import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { compositionCodeSource } from './source.ts'
import { compositionInputSchema, compositionReadonly } from './definition.ts'
import { compositionConfig, publishCompositionVersion, publishedCompositionService, readCompositions, selectedComposition, versionConfig, writeCompositions } from './compositions.ts'
import { workspaceConfigPath } from '../workspace.ts'
import { executableCatalog, type CompositionExecutionContext } from './extension.ts'
import { createRegistry, executeComposition, dryRunComposition, compositionStructure, compositionVersion, compositionImplementationDigest, saveRegistry, type McpRegistry } from './executor.ts'
import { callOpenApiOperation, limitedText, loadOpenApi, normalizeConnection, publicConnection, validateSpecUrl, type CredentialRef } from './openapi.ts'
import { managedDispatch, managementDispatch, type ManagedDispatch } from './control.ts'
import { currentBusinessContext, getBusinessControl } from '../business-control/core.ts'
import { createBusinessControlHandler } from '../business-control/management.ts'

const SERVER_INFO = { name: 'harness-platform-mcp-composition', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-06-18'

function failure(code: string, message: string, details = {}): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

function success<T>(value: T): ConnectionRpcResult<T> {
  return { ok: true, value }
}

async function listState(registry: McpRegistry, assetRoot: string, compositionsFile: string) {
  const { catalog, revision } = readCompositions(compositionsFile)
  return {
    connections: [
      ...[...registry.openapi.values()].map(connection => ({
        ...publicConnection(connection),
        status: registry.status.get(connection.id) ?? { registered: true, specLoaded: false, toolCallSucceeded: false },
      })),
      ...[...registry.mcp.values()].map(connection => ({
        kind: 'mcp-http',
        id: connection.id,
        name: connection.name ?? connection.id,
        endpointUrl: connection.endpointUrl,
        credential_configured: Boolean(connection.credentialRef),
        status: registry.status.get(connection.id) ?? { registered: true, specLoaded: 'unknown', toolCallSucceeded: 'unknown' },
      })),
    ],
    compositions: await Promise.all(catalog.compositions.map(async entry => ({ ...entry,
      ...(entry.published ? { binding: { compositionId: entry.id, versionId: entry.publishedVersionId,
        expectedImplementationDigest: compositionImplementationDigest(entry.published, registry.extension, catalog, registry) } } : {}),
      versions: entry.versions?.map(version => ({ ...version, binding: { compositionId: entry.id, versionId: version.versionId,
        expectedImplementationDigest: compositionImplementationDigest(version.config, registry.extension, catalog, registry) } })),
      graphs: Object.fromEntries(await Promise.all((['draft', 'published'] as const).filter(key => entry[key]).map(async key => [key, await compositionStructure(entry[key], catalog, registry.extension, true)]))),
    }))),
    publishedService: publishedCompositionService(catalog, executableCatalog(catalog, registry.extension ?? (registry.threat ? { threat: registry.threat } : undefined))),
    extension: registry.extension?.id ? { id: registry.extension.id, seed: Boolean(registry.extension.seed), flow: Boolean(registry.extension.flow), stages: Boolean(registry.extension.threat) } : null,
    revision,
    implementation: await compositionVersion(assetRoot, undefined, registry.extension),
  }
}

function executionContext(value: any): CompositionExecutionContext | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图执行关联信息无效')
  const allowed = ['execution_id', 'parent_run_id', 'case_id', 'session_id', 'tool_call_id']
  if (Object.keys(value).some(key => !allowed.includes(key)) || Object.values(value).some(item => typeof item !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item))) throw new Error('图执行关联信息无效')
  return { ...value, execution_id: value.execution_id ?? `graph-${randomUUID()}`, role: 'target' }
}

function totalSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function statusOf(registry: McpRegistry, id: string) {
  const status = registry.status.get(id) ?? { registered: true, specLoaded: 'unknown' as const, toolCallSucceeded: 'unknown' as const }
  registry.status.set(id, status)
  return status
}

function normalizeMcpConnection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP 连接配置无效')
  const input = value as Record<string, any>
  const id = String(input.id ?? '')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('连接 ID 无效')
  let credentialRef: CredentialRef | undefined
  if (input.credentialRef !== undefined) {
    if (!input.credentialRef || input.credentialRef.kind !== 'file' || typeof input.credentialRef.path !== 'string') throw new Error('凭据只能使用专用文件引用')
    credentialRef = { kind: 'file', path: input.credentialRef.path }
  }
  return {
    id,
    name: typeof input.name === 'string' && input.name ? input.name.slice(0, 80) : undefined,
    endpointUrl: validateSpecUrl(String(input.endpointUrl ?? input.url ?? '')),
    credentialRef,
    authHeader: typeof input.authHeader === 'string' ? input.authHeader : undefined,
  }
}

async function mcpAuthHeaders(connection: any) {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json,text/event-stream' })
  if (connection.credentialRef) {
    const value = (await readFile(connection.credentialRef.path, 'utf8')).trim()
    if (value) {
      const header = connection.authHeader ?? 'Authorization'
      headers.set(header, header.toLowerCase() === 'authorization' && !value.startsWith('Bearer ') ? `Bearer ${value}` : value)
    }
  }
  return headers
}

async function mcpSecret(connection: any) {
  return connection.credentialRef ? (await readFile(connection.credentialRef.path, 'utf8')).trim() : undefined
}

function redactLiteral(text: string, secret?: string) {
  return secret ? text.replaceAll(secret, '[redacted]') : text
}

function redactValue(value: any, secret?: string): any {
  if (typeof value === 'string') return redactLiteral(value, secret)
  if (Array.isArray(value)) return value.map(item => redactValue(item, secret))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secret)]))
}

function parseSseJsonRpc(text: string, id: unknown, secret?: string) {
  let sawData = false
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data || data === '[DONE]') continue
    sawData = true
    let body: any
    try { body = JSON.parse(redactLiteral(data, secret)) } catch { throw new Error('MCP SSE 响应无法解析，当前仅支持有限 JSON-RPC data 事件') }
    if (body?.id === id) return body
  }
  throw new Error(sawData ? 'MCP SSE 未返回匹配请求 id 的 JSON-RPC 结果' : 'MCP SSE 响应为空')
}

async function mcpJsonRpc(connection: any, message: any, session?: { id?: string; protocolVersion?: string }, signal?: AbortSignal, control?: ManagedDispatch) {
  const headers = await mcpAuthHeaders(connection)
  for (const [name, value] of Object.entries(control?.requestHeaders?.(connection.endpointUrl) ?? {})) headers.set(name, value)
  if (session?.id) headers.set('Mcp-Session-Id', session.id)
  if (session?.protocolVersion) headers.set('MCP-Protocol-Version', session.protocolVersion)
  const dispatch = (controlledSignal?: AbortSignal) => fetch(connection.endpointUrl, { method: 'POST', headers, body: JSON.stringify(message), signal: controlledSignal ?? signal, redirect: 'error' })
  const response = control && message.method === 'tools/call'
    ? await control({ serverId: connection.id, operationId: message.params.name, kind: 'write',
      target: connection.endpointUrl, method: message.method, args: message.params.arguments }, dispatch, signal)
    : await dispatch()
  const secret = await mcpSecret(connection)
  if (!response.ok) throw new Error(`MCP 请求失败：HTTP ${response.status}`)
  const text = await limitedText(response, 512 * 1024)
  const contentType = response.headers.get('content-type') ?? ''
  let body: any
  if (contentType.includes('text/event-stream')) body = parseSseJsonRpc(text, message.id, secret)
  else {
    try { body = JSON.parse(redactLiteral(text, secret)) } catch { throw new Error('MCP 响应不是 JSON') }
  }
  if (body.error) throw new Error(String(redactValue(body.error.message ?? 'MCP 返回错误', secret)))
  if (message.method === 'initialize') {
    session ??= {}
    session.id = response.headers.get('Mcp-Session-Id') ?? session.id
    session.protocolVersion = typeof body.result?.protocolVersion === 'string' ? body.result.protocolVersion : PROTOCOL_VERSION
  }
  return redactValue(body.result, secret)
}

async function listMcpTools(connection: any, signal?: AbortSignal) {
  const session = {}
  const runSignal = totalSignal(signal)
  await mcpJsonRpc(connection, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'harness-platform', version: '0.1.0' } } }, session, runSignal)
  const headers = await mcpAuthHeaders(connection)
  if ((session as any).id) headers.set('Mcp-Session-Id', (session as any).id)
  if ((session as any).protocolVersion) headers.set('MCP-Protocol-Version', (session as any).protocolVersion)
  const notified = await fetch(connection.endpointUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }), signal: runSignal })
  if (!notified.ok) throw new Error(`MCP initialized 通知失败：HTTP ${notified.status}`)
  return await mcpJsonRpc(connection, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session, runSignal)
}

async function callMcpTool(connection: any, name: string, args: any, signal?: AbortSignal, control?: ManagedDispatch) {
  const session = {}
  const runSignal = totalSignal(signal)
  await mcpJsonRpc(connection, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'harness-platform', version: '0.1.0' } } }, session, runSignal)
  const headers = await mcpAuthHeaders(connection)
  if ((session as any).id) headers.set('Mcp-Session-Id', (session as any).id)
  if ((session as any).protocolVersion) headers.set('MCP-Protocol-Version', (session as any).protocolVersion)
  const notified = await fetch(connection.endpointUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }), signal: runSignal })
  if (!notified.ok) throw new Error(`MCP initialized 通知失败：HTTP ${notified.status}`)
  await mcpJsonRpc(connection, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session, runSignal)
  return await mcpJsonRpc(connection, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args ?? {} } }, session, runSignal, control)
}

export function createMcpHandler(assetRoot: string, options: { stateFile?: string; compositionsFile?: string; servers?: () => any[]; native?: McpRegistry['native']; threat?: McpRegistry['threat']; extension?: McpRegistry['extension'] } = {}): ConnectionRpcHandler {
  const registry = options.servers ? createRegistry() : createRegistry(assetRoot, options.stateFile)
  const compositionsFile = options.compositionsFile ?? workspaceConfigPath(assetRoot, 'mcp-compositions.json')
  registry.native = options.native
  registry.threat = options.threat
  registry.control = managedDispatch(assetRoot)
  registry.access = {
    context: currentBusinessContext,
    assertRunRead(context, runId) { const control = getBusinessControl(assetRoot); if (control.enabled()) control.assert(context as any, 'read', [{ kind: 'run', id: runId }]) },
    bindRun(context, runId) { getBusinessControl(assetRoot).bindResource(context as any, { kind: 'run', id: runId }) },
  }
  registry.extension = options.extension
  const controlHandler = createBusinessControlHandler(assetRoot)
  return async (endpoint, payload, signal, peer) => {
    try {
      if (endpoint.startsWith('control/')) return controlHandler(endpoint.slice('control/'.length), payload, signal, peer)
      if (registry.extension) registry.threat = registry.extension.threat
      if (options.servers) {
        registry.openapi.clear()
        registry.mcp.clear()
        for (const server of options.servers().filter(item => item.enabled !== false)) {
          if (server.specUrl) registry.openapi.set(server.id, { id: server.id, name: server.serverName || server.id, specUrl: server.specUrl })
          else registry.mcp.set(server.id, { id: server.id, endpointUrl: server.url })
        }
        if (['registerOpenApi', 'registerMcp', 'deleteConnection', 'refreshSpec', 'callTool'].includes(endpoint)) {
          return failure('use_mcp_manager', '请通过 MCP 配置管理页面操作服务器、工具与资源')
        }
      }
      if (endpoint === 'list') return success(await listState(registry, assetRoot, compositionsFile))
      if (endpoint === 'compositionSource') return success(compositionCodeSource(assetRoot, readCompositions(compositionsFile).catalog, registry.extension, payload, undefined, (await compositionVersion(assetRoot, undefined, registry.extension)).sourceDigest))
      if (endpoint === 'compositionRun' || endpoint === 'compositionArtifact') {
        if (!registry.threat) throw new Error('威胁分析运行器尚未装载')
        const request = payload as any
        if (typeof request?.run_id !== 'string') throw new Error('请选择运行 ID')
        const context = currentBusinessContext(), control = getBusinessControl(assetRoot)
        if (control.enabled()) {
          if (!context) throw new Error('缺少受信业务上下文')
          control.assert(context, 'read', [{ kind: 'run', id: request.run_id }])
        }
        if (endpoint === 'compositionRun') return success(await registry.threat.inspect(request.run_id))
        if (typeof request.artifactId !== 'string') throw new Error('请选择运行产物')
        const artifact = await registry.threat.artifact(request.run_id, request.artifactId)
        if (context) {
          await control.inspect(context, 'report', artifact.body, signal)
          control.assert(context, 'read', [{ kind: 'run', id: request.run_id }])
        }
        return success(artifact)
      }
      if (endpoint === 'seedThreatCompositions') {
        if (!registry.extension?.seed) throw new Error('业务组合扩展尚未装载')
        const { catalog, revision } = readCompositions(compositionsFile)
        const request = (payload as any) ?? {}
        if (request.revision !== revision) throw new Error('编排目录已变化，请刷新后重试；当前草稿未覆盖')
        const validated = compositionConfig({ kind: 'threat-stage', stage: 'collect', toolName: 'threat_collect', title: '取证与快判', description: '', bindings: request.bindings })
        registry.extension.seed(catalog, validated.bindings!)
        writeCompositions(compositionsFile, catalog, revision)
        return success(await listState(registry, assetRoot, compositionsFile))
      }
      if (['saveCompositionDraft', 'publishComposition', 'executeComposition', 'dryRunComposition', 'callPublishedComposition'].includes(endpoint)) {
        const { catalog, revision } = readCompositions(compositionsFile)
        const request = (payload as any) ?? {}
        if (endpoint !== 'callPublishedComposition' && request.revision !== revision) throw new Error('编排目录已变化，请刷新后重试；当前草稿未覆盖')
        if (endpoint === 'saveCompositionDraft') {
          const draft = compositionConfig(request.draft)
          const entry = request.compositionId ? catalog.compositions.find(item => item.id === request.compositionId) : undefined
          if (request.compositionId && !entry) throw new Error('所选编排不存在')
          if (entry) entry.draft = draft
          else catalog.compositions.push({ id: `composition-${randomUUID()}`, draft })
          writeCompositions(compositionsFile, catalog, revision)
          return success(await listState(registry, assetRoot, compositionsFile))
        }
        if (endpoint === 'callPublishedComposition') {
          const execution = executionContext(request.execution)
          if (request.expectedImplementationDigest !== undefined && (typeof request.expectedImplementationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(request.expectedImplementationDigest)
            || !request.compositionId || !request.versionId)) return failure('invalid_request', '固定实现需要完整组合、版本和实现摘要')
          if (request.compositionId !== undefined || request.versionId !== undefined) {
            if (typeof request.compositionId !== 'string' || typeof request.versionId !== 'string' || !request.versionId) return failure('invalid_request', '执行固定组合需要完整的组合 ID 和版本 ID')
            const frozen = versionConfig(catalog, request.compositionId, request.versionId)
            if (frozen.toolName !== request.toolName) return failure('conflict', '固定组合版本与工具名称不一致，请重新生成预览')
            const actual = await compositionVersion(assetRoot, frozen, registry.extension, catalog, registry)
            if (request.expectedImplementationDigest !== undefined && (actual.sourceDigest === 'unknown' || actual.businessExtension?.sourceDigest === 'unknown'
              || actual.implementationDigest !== request.expectedImplementationDigest)) return failure('conflict', '固定组合实现已变化或来源不明，请恢复对应实现或重新预览')
            return success(await executeComposition(registry, assetRoot, frozen, request.input ?? {}, signal, catalog, false, execution, actual))
          }
          const entry = catalog.compositions.find(item => item.published?.toolName === request.toolName)
          if (!entry?.published) return failure('not_found', '已发布工具不存在')
          return success(await executeComposition(registry, assetRoot, entry.published, request.input ?? {}, signal, catalog, false, execution))
        }
        const config = selectedComposition(catalog, request)
        if (endpoint === 'publishComposition') {
          if (request.version !== 'draft') throw new Error('只能发布已保存的草稿')
          const dry = await dryRunComposition(registry, config, request.input ?? {}, catalog)
          const entry = catalog.compositions.find(item => item.id === request.compositionId)!
          publishCompositionVersion(entry, config)
          writeCompositions(compositionsFile, catalog, revision)
          return success({ ...await listState(registry, assetRoot, compositionsFile), dry })
        }
        return success(endpoint === 'dryRunComposition'
          ? { ...await dryRunComposition(registry, config, request.input ?? {}, catalog), version: await compositionVersion(assetRoot, config, registry.extension, catalog, registry) }
          : await executeComposition(registry, assetRoot, config, request.input ?? {}, signal, catalog))
      }
      if (endpoint === 'registerOpenApi') {
        const connection = normalizeConnection(payload)
        registry.openapi.set(connection.id, connection)
        registry.mcp.delete(connection.id)
        registry.status.set(connection.id, { registered: true, specLoaded: false, toolCallSucceeded: false })
        saveRegistry(registry)
        return success({ connection: publicConnection(connection), status: registry.status.get(connection.id) })
      }
      if (endpoint === 'registerMcp') {
        const connection = normalizeMcpConnection(payload)
        registry.mcp.set(connection.id, connection)
        registry.openapi.delete(connection.id)
        registry.status.set(connection.id, { registered: true, specLoaded: false, toolCallSucceeded: false })
        saveRegistry(registry)
        return success({ connection: { kind: 'mcp-http', id: connection.id, endpointUrl: connection.endpointUrl, credential_configured: Boolean(connection.credentialRef) }, status: registry.status.get(connection.id) })
      }
      if (endpoint === 'deleteConnection') {
        const id = String((payload as any)?.connectionId ?? '')
        const removed = registry.openapi.delete(id) || registry.mcp.delete(id)
        registry.status.delete(id)
        if (removed) saveRegistry(registry)
        return removed ? success({ deleted: true }) : failure('not_found', '连接不存在')
      }
      if (endpoint === 'refreshSpec') {
        const id = String((payload as any)?.connectionId ?? '')
        const connection = registry.openapi.get(id)
        const mcp = registry.mcp.get(id)
        if (!connection && !mcp) return failure('not_found', '连接不存在')
        const status = statusOf(registry, id)
        const runSignal = totalSignal(signal)
        const tools = connection ? (await loadOpenApi(connection, runSignal)).tools : (await listMcpTools(mcp, runSignal)).tools
        status.specLoaded = true
        registry.status.set(id, status)
        return success({ tools, status })
      }
      if (endpoint === 'callTool') {
        const id = String((payload as any)?.connectionId ?? '')
        const name = String((payload as any)?.toolName ?? '')
        const connection = registry.openapi.get(id)
        const mcp = registry.mcp.get(id)
        if (!connection && !mcp) return failure('not_found', '连接不存在')
        const runSignal = totalSignal(signal)
        const result = connection
          ? await callOpenApiOperation(await loadOpenApi(connection, runSignal), name, (payload as any)?.arguments ?? {}, runSignal, registry.control)
          : await callMcpTool(mcp, name, (payload as any)?.arguments ?? {}, runSignal, registry.control)
        const status = statusOf(registry, id)
        status.specLoaded = true
        status.toolCallSucceeded = connection ? result.ok : !result?.isError
        if (connection && !result.ok) status.lastError = `HTTP ${result.status}`
        registry.status.set(id, status)
        return success({ ...result, status })
      }
      return failure('not_found', '未知的 MCP 管理操作')
    } catch (error) {
      return failure('mcp_failed', error instanceof Error ? error.message : String(error))
    }
  }
}

async function bodyOf(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求超过 64 KiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function handleMcpMessage(handler: ConnectionRpcHandler, assetRoot: string, message: any, signal?: AbortSignal) {
  if (!message || typeof message.method !== 'string') return rpcError(message?.id ?? null, -32600, 'Invalid Request')
  if (message.id === undefined || message.id === null) return null
  if (message.method === 'initialize') {
    return rpcResult(message.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO })
  }
  if (message.method === 'tools/list') {
    const listed = await handler('list', {}, signal ?? new AbortController().signal, undefined as never)
    if (!listed.ok) return rpcError(message.id, -32603, listed.error.message)
    return rpcResult(message.id, { tools: ((listed.value as any).publishedService?.publishedTools ?? []).map((config: any) => ({
      name: config.toolName,
      description: config.description || config.title,
      inputSchema: compositionInputSchema(config),
      annotations: { readOnlyHint: compositionReadonly(config) },
      _meta: { harness: (listed.value as any).compositions.find((entry: any) => entry.published?.toolName === config.toolName)?.binding },
    })) })
  }
  if (message.method === 'tools/call') {
    const meta = message.params?._meta?.harness
    if (meta !== undefined && (!meta || typeof meta !== 'object' || Array.isArray(meta)
      || Object.keys(meta).some(key => !['compositionId', 'versionId', 'expectedImplementationDigest', 'execution'].includes(key)))) return rpcError(message.id, -32602, 'Invalid fixed composition metadata')
    const result = await handler('callPublishedComposition', { ...meta, toolName: message.params?.name, input: message.params?.arguments ?? {} }, signal ?? new AbortController().signal, undefined as never)
    if (!result.ok && result.error.code === 'not_found') return rpcError(message.id, -32602, 'Unknown tool')
    if (!result.ok) return rpcResult(message.id, { content: [{ type: 'text', text: result.error.message }], isError: true })
    const value = result.value as { ok: boolean } & Record<string, unknown>
    return rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: !value.ok })
  }
  return rpcError(message.id, -32601, `Method not found: ${message.method}`)
}

export function createPublishedCompositionClient(assetRoot: string, handler: ConnectionRpcHandler) {
  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const reply = await handleMcpMessage(handler, assetRoot, { id: 1, method, params }, signal) as any
    if (reply.error) throw new Error(reply.error.message)
    return reply.result
  }
  return {
    listTools: (options?: { signal?: AbortSignal }) => request('tools/list', undefined, options?.signal),
    callTool: (params: unknown, options?: { signal?: AbortSignal }) => request('tools/call', params, options?.signal),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    readResource: async () => { throw new Error('组合编排服务没有资源') },
  }
}

export function createMcpGatewayRequestHandler(assetRoot: string, handler = createMcpHandler(assetRoot)) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end()
        return
      }
      const parsed = await bodyOf(req)
      if (Array.isArray(parsed)) throw new Error('JSON-RPC batch 不受支持')
      const replies = (await Promise.all([parsed].map(message => handleMcpMessage(handler, assetRoot, message)))).filter(Boolean)
      if (!replies.length) {
        res.writeHead(202).end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(replies[0]))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(rpcError(null, -32603, error instanceof Error ? error.message : String(error))))
    }
  }
}

export function createMcpGatewayFetchHandler(assetRoot: string, handler = createMcpHandler(assetRoot)) {
  return async (request: Request) => {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    try {
      const parsed = JSON.parse(await limitedText(new Response(request.body), 64 * 1024))
      if (Array.isArray(parsed)) throw new Error('JSON-RPC batch 不受支持')
      const replies = (await Promise.all([parsed].map(message => handleMcpMessage(handler, assetRoot, message, request.signal)))).filter(Boolean)
      if (!replies.length) return new Response(null, { status: 202 })
      return Response.json(replies[0], { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return Response.json(rpcError(null, -32603, error instanceof Error ? error.message : String(error)), { status: 400 })
    }
  }
}

export function applyMcpGateway(ctx: Context, assetRoot: string, handler: ConnectionRpcHandler) {
  const fetch = createMcpGatewayFetchHandler(assetRoot, handler)
  ctx.connection.fetch.register({ path: '/api/harness-platform/mcp', methods: ['POST'], requestBody: 'buffered',
    fetch: request => managementDispatch(assetRoot, () => fetch(request)) })
}
