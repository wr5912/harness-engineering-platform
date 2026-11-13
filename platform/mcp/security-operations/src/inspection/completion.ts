/** 业务结论与执行完成性分离：unknown 只有明确的上游业务终态才算完成。 */
export function withCompletion(kind: string, item: any) {
  let reasonCode = item?.reasonCode
  const businessComplete = kind === 'status' && item?.facts?.online === 'unknown'
    || kind === 'baseline' && ['NO_TEMPLATE', 'NO_DATA'].includes(reasonCode)
    || kind === 'reachability' && reasonCode === 'NO_MATCHING_PAIRS'
  if (kind === 'status' && item?.status === 'unknown' && item?.facts?.online === 'unknown') reasonCode ??= 'SOC_STATUS_NOT_COLLECTED'
  const complete = item?.complete !== false && !item?.error && (
    ['normal', 'abnormal', 'not_applicable'].includes(item?.status)
    || item?.status === 'unknown' && businessComplete
  )
  return { ...item, ...(reasonCode ? { reasonCode } : {}), complete }
}

/** 父检查不能凭 completed 标签掩盖失败、缺证据或未执行的子结果。 */
export function checkComplete(check: any): boolean {
  if (!check || check.status !== 'completed' || check.complete === false || check.error) return false
  if (Array.isArray(check.items) && !check.items.every((item: any) => withCompletion(check.kind, item).complete)) return false
  if (check.checks && !Object.values(check.checks).every(checkComplete)) return false
  return true
}
