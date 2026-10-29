import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
  AccessDecision, AccessRequest, AgentAuthenticationEvidence, AgentInstanceStatus, AuthenticatedIdentity, AuthenticationInput, BusinessAccessConfig, BusinessContext,
  BusinessOperation, ControlEvent, ControlScope, ControlSnapshot, InstanceBinding, OperationKind,
  ReplicaBatch, ReplicaObservation, ResourceRef, Restriction, RiskFact, SessionBinding, SessionTrustFact, ToolPolicyEffect, ToolPolicyWhen, AuthorizationReceipt, ExternalAccessDecision,
} from './contracts.js'
import { retiredLocalRiskFact, validAgentToolPolicies } from './contracts.js'
import { HttpAuthenticationProvider, HttpIdentityTrustProvider, HttpRiskAssessmentProvider, HttpAccessAuthorizationProvider } from './providers.js'
import { resolveBusinessSecretFile } from './secret-file.ts'
import { REPLICA_BATCH_BYTES } from './replica.ts'

export * from './contracts.js'

/** 无需认证时仅构造实例级路由上下文，不识别访问者。 */
export function sharedInstanceIdentity(binding: Pick<InstanceBinding, 'workspaceId' | 'agentId' | 'instanceId'>): AuthenticatedIdentity {
  const id = `shared-${createHash('sha256').update(JSON.stringify([binding.workspaceId, binding.agentId, binding.instanceId])).digest('base64url')}`
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString()
  return { subject: { id, kind: 'human', identitySource: 'gateway-shared' },
    evidence: { issuer: 'gateway-shared', externalSubject: id, method: 'none', verifiedAt: new Date().toISOString(), expiresAt }, expiresAt }
}

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
/** 仅在平台核验 Runtime 的接入凭据与绑定后使用；Session 事实仍由业务 Runtime 持有。 */
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
const error = (code: string, status = 403, message?: string): never => {
  const reasons: Record<string, string> = {
    risk_provider_unavailable: '第三方风险评估未配置或未返回有效结果，请核对提供方后重试',
    risk_fact_unavailable: '匹配的第三方评估缺失、未知或已过期，暂不执行需要有效评估的操作',
    risk_restricted: '本次请求仍受人工限制或第三方明确拒绝约束，请核对对应用户、会话、服务与操作范围',
    confirmation_invalid: '本次确认依据已变化、失效或过期，请重新核对目标与参数后确认，未派发本次请求',
  }
  throw new BusinessControlError(code, message ?? reasons[code] ?? '当前请求未获业务许可', status)
}
const matches = (scope: ControlScope, context: BusinessContext, serverId?: string): boolean =>
  Object.entries(scope).every(([key, value]) => value === undefined
    || (key === 'subjectId' ? context.subject.id : key === 'serverId' ? serverId : context.scope[key as keyof ControlScope]) === value)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const future = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now()
const kinds: OperationKind[] = ['read', 'write', 'resource', 'publish']
interface GatewayRegistration { agentId: string; instanceId: string; sourceDigest?: string; accessMode?: string; identityMode?: string }
function gatewayRegistration(config: BusinessAccessConfig, agentId?: string, instanceId?: string): GatewayRegistration | undefined {
  return (config.gateway as { instances?: GatewayRegistration[] } | undefined)?.instances?.find(value => value.agentId === agentId && value.instanceId === instanceId)
}
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
  private synchronizations = new Map<string, { lastSuccessAt?: string; lastAttemptAt: string; lastError?: string }>()
  private replicaTransfers = new Map<string, { id: string; at: number; parts: Array<ReplicaObservation | undefined> }>()
  private completedReplicaTransfers = new Map<string, { id: string; digests: string[] }>()
  private active = new Map<string, { context: BusinessContext; operation: BusinessOperation; controller: AbortController; conditionFact?: RiskFact; policyVersion: string; confirmed: boolean; authorizationSource?: AuthorizationReceipt['source']; authorizationRiskDigest?: string; contentDigest?: string }>()
  private executionAuthorization = new AsyncLocalStorage<{ external: boolean; riskUnavailable: boolean; lastRiskStatus?: RiskFact['status']; grant?: ExternalAccessDecision; configVersion?: string; operationDigest?: string; riskDigest?: string; id?: string; contentDigest?: string; refreshingRisk?: boolean; pendingRiskAuthorization?: boolean; refresh?: () => Promise<void>; operation?: BusinessOperation }>()
  private confirmations = new Map<string, Confirmation>()
  private agentAuthentications = new Map<string, { evidence: AgentAuthenticationEvidence; receivedAt: number }>()
  private confirmationHandler?: (context: BusinessContext, operation: BusinessOperation, signal: AbortSignal, reason?: string) => Promise<void>
  private confirmationSynchronizer?: (signal: AbortSignal) => Promise<void>
  private available = true
  private observedManagedGateway = false

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
    this.observedManagedGateway = this.config().gateway !== undefined
  }
  config(): BusinessAccessConfig {
    const path = join(this.assetRoot, 'config', 'business-access.json')
    if (!existsSync(path)) return { schemaVersion: 1, enabled: false, agents: [] }
    let value: BusinessAccessConfig
    try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { return error('control_config_invalid', 503) }
    if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.agents)
      || value.agents.some(rule => !rule.agentId || typeof rule.enabled !== 'boolean' || !Array.isArray(rule.subjects) || !Array.isArray(rule.actions)
        || (rule.agentAuthentication !== undefined && (!rule.agentAuthentication || rule.agentAuthentication.method !== 'hmac-sha256' || typeof rule.agentAuthentication.enabled !== 'boolean'))
        || (rule.agentTrust !== undefined && (!rule.agentTrust || typeof rule.agentTrust.enabled !== 'boolean'))
        || (rule.toolPolicies !== undefined && !validAgentToolPolicies(rule.toolPolicies)))
      || (value.operations && (!Array.isArray(value.operations) || value.operations.some(rule =>
        !rule.serverId || !rule.operationId || !kinds.includes(rule.kind) || !rule.target || !rule.method)))) {
      return error('control_config_invalid', 503)
    }
    // 共享密钥属于本地状态：配置保存相对路径，读取时按当前数据根解析，避免数据仓库迁移后失效。
    const gateway = value.gateway as { sharedSecretFile?: string } | undefined
    if (typeof gateway?.sharedSecretFile === 'string') {
      gateway.sharedSecretFile = resolveBusinessSecretFile(this.assetRoot, gateway.sharedSecretFile)
    }
    return value
  }
  enabled(): boolean { return this.config().enabled }
  stateDirectory(): string { return dirname(this.path) }
  /** 仅由已完成 HMAC、接收实例、路径和重放校验的控制通道调用。 */
  recordAgentAuthentication(binding: InstanceBinding): void {
    const registered = this.state.instances[binding.instanceId]
    if (!registered || Object.entries(binding).some(([key, value]) => registered[key as keyof InstanceBinding] !== value)) return error('agent_authentication_binding_invalid')
    if (gatewayRegistration(this.config(), binding.agentId, binding.instanceId)?.identityMode === 'development') {
      this.agentAuthentications.delete(binding.instanceId)
      return
    }
    this.agentAuthentications.set(binding.instanceId, { receivedAt: performance.now(), evidence: {
      method: 'hmac-sha256', binding: { ...binding }, verifiedAt: iso(), expiresAt: new Date(Date.now() + 2000).toISOString(), source: 'signed-control-assertion',
    } })
  }
  agentStatus(instanceId: string): AgentInstanceStatus {
    const binding = this.state.instances[instanceId], config = this.config()
    if (config.gateway) this.observedManagedGateway = true
    const rule = config.agents.find(rule => rule.agentId === binding?.agentId)
    const registered = gatewayRegistration(config, binding?.agentId, instanceId)
    const development = registered?.identityMode === 'development'
    const pinnedDigest = development ? registered.sourceDigest : registered?.sourceDigest ?? rule?.sourceDigest
    const result: AgentInstanceStatus = { instanceId, agentId: binding?.agentId,
      authentication: development ? { method: 'none', status: 'not_required' } : { method: 'hmac-sha256', status: 'unknown' },
      trust: { status: 'unknown', reason: development ? 'development_channel_unknown' : 'agent_authentication_unknown', sourceDigest: binding?.sourceDigest,
        runtimeGeneration: binding?.runtimeGeneration, restrictionVersion: this.state.restrictionVersion } }
    if (!binding) { result.trust.reason = 'instance_unregistered'; return result }
    const replica = this.requiredSnapshots.has(instanceId), lease = this.leases.get(instanceId)
    if (development) {
      result.trust.status = 'trusted'; result.trust.reason = 'development-pinned-source'
    } else if (replica && lease?.snapshot.agentStatus) {
      result.authentication = { ...lease.snapshot.agentStatus.authentication }
      result.trust = { ...lease.snapshot.agentStatus.trust, restrictionVersion: this.state.restrictionVersion }
      if (development !== (result.authentication.status === 'not_required')) {
        result.authentication = development ? { method: 'none', status: 'not_required' } : { method: 'hmac-sha256', status: 'unknown' }
        result.trust.status = 'unknown'; result.trust.reason = 'identity_mode_changed'
      }
      if (performance.now() - lease.receivedAt >= Math.min(2000, lease.snapshot.leaseMs)) {
        if (!development) result.authentication.status = 'expired'
        result.trust.status = 'expired'; result.trust.reason = 'agent_channel_expired'
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
    if (!development && rule?.agentAuthentication?.enabled === false) {
      result.authentication.status = 'disabled'; result.trust.status = 'revoked'; result.trust.reason = 'agent_authentication_disabled'
    } else if (!config.enabled || !development && (!rule || rule.enabled === false || rule.agentTrust?.enabled === false)) {
      result.trust.status = 'revoked'; result.trust.reason = !config.enabled ? 'business_disabled' : !rule?.enabled ? 'agent_closed' : 'agent_trust_revoked'
    } else if (this.observedManagedGateway && !config.gateway) {
      result.trust.status = 'revoked'; result.trust.reason = 'gateway_registration_unavailable'
    } else if (config.gateway && !registered) {
      result.trust.status = 'revoked'; result.trust.reason = 'instance_not_registered'
    } else if (!pinnedDigest) { result.trust.status = 'unknown'; result.trust.reason = 'agent_source_unpinned' }
    else if (binding.sourceDigest !== pinnedDigest) { result.trust.status = 'mismatch'; result.trust.reason = 'agent_source_mismatch' }
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
  importReplicaBatch(binding: InstanceBinding, batch: ReplicaBatch): boolean {
    if (!batch || typeof batch.id !== 'string' || !/^[a-f0-9-]{36}$/.test(batch.id)
      || !Number.isSafeInteger(batch.count) || batch.count < 1 || batch.count > 256
      || !Number.isSafeInteger(batch.index) || batch.index < 0 || batch.index >= batch.count
      || !batch.observation || digest(batch.observation.binding) !== digest(binding)
      || !Array.isArray(batch.observation.sessions) || !Array.isArray(batch.observation.riskFacts) || !Array.isArray(batch.observation.events)
      || Buffer.byteLength(JSON.stringify(batch.observation)) > REPLICA_BATCH_BYTES) return error('replica_batch_invalid')
    const completed = this.completedReplicaTransfers.get(binding.instanceId)
    if (completed?.id === batch.id) {
      if (completed.digests.length !== batch.count || completed.digests[batch.index] !== digest(batch.observation)) return error('replica_batch_conflict')
      return true
    }
    let transfer = this.replicaTransfers.get(binding.instanceId)
    if (!transfer || transfer.id !== batch.id || Date.now() - transfer.at > 60_000) {
      transfer = { id: batch.id, at: Date.now(), parts: new Array(batch.count) }
      this.replicaTransfers.set(binding.instanceId, transfer)
    }
    if (transfer.parts.length !== batch.count) return error('replica_batch_conflict')
    const previous = transfer.parts[batch.index]
    if (previous && digest(previous) !== digest(batch.observation)) return error('replica_batch_conflict')
    transfer.parts[batch.index] = structuredClone(batch.observation)
    if (Array.from(transfer.parts).some(part => !part)) return false
    const parts = transfer.parts as ReplicaObservation[]
    this.importReplicaState(binding, { binding, sessions: parts.flatMap(part => part.sessions),
      riskFacts: parts.flatMap(part => part.riskFacts), events: parts.flatMap(part => part.events) })
    this.completedReplicaTransfers.set(binding.instanceId, { id: batch.id, digests: parts.map(part => digest(part)) })
    this.replicaTransfers.delete(binding.instanceId)
    return true
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
        || (session.parentSessionId !== undefined && (typeof session.parentSessionId !== 'string' || !session.parentSessionId
          || session.parentSessionId === session.sessionId))
        || session.subject?.kind !== 'human' || session.subjectId !== session.subject.id || !session.subject.identitySource
        || !session.identity || session.identity.evidence.externalSubject !== session.subjectId
        || session.identity.evidence.issuer !== session.subject.identitySource) return error('replica_session_invalid')
      const previous = this.state.sessions[session.sessionId]
      if (previous && (Object.entries(binding).some(([key, value]) => previous[key as keyof InstanceBinding] !== value)
        || previous.subjectId !== session.subjectId || previous.subject.identitySource !== session.subject.identitySource
        || previous.parentSessionId !== session.parentSessionId)) return error('replica_session_conflict')
      subjects.add(session.subjectId); sessions.set(session.sessionId, session)
    }
    for (const session of sessions.values()) if (session.parentSessionId) {
      const parent = sessions.get(session.parentSessionId)
      if (!parent || parent.parentSessionId || parent.subjectId !== session.subjectId
        || parent.subject.identitySource !== session.subject.identitySource)
        return error('replica_session_invalid')
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
        || !Number.isSafeInteger(event.restrictionVersion)
        || (event.scope && Object.entries(event.scope).some(([key, value]) => !['workspaceId', 'agentId', 'subjectId', 'instanceId', 'runtimeGeneration', 'sessionId', 'serverId'].includes(key)
          || typeof value !== 'string' || value.length > 500 || key !== 'serverId' && value !== (key === 'subjectId' ? event.subjectId : key === 'sessionId' ? event.sessionId : binding[key as keyof InstanceBinding])))
        || (event.authorization && (!['third-party', 'manual-fallback', 'manual'].includes(event.authorization.source)
          || !['allow', 'deny', 'confirm'].includes(event.authorization.decision)
          || Object.keys(event.authorization).some(key => !['source', 'decision', 'policyVersion', 'reason', 'expiresAt', 'provider'].includes(key))
          || [event.authorization.policyVersion, event.authorization.reason, event.authorization.expiresAt, event.authorization.provider].some(value => value !== undefined && (typeof value !== 'string' || value.length > 1500))
          || event.authorization.expiresAt !== undefined && !Number.isFinite(Date.parse(event.authorization.expiresAt))
          || event.authorization.provider !== undefined && (() => { try { const url = new URL(event.authorization!.provider!); return !['http:', 'https:'].includes(url.protocol) || url.origin !== event.authorization!.provider } catch { return true } })()))) return error('replica_event_invalid')
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
  private record(action: string, outcome: ControlEvent['outcome'], context?: BusinessContext, operationId?: string, reason?: string, authorization?: AuthorizationReceipt): void {
    this.state.events.push({ id: randomUUID(), at: iso(), requestId: context?.requestId,
      subjectId: context?.subject.id, sessionId: context?.scope.sessionId, operationId, action,
      restrictionVersion: this.state.restrictionVersion, outcome, reason,
      ...(context ? { scope: { ...context.scope } } : {}), ...(authorization ? { authorization: { ...authorization } } : {}) })
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
    const registered = gatewayRegistration(this.config(), binding.agentId, binding.instanceId)
    if (old && old.workspaceId === binding.workspaceId && old.agentId === binding.agentId
      && old.runtimeGeneration === binding.runtimeGeneration && registered?.identityMode === 'development') {
      for (const session of Object.values(this.state.sessions)) {
        if (session.instanceId === old.instanceId && session.workspaceId === old.workspaceId && session.agentId === old.agentId
          && session.runtimeGeneration === old.runtimeGeneration && session.sourceDigest === old.sourceDigest) session.sourceDigest = binding.sourceDigest
      }
    }
    this.state.instances[binding.instanceId] = { ...binding }
    this.agentAuthentications.delete(binding.instanceId); this.acknowledgements.delete(binding.instanceId)
    this.synchronizations.delete(binding.instanceId)
    this.replicaTransfers.delete(binding.instanceId); this.completedReplicaTransfers.delete(binding.instanceId)
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
  isSharedContext(context: BusinessContext): boolean {
    const evidence = context.identity?.evidence
    const shared = context.subject.identitySource === 'gateway-shared' && evidence?.issuer === 'gateway-shared'
      && evidence.method === 'none' && context.subject.id === sharedInstanceIdentity(context.scope as InstanceBinding).subject.id
    const legacy = context.subject.identitySource === 'gateway-anonymous' && evidence?.issuer === 'gateway-anonymous'
      && evidence.method === 'anonymous' && /^visitor-[A-Za-z0-9_-]{32,}$/.test(context.subject.id)
    if (context.subject.kind !== 'human' || (!shared && !legacy) || evidence?.externalSubject !== context.subject.id) return false
    const registered = gatewayRegistration(this.config(), context.scope.agentId, context.scope.instanceId)
    return registered?.accessMode === 'anonymous'
  }
  isDevelopmentContext(context: BusinessContext): boolean {
    return this.isDevelopmentInstance(context.scope)
  }
  isDevelopmentInstance(binding: { agentId?: string; instanceId?: string }): boolean {
    const registered = gatewayRegistration(this.config(), binding.agentId, binding.instanceId)
    if (registered?.identityMode !== undefined && !['development', 'published'].includes(registered.identityMode)) return error('identity_mode_invalid')
    return registered?.identityMode === 'development'
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
    const shared = this.isSharedContext(context)
    if (!binding || (!shared && (binding.subjectId !== context.subject.id || binding.subject.identitySource !== context.subject.identitySource))
      || binding.workspaceId !== context.scope.workspaceId || binding.agentId !== context.scope.agentId
      || binding.instanceId !== context.scope.instanceId || binding.runtimeGeneration !== context.scope.runtimeGeneration
      || binding.sourceDigest !== context.sourceDigest) return error('resource_unavailable')
    return binding
  }
  bindSession(context: BusinessContext, sessionId: string, parentSessionId?: string): BusinessContext {
    this.assert(context, 'session:create')
    if (!sessionId || typeof sessionId !== 'string') return error('session_invalid')
    if (parentSessionId !== undefined && (typeof parentSessionId !== 'string' || !parentSessionId || parentSessionId === sessionId)) return error('session_invalid')
    if (parentSessionId) {
      if (this.checkSession(context, parentSessionId).parentSessionId) return error('session_invalid')
      context = this.sessionContext(context, parentSessionId)
    }
    const previous = this.state.sessions[sessionId]
    if (previous) {
      this.checkSession(context, sessionId)
      if (previous.parentSessionId !== parentSessionId) return error('session_parent_mismatch')
    }
    else {
      const binding = this.state.instances[context.scope.instanceId!]!
      this.state.sessions[sessionId] = { ...binding, sessionId, subjectId: context.subject.id,
        subject: { ...context.subject }, identity: structuredClone(context.identity), createdAt: iso(), observedAt: iso(),
        ...(parentSessionId ? { parentSessionId } : {}) }
      this.persist()
    }
    return this.sessionContext(context, sessionId)
  }
  parentSessionId(context: BusinessContext, sessionId: string): string | undefined {
    return this.checkSession(context, sessionId).parentSessionId
  }
  sessionContext(context: BusinessContext, sessionId: string): BusinessContext {
    const binding = this.checkSession(context, sessionId)
    // 新凭据仍属于同一主体；刷新任务恢复证据，不改变持久归属。
    if (!this.isSharedContext(context) && context.identity && Date.parse(context.identity.evidence.verifiedAt) >= Date.parse(binding.identity?.evidence.verifiedAt ?? '1970-01-01')
      && digest(context.identity) !== digest(binding.identity)) {
      binding.identity = structuredClone(context.identity); binding.observedAt = iso(); this.persist()
    }
    return this.acceptContext({ ...context, scope: { ...context.scope, sessionId } })
  }
  contextForSession(sessionId: string): BusinessContext | undefined {
    const binding = this.state.sessions[sessionId]
    if (!binding) return undefined
    const identity = gatewayRegistration(this.config(), binding.agentId, binding.instanceId)?.accessMode === 'anonymous'
      ? sharedInstanceIdentity(binding) : binding.identity && { subject: binding.subject, ...structuredClone(binding.identity) }
    if (!identity) return undefined
    return this.acceptContext({ requestId: randomUUID(), subject: { ...identity.subject }, sourceDigest: binding.sourceDigest,
      identity: { evidence: identity.evidence, expiresAt: identity.expiresAt }, scope: { workspaceId: binding.workspaceId, agentId: binding.agentId,
        subjectId: identity.subject.id, instanceId: binding.instanceId, runtimeGeneration: binding.runtimeGeneration, sessionId } })
  }

  listSessions(context: BusinessContext): string[] {
    this.assert(context, 'session:read')
    return Object.keys(this.state.sessions).filter(id => { try { this.checkSession(context, id); return true } catch { return false } })
  }
  bindResource(context: BusinessContext, resource: ResourceRef): void {
    this.acceptContext(context)
    if (!context.scope.sessionId || !resource.kind || !resource.id) return error('resource_invalid')
    const key = JSON.stringify([resource.kind, resource.id]), old = this.state.resources[key]
    if (old) { this.checkResource(context, resource); return }
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
    if (!saved || saved.sessionId !== context.scope.sessionId) return error('resource_unavailable')
    const session = this.checkSession(context, saved.sessionId)
    if (saved.subjectId !== context.subject.id && !(this.isSharedContext(context) && saved.subjectId === session.subjectId)) return error('resource_unavailable')
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
  /** 仅核对身份与静态基础许可；业务执行仍须经 assert/execute 叠加手工限制和自动风险。 */
  assertBase(context: BusinessContext, action: string, resources: readonly ResourceRef[] = [], operation?: BusinessOperation): AccessDecision & { kind: 'allow' } {
    const config = this.config(), policyVersion = digest(config)
    const actionNames = action === 'resource' ? ['resource', 'read'] : [action]
    if (this.isManagement(context)) return { kind: 'allow', policyVersion, restrictionVersion: this.state.restrictionVersion }
    if (!config.enabled) return error('business_disabled', 503)
    if (!this.available) return error('authorization_unavailable', 503)
    const anonymous = this.isSharedContext(context)
    if (!anonymous && (!config.authentication || !config.identityTrust || !context.identity)) return error('identity_unavailable', 503)
    if (!anonymous && context.identity!.evidence.issuer !== new URL(config.authentication!.endpoint).origin) return error('identity_source_changed', 401)
    this.acceptContext(context)
    if (!this.isDevelopmentContext(context)) this.checkLease(context)
    if (config.gateway) this.observedManagedGateway = true
    if (this.observedManagedGateway && !config.gateway) return error('gateway_registration_unavailable', 503)
    const registered = gatewayRegistration(config, context.scope.agentId, context.scope.instanceId)
    if (config.gateway && !registered) return error('instance_not_registered', 403)
    const development = registered?.identityMode === 'development'
    const agent = config.agents.find(value => value.agentId === context.scope.agentId)
    if (!development && (!agent || agent.enabled === false)) return error('agent_closed')
    const agentStatus = this.agentStatus(context.scope.instanceId!)
    if (agentStatus.trust.status !== 'trusted') return error(agentStatus.trust.reason, 503)
    if (development) {
      if (!registered.sourceDigest || registered.sourceDigest !== context.sourceDigest) return error('agent_source_mismatch')
      resources.forEach(value => this.checkResource(context, value))
      return { kind: 'allow', policyVersion, restrictionVersion: this.state.restrictionVersion }
    }
    if (agentStatus.authentication.status !== 'verified') return error('agent_authentication_unknown', 503)
    const pinnedDigest = registered?.sourceDigest ?? agent!.sourceDigest
    if ((!anonymous && !agent!.subjects.includes(context.subject.id))
      || (pinnedDigest && pinnedDigest !== context.sourceDigest)) return error('agent_forbidden')
    if (!(operation && config.accessAuthorization && this.executionAuthorization.getStore()?.external !== false && kinds.includes(action as OperationKind))
      && !agent!.actions.includes('*') && !actionNames.some(value => agent!.actions.includes(value))) return error('action_forbidden')
    resources.forEach(value => this.checkResource(context, value))
    return { kind: 'allow', policyVersion, restrictionVersion: this.state.restrictionVersion }
  }
  assert(context: BusinessContext, action: string, resources: readonly ResourceRef[] = [], args?: unknown, operation?: BusinessOperation): AccessDecision & { kind: 'allow' } {
    const execution = this.executionAuthorization.getStore()
    if (operation && execution?.pendingRiskAuthorization) return error('authorization_changed', 403, '正文风险评估已变化，需要重新取得本次访问决定')
    if (operation && execution?.grant && (!future(execution.grant.expiresAt) || execution.configVersion !== digest(this.config())
      || execution.operationDigest !== digest(operation) || execution.riskDigest !== digest(this.authorizationRiskFacts(context, operation)))) return error('authorization_changed', 403, '本次访问决定已经过期或操作依据已变化，请重新请求')
    const decision = this.assertBase(context, action, resources, operation)
    if (this.isManagement(context) || this.isDevelopmentContext(context)) return decision
    const config = this.config(), actionNames = action === 'resource' ? ['resource', 'read'] : [action]
    const serverId = operation?.serverId ?? context.scope.serverId
    for (const restriction of Object.values(this.state.restrictions)) {
      if (restriction.active && matches(restriction.scope, context, serverId)
        && (restriction.deniedActions.includes('*') || actionNames.some(value => restriction.deniedActions.includes(value)))) return error('risk_restricted')
    }
    if (!config.riskAssessment) return decision
    for (const fact of this.effectiveRiskFacts()) {
      if (retiredLocalRiskFact(fact)) continue
      if (!matches(fact.scope, context, serverId)) continue
      if (fact.operationBinding && (!operation || !this.matchesRiskOperation(fact, operation, context))) continue
      if (fact.contentDigest && (args === undefined || fact.contentDigest !== digest(args))) continue
      if (future(fact.expiresAt) && fact.signals.some(value => (value.code === 'deny-all' && value.value === 'true')
        || (actionNames.some(action => value.code === `deny-${action}`) && value.value === 'true')
        || (value.code === 'deny-operation' && (value.value === '*' || actionNames.includes(value.value))))) return error('risk_restricted')
    }
    return decision
  }
  operationKind(serverId: string, operationId: string, fallback: OperationKind = 'write'): OperationKind {
    return this.config().operations?.find(value => value.serverId === serverId && value.operationId === operationId)?.kind ?? fallback
  }
  assertOperation(context: BusinessContext, operation: BusinessOperation): void {
    this.assert(context, operation.kind, operation.resources, operation.args, operation)
    this.operationRule(context, operation)
  }
  private authorizationRiskFacts(context: BusinessContext, operation: BusinessOperation): RiskFact[] {
    if (!this.config().riskAssessment) return []
    const contentDigest = this.executionAuthorization.getStore()?.contentDigest ?? digest(operation.kind === 'publish' ? reportInspectionInput(operation.args) : operation.args ?? null)
    return this.effectiveRiskFacts().filter(fact => !retiredLocalRiskFact(fact) && future(fact.expiresAt)
      && (!fact.contentDigest || fact.contentDigest === contentDigest)
      && matches(fact.scope, context, operation.serverId) && this.matchesRiskOperation(fact, operation, context))
  }
  private matchesRiskOperation(fact: RiskFact, operation: BusinessOperation, context: BusinessContext): boolean {
    const binding = fact.operationBinding
    if (!binding) return true
    const input = operation.kind === 'publish' ? reportInspectionInput(operation.args) : operation.args
    const inputDigest = fact.contentDigest ? this.executionAuthorization.getStore()?.contentDigest : digest(input ?? null)
    return fact.scope.workspaceId === context.scope.workspaceId && fact.scope.agentId === context.scope.agentId
      && fact.scope.subjectId === context.subject.id && fact.scope.instanceId === context.scope.instanceId
      && fact.scope.runtimeGeneration === context.scope.runtimeGeneration && fact.scope.sessionId === context.scope.sessionId
      && fact.scope.serverId === operation.serverId && binding.serverId === operation.serverId && binding.operationId === operation.operationId && binding.method === operation.method
      && binding.kind === operation.kind && binding.targetDigest === digest(operation.target) && binding.inputDigest === inputDigest
  }
  private operationRule(context: BusinessContext, operation: BusinessOperation, checkRisk = true): void {
    if (this.isDevelopmentContext(context)) return
    const config = this.config(), rule = config.operations?.find(value => value.serverId === operation.serverId && value.operationId === operation.operationId)
    if (!rule) return error('operation_unregistered')
    if (rule.kind !== operation.kind || !matchesOperationTarget(rule.target, operation.target, rule.queryParameters) || rule.method.toUpperCase() !== operation.method.toUpperCase()
      || (rule.schemaDigest !== undefined && rule.schemaDigest !== operation.schemaDigest)) return error('operation_binding_changed')
    const agent = config.agents.find(value => value.agentId === context.scope.agentId)
    if (!(config.accessAuthorization && this.executionAuthorization.getStore()?.external !== false)
      && agent?.serverIds && !agent.serverIds.includes(operation.serverId)) return error('server_forbidden')
    if (checkRisk && config.riskAssessment && this.effectiveRiskFacts().some(fact => !retiredLocalRiskFact(fact) && matches(fact.scope, context, operation.serverId) && future(fact.expiresAt) && (!fact.operationBinding || !fact.contentDigest || fact.contentDigest === (this.executionAuthorization.getStore()?.contentDigest ?? digest(operation.kind === 'publish' ? reportInspectionInput(operation.args) : operation.args ?? null))) && this.matchesRiskOperation(fact, operation, context)
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
    const codes = (value: unknown) => Array.isArray(value) && value.length <= 64
      && value.every(item => typeof item === 'string' && item.trim() === item && item.length > 0 && item.length <= 256)
    const evidence = fact?.conditionEvidence
    const binding = fact?.operationBinding
    return !!fact?.id && !['__proto__', 'constructor', 'prototype'].includes(fact.id)
      && Number.isSafeInteger(fact.version) && fact.version >= 0 && !!fact.scope?.workspaceId && !!fact.scope.agentId
      && ['assessed', 'unknown'].includes(fact.status) && Array.isArray(fact.signals)
      && (fact.level === undefined || ['low', 'high', 'unknown'].includes(fact.level))
      && fact.signals.every(value => typeof value.code === 'string' && typeof value.value === 'string' && typeof value.reason === 'string')
      && typeof fact.source === 'string' && Number.isFinite(Date.parse(fact.expiresAt))
      && (evidence === undefined || !!evidence && typeof evidence === 'object' && !Array.isArray(evidence)
        && Object.keys(evidence).every(key => ['scenarioIds', 'operationTags'].includes(key))
        && (evidence.scenarioIds === undefined || codes(evidence.scenarioIds)) && (evidence.operationTags === undefined || codes(evidence.operationTags)))
      && (binding === undefined || !!binding && typeof binding === 'object' && !Array.isArray(binding)
        && Object.keys(binding).every(key => ['serverId', 'operationId', 'method', 'kind', 'targetDigest', 'inputDigest'].includes(key))
        && [binding.serverId, binding.operationId, binding.method].every(value => typeof value === 'string' && value.length > 0)
        && kinds.includes(binding.kind) && /^[a-f0-9]{64}$/.test(binding.targetDigest) && /^[a-f0-9]{64}$/.test(binding.inputDigest))
  }
  private riskMeaning(fact: RiskFact): string { return digest([fact.scope, fact.status, fact.level, fact.signals, fact.source, fact.contentDigest, fact.conditionEvidence]) }
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
  private toolPolicy(context: BusinessContext, operation: AccessRequest['operationBinding']) {
    const policy = this.config().agents.find(agent => agent.agentId === context.scope.agentId)?.toolPolicies?.find(item => item.serverId === operation?.serverId)
    return policy && operation ? { policy, rules: policy.rules.filter(rule => (!rule.operationIds || rule.operationIds.includes(operation.operationId))
      && (!rule.kinds || rule.kinds.includes(operation.kind))) } : undefined
  }
  private requestedToolConditions(context: BusinessContext, operation: NonNullable<AccessRequest['operationBinding']>): ToolPolicyWhen | undefined {
    const rules = this.toolPolicy(context, operation)?.rules ?? []
    const result: ToolPolicyWhen = {}
    for (const key of ['riskLevels', 'scenarioIds', 'operationTags'] as const) {
      const values = [...new Set(rules.flatMap(rule => rule.when[key] ?? []))]
      if (values.length) Object.assign(result, { [key]: values })
    }
    return Object.keys(result).length ? result : undefined
  }
  private toolPolicyDecision(context: BusinessContext, operation: BusinessOperation, fact?: RiskFact): { effect: ToolPolicyEffect; reason: string } {
    const config = this.config(), selected = this.toolPolicy(context, operation)
    if (!selected) return { effect: 'allow', reason: '按基础工具权限执行' }
    const contentDigest = this.executionAuthorization.getStore()?.contentDigest
    const applicable = this.authorizationRiskFacts(context, operation).filter(value => value.source === config.riskAssessment?.endpoint && value.operationBinding)
    const candidates = [...applicable.filter(value => contentDigest && value.contentDigest === contentDigest),
      ...(fact && applicable.some(value => value.id === fact!.id) ? [fact] : []), ...applicable]
      .filter((value, index, values) => values.findIndex(item => item.id === value.id) === index)
    if (config.riskAssessment && !candidates.length && selected.rules.some(rule => Object.keys(rule.when).length)) {
      const state = this.executionAuthorization.getStore(); if (state) state.riskUnavailable = true
    }
    const rules = selected.rules.filter(rule => !Object.keys(rule.when).length || config.riskAssessment && candidates.length)
    if (rules.some(rule => !Object.keys(rule.when).length && rule.effect === 'deny')) return { effect: 'deny', reason: `服务 ${operation.serverId} 的工具规则禁止执行 ${operation.operationId}` }
    const matched = rules.filter(rule => {
      if (!Object.keys(rule.when).length) return true
      // 正文事实只覆盖其自身已提供的字段；其余操作条件仍使用同绑定的有效依据。
      const basis = candidates.find(value => (!rule.when.riskLevels || value.level !== undefined)
        && (!rule.when.scenarioIds || value.conditionEvidence?.scenarioIds !== undefined)
        && (!rule.when.operationTags || value.conditionEvidence?.operationTags !== undefined))
      if (!basis) { const state = this.executionAuthorization.getStore(); if (state) state.riskUnavailable = true; return false }
      return (!rule.when.riskLevels || rule.when.riskLevels.includes(basis.level!))
        && (!rule.when.scenarioIds || rule.when.scenarioIds.some(value => basis.conditionEvidence!.scenarioIds!.includes(value)))
        && (!rule.when.operationTags || rule.when.operationTags.some(value => basis.conditionEvidence!.operationTags!.includes(value)))
    })
    const effect = (['deny', 'confirm', 'allow'] as const).find(value => matched.some(rule => rule.effect === value)) ?? selected.policy.defaultEffect
    const reasons = [...new Set(matched.filter(rule => rule.effect === effect).flatMap(rule => [rule.when.riskLevels ? '第三方风险等级' : '', rule.when.scenarioIds ? '第三方业务场景' : '', rule.when.operationTags ? '第三方危险或敏感操作标签' : ''].filter(Boolean)))]
    return { effect, reason: `${operation.serverId} / ${operation.operationId} ${matched.length ? `命中${reasons.join('、') || '工具或动作'}条件` : '采用该服务的默认处理'}：${effect === 'deny' ? '禁止执行' : effect === 'confirm' ? '需要执行前确认' : '按基础权限允许'}` }
  }
  async reassess(context: BusinessContext, signal = noSignal(), action = 'write', args?: unknown, operationBinding?: AccessRequest['operationBinding'], contentDigest?: string): Promise<RiskFact> {
    this.acceptContext(context)
    const config = this.config()
    if (!config.riskAssessment) return error('risk_provider_unavailable', 503)
    let fact: RiskFact
    const requestedOperation = operationBinding ?? (contentDigest ? this.executionAuthorization.getStore()?.operation : undefined)
    try { fact = await new HttpRiskAssessmentProvider(config.riskAssessment).assess({ context, action,
      resources: context.scope.sessionId ? [{ kind: 'session', id: context.scope.sessionId }] : [{ kind: 'agent', id: context.scope.agentId }], validatedArgs: args, operationBinding,
      conditionRequest: requestedOperation ? this.requestedToolConditions(context, requestedOperation) ?? (config.accessAuthorization || contentDigest ? {} : undefined) : undefined }, signal) }
    catch { return error('risk_provider_unavailable', 503) }
    const execution = this.executionAuthorization.getStore(), active = execution?.id ? this.active.get(execution.id) : undefined
    if (contentDigest) fact = { ...fact, contentDigest }
    if (execution) { execution.riskUnavailable = false; execution.lastRiskStatus = fact.status; if (contentDigest) execution.contentDigest = contentDigest }
    if (execution && active) { execution.refreshingRisk = true; execution.grant = undefined; execution.pendingRiskAuthorization = true }
    try { this.updateRisk(fact) } finally {
      if (execution) execution.refreshingRisk = false
      if (active) { active.contentDigest = execution?.contentDigest; active.authorizationRiskDigest = digest(this.authorizationRiskFacts(active.context, active.operation)) }
    }
    return fact
  }
  async inspect(context: BusinessContext, stage: 'input' | 'operation' | 'report', input: unknown, signal = noSignal(), action: string = 'write', operationBinding?: AccessRequest['operationBinding']): Promise<RiskFact | undefined> {
    this.acceptContext(context)
    if (this.isDevelopmentContext(context)) return
    if (['anonymous', 'none'].includes(context.identity?.evidence.method ?? '') && !this.isSharedContext(context)) return error('identity_source_changed', 401)
    const config = this.config()
    if (!config.riskAssessment) return
    const inspected = stage === 'report' ? reportInspectionInput(input) : input
    // 旧 detection 字段只保留配置兼容；风险、业务场景和敏感性全部由第三方判定。
    // 共享基础聊天没有外部用户凭据，不调用要求认证主体的风险提供方。
    if (stage === 'input' && this.isSharedContext(context)) return
    if (config.riskAssessment) {
      try { return await this.reassess(context, signal, stage === 'report' ? 'publish' : stage === 'input' ? 'input' : action, inspected, operationBinding, stage === 'report' && (!operationBinding || !!this.active.get(this.executionAuthorization.getStore()?.id ?? '')) ? digest(inspected) : undefined) }
      catch (cause) {
        if (signal.aborted) throw cause
        const execution = this.executionAuthorization.getStore(); if (execution) { execution.riskUnavailable = true; if (execution.id && this.active.has(execution.id)) { execution.pendingRiskAuthorization = true; execution.grant = undefined } }
        this.record('risk-assessment', 'unknown', context, operationBinding?.operationId, 'risk_provider_unavailable')
      }
    }
  }
  async revalidateIdentity(context: BusinessContext, signal = noSignal()): Promise<void> {
    if (!this.enabled()) return error('business_disabled', 503)
    if (!this.available) return error('authorization_unavailable', 503)
    this.acceptContext(context)
    const config = this.config()
    if (this.isSharedContext(context)) { this.assert(context, 'agent:access', [{ kind: 'agent', id: context.scope.agentId }]); return }
    if (!config.authentication || !config.identityTrust || !context.identity) return error('identity_unavailable', 503)
    if (context.identity.evidence.issuer !== new URL(config.authentication.endpoint).origin) return error('identity_source_changed', 401)
    const trust = await new HttpIdentityTrustProvider(config.identityTrust).resolve(context.identity.evidence, signal)
    if (trust.kind !== 'trusted' || trust.subject.id !== context.subject.id || trust.subject.identitySource !== context.subject.identitySource) {
      return error(trust.kind === 'unknown' ? 'identity_unavailable' : 'identity_invalid', trust.kind === 'unknown' ? 503 : 401)
    }
  }
  private cancelRestricted(): void {
    const owner = this.executionAuthorization.getStore()
    for (const value of this.active.values()) {
      this.executionAuthorization.run({ external: value.authorizationSource === 'third-party', riskUnavailable: !value.conditionFact, contentDigest: value.contentDigest }, () => {
        try {
          this.assert(value.context, value.operation.kind, value.operation.resources, value.operation.args, value.operation); this.operationRule(value.context, value.operation)
          if (value.authorizationSource !== 'third-party') {
            const fact = value.conditionFact && (this.effectiveRiskFacts().find(fact => fact.id === value.conditionFact!.id) ?? value.conditionFact)
            const decision = this.toolPolicyDecision(value.context, value.operation, fact)
            if (decision.effect === 'deny' || decision.effect === 'confirm' && (!value.confirmed || value.policyVersion !== digest(this.config()))) throw new Error('工具权限条件已变化')
          }
          if (value.policyVersion !== digest(this.config())) throw new Error('访问策略配置已变化')
          if (!(owner?.refreshingRisk && this.active.get(owner.id!) === value) && value.authorizationSource === 'third-party' && value.authorizationRiskDigest !== digest(this.authorizationRiskFacts(value.context, value.operation))) throw new Error('外部决策的风险依据已变化')
        } catch { value.controller.abort(new BusinessControlError('permission_revoked', '当前操作许可已撤回')) }
      })
    }
  }
  private confirmationBinding(context: BusinessContext, operation: BusinessOperation): string {
    return digest([context.subject, { ...context.scope, serverId: operation.serverId }, context.sourceDigest, operation])
  }
  createConfirmation(context: BusinessContext, operation: BusinessOperation): { id: string; expiresAt: string } {
    this.assert(context, operation.kind, operation.resources, operation.args, operation); this.operationRule(context, operation)
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
  setConfirmationHandler(handler?: (context: BusinessContext, operation: BusinessOperation, signal: AbortSignal, reason?: string) => Promise<void>, synchronize?: (signal: AbortSignal) => Promise<void>): void {
    this.confirmationHandler = handler
    this.confirmationSynchronizer = handler ? synchronize : undefined
  }
  async execute<T>(operation: BusinessOperation, dispatch: (signal: AbortSignal) => Promise<T> | T, signal = noSignal()): Promise<T> {
    const context = currentBusinessContext()
    if (this.isManagement(context) || (!this.enabled() && !context)) return dispatch(signal)
    if (!this.enabled()) return error('business_disabled', 503)
    if (!context) return error('business_context_missing')
    const scoped = { ...context, scope: { ...context.scope, serverId: operation.serverId } }
    if (this.isDevelopmentContext(scoped)) {
      signal.throwIfAborted()
      this.assert(scoped, operation.kind, operation.resources, operation.args)
      return dispatch(signal)
    }
    return this.executionAuthorization.run({ external: !!this.config().accessAuthorization, riskUnavailable: false },
      () => this.executeAuthorized(scoped, operation, dispatch, signal))
  }
  private async executeAuthorized<T>(scoped: BusinessContext, operation: BusinessOperation,
    dispatch: (signal: AbortSignal) => Promise<T> | T, signal: AbortSignal): Promise<T> {
    const execution = this.executionAuthorization.getStore()!
    const operationBinding: AccessRequest['operationBinding'] = { serverId: operation.serverId, operationId: operation.operationId,
      target: operation.target, method: operation.method, kind: operation.kind }
    const controller = new AbortController(), executionSignal = AbortSignal.any([signal, controller.signal]), id = randomUUID()
    const configVersion = digest(this.config()), operationDigest = digest(operation)
    execution.id = id; execution.operation = operation
    let dispatched = false, confirmed = false, receipt: AuthorizationReceipt | undefined, expiry: ReturnType<typeof setTimeout> | undefined
    try {
      executionSignal.throwIfAborted()
      this.assertBase(scoped, operation.kind, operation.resources, operation)
      this.operationRule(scoped, operation, false)
      await this.revalidateIdentity(scoped, executionSignal)
      let conditionFact = await this.inspect(scoped, operation.kind === 'publish' ? 'report' : 'operation', operation.args, executionSignal, operation.kind, operationBinding)
      if (operationDigest !== digest(operation) || configVersion !== digest(this.config())) return error('authorization_changed', 403, '评估等待期间操作或策略已变化，请重新请求')
      const decide = async (): Promise<{ effect: ToolPolicyEffect; reason: string }> => {
        const config = this.config()
        if (config.accessAuthorization) {
          try {
            const facts = this.authorizationRiskFacts(scoped, operation), riskDigest = digest(facts)
            const grant = await new HttpAccessAuthorizationProvider(config.accessAuthorization).decide({ context: scoped, operation,
              risk: { enabled: !!config.riskAssessment, status: !config.riskAssessment ? 'disabled' : execution.riskUnavailable ? 'unavailable'
                : !facts.length ? 'unavailable' : (execution.lastRiskStatus ?? conditionFact?.status) === 'assessed' ? 'assessed' : 'unknown', facts: config.riskAssessment ? facts : [] } }, executionSignal)
            if (riskDigest !== digest(this.authorizationRiskFacts(scoped, operation)) || configVersion !== digest(this.config()) || operationDigest !== digest(operation)) return error('authorization_changed', 403, '外部决策等待期间的风险、策略或操作已变化，请重新请求')
            execution.external = true; execution.pendingRiskAuthorization = false; execution.grant = grant; execution.configVersion = configVersion; execution.operationDigest = operationDigest; execution.riskDigest = riskDigest
            let provider: string | undefined
            try { provider = new URL(config.accessAuthorization.endpoint).origin } catch { /* 无效地址走手动兜底。 */ }
            receipt = { source: 'third-party', decision: grant.decision, policyVersion: grant.policyVersion,
              reason: grant.reason, expiresAt: grant.expiresAt, ...(provider ? { provider } : {}) }
            return { effect: grant.decision, reason: grant.reason }
          } catch (cause) {
            if (executionSignal.aborted || cause instanceof BusinessControlError && cause.code === 'authorization_changed') throw cause
            execution.external = false; execution.pendingRiskAuthorization = false; execution.grant = undefined
            receipt = { source: 'manual-fallback', decision: 'deny', policyVersion: configVersion,
              reason: '访问控制服务未提供有效决定，按手动兜底策略执行' }
          }
        } else {
          execution.external = false; execution.pendingRiskAuthorization = false; execution.grant = undefined
          receipt = { source: execution.riskUnavailable ? 'manual-fallback' : 'manual', decision: 'deny', policyVersion: configVersion,
            reason: execution.riskUnavailable ? '风险服务未提供有效结果，按手动策略执行并暂停无证据条件' : '未配置访问控制服务，按手动策略执行' }
        }
        this.assertBase(scoped, operation.kind, operation.resources, operation)
        this.operationRule(scoped, operation, false)
        const local = this.toolPolicyDecision(scoped, operation, conditionFact)
        receipt.decision = local.effect
        if (execution.riskUnavailable && receipt.source === 'manual') receipt.source = 'manual-fallback'
        receipt.reason += `；${local.reason}`
        return local
      }
      execution.refresh = async () => {
        if (expiry) { clearTimeout(expiry); expiry = undefined }
        executionSignal.throwIfAborted()
        let next = await decide()
        if (next.effect === 'deny') return error('tool_policy_denied', 403, next.reason)
        if (next.effect === 'confirm') {
          if (!this.confirmationHandler) return error('confirmation_required', 403, next.reason)
          const previous = { source: receipt!.source, policyVersion: receipt!.policyVersion }
          await this.confirmationSynchronizer?.(executionSignal)
          const version = this.state.restrictionVersion
          await this.confirmationHandler(structuredClone(scoped), structuredClone(operation), executionSignal, next.reason)
          executionSignal.throwIfAborted(); execution.grant = undefined
          await this.revalidateIdentity(scoped, executionSignal)
          next = await decide()
          if (next.effect === 'deny') return error('tool_policy_denied', 403, next.reason)
          if (version !== this.state.restrictionVersion || previous.source !== receipt!.source || previous.policyVersion !== receipt!.policyVersion) return error('confirmation_invalid')
          confirmed = true
        }
        this.assertOperation(scoped, operation)
        const active = this.active.get(id)
        if (active) { active.authorizationSource = receipt?.source; active.authorizationRiskDigest = execution.riskDigest; active.contentDigest = execution.contentDigest; active.confirmed = confirmed }
        if (execution.grant) expiry = setTimeout(() => controller.abort(new BusinessControlError('authorization_expired', '本次访问决定已过期')),
          Math.min(0x7fffffff, Math.max(1, Math.min(Date.parse(execution.grant.expiresAt), ...this.authorizationRiskFacts(scoped, operation).map(fact => Date.parse(fact.expiresAt))) - Date.now())))
      }
      let policyDecision = await decide()
      executionSignal.throwIfAborted()
      if (policyDecision.effect === 'deny') return error('tool_policy_denied', 403, policyDecision.reason)
      const initialRule = this.config().operations?.find(value => value.serverId === operation.serverId && value.operationId === operation.operationId)
      if ((!execution.external && initialRule?.confirmation || policyDecision.effect === 'confirm') && this.confirmationHandler) {
        await this.confirmationSynchronizer?.(executionSignal)
        executionSignal.throwIfAborted()
        if (operationDigest !== digest(operation) || configVersion !== digest(this.config())) return error('confirmation_invalid')
        this.assertOperation(scoped, operation)
        const confirmationVersion = this.state.restrictionVersion, previous = { source: receipt!.source, policyVersion: receipt!.policyVersion }
        await this.confirmationHandler(structuredClone(scoped), structuredClone(operation), executionSignal,
          policyDecision.effect === 'confirm' ? policyDecision.reason : `操作 ${operation.operationId} 的基础执行设置要求确认，请核对本次目标与参数`)
        executionSignal.throwIfAborted()
        execution.grant = undefined
        await this.revalidateIdentity(scoped, executionSignal)
        if (this.config().riskAssessment) conditionFact = await this.inspect(scoped, operation.kind === 'publish' ? 'report' : 'operation', operation.args, executionSignal, operation.kind, operationBinding)
        if (confirmationVersion !== this.state.restrictionVersion || configVersion !== digest(this.config()) || operationDigest !== digest(operation)) return error('confirmation_invalid')
        policyDecision = await decide()
        if (policyDecision.effect === 'deny') return error('tool_policy_denied', 403, policyDecision.reason)
        if (confirmationVersion !== this.state.restrictionVersion || operationDigest !== digest(operation)
          || previous.source !== receipt!.source || previous.policyVersion !== receipt!.policyVersion) return error('confirmation_invalid')
        confirmed = true
      }
      executionSignal.throwIfAborted()
      if (configVersion !== digest(this.config()) || operationDigest !== digest(operation)) return error('authorization_changed', 403, '访问策略或实际操作在等待期间已变化，请重新请求')
      this.assert(scoped, operation.kind, operation.resources, operation.args, operation); this.operationRule(scoped, operation)
      if (!execution.external) policyDecision = this.toolPolicyDecision(scoped, operation, conditionFact)
      if (policyDecision.effect === 'deny') return error('tool_policy_denied', 403, policyDecision.reason)
      const rule = this.config().operations?.find(value => value.serverId === operation.serverId && value.operationId === operation.operationId)
      if ((!execution.external && rule?.confirmation || policyDecision.effect === 'confirm') && !this.confirmationHandler) {
        const binding = this.confirmationBinding(scoped, operation)
        const confirmation = [...this.confirmations.values()].find(value => value.confirmed && value.binding === binding
          && value.version === this.state.restrictionVersion && value.expiresAt > Date.now())
        if (!confirmation) return error('confirmation_required', 403, policyDecision.effect === 'confirm' ? policyDecision.reason : `操作 ${operation.operationId} 要求执行前确认，请先核对本次目标与参数`)
        this.confirmations.delete(confirmation.id); confirmed = true
      }
      if (execution.grant) expiry = setTimeout(() => controller.abort(new BusinessControlError('authorization_expired', '本次访问决定已过期')),
        Math.min(0x7fffffff, Math.max(1, Math.min(Date.parse(execution.grant.expiresAt), ...this.authorizationRiskFacts(scoped, operation).map(fact => Date.parse(fact.expiresAt))) - Date.now())))
      this.active.set(id, { context: scoped, operation, controller, conditionFact, policyVersion: configVersion, confirmed, authorizationSource: receipt?.source, authorizationRiskDigest: execution.riskDigest })
      dispatched = true
      const result = await dispatch(executionSignal)
      this.record(operation.kind, 'completed', scoped, operation.operationId,
        executionSignal.aborted ? 'completed_after_cancel_request' : undefined, receipt)
      return result
    } catch (cause) {
      if (!dispatched && receipt && receipt.source !== 'third-party') { receipt.decision = 'deny'; receipt.reason = cause instanceof Error ? cause.message : '手动兜底未允许本次操作' }
      this.record(operation.kind, dispatched ? 'unknown' : executionSignal.aborted ? 'cancelled' : 'denied', scoped, operation.operationId,
        cause instanceof BusinessControlError ? cause.code : dispatched ? 'upstream_result_unknown' : 'control_failed', receipt)
      throw cause
    } finally { if (expiry) clearTimeout(expiry); this.active.delete(id) }
  }
  async refreshOperationAuthorization(context: BusinessContext, operation: BusinessOperation): Promise<void> {
    const execution = this.executionAuthorization.getStore()
    if (execution?.pendingRiskAuthorization && execution.refresh) await execution.refresh()
    this.assertOperation(context, operation)
  }
  // 同时标记 Runtime 副本职责；开发模式保留会话单写入方，但不检查租约。
  requireSnapshot(instanceId: string): void { this.requiredSnapshots.add(instanceId) }
  currentRestrictionVersion(): number { return this.state.restrictionVersion }
  hasAcknowledgedSnapshot(instanceId: string): boolean {
    const ack = this.acknowledgements.get(instanceId)
    return !!ack && ack.restrictionVersion === this.state.restrictionVersion && Date.now() - Date.parse(ack.at) < 2000
  }
  hasCurrentSnapshot(instanceId: string, version: number): boolean {
    const lease = this.leases.get(instanceId)
    return !!lease && Number.isSafeInteger(version) && lease.snapshot.restrictionVersion >= version
      && performance.now() - lease.receivedAt < lease.snapshot.leaseMs
  }
  recordSynchronization(binding: InstanceBinding, lastError?: string): void {
    const previous = this.synchronizations.get(binding.instanceId)
    this.synchronizations.set(binding.instanceId, { lastSuccessAt: lastError ? previous?.lastSuccessAt : iso(), lastAttemptAt: iso(), ...(lastError ? { lastError } : {}) })
  }
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
  status(): { enabled: boolean; restrictionVersion: number; instances: Array<InstanceBinding & { synchronization?: { lastSuccessAt?: string; lastAttemptAt: string; lastError?: string }; applied: boolean; acknowledgement?: { restrictionVersion: number; leaseId: string; at: string } }>; restrictions: Restriction[]; riskFacts: RiskFact[]; events: ControlEvent[] } {
    return { enabled: this.enabled(), restrictionVersion: this.state.restrictionVersion,
      instances: Object.values(this.state.instances).map(value => {
        const ack = this.acknowledgements.get(value.instanceId)
        return { ...value, synchronization: this.synchronizations.get(value.instanceId), acknowledgement: ack, applied: !!ack && ack.restrictionVersion === this.state.restrictionVersion && Date.now() - Date.parse(ack.at) < 2000 }
      }), restrictions: structuredClone(Object.values(this.state.restrictions)),
      riskFacts: structuredClone(this.effectiveRiskFacts()), events: structuredClone(this.state.events) }
  }
}
