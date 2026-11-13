import test from 'node:test'
import assert from 'node:assert/strict'
import { renderTroubleshootingReport } from './troubleshooting.ts'
import { buildConclusion } from './conclusion.ts'

// 形状取自真实离线 Run run-aba78e28（仅用其结构做渲染回归，不冒充新实测）。
const shared = {
  kind: 'device-offline', run_id: 'run-aba78e28-4be0-4f25-aaee-2ccbc3bed80d', status: 'incomplete', conclusion: 'inconclusive',
  terminal: 'evidence-loop-stopped', generated_at: new Date(0).toISOString(),
  scope: { requested: { asset: { ip: '172.16.1.10' } }, asset: { ip: '172.16.1.10' } },
  items: [
    { check: 'resolve', id: 'a', node_id: 'root/execute', run_id: 'run-x', status: 'observed', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [] },
    { check: 'soc-state', id: 'b', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [] },
    { check: 'management-observation', id: 'c', node_id: 'root/execute', run_id: 'run-x', status: 'unavailable', execution_status: 'not_executed', observed_at: null,
      gaps: [{ check: 'management-observation', status: 'unavailable', reason: '未核得当前管理侧电源/系统/网卡观察原子；SOC标签和历史探测不能替代本次真实响应' }], raw_receipt_refs: [] },
  ],
  causes: [{ id: 'device-offline', title: '设备当前离线', status: 'unknown', support: { evidence_ids: [] }, refutation: { evidence_ids: [] } }],
  gaps: ['未核得当前管理侧电源/系统/网卡观察原子；SOC标签和历史探测不能替代本次真实响应', '未核得当前管理侧电源/系统/网卡观察原子；SOC标签和历史探测不能替代本次真实响应'],
}
const report = { ...shared, unified_conclusion: buildConclusion(shared) }

test('真实形状渲染：授权文本、未执行、无数据、部分失败共存均不丢', () => {
  const html = renderTroubleshootingReport(report)
  assert.match(html, /授权：需宿主管理面只读账号/)
  assert.equal(/授权：—/.test(html), false)
  assert.match(html, /未执行：management-observation/)
  assert.match(html, /有数据但证据不足：soc-state/)
  assert.match(html, /失败：无/)
  assert.match(html, /能力不可用：无/)
  assert.match(html, /未执行：management-observation/)
  assert.match(html, /部分失败与未覆盖/)
  assert.ok(html.includes('根因尚未确认'))
})

test('首要建议具体到责任方与可执行步骤，不出现“补齐证据/一线值班”泛化', () => {
  const html = renderTroubleshootingReport(report)
  assert.match(html, /虚拟化\/宿主平台责任方/)
  assert.match(html, /宿主平台管理员/)
  assert.doesNotMatch(html, /在责任边界内补齐尚未取得的只读证据/)
  assert.match(html, /完成标准：/)
  assert.match(html, /复验：/)
})

test('根因缺口去重，重复来源只出现一次', () => {
  const html = renderTroubleshootingReport(report)
  const hits = (html.match(/未核得当前管理侧电源\/系统\/网卡观察原子/g) ?? []).length
  assert.ok(hits >= 1)
  assert.equal(report.unified_conclusion.rootCause.gaps.filter(g => String(typeof g === 'string' ? g : g?.reason).includes('未核得当前管理侧')).length, 1)
})

test('旧报告无 unified_conclusion 时保持兼容并明确提示', () => {
  const legacy = { ...shared }
  delete legacy.unified_conclusion
  const html = renderTroubleshootingReport({ ...legacy, unified_conclusion: undefined })
  assert.match(html, /未包含统一结论对象/)
})

test('授权说明可展示，但真实 Authorization/cookie/token/API Key 必须继续脱敏', () => {
  const withSecrets = {
    ...report,
    unified_conclusion: { ...report.unified_conclusion,
      primaryRecommendation: { ...report.unified_conclusion.primaryRecommendation, authorization: '无需变更授权；仅只读' } },
    headers: { authorization: 'Bearer sk-live-abc123', cookie: 'session=xyz', 'x-api-key': 'key-999' },
    items: [...report.items, { check: 'portEvidence', id: 'z', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed',
      observed_at: null, gaps: [], raw_receipt_refs: [], authorization: 'Bearer leaked-token-1' }],
  }
  const html = renderTroubleshootingReport(withSecrets)
  assert.match(html, /授权：无需变更授权；仅只读/)
  for (const secret of ['sk-live-abc123', 'session=xyz', 'key-999', 'leaked-token-1']) assert.equal(html.includes(secret), false, secret)
})

test('真实Run形状：双端身份成功不产生虚假身份缺口；非空unknown进inconclusive而非noData', () => {
  const runShape = {
    kind: 'business-access', run_id: 'run-c129854e-6179-4295-bfdb-8dd662a0c1bc', status: 'incomplete', conclusion: 'inconclusive', terminal: 'evidence-loop-stopped',
    scope: { source: { assetId: 3617426, ip: '172.16.138.226' }, target: { assetId: 3617438, ip: '172.16.1.160' }, protocol: 'tcp', port: 8834 },
    items: [
      { check: 'unique-endpoints', id: 'f0', node_id: 'root/resolve', run_id: 'run-x', status: 'observed', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [], evidence: { identity: { source: 'resolved', target: 'resolved' } } },
      { check: 'source-soc-state', id: 'f1', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [], evidence: { online: true, stateEvidence: { signals: [{ supportsOnline: true }] } } },
      { check: 'target-soc-state', id: 'f2', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [], evidence: { online: true, stateEvidence: { signals: [] } } },
      { check: 'portEvidence', id: 'f3', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [], evidence: { status: 'NO_RECORD' } },
      { check: 'pathEvidence', id: 'f4', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [], evidence: { status: 'AVAILABLE', trafficEvidence: { hops: [], gaps: ['未确认同一会话'] }, candidatePolicies: [{ applicability: 'NOT_CONFIRMED' }] } },
      { check: 'routeEvidence', id: 'f5', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [], evidence: { status: 'UNKNOWN', candidates: [] } },
      { check: 'policyEvidence', id: 'f6', node_id: 'root/execute', run_id: 'run-x', status: 'unknown', execution_status: 'completed', observed_at: null, gaps: [], raw_receipt_refs: [], evidence: { status: 'AVAILABLE', exact: [], destination: [] } },
    ],
    causes: [{ id: 'service-not-listening', title: '服务未监听', status: 'unknown', support: { evidence_ids: [] }, refutation: { evidence_ids: [] } }],
    gaps: [],
  }
  const conclusion = buildConclusion(runShape)
  const identity = runShape.items[0]
  const idGaps = (conclusion.rootCause.gaps ?? []).filter(g => String(typeof g === 'string' ? g : g?.reason).includes('未在当前SOC台账唯一匹配'))
  assert.equal(idGaps.length, 0, '双端成功不得有虚假身份缺口')
  assert.equal(identity.status, 'observed')
  const pf = conclusion.partialFailures
  assert.ok(pf.noData.includes('portEvidence'))
  assert.ok(pf.noData.includes('routeEvidence'))
  assert.ok(pf.noData.includes('policyEvidence'))
  assert.ok(!pf.successNoMatch.includes('source-soc-state'))
  assert.ok(!pf.successNoMatch.includes('pathEvidence'))
  assert.ok(pf.unknownEvidence.includes('source-soc-state'))
  assert.ok(pf.unknownEvidence.includes('target-soc-state'))
  assert.ok(pf.unknownEvidence.includes('pathEvidence'))
  const html = renderTroubleshootingReport({ ...runShape, unified_conclusion: conclusion })
  assert.match(html, /有数据但证据不足：source-soc-state、target-soc-state、pathEvidence/)
  assert.doesNotMatch(html, /无匹配\/无数据：[^<]*pathEvidence/)
})

test('五类部分失败共存的实际渲染：分别展示、对象项取check、无[object Object]', () => {
  const base = {
    kind: 'business-access', run_id: 'run-five-ways', status: 'incomplete', conclusion: 'inconclusive', terminal: 'evidence-loop-stopped',
    scope: { source: { ip: '172.16.138.226', assetId: 3617426 }, target: { ip: '172.16.1.160', assetId: 3617438 }, protocol: 'tcp', port: 8834 },
    items: [
      { check: 'unique-endpoints', id: 'i0', node_id: 'root/resolve', run_id: 'run-five-ways', status: 'observed', execution_status: 'completed', gaps: [], raw_receipt_refs: [] },
      { check: 'pathEvidence', id: 'i1', node_id: 'root/execute', run_id: 'run-five-ways', status: 'failed', execution_status: 'failed', gaps: [], raw_receipt_refs: [], error: 'HTTP 503' },
      { check: 'management-observation', id: 'i2', node_id: 'root/execute', run_id: 'run-five-ways', status: 'unavailable', execution_status: 'completed', gaps: [], raw_receipt_refs: [] },
      { check: 'alerts', id: 'i3', node_id: 'root/execute', run_id: 'run-five-ways', status: 'unknown', execution_status: 'not_executed', gaps: [], raw_receipt_refs: [] },
      { check: 'portEvidence', id: 'i4', node_id: 'root/execute', run_id: 'run-five-ways', status: 'unknown', execution_status: 'completed', gaps: [], raw_receipt_refs: [], evidence: { status: 'NO_RECORD' } },
      { check: 'source-soc-state', id: 'i5', node_id: 'root/execute', run_id: 'run-five-ways', status: 'unknown', execution_status: 'completed', gaps: [], raw_receipt_refs: [], evidence: { online: true, stateEvidence: { signals: [] } } },
    ],
    causes: [{ id: 'service-not-listening', title: 'x', status: 'unknown', support: { evidence_ids: [] }, refutation: { evidence_ids: [] } }],
    gaps: [],
  }
  const html = renderTroubleshootingReport({ ...base, unified_conclusion: buildConclusion(base) })
  assert.match(html, /失败：pathEvidence/)
  assert.match(html, /能力不可用：management-observation/)
  assert.match(html, /未执行：alerts/)
  assert.match(html, /无记录\/成功无精确匹配：portEvidence/)
  assert.match(html, /有数据但证据不足：source-soc-state/)
  assert.equal(html.includes('[object Object]'), false)
})
