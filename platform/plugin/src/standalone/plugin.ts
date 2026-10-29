import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as manager from 'harness-mcp-manager-server'
import { execute, loadOpenApi } from 'harness-mcp-manager-openapi'
import { createRegistry, executeComposition, compositionImplementationDigest } from '../mcp/executor.ts'
import { compositionInputSchema } from '../mcp/definition.ts'
import { compositionConfig, publishedCompositionService, versionConfig, type Catalog } from '../mcp/compositions.ts'
import { readStandaloneConfig } from './config.ts'
import { populateStandaloneExtensions } from '../standalone-extensions/index.ts'

export const name = 'standalone-agent'
export const inject = ['webServer', 'connection', 'tools', 'agents', 'workspaceRegistry', 'llm', 'settingsController']
export const validateConfiguration = manager.validateConfiguration
export const Config = undefined
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 只装配业务文件与纯 MCP 传输，不拥有平台治理或管理界面。 */
export async function apply(ctx: any, options: { home?: string; root?: string } = {}) {
  const home = options.home || process.env.DSH_HOME || '/var/lib/dsh'
  const config = () => readStandaloneConfig(home)
  const catalog = (): Catalog => {
    const value = config().compositions as any
    return value?.schema_version === '1.0' && Array.isArray(value.compositions) ? value : { schema_version: '1.0', compositions: [] }
  }
  const extension: any = {}
  ctx.provide('standaloneCompositionExtension', extension)
  const registry = createRegistry()
  registry.extension = extension
  const servers = () => {
    const current = config()
    const service = publishedCompositionService(catalog())
    const upstream = [...current.mcp.servers.filter(server => !server.platformComposition && server.id !== 'platform-compositions'), ...(service ? [service] : [])]
    for (const id of (current.mcp as any).mountServerIds ?? []) {
      if (upstream.some(server => server.id === id) || !current.mcp.groups.some(group => group.id === id)) continue
      upstream.push({ id, serverName: id, enabled: true, url: groupUrl(id), headers: [{ name: 'Authorization', value: `Bearer ${current.mcp.sharedToken}` }], tools: { mode: 'all', names: [] } })
    }
    return upstream
  }
  function refreshRegistry() {
    registry.openapi.clear(); registry.mcp.clear()
    for (const server of servers().filter(server => server.enabled !== false)) {
      if (server.specUrl) registry.openapi.set(server.id, { id: server.id, name: server.serverName || server.id, specUrl: server.specUrl })
      else if (server.url) registry.mcp.set(server.id, { id: server.id, endpointUrl: server.url })
    }
    registry.threat = extension.threat
  }
  registry.native = {
    async load(connection, signal) {
      const server = servers().find(server => server.id === connection.id && server.enabled !== false)
      if (!server?.specUrl) throw new Error('组合依赖的 OpenAPI 连接未配置')
      return { ...await loadOpenApi({ ...server, platformSignal: signal }), connection }
    },
    async call(source, operationId, args, signal) {
      signal?.throwIfAborted()
      const operation = source.operations.get(operationId)
      if (!operation) throw new Error(`组合操作不存在：${operationId}`)
      const { response, text } = await execute(source, operation, args)
      let json: unknown
      try { json = JSON.parse(text) } catch { json = text }
      return { ok: response.ok, status: response.status, json,
        receipt: { connectionId: source.connection.id, specDigest: digest(source.spec), operationId, method: operation.method.toUpperCase(), path: operation.path, schemaDigest: digest(operation.raw) } }
    },
  }
  const platformClient = {
    async listResources() { return { resources: [] } },
    async listResourceTemplates() { return { resourceTemplates: [] } },
    async readResource() { throw new Error('组合工具不提供资源') },
    async listTools() {
      return { tools: catalog().compositions.filter(entry => entry.published).map(entry => ({ name: entry.published!.toolName, title: entry.published!.title,
        description: entry.published!.description, inputSchema: compositionInputSchema(entry.published) })) }
    },
    async callTool(request: any, options?: { signal?: AbortSignal }) {
      refreshRegistry()
      const meta = request._meta?.harness
      const entry = catalog().compositions.find(entry => entry.published?.toolName === request.name)
      if (!entry) throw new Error('组合工具未包含在此安装包中')
      const frozen = meta?.versionId ? versionConfig(catalog(), entry.id, meta.versionId) : compositionConfig(entry.published)
      const actualDigest = compositionImplementationDigest(frozen, registry.extension, catalog(), registry)
      if (meta && (meta.compositionId !== entry.id || meta.expectedImplementationDigest !== actualDigest)) throw new Error('固定组合部署绑定与实际实现不一致')
      const value = await executeComposition(registry, home, frozen, request.arguments ?? {}, options?.signal, catalog(), false, meta?.execution)
      return { isError: value.ok === false, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
    },
  }
  function groupUrl(id: string) { return new URL(ctx.webServer.publicPath?.(`/mcp/groups/${id}/v2`) ?? `/mcp/groups/${id}/v2`, ctx.webServer.getOrigin()).href }
  let dispatch: any
  const raw = {
    servers: { get: servers }, groups: { get: () => config().mcp.groups }, sharedToken: { get: () => config().mcp.sharedToken }, platformClient,
    mountServers: (all: any[]) => {
      const selected = (config().mcp as any).mountServerIds
      if (!Array.isArray(selected)) return all
      return selected.map(id => {
        const direct = all.find(server => server.id === id)
        if (direct) return { ...direct, ...config().mcp.mountOverrides?.[id] }
        if (!config().mcp.groups.some(group => group.id === id)) return undefined
        return { id, serverName: id, enabled: true, url: groupUrl(id), headers: [{ name: 'Authorization', value: `Bearer ${config().mcp.sharedToken}` }], tools: { mode: 'all', names: [] } }
      }).filter(Boolean)
    },
    businessGroupUrl: groupUrl,
    businessGroupFetch: (_id: string, _sessionId?: string) => (input: any, init: any = {}) => {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${config().mcp.sharedToken}`)
      return fetch(input, { ...init, headers })
    },
    // 原生资源与模板沿同一普通 MCP 传输装载，不叠加平台治理。
    platformTransportForServer: (server: any) => server.url ? { fetch: (input: any, init?: any) => fetch(input, init) } : undefined,
    isolateDiscovery: true,
    withToolContext: (_execution: unknown, task: () => unknown) => task(),
    groupUrl, platformDispatch: (value: any) => { dispatch = value },
  }
  manager.apply(ctx, raw)
  // 现有业务扩展只依赖通用连接与执行接缝；此处不提供平台控制服务。
  ctx.provide('platformMcp', { ...raw, compositionExtension: extension,
    dispatch: (...args: any[]) => { if (!dispatch) throw new Error('MCP 调用尚未就绪'); return dispatch(...args) } })
  await populateStandaloneExtensions(ctx, config(), options.root || '/opt/standalone')
  ctx.provide('standaloneBindings', {
    resolve(_name: string, original: any) {
      refreshRegistry()
      const current = ctx.mcpSessionManager.currentGroup(original.group_id, original.group_link_version ?? 1)
      if (!current) throw new Error('固定组合依赖的分组未包含在安装包中')
      const fixed = versionConfig(catalog(), original.compositionId, original.versionId)
      if (fixed.toolName !== original.tool_name) throw new Error('固定组合工具与冻结版本不一致')
      return { ...original, group_target_digest: current.targetDigest,
        expectedImplementationDigest: compositionImplementationDigest(fixed, registry.extension, catalog(), registry) }
    },
  })
  await ctx.workspaceRegistry.create('/work/harness/workspace', config().agentId)
  ctx.inject(['webApp'], (ready: any) => {
    const url = ready.connection.authenticatedUrl(ready.webApp.getAdvertisedUrl())
    const directory = join(home, 'standalone')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // 原生访问入口只写受保护本地文件，不把凭据 URL 打到普通日志。
    writeFileSync(join(directory, 'entry.url'), url + '\n', { mode: 0o600 })
    const escaped = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
    writeFileSync(join(directory, 'open.html'), `<!doctype html><meta charset="utf-8"><title>打开智能体</title><meta http-equiv="refresh" content="0;url=${escaped}"><a href="${escaped}">打开智能体</a>`, { mode: 0o600 })
  })
}
