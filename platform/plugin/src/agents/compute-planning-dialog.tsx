import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'

export type TrainingModelSource = 'huggingface' | 'modelscope' | 'local' | 'unspecified'

export type ComputePlanningRequest = {
  requestId: string
  type: 'medium' | 'low'
  variantName: string
  goal: string
  advanced: string
  sourceRunIds: string[]
  tracePlanRequested: boolean
  medium?: {
    serverMode: 'registered' | 'new' | 'later'
    serverId: string
    host: string
    port: number
    user: string
    workDir: string
    auth: 'ssh_key' | 'password'
    credentialRef: string
    models?: Array<{ kind: 'llm' | 'decision'; source?: TrainingModelSource; baseModel: string; revision: string; purpose: string }>
    combinationPreference?: string
  }
  low?: {
    uncovered: 'stop_and_report' | 'request_human'
    requirements: string
  }
}

type PlanningType = ComputePlanningRequest['type']
type ModelSuggestion = { id: number; kind: 'llm' | 'decision'; source: TrainingModelSource; baseModel: string; revision: string; purpose: string }
type Draft = {
  type: PlanningType
  variantName: string
  goal: string
  advanced: string
  sourceRunIds: string[]
  tracePlanRequested: boolean
  modelSuggestions: ModelSuggestion[]
  combinationPreference: string
  previousInferenceModel: string | null
  previousInferenceRevision: string
  medium: {
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
type TrainingServer = { id: string; name: string; host: string; port: number; user: string; workDir: string; auth: 'ssh_key' | 'password'; credentialRef: string }
type ServerList = { revision: string; servers: TrainingServer[] }
type ServerState = { phase: 'idle' | 'loading' | 'ready' | 'error'; list: ServerList | null; message: string }
type ServerSaveStatus = 'idle' | 'saving' | 'error' | 'unknown' | 'success'
type ConnectionCheck = { signature: string; status: 'probing' | 'ssh_reachable' | 'port_reachable_unverified' | 'unreachable' | 'unknown' | 'incomplete'; message: string; checkedAt?: string } | null
type Run = { run_id: string; experiment_id: string; status: string; created_at: string; title?: string; effective_verdict?: 'passed' | 'failed' | 'inconclusive' | null }

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
function serverList(value: unknown): ServerList {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('训练服务器列表响应格式不正确')
  const list = value as Partial<ServerList>
  if (typeof list.revision !== 'string' || !Array.isArray(list.servers)) throw new Error('训练服务器列表响应格式不正确')
  return { revision: list.revision, servers: list.servers }
}

function newServerErrors(medium: Draft['medium'], partial = false): Errors {
  const errors: Errors = {}
  if ((!partial || medium.host.trim()) && (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(medium.host.trim()) || medium.host.trim().length > 255)) errors.host = '请填写有效主机名或 IP，不含协议与空格。'
  if ((!partial || medium.port.trim()) && (!/^\d+$/.test(medium.port) || Number(medium.port) < 1 || Number(medium.port) > 65535)) errors.port = '端口范围为 1–65535。'
  if ((!partial || medium.user.trim()) && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(medium.user.trim())) errors.user = '请填写有效 SSH 用户名。'
  if ((!partial || medium.workDir.trim()) && (!medium.workDir.trim().startsWith('/') || /[\x00-\x1f\x7f]/.test(medium.workDir))) errors.workDir = '请填写以 / 开头的绝对工作目录。'
  if (medium.credentialRef && !/^ref:[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(medium.credentialRef.trim())) errors.credentialRef = '只填写 ref: 开头的凭据引用，不要粘贴密码或私钥。'
  return errors
}
const initialDraft = (): Draft => ({
  type: 'medium',
  variantName: '',
  goal: '在保留当前版本关键行为的前提下，降低推理资源需求，并比较效果与资源开销。',
  advanced: '',
  sourceRunIds: [],
  tracePlanRequested: true,
  modelSuggestions: [], combinationPreference: '', previousInferenceModel: null, previousInferenceRevision: '',
  medium: {
    serverMode: 'later', serverId: '', serverName: '', host: '', port: '22', user: '',
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
    const strings = [candidate.variantName, candidate.goal, candidate.medium?.serverId, candidate.medium?.serverName ?? '', candidate.medium?.host, candidate.medium?.port, candidate.medium?.user,
      candidate.medium?.workDir, candidate.medium?.credentialRef, candidate.low?.requirements]
    if (!strings.every(value => typeof value === 'string') || typeof candidate.tracePlanRequested !== 'boolean'
      || !Array.isArray(candidate.sourceRunIds)
      || !['registered', 'new', 'later'].includes(candidate.medium?.serverMode)
      || !['ssh_key', 'password'].includes(candidate.medium?.auth)
      || !['stop_and_report', 'request_human'].includes(candidate.low?.uncovered)) return fallback
    const base = initialDraft()
    const models: ModelSuggestion[] = Array.isArray(candidate.modelSuggestions)
      ? candidate.modelSuggestions.filter((row: any) => row && ['llm', 'decision'].includes(row.kind) && ['baseModel', 'revision', 'purpose'].every(key => typeof row[key] === 'string'))
        .map((row: any, id: number) => ({ ...row, id, source: ['huggingface', 'modelscope', 'local'].includes(row.source) ? row.source : 'unspecified' })) : []
    const { baseModelMode: oldMode, baseModelId: oldId, revision: oldRevision, ...training } = candidate.medium
    const legacyModel = typeof oldId === 'string' ? oldId : ''
    const legacyRevision = typeof oldRevision === 'string' ? oldRevision : ''
    if (oldMode === 'custom' && (legacyModel.trim() || legacyRevision.trim()) && !models.some(row => row.baseModel === legacyModel && row.revision === legacyRevision)) {
      models.push({ id: models.length, kind: 'decision', source: 'unspecified', baseModel: legacyModel, revision: legacyRevision, purpose: '训练基模型参考' })
    }
    const draft: Draft = {
      ...base, ...candidate,
      advanced: typeof candidate.advanced === 'string' ? candidate.advanced : '',
      modelSuggestions: models,
      combinationPreference: typeof candidate.combinationPreference === 'string' ? candidate.combinationPreference : '',
      previousInferenceModel: typeof candidate.previousInferenceModel === 'string' ? candidate.previousInferenceModel : oldMode === 'catalog' && typeof oldId === 'string' && oldId ? oldId : null,
      previousInferenceRevision: typeof candidate.previousInferenceRevision === 'string' ? candidate.previousInferenceRevision : oldMode === 'catalog' && typeof oldRevision === 'string' ? oldRevision : '',
      type: candidate.type === 'low' ? 'low' : 'medium',
      sourceRunIds: candidate.sourceRunIds.filter((id: unknown) => typeof id === 'string'),
      medium: { ...base.medium, ...training },
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

function Icon({ name }: { name: 'chip' | 'code' | 'server' | 'close' | 'send' }) {
  const path: Record<typeof name, JSX.Element> = {
    chip: <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 1v5m6-5v5M9 18v5m6-5v5M1 9h5m-5 6h5m12-6h5m-5 6h5" /><rect x="10" y="10" width="4" height="4" rx="1" /></>,
    code: <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />,
    server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    send: <><path d="m21 3-7 18-4-7-7-4Z" /><path d="m10 14 11-11" /></>,
  }
  return <svg className="hep-plan-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{path[name]}</svg>
}

function FieldError({ text }: { text?: string }) {
  return text ? <span className="hep-plan-field-error" role="alert">{text}</span> : null
}

export function ComputePlanningDialog({ rpc, open, agentName, agentId, experimentId, versionLabel, parentRef, runs, onClose, onSend, onDirtyChange }: {
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
}): JSX.Element {
  const sourceKey = agentId + '\u0000' + experimentId
  const initial = useRef(readDraft(sourceKey))
  const [draft, setDraft] = useState<Draft>(initial.current.draft)
  const [errors, setErrors] = useState<Errors>({})
  const modelSuggestions = draft.modelSuggestions
  const combinationPreference = draft.combinationPreference
  const [modelsOpen, setModelsOpen] = useState(false)
  const [serverOpen, setServerOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [status, setStatus] = useState<SendStatus>(initial.current.status)
  const [sendMessage, setSendMessage] = useState('')
  const [requestId, setRequestId] = useState<string | null>(initial.current.requestId)
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
  }, [open])

  function change(update: (value: Draft) => Draft) {
    if (frozen) return
    sentRef.current = false
    setDraft(previous => update(previous))
    setErrors({})
    if (serverSaveStatus !== 'unknown') { setServerSaveStatus('idle'); setServerSaveMessage('') }
    if (status === 'failure') { setStatus('idle'); setSendMessage(''); setRequestId(null) }
  }

  function setModelSuggestions(update: ModelSuggestion[] | ((rows: ModelSuggestion[]) => ModelSuggestion[])) {
    change(value => ({ ...value, modelSuggestions: typeof update === 'function' ? update(value.modelSuggestions) : update }))
  }
  function setCombinationPreference(value: string) {
    change(draft => ({ ...draft, combinationPreference: value }))
  }

  function validate(): Errors {
    const next: Errors = {}
    if (!draft.type) next.type = '请选择一种算力变体。'
    if (!draft.goal.trim()) next.goal = '请说明本次策划希望达成的目标。'
    if (!draft.tracePlanRequested && selectedRunIds.length === 0) next.runs = '请至少选择一条当前版本轨迹，或选择由助手补充轨迹采集方案。'
    if (draft.type === 'medium') {
      const medium = draft.medium
      if (medium.serverMode === 'registered' && (!selectedServer || serverState.phase !== 'ready')) next.serverId = '请选择仍在已登记列表中的训练服务器连接。'
      if (medium.serverMode === 'new') Object.assign(next, newServerErrors(medium, true))
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
      if (['serverId', 'serverName', 'host', 'port', 'user', 'workDir', 'credentialRef'].includes(first)) setServerOpen(true)
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
        models: modelSuggestions.map(row => ({ kind: row.kind, source: row.source, baseModel: row.baseModel.trim(), revision: row.revision.trim(), purpose: row.purpose.trim() })),
        combinationPreference: combinationPreference.trim(),
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
      try { sessionStorage.removeItem(draftStorageKey(sourceKey)) } catch { /* 当前页面仍清理内存草稿。 */ }
      if (sourceKeyRef.current !== sourceKey) return
      sentRef.current = true
      setDraft(initialDraft())
      setModelsOpen(false); setServerOpen(false); setAdvancedOpen(false)
      setStatus('idle')
      setRequestId(null)
      setServerSaveStatus('idle')
      setServerSaveMessage('')
      onClose()
    } catch (error) {
      if (sourceKeyRef.current !== sourceKey) return
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
    if (!modelSuggestions.some(row => row.baseModel.trim())) pending.push('小尺寸 LLM 与决策模型选型')
    if (modelSuggestions.some(row => row.baseModel.trim() && !row.revision.trim())) pending.push('模型版本固定')
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

  return <dialog ref={dialogRef} className="hep-compute-dialog hep-plan-config" aria-modal="true" aria-labelledby="hep-plan-title" aria-describedby="hep-plan-subtitle" onCancel={event => { event.preventDefault(); if (!sendingRef.current && serverSaveStatus !== 'saving') onClose() }}>
    <header className="hep-plan-head">
      <div className="hep-plan-top">
        <div><h2 id="hep-plan-title" tabIndex={-1} ref={titleRef}>策划算力变体</h2><p id="hep-plan-subtitle">补充目标与已有线索，交由平台助手制定可验证的方案。</p></div>
        <div className="hep-plan-top-actions">
          <button type="button" className="hep-plan-close" aria-label="暂存并关闭策划弹窗" disabled={status === 'sending' || serverSaveStatus === 'saving'} onClick={onClose}><Icon name="close" /></button>
        </div>
      </div>
      <div className="hep-plan-source"><span>父版本</span><strong>{agentName}</strong><span className="hep-plan-version">{versionLabel}</span><details><summary>版本来源</summary><code>{agentId}<br/>{experimentId}<br/>{parentRef || 'Git 引用未记录'}</code></details></div>
    </header>
    <form id="hep-planning-form" ref={bodyRef} className="hep-plan-body" onSubmit={event => void submit(event)} noValidate>
      <div className="hep-plan-config-layout">
        <div className="hep-plan-config-main">
          {status === 'failure' && <div className="hep-plan-notice hep-plan-error-notice" role="alert"><strong>明确未发送</strong><p>{sendMessage || '请求未离开本页。'}填写内容已保留，可以重试。</p></div>}
          {status === 'unknown' && <div className="hep-plan-notice hep-plan-warning-notice" role="alert"><strong>发送结果待核对，请勿重复发送</strong><p>请求编号 <code>{requestId}</code>。先在平台 AI 助手中核对该请求是否已送达。{sendMessage}</p><button type="button" onClick={() => { setStatus('failure'); setSendMessage('已由用户确认未送达。') }}>我已核对，确认未送达</button></div>}
          <fieldset disabled={frozen} className="hep-plan-fields">
            <div className="hep-plan-mode-switch" role="group" aria-label="策划模式">
              <button type="button" aria-label="中算力" aria-pressed={draft.type === 'medium'} data-active={draft.type === 'medium'} onClick={() => change(value => ({ ...value, type: 'medium' }))}><Icon name="chip" /><span><strong>中算力</strong><small>小模型训练与组合</small></span></button>
              <button type="button" aria-label="低算力" aria-pressed={draft.type === 'low'} data-active={draft.type === 'low'} onClick={() => change(value => ({ ...value, type: 'low' }))}><Icon name="code" /><span><strong>低算力</strong><small>LangGraph 流程 · 全链零 LLM</small></span></button>
            </div>
            <section className="hep-plan-form-section">
              <h3>策划目标</h3>
              <div className="hep-plan-field-grid hep-plan-goal-fields">
                <label className="hep-plan-field"><span>变体名称 <small>选填</small></span><input maxLength={60} value={draft.variantName} placeholder={agentName + ' · ' + typeLabel(draft.type) + '变体'} onChange={event => change(value => ({ ...value, variantName: event.target.value }))} /></label>
                <label className="hep-plan-field hep-plan-wide"><span>目标说明 <small>必填</small></span><textarea data-plan-field="goal" rows={2} maxLength={1000} aria-invalid={Boolean(errors.goal)} value={draft.goal} onChange={event => change(value => ({ ...value, goal: event.target.value }))} /><FieldError text={errors.goal} /></label>
              </div>
            </section>
            <section className="hep-plan-form-section hep-plan-traces">
              <h3>来源轨迹 <small>当前版本</small></h3>
              <div className="hep-plan-trace-control">{!draft.tracePlanRequested && <span>已选择 {selectedRunIds.length} 条轨迹 · 场景覆盖待分析</span>}<label><input type="checkbox" checked={draft.tracePlanRequested} onChange={event => change(value => ({ ...value, tracePlanRequested: event.target.checked }))} />先由助手补充轨迹采集方案</label></div>
              {!draft.tracePlanRequested && <>
              <div className="hep-plan-trace-box" data-plan-field="runs" tabIndex={-1} aria-invalid={Boolean(errors.runs)}>
                {availableRuns.length ? availableRuns.map(run => <label key={run.run_id} className="hep-plan-trace-row" data-disabled={draft.tracePlanRequested}>
                  <input type="checkbox" checked={selectedRunIds.includes(run.run_id)} disabled={draft.tracePlanRequested} onChange={() => change(value => ({ ...value, sourceRunIds: value.sourceRunIds.includes(run.run_id) ? value.sourceRunIds.filter(id => id !== run.run_id) : [...value.sourceRunIds, run.run_id] }))} />
                  <span>{runTitle(run)}<small>{run.run_id}</small></span><em data-status={runPresentation(run).tone}>{runPresentation(run).label}</em><time>{runTime(run.created_at)}</time>
                </label>) : <p className="hep-plan-trace-empty">当前版本暂无可选轨迹。可先由助手策划采集范围。</p>}
              </div>
              </>}
              <FieldError text={errors.runs} />

              {draft.tracePlanRequested && <p className="hep-plan-hint">助手会先策划采集范围与覆盖用例，再判断变体方案。</p>}
            </section>
            {draft.type === 'medium' ? <section className="hep-plan-form-section" data-testid="medium-training">
              <h3>模型与训练资源 <small>选填</small></h3>
              {(draft.previousInferenceModel || draft.previousInferenceRevision) && <div className="hep-plan-notice" role="status"><strong>旧草稿中的推理模型引用</strong><code>{draft.previousInferenceModel || '未填写模型引用'}</code>{draft.previousInferenceRevision && <small>原版本：{draft.previousInferenceRevision}</small>}<p>此引用不是训练模型权重，未纳入模型建议。请补充仓库或本地目录，或由助手重新建议。</p><button type="button" onClick={() => change(value => ({ ...value, previousInferenceModel: null, previousInferenceRevision: '' }))}>移除旧引用</button></div>}
              <div className="hep-plan-training-grid">
                <div className="hep-plan-form-card" data-testid="base-model"><details className="hep-plan-optional" open={modelsOpen} onToggle={event => setModelsOpen(event.currentTarget.open)}><summary>模型建议与分工 <small>{modelSuggestions.length ? `${modelSuggestions.length} 项草稿` : '由助手建议'}</small></summary><p className="hep-plan-hint">小尺寸 LLM 与决策模型均可引用 Hugging Face、ModelScope 仓库或实际加载环境中的本地模型目录。可暂留空交由助手建议；本次不下载或训练模型。</p><div className="hep-plan-model-suggestions">{modelSuggestions.map((row, index) => <div className="hep-plan-model-row" key={row.id}><div className="agent-section-heading"><strong>模型 {index + 1}</strong><button type="button" disabled={frozen} onClick={event => { const section = event.currentTarget.closest('.hep-plan-optional'); setModelSuggestions(rows => rows.filter(item => item.id !== row.id)); requestAnimationFrame(() => section?.querySelector<HTMLButtonElement>('.hep-plan-add-model')?.focus()) }}>移除模型 {index + 1}</button></div><label className="hep-plan-field">类型<select aria-label={`模型 ${index + 1} 类型`} value={row.kind} disabled={frozen} onChange={event => setModelSuggestions(rows => rows.map(item => item.id === row.id ? { ...item, kind: event.target.value as 'llm' | 'decision' } : item))}><option value="llm">小尺寸 LLM</option><option value="decision">决策模型</option></select></label><label className="hep-plan-field">模型来源<select aria-label={`模型 ${index + 1} 来源`} value={row.source} disabled={frozen} onChange={event => setModelSuggestions(rows => rows.map(item => item.id === row.id ? { ...item, source: event.target.value as TrainingModelSource } : item))}><option value="unspecified">待确定，由助手建议</option><option value="huggingface">Hugging Face</option><option value="modelscope">ModelScope</option><option value="local">本地模型目录</option></select></label><label className="hep-plan-field">{row.source === 'local' ? '本地模型目录' : '模型仓库 ID、链接或本地路径'}<input aria-label={`模型 ${index + 1} 基模型`} maxLength={300} value={row.baseModel} placeholder={row.source === 'local' ? '/path/to/downloaded-model' : row.source === 'modelscope' ? '组织/模型 或 https://modelscope.cn/models/组织/模型' : row.source === 'huggingface' ? '组织/模型 或 https://huggingface.co/组织/模型' : '填写模型仓库或路径，也可由助手建议'} disabled={frozen} onChange={event => setModelSuggestions(rows => rows.map(item => item.id === row.id ? { ...item, baseModel: event.target.value } : item))}/></label><label className="hep-plan-field">版本 / Revision<input aria-label={`模型 ${index + 1} 版本`} maxLength={160} value={row.revision} placeholder="选填" disabled={frozen} onChange={event => setModelSuggestions(rows => rows.map(item => item.id === row.id ? { ...item, revision: event.target.value } : item))}/></label><label className="hep-plan-field">用途与分工<textarea aria-label={`模型 ${index + 1} 用途`} maxLength={1000} rows={2} value={row.purpose} disabled={frozen} onChange={event => setModelSuggestions(rows => rows.map(item => item.id === row.id ? { ...item, purpose: event.target.value } : item))}/></label></div>)}<button type="button" className="hep-plan-add-model" disabled={frozen} onClick={event => { const section = event.currentTarget.closest('.hep-plan-optional'); setModelSuggestions(rows => [...rows, { id: Math.max(-1, ...rows.map(row => row.id)) + 1, kind: 'llm', source: 'unspecified', baseModel: '', revision: '', purpose: '' }]); requestAnimationFrame(() => { const fields = section?.querySelectorAll<HTMLInputElement>('.hep-plan-model-row input'); fields?.[Math.max(0, fields.length - 2)]?.focus() }) }}>添加模型</button><label className="hep-plan-field">组合偏好<textarea aria-label="模型组合偏好" maxLength={1500} rows={2} value={combinationPreference} disabled={frozen} onChange={event => setCombinationPreference(event.target.value)} placeholder="候选比较、分工协作或其他偏好"/></label></div></details></div>
                <details className="hep-plan-form-card hep-plan-optional" data-testid="training-server" open={serverOpen} onToggle={event => setServerOpen(event.currentTarget.open)}><summary>训练服务器 <small>{draft.medium.serverMode === 'later' ? '稍后配置' : draft.medium.serverMode === 'new' ? '新连接建议' : selectedServer?.name || '待选择'}</small></summary><h4><Icon name="server" />训练服务器</h4>
                  <div className="hep-plan-segmented" role="group" aria-label="训练服务器来源">{([['registered', '已登记连接'], ['new', '新连接'], ['later', '稍后配置']] as const).map(([mode, label]) => <button type="button" key={mode} data-active={draft.medium.serverMode === mode} onClick={() => change(value => ({ ...value, medium: { ...value.medium, serverMode: mode } }))}>{label}</button>)}</div>
                  {draft.medium.serverMode === 'registered' ? <>
                    {serverState.phase === 'loading' ? <LoadingIndicator label="读取训练服务器目录" block />
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
                </details>
              </div>
            </section> : <section className="hep-plan-form-section">
              <h3>流程与未覆盖情况</h3>
              <label className="hep-plan-field">优先规划的流程<textarea maxLength={1500} rows={3} value={draft.low.requirements} onChange={event => change(value => ({ ...value, low: { ...value.low, requirements: event.target.value } }))} placeholder="例如：查询任务 → 获取结果 → 整理报告" /></label>
              <div className="hep-plan-low-policy"><h4>未覆盖情况如何处理</h4><label className="hep-plan-field">流程无法处理时<select value={draft.low.uncovered} onChange={event => change(value => ({ ...value, low: { ...value.low, uncovered: event.target.value as Draft['low']['uncovered'] } }))}><option value="stop_and_report">中止并报告（默认）</option><option value="request_human">暂停并请求人工处理</option></select></label><p>AI 助手将进一步规划节点、工具调用与异常处理。</p></div>
            </section>}
            <details className="hep-plan-advanced" open={advancedOpen} onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
              <summary>更多策划补充（选填）</summary>
              <label className="hep-plan-field">其他限制与验收关注点<textarea data-plan-field="advanced" maxLength={1500} rows={3} value={draft.advanced} onChange={event => change(value => ({ ...value, advanced: event.target.value }))} placeholder="例如：必须覆盖的异常、资源预算或结果格式" /></label>
            </details>
            <div className="hep-plan-pending"><strong>待补充与核验</strong><p>{pending.join('、')}。</p></div>
          </fieldset>
        </div>

      </div>
    </form>
    <footer className="hep-plan-footer">
      <p>草稿自动保留；本次仅发送策划请求。</p>
      <div><button type="button" disabled={status === 'sending' || serverSaveStatus === 'saving'} onClick={onClose}>暂存并关闭</button><button type="submit" form="hep-planning-form" className="hep-plan-primary" disabled={frozen}><Icon name="send" />{status === 'sending' ? '正在发送…' : status === 'unknown' ? '等待核对发送结果' : '发送策划请求'}</button></div>
    </footer>
  </dialog>
}
