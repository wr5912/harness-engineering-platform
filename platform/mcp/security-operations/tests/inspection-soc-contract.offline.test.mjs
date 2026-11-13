import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyStatus } from '../src/inspection/status.ts'
import { classify } from '../compositions/inspection-baseline/src/index.ts'
import { create } from '../compositions/inspection-vulnerabilities/src/index.ts'
import { summary, artifacts } from '../src/inspection/index.ts'

globalThis.fetch = () => { throw new Error('离线测试禁止网络') }
test('SOC状态权威：offline缺心跳或证据冲突仍离线，online同理', () => {
  for (const online of ['offline', 'online']) {
    const result = classifyStatus({ online, lastSeenAt: null, stateEvidence: { online: 'unknown', evaluatedAt: 'invalid', signals: [] } })
    assert.equal(result.status, online === 'offline' ? 'abnormal' : 'normal')
    assert.equal(result.message, online === 'offline' ? '离线' : '在线')
    assert.equal(result.facts.online, online)
  }
  assert.equal(classifyStatus({ online: 'unknown' }).message, 'SOC未采集到状态数据')
})

test('NO_TEMPLATE与NO_DATA精确分开，不成为通过', () => {
  const ready = { assetId: 1, items: [], memberCount: 0, applicableCount: 0, templateScopeMatched: false, templateId: null, coverageReason: 'NO_TEMPLATE' }
  const missing = classify(1, { templateId: null, run: null }, ready)
  assert.equal(missing.reasonCode, 'NO_TEMPLATE')
  assert.equal(missing.message, '设备未绑定基线模板')
  const noData = classify(1, { run: { assetId: 1, templateId: 2, notCheckedReason: 'NO_DATA' } }, { ...ready, templateId: 2, templateScopeMatched: true, memberCount: 1, applicableCount: 1, items: [{ itemId: 1, applicable: true, applicabilityReason: 'MATCHED' }], coverageReason: 'NO_DATA' })
  assert.equal(noData.message, 'SOC未采集到基线数据')
  assert.equal(noData.status, 'unknown')
  assert.equal(missing.status, 'unknown')
  const html = artifacts(summary('baseline', [missing, noData].map((item, i) => ({ ...item, assetId: i + 1 })), { runId: 'offline', shared: { scope: { count: 2 } } }))[0].body
  assert.match(html, /设备未绑定基线模板 1 台/)
  assert.match(html, /SOC未采集到基线数据 1 台/)
  // 明确业务状态不再混入未完成 KPI，也不强输出“无明确结论分母”作为本次结论。
  assert.match(html, /实际未知、失败或冲突 0 台/)
  assert.match(html, /仍有实际读取失败、未执行或必需证据不足的设备 0 台/)
  assert.match(html, /未绑定 1 台 \/ 未采集 1 台/)
  assert.doesNotMatch(html, /无明确结论分母/)
})

for (const mode of ['empty', 'findings', 'network', 'parse', 'incomplete']) test(`漏洞完整读取分支 ${mode}`, async () => {
  const workflow = create(async () => {
    if (mode === 'network') throw new Error('403 forbidden')
    if (mode === 'parse') return { code: 200, data: null }
    return { code: 200, rows: mode === 'findings' ? [{ cveId: 'CVE-offline-test' }] : [] }
  })
  const context = { runId: `offline-${mode}`, shared: {}, signal: new AbortController().signal, call: fn => fn() }
  const observation = await workflow.components.observations({ item: { assetId: 1 } }, { connections: { master: 'mock' } }, context)
  const result = workflow.components.assess({ asset: { assetId: 1 }, errors: mode === 'incomplete' ? ['子资产分页不完整'] : [], items: [observation] })
  assert.equal(result.status, mode === 'empty' ? 'normal' : mode === 'findings' ? 'abnormal' : 'failed')
  if (mode === 'empty') assert.equal(result.message, '没有漏洞')
  else assert.notEqual(result.message, '没有漏洞')
  const report = summary('vulnerabilities', [result], { ...context, shared: { scope: { count: 1, assetIds: [1] } } })
  const html = artifacts(report)[0].body
  assert.doesNotMatch(html, /空返回不证明|不证明扫描覆盖.*资产无漏洞/)
  if (mode === 'empty') assert.match(html, /没有漏洞/)
  else if (mode !== 'findings') assert.match(html, /读取未完成/)
})
