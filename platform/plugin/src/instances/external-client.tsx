import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CHANNEL, type PlatformNavigation, type PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { useQueuedRefresh } from '../realtime/refresh.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { externalInstanceTheme } from './external-style.ts'
import type { ExternalAgent as Agent, ExternalDetail as Detail, ExternalInstance as Instance, ExternalList as Listing, ExternalFramework as Framework } from './external/types.ts'

interface Credential { id: string; clientId: string; instanceId: string; status: string; effectiveStatus?: string; createdAt: string; expiresAt: string; retireAt?: string }
interface Resource { id: string; audience: string; tools: { name: string; scope: string }[] }
interface Grant { instanceId: string; resourceId: string; scopes: string[]; objects?: string[]; enabled: boolean; version: number }
interface IdentityStatus { instanceId: string; credentials: Credential[]; grants: Grant[]; resources: Resource[]; issuer: string; revision: string }
interface Draft {
  instanceId?: string; agentId: string; name: string; system: string; owner: string; instanceName: string
  framework: Framework; endpoint: string; selector: string; declaredVersion: string; credentialRef: string
  subjects: string; actions: string; description: string; location: string; instanceOwner: string
}
type Tab = 'overview' | 'connection' | 'authorization' | 'records'
const tabs: Array<{ id: Tab; label: string }> = [{ id: 'overview', label: '概览' }, { id: 'connection', label: '接入与能力' }, { id: 'authorization', label: '访问授权' }, { id: 'records', label: '访问记录' }]
const frameworks: Record<Framework, string> = { dsh: 'DSH', agentscope: 'AgentScope', opencode: 'OpenCode' }
const labels: Record<string, string> = { enabled: '已启用', disabled: '已停用', pending: '待验证', draft: '草稿', registered: '已登记', removed: '已移除', verified: '已验证', passed: '已验证', failed: '未通过', unreachable: '不可达', reachable: '可达', unknown: '未知', active: '有效', expired: '已过期', revoked: '已撤销', unverified: '未验证', not_dispatched: '未转发', dispatching: '已开始转发', dispatched: '已转发', received: '已收到响应', responded: '已收到响应', accepted: '任务已受理', completed: '执行完成', error: '返回错误', response: '已收到响应', management: '管理操作', connection_closed: '连接已关闭', allow: '允许', deny: '拒绝' }
const actions = 'agent:access, session:create, session:prompt, session:read, session:events'
const emptyDraft = (): Draft => ({ agentId: '', name: '', system: '', owner: '平台管理者', instanceName: '', framework: 'agentscope', endpoint: '', selector: '', declaredVersion: '', credentialRef: '', subjects: 'platform-owner', actions, description: '', location: '', instanceOwner: '' })
function dshTarget(selector: string): { workspaceId: string; agentPreset: string } {
  try { const value = JSON.parse(selector); return { workspaceId: typeof value?.workspaceId === 'string' ? value.workspaceId : '', agentPreset: typeof value?.agentPreset === 'string' ? value.agentPreset : '' } }
  catch { return { workspaceId: '', agentPreset: '' } }
}
function systemFromEndpoint(endpoint: string): string { try { return new URL(endpoint).hostname } catch { return '未填写' } }
function Required() { return <span className="external-required" aria-hidden="true">*</span> }
const split = (value: string) => [...new Set(value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
const stamp = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '尚无观测'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const requestId = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`
const entryState = (instance: Instance, _policy?: Detail['policy']) => instance.state === 'removed' ? 'removed' : instance.entryState
function Badge({ state }: { state?: string }) { return <span className="external-badge" data-state={state ?? 'unknown'}>{labels[state ?? 'unknown'] ?? state}</span> }
function Facts({ rows }: { rows: Array<[string, ReactNode]> }) { return <dl className="external-facts">{rows.map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value ?? '未知'}</dd></div>)}</dl> }
function resultText(value: unknown, depth = 0): string[] {
  if (depth > 12 || value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(item => resultText(item, depth + 1))
  if (typeof value !== 'object') return []
  const row = value as Record<string, unknown>
  if (typeof row.text === 'string') return [row.text]
  return ['content', 'parts', 'messages', 'data', 'items', 'events', 'value'].flatMap(key => key in row ? resultText(row[key], depth + 1) : [])
}

/** 登记与访问都调用服务端共同接口；页面不以状态显示替代授权。 */
export function ExternalInstancesPage({ rpc, active = true, updates, target, onNavigate, onContext }: PlatformPageProps & { active?: boolean; updates?: PlatformUpdates; target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void; onContext?(context: Record<string, unknown>): void }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [framework, setFramework] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [identityError, setIdentityError] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [draftRevision, setDraftRevision] = useState('')
  const [draftError, setDraftError] = useState('')
  const [saveRequestId, setSaveRequestId] = useState('')
  const [pendingReadback, setPendingReadback] = useState(false)
  const [latestDraftBase, setLatestDraftBase] = useState<Detail | null>(null)
  const [confirm, setConfirm] = useState<'disable' | 'remove' | 'disableResourceAccess' | null>(null)
  const [secret, setSecret] = useState<{ credential: Credential; secret: string } | null>(null)
  const [accessing, setAccessing] = useState(false)
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [output, setOutput] = useState<unknown>(null)
  const [accessError, setAccessError] = useState('')
  const [grantDraft, setGrantDraft] = useState({ resourceId: '', scopes: '', objects: '' })
  const editDialog = useRef<HTMLDialogElement>(null)
  const secretDialog = useRef<HTMLDialogElement>(null)
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const accessDialog = useRef<HTMLDialogElement>(null)
  const selectedId = useRef('')
  const detailRead = useRef(0)
  const listRead = useRef(0)
  const identityRead = useRef(0)
  const opener = useRef<HTMLElement | null>(null)
  const mutation = useRef(false)
  const selectorDrafts = useRef<Partial<Record<Framework, string>>>({})
  const selected = detail?.instance
  const call = async <T,>(endpoint: string, payload: unknown = {}, machine = false): Promise<T> => {
    const response = await rpc.call(CHANNEL, `instances/${machine ? 'agentAccess' : 'external'}/${endpoint}`, payload)
    if (!response.ok) throw Object.assign(new Error(response.error.message), { responseReceived: true, code: response.error.code })
    return response.value as T
  }
  async function loadIdentity(id: string) {
    const at = ++identityRead.current
    try { const value = await call<IdentityStatus>('status', { instanceId: id }, true); if (at === identityRead.current && selectedId.current === id) { setIdentity(value); setIdentityError('') } }
    catch (error) { if (at === identityRead.current && selectedId.current === id) { setIdentity(null); setIdentityError(message(error)) } }
  }
  async function readDetail(id: string, navigate = false) {
    selectedId.current = id
    const at = ++detailRead.current
    if (detail?.instance.id !== id) { setDetail(null); setIdentity(null); setOutput(null); setSessionId(''); setInput(''); setAccessError(''); setSecret(null) }
    try {
      const value = await call<Detail>('detail', { id })
      if (at !== detailRead.current || selectedId.current !== id) return
      setDetail(value); setError(''); void loadIdentity(id)
      if (navigate) onNavigate?.({ page: 'instances', instance_name: id, tab: `external-${tab}` })
    } catch (error) { if (at === detailRead.current) setError(`详情读取失败：${message(error)}。请重新读取，已有输入保留。`) }
  }
  async function refresh() {
    const at = ++listRead.current
    setLoading(true)
    try {
      const value = await call<Listing>('list')
      if (at !== listRead.current) return
      setListing(value); setError('')
      if (selectedId.current) await readDetail(selectedId.current)
    } catch (error) { if (at === listRead.current) setError(`接入登记读取失败：${message(error)}`) }
    finally { if (at === listRead.current) setLoading(false) }
  }
  const refreshChanged = useQueuedRefresh(active, refresh)
  useEffect(() => { if (active) void refreshChanged() }, [active])
  useEffect(() => updates?.subscribe(() => { if (updates.getSnapshot().domains.includes('instances')) void refreshChanged() }), [updates])
  useEffect(() => () => { detailRead.current++; listRead.current++; identityRead.current++ }, [])
  useEffect(() => {
    if (!active || target?.page !== 'instances' || !target.tab?.startsWith('external')) return
    const requestedTab = target.tab.slice('external-'.length)
    if (tabs.some(item => item.id === requestedTab)) setTab(requestedTab as Tab)
    if (target.instance_name && target.instance_name !== selectedId.current) void readDetail(target.instance_name)
  }, [active, target?.page, target?.instance_name, target?.tab])
  useEffect(() => { if (active) onContext?.({ page: 'instances', tab: 'external', instance_name: selected?.id, agent_id: selected?.agentId, lifecycle_mode: 'externally-managed' }) }, [active, selected?.id, onContext])
  useEffect(() => {
    for (const [ref, visible] of [[editDialog, editing], [secretDialog, Boolean(secret)], [confirmDialog, Boolean(confirm)], [accessDialog, accessing]] as const) {
      if (active && visible) { if (!ref.current?.open) ref.current?.showModal() }
      else ref.current?.close()
    }
    if (!active) setSecret(null)
  }, [active, editing, secret, confirm, accessing])
  const visible = useMemo(() => (listing?.instances ?? []).filter(item => {
    const agent = listing?.agents.find(agent => agent.id === item.agentId)
    return (!framework || item.framework === framework) && (!stateFilter || entryState(item) === stateFilter)
      && `${item.name} ${agent?.name ?? ''} ${agent?.system ?? ''} ${agent?.owner ?? ''} ${item.instanceOwner ?? ''} ${item.location ?? ''}`.toLowerCase().includes(query.toLowerCase())
  }), [listing, query, framework, stateFilter])
  function openEditor(row?: Detail) {
    opener.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement
    editDialog.current?.querySelector('.external-more-settings')?.removeAttribute('open')
    if (pendingReadback) { setEditing(true); return }
    if (!row && saveRequestId && (draft.name || draft.instanceName || draft.endpoint)) { setEditing(true); return }
    selectorDrafts.current = row ? { [row.instance.framework]: row.instance.selector ?? '' } : {}
    setDraft(row ? { instanceId: row.instance.id, agentId: row.agent.id, name: row.agent.name, system: row.agent.system, owner: row.agent.owner, instanceName: row.instance.name,
      framework: row.instance.framework, endpoint: row.instance.endpoint, selector: row.instance.selector ?? '', declaredVersion: row.instance.declaredVersion ?? '', credentialRef: row.instance.credentialRef ?? '', subjects: (row.policy?.subjects ?? []).join(', '), actions: (row.policy?.actions ?? split(actions)).join(', '), description: row.instance.description ?? '', location: row.instance.location ?? '', instanceOwner: row.instance.instanceOwner ?? '' } : emptyDraft())
    setDraftRevision(row?.revision ?? listing?.revision ?? ''); setDraftError(''); setSaveRequestId(requestId()); setPendingReadback(false); setLatestDraftBase(null); setEditing(true)
  }
  function updateDraft(patch: Partial<Draft>) { if (pendingReadback) return; setDraft(current => ({ ...current, ...patch })); setSaveRequestId(requestId()); setDraftError('') }
  function changeFramework(framework: Framework) {
    selectorDrafts.current[draft.framework] = draft.selector
    updateDraft({ framework, selector: selectorDrafts.current[framework] ?? '' })
  }
  function closeEditor() { setEditing(false); opener.current?.focus?.(); opener.current = null }
  async function readLatestDraftBase() {
    setBusy('读取最新登记版本')
    try {
      const latest = await call<Listing>('list'); setListing(latest)
      const value = draft.instanceId ? await call<Detail>('detail', { id: draft.instanceId }) : null
      setLatestDraftBase(value); setDraftRevision(value?.revision ?? latest.revision); setSaveRequestId(requestId())
      setDraftError('已读取最新登记版本，您的草稿保持原样。请对照当前记录核对字段，再保存本次修改。')
    } catch (error) { setDraftError(`最新登记版本读取失败：${message(error)}。草稿保持原样。`) }
    finally { setBusy('') }
  }
  async function readSaveResult() {
    setBusy('核对保存结果')
    try {
      const result = await call<{ found: boolean; detail?: Detail }>('request', { requestId: saveRequestId })
      const value = result.detail
      if (result.found && value?.instance) { setDetail(value); selectedId.current = value.instance.id; setDraftRevision(value.revision); setPendingReadback(false); setNotice(`已从服务端核对登记与当前入口状态（${labels[entryState(value.instance, value.policy)] ?? '未知'}）；没有重复提交或继续执行后续操作。`); closeEditor(); setDraft(emptyDraft()); setSaveRequestId(''); await refresh() }
      else setDraftError('尚未确认此请求已保存。请保留草稿并稍后再次核对，不会自动重复登记。')
    } catch (error) { setDraftError(`保存结果仍待核对：${message(error)}`) }
    finally { setBusy('') }
  }
  async function save(enable: boolean) {
    if (mutation.current || pendingReadback) return
    const missing = !draft.name.trim() ? ['请填写智能体名称。', '接入智能体名称']
      : enable && !draft.endpoint.trim() ? ['请填写服务地址后验证并启用。', '接入服务地址']
      : enable && draft.framework === 'agentscope' && !draft.selector.trim() ? ['请填写 AgentScope 服务中的 Agent ID。', '接入目标选择器']
      : enable && draft.framework === 'dsh' && !dshTarget(draft.selector).workspaceId.trim() ? ['请填写 DSH 的工作区 ID。', '接入工作区ID']
      : enable && draft.framework === 'dsh' && !dshTarget(draft.selector).agentPreset.trim() ? ['请填写 DSH 的 Agent Preset。', '接入AgentPreset']
      : enable && !split(draft.subjects).length ? ['请在更多设置中填写至少一个允许访问的主体。', '接入允许主体']
      : enable && !split(draft.actions).includes('agent:access') ? ['请在更多设置的开放操作中保留 agent:access，才能启用入口。', '接入开放操作'] : null
    if (missing) { setDraftError(missing[0]); const field = editDialog.current?.querySelector<HTMLElement>(`[aria-label="${missing[1]}"]`); field?.closest('details')?.setAttribute('open', ''); field?.focus(); return }
    mutation.current = true; setBusy('保存登记'); setDraftError('')
    try {
      const savingRequestId = saveRequestId || requestId()
      setSaveRequestId(savingRequestId)
      const agent = draft.agentId ? listing?.agents.find(item => item.id === draft.agentId) : undefined
      const saved = await call<Detail>('save', { revision: draftRevision, requestId: savingRequestId, agent: agent ?? { name: draft.name, system: draft.system.trim() || systemFromEndpoint(draft.endpoint), owner: draft.owner.trim() || '平台管理者' },
        instance: { ...(draft.instanceId ? { id: draft.instanceId } : {}), ...(draft.agentId ? { agentId: draft.agentId } : {}), name: draft.instanceName.trim() || draft.name.trim(), framework: draft.framework, endpoint: draft.endpoint, selector: draft.selector || undefined, declaredVersion: draft.declaredVersion || undefined, credentialRef: draft.credentialRef || undefined, managementMode: 'externally-managed', usageMode: 'shared', description: draft.description, location: draft.location, instanceOwner: draft.instanceOwner || undefined },
        policy: { subjects: split(draft.subjects), actions: split(draft.actions), enabled: true } })
      if (!saved.instance?.id) throw new Error('服务端未返回登记对象，保存结果需要核对')
      setDetail(saved); selectedId.current = saved.instance.id; setDraftRevision(saved.revision)
      setListing(current => current ? { ...current, revision: saved.revision, agents: [...current.agents.filter(agent => agent.id !== saved.agent.id), saved.agent], instances: [...current.instances.filter(instance => instance.id !== saved.instance.id), saved.instance] } : current)
      setDraft(current => ({ ...current, instanceId: saved.instance.id, agentId: saved.agent.id, name: saved.agent.name, system: saved.agent.system, owner: saved.agent.owner,
        instanceName: saved.instance.name, endpoint: saved.instance.endpoint, selector: saved.instance.selector ?? '', declaredVersion: saved.instance.declaredVersion ?? '', credentialRef: saved.instance.credentialRef ?? '',
        description: saved.instance.description ?? '', location: saved.instance.location ?? '', instanceOwner: saved.instance.instanceOwner ?? '', subjects: saved.policy.subjects.join(', '), actions: saved.policy.actions.join(', ') }))
      setPendingReadback(false)
      if (enable) {
        setBusy('验证接入')
        const verificationRequestId = requestId(); setSaveRequestId(verificationRequestId)
        const verified = await call<Detail>('verify', { id: saved.instance.id, revision: saved.revision, requestId: verificationRequestId })
        setDetail(verified); setDraftRevision(verified.revision)
        setBusy('启用入口')
        const enableRequestId = requestId(); setSaveRequestId(enableRequestId)
        const enabled = await call<Detail>('enable', { id: saved.instance.id, revision: verified.revision, requestId: enableRequestId })
        setDetail(enabled); setNotice('已验证并启用核定入口。资源授权与原生运行状态请分别查看。')
      } else setNotice('登记已保存，业务入口尚未开放。请验证并启用核定范围。')
      closeEditor(); setDraft(emptyDraft()); setSaveRequestId(''); await refresh()
    } catch (error) {
      const text = message(error)
      if (!(error as { responseReceived?: boolean })?.responseReceived) { setPendingReadback(true); setDraftError(`保存、验证或启用结果待核对：${text}。请先查询结果，不要重复提交。`) }
      else { setSaveRequestId(requestId()); setDraftError(`${text}。已填写的非秘密内容保留；如登记已保存，可从详情继续验证。`) }
    } finally { mutation.current = false; setBusy('') }
  }
  async function mutate(operation: 'verify' | 'enable' | 'disable' | 'remove') {
    if (!detail || mutation.current) return
    const id = detail.instance.id
    mutation.current = true; setBusy(operation); setError(''); setConfirm(null)
    try {
      const result = await call<Detail>(operation, { id, revision: detail.revision, requestId: requestId() })
      if (selectedId.current === id) setDetail(result)
      setNotice(operation === 'remove' ? '登记已移除，平台访问入口已撤销；远端服务和数据保留。' : operation === 'disable' ? '入口已停用；远端进程及其资源授予保持独立状态。' : operation === 'verify' ? '已读取本次验证结果；只有核定能力通过后才能启用入口。' : '已启用核定入口。')
      await refresh()
    } catch (error) { const failure = `${message(error)}。已读取当前登记核对实际结果；不会自动重放操作。`; await refresh(); setError(failure) }
    finally { mutation.current = false; setBusy('') }
  }
  async function identityAction(operation: string, extra: Record<string, unknown> = {}) {
    if (!selected || mutation.current) return
    const id = selected.id
    mutation.current = true; setBusy(operation); setIdentityError(''); setConfirm(null)
    try {
      const result = await call<{ credential: Credential; secret: string }>(operation, { instanceId: id, ...(identity?.revision ? { revision: identity.revision } : {}), ...extra }, true)
      if (selectedId.current !== id) return
      if (result?.secret && result.credential) setSecret(result)
      setNotice(operation === 'saveGrant' ? '资源授予已保存，请以实际资源调用核对生效。' : operation === 'revokeCredential' || operation === 'disableResourceAccess' ? '已提交对应签名访问撤销；其他非签名服务和实例入口分别管理。' : '实例身份操作已完成。')
      await loadIdentity(id)
    } catch (error) { if (selectedId.current === id) setIdentityError(`${message(error)}。请重新读取身份状态核对结果；秘密交付结果未知时应撤销该凭据后重新创建。`) }
    finally { mutation.current = false; setBusy('') }
  }
  async function invoke(operation: 'session:create' | 'session:prompt' | 'session:read' | 'session:events') {
    if (!selected || mutation.current) return
    const id = selected.id
    mutation.current = true; setBusy('访问实例'); setAccessError('')
    try {
      const value = await call<Record<string, unknown>>('invoke', { id, operation, sessionId: sessionId || undefined, input: operation === 'session:prompt' ? input : undefined, requestId: requestId() })
      if (selectedId.current !== id) return
      setOutput(value)
      const nativeSession = value.sessionId ?? (value.value as { sessionId?: string } | undefined)?.sessionId
      if (typeof nativeSession === 'string') setSessionId(nativeSession)
      void readDetail(id)
    } catch (error) { if (selectedId.current === id) setAccessError(`访问未取得完整结果：${message(error)}。输入保留；已转发请求的执行结果请查访问记录，不会自动重试。`) }
    finally { mutation.current = false; setBusy('') }
  }
  const linkedAgent = listing?.agents.find(item => item.id === draft.agentId)
  return <section className="external-instances" aria-label="接入实例" hidden={!active}>
    <style>{externalInstanceTheme}</style>
    <div className="external-toolbar">
      <label>搜索<input aria-label="搜索接入实例" placeholder="实例、智能体、系统或责任主体" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>框架<select aria-label="接入框架筛选" value={framework} onChange={event => setFramework(event.target.value)}><option value="">全部框架</option>{Object.entries(frameworks).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label>入口<select aria-label="接入入口状态筛选" value={stateFilter} onChange={event => setStateFilter(event.target.value)}><option value="">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="pending">待验证</option><option value="draft">草稿</option></select></label>
      <div className="external-toolbar-actions"><button type="button" disabled={loading} onClick={() => void refreshChanged()}>刷新接入登记{loading && <LoadingIndicator label="读取接入登记" />}</button><button type="button" className="harness-primary" disabled={Boolean(busy) || !listing} onClick={() => openEditor()}>登记已有智能体</button></div>
    </div>
    <p className="external-note">原系统负责部署、启停和升级。平台管理已验证的访问路径；登记、入口状态与原生运行状态分别核对。{listing && <> 最近读取：{stamp(listing.observedAt)}，当前 {visible.length} 项。</>}</p>
    {error && <div role="alert" className="instance-error">{error}<div><button type="button" disabled={loading} onClick={() => void refresh()}>重新读取接入登记</button></div></div>}
    {notice && <p role="status" className="external-note">{notice}</p>}
    {!listing && !error && <LoadingIndicator label="读取接入实例" block />}
    {listing && !visible.length && <div className="external-empty">{listing.instances.length ? '当前筛选没有匹配实例。可以调整搜索、框架或入口条件。' : '尚无接入登记。可以登记已有智能体，无需创建 Harness 版本或 Experiment。'}</div>}
    <div className="external-list">{visible.map(item => { const agent = listing?.agents.find(agent => agent.id === item.agentId); return <article key={item.id} className="external-row" data-current={selected?.id === item.id}>
      <div><h3>{item.name}</h3><p>{agent?.name ?? '逻辑智能体待核对'}</p><p className="external-row-meta">{agent?.system ?? '所属系统未知'} · {agent?.owner ?? '责任主体未知'}</p></div>
      <div><p>{frameworks[item.framework] ?? item.framework} · {'原生 API'}</p><p className="external-row-meta">原系统负责生命周期</p></div>
      <div><Badge state={entryState(item)} /><p className="external-row-meta">最近接入验证：{item.verification ? item.verification.ok ? '通过' : '未通过' : '未知'} · {stamp(item.verification?.observedAt)}</p></div>
      <div className="external-row-actions"><button type="button" onClick={() => { setTab('overview'); void readDetail(item.id, true) }}>查看接入详情</button><button type="button" disabled={Boolean(busy)} onClick={() => { setTab('overview'); void readDetail(item.id, true); setAccessing(true) }}>访问</button></div>
    </article> })}</div>
    {selected && detail && <section className="external-detail" aria-label={`${selected.name}接入详情`}>
      <header className="external-detail-heading"><div><h2>{selected.name}</h2><p className="external-row-meta">{detail.agent.name} · {detail.agent.system} · {detail.agent.owner}</p></div><div className="external-row-actions"><button type="button" disabled={Boolean(busy)} onClick={() => openEditor(detail)}>编辑接入</button><button type="button" onClick={() => { selectedId.current = ''; detailRead.current++; identityRead.current++; setDetail(null); setIdentity(null); setSecret(null); onNavigate?.({ page: 'instances', tab: 'external' }) }}>返回接入列表</button></div></header>
      <div role="tablist" aria-label="接入实例详情" className="instance-detail-tabs">{tabs.map(item => <button key={item.id} type="button" role="tab" className="instance-detail-tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id); onNavigate?.({ page: 'instances', instance_name: selected.id, tab: `external-${item.id}` }) }}>{item.label}</button>)}</div>
      <div className="external-detail-body" role="tabpanel" aria-label={tabs.find(item => item.id === tab)?.label}>
        {tab === 'overview' && <><Facts rows={[[ '所属系统', detail.agent.system ], ['责任主体', detail.agent.owner], ['框架', frameworks[selected.framework]], ['生命周期责任', '原系统 / 原责任方'], ['实例运维责任', selected.instanceOwner || detail.agent.owner], ['运行位置', selected.location || '未记录'], ['平台入口', <Badge state={entryState(selected, detail.policy)} />], ['原生运行', '未知；不从入口状态推定'], ['使用方式', '核定使用组共享；未声明逐用户数据隔离'], ['最近验证', stamp(selected.verification?.observedAt)]]} />
          <p className="external-note">当前可控范围以“接入与能力”的真实验证为准。停用入口不会停止远端进程；资源授权和任务取消分别处理。</p><div className="external-actions"><button type="button" className="harness-primary" disabled={Boolean(busy)} onClick={() => setAccessing(true)}>访问此实例</button><button type="button" disabled={Boolean(busy)} onClick={() => void mutate('verify')}>重新验证接入</button><button type="button" disabled={Boolean(busy)} onClick={() => void mutate('enable')}>启用已验证入口</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirm('disable')}>停用入口</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirm('remove')}>移除登记</button></div></>}
        {tab === 'connection' && <><Facts rows={[[ '目标入口', selected.endpoint || '未填写' ], ['目标选择器', selected.selector || '未指定'], ['声明版本', selected.declaredVersion || '未知'], ['观测版本', selected.verification?.observedVersion || '未知'], ['凭据引用', selected.credentialRef || '未配置'], ['接入验证', <Badge state={selected.verification ? selected.verification.ok ? 'verified' : 'failed' : 'unverified'} />]]} />
          <p className="external-note">地址、凭据、适配器或开放能力变化后，需要重新验证受影响路径。验证结果只覆盖相应绑定、版本和检查项目。</p>
          <ul className="external-capabilities">{selected.verification?.checks.map((check, index) => <li key={`${check.name}-${index}`}><Badge state={check.ok ? 'verified' : 'failed'} /><span>{check.detail}</span></li>)}</ul><details><summary>查看能力与验证明细</summary><pre className="external-output">{JSON.stringify(selected.verification ?? { status: 'unverified', note: '尚无本次登记的验证记录' }, null, 2)}</pre></details>
          <h3>实例身份</h3>{identityError && <p role="alert" className="instance-error">{identityError}</p>}{identity ? <><p className="external-note">此处展示凭据持有证据与有效期，不代表代码完整或任务安全。普通详情不显示秘密。</p><div className="external-table-scroll"><table className="external-table"><thead><tr><th>客户端 / 凭据编号</th><th>状态 / 到期</th><th>操作</th></tr></thead><tbody>{identity.credentials.map(item => <tr key={item.id}><td>{item.clientId}<br/><span className="external-row-meta">{item.id}</span></td><td><Badge state={item.effectiveStatus ?? item.status} /><br/>{stamp(item.expiresAt)}</td><td><button type="button" disabled={Boolean(busy) || item.status === 'revoked'} onClick={() => void identityAction('revokeCredential', { credentialId: item.id })}>撤销此凭据</button></td></tr>)}</tbody></table></div>{!identity.credentials.length && <p>尚未配置实例访问 key。独立通过的入口不依赖签名能力启用。</p>}</> : !identityError && <LoadingIndicator label="读取实例身份" />}
          <div className="external-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void loadIdentity(selected.id)}>重新读取身份</button><button type="button" disabled={Boolean(busy)} onClick={() => void identityAction('createCredential')}>创建实例凭据</button><button type="button" disabled={Boolean(busy) || !identity?.credentials.length} onClick={() => void identityAction('rotateCredential')}>轮换实例凭据</button></div></>}
        {tab === 'authorization' && <><h3>谁能访问实例</h3><Facts rows={[[ '授权主体', detail.policy?.subjects.join('、') || '尚未授予' ], ['开放操作', detail.policy?.actions.join('、') || '尚未授予'], ['入口状态', <Badge state={entryState(selected, detail.policy)} />], ['使用边界', '实例服务账户与核定人群使用相同资源范围；无用户委托声明']]} /><div className="external-actions"><button type="button" disabled={Boolean(busy)} onClick={() => openEditor(detail)}>编辑入口授权</button></div>
          <h3>要求 Harness 凭证的服务</h3><p className="external-note">仅这里明确授予的资源附加 Harness 凭证。其他服务继续原路径、原认证；停用签名资源访问不会停止实例。</p>{identityError && <p role="alert" className="instance-error">{identityError}</p>}
          {identity && <><div className="external-table-scroll"><table className="external-table"><thead><tr><th>资源</th><th>范围 / 对象</th><th>状态 / 版本</th></tr></thead><tbody>{identity.grants.map(grant => <tr key={grant.resourceId}><td>{grant.resourceId}</td><td>{grant.scopes.join('、')}<br/><span className="external-row-meta">{grant.objects?.join('、') || '以资源配置为准'}</span></td><td>{grant.enabled ? '已启用' : '已禁用'} · {grant.version}</td></tr>)}</tbody></table></div>{!identity.grants.length && <p>尚无签名资源授予。</p>}
          <form className="external-resource-form" onSubmit={event => { event.preventDefault(); void identityAction('saveGrant', { resourceId: grantDraft.resourceId, scopes: split(grantDraft.scopes), objects: split(grantDraft.objects), enabled: true }) }}>
            <label>目标资源<select aria-label="签名授权目标资源" required value={grantDraft.resourceId} onChange={event => { const resource = identity.resources.find(item => item.id === event.target.value); setGrantDraft({ resourceId: event.target.value, scopes: resource ? [...new Set(resource.tools.map(item => item.scope))].join(', ') : '', objects: '' }) }}><option value="">选择已登记资源</option>{identity.resources.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
            <label>操作范围<input aria-label="签名资源操作范围" required value={grantDraft.scopes} onChange={event => setGrantDraft(current => ({ ...current, scopes: event.target.value }))} placeholder="以逗号分隔 scope" /></label><label className="external-wide">资源对象<input aria-label="签名资源对象范围" value={grantDraft.objects} onChange={event => setGrantDraft(current => ({ ...current, objects: event.target.value }))} placeholder="以逗号分隔对象 ID；按资源合同填写" /></label><div className="external-actions external-wide"><button type="submit" disabled={Boolean(busy) || !grantDraft.resourceId}>保存资源授予</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirm('disableResourceAccess')}>禁用 Harness 签名资源访问</button></div>
          </form></>}
        </>}
        {tab === 'records' && <><p className="external-note">记录区分授权、实际转发、返回和结果未知；历史记录不表示当前状态。</p><button type="button" disabled={Boolean(busy) || loading} onClick={() => void readDetail(selected.id)}>刷新访问记录</button><div className="external-table-scroll"><table className="external-table"><thead><tr><th>时间 / 请求</th><th>操作 / 主体</th><th>阶段 / 原因</th></tr></thead><tbody>{(detail.records ?? []).map(record => <tr key={record.id}><td>{stamp(record.at)}<br/><span className="external-row-meta">{record.requestId}</span></td><td>{record.operation}<br/>{record.subjectId ?? '见认证记录'}</td><td>{labels[record.stage] ?? record.stage} · {labels[record.result] ?? record.result}<br/>{record.reason ?? ''}<details><summary>关联信息</summary><pre className="external-output">{JSON.stringify(record, null, 2)}</pre></details></td></tr>)}</tbody></table></div>{!detail.records?.length && <p>当前没有可查询的访问记录。</p>}</>}
      </div>
    </section>}
    <dialog ref={editDialog} className="instance-dialog external-dialog" aria-labelledby="external-edit-title" onCancel={event => { event.preventDefault(); if (!busy) closeEditor() }}>
      <header className="instance-dialog-heading external-dialog-heading"><h2 id="external-edit-title">{draft.instanceId ? '编辑接入实例' : '登记已有智能体'}</h2><button type="button" disabled={Boolean(busy)} aria-label="关闭接入登记并保留草稿" onClick={closeEditor}>×</button></header>
      <div className="instance-dialog-content"><p className="external-note external-form-intro">* 为完成接入、验证启用时必填；也可先保存登记，稍后补齐连接。</p>{draftError && <div role="alert" className="instance-error"><p>{draftError}</p>{!pendingReadback && <button type="button" disabled={Boolean(busy)} onClick={() => void readLatestDraftBase()}>保留草稿并读取最新版本</button>}</div>}{latestDraftBase && <details open><summary>服务端当前登记 · 请与草稿核对</summary><Facts rows={[['实例名称', latestDraftBase.instance.name], ['服务地址', latestDraftBase.instance.endpoint || '未填写'], ['允许主体', latestDraftBase.policy.subjects.join('、')], ['开放操作', latestDraftBase.policy.actions.join('、')]]} /></details>}
        <fieldset className="external-form external-form-fields" disabled={Boolean(busy) || pendingReadback}>
          <label><span>智能体名称<Required /></span><input aria-label="接入智能体名称" required aria-required="true" value={draft.name} readOnly={Boolean(linkedAgent)} onChange={event => updateDraft({ name: event.target.value })} /></label>
          <label><span>框架<Required /></span><select aria-label="接入实例框架" required aria-required="true" value={draft.framework} onChange={event => changeFramework(event.target.value as Framework)}>{Object.entries(frameworks).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="external-wide"><span>服务地址<Required /></span><input aria-label="接入服务地址" required aria-required="true" value={draft.endpoint} onChange={event => updateDraft({ endpoint: event.target.value })} placeholder="http(s)://已有实例的服务地址" /></label>
          {draft.framework === 'agentscope' && <label className="external-wide"><span>AgentScope Agent ID<Required /></span><input aria-label="接入目标选择器" required aria-required="true" value={draft.selector} onChange={event => updateDraft({ selector: event.target.value })} placeholder="原服务中的 agent_id" /></label>}
          {draft.framework === 'dsh' && <><label><span>工作区 ID<Required /></span><input aria-label="接入工作区ID" required aria-required="true" value={dshTarget(draft.selector).workspaceId} onChange={event => updateDraft({ selector: JSON.stringify({ ...dshTarget(draft.selector), workspaceId: event.target.value }) })} /></label><label><span>Agent Preset<Required /></span><input aria-label="接入AgentPreset" required aria-required="true" value={dshTarget(draft.selector).agentPreset} onChange={event => updateDraft({ selector: JSON.stringify({ ...dshTarget(draft.selector), agentPreset: event.target.value }) })} placeholder="如 standard" /></label></>}
          <details className="external-wide external-more-settings"><summary>更多设置（选填或沿用当前配置）</summary><div className="external-form">
            {Boolean(listing?.agents.length) && <label className="external-wide"><span>关联已登记智能体（选填）</span><select aria-label="关联已登记智能体" value={draft.agentId} onChange={event => { const agent = listing?.agents.find(item => item.id === event.target.value); updateDraft({ agentId: event.target.value, ...(agent ? { name: agent.name, system: agent.system, owner: agent.owner } : {}) }) }} disabled={Boolean(draft.instanceId)}><option value="">登记新智能体</option>{listing?.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.system}</option>)}</select></label>}
            {draft.framework === 'opencode' && <label className="external-wide"><span>OpenCode 工作目录（选填）</span><input aria-label="接入工作目录" value={draft.selector} onChange={event => updateDraft({ selector: event.target.value })} placeholder="留空使用原实例默认目录" /></label>}
            <label className="external-wide"><span>上游凭据引用（选填）</span><input aria-label="接入上游凭据引用" value={draft.credentialRef} onChange={event => updateDraft({ credentialRef: event.target.value })} placeholder="引用已保存的专用凭据，不填写秘密" /></label>
            <label><span>实例名称（选填）</span><input aria-label="接入实例名称" value={draft.instanceName} onChange={event => updateDraft({ instanceName: event.target.value })} placeholder="默认沿用智能体名称" /></label>
            <label><span>所属系统（选填）</span><input aria-label="接入所属系统" value={draft.system} readOnly={Boolean(linkedAgent)} onChange={event => updateDraft({ system: event.target.value })} placeholder="默认使用服务地址的主机名" /></label>
            <label><span>责任主体（选填）</span><input aria-label="接入责任主体" value={draft.owner} readOnly={Boolean(linkedAgent)} onChange={event => updateDraft({ owner: event.target.value })} placeholder="默认平台管理者" /></label>
            <label><span>运行位置（选填）</span><input aria-label="接入运行位置" value={draft.location} onChange={event => updateDraft({ location: event.target.value })} placeholder="主机或部署位置说明" /></label>
            <label className="external-wide"><span>实例运维责任（选填）</span><input aria-label="接入实例运维责任" value={draft.instanceOwner} onChange={event => updateDraft({ instanceOwner: event.target.value })} placeholder="默认沿用智能体责任主体" /></label>
            <label className="external-wide"><span>允许访问主体（{draft.instanceId ? '沿用当前配置' : '默认 platform-owner'}）<Required /></span><input aria-label="接入允许主体" required aria-required="true" value={draft.subjects} onChange={event => updateDraft({ subjects: event.target.value })} placeholder="以逗号分隔已认证主体 ID" /></label>
            <label className="external-wide"><span>开放操作（{draft.instanceId ? '沿用当前配置' : '默认已配置'}）<Required /></span><input aria-label="接入开放操作" required aria-required="true" value={draft.actions} onChange={event => updateDraft({ actions: event.target.value })} /></label>
            <label className="external-wide"><span>声明版本（选填）</span><input aria-label="接入声明版本" value={draft.declaredVersion} onChange={event => updateDraft({ declaredVersion: event.target.value })} /></label>
            <label className="external-wide"><span>说明（选填）</span><textarea aria-label="接入说明" value={draft.description} onChange={event => updateDraft({ description: event.target.value })} /></label>
            <p className="external-note external-wide">{draft.instanceId ? '保留当前登记与访问范围；实际值以字段内容为准。' : '新登记默认仅平台管理者（platform-owner）可访问。'}未自定义时，实例名沿用智能体名称、系统取服务主机名、责任主体为平台管理者。启用时须保留至少一个允许主体及 agent:access 操作。</p>
            {linkedAgent && <p className="external-note external-wide">名称、所属系统和责任主体来自已登记智能体，仅供查看；当前操作不会修改公共信息。</p>}
          </div></details>
        </fieldset>
      </div><footer className="instance-dialog-actions"><button type="button" disabled={Boolean(busy)} onClick={closeEditor}>关闭并保留草稿</button>{pendingReadback ? <button type="button" className="harness-primary" disabled={Boolean(busy)} onClick={() => void readSaveResult()}>核对保存结果</button> : <><button type="button" disabled={Boolean(busy)} onClick={() => void save(false)}>保存登记</button><button type="button" className="harness-primary" disabled={Boolean(busy)} onClick={() => void save(true)}>验证并启用访问</button></>}{busy && <LoadingIndicator label={busy} />}</footer>
    </dialog>
    <dialog ref={confirmDialog} className="instance-dialog external-dialog" aria-labelledby="external-confirm-title" onCancel={event => { event.preventDefault(); setConfirm(null) }}><header className="instance-dialog-heading"><h2 id="external-confirm-title">{confirm === 'remove' ? '移除登记' : confirm === 'disable' ? '停用入口' : '禁用 Harness 签名资源访问'}</h2></header><div className="instance-dialog-content"><p>对象：{selected?.name ?? '请重新选择实例'}</p><p>{confirm === 'remove' ? '撤销平台登记与访问入口，保留远端服务、进程和数据。' : confirm === 'disable' ? '拒绝新的入口访问并处理受影响连接。不会停止远端进程，也不自动撤销资源授予。' : '撤销此实例对应的 Harness 签名资源授予。其他非签名服务按原方式继续访问。'}</p></div><footer className="instance-dialog-actions"><button type="button" onClick={() => setConfirm(null)}>取消</button><button type="button" className="instance-danger-button" disabled={Boolean(busy) || !selected} onClick={() => confirm && void (confirm === 'disableResourceAccess' ? identityAction(confirm) : mutate(confirm))}>确认{confirm === 'remove' ? '移除登记' : confirm === 'disable' ? '停用入口' : '禁用签名资源访问'}</button></footer></dialog>
    <dialog ref={secretDialog} className="instance-dialog external-dialog" aria-labelledby="external-secret-title" onCancel={event => { event.preventDefault(); setSecret(null) }}><header className="instance-dialog-heading"><h2 id="external-secret-title">交付实例凭据</h2></header><div className="instance-dialog-content">{secret && <><p>仅此创建流程展示一次。将凭据交给对应可信 connector；不要放入模型消息、工具参数或普通日志。</p><Facts rows={[[ 'client ID', secret.credential.clientId ], ['凭据编号', secret.credential.id], ['有效至', stamp(secret.credential.expiresAt)]]} /><label>实例 secret<textarea aria-label="仅本次交付的实例secret" className="external-secret" readOnly value={secret.secret} /></label></>}</div><footer className="instance-dialog-actions"><button type="button" className="harness-primary" onClick={() => setSecret(null)}>已交付，关闭秘密</button></footer></dialog>
    <dialog ref={accessDialog} className="instance-dialog external-dialog" aria-labelledby="external-access-title" onCancel={event => { event.preventDefault(); setAccessing(false) }}><header className="instance-dialog-heading external-dialog-heading"><h2 id="external-access-title">访问 {selected?.name ?? '正在读取实例'}</h2><button type="button" aria-label="关闭实例访问并保留输入" onClick={() => setAccessing(false)}>×</button></header><div className="instance-dialog-content"><p className="external-note">通过平台核定入口调用；请求受理与任务完成分别核对。关闭此窗口不代表取消后台任务。管理访问页手动读取结果；脚本流订阅按接入说明调用已验证的事件入口。</p>{accessError && <p role="alert" className="instance-error">{accessError}</p>}<div className="external-access-form"><label>会话标识<input aria-label="接入访问会话标识" value={sessionId} onChange={event => setSessionId(event.target.value)} placeholder="创建后由真实接口返回" /></label><label>输入<textarea aria-label="接入实例访问输入" value={input} onChange={event => setInput(event.target.value)} /></label><div className="external-actions"><button type="button" disabled={Boolean(busy) || !selected} onClick={() => void invoke('session:create')}>创建会话</button><button type="button" className="harness-primary" disabled={Boolean(busy) || !selected || !sessionId || !input.trim()} onClick={() => void invoke('session:prompt')}>发送请求</button><button type="button" disabled={Boolean(busy) || !selected || !sessionId} onClick={() => void invoke('session:read')}>核对会话结果</button>{busy === '访问实例' && <LoadingIndicator label="等待实例返回" />}</div></div>{output !== null && <div role="status"><p>实际接口回执；仅收到响应或任务受理时，不表示业务完成。</p><p><Badge state={String((output as { stage?: string }).stage ?? 'unknown')} /></p><div className="external-output">{resultText(output).join('\n\n') || '已收到结构化结果，可展开接口回执核对。'}</div><details><summary>接口回执与关联信息</summary><pre className="external-output">{JSON.stringify(output, null, 2)}</pre></details></div>}</div><footer className="instance-dialog-actions"><button type="button" onClick={() => setAccessing(false)}>关闭并保留输入</button></footer></dialog>
  </section>
}
