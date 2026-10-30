import type { PlatformNavigation } from '../protocol.ts'
import { effectReviewLabel, reviewMethodLabel, separatedReview, sourceDiagnosisLabel } from './review-state.ts'

const show = (value: unknown) => value === undefined || value === null || value === '' ? '未记录' : typeof value === 'object' ? JSON.stringify(value) : String(value)
function actualModels(view: any) {
  return [...new Set((view?.cases ?? []).flatMap((item: any) => (item.actual_routes ?? []).filter(Boolean).map((route: any) => `${route.provider ?? '未知提供方'}/${route.model ?? '未知模型'}/${route.reasoningEffort ?? '未知推理强度'}`)))].join('；') || '未记录'
}
function tools(view: any) {
  const calls = (view?.cases ?? []).flatMap((item: any) => item.tool_calls ?? [])
  return calls.length ? `${calls.length} 次；失败或未知 ${calls.filter((call: any) => call.status !== 'ok').length} 次；${[...new Set(calls.map((call: any) => call.name ?? '名称未知'))].join('、')}` : '未记录调用'
}
export function RunComparisonFacts({ comparison, onNavigate }: { comparison: any; onNavigate?(target: PlatformNavigation): void }) {
  const entries = comparison.cases ?? []
  const rows: [string, unknown, unknown][] = [
    ['实际模型 / 推理强度', actualModels(comparison.left_view), actualModels(comparison.right_view)],
    ['实际工具调用', tools(comparison.left_view), tools(comparison.right_view)],
    ['镜像 ID', comparison.left_image?.local_image_id, comparison.right_image?.local_image_id],
    ['镜像构建来源', comparison.left_image?.image_build_fingerprint, comparison.right_image?.image_build_fingerprint],
    ['评审方式', reviewMethodLabel(comparison.left_source), reviewMethodLabel(comparison.right_source)],
    ...(separatedReview(comparison.left_source?.review_contract) || separatedReview(comparison.right_source?.review_contract) ? [
      ['业务效果复核', effectReviewLabel(comparison.left_view?.summary?.review_status), effectReviewLabel(comparison.right_view?.summary?.review_status)],
      ['源码诊断', separatedReview(comparison.left_source?.review_contract) ? sourceDiagnosisLabel(comparison.left_view?.source_diagnosis ?? comparison.left_view?.summary?.source_diagnosis) : '未单独记录', separatedReview(comparison.right_source?.review_contract) ? sourceDiagnosisLabel(comparison.right_view?.source_diagnosis ?? comparison.right_view?.summary?.source_diagnosis) : '未单独记录'],
    ] as [string, unknown, unknown][] : []),
    ['固定运行来源', comparison.left_source?.source_ref ?? '当前工作树', comparison.right_source?.source_ref ?? '当前工作树'],
    ['接口环境', comparison.left_source?.mcp_fixture ? `Mock：${comparison.left_source.mcp_fixture.sha256}；不代表真实业务系统` : '未声明 Mock 映射', comparison.right_source?.mcp_fixture ? `Mock：${comparison.right_source.mcp_fixture.sha256}；不代表真实业务系统` : '未声明 Mock 映射'],
    ['插件 / 依赖配置摘要', comparison.left_source?.candidate_trees?.managed?.tree_sha256, comparison.right_source?.candidate_trees?.managed?.tree_sha256],
    ['资源消耗 / 费用', '未记录', '未记录'],
  ]
  return <section className="harness-eval-comparison-facts" aria-label="Run 比较来源与变化">
    <div className="harness-eval-section-heading"><h3>来源与变化</h3><span className="harness-eval-badge">{comparison.comparable ? '有共同用例可观察对照' : '缺少共同用例结果'}</span></div>
    <p>共同用例 {entries.length} 个；记录有差异 {entries.filter((item: any) => item.observed_change === '记录有差异').length} 个；冻结口径不同 {entries.filter((item: any) => !item.frozen_contract_same).length} 个。</p>
    <div className="harness-table-scroll"><table className="harness-eval-comparison-table"><thead><tr><th>核对项目</th><th>左侧 Run</th><th>右侧 Run</th></tr></thead><tbody>{rows.map(([name, left, right]) => <tr key={name}><th scope="row">{name}</th><td data-label="左侧 Run">{show(left)}</td><td data-label="右侧 Run">{show(right)}</td></tr>)}</tbody></table></div>
    <p className="harness-eval-note">{comparison.causal_comparable ? '已记录的比较条件一致，仍需结合实验设计判断效果。' : '来源或口径存在差异/缺失，应先核对下方限制；不能把观察差异归因为 Harness 改进。'}</p>
    {onNavigate && <div className="harness-eval-actions">{[['左侧', comparison.left_view], ['右侧', comparison.right_view]].map(([name, view]: any) => <button key={name} onClick={() => onNavigate({ page: 'agents', agent_id: view?.manifest?.agent_id, experiment_id: view?.manifest?.experiment_id, tab: 'assets' })}>查看{name} Harness 资产</button>)}</div>}
  </section>
}
