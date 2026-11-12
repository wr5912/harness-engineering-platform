import { createHash } from 'node:crypto'
import * as manager from 'harness-mcp-manager-server'
import { execute, loadOpenApi } from 'harness-mcp-manager-openapi'
import { createRegistry, executeComposition, compositionImplementationDigest } from '../mcp/executor.ts'
import { compositionInputSchema, compositionQueries } from '../mcp/definition.ts'
import { workflowRuns } from '../mcp/workflow-runs.ts'
import { frozenLfxWorkflow } from '../mcp/lfx-runtime.ts'
import { compositionConfig, versionConfig } from '../mcp/compositions.ts'
import { readStandaloneConfig, compositionCatalog, configuredServers } from './config.ts'
import { populateStandaloneExtensions } from '../standalone-extensions/index.ts'

export const name = 'standalone-agent'
export const inject = ['webServer', 'connection', 'tools', 'agents', 'workspaceRegistry', 'llm', 'settingsController']
export const validateConfiguration = manager.validateConfiguration
export const Config = undefined
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 只装配业务文件与纯 MCP 传输，不拥有平台治理或管理界面。 */
export async function apply(ctx: any, options: { home?: string; root?: string } = {}) {
  const home = options.home || process.env.DSH_HOME || '/var/lib/dsh'
  const root = options.root || '/opt/standalone'
  const config = () => readStandaloneConfig(home)
  const catalog = () => compositionCatalog(config())
  const extension: any = {}
  ctx.provide('standaloneCompositionExtension', extension)
  const registry = createRegistry()
  registry.runRoot = home
  registry.extension = extension
  const servers = () => {
    const current = config()
    const upstream = configuredServers(current)
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
        description: entry.published!.description, inputSchema: compositionInputSchema(entry.published, extension) })).concat(compositionQueries.map(query => ({ name: query.toolName, title: query.title, description: query.description, inputSchema: query.inputSchema }))) }
    },
    async callTool(request: any, options?: { signal?: AbortSignal }) {
      refreshRegistry()
      if (compositionQueries.some(query => query.toolName === request.name)) {
        const input = request.arguments ?? {}, runs = workflowRuns(home), run = runs.inspect(input.run_id)
        if (!run && !registry.threat) throw new Error('运行不存在或对应运行器尚未装载')
        const value = request.name === 'get_composition_run' ? run ? runs.summary(input.run_id) : await registry.threat!.inspect(input.run_id)
          : request.name === 'get_composition_details' ? runs.details(input.run_id, input.node_id, input.offset, input.limit)
            : run ? await runs.artifact(input.run_id, input.artifactId) : await registry.threat!.artifact(input.run_id, input.artifactId)
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
      }
      const meta = request._meta?.harness
      const entry = catalog().compositions.find(entry => entry.published?.toolName === request.name)
      if (!entry) throw new Error('组合工具未包含在此安装包中')
      const frozen = meta?.versionId ? versionConfig(catalog(), entry.id, meta.versionId) : compositionConfig(entry.published)
      const actualDigest = compositionImplementationDigest(frozen, registry.extension, catalog(), registry)
      if (meta && (meta.compositionId !== entry.id || meta.expectedImplementationDigest !== actualDigest)) throw new Error('固定组合部署绑定与实际实现不一致')
      const value = await executeComposition(registry, root, frozen, request.arguments ?? {}, options?.signal, catalog(), false, meta?.execution)
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
    platformTransportForServer: (server: any) => server.url === groupUrl(server.id)
      && config().mcp.groups.some(group => group.id === server.id) ? { fetch: (input: any, init?: any) => fetch(input, init) } : undefined,
    groupUrl, platformDispatch: (value: any) => { dispatch = value },
  }
  manager.apply(ctx, raw)
  // 现有业务扩展只依赖通用连接与执行接缝；此处不提供平台控制服务。
  ctx.provide('platformMcp', { ...raw, compositionExtension: extension,
    frozenWorkflow: (config: any, invoke: any) => frozenLfxWorkflow(root, config, invoke),
    dispatch: (...args: any[]) => { if (!dispatch) throw new Error('MCP 调用尚未就绪'); return dispatch(...args) } })
  await populateStandaloneExtensions(ctx, config(), root)
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
}
