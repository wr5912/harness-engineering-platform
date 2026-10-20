import { createHash } from 'node:crypto'
import type {
  AccessRequest, AuthenticationInput, UserAuthenticationPlugin, AuthenticationResult, IdentityEvidence,
  UserIdentityTrustPlugin, ProviderConfig, RiskAssessmentPlugin, RiskFact, TrustResult,
} from './contracts.js'

/** 外部 HTTP 只承载认证、信任与风险事实，不经过业务执行器以免递归。 */
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
    const result = await post(this.config, {
      testRunId: this.config.testRunId, subjectId: request.context.subject.id,
      sessionId: request.context.scope.sessionId, operation: request.action,
      scope: request.context.scope, sourceDigest: request.context.sourceDigest, operationBinding: request.operationBinding,
      phase: request.action === 'input' ? 'input' : request.action === 'publish' ? 'report' : 'execute',
      input: request.validatedArgs,
    }, signal)
    if (!Number.isSafeInteger(result.version) || result.version < 0 || !future(result.expiresAt)
      || result.scope?.subjectId !== request.context.subject.id
      || (result.scope?.sessionId && result.scope.sessionId !== request.context.scope.sessionId)
      || ['workspaceId', 'agentId', 'instanceId', 'runtimeGeneration', 'serverId'].some(key =>
        result.scope?.[key] !== undefined && result.scope[key] !== request.context.scope[key as keyof typeof request.context.scope])
      || !['low', 'high', 'unknown'].includes(result.level)
      || !Array.isArray(result.constraints?.deniedOperations)
      || result.constraints.deniedOperations.some((value: unknown) => !nonempty(value))) {
      throw new Error('风险提供方返回无效事实')
    }
    const scope = { workspaceId: request.context.scope.workspaceId, agentId: request.context.scope.agentId,
      subjectId: result.scope.subjectId, instanceId: request.context.scope.instanceId,
      runtimeGeneration: request.context.scope.runtimeGeneration,
      ...(result.scope.sessionId ? { sessionId: result.scope.sessionId } : {}),
      ...(result.scope.serverId ? { serverId: result.scope.serverId } : {}) }
    const source = this.config.endpoint
    return {
      id: `risk-${createHash('sha256').update(JSON.stringify([source, scope])).digest('hex').slice(0, 24)}`,
      version: result.version, scope, source, status: result.level === 'unknown' ? 'unknown' : 'assessed',
      level: result.level,
      signals: result.constraints.deniedOperations.map((value: string) => ({ code: 'deny-operation', value,
        reason: Array.isArray(result.reasons) ? result.reasons.filter(nonempty).join('; ').slice(0, 240) : 'risk_constraint' })),
      observedAt: new Date().toISOString(), expiresAt: result.expiresAt,
    }
  }
}
