/** 业务控制的唯一公共合同；管理端与 Runtime 均引用本模块。 */
export type PluginKind = 'authentication' | 'identity-trust' | 'risk-assessment' | 'access-authorization'
export interface ControlPluginManifest {
  name: string; version: string; contractVersion: 1; kinds: readonly PluginKind[]
  dshCompatibility: string; capabilities: readonly string[]
}
export interface Subject { id: string; kind: 'human' | 'service'; identitySource: string }
export interface ControlScope {
  workspaceId: string; agentId: string; subjectId?: string; instanceId?: string
  runtimeGeneration?: string; sessionId?: string; serverId?: string
}
export interface BusinessContext {
  requestId: string; subject: Subject; scope: ControlScope; sourceDigest: string; invocationId?: string
  /** 来自已验证凭据；不含凭据值。 */
  identity?: { evidence: IdentityEvidence; expiresAt: string }
}
export interface ResourceRef { kind: string; id: string }
export interface AccessRequest {
  context: BusinessContext; action: string; resources: readonly ResourceRef[]; validatedArgs?: unknown
  /** 服务端已解析并检查的真实操作；参数正文只由 validatedArgs 承载一次。 */
  operationBinding?: Pick<BusinessOperation, 'serverId' | 'operationId' | 'target' | 'method' | 'kind'>
}
export type AccessDecision =
  | { kind: 'allow'; policyVersion: string; restrictionVersion: number }
  | { kind: 'deny'; reason: string; policyVersion: string; restrictionVersion: number }
export interface UserIdentityEvidence {
  issuer: string; externalSubject: string; method: string; verifiedAt: string
  expiresAt: string; credentialRef?: string
}
/** 兼容既有用户接入调用；此证据不证明 Agent 可信。 */
export type IdentityEvidence = UserIdentityEvidence
export type AuthenticationResult = { kind: 'authenticated'; evidence: IdentityEvidence }
  | { kind: 'missing' | 'unsupported' | 'invalid' | 'unavailable'; reason: string }
export interface AuthenticationInput {
  transport: 'http' | 'websocket' | 'callback'; method: string; path: string
  headers: Readonly<Record<string, string | undefined>>
}
export interface UserAuthenticationPlugin {
  authenticate(input: AuthenticationInput, signal: AbortSignal): Promise<AuthenticationResult>
}
/** 兼容既有用户接入调用；Agent 使用独立的 HMAC 通道合同。 */
export type AuthenticationPlugin = UserAuthenticationPlugin
export type TrustResult = { kind: 'trusted'; subject: Subject; trustVersion: string; expiresAt: string }
  | { kind: 'untrusted' | 'unknown'; reason: string }
export interface UserIdentityTrustPlugin { resolve(evidence: UserIdentityEvidence, signal: AbortSignal): Promise<TrustResult> }
export type IdentityTrustPlugin = UserIdentityTrustPlugin
export interface AgentAuthenticationEvidence {
  method: 'hmac-sha256'; binding: InstanceBinding; verifiedAt: string; expiresAt: string
  source: 'signed-control-assertion'
}
export interface AgentInstanceStatus {
  instanceId: string; agentId?: string
  authentication: {
    method: 'hmac-sha256'; status: 'verified' | 'unknown' | 'expired' | 'disabled'
    verifiedAt?: string; expiresAt?: string; evidence?: 'signed-control-assertion'
  }
  /** 智能体身份下的可信来源、实例绑定与撤销状态；保留既有字段，不表示行为风险或综合信任评分。 */
  trust: {
    status: 'trusted' | 'unknown' | 'revoked' | 'mismatch' | 'expired'; reason: string
    sourceDigest?: string; runtimeGeneration?: string; restrictionVersion: number
  }
}
export interface AgentAuthenticationPlugin {
  verify(binding: InstanceBinding, evidence: AgentAuthenticationEvidence): AgentInstanceStatus['authentication']
}
export interface AgentIdentityTrustPlugin {
  evaluate(binding: InstanceBinding): AgentInstanceStatus['trust']
}
export interface RiskFact {
  id: string; version: number; scope: ControlScope; status: 'assessed' | 'unknown'
  level?: 'low' | 'high' | 'unknown'
  signals: readonly { code: string; value: string; reason: string }[]
  source: string; observedAt: string; expiresAt: string
  /** 内容检测只约束被检测的输入摘要，不把单次内容问题扩大为整个会话撤权。 */
  contentDigest?: string
}
export interface RiskAssessmentPlugin { assess(request: AccessRequest, signal: AbortSignal): Promise<RiskFact> }
export interface AccessAuthorizationPlugin { decide(request: AccessRequest): AccessDecision }
export type OperationKind = 'read' | 'write' | 'resource' | 'publish'
export interface BusinessOperation {
  serverId: string; operationId: string; kind: OperationKind; target: string; method: string
  args?: unknown; schemaDigest?: string; resources?: readonly ResourceRef[]
}
export interface ProviderConfig { endpoint: string; timeoutMs?: number; testRunId?: string }
export interface AgentAccessRule {
  agentId: string; enabled: boolean; subjects: string[]; actions: string[]
  serverIds?: string[]; sourceDigest?: string
  agentAuthentication?: { enabled: boolean; method: 'hmac-sha256' }
  /** 身份启用／撤销开关；沿用既有持久字段名，属于智能体身份配置。 */
  agentTrust?: { enabled: boolean }
}
export interface OperationRule {
  serverId: string; operationId: string; kind: OperationKind
  target: string; method: string; schemaDigest?: string; confirmation?: boolean; queryParameters?: string[]
}
export interface BusinessAccessConfig {
  schemaVersion: 1; enabled: boolean
  authentication?: ProviderConfig; identityTrust?: ProviderConfig
  riskAssessment?: ProviderConfig & { requiredKinds?: OperationKind[] }
  agents: AgentAccessRule[]; operations?: OperationRule[]
  detection?: { inputMarkers?: string[]; operationMarkers?: string[]; reportMarkers?: string[] }
  gateway?: Record<string, unknown>
  [key: string]: unknown
}
export interface AuthenticatedIdentity { subject: Subject; evidence: IdentityEvidence; expiresAt: string }
export interface InstanceBinding {
  workspaceId: string; agentId: string; instanceId: string; runtimeGeneration: string; sourceDigest: string
}
export interface SessionBinding extends InstanceBinding {
  sessionId: string; subjectId: string; subject: Subject; identity?: BusinessContext['identity']; createdAt: string; observedAt?: string
}
export interface SessionTrustFact {
  sessionId: string; subjectId: string; agentId: string; instanceId: string; identitySource: string
  verifiedAt?: string; expiresAt?: string; credentialExpiresAt?: string; observedAt: string
  state: 'evidence-held' | 'expired'
}
export interface Restriction {
  id: string; scope: ControlScope; deniedActions: string[]; reason: string; active: boolean
}
export interface ControlSnapshot {
  instanceId: string; runtimeGeneration: string; restrictionVersion: number; leaseId: string
  leaseMs: number; issuedAt: string; riskFacts: RiskFact[]; restrictions: Restriction[]
  agentStatus: AgentInstanceStatus
}
export interface ControlEvent {
  id: string; at: string; requestId?: string; subjectId?: string; sessionId?: string
  operationId?: string; action: string; restrictionVersion: number; reason?: string
  outcome: 'allowed' | 'denied' | 'completed' | 'cancelled' | 'unknown' | 'applied'
}
/** Runtime 为归属写者，协调器只保存受信观察索引；不包含凭据值和业务正文。 */
export interface ReplicaObservation {
  binding: InstanceBinding; sessions: SessionBinding[]; riskFacts: RiskFact[]; events: ControlEvent[]
}
