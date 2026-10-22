import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { build } from 'esbuild'
import { createAssistant, redactAssistant } from '../src/assistant/index.ts'
import { createInstancesHandler } from '../src/instances/index.ts'
import { managementSkills } from '../src/assistant/business-assets.ts'
import { assistantMcp } from '../src/assistant/mcp.ts'
import { applyTaskAssembly } from '../src/tasks/assembly.ts'
import { candidateDigest, sha256 } from '../src/tasks/files.ts'
import { assistantActions, assistantActionContract, projectAssistantTools } from '../src/assistant/tool-contracts.ts'
import { DECISION_EXTRACTION_CONTRACT } from '../src/evaluation/decision-dataset-contract.ts'
import { completedTaskModelView } from '../src/assistant/task-model-view.ts'
import { deliveryProjection, readInstanceDeliveryHistory } from '../src/assistant/delivery-history.ts'
import { workspaceIdentity } from '../src/workspace.ts'

const expressionFixture = '先说明结果、影响和用户需要采取的行动。保留失败与未知事实。'
function fixture(t, responder, root) {
  if (!root) { root = mkdtempSync(join(tmpdir(), 'assistant-data-')); t.after(() => rmSync(root, { recursive: true, force: true })) }
  if (!existsSync(join(root, 'AGENTS.md'))) writeFileSync(join(root, 'AGENTS.md'), '你是 Harness 工程平台管理助手。业务工作由数据工作区原则和技能指导。')
  for (const name of managementSkills) {
    const path = join(root, '.agents/skills', name, 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) writeFileSync(path, `---\nname: ${name}\ndescription: 测试技能\n---\n${name === 'user-facing-output' ? expressionFixture : `测试 ${name} 业务技能`}`)
  }
  const skills = { async get(name, options) {
    assert.equal(options.cwd, root)
    const path = join(root, '.agents/skills', name, 'SKILL.md')
    if (!existsSync(path)) return undefined
    return { name, path, content: readFileSync(path, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, ''), invocation: { modelInvocable: true } }
  } }

  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {})
  const sessions = new Map(), tools = new Map(), calls = [], peers = [], prompts = []
  let count = 0
  ctx.on('session/event', (session, event) => sessions.get(session.id)?.events.push(event))
  function addSession(id, cwd = root, seed = [], parentSession) {
    const row = { events: [...seed], input: {}, session: undefined }
    sessions.set(id, row)
    row.session = ctx.sessions.create(id, { ...(seed.length ? { seed } : {}), ...(parentSession ? { inheritedEventCount: seed.length } : {}), meta: { cwd, ...(parentSession ? { parentSession, isSeeded: true } : {}) } })
    return row.session
  }
  const controller = {
    async create(input) { assert.ok(!(input.cwd && input.workspaceId)); const id = `session-${++count}`; addSession(id, input.cwd ?? root); sessions.get(id).input = input; return { sessionId: id } },
    async resolveAgent(id) { return { agent: { id, session: sessions.get(id).session } } },
    async prompt(request) { prompts.push(request); return { accepted: true } },
    cancel() { return { accepted: true } },
  }
  const services = { controller, skills, projections: ctx.sessionProjections, systemPrompt: ctx.systemPrompt,
    record(session, type, data) { appendPluginRecord(session, type, data) }, notify() {} }
  const platform = async (endpoint, input, signal, peer) => {
    calls.push({ endpoint, input })
    peers.push({ endpoint, peer })
    const custom = await responder?.(endpoint, input, signal)
    if (custom !== undefined) return custom
    if (endpoint === 'instances/preview') return { ok: true, value: {
      name: input.name, operation: input.operation, source_id: 'experiment:EXP-test-agent-001',
      observed_state: 'running', observed_at: '2026-10-21T00:00:00.000Z',
      plan: { source_id: input.source ?? 'experiment:EXP-test-agent-001', port: 3199 },
      model_selection: { provider: 'fixture', model: 'default' }, model_policy_hash: 'a'.repeat(64),
    } }
    return { ok: true, value: { ok: true, source: endpoint } }
  }
  const create = () => { const assistant = createAssistant(root, platform, services); assistant.registerTools({ register: tool => tools.set(tool.name, tool) }); return assistant }
  let assistant = create()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => assistant.assemblePrompt(await next(), context))
  t.after(async () => { await assistant.dispose(); await ctx.fiber.dispose() })
  const signal = new AbortController().signal
  const rpc = (action, input, requestSignal = signal) => assistant.handler(action, input, requestSignal)
  const execute = async (id, domain, action, input = {}, toolSignal = signal) => tools.get(`platform_${domain}`).execute({ action, input }, { agent: { id, session: sessions.get(id)?.session }, signal: toolSignal })
  const status = async id => (await rpc('status', { session_id: id })).value
  async function proposal(id) {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const value = (await status(id)).proposals.find(item => item.state === 'awaiting_confirmation')
      if (value) return value
      await setImmediate()
    }
    assert.fail('未出现待确认提案')
  }
  const assembly = id => ctx.systemPrompt.assemble({ agent: { session: sessions.get(id).session } })
  const assemble = async id => (await assembly(id)).sections.filter(item => ['harness-platform/assistant', 'harness-platform/assistant-output'].includes(item.name)).map(item => item.text).filter(Boolean).join('\n')
  return { root, ctx, sessions, services, tools, calls, peers, prompts, rpc, status, execute, proposal, assemble, assembly, addSession,
    beforeModelCall: id => assistant.beforeModelCall(id),
    async reload() { await assistant.dispose(); assistant = create() } }
}

function taskPlan(overrides = {}) {
  return { goal: '检查三台设备并交付完整报告', agent_id: 'test-agent', source: 'experiment:EXP-test-agent-001',
    evaluation_case_ids: ['U-BUSINESS-001'], deliverables: ['设备巡检报告'], instance_name: 'test-delivery',
    allowed_actions: [{ domain: 'agents', action: 'edit/apply' }, { domain: 'agents', action: 'eval/start' }, { domain: 'instances', action: 'run' }], ...overrides }
}
function installTaskGoals(f) {
  const goals = new Map()
  f.services.goals = {
    get(agent) { return goals.get(agent.id) },
    create(agent, request) { const row = { id: 'native-goal', revision: 1, phase: 'active', activation: 'armed', ...request }; goals.set(agent.id, row); return row },
    pause(agent) { const row = { ...goals.get(agent.id), revision: goals.get(agent.id).revision + 1, phase: 'paused', activation: 'disarmed' }; goals.set(agent.id, row); return row },
    resume(agent) { const row = { ...goals.get(agent.id), revision: goals.get(agent.id).revision + 1, phase: 'active', activation: 'armed' }; goals.set(agent.id, row); return row },
    complete(agent) { const row = { ...goals.get(agent.id), revision: goals.get(agent.id).revision + 1, phase: 'complete', activation: 'disarmed' }; goals.set(agent.id, row); return row },
  }
  return goals
}
async function beginTask(f, id, plan = taskPlan()) {
  const operation = f.execute(id, 'task', 'start', { plan })
  const proposal = await f.proposal(id)
  const confirmed = await f.rpc('confirm', { session_id: id, proposal_id: proposal.id })
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed))
  await operation
  assert.equal((await f.status(id)).execution.state, 'running')
}
function taskResponder(endpoint, input) {
  if (endpoint === 'agents/detail') return { ok: true, value: { experiment: { id: 'EXP-test-agent-001' }, evaluation: { sha256: 'fixed-evaluation', cases: [{ id: 'U-BUSINESS-001' }] }, derivation: { parent_ref: 'git:' + 'a'.repeat(40) } } }
  if (endpoint === 'agents/eval/start') return { ok: true, value: { job_id: 'job-' + Math.random(), status: 'running' } }
  if (endpoint === 'agents/eval/status') return { ok: true, value: { status: 'completed', run_id: 'run-own' } }
  if (endpoint === 'agents/tasks/delivery') return { ok: true, value: { ready: false, checks: [{ name: '业务统计', ok: false }] } }
}

test('尚未确认任务的原生status返回对象，不触发工具输出schema错误或创建任务', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '先了解当前任务' })).value.session_id
  const result = await f.execute(id, 'task', 'status')
  assert.equal(f.tools.get('platform_task').output.schema.type, 'object')
  assert.equal(typeof result, 'object'); assert.equal(result.state, 'not_started')
  assert.equal((await f.status(id)).execution, undefined)
  assert.equal((await f.status(id)).proposals.length, 0)
  assert.equal(f.calls.length, 0)
})

test('管理助手工具以 owner 身份访问平台管理接口', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '查看已有实例', context: { skill: 'task-builder' } })).value.session_id
  await f.execute(id, 'instances', 'list')
  const call = f.peers[f.peers.length - 1]
  assert.equal(call.endpoint, 'instances/list')
  assert.equal(call.peer?.principal?.kind, 'owner')
})


test('任务一次确认后仅向固定目标连续执行，初测不计轮次且第四轮修复被拒绝', async t => {
  const f = fixture(t, taskResponder)
  const goals = installTaskGoals(f)
  const id = (await f.rpc('session', { task: '构建巡检助手', context: { skill: 'task-builder' } })).value.session_id
  await beginTask(f, id)
  for (const action of ['preview', 'start']) await assert.rejects(() => f.execute(id, 'task', action, { plan: taskPlan() }), /已有未结束任务/)
  assert.equal((await f.status(id)).proposals.length, 1, '活动任务重复 start 不再产生第二张无效确认卡')
  assert.equal(goals.get(id).maxGoalRounds, 60)
  await assert.rejects(() => f.execute(id, 'task', 'begin-repair'), /初次评测/)
  await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
  assert.equal((await f.status(id)).execution.repair_rounds, 0)
  await assert.rejects(() => f.execute(id, 'agents', 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/dsh/workspace/AGENTS.md', content: 'fix' }] }), /预留/)
  for (let round = 1; round <= 3; round++) {
    await f.execute(id, 'task', 'begin-repair')
    assert.equal((await f.execute(id, 'agents', 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/dsh/workspace/AGENTS.md', content: `fix ${round}` }] })).state, 'completed')
    await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
    assert.equal((await f.status(id)).execution.repair_rounds, round)
  }
  await assert.rejects(() => f.execute(id, 'task', 'begin-repair'), /最多三轮/)
  await assert.rejects(() => f.execute(id, 'agents', 'cases/update', { experiment_id: 'EXP-test-agent-001' }), /冻结/)
  assert.equal(f.calls.filter(row => row.endpoint === 'agents/eval/start').length, 4)
  assert.equal((await f.status(id)).proposals.length, 1)
})

test('真实Session持久记模型调用，暂停及冷恢复不重置额度，fork不继承执行权', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '构建巡检助手' })).value.session_id
  await f.beforeModelCall(id)
  await beginTask(f, id, taskPlan({ budget: { max_model_calls: 3, max_repair_rounds: 3, timeout_minutes: 30 } }))
  assert.equal((await f.status(id)).execution.model_calls, 1)
  await f.beforeModelCall(id)
  await f.rpc('task/pause', { session_id: id })
  const deadline = (await f.status(id)).execution.deadline_at
  await assert.rejects(() => f.beforeModelCall(id), /尚未恢复/)
  assert.equal((await f.rpc('task/resume', { session_id: id })).ok, true)
  await f.reload()
  assert.equal((await f.status(id)).execution.state, 'paused')
  assert.equal((await f.status(id)).execution.model_calls, 2)
  assert.equal((await f.rpc('task/resume', { session_id: id })).ok, true)
  await f.beforeModelCall(id)
  await assert.rejects(() => f.beforeModelCall(id), /额度已耗尽/)
  assert.equal((await f.status(id)).execution.state, 'budget_exhausted')
  assert.equal((await f.status(id)).execution.model_calls, 3)
  assert.equal((await f.status(id)).execution.deadline_at, deadline)
  f.addSession('task-fork', f.root, f.sessions.get(id).events, id)
  assert.equal((await f.status('task-fork')).execution, undefined)
  await assert.rejects(() => f.execute('task-fork', 'task', 'begin-repair'), /没有已确认任务/)
})

test('交付必须引用本任务Run并通过服务侧核验，模型ready不能覆盖失败', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '交付报告' })).value.session_id
  await beginTask(f, id)
  await assert.rejects(() => f.execute(id, 'task', 'deliver', { run_id: 'run-other', ready: true, artifacts: ['report.md'] }), /本任务实际启动/)
  await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
  assert.equal((await f.execute(id, 'task', 'deliver', { run_id: 'run-own', ready: true, artifacts: ['report.md'] })).state, 'verification_failed')
  assert.equal((await f.status(id)).execution.state, 'running')
})

test('首次创建把已确认业务Case传给真实new入口，回执一次绑定目标和评判摘要', async t => {
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/new' ? { ok: true, value: { source_id: 'experiment:EXP-test-agent-001', experiment_id: 'EXP-test-agent-001' } } : taskResponder(endpoint, input))
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '创建巡检助手' })).value.session_id
  await beginTask(f, id, taskPlan({ source: undefined, new_agent: { name: '设备巡检', description: '只读设备检查', role: '完整统计工具数据', evaluation_cases: [{ id: 'U-BUSINESS-001', title: '设备完整', inputs: '检查三台设备', expected_behavior: '包含全部设备且总数3' }] }, allowed_actions: [{ domain: 'agents', action: 'new' }] }))
  await f.execute(id, 'agents', 'new', { agent_id: 'test-agent', role: '丢弃业务要求' })
  assert.equal(f.calls.find(row => row.endpoint === 'agents/new').input.role, '完整统计工具数据')
  assert.equal((await f.status(id)).execution.target_source, 'experiment:EXP-test-agent-001')
  assert.equal((await f.status(id)).execution.evaluation_sha256, 'fixed-evaluation')
})

test('不可保存的新建Case在preview和start前被拒绝，不产生确认卡或执行任务', async t => {
  const f = fixture(t)
  const goals = installTaskGoals(f)
  const id = (await f.rpc('session', { task: '新建巡检助手并测试完整分页与漏页' })).value.session_id
  const business = { id: 'U-ASSET-PAGES-001', title: '完整分页', inputs: '读取全部分页', expected_behavior: '覆盖五台模拟设备' }
  const invalidCases = [
    [{ ...business, id: 'U-IDENTITY-001' }],
    [{ ...business, id: 'U-ROLE-001' }],
    [business, business],
    [{ ...business, title: '完整分页\n额外标题' }],
    [{ ...business, expected_behavior: '覆盖全部设备\n# 额外用例' }],
    Array.from({ length: 31 }, (_, i) => ({ ...business, id: `U-BUSINESS-${i}` })),
    [{ ...business, inputs: '设备'.repeat(5000) }],
  ]
  for (const evaluation_cases of invalidCases) {
    const plan = taskPlan({ source: undefined, evaluation_case_ids: [evaluation_cases[0].id], new_agent: { name: '巡检助手', description: '统计模拟台账', role: '读取实际工具数据', evaluation_cases } })
    for (const action of ['preview', 'start']) await assert.rejects(() => f.execute(id, 'task', action, { plan }))
    assert.equal((await f.rpc('task/start', { session_id: id, input: { plan } })).ok, false)
  }
  const state = await f.status(id)
  assert.equal(state.proposals.length, 0)
  assert.equal(state.execution, undefined)
  assert.equal(goals.size, 0)
  assert.equal(f.calls.length, 0)
})

test('新建业务Case可选择平台自动身份回归，不重复定义基础Case', async t => {
  const business = { id: 'U-BUSINESS-001', title: '完整设备', inputs: '读取全部分页', expected_behavior: '覆盖五台模拟设备' }
  const f = fixture(t, (endpoint, input) => {
    if (endpoint === 'agents/new') return { ok: true, value: { source_id: 'experiment:EXP-test-agent-001', experiment_id: 'EXP-test-agent-001' } }
    if (endpoint === 'agents/detail') return { ok: true, value: { experiment: { id: 'EXP-test-agent-001' }, evaluation: { sha256: 'fixed-evaluation', cases: [business, { id: 'U-IDENTITY-001' }, { id: 'U-ROLE-001' }] } } }
    return taskResponder(endpoint, input)
  })
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '创建巡检助手，保留身份回归' })).value.session_id
  await beginTask(f, id, taskPlan({ source: undefined, evaluation_case_ids: [business.id, 'U-IDENTITY-001', 'U-ROLE-001'], new_agent: { name: '巡检助手', description: '统计模拟台账', role: '读取实际工具数据', evaluation_cases: [business] }, allowed_actions: [{ domain: 'agents', action: 'new' }] }))
  await f.execute(id, 'agents', 'new', { agent_id: 'test-agent' })
  assert.equal((await f.status(id)).execution.target_source, 'experiment:EXP-test-agent-001')
  assert.deepEqual(f.calls.find(row => row.endpoint === 'agents/new').input.evaluation_cases, [{ ...business, fast: false }])
})

test('真实 Session 投影隔离上下文、冷恢复固定任务，用户 prompt 保持原文', async t => {
  const f = fixture(t)
  const task = '你好\n保留原始空格  '
  assert.equal((await f.rpc('session', { workspace_id: 'foreign-workspace' })).ok, false)
  const first = (await f.rpc('session', { task, context: { experiment_id: 'EXP-a-001', literal: '{{secret}}' } })).value.session_id
  const second = (await f.rpc('session', { context: { experiment_id: 'EXP-b-001' } })).value.session_id
  assert.notEqual(first, second)
  assert.equal(f.sessions.get(first).input.workspaceId, undefined)
  assert.equal(f.sessions.get(first).input.cwd, f.root)
  assert.deepEqual(f.prompts[0].content, [{ type: 'text', text: task }])
  await f.rpc('context', { session_id: first, context: { experiment_id: 'EXP-a-002' } })
  await f.reload()
  const status = await f.status(first)
  assert.equal(status.context.experiment_id, 'EXP-a-002')
  assert.equal(status.task_context.experiment_id, 'EXP-a-001')
  const a = await f.assemble(first), b = await f.assemble(second)
  assert.ok(a.includes('EXP-a-001') && a.includes('EXP-a-002') && a.includes('{{secret}}'))
  assert.ok(!a.includes('EXP-b-001') && !a.includes(task))
  assert.ok(b.includes('EXP-b-001') && !b.includes('EXP-a-'))
  assert.equal(f.prompts.length, 1, '页面变化和冷恢复不得触发用户消息')
  f.addSession('ordinary')
  assert.equal(await f.assemble('ordinary'), '', '普通原生会话不自动注入平台策略')
  f.addSession('foreign', '/another-project')
  assert.equal((await f.rpc('status', { session_id: 'foreign' })).ok, false)
})

test('向已有专用会话追加无context指导保留固定skill与目标，不跟随最新页面', async t => {
  const f = fixture(t), fixed = { skill: 'compute-variant-research', workflow: 'compute-variants', agent_id: 'alpha', experiment_id: 'EXP-alpha-002' }
  let scoped = 0, managed = 0, released = 0
  f.services.scopeComputeVariants = () => { scoped++ }
  f.services.releaseTaskScope = () => { released++ }
  const id = (await f.rpc('session', { task: '生成代码变体', context: fixed })).value.session_id
  await f.rpc('context', { session_id: id, context: { page: 'instances', instance_name: 'latest-page-only' } })
  assert.equal((await f.rpc('session', { session_id: id, task: '补充真实Guard探针事实' })).ok, true)
  const status = await f.status(id)
  assert.deepEqual(status.task_context, fixed)
  assert.equal(status.context.instance_name, 'latest-page-only')
  assert.equal(f.prompts.at(-1).sessionId, id)
  assert.deepEqual(f.prompts.at(-1).content, [{ type: 'text', text: '补充真实Guard探针事实' }])
  assert.ok(scoped > 0)
  await f.reload()
  assert.deepEqual((await f.status(id)).task_context, fixed, '保留的固定上下文必须可冷恢复')
  const beforeManagement = managed, beforeRelease = released
  assert.equal((await f.rpc('session', { session_id: id, task: '显式切换普通讨论', context: {} })).ok, true)
  assert.deepEqual((await f.status(id)).task_context, {})
  assert.equal(managed, beforeManagement, '通用管理不额外应用平台任务作用域')
  assert.ok(released > beforeRelease, '退出专用任务后释放专用 Scope，使用原生 DSH 工具')
})

test('各类平台任务只装载一份共用表达正文，不写入用户消息或会话事实', async t => {
  const principles = expressionFixture
  assert.ok(principles, '共用表达来源必须有正文')
  const f = fixture(t)
  const suffixOrder = f.services.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
  const before = f.services.systemPrompt.section({ name: 'test/before-persona-suffix', order: suffixOrder - 0.5, text: '部署角色收尾之前' })
  const after = f.services.systemPrompt.section({ name: 'test/after-persona-suffix', order: suffixOrder + 0.5, text: '部署角色收尾之后' })
  t.after(() => { before(); after() })
  const contexts = [
    { page: 'home' },
    { page: 'agents', skill: 'agent-maintenance', workflow: 'features', agent_id: 'basic', experiment_id: 'EXP-basic-001' },
    { page: 'agents', skill: 'agent-maintenance', workflow: 'research', experiment_id: 'EXP-basic-001' },
    { page: 'agents', skill: 'compute-variant-research', workflow: 'compute-variants', experiment_id: 'EXP-basic-001' },
    { page: 'mcp', skill: 'mcp-composition' },
    { page: 'evaluation', skill: 'decision-sample-extraction', run_id: 'run-fixed' },
    { page: 'instances' },
  ]
  for (const context of contexts) {
    const task = `请处理 ${context.workflow ?? context.page}`
    const id = (await f.rpc('session', { task, context })).value.session_id
    const assembled = await f.assemble(id)
    assert.equal(assembled.split(principles).length - 1, 1, `${context.workflow ?? context.page} 应装载唯一正文`)
    const { sections } = await f.assembly(id)
    const names = sections.map(item => item.name)
    const outputIndex = names.indexOf('harness-platform/assistant-output')
    assert.equal(sections[outputIndex]?.text, principles)
    assert.ok(names.indexOf('harness-platform/assistant') < names.indexOf('test/before-persona-suffix'))
    assert.ok(names.indexOf('test/before-persona-suffix') < outputIndex && outputIndex < names.indexOf('test/after-persona-suffix'), '表达正文使用 Runtime 官方部署角色收尾位置')
    assert.equal(sections.map(item => item.text).join('\n').split(principles).length - 1, 1, '整组系统提示不得重复装载原则')
    assert.deepEqual(f.prompts.at(-1).content, [{ type: 'text', text: task }])
    assert.ok(!JSON.stringify(f.sessions.get(id).events).includes(JSON.stringify(principles).slice(1, -1)), '运行记录不复制共用可编辑原则')
  }
  assert.equal(f.calls.length, 0, '装载表达原则不发起业务操作')
})

test('原生 Session 事件冷恢复后仍装载表达正文，普通会话与其他工作区保持隔离', async t => {
  const principles = expressionFixture
  const original = fixture(t)
  const id = (await original.rpc('session', { task: '抽取决策样本', context: { skill: 'decision-sample-extraction', run_id: 'run-fixed' } })).value.session_id
  const events = [...original.sessions.get(id).events]
  const restored = fixture(t, undefined, original.root)
  restored.addSession(id, original.root, events)
  assert.equal((await restored.assemble(id)).split(principles).length - 1, 1)
  assert.equal((await restored.status(id)).task_context.run_id, 'run-fixed')
  await restored.reload()
  assert.equal((await restored.assemble(id)).split(principles).length - 1, 1, '重新注册不能重复注入')
  restored.addSession('ordinary')
  restored.addSession('foreign', '/another-project', events)
  assert.equal(await restored.assemble('ordinary'), '')
  assert.equal(await restored.assemble('foreign'), '')
  assert.equal(restored.prompts.length, 0, '恢复和系统提示装载不得伪造用户消息')
})

test('表达 Skill 与管理规则从当前数据读取，编辑后及冷恢复立即生效，程序副本不替代来源', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { context: { page: 'home' } })).value.session_id
  const path = join(f.root, '.agents/skills/user-facing-output/SKILL.md')
  writeFileSync(path, '---\nname: user-facing-output\ndescription: 表达\n---\n当前数据中的新表达原则')
  writeFileSync(join(f.root, 'AGENTS.md'), '当前数据中的新管理原则')
  assert.match(await f.assemble(id), /当前数据中的新表达原则/)
  assert.match(await f.assemble(id), /当前数据中的新管理原则/)
  await f.reload()
  assert.match(await f.assemble(id), /当前数据中的新表达原则/)
  const before = f.sessions.get(id).events.length
  rmSync(path)
  assert.equal((await f.rpc('configuration', {})).value.core_ready, false)
  assert.equal((await f.rpc('session', { task: '新任务' })).ok, false)
  await assert.rejects(() => f.beforeModelCall(id), /未配置平台管理助手/)
  assert.equal((await f.rpc('status', { session_id: id })).ok, true)
  assert.equal(f.sessions.get(id).events.length, before)
  assert.equal(f.prompts.length, 0)
})

test('配置检查区分核心和专项缺失，并拒绝原生注册表同名的程序来源', async t => {
  const f = fixture(t)
  rmSync(join(f.root, '.agents/skills/decision-sample-extraction/SKILL.md'))
  const general = (await f.rpc('configuration', {})).value
  assert.equal(general.ready, true)
  assert.equal(general.tasks['decision-sample-extraction'], false)
  const extraction = (await f.rpc('configuration', { context: { skill: 'decision-sample-extraction' } })).value
  assert.equal(extraction.ready, false)
  assert.equal(extraction.core_ready, true)
  const original = f.services.skills.get
  f.services.skills.get = async (name, options) => name === 'user-facing-output' ? { name, path: '/old-program/platform/skills/user-facing-output/SKILL.md', content: '旧规则' } : original(name, options)
  assert.equal((await f.rpc('configuration', {})).value.core_ready, false)
  assert.equal((await f.rpc('session', { task: '新任务' })).ok, false)
  assert.equal(f.sessions.size, 0)
})

test('工具在确认前保持 pending，真实回执返回原调用，重复确认不重复写入或伪造消息', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '停止实例' })).value.session_id
  await f.execute(id, 'agents', 'eval/status', { job_id: 'same-job' })
  assert.equal(f.calls[0].endpoint, 'agents/eval/status')
  let returned = false
  const operation = f.execute(id, 'instances', 'run', { name: 'isolated', operation: 'stop' }).then(value => { returned = true; return value })
  const proposed = await f.proposal(id)
  assert.equal(returned, false)
  assert.equal(f.calls.filter(call => call.endpoint === 'instances/run').length, 0)
  const confirmed = await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  assert.equal(confirmed.value.continuation, 'resumed')
  const receipt = await operation
  assert.equal(receipt.kind, 'platform-operation')
  assert.equal(receipt.state, 'completed')
  assert.equal(receipt.preview, undefined, '已结算工具结果不得携带仍要求确认的旧预览')
  assert.equal(receipt.input, undefined)
  assert.ok((await f.status(id)).proposals[0].preview, '原始提案预览仍留在Session供界面核对')
  assert.equal(receipt.result.value.source, 'instances/run')
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  assert.equal(f.calls.filter(call => call.endpoint === 'instances/run').length, 1)
  assert.equal(f.calls.find(call => call.endpoint === 'instances/run').input.confirmed, true)
  assert.equal(f.prompts.length, 1)
})

test('实例创建、启动和重启由助手内部预览冻结来源、端口及模型设置，一次确认直接执行', async t => {
  assert.match(assistantActionContract('instances', 'run').instructions, /versions\[0\]\.id/)
  assert.match(assistantActionContract('agents', 'detail').instructions, /已启用版本/)
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '按固定版本办理实例操作' })).value.session_id
  for (const operation of ['create', 'start', 'restart']) {
    const request = { operation, name: `assistant-${operation}`, ...(operation === 'create' ? { source: 'experiment:EXP-test-agent-001' } : {}),
      expected_model_policy_hash: 'b'.repeat(64) }
    const pending = f.execute(id, 'instances', 'run', request)
    const card = await f.proposal(id)
    assert.equal(f.calls.at(-1).endpoint, 'instances/preview')
    assert.equal(f.calls.some(call => call.endpoint === 'instances/run' && call.input.name === request.name), false)
    assert.equal(card.input.expected_source_id, 'experiment:EXP-test-agent-001')
    assert.equal(card.input.port, 3199)
    assert.deepEqual(card.input.model_selection, { provider: 'fixture', model: 'default' })
    assert.equal(card.input.expected_model_policy_hash, 'a'.repeat(64), '模型填入的旧摘要不得覆盖实际预览')
    const confirmed = await f.rpc('confirm', { session_id: id, proposal_id: card.id })
    assert.equal(confirmed.value.state, 'completed')
    assert.equal((await pending).state, 'completed')
    const run = f.calls.find(call => call.endpoint === 'instances/run' && call.input.name === request.name)
    assert.equal(run.input.confirmed, true)
    assert.equal(run.input.expected_model_policy_hash, 'a'.repeat(64))
    await f.rpc('confirm', { session_id: id, proposal_id: card.id })
    assert.equal(f.calls.filter(call => call.endpoint === 'instances/run' && call.input.name === request.name).length, 1)
  }
})

test('业务实例创建冻结来源摘要、访问方式并使用统一网关入口', async t => {
  const contract = assistantActionContract('instances', 'run')
  for (const key of ['business_control', 'access_mode', 'identity_mode']) assert.ok(contract.input_schema.properties[key], `${key} 应出现在实例合同`)
  assert.deepEqual(contract.input_schema.properties.access_mode.enum, ['authenticated', 'anonymous'])
  assert.deepEqual(contract.input_schema.properties.identity_mode.enum, ['development', 'published'])
  const digest = 'sha256:' + 'b'.repeat(64)
  const f = fixture(t, async endpoint => {
    if (endpoint === 'instances/preview') return { ok: true, value: {
      name: 'biz-one', operation: 'create', source_id: 'experiment:EXP-test-agent-001',
      plan: { source_id: 'experiment:EXP-test-agent-001', port: 18600, business_control: { source_digest: digest } },
      access_mode: 'anonymous', identity_mode: 'development',
      model_selection: { provider: 'fixture', model: 'default' }, model_policy_hash: 'a'.repeat(64),
    } }
    if (endpoint === 'instances/url') return { ok: true, value: { url: 'http://172.16.138.228:53105/agents/security-operations-expert/instances/biz-one/', lan_access: true } }
  })
  const id = (await f.rpc('session', { task: '创建业务受控实例' })).value.session_id
  const pending = f.execute(id, 'instances', 'run', { name: 'biz-one', operation: 'create', source: 'experiment:EXP-test-agent-001', port: 18600,
    business_control: true, access_mode: 'anonymous', identity_mode: 'development' })
  const card = await f.proposal(id)
  assert.equal(card.input.business_control, true)
  assert.equal(card.input.expected_source_digest, digest)
  assert.equal(card.input.access_mode, 'anonymous')
  assert.equal(card.input.identity_mode, 'development')
  await f.rpc('confirm', { session_id: id, proposal_id: card.id })
  const receipt = await pending
  assert.equal(receipt.state, 'completed')
  const run = f.calls.find(call => call.endpoint === 'instances/run')
  assert.equal(run.input.business_control, true)
  assert.equal(run.input.expected_source_digest, digest)
  assert.equal(run.input.access_mode, 'anonymous')
  assert.equal(receipt.result.value.entry_url, 'http://172.16.138.228:53105/agents/security-operations-expert/instances/biz-one/')
})

test('实例预览失败、对象变化和批量部分失败均不生成可执行提案', async t => {
  const f = fixture(t, (endpoint, input) => {
    if (endpoint === 'instances/batch-preview') return { ok: true, value: { previews: [
      { name: 'first', operation: 'stop', ok: true, value: { name: 'first', operation: 'stop', source_id: 'experiment:EXP-test-agent-001', observed_state: 'running', observed_at: '2026-10-21T00:00:00.000Z' } },
      { name: 'second', operation: 'stop', ok: false, error: { message: '状态未知' } },
    ] } }
    if (endpoint === 'instances/preview' && input.name === 'mismatch') return { ok: true, value: { name: 'other', operation: 'create', plan: { source_id: input.source, port: 3199 }, model_selection: { provider: 'fixture', model: 'default' }, model_policy_hash: 'a'.repeat(64) } }
    if (endpoint === 'instances/preview' && input.name === 'failed') return { ok: false, error: { message: '模型不可用' } }
  })
  const id = (await f.rpc('session', { task: '检查实例操作' })).value.session_id
  assert.equal((await f.execute(id, 'instances', 'run', { name: 'failed', operation: 'create', source: 'experiment:EXP-test-agent-001' })).ok, false)
  await assert.rejects(() => f.execute(id, 'instances', 'run', { name: 'missing-source', operation: 'create' }), /固定版本/)
  await assert.rejects(() => f.execute(id, 'instances', 'run', { name: 'mismatch', operation: 'create', source: 'experiment:EXP-test-agent-001' }), /预览与请求对象不一致/)
  await assert.rejects(() => f.execute(id, 'instances', 'batch', { items: [{ name: 'first', operation: 'stop' }, { name: 'second', operation: 'stop' }] }), /预览失败/)
  assert.equal((await f.status(id)).proposals.length, 0)
  assert.equal(f.calls.some(call => ['instances/run', 'instances/batch'].includes(call.endpoint)), false)
})

test('已确认整体任务中的实例操作也先核对模型设置，不重复请求确认', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '按固定目标交付实例' })).value.session_id
  await beginTask(f, id)
  const count = (await f.status(id)).proposals.length
  const receipt = await f.execute(id, 'instances', 'run', {
    operation: 'create', name: 'test-delivery', source: 'experiment:EXP-test-agent-001',
  })
  assert.equal(receipt.state, 'completed')
  assert.equal((await f.status(id)).proposals.length, count)
  const preview = f.calls.find(call => call.endpoint === 'instances/preview')
  const run = f.calls.find(call => call.endpoint === 'instances/run')
  assert.ok(preview)
  assert.equal(run.input.expected_source_id, 'experiment:EXP-test-agent-001')
  assert.equal(run.input.expected_model_policy_hash, 'a'.repeat(64))
})

test('真实实例 handler 接收助手一次确认的冻结参数，策略过期与批量坏项不启动实例', async t => {
  let handler
  const f = fixture(t, (endpoint, input, signal) => endpoint.startsWith('instances/')
    ? handler(endpoint.slice('instances/'.length), input, signal) : undefined)
  const previousProgram = process.env.HARNESS_PROGRAM_ROOT
  const previousPython = process.env.HARNESS_PYTHON
  const previousState = process.env.HARNESS_INSTANCE_STATE_ROOT
  process.env.HARNESS_PROGRAM_ROOT = f.root
  process.env.HARNESS_PYTHON = process.execPath
  process.env.HARNESS_INSTANCE_STATE_ROOT = join(f.root, '.local/instances')
  t.after(() => {
    if (previousProgram === undefined) delete process.env.HARNESS_PROGRAM_ROOT; else process.env.HARNESS_PROGRAM_ROOT = previousProgram
    if (previousPython === undefined) delete process.env.HARNESS_PYTHON; else process.env.HARNESS_PYTHON = previousPython
    if (previousState === undefined) delete process.env.HARNESS_INSTANCE_STATE_ROOT; else process.env.HARNESS_INSTANCE_STATE_ROOT = previousState
  })
  const adapter = join(f.root, 'runtime/adapters/dsh-container')
  const callsPath = join(f.root, 'dsh-dev.calls')
  mkdirSync(adapter, { recursive: true })
  writeFileSync(join(adapter, 'sources.json'), JSON.stringify({ sources: { 'EXP-real-agent-002': { agent_id: 'real-agent' } } }))
  writeFileSync(join(adapter, 'dsh-dev'), `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n')
const option = key => args[args.indexOf(key) + 1]
if (args[0] === 'up') console.log(JSON.stringify(args.includes('--dry-run')
  ? { name: option('--name'), source_id: option('--source'), port: Number(option('--port')) || 3199, image_tag: 'dsh:fixture', mounts: [] }
  : { name: option('--name'), dsh_running: true }))
else if (args[0] === 'ps') console.log(JSON.stringify({ instances: [{ name: 'existing', state: 'running', source_id: 'experiment:EXP-real-agent-002' }] }))
else throw new Error('unexpected command')
`)
  mkdirSync(join(f.root, '.local/instances/existing'), { recursive: true })
  writeFileSync(join(f.root, '.local/instances/existing/instance.json'), JSON.stringify({
    name: 'existing', source_id: 'experiment:EXP-real-agent-002', port: 3198,
    model_policy: { default: { provider: 'fixture', model: 'business' } },
  }))
  let revision = 'current'
  const selected = { provider: 'fixture', model: 'business' }
  handler = createInstancesHandler(f.root, async (agentId, model) => {
    assert.equal(agentId, 'real-agent')
    assert.deepEqual(model ?? selected, selected)
    return { policy: { allowed: [selected], default: selected, revision }, environment: {} }
  })
  const id = (await f.rpc('session', { task: '以最新固定版本创建并启动实例' })).value.session_id
  const source = 'experiment:EXP-real-agent-002'
  const created = f.execute(id, 'instances', 'run', { operation: 'create', name: 'new-one', source })
  const card = await f.proposal(id)
  assert.equal(card.preview.value.plan.source_id, source)
  assert.equal(card.input.expected_source_id, source)
  assert.deepEqual(card.input.model_selection, selected)
  assert.match(card.input.expected_model_policy_hash, /^[0-9a-f]{64}$/)
  assert.equal(f.calls.some(call => call.endpoint === 'instances/run'), false)
  const confirmed = await f.rpc('confirm', { session_id: id, proposal_id: card.id })
  assert.equal(confirmed.value.state, 'completed')
  assert.equal((await created).state, 'completed')
  assert.equal(f.calls.find(call => call.endpoint === 'instances/run').input.expected_model_policy_hash, card.input.expected_model_policy_hash)
  for (const operation of ['start', 'restart']) {
    const pending = f.execute(id, 'instances', 'run', { operation, name: 'existing' })
    const proposed = await f.proposal(id)
    assert.equal(proposed.input.expected_source_id, source)
    assert.equal(proposed.input.port, 3198)
    assert.match(proposed.input.expected_model_policy_hash, /^[0-9a-f]{64}$/)
    await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
    assert.equal((await pending).state, 'completed')
  }
  const stale = f.execute(id, 'instances', 'run', { operation: 'create', name: 'stale-one', source })
  const staleCard = await f.proposal(id)
  const before = readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(args => args[0] === 'up' && !args.includes('--dry-run')).length
  revision = 'changed'
  assert.equal((await f.rpc('confirm', { session_id: id, proposal_id: staleCard.id })).value.state, 'failed')
  assert.equal((await stale).state, 'failed')
  assert.equal(readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(args => args[0] === 'up' && !args.includes('--dry-run')).length, before)
  const batch = await f.execute(id, 'instances', 'batch', { items: [
    { operation: 'create', name: 'good-one', source }, { operation: 'create', name: 'bad-one', source: 'experiment:EXP-missing-003' },
  ] }).catch(error => error)
  assert.match(String(batch), /预览失败/)
  assert.equal(f.calls.some(call => call.endpoint === 'instances/batch'), false)
})

test('原生记录冷恢复后可确认一次，但不会通过伪用户消息自动启动旧工具', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', {})).value.session_id
  appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', {
    kind: 'proposal', id: 'cold-proposal', domain: 'instances', action: 'run',
    input: { name: 'isolated', operation: 'stop' }, preview: {}, state: 'awaiting_confirmation',
  })
  await f.reload()
  const receipt = await f.rpc('confirm', { session_id: id, proposal_id: 'cold-proposal' })
  assert.equal(receipt.value.continuation, 'requires_user_message')
  await f.rpc('confirm', { session_id: id, proposal_id: 'cold-proposal' })
  assert.equal(f.calls.filter(call => call.endpoint === 'instances/run').length, 1)
  assert.equal(f.prompts.length, 0)
})

test('fork 可继承上下文，不能继承父会话提案或确认权', async t => {
  const f = fixture(t)
  const parent = (await f.rpc('session', { context: { experiment_id: 'EXP-parent' } })).value.session_id
  appendPluginRecord(f.sessions.get(parent).session, 'plugin:harness-platform/assistant', {
    kind: 'proposal', id: 'legacy-parent-proposal', domain: 'instances', action: 'run', input: {}, state: 'awaiting_confirmation',
  })
  const second = (await f.rpc('session', {})).value.session_id
  f.addSession('forked', f.root, f.sessions.get(parent).events, parent)
  assert.ok((await f.assemble('forked')).includes('EXP-parent'))
  assert.deepEqual((await f.status('forked')).proposals, [])
  for (const session_id of ['forked', second]) assert.equal((await f.rpc('confirm', { session_id, proposal_id: 'legacy-parent-proposal' })).ok, false)
  assert.equal(f.calls.length, 0)
})

test('冷恢复中断的 running 仅在读取时显示 unknown，不改写记录或自动重试', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', {})).value.session_id
  appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', {
    kind: 'proposal', id: 'interrupted-operation', domain: 'instances', action: 'run',
    input: { name: 'isolated', operation: 'stop' }, state: 'running', owner_session_id: id,
  })
  const prior = f.sessions.get(id).events.length
  await f.reload()
  assert.equal((await f.status(id)).proposals[0].state, 'unknown')
  await f.rpc('confirm', { session_id: id, proposal_id: 'interrupted-operation' })
  assert.equal(f.calls.length, 0)
  assert.equal(f.sessions.get(id).events.length, prior)
  assert.equal(f.ctx.sessionProjections.stateOf(f.sessions.get(id).session, 'harnessPlatformAssistant').proposals[0].state, 'running')
})

test('取消待确认工具会结算取消，不能随后确认执行', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', {})).value.session_id
  const operation = f.execute(id, 'instances', 'run', { name: 'isolated', operation: 'stop' })
  const proposed = await f.proposal(id)
  await f.rpc('cancel', { session_id: id })
  const receipt = await operation
  assert.equal(receipt.kind, 'platform-operation')
  assert.equal(receipt.state, 'cancelled')
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  assert.equal(f.calls.filter(call => call.endpoint === 'instances/run').length, 0)
})

test('写入 running 回执期间取消，不会退回浏览器信号执行写入', async t => {
  const f = fixture(t), tool = new AbortController()
  const id = (await f.rpc('session', {})).value.session_id
  const operation = f.execute(id, 'instances', 'run', { name: 'isolated', operation: 'stop' }, tool.signal)
  const proposed = await f.proposal(id)
  const original = f.services.record
  f.services.record = async (session, type, value) => {
    original(session, type, value)
    if (value.kind === 'settlement' && value.state === 'running') tool.abort()
  }
  assert.equal((await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })).ok, false)
  assert.equal((await operation).state, 'cancelled')
  assert.equal((await f.status(id)).proposals[0].state, 'cancelled')
  assert.equal(f.calls.filter(call => call.endpoint === 'instances/run').length, 0)
})

test('工具方案关联真实 Session；结果脱敏且模型结束不伪造融合成功', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', {})).value.session_id
  await f.execute(id, 'agents', 'fusion/preview', { agent_id: 'a' })
  assert.equal(f.calls[0].input.assistant_session_id, id)
  assert.equal((await f.status(id)).proposals.length, 0)
  assert.deepEqual(redactAssistant({ password: 'private', headers: { Authorization: 'Bearer private' }, token: 'private', credential_configured: true }),
    { password: '[已隐藏]', headers: { Authorization: '[已隐藏]' }, token: '[已隐藏]', credential_configured: true })
})

test('MCP 配置使用数据仓库 revision，调试管理复用实际 dispatcher action', async () => {
  const calls = []
  const bridge = assistantMcp({ configuration: () => ({ revision: 'r9', value: { servers: [{ id: 'soc', enabled: true,
    url: 'http://fixture.invalid/mcp', apiKey: 'opaque-fixture-key', headers: [{ name: 'X-Custom', value: 'opaque-fixture-header' }],
    tools: { mode: 'all', names: [] } }], groups: [], sharedToken: 'opaque-fixture-group' } }),
    saveConfiguration(...args) { calls.push(args); return { revision: 'r10' } },
    dispatch: async request => { calls.push(request); return { status: 200, value: { tools: [] } } } })
  const signal = new AbortController().signal
  const view = (await bridge('configuration', {}, signal)).value
  assert.equal(view.revision, 'r9')
  assert.equal(view.server_access[0].headers[0].configured, true)
  for (const secret of ['opaque-fixture-key', 'opaque-fixture-header', 'opaque-fixture-group']) {
    assert.ok(!JSON.stringify(view).includes(secret), '助手配置投影不得回显任意格式的凭据')
  }
  await bridge('saveConfiguration', { ops: [{ op: 'set', path: ['servers', '0', 'description'], value: '更新' }], revision: 'r9' }, signal)
  assert.equal(calls[0][1], 'r9')
  await assert.rejects(bridge('saveConfiguration', { ops: [{ op: 'set', path: ['servers'], value: view.value.servers }], revision: 'r9' }, signal), /整体替换/)
  await assert.rejects(bridge('saveConfiguration', { ops: [{ op: 'set', path: ['servers', '0', 'headers'], value: [] }], revision: 'r9' }, signal), /凭据/)
  for (const op of [
    { op: 'set', path: ['sharedToken'], value: 'opaque-fixture-group' },
    { op: 'set', path: ['servers', '0', 'loginUsername'], value: 'opaque-fixture-login' },
    { op: 'set', path: ['servers', '1'], value: { id: 'next', headers: [{ name: 'X-Custom', value: 'opaque-fixture-header' }] } },
    { op: 'set', path: ['servers', '1'], value: { id: 'next', apiKey: 'opaque-fixture-key' } },
  ]) await assert.rejects(bridge('saveConfiguration', { ops: [op], revision: 'r9' }, signal), /凭据/)
  assert.equal(calls.length, 1, '直接桥接拒绝凭据修改，不调用配置保存')
  await bridge('sources/list', { serverId: 'soc' }, signal)
  assert.equal(calls[1].action, 'sources')
})

test('完整融合方案成为待确认卡片，确认后返回原工具，冻结的工具参数保持不变', async t => {
  const f = fixture(t, endpoint => endpoint === 'agents/fusion/preview' ? { ok: true, value: { preview_id: 'fixed-preview', plan_ready: true, plan: { features: [] } } } : undefined)
  const id = (await f.rpc('session', {})).value.session_id
  const frozen = Object.freeze({ agent_id: 'a' })
  const operation = f.execute(id, 'agents', 'fusion/preview', frozen)
  const card = await f.proposal(id)
  assert.equal(card.action, 'fusion/confirm')
  assert.equal(frozen.assistant_session_id, undefined)
  assert.equal(f.calls.filter(call => call.endpoint === 'agents/fusion/confirm').length, 0)
  await f.rpc('confirm', { session_id: id, proposal_id: card.id })
  assert.equal((await operation).state, 'completed')
  assert.equal(f.calls.find(call => call.endpoint === 'agents/fusion/confirm').input.preview_id, 'fixed-preview')
})

test('已确认融合只自主编辑同 Session 目标 Candidate，评测口径仍等待确认', async t => {
  const f = fixture(t, endpoint => endpoint === 'agents/fusion/status' ? { ok: true, value: { creation: { status: 'integrating', assistant_session_id: 'session-1' } } } : undefined)
  const id = (await f.rpc('session', {})).value.session_id
  const allowed = await f.execute(id, 'agents', 'edit/apply', { experiment_id: 'EXP-a-002', edits: [{ path: 'candidate/dsh/workspace/AGENTS.md', content: '融合' }] })
  assert.equal(allowed.state, 'completed')
  const protectedEdit = f.execute(id, 'agents', 'edit/apply', { experiment_id: 'EXP-a-002', edits: [{ path: 'agents/a/evaluation.md', content: '不同口径' }] })
  assert.equal((await f.proposal(id)).state, 'awaiting_confirmation')
  assert.equal(f.calls.filter(call => call.endpoint === 'agents/edit/apply').length, 1)
  await f.rpc('cancel', { session_id: id })
  await protectedEdit
  await assert.rejects(f.execute(id, 'mcp', 'saveConfiguration', { revision: 1, ops: [{ op: 'set', path: ['servers', '0', 'apiKey'], value: 'fixture-secret' }] }), /凭据/)
  assert.ok(!JSON.stringify(f.sessions.get(id).events).includes('fixture-secret'))
})

for (const action of ['callPublishedComposition', 'callTool']) test(`${action} 提案冻结实际发布版本，后续发布不改变确认目标`, async t => {
  const originalVersion = '1'.repeat(64), nextVersion = '2'.repeat(64)
  const entry = { id: 'composition-fixed', publishedVersionId: originalVersion, published: { toolName: 'basic_status', title: '原版基础状态', description: '固定基础模拟数据' } }
  const f = fixture(t, (endpoint, input) => endpoint === 'mcp/list'
    ? { ok: true, value: { compositions: [entry] } }
    : endpoint === 'mcp/callPublishedComposition' ? { ok: true, value: { executed_version: input.versionId } } : undefined)
  const id = (await f.rpc('session', {})).value.session_id
  const input = action === 'callTool' ? { serverId: 'platform-compositions', toolName: 'basic_status', arguments: { asset: 'test' } }
    : { toolName: 'basic_status', input: { asset: 'test' }, compositionId: 'model-supplied', versionId: nextVersion }
  const before = structuredClone(input)
  const operation = f.execute(id, 'mcp', action, Object.freeze(input))
  const card = await f.proposal(id)
  assert.equal(card.action, 'callPublishedComposition')
  assert.equal(card.preview.title, '原版基础状态')
  assert.equal(card.preview.versionId, originalVersion)
  assert.equal(card.input.compositionId, entry.id)
  assert.deepEqual(input, before)
  entry.publishedVersionId = nextVersion
  entry.published = { ...entry.published, title: '后来发布的版本' }
  const confirmed = await f.rpc('confirm', { session_id: id, proposal_id: card.id })
  assert.equal(confirmed.value.result.value.executed_version, originalVersion)
  assert.equal((await operation).state, 'completed')
  await f.rpc('confirm', { session_id: id, proposal_id: card.id })
  assert.deepEqual(f.calls.filter(call => call.endpoint === 'mcp/callPublishedComposition').map(call => call.input), [{
    toolName: 'basic_status', compositionId: entry.id, versionId: originalVersion, input: { asset: 'test' }, confirmed: true,
  }])
})

test('冷恢复的旧组合卡片缺少固定版本时拒绝执行', async t => {
  const f = fixture(t), id = (await f.rpc('session', {})).value.session_id
  for (const action of ['callPublishedComposition', 'callTool']) {
    appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', {
      kind: 'proposal', id: action, owner_session_id: id, domain: 'mcp', action,
      input: { serverId: 'platform-compositions', toolName: 'basic_status', input: {} }, state: 'awaiting_confirmation',
    })
    const response = await f.rpc('confirm', { session_id: id, proposal_id: action })
    assert.equal(response.ok, false)
    assert.match(response.error.message, /固定组合版本/)
  }
  assert.deepEqual(f.calls, [])
})

test('URL 用户信息及查询凭据在写提案前拒绝，查询、上下文和错误展示均脱敏', async t => {
  const credentials = [
    'https://demo-user:dummy-password@fixture.invalid/spec',
    'https://fixture.invalid/spec?token=dummy-token',
    'https://fixture.invalid/spec?api_key=dummy-api-key',
    'wss://fixture.invalid/mcp?access_token=dummy-access-token',
    "https://fixture.invalid/spec?token=dummy-quoted'token",
  ]
  const f = fixture(t, () => ({ ok: true, value: { url: credentials[0], message: `请求失败：${credentials[1]}`, nested: [{ endpoint: credentials[2] }] } }))
  const id = (await f.rpc('session', {})).value.session_id
  for (const url of credentials) await assert.rejects(f.execute(id, 'mcp', 'saveConfiguration', {
    revision: 1, ops: [{ op: 'set', path: ['servers', '0', 'specUrl'], value: url }],
  }), /凭据请通过 MCP 管理页面维护/)
  assert.equal((await f.status(id)).proposals.length, 0)
  assert.equal(f.calls.length, 0)
  await f.rpc('context', { session_id: id, context: { url: credentials[0] } })
  const read = await f.execute(id, 'mcp', 'list')
  assert.ok(!JSON.stringify(read).includes('dummy-'))
  assert.ok(!JSON.stringify(f.sessions.get(id).events).includes('dummy-'))
  assert.ok(!(await f.assemble(id)).includes('dummy-'))
  const ordinary = 'https://EXAMPLE.invalid:443/spec?q=basic&page=2#view'
  assert.equal(redactAssistant(ordinary), ordinary, '普通 URL 原样保留，不因规范化误判凭据')
  const throwing = fixture(t, () => { throw new Error(`上游连接失败：${credentials[1]}`) })
  const throwingId = (await throwing.rpc('session', {})).value.session_id
  await assert.rejects(throwing.execute(throwingId, 'mcp', 'list'), error => !error.message.includes('dummy-') && !error.stack.includes('dummy-'))
  const previewFailure = fixture(t, () => ({ ok: false, error: { message: `预览连接失败：${credentials[1]}` } }))
  const previewId = (await previewFailure.rpc('session', {})).value.session_id
  assert.ok(!JSON.stringify(await previewFailure.execute(previewId, 'instances', 'run', { name: 'fixture', operation: 'stop' })).includes('dummy-'))
  appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', {
    kind: 'proposal', id: 'legacy-credential', owner_session_id: id, domain: 'mcp', action: 'saveConfiguration',
    input: { revision: 1, ops: [{ op: 'set', path: ['servers', '0', 'specUrl'], value: credentials[0] }] }, state: 'awaiting_confirmation',
  })
  assert.ok(!JSON.stringify(await f.status(id)).includes('dummy-'))
  assert.equal((await f.rpc('confirm', { session_id: id, proposal_id: 'legacy-credential' })).ok, false)
  f.services.controller.resolveAgent = async () => { throw new Error(`连接失败：${credentials[1]}`) }
  const failure = await f.rpc('status', { session_id: id })
  assert.ok(!JSON.stringify(failure).includes('dummy-'))
  // 恢复内存夹具，便于正常释放原生投影。
  f.services.controller.resolveAgent = async sessionId => ({ agent: { session: f.sessions.get(sessionId).session } })
})

test('MCP 服务凭据和任意 Header 值在提案持久化前拒绝', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', {})).value.session_id
  const opaque = 'opaque-fixture-private-value'
  for (const op of [
    { op: 'set', path: ['servers', '0', 'headers'], value: [{ name: 'X-Custom', value: opaque }] },
    { op: 'set', path: ['servers', '0', 'loginUsername'], value: opaque },
    { op: 'set', path: ['servers', '1'], value: { id: 'next', headers: [{ name: 'X-Custom', value: opaque }] } },
    { op: 'set', path: ['servers', '1'], value: { id: 'next', loginUsername: opaque } },
    { op: 'set', path: ['sharedToken'], value: opaque },
  ]) await assert.rejects(f.execute(id, 'mcp', 'saveConfiguration', { revision: 'r9', ops: [op] }), /凭据请通过 MCP 管理页面维护/)
  assert.equal((await f.status(id)).proposals.length, 0)
  assert.equal(f.calls.length, 0)
  assert.ok(!JSON.stringify(f.sessions.get(id).events).includes(opaque))
})

test('决策抽取预览使用当前真实请求模型和固定 Run，AI 不能自行把标签标为人员复核', async t => {
  const f = fixture(t)
  const runId = 'run-11111111-1111-4111-8111-111111111111'
  const id = (await f.rpc('session', { task: '抽取决策样本', context: { run_id: runId } })).value.session_id
  const route = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }
  f.sessions.get(id).session.append('request/header', { header: { config: { ...route, apiKey: 'fixture-private-model-key' } }, reason: 'initial' })
  await f.reload()
  const input = Object.freeze({ run_id: runId, path: 'evidence/U-BASIC-001/trace.jsonl', source_sha256: 'a'.repeat(64), samples: [], assistant_session_id: 'model-supplied-owner', assistant_model: { model: 'model-supplied-route' } })
  await f.execute(id, 'agents', 'datasets/preview', input)
  const call = f.calls.find(item => item.endpoint === 'agents/datasets/preview')
  assert.deepEqual(call.input.assistant_model, route)
  assert.equal(call.input.assistant_session_id, id)
  assert.equal(input.assistant_session_id, 'model-supplied-owner', '不得修改被冻结的模型工具入参')
  assert.ok(!JSON.stringify(call.input).includes('fixture-private-model-key'))
  assert.equal(f.tools.get('platform_agents').parameters.properties.action.enum.includes('datasets/update'), false)
  await assert.rejects(f.execute(id, 'agents', 'datasets/update', { label_status: 'reviewed' }), /未知的领域操作/)
  await f.rpc('context', { session_id: id, context: { run_id: 'run-22222222-2222-4222-8222-222222222222' } })
  await assert.rejects(f.execute(id, 'agents', 'datasets/preview', { ...input, run_id: 'run-22222222-2222-4222-8222-222222222222' }), /固定任务上下文/)
  assert.equal(f.calls.filter(item => item.endpoint === 'agents/datasets/preview').length, 1)
})

test('AI 决策样本预览经原生确认后仅携原 owner 保存一次，取消提案不写数据集', async t => {
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/datasets/preview' ? { ok: true, value: { preview_id: `preview-${input.assistant_session_id}`, count: 1, status: 'suggested', records: [{ _meta: { label_status: 'suggested' } }] } } : undefined)
  const runId = 'run-11111111-1111-4111-8111-111111111111'
  const id = (await f.rpc('session', { task: '抽取样本', context: { run_id: runId } })).value.session_id
  const operation = f.execute(id, 'agents', 'datasets/preview', { run_id: runId, samples: [] })
  const proposed = await f.proposal(id)
  assert.equal(proposed.action, 'datasets/apply')
  assert.equal(proposed.owner_session_id, id)
  assert.equal(proposed.input.assistant_session_id, id)
  assert.equal(proposed.preview.records[0]._meta.label_status, 'suggested')
  assert.equal(f.calls.filter(item => item.endpoint === 'agents/datasets/apply').length, 0)
  const other = (await f.rpc('session', {})).value.session_id
  assert.equal((await f.rpc('confirm', { session_id: other, proposal_id: proposed.id })).ok, false)
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  assert.equal((await operation).state, 'completed')
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  const saved = f.calls.filter(item => item.endpoint === 'agents/datasets/apply')
  assert.equal(saved.length, 1)
  assert.equal(saved[0].input.assistant_session_id, id)
  assert.equal(saved[0].input.preview_id, proposed.input.preview_id)
  const cancelId = (await f.rpc('session', { task: '抽取但取消', context: { run_id: runId } })).value.session_id
  const cancelled = f.execute(cancelId, 'agents', 'datasets/preview', { run_id: runId, samples: [] })
  const cancelProposal = await f.proposal(cancelId)
  await f.rpc('cancel', { session_id: cancelId })
  assert.equal((await cancelled).state, 'cancelled')
  await f.rpc('confirm', { session_id: cancelId, proposal_id: cancelProposal.id })
  assert.equal(f.calls.filter(item => item.endpoint === 'agents/datasets/apply').length, 1)
})


test('独立工作区固化助手身份、迁移旧 Session 归属且不改写原始事件', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant workspace '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-fixture', legacyRoots: ['/old-platform'] }))
  const f = fixture(t, undefined, root)
  f.addSession('legacy', '/old-platform')
  appendPluginRecord(f.sessions.get('legacy').session, 'plugin:harness-platform/assistant', { kind: 'task', task: '读取旧任务', context: { agent_id: 'business-agent' } })
  const before = [...f.sessions.get('legacy').events]
  assert.equal((await f.rpc('status', { session_id: 'legacy' })).ok, true)
  await f.reload()
  assert.equal((await f.rpc('status', { session_id: 'legacy' })).ok, true)
  assert.equal(f.sessions.get('legacy').session.header.cwd, '/old-platform')
  assert.deepEqual(f.sessions.get('legacy').events, before)
  const prompt = await f.assemble('legacy')
  assert.ok(prompt.includes('workspace-fixture') && prompt.includes(root))
  assert.ok(prompt.includes('business-agent') && prompt.includes('业务工作由数据工作区原则和技能指导'))
  const created = await f.rpc('session', { task: '读取业务数据', context: { agent_id: 'business-agent' } })
  assert.equal(f.sessions.get(created.value.session_id).input.cwd, root)
  f.addSession('other', '/old-platform/unrelated')
  assert.equal((await f.rpc('status', { session_id: 'other' })).ok, false)
  assert.equal(await f.assemble('other'), '')
})


test('已绑定的管理 Session 不随路径复用而跨工作区身份接受工具调用', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant bound workspace '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const descriptor = join(root, 'workspace.json')
  writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, id: 'workspace-first', legacyRoots: [] }))
  const f = fixture(t, undefined, root)
  const created = await f.rpc('session', { task: '读取任务' })
  const id = created.value.session_id
  assert.equal((await f.status(id)).workspace_id, 'workspace-first')
  writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, id: 'workspace-second', legacyRoots: [] }))
  assert.equal((await f.rpc('status', { session_id: id })).ok, false)
  assert.equal(await f.assemble(id), '')
  await assert.rejects(() => f.execute(id, 'agents', 'list'), /当前 Session 不是平台管理会话/)
  assert.equal(f.calls.length, 0)
})

test('普通派生、用例更新与业务样例创建可达，写操作仍须确认且只执行一次', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { context: { skill: 'agent-maintenance', workflow: 'research' } })).value.session_id
  for (const [domain, action, input] of [
    ['agents', 'create', { agent_id: 'basic', parent_experiment_id: 'EXP-basic-001', parent_ref: `git:${'a'.repeat(40)}`, research_question: '基本模拟数据摘要是否更清楚' }],
    ['agents', 'cases/update', { experiment_id: 'EXP-basic-001', case_id: 'U-BASIC-001', expected_sha256: 'a'.repeat(64), title: '基本输入', inputs: ['读取基本状态'], expected_behavior: '引用实际状态', fast: true }],
    ['mcp', 'seedThreatCompositions', { revision: 'fixture-revision', bindings: { socConnectionId: 'basic-soc', reportConnectionId: 'basic-report' } }],
  ]) {
    const operation = f.execute(id, domain, action, input)
    const proposed = await f.proposal(id)
    assert.equal(proposed.action, action)
    assert.equal(f.calls.filter(call => call.endpoint === `${domain}/${action}`).length, 0)
    await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
    assert.equal((await operation).state, 'completed')
    await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
    assert.equal(f.calls.filter(call => call.endpoint === `${domain}/${action}`).length, 1)
  }
  assert.equal((await f.execute(id, 'agents', 'assets/read-fixed', { agent_id: 'basic', experiment_id: 'EXP-basic-001', ref: `git:${'a'.repeat(40)}` })).state, 'completed')
  for (const action of ['compositionRun', 'compositionArtifact']) {
    const response = await f.execute(id, 'mcp', action, { run_id: 'basic-run', artifactId: 'summary' })
    assert.equal(response.state, 'completed')
  }
})

test('整理特性锁定任务版本，页面导航不改变预览目标', async t => {
  const f = fixture(t, endpoint => endpoint === 'agents/features/preview' ? { ok: true, value: { preview_id: 'features-fixed', experiment_id: 'EXP-basic-001', features: [], requires_confirmation: true } } : endpoint === 'agents/detail' ? { ok: true, value: { features: [] } } : undefined)
  const id = (await f.rpc('session', { task: '整理当前版本特性', context: { skill: 'agent-maintenance', workflow: 'features', agent_id: 'basic', experiment_id: 'EXP-basic-001' } })).value.session_id
  await f.rpc('context', { session_id: id, context: { experiment_id: 'EXP-basic-002' } })
  await assert.rejects(() => f.execute(id, 'agents', 'features/preview', { experiment_id: 'EXP-basic-002', features: [] }), /固定任务上下文/)
  assert.equal((await f.execute(id, 'agents', 'features/read-source', { experiment_id: 'EXP-basic-001', ref: 'evaluation/observations.md' })).state, 'completed')
  await f.execute(id, 'agents', 'features/read-source', {})
  assert.equal(f.calls.at(-1).input.experiment_id, 'EXP-basic-001', '缺省目标也绑定原任务，不能漂移到最新编号')
  await assert.rejects(() => f.execute(id, 'agents', 'edit/preview', { experiment_id: 'EXP-basic-001', edits: [] }), /仅允许读取业务来源/)
  await assert.rejects(() => f.execute(id, 'instances', 'list'), /仅允许读取业务来源/)
  const settled = await f.execute(id, 'agents', 'features/preview', { experiment_id: 'EXP-basic-001', features: [] })
  assert.deepEqual((await f.status(id)).proposals, [])
  assert.equal(f.calls.filter(call => call.endpoint === 'agents/features/apply').length, 1)
  assert.equal(settled.state, 'completed')
  assert.equal(settled.preview, undefined)
  assert.equal(settled.action, 'features/apply')
  assert.deepEqual(f.calls.find(call => call.endpoint === 'agents/detail').input, { agent_id: 'basic', experiment_id: 'EXP-basic-001' }, 'detail 必须使用固定 Agent 与版本，不随页面改变')
  assert.ok(settled.result.ok)
})

test('融合继续评测只使用实际目标source和确认Case，混淆字段与扩大范围重新确认', async t => {
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/fusion/status'
    ? { ok: true, value: { creation: { status: 'integrating', assistant_session_id: input.experiment_id === 'EXP-basic-002' ? 'session-1' : 'another-session', plan: { evaluation_case_ids: ['U-BASIC-001'] } } } }
    : undefined)
  const id = (await f.rpc('session', {})).value.session_id
  const allowed = await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-basic-002' })
  assert.equal(allowed.state, 'completed')
  assert.deepEqual(f.calls.find(call => call.endpoint === 'agents/eval/start').input.cases, ['U-BASIC-001'])
  for (const input of [
    { source: 'experiment:EXP-other-001', experiment_id: 'EXP-basic-002', cases: ['U-BASIC-001'] },
    { source: 'experiment:EXP-basic-002', cases: ['U-UNCONFIRMED-001'] },
  ]) {
    const operation = f.execute(id, 'agents', 'eval/start', input)
    const proposed = await f.proposal(id)
    assert.equal(proposed.action, 'eval/start')
    assert.equal(f.calls.filter(call => call.endpoint === 'agents/eval/start').length, 1)
    await f.rpc('cancel', { session_id: id })
    await operation
  }
})

test('普通资产写入与评测先使用真实preview失败时不生成确认或执行', async t => {
  const f = fixture(t, endpoint => ['agents/edit/preview', 'agents/eval/preview'].includes(endpoint) ? { ok: false, error: { code: 'conflict', message: '固定来源已变化', details: {} } } : undefined)
  const id = (await f.rpc('session', {})).value.session_id
  for (const [action, input] of [['edit/apply', { experiment_id: 'EXP-basic-001', edits: [] }], ['eval/start', { source: 'experiment:EXP-basic-001' }]]) {
    const response = await f.execute(id, 'agents', action, input)
    assert.equal(response.ok, false)
    assert.equal(f.calls.some(call => call.endpoint === `agents/${action}`), false)
  }
  assert.deepEqual((await f.status(id)).proposals, [])
})

test('算力变体先预览真实计划再确认创建，摘要和方案在等待期间固定', async t => {
  const digest = 'c'.repeat(64)
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/compute-variants/preview'
    ? { ok: true, value: { variant_name: input.variant_name, parent_experiment_id: input.parent_experiment_id, parent_ref: input.parent_ref, plan: { case_hashes: { 'U-BASIC-001': 'frozen-case' }, model_change: null }, model_configuration: 'inherited_from_fixed_parent', preview_sha256: digest } } : undefined)
  const id = (await f.rpc('session', { task: '策划并创建探索性算力变体', context: { skill: 'agent-maintenance', workflow: 'compute-variants', experiment_id: 'EXP-basic-001' } })).value.session_id
  const available = f.tools.get('platform_agents').parameters.properties.action.enum
  for (const action of ['context', 'preview', 'create', 'compare', 'rename']) assert.ok(available.includes(`compute-variants/${action}`))
  assert.equal(available.includes('compute-variants/confirm'), false)
  for (const action of ['context', 'compare']) assert.equal((await f.execute(id, 'agents', `compute-variants/${action}`, { experiment_id: 'EXP-basic-001' })).state, 'completed')
  const input = { variant_name: '基本状态轻量版', parent_experiment_id: 'EXP-basic-001', parent_ref: `git:${'a'.repeat(40)}`, strategy: '减少重复基本状态查询', case_ids: ['U-BASIC-001'], resource_metric: 'total_tokens', min_resource_reduction_pct: 10 }
  const operation = f.execute(id, 'agents', 'compute-variants/create', input)
  const proposed = await f.proposal(id)
  assert.equal(proposed.preview.value.parent_experiment_id, input.parent_experiment_id)
  assert.equal(proposed.preview.value.model_configuration, 'inherited_from_fixed_parent')
  assert.equal(proposed.preview.value.variant_name, '基本状态轻量版')
  assert.equal(proposed.input.expected_preview_sha256, digest)
  assert.equal(f.calls.filter(call => call.endpoint === 'agents/compute-variants/create').length, 0)
  input.case_ids.push('U-OTHER-001')
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  assert.equal((await operation).state, 'completed')
  const actual = f.calls.find(call => call.endpoint === 'agents/compute-variants/create').input
  assert.deepEqual(actual.case_ids, ['U-BASIC-001'])
  assert.equal(actual.expected_preview_sha256, digest)
  assert.equal(actual.human_confirmed, undefined)
  assert.equal(actual.variant_name, '基本状态轻量版')
  assert.equal(actual.strategy, '减少重复基本状态查询')
})

test('变体改名经普通写入提案确认后调用唯一名称接口，不自动修改计划或结论', async t => {
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/compute-variants/rename'
    ? { ok: true, value: { experiment_id: input.experiment_id, variant_name: input.variant_name, change_sha256: 'b'.repeat(64) } } : undefined)
  const id = (await f.rpc('session', { task: '将当前变体命名为资产告警轻量版', context: { skill: 'compute-variant-research', experiment_id: 'EXP-basic-002' } })).value.session_id
  const tool = f.tools.get('platform_agents')
  assert.equal(assistantActionContract('agents', 'compute-variants/rename').input_schema.properties.variant_name.type, 'string')
  assert.match(assistantActionContract('agents', 'compute-variants/create').instructions, /名称与策略分别提供/)
  const input = { experiment_id: 'EXP-basic-002', variant_name: '资产告警轻量版', expected_change_sha256: 'a'.repeat(64) }
  const operation = f.execute(id, 'agents', 'compute-variants/rename', input)
  const proposed = await f.proposal(id)
  assert.equal(proposed.action, 'compute-variants/rename')
  assert.equal(proposed.input.variant_name, '资产告警轻量版')
  assert.equal(f.calls.some(call => call.endpoint === 'agents/compute-variants/rename'), false)
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  const receipt = await operation
  assert.equal(receipt.state, 'completed')
  const writes = f.calls.filter(call => call.endpoint === 'agents/compute-variants/rename')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].input.variant_name, '资产告警轻量版')
  assert.equal(writes[0].input.expected_change_sha256, input.expected_change_sha256)
  assert.equal(writes[0].input.human_confirmed, undefined)
  assert.equal(f.calls.some(call => /compute-variants\/(create|confirm)$/.test(call.endpoint)), false)
  const meta = tool.output.presentationMeta({ action: 'compute-variants/rename', input }, receipt)
  assert.equal(meta.input.variant_name, '资产告警轻量版')
  for (const extra of [{ human_confirmed: true }, { decision: 'end' }, { variant_kind: 'end' }, { end_confirmed: true }, { outcome: 'adopt' }]) {
    await assert.rejects(() => f.execute(id, 'agents', 'compute-variants/rename', { ...input, ...extra }), /人员复核|不能更改研究结论/)
  }
})

test('算力变体预览失败或确认时配置已变，助手不宣称创建完成', async t => {
  let invalidPreview = true
  const f = fixture(t, endpoint => endpoint === 'agents/compute-variants/preview'
    ? invalidPreview ? { ok: false, error: { code: 'invalid_request', message: '父版无法恢复' } } : { ok: true, value: { preview_sha256: 'b'.repeat(64) } }
    : endpoint === 'agents/compute-variants/create' ? { ok: false, error: { code: 'conflict', message: '冻结Case已变化，请重新预览' } } : undefined)
  const id = (await f.rpc('session', { task: '创建变体' })).value.session_id
  const rejected = await f.execute(id, 'agents', 'compute-variants/create', { parent_experiment_id: 'EXP-basic-001' })
  assert.equal(rejected.ok, false)
  assert.equal((await f.status(id)).proposals.length, 0)
  assert.equal(f.calls.some(call => call.endpoint === 'agents/compute-variants/create'), false)
  invalidPreview = false
  const operation = f.execute(id, 'agents', 'compute-variants/create', { parent_experiment_id: 'EXP-basic-001' })
  const proposed = await f.proposal(id)
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  const receipt = await operation
  assert.equal(receipt.state, 'failed'); assert.equal(receipt.result.error.code, 'conflict')
})

test('助手不伪造变体人员复核，决策抽取会话也不能借新动作扩权', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '讨论变体' })).value.session_id
  await assert.rejects(() => f.execute(id, 'agents', 'compute-variants/confirm', { human_confirmed: true }), /未知的领域操作/)
  await assert.rejects(() => f.execute(id, 'agents', 'compute-variants/create', { human_confirmed: true }), /人员复核/)
  const extraction = (await f.rpc('session', { task: '抽取决策', context: { skill: 'decision-sample-extraction', run_id: 'run-fixed' } })).value.session_id
  for (const action of ['context', 'preview', 'compare', 'create', 'rename']) await assert.rejects(() => f.execute(extraction, 'agents', `compute-variants/${action}`, { run_id: 'run-fixed' }), /决策样本任务仅允许/)
  assert.equal(f.calls.length, 0)
})

test('代码变体连续任务固定两侧Case，实际构建后Git冻结仍单独确认，比较完成不标end', async t => {
  const parent = 'EXP-alpha-001', target = 'EXP-alpha-002', parentRef = 'git:' + 'a'.repeat(40), jobs = new Map()
  const freezeInput = { experiment_id: target, case_ids: ['U-ASSET-001'], evaluation_base_sha256: 'e'.repeat(64) }
  let loaded = false
  const f = fixture(t, (endpoint, input) => {
    if (endpoint === 'agents/detail') return { ok: true, value: { experiment: { id: input.experiment_id }, candidate_sha256: 'c'.repeat(64), evaluation: { sha256: 'fixed-cases', cases: [{ id: 'U-ASSET-001' }] }, derivation: { parent_ref: parentRef } } }
    if (endpoint === 'agents/compute-variants/context') return { ok: true, value: { agent_id: 'alpha', parent_experiment_id: parent, fixed_parent_ref: parentRef, plan: { case_hashes: { 'U-ASSET-001': 'fixed-case' }, generation: { mode: 'langgraph-aot' } }, workflow_status: { built: true, frozen: true, loaded } } }
    if (endpoint === 'agents/compute-variants/freeze-preview') return { ok: true, value: { preview_sha256: 'f'.repeat(64), freeze_input: freezeInput, diff: '+ 实际工作流源码' } }
    if (endpoint === 'agents/compute-variants/freeze') return { ok: true, value: { commit: 'b'.repeat(40) } }
    if (endpoint === 'agents/compute-variants/build-preview') return { ok: true, value: { candidate_sha256: 'c'.repeat(64), preview_sha256: 'b'.repeat(64) } }
    if (endpoint === 'agents/compute-variants/build') return { ok: true, value: { verified: true } }
    if (endpoint === 'agents/eval/start') { const id = 'job-' + jobs.size; jobs.set(id, { source: input.source, cases: input.cases, status: 'completed', run_id: input.source.endsWith(target) ? 'variant-run' : 'parent-run' }); return { ok: true, value: { job_id: id } } }
    if (endpoint === 'agents/eval/status') return { ok: true, value: jobs.get(input.job_id) }
    if (endpoint === 'agents/compute-variants/compare') return { ok: true, value: { comparability: { passed: true }, quality: { passed: false }, eligible_for_end: false } }
  })
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '生成资产告警代码变体', context: { skill: 'compute-variant-research', experiment_id: target, agent_id: 'alpha' } })).value.session_id
  for (const action of ['cases/update', 'cases/create-context', 'cases/from-run', 'cases/create-preview', 'cases/create']) {
    assert.equal((await f.execute(id, 'agents', 'describe', { action })).value.action, action, '策划阶段保留受控用例维护')
  }
  assert.equal((await f.execute(id, 'agents', 'cases/create-preview', { experiment_id: target })).state, 'completed')
  const plan = taskPlan({ goal: '生成资产告警代码变体', agent_id: 'alpha', source: `experiment:${target}`, kind: 'compute-variant', compute_variant: { parent_experiment_id: parent, parent_ref: parentRef }, evaluation_case_ids: ['U-ASSET-001'],
    allowed_actions: [{ domain: 'agents', action: 'edit/apply' }, { domain: 'agents', action: 'compute-variants/build' }, { domain: 'agents', action: 'eval/start' }] })
  const drift = await f.execute(id, 'task', 'preview', { plan: { ...plan, compute_variant: { parent_experiment_id: parent, parent_ref: 'git:' + 'b'.repeat(40) } } }).then(() => undefined, error => error)
  assert.match(drift.message, /实际冻结父版/)
  await beginTask(f, id, plan)
  for (const action of ['cases/update', 'cases/create']) {
    await assert.rejects(() => f.execute(id, 'agents', action, { experiment_id: target }), /评判口径已冻结/)
  }
  assert.equal(f.calls.some(call => ['agents/cases/update', 'agents/cases/create'].includes(call.endpoint)), false)
  await f.beforeModelCall(id)
  const beforeGuidance = (await f.status(id)).execution
  const fixedContext = (await f.status(id)).task_context
  assert.equal((await f.rpc('session', { session_id: id, task: '追加Guard验证事实，不改变已确认任务' })).ok, true)
  const afterGuidance = await f.status(id)
  assert.deepEqual(afterGuidance.task_context, fixedContext)
  assert.deepEqual(afterGuidance.execution, beforeGuidance, '追加指导不能重置任务身份、预算、截止时间或执行记录')
  assert.match(await f.assemble(id), /读取 compute-variant-research/)
  await assert.rejects(f.execute(id, 'agents', 'compute-variants/build', { experiment_id: parent }), /当前任务范围/)
  await assert.rejects(f.execute(id, 'agents', 'compute-variants/rename', { experiment_id: target, variant_name: '另一个名称', expected_change_sha256: 'a'.repeat(64) }), /当前任务范围/)
  await assert.rejects(f.execute(id, 'agents', 'eval/start', { source: `experiment:${target}`, cases: ['U-OTHER-001'] }), /当前任务范围/)
  assert.equal((await f.execute(id, 'agents', 'compute-variants/build', { experiment_id: target, expected_candidate_sha256: 'c'.repeat(64) })).state, 'completed')
  assert.equal(f.calls.find(call => call.endpoint === 'agents/compute-variants/build').input.expected_preview_sha256, 'b'.repeat(64))
  const freezing = f.execute(id, 'agents', 'compute-variants/freeze', { experiment_id: target })
  const proposed = await f.proposal(id)
  assert.equal(proposed.action, 'compute-variants/freeze'); assert.equal(proposed.preview.value.diff, '+ 实际工作流源码')
  assert.deepEqual(proposed.input.case_ids, ['U-ASSET-001']); assert.equal(proposed.input.evaluation_base_sha256, freezeInput.evaluation_base_sha256)
  assert.equal(f.calls.some(call => call.endpoint === 'agents/compute-variants/freeze'), false)
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id }); await freezing
  for (const source of [parent, target]) await f.execute(id, 'agents', 'eval/start', { source: `experiment:${source}`, cases: ['U-ASSET-001'] })
  const delivery = { parent_run_ids: ['parent-run'], variant_run_ids: ['variant-run'] }
  assert.equal((await f.execute(id, 'task', 'deliver', delivery)).state, 'verification_failed', '没有真实装载证据不能交付')
  loaded = true
  const result = await f.execute(id, 'task', 'deliver', delivery)
  assert.equal(result.state, 'completed'); assert.equal(result.delivery.end_confirmed, false)
  assert.equal(f.calls.some(call => call.endpoint === 'agents/compute-variants/confirm'), false)
  const completed = (await f.status(id)).execution
  const renaming = f.execute(id, 'agents', 'compute-variants/rename', { experiment_id: target, variant_name: '资产告警轻量版', expected_change_sha256: 'a'.repeat(64) })
  const renameProposal = await f.proposal(id)
  assert.equal(renameProposal.action, 'compute-variants/rename', '任务完成后同一管理会话可发起普通改名提案')
  assert.equal(f.calls.some(call => call.endpoint === 'agents/compute-variants/rename'), false, '完成任务不等于自动授权后续改名')
  await f.rpc('confirm', { session_id: id, proposal_id: renameProposal.id })
  assert.equal((await renaming).state, 'completed')
  assert.deepEqual((await f.status(id)).execution, completed, '后续普通写入不重启或改写已完成任务')
})


test('MCP 草稿复用真实结构校验，无效包装在提案前拒绝', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '新增只读组合', context: { skill: 'mcp-composition' } })).value.session_id
  const draft = { toolName: 'basic_read', title: '基础查询', description: '仅基础模拟数据', connectionId: 'mock-basic' }
  await assert.rejects(() => f.execute(id, 'mcp', 'saveCompositionDraft', { revision: 'before', draft: { config: draft, graph: {} } }), /工具名称/)
  assert.equal((await f.status(id)).proposals.length, 0)
  const operation = f.execute(id, 'mcp', 'saveCompositionDraft', { revision: 'before', draft })
  const proposed = await f.proposal(id)
  assert.deepEqual(proposed.input.draft, draft)
  assert.equal(f.calls.length, 0, '确认前不得保存')
  await f.rpc('confirm', { session_id: id, proposal_id: proposed.id })
  const result = await operation
  assert.equal(result.state, 'completed')
  assert.equal(result.preview, undefined)
  assert.equal(f.calls.filter(call => call.endpoint === 'mcp/saveCompositionDraft').length, 1)
})

test('真实Git回退覆盖本任务编辑与装配，恢复配置和模式、删除新文件，拒绝并行覆盖且不重置耗尽预算', async t => {
  const original = '# 已固定的设备巡检\n', edited = '# 本轮修改\n'
  const root = mkdtempSync(join(tmpdir(), 'harness-task-rollback-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const experiment = 'EXP-test-agent-001', donor = 'EXP-test-agent-002'
  const base = `evolution/experiments/${experiment}/candidate/`, donorBase = `evolution/experiments/${donor}/candidate/`
  const agentFile = 'dsh/workspace/AGENTS.md', preset = 'dsh/presets/test-agent/agent.cordis.yml', script = 'dsh/workspace/bin/check.txt'
  const added = ['dsh/managed/added.mjs', 'dsh/workspace/.agents/skills/inspection/SKILL.md']
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  write(base + agentFile, original); write(base + preset, '[]\n'); write(base + 'dsh/managed/test.patch.yml', '[]\n')
  write(base + script, 'original executable asset\n'); chmodSync(join(root, base, script), 0o755)
  write(`evolution/experiments/${experiment}/change.yaml`, `experiment_id: ${experiment}\nagent_id: test-agent\nbaseline_ref: none:first-experiment\n`)
  const sources = Object.fromEntries([experiment, donor].map(id => [id, { agent_id: 'test-agent', candidate_root: `evolution/experiments/${id}/candidate/dsh`, patch: 'test.patch.yml', preset: 'test-agent/agent.cordis.yml' }]))
  write('config/sources.json', JSON.stringify({ sources }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', '固定回退父版')
  const sourceRef = `git:${git('rev-parse', 'HEAD')}`
  const fixedReader = join(root, '.local/read-fixed.mjs')
  await build({ entryPoints: [new URL('../src/agents/asset-diff.ts', import.meta.url).pathname], outfile: fixedReader, bundle: true, platform: 'node', format: 'esm' })
  const { readFixedAsset } = await import(`file://${fixedReader}`)
  for (const path of [...added, script]) write(donorBase + path, path.endsWith('SKILL.md') ? '# 只读巡检\n' : 'assembled asset\n')
  const f = fixture(t, async (endpoint, input) => {
    if (endpoint === 'agents/detail') return { ok: true, value: { ...taskResponder(endpoint, input).value, derivation: { parent_ref: sourceRef } } }
    if (endpoint === 'agents/assets/read-fixed') return readFixedAsset(root, input)
    if (endpoint === 'agents/tasks/assembly-apply') return { ok: true, value: await applyTaskAssembly(root, input) }
    if (endpoint === 'agents/edit/apply') {
      const written = input.edits.map(edit => {
        const path = `evolution/experiments/${input.experiment_id}/${edit.path}`
        assert.equal(sha256(readFileSync(join(root, path))), edit.expected_sha256)
        write(path, edit.content)
        return { path: edit.path.slice('candidate/'.length), sha256: sha256(edit.content) }
      })
      return { ok: true, value: { written } }
    }
    return taskResponder(endpoint, input)
  }, root)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '改进巡检' })).value.session_id
  await beginTask(f, id, taskPlan({ budget: { max_model_calls: 3, timeout_minutes: 30, max_repair_rounds: 3 }, allowed_actions: [{ domain: 'agents', action: 'edit/apply' }, { domain: 'agents', action: 'tasks/assembly-apply' }] }))
  await f.execute(id, 'agents', 'edit/apply', { experiment_id: experiment, edits: [{ path: agentFile, content: edited, expected_sha256: sha256(original) }] })
  assert.equal((await f.status(id)).execution.operations[0].input.edits[0].path, 'candidate/dsh/workspace/AGENTS.md')
  assert.equal((await f.status(id)).execution.operations[0].receipt.value.written[0].path, agentFile, '回退同时支持Candidate内相对路径回执')
  const configured = '- name: cordis:include\n  config:\n    path: /opt/dsh-managed/added.mjs\n'
  await f.execute(id, 'agents', 'tasks/assembly-apply', { target_source: `experiment:${experiment}`, expected_candidate_sha256: candidateDigest(join(root, base)), files: [...added, script].map(path => ({ source: `experiment:${donor}`, path, expected_source_sha256: sha256(readFileSync(join(root, donorBase, path))), expected_target_sha256: existsSync(join(root, base, path)) ? sha256(readFileSync(join(root, base, path))) : null })), configuration_edits: [{ path: preset, content: configured, expected_target_sha256: sha256('[]\n') }] })
  await f.execute(id, 'agents', 'edit/apply', { experiment_id: experiment, edits: [{ path: `candidate/${preset}`, content: configured + '# 后续编辑\n', expected_sha256: sha256(configured) }] })
  assert.equal(statSync(join(root, base, script)).mode & 0o777, 0o644)
  write(base + 'notes/user.md', '并行新增但不属于本任务的文件\n')
  write(base + agentFile, '# 用户并行修改\n')
  const concurrentDigest = candidateDigest(join(root, base))
  await assert.rejects(() => f.execute(id, 'task', 'rollback'), /并行改动/)
  assert.equal(candidateDigest(join(root, base)), concurrentDigest, '预检发现一个冲突时整批文件都不能改写')
  write(base + agentFile, edited)
  write('.local/unrelated.txt', '不属于本任务的文件\n')
  symlinkSync(join(root, '.local/unrelated.txt'), join(root, base, 'notes/user-link'))
  for (let count = 0; count < 3; count++) await f.beforeModelCall(id)
  await assert.rejects(() => f.beforeModelCall(id), /额度已耗尽/)
  const before = (await f.status(id)).execution
  const restored = await f.execute(id, 'task', 'rollback')
  assert.equal(restored.state, 'rolled_back')
  assert.equal(readFileSync(join(root, base, agentFile), 'utf8'), original)
  assert.equal(readFileSync(join(root, base, preset), 'utf8'), '[]\n')
  assert.equal(readFileSync(join(root, base, script), 'utf8'), 'original executable asset\n')
  assert.equal(statSync(join(root, base, script)).mode & 0o777, 0o755)
  for (const path of added) assert.equal(existsSync(join(root, base, path)), false)
  assert.equal(existsSync(join(root, base, 'dsh/workspace/.agents')), false, '只清理由删除形成的空祖先目录')
  assert.match(readFileSync(join(root, base, 'notes/user.md'), 'utf8'), /不属于本任务/)
  assert.equal(lstatSync(join(root, base, 'notes/user-link')).isSymbolicLink(), true, '不扫描或改写无关用户文件，不能先写完再因全树摘要失败而抛错')
  assert.equal(readFileSync(join(root, '.local/unrelated.txt'), 'utf8'), '不属于本任务的文件\n')
  assert.equal((await f.status(id)).execution.state, 'budget_exhausted')
  assert.equal((await f.status(id)).execution.model_calls, before.model_calls)
  assert.equal((await f.status(id)).execution.deadline_at, before.deadline_at)
  assert.equal((await f.status(id)).execution.repair_rounds, before.repair_rounds)
  assert.equal((await f.status(id)).execution.operations.filter(operation => operation.state === 'rolled_back').length, 3)
  assert.equal((await f.status(id)).execution.operations[0].state, 'rolled_back')
})

test('装配与编辑共用修复轮次守卫，不能通过assembly跳过初测后的预留', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '装配巡检' })).value.session_id
  await beginTask(f, id, taskPlan({ allowed_actions: [{ domain: 'agents', action: 'tasks/assembly-apply' }, { domain: 'agents', action: 'eval/start' }] }))
  await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
  await assert.rejects(() => f.execute(id, 'agents', 'tasks/assembly-apply', { target_source: 'experiment:EXP-test-agent-001', files: [] }), /预留/)
  assert.equal(f.calls.filter(row => row.endpoint === 'agents/tasks/assembly-apply').length, 0)
})

test('首次新建无固定父版时拒绝回退，不把未验证资产覆盖成其他来源', async t => {
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/new' ? { ok: true, value: { source_id: 'experiment:EXP-test-agent-001' } } : taskResponder(endpoint, input))
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '新建只读巡检助手' })).value.session_id
  await beginTask(f, id, taskPlan({ source: undefined, new_agent: { name: '巡检助手', description: '只读设备数据', role: '核对实际台账', evaluation_cases: [{ id: 'U-BUSINESS-001', title: '设备完整', inputs: '检查三台设备', expected_behavior: '输出完整设备集合' }] }, allowed_actions: [{ domain: 'agents', action: 'new' }, { domain: 'agents', action: 'tasks/assembly-apply' }] }))
  await f.execute(id, 'agents', 'new', { agent_id: 'test-agent' })
  const before = (await f.status(id)).execution
  await assert.rejects(() => f.execute(id, 'task', 'rollback'), /首次创建.*固定可恢复父版/)
  assert.deepEqual((await f.status(id)).execution, before)
  assert.equal(f.calls.some(call => call.endpoint === 'agents/assets/read-fixed'), false)
})

test('确认前固定父版变化时拒绝开始，不能静默换成新HEAD', async t => {
  let parent = 'a'.repeat(40)
  const f = fixture(t, (endpoint, input) => {
    const value = taskResponder(endpoint, input)
    if (endpoint === 'agents/detail') value.value.derivation.parent_ref = `git:${parent}`
    return value
  })
  const goals = installTaskGoals(f)
  const id = (await f.rpc('session', { task: '从固定版本改进' })).value.session_id
  const waiting = f.execute(id, 'task', 'start', { plan: taskPlan() })
  const proposal = await f.proposal(id)
  parent = 'b'.repeat(40)
  const confirmed = await f.rpc('confirm', { session_id: id, proposal_id: proposal.id })
  assert.equal(confirmed.ok, false)
  assert.match(confirmed.error.message, /固定父版/)
  await waiting
  assert.equal((await f.status(id)).execution, undefined)
  assert.equal(goals.size, 0)
})

test('未知评测回执从预留operation_id读取真实Job后可显式恢复，不重复启动', async t => {
  let jobId
  const f = fixture(t, (endpoint, input) => {
    if (endpoint === 'agents/eval/start') { jobId = input.task_budget.operation_id; throw new Error('外部连接在Job启动后断开') }
    if (endpoint === 'agents/eval/status') return { ok: true, value: { job_id: jobId, source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'], status: 'completed', run_id: 'run-own' } }
    return taskResponder(endpoint, input)
  })
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '可恢复巡检' })).value.session_id
  await beginTask(f, id)
  await assert.rejects(() => f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] }), /断开/)
  assert.equal((await f.status(id)).execution.state, 'unknown')
  assert.equal((await f.rpc('task/resume', { session_id: id })).ok, false)
  assert.equal((await f.rpc('task/checkpoint', { session_id: id })).ok, true)
  assert.equal((await f.status(id)).execution.state, 'paused')
  assert.equal((await f.rpc('task/resume', { session_id: id })).ok, true)
  assert.equal(f.calls.filter(row => row.endpoint === 'agents/eval/start').length, 1)
})

test('长操作仍在等待时暂停立即取消其信号，晚到成功回执保持已暂停且不重发', async t => {
  let release, operationSignal
  const f = fixture(t, (endpoint, input, signal) => {
    if (endpoint === 'agents/tasks/assembly-apply') { operationSignal = signal; return new Promise(resolve => { release = resolve }) }
    return taskResponder(endpoint, input)
  })
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '装配后评测' })).value.session_id
  await beginTask(f, id, taskPlan({ allowed_actions: [{ domain: 'agents', action: 'tasks/assembly-apply' }] }))
  const operation = f.execute(id, 'agents', 'tasks/assembly-apply', { target_source: 'experiment:EXP-test-agent-001', files: [] })
  while (!release) await setImmediate()
  const paused = await Promise.race([f.rpc('task/pause', { session_id: id }), new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 150))])
  assert.equal(paused.ok, true)
  assert.equal(operationSignal.aborted, true)
  assert.equal((await f.status(id)).execution.state, 'paused')
  release({ ok: true, value: { source: 'experiment:EXP-test-agent-001' } })
  await operation
  assert.equal((await f.status(id)).execution.state, 'paused')
  assert.equal((await f.status(id)).execution.operations[0].state, 'completed')
  assert.equal(f.calls.filter(row => row.endpoint === 'agents/tasks/assembly-apply').length, 1)
})

test('业务与评审请求按job去重累计预算，同一status重复查询不重复计费', async t => {
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/eval/status' ? { ok: true, value: { status: 'completed', run_id: 'run-own', actual_model_calls: 7, observed_model_calls: 7, model_calls_complete: true } } : taskResponder(endpoint, input))
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '预算内巡检' })).value.session_id
  await f.beforeModelCall(id)
  await beginTask(f, id)
  const started = await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
  const job = started.result.value.job_id
  await f.execute(id, 'agents', 'eval/status', { job_id: job })
  await f.execute(id, 'agents', 'eval/status', { job_id: job })
  assert.equal((await f.status(id)).execution.model_calls, 8)
  assert.equal((await f.status(id)).execution.assistant_model_calls, 1)
  assert.equal((await f.status(id)).execution.evaluation_usage[job].complete, true)
})

test('任务详情缺省使用固定上下文，绑定目标后优先实际新版本，显式复用来源保持不变', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '改进所选版本', context: { skill: 'task-builder', agent_id: 'test-agent', experiment_id: 'EXP-test-agent-000' } })).value.session_id
  await f.execute(id, 'agents', 'detail', { agent_id: 'test-agent' })
  assert.equal(f.calls.at(-1).input.experiment_id, 'EXP-test-agent-000')
  await f.execute(id, 'agents', 'detail', { agent_id: 'test-agent', experiment_id: 'EXP-test-agent-002' })
  assert.equal(f.calls.at(-1).input.experiment_id, 'EXP-test-agent-002')
  await beginTask(f, id)
  await f.execute(id, 'agents', 'detail', { agent_id: 'test-agent' })
  assert.equal(f.calls.at(-1).input.experiment_id, 'EXP-test-agent-001')
  const other = (await f.rpc('session', { task: '查看智能体' })).value.session_id
  await f.execute(other, 'agents', 'detail', { agent_id: 'test-agent' })
  assert.equal(f.calls.at(-1).input.experiment_id, undefined)
})

test('助手查询本任务评测在工具内等待实际终态，暂停可中断等待且不重复启动', async t => {
  let polls = 0
  const f = fixture(t, (endpoint, input) => endpoint === 'agents/eval/status'
    ? { ok: true, value: { job_id: input.job_id, status: ++polls === 1 ? 'running' : 'completed', observed_model_calls: 2, model_calls_complete: true } }
    : taskResponder(endpoint, input))
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '等待真实评测' })).value.session_id
  await beginTask(f, id)
  const started = await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
  const input = { job_id: started.result.value.job_id }
  assert.equal((await f.execute(id, 'agents', 'eval/status', input)).result.value.status, 'completed')
  assert.equal(polls, 2)
  assert.equal((await f.status(id)).execution.model_calls, 2)
  polls = 0
  const pending = f.execute(id, 'agents', 'eval/status', input)
  while (polls === 0) await setImmediate()
  await f.rpc('task/pause', { session_id: id })
  await pending
  assert.equal(polls, 1, '暂停后不得继续查询或重发评测')
  assert.equal(f.calls.filter(item => item.endpoint === 'agents/eval/start').length, 1)
  assert.equal(f.calls.some(item => item.endpoint === 'agents/eval/cancel'), true)
})

test('任务不能通过领域delivery入口绕过预算或替换已确认业务判据', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '交付巡检' })).value.session_id
  await beginTask(f, id)
  await assert.rejects(() => f.execute(id, 'agents', 'tasks/delivery', { required_tool_names: [], expected_device_ids: [] }), /platform_task deliver/)
  assert.equal(f.calls.filter(row => row.endpoint === 'agents/tasks/delivery').length, 0)
})

test('所有平台工具回执元信息保留真实动作与定位字段，不重复附带文件正文', t => {
  const f = fixture(t)
  const value = f.tools.get('platform_agents').output.presentationMeta({ action: 'edit/apply', input: { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/dsh/workspace/AGENTS.md', content: '无需重复传入的正文' }] } }, { kind: 'platform-operation', domain: 'agents', action: 'edit/apply', state: 'completed', result: { ok: true, value: { updated: 1 } } })
  assert.equal(value.action, 'edit/apply')
  assert.equal(value.input.experiment_id, 'EXP-test-agent-001')
  assert.equal(value.input.edits[0].path, 'candidate/dsh/workspace/AGENTS.md')
  assert.equal(value.input.edits[0].content, undefined)
  const preview = f.tools.get('platform_task').output.presentationMeta({ action: 'preview', input: {} }, { plan: { goal: '基本任务' } })
  assert.equal(preview.domain, 'task'); assert.equal(preview.action, 'preview')
  assert.match(assistantActionContract('agents', 'edit/apply').input_schema.properties.edits.items.properties.content.description, /修改后完整文件正文/)
})

test('冻结模型回执省略完整编译diff并保留真实摘要，持久提案和确认RPC保持全文', async t => {
  const diff = '完整差异开始\n' + '+ compiled-esm-boundary '.repeat(120000) + '\n完整差异结束'
  assert.ok(Buffer.byteLength(diff) > 2400000)
  const files = [{ path: 'evolution/experiments/EXP-alpha-002/candidate/dsh/managed/compute-workflow/index.mjs', operation: 'create', sha256: sha256('compiled-esm') }]
  const preview = { experiment_id: 'EXP-alpha-002', preview_sha256: 'a'.repeat(64), branch: 'refs/heads/test', head: 'b'.repeat(40), tree: 'c'.repeat(40), files, diff,
    freeze_input: { experiment_id: 'EXP-alpha-002', case_ids: ['U-ASSET-001'], evaluation_base_sha256: 'e'.repeat(64), expected_preview_sha256: 'a'.repeat(64) } }
  const f = fixture(t, endpoint => endpoint === 'agents/compute-variants/freeze-preview' ? { ok: true, value: preview }
    : endpoint === 'agents/compute-variants/freeze' ? { ok: true, value: { experiment_id: preview.experiment_id, commit: 'd'.repeat(40), files } } : undefined)
  const id = (await f.rpc('session', { task: '核对代码变体冻结' })).value.session_id
  const output = f.tools.get('platform_agents').output, args = { action: 'compute-variants/freeze-preview', input: { experiment_id: preview.experiment_id } }
  const raw = await f.execute(id, 'agents', args.action, args.input)
  const rendered = JSON.parse(output.render(args, raw)[0].text), meta = output.presentationMeta(args, raw)
  for (const projected of [rendered, meta]) {
    assert.doesNotMatch(JSON.stringify(projected), /compiled-esm-boundary|完整差异开始|完整差异结束/)
    assert.ok(JSON.stringify(projected).length < 5000, '模型输出应只包含清单与摘要，不截断保留编译正文')
    assert.match(JSON.stringify(projected), /原生确认卡.*完整实际差异/)
  }
  assert.equal(rendered.result.value.diff, undefined)
  assert.equal(rendered.result.value.diff_sha256, sha256(diff))
  assert.equal(rendered.result.value.diff_bytes, Buffer.byteLength(diff))
  assert.deepEqual(rendered.result.value.files, files)
  assert.equal(raw.result.value.diff, diff, '模型投影不得修改原始RPC值')
  const pending = f.execute(id, 'agents', 'compute-variants/freeze', args.input)
  const proposal = await f.proposal(id)
  assert.equal(proposal.preview.value.diff, diff, '原生确认卡读取的持久预览必须完整')
  assert.equal(f.calls.some(row => row.endpoint === 'agents/compute-variants/freeze'), false)
  const confirmation = await f.rpc('confirm', { session_id: id, proposal_id: proposal.id })
  assert.equal(confirmation.value.preview.value.diff, diff, '确认RPC及历史原始回执保留完整预览')
  const settled = await pending, settledArgs = { ...args, action: 'compute-variants/freeze' }
  assert.equal(settled.preview_sha256, preview.preview_sha256)
  assert.equal(settled.result.value.commit, 'd'.repeat(40))
  for (const projected of [output.render(settledArgs, settled), output.presentationMeta(settledArgs, settled), output.render(settledArgs, confirmation.value), output.presentationMeta(settledArgs, confirmation.value)]) {
    assert.doesNotMatch(JSON.stringify(projected), /compiled-esm-boundary/)
    assert.ok(JSON.stringify(projected).length < 5000)
  }
  assert.equal((await f.status(id)).proposals[0].preview.value.diff, diff)
})

test('用户可仅拒绝当前未执行提案，结算原工具但不取消其他提案或执行写入', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '核对两项实例操作' })).value.session_id
  const first = f.execute(id, 'instances', 'run', { name: 'first', operation: 'stop' })
  const proposal = await f.proposal(id)
  const second = f.execute(id, 'instances', 'run', { name: 'second', operation: 'stop' })
  while ((await f.status(id)).proposals.length < 2) await setImmediate()
  assert.equal((await f.rpc('reject', { session_id: id, proposal_id: proposal.id })).ok, true)
  assert.equal((await first).state, 'cancelled')
  assert.equal(f.calls.some(call => call.endpoint === 'instances/run'), false)
  const remaining = (await f.status(id)).proposals.find(item => item.id !== proposal.id)
  assert.equal(remaining.state, 'awaiting_confirmation')
  await f.rpc('confirm', { session_id: id, proposal_id: remaining.id })
  await second
  assert.equal(f.calls.filter(call => call.endpoint === 'instances/run').length, 1)
  assert.equal((await f.rpc('reject', { session_id: id, proposal_id: remaining.id })).ok, false)
})

test('暂停跨过截止后恢复持久记录预算耗尽，不更换原任务、额度、截止或操作', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '有总时限的交付任务' })).value.session_id
  await f.beforeModelCall(id)
  await beginTask(f, id)
  await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
  await f.rpc('task/pause', { session_id: id })
  const before = (await f.status(id)).execution
  t.mock.method(Date, 'now', () => Date.parse(before.deadline_at) + 1)
  const response = await f.rpc('task/resume', { session_id: id })
  assert.equal(response.ok, false); assert.match(response.error.message, /总时限已耗尽/)
  const after = (await f.status(id)).execution
  assert.equal(after.state, 'budget_exhausted'); assert.match(after.reason, /总时限已耗尽/)
  for (const key of ['id', 'started_at', 'deadline_at', 'model_calls', 'assistant_model_calls', 'repair_rounds']) assert.equal(after[key], before[key])
  assert.deepEqual(after.operations, before.operations)
  assert.equal((await f.rpc('task/resume', { session_id: id })).ok, false)
  assert.equal(f.calls.filter(item => item.endpoint === 'agents/eval/start').length, 1)
})


test('专项研究文档按任务主题放行，拒绝借资料读取扩展动作范围', async t => {
  const f = fixture(t)
  const extraction = (await f.rpc('session', { task: '抽取', context: { skill: 'decision-sample-extraction', run_id: 'run-fixed' } })).value.session_id
  assert.equal((await f.execute(extraction, 'agents', 'research/read-reference', { topic: 'decision-samples' })).state, 'completed')
  await assert.rejects(() => f.execute(extraction, 'agents', 'research/read-reference', { topic: 'compute-variants' }), /主题不属于/)
  await assert.rejects(() => f.execute(extraction, 'agents', 'research/validate', { experiment_id: 'EXP-other-001' }), /仅允许/)
  const compute = (await f.rpc('session', { task: '算力', context: { skill: 'compute-variant-research' } })).value.session_id
  assert.equal((await f.execute(compute, 'agents', 'research/read-reference', { topic: 'evaluation-and-evidence' })).state, 'completed')
  await assert.rejects(() => f.execute(compute, 'agents', 'research/read-reference', { topic: 'decision-samples' }), /主题不属于/)
  const general = (await f.rpc('session', { task: '检查' })).value.session_id
  assert.equal((await f.execute(general, 'agents', 'research/validate', { experiment_id: 'EXP-selected-001' })).state, 'completed')
  assert.equal((await f.status(general)).proposals.length, 0)
})

test('研究结论确认展示结构化变更，并保留双摘要直到实际保存', async t => {
  const input = { experiment_id: 'EXP-test-agent-001', content: '验证完成后采纳', expected_sha256: 'a'.repeat(64), status: 'completed', outcome: 'adopt', expected_change_sha256: 'b'.repeat(64) }
  const change = { before: { status: 'active', outcome: 'continue' }, after: { status: 'completed', outcome: 'adopt' } }
  const f = fixture(t, endpoint => endpoint === 'agents/decision/preview' ? { ok: true, value: { edits: [], change } } : undefined)
  const id = (await f.rpc('session', { task: '保存结论' })).value.session_id
  const operation = f.execute(id, 'agents', 'decision/update', input)
  const proposal = await f.proposal(id)
  assert.deepEqual(proposal.preview.value.change, change)
  assert.deepEqual(f.calls[0], { endpoint: 'agents/decision/preview', input })
  await f.rpc('confirm', { session_id: id, proposal_id: proposal.id })
  await operation
  assert.deepEqual(f.calls.at(-1).input, { ...input, confirmed: true })
})

test('真实原生 assemble 先运行同步 section 再进入异步 waterfall，首次管理请求仍得到完整业务正文', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '第一次管理任务' })).value.session_id
  const order = []
  const unregister = f.services.systemPrompt.section({
    name: 'test/native-synchronous-provider', order: 640,
    text: () => { order.push('section'); return '原生同步内容' },
  })
  t.after(unregister)
  const get = f.services.skills.get
  f.services.skills.get = async (...args) => { order.push('skill'); await setImmediate(); return get(...args) }
  const assembled = await f.assembly(id)
  assert.equal(order[0], 'section', '测试必须走原生真实装配顺序，不提前调用业务加载函数')
  assert.ok(order.includes('skill'))
  assert.match(assembled.sections.find(item => item.name === 'harness-platform/assistant').text,
    /业务工作由数据工作区原则和技能指导/)
  assert.equal(assembled.sections.find(item => item.name === 'harness-platform/assistant-output').text, expressionFixture)
  assert.equal(assembled.sections.find(item => item.name === 'test/native-synchronous-provider').text, '原生同步内容')
  rmSync(join(f.root, '.agents/skills/user-facing-output/SKILL.md'))
  await assert.rejects(() => f.assembly(id), /未配置平台管理助手/)
})

test('所有管理业务可以逐动作发现参数；原生下一轮装配使用所选合同且可切换和恢复', async t => {
  const f = fixture(t)
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const require = createRequire(import.meta.url)
  const sdk = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
  const { ToolRuntime, assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(sdk.resolve('@deepseek-ai/dsh-tools')).href)
  new ToolRuntime(f.ctx, { mode: 'native' })
  for (const tool of f.tools.values()) f.ctx.tools.register(tool)
  const id = (await f.rpc('session', { task: '构建、评测和交付智能体' })).value.session_id
  const initial = (await f.assembly(id)).tools.filter(tool => tool.name.startsWith('platform_'))
  for (const tool of initial) {
    assert.deepEqual(tool.parameters.properties.action.enum, ['context', 'describe'], '未读取操作合同前不让模型盲猜参数')
    assert.equal(validateJsonSchemaValue(tool.parameters, { action: 'describe', input: { action: assistantActions[tool.name.slice(9)][0] } }).length, 0)
  }
  for (const [domain, names] of Object.entries(assistantActions)) {
    for (const action of names) {
      assert.equal(assistantActionContract(domain, action).action, action)
      assert.doesNotThrow(() => assertSupportedJsonSchema(projectAssistantTools([{ name: `platform_${domain}` }], { tool_contracts: { [domain]: action } })[0].parameters))
    }
  }
  const described = await f.execute(id, 'task', 'describe', { action: 'preview' })
  assert.equal(described.value.input_schema.properties.plan.properties.budget.properties.max_repair_rounds.maximum, 3)
  const task = (await f.assembly(id)).tools.find(tool => tool.name === 'platform_task')
  assert.deepEqual(task.parameters.properties.action.enum, ['context', 'describe', 'preview'])
  assert.equal(task.parameters.properties.input.properties.plan.additionalProperties, false)
  assert.equal(validateJsonSchemaValue(task.parameters, { action: 'preview', input: { plan: { ...taskPlan(), budget: { max_repair_rounds: '3' } } } }).length > 0, true)
  assert.equal(f.calls.length, 0, 'describe 不伪装公共业务 RPC，也不执行业务')
  await f.execute(id, 'agents', 'describe', { action: 'edit/apply' })
  await f.reload()
  assert.deepEqual((await f.assembly(id)).tools.find(tool => tool.name === 'platform_agents').parameters.properties.action.enum, ['context', 'describe', 'edit/apply'])
  await f.execute(id, 'agents', 'describe', { action: 'eval/status' })
  assert.deepEqual((await f.assembly(id)).tools.find(tool => tool.name === 'platform_agents').parameters.properties.action.enum, ['context', 'describe', 'eval/status'])
  const scoped = (await f.rpc('session', { task: '整理特性', context: { skill: 'agent-maintenance', workflow: 'features', agent_id: 'basic', experiment_id: 'EXP-basic-001' } })).value.session_id
  await assert.rejects(() => f.execute(scoped, 'agents', 'describe', { action: 'edit/apply' }), /不允许/)
  const feature = (await f.assembly(scoped)).tools.find(tool => tool.name === 'platform_agents')
  assert.equal(feature.parameters.properties.action.enum.includes('edit/apply'), false)
})

test('固定 Run 抽样自动保存并回读，省略 Run 由服务器绑定且不会生成确认提案', async t => {
  const run_id = 'run-11111111-1111-4111-8111-111111111111'
  const dataset_id = 'decision-dataset-11111111-1111-4111-8111-111111111111'
  const records = [{ workflow: '材料核对', targets: { sufficient: { label: false, status: 'suggested', decision_time_reviewed: false } }, _meta: { id: 'sample-fixed' } }]
  let stored = false
  const f = fixture(t, endpoint => {
    if (endpoint === 'agents/datasets/preview') return { ok: true, value: stored ? { count: 0, skipped: ['相同题目已存在'] } : { preview_id: 'fixed', run_id, records, count: 1, file: `evolution/datasets/${dataset_id}.json` } }
    if (endpoint === 'agents/datasets/apply') { stored = true; return { ok: true, value: { dataset: { id: dataset_id, records } } } }
    if (endpoint === 'agents/datasets/read') return { ok: true, value: { dataset: { id: dataset_id, records } } }
  })
  const id = (await f.rpc('session', { task: '抽取样本', context: { skill: 'decision-sample-extraction', run_id } })).value.session_id
  assert.match((await f.execute(id, 'agents', 'context')).value.next, /datasets\/source/)
  const saved = await f.execute(id, 'agents', 'datasets/preview', { samples: [] })
  assert.equal(saved.state, 'completed')
  assert.equal(saved.action, 'datasets/apply')
  assert.equal(saved.result.value.dataset.records[0].targets.sufficient.status, 'suggested')
  assert.equal(f.calls[0].input.run_id, run_id)
  assert.equal(f.calls.find(call => call.endpoint === 'agents/datasets/apply').input.assistant_session_id, id)
  assert.deepEqual((await f.status(id)).proposals, [])
  assert.equal((await f.status(id)).automatic_save.expected, undefined, '恢复检查仅保存目标和摘要，不复制另一份样本正文')
  await f.execute(id, 'agents', 'datasets/preview', { samples: [] })
  assert.equal(f.calls.filter(call => call.endpoint === 'agents/datasets/apply').length, 1)
  await assert.rejects(() => f.execute(id, 'agents', 'datasets/source', { run_id: 'run-other' }), /固定任务上下文/)
})

test('自动保存遇到未知回执只核查原目标，冷恢复不重放写入', async t => {
  const run_id = 'run-11111111-1111-4111-8111-111111111111', dataset_id = 'decision-dataset-22222222-2222-4222-8222-222222222222'
  const records = [{ _meta: { id: 'sample' }, workflow: '记录整理' }]
  let readable = false
  const f = fixture(t, endpoint => {
    if (endpoint === 'agents/datasets/preview') return { ok: true, value: { preview_id: 'fixed', run_id, records, count: 1, file: `evolution/datasets/${dataset_id}.json` } }
    if (endpoint === 'agents/datasets/apply') throw Object.assign(new Error('保存响应中断 Bearer confidential-value'), { code: 'ECONNRESET' })
    if (endpoint === 'agents/datasets/read') return readable ? { ok: true, value: { dataset: { id: dataset_id, run_id, records } } } : { ok: false, error: { message: '暂不能读取' } }
  })
  const id = (await f.rpc('session', { task: '抽取样本', context: { skill: 'decision-sample-extraction', run_id } })).value.session_id
  assert.equal((await f.execute(id, 'agents', 'datasets/preview', { samples: [] })).state, 'unknown')
  const failure = (await f.status(id)).automatic_save.failure
  assert.deepEqual(failure, { phase: 'apply', message: '保存响应中断 Bearer [已隐藏]' })
  await f.reload()
  assert.equal((await f.execute(id, 'agents', 'datasets/preview', { samples: [] })).state, 'unknown')
  assert.deepEqual((await f.status(id)).automatic_save.failure, failure, '回读失败不覆盖最初保存失败的证据')
  readable = true
  assert.equal((await f.execute(id, 'agents', 'datasets/preview', { samples: [] })).state, 'completed')
  assert.equal(f.calls.filter(call => call.endpoint === 'agents/datasets/apply').length, 1)
  assert.equal(f.calls.filter(call => call.endpoint === 'agents/datasets/preview').length, 1)
  assert.deepEqual((await f.status(id)).proposals, [])
})

test('自动保存的来源冲突原样返回失败，不宣称已保存或降低校验', async t => {
  const f = fixture(t, endpoint => {
    if (endpoint === 'agents/features/preview') return { ok: true, value: { preview_id: 'fixed', experiment_id: 'EXP-basic-001', features: [{ id: 'a', title: '清单', description: '整理台账', source_refs: [], evidence_refs: [] }] } }
    if (endpoint === 'agents/features/apply') return { ok: false, error: { code: 'conflict', message: '资产或特性已变化' } }
    if (endpoint === 'agents/detail') return { ok: true, value: { features: [{ id: 'a', title: '清单', description: '整理台账', source_refs: [], evidence_refs: [] }] } }
  })
  const id = (await f.rpc('session', { task: '整理特性', context: { skill: 'agent-maintenance', workflow: 'features', agent_id: 'basic', experiment_id: 'EXP-basic-001' } })).value.session_id
  const value = await f.execute(id, 'agents', 'features/preview', { features: [] })
  assert.equal(value.state, 'failed')
  assert.equal(value.result.error.code, 'conflict')
  assert.equal(f.calls.some(call => call.endpoint === 'agents/detail'), false, '明确冲突不能用内容相同的回读掩盖')
  assert.deepEqual((await f.status(id)).proposals, [])
})

test('旧特性unknown回执从原任务补齐Agent身份，只回读不重写且保留失败', async t => {
  const f = fixture(t, (endpoint, input) => {
    assert.equal(endpoint, 'agents/detail', '恢复不能重新预览或保存特性')
    assert.deepEqual(input, { agent_id: 'basic', experiment_id: 'EXP-basic-001' })
    return { ok: true, value: { features: [] } }
  })
  const id = (await f.rpc('session', { task: '整理特性', context: { skill: 'agent-maintenance', workflow: 'features', agent_id: 'basic', experiment_id: 'EXP-basic-001' } })).value.session_id
  const previous = { kind: 'automatic-save', owner_session_id: id, action: 'features/apply', target: { experiment_id: 'EXP-basic-001' }, expected_sha256: sha256('[]'), state: 'unknown', failure: { phase: 'readback', code: 'invalid_request', message: '缺少 agent_id' } }
  appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', previous)
  await f.rpc('context', { session_id: id, context: { agent_id: 'other', experiment_id: 'EXP-other-002' } })
  await f.reload()
  assert.equal((await f.execute(id, 'agents', 'features/preview', { features: [] })).state, 'completed')
  assert.deepEqual((await f.status(id)).automatic_save.failure, previous.failure)
  assert.equal(f.calls.length, 1)
  assert.equal(f.sessions.get(id).events.some(event => event.data?.kind === 'automatic-save' && event.data.state === 'unknown'), true)
})

test('特性自动保存缺少固定Agent身份时在写入前停止', async t => {
  const f = fixture(t, endpoint => {
    assert.equal(endpoint, 'agents/features/preview')
    return { ok: true, value: { preview_id: 'fixed', experiment_id: 'EXP-basic-001', features: [] } }
  })
  const id = (await f.rpc('session', { task: '整理特性', context: { skill: 'agent-maintenance', workflow: 'features', experiment_id: 'EXP-basic-001' } })).value.session_id
  await assert.rejects(() => f.execute(id, 'agents', 'features/preview', { features: [] }), /缺少固定目标/)
  assert.equal(f.calls.length, 1)
  assert.equal((await f.status(id)).automatic_save, undefined)
})

test('旧特性未知保存冷恢复后自然读取详情可核实，同目标新内容不能结算旧写入', async t => {
  for (const matches of [true, false]) await t.test(matches ? '原内容一致' : '内容已由后续任务改变', async t => {
    const original = [{ id: 'basic', title: '基础清单', description: '整理模拟台账', source_refs: [], evidence_refs: [] }]
    const current = matches ? original : [{ ...original[0], description: '后续任务的新说明' }]
    const f = fixture(t, (endpoint, input) => {
      assert.equal(endpoint, 'agents/detail', '自然恢复只使用已请求的详情，不重复预览、保存或取数')
      assert.deepEqual(input, { agent_id: 'basic', experiment_id: 'EXP-basic-001' })
      return { ok: true, value: { features: current } }
    })
    const id = (await f.rpc('session', { task: '续办特性核对', context: { skill: 'agent-maintenance', workflow: 'features', agent_id: 'basic', experiment_id: 'EXP-basic-001' } })).value.session_id
    const failure = { phase: 'readback', code: 'invalid_request', message: '缺少 agent_id' }
    const saved = { kind: 'automatic-save', owner_session_id: id, action: 'features/apply', target: { experiment_id: 'EXP-basic-001' }, expected_sha256: sha256(JSON.stringify(original)), state: 'unknown', failure }
    appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', saved)
    await f.reload()
    assert.equal((await f.status(id)).automatic_save.state, 'unknown')
    assert.equal(f.calls.length, 0, 'status 轮询不额外读取业务数据')
    const result = await f.execute(id, 'agents', 'detail')
    assert.deepEqual(result.result.value.features, current)
    assert.equal(result.result.value.automatic_save.state, matches ? 'completed' : 'unknown')
    assert.equal((await f.status(id)).automatic_save.state, matches ? 'completed' : 'unknown')
    assert.deepEqual((await f.status(id)).automatic_save.failure, failure)
    const records = f.sessions.get(id).events.filter(event => event.data?.kind === 'automatic-save')
    assert.equal(records.length, matches ? 2 : 1, '保留原失败；状态未变不追加重复记录')
    assert.equal(records[0].data.state, 'unknown')
    assert.equal(f.calls.length, 1)
    assert.equal((await f.status(id)).model_calls_observed, 0, '只读核实不产生模型调用或修改预算')
  })
})

test('抽样自然读取固定Run目录后只核实原批次，取消时不结算也不重写', async t => {
  for (const cancelled of [false, true]) await t.test(cancelled ? '回读时取消' : '同批次内容一致', async t => {
    const run_id = 'run-11111111-1111-4111-8111-111111111111', dataset_id = 'decision-dataset-33333333-3333-4333-8333-333333333333'
    const records = [{ workflow: '台账核对', _meta: { id: 'basic' } }]
    const controller = new AbortController()
    const f = fixture(t, (endpoint, input) => {
      if (endpoint === 'agents/datasets/list') {
        assert.equal(input.run_id, run_id)
        return { ok: true, value: { datasets: [{ id: dataset_id, run_id, count: 1 }] } }
      }
      assert.equal(endpoint, 'agents/datasets/read')
      assert.deepEqual(input, { dataset_id })
      if (cancelled) controller.abort(new Error('用户取消'))
      return { ok: true, value: { dataset: { id: dataset_id, records } } }
    })
    const id = (await f.rpc('session', { task: '核实已保存样本', context: { skill: 'decision-sample-extraction', run_id } })).value.session_id
    const saved = { kind: 'automatic-save', owner_session_id: id, action: 'datasets/apply', target: { dataset_id }, expected_sha256: sha256(JSON.stringify(records)), state: 'unknown', failure: { phase: 'apply', message: '响应中断' } }
    appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', saved)
    await f.reload()
    const operation = f.execute(id, 'agents', 'datasets/list', {}, controller.signal)
    if (cancelled) await assert.rejects(operation, /用户取消/)
    else assert.equal((await operation).result.value.automatic_save.state, 'completed')
    assert.equal((await f.status(id)).automatic_save.state, cancelled ? 'unknown' : 'completed')
    assert.deepEqual((await f.status(id)).automatic_save.failure, saved.failure)
    assert.deepEqual(f.calls.map(call => call.endpoint), ['agents/datasets/list', 'agents/datasets/read'])
  })
})

test('普通管理读取其他版本不会结算原未知保存，并发同目标回读只追加一次核实', async t => {
  const f = fixture(t, endpoint => {
    assert.equal(endpoint, 'agents/detail')
    return { ok: true, value: { features: [] } }
  })
  const id = (await f.rpc('session', { task: '核对版本' })).value.session_id
  const saved = { kind: 'automatic-save', owner_session_id: id, action: 'features/apply', target: { agent_id: 'basic', experiment_id: 'EXP-basic-001' }, expected_sha256: sha256('[]'), state: 'unknown' }
  appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', saved)
  await f.execute(id, 'agents', 'detail', { agent_id: 'other', experiment_id: 'EXP-other-001' })
  assert.equal((await f.status(id)).automatic_save.state, 'unknown')
  await Promise.all([1, 2].map(() => f.execute(id, 'agents', 'detail', { agent_id: 'basic', experiment_id: 'EXP-basic-001' })))
  assert.equal((await f.status(id)).automatic_save.state, 'completed')
  assert.equal(f.sessions.get(id).events.filter(event => event.data?.kind === 'automatic-save' && event.data.state === 'completed').length, 1)
  assert.equal(f.calls.length, 3)
})

test('模型预算耗尽后暂停和取消保持原终态及证据，冷恢复不重新开放额度', async t => {
  const f = fixture(t, taskResponder)
  installTaskGoals(f)
  const id = (await f.rpc('session', { task: '保留耗尽原因的交付任务' })).value.session_id
  await beginTask(f, id, taskPlan({ budget: { max_model_calls: 3, max_repair_rounds: 3, timeout_minutes: 30 } }))
  await f.execute(id, 'agents', 'eval/start', { source: 'experiment:EXP-test-agent-001', cases: ['U-BUSINESS-001'] })
  for (let count = 0; count < 3; count++) await f.beforeModelCall(id)
  await assert.rejects(() => f.beforeModelCall(id), /额度已耗尽/)
  const before = (await f.status(id)).execution
  assert.equal(before.state, 'budget_exhausted')
  assert.match(before.reason, /额度已耗尽/)
  assert.equal(before.model_calls, 3)
  assert.equal(before.operations[0].state, 'completed')
  const originalEvents = [...f.sessions.get(id).events]
  const dispatched = f.calls.length
  for (const action of ['pause', 'cancel', 'pause']) {
    assert.equal((await f.rpc('task/' + action, { session_id: id })).ok, true)
    assert.deepEqual((await f.status(id)).execution, before)
  }
  assert.equal(f.calls.length, dispatched, '重复停止不重新取消已结算的评测')
  assert.deepEqual(f.sessions.get(id).events.slice(0, originalEvents.length), originalEvents)
  await f.reload()
  assert.deepEqual((await f.status(id)).execution, before)
  assert.equal((await f.rpc('task/resume', { session_id: id })).ok, false)
  await assert.rejects(() => f.beforeModelCall(id), /尚未恢复/)
  await assert.rejects(() => f.execute(id, 'task', 'start', { plan: taskPlan() }), /已有未结束任务/)
  assert.deepEqual((await f.status(id)).execution, before)
})

test('预算耗尽时停止仍取消活动操作，晚到结算保留预算原因与真实回执', async t => {
  for (const outcome of ['success', 'unknown', 'created-with-missing-cases']) await t.test(outcome, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let release, fail, operationSignal
    const creating = outcome === 'created-with-missing-cases'
    const action = creating ? 'create' : 'tasks/assembly-apply'
    const f = fixture(t, (endpoint, input, signal) => {
      if (endpoint === 'agents/' + action) {
        operationSignal = signal
        return new Promise((resolve, reject) => { release = resolve; fail = reject })
      }
      if (creating && endpoint === 'agents/detail' && input.experiment_id === 'EXP-test-agent-002') {
        return { ok: true, value: { evaluation: { sha256: 'incomplete-evaluation', cases: [] } } }
      }
      return taskResponder(endpoint, input)
    })
    installTaskGoals(f)
    const id = (await f.rpc('session', { task: '截止时保持活动操作证据' })).value.session_id
    await f.beforeModelCall(id)
    await beginTask(f, id, taskPlan({ budget: { max_model_calls: 3, max_repair_rounds: 3, timeout_minutes: 1 }, allowed_actions: [{ domain: 'agents', action }] }))
    const operation = f.execute(id, 'agents', action, creating ? { agent_id: 'test-agent' } : { target_source: 'experiment:EXP-test-agent-001', files: [] })
      .then(value => ({ value }), error => ({ error }))
    for (let count = 0; count < 40 && !release; count++) await setImmediate()
    assert.ok(release, '没有进入真实连续操作派发')
    t.mock.timers.tick(60_001)
    for (let count = 0; count < 40 && (await f.status(id)).execution.state !== 'budget_exhausted'; count++) await setImmediate()
    const before = (await f.status(id)).execution
    assert.equal(before.state, 'budget_exhausted')
    assert.match(before.reason, /总时限已耗尽/)
    assert.equal(operationSignal.aborted, true)
    assert.equal(before.operations[0].state, 'running')
    for (const action of ['pause', 'cancel']) {
      assert.equal((await f.rpc('task/' + action, { session_id: id })).ok, true)
      assert.deepEqual((await f.status(id)).execution, before)
    }
    const receipt = { ok: true, value: { source: creating ? 'experiment:EXP-test-agent-002' : 'experiment:EXP-test-agent-001' } }
    if (outcome === 'unknown') fail(new Error('取消后连接断开，未取得回执'))
    else release(receipt)
    const settled = await operation
    const after = (await f.status(id)).execution
    for (const key of ['id', 'state', 'reason', 'started_at', 'deadline_at', 'model_calls', 'assistant_model_calls', 'repair_rounds', 'plan']) assert.deepEqual(after[key], before[key])
    assert.equal(after.operations.length, 1)
    assert.equal(after.operations[0].id, before.operations[0].id)
    if (outcome === 'unknown') {
      assert.match(settled.error.message, /未取得回执/)
      assert.equal(after.operations[0].state, 'unknown')
      assert.equal(after.operations[0].receipt, undefined)
    } else {
      assert.equal(settled.value.state, creating ? 'failed' : 'completed')
      assert.equal(after.operations[0].state, 'completed')
      assert.deepEqual(after.operations[0].receipt, receipt)
      if (creating) assert.equal(after.target_source, 'experiment:EXP-test-agent-002')
    }
    assert.equal(f.calls.filter(call => call.endpoint === 'agents/' + action).length, 1, '不重放活动操作')
    assert.equal((await f.rpc('task/cancel', { session_id: id })).ok, true)
    assert.deepEqual((await f.status(id)).execution, after)
    assert.equal((await f.rpc('task/resume', { session_id: id })).ok, false)
  })
})

test('逐题抽样仅适配模型工具入口，固定Run与原公开source和批量samples保持一致', async t => {
  const run_id = 'run-11111111-1111-4111-8111-111111111111'
  const source = { run_id, extraction_contract: DECISION_EXTRACTION_CONTRACT, files: [{ path: 'trace.jsonl' }] }
  const f = fixture(t, endpoint => endpoint === 'agents/datasets/source' ? { ok: true, value: source } : { ok: true, value: { count: 0, skipped: [] } })
  const id = (await f.rpc('session', { task: '逐题抽取', context: { skill: 'decision-sample-extraction', run_id } })).value.session_id
  const projected = (await f.execute(id, 'agents', 'datasets/source')).result.value.extraction_contract
  assert.equal(projected.model_submission.transport, 'single-question-v1')
  assert.equal(projected.preview, undefined); assert.equal(projected.sample_fields, undefined)
  assert.deepEqual(projected.types, DECISION_EXTRACTION_CONTRACT.types)
  assert.equal(source.extraction_contract.model_submission, undefined, '不能改变公共API原对象')
  assert.deepEqual(source.extraction_contract.preview.required_fields, ['run_id', 'path', 'source_sha256', 'samples'])
  const flat = { path: 'trace.jsonl', source_sha256: 'a'.repeat(64), decision_id: 'decision-fixed', action_name: 'respond', workflow: '材料核对', task: { id: 'check-input', semantics: 'recommended_decision' }, question_name: 'enough', question: { type: 'noul', instructions: '当前材料足够吗？' }, target: { label: true, basis: '用户已提供必要材料。' } }
  await f.execute(id, 'agents', 'datasets/preview', flat)
  const input = f.calls.at(-1).input
  assert.equal(input.run_id, run_id); assert.equal(input.assistant_session_id, id)
  assert.deepEqual(input.samples, [{ decision_id: flat.decision_id, action_name: flat.action_name, workflow: flat.workflow, task: flat.task, questions: { enough: flat.question }, targets: { enough: flat.target } }])
  for (const field of ['question_name', 'question', 'target']) assert.equal(Object.hasOwn(input, field), false)
  const legacy = { run_id, path: flat.path, source_sha256: flat.source_sha256, samples: input.samples }
  await f.execute(id, 'agents', 'datasets/preview', legacy)
  assert.deepEqual(f.calls.at(-1).input.samples, legacy.samples)
  await f.execute(id, 'agents', 'datasets/preview', { path: flat.path, source_sha256: flat.source_sha256, skipped: ['材料不足'] })
  assert.deepEqual(f.calls.at(-1).input.samples, [])
  const dispatched = f.calls.length
  await assert.rejects(() => f.execute(id, 'agents', 'datasets/preview', { ...flat, run_id: 'run-other' }), /固定任务上下文/)
  await assert.rejects(() => f.execute(id, 'agents', 'datasets/preview', { ...flat, samples: [] }), /不能混用/)
  await assert.rejects(() => f.execute(id, 'agents', 'datasets/preview', '{"question":{'), /请求必须是对象/)
  assert.equal(f.calls.length, dispatched); assert.deepEqual((await f.status(id)).proposals, [])
  const general = (await f.rpc('session', { task: '只读查看来源' })).value.session_id
  assert.deepEqual((await f.execute(general, 'agents', 'datasets/source', { run_id })).result.value.extraction_contract, DECISION_EXTRACTION_CONTRACT)
})

test('已完成任务的工具与真实系统装配共用精简视图，公共查询和GUI保留全文', async t => {
  const f = fixture(t)
  const id = (await f.rpc('session', { task: '核对已交付结果', context: { skill: 'task-builder' } })).value.session_id
  const original = {
    id: 'finished-task', owner_session_id: id, state: 'completed', plan: taskPlan(),
    started_at: '2026-10-17T01:00:00.000Z', deadline_at: '2026-10-17T01:30:00.000Z',
    model_calls: 48, assistant_model_calls: 29, repair_rounds: 0,
    evaluation_usage: { evaluation: { observed_model_calls: 13, complete: true }, probe: { observed_model_calls: 6, complete: true } },
    operations: Array.from({ length: 7 }, (_, index) => ({ id: `op-${index}`, domain: 'instances', action: 'run', state: 'completed',
      input: { name: `instance-${index}` }, receipt: { ok: true, value: { detail: '完整实际操作回执'.repeat(100) } } })),
    delivery: { ready: true, run_id: 'run-fixed', instance: { name: 'delivery-instance', state: 'running' }, entry: { url: 'http://localhost:3000/' },
      artifacts: [{ path: 'artifacts/report.md', sha256: 'a'.repeat(64) }], note: '保留实际边界。',
      checks: [{ name: 'instance_running', ok: true, message: '实际容器正在运行' }, { name: 'optional_check', ok: false, message: '完整失败原因', details: { observed: 'unknown' } }],
      probe: { id: 'probe-1', path: 'delivery-probes/probe-1', status: 'completed', case_id: 'U-BUSINESS-001', session_id: 'probe-session',
        model_usage: { actual_model_calls: 6 }, downloads: [{ format: 'markdown', url: 'http://localhost:3000/report.md' }], report_sha256: 'b'.repeat(64),
        trace: [{ text: '原始探针轨迹正文' }], receipt: { text: '原始探针回执正文' } } },
  }
  const before = structuredClone(original)
  appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', { kind: 'execution', owner_session_id: id, execution: original })
  const tool = f.tools.get('platform_task'), args = { action: 'status', input: {} }
  const raw = await f.execute(id, 'task', 'status')
  assert.deepEqual(raw, before, 'execute继续返回完整实际记录')
  const view = JSON.parse(tool.output.render(args, raw)[0].text)
  assert.equal(view.operations.length, 5); assert.equal(view.operations[0].id, 'op-2')
  assert.equal(view.operations[0].domain, 'instances'); assert.equal(view.operations[0].receipt, undefined); assert.equal(view.operations[0].input, undefined)
  assert.deepEqual(view.delivery.checks[0], { name: 'instance_running', ok: true })
  assert.deepEqual(view.delivery.checks[1], before.delivery.checks[1], '失败检查及其详情不可省略')
  assert.equal(view.delivery.probe.trace, undefined); assert.equal(view.delivery.probe.receipt, undefined)
  for (const key of ['status', 'model_usage', 'downloads', 'report_sha256']) assert.deepEqual(view.delivery.probe[key], before.delivery.probe[key])
  assert.equal(view.model_calls, 48); assert.equal(view.assistant_model_calls, 29)
  assert.match(view.model_usage_observation, /截至本次状态读取.*最终累计以任务卡当前计数为准/)
  const system = await f.assemble(id)
  const systemView = JSON.parse(system.split('当前任务方案与实际进度：')[1].split('\n本任务读取')[0])
  assert.deepEqual(systemView, view)
  assert.deepEqual(tool.output.presentationMeta(args, raw).result, before, 'GUI元数据保留原始全文')
  assert.deepEqual((await f.rpc('task/status', { session_id: id })).value, before)
  assert.deepEqual((await f.status(id)).execution, before)
  assert.deepEqual(original, before, '模型投影不能修改持久对象')
  await f.reload()
  assert.deepEqual((await f.status(id)).execution, before, '冷恢复仍读取完整原始记录')
})

test('未完成任务的模型status全文及原系统摘要不变，算力交付比较信息完整保留', async t => {
  const f = fixture(t)
  for (const state of ['running', 'paused', 'unknown', 'budget_exhausted', 'cancelled']) {
    const id = (await f.rpc('session', { task: '核对任务状态', context: { skill: 'task-builder' } })).value.session_id
    const task = { id: `task-${state}`, owner_session_id: id, state, plan: taskPlan(), model_calls: 4, repair_rounds: 1,
      operations: [{ id: 'eval-operation', domain: 'agents', action: 'eval/start', state: 'unknown', input: { source: 'experiment:EXP-test-agent-001' }, receipt: { value: { job_id: 'evaluation-job' } } }] }
    appendPluginRecord(f.sessions.get(id).session, 'plugin:harness-platform/assistant', { kind: 'execution', owner_session_id: id, execution: task })
    const raw = await f.execute(id, 'task', 'status')
    assert.deepEqual(JSON.parse(f.tools.get('platform_task').output.render({ action: 'status' }, raw)[0].text), task)
    assert.equal(completedTaskModelView(task), task)
    const system = await f.assemble(id)
    const systemView = JSON.parse(system.split('当前任务方案与实际进度：')[1].split('\n本任务读取')[0])
    assert.deepEqual(systemView, { ...task, operations: [{ id: 'eval-operation', action: 'eval/start', state: 'unknown' }] })
  }
  const compute = { state: 'completed', operations: [], plan: { kind: 'compute-variant' },
    delivery: { comparison: { comparability: { passed: true }, quality: { passed: false }, resource: { reduction_pct: 12.5 } }, end_confirmed: false, note: '仍需用户复核' } }
  assert.deepEqual(completedTaskModelView(compute).delivery, compute.delivery)
})

test('实例工具从精确原生投影读取交付摘要，不激活历史Agent且公共及GUI回执保持原文', async t => {
  const publicReceipt = { ok: true, value: { instance: { name: 'delivered-instance', source_id: 'experiment:EXP-test-agent-002', agent_id: 'test-agent', state: 'stopped' }, runs: [{ id: 'run-passed' }] } }
  const before = structuredClone(publicReceipt)
  const f = fixture(t, endpoint => endpoint === 'instances/detail' ? publicReceipt : undefined)
  const previousId = (await f.rpc('session', { task: '构建业务智能体' })).value.session_id
  const currentId = (await f.rpc('session', { task: '核对实例是否已交付' })).value.session_id
  const identity = workspaceIdentity(f.root)
  const task = { id: 'delivered-task', owner_session_id: previousId, state: 'completed', target_source: before.value.instance.source_id,
    plan: taskPlan({ instance_name: 'delivered-instance', goal: '不得进入wire的完整业务目标' }), operations: [], model_calls: 49, repair_rounds: 0,
    delivery: { ready: true, run_id: 'run-passed', instance: { name: 'delivered-instance', source: before.value.instance.source_id, state: 'running' },
      checks: [{ name: 'instance_running', ok: true, message: '当时实例正在运行' }], probe: { id: 'probe-original', status: 'completed', session_id: 'probe-session', trace: ['不得进入wire的业务内容'] },
      entry: { url: 'http://user:private-password@localhost/?token=private-token' }, artifacts: [{ content: '原始报告正文' }] } }
  const appendTask = execution => appendPluginRecord(f.sessions.get(previousId).session, 'plugin:harness-platform/assistant', { kind: 'execution', workspace_id: identity.id, owner_session_id: previousId, execution: JSON.parse(JSON.stringify(execution)) })
  appendTask(task)
  const observed = () => ({ kind: 'sequenced', ...f.ctx.sessionProjections.snapshot(f.sessions.get(previousId).session) })
  const wire = observed().values.harnessPlatformAssistant
  assert.equal(wire.task.delivery.ready, true)
  assert.equal(wire.task.owner_session_id, previousId)
  assert.doesNotMatch(JSON.stringify(wire), /完整业务目标|业务内容|报告正文|private-password|private-token|http:/)
  const reads = [], resolved = [], originalResolve = f.services.controller.resolveAgent
  f.services.controller.resolveAgent = async id => { resolved.push(id); return originalResolve(id) }
  f.services.controller.list = async () => ({ items: [{ sessionId: previousId, cwd: f.root, projections: { kind: 'cached', values: {} } }] })
  f.services.controller.projections = async ({ sessionId }) => { reads.push(sessionId); return observed() }
  const value = await f.execute(currentId, 'instances', 'detail', { name: 'delivered-instance' })
  assert.deepEqual(reads, [previousId]); assert.ok(resolved.every(id => id === currentId), '不能通过resolveAgent激活历史会话')
  assert.equal(value.delivery_history.records.length, 1)
  assert.equal(value.delivery_history.records[0].asOfSeq, observed().asOfSeq)
  assert.equal(value.delivery_history.records[0].task.delivery.probe.id, 'probe-original')
  assert.equal(value.delivery_history.records[0].task.delivery.instance.state, 'running')
  assert.equal(value.result.value.instance.state, 'stopped', '历史交付状态不能改写实时实例状态')
  assert.match(value.delivery_history.note, /未找到记录不表示从未交付/)
  const args = { action: 'detail', input: { name: 'delivered-instance' } }, tool = f.tools.get('platform_instances')
  assert.equal(JSON.parse(tool.output.render(args, value)[0].text).delivery_history.records.length, 1)
  const meta = tool.output.presentationMeta(args, value)
  assert.equal(meta.delivery_history, undefined); assert.deepEqual(meta.result, before)
  assert.deepEqual(publicReceipt, before)
  assert.deepEqual(f.calls.map(call => call.endpoint), ['instances/detail'], '只读取既有投影，不重跑交付或创建探针')
  await f.reload()
  assert.deepEqual(observed().values.harnessPlatformAssistant, wire, '投影重装后仍从原任务事件恢复摘要')
  appendTask({ ...task, id: 'new-task', state: 'unknown', delivery: undefined, reason: '新任务执行回执未知' })
  const latest = await f.execute(currentId, 'instances', 'detail', { name: 'delivered-instance' })
  assert.equal(latest.delivery_history.records[0].task.id, 'new-task')
  assert.equal(latest.delivery_history.records[0].task.state, 'unknown')
  assert.equal(latest.delivery_history.records[0].task.reason, '新任务执行回执未知')
  assert.equal(latest.delivery_history.records[0].task.delivery, undefined, '仅最新任务，不能沿用被替换的成功状态')
})

test('交付历史按工作区、owner、实例与来源隔离，缓存及待迁移信息不构成交付证明', async t => {
  const f = fixture(t), identity = workspaceIdentity(f.root)
  const instance = { name: 'target-instance', source_id: 'experiment:EXP-test-agent-002', agent_id: 'test-agent' }
  const summary = id => deliveryProjection({ session_id: id, workspace_id: identity.id, execution: {
    id: `task-${id}`, owner_session_id: id, state: 'completed', target_source: instance.source_id, plan: taskPlan({ instance_name: instance.name }), operations: [],
    delivery: { ready: true, instance: { name: instance.name, source: instance.source_id }, checks: [{ name: 'delivery_report', ok: true }] },
  } })
  const values = Object.fromEntries(['matching', 'other-workspace', 'other-owner', 'other-source', 'other-name', 'other-delivery-source', 'other-cwd', 'unbound-workspace', 'cached', 'migration', 'failed'].map(id => [id, { kind: 'sequenced', asOfSeq: 10, values: { harnessPlatformAssistant: summary(id) } }]))
  values['other-workspace'].values.harnessPlatformAssistant.workspace_id = 'workspace-other'
  values['other-owner'].values.harnessPlatformAssistant.task.owner_session_id = 'original-session'
  values['other-source'].values.harnessPlatformAssistant.task.target_source = 'experiment:EXP-test-agent-001'
  values['other-name'].values.harnessPlatformAssistant.task.instance_name = 'different-instance'
  values['other-delivery-source'].values.harnessPlatformAssistant.task.delivery.instance.source = 'experiment:EXP-test-agent-001'
  delete values['unbound-workspace'].values.harnessPlatformAssistant.workspace_id
  values.cached.kind = 'cached'; values.migration.kind = 'migration-required'
  values.failed.values.harnessPlatformAssistant.task.state = 'unknown'
  values.failed.values.harnessPlatformAssistant.task.reason = '业务回执未知'
  values.failed.values.harnessPlatformAssistant.task.delivery = { ready: false, checks: [{ name: 'delivery_report', ok: false, message: '实际下载失败' }] }
  const reads = [], reader = {
    async list() { return { items: Object.keys(values).map(sessionId => ({ sessionId, cwd: sessionId === 'other-cwd' ? f.root + '/other' : f.root, projections: { kind: 'cached', values: { harnessPlatformAssistant: summary(sessionId) } } })) } },
    async projections({ sessionId }) { reads.push(sessionId); return values[sessionId] },
  }
  const result = await readInstanceDeliveryHistory(f.root, instance, reader, new AbortController().signal)
  assert.deepEqual(result.records.map(row => row.session_id), ['matching', 'failed'])
  assert.equal(result.records[1].task.delivery.ready, false)
  assert.equal(result.records[1].task.delivery.checks[0].message, '实际下载失败')
  assert.equal(reads.includes('other-cwd'), false)
  assert.deepEqual(result.unavailable.map(row => row.session_id), ['cached', 'migration'])
  const noMatch = await readInstanceDeliveryHistory(f.root, { ...instance, source_id: 'experiment:EXP-test-agent-999' }, reader, new AbortController().signal)
  assert.deepEqual(noMatch.records, []); assert.match(noMatch.note, /不表示从未交付/)
  const abort = new AbortController()
  await assert.rejects(() => readInstanceDeliveryHistory(f.root, instance, { ...reader, async projections() { abort.abort(new Error('用户取消')); throw abort.signal.reason } }, abort.signal), /用户取消/)
})

test('交付wire在初始化及所有稀疏可选字段下符合原生无损JSON，投影重装保持可传输', async t => {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const sdk = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
  const { snapshotJsonValue } = await import(sdk.resolve('@deepseek-ai/dsh-util-values'))
  const sparseTask = { id: 'sparse-task', owner_session_id: 'sparse-session', state: 'unknown', operations: [],
    plan: { agent_id: 'test-agent', instance_name: undefined }, reason: undefined, target_source: undefined }
  const cases = [
    { session_id: 'initial-session', workspace_id: undefined, execution: undefined },
    { session_id: 'sparse-session', execution: sparseTask },
    { session_id: 'sparse-session', execution: { ...sparseTask, delivery: { ready: undefined, run_id: undefined,
      instance: { name: 'test-instance', source: 'experiment:EXP-test-agent-001', state: undefined },
      checks: [{ name: 'unknown_check', ok: undefined, message: undefined }, { name: 'failed_check', ok: false, message: '保留实际失败' }],
      probe: { id: 'probe-1', status: 'unknown', case_id: undefined, session_id: undefined } } } },
    { session_id: 'complete-session', workspace_id: 'workspace-test', execution: { ...sparseTask, state: 'completed', owner_session_id: 'complete-session',
      delivery: { ready: true, run_id: 'run-1', checks: [{ name: 'passed', ok: true, message: '不会重复传输成功说明' }],
        probe: { id: 'probe-2', status: 'completed', case_id: 'U-BUSINESS-001', session_id: 'probe-session' } } } },
  ]
  for (const source of cases) {
    const view = deliveryProjection(source)
    assert.deepEqual(snapshotJsonValue(view), view, '必须通过实际原生无损JSON校验，不能靠stringify静默丢字段')
  }
  assert.equal(snapshotJsonValue({ workspace_id: undefined }), undefined, '测试须能复现原生传输拒绝条件')
  const f = fixture(t)
  const session = f.addSession('initial-session')
  const snapshot = () => f.ctx.sessionProjections.snapshot(session)
  assert.deepEqual(snapshot().values.harnessPlatformAssistant, { session_id: 'initial-session' })
  assert.notEqual(snapshotJsonValue({ sessionId: session.id, cwd: f.root, projections: { kind: 'sequenced', ...snapshot() } }), undefined)
  appendPluginRecord(session, 'plugin:harness-platform/assistant', { kind: 'execution', owner_session_id: session.id,
    execution: { id: 'sparse-task', owner_session_id: session.id, state: 'unknown', plan: { agent_id: 'test-agent' }, operations: [],
      delivery: { checks: [{ name: 'pending_check' }], probe: { id: 'probe-1', status: 'unknown' } } } })
  const observed = snapshot()
  assert.deepEqual(snapshotJsonValue(observed), observed)
  await f.reload()
  assert.deepEqual(snapshot(), observed)
  assert.deepEqual(snapshotJsonValue(snapshot()), observed)
})

test('显式切换固定目标后，旧自动保存只读核实不能代替新目标预览', async t => {
  for (const dataset of [false, true]) for (const readable of [false, true]) await t.test(`${dataset ? '跨Run' : '跨Experiment'}：旧回执${readable ? '可核实' : '仍未知'}`, async t => {
    const oldId = dataset ? 'run-11111111-1111-4111-8111-111111111111' : 'EXP-basic-001'
    const newId = dataset ? 'run-22222222-2222-4222-8222-222222222222' : 'EXP-basic-002'
    const datasetId = target => `decision-dataset-${target.slice(4)}`
    const content = target => dataset ? [{ workflow: target, _meta: { id: `sample-${target}` } }]
      : [{ id: target, title: '版本特性', description: '基础模拟内容', source_refs: [], evidence_refs: [] }]
    const context = target => dataset ? { skill: 'decision-sample-extraction', run_id: target }
      : { skill: 'agent-maintenance', workflow: 'features', agent_id: 'basic', experiment_id: target }
    const action = dataset ? 'datasets/preview' : 'features/preview', writes = []
    let oldReadable = false
    const f = fixture(t, (endpoint, input) => {
      if (endpoint === `agents/${action}`) {
        const target = dataset ? input.run_id : input.experiment_id
        return { ok: true, value: { preview_id: target, ...(dataset
          ? { run_id: target, records: content(target), count: 1, file: `evolution/datasets/${datasetId(target)}.json` }
          : { experiment_id: target, features: content(target) }) } }
      }
      if (endpoint === `agents/${dataset ? 'datasets/apply' : 'features/apply'}`) {
        writes.push(input.preview_id)
        return { ok: true, value: { saved: true } }
      }
      assert.equal(endpoint, dataset ? 'agents/datasets/read' : 'agents/detail')
      const target = dataset ? `run-${input.dataset_id.slice('decision-dataset-'.length)}` : input.experiment_id
      if (target === oldId && !oldReadable) return { ok: false, error: { message: '旧批次暂不可读取' } }
      return { ok: true, value: dataset ? { dataset: { id: datasetId(target), run_id: target, records: content(target) } } : { features: content(target) } }
    })
    const id = (await f.rpc('session', { task: '整理旧目标', context: context(oldId) })).value.session_id
    assert.equal((await f.execute(id, 'agents', action, {})).state, 'unknown')
    const original = structuredClone((await f.status(id)).automatic_save)
    const originalEvents = structuredClone(f.sessions.get(id).session.snapshotEvents())
    assert.equal((await f.rpc('session', { session_id: id, task: '明确改为新目标', context: context(newId) })).ok, true)
    await f.reload()
    oldReadable = readable
    const result = await f.execute(id, 'agents', action, {})
    assert.deepEqual(f.sessions.get(id).session.snapshotEvents().slice(0, originalEvents.length), originalEvents, '原未知写入与失败事件不改写')
    const saves = f.sessions.get(id).events.filter(event => event.data?.kind === 'automatic-save').map(event => event.data)
    if (readable) {
      assert.equal(result.state, 'completed')
      assert.deepEqual(dataset ? result.result.value.dataset.records : result.result.value.features, content(newId), '本次结果必须来自新目标')
      assert.deepEqual(writes, [oldId, newId], '只核实旧写入，新目标独立保存一次')
      assert.ok(saves.some(save => save.state === 'completed' && save.expected_sha256 === original.expected_sha256 && save.failure.message === original.failure.message))
      assert.notEqual((await f.status(id)).automatic_save.expected_sha256, original.expected_sha256)
    } else {
      assert.equal(result.state, 'unknown')
      assert.match(result.result.error.message, /本次预览尚未执行/)
      assert.deepEqual(result.result.error.target, original.target)
      assert.deepEqual(writes, [oldId])
      assert.equal(f.calls.filter(call => call.endpoint === `agents/${action}`).length, 1, '旧结果未知时不预览或保存新目标')
      assert.deepEqual((await f.status(id)).automatic_save, original)
    }
    assert.deepEqual((await f.status(id)).proposals, [])
  })
})
