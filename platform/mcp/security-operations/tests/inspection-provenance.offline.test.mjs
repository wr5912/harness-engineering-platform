import test from 'node:test'
import assert from 'node:assert/strict'
import { assetItem, summary } from '../src/inspection/index.ts'
import { create } from '../compositions/inspection-vulnerabilities/src/index.ts'
import { renderInspectionReport } from '../src/reports/inspection.ts'
import { create as routine } from '../compositions/inspection-routine/src/index.ts'
import { create as deep } from '../compositions/inspection-deep/src/index.ts'

test('常规深度传递真实身份与连接，终态不从业务完成状态推断', () => {
  const config = { connections: { master: 'ai-soc-master', ingest: 'ai-soc-ingest', graph: 'ai-soc-graph' } }
  const context = { runId: 'offline-run-metadata', shared: { scope: { count: 1, assetIds: [1] } } }
  const check = { kind: 'status', status: 'incomplete', counts: { normal: 0, abnormal: 0, unknown: 1, failed: 0, not_applicable: 0 }, items: [{ assetId: 1, status: 'unknown' }] }
  for (const factory of [routine, deep]) {
    const workflow = factory(() => { throw new Error('禁止上游') })
    const result = workflow.components.summary({ status: check, baseline: check, reachability: check, routine: { checks: { status: check } }, vulnerabilities: check }, config, context)
    assert.equal(result.run_id, context.runId)
    assert.equal(result.execution_status, 'completed')
    assert.equal(Object.hasOwn(result, 'items'), false)
    const html = workflow.artifacts(result).find(artifact => artifact.id === 'report').body
    for (const id of Object.values(config.connections)) assert.ok(html.includes(id))
    assert.doesNotMatch(html, /报告生成时未取得外层终态回执/)
    assert.match(html, /实际读取失败、未执行、主体冲突或必需证据缺失才计缺口/)
    assert.doesNotMatch(html, /结构缺口为0不代表没有业务证据缺口/)
    assert.doesNotMatch(html, /其中 0 条为展示层显式揭示的缺口/)
  }
})

test('读取数包含unknown，不冒充明确判定；零failed仍incomplete', () => {
  for (const [normal, abnormal, unknown] of [[11, 1, 5], [10, 1, 6]]) {
    const items = ['normal', 'abnormal', 'unknown'].flatMap((status, i) => Array.from({ length: [normal, abnormal, unknown][i] }, () => ({ status })))
    const result = summary('status', items, { shared: { scope: { count: 17 } }, runId: 'offline' })
    assert.equal(result.items.length, 17)
    assert.equal(result.counts.normal + result.counts.abnormal, 17 - unknown)
    assert.equal(result.counts.failed, 0)
    assert.equal(result.status, 'incomplete')
  }
})

test('宿主直接子资产来源在零观测时仍保留至JSON与HTML', () => {
  const workflow = create(() => { throw new Error('离线禁止上游') })
  const asset = { assetId: 2, hostAssetId: 1, ip: '192.0.2.2' }
  assert.equal(assetItem(asset, {}).hostAssetId, 1)
  const item = workflow.components.assess({ asset: { assetId: 1 }, errors: [], items: [
    { assetId: 1, observed_at: '2026-11-10T06:46:32Z', records: [] },
    { assetId: 2, hostAssetId: 1, observed_at: '2026-11-10T06:46:32Z', records: [] },
  ] })
  assert.equal(item.status, 'normal')
  assert.equal(item.sources[1].hostAssetId, 1)
  assert.deepEqual(item.findings, [])
  const html = renderInspectionReport({ kind: 'vulnerabilities', scope: { count: 1 }, status: 'incomplete', items: [item] })
  assert.match(html, /hostAssetId/)
  assert.match(html, /没有漏洞/)
  assert.doesNotMatch(html, /空返回不证明|不证明扫描覆盖.*无漏洞/)
})

test('单项summary连接身份通过安全投影进入HTML', () => {
  const result = summary('status', [{ assetId: 1, status: 'unknown' }], { runId: 'offline-single', shared: { scope: { count: 1 }, connection_fingerprints: { 'ai-soc-master': 'fixture' } } })
  assert.match(renderInspectionReport(result), /ai-soc-master/)
})

test('真实格式子资产经完整读取保留直接关系，空漏洞为正常', async () => {
  const calls = []
  const workflow = create(async (_connection, operation, args) => {
    calls.push(operation)
    if (operation === 'get_soc_asset_registration_children') return { code: 200, data: { rows: [{ assetId: 2, hostAssetId: 1 }], total: 1 } }
    if (operation === 'get_soc_asset_vulnerabilities') return { code: 200, rows: [] }
    throw new Error(`禁止未声明操作 ${operation}`)
  })
  const context = { runId: 'offline-relationship', shared: {}, signal: new AbortController().signal, call: fn => fn() }
  const config = { connections: { master: 'mock-master' } }
  const children = await workflow.components.children({ item: { assetId: 1 } }, config, context)
  const items = []
  for (const item of children.items) items.push(await workflow.components.observations({ item }, config, context))
  const result = workflow.components.assess({ ...children, items })
  assert.deepEqual(calls, ['get_soc_asset_registration_children', 'get_soc_asset_vulnerabilities', 'get_soc_asset_vulnerabilities'])
  assert.equal(result.sources.find(item => item.assetId === 2).hostAssetId, 1)
  assert.equal(result.status, 'normal')
  assert.match(renderInspectionReport({ kind: 'vulnerabilities', scope: { count: 1 }, items: [result] }), /hostAssetId/)
})

test('缺关系来源不靠汇总位置猜直接子资产', () => {
  const workflow = create(() => { throw new Error('离线禁止上游') })
  const result = workflow.components.assess({ asset: { assetId: 1 }, errors: [], items: [{ assetId: 2, records: [] }] })
  assert.equal(result.status, 'failed')
  assert.equal(result.sources.length, 0)
  assert.match(result.errors.join(' '), /归属不一致/)
})
