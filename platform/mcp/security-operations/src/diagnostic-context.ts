export type DiagnosticValue = Record<string, any>

/** 查询窗、故障开始和本次观测互不替代；未提供历史时间不阻挡当前只读观察。 */
export function diagnosticTime(input: DiagnosticValue) {
  const timed = (value: unknown): value is string => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))
  const hasFrom = input.from !== undefined, hasTo = input.to !== undefined
  if (hasFrom !== hasTo) throw new Error('历史查询窗必须同时提供from/to；可均省略以仅检查当前状态')
  if (hasFrom && (!timed(input.from) || !timed(input.to) || Date.parse(input.from) >= Date.parse(input.to))) throw new Error('查询窗口须带时区且from早于to')
  if (input.faultStartedAt !== undefined && input.faultStartedAt !== null && !timed(input.faultStartedAt)) throw new Error('故障起点须为带时区时间；未知可省略或为null')
  return { fault_started_at: input.faultStartedAt ?? null, query_window: hasFrom ? { from: input.from, to: input.to } : null,
    observation_requested_at: new Date().toISOString(), message: '当前时间仅为本次请求时间；源观测时间由实际证据提供，不充当故障起点或查询窗' }
}

export const candidateStates = Object.freeze(['confirmed', 'supported', 'refuted', 'unknown', 'conflict', 'insufficient_capability'] as const)
export type CandidateState = typeof candidateStates[number]
export type Criterion = { predicate: string; value: unknown }
export type DiagnosticWindow = { from: string; to: string }
export type CandidateOptions = { window?: DiagnosticWindow; maxEvidenceSpanMs?: number }
export type CandidateRule = { id: string; title: string; cause_id?: string; support: Criterion[]; confirm: Criterion[]; refute: Criterion[]; maxEvidenceSpanMs?: number }
export type DiagnosticAtom = { id: string; object_id: string; predicate: string; cause_id?: string; value: unknown; observed_at: string | null;
  applicability: 'applicable' | 'not_applicable' | 'unknown'; result: 'observed' | 'no_data' | 'failed' | 'not_executed';
  provenance_verified: boolean; conflicts?: string[] }

const timestamp = (value: unknown) => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN

/** 时间跨度由调用方/规则明确给出；未给出时，只合并同一观测时刻，不猜测业务有效期。 */
export function evaluateCandidate(rule: CandidateRule, atoms: DiagnosticAtom[], objectId: string, blocked: string[] = [], options: CandidateOptions = {}) {
  const span = options.maxEvidenceSpanMs ?? rule.maxEvidenceSpanMs ?? 0
  if (!Number.isFinite(span) || span < 0) throw new Error('证据时间跨度须为非负有限毫秒数')
  const from = options.window ? timestamp(options.window.from) : -Infinity, to = options.window ? timestamp(options.window.to) : Infinity
  if (!(from < to)) throw new Error('候选查询窗须带时区且from早于to')
  const criteria = [...rule.support, ...rule.confirm, ...rule.refute]
  const usable = atoms.filter(atom => {
    const time = timestamp(atom.observed_at)
    return atom.object_id === objectId && atom.result === 'observed' && atom.applicability === 'applicable' && atom.provenance_verified
      && Number.isFinite(time) && time >= from && time <= to && (atom.cause_id === undefined || atom.cause_id === (rule.cause_id ?? rule.id))
      && criteria.some(criterion => criterion.predicate === atom.predicate)
  })
  const matches = (criterion: Criterion, atom: DiagnosticAtom) => atom.predicate === criterion.predicate && Object.is(atom.value, criterion.value)
  const collect = (entries: Criterion[]) => usable.filter(atom => entries.some(criterion => matches(criterion, atom)))
  const support = collect(rule.support), refute = collect(rule.refute), confirmation = collect(rule.confirm)
  // 枚举证据起点，而非分别为每个判据任意挑历史证据；完整集合必须落在同一跨度内。
  const confirmed = confirmation.map(start => confirmation.filter(atom => timestamp(atom.observed_at) >= timestamp(start.observed_at) && timestamp(atom.observed_at) - timestamp(start.observed_at) <= span))
    .find(group => rule.confirm.length > 0 && rule.confirm.every(criterion => group.some(atom => matches(criterion, atom)))) ?? []
  const relatedConflicts = usable.flatMap(atom => (atom.conflicts ?? []).filter(id => {
    const other = usable.find(entry => entry.id === id)
    return other !== undefined && other.id !== atom.id && other.predicate === atom.predicate && !Object.is(other.value, atom.value)
      && Math.abs(timestamp(other.observed_at) - timestamp(atom.observed_at)) <= span
  }))
  const contrary = [...support, ...confirmed].some(atom => refute.some(other => Math.abs(timestamp(other.observed_at) - timestamp(atom.observed_at)) <= span))
  const conflicts = [...new Set(relatedConflicts)]
  const status: CandidateState = conflicts.length || contrary ? 'conflict' : confirmed.length ? 'confirmed'
    : refute.length ? 'refuted' : support.length ? 'supported' : blocked.length ? 'insufficient_capability' : 'unknown'
  return { id: rule.id, title: rule.title, status, support_evidence_ids: support.map(atom => atom.id), confirmation_evidence_ids: confirmed.map(atom => atom.id),
    refutation_evidence_ids: refute.map(atom => atom.id), conflicts, blocked,
    missing_criteria: [...rule.support, ...rule.confirm].filter(criterion => !usable.some(atom => matches(criterion, atom))),
    temporal_confirmation_missing: rule.confirm.length > 0 && !confirmed.length && rule.confirm.every(criterion => confirmation.some(atom => matches(criterion, atom))) }
}

export type CheckProposal = { id: string; operation: string; object_id: string; purpose: string; discriminates: string[]; prerequisites: string[]; args: DiagnosticValue }
export type CheckCapability = {
  inputSchema: unknown; readonly: boolean; permission: 'granted' | 'denied' | 'unknown';
  binding: { object_id: string; args: DiagnosticValue };
  scope: { object_ids: string[]; inputSchema?: unknown }
}
export type CheckProposalState = {
  allowed: string[]; objects: string[]; evidenceIds: string[]; used: string[]; remaining: number; permitted: boolean;
  capabilities?: Record<string, CheckCapability>;
  /** 调用方提供与真实目录schema配套的同步校验器；不在此处替造schema或降级为字段白名单。 */
  validateSchema?: (schema: unknown, args: DiagnosticValue) => boolean;
  attempts?: { fingerprint: string; status: 'succeeded' | 'failed' | 'unknown'; request_id: string }[]
}

/** 只接受JSON值，递归排序对象键；数组顺序保留，避免不同请求被意外归一。 */
export function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('参数须为无循环的JSON值')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('参数须为普通JSON对象')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return '[' + Array.from(value, entry => canonical(entry, ancestors)).join(',') + ']'
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as DiagnosticValue)[key], ancestors)).join(',') + '}'
  } finally { ancestors.delete(value) }
}

/** 受控提议验证：仅消费已取得的真实schema/能力元数据与校验器；不执行、不发现工具、不调用上游。 */
export function validateCheckProposal(proposal: CheckProposal, state: CheckProposalState) {
  if (!state.permitted) throw new Error('本次授权不允许该动作')
  if (!state.allowed.includes(proposal.operation) || !state.objects.includes(proposal.object_id)) throw new Error('提议超出冻结能力或对象范围')
  if (!proposal.purpose?.trim() || !proposal.discriminates.length || proposal.prerequisites.some(id => !state.evidenceIds.includes(id))) throw new Error('提议缺区分目的或真实前置')
  if (!Number.isFinite(state.remaining) || state.remaining <= 0) throw new Error('诊断预算到限')
  const capability = state.capabilities && Object.hasOwn(state.capabilities, proposal.operation) ? state.capabilities[proposal.operation] : undefined
  if (!capability || capability.inputSchema === undefined || capability.inputSchema === null || !state.validateSchema) throw new Error('缺少已取得的真实schema或schema校验器，拒绝执行')
  if (capability.readonly !== true || capability.permission !== 'granted') throw new Error('能力不是已授权只读操作')
  if (!capability.binding || capability.binding.object_id !== proposal.object_id || !capability.binding.args || !capability.scope?.object_ids?.includes(proposal.object_id)) throw new Error('能力绑定或scope超出对象范围')
  if (!proposal.args || typeof proposal.args !== 'object' || Array.isArray(proposal.args)) throw new Error('参数须为JSON对象')
  const fingerprint = canonical([proposal.operation, proposal.object_id, proposal.purpose.trim(), proposal.args])
  for (const [key, value] of Object.entries(capability.binding.args)) {
    if (!Object.hasOwn(proposal.args, key) || canonical(proposal.args[key]) !== canonical(value)) throw new Error(`参数${key}超出已核对象绑定`)
  }
  if (state.validateSchema(capability.inputSchema, proposal.args) !== true) throw new Error('参数不符合真实schema约束')
  if (capability.scope.inputSchema !== undefined && state.validateSchema(capability.scope.inputSchema, proposal.args) !== true) throw new Error('参数超出已授权scope约束')
  const attempt = state.attempts?.find(entry => entry.fingerprint === fingerprint)
  if (attempt || state.used.includes(fingerprint)) throw new Error(`相同检查已有尝试记录；执行未知时先查原请求${attempt ? ` ${attempt.request_id}` : ''}，不自动重发`)
  return { ...proposal, fingerprint }
}
