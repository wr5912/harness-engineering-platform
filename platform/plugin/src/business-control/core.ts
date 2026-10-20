import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
  AccessDecision, AccessRequest, AgentAuthenticationEvidence, AgentInstanceStatus, AuthenticatedIdentity, AuthenticationInput, BusinessAccessConfig, BusinessContext,
  BusinessOperation, ControlEvent, ControlScope, ControlSnapshot, InstanceBinding, OperationKind,
  ReplicaObservation, ResourceRef, Restriction, RiskFact, SessionBinding, SessionTrustFact,
} from './contracts.js'
import { HttpAuthenticationProvider, HttpIdentityTrustProvider, HttpRiskAssessmentProvider } from './providers.js'

export * from './contracts.js'

export class BusinessControlError extends Error {
  constructor(public code: string, message: string, public httpStatus = 403) { super(message); this.name = 'BusinessControlError' }
}
interface StoredResource { subjectId: string; sessionId: string }
interface State {
  schemaVersion: 1; restrictionVersion: number; instances: Record<string, InstanceBinding>
  sessions: Record<string, SessionBinding>; resources: Record<string, StoredResource>
  riskFacts: Record<string, RiskFact>; localRiskFacts: Record<string, RiskFact>; restrictions: Record<string, Restriction>; events: ControlEvent[]
}
interface Confirmation { id: string; subjectId: string; binding: string; version: number; expiresAt: number; confirmed: boolean }
interface Shared {
  contexts: AsyncLocalStorage<BusinessContext>; services: Map<string, BusinessControl>; managers: WeakSet<BusinessContext>
  signedRuntimeSessions: AsyncLocalStorage<boolean>
  stateRoots: Map<string, string>
}
const symbol = Symbol.for('harness.platform.business-control.v1')
const globals = globalThis as typeof globalThis & { [symbol]?: Shared }
// 各 esbuild 制品共用同一个 ALS；否则 MCP 独立 bundle 会遗失受信上下文。
const shared = globals[symbol] ??= { contexts: new AsyncLocalStorage<BusinessContext>(), services: new Map(), managers: new WeakSet(),
  signedRuntimeSessions: new AsyncLocalStorage<boolean>(), stateRoots: new Map() }
shared.signedRuntimeSessions ??= new AsyncLocalStorage<boolean>()
export function currentBusinessContext(): BusinessContext | undefined { return shared.contexts.getStore() }
export function withBusinessContext<T>(context: BusinessContext, fn: () => T): T { return shared.contexts.run(context, fn) }
/** 仅在平台核验 Runtime 的逐请求签名后使用；Session 事实仍由业务 Runtime 持有。 */
export function withSignedRuntimeSession<T>(fn: () => T): T { return shared.signedRuntimeSessions.run(true, fn) }
export function getBusinessControl(assetRoot: string, stateRoot?: string): BusinessControl {
  const root = resolve(assetRoot), selectedStateRoot = stateRoot ?? shared.stateRoots.get(root)
  const key = JSON.stringify([root, resolve(selectedStateRoot ?? join(root, '.local', 'business-control'))])
  let value = shared.services.get(key)
  if (!value) { value = new BusinessControl(root, selectedStateRoot); shared.services.set(key, value) }
  return value
}
/** 在 Runtime 其他 bundle 取服务前固定独立状态目录；不允许同根产生第二个执行器。 */
export function configureBusinessControlStateRoot(assetRoot: string, stateRoot: string): BusinessControl {
  const root = resolve(assetRoot), selected = resolve(stateRoot)
  if ([...shared.services.keys()].some(key => { const [existingRoot, existingState] = JSON.parse(key); return existingRoot === root && existingState !== selected })) {
    return error('control_state_root_conflict', 503)
  }
  const previous = shared.stateRoots.get(root)
  if (previous && previous !== selected) return error('control_state_root_conflict', 503)
  shared.stateRoots.set(root, selected)
  return getBusinessControl(root)
}
const noSignal = () => new AbortController().signal
const iso = () => new Date().toISOString()
const error = (code: string, status = 403): never => { throw new BusinessControlError(code, '当前请求未获业务许可', status) }
const matches = (scope: ControlScope, context: BusinessContext, serverId?: string): boolean =>
  Object.entries(scope).every(([key, value]) => value === undefined
    || (key === 'subjectId' ? context.subject.id : key === 'serverId' ? serverId : context.scope[key as keyof ControlScope]) === value)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const future = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()
const kinds: OperationKind[] = ['read', 'write', 'resource', 'publish']
const maximumReportBytes = 1024 * 1024
/** 只解析报告工具明确声明的正文，不将普通字符串猜测为 Base64。 */
function reportInspectionInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const value = input as { fileContentBase64?: unknown; body?: { fileContentBase64?: unknown } }
  const candidates = [value, value.body].filter((entry): entry is { fileContentBase64: unknown } =>
    !!entry && typeof entry === 'object' && Object.hasOwn(entry, 'fileContentBase64'))
  if (!candidates.length) return input
  const encoded = candidates[0]!.fileContentBase64
  if (candidates.length !== 1 || typeof encoded !== 'string' || !encoded.length
    || encoded.length > Math.ceil(maximumReportBytes / 3) * 4 || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return error('report_content_invalid')
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength > maximumReportBytes || decoded.toString('base64') !== encoded) return error('report_content_invalid')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(decoded) }
  catch { return error('report_content_invalid') }
}

/** 仅允许注册路径中的整段参数及明确登记的查询键；来源与路径边界始终精确。 */
export function matchesOperationTarget(registered: string, actual: string, queryParameters: readonly string[] = []): boolean {
  let expected: URL, received: URL
  try { expected = new URL(registered); received = new URL(actual) } catch { return registered === actual }
  if (!['http:', 'https:'].includes(expected.protocol)) return registered === actual
  if (expected.origin !== received.origin || received.username || received.password || received.hash) return false
  try {
    const expectedParts = expected.pathname.split('/').map(decodeURIComponent), actualParts = received.pathname.split('/').map(decodeURIComponent)
    if (expectedParts.length !== actualParts.length || expectedParts.some((part, index) => {
      const value = actualParts[index]!
      return /^\{[a-zA-Z0-9_-]+\}$/.test(part) ? !value || value.includes('/') || value === '.' || value === '..' : part !== value
    })) return false
    const allowed = new Set([...queryParameters, ...expected.searchParams.keys()])
    for (const name of received.searchParams.keys()) if (!allowed.has(name)) return false
    for (const [name, value] of expected.searchParams) {
      const values = received.searchParams.getAll(name)
      if (values.length !== 1 || (!/^\{[a-zA-Z0-9_-]+\}$/.test(value) && values[0] !== value)) return false
    }
    return true
  } catch { return false }
}

export class BusinessControl {
  private state: State
  private path: string
  private leases = new Map<string, { snapshot: ControlSnapshot; receivedAt: number }>()
  private requiredSnapshots = new Set<string>()
  private issued = new Map<string, ControlSnapshot>()
  private acknowledgements = new Map<string, { restrictionVersion: number; leaseId: string; at: string }>()
  private active = new Map<string, { context: BusinessContext; operation: BusinessOperation; controller: AbortController }>()
  private confirmations = new Map<string, Confirmation>()
  private agentAuthentications = new Map<string, { evidence: AgentAuthenticationEvidence; receivedAt: number }>()
  private confirmationHandler?: (context: BusinessContext, operation: BusinessOperation, signal: AbortSignal) => Promise<void>
  private confirmationSynchronizer?: (signal: AbortSignal) => Promise<void>
  private available = true

  constructor(readonly assetRoot: string, stateRoot?: string) {
    this.path = join(stateRoot ?? join(assetRoot, '.local', 'business-control'), 'state.json')
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {
      schemaVersion: 1, restrictionVersion: 0, instances: {}, sessions: {}, resources: {}, riskFacts: {}, localRiskFacts: {}, restrictions: {}, events: [],
    }
    if (this.state.schemaVersion !== 1 || !Number.isSafeInteger(this.state.restrictionVersion)
      || this.state.restrictionVersion < 0 || !this.state.sessions || !this.state.instances
      || !this.state.resources || !this.state.riskFacts || !this.state.restrictions || !Array.isArray(this.state.events)) {
      throw new BusinessControlError('control_state_invalid', '业务控制状态无效', 503)
    }
    this.state.localRiskFacts ??= {}
  }
  config(): BusinessAccessConfig {
    const path = join(this.assetRoot, 'config', 'business-access.json')
    if (!existsSync(path)) return { schemaVersion: 1, enabled: false, agents: [] }
    let value: BusinessAccessConfig
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { return error('control_config_invalid', 503) }
    if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.agents)
      || value.agents.some(rule => !rule.agentId || typeof rule.enabled !== 'boolean' || !Array.isArray(rule.subjects) || !Array.isArray(rule.actions)
        || (rule.agentAuthentication !== undefined && (!rule.agentAuthentication || rule.agentAuthentication.method !== 'hmac-sha256' || typeof rule.agentAuthentication.enabled !== 'boolean'))
        || (rule.agentTrust !== undefined && (!rule.agentTrust || typeof rule.agentTrust.enabled !== 'boolean')))
      || (value.operations && (!Array.isArray(value.operations) || value.operations.some(rule =>
        !rule.serverId || !rule.operationId || !kinds.includes(rule.kind) || !rule.target || !rule.method)))) {
      return error('control_config_invalid', 503)
    }
    return value
  }
  enabled(): boolean { return this.config().enabled }
  stateDirectory(): string { return dirname(this.path) }
  /** 仅由已完成 HMAC、接收实例、路径和重放校验的控制通道调用。 */
  recordAgentAuthentication(binding: InstanceBinding): void {
    const registered = this.state.instances[binding.instanceId]
    if (!registered || Object.entries(binding).some(([key, value]) => registered[key as keyof InstanceBinding] !== value)) return error('agent_authentication_binding_invalid')
    this.agentAuthentications.set(binding.instanceId, { receivedAt: performance.now(), evidence: {
      method: 'hmac-sha256', binding: { ...binding }, verifiedAt: iso(), expiresAt: new Date(Date.now() + 2000).toISOString(), source: 'signed-control-assertion',
    } })
  }
  agentStatus(instanceId: string): AgentInstanceStatus {
    const binding = this.state.instances[instanceId], config = this.config()
    const rule = config.agents.find(rule => rule.agentId === binding?.agentId)
    const result: AgentInstanceStatus = { instanceId, agentId: binding?.agentId,
      authentication: { method: 'hmac-sha256', status: 'unknown' },
      trust: { status: 'unknown', reason: 'agent_authentication_unknown', sourceDigest: binding?.sourceDigest,
        runtimeGeneration: binding?.runtimeGeneration, restrictionVersion: this.state.restrictionVersion } }
    if (!binding) { result.trust.reason = 'instance_unregistered'; return result }
    const replica = this.requiredSnapshots.has(instanceId), lease = this.leases.get(instanceId)
    if (replica && lease?.snapshot.agentStatus) {
      result.authentication = { ...lease.snapshot.agentStatus.authentication }
      result.trust = { ...lease.snapshot.agentStatus.trust, restrictionVersion: this.state.restrictionVersion }
      if (performance.now() - lease.receivedAt >= Math.min(2000, lease.snapshot.leaseMs)) {
        result.authentication.status = 'expired'; result.trust.status = 'expired'; result.trust.reason = 'agent_channel_expired'
      }
    } else if (!replica) {
      const authenticated = this.agentAuthentications.get(instanceId)
      if (authenticated) {
        const fresh = performance.now() - authenticated.receivedAt < 2000
        result.authentication = { method: 'hmac-sha256', status: fresh ? 'verified' : 'expired',
          verifiedAt: authenticated.evidence.verifiedAt, expiresAt: authenticated.evidence.expiresAt, evidence: authenticated.evidence.source }
        const ack = this.acknowledgements.get(instanceId)
        // 身份与来源信任不随风险版本变化；当前策略应用仍由 checkLease/applied 独立核对。
        if (fresh && ack && Date.now() - Date.parse(ack.at) < 2000) result.trust = { ...result.trust, status: 'trusted', reason: 'authenticated-pinned-channel' }
        else { result.trust.status = fresh ? 'unknown' : 'expired'; result.trust.reason = fresh ? 'agent_channel_unconfirmed' : 'agent_authentication_expired' }
      }
    }
    if (rule?.agentAuthentication?.enabled === false) {
      result.authentication.status = 'disabled'; result.trust.status = 'revoked'; result.trust.reason = 'agent_authentication_disabled'
    } else if (!config.enabled || !rule?.enabled || rule.agentTrust?.enabled === false) {
      result.trust.status = 'revoked'; result.trust.reason = !config.enabled ? 'business_disabled' : !rule?.enabled ? 'agent_closed' : 'agent_trust_revoked'
    } else if (!rule.sourceDigest) { result.trust.status = 'unknown'; result.trust.reason = 'agent_source_unpinned' }
    else if (binding.sourceDigest !== rule.sourceDigest) { result.trust.status = 'mismatch'; result.trust.reason = 'agent_source_mismatch' }
    return result
  }
  agentStatuses(): AgentInstanceStatus[] { return Object.keys(this.state.instances).map(id => this.agentStatus(id)) }
  sessionTrustFacts(): SessionTrustFact[] {
    return Object.values(this.state.sessions).map(session => ({ sessionId: session.sessionId, subjectId: session.subjectId,
      agentId: session.agentId, instanceId: session.instanceId, identitySource: session.subject.identitySource,
      verifiedAt: session.identity?.evidence.verifiedAt, expiresAt: session.identity?.expiresAt,
      credentialExpiresAt: session.identity?.evidence.expiresAt, observedAt: session.observedAt ?? session.createdAt,
      state: session.identity && future(session.identity.expiresAt) && future(session.identity.evidence.expiresAt) ? 'evidence-held' : 'expired' }))
  }
  exportReplicaState(binding: InstanceBinding): ReplicaObservation {
    if (digest(this.state.instances[binding.instanceId]) !== digest(binding) || !this.requiredSnapshots.has(binding.instanceId)) return error('replica_binding_invalid')
    const sessions = Object.values(this.state.sessions).filter(session => Object.entries(binding).every(([key, value]) => session[key as keyof InstanceBinding] === value))
    const ids = new Set(sessions.map(session => session.sessionId))
    const facts = Object.values(this.state.localRiskFacts).filter(fact => fact.scope.workspaceId === binding.workspaceId
      && fact.scope.agentId === binding.agentId && fact.scope.instanceId === binding.instanceId
      && fact.scope.runtimeGeneration === binding.runtimeGeneration && (!fact.scope.sessionId || ids.has(fact.scope.sessionId)))
    return structuredClone({ binding, sessions, riskFacts: facts, events: this.state.events.filter(event => !!event.sessionId && ids.has(event.sessionId)).slice(-50) })
  }
  importReplicaState(binding: InstanceBinding, observation: ReplicaObservation): void {
    if (this.requiredSnapshots.size || digest(this.state.instances[binding.instanceId]) !== digest(binding)
      || !observation || digest(observation.binding) !== digest(binding) || !Array.isArray(observation.sessions)
      || !Array.isArray(observation.riskFacts) || !Array.isArray(observation.events)
      || observation.sessions.length > 10000 || observation.riskFacts.length > 5000 || observation.events.length > 1000) return error('replica_observation_invalid')
    const subjects = new Set<string>(), sessions = new Map<string, SessionBinding>()
    for (const session of observation.sessions) {
      if (!session.sessionId || ['__proto__', 'constructor', 'prototype'].includes(session.sessionId)
        || Object.entries(binding).some(([key, value]) => session[key as keyof InstanceBinding] !== value)
        || session.subject?.kind !== 'human' || session.subjectId !== session.subject.id || !session.subject.identitySource
        || !session.identity || session.identity.evidence.externalSubject !== session.subjectId
        || session.identity.evidence.issuer !== session.subject.identitySource) return error('replica_session_invalid')
      const previous = this.state.sessions[session.sessionId]
      if (previous && (Object.entries(binding).some(([key, value]) => previous[key as keyof InstanceBinding] !== value)
        || previous.subjectId !== session.subjectId || previous.subject.identitySource !== session.subject.identitySource)) return error('replica_session_conflict')
      subjects.add(session.subjectId); sessions.set(session.sessionId, session)
    }
    for (const fact of observation.riskFacts) {
      if (!this.validRiskFact(fact) || fact.scope.workspaceId !== binding.workspaceId || fact.scope.agentId !== binding.agentId
        || fact.scope.instanceId !== binding.instanceId || fact.scope.runtimeGeneration !== binding.runtimeGeneration
        || !fact.scope.subjectId || !subjects.has(fact.scope.subjectId)
        || (fact.scope.sessionId && sessions.get(fact.scope.sessionId)?.subjectId !== fact.scope.subjectId)) return error('replica_risk_scope_invalid')
      const previous = this.state.riskFacts[fact.id]
      if (previous && previous.version === fact.version && this.riskMeaning(previous) !== this.riskMeaning(fact)) return error('risk_fact_version_conflict')
    }
    for (const event of observation.events) {
      if (!event.id || !event.sessionId || !sessions.has(event.sessionId) || event.subjectId !== sessions.get(event.sessionId)!.subjectId
        || !['allowed', 'denied', 'completed', 'cancelled', 'unknown', 'applied'].includes(event.outcome)
        || !Number.isSafeInteger(event.restrictionVersion)) return error('replica_event_invalid')
    }
    // 全部对象先校验，再写观察索引；重复上报不改已有归属或推进同一事实版本。
    for (const session of sessions.values()) {
      const previous = this.state.sessions[session.sessionId]
      const saved = structuredClone(session)
      if (previous?.identity && Date.parse(previous.identity.evidence.verifiedAt) > Date.parse(saved.identity!.evidence.verifiedAt)) saved.identity = structuredClone(previous.identity)
      saved.observedAt = iso()
      this.state.sessions[session.sessionId] = saved
    }
    for (const fact of observation.riskFacts) this.updateRisk(fact)
    const eventIds = new Set(this.state.events.map(event => event.id))
    this.state.events.push(...structuredClone(observation.events.filter(event => !eventIds.has(event.id))))
    this.state.events = this.state.events.slice(-1000)
    this.persist()
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, this.path)
  }
  private record(action: string, outcome: ControlEvent['outcome'], context?: BusinessContext, operationId?: string, reason?: string): void {
    this.state.events.push({ id: randomUUID(), at: iso(), requestId: context?.requestId,
      subjectId: context?.subject.id, sessionId: context?.scope.sessionId, operationId, action,
      restrictionVersion: this.state.restrictionVersion, outcome, reason })
    this.state.events = this.state.events.slice(-1000)
    this.persist()
  }
  managementContext(): BusinessContext {
    const value: BusinessContext = { requestId: randomUUID(), subject: { id: 'platform-management', kind: 'service', identitySource: 'platform' },
      scope: { workspaceId: this.assetRoot, agentId: 'platform-management' }, sourceDigest: 'platform-management' }
    shared.managers.add(value)
    return value
  }
  isManagement(context?: BusinessContext): boolean { return !!context && shared.managers.has(context) }
  async authenticate(input: AuthenticationInput, signal = noSignal()): Promise<AuthenticatedIdentity> {
    const config = this.config()
    if (!config.enabled || !config.authentication || !config.identityTrust) return error('authentication_unavailable', 503)
    const authenticated = await new HttpAuthenticationProvider(config.authentication).authenticate(input, signal)
    if (authenticated.kind !== 'authenticated') return error(authenticated.reason, authenticated.kind === 'unavailable' ? 503 : 401)
    const trust = await new HttpIdentityTrustProvider(config.identityTrust).resolve(authenticated.evidence, signal)
    if (trust.kind !== 'trusted') return error(trust.reason, trust.kind === 'unknown' ? 503 : 401)
    return { subject: trust.subject, evidence: authenticated.evidence, expiresAt: trust.expiresAt }
  }
  registerInstance(binding: InstanceBinding): void {
    if (Object.values(binding).some(value => typeof value !== 'string' || !value)) return error('instance_binding_invalid')
    const old = this.state.instances[binding.instanceId]
    if (JSON.stringify(old) === JSON.stringify(binding)) return
    this.state.instances[binding.instanceId] = { ...binding }
    this.agentAuthentications.delete(binding.instanceId); this.acknowledgements.delete(binding.instanceId)
    this.persist()
  }
  registeredInstance(instanceId: string): InstanceBinding | undefined {
    const value = this.state.instances[instanceId]
    return value && { ...value }
  }
  createContext(identity: AuthenticatedIdentity, binding: InstanceBinding & { sessionId?: string; requestId?: string }): BusinessContext {
    const context: BusinessContext = { requestId: binding.requestId ?? randomUUID(), subject: { ...identity.subject },
      scope: { workspaceId: binding.workspaceId, agentId: binding.agentId, subjectId: identity.subject.id,
        instanceId: binding.instanceId, runtimeGeneration: binding.runtimeGeneration, ...(binding.sessionId ? { sessionId: binding.sessionId } : {}) },
      sourceDigest: binding.sourceDigest, identity: { evidence: { ...identity.evidence }, expiresAt: identity.expiresAt } }
    return this.acceptContext(context)
  }
  acceptContext(context: BusinessContext): BusinessContext {
    if (!context?.subject?.id || !context.scope || !context.requestId || !context.sourceDigest) return error('context_invalid')
    if (context.subject.kind !== 'human' || context.scope.subjectId !== context.subject.id) return error('context_invalid')
    const binding = this.state.instances[context.scope.instanceId ?? '']
    if (!binding || binding.workspaceId !== context.scope.workspaceId || binding.agentId !== context.scope.agentId
      || binding.runtimeGeneration !== context.scope.runtimeGeneration || binding.sourceDigest !== context.sourceDigest) return error('instance_binding_mismatch')
    if (!context.identity || context.identity.evidence.externalSubject !== context.subject.id
      || context.identity.evidence.issuer !== context.subject.identitySource || !future(context.identity.expiresAt)
      || !future(context.identity.evidence.expiresAt)) return error('identity_expired', 401)
    if (context.scope.sessionId && !shared.signedRuntimeSessions.getStore()) this.checkSession(context, context.scope.sessionId)
    return context
  }
  private checkSession(context: BusinessContext, sessionId: string): SessionBinding {
    const binding = this.state.sessions[sessionId]
    if (!binding || binding.subjectId !== context.subject.id || binding.subject.identitySource !== context.subject.identitySource
      || binding.workspaceId !== context.scope.workspaceId || binding.agentId !== context.scope.agentId
      || binding.instanceId !== context.scope.instanceId || binding.runtimeGeneration !== context.scope.runtimeGeneration
      || binding.sourceDigest !== context.sourceDigest) return error('resource_unavailable')
    return binding
  }
  bindSession(context: BusinessContext, sessionId: string): BusinessContext {
    this.assert(context, 'session:create')
    if (!sessionId || typeof sessionId !== 'string') return error('session_invalid')
    const previous = this.state.sessions[sessionId]
    if (previous) this.checkSession(context, sessionId)
    else {
      const binding = this.state.instances[context.scope.instanceId!]!
      this.state.sessions[sessionId] = { ...binding, sessionId, subjectId: context.subject.id,
        subject: { ...context.subject }, identity: structuredClone(context.identity), createdAt: iso(), observedAt: iso() }
      this.persist()
    }
    return this.sessionContext(context, sessionId)
  }
  sessionContext(context: BusinessContext, sessionId: string): BusinessContext {
    const binding = this.checkSession(context, sessionId)
    // 新凭据仍属于同一主体；刷新任务恢复证据，不改变持久归属。
    if (context.identity && Date.parse(context.identity.evidence.verifiedAt) >= Date.parse(binding.identity?.evidence.verifiedAt ?? '1970-01-01')
      && digest(context.identity) !== digest(binding.identity)) {
      binding.identity = structuredClone(context.identity); binding.observedAt = iso(); this.persist()
    }
    return this.acceptContext({ ...context, scope: { ...context.scope, sessionId } })
  }
  contextForSession(sessionId: string): BusinessContext | undefined {
    const binding = this.state.sessions[sessionId]
    if (!binding) return undefined
    return this.acceptContext({ requestId: randomUUID(), subject: { ...binding.subject }, sourceDigest: binding.sourceDigest,
      identity: structuredClone(binding.identity), scope: { workspaceId: binding.workspaceId, agentId: binding.agentId,
        subjectId: binding.subjectId, instanceId: binding.instanceId, runtimeGeneration: binding.runtimeGeneration, sessionId } })
  }
  listSessions(context: BusinessContext): string[] {
    this.assert(context, 'session:read')
    return Object.keys(this.state.sessions).filter(id => { try { this.checkSession(context, id); return true } catch { return false } })
  }
  bindResource(context: BusinessContext, resource: ResourceRef): void {
    this.acceptContext(context)
    if (!context.scope.sessionId || !resource.kind || !resource.id) return error('resource_invalid')
    const key = JSON.stringify([resource.kind, resource.id]), old = this.state.resources[key]
    if (old && (old.subjectId !== context.subject.id || old.sessionId !== context.scope.sessionId)) return error('resource_unavailable')
    this.state.resources[key] = { subjectId: context.subject.id, sessionId: context.scope.sessionId }
    this.persist()
  }
  private checkResource(context: BusinessContext, resource: ResourceRef): void {
    if (!resource.kind || !resource.id) return error('resource_invalid')
    if (resource.kind === 'session') { this.checkSession(context, resource.id); return }
    if (resource.kind === 'agent' && resource.id === context.scope.agentId) return
    if (resource.kind === 'instance' && resource.id === context.scope.instanceId) return
    if (resource.kind === 'operation') return
    const saved = this.state.resources[JSON.stringify([resource.kind, resource.id])]
    if (!saved || saved.subjectId !== context.subject.id || saved.sessionId !== context.scope.sessionId) return error('resource_unavailable')
  }
  private checkLease(context: BusinessContext): void {
    const id = context.scope.instanceId!
    if (!this.requiredSnapshots.has(id)) return
    const lease = this.leases.get(id)
    if (!lease || lease.snapshot.runtimeGeneration !== context.scope.runtimeGeneration
      || performance.now() - lease.receivedAt >= Math.min(2000, lease.snapshot.leaseMs)
      || lease.snapshot.restrictionVersion !== this.state.restrictionVersion) return error('control_snapshot_expired', 503)
  }
  private effectiveRiskFacts(): RiskFact[] {
    const facts = new Map(Object.values(this.state.riskFacts).map(fact => [fact.id, fact]))
    for (const local of Object.values(this.state.localRiskFacts)) {
      const known = facts.get(local.id)
      if (!known || local.version > known.version || (local.version === known.version
        && this.riskMeaning(local) === this.riskMeaning(known) && Date.parse(local.expiresAt) > Date.parse(known.expiresAt))) facts.set(local.id, local)
    }
    return [...facts.values()]
  }
  private assertBase(context: BusinessContext, action: string, resources: readonly ResourceRef[] = []): AccessDecision & { kind: 'allow' } {
    const config = this.config(), policyVersion = digest(config)
    const actionNames = action === 'resource' ? ['resource', 'read'] : [action]
    if (this.isManagement(context)) return { kind: 'allow', policyVersion, restrictionVersion: this.state.restrictionVersion }
    if (!config.enabled) return error('business_disabled', 503)
    if (!this.available) return error('authorization_unavailable', 503)
    this.acceptContext(context); this.checkLease(context)
    const agent = config.agents.find(value => value.agentId === context.scope.agentId)
    if (!agent?.enabled) return error('agent_closed')
    const agentStatus = this.agentStatus(context.scope.instanceId!)
    if (agentStatus.trust.status !== 'trusted') return error(agentStatus.trust.reason, 503)
    if (!agent.subjects.includes(context.subject.id) || (agent.sourceDigest && agent.sourceDigest !== context.sourceDigest)) return error('agent_forbidden')
    if (!agent.actions.includes('*') && !actionNames.some(value => agent.actions.includes(value))) return error('action_forbidden')
    resources.forEach(value => this.checkResource(context, value))
    return { kind: 'allow', policyVersion, restrictionVersion: this.state.restrictionVersion }
  }
  assert(context: BusinessContext, action: string, resources: readonly ResourceRef[] = [], args?: unknown): AccessDecision & { kind: 'allow' } {
    const decision = this.assertBase(context, action, resources)
    if (this.isManagement(context)) return decision
    const config = this.config(), actionNames = action === 'resource' ? ['resource', 'read'] : [action]
    const required = actionNames.some(value => (config.riskAssessment?.requiredKinds ?? ['write', 'publish']).includes(value as OperationKind))
    if (required && !config.riskAssessment) return error('risk_provider_unavailable', 503)
    let assessed = false
    for (const restriction of Object.values(this.state.restrictions)) {
      if (restriction.active && matches(restriction.scope, context, context.scope.serverId)
        && (restriction.deniedActions.includes('*') || actionNames.some(value => restriction.deniedActions.includes(value)))) return error('risk_restricted')
    }
    for (const fact of this.effectiveRiskFacts()) {
      if (!matches(fact.scope, context, context.scope.serverId)) continue
      if (fact.contentDigest && (args === undefined || fact.contentDigest !== digest(args))) continue
      if (required && (fact.status === 'unknown' || !future(fact.expiresAt))) return error('risk_fact_unavailable', 503)
      if (fact.status === 'assessed' && future(fact.expiresAt)) assessed = true
      if (future(fact.expiresAt) && fact.signals.some(value => (value.code === 'deny-all' && value.value === 'true')
        || (actionNames.some(action => value.code === `deny-${action}`) && value.value === 'true')
        || (value.code === 'deny-operation' && (value.value === '*' || actionNames.includes(value.value))))) return error('risk_restricted')
    }
    if (required && !assessed) return error('risk_fact_unavailable', 503)
    return decision
  }
  operationKind(serverId: string, operationId: string, fallback: OperationKind = 'write'): OperationKind {
    return this.config().operations?.find(value => value.serverId === serverId && value.operationId === operationId)?.kind ?? fallback
  }
  assertOperation(context: BusinessContext, operation: BusinessOperation): void {
    this.assert(context, operation.kind, operation.resources, operation.args)
    this.operationRule(context, operation)
  }
  private operationRule(context: BusinessContext, operation: BusinessOperation, checkRisk = true): void {
    const config = this.config(), rule = config.operations?.find(value => value.serverId === operation.serverId && value.operationId === operation.operationId)
    if (!rule) return error('operation_unregistered')
    if (rule.kind !== operation.kind || !matchesOperationTarget(rule.target, operation.target, rule.queryParameters) || rule.method.toUpperCase() !== operation.method.toUpperCase()
      || (rule.schemaDigest !== undefined && rule.schemaDigest !== operation.schemaDigest)) return error('operation_binding_changed')
    const agent = config.agents.find(value => value.agentId === context.scope.agentId)
    if (agent?.serverIds && !agent.serverIds.includes(operation.serverId)) return error('server_forbidden')
    if (checkRisk && this.effectiveRiskFacts().some(fact => matches(fact.scope, context, operation.serverId) && future(fact.expiresAt)
      && fact.signals.some(value => value.code === 'deny-operation' && value.value === operation.operationId))) return error('risk_restricted')
  }
  updateRisk(fact: RiskFact): boolean {
    if (!this.validRiskFact(fact)) return error('risk_fact_invalid')
    // Runtime 的检测只增加本地约束，不能擅自推进协调器的全局限制版本。
    const facts = this.requiredSnapshots.size ? this.state.localRiskFacts : this.state.riskFacts
    const authoritative = this.requiredSnapshots.size ? this.state.riskFacts[fact.id] : undefined
    if (authoritative && authoritative.version > fact.version) return false
    if (authoritative?.version === fact.version && this.riskMeaning(authoritative) !== this.riskMeaning(fact)) return error('risk_fact_version_conflict')
    const previous = facts[fact.id]
    if (previous && fact.version < previous.version) return false
    if (previous && fact.version === previous.version) {
      if (this.riskMeaning(previous) !== this.riskMeaning(fact)) return error('risk_fact_version_conflict')
      facts[fact.id] = structuredClone(fact); this.persist(); return false
    }
    facts[fact.id] = structuredClone(fact)
    if (!this.requiredSnapshots.size) this.state.restrictionVersion++
    this.persist(); this.cancelRestricted()
    return true
  }
  private validRiskFact(fact: RiskFact): boolean {
    return !!fact?.id && !['__proto__', 'constructor', 'prototype'].includes(fact.id)
      && Number.isSafeInteger(fact.version) && fact.version >= 0 && !!fact.scope?.workspaceId && !!fact.scope.agentId
      && ['assessed', 'unknown'].includes(fact.status) && Array.isArray(fact.signals)
      && (fact.level === undefined || ['low', 'high', 'unknown'].includes(fact.level))
      && fact.signals.every(value => typeof value.code === 'string' && typeof value.value === 'string' && typeof value.reason === 'string')
      && typeof fact.source === 'string' && Number.isFinite(Date.parse(fact.expiresAt))
  }
  private riskMeaning(fact: RiskFact): string { return digest([fact.scope, fact.status, fact.level, fact.signals, fact.source, fact.contentDigest]) }
  updateRestriction(input: Omit<Restriction, 'id'> & { id?: string }): Restriction {
    if (this.requiredSnapshots.size) return error('coordinator_write_required')
    const value: Restriction = { ...input, id: input.id ?? randomUUID() }
    if (!value.scope.workspaceId || !value.scope.agentId || !Array.isArray(value.deniedActions)) return error('restriction_invalid')
    this.state.restrictions[value.id] = structuredClone(value)
    this.state.restrictionVersion++; this.persist(); this.cancelRestricted()
    return value
  }
  /** 恢复修改限制后仍由最新基础授权、其他风险和实例许可共同决定。 */
  update(input: Omit<Restriction, 'id'> & { id?: string }): Restriction { return this.updateRestriction(input) }
  async reassess(context: BusinessContext, signal = noSignal(), action = 'write', args?: unknown, operationBinding?: AccessRequest['operationBinding']): Promise<RiskFact> {
    this.acceptContext(context)
    const config = this.config()
    if (!config.riskAssessment) return error('risk_provider_unavailable', 503)
    let fact: RiskFact
    try { fact = await new HttpRiskAssessmentProvider(config.riskAssessment).assess({ context, action,
      resources: context.scope.sessionId ? [{ kind: 'session', id: context.scope.sessionId }] : [{ kind: 'agent', id: context.scope.agentId }], validatedArgs: args, operationBinding }, signal) }
    catch { return error('risk_provider_unavailable', 503) }
    this.updateRisk(fact)
    return fact
  }
  async inspect(context: BusinessContext, stage: 'input' | 'operation' | 'report', input: unknown, signal = noSignal(), action: string = 'write', operationBinding?: AccessRequest['operationBinding']): Promise<RiskFact | undefined> {
    this.acceptContext(context)
    const config = this.config(), inspected = stage === 'report' ? reportInspectionInput(input) : input
    const text = typeof inspected === 'string' ? inspected : JSON.stringify(inspected)
    const markers = stage === 'input' ? config.detection?.inputMarkers : stage === 'report' ? config.detection?.reportMarkers : config.detection?.operationMarkers
    if (markers?.some(value => value && text?.includes(value))) {
      const facts = this.requiredSnapshots.size ? this.state.localRiskFacts : this.state.riskFacts
      const fact: RiskFact = { id: `local-${stage}-${digest(context.scope)}`, version: (facts[`local-${stage}-${digest(context.scope)}`]?.version ?? 0) + 1,
        scope: { ...context.scope }, status: 'assessed', level: 'high', source: `local-${stage}-marker`, observedAt: iso(),
        contentDigest: digest(input),
        expiresAt: new Date(Date.now() + 300000).toISOString(), signals: [{ code: stage === 'report' ? 'deny-publish' : 'deny-all', value: 'true', reason: 'synthetic_marker' }] }
      this.updateRisk(fact)
      return error('content_restricted')
    }
    if (config.riskAssessment) {
      try { return await this.reassess(context, signal, stage === 'report' ? 'publish' : stage === 'input' ? 'input' : action, inspected, operationBinding) }
      catch (cause) {
        const actionNames = action === 'resource' ? ['resource', 'read'] : [action]
        if (stage !== 'operation' || actionNames.some(value => (config.riskAssessment!.requiredKinds ?? ['write', 'publish']).includes(value as OperationKind))) throw cause
      }
    }
    else if (stage !== 'operation' || ['write', 'publish'].includes(action)) return error('risk_provider_unavailable', 503)
  }
  async revalidateIdentity(context: BusinessContext, signal = noSignal()): Promise<void> {
    if (!this.enabled()) return error('business_disabled', 503)
    if (!this.available) return error('authorization_unavailable', 503)
    this.acceptContext(context)
    const config = this.config()
    if (!config.authentication || !config.identityTrust || !context.identity) return error('identity_unavailable', 503)
    if (context.identity.evidence.issuer !== new URL(config.authentication.endpoint).origin) return error('identity_source_changed', 401)
    const trust = await new HttpIdentityTrustProvider(config.identityTrust).resolve(context.identity.evidence, signal)
    if (trust.kind !== 'trusted' || trust.subject.id !== context.subject.id || trust.subject.identitySource !== context.subject.identitySource) {
      return error(trust.kind === 'unknown' ? 'identity_unavailable' : 'identity_invalid', trust.kind === 'unknown' ? 503 : 401)
    }
  }
  private cancelRestricted(): void {
    for (const value of this.active.values()) {
      try { this.assert(value.context, value.operation.kind, value.operation.resources, value.operation.args); this.operationRule(value.context, value.operation) }
      catch { value.controller.abort(new BusinessControlError('permission_revoked', '当前操作许可已撤回')) }
    }
  }
  private confirmationBinding(context: BusinessContext, operation: BusinessOperation): string {
    return digest([context.subject, { ...context.scope, serverId: operation.serverId }, context.sourceDigest, operation])
  }
  createConfirmation(context: BusinessContext, operation: BusinessOperation): { id: string; expiresAt: string } {
    this.assert(context, operation.kind, operation.resources, operation.args); this.operationRule(context, operation)
    const id = randomUUID(), expiresAt = Date.now() + 120000
    this.confirmations.set(id, { id, subjectId: context.subject.id, binding: this.confirmationBinding(context, operation),
      version: this.state.restrictionVersion, expiresAt, confirmed: false })
    return { id, expiresAt: new Date(expiresAt).toISOString() }
  }
  confirm(context: BusinessContext, id: string): void {
    this.acceptContext(context)
    const value = this.confirmations.get(id)
    if (!value || value.subjectId !== context.subject.id || value.expiresAt <= Date.now() || value.version !== this.state.restrictionVersion) return error('confirmation_invalid')
    value.confirmed = true
  }
  setConfirmationHandler(handler?: (context: BusinessContext, operation: BusinessOperation, signal: AbortSignal) => Promise<void>, synchronize?: (signal: AbortSignal) => Promise<void>): void {
    this.confirmationHandler = handler
    this.confirmationSynchronizer = handler ? synchronize : undefined
  }
  async execute<T>(operation: BusinessOperation, dispatch: (signal: AbortSignal) => Promise<T> | T, signal = noSignal()): Promise<T> {
    const context = currentBusinessContext()
    if (this.isManagement(context) || (!this.enabled() && !context)) return dispatch(signal)
    if (!this.enabled()) return error('business_disabled', 503)
    if (!context) return error('business_context_missing')
    const scoped = { ...context, scope: { ...context.scope, serverId: operation.serverId } }
    const operationBinding: AccessRequest['operationBinding'] = { serverId: operation.serverId, operationId: operation.operationId,
      target: operation.target, method: operation.method, kind: operation.kind }
    const controller = new AbortController(), executionSignal = AbortSignal.any([signal, controller.signal]), id = randomUUID()
    let dispatched = false
    try {
      executionSignal.throwIfAborted()
      this.assertBase(scoped, operation.kind, operation.resources)
      this.operationRule(scoped, operation, false)
      await this.revalidateIdentity(scoped, executionSignal)
      await this.inspect(scoped, operation.kind === 'publish' ? 'report' : 'operation', operation.args, executionSignal, operation.kind, operationBinding)
      executionSignal.throwIfAborted()
      const initialRule = this.config().operations?.find(value => value.serverId === operation.serverId && value.operationId === operation.operationId)
      if (initialRule?.confirmation && this.confirmationHandler) {
        const operationDigest = digest(operation)
        // 本次检测事实先获中心接收并应用快照，再冻结供用户裁决的版本。
        await this.confirmationSynchronizer?.(executionSignal)
        executionSignal.throwIfAborted()
        if (operationDigest !== digest(operation)) return error('confirmation_invalid')
        this.assertOperation(scoped, operation)
        const confirmationVersion = this.state.restrictionVersion
        await this.confirmationHandler(structuredClone(scoped), structuredClone(operation), executionSignal)
        executionSignal.throwIfAborted()
        await this.revalidateIdentity(scoped, executionSignal)
        if (this.config().riskAssessment) await this.inspect(scoped, operation.kind === 'publish' ? 'report' : 'operation', operation.args, executionSignal, operation.kind, operationBinding)
        if (confirmationVersion !== this.state.restrictionVersion || operationDigest !== digest(operation)) return error('confirmation_invalid')
      }
      // 异步等待全部结束后，在同一同步片段重验并直接派发，旧许可没有可插入窗口。
      this.assert(scoped, operation.kind, operation.resources, operation.args); this.operationRule(scoped, operation)
      const rule = this.config().operations?.find(value => value.serverId === operation.serverId && value.operationId === operation.operationId)
      if (rule?.confirmation && !this.confirmationHandler) {
        const binding = this.confirmationBinding(scoped, operation)
        const confirmation = [...this.confirmations.values()].find(value => value.confirmed && value.binding === binding
          && value.version === this.state.restrictionVersion && value.expiresAt > Date.now())
        if (!confirmation) return error('confirmation_required')
        this.confirmations.delete(confirmation.id)
      }
      this.active.set(id, { context: scoped, operation, controller })
      dispatched = true
      const result = await dispatch(executionSignal)
      this.record(operation.kind, 'completed', scoped, operation.operationId,
        executionSignal.aborted ? 'completed_after_cancel_request' : undefined)
      return result
    } catch (cause) {
      this.record(operation.kind, dispatched ? 'unknown' : executionSignal.aborted ? 'cancelled' : 'denied', scoped, operation.operationId,
        cause instanceof BusinessControlError ? cause.code : dispatched ? 'upstream_result_unknown' : 'control_failed')
      throw cause
    } finally { this.active.delete(id) }
  }
  requireSnapshot(instanceId: string): void { this.requiredSnapshots.add(instanceId) }
  issueSnapshot(instanceId: string): ControlSnapshot {
    const binding = this.state.instances[instanceId]
    if (!binding) return error('instance_unregistered')
    const snapshot: ControlSnapshot = { instanceId, runtimeGeneration: binding.runtimeGeneration, restrictionVersion: this.state.restrictionVersion,
      leaseId: randomUUID(), leaseMs: 2000, issuedAt: iso(), riskFacts: Object.values(this.state.riskFacts), restrictions: Object.values(this.state.restrictions),
      agentStatus: this.agentStatus(instanceId) }
    this.issued.set(snapshot.leaseId, snapshot)
    // 只保留近期限度内的签发，避免长运行进程累积租约引用。
    for (const [id, value] of this.issued) if (Date.now() - Date.parse(value.issuedAt) > 10000) this.issued.delete(id)
    return structuredClone(snapshot)
  }
  acceptSnapshot(snapshot: ControlSnapshot): boolean {
    const binding = this.state.instances[snapshot.instanceId]
    if (!binding || binding.runtimeGeneration !== snapshot.runtimeGeneration || !Number.isSafeInteger(snapshot.restrictionVersion)
      || snapshot.restrictionVersion < this.state.restrictionVersion || snapshot.leaseMs <= 0 || snapshot.leaseMs > 2000
      || !future(new Date(Date.parse(snapshot.issuedAt) + snapshot.leaseMs).toISOString())) return false
    const incoming = Object.fromEntries(snapshot.riskFacts.map(value => [value.id, structuredClone(value)]))
    for (const local of Object.values(this.state.localRiskFacts)) {
      const known = incoming[local.id]
      if (known?.version === local.version && this.riskMeaning(known) !== this.riskMeaning(local)) return false
    }
    this.state.restrictionVersion = snapshot.restrictionVersion
    this.state.riskFacts = incoming
    for (const local of Object.values(this.state.localRiskFacts)) {
      const known = incoming[local.id]
      if (known && known.version >= local.version && Date.parse(known.expiresAt) >= Date.parse(local.expiresAt)) delete this.state.localRiskFacts[local.id]
      else if (known && known.version > local.version) delete this.state.localRiskFacts[local.id]
    }
    this.state.restrictions = Object.fromEntries(snapshot.restrictions.map(value => [value.id, structuredClone(value)]))
    this.leases.set(snapshot.instanceId, { snapshot: structuredClone(snapshot),
      receivedAt: performance.now() - Math.max(0, Date.now() - Date.parse(snapshot.issuedAt)) })
    this.persist(); this.cancelRestricted()
    return true
  }
  acknowledge(instanceId: string, restrictionVersion: number, leaseId: string): boolean {
    const snapshot = this.issued.get(leaseId)
    if (!snapshot || snapshot.instanceId !== instanceId || snapshot.restrictionVersion !== restrictionVersion
      || restrictionVersion !== this.state.restrictionVersion || Date.now() - Date.parse(snapshot.issuedAt) >= 2000) return false
    this.acknowledgements.set(instanceId, { restrictionVersion, leaseId, at: iso() })
    return true
  }
  setAvailable(available: boolean): void { this.available = available; if (!available) this.cancelRestricted() }
  configurationChanged(): void {
    if (this.requiredSnapshots.size) return error('coordinator_write_required')
    this.config()
    this.state.restrictionVersion++; this.persist(); this.cancelRestricted()
  }
  status(): { enabled: boolean; restrictionVersion: number; instances: unknown[]; restrictions: Restriction[]; riskFacts: RiskFact[]; events: ControlEvent[] } {
    return { enabled: this.enabled(), restrictionVersion: this.state.restrictionVersion,
      instances: Object.values(this.state.instances).map(value => {
        const ack = this.acknowledgements.get(value.instanceId)
        return { ...value, acknowledgement: ack, applied: !!ack && ack.restrictionVersion === this.state.restrictionVersion && Date.now() - Date.parse(ack.at) < 2000 }
      }), restrictions: structuredClone(Object.values(this.state.restrictions)),
      riskFacts: structuredClone(this.effectiveRiskFacts()), events: structuredClone(this.state.events) }
  }
}
