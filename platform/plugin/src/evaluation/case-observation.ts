export type CaseObservation = 'passed' | 'failed' | 'inconclusive' | 'mixed' | 'pending'

/** 逐例证据复核优先；机器 Trial 必须有完整且一致的判定才能归为单一结果。 */
export function caseObservation(item: any, requireReview = false): { value: CaseObservation; source: string } {
  const reviewed = item.review?.reviewed_verdict
  if (['passed', 'failed', 'inconclusive'].includes(reviewed)) return { value: reviewed, source: '证据复核' }
  if (requireReview) return { value: 'pending', source: '证据复核' }
  const trials = Array.isArray(item.trials) ? item.trials : []
  if (!trials.length) return { value: 'pending', source: '机器 Trial' }
  const verdicts = trials.map((trial: any) => trial.verdict)
  if (verdicts.some((value: unknown) => typeof value !== 'string' || !['passed', 'failed', 'inconclusive'].includes(value))) return { value: 'pending', source: '机器 Trial' }
  return { value: verdicts.every((value: string) => value === verdicts[0]) ? verdicts[0] : 'mixed', source: '机器 Trial' }
}
export const observationLabel = (value: CaseObservation) => ({ passed: '通过', failed: '未通过', inconclusive: '无法判定', mixed: '结果不一致', pending: '未记录结果' })[value]
