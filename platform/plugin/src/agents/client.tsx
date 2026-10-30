import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueuedRefresh } from '../realtime/refresh.ts'
import { CHANNEL } from '../protocol.ts'
import type { PlatformNavigation, PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { instanceWebUrl } from '../instances/url.ts'
import { AssetDiffPanel } from './asset-diff-client.tsx'
import { CreateAgentDialog } from './create-agent-client.tsx'
import { ImportAgentDialog, type MigrationEntryTarget } from './import-agent-client.tsx'
import { ComputeVariantsPanel, canDeriveVersion, isVariantVersion } from './compute-variants.tsx'
import { VariantSourcePanel } from './variant-source.tsx'
import { AgentDescriptionPanel } from './description-client.tsx'
import { SearchSelect } from '../components/search-select.tsx'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { AgentEvaluationOverview, type AgentRunOverview } from './overview.tsx'
import { DeploymentDialog } from '../deployment/client.tsx'

type RpcResult = { ok: true; value: any } | { ok: false; error: { code: string; message: string; details?: any } }
type AgentRow = { id: string; name?: string; manifest?: Record<string, any>; active_experiment?: string | null; version_count?: number; latest_experiment_status?: string | null; instance_state?: string }
type PreviewState = { path: string; body: string; before: string; diff: string; dry: any }
type AssetNode = { name: string; path: string; kind: string; children?: AssetNode[] }
type ExperimentRow = { id: string; agent_id: string; status?: string; is_variant?: boolean; derivable?: boolean; is_current?: boolean; change: Record<string, any> }
type ListView = NonNullable<PlatformNavigation['list_view']>
type RunOverview = AgentRunOverview

function isComputeVariant(experiment: ExperimentRow) {
  return isVariantVersion(experiment)
}

function generationLabel(experiment: ExperimentRow) {
  const mode = experiment.change?.compute_variant?.generation?.mode
  return mode === 'langgraph-aot' ? 'LangGraph 代码' : mode || '生成方式未记录'
}

function variantName(experiment: ExperimentRow) {
  return typeof experiment.change?.variant_name === 'string' && experiment.change.variant_name.trim()
    ? experiment.change.variant_name : '未命名变体'
}

function AssetTree({ nodes, selected, onSelect }: { nodes: AssetNode[]; selected: string; onSelect(path: string): void }) {
  return <ul className="harness-asset-tree">{nodes.map(node => <li key={node.path}>
    {node.children ? <details open={node.name === 'candidate' || selected.startsWith(node.path + '/')}><summary><button type="button" aria-pressed={selected === node.path} onClick={() => onSelect(node.path)}>{node.name}/</button></summary>
      <AssetTree nodes={node.children} selected={selected} onSelect={onSelect} /></details>
      : <button type="button" aria-pressed={selected === node.path} onClick={() => onSelect(node.path)}>{node.name}</button>}
  </li>)}</ul>
}
function containsAsset(nodes: AssetNode[], path: string): boolean {
  return nodes.some(node => node.path === path || Boolean(node.children && containsAsset(node.children, path)))
}

function Fields({ items }: { items: [string, unknown][] }) {
  return <dl className="harness-fields">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{Array.isArray(value) ? value.join('、') || '无' : typeof value === 'string' || typeof value === 'number' ? value : '未知'}</dd></div>)}</dl>
}

function researchStatus(status?: string | null) {
  return ({ active: '研究中', completed: '已完成研究', archived: '已归档', adopted: '已采纳', rejected: '已拒绝' } as Record<string, string>)[status ?? ''] ?? status ?? '状态未记录'
}

function versionLabel(id?: string | null) {
  if (!id) return '未记录'
  const number = /-(\d{3})(?:-r[0-9a-f]{12})?$/.exec(id)?.[1]
  return number ? `${id.startsWith('VAR-') ? '变体' : '版本'} ${number}` : id
}

const tabs = [
  { id: 'overview', label: '概览' },
  { id: 'description', label: '描述与技能' },
  { id: 'assets', label: 'Harness 资产' },
  { id: 'compute-variants', label: '算力变体' },
] as const

export function AgentsPage({ rpc, updates, onContext, onAssistant, target, onNavigate, active = true }: PlatformPageProps & { target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void; active?: boolean; updates?: PlatformUpdates; onContext?(context: Record<string, unknown>): void; onAssistant?(task: string, context: Record<string, unknown>): Promise<void> }) {
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [experiments, setExperiments] = useState<ExperimentRow[]>([])
  const [listPhase, setListPhase] = useState<'pending' | 'ready' | 'error'>('pending')
  const [listView, setListView] = useState<ListView>(target?.list_view ?? 'agents')
  const [mobileListOpen, setMobileListOpen] = useState(false)
  const [variantSearch, setVariantSearch] = useState('')
  const [variantAgent, setVariantAgent] = useState('')
  const [nameOpen, setNameOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [nameInitial, setNameInitial] = useState('')
  const [nameHash, setNameHash] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const [nameMessage, setNameMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [search, setSearch] = useState('')
  const [selectedExperiment, setSelectedExperiment] = useState('')
  const [tab, setTab] = useState<(typeof tabs)[number]['id']>('overview')
  const [detail, setDetail] = useState<any>(null)
  const [runOverview, setRunOverview] = useState<RunOverview | null>(null)
  const [error, setError] = useState('')
  const [editPath, setEditPath] = useState('')
  const [editBody, setEditBody] = useState('')
  const [editHash, setEditHash] = useState('')
  const [editPreview, setEditPreview] = useState<PreviewState | null>(null)
  const [editMessage, setEditMessage] = useState('')
  const [assetInfo, setAssetInfo] = useState<any>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editBusy, setEditBusy] = useState(false)
  const currentEdit = useRef({ path: editPath, open: editOpen })
  currentEdit.current = { path: editPath, open: editOpen }
  const appliedAssetTarget = useRef('')
  const editDialog = useRef<HTMLDialogElement>(null)
  const [versionOpen, setVersionOpen] = useState(false)
  const [versionGoal, setVersionGoal] = useState('')
  const derivable = detail && canDeriveVersion(detail.experiment) && detail.derivation?.derivable !== false
  const versionParent = derivable ? detail?.derivation?.parent_ref || '' : ''
  const [versionInventory, setVersionInventory] = useState<any>(null)
  const [versionProposal, setVersionProposal] = useState<any>(null)
  const [featureProposal, setFeatureProposal] = useState<any>(null)
  const [launch, setLaunch] = useState<any>(null)
  const [launchMessage, setLaunchMessage] = useState('')
  const [launchBusy, setLaunchBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [migrationTarget, setMigrationTarget] = useState<MigrationEntryTarget>()
  const [deploymentOpen, setDeploymentOpen] = useState(false)
  const [deploymentTarget, setDeploymentTarget] = useState<{ agent_id: string; experiment_id: string; label: string } | null>(null)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [descriptionVisited, setDescriptionVisited] = useState(false)
  const [qualityBusy, setQualityBusy] = useState(false)
  const [qualityMessage, setQualityMessage] = useState('')
  const publishDialog = useRef<HTMLDialogElement>(null)
  const publishOpener = useRef<HTMLElement | null>(null)
  const descriptionDirty = useRef(false)
  const detailRequest = useRef(0)
  const listRequest = useRef(0)
  const changedList = useRef(true)
  const selectionRequest = useRef(0)
  const versionPreviewRequest = useRef(0)
  const launchRequest = useRef(0)
  const launchBusyRef = useRef(false)
  const editRequest = useRef(0)
  const runOverviewRequest = useRef(0)
  const pendingReveal = useRef<'identity' | 'panel' | null>(null)
  const pendingListFocus = useRef(false)
  const keepTabFocus = useRef(false)
  const selectedAgent = useMemo(() => agents.find(agent => agent.id === selected), [agents, selected])
  const pendingSelectionNavigation = useRef(false)
  const navigation = useRef({ active, target, onNavigate, tab, listView })
  navigation.current = { active, target, onNavigate, tab, listView }

  function navigateSelection(agentId: string, experimentId: string | undefined, nextTab = tab, replace = false, nextListView = navigation.current.listView) {
    const current = navigation.current
    if (!current.active || !agentId || !experimentId) return
    const sameObject = agentId === selected && experimentId === (selectedExperiment || detail?.experiment?.id)
    const requested = current.target?.agent_id === agentId && current.target?.experiment_id === experimentId ? current.target.asset_path : undefined
    const pendingAsset = requested && appliedAssetTarget.current !== JSON.stringify([agentId, experimentId, requested])
    const asset = nextTab === 'assets' && sameObject ? pendingAsset ? requested : currentEdit.current.path || requested : undefined
    if (current.target?.page === 'agents' && current.target.agent_id === agentId
      && current.target.experiment_id === experimentId && current.target.tab === nextTab
      && current.target.asset_path === asset && (current.target.list_view ?? 'agents') === nextListView) return
    current.onNavigate?.({ page: 'agents', agent_id: agentId, experiment_id: experimentId, tab: nextTab, ...(asset ? { asset_path: asset } : {}), ...(nextListView === 'variants' ? { list_view: nextListView } : {}), ...(replace ? { replace: true } : {}) })
  }

  function selectListView(next: ListView) {
    setListView(next)
    navigation.current.listView = next
    const experimentId = detail?.experiment?.id || selectedExperiment
    if (selected && experimentId) navigateSelection(selected, experimentId, tab, false, next)
    else onNavigate?.({ page: 'agents', ...(selected ? { agent_id: selected } : {}), tab, ...(next === 'variants' ? { list_view: next } : {}) })
  }

  function showAgentVariants(agentId: string) {
    setVariantAgent(agentId)
    setVariantSearch('')
    selectListView('variants')
  }

  function revealSelection(kind: 'identity' | 'panel', nextTab = tab) {
    const element = document.getElementById(kind === 'identity' ? 'agent-identity' : `agent-panel-${nextTab}`)
    if (!element || element.hidden) return
    element.scrollIntoView?.({ block: 'start' })
    element.focus?.({ preventScroll: true })
  }

  function returnToList() {
    pendingListFocus.current = true
    setMobileListOpen(true)
  }

  function focusSelectedListEntry() {
    const entryId = listView === 'agents' ? `agent-list-card-${selected}` : `agent-variant-card-${selectedExperiment}`
    const element = document.getElementById(entryId) ?? document.getElementById(`agent-list-panel-${listView}`)
    element?.scrollIntoView?.({ block: 'start', inline: 'nearest' })
    element?.focus?.({ preventScroll: true })
  }

  function selectTab(nextTab: (typeof tabs)[number]['id'], reveal = true) {
    if (reveal) pendingReveal.current = 'panel'
    else keepTabFocus.current = true
    if (nextTab === 'description') setDescriptionVisited(true)
    setTab(nextTab)
    navigateSelection(selected, detail?.experiment?.id, nextTab)
    if (nextTab === tab && reveal) { pendingReveal.current = null; revealSelection('panel', nextTab) }
  }
  function openCode(path: string) {
    if (discardAssetDraft()) { selectEditFile(path); selectTab('assets') }
  }

  function selectVersion(agentId: string, experimentId = '', notify = true, detailTab?: (typeof tabs)[number]['id'], reveal?: 'identity' | 'panel') {
    setMoreActionsOpen(false)
    const showDetail = !!reveal || agentId !== selected || !!experimentId && experimentId !== selectedExperiment
    if (showDetail) setMobileListOpen(false)
    if (agentId === selected && (!experimentId || experimentId === selectedExperiment)) {
      if (detailTab) setTab(detailTab)
      if (notify) navigateSelection(agentId, detail?.experiment?.id, detailTab ?? tab)
      if (reveal) {
        if (mobileListOpen || detailTab && detailTab !== tab) pendingReveal.current = reveal
        else { pendingReveal.current = null; revealSelection(reveal, detailTab ?? tab) }
      }
      return true
    }
    if (!discardNameDraft() || !discardAssetDraft() || descriptionDirty.current && !window.confirm('当前版本资料有未保存修改。确认放弃草稿？')) return false
    descriptionDirty.current = false
    if (reveal) pendingReveal.current = reveal
    detailRequest.current++
    selectionRequest.current++
    runOverviewRequest.current++
    versionPreviewRequest.current++
    launchRequest.current++
    pendingSelectionNavigation.current = notify && !experimentId
    const nextTab = detailTab ?? (agentId !== selected ? 'overview' : tab)
    setTab(nextTab)
    setSelected(agentId)
    setSelectedExperiment(experimentId)
    setDetail(null)
    setNameOpen(false)
    setNameDraft('')
    setNameInitial('')
    setNameHash('')
    setNameBusy(false)
    setNameMessage('')
    setVersionOpen(false)
    setVersionInventory(null)
    setVersionProposal(null)
    setFeatureProposal(null)
    setLaunch(null)
    setLaunchMessage('')
    setDiffOpen(false)
    setPublishOpen(false)
    setDescriptionVisited(false)
    setQualityMessage('')
    setQualityBusy(false)
    setLaunchBusy(false)
    launchBusyRef.current = false
    selectEditFile('')
    if (notify && experimentId) navigateSelection(agentId, experimentId, nextTab)
    return true
  }

  function selectEditFile(path: string) {
    editRequest.current++
    currentEdit.current = { path, open: false }
    setEditPath(path)
    setEditBody('')
    setEditHash('')
    setEditPreview(null)
    setEditMessage('')
    setAssetInfo(null)
    setEditOpen(false)
  }

  async function call(operation: string, payload: Record<string, unknown> = {}) {
    const result = await rpc.call(CHANNEL, `agents/${operation}`, payload) as RpcResult
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  async function refreshList() {
    const request = ++listRequest.current
    setError('')
    setListPhase('pending')
    try {
      const value = await call('list')
      if (request !== listRequest.current) return
      setAgents(value.agents ?? [])
      setExperiments(value.experiments ?? [])
      setSelected(current => current || value.agents?.[0]?.id || '')
      setListPhase('ready')
    } catch (err) {
      if (request === listRequest.current) { setError((err as Error).message); setListPhase('error') }
    }
  }

  async function refreshDetail(agentId = selected, experimentId = selectedExperiment) {
    if (!agentId) return
    const request = ++detailRequest.current
    const owner = selectionRequest.current
    setError('')
    try {
      const payload = experimentId ? { agent_id: agentId, experiment_id: experimentId } : { agent_id: agentId }
      const value = await call('detail', payload)
      if (request !== detailRequest.current || owner !== selectionRequest.current) return
      setDetail(value)
      if (!experimentId) setSelectedExperiment(current => current || value.experiment.id)
      // 默认版本必须使用服务端实际解析结果，不能用登记版本填充地址。
      navigateSelection(agentId, value.experiment.id, navigation.current.tab, !pendingSelectionNavigation.current)
      pendingSelectionNavigation.current = false
      const editing = currentEdit.current
      const target = navigation.current.target
      const requested = target?.page === 'agents' && target.agent_id === agentId && target.experiment_id === value.experiment.id && target.tab === 'assets' ? target.asset_path : undefined
      if (!containsAsset(value.assets ?? [], editing.path) && !editing.open) selectEditFile(requested && containsAsset(value.assets ?? [], requested) ? requested : value.assets?.[0]?.path ?? '')
    } catch (err) {
      if (request === detailRequest.current && owner === selectionRequest.current) setError((err as Error).message)
    }
  }

  async function loadEditFile(path = editPath) {
    if (!detail || !path) return false
    const request = ++editRequest.current
    setError('')
    try {
      const value = await call('edit/read', { experiment_id: detail.experiment.id, path })
      if (request !== editRequest.current) return false
      setEditPath(value.path)
      setAssetInfo(value)
      setEditBody(value.content ?? '')
      setEditHash(value.sha256 ?? '')
      setEditPreview(null)
      setEditMessage('')
      return true
    } catch (err) {
      if (request === editRequest.current) setError((err as Error).message)
      return false
    }
  }

  function editVariantName() {
    const currentName = detail.experiment.change.variant_name ?? ''
    setNameDraft(currentName)
    setNameInitial(currentName)
    setNameHash(detail.experiment.change_sha256 ?? '')
    setNameMessage('')
    setNameOpen(true)
  }

  async function saveVariantName(recheck = false) {
    if (!detail || nameBusy) return
    const selection = selectionRequest.current
    const experimentId = detail.experiment.id, agentId = selected
    setNameBusy(true)
    setNameMessage('')
    try {
      if (recheck) {
        const value = await call('detail', { agent_id: agentId, experiment_id: experimentId })
        if (selection !== selectionRequest.current) return
        setNameHash(value.experiment.change_sha256)
        setNameMessage(`当前保存的名称为“${variantName(value.experiment)}”；输入草稿已保留，请核对后保存。`)
      } else {
        await call('compute-variants/rename', { experiment_id: experimentId, variant_name: nameDraft.trim(), expected_change_sha256: nameHash })
        await refreshList()
        if (selection !== selectionRequest.current) return
        await refreshDetail(agentId, experimentId)
        if (selection !== selectionRequest.current) return
        setNameOpen(false)
        setNameMessage('变体名称已保存。')
      }
    } catch (err) {
      if (selection === selectionRequest.current) setNameMessage(`${(err as Error).message}；名称草稿已保留，可重新核对后保存。`)
    } finally { if (selection === selectionRequest.current) setNameBusy(false) }
  }

  useEffect(() => { void refreshChanged() }, [selected, selectedExperiment])
  async function refreshRunOverview() {
    const experimentId = selectedExperiment || detail?.experiment?.id
    if (!selected || !experimentId) return
    const agentId = selected, request = ++runOverviewRequest.current
    setRunOverview(current => current?.agentId === agentId && current.experimentId === experimentId && current.phase === 'ready'
      ? { ...current, refreshing: true, refreshError: undefined }
      : { agentId, experimentId, phase: 'loading', runs: [] })
    await (async () => {
      try {
        const index = await call('runs/index', { agent_id: agentId })
        if (request !== runOverviewRequest.current) return
        if (!Array.isArray(index.experiments)) throw new Error('Run 索引格式不正确')
        const runs = [...(index.experiments.find((item: any) => (item.experiment_id ?? item.id) === experimentId)?.runs ?? [])]
          .sort((left: any, right: any) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))
        const latest = runs[0]
        if (!latest) {
          setRunOverview({ agentId, experimentId, phase: 'ready', runs })
          return
        }
        setRunOverview(current => {
          const sameScope = current?.agentId === agentId && current.experimentId === experimentId
          const sameRun = sameScope && (current.latest?.run_id ?? current.latest?.id) === (latest.run_id ?? latest.id)
          return { agentId, experimentId, phase: 'ready', runs, latest, refreshing: sameScope && current.refreshing,
            ...(sameRun && current.detail ? { detail: current.detail } : {}) }
        })
        try {
          const view = await call('runs/show', { run_id: latest.run_id ?? latest.id })
          if (request === runOverviewRequest.current) {
            const current = { ...latest, effective_verdict: view.summary?.effective_verdict ?? latest.effective_verdict }
            setRunOverview({ agentId, experimentId, phase: 'ready', runs, latest: current, detail: view })
          }
        } catch (error) {
          if (request === runOverviewRequest.current) setRunOverview(current => ({ agentId, experimentId, phase: 'ready', runs, latest, detailError: (error as Error).message,
            ...(current?.agentId === agentId && current.experimentId === experimentId && (current.latest?.run_id ?? current.latest?.id) === (latest.run_id ?? latest.id) && current.detail ? { detail: current.detail } : {}) }))
        }
      } catch (error) {
        if (request === runOverviewRequest.current) {
          setRunOverview(current => current?.agentId === agentId && current.experimentId === experimentId && current.phase === 'ready'
            ? { ...current, refreshing: false, refreshError: (error as Error).message }
            : { agentId, experimentId, phase: 'error', runs: [], error: (error as Error).message })
        }
      }
    })()
  }
  useEffect(() => {
    if (active) onContext?.({ page: 'agents', agent_id: selected || undefined, experiment_id: detail?.experiment?.id, tab })
  }, [active, selected, detail?.experiment?.id, tab, onContext])
  useEffect(() => {
    if (!active || !detail || target?.page !== 'agents' || target.tab !== 'assets' || !target.asset_path || target.agent_id !== selected || target.experiment_id !== detail.experiment.id) return
    const key = JSON.stringify([target.agent_id, target.experiment_id, target.asset_path])
    if (appliedAssetTarget.current === key) return
    appliedAssetTarget.current = key
    if (currentEdit.current.path === target.asset_path) return
    if (!containsAsset(detail.assets ?? [], target.asset_path)) { setError('当前版本的资产目录中没有此路径，请重新选择文件。'); return }
    if (!discardAssetDraft()) { navigateSelection(selected, detail.experiment.id, 'assets', true); return }
    selectEditFile(target.asset_path)
  }, [active, detail?.experiment?.id, detail?.assets, target?.page, target?.tab, target?.agent_id, target?.experiment_id, target?.asset_path, selected])
  useEffect(() => { if (!active) setMoreActionsOpen(false) }, [active])
  useEffect(() => {
    if (!active || !target || target.page !== 'agents') return
    if (!pendingReveal.current && target.tab && (target.tab !== tab || !detail)) pendingReveal.current = 'panel'
    if (target.tab && target.tab !== tab) setMobileListOpen(false)
    if (target.agent_id && !selectVersion(target.agent_id, target.experiment_id, false)) {
      // 浏览器已更新地址；用户保留草稿时同步恢复当前对象与标签。
      navigateSelection(selected, detail?.experiment?.id, tab, true)
      return
    }
    const nextTab = target.tab === 'capabilities' ? 'description' : target.tab === 'runtime' ? 'overview' : tabs.find(item => item.id === target.tab)?.id ?? 'overview'
    if (keepTabFocus.current) keepTabFocus.current = false
    const nextListView = target.list_view ?? 'agents'
    setTab(nextTab)
    setListView(nextListView)
    navigation.current.listView = nextListView
    if ((!target.agent_id || target.agent_id === selected)
      && (!target.experiment_id || target.experiment_id === selectedExperiment)) {
      navigateSelection(selected, detail?.experiment?.id, nextTab, true, nextListView)
    }
  }, [active, target?.page, target?.agent_id, target?.experiment_id, target?.tab, target?.list_view])
  useEffect(() => {
    if (!mobileListOpen || !pendingListFocus.current) return
    pendingListFocus.current = false
    focusSelectedListEntry()
  }, [mobileListOpen, listView, selected, selectedExperiment])
  useEffect(() => {
    const kind = pendingReveal.current
    if (!kind || !active || !detail || detail.agent?.id !== selected || detail.experiment?.id !== selectedExperiment) return
    if (kind === 'panel' && target?.page === 'agents' && target.tab && target.tab !== tab) return
    pendingReveal.current = null
    revealSelection(kind)
  }, [active, selected, selectedExperiment, detail?.experiment?.id, tab, target?.tab, mobileListOpen])
  useEffect(() => {
    if (!(editOpen && assetDirty) && !(nameOpen && nameDraft !== nameInitial)) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [editOpen, editBody, assetInfo?.content, nameOpen, nameDraft, nameInitial])
  const refreshChanged = useQueuedRefresh(active, async () => {
    const selection = selectionRequest.current
    const readList = changedList.current
    changedList.current = false
    const reads: Promise<unknown>[] = [refreshDetail(selected, selectedExperiment), refreshRunOverview()]
    if (readList) reads.push(refreshList())
    if (selected) reads.push(call('fusion/proposal', { agent_id: selected }).then(value => { if (selection === selectionRequest.current) setVersionProposal(value.proposal) }).catch(() => undefined))
    if (selectedExperiment) reads.push(call('features/proposal', { experiment_id: selectedExperiment }).then(value => { if (selection === selectionRequest.current) setFeatureProposal(value.proposal) }).catch(() => undefined))
    if (editOpen && detail?.experiment?.id && editPath && editHash) {
      const request = editRequest.current
      reads.push(call('edit/read', { experiment_id: detail.experiment.id, path: editPath }).then(value => { if (request === editRequest.current && value.sha256 !== editHash) setEditMessage('文件已被其他任务修改，编辑草稿已保留；保存前请核对最新内容。') }).catch(() => undefined))
    }
    await Promise.allSettled(reads)
  }, `${selected}:${selectedExperiment}`)
  useEffect(() => updates?.subscribe(() => {
    if (updates.getSnapshot().domains.some(domain => ['agents', 'instances', 'catalog'].includes(domain))) { changedList.current = true; void refreshChanged() }
  }), [updates])
  useEffect(() => { if (active) void loadEditFile(editPath) }, [active, detail?.experiment?.id, editPath])
  useEffect(() => {
    if (editOpen && active) editDialog.current?.showModal()
    else editDialog.current?.close()
  }, [editOpen, active])

  async function previewVersion() {
    if (!detail || !versionGoal.trim() || !versionParent) return
    const selection = selectionRequest.current
    const request = ++versionPreviewRequest.current
    try {
      const value = await call('fusion/preview', {
        agent_id: selected,
        parent_ref: versionParent,
        parent_experiment_id: detail.experiment.id,
        research_question: versionGoal,
      })
      if (selection !== selectionRequest.current || request !== versionPreviewRequest.current) return
      setVersionInventory(value)
      setVersionProposal(null)
    } catch (err) { if (selection === selectionRequest.current && request === versionPreviewRequest.current) setError((err as Error).message) }
  }

  async function askVersionPlan() {
    if (!derivable || !versionInventory || !onAssistant) return
    await onAssistant(`为当前智能体创建新版本。改进目标：${versionGoal.trim()}`, { page: 'agents', agent_id: selected, experiment_id: detail.experiment.id, skill: 'agent-maintenance', workflow: 'research', fusion_request: versionInventory })
  }

  async function confirmVersion() {
    if (!derivable || !versionProposal || versionProposal.parent_experiment_id !== detail.experiment.id || versionProposal.parent_ref !== versionParent) return
    if (versionProposal.plan.sources.some((source: any) => source.decision === 'inherit' && !canDeriveVersion(experiments.find(item => item.id === source.experiment_id) ?? { ...source, id: source.experiment_id }))) {
      setError('变体不能作为新版本的继承来源。'); return
    }
    const selection = selectionRequest.current
    try {
      const { value } = await confirmBusinessProposal('fusion/confirm', versionProposal)
      await refreshList()
      if (selection === selectionRequest.current) selectVersion(selected, value.experiment_id)
    } catch (err) { setError((err as Error).message) }
  }

  async function confirmFeatures() {
    if (!featureProposal) return
    const selection = selectionRequest.current
    try {
      await confirmBusinessProposal('features/apply', featureProposal)
      if (selection !== selectionRequest.current) return
      setFeatureProposal(null)
      await refreshDetail()
    } catch (err) { setError((err as Error).message) }
  }

  async function confirmBusinessProposal(action: string, proposal: any): Promise<{ value: any; resumed: boolean }> {
    if (proposal.assistant_session_id) {
      const status = await rpc.call(CHANNEL, 'assistant/status', { session_id: proposal.assistant_session_id }) as RpcResult
      if (!status.ok) throw new Error(status.error.message)
      const pending = status.value.proposals.find((item: any) => item.domain === 'agents' && item.action === action && item.input?.preview_id === proposal.preview_id)
      if (pending) {
        const response = await rpc.call(CHANNEL, 'assistant/confirm', { session_id: proposal.assistant_session_id, proposal_id: pending.id }) as RpcResult
        if (!response.ok) throw new Error(response.error.message)
        const receipt = response.value.result
        if (response.value.state !== 'completed' || !receipt?.ok) throw new Error(receipt?.error?.message || '尚未收到完整执行回执，请在同一会话核对状态。')
        return { value: receipt.value, resumed: response.value.continuation === 'resumed' }
      }
    }
    return { value: await call(action, { preview_id: proposal.preview_id, confirmed: true }), resumed: false }
  }

  async function instanceCall(endpoint: string, payload: Record<string, unknown> = {}) {
    const result = await rpc.call(CHANNEL, `instances/${endpoint}`, payload) as RpcResult
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  function changeLaunch(value: any) { launchRequest.current++; launchBusyRef.current = false; setLaunchBusy(false); setLaunchMessage(''); setLaunch(value) }
  function resetVersionPreview() { versionPreviewRequest.current++; setVersionInventory(null); setVersionProposal(null) }
  useEffect(() => { resetVersionPreview() }, [versionParent])

  async function launchVersion() {
    if (!detail || launchBusyRef.current) return
    const selection = selectionRequest.current
    const request = ++launchRequest.current
    launchBusyRef.current = true; setLaunchBusy(true)
    setLaunchMessage('')
    try {
      const value = await instanceCall('list')
      if (selection !== selectionRequest.current || request !== launchRequest.current) return
      const instances = value.instances.filter((item: any) => item.source_id === `experiment:${detail.experiment.id}`)
      setLaunch({ experiment_id: detail.experiment.id, instances, selected: instances[0]?.name ?? '', url: null })
    } catch (err) { if (selection === selectionRequest.current && request === launchRequest.current) setLaunchMessage((err as Error).message) }
    finally { if (selection === selectionRequest.current && request === launchRequest.current) { launchBusyRef.current = false; setLaunchBusy(false) } }
  }

  async function startInstance() {
    if (!launch || launchBusyRef.current) return
    const item = launch.instances.find((entry: any) => entry.name === launch.selected)
    if (item?.state !== 'running') {
      onNavigate?.({ page: 'instances', agent_id: selected, experiment_id: launch.experiment_id,
        source_id: `experiment:${launch.experiment_id}`, ...(item ? { instance_name: item.name } : {}) })
      changeLaunch(null)
      return
    }
    const selection = selectionRequest.current
    const requestId = ++launchRequest.current
    launchBusyRef.current = true; setLaunchBusy(true); setLaunchMessage('')
    try {
      const value = await instanceCall('url', { name: item.name })
      if (selection !== selectionRequest.current || requestId !== launchRequest.current) return
      setLaunch({ ...launch, url: instanceWebUrl(value, window.location.hostname) })
    } catch (err) { if (selection === selectionRequest.current && requestId === launchRequest.current) setLaunchMessage((err as Error).message) }
    finally { if (selection === selectionRequest.current && requestId === launchRequest.current) { launchBusyRef.current = false; setLaunchBusy(false) } }
  }

  async function doPreview() {
    if (!detail || !editPath || !editHash || assetInfo?.editable === false) return
    const request = editRequest.current
    setEditBusy(true)
    setEditMessage('')
    try {
      const value = await call('edit/preview', {
        experiment_id: detail.experiment.id,
        edits: [{ path: editPath, content: editBody, expected_sha256: editHash }],
      })
      if (request !== editRequest.current) return
      const row = value.edits?.[0]
      setEditPreview({ path: row.path, body: editBody, before: row.before_sha256, diff: row.diff || '无变化', dry: value.dry_run })
      setEditMessage('dry 校验通过，原文件尚未修改。')
    } catch (err) {
      if (request === editRequest.current) { setEditPreview(null); setEditMessage((err as Error).message) }
    } finally { setEditBusy(false) }
  }

  async function doApply() {
    if (!detail || !editHash || assetInfo?.editable === false) return
    const selection = selectionRequest.current
    const edit = editRequest.current
    setEditBusy(true)
    setEditMessage('正在进行 dry 校验…')
    try {
      const value = await call('edit/apply', {
        experiment_id: detail.experiment.id,
        edits: [{ path: editPath, content: editBody, expected_sha256: editHash }],
      })
      if (selection !== selectionRequest.current || edit !== editRequest.current) return
      setEditPreview(null)
      if (!await loadEditFile(editPath) || selection !== selectionRequest.current) return
      const currentEdit = editRequest.current
      await refreshDetail()
      if (selection !== selectionRequest.current || currentEdit !== editRequest.current) return
      setEditMessage(`文件校验通过，已保存 ${value.written?.[0]?.path}`)
    } catch (err) {
      if (selection === selectionRequest.current && edit === editRequest.current) setEditMessage(`${(err as Error).message}；草稿已保留。`)
    } finally { setEditBusy(false) }
  }

  const assetDirty = assetInfo?.kind === 'text' && editBody !== assetInfo.content
  const nameDirty = nameOpen && nameDraft !== nameInitial
  const visibleAgents = agents.filter(agent => `${agent.name ?? agent.manifest?.name ?? ''} ${agent.id}`.toLowerCase().includes(search.trim().toLowerCase()))
  const variants = experiments.filter(item => item.is_current !== false && isComputeVariant(item))
  const currentVersions = (detail?.agent?.id === selected ? detail.versions : experiments.filter(item => item.agent_id === selected))
  const agentVersions = detail?.is_current === false && !currentVersions.some((item: any) => item.id === detail.experiment.id)
    ? [...currentVersions, { ...detail.experiment, is_current: false }] : currentVersions
    .slice().sort((left: any, right: any) => String(right.id).localeCompare(String(left.id), 'en', { numeric: true }))
  const visibleVariants = variants.filter(variant => {
    const agent = agents.find(item => item.id === variant.agent_id)
    const query = `${variantName(variant)} ${agent?.name ?? agent?.manifest?.name ?? ''} ${variant.agent_id} ${variant.id} ${variant.change.research_question ?? ''} ${variant.change.parent_experiment_id ?? ''}`.toLowerCase()
    return (!variantAgent || variant.agent_id === variantAgent)
      && query.includes(variantSearch.trim().toLowerCase())
  })
  const versionRuns = detail?.verification?.runs ?? []
  const viewedRun = runOverview?.agentId === selected && runOverview.experimentId === detail?.experiment?.id ? runOverview : null

  function discardAssetDraft() {
    return !assetDirty || window.confirm('当前资产有未保存修改。确认放弃草稿？')
  }

  function discardNameDraft() {
    if (nameBusy) {
      setNameMessage('正在保存或核对名称，请等待结果后再切换。')
      return false
    }
    return !nameDirty || window.confirm('变体名称有未保存修改。确认放弃草稿？')
  }

  function closeNameEditor() {
    if (!discardNameDraft()) return
    setNameOpen(false)
    setNameDraft('')
    setNameInitial('')
    setNameHash('')
    setNameMessage('')
  }

  function closeEditor() {
    if (!editBusy && discardAssetDraft()) {
      setEditBody(assetInfo?.content ?? '')
      setEditOpen(false)
    }
  }

  function openEvaluation(nextTab = 'runs', runId?: string) {
    onNavigate?.({ page: 'evaluation', agent_id: selected, experiment_id: detail?.experiment?.id, tab: nextTab, ...(runId ? { run_id: runId } : {}) })
  }

  useEffect(() => { if (tab === 'description') setDescriptionVisited(true) }, [tab])
  useEffect(() => {
    const dialog = publishDialog.current
    if (!dialog) return
    if (active && publishOpen && !dialog.open) { publishOpener.current = document.activeElement as HTMLElement; dialog.showModal() }
    else if ((!active || !publishOpen) && dialog.open) { dialog.close(); if (active) publishOpener.current?.focus() }
  }, [publishOpen, active])

  async function requestQualityReview() {
    if (!detail || !onAssistant || qualityBusy) return
    const request = selectionRequest.current
    const experimentId = detail.experiment.id, digest = detail.candidate_sha256
    setQualityBusy(true); setQualityMessage('')
    try {
      const current = await call('detail', { agent_id: selected, experiment_id: experimentId })
      if (request !== selectionRequest.current) return
      if (digest !== current.candidate_sha256) throw new Error('已保存资产发生变化，请刷新后重新发起评价。')
      await onAssistant('请只读评价当前版本已保存的 Harness 资产质量，核对当前资产摘要与所选版本 Run 轨迹，分别说明有依据的问题、尚缺证据的能力和下一步。不要把 Run 通过率作为资产质量结论，不混入未保存草稿或其他版本证据；读取时若来源发生变化请明确说明。本次结果留在独立分析会话中，不声称已保存正式质量报告。', { page: 'agents', agent_id: selected, experiment_id: experimentId, candidate_sha256: digest, source_run_ids: (viewedRun?.runs ?? []).map((run: any) => run.run_id ?? run.id), planning_intent: 'read_only_quality_review' })
      if (request === selectionRequest.current) setQualityMessage('已打开独立分析会话；评价结果请在助手会话中查看。质量报告持久保存尚未接入。')
    } catch (error) { if (request === selectionRequest.current) setQualityMessage((error as Error).message) }
    finally { if (request === selectionRequest.current) setQualityBusy(false) }
  }

  function startEvaluation() {
    if (detail?.experiment?.id) onNavigate?.({ page: 'evaluation', agent_id: selected, experiment_id: detail.experiment.id, intent: 'start_eval' })
  }

  return <main className="harness-agents" data-active-tab={tab} aria-label="智能体管理">
    <div className="agent-page-content">
      <header className="agent-page-heading">
        <div className="agent-actions"><button type="button" className="agent-primary" onClick={() => setCreateOpen(true)}>新建智能体</button><button type="button" disabled={!onAssistant} onClick={() => { setMigrationTarget(derivable && /^git:[0-9a-f]{40}$/.test(versionParent) ? { agent_id: selected, experiment_id: detail.experiment.id, parent_ref: versionParent, name: detail.agent.name || selected } : undefined); setMigrationOpen(true) }}>导入 / 迁移</button><button type="button" onClick={() => { changedList.current = true; void refreshChanged() }}>刷新</button></div>
        {tab === 'compute-variants' && <button type="button" className="compute-page-back" onClick={returnToList}>返回智能体列表</button>}
      </header>
      {error && <p role="alert" className="agent-error">{error}</p>}
      <section className="harness-agent-layout" data-active-tab={tab} data-mobile-list={mobileListOpen || !selected}>
        <aside className="harness-agent-list">
          <div role="tablist" aria-label="浏览列表" className="agent-list-tabs" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next: ListView = event.key === 'Home' ? 'agents' : event.key === 'End' ? 'variants' : listView === 'agents' ? 'variants' : 'agents'
            selectListView(next)
            document.getElementById(`agent-list-tab-${next}`)?.focus()
          }}>
            {([{ id: 'agents', label: '智能体', count: agents.length }, { id: 'variants', label: '变体', count: variants.length }] as const).map(item => <button type="button" key={item.id} id={`agent-list-tab-${item.id}`} role="tab" aria-controls={`agent-list-panel-${item.id}`} aria-selected={listView === item.id} tabIndex={listView === item.id ? 0 : -1} onClick={() => selectListView(item.id)}>{item.label}<span aria-hidden="true"> {listPhase === 'pending' && !agents.length ? '…' : item.count}</span></button>)}
            {listPhase === 'pending' && (listView === 'agents' ? agents.length > 0 : variants.length > 0) && <LoadingIndicator label={listView === 'agents' ? "更新智能体列表" : "更新变体列表"} />}
          </div>
          <div role="tabpanel" id="agent-list-panel-agents" aria-labelledby="agent-list-tab-agents" tabIndex={-1} hidden={listView !== 'agents'}>
          <div className="agent-list-heading"><h2>智能体列表</h2><span>{listPhase === 'pending' && !agents.length ? '…' : agents.length}</span></div>
          <label className="agent-search"><span>搜索智能体</span><input type="search" placeholder="名称或 Agent ID" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <div className="harness-agent-list-options">
            {visibleAgents.map(agent => <div className="agent-list-entry" key={agent.id}><button type="button" id={`agent-list-card-${agent.id}`} className="agent-list-card" onClick={() => selectVersion(agent.id, '', true, undefined, 'identity')} aria-pressed={agent.id === selected}>
              <span className="agent-list-card-title"><strong>{agent.name || agent.manifest?.name || agent.id}</strong><span className="agent-badge">{researchStatus(agent.latest_experiment_status)}</span></span>
              <span className="agent-id">{agent.id}</span>
              {agent.manifest?.description && <span className="agent-list-description" title={agent.manifest.description}>{agent.manifest.description}</span>}
              <span className="agent-list-meta">{typeof agent.version_count === 'number' ? `${agent.version_count} 个研究版本` : '版本数量未读取'} · {agent.instance_state || '实例未观察'}</span>
            </button><button type="button" className="agent-variant-count" onClick={() => showAgentVariants(agent.id)} aria-label={`查看 ${agent.name || agent.id} 的变体`}>变体 {variants.filter(variant => variant.agent_id === agent.id).length}</button></div>)}
            {agents.length > 0 && !visibleAgents.length && <p className="agent-empty">没有匹配的智能体。</p>}
            {listPhase === 'pending' && !agents.length && <LoadingIndicator label="读取智能体列表" block />}
            {!agents.length && listPhase === 'ready' && <p className="agent-empty">尚无智能体资产。</p>}
          </div>
          </div>
          <div role="tabpanel" id="agent-list-panel-variants" aria-labelledby="agent-list-tab-variants" tabIndex={-1} hidden={listView !== 'variants'}>
            <div className="agent-list-heading"><h2>变体列表</h2><span>{listPhase === 'pending' && !experiments.length ? '…' : `${visibleVariants.length} / ${variants.length}`}</span></div>
            <label className="agent-search"><span>搜索变体</span><input type="search" placeholder="变体名称、版本或来源 ID" value={variantSearch} onChange={event => setVariantSearch(event.target.value)} /></label>
            {variantAgent && <div className="agent-variant-scope"><span>{agents.find(agent => agent.id === variantAgent)?.name || variantAgent} 的变体</span><button type="button" onClick={() => { setVariantAgent(''); setVariantSearch('') }}>显示全部变体</button></div>}
            <div className="harness-agent-list-options" aria-label="变体条目">
              {visibleVariants.map(variant => {
                const agent = agents.find(item => item.id === variant.agent_id)
                const fixedRef = variant.change.parent_ref || (variant.change.parent_experiment_id ? variant.change.baseline_ref : '')
                return <button type="button" id={`agent-variant-card-${variant.id}`} className="agent-list-card agent-variant-card" key={variant.id} aria-pressed={selected === variant.agent_id && selectedExperiment === variant.id} onClick={() => selectVersion(variant.agent_id, variant.id, true, 'compute-variants', 'panel')}>
                  <span className="agent-list-card-title"><strong>{variantName(variant)}</strong><span className="agent-badge">{variant.change.variant_kind === 'end' ? 'end 已记录' : '探索性变体'}</span></span>
                  <span className="agent-id">{variant.id}</span>
                  <span className="agent-list-meta">{agent?.name || agent?.manifest?.name || variant.agent_id} · {generationLabel(variant)}</span>
                  <span className="agent-list-meta">父版：{variant.change.parent_experiment_id || '未记录'}</span>
                  {fixedRef && <span className="agent-id" title={fixedRef}>{String(fixedRef).startsWith('git:') ? `${String(fixedRef).slice(0, 16)}…` : fixedRef}</span>}
                  <span className="agent-list-meta">{researchStatus(variant.status || variant.change.status)}</span>
                </button>
              })}
              {listPhase === 'pending' && !variants.length && <LoadingIndicator label="读取变体列表" block />}
              {!visibleVariants.length && listPhase === 'ready' && <p className="agent-empty">{variants.length ? '没有匹配的变体。' : '尚无已记录的算力变体。'}</p>}
            </div>
          </div>
        </aside>
        <section className="harness-agent-detail" data-active-tab={tab}>
          {!detail && selected && !error && <LoadingIndicator label="读取智能体资料" block />}
          {detail && <section className="agent-identity" id="agent-identity" tabIndex={-1}>
            <button type="button" className="agent-back-to-list" onClick={returnToList}>← 返回{listView === 'variants' ? '变体列表' : '智能体列表'}</button>
            <div className="agent-identity-top">
              {detail.is_current === false && detail.current_variant_id && <p className="agent-notice" role="status">当前查看历史变体记录，资产和 Run 保留原身份。<button type="button" onClick={() => selectVersion(selected, detail.current_variant_id, true, tab)}>查看当前变体</button><code>{detail.current_variant_id}</code></p>}
              <div className="agent-identity-title"><h2>{detail.agent.name || detail.agent.manifest.name || selectedAgent?.name || selected}</h2><SearchSelect className="agent-version-choice" label="版本" value={selectedExperiment || detail.experiment.id} options={agentVersions.map((version: any) => { const metadata = version.id === detail.experiment.id ? detail.experiment : experiments.find(item => item.id === version.id) ?? version; const name = versionLabel(version.id).replace(/^版本 /, 'v'); const disambiguation = agentVersions.filter((item: any) => versionLabel(item.id) === versionLabel(version.id)).length > 1 ? ` · ${version.id.slice(-6)}` : ''; return { value: version.id, label: isComputeVariant(metadata) ? `${variantName(metadata)} · ${name}${disambiguation}` : `${name}${disambiguation}`, description: version.id } })} onChange={value => selectVersion(selected, value)}/><span className="agent-badge">{isComputeVariant(detail.experiment) ? "算力变体" : "业务版本"}</span></div>
              <div className="agent-actions agent-main-actions"><button type="button" className="agent-primary" disabled={!onNavigate} onClick={startEvaluation}>发起评测</button><button type="button" disabled={launchBusy} onClick={() => void launchVersion()}>进入对话</button><button type="button" onClick={() => setPublishOpen(true)}>发布版本</button><details className="agent-more-actions" open={moreActionsOpen}><summary onClick={event => { event.preventDefault(); setMoreActionsOpen(!moreActionsOpen) }}>更多操作</summary><div><button type="button" onClick={() => { setMoreActionsOpen(false); setDeploymentTarget({ agent_id: selected, experiment_id: detail.experiment.id, label: `${detail.agent.name || selected} · ${versionLabel(detail.experiment.id)}` }); setDeploymentOpen(true) }}>导出独立运行包</button><button type="button" disabled={!onNavigate} onClick={() => { setMoreActionsOpen(false); openEvaluation() }}>查看评测</button><button type="button" disabled={!onNavigate} onClick={() => { setMoreActionsOpen(false); onNavigate?.({ page: 'instances', agent_id: selected, experiment_id: detail.experiment.id }) }}>查看实例</button><button type="button" disabled={!derivable} title={derivable ? undefined : "变体不能作为新版本的继承来源。"} onClick={() => { if (!derivable) return; setMoreActionsOpen(false); setVersionOpen(true); resetVersionPreview() }}>新建研究版本</button><button type="button" disabled={!onNavigate} onClick={() => { setMoreActionsOpen(false); onNavigate?.({ page: 'instances', agent_id: selected, experiment_id: detail.experiment.id, source_id: `experiment:${detail.experiment.id}` }) }}>创建实例</button></div></details></div>
            </div>
            {!derivable && <p className="agent-muted">变体不能作为新版本、融合或其他变体的继承来源。</p>}{isComputeVariant(detail.experiment) && <div className="agent-variant-name"><h3>{variantName(detail.experiment)}</h3><button type="button" disabled={nameBusy || nameOpen} onClick={editVariantName}>修改变体名称</button></div>}
            {nameOpen && <form className="agent-name-form" aria-label="修改变体名称" onSubmit={event => { event.preventDefault(); void saveVariantName() }}>
              <label className="agent-field">变体名称<input aria-label="变体名称" value={nameDraft} disabled={nameBusy} onChange={event => setNameDraft(event.target.value)} required /></label>
              <div className="agent-actions"><button type="submit" disabled={nameBusy || !nameDraft.trim() || !nameHash}>保存名称</button><button type="button" disabled={nameBusy} onClick={() => void saveVariantName(true)}>重新核对</button><button type="button" disabled={nameBusy} onClick={closeNameEditor}>取消改名</button></div>
            </form>}
            {nameMessage && <p role="status">{nameMessage}</p>}
            {detail.creation && <p role="status" className="agent-notice">{detail.creation.status === 'completed' ? '新版本创建成功' : '融合中：等待资产集成与约定验证'}{detail.creation.status !== 'completed' && <button type="button" disabled={!onAssistant} onClick={() => void onAssistant?.('继续完成当前版本的融合。', { page: 'agents', agent_id: selected, experiment_id: detail.experiment.id, skill: 'agent-maintenance', workflow: 'research', session_id: detail.creation.assistant_session_id })}>继续融合</button>}</p>}
          </section>}
          {versionOpen && detail && derivable && <section className="agent-inline-form" aria-label="新建智能体版本">
            <h2>新建 {selected} 版本</h2>
            <label className="agent-field">改进目标<textarea value={versionGoal} onChange={event => { setVersionGoal(event.target.value); resetVersionPreview() }} rows={3} /></label>
            <p className="agent-muted">{versionParent ? '来源已固定，平台将自动继承所选版本。' : detail.derivation?.note || '当前版本尚未固定，请先固定完整来源后再创建研究版本。'}</p>
            <p>当前主父版：{detail.experiment.id}。先核对未继承的并行能力及取舍，确认后再建立新版本。</p>
            <div className="agent-actions"><button type="button" disabled={!versionGoal.trim() || !versionParent} onClick={() => void previewVersion()}>盘点继承来源</button><button type="button" onClick={() => { versionPreviewRequest.current++; setVersionOpen(false) }}>关闭</button></div>
            {versionInventory && <><h3>主父版尚未覆盖的来源</h3>{versionInventory.inventory.sources.length ? <ul>{versionInventory.inventory.sources.filter((source: any) => canDeriveVersion(experiments.find(item => item.id === source.experiment_id) ?? { ...source, id: source.experiment_id })).map((source: any) => <li key={source.experiment_id}><strong>{source.experiment_id}</strong> · {source.status === 'recommended' ? '建议继承' : source.status === 'excluded' ? '默认排除' : '待判断'}<p>{source.reason}</p></li>)}</ul> : <p>没有发现尚未覆盖的并行来源。</p>}
              <button type="button" disabled={!onAssistant} onClick={() => void askVersionPlan()}>请 AI 整理融合方案</button></>}
            {versionProposal && versionProposal.parent_experiment_id === detail.experiment.id && versionProposal.parent_ref === versionParent && versionProposal.research_question === versionGoal && <>
              <h3>待确认方案</h3><p>{versionProposal.research_question}</p>
              <h4>继承来源与取舍</h4><ul>{versionProposal.plan.sources.map((source: any) => <li key={source.experiment_id}>{source.experiment_id}：{source.decision === 'inherit' ? '继承' : '舍弃'} · {source.reason}<p>{source.ref}</p></li>)}</ul>
              <h4>新版本特性</h4><ul>{versionProposal.plan.features.map((feature: any) => <li key={feature.id}><strong>{feature.title}</strong><p>{feature.description}</p><p>{feature.change || '保留来源能力'} · {feature.source_refs.join('、') || '来源待说明'}</p></li>)}</ul>
              <h4>冲突处理</h4>{versionProposal.plan.conflicts.length ? <ul>{versionProposal.plan.conflicts.map((conflict: any, index: number) => <li key={index}>{conflict.description}：{conflict.resolution}</li>)}</ul> : <p>方案未发现需要业务取舍的冲突。</p>}
              <h4>验证范围</h4><ul>{versionProposal.plan.checks.map((check: any) => <li key={check.id}>{check.id}：{check.kind === 'build' ? `构建 ${check.command.join(' ')}` : check.kind === 'load' ? '实际 DSH Session 装载证据' : `能力评测 ${check.case_ids.join('、')}`}</li>)}</ul>
              <button type="button" onClick={() => void confirmVersion()}>确认方案并创建版本</button>
            </>}
          </section>}
          {launch && <section className="agent-inline-form" aria-label="启动选中版本"><h2>实例与对话入口 · {launch.experiment_id}</h2>
            {launch.instances.length > 0 && <label className="agent-field">实例<select value={launch.selected} disabled={launchBusy} onChange={event => changeLaunch({ ...launch, selected: event.target.value, url: null })}>{launch.instances.map((item: any) => <option key={item.name} value={item.name}>{item.name} · {item.state}</option>)}<option value="">新建实例</option></select></label>}
            <div className="agent-actions"><button type="button" className="agent-primary" disabled={launchBusy || !onNavigate && launch.instances.find((item: any) => item.name === launch.selected)?.state !== 'running'} onClick={() => void startInstance()}>{launch.instances.find((item: any) => item.name === launch.selected)?.state === 'running' ? '获取对话入口' : launch.selected ? '在实例管理预览启动' : '前往实例管理创建'}</button><button type="button" disabled={launchBusy} onClick={() => changeLaunch(null)}>关闭</button></div>
            {launch.url && <p><a href={launch.url} target="_blank" rel="noreferrer">打开智能体对话</a></p>}
          </section>}
          {launchMessage && <p role="status">{launchMessage}</p>}
          {detail && <div role="tablist" aria-label="智能体详情" className="harness-agent-tabs" onKeyDown={event => {
            const index = tabs.findIndex(item => item.id === tab)
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined
            if (next === undefined) return
            event.preventDefault()
            selectTab(tabs[next].id, false)
            document.getElementById(`agent-tab-${tabs[next].id}`)?.focus()
          }}>
            {tabs.map(item => <button key={item.id} type="button" role="tab" id={`agent-tab-${item.id}`}
              aria-controls={`agent-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
              onClick={() => selectTab(item.id)}>{item.label}</button>)}
          </div>}
          {detail && <section role="tabpanel" id="agent-panel-overview" aria-labelledby="agent-tab-overview" tabIndex={-1} hidden={tab !== 'overview'}>
            <div className="agent-section-heading"><h2>用途与特性</h2><button type="button" disabled={!onAssistant} onClick={() => void onAssistant?.('请使用 agent-maintenance Skill 整理固定目标版本的用途与特性，读取资产和已有证据后通过 features/preview 提交清单，平台自动保存并回读，无需再次确认。', { page: 'agents', agent_id: selected, experiment_id: detail.experiment.id, skill: 'agent-maintenance', workflow: 'features' })}>请 AI 整理特性</button></div>
            <p>{detail.agent.manifest.description || detail.experiment.change.research_question || '用途尚未整理。'}</p>

            <AgentEvaluationOverview value={viewedRun} versionLabel={versionLabel(detail.experiment.id)} onOpenRun={onNavigate ? runId => openEvaluation('runs', runId) : undefined} onOpenEvaluation={onNavigate ? () => openEvaluation() : undefined} />
            <h3>当前版本特性</h3>
            {detail.features?.length ? <div className="agent-feature-list">{detail.features.map((feature: any) => <article key={feature.id}><h4>{feature.title}</h4><p>{feature.description}</p>{feature.change && <p>本版本变化：{feature.change}</p>}<small>来源：{feature.source_refs.join('、') || '未记录'}</small>{(feature.verification || feature.evidence?.length > 0) && <DetailDrawer title={`${feature.title} · 验证依据`} trigger="验证依据" active={active && tab === 'overview'} identity={`${detail.experiment.id}:${feature.id}`}>{feature.verification && <p>{feature.verification}</p>}{feature.evidence?.length > 0 && <ul>{feature.evidence.map((evidence: any) => <li key={evidence.ref}><code>{evidence.ref}</code> · {evidence.present ? '引用存在，效果需复核' : '未找到证据'}</li>)}</ul>}</DetailDrawer>}</article>)}</div> : <p className="agent-empty">此版本尚未整理特性，可由 AI 根据当前资产和证据整理并自动保存。</p>}
            {featureProposal && featureProposal.experiment_id === detail.experiment.id && <section className="agent-notice" aria-label="确认智能体特性"><h3>待确认特性</h3><ul>{featureProposal.features.map((feature: any) => <li key={feature.id}><strong>{feature.title}</strong><p>{feature.description}</p><p>{feature.source_refs.join('、') || '未记录来源'} · {feature.evidence_refs.length ? feature.evidence_refs.join('、') : '尚无验证证据'}</p></li>)}</ul><button type="button" onClick={() => void confirmFeatures()}>确认并保存特性</button></section>}
            <VariantSourcePanel active={active && tab === 'overview'} experiment={{ ...detail.experiment, agent_id: selected }} experiments={experiments}
            onSelectSource={(agentId, experimentId) => selectVersion(agentId, experimentId, true, 'overview', 'identity')}
            onOpenRun={(runId, agentId, experimentId) => onNavigate?.({ page: 'evaluation', agent_id: agentId, experiment_id: experimentId, tab: 'runs', run_id: runId })}
            onOpenCode={openCode} >
              <Fields items={[['Agent ID', selected], ['查看版本 ID', detail.experiment.id], ['登记版本 ID', selectedAgent?.active_experiment || '未登记'], ['研究状态', researchStatus(detail.experiment.status)], ['相关引用', detail.related_references ?? []]]} />
            </VariantSourcePanel>
          </section>}
          {detail && <section role="tabpanel" id="agent-panel-description" aria-labelledby="agent-tab-description" tabIndex={-1} hidden={tab !== 'description'}>{descriptionVisited && <AgentDescriptionPanel key={detail.experiment.id} active={active && tab === 'description'} rpc={rpc} detail={detail} agentId={selected} onSaved={() => { void refreshDetail(); void refreshList() }} onEditAsset={path => { if (discardAssetDraft() && (!descriptionDirty.current || window.confirm('放弃未保存资料并查看原始资产？'))) { descriptionDirty.current = false; selectEditFile(path); selectTab('assets') } }} onDirtyChange={dirty => { descriptionDirty.current = dirty }} onAssistant={onAssistant}/>}</section>}
          {detail && <section role="tabpanel" id="agent-panel-compute-variants" aria-labelledby="agent-tab-compute-variants" tabIndex={-1} hidden={tab !== 'compute-variants'}>
            {tab === 'compute-variants' && <ComputeVariantsPanel key={detail.experiment.id} active={active} rpc={rpc} agentId={selected} agentName={detail.agent.name || detail.agent.manifest.name || selected} versionLabel={versionLabel(detail.experiment.id).replace(/^版本 /, 'v')} experimentId={detail.experiment.id} versions={detail.versions} currentVariantName={detail.experiment.change.variant_name ?? null} onAssistant={onAssistant}
              onCreated={id => { void refreshList(); selectVersion(selected, id) }} onChanged={() => { void refreshDetail() }} onOpenCode={openCode} />}
          </section>}
          {detail && <section role="tabpanel" id="agent-panel-assets" aria-labelledby="agent-tab-assets" tabIndex={-1} hidden={tab !== 'assets'}>
            <div className="agent-quality-summary"><div><strong>版本质量评价</strong><p>暂无正式质量报告；分析结果可在独立助手会话查看，报告持久保存尚未接入。</p></div><button type="button" disabled={!onAssistant || qualityBusy} onClick={() => void requestQualityReview()}>{qualityBusy ? '正在核对来源…' : '请 AI 助手评价'}</button></div>{qualityMessage && <p role="status">{qualityMessage}</p>}
            <div className="agent-section-heading"><h2>智能体资产</h2><button type="button" aria-expanded={diffOpen} aria-controls="agent-asset-diff-panel" onClick={() => setDiffOpen(value => !value)}>{diffOpen ? '收起资产差异' : '展开资产差异'}</button></div>
            {diffOpen && <AssetDiffPanel key={detail.experiment.id} active={active && tab === 'assets'} rpc={rpc} experimentId={detail.experiment.id} versions={detail.versions} baseline={detail.baseline} />}
            <div className="harness-asset-layout">
              <nav aria-label="智能体资产目录"><AssetTree nodes={detail.assets ?? []} selected={editPath} onSelect={path => { if (path !== editPath && discardAssetDraft()) { selectEditFile(path); navigateSelection(selected, detail.experiment.id, 'assets') } }} /></nav>
              <article><h3>资产详情</h3><p>{editPath || '请选择资产'}</p>{/(^|\/)evaluation(?:\.md|\/|$)/.test(editPath) && <p><button type="button" disabled={!onNavigate} onClick={() => openEvaluation('cases')}>到评测中心管理用例</button></p>}{/(^|\/)decision\.md$/.test(editPath) && <p><button type="button" disabled={!onNavigate} onClick={() => openEvaluation('compare')}>到评测中心比较结果与记录决策</button></p>}
                {assetInfo && <>
                  <Fields items={[['类型', assetInfo.kind === 'directory' ? '目录' : assetInfo.kind === 'text' ? '文本' : '二进制或大文件（只读）'], ['大小（字节）', assetInfo.size], ['SHA-256', assetInfo.sha256]]} />
                  {assetInfo.kind === 'text' && <><button type="button" disabled={!editHash || assetInfo.editable === false} onClick={() => { currentEdit.current.open = true; setEditMessage(''); setEditOpen(true) }}>编辑</button>{assetInfo.reason && <p role="status">{assetInfo.reason}</p>}<pre className="harness-asset-content">{assetInfo.content || '空文件'}</pre></>}
                  {assetInfo.kind === 'directory' && <p>展开左侧目录后选择文件。</p>}
                </>}
                {editMessage && <p role="status">{editMessage}</p>}
              </article>
            </div>
            <DetailDrawer title="来源与 Runtime 配置" active={active && tab === 'assets'} identity={detail.experiment.id}><Fields items={[
              ['来源状态', detail.declared.source_contract.status === 'unavailable' ? '来源无法解析' : '已解析来源合同'],
              ['Candidate', detail.declared.loadable_source?.candidate_root], ['Profile', detail.declared.loadable_source?.profile], ['Preset', detail.declared.loadable_source?.preset],
              ['Patch', detail.declared.loadable_source?.patch], ['Guard', detail.declared.loadable_source?.guard ?? '无'], ['Runtime 版本', detail.declared.source_contract.image?.cli_version],
              ['镜像', detail.declared.source_contract.image?.local_image_tag], ['环境变量名称', detail.declared.loadable_source?.required_env_names],
            ]} /></DetailDrawer>
          </section>}
          <dialog ref={publishDialog} className="harness-asset-dialog agent-publish-dialog" aria-labelledby="agent-publish-title" onCancel={event => { event.preventDefault(); setPublishOpen(false) }}>{publishOpen && <><header className="agent-section-heading"><h2 id="agent-publish-title">发布 Harness 版本</h2><button type="button" onClick={() => setPublishOpen(false)}>关闭</button></header><div className="agent-dialog-body"><p>查看当前版本的来源、资产与已有评测。</p>{detail && <Fields items={[["智能体", detail.agent.name || selected], ["来源版本", detail.experiment.id], ["资产摘要", detail.candidate_sha256 || '未取得'], ["父版", detail.baseline.ref || '未记录'], ["已有 Run", String(versionRuns.length)]]}/>}<p role="status">当前平台尚未接入独立 Harness 版本发布。研究采纳、Research Release 和实例启用各自保留原有用途。</p></div><footer className="agent-actions agent-dialog-actions"><button type="button" className="agent-primary" disabled>发布版本（未接入）</button><button type="button" onClick={() => setPublishOpen(false)}>返回</button></footer></>}</dialog>
          <dialog ref={editDialog} className="harness-asset-dialog" aria-labelledby="asset-edit-title" onCancel={event => { event.preventDefault(); closeEditor() }}>
            <h2 id="asset-edit-title">编辑资产</h2><div className="agent-dialog-body"><p>{editPath}</p>
            <p>保存前仅检查本次文件的格式和语法，并核对文件是否被他人修改；不执行源码、评测或业务工具。</p>
            <label className="agent-field">编辑正文
              <textarea value={editBody} disabled={!editHash || editBusy || assetInfo?.editable === false} onChange={event => { editRequest.current++; setEditBody(event.target.value); setEditPreview(null); setEditMessage('') }} rows={12} className="agent-editor" />
            </label>
            {editBusy && <p role="status">正在进行 dry 校验…</p>}
            {editMessage && <p role="status">{editMessage}</p>}
            {editPreview && <><p>校验通过：{editPreview.dry.checks.join('、')}。</p>
              <p>{editPreview.dry.note}</p>
              <pre className="harness-asset-content">{editPreview.diff}</pre></>}
            </div>
            <div className="agent-actions agent-dialog-actions">
              <button type="button" onClick={() => { if (discardAssetDraft()) void loadEditFile() }} disabled={editBusy}>重读文件</button>
              <button type="button" onClick={() => void doPreview()} disabled={!editHash || editBusy || assetInfo?.editable === false}>dry 校验与预览</button>
              <button type="button" onClick={() => void doApply()} disabled={!editHash || editBusy || assetInfo?.editable === false}>应用保存</button>
              <button type="button" onClick={closeEditor} disabled={editBusy}>关闭</button>
            </div>
          </dialog>
        </section>
      </section>
      {createOpen && <CreateAgentDialog rpc={rpc} active={active} onClose={() => setCreateOpen(false)} onCreated={() => { void refreshList() }} onSelect={receipt => { if (selectVersion(receipt.agent_id, receipt.experiment_id)) setCreateOpen(false) }} />}
      {migrationOpen && onAssistant && <ImportAgentDialog active={active} target={migrationTarget} onClose={() => setMigrationOpen(false)} onAssistant={onAssistant} />}
      {deploymentTarget && <DeploymentDialog rpc={rpc} active={active && deploymentOpen} target={deploymentTarget} onClose={() => setDeploymentOpen(false)} />}
    </div>
  </main>
}
