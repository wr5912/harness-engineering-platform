import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import * as manager from 'harness-mcp-manager-server'
import { workspaceConfigPath } from '../workspace.ts'
import { COMPOSITION_SERVICE_ID, publishedCompositionService, readCompositions } from './compositions.ts'
import { createPublishedCompositionClient } from './index.ts'
import { createManagedMcpHandler } from './native.ts'
import { executableCatalog, type CompositionExtension } from './extension.ts'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { getBusinessControl, currentBusinessContext, withBusinessContext, withSignedRuntimeSession } from '../business-control/core.ts'
import { businessRpcDigest, readBusinessSecret, resolveBusinessInstance, verifyBusinessAssertion, type BusinessGatewayConfig, type RuntimeAssertion } from '../business-control/gateway.ts'
import { platformEntryUrl, platformGroupServer, platformGroupUrl } from '../business-control/group-link.ts'
import { managedDispatch, managementDispatch } from './control.ts'
import { setBusinessReportHeaderResolver } from '../business-control/reports.ts'
import { createBusinessControlHandler } from '../business-control/management.ts'
import { loadOpenApi } from 'harness-mcp-manager-openapi'
import { McpConfigStore, type McpConfigurationView } from './store.ts'

export const { name, Config, validateConfiguration } = manager
export const inject = manager.inject
export interface ManagerConfig {
  servers: { get(): any[] }
  groups: { get(): any[] }
  dispatch?: (request: any, signal?: AbortSignal) => Promise<{ status: number; value: any }>
  compositionHandler?: ConnectionRpcHandler
  compositionExtension?: CompositionExtension
  currentGroup?: (id: string, version?: 1 | 2) => { id: string; targetDigest: string } | undefined
  control?: ConnectionRpcHandler
  configuration?: () => McpConfigurationView
  saveConfiguration?: (ops: any[], revision: string) => McpConfigurationView
}

const connectionFields = ['specUrl', 'url', 'managementUrl', 'authType', 'authHeader', 'loginUrl',
  'loginTokenPath', 'apiKey', 'loginUsername', 'loginPassword', 'headers'] as const

function businessServers(assetRoot: string, candidateServers: any[], platformServers: any[]): any[] {
  const platformById = new Map(platformServers.map(server => [server.id, server]))
  return candidateServers.map(candidate => {
    // Candidate 保留分组身份；部署入口由当前工作区解析，不沿用种子中的宿主地址。
    if (candidate.url && new URL(candidate.url).pathname.endsWith(`/mcp/groups/${candidate.id}/v2`)) {
      return { ...candidate, url: platformGroupUrl(assetRoot, candidate.id) }
    }
    const current = platformById.get(candidate.id)
    const server = { ...candidate }
    for (const field of connectionFields) delete server[field]
    if (!current) return { ...server, enabled: false }
    for (const field of connectionFields) if (Object.hasOwn(current, field)) server[field] = current[field]
    const candidateTools = candidate.tools
    const platformTools = current.tools
    const tools = candidateTools.mode === 'selected'
      ? { ...candidateTools, names: candidateTools.names.filter((name: string) => platformTools.mode === 'all' || platformTools.names.includes(name)) }
      : platformTools.mode === 'selected' ? platformTools : candidateTools
    return { ...server, enabled: candidate.enabled !== false && current.enabled !== false, tools }
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context { platformMcp: ManagerConfig }
}
export function apply(ctx: Context, suppliedConfig: ManagerConfig) {
  const assetRoot = process.env.HARNESS_ASSET_ROOT
  if (!assetRoot) throw new Error('未设置 HARNESS_ASSET_ROOT')
  const businessRuntime = (ctx as any).get('businessRuntime')
  const compositionExtension: CompositionExtension = {}
  const publishedService = () => {
    const catalog = readCompositions(workspaceConfigPath(assetRoot, 'mcp-compositions.json')).catalog
    return publishedCompositionService(catalog, executableCatalog(catalog, compositionExtension))
  }
  const store = new McpConfigStore(assetRoot, value => {
    if (value.servers.some(server => server.id === COMPOSITION_SERVICE_ID || server.platformComposition)) {
      throw new Error('platform-compositions 是已发布编排的保留服务 ID')
    }
    const service = publishedService()
    manager.validateConfiguration({ ...value, servers: service ? [...value.servers, service] : value.servers })
  })
  store.view()
  const config = businessRuntime ? { ...suppliedConfig,
    servers: { get: () => businessServers(assetRoot, suppliedConfig.servers.get(), store.view().value.servers) },
  } : { ...suppliedConfig,
    servers: { get: () => store.view().value.servers },
    groups: { get: () => store.view().value.groups },
    sharedToken: { get: () => store.view().value.sharedToken },
  }
  let dispatch: ManagerConfig['dispatch']
  const compositionHandler = createManagedMcpHandler(assetRoot, () => config.servers.get(), { extension: compositionExtension })
  const platformClient = createPublishedCompositionClient(assetRoot, compositionHandler)
  const control = getBusinessControl(assetRoot)
  const execute = managedDispatch(assetRoot)
  const signedGroupRequests = new WeakMap<object, RuntimeAssertion>()
  const groupNonces = new Map<string, number>()
  ctx.effect(() => setBusinessReportHeaderResolver(assetRoot, async (serverId, expectedOrigin) => {
    const server = config.servers.get().find(value => value.id === serverId && value.enabled !== false)
    if (!server) throw new Error('报告依赖连接已停用')
    manager.assertConnectionReady(server)
    const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const expected = fingerprint(server)
    const currentOrigin = server.specUrl ? (await loadOpenApi(server)).base.origin : new URL(server.url).origin
    if (currentOrigin !== expectedOrigin) throw new Error('报告依赖连接的实际目标已经变化')
    const headers = Object.fromEntries((server.headers ?? []).map((header: any) => [header.name, header.value])) as Record<string, string>
    Object.assign(headers, execute.requestHeaders?.(expectedOrigin))
    if (server.apiKey) headers[server.authHeader ?? 'Authorization'] = server.authType === 'credential' ? server.apiKey : `Bearer ${server.apiKey}`
    if (server.authType === 'login') throw new Error('此报告下载连接尚未支持登录凭据适配')
    return { headers, assertCurrent: () => {
      const current = config.servers.get().find(value => value.id === serverId && value.enabled !== false)
      if (!current || fingerprint(current) !== expected) throw new Error('报告依赖连接或工具范围已变化')
    } }
  }))
  const controlHandler = createBusinessControlHandler(assetRoot)
  manager.apply(ctx, { ...config, platformClient, autoMountServers: Boolean(businessRuntime),
    platformExecute: execute,
    ...(businessRuntime ? {
      businessGroupUrl: (id: string) => businessRuntime.groupUrl(id),
      businessGroupFetch: (id: string, sessionId?: string) => businessRuntime.groupFetch(id, sessionId),
    } : {}),
    acceptGroupTransport: (req: any) => {
      const encoded = req.headers['x-harness-business-context']
      if (typeof encoded !== 'string' || encoded.length > 256_000) throw new Error('业务分组签名缺失')
      // 这两个字段仅用于定位本地登记；直到 HMAC 核验成功都不作为身份。
      let selected: { agentId: string; instanceId: string }
      try {
        const candidate = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as RuntimeAssertion
        selected = { agentId: candidate.binding.agentId, instanceId: candidate.binding.instanceId }
      } catch { throw new Error('业务分组签名信封无效') }
      const gateway = control.config().gateway as Partial<BusinessGatewayConfig> | undefined
      const registered = gateway?.instances?.find(item => item.agentId === selected.agentId && item.instanceId === selected.instanceId)
      if (!control.enabled() || !registered || typeof gateway?.sharedSecretFile !== 'string') throw new Error('业务实例未开放')
      const instance = resolveBusinessInstance(assetRoot, registered)
      const logical = new URL(req.url || '/', 'http://localhost')
      const path = ctx.webServer.publicPath(logical.pathname) + logical.search
      const assertion = verifyBusinessAssertion(readBusinessSecret(gateway.sharedSecretFile), req.headers,
        req.method || 'POST', path, instance.binding, groupNonces)
      control.registerInstance(instance.binding)
      control.recordAgentAuthentication(instance.binding)
      signedGroupRequests.set(req, assertion)
      return true
    },
    withGroupRequest: <T>(req: any, method: string, run: () => Promise<T>, rpcRequest: any) => {
      if (!control.enabled()) return run()
      const assertion = signedGroupRequests.get(req)
      if (!assertion) return managementDispatch(assetRoot, run)
      if (method === 'tools/list') return run()
      if (!assertion?.context?.scope.sessionId) throw new Error('业务 MCP 请求缺少受信 Session')
      if (assertion.requestDigest !== businessRpcDigest(rpcRequest)) throw new Error('业务 MCP 请求内容与签名不一致')
      return withSignedRuntimeSession(() => {
        const context = control.acceptContext(assertion.context!)
        control.assert(context, 'agent:access', [{ kind: 'agent', id: context.scope.agentId }])
        return withBusinessContext(context, run)
      })
    },
    platformTransportForServer: (server: { id: string; url?: string }) => {
      const runtime = (ctx as any).get('businessRuntime')
      return runtime && platformGroupServer(assetRoot, server) ? { fetch: runtime.groupFetch(server.id) } : undefined
    },
    onManagedResourceServer: (serverId: string, registered: boolean) => {
      const runtime = (ctx as any).get('businessRuntime')
      if (runtime?.resourceServers) { if (registered) runtime.resourceServers.add(serverId); else runtime.resourceServers.delete(serverId) }
    },
    onManagedTool: (name: string, registered: boolean) => {
      const runtime = (ctx as any).get('businessRuntime')
      if (runtime?.managedTools) { if (registered) runtime.managedTools.add(name); else runtime.managedTools.delete(name) }
    },
    withManagement: <T>(run: () => Promise<T>) => {
      if ((ctx as any).get('businessRuntime') && !currentBusinessContext()) throw new Error('业务执行缺少受信任务上下文')
      return managementDispatch(assetRoot, run)
    },
    ...(control.enabled() ? { withToolContext: async (execution: any, run: () => Promise<any>) => {
      const runtime = (ctx as any).get('businessRuntime')
      const sessionId = execution.agent?.session?.id ?? (runtime ? undefined : execution.agent?.id)
      const context = typeof sessionId === 'string' ? control.contextForSession(sessionId) : undefined
      if (runtime && (!sessionId || !context)) throw new Error('业务工具调用缺少受信 Session 归属')
      if (context) {
        const active = currentBusinessContext()
        if (runtime && active && (active.subject.id !== context.subject.id
          || active.subject.identitySource !== context.subject.identitySource
          || active.scope.workspaceId !== context.scope.workspaceId || active.scope.agentId !== context.scope.agentId
          || active.scope.instanceId !== context.scope.instanceId || active.scope.runtimeGeneration !== context.scope.runtimeGeneration
          || active.sourceDigest !== context.sourceDigest)) throw new Error('业务工具调用的主体或实例与当前上下文不一致')
        if (runtime && active?.scope.sessionId && active.scope.sessionId !== sessionId
          && !runtime.isTrustedChildSession?.(active.scope.sessionId, sessionId)) throw new Error('业务工具调用的 Session 与当前上下文不一致')
        return withBusinessContext({ ...context, invocationId: execution.callId }, run)
      }
      if (currentBusinessContext()) return run()
      return managementDispatch(assetRoot, run)
    } } : {}),
    platformDispatch: (handler: NonNullable<ManagerConfig['dispatch']>) => { dispatch = handler }, servers: { get() {
    const servers = config.servers.get()
    if (servers.some(server => server.id === COMPOSITION_SERVICE_ID || server.platformComposition)) throw new Error('platform-compositions 是已发布编排的保留服务 ID')
    if (businessRuntime) return servers
    const service = publishedService()
    return service ? [...servers, service] : servers
  } } })
  ctx.provide('platformMcp', { ...config, compositionHandler, compositionExtension,
    ...(!businessRuntime ? { configuration: () => ({ ...store.view(), publicUrl: platformEntryUrl(assetRoot) }),
      saveConfiguration: (ops: any[], revision: string) => {
        const publicUrl = platformEntryUrl(assetRoot)
        return { ...store.mutate(ops, revision), publicUrl }
      } } : {}),
    control: (endpoint, payload, signal) => controlHandler(endpoint, payload, signal, ctx.connection.browserPeer),
    currentGroup: (id, version) => (ctx as any).mcpSessionManager.currentGroup(id, version), dispatch: (request, signal) => {
    if (!dispatch) throw new Error('MCP 管理服务尚未就绪')
    return dispatch(request, signal)
  } })
}
