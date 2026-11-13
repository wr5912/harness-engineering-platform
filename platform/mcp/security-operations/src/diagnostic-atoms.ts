import type { DiagnosticAtom } from './diagnostic-context.ts'

/** 只解析响应内可核的证据项；不从在线标签、结论字符串或查询时间造原子。 */
export function normalizeDiagnosticAtoms(payload: any, binding: { objectId: string; sourceId: string; receiptId: string; ip?: string; port?: number; protocol?: string }): DiagnosticAtom[] {
  const items = payload?.evidence?.items ?? payload?.items ?? []
  if (!Array.isArray(items)) return []
  return items.flatMap((item: any, index: number) => {
    // 监听端仅返回目标身份；pair关联由平台冻结输入建立，不要求SOC知道源IP。
    const objectMatches = item && (binding.ip ? item.ip === binding.ip && item.port === binding.port && item.protocol === binding.protocol : item.objectId === binding.objectId)
    if (!item || !objectMatches || item.validity !== 'VALID' || item.applicability !== 'applicable'
      || typeof item.sourceId !== 'string' || !item.sourceId.trim() || typeof item.observedAt !== 'string'
      || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(item.observedAt) || !Number.isFinite(Date.parse(item.observedAt))
      || typeof item.predicate !== 'string' || !Object.hasOwn(item, 'value')) return []
    if (binding.ip && item.ip !== binding.ip || binding.port !== undefined && item.port !== binding.port || binding.protocol && item.protocol !== binding.protocol) return []
    return [{ id: `${binding.receiptId}:atom:${index}`, object_id: binding.objectId, predicate: item.predicate,
      value: item.value, observed_at: item.observedAt, applicability: 'applicable', result: 'observed', provenance_verified: true,
      source_id: item.sourceId, receipt_id: binding.receiptId, transport_source_id: binding.sourceId }]
  })
}

/** 复合判据要求同对象同观测时刻；任一标签不能独立确认。 */
export const businessConfirmCriteria: Record<string, { predicate: string; value: unknown }[]> = {
 'source-abnormal': [{predicate:'source-system-state',value:'failed'},{predicate:'source-interface-state',value:'down'}],
 'target-offline': [{predicate:'target-power-state',value:'off'},{predicate:'target-management-state',value:'unreachable'}],
 'service-not-listening': [{predicate:'listener-state',value:'not-listening'},{predicate:'service-state',value:'stopped'}],
 'policy-block': [{predicate:'policy-match',value:'deny'},{predicate:'policy-enforcement',value:'drop'}],
 'link-abnormal': [{predicate:'interface-carrier',value:'down'},{predicate:'adjacent-link-state',value:'down'}],
 'authentication': [{predicate:'business-auth',value:'failed'},{predicate:'business-auth-log',value:'rejected'}],
}
