import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import { HttpAuthenticationProvider, HttpIdentityTrustProvider } from '../../business-control/providers.ts'
import { workspaceIdentity, workspaceLocalPath } from '../../workspace.ts'
import { adapterFetch, eventPath, invokeAdapter, redactExternalValue, snapshotExternalCredentials } from './adapters.ts'
import { appendExternalRecord, digest, ExternalAccessError, externalPolicy, getExternalInstance, isExternalEnabled, object, readExternalBusinessConfig, text } from './registry.ts'
import type { ExternalInstance, ExternalInvocation, ExternalInvocationResult, ExternalOperation } from './types.ts'

export interface ExternalCaller { subjectId: string; source: string; expiresAt: string; kind?: 'human' | 'service' }
interface SessionBinding { id: string; instanceId: string; subjectId: string; nativeId: string; bindingDigest: string; createdAt: string }
interface InvocationReceipt { id: string; instanceId: string; subjectId: string; digest: string; state: 'dispatching' | 'accepted' | 'responded' | 'unknown'; sessionId?: string; upstreamSessionId?: string }
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
/** 外部绑定只携带登记证据；不冒充 DSH 源码摘要或运行代次。 */
export async function authorizeExternal(root: string, instance: ExternalInstance, caller: ExternalCaller, operation: string, input: unknown, requestId: string, signal: AbortSignal, resourceOperation?: Record<string, unknown>): Promise<void> {
  const config = readExternalBusinessConfig(root), scope = { workspaceId: workspaceIdentity(root).id, agentId: instance.agentId, instanceId: instance.id, subjectId: caller.subjectId }
  const providerDigest = (value: Record<string, any>) => digest([value.authentication, value.identityTrust, value.riskAssessment, value.accessAuthorization])
  const binding = { kind: 'external-controlled', instanceId: instance.id, registrationRevision: instance.revision, bindingDigest: instance.bindingDigest }
  let validUntil = Date.parse(caller.expiresAt)
  let risk: unknown = { status: 'assessed', source: 'registration-and-current-policy', binding }
  if (config.riskAssessment) {
    try {
      const fact = await postProvider(config.riskAssessment, { subjectId: caller.subjectId, subject: { id: caller.subjectId, kind: caller.kind ?? 'human' }, scope, binding, operation: resourceOperation ?? operation, phase: operation === 'session:prompt' ? 'input' : 'execute', input, testRunId: config.riskAssessment.testRunId }, signal)
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
  if (providerDigest(readExternalBusinessConfig(root)) !== providerDigest(config)) throw new ExternalAccessError('configuration_changed', '控制提供方配置在本次判断期间变化，请重新发起', 409)
  if (!(validUntil > Date.now())) throw new ExternalAccessError('authorization_expired', '身份、风险或访问决定在派发前已过期', 403)
  const latest = getExternalInstance(root, instance.id)
  if (!latest || latest.state !== 'registered' || latest.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('configuration_changed', '接入绑定在本次判断期间变化，请重新发起', 409)
}
/** 机器资源路径复用风险和第三方决定；入口停用不撤销独立资源授予。 */
export async function authorizeExternalOperation(root: string, request: { instanceId: string; subject?: { id: string; kind: 'service'; identitySource?: string }; operation: string | Record<string, unknown>; args?: unknown; resource?: unknown; tool?: string }, signal: AbortSignal): Promise<void> {
  const instance = getExternalInstance(root, request.instanceId)
  if (!instance || instance.state !== 'registered' || !instance.verification?.ok || instance.verification.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('instance_unverified', '机器请求的实例登记或目标验证无效', 403)
  if (request.subject && request.subject.kind !== 'service') throw new ExternalAccessError('invalid_machine_subject', '机器资源请求必须使用独立服务主体', 403)
  const caller: ExternalCaller = { subjectId: request.subject?.id ?? `instance:${instance.id}`, kind: 'service', source: request.subject?.identitySource ?? 'instance-client-credential', expiresAt: new Date(Date.now() + 60000).toISOString() }
  await authorizeExternal(root, instance, caller, typeof request.operation === 'string' ? request.operation : String(request.operation.operationId), request.args ?? null, randomUUID(), signal,
    typeof request.operation === 'object' ? request.operation : { serverId: request.resource, operationId: request.tool ?? request.operation, kind: 'read', target: request.resource, method: 'TOOLS/CALL' })
}
export function sessionBinding(root: string, instance: ExternalInstance, caller: ExternalCaller, id: string): SessionBinding {
  const session = readState(root).sessions.find(value => value.id === id && value.instanceId === instance.id && value.bindingDigest === instance.bindingDigest && value.subjectId === caller.subjectId)
  if (!session) throw new ExternalAccessError('session_forbidden', '会话不属于本次主体和接入绑定', 403)
  return session
}
export async function invokeExternal(root: string, caller: ExternalCaller, input: ExternalInvocation, signal: AbortSignal): Promise<ExternalInvocationResult> {
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
  let dispatched = false
  try {
    await authorizeExternal(root, instance, caller, input.operation, input.input ?? null, requestId, signal)
    const current = assertExternalAccess(root, input.id, caller, input.operation)
    if (current.instance.bindingDigest !== instance.bindingDigest || current.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '访问决定后配置已变化，请重新发起', 409)
    signal.throwIfAborted()
    const requestDigest = digest([input.id, caller.subjectId, input.operation, input.sessionId, input.input]), mutation = input.operation !== 'session:read'
    if (mutation) {
      const previous = readState(root).requests.find(value => value.id === requestId)
      if (previous) {
        if (previous.digest !== requestDigest || previous.subjectId !== caller.subjectId) throw new ExternalAccessError('request_conflict', '请求标识已用于其他操作', 409)
        if (previous.state === 'dispatching' || previous.state === 'unknown') return { requestId, stage: 'unknown', sessionId: previous.sessionId, note: '原请求已开始派发，结果仍待确认；不会重复执行。' }
        return { requestId, stage: previous.state, sessionId: previous.sessionId, upstreamSessionId: previous.upstreamSessionId, note: '返回原请求回执，未重复执行。' }
      }
    }
    appendExternalRecord(root, { instanceId: instance.id, subjectId: caller.subjectId, requestId, operation: input.operation, stage: 'dispatching', result: 'allow', bindingDigest: instance.bindingDigest, policyDigest, sessionId: session?.id })
    if (mutation) updateState(root, state => {
      if (state.requests.some(value => value.id === requestId)) throw new ExternalAccessError('request_conflict', '请求已受理，请查询原结果', 409)
      state.requests.push({ id: requestId, instanceId: instance.id, subjectId: caller.subjectId, digest: requestDigest, state: 'dispatching', sessionId: session?.id })
    })
    const final = assertExternalAccess(root, instance.id, caller, input.operation)
    if (final.instance.bindingDigest !== instance.bindingDigest || final.policyDigest !== policyDigest) throw new ExternalAccessError('configuration_changed', '派发前配置已变化，本次未转发', 409)
    dispatched = true
    const result = await invokeAdapter(root, instance, input, session?.nativeId, signal)
    result.sessionId = session?.id
    updateState(root, state => {
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
    try { appendExternalRecord(root, { instanceId: instance.id, requestId, subjectId: caller.subjectId, operation: input.operation, stage: 'not_dispatched', result: 'deny', reason: error instanceof ExternalAccessError ? error.code : 'dependency_failed' }) } catch { /* 不因日志错误放行。 */ }
    throw error
  }
}
export async function streamExternal(root: string, caller: ExternalCaller, instanceId: string, sessionId: string, res: ServerResponse, signal: AbortSignal, reauthenticate?: () => Promise<ExternalCaller>): Promise<void> {
  const { instance, policyDigest } = assertExternalAccess(root, instanceId, caller, 'session:events'), session = sessionBinding(root, instance, caller, sessionId)
  const credentials = snapshotExternalCredentials(root, instance)
  const requestId = randomUUID(); await authorizeExternal(root, instance, caller, 'session:events', null, requestId, signal)
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
    dispatched = true
    const response = await adapterFetch(root, instance, eventPath(instance, session.nativeId), { method: 'GET' }, combined, credentials)
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
