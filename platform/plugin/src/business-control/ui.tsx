import { useEffect, useRef, useState } from 'react'
import { SearchSelect } from '../components/search-select.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { GatewayWindow, GatewayWindows, type GatewayAssistantBridge } from './window.tsx'
import { CHANNEL, type PlatformNavigation, type PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { agentAccessActions, businessOperationMethods, retiredLocalRiskFact, validAgentToolPolicies, type AgentAccessRule, type AgentToolPolicy } from './contracts.ts'
import type { BusinessControlManagementStatus, BusinessProviderView } from './management.ts'
import { GatewayChart, currentRiskFacts, identityBucket, riskBucket, type GatewayBucket } from './overview.tsx'
import { ToolPolicyEditor, editableToolPolicy, policyInputError, policyRangeWarnings, effectLabels, toolKinds, toolRuleSummary } from './tool-policy-editor.tsx'
import { businessControlStyle } from './style.ts'
import { ProviderProtocolView } from './provider-protocol-view.tsx'
import { GatewayAccessState, matchesGatewayInstanceScope } from './access-state.tsx'

type ProviderDraft = { enabled: boolean; endpoint: string; endpointHidden: boolean; timeout: string }
type Draft = { revision: string; enabled: boolean; agents: string; operations: string; authentication: ProviderDraft; identityTrust: ProviderDraft
  riskAssessment: ProviderDraft; accessAuthorization: ProviderDraft; inputMarkers: string; operationMarkers: string; reportMarkers: string; base: string }
type RegisteredInstance = { name: string; agent_id: string; state?: string; observed_at?: string }
type InstanceObservation = { phase: 'loading' | 'ready' | 'error'; rows: RegisteredInstance[]; observedAt: string; error: string }
type McpService = { id: string; name: string; description?: string; enabled?: boolean; tools?: { mode: 'all' | 'selected'; count: number; names: string[] } }
type AgentCatalog = { agents: { id: string; name?: string; active_experiment?: string | null; version_count?: number }[]; experiments: { id: string; agent_id: string }[] }
type AgentDescription = { agentId: string; source: { experimentId: string; basis: string } | null; name: string | null; description: string | null;
  skills: { skillId: string; skillName: string | null; skillDescription: string | null; verification: 'discovered' }[] }
type ProviderProbe = { network: 'httpResponded' | 'timeout' | 'noResponse'; httpStatus?: number; checkedAt: string; durationMs: number;
  contractChecked: false; businessChecked: false }
type Section = 'overview' | 'identity' | 'risk' | 'authorization'
const serialized = ({ revision: _revision, base: _base, ...value }: Draft) => JSON.stringify(value)
const dirty = (draft: Draft) => serialized(draft) !== draft.base
// 保留键入中的分隔符；保存时由管理入口校验并规范化数组元素。
const draftList = (text: string) => text ? text.split(',') : []
const markerLines = (text: string) => text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
function draftOf(data: BusinessControlManagementStatus): Draft {
  const provider = (value?: BusinessProviderView): ProviderDraft => ({ enabled: value?.configured ?? false, endpoint: value?.endpoint ?? '', endpointHidden: value?.endpointHidden ?? false,
    timeout: value?.timeoutMs === undefined ? '' : String(value.timeoutMs) })
  const value: Draft = { revision: data.revision, enabled: data.configuration.enabled, agents: JSON.stringify(data.configuration.agents, null, 2),
    operations: JSON.stringify(data.configuration.operations ?? [], null, 2), authentication: provider(data.configuration.authentication), identityTrust: provider(data.configuration.identityTrust),
    riskAssessment: provider(data.configuration.riskAssessment), accessAuthorization: provider(data.configuration.accessAuthorization),
    inputMarkers: (data.configuration.detection?.inputMarkers ?? []).join('\n'), operationMarkers: (data.configuration.detection?.operationMarkers ?? []).join('\n'),
    reportMarkers: (data.configuration.detection?.reportMarkers ?? []).join('\n'), base: '' }
  value.base = serialized(value)
  return value
}
function providerPayload(value: ProviderDraft) {
  return !value.enabled ? null : { ...(value.endpoint.trim() || !value.endpointHidden ? { endpoint: value.endpoint.trim() } : {}),
    timeoutMs: value.timeout.trim() ? Number(value.timeout) : null }
}
function ProviderFields({ title, kind, value, current, revision, rpc, change, showStatus = true }: { title: string; kind: 'authentication' | 'identityTrust' | 'riskAssessment' | 'accessAuthorization';
  value: ProviderDraft; current: BusinessProviderView; revision: string; rpc: PlatformPageProps['rpc']; change(value: ProviderDraft): void; showStatus?: boolean }) {
  const [probe, setProbe] = useState<ProviderProbe | null>(null)
  const [probeError, setProbeError] = useState('')
  const [probing, setProbing] = useState(false)
  const probeRequest = useRef(0)
  useEffect(() => { probeRequest.current++; setProbe(null); setProbeError(''); setProbing(false)
    return () => { probeRequest.current++ }
  }, [kind, value.endpoint, value.timeout, revision])
  async function check() {
    const id = ++probeRequest.current
    setProbing(true); setProbe(null); setProbeError('')
    try {
      const response = await rpc.call(CHANNEL, 'mcp/control/probeProvider', { kind,
        ...(value.endpoint.trim() ? { endpoint: value.endpoint.trim() } : {}),
        ...(value.timeout.trim() ? { timeoutMs: Number(value.timeout) } : {}) })
      if (id !== probeRequest.current) return
      if (response.ok) setProbe(response.value as ProviderProbe)
      else setProbeError(response.error.message)
    } catch { if (id === probeRequest.current) setProbeError('未收到探测结果，请稍后重试。') }
    finally { if (id === probeRequest.current) setProbing(false) }
  }
  const timeout = value.timeout.trim() ? Number(value.timeout) : 1500
  const canProbe = !!value.endpoint.trim() || value.endpointHidden
  return <div className="harness-gateway-provider-fields" role="group" aria-label={`${title}连接配置`}>
    {showStatus && <p className="harness-gateway-provider-note">{current.mode === 'test-mock' ? '当前保存的是测试模拟提供方。' : current.configured ? '已配置提供方。' : '尚未配置提供方。'}配置与 HTTP 响应均不代表接口合同或实际业务已通过。</p>}
    <label className="harness-gateway-provider-enabled"><input type="checkbox" checked={value.enabled} onChange={event => change({ ...value, enabled: event.target.checked })} /><span>启用{title}</span></label>
    <div className="harness-gateway-provider-inputs">
      <label className="harness-gateway-field"><span>服务地址</span><input aria-label={`${title}地址`} data-gateway-field={`${kind}-endpoint`} type="url" value={value.endpoint} placeholder={value.endpointHidden ? '原地址含私有部分，留空保留；可填写新的无凭据地址' : 'http://127.0.0.1:53101/api/v1/control/…'} onChange={event => change({ ...value, endpoint: event.target.value })} /></label>
      <label className="harness-gateway-field"><span>超时（毫秒）</span><input aria-label={`${title}超时（毫秒）`} data-gateway-field={`${kind}-timeout`} type="number" min={1} max={60000} placeholder="默认 1500" value={value.timeout} onChange={event => change({ ...value, timeout: event.target.value })} /></label>
    </div>
    <div className="harness-gateway-probe"><button type="button" disabled={probing || !canProbe || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000} onClick={() => void check()}>{probing ? '正在探测…' : '测试 HTTP 响应'}</button>
      {probe && <small role="status">{probe.network === 'httpResponded' ? `收到 HTTP ${probe.httpStatus} 响应${probe.httpStatus === 404 ? '；请核对路径' : ''}` : probe.network === 'timeout' ? '连接超时' : '未收到 HTTP 响应'} · {probe.durationMs} 毫秒。POST 合同及业务结果未验证。</small>}
      {probeError && <small role="alert">{probeError}</small>}</div>
    {value.endpointHidden && <p className="harness-gateway-provider-note">原地址不回传私有部分；未填写新地址时保留原配置。提供方地址不接受用户名、密码、查询参数或片段。</p>}
  </div>
}
const actionNames: Record<string, string> = { read: '查询', write: '写入', publish: '报告发布' }
const accessActionNames: Record<string, string> = { '*': '全部动作', 'agent:access': '访问 Agent', 'session:create': '创建会话', 'session:read': '读取会话', 'session:prompt': '发送会话消息', read: '读取', write: '写入', resource: '读取资源', publish: '发布报告' }
const stateNames: Record<string, string> = { verified: '已验证签名', unknown: '未知', expired: '已过期', disabled: '已停用', not_required: '开发调试无需发布身份签名', trusted: '来源与通道已确认', revoked: '身份已撤销', mismatch: '来源或代次不匹配' }
function identityResult(value: BusinessControlManagementStatus['agentStatuses'][number] | undefined) {
  if (!value) return { label: '待核对', state: 'pending' }
  if (value.authentication.status === 'not_required') return value.trust.status === 'trusted'
    ? { label: '开发调试 · 不要求发布身份签名', state: 'success' }
    : value.trust.status === 'revoked' || value.trust.status === 'mismatch'
      ? { label: '开发调试 · 来源不可用', state: 'blocked' }
      : { label: '开发调试 · 来源待核对', state: 'pending' }
  if (value.authentication.status === 'verified' && value.trust.status === 'trusted') return { label: '已核验', state: 'success' }
  if (value.authentication.status === 'disabled' || value.trust.status === 'revoked') return { label: '已撤销', state: 'blocked' }
  if (value.authentication.status === 'expired' || value.trust.status === 'expired') return { label: '已过期', state: 'pending' }
  if (value.trust.status === 'mismatch') return { label: '来源不匹配', state: 'blocked' }
  return { label: '待核对', state: 'pending' }
}
const configurationTabs = [{ id: 'overview', label: '运行概览' }, { id: 'identity', label: '智能体身份' }, { id: 'risk', label: '风险评估' }, { id: 'authorization', label: '访问控制' }] as const
function GatewayIcon({ kind }: { kind: 'refresh' | 'external' | 'shield' | 'alert' | 'check' }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === 'refresh' ? <><path d="M20 11a8 8 0 1 0-2.3 6.2" /><path d="M20 4v7h-7" /></> : kind === 'external' ? <><path d="M13 5h6v6" /><path d="m19 5-9 9" /><path d="M19 14v5H5V5h5" /></> : kind === 'shield' ? <><path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z" /><path d="m9 12 2 2 4-4" /></> : kind === 'alert' ? <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></> : <path d="m4 12 5 5L20 6" />}</svg>
}
function changedSections(draft: Draft): Set<Section> {
  const base = JSON.parse(draft.base) as Omit<Draft, 'base' | 'revision'>
  const changed = new Set<Section>()
  if (draft.authentication.endpoint !== base.authentication.endpoint || JSON.stringify(draft.authentication) !== JSON.stringify(base.authentication)
    || JSON.stringify(draft.identityTrust) !== JSON.stringify(base.identityTrust)) changed.add('identity')
  if (JSON.stringify(draft.riskAssessment) !== JSON.stringify(base.riskAssessment)
    || draft.inputMarkers !== base.inputMarkers || draft.operationMarkers !== base.operationMarkers || draft.reportMarkers !== base.reportMarkers) changed.add('risk')
  if (draft.enabled !== base.enabled) changed.add('overview')
  if (draft.operations !== base.operations || JSON.stringify(draft.accessAuthorization) !== JSON.stringify(base.accessAuthorization)) changed.add('authorization')
  if (draft.agents !== base.agents) {
    try {
      const rows = JSON.parse(draft.agents) as AgentAccessRule[], previous = JSON.parse(base.agents) as AgentAccessRule[]
      const identity = (value: AgentAccessRule[]) => value.map(row => [row.agentId, row.agentAuthentication, row.agentTrust, row.sourceDigest])
      const access = (value: AgentAccessRule[]) => value.map(row => [row.agentId, row.enabled, row.subjects, row.actions, row.serverIds, row.toolPolicies])
      if (JSON.stringify(identity(rows)) !== JSON.stringify(identity(previous))) changed.add('identity')
      if (JSON.stringify(access(rows)) !== JSON.stringify(access(previous))) changed.add('authorization')
      if (!changed.has('identity') && !changed.has('authorization')) changed.add('authorization')
    } catch { changed.add('authorization') }
  }
  return changed
}
function draftError(draft: Draft): { section: Section; field: string; message: string; agentIndex?: number; serverId?: string } | null {
  for (const [kind, section] of [['authentication', 'identity'], ['identityTrust', 'identity'], ['riskAssessment', 'risk'], ['accessAuthorization', 'authorization']] as const) {
    const provider = draft[kind]
    if (!provider.enabled) continue
    if (!provider.endpoint.trim() && !provider.endpointHidden) return { section, field: `${kind}-endpoint`, message: '请填写提供方地址' }
    if (provider.endpoint.trim()) {
      try {
        const url = new URL(provider.endpoint)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
      } catch { return { section, field: `${kind}-endpoint`, message: '提供方地址必须是无凭据、无查询参数的 HTTP(S) 地址' } }
    }
    if (provider.timeout.trim() && (!Number.isSafeInteger(Number(provider.timeout)) || Number(provider.timeout) < 1 || Number(provider.timeout) > 60000))
      return { section, field: `${kind}-timeout`, message: '提供方超时必须为 1 至 60000 毫秒' }
  }
  for (const [value, field] of [[draft.agents, 'agents-json'], [draft.operations, 'operations-json']] as const) {
    try { const rows = JSON.parse(value); if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error() }
    catch { return { section: 'authorization', field, message: '原始配置格式异常，内容已保留。请重新读取状态；若仍异常，需要修复配置来源。' } }
  }
  try {
    for (const [agentIndex, agent] of (JSON.parse(draft.agents) as AgentAccessRule[]).entries()) {
      if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return { section: 'authorization', field: 'agents-json', message: 'Agent 原始配置格式异常，内容已保留。请重新读取状态；若仍异常，需要修复配置来源。' }
      if (!Array.isArray(agent.actions) || !Array.isArray(agent.subjects) || agent.serverIds !== undefined && !Array.isArray(agent.serverIds)) return { section: 'authorization', field: 'agents-json', message: 'Agent 通用范围格式异常，原始内容已保留。请重新读取状态；若仍异常，需要修复配置来源。' }
      if (agent.toolPolicies === undefined) continue
      if (!Array.isArray(agent.toolPolicies) || agent.toolPolicies.some(policy => !editableToolPolicy(policy))) return { section: 'authorization', field: 'agents-json', message: '服务处理规则格式异常，原始内容已保留。请重新读取状态；若仍异常，需要修复配置来源。' }
      for (const policy of agent.toolPolicies) { const error = policyInputError(policy); if (error) return { section: 'authorization', agentIndex, serverId: policy.serverId, field: `tool-policies-${agentIndex}-${error.field}`, message: error.message } }
      if (!validAgentToolPolicies(agent.toolPolicies)) return { section: 'authorization', field: 'agents-json', message: '服务策略格式异常，原始内容已保留。请重新读取状态；若仍异常，需要修复配置来源。' }
    }
  } catch { /* 非数组JSON已由上方给出错误。 */ }
  return null
}
function RestrictionRow({ value, sessions, busy, perform }: { value: BusinessControlManagementStatus['restrictions'][number];
  sessions: BusinessControlManagementStatus['sessionTrustFacts']; busy: boolean;
  perform(endpoint: string, payload: unknown): Promise<{ ok: boolean; message: string }> }) {
  const [sessionId, setSessionId] = useState(value.scope.sessionId ?? '')
  const [action, setAction] = useState(value.deniedActions[0] ?? 'write')
  const [feedback, setFeedback] = useState('')
  const choices = sessions.filter(item => item.agentId === value.scope.agentId && item.subjectId === value.scope.subjectId
    && (!value.scope.instanceId || item.instanceId === value.scope.instanceId))
  async function release() {
    setFeedback('')
    const result = await perform('release', { restrictionId: value.id, sessionId: sessionId.trim(), action })
    setFeedback(result.message)
  }
  return <li className="harness-gateway-restriction-detail"><div className="harness-gateway-restriction-heading">
    <strong>{value.active ? '限制中' : '已解除'}</strong> · {value.scope.subjectId} · {value.scope.agentId} · {value.scope.instanceId ?? '所选工作区内匹配实例'}{value.scope.sessionId ? ` · ${value.scope.sessionId}` : ''}</div>
    <p>{value.deniedActions.map(item => actionNames[item] ?? item).join('、')}：{value.reason}</p>
    {value.active && <div className="harness-gateway-release">
      <label>匹配的 Session ID<input list={`gateway-sessions-${value.id}`} value={sessionId} readOnly={!!value.scope.sessionId} onChange={event => setSessionId(event.target.value)} placeholder="选择或填写该限制范围内的 Session" /></label>
      <datalist id={`gateway-sessions-${value.id}`}>{choices.map(item => <option key={item.sessionId} value={item.sessionId}>{item.state === 'expired' ? '身份记录已过期' : '已观察到的会话'}</option>)}</datalist>
      {value.deniedActions.length > 1 && <label>评估动作<select value={action} onChange={event => setAction(event.target.value)}>{value.deniedActions.map(item => <option key={item} value={item}>{actionNames[item] ?? item}</option>)}</select></label>}
      <button type="button" disabled={busy || !sessionId.trim()} onClick={() => void release()}>检查并解除</button>
    </div>}
    {feedback && <p role="status">{feedback}</p>}
  </li>
}

export function BusinessControlPage({ rpc, updates, active = true, target, onNavigate, assistantVisible, onAssistantVisibilityChange, onAssistantReturnChange }: PlatformPageProps & GatewayAssistantBridge & { updates?: PlatformUpdates; active?: boolean;
  target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void }) {
  const [data, setData] = useState<BusinessControlManagementStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [missingInstance, setMissingInstance] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewReturn = useRef<'identity' | 'access' | 'operations' | 'manual' | null>(null)
  const [localSection, setLocalSection] = useState<Section>('overview')
  const [accessAgentIndex, setAccessAgentIndex] = useState(0)
  const [policyServiceSelections, setPolicyServiceSelections] = useState<Record<string, string>>({})
  const [policyFocus, setPolicyFocus] = useState<{ serverId: string; field: string; token: number } | null>(null)
  const [identityEditorOpen, setIdentityEditorOpen] = useState(false)
  const [accessSettingsOpen, setAccessSettingsOpen] = useState(false)
  const [manualPolicyOpen, setManualPolicyOpen] = useState(false)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [operationIndex, setOperationIndex] = useState(0)
  const [chartFilter, setChartFilter] = useState('')
  const [riskFilter, setRiskFilter] = useState('')
  const section = target?.page === 'gateway' ? configurationTabs.find(value => value.id === target.tab)?.id ?? 'overview' : localSection
  const openSection = (next: Section) => { setPreviewOpen(false); setLocalSection(next); onNavigate?.({ page: 'gateway', ...(next === 'overview' ? {} : { tab: next }) }) }
  const [instanceId, setInstanceId] = useState('')
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([])
  const [sessionId, setSessionId] = useState('')
  const [action, setAction] = useState('write')
  const [reason, setReason] = useState('')
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalog | null>(null)
  const [agentCatalogError, setAgentCatalogError] = useState('')
  const [agentCatalogRevision, setAgentCatalogRevision] = useState(0)
  const [agentQuery, setAgentQuery] = useState('')
  const [description, setDescription] = useState<AgentDescription | null>(null)
  const [descriptionSelection, setDescriptionSelection] = useState('')
  const [descriptionError, setDescriptionError] = useState('')
  const [descriptionLoading, setDescriptionLoading] = useState(false)
  const [serviceCatalog, setServiceCatalog] = useState<McpService[]>([])
  const [serviceCatalogError, setServiceCatalogError] = useState('')
  const [runtimeFeedback, setRuntimeFeedback] = useState('')
  const [lastStatusAt, setLastStatusAt] = useState('')
  const [instanceObservation, setInstanceObservation] = useState<InstanceObservation>({ phase: 'loading', rows: [], observedAt: '', error: '' })
  const instanceRead = useRef(0)
  const instanceNavigation = useRef(0)
  const requestId = useRef(0)
  const reading = useRef<number | null>(null)
  const mounted = useRef(true)
  const mutating = useRef(false)
  const runtimeScopeInitialized = useRef(false)
  function accept(value: BusinessControlManagementStatus) {
    setData(value)
    setLastStatusAt(new Date().toLocaleString())
    setDraft(previous => {
      if (previous && dirty(previous)) return previous
      return draftOf(value)
    })

  }
  async function readRegisteredInstances(): Promise<RegisteredInstance[] | null> {
    const request = ++instanceRead.current
    setInstanceObservation(previous => ({ ...previous, phase: 'loading', error: '' }))
    try {
      const response = await rpc.call(CHANNEL, 'instances/list', {})
      if (!mounted.current || request !== instanceRead.current) return null
      if (!response.ok) throw new Error(response.error.message)
      const value = response.value as { instances?: RegisteredInstance[]; observed_at?: string }
      if (!Array.isArray(value.instances)) throw new Error('实例登记响应缺少实例列表')
      const rows = value.instances.filter(row => typeof row.name === 'string' && typeof row.agent_id === 'string')
      setInstanceObservation({ phase: 'ready', rows, observedAt: value.observed_at || '', error: '' })
      return rows
    } catch (error) {
      if (mounted.current && request === instanceRead.current) setInstanceObservation(previous => ({ ...previous, phase: 'error', error: error instanceof Error ? error.message : '无法读取实例登记' }))
      return null
    }
  }
  async function viewCurrentInstance(instance: BusinessControlManagementStatus['instances'][number]) {
    const request = ++instanceNavigation.current
    setMissingInstance('')
    const rows = await readRegisteredInstances()
    if (request !== instanceNavigation.current) return
    if (!rows) { setNotice('无法核对当前实例登记，请重试；未打开可能过期的实例详情。'); return }
    const found = rows.find(row => row.name === instance.instanceId && row.agent_id === instance.agentId)
    if (!found) {
      setNotice(`实例 ${instance.instanceId} 已不在当前登记中；此网关记录仅供历史核对。`)
      setMissingInstance(instance.instanceId)
      return
    }
    onNavigate?.({ page: 'instances', instance_name: found.name })
  }
  async function refresh() {
    if (mutating.current || reading.current !== null) return
    const id = ++requestId.current
    reading.current = id
    try {
      const response = await rpc.call(CHANNEL, 'mcp/control/status', {})
      if (!mounted.current || id !== requestId.current) return
      if (response.ok) { accept(response.value as BusinessControlManagementStatus); setLoadError('') }
      else setLoadError(response.error.message)
    } catch { if (mounted.current && id === requestId.current) setLoadError('无法读取统一网关状态，请检查连接。') }
    finally { if (reading.current === id) reading.current = null }
  }
  useEffect(() => {
    mounted.current = true
    // 常驻页面隐藏时仍接收写入回执；只有实际卸载才结束组件寿命。
    return () => { mounted.current = false; requestId.current++; reading.current = null }
  }, [])
  useEffect(() => { if (!active) { setPreviewOpen(false); instanceNavigation.current++ } }, [active])
  useEffect(() => {
    if (!active) return
    void readRegisteredInstances()
    const unsubscribe = updates?.subscribe(() => { if (updates.getSnapshot().domains.includes('instances')) void readRegisteredInstances() })
    return () => { instanceRead.current++; instanceNavigation.current++; unsubscribe?.() }
  }, [active, rpc, updates])
  useEffect(() => {
    if (!active) return
    void refresh()
    // 回执与许可租期为 2 秒，页面每秒重读事实；轮询不修改草稿或发起业务。
    const timer = setInterval(() => { void refresh() }, 1000)
    const unsubscribe = updates?.subscribe(() => {
      if (updates.getSnapshot().domains.some(domain => domain === 'mcp' || domain === 'instances')) void refresh()
    })
    return () => { requestId.current++; reading.current = null; clearInterval(timer); unsubscribe?.() }
  }, [active, rpc, updates])
  useEffect(() => {
    if (!active) return
    let disposed = false, request = 0
    const readAgents = async () => {
      const id = ++request
      try {
        const response = await rpc.call(CHANNEL, 'agents/list', {})
        if (disposed || id !== request) return
        if (response.ok) { setAgentCatalog(response.value as AgentCatalog); setAgentCatalogError('') }
        else setAgentCatalogError(response.error.message)
      } catch { if (!disposed && id === request) setAgentCatalogError('无法读取智能体列表，请刷新重试；已选配置已保留。') }
    }
    void readAgents()
    const unsubscribe = updates?.subscribe(() => {
      if (updates.getSnapshot().domains.some(domain => domain === 'agents' || domain === 'catalog')) void readAgents()
    })
    return () => { disposed = true; unsubscribe?.() }
  }, [active, rpc, updates, agentCatalogRevision])
  async function perform(endpoint: string, payload: unknown): Promise<{ ok: boolean; message: string }> {
    if (mutating.current) return { ok: false, message: '已有操作正在进行，请等待结果。' }
    mutating.current = true
    setBusy(true); setError(''); setNotice(''); setMissingInstance('')
    // 先前发出的状态读取不能覆盖本次操作回执。
    requestId.current++
    reading.current = null
    try {
      const response = await rpc.call(CHANNEL, `mcp/control/${endpoint}`, payload)
      if (!mounted.current) return { ok: false, message: '页面已关闭，操作结果请重新读取。' }
      requestId.current++
      if (!response.ok) {
        setError(response.error.message)
        if (response.error.code === 'conflict') { mutating.current = false; void refresh() }
        return { ok: false, message: response.error.message }
      }
      const value = response.value as BusinessControlManagementStatus
      let message: string
      if (endpoint === 'saveConfiguration') {
        setDraft(draftOf(value))
        message = '配置已保存；实例是否应用请核对运行概览的回执。'
      } else if (endpoint === 'restrict') message = '限制已保存；请核对实例回执。'
      else if (endpoint === 'release') message = value.change?.currentPermission === 'deny'
        ? '所选限制已解除，当前请求仍受其他约束；没有重放业务。'
        : value.change?.source === 'manual-fallback' ? '风险服务当前不可用，已按手动兜底核对并解除所选人工限制；其他约束继续生效，没有重放业务。' : value.configuration.riskAssessment.configured ? '重新评估后已解除所选限制；新请求仍会重验身份和许可，没有重放业务。'
          : '检查基础策略后已解除所选限制；新请求仍会重验身份和许可，没有重放业务。'
      else message = '风险事实已重新评估；没有执行或重放业务。'
      setNotice(message)
      accept(value)
      updates?.invalidate(['mcp', 'instances'])
      return { ok: true, message }
    } catch {
      const message = '操作结果未确认，请先刷新状态核对；没有自动重试。'
      if (mounted.current) setError(message)
      return { ok: false, message }
    }
    finally { mutating.current = false; if (mounted.current) setBusy(false) }
  }
  const currentInstances = instanceObservation.phase === 'ready' ? data?.instances.filter(binding => instanceObservation.rows.some(row => row.name === binding.instanceId && row.agent_id === binding.agentId)) ?? [] : []
  const historicalInstances = instanceObservation.phase === 'ready' ? data?.instances.filter(binding => !currentInstances.includes(binding)) ?? [] : []
  const currentInstanceIds = new Set(currentInstances.map(instance => instance.instanceId))
  const currentRiskRecords = (data?.riskFacts ?? []).filter(fact => !retiredLocalRiskFact(fact) && currentInstances.some(instance => matchesGatewayInstanceScope(fact.scope, instance)))
  useEffect(() => {
    if (instanceObservation.phase !== 'ready' || !data || runtimeScopeInitialized.current) return
    setInstanceId(currentInstances[0]?.instanceId || ''); runtimeScopeInitialized.current = true
  }, [instanceObservation, data])
  const instance = currentInstances.find(value => value.instanceId === instanceId)
  const agent = data?.configuration.agents.find(value => value.agentId === instance?.agentId)
  const selectedSubjects = agent?.subjects.filter(value => selectedSubjectIds.includes(value)) ?? []
  const conflict = !!draft && !!data && draft.revision !== data.revision
  const scope = instance && selectedSubjects.length === 1 ? { workspaceId: instance.workspaceId, agentId: instance.agentId,
    instanceId: instance.instanceId, runtimeGeneration: instance.runtimeGeneration, subjectId: selectedSubjects[0],
    ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}) } : undefined
  async function restrictSelected() {
    if (!instance || !selectedSubjects.length || !reason.trim() || (sessionId.trim() && selectedSubjects.length !== 1)) return
    const applied: string[] = [], unresolved: string[] = []
    for (const subjectId of selectedSubjects) {
      const targetScope = { workspaceId: instance.workspaceId, agentId: instance.agentId, instanceId: instance.instanceId,
        runtimeGeneration: instance.runtimeGeneration, subjectId, ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}) }
      const result = await perform('restrict', { scope: targetScope, deniedActions: [action], reason })
      if (result.ok) applied.push(subjectId)
      else unresolved.push(`${subjectId}：${result.message}`)
    }
    setRuntimeFeedback(`${applied.length} / ${selectedSubjects.length} 位接入用户的限制已保存；实例应用请核对回执。${unresolved.length ? `未确认：${unresolved.join('；')}` : ''}`)
  }
  function resetDraft() {
    if (!data) return
    setPreviewOpen(false)
    setDraft(draftOf(data))
    setError('')
  }
  function validateDraft() {
    if (!draft || busy || conflict) return false
    const invalid = draftError(draft)
    if (invalid) {
      setError(`${configurationTabs.find(value => value.id === invalid.section)?.label}：${invalid.message}`)
      setPreviewOpen(false)
      if (invalid.field.startsWith('accessAuthorization-')) { setManualPolicyOpen(false); setAccessSettingsOpen(false); setOperationsOpen(false) }
      if (invalid.section === 'identity') setIdentityEditorOpen(true)
      else if (invalid.section === 'authorization' && !invalid.field.startsWith('accessAuthorization-')) { if (invalid.agentIndex !== undefined) { setManualPolicyOpen(true); setAccessAgentIndex(invalid.agentIndex); const row = JSON.parse(draft.agents)[invalid.agentIndex]; if (row?.agentId && invalid.serverId) { setPolicyServiceSelections(value => ({ ...value, [row.agentId]: invalid.serverId! })); setPolicyFocus(value => ({ serverId: invalid.serverId!, field: invalid.field, token: (value?.token ?? 0) + 1 })) } } else if (invalid.field === 'operations-json') setOperationsOpen(true); else setAccessSettingsOpen(true) }
      openSection(invalid.section)
      window.requestAnimationFrame?.(() => { const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-gateway-field="${invalid.field}"]`)
        for (let parent = field?.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true
        field?.focus() })
      return false
    }
    return true
  }
  function openPreview() { if (validateDraft()) { setError(''); previewReturn.current = identityEditorOpen ? 'identity' : accessSettingsOpen ? 'access' : operationsOpen ? 'operations' : manualPolicyOpen ? 'manual' : null; setPreviewOpen(true) } }
  function returnFromPreview() { if (previewReturn.current === 'identity') setIdentityEditorOpen(true); else if (previewReturn.current === 'access') setAccessSettingsOpen(true); else if (previewReturn.current === 'operations') setOperationsOpen(true); else if (previewReturn.current === 'manual') setManualPolicyOpen(true) }
  function saveDraft() {
    if (!validateDraft() || !draft) return
    setPreviewOpen(false)
    void perform('saveConfiguration', { revision: draft.revision, enabled: draft.enabled, agents: JSON.parse(draft.agents), operations: JSON.parse(draft.operations),
      authentication: providerPayload(draft.authentication), identityTrust: providerPayload(draft.identityTrust),
      riskAssessment: providerPayload(draft.riskAssessment), accessAuthorization: providerPayload(draft.accessAuthorization),
      detection: { inputMarkers: markerLines(draft.inputMarkers), operationMarkers: markerLines(draft.operationMarkers), reportMarkers: markerLines(draft.reportMarkers) } })
  }
  let agentDrafts: AgentAccessRule[] = [], operationDrafts: any[] = [], agentDraftMalformed = false, operationDraftMalformed = false
  try { const parsed = JSON.parse(draft?.agents ?? '[]'); if (Array.isArray(parsed) && parsed.every(row => row && typeof row === 'object' && typeof row.agentId === 'string' && Array.isArray(row.subjects) && Array.isArray(row.actions) && (row.serverIds === undefined || Array.isArray(row.serverIds)))) agentDrafts = parsed; else agentDraftMalformed = true } catch { agentDraftMalformed = true /* 保留无法解析的原始配置，供重新读取或修复来源。 */ }
  try { const parsed = JSON.parse(draft?.operations ?? '[]'); if (Array.isArray(parsed) && parsed.every(row => row && typeof row === 'object' && !Array.isArray(row))) operationDrafts = parsed; else operationDraftMalformed = true } catch { operationDraftMalformed = true }
  const dirtyPages = draft ? changedSections(draft) : new Set<Section>()
  const descriptionAgentId = agentDrafts.some(row => row.agentId === descriptionSelection) ? descriptionSelection : agentDrafts.find(row => row.agentId)?.agentId ?? ''
  useEffect(() => {
    if (!active || section !== 'identity' || !descriptionAgentId) { setDescription(null); return }
    let disposed = false
    setDescription(null); setDescriptionError(''); setDescriptionLoading(true)
    void rpc.call(CHANNEL, 'agents/description', { agent_id: descriptionAgentId }).then(response => {
      if (disposed) return
      if (response.ok) setDescription(response.value as AgentDescription)
      else setDescriptionError(response.error.message)
    }).catch(() => { if (!disposed) setDescriptionError('无法读取当前智能体描述。') })
      .finally(() => { if (!disposed) setDescriptionLoading(false) })
    return () => { disposed = true }
  }, [active, section, descriptionAgentId, rpc])
  useEffect(() => {
    if (!active || section !== 'authorization') return
    let disposed = false
    void Promise.allSettled([rpc.call(CHANNEL, 'mcp/configuration', {}), rpc.call(CHANNEL, 'mcp/list', {})]).then(results => {
      if (disposed) return
      const catalog: McpService[] = []
      const configuration = results[0].status === 'fulfilled' && results[0].value.ok ? results[0].value.value as { servers?: { id: string; serverName?: string; description?: string; enabled?: boolean; tools?: { mode: 'all' | 'selected'; names?: string[] } }[] } : null
      // 只保留公开展示字段；连接地址、请求头等配置不进入页面状态。
      for (const server of configuration?.servers ?? []) catalog.push({ id: server.id, name: server.serverName || server.id, description: server.description, enabled: server.enabled,
        ...(server.tools ? { tools: { mode: server.tools.mode, count: server.tools.names?.length ?? 0, names: [...(server.tools.names ?? [])] } } : {}) })
      const listed = results[1].status === 'fulfilled' && results[1].value.ok ? results[1].value.value as { connections?: { id: string; name?: string }[] } : null
      for (const server of listed?.connections ?? []) if (!catalog.some(row => row.id === server.id)) catalog.push({ id: server.id, name: server.name || server.id })
      setServiceCatalog(catalog)
      setServiceCatalogError(!configuration && !listed ? 'MCP 目录读取失败，已有服务范围已保留。' : '')
    })
    return () => { disposed = true }
  }, [active, section, rpc])
  useEffect(() => {
    if (!draft || !dirty(draft)) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draft])
  const activeAgentIndex = Math.min(accessAgentIndex, Math.max(0, agentDrafts.length - 1))
  const accessAgent = agentDrafts[activeAgentIndex]
  const registeredServerIds = [...new Set(operationDrafts.map(row => String(row.serverId ?? '').trim()).filter(Boolean))]
  const changeAgent = (index: number, value: Partial<AgentAccessRule>) => { if (draft) setDraft({ ...draft, agents: JSON.stringify(agentDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const selectAgent = (index: number, agentId: string) => {
    if (!agentCatalog?.agents.some(value => value.id === agentId) || agentDrafts[index]?.agentId === agentId) return
    // 更换配置对象不能沿用上一智能体的来源和身份启用状态。
    changeAgent(index, { agentId, enabled: false, sourceDigest: undefined, agentTrust: { enabled: false } })
  }
  function changeToolAction(action: string, checked: boolean) {
    if (!accessAgent) return
    const actions = accessAgent.actions.includes('*') ? [...new Set([...agentAccessActions.filter(value => value !== '*'), ...accessAgent.actions.filter(value => value !== '*')])] : accessAgent.actions
    changeAgent(activeAgentIndex, { actions: checked ? [...new Set([...actions, action])] : actions.filter(value => value !== action) })
  }
  const changeOperation = (index: number, value: Record<string, unknown>) => { if (draft) setDraft({ ...draft, operations: JSON.stringify(operationDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const addAgent = () => { if (draft && !agentDraftMalformed) { setAccessAgentIndex(agentDrafts.length); setDraft({ ...draft, agents: JSON.stringify([...agentDrafts, { agentId: '', enabled: false, subjects: [], actions: ['read'], serverIds: [], agentAuthentication: { enabled: true, method: 'hmac-sha256' }, agentTrust: { enabled: false } }], null, 2) }); setIdentityEditorOpen(true); openSection('identity') } }
  const currentPolicies = Array.isArray(accessAgent?.toolPolicies) ? accessAgent.toolPolicies : []
  const policyRulesMalformed = accessAgent?.toolPolicies !== undefined && (!Array.isArray(accessAgent.toolPolicies) || accessAgent.toolPolicies.some(policy => !editableToolPolicy(policy)))
  const policyServiceIds = [...new Set([...serviceCatalog.map(row => row.id), ...registeredServerIds, ...(accessAgent?.serverIds ?? []), ...currentPolicies.map(row => row?.serverId).filter((value): value is string => typeof value === 'string')])]
  const policyServiceId = accessAgent ? policyServiceSelections[accessAgent.agentId] || currentPolicies[0]?.serverId || accessAgent.serverIds?.[0] || '' : ''
  const currentPolicy = currentPolicies.find(policy => policy?.serverId === policyServiceId)
  const policyOperations = [...operationDrafts.filter(row => row.serverId === policyServiceId).map(row => ({ id: String(row.operationId), label: String(row.operationId), kind: row.kind })),
    ...(serviceCatalog.find(row => row.id === policyServiceId)?.tools?.names ?? []).filter(id => !operationDrafts.some(row => row.serverId === policyServiceId && row.operationId === id)).map(id => ({ id, label: id }))]
  function changeServicePolicy(value: AgentToolPolicy | undefined) {
    if (!accessAgent || !policyServiceId) return
    const policies = currentPolicies.filter(policy => policy.serverId !== policyServiceId)
    if (value) policies.push(value)
    changeAgent(activeAgentIndex, { toolPolicies: policies.length ? policies : undefined })
  }
  const currentRisks = currentRiskFacts(currentRiskRecords, Date.now())
  const freshFacts = currentRisks.map(value => value.fact).filter(value => Date.parse(value.expiresAt) > Date.now())
  const highRiskCount = freshFacts.filter(value => value.level === 'high').length
  const unknownRiskCount = currentRisks.filter(value => value.bucket === 'unknown').length
  const automaticRiskEnabled = !!data?.configuration.riskAssessment.configured
  const riskOverview = !automaticRiskEnabled ? '自动评估已关闭' : !currentRisks.length ? '尚无评估' : unknownRiskCount ? '存在未知评估' : !freshFacts.length ? '评估已过期' : `已评估范围内 ${highRiskCount} 项高风险`
  const riskLabel = !automaticRiskEnabled ? '自动评估已关闭' : instanceObservation.phase !== 'ready' ? '实例范围待核对' : !currentRisks.length ? '尚无评估' : unknownRiskCount ? '结果未知' : !freshFacts.length ? '已过期' : highRiskCount ? '高风险' : '当前范围已评估'
  const latestRiskFact = currentRisks.map(value => value.fact).reduce<BusinessControlManagementStatus['riskFacts'][number] | undefined>((latest, fact) => !latest || Date.parse(fact.observedAt) > Date.parse(latest.observedAt) ? fact : latest, undefined)
  const riskNext = !automaticRiskEnabled ? '核对基础策略与人工限制；已记录自动评估不参与当前许可' : !currentRisks.length ? '等待下一次受管业务事件，或为已知 Session 发起辅助重评'
    : unknownRiskCount ? '核对提供方响应与未知评估的依据'
      : !freshFacts.length ? '选择匹配的 Session 重新评估，再核对新证据'
        : highRiskCount ? '核对高风险信号与当前限制' : '执行时仍按实际请求重新判断许可'
  const isCurrentApplied = (value: BusinessControlManagementStatus['instances'][number]) => value.applied && instanceObservation.rows.some(row => row.name === value.instanceId && row.agent_id === value.agentId && row.state === 'running')
  const appliedInstances = currentInstances.filter(isCurrentApplied).length
  const identitySegments: GatewayBucket[] = [
    { key: 'verified', label: '核验通过', tone: 'success', count: 0 }, { key: 'abnormal', label: '异常', tone: 'blocked', count: 0 }, { key: 'unknown', label: '待核验', tone: 'pending', count: 0 },
  ].map(segment => ({ ...segment, count: currentInstances.filter(instance => identityBucket(instance, data!.agentStatuses.find(status => status.instanceId === instance.instanceId)) === segment.key).length })) as GatewayBucket[]
  const applySegments: GatewayBucket[] = [{ key: 'applied', label: '已同步', count: appliedInstances, tone: 'success' }, { key: 'pending', label: '待核对', count: currentInstances.length - appliedInstances, tone: 'pending' }]
  const riskSegments: GatewayBucket[] = [{ key: 'high', label: automaticRiskEnabled ? '有效高风险' : '高风险记录', tone: automaticRiskEnabled ? 'blocked' : 'neutral', count: 0 }, { key: 'low', label: automaticRiskEnabled ? '有效低风险' : '低风险记录', tone: automaticRiskEnabled ? 'success' : 'neutral', count: 0 }, { key: 'expired', label: '已过期', tone: 'pending', count: 0 }, { key: 'unknown', label: '未知', tone: 'neutral', count: 0 }]
    .map(segment => ({ ...segment, count: currentRisks.filter(item => item.bucket === segment.key).length })) as GatewayBucket[]
  const overviewInstances = currentInstances.filter(instance => {
    if (!chartFilter) return true
    if (chartFilter.startsWith('identity:')) return identityBucket(instance, data!.agentStatuses.find(status => status.instanceId === instance.instanceId)) === chartFilter.slice(9)
    return chartFilter === 'apply:applied' ? isCurrentApplied(instance) : !isCurrentApplied(instance)
  }) ?? []
  function applicationLabel(value: BusinessControlManagementStatus['instances'][number]) {
    const current = instanceObservation.rows.find(row => row.name === value.instanceId && row.agent_id === value.agentId)
    if (current?.state !== 'running') return current?.state && ['stopped', 'absent', 'exited'].includes(current.state) ? '未运行，无实时回执' : '运行状态待核对'
    if (value.applied) return '已应用'
    const time = Date.parse(value.acknowledgement?.at || '')
    return Number.isFinite(time) && Date.now() - time > data!.coverage.acknowledgementDeadlineMs ? '回执已过期' : '尚无当前应用回执'
  }
  const attentionInstances = currentInstances.filter(value => {
    const current = instanceObservation.rows.find(row => row.name === value.instanceId && row.agent_id === value.agentId)
    return current?.state === 'running' && (!value.applied || identityBucket(value, data!.agentStatuses.find(status => status.instanceId === value.instanceId)) === 'abnormal')
  })
  function showRiskContext(fact?: BusinessControlManagementStatus['riskFacts'][number]) {
    setMissingInstance('')
    if (fact?.scope.instanceId && !currentInstanceIds.has(fact.scope.instanceId)) { setNotice('此评估关联的实例已不在当前登记中，保留为历史依据；请从实例管理核对当前对象。'); return }
    if (instanceObservation.phase !== 'ready') { setNotice('当前实例登记尚未核对，暂不能带入运行操作。'); return }
    if (fact) { setInstanceId(fact.scope.instanceId ?? ''); setSelectedSubjectIds(fact.scope.subjectId ? [fact.scope.subjectId] : []); setSessionId(fact.scope.sessionId ?? ''); setReason(fact.signals.map(signal => signal.reason).join('；')) }
    openSection('overview')
    window.requestAnimationFrame?.(() => { const element = document.getElementById('gateway-reassess'); if (element) { element.scrollIntoView({ block: 'start' }); element.focus() } })
  }
  return <GatewayWindows assistantVisible={assistantVisible} onAssistantVisibilityChange={onAssistantVisibilityChange} onAssistantReturnChange={onAssistantReturnChange}><main className="harness-mcp-page harness-gateway-page" aria-label="统一网关管理">
      <style>{businessControlStyle}</style>
      {error && <p role="alert">{error}</p>}
      {loadError && <p role="alert">{loadError}{data && `；以下为上次成功读取的状态（${lastStatusAt || '时间未知'}），当前许可需重新核对。`}</p>}
      {notice && <div role="status"><p>{notice}</p>{missingInstance && <button type="button" onClick={() => onNavigate?.({ page: 'instances' })}>前往实例列表</button>}</div>}
      {!data ? <section className="harness-card">{loadError ? <><h2>无法读取统一网关状态</h2><p>当前访问范围和实例回执尚未确认。</p><button type="button" onClick={() => void refresh()}>重新读取</button></> : <LoadingIndicator label="读取统一网关状态" block />}</section> : <>
        {conflict && <p role="alert">配置已在其他位置更新，当前草稿已保留。请复制需要的修改，放弃草稿后按最新版本编辑；旧草稿不能覆盖新配置。</p>}
        <div className="harness-gateway-navigation"><nav className="harness-mcp-tabs harness-gateway-main-tabs" role="tablist" aria-label="统一网关视图" onKeyDown={event => {
          const index = configurationTabs.findIndex(tab => tab.id === section)
          const next = event.key === 'ArrowRight' ? (index + 1) % configurationTabs.length : event.key === 'ArrowLeft' ? (index + configurationTabs.length - 1) % configurationTabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? configurationTabs.length - 1 : -1
          if (next < 0) return
          event.preventDefault(); openSection(configurationTabs[next].id)
          window.requestAnimationFrame?.(() => document.querySelector<HTMLButtonElement>(`[data-gateway-tab="${configurationTabs[next].id}"]`)?.focus())
        }}>{configurationTabs.map(tab => <button key={tab.id} data-gateway-tab={tab.id} role="tab" aria-selected={section === tab.id} aria-controls="gateway-panel" tabIndex={section === tab.id ? 0 : -1} type="button" onClick={() => openSection(tab.id)}>{tab.label}{dirtyPages.has(tab.id) && <span className="harness-gateway-dirty-dot" aria-label="有未保存更改"> ●</span>}</button>)}</nav><div className="harness-gateway-read-controls">{instanceObservation.phase === 'loading' && <LoadingIndicator label="核对当前实例登记" />}<span>{lastStatusAt ? `${loadError ? '上次网关读取于' : '网关状态读取于'} ${lastStatusAt}` : '尚未读取'}</span><button className="harness-gateway-refresh" type="button" disabled={busy} onClick={() => { void refresh(); setAgentCatalogRevision(value => value + 1); void readRegisteredInstances() }}><GatewayIcon kind="refresh" />{loadError ? '重新读取' : '刷新状态'}</button></div></div>
        {draft && dirty(draft) && <div className="harness-gateway-savebar"><div><strong>有未保存更改</strong><small>一次保存全部配置；实例应用状态见运行概览。</small></div><div className="harness-mcp-actions">{section !== 'authorization' && <button className="harness-primary" type="button" disabled={busy || conflict} onClick={openPreview}>预览配置</button>}<button type="button" disabled={busy} onClick={() => { if (window.confirm?.('放弃全部未保存更改并读取当前配置？') ?? true) resetDraft() }}>放弃草稿并读取当前配置</button></div></div>}
        {instanceObservation.phase !== 'ready' && <div className="harness-gateway-instance-observation"><p role={instanceObservation.phase === 'error' ? 'alert' : 'status'}>{instanceObservation.phase === 'error' ? `实例登记读取失败：${instanceObservation.error}。当前实例范围未知，历史快照不作为当前状态。` : '当前实例范围待确认，历史网关记录暂不计入。'}{instanceObservation.observedAt && ` 上次读取：${instanceObservation.observedAt}。`}{instanceObservation.phase === 'error' && <button type="button" onClick={() => void readRegisteredInstances()}>重试实例登记</button>}</p>{instanceObservation.rows.length > 0 && <GatewayWindow title="上次实例登记快照" trigger="上次实例登记快照（当前状态待核对）" active={active} identity={`${section}:${instanceObservation.observedAt}`}><p>上次读取于 {instanceObservation.observedAt || '时间未知'}；以下记录不代表当前实例状态。</p><ul className="harness-gateway-list">{instanceObservation.rows.map(row => <li key={row.name}>{row.name} · {row.agent_id} · 上次运行状态 {row.state || '未记录'}</li>)}</ul></GatewayWindow>}</div>}
        <div className="harness-gateway-workspace" id="gateway-panel" role="tabpanel" aria-label={configurationTabs.find(tab => tab.id === section)?.label}>
        {section !== 'overview' && <section className="harness-card harness-composition-detail" aria-label="功能配置">
        {section === 'identity' && <div className="harness-gateway-object"><SearchSelect label="当前智能体" value={descriptionAgentId} options={agentDrafts.filter(row => row.agentId).map(row => ({ value: row.agentId, label: agentCatalog?.agents.find(item => item.id === row.agentId)?.name || row.agentId, description: row.agentId }))} onChange={setDescriptionSelection}/><div>{descriptionLoading ? <LoadingIndicator label="读取资产描述" /> : descriptionError ? <p role="alert">{descriptionError}</p> : <><strong>{description?.name || descriptionAgentId || '尚未配置智能体身份'}</strong><p>{description?.description || '当前登记版本尚无描述资料。'}</p>{description?.source && <small>登记版本：{description.source.experimentId}</small>}</>}</div>{descriptionAgentId && <button type="button" className="harness-gateway-text-button" onClick={() => onNavigate?.({ page: 'agents', agent_id: descriptionAgentId, ...(description?.source ? { experiment_id: description.source.experimentId } : {}), tab: 'description' })}>维护描述与技能 →</button>}</div>}
        {section === 'identity' && (currentInstances.some(instance => !descriptionAgentId || instance.agentId === descriptionAgentId) ? <div className="harness-table-scroll harness-gateway-overview-table harness-gateway-identity-table"><table><thead><tr><th>智能体</th><th>Agent ID</th><th>业务实例</th><th>实际装载</th><th>核验结果</th></tr></thead><tbody>{currentInstances.filter(instance => !descriptionAgentId || instance.agentId === descriptionAgentId).map(instance => {
          const status = data.agentStatuses.find(value => value.instanceId === instance.instanceId)
          const outcome = identityResult(status)
          return <tr key={instance.instanceId}><td><strong>{agentCatalog?.agents.find(value => value.id === instance.agentId)?.name || instance.agentId}</strong><span className="harness-gateway-mobile-identity-result">{outcome.label}</span><GatewayWindow title={`${instance.instanceId} · 核验详情`} trigger="查看实例核验" active={active && section === 'identity'} identity={`${instance.instanceId}:${instance.runtimeGeneration}`}><dl className="harness-fields"><div><dt>业务实例</dt><dd>{instance.instanceId}</dd></div><div><dt>当前代次</dt><dd>{instance.runtimeGeneration}</dd></div><div><dt>实际来源</dt><dd><code>{instance.sourceDigest}</code></dd></div><div><dt>核验结果</dt><dd>{outcome.label}</dd></div></dl></GatewayWindow></td><td><code>{instance.agentId}</code></td><td>{instance.instanceId}</td><td>代次 {instance.runtimeGeneration}</td><td><span className="harness-gateway-badge" data-state={outcome.state}>● {outcome.label}</span></td></tr>
        })}</tbody></table></div> : <div className="harness-gateway-access-empty"><strong>{instanceObservation.phase === 'ready' ? '暂无已登记业务实例' : '当前实例范围尚未确认'}</strong><p>实例登记和网关回执分别核对；读取失败或历史记录不作为当前身份核验结果。</p><button type="button" onClick={() => onNavigate?.({ page: 'instances' })}>前往实例管理</button></div>)}
        {section === 'identity' && <>
        <div className="harness-gateway-detail-links"><GatewayWindow title="身份核验依据" active={active && section === 'identity'} identity={descriptionAgentId}>
          <p className="harness-gateway-description">许可租期上限 2 秒，在线回执目标 2 秒；以下按所选智能体展示已记录依据。</p>
          <h3>智能体身份与可信来源</h3>{instanceObservation.phase !== 'ready' ? <p>当前实例范围尚未确认，暂不能判断当前身份核验状态。</p> : currentInstances.some(value => !descriptionAgentId || value.agentId === descriptionAgentId) ? <ul className="harness-gateway-list">{data.agentStatuses.filter(value => currentInstanceIds.has(value.instanceId) && (!descriptionAgentId || value.agentId === descriptionAgentId)).map(value => <li key={value.instanceId}>{value.agentId} / {value.instanceId}：{value.authentication.status === 'not_required' ? '开发调试，不要求发布身份签名' : `发布身份 ${stateNames[value.authentication.status] ?? value.authentication.status}`}；来源状态 {stateNames[value.trust.status] ?? value.trust.status}<p>{value.authentication.status === 'not_required' ? '无需发布身份验证或风险评估；网关内部签名用于实例路由。' : `签名最近验证 ${value.authentication.verifiedAt ?? '尚无证据'} · 签名有效期 ${value.authentication.expiresAt ?? '未知'}`} · 来源依据 {value.trust.reason}</p></li>)}</ul> : <p>尚无当前 Agent 身份核验事实。</p>}
          <h3>接入用户会话身份事实</h3><p>会话条目为已保存的观察，不代表实时身份探测。</p>{data.sessionTrustFacts?.some(value => !descriptionAgentId || value.agentId === descriptionAgentId) ? <ul className="harness-gateway-list">{data.sessionTrustFacts.filter(value => !descriptionAgentId || value.agentId === descriptionAgentId).map(value => <li key={value.sessionId}>{instanceObservation.phase === 'ready' && !instanceObservation.rows.some(row => row.name === value.instanceId && row.agent_id === value.agentId) ? '历史对象 · ' : ''}{value.subjectId} / {value.sessionId}：{value.state === 'evidence-held' ? '持有已验证身份记录（非实时探测）' : '身份记录已过期'} · 验证时间 {value.verifiedAt ?? '未知'} · 有效期 {value.expiresAt ?? '未知'} · 观察时间 {value.observedAt}</li>)}</ul> : <p>尚无用户会话信任事实。</p>}
        </GatewayWindow></div>
        </>}
        {section === 'risk' && <><section className="harness-gateway-risk-primary" aria-label="风险评估提供方与动态结果">
          <div className="harness-gateway-provider-summary"><div><h2>Agent 风险评估提供方</h2><strong>{data.configuration.riskAssessment.configured ? data.configuration.riskAssessment.mode === 'test-mock' ? '已配置 · 测试模拟提供方' : '已配置 · 外部提供方' : '尚未配置'}</strong>{dirtyPages.has('risk') && <small>有待保存的风险配置；下方结果来自已保存配置的实际运行记录。</small>}<p>页面每秒读取最新已记录评估，并跟随网关状态更新；不主动发起业务或模型请求。发布实例按风险策略评估，未发布实例全部放行。</p></div><ProviderProtocolView kind="risk-assessment" rpc={rpc} active={active && section === 'risk'}/></div>
          {draft && <form id="gateway-risk-provider" tabIndex={-1} noValidate aria-label="统一网关配置" className="harness-gateway-risk-provider-form" onSubmit={event => { event.preventDefault(); openPreview() }}><fieldset aria-label="风险评估提供方配置">
            <ProviderFields showStatus={false} title="Agent 风险评估提供方" kind="riskAssessment" value={draft.riskAssessment} current={data.configuration.riskAssessment} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, riskAssessment: value })} />
            <p className="harness-gateway-provider-note">风险判断由第三方提供方负责。未配置或不可用时不生成风险结论；访问控制服务继续按可用依据作决定。需要手动兜底时执行基础处理和纯工具规则，依赖缺失风险的条件暂停。<button type="button" className="harness-gateway-text-button" onClick={() => { openSection('authorization'); setManualPolicyOpen(true) }}>查看手动兜底配置</button></p>
</fieldset></form>}

        <section className="harness-gateway-agent-risk-summary" aria-label="智能体风险摘要"><h3>智能体风险摘要</h3>{data.configuration.agents.length ? <div className="harness-gateway-facts">{data.configuration.agents.map(row => {
          const facts = currentRisks.map(value => value.fact).filter(fact => fact.scope.agentId === row.agentId), valid = facts.filter(fact => Date.parse(fact.expiresAt) > Date.now())
          const development = data.agentStatuses.filter(value => currentInstanceIds.has(value.instanceId) && value.agentId === row.agentId).every(value => value.authentication.status === 'not_required') && data.agentStatuses.some(value => currentInstanceIds.has(value.instanceId) && value.agentId === row.agentId)
          const label = !automaticRiskEnabled ? '自动评估已关闭' : instanceObservation.phase !== 'ready' ? '当前实例范围待核对' : development ? '未发布，无需风险评估' : !facts.length ? '尚未评估' : !valid.length ? '评估已过期' : valid.some(fact => fact.level === 'high') ? '高风险（已评估范围）'
            : valid.some(fact => fact.status === 'unknown' || fact.level === 'unknown') ? '存在未知评估' : valid.every(fact => fact.level === 'low') ? '低风险（已评估范围）' : '已评估，未提供风险等级'
          const latest = [...facts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]
          const instances = currentInstances.filter(value => value.agentId === row.agentId)
          return <article key={row.agentId}><h4>{row.agentId}：{label}</h4>{development ? <p>所有请求放行；发布后按风险策略限制高风险 MCP 工具调用。</p> : <><p>最新评估 {latest?.observedAt ?? '尚无事实'} · {automaticRiskEnabled ? `有效期内评估 ${valid.length}/${facts.length}` : `已停用自动记录 ${facts.length} 条`} · 人工限制 {data.restrictions.filter(value => value.active && instances.some(instance => matchesGatewayInstanceScope(value.scope, instance))).length} · 实例回执 {instances.filter(isCurrentApplied).length}/{instances.length}</p>
</>}</article>
        })}</div> : <p>尚无已配置业务 Agent。</p>}</section>
        </section><div className="harness-gateway-risk-records"><div className="harness-section-heading"><h3>{automaticRiskEnabled ? '当前动态评估结果' : '已记录评估（当前不参与许可）'}</h3>{riskFilter && <button type="button" onClick={() => setRiskFilter('')}>清除图表筛选</button>}</div>
          {currentRisks.some(item => !riskFilter || item.bucket === riskFilter) ? <div className="harness-table-scroll harness-gateway-risk-table"><table><thead><tr><th>评估对象与范围</th><th>结果</th><th>观察时间与有效性</th><th>依据</th><th>处置</th></tr></thead><tbody>{currentRisks.filter(item => !riskFilter || item.bucket === riskFilter).map(({ fact, bucket }) => <tr key={fact.id}><td><strong>{fact.scope.agentId} · {fact.scope.instanceId || '当前智能体范围'}</strong><small>接入用户 {fact.scope.subjectId || '未限定'} · Session {fact.scope.sessionId || '未限定'}{fact.contentDigest && ' · 指定内容检测'}</small></td><td><span className="harness-gateway-badge" data-state={bucket === 'low' ? 'success' : bucket === 'high' ? 'blocked' : 'pending'}>{riskSegments.find(item => item.key === bucket)?.label}</span></td><td><span>{fact.observedAt}</span><small>有效至 {fact.expiresAt || '未记录'} · 版本 {fact.version}</small></td><td>{fact.signals.map(signal => signal.reason).join('；') || '未附加风险信号'}</td><td><button type="button" className="harness-gateway-text-button" onClick={() => showRiskContext(fact)}>前往运行处置</button></td></tr>)}</tbody></table></div> : <p>{instanceObservation.phase !== 'ready' ? '当前实例范围尚未确认，暂不显示为当前评估。' : riskFilter ? '没有符合筛选范围的评估结果。' : data.configuration.riskAssessment.configured ? '已配置提供方，当前实例尚无动态评估结果；等待实际业务事件产生记录。' : '当前实例尚无动态评估结果；请先配置风险评估提供方。'}</p>}
        </div><div className="harness-gateway-risk-summary"><div className="harness-gateway-risk-notice" role="status"><div><strong>{riskLabel === '自动评估已关闭' ? '自动风险评估已关闭' : riskLabel === '实例范围待核对' ? '当前实例范围尚未确认，暂不能判断当前评估状态' : riskLabel === '已过期' ? '当前评估已超过有效期' : riskLabel === '尚无评估' ? '当前没有可用于判断许可的评估事实' : riskLabel === '结果未知' ? '当前评估包含未知结果' : riskLabel === '高风险' ? '当前评估范围内存在高风险' : '当前范围已有有效评估'}</strong><p>{riskLabel === '自动评估已关闭' ? '已记录自动评估不参与当前许可；基础工具权限与人工限制仍然生效。可配置提供方开启动态评估。' : riskLabel === '已过期' ? '请重新评估或核对有效证据；不能据此推断访问已允许或已阻止。' : '评估只覆盖记录的对象与动作；单次请求仍需核对当时的身份和访问配置。'}</p></div></div>
          <div className="harness-gateway-risk-actions"><button className="harness-primary" type="button" onClick={() => showRiskContext()}>前往运行处置</button><GatewayWindow title="评估范围与历史依据" trigger={`历史与完整评估依据 · ${data.riskFacts.length} 条`} active={active && section === 'risk'} identity={riskFilter}><dl className="harness-gateway-risk-facts"><dt>评估范围</dt><dd>{latestRiskFact ? `${latestRiskFact.scope.agentId}${latestRiskFact.scope.instanceId ? ` · ${latestRiskFact.scope.instanceId}` : ''}${latestRiskFact.scope.subjectId ? ` · ${latestRiskFact.scope.subjectId}` : ''}` : '当前工作区尚无评估对象'}</dd><dt>最近评估</dt><dd>{latestRiskFact ? `${latestRiskFact.observedAt} · ${Date.parse(latestRiskFact.expiresAt) <= Date.now() ? '已过期' : latestRiskFact.status === 'unknown' ? '结果未知' : '当前有效'}` : '尚无记录'}</dd><dt>即时访问配置</dt><dd>{data.enabled ? '已开放' : '已关闭'}；单次请求的许可仍需核对</dd><dt>下一步</dt><dd>{riskNext}</dd></dl>
          <h3>已保存的评估事实</h3>{data.riskFacts.length ? <ul className="harness-gateway-list">{[...data.riskFacts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).map(fact => <li key={fact.id}><strong>{retiredLocalRiskFact(fact) && '旧本地测试记录 · '}{instanceObservation.phase === 'ready' && fact.scope.instanceId && !currentInstanceIds.has(fact.scope.instanceId) ? '历史对象 · ' : ''}{fact.scope.agentId} · {fact.scope.instanceId || '未限定实例'} · {riskSegments.find(segment => segment.key === riskBucket(fact, Date.now()))?.label || '结果未知'}</strong><p>版本 {fact.version} · {fact.observedAt} · 有效期至 {fact.expiresAt} · {fact.signals.length ? fact.signals.map(signal => `${signal.code}=${signal.value}（${signal.reason}）`).join('；') : '未附加风险信号'}</p></li>)}</ul> : <p>暂无已保存的评估事实。</p>}</GatewayWindow></div>
        </div></>}
        {draft && <div className="harness-composition-editor harness-gateway-config" aria-label="统一网关配置">
          {section === 'identity' && <GatewayWindow title="配置智能体身份与可信来源" editing open={identityEditorOpen} onOpenChange={setIdentityEditorOpen} active={active && section === 'identity'} disabled={busy} footer={<button type="button" className="harness-primary" disabled={busy || conflict} onClick={openPreview}>预览配置</button>}><form noValidate aria-label="统一网关配置" onSubmit={event => { event.preventDefault(); openPreview() }}>{!agentDrafts.length && <div className="harness-gateway-empty"><strong>{agentDraftMalformed ? 'Agent 原始配置格式异常' : '尚未配置业务 Agent'}</strong><p>{agentDraftMalformed ? '原内容已保留，请重新读取状态；若仍异常，需要修复配置来源。' : '先登记智能体身份并核对可信来源，再配置访问范围。'}</p><button type="button" className="harness-primary" disabled={agentDraftMalformed} onClick={addAgent}>配置首个 Agent</button></div>}<fieldset><legend>1．智能体身份</legend>
            <p>验证智能体的身份凭据、可信来源与实例绑定。身份过期、撤销或来源不匹配直接阻断访问，不折算成业务风险分数；低风险不能覆盖身份条件失败。</p>
            <div className="harness-gateway-identity"><section aria-label="认证方式与凭据"><h3>认证方式与凭据</h3>
            <p>当前支持受信部署域内的 HMAC SHA-256 签名，只有有效的真实签名才显示已验证。</p>
            {!!agentDrafts.length && <label>搜索智能体<input type="search" value={agentQuery} placeholder="按名称或 Agent ID 搜索" onChange={event => setAgentQuery(event.target.value)} /></label>}
            {agentCatalogError ? <p role="alert">{agentCatalogError}<button type="button" onClick={() => setAgentCatalogRevision(value => value + 1)}>重试智能体列表</button></p>
              : !agentCatalog ? <LoadingIndicator label="读取智能体列表" block /> : !agentCatalog.agents.length && <p>当前没有可选智能体，请先在智能体管理中新建。</p>}
            {agentDrafts.map((row, index) => <div key={index} className="harness-composition-editor harness-gateway-agent">
              <label>选择智能体<select aria-label={`选择智能体 ${index + 1}`} value={row.agentId ?? ''} disabled={!agentCatalog || !!agentCatalogError} onChange={event => selectAgent(index, event.target.value)}>
                <option value="" disabled>请选择已有智能体</option>
                {!!row.agentId && !agentCatalog?.agents.some(value => value.id === row.agentId) && <option value={row.agentId}>{row.agentId}（{agentCatalog && !agentCatalogError ? '当前未找到，保留配置' : '列表未就绪，保留配置'}）</option>}
                {agentCatalog?.agents.filter(value => value.id === row.agentId || `${value.name ?? ''} ${value.id}`.toLowerCase().includes(agentQuery.trim().toLowerCase())).map(value => <option key={value.id} value={value.id} disabled={agentDrafts.some((other, at) => at !== index && other.agentId === value.id)}>{value.name && value.name !== value.id ? `${value.name}（${value.id}）` : value.id}</option>)}
              </select></label>
              {!!row.agentId && agentCatalog && !agentCatalogError && !agentCatalog.agents.some(value => value.id === row.agentId) && <p role="status">该智能体当前未在资产列表中找到，原配置已保留。</p>}
              <label>Agent ID<input readOnly value={row.agentId ?? ''} placeholder="选择后自动关联" /></label>
              {!!row.agentId && <section className="harness-gateway-agent-source" aria-label={`${row.agentId} · 版本与业务实例`}><h4>版本与业务实例</h4><p>当前启用版本：{agentCatalog?.agents.find(value => value.id === row.agentId)?.active_experiment || '未记录'}</p><p>已登记版本：{agentCatalog?.experiments.filter(value => value.agent_id === row.agentId).map(value => value.id).join('、') || '当前无可展示记录'}</p>
                {currentInstances.filter(value => value.agentId === row.agentId).map(value => <p key={value.instanceId}>{value.instanceId} · {value.runtimeGeneration} · 实际来源 <code>{value.sourceDigest}</code></p>)}
                {!currentInstances.some(value => value.agentId === row.agentId) && <p>{instanceObservation.phase === 'ready' ? '尚无该智能体的业务实例与来源登记。' : '当前实例范围尚未确认，请先重新读取实例登记。'}</p>}
              </section>}
              <small>选择后需分别核对来源、身份启用和访问策略。</small>
              <p>认证方式：HMAC SHA-256</p>
              <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={row.agentAuthentication?.enabled ?? true} onChange={event => changeAgent(index, { agentAuthentication: { enabled: event.target.checked, method: 'hmac-sha256' } })} />启用该 Agent 的签名认证</label>
            </div>)}
            <p>当前签名和实例绑定状态请到“运行概览”核对。</p>
            </section><section aria-label="可信来源与身份状态"><h3>可信来源与身份状态</h3>
            <p>核对当前代次的有效签名、已建立的回执及固定来源。这里说明身份条件是否满足；当前访问策略是否应用另看实例回执。</p>
            {agentDrafts.map((row, index) => <div key={index} className="harness-composition-editor harness-gateway-agent"><strong>{row.agentId || '待填写 Agent'}</strong>
              <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={row.agentTrust?.enabled ?? true} onChange={event => changeAgent(index, { agentTrust: { enabled: event.target.checked } })} />允许该智能体身份（取消即撤销）</label>
              <div className="harness-gateway-source-record"><span>旧实例来源记录</span><code data-gateway-source-digest={row.agentId}>{row.sourceDigest || '未记录'}</code><small>实例专属来源由系统自动登记；既有兼容记录保留，不在此编辑。</small></div>
            </div>)}
            <p>可信来源的实时核验结果请到“运行概览”核对。</p>
            </section></div>
            <section className="harness-gateway-auxiliary"><h3>辅助：接入用户认证与状态核验</h3>
              <p>这里验证接入用户及其有效状态，用于区分会话归属；智能体身份由上方独立核验。</p>
              <ProviderFields title="接入用户认证提供方" kind="authentication" value={draft.authentication} current={data.configuration.authentication} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, authentication: value })} />
              <ProviderFields title="接入用户状态核验提供方" kind="identityTrust" value={draft.identityTrust} current={data.configuration.identityTrust} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, identityTrust: value })} />
            </section>
          </fieldset></form></GatewayWindow>}

          {section === 'authorization' && <div className="harness-gateway-authorization"><div className="harness-gateway-policy-heading"><h2>访问控制</h2><p>优先由第三方综合当前请求与风险作出访问决定，平台负责按决定执行。</p></div><div className="harness-gateway-policy-object"><label>查看智能体<select aria-label="业务智能体" value={String(activeAgentIndex)} disabled={!agentDrafts.length} onChange={event => setAccessAgentIndex(Number(event.target.value))}>{agentDrafts.map((row, index) => <option key={index} value={index}>{agentCatalog?.agents.find(value => value.id === row.agentId)?.name || row.agentId || `待配置智能体 ${index + 1}`} · {row.agentId || '未选择'}</option>)}</select></label><p>选择对象查看实际决定；第三方连接作用于此工作区，单次结果不代表该智能体永久获准。</p></div><div className="harness-gateway-policy-panels"><form noValidate aria-label="第三方访问控制配置" className="harness-gateway-provider-card" onSubmit={event => { event.preventDefault(); openPreview() }}><header className="harness-gateway-policy-section-heading harness-gateway-provider-heading"><div><h3>第三方访问控制服务</h3><p>{data.configuration.accessAuthorization?.configured ? `${data.configuration.accessAuthorization.mode === 'test-mock' ? '测试模拟服务' : '已配置'} · 已发布实例每次实际操作获取决定` : '尚未配置 · 当前使用手动兜底策略'}</p></div><ProviderProtocolView kind="access-control" rpc={rpc} active={active && section === 'authorization'}/></header><ProviderFields showStatus={false} title="访问控制提供方" kind="accessAuthorization" value={draft.accessAuthorization} current={data.configuration.accessAuthorization ?? { configured: false, endpoint: '', endpointHidden: false, mode: 'unconfigured' }} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, accessAuthorization: value })}/><p className="harness-gateway-provider-note">未配置、超时或无有效响应时，执行已保存的手动兜底策略。第三方明确返回禁止时，继续禁止；关闭风险评估也不会关闭第三方基础授权。</p><div className="harness-gateway-provider-footer"><button type="button" className="harness-gateway-text-button" aria-haspopup="dialog" aria-expanded={manualPolicyOpen} onClick={() => setManualPolicyOpen(true)}>手动兜底策略</button><button type="submit" className="harness-primary" disabled={busy || conflict}>预览配置</button></div></form><GatewayAccessState data={data} selectedAgentId={accessAgent?.agentId ?? ''} selectedServerId={policyServiceId || undefined} registration={instanceObservation} statusLoading={!data && !loadError} statusError={loadError} onNavigateRisk={() => openSection('risk')} onNavigateOverview={() => openSection('overview')} /></div><GatewayWindow title="手动兜底策略" trigger={null} editing open={manualPolicyOpen} onOpenChange={setManualPolicyOpen} active={active && section === 'authorization'} identity={String(accessAgentIndex)} footer={<button type="button" className="harness-primary" disabled={busy || conflict} onClick={openPreview}>预览配置</button>}><form noValidate aria-label="统一网关配置" onSubmit={event => { event.preventDefault(); openPreview() }}><fieldset className="harness-gateway-access harness-gateway-static-policy"><legend className="harness-gateway-visually-hidden">3．访问控制</legend><header className="harness-gateway-policy-section-heading"><div><h3>手动基础范围与条件规则</h3><p>第三方未配置或未返回有效决定时，使用此处已保存策略。</p></div><div className="harness-gateway-policy-actions"><span>{dirtyPages.has('authorization') ? '有未保存更改' : '与已保存配置一致'}</span><button type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={accessSettingsOpen} onClick={() => setAccessSettingsOpen(true)}>Agent高级设置</button></div></header>
            <div className="harness-gateway-policy-context"><div><strong>已保存基础权限：{accessAgent ? (() => { const saved = data.configuration.agents.find(row => row.agentId === accessAgent.agentId); return !saved ? '尚未登记' : data.configuration.enabled && saved.enabled ? '已开放' : '已关闭' })() : '尚未选择智能体'}</strong><p>手动策略仅作兜底；第三方有效决定优先，明确禁止不会回退放行。保存不等于实例已应用；未发布实例仍按开发调试全部放行。</p></div></div>
            {!agentDrafts.length && <div className="harness-gateway-access-empty"><p>{agentDraftMalformed ? 'Agent 原始配置格式异常，内容已保留。请重新读取状态；若仍异常，需要修复配置来源。' : '尚无业务智能体配置。先登记身份，再设置访问范围。'}</p>{!agentDraftMalformed && <button type="button" onClick={addAgent}>配置智能体身份</button>}</div>}
            {accessAgent && <>

              <section className="harness-gateway-policy-step"><h4>选择 MCP 服务</h4>{policyRulesMalformed && <p role="alert">服务规则格式异常，原始内容已保留。请重新读取状态；若仍异常，需要修复配置来源。</p>}<SearchSelect label="选择 MCP 服务" value={policyServiceId} placeholder="选择要设置规则的 MCP 服务" options={policyServiceIds.map(id => { const server = serviceCatalog.find(row => row.id === id); return { value: id, label: server?.name || id, description: server?.description || id } })} onChange={id => setPolicyServiceSelections(values => ({ ...values, [accessAgent.agentId]: id }))}/>{serviceCatalogError && <p role="status">{serviceCatalogError}</p>}</section>
              {policyServiceId && <section className="harness-gateway-policy-step"><h4>设置适用情况与操作处理</h4><div className="harness-gateway-base-scope"><div><strong>当前基础范围：{accessAgent.serverIds === undefined || accessAgent.serverIds.includes(policyServiceId) ? '服务已开放' : '服务未开放'}</strong><span>可进行：{accessAgent.actions.includes('*') ? '全部工具操作' : toolKinds.filter(kind => accessAgent.actions.includes(kind.value)).map(kind => kind.label).join('、') || '未开放工具操作'}</span>{!draft.enabled && <small>工作区业务访问已关闭。</small>}{!accessAgent.enabled && <small>当前智能体访问尚未启用。</small>}</div>{accessAgent.serverIds !== undefined && !accessAgent.serverIds.includes(policyServiceId) && <button type="button" onClick={() => changeAgent(activeAgentIndex, { serverIds: [...accessAgent.serverIds!, policyServiceId] })}>允许此服务</button>}</div>
                {!policyRulesMalformed && (!currentPolicy || editableToolPolicy(currentPolicy)) ? <ToolPolicyEditor serverId={policyServiceId} value={currentPolicy} fieldPrefix={`tool-policies-${activeAgentIndex}`} operations={policyOperations} allowedKinds={accessAgent.actions} automaticRiskEnabled={automaticRiskEnabled} onChange={changeServicePolicy} focusRequest={policyFocus?.serverId === policyServiceId ? policyFocus : undefined} onAdjustBase={() => setAccessSettingsOpen(true)}/> : <p role="alert">此服务的原规则格式异常，内容已保留。请重新读取状态；若仍异常，需要修复配置来源。</p>}
              </section>}
            </>}

            <datalist id="gateway-service-suggestions">{[...new Set([...serviceCatalog.map(row => row.id), ...registeredServerIds])].map(value => <option key={value} value={value} />)}</datalist>


          </fieldset></form><p>先保存访问配置，再核对实例回执。发布实例的资源读取按配置核对实际目标；未发布实例全部放行。原生定时任务已开放，自动检测与防护闭环尚待验证。</p><button type="button" className="harness-gateway-text-button" onClick={() => setOperationsOpen(true)}>操作定义</button></GatewayWindow><div className="harness-gateway-settings-links"><GatewayWindow title="Agent高级设置" trigger={null} editing active={active && section === 'authorization'} identity={String(accessAgentIndex)} open={accessSettingsOpen} onOpenChange={setAccessSettingsOpen} onClose={() => setManualPolicyOpen(true)} disabled={busy} footer={<button type="button" className="harness-primary" disabled={busy || conflict} onClick={openPreview}>预览配置</button>}>{accessAgent && <section className="harness-gateway-settings-section"><h3>Agent 通用范围</h3><p>此处维护当前智能体的手动兜底范围；接入用户与身份归属始终按已保存配置核对。</p>              <div className="harness-gateway-access-fields">
                <div className="harness-gateway-service-scope" role="group" aria-label={`允许访问的服务 ${activeAgentIndex + 1}`}><label>MCP 服务范围<select aria-label="MCP 服务范围" value={accessAgent.serverIds === undefined ? 'registered' : 'selected'} onChange={event => changeAgent(activeAgentIndex, { serverIds: event.target.value === 'registered' ? undefined : [] })}><option value="registered">按已登记操作中的服务开放</option><option value="selected">仅允许所选 MCP 服务</option></select></label>
                  {serviceCatalogError && <p role="status">{serviceCatalogError}</p>}
                  {accessAgent.serverIds === undefined ? <p>使用操作定义中已登记的服务；也可改为仅允许指定服务。</p> : <><SearchSelect label="添加 MCP 服务" value="" placeholder="搜索并添加 MCP 服务" options={[...new Set([...serviceCatalog.map(row => row.id), ...registeredServerIds])].filter(id => !accessAgent.serverIds?.includes(id)).map(id => { const server = serviceCatalog.find(row => row.id === id); return { value: id, label: server?.name || id, description: server?.description || id, disabled: server?.enabled === false } })} onChange={id => changeAgent(activeAgentIndex, { serverIds: [...(accessAgent.serverIds ?? []), id] })}/><div className="harness-gateway-selected-services">{accessAgent.serverIds.map(id => { const server = serviceCatalog.find(row => row.id === id); return <div key={id}><div><strong>{server?.name || id}</strong>{server?.name && server.name !== id && <small>{id}</small>}{server?.description && <p title={server.description}>{server.description}</p>}<small>{server?.enabled === false ? '服务已停用' : !server ? '原有服务，当前目录未找到' : server.tools?.mode === 'selected' ? `平台已选 ${server.tools.count} 项工具` : '服务工具范围；未读取工具目录'}</small></div><button type="button" aria-label={`移除服务 ${server?.name || id}`} onClick={() => changeAgent(activeAgentIndex, { serverIds: (accessAgent.serverIds ?? []).filter(value => value !== id) })}>移除</button></div> })}</div>{!accessAgent.serverIds.length && <p>尚未选择服务，此范围不允许访问任何 MCP 服务。</p>}</>}
                </div>
              </div>
              <div className="harness-gateway-action-row harness-gateway-choices" role="group" aria-label={`允许的动作 ${activeAgentIndex + 1}`}><div><strong>允许的动作</strong><small>身份有效或低风险不会自动增加权限。</small></div><label className="harness-gateway-inline"><input type="checkbox" checked={(accessAgent.actions ?? []).includes('*') || (accessAgent.actions ?? []).includes('read')} onChange={event => changeToolAction('read', event.target.checked)} />查询信息</label><div className="harness-gateway-action-options"><div className="harness-gateway-choice-list">{['write', 'resource', 'publish'].map(value => <label key={value} className="harness-gateway-option" data-selected={(accessAgent.actions ?? []).includes('*') || (accessAgent.actions ?? []).includes(value)}><input type="checkbox" checked={(accessAgent.actions ?? []).includes('*') || (accessAgent.actions ?? []).includes(value)} onChange={event => changeToolAction(value, event.target.checked)} />{toolKinds.find(kind => kind.value === value)?.label || accessActionNames[value]}</label>)}</div></div></div>

                <label className="harness-gateway-subjects">允许使用此智能体的接入用户 ID<input value={(accessAgent.subjects ?? []).join(',')} onChange={event => changeAgent(activeAgentIndex, { subjects: draftList(event.target.value) })} placeholder="例如 subject-a,subject-b" /><small>填写接入用户的稳定 ID，多个用逗号分隔；留空表示无人可用。</small></label><div className="harness-gateway-action-options"><span>其他动作</span><div className="harness-gateway-choice-list">{agentAccessActions.filter(value => !['read', 'write', 'resource', 'publish'].includes(value)).map(value => <label key={value} className="harness-gateway-option" data-selected={(accessAgent.actions ?? []).includes(value)}><input type="checkbox" checked={(accessAgent.actions ?? []).includes(value)} onChange={event => changeAgent(activeAgentIndex, { actions: event.target.checked ? [...(accessAgent.actions ?? []), value] : (accessAgent.actions ?? []).filter(action => action !== value) })} />{accessActionNames[value]}</label>)}</div>{accessAgent.actions.some(value => !agentAccessActions.includes(value)) && <small>存在未识别的历史权限，原值已保留，不在此修改。</small>}</div>              <div className="harness-gateway-agent-tools"><label className="harness-gateway-inline"><input type="checkbox" checked={accessAgent.enabled ?? false} onChange={event => changeAgent(activeAgentIndex, { enabled: event.target.checked })} />开放该智能体的访问权限</label><button type="button" onClick={addAgent}>添加智能体身份</button><button type="button" onClick={() => setDraft({ ...draft, agents: JSON.stringify(agentDrafts.filter((_, at) => at !== activeAgentIndex), null, 2) })}>移除当前智能体配置</button></div></section>}<section className="harness-gateway-settings-section"><h3>查看原始配置</h3><p>只读核对当前 Agent 配置；权限与条件通过表单设置，系统字段自动保留。</p><label>Agent 原始配置<textarea data-gateway-field="agents-json" aria-label="Agent 原始配置" readOnly rows={10} spellCheck={false} value={draft.agents} /></label>{agentDraftMalformed && <p role="alert">原内容已保留，请重新读取状态；若仍异常，需要修复配置来源。<button type="button" disabled={busy} onClick={() => void refresh()}>重新读取状态</button></p>}</section></GatewayWindow>
            <GatewayWindow title="操作定义" trigger={null} editing active={active && section === 'authorization'} open={operationsOpen} onOpenChange={setOperationsOpen} onClose={() => setManualPolicyOpen(true)} disabled={busy} footer={<button type="button" className="harness-primary" disabled={busy || conflict} onClick={openPreview}>预览配置</button>}>            <section className="harness-gateway-operation-list" aria-label="工具与资源操作允许清单"><div className="harness-gateway-operation-list-heading"><h3>工具与资源操作登记</h3><button type="button" disabled={operationDraftMalformed} onClick={() => { setOperationIndex(operationDrafts.length); setDraft({ ...draft, operations: JSON.stringify([...operationDrafts, { serverId: '', operationId: '', kind: 'read', method: 'GET', target: '' }], null, 2) }) }}>添加操作</button></div>
              <p className="harness-gateway-description">操作目标供工作区各智能体复用；所选智能体的可用范围由上方服务与动作限定。</p>
              {!!operationDrafts.length && <label className="harness-gateway-operation-select">选择要编辑的操作<select aria-label="选择要编辑的操作" value={String(Math.min(operationIndex, operationDrafts.length - 1))} onChange={event => setOperationIndex(Number(event.target.value))}>{operationDrafts.map((row, index) => <option key={index} value={index}>{row.operationId || `操作 ${index + 1}`} · {row.serverId || '未填写服务'} · {row.method || '未选方法'} · {accessActionNames[row.kind] ?? row.kind}</option>)}</select></label>}
              {operationDrafts.map((row, index) => index === Math.min(operationIndex, operationDrafts.length - 1) && <div key={index} className="harness-gateway-operation-card"><h4>{row.operationId || `操作 ${index + 1}`}</h4><div className="harness-gateway-operation-fields">
                <label>服务 ID<input aria-label={`服务 ID ${index + 1}`} list="gateway-service-suggestions" value={row.serverId ?? ''} onChange={event => changeOperation(index, { serverId: event.target.value })} /></label>
                <label>操作 ID<input aria-label={`操作 ID ${index + 1}`} value={row.operationId ?? ''} onChange={event => changeOperation(index, { operationId: event.target.value })} /></label>
                <label>动作<select aria-label={`动作 ${index + 1}`} value={row.kind ?? 'read'} onChange={event => changeOperation(index, { kind: event.target.value })}>{['read', 'write', 'resource', 'publish'].map(value => <option key={value} value={value}>{toolKinds.find(kind => kind.value === value)?.label || accessActionNames[value]}</option>)}</select></label>
                <label>方法<select aria-label={`方法 ${index + 1}`} value={row.method ?? ''} onChange={event => changeOperation(index, { method: event.target.value })}><option value="" disabled>选择方法</option>{!!row.method && !businessOperationMethods.includes(row.method) && <option value={row.method}>{row.method}（无效）</option>}{businessOperationMethods.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className="harness-gateway-field-wide">实际目标<input aria-label={`实际目标 ${index + 1}`} value={row.target ?? ''} placeholder={row.targetHidden ? '原目标私有部分不回传，留空保留' : 'http://…/path/{id}'} onChange={event => changeOperation(index, { target: event.target.value, targetHidden: !event.target.value && !!row.targetHidden })} /></label>
                <label className="harness-gateway-inline harness-gateway-field-wide"><input aria-label={`必要确认 ${index + 1}`} type="checkbox" checked={row.confirmation ?? false} onChange={event => changeOperation(index, { confirmation: event.target.checked })} />执行前需要确认</label>
                <button type="button" onClick={() => setDraft({ ...draft, operations: JSON.stringify(operationDrafts.filter((_, at) => at !== index), null, 2) })}>移除操作</button>
              </div></div>)}
              {!operationDrafts.length && <p className="harness-gateway-access-empty">尚无操作。添加工具或资源操作后，才能授权实际目标。</p>}
            </section><section className="harness-gateway-settings-section"><h3>查看原始配置</h3><p>只读核对工作区共享的操作定义；系统绑定信息自动保留。</p><label>操作原始配置<textarea data-gateway-field="operations-json" aria-label="操作原始配置" readOnly rows={10} spellCheck={false} value={draft.operations} /></label>{operationDraftMalformed && <p role="alert">原内容已保留，请重新读取状态；若仍异常，需要修复配置来源。<button type="button" disabled={busy} onClick={() => void refresh()}>重新读取状态</button></p>}</section></GatewayWindow></div></div>}
        </div>}
        </section>}
        {section === 'overview' && <section className="harness-card harness-composition-detail" aria-label="运行概览">
        {draft && <section className="harness-gateway-business-entry" aria-label="业务入口"><div><h3>业务入口</h3><p>控制此工作区所有业务实例的访问；不控制 DSH 工作区读写和会话权限，也不停止容器。</p><small>{draft.enabled !== data.configuration.enabled ? '有未保存更改' : data.configuration.enabled ? '已保存：入口开放' : '已保存：入口关闭'}</small></div><label className="harness-gateway-switch-label">开放业务入口<span className="harness-gateway-switch"><input type="checkbox" role="switch" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span aria-hidden="true" /></span></label></section>}
        {instanceObservation.phase === 'ready' && <div className="harness-gateway-charts" aria-label="统一网关状态概览">
          <GatewayChart title="身份核验" totalLabel="个实例" scope="对外服务实例" segments={identitySegments} selected={chartFilter.startsWith('identity:') ? chartFilter.slice(9) : undefined} note={`${currentInstances.filter(instance => identityBucket(instance, data.agentStatuses.find(status => status.instanceId === instance.instanceId)) === 'development').length} 个开发实例不计入发布身份核验`} onSelect={key => setChartFilter(`identity:${key}`)}/>
          <GatewayChart title="配置同步" totalLabel="个实例" scope="已观察实例" segments={applySegments} selected={chartFilter.startsWith('apply:') ? chartFilter.slice(6) : undefined} onSelect={key => setChartFilter(`apply:${key}`)}/>
          <GatewayChart title="风险评估" totalLabel="条评估" scope={automaticRiskEnabled ? "当前实例关联记录（含已过期）" : "自动评估已关闭 · 仅展示已记录事实"} segments={riskSegments} note={automaticRiskEnabled ? "历史记录可在风险评估中查看" : "已记录评估不参与当前许可"} onSelect={key => { setRiskFilter(key); openSection('risk') }}/>
        </div>}
        {attentionInstances.length > 0 && <section className="harness-gateway-attention"><h3>需要处理</h3>{attentionInstances.map(instance => <div key={instance.instanceId}><span><strong>{instance.instanceId}</strong> · {!instance.applied ? applicationLabel(instance) : '身份异常'}</span><button type="button" onClick={() => void viewCurrentInstance(instance)}>查看实例</button></div>)}</section>}
        <div className="harness-section-heading"><div><h3>当前业务实例</h3>{instanceObservation.observedAt && <small>实例登记核对于 {instanceObservation.observedAt}</small>}</div>{chartFilter && <button type="button" onClick={() => setChartFilter('')}>清除筛选 · {overviewInstances.length} 个实例</button>}</div>
        {instanceObservation.phase === 'ready' && automaticRiskEnabled && data.agentStatuses.some(item => currentInstanceIds.has(item.instanceId) && item.authentication.status !== 'not_required') && (!freshFacts.length || highRiskCount > 0 || unknownRiskCount > 0) && <div className="harness-gateway-risk-notice" role="status"><div><strong>{!currentRisks.length ? '尚无风险评估，当前许可待核对' : !freshFacts.length ? '风险评估已过期，需要复核当前许可' : riskOverview}</strong><p>{!freshFacts.length ? '没有有效评估事实，不等于已确认高风险；请核对评估范围与证据。' : '请核对评估范围与证据，再判断当前许可。'}</p></div><button className="harness-gateway-text-button" type="button" onClick={() => openSection('risk')}>查看评估 →</button></div>}
        {overviewInstances.length ? <div className="harness-table-scroll harness-gateway-overview-table"><table><thead><tr><th>业务实例</th><th>实际装载</th><th>身份核验</th><th>访问配置</th><th>配置应用</th><th><span className="harness-gateway-visually-hidden">操作</span></th></tr></thead><tbody>{overviewInstances.map(value => {
          const identity = data.agentStatuses.find(item => item.instanceId === value.instanceId)
          const access = data.configuration.agents.find(item => item.agentId === value.agentId)
          const outcome = identityResult(identity)
          return <tr key={value.instanceId}><td><strong>{value.instanceId}</strong><small>{agentCatalog?.agents.find(item => item.id === value.agentId)?.name || value.agentId}</small></td>
            <td><span>来源已登记</span><GatewayWindow title={`${value.instanceId} · 来源与代次`} trigger="查看来源与代次" active={active && section === 'overview'} identity={`${value.instanceId}:${value.runtimeGeneration}`}><dl className="harness-fields"><div><dt>实际来源</dt><dd><code>{value.sourceDigest}</code></dd></div><div><dt>该实例固定来源</dt><dd><code>{value.pinnedSourceDigest || '尚未固定'}</code></dd></div><div><dt>当前代次</dt><dd>{value.runtimeGeneration}</dd></div></dl></GatewayWindow></td>
            <td><span className="harness-gateway-badge" data-state={outcome.state}>● {outcome.label}</span></td>
            <td>{identity?.authentication.status === 'not_required' ? '未发布，全部放行、不评估风险' : access ? data.enabled && access.enabled ? '已开放' : '已关闭' : '未配置'}</td>
            <td><span className="harness-gateway-badge" data-state={isCurrentApplied(value) ? 'success' : 'pending'}>● {applicationLabel(value)}</span></td>
            <td><button className="harness-gateway-text-button" type="button" onClick={() => { setAccessAgentIndex(Math.max(0, agentDrafts.findIndex(row => row.agentId === value.agentId))); openSection('authorization') }}>访问配置</button></td></tr>
        })}</tbody></table></div> : <div className="harness-gateway-access-empty"><strong>{instanceObservation.phase !== 'ready' ? '当前实例范围尚未确认' : chartFilter ? '没有符合筛选的实例' : '暂无已登记业务实例'}</strong><p>{instanceObservation.phase === 'ready' ? '配置保存不表示实例已应用。创建实例并取得回执后，这里才会显示实际状态。' : '登记读取完成前不把历史观察标为当前异常或成功。'}</p></div>}
        <section className="harness-gateway-runtime-section" aria-label="运行处置">
        <div className="harness-section-heading"><h3>运行处置</h3><p>当前限制与手动处理；不代替风险提供方的动态评估。</p></div>
        <div className="harness-gateway-runtime-layout"><div><h3>当前限制</h3>
        {data.restrictions.some(value => value.active) ? <ul className="harness-gateway-list">{data.restrictions.filter(value => value.active).map(value => <RestrictionRow key={value.id} value={value} sessions={data.sessionTrustFacts ?? []} busy={busy} perform={perform} />)}</ul> : <p>暂无当前限制。</p>}
        </div><section id="gateway-reassess" tabIndex={-1} className="harness-gateway-manual" aria-label="手动添加限制或辅助重评"><h3>手动添加限制或辅助重评</h3><p>指定实例与接入用户范围。</p>
        <form className="harness-gateway-restriction-form" aria-label="手动运行限制配置" onSubmit={event => { event.preventDefault(); void restrictSelected() }}>
          <div className="harness-gateway-restriction-target">
            <label className="harness-gateway-field"><span>业务实例</span><select required value={instanceId} onChange={event => { setInstanceId(event.target.value); setSelectedSubjectIds([]); setSessionId('') }}><option value="">请选择实例</option>{currentInstances.map(value => <option key={value.instanceId} value={value.instanceId}>{value.instanceId}（{value.agentId}）</option>)}</select></label>
            <label className="harness-gateway-field"><span>动作</span><select value={action} onChange={event => setAction(event.target.value)}>{Object.entries(actionNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          </div>
          <fieldset className="harness-gateway-subject-picker"><legend>要限制的接入用户（可多选）</legend>
            {agent?.subjects.length ? <div className="harness-gateway-choice-list">{agent.subjects.map(value => <label key={value} className="harness-gateway-option" data-selected={selectedSubjectIds.includes(value)}><input type="checkbox" checked={selectedSubjectIds.includes(value)} onChange={event => {
              setSelectedSubjectIds(current => event.target.checked ? [...current, value] : current.filter(id => id !== value))
              if (event.target.checked && selectedSubjectIds.length && sessionId) { setSessionId(''); setRuntimeFeedback('已选多位接入用户，Session ID 已清空；限制将覆盖这些用户在所选实例的会话。') }
            }} />{value}</label>)}</div> : <p>此 Agent 尚无获准用户；请先到“访问控制”设置。</p>}
            <small>只列出“访问控制”中获准使用此 Agent 的用户。此处选择限制对象，不会授予使用权。</small>
          </fieldset>
          <label className="harness-gateway-field"><span>Session ID（可选；辅助重评时必填）</span><input maxLength={500} disabled={selectedSubjects.length > 1} value={sessionId} onChange={event => setSessionId(event.target.value)} /><small>选多位用户时，限制覆盖他们在此实例的全部会话；若只限制一个 Session，请只选一位用户。</small></label>
          <label className="harness-gateway-field"><span>收紧依据</span><input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <div className="harness-gateway-restriction-actions"><button type="submit" disabled={busy || !instance || !selectedSubjects.length || !reason.trim() || (!!sessionId.trim() && selectedSubjects.length !== 1)}>收紧所选用户的动作</button><button type="button" disabled={busy || !automaticRiskEnabled || !scope || !sessionId.trim()} onClick={() => void perform('reassess', { sessionId: sessionId.trim(), action, scope }).then(result => setRuntimeFeedback(result.message))}>辅助重评当前 Session</button></div>
        </form>
        {!automaticRiskEnabled && <p className="harness-gateway-description">自动风险评估已关闭，辅助重评不可用；手动限制仍然可用。<button type="button" className="harness-gateway-text-button" onClick={() => { openSection('risk'); window.requestAnimationFrame?.(() => { const area = document.getElementById('gateway-risk-provider'); area?.scrollIntoView({ block: 'start' }); area?.focus() }) }}>配置风险评估提供方</button></p>}
        {runtimeFeedback && <p role="status">{runtimeFeedback}</p>}
        <p>收紧必须处于各用户的基础许可内；多选会分别建立限制。填写 Session 后进一步限定单个用户的会话。重新评估只更新风险事实。</p>

        </section></div>

        <div className="harness-gateway-detail-links"><GatewayWindow title="已解除限制" trigger={`已解除限制（${data.restrictions.filter(value => !value.active).length}）`} active={active && section === 'overview'}>{data.restrictions.some(value => !value.active) ? <ul className="harness-gateway-list">{data.restrictions.filter(value => !value.active).map(value => <li key={value.id}><strong>{value.scope.subjectId} · {value.scope.agentId} · {value.scope.instanceId ?? '所选工作区内匹配实例'}</strong>{value.scope.sessionId && <p>会话 {value.scope.sessionId}</p>}<p>{value.deniedActions.map(item => actionNames[item] ?? item).join('、')}：{value.reason}</p></li>)}</ul> : <p>暂无已解除限制。</p>}</GatewayWindow></div></section>
        <div className="harness-gateway-detail-links">{historicalInstances.length > 0 && <GatewayWindow title="历史网关记录" trigger={`历史网关记录 · ${historicalInstances.length} 项已不在当前实例登记`} active={active && section === 'overview'} footer={<button type="button" onClick={() => onNavigate?.({ page: 'instances' })}>前往实例列表</button>}><p>以下是保留的历史观察，不计入当前分布或待处理事项。</p><ul className="harness-gateway-list">{historicalInstances.map(instance => <li key={instance.instanceId}><strong>{instance.instanceId}</strong> · {instance.agentId}<p>来源 {instance.sourceDigest} · 历史代次 {instance.runtimeGeneration}{instance.acknowledgement?.at && ` · 上次回执 ${instance.acknowledgement.at}`}</p></li>)}</ul></GatewayWindow>}
        <GatewayWindow title="管理范围与验证边界" active={active && section === 'overview'}><p>当前工作区经统一业务网关访问的业务实例。未发布实例全部放行；发布实例按风险策略限制高风险 MCP 调用。</p><p>原生定时任务已开放，到期投递与实际业务执行分别核对，自动检测与防护闭环尚待验证。</p></GatewayWindow>
        <GatewayWindow title="最近操作与执行结果" trigger={`最近操作与执行结果 · ${Math.min(data.events.length, 30)} 条`} active={active && section === 'overview'}>
        {data.events.length ? <div className="harness-table-scroll harness-gateway-drawer-table"><table><thead><tr><th>时间</th><th>接入用户／会话</th><th>动作／操作</th><th>结果</th><th>依据</th></tr></thead><tbody>{data.events.slice(-30).reverse().map(value => <tr key={value.id}>
          <td>{value.at}</td><td>{value.subjectId} / {value.sessionId}</td><td>{value.action} / {value.operationId}</td><td>{value.outcome}</td><td>{value.reason ?? '—'}</td>
        </tr>)}</tbody></table></div> : <p>暂无受管执行记录。</p>}</GatewayWindow></div>
        </section>}</div>
        {draft && <GatewayWindow title="确认保存业务访问配置" trigger={null} editing open={previewOpen} onOpenChange={setPreviewOpen} closeLabel="返回修改" onClose={previewReturn.current ? returnFromPreview : undefined} active={active} disabled={busy}>
          <p>摘要随当前草稿更新；确认后保存以下配置，再按对应版本的实例回执判断应用结果。</p>
          <dl className="harness-gateway-preview-facts"><dt>配置对象</dt><dd>{agentDrafts.map(row => row.agentId || '未选择智能体').join('、') || '尚无业务智能体'}</dd>
            <dt>业务入口</dt><dd>{draft.enabled ? '开放' : '关闭'} · 单次请求仍需核对</dd>
            <dt>访问决策来源</dt><dd>{draft.accessAuthorization.enabled ? '第三方优先；未返回有效决定时使用手动兜底，明确禁止仍禁止' : '未配置第三方，使用手动兜底策略'}</dd><dt>访问控制服务</dt><dd>{draft.accessAuthorization.enabled ? draft.accessAuthorization.endpoint || '保留已配置的私有地址' : '未启用'}</dd><dt>手动兜底范围</dt><dd>{agentDrafts.length ? agentDrafts.map((row, index) => <p key={index}>{row.agentId || '待配置智能体'}：{row.enabled ? '已开放' : '未开放'} · {row.serverIds === undefined ? '按已登记操作开放服务' : row.serverIds.length ? `服务 ${row.serverIds.join('、')}` : '无已选服务'} · 接入用户 {row.subjects.length ? row.subjects.join('、') : '未配置'} · 动作 {row.actions.length ? row.actions.map(value => accessActionNames[value] ?? '未识别历史权限（保留）').join('、') : '未选择'}</p>) : '尚未配置'}</dd>
            <dt>手动兜底条件规则</dt><dd>{agentDrafts.some(row => Array.isArray(row.toolPolicies) && row.toolPolicies.length) ? agentDrafts.flatMap(row => (Array.isArray(row.toolPolicies) ? row.toolPolicies : []).filter(editableToolPolicy).map(policy => <div key={`${row.agentId}:${policy.serverId}`}><strong>{row.agentId} · {serviceCatalog.find(server => server.id === policy.serverId)?.name || policy.serverId}</strong><p>默认：{policy.defaultEffect === 'allow' ? '按基础权限允许' : effectLabels[policy.defaultEffect]} · {policy.rules.length} 条条件规则</p>{policy.rules.map((rule, index) => <p key={index}>{toolRuleSummary(rule, operationDrafts.filter(operation => operation.serverId === policy.serverId).map(operation => ({ id: operation.operationId, label: operation.operationId, kind: operation.kind })))}</p>)}{policyRangeWarnings(policy, row.actions, operationDrafts.filter(operation => operation.serverId === policy.serverId).map(operation => ({ id: operation.operationId, label: operation.operationId, kind: operation.kind }))).map(text => <p key={text} className="harness-gateway-policy-warning">{text}</p>)}</div>)) : '沿用已有基础权限；未新增服务条件策略'}</dd>
            <dt>实际操作目标</dt><dd>{operationDrafts.length ? operationDrafts.map((row, index) => <p key={index}>{row.serverId || '未填写服务'} · {row.operationId || '未填写操作'} · {row.method || '未选方法'} · {row.target || (row.targetHidden ? '原目标已保留' : '未填写目标')}</p>) : '尚未登记操作'}</dd>
          </dl>
          <p className="harness-gateway-preview-warning">{riskOverview}。保存配置不表示身份核验、风险许可或目标实例已经应用。</p>
          <div className="harness-gateway-preview-actions"><button className="harness-primary" type="button" disabled={busy || conflict || !dirty(draft)} onClick={saveDraft}>{dirty(draft) ? '确认保存业务访问配置' : '当前没有待保存更改'}</button></div>
        </GatewayWindow>}
      </>}
  </main></GatewayWindows>
}
