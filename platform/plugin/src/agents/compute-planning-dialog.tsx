import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'

export type ComputePlanningRequest = {
  requestId: string
  type: 'medium' | 'low'
  variantName: string
  goal: string
  advanced: string
  sourceRunIds: string[]
  tracePlanRequested: boolean
  medium?: {
    baseModelMode: 'catalog' | 'custom' | 'suggest'
    baseModelId: string
    revision: string
    serverMode: 'registered' | 'new' | 'later'
    serverId: string
    host: string
    port: number
    user: string
    workDir: string
    auth: 'ssh_key' | 'password'
    credentialRef: string
  }
  low?: {
    uncovered: 'stop_and_report' | 'request_human'
    requirements: string
  }
}

type PlanningType = ComputePlanningRequest['type']
type Draft = {
  step: 1 | 2
  type: PlanningType | null
  variantName: string
  goal: string
  advanced: string
  sourceRunIds: string[]
  tracePlanRequested: boolean
  medium: {
    baseModelMode: NonNullable<ComputePlanningRequest['medium']>['baseModelMode']
    baseModelId: string
    revision: string
    serverMode: NonNullable<ComputePlanningRequest['medium']>['serverMode']
    serverId: string
    serverName: string
    host: string
    port: string
    user: string
    workDir: string
    auth: NonNullable<ComputePlanningRequest['medium']>['auth']
    credentialRef: string
  }
  low: NonNullable<ComputePlanningRequest['low']>
}
type Errors = Record<string, string>
type SendStatus = 'idle' | 'sending' | 'failure' | 'unknown'
type CatalogChoice = { id: string; name: string; provider: string; model: string }
type ModelList = { catalog: { groups: Array<{ id: string; name?: string; models: Array<{ id: string; name?: string }> }> }; business_allowed: Array<{ provider: string; model: string }> }
type CatalogState = { phase: 'idle' | 'loading' | 'ready' | 'error'; agentId: string; choices: CatalogChoice[]; message: string }
type TrainingServer = { id: string; name: string; host: string; port: number; user: string; workDir: string; auth: 'ssh_key' | 'password'; credentialRef: string }
type ServerList = { revision: string; servers: TrainingServer[] }
type ServerState = { phase: 'idle' | 'loading' | 'ready' | 'error'; list: ServerList | null; message: string }
type ServerSaveStatus = 'idle' | 'saving' | 'error' | 'unknown' | 'success'
type ConnectionCheck = { signature: string; status: 'probing' | 'ssh_reachable' | 'port_reachable_unverified' | 'unreachable' | 'unknown' | 'incomplete'; message: string; checkedAt?: string } | null
type Run = { run_id: string; experiment_id: string; status: string; created_at: string; title?: string; effective_verdict?: 'passed' | 'failed' | 'inconclusive' | null }

const mediumRoute = [
  ['提炼决策样本', '从真实运行轨迹提取决策输入、动作与结果'],
  ['训练决策模型', '选择基模型，在已配置服务器上训练'],
  ['组装 LangGraph', '决策模型 + 状态流程 + 真实工具'],
  ['独立比较验证', '比较效果、覆盖、延迟与资源开销'],
]
const lowRoute = [
  ['提炼规则与分支', '从轨迹归纳决策规则和数据处理逻辑'],
  ['编写 LangGraph 代码', '用明确的规则与流程实现决策'],
  ['复用真实工具', '调用原有工具，不以假返回值替代'],
  ['独立比较验证', '识别未覆盖场景，验证效果与资源开销'],
]
const typeLabel = (type: PlanningType | null) => type === 'medium' ? '中算力' : type === 'low' ? '低算力' : '尚未选择'
const runPresentation = (run: Run) => {
  if (run.status === 'completed') {
    if (run.effective_verdict === 'passed') return { label: '成功', tone: 'passed' }
    if (run.effective_verdict === 'failed') return { label: '未通过', tone: 'failed' }
    if (run.effective_verdict === 'inconclusive') return { label: '无法判定', tone: 'inconclusive' }
    return { label: '结果待核对', tone: 'unknown' }
  }
  return ({ failed: { label: '异常', tone: 'failed' }, cancelled: { label: '已取消', tone: 'unknown' }, running: { label: '运行中', tone: 'running' } } as const)[run.status as 'failed' | 'cancelled' | 'running'] ?? { label: '状态待核对', tone: 'unknown' }
}
const runTitle = (run: Run) => run.title?.trim() || `运行记录 · ${run.run_id.slice(-8)}`
const runTime = (value: string) => {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString('zh-CN') : '时间待核对'
}

export function catalogChoices(value: ModelList): CatalogChoice[] {
  if (!value || !value.catalog || !Array.isArray(value.catalog.groups) || !Array.isArray(value.business_allowed)) throw new Error('模型目录响应格式不正确')
  const allowed = new Set(value.business_allowed.filter(item => typeof item.provider === 'string' && typeof item.model === 'string')
    .map(item => JSON.stringify([item.provider, item.model])))
  return value.catalog.groups.flatMap(group => group.models.filter(model => allowed.has(JSON.stringify([group.id, model.id])))
    .map(model => ({ id: JSON.stringify([group.id, model.id]), name: `${group.name || group.id} · ${model.name || model.id}`, provider: group.id, model: model.id })))
}

function serverList(value: unknown): ServerList {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('训练服务器列表响应格式不正确')
  const list = value as Partial<ServerList>
  if (typeof list.revision !== 'string' || !Array.isArray(list.servers)) throw new Error('训练服务器列表响应格式不正确')
  return { revision: list.revision, servers: list.servers }
}

function newServerErrors(medium: Draft['medium']): Errors {
  const errors: Errors = {}
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(medium.host.trim()) || medium.host.trim().length > 255) errors.host = '请填写有效主机名或 IP，不含协议与空格。'
  if (!/^\d+$/.test(medium.port) || Number(medium.port) < 1 || Number(medium.port) > 65535) errors.port = '端口范围为 1–65535。'
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(medium.user.trim())) errors.user = '请填写有效 SSH 用户名。'
  if (!medium.workDir.trim().startsWith('/') || /[\x00-\x1f\x7f]/.test(medium.workDir)) errors.workDir = '请填写以 / 开头的绝对工作目录。'
  if (medium.credentialRef && !/^ref:[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(medium.credentialRef.trim())) errors.credentialRef = '只填写 ref: 开头的凭据引用，不要粘贴密码或私钥。'
  return errors
}
const initialDraft = (): Draft => ({
  step: 1,
  type: null,
  variantName: '',
  goal: '在保留当前版本关键行为的前提下，降低推理资源需求，并比较效果与资源开销。',
  advanced: '',
  sourceRunIds: [],
  tracePlanRequested: false,
  medium: {
    baseModelMode: 'suggest', baseModelId: '', revision: '',
    serverMode: 'new', serverId: '', serverName: '', host: '', port: '22', user: '',
    workDir: '', auth: 'ssh_key', credentialRef: '',
  },
  low: { uncovered: 'stop_and_report', requirements: '' },
})
const draftStorageKey = (source: string) => 'hep-compute-planning:' + encodeURIComponent(source)
function readDraft(source: string): { draft: Draft; status: SendStatus; requestId: string | null } {
  const fallback = { draft: initialDraft(), status: 'idle' as SendStatus, requestId: null }
  try {
    const saved = JSON.parse(sessionStorage.getItem(draftStorageKey(source)) || 'null')
    if (!saved || typeof saved !== 'object' || !saved.draft || typeof saved.draft !== 'object') return fallback
    const candidate = saved.draft
    const strings = [candidate.variantName, candidate.goal, candidate.medium?.baseModelId, candidate.medium?.revision,
      candidate.medium?.serverId, candidate.medium?.serverName ?? '', candidate.medium?.host, candidate.medium?.port, candidate.medium?.user,
      candidate.medium?.workDir, candidate.medium?.credentialRef, candidate.low?.requirements]
    if (!strings.every(value => typeof value === 'string') || typeof candidate.tracePlanRequested !== 'boolean'
      || !Array.isArray(candidate.sourceRunIds)
      || !['catalog', 'custom', 'suggest'].includes(candidate.medium?.baseModelMode)
      || !['registered', 'new', 'later'].includes(candidate.medium?.serverMode)
      || !['ssh_key', 'password'].includes(candidate.medium?.auth)
      || !['stop_and_report', 'request_human'].includes(candidate.low?.uncovered)) return fallback
    const base = initialDraft()
    const draft: Draft = {
      ...base, ...candidate,
      advanced: typeof candidate.advanced === 'string' ? candidate.advanced : '',
      type: candidate.type === 'medium' || candidate.type === 'low' ? candidate.type : null,
      step: candidate.step === 2 ? 2 : 1,
      sourceRunIds: candidate.sourceRunIds.filter((id: unknown) => typeof id === 'string'),
      medium: { ...base.medium, ...candidate.medium },
      low: { ...base.low, ...candidate.low },
    }
    const requestId = typeof saved.requestId === 'string' && saved.requestId ? saved.requestId : null
    const status: SendStatus = requestId && ['sending', 'unknown'].includes(saved.status) ? 'unknown' : saved.status === 'failure' ? 'failure' : 'idle'
    return { draft, status, requestId }
  } catch { return fallback }
}
function writeDraft(source: string, draft: Draft, status: SendStatus, requestId: string | null) {
  try { sessionStorage.setItem(draftStorageKey(source), JSON.stringify({ draft, status, requestId })) } catch { /* 浏览器禁用会话存储时，当前挂载中的草稿仍可继续使用。 */ }
}

function Icon({ name }: { name: 'chip' | 'code' | 'server' | 'layers' | 'tool' | 'close' | 'send' }) {
  const path: Record<typeof name, JSX.Element> = {
    chip: <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5" /><rect x="10" y="10" width="4" height="4" rx="1" /></>,
    code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6" /></>,
    layers: <path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5m-20 5 10 5 10-5" />,
    tool: <path d="M14.5 6.5a5 5 0 0 0-6 6L3 18l3 3 5.5-5.5a5 5 0 0 0 6-6l-3 3-3-3Z" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    send: <><path d="m21 3-7 18-4-7-7-4Z" /><path d="m10 14 11-11" /></>,
  }
  return <svg className="hep-plan-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{path[name]}</svg>
}

function FieldError({ text }: { text?: string }) {
  return text ? <span className="hep-plan-field-error" role="alert">{text}</span> : null
}

export function ComputePlanningDialog({ rpc, open, agentName, agentId, experimentId, versionLabel, parentRef, runs, onClose, onSend, onDirtyChange, themeScheme, onThemeToggle }: {
  rpc: PlatformPageProps['rpc']
  open: boolean
  agentName: string
  agentId: string
  experimentId: string
  versionLabel: string
  parentRef: string
  runs: Run[]
  onClose(): void
  onSend(request: ComputePlanningRequest): Promise<void>
  onDirtyChange?(dirty: boolean): void
  themeScheme?: 'light' | 'dark'
  onThemeToggle?(): void
}): JSX.Element {
  const sourceKey = agentId + '\u0000' + experimentId
  const initial = useRef(readDraft(sourceKey))
  const [draft, setDraft] = useState<Draft>(initial.current.draft)
  const [errors, setErrors] = useState<Errors>({})
  const [status, setStatus] = useState<SendStatus>(initial.current.status)
  const [sendMessage, setSendMessage] = useState('')
  const [requestId, setRequestId] = useState<string | null>(initial.current.requestId)
  const [catalogState, setCatalogState] = useState<CatalogState>({ phase: 'idle', agentId: '', choices: [], message: '' })
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [serverState, setServerState] = useState<ServerState>({ phase: 'idle', list: null, message: '' })
  const [serverRetry, setServerRetry] = useState(0)
  const [serverSaveStatus, setServerSaveStatus] = useState<ServerSaveStatus>('idle')
  const [serverSaveMessage, setServerSaveMessage] = useState('')
  const [connectionCheck, setConnectionCheck] = useState<ConnectionCheck>(null)
  const probeRequestRef = useRef(0)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLFormElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const sendingRef = useRef(false)
  const sentRef = useRef(false)
  const reportedDirtyRef = useRef<{ source: string; dirty: boolean } | null>(null)
  const sourceKeyRef = useRef(sourceKey)
  const availableRuns = useMemo(() => runs.filter(run => run.experiment_id === experimentId && run.run_id).sort((a, b) => b.created_at.localeCompare(a.created_at)), [runs, experimentId])
  const availableIds = useMemo(() => new Set(availableRuns.map(run => run.run_id)), [availableRuns])
  const selectedRunIds = draft.sourceRunIds.filter(id => availableIds.has(id))
  const selectedCatalogModel = catalogState.agentId === agentId ? catalogState.choices.find(item => item.id === draft.medium.baseModelId) : undefined
  const selectedServer = serverState.list?.servers.find(item => item.id === draft.medium.serverId)
  const serverSignature = JSON.stringify(draft.medium.serverMode === 'registered'
    ? [draft.medium.serverMode, selectedServer?.id, selectedServer?.host, selectedServer?.port]
    : [draft.medium.serverMode, draft.medium.host.trim(), draft.medium.port])
  const currentConnectionCheck = connectionCheck?.signature === serverSignature ? connectionCheck : null
  const connectionMessage = currentConnectionCheck?.message || 'SSH 服务尚未探测；可先发送策划，后续核对训练环境。'
  const frozen = status === 'sending' || status === 'unknown' || serverSaveStatus === 'saving'
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft())

  useEffect(() => {
    probeRequestRef.current++
    setConnectionCheck(null)
  }, [serverSignature])

  useEffect(() => {
    if (!onDirtyChange || sourceKeyRef.current !== sourceKey) return
    if (reportedDirtyRef.current?.source === sourceKey && reportedDirtyRef.current.dirty === dirty) return
    reportedDirtyRef.current = { source: sourceKey, dirty }
    onDirtyChange(dirty)
  }, [sourceKey, dirty, onDirtyChange])

  useEffect(() => {
    if (sourceKeyRef.current !== sourceKey || sentRef.current) return
    writeDraft(sourceKey, draft, status, requestId)
  }, [sourceKey, draft, status, requestId])

  useEffect(() => {
    if (!open || draft.type !== 'medium') return
    let active = true
    setCatalogState({ phase: 'loading', agentId, choices: [], message: '' })
    void rpc.call(CHANNEL, 'models/list', {}).then(result => {
      if (!result.ok) throw new Error(result.error.message || '模型目录读取失败')
      const choices = catalogChoices(result.value as ModelList)
      if (active) setCatalogState({ phase: 'ready', agentId, choices, message: '' })
    }).catch(error => {
      if (active) setCatalogState({ phase: 'error', agentId, choices: [], message: error instanceof Error ? error.message : '模型目录读取失败' })
    })
    return () => { active = false }
  }, [rpc, open, agentId, draft.type, catalogRetry])

  useEffect(() => {
    if (!open || draft.type !== 'medium') return
    let active = true
    setServerState({ phase: 'loading', list: null, message: '' })
    void rpc.call(CHANNEL, 'agents/training-servers/list', {}).then(result => {
      if (!result.ok) throw new Error(result.error.message || '训练服务器列表读取失败')
      if (active) setServerState({ phase: 'ready', list: serverList(result.value), message: '' })
    }).catch(error => {
      if (active) setServerState({ phase: 'error', list: null, message: error instanceof Error ? error.message : '训练服务器列表读取失败' })
    })
    return () => { active = false }
  }, [rpc, open, draft.type, serverRetry])

  // 变更工作对象时清除旧草稿，避免把上一版本轨迹发给新的版本。
  useEffect(() => {
    if (sourceKeyRef.current === sourceKey) return
    const restored = readDraft(sourceKey)
    sourceKeyRef.current = sourceKey
    sentRef.current = false
    setDraft(restored.draft)
    setErrors({})
    setStatus(restored.status)
    setSendMessage('')
    setRequestId(restored.requestId)
    setServerSaveStatus('idle')
    setServerSaveMessage('')
    if (open) onClose()
  }, [sourceKey, open, onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      requestAnimationFrame(() => titleRef.current?.focus())
    } else if (!open && dialog.open) {
      dialog.close()
      requestAnimationFrame(() => openerRef.current?.isConnected && openerRef.current.focus())
    }
    return () => {
      if (dialog.open) dialog.close()
      if (openerRef.current?.isConnected) openerRef.current.focus()
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open || !bodyRef.current) return
    bodyRef.current.scrollTop = 0
    const frame = requestAnimationFrame(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0 })
    return () => cancelAnimationFrame(frame)
  }, [open, draft.step])

  function change(update: (value: Draft) => Draft) {
    if (frozen) return
    sentRef.current = false
    setDraft(previous => update(previous))
    setErrors({})
    if (serverSaveStatus !== 'unknown') { setServerSaveStatus('idle'); setServerSaveMessage('') }
    if (status === 'failure') { setStatus('idle'); setSendMessage(''); setRequestId(null) }
  }

  function next() {
    if (!draft.type) {
      setErrors({ type: '请选择一种算力变体。' })
      return
    }
    titleRef.current?.focus({ preventScroll: true })
    change(value => ({ ...value, step: 2 }))
  }

  function validate(): Errors {
    const next: Errors = {}
    if (!draft.type) next.type = '请选择一种算力变体。'
    if (!draft.goal.trim()) next.goal = '请说明本次策划希望达成的目标。'
    if (!draft.tracePlanRequested && selectedRunIds.length === 0) next.runs = '请至少选择一条当前版本轨迹，或选择由助手补充轨迹采集方案。'
    if (draft.type === 'medium') {
      const medium = draft.medium
      if (medium.baseModelMode === 'catalog' && (!selectedCatalogModel || catalogState.phase !== 'ready')) next.baseModelId = '请选择当前业务可用目录中的模型；目录未就绪时可刷新或改请助手建议。'
      if (medium.baseModelMode === 'custom' && !medium.baseModelId.trim()) next.baseModelId = '请填写模型标识或仓库地址。'
      if (medium.serverMode === 'registered' && (!selectedServer || serverState.phase !== 'ready')) next.serverId = '请选择仍在已登记列表中的训练服务器连接。'
      if (medium.serverMode === 'new') Object.assign(next, newServerErrors(medium))
    }
    return next
  }

  async function probeConnection() {
    const target = draft.medium.serverMode === 'registered' ? selectedServer
      : draft.medium.serverMode === 'new' ? { host: draft.medium.host.trim(), port: Number(draft.medium.port) } : null
    if (!target) {
      setErrors({ serverId: '请先选择已登记连接。' })
      return
    }
    const found: Errors = {}
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(target.host) || target.host.length > 255) found.host = '请填写有效主机名或 IP，不含协议与空格。'
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) found.port = '端口范围为 1–65535。'
    if (Object.keys(found).length) {
      setErrors(found)
      setConnectionCheck({ signature: serverSignature, status: 'incomplete', message: '主机或端口无效，未发起 SSH 服务探测。' })
      const first = Object.keys(found)[0]
      requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(`[data-plan-field="${first}"]`)?.focus())
      return
    }
    const request = ++probeRequestRef.current
    const probingSource = sourceKeyRef.current
    setConnectionCheck({ signature: serverSignature, status: 'probing', message: '正在探测目标端口与 SSH 服务标识…' })
    try {
      const result = await rpc.call(CHANNEL, 'agents/training-servers/probe', { host: target.host, port: target.port })
      if (request !== probeRequestRef.current || sourceKeyRef.current !== probingSource) return
      if (!result.ok) throw new Error(result.error.message || 'SSH 服务探测失败')
      const value = result.value as { status?: string; message?: string; checked_at?: string }
      if (!['ssh_reachable', 'port_reachable_unverified', 'unreachable'].includes(value.status || '')) throw new Error('SSH 服务探测响应格式不正确')
      const status = value.status as NonNullable<ConnectionCheck>['status']
      const prefix = status === 'ssh_reachable' ? 'SSH 服务标识已确认可达。' : status === 'port_reachable_unverified' ? '端口可达，但 SSH 服务标识未确认。' : '目标端口不可达。'
      setConnectionCheck({ signature: serverSignature, status, checkedAt: value.checked_at,
        message: `${prefix}${value.message ? ` ${value.message}` : ''} 认证、GPU 与训练依赖仍未验证。` })
    } catch (error) {
      if (request !== probeRequestRef.current || sourceKeyRef.current !== probingSource) return
      setConnectionCheck({ signature: serverSignature, status: 'unknown', message: `探测结果未知：${error instanceof Error ? error.message : '请求失败'}。请重试或稍后在训练环境核对。` })
    }
  }

  async function saveServer() {
    if (serverSaveStatus === 'saving' || serverSaveStatus === 'unknown' || draft.medium.serverMode !== 'new') return
    const found = newServerErrors(draft.medium)
    if (!draft.medium.serverName.trim() || draft.medium.serverName.trim().length > 80 || /[\x00-\x1f\x7f]/.test(draft.medium.serverName)) found.serverName = '请填写 80 字以内的连接名称。'
    if (!serverState.list || serverState.phase !== 'ready') found.serverList = '服务器登记目录尚未就绪，请刷新后重试。'
    setErrors(found)
    const first = Object.keys(found)[0]
    if (first) {
      setServerSaveStatus('error')
      setServerSaveMessage(found[first])
      requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>(`[data-plan-field="${first}"]`)?.focus())
      return
    }
    setServerSaveStatus('saving')
    setServerSaveMessage('')
    const savingSource = sourceKeyRef.current
    try {
      const result = await rpc.call(CHANNEL, 'agents/training-servers/save', {
        revision: serverState.list!.revision,
        server: { name: draft.medium.serverName.trim(), host: draft.medium.host.trim(), port: Number(draft.medium.port),
          user: draft.medium.user.trim(), workDir: draft.medium.workDir.trim(), auth: draft.medium.auth,
          credentialRef: draft.medium.credentialRef.trim() },
      })
      if (sourceKeyRef.current !== savingSource) return
      if (!result.ok) {
        setServerSaveStatus('error')
        setServerSaveMessage(result.error.message || '连接登记失败，请核对资料后重试。')
        return
      }
      const list = serverList(result.value)
      const saved = list.servers.find(item => item.name === draft.medium.serverName.trim() && item.host === draft.medium.host.trim()
        && item.port === Number(draft.medium.port) && item.user === draft.medium.user.trim())
      if (!saved) {
        setServerSaveStatus('unknown')
        setServerSaveMessage('服务器返回成功，但新连接未出现在回执列表。请刷新登记记录核对，勿重复保存。')
        return
      }
      setServerState({ phase: 'ready', list, message: '' })
      setDraft(value => ({ ...value, medium: { ...value.medium, serverMode: 'registered', serverId: saved.id } }))
      setServerSaveStatus('success')
      setServerSaveMessage('连接资料已登记并选中；SSH 连通性与训练环境仍未验证。')
    } catch {
      if (sourceKeyRef.current !== savingSource) return
      setServerSaveStatus('unknown')
      setServerSaveMessage('连接中断，保存结果待核对。请刷新已登记列表查找该连接，勿重复保存。')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sendingRef.current || frozen) return
    const found = validate()
    setErrors(found)
    const first = Object.keys(found)[0]
    if (first) {
      requestAnimationFrame(() => {
        const input = dialogRef.current?.querySelector<HTMLElement>('[data-plan-field="' + first + '"]')
        input?.focus()
        input?.scrollIntoView({ block: 'center' })
      })
      return
    }
    const type = draft.type
    if (!type) return
    const id = requestId ?? (globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + '-' + Math.random().toString(36).slice(2))
    const request: ComputePlanningRequest = {
      requestId: id,
      type,
      variantName: draft.variantName.trim() || agentName + ' · ' + typeLabel(type) + '变体',
      goal: draft.goal.trim(),
      advanced: draft.advanced.trim(),
      sourceRunIds: draft.tracePlanRequested ? [] : selectedRunIds,
      tracePlanRequested: draft.tracePlanRequested,
      ...(type === 'medium' ? { medium: {
        baseModelMode: draft.medium.baseModelMode,
        baseModelId: draft.medium.baseModelMode === 'suggest' ? '' : draft.medium.baseModelMode === 'catalog' && selectedCatalogModel
          ? `${selectedCatalogModel.provider}/${selectedCatalogModel.model}` : draft.medium.baseModelId.trim(),
        revision: draft.medium.revision.trim(),
        serverMode: draft.medium.serverMode,
        serverId: draft.medium.serverMode === 'registered' ? draft.medium.serverId : '',
        host: draft.medium.serverMode === 'registered' ? selectedServer?.host || '' : draft.medium.serverMode === 'new' ? draft.medium.host.trim() : '',
        port: draft.medium.serverMode === 'registered' ? selectedServer?.port || 0 : draft.medium.serverMode === 'new' ? Number(draft.medium.port) : 0,
        user: draft.medium.serverMode === 'registered' ? selectedServer?.user || '' : draft.medium.serverMode === 'new' ? draft.medium.user.trim() : '',
        workDir: draft.medium.serverMode === 'registered' ? selectedServer?.workDir || '' : draft.medium.serverMode === 'new' ? draft.medium.workDir.trim() : '',
        auth: draft.medium.serverMode === 'registered' ? selectedServer?.auth || 'ssh_key' : draft.medium.auth,
        credentialRef: draft.medium.serverMode === 'registered' ? selectedServer?.credentialRef || '' : draft.medium.serverMode === 'new' ? draft.medium.credentialRef.trim() : '',
      } } : { low: { ...draft.low, requirements: draft.low.requirements.trim() } }),
    }
    sendingRef.current = true
    setRequestId(id)
    setStatus('sending')
    setSendMessage('')
    try {
      await onSend(request)
      sentRef.current = true
      try { sessionStorage.removeItem(draftStorageKey(sourceKey)) } catch { /* 当前页面仍清理内存草稿。 */ }
      setDraft(initialDraft())
      setStatus('idle')
      setRequestId(null)
      setServerSaveStatus('idle')
      setServerSaveMessage('')
      onClose()
    } catch (error) {
      const knownUnsent = Boolean(error && typeof error === 'object' && ('definitelyNotSent' in error && error.definitelyNotSent === true))
      setStatus(knownUnsent ? 'failure' : 'unknown')
      setSendMessage(error instanceof Error ? error.message : '请求状态无法确认。')
    } finally {
      sendingRef.current = false
    }
  }

  const pending: string[] = []
  if (draft.tracePlanRequested) pending.push('轨迹采集方案与样本覆盖')
  if (draft.type === 'medium') {
    if (draft.medium.baseModelMode === 'suggest') pending.push('决策基模型选型')
    if (!draft.medium.revision.trim()) pending.push('模型版本固定')
    pending.push('模型训练适配性评估')
    if (draft.medium.serverMode === 'later') pending.push('训练服务器与凭据配置')
    else {
      if (currentConnectionCheck?.status === 'unreachable') pending.push('SSH 端口不可达待处理')
      else if (currentConnectionCheck?.status !== 'ssh_reachable') pending.push('SSH 服务标识验证')
      pending.push('SSH 认证、GPU、依赖与训练环境检查')
    }
    if (draft.medium.serverMode === 'new' && !draft.medium.credentialRef.trim()) pending.push('认证凭据引用')
  }
  pending.push('独立比较集与验收阈值')

  return <dialog ref={dialogRef} className={'hep-compute-dialog' + (draft.step === 2 ? ' hep-plan-config' : '')} aria-modal="true" aria-labelledby="hep-plan-title" aria-describedby="hep-plan-subtitle" onCancel={event => { event.preventDefault(); if (!sendingRef.current && serverSaveStatus !== 'saving') onClose() }}>
    <header className="hep-plan-head">
      <div className="hep-plan-top">
        <div><h2 id="hep-plan-title" tabIndex={-1} ref={titleRef}>请 AI 策划算力变体</h2><p id="hep-plan-subtitle">从当前版本的运行轨迹出发，让 AI 助手协助制定可验证的变体方案。</p></div>
        <div className="hep-plan-top-actions">
          {onThemeToggle && <button type="button" className="hep-plan-theme" aria-label={themeScheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={themeScheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={onThemeToggle}><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{themeScheme === 'dark' ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></> : <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>}</svg></button>}
          <button type="button" className="hep-plan-close" aria-label="暂存并关闭策划弹窗" disabled={status === 'sending' || serverSaveStatus === 'saving'} onClick={onClose}><Icon name="close" /></button>
        </div>
      </div>
      <div className="hep-plan-stepper" aria-label={'第 ' + draft.step + ' 步，共 2 步'}>
        <span data-active={draft.step === 1}><b>{draft.step === 2 ? '✓' : '1'}</b>{draft.step === 2 ? <button type="button" className="hep-plan-link" disabled={frozen} onClick={() => { titleRef.current?.focus({ preventScroll: true }); change(value => ({ ...value, step: 1 })) }}>选择类型</button> : '选择类型'}</span>
        <i aria-hidden="true" />
        <span data-active={draft.step === 2}><b>2</b>策划配置</span>
        {draft.step === 2 && <em>{typeLabel(draft.type)}</em>}
      </div>
      <div className="hep-plan-source"><span>父版本</span><strong>{agentName} · {versionLabel}</strong><em>所选版本</em><details><summary>查看来源线索</summary><code>{agentId} · {experimentId} · {parentRef || 'Git 引用未记录'}</code></details></div>
    </header>
    <form key={draft.step} id="hep-planning-form" ref={bodyRef} className="hep-plan-body" onSubmit={event => void submit(event)} noValidate>
      {draft.step === 1 ? <>
        <div className="hep-plan-choose-lead"><h3>请选择一种算力变体</h3><p>两种路线都基于当前版本的轨迹与工具；本次仅发送策划请求。</p></div>
        {errors.type && <p className="hep-plan-error" role="alert" data-plan-field="type" tabIndex={-1}>{errors.type}</p>}
        <div className="hep-plan-type-grid" role="radiogroup" aria-label="算力变体类型">
          {(['medium', 'low'] as const).map(type => <label key={type} className="hep-plan-type-card" data-selected={draft.type === type}>
            <input type="radio" name="compute-type" value={type} checked={draft.type === type} onChange={() => change(value => ({ ...value, type }))} />
            <div className="hep-plan-type-heading"><span className="hep-plan-type-icon"><Icon name={type === 'medium' ? 'chip' : 'code'} /></span><div><h3>{typeLabel(type)}</h3><p>{type === 'medium' ? '决策模型 + 工具编排' : '规则代码 + 工具编排'}</p></div><span className="hep-plan-radio-mark" aria-hidden="true" /></div>
            <p className="hep-plan-type-desc">{type === 'medium' ? '把轨迹中的决策经验转为训练样本，训练一个决策模型，再由 LangGraph 连接模型、流程和工具。' : '把轨迹中可归纳的决策行为转为规则、分支和数据处理代码，直接用 LangGraph 实现，不训练决策模型。'}</p>
            <ol className="hep-plan-route-list">{(type === 'medium' ? mediumRoute : lowRoute).map(([title, explanation], index) => <li key={title}><i>{index + 1}</i><div><strong>{title}</strong><small>{explanation}</small></div></li>)}</ol>
            <div className="hep-plan-type-foot"><b>适合：</b>{type === 'medium' ? '需要模型参与决策，且有可用样本与训练资源的场景。' : '流程较稳定、决策可归纳为明确规则的场景。'}</div>
          </label>)}
        </div>
        <div className="hep-plan-choose-notes"><p><strong>近似等效是待验证目标。</strong> 不以技术路线代替效果结论，后续须使用独立用例与原版本比较。</p><p><strong>“中 / 低”描述目标实现路线。</strong> 实际资源收益需验证；低算力未覆盖场景默认中止并报告。</p></div>
      </> : <div className="hep-plan-config-layout">
        <div className="hep-plan-config-main">
          {status === 'failure' && <div className="hep-plan-notice hep-plan-error-notice" role="alert"><strong>明确未发送</strong><p>{sendMessage || '请求未离开本页。'}填写内容已保留，可以重试。</p></div>}
          {status === 'unknown' && <div className="hep-plan-notice hep-plan-warning-notice" role="alert"><strong>发送结果待核对，请勿重复发送</strong><p>请求编号 <code>{requestId}</code>。先在平台 AI 助手中核对该请求是否已送达。{sendMessage}</p><button type="button" onClick={() => { setStatus('failure'); setSendMessage('已由用户确认未送达。') }}>我已核对，确认未送达</button></div>}
          <fieldset disabled={frozen} className="hep-plan-fields">
            <section className="hep-plan-form-section">
              <h3><span>01</span>策划目标</h3>
              <div className="hep-plan-field-grid">
                <label className="hep-plan-field"><span>变体名称 <small>选填</small></span><input maxLength={60} value={draft.variantName} placeholder={agentName + ' · ' + typeLabel(draft.type) + '变体'} onChange={event => change(value => ({ ...value, variantName: event.target.value }))} /></label>
                <div className="hep-plan-field"><span>父版本</span><div className="hep-plan-readonly">{agentName} <strong>{versionLabel}</strong><em>所选版本</em></div></div>
                <label className="hep-plan-field hep-plan-wide">目标说明<textarea data-plan-field="goal" rows={3} maxLength={1000} aria-invalid={Boolean(errors.goal)} value={draft.goal} onChange={event => change(value => ({ ...value, goal: event.target.value }))} /><FieldError text={errors.goal} /></label>
              </div>
            </section>
            <section className="hep-plan-form-section">
              <h3><span>02</span>来源轨迹 <small>{versionLabel} · 当前版本</small></h3>
              <div className="hep-plan-trace-box" data-plan-field="runs" tabIndex={-1} aria-invalid={Boolean(errors.runs)}>
                {availableRuns.length ? availableRuns.map(run => <label key={run.run_id} className="hep-plan-trace-row" data-disabled={draft.tracePlanRequested}>
                  <input type="checkbox" checked={selectedRunIds.includes(run.run_id)} disabled={draft.tracePlanRequested} onChange={() => change(value => ({ ...value, sourceRunIds: value.sourceRunIds.includes(run.run_id) ? value.sourceRunIds.filter(id => id !== run.run_id) : [...value.sourceRunIds, run.run_id] }))} />
                  <span>{runTitle(run)}</span><em data-status={runPresentation(run).tone}>{runPresentation(run).label}</em><time>{runTime(run.created_at)}</time>
                </label>) : <p className="hep-plan-trace-empty">当前版本暂无可选轨迹。可先由助手策划采集范围。</p>}
              </div>
              {availableRuns.length > 0 && <details className="hep-plan-trace-details"><summary>查看 Run ID 与来源</summary>{availableRuns.map(run => <code key={run.run_id}>{run.run_id} · {versionLabel} / {run.experiment_id}</code>)}</details>}
              <FieldError text={errors.runs} />
              <div className="hep-plan-trace-control"><span>{draft.tracePlanRequested ? '本次暂不引用轨迹' : '已选择 ' + selectedRunIds.length + ' 条轨迹 · 场景覆盖待分析'}</span><label><input type="checkbox" checked={draft.tracePlanRequested} onChange={event => change(value => ({ ...value, tracePlanRequested: event.target.checked }))} />先由助手补充轨迹采集方案</label></div>
              {draft.tracePlanRequested && <div className="hep-plan-notice hep-plan-warning-notice">本次暂不引用轨迹。助手会先策划采集范围与覆盖用例，再判断变体方案。</div>}
            </section>
            {draft.type === 'medium' ? <section className="hep-plan-form-section" data-testid="medium-training">
              <h3><span>03</span>中算力配置 <small>决策模型 + LangGraph + 真实工具</small></h3>
              <div className="hep-plan-training-grid">
                <div className="hep-plan-form-card" data-testid="base-model"><h4><Icon name="chip" />决策基模型</h4>
                  <div className="hep-plan-segmented" role="group" aria-label="基模型来源">{([['catalog', '模型库'], ['custom', '自定义'], ['suggest', '请助手建议']] as const).map(([mode, label]) => <button type="button" key={mode} data-active={draft.medium.baseModelMode === mode} onClick={() => change(value => ({ ...value, medium: { ...value.medium, baseModelMode: mode, baseModelId: '' } }))}>{label}</button>)}</div>
                  {draft.medium.baseModelMode === 'catalog' ? <>
                    {catalogState.phase === 'loading' || catalogState.agentId !== agentId ? <div className="hep-plan-notice" role="status">正在读取统一业务可用模型…</div>
                      : catalogState.phase === 'error' ? <div className="hep-plan-notice hep-plan-error-notice" role="alert">模型目录读取失败：{catalogState.message}。<button type="button" onClick={() => setCatalogRetry(value => value + 1)}>重试读取</button></div>
                        : catalogState.choices.length ? <label className="hep-plan-field">决策基模型<select data-plan-field="baseModelId" value={selectedCatalogModel?.id || ''} aria-invalid={Boolean(errors.baseModelId)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, baseModelId: event.target.value } }))}><option value="">请选择业务可用模型</option>{catalogState.choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
                          : <div className="hep-plan-notice">当前 DSH 目录暂无可用于业务实例的模型。请先到“设置 → 模型”配置模型，或选择“自定义”提交策划意向、“请助手建议”继续策划。</div>}
                  </> : draft.medium.baseModelMode === 'custom' ? <label className="hep-plan-field">模型标识或仓库地址<input data-plan-field="baseModelId" value={draft.medium.baseModelId} aria-invalid={Boolean(errors.baseModelId)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, baseModelId: event.target.value } }))} placeholder="填写真实模型标识或仓库地址" /><FieldError text={errors.baseModelId} /></label> : <div className="hep-plan-notice hep-plan-blue-notice">助手将结合轨迹、目标和训练资源建议候选基模型。</div>}
                    {draft.medium.baseModelMode === 'catalog' && <><button type="button" className="hep-plan-link" disabled={catalogState.phase === 'loading'} onClick={() => setCatalogRetry(value => value + 1)}>刷新模型目录</button><FieldError text={errors.baseModelId} /></>}
                  {draft.medium.baseModelMode !== 'suggest' && <label className="hep-plan-field"><span>版本 / Revision <small>选填</small></span><input value={draft.medium.revision} onChange={event => change(value => ({ ...value, medium: { ...value.medium, revision: event.target.value } }))} placeholder="待固定，可在策划时补充" /></label>}
                  {draft.medium.baseModelMode !== 'suggest' && <span className="hep-plan-model-meta">训练适配性待评估</span>}
                  <p className="hep-plan-hint">模型库引用共享的 DSH 推理目录；训练适配性、版本、许可与资源要求仍需核实。</p>
                </div>
                <div className="hep-plan-form-card" data-testid="training-server"><h4><Icon name="server" />训练服务器</h4>
                  <div className="hep-plan-segmented" role="group" aria-label="训练服务器来源">{([['registered', '已登记连接'], ['new', '新连接'], ['later', '稍后配置']] as const).map(([mode, label]) => <button type="button" key={mode} data-active={draft.medium.serverMode === mode} onClick={() => change(value => ({ ...value, medium: { ...value.medium, serverMode: mode } }))}>{label}</button>)}</div>
                  {draft.medium.serverMode === 'registered' ? <>
                    {serverState.phase === 'loading' ? <div className="hep-plan-notice" role="status">正在读取已登记训练服务器…</div>
                      : serverState.phase === 'error' ? <div className="hep-plan-notice hep-plan-error-notice" role="alert">训练服务器列表读取失败：{serverState.message}。</div>
                        : serverState.list?.servers.length ? <>
                          <label className="hep-plan-field">连接记录<select data-plan-field="serverId" value={selectedServer?.id || ''} aria-invalid={Boolean(errors.serverId)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, serverId: event.target.value } }))}><option value="">请选择已登记连接</option>{serverState.list.servers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label>
                          {selectedServer && <div className="hep-plan-registered-details"><span><b>Host</b><code>{selectedServer.host}</code></span><span><b>Port</b><code>{selectedServer.port}</code></span><span><b>Username</b><code>{selectedServer.user}</code></span><span><b>认证</b>{selectedServer.auth === 'ssh_key' ? 'SSH 密钥引用' : '密码凭据引用'}</span><span className="hep-plan-wide"><b>工作目录</b><code>{selectedServer.workDir}</code></span><span className="hep-plan-wide"><b>凭据引用</b><code>{selectedServer.credentialRef || '待补充'}</code></span></div>}
                          <p className="hep-plan-hint">登记只表示资料已保存；SSH 连通性、GPU 与训练环境仍未验证。</p>
                        </> : <div className="hep-plan-notice">当前没有已登记的训练服务器 SSH 连接。可切换“新连接”填写并显式保存，或选“稍后配置”。</div>}
                    <div className="hep-plan-connection-actions"><button type="button" onClick={() => setServerRetry(value => value + 1)} disabled={serverState.phase === 'loading'}>刷新登记记录</button><span>列表来自当前数据工作区</span></div>
                    {selectedServer && <div className="hep-plan-connection-actions"><button type="button" onClick={() => void probeConnection()} disabled={currentConnectionCheck?.status === 'probing'}>{currentConnectionCheck?.status === 'probing' ? '测试中…' : currentConnectionCheck?.status === 'unreachable' ? '重试连接测试' : '测试连接'}</button><span>真实端口与 SSH 标识探测</span><p role="status" data-status={currentConnectionCheck?.status || 'idle'}>{connectionMessage}{currentConnectionCheck?.checkedAt && <> · {runTime(currentConnectionCheck.checkedAt)}</>}</p></div>}
                    {serverSaveStatus === 'success' && <p className="hep-plan-notice hep-plan-blue-notice" role="status">{serverSaveMessage}</p>}
                    <FieldError text={errors.serverId} />
                  </> : draft.medium.serverMode === 'later' ? <div className="hep-plan-notice hep-plan-blue-notice">可以先策划。助手会列出训练资源和连接配置的待补项，本次不会连接服务器。</div> : <>
                    <label className="hep-plan-field">连接名称 <small>仅保存登记时必填</small><input data-plan-field="serverName" value={draft.medium.serverName} aria-invalid={Boolean(errors.serverName)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, serverName: event.target.value } }))} placeholder="例如：训练服务器 A" /><FieldError text={errors.serverName} /></label>
                    <div className="hep-plan-field-grid hep-plan-three">
                      <label className="hep-plan-field">Host<input data-plan-field="host" value={draft.medium.host} aria-invalid={Boolean(errors.host)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, host: event.target.value } }))} placeholder="服务器地址" /><FieldError text={errors.host} /></label>
                      <label className="hep-plan-field">Port<input data-plan-field="port" inputMode="numeric" value={draft.medium.port} aria-invalid={Boolean(errors.port)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, port: event.target.value } }))} /><FieldError text={errors.port} /></label>
                      <label className="hep-plan-field">Username<input data-plan-field="user" value={draft.medium.user} aria-invalid={Boolean(errors.user)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, user: event.target.value } }))} placeholder="SSH 用户" /><FieldError text={errors.user} /></label>
                    </div>
                    <div className="hep-plan-field-grid">
                      <label className="hep-plan-field hep-plan-wide">工作目录<input data-plan-field="workDir" value={draft.medium.workDir} aria-invalid={Boolean(errors.workDir)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, workDir: event.target.value } }))} placeholder="/workspace/variant-training" /><FieldError text={errors.workDir} /></label>
                      <label className="hep-plan-field">认证方式<select value={draft.medium.auth} onChange={event => change(value => ({ ...value, medium: { ...value.medium, auth: event.target.value as Draft['medium']['auth'] } }))}><option value="ssh_key">SSH 密钥引用</option><option value="password">密码凭据引用</option></select></label>
                      <label className="hep-plan-field"><span>凭据引用 <small>可稍后补充</small></span><input data-plan-field="credentialRef" value={draft.medium.credentialRef} aria-invalid={Boolean(errors.credentialRef)} onChange={event => change(value => ({ ...value, medium: { ...value.medium, credentialRef: event.target.value } }))} placeholder="ref:training-ssh-key" autoComplete="off" /><FieldError text={errors.credentialRef} /></label>
                    </div>
                    <p className="hep-plan-hint">只填 ref: 开头的凭据引用，不输入密码或私钥正文。本次仅发送策划信息，不发起 SSH 或训练。</p>
                  </>}
                  {draft.medium.serverMode === 'new' && <>
                    <div className="hep-plan-connection-actions"><button type="button" onClick={() => void probeConnection()} disabled={currentConnectionCheck?.status === 'probing'}>{currentConnectionCheck?.status === 'probing' ? '测试中…' : currentConnectionCheck?.status === 'unreachable' ? '重试连接测试' : '测试连接'}</button><span>真实端口与 SSH 标识探测</span><p role="status" data-status={currentConnectionCheck?.status || 'idle'}>{connectionMessage}{currentConnectionCheck?.checkedAt && <> · {runTime(currentConnectionCheck.checkedAt)}</>}</p></div>
                    <div className="hep-plan-connection-actions"><button type="button" onClick={() => void saveServer()} disabled={serverSaveStatus === 'saving' || serverSaveStatus === 'unknown'}>{serverSaveStatus === 'saving' ? '正在保存…' : '保存为已登记连接'}</button><span>仅点击此按钮才保存连接资料</span>
                      {serverSaveStatus === 'error' && <p className="hep-plan-error-notice" role="alert">{serverSaveMessage}</p>}
                      {serverSaveStatus === 'unknown' && <p className="hep-plan-warning-notice" role="alert">{serverSaveMessage}<button type="button" onClick={() => { setServerSaveStatus('idle'); setServerSaveMessage('') }}>我已核对，确认未保存</button></p>}
                    </div>
                  </>}
                </div>
              </div>
            </section> : <section className="hep-plan-form-section">
              <h3><span>03</span>低算力实现约束 <em>不训练决策模型</em></h3>
              <div className="hep-plan-low-route"><div><Icon name="layers" /><strong>提炼规则与分支</strong><p>分析轨迹中的条件、动作与数据处理。</p></div><div><Icon name="code" /><strong>LangGraph 代码实现</strong><p>将决策流程转为可检查的代码。</p></div><div><Icon name="tool" /><strong>复用真实工具</strong><p>沿用工具接口与权限，保留真实调用。</p></div></div>
              <div className="hep-plan-low-policy"><h4>未覆盖情况如何处理</h4><label className="hep-plan-field">处理策略<select value={draft.low.uncovered} onChange={event => change(value => ({ ...value, low: { ...value.low, uncovered: event.target.value as Draft['low']['uncovered'] } }))}><option value="stop_and_report">中止并报告（默认）</option><option value="request_human">暂停并请求人工处理</option></select></label><p>无法匹配规则、工具异常或输入越界时，明确报告原因；不会自动改用大模型。</p></div>
              <label className="hep-plan-field"><span>实现要求与限制 <small>选填</small></span><textarea maxLength={1500} rows={3} value={draft.low.requirements} onChange={event => change(value => ({ ...value, low: { ...value.low, requirements: event.target.value } }))} placeholder="可补充必须保留的工具、输出格式与边界条件" /></label>
            </section>}
            <details className="hep-plan-advanced">
              <summary>更多策划补充（选填）</summary>
              <label className="hep-plan-field">其他限制与验收关注点<textarea data-plan-field="advanced" maxLength={1500} rows={3} value={draft.advanced} onChange={event => change(value => ({ ...value, advanced: event.target.value }))} placeholder="例如：必须覆盖的异常、资源预算或结果格式" /></label>
            </details>
          </fieldset>
        </div>
        <aside className="hep-plan-summary" aria-label="本次策划摘要"><small>本次策划摘要</small><h3>{typeLabel(draft.type)}变体</h3><p>{draft.type === 'medium' ? '决策模型 + 工具编排' : '规则代码 + 工具编排'}</p><dl>
          <div><dt>父版本</dt><dd>{agentName} · {versionLabel}</dd></div>
          <div><dt>轨迹依据</dt><dd>{draft.tracePlanRequested ? '由助手策划采集' : selectedRunIds.length + ' 条当前版本轨迹'}</dd></div>
          {draft.type === 'medium' ? <><div><dt>决策基模型</dt><dd>{draft.medium.baseModelMode === 'suggest' ? '请助手建议' : draft.medium.baseModelMode === 'catalog' ? selectedCatalogModel?.name || '请选择业务可用模型' : draft.medium.baseModelId || '待填写'}</dd></div><div><dt>训练服务器</dt><dd>{draft.medium.serverMode === 'later' ? '稍后配置' : draft.medium.serverMode === 'registered' ? selectedServer?.name || '请选择已登记连接' : draft.medium.host ? draft.medium.host + ':' + draft.medium.port : '新连接待填写'}</dd></div></> : <><div><dt>工具调用</dt><dd>复用原有真实工具</dd></div><div><dt>未覆盖情况</dt><dd>{draft.low.uncovered === 'stop_and_report' ? '中止并报告' : '暂停并请求人工处理'}</dd></div></>}
          {draft.advanced.trim() && <div><dt>其他限制</dt><dd className="hep-plan-summary-advanced">{draft.advanced.trim()}</dd></div>}
        </dl><div className="hep-plan-notice hep-plan-blue-notice">发送后在平台 AI 助手中继续策划，不会启动训练或创建变体。</div><div className="hep-plan-pending"><strong>方案中待补充 / 验证</strong><ul>{pending.map(item => <li key={item}>{item}</li>)}</ul></div></aside>
      </div>}
    </form>
    <footer className="hep-plan-footer">
      <p><strong>{draft.step === 1 ? (draft.type ? '已选择' + typeLabel(draft.type) : '先选择一种技术路线') : typeLabel(draft.type) + ' · ' + (draft.tracePlanRequested ? '轨迹待采集' : selectedRunIds.length + ' 条轨迹') + ' · ' + pending.length + ' 项待补充 / 验证'}</strong><br />{draft.step === 1 ? '下一步补充轨迹依据与策划配置。' : '仅发送策划请求，配置可在助手中继续完善。'}</p>
      <div><button type="button" disabled={status === 'sending'} onClick={onClose}>暂存并关闭</button>{draft.step === 1 ? <button key="next" type="button" className="hep-plan-primary" onClick={event => { event.preventDefault(); next() }}>下一步：策划配置 →</button> : <button key="send" type="submit" form="hep-planning-form" className="hep-plan-primary" disabled={frozen}><Icon name="send" />{status === 'sending' ? '正在发送…' : status === 'unknown' ? '等待核对发送结果' : '发送给平台 AI 助手'}</button>}</div>
    </footer>
  </dialog>
}
