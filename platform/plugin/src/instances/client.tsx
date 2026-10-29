import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller'
import { CHANNEL } from '../protocol.ts'
import type { PlatformNavigation, PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { instanceWebUrl } from './url.ts'
import { instanceTheme } from './style.ts'

type Operation = 'create' | 'start' | 'stop' | 'restart' | 'delete'

interface InstanceRow {
  name: string
  state?: string
  source_id?: string
  image_tag?: string
  image_id?: string
  agent_id?: string
  port?: number
  business_gateway?: boolean
  access_mode?: 'authenticated' | 'anonymous'
  identity_mode?: 'development' | 'published'
  access_url?: string
  lan_access?: boolean
  home_volume?: string
  home_directory?: string
  home_preserved?: boolean | null
  container_name?: string
  observed_at?: string
  mounts?: Record<string, string>
  mount_modes?: Record<string, string>
  ps?: string
  model_policy?: { default?: ModelSelection | null }
}

type ModelRef = Pick<ModelSelection, 'provider' | 'model'>
type ModelList = { catalog: ModelCatalog; business_allowed: ModelRef[]; business_default: ModelSelection | null; migration_required?: boolean }

interface ActionRequest {
  operation: Operation
  name: string
  source?: string
  expected_source_id?: string
  expected_source_digest?: string
  expected_state?: string
  port?: number
  business_control?: boolean
  access_mode?: 'authenticated' | 'anonymous'
  identity_mode?: 'development' | 'published'
  model_selection?: ModelSelection
  expected_model_policy_hash?: string
}

interface Detail {
  instance: InstanceRow
  runs: { id: string, path: string }[]
  session_scope: { home_volume?: unknown, preserved?: unknown, note: string }
}

interface Receipt {
  name: string
  operation: Operation
  ok: boolean
  port?: number
  status?: 'success' | 'failed' | 'unknown' | 'not_dispatched'
  requested_source_id?: string
  model_selection?: ModelSelection
  registration?: { status: 'checking' | 'verified' | 'unknown'; observed?: Pick<InstanceRow, 'source_id' | 'state' | 'business_gateway' | 'access_mode' | 'identity_mode' | 'access_url'> | null; checked_at?: string }
  value?: unknown
  error?: { message: string }
}

interface SourceOption {
  source_id: string
  experiment_id: string
  agent_id: string
  selectable: boolean
  reason: string
}

interface AgentOption { id: string; name?: string }

interface SourceRun {
  run_id: string
  status?: string
  created_at?: string
  finished_at?: string
  title?: string | null
  case_scope?: string | null
  case_counts?: { total: number; passed: number; failed: number; inconclusive: number; mixed: number; pending: number } | null
  effective_verdict?: string | null
}

interface OperationPreview {
  name: string
  operation: Operation
  ok: boolean
  value?: { name: string; operation: Operation; plan?: Record<string, unknown>; source_id?: string; port?: number; retention?: Record<string, string>; model_selection?: ModelSelection; model_policy_hash?: string; observed_state?: string; observed_at?: string; access_mode?: 'authenticated' | 'anonymous'; identity_mode?: 'development' | 'published' }
  error?: { message: string }
}

const labels: Record<Operation, string> = {
  create: '创建',
  start: '启动',
  stop: '停止',
  restart: '重启',
  delete: '删除',
}
const impacts: Record<Operation, string> = {
  create: '创建实例登记并启动新容器',
  start: '启动此实例容器',
  stop: '停止并移除此实例容器',
  restart: '停止旧容器并以同一来源重建',
  delete: '移除已停止容器与本实例管理登记',
}

const detailTabs = [{ id: 'overview', label: '概览' }, { id: 'embed', label: '网站嵌入' }, { id: 'logs', label: '运行日志' }, { id: 'receipts', label: '操作回执' }] as const
const stateLabels: Record<string, string> = { running: '运行中', stopped: '已停止', absent: '无容器', failed: '异常', unknown: '状态未知' }
const modelKey = (value: ModelRef) => JSON.stringify([value.provider, value.model])
const sameModel = (left?: ModelSelection | null, right?: ModelSelection | null) =>
  left === right || Boolean(left && right && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort)
const modelRoute = (catalog: ModelCatalog, value: ModelRef) => catalog.groups.find(group => group.id === value.provider)?.models.find(model => model.id === value.model)
const modelLabel = (catalog: ModelCatalog | undefined, value?: ModelRef | null) => {
  if (!value) return '未设置'
  const group = catalog?.groups.find(item => item.id === value.provider)
  const model = group?.models.find(item => item.id === value.model)
  return `${group?.name || value.provider} · ${model?.name || value.model}`
}
const modelAllowed = (allowed: ModelRef[], value?: ModelRef | null) => Boolean(value && allowed.some(item => modelKey(item) === modelKey(value)))
const selectedModel = (catalog: ModelCatalog, allowed: ModelRef[], key: string): ModelSelection | null => {
  const ref = allowed.find(item => modelKey(item) === key)
  if (!ref) return null
  const effort = modelRoute(catalog, ref)?.reasoning?.defaultEffort
  return { ...ref, ...(effort ? { reasoningEffort: effort } : {}) }
}
const modelIssue = (catalog: ModelCatalog | undefined, allowed: ModelRef[], value?: ModelSelection | null) => {
  if (!value) return allowed.length ? '请选择此实例的默认模型。' : '尚无可供业务实例使用的模型，请先到设置 → 模型配置提供方。'
  if (!modelAllowed(allowed, value)) return '所选模型已不在当前业务模型目录，请重新选择。'
  const model = catalog && modelRoute(catalog, value)
  if (!model) return '所选模型已不在当前模型目录，请重新选择。'
  if (value.reasoningEffort && !model.reasoning?.efforts.some(item => item.id === value.reasoningEffort)) return '所选推理档位已不可用，请重新选择。'
  return ''
}

function ModelChoice({ catalog, allowed, value, onChange, label }: { catalog: ModelCatalog; allowed: ModelRef[]; value: ModelSelection | null; onChange(value: ModelSelection | null): void; label: string }) {
  const key = value ? modelKey(value) : ''
  const missing = Boolean(value && !modelRoute(catalog, value)) || Boolean(value && !modelAllowed(allowed, value))
  const reasoning = value && modelRoute(catalog, value)?.reasoning
  return <div className="instance-model-fields">
    <label className="instance-field">{label}<select aria-label={label} className="instance-field-input" value={key} onChange={event => onChange(selectedModel(catalog, allowed, event.target.value))}>
      <option value="">请选择业务可用模型</option>
      {missing && value && <option value={key} disabled>原选择当前不可用：{value.provider} / {value.model}</option>}
      {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.filter(model => modelAllowed(allowed, { provider: group.id, model: model.id })).map(model =>
        <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>{model.name}{model.name === model.id ? '' : ` (${model.id})`}</option>)}</optgroup>)}
    </select></label>
    {value && reasoning?.efforts.length ? <label className="instance-field">推理档位<select aria-label={`${label}推理档位`} className="instance-field-input" value={value.reasoningEffort ?? ''} onChange={event => onChange({ provider: value.provider, model: value.model, ...(event.target.value ? { reasoningEffort: event.target.value } : {}) })}>
      <option value="">使用模型默认档位</option>
      {value.reasoningEffort && !reasoning.efforts.some(item => item.id === value.reasoningEffort) && <option value={value.reasoningEffort} disabled>原档位当前不可用：{value.reasoningEffort}</option>}
      {reasoning.efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label> : null}
  </div>
}

export function InstancesPage({ rpc, updates, onContext, target, onNavigate }: PlatformPageProps & { updates?: PlatformUpdates; target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void; onContext?(context: Record<string, unknown>): void }) {
  const [instances, setInstances] = useState<InstanceRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('existing')
  const [actionPhase, setActionPhase] = useState<'preview' | 'execute' | 'readback' | null>(null)
  const busy = actionPhase !== null
  const actionDialogLocked = actionPhase === 'preview' || actionPhase === 'execute'
  const [loading, setLoading] = useState(false)
  const [listLoaded, setListLoaded] = useState(false)
  const [lastListAt, setLastListAt] = useState('')
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  useEffect(() => {
    if (target?.page === 'instances') setSourceFilter(target.experiment_id ? `experiment:${target.experiment_id}` : '')
  }, [target?.page, target?.experiment_id])
  const [detailLoading, setDetailLoading] = useState(false)
  const [opening, setOpening] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [previews, setPreviews] = useState<OperationPreview[]>([])
  const [previewRun, setPreviewRun] = useState<{ source: string; heading: string; scope: string; cases: string; hasRun: boolean; error: string; checkedAt?: string; runAt?: string } | null>(null)
  const [pending, setPending] = useState<{ operation: Operation, items: ActionRequest[], selectedCount: number, skipped: Receipt[], modelChange?: boolean } | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [receiptHistory, setReceiptHistory] = useState<Receipt[]>([])
  const [actionDialog, setActionDialog] = useState<Operation | null>(null)
  const [creating, setCreating] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const createDialog = useRef<HTMLDialogElement>(null)
  const actionOpener = useRef<HTMLElement | null>(null)
  const createOpener = useRef<HTMLElement | null>(null)
  const [form, setForm] = useState<{ name: string; source: string; port: string; access_mode: 'authenticated' | 'anonymous'; identity_mode: 'development' | 'published' }>({ name: '', source: '', port: '', access_mode: 'anonymous', identity_mode: 'development' })
  const [businessGatewayAvailable, setBusinessGatewayAvailable] = useState(false)
  const [sources, setSources] = useState<SourceOption[]>([])
  const [agents, setAgents] = useState<AgentOption[]>([])
  const [models, setModels] = useState<ModelList | null>(null)
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState('')
  const [createModelDraft, setCreateModelDraft] = useState<ModelSelection | null | undefined>(undefined)
  const [instanceModelEdit, setInstanceModelEdit] = useState<{ name: string; base: ModelSelection | null; selection: ModelSelection | null } | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const [sourceRun, setSourceRun] = useState<{ source: string; loading: boolean; error: string; latest: SourceRun | null; checkedAt?: string } | null>(null)
  const [sourceRunRefresh, setSourceRunRefresh] = useState(0)
  const [agentSearch, setAgentSearch] = useState('')
  const [selectedAgent, setSelectedAgent] = useState('')
  const [advancedSource, setAdvancedSource] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailTab, setDetailTab] = useState<typeof detailTabs[number]['id']>('overview')
  const [detailNotice, setDetailNotice] = useState('')
  const [sourceCopyNotice, setSourceCopyNotice] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [logs, setLogs] = useState('')
  const [logsError, setLogsError] = useState('')
  const [embedUrl, setEmbedUrl] = useState('')
  const [embedMessage, setEmbedMessage] = useState('')
  const embedRequest = useRef(0)
  const listRequest = useRef(0)
  const currentListRead = useRef<{ request: number; promise: Promise<InstanceRow[]> } | null>(null)
  const detailRequest = useRef(0)
  const detailName = useRef<string | undefined>(undefined)
  const sourceRequest = useRef(0)
  const sourceRunRequest = useRef(0)
  const modelRequest = useRef(0)
  const detailSection = useRef<HTMLElement>(null)
  const detailNoticeSection = useRef<HTMLDivElement>(null)
  const detailOpener = useRef<HTMLElement | null>(null)
  const focusDetail = useRef(false)
  const lastPreselectedSource = useRef('')
  const lastTargetPage = useRef<PlatformNavigation['page'] | undefined>(undefined)
  const embedCode = embedUrl ? `<iframe\n  src="${embedUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"\n  title="DSH 智能体"\n  style="width: 100%; height: 700px; border: 0;"\n  allow="clipboard-write"\n></iframe>` : ''

  const visible = useMemo(() => instances.filter(item => (!sourceFilter || item.source_id === sourceFilter) && (filter === 'all' || (filter === 'existing' ? item.state !== 'absent' : item.state === filter)) && `${item.name} ${item.agent_id ?? ''} ${item.source_id ?? ''}`.toLowerCase().includes(query.toLowerCase())), [instances, filter, query, sourceFilter])
  const visibleSelected = visible.filter(item => selected.has(item.name)).length
  const sourceById = useMemo(() => new Map(sources.map(item => [item.source_id, item])), [sources])
  const agentName = (id?: string) => agents.find(item => item.id === id)?.name || id || '未记录智能体'
  const sourceLabel = (id?: string) => {
    if (!id) return '未记录来源'
    const source = sourceById.get(id)
    return source ? `${agentName(source.agent_id)} · ${source.experiment_id}` : id
  }
  const chosenSource = sourceById.get(form.source)
  const currentSourceRun = sourceRun?.source === form.source ? sourceRun : null
  const latestSourceRun = currentSourceRun?.latest
  const sourceRunCounts = latestSourceRun?.case_counts
  const sourceRunResult = !chosenSource?.selectable ? 'unavailable'
    : currentSourceRun?.loading || !currentSourceRun ? 'pending'
      : currentSourceRun.error ? 'pending'
        : latestSourceRun?.status === 'completed' && latestSourceRun.effective_verdict === 'passed' ? 'passed'
          : latestSourceRun?.status === 'failed' || latestSourceRun?.status === 'completed' && latestSourceRun.effective_verdict === 'failed' ? 'failed' : 'pending'
  const sourceRunHeading = !chosenSource?.selectable ? `${chosenSource?.experiment_id} 当前不可用`
    : currentSourceRun?.loading || !currentSourceRun ? '正在核对最近评测…'
      : currentSourceRun.error ? '最近评测读取失败'
        : !latestSourceRun ? '此版本尚无评测记录'
          : latestSourceRun.status === 'failed' ? '最近评测执行失败'
            : latestSourceRun.status === 'cancelled' ? '最近评测已取消'
              : latestSourceRun.status === 'running' ? '最近评测运行中'
                : latestSourceRun.status === 'planned' ? '最近评测待运行'
                  : latestSourceRun.status !== 'completed' ? '最近评测状态待核对'
                    : latestSourceRun.effective_verdict === 'passed' ? '最近评测通过'
              : latestSourceRun.effective_verdict === 'failed' ? '最近评测未通过'
                : latestSourceRun.effective_verdict === 'inconclusive' ? '最近评测无法判定' : '最近评测结论待核对'
  const sourceRunScope = latestSourceRun?.case_scope || '未记录验证范围'
  const sourceRunCases = sourceRunCounts ? `${sourceRunCounts.passed} 通过 / ${sourceRunCounts.failed} 未通过 / ${sourceRunCounts.inconclusive} 无法判定${sourceRunCounts.mixed ? ` / ${sourceRunCounts.mixed} 结果不一致` : ''}${sourceRunCounts.pending ? ` / ${sourceRunCounts.pending} 未记录结果` : ''}` : '逐例结果未记录'
  const sourceFieldError = form.source && sourcesLoaded && !chosenSource ? '该版本的装载声明不可用，请重新选择。'
    : chosenSource && selectedAgent && chosenSource.agent_id !== selectedAgent ? '所选来源不属于当前智能体，请重新选择。'
      : chosenSource && !chosenSource.selectable ? chosenSource.reason : ''
  const createAllowed = models?.business_allowed ?? []
  const globalDefault = models?.business_default
  const createModel = createModelDraft !== undefined ? createModelDraft
    : modelAllowed(createAllowed, globalDefault) ? globalDefault : null
  const createModelIssue = models && !modelError ? modelIssue(models.catalog, createAllowed, createModel) : modelError || '正在读取业务模型目录…'
  const instanceAllowed = models?.business_allowed ?? []
  const instanceCurrentModel = detail?.instance.model_policy?.default ?? null
  const activeModelEdit = instanceModelEdit?.name === detail?.instance.name ? instanceModelEdit : null
  const instanceEditIssue = activeModelEdit && models && !modelError ? modelIssue(models.catalog, instanceAllowed, activeModelEdit.selection) : modelError || '正在读取业务模型目录…'
  const instanceEditStale = Boolean(activeModelEdit && !sameModel(activeModelEdit.base, instanceCurrentModel))
  const filteredAgents = useMemo(() => {
    const byId = new Map(agents.map(item => [item.id, item]))
    for (const source of sources) if (source.agent_id && !byId.has(source.agent_id)) byId.set(source.agent_id, { id: source.agent_id })
    return [...byId.values()].filter(item => item.id === selectedAgent || `${item.name || ''} ${item.id}`.toLowerCase().includes(agentSearch.trim().toLowerCase()))
  }, [agents, sources, agentSearch, selectedAgent])
  const filteredSources = sources.filter(item => item.agent_id === selectedAgent)

  async function call<T>(endpoint: string, payload: unknown): Promise<T> {
    const result = await rpc.call(CHANNEL, `instances/${endpoint}`, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }

  async function loadSources() {
    const request = ++sourceRequest.current
    setSourceLoading(true)
    setSourceError('')
    const [sourceResult, agentResult] = await Promise.allSettled([
      call<{ sources: SourceOption[]; business_gateway_available?: boolean }>('sources', {}),
      rpc.call(CHANNEL, 'agents/list', {}).then(result => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value as { agents: AgentOption[] }
      }),
    ])
    if (request !== sourceRequest.current) return
    if (sourceResult.status === 'fulfilled') { setSources(sourceResult.value.sources); setBusinessGatewayAvailable(sourceResult.value.business_gateway_available === true); setSourcesLoaded(true) }
    else { setBusinessGatewayAvailable(false); setSourceError(sourceResult.reason instanceof Error ? sourceResult.reason.message : String(sourceResult.reason)) }
    if (agentResult.status === 'fulfilled') setAgents(agentResult.value.agents)
    setSourceLoading(false)
  }

  async function loadModels() {
    const request = ++modelRequest.current
    setModelLoading(true)
    setModelError('')
    try {
      const result = await rpc.call(CHANNEL, 'models/list', {})
      if (!result.ok) throw new Error(result.error.message)
      if (request === modelRequest.current) setModels(result.value as ModelList)
    } catch (err) {
      if (request === modelRequest.current) setModelError((err as Error).message)
    } finally {
      if (request === modelRequest.current) setModelLoading(false)
    }
  }

  async function refresh(background = false) {
    const request = ++listRequest.current
    setLoading(true)
    if (!background) setError('')
    const read = call<{ instances: InstanceRow[] }>('list', {}).then(data => data.instances)
    currentListRead.current = { request, promise: read }
    const newerRead = async () => {
      const latest = currentListRead.current
      if (!latest || latest.request <= request) return undefined
      const rows = await latest.promise.catch(() => undefined)
      return latest.request === listRequest.current ? rows : undefined
    }
    try {
      const rows = await read
      if (request !== listRequest.current) return await newerRead()
      setInstances(rows)
      setListLoaded(true)
      setLastListAt(new Date().toLocaleString())
      setRefreshError('')
      if (detailName.current) {
        if (rows.some(item => item.name === detailName.current)) void openDetail(detailName.current, true)
        else {
          detailRequest.current++
          embedRequest.current++
          setDetailLoading(false)
          setDetail(current => current ? { ...current, instance: { ...current.instance, state: 'unknown' } } : current)
          setDetailNotice(`所选实例 ${detailName.current} 的登记已不存在，请重新选择。`)
          setLogs('')
          setLogsError('')
          setEmbedUrl('')
          setEmbedMessage('')
        }
      }
      return rows
    } catch (err) {
      if (request === listRequest.current) setRefreshError((err as Error).message)
      else return await newerRead()
    } finally {
      if (request === listRequest.current) setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    void loadSources()
    void loadModels()
    return () => { listRequest.current++; detailRequest.current++; sourceRequest.current++; sourceRunRequest.current++; modelRequest.current++ }
  }, [])
  useEffect(() => {
    const source = sourceById.get(form.source)
    const request = ++sourceRunRequest.current
    if (!source) { setSourceRun(null); return }
    setSourceRun({ source: source.source_id, loading: true, error: '', latest: null })
    void rpc.call(CHANNEL, 'agents/runs/index', { agent_id: source.agent_id }).then(result => {
      if (request !== sourceRunRequest.current) return
      if (!result.ok) throw new Error(result.error.message)
      const entries = (result.value as { experiments?: { experiment_id: string; runs?: SourceRun[] }[] }).experiments
        ?.find(item => item.experiment_id === source.experiment_id)?.runs ?? []
      const latest = [...entries].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] ?? null
      setSourceRun({ source: source.source_id, loading: false, error: '', latest, checkedAt: new Date().toISOString() })
    }).catch(error => {
      if (request === sourceRunRequest.current) setSourceRun({ source: source.source_id, loading: false, error: (error as Error).message, latest: null, checkedAt: new Date().toISOString() })
    })
    return () => { sourceRunRequest.current++ }
  }, [form.source, sources, sourceRunRefresh])
  useEffect(() => updates?.subscribe(() => {
    const domains = updates.getSnapshot().domains
    if (domains.includes('instances')) void refresh(true)
    if (domains.some(domain => ['agents', 'catalog'].includes(domain))) {
      void loadSources()
      void loadModels()
      if (detailName.current) void openDetail(detailName.current, true)
    }
  }), [updates])
  useEffect(() => {
    const entering = lastTargetPage.current !== 'instances'
    lastTargetPage.current = target?.page
    if (target?.page !== 'instances' || !target.source_id || (!entering && target.source_id === lastPreselectedSource.current)) return
    lastPreselectedSource.current = target.source_id
    setCreating(true)
    setForm(current => ({ ...current, source: target.source_id! }))
    setSelectedAgent(target.agent_id || sourceById.get(target.source_id)?.agent_id || '')
    setCreateModelDraft(undefined)
    setAgentSearch('')
  }, [target?.page, target?.source_id, target?.agent_id])
  useEffect(() => {
    const source = sourceById.get(form.source)
    if (source && !selectedAgent) setSelectedAgent(source.agent_id)
  }, [sources, form.source, selectedAgent])
  useEffect(() => {
    if (target?.page !== 'instances') return
    const name = target.instance_name
    if (!name) {
      if (detailName.current) closeDetail(true)
      return
    }
    if (detailName.current !== name) void openDetail(name, false, true)
    const tab = detailTabs.find(item => item.id === target.tab)?.id
    if (tab) setDetailTab(tab)
  }, [target?.page, target?.instance_name, target?.tab])
  useEffect(() => {
    if (!focusDetail.current || loading || detailLoading) return
    const section = detail ? detailSection.current : detailNotice ? detailNoticeSection.current : null
    if (!section) return
    focusDetail.current = false
    section.scrollIntoView?.({ block: 'start' })
    section.focus?.({ preventScroll: true })
  }, [detail, detailNotice, detailLoading, loading])
  useEffect(() => {
    onContext?.({ page: 'instances', instance_name: detail?.instance.name, selected_instances: [...selected] })
  }, [detail?.instance.name, selected, onContext])
  useEffect(() => {
    if (actionDialog) dialog.current?.showModal()
    else {
      dialog.current?.close()
      actionOpener.current?.focus?.({ preventScroll: true })
      actionOpener.current = null
    }
  }, [actionDialog])
  useEffect(() => {
    const element = createDialog.current
    if (!element) return
    if (creating && !actionDialog && !element.open) element.showModal()
    if ((!creating || actionDialog) && element.open) element.close()
    if (!creating && !actionDialog) {
      createOpener.current?.focus?.({ preventScroll: true })
      createOpener.current = null
    }
  }, [creating, actionDialog])
  useEffect(() => {
    if (!selectedAgent || agentSearch || !agents.length) return
    const agent = agents.find(item => item.id === selectedAgent)
    if (agent) setAgentSearch(agent.name && agent.name !== agent.id ? `${agent.name} · ${agent.id}` : agent.id)
  }, [agents, selectedAgent, agentSearch])

  function closeAction() {
    setActionDialog(null)
    setPreviews([])
    setPreviewRun(null)
    setPending(null)
  }

  function updateForm(next: typeof form) {
    setForm(next)
    setPreviews([])
    setPending(null)
  }

  function createRequest(): ActionRequest {
    return {
      operation: 'create',
      name: form.name,
      source: form.source,
      port: form.port ? Number(form.port) : undefined,
      business_control: true,
      access_mode: form.access_mode,
      identity_mode: form.identity_mode,
      ...(createModel ? { model_selection: createModel } : {}),
    }
  }

  async function prepare(operation: Operation, names: string[], modelSelection?: ModelSelection) {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) actionOpener.current = document.activeElement
    setActionDialog(operation)
    setReceipts([])
    setActionPhase('preview')
    setError('')
    setPreviews([])
    setPreviewRun(operation === 'create' ? { source: form.source, heading: sourceRunHeading, scope: sourceRunScope, cases: sourceRunCases, hasRun: Boolean(latestSourceRun), error: currentSourceRun?.error || '', checkedAt: currentSourceRun?.checkedAt, runAt: latestSourceRun?.created_at } : null)
    setPending(null)
    try {
      const items: ActionRequest[] = operation === 'create'
        ? [createRequest()]
        : names.map(name => ({ operation, name, ...(modelSelection ? { model_selection: modelSelection } : {}) }))
      const results: OperationPreview[] = items.length === 1
        ? [{ name: items[0].name, operation, ok: true, value: await call<OperationPreview['value']>('preview', items[0]) }]
        : (await call<{ previews: OperationPreview[] }>('batch-preview', { items })).previews
      const frozen: ActionRequest[] = []
      const skipped: Receipt[] = []
      const shown = results.map((result, index) => {
        const item = items[index]
        if (!result.ok || !result.value) {
          skipped.push({ ...item, ok: false, status: 'not_dispatched', error: { message: result.error?.message || '预览失败' } })
          return result
        }
        const source = result.value.plan?.source_id ?? result.value.source_id
        if (typeof source !== 'string' || !source || (operation === 'create' && source !== item.source)) {
          const message = operation === 'create' ? '实际预览来源与所选来源不一致，请重新选择。' : '预览缺少实例来源，请刷新后重新预览。'
          skipped.push({ ...item, ok: false, status: 'not_dispatched', error: { message } })
          return { ...result, ok: false, error: { message } }
        }
        const plannedPort = result.value.plan?.port
        if (['create', 'start', 'restart'].includes(operation) && (typeof plannedPort !== 'number' || !Number.isInteger(plannedPort) || plannedPort < 1 || plannedPort > 65535)) {
          const message = '预览缺少有效端口，请重新预览；本项不会执行。'
          skipped.push({ ...item, ok: false, status: 'not_dispatched', error: { message } })
          return { ...result, ok: false, error: { message } }
        }
        if (['create', 'start', 'restart'].includes(operation)) {
          const selected = result.value.model_selection
          const hash = result.value.model_policy_hash
          if (!selected || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash) || (item.model_selection && !sameModel(item.model_selection, selected))) {
            const message = '预览未确认所选模型及配置摘要，请重新预览；本项不会执行。'
            skipped.push({ ...item, ok: false, status: 'not_dispatched', error: { message } })
            return { ...result, ok: false, error: { message } }
          }
          const business = result.value.plan?.business_control as { source_digest?: unknown } | undefined
          const sourceDigest = business?.source_digest
          if ((operation === 'create' || business) && (typeof sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(sourceDigest))) {
            const message = '预览缺少受控实例来源摘要，请重新预览；本项不会执行。'
            skipped.push({ ...item, ok: false, status: 'not_dispatched', error: { message } })
            return { ...result, ok: false, error: { message } }
          }
          frozen.push({ ...item, model_selection: selected, expected_model_policy_hash: hash, expected_source_id: source,
            ...(typeof sourceDigest === 'string' ? { expected_source_digest: sourceDigest } : {}), port: plannedPort as number })
        } else if (operation === 'stop') {
          const state = result.value.observed_state
          if (!state || state === 'unknown' || !result.value.observed_at) {
            const message = '预览缺少当前实例状态，请重新预览；本项不会执行。'
            skipped.push({ ...item, ok: false, status: 'not_dispatched', error: { message } })
            return { ...result, ok: false, error: { message } }
          }
          frozen.push({ ...item, expected_source_id: source, expected_state: state })
        } else frozen.push({ ...item, expected_source_id: source })
        return result
      })
      setPreviews(shown)
      if (frozen.length) setPending({ operation, items: frozen, selectedCount: items.length, skipped, modelChange: Boolean(modelSelection) })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setActionPhase(null)
    }
  }

  async function execute() {
    if (!pending) return
    setActionPhase('execute')
    setError('')
    setPreviews([])
    const all: Receipt[] = [...pending.skipped]
    setReceipts(all)
    let stoppedAfterUnknown = false
    try {
      const concurrency = pending.operation === 'delete' ? 5 : 1
      for (let offset = 0; offset < pending.items.length; offset += concurrency) {
        const group = pending.items.slice(offset, offset + concurrency)
        const results = await Promise.all(group.map(async item => {
          try {
            const receipt = await call<Receipt>('run', item)
            if (receipt.name !== item.name || receipt.operation !== item.operation) {
              return { ...item, ok: false, status: 'unknown' as const, error: { message: '操作回执目标与提交目标不一致，执行结果待核对。' } }
            }
            return { ...receipt, port: item.port, model_selection: item.model_selection, status: receipt.ok ? 'success' as const : /未知|未确认|无法确认|查询失败|无法复查/.test(receipt.error?.message || '') ? 'unknown' as const : 'failed' as const }
          } catch (err) {
            return { ...item, ok: false, status: 'unknown' as const, error: { message: `回执未收到，执行结果未知；请刷新核对。${(err as Error).message}` } }
          }
        }))
        all.push(...results)
        setReceipts([...all])
        if (results.some(result => result.status === 'unknown')) {
          for (const item of pending.items.slice(offset + group.length)) all.push({ ...item, ok: false, status: 'not_dispatched', error: { message: '前项结果未知，本项未派发。' } })
          stoppedAfterUnknown = true
          break
        }
      }
    } finally {
      const checking = all.map(item => item.status === 'success' ? { ...item, registration: { status: 'checking' as const } } : item)
      setReceipts(checking)
      setPending(null)
      if (pending.operation === 'create') setCreating(false)
      setActionPhase('readback')
      const observed = await refresh()
      const checked = checkRegistrations(checking, observed)
      setReceipts(checked)
      setReceiptHistory(current => [...checked, ...current])
      if (pending.modelChange && all.some(item => item.name === pending.items[0]?.name && item.status === 'success')) {
        const target = pending.items[0]
        const registered = observed?.find(item => item.name === target.name)?.model_policy?.default
        if (target.model_selection && registered && sameModel(registered, target.model_selection)) setInstanceModelEdit(current => current?.name === target.name ? null : current)
        else setError('已收到实例启动回执，但尚未从实例登记核对到所选默认模型。请刷新详情与实例状态后再判断是否生效。')
      }
      if (stoppedAfterUnknown) setError('部分目标结果未知或未派发。请先刷新核对各实例，再对明确需要的目标重新预览。')
      setActionPhase(null)
    }
  }

  function checkRegistrations(items: Receipt[], observed?: InstanceRow[]): Receipt[] {
    const checkedAt = new Date().toISOString()
    return items.map(item => {
      if (item.status !== 'success') return item
      const row = observed?.find(entry => entry.name === item.name)
      return {
        ...item,
        registration: observed ? {
          status: 'verified' as const,
          observed: row ?? null,
          checked_at: row?.observed_at || checkedAt,
        } : { status: 'unknown' as const, checked_at: checkedAt },
      }
    })
  }

  async function retryRegistrationReadback() {
    const prior = receipts
    const checking = prior.map(item => item.registration ? { ...item, registration: { status: 'checking' as const } } : item)
    setReceipts(checking)
    setActionPhase('readback')
    const observed = await refresh()
    const checked = checkRegistrations(checking, observed)
    setReceipts(checked)
    setReceiptHistory(current => current.map(item => {
      const index = prior.indexOf(item)
      return index < 0 ? item : checked[index]
    }))
    const modelTarget = prior.find(item => item.status === 'success' && item.model_selection && item.name === instanceModelEdit?.name)
    const registeredModel = modelTarget && observed?.find(item => item.name === modelTarget.name)?.model_policy?.default
    if (modelTarget?.model_selection && registeredModel && sameModel(registeredModel, modelTarget.model_selection)) {
      setInstanceModelEdit(current => current?.name === modelTarget.name ? null : current)
      setError(current => current.startsWith('已收到实例启动回执，但尚未从实例登记核对') ? '' : current)
    }
    setActionPhase(null)
  }

  async function openDetail(name: string, background = false, fromRoute = false, opener?: HTMLElement) {
    const request = ++detailRequest.current
    const previousName = detailName.current
    detailName.current = name
    if (!background) {
      if (previousName !== name || !detail) setInstanceModelEdit(null)
      if (opener) detailOpener.current = opener
      focusDetail.current = true
      embedRequest.current++
      setDetail(null)
      setDetailTab(fromRoute && detailTabs.some(item => item.id === target?.tab) ? target!.tab as typeof detailTabs[number]['id'] : 'overview')
      setLogs('')
      setLogsError('')
      setEmbedUrl('')
      setEmbedMessage('')
      setSourceCopyNotice('')
      if (!fromRoute) onNavigate?.({ page: 'instances', instance_name: name, tab: 'overview', ...(sourceFilter ? { experiment_id: sourceFilter.slice('experiment:'.length) } : {}) })
    }
    setDetailLoading(true)
    if (!background) setError('')
    try {
      const [nextDetail, nextLogs] = await Promise.all([
        call<Detail>('detail', { name }),
        call<{ logs: string }>('logs', { name, tail: 200 }).then(value => ({ logs: value.logs, error: '' }), err => ({ logs: '', error: (err as Error).message })),
      ])
      if (request !== detailRequest.current || name !== detailName.current) return
      setDetail(nextDetail)
      setDetailNotice('')
      setLogs(nextLogs.logs)
      setLogsError(nextLogs.error)
    } catch (err) {
      if (request === detailRequest.current) {
        setDetailNotice((err as Error).message)
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false)
    }
  }

  function closeDetail(fromRoute = false) {
    detailRequest.current++
    embedRequest.current++
    detailName.current = undefined
    setDetail(null)
    setInstanceModelEdit(null)
    setDetailLoading(false)
    setDetailNotice('')
    setError('')
    setLogs('')
    setLogsError('')
    setEmbedUrl('')
    setEmbedMessage('')
    setSourceCopyNotice('')
    if (!fromRoute) onNavigate?.({ page: 'instances', ...(sourceFilter ? { experiment_id: sourceFilter.slice('experiment:'.length) } : {}) })
    detailOpener.current?.focus?.({ preventScroll: true })
    detailOpener.current?.scrollIntoView?.({ block: 'nearest' })
    detailOpener.current = null
  }

  function selectDetailTab(tab: typeof detailTabs[number]['id']) {
    setDetailTab(tab)
    if (detailName.current) onNavigate?.({ page: 'instances', instance_name: detailName.current, tab, ...(sourceFilter ? { experiment_id: sourceFilter.slice('experiment:'.length) } : {}) })
  }

  async function webUrl(name: string) {
    const result = await call<{ url: string, lan_access: boolean }>('url', { name })
    return instanceWebUrl(result, window.location.hostname)
  }

  async function generateEmbed(name: string) {
    const request = ++embedRequest.current
    setEmbedUrl('')
    setEmbedMessage('正在读取实例地址…')
    try {
      const url = await webUrl(name)
      if (request !== embedRequest.current) return
      setEmbedUrl(url)
      setEmbedMessage('将以下代码粘贴到网站的 HTML 中。')
    } catch (err) {
      if (request === embedRequest.current) setEmbedMessage((err as Error).message)
    }
  }

  async function copyEmbed() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(embedCode)
      else {
        const input = document.createElement('textarea')
        input.value = embedCode
        document.body.appendChild(input)
        input.select()
        try { if (!document.execCommand('copy')) throw new Error('copy failed') } finally { input.remove() }
      }
      setEmbedMessage('嵌入代码已复制。')
    } catch { setEmbedMessage('浏览器未允许复制，请手动复制下面的代码。') }
  }

  async function copySourceId(sourceId: string) {
    try {
      await navigator.clipboard.writeText(sourceId)
      setSourceCopyNotice('来源 ID 已复制。')
    } catch {
      setSourceCopyNotice('复制失败，请手动选取来源 ID。')
    }
  }

  async function openWeb(name: string) {
    const tab = window.open('about:blank', '_blank')
    if (!tab) {
      setError('浏览器阻止了新标签页，请允许弹出窗口后重试。')
      return
    }
    tab.opener = null
    tab.document.title = '正在打开 DSH Web'
    tab.document.body.textContent = '正在获取实例访问地址…'
    setOpening(current => new Set(current).add(name))
    setError('')
    try {
      const url = await webUrl(name)
      if (!tab.closed) tab.location.replace(url)
    } catch (err) {
      tab.close()
      setError((err as Error).message)
    } finally {
      setOpening(current => { const next = new Set(current); next.delete(name); return next })
    }
  }

  const selectedNames = [...selected]
  const missingSelections = selectedNames.filter(name => !instances.some(item => item.name === name))
  const containerCount = instances.filter(item => ['running', 'stopped', 'failed'].includes(item.state ?? '')).length
  const absentCount = instances.filter(item => item.state === 'absent').length
  const unknownCount = instances.length - containerCount - absentCount
  const detailReceipts = receiptHistory.filter(item => item.name === detail?.instance.name)
  const needsRegistrationReadback = receipts.some(item => item.registration?.status === 'unknown'
    || item.registration?.status === 'verified' && !registrationMatchesReceipt(item))

  function registrationMatchesReceipt(item: Receipt) {
    const observed = item.registration?.observed
    if (item.registration?.status !== 'verified') return false
    if (item.operation === 'delete') return !observed
    if (!observed) return false
    if (item.requested_source_id && observed.source_id !== item.requested_source_id) return false
    return item.operation === 'stop' ? observed.state === 'absent' : observed.state === 'running'
  }

  function receiptItems(items: Receipt[]) {
    return <div className="instance-receipt-items">{items.map((item, index) => {
      const status = item.status || (item.ok ? 'success' : 'failed')
      const registration = item.registration
      const command = item.value && typeof item.value === 'object' ? (item.value as { value?: Record<string, unknown> }).value : undefined
      return <div key={`${item.operation}-${item.name}-${index}`} className={status === 'success' ? 'instance-receipt-ok' : 'instance-receipt-bad'}>
        <strong>{item.name}</strong> · {labels[item.operation]} · {status === 'success' ? '成功' : status === 'failed' ? '失败' : status === 'unknown' ? '结果未知，请刷新核对' : '未派发'}
        {item.error?.message && <div>{item.error.message}</div>}
        {status === 'failed' && item.port && <div>请核对当前端口和实例状态，重新预览后再执行。</div>}
        {item.port && <div className="instance-muted">{registration?.observed?.business_gateway ? '内部 Runtime ' : ''}预览端口：{item.port}；执行回执端口：{typeof command?.port === 'number' ? command.port : '尚未确认'}</div>}
        {item.model_selection && <div className="instance-muted">提交默认模型：{modelLabel(models?.catalog, item.model_selection)}；当前实例登记与实际模型调用请分别核对。</div>}
        {item.requested_source_id && <div className="instance-muted">提交来源：<code>{item.requested_source_id}</code>；当前登记来源{registration?.checked_at ? `（核对于 ${new Date(registration.checked_at).toLocaleString('zh-CN')}）` : ''}：{registration?.status === 'checking' ? '正在核对…' : registration?.status === 'unknown' ? '未知，登记读取未完成' : registration?.status === 'verified' ? registration.observed?.source_id ? <code>{registration.observed.source_id}</code> : registration.observed ? '登记未记录来源' : '未找到此实例登记' : '等待操作完成后核对'}{registration?.status === 'verified' && registration.observed && `；登记状态：${stateLabels[registration.observed.state || 'unknown'] || '状态待核对'}`}</div>}
        {status === 'success' && !item.requested_source_id && registration && <div className="instance-muted">当前登记状态{registration.checked_at ? `（核对于 ${new Date(registration.checked_at).toLocaleString('zh-CN')}）` : ''}：{registration.status === 'checking' ? '正在核对…' : registration.status === 'unknown' ? '未知，登记读取未完成' : registration.observed ? stateLabels[registration.observed.state || 'unknown'] || '状态待核对' : '未找到此实例登记'}{registration.status === 'verified' && registration.observed?.source_id && <>；登记来源：<code>{registration.observed.source_id}</code></>}</div>}
        {status === 'success' && registration?.status === 'unknown' && <div role="alert">操作回执已成功，但当前实例登记未知。请重新读取登记核对；不会再次执行操作。</div>}
        {status === 'success' && registration?.status === 'verified' && !registrationMatchesReceipt(item) && <div role="alert">操作回执已成功，但当前登记与本次操作预期不一致。请重新读取登记核对。</div>}
        {status === 'success' && item.operation === 'create' && registration?.status === 'verified' && registration.observed?.business_gateway && <div className="instance-muted">已登记网关入口：{registration.observed.access_url ? <code>{registration.observed.access_url}</code> : '尚未核对，请刷新实例登记'}；{registration.observed.access_mode === 'anonymous' ? '无需登录' : '需要个人登录'}；{registration.observed.identity_mode === 'development' ? '开发调试，不要求发布身份签名' : '对外服务，验证智能体身份签名'}。</div>}
      </div>
    })}</div>
  }

  return (
    <main className="harness-instances-page" aria-label="实例管理">
      <style>{instanceTheme}</style>
      <header className="harness-page-heading instance-page-heading">
        <div><h1>实例管理</h1><p>核对登记来源和容器状态，查看访问入口、日志与操作回执。</p><div className="instance-summary-stats">{listLoaded ? <>{containerCount} 个容器实例 · {absentCount} 个无容器登记{unknownCount > 0 && ` · ${unknownCount} 个状态未知`}{refreshError && ' · 上次读取结果，当前状态待核对'}</> : loading ? '正在读取实例…' : '实例状态尚未读取'}</div></div>
        <button type="button" className="harness-primary" aria-haspopup="dialog" aria-expanded={creating} aria-controls="instance-create" disabled={busy} onClick={event => { createOpener.current = event.currentTarget; void loadModels(); void loadSources(); setCreating(true) }}>新建实例</button>
      </header>
      <dialog ref={createDialog} id="instance-create" aria-labelledby="instance-create-title" className="instance-dialog instance-create-dialog" onCancel={event => { event.preventDefault(); setCreating(false) }}>
        {creating && !actionDialog && <>
        <header className="instance-dialog-heading instance-create-heading"><div><h2 id="instance-create-title">创建业务实例</h2><p>通过可读名称选择来源，再查看创建预览。</p></div><button type="button" onClick={() => setCreating(false)} className="instance-dialog-close" aria-label="关闭创建实例">×</button></header>
        <div className="instance-dialog-content instance-create-content">
        <div className="instance-source-picker" aria-label="选择实例来源">
          {sourceError && <p role="alert" className="instance-error">来源读取失败：{sourceError}</p>}
          <label className="instance-field">来源智能体<input aria-label="来源智能体" list="instance-agent-options" value={agentSearch} onChange={event => {
            const typed = event.target.value
            setAgentSearch(typed)
            const matching = agents.filter(agent => [agent.id, agent.name, agent.name && `${agent.name} · ${agent.id}`].includes(typed))
            const next = matching.length === 1 ? matching[0].id : ''
            if (next !== selectedAgent) { setSelectedAgent(next); updateForm({ ...form, source: '' }) }
          }} placeholder="输入智能体名称或 ID 检索" autoComplete="off" className="instance-field-input" />
            <datalist id="instance-agent-options">{filteredAgents.map(agent => <option key={agent.id} value={agent.name && agent.name !== agent.id ? `${agent.name} · ${agent.id}` : agent.id} />)}</datalist>
            <span className="instance-field-hint">{selectedAgent ? `已选择 · Agent ID：${selectedAgent}` : '输入名称检索，再选择对应智能体。'}</span></label>
          <label className="instance-field">来源版本<select aria-label="选择来源版本" value={form.source && filteredSources.some(item => item.source_id === form.source) ? form.source : ''} onChange={event => updateForm({ ...form, source: event.target.value })} className="instance-field-input">
            <option value="">请选择已登记版本</option>{filteredSources.map(source => <option key={source.source_id} value={source.source_id} disabled={!source.selectable}>{source.experiment_id}{source.selectable ? '' : ` · 不可用：${source.reason}`}</option>)}
          </select></label>
          {selectedAgent && sourcesLoaded && !sourceLoading && !sources.some(item => item.agent_id === selectedAgent && item.selectable) && <p role="status" className="instance-muted">此智能体没有可用的装载版本。请检查该版本的装载声明与 Candidate 目录。</p>}
          {chosenSource && <div className="instance-source-verdict" data-state={sourceRunResult} role="status"><strong>{sourceRunHeading}</strong><span>{chosenSource.experiment_id} · {latestSourceRun?.title || chosenSource.reason}</span><span>验证范围：{currentSourceRun?.error ? '读取失败，请到评测中心核对' : sourceRunScope}{latestSourceRun && ` · ${sourceRunCases}`}</span>{currentSourceRun?.error && <span>读取原因：{currentSourceRun.error}。</span>}{currentSourceRun?.checkedAt && <span>{latestSourceRun?.created_at && `Run 记录于 ${new Date(latestSourceRun.created_at).toLocaleString('zh-CN')} · `}{currentSourceRun.error ? '读取尝试于' : '核对于'} {new Date(currentSourceRun.checkedAt).toLocaleString('zh-CN')}</span>}<button type="button" className="instance-button" disabled={currentSourceRun?.loading} onClick={() => setSourceRunRefresh(value => value + 1)}>重新核对评测</button><span>创建实例不代表业务验证通过。</span></div>}
          {sourceFieldError && <p role="alert" className="instance-error">{sourceFieldError}</p>}
        </div>
        <label className="instance-field">实例名称<input aria-label="实例名" placeholder="例如 my-agent" value={form.name}
          onChange={event => updateForm({ ...form, name: event.target.value })} className="instance-field-input" /></label>
        <p className="instance-field-hint">此工作区的业务实例经统一网关访问，使用独立 HOME 与实例专属地址；已开放原生定时任务，任务到期按实例和会话的当前许可执行。</p>
        {sourcesLoaded && !businessGatewayAvailable && <div role="alert" className="instance-error">业务网关未启用或配置不完整，暂时无法创建业务实例。请核对数据目录 config/business-access.json 并启动网关，再重新检查；已填写内容会保留。<button type="button" className="instance-button" disabled={sourceLoading} onClick={() => void loadSources()}>{sourceLoading ? '检查中…' : '重新检查网关'}</button></div>}
        <label className="instance-field">实例阶段<select aria-label="实例阶段" value={form.identity_mode} onChange={event => updateForm({ ...form, identity_mode: event.target.value as 'development' | 'published' })} className="instance-field-input">
          <option value="development">开发调试 · 不要求发布身份签名</option><option value="published">对外服务 · 验证智能体身份签名</option>
        </select><span className="instance-field-hint">开发调试仍经统一网关；对外服务时再启用智能体身份验证。</span></label>
        <label className="instance-field">访问方式<select aria-label="访问方式" value={form.access_mode} onChange={event => updateForm({ ...form, access_mode: event.target.value as 'authenticated' | 'anonymous' })} className="instance-field-input">
          <option value="authenticated">经过网关，需要登录</option><option value="anonymous">经过网关，无需认证（共享数据和会话）</option>
        </select><span className="instance-field-hint">无需登录时，所有访问者共享此实例的历史会话、任务与工作区数据。未发布实例不做风险评估，网关全部放行。</span></label>
        <div className="instance-create-model" aria-label="设置新实例默认模型">
          <div className="instance-create-model-heading"><strong>此实例默认模型</strong>{modelError && <button type="button" className="instance-button" disabled={modelLoading} onClick={() => void loadModels()}>{modelLoading ? '读取中…' : '刷新模型'}</button>}</div>
          <p className="instance-field-hint">预选“设置 → 模型”的业务统一默认；此实例也可另选已配置模型。</p>
          {modelError && <p role="alert" className="instance-model-warning">模型目录读取失败：{modelError}。请刷新模型后再预览。</p>}
          {models && <ModelChoice catalog={models.catalog} allowed={createAllowed} value={createModel || null} label="新实例默认模型" onChange={selection => { setCreateModelDraft(selection); setPreviews([]); setPending(null) }} />}
          {createModelIssue && !modelError && <p role="status" className="instance-model-warning">{createModelIssue}</p>}
        </div>
        <details className="instance-create-advanced"><summary>高级设置 · 端口与来源表达式</summary><div className="instance-create-advanced-body"><label className="instance-field">内部 Runtime 端口（可选）<input aria-label="端口" placeholder="留空从 18500–28999 自动分配" value={form.port}
          onChange={event => updateForm({ ...form, port: event.target.value })} className="instance-field-input" /></label><button type="button" className="instance-source-advanced" aria-expanded={advancedSource} onClick={() => setAdvancedSource(value => !value)}>{advancedSource ? '收起来源表达式' : '手动输入来源表达式'}</button>
          {advancedSource && <label className="instance-field">来源表达式<input aria-label="来源" placeholder="experiment:EXP-..." value={form.source} onChange={event => {
            const source = event.target.value.trim()
            updateForm({ ...form, source })
            const agent = sourceById.get(source)?.agent_id
            if (agent && agent !== selectedAgent) { setSelectedAgent(agent); setAgentSearch(agentName(agent)) }
          }} className="instance-field-input" /></label>}</div></details>
        <p className="instance-create-impact">将创建独立实例；现有业务实例不会因创建操作而停止或切换版本。</p>
        </div>
        <footer className="instance-dialog-actions"><button type="button" onClick={() => setCreating(false)} className="instance-button">取消</button><button type="button" className="harness-primary" disabled={busy || !businessGatewayAvailable || !form.name || !form.source || Boolean(sourceFieldError) || sourceLoading || modelLoading || Boolean(createModelIssue) || !currentSourceRun || currentSourceRun.loading} onClick={() => prepare('create', [])}>查看创建预览</button></footer>
        </>}
      </dialog>
      <section aria-label="实例筛选" className="instance-filter-panel">
        {sourceFilter && <div className="instance-source-filter"><span>关联来源：{sourceFilter}</span><button type="button" onClick={() => { setSourceFilter(''); onNavigate?.({ page: 'instances' }) }}>查看全部实例</button></div>}
        <div className="instance-filter-row">
          <label className="instance-search-field">搜索<input aria-label="搜索实例" placeholder="搜索实例名或智能体 ID" value={query} onChange={event => setQuery(event.target.value)} className="instance-field-input" /></label>
          <label className="instance-filter-field">状态<select aria-label="状态筛选" value={filter} onChange={event => setFilter(event.target.value)} className="instance-field-input">
            <option value="existing">现有容器</option><option value="all">全部登记</option>
            <option value="running">运行中</option><option value="stopped">已停止</option>
            <option value="absent">无容器（仅登记）</option><option value="failed">异常</option><option value="unknown">状态未知</option>
          </select></label>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="instance-button">{loading ? '读取中…' : '刷新'}</button>
          <span className="instance-filter-count" role="status">{listLoaded ? `${visible.length} 个业务实例${refreshError ? ' · 上次读取' : ''}` : '实例状态待读取'}</span>
        </div>
        {selectedNames.length > 0 && <div aria-label="批量操作" className="instance-batch-bar">
          <strong>已选择 {selected.size} 个</strong>
          {selected.size > visibleSelected && <span className="instance-muted">其中 {selected.size - visibleSelected} 个不在当前列表</span>}
          {(['start', 'stop', 'restart', 'delete'] as Operation[]).map(operation => <button key={operation} type="button" disabled={busy || missingSelections.length > 0}
            onClick={() => prepare(operation, selectedNames)} className="instance-button">{labels[operation]}</button>)}
          <button type="button" disabled={busy} onClick={() => setSelected(new Set())} className="instance-button">取消选择</button>
          {missingSelections.length > 0 && <span role="status" className="instance-selection-notice">{missingSelections.length} 个所选登记已不存在。<button type="button" onClick={() => setSelected(current => new Set([...current].filter(name => !missingSelections.includes(name))))}>清除失效选择</button></span>}
        </div>}
      </section>

      {error && !actionDialog ? <div role="alert" className="instance-error">{error}</div> : null}
      {refreshError && <div role="alert" className="instance-error">实例列表读取失败：{refreshError}。{listLoaded ? `当前显示 ${lastListAt} 读取的列表，实例状态待核对。` : '当前无法确认是否有实例。'} <button type="button" className="instance-button" disabled={loading} onClick={() => void refresh()}>重新读取</button></div>}

      <section aria-label="实例列表" className="instance-list-panel">
        <div className="instance-table-wrap"><table className="instance-table">
          <colgroup><col style={{ width: 44 }}/><col style={{ width: '19%' }}/><col style={{ width: '13%' }}/><col style={{ width: '20%' }}/><col style={{ width: 100 }}/><col style={{ width: 170 }}/><col/></colgroup>
          <thead>
            <tr>
              <th className="instance-list-th">
                <input type="checkbox" aria-label="全选当前列表实例" disabled={loading || visible.length === 0}
                  checked={visible.length > 0 && visibleSelected === visible.length}
                  ref={element => { if (element) element.indeterminate = visibleSelected > 0 && visibleSelected < visible.length }}
                  onChange={event => setSelected(current => {
                    const next = new Set(current)
                    for (const item of visible) {
                      if (event.target.checked) next.add(item.name)
                      else next.delete(item.name)
                    }
                    return next
                  })} />
              </th>
              <th className="instance-list-th">实例名称</th><th className="instance-list-th">智能体</th><th className="instance-list-th">登记来源版本</th>
              <th className="instance-list-th">运行状态</th><th className="instance-list-th">访问入口</th><th className="instance-list-th">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(item => (
              <tr key={item.name} data-current={detail?.instance.name === item.name || undefined} data-selected={selected.has(item.name) || undefined}>
                <td className="instance-list-td instance-selection">
                  <input type="checkbox" aria-label={`选择实例 ${item.name}`} checked={selected.has(item.name)}
                    onChange={event => setSelected(current => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(item.name)
                      else next.delete(item.name)
                      return next
                    })} />
                </td>
                <td className="instance-list-td instance-name" data-label="实例名称">{item.name}</td>
                <td className="instance-list-td" data-label="智能体">{agentName(item.agent_id)}</td>
                <td className="instance-list-td instance-source" data-label="登记来源版本"><strong>{sourceById.get(item.source_id || '')?.experiment_id || item.source_id || '未记录来源'}</strong><small>实际装载须在目标 Session 核对</small></td>
                <td className="instance-list-td" data-label="运行状态"><span className="instance-state-badge" data-state={item.state}>{stateLabels[item.state ?? 'unknown'] || item.state}</span></td>
                <td className="instance-list-td" data-label="访问入口">
                  <button type="button" disabled={item.state !== 'running' || !item.port || opening.has(item.name)}
                    onClick={() => openWeb(item.name)} className="instance-button"
                    title={item.state !== 'running' ? '实例运行后可访问' : item.business_gateway ? item.access_mode === 'anonymous' ? '经业务网关打开；无需登录' : '经业务网关打开；需要业务用户登录' : item.lan_access ? '在新标签页打开' : '仅宿主机浏览器可访问'}>
                    {opening.has(item.name) ? '正在打开…' : '打开 Web'}
                  </button>
                  <div className="instance-muted instance-access-note">{item.state !== 'running' ? '实例运行后可访问' : !item.port ? '未记录端口' : item.business_gateway ? `${item.identity_mode === 'development' ? '开发调试' : '对外服务'} · 经统一网关 · ${item.access_mode === 'anonymous' ? '无需登录' : '需个人登录'}` : !item.lan_access ? '仅宿主机' : null}</div>
                  {item.business_gateway && <div className="instance-muted instance-access-note">{item.access_url || '网关深链尚未核对'}</div>}
                </td>
                <td className="instance-list-td" data-label="操作"><div className="instance-actions">
                  <button type="button" onClick={event => openDetail(item.name, false, false, event?.currentTarget)} disabled={detailLoading} className="instance-button">详情</button>
                  {(item.state === 'running' ? ['stop', 'restart'] : item.state === 'stopped' || item.state === 'absent' ? ['start', 'delete'] : item.state === 'failed' ? ['start', 'stop'] : []).map(operation =>
                    <button type="button" key={operation} disabled={busy} onClick={() => prepare(operation as Operation, [item.name])} className="instance-button">{labels[operation as Operation]}</button>)}
                  {item.state === 'unknown' && <span>观察失败，请刷新</span>}
                </div></td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={7} className="instance-empty-list">{loading && !listLoaded ? '正在读取实例…' : !listLoaded ? '实例列表尚未读取，请重新读取。' : instances.length === 0 ? '暂无实例。点击右上角“新建实例”开始创建。' : '没有符合当前筛选条件的实例。请调整状态或搜索内容。'}</td></tr>}
          </tbody>
        </table></div>
        <div className="instance-list-heading"><strong>实例列表</strong><span className="instance-muted">{listLoaded ? `共 ${visible.length} 条记录${refreshError ? '（上次读取）' : ''} · 运行状态不代表业务验证通过` : '等待读取实例状态'}</span></div>
      </section>

      {detailLoading && !detail && <p role="status">正在读取实例详情…</p>}
      {!detail && !detailLoading && detailName.current && detailNotice && <div ref={detailNoticeSection} tabIndex={-1} role="alert" className="instance-error instance-detail-route-notice">{detailNotice} <button type="button" className="instance-button" onClick={() => closeDetail()}>返回实例列表</button></div>}
      {detail ? (
        <section ref={detailSection} tabIndex={-1} className="harness-instance-detail instance-panel" aria-label="实例详情">
          <header className="instance-detail-header">
            <div className="instance-heading-content"><small className="instance-muted">实例详情</small><div className="instance-detail-title">
              <h2>{detail.instance.name}</h2>
              <span className="instance-state-badge" data-state={detail.instance.state}>{stateLabels[detail.instance.state ?? 'unknown'] || detail.instance.state}</span>
            </div></div>
            <div className="instance-actions">
              <button type="button" className="harness-primary" disabled={detail.instance.state !== 'running' || !detail.instance.port || opening.has(detail.instance.name)} onClick={() => void openWeb(detail.instance.name)}>{opening.has(detail.instance.name) ? '正在打开…' : '访问 DSH Web'}</button>
              <button type="button" className="instance-button" disabled={detailLoading} onClick={() => void openDetail(detail.instance.name, true)}>{detailLoading ? '刷新中…' : '刷新详情'}</button>
              <button type="button" className="instance-button" onClick={() => closeDetail()}>关闭详情</button>
            </div>
          </header>
          {detailNotice && <p role="alert" className="instance-detail-notice">{detailNotice}</p>}
          {(detail.instance.state === 'failed' || detail.instance.state === 'unknown') && <p role="alert" className="instance-detail-notice">实例状态异常，请先查看运行日志，再决定是否停止或删除。</p>}
          <div role="tablist" aria-label="实例详情" className="instance-detail-tabs" onKeyDown={event => {
            const index = detailTabs.findIndex(item => item.id === detailTab)
            const next = event.key === 'ArrowRight' ? (index + 1) % detailTabs.length : event.key === 'ArrowLeft' ? (index + detailTabs.length - 1) % detailTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : undefined
            if (next === undefined) return
            event.preventDefault()
            selectDetailTab(detailTabs[next].id)
            document.getElementById(`instance-tab-${detailTabs[next].id}`)?.focus()
          }}>{detailTabs.map(item => <button key={item.id} id={`instance-tab-${item.id}`} type="button" role="tab" aria-selected={detailTab === item.id} aria-controls={`instance-panel-${item.id}`} tabIndex={detailTab === item.id ? 0 : -1} onClick={() => selectDetailTab(item.id)} className="instance-detail-tab">{item.label}</button>)}</div>

          <section id="instance-panel-overview" role="tabpanel" aria-labelledby="instance-tab-overview" hidden={detailTab !== 'overview'} className="instance-detail-body">
            <dl className="instance-detail-grid">
              <div className="instance-fact"><dt className="instance-muted">实例登记来源</dt><dd className="instance-fact-value"><strong>{sourceLabel(detail.instance.source_id)}</strong><br/><code>{detail.instance.source_id || '未记录来源 ID'}</code>{detail.instance.source_id && <button type="button" className="instance-button instance-copy-id" onClick={() => void copySourceId(detail.instance.source_id!)}>复制来源 ID</button>}{sourceCopyNotice && <small role="status">{sourceCopyNotice}</small>}</dd></div>
              <div className="instance-fact"><dt className="instance-muted">登记默认模型</dt><dd className="instance-fact-value"><strong>{modelLabel(models?.catalog, instanceCurrentModel)}</strong>{instanceCurrentModel?.reasoningEffort && <small>推理档位：{instanceCurrentModel.reasoningEffort}</small>}<small>来自本实例登记，当前 Session 的实际模型需单独核对。</small></dd></div>
              {[
                ['智能体', detail.instance.agent_id || '未记录'],
                [detail.instance.business_gateway ? '内部 Web 端口' : '访问端口', detail.instance.port || '未记录'],
                ...(detail.instance.business_gateway ? [['实例阶段', detail.instance.identity_mode === 'development' ? '开发调试，不要求发布身份签名' : '对外服务，验证智能体身份签名'], ['访问方式', detail.instance.access_mode === 'anonymous' ? '经过网关，无需认证（共享数据和会话）' : '经统一网关，需要个人登录'], ['已登记网关入口', detail.instance.access_url || '尚未核对，请刷新实例登记']] : []),
                ['登记镜像', detail.instance.image_tag || '未记录'],
                ['登记镜像 ID', detail.instance.image_id || '未记录'],
                ['HOME 存储', String(detail.instance.home_directory || detail.session_scope.home_volume || detail.instance.home_volume || '未记录')],
                ['HOME 保留状态', detail.session_scope.preserved === true ? '已保留' : detail.session_scope.preserved === false ? '未保留' : '尚未确认'],
              ].map(([label, value]) => <div key={label} className="instance-fact"><dt className="instance-muted">{label}</dt><dd className="instance-fact-value">{value}</dd></div>)}
            </dl>
            <p className="instance-muted">容器状态来自当前观察；来源和镜像为实例登记记录。当前 Session 的实际装载需通过运行观察核对。</p>
            <div className="instance-model-panel" aria-label="管理实例默认模型">
              <div className="instance-source-heading"><strong>实例模型设置</strong><button type="button" className="instance-button" aria-expanded={Boolean(activeModelEdit)} disabled={!['running', 'stopped', 'absent'].includes(detail.instance.state || '')} onClick={() => {
                if (activeModelEdit) setInstanceModelEdit(null)
                else {
                  void loadModels()
                  setInstanceModelEdit({ name: detail.instance.name, base: instanceCurrentModel, selection: modelAllowed(instanceAllowed, instanceCurrentModel) ? instanceCurrentModel : modelAllowed(instanceAllowed, models?.business_default) ? models!.business_default : null })
                }
              }}>{activeModelEdit ? '取消更改' : '更改默认模型'}</button></div>
              {activeModelEdit ? <>
                <p className="instance-muted">从已配置的业务模型中选择。确认后将{detail.instance.state === 'running' ? '重启' : '启动'}实例，新 Session 才使用新默认模型；已有 Session 的模型不会在此处自动切换。</p>
                {models && <ModelChoice catalog={models.catalog} allowed={instanceAllowed} value={activeModelEdit.selection} label="实例默认模型" onChange={selection => setInstanceModelEdit(current => current?.name === detail.instance.name ? { ...current, selection } : current)} />}
                {instanceEditStale && <p role="alert" className="instance-model-warning">此实例的登记默认模型已变化。请取消更改并重新核对。</p>}
                {instanceEditIssue && <p role="status" className="instance-model-warning">{instanceEditIssue}</p>}
                {sameModel(activeModelEdit.selection, instanceCurrentModel) && !instanceEditStale && <p role="status" className="instance-muted">当前选择与本实例登记相同。</p>}
                <div className="instance-model-actions"><button type="button" className="instance-button" disabled={modelLoading} onClick={() => void loadModels()}>{modelLoading ? '读取中…' : '刷新可用模型'}</button><button type="button" className="harness-primary" disabled={busy || modelLoading || Boolean(instanceEditIssue) || instanceEditStale || sameModel(activeModelEdit.selection, instanceCurrentModel)} onClick={() => void prepare(detail.instance.state === 'running' ? 'restart' : 'start', [detail.instance.name], activeModelEdit.selection!)}>预览并{detail.instance.state === 'running' ? '重启' : '启动'}</button></div>
              </> : <p className="instance-muted">本实例沿用自己的登记默认模型；修改统一默认模型不会改变已登记实例。</p>}
              {!['running', 'stopped', 'absent'].includes(detail.instance.state || '') && <p className="instance-model-warning">当前状态无法安全确认更改操作，请刷新或先处理实例状态。</p>}
            </div>
            <div className="instance-session-note"><strong>会话与数据</strong><p>{detail.session_scope.note || '未记录会话说明。'}</p></div>
            <details className="instance-detail-fold"><summary className="instance-fold-title">挂载配置 · {Object.keys(detail.instance.mounts || {}).length} 项</summary>
              {Object.keys(detail.instance.mounts || {}).length ? <div className="instance-mount-scroll"><table className="instance-mount-table"><thead><tr><th className="instance-th">用途</th><th className="instance-th">来源路径</th><th className="instance-th">权限</th></tr></thead><tbody>{Object.entries(detail.instance.mounts || {}).map(([name, path]) => {
                const mode = detail.instance.mount_modes?.[name]
                return <tr key={name}><td className="instance-td">{name}</td><td className="instance-td instance-path">{path}</td><td className="instance-td">{mode === 'ro' ? '只读' : mode === 'rw' ? '读写' : mode || '未记录'}</td></tr>
              })}</tbody></table></div> : <p className="instance-muted">暂无挂载配置。</p>}
            </details>
            <details className="instance-detail-fold"><summary className="instance-fold-title">来源版本的运行记录 · {detail.runs.length} 条</summary>
              {detail.runs.length ? <ul className="instance-run-list">{detail.runs.map(run => <li key={run.id} className="instance-run-item">
                {onNavigate ? <button type="button" className="instance-run-link" onClick={() => onNavigate({ page: 'evaluation', run_id: run.id, agent_id: detail.instance.agent_id })}>{run.id}</button> : <code>{run.id}</code>}
                <small className="instance-muted instance-path">{run.path}</small>
              </li>)}</ul> : <p className="instance-muted">此来源版本暂无运行记录。</p>}
            </details>
          </section>

          <section id="instance-panel-embed" role="tabpanel" aria-labelledby="instance-tab-embed" hidden={detailTab !== 'embed'} className="instance-detail-body">
            <div className="instance-embed-heading"><div><h3 className="instance-section-title">将智能体嵌入网站</h3><p className="instance-muted">生成 iframe 代码，粘贴到网站的 HTML 中即可展示此实例。</p></div>
              <button type="button" className="instance-button" disabled={detail.instance.state !== 'running' || !detail.instance.port} onClick={() => void generateEmbed(detail.instance.name)}>{embedCode ? '重新生成代码' : '生成 iframe 代码'}</button>
            </div>
            {(detail.instance.state !== 'running' || !detail.instance.port) && <p role="status">实例运行且记录{detail.instance.business_gateway ? '内部 Runtime 端口' : '访问端口'}后，才可生成嵌入代码。</p>}
            {embedCode ? <div className="instance-code-box"><div className="instance-code-heading"><span>HTML 嵌入代码</span><button type="button" className="instance-button" onClick={() => void copyEmbed()}>复制嵌入代码</button></div><pre className="instance-embed-code">{embedCode}</pre></div> : <div className="instance-embed-empty">点击“生成 iframe 代码”，获取使用此实例实际访问地址的代码。</div>}
            {embedMessage && <p role="status" className="instance-muted">{embedMessage}</p>}
            <details className="instance-detail-fold"><summary className="instance-fold-title">使用须知</summary><ul className="instance-embed-notes">
              <li>网站访问者需要能连接到实例地址。供其他电脑访问时，使用局域网可达的地址；127.0.0.1 只指访问者自己的电脑。</li>
              <li>{detail.instance.business_gateway ? detail.instance.access_mode === 'anonymous' ? '无需认证时所有访问者共享此实例的数据和会话，无需登录或访客 Cookie；统一网关提供访问入口。' : '业务访问仍经统一网关，需要个人登录；跨站嵌入受浏览器 Cookie 限制，可同站点嵌入或直接打开网关入口。' : '嵌入沿用实例自身的登录设置，不会自动传递平台登录状态。跨站登录受浏览器 Cookie 限制时，可使用同站点反向代理或直接打开 DSH Web。'}</li>
              <li>HTTPS 网站需使用 HTTPS 实例入口，网站的 CSP 也需要允许该 iframe 来源。</li>
            </ul></details>
          </section>

          <section id="instance-panel-logs" role="tabpanel" aria-labelledby="instance-tab-logs" hidden={detailTab !== 'logs'} className="instance-detail-body">
            <h3 className="instance-section-title">运行日志</h3><p className="instance-muted">最近 200 行。点击右上角“刷新详情”获取最新日志。</p>
            {logsError ? <p role="alert" className="instance-error">日志读取失败：{logsError}</p> : <pre role="log" aria-label="实例运行日志" aria-live="off" tabIndex={0} className="instance-log-content">{logs || '暂无日志。'}</pre>}
          </section>
          <section id="instance-panel-receipts" role="tabpanel" aria-labelledby="instance-tab-receipts" hidden={detailTab !== 'receipts'} className="instance-detail-body">
            <h3 className="instance-section-title">本页操作回执</h3>
            <p className="instance-muted">仅展示本次打开页面期间对此实例确认过的操作。刷新页面后不保留；实例当前状态请重新读取核对。</p>
            {detailReceipts.length ? receiptItems(detailReceipts) : <p role="status">本页尚无此实例的操作回执。</p>}
          </section>
        </section>
      ) : null}

      <dialog ref={dialog} aria-labelledby="instance-action-title" className="instance-dialog"
        onCancel={event => { if (actionDialogLocked) event.preventDefault(); else closeAction() }}>
        {actionDialog && <>
        <header className="instance-dialog-heading instance-action-heading"><div><h2 id="instance-action-title">{actionDialog === 'create' ? '确认创建业务实例' : actionDialog === 'stop' ? '停止业务实例？' : `${actionDialog && labels[actionDialog]}业务实例`}</h2><p>{actionDialog === 'create' ? '核对来源、影响对象和验证范围后再执行。' : actionDialog === 'stop' ? '这是对业务实例的操作，不会取消独立的评测任务。' : '核对目标和实际影响，再确认执行。'}</p></div><button type="button" className="instance-dialog-close" aria-label="关闭操作预览" disabled={actionDialogLocked} onClick={closeAction}>×</button></header>
        <div className="instance-dialog-content">
        {actionPhase && <p role="status">{actionPhase === 'preview' ? '正在读取操作预览…' : actionPhase === 'execute' ? `正在执行：已收到 ${receipts.filter(item => item.status !== 'not_dispatched').length} / ${pending?.items.length ?? 0} 项回执` : '操作回执已收到，正在读取实例登记；请勿重复提交操作。'}</p>}
        {error && <div role="alert" className="instance-error">{error}</div>}
        {previews.length ? <section aria-label="操作预览">
          {!(previews.length === 1 && ['create', 'stop'].includes(actionDialog || '')) && <><p className="instance-preview-summary">共选择 {previews.length} 项 · 可确认 {pending?.items.length || 0} 项 · 预览失败 {previews.filter(item => !item.ok).length} 项</p><p className="instance-muted">确认只会派发下方可确认的目标。来源、模型与启动端口沿用本次预览；配置变化或端口占用时，本项会失败并提示重新预览。</p></>}
          <div className="instance-preview-items">{previews.map(item => {
            const value = item.value
            const plan = value?.plan
            const source = plan?.source_id ?? value?.source_id
            const port = plan?.port ?? value?.port
            const retention = value?.retention
            const observed = instances.find(instance => instance.name === item.name)
            const runForPreview = previewRun?.source === source ? previewRun : null
            const businessCreate = item.operation === 'create' && (value?.access_mode === 'anonymous' || value?.access_mode === 'authenticated')
            const agentId = sourceById.get(String(source))?.agent_id
            const plannedGatewayPath = businessCreate && agentId ? `/agents/${agentId}/instances/${item.name}/` : ''
            const singleReference = previews.length === 1 && (item.operation === 'create' || item.operation === 'stop')
            return <article key={`${item.operation}-${item.name}`} className={`instance-preview-item${singleReference ? ' instance-reference-preview' : ''}`} data-ok={item.ok}>
              {!singleReference && <h3>{item.name} <span className="instance-muted">· {labels[item.operation]}</span></h3>}
              {!item.ok ? <p role="alert" className="instance-error">预览失败，本项不会执行：{item.error?.message || '未知原因'}</p> : singleReference ? <>
                <div className="instance-reference-card"><h3>{item.name}</h3>
                <dl className="instance-preview-facts">
                  <div><dt>{item.operation === 'create' ? '来源智能体' : '智能体'}</dt><dd>{sourceById.get(String(source))?.agent_id ? agentName(sourceById.get(String(source))!.agent_id) : agentName(observed?.agent_id)}</dd></div>
                  <div><dt>{item.operation === 'create' ? '来源版本' : '登记来源版本'}</dt><dd>{typeof source === 'string' ? sourceLabel(source) : '未确认'}</dd></div>
                  <div><dt>{item.operation === 'create' ? '运行方式' : '本次预览状态'}</dt><dd>{item.operation === 'create' ? '新增一个独立的本地实例' : <>{stateLabels[value?.observed_state || ''] || '状态待核对'}{value?.observed_at && <small className="instance-muted">观察于 {new Date(value.observed_at).toLocaleString('zh-CN')}</small>}</>}</dd></div>
                  {item.operation === 'create' && <div><dt>验证范围</dt><dd>{runForPreview && !runForPreview.error ? runForPreview.scope : '读取失败，请到评测中心核对'}{runForPreview && !runForPreview.error && <small className="instance-muted">{runForPreview.hasRun ? '最近 Run：' : '评测记录：'}{runForPreview.heading}{runForPreview.hasRun && ` · ${runForPreview.cases}`}{runForPreview.runAt && ` · 记录于 ${new Date(runForPreview.runAt).toLocaleString('zh-CN')}`}{runForPreview.checkedAt && ` · 核对于 ${new Date(runForPreview.checkedAt).toLocaleString('zh-CN')}`}</small>}</dd></div>}
                  {item.operation === 'create' && <div><dt>实例默认模型</dt><dd>{modelLabel(models?.catalog, value?.model_selection)}</dd></div>}
                  {item.operation === 'create' && businessCreate && <div><dt>实例阶段</dt><dd>{value?.identity_mode === 'published' ? '对外服务 · 验证智能体身份签名' : '开发调试 · 不要求发布身份签名'}</dd></div>}
                  {item.operation === 'create' && <div><dt>访问方式</dt><dd>{value?.access_mode === 'anonymous' ? '经过网关，无需认证（共享数据和会话）' : value?.access_mode === 'authenticated' ? '经统一网关，需要个人登录' : '按实例配置'}</dd></div>}
                  <div><dt>{item.operation === 'create' ? businessCreate ? '内部 Runtime 端口' : '访问端口' : '影响入口'}</dt><dd>{item.operation === 'create' ? typeof port === 'number' ? `127.0.0.1:${port}` : '未确认' : observed?.business_gateway ? observed.access_url || '网关深链尚未核对' : observed?.port ? `127.0.0.1:${observed.port}` : '未确认'}</dd></div>
                </dl></div>
                {item.operation === 'stop' && <div className="instance-preview-warning" role="note"><strong>业务访问将中断</strong><span>进行中的业务请求可能终止，需要再次启动后恢复访问。</span></div>}
                <div className="instance-preview-impact"><h4>{item.operation === 'create' ? '执行后的影响' : '数据与任务影响'}</h4><ul>{item.operation === 'create' ? <>
                  <li>{businessCreate ? <>创建成功并完成登记后，经统一网关路径 <code>{plannedGatewayPath || '待登记核对'}</code> 访问；{value?.access_mode === 'anonymous' ? '无需登录' : '需要个人登录'}。</> : <>新增独立业务访问入口{typeof port === 'number' ? ` 127.0.0.1:${port}` : '，端口以执行回执为准'}。</>}</li>
                  <li>现有 {instances.filter(instance => instance.state === 'running').length} 个运行中业务实例保持当前状态。</li>
                  <li>创建不代表业务验证通过；请按来源版本的评测范围核对结果。</li>
                </> : <>
                  <li>{retention?.registration === '保留' && retention?.home === '保留' ? '保留实例配置和 HOME 数据。' : `实例配置：${retention?.registration || '待回执核对'}；HOME 数据：${retention?.home || '待回执核对'}。`}</li>
                  <li>已有运行记录：{retention?.runs || '待回执核对'}；来源版本不会因停止实例而删除。</li>
                  <li>独立评测任务不在本次停止范围内。</li>
                </>}</ul></div>
              </> : <dl>
                <div><dt>目标</dt><dd>{item.name}</dd></div>
                <div><dt>登记来源</dt><dd>{typeof source === 'string' ? <>{sourceLabel(source)}<br/><code>{source}</code></> : '未确认'}</dd></div>
                <div><dt>本次变化</dt><dd>{impacts[item.operation]}</dd></div>
                {['create', 'start', 'restart'].includes(item.operation) && <div><dt>默认模型</dt><dd>{modelLabel(models?.catalog, value?.model_selection)}{value?.model_selection?.reasoningEffort ? ` · 推理档位 ${value.model_selection.reasoningEffort}` : ''}<small className="instance-muted">应用到本次实例启动配置；已有 Session 需另行核对。</small></dd></div>}
                <div><dt>{observed?.business_gateway ? '内部 Runtime 端口' : '访问端口'}</dt><dd>{typeof port === 'number' ? port : '未确认或不适用'}</dd></div>
                {observed?.business_gateway && <div><dt>网关入口</dt><dd>{observed.access_url || '网关深链尚未核对'}；{observed.access_mode === 'anonymous' ? '无需登录' : '需要个人登录'}</dd></div>}
                <div><dt>保留</dt><dd>{retention ? `HOME：${retention.home || '未确认'}；Session：${retention.sessions || '未确认'}；来源：${retention.source || '未确认'}；Run：${retention.runs || '未确认'}` : '未确认'}</dd></div>
                <div><dt>登记处置</dt><dd>{retention?.registration || '未确认'}</dd></div>
              </dl>}
              <details className="instance-preview-technical"><summary>技术详情 · {singleReference ? '操作参数' : '预览参数'}</summary><pre className="instance-pre">{JSON.stringify(item, null, 2)}</pre></details>
            </article>
          })}</div>
        </section> : null}
        {receipts.length ? <section aria-live="polite" aria-label="操作回执">
          <strong>操作回执：成功 {receipts.filter(item => item.status === 'success' || (!item.status && item.ok)).length} 项，失败 {receipts.filter(item => item.status === 'failed').length} 项，结果未知 {receipts.filter(item => item.status === 'unknown').length} 项，未派发 {receipts.filter(item => item.status === 'not_dispatched').length} 项</strong>
          {receiptItems(receipts)}
          {needsRegistrationReadback && <button type="button" className="instance-button" disabled={busy} onClick={() => void retryRegistrationReadback()}>重新读取实例登记</button>}
        </section> : null}
        </div>
        <footer className="instance-dialog-actions">
          <button type="button" disabled={actionDialogLocked} onClick={closeAction} className="instance-button">{pending?.operation === 'create' ? '返回修改' : pending?.operation === 'stop' ? '保持运行' : pending ? '取消' : '关闭'}</button>
          {previews.length && pending ? <button type="button" onClick={execute} disabled={busy} className={pending.operation === 'stop' ? 'instance-danger-button' : 'harness-primary'}>{pending.items.length === 1 && pending.operation === 'create' ? '确认创建' : pending.items.length === 1 && pending.operation === 'stop' ? '确认停止' : `确认${labels[pending.operation]} ${pending.items.length} 项`}</button> : null}
        </footer>
        </>}
      </dialog>
    </main>
  )
}
