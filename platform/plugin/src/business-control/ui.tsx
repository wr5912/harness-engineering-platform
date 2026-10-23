import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformNavigation, type PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { agentAccessActions, businessOperationMethods, type AgentAccessRule } from './contracts.ts'
import type { BusinessControlManagementStatus, BusinessProviderView } from './management.ts'
import { businessControlStyle } from './style.ts'

type ProviderDraft = { enabled: boolean; endpoint: string; endpointHidden: boolean; timeout: string; testRunId: string }
type Draft = { revision: string; enabled: boolean; agents: string; operations: string; authentication: ProviderDraft; identityTrust: ProviderDraft
  riskAssessment: ProviderDraft; requiredKinds: string; inputMarkers: string; operationMarkers: string; reportMarkers: string; base: string }
type AgentCatalog = { agents: { id: string; name?: string; active_experiment?: string | null; version_count?: number }[]; experiments: { id: string; agent_id: string }[] }
type AgentDescription = { agentId: string; source: { experimentId: string; basis: string } | null; name: string | null; description: string | null;
  skills: { skillId: string; skillName: string | null; skillDescription: string | null; verification: 'discovered' }[] }
type ProviderProbe = { network: 'httpResponded' | 'timeout' | 'noResponse'; httpStatus?: number; checkedAt: string; durationMs: number;
  contractChecked: false; businessChecked: false }
type Section = 'overview' | 'identity' | 'risk' | 'authorization'
const serialized = ({ revision: _revision, base: _base, ...value }: Draft) => JSON.stringify(value)
const dirty = (draft: Draft) => serialized(draft) !== draft.base
const lines = (text: string) => text.split(/[,\n]/).map(value => value.trim()).filter(Boolean)
// 保留键入中的分隔符；保存时由管理入口校验并规范化数组元素。
const draftList = (text: string) => text ? text.split(',') : []
const markerLines = (text: string) => text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
function draftOf(data: BusinessControlManagementStatus): Draft {
  const provider = (value?: BusinessProviderView): ProviderDraft => ({ enabled: value?.configured ?? false, endpoint: value?.endpoint ?? '', endpointHidden: value?.endpointHidden ?? false,
    timeout: value?.timeoutMs === undefined ? '' : String(value.timeoutMs), testRunId: value?.testRunId ?? '' })
  const value: Draft = { revision: data.revision, enabled: data.configuration.enabled, agents: JSON.stringify(data.configuration.agents, null, 2),
    operations: JSON.stringify(data.configuration.operations ?? [], null, 2), authentication: provider(data.configuration.authentication), identityTrust: provider(data.configuration.identityTrust),
    riskAssessment: provider(data.configuration.riskAssessment), requiredKinds: (data.configuration.riskAssessment?.requiredKinds ?? ['write', 'publish']).join(', '),
    inputMarkers: (data.configuration.detection?.inputMarkers ?? []).join('\n'), operationMarkers: (data.configuration.detection?.operationMarkers ?? []).join('\n'),
    reportMarkers: (data.configuration.detection?.reportMarkers ?? []).join('\n'), base: '' }
  value.base = serialized(value)
  return value
}
function providerPayload(value: ProviderDraft, fixture = false) {
  return !value.enabled ? null : { ...(value.endpoint.trim() || !value.endpointHidden ? { endpoint: value.endpoint.trim() } : {}),
    timeoutMs: value.timeout.trim() ? Number(value.timeout) : null, ...(fixture ? { testRunId: value.testRunId.trim() || null } : {}) }
}
function ProviderFields({ title, kind, value, current, revision, rpc, change }: { title: string; kind: 'authentication' | 'identityTrust' | 'riskAssessment';
  value: ProviderDraft; current: BusinessProviderView; revision: string; rpc: PlatformPageProps['rpc']; change(value: ProviderDraft): void }) {
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
  return <div className="harness-composition-editor">
    <p>{current.mode === 'test-mock' ? '当前保存的是测试模拟提供方。' : current.configured ? '已配置提供方。' : '尚未配置提供方。'}配置与 HTTP 响应均不代表身份核验或风险评估已通过。</p>
    <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={value.enabled} onChange={event => change({ ...value, enabled: event.target.checked })} />启用{title}</label>
    <label>{title}地址<input data-gateway-field={`${kind}-endpoint`} type="url" value={value.endpoint} placeholder={value.endpointHidden ? '原地址含私有部分，留空保留；可填写新的无凭据地址' : 'http://127.0.0.1:53101/api/v1/control/…'} onChange={event => change({ ...value, endpoint: event.target.value })} /></label>
    <label>{title}超时（毫秒）<input data-gateway-field={`${kind}-timeout`} type="number" min={1} max={60000} placeholder="默认 1500" value={value.timeout} onChange={event => change({ ...value, timeout: event.target.value })} /></label>
    {kind === 'riskAssessment' && <label>{title}测试 fixture ID（可选）<input value={value.testRunId} onChange={event => change({ ...value, testRunId: event.target.value })} /></label>}
    <div className="harness-gateway-probe"><button type="button" disabled={probing || !canProbe || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000} onClick={() => void check()}>{probing ? '正在探测…' : '测试 HTTP 响应'}</button>
      {probe && <small role="status">{probe.network === 'httpResponded' ? `收到 HTTP ${probe.httpStatus} 响应${probe.httpStatus === 404 ? '；请核对路径' : ''}` : probe.network === 'timeout' ? '连接超时' : '未收到 HTTP 响应'} · {probe.durationMs} 毫秒。POST 合同及业务结果未验证。</small>}
      {probeError && <small role="alert">{probeError}</small>}</div>
    {value.endpointHidden && <p>原地址不回传私有部分；未填写新地址时保留原配置。提供方地址不接受用户名、密码、查询参数或片段。</p>}
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
  if (JSON.stringify(draft.riskAssessment) !== JSON.stringify(base.riskAssessment) || draft.requiredKinds !== base.requiredKinds
    || draft.inputMarkers !== base.inputMarkers || draft.operationMarkers !== base.operationMarkers || draft.reportMarkers !== base.reportMarkers) changed.add('risk')
  if (draft.enabled !== base.enabled || draft.operations !== base.operations) changed.add('authorization')
  if (draft.agents !== base.agents) {
    try {
      const rows = JSON.parse(draft.agents) as AgentAccessRule[], previous = JSON.parse(base.agents) as AgentAccessRule[]
      const identity = (value: AgentAccessRule[]) => value.map(row => [row.agentId, row.agentAuthentication, row.agentTrust, row.sourceDigest])
      const access = (value: AgentAccessRule[]) => value.map(row => [row.agentId, row.enabled, row.subjects, row.actions, row.serverIds])
      if (JSON.stringify(identity(rows)) !== JSON.stringify(identity(previous))) changed.add('identity')
      if (JSON.stringify(access(rows)) !== JSON.stringify(access(previous))) changed.add('authorization')
      if (!changed.has('identity') && !changed.has('authorization')) changed.add('authorization')
    } catch { changed.add('authorization') }
  }
  return changed
}
function draftError(draft: Draft): { section: Section; field: string; message: string } | null {
  for (const [kind, section] of [['authentication', 'identity'], ['identityTrust', 'identity'], ['riskAssessment', 'risk']] as const) {
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
    try { if (!Array.isArray(JSON.parse(value))) throw new Error() }
    catch { return { section: 'authorization', field, message: 'Agent 规则或操作授权 JSON 必须是数组' } }
  }
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
  return <li>
    <strong>{value.active ? '限制中' : '已解除'}</strong> · {value.scope.subjectId} · {value.scope.agentId} · {value.scope.instanceId ?? '所选工作区内匹配实例'}{value.scope.sessionId ? ` · ${value.scope.sessionId}` : ''}
    <p>{value.deniedActions.map(item => actionNames[item] ?? item).join('、')}：{value.reason}</p>
    {value.active && <div className="harness-gateway-release">
      <label>匹配的 Session ID<input list={`gateway-sessions-${value.id}`} value={sessionId} readOnly={!!value.scope.sessionId} onChange={event => setSessionId(event.target.value)} placeholder="选择或填写该限制范围内的 Session" /></label>
      <datalist id={`gateway-sessions-${value.id}`}>{choices.map(item => <option key={item.sessionId} value={item.sessionId}>{item.state === 'expired' ? '身份记录已过期' : '已观察到的会话'}</option>)}</datalist>
      {value.deniedActions.length > 1 && <label>评估动作<select value={action} onChange={event => setAction(event.target.value)}>{value.deniedActions.map(item => <option key={item} value={item}>{actionNames[item] ?? item}</option>)}</select></label>}
      <button type="button" disabled={busy || !sessionId.trim()} onClick={() => void release()}>重新评估并解除</button>
    </div>}
    {feedback && <p role="status">{feedback}</p>}
  </li>
}

export function BusinessControlPage({ rpc, updates, active = true, target, onNavigate }: PlatformPageProps & { updates?: PlatformUpdates; active?: boolean;
  target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void }) {
  const [data, setData] = useState<BusinessControlManagementStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewDialog = useRef<HTMLDivElement | null>(null)
  const [localSection, setLocalSection] = useState<Section>('overview')
  const [accessAgentIndex, setAccessAgentIndex] = useState(0)
  const [identityEditorOpen, setIdentityEditorOpen] = useState(false)
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
  const [serviceSuggestions, setServiceSuggestions] = useState<string[]>([])
  const [runtimeFeedback, setRuntimeFeedback] = useState('')
  const [lastStatusAt, setLastStatusAt] = useState('')
  const requestId = useRef(0)
  const reading = useRef<number | null>(null)
  const mounted = useRef(true)
  const mutating = useRef(false)
  function accept(value: BusinessControlManagementStatus) {
    setData(value)
    setLastStatusAt(new Date().toLocaleString())
    setDraft(previous => {
      if (previous && dirty(previous)) return previous
      return draftOf(value)
    })
    setInstanceId(previous => previous || value.instances[0]?.instanceId || '')
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
  useEffect(() => { if (!active) setPreviewOpen(false) }, [active])
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
    setBusy(true); setError(''); setNotice('')
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
        : '重新评估后已解除所选限制；新请求仍会重验身份和许可，没有重放业务。'
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
  const instance = data?.instances.find(value => value.instanceId === instanceId)
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
      if (invalid.section === 'identity') setIdentityEditorOpen(true)
      openSection(invalid.section)
      window.requestAnimationFrame?.(() => { const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-gateway-field="${invalid.field}"]`)
        for (let parent = field?.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true
        field?.focus() })
      return false
    }
    return true
  }
  function openPreview() { if (validateDraft()) setPreviewOpen(true) }
  function saveDraft() {
    if (!validateDraft() || !draft) return
    setPreviewOpen(false)
    void perform('saveConfiguration', { revision: draft.revision, enabled: draft.enabled, agents: JSON.parse(draft.agents), operations: JSON.parse(draft.operations),
      authentication: providerPayload(draft.authentication), identityTrust: providerPayload(draft.identityTrust),
      riskAssessment: draft.riskAssessment.enabled ? { ...providerPayload(draft.riskAssessment, true), requiredKinds: lines(draft.requiredKinds) } : null,
      detection: { inputMarkers: markerLines(draft.inputMarkers), operationMarkers: markerLines(draft.operationMarkers), reportMarkers: markerLines(draft.reportMarkers) } })
  }
  let agentDrafts: AgentAccessRule[] = [], operationDrafts: any[] = []
  try { const parsed = JSON.parse(draft?.agents ?? '[]'); if (Array.isArray(parsed)) agentDrafts = parsed } catch { /* 高级编辑中的未完成JSON保持草稿。 */ }
  try { const parsed = JSON.parse(draft?.operations ?? '[]'); if (Array.isArray(parsed)) operationDrafts = parsed } catch { /* 同上。 */ }
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
    void rpc.call(CHANNEL, 'mcp/list', {}).then(response => {
      if (!disposed && response.ok) setServiceSuggestions((response.value as { connections?: { id: string }[] }).connections?.map(value => value.id) ?? [])
    }).catch(() => { /* 操作允许清单仍可手工登记服务 ID。 */ })
    return () => { disposed = true }
  }, [active, section, rpc])
  useEffect(() => {
    if (!draft || !dirty(draft)) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draft])
  useEffect(() => {
    if (!previewOpen || typeof document === 'undefined') return
    const previousFocus = document.activeElement as HTMLElement | null
    previewDialog.current?.focus()
    return () => previousFocus?.focus?.()
  }, [previewOpen])
  const registeredServerIds = [...new Set(operationDrafts.map(row => String(row.serverId ?? '').trim()).filter(Boolean))]
  const changeAgent = (index: number, value: Partial<AgentAccessRule>) => { if (draft) setDraft({ ...draft, agents: JSON.stringify(agentDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const selectAgent = (index: number, agentId: string) => {
    if (!agentCatalog?.agents.some(value => value.id === agentId) || agentDrafts[index]?.agentId === agentId) return
    // 更换配置对象不能沿用上一智能体的来源和身份启用状态。
    changeAgent(index, { agentId, enabled: false, sourceDigest: undefined, agentTrust: { enabled: false } })
  }
  const changeOperation = (index: number, value: Record<string, unknown>) => { if (draft) setDraft({ ...draft, operations: JSON.stringify(operationDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const addAgent = () => { if (draft) { setAccessAgentIndex(agentDrafts.length); setDraft({ ...draft, agents: JSON.stringify([...agentDrafts, { agentId: '', enabled: false, subjects: [], actions: ['read'], serverIds: [], agentAuthentication: { enabled: true, method: 'hmac-sha256' }, agentTrust: { enabled: false } }], null, 2) }); openSection('identity') } }
  const freshFacts = data?.riskFacts.filter(value => Date.parse(value.expiresAt) > Date.now()) ?? []
  const highRiskCount = freshFacts.filter(value => value.level === 'high').length
  const unknownRiskCount = freshFacts.filter(value => value.status === 'unknown' || value.level === 'unknown' || value.level === undefined).length
  const riskOverview = !data?.riskFacts.length ? '尚无评估' : !freshFacts.length ? '评估已过期'
    : unknownRiskCount ? '存在未知评估' : `已评估范围内 ${highRiskCount} 项高风险`
  const riskLabel = !data?.riskFacts.length ? '尚无评估' : !freshFacts.length ? '已过期'
    : unknownRiskCount ? '结果未知' : highRiskCount ? '高风险' : '当前范围已评估'
  const latestRiskFact = data?.riskFacts.reduce<BusinessControlManagementStatus['riskFacts'][number] | undefined>((latest, fact) => !latest || Date.parse(fact.observedAt) > Date.parse(latest.observedAt) ? fact : latest, undefined)
  const riskNext = !data?.riskFacts.length ? '等待下一次受管业务事件，或为已知 Session 发起辅助重评'
    : !freshFacts.length ? '选择匹配的 Session 重新评估，再核对新证据'
      : unknownRiskCount ? '核对提供方响应与未知评估的依据'
        : highRiskCount ? '核对高风险信号与当前限制' : '执行时仍按实际请求重新判断许可'
  const publishedStatuses = data?.agentStatuses.filter(value => value.authentication.status !== 'not_required') ?? []
  const trustedInstances = publishedStatuses.filter(value => value.authentication.status === 'verified' && value.trust.status === 'trusted').length
  const appliedInstances = data?.instances.filter(value => value.applied).length ?? 0
  const activeAgentIndex = Math.min(accessAgentIndex, Math.max(0, agentDrafts.length - 1))
  const accessAgent = agentDrafts[activeAgentIndex]
  const statusCards = data && <>
    <span><span className="harness-gateway-stat-label">即时访问 <GatewayIcon kind="external" /></span><strong>{data.enabled ? '已开放' : '已关闭'}</strong><small>{data.enabled ? '开放配置 · 单次请求仍需判定' : '当前配置未开放即时访问'}</small></span>
    <span title="仅统计对外服务实例的发布身份验证"><span className="harness-gateway-stat-label">发布身份核验 <GatewayIcon kind="shield" /></span><strong>{trustedInstances} <small>/ {publishedStatuses.length}</small></strong><small>{publishedStatuses.length ? trustedInstances === publishedStatuses.length ? '对外服务实例已核验' : '对外服务实例身份待核对' : data.instances.length ? '开发调试实例不要求发布身份签名' : '尚无已登记实例'}</small></span>
    <span title={`有效事实 ${freshFacts.length} / ${data.riskFacts.length} · 高风险 ${highRiskCount} · 未知 ${unknownRiskCount}`}><span className="harness-gateway-stat-label">风险评估 <GatewayIcon kind="alert" /></span><strong data-summary="risk" className={!freshFacts.length || unknownRiskCount || highRiskCount ? 'harness-gateway-warning-text' : undefined}>{riskOverview}</strong><small><button className="harness-gateway-text-button" type="button" onClick={() => openSection('risk')}>查看评估，复核当前许可 →</button></small></span>
    <span><span className="harness-gateway-stat-label">配置应用 <GatewayIcon kind="check" /></span><strong>{appliedInstances} <small>/ {data.instances.length}</small></strong><small>{data.instances.length ? appliedInstances === data.instances.length ? '目标实例已确认应用' : '目标实例应用待核对' : '尚无目标实例'}</small></span>
  </>
  return <main className="harness-mcp-page harness-gateway-page" aria-label="统一网关管理">
      <style>{businessControlStyle}</style>
      <header className="harness-page-heading"><div><h1>统一网关</h1><p>管理业务访问、智能体身份与配置应用状态。</p></div><button className="harness-gateway-refresh" type="button" disabled={busy} onClick={() => { void refresh(); setAgentCatalogRevision(value => value + 1) }}><GatewayIcon kind="refresh" />刷新状态</button></header>
      {error && <p role="alert">{error}</p>}
      {loadError && <p role="alert">{loadError}{data && `；以下为上次成功读取的状态（${lastStatusAt || '时间未知'}），当前许可需重新核对。`}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data ? <section className="harness-card">{loadError ? <><h2>无法读取统一网关状态</h2><p>当前访问范围和实例回执尚未确认。</p><button type="button" onClick={() => void refresh()}>重新读取</button></> : <p role="status">正在读取统一网关状态…</p>}</section> : <>
        <div className="harness-gateway-status harness-gateway-status-desktop" aria-label="统一网关状态概览">
          {statusCards}
        </div>
        <div className="harness-gateway-mobile-status" aria-label="统一网关状态概览"><div><strong>即时访问 {data.enabled ? '已开放' : '已关闭'} · 发布身份 {trustedInstances}/{publishedStatuses.length}</strong><span className="harness-gateway-risk-badge">● {riskOverview}</span></div><p>{data.instances.length ? `配置 ${appliedInstances}/${data.instances.length} 已应用` : '配置尚无目标实例'} · <button className="harness-gateway-text-button" type="button" onClick={() => openSection('risk')}>复核当前许可</button></p></div>
        {conflict && <p role="alert">配置已在其他位置更新，当前草稿已保留。请复制需要的修改，放弃草稿后按最新版本编辑；旧草稿不能覆盖新配置。</p>}
        <nav className="harness-mcp-toolbar harness-mcp-tabs harness-gateway-main-tabs" role="tablist" aria-label="统一网关视图" onKeyDown={event => {
          const index = configurationTabs.findIndex(tab => tab.id === section)
          const next = event.key === 'ArrowRight' ? (index + 1) % configurationTabs.length : event.key === 'ArrowLeft' ? (index + configurationTabs.length - 1) % configurationTabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? configurationTabs.length - 1 : -1
          if (next < 0) return
          event.preventDefault(); openSection(configurationTabs[next].id)
          window.requestAnimationFrame?.(() => document.querySelector<HTMLButtonElement>(`[data-gateway-tab="${configurationTabs[next].id}"]`)?.focus())
        }}>{configurationTabs.map(tab => <button key={tab.id} data-gateway-tab={tab.id} role="tab" aria-selected={section === tab.id} aria-controls="gateway-panel" tabIndex={section === tab.id ? 0 : -1} type="button" onClick={() => openSection(tab.id)}>{tab.label}{dirtyPages.has(tab.id) && <span className="harness-gateway-dirty-dot" aria-label="有未保存更改"> ●</span>}</button>)}</nav>
        {draft && dirty(draft) && <div className="harness-gateway-savebar"><div><strong>有未保存更改</strong><small>一次保存全部配置；实例应用状态见运行概览。</small></div><div className="harness-mcp-actions">{section !== 'authorization' && <button className="harness-primary" type="button" disabled={busy || conflict} onClick={openPreview}>预览配置</button>}<button type="button" disabled={busy} onClick={() => { if (window.confirm?.('放弃全部未保存更改并读取当前配置？') ?? true) resetDraft() }}>放弃草稿并读取当前配置</button></div></div>}
        <div className="harness-gateway-workspace" id="gateway-panel" role="tabpanel" aria-label={configurationTabs.find(tab => tab.id === section)?.label}>
        {section !== 'overview' && <section className="harness-card harness-composition-detail" aria-label="功能配置">
        <div className="harness-section-heading"><div><h2>{configurationTabs.find(tab => tab.id === section)?.label}</h2><p className="harness-gateway-description">{section === 'authorization' ? '配置智能体可访问的服务、动作与实际目标。' : section === 'identity' ? '可读名称用于识别，稳定 ID 用于核对与复制。' : latestRiskFact ? `最近评估：${latestRiskFact.scope.agentId}${latestRiskFact.scope.instanceId ? ` · ${latestRiskFact.scope.instanceId}` : ''}` : '当前工作区暂无评估事实。'}</p></div>{section === 'risk' ? <span className="harness-gateway-badge" data-state={riskLabel === '当前范围已评估' ? 'success' : 'pending'}>{riskLabel}</span> : section === 'authorization' && <span className="harness-gateway-draft-state">{draft && dirty(draft) ? '有未保存更改' : '配置草稿'}</span>}</div>
        {section === 'identity' && (data.instances.length ? <div className="harness-table-scroll harness-gateway-overview-table harness-gateway-identity-table"><table><thead><tr><th>智能体</th><th>Agent ID</th><th>业务实例</th><th>实际装载</th><th>核验结果</th></tr></thead><tbody>{data.instances.map(instance => {
          const status = data.agentStatuses.find(value => value.instanceId === instance.instanceId)
          const outcome = identityResult(status)
          return <tr key={instance.instanceId}><td><strong>{agentCatalog?.agents.find(value => value.id === instance.agentId)?.name || instance.agentId}</strong><details className="harness-gateway-mobile-identity-details"><summary>查看实例核验</summary><p>{instance.instanceId} · 代次 {instance.runtimeGeneration} · {outcome.label}</p><code>{instance.sourceDigest}</code></details></td><td><code>{instance.agentId}</code></td><td>{instance.instanceId}</td><td>代次 {instance.runtimeGeneration}<details><summary>查看来源</summary><code>{instance.sourceDigest}</code></details></td><td><span className="harness-gateway-badge" data-state={outcome.state}>● {outcome.label}</span></td></tr>
        })}</tbody></table></div> : <div className="harness-gateway-access-empty"><strong>暂无已登记业务实例</strong><p>实例运行并登记后，可在这里核对实际装载来源和身份结果。配置中的 Agent 身份不等于实例已核验。</p><button type="button" onClick={() => onNavigate?.({ page: 'instances' })}>前往实例管理</button></div>)}
        {section === 'risk' && <div className="harness-gateway-risk-summary"><div className="harness-gateway-risk-notice" role="status"><div><strong>{riskLabel === '已过期' ? '当前评估已超过有效期' : riskLabel === '尚无评估' ? '当前没有可用于判断许可的评估事实' : riskLabel === '结果未知' ? '当前评估包含未知结果' : riskLabel === '高风险' ? '当前评估范围内存在高风险' : '当前范围已有有效评估'}</strong><p>{riskLabel === '已过期' ? '请重新评估或核对有效证据；不能据此推断访问已允许或已阻止。' : '评估只覆盖记录的对象与动作；单次请求仍需核对当时的身份和访问配置。'}</p></div></div>
          <dl className="harness-gateway-risk-facts"><dt>评估范围</dt><dd>{latestRiskFact ? `${latestRiskFact.scope.agentId}${latestRiskFact.scope.instanceId ? ` · ${latestRiskFact.scope.instanceId}` : ''}${latestRiskFact.scope.subjectId ? ` · ${latestRiskFact.scope.subjectId}` : ''}` : '当前工作区尚无评估对象'}</dd><dt>最近评估</dt><dd>{latestRiskFact ? `${latestRiskFact.observedAt} · ${Date.parse(latestRiskFact.expiresAt) <= Date.now() ? '已过期' : latestRiskFact.status === 'unknown' ? '结果未知' : '当前有效'}` : '尚无记录'}</dd><dt>即时访问配置</dt><dd>{data.enabled ? '已开放' : '已关闭'}；单次请求的许可仍需核对</dd><dt>下一步</dt><dd>{riskNext}</dd></dl>
          <div className="harness-gateway-risk-actions"><button className="harness-primary" type="button" onClick={() => { openSection('overview'); window.requestAnimationFrame?.(() => { const target = document.getElementById('gateway-reassess'); target?.scrollIntoView({ block: 'start' }); target?.focus() }) }}>选择会话并辅助重评</button><details><summary>查看评估依据（{data.riskFacts.length}）</summary>{data.riskFacts.length ? <ul className="harness-gateway-list">{[...data.riskFacts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).map(fact => <li key={fact.id}><strong>{fact.scope.agentId} · {fact.scope.instanceId || '未限定实例'} · {Date.parse(fact.expiresAt) <= Date.now() ? '已过期' : fact.status === 'unknown' ? '结果未知' : fact.level === 'high' ? '高风险' : fact.level === 'low' ? '低风险' : '等级未知'}</strong><p>{fact.observedAt} · 有效期至 {fact.expiresAt} · {fact.signals.length ? fact.signals.map(signal => signal.reason).join('；') : '未附加风险信号'}</p></li>)}</ul> : <p>暂无已保存的评估事实。</p>}</details></div>
        </div>}
        {draft && <form noValidate className="harness-composition-editor harness-gateway-config" aria-label="统一网关配置" onSubmit={event => { event.preventDefault(); openPreview() }}>
          {section === 'identity' && <details className="harness-gateway-config-details" open={identityEditorOpen || !agentDrafts.length} onToggle={event => { if (event.target === event.currentTarget) setIdentityEditorOpen(event.currentTarget.open) }}><summary>配置智能体身份与可信来源</summary>{!agentDrafts.length && <div className="harness-gateway-empty"><strong>尚未配置业务 Agent</strong><p>先登记智能体身份并核对可信来源，再配置访问范围。</p><button type="button" className="harness-primary" onClick={addAgent}>配置首个 Agent</button></div>}<fieldset><legend>1．智能体身份</legend>
            <p>验证智能体的身份凭据、可信来源与实例绑定。身份过期、撤销或来源不匹配直接阻断访问，不折算成业务风险分数；低风险不能覆盖身份条件失败。</p>
            {!!descriptionAgentId && <section className="harness-gateway-description-card" aria-label="当前资产描述"><div className="harness-gateway-panel-heading"><div><h3>当前资产描述</h3><small>读取已启用 Experiment 的业务 Agent 资产；不等于实例已装载。</small></div>{agentDrafts.filter(row => row.agentId).length > 1 && <label>查看 Agent<select value={descriptionAgentId} onChange={event => setDescriptionSelection(event.target.value)}>{agentDrafts.filter(row => row.agentId).map(row => <option key={row.agentId} value={row.agentId}>{row.agentId}</option>)}</select></label>}</div>
              {descriptionLoading ? <p role="status">正在读取资产描述…</p> : descriptionError ? <p role="alert">{descriptionError}</p> : description ? <>
                <p><strong>{description.name ?? description.agentId}</strong> · Agent ID：<code>{description.agentId}</code> · {description.source ? `已启用来源 ${description.source.experimentId}` : '尚无已启用版本'}</p>
                <p>{description.description ?? '当前版本未登记描述。'}</p>
                <details><summary>已发现业务技能（{description.skills.length}）</summary>{description.skills.length ? <ul>{description.skills.map(skill => <li key={skill.skillId}><strong>{skill.skillName ?? skill.skillId}</strong>（{skill.skillId}）<p>{skill.skillDescription ?? '未登记技能描述。'} · 仅证明资产中已发现，不证明实例已装载或任务可执行。</p></li>)}</ul> : <p>当前版本未发现业务 Skill 文件。</p>}</details>
              </> : <p>尚无可展示的资产描述。</p>}
            </section>}
            <div className="harness-gateway-identity"><section aria-label="认证方式与凭据"><h3>认证方式与凭据</h3>
            <p>当前支持受信部署域内的 HMAC SHA-256 签名，只有有效的真实签名才显示已验证。</p>
            {!!agentDrafts.length && <label>搜索智能体<input type="search" value={agentQuery} placeholder="按名称或 Agent ID 搜索" onChange={event => setAgentQuery(event.target.value)} /></label>}
            {agentCatalogError ? <p role="alert">{agentCatalogError}<button type="button" onClick={() => setAgentCatalogRevision(value => value + 1)}>重试智能体列表</button></p>
              : !agentCatalog ? <p role="status">正在读取智能体列表…</p> : !agentCatalog.agents.length && <p>当前没有可选智能体，请先在智能体管理中新建。</p>}
            {agentDrafts.map((row, index) => <div key={index} className="harness-composition-editor harness-gateway-agent">
              <label>选择智能体<select aria-label={`选择智能体 ${index + 1}`} value={row.agentId ?? ''} disabled={!agentCatalog || !!agentCatalogError} onChange={event => selectAgent(index, event.target.value)}>
                <option value="" disabled>请选择已有智能体</option>
                {!!row.agentId && !agentCatalog?.agents.some(value => value.id === row.agentId) && <option value={row.agentId}>{row.agentId}（{agentCatalog && !agentCatalogError ? '当前未找到，保留配置' : '列表未就绪，保留配置'}）</option>}
                {agentCatalog?.agents.filter(value => value.id === row.agentId || `${value.name ?? ''} ${value.id}`.toLowerCase().includes(agentQuery.trim().toLowerCase())).map(value => <option key={value.id} value={value.id} disabled={agentDrafts.some((other, at) => at !== index && other.agentId === value.id)}>{value.name && value.name !== value.id ? `${value.name}（${value.id}）` : value.id}</option>)}
              </select></label>
              {!!row.agentId && agentCatalog && !agentCatalogError && !agentCatalog.agents.some(value => value.id === row.agentId) && <p role="status">该智能体当前未在资产列表中找到，原配置已保留。</p>}
              <label>Agent ID<input readOnly value={row.agentId ?? ''} placeholder="选择后自动关联" /></label>
              {!!row.agentId && <details><summary>查看版本与业务实例</summary><p>当前启用版本：{agentCatalog?.agents.find(value => value.id === row.agentId)?.active_experiment || '未记录'}</p><p>已登记版本：{agentCatalog?.experiments.filter(value => value.agent_id === row.agentId).map(value => value.id).join('、') || '当前无可展示记录'}</p>
                {data.instances.filter(value => value.agentId === row.agentId).map(value => <p key={value.instanceId}>{value.instanceId} · {value.runtimeGeneration} · 实际来源 <code>{value.sourceDigest}</code></p>)}
                {!data.instances.some(value => value.agentId === row.agentId) && <p>尚无该智能体的业务实例与来源登记。</p>}
              </details>}
              <small>选择后需分别核对来源、身份启用和访问策略。</small>
              <label>认证方式<select value="hmac-sha256" onChange={() => changeAgent(index, { agentAuthentication: { enabled: row.agentAuthentication?.enabled ?? true, method: 'hmac-sha256' } })}><option value="hmac-sha256">HMAC SHA-256（当前支持）</option></select></label>
              <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={row.agentAuthentication?.enabled ?? true} onChange={event => changeAgent(index, { agentAuthentication: { enabled: event.target.checked, method: 'hmac-sha256' } })} />启用该 Agent 的签名认证</label>
            </div>)}
            <p>当前签名和实例绑定状态请到“运行概览”核对。</p>
            </section><section aria-label="可信来源与身份状态"><h3>可信来源与身份状态</h3>
            <p>核对当前代次的有效签名、已建立的回执及固定来源。这里说明身份条件是否满足；当前访问策略是否应用另看实例回执。</p>
            {agentDrafts.map((row, index) => <div key={index} className="harness-composition-editor harness-gateway-agent"><strong>{row.agentId || '待填写 Agent'}</strong>
              <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={row.agentTrust?.enabled ?? true} onChange={event => changeAgent(index, { agentTrust: { enabled: event.target.checked } })} />允许该智能体身份（取消即撤销）</label>
              <label className="harness-mcp-wide">{row.agentId || 'Agent'} 的旧实例默认固定来源<input value={row.sourceDigest ?? ''} onChange={event => changeAgent(index, { sourceDigest: event.target.value || undefined })} placeholder="旧登记缺少实例专属摘要时使用" /></label>
            </div>)}
            <p>可信来源的实时核验结果请到“运行概览”核对。</p>
            </section></div>
            <details className="harness-gateway-auxiliary"><summary>辅助：接入用户认证与状态核验</summary>
              <p>这里验证接入用户及其有效状态，用于区分会话归属；智能体身份由上方独立核验。</p>
              <ProviderFields title="接入用户认证提供方" kind="authentication" value={draft.authentication} current={data.configuration.authentication} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, authentication: value })} />
              <ProviderFields title="接入用户状态核验提供方" kind="identityTrust" value={draft.identityTrust} current={data.configuration.identityTrust} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, identityTrust: value })} />
            </details>
          </fieldset></details>}
          {section === 'risk' && <details className="harness-gateway-config-details"><summary>配置风险评估提供方与检测范围</summary><fieldset><legend>2．风险评估</legend>
            <p>按业务事件实时自动评估各 Agent：输入、每个工具或资源执行步骤、报告发布与下载。风险变化自动参与执行许可；手动重评仅为辅助。空闲周期巡检不在首期范围。</p>
            <ProviderFields title="Agent 风险评估提供方" kind="riskAssessment" value={draft.riskAssessment} current={data.configuration.riskAssessment} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, riskAssessment: value })} />
            <label>必须自动评估的动作（逗号分隔）<input value={draft.requiredKinds} onChange={event => setDraft({ ...draft, requiredKinds: event.target.value })} placeholder="write, publish" /></label>
            <p>检测标记每行一个，仅验证已配置的检测接入，不代表通用攻击识别。</p>
            <div className="harness-composition-editor">{(['inputMarkers', 'operationMarkers', 'reportMarkers'] as const).map((key, index) => <label key={key}>{['输入检测标记', '执行参数检测标记', '报告检测标记'][index]}<textarea value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div>
          </fieldset></details>}
          {section === 'authorization' && <fieldset className="harness-gateway-access"><legend className="harness-gateway-visually-hidden">3．访问控制</legend>
            <div className="harness-gateway-access-fields">
              <label>业务智能体<select aria-label="业务智能体" value={String(activeAgentIndex)} disabled={!agentDrafts.length} onChange={event => setAccessAgentIndex(Number(event.target.value))}>{agentDrafts.map((row, index) => <option key={index} value={index}>{agentCatalog?.agents.find(value => value.id === row.agentId)?.name || row.agentId || `待配置智能体 ${index + 1}`} · {row.agentId || '未选择'}</option>)}</select></label>
              <label>关联实例实际装载<input readOnly value={accessAgent ? (() => { const instances = data.instances.filter(value => value.agentId === accessAgent.agentId); return instances.length ? `${instances.map(value => value.instanceId).join('、')} · ${instances.length} 个已登记` : '尚无关联实例' })() : '请先配置业务智能体'} /><small>装载来源与配置回执请在运行概览核对。</small></label>
            </div>
            {!agentDrafts.length && <div className="harness-gateway-access-empty"><p>尚无业务智能体配置。先登记身份，再设置访问范围。</p><button type="button" onClick={addAgent}>配置智能体身份</button></div>}
            {accessAgent && <>
              <div className="harness-gateway-switch-row"><label className="harness-gateway-switch-label">开放即时业务访问<span className="harness-gateway-switch"><input type="checkbox" role="switch" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /><span aria-hidden="true" /></span></label><small>仅覆盖经统一业务网关发起的即时任务。</small></div>
              <div className="harness-gateway-access-fields">
                <div className="harness-gateway-choices" role="group" aria-label={`允许访问的服务 ${activeAgentIndex + 1}`}><span>允许访问的服务</span>
                  <details className="harness-gateway-service-picker"><summary>{accessAgent.serverIds === undefined ? '按已登记操作开放服务' : accessAgent.serverIds.length ? accessAgent.serverIds.join('、') : '尚未选择服务'}</summary><div className="harness-gateway-service-options"><label className="harness-gateway-inline"><input type="checkbox" checked={accessAgent.serverIds !== undefined} onChange={event => changeAgent(activeAgentIndex, { serverIds: event.target.checked ? [] : undefined })} />仅允许所选服务</label>
                    {accessAgent.serverIds !== undefined && <div className="harness-gateway-choice-list">{[...new Set([...registeredServerIds, ...accessAgent.serverIds])].map(serverId => <label key={serverId} className="harness-gateway-option" data-selected={accessAgent.serverIds?.includes(serverId)}><input type="checkbox" checked={accessAgent.serverIds?.includes(serverId) ?? false} onChange={event => changeAgent(activeAgentIndex, { serverIds: event.target.checked ? [...(accessAgent.serverIds ?? []), serverId] : (accessAgent.serverIds ?? []).filter(value => value !== serverId) })} />{serverId}{!registeredServerIds.includes(serverId) && <small>（操作清单中已无此服务）</small>}</label>)}</div>}
                  </div></details><small>{accessAgent.serverIds === undefined ? '按已登记操作开放服务；可选择进一步限制。' : accessAgent.serverIds.length ? '仅允许所选服务；保留现有 Agent 服务范围。' : '未选任何服务时不允许访问；可先在下方登记操作。'}</small>
                </div>
                <label className="harness-gateway-subjects">允许使用此智能体的接入用户 ID<input value={(accessAgent.subjects ?? []).join(',')} onChange={event => changeAgent(activeAgentIndex, { subjects: draftList(event.target.value) })} placeholder="例如 subject-a,subject-b" /><small>填写接入用户的稳定 ID，多个用逗号分隔；留空表示无人可用。</small></label>
              </div>
              <div className="harness-gateway-action-row harness-gateway-choices" role="group" aria-label={`允许的动作 ${activeAgentIndex + 1}`}><div><strong>允许的动作</strong><small>身份有效或低风险不会自动增加权限。</small></div><label className="harness-gateway-inline"><input type="checkbox" checked={accessAgent.actions?.includes('read') ?? false} onChange={event => changeAgent(activeAgentIndex, { actions: event.target.checked ? [...(accessAgent.actions ?? []), 'read'] : (accessAgent.actions ?? []).filter(value => value !== 'read') })} />读取（read）</label><details className="harness-gateway-action-details"><summary>其他动作 · {accessAgent.actions?.filter(value => value !== 'read').length ?? 0} 项</summary><div className="harness-gateway-choice-list">{[...new Set([...agentAccessActions, ...(accessAgent.actions ?? [])])].filter(value => value !== 'read').map(value => <label key={value} className="harness-gateway-option" data-selected={(accessAgent.actions ?? []).includes(value)}><input type="checkbox" checked={(accessAgent.actions ?? []).includes(value)} onChange={event => changeAgent(activeAgentIndex, { actions: event.target.checked ? [...(accessAgent.actions ?? []), value] : (accessAgent.actions ?? []).filter(action => action !== value) })} />{accessActionNames[value] ?? '未知动作'}（{value}）</label>)}</div></details></div>
              <div className="harness-gateway-agent-tools"><label className="harness-gateway-inline"><input type="checkbox" checked={accessAgent.enabled ?? false} onChange={event => changeAgent(activeAgentIndex, { enabled: event.target.checked })} />开放该智能体的访问权限</label><button type="button" onClick={addAgent}>添加智能体身份</button><button type="button" onClick={() => setDraft({ ...draft, agents: JSON.stringify(agentDrafts.filter((_, at) => at !== activeAgentIndex), null, 2) })}>移除当前智能体配置</button></div>
            </>}
            <section className="harness-gateway-operation-list" aria-label="工具与资源操作允许清单"><div className="harness-gateway-operation-list-heading"><h3>工具与资源操作</h3><button type="button" onClick={() => setDraft({ ...draft, operations: JSON.stringify([...operationDrafts, { serverId: '', operationId: '', kind: 'read', method: 'GET', target: '' }], null, 2) })}>添加操作</button></div>
              {operationDrafts.map((row, index) => <details key={index} className="harness-gateway-operation-card"><summary>{row.operationId || `操作 ${index + 1}`} · {row.serverId || '未填写服务'} · {row.method || '未选方法'} · {accessActionNames[row.kind] ?? row.kind}</summary><div className="harness-gateway-operation-fields">
                <label>服务 ID<input aria-label={`服务 ID ${index + 1}`} list="gateway-service-suggestions" value={row.serverId ?? ''} onChange={event => changeOperation(index, { serverId: event.target.value })} /></label>
                <label>操作 ID<input aria-label={`操作 ID ${index + 1}`} value={row.operationId ?? ''} onChange={event => changeOperation(index, { operationId: event.target.value })} /></label>
                <label>动作<select aria-label={`动作 ${index + 1}`} value={row.kind ?? 'read'} onChange={event => changeOperation(index, { kind: event.target.value })}>{['read', 'write', 'resource', 'publish'].map(value => <option key={value} value={value}>{accessActionNames[value]}（{value}）</option>)}</select></label>
                <label>方法<select aria-label={`方法 ${index + 1}`} value={row.method ?? ''} onChange={event => changeOperation(index, { method: event.target.value })}><option value="" disabled>选择方法</option>{!!row.method && !businessOperationMethods.includes(row.method) && <option value={row.method}>{row.method}（无效）</option>}{businessOperationMethods.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className="harness-gateway-field-wide">实际目标<input aria-label={`实际目标 ${index + 1}`} value={row.target ?? ''} placeholder={row.targetHidden ? '原目标私有部分不回传，留空保留' : 'http://…/path/{id}'} onChange={event => changeOperation(index, { target: event.target.value, targetHidden: !event.target.value && !!row.targetHidden })} /></label>
                <label className="harness-gateway-inline harness-gateway-field-wide"><input aria-label={`必要确认 ${index + 1}`} type="checkbox" checked={row.confirmation ?? false} onChange={event => changeOperation(index, { confirmation: event.target.checked })} />执行前需要确认</label>
                <button type="button" onClick={() => setDraft({ ...draft, operations: JSON.stringify(operationDrafts.filter((_, at) => at !== index), null, 2) })}>移除操作</button>
              </div></details>)}
              {!operationDrafts.length && <p className="harness-gateway-access-empty">尚无操作。添加工具或资源操作后，才能授权实际目标。</p>}
            </section>
            <div className="harness-gateway-access-footer"><details><summary>范围与应用说明</summary><p>先保存访问配置，再核对实例回执。发布实例的资源读取按配置核对实际目标；未发布实例全部放行。原生定时任务已开放，自动检测与防护闭环尚待验证。</p></details><button type="submit" className="harness-primary" disabled={busy || conflict}>预览配置</button></div>
            <datalist id="gateway-service-suggestions">{[...new Set([...serviceSuggestions, ...registeredServerIds])].map(value => <option key={value} value={value} />)}</datalist>
            <details className="harness-gateway-access-advanced"><summary>高级 JSON 编辑</summary><label>Agent 规则 JSON<textarea data-gateway-field="agents-json" aria-label="Agent 规则 JSON" rows={10} spellCheck={false} value={draft.agents} onChange={event => setDraft({ ...draft, agents: event.target.value })} /></label><label>操作授权 JSON<textarea data-gateway-field="operations-json" aria-label="操作授权 JSON" rows={10} spellCheck={false} value={draft.operations} onChange={event => setDraft({ ...draft, operations: event.target.value })} /></label></details>
          </fieldset>}
        </form>}
        </section>}
        {section === 'overview' && <section className="harness-card harness-composition-detail" aria-label="运行概览">
        <div className="harness-section-heading"><div><h2>业务访问与配置应用</h2><p className="harness-gateway-description">区分当前访问状态、评估有效性与实例回执。</p></div><span className="harness-gateway-description">{loadError ? '最近读取失败 · 状态待核对' : `${lastStatusAt || '尚未读取'} 更新`}</span></div>
        {data.agentStatuses.some(item => item.authentication.status !== 'not_required') && (!freshFacts.length || highRiskCount > 0 || unknownRiskCount > 0) && <div className="harness-gateway-risk-notice" role="status"><div><strong>{!data.riskFacts.length ? '尚无风险评估，当前许可待核对' : !freshFacts.length ? '风险评估已过期，需要复核当前许可' : riskOverview}</strong><p>{!freshFacts.length ? '没有有效评估事实，不等于已确认高风险；请核对评估范围与证据。' : '请核对评估范围与证据，再判断当前许可。'}</p></div><button className="harness-gateway-text-button" type="button" onClick={() => openSection('risk')}>查看评估 →</button></div>}
        {data.instances.length ? <div className="harness-table-scroll harness-gateway-overview-table"><table><thead><tr><th>业务实例</th><th>实际装载</th><th>身份核验</th><th>访问配置</th><th>配置应用</th><th><span className="harness-gateway-visually-hidden">操作</span></th></tr></thead><tbody>{data.instances.map(value => {
          const identity = data.agentStatuses.find(item => item.instanceId === value.instanceId)
          const access = data.configuration.agents.find(item => item.agentId === value.agentId)
          const outcome = identityResult(identity)
          return <tr key={value.instanceId}><td><strong>{value.instanceId}</strong><small>{agentCatalog?.agents.find(item => item.id === value.agentId)?.name || value.agentId}</small></td>
            <td><span>来源已登记</span><details><summary>查看来源与代次</summary><small>实际来源</small><code>{value.sourceDigest}</code><small>该实例固定来源</small><code>{value.pinnedSourceDigest || '尚未固定'}</code><small>当前代次 {value.runtimeGeneration}</small></details></td>
            <td><span className="harness-gateway-badge" data-state={outcome.state}>● {outcome.label}</span></td>
            <td>{identity?.authentication.status === 'not_required' ? '未发布，全部放行、不评估风险' : access ? data.enabled && access.enabled ? '已开放' : '已关闭' : '未配置'}</td>
            <td><span className="harness-gateway-badge" data-state={value.applied ? 'success' : 'pending'}>● {value.applied ? '已应用' : '待核对'}</span></td>
            <td><button className="harness-gateway-text-button" type="button" onClick={() => { setAccessAgentIndex(Math.max(0, agentDrafts.findIndex(row => row.agentId === value.agentId))); openSection('authorization') }}>访问配置</button></td></tr>
        })}</tbody></table></div> : <div className="harness-gateway-access-empty"><strong>暂无已登记业务实例</strong><p>配置保存不表示实例已应用。创建实例并取得回执后，这里才会显示实际状态。</p></div>}
        <div className="harness-gateway-overview-cards"><article><h3>配置应用回执</h3><strong className={data.instances.length && appliedInstances === data.instances.length ? 'harness-gateway-applied' : undefined}>{data.instances.length ? `${appliedInstances}/${data.instances.length} 个目标实例已确认应用` : '尚无目标实例'}</strong><p>{data.instances.length ? '回执确认配置生效；业务验证结果仍以对应评测证据为准。' : '登记目标实例后，再核对实际应用回执。'}</p></article><article><h3>管理范围</h3><p>当前工作区经统一业务网关访问的业务实例。</p><details><summary>展开范围与来源说明</summary><p>未发布实例全部放行；发布实例按风险策略限制高风险 MCP 调用。原生定时任务已开放，到期投递与实际业务执行分别核对，自动检测与防护闭环尚待验证。</p></details></article></div>
        <details className="harness-gateway-auxiliary" aria-label="实例与身份回执"><summary>实例与身份回执 · 查看核验依据</summary><p className="harness-gateway-description">许可租期上限 2 秒，在线回执目标 2 秒；下列事实按当前工作区读取。</p>
          {data.agentStatuses.length ? <ul className="harness-gateway-list">{data.agentStatuses.map(value => <li key={value.instanceId}>{value.agentId} / {value.instanceId}：{value.authentication.status === 'not_required' ? '开发调试，不要求发布身份签名' : `发布身份 ${stateNames[value.authentication.status] ?? value.authentication.status}`}；来源状态 {stateNames[value.trust.status] ?? value.trust.status}<p>{value.authentication.status === 'not_required' ? '无需发布身份验证或风险评估；网关内部签名用于实例路由。' : `签名最近验证 ${value.authentication.verifiedAt ?? '尚无证据'} · 签名有效期 ${value.authentication.expiresAt ?? '未知'}`} · 来源依据 {value.trust.reason}</p></li>)}</ul> : <p>尚无 Agent 身份核验事实。</p>}
          {data.sessionTrustFacts?.length ? <details className="harness-gateway-auxiliary"><summary>查看接入用户会话身份事实（{data.sessionTrustFacts.length}）</summary><ul>{data.sessionTrustFacts.map(value => <li key={value.sessionId}>{value.subjectId} / {value.sessionId}：{value.state === 'evidence-held' ? '持有已验证身份记录（非实时探测）' : '身份记录已过期'} · 验证时间 {value.verifiedAt ?? '未知'} · 有效期 {value.expiresAt ?? '未知'} · 观察时间 {value.observedAt}</li>)}</ul></details> : <p>尚无用户会话信任事实。</p>}
        </details>
        <section className="harness-gateway-runtime-section" aria-label="风险与运行限制">
        <h3>风险状态</h3>
        {data.configuration.agents.length ? <div className="harness-gateway-facts">{data.configuration.agents.map(row => {
          const facts = data.riskFacts.filter(fact => fact.scope.agentId === row.agentId), valid = facts.filter(fact => Date.parse(fact.expiresAt) > Date.now())
          const development = data.agentStatuses.filter(value => value.agentId === row.agentId).every(value => value.authentication.status === 'not_required') && data.agentStatuses.some(value => value.agentId === row.agentId)
          const label = development ? '未发布，无需风险评估' : !facts.length ? '尚未评估' : !valid.length ? '评估已过期' : valid.some(fact => fact.level === 'high') ? '高风险（已评估范围）'
            : valid.some(fact => fact.status === 'unknown' || fact.level === 'unknown') ? '存在未知评估' : valid.every(fact => fact.level === 'low') ? '低风险（已评估范围）' : '已评估，未提供风险等级'
          const latest = [...facts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]
          const instances = data.instances.filter(value => value.agentId === row.agentId)
          return <article key={row.agentId}><h4>{row.agentId}：{label}</h4>{development ? <p>所有请求放行；发布后按风险策略限制高风险 MCP 工具调用。</p> : <><p>最新评估 {latest?.observedAt ?? '尚无事实'} · 当前有效事实 {valid.length}/{facts.length} · 人工限制 {data.restrictions.filter(value => value.active && value.scope.agentId === row.agentId).length} · 实例回执 {instances.filter(value => value.applied).length}/{instances.length}</p>
            <p>依据：{latest?.signals.length ? latest.signals.map(value => `${value.code}=${value.value}（${value.reason}）`).join('；') : latest ? '最近事实未附加拒绝信号；不据此推断整个 Agent 无风险' : '尚无评估依据'}</p></>}</article>
        })}</div> : <p>尚无已配置业务 Agent。</p>}
        <div className="harness-gateway-runtime-layout"><div><h3>当前限制</h3>
        {data.restrictions.length ? <ul className="harness-gateway-list">{data.restrictions.map(value => <RestrictionRow key={value.id} value={value} sessions={data.sessionTrustFacts ?? []} busy={busy} perform={perform} />)}</ul> : <p>暂无人工运行限制。风险事实和基础授权仍会参与每次请求判断。</p>}
        </div><aside id="gateway-reassess" tabIndex={-1}><h3>辅助：收紧指定实例与接入用户范围</h3>
        <form className="harness-composition-editor" onSubmit={event => { event.preventDefault(); void restrictSelected() }}>
          <label>业务实例<select required value={instanceId} onChange={event => { setInstanceId(event.target.value); setSelectedSubjectIds([]); setSessionId('') }}><option value="">请选择实例</option>{data.instances.map(value => <option key={value.instanceId} value={value.instanceId}>{value.instanceId}（{value.agentId}）</option>)}</select></label>
          <fieldset className="harness-gateway-subject-picker"><legend>要限制的接入用户（可多选）</legend>
            {agent?.subjects.length ? <div className="harness-gateway-choice-list">{agent.subjects.map(value => <label key={value} className="harness-gateway-option" data-selected={selectedSubjectIds.includes(value)}><input type="checkbox" checked={selectedSubjectIds.includes(value)} onChange={event => {
              setSelectedSubjectIds(current => event.target.checked ? [...current, value] : current.filter(id => id !== value))
              if (event.target.checked && selectedSubjectIds.length && sessionId) { setSessionId(''); setRuntimeFeedback('已选多位接入用户，Session ID 已清空；限制将覆盖这些用户在所选实例的会话。') }
            }} />{value}</label>)}</div> : <p>此 Agent 尚无获准用户；请先到“访问控制”设置。</p>}
            <small>只列出“访问控制”中获准使用此 Agent 的用户。此处选择限制对象，不会授予使用权。</small>
          </fieldset>
          <label>动作<select value={action} onChange={event => setAction(event.target.value)}>{Object.entries(actionNames).map(([value, label]) => <option key={value} value={value}>{label}（{value}）</option>)}</select></label>
          <label>Session ID（可选；辅助重评时必填）<input maxLength={500} disabled={selectedSubjects.length > 1} value={sessionId} onChange={event => setSessionId(event.target.value)} /><small>选多位用户时，限制覆盖他们在此实例的全部会话；若只限制一个 Session，请只选一位用户。</small></label>
          <label className="harness-mcp-wide">收紧依据<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <div className="harness-mcp-actions"><button type="submit" disabled={busy || !instance || !selectedSubjects.length || !reason.trim() || (!!sessionId.trim() && selectedSubjects.length !== 1)}>收紧所选用户的动作</button><button type="button" disabled={busy || !scope || !sessionId.trim()} onClick={() => void perform('reassess', { sessionId: sessionId.trim(), action, scope }).then(result => setRuntimeFeedback(result.message))}>辅助重评当前 Session</button></div>
        </form>
        {runtimeFeedback && <p role="status">{runtimeFeedback}</p>}
        <p>收紧必须处于各用户的基础许可内；多选会分别建立限制。填写 Session 后进一步限定单个用户的会话。重新评估只更新风险事实。</p>

        </aside></div>

        <details className="harness-gateway-auxiliary"><summary>查看全部风险事实（{data.riskFacts.length}）</summary>
        {data.riskFacts.length ? <ul className="harness-gateway-list">{data.riskFacts.map(value => <li key={value.id}>{value.scope.subjectId ?? '所选范围'} · {value.scope.sessionId ?? value.scope.agentId} · 版本 {value.version} · {Date.parse(value.expiresAt) <= Date.now() ? '已过期' : value.status === 'assessed' ? '已评估' : '未知'} · 有效期至 {value.expiresAt}
          <p>{value.signals.length ? value.signals.map(signal => `${signal.code}=${signal.value}（${signal.reason}）`).join('；') : '无新增风险约束'}</p>
        </li>)}</ul> : <p>尚无风险事实。实际受保护动作仍须按配置完成必要评估。</p>}</details></section>

        <section className="harness-gateway-runtime-section" aria-label="最近执行结果"><h3>最近执行结果</h3>
        {data.events.length ? <div className="harness-table-scroll"><table><thead><tr><th>时间</th><th>接入用户／会话</th><th>动作／操作</th><th>结果</th><th>依据</th></tr></thead><tbody>{data.events.slice(-30).reverse().map(value => <tr key={value.id}>
          <td>{value.at}</td><td>{value.subjectId} / {value.sessionId}</td><td>{value.action} / {value.operationId}</td><td>{value.outcome}</td><td>{value.reason ?? '—'}</td>
        </tr>)}</tbody></table></div> : <p>暂无受管执行记录。</p>}</section>
        </section>}</div>
        {section !== 'overview' && <><p className="harness-gateway-scope" role="note">所有实例经统一网关访问；未发布实例不做风险评估，全部放行。</p><details className="harness-guide"><summary>查看覆盖范围与限制</summary><p>原生定时任务可创建并到期投递；巡检、研判及报表是否完成以业务回执为准。定时检测与防护闭环尚待验证。</p></details></>}
        {previewOpen && draft && <div className="harness-gateway-preview-backdrop" onClick={event => { if (event.target === event.currentTarget) setPreviewOpen(false) }}><div ref={previewDialog} tabIndex={-1} className="harness-gateway-preview-dialog" role="dialog" aria-modal="true" aria-label="确认保存业务访问配置" onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setPreviewOpen(false) }
          if (event.key !== 'Tab') return
          const buttons = previewDialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
          if (!buttons?.length) return
          const first = buttons[0], last = buttons[buttons.length - 1]
          if (event.shiftKey && (document.activeElement === first || document.activeElement === previewDialog.current)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }}>
          <h2>确认保存业务访问配置</h2><p>先保存配置，再根据对应版本的实例回执判断应用结果。</p>
          <dl><dt>配置对象</dt><dd>{agentDrafts.map(row => row.agentId || '未选择智能体').join('、') || '尚无业务智能体'}</dd>
            <dt>即时业务访问</dt><dd>{draft.enabled ? '开放' : '关闭'} · 单次请求仍需核对</dd>
            <dt>智能体访问范围</dt><dd>{agentDrafts.length ? agentDrafts.map((row, index) => <p key={index}>{row.agentId || '待配置智能体'}：{row.enabled ? '已开放' : '未开放'} · {row.serverIds === undefined ? '按已登记操作开放服务' : row.serverIds.length ? `服务 ${row.serverIds.join('、')}` : '无已选服务'} · 接入用户 {row.subjects.length ? row.subjects.join('、') : '未配置'} · 动作 {row.actions.length ? row.actions.map(value => accessActionNames[value] ?? value).join('、') : '未选择'}</p>) : '尚未配置'}</dd>
            <dt>实际操作目标</dt><dd>{operationDrafts.length ? operationDrafts.map((row, index) => <p key={index}>{row.serverId || '未填写服务'} · {row.operationId || '未填写操作'} · {row.method || '未选方法'} · {row.target || (row.targetHidden ? '原目标已保留' : '未填写目标')}</p>) : '尚未登记操作'}</dd>
          </dl>
          <p className="harness-gateway-preview-warning">{riskOverview}。保存配置不表示身份核验、风险许可或目标实例已经应用。</p>
          <div className="harness-gateway-preview-actions"><button type="button" onClick={() => setPreviewOpen(false)}>返回修改</button><button className="harness-primary" type="button" disabled={busy || conflict || !dirty(draft)} onClick={saveDraft}>{dirty(draft) ? '确认保存业务访问配置' : '当前没有待保存更改'}</button></div>
        </div></div>}
      </>}
  </main>
}
