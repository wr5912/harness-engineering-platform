import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Catalog } from './catalog.ts'
import type { PageId, PlatformNavigation, PlatformPageProps } from './protocol.ts'
import type { RecentRun } from './dashboard.ts'
import { CHANNEL } from './protocol.ts'
import { useQueuedRefresh } from './realtime/refresh.ts'
import type { PlatformUpdates } from './realtime/client.ts'
import type { Assistant } from './assistant/client.tsx'
import type { AssistantView } from './assistant/index.ts'
import type { RiskFact } from './business-control/contracts.ts'
import { PlatformLogo } from './logo.tsx'
import { LoadingIndicator } from './components/loading-indicator.tsx'
import { DistributionChart } from './components/overview-charts.tsx'
import { runOutcomeSegments } from './components/run-overview.ts'
import { GENERAL_PLACEHOLDER, DEMO_AGENT, DEMO_BUILD_PROMPT, DEMO_CASE, HOME_MODES, HOME_SUBTITLE, homeTaskRequest, type HomeMode } from './home-entry.ts'
export { PlatformLogo } from './logo.tsx'

export type { PageId } from './protocol.ts'
type Observation<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
interface Dashboard {
  recent_runs: RecentRun[]
  instances: Observation<{ instances: { state: string }[] }>
  mcp: Observation<{ connections: unknown[] }>
}
interface EvaluationJob {
  job_id: string
  source: string
  experiment_id: string | null
  agent_id: string | null
  status: string
  run_id?: string
  started_at?: string
  updated_at?: string
  error?: string
}

const jobStates: Record<string, string> = { queued: '排队中', running: '运行中', recovering: '正在恢复', completed: '已完成，查看结论', failed: '执行失败', cancelled: '已取消', unknown: '状态待核对' }
function riskOverview(phase: 'pending' | 'ready' | 'error', facts: RiskFact[], enabled?: boolean) {
  if (phase === 'pending') return { value: '—', note: '' }
  if (phase === 'error') return { value: '读取失败', note: '进入统一网关重新核对' }
  if (enabled === false) return { value: '自动评估已关闭', note: '按访问策略和人工限制执行' }
  if (enabled !== true) return { value: '评估开关待核对', note: '进入统一网关核对评估配置' }
  if (!facts.length) return { value: '尚无评估', note: '进入统一网关核对当前范围' }
  const active = facts.filter(fact => Date.parse(fact.expiresAt) > Date.now())
  if (!active.length) return { value: '评估已过期', note: `${facts.length} 项历史事实需重新核对` }
  const expired = facts.length - active.length
  const scope = `${active.length} 项有效范围${expired ? `，${expired} 项已过期` : ''}`
  if (active.some(fact => fact.status === 'unknown' || !fact.level || fact.level === 'unknown')) return { value: '结果未知', note: scope }
  if (active.some(fact => fact.level === 'high')) return { value: '存在高风险', note: scope }
  return { value: '已评估', note: `${scope}内未见高风险` }
}
const emptyDrafts = (): Record<HomeMode, string> => ({ general: '', build: '', evaluate: '', improve: '', manage: '' })
function readComposer(key: string): { mode: HomeMode; drafts: Record<HomeMode, string> } {
  const saved = sessionStorage.getItem(key)
  if (!saved) return { mode: 'general', drafts: emptyDrafts() }
  const parsed: unknown = JSON.parse(saved)
  if (!parsed || typeof parsed !== 'object') throw new Error('任务草稿无法读取')
  const value = parsed as Record<string, unknown>
  const source = value.drafts && typeof value.drafts === 'object' ? value.drafts as Record<string, unknown> : value
  const modes = Object.keys(emptyDrafts()) as HomeMode[]
  const mode = modes.includes(value.mode as HomeMode) ? value.mode as HomeMode : 'general'
  const drafts = Object.fromEntries(modes.map(item => [item, typeof source[item] === 'string' ? source[item] : ''])) as Record<HomeMode, string>
  return { mode, drafts }
}
function saveComposer(key: string, mode: HomeMode, drafts: Record<HomeMode, string>) {
  if (mode !== 'general' || Object.values(drafts).some(Boolean)) sessionStorage.setItem(key, JSON.stringify({ mode, drafts }))
  else sessionStorage.removeItem(key)
}
function ShortcutIcon({ mode }: { mode: Exclude<HomeMode, 'general'> }) {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {mode === 'build' ? <><path d="m12 2 9 5-9 5-9-5 9-5Zm-9 5v10l9 5 9-5V7M12 12v10"/></> : mode === 'evaluate' ? <><path d="M4 19V5m4 14v-6m4 6V9m4 10v-9m4 9v-4M3 19h18"/></> : mode === 'improve' ? <><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2ZM19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7L19 17Z"/></> : <><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h7M11 16.5h7"/></>}
  </svg>
}
function ContinueIcon({ kind, tone }: { kind: 'session' | 'job' | 'run'; tone: 'warning' | 'danger' | 'blue' }) {
  return <span className="harness-continue-icon" data-tone={tone} aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {kind === 'session' ? <><path d="M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Z"/><path d="M12 7v5m0 4h.01"/></> : kind === 'job' ? <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></> : <><path d="M4 19V5m0 14h16M8 16v-4m4 4V8m4 8v-6"/></>}
  </svg></span>
}
export function HomePage({ catalog, rpc, updates, sessions, assistant, navigate, startConversation, active = true }: PlatformPageProps & { catalog: Catalog; active?: boolean; updates: PlatformUpdates; sessions: Context['sessions']; assistant: Assistant; navigate: (page: PageId | PlatformNavigation) => void; startConversation: (root: string, prompt: string, context?: Record<string, unknown>) => Promise<void> }) {
  const state = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const assets = state.inventory
  const workspaceScope = assets ? JSON.stringify([assets.workspace?.id ?? '', assets.root]) : ''
  const sessionList = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
  const observedSessions = useRef(new Set<string>())
  const [sessionError, setSessionError] = useState('')
  const [continueError, setContinueError] = useState('')
  const [jobs, setJobs] = useState<EvaluationJob[]>([])
  const [jobsLoaded, setJobsLoaded] = useState(false)
  const [jobsObserved, setJobsObserved] = useState(false)
  const changedDomains = useRef(new Set(['agents']))
  const homeRequest = useRef(0), currentScope = useRef(workspaceScope)
  currentScope.current = workspaceScope
  const currentPage = useRef({ active, workspaceScope })
  currentPage.current = { active, workspaceScope }
  const [continueMenuOpen, setContinueMenuOpen] = useState(false)
  useEffect(() => {
    const close = () => setContinueMenuOpen(false)
    window.addEventListener('hashchange', close); window.addEventListener('popstate', close)
    return () => { window.removeEventListener('hashchange', close); window.removeEventListener('popstate', close) }
  }, [])
  useEffect(() => { setContinueMenuOpen(false) }, [active, workspaceScope])
  const [runs, setRuns] = useState<RecentRun[]>()
  const [runPhase, setRunPhase] = useState<'pending' | 'ready' | 'error'>('pending')
  const [dashboard, setDashboard] = useState<Dashboard>()
  const [riskState, setRiskState] = useState<{ phase: 'pending' | 'ready' | 'error'; facts: RiskFact[]; enabled?: boolean; observed?: boolean }>({ phase: 'pending', facts: [] })
  const [riskExpiryRevision, setRiskExpiryRevision] = useState(0)
  const [runError, setRunError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [mode, setMode] = useState<HomeMode>('general')
  const [drafts, setDrafts] = useState<Record<HomeMode, string>>(emptyDrafts())
  const [draftScope, setDraftScope] = useState('')
  const [restoredWorkspace, setRestoredWorkspace] = useState('')
  const [draftStatus, setDraftStatus] = useState<'pending' | 'ready' | 'unavailable'>('pending')
  const draftPending = !assets || draftStatus === 'pending' || restoredWorkspace !== workspaceScope
  const prompt = draftPending ? '' : drafts[mode]
  const modeInfo = HOME_MODES.find(item => item.id === mode)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!assets) return
    let active = true
    setDraftStatus('pending'); setDraftScope(''); setRestoredWorkspace(''); setMode('general'); setDrafts(emptyDrafts())
    void rpc.call(CHANNEL, 'auth/current', {}).then(result => {
      if (!active) return
      const username = result.ok ? (result.value as { username?: unknown }).username : undefined
      if (typeof username !== 'string' || !username) { setRestoredWorkspace(workspaceScope); setDraftStatus('unavailable'); return }
      const key = `harness-platform:home-drafts:v1:${JSON.stringify([username, assets.workspace?.id ?? '', assets.root])}`
      try { const restored = readComposer(key); setMode(restored.mode); setDrafts(restored.drafts); setDraftScope(key); setRestoredWorkspace(workspaceScope); setDraftStatus('ready') }
      catch { setRestoredWorkspace(workspaceScope); setDraftStatus('unavailable') }
    }).catch(() => { if (active) { setRestoredWorkspace(workspaceScope); setDraftStatus('unavailable') } })
    return () => { active = false }
  }, [rpc, workspaceScope])
  function persistComposer(selectedMode: HomeMode, next: Record<HomeMode, string>) {
    if (draftScope) {
      try { saveComposer(draftScope, selectedMode, next) }
      catch { setDraftScope(''); setDraftStatus('unavailable') }
    }
  }
  function replaceDraft(target: HomeMode, value: string, selectedMode = mode) {
    const next = { ...drafts, [target]: value }
    setDrafts(next)
    persistComposer(selectedMode, next)
  }
  function selectMode(next: HomeMode) {
    setMode(next)
    persistComposer(next, drafts)
  }
  useLayoutEffect(() => {
    const input = promptRef.current
    if (!input) return
    const resize = () => {
      input.style.height = 'auto'
      if (input.value) input.style.height = `${Math.min(240, input.scrollHeight)}px`
    }
    resize()
    let width = input.getBoundingClientRect().width
    const observer = new ResizeObserver(() => {
      const current = input.getBoundingClientRect().width
      if (current !== width) { width = current; resize() }
    })
    observer.observe(input)
    return () => observer.disconnect()
  }, [mode, prompt])
  const [exampleOpen, setExampleOpen] = useState(false)
  const [exampleLoading, setExampleLoading] = useState(false)
  const [exampleError, setExampleError] = useState('')
  const [exampleSources, setExampleSources] = useState<{ source: string; experiment_id: string; active: boolean }[]>([])
  const [exampleSource, setExampleSource] = useState('')
  const [sending, setSending] = useState(false)
  const [entryError, setEntryError] = useState('')
  useEffect(() => { if (active) void catalog.refresh() }, [catalog, refresh, active])
  useEffect(() => {
    if (!active) return
    let current = true
    setSessionError('')
    void sessions.refresh().catch(() => { if (current) setSessionError('会话列表暂不可读，请重试。') })
    return () => { current = false }
  }, [sessions, refresh, active])
  useEffect(() => {
    if (!active) return
    const roots = state.inventory ? [state.inventory.root, ...(state.inventory.workspace?.legacyRoots ?? [])] : []
    const pending = sessionList.ids.filter(id => roots.includes(sessionList.byId[id]?.cwd ?? '') && !observedSessions.current.has(id))
    pending.forEach(id => observedSessions.current.add(id))
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (pending.length) {
        const id = pending.shift()!
        await sessions.refreshProjections(id).catch(() => setSessionError('部分会话任务状态暂不可读，请刷新重试。'))
      }
    }))
  }, [sessions, sessionList, state.inventory?.root, active])
  const refreshHome = useQueuedRefresh(active, async () => {
    const request = ++homeRequest.current, scope = workspaceScope
    const readJobs = changedDomains.current.has('agents')
    changedDomains.current.clear()
    const current = () => request === homeRequest.current && currentScope.current === scope
    if (readJobs) { setContinueError(''); setJobsLoaded(false) }
    setRunError(''); setRunPhase('pending')
    setRiskState(previous => ({ ...previous, phase: 'pending' }))
    await Promise.allSettled([
      ...(readJobs ? [rpc.call(CHANNEL, 'agents/eval/list', {}).then(result => {
        if (!current()) return
        if (result.ok) { setJobs((result.value as { jobs: EvaluationJob[] }).jobs ?? []); setJobsObserved(true) }
        else setContinueError(result.error.message)
        setJobsLoaded(true)
      }).catch(() => { if (current()) { setContinueError('评测任务暂不可读，请重试。'); setJobsLoaded(true) } })] : []),
      rpc.call(CHANNEL, 'home', {}).then(result => {
        if (!current()) return
        if (result.ok) {
          const data = result.value as Dashboard
          setRuns(data.recent_runs); setDashboard(data); setRunPhase('ready')
        } else { setRunError(result.error.message); setRunPhase('error') }
      }).catch(() => { if (current()) { setRunError('无法连接 Run 查询，请刷新重试。'); setRunPhase('error') } }),
      rpc.call(CHANNEL, 'mcp/control/status', {}).then(result => {
        if (!current()) return
        const value = result.ok ? result.value as { riskFacts?: RiskFact[]; configuration?: { riskAssessment?: { configured?: unknown } } } : null
        const enabled = value?.configuration?.riskAssessment?.configured
        setRiskState(previous => value && Array.isArray(value.riskFacts)
          ? { phase: 'ready', facts: value.riskFacts, enabled: typeof enabled === 'boolean' ? enabled : undefined, observed: true }
          : { ...previous, phase: 'error' })
      }).catch(() => { if (current()) setRiskState(previous => ({ ...previous, phase: 'error' })) }),
    ])
  }, workspaceScope)
  useEffect(() => { changedDomains.current.add('agents'); void refreshHome(); return () => { homeRequest.current++ } }, [workspaceScope, refresh])
  useEffect(() => updates.subscribe(() => {
    const domains = updates.getSnapshot().domains.filter(domain => ['catalog', 'agents', 'instances', 'mcp'].includes(domain))
    if (!domains.length) return
    for (const domain of domains) changedDomains.current.add(domain)
    void refreshHome()
  }), [updates])
  useEffect(() => {
    if (!active || riskState.enabled !== true || riskState.phase === 'error') return
    const now = Date.now()
    const nextExpiry = riskState.facts.reduce((next, fact) => {
      const expiry = Date.parse(fact.expiresAt)
      return expiry > now && expiry < next ? expiry : next
    }, Infinity)
    if (!Number.isFinite(nextExpiry)) return
    const timer = window.setTimeout(() => setRiskExpiryRevision(value => value + 1), Math.min(nextExpiry - now + 1, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [active, riskState.enabled, riskState.phase, riskState.facts, riskExpiryRevision])
  const sessionTasks = assets ? sessionList.ids.flatMap(id => {
    const row = sessionList.byId[id]
    if (!row || ![assets.root, ...(assets.workspace?.legacyRoots ?? [])].includes(row.cwd ?? '')) return []
    const projection = row.projectionValues?.harnessPlatformAssistant as AssistantView | undefined
    if (!projection || projection.session_id !== id || projection.workspace_id !== assets.workspace?.id) return []
    if (!row.running && !projection.pending_proposals && !projection.unknown_proposals) return []
    const priority = projection.pending_proposals ? 0 : projection.unknown_proposals ? 1 : row.running ? 2 : 3
    return [{ id, row, projection, priority }]
  }).sort((a, b) => a.priority - b.priority || b.row.updatedAt - a.row.updatedAt) : []
  const runStatusLabel = (run: RecentRun) => ({ completed: '执行结束', failed: '执行失败', cancelled: '已取消', running: '运行中', planned: '计划中' } as Record<string, string>)[run.status ?? ''] ?? '执行状态未知'
  const verdictLabel = (run: RecentRun) => run.status !== 'completed' ? '尚无业务结论' : ({ passed: '业务通过', failed: '业务未通过', inconclusive: '结论待核实' } as Record<string, string>)[run.effective_verdict ?? ''] ?? '业务结论未知'
  const versionName = (id: string) => '版本 ' + (/-([0-9]{3})(?:-r[0-9a-f]{12})?$/.exec(id)?.[1] ?? id)
  const uniqueRuns = (runs ?? []).filter((run, index, rows) => rows.findIndex(item => item.id === run.id) === index)
  const attentionRuns = runPhase !== 'error' ? uniqueRuns.filter(run => run.status === 'failed' || run.status === 'completed' && run.effective_verdict !== 'passed') : []
  const attentionRunIds = new Set(attentionRuns.map(run => run.id))
  const terminalRunIds = new Set(runPhase !== 'error' ? uniqueRuns.filter(run => ['completed', 'failed', 'cancelled'].includes(run.status ?? '')).map(run => run.id) : [])
  const visibleJobs = jobs.filter(job => ['queued', 'running', 'recovering', 'unknown', 'failed', 'completed'].includes(job.status) && (!job.run_id || !terminalRunIds.has(job.run_id)))
  const linkedJobRunIds = new Set(visibleJobs.map(job => job.run_id).filter((id): id is string => Boolean(id)))
  const recentWorkRuns = runPhase !== 'error' ? uniqueRuns.filter(run => !attentionRunIds.has(run.id) && !linkedJobRunIds.has(run.id)).slice(0, 2) : []
  const continuations = [
    ...sessionTasks.map(item => ({ kind: 'session' as const, priority: item.priority, updatedAt: item.row.updatedAt, item })),
    ...visibleJobs.map(item => ({ kind: 'job' as const,
      priority: item.status === 'unknown' ? 1 : ['queued', 'running', 'recovering'].includes(item.status) ? 2 : item.status === 'failed' ? 3 : 4,
      updatedAt: Date.parse(item.updated_at ?? item.started_at ?? '') || 0, item })),
    ...attentionRuns.map(item => ({ kind: 'run' as const, priority: 1,
      updatedAt: Date.parse(item.finished_at ?? item.created_at ?? '') || 0, item })),
  ].sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt)
  const visibleContinuations = continuations.slice(0, 4)
  const hasSessionContinuations = continuations.some(entry => entry.kind === 'session')
  const hasEvaluationContinuations = continuations.some(entry => entry.kind !== 'session')
  const mixedContinuations = hasSessionContinuations && hasEvaluationContinuations
  useEffect(() => { setContinueMenuOpen(false) }, [mixedContinuations])
  const selectedExample = exampleSources.find(source => source.source === exampleSource)
  async function enterTask(request: ReturnType<typeof homeTaskRequest>, completed?: () => void) {
    if (!assets) throw new Error('工作区尚未读取完成，请稍后重试。')
    const scope = workspaceScope
    await startConversation(assets.root, request.prompt, request.context)
    if (currentPage.current.workspaceScope !== scope) return
    completed?.()
    if (currentPage.current.active) navigate('conversations')
  }
  async function submitTask() {
    if (sending || draftPending) return
    setEntryError(''); setSending(true)
    try {
      await enterTask(homeTaskRequest(mode, prompt), () => replaceDraft(mode, ''))
    } catch (error) { setEntryError(error instanceof Error ? error.message : '无法开始任务，请重试。') }
    finally { setSending(false) }
  }
  async function showExample() {
    setExampleOpen(value => !value)
    if (exampleOpen || exampleLoading) return
    setExampleLoading(true); setExampleError(''); setExampleSources([]); setExampleSource('')
    try {
      if (!assets?.agents.some(agent => agent.id === DEMO_AGENT)) return
      const result = await rpc.call(CHANNEL, 'agents/tasks/capabilities', { agent_id: DEMO_AGENT })
      if (!result.ok) throw new Error(result.error.message)
      const found = ((result.value as any).sources ?? []).filter((source: any) => source.plugins?.some((plugin: any) => plugin.plugin_names?.some((name: string) => name.endsWith('/task-example-tools.mjs'))))
      const inspected = await Promise.all(found.map(async (source: any) => {
        const detail = await rpc.call(CHANNEL, 'agents/detail', { agent_id: DEMO_AGENT, experiment_id: source.experiment_id })
        if (!detail.ok) throw new Error(detail.error.message)
        const value = detail.value as any
        return value.evaluation?.cases?.some((item: any) => item.id === DEMO_CASE) ? { ...source, active: value.agent?.manifest?.active_experiment === source.experiment_id } : null
      }))
      const ready = inspected.filter(Boolean)
      setExampleSources(ready)
      if (ready.length) setExampleSource((ready.find(source => source.active) ?? ready[0]).source)
    } catch (error) { setExampleError(error instanceof Error ? error.message : '示例资产暂时无法读取。') }
    finally { setExampleLoading(false) }
  }
  async function launchExample() {
    if (sending) return
    setSending(true); setExampleError('')
    try {
      const source = exampleSources.find(item => item.source === exampleSource)
      if (!source) throw new Error('请选择实际已安装的示例版本。')
      const result = await rpc.call(CHANNEL, 'agents/detail', { agent_id: DEMO_AGENT, experiment_id: source.experiment_id })
      if (!result.ok) throw new Error(result.error.message)
      if (!(result.value as any).evaluation?.cases?.some((item: any) => item.id === DEMO_CASE)) throw new Error('示例版本缺少完整分页与报告的业务测试，请先在评测中心核对。')
      await enterTask({ prompt: '请体验当前工作区已经绑定的基础资产台账巡检示例：先核对实际来源和 Mock 服务，按约定业务测试读取全部分页，交付本轮实际生成的完整报告及下载。只使用基础模拟台账，不修改设备，也不称为真实设备健康检测；服务不可用时如实说明。',
        context: { page: 'home', skill: 'task-builder', workflow: 'example', entry_intent: 'example', agent_id: DEMO_AGENT, experiment_id: source.experiment_id,
          source: source.source, evaluation_case_ids: [DEMO_CASE], source_kind: 'basic_mock' } })
    } catch (error) { setExampleError(error instanceof Error ? error.message : '无法开始示例。') }
    finally { setSending(false) }
  }
  const running = dashboard?.instances.ok ? dashboard.instances.value.instances.filter(item => item.state === 'running').length : undefined
  const runningJobs = jobsObserved && !continueError ? jobs.filter(job => ['queued', 'running', 'recovering'].includes(job.status)).length : undefined
  const totalInstances = dashboard?.instances.ok ? dashboard.instances.value.instances.length : undefined
  const mcpConnections = dashboard?.mcp.ok ? dashboard.mcp.value.connections.length : undefined
  const risk = riskOverview(riskState.phase === 'pending' && riskState.observed ? 'ready' : riskState.phase, riskState.facts, riskState.enabled)
  const continueLoading = sessionList.phase === 'pending' || !jobsLoaded || runPhase === 'pending'
  const fillExampleTask = () => {
    setMode('build')
    replaceDraft('build', DEMO_BUILD_PROMPT, 'build')
    promptRef.current?.scrollIntoView?.({ block: 'center' })
    promptRef.current?.focus()
  }
  const continueAllButton = <button type="button" className="harness-home-view-all" aria-haspopup={mixedContinuations ? 'menu' : undefined} aria-expanded={mixedContinuations ? continueMenuOpen && active : undefined}
    onClick={() => mixedContinuations ? setContinueMenuOpen(open => !open) : navigate(hasSessionContinuations ? 'conversations' : { page: 'evaluation', tab: 'runs' })}
    onKeyDown={event => { if (mixedContinuations && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); setContinueMenuOpen(true) } }}>查看全部 →</button>
  return <main className="harness-home">
    <section className="harness-hero">
      <span className="harness-hero-kicker">工程工作台 · WORKSPACE</span>
      <h1>用 AI 构建和管理智能体</h1>
      <p>{HOME_SUBTITLE}</p>
      <div className="harness-task-composer">
        <form className="harness-entry" aria-busy={draftPending} onSubmit={event => { event.preventDefault(); void submitTask() }}>
          <textarea ref={promptRef} rows={1} aria-label="业务任务" placeholder={mode === 'general' ? GENERAL_PLACEHOLDER : mode === 'build' ? '描述要构建的智能体用途和目标，例如整理模拟资产台账并生成报告。' : mode === 'evaluate' ? '描述要评测的智能体和业务能力，例如评测巡检助手能否完整统计全部设备。' : mode === 'improve' ? '描述希望改进的能力，例如让巡检报告覆盖全部设备。' : '描述要管理的实例或工具，例如核对实例来源或接入 MCP 工具。'} value={prompt} disabled={sending || draftPending}
            onChange={event => replaceDraft(mode, event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submitTask() } }}/>
          <div className="harness-entry-footer"><span>{mode === 'general' ? '涉及变更时，先展示方案与影响。' : mode === 'build' ? '先了解目标与可复用资产，确认后再构建与验证。' : mode === 'evaluate' ? '先查询智能体和已有测试，确认范围后运行评测。' : mode === 'improve' ? '先查已有资产和记录，确认优化目标；最多修复 3 轮。' : '先核对实例与工具，再确认操作范围。'}</span><button className="harness-primary" type="submit" disabled={sending || draftPending || mode === 'general' && !prompt.trim()}>{draftPending && <LoadingIndicator label="恢复任务输入" />}{sending ? '正在进入…' : modeInfo?.action ?? '开始任务'}</button></div>
        </form>
        {!draftPending && draftStatus === 'unavailable' && <p role="alert">当前输入无法自动保存；离开或刷新前请复制内容。</p>}
        {mode === 'evaluate' && assets && !assets.agents.length && <p>还没有业务智能体。<button type="button" disabled={draftPending} onClick={() => selectMode('build')}>先构建一个</button></p>}
        {entryError && <p role="alert">{entryError}</p>}
      </div>
      <div className="harness-home-shortcuts"><div className="harness-entry-modes" role="group" aria-label="快捷任务">{HOME_MODES.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id && !draftPending} disabled={sending || draftPending} onClick={() => { selectMode(item.id); setEntryError(''); promptRef.current?.focus() }}><ShortcutIcon mode={item.id}/>{item.label}</button>)}</div>{mode !== 'general' && <button className="harness-free-mode" type="button" title="返回自由咨询" disabled={sending || draftPending} onClick={() => { selectMode('general'); setEntryError(''); promptRef.current?.focus() }}>自由咨询</button>}</div>
    </section>
    {state.status === 'error' && <p role="alert">{state.error}{assets && ' 保留上次查询结果。'}</p>}
    {!assets && state.status !== 'error' && <LoadingIndicator label="读取仓库" block />}
    <div className="harness-home-workspace"><div className="harness-home-primary"><section className="harness-card harness-continue" aria-label="继续处理" aria-busy={continueLoading}>
      <div className="harness-section-heading"><div><h2>继续处理{continueLoading && continuations.length > 0 && <LoadingIndicator label="更新继续处理事项" />}</h2><p>先处理需要你参与的事项，再追踪运行进展</p></div>{mixedContinuations ? <Menu open={continueMenuOpen && active} anchor={continueAllButton} compact autoFocus align="end" listClassName="harness-home-more-menu" items={[{ id: 'sessions', label: '管理对话' }, { id: 'evaluation', label: '评测记录' }]} onClose={() => setContinueMenuOpen(false)} onSelect={id => { setContinueMenuOpen(false); navigate(id === 'sessions' ? 'conversations' : { page: 'evaluation', tab: 'runs' }) }} /> : continueAllButton}</div>
      {sessionError && <p role="alert">{sessionError}</p>}
      {continueError && <p role="alert">评测任务：{continueError}</p>}
      {runPhase === 'error' && <p role="alert">最近 Run：{runError}，继续处理暂无法核对全部结果。</p>}
      {continueLoading && !continuations.length && <LoadingIndicator label="读取继续处理事项" block />}
      {sessionList.phase === 'ready' && jobsLoaded && runPhase === 'ready' && !continuations.length && !sessionError && !continueError && <p>暂无需要继续的任务。可在上方描述新任务，或查看下方最近工作。</p>}
      <div className="harness-continue-list">
        {visibleContinuations.map(entry => {
          if (entry.kind === 'session') {
            const { id, row, projection } = entry.item
            const status = projection.pending_proposals ? 'waiting' : projection.unknown_proposals ? 'unknown' : row.running ? 'running' : 'unknown'
            return <article className="harness-continue-item" key={id}>
          <ContinueIcon kind="session" tone={status === 'waiting' || status === 'unknown' ? 'warning' : 'blue'}/>
          <div className="harness-continue-content"><div className="harness-continue-title"><strong>{row.displayTitle}</strong><span className="harness-run-state" data-status={status}>{projection.pending_proposals ? '待确认' : projection.unknown_proposals ? '操作待核对' : row.running ? '运行中' : '待处理'}</span></div><small>管理任务 · {new Date(row.updatedAt).toLocaleString()}</small></div>
          <button type="button" onClick={() => { void assistant.select(id).then(() => navigate('conversations')).catch(error => setSessionError(error instanceof Error ? error.message : '无法打开原会话')) }}>继续原会话</button>
            </article>
          }
          if (entry.kind === 'run') {
            const run = entry.item
            const failed = run.status === 'failed' || run.effective_verdict === 'failed'
            return <article className="harness-continue-item" key={`run/${run.id}`}>
              <ContinueIcon kind="run" tone={failed ? 'danger' : 'warning'}/>
              <div className="harness-continue-content"><div className="harness-continue-title"><strong>{run.agent_name || run.agent_id} · {versionName(run.experiment_id)} 评测</strong><span className="harness-run-state" data-status={failed ? 'failed' : 'unknown'}>{run.status === 'failed' ? '执行失败' : run.effective_verdict === 'failed' ? '结果待处理' : run.effective_verdict === 'inconclusive' ? '结论待核实' : '结论待核对'}</span></div><small>最近 Run · {runStatusLabel(run)} · {verdictLabel(run)} · {run.finished_at || run.created_at ? new Date(run.finished_at || run.created_at || '').toLocaleString() : '时间未记录'}</small></div>
              <button type="button" onClick={() => navigate({ page: 'evaluation', tab: 'runs', agent_id: run.agent_id, experiment_id: run.experiment_id, run_id: run.id })}>查看结果</button>
            </article>
          }
          const job = entry.item
          return <article className="harness-continue-item" key={job.job_id}>
          <ContinueIcon kind="job" tone={job.status === 'failed' ? 'danger' : job.status === 'unknown' ? 'warning' : 'blue'}/>
          <div className="harness-continue-content"><div className="harness-continue-title"><strong>{job.agent_id ? `智能体 ${job.agent_id}` : '来源待核对'} · {job.experiment_id ? versionName(job.experiment_id) : job.source}</strong><span className="harness-run-state" data-status={job.status}>{jobStates[job.status] ?? '状态待核对'}</span></div><small>评测任务 · {job.updated_at ? new Date(job.updated_at).toLocaleString() : '时间未记录'}</small></div>
          <button type="button" onClick={() => navigate({ page: 'evaluation', tab: 'jobs', job_id: job.job_id, ...(job.agent_id ? { agent_id: job.agent_id } : {}), ...(job.experiment_id ? { experiment_id: job.experiment_id } : {}) })}>查看任务</button>
          </article>
        })}
      </div>
    </section>
      <section className="harness-card harness-recent-work" aria-label="最近评测" aria-busy={runPhase === 'pending'}><div className="harness-section-heading"><h2>最近评测{runPhase === 'pending' && uniqueRuns.length > 0 && <LoadingIndicator label="更新最近评测" />}</h2><button type="button" className="harness-home-view-all" onClick={() => navigate({ page: 'evaluation', tab: 'runs' })}>查看全部 →</button></div>
        {runPhase === 'error' && <p role="alert">{runError}</p>}{runPhase === 'pending' && !uniqueRuns.length && <LoadingIndicator label="读取最近评测" block />}
        {runPhase === 'ready' && uniqueRuns.length === 0 && <p>尚无 Run。进入评测中心选择用例并运行评测。</p>}
        {uniqueRuns.length > 0 && <div className="harness-home-run-overview">
          <DistributionChart title="近期评测分布" description={`${runPhase === 'ready' ? '本次读取' : runPhase === 'pending' ? '保留上次读取，更新中' : '上次读取，当前更新失败'} · 当前工作区最近 ${uniqueRuns.length} 条记录，最多 8 条；不代表累计通过率。`} segments={runOutcomeSegments(uniqueRuns)} totalLabel="条记录" />
        </div>}
        {runPhase === 'ready' && uniqueRuns.length > 0 && recentWorkRuns.length === 0 && <p>需处理的最近 Run 已列在上方；暂无其他 Run 记录。</p>}
        {recentWorkRuns.length > 0 && <div><table className="harness-home-run-table"><thead><tr><th>任务与版本</th><th>执行</th><th>有效结论</th><th>操作</th></tr></thead><tbody>{recentWorkRuns.map(run => <tr className="harness-run-row" key={`${run.experiment_id}/${run.id}`}><td data-label="任务与版本"><strong>{run.agent_name || run.agent_id} · {versionName(run.experiment_id)}</strong><small>{run.created_at ? new Date(run.created_at).toLocaleString() : '创建时间未记录'}</small></td><td data-label="执行"><span className="harness-run-state" data-status={run.status ?? 'unknown'}>{runStatusLabel(run)}</span></td><td data-label="有效结论"><span className="harness-run-state" data-status={run.effective_verdict ?? 'unknown'}>{verdictLabel(run)}</span></td><td data-label="操作"><button className="harness-run-action" type="button" onClick={() => navigate({ page: 'evaluation', tab: 'runs', agent_id: run.agent_id, experiment_id: run.experiment_id, run_id: run.id })}>查看结果</button></td></tr>)}</tbody></table></div>}
    </section></div>
    <aside className="harness-home-secondary"><section className="harness-card harness-workspace-summary" aria-label="工作区概况"><div className="harness-section-heading"><div><h2>工作区概况</h2><p>{dashboard && runPhase !== 'ready' ? runPhase === 'pending' ? '上次观察' : '读取失败，显示上次观察' : '来自当前工作区的实际观察'}</p></div><button type="button" aria-busy={runPhase === 'pending'} onClick={() => setRefresh(value => value + 1)}>{runPhase === 'pending' && <LoadingIndicator label="更新工作区概况" />}刷新</button></div><div className="harness-stats">
      {([{ kind: 'number', label: '正在运行的评测', pending: !jobsLoaded && runningJobs === undefined, value: runningJobs, page: { page: 'evaluation', tab: 'jobs' }, note: runningJobs === undefined ? continueError ? '评测任务读取失败' : '' : '查看运行任务' },
        { kind: 'number', label: '业务实例运行中', pending: !dashboard && runPhase === 'pending', value: running === undefined ? undefined : `${running} / ${totalInstances}`, page: { page: 'instances' }, note: running === undefined ? '实例状态暂不可读' : '按最近一次实例观察' },
        { kind: 'number', label: 'MCP 已登记连接', pending: !dashboard && runPhase === 'pending', value: mcpConnections, page: { page: 'mcp' }, note: mcpConnections === undefined ? '连接清单暂不可读' : '调用结果需在 MCP 页核对' },
        { kind: 'status', label: '网关风险评估', pending: riskState.phase === 'pending' && !riskState.observed, value: risk.value, page: { page: 'gateway', tab: 'risk' }, note: riskState.phase === 'pending' && riskState.observed ? `${risk.note} · 上次读取` : risk.note }] as const)
        .map(item => <button type="button" className="harness-stat" data-value-kind={item.value === undefined || item.value === '—' ? 'unknown' : item.kind} key={item.label} onClick={() => navigate(item.page)}><span>{item.label}{item.label === '网关风险评估' && riskState.phase === 'pending' && riskState.observed ? <LoadingIndicator label="更新风险评估" /> : null}</span><strong>{item.pending ? <LoadingIndicator label={`读取${item.label}`} /> : item.value ?? '—'}</strong><small>{item.pending ? '' : item.note}</small></button>)}
    </div>{dashboard && !dashboard.instances.ok && <p role="alert">实例观察失败：{dashboard.instances.error.message}</p>}{dashboard && !dashboard.mcp.ok && <p role="alert">MCP 查询失败：{dashboard.mcp.error.message}</p>}</section>
    <section className="harness-card harness-start-guide" aria-label="开始可验证的任务"><span className="harness-guide-icon" aria-hidden="true">✧</span><h2>从一个可验证的目标开始</h2><p>把想法整理成清晰的任务，再用实际结果验证。</p>
      <ol className="harness-guide-steps" aria-label="任务准备要点">
        <li><span aria-hidden="true">01</span><div><strong>明确任务</strong><p>说清要完成什么、交付什么。</p></div></li>
        <li><span aria-hidden="true">02</span><div><strong>说明输入</strong><p>列出已有资料、数据与所需工具。</p></div></li>
        <li><span aria-hidden="true">03</span><div><strong>定义验收</strong><p>给出可核对的结果或验收样例。</p></div></li>
      </ol>
      <div className="harness-guide-actions"><button type="button" className="harness-guide-action" disabled={draftPending} onClick={fillExampleTask}>填写示例任务 →</button>
      <button className="harness-example-toggle" type="button" aria-expanded={exampleOpen} disabled={!assets || exampleLoading} onClick={() => void showExample()}>体验示例 <span aria-hidden="true">→</span></button>
      </div>
      {exampleOpen && <div className="harness-example" aria-label="基础资产巡检体验示例"><strong>基础资产台账巡检</strong><p>读取五台基础模拟资产，处理分页并生成报告。使用 Mock 台账数据，不代表连接或检测真实设备。</p>
        {exampleLoading ? <LoadingIndicator label="核对当前工作区的示例资产" block /> : exampleSources.length ? <>{selectedExample && <p>将使用{versionName(selectedExample.experiment_id)}{selectedExample.active ? '（当前启用）' : ''}；开始后将核对服务和实际任务结果。</p>}{exampleSources.length > 1 && <details aria-label="可选示例版本"><summary>更换示例版本</summary><label>示例版本<select aria-label="巡检示例版本" value={exampleSource} onChange={event => setExampleSource(event.target.value)}>{exampleSources.map(source => <option key={source.source} value={source.source}>{versionName(source.experiment_id)}{source.active ? ' · 当前启用' : ''}</option>)}</select></label></details>}<button type="button" disabled={sending || !selectedExample} onClick={() => void launchExample()}>开始体验</button></> : exampleError ? <p>暂时无法核对示例资产，请稍后重新打开体验入口。</p> : <><p>当前工作区尚未安装带工具的巡检示例。可以先构建一个只整理用户给定模拟数据的智能体，或到智能体管理接入已有版本。</p><div><button type="button" onClick={() => { fillExampleTask(); setExampleOpen(false) }}>构建一个基础示例</button><button type="button" onClick={() => navigate('agents')}>查看智能体管理</button></div></>}
        {exampleError && <p role="alert">{exampleError}</p>}
      </div>}
    </section></aside>
    </div>
    {assets && <p className="harness-source">状态来自当前工作区；点击条目核对具体结果。</p>}
  </main>
}
