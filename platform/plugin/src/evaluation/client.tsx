import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { CaseCreationDialog } from './cases-editor.tsx'
import { CaseExpected, CaseExpectedPreview } from './case-expected.tsx'
import { RunTraceView } from './trace-view.tsx'
import { DecisionDatasetView } from './dataset-view.tsx'
import { RunComparisonFacts } from './comparison-view.tsx'
import { RunReviewAssessment } from './review-view.tsx'
import { effectReviewLabel, separatedReview, sourceDiagnosisLabel, type ReviewContract, type SourceDiagnosis } from './review-state.ts'
import { CHANNEL } from '../protocol.ts'
import { SearchSelect } from '../components/search-select.tsx'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { evaluationAgentName, evaluationObjectType, evaluationVersionLabel, type EvaluationExperiment } from './object-identity.ts'
import { DistributionChart, type ChartSegment } from '../components/overview-charts.tsx'
import { caseObservation, observationLabel, type CaseObservation } from './case-observation.ts'
import type { PlatformNavigation, PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'

type DeleteTarget = { kind: 'runs'; runs: Run[] } | { kind: 'case'; experimentId: string; agentId: string; document: CaseDocument }
type Tab = 'cases' | 'jobs' | 'runs' | 'compare'
type RunTab = 'report' | 'results' | 'files' | 'datasets'
const runTabValue = (value: PlatformNavigation['run_tab']): RunTab => value === 'trace' ? 'files' : value ?? 'report'
const isTraceFile = (path: string) => /(?:^|\/)(?:trace|judge-trace)\.jsonl$/.test(path)
type RpcResult = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }
type Agent = { id: string; name?: string; manifest?: Record<string, any>; active_experiment?: string | null }
type CaseCounts = { total: number; passed: number; failed: number; inconclusive: number; mixed: number; pending: number }
type Run = { stale?: boolean; run_id: string; experiment_id: string; agent_id: string; status?: string; created_at?: string; finished_at?: string; effective_verdict?: string | null; title?: string | null; case_scope?: string | null; case_counts?: CaseCounts | null; review_contract?: ReviewContract; review_status?: string; source_diagnosis?: SourceDiagnosis | null }
type EvaluationExecution = { run_id: string | null; run_created: boolean; legacy_id?: string; source?: string; agent_id?: string | null; experiment_id?: string | null; status: string; started_at?: string; updated_at?: string; error?: string; [key: string]: any }
type EvaluationSubmission = { run_id: string; payload: Record<string, unknown>; agentId: string; experimentId: string; previousRunId: string; tab: string; runSelection: number; scope: string; legacy_id?: string }
const submissionKey = (scope: string) => `harness-evaluation-pending:v2:${new URL('.', document.baseURI).href}:${scope}`
const legacySubmissionKey = () => `harness-evaluation-pending:${new URL('.', document.baseURI).href}`
function savedSubmission(scope: string): EvaluationSubmission | null {
  if (!scope) return null
  try {
    const value = JSON.parse(window.sessionStorage.getItem(submissionKey(scope)) ?? 'null')
    return value && /^run-[0-9a-f-]{36}$/.test(value.run_id) && value.scope === scope && typeof value.agentId === 'string' && typeof value.experimentId === 'string'
      && value.payload?.source === (value.experimentId.startsWith('business:') ? value.experimentId : `experiment:${value.experimentId}`) ? value : null
  } catch { return null }
}
function saveSubmission(value: EvaluationSubmission): boolean {
  try { const text = JSON.stringify(value); window.sessionStorage.setItem(submissionKey(value.scope), text); return window.sessionStorage.getItem(submissionKey(value.scope)) === text }
  catch { return false }
}
function clearSubmission(value: EvaluationSubmission) {
  try {
    if (value.legacy_id) window.sessionStorage.removeItem(legacySubmissionKey())
    else if (savedSubmission(value.scope)?.run_id === value.run_id) window.sessionStorage.removeItem(submissionKey(value.scope))
  } catch {}
}
const legacyRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const executionKey = (value?: EvaluationExecution | null) => value?.run_id ?? value?.legacy_id ?? ''
const missingExecution = (error: unknown) => ['not_found', 'creation_expired', 'expired'].includes(String((error as any)?.code ?? ''))
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
const statusLabels: Record<string, string> = { prepared: '尚未启动', preparing: '正在准备', planned: '计划中', running: '运行中', cancelling: '正在取消', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '状态待核对', passed: '通过', inconclusive: '无法判定', error: '执行错误', skipped: '已跳过', not_requested: '未请求', pending: '等待中' }
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
const versionName = evaluationVersionLabel
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
function RunCase({ item, onEvidence, active, identity, paired, separated = false }: { item: any; onEvidence(path: string): void; active: boolean; identity: string; paired?: PairedCaseRows; separated?: boolean }) {
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
  if (frozen || paired) parts.push({ id: 'expected', content: <><h4>本次 Run 冻结预期</h4><CaseExpected text={frozen?.expected_behavior} empty={frozen ? '本次 Run 未记录预期行为。' : '此历史 Run 未冻结预期行为。'} /></> })
  parts.push({ id: 'outputs-title', content: <h4>智能体回答</h4> })
  for (let index = 0; index < (paired?.outputs ?? Math.max(1, outputs.length)); index++) parts.push({ id: `output-${index}`, content: index < outputs.length ? <div className="harness-eval-answer"><small>第 {index + 1} 轮</small><MarkdownText text={typeof outputs[index] === 'string' ? outputs[index] as string : json(outputs[index])} labels={markdownLabels} /></div> : paired ? <div className="harness-eval-answer"><small>第 {index + 1} 轮</small><p>未采集到第 {index + 1} 轮回答。</p></div> : <p>未采集到回答。</p> })
  parts.push({ id: 'trials-title', content: <h4>机器结果</h4> })
  for (let index = 0; index < (paired?.trials ?? Math.max(1, trials.length)); index++) {
    const trial = trials[index]
    parts.push({ id: `trial-${index}`, content: trial ? <div className="harness-eval-observation"><span className="harness-eval-badge" data-state={trial.verdict}>{label(trial.execution_status)} · {label(trial.verdict)}</span><p>{trial.observation}</p>{trial.failure_reason && <p role="alert">{trial.failure_reason}</p>}</div> : <p>{paired ? `未记录第 ${index + 1} 次 Trial 结果。` : '尚无 Trial 结果。'}</p> })
  }
  if (item.review || paired) parts.push({ id: 'review', content: <><h4>{separated ? '业务效果复核' : '证据复核'}</h4><p>{item.review ? <>{label(item.review.reviewed_verdict)} · {item.review.reason}</> : separated ? '未记录业务效果复核。' : '未记录证据复核。'}</p></> })
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
  const [experiments, setExperiments] = useState<EvaluationExperiment[]>([])
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
  const [objectTypeFilter, setObjectTypeFilter] = useState('')
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
  const [assetScope, setAssetScope] = useState('')
  const [evalPending, setEvalPending] = useState<EvaluationSubmission | null>(null)
  const [pendingObservation, setPendingObservation] = useState<EvaluationExecution | null>(null)
  const evalSubmission = useRef<EvaluationSubmission | null>(null), evalSending = useRef(false), evalPersisted = useRef(true)
  const restoredScope = useRef('')
  const previewRun = useRef<string | null>(null)
  const [job, setJob] = useState<EvaluationExecution | null>(null)
  const [jobError, setJobError] = useState('')
  const cancellingJob = useRef('')
  const [cancelJobId, setCancelJobId] = useState('')
  const [jobs, setJobs] = useState<EvaluationExecution[]>([])
  const [jobsError, setJobsError] = useState('')
  const [jobsLoading, setJobsLoading] = useState(false)
  const runSelectionVersion = useRef(0)
  const configDialog = useRef<HTMLDialogElement>(null)
  const cancelDialog = useRef<HTMLDialogElement>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)
  const deleteLock = useRef(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleteNotice, setDeleteNotice] = useState('')
  const [selectedRuns, setSelectedRuns] = useState<string[]>([])
  const listRequest = useRef(0), runsRequest = useRef(0), jobsRequest = useRef(0), detailRequest = useRef(0), caseRequest = useRef(0), runRequest = useRef(0), fileRequest = useRef(0), compareRequest = useRef(0), evalRequest = useRef(0)
  const runDetailHeading = useRef<HTMLHeadingElement>(null)
  const jobDetailHeading = useRef<HTMLElement>(null)
  const runListHeading = useRef<HTMLElement>(null)
  const runListTrigger = useRef<HTMLElement | null>(null)
  const recordScope = useRef<{ agent: string; experiment: string } | null>(null)
  const returnToComparison = useRef(false)
  const focusRunDetail = useRef(Boolean(target?.run_id && tabValue(target?.tab) === 'runs'))
  const focusJobDetail = useRef(Boolean(target?.job_id && tabValue(target?.tab) === 'jobs'))
  const caseDirty = !!caseDocument && !!caseDraft && JSON.stringify(caseDraft) !== JSON.stringify(draftFor(caseDocument))
  const current = useRef({ caseDirty, datasetDirty, datasetBusy, newCaseDirty, newCaseBusy, caseBusy, agentId, experimentId, tab, runId, caseId, active, targetJobId: target?.job_id, targetRunId: target?.run_id ?? '' })
  current.current = { caseDirty, datasetDirty, datasetBusy, newCaseDirty, newCaseBusy, caseBusy, agentId, experimentId, tab, runId, caseId, active, targetJobId: target?.job_id, targetRunId: target?.run_id ?? '' }
  const refreshTimer = useRef<number | undefined>(undefined)
  const refreshRunning = useRef(false)
  const refreshPending = useRef(false)
  const refreshOnActive = useRef(false)
  const refreshTask = useRef<() => Promise<void>>(async () => {})
  const refreshSnapshot = useRef({ caseBusy, caseId, experimentId, runId, job })
  refreshSnapshot.current = { caseBusy, caseId, experimentId, runId, job }
  const cases: any[] = detail?.evaluation?.cases ?? []

  async function call(operation: string, payload: Record<string, unknown> = {}) {
    const result = await rpc.call(CHANNEL, `agents/${operation}`, payload) as RpcResult
    if (!result.ok) throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), { rejected: true, code: result.error.code })
    return result.value
  }
  function location(overrides: Partial<PlatformNavigation> = {}): PlatformNavigation {
    return { page: 'evaluation', tab, agent_id: agentId || undefined, experiment_id: experimentId || undefined, run_id: runId || undefined, run_tab: tab === 'runs' && runTab !== 'report' ? runTab : undefined, case_id: caseId || undefined, ...overrides }
  }
  function leaveDrafts() {
    if (deleteLock.current || current.current.caseBusy || current.current.datasetBusy || current.current.newCaseBusy) return false
    const confirmed = !(current.current.caseDirty || current.current.datasetDirty || current.current.newCaseDirty) || window.confirm('当前有未保存的用例或样本。离开将丢弃草稿，是否继续？')
    if (confirmed && current.current.datasetDirty) { setDatasetEpoch(value => value + 1); setDatasetDirty(false) }
    if (confirmed && current.current.newCaseDirty) setNewCase(null)
    return confirmed
  }
  function resetScope(nextAgent: string, nextExperiment: string) {
    recordScope.current = null
    detailRequest.current++; caseRequest.current++; evalRequest.current++; compareRequest.current++
    setNewCase(null); setAgentId(nextAgent); setExperimentId(nextExperiment); setDetail(null); setCaseId(''); setCaseDocument(null); setCaseDraft(null); setCaseLatest(null); setCaseEditing(false); setSelectedCases([]); setCaseMessage(''); setCaseConflict(false)
    setConfigOpen(false); releasePreview(); setEvalError(''); setEvalBusy(false)
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
  function chooseRun(id: string, nextTab: Tab = tab) {
    if (id !== runId && !leaveDrafts()) return
    if (tab === 'runs' && !runId) { recordScope.current = { agent: agentId, experiment: experimentId }; returnToComparison.current = false }
    runSelectionVersion.current++
    if (typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement) runListTrigger.current = document.activeElement
    focusRunDetail.current = true
    if (id !== runId) {
      runRequest.current++; fileRequest.current++; setRunId(id); setRunDetail(null); setReport(null); setRunFiles(null); setResultCaseId(''); setFilePath(''); setFilePreview(null)
    }
    setTab(nextTab); setRunTab('report')
    onNavigate?.(location({ tab: nextTab, run_id: id, run_tab: undefined, case_id: undefined, job_id: undefined }))
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
    try { const value = await call('list'); if (request === listRequest.current) { setAssetScope(value.root || ''); setAgents(value.agents ?? []); setExperiments([...(value.experiments ?? []), ...(value.historical_experiments ?? [])]); setAgentsError(''); if (!(value.agents ?? []).length) setRunListReady(true) } }
    catch (error) { if (request === listRequest.current) { setAgentsError((error as Error).message); setRunListReady(true) } }
  }
  async function loadJobs() {
    const request = ++jobsRequest.current
    setJobsLoading(true); setJobsError('')
    try { const value = await call('eval/list'); if (request === jobsRequest.current) { setJobs((value.runs ?? []).filter((item: EvaluationExecution) => item.run_created && item.run_id)); setJobsError((value.errors ?? []).map((item: any) => `${item.path || '运行观察'}：${item.message || item.error || '暂不可读'}`).join('；')) } }
    catch (error) { if (request === jobsRequest.current) setJobsError((error as Error).message) }
    finally { if (request === jobsRequest.current) setJobsLoading(false) }
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
          ...run, run_id: run.run_id ?? run.id, experiment_id: run.source_id?.startsWith('business:') ? run.source_id : experiment.experiment_id ?? experiment.id, agent_id: agent.agent_id,
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
      if (snapshot.job && executionKey(snapshot.job) && !isFinal(snapshot.job.status)) tasks.push(statusEvaluation(executionKey(snapshot.job)))
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
  function requestDelete(target: DeleteTarget) {
    if (deleteLock.current) return
    setDeleteError(''); setDeleteNotice(''); setDeleteTarget(target)
  }
  async function confirmDelete() {
    if (!deleteTarget || deleteLock.current) return
    const target = deleteTarget
    deleteLock.current = true; setDeleteBusy(true); setDeleteError('')
    try {
      if (target.kind === 'case') {
        setCaseBusy(true)
        await call('cases/delete', { experiment_id: target.experimentId, case_id: target.document.case.id, expected_sha256: target.document.sha256 })
        caseRequest.current++
        if (current.current.experimentId === target.experimentId && current.current.caseId === target.document.case.id) {
          setCaseId(''); setCaseDocument(null); setCaseDraft(null); setCaseLatest(null); setCaseEditing(false); setCaseMessage(''); setCaseConflict(false)
          onNavigate?.(location({ case_id: undefined }))
        }
        setSelectedCases(ids => ids.filter(id => id !== target.document.case.id))
        setDeleteNotice(`已删除测试用例「${target.document.case.title}」。历史评测的冻结用例与结果保持不变。`)
        setDeleteTarget(null)
        await loadDetail()
      } else {
        const result = await call('runs/delete', { run_ids: target.runs.map(run => run.run_id) })
        const deleted = new Set<string>(result.deleted)
        runsRequest.current++; jobsRequest.current++
        setRuns(items => items.filter(run => !deleted.has(run.run_id)))
        setJobs(items => items.filter(job => !job.run_id || !deleted.has(job.run_id)))
        setSelectedRuns(ids => ids.filter(id => !deleted.has(id)))
        if (job?.run_id && deleted.has(job.run_id)) setJob(null)
        if (deleted.has(current.current.runId)) { runRequest.current++; fileRequest.current++; setRunDetail(null); setReport(null); setRunId(''); setResultCaseId(''); onNavigate?.(location({ run_id: undefined, case_id: undefined, job_id: undefined })) }
        if (deleted.has(leftRun) || deleted.has(rightRun)) {
          compareRequest.current++; setComparison(null); setCompareError(''); setCompareBusy(false)
          if (deleted.has(leftRun)) setLeftRun('')
          if (deleted.has(rightRun)) setRightRun('')
        }
        setDeleteNotice(`已删除 ${result.deleted.length} 条评测记录${result.failed.length ? `，${result.failed.length} 条未删除。` : '。'}`)
        if (result.failed.length) {
          setDeleteTarget({ kind: 'runs', runs: target.runs.filter(run => result.failed.some((item: any) => item.run_id === run.run_id)) })
          setDeleteError(result.failed.map((item: any) => `${item.run_id}：${item.message}`).join('；'))
        } else setDeleteTarget(null)
        await Promise.allSettled([loadRuns(), loadJobs()])
      }
    } catch (error) { setDeleteError(`${(error as Error & { rejected?: boolean }).rejected ? '删除失败' : '删除结果待核对'}：${(error as Error).message}。请刷新核对后再操作。`) }
    finally { deleteLock.current = false; setDeleteBusy(false); setCaseBusy(false) }
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
    } catch (error) { if (request === caseRequest.current) setCaseMessage(`读取用例失败：${(error as Error).message}。${caseDocument ? '当前显示上次读取内容；草稿已保留。' : '请重试读取用例。'}`) }
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
  function evalPayload() { return { source: experimentId.startsWith('business:') ? experimentId : `experiment:${experimentId}`, mode: caseScope === 'selected' ? 'full' : caseScope, executor, review: executor === 'browser' ? 'none' : review, ...(caseScope === 'selected' ? { cases: selectedCases } : {}) } }
  function releasePreview() {
    const id = previewRun.current
    previewRun.current = null; setEvalPreview(null)
    if (id && evalSubmission.current?.run_id !== id) void call('eval/cancel', { run_id: id }).catch(() => {})
  }
  function clearPreview() { evalRequest.current++; releasePreview(); setEvalError('') }
  async function readPreview(payload: Record<string, unknown>, request: number) {
    const value = await call('eval/preview', payload)
    if (typeof value.run_id !== 'string' || !/^run-[0-9a-f-]{36}$/.test(value.run_id)) throw new Error('评测预览未返回有效 Run ID，请重新预览。')
    if (request !== evalRequest.current || !current.current.active) { void call('eval/cancel', { run_id: value.run_id }).catch(() => {}); return null }
    const preview = { ...(value.result ?? value), run_id: value.run_id }
    previewRun.current = value.run_id; setEvalPreview(preview)
    return preview
  }
  async function previewEvaluation() {
    if (!experimentId || !assetScope || evalSending.current || evalSubmission.current) return
    releasePreview()
    const request = ++evalRequest.current
    setEvalBusy(true); setEvalError('')
    try { await readPreview(evalPayload(), request) }
    catch (error) { if (request === evalRequest.current) setEvalError((error as Error).message) }
    finally { setEvalBusy(false) }
  }
  function finishSubmission(submission: EvaluationSubmission, message = '') {
    if (evalSubmission.current !== submission) return
    clearSubmission(submission); evalSubmission.current = null; setEvalPending(null); setPendingObservation(null); setEvalError(message)
    if (previewRun.current === submission.run_id) { previewRun.current = null; setEvalPreview(null) }
  }
  async function startEvaluation() {
    if (!experimentId || !assetScope || evalSending.current || evalSubmission.current) return
    evalSending.current = true
    const request = ++evalRequest.current, payload = evalPayload()
    const origin = { agentId, experimentId, previousRunId: runId, tab, runSelection: runSelectionVersion.current, scope: assetScope }
    setEvalBusy(true); setEvalError('')
    let submission: EvaluationSubmission | null = null
    try {
      const preview = evalPreview?.run_id && previewRun.current === evalPreview.run_id ? evalPreview : await readPreview(payload, request)
      if (!preview || request !== evalRequest.current) return
      submission = { ...origin, run_id: preview.run_id, payload }
      evalSubmission.current = submission; evalPersisted.current = saveSubmission(submission); setEvalPending(submission)
      const value = await call('eval/start', { ...payload, run_id: submission.run_id })
      if (value.run_id !== submission.run_id || value.run_created !== true) throw new Error('尚未核对到完整的 Run 创建回执，请查询原 Run。')
      finishSubmission(submission)
      void loadJobs(); void loadRuns()
      const state = current.current
      if (request === evalRequest.current && state.active && state.agentId === origin.agentId && state.experimentId === origin.experimentId && state.tab === origin.tab && state.runId === origin.previousRunId && runSelectionVersion.current === origin.runSelection) {
        setJob({ ...value, agent_id: origin.agentId, experiment_id: origin.experimentId }); setJobError(''); setConfigOpen(false)
        chooseRun(value.run_id, 'runs')
      }
    } catch (error) {
      if (submission && (error as any).rejected && !['observation_unknown', 'cleanup_failed', 'run_read_failed', 'conflict'].includes(String((error as any).code))) {
        finishSubmission(submission, `${(error as Error).message} 请重新预览后发起新的评测。`)
      } else if (submission) {
        setEvalError((error as any).rejected ? `${(error as Error).message} 已保留原 Run，只能查询核对，不会重新启动。` : '此次 Run 的受理结果待核对。恢复时仅查询原 Run，不会重新发起评测。')
        await recoverPendingEvaluation()
      } else if (request === evalRequest.current) setEvalError((error as Error).message)
    } finally { evalSending.current = false; setEvalBusy(false) }
  }
  async function recoverPendingEvaluation() {
    const submission = evalSubmission.current
    if (!submission) return
    try {
      const value = await call('eval/status', submission.legacy_id ? { job_id: submission.legacy_id } : { run_id: submission.run_id }) as EvaluationExecution
      if (evalSubmission.current !== submission) return
      setPendingObservation(value)
      if (value.run_created && value.run_id) {
        if (value.source && value.source !== submission.payload.source) { finishSubmission(submission, '查询结果不属于原评测目标，未执行任何启动。请重新预览。'); return }
        finishSubmission(submission)
        void loadJobs(); void loadRuns()
        if (current.current.runId === value.run_id) { setJob(value); setJobError('') }
      } else if (value.status === 'prepared') {
        setEvalError('该 Run 尚未启动。可撤销预留后重新预览，当前不会重发启动请求。')
      } else if (isFinal(value.status) && !value.run_created) {
        finishSubmission(submission, '此次评测未形成可继续的运行记录，请重新预览。')
      } else setEvalError('原评测仍在准备或状态待核对，当前只查询，不会重新启动。')
    } catch (error) {
      if (evalSubmission.current !== submission) return
      if (missingExecution(error)) finishSubmission(submission, '未找到可继续的运行记录，请重新预览后发起新的评测。')
      else setEvalError('暂时无法核对原评测状态。已保留原身份，请恢复连接后重新查询。')
    }
  }
  async function cancelPendingEvaluation() {
    const submission = evalSubmission.current
    if (!submission) return
    const id = submission.legacy_id || submission.run_id
    if (!id || cancellingJob.current === id) return
    cancellingJob.current = id
    try {
      const value = await call('eval/cancel', submission.legacy_id ? { job_id: id } : { run_id: id }) as EvaluationExecution
      if (evalSubmission.current !== submission) return
      if (value.status === 'cancelled' && !value.run_created) finishSubmission(submission, '预留或创建已取消，请重新预览。')
      else { setPendingObservation(value); setEvalError('已请求取消，正在核对收尾状态。'); await recoverPendingEvaluation() }
    } catch (error) {
      if (missingExecution(error)) finishSubmission(submission, '未找到可继续的运行记录，请重新预览。')
      else setEvalError((error as Error).message)
    } finally { if (cancellingJob.current === id) cancellingJob.current = '' }
  }
  async function statusEvaluation(id = executionKey(job), legacy = Boolean(job?.legacy_id && !job?.run_id)) {
    if (!id) return
    try {
      const value = await call('eval/status', legacy ? { job_id: id } : { run_id: id }) as EvaluationExecution
      const state = current.current
      if (legacy) {
        if (state.targetRunId || state.targetJobId !== id) return
        if (value.run_created && value.run_id) {
          setJob(value); setJobError(''); setTab('runs'); setRunId(value.run_id)
          onNavigate?.({ page: 'evaluation', tab: 'runs', run_id: value.run_id, agent_id: value.agent_id || state.agentId || undefined, experiment_id: value.experiment_id || state.experimentId || undefined, replace: true })
        } else { setJob({ ...value, legacy_id: id }); setJobError('') }
      } else {
        if (state.runId !== id) return
        setJob(previous => executionKey(previous) === id || state.runId === id ? value : previous); setJobError('')
      }
      if (isFinal(value.status)) scheduleRefresh(0)
    } catch (error) {
      const state = current.current
      if (legacy ? state.targetRunId || state.targetJobId !== id : state.runId !== id) return
      if (legacy && missingExecution(error)) {
        setJob(null); setJobError('该旧评测未形成可继续的运行记录，可返回评测记录或重新预览。')
      } else setJobError((error as Error).message)
    }
  }
  async function cancelEvaluation(id: string) {
    if (!job || executionKey(job) !== id || !['running', 'preparing', 'prepared', 'unknown'].includes(job.status) || cancellingJob.current === id) return
    cancellingJob.current = id
    setJob(previous => previous && executionKey(previous) === id ? { ...previous, status: 'cancelling' } : previous)
    try { await call('eval/cancel', job?.run_id ? { run_id: id } : { job_id: id }); await statusEvaluation(id) }
    catch (error) { if (executionKey(job) === id) setJobError((error as Error).message) }
    finally { if (cancellingJob.current === id) cancellingJob.current = '' }
  }
  function restoreLegacy(id: string) {
    if (current.current.targetRunId) return
    setJob({ run_id: null, run_created: false, legacy_id: id, status: 'unknown' }); setJobError('')
    void statusEvaluation(id, true)
  }
  useEffect(() => { void runRefresh(); return () => { listRequest.current++; runsRequest.current++; jobsRequest.current++; detailRequest.current++; caseRequest.current++; runRequest.current++; fileRequest.current++; compareRequest.current++; evalRequest.current++; if (refreshTimer.current !== undefined) { window.clearTimeout(refreshTimer.current); refreshTimer.current = undefined } } }, [])
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
    if (!active || tab !== 'jobs' || jobsLoading || !focusJobDetail.current || !target?.job_id || job?.legacy_id !== target.job_id || !jobDetailHeading.current) return
    focusJobDetail.current = false
    if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return
    jobDetailHeading.current.scrollIntoView({ block: 'start' })
    jobDetailHeading.current.focus({ preventScroll: true })
  }, [active, tab, jobsLoading, target?.job_id, job?.legacy_id])
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
    if ((target.run_id ?? '') !== current.current.runId) runSelectionVersion.current++
    const state = current.current
    const nextTab = tabValue(target.tab), nextAgent = target.agent_id ?? '', nextExperiment = target.experiment_id ?? '', nextRun = target.run_id ?? '', nextCase = target.case_id ?? ''
    if (nextTab === 'jobs' && target.job_id && target.job_id !== job?.legacy_id) focusJobDetail.current = true
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
    if (target?.page !== 'evaluation') return
    if (target.run_id) { void statusEvaluation(target.run_id, false); return }
    if (target.job_id) restoreLegacy(target.job_id)
  }, [target?.page, target?.run_id, target?.job_id])
  useEffect(() => {
    if (!assetScope || restoredScope.current === assetScope) return
    restoredScope.current = assetScope
    let saved = savedSubmission(assetScope)
    if (!saved) try {
      const previous = JSON.parse(window.sessionStorage.getItem(legacySubmissionKey()) ?? 'null')
      if (previous && typeof previous.request_id === 'string' && legacyRequestId.test(previous.request_id) && previous.payload?.source === `experiment:${previous.experimentId}`) saved = {
        run_id: '', legacy_id: previous.request_id, payload: previous.payload, agentId: previous.agentId, experimentId: previous.experimentId,
        previousRunId: previous.runId ?? '', tab: previous.tab ?? 'runs', runSelection: 0, scope: assetScope,
      }
      else if (previous) window.sessionStorage.removeItem(legacySubmissionKey())
    } catch {}
    evalSubmission.current = saved; setEvalPending(saved); setPendingObservation(null); evalPersisted.current = true
    if (saved) void recoverPendingEvaluation()
  }, [assetScope])
  useEffect(() => {
    if (target?.page !== 'evaluation' || target.intent !== 'start_eval') return
    setConfigOpen(true)
    onNavigate?.({ ...target, intent: undefined, replace: true })
  }, [target?.page, target?.intent])
  useEffect(() => {
    if (active || !(current.current.caseDirty || current.current.datasetDirty || current.current.newCaseDirty || current.current.datasetBusy || current.current.newCaseBusy || current.current.caseBusy)) return
    if (!leaveDrafts()) { onNavigate?.(location()); return }
    setCaseDraft(caseDocument ? draftFor(caseDocument) : null); setCaseEditing(false)
  }, [active])
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (deleteLock.current || evalSubmission.current && !evalPersisted.current || current.current.caseDirty || current.current.datasetDirty || current.current.newCaseDirty || current.current.datasetBusy || current.current.newCaseBusy || current.current.caseBusy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [])
  useEffect(() => { if (!active && !evalSubmission.current) releasePreview() }, [active])
  useEffect(() => { if (active && configOpen) configDialog.current?.showModal(); else configDialog.current?.close() }, [active, configOpen])
  useEffect(() => {
    const dialog = deleteDialog.current
    if (active && deleteTarget) { if (dialog && !dialog.open) dialog.showModal() }
    else if (dialog?.open) dialog.close()
  }, [active, deleteTarget])
  useEffect(() => { setSelectedRuns([]) }, [agentId, experimentId, runStatus, runVerdictFilter, objectTypeFilter, runSearch])
  useEffect(() => {
    const dialog = cancelDialog.current
    if (!dialog) return
    if (active && job && cancelJobId && executionKey(job) === cancelJobId && ['running', 'preparing', 'unknown'].includes(job.status) && !jobError) {
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
      if (cancelJobId) setCancelJobId('')
    }
  }, [active, cancelJobId, job?.run_id, job?.legacy_id, job?.status, jobError])
  useEffect(() => {
    if (!active) return
    if (refreshOnActive.current) { refreshOnActive.current = false; refreshNow() }
  }, [active])
  useEffect(() => updates?.subscribe(() => {
    if (!updates.getSnapshot().domains.some(domain => ['agents', 'catalog'].includes(domain))) return
    scheduleRefresh()
  }), [updates])
  useEffect(() => {
    if (!job || !executionKey(job) || isFinal(job.status)) return
    const timer = window.setInterval(() => void statusEvaluation(), 2500)
    return () => window.clearInterval(timer)
  }, [job?.run_id, job?.legacy_id, job?.status])

  const controls = [...jobs, ...(job?.run_created && job.run_id ? [job] : [])].sort((a, b) => (a.updated_at ?? '').localeCompare(b.updated_at ?? ''))
  const byRun = new Map(runs.map(run => [run.run_id, run]))
  for (const control of controls) {
    if (!control.run_created || !control.run_id) continue
    const previous = byRun.get(control.run_id)
    const experiment = control.source?.startsWith('business:') ? control.source : control.experiment_id || (control.source?.startsWith('experiment:') ? control.source.slice(11) : '')
    const agent = control.agent_id || experiments.find(item => item.id === experiment)?.agent_id || previous?.agent_id || ''
    byRun.set(control.run_id, { ...previous, run_id: control.run_id, agent_id: agent, experiment_id: experiment || previous?.experiment_id || '',
      status: previous && isFinal(previous.status) ? previous.status : control.status,
      created_at: previous?.created_at || control.started_at, finished_at: previous?.finished_at,
    })
  }
  const recordRuns = [...byRun.values()].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const runExperiments = [...new Set(recordRuns.filter(run => !agentId || run.agent_id === agentId).map(run => run.experiment_id))]
  const objectType = (id?: string | null) => evaluationObjectType(id ?? '', experiments)
  const filteredRuns = recordRuns.filter(run => (!objectTypeFilter || objectType(run.experiment_id) === objectTypeFilter) && (!agentId || run.agent_id === agentId) && (!experimentId || run.experiment_id === experimentId) && (!runStatus || run.status === runStatus) && (!runVerdictFilter || verdictIfCompleted(run.status, run.effective_verdict) === runVerdictFilter) && (!runSearch || `${run.run_id} ${run.agent_id} ${evaluationAgentName(agents, run.agent_id)} ${run.experiment_id} ${run.title ?? ''}`.toLowerCase().includes(runSearch.toLowerCase())))
  const deletableRuns = filteredRuns.filter(run => isFinal(run.status) && !run.stale)
  const selectedRecords = deletableRuns.filter(run => selectedRuns.includes(run.run_id))
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
  const selectedRunAgentId = visibleRunDetail?.manifest?.agent_id || recordRuns.find(run => run.run_id === runId)?.agent_id || agentId
  const selectedRun = recordRuns.find(run => run.run_id === runId)
  const selectedAgentName = evaluationAgentName(agents, selectedRunAgentId)
  const selectedRunVersion = visibleRunDetail?.manifest?.experiment_id || selectedRun?.experiment_id || experimentId
  const agentName = (id?: string | null) => evaluationAgentName(agents, id)
  const runName = (run: Run) => run.title?.trim() || `${agentName(run.agent_id)} ${versionName(run.experiment_id)} 评测`
  const runCaseSummary = (run: Run) => caseSummary(visibleRunDetail?.run_id === run.run_id && observedCases.length
    ? { total: observedCases.length, ...caseCounts } : run.case_counts)
  const highlightedJob = runId ? [...controls].reverse().find(item => item.run_id === runId) : target?.job_id ? job : null
  const highlightedJobVersion = highlightedJob?.experiment_id ? versionName(highlightedJob.experiment_id) : '版本待读取'
  const selectedComparison = comparison?.cases?.find((item: any) => item.case_id === compareCaseId)
  const comparedCases = comparison ? [comparison.left_view, comparison.right_view].map(view => view.cases.find((item: any) => item.case_id === compareCaseId)) : []
  const pairedCaseRows: PairedCaseRows = { inputs: Math.max(1, ...comparedCases.map(item => item?.frozen?.inputs?.length ?? 0)), outputs: Math.max(1, ...comparedCases.map(item => Array.isArray(item?.output) ? item.output.length : 0)), trials: Math.max(1, ...comparedCases.map(item => item?.trials?.length ?? 0)) }
  const selectedFile = runFiles?.files?.find((file: RunFile) => file.path === filePath)
  const sealed = runFiles?.sealed ?? isFinal(visibleRunDetail?.manifest?.status)
  const sourceVersions: string[] = agentId ? [`business:${agentId}`, ...(detail?.versions ?? []).map((version: any) => version.id)] : []
  const versions: string[] = [...new Set([...sourceVersions, ...(tab === 'runs' || tab === 'compare' ? runExperiments : [])])]
  const showRecords = tab === 'runs' || tab === 'jobs'
  const scopeControls = <>
    <button type="button" className="harness-eval-mobile-filter-toggle" aria-expanded={scopeFiltersOpen} aria-controls="evaluation-scope-filters" onClick={() => setScopeFiltersOpen(open => !open)}>筛选：{agentId ? agentName(agentId) : '全部智能体'} · {experimentId || '全部版本'}</button>
    <div id="evaluation-scope-filters" className="harness-eval-filters harness-eval-scope-filters" data-mobile-open={scopeFiltersOpen}><label>智能体<SearchSelect label="评测智能体" value={agentId} onChange={value => changeScope(value)} options={[{ value: '', label: '全部智能体' }, ...agents.map(agent => ({ value: agent.id, label: agentName(agent.id), description: agent.id }))]} /></label><label>版本<SearchSelect label="评测版本" value={experimentId} disabled={!agentId} onChange={value => changeScope(agentId, value)} options={[{ value: '', label: '全部版本' }, ...versions.map(id => ({ value: id, label: versionName(id), description: `${objectType(id)} · ${id}` }))]} /></label>{showRecords && <label>对象类型<select aria-label="筛选对象类型" value={objectTypeFilter} onChange={event => setObjectTypeFilter(event.target.value)}><option value="">全部类型</option><option value="智能体">智能体</option><option value="变体">变体</option></select></label>}<label>评测结论<select aria-label="筛选评测结论" value={runVerdictFilter} onChange={event => setRunVerdictFilter(event.target.value)}><option value="">全部结论</option>{['passed', 'failed', 'inconclusive'].map(verdict => <option key={verdict} value={verdict}>{verdictLabel(verdict)}</option>)}</select></label><button type="button" onClick={refreshNow} aria-busy={runsLoading || jobsLoading || detailLoading}>刷新{(runsLoading || jobsLoading || detailLoading) ? <LoadingIndicator label="读取评测记录与版本" /> : null}</button>{detailError && <p role="alert">{detailError}</p>}</div>
  </>

  return <main className="harness-evaluation" aria-label="评测中心">
    <header className="harness-page-heading harness-eval-page-heading">
      <div><span className="harness-eval-eyebrow"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 15V9m6 6V5m6 10V2M2 18h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>验证 · 比较 · 改进</span><h1>评测中心</h1><p>选择测试用例，运行评测，并比较各版本的结果。</p></div>
    </header>
    {evalPending && !evalBusy && <section className="harness-eval-limits" role="status" aria-label="待核对的评测请求"><strong>评测受理结果待核对</strong>{evalPending.run_id && <p>Run ID：{evalPending.run_id}</p>}<p>原目标：{agentName(evalPending.agentId)} · {versionName(evalPending.experimentId)}（{evalPending.experimentId}）。请求可能已经执行；这里只查询原评测状态，不重新发送启动请求。</p><button type="button" onClick={() => void recoverPendingEvaluation()}>核对原评测请求</button><button type="button" disabled={pendingObservation?.status === 'cancelling'} onClick={() => void cancelPendingEvaluation()}>{pendingObservation?.status === 'prepared' ? '撤销预留' : '取消此次评测'}</button>{evalError && <p role="alert">{evalError}</p>}</section>}
    {!evalPending && !configOpen && evalError && <p role="alert">{evalError}</p>}
    <header className="harness-eval-toolbar"><div role="tablist" aria-label="评测工作区" className="harness-eval-tabs" onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === (tab === 'jobs' ? 'runs' : tab))
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault(); if (tabs[next].id === 'runs') returnToRecords(); else chooseTab(tabs[next].id); document.getElementById(`evaluation-tab-${tabs[next].id}`)?.focus()
    }}>{tabs.map(item => <button key={item.id} id={`evaluation-tab-${item.id}`} type="button" role="tab" aria-selected={(tab === 'jobs' ? 'runs' : tab) === item.id} aria-controls={item.id === 'runs' ? runId ? 'evaluation-panel-runs' : 'evaluation-record-list' : `evaluation-panel-${item.id}`}  tabIndex={(tab === 'jobs' ? 'runs' : tab) === item.id ? 0 : -1} onClick={() => item.id === 'runs' ? returnToRecords() : chooseTab(item.id)}>{item.label}</button>)}</div><button type="button" className="harness-primary" onClick={() => { setConfigOpen(true); clearPreview() }}>新建评测</button></header>

    {agentsError && <p role="alert">{agentsError}</p>}
    {highlightedJob && <section id="evaluation-job-detail" role="region" className="harness-eval-job harness-card" aria-label="评测进度" data-state={highlightedJob.status}>
      <div className="harness-eval-job-content"><small>{highlightedJob.run_id ? `Run ID：${highlightedJob.run_id}` : '旧评测尚未形成运行记录'}</small><div className="harness-eval-job-title"><strong ref={jobDetailHeading} tabIndex={-1}>{agentName(highlightedJob.agent_id)} {highlightedJobVersion} · {objectType(highlightedJob.experiment_id)}</strong><span className="harness-eval-badge" data-state={highlightedJob.status}>{executionLabel(highlightedJob.status)}</span></div>
        <p>{['running', 'cancelling', 'preparing'].includes(highlightedJob.status) ? elapsed(highlightedJob.started_at) || `开始于 ${time(highlightedJob.started_at)}` : `开始于 ${time(highlightedJob.started_at)}`}</p>
        <p className="harness-eval-job-update">{jobError ? '最新进度暂不可读，保留上次观察；请恢复连接后刷新。' : '执行状态来自本次 Run；业务结论以运行证据为准。'}</p>
        {highlightedJob.error && <p role="alert">{highlightedJob.error}</p>}{jobError && <p role="alert">{jobError}</p>}
      </div><div className="harness-eval-actions"><button type="button" onClick={() => void statusEvaluation()}>刷新状态</button><button type="button" disabled={!!jobError || !['running', 'preparing', 'unknown'].includes(highlightedJob.status)} onClick={() => { setJob(highlightedJob); setCancelJobId(executionKey(highlightedJob)) }}>取消评测</button>{!highlightedJob.run_id && <button type="button" onClick={returnToRecords}>返回评测记录</button>}</div>
      <DetailDrawer title="Run 与执行日志" active={active && Boolean(runId || target?.job_id)} identity={executionKey(highlightedJob)}><p>来源版本：{highlightedJob.experiment_id || highlightedJob.source || '待读取'}<br />{highlightedJob.run_id ? `Run ID：${highlightedJob.run_id}` : '该旧评测尚无 Run ID。'}</p><pre>{`${highlightedJob.stdout || '等待输出…'}${highlightedJob.stderr ? `\n${highlightedJob.stderr}` : ''}`}</pre></DetailDrawer>
    </section>}
    {!runId && target?.job_id && jobError && !highlightedJob && <section className="harness-eval-limits" role="alert"><p>{jobError}</p><button type="button" onClick={() => restoreLegacy(target.job_id!)}>重新查询</button><button type="button" onClick={returnToRecords}>返回评测记录</button></section>}
    {!showRecords && (tab === 'cases' || tab === 'compare') && scopeControls}
    {deleteNotice && <p role="status">{deleteNotice}</p>}
    {showRecords &&     <section ref={runListHeading} tabIndex={-1} id="evaluation-record-list" role="tabpanel" aria-labelledby="evaluation-tab-runs" className="harness-card harness-eval-run-list harness-eval-record-list" hidden={Boolean(runId || tab === 'jobs')} data-expanded={recordExpanded} aria-busy={runsLoading || jobsLoading}>{scopeControls}<div className="harness-eval-record-extra"><div className="harness-eval-filters"><input aria-label="搜索评测记录" placeholder="搜索任务、Run、智能体或版本" value={runSearch} onChange={event => setRunSearch(event.target.value)} /><select aria-label="筛选运行状态" value={runStatus} onChange={event => setRunStatus(event.target.value)}><option value="">全部状态</option>{['planned', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'unknown'].map(status => <option key={status} value={status}>{executionLabel(status)}</option>)}</select></div></div>{runsError && <p role="alert">Run 列表读取失败：{runsError}。可刷新重试。</p>}{jobsError && <p role="alert">Run 状态读取失败：{jobsError}。可刷新重试。</p>}<div className="harness-eval-actions harness-eval-delete-toolbar"><label className="harness-eval-check"><input type="checkbox" aria-label="选择当前筛选下所有可删除评测" disabled={!deletableRuns.length || deleteBusy} checked={!!deletableRuns.length && selectedRecords.length === deletableRuns.length} aria-checked={selectedRecords.length && selectedRecords.length < deletableRuns.length ? 'mixed' : selectedRecords.length > 0} onChange={event => setSelectedRuns(event.target.checked ? deletableRuns.map(run => run.run_id) : [])} />全选可删除记录</label><span>已选 {selectedRecords.length} 条</span><button type="button" className="harness-eval-delete" disabled={!selectedRecords.length || deleteBusy} onClick={() => requestDelete({ kind: 'runs', runs: selectedRecords })}>批量删除</button><small className="harness-eval-muted">执行中的评测请先取消，结束后再删除。</small></div><div className="harness-table-scroll" role="region" aria-label="评测记录，可横向滚动查看完整列" tabIndex={0}><table className="harness-eval-run-table" aria-label="评测记录列表"><thead><tr><th>评测名称</th><th>所属智能体</th><th>被测版本</th><th>对象类型</th><th>执行状态</th><th>评测结论</th><th>用例结果</th><th>时间</th><th>操作</th></tr></thead><tbody>{filteredRuns.map(run => <tr key={run.run_id} data-selected={runId === run.run_id} onClick={() => chooseRun(run.run_id, 'runs')}><td data-label="评测名称"><div className="harness-eval-record-name"><input type="checkbox" aria-label={`选择评测 ${run.run_id}`} disabled={!isFinal(run.status) || run.stale || deleteBusy} checked={selectedRecords.some(item => item.run_id === run.run_id)} onClick={event => event.stopPropagation()} onChange={event => setSelectedRuns(ids => event.target.checked ? [...ids, run.run_id] : ids.filter(id => id !== run.run_id))} /><button type="button" className="harness-eval-row-link" title={run.run_id} aria-label={`查看 ${runName(run)}，Run ${run.run_id}`} aria-pressed={runId === run.run_id} onClick={event => { event.stopPropagation(); chooseRun(run.run_id, 'runs') }}><strong className="harness-eval-object-name">{runName(run)}</strong><small className="harness-eval-case-meta">{run.case_scope || '用例范围未知'}</small><small className="harness-eval-run-id">Run ID：{run.run_id}</small></button></div></td><td data-label="所属智能体">{agentName(run.agent_id)}</td><td data-label="被测版本"><strong className="harness-eval-version-name" title={run.experiment_id}>{versionName(run.experiment_id)}</strong></td><td data-label="对象类型"><span className="harness-eval-badge">{objectType(run.experiment_id)}</span></td><td data-label="执行状态"><span className="harness-eval-badge" data-state={run.status}>{executionLabel(run.status)}</span></td><td data-label="评测结论">{run.stale && <small role="status">上次读取结果，当前记录暂不可读</small>}<span className="harness-eval-badge" data-state={verdictIfCompleted(run.status, run.effective_verdict) || 'unknown'}>{verdictLabel(verdictIfCompleted(run.status, run.effective_verdict))}</span>{separatedReview(run.review_contract) && <small className="harness-eval-review-status">业务效果复核：{effectReviewLabel(run.review_status)}<br />源码诊断：{sourceDiagnosisLabel(run.source_diagnosis)}</small>}</td><td data-label="用例结果">{runCaseSummary(run) ? <>{runCaseSummary(run)}{run.status !== 'completed' && <small>部分记录，非最终结论</small>}</> : <span className="harness-eval-muted">结果未知 · 逐例记录待核对</span>}</td><td data-label="时间"><span className="harness-eval-timestamp">开始：<time dateTime={run.created_at}>{time(run.created_at)}</time></span><span className="harness-eval-timestamp">结束：{run.finished_at ? <time dateTime={run.finished_at}>{time(run.finished_at)}</time> : ['planned', 'preparing', 'running', 'cancelling'].includes(run.status ?? '') ? '尚未结束' : '未记录'}</span></td><td data-label="操作"><div className="harness-eval-record-actions"><button type="button" className="harness-eval-open-result" onClick={event => { event.stopPropagation(); chooseRun(run.run_id, 'runs') }}>{runId === run.run_id ? '已选中' : '查看结果'}</button><button type="button" className="harness-eval-delete" aria-label={`删除评测 ${run.run_id}`} title={!isFinal(run.status) ? '评测结束后可删除' : run.stale ? '请刷新核对当前记录后再删除' : '删除这次评测及其结果证据'} disabled={!isFinal(run.status) || run.stale || deleteBusy} onClick={event => { event.stopPropagation(); requestDelete({ kind: 'runs', runs: [run] }) }}>删除</button></div></td></tr>)}</tbody></table></div>{!runsLoading && !jobsLoading && !filteredRuns.length && !runsError && !jobsError && !agentsError && <Empty>当前筛选范围暂无评测记录。可新建评测，或选择其他智能体与版本。</Empty>}<div className="harness-eval-list-footer"><span>{(runsLoading || jobsLoading) && !runs.length && !jobs.length ? '—' : `共 ${filteredRuns.length} 条评测记录`}</span><span>结论仅适用于对应评测范围；逐例摘要来自本次 Run 的冻结用例与记录，缺失时标为未知。</span><button type="button" aria-expanded={recordExpanded} onClick={() => setRecordExpanded(value => !value)}>{recordExpanded ? '收起列表' : '展开列表'}</button></div></section>}
    <section role="tabpanel" id="evaluation-panel-cases" aria-labelledby="evaluation-tab-cases" hidden={tab !== 'cases'}>
      {!agentId || !experimentId ? <Empty>选择智能体和具体版本后维护用例或运行评测。</Empty> : <>
        <p className="harness-eval-note">用例保存在 business-agents 中；Git tag 使用对应提交的只读快照。正在执行和历史 Run 保留各自冻结的用例定义。</p>
        <div className="harness-eval-workbench">
          <section className="harness-card harness-eval-list-card" aria-label="测试用例列表"><div className="harness-eval-section-heading"><h2>测试用例 <span>{cases.length}</span></h2><div className="harness-eval-actions"><button onClick={() => setNewCase({ agent: agentId, experiment: experimentId })}>＋ 新增用例</button></div></div>
            <div className="harness-eval-filters"><input aria-label="搜索测试用例" placeholder="搜索用例 ID、名称或输入" value={caseSearch} onChange={event => setCaseSearch(event.target.value)} /><select aria-label="筛选用例场景" value={sceneFilter} onChange={event => setSceneFilter(event.target.value)}><option value="">全部场景</option>{sceneOptions.map(scene => <option key={scene} value={scene}>{scene}</option>)}</select><select aria-label="筛选用例档位" value={tierFilter} onChange={event => setTierFilter(event.target.value)}><option value="">全部档位</option>{tierOptions.map(tier => <option key={tier} value={tier}>{tier}</option>)}</select></div>
            <div className="harness-table-scroll"><table className="harness-eval-case-table"><thead><tr><th>用例 · 场景 / 档位</th></tr></thead><tbody>{filteredCases.map(item => <tr key={item.id} data-selected={caseId === item.id} onClick={() => chooseCase(item.id)}><td><button type="button" className="harness-eval-row-link" aria-pressed={caseId === item.id} onClick={event => { event.stopPropagation(); chooseCase(item.id) }}><strong>{item.title || item.id}</strong><span>{item.id}</span><small className="harness-eval-case-meta">{item.scene || '未分组'} · {item.tier || '未记录'}</small></button></td></tr>)}</tbody></table></div>{!filteredCases.length && (detailLoading ? <LoadingIndicator label="读取用例列表" block /> : <Empty>没有匹配的用例。</Empty>)}
            <div className="harness-eval-list-footer"><span>选择用例查看与编辑。执行范围在“新建评测”中选择。</span></div>
          </section>
          <section className="harness-card harness-eval-case-detail" aria-label="用例详情">{!caseId || !filteredCases.some(item => item.id === caseId) ? <Empty>{caseId ? '所选用例不在当前筛选结果中，草稿已保留。请清除筛选后继续编辑。' : '从列表选择一个用例，查看输入与预期行为。'}</Empty> : <><div className="harness-eval-section-heading"><div><h2>{caseDocument?.case.title || caseId}{caseMessage === '正在读取用例…' ? <LoadingIndicator label="读取用例" /> : null}</h2><small className="harness-eval-muted">用例 {caseId}{caseDocument?.path ? ` · ${caseDocument.path}` : ''}</small></div>{caseDocument && !caseEditing && <div className="harness-eval-actions"><button type="button" disabled={caseBusy} onClick={() => { setCaseEditing(true); setCaseMessage('') }}>编辑用例</button><button type="button" className="harness-eval-delete" disabled={caseBusy || cases.length <= 1} title={cases.length <= 1 ? '评测合同要求至少保留一个测试用例' : '从当前智能体的共用用例集中删除'} onClick={() => requestDelete({ kind: 'case', experimentId, agentId, document: caseDocument })}>删除用例</button>{cases.length <= 1 && <small className="harness-eval-muted">至少保留一个测试用例</small>}</div>}</div>{caseConflict && <div className="harness-eval-conflict" role="alert"><p>用例已被其他任务修改。你的草稿仍在编辑框中，请先保留草稿，再对照最新内容合并。</p><div className="harness-eval-actions"><a className="harness-eval-download" href={`data:application/json;charset=utf-8,${encodeURIComponent(json(caseDraft))}`} download={`${caseId}-draft.json`}>下载用例草稿</a><button type="button" onClick={() => void loadCase()}>读取最新用例</button>{caseLatest && <button type="button" onClick={() => { setCaseDocument(caseLatest); setCaseConflict(false); setCaseMessage('已使用最新用例作为保存基准；草稿未改变，请核对合并后保存。') }}>使用最新版本作为保存基准</button>}</div>{caseLatest && <details><summary>查看最新用例（不覆盖草稿）</summary><pre>{json(caseLatest.case)}</pre></details>}</div>}{caseMessage && caseMessage !== '正在读取用例…' && <p role={caseMessage.startsWith('读取用例失败：') ? 'alert' : 'status'}>{caseMessage}{caseMessage.startsWith('读取用例失败：') && <button type="button" disabled={caseBusy} onClick={() => void loadCase()}>重试读取用例</button>}</p>}{caseDraft && caseDocument && (caseEditing ? <div className="harness-eval-editor"><label>名称<input aria-label="用例名称" disabled={caseBusy} value={caseDraft.title} onChange={event => setCaseDraft({ ...caseDraft, title: event.target.value })} /></label><h3>多轮输入</h3>{caseDraft.inputs.map((input, index) => <div className="harness-eval-input-turn" key={index}><label>第 {index + 1} 轮<textarea aria-label={`第 ${index + 1} 轮输入`} disabled={caseBusy} rows={4} value={input} onChange={event => setCaseDraft({ ...caseDraft, inputs: caseDraft.inputs.map((value, at) => at === index ? event.target.value : value) })} /></label><button type="button" disabled={caseBusy || caseDraft.inputs.length === 1} onClick={() => setCaseDraft({ ...caseDraft, inputs: caseDraft.inputs.filter((_, at) => at !== index) })}>移除第 {index + 1} 轮</button></div>)}<button type="button" disabled={caseBusy} onClick={() => setCaseDraft({ ...caseDraft, inputs: [...caseDraft.inputs, ''] })}>＋ 添加一轮输入</button><label>预期行为<textarea aria-label="用例预期行为" disabled={caseBusy} rows={5} value={caseDraft.expected_behavior} onChange={event => setCaseDraft({ ...caseDraft, expected_behavior: event.target.value })} /></label><CaseExpectedPreview text={caseDraft.expected_behavior} /><label className="harness-eval-check"><input type="checkbox" disabled={caseBusy} checked={caseDraft.fast} onChange={event => setCaseDraft({ ...caseDraft, fast: event.target.checked })} />纳入快速评测（fast）</label><div className="harness-eval-actions"><button type="button" className="harness-primary" disabled={caseBusy || !caseDirty} onClick={() => void saveCase()}>{caseBusy ? '保存中…' : '保存用例'}</button><button type="button" disabled={caseBusy} onClick={() => { if (caseDirty && !window.confirm('取消编辑并丢弃当前用例草稿？')) return; setCaseDraft(draftFor(caseDocument)); setCaseEditing(false); setCaseMessage(''); void loadCase() }}>取消编辑</button></div></div> : <><Facts items={[["场景", caseDocument.case.scene], ["评测档位", caseDraft.fast ? 'fast / full' : 'full']]} /><h4>多轮输入</h4><ol className="harness-eval-turns">{caseDocument.case.inputs.map((input, index) => <li key={index}>{input}</li>)}</ol><h4>当前用例预期行为</h4><CaseExpected text={caseDocument.case.expected_behavior} empty="当前用例未填写预期行为。" /></>)}</> }</section>
        </div>
      </>}
    </section>
    <section role="tabpanel" id="evaluation-panel-runs" aria-labelledby="evaluation-tab-runs" hidden={tab !== 'runs' || !runId}>
      <section className="harness-card harness-eval-run-detail" aria-label="Run 详情">{!runId ? <Empty>{runsLoading || !runListReady ? <LoadingIndicator label="读取评测结果" block /> : runsError && !runs.length ? '暂时无法读取已保存的评测结果；请刷新重试。' : !runs.length ? '当前没有已保存的 Run。可打开上方评测任务核对进展，或新建评测。' : '从运行列表选择一项，查看结论与需要核对的证据。'}</Empty> : <>
        <div className="harness-eval-section-heading"><div><div className="harness-eval-detail-title"><h2 ref={runDetailHeading} tabIndex={-1}>{selectedRunVersion ? versionName(selectedRunVersion) : '版本待读取'} · {objectType(selectedRunVersion)} · {selectedRun?.title?.trim() || `${selectedAgentName || '智能体'}评测`}</h2><span className="harness-eval-badge" data-state={verdictIfCompleted(visibleRunDetail?.manifest?.status ?? selectedRun?.status, summaryVerdict(visibleRunDetail?.summary) ?? selectedRun?.effective_verdict) || 'unknown'}>{verdictLabel(verdictIfCompleted(visibleRunDetail?.manifest?.status ?? selectedRun?.status, summaryVerdict(visibleRunDetail?.summary) ?? selectedRun?.effective_verdict))}</span>{runLoading && visibleRunDetail ? <LoadingIndicator label="刷新评测结果" /> : null}</div><small className="harness-eval-muted">{executionLabel(visibleRunDetail?.manifest?.status ?? selectedRun?.status)} · {time(visibleRunDetail?.manifest?.finished_at ?? selectedRun?.finished_at ?? visibleRunDetail?.manifest?.created_at ?? selectedRun?.created_at)} {visibleRunDetail?.manifest?.finished_at || selectedRun?.finished_at ? '结束' : '开始'}</small><DetailDrawer title="技术来源与 Run 信息" active={active && tab === 'runs'} identity={`${runId}:${runTab}`}><Facts items={[["来源版本", selectedRunVersion], ["Run ID", runId], ["智能体", selectedRunAgentId]]} />{visibleRunDetail && <><Facts items={[["机器结论", label(verdictIfCompleted(visibleRunDetail.manifest.status, visibleRunDetail.summary?.machine_overall_verdict ?? visibleRunDetail.summary?.overall_verdict))], ["开始时间", time(visibleRunDetail.manifest.created_at)], ["执行器", visibleRunDetail.source?.executor], [separatedReview(visibleRunDetail.source?.review_contract) ? "业务效果复核" : "复核", label(visibleRunDetail.summary?.review_status)]]} />{visibleRunDetail.missing?.length > 0 && <><h3>记录与采集缺口（{visibleRunDetail.missing.length}）</h3><ul>{visibleRunDetail.missing.map((value: string) => <li key={value}>{value}</li>)}</ul></>}<h3>Run 原始结构化记录</h3><pre>{json(visibleRunDetail)}</pre></>}{sealed ? <a className="harness-eval-download" href={download('archive')} download>下载完整 Run ZIP</a> : <p>完整包在 Run 封存后提供</p>}</DetailDrawer></div><div className="harness-eval-actions">{onAssistant && <button type="button" className="harness-primary" disabled={!visibleRunDetail} onClick={() => void onAssistant('请分析当前评测的业务结论、未通过或无法判定的用例与证据，提出可验证的改进建议；不要把执行结束当作业务通过。', { page: 'evaluation', agent_id: selectedRunAgentId, experiment_id: selectedRunVersion, run_id: runId })}>AI 分析并改进</button>}{report?.present && <a className="harness-eval-download" href={download('report')} download>下载报告</a>}<button type="button" onClick={() => { if (returnToComparison.current) { returnToComparison.current = false; setRunId(''); chooseTab('compare', { run_id: undefined, run_tab: undefined, case_id: undefined, job_id: undefined }) } else returnToRecords() }}>{returnToComparison.current ? '返回结果比较' : '返回评测记录'}</button></div></div>
        {extractError && <p role="alert">{extractError}</p>}{runLoading && !visibleRunDetail && <LoadingIndicator label="读取评测结果" block />}{runError && <p role="alert">结果读取失败：{runError}。{visibleRunDetail ? '以下为上次读取内容，可能已过期。' : '当前没有可显示的结果。'}可用页面顶部的“刷新”重试。</p>}
        {datasetSource && runTab === 'files' && <button type="button" onClick={() => chooseRunTab('datasets')}>返回样本复核（保留草稿）</button>}
        <div role="tablist" aria-label="Run 内容" className="harness-eval-subtabs" onKeyDown={event => { const ids: RunTab[] = ['report', 'results', 'files', 'datasets']; const index = ids.indexOf(runTab); const next = event.key === 'ArrowRight' ? (index + 1) % ids.length : event.key === 'ArrowLeft' ? (index + ids.length - 1) % ids.length : -1; if (next < 0) return; event.preventDefault(); chooseRunTab(ids[next]); document.getElementById(`evaluation-run-tab-${ids[next]}`)?.focus() }}>{([{ id: 'report', title: '结果概览' }, { id: 'results', title: '逐例结果' }, { id: 'files', title: '产物文件' }, { id: 'datasets', title: '决策样本' }] as const).map(item => <button type="button" key={item.id} role="tab" id={`evaluation-run-tab-${item.id}`} aria-selected={runTab === item.id} aria-controls={`evaluation-run-panel-${item.id}`} tabIndex={runTab === item.id ? 0 : -1} onClick={() => chooseRunTab(item.id)}>{item.title}</button>)}</div>
        {visibleRunDetail && <RunReviewAssessment view={visibleRunDetail} onEvidence={path => void openFile(path)} />}
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
          <div className="harness-eval-actions harness-eval-secondary-actions"><button type="button" disabled={!onAssistant || extractBusy || !sealed || !visibleRunDetail?.manifest?.experiment_id} onClick={() => void extractDecisionSamples()}>{extractBusy ? '正在打开 AI…' : '请 AI 抽取决策样本'}</button></div>
{reportError && <p role="alert">报告读取失败：{reportError}。{report?.present ? '以下为上次读取内容，可能已过期。' : '可查看逐例结果。'}</p>}{report?.present ? <div className="harness-eval-report"><MarkdownDelegateProvider openFile={path => void openFile(path)}><MarkdownText text={report.content} labels={markdownLabels} /></MarkdownDelegateProvider></div> : !runLoading && !reportError && <Empty>{sealed ? '此历史 Run 未保存 report.md。可查看逐例结果并下载已保存的证据。' : '评测尚未封存，报告将在运行结束后生成。可先查看逐例结果与任务日志。'}</Empty>}</div>
        <div role="tabpanel" id="evaluation-run-panel-results" aria-labelledby="evaluation-run-tab-results" hidden={runTab !== 'results'}>{runDetail?.cases?.length ? <><div className="harness-eval-result-workspace"><nav className="harness-eval-result-cases" aria-label="Run 结果用例">{runDetail.cases.map((item: any) => <button key={item.case_id} type="button" aria-current={resultCaseId === item.case_id ? 'true' : undefined} onClick={() => { setResultCaseId(item.case_id); onNavigate?.(location({ case_id: item.case_id })) }}><span className="harness-eval-badge" data-state={caseObservation(item).value}>{observationLabel(caseObservation(item).value)}</span><strong>{item.frozen?.title || item.case_id}</strong><small>{item.case_id}</small></button>)}</nav><article>{selectedResult && <><button disabled={!runDetail?.manifest?.experiment_id} onClick={() => setNewCase({ agent: runDetail.manifest.agent_id, experiment: runDetail.manifest.experiment_id, source: { run_id: runId, case_id: selectedResult.case_id } })}>从此 Run 创建用例草稿</button><RunCase separated={separatedReview(visibleRunDetail?.source?.review_contract)} item={selectedResult} active={active && tab === 'runs' && runTab === 'results'} identity={runId} onEvidence={path => void openFile(path)} /></>}</article></div></> : <Empty>此 Run 尚无逐例记录。</Empty>}</div>
        <div role="tabpanel" id="evaluation-run-panel-datasets" aria-labelledby="evaluation-run-tab-datasets" hidden={runTab !== 'datasets'}><DecisionDatasetView key={datasetEpoch} rpc={rpc} runId={runId} active={active && tab === 'runs' && runTab === 'datasets'} updates={updates} onDirty={setDatasetDirty} onBusy={setDatasetBusy} onSource={source => { setDatasetSource(source); setFileSearch(''); void openFile(source.path) }} onReextract={onAssistant && sealed ? () => void extractDecisionSamples() : undefined}/></div>
        <div role="tabpanel" id="evaluation-run-panel-files" aria-labelledby="evaluation-run-tab-files" hidden={runTab !== 'files'}>{filesError && <p role="alert">{filesError}</p>}<p className="harness-eval-note">文件清单来自实际保存的 Run 目录。原文预览最多显示前 64 KiB；下载保留完整内容并脱敏。</p>{runFiles?.coverage && <Raw value={runFiles.coverage} title="导出覆盖与采集限制" active={active && tab === 'runs' && runTab === 'files'} identity={runId} />}<input aria-label="筛选产物文件" placeholder="搜索路径、Case 或文件名" value={fileSearch} onChange={event => setFileSearch(event.target.value)} /><div className="harness-eval-files-layout"><div className="harness-eval-file-list" aria-label="产物文件列表">{(runFiles?.files ?? []).filter((file: RunFile) => file.path.toLowerCase().includes(fileSearch.toLowerCase())).map((file: RunFile) => <button type="button" key={file.path} aria-pressed={filePath === file.path} onClick={() => void openFile(file.path)}><span>{runDetail?.run_path ? file.path.replace(`${runDetail.run_path}/`, '') : file.path}</span><small>{file.size.toLocaleString()} 字节 · {file.kind === 'text' ? '文本' : '二进制'}</small></button>)}</div><article className="harness-eval-file-preview">{fileError && <p role="alert">{fileError}</p>}{filePath ? <><div className="harness-eval-section-heading"><strong>{runDetail?.run_path ? filePath.replace(`${runDetail.run_path}/`, '') : filePath}</strong><a className="harness-eval-download" href={download('file', filePath)} download>下载完整文件</a></div>{isTraceFile(filePath) && <div className="harness-eval-actions" role="group" aria-label="文件查看方式"><button type="button" aria-pressed={fileView === 'structured'} onClick={() => setFileView('structured')}>结构化查看</button><button type="button" aria-pressed={fileView === 'raw'} onClick={() => setFileView('raw')}>原文</button></div>}{isTraceFile(filePath) && fileView === 'structured' && runTab === 'files' ? <RunTraceView send={call} active={active && tab === 'runs' && runTab === 'files'} runId={runId} path={filePath} focus={datasetSource && (filePath === datasetSource.path || filePath.endsWith('/' + datasetSource.path)) ? { ...datasetSource, path: filePath } : undefined} onEvidence={() => setFileView('raw')}/> : selectedFile?.kind === 'binary' ? <p>二进制文件请下载查看。</p> : filePreview ? <>{filePreview.truncated && <p role="status">仅预览前 64 KiB。下载完整文件不受预览限制。</p>}<pre>{filePreview.content || '空文件'}</pre></> : !fileError && <LoadingIndicator label="读取文件" block />}</> : <Empty>选择文件查看轨迹、工具事件、检查或归因证据。</Empty>}</article></div></div>
      </>}</section>
    </section>
    <section role="tabpanel" id="evaluation-panel-compare" aria-labelledby="evaluation-tab-compare" hidden={tab !== 'compare'}>
      <section className="harness-card"><div className="harness-eval-section-heading"><h2>两次 Run 对照</h2><span className="harness-eval-muted">同一智能体 · 已封存 Run</span></div><div className="harness-eval-compare-controls"><label>左侧 Run<SearchSelect label="左侧 Run" value={leftRun} placeholder="选择基准评测" onChange={value => { compareRequest.current++; setLeftRun(value); setRightRun(''); setComparison(null); setCompareBusy(false) }} options={compareRunsOptions.map(run => ({ value: run.run_id, label: `${agentName(run.agent_id)} · ${versionName(run.experiment_id)} · ${time(run.finished_at || run.created_at)}`, description: run.run_id }))} /></label><label>右侧 Run<SearchSelect label="右侧 Run" value={rightRun} disabled={!leftRun} placeholder="选择对照评测" onChange={value => { compareRequest.current++; setRightRun(value); setComparison(null); setCompareBusy(false) }} options={compareRunsOptions.filter(run => run.agent_id === leftAgent && run.run_id !== leftRun).map(run => ({ value: run.run_id, label: `${versionName(run.experiment_id)} · ${time(run.finished_at || run.created_at)}`, description: run.run_id }))} /></label><button type="button" className="harness-primary" disabled={!leftRun || !rightRun || compareBusy} onClick={() => void compareRuns()}>{compareBusy ? '比较中…' : '开始比较'}</button></div><p className="harness-eval-note">观察性对照需结合输入、模型、执行器与环境判断；记录差异不能单独证明 Harness 导致效果变化。</p>{compareError && <p role="alert">{compareError}</p>}{comparison && <><div className="harness-eval-compare-conclusion" data-state={comparison.causal_comparable ? 'passed' : 'inconclusive'}><strong>{comparison.comparable ? '有共同用例可观察对照' : '缺少共同用例结果'}</strong><p>共同用例 {comparison.cases?.length ?? 0} 个；记录有差异 {(comparison.cases ?? []).filter((item: any) => item.observed_change === '记录有差异').length} 个。{comparison.causal_comparable ? '已记录的比较条件一致，仍需结合实验设计判断效果。' : '来源或口径存在差异或缺失，不能将观察差异归因为 Harness 改进。'}</p></div><div className="harness-eval-compare-grid harness-eval-compare-summary-grid">{[['左侧', comparison.left_view], ['右侧', comparison.right_view]].map(([name, value]) => <article key={name as string} className="harness-eval-comparison-summary"><h3>{name as string} · {agentName((value as any).manifest.agent_id)} · {versionName((value as any).manifest.experiment_id)}</h3><small className="harness-eval-run-id">Run {(value as any).run_id}</small><Facts items={[["版本", (value as any).manifest.experiment_id], ["状态", label((value as any).manifest.status)], ["业务效果", verdictLabel(verdictIfCompleted((value as any).manifest.status, summaryVerdict((value as any).summary)))], ["执行器", (value as any).source.executor], ["预期模型", (value as any).source.model], ["Git", (value as any).source.git_version?.commit], ["工作树含未提交改动", (value as any).source.git_version?.dirty]]} /><RunReviewAssessment view={value} onEvidence={path => { returnToComparison.current = true; pendingEvidence.current = { run: (value as any).run_id, path }; chooseRun((value as any).run_id, 'runs'); if (runId === (value as any).run_id) { pendingEvidence.current = null; void openFile(path) } }} /></article>)}</div><p>仅左侧用例：{comparison.left_only?.join('、') || '无'}；仅右侧用例：{comparison.right_only?.join('、') || '无'}。</p>{comparison.limits?.length > 0 && <div className="harness-eval-limits"><strong>对照限制</strong><ul>{comparison.limits.map((value: string) => <li key={value}>{value}</li>)}</ul></div>}<label className="harness-eval-field">共同 Case<SearchSelect label="对照用例" value={compareCaseId} onChange={setCompareCaseId} options={(comparison.cases ?? []).map((item: any) => ({ value: item.case_id, label: item.case_id, description: item.observed_change }))} /></label>{selectedComparison ? <><p><strong>{selectedComparison.observed_change}</strong> · 冻结用例口径{selectedComparison.frozen_contract_same ? '相同' : '不同'}</p><div className="harness-eval-compare-grid harness-eval-case-compare-grid">{[comparison.left_view, comparison.right_view].map((value: any) => { const item = value.cases.find((entry: any) => entry.case_id === compareCaseId); return <article key={value.run_id} className="harness-eval-comparison-side" style={{ '--harness-case-rows': 13 + pairedCaseRows.inputs + pairedCaseRows.outputs + pairedCaseRows.trials } as CSSProperties}><h3>{agentName(value.manifest.agent_id)} · {versionName(value.manifest.experiment_id)}</h3><small className="harness-eval-run-id">Run {value.run_id}</small>{item && <RunCase separated={separatedReview(value.source?.review_contract)} item={item} paired={pairedCaseRows} active={active && tab === 'compare'} identity={value.run_id} onEvidence={path => { returnToComparison.current = true; pendingEvidence.current = { run: value.run_id, path }; chooseRun(value.run_id, 'runs'); if (runId === value.run_id) { pendingEvidence.current = null; void openFile(path) } }} />}</article> })}</div></> : <Empty>这两次 Run 没有可对照的共同 Case。</Empty>}<DetailDrawer title="比较条件与技术来源" active={active && tab === 'compare'} identity={`${leftRun}:${rightRun}`}><RunComparisonFacts comparison={comparison} onNavigate={onNavigate}/><h3>完整对照记录与来源条件</h3><pre>{json(comparison)}</pre></DetailDrawer></>}</section>
    </section>
    {newCase && <CaseCreationDialog rpc={rpc} active={active} onDirty={setNewCaseDirty} onBusy={setNewCaseBusy} agentId={newCase.agent} experimentId={newCase.experiment} sourceRun={newCase.source} onClose={() => setNewCase(null)} onSaved={document => {
      resetScope(newCase.agent, newCase.experiment); setTab('cases'); setCaseId(document.case.id); setCaseDocument(document); setCaseDraft(draftFor(document)); setCaseMessage('已新增用例，后续评测立即使用；历史 Run 冻结口径保持。')
      onNavigate?.({ page: 'evaluation', tab: 'cases', agent_id: newCase.agent, experiment_id: newCase.experiment, case_id: document.case.id })
      updates?.invalidate(['agents', 'catalog'])
    }}/>}
    <dialog ref={configDialog} className="harness-eval-drawer" aria-labelledby="evaluation-config-title" onCancel={event => { if (evalBusy) event.preventDefault(); else { setConfigOpen(false); releasePreview() } }}><div className="harness-eval-section-heading"><h2 id="evaluation-config-title">{evalPending ? `核对评测 ${agentName(evalPending.agentId)} ${versionName(evalPending.experimentId)}` : agentId && experimentId ? `评测 ${agentName(agentId)} ${versionName(experimentId)}` : '新建评测'}</h2><button type="button" disabled={evalBusy} onClick={() => { setConfigOpen(false); releasePreview() }}>关闭</button></div><div className="harness-eval-dialog-body"><p className="harness-eval-muted">选择版本、验证目标和用例范围，再启动独立 Run。</p>{evalPending && <p role="status">{evalPending.run_id ? `Run ID：${evalPending.run_id}` : '旧评测受理状态待核对'} · {evalBusy ? '正在准备运行记录' : '受理结果待核对'}</p>}<div className="harness-eval-editor"><label>智能体<SearchSelect label="新建评测智能体" disabled={evalBusy || !!evalPending} value={agentId} onChange={value => { changeScope(value); setConfigOpen(true) }} options={agents.map(agent => ({ value: agent.id, label: agentName(agent.id), description: agent.id }))} /></label><label>版本<SearchSelect label="新建评测版本" disabled={!agentId || detailLoading || evalBusy || !!evalPending} value={experimentId} onChange={value => { changeScope(agentId, value); setConfigOpen(true) }} options={sourceVersions.map(id => ({ value: id, label: versionName(id), description: `${objectType(id)} · ${id}` }))} /></label></div><section className="harness-eval-advanced"><h3>验证目标与复核</h3><div className="harness-eval-editor"><label>验证目标<select aria-label="验证目标" value={executor} disabled={evalBusy || !!evalPending} onChange={event => { setExecutor(event.target.value); clearPreview() }}><option value="api">业务能力评测</option><option value="browser">界面冒烟</option></select></label><label>证据复核<select aria-label="证据复核" value={executor === 'browser' ? 'none' : review} disabled={evalBusy || !!evalPending || executor === 'browser'} onChange={event => { if (executor === 'browser') return; setReview(event.target.value); clearPreview() }}><option value="none">不请求 AI 复核</option><option value="ai">AI 业务效果与源码评估</option></select></label></div><p className="harness-eval-muted">{executor === 'browser' ? '检查界面能否打开和完成基础交互，不生成业务能力通过结论，也不进行 AI 证据复核。' : '按用例验证业务行为。AI 评估分别审读业务运行证据与冻结源码，源码诊断不改变业务效果结论。'}</p></section><section className="harness-eval-range"><h3>评测范围</h3><div className="harness-eval-scope-choice" role="group" aria-label="评测范围">{([{ id: 'fast', title: '快速评测' }, { id: 'full', title: '全部用例' }, { id: 'selected', title: '自选用例' }] as const).map(item => <button key={item.id} type="button" aria-pressed={caseScope === item.id} disabled={evalBusy || !!evalPending} onClick={() => { setCaseScope(item.id); clearPreview() }}>{item.title}</button>)}</div>{caseScope === 'selected' ? <><input aria-label="搜索待评测用例" placeholder="搜索用例名称或 ID" value={newCaseSearch} onChange={event => setNewCaseSearch(event.target.value)} /><div className="harness-eval-new-case-list">{cases.filter(item => `${item.id} ${item.title}`.toLowerCase().includes(newCaseSearch.trim().toLowerCase())).map(item => <label key={item.id}><input type="checkbox" aria-label={`执行 ${item.id}`} disabled={evalBusy || !!evalPending} checked={selectedCases.includes(item.id)} onChange={event => { setSelectedCases(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); clearPreview() }} /><span><strong>{item.title || item.id}</strong><small>{item.id}</small></span></label>)}</div><p>已选择 {selectedCases.length} 个用例。</p>{!selectedCases.length && <p className="harness-eval-muted">请至少选择一个用例。</p>}</> : <p>{caseScope === 'fast' ? '按已保存的快速评测标记选择用例。' : '评测此智能体的全部已保存用例。'}实际范围以执行预览为准。</p>}<p className="harness-eval-muted">结论只适用于本次用例和执行环境；历史 Run 保留冻结定义。</p></section>{caseDirty && <p role="alert">用例草稿尚未保存，本次评测将使用已保存的定义。</p>}{detailError && <p role="alert">{detailError}</p>}{evalError && <p role="alert">{evalError}</p>}{evalPreview && <section className="harness-eval-preview"><h3>执行预览</h3><Facts items={[["用例数量", evalPreview.case_ids?.length], ["验证目标", evalPreview.executor === 'browser' ? '界面冒烟' : '业务能力评测']]} />{evalPreview.case_ids?.length > 0 && <p>{evalPreview.case_ids.join('、')}</p>}{evalPreview.missing_env_names?.length > 0 && <p role="alert">缺少环境变量：{evalPreview.missing_env_names.join('、')}</p>}<Raw value={evalPreview} title="预览完整配置" inline /></section>}</div><div className="harness-eval-actions harness-eval-dialog-footer">{evalPending && <button type="button" disabled={pendingObservation?.status === 'cancelling'} onClick={() => void cancelPendingEvaluation()}>取消此次评测</button>}<button type="button" disabled={!!evalPending || !experimentId || evalBusy || detailLoading || caseScope === 'selected' && !selectedCases.length} onClick={() => void previewEvaluation()}>执行预览</button><button type="button" className="harness-primary" disabled={evalBusy || !evalPending && (!experimentId || detailLoading || caseScope === 'selected' && !selectedCases.length)} onClick={() => { if (evalPending) void recoverPendingEvaluation(); else void startEvaluation() }}>{evalBusy ? '处理中…' : evalPending ? '核对此次 Run' : '启动评测'}</button></div></dialog>
    <dialog ref={deleteDialog} className="harness-eval-confirm-dialog" aria-labelledby="evaluation-delete-title" aria-busy={deleteBusy} onCancel={event => { if (deleteLock.current) event.preventDefault(); else setDeleteTarget(null) }}><div className="harness-eval-section-heading"><h2 id="evaluation-delete-title">{deleteTarget?.kind === 'case' ? '删除测试用例？' : `删除 ${deleteTarget?.runs.length ?? 0} 条评测记录？`}</h2><button type="button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>关闭</button></div><div className="harness-eval-dialog-body">{deleteTarget?.kind === 'case' ? <><p>将删除 <strong>{agentName(deleteTarget.agentId)}</strong> 的测试用例「{deleteTarget.document.case.title}」（{deleteTarget.document.case.id}）。该智能体各版本共用当前用例集，后续评测不再使用此用例。</p><p>历史评测冻结的用例和结果保留。此操作无法撤销。</p></> : <><p>将永久删除以下评测的结果、报告和证据文件，相关比较与证据引用将无法继续读取。测试用例、被测版本和实例会话保留。此操作无法撤销。</p><ul>{deleteTarget?.runs.map(run => <li key={run.run_id}><strong>{runName(run)}</strong> · {agentName(run.agent_id)} · {versionName(run.experiment_id)}<br /><code>{run.run_id}</code></li>)}</ul></>}{deleteNotice && <p role="status">{deleteNotice}</p>}{deleteError && <p role="alert">{deleteError}</p>}</div><div className="harness-eval-actions harness-eval-dialog-footer"><button type="button" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>取消</button><button type="button" className="harness-eval-delete" disabled={!deleteTarget || deleteBusy} onClick={() => void confirmDelete()}>{deleteBusy ? '删除中…' : deleteError ? '重试删除' : '确认删除'}</button></div></dialog>
    <dialog ref={cancelDialog} className="harness-eval-confirm-dialog" aria-labelledby="evaluation-cancel-title" onCancel={() => setCancelJobId('')}><div className="harness-eval-section-heading"><h2 id="evaluation-cancel-title">取消当前评测？</h2><button type="button" onClick={() => setCancelJobId('')}>关闭</button></div><div className="harness-eval-dialog-body"><p>目标评测：<strong>{agentName(job?.agent_id)} {job?.experiment_id ? versionName(job.experiment_id) : '版本待读取'}</strong></p><p>当前状态：{job?.status === 'running' ? `运行中${elapsed(job.started_at) ? ` · ${elapsed(job.started_at)}` : ''}` : executionLabel(job?.status)}</p><p>取消会请求结束这项独立评测任务。已保存的历史 Run 和用例不会因此删除；取消完成前，最终执行状态与业务结论仍需重新查询。</p><p className="harness-eval-muted">{job?.run_id ? 'Run ID：' : '旧评测标识：'}<code>{cancelJobId}</code></p></div><div className="harness-eval-actions harness-eval-dialog-footer"><button type="button" onClick={() => setCancelJobId('')}>继续评测</button><button type="button" className="harness-primary" disabled={!cancelJobId || executionKey(job) !== cancelJobId || !['running', 'preparing', 'unknown'].includes(job?.status ?? '') || !!jobError} onClick={() => { const confirmedJobId = cancelJobId; setCancelJobId(''); void cancelEvaluation(confirmedJobId) }}>确认取消</button></div></dialog>
  </main>
}
