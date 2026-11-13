import test from 'node:test'
import assert from 'node:assert/strict'
import { requireReportRequest, resolveReportRunSelection } from '@hep-data/evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/managed/security-report-runtime.ts'

const event = { action: 'download_report', runId: 'run-11111111-1111-4111-8111-111111111111', schema: 'inspection-report-event/v1', type: 'inspection_report_event' }
const exec = () => {
  const user = { type: 'user/message', data: { source: { kind: 'user' }, id: 'user-1', content: [{ type: 'text', text: JSON.stringify(event) }] } }
  return { agent: { id: 'agent-1', session: { id: 'agent-1', header: { delegationDepth: 0 }, snapshotEvents: () => [user] } } }
}

test('真实报告卡下载事件被识别为下载意图', () => {
  assert.doesNotThrow(() => requireReportRequest(exec()))
  assert.equal(requireReportRequest(exec()).reuseOnly, false)
  assert.equal(requireReportRequest(exec()).eventRunId, 'run-11111111-1111-4111-8111-111111111111')
})

test('普通文本没有下载意图仍被拒绝', () => {
  const value = exec()
  value.agent.session.snapshotEvents = () => [{ type: 'user/message', data: { source: { kind: 'user' }, id: 'user-2', content: [{ type: 'text', text: '请介绍巡检报告' }] } }]
  assert.throws(() => requireReportRequest(value), /没有报告生成或下载意图/)
})


test('错误schema、action或缺少runId不被当作下载事件', () => {
  for (const bad of [
    { ...event, schema: 'inspection-report-event/v2' },
    { ...event, action: 'view_devices' },
    { ...event, runId: '' },
    { ...event, runId: 'not-a-run' },
  ]) {
    const value = exec()
    value.agent.session.snapshotEvents = () => [{ type: 'user/message', data: { source: { kind: 'user' }, id: 'u-bad', content: [{ type: 'text', text: JSON.stringify(bad) }] } }]
    assert.throws(() => requireReportRequest(value), /没有报告生成或下载意图/)
  }
})


test('报告卡事件优先绑定事件Run，附件按manifest同Run而非缺省run_id拒绝', () => {
  const a = 'run-11111111-1111-4111-8111-111111111111', b = 'run-22222222-2222-4222-8222-222222222222'
  assert.equal(resolveReportRunSelection(a, { kind: 'inspection' }), a)
  assert.equal(resolveReportRunSelection(a, { kind: 'inspection', attachment_id: `sha256:${'a'.repeat(64)}` }, a), a)
  assert.throws(() => resolveReportRunSelection(a, { kind: 'inspection', attachment_id: `sha256:${'a'.repeat(64)}` }, b), /附件 manifest/)
  assert.throws(() => resolveReportRunSelection(a, { kind: 'inspection', run_id: b }), /显式 run_id/)
  assert.throws(() => resolveReportRunSelection(a, { kind: 'inspection', selection: 'latest_completed' }), /latest_completed/)
  assert.equal(resolveReportRunSelection(undefined, { kind: 'inspection' }), undefined)
})
