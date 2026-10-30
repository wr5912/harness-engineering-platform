import { effectReviewLabel, separatedReview, sourceDiagnosisLabel, type SourceDiagnosis } from './review-state.ts'

export function RunReviewAssessment({ view, onEvidence }: { view: any; onEvidence?(path: string): void }) {
  if (!separatedReview(view?.source?.review_contract)) return null
  const diagnosis: SourceDiagnosis | null = view.source_diagnosis ?? view.summary?.source_diagnosis ?? null
  const scope = diagnosis?.scope ?? []
  const evidence = [...new Set([diagnosis?.analysis_session?.evidence_ref, diagnosis?.diagnostic?.evidence_ref,
    ...(diagnosis?.findings ?? []).flatMap(item => item.evidence_refs)].filter((path): path is string => Boolean(path)))]
  return <section className="harness-eval-case-evidence-summary" aria-label="业务效果与源码诊断">
    <dl className="harness-eval-facts">
      <div><dt>业务效果复核</dt><dd>{effectReviewLabel(view.summary?.review_status)}</dd></div>
      <div><dt>源码诊断</dt><dd>{sourceDiagnosisLabel(diagnosis)}</dd></div>
    </dl>
    <p>{diagnosis?.reason || '源码诊断记录尚未取得，当前状态待核对。'}</p>
    <small>业务结论来自本次用例的运行证据。源码诊断仅说明所列审读范围，不改变业务效果判定；未审读部分尚未核实。</small>
    <details className="harness-eval-raw"><summary>源码审读范围与诊断发现</summary>
      {scope.length ? <ul>{scope.map(item => <li key={`${item.bundle}:${item.path}`}><strong>{item.path}</strong> · {item.complete ? '该材料分片已完整读取' : '该材料分片尚未完整读取'}<br />已读行：{item.read_ranges.map(([start, end]) => `${start}–${end}`).join('、') || '未记录'} / 共 {item.total_lines} 行<small>{item.bundle} · SHA-256 {item.sha256}</small></li>)}</ul> : <p>未取得文件审读范围；不能据此认定源码已核实。</p>}
      {(diagnosis?.findings ?? []).map((finding, index) => <article key={index}><h4>{finding.observed_gap}</h4><p>{finding.root_cause_hypothesis}</p><p>其他解释：{finding.alternative}</p><p>验证方式：{finding.falsification}</p><small>支持用例：{finding.support_case_ids.join('、') || '无'}；反例用例：{finding.counterexample_case_ids.join('、') || '无'}</small></article>)}
      {onEvidence && evidence.length > 0 && <div className="harness-eval-actions">{evidence.map(path => <button type="button" key={path} title={path} onClick={() => onEvidence(path)}>查看 {path.split('/').pop()}</button>)}</div>}
    </details>
  </section>
}
