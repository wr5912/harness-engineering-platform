import type { BusinessControlManagementStatus } from './management.ts'

export type GatewayBucket = { key: string; label: string; count: number; tone: 'success' | 'blocked' | 'pending' | 'neutral' }
export function identityBucket(instance: BusinessControlManagementStatus['instances'][number], status?: BusinessControlManagementStatus['agentStatuses'][number]) {
  if (instance.identityMode === 'development' || status?.authentication.status === 'not_required') return 'development'
  if (status?.authentication.status === 'verified' && status.trust.status === 'trusted') return 'verified'
  if (status?.authentication.status === 'disabled' || status?.trust.status === 'revoked' || status?.trust.status === 'mismatch') return 'abnormal'
  return 'unknown'
}
export function riskBucket(fact: BusinessControlManagementStatus['riskFacts'][number], now: number) {
  const expiry = Date.parse(fact.expiresAt)
  if (!Number.isFinite(expiry)) return 'unknown'
  if (expiry <= now) return 'expired'
  if (fact.status === 'unknown' || !fact.level || fact.level === 'unknown') return 'unknown'
  return fact.level
}
/** 同一事实只取最新版本；不同事实的约束可叠加，不能按相同范围互相覆盖。 */
export function currentRiskFacts(facts: BusinessControlManagementStatus['riskFacts'], now: number) {
  const latest = new Map<string, BusinessControlManagementStatus['riskFacts'][number]>()
  for (const fact of facts) {
    const key = fact.id
    const previous = latest.get(key)
    if (!previous || fact.version > previous.version || fact.version === previous.version && Date.parse(fact.observedAt) > Date.parse(previous.observedAt)) latest.set(key, fact)
  }
  return [...latest.values()].map(fact => ({ fact, bucket: riskBucket(fact, now) }))
}
export function GatewayChart({ title, scope, segments, totalLabel, note, selected, onSelect }: { title: string; scope: string; segments: GatewayBucket[]; totalLabel: string; note?: string; selected?: string; onSelect(key: string): void }) {
  const total = segments.reduce((sum, item) => sum + item.count, 0)
  const circumference = 2 * Math.PI * 39
  let offset = 0
  return <article className="harness-gateway-chart"><h3>{title}</h3><p>{scope}</p><div className="harness-gateway-chart-body"><svg viewBox="0 0 110 110" aria-label={`${title}，共 ${total} ${totalLabel}`} role="img"><circle className="harness-gateway-chart-base" cx="55" cy="55" r="39"/>{segments.filter(item => item.count > 0).map(item => {
    const length = item.count / total * circumference, start = offset; offset += length
    return <circle key={item.key} cx="55" cy="55" r="39" data-tone={item.tone} strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-start} transform="rotate(-90 55 55)"/>
  })}<text x="55" y="53" className="harness-gateway-chart-total">{total}</text><text x="55" y="70">{totalLabel}</text></svg><div>{segments.map(item => <button type="button" key={item.key} data-tone={item.tone} aria-pressed={selected === item.key} onClick={() => onSelect(item.key)}><i/><span>{item.label}</span><strong>{item.count}</strong></button>)}</div></div><small aria-hidden={note ? undefined : true}>{note || '\u00a0'}</small></article>
}
