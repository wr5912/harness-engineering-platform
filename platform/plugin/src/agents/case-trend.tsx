import type { ChartTone } from '../components/overview-charts.tsx'
import { caseObservation, observationLabel, type CaseObservation } from '../evaluation/case-observation.ts'

export type CaseCounts = Record<CaseObservation, number> & { total: number }
export type CaseTrendPoint = { key: string; runId?: string; label: string; fullTime: string; counts: CaseCounts | null; partial: boolean }
export const caseTrendSeries: { key: CaseObservation; label: string; tone: ChartTone; dash?: string }[] = [
  { key: 'passed', label: observationLabel('passed'), tone: 'success' },
  { key: 'failed', label: observationLabel('failed'), tone: 'danger', dash: '7 2' },
  { key: 'inconclusive', label: observationLabel('inconclusive'), tone: 'warning', dash: '4 3' },
  { key: 'mixed', label: observationLabel('mixed'), tone: 'accent', dash: '2 3' },
  { key: 'pending', label: observationLabel('pending'), tone: 'neutral', dash: '1 4' },
]
const runId = (run: any): string | undefined => typeof (run?.run_id ?? run?.id) === 'string' && (run.run_id ?? run.id) ? run.run_id ?? run.id : undefined

/** 总量与五类必须完整且相符；未知记录不补成零。 */
export function validCaseCounts(value: unknown): CaseCounts | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const keys = ['total', ...caseTrendSeries.map(series => series.key)]
  if (!keys.every(key => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0)) return null
  if (caseTrendSeries.reduce((sum, series) => sum + Number(item[series.key]), 0) !== item.total) return null
  return { total: Number(item.total), passed: Number(item.passed), failed: Number(item.failed), inconclusive: Number(item.inconclusive), mixed: Number(item.mixed), pending: Number(item.pending) }
}

export function observedCaseCounts(cases: any[]): CaseCounts {
  const counts: CaseCounts = { total: cases.length, passed: 0, failed: 0, inconclusive: 0, mixed: 0, pending: 0 }
  for (const item of cases) counts[caseObservation(item).value]++
  return counts
}

/** 最新详情可修正同一 Run 的索引结论，不借用其他版本或其他 Run。 */
export function agentOverviewRuns(runs: any[], latest?: any) {
  const latestId = runId(latest)
  return runs.map(run => latestId && runId(run) === latestId ? { ...run, ...latest } : run)
}

/** 调用方的索引以最新优先排列；展示最近八次，横轴由早到近。 */
export function agentCaseTrendPoints(runs: any[], latest?: any, latestDetail?: any): CaseTrendPoint[] {
  const latestId = runId(latest)
  const detailId = runId(latestDetail) ?? runId(latestDetail?.manifest)
  const latestCases = detailId && detailId === latestId && Array.isArray(latestDetail?.cases) && latestDetail.cases.length > 0 ? observedCaseCounts(latestDetail.cases) : null
  return agentOverviewRuns(runs, latest).slice(0, 8).reverse().map((run, index) => {
    const id = runId(run), dated = typeof run.created_at === 'string' && Number.isFinite(Date.parse(run.created_at))
    return { key: id ?? `unlocated-${index}`, runId: id,
      label: dated ? new Date(run.created_at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录',
      fullTime: dated ? new Date(run.created_at).toLocaleString('zh-CN') : '时间未记录',
      counts: id && id === latestId && latestCases ? latestCases : validCaseCounts(run.case_counts), partial: run.status !== 'completed' }
  })
}

export function caseTrendLineSegments(points: CaseTrendPoint[], key: CaseObservation) {
  const segments: { index: number; value: number }[][] = []
  let current: { index: number; value: number }[] = []
  for (const [index, point] of points.entries()) {
    if (point.counts) current.push({ index, value: point.counts[key] })
    else { if (current.length) segments.push(current); current = [] }
  }
  if (current.length) segments.push(current)
  return segments
}

function description(point: CaseTrendPoint) {
  return `${point.fullTime}，${point.counts ? `${point.counts.total} 个选定用例，${caseTrendSeries.map(series => `${series.label} ${point.counts![series.key]}`).join('，')}${point.partial ? '；未完整结束，仅为已记录观察' : ''}` : '用例计数未记录或无效，趋势留空'}`
}

export function AgentCaseTrend({ points, onOpenRun }: { points: CaseTrendPoint[]; onOpenRun?(id: string): void }) {
  const valid = points.filter(point => point.counts)
  const maximum = Math.max(1, ...valid.map(point => point.counts!.total))
  const latest = points.at(-1)
  const x = (index: number) => 28 + (index + .5) / points.length * 282
  const y = (value: number) => 84 - value / maximum * 68
  const ticks = [...new Set([0, Math.ceil(maximum / 2), maximum])]
  return <figure className="hep-overview-chart" data-variant="case-trend">
    <figcaption><h3>用例观察趋势</h3><p>个选定用例 · 最近 {points.length} 次 Run</p></figcaption>
    <div className="agent-case-trend-body">
      {valid.length ? <svg viewBox="0 0 320 106" role="img" aria-label={`用例观察趋势，单位为个选定用例，${points.length} 次 Run 中 ${valid.length} 次计数可用，${points.length - valid.length} 次留空`}>
        {ticks.map(tick => <g key={tick} className="agent-case-trend-axis"><line x1="28" x2="310" y1={y(tick)} y2={y(tick)} /><text x="21" y={y(tick) + 4}>{tick}</text></g>)}
        {points.map((point, index) => !point.counts && <g key={point.key} className="agent-case-trend-gap"><line x1={x(index)} x2={x(index)} y1="16" y2="84" /><text x={x(index)} y="55">?</text></g>)}
        {caseTrendSeries.map(series => <g key={series.key} data-series={series.key} data-tone={series.tone}>
          {caseTrendLineSegments(points, series.key).filter(segment => segment.length > 1).map((segment, index) => <polyline key={index} points={segment.map(point => `${x(point.index)},${y(point.value)}`).join(' ')} strokeDasharray={series.dash} />)}
          {points.map((point, index) => point.counts && <circle key={point.key} cx={x(index)} cy={y(point.counts[series.key])} r="2.5"><title>{series.label} · {description(point)}</title></circle>)}
        </g>)}
      </svg> : <p className="hep-overview-chart-empty">{points.length ? '尚无有效用例计数，无法绘制趋势。' : '完成首次评测后查看跨 Run 的用例数量变化。'}</p>}
      {points.length > 0 && <ol className="agent-case-trend-dates" style={{ gridTemplateColumns: `repeat(${points.length},minmax(0,1fr))` }} aria-label="查看趋势对应的 Run">{points.map(point => <li key={point.key}>{point.runId && onOpenRun ? <button type="button" title={description(point)} aria-label={`查看 Run，${description(point)}`} onClick={() => onOpenRun(point.runId!)}>{point.label}<small>{point.counts ? `${point.counts.total} 个${point.partial ? ' · 部分' : ''}` : '未读取'}</small></button> : <span>{point.label}<small>{point.counts ? `${point.counts.total} 个${point.partial ? ' · 部分' : ''}` : '未读取'}</small></span>}</li>)}</ol>}
      <ul className="agent-case-trend-legend" aria-label="用例观察趋势分类，数字为最近一次 Run">{caseTrendSeries.map(series => <li key={series.key} data-tone={series.tone}><svg width="15" height="8" viewBox="0 0 15 8" aria-hidden="true"><line x1="0" x2="15" y1="4" y2="4" strokeDasharray={series.dash} /></svg><span>{series.label}</span><strong>{latest?.counts ? latest.counts[series.key] : '—'}</strong></li>)}</ul>
      {points.length > 0 && valid.length < 2 && <p className="agent-case-trend-note">{valid.length ? '仅有 1 次有效计数，尚不能形成趋势。' : '缺失计数保持留空，不按零计算。'}</p>}
    </div>
  </figure>
}
