import assert from 'node:assert/strict'
import test from 'node:test'
import { summary } from '../src/inspection/index.ts'
import { classifyStatus } from '../src/inspection/status.ts'
import { classify, create as baseline } from '../compositions/inspection-baseline/src/index.ts'
import { create as routine } from '../compositions/inspection-routine/src/index.ts'
import { create as deep } from '../compositions/inspection-deep/src/index.ts'
import { create as reachability } from '../compositions/inspection-reachability/src/index.ts'

globalThis.fetch = () => { throw new Error('离线测试禁止网络') }
const ctx = { runId: 'offline-completion', shared: { scope: { count: 1 }, assets: [{ assetId: 1, online: 'unknown' }] } }
const config = { connections: {} }
const noCall = () => { throw new Error('本测试不得调用上游') }
const unbound = { assetId: 1, templateId: null, templateScopeMatched: false, memberCount: 0, applicableCount: 0, items: [], coverageReason: 'NO_TEMPLATE' }
const ready = { ...unbound, templateId: 8, templateScopeMatched: true, memberCount: 1, applicableCount: 1, coverageReason: 'APPLICABLE_ITEMS_PRESENT', items: [{ itemId: 2, applicable: true, applicabilityReason: 'MATCHED' }] }
const completed = (kind, item) => summary(kind, [item], ctx)

test('SOC未采集状态、未绑定模板、未采集基线均执行完成但不是normal', () => {
  const cases = [
    ['status', classifyStatus({ online: 'unknown' }), 'SOC未采集到状态数据'],
    ['baseline', classify(1, { run: null }, unbound), '设备未绑定基线模板'],
    ['baseline', classify(1, { run: { assetId: 1, templateId: 8, notCheckedReason: 'NO_DATA' } }, ready), 'SOC未采集到基线数据'],
  ]
  for (const [kind, item, message] of cases) {
    const result = completed(kind, item)
    assert.equal(result.status, 'completed'); assert.equal(result.complete, true)
    assert.equal(result.items[0].status, 'unknown'); assert.equal(result.items[0].complete, true)
    assert.equal(result.items[0].message, message); assert.equal(result.counts.normal, 0)
    assert.equal(result.counts.unknown, 1)
  }
  assert.equal(cases[0][1].reasonCode, undefined, '不修改原子返回对象')
})

test('显式null模板为未绑定；缺字段、冲突和真实接口失败仍未完成', () => {
  const explicitNull = classify(1, { run: null }, { ...unbound, coverageReason: undefined })
  assert.equal(explicitNull.reasonCode, 'NO_TEMPLATE')
  assert.equal(completed('baseline', explicitNull).complete, true)
  const missing = classify(1, { run: null }, { ...unbound, templateId: undefined, coverageReason: undefined })
  assert.equal(missing.reasonCode, 'TEMPLATE_BINDING_UNVERIFIED')
  assert.equal(completed('baseline', missing).status, 'incomplete')
  const conflict = classify(1, { run: { assetId: 1, templateId: 8, passFlag: '1' } }, unbound)
  assert.equal(conflict.reasonCode, 'BASELINE_EVIDENCE_CONFLICT')
  assert.equal(completed('baseline', conflict).complete, false)
  const failed = baseline(noCall).components.assess({ item: { assetId: 1 }, report: { error: '403 forbidden' }, readiness: { data: unbound } })
  assert.equal(failed.status, 'failed'); assert.equal(completed('baseline', failed).status, 'incomplete')
})

test('缺在线字段、invalid、未执行与缺互联必需证据不会被unknown放行', () => {
  for (const asset of [{}, { online: 'invalid' }]) assert.equal(completed('status', classifyStatus(asset)).status, 'incomplete')
  const workflow = reachability(noCall)
  const result = workflow.components.evidence({ item: { srcIp: '192.0.2.1', dstIp: '192.0.2.2', ruleType: 'REQUIRED' }, facts: { path: { reachable: true, verdict: 'REACHABLE', path: [] } } }).early
  assert.equal(result.status, 'unknown'); assert.equal(completed('reachability', result).status, 'incomplete')
  for (const item of [{ status: 'failed', complete: true }, { status: 'unknown', complete: true }, { status: 'not_executed' }, { status: 'normal', complete: false }]) assert.equal(completed('status', item).complete, false)
  assert.equal(summary('status', [], ctx).status, 'incomplete')
})

test('NO_MATCHING_PAIRS与not_applicable为完成，未改变业务状态', () => {
  for (const status of ['unknown', 'not_applicable']) {
    const result = completed('reachability', { status, reasonCode: 'NO_MATCHING_PAIRS' })
    assert.equal(result.status, 'completed'); assert.equal(result.items[0].status, status)
  }
  assert.equal(completed('baseline', { status: 'not_applicable', reasonCode: 'NO_APPLICABLE_ITEM' }).complete, true)
})

test('常规与深度汇总继承完成性，实际失败和未执行检查保留incomplete', () => {
  const status = routine(noCall).components.status({}, config, ctx)
  const baselineResult = completed('baseline', classify(1, { run: null }, unbound))
  const reachable = completed('reachability', { status: 'not_applicable', reasonCode: 'NO_MATCHING_PAIRS' })
  const combine = overrides => routine(noCall).components.summary({ status, baseline: baselineResult, reachability: reachable, ...overrides }, config, ctx)
  const full = combine({})
  assert.equal(full.status, 'completed'); assert.equal(full.complete, true)
  const vulnerabilities = completed('vulnerabilities', { status: 'normal' })
  assert.equal(deep(noCall).components.summary({ routine: full, vulnerabilities }, config, ctx).status, 'completed')
  for (const override of [undefined, completed('reachability', { status: 'unknown', message: '缺互联证据' }), completed('reachability', { status: 'failed' })]) {
    const partial = combine({ reachability: override })
    assert.equal(partial.status, 'incomplete')
    assert.equal(deep(noCall).components.summary({ routine: partial, vulnerabilities }, config, ctx).complete, false)
  }
  const falselyCompleted = { kind: 'reachability', status: 'completed', items: [{ status: 'unknown' }] }
  assert.equal(combine({ reachability: falselyCompleted }).status, 'incomplete')
  assert.equal(deep(noCall).components.summary({ routine: { ...full, status: 'incomplete' }, vulnerabilities }, config, ctx).status, 'incomplete')
})
