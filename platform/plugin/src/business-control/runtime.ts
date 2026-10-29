import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionAdmission, ConnectionIndexRequest, ConnectionIndexResponse, ConnectionTrustRequest, PeerAdmission, PeerScope } from '@deepseek-ai/dsh-client-connection'
import { runtimeModule } from '../../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { getBusinessControl, configureBusinessControlStateRoot, currentBusinessContext, withBusinessContext, type BusinessControl } from './core.ts'
import type { BusinessContext, BusinessOperation, InstanceBinding } from './contracts.ts'
import { readBusinessReport } from './reports.ts'
import { HttpIdentityTrustProvider } from './providers.ts'
import { businessRpcDigest, readBusinessSecret, signBusinessAssertion, verifyBusinessAssertion, type RuntimeAssertion } from './gateway.ts'
import { platformGroupUrl } from './group-link.ts'

const containerConnectionManifest = '/opt/dsh/packages/client/connection/package.json'
const NativeConnection: typeof import('@deepseek-ai/dsh-client-connection') = await runtimeModule('@deepseek-ai/dsh-client-connection', existsSync(containerConnectionManifest) ? containerConnectionManifest : undefined)
const PRINCIPAL = 'harness-business'
import type { BusinessRuntimeConfig } from './patch.ts'
export { createBusinessRuntimePatch } from './patch.ts'
export type { BusinessRuntimeConfig } from './patch.ts'
interface BusinessPrincipal { kind: 'harness-business'; context: BusinessContext }
declare module '@deepseek-ai/dsh-typert-protocol' { interface PrincipalMap { 'harness-business': BusinessPrincipal } }
const generalReads = ['session/list', 'session/search', 'session/modelCatalog', 'session/control', 'remoteAccess/follow',
  'settings/describe', 'credentials/describe', 'permissionPresets/catalog', 'llm/listProviders',
  'dynamicCordisRunner/inventory', 'dynamicCordisRunner/syncInspectManifest', 'commands/list', 'skills/list', 'voiceMode/follow',
  'pluginInventory/list', 'pluginManager/listBundles', 'pluginManager/listPlugins']
/** 自动化任务当前按实例开放；任务目录尚未按访问者过滤，跨用户可见性作为已知缺陷记录。 */
const scheduleActions = ['schedule/list', 'schedule/catalog', 'schedule/history', 'schedule/delete', 'schedule/update', 'event:schedule/changed']
const sessionActions = ['session/page', 'session/follow', 'session/projections', 'session/attachment', 'session/prompt', 'session/cancel', 'session/updateQueue', 'session/rename', 'session/fork', 'session/selectModel']
const sessionEvents = ['event:api-session/activity', 'event:api-session/added', 'event:api-session/error', 'event:api-session/removed', 'event:api-session/status']
const requestContext = new WeakMap<object, { peer: PeerScope; context: BusinessContext }>()
function headersOf(request: ConnectionTrustRequest): IncomingMessage['headers'] {
  return request.headers instanceof Headers ? Object.fromEntries(request.headers) : request.headers as IncomingMessage['headers']
}
function requestAddress(request: ConnectionTrustRequest): { method: string; path: string } {
  const node = request as ConnectionIndexRequest
  return { method: node.method || 'GET', path: node.url || '/' }
}

/** 保留原生 Connection 注册表与 Gateway/mux，仅替换公开的接入认证方法。 */
export class BusinessConnection extends NativeConnection.HostConnectionService {
  private nonces = new Map<string, number>()
  private businessPeers = new Map<PeerScope, BusinessContext>()
  private disposedBusiness = false
  private businessLifetime = new AbortController()
  private refreshing?: Promise<void>
  private peerTrustChecks = new Map<string, Promise<void>>()
  private readonly secret: Buffer
  private latestSnapshot?: RuntimeAssertion['snapshot']
  constructor(ctx: Context, readonly businessConfig: BusinessRuntimeConfig, readonly control: BusinessControl) {
    // 所有业务 admission 均经网关签名验证，不使用原生免校验 browserPeer。
    super(ctx, [], { isAuthenticated: () => false, authenticateApi: () => undefined } as never)
    this.secret = readBusinessSecret(businessConfig.sharedSecretFile)
    control.registerInstance(businessConfig.binding)
    control.requireSnapshot(businessConfig.binding.instanceId)
    const timer = setInterval(() => { void this.refresh().catch(() => { /* 租约到期由同步授权与Peer检查拒绝。 */ }) }, 500)
    const monitor = setInterval(() => { for (const [peer, context] of this.businessPeers) {
      try { if (!control.enabled()) throw new Error('业务控制已关闭'); control.assert(context, 'agent:access', [{ kind: 'agent', id: context.scope.agentId }]) }
      catch { void peer.dispose(); this.businessPeers.delete(peer) }
    } }, 100)
    timer.unref(); monitor.unref()
    void this.refresh().catch(() => { /* 尚未握手时拒绝执行，后续定期重试受信通道。 */ })
    ctx.effect(() => async () => { this.disposedBusiness = true; this.businessLifetime.abort(); clearInterval(timer); clearInterval(monitor); await Promise.all([...this.businessPeers.keys()].map(peer => peer.dispose())); this.businessPeers.clear() }, 'business connection: Peer and lease lifecycle')
  }
  /** 仅向当前受信平台分组发送请求；每次请求使用最新 Session 事实重新签名。 */
  groupFetch(groupId: string, sessionId?: string): typeof fetch {
    return async (input, init) => {
      const actual = new URL(input instanceof Request ? input.url : String(input))
      if (actual.href !== platformGroupUrl(this.businessConfig.assetRoot, groupId)) throw new Error('平台 MCP 分组请求目标已变化')
      const context = sessionId ? this.control.contextForSession(sessionId) : currentBusinessContext()
      if (sessionId && !context) throw new Error('业务 MCP 请求缺少当前 Session')
      if (context) this.control.assert(context, 'agent:access', [{ kind: 'agent', id: context.scope.agentId }])
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      for (const key of [...headers.keys()]) if (key.startsWith('x-harness-')) headers.delete(key)
      const outgoing = new Request(input, { ...init, method, headers, redirect: 'error' })
      let requestDigest: string | undefined
      if (method === 'POST') {
        const body = await outgoing.clone().text()
        if (Buffer.byteLength(body) > 64 * 1024) throw new Error('业务 MCP 请求体超过 64 KiB')
        requestDigest = businessRpcDigest(JSON.parse(body))
      }
      const assertion: RuntimeAssertion = { binding: this.businessConfig.binding,
        ...(context ? { context } : {}), ...(requestDigest ? { requestDigest } : {}),
        issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') }
      for (const [key, value] of Object.entries(signBusinessAssertion(this.secret, assertion, method,
        actual.pathname + actual.search))) headers.set(key, value)
      return fetch(outgoing, { headers, redirect: 'error' })
    }
  }
  invalidateSubject(ctx: Context, context: BusinessContext): void {
    for (const [peer, current] of this.businessPeers) {
      if (current.subject.id === context.subject.id && current.subject.identitySource === context.subject.identitySource
        && current.scope.workspaceId === context.scope.workspaceId && current.scope.agentId === context.scope.agentId
        && current.scope.instanceId === context.scope.instanceId) (ctx as any).remoteAccess.invalidate(peer.principal)
    }
  }
  private assertion(request: ConnectionTrustRequest): RuntimeAssertion {
    const { method, path: logicalPath } = requestAddress(request)
    const prefix = this.businessConfig.basePath?.replace(/\/$/, '') || ''
    const path = prefix && !logicalPath.startsWith(prefix + '/') ? prefix + logicalPath : logicalPath
    const assertion = verifyBusinessAssertion(this.secret, headersOf(request), method, path, this.businessConfig.binding, this.nonces)
    if (!assertion.snapshot || !this.control.acceptSnapshot(assertion.snapshot)) throw new Error('业务许可快照无效')
    this.latestSnapshot = assertion.snapshot
    return assertion
  }
  override admit(request: ConnectionTrustRequest): PeerAdmission {
    if (this.disposedBusiness) return { rejection: 401 }
    const cached = requestContext.get(request)
    if (cached) return { peer: cached.peer }
    try {
      const assertion = this.assertion(request)
      if (!assertion.context) return { rejection: 401 }
      const context = this.control.acceptContext(assertion.context)
      this.control.assert(context, 'agent:access', [{ kind: 'agent', id: context.scope.agentId }])
      // 无需认证的开发实例共享整个原生界面；已认证及已发布实例保留各自资源合同。
      const sharedDevelopment = this.control.isDevelopmentContext(context) && this.control.isSharedContext(context)
      const peer = this.createPeer({ principal: sharedDevelopment ? { kind: 'owner' } : { kind: PRINCIPAL, context }, interactions: 'answer' })
      this.businessPeers.set(peer, context); requestContext.set(request, { peer, context })
      peer.signal.addEventListener('abort', () => this.businessPeers.delete(peer), { once: true })
      return { peer }
    } catch { return { rejection: 403 } }
  }
  override admitConnection(request: ConnectionTrustRequest): ConnectionAdmission {
    const admitted = this.admit(request)
    if ('rejection' in admitted) return admitted
    return { peer: admitted.peer, release: () => admitted.peer.dispose() }
  }
  override authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    const admitted = this.admit(request)
    if ('rejection' in admitted) { response.writeHead(admitted.rejection); response.end('业务访问被拒绝'); return false }
    const actualResponse = response as ServerResponse
    actualResponse.once?.('finish', () => { void admitted.peer.dispose() })
    return true
  }
  override authorizeConnect(_request: ConnectionIndexRequest, response: ConnectionIndexResponse): void { response.writeHead(403); response.end('业务入口不提供 owner 接入') }
  override authenticatedUrl(base: string): string { return base }
  contextForPeer(peer: PeerScope): BusinessContext {
    const context = this.businessPeers.get(peer)
    if (!context) throw new Error('业务连接上下文缺失')
    return context
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const task = this.refreshOnce().finally(() => { if (this.refreshing === task) this.refreshing = undefined })
    this.refreshing = task
    return task
  }
  /** 确认前先完成旧心跳，再发送含本次检测事实的新观察；调用取消不打断共享心跳。 */
  async refreshLatest(signal?: AbortSignal): Promise<void> {
    const wait = async (task: Promise<void>): Promise<void> => {
      if (!signal) return task
      signal.throwIfAborted()
      let abort!: () => void
      const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
      try { await Promise.race([task, cancelled]) } finally { signal.removeEventListener('abort', abort) }
    }
    const previous = this.refreshing
    if (previous) await wait(previous)
    signal?.throwIfAborted()
    const facts = this.control.exportReplicaState(this.businessConfig.binding).riskFacts
    await wait(this.refresh())
    if (facts.some(fact => !this.latestSnapshot?.riskFacts.some(known => known.id === fact.id && known.version >= fact.version))) throw new Error('控制快照未确认本次风险事实')
  }
  private async refreshOnce(): Promise<void> {
    if (this.disposedBusiness) return
    const url = new URL(`/control/${this.businessConfig.binding.instanceId}`, this.businessConfig.coordinatorOrigin)
    const assertion: RuntimeAssertion = { binding: this.businessConfig.binding, ...(this.latestSnapshot ? { snapshot: this.latestSnapshot } : {}), observation: this.control.exportReplicaState(this.businessConfig.binding), issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') }
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signBusinessAssertion(this.secret, assertion, 'POST', url.pathname)), signal: AbortSignal.any([this.businessLifetime.signal, AbortSignal.timeout(1000)]) })
    if (this.disposedBusiness) return
    if (!response.ok) throw new Error('控制服务未确认租约')
    const signed = await response.json() as Record<string, string>
    const updated = verifyBusinessAssertion(this.secret, signed, 'RESPONSE', url.pathname, this.businessConfig.binding, this.nonces)
    if (!updated.snapshot || !this.control.acceptSnapshot(updated.snapshot)) throw new Error('控制服务快照无效')
    this.latestSnapshot = updated.snapshot
    this.refreshPeerTrust()
  }
  private peerTrustKey(context: BusinessContext): string {
    const evidence = context.identity?.evidence
    return JSON.stringify([context.subject, evidence && { issuer: evidence.issuer, externalSubject: evidence.externalSubject, method: evidence.method, credentialRef: evidence.credentialRef, expiresAt: evidence.expiresAt }])
  }
  /** 用户信任复核独立于Agent续租；同一凭据只保留一项请求，慢用户不拖住其他连接。 */
  private refreshPeerTrust(): void {
    const trustConfig = this.control.config().identityTrust
    if (!trustConfig || this.disposedBusiness) return
    for (const context of this.businessPeers.values()) {
      if (this.control.isSharedContext(context)) continue
      const key = this.peerTrustKey(context)
      if (this.peerTrustChecks.has(key)) continue
      const task = (async () => {
        const result = context.identity ? await new HttpIdentityTrustProvider(trustConfig).resolve(context.identity.evidence, AbortSignal.any([this.businessLifetime.signal, AbortSignal.timeout(1000)])) : undefined
        if (this.disposedBusiness || (result?.kind === 'trusted' && result.subject.id === context.subject.id && result.subject.identitySource === context.subject.identitySource)) return
        await Promise.all([...this.businessPeers].filter(([, current]) => this.peerTrustKey(current) === key).map(async ([peer]) => { this.businessPeers.delete(peer); await peer.dispose() }))
      })().finally(() => { if (this.peerTrustChecks.get(key) === task) this.peerTrustChecks.delete(key) })
      this.peerTrustChecks.set(key, task)
      void task.catch(() => { /* Peer释放失败不影响独立的Agent控制通道。 */ })
    }
  }
}

function addressedSession(args: unknown, verifyChild?: (parentId: string, childId: string) => void): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const value = args as { request?: { sessionId?: unknown; address?: { kind?: unknown; sessionId?: unknown; parentSessionId?: unknown; childSessionId?: unknown; mode?: unknown } }; sessionId?: unknown; address?: { kind?: unknown; sessionId?: unknown; parentSessionId?: unknown; childSessionId?: unknown; mode?: unknown } }
  const request = value.request ?? value
  if (request.address !== undefined) {
    if (request.address?.kind === 'session' && typeof request.address.sessionId === 'string' && request.address.sessionId) return request.address.sessionId
    if (request.address?.kind !== 'subagent' || typeof request.address.parentSessionId !== 'string' || !request.address.parentSessionId
      || typeof request.address.childSessionId !== 'string' || !request.address.childSessionId
      || !['one-shot', 'continuable', 'unknown'].includes(String(request.address.mode)) || !verifyChild) throw new Error('业务 Session 地址无效')
    verifyChild(request.address.parentSessionId, request.address.childSessionId)
    return request.address.childSessionId
  }
  const session = request.sessionId
  return typeof session === 'string' && session ? session : undefined
}
function assertChildAddress(control: BusinessControl, context: BusinessContext, binding: InstanceBinding, parentId: string, childId: string): void {
  const parent = control.sessionContext(context, parentId), child = control.sessionContext(context, childId)
  if (!matchesInstance(parent, binding) || !matchesInstance(child, binding)
    || control.parentSessionId(context, childId) !== parentId
    || parent.subject.id !== child.subject.id || parent.subject.identitySource !== child.subject.identitySource) throw new Error('子 Session 归属与地址不一致')
}
function actionFor(endpoint: string): string { return endpoint === 'session/create' || endpoint === 'session/fork' || endpoint === 'workspace/create' ? 'session:create' : endpoint === 'session/prompt' || endpoint === 'session/updateQueue' ? 'session:prompt' : 'session:read' }
function fixedWorkspaceRequest(args: unknown, path?: string): boolean {
  const request = (args as { request?: { path?: unknown } } | undefined)?.request
  return !!path && !!request && typeof request === 'object' && !Array.isArray(request) && Object.keys(request).every(key => key === 'path') && request.path === path
}
function nativeFixedWorkspace(ctx: Context, path?: string): { id: string; path: string } | undefined {
  return path ? (ctx.get('workspaceRegistry') as { list(): { id: string; path: string }[] } | undefined)?.list().find(item => item.path === path) : undefined
}

export function registerBusinessRemotePolicy(ctx: Context, control: BusinessControl, instanceBinding: InstanceBinding, workspacePath?: string): void {
  const remoteAccess = (ctx as any).remoteAccess
  remoteAccess.registerPolicy(PRINCIPAL, {
    bindings(principal: BusinessPrincipal) {
      const context = principal.context
      const binding = (kind: string, id: string | undefined, actions: string[]) => ({
        resource: id === undefined ? { kind } : { kind, id }, role: { name: '业务归属', resource: kind, actions },
        condition(request: { action: string; args?: unknown }) {
          try {
            if (request.action === 'workspace/create' && !fixedWorkspaceRequest(request.args, workspacePath)) throw new Error('业务工作区使用服务端固定路径')
            const session = addressedSession(request.args, (parentId, childId) => assertChildAddress(control, context, instanceBinding, parentId, childId))
            const scoped = session ? control.sessionContext(context, session) : context
            if (sessionActions.includes(request.action) && !session && request.args) throw new Error('Session 缺失')
            control.assert(scoped, actionFor(request.action), kind === 'session' ? [{ kind, id: id! }] : [])
            return { kind: 'allow' }
          } catch { return { kind: 'deny', reason: 'business-access-denied' } }
        },
      })
      const owned = control.listSessions(context)
      const workspace = nativeFixedWorkspace(ctx, workspacePath)
      const workspaceActions = workspacePath ? ['workspace/create', 'workspace/follow'] : []
      return [binding('global', undefined, [...generalReads, ...scheduleActions, 'session/create', ...sessionActions, ...workspaceActions]),
        ...owned.map(id => binding('session', id, [...generalReads, ...scheduleActions, ...sessionActions, ...sessionEvents, ...(workspacePath ? ['workspace/follow'] : [])])),
        ...(workspace ? [binding('workspace', workspace.id, ['workspace/follow', 'session/create'])] : [])]
    },
    explain: () => 'business-access-denied',
  })
  // HTML首帧永远不带owner baseline；原生follow会立刻取得该主体的实际快照。
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: '__DSH_REMOTE_ACCESS__', value: { type: 'baseline', owner: false, grants: [] } })
    // 仅业务 Runtime 装载此样式；只隐藏原生工作区按钮，保留同一行的模型等选项。
    table.push({ kind: 'style', text: '[data-conversation-content] button[aria-haspopup="menu"][aria-label="选择工作区"], [data-conversation-content] button[aria-haspopup="menu"][aria-label="Choose workspace"] { display: none !important; }' })
  })
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; let length = 0
  for await (const raw of req) { const bytes = Buffer.from(raw); length += bytes.length; if (length > 1_048_576) throw new Error('业务请求过大'); parts.push(bytes) }
  return Buffer.concat(parts)
}
async function sendFetch(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) { res.end(); return }
  for await (const bytes of Readable.fromWeb(response.body as never)) {
    if (!res.write(bytes)) await new Promise<void>(resolve => res.once('drain', resolve))
  }
  res.end()
}

/** 所有公开消息写入口都先解析“新增入箱内容”，不依赖端点名称直接放行。 */
export function businessInboxContent(endpoint: string, args: unknown): readonly unknown[] | undefined {
  const request = (args as { request?: { content?: unknown; action?: { kind?: unknown; content?: unknown } } } | undefined)?.request
  const candidate = endpoint === 'session/prompt' ? request?.content
    : endpoint === 'session/updateQueue' && request?.action?.kind === 'edit' ? request.action.content : undefined
  if (candidate === undefined && endpoint !== 'session/prompt' && !(endpoint === 'session/updateQueue' && request?.action?.kind === 'edit')) return undefined
  if (!Array.isArray(candidate) || !candidate.length) throw new Error('业务输入必须有有效内容')
  return candidate
}

/** 原生串行创建接缝在释放恢复队列前等待检测；失败不修改旧队列。 */
interface BusinessAgent {
  session: { id: string; header?: { id?: string; origin?: string; parentSession?: string; delegationDepth?: number } }
  inbox: { nextTurn: readonly { content: readonly unknown[] }[]; nextStep: readonly { content: readonly unknown[] }[] }
}
function matchesInstance(context: BusinessContext, binding: InstanceBinding): boolean {
  return context.scope.workspaceId === binding.workspaceId && context.scope.agentId === binding.agentId
    && context.scope.instanceId === binding.instanceId && context.scope.runtimeGeneration === binding.runtimeGeneration
    && context.sourceDigest === binding.sourceDigest
}
function parentForNativeChild(ctx: Context, control: BusinessControl, binding: InstanceBinding, child: BusinessAgent): BusinessContext | undefined {
  const header = child.session.header, parentId = header?.parentSession
  if (header?.origin !== 'subagent' || typeof parentId !== 'string' || !parentId || header.delegationDepth !== 1
    || header.id !== child.session.id || parentId === child.session.id) return undefined
  const parent = (ctx as any).get('agents')?.get(parentId) as BusinessAgent | undefined
  if (!parent || parent.session.id !== parentId || parent.session.header?.id !== parentId) return undefined
  const context = control.contextForSession(parentId)
  return context && matchesInstance(context, binding) ? context : undefined
}
function trustedNativeChild(ctx: Context, control: BusinessControl, binding: InstanceBinding, parentId: string, childId: string): boolean {
  const child = (ctx as any).get('agents')?.get(childId) as BusinessAgent | undefined
  if (!child || child.session.header?.parentSession !== parentId || !parentForNativeChild(ctx, control, binding, child)) return false
  const parent = control.contextForSession(parentId), own = control.contextForSession(childId)
  return !!parent && !!own && matchesInstance(own, binding)
    && control.parentSessionId(parent, childId) === parentId
    && parent.subject.id === own.subject.id && parent.subject.identitySource === own.subject.identitySource
}

export function registerBusinessInboxChecks(ctx: Context, control: BusinessControl, binding: InstanceBinding): void {
  ;(ctx as any).on('agent/created', async ({ agent, signal }: { agent: BusinessAgent; signal?: AbortSignal }) => {
    const messages = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    let context = control.contextForSession(agent.session.id)
    const header = agent.session.header
    if (header?.origin === 'subagent') {
      const parent = parentForNativeChild(ctx, control, binding, agent)
      if (!parent) throw new Error('子 Session 缺少受信原生父归属')
      context = control.bindSession(parent, agent.session.id, header!.parentSession)
    } else {
      if (header?.origin !== undefined || (header?.delegationDepth !== undefined && header.delegationDepth !== 0)) throw new Error('Session 来源元数据无效')
      const creator = currentBusinessContext()
      // 新Agent在原生串行创建边界先绑定归属，初始队列才可进入执行。
      if (!context && creator && !control.isManagement(creator)) context = control.bindSession(creator, agent.session.id)
    }
    if (!messages.length) return
    if (!context) throw new Error('历史待执行输入缺少可信业务归属，拒绝自动恢复')
    const lifetime = signal || new AbortController().signal
    await control.revalidateIdentity(context, lifetime)
    for (const message of messages) await control.inspect(context, 'input', message.content, lifetime, 'session:prompt')
    control.assert(context, 'session:prompt', [{ kind: 'session', id: agent.session.id }])
  })
}

export const name = 'harness-business-runtime'
export const inject = ['webServer', 'remoteAccess', 'tools', 'approval', 'workspaceRegistry']
const scheduleTools = new Set(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])

export function businessToolDeniedReason(exec: { agent?: { session: { id: string } }; name: string; arguments?: unknown },
  sessionContext: (id: string) => BusinessContext | undefined, managedTools: ReadonlySet<string>,
  localTools: ReadonlySet<string>, resourceServers: ReadonlySet<string>, useNativeTools = false): string | undefined {
  try {
    const id = exec.agent?.session.id
    if (!id || !sessionContext(id)) return '业务 Session 未登记'
    if (useNativeTools) return
    if (scheduleTools.has(exec.name)) return
    const resourceServer = exec.arguments && typeof exec.arguments === 'object'
      ? (exec.arguments as { server?: unknown }).server : undefined
    if (!managedTools.has(exec.name) && !localTools.has(exec.name) && !(typeof resourceServer === 'string' && resourceServers.has(resourceServer) &&
      ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(exec.name))) {
      return '业务入口只开放受管 MCP 工具与资源或来源声明的本地工具'
    }
  } catch { return '业务任务上下文或许可无效' }
}

export async function apply(ctx: Context, config: BusinessRuntimeConfig): Promise<void> {
  if (!config?.binding || !config.assetRoot || !config.stateRoot || !config.coordinatorOrigin || !config.workspacePath) throw new Error('业务 Runtime 配置缺失')
  if (config.localTools !== undefined && (!Array.isArray(config.localTools) || config.localTools.some(name => typeof name !== 'string' || !name)
    || new Set(config.localTools).size !== config.localTools.length)) throw new Error('业务本地工具声明无效')
  if (ctx.get('connection')) throw new Error('业务 Profile 必须停用默认 owner Connection')
  const control = configureBusinessControlStateRoot(config.assetRoot, config.stateRoot)
  if (!control.enabled()) throw new Error('业务 Runtime 控制未启用')
  try {
    await (ctx.get('workspaceRegistry') as { create(path: string): Promise<unknown> }).create(config.workspacePath)
  } catch (error) {
    throw new Error(`业务固定工作区登记失败：${config.workspacePath}：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  control.setAvailable(true)
  ctx.effect(() => () => control.setAvailable(false), 'business Runtime: authorization lifecycle')
  const managedTools = new Set<string>(), resourceServers = new Set<string>(), localTools = new Set(config.localTools ?? [])
  const connection = new BusinessConnection(ctx, config, control)
  ctx.provide('businessRuntime', Object.freeze({ binding: Object.freeze({ ...config.binding }),
    basePath: config.basePath ?? `/agents/${config.binding.agentId}/instances/${config.binding.instanceId}/`, managedTools, resourceServers,
    isTrustedChildSession: (parentId: string, childId: string) => trustedNativeChild(ctx, control, config.binding, parentId, childId),
    groupUrl: (id: string) => platformGroupUrl(config.assetRoot, id),
    groupFetch: (id: string, sessionId?: string) => connection.groupFetch(id, sessionId) }))
  registerBusinessRemotePolicy(ctx, control, config.binding, config.workspacePath)
  registerBusinessInboxChecks(ctx, control, config.binding)
  ;(ctx as any).on('subagent/start', (info: { id: string; provider: string; local: boolean }) => {
    if (!info.local || info.provider !== 'spawn') return
    const child = (ctx as any).get('agents')?.get(info.id) as BusinessAgent | undefined
    const parentId = child?.session.header?.parentSession
    if (!parentId || !trustedNativeChild(ctx, control, config.binding, parentId, info.id)) return
    connection.invalidateSubject(ctx, control.contextForSession(info.id)!)
  })
  // 所有模型工具先恢复Session真实归属；来源声明仅增加精确本地工具，受管MCP仍走平台授权。
  ;(ctx as any).tools.guard((exec: { agent?: { session: { id: string } }; name: string; arguments?: unknown }) => {
    const context = exec.agent?.session.id ? control.contextForSession(exec.agent.session.id) : undefined
    if (context) {
      try { control.assert(context, 'agent:access', [{ kind: 'agent', id: context.scope.agentId }]) }
      catch { return '业务任务上下文或许可无效' }
    }
    return businessToolDeniedReason(exec, id => control.contextForSession(id), managedTools, localTools, resourceServers,
      Boolean(context && control.isDevelopmentContext(context)))
  })
  const approvals = createBusinessApprovalAdapter(ctx, control)
  const fetchHandler = connection.createSharedFetchHandler('/api')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api', handler: async (req, res) => {
    const admission = connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('业务访问被拒绝'); return }
    const lifetime = new AbortController()
    res.once('close', () => lifetime.abort())
    try {
      const base = connection.contextForPeer(admission.peer)
      const report = /^\/api\/business-control\/reports\/([a-f0-9-]{36})$/.exec(new URL(req.url || '/', 'http://runtime').pathname)
      if (report) {
        if (req.method !== 'GET') throw new Error('报告只允许读取')
        const result = await readBusinessReport(config.assetRoot, base, report[1], lifetime.signal)
        res.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${result.filename}"`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" }); res.end(result.body); return
      }
      if (new URL(req.url || '/', 'http://runtime').pathname === '/api/business-control/confirmations') { await approvals.handle(req, res, base); return }
      let body = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readBody(req) : undefined
      const envelope = body ? JSON.parse(body.toString()) : undefined
      const endpoint = new URL(req.url || '/', 'http://runtime').pathname.slice('/api/'.length)
      const session = endpoint === 'session/create' ? undefined : addressedSession(envelope?.payload?.args,
        (parentId, childId) => assertChildAddress(control, base, config.binding, parentId, childId))
      const context = session ? control.sessionContext(base, session) : base
      if (endpoint === 'workspace/create') {
        if (!fixedWorkspaceRequest(envelope?.payload?.args, config.workspacePath)) throw new Error('业务工作区使用服务端固定路径')
        envelope.payload.args.request = { path: config.workspacePath }
        body = Buffer.from(JSON.stringify(envelope))
      }
      if (endpoint === 'session/create') {
        const request = envelope?.payload?.args?.request
        if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['sessionId', 'workspaceId', 'cwd', 'agentPreset'].includes(key))) throw new Error('业务 Session 使用固定工作区与Preset，不接受初始消息')
        // 原生UI的临时ID、工作区与Preset选择均不决定业务来源。
        const workspace = nativeFixedWorkspace(ctx, config.workspacePath)
        envelope.payload.args.request = { ...(workspace ? { workspaceId: workspace.id } : config.workspacePath ? { cwd: config.workspacePath } : {}), ...(config.presetId ? { agentPreset: config.presetId } : {}) }
        body = Buffer.from(JSON.stringify(envelope))
      }
      const content = businessInboxContent(endpoint, envelope?.payload?.args)
      if (content) { await control.inspect(context, 'input', content, lifetime.signal, 'session:prompt'); control.assert(context, 'session:prompt', session ? [{ kind: 'session', id: session }] : []) }
      const request = new Request(`http://runtime${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: body?.toString('utf8'), signal: lifetime.signal })
      let response = await withBusinessContext(context, () => fetchHandler.fetch(request, admission.peer))
      if (endpoint === 'workspace/create') {
        const result = await response.clone().json() as { result?: { ok?: boolean; value?: { workspace?: { sessionIds?: string[] } } } }
        const workspace = result.result?.ok ? result.result.value?.workspace : undefined
        if (workspace?.sessionIds) { const owned = new Set(control.listSessions(base)); workspace.sessionIds = workspace.sessionIds.filter(id => owned.has(id)); const headers = new Headers(response.headers); headers.delete('content-length'); response = new Response(JSON.stringify(result), { status: response.status, headers }) }
      }
      if (endpoint === 'session/create' || endpoint === 'session/fork') {
        const result = await response.clone().json() as { result?: { ok?: boolean; value?: { sessionId?: string } } }
        if (result.result?.ok && result.result.value?.sessionId) { control.bindSession(base, result.result.value.sessionId); (ctx as any).remoteAccess.invalidate(admission.peer.principal) }
      }
      await sendFetch(res, response)
    } catch { if (!res.headersSent) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '业务请求被拒绝' })) } else res.destroy() }
    finally { await admission.peer.dispose() }
  } }), 'business Runtime: native API bridge')
}


interface PendingBusinessApproval {
  id: string; context: BusinessContext; operation: BusinessOperation; version: number; expiresAt: number
  reason: string
  finish(outcome: ApprovalOutcome): void
}
/** 原生ApprovalService负责等待和日志；业务答复入口仅裁决同一条未派发调用。 */
export function createBusinessApprovalAdapter(ctx: Context, control: BusinessControl) {
  const pending = new Map<string, PendingBusinessApproval>()
  const bindings = new WeakMap<object, { context: BusinessContext; operation: BusinessOperation }>()
  const liveAgents = new Map<string, ApprovalRequest['agent']>()
  ;(ctx as any).on('tools/pre-execute', (exec: { agent?: ApprovalRequest['agent'] }, next: () => Promise<unknown>) => {
    if (exec.agent) liveAgents.set(exec.agent.session.id, exec.agent)
    return next()
  })
  ;(ctx as any).on('approval/request', (request: object, next: () => Promise<ApprovalOutcome>) => {
    const saved = bindings.get(request)
    if (!saved) return next()
    const typed = request as ApprovalRequest
    if (typed.signal?.aborted) return Promise.resolve<ApprovalOutcome>('cancelled')
    return new Promise<ApprovalOutcome>(resolve => {
      const id = randomBytes(24).toString('base64url')
      const finish = (outcome: ApprovalOutcome) => { pending.delete(id); clearTimeout(timer); typed.signal?.removeEventListener('abort', cancel); resolve(outcome) }
      const cancel = () => finish('cancelled')
      const timer = setTimeout(() => finish('cancelled'), 120_000); timer.unref()
      pending.set(id, { id, context: structuredClone(saved.context), operation: structuredClone(saved.operation), reason: typed.reason ?? '此业务操作需要确认，请核对本次目标与参数', version: control.status().restrictionVersion, expiresAt: Date.now() + 120_000, finish })
      typed.signal?.addEventListener('abort', cancel, { once: true })
    })
  }, { prepend: true })
  control.setConfirmationHandler(async (context, operation, signal, reason) => {
    const agent = liveAgents.get(context.scope.sessionId || '')
    if (!agent || agent.session.id !== context.scope.sessionId) throw new Error('业务确认没有真实执行Agent')
    const request: ApprovalRequest = { agent, toolName: operation.operationId, reason: reason ?? '此业务操作需要确认，请在业务确认栏核对目标与参数。', signal }
    bindings.set(request, { context: structuredClone(context), operation: structuredClone(operation) })
    try {
      const outcome = await (ctx as any).approval.request(request)
      if (outcome !== 'allowed-once') throw new Error('业务操作未获确认')
    } finally { bindings.delete(request) }
  }, signal => (ctx.get('connection') as BusinessConnection).refreshLatest(signal))
  ctx.effect(() => () => { control.setConfirmationHandler(undefined); for (const request of pending.values()) request.finish('cancelled'); liveAgents.clear() }, 'business confirmations')
  const authorized = (context: BusinessContext, request: PendingBusinessApproval) => {
    try {
      const owned = control.sessionContext(context, request.context.scope.sessionId!)
      if (owned.subject.id !== request.context.subject.id || owned.subject.identitySource !== request.context.subject.identitySource) return false
      control.assert(owned, request.operation.kind, request.operation.resources, request.operation.args, request.operation); return true
    } catch { return false }
  }
  const send = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
  // 与原生UI共页；只使用自有受归属检查的接口，不能回答owner瀑布。
  ctx.on('webserver/index-inject', table => { table.push({ kind: 'script', placement: 'body', text: `(function(){const base=${JSON.stringify((ctx.get('businessRuntime') as any).basePath)};const panel=document.createElement('aside');panel.setAttribute('aria-label','业务操作确认');panel.style.cssText='position:fixed;bottom:16px;right:16px;max-width:420px;background:Canvas;color:CanvasText;padding:16px;border:1px solid #888;z-index:9999;display:none';document.body.append(panel);let busy=false;async function poll(){if(busy)return;busy=true;try{const r=await fetch(base+'api/business-control/confirmations');if(!r.ok)return;const list=await r.json();panel.replaceChildren();panel.style.display=list.items.length?'block':'none';for(const item of list.items){const title=document.createElement('p');title.textContent='确认操作：'+item.operationId;const reason=document.createElement('p');reason.textContent=item.reason||'请核对本次操作目标与参数';const detail=document.createElement('pre');detail.style.cssText='white-space:pre-wrap;max-height:240px;overflow:auto';detail.textContent=item.target+'\\n'+JSON.stringify(item.args,null,2);panel.append(title,reason,detail);for(const allow of [true,false]){const b=document.createElement('button');b.textContent=allow?'确认执行':'拒绝';b.onclick=async()=>{await fetch(base+'api/business-control/confirmations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:item.id,allow})});poll()};panel.append(b)}}}finally{busy=false}}setInterval(()=>poll().catch(()=>{}),750);poll().catch(()=>{})})();` }) })
  return {
    async handle(req: IncomingMessage, res: ServerResponse, context: BusinessContext): Promise<void> {
      control.assert(context, 'session:read')
      if (req.method === 'GET') return send(res, 200, { items: [...pending.values()].filter(item => authorized(context, item)).map(item => ({ id: item.id, sessionId: item.context.scope.sessionId, operationId: item.operation.operationId, reason: item.reason, target: item.operation.target, args: item.operation.args, expiresAt: new Date(item.expiresAt).toISOString() })) })
      if (req.method !== 'POST') return send(res, 405, { error: '操作不支持' })
      const body = JSON.parse((await readBody(req)).toString()) as { id?: string; allow?: boolean }
      const item = typeof body.id === 'string' ? pending.get(body.id) : undefined
      if (!item || typeof body.allow !== 'boolean' || !authorized(context, item)) return send(res, 403, { error: '业务确认不可用' })
      if (item.version !== control.status().restrictionVersion || item.expiresAt <= Date.now()) { item.finish('cancelled'); return send(res, 409, { error: '业务确认已失效' }) }
      item.finish(body.allow ? 'allowed-once' : 'rejected')
      send(res, 200, { accepted: true })
    },
  }
}
