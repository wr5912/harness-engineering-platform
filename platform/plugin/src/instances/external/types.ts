/** 接入实例的公共合同；运行来源与 DSH Harness 来源分别表达。 */
export type ExternalFramework = 'dsh' | 'agentscope' | 'opencode'
export type ExternalOperation = 'session:create' | 'session:prompt' | 'session:read' | 'session:events'
export interface ExternalAgent { id: string; name: string; system: string; owner: string; description?: string; linkedAgentId?: string }
export interface ExternalVerification {
  ok: boolean; bindingDigest: string; adapterVersion: string; observedAt: string
  observedVersion?: string; checks: Array<{ name: string; ok: boolean; detail: string }>
}
export interface ExternalInstance {
  id: string; agentId: string; name: string; framework: ExternalFramework; endpoint: string
  selector?: string; declaredVersion?: string; credentialRef?: string; connectionUserId?: string; description?: string; location?: string; instanceOwner?: string
  managementMode: 'externally-managed'; usageMode: 'shared'; state: 'draft' | 'registered' | 'removed'
  revision: number; bindingDigest: string; entryState: 'pending' | 'enabled' | 'disabled'
  verification?: ExternalVerification; activation?: { bindingDigest: string; policyDigest: string; activatedAt: string }
  createdAt: string; updatedAt: string
}
export interface ExternalPolicy { instanceId: string; subjects: string[]; actions: string[]; enabled: boolean }
export interface ExternalRecord {
  id: string; at: string; instanceId: string; requestId?: string; subjectId?: string; operation: string
  stage: 'management' | 'not_dispatched' | 'dispatching' | 'responded' | 'accepted' | 'unknown' | 'connection_closed'
  result: 'allow' | 'deny' | 'error' | 'unknown'; reason?: string; bindingDigest?: string; policyDigest?: string
  sessionId?: string; upstreamSessionId?: string; status?: number
}
export interface ExternalList { revision: string; workspaceId: string; agents: ExternalAgent[]; instances: ExternalInstance[]; observedAt: string }
export interface ExternalDetail { revision: string; agent: ExternalAgent; instance: ExternalInstance; policy: ExternalPolicy; records: ExternalRecord[] }
export interface ExternalInvocation { id: string; operation: ExternalOperation; sessionId?: string; input?: string; requestId: string }
export interface ExternalInvocationResult {
  requestId: string; stage: 'responded' | 'accepted' | 'unknown'; sessionId?: string; upstreamSessionId?: string
  value?: unknown; note?: string
}
/** 只读发现不登记、不创建远端工作区或会话；认证材料仅由本地引用读取。 */
export interface ExternalDiscoveryRequest {
  id?: string; framework: ExternalFramework; endpoint: string; credentialRef?: string; connectionUserId?: string
}
export interface ExternalDiscoveryTarget {
  id: string; name: string; description?: string; path?: string; isDefault?: boolean; unavailableReason?: string
}
export interface ExternalDiscoveryChoices {
  status: 'ready' | 'empty' | 'unauthorized' | 'forbidden' | 'unsupported' | 'failed'
  items: ExternalDiscoveryTarget[]; message?: string
}
export interface ExternalDiscoveryResult {
  framework: ExternalFramework; endpoint: string; observedAt: string
  status: 'selected' | 'selection_required' | 'unavailable'; selector?: string; connectionUserId?: string; message?: string
  workspaces?: ExternalDiscoveryChoices; presets?: ExternalDiscoveryChoices; agents?: ExternalDiscoveryChoices
}
export interface ExternalConversationSend { id: string; requestId: string; sessionId?: string; input: string }
export interface ExternalConversationStatus { id: string; requestId: string }
export interface ExternalConversationResult {
  requestId: string; sessionId?: string; status: 'running' | 'waiting' | 'completed' | 'failed' | 'unknown'
  messages: Array<{ id: string; role: 'assistant'; text: string }>
  tools: Array<{ id: string; name: string; status: 'running' | 'completed' | 'failed' }>
  note?: string; retryAfterMs?: number
}
