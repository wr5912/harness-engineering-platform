import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeCase, turnsFromTrace, saveSessionTrace, saveCaseResult } from './dsh-eval-common.mjs'

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
  { type: 'tool/call', seq: 2, data: { name: 'inspection.run', callId: 'inspection-call-1', arguments: '{}' } },
  { type: 'tool/result', seq: 3, data: { message: { source: { callId: 'inspection-call-1' }, content: [
    { type: 'text', text: JSON.stringify({ total: 39, report_url: 'https://example/report' }) },
  ] } } },
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
    assert.equal(Object.hasOwn(request, 'evidence'), false, '评审只收到一份索引证据，避免引用不同转义层级的投影')
    assert.equal(request.indexed_evidence[2].text, targetArchive.root[3].data.message.content[0].text)
    assert.equal(request.indexed_evidence[2].session_log, 'session.jsonl')
    assert.equal(request.indexed_evidence[2].event_seq, 3)
    assert.equal(request.indexed_evidence[2].call_id, 'inspection-call-1')
    assert.equal(request.indexed_evidence[2].content_index, 0)
    assert.equal(request.indexed_evidence[2].citation_allowed, true)
    assert.equal(request.indexed_evidence[1].citation_allowed, false)
    assert.deepEqual(Object.keys(request.output_contract.requirements[0].evidence[0]), ['index'])
    return {
      session: { session_id: 'judge-session' },
      archive: archive([
        user('judge-user', input), header([]),
        assistant(JSON.stringify({ verdict: 'passed', reason: '回答与同一 Session 工具结果一致', requirements: request.requirements.map(requirement => ({ requirement, status: 'satisfied', evidence: [{ index: 2, quote: 'total' }] })) })), end(1),
      ]),
    }
  })
assert.equal(judged.available, true)
assert.equal(judged.response.verdict, 'passed')
assert.deepEqual(judged.checks.tools, [])
assert.equal(judged.checks.same_route_as_target, true)
assert.equal(judged.response.requirements[0].evidence[0].quote_source, 'judge_output')

const roleRequirements = [
  '根据 Candidate 中用户提供的角色正文，说明与“只读基础模拟台账：按分页读取固定 asset-0001 至 asset-0005 五台资产台账，交付逐设备 Markdown 与 CSV 报告及实际下载入口；漏页时不得声称完整交付，不提供真实设备健康结论。”一致的工作方式',
  '缺少必要信息时提出具体问题，不声称已经执行未提供的工具或产生业务结果',
]
for (const [name, expectedBehavior, expectedRequirements] of [
  ['真实 U-ROLE-001 保留引用的完整角色正文', roleRequirements.join('。') + '。', roleRequirements],
  ['引号外仍按分号句号与换行分段', '第一项；\n第二项。\n第三项；。', ['第一项', '第二项', '第三项']],
  ['嵌套中文引号内标点与换行逐字保留', '说明与“外层「内层『更内层；句。』原样」及‘单引号；句。\n换行’保持。”一致；结束。',
    ['说明与“外层「内层『更内层；句。』原样」及‘单引号；句。\n换行’保持。”一致', '结束']],
  ['未成对引号不吞掉后续要求', '前置“未闭合；后续。\n最后一项', ['前置“未闭合', '后续', '最后一项']],
]) {
  const inputText = '请说明你能如何帮助我开始工作；如果信息不足，你需要先了解什么？'
  const splitArchive = archive([user('split-user', inputText), header([]), assistant('需求分段回归回答。'), end(1)])
  const evaluated = await judgeCase({ case_id: 'U-ROLE-001', inputs: [inputText], expected_behavior: expectedBehavior },
    { assistant_texts: ['需求分段回归回答。'], turns: turnsFromTrace(splitArchive, [inputText]) }, splitArchive, async input => {
      const request = JSON.parse(input)
      assert.deepEqual(request.requirements, expectedRequirements, name)
      assert.equal(request.case.expected, expectedBehavior, '需求分段不修改冻结原文')
      return { session: { session_id: 'split-judge' }, archive: archive([
        user('split-judge-user', input), header([]), assistant(JSON.stringify({ verdict: 'passed', reason: name,
          requirements: request.requirements.map(requirement => ({ requirement, status: 'satisfied', evidence: [{ index: 0 }] })) })), end(1),
      ]) }
    })
  assert.equal(evaluated.response.verdict, 'passed', name)
  assert.deepEqual(evaluated.response.requirements.map(requirement => requirement.requirement), expectedRequirements)
}

const nativeReceipt = JSON.stringify({ ok: true, result: { reply: '报告包含“台账”说明。' }, graph_execution: { execution_mode: 'code-only' } })
const nativeToolArchive = archive([
  user('native-user', item.inputs[0]), header([{ name: 'inspection.run' }]),
  { type: 'tool/call', data: { name: 'inspection.run', callId: 'native-call', arguments: '{"action":"report"}' } },
  { type: 'tool/result', data: { message: { source: { callId: 'native-call' }, content: [
    { type: 'text', text: nativeReceipt }, { type: 'text', text: '第二个独立文本块。' },
  ] } } },
  assistant('报告包含“台账”说明。'), end(1),
])
const nativeArchiveBefore = JSON.stringify(nativeToolArchive)
for (const [name, reference, expected] of [
  ['原生 JSON 文本连续原文', { index: 2, quote: '"execution_mode":"code-only"' }, 'passed'],
  ['额外转义不能借归档投影通过', { index: 2, quote: '\\"execution_mode\\":\\"code-only\\"' }, 'inconclusive'],
  ['不同文本块不能拼接为连续引文', { index: 2, quote: nativeReceipt + '第二个独立文本块。' }, 'inconclusive'],
  ['工具调用不能冒充执行结果', { index: 1, quote: '"action":"report"' }, 'inconclusive'],
]) {
  const verdict = await judgeCase(item, { assistant_texts: ['报告包含“台账”说明。'], turns: turnsFromTrace(nativeToolArchive, item.inputs) }, nativeToolArchive, async input => {
    const request = JSON.parse(input)
    assert.equal(request.indexed_evidence[2].text, nativeReceipt)
    assert.equal(request.indexed_evidence[3].text, '第二个独立文本块。')
    assert.equal(request.indexed_evidence[3].content_index, 1)
    return { session: { session_id: 'native-judge' }, archive: archive([
      user('native-judge-user', input), header([]), assistant(JSON.stringify({ verdict: 'passed', reason: name,
        requirements: request.requirements.map(requirement => ({ requirement, status: 'satisfied', evidence: [reference] })) })), end(1),
    ]) }
  })
  assert.equal(verdict.response.verdict, expected, name)
}
assert.equal(JSON.stringify(nativeToolArchive), nativeArchiveBefore, '创建索引不改写原生轨迹或工具内容')

for (const [name, references, expected] of [
  ['按选择索引物化完整原文', [{ index: 2 }], 'passed'],
  ['不代选其他证据块', [{ index: 3 }], 'passed'],
  ['多个索引分别保留单块原文', [{ index: 2 }, { index: 3 }], 'passed'],
  ['遗漏索引', [{}], 'inconclusive'],
  ['null 索引', [{ index: null }], 'inconclusive'],
  ['空字符串索引', [{ index: '' }], 'inconclusive'],
  ['负数索引', [{ index: -1 }], 'inconclusive'],
  ['越界索引', [{ index: 4 }], 'inconclusive'],
  ['工具调用索引', [{ index: 1 }], 'inconclusive'],
  ['显式空引文不能物化回退', [{ index: 2, quote: '' }], 'inconclusive'],
  ['显式 null 引文不能物化回退', [{ index: 2, quote: null }], 'inconclusive'],
  ['显式错误引文不能物化回退', [{ index: 2, quote: '不存在的结果原文' }], 'inconclusive'],
  ['引用列表为空', [], 'inconclusive'],
  ['有效引用不能掩盖另一条非法索引', [{ index: 2 }, { index: 99 }], 'inconclusive'],
]) {
  let rawJudgeOutput
  const evaluated = await judgeCase(item, { assistant_texts: ['报告包含“台账”说明。'], turns: turnsFromTrace(nativeToolArchive, item.inputs) }, nativeToolArchive, async input => {
    const request = JSON.parse(input)
    assert.equal(request.indexed_evidence[1].citation_allowed, false)
    assert.equal(request.indexed_evidence[2].citation_allowed, true)
    rawJudgeOutput = JSON.stringify({ verdict: 'passed', reason: name,
      requirements: request.requirements.map(requirement => ({ requirement, status: 'satisfied', evidence: references })) })
    return { session: { session_id: 'indexed-judge' }, archive: archive([
      user('indexed-judge-user', input), header([]), assistant(rawJudgeOutput), end(1),
    ]) }
  })
  assert.equal(evaluated.response.verdict, expected, name)
  assert.equal(evaluated.archive.root.find(event => event.type === 'assistant/message').data.message.content[0].text, rawJudgeOutput,
    '索引物化结果不能覆盖或冒充模型原始输出')
  if (expected === 'passed') {
    assert.equal(evaluated.response.evidence_normalized, true)
    const materialized = evaluated.response.requirements[0].evidence
    assert.deepEqual(materialized.map(ref => ref.index), references.map(ref => ref.index))
    for (const ref of materialized) {
      assert.equal(ref.quote, ref.index === 2 ? nativeReceipt : '第二个独立文本块。')
      assert.equal(ref.quote_source, 'indexed_evidence')
    }
    assert.deepEqual(JSON.parse(rawJudgeOutput).requirements[0].evidence, references,
      '原始模型只选择索引，完整 quote 属于明确标记的程序物化结果')
  }
}

for (const withText of [true, false]) {
  const failureText = '模拟服务不可达，未读取任何资产。'
  const nativeError = { code: 'MOCK_UNAVAILABLE', message: '模拟服务不可达' }
  const failureArchive = archive([
    user('failure-user', item.inputs[0]), header([{ name: 'inspection.run' }]),
    { type: 'tool/call', data: { name: 'inspection.run', callId: 'failed-call', arguments: '{}' } },
    { type: 'tool/result', seq: 7, data: { error: nativeError, message: { source: { callId: 'failed-call' }, isError: true,
      content: withText ? [{ type: 'text', text: failureText }] : [] } } },
    assistant(failureText), end(1),
  ])
  const evaluated = await judgeCase({ ...item, expected_behavior: '工具不可用时准确报告并停止，不声称读取成功。' },
    { assistant_texts: [failureText], turns: turnsFromTrace(failureArchive, item.inputs) }, failureArchive, async input => {
      const request = JSON.parse(input), receipt = request.indexed_evidence[2]
      assert.equal(request.indexed_evidence.length, 3, '无文本错误回执仍须保留一个可定位结果项')
      assert.equal(receipt.kind, 'tool/result')
      assert.equal(receipt.call_id, 'failed-call')
      assert.equal(receipt.event_seq, 7)
      assert.equal(receipt.is_error, true)
      assert.deepEqual(receipt.error, nativeError)
      assert.equal(receipt.text, withText ? failureText : '')
      assert.equal(receipt.citation_allowed, withText)
      return { session: { session_id: 'failure-judge' }, archive: archive([
        user('failure-judge-user', input), header([]), assistant(JSON.stringify({ verdict: 'passed', reason: '核对异常处理与失败回执',
          requirements: request.requirements.map(requirement => ({ requirement, status: 'satisfied', evidence: [withText ? { index: 2, quote: failureText } : { index: 2 }] })) })), end(1),
      ]) }
    })
  assert.equal(evaluated.response.verdict, withText ? 'passed' : 'inconclusive',
    withText ? '正确异常 Case 可以引用真实错误文本，不因 isError 一律拒绝' : '错误元数据可见但不能伪装成空正文中的连续引文')
}

const extraJudgeField = await judgeCase(item, {
  assistant_texts: [targetTurns[0].assistant_text], turns: targetTurns,
}, targetArchive, async input => ({
  session: { session_id: 'judge-session' },
  archive: archive([
    user('judge-user', input), header([]),
    assistant('{"verdict":"passed","reason":"回执与回答一致","reason_note":"附加说明"}'), end(1),
  ]),
}))
assert.equal(extraJudgeField.response.verdict, 'inconclusive', '没有逐项证据的通过不能采信')

const englishReply = await judgeCase({ ...item, expected_behavior: '用中文指出证据缺口。' }, {
  assistant_texts: ['Please provide the evidence.'],
  turns: targetTurns,
}, targetArchive, async input => ({
  session: { session_id: 'judge-session' },
  archive: archive([
    user('judge-user', input), header([]),
    assistant(JSON.stringify({ verdict: 'passed', reason: '内容符合要求', requirements: JSON.parse(input).requirements.map(requirement => ({ requirement, status: 'satisfied', evidence: [{ index: 0, quote: 'Please' }] })) })), end(1),
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

// 评测轮询会反复导出同一份轨迹；相同内容不得重复改写，避免平台收到无意义的文件变更。
const dedupeDirectory = await mkdtemp(join(tmpdir(), 'dsh-eval-common-dedupe-'))
try {
  const tracePath = join(dedupeDirectory, 'trace.jsonl')
  await saveSessionTrace(dedupeDirectory, targetArchive, { completed: false })
  const firstTrace = await stat(tracePath, { bigint: true })
  const firstContent = await readFile(tracePath, 'utf8')
  await new Promise(resolve => setTimeout(resolve, 10))
  await saveSessionTrace(dedupeDirectory, targetArchive, { completed: false })
  assert.equal((await stat(tracePath, { bigint: true })).mtimeNs, firstTrace.mtimeNs,
    '相同轨迹重复保存不得改写文件')
  assert.equal(await readFile(tracePath, 'utf8'), firstContent)
  await saveSessionTrace(dedupeDirectory, archive([user('changed', '轨迹已变化')]), { completed: true })
  assert.ok((await stat(tracePath, { bigint: true })).mtimeNs > firstTrace.mtimeNs,
    '轨迹内容变化仍必须写入')

  const resultPath = join(dedupeDirectory, 'C-1', 'case-result.json')
  await saveCaseResult(dedupeDirectory, { case_id: 'C-1', verdict: 'passed' })
  const firstResult = await stat(resultPath, { bigint: true })
  await new Promise(resolve => setTimeout(resolve, 10))
  await saveCaseResult(dedupeDirectory, { case_id: 'C-1', verdict: 'passed' })
  assert.equal((await stat(resultPath, { bigint: true })).mtimeNs, firstResult.mtimeNs,
    '相同 Case 回执重复保存不得改写文件')
  await saveCaseResult(dedupeDirectory, { case_id: 'C-1', verdict: 'failed' })
  assert.ok((await stat(resultPath, { bigint: true })).mtimeNs > firstResult.mtimeNs,
    'Case 回执内容变化仍必须写入')
} finally { await rm(dedupeDirectory, { recursive: true, force: true }) }

console.log(JSON.stringify({ status: 'dsh-eval-common-tests-passed', cases: 42 }))
