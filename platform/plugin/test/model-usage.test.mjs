import assert from 'node:assert/strict'
import test from 'node:test'
import { extractGraphExecutions, measureModelUsage, normalizeTokenUsage } from '../src/evaluation/model-usage.ts'
import { observeLlm } from '../src/evaluation/model-attempts.ts'

const usage = { inputTokens: 5, outputTokens: 2, totalTokens: 7 }
const event = (type, data = {}) => ({ type, data })
function trace(id, body, path = '/run/evidence/U-CASE-001/trace.jsonl', seeded = false) {
  return { path, rows: [{ session_log: 'session.v4.jsonl', event: { type: 'session', id, isSeeded: seeded } },
    ...body.map((item, seq) => ({ session_log: 'session.v4.jsonl', event: { ...item, seq } }))] }
}
function turn(turn = 1, steps = 1) {
  return [event('turn/start', { turn }), ...Array.from({ length: steps }, (_, index) => {
    const step = index + 1
    return [event('step/start', { turn, step }), ...(step === 1 ? [event('request/header')] : []),
      event('assistant/message', { turn, step, usage }), event('step/end', { turn, step })]
  }).flat(), event('turn/end', { turn })]
}

test('原生尝试结算覆盖多Step；相同配置头只有一次也能计数，重复导出不重复收费', () => {
  const input = trace('target', turn(1, 2))
  const result = measureModelUsage([input, input])
  assert.equal(result.actual_model_calls, 2)
  assert.equal(result.observed_model_calls, 2)
  assert.deepEqual(result.token_usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 })
  assert.equal(result.hard_cap_supported, false)
})

test('失败重试、业务与评审同名导出文件按真正Session ID分别统计', () => {
  const target = trace('target', [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }),
    event('assistant/attempt', { turn: 1, step: 1, stream: [{ chunk: { type: 'usage', usage } }] }),
    event('llm/retry', { turn: 1, step: 1 }), event('llm/retry-started', { turn: 1, step: 1 }),
    event('assistant/message', { turn: 1, step: 1, usage }), event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1 })])
  const judge = trace('judge', turn(), '/run/evidence/U-CASE-001/judge-trace.jsonl')
  const result = measureModelUsage([target, judge])
  assert.equal(result.actual_model_calls, 3)
  assert.equal(result.failed_model_calls, 1)
  assert.deepEqual(result.model_calls_by_role, { target: 2, judge: 1, analysis: 0 })
})

const emptyAttempt = () => event('assistant/attempt', { turn: 2, step: 1, stream: [] })
const delivery = (sessionId = 'failed', throughSeq = 6, sessionFormatVersion = 4) =>
  event('session-log-deepseek/delivery-accepted', { sessionId, throughSeq, sessionFormatVersion })
function failedTurn(body) {
  return trace('failed', [...turn(), event('turn/start', { turn: 2 }), event('step/start', { turn: 2, step: 1 }),
    ...body, event('step/end', { turn: 2, step: 1 }), event('turn/end', { turn: 2 })])
}

test('空attempt可能来自Provider前的中间件失败，既不补成一次调用也不按零结算', () => {
  const input = failedTurn([emptyAttempt()])
  const result = measureModelUsage([input, input])
  assert.equal(result.actual_model_calls, null)
  assert.equal(result.observed_model_calls, 1)
  assert.equal(result.failed_model_calls, null)
  assert.equal(result.observed_failed_model_calls, 0)
  assert.ok(result.model_calls_unknown_reasons.includes('attempt-invocation-unproven'))
  assert.equal(result.token_usage, null)
  assert.deepEqual(result.observed_token_usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
})

test('HTTP接受证明空失败已调用；其它Session、旧水位、错误代次不能替代当次发出证据', () => {
  // turn() 占 seq0..5，失败 Step 从 seq7 开始，标记必须覆盖本次边界。
  const result = measureModelUsage([failedTurn([delivery('failed', 7), emptyAttempt()])])
  assert.equal(result.actual_model_calls, 2)
  assert.equal(result.failed_model_calls, 1)
  assert.equal(result.token_usage, null, '失败没有供应商Token结算，不能按零补齐')
  for (const marker of [delivery('other', 7), delivery('failed', 5), delivery('failed', 7, 3), delivery('failed', 8)]) {
    const invalid = measureModelUsage([failedTurn([marker, emptyAttempt()])])
    assert.equal(invalid.actual_model_calls, null)
    assert.equal(invalid.observed_model_calls, 1)
  }
  const auxiliary = measureModelUsage([failedTurn([titleRequest(), delivery('failed', 8), emptyAttempt(), titleResult()])])
  assert.equal(auxiliary.actual_model_calls, null, '只有Session身份的并发标题接受标记不能归到主尝试')
  assert.equal(auxiliary.observed_model_calls, 2)
})

test('匹配retry证明前次空失败；retry-started不证明新调用，也不复用上次HTTP接受', () => {
  const retry = [event('llm/retry', { turn: 2, step: 1 }), event('llm/retry-started', { turn: 2, step: 1 })]
  const completed = measureModelUsage([failedTurn([emptyAttempt(), ...retry, event('assistant/message', { turn: 2, step: 1, usage })])])
  assert.equal(completed.actual_model_calls, 3)
  assert.equal(completed.failed_model_calls, 1)
  assert.deepEqual(completed.observed_token_usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 })
  for (const prefix of [[], [delivery('failed', 7)]]) {
    const unresolved = measureModelUsage([failedTurn([...prefix, emptyAttempt(), ...retry, emptyAttempt()])])
    assert.equal(unresolved.actual_model_calls, null)
    assert.equal(unresolved.observed_model_calls, 2)
    assert.equal(unresolved.observed_failed_model_calls, 1)
    assert.ok(unresolved.model_calls_unknown_reasons.includes('attempt-invocation-unproven'))
  }
  const invalid = measureModelUsage([failedTurn([emptyAttempt(), event('llm/retry', { turn: 2, step: 2 })])])
  assert.equal(invalid.actual_model_calls, null)
  assert.equal(invalid.observed_model_calls, 1)
})

test('已发出但未结算的请求保留下界，retry-started后尚未发出不补造新调用', () => {
  const open = trace('failed', [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }), delivery('failed', 1)])
  const result = measureModelUsage([open, open])
  assert.equal(result.actual_model_calls, null)
  assert.equal(result.observed_model_calls, 1)
  assert.equal(result.observed_failed_model_calls, 0)
  assert.ok(result.model_calls_unknown_reasons.includes('request-lifecycle-in-progress'))
  const retry = measureModelUsage([failedTurn([emptyAttempt(), event('llm/retry', { turn: 2, step: 1 }), event('llm/retry-started', { turn: 2, step: 1 })])])
  assert.equal(retry.actual_model_calls, null)
  assert.equal(retry.observed_model_calls, 2)
  assert.equal(retry.observed_failed_model_calls, 1)
})

test('显式已调用或实际流chunk证明失败调用，显式本地失败不凭错误文本猜远程请求', () => {
  for (const attempt of [event('assistant/attempt', { turn: 2, step: 1, stream: [], model_invocation: true }),
    event('assistant/attempt', { turn: 2, step: 1, stream: [{ chunk: { type: 'finish', reason: { kind: 'error' } } }] })]) {
    const result = measureModelUsage([failedTurn([attempt])])
    assert.equal(result.actual_model_calls, 2)
    assert.equal(result.failed_model_calls, 1)
    assert.equal(result.token_usage, null)
  }
  const local = measureModelUsage([failedTurn([event('assistant/attempt', { turn: 2, step: 1, stream: [], model_invocation: false })])])
  assert.equal(local.actual_model_calls, 1)
  assert.equal(local.failed_model_calls, 0)
  assert.deepEqual(local.token_usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
})

test('缺失失败结算或在途请求保留unknown，同时保留已观察请求下界', () => {
  const input = trace('target', [...turn(), event('turn/start', { turn: 2 }), event('step/start', { turn: 2, step: 1 })])
  const result = measureModelUsage([input])
  assert.equal(result.actual_model_calls, null)
  assert.equal(result.observed_model_calls, 1)
  assert.ok(result.model_calls_unknown_reasons.includes('request-lifecycle-in-progress'))
  const failed = trace('target', [event('turn/start', { turn: 1 }), event('step/start', { turn: 1, step: 1 }),
    event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1 })])
  assert.equal(measureModelUsage([failed]).actual_model_calls, null)
})

test('明确标记的一次压缩请求计入，失败或未知压缩不猜测调用数', () => {
  const compact = trace('analysis', [event('compaction/start', { compactionId: 'compact' }),
    event('compaction/summary', { compactionId: 'compact', llmStreamCall: true, usage }),
    event('compaction/end', { compactionId: 'compact' }), ...turn()], '/run/evidence/analysis/scene-01/attempt-01/trace.jsonl')
  const result = measureModelUsage([compact])
  assert.equal(result.actual_model_calls, 2)
  assert.equal(result.model_calls_by_role.analysis, 2)
  const failed = trace('failed', [event('compaction/start', { compactionId: 'compact' }), event('compaction/end', { compactionId: 'compact', error: 'failed' })])
  assert.equal(measureModelUsage([failed]).actual_model_calls, null)
})

test('fork继承的历史请求不再次计数，缺Token用量不伪造费用', () => {
  const old = turn()
  const fresh = turn(2)
  const child = trace('child', [...old, event('session/end-seed', { inherited: true }), ...fresh], '/run/evidence/U-CASE-001/trace.jsonl', true)
  const result = measureModelUsage([trace('parent', old), child])
  assert.equal(result.actual_model_calls, 2)
  const noUsage = trace('no-usage', turn().map(item => item.type === 'assistant/message' ? event(item.type, { turn: 1, step: 1 }) : item))
  assert.equal(measureModelUsage([noUsage]).actual_model_calls, 1)
  assert.equal(measureModelUsage([noUsage]).token_usage, null)
})

const titleRequest = () => event('session/title-llm-request', { titleProvider: 'first-prompt', messageSeqs: [2], route: { provider: 'provider', model: 'model' } })
const titleResult = () => event('session/title', { messageSeqs: [2], source: { kind: 'provider', provider: 'first-prompt', model: { provider: 'provider', model: 'model' } } })

test('业务和评审的成功辅助标题计入角色总数，重复导出不重复计且总Token保持未知', () => {
  const target = trace('target-title', [titleRequest(), ...turn(), titleResult()])
  const judge = trace('judge-title', [titleRequest(), ...turn(), titleResult()], '/run/evidence/U-CASE-001/judge-trace.jsonl')
  const result = measureModelUsage([target, judge, target])
  assert.equal(result.actual_model_calls, 4)
  assert.equal(result.auxiliary_model_calls, 2)
  assert.equal(result.auxiliary_requests_observed, 2)
  assert.deepEqual(result.model_calls_by_role, { target: 2, judge: 2, analysis: 0 })
  assert.equal(result.token_usage, null)
  assert.equal(result.token_usage_complete, false)
  assert.deepEqual(result.observed_token_usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 })
})

test('辅助标题只有预发送记录时不假定已发出或失败为零，保留主请求观测下界', () => {
  const result = measureModelUsage([trace('unsettled-title', [titleRequest(), ...turn()])])
  assert.equal(result.actual_model_calls, null)
  assert.equal(result.observed_model_calls, 1)
  assert.equal(result.auxiliary_model_calls, 0)
  assert.equal(result.failed_model_calls, null)
  assert.ok(result.model_calls_unknown_reasons.includes('auxiliary-title-request-outcome-missing'))
  assert.equal(result.token_usage, null)
  assert.deepEqual(result.observed_token_usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
  const retry = measureModelUsage([trace('title-retry', [titleRequest(), titleRequest(), ...turn(), titleResult()])])
  assert.equal(retry.actual_model_calls, null)
  assert.equal(retry.observed_model_calls, 2)
  const preparing = measureModelUsage([trace('title-preparing', [event('session/title', { source: { kind: 'fallback' } }), ...turn()])])
  assert.equal(preparing.actual_model_calls, null, '标题仍在prepareCall且尚未写请求记录，主Turn结束也不能宣称总调用已封闭')
  assert.equal(preparing.observed_model_calls, 1)
})

test('手动固定标题不增加模型调用，fork继承标题不重算', () => {
  const manual = trace('case-title', [event('session/title', { title: 'U-CASE-001', source: { kind: 'user' } }), ...turn()])
  assert.equal(measureModelUsage([manual]).actual_model_calls, 1)
  const child = trace('child-title', [titleRequest(), titleResult(), event('session/end-seed', { inherited: true }), ...turn()], '/run/evidence/U-CASE-001/trace.jsonl', true)
  assert.equal(measureModelUsage([child]).auxiliary_model_calls, 0)
})

test('受控本地交付不算模型调用；未知provider没有用量仍计调用并保留Token未知', () => {
  const withRoute = route => trace('local', turn().map(item => item.type === 'request/header'
    ? event(item.type, { header: { config: route } }) : item.type === 'assistant/message' ? event(item.type, { turn: 1, step: 1 }) : item))
  for (const route of [{ provider: 'threat-analysis-delivery', model: 'fixed-summary' }, { provider: 'harness-code-only', model: 'workflow-v1', reasoningEffort: 'off' }, { provider: 'harness-workflow', model: 'hybrid-v1', reasoningEffort: 'off' }]) {
    const local = measureModelUsage([withRoute(route)])
    assert.equal(local.actual_model_calls, 0)
    assert.equal(local.model_calls_complete, true)
    assert.deepEqual(local.token_usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  }
  const unknown = measureModelUsage([withRoute({ provider: 'unknown-local-looking-provider', model: 'fixed-summary' })])
  assert.equal(unknown.actual_model_calls, 1)
  assert.equal(unknown.token_usage, null)
})

test('统一Token桶核对缓存、reasoning与缺失aggregate，缓存命中不是零输入', () => {
  assert.deepEqual(normalizeTokenUsage({ inputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3, outputTokens: 10, reasoningTokens: 7, totalTokens: 38 }), { input: 28, output: 10, total: 38 })
  assert.deepEqual(normalizeTokenUsage({ inputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3, outputTokens: 10 }), { input: 28, output: 10, total: null })
  assert.equal(normalizeTokenUsage({ inputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3, outputTokens: 10, totalTokens: 40 }), null)
  assert.equal(normalizeTokenUsage({ inputTokens: 20, outputTokens: 10, reasoningTokens: 11, totalTokens: 30 }), null)
})

test('prepared observer透传原生调用，累计usage只结算最后快照且原始事实不含输入或错误秘密', async () => {
  const records = [], config = { provider: 'real', model: 'model' }, signal = new AbortController().signal
  const preparedConfig = { ...config, model: 'resolved' }, request = { ...preparedConfig, signal, messages: [{ content: 'private-prompt' }] }
  const model = { async prepareCall(actual, receivedSignal) {
    assert.equal(actual, config); assert.equal(receivedSignal, signal)
    return { config: preparedConfig, async *stream(actualRequest) {
      assert.equal(actualRequest, request)
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'usage', usage: { ...usage, private_key: 'private-extra-field' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } }
  const observed = observeLlm(model, { execution_id: 'graph-one', role: 'target', recordAttempt() {} }, row => { records.push(structuredClone(row)) })
  const call = await observed.prepareCall(config, signal)
  for await (const chunk of call.stream(request)) assert.ok(chunk.type)
  const result = measureModelUsage([], { attempts: [...records, ...records], requireSessionTrace: false })
  assert.equal(result.actual_model_calls, 1)
  assert.deepEqual(result.token_usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
  assert.equal(records.at(-1).model, 'resolved')
  assert.equal(records.at(-1).model_invocation, true)
  assert.doesNotMatch(JSON.stringify(records), /private-prompt|private-extra-field|recordAttempt/)
  const failure = []
  const failing = observeLlm({ async prepareCall() { throw new Error('private-key-in-error') } }, { execution_id: 'prepare-failed' }, row => { failure.push(row) })
  await assert.rejects(() => failing.prepareCall(config, signal), /private-key-in-error/)
  assert.equal(measureModelUsage([], { attempts: failure, requireSessionTrace: false }).actual_model_calls, 0)
  assert.doesNotMatch(JSON.stringify(failure), /private-key-in-error/)
})

test('prepare成功后stream在Provider前失败或取消保留尝试，但实际调用数仍为未知下界', async () => {
  for (const kind of ['middleware', 'cancelled', 'local-error-finish']) {
    const attempts = [], controller = new AbortController()
    const model = observeLlm({ async prepareCall() { return { config: { provider: 'real', model: 'model' }, async *stream() {
      if (kind === 'cancelled') { controller.abort(); controller.signal.throwIfAborted() }
      if (kind === 'local-error-finish') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'LOCAL_INPUT_INVALID' } } }; return }
      throw new Error('中间件在Provider派发前失败')
    } } } }, { execution_id: `pre-dispatch-${kind}` }, row => attempts.push(row))
    const prepared = await model.prepareCall({}, controller.signal)
    try { for await (const _chunk of prepared.stream({ signal: controller.signal })) {} } catch {}
    assert.deepEqual(attempts.map(row => row.status), ['preparing', 'started', kind === 'cancelled' ? 'cancelled' : 'failed'])
    const result = measureModelUsage([], { attempts, requireSessionTrace: false })
    assert.equal(result.actual_model_calls, null)
    assert.equal(result.observed_model_calls, 0)
    assert.equal(result.failed_model_calls, null)
    assert.equal(result.token_usage, null)
    assert.ok(result.model_calls_unknown_reasons.includes('graph-attempt-invocation-unproven'))
    assert.equal(attempts.at(-1).model_invocation, undefined, '未证明已派发也未证明零调用')
  }
})

test('图内错误响应和取消只有保留实际Provider证据时才计入调用下界', async () => {
  for (const kind of ['http-error', 'request-id', 'chunk-then-error', 'consumer-close']) {
    const attempts = []
    const model = observeLlm({ async prepareCall() { return { config: {}, async *stream() {
      if (kind === 'http-error' || kind === 'request-id') {
        yield { type: 'finish', reason: { kind: 'error', failure: kind === 'http-error' ? { status: 503 } : { requestId: 'provider-request' } } }; return
      }
      yield { type: 'text-delta', text: '实际响应' }
      throw new Error('响应中断')
    } } } }, { execution_id: `proven-${kind}` }, row => attempts.push(row))
    const prepared = await model.prepareCall({})
    try { for await (const _chunk of prepared.stream({})) { if (kind === 'consumer-close') break } } catch {}
    assert.equal(attempts.at(-1).model_invocation, true)
    const result = measureModelUsage([], { attempts, requireSessionTrace: false })
    assert.equal(result.actual_model_calls, 1)
    assert.equal(result.failed_model_calls, 1)
    assert.equal(result.token_usage, null)
  }
})

function graphTrace(overrides = {}, attemptOverrides = {}) {
  const identity = { execution_id: 'graph-a', session_id: 'target-graph', tool_call_id: 'call-a', role: 'target' }
  const model_attempts = [{ ...identity, attempt_id: 'attempt-a', time: 1, status: 'started', ...attemptOverrides },
    { ...identity, attempt_id: 'attempt-a', time: 2, status: 'completed', usage, ...attemptOverrides }]
  const graph_execution = { ...identity, complete: true, model_attempts, ...overrides }
  return trace('target-graph', [...turn(), event('tool/call', { callId: 'call-a', name: 'workflow' }),
    event('tool/result', { meta: { graph_execution }, message: { source: { callId: 'call-a' }, content: [{ type: 'text', text: JSON.stringify({ graph_execution }) }] } })])
}

test('原始工具回执验证Session/call关联，meta与JSON重复图事实和重复导出只计一次', () => {
  const input = graphTrace()
  const graph = extractGraphExecutions(input.rows)
  assert.equal(graph.executions.length, 1)
  assert.deepEqual(graph.unknown_reasons, [])
  const result = measureModelUsage([input, input], { attempts: graph.attempts })
  assert.equal(result.actual_model_calls, 2)
  assert.deepEqual(result.token_usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 })
  assert.equal(measureModelUsage([graphTrace({ session_id: 'other' })]).actual_model_calls, null)
  assert.equal(measureModelUsage([graphTrace({ complete: false })]).actual_model_calls, null)
  assert.equal(measureModelUsage([graphTrace({}, { tool_call_id: 'another-call' })]).actual_model_calls, null)
})

test('已证明派发的图内失败和取消仍计调用，无usage不当零；未结算与相同ID冲突保留未知', () => {
  const start = { attempt_id: 'one', execution_id: 'graph', role: 'target', time: 1, status: 'started', model_invocation: true }
  const failed = { ...start, time: 2, status: 'cancelled' }
  const result = measureModelUsage([], { attempts: [start, failed], requireSessionTrace: false })
  assert.equal(result.actual_model_calls, 1); assert.equal(result.failed_model_calls, 1); assert.equal(result.token_usage, null)
  assert.equal(measureModelUsage([], { attempts: [start], requireSessionTrace: false }).actual_model_calls, null)
  assert.equal(measureModelUsage([], { attempts: [start, failed, { ...failed, status: 'completed', usage }], requireSessionTrace: false }).actual_model_calls, null)
})

test('fork继承的图保持父身份且不重新关联收费，新图只计seed分界之后', () => {
  const parent = graphTrace()
  const inherited = parent.rows.filter(row => row.event.type !== 'session').map(row => { const { seq, ...event } = row.event; return event })
  const graph_execution = { execution_id: 'child-graph', session_id: 'child-session', tool_call_id: 'new-call', complete: true, model_attempts: [] }
  const child = trace('child-session', [...inherited, event('session/end-seed', { inherited: true }), ...turn(2),
    event('tool/call', { callId: 'new-call', name: 'workflow' }), event('tool/result', { meta: { graph_execution }, message: { source: { callId: 'new-call' } } })], '/run/evidence/U-CASE-002/trace.jsonl', true)
  const graphs = extractGraphExecutions(child.rows)
  assert.deepEqual(graphs.unknown_reasons, [])
  assert.deepEqual(graphs.executions.map(item => item.execution_id), ['child-graph'])
  assert.equal(extractGraphExecutions(parent.rows).executions[0].session_id, 'target-graph')
  const result = measureModelUsage([parent, child, child])
  assert.equal(result.actual_model_calls, 3, '父版原生1+图内1，子版仅新原生1')
  const missing = trace('child-without-boundary', [...inherited, ...turn(2)], '/run/evidence/U-CASE-002/trace.jsonl', true)
  assert.ok(extractGraphExecutions(missing.rows).unknown_reasons.includes('seed-boundary-missing'))
  assert.equal(extractGraphExecutions(missing.rows).executions.length, 0)
  assert.equal(measureModelUsage([missing]).actual_model_calls, null)
})

test('原生嵌套工具trace的子图按各自call身份递归计量，关联错误不按零', () => {
  const identity = { execution_id: 'child-graph', session_id: 'target-graph', tool_call_id: 'child-call', role: 'target' }
  const child = { ...identity, complete: true, model_attempts: [
    { ...identity, attempt_id: 'child-attempt', time: 1, status: 'started' },
    { ...identity, attempt_id: 'child-attempt', time: 2, status: 'completed', usage },
  ] }
  const parent = graphTrace({ trace: [{ call_id: 'child-call', meta: { graph_execution: child } }] })
  assert.equal(extractGraphExecutions(parent.rows).executions.length, 2)
  assert.equal(measureModelUsage([parent, parent]).actual_model_calls, 3)
  assert.equal(measureModelUsage([graphTrace({ trace: [{ call_id: 'wrong', meta: { graph_execution: child } }] })]).actual_model_calls, null)
  assert.equal(measureModelUsage([graphTrace({ trace: {} })]).actual_model_calls, null)
  assert.equal(measureModelUsage([graphTrace({ model_attempts: [null] })]).actual_model_calls, null)
})
