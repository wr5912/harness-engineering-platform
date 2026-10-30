import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-settings-controller'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type * as NativeWebApp from '@deepseek-ai/dsh-web-app'
import { applyAuthentication, currentAccount } from './auth.ts'
import { inventory as agentExperimentInventory } from '../../../plugins/asset-query-cli/query.mjs'
import { CHANNEL } from './protocol.ts'
import type { Inventory, RunAsset } from './protocol.ts'
import { DOMAIN_PREFIXES } from './protocol.ts'
import { recentRuns } from './dashboard.ts'
import { workspaceIdentity } from './workspace.ts'
import { createAgentsHandler } from './agents/index.ts'
import { createExtractionScope, createComputeVariantScope, isDecisionExtraction, isComputeVariantResearch, createFeatureScope, isFeatureOrganization, createExclusiveTaskScopes, projectDecisionExtractionTools } from './assistant/extraction-scope.ts'
import { createToolInputRecovery } from './assistant/tool-input-recovery.ts'
import { guardToolArguments } from './assistant/tool-argument-guard.ts'
import { createRunDownloadHandler } from './agents/run-files.ts'
import { createInstancesHandler } from './instances/index.ts'
import { createModelsHandler } from './models/index.ts'
import { modelProviderReadiness, projectModelPolicy } from './models/projection.ts'
import { applyMcpGateway, createMcpHandler } from './mcp/index.ts'
import { compositionInputSchema } from './mcp/definition.ts'
import type {} from './mcp/manager.ts'
import { createManagedMcpHandler } from './mcp/native.ts'
import { runtimeModule } from '../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'
import { createAssistant } from './assistant/index.ts'
import { createDocumentReader } from './assistant/documents.ts'
import { createDeployments } from './deployment/index.ts'
import { createDeploymentSeed } from './deployment/seed.ts'
import { assistantMcp } from './assistant/mcp.ts'
import { createPlatformEvents } from './realtime/index.ts'
import logo from '../assets/harness-logo.svg'
import { applyBusinessGateway } from './business-control/index.ts'
import { platformEntryUrl } from './business-control/group-link.ts'
import { managementDispatch } from './mcp/control.ts'
import { currentBusinessContext, getBusinessControl } from './business-control/core.ts'
import { bindConversationWorkspace } from './conversation-workspace.ts'

// 使用启动器核对过的全局 Runtime；开发依赖只提供类型和隔离测试环境。
const WebApp: typeof NativeWebApp = await runtimeModule('@deepseek-ai/dsh-web-app')

export const name = 'harness-platform'
export const inject = ['connection', 'webServer', 'credentials', 'platformMcp', 'workspaceRegistry', 'workspaceController', 'sessionController', 'sessionQuery', 'settingsController', 'agentDefaultModel', 'llm', 'tools', 'agents', 'sessionProjections', 'systemPrompt', 'skills', 'attachments', 'fs']
export const Config = WebApp.Config
export type Config = NativeWebApp.Config

const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function inventory(assetRoot: string): Inventory {
  const root = resolve(assetRoot)
  const assets = agentExperimentInventory(root)
  const runs: RunAsset[] = []
  for (const id of assets.experiments) {
    const base = `evolution/experiments/${id}/runs`
    let entries
    try {
      entries = readdirSync(join(root, base), { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries.filter(entry => entry.isDirectory() && RUN_ID.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      runs.push({ id: entry.name, experiment_id: id, path: `${base}/${entry.name}` })
    }
  }
  return {
    schema_version: '1.0',
    root,
    workspace: workspaceIdentity(root),
    observed_at: new Date().toISOString(),
    agents: assets.agents.map(id => ({ id, path: `agents/${id}` })),
    experiments: assets.experiments.map(id => ({ id, path: `evolution/experiments/${id}` })),
    runs,
  }
}

function failure(code: string, message: string, details = {}): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

export function createInventoryHandler(assetRoot: string): ConnectionRpcHandler {
  return async (endpoint, payload, signal, peer) => {
    if (endpoint !== 'inventory') return failure('not_found', '未知的资产查询操作')
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) {
      return failure('invalid_request', 'inventory 不接受查询参数')
    }
    if (signal.aborted) return failure('aborted', '资产查询已取消')
    try {
      return { ok: true, value: inventory(assetRoot) }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
      return failure('asset_read_failed', '无法读取仓库资产', { filesystem_code: code })
    }
  }
}

export function createPlatformHandler(assetRoot: string, domains: Record<'agents' | 'instances' | 'mcp' | 'models', ConnectionRpcHandler> & { assistant?: ConnectionRpcHandler }): ConnectionRpcHandler {
  const readInventory = createInventoryHandler(assetRoot)
  return async (endpoint, payload, signal, peer) => {
    if (signal.aborted) return failure('aborted', '请求已取消')
    if (endpoint === 'auth/current') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) return failure('invalid_request', '当前账号查询不接受参数')
      try { return { ok: true, value: currentAccount(assetRoot) } }
      catch { return failure('account_read_failed', '无法读取当前账号') }
    }
    if (endpoint === 'inventory') return readInventory(endpoint, payload, signal, peer)
    if (endpoint === 'home') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) {
        return failure('invalid_request', '首页查询不接受参数')
      }
      try {
        const assets = inventory(assetRoot)
        const [runs, instances, mcp] = await Promise.all([
          recentRuns(assets.root, assets.agents.map(agent => agent.id), signal),
          domains.instances('list', {}, signal, peer),
          domains.mcp('list', {}, signal, peer),
        ])
        return { ok: true, value: { recent_runs: runs, instances, mcp } }
      } catch {
        return failure('run_read_failed', '无法读取 Run 索引，请核对记录和 Python 环境。')
      }
    }
    const prefix = DOMAIN_PREFIXES.find(value => endpoint.startsWith(value))
    if (!prefix) return failure('not_found', '未知的平台操作')
    const domain = domains[prefix.slice(0, -1) as keyof typeof domains]
    if (!domain) return failure('not_found', '平台功能尚未装载')
    const result = await domain(endpoint.slice(prefix.length), payload, signal, peer)
    if (endpoint === 'agents/detail' && result.ok) {
      const instances = await domains.instances('list', {}, signal, peer)
      const value = result.value as { agent: { id: string }; experiment: { id: string }; loaded_instance: unknown }
      const observed = instances.ok ? (instances.value as { instances: { agent_id?: string; source_id: string }[] }).instances : []
      value.loaded_instance = instances.ok
        ? { status: 'observed', instances: observed.filter(instance => instance.source_id === `experiment:${value.experiment.id}`),
          agent_instances: observed.filter(instance => instance.agent_id === value.agent.id),
        note: '实例与只读挂载来自 Docker 观察；具体能力是否生效仍需相应 Session/Run 证据。' }
        : { status: 'unknown', reason: instances.error.message }
    }
    return result
  }
}

export function applyTools(ctx: Context) {
  const assetRoot = process.env.HARNESS_ASSET_ROOT
  if (!assetRoot) throw new Error('未设置 HARNESS_ASSET_ROOT')
  // 当前 Cordis 的 Service getter 在内部注册时沿提供方 Fiber 解析依赖。
  // 把已注入的载体绑定到子上下文，供原生 RPC 注册读取；父上下文不变。
  const registrationContext = ctx.extend({ webServer: ctx.webServer })
  const manager = ctx.platformMcp
  const mcp = manager?.compositionHandler ?? (manager ? createManagedMcpHandler(assetRoot, () => manager.servers.get()) : createMcpHandler(assetRoot))
  const mcpManagement: ConnectionRpcHandler = async (endpoint, payload, signal, peer) => {
    if (['configuration', 'saveConfiguration'].includes(endpoint) && peer?.principal?.kind !== 'owner') {
      return failure('forbidden', 'MCP 配置读写要求平台管理身份')
    }
    if (endpoint === 'configuration') {
      if (!manager?.configuration) return failure('unavailable', 'MCP 数据配置尚未装载')
      try { return { ok: true, value: manager.configuration() } }
      catch (error) { return failure('configuration_failed', (error as Error).message) }
    }
    if (endpoint === 'saveConfiguration') {
      if (!manager?.saveConfiguration) return failure('unavailable', 'MCP 数据配置尚未装载')
      const input = payload as { ops?: unknown; revision?: unknown } | undefined
      if (!Array.isArray(input?.ops) || typeof input.revision !== 'string') {
        return failure('invalid_request', 'MCP 保存需要原始版本和修改操作')
      }
      try { return { ok: true, value: manager.saveConfiguration(input.ops, input.revision) } }
      catch (error) { return failure('configuration_save_failed', (error as Error).message) }
    }
    return mcp(endpoint, payload, signal, peer)
  }
  const events = createPlatformEvents(assetRoot)
  events.register(registrationContext)
  registrationContext.connection.fetch.register({ path: '/api/harness-platform/runs/download', methods: ['GET'], requestBody: 'buffered', fetch: createRunDownloadHandler(assetRoot) })
  const notify = (domains: string[], ids?: string[]) => events.notify(domains as any, ids)
  const wrap = (domain: 'agents' | 'instances' | 'mcp' | 'models', handler: ConnectionRpcHandler): ConnectionRpcHandler => async (endpoint, payload, signal, peer) => {
    if (getBusinessControl(assetRoot).enabled() && !currentBusinessContext() && peer?.principal.kind !== 'owner') return failure('forbidden', '平台管理操作要求管理身份')
    try { return await managementDispatch(assetRoot, () => handler(endpoint, payload, signal, peer)) }
    finally {
      if (!['deployment/preview', 'deployment/status', 'control/status', 'control/probeProvider', 'control/providerProtocol', 'description', 'research/read-reference', 'research/validate', 'legacy/inspect', 'decision/preview', 'list', 'detail', 'sources', 'url', 'logs', 'edit/read', 'cases/list', 'cases/read', 'eval/list', 'eval/status', 'runs/index', 'runs/overview', 'runs/show', 'runs/evidence', 'runs/report', 'runs/files', 'runs/read-file', 'runs/compare', 'runs/trace', 'assets/diff', 'assets/read-fixed', 'compute-variants/context', 'compute-variants/preview', 'compute-variants/compare', 'compute-variants/build-preview', 'compute-variants/freeze-preview', 'training-servers/list', 'training-servers/probe', 'tasks/capabilities', 'datasets/source', 'datasets/list', 'datasets/read', 'datasets/export', 'cases/create-context', 'cases/from-run', 'cases/create-preview', 'fusion/status', 'fusion/proposal', 'features/proposal', 'features/read-source', 'configuration'].includes(endpoint)) notify([domain, 'catalog'])
    }
  }
  const modelProjection = (agentId: string, selected?: { provider: string; model: string; reasoningEffort?: string }) => projectModelPolicy(assetRoot, agentId, {
    sessionController: ctx.sessionController, settingsController: ctx.settingsController, credentials: ctx.credentials, llm: ctx.llm,
  }, selected)
  const deployments = createDeployments(assetRoot, { seed: createDeploymentSeed(assetRoot, modelProjection), notify: () => notify(['agents']) })
  ctx.effect(() => () => deployments.dispose())
  registrationContext.connection.fetch.register({ path: '/api/harness-platform/agent-deployments/download', methods: ['GET'], requestBody: 'buffered', fetch: deployments.download })
  const domains = {
    agents: wrap('agents', createAgentsHandler(assetRoot, () => notify(['agents', 'catalog']), {
      nativeServers: () => manager?.servers.get() ?? [],
      discoveredTools: async (serverId, signal) => {
        // 仅在明确选择服务时取其真实契约，避免一次查询遍历所有外部连接。
        if (!serverId || !manager?.dispatch) return []
        const found = await manager.dispatch({ action: 'test', serverId }, signal)
        if (found.status >= 400 || !Array.isArray(found.value?.tools)) throw new Error('无法读取所选 MCP 服务的工具契约')
        return found.value.tools.map((tool: any) => ({ ...tool, server_id: serverId }))
      },
      compositionBindings: async signal => {
        const listed = await mcp('list', {}, signal ?? new AbortController().signal, undefined as never)
        if (!listed.ok) return []
        const state = listed.value as any
        const callable = new Set((state.publishedService?.publishedTools ?? []).map((tool: any) => tool.toolName))
        return (state.compositions ?? []).filter((entry: any) => entry.published && entry.binding).flatMap((entry: any) => {
          const base = { composition_id: entry.binding.compositionId, version_id: entry.binding.versionId,
            tool_name: entry.published.toolName, source_digest: entry.binding.expectedImplementationDigest }
          const groups = (manager?.groups.get() ?? []).filter(group => callable.has(entry.published.toolName)
            && group.members?.some((member: any) => member.serverId === 'platform-compositions' && member.names?.includes(entry.published.toolName)))
          const bindings = groups.flatMap(group => {
            const actual = manager?.currentGroup?.(group.id, 2)
            return actual && /^[0-9a-f]{64}$/.test(actual.targetDigest) ? [{ ...base, fixed_binding: {
              group_id: actual.id, group_link_version: 2, group_target_digest: actual.targetDigest,
              tool_name: entry.published.toolName,
              compositionId: entry.binding.compositionId, versionId: entry.binding.versionId,
              expectedImplementationDigest: entry.binding.expectedImplementationDigest, input_schema: compositionInputSchema(entry.published),
            } }] : []
          })
          return bindings.length ? bindings : [{ ...base, fixed_binding_unavailable: '尚无已登记且可核验目标身份的原生 MCP 分组包含该工具' }]
        })
      },
    }, modelProjection, deployments.handler)),
    instances: wrap('instances', createInstancesHandler(assetRoot, modelProjection)), mcp: wrap('mcp', mcpManagement),
    models: wrap('models', createModelsHandler(assetRoot, {
      modelCatalog: () => ctx.sessionController.modelCatalog(),
      providerReadiness: providers => modelProviderReadiness(providers, {
        settingsController: ctx.settingsController, credentials: ctx.credentials, llm: ctx.llm,
      }),
      currentSelection: () => ctx.agentDefaultModel.currentSelection(),
      saveSelection: value => ctx.agentDefaultModel.saveSelection(value as Parameters<typeof ctx.agentDefaultModel.saveSelection>[0]),
    })),
    assistant: undefined as ConnectionRpcHandler | undefined,
  }
  const handler = createPlatformHandler(assetRoot, domains)
  const services = ctx as any
  const extractionScope = createExtractionScope()
  const computeVariantScope = createComputeVariantScope()
  const featureScope = createFeatureScope()
  const taskScopes = createExclusiveTaskScopes([extractionScope, computeVariantScope, featureScope])
  const taskScope = (agent: any, state: any) => isDecisionExtraction(assetRoot, agent, state) ? extractionScope
    : isComputeVariantResearch(assetRoot, agent, state) ? computeVariantScope
      : isFeatureOrganization(assetRoot, agent, state) ? featureScope : undefined
  const assistant = createAssistant(assetRoot, handler, {
    controller: services.sessionController,
    readDocument: createDocumentReader(assetRoot, services),
    sessionEvents: async (id, signal) => {
      signal.throwIfAborted()
      const snapshot = await services.sessionQuery.readSession(id)
      signal.throwIfAborted()
      if (snapshot.session?.id !== id || !Array.isArray(snapshot.events)) throw new Error('原生管理会话的阅读记录身份不一致')
      return snapshot.events
    },
    scopeExtraction: agent => taskScopes.apply(agent, extractionScope),
    scopeComputeVariants: agent => taskScopes.apply(agent, computeVariantScope),
    scopeFeatures: agent => taskScopes.apply(agent, featureScope),
    releaseTaskScope: agent => taskScopes.release(agent),
    running: id => services.agents.get(id)?.status === 'running',
    liveAgent: id => services.agents.get(id),
    record: async (session, type, value) => { const records = await runtimeModule('@deepseek-ai/dsh-session'); records.appendPluginRecord(session, type, value) },
    projections: services.sessionProjections, systemPrompt: services.systemPrompt, skills: services.skills,
    notify, mcp: manager ? assistantMcp(manager) : undefined,
  })
  domains.assistant = assistant.handler
  assistant.registerTools(services.tools)
  const extractionRecoveryLifetime = new AbortController()
  ctx.on('agent/request-error' as any, createToolInputRecovery(assetRoot, services.sessionProjections, extractionRecoveryLifetime.signal) as any)
  ctx.on('llm/stream' as any, (async function* (request: any, next: any) {
    if (request.sessionId) await assistant.beforeModelCall(String(request.sessionId))
    yield* guardToolArguments(next())
  }) as any)
  ctx.on('agent/created' as any, (({ agent }: any) => {
    const state = services.sessionProjections.stateOf(agent.session, 'harnessPlatformAssistant')
    const scope = taskScope(agent, state)
    if (scope) taskScopes.apply(agent, scope)
  }) as any)
  ctx.on('agent/disposed' as any, (({ agent }: any) => taskScopes.release(agent)) as any)
  ctx.on('system-prompt/assemble' as any, (async (_assembly: any, context: any, next: any) => {
    const agent = context.agent
    const state = agent && services.sessionProjections.stateOf(agent.session, 'harnessPlatformAssistant')
    const scope = taskScope(agent, state)
    if (agent && scope) taskScopes.apply(agent, scope)
    else if (agent && assistant.isManagementSession(agent)) taskScopes.release(agent)
    const assembly = await assistant.assemblePrompt(await next(), context)
    if (!scope) return assembly
    const names = ['skill', 'platform_agents']
    const tools = assembly.tools.filter((tool: any) => names.includes(tool.name))
    return { ...assembly, tools: isDecisionExtraction(assetRoot, agent, state) ? projectDecisionExtractionTools(tools) : tools }
  }) as any)
  ctx.effect(() => () => taskScopes.dispose())
  ctx.effect(() => () => assistant.dispose())
  ctx.effect(() => () => extractionRecoveryLifetime.abort())
  ctx.on('session/event' as any, ((session: any) => notify(['assistant'], [session.id])) as any)
  ctx.on('agent/status' as any, ((event: any) => notify(['assistant'], [event.agent.id])) as any)
  ctx.on('settings/document-updated' as any, (() => notify(['mcp', 'catalog'])) as any)
  registrationContext.connection.rpc.handle(CHANNEL, handler)
  applyMcpGateway(registrationContext, assetRoot, mcp)
}


export async function apply(ctx: Context, config: Config) {
  const assetRoot = process.env.HARNESS_ASSET_ROOT
  if (!assetRoot) throw new Error('未设置 HARNESS_ASSET_ROOT')
  await bindConversationWorkspace(ctx, assetRoot)
  await applyAuthentication(ctx, assetRoot)
  // 替换原生明暗主题图标，避免浏览器从多条候选中继续选择 DSH 图标。
  const icon = `<link rel="icon" type="image/svg+xml" href="${logo.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" />`
  ctx.effect(() => ctx.webServer.tapIndex(html => html
    .replace(/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*>/gi, '')
    .replace(/<title>[^<]*<\/title>/i, '<title>Harness工程平台</title>')
    .replace('</head>', `${icon}</head>`)))
  applyTools(ctx)
  const publicUrl = platformEntryUrl(assetRoot, { publicUrl: config.publicUrl, host: ctx.webServer.host,
    fallback: `${ctx.webServer.protocol}//${ctx.webServer.host}:${ctx.webServer.port}${ctx.webServer.publicPath('/')}` })
  await applyBusinessGateway(ctx, assetRoot)
  WebApp.apply(ctx, { ...config, publicUrl })
}
