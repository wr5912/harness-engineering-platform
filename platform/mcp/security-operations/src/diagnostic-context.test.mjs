import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticTime, evaluateCandidate, validateCheckProposal } from './diagnostic-context.ts'

test('未知故障起点与历史窗不阻挡当前状态', () => {
  const time = diagnosticTime({})
  assert.equal(time.fault_started_at, null)
  assert.equal(time.query_window, null)
  assert.match(time.observation_requested_at, /Z$/)
  assert.throws(() => diagnosticTime({ from: '2026-11-09T10:00:00Z' }))
})
const rule = { id: 'power-off', title: '当前关机（不等于触发原因）', support: [{ predicate: 'power', value: 'off' }], confirm: [{ predicate: 'power', value: 'off' }, { predicate: 'management-bound', value: true }], refute: [{ predicate: 'power', value: 'on' }] }
const atom = (id, predicate, value, extra = {}) => ({ id, object_id: 'asset:1', predicate, value, observed_at: '2026-11-09T10:00:00Z', applicability: 'applicable', result: 'observed', provenance_verified: true, ...extra })
test('候选六态由已核原子和明确权限阻塞更新', () => {
  const off = atom('e1', 'power', 'off'), binding = atom('e2', 'management-bound', true), on = atom('e3', 'power', 'on')
  assert.equal(evaluateCandidate(rule, [], 'asset:1').status, 'unknown')
  assert.equal(evaluateCandidate(rule, [off], 'asset:1').status, 'supported')
  assert.equal(evaluateCandidate(rule, [off, binding], 'asset:1').status, 'confirmed')
  assert.equal(evaluateCandidate(rule, [on], 'asset:1').status, 'refuted')
  assert.equal(evaluateCandidate(rule, [off, on], 'asset:1').status, 'conflict')
  assert.equal(evaluateCandidate(rule, [], 'asset:1', ['explicit-403']).status, 'insufficient_capability')
})
test('失败/无数据/身份不符/时间未知不作业务反证', () => {
  for (const extra of [{ result: 'failed' }, { result: 'no_data' }, { object_id: 'asset:2' }, { observed_at: null }, { provenance_verified: false }, { applicability: 'unknown' }]) {
    assert.equal(evaluateCandidate(rule, [atom('bad', 'power', 'on', extra)], 'asset:1').status, 'unknown')
  }
})
test('无关predicate、cause、对象和窗外证据的冲突不污染当前候选', () => {
  const off = atom('off', 'power', 'off'), binding = atom('binding', 'management-bound', true)
  const irrelevant = [
    atom('route', 'route-error', true, { conflicts: ['route-other'] }), atom('route-other', 'route-error', false),
    atom('other-cause', 'power', 'on', { cause_id: 'upstream-outage', conflicts: ['off'] }),
    atom('other-object', 'power', 'on', { object_id: 'asset:2', conflicts: ['off'] }),
    atom('old', 'power', 'on', { observed_at: '2026-11-08T10:00:00Z', conflicts: ['off'] }),
  ]
  const result = evaluateCandidate(rule, [off, binding, ...irrelevant], 'asset:1', [], { window: { from: '2026-11-09T09:59:00Z', to: '2026-11-09T10:01:00Z' } })
  assert.equal(result.status, 'confirmed')
  assert.deepEqual(result.conflicts, [])
})
test('同一cause与predicate的真实冲突才影响候选；任意字符串不充当cause白名单', () => {
  const off = atom('off', 'power', 'off', { conflicts: ['on', 'unverified-conflict-label'] })
  const result = evaluateCandidate(rule, [off, atom('on', 'power', 'on')], 'asset:1')
  assert.equal(result.status, 'conflict')
  assert.deepEqual(result.conflicts, ['on'])
})
test('不同观测时间不拼接确认；显式跨度下所有判据仍须落在同一窗', () => {
  const off = atom('off', 'power', 'off'), laterBinding = atom('binding', 'management-bound', true, { observed_at: '2026-11-09T10:02:00Z' })
  const result = evaluateCandidate(rule, [off, laterBinding], 'asset:1')
  assert.equal(result.status, 'supported')
  assert.equal(result.temporal_confirmation_missing, true)
  assert.deepEqual(result.confirmation_evidence_ids, [])
  assert.equal(evaluateCandidate(rule, [off, laterBinding], 'asset:1', [], { maxEvidenceSpanMs: 120_000 }).status, 'confirmed')
  assert.equal(evaluateCandidate({ ...rule, maxEvidenceSpanMs: 119_999 }, [off, laterBinding], 'asset:1').status, 'supported')
  const three = { ...rule, confirm: [...rule.confirm, { predicate: 'third', value: true }] }
  const final = atom('third', 'third', true, { observed_at: '2026-11-09T10:04:00Z' })
  assert.equal(evaluateCandidate(three, [off, laterBinding, final], 'asset:1', [], { maxEvidenceSpanMs: 120_000 }).status, 'supported')
})
test('未满足完整confirm的局部判据不单独制造支持与反证冲突', () => {
  const onlyConfirm = { ...rule, support: [] }
  const result = evaluateCandidate(onlyConfirm, [atom('binding', 'management-bound', true), atom('on', 'power', 'on')], 'asset:1')
  assert.equal(result.status, 'refuted')
  assert.deepEqual(result.confirmation_evidence_ids, [])
})
test('时间窗与跨度合法，时间可按相同时刻而非字符串相等判断', () => {
  for (const observed_at of ['not-a-date', '2026-11-09T10:00:00']) assert.equal(evaluateCandidate(rule, [atom('bad', 'power', 'on', { observed_at })], 'asset:1').status, 'unknown')
  assert.equal(evaluateCandidate(rule, [atom('off', 'power', 'off'), atom('binding', 'management-bound', true, { observed_at: '2026-11-09T18:00:00+08:00' })], 'asset:1').status, 'confirmed')
  for (const maxEvidenceSpanMs of [-1, NaN, Infinity]) assert.throws(() => evaluateCandidate(rule, [], 'asset:1', [], { maxEvidenceSpanMs }))
  assert.throws(() => evaluateCandidate(rule, [], 'asset:1', [], { window: { from: 'bad', to: 'bad' } }))
})
test('旧的相反状态不与新的状态构成同时冲突；可从多份证据找到真正共同窗', () => {
  const off = atom('off', 'power', 'off'), binding = atom('binding', 'management-bound', true)
  assert.equal(evaluateCandidate(rule, [off, binding, atom('old-on', 'power', 'on', { observed_at: '2026-11-08T10:00:00Z' })], 'asset:1').status, 'confirmed')
  const result = evaluateCandidate(rule, [atom('old-off', 'power', 'off', { observed_at: '2026-11-08T10:00:00Z' }), binding, off], 'asset:1')
  assert.equal(result.status, 'confirmed')
  assert.deepEqual(result.confirmation_evidence_ids.sort(), ['binding', 'off'])
})

// 纯本地测试fixture，不代表任何线上工具或已取得的目录schema。
// 测试校验器实际检查下列fixture所用JSON Schema关键字；生产须注入目录配套的完整校验器。
const fixtureSchema = { type: 'object', required: ['assetId'], additionalProperties: false, properties: {
  assetId: { type: 'integer', minimum: 1 },
  options: { type: 'object', required: ['limit', 'mode'], additionalProperties: false, properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 }, mode: { type: 'string', enum: ['current', 'history'] },
    filters: { type: 'object', additionalProperties: false, properties: { healthy: { type: 'boolean' }, label: { type: 'string' } } }
  } }
} }
function fixtureValidate(schema, value) {
  if (schema === false) return false
  if (schema === true) return true
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false
    if (!Object.entries(schema.properties ?? {}).every(([key, child]) => !Object.hasOwn(value, key) || fixtureValidate(child, value[key]))) return false
  } else if (schema.type === 'integer' ? !Number.isInteger(value) : schema.type && typeof value !== schema.type) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false
  return true
}
const proposal = { id: 'p1', operation: 'read-power', object_id: 'asset:1', purpose: '区分当前电源状态', discriminates: ['power-off'], prerequisites: ['identity'], args: { assetId: 1 } }
const capability = { inputSchema: fixtureSchema, readonly: true, permission: 'granted', binding: { object_id: 'asset:1', args: { assetId: 1 } }, scope: { object_ids: ['asset:1'] } }
const state = { allowed: ['read-power'], objects: ['asset:1'], evidenceIds: ['identity'], used: [], remaining: 1, permitted: true, capabilities: { 'read-power': capability }, validateSchema: fixtureValidate }
test('受控提议范围、前置、预算和授权校验', () => {
  assert.ok(validateCheckProposal(proposal, state).fingerprint)
  assert.throws(() => validateCheckProposal(proposal, { ...state, remaining: 0 }))
  assert.throws(() => validateCheckProposal(proposal, { ...state, permitted: false }))
  assert.throws(() => validateCheckProposal(proposal, { ...state, evidenceIds: [] }))
  assert.throws(() => validateCheckProposal(proposal, { ...state, objects: [] }))
})
test('已有尝试（包括未知执行）不自动重发', () => {
  const first = validateCheckProposal(proposal, state)
  assert.throws(() => validateCheckProposal(proposal, { ...state, used: [first.fingerprint] }), /先查原请求/)
  assert.throws(() => validateCheckProposal(proposal, { ...state, attempts: [{ fingerprint: first.fingerprint, status: 'unknown', request_id: 'request-17' }] }), /先查原请求 request-17/)
})
test('递归canonical使嵌套参数等价请求去重；观测目的纳入key，数组保留顺序', () => {
  const first = { ...proposal, args: { assetId: 1, options: { limit: 10, mode: 'current', filters: { label: 'edge', healthy: true } } } }
  const reordered = { ...proposal, args: { options: { filters: { healthy: true, label: 'edge' }, mode: 'current', limit: 10 }, assetId: 1 } }
  const checked = validateCheckProposal(first, state)
  assert.equal(validateCheckProposal(reordered, state).fingerprint, checked.fingerprint)
  assert.throws(() => validateCheckProposal(reordered, { ...state, used: [checked.fingerprint] }), /先查原请求/)
  assert.notEqual(validateCheckProposal({ ...reordered, purpose: '区分历史电源状态' }, state).fingerprint, checked.fingerprint)
  const arrays = { ...state, capabilities: { 'read-power': { ...capability, inputSchema: true } } }
  assert.notEqual(validateCheckProposal({ ...proposal, args: { assetId: 1, sequence: [1, 2] } }, arrays).fingerprint, validateCheckProposal({ ...proposal, args: { assetId: 1, sequence: [2, 1] } }, arrays).fingerprint)
})
test('未知schema、缺validator和未知能力拒绝；仅真实传入schema交给校验器', () => {
  for (const missing of [{ capabilities: undefined }, { capabilities: {} }, { validateSchema: undefined }, { capabilities: { 'read-power': { ...capability, inputSchema: undefined } } }]) {
    assert.throws(() => validateCheckProposal(proposal, { ...state, ...missing }), /真实schema/)
  }
  let calls = 0
  validateCheckProposal(proposal, { ...state, validateSchema(schema, args) { calls++; assert.equal(schema, fixtureSchema); assert.equal(args, proposal.args); return fixtureValidate(schema, args) } })
  assert.equal(calls, 1)
  assert.throws(() => validateCheckProposal(proposal, { ...state, validateSchema: () => Promise.resolve(true) }), /schema约束/)
})
test('真实schema约束包含required、嵌套类型、enum、范围和额外字段', () => {
  for (const args of [{}, { assetId: '1' }, { assetId: 1, unexpected: true },
    { assetId: 1, options: { limit: 1 } }, { assetId: 1, options: { limit: 1.5, mode: 'current' } },
    { assetId: 1, options: { limit: 101, mode: 'current' } }, { assetId: 1, options: { limit: 1, mode: 'delete' } },
    { assetId: 1, options: { limit: 1, mode: 'current', filters: { healthy: 'true' } } }]) {
    assert.throws(() => validateCheckProposal({ ...proposal, args }, state))
  }
  assert.ok(validateCheckProposal({ ...proposal, args: { assetId: 1, options: { limit: 100, mode: 'history' } } }, state))
})
test('只读、绑定、权限与scope均须核实，合法schema不能绕过参数授权范围', () => {
  for (const metadata of [{ readonly: false }, { permission: 'unknown' }, { permission: 'denied' },
    { binding: { object_id: 'asset:2', args: { assetId: 1 } } }, { scope: { object_ids: [] } }]) {
    assert.throws(() => validateCheckProposal(proposal, { ...state, capabilities: { 'read-power': { ...capability, ...metadata } } }))
  }
  assert.throws(() => validateCheckProposal({ ...proposal, args: { assetId: 2 } }, state), /绑定/)
  const scoped = { ...state, capabilities: { 'read-power': { ...capability, scope: { object_ids: ['asset:1'], inputSchema: { type: 'object', properties: { options: { type: 'object', properties: { limit: { type: 'integer', maximum: 5 } } } } } } } } }
  assert.throws(() => validateCheckProposal({ ...proposal, args: { assetId: 1, options: { limit: 6, mode: 'current' } } }, scoped), /scope约束/)
  assert.ok(validateCheckProposal({ ...proposal, args: { assetId: 1, options: { limit: 5, mode: 'current' } } }, scoped))
})
test('非法JSON参数和循环值拒绝，不可在canonical时悄悄删去', () => {
  const jsonState = { ...state, capabilities: { 'read-power': { ...capability, inputSchema: true } } }
  const circular = {}; circular.self = circular
  for (const value of [undefined, NaN, Infinity, new Date(), circular, [undefined], 1n, () => true]) {
    assert.throws(() => validateCheckProposal({ ...proposal, args: { assetId: 1, value } }, jsonState), /JSON/)
  }
})
