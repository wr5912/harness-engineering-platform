import { useEffect, useRef, useState } from 'react'
import { CHANNEL } from '../protocol.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import type { PlatformPageProps } from '../protocol.ts'

type Draft = { case_id: string; title: string; scene: string; inputs: string[]; expected_behavior: string; fast: boolean }
export interface CreatedCaseDocument {
  case: { id: string; title: string; scene: string; inputs: string[]; expected_behavior: string; fast: boolean; tier: string }
  sha256: string
  path: string
}
export interface CaseCreationDialogProps extends PlatformPageProps {
  agentId: string
  experimentId: string
  sourceRun?: { run_id: string; case_id: string }
  active?: boolean
  onDirty?(dirty: boolean): void
  onBusy?(busy: boolean): void
  onSaved(document: CreatedCaseDocument): void | Promise<void>
  onClose(): void
}

export function CaseCreationDialog({ rpc, agentId, experimentId, sourceRun, active = true, onDirty, onBusy, onSaved, onClose }: CaseCreationDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const request = useRef(0)
  const [document, setDocument] = useState<any>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadedDraft, setLoadedDraft] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [message, setMessage] = useState('')
  const dirty = !!draft && JSON.stringify(draft) !== loadedDraft
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty])
  useEffect(() => { onBusy?.(busy || loading); return () => onBusy?.(false) }, [busy, loading])
  useEffect(() => { if (active) dialog.current?.showModal(); else dialog.current?.close() }, [active])

  async function call(operation: string, payload: Record<string, unknown>) {
    const result = await rpc.call(CHANNEL, `agents/${operation}`, payload)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as any
  }
  async function load(keepDraft = false) {
    const id = ++request.current
    setLoading(true); setError(''); setMessage(''); setPreview(null)
    try {
      const value = await call(sourceRun ? 'cases/from-run' : 'cases/create-context', { experiment_id: experimentId, ...(sourceRun ?? {}) })
      if (id !== request.current) return
      if (value.agent_id !== agentId) throw new Error('invalid_request: 所选研究版本与智能体不一致')
      setDocument(value); setConflict(false)
      if (!keepDraft) { setDraft(value.draft); setLoadedDraft(JSON.stringify(value.draft)) }
      else {
        setDraft(current => current ? { ...current, case_id: value.draft.case_id } : value.draft)
        setMessage('已读取最新用例文件并自动分配可用编号，当前草稿已保留。请重新预览，核对新增内容后保存。')
      }
    } catch (cause) { if (id === request.current) setError((cause as Error).message) }
    finally { if (id === request.current) setLoading(false) }
  }
  function update(next: Draft) { setDraft(next); setPreview(null); setMessage('') }
  function payload() {
    return { ...draft, experiment_id: experimentId, expected_sha256: document.sha256,
      ...(document.source_run_id ? { source_run_id: document.source_run_id, source_case_id: document.source_case_id } : {}) }
  }
  async function perform(save: boolean) {
    if (!draft || !document || busy || loading || conflict || save && !preview) return
    const id = request.current
    setBusy(true); setError(''); setMessage('')
    try {
      const value = await call(save ? 'cases/create' : 'cases/create-preview', payload())
      if (id !== request.current) return
      if (save) { setLoadedDraft(JSON.stringify(draft)); await onSaved(value); onClose() }
      else { setPreview(value); setMessage('差异预览已生成，尚未写入。确认新增后，后续评测立即使用此用例。') }
    } catch (cause) {
      if (id !== request.current) return
      const detail = (cause as Error).message
      setError(`${detail}；当前草稿已保留。`); setPreview(null)
      if (detail.startsWith('conflict:')) setConflict(true)
    } finally { if (id === request.current) setBusy(false) }
  }
  function close() {
    if (busy || loading || dirty && !window.confirm('关闭并放弃当前新增用例草稿？')) return
    onClose()
  }

  useEffect(() => {
    if (active) dialog.current?.showModal()
    void load()
    return () => { request.current++; dialog.current?.close() }
  }, [agentId, experimentId, sourceRun?.run_id, sourceRun?.case_id])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy])

  return <dialog ref={dialog} className="harness-eval-decision-dialog" aria-labelledby="evaluation-case-create-title" onCancel={event => { event.preventDefault(); close() }}>
    <div className="harness-eval-section-heading"><div><h2 id="evaluation-case-create-title">{sourceRun ? '从运行记录整理测试用例' : '新增测试用例'}{loading && draft ? <LoadingIndicator label="刷新用例来源" /> : null}</h2><small>{agentId} · {experimentId}</small></div><button type="button" disabled={busy || loading} onClick={close}>关闭</button></div>
    <div className="harness-eval-dialog-body"><p className="harness-eval-note">新增内容写入智能体共用的 evaluation.md；已启动和历史 Run 保留冻结口径。</p>
    {sourceRun && <p className="harness-eval-note">来源：{sourceRun.run_id} / {sourceRun.case_id}。仅复制冻结输入，请调整为新的复现输入并独立填写预期行为；实际回答不会作为参考答案。</p>}
    {loading && !draft && <LoadingIndicator label="读取当前用例与来源" block />}
    {error && <p role="alert">{error}</p>}
    {conflict && <p role="alert">用例文件已变化，请重新读取后核对。<button type="button" disabled={busy || loading} onClick={() => void load(true)}>保留草稿并重读最新版本</button></p>}
    {draft && <div className="harness-eval-editor">
      <p className="harness-eval-muted">用例编号：<code aria-label="新增用例编号">{draft.case_id}</code>（自动分配）</p>
      <label className="harness-eval-field">场景<input aria-label="新增用例场景" list="evaluation-case-scenes" disabled={busy || loading} value={draft.scene} onChange={event => update({ ...draft, scene: event.target.value })} /><datalist id="evaluation-case-scenes">{document?.scenes?.map((scene: string) => <option key={scene} value={scene} />)}</datalist></label>
      <label className="harness-eval-field">名称<input aria-label="新增用例名称" disabled={busy || loading} value={draft.title} onChange={event => update({ ...draft, title: event.target.value })} /></label>
      <h3>多轮输入</h3>{draft.inputs.map((value, index) => <div className="harness-eval-input-turn" key={index}><label className="harness-eval-field">第 {index + 1} 轮<textarea aria-label={`新增用例第 ${index + 1} 轮输入`} rows={3} disabled={busy || loading} value={value} onChange={event => update({ ...draft, inputs: draft.inputs.map((item, at) => at === index ? event.target.value : item) })} /></label><button type="button" disabled={busy || loading || draft.inputs.length === 1} onClick={() => update({ ...draft, inputs: draft.inputs.filter((_, at) => at !== index) })}>移除第 {index + 1} 轮</button></div>)}
      <button type="button" disabled={busy || loading} onClick={() => update({ ...draft, inputs: [...draft.inputs, ''] })}>＋ 添加一轮输入</button>
      <label className="harness-eval-field">预期行为<textarea aria-label="新增用例预期行为" rows={5} disabled={busy || loading} value={draft.expected_behavior} placeholder="填写应如何判断正确行为，保留无法判断的条件。" onChange={event => update({ ...draft, expected_behavior: event.target.value })} /></label>
      <label className="harness-eval-check"><input type="checkbox" disabled={busy || loading} checked={draft.fast} onChange={event => update({ ...draft, fast: event.target.checked })} />纳入快速评测（fast）</label>
    </div>}
    {message && <p role="status">{message}</p>}{preview && <details open><summary>新增用例差异</summary><pre className="harness-asset-content">{preview.diff}</pre></details>}
    </div>
    {draft && <div className="harness-eval-actions harness-eval-dialog-footer"><button type="button" disabled={busy || loading || conflict} onClick={() => void perform(false)}>{busy ? '处理中…' : '预览差异'}</button><button type="button" className="harness-primary" disabled={busy || loading || conflict || !preview} onClick={() => void perform(true)}>确认新增用例</button></div>}
  </dialog>
}
