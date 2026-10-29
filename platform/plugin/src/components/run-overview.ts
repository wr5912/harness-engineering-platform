import type { ChartSegment, ChartTone } from './overview-charts.tsx'

type RunObservation = { status?: string | null; effective_verdict?: string | null }
export type RunOutcome = 'passed' | 'failed' | 'inconclusive' | 'unreviewed' | 'execution-failed' | 'unfinished' | 'cancelled' | 'unknown'
export const runOutcomeLabels: Record<RunOutcome, string> = { passed: '业务通过', failed: '业务未通过', inconclusive: '无法判定', unreviewed: '结论待核对', 'execution-failed': '执行失败', unfinished: '运行或待执行', cancelled: '已取消', unknown: '执行状态未知' }
export const runOutcomeTones: Record<RunOutcome, ChartTone> = { passed: 'success', failed: 'danger', inconclusive: 'warning', unreviewed: 'neutral', 'execution-failed': 'danger', unfinished: 'accent', cancelled: 'neutral', unknown: 'neutral' }
export function runOutcome(run: RunObservation): RunOutcome {
  if (run.status === 'completed') return run.effective_verdict === 'passed' || run.effective_verdict === 'failed' || run.effective_verdict === 'inconclusive' ? run.effective_verdict : 'unreviewed'
  if (run.status === 'failed') return 'execution-failed'
  if (run.status === 'cancelled') return 'cancelled'
  if (['running', 'queued', 'planned', 'recovering'].includes(run.status ?? '')) return 'unfinished'
  return 'unknown'
}
export function runOutcomeSegments(runs: RunObservation[]): ChartSegment[] {
  const counts = new Map<RunOutcome, number>()
  for (const run of runs) { const outcome = runOutcome(run); counts.set(outcome, (counts.get(outcome) ?? 0) + 1) }
  return (Object.keys(runOutcomeLabels) as RunOutcome[]).filter(key => counts.has(key)).map(key => ({ key, label: runOutcomeLabels[key], count: counts.get(key)!, tone: runOutcomeTones[key] }))
}
