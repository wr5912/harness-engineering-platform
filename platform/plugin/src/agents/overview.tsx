import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { DistributionChart, SequenceChart, type ChartSegment } from '../components/overview-charts.tsx'
import { runOutcome, runOutcomeLabels, runOutcomeSegments, runOutcomeTones } from '../components/run-overview.ts'
import { caseObservation, observationLabel } from '../evaluation/case-observation.ts'
import { AgentCaseTrend, agentCaseTrendPoints, agentOverviewRuns, observedCaseCounts, caseTrendSeries } from './case-trend.tsx'

export type AgentRunOverview = { agentId: string; experimentId: string; phase: 'loading' | 'ready' | 'error'; runs: any[]; latest?: any; error?: string; detail?: any; detailError?: string; refreshing?: boolean; refreshError?: string }
const runId = (run: any): string | undefined => typeof (run?.run_id ?? run?.id) === 'string' && (run.run_id ?? run.id) ? run.run_id ?? run.id : undefined
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '时间未记录'
const scopeTime = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : null
const executionLabel = (status?: string) => ({ completed: '执行已结束', failed: '执行失败', running: '运行中', planned: '计划中', queued: '排队中', recovering: '正在恢复', cancelled: '已取消' } as Record<string, string>)[status ?? ''] ?? '执行状态待核对'
const verdictLabel = (run: any) => run.status === 'completed' && ['passed', 'failed', 'inconclusive'].includes(run.effective_verdict) ? runOutcomeLabels[runOutcome(run)] : run.status === 'completed' ? '业务结论待核对' : '尚无业务结论'

export function agentCaseSegments(cases: any[]): ChartSegment[] {
  const counts = observedCaseCounts(cases)
  return caseTrendSeries.map(series => ({ key: series.key, label: series.label, count: counts[series.key], tone: series.tone }))
}

export function AgentEvaluationOverview({ value, versionLabel, onOpenRun, onOpenEvaluation }: {
  value: AgentRunOverview | null; versionLabel: string; onOpenRun?(runId: string): void; onOpenEvaluation?(): void
}) {
  const latest = value?.latest, latestId = runId(latest)
  const runs = agentOverviewRuns(value?.runs ?? [], latest)
  const cases = Array.isArray(value?.detail?.cases) ? value.detail.cases : []
  const segments = agentCaseSegments(cases)
  const attention = cases.map((item: any) => ({ ...item, observation: caseObservation(item).value }))
    .filter((item: any) => ['failed', 'inconclusive', 'mixed'].includes(item.observation))
  const count = (key: string) => segments.find(segment => segment.key === key)?.count ?? 0
  const runScope = `当前版本全部已登记记录，共 ${runs.length} 次 Run`
  const latestTime = scopeTime(latest?.created_at)
  const caseScope = latestTime ? `最近一次 Run（${latestTime}）` : '最近一次 Run（创建时间未记录）'
  const trendPoints = agentCaseTrendPoints(value?.runs ?? [], latest, value?.detail)
  const latestCounts = trendPoints.at(-1)?.runId === latestId ? trendPoints.at(-1)?.counts : null
  const sequence = runs.filter(run => runId(run)).slice(0, 8).reverse().map(run => {
    const outcome = runOutcome(run)
    return { key: runId(run)!, label: run.created_at && Number.isFinite(Date.parse(run.created_at)) ? new Date(run.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录',
      status: runOutcomeLabels[outcome], tone: runOutcomeTones[outcome], description: `${executionLabel(run.status)} · ${time(run.created_at)}` }
  })
  return <section className="agent-evaluation-summary" aria-label="所选版本评测结论" aria-busy={value?.refreshing || !value || value.phase === 'loading'}>
    <div className="agent-section-heading"><div><h3>{versionLabel} 的评测概况{value?.refreshing && <LoadingIndicator label="更新此版本评测概况" />}</h3><p>仅统计当前所选版本；执行结束与业务结论分别核对。{(value?.refreshing || value?.refreshError || value?.detailError && value.detail) && <span> · {value.refreshError || value.detailError ? '读取失败，显示上次观察' : '上次观察'}</span>}</p></div><div className="agent-overview-actions">
      {latestId && <button type="button" title={`打开最近一次 Run：${latestId}`} disabled={!onOpenRun} onClick={() => onOpenRun?.(latestId)}>查看最近结果</button>}
      <button type="button" disabled={!onOpenEvaluation} onClick={() => onOpenEvaluation?.()}>查看全部 →</button>
    </div></div>
    {value?.refreshError && <p role="alert">评测结果读取失败：{value.refreshError}。以下显示上次观察，可刷新后重试。</p>}
    {!value || value.phase === 'loading' ? <LoadingIndicator label="读取此版本评测结果" block /> : value.phase === 'error' ? <p role="alert">评测结果读取失败：{value.error}。请刷新后重试。</p> : !latest ? <div className="agent-overview-charts">
      <DistributionChart title="当前版本 Run 分布" description={runScope} segments={[]} totalLabel="次 Run" emptyText="此版本尚无 Run。可先评测此版本，再查看业务结论。" />
      <SequenceChart title="最近 Run 结果" description="当前版本的可定位记录" items={[]} emptyText="此版本尚无可定位 Run。" />
      <AgentCaseTrend points={[]} />
    </div> : <>
      <div className="agent-result-status"><span data-status={latest.status ?? 'unknown'}>{executionLabel(latest.status)}</span><span data-status={latest.status === 'completed' ? latest.effective_verdict ?? 'unknown' : 'unknown'}>{verdictLabel(latest)}</span><small>最近一次 Run · {time(latest.created_at)}</small></div>
      <div className="agent-overview-charts">
        <DistributionChart title="当前版本 Run 分布" description={runScope} segments={runOutcomeSegments(runs)} totalLabel="次 Run" />
        <SequenceChart title="最近 Run 结果" description={`最近 ${sequence.length} 次记录 · ${sequence.some(item => item.label === '时间未记录') ? '缺少时间单独标注' : '左早右近'}`} items={sequence} onSelect={onOpenRun} emptyText="索引记录缺少 Run 定位信息，请在评测中心核对。" />
        <AgentCaseTrend points={trendPoints} onOpenRun={onOpenRun} />
      </div>
      <p className="agent-overview-latest-scope">{value.refreshing || value.detailError ? '上次观察 · ' : ''}{caseScope}：{latestCounts ? `共 ${latestCounts.total} 个选定用例` : value.detailError ? '选定用例数量未读取' : value.detail ? '未保存可统计的逐例观察' : '选定用例数量待核对'}。{!value.detail && !value.detailError && <LoadingIndicator label="读取最近 Run 的逐例观察" />}</p>
      <p className="agent-overview-scope">折线表示每次 Run 的用例数量变化；用例与环境可能不同，不是通过率，不代表质量升降。{trendPoints.some(point => point.partial) ? '未完整结束的 Run 仅包含已记录观察。' : ''}</p>
      {value.detailError && !value.detail && <p role="alert">逐例证据暂不可读：{value.detailError}。可在评测中心查看原 Run。</p>}
      {value.detailError && value.detail && <p role="alert">逐例证据读取失败：{value.detailError}。用例图保留上次观察，可刷新后重试。</p>}
      {value.detail && attention.length > 0 ? <div className="agent-overview-attention"><div className="agent-section-heading"><h4>需要关注的用例</h4></div>
        <p>{count('failed')} 项未通过，{count('inconclusive')} 项无法判定{count('mixed') ? `，${count('mixed')} 项结果不一致` : ''}；以下是需要关注的用例。</p>
        <ul className="agent-result-cases">{attention.slice(0, 3).map((item: any) => <li key={item.case_id}><span data-status={item.observation}>{observationLabel(item.observation)}</span><strong>{item.frozen?.title || item.current?.title || item.case_id}</strong><small>{item.case_id}</small></li>)}</ul>
        {attention.length > 3 && <p>另有 {attention.length - 3} 项需要在报告中核对。</p>}
      </div> : value.detail && latest.status === 'completed' && latest.effective_verdict === 'passed' ? <p className="agent-overview-scope">此 Run 的业务结论为通过；适用范围以报告中的冻结用例和来源为准。</p> : null}
    </>}
  </section>
}
