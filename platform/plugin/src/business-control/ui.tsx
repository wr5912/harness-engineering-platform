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
const stateNames: Record<string, string> = { verified: '已验证签名', unknown: '未知', expired: '已过期', disabled: '已停用', trusted: '身份条件已满足', revoked: '身份已撤销', mismatch: '来源或代次不匹配' }
const configurationTabs = [{ id: 'overview', label: '运行概览' }, { id: 'identity', label: '智能体身份' }, { id: 'risk', label: '风险评估' }, { id: 'authorization', label: '访问控制' }] as const
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
  const [localSection, setLocalSection] = useState<Section>('overview')
  const section = target?.page === 'gateway' ? configurationTabs.find(value => value.id === target.tab)?.id ?? 'overview' : localSection
  const openSection = (next: Section) => { setLocalSection(next); onNavigate?.({ page: 'gateway', ...(next === 'overview' ? {} : { tab: next }) }) }
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
    setLastStatusAt(new Date().toISOString())
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
    setDraft(draftOf(data))
    setError('')
  }
  function saveDraft() {
    if (!draft || busy || conflict) return
    const invalid = draftError(draft)
    if (invalid) {
      setError(`${configurationTabs.find(value => value.id === invalid.section)?.label}：${invalid.message}`)
      openSection(invalid.section)
      window.requestAnimationFrame?.(() => { const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-gateway-field="${invalid.field}"]`)
        field?.closest('details')?.setAttribute('open', ''); field?.focus() })
      return
    }
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
  const registeredServerIds = [...new Set(operationDrafts.map(row => String(row.serverId ?? '').trim()).filter(Boolean))]
  const changeAgent = (index: number, value: Partial<AgentAccessRule>) => { if (draft) setDraft({ ...draft, agents: JSON.stringify(agentDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const selectAgent = (index: number, agentId: string) => {
    if (!agentCatalog?.agents.some(value => value.id === agentId) || agentDrafts[index]?.agentId === agentId) return
    // 更换配置对象不能沿用上一智能体的来源和身份启用状态。
    changeAgent(index, { agentId, enabled: false, sourceDigest: undefined, agentTrust: { enabled: false } })
  }
  const changeOperation = (index: number, value: Record<string, unknown>) => { if (draft) setDraft({ ...draft, operations: JSON.stringify(operationDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const addAgent = () => { if (draft) { setDraft({ ...draft, agents: JSON.stringify([...agentDrafts, { agentId: '', enabled: false, subjects: [], actions: ['read'], serverIds: [], agentAuthentication: { enabled: true, method: 'hmac-sha256' }, agentTrust: { enabled: false } }], null, 2) }); openSection('identity') } }
  const freshFacts = data?.riskFacts.filter(value => Date.parse(value.expiresAt) > Date.now()) ?? []
  const highRiskCount = freshFacts.filter(value => value.level === 'high').length
  const unknownRiskCount = freshFacts.filter(value => value.status === 'unknown' || value.level === 'unknown' || value.level === undefined).length
  const riskOverview = !data?.riskFacts.length ? '尚无评估' : !freshFacts.length ? '评估已过期'
    : unknownRiskCount ? '存在未知评估' : `已评估范围内 ${highRiskCount} 项高风险`
  return <main className="harness-mcp-page harness-gateway-page" aria-label="统一网关管理">
      <style>{businessControlStyle}</style>
      <header className="harness-page-heading"><div><p>智能体身份、实时风险评估与访问控制</p></div><button type="button" disabled={busy} onClick={() => { void refresh(); setAgentCatalogRevision(value => value + 1) }}>刷新状态</button></header>
      {(loadError || error) && <p role="alert">{error || loadError}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data ? <section className="harness-card"><p role="status">正在读取统一网关状态…</p></section> : <>
        <div className="harness-gateway-status" aria-label="统一网关状态概览">
          <span>即时访问 <strong>{data.enabled ? '已开放' : '已关闭'}</strong><small>限制版本 {data.restrictionVersion}</small></span>
          <span title="已验证凭据、可信来源与实例绑定">身份核验 <strong>{data.agentStatuses.filter(value => value.trust.status === 'trusted').length} / {data.instances.length}</strong></span>
          <span title={`有效事实 ${freshFacts.length} / ${data.riskFacts.length} · 高风险 ${highRiskCount} · 未知 ${unknownRiskCount}`}>风险 <strong data-summary="risk">{riskOverview}</strong></span>
          <span>策略回执 <strong>{data.instances.filter(value => value.applied).length} / {data.instances.length}</strong></span>
        </div>
        <p className="harness-guide" role="note">首期仅覆盖经统一业务网关发起的即时任务。暂不支持定时任务的检测、防护闭环；定时巡检、自动研判和报表需手动发起，存在延迟和漏执行风险。现有研究实例的定时任务不纳入本闭环的完整保护声明。</p>
        {conflict && <p role="alert">配置已在其他位置更新，当前草稿已保留。请复制需要的修改，放弃草稿后按最新版本编辑；旧草稿不能覆盖新配置。</p>}
        <nav className="harness-mcp-toolbar harness-mcp-tabs harness-gateway-main-tabs" role="tablist" aria-label="统一网关视图" onKeyDown={event => {
          const index = configurationTabs.findIndex(tab => tab.id === section)
          const next = event.key === 'ArrowRight' ? (index + 1) % configurationTabs.length : event.key === 'ArrowLeft' ? (index + configurationTabs.length - 1) % configurationTabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? configurationTabs.length - 1 : -1
          if (next < 0) return
          event.preventDefault(); openSection(configurationTabs[next].id)
          window.requestAnimationFrame?.(() => document.querySelector<HTMLButtonElement>(`[data-gateway-tab="${configurationTabs[next].id}"]`)?.focus())
        }}>{configurationTabs.map(tab => <button key={tab.id} data-gateway-tab={tab.id} role="tab" aria-selected={section === tab.id} aria-controls="gateway-panel" tabIndex={section === tab.id ? 0 : -1} type="button" onClick={() => openSection(tab.id)}>{tab.label}{dirtyPages.has(tab.id) && <span className="harness-gateway-dirty-dot" aria-label="有未保存更改"> ●</span>}</button>)}</nav>
        {draft && <div className="harness-gateway-savebar"><div><strong>{dirty(draft) ? '有未保存更改' : '配置草稿与已保存内容一致'}</strong><small>一次保存全部配置；实例应用状态见运行概览。</small></div><div className="harness-mcp-actions"><button className="harness-primary" type="button" onClick={saveDraft} disabled={busy || !dirty(draft) || conflict}>保存业务访问配置</button><button type="button" disabled={busy || !dirty(draft)} onClick={() => { if (window.confirm?.('放弃全部未保存更改并读取当前配置？') ?? true) resetDraft() }}>放弃草稿并读取当前配置</button></div></div>}
        <div className="harness-gateway-workspace" id="gateway-panel" role="tabpanel" aria-label={configurationTabs.find(tab => tab.id === section)?.label}>
        {section !== 'overview' && <section className="harness-card harness-composition-detail" aria-label="功能配置">
        <div className="harness-section-heading"><h2>{configurationTabs.find(tab => tab.id === section)?.label}配置</h2><span className="harness-gateway-description">三类配置共用一份草稿</span></div>
        {draft && <form noValidate className="harness-composition-editor harness-gateway-config" aria-label="统一网关配置" onSubmit={event => { event.preventDefault(); saveDraft() }}>
          {section === 'identity' && !agentDrafts.length && <div className="harness-gateway-empty"><strong>尚未配置业务 Agent</strong><p>先登记智能体身份并核对可信来源，再配置风险评估和访问范围。</p><button type="button" className="harness-primary" onClick={addAgent}>配置首个 Agent</button></div>}
          {section === 'identity' && <fieldset><legend>1．智能体身份</legend>
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
              <label className="harness-mcp-wide">{row.agentId || 'Agent'} 的可信固定来源<input value={row.sourceDigest ?? ''} onChange={event => changeAgent(index, { sourceDigest: event.target.value || undefined })} placeholder="填写已核对的 sourceDigest；缺失时为未知" /></label>
            </div>)}
            <p>可信来源的实时核验结果请到“运行概览”核对。</p>
            </section></div>
            <details className="harness-gateway-auxiliary"><summary>辅助：接入用户认证与状态核验</summary>
              <p>这里验证接入用户及其有效状态，用于区分会话归属；智能体身份由上方独立核验。</p>
              <ProviderFields title="接入用户认证提供方" kind="authentication" value={draft.authentication} current={data.configuration.authentication} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, authentication: value })} />
              <ProviderFields title="接入用户状态核验提供方" kind="identityTrust" value={draft.identityTrust} current={data.configuration.identityTrust} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, identityTrust: value })} />
            </details>
          </fieldset>}
          {section === 'risk' && <fieldset><legend>2．风险评估</legend>
            <p>按业务事件实时自动评估各 Agent：输入、每个工具或资源执行步骤、报告发布与下载。风险变化自动参与执行许可；手动重评仅为辅助。空闲周期巡检不在首期范围。</p>
            <ProviderFields title="Agent 风险评估提供方" kind="riskAssessment" value={draft.riskAssessment} current={data.configuration.riskAssessment} revision={draft.revision} rpc={rpc} change={value => setDraft({ ...draft, riskAssessment: value })} />
            <label>必须自动评估的动作（逗号分隔）<input value={draft.requiredKinds} onChange={event => setDraft({ ...draft, requiredKinds: event.target.value })} placeholder="write, publish" /></label>
            <p>检测标记每行一个，仅验证已配置的检测接入，不代表通用攻击识别。</p>
            <div className="harness-composition-editor">{(['inputMarkers', 'operationMarkers', 'reportMarkers'] as const).map((key, index) => <label key={key}>{['输入检测标记', '执行参数检测标记', '报告检测标记'][index]}<textarea value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div>
          </fieldset>}
          {section === 'authorization' && <fieldset className="harness-gateway-access"><legend>3．访问控制</legend>
            <p>配置智能体可访问的服务、工具、资源和动作。执行时综合身份核验、当前风险与资源归属作出允许或拒绝；身份有效或低风险不会自动增加权限。</p>
            <label className="harness-gateway-inline"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />开放即时业务访问</label>
            <div className="harness-gateway-access-layout">
              <section className="harness-gateway-access-panel" aria-label="Agent 访问范围">
                <div className="harness-gateway-panel-heading"><div><h3>Agent 访问范围</h3><small>新增 Agent 先完成身份配置</small></div><button type="button" onClick={addAgent}>添加 Agent 身份</button></div>
                {agentDrafts.map((row, index) => <article key={index} className="harness-gateway-access-card">
                  <div className="harness-gateway-access-card-heading"><strong>{row.agentId || '待填写智能体身份'}</strong><label className="harness-gateway-inline"><input type="checkbox" checked={row.enabled ?? false} onChange={event => changeAgent(index, { enabled: event.target.checked })} />开放该 Agent</label></div>
                  <div className="harness-gateway-access-fields">
                    <div className="harness-gateway-choices" role="group" aria-label={`允许访问的服务 ${index + 1}`}>
                      <span>服务范围</span>
                      <label className="harness-gateway-inline"><input type="checkbox" checked={row.serverIds !== undefined} onChange={event => changeAgent(index, { serverIds: event.target.checked ? [] : undefined })} />仅允许所选服务</label>
                      {row.serverIds !== undefined && <div className="harness-gateway-choice-list">{[...new Set([...registeredServerIds, ...row.serverIds])].map(serverId => <label key={serverId} className="harness-gateway-option" data-selected={(row.serverIds ?? []).includes(serverId)}><input type="checkbox" checked={(row.serverIds ?? []).includes(serverId)} onChange={event => changeAgent(index, { serverIds: event.target.checked ? [...(row.serverIds ?? []), serverId] : (row.serverIds ?? []).filter(value => value !== serverId) })} />{serverId}{!registeredServerIds.includes(serverId) && <small>（操作清单中已无此服务）</small>}</label>)}</div>}
                      <small>{row.serverIds === undefined ? '按已登记操作开放服务。' : registeredServerIds.length ? '未选任何服务时不允许访问。' : row.serverIds.length ? '旧服务可取消；新增服务先登记操作。' : '先在右侧登记操作，再选择服务。'}</small>
                    </div>
                    <label className="harness-gateway-subjects">允许使用此 Agent 的接入用户 ID<input value={(row.subjects ?? []).join(',')} onChange={event => changeAgent(index, { subjects: draftList(event.target.value) })} placeholder="例如 subject-a,subject-b" /><small>填写接入用户登录验证后返回的稳定 ID，多个用逗号分隔。留空表示无人可使用；当前没有可选择的用户目录。</small></label>
                  </div>
                  <div className="harness-gateway-choices" role="group" aria-label={`允许的动作 ${index + 1}`}><details className="harness-gateway-action-details"><summary><span>允许的动作</span><small>{row.actions?.includes('*') ? '全部动作' : row.actions?.length ? row.actions.map(value => accessActionNames[value] ?? value).join(' · ') : '尚未选择'}</small><span className="harness-gateway-selection-count">{row.actions?.includes('*') ? '全部' : `${row.actions?.length ?? 0} 项`}</span><span className="harness-gateway-edit-label">编辑</span></summary><div className="harness-gateway-choice-list">{[...new Set([...agentAccessActions, ...(row.actions ?? [])])].map(value => <label key={value} className="harness-gateway-option" data-selected={(row.actions ?? []).includes(value)}><input type="checkbox" checked={(row.actions ?? []).includes(value)} onChange={event => changeAgent(index, { actions: event.target.checked ? [...(row.actions ?? []), value] : (row.actions ?? []).filter(action => action !== value) })} />{accessActionNames[value] ?? '未知动作'}（{value}）</label>)}</div></details></div>
                  <div className="harness-gateway-access-card-footer"><button type="button" onClick={() => setDraft({ ...draft, agents: JSON.stringify(agentDrafts.filter((_, at) => at !== index), null, 2) })}>移除 Agent 配置</button></div>
                </article>)}
                {!agentDrafts.length && <p className="harness-gateway-access-empty">尚无 Agent 配置，请先添加并完成身份设置。</p>}
              </section>
              <section className="harness-gateway-access-panel" aria-label="工具与资源操作允许清单">
                <div className="harness-gateway-panel-heading"><div><h3>工具与资源操作</h3><small>每项绑定实际方法和目标</small></div><button type="button" onClick={() => setDraft({ ...draft, operations: JSON.stringify([...operationDrafts, { serverId: '', operationId: '', kind: 'read', method: 'GET', target: '' }], null, 2) })}>添加操作</button></div>
                {operationDrafts.map((row, index) => <article key={index} className="harness-gateway-operation-card">
                  <div className="harness-gateway-operation-heading"><div><strong>{row.operationId || `操作 ${index + 1}`}</strong><small>{row.serverId || '尚未填写服务 ID'}</small></div><button type="button" onClick={() => setDraft({ ...draft, operations: JSON.stringify(operationDrafts.filter((_, at) => at !== index), null, 2) })}>移除操作</button></div>
                  <div className="harness-gateway-operation-fields">
                    <label>服务 ID<input aria-label={`服务 ID ${index + 1}`} list="gateway-service-suggestions" value={row.serverId ?? ''} onChange={event => changeOperation(index, { serverId: event.target.value })} /></label>
                    <label>操作 ID<input aria-label={`操作 ID ${index + 1}`} value={row.operationId ?? ''} onChange={event => changeOperation(index, { operationId: event.target.value })} /></label>
                    <label>动作<select aria-label={`动作 ${index + 1}`} value={row.kind ?? 'read'} onChange={event => changeOperation(index, { kind: event.target.value })}>{['read', 'write', 'resource', 'publish'].map(value => <option key={value} value={value}>{accessActionNames[value]}（{value}）</option>)}</select></label>
                    <label>方法<select aria-label={`方法 ${index + 1}`} value={row.method ?? ''} onChange={event => changeOperation(index, { method: event.target.value })}><option value="" disabled>选择方法</option>{!!row.method && !businessOperationMethods.includes(row.method) && <option value={row.method}>{row.method}（无效）</option>}{businessOperationMethods.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
                    <label className="harness-gateway-field-wide">实际目标<input aria-label={`实际目标 ${index + 1}`} value={row.target ?? ''} placeholder={row.targetHidden ? '原目标私有部分不回传，留空保留' : 'http://…/path/{id}'} onChange={event => changeOperation(index, { target: event.target.value, targetHidden: !event.target.value && !!row.targetHidden })} /></label>
                    <label className="harness-gateway-inline harness-gateway-field-wide"><input aria-label={`必要确认 ${index + 1}`} type="checkbox" checked={row.confirmation ?? false} onChange={event => changeOperation(index, { confirmation: event.target.checked })} />执行前需要确认</label>
                  </div>
                </article>)}
                {!operationDrafts.length && <p className="harness-gateway-access-empty">尚无操作。添加工具或资源操作后，才能授权实际目标。</p>}
              </section>
            </div>
            <p className="harness-gateway-access-note">资源读取还受 resource 动作及 RESOURCES/READ 实际目标约束。</p>
            <datalist id="gateway-service-suggestions">{[...new Set([...serviceSuggestions, ...registeredServerIds])].map(value => <option key={value} value={value} />)}</datalist>
            <details className="harness-gateway-access-advanced"><summary>高级 JSON 编辑</summary><label>Agent 规则 JSON<textarea data-gateway-field="agents-json" aria-label="Agent 规则 JSON" rows={10} spellCheck={false} value={draft.agents} onChange={event => setDraft({ ...draft, agents: event.target.value })} /></label><label>操作授权 JSON<textarea data-gateway-field="operations-json" aria-label="操作授权 JSON" rows={10} spellCheck={false} value={draft.operations} onChange={event => setDraft({ ...draft, operations: event.target.value })} /></label></details>
          </fieldset>}
        </form>}
        </section>}
        {section === 'overview' && <section className="harness-card harness-composition-detail" aria-label="运行概览">
        <div className="harness-section-heading"><h2>运行概览</h2><span className="harness-gateway-description">最近读取 {lastStatusAt || '尚未读取'} · 许可租期上限 2 秒 · 在线回执目标 2 秒</span></div>
        <p className="harness-gateway-description">配置保存、实例应用与业务允许是不同状态。下方显示当前管理接口观察到的事实；执行记录仅展示最近 30 条。</p>
        <section className="harness-gateway-runtime-section" aria-label="实例与身份回执"><h3>实例与身份回执</h3>
        {data.instances.length ? <div className="harness-table-scroll"><table><thead><tr><th>实例</th><th>Agent</th><th>当前代次</th><th>回执版本</th><th>实际应用</th></tr></thead><tbody>{data.instances.map(value => <tr key={value.instanceId}>
          <td>{value.instanceId}</td><td>{value.agentId}</td><td>{value.runtimeGeneration}</td><td>{value.acknowledgement?.restrictionVersion ?? '尚无回执'}</td>
          <td>{value.applied ? '已应用（2 秒内有效回执）' : '未确认；到期许可不能用于受保护动作'}</td>
        </tr>)}</tbody></table></div> : <p>暂无已登记业务实例。配置保存不表示实例已经应用。</p>}
        {data.agentStatuses.length ? <details className="harness-gateway-auxiliary"><summary>查看 Agent 签名与可信来源核验（{data.agentStatuses.length}）</summary><ul className="harness-gateway-list">{data.agentStatuses.map(value => <li key={value.instanceId}>{value.agentId} / {value.instanceId}：签名 {stateNames[value.authentication.status] ?? value.authentication.status}；可信来源 {stateNames[value.trust.status] ?? value.trust.status}<p>签名最近验证 {value.authentication.verifiedAt ?? '尚无证据'} · 签名有效期 {value.authentication.expiresAt ?? '未知'} · 来源依据 {value.trust.reason}</p></li>)}</ul></details> : <p>尚无 Agent 身份核验事实。</p>}
        {data.sessionTrustFacts?.length ? <details className="harness-gateway-auxiliary"><summary>查看接入用户会话身份事实（{data.sessionTrustFacts.length}）</summary><ul>{data.sessionTrustFacts.map(value => <li key={value.sessionId}>{value.subjectId} / {value.sessionId}：{value.state === 'evidence-held' ? '持有已验证身份记录（非实时探测）' : '身份记录已过期'} · 验证时间 {value.verifiedAt ?? '未知'} · 有效期 {value.expiresAt ?? '未知'} · 观察时间 {value.observedAt}</li>)}</ul></details> : <p>尚无用户会话信任事实。</p>}
        </section>
        <section className="harness-gateway-runtime-section" aria-label="风险与运行限制">
        <h3>风险状态</h3>
        {data.configuration.agents.length ? <div className="harness-gateway-facts">{data.configuration.agents.map(row => {
          const facts = data.riskFacts.filter(fact => fact.scope.agentId === row.agentId), valid = facts.filter(fact => Date.parse(fact.expiresAt) > Date.now())
          const label = !facts.length ? '尚未评估' : !valid.length ? '评估已过期' : valid.some(fact => fact.level === 'high') ? '高风险（已评估范围）'
            : valid.some(fact => fact.status === 'unknown' || fact.level === 'unknown') ? '存在未知评估' : valid.every(fact => fact.level === 'low') ? '低风险（已评估范围）' : '已评估，未提供风险等级'
          const latest = [...facts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]
          const instances = data.instances.filter(value => value.agentId === row.agentId)
          return <article key={row.agentId}><h4>{row.agentId}：{label}</h4><p>最新评估 {latest?.observedAt ?? '尚无事实'} · 当前有效事实 {valid.length}/{facts.length} · 人工限制 {data.restrictions.filter(value => value.active && value.scope.agentId === row.agentId).length} · 实例回执 {instances.filter(value => value.applied).length}/{instances.length}</p>
            <p>依据：{latest?.signals.length ? latest.signals.map(value => `${value.code}=${value.value}（${value.reason}）`).join('；') : latest ? '最近事实未附加拒绝信号；不据此推断整个 Agent 无风险' : '尚无评估依据'}</p></article>
        })}</div> : <p>尚无已配置业务 Agent。</p>}
        <div className="harness-gateway-runtime-layout"><div><h3>当前限制</h3>
        {data.restrictions.length ? <ul className="harness-gateway-list">{data.restrictions.map(value => <RestrictionRow key={value.id} value={value} sessions={data.sessionTrustFacts ?? []} busy={busy} perform={perform} />)}</ul> : <p>暂无人工运行限制。风险事实和基础授权仍会参与每次请求判断。</p>}
        </div><aside><h3>辅助：收紧指定实例与接入用户范围</h3>
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
      </>}
  </main>
}
