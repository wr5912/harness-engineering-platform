import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInspectionOperations, renderInspectionMarkdown, renderInspectionChatMarkdown, renderInspectionMarkdownDetailed, renderInspectionOperationsHtml } from '../src/reports/inspection-operations.ts'
import { renderInspectionReport } from '../src/reports/inspection.ts'

// 全部夹具独立定义，既不引用组合私有实现，也不调用SOC或运行扫描。
globalThis.fetch = () => { throw new Error('离线报告测试不得联网') }
const section = (kind, items) => ({ kind, items })
const completeSection = (kind, items) => ({ kind, items, status: 'completed', counts: { normal: 0, abnormal: 0, unknown: 0, not_applicable: 0, failed: 0 } })
const result = () => ({
  kind: 'deep', report_id: 'report-offline-1', run_id: 'run-offline-1',
  scope: { count: 4, assetIds: [1, 2, 3, 4], frozen_at: '2026-11-04T01:00:00Z' },
  checks: {
    status: section('status', [
      { assetId: 1, hostname: '共享名字', ip: '192.0.2.1', status: 'normal', facts: { online: 'offline', stateEvidence: { online: 'online' }, lastProbeAt: '2026-11-03T00:00:00Z' }, message: '不能覆盖权威SOC状态' },
      { assetId: 2, hostname: '共享名字', ip: '192.0.2.1', status: 'abnormal', facts: { online: 'online' } },
      { assetId: 3, hostname: '无效地址设备', ip: 'any', status: 'unknown', facts: { online: 'unknown' } },
      { assetId: 4, hostname: '正常设备', ip: '192.0.2.4', status: 'normal', facts: { online: 'online' } },
    ]),
    baseline: section('baseline', [
      { assetId: '01', status: 'unknown', reasonCode: 'NO_TEMPLATE', message: '错误旧词' },
      { assetId: 2, status: 'unknown', reasonCode: 'NO_DATA' },
      { assetId: 3, status: 'unknown', reasonCode: 'NO_TEMPLATE' },
      { assetId: 4, status: 'normal', reasonCode: 'BASELINE_PASSED', message: '本机报告达标' },
    ]),
    vulnerabilities: section('vulnerabilities', [
      { assetId: 1, status: 'abnormal', coverage: 'existing_records_only', findings: [
        { identity: 'CVE-TEST-1', observations: [
          { sourceAssetId: 1, record: { cveId: 'CVE-TEST-1', severity: '原严重度-X', score: 0, recommendation: '升级建议-1', software: '产品A', version: '1.0', password: '秘密不可公开' } },
          { sourceAssetId: 101, record: { cveId: 'CVE-TEST-1', riskLevel: 99, recommendation: '原建议-2', description: '子资产独立记录', token: 'secret' } },
        ] },
        { identity: 'CVE-TEST-2', observations: [{ sourceAssetId: 1, record: { cveId: 'CVE-TEST-2', severity: '未分级', solution: '厂商原方案', observedAt: '2026-10-01T00:00:00Z' } }] },
      ] },
      { assetId: 4, status: 'normal', message: '没有漏洞', findings: [], errors: [], coverage: 'existing_records_only' },
    ]),
    reachability: section('reachability', [
      { ruleId: 'R1', ruleName: '禁止访问', ruleType: 'FORBIDDEN', srcIp: '192.0.2.1', dstIp: '192.0.2.4', port: 443, protocol: 'tcp', status: 'abnormal', message: '模型显示二层直达；未执行应用实测', facts: { path: { reachable: true, reason: '模型路径' } } },
      { ruleId: 'R1', ruleName: '禁止访问', ruleType: 'FORBIDDEN', srcIp: '192.0.2.4', dstIp: '192.0.2.9', status: 'normal', message: '模型策略符合' },
      { ruleId: 'R2', ruleName: '缺少图层', status: 'unknown', reasonCode: 'LAYER_MISSING', message: '缺少图层' },
    ]),
  },
})

test('按稳定assetId跨检查归并，不以同名、共享IP合并；SOC字段权威', () => {
  const model = buildInspectionOperations(result())
  assert.equal(model.devices.length, 4)
  assert.equal(model.devices[0].assetId, '1')
  assert.equal(model.devices[0].checks.length, 3)
  assert.equal(model.devices[0].online, 'offline')
  assert.equal(model.devices[1].online, 'online')
  assert.equal(model.devices[1].abnormal, false)
  assert.deepEqual(model.abnormalDevices.map(d => d.assetId), ['1'])
  assert.equal(model.counts.offlineDevices, 1)
  assert.equal(model.counts.rules, 2)
  assert.equal(model.rules[0].checks.length, 2)
  assert.equal(model.counts.abnormalRules, 1)
  assert.deepEqual(model.rules[0].deviceIds, ['asset:4']) // 共享IP不产生错误关联
  assert.ok(model.devices[0].problems.includes('设备未绑定基线模板'))
  assert.match(model.devices[0].problems.join('；'), /历史漏洞3条/)
  assert.deepEqual(buildInspectionOperations(result()), model)
})

test('无ID条目不能仅凭同IP或同名合并，且不能冒充已知稳定资产', () => {
  const model = buildInspectionOperations({ kind: 'baseline', items: [
    { assetId: 'a-1', hostname: '同名', ip: '192.0.2.1', status: 'normal' },
    { hostname: '同名', ip: '192.0.2.1', status: 'unknown', reasonCode: 'NO_TEMPLATE' },
    { hostname: '同名', ip: '192.0.2.1', status: 'unknown', reasonCode: 'NO_DATA' },
  ] })
  assert.equal(model.devices.length, 3)
  assert.equal(model.devices[0].assetId, 'a-1')
  assert.equal(new Set(model.devices.map(d => d.id)).size, 3)
  assert.equal(model.abnormalDevices.length, 0)
})

test('any及SOC状态精确措辞；独立分组不计缺口或异常', () => {
  const model = buildInspectionOperations(result())
  assert.equal(model.devices[2].address, '地址待核实（源值：any）')
  assert.deepEqual(model.devices[2].problems, ['SOC未采集到状态数据', '设备未绑定基线模板'])
  const groups = Object.fromEntries(model.socStateGroups.map(g => [g.reason, g]))
  assert.deepEqual(groups.NO_TEMPLATE.deviceIds, ['asset:1', 'asset:3'])
  assert.equal(groups.NO_DATA.label, 'SOC未采集到基线数据')
  assert.equal(groups.SOC_STATUS_UNKNOWN.label, 'SOC未采集到状态数据')
  assert.deepEqual(model.gapGroups.find(g => g.reason === 'LAYER_MISSING').ruleIds, ['rule:R2'])
  assert.equal(model.counts.gapDevices, 0)
  assert.ok(model.gapGroups.every(g => !['NO_TEMPLATE', 'NO_DATA', 'SOC_STATUS_UNKNOWN'].includes(g.reason)))
})

test('全部漏洞observations保留，不把同CVE、数值0或未知严重度重分级；业务投影去除凭据', () => {
  const model = buildInspectionOperations(result()), records = model.devices[0].vulnerabilities
  assert.equal(records.length, 3)
  assert.equal(records[0].record.severity, '原严重度-X')
  assert.equal(records[0].record.score, 0)
  assert.equal(records[0].record.recommendation, '升级建议-1')
  assert.equal(records[1].record.riskLevel, 99)
  assert.equal(records[1].sourceAssetId, '101')
  assert.equal(records[2].record.solution, '厂商原方案')
  assert.equal(records[0].record.password, undefined)
  assert.equal(records[1].record.token, undefined)
  assert.equal(model.counts.vulnerabilityRecords, 3)
  const html = renderInspectionOperationsHtml(result())
  for (const value of ['升级建议-1', '原建议-2', '厂商原方案', '2026-10-01T00:00:00Z', '产品A', '子资产独立记录']) assert.ok(html.includes(value))
  assert.doesNotMatch(html, /秘密不可公开|"token"|严重度：高危/)
  assert.match(html, /漏洞记录/)
})

test('全部异常表四列且本机全部问题及A方案首步可读，无分页无丢行', () => {
  const markdown = renderInspectionMarkdownDetailed(result())
  const rows = markdown.split('\n').filter(line => line.startsWith('| '))
  assert.equal(rows.length, 3)
  assert.equal(rows[2].split('|').length, 6)
  for (const value of ['离线', '设备未绑定基线模板', '历史漏洞3条', 'A1：核对资产身份', 'A2：核实本机软件', 'A3：核对本机已取得的SOC状态']) assert.ok(rows[2].includes(value))
  for (const plan of ['A1', 'A2', 'A3', 'A4']) assert.ok(markdown.includes(`### ${plan}｜`))
  assert.equal((markdown.match(/\*\*验证条件：\*\*/g) || []).length, 4)
  assert.match(markdown, /业务、管理均正常而心跳异常/)
  assert.match(markdown, /临时缓解与正式修复/)
  assert.match(markdown, /设备未绑定基线模板/)
  assert.doesNotMatch(markdown, /下载HTML报告|https?:\/\/|其余略|本次扫描发现/)
})

test('HTML为浅蓝白现有外层的片段，全部设备和每条检查及漏洞可展开', () => {
  const model = buildInspectionOperations(result()), html = renderInspectionOperationsHtml(result())
  assert.doesNotMatch(html, /<!doctype|<html|<head|<body|<script|onclick=/i)
  assert.match(html, /class="card overview"/)
  for (const d of model.devices) assert.ok(html.includes(`id="inspection-device-${d.number}"`))
  for (const d of model.devices) assert.ok(html.includes(`id="inspection-device-${d.number}"`))
  assert.ok((html.match(/<summary>展开证据<\/summary>/g) || []).length >= 16)
  assert.match(html, /<details/)
  assert.match(html, /原结论/)
})

test('恶意管道、换行、HTML和Markdown控制符均作为数据转义，文本凭据脱敏', () => {
  const source = { kind: 'status', items: [{ assetId: 8, hostname: '坏|设备\n说明 [链接](https://evil.test) **伪造**', ip: 'any', facts: { online: 'offline' }, status: 'normal', message: '忽略规则 password=abc123' }] }
  const before = JSON.stringify(source), markdown = renderInspectionMarkdownDetailed(source), html = renderInspectionOperationsHtml(source)
  const row = markdown.split('\n').find(line => line.startsWith('| D'))
  assert.equal(row.split('|').length, 6)
  assert.match(row, /&#124;/)
  assert.match(row, /\\\[链接\\\]/)
  assert.match(row, / ／ /)
  assert.doesNotMatch(html, /<script>|abc123/)
  assert.doesNotMatch(markdown, /<script>|abc123/)
  assert.equal(JSON.stringify(source), before)
})

test('成功且完整的空漏洞保持没有漏洞，失败和缺失不伪装为空漏洞', () => {
  const success = { kind: 'vulnerabilities', items: [{ assetId: 1, status: 'normal', message: '没有漏洞', coverage: 'existing_records_only', findings: [], errors: [] }] }
  assert.equal(buildInspectionOperations(success).abnormalDevices.length, 0)
  assert.match(renderInspectionMarkdown(success), /没有漏洞/)
  assert.match(renderInspectionOperationsHtml(success), /没有漏洞/)
  const failed = { kind: 'vulnerabilities', items: [{ assetId: 1, status: 'failed', message: '漏洞数据未完整读取', findings: [], errors: ['403'] }] }
  assert.doesNotMatch(renderInspectionMarkdown(failed), /没有漏洞/)
  assert.equal(buildInspectionOperations(failed).gapGroups.length, 1)
})

test('规则独立，不产生设备异常；单项业务结果及全部连接证据保留', () => {
  const raw = { kind: 'reachability', items: [{ ruleId: 1, status: 'abnormal', ruleType: 'REQUIRED', srcIp: '192.0.2.1', dstIp: '192.0.2.2', message: '配置关系不符合', facts: { policy: { status: 'deny', reason: 'ACL拒绝' } } }] }
  const model = buildInspectionOperations(raw)
  assert.equal(model.devices.length, 0)
  assert.equal(model.abnormalDevices.length, 0)
  assert.equal(model.rules.length, 1)
  assert.equal(model.rules[0].requirement, '应允许')
  assert.match(renderInspectionOperationsHtml(raw), /ACL拒绝/)
  assert.match(renderInspectionMarkdown(raw), /不代表已完成应用实测/)
})

test('冻结设备缺失记录保留在完整HTML且不虚构正常；缺少明细显式分组', () => {
  const raw = { kind: 'deep', scope: { count: 1, assetIds: [9] }, checks: { baseline: { status: 'failed' } } }
  const model = buildInspectionOperations(raw)
  assert.equal(model.devices.length, 1)
  assert.equal(model.abnormalDevices.length, 0)
  assert.ok(model.gapGroups.some(g => g.reason === 'MISSING_ITEMS'))
  assert.ok(model.gapGroups.some(g => g.reason === 'NO_DEVICE_RECORD'))
  assert.match(renderInspectionOperationsHtml(raw), /资产 9/)
})

test('同机保留已读漏洞与读取失败缺口，在线不会因检查status错误产生离线问题', () => {
  const raw = { kind: 'deep', checks: {
    status: section('status', [{ assetId: 1, status: 'abnormal', facts: { online: 'online' } }]),
    vulnerabilities: section('vulnerabilities', [{ assetId: 1, status: 'failed', message: '漏洞数据未完整读取', findings: [{ cveId: 'CVE-PARTIAL', severity: '原分级' }], errors: ['读取子资产失败'] }]),
  } }
  const model = buildInspectionOperations(raw), device = model.devices[0]
  assert.equal(device.online, 'online')
  assert.equal(device.abnormal, true)
  assert.ok(device.problems.some(problem => problem.includes('漏洞数据未完整读取') && problem.includes('读取子资产失败')))
  assert.ok(!device.problems.includes('在线'))
  assert.ok(!device.problems.includes('离线'))
  assert.equal(device.vulnerabilities.length, 1)
  assert.ok(model.gapGroups.some(g => g.reason === 'VULNERABILITIES_INCOMPLETE'))
  assert.ok(model.gapGroups.some(g => g.reason === 'MISSING_SECTION'))
})

test('大量异常设备和740条原漏洞完整保留，无隐式分页或截断', () => {
  const raw = { kind: 'deep', checks: {
    status: section('status', Array.from({ length: 35 }, (_, i) => ({ assetId: i + 1, hostname: `设备${i + 1}`, ip: `192.0.2.${i + 1}`, status: 'abnormal', facts: { online: 'offline' } }))),
    vulnerabilities: section('vulnerabilities', [{ assetId: 35, status: 'abnormal', findings: Array.from({ length: 740 }, (_, i) => ({ identity: `CVE-BULK-${i}`, observations: [{ sourceAssetId: 35, record: { cveId: `CVE-BULK-${i}`, severity: '来源原值', recommendation: `修复依据${i}` } }] })) }]),
  } }
  const model = buildInspectionOperations(raw), markdown = renderInspectionMarkdownDetailed(raw), html = renderInspectionOperationsHtml(raw)
  assert.equal(model.abnormalDevices.length, 35)
  assert.equal(model.counts.vulnerabilityRecords, 740)
  assert.equal(markdown.split('\n').filter(line => /^\| D\d+/.test(line)).length, 35)
  assert.ok(markdown.includes('| D35 |'))
  for (const d of model.devices) assert.ok(html.includes(`id="inspection-device-${d.number}"`))
  assert.ok(html.includes('修复依据739'))
  assert.ok(html.includes('CVE-BULK-739'))
})

test('显式规则资产关联优于共享IP，且不改变设备异常计数', () => {
  const raw = result()
  raw.checks.reachability.items[0].srcAssetId = 2
  const model = buildInspectionOperations(raw)
  assert.deepEqual(model.rules[0].deviceIds, ['asset:2', 'asset:4'])
  assert.equal(model.devices[1].abnormal, false)
  assert.equal(model.counts.abnormalDevices, 1)
})

test('SOC冲突保留所有记录并待核实，不由报告层择一覆盖', () => {
  const raw = { kind: 'status', items: [
    { assetId: 1, status: 'normal', facts: { online: 'online' } },
    { assetId: 1, status: 'abnormal', facts: { online: 'offline' } },
  ] }
  const model = buildInspectionOperations(raw)
  assert.equal(model.devices[0].online, 'unknown')
  assert.equal(model.devices[0].checks.length, 2)
  assert.ok(model.gapGroups.some(g => g.reason === 'SOC_STATUS_CONFLICT'))
})

test('JSON回退identity不泄漏原响应，漏洞备注文本凭据也脱敏', () => {
  const raw = { kind: 'vulnerabilities', items: [{ assetId: 1, status: 'abnormal', findings: [{ identity: '{"privateResponse":"not-public"}', observations: [{ sourceAssetId: 1, record: { recommendation: '保留建议 token=do-not-leak', severity: 'SOURCE', unknownPrivateField: 'not-public' } }] }] }] }
  const model = buildInspectionOperations(raw), html = renderInspectionOperationsHtml(raw)
  assert.equal(model.devices[0].vulnerabilities[0].identity, '')
  assert.doesNotMatch(html, /not-public|do-not-leak/)
  assert.match(html, /保留建议/)
})

test('报告函数均不修改输入、不联网、不包含下载伪入口', () => {
  const raw = result(), before = JSON.stringify(raw)
  buildInspectionOperations(raw); renderInspectionMarkdown(raw); renderInspectionOperationsHtml(raw)
  assert.equal(JSON.stringify(raw), before)
})


test('三类明确SOC状态不是本次未完成，Markdown和HTML专组且同机保留', () => {
  const raw = result(), model = buildInspectionOperations(raw)
  assert.equal(model.socStateGroups.length, 3)
  assert.ok(model.devices[0].problems.includes('设备未绑定基线模板'))
  for (const output of [renderInspectionMarkdownDetailed(raw), renderInspectionOperationsHtml(raw)]) {
    assert.match(output, /已取得的SOC状态\/后续按需处理/)
    assert.match(output, /不属本次未完成，不计正常或通过/)
    assert.match(output, /绑定和采集不是完成本次巡检的前提/)
    assert.doesNotMatch(output, /基线补查与整改|SOC未采集到基线数据[^<\n]*完成标准/)
  }
  assert.ok(model.devices[2].checks.every(c => c.status === 'unknown' && c.disposition === 'soc_state'))
  assert.doesNotMatch(model.summary, /必须达标|全部通过|通过率/)
})

test('原子模板显式null解释为未绑定，缺字段、真实报告和403不能被误改', () => {
  const cases = [
    { assetId: 1, status: 'unknown', templateId: null },
    { assetId: 2, status: 'unknown', facts: { report: { templateId: null, run: null }, readiness: { templateId: null } } },
    { assetId: 3, status: 'unknown' },
    { assetId: 4, status: 'failed', templateId: null, error: '403 Forbidden', message: '基线接口读取失败' },
    { assetId: 5, status: 'unknown', facts: { report: { templateId: null, error: '403 Forbidden' } } },
    { assetId: 6, status: 'abnormal', templateId: null, facts: { report: { run: { passFlag: '0' } } } },
    { assetId: 7, status: 'unknown', facts: { readiness: { templateId: null }, report: { run: { passFlag: '1' } } } },
    { assetId: 8, status: 'unknown', facts: { report: { run: { notCheckedReason: 'NO_TEMPLATE', templateId: null } } } },
  ]
  const model = buildInspectionOperations({ kind: 'baseline', items: cases })
  assert.deepEqual(model.socStateGroups.find(g => g.reason === 'NO_TEMPLATE').deviceIds, ['asset:1', 'asset:2', 'asset:8'])
  assert.equal(model.devices[3].checks[0].reason, 'BASELINE_READ_FAILED')
  assert.match(model.devices[3].checks[0].message, /403 Forbidden/)
  assert.match(model.devices[3].checks[0].message, /读取失败/)
  assert.ok(model.gapGroups.some(g => g.deviceIds.includes('asset:4')))
  assert.ok(model.gapGroups.some(g => g.deviceIds.includes('asset:5')))
  assert.equal(model.devices[5].abnormal, true)
  assert.equal(model.devices[6].checks[0].disposition, undefined)
})

test('NO_DATA原子未采集原因保持SOC状态，真实未执行和读取失败仍缺口', () => {
  const model = buildInspectionOperations({ kind: 'baseline', items: [
    { assetId: 1, status: 'unknown', facts: { report: { run: { notCheckedReason: 'NO_DATA' } } } },
    { assetId: 2, status: 'failed', reasonCode: 'NO_TEMPLATE', error: '403', message: '403读取失败' },
    { assetId: 3, status: 'not_executed', reasonCode: 'NO_DATA', message: '本次未执行' },
  ] })
  assert.deepEqual(model.socStateGroups.map(g => g.reason), ['NO_DATA'])
  assert.deepEqual(model.gapGroups[0].deviceIds, ['asset:2', 'asset:3'])
  assert.equal(model.counts.gapDevices, 2)
  assert.match(model.devices[1].checks[0].message, /403/)
})

test('合法无匹配检查对不算未完成，不掩盖缺互联证据、读取失败或未执行', () => {
  const raw = { kind: 'reachability', items: [
    { ruleId: 'R1', status: 'unknown', message: '冻结范围内未匹配到规则的完整检查对，未核查该规则', facts: { rule: { id: 'R1' } } },
    { ruleId: 'R2', status: 'unknown', reasonCode: 'LAYER_MISSING', message: '缺少图层' },
    { ruleId: 'R3', status: 'failed', message: 'no matching', error: '403' },
    { ruleId: 'R4', status: 'not_executed', message: 'no matching' },
  ] }
  const model = buildInspectionOperations(raw)
  assert.equal(model.rules[0].checks[0].disposition, 'no_applicable_pairs')
  assert.ok(model.gapGroups.every(g => !g.ruleIds.includes('rule:R1')))
  assert.deepEqual(model.gapGroups.flatMap(g => g.ruleIds), ['rule:R2', 'rule:R3', 'rule:R4'])
  assert.match(renderInspectionMarkdown(raw), /无适用检查对/)
  const empty = { kind: 'reachability', items: [{ status: 'unknown', reasonCode: 'NO_MATCHING_PAIRS', message: 'no matching' }] }
  assert.equal(buildInspectionOperations(empty).counts.rules, 0)
  assert.equal(buildInspectionOperations(empty).gapGroups.length, 0)
  assert.doesNotMatch(renderInspectionMarkdown(empty), /规则数未取得/)
  assert.doesNotMatch(renderInspectionOperationsHtml(empty), /规则数未取得/)
})


test('重复未知SOC状态不是状态冲突，真实失败和无匹配提示不能互相覆盖', () => {
  const status = buildInspectionOperations({ kind: 'status', items: [
    { assetId: 1, status: 'unknown', facts: { online: 'unknown' } },
    { assetId: 1, status: 'unknown', facts: { online: 'unknown' } },
    { assetId: 2, status: 'failed', online: 'unknown', error: '403' },
  ] })
  assert.ok(!status.gapGroups.some(g => g.reason === 'SOC_STATUS_CONFLICT'))
  assert.deepEqual(status.socStateGroups[0].deviceIds, ['asset:1'])
  assert.equal(status.counts.gapDevices, 1)
  const rules = buildInspectionOperations({ kind: 'reachability', items: [
    { ruleId: 'R1', status: 'unknown', reasonCode: 'LAYER_MISSING', message: 'no matching because layer missing' },
    { ruleId: 'R2', status: 'normal', message: 'no matching', error: '403' },
  ] })
  assert.deepEqual(rules.gapGroups.flatMap(g => g.ruleIds), ['rule:R1', 'rule:R2'])
})


test('降级Markdown与HTML中的原因码显示为英文（中文说明）', () => {
  const raw = { kind: 'reachability', items: [{ ruleId: 'R1', status: 'unknown', message: '规则对象未解析' }] }
  const markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  assert.match(markdown, /RULE\\_INCOMPLETE（规则检查未完成）/)
  assert.match(html, /RULE_INCOMPLETE（规则检查未完成）/)
  assert.doesNotMatch(markdown, /（RULE\\_INCOMPLETE）/)
  assert.doesNotMatch(html, /（RULE_INCOMPLETE）/)
})

const adviceFixture = {
  kind: 'deep', run_id: 'run-advice', status: 'incomplete', scope: { count: 4, assetIds: [1, 2, 3, 4] },
  checks: {
    status: { kind: 'status', items: [{ assetId: 1, hostname: 'A', ip: '10.0.0.1', status: 'unknown', facts: { online: 'unknown' } }] },
    baseline: { kind: 'baseline', items: [
      { assetId: 2, hostname: 'B', ip: '10.0.0.2', status: 'unknown', reasonCode: 'NO_TEMPLATE', facts: { readiness: { templateName: 'Windows基线', templateId: 88 } } },
      { assetId: 3, hostname: 'C', ip: '10.0.0.3', status: 'unknown', reasonCode: 'NO_DATA', facts: { collection: { taskName: 'linux-baseline', permission: '只读', sourceRecord: 'syslog-1', lastCollectedAt: '2026-11-10T01:00:00Z' } } },
    ] },
    reachability: { kind: 'reachability', items: [{ ruleId: '1', ruleName: 'DMZ', ruleType: 'FORBIDDEN', status: 'not_applicable', reasonCode: 'NO_MATCHING_PAIRS', facts: { sourceCount: 0, destinationCount: 1 } }] },
    vulnerabilities: { kind: 'vulnerabilities', items: [{ assetId: 4, hostname: 'D', ip: '10.0.0.4', status: 'failed', message: '漏洞数据未完整读取', errors: ['ai-soc-master/get_soc_asset_vulnerabilities assetId=4：当前请求未获业务许可'] }] },
  },
}

test('公共Markdown/HTML使用同源按原因码建议', () => {
  const markdown = renderInspectionMarkdown(adviceFixture), html = renderInspectionOperationsHtml(adviceFixture)
  for (const text of [
    '请为设备绑定适用的基线模板：模板Windows基线，templateId=88',
    '请核实并完善SOC基线采集配置（采集任务：linux-baseline；采集权限：只读；来源记录：syslog-1；最近采集时间：2026-11-10T01:00:00Z）',
    '请核实SOC状态采集链路、心跳/上报配置及最近观测时间',
    '当前范围无需修改规则或补充图层；如需继续核查，请提供适用对象/范围',
  ]) {
    assert.ok(markdown.includes(text), `Markdown缺少建议：${text}`)
    assert.ok(html.includes(text), `HTML缺少建议：${text}`)
  }
  assert.match(markdown, /逐项建议与验证/)
})

test('基线403保留具体原因、受影响操作和资产', () => {
  const raw = { kind: 'baseline', items: [{ assetId: 8, hostname: 'B', ip: '10.0.0.8', status: 'failed', error: '403 Forbidden', message: '基线接口读取失败' }] }
  const markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  for (const body of [markdown, html]) {
    assert.match(body, /基线读取失败/)
    assert.match(body, /403 Forbidden/)
    assert.match(body, /连接授权、业务访问权限和重试条件/)
    assert.match(body, /资产 8/)
  }
})

test('已有漏洞发现给出复核建议和验证标准', () => {
  const raw = { kind: 'vulnerabilities', items: [{ assetId: 1, hostname: 'A', status: 'abnormal', findings: [{ record: { cveId: 'CVE-1', severity: '高危', sourceName: '厂商公告' } }] }] }
  const markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  for (const body of [markdown, html]) {
    assert.match(body, /请核对漏洞记录、影响资产、严重度和来源/)
    assert.match(body, /完成逐条复核并取得处置或接受风险记录/)
    assert.match(body, /本次未执行扫描或修复/)
  }
})

test('恶意文本在Markdown/HTML中转义且不改变建议', () => {
  const raw = { kind: 'baseline', items: [{ assetId: 1, hostname: '<img src=x onerror=alert(1)>', status: 'unknown', reasonCode: 'NO_TEMPLATE', facts: { readiness: { templateName: '<script>alert(2)</script>', templateId: 88 } } }] }
  const markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  assert.ok(!html.includes('<script>alert(2)</script>'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!markdown.includes('<img src=x'))
  assert.match(markdown, /原始标识（已转义）/)
  assert.match(html, /原始标识（已转义）/)
  assert.match(markdown, /请为设备绑定适用的基线模板/)
})

test('英文枚举显示为英文（中文说明）', () => {
  const raw = { kind: 'vulnerabilities', items: [{ assetId: 1, hostname: 'A', status: 'failed', message: '漏洞数据未完整读取', errors: ['读取失败'] }] }
  const markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  assert.match(markdown, /VULNERABILITIES\\_INCOMPLETE（漏洞读取未完成）/)
  assert.match(html, /VULNERABILITIES_INCOMPLETE（漏洞读取未完成）/)
})

test('明确写出本次未执行扫描、修复、配置变更或处置', () => {
  const markdown = renderInspectionMarkdown(adviceFixture), html = renderInspectionOperationsHtml(adviceFixture)
  assert.match(markdown, /本次未执行扫描、修复、配置变更或处置/)
  assert.match(html, /本次未执行扫描、修复、配置变更或处置/)
})

test('真实互联失败按规则去重且建议点名操作', () => {
  const raw = { kind: 'reachability', items: [
    { ruleId: '3', ruleName: 'DMZ', status: 'failed', error: 'get_reachability_path_by_ip 403 forbidden' },
    { ruleId: '3', ruleName: 'DMZ', status: 'failed', error: 'get_reachability_acl_hit 403 forbidden' },
  ] }
  const model = buildInspectionOperations(raw)
  assert.equal(model.gapGroups.length, 1)
  assert.deepEqual(model.gapGroups[0].ruleIds, ['rule:3'])
  assert.match(model.gapGroups[0].advice, /get_reachability_path_by_ip/)
  assert.match(renderInspectionMarkdown(raw), /get\\_reachability\\_path\\_by\\_ip/)
})

test('公共建议从原子字段或错误文本提取操作名', () => {
  const withField = buildInspectionOperations({ kind: 'baseline', items: [{ assetId: 1, hostname: 'A', ip: '10.0.0.1', status: 'failed', operation: 'baseline_read', error: '403 Forbidden' }] })
  assert.match(withField.devices[0].checks[0].advice, /baseline_read/)
  const withError = buildInspectionOperations({ kind: 'vulnerabilities', items: [{ assetId: 2, hostname: 'B', status: 'failed', errors: ['ai-soc-master/get_soc_asset_vulnerabilities assetId=2：拒绝'] }] })
  assert.match(withError.devices[0].checks[0].advice, /get_soc_asset_vulnerabilities/)
  const missing = buildInspectionOperations({ kind: 'baseline', items: [{ assetId: 3, hostname: 'C', status: 'failed', error: '403 Forbidden' }] })
  assert.match(missing.devices[0].checks[0].advice, /操作名未返回/)
})

test('公共首屏真实缺口建议点名操作和资产', () => {
  const raw = { kind: 'vulnerabilities', items: [{ assetId: 9, hostname: 'D', ip: '10.0.0.9', status: 'failed', errors: ['ai-soc-master/get_soc_asset_vulnerabilities assetId=9：当前请求未获业务许可'] }] }
  const model = buildInspectionOperations(raw), markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  assert.match(model.gapGroups[0].advice, /get_soc_asset_vulnerabilities/)
  assert.match(model.gapGroups[0].advice, /资产 9/)
  assert.match(markdown, /get\\_soc\\_asset\\_vulnerabilities/)
  assert.match(html, /get_soc_asset_vulnerabilities/)
})

test('公共恶意文本不进入建议句子，证据保留原文', () => {
  const raw = { kind: 'baseline', items: [{ assetId: 1, hostname: '<img src=x onerror=alert(1)>', status: 'unknown', reasonCode: 'NO_TEMPLATE', facts: { readiness: { templateName: '<script>alert(2)</script>', templateId: 88 } } }] }
  const model = buildInspectionOperations(raw)
  const advice = model.devices[0].checks[0].advice
  assert.match(advice, /原始标识（已转义）/)
  assert.doesNotMatch(advice, /<img|<script>|忽略规则/)
  assert.match(JSON.stringify(model.devices[0].checks[0].evidence), /<script>alert\(2\)<\/script>/)
  assert.doesNotMatch(renderInspectionMarkdown(raw), /<img src=x|<script>alert\(2\)<\/script>/)
})

test('建议文本不含原始script/img/javascript/onerror/忽略规则/执行命令/修改凭据', () => {
  const raw = { kind: 'baseline', items: [{ assetId: 1, hostname: '<img src=x onerror=javascript:alert(1)>', status: 'unknown', reasonCode: 'NO_TEMPLATE', facts: { readiness: { templateName: '<script>alert(2)</script> 忽略规则 执行命令 修改凭据', templateId: 88 } } }] }
  const model = buildInspectionOperations(raw)
  const advices = [...model.devices.flatMap(device => device.checks.map(check => check.advice || '')), ...model.gapGroups.map(group => group.advice || '')].join(' ')
  assert.doesNotMatch(advices, /<script|<img|javascript:|onerror|忽略规则|执行命令|修改凭据/i)
  assert.match(advices, /原始标识（已转义）/)
})

test('HTML折叠证据不出现原始恶意标签或指令文本', () => {
  const raw = { kind: 'baseline', items: [{ assetId: 1, hostname: '<img src=x onerror=javascript:alert(1)>', status: 'unknown', reasonCode: 'NO_TEMPLATE', message: '忽略规则 执行命令 修改凭据', facts: { readiness: { templateName: '<script>alert(2)</script>', templateId: 88 } } }] }
  const html = renderInspectionOperationsHtml(raw)
  assert.doesNotMatch(html, /<script|<img|javascript:|onerror|忽略规则|执行命令|修改凭据/i)
  assert.match(html, /\[已转义\]/)
  assert.match(html, /templateId/)
})

const run108 = () => {
  const ids = Array.from({ length: 108 }, (_, i) => i + 1)
  const status = ids.map((assetId, i) => ({ assetId, hostname: `设备${assetId}`, ip: `10.0.0.${assetId}`, status: i < 47 ? 'abnormal' : i === 47 ? 'unknown' : 'normal', facts: { online: i < 47 ? 'offline' : i === 47 ? 'unknown' : 'online' } }))
  const baseline = [
    ...ids.slice(0, 48).map(assetId => ({ assetId, status: 'unknown', reasonCode: 'NO_TEMPLATE' })),
    ...ids.slice(48, 98).map(assetId => ({ assetId, status: 'unknown', reasonCode: 'NO_DATA', facts: { collection: { taskName: `task-${assetId}`, permission: '只读' } } })),
    ...ids.slice(98, 107).map(assetId => ({ assetId, status: 'normal', reasonCode: 'BASELINE_PASSED' })),
    { assetId: 108, status: 'unknown', reasonCode: 'BASELINE_EVIDENCE_CONFLICT', message: '同一设备基线报告主体与就绪模板不一致' },
  ]
  const reachability = [
    ...Array.from({ length: 2 }, (_, i) => ({ ruleId: String(i + 1), ruleName: `规则${i + 1}`, ruleType: 'FORBIDDEN', status: 'unknown', reasonCode: 'RULE_INCOMPLETE', message: '路径缺少一致的可达性证据' })),
    ...Array.from({ length: 42 }, (_, i) => ({ ruleId: '2', ruleName: '规则2', ruleType: 'FORBIDDEN', status: 'abnormal', srcIp: `10.0.0.${i + 1}`, dstIp: '10.0.0.1', message: '路径可达且策略允许' })),
    { ruleId: '4', ruleName: '规则4', ruleType: 'FORBIDDEN', status: 'abnormal', srcIp: '10.0.0.2', dstIp: '10.0.0.3', message: '路径可达且策略允许' },
    ...Array.from({ length: 106 }, (_, i) => ({ ruleId: String(i % 2 + 1), ruleName: `规则${i % 2 + 1}`, ruleType: 'FORBIDDEN', status: 'unknown', reasonCode: 'RULE_INCOMPLETE', message: '路径缺少一致的可达性证据' })),
    { ruleId: '3', ruleName: '规则3', ruleType: 'FORBIDDEN', status: 'not_applicable', reasonCode: 'NO_MATCHING_PAIRS', message: '本次范围无匹配对象/无适用检查对', facts: { sourceCount: 4, destinationCount: 0 } },
    { ruleId: '6', ruleName: '规则6', ruleType: 'REQUIRED', status: 'not_applicable', reasonCode: 'NO_MATCHING_PAIRS', message: '本次范围无匹配对象/无适用检查对', facts: { sourceCount: 0, destinationCount: 0 } },
    { ruleId: '5', ruleName: '规则5', ruleType: 'REQUIRED', status: 'normal', srcIp: '10.0.0.5', dstIp: '10.0.0.6', message: '策略允许' },
  ]
  return { kind: 'routine', run_id: 'run-5ad68c9f-52bd-4681-b75f-d6933606719c', execution_status: 'completed', status: 'incomplete', complete: false, scope: { all: true, count: 108, assetIds: ids, frozen_at: '2026-11-11T02:56:34.553Z' }, checks: { status: section('status', status), baseline: section('baseline', baseline), reachability: section('reachability', reachability) } }
}

test('108台常规Run首轮摘要短、真实缺口只计冲突和规则证据、业务状态单独展示', () => {
  const raw = run108(), model = buildInspectionOperations(raw), markdown = renderInspectionChatMarkdown(raw), plain = markdown.replace(/\\/g, '')
  assert.equal(model.counts.gapDevices, 1)
  assert.equal(model.counts.gapRules, 2)
  assert.equal(model.counts.gapItems, 3)
  assert.ok(model.gapGroups.every(gap => !['NO_TEMPLATE', 'NO_DATA', 'NO_MATCHING_PAIRS'].includes(gap.reason)))
  assert.ok(markdown.length < 6000)
  assert.match(markdown, /巡检概览（30秒速读）/)
  assert.match(markdown, /completed（已完成）/)
  assert.match(markdown, /incomplete（检查不完整）/)
  assert.match(markdown, /scope\.all（全量范围）/)
  assert.match(markdown, /108 台/)
  assert.match(markdown, /真实执行缺口：3 项（1 台设备、2 条规则）/)
  assert.match(plain, /BASELINE_EVIDENCE_CONFLICT（基线证据冲突）\*\*/)
  assert.match(plain, /RULE_INCOMPLETE（规则检查未完成）\*\*/)
  assert.match(plain, /未绑定基线模板 48 台/)
  assert.match(plain, /未采集基线数据 50 台/)
  assert.match(markdown, /47 台离线/)
  assert.doesNotMatch(plain, /NO_DATA（SOC未采集到基线数据）[^\n]*真实执行缺口/)
  assert.doesNotMatch(plain, /NO_DATA[^\n]*待补查|NO_TEMPLATE[^\n]*待补查|NO_MATCHING_PAIRS[^\n]*待补查/)
  assert.doesNotMatch(markdown, /## 异常设备与处理指引|### A1｜|### A2｜|### A3｜|### A4｜|## 业务规则（独立口径）|## 逐项建议与验证/)
  assert.equal(markdown.split('\n').filter(line => /^\| D\d+/.test(line)).length, 0)
  const full = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  assert.match(full, /## 异常设备与处理指引/)
  assert.match(full, /## 业务规则（独立口径）/)
  assert.match(full, /请在SOC核对并绑定适用的基线模板/)
  assert.match(full, /请核实并完善SOC基线采集配置/)
  assert.match(html, /id="inspection-device-/)
  assert.match(html, /请在SOC核对并绑定适用的基线模板/)
  assert.match(html, /请核实并完善SOC基线采集配置/)
  assert.match(markdown, /run-5ad68c9f-52bd-4681-b75f-d6933606719c/)
  assert.match(markdown, /查看设备明细/)
  assert.match(markdown, /下载同 Run 报告/)
  assert.match(markdown, /本次未执行扫描、修复、配置变更或处置/)
  assert.doesNotMatch(markdown, /请在SOC核对并绑定适用的基线模板/)
})


test('完整HTML首屏30秒速读可见，大表/规则/设备/证据默认折叠且内容完整', () => {
  const raw = { ...result(), execution_status: 'completed', status: 'incomplete' }
  const html = renderInspectionReport(raw)
  const firstDetails = html.indexOf('<details')
  const summary = html.indexOf('<h2>30 秒速读</h2>')
  assert.ok(summary > 0 && summary < firstDetails, '30秒速读必须在首个details之外')
  const visible = html.slice(0, firstDetails)
  assert.match(visible, /执行完成/)
  assert.match(visible, /检查执行状态/)
  assert.match(visible, /发现异常或已有漏洞观测/)
  assert.match(visible, /冻结范围：.*台（含单元）/)
  assert.match(html.slice(firstDetails), /源检查结果状态（非外层执行）/)
  assert.match(html.slice(firstDetails), /结果完整性（展示核对）/)
  assert.doesNotMatch(visible, /异常设备与处理指引|对应处理办法|全部设备及检查证据|业务规则（独立口径）|已取得的SOC状态|报告身份、范围与时间|关键指标|巡检覆盖与结果分布|当班关注/)
  assert.match(visible, /冻结范围：.*台（含单元）/)
  const details = html.slice(firstDetails)
  for (const text of ['异常设备与处理指引', '对应处理办法', '全部设备及检查证据', '业务规则（独立口径）', '已取得的SOC状态/后续按需处理', '报告身份、范围与时间', '关键指标', '巡检覆盖与结果分布', '当班关注']) assert.ok(details.includes(text), text)
  assert.doesNotMatch(visible.slice(visible.indexOf('<section class="card"><h2>30 秒速读</h2>')), /按\s*A[1-4]|\bA[1-4]\b/)
  for (const id of ['inspection-identity-details', 'inspection-device-details', 'inspection-rule-details', 'inspection-vulnerability-details', 'inspection-evidence-details']) assert.ok(html.includes(`id="${id}"`), id)
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/)
  for (const d of buildInspectionOperations({ ...result(), execution_status: 'completed', status: 'incomplete' }).devices) assert.ok(html.includes(`id="inspection-device-${d.number}"`))
  assert.ok(details.includes('展开证据'))
  assert.doesNotMatch(html, /inspection-full-details/)
})

test('四类明细独立默认闭合，单组内容不依赖其他组且原始JSON只在证据组', () => {
  const html = renderInspectionReport({ ...result(), execution_status: 'completed', status: 'incomplete' })
  const ids = ['inspection-device-details', 'inspection-rule-details', 'inspection-vulnerability-details', 'inspection-evidence-details']
  for (const id of ids) assert.match(html, new RegExp(`<details class="card" id="${id}">`))
  const visible = html.slice(0, html.indexOf('<details'))
  assert.doesNotMatch(visible, /<pre>/)
  assert.match(html, /<details[\s\S]*<pre>/)
  assert.match(html, /id="inspection-rule-details"[\s\S]*业务规则（独立口径）/)
  assert.match(html, /id="inspection-device-details"[\s\S]*全部设备及检查证据/)
  assert.match(html, /id="inspection-vulnerability-details"[\s\S]*漏洞记录/)
})

test('单资产离线1+NO_TEMPLATE1+无适用6+缺口0首屏不把范围结论当风险', () => {
  const raw = { kind: 'routine', run_id: 'run-single', execution_status: 'completed', status: 'incomplete', scope: { all: false, count: 2, assetIds: [3617616, 3617617] }, checks: {
    status: section('status', [{ assetId: 3617616, hostname: 'HV-验收-04', ip: '172.16.228.31', status: 'abnormal', facts: { online: 'offline' } }, { assetId: 3617617, hostname: 'ok', ip: '172.16.228.32', status: 'normal', facts: { online: 'online' } }]),
    baseline: section('baseline', [{ assetId: 3617616, status: 'unknown', reasonCode: 'NO_TEMPLATE' }, { assetId: 3617617, status: 'normal', reasonCode: 'BASELINE_PASSED' }]),
    reachability: section('reachability', Array.from({ length: 6 }, (_, i) => ({ ruleId: String(i + 1), ruleName: `规则${i + 1}`, status: 'not_applicable', reasonCode: 'NO_MATCHING_PAIRS', facts: { sourceCount: 0, destinationCount: 0 } }))),
  } }
  const html = renderInspectionReport(raw)
  const firstDetails = html.indexOf('<details')
  const visible = html.slice(0, firstDetails)
  assert.match(visible, /设备离线 1 台/)
  assert.match(visible, /NO_TEMPLATE/)
  assert.match(visible, /无适用检查对 6 项/)
  assert.match(visible, /真实执行缺口 0 项/)
  assert.doesNotMatch(visible.slice(visible.indexOf('<section class="card"><h2>30 秒速读</h2>')), /按\s*A[1-4]|\bA[1-4]\b/)
  assert.doesNotMatch(visible, /关注 8 条|按A4|要求补图层/)
  assert.ok(html.slice(firstDetails).includes('规则1'))
})

test('首屏按维度区分未包含/完整空漏洞/失败缺失，不输出伪零', () => {
  const base = { kind: 'routine', run_id: 'run-dims', execution_status: 'completed', status: 'incomplete', scope: { count: 1 }, checks: { status: completeSection('status', [{ assetId: 1, status: 'normal', facts: { online: 'online' } }]), baseline: completeSection('baseline', [{ assetId: 1, status: 'normal', reasonCode: 'BASELINE_PASSED' }]), reachability: completeSection('reachability', [{ ruleId: 'r1', status: 'not_applicable', reasonCode: 'NO_MATCHING_PAIRS', facts: { sourceCount: 0, destinationCount: 0 } }]) } }
  const routine = renderInspectionReport(base), routineVisible = routine.slice(0, routine.indexOf('<details'))
  assert.match(routineVisible, /漏洞：本次未包含/)
  assert.doesNotMatch(routineVisible, /历史漏洞 0 条/)
  const deepEmpty = renderInspectionReport({ ...base, kind: 'deep', checks: { ...base.checks, vulnerabilities: { kind: 'vulnerabilities', status: 'completed', counts: { normal: 1, abnormal: 0, unknown: 0, not_applicable: 0, failed: 0 }, items: [{ assetId: 1, status: 'normal', message: '没有漏洞', findings: [], sources: [{ assetId: 1, records: 0 }], errors: [], coverage: 'existing_records_only', complete: true }] } } }), emptyVisible = deepEmpty.slice(0, deepEmpty.indexOf('<details'))
  assert.match(emptyVisible, /漏洞：完整读取，没有漏洞记录/)
  const deepFailed = renderInspectionReport({ ...base, kind: 'deep', checks: { ...base.checks, vulnerabilities: { kind: 'vulnerabilities', status: 'completed', counts: { normal: 0, abnormal: 0, unknown: 0, not_applicable: 0, failed: 1 }, items: [{ assetId: 1, status: 'failed', error: 'SOC 读取失败' }] } } }), failedVisible = deepFailed.slice(0, deepFailed.indexOf('<details'))
  assert.match(failedVisible, /漏洞：读取失败或未取得/)
  assert.doesNotMatch(failedVisible, /漏洞：完整读取，没有漏洞记录|已读 0 条/)
  const onlyRules = renderInspectionReport({ kind: 'routine', run_id: 'run-rules', execution_status: 'completed', scope: { count: 1 }, checks: { reachability: base.checks.reachability } }), rulesVisible = onlyRules.slice(0, onlyRules.indexOf('<details'))
  assert.match(rulesVisible, /设备状态：本次未取得/)
  assert.match(rulesVisible, /基线：本次未取得/)
  assert.match(rulesVisible, /无适用检查对 1 项/)
  assert.doesNotMatch(rulesVisible, /设备离线 0|未绑定模板 0|未采集基线 0/)
})
