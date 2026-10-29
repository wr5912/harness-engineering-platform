import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/agents/client.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', 'react-dom'], plugins: [{ name: 'page-components', setup(builder) { builder.onLoad({ filter: /detail-drawer\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function DetailDrawer(p) { return createElement('section', { 'data-drawer-title': p.title }, createElement('button', { type: 'button' }, p.trigger || p.title), p.children) }` })); builder.onLoad({ filter: /search-select\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function SearchSelect(p) { return createElement('select', { 'aria-label': p.label, value: p.value, onChange: e => p.onChange(e.target.value) }, p.options.map(o => createElement('option', { key:o.value, value:o.value }, o.label + ' ' + (o.description || '')))) }` })); builder.onLoad({ filter: /description-client\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function AgentDescriptionPanel(p) { return createElement('div', { 'data-description-version': p.detail.experiment.id }, '版本资料与技能') }` })) } }] })).outputFiles[0].text

function experiments() {
  return ['first-agent', 'second-agent'].flatMap(agentId => [
    { id: `EXP-${agentId}-001`, agent_id: agentId, status: 'completed', change: { baseline_ref: 'none:first-experiment' } },
    { id: `EXP-${agentId}-002`, agent_id: agentId, change_sha256: 'a'.repeat(64), status: agentId === 'first-agent' ? 'active' : 'completed', change: {
      ...(agentId === 'first-agent' ? { variant_name: '资产告警轻量版' } : {}),
      research_question: `${agentId} 的省算力方案`, parent_experiment_id: `EXP-${agentId}-001`, parent_ref: `git:${'b'.repeat(40)}`,
      variant_kind: 'exploratory', compute_variant: { generation: agentId === 'first-agent' ? { mode: 'langgraph-aot', entry_path: 'dsh/managed/compute-workflow/index.ts', source_run_ids: ['run-22222222-2222-4222-8222-222222222222'] } : undefined },
    } },
  ])
}

function detail(agentId = 'first-agent', experimentId = `EXP-${agentId}-002`) {
  return { agent: { id: agentId, name: `名称 ${agentId}`, manifest: { description: '真实用途' } }, experiment: experiments().find(item => item.id === experimentId),
    versions: experiments().filter(item => item.agent_id === agentId).reverse().map(item => ({ id: item.id, status: item.status, baseline_ref: item.change.baseline_ref })), baseline: { ref: 'none:first-experiment' }, fusion: {}, related_references: [],
    declared: { source_contract: {}, loadable_source: {} }, loaded_instance: { status: 'not_queried' }, features: [],
    repo_commit: 'c'.repeat(40), derivation: { parent_experiment_id: experimentId, parent_ref: `git:${'d'.repeat(40)}` },
    verification: { runs: [{ id: 'run-11111111-1111-4111-8111-111111111111', status: 'failed' }] },
    assets: [{ name: 'candidate', path: 'candidate', kind: 'directory', children: [{ name: 'prompt.md', path: 'candidate/prompt.md', kind: 'text' }] }] }
}

function page({ active = true, target, intercept, updates } = {}) {
  const states = [], dependencies = [], cleanups = [], dialogs = new Map(), resolvedComponents = new WeakMap()
  let cursor = 0, effects = [], changed = false, tree, confirm = false
  const calls = [], contexts = [], navigations = [], assistantTasks = [], listeners = new Map(), reveals = []
  const history = [target ?? { page: 'agents' }]
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useMemo(factory, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; states[at] = factory() } return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, URL, require: name => name === 'react' ? react : require(name),
    window: { location: { hostname: '127.0.0.1' }, confirm: () => confirm, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) },
    document: { activeElement: { focus() {} }, getElementById: id => {
      const node = nodes(tree).find(item => item.props?.id === id)
      return node ? { hidden: Boolean(node.props.hidden), focus() { reveals.push(`focus:${id}`) }, scrollIntoView() { reveals.push(`scroll:${id}`) } } : null
    } },
  })
  const props = { active, target, updates, onContext: context => contexts.push(context), onNavigate: value => { const { replace, ...destination } = value; navigations.push(value); if (replace) history[history.length - 1] = destination; else history.push(destination); props.target = destination; props.active = value.page === 'agents'; changed = true }, onAssistant: async (task, context) => { assistantTasks.push({ task, context }) },
    rpc: { async call(channel, endpoint, payload) {
      calls.push({ channel, endpoint, payload })
      const override = intercept?.(endpoint, payload)
      if (override !== undefined) return await override
      if (endpoint === 'agents/list') return { ok: true, value: { agents: ['first-agent', 'second-agent'].map(id => ({ id, name: `名称 ${id}`, version_count: 2, latest_experiment_status: 'active', active_experiment: `EXP-${id}-001` })), experiments: experiments() } }
      if (endpoint === 'agents/detail') return { ok: true, value: detail(payload.agent_id, payload.experiment_id) }
      if (endpoint === 'agents/runs/index') return { ok: true, value: { experiments: ['001', '002'].map(version => ({ experiment_id: `EXP-${payload.agent_id}-${version}`, runs: [{ run_id: 'run-11111111-1111-4111-8111-111111111111', status: 'completed', effective_verdict: 'failed', created_at: '2026-10-20T08:00:00Z' }] })) } }
      if (endpoint === 'agents/runs/show') return { ok: true, value: { run_id: payload.run_id, manifest: { status: 'completed' }, cases: [{ case_id: 'CASE-008', frozen: { title: '完整读取分页台账' }, trials: [{ verdict: 'failed' }] }, { case_id: 'CASE-012', frozen: { title: '台账服务异常处理' }, trials: [{ verdict: 'inconclusive' }] }] } }
      if (endpoint === 'agents/edit/read') return { ok: true, value: { path: payload.path, kind: payload.path === 'candidate' ? 'directory' : 'text', content: '原始正文', sha256: 'a'.repeat(64), size: 12 } }
      if (endpoint === 'agents/edit/apply') return { ok: false, error: { code: 'conflict', message: '内容已变化' } }
      return { ok: true, value: { proposal: null } }
    } },
  }
  function rawNodes(value) { if (Array.isArray(value)) return value.flatMap(rawNodes); if (!value || typeof value !== 'object') return []; return [value, ...rawNodes(value.props?.children)] }
  function render() { let count = 0; do { if (++count > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.AgentsPage(props); for (const node of rawNodes(tree).filter(node => node.type === 'dialog')) { const id = node.props['aria-labelledby']; if (!dialogs.has(id)) dialogs.set(id, { open: false, showModal() { this.open = true }, close() { this.open = false } }); if (node.ref) node.ref.current = dialogs.get(id) }; effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 5; index++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function resolved(value) { if (!resolvedComponents.has(value)) resolvedComponents.set(value, value.type(value.props)); return resolvedComponents.get(value) }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object') return []; if (value.type?.name === 'AssetDiffPanel') return [value]; if (typeof value.type === 'function') return nodes(resolved(value)); return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object') return typeof value.type === 'function' && value.type.name !== 'AssetDiffPanel' ? text(resolved(value)) : text(value.props?.children); return typeof value === 'boolean' ? '' : String(value ?? '') }
  const button = name => nodes().find(node => node.type === 'button' && text(node) === name)
  render()
  return { render, settle, nodes, text, button, calls, contexts, navigations, history, assistantTasks, props, listeners, reveals, dialogs, setConfirm: value => { confirm = value } }
}

test('智能体四个任务页签、搜索与默认最新版本保持登记版本独立', async () => {
  const ui = page()
  await ui.settle()
  assert.deepEqual(ui.nodes().filter(node => node.props?.role === 'tab' && node.props.id?.startsWith('agent-tab-')).map(node => ui.text(node)), ['概览', '描述与技能', 'Harness 资产', '低算力变体'])
  assert.ok(ui.calls.some(call => call.endpoint === 'agents/detail' && call.payload.agent_id === 'first-agent' && call.payload.experiment_id === undefined))
  assert.match(ui.text(ui.render()), /EXP-first-agent-002/)
  assert.ok(ui.nodes().some(node => node.type === 'dd' && ui.text(node) === 'EXP-first-agent-001'))
  const search = ui.nodes().find(node => node.props?.type === 'search')
  search.props.onChange({ target: { value: 'second-agent' } }); ui.render()
  const cards = ui.nodes().filter(node => node.props?.className === 'agent-list-card')
  assert.equal(cards.length, 1)
  assert.match(ui.text(cards[0]), /second-agent/)
  assert.equal(ui.nodes().some(node => node.props?.id === 'agent-panel-evaluation'), false)
})

test('唯一紧凑版本选择器切换查看对象，不更改登记来源', async () => {
  const ui = page(); await ui.settle()
  const selectors = ui.nodes().filter(node => node.type === 'select' && node.props['aria-label'] === '版本')
  assert.equal(selectors.length, 1)
  assert.equal(selectors[0].props.value, 'EXP-first-agent-002')
  selectors[0].props.onChange({ target: { value: 'EXP-first-agent-001' } }); ui.render(); await ui.settle()
  assert.equal(ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '版本').props.value, 'EXP-first-agent-001')
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'agents', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-001', tab: 'overview' })
  assert.equal(ui.calls.some(call => /apply|activate/.test(call.endpoint)), false)
})

test('Run 索引不可读时概览显示读取失败，不把未证实结论当成业务通过', async () => {
  const ui = page({ intercept(endpoint) { if (endpoint === 'agents/runs/index') return { ok: false, error: { code: 'unavailable', message: '索引暂不可读' } } } })
  await ui.settle()
  const current = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.match(ui.text(current), /评测结果读取失败/)
  assert.doesNotMatch(ui.text(current), /业务通过/)
})

test('智能体清单未返回前显示读取状态，不把暂时的零条目当真实空资产', async () => {
  let resolveList
  const pending = page({ intercept(endpoint) {
    if (endpoint === 'agents/list') return new Promise(resolve => { resolveList = resolve })
  } })
  pending.render()
  assert.ok(pending.nodes().some(node => node.props?.role === 'status' && node.props['aria-label'] === '读取智能体列表' && node.props.className.includes('hep-loading-block')))
  assert.doesNotMatch(pending.text(pending.render()), /正在读取|正在更新/)
  assert.doesNotMatch(pending.text(pending.render()), /尚无智能体资产/)
  assert.match(pending.text(pending.nodes().find(node => node.props?.id === 'agent-list-tab-agents')), /智能体\s*…/)
  resolveList({ ok: true, value: { agents: [], experiments: [] } })
  await pending.settle()
  assert.match(pending.text(pending.render()), /尚无智能体资产/)
  assert.equal(pending.nodes().some(node => node.props?.['aria-label'] === '读取智能体列表'), false)

  const failed = page({ intercept(endpoint) { if (endpoint === 'agents/list') return { ok: false, error: { code: 'unavailable', message: '暂不可用' } } } })
  await failed.settle()
  assert.match(failed.text(failed.render()), /暂不可用/)
  assert.doesNotMatch(failed.text(failed.render()), /尚无智能体资产/)
})

test('窄屏先呈现所选对象，返回列表后可选择另一对象并恢复详情焦点', async () => {
  const ui = page({ target: { page: 'agents', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', tab: 'overview' } })
  await ui.settle()
  const layout = () => ui.nodes().find(node => node.props?.className === 'harness-agent-layout')
  assert.equal(layout().props['data-mobile-list'], false)
  ui.button('← 返回智能体列表').props.onClick(); ui.render()
  assert.equal(layout().props['data-mobile-list'], true)
  assert.ok(ui.reveals.includes('focus:agent-list-card-first-agent'))
  ui.nodes().find(node => node.props?.id === 'agent-list-card-second-agent').props.onClick(); ui.render(); await ui.settle()
  assert.equal(layout().props['data-mobile-list'], false)
  assert.equal(ui.contexts.at(-1).agent_id, 'second-agent')
  assert.ok(ui.reveals.includes('focus:agent-identity'))
})

test('所选版本概览分开显示执行和业务结论，异常用例可回到原 Run', async () => {
  const ui = page()
  await ui.settle()
  const overview = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  const identity = ui.nodes().find(node => node.props?.className === 'agent-identity')
  const panel = ui.nodes().find(node => node.props?.id === 'agent-panel-overview')
  const all = ui.nodes()
  assert.ok(ui.nodes(panel).includes(overview), '所选版本结论位于概览首段')
  assert.ok(ui.nodes(panel).includes(overview), '最近评测位于所选版本概览')
  assert.equal(panel.props.hidden, false)
  assert.ok(all.indexOf(identity) < all.findIndex(node => node.props?.className === 'harness-agent-tabs')
    && all.findIndex(node => node.props?.className === 'harness-agent-tabs') < all.indexOf(overview)
    && all.indexOf(overview) < all.findIndex(node => node.props?.className === 'agent-variant-source'), '版本身份、页签、结论、技术来源依任务顺序呈现')
  assert.match(ui.text(overview), /执行已结束.*业务未通过.*1 项未通过，1 项无法判定.*完整读取分页台账.*台账服务异常处理/s)
  ui.button('查看最近结果').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'evaluation', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', tab: 'runs', run_id: 'run-11111111-1111-4111-8111-111111111111' })
})

test('概览图表限定当前版本，未结束执行不计业务通过，混合与缺失逐例结果独立展示', async () => {
  const currentRuns = [
    { run_id: 'run-current', status: 'running', effective_verdict: 'passed', created_at: '2026-10-29T08:00:00Z' },
    { run_id: 'run-passed', status: 'completed', effective_verdict: 'passed', created_at: '2026-10-28T08:00:00Z' },
    { run_id: 'run-error', status: 'failed', effective_verdict: 'passed', created_at: '2026-10-27T08:00:00Z' },
    { run_id: 'run-unreviewed', status: 'completed', created_at: '2026-10-26T08:00:00Z' },
  ]
  const ui = page({ intercept(endpoint) {
    if (endpoint === 'agents/runs/index') return { ok: true, value: { experiments: [
      { experiment_id: 'EXP-first-agent-001', runs: [{ run_id: 'run-foreign', status: 'completed', effective_verdict: 'passed' }] },
      { experiment_id: 'EXP-first-agent-002', runs: currentRuns },
    ] } }
    if (endpoint === 'agents/runs/show') return { ok: true, value: { run_id: 'run-current', summary: { effective_verdict: 'passed' }, cases: [
      { case_id: 'mixed', frozen: { title: '不同Trial结果' }, trials: [{ verdict: 'passed' }, { verdict: 'failed' }] },
      { case_id: 'pending', trials: [] },
      { case_id: 'reviewed', review: { reviewed_verdict: 'passed' }, trials: [{ verdict: 'failed' }] },
      { case_id: 'inconclusive', trials: [{ verdict: 'inconclusive' }] },
      { case_id: 'failed', trials: [{ verdict: 'failed' }] },
    ] } }
  } })
  await ui.settle()
  const charts = ui.nodes().filter(node => node.type === 'figure' && node.props.className === 'hep-overview-chart')
  const runs = charts.find(node => ui.text(node).includes('版本 Run 分布'))
  const cases = charts.find(node => node.props['data-variant'] === 'case-trend')
  assert.deepEqual(ui.nodes(runs).filter(node => node.type === 'li').map(node => ui.text(node)), ['业务通过1', '结论待核对1', '执行失败1', '运行或待执行1'])
  assert.deepEqual(ui.nodes(ui.nodes(cases).find(node => node.props?.className === 'agent-case-trend-legend')).filter(node => node.type === 'li').map(node => ui.text(node)), ['通过1', '未通过1', '无法判定1', '结果不一致1', '未记录结果1'])
  const status = ui.nodes().find(node => node.props?.className === 'agent-result-status')
  assert.match(ui.text(status), /运行中尚无业务结论/)
  const attention = ui.nodes().find(node => node.props?.className === 'agent-result-cases')
  assert.match(ui.text(attention), /结果不一致不同Trial结果/)
  assert.doesNotMatch(ui.text(attention), /未通过不同Trial结果/)
  const points = ui.nodes().filter(node => node.type === 'button' && node.props['aria-label']?.includes('，运行或待执行'))
  assert.equal(points.length, 1)
  points[0].props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'evaluation', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', tab: 'runs', run_id: 'run-current' })
  assert.equal(ui.calls.some(call => /run-foreign/.test(JSON.stringify(call.payload))), false)
})

test('三个版本Run与最近一次的一个选定用例分别标明范围，不共用统计分母', async () => {
  const latest = { run_id: 'run-newest', status: 'completed', effective_verdict: 'inconclusive', created_at: '2026-10-16T09:09:50Z' }
  const ui = page({ target: { page: 'agents', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-001', tab: 'overview' }, intercept(endpoint) {
    if (endpoint === 'agents/runs/index') return { ok: true, value: { experiments: [{ experiment_id: 'EXP-first-agent-001', runs: [
      { run_id: 'run-old-1', status: 'completed', effective_verdict: 'passed', created_at: '2026-10-14T08:00:00Z' },
      { run_id: 'run-old-2', status: 'completed', effective_verdict: 'failed', created_at: '2026-10-15T08:00:00Z' }, latest,
    ] }] } }
    if (endpoint === 'agents/runs/show') return { ok: true, value: { run_id: latest.run_id, cases: [{ case_id: 'CASE-only', frozen: { title: '仅本次运行用例' }, trials: [{ verdict: 'failed' }] }] } }
  } })
  await ui.settle()
  const charts = ui.nodes().filter(node => node.type === 'figure' && node.props.className === 'hep-overview-chart')
  const runs = charts.find(node => ui.text(node).includes('当前版本 Run 分布'))
  const cases = charts.find(node => node.props['data-variant'] === 'case-trend')
  const scopeTime = new Date(latest.created_at).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  assert.match(ui.text(runs), /当前版本全部已登记记录，共 3 次 Run/)
  assert.ok(ui.nodes(runs).some(node => node.type === 'svg' && node.props['aria-label'] === '当前版本 Run 分布，共 3 次 Run'))
  assert.ok(ui.text(ui.nodes().find(node => node.props?.className === 'agent-overview-latest-scope')).includes(`最近一次 Run（${scopeTime}）：共 1 个选定用例`))
  assert.deepEqual(ui.nodes(ui.nodes(cases).find(node => node.props?.className === 'agent-case-trend-legend')).filter(node => node.type === 'li').map(node => ui.text(node)), ['通过0', '未通过1', '无法判定0', '结果不一致0', '未记录结果0'])
  assert.doesNotMatch(ui.text(cases), /共 3 个选定用例/)
  assert.equal(ui.nodes(cases).filter(node => node.props?.className === 'agent-case-trend-gap').length, 2, '未读取历史用例计数时保持缺口，不借用最近一次的一个用例')
  assert.ok(ui.calls.filter(call => call.endpoint === 'agents/runs/show').every(call => call.payload.run_id === latest.run_id))
  ui.button('查看最近结果').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'evaluation', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-001', tab: 'runs', run_id: latest.run_id })
})

test('逐例证据读取失败保留已读取版本分布，不伪造零用例结果', async () => {
  const ui = page({ intercept: endpoint => endpoint === 'agents/runs/show' ? { ok: false, error: { code: 'offline', message: '逐例记录暂不可读' } } : undefined })
  await ui.settle()
  const overview = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.match(ui.text(overview), /版本 Run 分布.*业务未通过1.*逐例证据暂不可读/s)
  assert.equal(ui.nodes(overview).filter(node => node.type === 'svg' && node.props.role === 'img').length, 1)
  assert.doesNotMatch(ui.text(overview), /未记录结果0|通过0|此版本尚无 Run/)
})

test('逐例详情未返回时保留索引图并显示读取指示，不先展示零用例', async () => {
  let finish
  const ui = page({ intercept: endpoint => endpoint === 'agents/runs/show' ? new Promise(resolve => { finish = resolve }) : undefined })
  await ui.settle()
  const overview = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.ok(ui.nodes(overview).some(node => node.props?.role === 'status' && node.props['aria-label'] === '读取最近 Run 的逐例观察'))
  assert.equal(ui.nodes(overview).filter(node => node.type === 'svg' && node.props.role === 'img').length, 1)
  assert.doesNotMatch(ui.text(overview), /未记录结果0|通过0|此版本尚无 Run/)
  finish({ ok: true, value: { cases: [] } }); await ui.settle()
  const ready = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.match(ui.text(ready), /未保存可统计的逐例观察/)
  assert.equal(ui.nodes(ready).some(node => node.props?.['aria-label'] === '读取最近 Run 的逐例观察'), false)
})

test('此版本尚无Run时显示真实空图表，保留进入评测的固定对象', async () => {
  const ui = page({ intercept: endpoint => endpoint === 'agents/runs/index' ? { ok: true, value: { experiments: [] } } : undefined })
  await ui.settle()
  const overview = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.match(ui.text(overview), /此版本尚无 Run/)
  assert.equal(ui.calls.some(call => call.endpoint === 'agents/runs/show'), false)
  ui.nodes(overview).find(node => node.type === 'button' && ui.text(node) === '查看全部 →').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'evaluation', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', tab: 'runs' })
})

test('同版本刷新保留图表和逐例观察，读取失败标注旧观察并可刷新恢复', async () => {
  let mode = 'ready', releaseIndex, releaseDetail
  const ui = page({ intercept(endpoint) {
    if (endpoint === 'agents/runs/index' && mode === 'index-pending') return new Promise(resolve => { releaseIndex = resolve })
    if (endpoint === 'agents/runs/show' && mode === 'detail-pending') return new Promise(resolve => { releaseDetail = resolve })
  } })
  await ui.settle()
  const summary = () => ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  const oldCases = ui.text(ui.nodes(summary()).find(node => node.props?.className === 'agent-result-cases'))
  mode = 'index-pending'; ui.button('刷新').props.onClick(); await ui.settle()
  assert.equal(ui.text(ui.nodes(summary()).find(node => node.props?.className === 'agent-result-cases')), oldCases)
  assert.ok(ui.nodes(summary()).some(node => node.props?.['aria-label'] === '更新此版本评测概况' && !node.props.className.includes('hep-loading-block')))
  assert.match(ui.text(summary()), /上次观察/)
  assert.equal(ui.nodes(summary()).some(node => node.props?.['aria-label'] === '读取此版本评测结果'), false)
  releaseIndex({ ok: false, error: { code: 'offline', message: '刷新索引失败' } }); await ui.settle()
  assert.match(ui.text(summary()), /读取失败，显示上次观察.*刷新索引失败/s)
  assert.equal(ui.text(ui.nodes(summary()).find(node => node.props?.className === 'agent-result-cases')), oldCases)
  assert.equal(summary().props['aria-busy'], false)
  mode = 'ready'; ui.button('刷新').props.onClick(); await ui.settle()
  assert.doesNotMatch(ui.text(summary()), /上次观察|刷新索引失败/)
  mode = 'detail-pending'; ui.button('刷新').props.onClick(); await ui.settle()
  assert.equal(ui.text(ui.nodes(summary()).find(node => node.props?.className === 'agent-result-cases')), oldCases)
  assert.equal(ui.nodes(summary()).some(node => node.props?.['aria-label'] === '读取最近 Run 的逐例观察'), false)
  releaseDetail({ ok: false, error: { code: 'offline', message: '刷新逐例失败' } }); await ui.settle()
  assert.match(ui.text(summary()), /读取失败，显示上次观察.*刷新逐例失败/s)
  assert.equal(ui.text(ui.nodes(summary()).find(node => node.props?.className === 'agent-result-cases')), oldCases)
  mode = 'ready'; ui.button('刷新').props.onClick(); await ui.settle()
  assert.doesNotMatch(ui.text(summary()), /上次观察|刷新逐例失败/)
})

test('同版本出现新Run时不复用旧逐例图，切版本后迟到详情也不能越界', async () => {
  let changedRun = false, changingVersion = false, finishNewRun, finishVersion
  const newRun = { run_id: 'run-new', status: 'completed', effective_verdict: 'passed', created_at: '2026-10-30T08:15:00Z' }
  const versionRun = { run_id: 'run-version', status: 'completed', effective_verdict: 'inconclusive', created_at: '2026-10-30T09:15:00Z' }
  const ui = page({ intercept(endpoint, payload) {
    if (endpoint === 'agents/runs/index' && changingVersion) return new Promise(resolve => { finishVersion = resolve })
    if (endpoint === 'agents/runs/index' && changedRun) return { ok: true, value: { experiments: [{ experiment_id: 'EXP-first-agent-002', runs: [newRun] }] } }
    if (endpoint === 'agents/runs/show' && payload.run_id === 'run-new') return new Promise(resolve => { finishNewRun = resolve })
    if (endpoint === 'agents/runs/show' && payload.run_id === 'run-version') return { ok: true, value: { cases: [{ case_id: 'new-version-case', frozen: { title: '当前版本用例' }, trials: [{ verdict: 'inconclusive' }] }] } }
  } })
  await ui.settle()
  changedRun = true; ui.button('刷新').props.onClick(); await ui.settle()
  const summary = () => ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.doesNotMatch(ui.text(summary()), /完整读取分页台账|台账服务异常处理/)
  assert.ok(ui.nodes(summary()).some(node => node.props?.['aria-label'] === '读取最近 Run 的逐例观察'))
  changingVersion = true
  ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '版本').props.onChange({ target: { value: 'EXP-first-agent-001' } })
  await ui.settle()
  assert.ok(ui.nodes(summary()).some(node => node.props?.['aria-label'] === '读取此版本评测结果'))
  assert.equal(ui.nodes(summary()).some(node => node.type === 'svg' && node.props.role === 'img'), false)
  finishNewRun({ ok: true, value: { cases: [{ case_id: 'late-case', frozen: { title: '迟到的其他版本用例' }, trials: [{ verdict: 'failed' }] }] } }); await ui.settle()
  assert.doesNotMatch(ui.text(summary()), /迟到的其他版本用例/)
  changingVersion = false
  finishVersion({ ok: true, value: { experiments: [{ experiment_id: 'EXP-first-agent-001', runs: [versionRun] }] } }); await ui.settle()
  assert.match(ui.text(summary()), /版本 001 的评测概况.*当前版本用例/s)
  assert.doesNotMatch(ui.text(summary()), /迟到的其他版本用例|完整读取分页台账/)
})

test('迟到的评测索引不能覆盖切换后的智能体结论', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const ui = page({ intercept: (endpoint, payload) => endpoint === 'agents/runs/index' && payload.agent_id === 'first-agent' ? pending : undefined })
  await ui.settle()
  ui.nodes().find(node => node.props?.className === 'agent-list-card' && ui.text(node).includes('second-agent')).props.onClick()
  ui.render(); await ui.settle()
  finish({ ok: true, value: { experiments: [{ experiment_id: 'EXP-first-agent-002', runs: [{ run_id: 'old-run', status: 'completed', effective_verdict: 'passed' }] }] } })
  await ui.settle()
  const overview = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.match(ui.text(overview), /业务未通过/)
  assert.doesNotMatch(ui.text(overview), /业务通过/)
  const version = ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '版本')
  assert.equal(version.props.value, 'EXP-second-agent-002')
})

test('导航精确定位研究版本、Run 报告，隐藏页不覆盖助手上下文', async () => {
  const ui = page({ target: { page: 'agents', agent_id: 'second-agent', experiment_id: 'EXP-second-agent-001', tab: 'runtime' } })
  await ui.settle()
  assert.equal(ui.nodes().find(node => node.props?.id === 'agent-panel-overview').props.hidden, false)
  assert.equal(ui.nodes().some(node => node.props?.id === 'agent-panel-runtime'), false)
  ui.button('查看最近结果').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'evaluation', agent_id: 'second-agent', experiment_id: 'EXP-second-agent-001', tab: 'runs', run_id: 'run-11111111-1111-4111-8111-111111111111' })
  const count = ui.contexts.length
  ui.props.active = false
  ui.props.target = { page: 'agents', agent_id: 'first-agent' }
  ui.render(); await ui.settle()
  assert.equal(ui.contexts.length, count)
  ui.props.active = true; ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'first-agent')
})

test('详情深链、页签点击与变体选择将手机视口定位到目标内容，键盘方向键保留页签焦点', async () => {
  const target = { page: 'agents', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', tab: 'compute-variants' }
  const deepLink = page({ target })
  await deepLink.settle()
  assert.ok(deepLink.reveals.includes('scroll:agent-panel-compute-variants'))
  assert.ok(deepLink.reveals.includes('focus:agent-panel-compute-variants'))
  const refreshed = page({ target: deepLink.history.at(-1) })
  await refreshed.settle()
  assert.ok(refreshed.reveals.includes('scroll:agent-panel-compute-variants'), '刷新后重新定位目标页签')

  const ui = page()
  await ui.settle()
  ui.button('描述与技能').props.onClick(); ui.render(); await ui.settle()
  assert.ok(ui.reveals.includes('scroll:agent-panel-description'))
  assert.ok(ui.reveals.includes('focus:agent-panel-description'))
  const scrolls = ui.reveals.filter(value => value.startsWith('scroll:agent-panel-')).length
  ui.nodes().find(node => node.props?.role === 'tablist' && node.props?.['aria-label'] === '智能体详情').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  ui.render(); await ui.settle()
  assert.equal(ui.reveals.filter(value => value.startsWith('scroll:agent-panel-')).length, scrolls)
  assert.ok(ui.reveals.includes('focus:agent-tab-assets'))
})

test('手机详情返回当前列表条目并恢复焦点，保留筛选和选中对象', async () => {
  const ui = page()
  await ui.settle()
  const search = ui.nodes().find(node => node.props?.placeholder === '名称或 Agent ID')
  search.props.onChange({ target: { value: 'second-agent' } }); ui.render()
  const card = ui.nodes().find(node => node.props?.id === 'agent-list-card-second-agent')
  card.props.onClick(); ui.render(); await ui.settle()
  assert.ok(ui.reveals.includes('focus:agent-identity'))
  ui.button('← 返回智能体列表').props.onClick(); ui.render()
  assert.deepEqual(ui.reveals.slice(-2), ['scroll:agent-list-card-second-agent', 'focus:agent-list-card-second-agent'])
  assert.equal(ui.nodes().find(node => node.props?.placeholder === '名称或 Agent ID').props.value, 'second-agent')
  assert.equal(ui.contexts.at(-1).agent_id, 'second-agent')

  ui.nodes().find(node => node.props?.id === 'agent-list-tab-variants').props.onClick(); ui.render(); await ui.settle()
  ui.nodes().find(node => node.props?.id === 'agent-variant-card-EXP-first-agent-002').props.onClick(); ui.render(); await ui.settle()
  ui.button('← 返回变体列表').props.onClick(); ui.render()
  assert.deepEqual(ui.reveals.slice(-2), ['scroll:agent-variant-card-EXP-first-agent-002', 'focus:agent-variant-card-EXP-first-agent-002'])
})

test('概览唯一评测摘要显示真实执行状态和时间，读取失败明确说明', async () => {
  const ui = page()
  await ui.settle()
  ui.button('概览').props.onClick(); ui.render(); await ui.settle()
  const summary = ui.nodes().find(node => node.props?.className === 'agent-evaluation-summary')
  assert.match(ui.text(summary), /执行已结束.*2026/s)
  const execution = ui.nodes(summary).find(node => node.props?.className === 'agent-result-status')
  assert.doesNotMatch(ui.text(execution), /未记录|读取失败/)
  assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '所选版本 Run'), false)

  const failed = page({ intercept: endpoint => endpoint === 'agents/runs/index' ? { ok: false, error: { code: 'offline', message: '索引暂不可读' } } : undefined })
  await failed.settle()
  failed.button('概览').props.onClick(); failed.render(); await failed.settle()
  assert.match(failed.text(failed.render()), /评测结果读取失败：offline: 索引暂不可读/)
})

test('资产保存冲突保留草稿，取消放弃时关闭和切换均不丢失修改', async () => {
  const ui = page()
  await ui.settle()
  ui.button('Harness 资产').props.onClick(); ui.render()
  ui.button('prompt.md').props.onClick(); ui.render(); await ui.settle()
  ui.button('编辑').props.onClick(); ui.render()
  let editor = ui.nodes().find(node => node.type === 'textarea')
  editor.props.onChange({ target: { value: '未保存正文' } }); ui.render()
  await ui.button('应用保存').props.onClick(); await ui.settle()
  editor = ui.nodes().find(node => node.type === 'textarea')
  assert.equal(editor.props.value, '未保存正文')
  assert.match(ui.text(ui.render()), /草稿已保留/)
  assert.ok(ui.listeners.has('beforeunload'))
  ui.button('关闭').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '未保存正文')
  ui.nodes().find(node => node.props?.className === 'agent-list-card' && ui.text(node).includes('second-agent')).props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'first-agent')
  ui.setConfirm(true); ui.button('关闭').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '原始正文')
  assert.equal(ui.listeners.has('beforeunload'), false)
})

test('保存期间的资产实时刷新不丢弃同一文件的成功回执', async () => {
  let notify, resolveSave
  const pending = new Promise(resolve => { resolveSave = resolve })
  const ui = page({ updates: {
    subscribe(listener) { notify = listener; return () => {} },
    getSnapshot() { return { domains: ['agents'] } },
  }, intercept(endpoint) { if (endpoint === 'agents/edit/apply') return pending } })
  await ui.settle()
  ui.button('Harness 资产').props.onClick(); ui.render()
  ui.button('prompt.md').props.onClick(); ui.render(); await ui.settle()
  ui.button('编辑').props.onClick(); ui.render()
  ui.button('应用保存').props.onClick(); ui.render()
  notify(); await ui.settle()
  resolveSave({ ok: true, value: { written: [{ path: 'candidate/prompt.md' }] } })
  await ui.settle()
  assert.match(ui.text(ui.render()), /文件校验通过，已保存 candidate\/prompt.md/)
  assert.equal(ui.button('应用保存').props.disabled, false)
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '原始正文')
})

test('切换智能体后忽略上个目标迟到的详情响应', async () => {
  let resolveFirst
  const pending = new Promise(resolve => { resolveFirst = resolve })
  const ui = page({ intercept: (endpoint, payload) => endpoint === 'agents/detail' && payload.agent_id === 'first-agent' ? pending : undefined })
  await ui.settle()
  ui.nodes().find(node => node.props?.className === 'agent-list-card' && ui.text(node).includes('second-agent')).props.onClick(); ui.render(); await ui.settle()
  resolveFirst({ ok: true, value: detail('first-agent') }); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'second-agent')
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-second-agent-002')
})

test('新版本继承盘点仍交由现有 AI 融合流程，保留目标和当前版本上下文', async () => {
  const ui = page({ intercept: endpoint => endpoint === 'agents/fusion/preview' ? { ok: true, value: { inventory: { sources: [] }, preview_id: 'fusion-preview' } } : undefined })
  await ui.settle()
  ui.button('新建研究版本').props.onClick(); ui.render()
  ui.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: '继承已有能力并改进摘要' } }); ui.render()
  ui.button('盘点继承来源').props.onClick(); await ui.settle()
  assert.equal(ui.calls.find(call => call.endpoint === 'agents/fusion/preview').payload.parent_ref, `git:${'d'.repeat(40)}`, '自动使用经过 Candidate 核对的派生来源')
  assert.equal(ui.nodes().some(node => node.type === 'input' && node.props.value === `git:${'d'.repeat(40)}`), false)
  await ui.button('请 AI 整理融合方案').props.onClick()
  assert.equal(ui.assistantTasks.length, 1)
  assert.match(ui.assistantTasks[0].task, /继承已有能力并改进摘要/)
  assert.equal(ui.assistantTasks[0].context.experiment_id, 'EXP-first-agent-002')
  assert.equal(ui.assistantTasks[0].context.fusion_request.preview_id, 'fusion-preview')
  assert.equal(ui.calls.some(call => call.endpoint === 'agents/versions/create'), false)
})

test('未固定来源时展示后端原因并阻止盘点，不以仓库提交替代所选版本', async () => {
  const ui = page({ intercept: (endpoint, payload) => endpoint === 'agents/detail' ? { ok: true, value: { ...detail(payload.agent_id, payload.experiment_id), derivation: { parent_ref: null, note: '当前 Candidate 有未提交改动，请先固定来源。' } } } : undefined })
  await ui.settle(); ui.button('新建研究版本').props.onClick(); ui.render()
  ui.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: '改善查询结果' } }); ui.render()
  assert.match(ui.text(ui.render()), /当前 Candidate 有未提交改动，请先固定来源/)
  assert.equal(ui.button('盘点继承来源').props.disabled, true)
  ui.button('盘点继承来源').props.onClick(); await ui.settle()
  assert.equal(ui.calls.some(call => call.endpoint === 'agents/fusion/preview'), false)
})

test('更多操作进入子视图后收起，不遮挡版本栏', async () => {
  const ui = page()
  await ui.settle()
  const menu = () => ui.nodes().find(node => node.props?.className === 'agent-more-actions')
  ui.nodes().find(node => node.type === 'summary' && ui.text(node) === '更多操作').props.onClick({ preventDefault() {} }); ui.render()
  assert.equal(menu().props.open, true)
  ui.button('新建研究版本').props.onClick(); ui.render()
  assert.equal(menu().props.open, false)
  assert.ok(ui.nodes().some(node => node.props?.['aria-label'] === '新建智能体版本'))
})

function launchPage(instances = [], override) {
  return page({ intercept: (endpoint, payload) => {
    const result = override?.(endpoint, payload)
    if (result !== undefined) return result
    if (endpoint === 'instances/list') return { ok: true, value: { instances } }
    if (endpoint === 'instances/run') return { ok: true, value: { ok: true } }
    if (endpoint === 'instances/url') return { ok: true, value: { url: 'http://127.0.0.1:3100/assistant/' } }
  } })
}

test('新建实例进入实例管理的来源预选与结构化预览，不在智能体页直接写入', async () => {
  const ui = launchPage()
  await ui.settle(); ui.button('进入对话').props.onClick(); await ui.settle()
  ui.button('前往实例管理创建').props.onClick(); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'instances', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', source_id: 'experiment:EXP-first-agent-002' })
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/url'), false)
})

test('已停止实例交给实例管理预览，已运行实例只读取得对话入口', async () => {
  for (const state of ['stopped', 'running']) {
    const ui = launchPage([{ name: 'existing', source_id: 'experiment:EXP-first-agent-002', state }])
    await ui.settle(); ui.button('进入对话').props.onClick(); await ui.settle()
    ui.button(state === 'running' ? '获取对话入口' : '在实例管理预览启动').props.onClick(); await ui.settle()
    assert.equal(ui.calls.filter(call => call.endpoint === 'instances/run').length, 0)
    assert.equal(ui.calls.filter(call => call.endpoint === 'instances/url').length, state === 'running' ? 1 : 0)
    if (state === 'stopped') assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'instances', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', source_id: 'experiment:EXP-first-agent-002', instance_name: 'existing' })
    else assert.ok(ui.nodes().find(node => node.type === 'a' && node.props.href === 'http://127.0.0.1:3100/assistant/'))
  }
})

test('版本来源保留查看与登记身份，实例信息只在实例管理查看', async () => {
  const ui = page({ intercept(endpoint, payload) {
    if (endpoint !== 'agents/detail') return undefined
    return { ok: true, value: { ...detail(payload.agent_id, payload.experiment_id), loaded_instance: { status: 'observed', instances: [], agent_instances: [
      { name: 'legacy-instance', source_id: 'experiment:EXP-first-agent-001', state: 'running' },
    ] } } }
  } })
  await ui.settle()
  const version = ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '版本')
  assert.equal(version.props.value, 'EXP-first-agent-002')
  const facts = ui.nodes(ui.nodes().find(node => node.props?.className === 'agent-variant-source'))
  assert.ok(facts.some(node => node.type === 'dd' && ui.text(node) === 'EXP-first-agent-002'))
  assert.ok(facts.some(node => node.type === 'dd' && ui.text(node) === 'EXP-first-agent-001'))
  assert.doesNotMatch(ui.text(), /legacy-instance|实例与近期 Run|对象与来源 ID/)
  ui.button('查看实例').props.onClick()
  assert.deepEqual(plain(ui.navigations.at(-1)), { page: 'instances', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002' })
})

test('读取现有实例入口时快速双击只查询一次，期间不能丢弃在途回执', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const ui = launchPage([{ name: 'existing', source_id: 'experiment:EXP-first-agent-002', state: 'running' }], endpoint => endpoint === 'instances/url' ? pending : undefined)
  await ui.settle(); ui.button('进入对话').props.onClick(); await ui.settle()
  const click = ui.button('获取对话入口').props.onClick
  click(); click(); ui.render(); await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/url').length, 1)
  assert.equal(ui.button('获取对话入口').props.disabled, true)
  assert.equal(ui.button('关闭').props.disabled, true)
  finish({ ok: true, value: { url: 'http://127.0.0.1:3100/assistant/' } }); await ui.settle()
  assert.equal(ui.button('获取对话入口').props.disabled, false)
  assert.equal(ui.button('关闭').props.disabled, false)
})

test('现有实例入口读取失败保留原实例并允许重试，不发起写操作', async () => {
  let failed = false
  const ui = launchPage([{ name: 'existing', source_id: 'experiment:EXP-first-agent-002', state: 'running' }], endpoint => {
    if (endpoint === 'instances/url' && !failed) { failed = true; return { ok: false, error: { code: 'failed', message: '入口暂不可读' } } }
  })
  await ui.settle(); ui.button('进入对话').props.onClick(); await ui.settle()
  ui.button('获取对话入口').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /入口暂不可读/)
  assert.equal(ui.nodes().some(node => node.type === 'a' && ui.text(node) === '打开智能体对话'), false)
  ui.button('获取对话入口').props.onClick(); await ui.settle()
  assert.ok(ui.nodes().find(node => node.type === 'a' && ui.text(node) === '打开智能体对话'))
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
})

test('切换智能体或版本后，迟到的实例入口不覆盖新对象', async () => {
  for (const next of ['agent', 'version']) {
    let finish
    const pending = new Promise(resolve => { finish = resolve })
    const ui = launchPage([{ name: 'existing', source_id: 'experiment:EXP-first-agent-002', state: 'running' }], endpoint => endpoint === 'instances/url' ? pending : undefined)
    await ui.settle(); ui.button('进入对话').props.onClick(); await ui.settle()
    ui.button('获取对话入口').props.onClick(); ui.render(); await ui.settle()
    if (next === 'agent') ui.nodes().find(node => node.props?.className === 'agent-list-card' && ui.text(node).includes('second-agent')).props.onClick()
    else ui.nodes().find(node => node.props?.['aria-label'] === '版本').props.onChange({ target: { value: 'EXP-first-agent-001' } })
    ui.render(); await ui.settle()
    const firstDetails = ui.calls.filter(call => call.endpoint === 'agents/detail' && call.payload.agent_id === 'first-agent').length
    finish({ ok: true, value: { url: 'http://127.0.0.1:3100/assistant/' } }); await ui.settle()
    assert.equal(ui.contexts.at(-1).agent_id, next === 'agent' ? 'second-agent' : 'first-agent')
    assert.equal(ui.contexts.at(-1).experiment_id, next === 'agent' ? 'EXP-second-agent-002' : 'EXP-first-agent-001')
    assert.equal(ui.nodes().some(node => node.type === 'a' && ui.text(node) === '打开智能体对话'), false)
    assert.equal(ui.calls.filter(call => call.endpoint === 'agents/detail' && call.payload.agent_id === 'first-agent').length, firstDetails)
    assert.equal(ui.calls.filter(call => call.endpoint === 'instances/url').length, 1)
  }
})

test('智能体、版本和标签选择同步导航地址，后退精确恢复且不产生导航循环', async () => {
  const ui = page({ target: { page: 'agents' } })
  await ui.settle()
  const plain = value => JSON.parse(JSON.stringify(value))
  assert.deepEqual(plain(ui.navigations.at(-1)), { page: 'agents', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002', tab: 'overview', replace: true })
  assert.equal(ui.history.length, 1, '默认地址补全必须替换原历史条目')
  ui.button('描述与技能').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.props.target.tab, 'description')
  assert.equal(ui.navigations.at(-1).replace, undefined)
  assert.equal(ui.history.length, 2)
  const version = ui.nodes().find(node => node.props?.['aria-label'] === '版本')
  version.props.onChange({ target: { value: 'EXP-first-agent-001' } }); ui.render(); await ui.settle()
  const previous = plain(ui.props.target)
  assert.deepEqual(previous, { page: 'agents', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-001', tab: 'description' })
  ui.nodes().find(node => node.props?.className === 'agent-list-card' && ui.text(node).includes('second-agent')).props.onClick(); ui.render(); await ui.settle()
  assert.deepEqual(plain(ui.props.target), { page: 'agents', agent_id: 'second-agent', experiment_id: 'EXP-second-agent-002', tab: 'overview' })
  assert.equal(ui.navigations.at(-1).replace, undefined, '显式切换智能体解析最新版后仍新增历史条目')
  assert.equal(ui.history.length, 4)
  const notified = ui.navigations.length
  ui.props.target = previous // 模拟 popstate 将历史 Hash 恢复为之前的精确对象。
  ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'first-agent')
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-first-agent-001')
  assert.equal(ui.contexts.at(-1).tab, 'description')
  assert.equal(ui.navigations.length, notified)
  for (let index = 0; index < 3; index++) {
    const callback = ui.props.onNavigate
    ui.props.onNavigate = value => callback(value)
    ui.render(); await ui.settle()
  }
  assert.equal(ui.navigations.length, notified, '父组件回调身份变化不应重新发出导航')
})

test('后退或深链接切换遭草稿保护拒绝时恢复旧地址，确认放弃后才加载新目标', async () => {
  const ui = page({ target: { page: 'agents' } })
  await ui.settle()
  ui.button('Harness 资产').props.onClick(); ui.render()
  ui.button('prompt.md').props.onClick(); ui.render(); await ui.settle()
  ui.button('编辑').props.onClick(); ui.render()
  ui.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: '保留的资产草稿' } }); ui.render()
  const oldTarget = JSON.parse(JSON.stringify(ui.props.target))
  const deepTarget = { page: 'agents', agent_id: 'second-agent', experiment_id: 'EXP-second-agent-001', tab: 'runtime' }
  ui.props.target = deepTarget; ui.render(); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.props.target)), oldTarget)
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { ...oldTarget, replace: true })
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '保留的资产草稿')
  assert.equal(ui.contexts.at(-1).agent_id, 'first-agent')
  ui.setConfirm(true)
  ui.props.target = deepTarget; ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'second-agent')
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-second-agent-001')
  assert.equal(ui.contexts.at(-1).tab, 'overview')
  assert.deepEqual(JSON.parse(JSON.stringify(ui.props.target)), { ...deepTarget, tab: 'overview' })
})

test('整理特性入口携带选定版本及维护Skill，后续页面变化不改发起上下文', async () => {
  const ui = page({ target: { page: 'agents', agent_id: 'second-agent', experiment_id: 'EXP-second-agent-001' } })
  await ui.settle()
  await ui.button('请 AI 整理特性').props.onClick()
  const request = ui.assistantTasks[0]
  assert.equal(request.context.agent_id, 'second-agent')
  assert.equal(request.context.experiment_id, 'EXP-second-agent-001')
  assert.equal(request.context.skill, 'agent-maintenance')
  assert.equal(request.context.workflow, 'features')
  ui.props.target = { page: 'agents', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-002' }
  await ui.settle()
  assert.equal(request.context.experiment_id, 'EXP-second-agent-001')
})

const plain = value => JSON.parse(JSON.stringify(value))
const listTab = (ui, view) => ui.nodes().find(node => node.props?.id === `agent-list-tab-${view}`)
const variantCards = ui => ui.nodes().filter(node => node.props?.className === 'agent-list-card agent-variant-card')

test('左右两层标签独立，切换列表保留右侧资产草稿且无需重新读取详情', async () => {
  const ui = page()
  await ui.settle()
  ui.button('Harness 资产').props.onClick(); ui.render()
  ui.button('prompt.md').props.onClick(); await ui.settle()
  ui.button('编辑').props.onClick(); ui.render()
  ui.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: '列表切换保留草稿' } }); ui.render()
  const expand = ui.button('展开资产差异')
  assert.equal(expand.props['aria-expanded'], false)
  assert.equal(expand.props['aria-controls'], 'agent-asset-diff-panel')
  expand.props.onClick(); ui.render()
  assert.equal(ui.button('收起资产差异').props['aria-expanded'], true)
  assert.ok(ui.nodes().find(node => node.type?.name === 'AssetDiffPanel'))
  ui.button('收起资产差异').props.onClick(); ui.render()
  assert.equal(ui.nodes().some(node => node.type?.name === 'AssetDiffPanel'), false)
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '列表切换保留草稿')
  const before = ui.calls.length
  listTab(ui, 'variants').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.props.target.list_view, 'variants')
  assert.equal(ui.props.target.tab, 'assets')
  assert.equal(ui.props.target.experiment_id, 'EXP-first-agent-002')
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '列表切换保留草稿')
  assert.equal(ui.calls.length, before, '左侧切换不读取详情、Run或比较context')
  listTab(ui, 'agents').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.props.target.list_view, undefined)
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '列表切换保留草稿')
})

test('变体汇总仅保留搜索与所属范围，两个列表分别保留搜索且可回到全部变体', async () => {
  const ui = page()
  await ui.settle()
  ui.nodes().find(node => node.props?.placeholder === '名称或 Agent ID').props.onChange({ target: { value: 'first-agent' } }); ui.render()
  ui.nodes().find(node => node.props?.['aria-label'] === '查看 名称 first-agent 的变体').props.onClick(); ui.render(); await ui.settle()
  assert.match(ui.text(ui.nodes().find(node => node.props?.className === 'agent-variant-scope')), /名称 first-agent 的变体/)
  assert.equal(ui.nodes().some(node => node.props?.className === 'agent-variant-filters'), false)
  assert.equal(ui.nodes().some(node => node.props?.['aria-label']?.startsWith('筛选变体')), false)
  assert.equal(variantCards(ui).length, 1)
  ui.button('显示全部变体').props.onClick(); ui.render()
  assert.equal(variantCards(ui).length, 2, '普通研究版本不算作算力变体')
  ui.nodes().find(node => node.props?.placeholder === '变体名称、版本或来源 ID').props.onChange({ target: { value: 'EXP-second-agent-001' } }); ui.render()
  assert.equal(variantCards(ui).length, 1, '可按来源父版ID搜索')
  listTab(ui, 'agents').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.nodes().find(node => node.props?.placeholder === '名称或 Agent ID').props.value, 'first-agent')
  listTab(ui, 'variants').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.nodes().find(node => node.props?.placeholder === '变体名称、版本或来源 ID').props.value, 'EXP-second-agent-001')
  assert.equal(ui.calls.some(call => /compute-variants/.test(call.endpoint)), false)
  assert.ok(ui.calls.some(call => call.endpoint === 'agents/runs/index' && call.payload.agent_id === 'first-agent'))
})

test('变体选择显式定位所属智能体和生成页，同版本也可从资产页切换，父版仍在同页查看', async () => {
  const ui = page()
  await ui.settle()
  ui.button('Harness 资产').props.onClick(); ui.render(); await ui.settle()
  listTab(ui, 'variants').props.onClick(); ui.render(); await ui.settle()
  variantCards(ui).find(node => ui.text(node).includes('EXP-first-agent-002')).props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.props.target.tab, 'compute-variants', '同对象早返回也应用显式页签')
  variantCards(ui).find(node => ui.text(node).includes('EXP-second-agent-002')).props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.props.target.agent_id, 'second-agent')
  assert.equal(ui.props.target.experiment_id, 'EXP-second-agent-002')
  assert.equal(ui.props.target.tab, 'compute-variants', '跨Agent不能强制落回概览')
  ui.button('查看父版当前详情').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.props.target.experiment_id, 'EXP-second-agent-001')
  assert.equal(ui.props.target.tab, 'overview')
  assert.equal(ui.props.target.list_view, 'variants')
  assert.match(ui.text(ui.render()), /真实用途/)
})

test('变体深链接与浏览历史恢复列表和对象，迟到详情不覆盖最新列表视图', async () => {
  const target = { page: 'agents', agent_id: 'second-agent', experiment_id: 'EXP-second-agent-002', tab: 'overview', list_view: 'variants' }
  const ui = page({ target })
  await ui.settle()
  assert.equal(listTab(ui, 'variants').props['aria-selected'], true)
  const old = plain(ui.props.target)
  listTab(ui, 'agents').props.onClick(); ui.render(); await ui.settle()
  const notified = ui.navigations.length
  ui.props.target = old; ui.render(); await ui.settle()
  assert.equal(listTab(ui, 'variants').props['aria-selected'], true)
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-second-agent-002')
  assert.equal(ui.navigations.length, notified)
  let finish
  const slow = page({ intercept: (endpoint, payload) => endpoint === 'agents/detail' && payload.agent_id === 'first-agent' ? new Promise(resolve => { finish = resolve }) : undefined })
  await slow.settle()
  listTab(slow, 'variants').props.onClick(); slow.render(); await slow.settle()
  finish({ ok: true, value: detail('first-agent') }); await slow.settle()
  assert.equal(slow.props.target.list_view, 'variants')
  assert.equal(listTab(slow, 'variants').props['aria-selected'], true)
})

test('来源Run定位父版报告，生成代码定位当前Candidate资产，缺失父版诚实显示', async () => {
  const ui = page()
  await ui.settle()
  ui.button('查看生成源码').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.props.target.tab, 'assets')
  assert.ok(ui.calls.some(call => call.endpoint === 'agents/edit/read' && call.payload.path === 'evolution/experiments/EXP-first-agent-002/candidate/dsh/managed/compute-workflow/index.ts'))
  ui.button('查看诊断报告').props.onClick()
  assert.deepEqual(plain(ui.props.target), { page: 'evaluation', agent_id: 'first-agent', experiment_id: 'EXP-first-agent-001', tab: 'runs', run_id: 'run-22222222-2222-4222-8222-222222222222' })
  const unknown = page({ intercept: (endpoint, payload) => {
    if (endpoint !== 'agents/detail') return
    const value = detail(payload.agent_id, payload.experiment_id)
    value.experiment = { ...value.experiment, change: { baseline_ref: `git:${'c'.repeat(40)}` } }
    value.baseline = { ref: `git:${'c'.repeat(40)}` }
    return { ok: true, value }
  } })
  await unknown.settle()
  assert.match(unknown.text(unknown.nodes().find(node => node.props?.['aria-label'] === '版本来源与继承')), /父版本未记录/)
  assert.equal(unknown.button('查看父版当前详情'), undefined)
})

test('列表主标题使用独立名称，不截取策略或研究问题，名称可直接搜索', async () => {
  const ui = page()
  await ui.settle()
  listTab(ui, 'variants').props.onClick(); ui.render(); await ui.settle()
  const titles = () => variantCards(ui).map(card => ui.text(card.props.children[0].props.children[0]))
  assert.deepEqual(titles(), ['资产告警轻量版', '未命名变体'])
  const search = ui.nodes().find(node => node.props?.placeholder === '变体名称、版本或来源 ID')
  search.props.onChange({ target: { value: '告警轻量' } }); ui.render()
  assert.equal(variantCards(ui).length, 1)
  assert.match(ui.text(variantCards(ui)[0]), /EXP-first-agent-002/)
  const version = ui.nodes().find(node => node.props?.['aria-label'] === '版本')
  assert.match(ui.text(version), /资产告警轻量版 · v002/)
})

test('名称保存后回读列表与详情，冲突保留草稿并可重新核对而不改策略', async () => {
  let saved = '资产告警轻量版', revision = 'a'.repeat(64), conflict = true
  const ui = page({ intercept: (endpoint, payload) => {
    if (endpoint === 'agents/list') return { ok: true, value: { agents: [{ id: 'first-agent', name: '名称 first-agent' }], experiments: experiments().map(item => item.id === 'EXP-first-agent-002' ? { ...item, change_sha256: revision, change: { ...item.change, variant_name: saved } } : item) } }
    if (endpoint === 'agents/detail') { const value = detail(payload.agent_id, payload.experiment_id); value.experiment = { ...value.experiment, change_sha256: revision, change: { ...value.experiment.change, variant_name: saved } }; return { ok: true, value } }
    if (endpoint === 'agents/compute-variants/rename') {
      if (conflict) { revision = 'b'.repeat(64); return { ok: false, error: { code: 'conflict', message: '版本信息已变化' } } }
      assert.equal(payload.expected_change_sha256, revision)
      saved = payload.variant_name
      return { ok: true, value: { experiment_id: payload.experiment_id, variant_name: saved } }
    }
  } })
  await ui.settle()
  ui.button('修改变体名称').props.onClick(); ui.render()
  const input = () => ui.nodes().find(node => node.props?.['aria-label'] === '变体名称')
  input().props.onChange({ target: { value: '独立的新名称' } }); ui.render()
  const form = () => ui.nodes().find(node => node.props?.['aria-label'] === '修改变体名称')
  form().props.onSubmit({ preventDefault() {} }); await ui.settle()
  assert.equal(input().props.value, '独立的新名称')
  assert.match(ui.text(ui.render()), /名称草稿已保留/)
  await ui.button('重新核对').props.onClick(); await ui.settle()
  assert.equal(input().props.value, '独立的新名称')
  conflict = false
  form().props.onSubmit({ preventDefault() {} }); await ui.settle()
  assert.equal(ui.button('取消改名'), undefined)
  assert.match(ui.text(variantCards(ui)[0]), /独立的新名称/)
  assert.equal(ui.calls.findLast(call => call.endpoint === 'agents/compute-variants/rename').payload.variant_name, '独立的新名称')
  assert.equal(ui.calls.some(call => /generate|eval\/start|compute-variants\/build/.test(call.endpoint)), false)
})

test('改名草稿在取消、切换智能体和切换版本前均须明确放弃', async () => {
  const ui = page()
  await ui.settle()
  ui.button('修改变体名称').props.onClick(); ui.render()
  const input = () => ui.nodes().find(node => node.props?.['aria-label'] === '变体名称')
  input().props.onChange({ target: { value: '尚未保存的名称' } }); ui.render()
  assert.ok(ui.listeners.has('beforeunload'))

  ui.button('取消改名').props.onClick(); ui.render()
  assert.equal(input().props.value, '尚未保存的名称')
  ui.nodes().find(node => node.props?.id === 'agent-list-card-second-agent').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'first-agent')
  assert.equal(input().props.value, '尚未保存的名称')
  assert.equal(ui.calls.some(call => call.endpoint === 'agents/detail' && call.payload.agent_id === 'second-agent'), false)

  ui.nodes().find(node => node.props?.['aria-label'] === '版本').props.onChange({ target: { value: 'EXP-first-agent-001' } }); ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-first-agent-002')
  assert.equal(input().props.value, '尚未保存的名称')

  ui.setConfirm(true)
  ui.nodes().find(node => node.props?.['aria-label'] === '版本').props.onChange({ target: { value: 'EXP-first-agent-001' } }); ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-first-agent-001')
  assert.equal(input(), undefined)
  assert.equal(ui.listeners.has('beforeunload'), false)

  ui.nodes().find(node => node.props?.['aria-label'] === '版本').props.onChange({ target: { value: 'EXP-first-agent-002' } }); ui.render(); await ui.settle()
  ui.button('修改变体名称').props.onClick(); ui.render()
  input().props.onChange({ target: { value: '再次编辑' } }); ui.render()
  ui.button('取消改名').props.onClick(); ui.render()
  assert.equal(input(), undefined)
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-first-agent-002')
  assert.equal(ui.calls.some(call => call.endpoint === 'agents/compute-variants/rename'), false)
})

test('名称核对未完成时暂缓切换，核对后确认放弃草稿', async () => {
  let resolveRecheck, pendingRecheck = false
  const recheck = new Promise(resolve => { resolveRecheck = resolve })
  const ui = page({ intercept: (endpoint, payload) => endpoint === 'agents/detail' && pendingRecheck
    && payload.agent_id === 'first-agent' && payload.experiment_id === 'EXP-first-agent-002' ? recheck : undefined })
  await ui.settle()
  ui.button('修改变体名称').props.onClick(); ui.render()
  const input = () => ui.nodes().find(node => node.props?.['aria-label'] === '变体名称')
  input().props.onChange({ target: { value: '保留的名称草稿' } }); ui.render()
  pendingRecheck = true
  ui.button('重新核对').props.onClick(); ui.render()
  ui.setConfirm(true)
  ui.nodes().find(node => node.props?.id === 'agent-list-card-second-agent').props.onClick(); ui.render()
  assert.equal(ui.contexts.at(-1).agent_id, 'first-agent')
  assert.match(ui.text(ui.render()), /正在保存或核对名称，请等待结果后再切换/)

  pendingRecheck = false
  const current = detail('first-agent', 'EXP-first-agent-002')
  current.experiment.change_sha256 = 'b'.repeat(64)
  resolveRecheck({ ok: true, value: current }); await ui.settle()
  assert.equal(input().props.value, '保留的名称草稿')
  ui.nodes().find(node => node.props?.id === 'agent-list-card-second-agent').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'second-agent')
  assert.equal(input(), undefined)
  assert.doesNotMatch(ui.text(ui.render()), /保留的名称草稿/)
})

test('改名时旧对象详情迟到，不覆盖新对象的名称和草稿', async () => {
  let finishOldRead, holdOldRead = false
  const oldRead = new Promise(resolve => { finishOldRead = resolve })
  const ui = page({ intercept: (endpoint, payload) => endpoint === 'agents/detail' && holdOldRead
    && payload.agent_id === 'first-agent' && payload.experiment_id === 'EXP-first-agent-002' ? oldRead : undefined })
  await ui.settle()
  ui.button('修改变体名称').props.onClick(); ui.render()
  ui.nodes().find(node => node.props?.['aria-label'] === '变体名称').props.onChange({ target: { value: '旧对象的草稿' } }); ui.render()
  holdOldRead = true
  ui.button('刷新').props.onClick(); ui.render()
  ui.setConfirm(true)
  ui.nodes().find(node => node.props?.id === 'agent-list-card-second-agent').props.onClick(); ui.render(); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'second-agent')

  holdOldRead = false
  finishOldRead({ ok: true, value: detail('first-agent', 'EXP-first-agent-002') }); await ui.settle()
  assert.equal(ui.contexts.at(-1).agent_id, 'second-agent')
  assert.equal(ui.contexts.at(-1).experiment_id, 'EXP-second-agent-002')
  ui.button('修改变体名称').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '变体名称').props.value, '')
  assert.doesNotMatch(ui.text(ui.render()), /旧对象的草稿/)
})

test('旧列表请求迟到时不能把新名称覆盖回旧名称', async () => {
  let finish, reads = 0
  const old = new Promise(resolve => { finish = resolve })
  const value = name => ({ agents: [{ id: 'first-agent', name: '名称 first-agent' }], experiments: experiments().map(item => item.id === 'EXP-first-agent-002' ? { ...item, change: { ...item.change, variant_name: name } } : item) })
  const ui = page({ intercept: endpoint => endpoint === 'agents/list' ? ++reads === 1 ? old : { ok: true, value: value('更新后的名称') } : undefined })
  await ui.settle()
  ui.button('刷新').props.onClick(); await ui.settle()
  finish({ ok: true, value: value('迟到的旧名称') }); await ui.settle()
  assert.match(ui.text(variantCards(ui)[0]), /更新后的名称/)
  assert.doesNotMatch(ui.text(variantCards(ui)[0]), /迟到的旧名称/)
})


test('凭据脱敏预览显示只读原因，不能进入编辑或保存', async () => {
  const ui = page({ intercept(endpoint, payload) {
    if (endpoint === 'agents/edit/read') return { ok: true, value: { kind: 'text', path: payload.path,
      content: 'token: "[已隐藏]"', sha256: 'a'.repeat(64), content_sha256: 'b'.repeat(64), editable: false, redacted: true,
      reason: '内容已脱敏，不能以预览替换源码。' } }
  } })
  await ui.settle()
  ui.button('Harness 资产').props.onClick(); ui.render()
  ui.button('prompt.md').props.onClick(); ui.render(); await ui.settle()
  assert.match(ui.text(ui.render()), /内容已脱敏，不能以预览替换源码/)
  assert.equal(ui.button('编辑').props.disabled, true)
  assert.equal(ui.calls.some(call => ['agents/edit/preview', 'agents/edit/apply'].includes(call.endpoint)), false)
})

test('发布预览在页面失活时关闭原生 modal，返回时可继续核对', async () => {
  const ui = page()
  await ui.settle()
  ui.button('发布版本').props.onClick(); ui.render()
  const dialog = ui.dialogs.get('agent-publish-title')
  assert.equal(dialog.open, true)
  assert.equal(ui.button('发布版本（未接入）').props.disabled, true)
  ui.props.active = false; ui.render()
  assert.equal(dialog.open, false)
  ui.props.active = true; ui.render()
  assert.equal(dialog.open, true)
  assert.equal(ui.calls.some(call => /publish/.test(call.endpoint)), false)
})

test('概览保留独有特性证据，来源唯一，Runtime信息归资产页', async () => {
  const ui = page({ intercept(endpoint, payload) {
    if (endpoint !== 'agents/detail') return
    const value = detail(payload.agent_id, payload.experiment_id)
    value.features = [{ id: 'pagination', title: '分页能力', description: '覆盖分页设备', source_refs: ['candidate/role.md'], verification: '已核对分页返回', evidence: [{ ref: 'runs/one/report.md', present: true }] }]
    value.declared = { source_contract: { status: 'available', image: { cli_version: '0.2.1-rc.2' } }, loadable_source: { candidate_root: 'candidate', profile: 'main' } }
    return { ok: true, value }
  } }); await ui.settle()
  const overview = ui.nodes().find(node => node.props?.id === 'agent-panel-overview')
  assert.equal(ui.nodes(overview).filter(node => node.type === 'h4' && ui.text(node) === '分页能力').length, 1)
  assert.match(ui.text(overview), /已核对分页返回.*runs\/one\/report.md/s)
  assert.equal(ui.nodes().filter(node => node.props?.className === 'agent-variant-source').length, 1)
  assert.equal(ui.nodes().some(node => node.props?.className === 'agent-legacy-evidence'), false)
  const assets = ui.nodes().find(node => node.props?.id === 'agent-panel-assets')
  assert.match(ui.nodes(assets).map(ui.text).join(''), /Runtime 版本0.2.1-rc.2/)
  assert.match(ui.nodes(assets).map(ui.text).join(''), /CandidatecandidateProfilemain/)
})


test('刷新已有智能体清单时保留条目，仅在标题显示紧凑读取反馈', async () => {
  let refreshing = false, release
  const ui = page({ intercept(endpoint) { if (endpoint === 'agents/list' && refreshing) return new Promise(resolve => { release = resolve }) } })
  await ui.settle()
  const before = ui.nodes().filter(node => node.props?.className === 'agent-list-card').map(node => ui.text(node))
  refreshing = true
  ui.button('刷新').props.onClick(); ui.render()
  assert.deepEqual(ui.nodes().filter(node => node.props?.className === 'agent-list-card').map(node => ui.text(node)), before)
  const loading = ui.nodes().find(node => node.props?.['aria-label'] === '更新智能体列表')
  assert.equal(loading.props.role, 'status')
  const tabs = ui.nodes().find(node => node.props?.['aria-label'] === '浏览列表')
  assert.ok(ui.nodes(tabs).some(node => node.props?.['aria-label'] === '更新智能体列表'), '刷新反馈应在可见页签栏，而非被隐藏的列表标题中')
  assert.equal(loading.props.className.includes('hep-loading-block'), false)
  assert.doesNotMatch(ui.text(ui.render()), /正在读取|正在更新/)
  assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '读取智能体列表'), false)
  release({ ok: true, value: { agents: [], experiments: [] } })
  await ui.settle()
  assert.match(ui.text(ui.render()), /尚无智能体资产/)
})

test('Agents 隐藏只记脏，恢复及慢读取通知合并为顺序两批', async () => {
  let listener, block = false, release, concurrent = 0, maximum = 0
  const updates = { subscribe(fn) { listener = fn; return () => { listener = undefined } }, getSnapshot: () => ({ domains: ['agents'] }) }
  const ui = page({ updates, intercept(endpoint) {
    if (endpoint !== 'agents/list' || !block) return
    concurrent++; maximum = Math.max(maximum, concurrent)
    return new Promise(resolve => { release = () => { concurrent--; resolve({ ok: true, value: { agents: [], experiments: [] } }) } })
  } })
  await ui.settle(); const before = ui.calls.length
  ui.props.active = false; ui.render()
  listener(); listener(); listener(); await ui.settle()
  assert.equal(ui.calls.length, before)
  block = true; ui.props.active = true; ui.render(); await ui.settle()
  assert.equal(concurrent, 1)
  const started = ui.calls.filter(call => call.endpoint === 'agents/list').length
  listener(); listener(); listener(); await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint === 'agents/list').length, started)
  block = false; release(); await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint === 'agents/list').length, started + 1)
  assert.equal(maximum, 1)
})

test('Agents 首次慢读取也纳入同一刷新队列，通知不能另起并行目录读取', async () => {
  let listener, release, blocked = true, reads = 0
  const updates = { subscribe(fn) { listener = fn; return () => {} }, getSnapshot: () => ({ domains: ['agents'] }) }
  const ui = page({ updates, intercept(endpoint) {
    if (endpoint !== 'agents/list') return
    reads++
    if (blocked) return new Promise(resolve => { release = () => resolve({ ok: true, value: { agents: [], experiments: [] } }) })
    return { ok: true, value: { agents: [], experiments: [] } }
  } })
  assert.equal(reads, 1)
  listener(); listener(); listener(); await ui.settle()
  assert.equal(reads, 1)
  blocked = false; release(); await ui.settle()
  assert.equal(reads, 2)
})
