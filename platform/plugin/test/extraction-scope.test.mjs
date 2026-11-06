import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { createAssistant } from '../src/assistant/index.ts'
import { DECISION_EXTRACTION_CONTRACT, decisionExtractionModelContract, normalizeDecisionModelSubmission, validateDecisionQuestions, validateDecisionLabel } from '../src/evaluation/decision-dataset-contract.ts'

const require = createRequire(import.meta.url)
// 使用平台已锁定 Controller 依赖树中的真实 SDK，不依赖机器的全局安装位置。
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const sdk = async name => import(pathToFileURL(sdkRequire.resolve(name)).href)
const [{ Context }, { SystemPrompt }, { ToolRuntime, assertSupportedJsonSchema, validateJsonSchemaValue }, { createScope }] = await Promise.all([
  sdk('@deepseek-ai/cordis'), sdk('@deepseek-ai/dsh-system-prompt'), sdk('@deepseek-ai/dsh-tools'), sdk('@deepseek-ai/dsh-scope'),
])
const built = mkdtempSync(join(tmpdir(), 'extraction-scope-build-'))
await build({ entryPoints: [new URL('../src/assistant/extraction-scope.ts', import.meta.url).pathname], outfile: join(built, 'scope.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { DECISION_EXTRACTION_ACTIONS, projectDecisionExtractionTools } = await import(pathToFileURL(join(built, 'scope.mjs')).href)
test.after(() => rm(built, { recursive: true, force: true }))

function fixture(t, { parentPtc = false, actualPlatformTools = false } = {}) {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, { mode: 'native' })
  const calls = []
  const definition = name => ({
    name, description: '受控基本数据能力', parameters: { type: 'object', additionalProperties: true },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(arguments_) { calls.push({ name, arguments: arguments_ }); return { basic: true } },
  })
  for (const name of ['skill', 'platform_agents', 'bash', 'read', 'write', 'spawn_agent', 'run_in_background']) {
    if (!actualPlatformTools || !name.startsWith('platform_')) ctx.tools.register(definition(name))
  }
  // 仅装载真实平台工具声明；此夹具不执行平台业务，也不访问模型或实际数据。
  const assistant = actualPlatformTools ? createAssistant('/schema-fixture', async () => assert.fail('声明测试不能调用平台业务'), {
    projections: { register: () => () => {} }, systemPrompt: ctx.systemPrompt,
  }) : null
  assistant?.registerTools(ctx.tools)
  const parentKey = { id: 'preset' }
  const parent = parentPtc ? createScope(ctx, parentKey) : null
  if (parent) parent.ctx.tools.presentAs('ptc')
  const agent = { id: 'extraction-agent', session: {} }
  const agentScope = createScope(ctx, agent, parent ? { parent: parentKey } : undefined)
  agent.ctx = agentScope.ctx
  const other = { id: 'other-agent', session: {} }
  const otherScope = createScope(ctx, other)
  other.ctx = otherScope.ctx
  const execute = (name, arguments_ = {}, target = agent) => ctx.tools.execute({ name, arguments: arguments_, callId: `call-${name}-${calls.length}`, agent: target, signal: new AbortController().signal })
  const toolSchemas = async target => (await ctx.systemPrompt.assemble({ scope: target, agent: target })).tools
  const schemas = async target => (await toolSchemas(target)).map(tool => tool.name).sort()
  t.after(async () => { await assistant?.dispose(); await agentScope.dispose(); await otherScope.dispose(); if (parent) await parent.dispose(); await ctx.fiber.dispose() })
  return { ctx, agent, agentScope, calls, definition, execute, schemas, toolSchemas, other }
}

test('抽取投影使用真实平台工具，SDK校验逐题字段及三题型而不公开动态样本映射', async t => {
  const f = fixture(t, { actualPlatformTools: true })
  const original = (await f.toolSchemas(f.agent)).find(tool => tool.name === 'platform_agents')
  assert.ok(original.parameters.properties.action.enum.includes('compute-variants/create'))
  const assembled = await f.toolSchemas(f.agent), snapshot = structuredClone(assembled)
  const projected = projectDecisionExtractionTools(assembled), tool = projected.find(tool => tool.name === 'platform_agents')
  assert.deepEqual(assembled, snapshot, '不得修改 SDK 返回的原始声明')
  assert.equal(projected.find(tool => tool.name === 'skill'), assembled.find(tool => tool.name === 'skill'))
  assert.deepEqual(tool.parameters.properties.action.enum, DECISION_EXTRACTION_ACTIONS)
  assert.deepEqual(DECISION_EXTRACTION_ACTIONS, ['context', 'research/read-reference', 'datasets/source', 'datasets/preview', 'datasets/list'])
  assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters))
  const input = tool.parameters.properties.input, contract = decisionExtractionModelContract()
  assert.equal(contract.model_submission.transport, 'single-question-v1')
  assert.deepEqual(input.properties.task.properties.semantics.enum, DECISION_EXTRACTION_CONTRACT.task.semantics)
  assert.equal(input.properties.workflow.description, DECISION_EXTRACTION_CONTRACT.workflow)
  assert.ok(input.description.includes(contract.model_submission.required_fields.join('、')))
  for (const field of ['samples', 'questions', 'targets', 'state', '_meta', 'assistant_session_id']) assert.equal(input.properties[field], undefined)
  assert.equal(input.properties.skipped.items.type, 'string')
  const common = { path: 'trace.jsonl', source_sha256: 'a'.repeat(64), decision_id: 'decision-fixed', action_name: 'respond', workflow: '材料核对', task: { id: 'check-input', semantics: 'recommended_decision' }, question_name: 'input_ready' }
  const variants = [
    { question: { type: 'choice', instructions: '当前应采取哪种动作？', criteria: { respond: '依据现有材料答复', query: '继续查询缺少的材料' } }, target: { label: 'respond', basis: '当前用户输入已包含必要材料。', probabilities: { respond: 0.7, query: 0.3 } } },
    { question: { type: 'noul', instructions: '当前材料是否足以答复？' }, target: { label: false, basis: '仍有信息未明确。' } },
    { question: { type: 'score', instructions: '当前信息完整程度？', criteria: ['不足', '基本充分', '充分'] }, target: { label: 1, basis: '主要信息已具备，边界尚需确认。', probabilities: { 0: 0.1, 1: 0.8, 2: 0.1 } } },
  ]
  for (const variant of [...variants, { ...variants[0], task: { id: 'actual-action', semantics: 'observed_action' }, target: { label: 'respond', basis: '来源记录的实际动作是 respond。' } }]) {
    const submission = { ...common, ...variant }
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, { action: 'datasets/preview', input: submission }), [])
    const sample = normalizeDecisionModelSubmission(submission).samples[0]
    const questions = validateDecisionQuestions(sample.questions)
    assert.doesNotThrow(() => validateDecisionLabel(questions.input_ready, sample.targets.input_ready))
  }
  for (const args of [
    { action: 'context', input: {} },
    { action: 'research/read-reference', input: { topic: 'decision-samples' } },
    { action: 'datasets/source', input: { run_id: 'run-fixed', path: 'trace.jsonl', cursor: 3 } },
    { action: 'datasets/list', input: { run_id: 'run-fixed' } },
    { action: 'datasets/preview', input: { path: 'trace.jsonl', source_sha256: 'a'.repeat(64), skipped: ['输入不足'] } },
  ]) assert.deepEqual(validateJsonSchemaValue(tool.parameters, args), [])
  for (const args of [
    { action: 'eval/start', input: {} },
    { action: 'datasets/preview', input: '{"question":{}}' },
    ...[
      { ...common, ...variants[0], samples: [] },
      { ...common, ...variants[1], skipped: [{ reason: '输入不足' }] },
      { ...common, ...variants[1], question: { type: 'noul' } },
      { ...common, ...variants[2], question: { ...variants[2].question, criteria: { a: '低', b: '高' } } },
      { ...common, ...variants[0], target: { ...variants[0].target, status: 'reviewed' } },
      { ...common, ...variants[0], target: { ...variants[0].target, label: 0.5 } },
    ].map(value => ({ action: 'datasets/preview', input: value })),
  ]) assert.ok(validateJsonSchemaValue(tool.parameters, args).length)
  assert.equal(f.calls.length, 0)
})

test('抽取Schema投影保留原生工具、其他会话和原始注册', async t => {
  const f = fixture(t, { actualPlatformTools: true })
  const before = await f.toolSchemas(f.agent), otherBefore = await f.toolSchemas(f.other)
  const projected = projectDecisionExtractionTools(await f.toolSchemas(f.agent))
  for (const name of ['bash', 'read', 'write', 'spawn_agent', 'run_in_background']) {
    assert.ok(projected.some(tool => tool.name === name), `${name} 必须沿用原生声明`)
    assert.equal((await f.execute(name)).isError, false)
  }
  assert.deepEqual(await f.toolSchemas(f.other), otherBefore)
  const registered = f.ctx.tools.get('platform_agents', f.agent)
  assert.ok(registered.parameters.properties.action.enum.includes('compute-variants/create'))
  assert.deepEqual(await f.toolSchemas(f.agent), before)
})
