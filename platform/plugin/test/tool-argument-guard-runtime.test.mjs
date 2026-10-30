import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire, findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { guardToolArguments } from '../src/assistant/tool-argument-guard.ts'

const sdkRequire = createRequire(process.env.HARNESS_DSH_ENTRY ?? '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json')
const piRoot = dirname(findPackageJSON('@earendil-works/pi-ai', pathToFileURL(process.env.HARNESS_CODEX_PLUGIN_ENTRY ?? sdkRequire.resolve('@deepseek-ai/dsh-llm-pi-ai'))))
const sdk = name => import(pathToFileURL(sdkRequire.resolve(name)).href)
const pi = name => import(pathToFileURL(join(piRoot, 'dist', name + '.js')).href)
const [
  { Context }, { SessionStore }, { SessionProjectionRegistry }, { SystemPrompt }, { ToolRuntime }, { default: AgentRegistry },
  { default: AgentLoop }, { default: LlmRuntime, createUserMessage }, { PiAiAdapter },
  { openaiCodexProvider }, { processResponsesStream }, { AssistantMessageEventStream }, { InMemoryCredentialStore, defaultProviderAuthContext },
] = await Promise.all([
  sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-session'), sdk('@deepseek-ai/dsh-session-projection'), sdk('@deepseek-ai/dsh-system-prompt'),
  sdk('@deepseek-ai/dsh-tools'), sdk('@deepseek-ai/dsh-agent'), sdk('@deepseek-ai/dsh-agent-loop'),
  sdk('@deepseek-ai/dsh-llm'), sdk('@deepseek-ai/dsh-llm-pi-ai'), pi('providers/openai-codex'),
  pi('api/openai-responses-shared'), pi('utils/event-stream'), pi('index'),
])

test('原生 Codex 解析链及时取消深层生成、不执行异常工具，HTTP 和其他会话可继续工作', { timeout: 15_000 }, async t => {
  const requests = [], calls = [], failures = []
  const ctx = new Context()
  const server = createServer((_request, response) => response.end('ready'))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  const base = openaiCodexProvider()
  const model = base.getModels()[0]
  const badInput = '{"old_string":' + '{",":{":":'.repeat(1450)
  const provider = { ...base, auth: { apiKey: { resolve: async () => ({ auth: { apiKey: 'fixture' }, source: 'fixture' }) } }, streamSimple(model, _context, options) {
    const stream = new AssistantMessageEventStream()
    const state = { received: 0, aborted: false, finished: false }
    requests.push(state)
    const input = requests.length === 1 ? badInput : '{"old_string":"ok"}'
    const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call-fixture', name: 'edit', arguments: '' }
    async function* events() {
      try {
        yield { type: 'response.output_item.added', output_index: 0, item }
        for (let index = 0; index < input.length; index += 2) {
          options.signal.throwIfAborted()
          state.received += 2
          yield { type: 'response.function_call_arguments.delta', output_index: 0, delta: input.slice(index, index + 2) }
        }
        yield { type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: input } }
        yield { type: 'response.completed', response: { status: 'completed' } }
      } finally { state.aborted = options.signal.aborted; state.finished = true }
    }
    const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now() }
    void (async () => {
      try {
        await processResponsesStream(events(), output, stream, model)
        stream.push({ type: 'done', reason: output.stopReason, message: output })
      } catch {
        output.stopReason = 'aborted'; output.errorMessage = 'fixture cancelled'
        stream.push({ type: 'error', reason: 'aborted', error: output })
      } finally { stream.end(output) }
    })()
    return stream
  } }
  const profiles = new Map([[base.id, { provider: base.id, streamIdleTimeoutMs: 5000, transport: 'sse', configuredMaxTokens: new Map(), modelErrors: new Map(), piProvider: provider }]])
  ctx.llm.registerAdapter([base.id], new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'fixture', auth: {
    credentials: new InMemoryCredentialStore(), authContext: defaultProviderAuthContext(),
  } }))
  ctx.on('llm/stream', async function* (_request, next) { yield* guardToolArguments(next()) })
  ctx.on('agent/request-error', event => { failures.push(event.failure) })
  ctx.tools.register({ name: 'edit', description: '记录执行次数', parameters: { type: 'object', properties: { old_string: { type: 'string' } }, required: ['old_string'] },
    output: { schema: { type: 'object' }, render: () => [] }, async execute(args) { calls.push(args); return {} } })
  const agent = await ctx.agentLoop.create('session-guard-bad', { provider: base.id, model: model.id }, { cwd: process.cwd() })
  const send = target => target.followup(createUserMessage({ content: [{ type: 'text', text: '测试参数边界' }], source: { kind: 'user' } }))
  send(agent)
  await agent.whenIdle()
  assert.equal(failures[0]?.code, 'TOOL_ARGUMENT_LIMIT', JSON.stringify(failures))
  assert.equal(calls.length, 0)
  assert.equal(requests.length, 1, '不能自动重试异常生成')
  // 原生生产者可短暂领先于消费者；取消必须在积累到数千层前传回实际解析链。
  assert.ok(requests[0].received < 8192, `必须在解析数千层之前关闭生产者：${JSON.stringify(requests[0])}`)
  assert.equal(requests[0].aborted, true)
  assert.equal(requests[0].finished, true)
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'ready')

  // 正常会话使用同一个模型适配器和守卫；工具完成后主动取消，避免固定样本无限生成工具。
  ctx.on('tools/post-execute', (_exec, _result, next) => { other.cancel({ kind: 'user' }); return next() })
  const other = await ctx.agentLoop.create('session-guard-normal', { provider: base.id, model: model.id }, { cwd: process.cwd() })
  send(other)
  await other.whenIdle()
  assert.deepEqual(calls, [{ old_string: 'ok' }])
})
