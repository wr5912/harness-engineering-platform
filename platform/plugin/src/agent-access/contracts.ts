/** 实例机器访问与现有 DSH 控制签名分属不同合同。 */
export interface ResourceTool {
  name: string
  scope: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  description?: string
  inputSchema?: Record<string, unknown>
  objectField?: string
}
export interface AccessResource {
  id: string
  audience: string
  endpoint: string
  credentialFile?: string
  tools: ResourceTool[]
}
export interface ResourceGrant {
  instanceId: string
  resourceId: string
  scopes: string[]
  objects?: string[]
  enabled: boolean
  version: number
}
export interface AgentAccessConfiguration {
  schemaVersion: 1
  issuer: string
  resources: AccessResource[]
  grants: ResourceGrant[]
}
export interface RegisteredMachine {
  id: string
  state: string
  bindingDigest?: string
  verification?: { ok: boolean; bindingDigest?: string; observedAt?: string }
}
export interface CredentialMetadata {
  id: string
  clientId: string
  instanceId: string
  status: 'active' | 'revoked'
  createdAt: string
  expiresAt: string
  retireAt?: string
}
export interface AccessEvent {
  requestId: string
  at: string
  instanceId?: string
  credentialId?: string
  resourceId?: string
  operation?: string
  jti?: string
  grantVersion?: number
  stage: 'authenticated' | 'issued' | 'denied' | 'prepared' | 'dispatched' | 'response' | 'unknown' | 'management'
  reason?: string
  httpStatus?: number
}
export interface AgentAccessOptions {
  resolveInstance?: (id: string) => RegisteredMachine | undefined
  now?: () => number
  /** 在具体操作执行前核对风险/授权，拒绝通过抛出 AccessError 表达。 */
  authorize?: (input: { instanceId: string; resource: AccessResource; tool: ResourceTool; args: Record<string, unknown> }, signal: AbortSignal) => Promise<void>
  fetch?: typeof fetch
}
export class AccessError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message) }
}
