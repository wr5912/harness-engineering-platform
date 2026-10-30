import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { validateDecisionQuestions, validateDecisionTargets, validateDecisionTask, isDecisionTargetReviewed } from './decision-dataset-contract.ts'

type QuestionDraft = { originalName: string; name: string; type: string; instructions: string; criteria: string; label: string; probabilities: string; provenance: string; basis: string; status: string; decisionTimeReviewed: boolean; reviewCleared?: boolean; originalQuestion: any; originalTarget: any }
type Draft = { workflow: string; taskId: string; semantics: string; questions: QuestionDraft[]; group: string; split: string }
const json = (value: unknown) => value === undefined ? '' : JSON.stringify(value, null, 2)
function recordReadIssue(record: any) {
  try { const questions = validateDecisionQuestions(record.questions); validateDecisionTargets(questions, record.targets); validateDecisionTask(record.task); return '' }
  catch (error) { return (error as Error).message }
}
function draftOf(record: any): Draft | null {
  if (recordReadIssue(record)) return null
  return {
    workflow: record.workflow ?? '', taskId: record.task.id, semantics: record.task.semantics,
    questions: Object.entries(record.questions).map(([name, question]: [string, any]) => {
      const target = record.targets[name]
      return { originalName: name, name, type: question.type, instructions: question.instructions, criteria: json(question.criteria), label: json(target.label), probabilities: json(target.probabilities), provenance: json(target.provenance), basis: target.basis, status: target.status, decisionTimeReviewed: target.decision_time_reviewed === true, originalQuestion: question, originalTarget: target }
    }), group: record._meta?.group_id ?? '', split: record._meta?.split ?? 'unassigned',
  }
}
const status: Record<string, string> = { suggested: '待复核', reviewed: '已复核', rejected: '已排除' }
const provenanceLabels: Record<string, string> = { model_suggestion: '模型建议（未经校准）', human_annotation: '人工标注', ai_annotation: 'AI 标注（功能验证）', observed_action: '实际动作记录' }
const pendingReviewInput = (question: QuestionDraft) => !question.reviewCleared && question.originalTarget.review?.kind === 'ai_delegated' && !question.originalTarget.review.input_evidence
const aiReviewed = (question: QuestionDraft) => !question.reviewCleared && question.originalTarget.review?.kind === 'ai_delegated'
const purposes = [['unassigned', '未分配'], ['train', '训练'], ['development', '开发'], ['calibration', '校准'], ['test', '测试']]
const downloads = [['candidates', '候选'], ['training', '已复核训练'], ['development', '已复核开发'], ['calibration', '已复核校准'], ['test', '已复核测试']]
const time = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString()
const recordSummary = (record: any) => Object.values(record.questions ?? {}).map((question: any) => question?.instructions).filter(Boolean).join('；') || '未记录问题'
const reviewSummary = (record: any) => record.targets ? `${Object.values(record.targets).filter((target: any) => isDecisionTargetReviewed(target)).length} / ${Object.keys(record.questions ?? {}).length} 题已复核` : status[record._meta?.label_status] ?? '旧格式'
const roleNames: Record<string, string> = { system: '系统约定', user: '用户请求', assistant: '助手记录', tool: '工具结果' }
function messageName(message: any) {
  const kind = message.source?.kind
  if (kind === 'subagent') return '父智能体委派'
  if (kind === 'context' || kind === 'runtime-context') return '运行上下文'
  if (kind === 'skill-catalog') return '技能目录'
  if (kind === 'instructions') return '加载的指令'
  if (message.role === 'user' && kind !== 'user') return kind ? `注入消息（${kind}）` : '用户角色消息（来源未记录）'
  return roleNames[message.role] ?? message.role ?? '消息'
}
function messageText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text ?? '').filter(Boolean).join('\n')
  return ''
}
function answerOptions(question: QuestionDraft) {
  try {
    const criteria = question.criteria.trim() ? JSON.parse(question.criteria) : {}
    if (question.type === 'noul') return [{ value: 'false', label: criteria.false ?? '否' }, { value: 'true', label: criteria.true ?? '是' }]
    if (question.type === 'score' && Array.isArray(criteria)) return criteria.map((label, index) => ({ value: String(index), label }))
    if (question.type === 'choice' && criteria && typeof criteria === 'object' && !Array.isArray(criteria)) return Object.entries(criteria).map(([value, label]) => ({ value, label: String(label) }))
  } catch { /* 高级编辑中的无效 JSON 由保存校验提示；保留原草稿。 */ }
  return []
}
function answerValue(question: QuestionDraft) {
  try { return String(JSON.parse(question.label)) } catch { return '' }
}

export function DecisionDatasetView({ rpc, runId, active, updates, onDirty, onBusy, onSource, onReextract }: PlatformPageProps & { runId: string; active: boolean; updates?: PlatformUpdates; onDirty?(dirty: boolean): void; onBusy?(busy: boolean): void; onSource?(source: { path: string; line: number; source_sha256?: string }): void; onReextract?(): void }) {
  const [list, setList] = useState<any[]>([]), [id, setId] = useState(''), [document, setDocument] = useState<any>(null), [recordId, setRecordId] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [listPhase, setListPhase] = useState<'loading' | 'ready' | 'error'>('loading'), [listError, setListError] = useState('')
  const generation = useRef(0), refreshSequence = useRef(0), current = useRef({ runId, id, recordId, dirty: false, busy: false, sha256: '' })
  const invalidField = useRef('')
  const record = document?.dataset?.records?.find((entry: any) => entry._meta.id === recordId)
  const legacy = document?.dataset?.schema_version !== 2
  const readIssue = record && !legacy ? recordReadIssue(record) : ''
  const dirty = !legacy && !!record && !!draft && JSON.stringify(draft) !== JSON.stringify(draftOf(record))
  const eligibility = document?.eligibility
  const recordEligibility = eligibility?.records?.find((entry: any) => entry.record_id === recordId)
  current.current = { runId, id, recordId, dirty, busy, sha256: document?.sha256 ?? '' }
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty])
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false) }, [busy])
  useEffect(() => {
    if (!error) return
    const field = window.document.getElementById?.(invalidField.current || `harness-dataset-save-error-${recordId}`)
    if (!field) return
    const advanced = field.closest('details')
    if (advanced) advanced.open = true
    field.focus({ preventScroll: true }); field.scrollIntoView({ block: 'center' })
  }, [error])
  async function call(action: string, input: Record<string, unknown>) {
    const result = await rpc.call(CHANNEL, `agents/datasets/${action}`, input) as any
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  async function refresh() {
    const target = current.current.runId
    const refreshId = ++refreshSequence.current
    const request = generation.current, selectedId = current.current.id
    setListPhase('loading'); setListError('')
    let listRead = false
    try {
      const value = await call('list', { run_id: target, include_eligibility: false })
      if (current.current.runId !== target || request !== generation.current || refreshId !== refreshSequence.current) return
      setList(value.datasets); setListPhase('ready'); listRead = true
      if (selectedId && !current.current.busy) {
        const latest = await call('read', { dataset_id: selectedId })
        if (current.current.runId !== target || request !== generation.current || refreshId !== refreshSequence.current || current.current.id !== selectedId || current.current.busy) return
        if (current.current.dirty) { if (latest.sha256 !== current.current.sha256) setError('样本已在其他窗口修改；当前草稿保留。请核对后重新读取本批次。'); return }
        const selected = latest.dataset.records.find((entry: any) => entry._meta.id === current.current.recordId) ?? latest.dataset.records[0]
        setDocument(latest); setRecordId(selected?._meta.id ?? ''); setDraft(selected ? draftOf(selected) : null); setError('')
      }
    }
    catch (e) { if (current.current.runId === target && request === generation.current && refreshId === refreshSequence.current) {
      if (listRead) setError((e as Error).message)
      else { setListPhase('error'); setListError((e as Error).message) }
    } }
  }
  useEffect(() => { generation.current++; setId(''); setDocument(null); setRecordId(''); setDraft(null); setList([]); setListPhase('loading'); setListError(''); setError(''); setMessage(''); return () => { generation.current++ } }, [runId])
  useEffect(() => { if (active && runId) void refresh() }, [active, runId])
  useEffect(() => updates?.subscribe(() => { if (active && updates.getSnapshot().domains.includes('agents')) void refresh() }), [updates, active, runId])
  async function open(next: string) {
    if (busy || dirty && !window.confirm('样本有未保存的修改，丢弃后切换？')) return
    const request = ++generation.current
    setId(next); setDocument(null); setDraft(null); setError(''); setMessage('')
    if (!next) return
    try { const value = await call('read', { dataset_id: next }); if (request !== generation.current) return; setDocument(value); const first = value.dataset.records[0]; setRecordId(first?._meta.id ?? ''); setDraft(first ? draftOf(first) : null) }
    catch (e) { if (request === generation.current) setError((e as Error).message) }
  }
  function changeQuestion(index: number, patch: Partial<QuestionDraft>, reset = true) {
    if (!draft) return
    setDraft({ ...draft, questions: draft.questions.map((question, at) => at === index ? { ...question, ...patch, ...(reset ? { status: 'suggested', decisionTimeReviewed: false, ...(question.originalTarget.review ? { reviewCleared: true } : {}) } : {}) } : question) })
  }
  function changeTask(patch: Partial<Draft>) {
    if (!draft) return
    setDraft({ ...draft, ...patch, questions: draft.questions.map(question => ({ ...question, status: 'suggested', decisionTimeReviewed: false, ...(question.originalTarget.review ? { reviewCleared: true } : {}) })) })
  }
  function contentChanged(question: QuestionDraft) {
    return !!draft && (draft.workflow !== record.workflow || draft.taskId !== record.task?.id || draft.semantics !== record.task?.semantics || question.name !== question.originalName || question.type !== question.originalQuestion.type || question.instructions !== question.originalQuestion.instructions || question.criteria !== json(question.originalQuestion.criteria) || question.label !== json(question.originalTarget.label) || question.probabilities !== json(question.originalTarget.probabilities) || question.basis !== (question.originalTarget.basis ?? ''))
  }
  function selectRecord(next: string) {
    if (busy || dirty && !window.confirm('丢弃本条未保存修改并切换？')) return
    const entry = document?.dataset.records.find((item: any) => item._meta.id === next)
    if (!entry) return
    setRecordId(next); setDraft(draftOf(entry)); setError(''); setMessage('')
  }
  async function save(nextRecordId?: string) {
    if (!draft || !record || busy || legacy) return
    setError(''); setBusy(true); setMessage(''); invalidField.current = ''
    const request = ++generation.current
    try {
      const questions: Record<string, any> = Object.create(null), targets: Record<string, any> = Object.create(null)
      for (const [index, question] of draft.questions.entries()) {
        if (Object.hasOwn(questions, question.name)) throw new Error('决策题名称不能重复')
        const parse = (text: string, field: string, name: string) => {
          try { return JSON.parse(text) }
          catch { invalidField.current = `harness-dataset-${recordId}-${index}-${field}`; throw new Error(`第 ${index + 1} 题的${name}不是有效 JSON，请检查格式`) }
        }
        const { criteria: _criteria, ...original } = question.originalQuestion
        questions[question.name] = { ...original, type: question.type, instructions: question.instructions, ...(question.criteria.trim() ? { criteria: parse(question.criteria, 'criteria', '候选或等级规则') } : {}) }
        const { probabilities: _probabilities, ...target } = question.originalTarget
        targets[question.name] = { ...target, label: parse(question.label, 'label', '标签'), ...(question.probabilities.trim() ? { probabilities: parse(question.probabilities, 'probabilities', '标签概率') } : {}), provenance: JSON.parse(question.provenance), basis: question.basis, status: question.status, decision_time_reviewed: question.decisionTimeReviewed, ...(question.reviewCleared ? { review: null } : {}) }
      }
      const checkedQuestions = validateDecisionQuestions(questions), checkedTargets = validateDecisionTargets(checkedQuestions, targets), task = validateDecisionTask({ ...record.task, id: draft.taskId, semantics: draft.semantics })
      const saveTargets = Object.fromEntries(Object.entries(checkedTargets).map(([name, target]) => [name, { ...target, ...(targets[name].review === null ? { review: null } : {}) }]))
      const value = await call('update', { dataset_id: id, expected_sha256: document.sha256, record_id: recordId, workflow: draft.workflow, task, questions: checkedQuestions, targets: saveTargets, group_id: draft.group, split: draft.split })
      if (request !== generation.current) return
      const selected = value.dataset.records.find((entry: any) => entry._meta.id === (nextRecordId ?? recordId))
      setDocument(value); setRecordId(selected._meta.id); setDraft(draftOf(selected)); setMessage('本条已保存。复核状态和各用途可导出数量以保存后的检查结果为准。'); void refresh()
    } catch (e) { if (request === generation.current) setError(`${(e as Error).message}；草稿已保留。`) }
    finally { setBusy(false) }
  }
  async function download(kind: string) {
    setError('')
    const request = generation.current
    try {
      const value = await call('export', { dataset_id: id, kind })
      if (request !== generation.current) return
      const url = URL.createObjectURL(new Blob([value.content], { type: 'application/x-ndjson;charset=utf-8' }))
      const link = window.document.createElement('a'); link.href = url; link.download = value.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(`已下载 ${value.count} 条${downloads.find(([mode]) => mode === kind)?.[1] ?? ''}样本${value.question_count === undefined ? '' : `，含 ${value.question_count} 题`}${value.omitted_question_count ? `；${value.omitted_question_count} 题不满足该用途，未导出` : ''}。`)
    } catch (e) { if (request === generation.current) setError((e as Error).message) }
  }
  const recordIndex = document?.dataset.records.findIndex((entry: any) => entry._meta.id === recordId) ?? -1
  const nextRecord = document?.dataset.records[recordIndex + 1]
  const messages = Array.isArray(record?.state?.messages) ? record.state.messages : typeof record?.state?.request === 'string' ? [{ role: 'user', content: record.state.request }] : []
  const explicitRequest = messages.findLastIndex((entry: any) => entry.role === 'user' && ['user', 'subagent'].includes(entry.source?.kind))
  const legacyRequest = messages.findLastIndex((entry: any) => entry.role === 'user' && !entry.source?.kind)
  const primaryMessage = explicitRequest >= 0 ? explicitRequest : legacyRequest >= 0 ? legacyRequest : messages.findLastIndex((entry: any) => messageText(entry.content).trim())
  const renderMessage = (entry: any, index: number, open = false) => <details key={`${recordId}:${index}`} className="harness-dataset-message" open={open}><summary><span>{messageName(entry)}</span>{!open && <small>第 {index + 1} 条{entry.name ? ` · ${entry.name}` : ''}</small>}</summary><div className="harness-dataset-message-content">{messageText(entry.content) || '本条含结构化内容，请展开原始输入核对。'}</div>{entry.tool_calls?.length > 0 && <p className="harness-eval-muted">包含 {entry.tool_calls.length} 个工具请求；参数见原始输入。</p>}</details>
  return <section className="harness-eval-dataset" aria-label="决策样本工作区">
    <div className="harness-dataset-toolbar">
      <label className="harness-eval-field harness-dataset-picker">样本批次<select aria-label="样本批次" value={id} disabled={busy} onChange={event => void open(event.target.value)}><option value="">选择已保存的批次</option>{list.map(item => <option key={item.id} value={item.id}>{time(item.created_at)} · {item.count} 条 · 有已复核题 {item.reviewed}</option>)}</select></label>
      <div className="harness-dataset-toolbar-actions"><button onClick={() => void refresh()}>刷新样本</button>{document && <DetailDrawer title="批次操作与导出" trigger="批次操作" active={active} identity={`${runId}:${id}:batch`}>
        <div className="harness-eval-actions"><button disabled={busy} onClick={() => void open(id)}>重新读取本批次</button>{downloads.map(([kind, title]) => <button key={kind} disabled={busy || !eligibility?.counts?.[kind]} onClick={() => void download(kind)}>下载{title} JSONL{eligibility?.counts?.[kind] === undefined ? '' : `（${eligibility.counts[kind]}）`}</button>)}</div>
        <p className="harness-eval-note">下载仅包含已保存且符合该用途的题目。未分配用途不进入训练；来源组与关联组共同约束训练、开发、校准和测试隔离。复核记录保留实际方式，AI 委托复核仅用于功能验证。</p>
        {eligibility?.blocked?.length > 0 && <div className="harness-eval-limits"><strong>批次中 {eligibility.blocked.length} 条样本存在导出限制</strong><ul>{eligibility.blocked.map((item: any) => <li key={item.record_id}>{item.record_id}：{item.reasons.join('；')}</li>)}</ul></div>}
        <details><summary>抽取来源与跳过原因</summary><pre>{json({ extractor: document.dataset.extractor, path: document.dataset.path, source_sha256: document.dataset.source_sha256, skipped: document.dataset.skipped })}</pre></details>
      </DetailDrawer>}</div>
    </div>
    {listPhase === 'loading' && <p role="status">正在读取样本批次…</p>}{listError && <p role="alert">样本批次读取失败：{listError}。请重新读取。{list.length > 0 && '当前显示上次读取的批次。'}</p>}
    {error && (!document || !draft || readIssue) && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {listPhase === 'ready' && !list.length && <p className="harness-eval-empty">此 Run 尚无样本。点击上方“请 AI 抽取决策样本”，平台会自动保存候选并回读；训练前仍需逐题复核。</p>}
    {id && !document && !error && <p role="status">正在读取本批次样本…</p>}
    {document && <>
      {legacy && <div className="harness-eval-limits" role="status"><strong>旧格式样本，仅供阅读和候选下载。</strong><p>原有标签和复核记录保持原样；需要按当前决策合同重新抽取，不能直接作为新版合格训练或评测样本。</p>{onReextract && <button disabled={busy} onClick={onReextract}>按当前合同重新抽取</button>}</div>}
      {document.warnings?.length > 0 && <div className="harness-eval-limits"><strong>批次检查提示</strong><ul>{document.warnings.map((warning: string) => <li key={warning}>{warning}</li>)}</ul></div>}
      <div className="harness-eval-files-layout harness-dataset-workbench" data-single-record={document.dataset.records.length === 1}>
        <nav className="harness-eval-file-list harness-dataset-records" aria-label="决策样本列表"><span className="harness-dataset-list-title">本批样本</span>{document.dataset.records.map((entry: any, index: number) => <button key={entry._meta.id} disabled={busy} aria-pressed={recordId === entry._meta.id} onClick={() => selectRecord(entry._meta.id)}><span>{index + 1}. {entry.workflow || '业务决策'}</span><span className="harness-dataset-list-question">{recordSummary(entry)}</span><small>{reviewSummary(entry)}</small></button>)}</nav>
        {record && <article className="harness-eval-file-preview harness-dataset-detail" aria-label="当前决策样本">
          <header className="harness-dataset-record-heading"><h3>{record.workflow || '业务决策'}{document.dataset.records.length > 1 && <small>样本 {recordIndex + 1}/{document.dataset.records.length}</small>}</h3><div className="harness-dataset-state"><span>{reviewSummary(record)}</span>{(busy || dirty) && <span role="status" className="harness-dataset-unsaved">{busy ? '正在保存…' : '未保存修改'}</span>}</div></header>
          <section className="harness-dataset-section harness-dataset-context-section" aria-labelledby="harness-dataset-context-title">
            <h4 id="harness-dataset-context-title" className="harness-dataset-context-title">当前可见任务材料</h4>
            <div className="harness-dataset-messages" aria-label="决策前输入（各题共享）">{primaryMessage >= 0 ? <>{!['user', 'subagent'].includes(messages[primaryMessage].source?.kind) && messages[primaryMessage].source?.kind && <p className="harness-dataset-source-note">来源未记录用户请求，以下按实际来源展示可核对材料。</p>}{renderMessage(messages[primaryMessage], primaryMessage, true)}</> : <p className="harness-eval-note">未记录可直接阅读的任务正文，请展开来源与完整上下文核对。</p>}</div>
            <details className="harness-dataset-source-details" aria-label="样本决策时点" key={`${recordId}:source`}><summary>来源与完整上下文 <small>{messages.length} 条消息</small></summary>
              <div className="harness-eval-decision-context"><strong>实际观察 · 原始轨迹第 {record._meta.cutoff?.line ?? '未知'} 行</strong><p>{record._meta.context_mode === 'actual_request' ? '已保存的实际模型请求' : record._meta.context_mode === 'reconstructed' ? '由可观察历史重建，可能与实际上下文不同' : '来源模式未记录'}</p>
                <dl className="harness-dataset-source-facts"><div><dt>来源版本</dt><dd>{record._meta.experiment_id ?? document.dataset.experiment_id ?? '历史批次未记录'}</dd></div><div><dt>Run</dt><dd>{record._meta.run_id ?? document.dataset.run_id}</dd></div><div><dt>Session</dt><dd>{record._meta.cutoff?.session_log ?? '未记录'}</dd></div><div><dt>轨迹文件</dt><dd>{record._meta.trace_path ?? '未记录'}</dd></div></dl>{record._meta.source_version?.git_version?.dirty === true && <p>该历史 Run 使用了未提交的 Candidate。</p>}
                <p className="harness-eval-muted">观察到的动作：<code>{record._meta.observed_action?.name ?? '未记录'}</code>。实际动作只供对照，不能直接成为推荐答案。</p>{onSource && record._meta.trace_path && Number.isInteger(record._meta.cutoff?.line) && <button disabled={busy} onClick={() => onSource({ path: record._meta.trace_path, line: record._meta.cutoff.line, ...(record._meta.trace_sha256 ? { source_sha256: record._meta.trace_sha256 } : {}) })}>定位原始轨迹（保留草稿）</button>}
              </div>
              <div className="harness-dataset-history"><p className="harness-eval-muted">其余上下文按原始顺序保留；主材料来自第 {primaryMessage + 1} 条。</p>{messages.map((entry: any, index: number) => index === primaryMessage ? null : renderMessage(entry, index))}</div>
              <DetailDrawer title="完整原始输入与工具目录" active={active} identity={`${runId}:${id}:${recordId}:state`}><pre>{json(record.state)}</pre></DetailDrawer>
            </details>
          </section>

          {readIssue && <p className="harness-eval-limits" role="alert">本条结构损坏，仅供阅读和候选下载：{readIssue}。请核对原始资料后重新抽取；平台不会补造缺失的问题或目标。</p>}
          {legacy || readIssue ? <section><h4>{legacy ? '旧格式问题、标签与复核记录' : '原始问题、目标与复核记录'}</h4><pre>{json({ questions: record.questions, targets: record.targets, review: record._meta })}</pre></section> : draft && <>
            <section className="harness-dataset-section" aria-labelledby="harness-dataset-questions-title">
              <div className="harness-dataset-section-title"><h4 id="harness-dataset-questions-title">逐题复核</h4><p>依据决策前材料核对答案，修改保存后生效。</p></div>
              <details className="harness-dataset-advanced"><summary>调整业务流程与监督目标</summary><div className="harness-eval-form-grid"><label className="harness-eval-field">业务流程<input aria-label="决策业务流程" disabled={busy} value={draft.workflow} onChange={event => changeTask({ workflow: event.target.value })}/></label><label className="harness-eval-field">业务任务<input aria-label="决策业务任务" disabled={busy} value={draft.taskId} onChange={event => changeTask({ taskId: event.target.value })}/></label></div><label className="harness-eval-field">监督目标<select aria-label="决策监督语义" disabled={busy} value={draft.semantics} onChange={event => changeTask({ semantics: event.target.value })}><option value="recommended_decision">基于可见状态的推荐判断</option><option value="observed_action">记录实际观察到的动作</option></select></label><p className="harness-eval-note">{draft.semantics === 'observed_action' ? '标签描述实际发生的行为，不能因此认定该行为正确或最佳。此模式使用候选选择题及与真实动作名一致的硬标签，不填写概率。' : '标签回答在当前可见输入下应该如何判断；实际动作只供对照，不自动成为正确答案。'}</p></details>
              {draft.questions.map((question, index) => <fieldset className="harness-eval-question" id={`harness-decision-${recordId}-${index}`} key={`${recordId}:${index}`}><legend>第 {index + 1} 题 <span className="harness-eval-badge">{pendingReviewInput(question) ? '待补齐输入复核' : status[question.status]}{(contentChanged(question) || question.reviewCleared || question.status !== question.originalTarget.status || question.decisionTimeReviewed !== question.originalTarget.decision_time_reviewed) ? ' · 待保存' : ''}</span></legend>
                <p className="harness-dataset-question-text">{question.instructions || '请填写问题'}</p>
                <ol className="harness-dataset-options" aria-label={`第 ${index + 1} 题候选与规则`}>{answerOptions(question).map(option => <li key={option.value} data-selected={answerValue(question) === option.value}><span>{option.label}</span><code>{option.value}</code></li>)}</ol>
                <label className="harness-eval-field harness-dataset-answer">{draft.semantics === 'observed_action' ? '记录的动作' : '建议答案'}<select aria-label={`第 ${index + 1} 题答案`} disabled={busy} value={answerValue(question)} onChange={event => changeQuestion(index, { label: question.type === 'choice' ? JSON.stringify(event.target.value) : event.target.value })}><option value="" disabled>选择与材料相符的答案</option>{answerOptions(question).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                <label className="harness-eval-field">判断依据<textarea aria-label={`第 ${index + 1} 题标签依据`} rows={3} disabled={busy} value={question.basis} placeholder="说明哪些决策前材料支持这个答案，以及存在的不确定性" onChange={event => changeQuestion(index, { basis: event.target.value })}/></label>
                <div className="harness-dataset-review-origin"><p>标签来源：{provenanceLabels[question.originalTarget.provenance?.kind] ?? '未记录'}</p>{question.originalTarget.review?.kind === 'ai_delegated' && <p>AI 委托复核 · 功能验证 · {question.originalTarget.review.model.provider}/{question.originalTarget.review.model.model} · {time(question.originalTarget.review.reviewed_at)}。该记录不代表人工复核或独立真值。{question.originalTarget.review.input_evidence ? '已核对该会话完整输入的阅读记录。' : '该次记录尚缺完整输入的阅读证据，需重新复核后用于训练。'}{question.reviewCleared && '本次人工操作将在保存后替换此复核记录。'}</p>}<DetailDrawer title={`第 ${index + 1} 题标签来源详情`} trigger="标签来源详情" active={active} identity={`${runId}:${id}:${recordId}:${question.name}`}><pre>{json({ provenance: question.originalTarget.provenance, review: question.originalTarget.review })}</pre></DetailDrawer></div>
                {recordEligibility?.question_reasons?.[question.name]?.length > 0 && <details className="harness-dataset-export-limits" aria-label={`第 ${index + 1} 题导出限制`}><summary>本题导出限制（{recordEligibility.question_reasons[question.name].length}）</summary><ul>{recordEligibility.question_reasons[question.name].map((reason: string) => <li key={reason}>{reason}</li>)}</ul></details>}
                <div className="harness-dataset-review-action"><label className="harness-eval-review-check"><input type="checkbox" aria-label={`已核对第 ${index + 1} 题输入与监督目标`} disabled={busy || contentChanged(question)} checked={!aiReviewed(question) && question.decisionTimeReviewed} onChange={event => changeQuestion(index, { reviewCleared: true, decisionTimeReviewed: event.target.checked, ...(!event.target.checked ? { status: 'suggested' } : {}) }, false)}/>我已核对：材料足以回答本题，候选中的事实来自决策前输入，答案与依据符合监督目标。</label>{contentChanged(question) && <p className="harness-eval-note">本题内容已修改，请先保存修改，再核对并复核本题。</p>}<div className="harness-eval-actions"><button disabled={busy || contentChanged(question) || aiReviewed(question) || !question.decisionTimeReviewed} onClick={() => changeQuestion(index, { status: 'reviewed', reviewCleared: true }, false)}>确认第 {index + 1} 题已复核</button><button disabled={busy || contentChanged(question)} onClick={() => changeQuestion(index, { status: 'rejected', decisionTimeReviewed: false, reviewCleared: true }, false)}>排除第 {index + 1} 题</button>{index + 1 < draft.questions.length && <a href={`#harness-decision-${recordId}-${index + 1}`}>查看下一题</a>}</div></div>
                <details className="harness-dataset-advanced"><summary>编辑题目与高级字段</summary><div className="harness-eval-form-grid"><label className="harness-eval-field">决策题名称<input aria-label={`第 ${index + 1} 题名称`} disabled={busy} value={question.name} onChange={event => changeQuestion(index, { name: event.target.value })}/></label><label className="harness-eval-field">题型<select aria-label={`第 ${index + 1} 题题型`} disabled={busy} value={question.type} onChange={event => changeQuestion(index, { type: event.target.value })}><option value="choice">choice · 候选选择</option><option value="noul">noul · 是非判断</option><option value="score">score · 有序等级</option></select></label></div><label className="harness-eval-field">问题<textarea aria-label={`第 ${index + 1} 题问题`} rows={3} disabled={busy} value={question.instructions} onChange={event => changeQuestion(index, { instructions: event.target.value })}/></label><label className="harness-eval-field">{question.type === 'score' ? '有序等级 JSON（从 0 开始）' : '候选或判断规则 JSON'}<textarea id={`harness-dataset-${recordId}-${index}-criteria`} aria-label={`第 ${index + 1} 题规则 JSON`} rows={4} disabled={busy} value={question.criteria} onChange={event => changeQuestion(index, { criteria: event.target.value })}/></label><label className="harness-eval-field">标签 JSON（choice 用字符串、noul 用布尔值、score 用等级序号）<input id={`harness-dataset-${recordId}-${index}-label`} aria-label={`第 ${index + 1} 题标签 JSON`} disabled={busy} value={question.label} onChange={event => changeQuestion(index, { label: event.target.value })}/></label><label className="harness-eval-field">可选标签概率 JSON<textarea id={`harness-dataset-${recordId}-${index}-probabilities`} aria-label={`第 ${index + 1} 题概率 JSON`} rows={3} disabled={busy} value={question.probabilities} placeholder="没有真实概率证据时留空" onChange={event => changeQuestion(index, { probabilities: event.target.value })}/></label><p className="harness-eval-note">硬标签不自动补成概率。模型建议的概率未经校准，不能当作教师多次采样或人工真值。修改题目、规则、标签、概率或依据后需要重新复核；人工改写的标签来源由平台记录。</p><button disabled={busy || draft.questions.length <= 1} onClick={() => setDraft({ ...draft, questions: draft.questions.filter((_, at) => at !== index) })}>移除第 {index + 1} 题</button></details>
              </fieldset>)}
              <button disabled={busy} onClick={() => setDraft({ ...draft, questions: [...draft.questions, { originalName: '', name: `decision_${draft.questions.length + 1}`, type: 'choice', instructions: '', criteria: '{}', label: '""', probabilities: '', provenance: '{"kind":"human_annotation"}', basis: '', status: 'suggested', decisionTimeReviewed: false, originalQuestion: {}, originalTarget: {} }] })}>添加命名决策题</button>
            </section>
            <section className="harness-dataset-section"><div className="harness-dataset-section-title"><h4>保存与后续用途</h4></div>{recordEligibility?.reasons?.length > 0 && <details className="harness-dataset-export-limits" aria-label="本条导出限制"><summary>本条导出限制（{recordEligibility.reasons.length}）</summary><ul>{recordEligibility.reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul></details>}<details className="harness-dataset-advanced"><summary>数据用途与关联分组 <span>{purposes.find(([value]) => value === draft.split)?.[1] ?? '未分配'}</span></summary><p className="harness-eval-note">固定来源任务组：{record._meta.source_group_id ?? '未记录'}。关联分组只能增加同源联系，不能解除已有隔离。</p><label className="harness-eval-field">关联任务分组<input aria-label="决策任务分组" disabled={busy} value={draft.group} onChange={event => setDraft({ ...draft, group: event.target.value })}/></label><label className="harness-eval-field">数据用途<select aria-label="决策数据用途" disabled={busy} value={draft.split} onChange={event => setDraft({ ...draft, split: event.target.value })}>{purposes.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label></details></section>
            <div className="harness-dataset-savebar">{error && <p id={`harness-dataset-save-error-${recordId}`} tabIndex={-1} className="harness-dataset-save-error" role="alert">{error}</p>}<div className="harness-dataset-savebar-main"><div><strong>{busy ? '正在保存…' : dirty ? '本条有未保存修改' : '暂无待保存修改'}</strong></div><div className="harness-eval-actions"><button className="harness-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '正在保存…' : '保存本条修改与复核'}</button>{nextRecord && <button disabled={busy} onClick={() => dirty ? void save(nextRecord._meta.id) : selectRecord(nextRecord._meta.id)}>{dirty ? '保存并查看下一条' : '查看下一条样本'}</button>}</div></div></div>
          </>}
          <DetailDrawer title="实际动作与证据定位" active={active} identity={`${runId}:${id}:${recordId}`}><pre>{json(record._meta)}</pre></DetailDrawer>
        </article>}
      </div>
    </>}
  </section>
}
