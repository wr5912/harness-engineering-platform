import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: [new URL('../src/business-control/providers.ts', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { HttpRiskAssessmentProvider } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const request = () => ({
  context: { requestId: 'request-a', subject: { id: 'subject-a', kind: 'human', identitySource: 'https://identity.example' },
    scope: { workspaceId: 'workspace-a', agentId: 'agent-a', instanceId: 'instance-a', runtimeGeneration: 'generation-a',
      subjectId: 'subject-a', sessionId: 'session-a', serverId: 'service-a' }, sourceDigest: 'source-a' },
  action: 'write', resources: [], validatedArgs: { record: 'record-a', value: 'input-a' },
  operationBinding: { serverId: 'service-a', operationId: 'write-record', target: 'https://business.example/records?private=fixture-value', method: 'POST', kind: 'write' },
})
const conditions = () => ({ riskLevels: ['low', 'unknown'], scenarioIds: ['scenario-a'], operationTags: ['sensitive-write'] })
const result = (input, values = {}) => ({ version: 3, scope: { ...input.context.scope }, level: 'low',
  expiresAt: new Date(Date.now() + 60000).toISOString(), constraints: { deniedOperations: [] }, ...values })
const signal = () => new AbortController().signal

async function provider(t, respond, config = {}) {
  const calls = [], received = Promise.withResolvers()
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ method: req.method, path: req.url, contentType: req.headers['content-type'], body })
    received.resolve()
    await respond(body, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const endpoint = `http://127.0.0.1:${server.address().port}/risk`
  return { calls, received: received.promise, endpoint, instance: new HttpRiskAssessmentProvider({ endpoint, timeoutMs: 1000, ...config }) }
}
function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

test('有条件请求真实发送第三方需求，完整保留条件证据并绑定本次操作和输入摘要', async t => {
  const input = { ...request(), conditionRequest: conditions() }
  const evidence = { scenarioIds: ['scenario-b', 'scenario-a', 'scenario-a'], operationTags: ['sensitive-write', 'tag-b'] }
  const response = result(input, { conditionEvidence: evidence,
    operationBinding: { operationId: 'provider-cannot-replace', targetDigest: 'forged', inputDigest: 'forged' } })
  const f = await provider(t, (_body, res) => json(res, response), { testRunId: 'provider-fixture' })
  const fact = await f.instance.assess(input, signal())
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'POST')
  assert.equal(f.calls[0].contentType, 'application/json')
  assert.deepEqual(f.calls[0].body, { testRunId: 'provider-fixture', subjectId: 'subject-a', sessionId: 'session-a',
    operation: 'write', scope: input.context.scope, sourceDigest: 'source-a', operationBinding: input.operationBinding,
    phase: 'execute', input: input.validatedArgs, conditionRequest: input.conditionRequest })
  assert.deepEqual(fact.conditionEvidence, evidence, '不重排、不去重或在本地推断条件')
  assert.deepEqual(fact.operationBinding, { serverId: 'service-a', operationId: 'write-record', method: 'POST', kind: 'write',
    targetDigest: digest(input.operationBinding.target), inputDigest: digest(input.validatedArgs) })
  assert.equal(JSON.stringify(fact).includes('fixture-value'), false, '不把实际目标URL持久化到事实')
  assert.equal(fact.status, 'assessed')
  assert.equal(fact.version, 3)
  assert.equal(fact.source, f.endpoint)
})

test('无条件请求保持既有请求与事实形态，第三方额外的新协议字段不影响旧调用', async t => {
  const input = request()
  const response = result(input, { level: 'high', constraints: { deniedOperations: ['write-record', '*'] }, reasons: ['legacy-reason'],
    conditionEvidence: { scenarioIds: '旧调用忽略未请求的新字段' }, operationBinding: { target: 'untrusted' } })
  const f = await provider(t, (_body, res) => json(res, response))
  const fact = await f.instance.assess(input, signal())
  assert.deepEqual(f.calls[0].body, { subjectId: 'subject-a', sessionId: 'session-a', operation: 'write', scope: input.context.scope,
    sourceDigest: 'source-a', operationBinding: input.operationBinding, phase: 'execute', input: input.validatedArgs })
  assert.deepEqual(Object.keys(fact).sort(), ['id', 'version', 'scope', 'source', 'status', 'level', 'signals', 'observedAt', 'expiresAt'].sort())
  assert.equal(fact.id, `risk-${digest([f.endpoint, fact.scope]).slice(0, 24)}`)
  assert.deepEqual(fact.signals, [{ code: 'deny-operation', value: 'write-record', reason: 'legacy-reason' },
    { code: 'deny-operation', value: '*', reason: 'legacy-reason' }])
  assert.equal(fact.level, 'high')
})

test('同scope的条件事实按本次操作与输入分离ID，同绑定和第三方版本1保持稳定', async t => {
  const input = { ...request(), conditionRequest: conditions() }
  const f = await provider(t, (_body, res) => json(res, result(input, { version: 1, conditionEvidence: { scenarioIds: [] } })))
  const first = await f.instance.assess(input, signal()), repeated = await f.instance.assess(input, signal())
  assert.equal(first.id, repeated.id)
  assert.equal(first.id, `risk-${digest([f.endpoint, first.scope, first.operationBinding]).slice(0, 24)}`)
  input.validatedArgs.value = 'different-input'
  const changedInput = await f.instance.assess(input, signal())
  input.operationBinding.operationId = 'different-tool'
  const changedTool = await f.instance.assess(input, signal())
  assert.equal(new Set([first.id, changedInput.id, changedTool.id]).size, 3)
  for (const fact of [first, repeated, changedInput, changedTool]) {
    assert.equal(fact.version, 1)
    assert.deepEqual(fact.scope, first.scope)
  }
  assert.equal(changedTool.id, (await f.instance.assess(input, signal())).id)
})

test('绑定事实固定本次Session与服务，响应缺省不扩大；legacy仍保留原缺省范围', async t => {
  const input = { ...request(), conditionRequest: conditions() }
  const f = await provider(t, (_body, res) => json(res, result(input, { version: 1, scope: { subjectId: 'subject-a' } })))
  const first = await f.instance.assess(input, signal())
  assert.deepEqual(first.scope, input.context.scope)
  input.context.scope.sessionId = 'session-b'
  const second = await f.instance.assess(input, signal())
  assert.deepEqual(second.scope, input.context.scope)
  assert.notEqual(first.id, second.id, '同主体同操作参数也不能在两个Session共享条件事实ID')
  delete input.conditionRequest
  const legacy = await f.instance.assess(input, signal())
  assert.equal(Object.hasOwn(legacy.scope, 'sessionId'), false)
  assert.equal(Object.hasOwn(legacy.scope, 'serverId'), false)
  assert.equal(Object.hasOwn(legacy, 'operationBinding'), false)
  assert.equal(legacy.id, `risk-${digest([f.endpoint, legacy.scope]).slice(0, 24)}`)
})

test('条件证据缺失、空对象和显式空数组分别保留，不伪造未请求维度', async t => {
  const input = { ...request(), conditionRequest: conditions() }
  let evidence
  const f = await provider(t, (_body, res) => json(res, result(input, evidence === undefined ? {} : { conditionEvidence: evidence })))
  let fact = await f.instance.assess(input, signal())
  assert.equal(Object.hasOwn(fact, 'conditionEvidence'), false)
  for (evidence of [{}, { scenarioIds: [] }, { operationTags: [] }, { scenarioIds: [], operationTags: [] }]) {
    fact = await f.instance.assess(input, signal())
    assert.deepEqual(fact.conditionEvidence, evidence)
    for (const key of ['scenarioIds', 'operationTags']) assert.equal(Object.hasOwn(fact.conditionEvidence, key), Object.hasOwn(evidence, key))
  }
})

test('条件证据只接受有界字符串数组；无效第三方证据拒绝整条事实', async t => {
  const input = { ...request(), conditionRequest: conditions() }
  let evidence
  const f = await provider(t, (_body, res) => json(res, result(input, { conditionEvidence: evidence })))
  const invalid = [null, [], 'scenario-a', { other: [] }, { scenarioIds: null }, { scenarioIds: 'scenario-a' },
    { scenarioIds: [1] }, { scenarioIds: [''] }, { scenarioIds: [' '] }, { scenarioIds: [' leading'] },
    { scenarioIds: ['trailing '] }, { scenarioIds: ['a'.repeat(257)] }, { scenarioIds: Array(65).fill('scenario-a') },
    { operationTags: {} }, { operationTags: [false] }, { operationTags: ['\n'] }, { operationTags: Array(65).fill('tag-a') }]
  for (const value of invalid) {
    evidence = value
    await assert.rejects(f.instance.assess(input, signal()), /风险提供方返回无效条件证据/)
  }
  evidence = { scenarioIds: Array.from({ length: 64 }, (_, index) => `scenario-${index}`), operationTags: ['a'.repeat(256)] }
  assert.deepEqual((await f.instance.assess(input, signal())).conditionEvidence, evidence)
})

test('绑定在HTTP等待前固定，提供方响应或调用方迟到变更不能替换被评估输入', async t => {
  const input = { ...request(), conditionRequest: conditions() }, original = structuredClone(input), reply = Promise.withResolvers()
  const f = await provider(t, async (_body, res) => { await reply.promise; json(res, result(original, { conditionEvidence: { operationTags: [] } })) })
  const pending = f.instance.assess(input, signal())
  await f.received
  input.operationBinding.operationId = 'changed-after-request'
  input.operationBinding.target = 'https://business.example/changed'
  input.validatedArgs.value = 'changed-after-request'
  input.context.scope.sessionId = 'changed-session'
  input.context.scope.serverId = 'changed-service'
  input.context.subject.id = 'changed-subject'
  reply.resolve()
  const fact = await pending
  assert.deepEqual(f.calls[0].body.operationBinding, original.operationBinding)
  assert.deepEqual(f.calls[0].body.input, original.validatedArgs)
  assert.equal(fact.operationBinding.operationId, original.operationBinding.operationId)
  assert.equal(fact.operationBinding.targetDigest, digest(original.operationBinding.target))
  assert.equal(fact.operationBinding.inputDigest, digest(original.validatedArgs))
  assert.deepEqual(fact.scope, original.context.scope)
})

test('无操作绑定的条件评估不伪造绑定，undefined和null输入摘要遵循核心合同', async t => {
  const input = { ...request(), conditionRequest: { riskLevels: ['unknown'] }, validatedArgs: undefined }
  const f = await provider(t, (_body, res) => json(res, result(input, { level: 'unknown' })))
  let fact = await f.instance.assess(input, signal())
  assert.equal(fact.status, 'unknown')
  assert.equal(fact.operationBinding.inputDigest, digest(null))
  input.validatedArgs = null
  fact = await f.instance.assess(input, signal())
  assert.equal(fact.operationBinding.inputDigest, digest(null))
  delete input.operationBinding
  fact = await f.instance.assess(input, signal())
  assert.equal(Object.hasOwn(fact, 'operationBinding'), false)
})

test('新条件协议保留input/report/execute阶段和现有事实有效性检查', async t => {
  const input = { ...request(), conditionRequest: { scenarioIds: ['scenario-a'] } }
  let values = { conditionEvidence: { scenarioIds: ['scenario-a'] } }
  const f = await provider(t, (_body, res) => json(res, result(input, values)))
  for (const [action, phase] of [['input', 'input'], ['publish', 'report'], ['resource', 'execute']]) {
    input.action = action
    const fact = await f.instance.assess(input, signal())
    assert.equal(f.calls.at(-1).body.phase, phase)
    assert.equal(f.calls.at(-1).body.operation, action)
    assert.equal(fact.expiresAt.length > 0, true)
  }
  for (values of [{ scope: { ...input.context.scope, subjectId: 'other-subject' } },
    { scope: { ...input.context.scope, workspaceId: 'other-workspace' } },
    { scope: { ...input.context.scope, runtimeGeneration: 'other-generation' } },
    { expiresAt: new Date(Date.now() - 1000).toISOString() }, { version: -1 }, { level: 'invalid' },
    { constraints: { deniedOperations: [4] } }]) {
    await assert.rejects(f.instance.assess(input, signal()), /风险提供方返回无效事实/)
  }
})

test('HTTP错误与无效JSON保持失败，不生成条件事实', async t => {
  const input = { ...request(), conditionRequest: conditions() }
  let mode = 'http'
  const f = await provider(t, (_body, res) => { if (mode === 'http') json(res, {}, 503); else { res.writeHead(200); res.end('invalid-json') } })
  await assert.rejects(f.instance.assess(input, signal()), /控制提供方不可用/)
  mode = 'json'
  await assert.rejects(f.instance.assess(input, signal()), SyntaxError)
})

test('请求取消与超时中止实际HTTP等待，不产生事实或自动重试', async t => {
  const input = { ...request(), conditionRequest: conditions() }
  const f = await provider(t, () => {})
  const controller = new AbortController(), pending = f.instance.assess(input, controller.signal)
  await f.received
  controller.abort(new Error('fixture-cancelled'))
  await assert.rejects(pending, /fixture-cancelled/)
  assert.equal(f.calls.length, 1)
  const timed = await provider(t, () => {}, { timeoutMs: 25 })
  await assert.rejects(timed.instance.assess(input, signal()), error => error.name === 'TimeoutError')
  assert.equal(timed.calls.length, 1)
})
