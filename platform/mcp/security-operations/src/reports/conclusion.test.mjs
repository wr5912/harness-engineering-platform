import test from 'node:test'
import assert from 'node:assert/strict'
import { buildConclusion, validateEcho, structuredSummary, statusLabels, stopLabels, impactLevel } from './conclusion.ts'
import { renderTroubleshootingReport } from './troubleshooting.ts'

const unknownReport = {
  kind: 'business-access', run_id: 'run-11111111-2222-4333-8444-555555555555', status: 'incomplete', conclusion: 'inconclusive', terminal: 'evidence-loop-stopped',
  scope: { source: { ip: '192.0.2.10' }, target: { ip: '192.0.2.20' }, protocol: 'tcp', port: 80 },
  items: [
    { check: 'portEvidence', id: 'f1', node_id: 'root/execute', run_id: 'run-11111111-2222-4333-8444-555555555555', status: 'unknown', execution_status: 'completed', observed_at: null, evidence: { status: 'NO_RECORD' },
      gaps: [{ check: 'portEvidence', status: 'unknown', reason: 'SOC端口证据 status=NO_RECORD，recordedAt/source/service 均为空' }], raw_receipt_refs: [{ receipt_id: 'r1' }] },
    { check: 'pathEvidence', id: 'f2', node_id: 'root/execute', run_id: 'run-11111111-2222-4333-8444-555555555555', status: 'failed', execution_status: 'failed',
      gaps: [], raw_receipt_refs: [] },
    { check: 'alerts', id: 'f3', node_id: 'root/execute', run_id: 'run-11111111-2222-4333-8444-555555555555', status: 'unknown', execution_status: 'not_executed', gaps: [], raw_receipt_refs: [] },
  ],
  causes: [
    { id: 'service-not-listening', title: '服务未监听', status: 'unknown', support: { evidence_ids: [] }, refutation: { evidence_ids: [] } },
    { id: 'link-abnormal', title: '链路异常', status: 'unknown', support: { evidence_ids: [] }, refutation: { evidence_ids: [] } },
  ],
  gaps: ['上游未提供可核带时区观测时间；查询窗口和记录时间不替代观测时间'],
}
const supportedReport = {
  ...unknownReport,
  causes: [{ id: 'link-abnormal', title: '链路异常', status: 'supported', support: { evidence_ids: ['f1'] }, refutation: { evidence_ids: [] } }],
}
const confirmedReport = {
  ...unknownReport, status: 'complete', conclusion: 'confirmed',
  causes: [{ id: 'service-not-listening', title: '服务未监听', status: 'confirmed', support: { evidence_ids: ['f1', 'f2'] }, refutation: { evidence_ids: [] } }],
}

test('状态与停止状态按英文(中文)保存，展示优先中文', () => {
  assert.equal(statusLabels.CONFIRMED, '已确认')
  assert.equal(stopLabels.EVIDENCE_INSUFFICIENT, '证据不足停止')
  const c = buildConclusion(unknownReport)
  assert.equal(c.rootCause.statusCode, 'UNKNOWN')
  assert.match(c.rootCause.status, /^UNKNOWN\(/)
  assert.match(c.currentStatus, /^UNKNOWN\(/)
  assert.ok(Object.values(statusLabels).every(v => typeof v === 'string' && v.length > 0))
})

test('根因未知明确写“根因尚未确认”，支持态不写成确认', () => {
  const c = buildConclusion(unknownReport)
  assert.equal(c.rootCause.title, '根因尚未确认')
  assert.doesNotMatch(JSON.stringify(c.rootCause.title), /服务未监听|链路异常/)
  assert.ok(c.rootCause.gaps.length >= 1)
  const supported = buildConclusion(supportedReport)
  assert.equal(supported.rootCause.statusCode, 'SUPPORTED')
  assert.equal(supported.rootCause.title, '链路异常')
  assert.notEqual(supported.rootCause.statusCode, 'CONFIRMED')
})

test('影响等级只由影响范围/业务重要性/持续时间计算，与根因置信度分开', () => {
  const low = impactLevel({ scope: 'service', businessCritical: false, durationHours: 0.2, confirmed: false })
  const high = impactLevel({ scope: 'multi', businessCritical: true, durationHours: 30, confirmed: true })
  assert.equal(low.level, 'LOW')
  assert.ok(['HIGH', 'CRITICAL'].includes(high.level))
  const c = buildConclusion(unknownReport)
  assert.ok(c.impactLevel.basis)
  assert.match(c.impactLevel.note, /不代表根因置信度/)
  assert.match(c.impactLevel.note, /根因置信度/)
  assert.equal(c.impactLevel.basis.confirmedImpact, false)
})

test('建议可执行但不越权：字段齐全、首屏一个首要+最多两个后续、核查与处置分开', () => {
  const c = buildConclusion(unknownReport)
  const primary = c.primaryRecommendation
  for (const key of ['recommendationId', 'owner', 'prerequisites', 'authorization', 'risk', 'completionCriteria', 'verificationMethod', 'state', 'stateLabel', 'category']) assert.ok(key in primary, key)
  assert.match(primary.category, /只读|处置/)
  assert.ok(c.followupRecommendations.length <= 2)
  assert.equal(c.recommendationLifecycle.length, 1 + c.followupRecommendations.length)
  assert.match(c.primaryRecommendation.authorization, /本编排不执行|只读/)
  const confirmed = buildConclusion(confirmedReport)
  assert.match(confirmed.primaryRecommendation.category, /处置/)
  assert.match(confirmed.primaryRecommendation.authorization, /不执行任何写操作/)
})

test('部分失败不覆盖成功证据，动作/证据/归因分开保存', () => {
  const c = buildConclusion(unknownReport)
  assert.deepEqual(c.partialFailures.failed.map(x => x.check), ['pathEvidence'])
  assert.deepEqual(c.partialFailures.notExecuted, ['alerts'])
  assert.ok(c.partialFailures.noData.includes('portEvidence'))
  const fact = c.evidenceRefs.find(x => x.check === 'portEvidence')
  assert.equal(fact.evidenceStatus, 'UNKNOWN')
  assert.equal(fact.actionStatus, 'completed')
  assert.equal(c.evidenceRefs.find(x => x.check === 'pathEvidence').actionStatus, 'failed')
})

test('回显事实校验：外域IP/根因过度声称/无记录当未监听/旁路当实测/缺Run号均判违规', () => {
  const c = buildConclusion(unknownReport)
  const good = `本次 ${c.runId} 对 192.0.2.10 → 192.0.2.20 tcp/80 只读排查，根因 UNKNOWN(未知)，端口 NO_RECORD 不等于未监听。`
  assert.equal(validateEcho(c, good).ok, true)
  assert.ok(validateEcho(c, good.replace('192.0.2.20', '198.51.100.9')).violations.some(v => v.startsWith('OBJECT_EXTRA')))
  assert.ok(validateEcho(c, `${good} 根因已确认是服务未监听`).violations.includes('ROOT_OVERCLAIM'))
  assert.ok(validateEcho(c, `${good} 目标 80 未监听`).violations.includes('NO_RECORD_AS_NOT_LISTENING'))
  assert.ok(validateEcho(c, `${good} 源端实测不可达（旁路 PLATFORM_ONLY）`).violations.includes('SIDECHANNEL_AS_DIRECT'))
  const noRun = validateEcho(c, '192.0.2.10 → 192.0.2.20 tcp/80 根因 UNKNOWN(未知)')
  assert.ok(noRun.violations.includes('RUN_ID_MISSING'))
  assert.match(noRun.fallback, /当前状态：/)
  assert.equal(structuredSummary(c).split('\n').length, 4)
})

test('HTML 首屏七项可用；根因未知时显示“根因尚未确认”并分区旁路', () => {
  const report = { ...unknownReport, unified_conclusion: buildConclusion(unknownReport), generated_at: new Date(0).toISOString() }
  const html = renderTroubleshootingReport(report)
  for (const label of ['首屏结论', '当前状态', '影响等级', '故障概况', '影响范围', '当前根因判断', '首要建议', '升级条件']) assert.ok(html.includes(label), label)
  assert.ok(html.includes('根因尚未确认'))
  assert.ok(html.includes('CORROBORATION') && html.includes('PLATFORM_ONLY'))
  assert.ok(html.includes('分层核对') && html.includes('部分失败与未覆盖'))
  assert.ok(html.includes('192.0.2.20'))
})
