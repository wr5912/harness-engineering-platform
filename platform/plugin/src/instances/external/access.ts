import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { HttpAuthenticationProvider, HttpIdentityTrustProvider } from '../../business-control/providers.ts'
import type { ProviderConfig } from '../../business-control/contracts.ts'
import { workspaceIdentity, workspaceLocalPath } from '../../workspace.ts'
import { adapterFetch, eventPath, invokeAdapter, readConversationSnapshot, redactExternalValue, snapshotExternalCredentials } from './adapters.ts'
import { conversationReply } from './conversation.ts'
import { appendExternalRecord, digest, ExternalAccessError, externalPolicy, getExternalInstance, isExternalEnabled, object, readExternalBusinessConfig, readExternalRecords, text } from './registry.ts'
import type { ExternalConversationResult, ExternalConversationSend, ExternalConversationStatus, ExternalInstance, ExternalInvocation, ExternalInvocationResult, ExternalOperation } from './types.ts'

export interface ExternalCaller { subjectId: string; source: string; expiresAt: string; kind?: 'human' | 'service' }
interface SessionBinding { id: string; instanceId: string; subjectId: string; nativeId: string; bindingDigest: string; createdAt: string }
interface InvocationReceipt { id: string; instanceId: string; subjectId: string; digest: string; state: 'dispatching' | 'accepted' | 'responded' | 'unknown'; sessionId?: string; upstreamSessionId?: string; bindingDigest?: string; conversationDigest?: string; messageId?: string }
interface AccessState { schemaVersion: 1; sessions: SessionBinding[]; requests: InvocationReceipt[] }
function statePath(root: string) { return workspaceLocalPath(root, 'external-instances', 'sessions.json') }
function readState(root: string): AccessState {
  const path = statePath(root), value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, sessions: [], requests: [] }
  if (value.schemaVersion !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.requests)) throw new ExternalAccessError('invalid_state', '接入会话记录格式无效', 503)
  return value
}
function updateState<T>(root: string, callback: (state: AccessState) => T): T {
  const path = statePath(root); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); let fd: number
  try { fd = openSync(path + '.lock', 'wx', 0o600) } catch { throw new ExternalAccessError('conflict', '接入会话正在更新，请查询原请求结果', 409) }
  const temporary = path + '.' + randomUUID() + '.tmp'
  try { const state = readState(root), result = callback(state); writeFileSync(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); return result }
  finally { closeSync(fd); rmSync(path + '.lock', { force: true }); rmSync(temporary, { force: true }) }
}
export async function authenticateExternal(root: string, req: IncomingMessage, signal: AbortSignal): Promise<ExternalCaller> {
  const config = readExternalBusinessConfig(root)
  if (!config.authentication || !config.identityTrust) throw new ExternalAccessError('authentication_unavailable', '接入实例需要已配置的调用者认证与身份核验提供方', 503)
  const authorization = req.headers.authorization
  const authenticated = await new HttpAuthenticationProvider(config.authentication).authenticate({ transport: 'http', method: req.method ?? 'GET', path: req.url ?? '/', headers: { authorization } }, signal)
  if (authenticated.kind !== 'authenticated') throw new ExternalAccessError(authenticated.kind, '调用者认证未通过', authenticated.kind === 'unavailable' ? 503 : 401)
  const trust = await new HttpIdentityTrustProvider(config.identityTrust).resolve(authenticated.evidence, signal)
  if (trust.kind !== 'trusted') throw new ExternalAccessError('identity_unavailable', '调用者身份核验未通过', trust.kind === 'unknown' ? 503 : 403)
  return { subjectId: trust.subject.id, source: trust.subject.identitySource, expiresAt: trust.expiresAt }
}
export function assertExternalAccess(root: string, id: string, caller: ExternalCaller, operation: string): { instance: ExternalInstance; policyDigest: string } {
  const instance = getExternalInstance(root, id)
  if (!instance || !isExternalEnabled(root, instance)) throw new ExternalAccessError('entry_disabled', '接入入口未启用、已停用或验证已失效', 403)
  const policy = externalPolicy(root, id)
  if (!(Date.parse(caller.expiresAt) > Date.now()) || !policy.subjects.includes(caller.subjectId) || !policy.actions.includes('agent:access') || !policy.actions.includes(operation)) throw new ExternalAccessError('forbidden', '当前主体未获该实例操作权限', 403)
  return { instance, policyDigest: digest(policy) }
}
async function postProvider(config: any, body: unknown, signal: AbortSignal): Promise<any> {
  const response = await fetch(config.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 1500)]) })
  if (!response.ok) throw new ExternalAccessError('provider_unavailable', '必要控制提供方暂不可用', 503)
  return response.json()
}
function externalRiskAssessment(config: Record<string, any>): ProviderConfig | undefined {
  if (config.externalAccess === undefined) return config.riskAssessment
  const external = config.externalAccess
  const invalid = (): never => { throw new ExternalAccessError('invalid_provider_config', '外部接入风险提供方配置无效，请核对 externalAccess.riskAssessment', 503) }
  if (!external || typeof external !== 'object' || Array.isArray(external) || Object.keys(external).some(key => key !== 'riskAssessment')) return invalid()
  if (!Object.hasOwn(external, 'riskAssessment')) return config.riskAssessment
  const provider = external.riskAssessment
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)
    || Object.keys(provider).some(key => !['endpoint', 'timeoutMs', 'testRunId'].includes(key))
    || typeof provider.endpoint !== 'string' || !provider.endpoint.trim() || provider.endpoint.length > 500) return invalid()
  let endpoint: URL
  try { endpoint = new URL(provider.endpoint) } catch { return invalid() }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || provider.timeoutMs !== undefined && (!Number.isSafeInteger(provider.timeoutMs) || provider.timeoutMs < 1 || provider.timeoutMs > 60000)
    || provider.testRunId !== undefined && (typeof provider.testRunId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(provider.testRunId))) return invalid()
  return provider
}
/** 外部绑定只携带登记证据；不冒充 DSH 源码摘要或运行代次。 */
export async function authorizeExternal(root: string, instance: ExternalInstance, caller: ExternalCaller, operation: string, input: unknown, requestId: string, signal: AbortSignal, resourceOperation?: Record<string, unknown>): Promise<() => void> {
  const config = readExternalBusinessConfig(root), scope = { workspaceId: workspaceIdentity(root).id, agentId: instance.agentId, instanceId: instance.id, subjectId: caller.subjectId }
  const riskAssessment = externalRiskAssessment(config)
  const providerDigest = (value: Record<string, any>) => digest([value.authentication, value.identityTrust, externalRiskAssessment(value), value.accessAuthorization])
  const binding = { kind: 'external-controlled', instanceId: instance.id, registrationRevision: instance.revision, bindingDigest: instance.bindingDigest }
  let validUntil = Date.parse(caller.expiresAt)
  let risk: unknown = { status: 'assessed', source: 'registration-and-current-policy', binding }
  if (riskAssessment) {
    try {
      const fact = await postProvider(riskAssessment, { subjectId: caller.subjectId, subject: { id: caller.subjectId, kind: caller.kind ?? 'human' }, scope, binding, operation: resourceOperation ?? operation, phase: operation === 'session:prompt' ? 'input' : 'execute', input, testRunId: riskAssessment.testRunId }, signal)
      if (!Number.isSafeInteger(fact.version) || !(Date.parse(fact.expiresAt) > Date.now()) || fact.scope?.subjectId !== caller.subjectId || Object.entries(scope).some(([key, value]) => fact.scope?.[key] !== undefined && fact.scope[key] !== value) || !['low', 'high', 'unknown'].includes(fact.level) || !Array.isArray(fact.constraints?.deniedOperations) || fact.constraints.deniedOperations.some((value: unknown) => typeof value !== 'string')) throw new ExternalAccessError('risk_unknown', '必要风险事实无效或已过期', 503)
      if (fact.level === 'unknown') throw new ExternalAccessError('risk_unknown', '必要风险事实不足', 503)
      if (fact.constraints.deniedOperations.some((value: string) => value === '*' || value === operation || value === 'agent:access')) throw new ExternalAccessError('risk_denied', '风险规则禁止本次操作', 403)
      risk = { status: 'assessed', level: fact.level, version: fact.version, expiresAt: fact.expiresAt }
      validUntil = Math.min(validUntil, Date.parse(fact.expiresAt))
    } catch (error) { if (error instanceof ExternalAccessError) throw error; throw new ExternalAccessError('risk_unavailable', '必要风险评估暂不可用', 503) }
  }
  if (config.accessAuthorization) {
    const op = resourceOperation ?? { serverId: 'external:' + instance.id, operationId: operation, kind: 'read', target: instance.endpoint, method: 'POST' }, decisionBinding = digest([binding, caller.subjectId, op, input])
    try {
      const decision = await postProvider(config.accessAuthorization, { protocolVersion: 1, requestId, binding: decisionBinding, subject: { id: caller.subjectId, kind: caller.kind ?? 'human', identitySource: caller.source }, scope, instanceBinding: binding, operation: op, input, risk }, signal)
      if (decision.protocolVersion !== 1 || decision.requestId !== requestId || decision.binding !== decisionBinding || !(Date.parse(decision.expiresAt) > Date.now()) || !['allow', 'deny', 'confirm'].includes(decision.decision)) throw new ExternalAccessError('authorization_unknown', '访问控制返回无效决定', 503)
      if (decision.decision !== 'allow') throw new ExternalAccessError('authorization_denied', '访问控制未允许本次操作', 403)
      validUntil = Math.min(validUntil, Date.parse(decision.expiresAt))
    } catch (error) { if (error instanceof ExternalAccessError) throw error; throw new ExternalAccessError('authorization_unavailable', '必要访问控制暂不可用', 503) }
  }
  const assertCurrent = () => {
    signal.throwIfAborted()
    if (providerDigest(readExternalBusinessConfig(root)) !== providerDigest(config)) throw new ExternalAccessError('configuration_changed', '控制提供方配置在本次判断期间变化，请重新发起', 409)
    if (!(validUntil > Date.now())) throw new ExternalAccessError('authorization_expired', '身份、风险或访问决定在派发前已过期', 403)
    const latest = getExternalInstance(root, instance.id)
    if (!latest || latest.state !== 'registered' || latest.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('configuration_changed', '接入绑定在本次判断期间变化，请重新发起', 409)
  }
  assertCurrent()
  return assertCurrent
}
/** 机器资源路径复用风险和第三方决定；入口停用不撤销独立资源授予。 */
export async function authorizeExternalOperation(root: string, request: { instanceId: string; subject?: { id: string; kind: 'service'; identitySource?: string }; operation: string | Record<string, unknown>; args?: unknown; resource?: unknown; tool?: string }, signal: AbortSignal): Promise<() => void> {
  const instance = getExternalInstance(root, request.instanceId)
  if (!instance || instance.state !== 'registered' || !instance.verification?.ok || instance.verification.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('instance_unverified', '机器请求的实例登记或目标验证无效', 403)
  if (request.subject && request.subject.kind !== 'service') throw new ExternalAccessError('invalid_machine_subject', '机器资源请求必须使用独立服务主体', 403)
  const caller: ExternalCaller = { subjectId: request.subject?.id ?? `instance:${instance.id}`, kind: 'service', source: request.subject?.identitySource ?? 'instance-client-credential', expiresAt: new Date(Date.now() + 60000).toISOString() }
  return authorizeExternal(root, instance, caller, typeof request.operation === 'string' ? request.operation : String(request.operation.operationId), request.args ?? null, randomUUID(), signal,
    typeof request.operation === 'object' ? request.operation : { serverId: request.resource, operationId: request.tool ?? request.operation, kind: 'read', target: request.resource, method: 'TOOLS/CALL' })
}
export function sessionBinding(root: string, instance: ExternalInstance, caller: ExternalCaller, id: string): SessionBinding {
  const session = readState(root).sessions.find(value => value.id === id && value.instanceId === instance.id && value.bindingDigest === instance.bindingDigest && value.subjectId === caller.subjectId)
  if (!session) throw new ExternalAccessError('session_forbidden', '会话不属于本次主体和接入绑定', 403)
  return session
}
export async function invokeExternal(root: string, caller: ExternalCaller, input: ExternalInvocation, signal: AbortSignal, conversationDigest?: string): Promise<ExternalInvocationResult> {
  const requestId = text(input.requestId, '请求标识')
  if (!['session:create', 'session:prompt', 'session:read'].includes(input.operation)) throw new ExternalAccessError('unsupported_operation', '请使用已开放的会话操作或事件订阅', 400)
  if (input.operation === 'session:prompt' && (typeof input.input !== 'string' || !input.input.trim() || input.input.length > 32000)) throw new ExternalAccessError('invalid_input', '请输入不超过 32000 字符的内容')
  let prepared: ReturnType<typeof assertExternalAccess>, session: SessionBinding | undefined
  try {
    prepared = assertExternalAccess(root, input.id, caller, input.operation)
    session = input.operation === 'session:create' ? undefined : sessionBinding(root, prepared.instance, caller, text(input.sessionId, '会话标识'))
  } catch (error) {
    try { appendExternalRecord(root, { instanceId: input.id, subjectId: caller.subjectId, requestId, operation: input.operation, stage: 'not_dispatched', result: 'deny', reason: error instanceof ExternalAccessError ? error.code : 'invalid_request' }) } catch { /* 拒绝结果不因此转为放行。 */ }
    throw error
  }
  const { instance, policyDigest } = prepared
  let dispatched = false, reserved = false
  try {
    const assertAuthorized = await authorizeExternal(root, instance, caller, input.operation, input.input ?? null, requestId, signal)
    const current = assertExternalAccess(root, input.id, caller, input.operation)
    if (current.instance.bindingDigest !== instance.bindingDigest || current.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '访问决定后配置已变化，请重新发起', 409)
    signal.throwIfAborted()
    const requestDigest = digest([input.id, caller.subjectId, input.operation, input.sessionId, input.input, ...(conversationDigest ? [conversationDigest] : [])]), mutation = input.operation !== 'session:read'
    if (mutation) {
      const previous = readState(root).requests.find(value => value.id === requestId)
      if (previous) {
        if (previous.digest !== requestDigest || previous.subjectId !== caller.subjectId) throw new ExternalAccessError('request_conflict', '请求标识已用于其他操作', 409)
        if (previous.bindingDigest && previous.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('configuration_changed', '原请求的接入绑定已变化，不能沿用旧回执', 409)
        if (previous.state === 'dispatching' || previous.state === 'unknown') return { requestId, stage: 'unknown', sessionId: previous.sessionId, note: '原请求已开始派发，结果仍待确认；不会重复执行。' }
        return { requestId, stage: previous.state, sessionId: previous.sessionId, upstreamSessionId: previous.upstreamSessionId, note: '返回原请求回执，未重复执行。' }
      }
    }
    appendExternalRecord(root, { instanceId: instance.id, subjectId: caller.subjectId, requestId, operation: input.operation, stage: 'dispatching', result: 'allow', bindingDigest: instance.bindingDigest, policyDigest, sessionId: session?.id })
    const messageId = conversationDigest && input.operation === 'session:prompt' && instance.framework !== 'dsh' ? `msg_${Date.now().toString(16)}001${randomUUID().replaceAll('-', '')}` : undefined
    if (mutation) updateState(root, state => {
      if (state.requests.some(value => value.id === requestId)) throw new ExternalAccessError('request_conflict', '请求已受理，请查询原结果', 409)
      state.requests.push({ id: requestId, instanceId: instance.id, subjectId: caller.subjectId, digest: requestDigest, state: 'dispatching', sessionId: session?.id,
        bindingDigest: instance.bindingDigest, ...(conversationDigest ? { conversationDigest } : {}), ...(messageId ? { messageId } : {}) })
      reserved = true
    })
    const beforeDispatch = () => {
      assertAuthorized()
      const final = assertExternalAccess(root, instance.id, caller, input.operation)
      if (final.instance.bindingDigest !== instance.bindingDigest || final.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '派发前配置已变化，本次未转发', 409)
      dispatched = true
    }
    const result = await invokeAdapter(root, instance, input, session?.nativeId, signal, { beforeDispatch, messageId })
    // 读取或响应解析同样可能让出执行权，失效绑定不能带出旧输出。
    assertAuthorized()
    const latest = assertExternalAccess(root, instance.id, caller, input.operation)
    if (latest.instance.bindingDigest !== instance.bindingDigest || latest.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '响应期间接入配置已变化，请重新读取', 409)
    result.sessionId = session?.id
    if (mutation) updateState(root, state => {
      if (input.operation === 'session:create') {
        result.sessionId = 'external-session-' + randomUUID()
        state.sessions.push({ id: result.sessionId, instanceId: instance.id, subjectId: caller.subjectId, nativeId: result.upstreamSessionId!, bindingDigest: instance.bindingDigest, createdAt: new Date().toISOString() })
      }
      const receipt = state.requests.find(value => value.id === requestId)
      if (receipt) Object.assign(receipt, { state: result.stage, sessionId: result.sessionId, upstreamSessionId: result.upstreamSessionId })
    })
    try { appendExternalRecord(root, { instanceId: instance.id, subjectId: caller.subjectId, requestId, operation: input.operation, stage: result.stage, result: 'allow', sessionId: result.sessionId, upstreamSessionId: result.upstreamSessionId, bindingDigest: instance.bindingDigest }) }
    catch { result.note = '上游已响应，但完成记录写入失败；请保留请求标识核对，不要重复提交。' }
    return result
  } catch (error) {
    if (dispatched) {
      try { updateState(root, state => { const receipt = state.requests.find(value => value.id === requestId); if (receipt) receipt.state = 'unknown' }) } catch { /* 保留派发中记录，禁止盲目重放。 */ }
      try { appendExternalRecord(root, { instanceId: instance.id, requestId, subjectId: caller.subjectId, operation: input.operation, stage: 'unknown', result: 'unknown', reason: error instanceof ExternalAccessError ? error.code : 'upstream_disconnected', bindingDigest: instance.bindingDigest }) } catch { /* 返回记录缺口，不能改成未执行。 */ }
      return { requestId, stage: 'unknown', sessionId: session?.id, note: '请求已向上游派发，但结果无法确认；请查询原生状态，不会自动重试。' }
    }
    if (reserved) try { updateState(root, state => { state.requests = state.requests.filter(value => value.id !== requestId) }) } catch { /* 无派发的失败仍由访问记录说明，不自动补发。 */ }
    try { appendExternalRecord(root, { instanceId: instance.id, requestId, subjectId: caller.subjectId, operation: input.operation, stage: 'not_dispatched', result: 'deny', reason: error instanceof ExternalAccessError ? error.code : 'dependency_failed' }) } catch { /* 不因日志错误放行。 */ }
    throw error
  }
}

/** 首次发送才创建会话；沿用现有 create/prompt 回执，不维护独立任务状态。 */
export async function sendExternalConversation(root: string, caller: ExternalCaller, input: ExternalConversationSend, signal: AbortSignal): Promise<ExternalConversationResult> {
  const requestId = text(input.requestId, '请求标识')
  let id: string, sessionId = input.sessionId
  const failed = (error: ExternalAccessError): ExternalConversationResult => ({ requestId, sessionId, status: 'failed', messages: [], tools: [], note: error.message })
  try {
    id = text(input.id, '实例标识')
    if (typeof input.input !== 'string' || !input.input.trim() || input.input.length > 32000) throw new ExternalAccessError('invalid_input', '请输入不超过 32000 字符的内容')
    if (sessionId !== undefined) text(sessionId, '会话标识')
  } catch (error) { if (error instanceof ExternalAccessError) return failed(error); throw error }
  // 已可能派发的请求只回读；读取失败不能重新解释为“消息未发送”。
  const readReply = async (): Promise<ExternalConversationResult> => {
    try { return await readExternalConversation(root, caller, { id, requestId }, signal) }
    catch (error) { return { requestId, sessionId, status: 'unknown', messages: [], tools: [],
      note: `消息回执已保留，但本次读取未完成；可继续读取，不会自动重发。${error instanceof ExternalAccessError ? error.message : ''}` } }
  }
  const conversationDigest = digest([id, caller.subjectId, input.sessionId, input.input])
  const existing = readState(root).requests.find(row => row.id === requestId)
  if (existing) {
    if (existing.instanceId !== id || existing.subjectId !== caller.subjectId || existing.conversationDigest !== conversationDigest) throw new ExternalAccessError('request_conflict', '请求标识已用于其他消息或会话', 409)
    sessionId = existing.sessionId
    return readReply()
  }
  try {
    const { instance } = assertExternalAccess(root, id, caller, 'session:prompt')
    assertExternalAccess(root, id, caller, 'session:read')
    if (sessionId) sessionBinding(root, instance, caller, sessionId)
  } catch (error) { if (error instanceof ExternalAccessError) return failed(error); throw error }
  if (!sessionId) {
    let created: ExternalInvocationResult
    try { created = await invokeExternal(root, caller, { id, requestId: requestId + ':create', operation: 'session:create' }, signal, conversationDigest) }
    catch (error) { if (error instanceof ExternalAccessError) return failed(error); throw error }
    if (created.stage === 'unknown' || !created.sessionId) return { requestId, status: 'unknown', messages: [], tools: [], note: '会话创建结果待确认；不会自动创建第二个会话，请保留请求标识继续核对。' }
    sessionId = created.sessionId
  }
  try {
    await invokeExternal(root, caller, { id, requestId, sessionId, operation: 'session:prompt', input: input.input }, signal, conversationDigest)
  } catch (error) {
    if (!(error instanceof ExternalAccessError)) throw error
    return failed(error)
  }
  return readReply()
}

export async function readExternalConversation(root: string, caller: ExternalCaller, input: ExternalConversationStatus, signal: AbortSignal): Promise<ExternalConversationResult> {
  const requestId = text(input.requestId, '请求标识'), { instance, policyDigest } = assertExternalAccess(root, text(input.id, '实例标识'), caller, 'session:read')
  const receipt = readState(root).requests.find(row => row.id === requestId) ?? readState(root).requests.find(row => row.id === requestId + ':create')
  if (!receipt || receipt.instanceId !== instance.id || receipt.subjectId !== caller.subjectId || !receipt.conversationDigest) throw new ExternalAccessError('request_not_found', '尚无本次消息的回执，请保留原请求标识核对；不会自动创建或重发', 404)
  if (receipt.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('configuration_changed', '本次消息的接入绑定已失效，不能读取旧结果', 409)
  const assertAuthorized = await authorizeExternal(root, instance, caller, 'session:read', null, requestId, signal)
  const current = () => {
    assertAuthorized()
    const latest = assertExternalAccess(root, instance.id, caller, 'session:read')
    if (latest.instance.bindingDigest !== instance.bindingDigest || latest.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '读取期间接入配置已变化，请重新读取', 409)
  }
  current()
  if (receipt.id !== requestId || !receipt.sessionId || !receipt.messageId && instance.framework !== 'dsh') {
    const rejected = receipt.id !== requestId && readExternalRecords(root, instance.id).some(row => row.requestId === requestId && row.stage === 'not_dispatched')
    return { requestId, sessionId: receipt.sessionId, status: rejected ? 'failed' : 'unknown', messages: [], tools: [],
      note: rejected ? '会话已保留，本次消息未派发；可在当前会话重新发送。' : '会话创建或消息发送尚无完整回执；可继续读取，当前不会自动补发。' }
  }
  const session = sessionBinding(root, instance, caller, receipt.sessionId)
  const messageId = receipt.messageId ?? requestId
  const snapshot = await readConversationSnapshot(root, instance, session.nativeId, requestId, messageId, signal, current)
  current()
  return { requestId, sessionId: session.id, ...conversationReply(instance.framework, requestId, messageId, snapshot, receipt.state === 'accepted' || receipt.state === 'responded') }
}
export async function streamExternal(root: string, caller: ExternalCaller, instanceId: string, sessionId: string, res: ServerResponse, signal: AbortSignal, reauthenticate?: () => Promise<ExternalCaller>): Promise<void> {
  const { instance, policyDigest } = assertExternalAccess(root, instanceId, caller, 'session:events'), session = sessionBinding(root, instance, caller, sessionId)
  const credentials = snapshotExternalCredentials(root, instance)
  const requestId = randomUUID(), assertAuthorized = await authorizeExternal(root, instance, caller, 'session:events', null, requestId, signal)
  const lifetime = new AbortController(), combined = AbortSignal.any([signal, lifetime.signal])
  let dispatched = false
  let lastAuthentication = Date.now(), validating = false
  const interval = setInterval(() => {
    if (validating) return
    validating = true
    void (async () => {
      const latest = assertExternalAccess(root, instanceId, caller, 'session:events')
      if (latest.instance.bindingDigest !== instance.bindingDigest || latest.policyDigest !== policyDigest) throw new ExternalAccessError('revoked', '入口或权限已变化')
      if (reauthenticate && Date.now() - lastAuthentication >= 5000) { const renewed = await reauthenticate(); if (renewed.subjectId !== caller.subjectId) throw new ExternalAccessError('revoked', '调用者身份已变化'); caller = renewed; lastAuthentication = Date.now() }
    })().catch(() => { lifetime.abort(); if (!res.writableEnded) res.end() }).finally(() => { validating = false })
  }, 250)
  interval.unref()
  try {
    const current = assertExternalAccess(root, instanceId, caller, 'session:events')
    if (current.instance.bindingDigest !== instance.bindingDigest || current.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '订阅决定后绑定或策略已变化，本次未转发', 409)
    combined.throwIfAborted()
    appendExternalRecord(root, { instanceId, subjectId: caller.subjectId, requestId, operation: 'session:events', stage: 'dispatching', result: 'allow', sessionId })
    const final = assertExternalAccess(root, instanceId, caller, 'session:events')
    if (final.instance.bindingDigest !== instance.bindingDigest || final.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '订阅派发前绑定或策略已变化，本次未转发', 409)
    const response = await adapterFetch(root, instance, eventPath(instance, session.nativeId), { method: 'GET' }, combined, credentials, () => {
      combined.throwIfAborted(); assertAuthorized(); dispatched = true
    })
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new ExternalAccessError('upstream_error', '上游未提供可用 Session 事件流', 502)
    const opened = assertExternalAccess(root, instanceId, caller, 'session:events')
    if (opened.instance.bindingDigest !== instance.bindingDigest || opened.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '订阅建立时绑定或策略已变化', 409)
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = ''
    while (!combined.aborted) {
      const next = await reader.read(); if (next.done) break
      buffer = (buffer + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n'); if (buffer.length > 1024 * 1024) throw new Error('event_too_large')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const lines = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!lines) continue
        let event: any
        try { event = JSON.parse(lines) } catch { continue }
        // v2 Session event 的权威归属为 data.sessionID；任意 metadata 中的同名字段不授予访问。
        if (instance.framework === 'opencode' && event?.data?.sessionID !== session.nativeId) continue
        assertExternalAccess(root, instanceId, caller, 'session:events'); res.write(`data: ${JSON.stringify(redactExternalValue(event, credentials))}\n\n`)
      }
    }
  } finally {
    clearInterval(interval); lifetime.abort(); if (res.headersSent && !res.writableEnded) res.end()
    try { appendExternalRecord(root, { instanceId, subjectId: caller.subjectId, requestId, operation: 'session:events', stage: dispatched ? 'connection_closed' : 'not_dispatched', result: dispatched ? 'unknown' : 'deny', sessionId, reason: dispatched ? 'connection_closed_task_state_independent' : 'subscription_not_dispatched' }) } catch { /* 连接关闭不证明后台任务停止。 */ }
  }
}
