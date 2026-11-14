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
import { BusinessTransportError, businessRpcDigest, readBusinessAssertion, readBusinessSecret, requireBusinessToken, resolveBusinessInstance, verifyBusinessAssertion, type BusinessGatewayConfig, type RuntimeAssertion } from '../business-control/gateway.ts'
import { platformEntryUrl, platformGroupServer, platformGroupUrl } from '../business-control/group-link.ts'
import { managedDispatch, managementDispatch } from './control.ts'
import { setBusinessReportHeaderResolver } from '../business-control/reports.ts'
import { createBusinessControlHandler } from '../business-control/management.ts'
import { loadOpenApi } from 'harness-mcp-manager-openapi'
import { McpConfigStore, type McpConfigurationView } from './store.ts'
import type { BusinessContext } from '../business-control/contracts.ts'
import { inspectDraftBinding, withDraftInstance } from './draft-bindings.ts'
import { bindPlatformGroupConnection } from '../standalone/connections.ts'

export const { name, Config, validateConfiguration } = manager
export const inject = manager.inject
export interface ManagerConfig {
  servers: { get(): any[] }
  groups: { get(): any[] }
  mountServers?: (servers: any[]) => any[]
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

/** 仅补充来源已声明、但没有本地客户端的组成员引用；不发布平台全部目录。 */
function businessGroups(candidateServers: any[], candidateGroups: any[], platform: { servers: any[]; groups: any[] }): any[] {
  const direct = new Set(candidateServers.map(server => server.id))
  return candidateGroups.flatMap(group => {
    if (group.members.every((member: any) => direct.has(member.serverId))) return [group]
    const saved = platform.groups.find(value => value.id === group.id)
    if (!saved) return []
    const members = group.members.flatMap((member: any) => {
      if (direct.has(member.serverId)) return [member]
      const selected = saved.members.find((value: any) => value.serverId === member.serverId)
      if (!selected || !platform.servers.some(server => server.id === member.serverId && server.enabled !== false)) return []
      const names = member.names.filter((name: string) => selected.names.includes(name))
      const resourceUris = (member.resourceUris ?? []).filter((uri: string) => (selected.resourceUris ?? []).includes(uri))
      const resourceTemplates = (member.resourceTemplates ?? []).filter((uri: string) => (selected.resourceTemplates ?? []).includes(uri))
      return names.length || resourceUris.length || resourceTemplates.length
        ? [{ ...member, names, resourceUris, resourceTemplates }] : []
    })
    return members.length ? [{ ...group, members }] : []
  })
}

function businessServers(assetRoot: string, candidateServers: any[], platformServers: any[]): any[] {
  const platformById = new Map(platformServers.map(server => [server.id, server]))
  return candidateServers.map(candidate => {
    // Candidate 保留分组身份；部署入口由当前工作区解析，不沿用种子中的宿主地址。
    const bound = bindPlatformGroupConnection(candidate, id => platformGroupUrl(assetRoot, id))
    if (bound) return bound
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
    const { compositions: drafts, error: draftBindingError } = inspectDraftBinding(assetRoot)
    const available = executableCatalog(catalog, compositionExtension)
    return { ...publishedCompositionService({ ...available, compositions: [...available.compositions.filter(item => !drafts.some(draft => draft.config.toolName === item.published?.toolName)), ...drafts.map(item => ({ id: item.id, published: item.config }))] }), draftBindingError }
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
    groups: { get: () => businessGroups(suppliedConfig.servers.get(), suppliedConfig.groups.get(), store.view().value) },
    servers: { get: () => {
      const platform = store.view().value, declared = suppliedConfig.servers.get()
      const referenced = businessGroups(declared, suppliedConfig.groups.get(), platform).flatMap(group => group.members)
      const servers = [...declared]
      for (const member of referenced) if (!declared.some((server: any) => server.id === member.serverId)) {
        const existing = servers.find(server => server.id === member.serverId)
        if (existing) existing.tools.names = [...new Set([...existing.tools.names, ...member.names])]
        else servers.push({ id: member.serverId, enabled: true, tools: { mode: 'selected', names: [...member.names] } })
      }
      return businessServers(assetRoot, servers, platform.servers)
    } },
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
  const businessGroupRequests = new WeakMap<object, RuntimeAssertion>()
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
      // 引用成员仅供组服务内部调用，不自动变成主/子角色的新底层MCP客户端。
      mountServers: (servers: any[]) => {
        const declared = suppliedConfig.servers.get()
        const direct = servers.filter(server => declared.some((value: any) => value.id === server.id))
        return suppliedConfig.mountServers ? suppliedConfig.mountServers(direct) : direct
      },
      businessGroupUrl: (id: string) => businessRuntime.groupUrl(id),
      businessGroupFetch: (id: string, sessionId?: string) => businessRuntime.groupFetch(id, sessionId),
    } : {}),
    acceptGroupTransport: (req: any) => {
      const encoded = req.headers['x-harness-business-context']
      if (typeof encoded !== 'string' || encoded.length > 256_000) throw new BusinessTransportError('binding', '业务分组上下文缺失')
      // 这两个字段只用于定位本地登记；模式以本地配置为准。
      let selected: { agentId: string; instanceId: string }
      try {
        const candidate = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as RuntimeAssertion
        selected = { agentId: candidate.binding.agentId, instanceId: candidate.binding.instanceId }
      } catch { throw new BusinessTransportError('binding', '业务分组上下文无效') }
      const gateway = control.config().gateway as Partial<BusinessGatewayConfig> | undefined
      const registered = gateway?.instances?.find(item => item.agentId === selected.agentId && item.instanceId === selected.instanceId)
      if (!registered || !control.enabled() && registered.accessMode !== 'anonymous') throw new BusinessTransportError('registration', '业务实例未开放')
      let instance: ReturnType<typeof resolveBusinessInstance>
      try { instance = resolveBusinessInstance(assetRoot, registered) }
      catch { throw new BusinessTransportError('binding', '业务实例来源或代次不匹配') }
      const logical = new URL(req.url || '/', 'http://localhost')
      const path = ctx.webServer.publicPath(logical.pathname) + logical.search
      let assertion: RuntimeAssertion
      if (control.isUnrestrictedInstance(instance.binding)) {
        requireBusinessToken(req.headers.authorization, assetRoot)
        assertion = readBusinessAssertion(req.headers, instance.binding)
      } else {
        try { assertion = verifyBusinessAssertion(readBusinessSecret(gateway?.sharedSecretFile), req.headers,
          req.method || 'POST', path, instance.binding, groupNonces) }
        catch { throw new BusinessTransportError('signature', '已发布实例的签名无效、过期或已使用') }
      }
      control.registerInstance(instance.binding)
      control.recordAgentAuthentication(instance.binding)
      businessGroupRequests.set(req, assertion)
      return true
    },
    withGroupTransport: <T>(req: any, run: () => Promise<T>) => {
      const assertion = businessGroupRequests.get(req)
      return assertion ? withDraftInstance(assertion.binding, run) : run()
    },
    withGroupRequest: <T>(req: any, method: string, run: () => Promise<T>, rpcRequest: any) => {
      const assertion = businessGroupRequests.get(req)
      if (!assertion) return managementDispatch(assetRoot, run)
      if (!control.enabled() && !control.isAnonymousInstance(assertion.binding)) throw new BusinessTransportError('registration', '业务接入已关闭')
      const scopedRun = () => withDraftInstance(assertion.binding, run)
      if (method === 'tools/list') return scopedRun()
      const sharedResourceRead = control.isAnonymousInstance(assertion.binding)
        && ['resources/list', 'resources/templates/list', 'resources/read'].includes(method)
      if (!assertion.context || !sharedResourceRead && !assertion.context.scope.sessionId) throw new BusinessTransportError('context', '业务 MCP 请求缺少受信 Session')
      if (!control.isUnrestrictedInstance(assertion.binding) && assertion.requestDigest !== businessRpcDigest(rpcRequest)) throw new BusinessTransportError('signature', '业务 MCP 请求内容与签名不一致')
      return withSignedRuntimeSession(() => {
        let context: BusinessContext
        try {
          context = control.acceptContext(assertion.context!)
          control.assert(context, 'agent:access', [{ kind: 'agent', id: context.scope.agentId }])
        } catch { throw new BusinessTransportError('context', '业务 Session、身份或实例许可已失效') }
        return withBusinessContext(context, scopedRun)
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
    withToolContext: async (execution: any, run: () => Promise<any>) => {
      execution.signal?.throwIfAborted()
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
    },
    workspaceId: assetRoot,
    groupUrl: (id: string) => platformGroupUrl(assetRoot, id),
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
