// 专属离线回归：直接加载 TypeScript；所有上游仅使用本文件内存桩，不构建、发布或调用网络。
import assert from 'node:assert/strict'
import test from 'node:test'
import { decode, inputSchema, tools, summary } from '../src/inspection/index.ts'
import { create as reachability } from '../compositions/inspection-reachability/src/index.ts'
import { classify, create as baseline } from '../compositions/inspection-baseline/src/index.ts'

globalThis.fetch = () => { throw new Error('本测试禁止网络请求') }
const config = { connections: { master: 'master', graph: 'graph', ingest: 'ingest' } }
const signal = new AbortController().signal
const assets = [
  { assetId: 1, ip: '10.0.0.1', hostname: 'one', assetType: 'host', layerId: 1, networkTier: 'core', deptId: 11 },
  { assetId: 2, ip: '10.0.0.1', hostname: 'two', assetType: 'network', layerId: 2, networkTier: 'edge', deptId: 12 },
  { assetId: 3, ip: '10.0.0.3', hostname: 'three', assetType: 'host', layerId: 1, networkTier: 'core', deptId: 11 },
]
const required = { id: 10, name: 'required', enabled: true, ruleType: 'REQUIRED', sourceSelector: { scope: 'ASSETS', cidrs: ['10.0.0.1'] }, destSelector: { scope: 'ASSETS', cidrs: ['10.0.0.3'] } }
const forbidden = { ...required, id: 11, name: 'forbidden', ruleType: 'FORBIDDEN' }
function socFixture({ inventory = assets, rules = [required, forbidden], rulesError, pages = false } = {}) {
  const calls = []
  const soc = async (connection, operation, args) => {
    calls.push({ connection, operation, args })
    if (operation === 'list_soc_asset') return { code: 200, total: inventory.length, rows: pages ? inventory.slice(args.pageNum - 1, args.pageNum) : inventory }
    if (operation === 'get_soc_asset_by_asset_id') return { code: 200, data: inventory.find(asset => asset.assetId === args.assetId) }
    if (operation === 'get_graph_compliance_rules') { if (rulesError) throw new Error(rulesError); return { code: 200, data: rules } }
    throw new Error(`未声明的离线操作 ${operation}`)
  }
  return { soc, calls }
}
const context = shared => ({ shared, signal, call: fn => fn() })

test('编排上游错误保留安全正文，不再丢失鉴权失败原因', () => {
  assert.throws(() => decode({ isError: true, content: [{ type: 'text', text: '{"code":401,"msg":"API Key 无效 apiKey=fixture-secret"}' }] }), error => {
    assert.match(error.message, /上游 MCP 工具执行失败/u)
    assert.match(error.message, /code/u)
    assert.match(error.message, /已隐藏/u)
    assert.doesNotMatch(error.message, /fixture-secret/u)
    return true
  })
})

test('IP 歧义跨分页返回结构化真实候选；相同 ID 去重且不静默全选', async () => {
  const fixture = socFixture({ pages: true }), api = tools(fixture.soc)
  await assert.rejects(api.prepare({ scope: { ips: ['10.0.0.1'] } }, config, signal), error => {
    assert.equal(error.code, 'AMBIGUOUS_ASSET_IP')
    assert.deepEqual(error.details.ambiguities[0].candidates.map(asset => [asset.assetId, asset.hostname]), [[1, 'one'], [2, 'two']])
    assert.match(error.message, /"code":"AMBIGUOUS_ASSET_IP"/)
    const wire = JSON.parse(JSON.stringify({ error: error.message }))
    const payload = JSON.parse(wire.error.slice(wire.error.indexOf('{')))
    assert.equal(payload.code, 'AMBIGUOUS_ASSET_IP')
    assert.deepEqual(payload.ambiguities[0].candidates.map(asset => asset.assetId), [1, 2])
    return true
  })
  assert.equal(fixture.calls.length, 3)
  const explicit = await api.prepare({ scope: { ips: ['10.0.0.1'], assetIds: [1, 2] } }, config, signal)
  assert.deepEqual(explicit.scope.assetIds, [1, 2])
  const dedup = tools(async (_connection, _operation, args) => ({ code: 200, total: 2, rows: args.pageNum === 1 ? [assets[0]] : [assets[0], assets[2]] }))
  assert.deepEqual((await dedup.prepare({ scope: { ips: ['10.0.0.1'] } }, config, signal)).scope.assetIds, [1])
})

test('scope 所有筛选继续相交，部门含下级语义、CIDR IPv4/IPv6与 all 保持', async () => {
  const fixture = socFixture({ pages: true }), api = tools(fixture.soc)
  const scope = { assetIds: [1, 2, 3], ips: ['10.0.0.1'], cidrs: ['10.0.0.0/24'], assetTypes: ['host'], layerIds: ['1'], networkTiers: ['core'], deptIds: [10] }
  const frozen = await api.prepare({ scope }, config, signal)
  assert.deepEqual(frozen.scope.assetIds, [1])
  assert.deepEqual(frozen.scope.requested, scope)
  assert.ok(fixture.calls.every(call => call.args.deptId === 10))
  const { assetIds: _ids, ...withoutIds } = scope
  assert.deepEqual((await api.prepare({ scope: withoutIds }, config, signal)).scope.assetIds, [1])
  assert.deepEqual((await api.prepare({ scope: { all: true } }, config, signal)).scope.assetIds, [1, 2, 3])
  const ipv6 = socFixture({ inventory: [{ ...assets[0], ip: '2001:db8::1' }, { ...assets[2], ip: '2001:db9::1' }], pages: true })
  assert.deepEqual((await tools(ipv6.soc).prepare({ scope: { cidrs: ['2001:db8::/32'] } }, config, signal)).scope.assetIds, [1])
  await assert.rejects(api.prepare({ scope: { all: true, ips: ['10.0.0.1'] } }, config, signal), /不能与其他筛选混用/)
  await assert.rejects(api.prepare({ scope: { cidrs: ['10.0.0.1/33'] } }, config, signal), /CIDR 无效/)
  const broken = tools(async () => ({ code: 200, total: 3, rows: [assets[0]] }))
  await assert.rejects(broken.prepare({ scope: { all: true } }, config, signal), /未完整/)
})

test('ruleTypes 独立于 mode；筛选冻结、检查对及汇总结果，快照拒绝改变筛选', async () => {
  assert.deepEqual(inputSchema.properties.ruleTypes.items.enum, ['REQUIRED', 'FORBIDDEN'])
  const fixture = socFixture(), workflow = reachability(fixture.soc)
  const input = { scope: { assetIds: [1, 3] }, ruleTypes: ['FORBIDDEN'] }
  const frozen = await workflow.prepare(input, config, signal)
  assert.deepEqual(frozen.rules.map(rule => rule.id), [11])
  assert.deepEqual(frozen.scope.ruleTypes, ['FORBIDDEN'])
  const ctx = context(frozen)
  assert.deepEqual((await workflow.components.scope(input, config, ctx)).ruleTypes, ['FORBIDDEN'])
  assert.equal(workflow.components.mode(input, config, ctx).mode, 'rules')
  const generated = workflow.components.rules(input, config, ctx)
  assert.deepEqual(generated.items.map(pair => [pair.ruleId, pair.ruleType]), [[11, 'FORBIDDEN']])
  const result = workflow.components.assess({ item: generated.items[0], facts: {}, policy: 'permit' })
  assert.equal(result.status, 'abnormal')
  assert.equal(result.ruleType, 'FORBIDDEN')
  const outcome = workflow.components.summary({ items: [result] }, config, ctx)
  assert.deepEqual(outcome.scope.ruleTypes, ['FORBIDDEN'])
  assert.deepEqual(JSON.parse(workflow.artifacts(outcome)[1].body).scope.ruleTypes, ['FORBIDDEN'])
  assert.match(workflow.artifacts(outcome)[0].body, /FORBIDDEN/)
  await assert.rejects(workflow.components.scope({ ...input, ruleTypes: ['REQUIRED'] }, config, ctx), /快照/)
  for (const ruleTypes of [[], ['INVALID'], ['REQUIRED', 'REQUIRED']]) await assert.rejects(workflow.prepare({ ...input, ruleTypes }, config, signal), /ruleTypes/)
})

test('无启用或筛选后空仍返回实际缺参，合法规则无检查对则完成', async () => {
  for (const rules of [[], [{ ...required, enabled: false }], [forbidden]]) {
    const fixture = socFixture({ rules }), workflow = reachability(fixture.soc)
    await assert.rejects(workflow.prepare({ scope: { assetIds: [1, 3] }, ruleTypes: ['REQUIRED'] }, config, signal), error => {
      assert.equal(error.code, 'REACHABILITY_INPUT_REQUIRED')
      assert.deepEqual(error.details.missingFields, ['reachability.srcIp', 'reachability.dstIp'])
      assert.deepEqual(error.details.ruleTypes, ['REQUIRED'])
      const wire = JSON.parse(JSON.stringify({ error: error.message }))
      const payload = JSON.parse(wire.error.slice(wire.error.indexOf('{')))
      assert.equal(payload.code, 'REACHABILITY_INPUT_REQUIRED')
      assert.deepEqual(payload.missingFields, ['reachability.srcIp', 'reachability.dstIp'])
      return true
    })
    assert.ok(fixture.calls.every(call => !call.operation.startsWith('get_reachability_')))
  }
  for (const rule of [{ ...required, destSelector: { scope: 'ASSETS', cidrs: ['192.0.2.1'] } }, { ...required, destSelector: required.sourceSelector }]) {
    const fixture = socFixture({ rules: [rule] }), workflow = reachability(fixture.soc)
    const input = { scope: { assetIds: [1, 3] }, ruleTypes: ['REQUIRED'] }
    const frozen = await workflow.prepare(input, config, signal), ctx = context(frozen)
    const generated = workflow.components.rules(input, config, ctx)
    assert.equal(generated.items.length, 0)
    assert.equal(generated.prior[0].status, 'not_applicable')
    assert.equal(generated.prior[0].reasonCode, 'NO_MATCHING_PAIRS')
    assert.equal(generated.prior[0].complete, true)
    assert.equal(workflow.components.summary(generated, config, ctx).status, 'completed')
    assert.ok(fixture.calls.every(call => !call.operation.startsWith('get_reachability_')))
  }
})

test('规则读取失败和非法规则保留失败/未知，不冒充零规则', async () => {
  const fixture = socFixture({ rulesError: 'offline evidence' }), workflow = reachability(fixture.soc)
  const input = { scope: { assetIds: [1, 3] } }, frozen = await workflow.prepare(input, config, signal), ctx = context(frozen)
  assert.match(frozen.rules_error, /offline evidence/)
  assert.equal(workflow.components.mode(input, config, ctx).mode, 'rulesError')
  const failure = workflow.components.rulesError(input, config, ctx)
  assert.equal(failure.items[0].status, 'failed')
  assert.equal(workflow.components.summary(failure, config, ctx).status, 'incomplete')
  const malformed = reachability(socFixture({ rules: [null] }).soc)
  const malformedFrozen = await malformed.prepare(input, config, signal)
  assert.match(malformedFrozen.rules_error, /规则列表包含无效记录/)
  assert.equal(malformed.components.rulesError(input, config, context(malformedFrozen)).items[0].status, 'failed')
  const invalid = reachability(socFixture({ rules: [{ ...required, sourceSelector: { scope: 'UNKNOWN' } }] }).soc)
  const bad = await invalid.prepare(input, config, signal)
  assert.equal(invalid.components.rules(input, config, context(bad)).prior[0].status, 'unknown')
})

test('显式 REQUIRED FULL/MUST_PASS 途经意义不变，缺参只报告真正缺的字段', async () => {
  const fixture = socFixture({ rules: [] }), workflow = reachability(fixture.soc)
  const input = { scope: { assetIds: [1] }, reachability: { srcIp: '10.0.0.1', dstIp: '10.0.0.3', mode: 'MUST_PASS', via: ['7'] }, ruleTypes: ['REQUIRED'] }
  const frozen = await workflow.prepare(input, config, signal)
  assert.equal(fixture.calls.some(call => call.operation === 'get_graph_compliance_rules'), false)
  const pair = workflow.components.explicit(input).items[0]
  const path = { reachable: true, verdict: 'REACHABLE', path: ['8'] }
  assert.equal(workflow.components.evidence({ item: pair, facts: { path } }).early.status, 'abnormal')
  assert.equal(workflow.components.evidence({ item: pair, facts: { path: { ...path, path: ['7', '8'] } } }).early, undefined)
  assert.deepEqual(frozen.scope.ruleTypes, ['REQUIRED'])
  await assert.rejects(workflow.prepare({ ...input, reachability: { ...input.reachability, via: [] } }, config, signal), error => { assert.deepEqual(error.details.missingFields, ['reachability.via']); return true })
  await assert.rejects(workflow.prepare({ ...input, reachability: { srcIp: '10.0.0.1' } }, config, signal), error => { assert.deepEqual(error.details.missingFields, ['reachability.dstIp']); return true })
  await assert.rejects(workflow.prepare({ ...input, ruleTypes: ['FORBIDDEN'] }, config, signal), error => error.code === 'REACHABILITY_RULE_TYPE_CONFLICT')
})

const ready = { assetId: 1, templateId: 8, templateScopeMatched: true, memberCount: 1, applicableCount: 1, coverageReason: 'APPLICABLE_ITEMS_PRESENT', items: [{ itemId: 2, applicable: true, applicabilityReason: 'MATCHED' }] }
const report = { run: { assetId: 1, templateId: 8, passFlag: '1' } }
test('NO_TEMPLATE 按明确原因或显式null；缺模板字段不猜未绑定或失效', () => {
  const unbound = { ...ready, templateId: null, templateScopeMatched: false, memberCount: 0, applicableCount: 0, items: [], coverageReason: 'NO_TEMPLATE' }
  const result = classify(1, { run: null }, unbound)
  assert.equal(result.status, 'unknown'); assert.equal(result.reasonCode, 'NO_TEMPLATE'); assert.match(result.message, /未绑定/)
  assert.equal(classify(1, { run: null }, { ...unbound, coverageReason: undefined }).reasonCode, 'NO_TEMPLATE')
  assert.equal(classify(1, { run: null }, { ...unbound, templateId: undefined, coverageReason: undefined }).reasonCode, 'TEMPLATE_BINDING_UNVERIFIED')
  assert.equal(classify(1, report, unbound).reasonCode, 'BASELINE_EVIDENCE_CONFLICT')
  assert.equal(classify(1, { run: { assetId: 1, notCheckedReason: 'NO_TEMPLATE' } }, { ...unbound, coverageReason: undefined }).reasonCode, 'NO_TEMPLATE')
})

test('NO_DATA 只按上游明确未采集原因，冲突证据和空报告不猜失效', () => {
  const result = classify(1, { run: { assetId: 1, templateId: 8, notCheckedReason: 'NO_DATA' } }, ready)
  assert.equal(result.status, 'unknown'); assert.equal(result.reasonCode, 'NO_DATA'); assert.match(result.message, /未采集/)
  assert.equal(classify(1, { run: null }, ready).reasonCode, 'BASELINE_REPORT_MISSING')
  assert.equal(classify(1, { run: null }, { ...ready, coverageReason: 'NO_DATA' }).reasonCode, 'NO_DATA')
  assert.equal(classify(1, { run: { ...report.run, notCheckedReason: 'NO_DATA' } }, ready).reasonCode, 'BASELINE_EVIDENCE_CONFLICT')
  assert.equal(classify(1, { run: { assetId: 1, templateId: 9, notCheckedReason: 'NO_DATA' } }, ready).reasonCode, 'BASELINE_TEMPLATE_MISMATCH')
  assert.equal(classify(1, { run: { assetId: 1, templateId: 8, notCheckedReason: 'DISABLED' } }, { ...ready, coverageReason: 'NO_DATA' }).reasonCode, 'BASELINE_EVIDENCE_CONFLICT')
})

test('基线五种既有状态兼容，原因明确且部分接口失败保留已有事实', () => {
  assert.equal(classify(1, report, ready).status, 'normal')
  assert.equal(classify(1, report, ready).reasonCode, 'BASELINE_PASSED')
  assert.equal(classify(1, { run: { ...report.run, passFlag: '0' } }, ready).status, 'abnormal')
  assert.equal(classify(1, report, { ...ready, templateId: 9 }).status, 'unknown')
  const na = classify(1, { run: { assetId: 1, templateId: 8, notCheckedReason: 'NO_APPLICABLE_ITEM' } }, { ...ready, assetType: 'host', applicableCount: 0, coverageReason: 'NO_APPLICABLE_ITEM', items: [{ itemId: 2, applicable: false, applicabilityReason: 'ASSET_SCOPE_NOT_MATCHED' }] })
  assert.equal(na.status, 'not_applicable'); assert.equal(na.reasonCode, 'NO_APPLICABLE_ITEM')
  const workflow = baseline(() => { throw new Error('assess 不得调用上游') })
  const failed = workflow.components.assess({ item: assets[0], report: { data: report }, readiness: { error: 'offline evidence' } })
  assert.equal(failed.status, 'failed'); assert.equal(failed.reasonCode, 'BASELINE_READ_FAILED'); assert.deepEqual(failed.facts.report, report)
  assert.equal(summary('baseline', [failed], context({ scope: { assetIds: [1] } })).status, 'incomplete')
})
