import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { CaseCreationDialog } from './cases-editor.tsx'
import { RunTraceView } from './trace-view.tsx'
import { DecisionDatasetView } from './dataset-view.tsx'
import { RunComparisonFacts } from './comparison-view.tsx'
import { CHANNEL } from '../protocol.ts'
import { SearchSelect } from '../components/search-select.tsx'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { DistributionChart, type ChartSegment } from '../components/overview-charts.tsx'
import { caseObservation, observationLabel, type CaseObservation } from './case-observation.ts'
import type { PlatformNavigation, PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'

type Tab = 'cases' | 'jobs' | 'runs' | 'compare'
type RunTab = 'report' | 'results' | 'files' | 'datasets'
const runTabValue = (value: PlatformNavigation['run_tab']): RunTab => value === 'trace' ? 'files' : value ?? 'report'
const isTraceFile = (path: string) => /(?:^|\/)(?:trace|judge-trace)\.jsonl$/.test(path)
const evaluationRequestId = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, marker => {
  const value = Math.floor(Math.random() * 16)
  return (marker === 'x' ? value : value & 3 | 8).toString(16)
})
type RpcResult = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }
type Agent = { id: string; name?: string; active_experiment?: string | null }
type CaseCounts = { total: number; passed: number; failed: number; inconclusive: number; mixed: number; pending: number }
type Run = { stale?: boolean; run_id: string; experiment_id: string; agent_id: string; status?: string; created_at?: string; finished_at?: string; effective_verdict?: string | null; title?: string | null; case_scope?: string | null; case_counts?: CaseCounts | null }
type EvaluationJob = { job_id: string; source: string; agent_id?: string | null; experiment_id?: string | null; status: string; run_id?: string; started_at: string; updated_at?: string; error?: string }
type EvaluationSubmission = { request_id: string; payload: Record<string, unknown>; agentId: string; experimentId: string; runId: string; tab: string; runSelection: number }
const submissionKey = () => `harness-evaluation-pending:${new URL('.', document.baseURI).href}`
function savedSubmission(): EvaluationSubmission | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(submissionKey()) ?? 'null')
    return value && /^[0-9a-f-]{36}$/.test(value.request_id) && typeof value.agentId === 'string' && typeof value.experimentId === 'string'
      && value.payload?.source === `experiment:${value.experimentId}` ? value : null
  } catch { return null }
}
function saveSubmission(value: EvaluationSubmission): boolean {
  try { const text = JSON.stringify(value); window.sessionStorage.setItem(submissionKey(), text); return window.sessionStorage.getItem(submissionKey()) === text }
  catch { return false }
}
function clearSubmission(value: EvaluationSubmission) {
  try { if (savedSubmission()?.request_id === value.request_id) window.sessionStorage.removeItem(submissionKey()) } catch {}
}
type CaseDraft = { title: string; inputs: string[]; expected_behavior: string; fast: boolean }
type CaseDocument = { case: { id: string; title: string; inputs: string[]; expected_behavior: string; scene?: string; tier?: string; fast?: boolean }; sha256: string; path: string }
type RunFile = { path: string; size: number; kind: 'text' | 'binary' }
type EvaluationPageProps = PlatformPageProps & {
  updates?: PlatformUpdates
  onAssistant?(task: string, context: Record<string, unknown>): Promise<void>
  onContext?(context: Record<string, unknown>): void
  target?: PlatformNavigation
  onNavigate?(target: PlatformNavigation): void
  active?: boolean
}
const tabs: { id: Tab; label: string }[] = [{ id: 'runs', label: '评测记录' }, { id: 'cases', label: '测试用例' }, { id: 'compare', label: '结果比较' }]
const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
const statusLabels: Record<string, string> = { planned: '计划中', running: '运行中', cancelling: '正在取消', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '状态待核对', passed: '通过', inconclusive: '无法判定', error: '执行错误', skipped: '已跳过', not_requested: '未请求', pending: '等待中' }
const label = (value: unknown) => typeof value === 'string' ? statusLabels[value] ?? value : '未记录'
const executionLabel = (value: unknown) => value === 'completed' ? '已结束' : value === 'failed' ? '执行错误' : label(value)
const verdictLabel = (value: unknown) => value === 'failed' ? '未通过' : value === 'passed' ? '通过' : value === 'inconclusive' ? '无法判定' : '尚无结论'
const verdictIfCompleted = (status: unknown, verdict: unknown) => status === 'completed' && typeof verdict === 'string' && ['passed', 'failed', 'inconclusive'].includes(verdict) ? verdict : null
const summaryVerdict = (summary: any) => summary?.effective_verdict ?? summary?.machine_overall_verdict ?? summary?.overall_verdict
const json = (value: unknown) => JSON.stringify(value, null, 2) ?? '未记录'
const time = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : '未记录'
const elapsed = (value: unknown) => {
  const started = typeof value === 'string' ? Date.parse(value) : NaN
  if (Number.isNaN(started) || started > Date.now()) return ''
  const minutes = Math.floor((Date.now() - started) / 60000)
  return minutes < 60 ? `已用 ${minutes} 分钟` : `已用 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}
const versionName = (value: string) => {
  const match = value.match(/-(\d{3})(?:-r[0-9a-f]{12})?$/)
  return match ? `v${match[1]}` : value
}
const tabValue = (value?: string): Tab => value === 'jobs' ? 'jobs' : tabs.some(item => item.id === value) ? value as Tab : 'runs'
const isFinal = (status?: string) => ['completed', 'failed', 'cancelled'].includes(status ?? '')
const draftFor = (document: CaseDocument): CaseDraft => ({ title: document.case.title ?? '', inputs: [...(document.case.inputs ?? [])], expected_behavior: document.case.expected_behavior ?? '', fast: document.case.fast ?? document.case.tier === 'fast' })
const caseSummary = (counts: CaseCounts | null | undefined) => {
  if (!counts || ![counts.total, counts.passed, counts.failed, counts.inconclusive, counts.mixed, counts.pending].every(value => Number.isInteger(value) && value >= 0)
    || counts.passed + counts.failed + counts.inconclusive + counts.mixed + counts.pending !== counts.total) return null
  return `${counts.passed} 通过 / ${counts.failed} 未通过 / ${counts.inconclusive} 无法判定${counts.mixed || counts.pending ? ` / ${counts.mixed + counts.pending} 待核对` : ''}`
}

function Raw({ value, title = '原始记录', active, identity, inline = false }: { value: unknown; title?: string; active?: boolean; identity?: string; inline?: boolean }) {
  return inline ? <details className="harness-eval-raw"><summary>{title}</summary><pre>{json(value)}</pre></details> : <DetailDrawer title={title} active={active} identity={identity}><pre>{json(value)}</pre></DetailDrawer>
}
function Facts({ items }: { items: [string, unknown][] }) {
  return <dl className="harness-eval-facts">{items.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{typeof value === 'string' || typeof value === 'number' ? value || '未记录' : value === true ? '是' : value === false ? '否' : '未记录'}</dd></div>)}</dl>
}
function Empty({ children }: { children: React.ReactNode }) { return <div className="harness-eval-empty">{children}</div> }
type PairedCaseRows = { inputs: number; outputs: number; trials: number }
function RunCase({ item, onEvidence, active, identity, paired }: { item: any; onEvidence(path: string): void; active: boolean; identity: string; paired?: PairedCaseRows }) {
  const frozen = item.frozen
  const observation = caseObservation(item)
  const observedReason = item.review?.reason || item.trials?.find((trial: any) => ['failed', 'inconclusive'].includes(trial.verdict))?.failure_reason || item.trials?.find((trial: any) => ['failed', 'inconclusive'].includes(trial.verdict))?.observation
  const inputs: string[] = frozen?.inputs ?? []
  const outputs: unknown[] = Array.isArray(item.output) ? item.output : []
  const trials: any[] = Array.isArray(item.trials) ? item.trials : []
  const parts: { id: string; content: React.ReactNode }[] = [
    { id: 'case-heading', content: <div className="harness-eval-section-heading"><h3>{frozen?.title || item.case_id}<small className="harness-eval-muted">{item.case_id}</small></h3><span className="harness-eval-badge" data-state={observation.value}>{observationLabel(observation.value)}</span></div> },
    { id: 'summary', content: <div className="harness-eval-case-evidence-summary"><strong>可读证据摘要</strong><p>{observedReason || '尚未记录可读原因；请核对下方机器结果、实际回答与证据文件。'}</p><small>{observation.source} · {frozen ? '以下记录使用本次 Run 冻结的用例定义。' : '此历史 Run 未冻结用例定义，需核对保存的证据。'}</small></div> },
  ]
  if (paired || item.contract_changed === true) parts.push({ id: 'contract', content: item.contract_changed === true && <p className="harness-eval-note">当前用例定义已修改；本结果保留运行时的冻结输入与判定标准。</p> })
  if (frozen || paired) parts.push({ id: 'inputs-title', content: <h4>冻结输入</h4> })
  if (paired) for (let index = 0; index < paired.inputs; index++) parts.push({ id: `input-${index}`, content: inputs[index] !== undefined ? <ol className="harness-eval-turns" start={index + 1}><li>{inputs[index]}</li></ol> : <p>{!frozen && index === 0 ? '历史 Run 未冻结用例定义。' : `未记录第 ${index + 1} 轮冻结输入。`}</p> })
  else parts.push({ id: 'input', content: frozen ? <ol className="harness-eval-turns">{inputs.map((input, index) => <li key={index}>{input}</li>)}</ol> : <p>历史 Run 未冻结用例定义。</p> })
  if (frozen || paired) parts.push({ id: 'expected', content: <><h4>预期行为</h4><p className="harness-eval-preserve">{frozen?.expected_behavior || (frozen ? '未记录' : '此历史 Run 未冻结预期行为。')}</p></> })
  parts.push({ id: 'outputs-title', content: <h4>智能体回答</h4> })
  for (let index = 0; index < (paired?.outputs ?? Math.max(1, outputs.length)); index++) parts.push({ id: `output-${index}`, content: index < outputs.length ? <div className="harness-eval-answer"><small>第 {index + 1} 轮</small><MarkdownText text={typeof outputs[index] === 'string' ? outputs[index] as string : json(outputs[index])} labels={markdownLabels} /></div> : paired ? <div className="harness-eval-answer"><small>第 {index + 1} 轮</small><p>未采集到第 {index + 1} 轮回答。</p></div> : <p>未采集到回答。</p> })
  parts.push({ id: 'trials-title', content: <h4>机器结果</h4> })
  for (let index = 0; index < (paired?.trials ?? Math.max(1, trials.length)); index++) {
    const trial = trials[index]
    parts.push({ id: `trial-${index}`, content: trial ? <div className="harness-eval-observation"><span className="harness-eval-badge" data-state={trial.verdict}>{label(trial.execution_status)} · {label(trial.verdict)}</span><p>{trial.observation}</p>{trial.failure_reason && <p role="alert">{trial.failure_reason}</p>}</div> : <p>{paired ? `未记录第 ${index + 1} 次 Trial 结果。` : '尚无 Trial 结果。'}</p> })
  }
  if (item.review || paired) parts.push({ id: 'review', content: <><h4>证据复核</h4><p>{item.review ? <>{label(item.review.reviewed_verdict)} · {item.review.reason}</> : '未记录证据复核。'}</p></> })
  parts.push({ id: 'tools', content: <><h4>实际工具调用</h4>{item.tool_calls?.length ? <ul>{item.tool_calls.map((tool: any, index: number) => <li key={index}>{tool.name || '未记录名称'} · {label(tool.status)}{tool.error_code ? ` · ${tool.error_code}` : ''}</li>)}</ul> : <p>未记录工具调用。</p>}</> })
  parts.push({ id: 'evidence', content: <>{paired && <h4>证据文件</h4>}<div className="harness-eval-actions">{(item.evidence ?? []).map((file: any) => <button key={file.path} type="button" disabled={!file.present} onClick={() => onEvidence(file.path)}>{file.path.split('/').pop()}{!file.present ? '（缺失）' : ''}</button>)}</div>{paired && !item.evidence?.length && <p>未记录证据文件。</p>}</> })
  parts.push({ id: 'raw', content: <Raw value={item} title="用例原始记录、装载观察与证据引用" active={active} identity={`${identity}:${item.case_id}`} /> })
  return <article className="harness-eval-case-result">{parts.map(part => paired ? <div key={part.id} className="harness-eval-case-part" data-case-part={part.id}>{part.content}</div> : <Fragment key={part.id}>{part.content}</Fragment>)}</article>
}

export function EvaluationPage({ rpc, updates, onAssistant, onContext, target, onNavigate, active = true }: EvaluationPageProps) {
  const [tab, setTab] = useState<Tab>(tabValue(target?.tab))
  const [agentId, setAgentId] = useState(target?.agent_id ?? '')
  const [experimentId, setExperimentId] = useState(target?.experiment_id ?? '')
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentsError, setAgentsError] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const [detailError, setDetailError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [runs, setRuns] = useState<Run[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [runListReady, setRunListReady] = useState(false)
  const [runStatus, setRunStatus] = useState('')
  const [runVerdictFilter, setRunVerdictFilter] = useState('')
  const [runSearch, setRunSearch] = useState('')
  const [recordExpanded, setRecordExpanded] = useState(false)
  const [scopeFiltersOpen, setScopeFiltersOpen] = useState(false)
  const [caseSearch, setCaseSearch] = useState('')
  const [sceneFilter, setSceneFilter] = useState('')
  const [tierFilter, setTierFilter] = useState('')
  const [selectedCases, setSelectedCases] = useState<string[]>([])
  const [caseScope, setCaseScope] = useState<'fast' | 'full' | 'selected'>('fast')
  const [newCaseSearch, setNewCaseSearch] = useState('')
  const [caseId, setCaseId] = useState(target?.tab === 'cases' ? target.case_id ?? '' : '')
  const [caseDocument, setCaseDocument] = useState<CaseDocument | null>(null)
  const [caseDraft, setCaseDraft] = useState<CaseDraft | null>(null)
  const [caseEditing, setCaseEditing] = useState(false)
  const [caseBusy, setCaseBusy] = useState(false)
  const [caseMessage, setCaseMessage] = useState('')
  const [caseConflict, setCaseConflict] = useState(false)
  const [caseLatest, setCaseLatest] = useState<CaseDocument | null>(null)
  const [runId, setRunId] = useState(target?.run_id ?? '')
  const [runDetail, setRunDetail] = useState<any>(null)
  const [runError, setRunError] = useState('')
  const [runLoading, setRunLoading] = useState(false)
  const [report, setReport] = useState<any>(null)
  const [reportError, setReportError] = useState('')
  const [runFiles, setRunFiles] = useState<any>(null)
  const [filesError, setFilesError] = useState('')
  const [newCase, setNewCase] = useState<{ agent: string; experiment: string; source?: { run_id: string; case_id: string } } | null>(null)
  const [newCaseDirty, setNewCaseDirty] = useState(false)
  const [newCaseBusy, setNewCaseBusy] = useState(false)
  const [datasetDirty, setDatasetDirty] = useState(false)
  const [datasetBusy, setDatasetBusy] = useState(false)
  const [datasetEpoch, setDatasetEpoch] = useState(0)
  const [extractError, setExtractError] = useState('')
  const [extractBusy, setExtractBusy] = useState(false)
  const [runTab, setRunTab] = useState<RunTab>(target?.tab === 'runs' && target.run_id ? target.case_id ? 'results' : runTabValue(target.run_tab) : 'report')
  const [datasetSource, setDatasetSource] = useState<{ path: string; line: number; source_sha256?: string } | null>(null)
  const [resultCaseId, setResultCaseId] = useState(target?.tab === 'runs' && target.run_id ? target.case_id ?? '' : '')
  const [fileSearch, setFileSearch] = useState('')
  const [filePath, setFilePath] = useState('')
  const [fileView, setFileView] = useState<'structured' | 'raw'>('structured')
  const fileSelection = useRef<{ run: string; path: string } | null>(null)
  const [filePreview, setFilePreview] = useState<any>(null)
  const [fileError, setFileError] = useState('')
  const pendingEvidence = useRef<{ run: string; path: string } | null>(null)
  const [leftRun, setLeftRun] = useState('')
  const [rightRun, setRightRun] = useState('')
  const [comparison, setComparison] = useState<any>(null)
  const [compareCaseId, setCompareCaseId] = useState('')
  const [compareError, setCompareError] = useState('')
  const [compareBusy, setCompareBusy] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [executor, setExecutor] = useState('api')
  const [review, setReview] = useState('none')
  const [evalPreview, setEvalPreview] = useState<any>(null)
  const [evalError, setEvalError] = useState('')
  const [evalBusy, setEvalBusy] = useState(false)
  const [evalPending, setEvalPending] = useState<EvaluationSubmission | null>(savedSubmission)
  const evalSubmission = useRef(evalPending), evalSending = useRef(false), evalPersisted = useRef(!!evalPending)
  const [job, setJob] = useState<any>(null)
  const [jobError, setJobError] = useState('')
  const cancellingJob = useRef('')
  const [cancelJobId, setCancelJobId] = useState('')
  const [jobs, setJobs] = useState<EvaluationJob[]>([])
  const [jobsError, setJobsError] = useState('')
  const [jobsLoading, setJobsLoading] = useState(false)
  const jobNavigation = useRef<{ job_id: string; run_id?: string; agent_id: string; experiment_id: string; initial_run_id: string; run_selection_version: number } | null>(null)
  const runSelectionVersion = useRef(0)
  const previousTarget = useRef({ run_id: target?.run_id, job_id: target?.job_id })
  const [decisionOpen, setDecisionOpen] = useState(false)
  const [decisionTarget, setDecisionTarget] = useState({ agent: '', experiment: '' })
  const [decision, setDecision] = useState({ body: '', hash: '', saved: '' })
  const [decisionBusy, setDecisionBusy] = useState(false)
  const [decisionMessage, setDecisionMessage] = useState('')
  const [decisionConflict, setDecisionConflict] = useState(false)
  const [decisionLatest, setDecisionLatest] = useState<{ body: string; hash: string } | null>(null)
  const configDialog = useRef<HTMLDialogElement>(null)
  const decisionDialog = useRef<HTMLDialogElement>(null)
  const cancelDialog = useRef<HTMLDialogElement>(null)
  const listRequest = useRef(0), runsRequest = useRef(0), jobsRequest = useRef(0), detailRequest = useRef(0), caseRequest = useRef(0), runRequest = useRef(0), fileRequest = useRef(0), compareRequest = useRef(0), evalRequest = useRef(0), decisionRequest = useRef(0)
  const runDetailHeading = useRef<HTMLHeadingElement>(null)
  const jobDetailHeading = useRef<HTMLElement>(null)
  const runListHeading = useRef<HTMLElement>(null)
  const runListTrigger = useRef<HTMLElement | null>(null)
  const recordScope = useRef<{ agent: string; experiment: string } | null>(null)
  const returnToComparison = useRef(false)
  const focusRunDetail = useRef(Boolean(target?.run_id && tabValue(target?.tab) === 'runs'))
  const focusJobDetail = useRef(Boolean(target?.job_id && tabValue(target?.tab) === 'jobs'))
  const caseDirty = !!caseDocument && !!caseDraft && JSON.stringify(caseDraft) !== JSON.stringify(draftFor(caseDocument))
  const decisionDirty = decision.body !== decision.saved
  const current = useRef({ caseDirty, decisionDirty, datasetDirty, datasetBusy, newCaseDirty, newCaseBusy, caseBusy, decisionBusy, agentId, experimentId, tab, runId, caseId, active, targetJobId: target?.job_id, targetRunId: target?.run_id ?? '' })
  current.current = { caseDirty, decisionDirty, datasetDirty, datasetBusy, newCaseDirty, newCaseBusy, caseBusy, decisionBusy, agentId, experimentId, tab, runId, caseId, active, targetJobId: target?.job_id, targetRunId: target?.run_id ?? '' }
  const refreshTimer = useRef<number | undefined>(undefined)
  const refreshRunning = useRef(false)
  const refreshPending = useRef(false)
  const refreshOnActive = useRef(false)
  const refreshTask = useRef<() => Promise<void>>(async () => {})
  const refreshSnapshot = useRef({ caseBusy, caseId, experimentId, runId, job })
  refreshSnapshot.current = { caseBusy, caseId, experimentId, runId, job }
  const decisionSnapshot = useRef({ open: decisionOpen, target: decisionTarget, hash: decision.hash })
  decisionSnapshot.current = { open: decisionOpen, target: decisionTarget, hash: decision.hash }
  const cases: any[] = detail?.evaluation?.cases ?? []

  async function call(operation: string, payload: Record<string, unknown> = {}) {
    const result = await rpc.call(CHANNEL, `agents/${operation}`, payload) as RpcResult
    if (!result.ok) throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), { rejected: true })
    return result.value
  }
  function location(overrides: Partial<PlatformNavigation> = {}): PlatformNavigation {
    return { page: 'evaluation', tab, agent_id: agentId || undefined, experiment_id: experimentId || undefined, run_id: runId || undefined, run_tab: tab === 'runs' && runTab !== 'report' ? runTab : undefined, case_id: caseId || undefined, job_id: target?.job_id, ...overrides }
  }
  function leaveDrafts() {
    if (current.current.caseBusy || current.current.decisionBusy || current.current.datasetBusy || current.current.newCaseBusy) return false
    const confirmed = !(current.current.caseDirty || current.current.decisionDirty || current.current.datasetDirty || current.current.newCaseDirty) || window.confirm('当前有未保存的用例、样本或研究决策。离开将丢弃草稿，是否继续？')
    if (confirmed && current.current.datasetDirty) { setDatasetEpoch(value => value + 1); setDatasetDirty(false) }
    if (confirmed && current.current.newCaseDirty) setNewCase(null)
    return confirmed
  }
  function resetScope(nextAgent: string, nextExperiment: string) {
    recordScope.current = null
    detailRequest.current++; caseRequest.current++; evalRequest.current++; compareRequest.current++; decisionRequest.current++
    setNewCase(null); setAgentId(nextAgent); setExperimentId(nextExperiment); setDetail(null); setCaseId(''); setCaseDocument(null); setCaseDraft(null); setCaseLatest(null); setCaseEditing(false); setSelectedCases([]); setCaseMessage(''); setCaseConflict(false)
    setDecisionOpen(false); setDecision({ body: '', hash: '', saved: '' }); setDecisionLatest(null); setConfigOpen(false); setEvalPreview(null); setEvalError(''); setEvalBusy(false)
    setComparison(null); setCompareCaseId(''); setCompareError(''); setCompareBusy(false); setLeftRun(''); setRightRun(''); setSceneFilter(''); setTierFilter(''); setRunId('')
  }
  function changeScope(nextAgent: string, nextExperiment = '') {
    if (nextAgent === agentId && nextExperiment === experimentId) return
    if (!leaveDrafts()) return
    resetScope(nextAgent, nextExperiment)
    onNavigate?.(location({ agent_id: nextAgent || undefined, experiment_id: nextExperiment || undefined, case_id: undefined, run_id: undefined, job_id: undefined }))
  }
  function chooseCase(id: string) {
    if (id === caseId || !leaveDrafts()) return
    caseRequest.current++; setCaseId(id); setCaseDocument(null); setCaseDraft(null); setCaseLatest(null); setCaseEditing(false); setCaseMessage(''); setCaseConflict(false)
    onNavigate?.(location({ case_id: id }))
  }
  function returnToRecords() {
    if (!leaveDrafts()) return
    const scope = (tab === 'jobs' || tab === 'runs' && runId ? recordScope.current : null) ?? { agent: agentId, experiment: experimentId }
    recordScope.current = null
    setAgentId(scope.agent); setExperimentId(scope.experiment); setRunId(''); setTab('runs'); setResultCaseId('')
    onNavigate?.({ page: 'evaluation', tab: 'runs', agent_id: scope.agent || undefined, experiment_id: scope.experiment || undefined })
    window.setTimeout(() => { const destination = runListTrigger.current?.isConnected ? runListTrigger.current : runListHeading.current; destination?.scrollIntoView({ block: 'center' }); destination?.focus({ preventScroll: true }) }, 0)
  }
  function chooseRun(id: string, nextTab: Tab = tab, automatic = false, relatedJobId?: string) {
    if (id !== runId && !leaveDrafts()) return
    if (!automatic) {
      if (tab === 'runs' && !runId) { recordScope.current = { agent: agentId, experiment: experimentId }; returnToComparison.current = false }
      runSelectionVersion.current++
      if (typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement) runListTrigger.current = document.activeElement
      focusRunDetail.current = true
    }
    if (id !== runId) {
      runRequest.current++; fileRequest.current++; setRunId(id); setRunDetail(null); setReport(null); setRunFiles(null); setResultCaseId(''); setFilePath(''); setFilePreview(null)
    }
    setTab(nextTab); setRunTab('report')
    onNavigate?.(location({ tab: nextTab, run_id: id, run_tab: undefined, case_id: undefined, job_id: automatic ? target?.job_id : relatedJobId, replace: automatic || undefined }))
  }
  function chooseRunTab(next: RunTab) {
    if (next === runTab && target?.run_tab !== 'trace' && (!target?.case_id || next === 'results')) return
    setRunTab(next)
    const selectedCase = next === 'results' ? target?.case_id : undefined
    onNavigate?.(location({ tab: 'runs', run_id: runId || undefined, run_tab: next === 'report' || selectedCase ? undefined : next, case_id: selectedCase }))
  }
  function chooseTab(next: Tab, overrides: Partial<PlatformNavigation> = {}) {
    current.current = { ...current.current, tab: next }
    if (next !== 'runs') focusRunDetail.current = false
    setTab(next); onNavigate?.(location({ tab: next, run_tab: next === 'runs' && runTab !== 'report' ? runTab : undefined, ...overrides }))
  }
  async function loadAgents() {
    const request = ++listRequest.current
    setRunListReady(false)
    try { const value = await call('list'); if (request === listRequest.current) { setAgents(value.agents ?? []); setAgentsError(''); if (!(value.agents ?? []).length) setRunListReady(true) } }
    catch (error) { if (request === listRequest.current) { setAgentsError((error as Error).message); setRunListReady(true) } }
  }
  async function loadJobs() {
    const request = ++jobsRequest.current
    setJobsLoading(true); setJobsError('')
    try { const value = await call('eval/list'); if (request === jobsRequest.current) setJobs(value.jobs ?? []) }
    catch (error) { if (request === jobsRequest.current) setJobsError((error as Error).message) }
    finally { if (request === jobsRequest.current) setJobsLoading(false) }
  }
  function chooseJob(selected: EvaluationJob) {
    if (!leaveDrafts()) return
    focusRunDetail.current = false
    focusJobDetail.current = true
    if (typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement && document.activeElement.closest('.harness-eval-record-list, #evaluation-panel-jobs')) runListTrigger.current = document.activeElement
    const nextAgent = selected.agent_id ?? ''
    const nextExperiment = selected.experiment_id ?? ''
    if (nextAgent !== agentId || nextExperiment !== experimentId) resetScope(nextAgent, nextExperiment)
    current.current = { ...current.current, tab: 'jobs', agentId: nextAgent, experimentId: nextExperiment, runId: '' }
    jobNavigation.current = { job_id: selected.job_id, agent_id: nextAgent, experiment_id: nextExperiment,
      initial_run_id: '', run_selection_version: runSelectionVersion.current, run_id: selected.run_id }
    recordScope.current = { agent: agentId, experiment: experimentId }
    returnToComparison.current = false
    setJob(selected); setJobError(''); setTab('jobs')
    onNavigate?.({ page: 'evaluation', tab: 'jobs', job_id: selected.job_id,
      agent_id: nextAgent || undefined, experiment_id: nextExperiment || undefined })
    void statusEvaluation(selected.job_id)
  }
  async function loadRuns() {
    const request = ++runsRequest.current
    setRunListReady(false); setRunsLoading(true); setRunsError('')
    try {
      const value = await call('runs/overview') as { agents?: any[]; errors?: { agent_id: string; experiment_id?: string; run_id?: string; path: string; error: string }[] }
      if (request !== runsRequest.current) return
      // 汇总读取一次返回全部 Agent，避免按 Agent 重复启动 Run 索引解析。
      const rows = (value.agents ?? []).flatMap(agent => (agent.experiments ?? []).flatMap((experiment: any) =>
        (experiment.runs ?? []).map((run: any) => ({
          ...run, run_id: run.run_id ?? run.id, experiment_id: experiment.experiment_id ?? experiment.id, agent_id: agent.agent_id,
        })))) as Run[]
      const errors = value.errors ?? []
      setRuns(previous => [...rows, ...previous.filter(run => !rows.some(row => row.run_id === run.run_id)
        && errors.some(error => error.agent_id === run.agent_id && (!error.experiment_id || error.experiment_id === run.experiment_id)
          && (!error.run_id || error.run_id === run.run_id))).map(run => ({ ...run, stale: true }))]
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')))
      setRunsError(errors.length ? `部分记录读取失败，相关历史结果保留为上次读取状态：${errors.map(error => `${error.path}（${error.error}）`).join('；')}` : '')
    } catch (error) {
      // 读取失败保留上次结果，避免把已经看到的记录清空。
      if (request === runsRequest.current) { setRunsError((error as Error).message); setRuns(previous => previous.map(run => ({ ...run, stale: true }))) }
    } finally {
      if (request === runsRequest.current) { setRunsLoading(false); setRunListReady(true) }
    }
  }
  async function runRefresh() {
    if (refreshRunning.current) { refreshPending.current = true; return }
    refreshRunning.current = true
    const snapshot = refreshSnapshot.current
    try {
      const tasks: Promise<unknown>[] = [loadAgents(), loadJobs(), loadRuns(), loadDetail()]
      if (evalSubmission.current && !evalSending.current) tasks.push(recoverPendingEvaluation())
      if (snapshot.caseId && snapshot.experimentId && !snapshot.caseBusy) tasks.push(loadCase())
      if (snapshot.runId) tasks.push(loadRun())
      if (snapshot.job?.job_id && !isFinal(snapshot.job.status)) tasks.push(statusEvaluation())
      await Promise.allSettled(tasks)
    } finally {
      refreshRunning.current = false
      if (refreshPending.current) { refreshPending.current = false; scheduleRefresh(0) }
    }
  }
  refreshTask.current = runRefresh
  /** 通知先合并 250ms；同一页面只允许一批刷新在途，结束后再补一次。 */
  function scheduleRefresh(delay = 250) {
    if (!current.current.active) { refreshOnActive.current = true; return }
    if (refreshTimer.current !== undefined) return
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = undefined
      if (!current.current.active) { refreshOnActive.current = true; return }
      void refreshTask.current()
    }, delay)
  }
  function refreshNow() {
    if (refreshTimer.current !== undefined) { window.clearTimeout(refreshTimer.current); refreshTimer.current = undefined }
    refreshOnActive.current = false
    void refreshTask.current()
  }
  async function loadDetail() {
    const request = ++detailRequest.current
    if (!agentId) { setDetail(null); setDetailLoading(false); return }
    setDetailLoading(true); setDetailError('')
    try {
      const value = await call('detail', { agent_id: agentId, ...(experimentId ? { experiment_id: experimentId } : {}) })
      if (request !== detailRequest.current) return
      setDetail(value)
      if (!experimentId && (tab === 'cases' || configOpen)) setExperimentId(value.experiment.id)
      setSelectedCases(current => current.filter(id => value.evaluation.cases.some((item: any) => item.id === id)))
    } catch (error) { if (request === detailRequest.current) setDetailError((error as Error).message) }
    finally { if (request === detailRequest.current) setDetailLoading(false) }
  }
  async function loadCase() {
    const request = ++caseRequest.current
    if (!experimentId || !caseId) return
    setCaseMessage('正在读取用例…')
    try {
      const value = await call('cases/read', { experiment_id: experimentId, case_id: caseId }) as CaseDocument
      if (request !== caseRequest.current) return
      if (current.current.caseDirty) {
        if (caseDocument?.sha256 !== value.sha256) { setCaseConflict(true); setCaseLatest(value) }
        setCaseMessage('当前草稿已保留，未用远端内容覆盖。')
        return
      }
      setCaseDocument(value); setCaseDraft(draftFor(value)); setCaseLatest(null); setCaseMessage(''); setCaseConflict(false)
    } catch (error) { if (request === caseRequest.current) setCaseMessage((error as Error).message) }
  }
  async function saveCase() {
    if (!caseDraft || !caseDocument || caseBusy) return
    const request = caseRequest.current
    setCaseBusy(true); setCaseMessage('正在校验并保存…')
    try {
      const value = await call('cases/update', { experiment_id: experimentId, case_id: caseId, ...caseDraft, expected_sha256: caseDocument.sha256 }) as CaseDocument
      if (request !== caseRequest.current) return
      setCaseDocument(value); setCaseDraft(draftFor(value)); setCaseLatest(null); setCaseEditing(false); setCaseConflict(false); setCaseMessage('已保存。后续评测立即使用新定义；已启动的 Run 保留冻结口径。'); setEvalPreview(null)
      await loadDetail()
    } catch (error) { if (request === caseRequest.current) { setCaseMessage(`${(error as Error).message}；草稿已保留。`); if ((error as Error).message.startsWith('conflict:')) setCaseConflict(true) } }
    finally { setCaseBusy(false) }
  }
  async function loadRun(id = runId) {
    const request = ++runRequest.current
    if (runDetail?.run_id !== id) { setRunDetail(null); setReport(null); setRunFiles(null); setFilePreview(null); setFilePath('') }
    setRunError(''); setReportError(''); setFilesError('')
    if (!id) { setRunLoading(false); return }
    setRunLoading(true)
    const results = await Promise.allSettled([call('runs/show', { run_id: id }), call('runs/report', { run_id: id }), call('runs/files', { run_id: id })])
    if (request !== runRequest.current || current.current.runId !== id) return
    const [view, document, files] = results
    if (view.status === 'fulfilled') { setRunDetail(view.value); setResultCaseId(current => view.value.cases?.some((item: any) => item.case_id === current) ? current : view.value.cases?.[0]?.case_id ?? '') } else setRunError(view.reason.message)
    if (document.status === 'fulfilled') setReport(document.value); else setReportError(document.reason.message)
    if (files.status === 'fulfilled') setRunFiles(files.value); else setFilesError(files.reason.message)
    setRunLoading(false)
  }
  async function openFile(path: string) {
    // Markdown 的本地链接仅能命中本次 Run 文件目录；目录链接展开为目录筛选。
    const files: RunFile[] = runFiles?.files ?? []
    const marker = `/runs/${runId}/`
    const rootedFile = files.find(file => file.path.includes(marker))?.path
    const prefix = runDetail?.run_path ? `${runDetail.run_path}/` : rootedFile ? rootedFile.slice(0, rootedFile.indexOf(marker) + marker.length) : ''
    let decoded: string
    try { decoded = decodeURIComponent(path).replace(/^\.\//, '').replace(/#.*$/, '') } catch { decoded = path }
    const match = files.find(file => file.path === decoded || file.path === `${prefix}${decoded}`)
    chooseRunTab('files')
    if (!match) {
      const folder = decoded.replace(/\/$/, '')
      if (files.some(file => file.path.startsWith(`${prefix}${folder}/`) || file.path.startsWith(`${folder}/`))) { setFileSearch(folder); setFileError(''); return }
      setFileError('此链接未对应当前 Run 中已保存的文件。请从文件清单选择。'); return
    }
    const request = ++fileRequest.current
    const selectedRun = runId
    fileSelection.current = { run: runId, path: match.path }
    setFilePath(match.path); setFileView(isTraceFile(match.path) ? 'structured' : 'raw'); setFilePreview(null); setFileError('')
    if (match.kind === 'binary') return
    try { const value = await call('runs/read-file', { run_id: runId, path: match.path }); if (request === fileRequest.current && current.current.runId === selectedRun) setFilePreview(value) }
    catch (error) { if (request === fileRequest.current && current.current.runId === selectedRun) setFileError((error as Error).message) }
  }
  async function extractDecisionSamples() {
    if (!runDetail || !onAssistant || extractBusy) return
    const context = { page: 'evaluation', run_id: runId, agent_id: runDetail.manifest.agent_id, experiment_id: runDetail.manifest.experiment_id, skill: 'decision-sample-extraction' }
    setExtractBusy(true); setExtractError('')
    try { await onAssistant('请读取并使用 decision-sample-extraction Skill，仅从固定任务上下文的 Run 抽取有证据的决策样本。先通过 datasets/source 读取当前 extraction_contract，核对业务目标轨迹和完整决策分页，依据该合同明确 workflow、task、观察动作或推荐判断的监督语义，并为同一可见状态建立有业务含义的命名决策题与逐题建议目标；以 datasets/preview 提交候选，平台自动保存并回读，无需再次确认；题目、流程名和依据优先使用中文，保留协议枚举、实际动作及来源原值。禁止评价输入中不可见的回复，禁止把实际动作当作正确答案或把模型建议当作人工真值；不要虚构概率、采样或校准证据。不要修改 Run；材料不足时说明限制，逐条原因保留在候选记录中，允许零条。', context) }
    catch (error) { setExtractError((error as Error).message) }
    finally { setExtractBusy(false) }
  }
  function download(kind: 'archive' | 'report' | 'file', path?: string) {
    const url = new URL('api/harness-platform/runs/download', document.baseURI)
    url.searchParams.set('run_id', runId); url.searchParams.set('kind', kind)
    if (path) url.searchParams.set('path', path)
    return url.href
  }
  async function compareRuns() {
    if (!leftRun || !rightRun || leftRun === rightRun) return
    const request = ++compareRequest.current
    setCompareBusy(true); setCompareError(''); setComparison(null)
    try {
      const [value, left, right] = await Promise.all([call('runs/compare', { left: leftRun, right: rightRun }), call('runs/show', { run_id: leftRun }), call('runs/show', { run_id: rightRun })])
      if (request !== compareRequest.current) return
      setComparison({ ...value, left_view: left, right_view: right }); setCompareCaseId(value.cases?.[0]?.case_id ?? '')
    } catch (error) { if (request === compareRequest.current) setCompareError((error as Error).message) }
    finally { if (request === compareRequest.current) setCompareBusy(false) }
  }
  function evalPayload() { return { source: `experiment:${experimentId}`, mode: caseScope === 'selected' ? 'full' : caseScope, executor, review: executor === 'browser' ? 'none' : review, ...(caseScope === 'selected' ? { cases: selectedCases } : {}) } }
  function clearPreview() { evalRequest.current++; setEvalPreview(null); setEvalError('') }
  async function previewEvaluation() {
    if (!experimentId) return
    const request = ++evalRequest.current
    setEvalBusy(true); setEvalError(''); setEvalPreview(null)
    try { const value = await call('eval/preview', evalPayload()); if (request === evalRequest.current) setEvalPreview(value.result ?? value) }
    catch (error) { if (request === evalRequest.current) setEvalError((error as Error).message) }
    finally { setEvalBusy(false) }
  }
  async function startEvaluation(resume?: EvaluationSubmission) {
    // 自动回读可能先于旧按钮的点击回调完成；恢复操作只能指向它显示的原请求。
    if (resume && evalSubmission.current?.request_id !== resume.request_id) return
    if ((!experimentId && !evalSubmission.current) || evalSending.current) return
    evalSending.current = true
    const request = ++evalRequest.current
    const submission = evalSubmission.current ?? { request_id: evaluationRequestId(), payload: evalPayload(), agentId, experimentId, runId, tab, runSelection: runSelectionVersion.current }
    evalSubmission.current = submission
    evalPersisted.current = saveSubmission(submission)
    setEvalPending(submission)
    const initialRunSelection = submission.runSelection
    setEvalBusy(true); setEvalError('')
    function accepted(value: any) {
      clearSubmission(submission)
      evalSubmission.current = null; setEvalPending(null)
      if (request !== evalRequest.current) { void loadJobs(); return }
      jobNavigation.current = { job_id: value.job_id, agent_id: submission.agentId, experiment_id: submission.experimentId, initial_run_id: submission.runId, run_selection_version: initialRunSelection }
      setJob({ ...value, agent_id: submission.agentId, experiment_id: submission.experimentId }); setJobError('')
      const state = current.current
      if (state.agentId === submission.agentId && state.experimentId === submission.experimentId) setConfigOpen(false)
      if (state.active && state.agentId === submission.agentId && state.experimentId === submission.experimentId && state.tab === submission.tab && state.runId === submission.runId && runSelectionVersion.current === initialRunSelection) {
        chooseTab('runs', { job_id: value.job_id })
        current.current.targetJobId = value.job_id
      }
      void loadJobs()
      void statusEvaluation(value.job_id)
    }
    try {
      accepted(await call('eval/start', { ...submission.payload, request_id: submission.request_id }))
    } catch (error) {
      if ((error as any).rejected) {
        clearSubmission(submission)
        evalSubmission.current = null; setEvalPending(null)
        if (request === evalRequest.current) setEvalError((error as Error).message)
      } else {
        try { accepted(await call('eval/status', { job_id: submission.request_id })) }
        catch { setEvalError(`此次评测的受理结果未知，可能已经执行。请核对此次请求；继续时沿用同一请求，不会另建任务。目标：${submission.experimentId}。`) }
      }
    } finally { evalSending.current = false; setEvalBusy(false) }
  }
  async function recoverPendingEvaluation() {
    const submission = evalSubmission.current
    if (!submission) return
    try {
      const value = await call('eval/status', { job_id: submission.request_id })
      if (evalSubmission.current !== submission || evalSending.current) return
      clearSubmission(submission)
      evalSubmission.current = null; setEvalPending(null); setEvalError('')
      const state = current.current
      if (state.agentId === submission.agentId && state.experimentId === submission.experimentId && runSelectionVersion.current === submission.runSelection) {
        jobNavigation.current = { job_id: value.job_id, agent_id: submission.agentId, experiment_id: submission.experimentId, initial_run_id: submission.runId, run_selection_version: submission.runSelection }
        setJob({ ...value, agent_id: submission.agentId, experiment_id: submission.experimentId }); setJobError('')
      }
    } catch { /* 回读尚未确认时保留原请求，只允许沿用同一请求继续。 */ }
  }
  async function statusEvaluation(jobId = job?.job_id) {
    if (!jobId) return
    try {
      const value = await call('eval/status', { job_id: jobId })
      const navigation = jobNavigation.current
      if (!navigation || navigation.job_id !== jobId) return
      setJob((previous: any) => previous?.job_id === jobId ? { ...previous, ...value,
        agent_id: previous.agent_id ?? navigation.agent_id, experiment_id: previous.experiment_id ?? navigation.experiment_id } : previous); setJobError('')
      const id = value.result?.run_id ?? value.run_id
      if (id && navigation.run_id !== id) {
        // 首次观察到 ID 后即记住，离开工作区也不在返回时补跳。
        navigation.run_id = id
        const state = current.current
        if (state.active && state.targetJobId === jobId && state.targetRunId === state.runId
          && state.agentId === navigation.agent_id && state.experimentId === navigation.experiment_id
          && state.tab === 'runs' && state.runId === navigation.initial_run_id && runSelectionVersion.current === navigation.run_selection_version) chooseRun(id, 'runs', true)
      }
      if (isFinal(value.status)) scheduleRefresh(0)
    } catch (error) {
      if (jobNavigation.current?.job_id !== jobId) return
      setJob((previous: any) => previous?.job_id === jobId ? { ...previous, status: 'unknown' } : previous)
      setJobError((error as Error).message)
    }
  }
  async function cancelEvaluation(jobId: string) {
    if (job?.job_id !== jobId || job.status !== 'running' || cancellingJob.current === jobId) return
    cancellingJob.current = jobId
    setJob((previous: any) => previous?.job_id === jobId ? { ...previous, status: 'cancelling' } : previous)
    try { await call('eval/cancel', { job_id: jobId }); await statusEvaluation(jobId) }
    catch (error) {
      if (jobNavigation.current?.job_id === jobId) {
        setJob((previous: any) => previous?.job_id === jobId ? { ...previous, status: 'unknown' } : previous)
        setJobError((error as Error).message)
      }
    } finally { if (cancellingJob.current === jobId) cancellingJob.current = '' }
  }
  function restoreJob(jobId: string) {
    const listed = jobs.find(item => item.job_id === jobId)
    const nextAgent = listed?.agent_id ?? target?.agent_id ?? ''
    const nextExperiment = listed?.experiment_id ?? target?.experiment_id ?? ''
    jobNavigation.current = { job_id: jobId, agent_id: nextAgent, experiment_id: nextExperiment,
      initial_run_id: target?.run_id ?? '', run_selection_version: runSelectionVersion.current,
      run_id: listed?.run_id }
    setJob(listed ?? { job_id: jobId, status: 'pending', agent_id: nextAgent, experiment_id: nextExperiment })
    setJobError('')
    void statusEvaluation(jobId)
  }
  async function openDecision() {
    const experiment = runDetail?.manifest?.experiment_id ?? experimentId
    const agent = runDetail?.manifest?.agent_id ?? agentId
    if (!experiment || !agent) return
    if (decisionDirty && decisionTarget.experiment === experiment) { setDecisionOpen(true); return }
    if (!leaveDrafts()) return
    const request = ++decisionRequest.current
    setDecisionOpen(true); setDecisionTarget({ agent, experiment }); setDecision({ body: '', hash: '', saved: '' }); setDecisionMessage('正在读取研究决策…'); setDecisionConflict(false)
    try {
      const value = await call('detail', { agent_id: agent, experiment_id: experiment })
      if (request !== decisionRequest.current) return
      setDecision({ body: value.decision.content ?? '', hash: value.decision.sha256, saved: value.decision.content ?? '' }); setDecisionLatest(null); setDecisionMessage('')
    } catch (error) { if (request === decisionRequest.current) setDecisionMessage((error as Error).message) }
  }
  async function saveDecision() {
    const request = decisionRequest.current
    const body = decision.body
    setDecisionBusy(true); setDecisionMessage('正在保存…')
    try {
      const value = await call('decision/update', { experiment_id: decisionTarget.experiment, content: body, expected_sha256: decision.hash })
      if (request !== decisionRequest.current) return
      setDecision(previous => ({ ...previous, hash: value.sha256, saved: body })); setDecisionLatest(null); setDecisionConflict(false); setDecisionMessage('研究决策已保存。')
    } catch (error) { if (request === decisionRequest.current) { setDecisionMessage(`${(error as Error).message}；草稿已保留。`); if ((error as Error).message.startsWith('conflict:')) setDecisionConflict(true) } }
    finally { setDecisionBusy(false) }
  }
  async function readLatestDecision() {
    const request = decisionRequest.current
    setDecisionMessage('正在读取最新 Decision…')
    try {
      const value = await call('detail', { agent_id: decisionTarget.agent, experiment_id: decisionTarget.experiment })
      if (request !== decisionRequest.current) return
      setDecisionLatest({ body: value.decision.content ?? '', hash: value.decision.sha256 })
      setDecisionMessage('最新内容已读取；你的草稿仍在编辑框中。请对照合并后再保存。')
    } catch (error) { if (request === decisionRequest.current) setDecisionMessage((error as Error).message) }
  }
  function closeDecision() {
    if (decisionBusy) return
    setDecisionOpen(false)
    if (!decisionDirty) { setDecision({ body: '', hash: '', saved: '' }); setDecisionLatest(null); decisionRequest.current++ }
  }

  useEffect(() => { void runRefresh(); return () => { listRequest.current++; runsRequest.current++; jobsRequest.current++; detailRequest.current++; caseRequest.current++; runRequest.current++; fileRequest.current++; compareRequest.current++; evalRequest.current++; decisionRequest.current++; if (refreshTimer.current !== undefined) { window.clearTimeout(refreshTimer.current); refreshTimer.current = undefined } } }, [])
  useEffect(() => { void loadDetail() }, [agentId, experimentId, tab, configOpen])
  useEffect(() => { void loadCase() }, [experimentId, caseId])
  useEffect(() => { fileSelection.current = null; setDatasetSource(null); setFileError(''); setFileSearch(''); void loadRun() }, [runId])
  useEffect(() => {
    if (!active || tab !== 'runs' || !runListReady || jobsLoading || !focusRunDetail.current || !runId || runDetail?.run_id !== runId || !runDetailHeading.current) return
    focusRunDetail.current = false
    if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return
    runDetailHeading.current.scrollIntoView({ block: 'start' })
    runDetailHeading.current.focus({ preventScroll: true })
  }, [active, tab, runId, runDetail?.run_id, runListReady, jobsLoading])
  useEffect(() => {
    if (!active || tab !== 'jobs' || jobsLoading || !focusJobDetail.current || !target?.job_id || job?.job_id !== target.job_id || !jobDetailHeading.current) return
    focusJobDetail.current = false
    if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return
    jobDetailHeading.current.scrollIntoView({ block: 'start' })
    jobDetailHeading.current.focus({ preventScroll: true })
  }, [active, tab, jobsLoading, target?.job_id, job?.job_id])
  useEffect(() => {
    if (pendingEvidence.current?.run !== runId || !runFiles || runDetail?.run_id !== runId) return
    const path = pendingEvidence.current.path
    pendingEvidence.current = null
    void openFile(path)
  }, [runId, runFiles, runDetail?.run_id])
  useEffect(() => {
    if (runTab !== 'files' || filePath || fileSearch || fileError || fileSelection.current?.run === runId || runDetail?.run_id !== runId || !runFiles?.files?.length) return
    const first = runFiles.files.find((file: RunFile) => /(?:^|\/)trace\.jsonl$/.test(file.path)) ?? runFiles.files.find((file: RunFile) => isTraceFile(file.path)) ?? runFiles.files[0]
    void openFile(first.path)
  }, [runTab, runId, runDetail?.run_id, runFiles, filePath, fileSearch, fileError])
  useEffect(() => {
    if (active) onContext?.({ page: 'evaluation', agent_id: agentId || undefined, experiment_id: experimentId || undefined, run_id: runId || undefined, case_id: tab === 'cases' ? caseId || undefined : resultCaseId || undefined, tab })
  }, [active, agentId, experimentId, runId, caseId, resultCaseId, tab, onContext])
  useEffect(() => {
    if (target?.page !== 'evaluation') return
    const previous = previousTarget.current
    previousTarget.current = { run_id: target.run_id, job_id: target.job_id }
    if (tabValue(target.tab) === 'runs' && previous.job_id && previous.job_id === target.job_id && previous.run_id !== target.run_id) runSelectionVersion.current++
    const state = current.current
    const nextTab = tabValue(target.tab), nextAgent = target.agent_id ?? '', nextExperiment = target.experiment_id ?? '', nextRun = target.run_id ?? '', nextCase = target.case_id ?? ''
    if (nextTab === 'jobs' && target.job_id && target.job_id !== job?.job_id) focusJobDetail.current = true
    else if (nextTab !== 'jobs') focusJobDetail.current = false
    const scopeChanged = nextAgent !== state.agentId || nextExperiment !== state.experimentId
    const caseChanged = nextTab === 'cases' && nextCase !== state.caseId
    if ((scopeChanged || caseChanged || nextRun !== state.runId) && !leaveDrafts()) { onNavigate?.({ page: 'evaluation', tab: state.tab, agent_id: state.agentId || undefined, experiment_id: state.experimentId || undefined, run_id: state.runId || undefined, case_id: state.caseId || undefined }); return }
    if (scopeChanged) resetScope(nextAgent, nextExperiment)
    if (nextTab === 'runs' && nextRun && nextRun !== state.runId) focusRunDetail.current = true
    else if (nextTab !== 'runs') focusRunDetail.current = false
    if (nextRun !== state.runId) { runRequest.current++; fileRequest.current++; setRunDetail(null); setReport(null); setRunFiles(null); setFilePreview(null); setFilePath('') }
    setTab(nextTab); setRunId(nextRun)
    if (nextTab === 'cases') { setCaseId(nextCase); if (caseChanged) { setCaseDocument(null); setCaseDraft(null); setCaseEditing(false) } }
    else if (nextTab === 'runs' && nextRun) {
      if (nextCase) { setResultCaseId(nextCase); setRunTab('results') }
      else { if (nextRun !== state.runId) setResultCaseId(''); setRunTab(runTabValue(target.run_tab)) }
    }
  }, [target?.page, target?.agent_id, target?.experiment_id, target?.run_id, target?.run_tab, target?.case_id, target?.job_id, target?.tab])
  useEffect(() => {
    if (target?.page !== 'evaluation' || !target.job_id || jobNavigation.current?.job_id === target.job_id) return
    restoreJob(target.job_id)
  }, [target?.page, target?.job_id])
  useEffect(() => {
    if (target?.page !== 'evaluation' || !target.job_id) return
    const listed = jobs.find(item => item.job_id === target.job_id)
    if (listed && (jobNavigation.current?.agent_id !== (listed.agent_id ?? '') || jobNavigation.current?.experiment_id !== (listed.experiment_id ?? ''))) restoreJob(target.job_id)
  }, [jobs, target?.page, target?.job_id])
  useEffect(() => {
    if (target?.page !== 'evaluation' || target.intent !== 'start_eval') return
    setConfigOpen(true)
    onNavigate?.({ ...target, intent: undefined, replace: true })
  }, [target?.page, target?.intent])
  useEffect(() => {
    if (active || !(current.current.caseDirty || current.current.decisionDirty || current.current.datasetDirty || current.current.newCaseDirty || current.current.datasetBusy || current.current.newCaseBusy || current.current.caseBusy || current.current.decisionBusy)) return
    if (!leaveDrafts()) { onNavigate?.(location()); return }
    setCaseDraft(caseDocument ? draftFor(caseDocument) : null); setCaseEditing(false); setDecisionOpen(false); setDecision({ body: '', hash: '', saved: '' })
  }, [active])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (evalSubmission.current && !evalPersisted.current || current.current.caseDirty || current.current.decisionDirty || current.current.datasetDirty || current.current.newCaseDirty || current.current.datasetBusy || current.current.newCaseBusy || current.current.caseBusy || current.current.decisionBusy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [])
  useEffect(() => { if (active && configOpen) configDialog.current?.showModal(); else configDialog.current?.close() }, [active, configOpen])
  useEffect(() => { if (active && decisionOpen) decisionDialog.current?.showModal(); else decisionDialog.current?.close() }, [active, decisionOpen])
  useEffect(() => {
    const dialog = cancelDialog.current
    if (!dialog) return
    if (active && cancelJobId && job?.job_id === cancelJobId && job.status === 'running' && !jobError) {
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
      if (cancelJobId) setCancelJobId('')
    }
  }, [active, cancelJobId, job?.job_id, job?.status, jobError])
  useEffect(() => {
    if (!active) return
    if (refreshOnActive.current) { refreshOnActive.current = false; refreshNow() }
  }, [active])
  useEffect(() => updates?.subscribe(() => {
    if (!updates.getSnapshot().domains.some(domain => ['agents', 'catalog'].includes(domain))) return
    scheduleRefresh()
    const decisionState = decisionSnapshot.current
    if (!decisionState.open || !decisionState.target.experiment || !decisionState.hash) return
    void call('detail', { agent_id: decisionState.target.agent, experiment_id: decisionState.target.experiment }).then(value => {
      if (value.decision.sha256 !== decisionState.hash) { if (current.current.decisionDirty) { setDecisionConflict(true); setDecisionLatest({ body: value.decision.content ?? '', hash: value.decision.sha256 }) } else setDecision({ body: value.decision.content ?? '', hash: value.decision.sha256, saved: value.decision.content ?? '' }) }
    }).catch(() => undefined)
  }), [updates])
  useEffect(() => {
    if (!job?.job_id || isFinal(job.status)) return
    const timer = window.setInterval(() => void statusEvaluation(), 2500)
    return () => window.clearInterval(timer)
  }, [job?.job_id, job?.status])

  const runExperiments = useMemo(() => [...new Set(runs.filter(run => !agentId || run.agent_id === agentId).map(run => run.experiment_id))], [runs, agentId])
  const displayedJobStatus = (item: EvaluationJob) => job?.job_id === item.job_id ? job.status : item.status
  const displayedJobRunId = (item: EvaluationJob) => job?.job_id === item.job_id ? (job.result?.run_id || job.run_id || item.run_id) : item.run_id
  const filteredJobs = jobs.filter(item => (!displayedJobRunId(item) || !runs.some(run => run.run_id === displayedJobRunId(item)))
    && (!agentId || item.agent_id === agentId) && (!experimentId || item.experiment_id === experimentId)
    && (!runStatus || displayedJobStatus(item) === runStatus) && !runVerdictFilter
    && (!runSearch || `${item.job_id} ${item.agent_id ?? ''} ${agents.find(agent => agent.id === item.agent_id)?.name ?? ''} ${item.experiment_id ?? ''}`.toLowerCase().includes(runSearch.toLowerCase())))
  const filteredRuns = runs.filter(run => (!agentId || run.agent_id === agentId) && (!experimentId || run.experiment_id === experimentId) && (!runStatus || run.status === runStatus) && (!runVerdictFilter || verdictIfCompleted(run.status, run.effective_verdict) === runVerdictFilter) && (!runSearch || `${run.run_id} ${run.agent_id} ${agents.find(agent => agent.id === run.agent_id)?.name ?? ''} ${run.experiment_id} ${run.title ?? ''}`.toLowerCase().includes(runSearch.toLowerCase())))
  const filteredCases = cases.filter(item => (!caseSearch || `${item.id} ${item.title} ${item.input_preview ?? ''}`.toLowerCase().includes(caseSearch.toLowerCase())) && (!sceneFilter || item.scene === sceneFilter) && (!tierFilter || item.tier === tierFilter))
  const sceneOptions = [...new Set(cases.map(item => item.scene).filter(Boolean))]
  const tierOptions = [...new Set(cases.map(item => item.tier).filter(Boolean))]
  const compareRunsOptions = runs.filter(run => isFinal(run.status) && (!agentId || run.agent_id === agentId))
  const leftAgent = runs.find(run => run.run_id === leftRun)?.agent_id
  const visibleRunDetail = runDetail?.run_id === runId ? runDetail : null
  const selectedResult = visibleRunDetail?.cases?.find((item: any) => item.case_id === resultCaseId)
  const observedCases: any[] = visibleRunDetail?.cases ?? []
  const caseCounts: Record<CaseObservation, number> = { passed: 0, failed: 0, inconclusive: 0, mixed: 0, pending: 0 }
  for (const item of observedCases) caseCounts[caseObservation(item).value]++
  const attentionCases = observedCases.filter(item => ['failed', 'inconclusive', 'mixed'].includes(caseObservation(item).value))
  const selectedRunAgentId = visibleRunDetail?.manifest?.agent_id || runs.find(run => run.run_id === runId)?.agent_id || agentId
  const selectedRun = runs.find(run => run.run_id === runId)
  const selectedAgentName = agents.find(agent => agent.id === selectedRunAgentId)?.name || selectedRunAgentId
  const selectedRunVersion = visibleRunDetail?.manifest?.experiment_id || selectedRun?.experiment_id || experimentId
  const agentName = (id?: string) => agents.find(agent => agent.id === id)?.name || id || '智能体未知'
  const runName = (run: Run) => run.title?.trim() || `${agentName(run.agent_id)} ${versionName(run.experiment_id)} 评测`
  const runCaseSummary = (run: Run) => caseSummary(visibleRunDetail?.run_id === run.run_id && observedCases.length
    ? { total: observedCases.length, ...caseCounts } : run.case_counts)
  const jobVerdict = job?.result?.run_status === 'completed' ? verdictIfCompleted(job.status, summaryVerdict(job.summary)) : null
  const highlightedJob = job ?? jobs.find(item => ['running', 'cancelling'].includes(item.status))
  const highlightedJobVersion = highlightedJob?.experiment_id ? versionName(highlightedJob.experiment_id) : '版本待读取'
  const selectedComparison = comparison?.cases?.find((item: any) => item.case_id === compareCaseId)
  const comparedCases = comparison ? [comparison.left_view, comparison.right_view].map(view => view.cases.find((item: any) => item.case_id === compareCaseId)) : []
  const pairedCaseRows: PairedCaseRows = { inputs: Math.max(1, ...comparedCases.map(item => item?.frozen?.inputs?.length ?? 0)), outputs: Math.max(1, ...comparedCases.map(item => Array.isArray(item?.output) ? item.output.length : 0)), trials: Math.max(1, ...comparedCases.map(item => item?.trials?.length ?? 0)) }
  const selectedFile = runFiles?.files?.find((file: RunFile) => file.path === filePath)
  const sealed = runFiles?.sealed ?? isFinal(visibleRunDetail?.manifest?.status)
  const versions: string[] = [...new Set([...(detail?.versions ?? []).map((version: any) => version.id), ...runExperiments])]
  const showRecords = tab === 'runs' || tab === 'jobs'
  const scopeControls = <>
    <button type="button" className="harness-eval-mobile-filter-toggle" aria-expanded={scopeFiltersOpen} aria-controls="evaluation-scope-filters" onClick={() => setScopeFiltersOpen(open => !open)}>筛选：{agents.find(agent => agent.id === agentId)?.name || agentId || '全部智能体'} · {experimentId || '全部版本'}</button>
    <div id="evaluation-scope-filters" className="harness-eval-filters harness-eval-scope-filters" data-mobile-open={scopeFiltersOpen}><label>智能体<SearchSelect label="评测智能体" value={agentId} onChange={value => changeScope(value)} options={[{ value: '', label: '全部智能体' }, ...agents.map(agent => ({ value: agent.id, label: agent.name || agent.id, description: agent.id }))]} /></label><label>研究版本<SearchSelect label="评测研究版本" value={experimentId} disabled={!agentId} onChange={value => changeScope(agentId, value)} options={[{ value: '', label: '全部版本' }, ...versions.map(id => ({ value: id, label: versionName(id), description: id }))]} /></label><label>评测结论<select aria-label="筛选评测结论" value={runVerdictFilter} onChange={event => setRunVerdictFilter(event.target.value)}><option value="">全部结论</option>{['passed', 'failed', 'inconclusive'].map(verdict => <option key={verdict} value={verdict}>{verdictLabel(verdict)}</option>)}</select></label><button type="button" onClick={refreshNow} aria-busy={runsLoading || jobsLoading || detailLoading}>刷新{(runsLoading || jobsLoading || detailLoading) ? <LoadingIndicator label="读取评测记录与版本" /> : null}</button>{detailError && <p role="alert">{detailError}</p>}</div>
  </>

  return <main className="harness-evaluation" aria-label="评测中心">
    {evalPending && !evalBusy && <section className="harness-eval-limits" role="status" aria-label="待核对的评测请求"><strong>评测受理结果待核对</strong><p>原目标：{agentName(evalPending.agentId)} · {versionName(evalPending.experimentId)}（{evalPending.experimentId}）。请求可能已经执行；核对和继续均沿用原参数与同一请求身份。</p><button type="button" onClick={() => void startEvaluation(evalPending)}>核对原评测请求</button></section>}
    <header className="harness-eval-toolbar"><div role="tablist" aria-label="评测工作区" className="harness-eval-tabs" onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === (tab === 'jobs' ? 'runs' : tab))
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); if (tabs[next].id === 'runs') returnToRecords(); else chooseTab(tabs[next].id); document.getElementById(`evaluation-tab-${tabs[next].id}`)?.focus()
    }}>{tabs.map(item => <button key={item.id} id={`evaluation-tab-${item.id}`} type="button" role="tab" aria-selected={(tab === 'jobs' ? 'runs' : tab) === item.id} aria-controls={item.id === 'runs' ? tab === 'jobs' || target?.job_id && !runId ? 'evaluation-job-detail' : runId ? 'evaluation-panel-runs' : 'evaluation-record-list' : `evaluation-panel-${item.id}`}  tabIndex={(tab === 'jobs' ? 'runs' : tab) === item.id ? 0 : -1} onClick={() => item.id === 'runs' ? returnToRecords() : chooseTab(item.id)}>{item.label}</button>)}</div><button type="button" className="harness-primary" onClick={() => { setConfigOpen(true); clearPreview() }}>新建评测</button></header>

    {agentsError && <p role="alert">{agentsError}</p>}
    {highlightedJob && <section id="evaluation-job-detail" role="tabpanel" aria-labelledby="evaluation-tab-runs" hidden={tab !== 'jobs' && !(target?.job_id === highlightedJob.job_id && !runId)} className="harness-eval-job harness-card" aria-label="当前评测任务" data-state={highlightedJob.status}>
      <div className="harness-eval-job-content"><small>评测任务</small><div className="harness-eval-job-title"><strong ref={job?.job_id === highlightedJob.job_id ? jobDetailHeading : undefined} tabIndex={job?.job_id === highlightedJob.job_id ? -1 : undefined}>{agentName(highlightedJob.agent_id ?? undefined)} {highlightedJobVersion}</strong><span className="harness-eval-badge" data-state={highlightedJob.status}>{executionLabel(highlightedJob.status)}</span></div>
        <p>{['running', 'cancelling'].includes(highlightedJob.status) ? elapsed(highlightedJob.started_at) || `开始于 ${time(highlightedJob.started_at)}` : `开始于 ${time(highlightedJob.started_at)}`}</p>
        <p className="harness-eval-job-update">{jobError && job?.job_id === highlightedJob.job_id ? '当前无法获取最新状态；任务身份已保留，请重新查询。' : highlightedJob.status === 'pending' ? '正在连接原评测任务；不会重新发起评测。' : `任务状态已读取${highlightedJob.updated_at ? ` · ${time(highlightedJob.updated_at)} 更新` : ''} · 离开页面后仍可查看`}</p>
        {jobVerdict && job?.job_id === highlightedJob.job_id && <p>业务结论：{verdictLabel(jobVerdict)}</p>}{highlightedJob.error && <p role="alert">{highlightedJob.error}</p>}{jobError && job?.job_id === highlightedJob.job_id && <p role="alert">未能连接任务 {highlightedJob.job_id}：{jobError}。可重新查询。</p>}
      </div><div className="harness-eval-actions"><button type="button" onClick={() => chooseJob(highlightedJob)}>查看执行过程</button>{job?.job_id === highlightedJob.job_id && <button type="button" onClick={returnToRecords}>返回评测记录</button>}{job?.job_id === highlightedJob.job_id && <button type="button" onClick={() => void statusEvaluation()}>刷新状态</button>}{job?.job_id === highlightedJob.job_id && <button type="button" disabled={!!jobError || job.status !== 'running'} onClick={() => setCancelJobId(job.job_id)}>取消评测</button>}{job?.job_id === highlightedJob.job_id && (job.result?.run_id || job.run_id) && <button type="button" onClick={() => chooseRun(job.result?.run_id || job.run_id, 'runs', false, job.job_id)}>查看本次报告</button>}</div>
      <DetailDrawer title="任务 ID 与执行日志" active={active && (tab === 'jobs' || Boolean(target?.job_id === highlightedJob.job_id && !runId))} identity={highlightedJob.job_id}><p>来源版本：{highlightedJob.experiment_id || highlightedJob.source || '待读取'}<br />任务 ID：{highlightedJob.job_id}</p><pre>{job?.job_id === highlightedJob.job_id ? `${job.stdout || '等待输出…'}${job.stderr ? `\n${job.stderr}` : ''}` : '打开任务后读取执行日志。'}</pre></DetailDrawer>
    </section>}
    {!showRecords && (tab === 'cases' || tab === 'compare') && scopeControls}
    {showRecords &&     <section ref={runListHeading} tabIndex={-1} id="evaluation-record-list" role="tabpanel" aria-labelledby="evaluation-tab-runs" className="harness-card harness-eval-run-list harness-eval-record-list" hidden={Boolean(runId || tab === 'jobs')} data-expanded={recordExpanded} aria-busy={runsLoading || jobsLoading}>{scopeControls}<div className="harness-eval-record-extra"><div className="harness-eval-filters"><input aria-label="搜索评测记录" placeholder="搜索任务、Run、智能体或版本" value={runSearch} onChange={event => setRunSearch(event.target.value)} /><select aria-label="筛选运行状态" value={runStatus} onChange={event => setRunStatus(event.target.value)}><option value="">全部状态</option>{['planned', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'unknown'].map(status => <option key={status} value={status}>{executionLabel(status)}</option>)}</select></div></div>{runsError && <p role="alert">Run 列表读取失败：{runsError}。可刷新重试。</p>}{jobsError && <p role="alert">任务列表读取失败：{jobsError}。可刷新重试。</p>}<div className="harness-table-scroll" role="region" aria-label="评测记录，可横向滚动查看完整列" tabIndex={0}><table className="harness-eval-run-table" aria-label="评测记录列表"><thead><tr><th>评测名称</th><th>版本</th><th>执行状态</th><th>评测结论</th><th>用例结果</th><th>时间</th><th>操作</th></tr></thead><tbody>{filteredJobs.map(item => <tr key={`job-${item.job_id}`} data-selected={job?.job_id === item.job_id} onClick={() => chooseJob(item)}><td data-label="评测名称"><button type="button" className="harness-eval-row-link" title={item.job_id} aria-label={`查看 ${agentName(item.agent_id ?? undefined)} 的评测任务 ${item.job_id}`} aria-pressed={job?.job_id === item.job_id} onClick={event => { event.stopPropagation(); chooseJob(item) }}><strong className="harness-eval-object-name">{agentName(item.agent_id ?? undefined)} {item.experiment_id ? versionName(item.experiment_id) : '版本待读取'} 评测任务</strong><small className="harness-eval-run-id">{isFinal(displayedJobStatus(item)) ? '历史任务' : '当前任务'} · …{item.job_id.slice(-8)}</small></button></td><td data-label="版本"><strong className="harness-eval-version-name" title={item.experiment_id || item.source}>{item.experiment_id ? versionName(item.experiment_id) : '版本待读取'}</strong></td><td data-label="执行状态"><span className="harness-eval-badge" data-state={displayedJobStatus(item)}>{executionLabel(displayedJobStatus(item))}</span></td><td data-label="评测结论"><span className="harness-eval-muted">{displayedJobStatus(item) === 'unknown' ? '状态待核对' : '尚无可核对结论'}</span></td><td data-label="用例结果"><span className="harness-eval-muted">{displayedJobRunId(item) ? '已有 Run，打开任务核对' : isFinal(displayedJobStatus(item)) ? '未生成可核对的 Run' : '等待评测完成'}</span></td><td data-label="时间"><time className="harness-eval-timestamp" dateTime={item.started_at}>{time(item.started_at)} 开始</time></td><td data-label="操作"><button type="button" className="harness-eval-open-result" onClick={event => { event.stopPropagation(); chooseJob(item) }}>{job?.job_id === item.job_id ? '已选中' : '查看任务'}</button></td></tr>)}{filteredRuns.map(run => <tr key={run.run_id} data-selected={runId === run.run_id} onClick={() => chooseRun(run.run_id, 'runs')}><td data-label="评测名称"><button type="button" className="harness-eval-row-link" title={run.run_id} aria-label={`查看 ${runName(run)}，Run ${run.run_id}`} aria-pressed={runId === run.run_id} onClick={event => { event.stopPropagation(); chooseRun(run.run_id, 'runs') }}><strong className="harness-eval-object-name">{runName(run)}</strong><small className="harness-eval-run-id">{agentName(run.agent_id)} · {run.case_scope || '用例范围未知'} · Run · …{run.run_id.slice(-8)}</small></button></td><td data-label="版本"><strong className="harness-eval-version-name" title={run.experiment_id}>{versionName(run.experiment_id)}</strong></td><td data-label="执行状态"><span className="harness-eval-badge" data-state={run.status}>{executionLabel(run.status)}</span></td><td data-label="评测结论">{run.stale && <small role="status">上次读取结果，当前记录暂不可读</small>}<span className="harness-eval-badge" data-state={verdictIfCompleted(run.status, run.effective_verdict) || 'unknown'}>{verdictLabel(verdictIfCompleted(run.status, run.effective_verdict))}</span></td><td data-label="用例结果">{runCaseSummary(run) ? <>{runCaseSummary(run)}{run.status !== 'completed' && <small>部分记录，非最终结论</small>}</> : <span className="harness-eval-muted">结果未知 · 逐例记录待核对</span>}</td><td data-label="时间"><time className="harness-eval-timestamp" dateTime={run.finished_at || run.created_at}>{time(run.finished_at || run.created_at)}{run.finished_at ? ' 结束' : ' 开始'}</time></td><td data-label="操作"><button type="button" className="harness-eval-open-result" onClick={event => { event.stopPropagation(); chooseRun(run.run_id, 'runs') }}>{runId === run.run_id ? '已选中' : '查看结果'}</button></td></tr>)}</tbody></table></div>{!runsLoading && !jobsLoading && !filteredRuns.length && !filteredJobs.length && !runsError && !jobsError && !agentsError && <Empty>当前筛选范围暂无评测记录。可新建评测，或选择其他智能体与版本。</Empty>}<div className="harness-eval-list-footer"><span>{(runsLoading || jobsLoading) && !runs.length && !jobs.length ? '—' : `共 ${filteredJobs.length + filteredRuns.length} 条评测记录`}</span><span>结论仅适用于对应评测范围；逐例摘要来自本次 Run 的冻结用例与记录，缺失时标为未知。</span><button type="button" aria-expanded={recordExpanded} onClick={() => setRecordExpanded(value => !value)}>{recordExpanded ? '收起列表' : '展开列表'}</button></div></section>}
    <section role="tabpanel" id="evaluation-panel-cases" aria-labelledby="evaluation-tab-cases" hidden={tab !== 'cases'}>
      {!agentId || !experimentId ? <Empty>选择智能体和具体研究版本后维护用例或运行评测。</Empty> : <>
        <p className="harness-eval-note">用例由 <strong>{agentId}</strong> 的所有研究版本共用。保存后对后续评测立即生效；正在执行和历史 Run 保留各自冻结的用例定义。</p>
        <div className="harness-eval-workbench">
          <section className="harness-card harness-eval-list-card" aria-label="测试用例列表"><div className="harness-eval-section-heading"><h2>测试用例 <span>{cases.length}</span></h2><div className="harness-eval-actions"><button onClick={() => setNewCase({ agent: agentId, experiment: experimentId })}>＋ 新增用例</button></div></div>
            <div className="harness-eval-filters"><input aria-label="搜索测试用例" placeholder="搜索用例 ID、名称或输入" value={caseSearch} onChange={event => setCaseSearch(event.target.value)} /><select aria-label="筛选用例场景" value={sceneFilter} onChange={event => setSceneFilter(event.target.value)}><option value="">全部场景</option>{sceneOptions.map(scene => <option key={scene} value={scene}>{scene}</option>)}</select><select aria-label="筛选用例档位" value={tierFilter} onChange={event => setTierFilter(event.target.value)}><option value="">全部档位</option>{tierOptions.map(tier => <option key={tier} value={tier}>{tier}</option>)}</select></div>
            <div className="harness-table-scroll"><table className="harness-eval-case-table"><thead><tr><th>用例</th><th>场景 / 档位</th></tr></thead><tbody>{filteredCases.map(item => <tr key={item.id} data-selected={caseId === item.id} onClick={() => chooseCase(item.id)}><td><button type="button" className="harness-eval-row-link" aria-pressed={caseId === item.id} onClick={event => { event.stopPropagation(); chooseCase(item.id) }}><strong>{item.title || item.id}</strong><span>{item.id}</span></button></td><td><span>{item.scene || '未分组'}</span><small>{item.tier || '未记录'}</small></td></tr>)}</tbody></table></div>{!filteredCases.length && (detailLoading ? <LoadingIndicator label="读取用例列表" block /> : <Empty>没有匹配的用例。</Empty>)}
            <div className="harness-eval-list-footer"><span>选择用例查看与编辑。执行范围在“新建评测”中选择。</span></div>
          </section>
          <section className="harness-card harness-eval-case-detail" aria-label="用例详情">{!caseId || !filteredCases.some(item => item.id === caseId) ? <Empty>{caseId ? '所选用例不在当前筛选结果中，草稿已保留。请清除筛选后继续编辑。' : '从列表选择一个用例，查看输入与预期行为。'}</Empty> : <><div className="harness-eval-section-heading"><div><h2>{caseDocument?.case.title || caseId}{caseMessage === '正在读取用例…' ? <LoadingIndicator label="读取用例" /> : null}</h2><small className="harness-eval-muted">用例 {caseId}{caseDocument?.path ? ` · ${caseDocument.path}` : ''}</small></div>{caseDocument && !caseEditing && <button type="button" onClick={() => { setCaseEditing(true); setCaseMessage('') }}>编辑用例</button>}</div>{caseConflict && <div className="harness-eval-conflict" role="alert"><p>用例已被其他任务修改。你的草稿仍在编辑框中，请先保留草稿，再对照最新内容合并。</p><div className="harness-eval-actions"><a className="harness-eval-download" href={`data:application/json;charset=utf-8,${encodeURIComponent(json(caseDraft))}`} download={`${caseId}-draft.json`}>下载用例草稿</a><button type="button" onClick={() => void loadCase()}>读取最新用例</button>{caseLatest && <button type="button" onClick={() => { setCaseDocument(caseLatest); setCaseConflict(false); setCaseMessage('已使用最新用例作为保存基准；草稿未改变，请核对合并后保存。') }}>使用最新版本作为保存基准</button>}</div>{caseLatest && <details><summary>查看最新用例（不覆盖草稿）</summary><pre>{json(caseLatest.case)}</pre></details>}</div>}{caseMessage && caseMessage !== '正在读取用例…' && <p role="status">{caseMessage}</p>}{caseDraft && caseDocument && (caseEditing ? <div className="harness-eval-editor"><label>名称<input aria-label="用例名称" disabled={caseBusy} value={caseDraft.title} onChange={event => setCaseDraft({ ...caseDraft, title: event.target.value })} /></label><h3>多轮输入</h3>{caseDraft.inputs.map((input, index) => <div className="harness-eval-input-turn" key={index}><label>第 {index + 1} 轮<textarea aria-label={`第 ${index + 1} 轮输入`} disabled={caseBusy} rows={4} value={input} onChange={event => setCaseDraft({ ...caseDraft, inputs: caseDraft.inputs.map((value, at) => at === index ? event.target.value : value) })} /></label><button type="button" disabled={caseBusy || caseDraft.inputs.length === 1} onClick={() => setCaseDraft({ ...caseDraft, inputs: caseDraft.inputs.filter((_, at) => at !== index) })}>移除第 {index + 1} 轮</button></div>)}<button type="button" disabled={caseBusy} onClick={() => setCaseDraft({ ...caseDraft, inputs: [...caseDraft.inputs, ''] })}>＋ 添加一轮输入</button><label>预期行为<textarea aria-label="用例预期行为" disabled={caseBusy} rows={5} value={caseDraft.expected_behavior} onChange={event => setCaseDraft({ ...caseDraft, expected_behavior: event.target.value })} /></label><label className="harness-eval-check"><input type="checkbox" disabled={caseBusy} checked={caseDraft.fast} onChange={event => setCaseDraft({ ...caseDraft, fast: event.target.checked })} />纳入快速评测（fast）</label><div className="harness-eval-actions"><button type="button" className="harness-primary" disabled={caseBusy || !caseDirty} onClick={() => void saveCase()}>{caseBusy ? '保存中…' : '保存用例'}</button><button type="button" disabled={caseBusy} onClick={() => { if (caseDirty && !window.confirm('取消编辑并丢弃当前用例草稿？')) return; setCaseDraft(draftFor(caseDocument)); setCaseEditing(false); setCaseMessage(''); void loadCase() }}>取消编辑</button></div></div> : <><Facts items={[["场景", caseDocument.case.scene], ["评测档位", caseDraft.fast ? 'fast / full' : 'full']]} /><h4>多轮输入</h4><ol className="harness-eval-turns">{caseDocument.case.inputs.map((input, index) => <li key={index}>{input}</li>)}</ol><h4>预期行为</h4><p className="harness-eval-preserve">{caseDocument.case.expected_behavior}</p></>)}</> }</section>
        </div>
      </>}
    </section>
    <section role="tabpanel" id="evaluation-panel-runs" aria-labelledby="evaluation-tab-runs" hidden={tab !== 'runs' || !runId}>
      <section className="harness-card harness-eval-run-detail" aria-label="Run 详情">{!runId ? <Empty>{runsLoading || !runListReady ? <LoadingIndicator label="读取评测结果" block /> : runsError && !runs.length ? '暂时无法读取已保存的评测结果；请刷新重试。' : !runs.length ? '当前没有已保存的 Run。可打开上方评测任务核对进展，或新建评测。' : '从运行列表选择一项，查看结论与需要核对的证据。'}</Empty> : <>
        <div className="harness-eval-section-heading"><div><div className="harness-eval-detail-title"><h2 ref={runDetailHeading} tabIndex={-1}>{selectedRunVersion ? versionName(selectedRunVersion) : '版本待读取'} · {selectedRun?.title?.trim() || `${selectedAgentName || '智能体'}评测`}</h2><span className="harness-eval-badge" data-state={verdictIfCompleted(visibleRunDetail?.manifest?.status ?? selectedRun?.status, summaryVerdict(visibleRunDetail?.summary) ?? selectedRun?.effective_verdict) || 'unknown'}>{verdictLabel(verdictIfCompleted(visibleRunDetail?.manifest?.status ?? selectedRun?.status, summaryVerdict(visibleRunDetail?.summary) ?? selectedRun?.effective_verdict))}</span>{runLoading && visibleRunDetail ? <LoadingIndicator label="刷新评测结果" /> : null}</div><small className="harness-eval-muted">{executionLabel(visibleRunDetail?.manifest?.status ?? selectedRun?.status)} · {time(visibleRunDetail?.manifest?.finished_at ?? selectedRun?.finished_at ?? visibleRunDetail?.manifest?.created_at ?? selectedRun?.created_at)} {visibleRunDetail?.manifest?.finished_at || selectedRun?.finished_at ? '结束' : '开始'}</small><DetailDrawer title="技术来源与 Run 信息" active={active && tab === 'runs'} identity={`${runId}:${runTab}`}><Facts items={[["来源版本", selectedRunVersion], ["Run ID", runId], ["智能体", selectedRunAgentId]]} />{visibleRunDetail && <><Facts items={[["机器结论", label(verdictIfCompleted(visibleRunDetail.manifest.status, visibleRunDetail.summary?.machine_overall_verdict ?? visibleRunDetail.summary?.overall_verdict))], ["开始时间", time(visibleRunDetail.manifest.created_at)], ["执行器", visibleRunDetail.source?.executor], ["复核", label(visibleRunDetail.summary?.review_status)]]} />{visibleRunDetail.missing?.length > 0 && <><h3>记录与采集缺口（{visibleRunDetail.missing.length}）</h3><ul>{visibleRunDetail.missing.map((value: string) => <li key={value}>{value}</li>)}</ul></>}<h3>Run 原始结构化记录</h3><pre>{json(visibleRunDetail)}</pre></>}{sealed ? <a className="harness-eval-download" href={download('archive')} download>下载完整 Run ZIP</a> : <p>完整包在 Run 封存后提供</p>}</DetailDrawer></div><div className="harness-eval-actions">{onAssistant && <button type="button" className="harness-primary" disabled={!visibleRunDetail} onClick={() => void onAssistant('请分析当前评测的业务结论、未通过或无法判定的用例与证据，提出可验证的改进建议；不要把执行结束当作业务通过。', { page: 'evaluation', agent_id: selectedRunAgentId, experiment_id: selectedRunVersion, run_id: runId })}>AI 分析并改进</button>}{report?.present && <a className="harness-eval-download" href={download('report')} download>下载报告</a>}<button type="button" onClick={() => { if (returnToComparison.current) { returnToComparison.current = false; setRunId(''); chooseTab('compare', { run_id: undefined, run_tab: undefined, case_id: undefined, job_id: undefined }) } else returnToRecords() }}>{returnToComparison.current ? '返回结果比较' : '返回评测记录'}</button></div></div>
        {extractError && <p role="alert">{extractError}</p>}{runLoading && !visibleRunDetail && <LoadingIndicator label="读取评测结果" block />}{runError && <p role="alert">结果读取失败：{runError}。{visibleRunDetail ? '以下为上次读取内容，可能已过期。' : '当前没有可显示的结果。'}可用页面顶部的“刷新”重试。</p>}
        {datasetSource && runTab === 'files' && <button type="button" onClick={() => chooseRunTab('datasets')}>返回样本复核（保留草稿）</button>}
        <div role="tablist" aria-label="Run 内容" className="harness-eval-subtabs" onKeyDown={event => { const ids: RunTab[] = ['report', 'results', 'files', 'datasets']; const index = ids.indexOf(runTab); const next = event.key === 'ArrowRight' ? (index + 1) % ids.length : event.key === 'ArrowLeft' ? (index + ids.length - 1) % ids.length : -1; if (next < 0) return; event.preventDefault(); chooseRunTab(ids[next]); document.getElementById(`evaluation-run-tab-${ids[next]}`)?.focus() }}>{([{ id: 'report', title: '结果概览' }, { id: 'results', title: '逐例结果' }, { id: 'files', title: '产物文件' }, { id: 'datasets', title: '决策样本' }] as const).map(item => <button type="button" key={item.id} role="tab" id={`evaluation-run-tab-${item.id}`} aria-selected={runTab === item.id} aria-controls={`evaluation-run-panel-${item.id}`} tabIndex={runTab === item.id ? 0 : -1} onClick={() => chooseRunTab(item.id)}>{item.title}</button>)}</div>
        <div role="tabpanel" id="evaluation-run-panel-report" aria-labelledby="evaluation-run-tab-report" hidden={runTab !== 'report'}>
        {visibleRunDetail && <div className="harness-eval-overview-grid"><aside className="harness-eval-score-summary">
          {visibleRunDetail.manifest.status !== 'completed' && <p className="harness-eval-note">执行尚未正常结束，逐例记录仅是已采集的部分证据。</p>}
          <section className="harness-eval-case-overview" aria-label="用例观察分布"><DistributionChart title="用例观察" description={`共 ${observedCases.length} 个选定用例；优先采用逐例证据复核，未复核时使用机器 Trial 观察。`} totalLabel="个用例" emptyText="本次 Run 尚未记录逐例观察。" segments={([
            { key: 'passed', label: observationLabel('passed'), count: caseCounts.passed, tone: 'success' },
            { key: 'failed', label: observationLabel('failed'), count: caseCounts.failed, tone: 'danger' },
            { key: 'inconclusive', label: observationLabel('inconclusive'), count: caseCounts.inconclusive, tone: 'warning' },
            { key: 'mixed', label: observationLabel('mixed'), count: caseCounts.mixed, tone: 'accent' },
            { key: 'pending', label: observationLabel('pending'), count: caseCounts.pending, tone: 'neutral' },
          ] satisfies ChartSegment[])} /><p className="harness-eval-muted">结论仅适用于本次 Run 保存的用例与执行环境。</p></section>
          </aside><div className="harness-eval-attention-column">{attentionCases.length > 0 ? <section className="harness-eval-attention" aria-label="需关注的用例"><div className="harness-eval-section-heading"><h3>需关注的用例 <span>{attentionCases.length}</span></h3><p className="harness-eval-muted">打开用例查看冻结输入、判定原因和证据。</p></div><ul>{attentionCases.map(item => { const observation = caseObservation(item); const reason = item.review?.reason || item.trials?.find((trial: any) => ['failed', 'inconclusive'].includes(trial.verdict))?.failure_reason || item.trials?.find((trial: any) => ['failed', 'inconclusive'].includes(trial.verdict))?.observation; return <li key={item.case_id}><button type="button" onClick={() => { setResultCaseId(item.case_id); setRunTab('results'); onNavigate?.(location({ tab: 'runs', run_id: runId, run_tab: undefined, case_id: item.case_id })); const resultTab = document.getElementById('evaluation-run-tab-results'); resultTab?.scrollIntoView?.({ block: 'center' }); resultTab?.focus() }}><span className="harness-eval-badge" data-state={observation.value}>{observationLabel(observation.value)}</span><span className="harness-eval-attention-title">{item.case_id} · {item.frozen?.title || '未记录用例名称'}</span><small>{observation.source}</small>{reason && <span className="harness-eval-attention-reason">{reason}</span>}<span className="harness-eval-attention-action">查看证据 ›</span></button></li> })}</ul></section> : observedCases.length > 0 && <p className="harness-eval-muted">当前逐例记录没有未通过、无法判定或不一致项。继续查看报告与适用范围。</p>}
        </div></div>}
          <div className="harness-eval-actions harness-eval-secondary-actions"><button type="button" disabled={!visibleRunDetail?.manifest?.experiment_id} onClick={() => void openDecision()}>记录研究决策</button><button type="button" disabled={!onAssistant || extractBusy || !sealed || !visibleRunDetail?.manifest?.experiment_id} onClick={() => void extractDecisionSamples()}>{extractBusy ? '正在打开 AI…' : '请 AI 抽取决策样本'}</button></div>
{reportError && <p role="alert">报告读取失败：{reportError}。{report?.present ? '以下为上次读取内容，可能已过期。' : '可查看逐例结果。'}</p>}{report?.present ? <div className="harness-eval-report"><MarkdownDelegateProvider openFile={path => void openFile(path)}><MarkdownText text={report.content} labels={markdownLabels} /></MarkdownDelegateProvider></div> : !runLoading && !reportError && <Empty>{sealed ? '此历史 Run 未保存 report.md。可查看逐例结果并下载已保存的证据。' : '评测尚未封存，报告将在运行结束后生成。可先查看逐例结果与任务日志。'}</Empty>}</div>
        <div role="tabpanel" id="evaluation-run-panel-results" aria-labelledby="evaluation-run-tab-results" hidden={runTab !== 'results'}>{runDetail?.cases?.length ? <><div className="harness-eval-result-workspace"><nav className="harness-eval-result-cases" aria-label="Run 结果用例">{runDetail.cases.map((item: any) => <button key={item.case_id} type="button" aria-current={resultCaseId === item.case_id ? 'true' : undefined} onClick={() => { setResultCaseId(item.case_id); onNavigate?.(location({ case_id: item.case_id })) }}><span className="harness-eval-badge" data-state={caseObservation(item).value}>{observationLabel(caseObservation(item).value)}</span><strong>{item.frozen?.title || item.case_id}</strong><small>{item.case_id}</small></button>)}</nav><article>{selectedResult && <><button disabled={!runDetail?.manifest?.experiment_id} onClick={() => setNewCase({ agent: runDetail.manifest.agent_id, experiment: runDetail.manifest.experiment_id, source: { run_id: runId, case_id: selectedResult.case_id } })}>从此 Run 创建用例草稿</button><RunCase item={selectedResult} active={active && tab === 'runs' && runTab === 'results'} identity={runId} onEvidence={path => void openFile(path)} /></>}</article></div></> : <Empty>此 Run 尚无逐例记录。</Empty>}</div>
        <div role="tabpanel" id="evaluation-run-panel-datasets" aria-labelledby="evaluation-run-tab-datasets" hidden={runTab !== 'datasets'}><DecisionDatasetView key={datasetEpoch} rpc={rpc} runId={runId} active={active && tab === 'runs' && runTab === 'datasets'} updates={updates} onDirty={setDatasetDirty} onBusy={setDatasetBusy} onSource={source => { setDatasetSource(source); setFileSearch(''); void openFile(source.path) }} onReextract={onAssistant && sealed ? () => void extractDecisionSamples() : undefined}/></div>
        <div role="tabpanel" id="evaluation-run-panel-files" aria-labelledby="evaluation-run-tab-files" hidden={runTab !== 'files'}>{filesError && <p role="alert">{filesError}</p>}<p className="harness-eval-note">文件清单来自实际保存的 Run 目录。原文预览最多显示前 64 KiB；下载保留完整内容并脱敏。</p>{runFiles?.coverage && <Raw value={runFiles.coverage} title="导出覆盖与采集限制" active={active && tab === 'runs' && runTab === 'files'} identity={runId} />}<input aria-label="筛选产物文件" placeholder="搜索路径、Case 或文件名" value={fileSearch} onChange={event => setFileSearch(event.target.value)} /><div className="harness-eval-files-layout"><div className="harness-eval-file-list" aria-label="产物文件列表">{(runFiles?.files ?? []).filter((file: RunFile) => file.path.toLowerCase().includes(fileSearch.toLowerCase())).map((file: RunFile) => <button type="button" key={file.path} aria-pressed={filePath === file.path} onClick={() => void openFile(file.path)}><span>{runDetail?.run_path ? file.path.replace(`${runDetail.run_path}/`, '') : file.path}</span><small>{file.size.toLocaleString()} 字节 · {file.kind === 'text' ? '文本' : '二进制'}</small></button>)}</div><article className="harness-eval-file-preview">{fileError && <p role="alert">{fileError}</p>}{filePath ? <><div className="harness-eval-section-heading"><strong>{runDetail?.run_path ? filePath.replace(`${runDetail.run_path}/`, '') : filePath}</strong><a className="harness-eval-download" href={download('file', filePath)} download>下载完整文件</a></div>{isTraceFile(filePath) && <div className="harness-eval-actions" role="group" aria-label="文件查看方式"><button type="button" aria-pressed={fileView === 'structured'} onClick={() => setFileView('structured')}>结构化查看</button><button type="button" aria-pressed={fileView === 'raw'} onClick={() => setFileView('raw')}>原文</button></div>}{isTraceFile(filePath) && fileView === 'structured' && runTab === 'files' ? <RunTraceView send={call} active={active && tab === 'runs' && runTab === 'files'} runId={runId} path={filePath} focus={datasetSource && (filePath === datasetSource.path || filePath.endsWith('/' + datasetSource.path)) ? { ...datasetSource, path: filePath } : undefined} onEvidence={() => setFileView('raw')}/> : selectedFile?.kind === 'binary' ? <p>二进制文件请下载查看。</p> : filePreview ? <>{filePreview.truncated && <p role="status">仅预览前 64 KiB。下载完整文件不受预览限制。</p>}<pre>{filePreview.content || '空文件'}</pre></> : !fileError && <LoadingIndicator label="读取文件" block />}</> : <Empty>选择文件查看轨迹、工具事件、检查或归因证据。</Empty>}</article></div></div>
      </>}</section>
    </section>
    <section role="tabpanel" id="evaluation-panel-compare" aria-labelledby="evaluation-tab-compare" hidden={tab !== 'compare'}>
      <section className="harness-card"><div className="harness-eval-section-heading"><h2>两次 Run 对照</h2><span className="harness-eval-muted">同一智能体 · 已封存 Run</span></div><div className="harness-eval-compare-controls"><label>左侧 Run<SearchSelect label="左侧 Run" value={leftRun} placeholder="选择基准评测" onChange={value => { compareRequest.current++; setLeftRun(value); setRightRun(''); setComparison(null); setCompareBusy(false) }} options={compareRunsOptions.map(run => ({ value: run.run_id, label: `${agentName(run.agent_id)} · ${versionName(run.experiment_id)} · ${time(run.finished_at || run.created_at)}`, description: run.run_id }))} /></label><label>右侧 Run<SearchSelect label="右侧 Run" value={rightRun} disabled={!leftRun} placeholder="选择对照评测" onChange={value => { compareRequest.current++; setRightRun(value); setComparison(null); setCompareBusy(false) }} options={compareRunsOptions.filter(run => run.agent_id === leftAgent && run.run_id !== leftRun).map(run => ({ value: run.run_id, label: `${versionName(run.experiment_id)} · ${time(run.finished_at || run.created_at)}`, description: run.run_id }))} /></label><button type="button" className="harness-primary" disabled={!leftRun || !rightRun || compareBusy} onClick={() => void compareRuns()}>{compareBusy ? '比较中…' : '开始比较'}</button></div><p className="harness-eval-note">观察性对照需结合输入、模型、执行器与环境判断；记录差异不能单独证明 Harness 导致效果变化。</p>{compareError && <p role="alert">{compareError}</p>}{comparison && <><div className="harness-eval-compare-conclusion" data-state={comparison.causal_comparable ? 'passed' : 'inconclusive'}><strong>{comparison.comparable ? '有共同用例可观察对照' : '缺少共同用例结果'}</strong><p>共同用例 {comparison.cases?.length ?? 0} 个；记录有差异 {(comparison.cases ?? []).filter((item: any) => item.observed_change === '记录有差异').length} 个。{comparison.causal_comparable ? '已记录的比较条件一致，仍需结合实验设计判断效果。' : '来源或口径存在差异或缺失，不能将观察差异归因为 Harness 改进。'}</p></div><div className="harness-eval-compare-grid harness-eval-compare-summary-grid">{[['左侧', comparison.left_view], ['右侧', comparison.right_view]].map(([name, value]) => <article key={name as string} className="harness-eval-comparison-summary"><h3>{name as string} · {agentName((value as any).manifest.agent_id)} · {versionName((value as any).manifest.experiment_id)}</h3><small className="harness-eval-run-id">Run {(value as any).run_id}</small><Facts items={[["版本", (value as any).manifest.experiment_id], ["状态", label((value as any).manifest.status)], ["结论", verdictLabel(verdictIfCompleted((value as any).manifest.status, summaryVerdict((value as any).summary)))], ["执行器", (value as any).source.executor], ["预期模型", (value as any).source.model], ["Git", (value as any).source.git_version?.commit], ["工作树含未提交改动", (value as any).source.git_version?.dirty]]} /></article>)}</div><p>仅左侧用例：{comparison.left_only?.join('、') || '无'}；仅右侧用例：{comparison.right_only?.join('、') || '无'}。</p>{comparison.limits?.length > 0 && <div className="harness-eval-limits"><strong>对照限制</strong><ul>{comparison.limits.map((value: string) => <li key={value}>{value}</li>)}</ul></div>}<label className="harness-eval-field">共同 Case<SearchSelect label="对照用例" value={compareCaseId} onChange={setCompareCaseId} options={(comparison.cases ?? []).map((item: any) => ({ value: item.case_id, label: item.case_id, description: item.observed_change }))} /></label>{selectedComparison ? <><p><strong>{selectedComparison.observed_change}</strong> · 冻结用例口径{selectedComparison.frozen_contract_same ? '相同' : '不同'}</p><div className="harness-eval-compare-grid harness-eval-case-compare-grid">{[comparison.left_view, comparison.right_view].map((value: any) => { const item = value.cases.find((entry: any) => entry.case_id === compareCaseId); return <article key={value.run_id} className="harness-eval-comparison-side" style={{ '--harness-case-rows': 13 + pairedCaseRows.inputs + pairedCaseRows.outputs + pairedCaseRows.trials } as CSSProperties}><h3>{agentName(value.manifest.agent_id)} · {versionName(value.manifest.experiment_id)}</h3><small className="harness-eval-run-id">Run {value.run_id}</small>{item && <RunCase item={item} paired={pairedCaseRows} active={active && tab === 'compare'} identity={value.run_id} onEvidence={path => { returnToComparison.current = true; pendingEvidence.current = { run: value.run_id, path }; chooseRun(value.run_id, 'runs'); if (runId === value.run_id) { pendingEvidence.current = null; void openFile(path) } }} />}</article> })}</div></> : <Empty>这两次 Run 没有可对照的共同 Case。</Empty>}<DetailDrawer title="比较条件与技术来源" active={active && tab === 'compare'} identity={`${leftRun}:${rightRun}`}><RunComparisonFacts comparison={comparison} onNavigate={onNavigate}/><h3>完整对照记录与来源条件</h3><pre>{json(comparison)}</pre></DetailDrawer></>}</section>
    </section>
    {newCase && <CaseCreationDialog rpc={rpc} active={active} onDirty={setNewCaseDirty} onBusy={setNewCaseBusy} agentId={newCase.agent} experimentId={newCase.experiment} sourceRun={newCase.source} onClose={() => setNewCase(null)} onSaved={document => {
      resetScope(newCase.agent, newCase.experiment); setTab('cases'); setCaseId(document.case.id); setCaseDocument(document); setCaseDraft(draftFor(document)); setCaseMessage('已新增用例，后续评测立即使用；历史 Run 冻结口径保持。')
      onNavigate?.({ page: 'evaluation', tab: 'cases', agent_id: newCase.agent, experiment_id: newCase.experiment, case_id: document.case.id })
      updates?.invalidate(['agents', 'catalog'])
    }}/>}
    <dialog ref={configDialog} className="harness-eval-drawer" aria-labelledby="evaluation-config-title" onCancel={event => { if (evalBusy) event.preventDefault(); else setConfigOpen(false) }}><div className="harness-eval-section-heading"><h2 id="evaluation-config-title">{evalPending ? `核对评测 ${agentName(evalPending.agentId)} ${versionName(evalPending.experimentId)}` : agentId && experimentId ? `评测 ${agentName(agentId)} ${versionName(experimentId)}` : '新建评测'}</h2><button type="button" disabled={evalBusy} onClick={() => setConfigOpen(false)}>关闭</button></div><div className="harness-eval-dialog-body"><p className="harness-eval-muted">选择研究版本、验证目标和用例范围，再启动独立 Run。</p><div className="harness-eval-editor"><label>智能体<SearchSelect label="新建评测智能体" disabled={evalBusy || !!evalPending} value={agentId} onChange={value => { changeScope(value); setConfigOpen(true) }} options={agents.map(agent => ({ value: agent.id, label: agent.name || agent.id, description: agent.id }))} /></label><label>研究版本<SearchSelect label="新建评测版本" disabled={!agentId || detailLoading || evalBusy || !!evalPending} value={experimentId} onChange={value => { changeScope(agentId, value); setConfigOpen(true) }} options={versions.map(id => ({ value: id, label: versionName(id), description: id }))} /></label></div><section className="harness-eval-advanced"><h3>验证目标与复核</h3><div className="harness-eval-editor"><label>验证目标<select aria-label="验证目标" value={executor} disabled={evalBusy || !!evalPending} onChange={event => { setExecutor(event.target.value); clearPreview() }}><option value="api">业务能力评测</option><option value="browser">界面冒烟</option></select></label><label>证据复核<select aria-label="证据复核" value={executor === 'browser' ? 'none' : review} disabled={evalBusy || !!evalPending || executor === 'browser'} onChange={event => { if (executor === 'browser') return; setReview(event.target.value); clearPreview() }}><option value="none">不请求 AI 复核</option><option value="ai">AI 证据复核</option></select></label></div><p className="harness-eval-muted">{executor === 'browser' ? '检查界面能否打开和完成基础交互，不生成业务能力通过结论，也不进行 AI 证据复核。' : '按用例验证业务行为，可选择由 AI 复核本次运行证据。'}</p></section><section className="harness-eval-range"><h3>评测范围</h3><div className="harness-eval-scope-choice" role="group" aria-label="评测范围">{([{ id: 'fast', title: '快速评测' }, { id: 'full', title: '全部用例' }, { id: 'selected', title: '自选用例' }] as const).map(item => <button key={item.id} type="button" aria-pressed={caseScope === item.id} disabled={evalBusy || !!evalPending} onClick={() => { setCaseScope(item.id); clearPreview() }}>{item.title}</button>)}</div>{caseScope === 'selected' ? <><input aria-label="搜索待评测用例" placeholder="搜索用例名称或 ID" value={newCaseSearch} onChange={event => setNewCaseSearch(event.target.value)} /><div className="harness-eval-new-case-list">{cases.filter(item => `${item.id} ${item.title}`.toLowerCase().includes(newCaseSearch.trim().toLowerCase())).map(item => <label key={item.id}><input type="checkbox" aria-label={`执行 ${item.id}`} disabled={evalBusy || !!evalPending} checked={selectedCases.includes(item.id)} onChange={event => { setSelectedCases(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); clearPreview() }} /><span><strong>{item.title || item.id}</strong><small>{item.id}</small></span></label>)}</div><p>已选择 {selectedCases.length} 个用例。</p>{!selectedCases.length && <p className="harness-eval-muted">请至少选择一个用例。</p>}</> : <p>{caseScope === 'fast' ? '按已保存的快速评测标记选择用例。' : '评测此智能体的全部已保存用例。'}实际范围以执行预览为准。</p>}<p className="harness-eval-muted">结论只适用于本次用例和执行环境；历史 Run 保留冻结定义。</p></section>{caseDirty && <p role="alert">用例草稿尚未保存，本次评测将使用已保存的定义。</p>}{detailError && <p role="alert">{detailError}</p>}{evalError && <p role="alert">{evalError}</p>}{evalPreview && <section className="harness-eval-preview"><h3>执行预览</h3><Facts items={[["用例数量", evalPreview.case_ids?.length], ["验证目标", evalPreview.executor === 'browser' ? '界面冒烟' : '业务能力评测']]} />{evalPreview.case_ids?.length > 0 && <p>{evalPreview.case_ids.join('、')}</p>}{evalPreview.missing_env_names?.length > 0 && <p role="alert">缺少环境变量：{evalPreview.missing_env_names.join('、')}</p>}<Raw value={evalPreview} title="预览完整配置" inline /></section>}</div><div className="harness-eval-actions harness-eval-dialog-footer"><button type="button" disabled={!!evalPending || !experimentId || evalBusy || detailLoading || caseScope === 'selected' && !selectedCases.length} onClick={() => void previewEvaluation()}>执行预览</button><button type="button" className="harness-primary" disabled={evalBusy || !evalPending && (!experimentId || detailLoading || caseScope === 'selected' && !selectedCases.length)} onClick={() => void startEvaluation(evalPending ?? undefined)}>{evalBusy ? '处理中…' : evalPending ? '核对并继续此次请求' : '启动评测'}</button></div></dialog>
    <dialog ref={decisionDialog} className="harness-eval-decision-dialog" aria-labelledby="evaluation-decision-title" onCancel={event => { event.preventDefault(); closeDecision() }}><div className="harness-eval-section-heading"><h2 id="evaluation-decision-title">记录研究决策{['正在读取研究决策…', '正在读取最新 Decision…'].includes(decisionMessage) ? <LoadingIndicator label="读取研究决策" /> : null}</h2><button type="button" disabled={decisionBusy} onClick={closeDecision}>关闭</button></div><div className="harness-eval-dialog-body"><p>绑定研究版本：<strong>{decisionTarget.experiment}</strong></p><label className="harness-eval-field">Decision 正文<textarea aria-label="Decision 正文" rows={16} disabled={decisionBusy || !decision.hash} value={decision.body} onChange={event => setDecision({ ...decision, body: event.target.value })} /></label>{decisionConflict && <div className="harness-eval-conflict" role="alert"><p>Decision 已被其他任务修改。你的草稿保留在编辑框中；关闭窗口后重新打开仍可继续。</p><div className="harness-eval-actions"><a className="harness-eval-download" href={`data:text/markdown;charset=utf-8,${encodeURIComponent(decision.body)}`} download={`${decisionTarget.experiment}-decision-draft.md`}>下载 Decision 草稿</a><button type="button" onClick={() => void readLatestDecision()}>读取最新 Decision</button>{decisionLatest && <button type="button" onClick={() => { setDecision(previous => ({ ...previous, hash: decisionLatest.hash, saved: decisionLatest.body })); setDecisionConflict(false); setDecisionMessage('已使用最新 Decision 作为保存基准；草稿未改变，请核对合并后保存。') }}>使用最新版本作为保存基准</button>}</div>{decisionLatest && <details><summary>查看最新 Decision（不覆盖草稿）</summary><pre>{decisionLatest.body}</pre></details>}</div>}{decisionMessage && !['正在读取研究决策…', '正在读取最新 Decision…'].includes(decisionMessage) && <p role="status">{decisionMessage}</p>}</div><div className="harness-eval-actions harness-eval-dialog-footer"><button type="button" className="harness-primary" disabled={decisionBusy || !decision.hash || !decisionDirty} onClick={() => void saveDecision()}>{decisionBusy ? '保存中…' : '保存研究决策'}</button></div></dialog>
    <dialog ref={cancelDialog} className="harness-eval-confirm-dialog" aria-labelledby="evaluation-cancel-title" onCancel={() => setCancelJobId('')}><div className="harness-eval-section-heading"><h2 id="evaluation-cancel-title">取消当前评测？</h2><button type="button" onClick={() => setCancelJobId('')}>关闭</button></div><div className="harness-eval-dialog-body"><p>目标评测：<strong>{agentName(job?.agent_id)} {job?.experiment_id ? versionName(job.experiment_id) : '版本待读取'}</strong></p><p>当前状态：{job?.status === 'running' ? `运行中${elapsed(job.started_at) ? ` · ${elapsed(job.started_at)}` : ''}` : executionLabel(job?.status)}</p><p>取消会请求结束这项独立评测任务。已保存的历史 Run 和用例不会因此删除；取消完成前，最终执行状态与业务结论仍需重新查询。</p><p className="harness-eval-muted">任务 ID：<code>{cancelJobId}</code></p></div><div className="harness-eval-actions harness-eval-dialog-footer"><button type="button" onClick={() => setCancelJobId('')}>继续评测</button><button type="button" className="harness-primary" disabled={!cancelJobId || job?.job_id !== cancelJobId || job?.status !== 'running' || !!jobError} onClick={() => { const confirmedJobId = cancelJobId; setCancelJobId(''); void cancelEvaluation(confirmedJobId) }}>确认取消</button></div></dialog>
  </main>
}
