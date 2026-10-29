import { createHash, randomUUID } from 'node:crypto'
import type {
  AccessRequest, AuthenticationInput, UserAuthenticationPlugin, AuthenticationResult, IdentityEvidence,
  UserIdentityTrustPlugin, ProviderConfig, RiskAssessmentPlugin, RiskFact, TrustResult,
  AccessAuthorizationPlugin, AuthorizationRequest, ExternalAccessDecision,
} from './contracts.js'

/** 控制接口不经过业务执行器，避免访问决策递归请求自身。 */
async function post(config: ProviderConfig, body: unknown, signal: AbortSignal): Promise<any> {
  const url = new URL(config.endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('控制提供方必须使用 HTTP 或 HTTPS')
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 1500)]), redirect: 'error',
  })
  if (!response.ok) throw new Error('控制提供方不可用')
  return response.json()
}
function future(value: unknown): value is string { return typeof value === 'string' && Date.parse(value) > Date.now() }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function conditionEvidence(value: unknown): NonNullable<RiskFact['conditionEvidence']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['scenarioIds', 'operationTags'].includes(key))) throw new Error('风险提供方返回无效条件证据')
  const evidence: NonNullable<RiskFact['conditionEvidence']> = {}
  for (const key of ['scenarioIds', 'operationTags'] as const) {
    if (!Object.hasOwn(value, key)) continue
    const values = (value as Record<string, unknown>)[key]
    if (!Array.isArray(values) || values.length > 64 || values.some(item => typeof item !== 'string'
      || !item.length || item.length > 256 || item.trim() !== item)) throw new Error('风险提供方返回无效条件证据')
    evidence[key] = [...values]
  }
  return evidence
}

/** 接入用户凭据校验；业务 Agent 的认证由 HMAC 控制通道完成。 */
export class HttpAuthenticationProvider implements UserAuthenticationPlugin {
  constructor(private config: ProviderConfig) {}
  async authenticate(input: AuthenticationInput, signal: AbortSignal): Promise<AuthenticationResult> {
    const authorization = input.headers.authorization ?? input.headers.Authorization
    if (!authorization) return { kind: 'missing', reason: 'credential_missing' }
    const match = /^Bearer ([^\s]+)$/i.exec(authorization)
    if (!match) return { kind: 'unsupported', reason: 'credential_unsupported' }
    try {
      const result = await post(this.config, { credential: match[1] }, signal)
      if (!result.authenticated || !nonempty(result.subjectId) || !nonempty(result.credentialId) || !future(result.expiresAt)) {
        return { kind: 'invalid', reason: 'credential_invalid' }
      }
      return { kind: 'authenticated', evidence: {
        issuer: new URL(this.config.endpoint).origin, externalSubject: result.subjectId, method: 'bearer',
        verifiedAt: new Date().toISOString(), expiresAt: result.expiresAt, credentialRef: result.credentialId,
      } }
    } catch { return { kind: 'unavailable', reason: 'authentication_unavailable' } }
  }
}

export class HttpIdentityTrustProvider implements UserIdentityTrustPlugin {
  constructor(private config: ProviderConfig) {}
  async resolve(evidence: IdentityEvidence, signal: AbortSignal): Promise<TrustResult> {
    if (!future(evidence.expiresAt)) return { kind: 'untrusted', reason: 'credential_expired' }
    try {
      const result = await post(this.config, { subjectId: evidence.externalSubject, credentialId: evidence.credentialRef }, signal)
      if (!result.valid || result.subjectId !== evidence.externalSubject || !future(result.expiresAt)) {
        return { kind: 'untrusted', reason: 'identity_invalid' }
      }
      // 来源与外部主体共同构成身份；提供方返回的稳定 ID 不按显示名或邮箱合并。
      return { kind: 'trusted', subject: { id: result.subjectId, kind: 'human', identitySource: evidence.issuer },
        trustVersion: String(result.version ?? '1'), expiresAt: new Date(Math.min(Date.parse(evidence.expiresAt), Date.parse(result.expiresAt))).toISOString() }
    } catch { return { kind: 'unknown', reason: 'identity_unavailable' } }
  }
}

export class HttpRiskAssessmentProvider implements RiskAssessmentPlugin {
  constructor(private config: ProviderConfig) {}
  async assess(request: AccessRequest, signal: AbortSignal): Promise<RiskFact> {
    const conditional = request.conditionRequest !== undefined
    const operation = request.operationBinding ? { serverId: request.operationBinding.serverId, operationId: request.operationBinding.operationId,
      target: request.operationBinding.target, method: request.operationBinding.method, kind: request.operationBinding.kind } : undefined
    // 在等待第三方之前固定本次操作和输入；不接受响应中的绑定，也不保存目标 URL。
    const binding = conditional && request.operationBinding ? {
      serverId: request.operationBinding.serverId, operationId: request.operationBinding.operationId,
      method: request.operationBinding.method, kind: request.operationBinding.kind,
      targetDigest: createHash('sha256').update(JSON.stringify(request.operationBinding.target)).digest('hex'),
      inputDigest: createHash('sha256').update(JSON.stringify(request.validatedArgs ?? null)).digest('hex'),
    } : undefined
    const boundScope = binding ? { ...request.context.scope, subjectId: request.context.subject.id, serverId: binding.serverId } : undefined
    const requestedScope = boundScope ?? request.context.scope, subjectId = request.context.subject.id
    const result = await post(this.config, {
      testRunId: this.config.testRunId, subjectId,
      sessionId: requestedScope.sessionId, operation: request.action,
      scope: requestedScope, sourceDigest: request.context.sourceDigest, operationBinding: operation,
      phase: request.action === 'input' ? 'input' : request.action === 'publish' ? 'report' : 'execute',
      input: request.validatedArgs,
      ...(conditional ? { conditionRequest: request.conditionRequest } : {}),
    }, signal)
    if (!Number.isSafeInteger(result.version) || result.version < 0 || !future(result.expiresAt)
      || result.scope?.subjectId !== subjectId
      || ((binding ? result.scope?.sessionId !== undefined : result.scope?.sessionId) && result.scope.sessionId !== requestedScope.sessionId)
      || ['workspaceId', 'agentId', 'instanceId', 'runtimeGeneration', 'serverId'].some(key =>
        result.scope?.[key] !== undefined && result.scope[key] !== requestedScope[key as keyof typeof requestedScope])
      || !['low', 'high', 'unknown'].includes(result.level)
      || !Array.isArray(result.constraints?.deniedOperations)
      || result.constraints.deniedOperations.some((value: unknown) => !nonempty(value))) {
      throw new Error('风险提供方返回无效事实')
    }
    const scope = boundScope ?? { workspaceId: request.context.scope.workspaceId, agentId: request.context.scope.agentId,
      subjectId: result.scope.subjectId, instanceId: request.context.scope.instanceId,
      runtimeGeneration: request.context.scope.runtimeGeneration,
      ...(result.scope.sessionId ? { sessionId: result.scope.sessionId } : {}),
      ...(result.scope.serverId ? { serverId: result.scope.serverId } : {}) }
    const source = this.config.endpoint
    return {
      id: `risk-${createHash('sha256').update(JSON.stringify(binding ? [source, scope, binding] : [source, scope])).digest('hex').slice(0, 24)}`,
      version: result.version, scope, source, status: result.level === 'unknown' ? 'unknown' : 'assessed',
      level: result.level,
      signals: result.constraints.deniedOperations.map((value: string) => ({ code: 'deny-operation', value,
        reason: Array.isArray(result.reasons) ? result.reasons.filter(nonempty).join('; ').slice(0, 240) : 'risk_constraint' })),
      observedAt: new Date().toISOString(), expiresAt: result.expiresAt,
      ...(conditional && result.conditionEvidence !== undefined ? { conditionEvidence: conditionEvidence(result.conditionEvidence) } : {}),
      ...(binding ? { operationBinding: binding } : {}),
    }
  }
}

/** 每个实际操作单独决策；响应只能引用本次平台生成的绑定。 */
export class HttpAccessAuthorizationProvider implements AccessAuthorizationPlugin {
  constructor(private config: ProviderConfig) {}
  async decide(request: AuthorizationRequest, signal: AbortSignal): Promise<ExternalAccessDecision> {
    const { context } = request
    const scope = { ...context.scope, subjectId: context.subject.id, serverId: request.operation.serverId }
    const operation = { serverId: request.operation.serverId, operationId: request.operation.operationId,
      kind: request.operation.kind, target: request.operation.target, method: request.operation.method,
      ...(request.operation.schemaDigest !== undefined ? { schemaDigest: request.operation.schemaDigest } : {}) }
    const input = request.operation.args ?? null, resources = request.operation.resources ?? []
    const requestId = randomUUID()
    const binding = createHash('sha256').update(JSON.stringify([context.subject, scope, context.sourceDigest, operation, input, resources])).digest('hex')
    // 跨提供方只传公开来源；内部事实与其绑定摘要继续使用原值。
    const risk = { ...request.risk, facts: request.risk.facts.map(fact => {
      let source = '第三方风险评估'
      try { const url = new URL(fact.source); if (['http:', 'https:'].includes(url.protocol)) source = url.origin } catch { /* 不转发任意来源标识中的私密内容。 */ }
      return { ...fact, source }
    }) }
    const result = await post(this.config, { protocolVersion: 1, requestId, binding, scope, sourceDigest: context.sourceDigest,
      operation, input, resources, risk }, signal)
    if (!result || result.protocolVersion !== 1 || result.requestId !== requestId || result.binding !== binding
      || !['allow', 'deny', 'confirm'].includes(result.decision) || !nonempty(result.policyVersion) || result.policyVersion.length > 256 || result.policyVersion.trim() !== result.policyVersion
      || !nonempty(result.reason) || !result.reason.trim() || result.reason.length > 1000 || !future(result.expiresAt)
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(result.expiresAt)) {
      throw new Error('访问控制提供方返回无效决定')
    }
    return { protocolVersion: 1, requestId, binding, decision: result.decision, policyVersion: result.policyVersion,
      reason: result.reason, expiresAt: result.expiresAt }
  }
}
