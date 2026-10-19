import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeCase, turnsFromTrace, saveSessionTrace } from './dsh-eval-common.mjs'

const user = (id, text) => ({
  type: 'user/message',
  data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] },
})
const header = tools => ({
  type: 'request/header',
  data: { header: { config: { provider: 'test', model: 'model' }, tools } },
})
const assistant = text => ({
  type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } },
})
const end = turn => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
const archive = root => ({
  root,
  trace: root.map(event => ({ session_log: 'session.jsonl', event })),
})

const multiTurnArchive = archive([
  user('u1', '执行一次常规巡检。'), header([{ name: 'inspection.run' }]),
  assistant('共 39 台，报告：https://example/report'), end(1),
  user('u2', '只分析。'), header([{ name: 'inspection.analyze' }]),
  assistant('分析完成。'), end(2),
])

const turns = turnsFromTrace(multiTurnArchive, ['执行一次常规巡检。', '只分析。'])
assert.deepEqual(turns.map(turn => turn.assistant_text), [
  '共 39 台，报告：https://example/report', '分析完成。',
])
const inheritedHeaderTurns = turnsFromTrace(archive([
  user('u1', '首次分析。'), header([{ name: 'read' }]), assistant('首次完成。'), end(1),
  user('u2', '修正格式。'), assistant('修正完成。'), end(2),
]), ['首次分析。', '修正格式。'])
assert.deepEqual(inheritedHeaderTurns[1].route, { provider: 'test', model: 'model' })
assert.deepEqual(inheritedHeaderTurns[1].tool_names, ['read'])
assert.throws(
  () => turnsFromTrace(multiTurnArchive, ['执行一次常规巡检。']),
  /evidence-cross-turn/,
)

const rc2Failure = JSON.parse(await readFile(new URL('./fixtures/rc2-prompt-render-failure.json', import.meta.url), 'utf8'))
const failedBeforeSurface = turnsFromTrace(archive(rc2Failure.events), [rc2Failure.input])
assert.equal(failedBeforeSurface[0].turn_reason, 'error', '真实 rc.2 前置错误不应被误判为仍在等待模型')
assert.equal(failedBeforeSurface[0].assistant_text, '')
assert.equal(failedBeforeSurface[0].route, null, '未发起模型请求时不虚构实际模型')
assert.equal(failedBeforeSurface[0].input_message_id, 'fixture-user-message')
assert.throws(() => turnsFromTrace(archive(rc2Failure.events), ['不是本次输入']), /evidence-cross-turn/)
assert.equal(turnsFromTrace(archive(rc2Failure.events.slice(0, 1)), [rc2Failure.input]), null, '只排队尚未消费不算完成')

const claimed = rc2Failure.events.slice(0, 3)
const committedRc2 = archive([
  ...claimed, user('fixture-user-message', rc2Failure.input), header([]), assistant('已就绪。'), end(1),
])
assert.equal(turnsFromTrace(committedRc2, [rc2Failure.input]).length, 1, '已投影输入不能和 inbox claim 重复计数')
const canceledRc2 = archive([
  claimed[0],
  { ...claimed[2], data: { ...claimed[2].data, outcome: 'canceled' } },
  claimed[1],
  rc2Failure.events.at(-1),
])
assert.equal(turnsFromTrace(canceledRc2, [rc2Failure.input]), null, '取消队列输入不能冒充回合消费')
const errorThenSuccess = turnsFromTrace(archive([
  ...rc2Failure.events,
  user('u2', '再次检查。'), header([]), assistant('已就绪。'), end(2),
]), [rc2Failure.input, '再次检查。'])
assert.deepEqual(errorThenSuccess.map(turn => turn.turn_reason), ['error', 'completed'])
const successThenError = turnsFromTrace(archive([
  user('u1', '先检查。'), header([{ name: 'first_tool' }]), assistant('首次完成。'), end(1),
  ...rc2Failure.events.map(event => ({ ...event, data: { ...event.data, ...(event.data.turn === 1 ? { turn: 2 } : {}) } })),
]), ['先检查。', rc2Failure.input])
assert.equal(successThenError[1].turn_reason, 'error')
assert.equal(successThenError[1].route, null, '前置失败不得继承上一轮实际模型')
assert.equal(successThenError[1].tool_names, null, '前置失败不得继承上一轮可用工具')

const targetArchive = archive([
  user('u1', '执行一次常规巡检。'), header([{ name: 'inspection.run' }]),
  { type: 'tool/call', data: { name: 'inspection.run' } },
  { type: 'tool/result', data: { result: { total: 39, report_url: 'https://example/report' } } },
  assistant('共 39 台，报告：https://example/report'), end(1),
])
const targetTurns = turnsFromTrace(targetArchive, ['执行一次常规巡检。'])
const item = {
  case_id: 'U-INS-001',
  inputs: ['执行一次常规巡检。'],
  expected_behavior: '设备数量和报告链接必须来自真实工具返回。',
}
const judged = await judgeCase(item, {
  assistant_texts: [targetTurns[0].assistant_text],
  turns: [...targetTurns, { ...targetTurns[0], route: null }],
}, targetArchive,
  async input => {
    const request = JSON.parse(input)
    assert.equal(request.evidence.tool_events.length, 2)
    return {
      session: { session_id: 'judge-session' },
      archive: archive([
        user('judge-user', input), header([]),
        assistant('{"verdict":"passed","reason":"回答与同一 Session 工具结果一致"}'), end(1),
      ]),
    }
  })
assert.equal(judged.available, true)
assert.equal(judged.response.verdict, 'passed')
assert.deepEqual(judged.checks.tools, [])
assert.equal(judged.checks.same_route_as_target, true)

const extraJudgeField = await judgeCase(item, {
  assistant_texts: [targetTurns[0].assistant_text], turns: targetTurns,
}, targetArchive, async input => ({
  session: { session_id: 'judge-session' },
  archive: archive([
    user('judge-user', input), header([]),
    assistant('{"verdict":"passed","reason":"回执与回答一致","reason_note":"附加说明"}'), end(1),
  ]),
}))
assert.deepEqual(extraJudgeField.response, { verdict: 'passed', reason: '回执与回答一致' })

const englishReply = await judgeCase({ ...item, expected_behavior: '用中文指出证据缺口。' }, {
  assistant_texts: ['Please provide the evidence.'],
  turns: targetTurns,
}, targetArchive, async input => ({
  session: { session_id: 'judge-session' },
  archive: archive([
    user('judge-user', input), header([]),
    assistant('{"verdict":"passed","reason":"内容符合要求"}'), end(1),
  ]),
}))
assert.equal(englishReply.response.verdict, 'failed')
assert.equal(englishReply.checks.model_verdict, 'passed')
assert.equal(englishReply.checks.deterministic_check, 'language-mismatch')

const evidenceDirectory = await mkdtemp(join(tmpdir(), 'dsh-eval-common-trace-'))
try {
  const successChecks = { completed: true }
  await saveSessionTrace(evidenceDirectory, targetArchive, successChecks)
  assert.deepEqual(JSON.parse(await readFile(join(evidenceDirectory, 'checks.json'), 'utf8')), { completed: true, trace_available: true })
  assert.equal(successChecks.trace_available, undefined, '持久化回执不修改调用方对象')
  await saveSessionTrace(evidenceDirectory, archive([user('partial', '未完成输入')]), { completed: false })
  assert.deepEqual(JSON.parse(await readFile(join(evidenceDirectory, 'checks.json'), 'utf8')), { completed: false, trace_available: true }, '有轨迹不等于执行完成')
  await saveSessionTrace(evidenceDirectory, null, { completed: false, trace_available: true })
  assert.equal(JSON.parse(await readFile(join(evidenceDirectory, 'checks.json'), 'utf8')).trace_available, false)
  assert.equal(await readFile(join(evidenceDirectory, 'trace.jsonl'), 'utf8'), '')
} finally { await rm(evidenceDirectory, { recursive: true, force: true }) }

console.log(JSON.stringify({ status: 'dsh-eval-common-tests-passed', cases: 16 }))
