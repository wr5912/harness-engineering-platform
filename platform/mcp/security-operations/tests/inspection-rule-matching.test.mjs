import assert from 'node:assert/strict'
import test from 'node:test'
import { applicableRule, matches } from '../src/inspection/index.ts'
import { create } from '../compositions/inspection-reachability/src/index.ts'

// 离线 fixture：仅 mock 公开 SOC 操作，不访问真实 SOC 或创建平台 Run。
const config = { connections: { master: 'master', graph: 'graph' } }
const layers = [
  ...['core', 'aggregation', 'access', 'unclassified'].map((code, index) => ({ id: index + 1, code, category: 'network_tier', type: 'built_in' })),
  { id: 328, code: 'dept_100', category: 'dept', type: 'custom' },
]
const selector = networkTier => ({ scope: 'ASSETS', networkTiers: [networkTier] })
const rules = [
  { id: 1, enabled: true, builtIn: true, ruleType: 'FORBIDDEN', sourceSelector: selector('dmz'), destSelector: selector('core'), selectorIssues: [{ side: 'source', code: 'dmz', reason: 'LAYER_NOT_FOUND' }] },
  { id: 2, enabled: true, builtIn: true, ruleType: 'FORBIDDEN', sourceSelector: selector('access'), destSelector: selector('core') },
  { id: 3, enabled: true, builtIn: true, ruleType: 'FORBIDDEN', sourceSelector: selector('dmz'), destSelector: { scope: 'ASSETS', assetTypes: ['database'] }, selectorIssues: [{ side: 'source', code: 'dmz', reason: 'LAYER_NOT_FOUND' }] },
]
const assets = Array.from({ length: 21 }, (_, index) => ({ assetId: 9106 + index, ip: `10.0.0.${index + 1}`, assetType: index === 1 ? 'database' : 'host', networkTier: index === 0 ? 'core' : null, layerId: index === 0 ? 1 : index % 2 ? 4 : null, ...(index === 2 ? { hostAssetId: 9106 } : {}) }))
function fixture({ inventory = assets, policyRules = rules, directory = layers, layerError, pages } = {}) {
  const calls = [], workflow = create(async (connection, operation, args) => {
    calls.push({ connection, operation, args })
    if (operation === 'list_soc_asset') return pages ? { code: 200, total: inventory.length, rows: pages[args.pageNum - 1] ?? [] } : { code: 200, total: inventory.length, rows: inventory }
    if (operation === 'get_graph_compliance_rules') return { code: 200, data: policyRules }
    if (operation === 'list_soc_layer') { if (layerError) throw new Error(layerError); return { code: 200, data: directory } }
    if (operation === 'get_reachability_path_by_ip') return { code: 200, data: { reachable: true, verdict: 'REACHABLE', path: ['100'] } }
    if (operation === 'get_reachability_acl_hit') return { code: 200, data: { hops: [{ deviceId: 100, verdict: 'PERMIT' }] } }
    throw new Error(`Unexpected operation: ${operation}`)
  })
  const context = { signal: new AbortController().signal, call: call => call(), runId: 'offline-fixture' }
  return { calls, workflow, context, async prepare(input = { scope: { all: true } }) { context.shared = await workflow.prepare(input, config, context.signal); return workflow.components.rules(input, config, context) } }
}

test('当前三条合法规则与21资产完整取数：无匹配 completed，不请求路径', async () => {
  const mock = fixture(), result = await mock.prepare()
  assert.equal(mock.context.shared.assets.length, 21)
  assert.equal(mock.context.shared.assets[2].hostAssetId, 9106)
  assert.equal(mock.context.shared.assets[2].networkTier, null)
  assert.equal(result.items.length, 0)
  assert.equal(result.prior.length, 3)
  for (const item of result.prior) {
    assert.equal(item.status, 'not_applicable')
    assert.equal(item.reasonCode, 'NO_MATCHING_PAIRS')
    assert.equal(item.complete, true)
    assert.equal(item.message, '本次范围无匹配对象/无适用检查对')
  }
  const report = mock.workflow.components.summary({ prior: result.prior, items: [] }, config, mock.context)
  assert.equal(report.status, 'completed')
  assert.equal(mock.calls.filter(call => call.operation === 'list_soc_layer').length, 1)
  assert.equal(mock.calls.some(call => call.operation.includes('reachability')), false)
  assert.ok(mock.context.shared.layers_observed_at)
})

test('layerId仅通过冻结network_tier code匹配，不匹配部门或猜中文、不继承宿主', () => {
  assert.equal(matches({ layerId: 3, networkTier: null }, selector('access'), layers), true)
  assert.equal(matches({ layerId: 328 }, selector('dept_100'), layers), false)
  assert.equal(matches({ layerId: 4, hostname: '接入层' }, selector('access'), layers), false)
  assert.equal(matches({ hostAssetId: 9106 }, selector('core'), layers), false)
  assert.equal(matches({ networkTier: 'access' }, selector('access'), layers), true)
  assert.equal(matches({ layerId: 4 }, selector('dmz'), layers), false)
  assert.throws(() => matches({ layerId: 3 }, selector('access')), /目录未成功冻结/)
  for (const rule of rules) assert.doesNotThrow(() => applicableRule(rule))
})

test('合法layerId匹配产生检查对并进入既有路径和ACL', async () => {
  const mock = fixture({ inventory: [assets[0], { assetId: 9200, ip: '10.0.0.100', networkTier: null, layerId: 3 }] })
  const result = await mock.prepare()
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].ruleId, 2)
  let value = await mock.workflow.components.path({ item: result.items[0] }, config, mock.context)
  value = mock.workflow.components.evidence(value)
  value = await mock.workflow.components.acl(value, config, mock.context)
  assert.equal(mock.workflow.components.assess(value).status, 'abnormal')
  assert.equal(mock.calls.filter(call => call.operation === 'get_reachability_path_by_ip').length, 1)
  assert.equal(mock.calls.filter(call => call.operation === 'get_reachability_acl_hit').length, 1)
})

test('目录读取失败保留具体缺口，不假装无匹配或规则非法', async () => {
  const mock = fixture({ layerError: 'layer upstream unavailable' }), result = await mock.prepare()
  assert.equal(result.items.length, 0)
  assert.equal(result.prior.length, 3)
  assert.ok(result.prior.every(item => item.status === 'failed' && item.reasonCode === 'NETWORK_LAYER_READ_FAILED' && item.complete === false))
  assert.match(result.prior[0].error, /master\/list_soc_layer.*layer upstream unavailable/)
  assert.equal(mock.context.shared.layers, undefined)
  assert.equal(mock.calls.some(call => call.operation.includes('reachability')), false)
})

test('无需networkTiers不读取层目录；同IP无检查对仍完成', async () => {
  const all = { scope: 'ALL' }, rule = { id: 4, enabled: true, ruleType: 'FORBIDDEN', sourceSelector: all, destSelector: all }
  const mock = fixture({ inventory: [assets[0]], policyRules: [rule] }), result = await mock.prepare()
  assert.equal(result.prior[0].status, 'not_applicable')
  assert.equal(result.prior[0].complete, true)
  assert.equal(result.items.length, 0)
  assert.equal(mock.calls.some(call => call.operation === 'list_soc_layer'), false)
})

test('无规则仍保留既有输入约束；早期范围guard先于取数', async () => {
  const mock = fixture({ policyRules: [] })
  await assert.rejects(mock.prepare(), /REACHABILITY_INPUT_REQUIRED/)
  const guarded = fixture()
  await assert.rejects(guarded.prepare({ scope: { all: true, assetIds: [9106] } }), /全部资产不能与其他筛选混用/)
  assert.equal(guarded.calls.length, 0)
})

test('资产继续完整分页，ruleTypes过滤后只冻结需要的目录', async () => {
  const mock = fixture({ pages: [assets.slice(0, 10), assets.slice(10)] })
  const result = await mock.prepare({ scope: { all: true }, ruleTypes: ['FORBIDDEN'] })
  assert.equal(result.prior.length, 3)
  assert.deepEqual(mock.calls.filter(call => call.operation === 'list_soc_asset').map(call => call.args), [1, 2].map(pageNum => ({ pageNum, pageSize: 200, includeUnits: true })))
  const filtered = fixture()
  await assert.rejects(filtered.prepare({ scope: { all: true }, ruleTypes: ['REQUIRED'] }), /REACHABILITY_INPUT_REQUIRED/)
  assert.equal(filtered.calls.some(call => call.operation === 'list_soc_layer'), false)
})

test('无法解读条件保留unknown，不误报规则非法或无匹配', async () => {
  const mock = fixture({ policyRules: [{ ...rules[1], sourceSelector: { scope: 'ASSETS', bizIds: [1] } }] })
  const result = await mock.prepare()
  assert.equal(result.prior[0].status, 'unknown')
  assert.match(result.prior[0].message, /无法解析/)
  assert.equal(result.items.length, 0)
})
