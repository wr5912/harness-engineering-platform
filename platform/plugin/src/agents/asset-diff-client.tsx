import { useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import type { AssetDiffView } from './asset-diff.ts'
import { DetailDrawer } from '../components/detail-drawer.tsx'

type Result = { ok: true; value: AssetDiffView } | { ok: false; error: { code: string; message: string } }
const statusText = { added: '新增', removed: '删除', modified: '修改' }

export function AssetDiffPanel({ rpc, experimentId, versions, baseline, active = true }: PlatformPageProps & {
  active?: boolean; experimentId: string; versions: { id: string }[]; baseline: { ref?: string; parent_experiment_id?: string }
}) {
  const [against, setAgainst] = useState('baseline')
  const [baselineExperiment, setBaselineExperiment] = useState(baseline.parent_experiment_id || experimentId)
  const [view, setView] = useState<AssetDiffView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  function reset() { request.current++; setView(null); setBusy(false); setError('') }
  async function compare(path?: string) {
    const current = ++request.current
    setBusy(true); setError('')
    try {
      const result = await rpc.call(CHANNEL, 'agents/assets/diff', { experiment_id: experimentId, against,
        ...(against === 'baseline' && baseline.ref?.startsWith('git:') ? { baseline_experiment_id: baselineExperiment } : {}), ...(path ? { path } : {}) }) as Result
      if (current !== request.current) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setView(result.value)
    } catch (error) { if (current === request.current) setError((error as Error).message) }
    finally { if (current === request.current) setBusy(false) }
  }
  return <section id="agent-asset-diff-panel" className="agent-asset-diff" aria-label="资产差异">
    <div className="agent-section-heading"><h3>资产差异</h3></div>
    <div className="agent-diff-controls">
      <label className="agent-field">对比来源<select value={against} onChange={event => { reset(); setAgainst(event.target.value) }}>
        <option value="baseline">固定 Baseline</option>
        {versions.filter(item => item.id !== experimentId).map(item => <option key={item.id} value={item.id}>{item.id}（工作树）</option>)}
      </select></label>
      {against === 'baseline' && baseline.ref?.startsWith('git:') && <label className="agent-field">Baseline 中的研究版本<select value={baselineExperiment} onChange={event => { reset(); setBaselineExperiment(event.target.value) }}>{versions.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>}
      <button type="button" disabled={busy} onClick={() => void compare()}>{busy ? '正在比较…' : '比较资产'}</button>
    </div>
    {against === 'baseline' && <p className="agent-muted">Baseline：{baseline.ref || '未记录'}。有固定 Git 引用时读取该提交中的父版本；首版与空来源比较。</p>}
    {error && <p role="alert">{error}</p>}
    {view && <>
      <p><strong>{view.left.label}</strong> → <strong>{view.right.label}</strong></p>
      <p role="status">新增 {view.summary.added} · 删除 {view.summary.removed} · 修改 {view.summary.modified} · 未变 {view.summary.unchanged}</p>
      {view.notes.map(note => <p key={note} className="agent-muted">{note}</p>)}
      <div className="harness-asset-layout">
        <nav aria-label="差异文件"><ul className="harness-asset-tree">{view.files.map(file => <li key={file.path}><button type="button" aria-pressed={view.selected?.path === file.path} disabled={busy} onClick={() => void compare(file.path)}>{statusText[file.status]} · {file.path}{file.mode_changed ? '（执行权限变化）' : ''}</button></li>)}</ul>{!view.files.length && <p>所选范围没有资产变化。</p>}</nav>
        <article>{view.selected ? <><h4>{view.selected.path}</h4>{view.selected.truncated && <p role="status">大文件只预览前 128 KiB 文本；完整内容摘要已参与比较。</p>}<pre className="harness-asset-content">{view.selected.diff || '脱敏后的文本相同；请核对文件摘要或执行权限变化。'}</pre></> : <p>选择一个差异文件查看只读内容。</p>}</article>
      </div>
      <DetailDrawer title="本次来源摘要" active={active} identity={`${experimentId}:${against}:${baselineExperiment}:${view.left.digest}:${view.right.digest}`}><dl className="harness-fields"><div><dt>对比来源</dt><dd>{view.left.source}</dd></div><div><dt>左侧摘要</dt><dd>{view.left.digest}</dd></div><div><dt>右侧摘要</dt><dd>{view.right.digest}</dd></div></dl></DetailDrawer>
    </>}
  </section>
}
