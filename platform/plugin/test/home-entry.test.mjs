import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import { GENERAL_PLACEHOLDER, HOME_SUBTITLE, PLATFORM_SLOGAN, homeTaskRequest } from '../src/home-entry.ts'
import { createPlatformUpdates } from '../src/realtime/client.ts'

const require = createRequire(import.meta.url)
const compile = async entry => (await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.svg': 'dataurl' }, external: ['react', 'react/jsx-runtime', 'react-dom/server'] })).outputFiles[0].text
const homeSource = await compile('../src/home.tsx'), loginSource = await compile('../src/login.tsx')
const experiment = 'EXP-alpha-001-r123456abcdef'
const runId = 'run-12345678-1234-4234-8234-123456789abc'
function memoryStorage() {
  const values = new Map()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
function home({ example = false, exampleCase = true, exampleExtra = false, exampleActive = 'EXP-daily-inspection-assistant-002-r222222222222', noRuns = false, runVerdict = 'passed', runStatus = 'completed', runsFixture, failStart = false, sessionFixture, jobsFixture = [], intercept, storage = memoryStorage(), username = 'admin', workspaceRoot = '/test-assets', workspaceId = 'workspace-test', accountError = false } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], tasks = [], navigations = [], assistantSelections = [], projectionRefreshes = []
  let cursor = 0, effects = [], changed = false, tree
  const react = { ...require('react'),
    useRef(initial) { const key = cursor++; if (!(key in states)) states[key] = { current: initial }; return states[key] },
    useState(initial) { const key = cursor++; if (!(key in states)) states[key] = initial; return [states[key], next => { const value = typeof next === 'function' ? next(states[key]) : next; if (!Object.is(states[key], value)) { states[key] = value; changed = true } }] },
    useEffect(effect, values) { const key = cursor++; if (!dependencies[key] || values.some((value, at) => value !== dependencies[key][at])) { dependencies[key] = values; effects.push(() => { cleanups[key]?.(); cleanups[key] = effect() }) } },
    useSyncExternalStore(_subscribe, get) { return get() },
  }
  react.useLayoutEffect = react.useEffect
  const module = { exports: {} }
  vm.runInNewContext(homeSource, { module, exports: module.exports, Error, sessionStorage: storage, require: name => name === 'react' ? react : require(name) })
  let inventory = { root: workspaceRoot, workspace: { id: workspaceId, legacyRoots: [] }, observed_at: '2026-10-16T00:00:00Z', agents: [{ id: 'alpha' }, ...(example ? [{ id: 'daily-inspection-assistant' }] : [])], experiments: [], runs: [] }
  const updates = createPlatformUpdates()
  const sessionSnapshot = sessionFixture ?? { ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }
  const props = { catalog: { subscribe() { return () => {} }, getSnapshot() { return { status: 'ready', inventory } }, refresh: async () => {} },
    sessions: { list: { subscribe() { return () => {} }, getSnapshot() { return sessionSnapshot } }, refresh: async () => {}, refreshProjections: async id => { projectionRefreshes.push(id) } },
    assistant: { select: async id => { assistantSelections.push(id) } },
    updates, navigate: target => navigations.push(target),
    startConversation: async (root, prompt, context) => { if (failStart) throw new Error('会话服务暂不可用'); tasks.push({ root, prompt, context }) },
    rpc: { call: async (_channel, method, body) => {
      calls.push({ method, body })
      const intercepted = intercept?.(method, body)
      if (intercepted !== undefined) return await intercepted
      if (method === 'auth/current') return accountError ? { ok: false, error: { message: '账号暂不可读' } } : { ok: true, value: { username } }
      if (method === 'home') return { ok: true, value: { recent_runs: runsFixture ?? (noRuns ? [] : [{ id: runId, agent_id: 'alpha', experiment_id: experiment, status: runStatus, effective_verdict: runVerdict, created_at: '2026-10-16T00:00:00Z' }]), instances: { ok: true, value: { instances: [] } }, mcp: { ok: true, value: { connections: [] } } } }
      if (method === 'mcp/control/status') return { ok: true, value: { riskFacts: [] } }
      if (method === 'agents/eval/list') return { ok: true, value: { jobs: jobsFixture } }
      if (method === 'agents/list') return { ok: true, value: { agents: [{ id: 'alpha', name: '行业简报助手' }] } }
      if (method === 'agents/detail') return { ok: true, value: { agent: { id: body.agent_id, manifest: { active_experiment: body.agent_id === 'daily-inspection-assistant' ? exampleActive : body.experiment_id || experiment } }, experiment: { id: body.experiment_id || experiment }, selection: { basis: body.experiment_id ? 'explicit' : 'active_experiment' }, versions: [{ id: body.experiment_id || experiment }], evaluation: { cases: body.agent_id === 'daily-inspection-assistant' ? exampleCase ? [{ id: 'U-ASSET-PAGES-001' }] : [] : [{ id: 'U-BUSINESS-001' }] } } }
      if (method === 'agents/tasks/capabilities') return { ok: true, value: { sources: [{ source: 'experiment:EXP-daily-inspection-assistant-001-r111111111111', experiment_id: 'EXP-daily-inspection-assistant-001-r111111111111', plugins: [] }, { source: 'experiment:EXP-daily-inspection-assistant-002-r222222222222', experiment_id: 'EXP-daily-inspection-assistant-002-r222222222222', plugins: [{ plugin_names: ['/opt/dsh-managed/task-example-tools.mjs'] }] }, ...(exampleExtra ? [{ source: 'experiment:EXP-daily-inspection-assistant-003-r333333333333', experiment_id: 'EXP-daily-inspection-assistant-003-r333333333333', plugins: [{ plugin_names: ['/opt/dsh-managed/task-example-tools.mjs'] }] }] : [])] } }
      throw new Error(`unexpected RPC ${method}`)
    } },
  }
  function render() { let iteration = 0; do { if (++iteration > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.HomePage(props); effects.forEach(effect => effect()) } while (changed); return tree }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...nodes(value.props?.children)] }
  function text(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.map(item => text(item)).join('') : value && typeof value === 'object' ? text(value.props?.children ?? '') : String(value ?? '') }
  const button = title => nodes().find(node => node.type === 'button' && text(node).trim().replace(' →', '') === title)
  const label = title => nodes().find(node => node.props?.['aria-label'] === title)
  async function settle() { for (let step = 0; step < 8; step++) { render(); await new Promise(resolve => setImmediate(resolve)) }; render() }
  const change = (title, value) => { label(title).props.onChange({ target: { value } }); render() }
  const click = async title => { const found = button(title); assert.ok(found, `missing button ${title}`); await found.props.onClick?.(); await settle() }
  const submit = async () => { nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle() }
  render()
  return { settle, nodes, text, calls, tasks, navigations, assistantSelections, projectionRefreshes, button, label, change, click, submit, invalidate: updates.invalidate,
    switchWorkspace(root, id) { inventory = { ...inventory, root, workspace: { ...inventory.workspace, id } }; render() },
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()) }
}

test('继续工作回到原 Session 和原 Job，不创建第二个任务', async () => {
  const sessionId = 'session-original'
  const jobId = '550e8400-e29b-41d4-a716-446655440000'
  const ui = home({ sessionFixture: { ids: [sessionId], byId: { [sessionId]: { cwd: '/test-assets', updatedAt: Date.now(), displayTitle: '完成原评测',
    projectionValues: { harnessPlatformAssistant: { session_id: sessionId, workspace_id: 'workspace-test', pending_proposals: 1,
      task: { id: 'task-1', owner_session_id: sessionId, state: 'paused', agent_id: 'alpha' } } } } }, projectionsBySession: {}, phase: 'ready' },
    jobsFixture: [{ job_id: jobId, source: `experiment:${experiment}`, agent_id: 'alpha', experiment_id: experiment, status: 'running' }] })
  try {
    await ui.settle()
    assert.match(ui.text(), /完成原评测/)
    assert.match(ui.text(), /待确认/)
    await ui.click('继续原会话')
    assert.deepEqual(ui.assistantSelections, [sessionId])
    assert.equal(ui.navigations.at(-1), 'conversations')
    await ui.click('查看原任务')
    assert.equal(ui.navigations.at(-1).job_id, jobId)
    assert.equal(ui.navigations.at(-1).tab, 'jobs')
    assert.equal(ui.tasks.length, 0)
  } finally { ui.cleanup() }
})

test('首页风险概况只汇总有效事实，读取失败和过期分别提示', async () => {
  const base = { id: 'risk-1', version: 1, scope: {}, source: 'fixture', signals: [], observedAt: new Date(Date.now() - 60_000).toISOString() }
  const active = home({ intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { riskFacts: [
    { ...base, status: 'assessed', level: 'high', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { ...base, id: 'risk-old', level: 'low', expiresAt: new Date(Date.now() - 1_000).toISOString() },
  ] } } } })
  try {
    await active.settle()
    assert.match(active.text(), /网关风险评估.*存在高风险.*1 项有效范围，1 项已过期/s)
    const card = active.nodes().find(node => node.props?.className === 'harness-stat' && active.text(node).includes('网关风险评估'))
    card.props.onClick()
    assert.deepEqual({ ...active.navigations.at(-1) }, { page: 'gateway', tab: 'risk' })
  } finally { active.cleanup() }
  const expired = home({ intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { riskFacts: [
    { ...base, status: 'assessed', level: 'low', expiresAt: new Date(Date.now() - 1_000).toISOString() },
  ] } } } })
  try { await expired.settle(); assert.match(expired.text(), /网关风险评估.*评估已过期/s) } finally { expired.cleanup() }
  const failed = home({ intercept(method) { if (method === 'mcp/control/status') return { ok: false, error: { message: '读取失败' } } } })
  try { await failed.settle(); assert.match(failed.text(), /网关风险评估.*读取失败/s) } finally { failed.cleanup() }
})

test('继续工作读取较早待确认会话，跨会话与 Job 按待处理优先级排列', async () => {
  const ids = Array.from({ length: 13 }, (_, index) => `session-${index}`)
  const byId = Object.fromEntries(ids.map((id, index) => [id, { cwd: '/test-assets', updatedAt: Date.now() - index * 1000,
    displayTitle: `会话 ${index}`, projectionValues: { harnessPlatformAssistant: { session_id: id, workspace_id: 'workspace-test',
      ...(index === 12 ? { pending_proposals: 1 } : {}), task: { id: `task-${index}`, owner_session_id: id, state: 'completed', agent_id: 'alpha' } } } }]))
  const jobId = '550e8400-e29b-41d4-a716-446655440001'
  const ui = home({ sessionFixture: { ids, byId, projectionsBySession: {}, phase: 'ready' }, jobsFixture: [
    { job_id: jobId, source: `experiment:${experiment}`, agent_id: 'alpha', experiment_id: experiment, status: 'running' },
  ] })
  try {
    await ui.settle()
    assert.equal(ui.projectionRefreshes.length, 13)
    const rows = ui.nodes().filter(node => node.type === 'article' && node.props.className === 'harness-continue-item')
    assert.match(ui.text(rows[0]), /会话 12.*待确认/s)
    assert.match(ui.text(rows[1]), /智能体 alpha.*运行中/s)
    await ui.click('查看原任务')
    assert.equal(ui.navigations.at(-1).job_id, jobId)
  } finally { ui.cleanup() }
})

test('业务未通过、无法判定与执行失败的 Run 进入继续处理，同 Run 不重复列为 Job 或最近工作', async () => {
  const inconclusiveId = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const executionFailedId = 'run-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const unknownId = 'run-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const passedId = 'run-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const failed = { id: runId, agent_id: 'alpha', agent_name: '行业简报助手', experiment_id: experiment, status: 'completed', effective_verdict: 'failed', created_at: '2026-10-16T08:00:00Z' }
  const ui = home({ runsFixture: [failed, { ...failed },
    { ...failed, id: inconclusiveId, effective_verdict: 'inconclusive', created_at: '2026-10-16T07:00:00Z' },
    { ...failed, id: executionFailedId, status: 'failed', effective_verdict: null, created_at: '2026-10-16T06:00:00Z' },
    { ...failed, id: unknownId, effective_verdict: null, created_at: '2026-10-16T05:30:00Z' },
    { ...failed, id: passedId, effective_verdict: 'passed', created_at: '2026-10-16T05:00:00Z' },
  ], jobsFixture: [
    { job_id: 'job-for-failed-run', source: `experiment:${experiment}`, agent_id: 'alpha', experiment_id: experiment, run_id: runId, status: 'completed' },
    { job_id: 'job-for-passed-run', source: `experiment:${experiment}`, agent_id: 'alpha', experiment_id: experiment, run_id: passedId, status: 'completed' },
  ] })
  try {
    await ui.settle()
    const rows = ui.nodes().filter(node => node.type === 'article' && node.props.className === 'harness-continue-item')
    assert.equal(rows.length, 4, '同一 Run 只保留一个待处理入口，并合并对应 Job')
    const title = row => ui.nodes(row).find(node => node.props?.className === 'harness-continue-title')
    assert.match(ui.text(title(rows[0])), /行业简报助手.*版本 001 评测.*结果待处理/s)
    assert.match(ui.text(rows[0]), /执行结束.*业务未通过/s)
    assert.match(ui.text(rows[1]), /结论待核实/)
    assert.match(ui.text(rows[2]), /执行失败.*尚无业务结论/s)
    assert.match(ui.text(title(rows[3])), /结论待核对/)
    assert.match(ui.text(rows[3]), /业务结论未知/)
    const recent = ui.nodes().find(node => node.props?.className === 'harness-card harness-recent-work')
    assert.equal(ui.nodes(recent).filter(node => node.props?.className === 'harness-run-row').length, 1)
    assert.doesNotMatch(ui.text(recent), /业务未通过|结论待核实|执行失败/)
    await ui.click('查看结果')
    assert.deepEqual({ ...ui.navigations.at(-1) }, { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: experiment, run_id: runId })
  } finally { ui.cleanup() }
})

test('Run 索引读取失败时不把继续处理误判为空', async () => {
  const ui = home({ intercept(method) { if (method === 'home') return { ok: false, error: { message: 'Run 索引不可读' } } } })
  try {
    await ui.settle()
    assert.match(ui.text(), /继续处理暂无法核对全部结果/)
    assert.doesNotMatch(ui.text(), /暂无需要继续的任务|尚无 Run/)
  } finally { ui.cleanup() }
})

test('首页突出任务输入、同层快捷入口和继续工作，登录承接品牌口号', async () => {
  const ui = home()
  try { await ui.settle(); assert.match(ui.text(), /用 AI 构建和管理智能体/); assert.ok(ui.text().includes(HOME_SUBTITLE)); assert.equal(ui.label('业务任务').props.placeholder, GENERAL_PLACEHOLDER); assert.equal(ui.label('业务任务').props.rows, 1); assert.equal(ui.button('开始任务').props.disabled, true); assert.equal(ui.text().includes(PLATFORM_SLOGAN), false); assert.ok(ui.nodes().some(node => node.props?.className === 'harness-home-workspace')); assert.ok(ui.nodes().some(node => node.props?.className === 'harness-home-shortcuts')); assert.equal(ui.button('自由咨询'), undefined, '默认输入即自由咨询，不额外占用手机首屏'); const layout = ui.nodes().find(node => node.props?.className === 'harness-home-workspace'); assert.deepEqual(Array.from(layout.props.children, child => child.props.className), ['harness-home-primary', 'harness-home-secondary']); assert.match(ui.text(layout.props.children[0]), /继续处理.*最近工作/s); assert.match(ui.text(layout.props.children[1]), /工作区概况.*从一个可验证的目标开始/s); await ui.click('查看记录'); assert.deepEqual({ ...ui.navigations.at(-1) }, { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: experiment, run_id: runId }) } finally { ui.cleanup() }
  const module = { exports: {} }; vm.runInNewContext(loginSource, { module, exports: module.exports, require })
  assert.match(module.exports.loginPage('/hep/login'), /让智能体真正可用，持续变好。/)
})

test('通用入口保留需求原文且不预设构建流程，空输入和会话失败不假跳转', async () => {
  const ui = home()
  try {
    await ui.settle()
    await ui.submit(); assert.equal(ui.tasks.length, 0); assert.match(ui.text(), /请先描述/)
    ui.change('业务任务', '请帮我查看当前运行的实例。'); await ui.submit()
    assert.equal(ui.tasks[0].prompt, '请帮我查看当前运行的实例。'); assert.deepEqual({ ...ui.tasks[0].context }, { page: 'home', entry_intent: 'general' }); assert.deepEqual(ui.navigations, ['conversations'])
  } finally { ui.cleanup() }
  const failed = home({ failStart: true })
  try { await failed.settle(); failed.change('业务任务', '构建报告助手'); await failed.submit(); assert.match(failed.text(), /会话服务暂不可用/); assert.equal(failed.navigations.length, 0) } finally { failed.cleanup() }
})

test('四类快捷任务仅凭描述进入对应意图，不预选智能体、版本或运行记录', async () => {
  const cases = [
    { label: '构建智能体', action: '开始构建', mode: 'build', skill: 'task-builder', workflow: 'creation', prompt: '构建每天生成行业情报简报的智能体。' },
    { label: '评测效果', action: '开始评测', mode: 'evaluate', skill: 'agent-maintenance', workflow: 'evaluation', prompt: '评测行业简报助手当前启用版本的来源准确性。' },
    { label: '改进能力', action: '开始改进', mode: 'improve', skill: 'task-builder', workflow: 'improvement', prompt: '根据最近一次运行，改进行业简报助手遗漏来源的问题。' },
    { label: '管理实例与工具', action: '开始管理', mode: 'manage', skill: undefined, workflow: undefined, prompt: '核对当前实例和工具连接。' },
  ]
  for (const entry of cases) {
    const ui = home({ intercept(method) {
      if (method === 'agents/list' || method === 'agents/detail') throw new Error('首页无需预读选择器数据')
    } })
    try {
      await ui.settle()
      await ui.click(entry.label)
      assert.equal(ui.nodes().some(node => node.type === 'select'), false)
      assert.equal(ui.nodes().some(node => /(?:^|\s)harness-entry-(?:selection|run|association)(?:\s|$)/.test(node.props?.className ?? '')), false)
      ui.change('业务任务', entry.prompt)
      assert.equal(ui.button(entry.action).props.disabled, false)
      await ui.submit()
      assert.equal(ui.tasks.length, 1); assert.equal(ui.tasks[0].prompt, entry.prompt)
      assert.equal(ui.tasks[0].root, '/test-assets'); assert.equal(ui.tasks[0].context.page, 'home')
      assert.equal(ui.tasks[0].context.skill, entry.skill); assert.equal(ui.tasks[0].context.workflow, entry.workflow); assert.equal(ui.tasks[0].context.entry_intent, entry.mode)
      for (const key of ['agent_id', 'experiment_id', 'source', 'run_id', 'evaluation_case_ids']) assert.equal(ui.tasks[0].context[key], undefined)
      assert.equal(ui.calls.some(call => call.method === 'agents/list' || call.method === 'agents/detail'), false)
    } finally { ui.cleanup() }
  }
})

test('空白快捷任务先查询信息与确认范围，再执行实际操作', async () => {
  const build = homeTaskRequest('build', '')
  assert.match(build.prompt, /业务智能体的用途/); assert.match(build.prompt, /经确认再创建、评测和交付/)
  const evaluation = homeTaskRequest('evaluate', '  ')
  assert.match(evaluation.prompt, /查询当前工作区/); assert.match(evaluation.prompt, /智能体、版本、已有测试用例和运行记录/)
  assert.match(evaluation.prompt, /集中询问必要信息/); assert.match(evaluation.prompt, /固定来源版本、测试用例和评判口径/)
  assert.match(evaluation.prompt, /整体确认后开展真实评测/); assert.match(evaluation.prompt, /缺少用例或运行条件/)
  assert.equal(evaluation.context.workflow, 'evaluation')
  const improvement = homeTaskRequest('improve', '')
  assert.match(improvement.prompt, /查询当前工作区/); assert.match(improvement.prompt, /原始证据与评判口径/)
  assert.match(improvement.prompt, /整体确认/); assert.match(improvement.prompt, /最多 3 轮“分析问题→修改→复测”/); assert.match(improvement.prompt, /达到预算时如实停止/)
  assert.equal(improvement.context.workflow, 'improvement'); assert.equal(improvement.context.max_repair_rounds, 3)
  const manage = homeTaskRequest('manage', '')
  assert.match(manage.prompt, /实例与 MCP 工具状态/); assert.match(manage.prompt, /任何写操作须经确认/)
  for (const [label, action, request] of [['构建智能体', '开始构建', build], ['评测效果', '开始评测', evaluation], ['改进能力', '开始改进', improvement], ['管理实例与工具', '开始管理', manage]]) {
    const ui = home({ noRuns: true })
    try {
      await ui.settle()
      await ui.click(label); assert.equal(ui.button(action).props.disabled, false); await ui.submit()
      assert.equal(ui.tasks[0].prompt, request.prompt); assert.deepEqual({ ...ui.tasks[0].context }, request.context)
    } finally { ui.cleanup() }
  }
})

test('首页按实际业务域刷新摘要，助手事件及模式切换不触发选择器数据读取', async () => {
  const ui = home()
  try {
    await ui.settle()
    const count = method => ui.calls.filter(call => call.method === method).length
    const initial = count('home')
    const initialJobs = count('agents/eval/list')
    for (const label of ['构建智能体', '评测效果', '改进能力', '管理实例与工具', '自由咨询']) await ui.click(label)
    for (let index = 0; index < 5; index++) { ui.invalidate(['assistant']); await ui.settle() }
    assert.equal(count('home'), initial)
    assert.equal(count('agents/eval/list'), initialJobs, '助手状态更新不重读评测任务或清空已读取结果')
    for (const domain of ['instances', 'mcp', 'agents', 'catalog']) { ui.invalidate([domain]); await ui.settle() }
    assert.equal(count('home'), initial + 4)
    assert.equal(count('agents/eval/list'), initialJobs + 1)
    assert.equal(count('agents/list'), 0); assert.equal(count('agents/detail'), 0)
  } finally { ui.cleanup() }
})

test('首页摘要后台请求不阻断评测和改进，也不会给任务注入最近运行的对象', async () => {
  let hold = false
  const pending = []
  const ui = home({ intercept(method) {
    if (hold && method === 'home') return new Promise(resolve => pending.push(resolve))
  } })
  try {
    await ui.settle(); hold = true; ui.invalidate(['agents']); await ui.settle()
    assert.equal(pending.length, 1)
    for (const [label, action] of [['评测效果', '开始评测'], ['改进能力', '开始改进']]) {
      await ui.click(label); assert.equal(ui.button(action).props.disabled, false); await ui.submit()
      assert.equal(ui.tasks.at(-1).context.agent_id, undefined); assert.equal(ui.tasks.at(-1).context.run_id, undefined)
    }
    pending[0]({ ok: true, value: { recent_runs: [], instances: { ok: true, value: { instances: [] } }, mcp: { ok: true, value: { connections: [] } } } }); await ui.settle()
    assert.equal(ui.tasks.length, 2)
  } finally { ui.cleanup() }
})

test('体验示例只选择带实际工具和业务Case的来源，缺依赖时明确引导构建', async () => {
  const ui = home({ example: true })
  try {
    await ui.click('体验示例'); assert.ok(ui.button('开始体验')); await ui.click('开始体验')
    const context = ui.tasks[0].context; assert.equal(context.source, 'experiment:EXP-daily-inspection-assistant-002-r222222222222'); assert.equal(context.source_kind, 'basic_mock'); assert.deepEqual(Array.from(context.evaluation_case_ids), ['U-ASSET-PAGES-001']); assert.match(ui.tasks[0].prompt, /不称为真实设备健康检测/)
  } finally { ui.cleanup() }
  for (const options of [{ example: false }, { example: true, exampleCase: false }]) {
    const missing = home(options)
    try { await missing.click('体验示例'); assert.equal(missing.button('开始体验'), undefined); assert.match(missing.text(), /尚未安装带工具的巡检示例/); await missing.click('构建一个基础示例'); assert.match(missing.label('业务任务').props.value, /不连接外部设备/); assert.equal(missing.tasks.length, 0) } finally { missing.cleanup() }
  }
})


test('多版本示例默认使用具工具和Case的启用来源，版本切换可选且启动前回读', async () => {
  const active = 'EXP-daily-inspection-assistant-003-r333333333333'
  for (const selectedActive of [active, null, 'EXP-daily-inspection-assistant-001-r111111111111']) {
    const ui = home({ example: true, exampleExtra: true, exampleActive: selectedActive })
    try {
      await ui.click('体验示例')
      const expected = selectedActive === active ? active : 'EXP-daily-inspection-assistant-002-r222222222222'
      assert.equal(ui.label('巡检示例版本').props.value, `experiment:${expected}`)
      assert.equal(ui.button('开始体验').props.disabled, false)
      assert.equal(ui.label('可选示例版本').type, 'details'); assert.equal(ui.label('可选示例版本').props.open, undefined)
      if (selectedActive === active) assert.match(ui.text(), /版本 003（当前启用）/)
      const before = ui.calls.filter(call => call.method === 'agents/detail' && call.body.experiment_id === expected).length
      await ui.click('开始体验')
      assert.equal(ui.tasks[0].context.source, `experiment:${expected}`)
      assert.equal(ui.calls.filter(call => call.method === 'agents/detail' && call.body.experiment_id === expected).length, before + 1)
    } finally { ui.cleanup() }
  }
  const ui = home({ example: true, exampleExtra: true, exampleActive: active })
  try {
    await ui.click('体验示例'); ui.change('巡检示例版本', 'experiment:EXP-daily-inspection-assistant-002-r222222222222')
    await ui.click('开始体验'); assert.equal(ui.tasks[0].context.experiment_id, 'EXP-daily-inspection-assistant-002-r222222222222')
  } finally { ui.cleanup() }
})


test('首页输入时保持换行与IME行为，Ctrl+Enter仍提交当前模式草稿', async () => {
  const ui = home()
  try {
    await ui.settle(); ui.change('业务任务', '第一行\n第二行')
    let prevented = 0
    const event = (ctrlKey, composing) => ({ key: 'Enter', ctrlKey, nativeEvent: { isComposing: composing }, preventDefault() { prevented++ } })
    ui.label('业务任务').props.onKeyDown(event(false, false)); await ui.settle()
    ui.label('业务任务').props.onKeyDown(event(true, true)); await ui.settle()
    assert.equal(prevented, 0); assert.equal(ui.tasks.length, 0)
    ui.label('业务任务').props.onKeyDown(event(true, false)); await ui.settle()
    assert.equal(prevented, 1); assert.equal(ui.tasks.length, 1); assert.equal(ui.tasks[0].prompt, '第一行\n第二行')
  } finally { ui.cleanup() }
})


test('四类快捷任务与自由咨询各自保留草稿，示例来源不带入评测', async () => {
  const ui = home({ example: true })
  try {
    await ui.settle()
    ui.change('业务任务', '咨询草稿')
    for (const [label, prompt] of [['构建智能体', '构建草稿'], ['评测效果', '评测草稿'], ['改进能力', '改进草稿'], ['管理实例与工具', '管理草稿']]) {
      await ui.click(label); ui.change('业务任务', prompt)
    }
    for (const [label, prompt] of [['自由咨询', '咨询草稿'], ['构建智能体', '构建草稿'], ['评测效果', '评测草稿'], ['改进能力', '改进草稿'], ['管理实例与工具', '管理草稿']]) {
      await ui.click(label); assert.equal(ui.label('业务任务').props.value, prompt)
    }
    await ui.click('体验示例'); await ui.click('开始体验')
    assert.equal(ui.tasks[0].context.experiment_id, 'EXP-daily-inspection-assistant-002-r222222222222')
    await ui.click('评测效果'); await ui.submit()
    assert.equal(ui.tasks[1].prompt, '评测草稿')
    assert.equal(ui.tasks[1].context.agent_id, undefined); assert.equal(ui.tasks[1].context.experiment_id, undefined); assert.equal(ui.tasks[1].context.source, undefined)
  } finally { ui.cleanup() }
})

test('首页模式和五种输入在页面重载后按账号与工作区恢复，成功进入任务只清理对应草稿', async () => {
  const storage = memoryStorage()
  const first = home({ storage })
  try {
    await first.settle()
    first.change('业务任务', '咨询草稿')
    for (const [label, prompt] of [['构建智能体', '构建草稿'], ['评测效果', '评测草稿'], ['改进能力', '改进草稿'], ['管理实例与工具', '管理草稿']]) {
      await first.click(label); first.change('业务任务', prompt)
    }
    assert.equal(storage.values.size, 1)
  } finally { first.cleanup() }

  const reloaded = home({ storage })
  try {
    await reloaded.settle()
    assert.equal(reloaded.button('管理实例与工具').props['aria-pressed'], true)
    assert.equal(reloaded.label('业务任务').props.value, '管理草稿')
    await reloaded.click('自由咨询')
    assert.equal(reloaded.label('业务任务').props.value, '咨询草稿')
    for (const [label, prompt] of [['构建智能体', '构建草稿'], ['评测效果', '评测草稿'], ['改进能力', '改进草稿'], ['管理实例与工具', '管理草稿']]) {
      await reloaded.click(label); assert.equal(reloaded.label('业务任务').props.value, prompt)
    }
    await reloaded.click('评测效果'); await reloaded.submit()
    assert.equal(reloaded.tasks[0].prompt, '评测草稿')
  } finally { reloaded.cleanup() }

  const afterSubmit = home({ storage })
  try {
    await afterSubmit.settle()
    assert.equal(afterSubmit.button('评测效果').props['aria-pressed'], true)
    await afterSubmit.click('评测效果'); assert.equal(afterSubmit.label('业务任务').props.value, '')
    await afterSubmit.click('自由咨询'); assert.equal(afterSubmit.label('业务任务').props.value, '咨询草稿')
    await afterSubmit.click('构建智能体'); assert.equal(afterSubmit.label('业务任务').props.value, '构建草稿')
    await afterSubmit.click('改进能力'); assert.equal(afterSubmit.label('业务任务').props.value, '改进草稿')
    await afterSubmit.click('管理实例与工具'); assert.equal(afterSubmit.label('业务任务').props.value, '管理草稿')
  } finally { afterSubmit.cleanup() }

  for (const identity of [{ username: 'other' }, { workspaceRoot: '/other-assets' }, { workspaceId: 'other-workspace' }]) {
    const isolated = home({ storage, ...identity })
    try { await isolated.settle(); assert.equal(isolated.label('业务任务').props.value, ''); await isolated.click('构建智能体'); assert.equal(isolated.label('业务任务').props.value, '') }
    finally { isolated.cleanup() }
  }
})

test('首页任务启动失败保留刷新可恢复的输入；账号无法核实时提示无法自动保存', async () => {
  const storage = memoryStorage()
  const failed = home({ storage, failStart: true })
  try {
    await failed.settle(); failed.change('业务任务', '失败后继续的内容'); await failed.submit()
    assert.match(failed.text(), /会话服务暂不可用/)
  } finally { failed.cleanup() }
  const reloaded = home({ storage })
  try { await reloaded.settle(); assert.equal(reloaded.label('业务任务').props.value, '失败后继续的内容') }
  finally { reloaded.cleanup() }
  const unknownAccount = home({ storage, accountError: true })
  try { await unknownAccount.settle(); assert.match(unknownAccount.text(), /当前输入无法自动保存/); assert.equal(unknownAccount.label('业务任务').props.value, '') }
  finally { unknownAccount.cleanup() }
})

test('工作区来源变化时立即隐藏旧草稿，回到原工作区才恢复对应输入', async () => {
  const storage = memoryStorage()
  const ui = home({ storage })
  try {
    await ui.settle(); ui.change('业务任务', '原工作区的任务')
    ui.switchWorkspace('/other-assets', 'other-workspace')
    assert.equal(ui.label('业务任务').props.value, '')
    assert.equal(ui.label('业务任务').props.disabled, true)
    await ui.settle(); assert.equal(ui.label('业务任务').props.value, '')
    ui.switchWorkspace('/test-assets', 'workspace-test')
    await ui.settle(); assert.equal(ui.label('业务任务').props.value, '原工作区的任务')
  } finally { ui.cleanup() }
})

test('引导卡填写示例任务只预填输入，不自动运行', async () => {
  const ui = home()
  try {
    await ui.settle()
    await ui.click('填写示例任务')
    assert.match(ui.label('业务任务').props.value, /不连接外部设备/)
    assert.equal(ui.button('开始构建').props.disabled, false)
    assert.equal(ui.tasks.length, 0)
  } finally { ui.cleanup() }
})
