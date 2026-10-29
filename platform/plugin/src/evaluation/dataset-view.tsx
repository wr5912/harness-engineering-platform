import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { validateDecisionQuestions, validateDecisionTargets, validateDecisionTask } from './decision-dataset-contract.ts'

type QuestionDraft = { originalName: string; name: string; type: string; instructions: string; criteria: string; label: string; probabilities: string; provenance: string; basis: string; status: string; decisionTimeReviewed: boolean; originalQuestion: any; originalTarget: any }
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
const provenanceLabels: Record<string, string> = { model_suggestion: '模型建议（未经校准）', human_annotation: '人工标注', observed_action: '实际动作记录' }
const purposes = [['unassigned', '未分配'], ['train', '训练'], ['development', '开发'], ['calibration', '校准'], ['test', '测试']]
const downloads = [['candidates', '候选'], ['training', '已复核训练'], ['development', '已复核开发'], ['calibration', '已复核校准'], ['test', '已复核测试']]
const time = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString()
const recordSummary = (record: any) => Object.values(record.questions ?? {}).map((question: any) => question?.instructions).filter(Boolean).join('；') || '未记录问题'
const reviewSummary = (record: any) => record.targets ? `${Object.values(record.targets).filter((target: any) => target?.status === 'reviewed').length} / ${Object.keys(record.questions ?? {}).length} 题已复核` : status[record._meta?.label_status] ?? '旧格式'

export function DecisionDatasetView({ rpc, runId, active, updates, onDirty, onBusy, onSource, onReextract }: PlatformPageProps & { runId: string; active: boolean; updates?: PlatformUpdates; onDirty?(dirty: boolean): void; onBusy?(busy: boolean): void; onSource?(source: { path: string; line: number; source_sha256?: string }): void; onReextract?(): void }) {
  const [list, setList] = useState<any[]>([]), [id, setId] = useState(''), [document, setDocument] = useState<any>(null), [recordId, setRecordId] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null), [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const generation = useRef(0), refreshSequence = useRef(0), current = useRef({ runId, id, recordId, dirty: false, busy: false, sha256: '' })
  const record = document?.dataset?.records?.find((entry: any) => entry._meta.id === recordId)
  const legacy = document?.dataset?.schema_version !== 2
  const readIssue = record && !legacy ? recordReadIssue(record) : ''
  const dirty = !legacy && !!record && !!draft && JSON.stringify(draft) !== JSON.stringify(draftOf(record))
  const eligibility = document?.eligibility
  const recordEligibility = eligibility?.records?.find((entry: any) => entry.record_id === recordId)
  current.current = { runId, id, recordId, dirty, busy, sha256: document?.sha256 ?? '' }
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty])
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false) }, [busy])
  async function call(action: string, input: Record<string, unknown>) {
    const result = await rpc.call(CHANNEL, `agents/datasets/${action}`, input) as any
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  async function refresh() {
    const target = current.current.runId
    const refreshId = ++refreshSequence.current
    const request = generation.current, selectedId = current.current.id
    try {
      const value = await call('list', { run_id: target })
      if (current.current.runId !== target || request !== generation.current || refreshId !== refreshSequence.current) return
      setList(value.datasets)
      if (selectedId && !current.current.busy) {
        const latest = await call('read', { dataset_id: selectedId })
        if (current.current.runId !== target || request !== generation.current || refreshId !== refreshSequence.current || current.current.id !== selectedId || current.current.busy) return
        if (current.current.dirty) { if (latest.sha256 !== current.current.sha256) setError('样本已在其他窗口修改；当前草稿保留。请核对后重新读取本批次。'); return }
        const selected = latest.dataset.records.find((entry: any) => entry._meta.id === current.current.recordId) ?? latest.dataset.records[0]
        setDocument(latest); setRecordId(selected?._meta.id ?? ''); setDraft(selected ? draftOf(selected) : null)
      }
    }
    catch (e) { if (current.current.runId === target && request === generation.current && refreshId === refreshSequence.current) setError((e as Error).message) }
  }
  useEffect(() => { generation.current++; setId(''); setDocument(null); setRecordId(''); setDraft(null); setList([]); setError(''); setMessage(''); return () => { generation.current++ } }, [runId])
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
    setDraft({ ...draft, questions: draft.questions.map((question, at) => at === index ? { ...question, ...patch, ...(reset ? { status: 'suggested', decisionTimeReviewed: false } : {}) } : question) })
  }
  function changeTask(patch: Partial<Draft>) {
    if (!draft) return
    setDraft({ ...draft, ...patch, questions: draft.questions.map(question => ({ ...question, status: 'suggested', decisionTimeReviewed: false })) })
  }
  function contentChanged(question: QuestionDraft) {
    return !!draft && (draft.workflow !== record.workflow || draft.taskId !== record.task?.id || draft.semantics !== record.task?.semantics || question.name !== question.originalName || question.type !== question.originalQuestion.type || question.instructions !== question.originalQuestion.instructions || question.criteria !== json(question.originalQuestion.criteria) || question.label !== json(question.originalTarget.label) || question.probabilities !== json(question.originalTarget.probabilities) || question.basis !== (question.originalTarget.basis ?? ''))
  }
  async function save() {
    if (!draft || !record || busy || legacy) return
    setError(''); setBusy(true); setMessage('')
    const request = ++generation.current
    try {
      const questions: Record<string, any> = Object.create(null), targets: Record<string, any> = Object.create(null)
      for (const question of draft.questions) {
        if (Object.hasOwn(questions, question.name)) throw new Error('决策题名称不能重复')
        const { criteria: _criteria, ...original } = question.originalQuestion
        questions[question.name] = { ...original, type: question.type, instructions: question.instructions, ...(question.criteria.trim() ? { criteria: JSON.parse(question.criteria) } : {}) }
        const { probabilities: _probabilities, ...target } = question.originalTarget
        targets[question.name] = { ...target, label: JSON.parse(question.label), ...(question.probabilities.trim() ? { probabilities: JSON.parse(question.probabilities) } : {}), provenance: JSON.parse(question.provenance), basis: question.basis, status: question.status, decision_time_reviewed: question.decisionTimeReviewed }
      }
      const checkedQuestions = validateDecisionQuestions(questions), checkedTargets = validateDecisionTargets(checkedQuestions, targets), task = validateDecisionTask({ ...record.task, id: draft.taskId, semantics: draft.semantics })
      const value = await call('update', { dataset_id: id, expected_sha256: document.sha256, record_id: recordId, workflow: draft.workflow, task, questions: checkedQuestions, targets: checkedTargets, group_id: draft.group, split: draft.split })
      if (request !== generation.current) return
      setDocument(value); setDraft(draftOf(value.dataset.records.find((entry: any) => entry._meta.id === recordId))); setMessage('本条已保存。复核状态和各用途可导出数量以保存后的检查结果为准。'); void refresh()
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
  return <section className="harness-eval-dataset" aria-label="决策样本工作区">
    <div className="harness-eval-section-heading"><div><h3>决策样本</h3><p className="harness-eval-muted">每条样本共享决策前输入，可包含多个命名决策题。AI 标签先作为建议，逐题人员复核后按明确用途导出。</p></div><button onClick={() => void refresh()}>刷新样本</button></div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <label className="harness-eval-field">样本批次<select aria-label="样本批次" value={id} disabled={busy} onChange={event => void open(event.target.value)}><option value="">选择已保存的批次</option>{list.map(item => <option key={item.id} value={item.id}>{time(item.created_at)} · {item.count} 条 · 有已复核题 {item.reviewed}</option>)}</select></label>
    {!list.length && <p className="harness-eval-empty">此 Run 尚无样本。点击上方“请 AI 抽取决策样本”，在对话中的预览卡确认保存后刷新。</p>}
    {document && <>
      {legacy && <div className="harness-eval-limits" role="status"><strong>旧格式样本，仅供阅读和候选下载。</strong><p>原有标签和复核记录保持原样；需要按当前决策合同重新抽取，不能直接作为新版合格训练或评测样本。</p>{onReextract && <button disabled={busy} onClick={onReextract}>按当前合同重新抽取</button>}</div>}
      {document.warnings?.length > 0 && <div className="harness-eval-limits"><strong>批次检查提示</strong><ul>{document.warnings.map((warning: string) => <li key={warning}>{warning}</li>)}</ul></div>}
      <div className="harness-eval-actions"><button disabled={busy} onClick={() => void open(id)}>重新读取本批次</button>{downloads.map(([kind, title]) => <button key={kind} disabled={busy || !eligibility?.counts?.[kind]} onClick={() => void download(kind)}>下载{title} JSONL{eligibility?.counts?.[kind] === undefined ? '' : `（${eligibility.counts[kind]}）`}</button>)}</div>
      <p className="harness-eval-note">可导出数量由平台检查已保存内容和真实来源后计算。只导出符合该用途的题目；候选下载保留建议供继续整理。未分配用途不进入训练；任务来源组及人工关联组共同约束训练、开发、校准和测试隔离。未保存修改不进入下载。</p>
      {eligibility?.blocked?.length > 0 && <div className="harness-eval-limits"><strong>批次中 {eligibility.blocked.length} 条样本存在导出限制</strong><ul>{eligibility.blocked.map((item: any) => <li key={item.record_id}>{item.record_id}：{item.reasons.join('；')}</li>)}</ul></div>}
      <div className="harness-eval-files-layout"><div className="harness-eval-file-list" aria-label="决策样本列表">{document.dataset.records.map((entry: any, index: number) => <button key={entry._meta.id} disabled={busy} aria-pressed={recordId === entry._meta.id} onClick={() => { if (dirty && !window.confirm('丢弃本条未保存修改并切换？')) return; setRecordId(entry._meta.id); setDraft(draftOf(entry)); setError(''); setMessage('') }}><span>{index + 1}. {entry.workflow ? `${entry.workflow} · ` : ''}{recordSummary(entry)}</span><small>{reviewSummary(entry)}</small></button>)}</div>
      {record && <article className="harness-eval-file-preview">
        <div className="harness-eval-decision-context" aria-label="样本决策时点"><strong>实际观察 · 原始轨迹第 {record._meta.cutoff?.line ?? '未知'} 行</strong><p className="harness-eval-note">{record._meta.cutoff?.session_log ?? 'Session 未记录'} · {record._meta.trace_path ?? '来源未记录'}</p><p className="harness-eval-note">来源输入：{record._meta.context_mode === 'actual_request' ? '已保存的实际模型请求' : record._meta.context_mode === 'reconstructed' ? '由可观察历史重建，可能与实际上下文不同' : '来源模式未记录'}。</p><pre>{json(record._meta.observed_action ?? null)}</pre>{onSource && record._meta.trace_path && Number.isInteger(record._meta.cutoff?.line) && <button disabled={busy} onClick={() => onSource({ path: record._meta.trace_path, line: record._meta.cutoff.line, ...(record._meta.trace_sha256 ? { source_sha256: record._meta.trace_sha256 } : {}) })}>定位原始轨迹（保留草稿）</button>}</div>
        <section className="harness-eval-sample-input"><h4>决策前输入（各题共享）</h4><pre>{json(record.state)}</pre></section>
        {recordEligibility?.reasons?.length > 0 && <div className="harness-eval-limits" aria-label="本条导出限制"><strong>本条导出限制</strong><ul>{recordEligibility.reasons.map((reason: string) => <li key={reason}>{reason}</li>)}</ul></div>}
        {readIssue && <p className="harness-eval-limits" role="alert">本条结构损坏，仅供阅读和候选下载：{readIssue}。请核对原始资料后重新抽取；平台不会补造缺失的问题或目标。</p>}
        {legacy || readIssue ? <section><h4>{legacy ? '旧格式问题、标签与复核记录' : '原始问题、目标与复核记录'}</h4><pre>{json({ questions: record.questions, targets: record.targets, review: record._meta })}</pre></section> : draft && <>
          <div className="harness-eval-form-grid"><label className="harness-eval-field">业务流程<input aria-label="决策业务流程" disabled={busy} value={draft.workflow} onChange={event => changeTask({ workflow: event.target.value })}/></label><label className="harness-eval-field">业务任务<input aria-label="决策业务任务" disabled={busy} value={draft.taskId} onChange={event => changeTask({ taskId: event.target.value })}/></label></div>
          <label className="harness-eval-field">监督目标<select aria-label="决策监督语义" disabled={busy} value={draft.semantics} onChange={event => changeTask({ semantics: event.target.value })}><option value="recommended_decision">基于可见状态的推荐判断</option><option value="observed_action">记录实际观察到的动作</option></select></label><p className="harness-eval-note">{draft.semantics === 'observed_action' ? '标签描述实际发生的行为，不能因此认定该行为正确或最佳。此模式使用候选选择题及与真实动作名一致的硬标签，不填写概率。' : '标签回答在当前可见输入下应该如何判断；实际动作只供对照，不自动成为正确答案。'}</p>
          {draft.questions.map((question, index) => <fieldset className="harness-eval-question" key={index}><legend>第 {index + 1} 题 · {question.name || '未命名'} · {status[question.status]}</legend>
            <div className="harness-eval-form-grid"><label className="harness-eval-field">决策题名称<input aria-label={`第 ${index + 1} 题名称`} disabled={busy} value={question.name} onChange={event => changeQuestion(index, { name: event.target.value })}/></label><label className="harness-eval-field">题型<select aria-label={`第 ${index + 1} 题题型`} disabled={busy} value={question.type} onChange={event => changeQuestion(index, { type: event.target.value })}><option value="choice">choice · 候选选择</option><option value="noul">noul · 是非判断</option><option value="score">score · 有序等级</option></select></label></div>
            <label className="harness-eval-field">问题<textarea aria-label={`第 ${index + 1} 题问题`} rows={3} disabled={busy} value={question.instructions} onChange={event => changeQuestion(index, { instructions: event.target.value })}/></label>
            <label className="harness-eval-field">{question.type === 'score' ? '有序等级 JSON（从 0 开始）' : '候选或判断规则 JSON'}<textarea aria-label={`第 ${index + 1} 题规则 JSON`} rows={4} disabled={busy} value={question.criteria} onChange={event => changeQuestion(index, { criteria: event.target.value })}/></label>
            <label className="harness-eval-field">标签 JSON（choice 用字符串、noul 用布尔值、score 用等级序号）<input aria-label={`第 ${index + 1} 题标签 JSON`} disabled={busy} value={question.label} onChange={event => changeQuestion(index, { label: event.target.value })}/></label>
            <label className="harness-eval-field">可选标签概率 JSON<textarea aria-label={`第 ${index + 1} 题概率 JSON`} rows={3} disabled={busy} value={question.probabilities} placeholder="没有真实概率证据时留空" onChange={event => changeQuestion(index, { probabilities: event.target.value })}/></label><p className="harness-eval-note">硬标签不自动补成概率。模型建议的概率未经校准，不能当作教师多次采样或人工真值。</p>
            <p className="harness-eval-note">标签来源：{provenanceLabels[question.originalTarget.provenance?.kind] ?? '未记录'}。修改题目、规则、标签、概率或依据后，当前题目需要重新复核；人工改写的标签来源由平台记录。</p><DetailDrawer title={`第 ${index + 1} 题标签来源详情`} trigger="标签来源详情" active={active} identity={`${runId}:${id}:${recordId}:${question.name}`}><pre>{question.provenance}</pre></DetailDrawer>
            <label className="harness-eval-field">可核对的标签依据<textarea aria-label={`第 ${index + 1} 题标签依据`} rows={3} disabled={busy} value={question.basis} onChange={event => changeQuestion(index, { basis: event.target.value })}/></label>
            {recordEligibility?.question_reasons?.[question.name]?.length > 0 && <ul className="harness-eval-note" aria-label={`第 ${index + 1} 题导出限制`}>{recordEligibility.question_reasons[question.name].map((reason: string) => <li key={reason}>{reason}</li>)}</ul>}
            <label className="harness-eval-review-check"><input type="checkbox" aria-label={`已核对第 ${index + 1} 题输入与监督目标`} disabled={busy || contentChanged(question)} checked={question.decisionTimeReviewed} onChange={event => changeQuestion(index, { decisionTimeReviewed: event.target.checked, ...(!event.target.checked ? { status: 'suggested' } : {}) }, false)}/>我已核对这道题：输入包含作答所需的全部材料，题目和候选中的事实来自决策前输入；标签依据符合上方监督目标，已区分实际动作与推荐判断。</label>
            {contentChanged(question) && <p className="harness-eval-note">本题内容已修改，请先保存修改，再核对并复核本题。</p>}
            <div className="harness-eval-actions"><button disabled={busy || contentChanged(question) || !question.decisionTimeReviewed} onClick={() => changeQuestion(index, { status: 'reviewed' }, false)}>确认第 {index + 1} 题已复核</button><button disabled={busy || contentChanged(question)} onClick={() => changeQuestion(index, { status: 'rejected', decisionTimeReviewed: false }, false)}>排除第 {index + 1} 题</button><button disabled={busy || draft.questions.length <= 1} onClick={() => setDraft({ ...draft, questions: draft.questions.filter((_, at) => at !== index) })}>移除第 {index + 1} 题</button></div>
          </fieldset>)}
          <button disabled={busy} onClick={() => setDraft({ ...draft, questions: [...draft.questions, { originalName: '', name: `decision_${draft.questions.length + 1}`, type: 'choice', instructions: '', criteria: '{}', label: '""', probabilities: '', provenance: '{"kind":"human_annotation"}', basis: '', status: 'suggested', decisionTimeReviewed: false, originalQuestion: {}, originalTarget: {} }] })}>添加命名决策题</button>
          <p className="harness-eval-note">复核是人员对题目、输入和标签的判断，平台不能自动证明业务正确。上方逐题操作先进入草稿，点击“保存本条修改与复核”后生效。</p>
          <p className="harness-eval-note">固定来源任务组：{record._meta.source_group_id ?? '未记录'}。手工关联任务只能增加同源联系，不能解除已有隔离。</p>
          <label className="harness-eval-field">关联任务分组<input aria-label="决策任务分组" disabled={busy} value={draft.group} onChange={event => setDraft({ ...draft, group: event.target.value })}/></label><label className="harness-eval-field">数据用途<select aria-label="决策数据用途" disabled={busy} value={draft.split} onChange={event => setDraft({ ...draft, split: event.target.value })}>{purposes.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
          <div className="harness-eval-actions"><button className="harness-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '正在保存…' : '保存本条修改与复核'}</button></div>
        </>}
        <DetailDrawer title="实际动作与证据定位" active={active} identity={`${runId}:${id}:${recordId}`}><pre>{json(record._meta)}</pre></DetailDrawer>
      </article>}</div><DetailDrawer title="抽取来源与跳过原因" active={active} identity={`${runId}:${id}`}><pre>{json({ extractor: document.dataset.extractor, path: document.dataset.path, source_sha256: document.dataset.source_sha256, skipped: document.dataset.skipped })}</pre></DetailDrawer>
    </>}
  </section>
}
