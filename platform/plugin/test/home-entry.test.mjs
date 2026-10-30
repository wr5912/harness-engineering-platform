import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import { GENERAL_PLACEHOLDER, HOME_SUBTITLE, PLATFORM_SLOGAN, homeTaskRequest } from '../src/home-entry.ts'
import { createPlatformUpdates } from '../src/realtime/client.ts'

const require = createRequire(import.meta.url)
const compile = async entry => (await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.svg': 'dataurl' }, external: ['react', 'react/jsx-runtime', 'react-dom/server', '@deepseek-ai/dsh-client-ui-primitives'] })).outputFiles[0].text
const homeSource = await compile('../src/home.tsx'), loginSource = await compile('../src/login.tsx')
const experiment = 'EXP-alpha-001-r123456abcdef'
const runId = 'run-12345678-1234-4234-8234-123456789abc'
function memoryStorage() {
  const values = new Map()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
function localClock(initial = Date.parse('2026-10-29T08:00:00Z')) {
  let now = initial, nextId = 0
  const timers = new Map()
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  return { Date: ClockDate, now: () => now, pending: () => timers.size,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    advance(duration) { now += duration; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback() } },
  }
}
function home({ example = false, exampleCase = true, exampleExtra = false, exampleActive = 'EXP-daily-inspection-assistant-002-r222222222222', noRuns = false, runVerdict = 'passed', runStatus = 'completed', runsFixture, failStart = false, sessionFixture, jobsFixture = [], active = true, intercept, storage = memoryStorage(), username = 'admin', workspaceRoot = '/test-assets', workspaceId = 'workspace-test', accountError = false, clock, beforeStart } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], tasks = [], navigations = [], assistantSelections = [], projectionRefreshes = []
  let cursor = 0, effects = [], changed = false, tree
  const react = { ...require('react'),
    useRef(initial) { const key = cursor++; if (!(key in states)) states[key] = { current: initial }; return states[key] },
    useState(initial) { const key = cursor++; if (!(key in states)) states[key] = initial; return [states[key], next => { const value = typeof next === 'function' ? next(states[key]) : next; if (!Object.is(states[key], value)) { states[key] = value; changed = true } }] },
    useEffect(effect, values) { const key = cursor++; if (!dependencies[key] || values.some((value, at) => value !== dependencies[key][at])) { dependencies[key] = values; effects.push(() => { cleanups[key]?.(); cleanups[key] = effect() }) } },
    useSyncExternalStore(_subscribe, get) { return get() },
  }
  react.useLayoutEffect = react.useEffect
  const primitives = { Menu(props) { return react.createElement('span', null, props.anchor, props.open ? react.createElement('div', { role: 'menu' }, props.items.map(item => react.createElement('button', { key: item.id, type: 'button', role: 'menuitem', onClick: () => props.onSelect(item.id) }, item.label))) : null) } }
  const navigationListeners = new Map()
  const browserWindow = { setTimeout: clock?.setTimeout ?? setTimeout, clearTimeout: clock?.clearTimeout ?? clearTimeout,
    addEventListener(type, fn) { if (!navigationListeners.has(type)) navigationListeners.set(type, new Set()); navigationListeners.get(type).add(fn) }, removeEventListener(type, fn) { navigationListeners.get(type)?.delete(fn) } }
  const module = { exports: {} }
  vm.runInNewContext(homeSource, { module, exports: module.exports, Error, Date: clock?.Date ?? Date, sessionStorage: storage, window: browserWindow, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name) })
  let inventory = { root: workspaceRoot, workspace: { id: workspaceId, legacyRoots: [] }, observed_at: '2026-10-16T00:00:00Z', agents: [{ id: 'alpha' }, ...(example ? [{ id: 'daily-inspection-assistant' }] : [])], experiments: [], runs: [] }
  const updates = createPlatformUpdates()
  const sessionSnapshot = sessionFixture ?? { ids: [], byId: {}, projectionsBySession: {}, phase: 'ready' }
  const props = { active, catalog: { subscribe() { return () => {} }, getSnapshot() { return { status: 'ready', inventory } }, refresh: async () => {} },
    sessions: { list: { subscribe() { return () => {} }, getSnapshot() { return sessionSnapshot } }, refresh: async () => {}, refreshProjections: async id => { projectionRefreshes.push(id) } },
    assistant: { select: async id => { assistantSelections.push(id) } },
    updates, navigate: target => navigations.push(target),
    startConversation: async (root, prompt, context) => { await beforeStart?.(); if (failStart) throw new Error('会话服务暂不可用'); tasks.push({ root, prompt, context }) },
    rpc: { call: async (_channel, method, body) => {
      calls.push({ method, body })
      const intercepted = intercept?.(method, body)
      if (intercepted !== undefined) return await intercepted
      if (method === 'auth/current') return accountError ? { ok: false, error: { message: '账号暂不可读' } } : { ok: true, value: { username } }
      if (method === 'home') return { ok: true, value: { recent_runs: runsFixture ?? (noRuns ? [] : [{ id: runId, agent_id: 'alpha', experiment_id: experiment, status: runStatus, effective_verdict: runVerdict, created_at: '2026-10-16T00:00:00Z' }]), instances: { ok: true, value: { instances: [] } }, mcp: { ok: true, value: { connections: [] } } } }
      if (method === 'mcp/control/status') return { ok: true, value: { configuration: { riskAssessment: { configured: true } }, riskFacts: [] } }
      if (method === 'agents/eval/list') return { ok: true, value: { jobs: jobsFixture } }
      if (method === 'agents/list') return { ok: true, value: { agents: [{ id: 'alpha', name: '行业简报助手' }] } }
      if (method === 'agents/detail') return { ok: true, value: { agent: { id: body.agent_id, manifest: { active_experiment: body.agent_id === 'daily-inspection-assistant' ? exampleActive : body.experiment_id || experiment } }, experiment: { id: body.experiment_id || experiment }, selection: { basis: body.experiment_id ? 'explicit' : 'active_experiment' }, versions: [{ id: body.experiment_id || experiment }], evaluation: { cases: body.agent_id === 'daily-inspection-assistant' ? exampleCase ? [{ id: 'U-ASSET-PAGES-001' }] : [] : [{ id: 'U-BUSINESS-001' }] } } }
      if (method === 'agents/tasks/capabilities') return { ok: true, value: { sources: [{ source: 'experiment:EXP-daily-inspection-assistant-001-r111111111111', experiment_id: 'EXP-daily-inspection-assistant-001-r111111111111', plugins: [] }, { source: 'experiment:EXP-daily-inspection-assistant-002-r222222222222', experiment_id: 'EXP-daily-inspection-assistant-002-r222222222222', plugins: [{ plugin_names: ['/opt/dsh-managed/task-example-tools.mjs'] }] }, ...(exampleExtra ? [{ source: 'experiment:EXP-daily-inspection-assistant-003-r333333333333', experiment_id: 'EXP-daily-inspection-assistant-003-r333333333333', plugins: [{ plugin_names: ['/opt/dsh-managed/task-example-tools.mjs'] }] }] : [])] } }
      throw new Error(`unexpected RPC ${method}`)
    } },
  }
  function render() { let iteration = 0; do { if (++iteration > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.HomePage(props); effects.forEach(effect => effect()) } while (changed); return tree }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; if (value.type === primitives.Menu || value.type?.name === 'LoadingIndicator') return [value, ...nodes(value.type(value.props))]; return [value, ...nodes(value.props?.children)] }
  function text(value) { if (!arguments.length) value = tree; if (typeof value === 'boolean') return ''; if (value?.type === primitives.Menu) return text(value.type(value.props)); return Array.isArray(value) ? value.map(item => text(item)).join('') : value && typeof value === 'object' ? text(value.props?.children ?? '') : String(value ?? '') }
  const button = title => nodes().find(node => node.type === 'button' && text(node).trim().replace(' →', '') === title)
  const label = title => nodes().find(node => node.props?.['aria-label'] === title)
  async function settle() { for (let step = 0; step < 8; step++) { render(); await new Promise(resolve => setImmediate(resolve)) }; render() }
  const change = (title, value) => { label(title).props.onChange({ target: { value } }); render() }
  const click = async title => { const found = button(title); assert.ok(found, `missing button ${title}`); await found.props.onClick?.(); await settle() }
  const submit = async () => { nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle() }
  render()
  return { settle, nodes, text, calls, tasks, navigations, assistantSelections, projectionRefreshes, button, label, change, click, submit, invalidate: updates.invalidate, menu: () => nodes().find(node => node.type === primitives.Menu), dispatchNavigation: type => navigationListeners.get(type)?.forEach(fn => fn()), setActive(value) { props.active = value; render() },
    switchWorkspace(root, id) { inventory = { ...inventory, root, workspace: { ...inventory.workspace, id } }; render() },
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()) }
}

test('继续工作回到原 Session 和原 Job，不创建第二个任务', async () => {
  const sessionId = 'session-original'
  const jobId = '550e8400-e29b-41d4-a716-446655440000'
  const ui = home({ sessionFixture: { ids: [sessionId], byId: { [sessionId]: { cwd: '/test-assets', updatedAt: Date.now(), displayTitle: '完成原评测',
    projectionValues: { harnessPlatformAssistant: { session_id: sessionId, workspace_id: 'workspace-test', pending_proposals: 1 } } } }, projectionsBySession: {}, phase: 'ready' },
    jobsFixture: [{ job_id: jobId, source: `experiment:${experiment}`, agent_id: 'alpha', experiment_id: experiment, status: 'running' }] })
  try {
    await ui.settle()
    assert.match(ui.text(), /完成原评测/)
    assert.match(ui.text(), /待确认/)
    await ui.click('继续原会话')
    assert.deepEqual(ui.assistantSelections, [sessionId])
    assert.equal(ui.navigations.at(-1), 'conversations')
    await ui.click('查看任务')
    assert.equal(ui.navigations.at(-1).job_id, jobId)
    assert.equal(ui.navigations.at(-1).tab, 'jobs')
    assert.equal(ui.tasks.length, 0)
  } finally { ui.cleanup() }
})

test('继续处理使用原生会话运行状态与操作投影，完成且无待办的会话不重复呈现', async () => {
  const ids = ['native-running', 'native-unknown', 'native-idle']
  const ui = home({ noRuns: true, sessionFixture: { ids, phase: 'ready', projectionsBySession: {},
    byId: Object.fromEntries(ids.map((id, index) => [id, { cwd: '/test-assets', updatedAt: Date.now() - index * 1000,
      running: index === 0, displayTitle: id, projectionValues: { harnessPlatformAssistant: { session_id: id, workspace_id: 'workspace-test', ...(index === 1 ? { unknown_proposals: 1 } : {}) } } }])) } })
  try {
    await ui.settle()
    const rows = ui.nodes().filter(node => node.props?.className === 'harness-continue-item')
    assert.equal(rows.length, 2)
    assert.match(ui.text(rows[0]), /native-unknown.*操作待核对/s)
    assert.match(ui.text(rows[1]), /native-running.*运行中/s)
    assert.doesNotMatch(ui.text(), /native-idle/)
    assert.equal(ui.tasks.length, 0)
  } finally { ui.cleanup() }
})

test('首页风险概况只汇总有效事实，读取失败和过期分别提示', async () => {
  const base = { id: 'risk-1', version: 1, scope: {}, source: 'fixture', signals: [], observedAt: new Date(Date.now() - 60_000).toISOString() }
  const active = home({ intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { configuration: { riskAssessment: { configured: true } }, riskFacts: [
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
  const expired = home({ intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { configuration: { riskAssessment: { configured: true } }, riskFacts: [
    { ...base, status: 'assessed', level: 'low', expiresAt: new Date(Date.now() - 1_000).toISOString() },
  ] } } } })
  try { await expired.settle(); assert.match(expired.text(), /网关风险评估.*评估已过期/s) } finally { expired.cleanup() }
  const failed = home({ intercept(method) { if (method === 'mcp/control/status') return { ok: false, error: { message: '读取失败' } } } })
  try { await failed.settle(); assert.match(failed.text(), /网关风险评估.*读取失败/s) } finally { failed.cleanup() }
})

test('首页风险事实自然过期时本地更新，依次转移有效范围且不发起请求', async () => {
  const clock = localClock(), base = { version: 1, scope: {}, status: 'assessed', source: 'fixture', signals: [], observedAt: new Date(clock.now()).toISOString() }
  const ui = home({ clock, intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { configuration: { riskAssessment: { configured: true } }, riskFacts: [
    { ...base, id: 'high', level: 'high', expiresAt: new Date(clock.now() + 1000).toISOString() },
    { ...base, id: 'low', level: 'low', expiresAt: new Date(clock.now() + 3000).toISOString() },
  ] } } } })
  try {
    await ui.settle()
    const requests = ui.calls.length
    assert.match(ui.text(), /网关风险评估.*存在高风险.*2 项有效范围/s)
    assert.equal(clock.pending(), 1)
    clock.advance(1001); await ui.settle()
    assert.match(ui.text(), /网关风险评估.*已评估.*1 项有效范围，1 项已过期/s)
    assert.equal(clock.pending(), 1, '只等待下一个尚未到期的事实')
    clock.advance(2000); await ui.settle()
    assert.match(ui.text(), /网关风险评估.*评估已过期.*2 项历史事实需重新核对/s)
    assert.equal(clock.pending(), 0, '全部到期后不再安排忙轮询')
    assert.equal(ui.calls.length, requests, '自然过期只重绘，不触发RPC')
  } finally { ui.cleanup() }
})

test('首页不可见时取消风险到期计时，恢复时直接显示正确时效', async () => {
  const clock = localClock(), expiresAt = new Date(clock.now() + 1000).toISOString()
  const ui = home({ clock, active: false, intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { configuration: { riskAssessment: { configured: true } }, riskFacts: [{ id: 'low', status: 'assessed', level: 'low', expiresAt }] } } } })
  try {
    await ui.settle()
    assert.equal(clock.pending(), 0)
    ui.setActive(true); await ui.settle()
    const requests = ui.calls.length
    assert.equal(clock.pending(), 1)
    ui.setActive(false); await ui.settle()
    assert.equal(clock.pending(), 0)
    clock.advance(1001); ui.setActive(true); await ui.settle()
    assert.match(ui.text(), /网关风险评估.*评估已过期/s)
    assert.equal(clock.pending(), 0)
    assert.equal(ui.calls.length, requests)
  } finally { ui.cleanup() }
})

test('新的风险事实替换旧到期计时，无未来有效期时不继续计时', async () => {
  const clock = localClock()
  let facts = [{ id: 'risk', status: 'assessed', level: 'low', expiresAt: new Date(clock.now() + 1000).toISOString() }]
  const ui = home({ clock, intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { configuration: { riskAssessment: { configured: true } }, riskFacts: facts } } } })
  try {
    await ui.settle(); assert.equal(clock.pending(), 1)
    facts = [{ ...facts[0], expiresAt: new Date(clock.now() + 3000).toISOString() }]
    ui.invalidate(['mcp']); await ui.settle()
    assert.equal(clock.pending(), 1)
    const requests = ui.calls.length
    clock.advance(1001); await ui.settle()
    assert.match(ui.text(), /网关风险评估.*已评估/s)
    assert.equal(clock.pending(), 1, '旧有效期对应的计时已取消')
    clock.advance(2000); await ui.settle()
    assert.match(ui.text(), /网关风险评估.*评估已过期/s)
    assert.equal(clock.pending(), 0)
    assert.equal(ui.calls.length, requests)
    facts = [{ ...facts[0], expiresAt: 'invalid' }]
    ui.invalidate(['mcp']); await ui.settle()
    assert.equal(clock.pending(), 0, '未知有效期不安排忙轮询')
    facts = []
    ui.invalidate(['mcp']); await ui.settle()
    assert.equal(clock.pending(), 0)
    assert.match(ui.text(), /网关风险评估.*尚无评估/s)
  } finally { ui.cleanup() }
})

test('首页按同一回执的风险开关显示模式，关闭时有效旧事实不冒充当前评估', async () => {
  const clock = localClock(), facts = [{ id: 'high', status: 'assessed', level: 'high', expiresAt: new Date(clock.now() + 60_000).toISOString() }]
  let hold = false, resolve
  const ui = home({ clock, intercept(method) { if (method === 'mcp/control/status') return hold ? new Promise(done => { resolve = done })
    : { ok: true, value: { configuration: { riskAssessment: { configured: true } }, riskFacts: facts } } } })
  const riskText = () => ui.text(ui.nodes().find(node => node.props?.className === 'harness-stat' && ui.text(node).includes('网关风险评估')))
  try {
    await ui.settle()
    assert.match(riskText(), /存在高风险/)
    assert.equal(clock.pending(), 1)
    hold = true; ui.invalidate(['mcp']); await ui.settle()
    assert.match(riskText(), /存在高风险.*上次读取/s, '刷新期间保留同一观察中的模式和事实')
    resolve({ ok: true, value: { configuration: { riskAssessment: { configured: false } }, riskFacts: facts } }); await ui.settle()
    assert.match(riskText(), /自动评估已关闭.*按访问策略和人工限制执行/s)
    assert.doesNotMatch(riskText(), /已评估|存在高风险/)
    assert.equal(clock.pending(), 0, '关闭评估不再为旧事实安排计时')
    const requests = ui.calls.length
    clock.advance(1001); await ui.settle()
    assert.equal(ui.calls.length, requests)
    ui.invalidate(['mcp']); await ui.settle()
    assert.match(riskText(), /自动评估已关闭.*上次读取/s)
    assert.equal(clock.pending(), 0)
    resolve({ ok: false, error: { message: '模式暂不可读' } }); await ui.settle()
    assert.match(riskText(), /读取失败/)
    assert.doesNotMatch(riskText(), /自动评估已关闭/)
    assert.equal(clock.pending(), 0)
  } finally { ui.cleanup() }
})

test('首页风险回执缺少明确开关时保留待核对，不能据旧事实推断已启用', async () => {
  for (const configuration of [undefined, { riskAssessment: {} }, { riskAssessment: { configured: 'true' } }]) {
    const clock = localClock()
    const ui = home({ clock, intercept(method) { if (method === 'mcp/control/status') return { ok: true, value: { configuration, riskFacts: [
      { id: 'low', status: 'assessed', level: 'low', expiresAt: new Date(clock.now() + 60_000).toISOString() },
    ] } } } })
    try {
      await ui.settle()
      const risk = ui.nodes().find(node => node.props?.className === 'harness-stat' && ui.text(node).includes('网关风险评估'))
      assert.match(ui.text(risk), /评估开关待核对.*核对评估配置/s)
      assert.doesNotMatch(ui.text(risk), /已评估|自动评估已关闭/)
      assert.equal(clock.pending(), 0)
    } finally { ui.cleanup() }
  }
})

test('继续工作读取较早待确认会话，跨会话与 Job 按待处理优先级排列', async () => {
  const ids = Array.from({ length: 13 }, (_, index) => `session-${index}`)
  const byId = Object.fromEntries(ids.map((id, index) => [id, { cwd: '/test-assets', updatedAt: Date.now() - index * 1000,
    displayTitle: `会话 ${index}`, projectionValues: { harnessPlatformAssistant: { session_id: id, workspace_id: 'workspace-test',
      ...(index === 12 ? { pending_proposals: 1 } : {}) } } }]))
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
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => !/会话 [0-9](?:\D|$)/.test(ui.text(row))), '已结束且没有待处理操作的原生会话不进入继续处理')
    assert.doesNotMatch(ui.text(), /已显示.*项/)
    assert.ok(ui.menu())
    await ui.click('查看任务')
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
    assert.equal(rows.length, 4, '摘要只展示前四项，同一 Run 合并对应 Job')
    const title = row => ui.nodes(row).find(node => node.props?.className === 'harness-continue-title')
    assert.match(ui.text(title(rows[0])), /行业简报助手.*版本 001 评测.*结果待处理/s)
    assert.match(ui.text(rows[0]), /执行结束.*业务未通过/s)
    assert.match(ui.text(rows[1]), /结论待核实/)
    assert.match(ui.text(rows[2]), /执行失败.*尚无业务结论/s)
    assert.doesNotMatch(ui.text(), /已显示.*项/)
    assert.equal(ui.menu(), undefined, 'Run 与 Job 共用评测记录入口')
    const recent = ui.nodes().find(node => node.props?.className === 'harness-card harness-recent-work')
    const recentRows = ui.nodes(recent).filter(node => node.props?.className === 'harness-run-row')
    assert.equal(recentRows.length, 1)
    assert.doesNotMatch(ui.text(recentRows), /业务未通过|结论待核实|执行失败/)
    const chart = ui.nodes(recent).find(node => node.type?.name === 'DistributionChart')
    assert.equal(chart.props.segments.reduce((sum, item) => sum + item.count, 0), 5, '图表汇总最近去重记录，未重复列出对应Job')
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
    assert.equal(ui.nodes().some(node => node.type?.name === 'DistributionChart'), false, '读取失败不绘制空的结论分布')
  } finally { ui.cleanup() }
})

test('首页评测图只汇总当前最近记录，执行中或执行失败不能被旧结论标为通过', async () => {
  const base = { agent_id: 'alpha', experiment_id: experiment, created_at: '2026-10-16T08:00:00Z' }
  const ui = home({ runsFixture: [
    { ...base, id: 'passed', status: 'completed', effective_verdict: 'passed' },
    { ...base, id: 'passed', status: 'completed', effective_verdict: 'passed' },
    { ...base, id: 'execution-failed', status: 'failed', effective_verdict: 'passed' },
    { ...base, id: 'running', status: 'running', effective_verdict: 'passed' },
    { ...base, id: 'unreviewed', status: 'completed', effective_verdict: null },
    { ...base, id: 'unknown', status: null, effective_verdict: null },
  ] })
  try {
    await ui.settle()
    const chart = ui.nodes().find(node => node.type?.name === 'DistributionChart')
    assert.match(chart.props.description, /当前工作区最近 5 条记录，最多 8 条；不代表累计通过率/)
    assert.deepEqual(Object.fromEntries(chart.props.segments.filter(item => item.count).map(item => [item.key, item.count])), {
      passed: 1, unreviewed: 1, 'execution-failed': 1, unfinished: 1, unknown: 1,
    })
    assert.equal(ui.calls.filter(call => call.method === 'home').length, 1, '图表直接复用首页读取，不新增请求')
  } finally { ui.cleanup() }
})

test('首页突出任务输入、同层快捷入口和继续工作，登录承接品牌口号', async () => {
  const ui = home()
  try { await ui.settle(); assert.match(ui.text(), /用 AI 构建和管理智能体/); assert.ok(ui.text().includes(HOME_SUBTITLE)); assert.equal(ui.label('业务任务').props.placeholder, GENERAL_PLACEHOLDER); assert.equal(ui.label('业务任务').props.rows, 1); assert.equal(ui.button('开始任务').props.disabled, true); assert.equal(ui.text().includes(PLATFORM_SLOGAN), false); assert.ok(ui.nodes().some(node => node.props?.className === 'harness-home-workspace')); assert.ok(ui.nodes().some(node => node.props?.className === 'harness-home-shortcuts')); assert.equal(ui.button('自由咨询'), undefined, '默认输入即自由咨询，不额外占用手机首屏'); const layout = ui.nodes().find(node => node.props?.className === 'harness-home-workspace'); assert.deepEqual(Array.from(layout.props.children, child => child.props.className), ['harness-home-primary', 'harness-home-secondary']); assert.match(ui.text(layout.props.children[0]), /继续处理.*最近评测/s); assert.match(ui.text(layout.props.children[1]), /工作区概况.*从一个可验证的目标开始/s); await ui.click('查看结果'); assert.deepEqual({ ...ui.navigations.at(-1) }, { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: experiment, run_id: runId }) } finally { ui.cleanup() }
  const module = { exports: {} }; vm.runInNewContext(loginSource, { module, exports: module.exports, require })
  const slogan = module.exports.loginPage('/hep/login').match(/<h2>([\s\S]*?)<\/h2>/)?.[1].replace(/<[^>]+>/g, '')
  assert.equal(slogan, PLATFORM_SLOGAN)
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
  assert.match(build.prompt, /业务智能体的用途/); assert.match(build.prompt, /按已有授权创建、评测和交付/)
  const evaluation = homeTaskRequest('evaluate', '  ')
  assert.match(evaluation.prompt, /查询当前工作区/); assert.match(evaluation.prompt, /智能体、版本、已有测试用例和运行记录/)
  assert.match(evaluation.prompt, /集中询问必要信息/); assert.match(evaluation.prompt, /固定来源版本、测试用例和评判口径/)
  assert.match(evaluation.prompt, /整体确认后开展真实评测/); assert.match(evaluation.prompt, /缺少用例或运行条件/)
  assert.equal(evaluation.context.workflow, 'evaluation')
  const improvement = homeTaskRequest('improve', '')
  assert.match(improvement.prompt, /查询当前工作区/); assert.match(improvement.prompt, /原始证据与评判口径/)
  assert.match(improvement.prompt, /明确目标、评测和修改范围后按已有授权改进/); assert.match(improvement.prompt, /依据真实评测结果决定继续或停止/)
  assert.equal(improvement.context.workflow, 'improvement'); assert.equal(improvement.context.max_repair_rounds, undefined)
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


test('首页摘要只显示前四项，单一类型的顶栏查看全部直接导航所属列表', async () => {
  const now = Date.now()
  for (const kind of ['session', 'run', 'job']) {
    const ids = Array.from({ length: 4 }, (_, index) => `more-${kind}-${index}`)
    const ui = home({ noRuns: kind !== 'run',
      ...(kind === 'session' ? { sessionFixture: { ids, phase: 'ready', projectionsBySession: {}, byId: Object.fromEntries(ids.map((id, index) => [id, { cwd: '/test-assets', updatedAt: now - index * 1000, displayTitle: `原管理会话 ${index}`, projectionValues: { harnessPlatformAssistant: { session_id: id, workspace_id: 'workspace-test', pending_proposals: 1 } } }])) } } : {}),
      ...(kind === 'run' ? { runsFixture: ids.map((id, index) => ({ id, agent_id: 'alpha', experiment_id: experiment, status: 'completed', effective_verdict: 'failed', created_at: new Date(now - index * 1000).toISOString() })) } : {}),
      ...(kind === 'job' ? { jobsFixture: ids.map((job_id, index) => ({ job_id, source: `experiment:${experiment}`, agent_id: 'alpha', experiment_id: experiment, status: 'running', updated_at: new Date(now - index * 1000).toISOString() })) } : {}),
    })
    try {
      await ui.settle()
      assert.equal(ui.nodes().filter(node => node.props?.className === 'harness-continue-item').length, 4)
      assert.doesNotMatch(ui.text(), /已显示.*项/)
      assert.equal(ui.nodes().some(node => node.props?.className === 'harness-continue-footer'), false)
      const continuation = ui.label('继续处理')
      assert.equal(ui.nodes(continuation).filter(node => node.type === 'button' && ui.text(node) === '刷新').length, 0)
      const action = ui.nodes(continuation).find(node => node.props?.className === 'harness-home-view-all')
      const recentAction = ui.nodes(ui.label('最近评测')).find(node => node.props?.className === 'harness-home-view-all')
      assert.equal(ui.text(action), '查看全部 →')
      assert.equal(ui.text(recentAction), ui.text(action))
      assert.equal(ui.menu(), undefined)
      await ui.click('查看全部')
      assert.deepEqual(typeof ui.navigations.at(-1) === 'string' ? ui.navigations.at(-1) : { ...ui.navigations.at(-1) }, kind === 'session' ? 'conversations' : { page: 'evaluation', tab: 'runs' })
      assert.equal(ui.assistantSelections.length, 0, '列表入口不擅自选择原会话')
      assert.equal(ui.tasks.length, 0)
    } finally { ui.cleanup() }
  }
})

test('混合摘要的顶栏原生菜单区分管理与评测，关闭和导航保留首页输入', async () => {
  const ids = ['pending-0', 'pending-1', 'pending-2', 'completed-session']
  const ui = home({ runVerdict: 'failed', sessionFixture: { ids, phase: 'ready', projectionsBySession: {}, byId: Object.fromEntries(ids.map((id, index) => [id, { cwd: '/test-assets', updatedAt: Date.now() - index * 1000, displayTitle: `管理任务 ${index}`, projectionValues: { harnessPlatformAssistant: { session_id: id, workspace_id: 'workspace-test', ...(index < 3 ? { pending_proposals: 1 } : {}) } } }])) },
    jobsFixture: [{ job_id: 'hidden-running-job', source: `experiment:${experiment}`, agent_id: 'alpha', experiment_id: experiment, status: 'running', updated_at: new Date().toISOString() }] })
  try {
    await ui.settle()
    const rows = ui.nodes().filter(node => node.props?.className === 'harness-continue-item')
    assert.equal(rows.length, 4)
    assert.ok(rows.slice(0, 3).every(row => ui.text(row).includes('待确认')))
    assert.match(ui.text(rows[3]), /业务未通过/)
    assert.doesNotMatch(ui.text(), /已显示.*项/)
    assert.equal(ui.nodes().some(node => node.props?.className === 'harness-continue-footer'), false)
    const action = () => ui.nodes(ui.label('继续处理')).find(node => node.props?.className === 'harness-home-view-all')
    assert.equal(action().props['aria-haspopup'], 'menu')
    assert.equal(ui.menu().props.portal, undefined, '卡片内菜单直接挂载以保留原生自动聚焦')
    assert.equal(ui.menu().props.autoFocus, true)
    let prevented = false
    action().props.onKeyDown({ key: 'ArrowDown', preventDefault() { prevented = true } }); await ui.settle()
    assert.equal(prevented, true)
    assert.equal(action().props['aria-expanded'], true)
    assert.deepEqual(Array.from(ui.menu().props.items, item => item.label), ['管理对话', '评测记录'])
    ui.menu().props.onClose(); await ui.settle()
    assert.equal(action().props['aria-expanded'], false, '原生菜单 Escape/点击外部回调会关闭 owner 状态')
    for (const event of ['hashchange', 'popstate']) {
      await ui.click('查看全部'); assert.equal(ui.menu().props.open, true)
      ui.dispatchNavigation(event); await ui.settle(); assert.equal(ui.menu().props.open, false)
    }
    await ui.click('查看全部'); assert.equal(ui.menu().props.open, true)
    ui.setActive(false); await ui.settle(); assert.equal(ui.menu().props.open, false)
    ui.setActive(true); await ui.settle(); assert.equal(ui.menu().props.open, false, '重新回首页不自动重开旁路菜单')
    ui.change('业务任务', '保留首页原输入')
    for (const label of ['管理对话', '评测记录']) {
      await ui.click('查看全部'); await ui.click(label)
      assert.equal(ui.menu().props.open, false)
    }
    assert.deepEqual(ui.navigations.map(value => typeof value === 'string' ? value : { ...value }), ['conversations', { page: 'evaluation', tab: 'runs' }])
    assert.equal(ui.label('业务任务').props.value, '保留首页原输入')
    assert.equal(ui.tasks.length, 0)
  } finally { ui.cleanup() }
})

test('摘要不显示计数尾栏，未知 Run 仍保留原结果说明', async () => {
  const ui = home({ runVerdict: null })
  try {
    await ui.settle()
    assert.equal(ui.nodes().filter(node => node.props?.className === 'harness-continue-item').length, 1)
    assert.match(ui.text(), /结论待核对.*业务结论未知/s)
    assert.equal(ui.nodes().some(node => node.props?.className === 'harness-continue-footer'), false)
    assert.ok(ui.button('查看结果'))
  } finally { ui.cleanup() }
  const empty = home({ noRuns: true })
  try {
    await empty.settle()
    assert.match(empty.text(), /暂无需要继续的任务/)
    assert.equal(empty.nodes().some(node => node.props?.className === 'harness-continue-footer'), false)
  } finally { empty.cleanup() }
})

test('最近评测摘要仍限两条，查看全部直达混合评测记录且不用内部滚动容器', async () => {
  const ui = home({ runsFixture: Array.from({ length: 5 }, (_, index) => ({ id: `passed-run-${index}`, agent_id: 'alpha', experiment_id: experiment, status: 'completed', effective_verdict: 'passed', created_at: new Date(Date.now() - index * 1000).toISOString() })) })
  try {
    await ui.settle()
    const recent = ui.label('最近评测')
    assert.equal(ui.nodes(recent).filter(node => node.props?.className === 'harness-run-row').length, 2)
    assert.equal(ui.nodes(recent).some(node => node.props?.className === 'harness-table-scroll'), false)
    const recordAction = ui.nodes(recent).find(node => node.props?.className === 'harness-run-action')
    assert.equal(ui.text(recordAction), '查看结果')
    recordAction.props.onClick(); await ui.settle()
    assert.equal(ui.navigations.at(-1).run_id, 'passed-run-0')
    const allAction = ui.nodes(recent).find(node => node.props?.className === 'harness-home-view-all')
    allAction.props.onClick(); await ui.settle()
    assert.deepEqual({ ...ui.navigations.at(-1) }, { page: 'evaluation', tab: 'runs' })
  } finally { ui.cleanup() }
})

test('摘要刷新保留条目和已知数字，加载状态不插入正文且失败后可见', async () => {
  let hold = false
  const pending = new Map()
  const ui = home({ runVerdict: 'failed', jobsFixture: [{ job_id: 'job-active', status: 'running', agent_id: 'alpha', experiment_id: experiment }],
    intercept(method) { if (hold && ['home', 'agents/eval/list', 'mcp/control/status'].includes(method)) return new Promise(resolve => pending.set(method, resolve)) } })
  try {
    await ui.settle()
    const entries = () => ui.nodes(ui.label('继续处理')).filter(node => node.props?.className === 'harness-continue-item')
    const before = entries().map(node => ui.text(node))
    const stats = () => ui.nodes().filter(node => node.props?.className === 'harness-stat')
    const values = stats().map(node => ui.text(ui.nodes(node).find(child => child.type === 'strong')))
    const chart = () => ui.nodes().find(node => node.type?.name === 'DistributionChart')
    const distribution = JSON.stringify(chart().props.segments)
    hold = true; ui.invalidate(['agents']); await ui.settle()
    assert.equal(ui.label('继续处理').props['aria-busy'], true)
    assert.deepEqual(entries().map(node => ui.text(node)), before)
    assert.deepEqual(stats().map(node => ui.text(ui.nodes(node).find(child => child.type === 'strong'))), values)
    assert.equal(JSON.stringify(chart().props.segments), distribution)
    assert.match(chart().props.description, /保留上次读取，更新中/)
    assert.equal(ui.nodes(ui.label('最近评测')).some(node => node.props?.['aria-label'] === '读取最近评测'), false)
    assert.equal(ui.nodes(ui.label('继续处理')).some(node => node.type === 'p' && node.props?.role === 'status'), false)
    assert.ok(ui.nodes(ui.label('继续处理')).some(node => node.props?.role === 'status' && node.props['aria-label'] === '更新继续处理事项'))
    assert.doesNotMatch(ui.text(), /正在读取已有会话|正在读取 Run|正在更新，显示/)
    pending.get('home')({ ok: false, error: { message: '上游暂不可用' } })
    pending.get('agents/eval/list')({ ok: false, error: { message: '任务列表失败' } })
    pending.get('mcp/control/status')({ ok: false, error: { message: '风险读取失败' } })
    await ui.settle()
    assert.equal(ui.label('继续处理').props['aria-busy'], false)
    assert.match(ui.text(), /上游暂不可用.*继续处理暂无法核对全部结果/s)
    assert.match(ui.text(), /任务列表失败/)
    assert.doesNotMatch(ui.text(ui.label('继续处理')), /暂无需要继续的任务/)
    assert.equal(JSON.stringify(chart().props.segments), distribution)
    assert.match(chart().props.description, /上次读取，当前更新失败/)
  } finally { ui.cleanup() }
})

test('首页隐藏只记脏，首次慢请求及在途通知共用单批刷新，恢复补一次', async () => {
  const waiting = [], endpoints = new Set(['home', 'agents/eval/list', 'mcp/control/status'])
  let slow = true, activeReads = 0, maximum = 0
  const ui = home({ active: false, intercept(method) {
    if (!slow || !endpoints.has(method)) return
    activeReads++; maximum = Math.max(maximum, activeReads)
    return new Promise(resolve => waiting.push(() => { activeReads--; resolve(method === 'home' ? { ok: true, value: { recent_runs: [], instances: { ok: true, value: { instances: [] } }, mcp: { ok: true, value: { connections: [] } } } } : method === 'agents/eval/list' ? { ok: true, value: { jobs: [] } } : { ok: true, value: { riskFacts: [] } }) }))
  } })
  try {
    await ui.settle(); const before = ui.calls.length
    for (let n = 0; n < 3; n++) { ui.invalidate(['agents']); await ui.settle() }
    assert.equal(ui.calls.length, before)
    ui.setActive(true); await ui.settle(); assert.equal(activeReads, 3)
    const started = ui.calls.length
    for (let n = 0; n < 3; n++) { ui.invalidate(['agents']); await ui.settle() }
    assert.equal(ui.calls.length, started)
    slow = false; waiting.splice(0).forEach(release => release()); await ui.settle()
    assert.equal(ui.calls.length, started + 3)
    assert.equal(maximum, 3, '同一批三个不同端点并行，不启动第二批')
    ui.setActive(false); await ui.settle(); const hidden = ui.calls.length
    ui.invalidate(['agents']); ui.invalidate(['instances']); await ui.settle(); assert.equal(ui.calls.length, hidden)
    ui.setActive(true); await ui.settle(); assert.equal(ui.calls.length, hidden + 3)
  } finally { ui.cleanup() }
})

test('首页任务回执迟到时已离开页面不抢回导航，跨工作区不清除新草稿', async () => {
  for (const switchWorkspace of [false, true]) {
    let release
    const ui = home({ beforeStart: () => new Promise(resolve => { release = resolve }) })
    try {
      await ui.settle(); ui.change('业务任务', '原工作区任务'); await ui.submit()
      assert.equal(typeof release, 'function')
      if (switchWorkspace) { ui.switchWorkspace('/other-workspace', 'workspace-other'); await ui.settle(); ui.change('业务任务', '新工作区草稿') }
      else ui.setActive(false)
      release(); await ui.settle()
      assert.equal(ui.navigations.length, 0)
      assert.equal(ui.label('业务任务').props.value, switchWorkspace ? '新工作区草稿' : '')
    } finally { ui.cleanup() }
  }
})
