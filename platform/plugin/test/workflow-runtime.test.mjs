import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { measureModelUsage } from '../src/evaluation/model-usage.ts'

const directory = mkdtempSync(join(tmpdir(), 'workflow-runtime-test-'))
const file = join(directory, 'runtime.mjs')
await build({ entryPoints: [new URL('../src/workflows/runtime.ts', import.meta.url).pathname], outfile: file, bundle: true,
  platform: 'node', format: 'esm', banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require=__createRequire(import.meta.url);` } })
const { defineWorkflow, registerWorkflowTool, registerCodeOnlyWorkflowAgent, registerHybridWorkflowAgent, runWorkflow, LlmError, attributionHeaders } = await import(`file://${file}`)
const modelRoles = {
  language: { provider: 'qwen', model: 'qwen3.5-2b', reasoning_effort: 'off' },
  decision: { provider: 'kev', model: 'kev-0.8b', reasoning_effort: 'off', checkpoint_sha256: 'a'.repeat(64), state_constructor_sha256: 'b'.repeat(64), calibration_sha256: 'c'.repeat(64) },
}

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const sdk = name => import(pathToFileURL(sdkRequire.resolve(name)).href)
const [{ Context }, { ToolRuntime }, { SystemPrompt }, { createScope }, { LlmRuntime }] = await Promise.all([
  sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-tools'), sdk('@deepseek-ai/dsh-system-prompt'), sdk('@deepseek-ai/dsh-scope'), sdk('@deepseek-ai/dsh-llm'),
])
test.after(() => rmSync(directory, { recursive: true, force: true }))
test('生成适配器复用锁定Runtime的真实Provider错误事实和归属头', () => {
  const failure = new LlmError('模型服务返回失败', 'PROVIDER_FAILURE', { status: 503, requestId: 'actual-response-id' })
  assert.equal(failure.failure.status, 503)
  assert.equal(failure.failure.requestId, 'actual-response-id')
  const headers = attributionHeaders()
  assert.ok(headers && typeof headers === 'object' && Object.keys(headers).length > 0)
})

function fixture(dispatch, llm) {
  let tool
  const ctx = { tools: { register(value) { tool = value }, execute: dispatch }, llm }
  const identity = { callId: 'outer', rootCallId: 'outer-root', token: Symbol('native'), agent: { session: { id: 'session-real' } }, signal: new AbortController().signal }
  return { ctx, identity, tool: () => tool }
}
test('真实 LangGraph 执行两步原生子工具，传递参数和身份并保留ESM来源', async () => {
  const calls = [], f = fixture(async input => {
    calls.push(input)
    return { isError: false, value: input.name === 'get_asset' ? { id: 'asset-17' } : { alerts: [{ id: 'alert-9' }] }, content: [] }
  })
  registerWorkflowTool(f.ctx, defineWorkflow({ id: 'asset-alerts', toolName: 'query_asset_alerts', description: '查询', inputSchema: { type: 'object' },
    async run(context) { return runWorkflow(context, [
      { id: 'asset', run: (_values, current) => current.callTool('get_asset', { asset: current.input.asset }) },
      { id: 'alerts', run: (values, current) => current.callTool('list_alerts', { assetId: values.asset.id }) },
    ]) } }))
  const result = await f.tool().execute({ asset: '主机' }, f.identity)
  assert.equal(result.ok, true)
  assert.equal(result.result.alerts.alerts[0].id, 'alert-9')
  assert.deepEqual(calls.map(input => input.arguments), [{ asset: '主机' }, { assetId: 'asset-17' }])
  for (const input of calls) { assert.equal(input.parent, f.identity.token); assert.equal(input.rootCallId, 'outer-root'); assert.equal(input.agent, f.identity.agent); assert.equal(input.signal, f.identity.signal) }
  assert.equal(result.graph_execution.complete, true)
  assert.deepEqual(result.graph_execution.model_attempts, [])
  assert.equal(result.graph_execution.esm_sha256, createHash('sha256').update(readFileSync(file)).digest('hex'))
  assert.equal(f.tool().output.presentationMeta({}, result).graph_execution.execution_id, result.graph_execution.execution_id)
})
test('上游失败或取消停止后继节点，失败回执仍保留图证据', async () => {
  let calls = 0
  const f = fixture(async () => { calls++; return { isError: true, error: { code: 'BUSINESS_FAILED' }, content: [] } })
  registerWorkflowTool(f.ctx, defineWorkflow({ id: 'fail', toolName: 'fail', description: '失败', inputSchema: { type: 'object' },
    run: context => runWorkflow(context, [{ id: 'first', run: (_v, c) => c.callTool('first', {}) }, { id: 'second', run: (_v, c) => c.callTool('second', {}) }]) }))
  const value = await f.tool().execute({}, f.identity)
  assert.equal(value.ok, false); assert.equal(calls, 1)
  assert.equal(value.graph_execution.status, 'failed')
  assert.equal(value.graph_execution.trace[0].result.error.code, 'BUSINESS_FAILED')
  const aborted = new AbortController(); aborted.abort()
  assert.equal((await f.tool().execute({}, { ...f.identity, signal: aborted.signal })).graph_execution.status, 'cancelled')
  assert.equal(calls, 1)
})
test('图内模型请求保留同一次attempt及真实usage，不能隐藏在工具内', async () => {
  let preparations = 0
  const f = fixture(async () => assert.fail('没有工具调用'), { async prepareCall(config) {
    preparations++; return { config, async *stream() { yield { type: 'text-delta', text: '实际模型结果' }; yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  } })
  registerWorkflowTool(f.ctx, defineWorkflow({ id: 'infer', toolName: 'infer', description: '推理', inputSchema: { type: 'object' },
    run: context => context.infer({ provider: 'provider-real', model: 'model-real' }, { messages: [{ role: 'user', content: [] }] }) }))
  const value = await f.tool().execute({}, f.identity)
  assert.equal(preparations, 1); assert.equal(value.ok, true)
  const attempts = value.graph_execution.model_attempts
  assert.deepEqual(attempts.map(item => item.status), ['preparing', 'started', 'completed'])
  assert.equal(new Set(attempts.map(item => item.attempt_id)).size, 1)
  assert.equal(attempts.at(-1).usage.totalTokens, 11)
  assert.equal(attempts.at(-1).session_id, 'session-real')
})

function nativeFixture(t, llm) {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, { mode: 'native' })
  const agent = { id: 'workflow-agent', session: { id: 'workflow-session' } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(async () => { await scope.dispose(); await ctx.fiber.dispose() })
  let call = 0
  return { ctx, registration: { tools: ctx.tools, llm }, agent,
    execute: name => ctx.tools.execute({ name, arguments: {}, callId: `native-workflow-${++call}`, agent, signal: new AbortController().signal }),
    register(name, execute) { ctx.tools.register({ name, description: '真实原生边界测试', parameters: { type: 'object' },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute }) },
  }
}

test('真实Cordis仅注入tools可执行确定性图，infer才要求llm且纯代码限制优先', async t => {
  const f = nativeFixture(t)
  await f.ctx.plugin(LlmRuntime)
  f.register('tools_only_child', args => ({ quantity: args.quantity }))
  let registration, forbidden
  await f.ctx.plugin({ name: 'workflow-tools-only', inject: ['tools'], apply(ctx) {
    registration = ctx
    registerWorkflowTool(ctx, defineWorkflow({ id: 'tools-only', toolName: 'tools_only_graph', description: '零模型图', inputSchema: { type: 'object' },
      async run(context) {
        const value = await context.callTool('tools_only_child', { quantity: 12 })
        return { route: value.quantity >= 10 ? 'bulk' : 'regular' }
      } }))
    registerWorkflowTool(ctx, defineWorkflow({ id: 'tools-only-infer', toolName: 'tools_only_infer', description: '缺少模型注入', inputSchema: { type: 'object' },
      run: context => context.infer({ provider: 'not-dispatched', model: 'not-dispatched' }, { messages: [] }) }))
    registerWorkflowTool(ctx, defineWorkflow({ id: 'tools-only-forbidden', toolName: 'tools_only_forbidden', description: '纯代码限制', inputSchema: { type: 'object' },
      async run(context) {
        try { return await context.infer({}, { messages: [] }) } catch (error) { forbidden = error.message; throw error }
      } }), { executionMode: 'code-only' })
  } })
  assert.throws(() => registration.llm, /cannot get property "llm" without inject/)
  const result = await f.execute('tools_only_graph')
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value.ok, true)
  assert.deepEqual(result.value.result, { route: 'bulk' })
  assert.equal(result.value.graph_execution.trace[0].node, 'tools_only_child')
  assert.deepEqual(result.value.graph_execution.model_attempts, [])
  const missing = (await f.execute('tools_only_infer')).value
  assert.equal(missing.ok, false); assert.equal(missing.error_code, 'WORKFLOW_MODEL_UNAVAILABLE')
  assert.match(missing.error, /使用 infer 的插件需要声明 llm 注入/)
  assert.equal(missing.graph_execution.status, 'failed'); assert.deepEqual(missing.graph_execution.model_attempts, [])
  const rejected = (await f.execute('tools_only_forbidden')).value
  assert.equal(rejected.ok, false); assert.equal(forbidden, '纯代码工作流禁止模型调用')
  assert.deepEqual(rejected.graph_execution.model_attempts, [])
})

test('真实ToolRuntime拒绝业务undefined；工作流返回明确失败并保留两次原生子调用图回执', async t => {
  const f = nativeFixture(t), calls = []
  const invalidResult = { steps: [{ operation: 'get_asset', detail: undefined }] }
  f.register('invalid_direct', () => invalidResult)
  const rejected = await f.execute('invalid_direct')
  assert.equal(rejected.isError, true)
  assert.equal(rejected.error.info?.code, 'INVALID_TOOL_OUTPUT', JSON.stringify(rejected))
  assert.match(rejected.error.message, /value is not lossless JSON/)
  for (const name of ['get_asset', 'list_alerts']) f.register(name, (_args, exec) => {
    calls.push({ name, parent: exec.parent, root: exec.rootCallId }); return { status: 200, json: { code: 200 } }
  })
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'invalid-result', toolName: 'invalid_workflow', description: '校验业务输出', inputSchema: { type: 'object' },
    async run(context) {
      await context.callTool('get_asset', {})
      await context.callTool('list_alerts', {})
      return invalidResult
    } }))
  const result = await f.execute('invalid_workflow')
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.ok, false)
  assert.equal(result.value.error_code, 'WORKFLOW_INVALID_RESULT')
  assert.equal(Object.hasOwn(result.value, 'result'), false, '不能静默删除undefined后把原业务值作为成功结果')
  assert.equal(result.value.graph_execution.status, 'failed')
  assert.equal(result.value.graph_execution.complete, true)
  assert.equal(result.value.graph_execution.session_id, 'workflow-session')
  assert.equal(result.value.graph_execution.tool_call_id, 'native-workflow-2')
  assert.deepEqual(result.value.graph_execution.trace.map(row => row.node), ['get_asset', 'list_alerts'])
  assert.deepEqual(result.value.graph_execution.model_attempts, [])
  assert.equal(result.meta.graph_execution.execution_id, result.value.graph_execution.execution_id)
  assert.equal(calls.length, 2)
  for (const call of calls) { assert.ok(call.parent); assert.equal(call.root, 'native-workflow-2') }
})

test('真实ToolRuntime保留合法结果与原生失败，非JSON业务值不能经字符串化伪装成功', async t => {
  const f = nativeFixture(t)
  f.register('native_failed', () => { throw new Error('受控子工具失败') })
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'child-failed', toolName: 'child_failed_workflow', description: '失败图', inputSchema: { type: 'object' },
    run: context => context.callTool('native_failed', {}) }))
  const failed = await f.execute('child_failed_workflow')
  assert.equal(failed.isError, false, JSON.stringify(failed))
  assert.equal(failed.value.ok, false)
  assert.equal(failed.value.graph_execution.trace[0].status, 'failed')
  assert.equal(failed.value.graph_execution.trace[0].result.error.message, '受控子工具失败')
  const cycle = {}; cycle.self = cycle
  for (const [index, value] of [undefined, { detail: undefined }, [undefined], NaN, Infinity, -0, 1n, new Date(0), cycle].entries()) {
    const name = `invalid_value_${index}`
    registerWorkflowTool(f.registration, defineWorkflow({ id: name, toolName: name, description: '无损校验', inputSchema: { type: 'object' }, async run() { return value } }))
    const result = await f.execute(name)
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.equal(result.value.error_code, 'WORKFLOW_INVALID_RESULT')
    assert.equal(result.value.graph_execution.status, 'failed')
  }
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'valid', toolName: 'valid_workflow', description: '合法图', inputSchema: { type: 'object' },
    async run() { return { detail: null, steps: [], total: 0 } } }))
  const success = await f.execute('valid_workflow')
  assert.equal(success.isError, false, JSON.stringify(success))
  assert.equal(success.value.ok, true)
  assert.deepEqual(success.value.result, { detail: null, steps: [], total: 0 })
})

test('真实ToolRuntime接收图内默认路由的attempt，未指定的观察字段不制造undefined输出', async t => {
  const f = nativeFixture(t, { async prepareCall() { return { config: { provider: 'actual-provider', model: 'actual-model' },
    async *stream() { yield { type: 'text-delta', text: '实际结果' }; yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }; yield { type: 'finish', reason: { kind: 'stop' } } },
  } } })
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'observed-default', toolName: 'observed_default', description: '原生模型观察', inputSchema: { type: 'object' },
    run: context => context.infer({}, { messages: [] }) }))
  const result = await f.execute('observed_default')
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.ok, true)
  const attempts = result.value.graph_execution.model_attempts
  assert.deepEqual(attempts.map(row => row.status), ['preparing', 'started', 'completed'])
  assert.equal(Object.hasOwn(attempts[0], 'provider'), false)
  assert.equal(attempts.at(-1).provider, 'actual-provider')
  assert.equal(attempts.at(-1).usage.totalTokens, 6)
})

test('真实ToolRuntime中图模型派发前中间件失败保留原始attempt且不能结算成一次远程调用', async t => {
  const f = nativeFixture(t, { async prepareCall() { return { config: { provider: 'actual-provider', model: 'actual-model' },
    async *stream() { throw new Error('Provider派发前的中间件失败') },
  } } })
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'pre-dispatch-error', toolName: 'pre_dispatch_error', description: '派发前失败', inputSchema: { type: 'object' },
    run: context => context.infer({}, { messages: [] }) }))
  const result = await f.execute('pre_dispatch_error')
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.ok, false)
  const attempts = result.value.graph_execution.model_attempts
  assert.deepEqual(attempts.map(row => row.status), ['preparing', 'started', 'failed'])
  const measured = measureModelUsage([], { attempts, requireSessionTrace: false })
  assert.equal(measured.actual_model_calls, null)
  assert.equal(measured.observed_model_calls, 0)
  assert.ok(measured.model_calls_unknown_reasons.includes('graph-attempt-invocation-unproven'))
})

test('原生LLM错误终态保留结构化失败并将已返回用量结算为failed', async t => {
  const f = nativeFixture(t)
  await f.ctx.plugin(LlmRuntime)
  f.registration.llm = f.ctx.llm
  const card = { provider: 'qwen', id: 'qwen3.5-2b', name: '本地测试模型', reasoning: { efforts: [{ id: 'off', name: '关闭' }] } }
  let responseReceived = true
  f.ctx.llm.registerAdapter(['qwen'], {
    providerInfo: provider => ({ id: provider, name: '本地测试适配器' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    async listModels() { return [card] }, async resolveModel() { return card },
    async prepareCall() { return { model: card, async *stream() {
      if (responseReceived) {
        yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 } }
        throw new LlmError('QWEN_HTTP_503', 'QWEN_HTTP_503', { status: 503, requestId: 'provider-failed-request', providerRetryAfterMs: 250, cause: new Error('私有Provider诊断') })
      }
      throw new TypeError('fetch failed')
    } } },
  })
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'native-error-finish', toolName: 'native_error_finish', description: '原生失败终态', inputSchema: { type: 'object' },
    run: context => context.infer({ ...modelRoles.language, reasoningEffort: 'off' }, { messages: [] }) }), { executionMode: 'hybrid', modelRoles })
  const result = await f.execute('native_error_finish')
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value.ok, false)
  assert.deepEqual(result.value.graph_execution.failure, { message: 'QWEN_HTTP_503', code: 'QWEN_HTTP_503', status: 503, requestId: 'provider-failed-request' })
  assert.equal(JSON.stringify(result).includes('私有Provider诊断'), false)
  const attempts = result.value.graph_execution.model_attempts
  assert.deepEqual(attempts.map(row => row.status), ['preparing', 'started', 'failed'])
  assert.deepEqual(attempts.at(-1).usage, { inputTokens: 9, outputTokens: 2, totalTokens: 11 })
  assert.equal(attempts.at(-1).model_invocation, true)
  assert.equal(new Set(attempts.map(row => row.attempt_id)).size, 1)
  const measured = measureModelUsage([], { attempts, requireSessionTrace: false })
  assert.equal(measured.actual_model_calls, 1)
  assert.equal(measured.failed_model_calls, 1)
  assert.equal(measured.token_usage.total_tokens, 11)

  responseReceived = false
  const unknown = (await f.execute('native_error_finish')).value
  assert.equal(unknown.ok, false)
  assert.deepEqual(unknown.graph_execution.failure, { message: 'fetch failed', code: 'UNKNOWN' })
  const uncertain = unknown.graph_execution.model_attempts
  assert.deepEqual(uncertain.map(row => row.status), ['preparing', 'started', 'failed'])
  assert.equal(Object.hasOwn(uncertain.at(-1), 'model_invocation'), false)
  assert.equal(Object.hasOwn(uncertain.at(-1), 'usage'), false)
  const unmeasured = measureModelUsage([], { attempts: uncertain, requireSessionTrace: false })
  assert.equal(unmeasured.actual_model_calls, null)
  assert.equal(unmeasured.observed_model_calls, 0)
  assert.equal(unmeasured.token_usage, null)
})

test('infer缺失结构化失败或finish仍报未完成，原生取消保持cancelled', async () => {
  for (const kind of ['error-without-failure', 'missing-finish', 'aborted']) {
    const controller = new AbortController()
    let captured
    const f = fixture(async () => assert.fail('无工具调用'), { async prepareCall(config) { return { config, async *stream() {
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } }
      if (kind === 'aborted') {
        controller.abort()
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
      } else if (kind === 'error-without-failure') yield { type: 'finish', reason: { kind: 'error' } }
    } } } })
    const name = kind.replaceAll('-', '_')
    registerWorkflowTool(f.ctx, defineWorkflow({ id: name, toolName: name, description: '未完成响应', inputSchema: { type: 'object' },
      async run(context) {
        try { return await context.infer({ ...modelRoles.language, reasoningEffort: 'off' }, { messages: [] }) }
        catch (error) { captured = error; throw error }
      } }), { executionMode: 'hybrid', modelRoles })
    const result = await f.tool().execute({}, { ...f.identity, signal: controller.signal })
    assert.equal(result.ok, false)
    assert.equal(result.graph_execution.status, kind === 'aborted' ? 'cancelled' : 'failed')
    assert.equal(Object.hasOwn(result.graph_execution, 'failure'), false)
    if (kind === 'aborted') {
      assert.ok(captured instanceof LlmError)
      assert.equal(captured.failure.code, 'ABORTED')
      assert.equal(result.graph_execution.model_attempts.at(-1).status, 'cancelled')
    } else {
      assert.equal(captured.name, 'Error')
      assert.equal(captured.message, '工作流模型响应未完成')
    }
  }
})

test('纯代码工作流拒绝infer，保留失败图且不准备任何模型请求', async t => {
  let preparations = 0
  const f = nativeFixture(t, { async prepareCall() { preparations++; throw new Error('不应访问模型') } })
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'code-only-infer', toolName: 'code_only_infer', description: '纯代码限制', inputSchema: { type: 'object' },
    run: context => context.infer({ provider: 'remote', model: 'remote' }, { messages: [] }) }), { executionMode: 'code-only' })
  const result = await f.execute('code_only_infer')
  assert.equal(result.value.ok, false)
  assert.equal(result.value.graph_execution.execution_mode, 'code-only')
  assert.equal(result.value.graph_execution.status, 'failed')
  assert.deepEqual(result.value.graph_execution.model_attempts, [])
  assert.equal(preparations, 0)
})

function codeOnlyFixture(t, run, renderResult, hybrid) {
  const f = nativeFixture(t), hooks = new Map(), adapters = new Map(), titles = []
  const events = [], agent = { ...f.agent, session: { id: 'workflow-session', header: { agentPreset: 'code-preset' }, snapshotEvents: () => events } }
  const registration = { ...f.registration,
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]) },
    llm: { registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
      prepareCall: hybrid?.prepareCall ?? (() => assert.fail('纯代码回合不能使用远程模型服务')) },
    sessionTitle: { register(provider) { titles.push(provider) } },
  }
  const registerAgent = hybrid ? registerHybridWorkflowAgent : registerCodeOnlyWorkflowAgent
  registerAgent(registration, { presetId: 'code-preset', renderResult, ...(hybrid ? { modelRoles } : {}), workflow: defineWorkflow({ id: 'code-test', toolName: 'code_test', description: '业务图',
    inputSchema: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'], additionalProperties: false }, run }) })
  const signal = new AbortController().signal
  const hook = (name, ...args) => hooks.get(name)?.at(-1)(...args)
  async function enter(turn, text, target = agent) {
    const messages = text === undefined ? [] : [{ role: 'user', id: `message-${turn}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }]
    if (text !== undefined) events.push({ type: 'turn/start', data: { turn } })
    const decision = await hook('agent/pre-step', { agent: target, turn }, async () => ({ kind: 'enter', messages }))
    return { decision, commit() { for (const message of messages) events.push({ type: 'user/message', data: message }) } }
  }
  async function stream(turn, target = agent, currentSignal = signal) {
    const route = await hook('agent/request', { agent: target, turn, step: events.length, signal: currentSignal }, async () => ({ provider: 'remote', model: 'remote' }))
    const adapter = adapters.get(route.provider)
    if (!adapter) return { route, chunks: [] }
    const prepared = await adapter.prepareCall(route.provider, route.model)
    const chunks = []
    for await (const chunk of prepared.stream({ sessionId: target.session.id, signal: currentSignal })) chunks.push(chunk)
    return { route, chunks, text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('') }
  }
  async function execute(turn, response, target = agent) {
    const call = response.chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
    events.push({ type: 'tool/call', data: { turn, step: 1, callId: call.id, name: call.name, arguments: call.arguments } })
    const result = await f.ctx.tools.execute({ name: call.name, arguments: JSON.parse(call.arguments), callId: call.id, agent: target, signal })
    events.push({ type: 'tool/result', data: { turn, step: 1, message: { role: 'tool', toolCallId: call.id,
      source: { kind: 'tool', callId: call.id, name: call.name }, content: result.content, ...(result.isError ? { isError: true } : {}) }, ...(result.isError ? { error: { code: 'TOOL_FAILED' } } : {}) } })
    return result
  }
  return { ...f, agent, hooks, hook, events, titles, adapters, enter, stream, execute }
}

test('纯代码原生回合将当前输入交给LangGraph和真实工具，再按同轮回执本地回复', async t => {
  const f = codeOnlyFixture(t, context => runWorkflow(context, [
    { id: 'read', run: (_v, current) => current.callTool('read_ledger', { request: current.input.request }) },
    { id: 'answer', async run(values) { return { reply: `台账：${values.read.asset_id}` } } },
  ]), value => value.answer.reply)
  const childCalls = []
  f.register('read_ledger', (input, exec) => { childCalls.push({ input, exec }); return { asset_id: 'asset-0001' } })
  const entered = await f.enter(1, '请读取台账')
  const initial = await f.stream(1)
  entered.commit()
  assert.deepEqual(initial.route, { provider: 'harness-code-only', model: 'workflow-v1', reasoningEffort: 'off' })
  assert.deepEqual((await f.adapters.get('harness-code-only').listModels()).map(model => model.name), ['纯代码工作流'])
  const call = initial.chunks.find(chunk => chunk.type === 'block-end').block
  assert.deepEqual(JSON.parse(call.arguments), { request: '请读取台账' })
  const executed = await f.execute(1, initial)
  assert.equal(executed.isError, false)
  assert.equal(executed.value.graph_execution.execution_mode, 'code-only')
  assert.equal(executed.value.graph_execution.status, 'completed')
  assert.equal(childCalls.length, 1)
  assert.equal(childCalls[0].exec.agent, f.agent)
  await f.enter(1)
  const final = await f.stream(1)
  assert.equal(final.text, '台账：asset-0001')
  assert.equal(final.chunks.at(-1).reason.kind, 'stop')
  assert.equal((await f.stream(1)).chunks.some(chunk => chunk.blockType === 'tool-call'), false)
  const title = await f.titles[0].generate({ messages: [{ seq: 7, text: '请读取台账' }], signal: new AbortController().signal })
  assert.deepEqual(title, { title: '请读取台账', messageSeqs: [7] })
  assert.equal(Object.hasOwn(title, 'model'), false)
})

test('身份和未知输入也通过图，原生Guard失败时本地停止且不重放工具', async t => {
  let graphs = 0
  const f = codeOnlyFixture(t, async context => {
    graphs++
    if (context.input.request === '身份') return { reply: '我是台账助手' }
    return context.callTool('blocked_ledger', {})
  })
  f.register('blocked_ledger', () => assert.fail('原生Guard应拦截工具'))
  f.ctx.tools.guard(exec => exec.name === 'blocked_ledger' ? '工具当前不可用' : undefined)
  let entered = await f.enter(1, '身份'), first = await f.stream(1); entered.commit()
  const identity = await f.execute(1, first)
  assert.equal(identity.value.graph_execution.complete, true)
  assert.equal((await f.stream(1)).text, '我是台账助手')
  f.hook('session/event', f.agent.session, { type: 'turn/end', data: { turn: 1 } })
  entered = await f.enter(2, '未知操作'); first = await f.stream(2); entered.commit()
  const failed = await f.execute(2, first)
  assert.equal(failed.value.ok, false)
  assert.equal(failed.value.graph_execution.trace[0].status, 'failed')
  assert.match((await f.stream(2)).text, /未完成|失败/)
  assert.equal((await f.stream(2)).chunks.some(chunk => chunk.blockType === 'tool-call'), false)
  assert.equal(graphs, 2)
})

test('会话恢复仅消费精确回执，其他Session或旧callId不能替代本轮结果', async t => {
  const f = codeOnlyFixture(t, async context => ({ reply: context.input.request }))
  const entered = await f.enter(4, '本轮请求'), first = await f.stream(4); entered.commit()
  await f.execute(4, first)
  f.hook('agent/disposed', { agent: f.agent })
  assert.equal((await f.stream(4)).text, '本轮请求', '恢复后应消费已有回执而非再次执行')
  f.hook('agent/disposed', { agent: f.agent })
  f.events.at(-1).data.message.source.callId = 'old-call'
  assert.match((await f.stream(4)).text, /结果未知/)
  const other = { ...f.agent, session: { ...f.agent.session, id: 'other-session', snapshotEvents: () => [] } }
  const unbound = await f.stream(4, other)
  assert.match(unbound.text, /结果未知/)
  assert.equal(unbound.chunks.some(chunk => chunk.blockType === 'tool-call'), false)
})

test('同一turn接受新的用户消息时执行新请求，不丢输入也不重放旧调用', async t => {
  const requests = [], f = codeOnlyFixture(t, async context => { requests.push(context.input.request); return { reply: context.input.request } })
  let entered = await f.enter(1, '第一个请求'), first = await f.stream(1); entered.commit()
  await f.execute(1, first)
  entered = await f.enter(1, '第二个请求'); const second = await f.stream(1); entered.commit()
  const firstId = first.chunks.find(chunk => chunk.type === 'block-end').block.id
  const secondId = second.chunks.find(chunk => chunk.type === 'block-end').block.id
  assert.notEqual(firstId, secondId)
  await f.execute(1, second)
  assert.equal((await f.stream(1)).text, '第二个请求')
  assert.deepEqual(requests, ['第一个请求', '第二个请求'])
})

test('取消和其他Preset不会重放纯代码请求或改写其模型路由', async t => {
  const f = codeOnlyFixture(t, async () => ({ reply: '完成' }))
  await f.enter(1, '已取消的请求')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => f.stream(1, f.agent, controller.signal), { name: 'AbortError' })
  f.hook('session/event', f.agent.session, { type: 'turn/end', data: { turn: 1 } })
  assert.match((await f.stream(2)).text, /结果未知/)
  const other = { ...f.agent, session: { ...f.agent.session, header: { agentPreset: 'ordinary-preset' } } }
  assert.deepEqual((await f.stream(3, other)).route, { provider: 'remote', model: 'remote' })
})

test('混合原生回合只本地派发，图内语言推理与类型化决策含失败重试逐次结算，恢复不重放', async t => {
  let languageCalls = 0, decisionCalls = 0
  const f = codeOnlyFixture(t, async context => {
    const parsed = await context.infer({ ...modelRoles.language, reasoningEffort: 'off' }, { messages: [{ role: 'user', content: context.input.request }] })
    const decision = await context.decide('kev_decide', { state: parsed.content })
    return { reply: `决定：${decision.action}` }
  }, undefined, { async prepareCall(config) {
    languageCalls++
    return { config, async *stream() {
      yield { type: 'text-delta', text: '结构化输入' }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } })
  f.register('kev_decide', (args, exec) => {
    decisionCalls++
    assert.equal(args.state, '结构化输入')
    assert.equal(exec.agent, f.agent)
    assert.equal(args.model_execution.session_id, f.agent.session.id)
    const first = { ...modelRoles.decision, request_id: 'kev-retry-first', status: 'failed', model_invocation: true,
      usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 } }
    const second = { ...modelRoles.decision, request_id: 'kev-retry-second', status: 'completed', model_invocation: true,
      usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } }
    return { typed_decision: { action: 'read_asset' }, model_execution: args.model_execution, model_requests: [first, first, second] }
  })
  const entered = await f.enter(1, '查询资产'), first = await f.stream(1); entered.commit()
  assert.deepEqual(first.route, { provider: 'harness-workflow', model: 'hybrid-v1', reasoningEffort: 'off' })
  assert.equal(languageCalls, 0)
  const executed = await f.execute(1, first)
  assert.equal(executed.value.ok, true)
  assert.equal(executed.value.graph_execution.execution_mode, 'hybrid')
  const attempts = executed.value.graph_execution.model_attempts
  const measured = measureModelUsage([], { attempts: [...attempts, ...attempts], requireSessionTrace: false })
  assert.equal(measured.actual_model_calls, 3)
  assert.equal(measured.failed_model_calls, 1)
  assert.deepEqual(measured.model_calls_by_model_role, { language: 1, decision: 2 })
  assert.equal(measured.token_usage.total_tokens, 19)
  f.hook('agent/disposed', { agent: f.agent })
  assert.equal((await f.stream(1)).text, '决定：read_asset')
  assert.equal((await f.stream(1)).chunks.some(chunk => chunk.blockType === 'tool-call'), false)
  assert.equal(languageCalls, 1); assert.equal(decisionCalls, 1)
  const other = { ...f.agent, session: { ...f.agent.session, header: { agentPreset: 'ordinary-preset' } } }
  assert.deepEqual((await f.stream(2, other)).route, { provider: 'remote', model: 'remote' })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(() => f.stream(2, f.agent, cancelled.signal), { name: 'AbortError' })
})

test('混合工作流拒绝未绑定路由、错产物、丢失和失败决策回执，不把未知请求算作零', async t => {
  const f = nativeFixture(t, { async prepareCall() { assert.fail('错误语言路由不得请求模型') } })
  let response
  f.register('kev_observed', args => typeof response === 'function' ? response(args) : response)
  const register = (name, run) => registerWorkflowTool(f.registration,
    defineWorkflow({ id: name, toolName: name, description: '角色核验', inputSchema: { type: 'object' }, run }), { executionMode: 'hybrid', modelRoles })
  register('bad_language', context => context.infer({ provider: 'large', model: 'fallback', reasoningEffort: 'off' }, { messages: [] }))
  assert.equal((await f.execute('bad_language')).value.ok, false)
  register('typed_receipt', context => context.decide('kev_observed', {}))
  for (const corrupt of ['missing', 'digest', 'identity']) {
    response = args => ({ typed_decision: { action: 'read' }, model_execution: { ...args.model_execution,
      ...(corrupt === 'identity' ? { execution_id: 'wrong-execution' } : {}) }, model_requests: corrupt === 'missing' ? [] : [
      { ...modelRoles.decision, ...(corrupt === 'digest' ? { checkpoint_sha256: 'd'.repeat(64) } : {}), request_id: 'request', status: 'completed', model_invocation: true },
    ] })
    const result = (await f.execute('typed_receipt')).value
    assert.equal(result.ok, false)
    const measured = measureModelUsage([], { attempts: result.graph_execution.model_attempts, requireSessionTrace: false })
    assert.equal(measured.actual_model_calls, null)
    assert.ok(measured.model_calls_unknown_reasons.includes('graph-attempt-invocation-unproven'))
  }
  response = args => ({ isError: true, typed_decision: null, model_execution: args.model_execution,
    model_requests: [{ ...modelRoles.decision, request_id: 'failed-request', status: 'failed', model_invocation: true }] })
  const failed = (await f.execute('typed_receipt')).value
  assert.equal(failed.ok, false)
  const measured = measureModelUsage([], { attempts: failed.graph_execution.model_attempts, requireSessionTrace: false })
  assert.equal(measured.actual_model_calls, 1)
  assert.equal(measured.failed_model_calls, 1)
  assert.equal(measured.token_usage, null)
  response = args => ({ typed_decision: { action: 'read' }, model_execution: args.model_execution,
    model_requests: [
      { ...modelRoles.decision, request_id: 'known-request', status: 'failed', model_invocation: true },
      { ...modelRoles.decision, request_id: 'uncertain-request', status: 'cancelled' },
    ] })
  const partial = (await f.execute('typed_receipt')).value
  assert.equal(partial.ok, false)
  const partialUsage = measureModelUsage([], { attempts: partial.graph_execution.model_attempts, requireSessionTrace: false })
  assert.equal(partialUsage.actual_model_calls, null)
  assert.equal(partialUsage.observed_model_calls, 1, '回执不完整仍保留已证明请求下界')
  const uncertain = partial.graph_execution.model_attempts.find(item => item.attempt_id.endsWith(':uncertain-request'))
  assert.equal(uncertain.status, 'cancelled', '派发未知也保留原始请求身份和取消事实')
  assert.equal(Object.hasOwn(uncertain, 'model_invocation'), false, '未知不写成false或undefined属性')
  response = args => ({ typed_decision: null, model_execution: args.model_execution,
    model_requests: [{ ...modelRoles.decision, request_id: 'pre-aborted', status: 'cancelled', model_invocation: false }] })
  const notDispatched = (await f.execute('typed_receipt')).value
  assert.equal(notDispatched.ok, false)
  assert.equal(measureModelUsage([], { attempts: notDispatched.graph_execution.model_attempts, requireSessionTrace: false }).actual_model_calls, 0)
})

test('混合语言模型装配改变路由时在stream前停止，不调用隐藏的大模型', async t => {
  let streams = 0
  const f = nativeFixture(t, { async prepareCall(config) {
    return { config: { ...config, model: 'large-fallback' }, async *stream() { streams++; yield { type: 'finish', reason: { kind: 'stop' } } } }
  } })
  registerWorkflowTool(f.registration, defineWorkflow({ id: 'resolved-route', toolName: 'resolved_route', description: '路由核对', inputSchema: { type: 'object' },
    run: context => context.infer({ provider: 'qwen', model: 'qwen3.5-2b', reasoningEffort: 'off' }, { messages: [] }) }), { executionMode: 'hybrid', modelRoles })
  const result = (await f.execute('resolved_route')).value
  assert.equal(result.ok, false)
  assert.equal(streams, 0)
  const measured = measureModelUsage([], { attempts: result.graph_execution.model_attempts, requireSessionTrace: false })
  assert.equal(measured.actual_model_calls, 0)
})

test('混合infer只向原生stream传递exec真实Session，自报身份不能替换或补造归属', async t => {
  const requests = []
  const f = nativeFixture(t, { async prepareCall(config) {
    return { config, async *stream(options) {
      requests.push(options)
      yield { type: 'text-delta', text: '原生身份已保留' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  } })
  const definition = name => defineWorkflow({ id: name, toolName: name, description: '模型请求身份', inputSchema: { type: 'object' },
    run: context => context.infer({ provider: 'qwen', model: 'qwen3.5-2b', reasoningEffort: 'off', sessionId: 'forged-from-config' },
      { system: '真实请求', messages: [{ role: 'user', content: [] }], sessionId: 'forged-from-payload' }) })
  registerWorkflowTool(f.registration, definition('trusted_session_infer'), { executionMode: 'hybrid', modelRoles })
  const actual = await f.execute('trusted_session_infer')
  assert.equal(actual.value.ok, true, JSON.stringify(actual))
  assert.equal(requests[0].sessionId, f.agent.session.id)
  assert.equal(actual.value.graph_execution.model_attempts.at(-1).session_id, f.agent.session.id)

  const noAgent = await f.ctx.tools.execute({ name: 'trusted_session_infer', arguments: {}, callId: 'standalone-infer', signal: new AbortController().signal })
  assert.equal(noAgent.value.ok, true, JSON.stringify(noAgent))
  assert.equal(requests[1].sessionId, undefined, '没有exec Session时不得采用config或payload自报身份')
  assert.equal(Object.hasOwn(noAgent.value.graph_execution, 'session_id'), false)

  registerWorkflowTool(f.registration, defineWorkflow({ id: 'identity-not-authority', toolName: 'identity_not_authority', description: '身份不改变模型角色', inputSchema: { type: 'object' },
    run: context => context.infer({ provider: 'unbound', model: 'fallback', reasoningEffort: 'off', sessionId: f.agent.session.id }, { messages: [] }) }), { executionMode: 'hybrid', modelRoles })
  const refused = await f.execute('identity_not_authority')
  assert.equal(refused.value.ok, false)
  assert.equal(requests.length, 2, '真实Session也不能授权计划外模型')
  assert.deepEqual(refused.value.graph_execution.model_attempts, [])
})
