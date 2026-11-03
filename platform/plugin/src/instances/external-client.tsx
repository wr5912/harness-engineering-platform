import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CHANNEL, type PlatformNavigation, type PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { useQueuedRefresh } from '../realtime/refresh.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { externalInstanceTheme } from './external-style.ts'
import type { ExternalDetail as Detail, ExternalInstance as Instance, ExternalList as Listing, ExternalFramework as Framework, ExternalDiscoveryResult as Discovery, ExternalDiscoveryChoices as Choices, ExternalConversationResult as ConversationResult } from './external/types.ts'

interface Credential { id: string; clientId: string; instanceId: string; status: string; effectiveStatus?: string; createdAt: string; expiresAt: string; retireAt?: string }
interface Resource { id: string; audience: string; tools: { name: string; scope: string }[] }
interface Grant { instanceId: string; resourceId: string; scopes: string[]; objects?: string[]; enabled: boolean; version: number }
interface IdentityStatus { instanceId: string; credentials: Credential[]; grants: Grant[]; resources: Resource[]; issuer: string; revision: string }
interface Draft {
  instanceId?: string; agentId: string; name: string; instanceName: string
  framework: Framework; endpoint: string; selector: string; credentialRef: string
  subjects: string; actions: string; connectionUserId: string; policyEnabled: boolean
}
type EditorMode = 'register' | 'connection' | 'metadata' | 'authorization'
interface ConversationDraft {
  input: string; sessionId?: string; requestId?: string; status: 'idle' | 'sending' | ConversationResult['status']
  result?: ConversationResult; error?: string; paused?: boolean; restoreResult?: boolean; readRound: number
}
interface CachedEditor { draft: Draft; revision: string; requestId: string; discovery: Discovery | null; discoveryError: string }
interface BrowserRecovery {
  conversations: Record<string, Pick<ConversationDraft, 'input' | 'sessionId' | 'requestId' | 'status'>>
  editors: Record<string, CachedEditor>
  editor?: CachedEditor & { mode: EditorMode; pendingReadback: boolean; open: boolean }
  accessId?: string; accessing?: boolean
}
type Tab = 'overview' | 'connection' | 'authorization' | 'records'
const tabs: Array<{ id: Tab; label: string }> = [{ id: 'overview', label: '概览' }, { id: 'connection', label: '接入与能力' }, { id: 'authorization', label: '访问授权' }, { id: 'records', label: '访问记录' }]
const frameworks: Record<Framework, string> = { dsh: 'DSH', agentscope: 'AgentScope', opencode: 'OpenCode' }
const entryActions = [{ id: 'agent:access', name: '访问实例' }, { id: 'session:create', name: '创建会话' }, { id: 'session:prompt', name: '发送消息' }, { id: 'session:read', name: '查看结果' }, { id: 'session:events', name: '接收事件' }]
const labels: Record<string, string> = { enabled: '已启用', disabled: '已停用', pending: '待验证', draft: '草稿', registered: '已登记', removed: '已移除', verified: '已验证', passed: '已验证', failed: '未通过', unreachable: '不可达', reachable: '可达', unknown: '未知', active: '有效', expired: '已过期', revoked: '已撤销', unverified: '未验证', not_dispatched: '未转发', dispatching: '已开始转发', dispatched: '已转发', received: '已收到响应', responded: '已收到响应', accepted: '任务已受理', completed: '执行完成', error: '返回错误', response: '已收到响应', management: '管理操作', connection_closed: '连接已关闭', allow: '允许', deny: '拒绝' }
const emptyDraft = (): Draft => ({ agentId: '', name: '', instanceName: '', framework: 'agentscope', endpoint: '', selector: '', credentialRef: '', subjects: '', actions: '', connectionUserId: '', policyEnabled: false })
const emptyConversation = (): ConversationDraft => ({ input: '', status: 'idle', readRound: 0 })
function dshTarget(selector: string): { workspaceId: string; agentPreset: string } {
  try { const value = JSON.parse(selector); return { workspaceId: typeof value?.workspaceId === 'string' ? value.workspaceId : '', agentPreset: typeof value?.agentPreset === 'string' ? value.agentPreset : '' } }
  catch { return { workspaceId: '', agentPreset: '' } }
}

function Required() { return <span className="external-required" aria-hidden="true">*</span> }
const split = (value: string) => [...new Set(value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
const stamp = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '尚无观测'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const requestId = () => typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`
const entryState = (instance: Instance, _policy?: Detail['policy']) => instance.state === 'removed' ? 'removed' : instance.entryState
function Badge({ state }: { state?: string }) { return <span className="external-badge" data-state={state ?? 'unknown'}>{labels[state ?? 'unknown'] ?? state}</span> }
function Facts({ rows }: { rows: Array<[string, ReactNode]> }) { return <dl className="external-facts">{rows.map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value ?? '未知'}</dd></div>)}</dl> }
const conversationPending = (value?: ConversationDraft) => Boolean(value?.requestId) && (Boolean(value?.restoreResult) || !['completed', 'failed'].includes(value?.status ?? ''))

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
  const [editorMode, setEditorMode] = useState<EditorMode>('register')
  const [discovery, setDiscovery] = useState<Discovery | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState('')
  const [credentialRefs, setCredentialRefs] = useState<string[]>([])
  const [credentialError, setCredentialError] = useState('')
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [draftRevision, setDraftRevision] = useState('')
  const [draftError, setDraftError] = useState('')
  const [saveRequestId, setSaveRequestId] = useState('')
  const [pendingReadback, setPendingReadback] = useState(false)
  const [latestDraftBase, setLatestDraftBase] = useState<Detail | null>(null)
  const [confirm, setConfirm] = useState<'disable' | 'remove' | 'disableResourceAccess' | null>(null)
  const [secret, setSecret] = useState<{ credential: Credential; secret: string } | null>(null)
  const [accessing, setAccessing] = useState(false)
  const [accessId, setAccessId] = useState('')
  const [conversations, setConversations] = useState<Record<string, ConversationDraft>>({})
  const [grantDraft, setGrantDraft] = useState({ resourceId: '', scopes: '', objects: '' })
  const [recoveryReady, setRecoveryReady] = useState(false)
  const [recoveryWorkspace, setRecoveryWorkspace] = useState('')
  const [recoveryRound, setRecoveryRound] = useState(0)
  const [storageError, setStorageError] = useState('')
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
  const discoveryRead = useRef(0)
  const conversationStates = useRef<Record<string, ConversationDraft>>({})
  const accessObject = useRef('')
  const editorCache = useRef<Record<string, CachedEditor>>({})
  const recoveryKey = useRef('')
  const recovery = useRef<BrowserRecovery>({ conversations: {}, editors: {} })
  const canOperate = recoveryReady && recoveryWorkspace === listing?.workspaceId
  const selected = detail?.instance
  const call = async <T,>(endpoint: string, payload: unknown = {}, machine = false, signal?: AbortSignal): Promise<T> => {
    const response = await rpc.call(CHANNEL, `instances/${machine ? 'agentAccess' : 'external'}/${endpoint}`, payload, signal)
    if (!response.ok) throw Object.assign(new Error(response.error.message), { responseReceived: true, code: response.error.code })
    return response.value as T
  }
  function persistRecovery(patch: Partial<BrowserRecovery>) {
    recovery.current = { ...recovery.current, ...patch }
    if (!recoveryKey.current) return
    try { sessionStorage.setItem(recoveryKey.current, JSON.stringify(recovery.current)) }
    catch { setStorageError('浏览器无法保存恢复信息。内容仅保留在当前页面，刷新后无法恢复；请先完成当前操作。') }
  }
  function persistEditor(value = draft, phaseRequestId = saveRequestId, revision = draftRevision, pending = pendingReadback, open = editing) {
    persistRecovery({ editors: editorCache.current, editor: phaseRequestId ? { draft: value, revision, requestId: phaseRequestId, discovery, discoveryError, mode: editorMode, pendingReadback: pending, open } : undefined })
  }
  useEffect(() => {
    const workspaceId = listing?.workspaceId
    if (!workspaceId) return
    let current = true
    recoveryKey.current = ''; setRecoveryReady(false); setEditing(false); setAccessing(false)
    conversationStates.current = {}; editorCache.current = {}; setConversations({}); setPendingReadback(false); setSaveRequestId(''); setDraft(emptyDraft())
    void rpc.call(CHANNEL, 'auth/current', {}).then(result => {
      if (!current) return
      const username = result.ok ? (result.value as { username?: unknown }).username : undefined
      if (typeof username !== 'string' || !username) { setStorageError('无法确认当前账号，恢复信息尚未读取。请重新读取。'); return }
      const key = `harness-platform:external-drafts:v1:${JSON.stringify([username, workspaceId])}`
      let saved: BrowserRecovery = { conversations: {}, editors: {} }
      try {
        const value = JSON.parse(sessionStorage.getItem(key) ?? 'null')
        if (value) {
          if (!value.conversations || typeof value.conversations !== 'object' || !value.editors || typeof value.editors !== 'object') throw new Error('invalid recovery')
          saved = value
        }
        // 实际结果仍由服务端读取，浏览器仅保留会话与请求引用。
        const restored: Record<string, ConversationDraft> = {}
        for (const [id, value] of Object.entries(saved.conversations)) {
          if (typeof value.input !== 'string' || !['idle', 'sending', 'running', 'waiting', 'completed', 'failed', 'unknown'].includes(value.status)) throw new Error('invalid conversation')
          restored[id] = { ...value, status: value.status === 'sending' ? 'unknown' : value.status, restoreResult: Boolean(value.requestId) && value.status !== 'failed', readRound: 0 }
        }
        conversationStates.current = restored; setConversations(restored); editorCache.current = saved.editors
        if (saved.editor) {
          const value = saved.editor
          setDraft(value.draft); setDraftRevision(value.revision); setSaveRequestId(value.requestId); setEditorMode(value.mode); setDiscovery(value.discovery); setDiscoveryError(value.discoveryError)
          setPendingReadback(value.pendingReadback); setEditing(value.open)
        }
        if (saved.accessId) { accessObject.current = saved.accessId; setAccessId(saved.accessId); setAccessing(Boolean(saved.accessing)) }
        setStorageError('')
      } catch { setStorageError('浏览器恢复信息不可用。内容仅保留在当前页面，刷新后无法恢复。') }
      recoveryKey.current = key; recovery.current = saved; setRecoveryWorkspace(workspaceId); setRecoveryReady(true)
    }, () => { if (current) setStorageError('当前账号读取失败，恢复信息尚未读取。请重新读取。') })
    return () => { current = false }
  }, [rpc, listing?.workspaceId, recoveryRound])
  useEffect(() => { if (canOperate) persistEditor(draft, saveRequestId, draftRevision, pendingReadback || editing && mutation.current && Boolean(busy), editing) }, [canOperate, draft, saveRequestId, draftRevision, pendingReadback, editing, editorMode, discovery, discoveryError, busy])
  useEffect(() => { if (canOperate) persistRecovery({ accessId, accessing }) }, [canOperate, accessId, accessing])
  async function loadIdentity(id: string) {
    const at = ++identityRead.current
    try { const value = await call<IdentityStatus>('status', { instanceId: id }, true); if (at === identityRead.current && selectedId.current === id) { setIdentity(value); setIdentityError('') } }
    catch (error) { if (at === identityRead.current && selectedId.current === id) { setIdentity(null); setIdentityError(message(error)) } }
  }
  async function readDetail(id: string, navigate = false) {
    selectedId.current = id
    const at = ++detailRead.current
    if (detail?.instance.id !== id) { setDetail(null); setIdentity(null); setSecret(null); if (accessObject.current && accessObject.current !== id) setAccessing(false) }
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
  useEffect(() => () => { detailRead.current++; listRead.current++; identityRead.current++; discoveryRead.current++ }, [])
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
  function openEditor(row?: Detail, mode: EditorMode = 'register') {
    if (!canOperate) return
    opener.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement
    if (pendingReadback) { setEditing(true); return }
    const cached = editorCache.current[`${mode}:${row?.instance.id ?? 'new'}`]
    setEditorMode(mode); setDiscovery(null); setDiscoveryError(''); discoveryRead.current++; setDiscovering(false)
    if (cached) { setDraft(cached.draft); setDraftRevision(cached.revision); setSaveRequestId(cached.requestId); setDiscovery(cached.discovery); setDiscoveryError(cached.discoveryError); setDraftError(''); setEditing(true); return }
    setDraft(row ? { instanceId: row.instance.id, agentId: row.agent.id, name: row.agent.name, instanceName: row.instance.name,
      framework: row.instance.framework, endpoint: row.instance.endpoint, selector: row.instance.selector ?? '', credentialRef: row.instance.credentialRef ?? '', connectionUserId: row.instance.connectionUserId ?? '', subjects: (row.policy?.subjects ?? []).join(', '), actions: (row.policy?.actions ?? []).join(', '), policyEnabled: row.policy.enabled } : emptyDraft())
    setDraftRevision(row?.revision ?? listing?.revision ?? ''); setDraftError(''); setSaveRequestId(requestId()); setPendingReadback(false); setLatestDraftBase(null); setEditing(true)
  }
  function updateDraft(patch: Partial<Draft>) { if (!canOperate || pendingReadback || busy) return; const next = { ...draft, ...patch }, id = requestId(); setDraft(next); setSaveRequestId(id); persistEditor(next, id); setDraftError('') }
  function updateConnection(patch: Partial<Draft>) {
    if (pendingReadback || busy || discovering) return
    discoveryRead.current++; setDiscovery(null); setDiscoveryError('')
    updateDraft({ ...patch, selector: '' })
  }
  function closeEditor(remember = true) {
    if (remember) editorCache.current[`${editorMode}:${editorMode === 'register' ? 'new' : draft.instanceId ?? 'new'}`] = { draft, revision: draftRevision, requestId: saveRequestId, discovery, discoveryError }
    else delete editorCache.current[`${editorMode}:${editorMode === 'register' ? 'new' : draft.instanceId ?? 'new'}`]
    persistEditor(draft, saveRequestId, draftRevision, pendingReadback, false)
    discoveryRead.current++; setDiscovering(false); setEditing(false); opener.current?.focus?.(); opener.current = null
  }
  useEffect(() => {
    if (!editing || !['register', 'connection'].includes(editorMode)) return
    let current = true
    void call<{ refs: string[] }>('credentials').then(value => { if (current) { setCredentialRefs(value.refs); setCredentialError('') } }, error => { if (current) setCredentialError(`连接凭据列表读取失败：${message(error)}`) })
    return () => { current = false }
  }, [editing, editorMode])
  async function discover() {
    if (discovering || pendingReadback || busy) return
    if (!draft.endpoint.trim()) { setDraftError('请填写服务地址。'); editDialog.current?.querySelector<HTMLElement>('[aria-label="接入服务地址"]')?.focus(); return }
    const at = ++discoveryRead.current
    setDiscovering(true); setDiscoveryError(''); setDraftError('')
    try {
      const value = await call<Discovery>('discover', { ...(draft.instanceId ? { id: draft.instanceId } : {}), framework: draft.framework, endpoint: draft.endpoint, credentialRef: draft.credentialRef || undefined, connectionUserId: draft.connectionUserId || undefined })
      if (at !== discoveryRead.current) return
      setDiscovery(value)
      updateDraft({ selector: value.selector ?? '', ...(value.connectionUserId ? { connectionUserId: value.connectionUserId } : {}) })
    } catch (error) { if (at === discoveryRead.current) setDiscoveryError(message(error)) }
    finally { if (at === discoveryRead.current) setDiscovering(false) }
  }
  function selectTarget(value: string, kind: 'agent' | 'workspace' | 'preset') {
    updateDraft({ selector: kind === 'agent' ? value : JSON.stringify({ ...dshTarget(draft.selector), [kind === 'workspace' ? 'workspaceId' : 'agentPreset']: value }) })
  }
  const discoveredName = draft.framework === 'agentscope' ? discovery?.agents?.items.find(item => item.id === draft.selector)?.name
    : draft.framework === 'dsh' ? discovery?.presets?.items.find(item => item.id === dshTarget(draft.selector).agentPreset)?.name : undefined
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
      if (result.found && value?.instance) { setDetail(value); selectedId.current = value.instance.id; setDraftRevision(value.revision); setPendingReadback(false); setNotice(`已从服务端核对登记与当前入口状态（${labels[entryState(value.instance, value.policy)] ?? '未知'}）；没有重复提交或继续执行后续操作。`); closeEditor(false); setDraft(emptyDraft()); setSaveRequestId(''); persistRecovery({ editor: undefined, editors: editorCache.current }); await refresh() }
      else setDraftError('尚未确认此请求已保存。请保留草稿并稍后再次核对，不会自动重复登记。')
    } catch (error) { setDraftError(`保存结果仍待核对：${message(error)}`) }
    finally { setBusy('') }
  }
  async function save(enable: boolean) {
    if (!canOperate || mutation.current || pendingReadback) return
    const missing = editorMode === 'metadata' && !draft.instanceName.trim() ? ['请填写实例名称。', '接入实例名称']
      : enable && !draft.endpoint.trim() ? ['请填写服务地址。', '接入服务地址']
      : enable && draft.framework === 'agentscope' && !draft.selector.trim() ? ['请先查找并选择一个远端智能体。', '发现远端智能体']
      : enable && draft.framework === 'dsh' && !dshTarget(draft.selector).workspaceId.trim() ? ['请先查找并选择工作区。', '发现远端智能体']
      : enable && draft.framework === 'dsh' && !dshTarget(draft.selector).agentPreset.trim() ? ['请选择工作区中的智能体。', '接入智能体选择']
      : editorMode === 'authorization' && !split(draft.subjects).length ? ['请保留至少一个允许访问的主体。', '接入允许主体']
      : editorMode === 'authorization' && !split(draft.actions).includes('agent:access') ? ['请保留“访问实例”操作。', '入口操作-访问实例'] : null
    if (missing) { setDraftError(missing[0]); const field = editDialog.current?.querySelector<HTMLElement>(`[aria-label="${missing[1]}"]`); field?.closest('details')?.setAttribute('open', ''); field?.focus(); return }
    mutation.current = true; setBusy('保存登记'); setDraftError('')
    try {
      const savingRequestId = saveRequestId || requestId()
      setSaveRequestId(savingRequestId)
      persistEditor(draft, savingRequestId, draftRevision, true, true)
      const connection = { framework: draft.framework, endpoint: draft.endpoint, selector: draft.selector, credentialRef: draft.credentialRef, connectionUserId: draft.connectionUserId }
      const saved = await call<Detail>('save', { revision: draftRevision, requestId: savingRequestId,
        agent: draft.agentId ? { id: draft.agentId } : { ...(draft.name.trim() || discoveredName ? { name: draft.name.trim() || discoveredName } : {}) },
        instance: { ...(draft.instanceId ? { id: draft.instanceId } : {}), ...(connectionEditor ? connection : {}), ...(editorMode === 'metadata' ? { name: draft.instanceName } : {}) },
        ...(editorMode === 'authorization' ? { policy: { subjects: split(draft.subjects), actions: split(draft.actions), enabled: draft.policyEnabled } } : {}) })
      if (!saved.instance?.id) throw new Error('服务端未返回登记对象，保存结果需要核对')
      setDetail(saved); selectedId.current = saved.instance.id; setDraftRevision(saved.revision)
      setListing(current => current ? { ...current, revision: saved.revision, agents: [...current.agents.filter(agent => agent.id !== saved.agent.id), saved.agent], instances: [...current.instances.filter(instance => instance.id !== saved.instance.id), saved.instance] } : current)
      const savedDraft = { ...draft, instanceId: saved.instance.id, agentId: saved.agent.id, name: saved.agent.name,
        instanceName: saved.instance.name, endpoint: saved.instance.endpoint, selector: saved.instance.selector ?? '', credentialRef: saved.instance.credentialRef ?? '', connectionUserId: saved.instance.connectionUserId ?? '',
        subjects: saved.policy.subjects.join(', '), actions: saved.policy.actions.join(', '), policyEnabled: saved.policy.enabled }
      setDraft(savedDraft)
      setPendingReadback(false)
      if (enable) {
        setBusy('验证接入')
        const verificationRequestId = requestId(); setSaveRequestId(verificationRequestId)
        persistEditor(savedDraft, verificationRequestId, saved.revision, true, true)
        const verified = await call<Detail>('verify', { id: saved.instance.id, revision: saved.revision, requestId: verificationRequestId })
        setDetail(verified); setDraftRevision(verified.revision)
        setBusy('启用入口')
        const enableRequestId = requestId(); setSaveRequestId(enableRequestId)
        persistEditor(savedDraft, enableRequestId, verified.revision, true, true)
        const enabled = await call<Detail>('enable', { id: saved.instance.id, revision: verified.revision, requestId: enableRequestId })
        setDetail(enabled); setNotice('已验证并启用核定入口。资源授权与原生运行状态请分别查看。')
      } else setNotice(`登记已保存。当前入口：${labels[entryState(saved.instance, saved.policy)] ?? '未知'}。`)
      delete editorCache.current[`${editorMode}:new`]; closeEditor(false); setDraft(emptyDraft()); setSaveRequestId(''); persistRecovery({ editor: undefined, editors: editorCache.current }); await refresh()
    } catch (error) {
      const text = message(error)
      if (!(error as { responseReceived?: boolean })?.responseReceived) { setPendingReadback(true); setDraftError(`保存、验证或启用结果待核对：${text}。请先查询结果，不要重复提交。`) }
      else { setSaveRequestId(requestId()); setDraftError(`${text}。已填写的非秘密内容保留；如登记已保存，可从详情继续验证。`) }
    } finally { mutation.current = false; setBusy('') }
  }
  async function mutate(operation: 'verify' | 'enable' | 'disable' | 'remove') {
    if (!canOperate || !detail || mutation.current) return
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
    if (!canOperate || !selected || mutation.current) return
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
  function updateConversation(id: string, patch: Partial<ConversationDraft>) {
    const value = { ...(conversationStates.current[id] ?? emptyConversation()), ...patch }
    conversationStates.current = { ...conversationStates.current, [id]: value }
    setConversations(conversationStates.current)
    const saved = Object.fromEntries(Object.entries(conversationStates.current).map(([id, item]) => [id, { input: item.input, sessionId: item.sessionId, requestId: item.requestId, status: item.status }]))
    persistRecovery({ conversations: saved })
  }
  function openAccess(id: string) { if (!canOperate) return; accessObject.current = id; setAccessId(id); const current = conversationStates.current[id]; if (current && conversationPending(current)) updateConversation(id, { paused: false, readRound: current.readRound + 1 }); setAccessing(true) }
  function acceptConversation(id: string, sentRequestId: string, result: ConversationResult) {
    const current = conversationStates.current[id]
    if (current?.requestId !== sentRequestId) return
    if (result.requestId !== sentRequestId || current.sessionId && result.sessionId && current.sessionId !== result.sessionId) {
      updateConversation(id, { status: current.restoreResult && ['completed', 'failed'].includes(current.status) ? current.status : 'unknown', error: '返回结果与当前请求不一致，请继续读取。', paused: true }); return
    }
    updateConversation(id, { result, status: result.status, restoreResult: false, sessionId: result.sessionId ?? current.sessionId, error: '', ...(result.status === 'completed' && !['completed', 'failed'].includes(current.status) ? { input: '' } : {}) })
  }
  async function sendConversation() {
    const id = accessObject.current
    const current = conversationStates.current[id] ?? emptyConversation()
    if (!canOperate || !id || !current.input.trim() || conversationPending(current)) return
    if (current.input.length > 32000) { updateConversation(id, { error: '消息不能超过 32000 个字符，请缩短后发送。' }); return }
    const sentRequestId = requestId()
    updateConversation(id, { requestId: sentRequestId, status: 'sending', result: undefined, error: '', paused: false })
    try {
      const result = await call<ConversationResult>('conversation/send', { id, requestId: sentRequestId, sessionId: current.sessionId, input: current.input }, false, AbortSignal.timeout(30000))
      acceptConversation(id, sentRequestId, result)
    } catch (error) {
      if (conversationStates.current[id]?.requestId === sentRequestId) updateConversation(id, { status: 'unknown', error: `发送结果待确认：${message(error)}。正在读取原请求，不会重新发送。` })
    }
  }
  const conversation = conversations[accessId] ?? emptyConversation()
  useEffect(() => {
    if (!canOperate || !active || !accessing || !accessId || !conversation.requestId || conversation.status === 'sending') return
    const id = accessId, sentRequestId = conversation.requestId
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined
    const started = Date.now()
    async function poll() {
      const current = conversationStates.current[id]
      if (stopped || !current || current.requestId !== sentRequestId || !conversationPending(current) || current.paused) return
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 20000)
      try {
        const value = await call<ConversationResult>('conversation/status', { id, requestId: sentRequestId }, false, controller.signal)
        if (stopped) return
        acceptConversation(id, sentRequestId, value)
      } catch (error) {
        const current = conversationStates.current[id]
        if (!stopped && current?.requestId === sentRequestId) updateConversation(id, { status: current.restoreResult && ['completed', 'failed'].includes(current.status) ? current.status : 'unknown', error: `结果读取中断：${message(error)}。原请求已保留。`, paused: true })
      } finally { clearTimeout(timeout) }
      if (stopped || !conversationPending(conversationStates.current[id]) || conversationStates.current[id]?.paused) return
      if (Date.now() - started >= 90000) { updateConversation(id, { paused: true, error: '暂未取得最终结果。可以继续读取，原请求不会重新发送。' }); return }
      timer = setTimeout(() => void poll(), Math.min(5000, Math.max(500, conversationStates.current[id]?.result?.retryAfterMs ?? 1000)))
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer); controller?.abort() }
  }, [canOperate, active, accessing, accessId, conversation.requestId, conversation.status === 'sending', conversation.readRound])
  const accessInstance = listing?.instances.find(item => item.id === accessId) ?? (selected?.id === accessId ? selected : undefined)
  const connectionEditor = editorMode === 'register' || editorMode === 'connection'
  function TargetChoices({ choices, label, kind, value }: { choices?: Choices; label: string; kind: 'agent' | 'workspace' | 'preset'; value: string }) {
    if (!choices) return null
    if (choices.status !== 'ready') return <p role="status" className="external-note external-wide">{label}：{{ empty: '没有可用对象', unauthorized: '需要有效的原系统认证', forbidden: '当前账号无权查看', unsupported: '原系统暂不支持查询', failed: '查询失败' }[choices.status]}。{choices.message}</p>
    return <label className="external-wide"><span>{label}<Required /></span><select aria-label={kind === 'workspace' ? '接入工作区选择' : '接入智能体选择'} aria-required="true" required value={value} onChange={event => selectTarget(event.target.value, kind)}><option value="">请选择</option>{choices.items.map(item => <option key={item.id} value={item.id} disabled={Boolean(item.unavailableReason)}>{item.name}{item.unavailableReason ? `（${item.unavailableReason}）` : ''}</option>)}</select></label>
  }
  return <section className="external-instances" aria-label="接入实例" hidden={!active}>
    <style>{externalInstanceTheme}</style>
    {storageError && <p role="alert" className="instance-error">{storageError}{!canOperate && <button type="button" onClick={() => setRecoveryRound(value => value + 1)}>重新读取恢复信息</button>}</p>}
    {listing && !canOperate && !storageError && <LoadingIndicator label="读取当前账号的恢复信息" />}
    <div className="external-toolbar">
      <label>搜索<input aria-label="搜索接入实例" placeholder="实例、智能体、系统或责任主体" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <label>框架<select aria-label="接入框架筛选" value={framework} onChange={event => setFramework(event.target.value)}><option value="">全部框架</option>{Object.entries(frameworks).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <label>入口<select aria-label="接入入口状态筛选" value={stateFilter} onChange={event => setStateFilter(event.target.value)}><option value="">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="pending">待验证</option><option value="draft">草稿</option></select></label>
      <div className="external-toolbar-actions"><button type="button" disabled={loading} onClick={() => void refreshChanged()}>刷新接入登记{loading && <LoadingIndicator label="读取接入登记" />}</button><button type="button" className="harness-primary" disabled={Boolean(busy) || !canOperate} onClick={() => openEditor()}>登记已有智能体</button></div>
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
      <div className="external-row-actions"><button type="button" onClick={() => { setTab('overview'); void readDetail(item.id, true) }}>查看接入详情</button><button type="button" disabled={Boolean(busy)} onClick={() => { setTab('overview'); void readDetail(item.id, true); openAccess(item.id) }}>访问</button></div>
    </article> })}</div>
    {selected && detail && <section className="external-detail" aria-label={`${selected.name}接入详情`}>
      <header className="external-detail-heading"><div><h2>{selected.name}</h2><p className="external-row-meta">{detail.agent.name} · {detail.agent.system} · {detail.agent.owner}</p></div><div className="external-row-actions"><button type="button" disabled={Boolean(busy)} onClick={() => openEditor(detail, 'metadata')}>编辑实例名称</button><button type="button" onClick={() => { selectedId.current = ''; detailRead.current++; identityRead.current++; setDetail(null); setIdentity(null); setSecret(null); onNavigate?.({ page: 'instances', tab: 'external' }) }}>返回接入列表</button></div></header>
      <div role="tablist" aria-label="接入实例详情" className="instance-detail-tabs">{tabs.map(item => <button key={item.id} type="button" role="tab" className="instance-detail-tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id); onNavigate?.({ page: 'instances', instance_name: selected.id, tab: `external-${item.id}` }) }}>{item.label}</button>)}</div>
      <div className="external-detail-body" role="tabpanel" aria-label={tabs.find(item => item.id === tab)?.label}>
        {tab === 'overview' && <><Facts rows={[[ '所属系统', detail.agent.system ], ['责任主体', detail.agent.owner], ['框架', frameworks[selected.framework]], ['生命周期责任', '原系统 / 原责任方'], ['实例运维责任', selected.instanceOwner || detail.agent.owner], ['运行位置', selected.location || '未记录'], ['平台入口', <Badge state={entryState(selected, detail.policy)} />], ['原生运行', '未知；不从入口状态推定'], ['使用方式', '核定使用组共享；未声明逐用户数据隔离'], ['最近验证', stamp(selected.verification?.observedAt)]]} />
          <p className="external-note">当前可控范围以“接入与能力”的真实验证为准。停用入口不会停止远端进程；资源授权和任务取消分别处理。</p><div className="external-actions"><button type="button" className="harness-primary" disabled={Boolean(busy)} onClick={() => openAccess(selected.id)}>访问此实例</button><button type="button" disabled={Boolean(busy)} onClick={() => void mutate('verify')}>重新验证接入</button><button type="button" disabled={Boolean(busy)} onClick={() => void mutate('enable')}>启用已验证入口</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirm('disable')}>停用入口</button><button type="button" disabled={Boolean(busy)} onClick={() => setConfirm('remove')}>移除登记</button></div></>}
        {tab === 'connection' && <><Facts rows={[[ '目标入口', selected.endpoint || '未填写' ], ['原系统账号', selected.connectionUserId || '沿用原连接配置'], ['声明版本', selected.declaredVersion || '未知'], ['观测版本', selected.verification?.observedVersion || '未知'], ['凭据引用', selected.credentialRef || '未配置'], ['接入验证', <Badge state={selected.verification ? selected.verification.ok ? 'verified' : 'failed' : 'unverified'} />]]} />
          <div className="external-actions"><button type="button" disabled={Boolean(busy)} onClick={() => openEditor(detail, 'connection')}>修改连接</button></div>
          <ul className="external-capabilities">{selected.verification?.checks.map((check, index) => <li key={`${check.name}-${index}`}><Badge state={check.ok ? 'verified' : 'failed'} /><span>{check.detail}</span></li>)}</ul><details><summary>查看能力与验证明细</summary><pre className="external-output">{JSON.stringify(selected.verification ?? { status: 'unverified', note: '尚无本次登记的验证记录' }, null, 2)}</pre></details>
          <h3>实例身份</h3>{identityError && <p role="alert" className="instance-error">{identityError}</p>}{identity ? <><p className="external-note">此处展示凭据持有证据与有效期，不代表代码完整或任务安全。普通详情不显示秘密。</p><div className="external-table-scroll"><table className="external-table"><thead><tr><th>客户端 / 凭据编号</th><th>状态 / 到期</th><th>操作</th></tr></thead><tbody>{identity.credentials.map(item => <tr key={item.id}><td>{item.clientId}<br/><span className="external-row-meta">{item.id}</span></td><td><Badge state={item.effectiveStatus ?? item.status} /><br/>{stamp(item.expiresAt)}</td><td><button type="button" disabled={Boolean(busy) || item.status === 'revoked'} onClick={() => void identityAction('revokeCredential', { credentialId: item.id })}>撤销此凭据</button></td></tr>)}</tbody></table></div>{!identity.credentials.length && <p>尚未配置实例访问 key。独立通过的入口不依赖签名能力启用。</p>}</> : !identityError && <LoadingIndicator label="读取实例身份" />}
          <div className="external-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void loadIdentity(selected.id)}>重新读取身份</button><button type="button" disabled={Boolean(busy)} onClick={() => void identityAction('createCredential')}>创建实例凭据</button><button type="button" disabled={Boolean(busy) || !identity?.credentials.length} onClick={() => void identityAction('rotateCredential')}>轮换实例凭据</button></div></>}
        {tab === 'authorization' && <><h3>谁能访问实例</h3><Facts rows={[[ '授权主体', detail.policy?.subjects.join('、') || '尚未授予' ], ['开放操作', detail.policy?.actions.join('、') || '尚未授予'], ['入口状态', <Badge state={entryState(selected, detail.policy)} />], ['使用边界', '实例服务账户与核定人群使用相同资源范围；无用户委托声明']]} /><div className="external-actions"><button type="button" disabled={Boolean(busy)} onClick={() => openEditor(detail, 'authorization')}>编辑入口授权</button></div>
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
      <header className="instance-dialog-heading external-dialog-heading"><h2 id="external-edit-title">{{ register: '登记已有智能体', connection: '修改连接', metadata: '编辑实例名称', authorization: '编辑入口授权' }[editorMode]}</h2><button type="button" disabled={Boolean(busy)} aria-label="关闭接入登记并保留草稿" onClick={() => closeEditor()}>×</button></header>
      <div className="instance-dialog-content">
        {connectionEditor && <p className="external-note external-form-intro">填写服务地址，查找要接入的智能体。* 为完成接入必填。</p>}
        {draftError && <div role="alert" className="instance-error"><p>{draftError}</p>{!pendingReadback && <button type="button" disabled={Boolean(busy)} onClick={() => void readLatestDraftBase()}>保留草稿并读取最新版本</button>}</div>}
        {latestDraftBase && <details open><summary>服务端当前登记 · 请与草稿核对</summary><Facts rows={[['实例名称', latestDraftBase.instance.name], ['服务地址', latestDraftBase.instance.endpoint || '未填写'], ['允许主体', latestDraftBase.policy.subjects.join('、')], ['开放操作', latestDraftBase.policy.actions.join('、')]]} /></details>}
        <fieldset className="external-form external-form-fields" disabled={Boolean(busy) || pendingReadback || discovering}>
          {connectionEditor && <>
            <label><span>框架<Required /></span><select aria-label="接入实例框架" required aria-required="true" value={draft.framework} onChange={event => updateConnection({ framework: event.target.value as Framework, connectionUserId: '' })}>{Object.entries(frameworks).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
            <label className="external-wide"><span>服务地址<Required /></span><input aria-label="接入服务地址" required aria-required="true" value={draft.endpoint} onChange={event => updateConnection({ endpoint: event.target.value })} placeholder="http(s)://已有实例的服务地址" /></label>
            <details className="external-wide external-connection-settings"><summary>连接设置</summary><div className="external-form">
              {credentialError && <p role="alert" className="external-note external-wide">{credentialError}</p>}
              <label className="external-wide"><span>连接凭据（按原系统要求选择）</span><select aria-label="接入连接凭据" value={draft.credentialRef} onChange={event => updateConnection({ credentialRef: event.target.value })}><option value="">无需凭据 / 暂不配置</option>{[...new Set([...credentialRefs, ...(draft.credentialRef ? [draft.credentialRef] : [])])].map(ref => <option value={ref} key={ref}>{ref}</option>)}</select></label>
              {!credentialError && !credentialRefs.length && <p className="external-row-meta external-wide">需要认证时，请管理员先配置连接凭据。</p>}
              {draft.framework === 'agentscope' && <label className="external-wide"><span>原系统账号</span><input aria-label="接入原系统账号" value={draft.connectionUserId} onChange={event => updateConnection({ connectionUserId: event.target.value })} placeholder="凭据已包含账号时可留空" /><span className="external-row-meta">使用远端已有账号；不清楚时请联系原系统管理员。</span></label>}
              {draft.framework === 'opencode' && <label className="external-wide"><span>工作目录（选填）</span><input aria-label="接入工作目录" value={draft.selector} onChange={event => updateDraft({ selector: event.target.value })} placeholder="沿用原实例默认目录" /></label>}
            </div></details>
            <div className="external-actions external-wide"><button type="button" aria-label="发现远端智能体" disabled={!draft.endpoint.trim()} onClick={() => void discover()}>查找智能体</button></div>
            {discoveryError && <p role="alert" className="instance-error external-wide">查找失败：{discoveryError}</p>}
            {!discovery && editorMode === 'connection' && draft.selector && <p className="external-note external-wide">当前接入：{draft.name}。查找可重新选择。</p>}
            {discovery && <>
              {discovery.framework === 'agentscope' && TargetChoices({ choices: discovery.agents, label: '智能体', kind: 'agent', value: draft.selector })}
              {discovery.framework === 'dsh' && <>{TargetChoices({ choices: discovery.workspaces, label: '工作区', kind: 'workspace', value: dshTarget(draft.selector).workspaceId })}{TargetChoices({ choices: discovery.presets, label: '智能体', kind: 'preset', value: dshTarget(draft.selector).agentPreset })}</>}
              {discovery.framework === 'opencode' && <p role="status" className="external-note external-wide">{discovery.status === 'selected' ? '已找到 OpenCode 服务。' : discovery.message || '尚未识别此服务，请核对地址与连接设置。'}</p>}
              <p className="external-row-meta external-wide">查询时间：{stamp(discovery.observedAt)}</p>
            </>}
            {(discoveryError || discovery?.status === 'unavailable') && draft.framework !== 'opencode' && <details className="external-wide external-connection-settings"><summary>使用管理员提供的目标</summary><div className="external-form">
              {draft.framework === 'agentscope' ? <label className="external-wide"><span>Agent ID<Required /></span><input aria-label="接入目标选择器" aria-required="true" value={draft.selector} onChange={event => updateDraft({ selector: event.target.value })} /></label> : <><label><span>工作区 ID<Required /></span><input aria-label="接入工作区ID" aria-required="true" value={dshTarget(draft.selector).workspaceId} onChange={event => updateDraft({ selector: JSON.stringify({ ...dshTarget(draft.selector), workspaceId: event.target.value }) })} /></label><label><span>Agent Preset<Required /></span><input aria-label="接入AgentPreset" aria-required="true" value={dshTarget(draft.selector).agentPreset} onChange={event => updateDraft({ selector: JSON.stringify({ ...dshTarget(draft.selector), agentPreset: event.target.value }) })} /></label></>}
            </div></details>}
            {editorMode === 'register' && <label className="external-wide"><span>显示名称（选填）</span><input aria-label="接入智能体名称" value={draft.name} readOnly={Boolean(draft.agentId)} onChange={event => updateDraft({ name: event.target.value })} placeholder={discoveredName || '沿用远端智能体名称'} /></label>}
          </>}
          {editorMode === 'metadata' && <label className="external-wide"><span>实例名称<Required /></span><input aria-label="接入实例名称" required aria-required="true" value={draft.instanceName} onChange={event => updateDraft({ instanceName: event.target.value })} /></label>}
          {editorMode === 'authorization' && <>
            <label className="external-wide"><span>允许访问主体<Required /></span><input aria-label="接入允许主体" required aria-required="true" value={draft.subjects} onChange={event => updateDraft({ subjects: event.target.value })} placeholder="以逗号分隔主体 ID" /><span className="external-row-meta">platform-owner 代表平台管理者；其他账号请填写已知主体 ID。</span></label>
            <div role="group" aria-label="开放操作" className="external-policy-actions external-wide"><span>开放操作<Required /></span>{entryActions.map(action => <label key={action.id}><input type="checkbox" aria-label={`入口操作-${action.name}`} checked={split(draft.actions).includes(action.id)} onChange={event => updateDraft({ actions: (event.target.checked ? [...split(draft.actions), action.id] : split(draft.actions).filter(value => value !== action.id)).join(', ') })} />{action.name}</label>)}</div>
          </>}
        </fieldset>
        {discovering && <LoadingIndicator label="查找远端智能体" block />}
      </div><footer className="instance-dialog-actions"><button type="button" disabled={Boolean(busy)} onClick={() => closeEditor()}>关闭并保留草稿</button>{pendingReadback ? <button type="button" className="harness-primary" disabled={Boolean(busy)} onClick={() => void readSaveResult()}>核对保存结果</button> : connectionEditor ? <><button type="button" disabled={Boolean(busy) || discovering} onClick={() => void save(false)}>保存草稿</button><button type="button" className="harness-primary" disabled={Boolean(busy) || discovering} onClick={() => void save(true)}>验证并接入</button></> : <button type="button" className="harness-primary" disabled={Boolean(busy)} onClick={() => void save(false)}>保存修改</button>}{busy && <LoadingIndicator label={busy} />}</footer>
    </dialog>
    <dialog ref={confirmDialog} className="instance-dialog external-dialog" aria-labelledby="external-confirm-title" onCancel={event => { event.preventDefault(); setConfirm(null) }}><header className="instance-dialog-heading"><h2 id="external-confirm-title">{confirm === 'remove' ? '移除登记' : confirm === 'disable' ? '停用入口' : '禁用 Harness 签名资源访问'}</h2></header><div className="instance-dialog-content"><p>对象：{selected?.name ?? '请重新选择实例'}</p><p>{confirm === 'remove' ? '撤销平台登记与访问入口，保留远端服务、进程和数据。' : confirm === 'disable' ? '拒绝新的入口访问并处理受影响连接。不会停止远端进程，也不自动撤销资源授予。' : '撤销此实例对应的 Harness 签名资源授予。其他非签名服务按原方式继续访问。'}</p></div><footer className="instance-dialog-actions"><button type="button" onClick={() => setConfirm(null)}>取消</button><button type="button" className="instance-danger-button" disabled={Boolean(busy) || !selected} onClick={() => confirm && void (confirm === 'disableResourceAccess' ? identityAction(confirm) : mutate(confirm))}>确认{confirm === 'remove' ? '移除登记' : confirm === 'disable' ? '停用入口' : '禁用签名资源访问'}</button></footer></dialog>
    <dialog ref={secretDialog} className="instance-dialog external-dialog" aria-labelledby="external-secret-title" onCancel={event => { event.preventDefault(); setSecret(null) }}><header className="instance-dialog-heading"><h2 id="external-secret-title">交付实例凭据</h2></header><div className="instance-dialog-content">{secret && <><p>仅此创建流程展示一次。将凭据交给对应可信 connector；不要放入模型消息、工具参数或普通日志。</p><Facts rows={[[ 'client ID', secret.credential.clientId ], ['凭据编号', secret.credential.id], ['有效至', stamp(secret.credential.expiresAt)]]} /><label>实例 secret<textarea aria-label="仅本次交付的实例secret" className="external-secret" readOnly value={secret.secret} /></label></>}</div><footer className="instance-dialog-actions"><button type="button" className="harness-primary" onClick={() => setSecret(null)}>已交付，关闭秘密</button></footer></dialog>
    <dialog ref={accessDialog} className="instance-dialog external-dialog" aria-labelledby="external-access-title" onCancel={event => { event.preventDefault(); setAccessing(false) }}>
      <header className="instance-dialog-heading external-dialog-heading"><h2 id="external-access-title">{accessInstance?.name ?? '访问智能体'}</h2><button type="button" aria-label="关闭实例访问并保留会话" onClick={() => setAccessing(false)}>×</button></header>
      <div className="instance-dialog-content">
        <div className="external-access-form"><label><span>发消息</span><textarea aria-label="接入实例访问输入" maxLength={32000} placeholder="输入要交给智能体的任务" value={conversation.input} disabled={conversationPending(conversation)} onChange={event => { if (!conversationPending(conversation)) updateConversation(accessId, { input: event.target.value }) }} /></label><div className="external-actions"><button type="button" className="harness-primary" disabled={!accessInstance || !conversation.input.trim() || conversationPending(conversation)} onClick={() => void sendConversation()}>发送</button></div></div>
        {(conversation.status !== 'idle' || conversation.error) && <div className="external-conversation-result" aria-label="本次智能体结果" aria-live="polite">
          <p role="status">{conversation.restoreResult ? '正在读取上次结果…' : { idle: '尚未发送', sending: '正在发送…', running: '智能体正在处理…', waiting: '等待原系统处理…', completed: '本次处理完成', failed: '本次处理未完成', unknown: '正在确认本次结果…' }[conversation.status]}</p>
          {conversation.error && <p role="alert" className="instance-error">{conversation.error}</p>}
          {conversation.result?.messages.filter(item => item.role === 'assistant' && item.text.trim()).map(item => <div className="external-assistant-message" key={item.id}>{item.text}</div>)}
          {conversation.status === 'completed' && !conversation.result?.messages.some(item => item.role === 'assistant' && item.text.trim()) && <p className="external-note">原系统已完成，未返回文字答复。</p>}
          {conversation.result?.note && <p className="external-note">{conversation.result.note}</p>}
          {conversation.paused && conversationPending(conversation) && <button type="button" onClick={() => updateConversation(accessId, { paused: false, error: '', readRound: conversation.readRound + 1 })}>继续读取结果</button>}
        </div>}
        {(conversation.requestId || conversation.sessionId) && <details className="external-conversation-details"><summary>详细信息</summary><Facts rows={[[ '会话标识', conversation.sessionId ?? '等待原系统返回' ], ['本次请求', conversation.requestId]]} />{conversation.result?.tools.length ? <ul>{conversation.result.tools.map(tool => <li key={tool.id}>{tool.name} · {{ running: '执行中', completed: '完成', failed: '失败' }[tool.status]}</li>)}</ul> : null}<pre className="external-output">{JSON.stringify(conversation.result ?? { status: conversation.status }, null, 2)}</pre></details>}
      </div><footer className="instance-dialog-actions"><button type="button" onClick={() => setAccessing(false)}>关闭并保留会话</button></footer>
    </dialog>
  </section>
}
