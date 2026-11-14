import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/agents/business-client.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], plugins: [{ name: 'page-components', setup(builder) { builder.onLoad({ filter: /detail-drawer\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function DetailDrawer(p) { return createElement('section', { 'data-drawer-title': p.title }, createElement('button', { type: 'button' }, p.trigger || p.title), p.children) }` })); builder.onLoad({ filter: /search-select\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function SearchSelect(p) { const option = o => createElement('option', { key:o.value, value:o.value }, o.label + ' ' + (o.description || '')); return createElement('select', { 'aria-label': p.label, value: p.value, onChange: e => p.onChange(e.target.value) }, p.groups ? p.groups.map(group => createElement('optgroup', { key:group, label:group }, p.options.filter(o => o.group === group).map(option))) : p.options.map(option)) }` })); builder.onLoad({ filter: /deployment\/client\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function DeploymentDialog(p) { return createElement('section', { 'data-deployment': p.target, 'data-active': p.active }, createElement('button', { onClick:p.onClose }, '关闭导出')) }` })); builder.onLoad({ filter: /overview\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function AgentEvaluationOverview(p) { return createElement('div', {}, p.value?.phase || '') }` })); builder.onLoad({ filter: /description-client\.tsx$/ }, () => ({ loader: 'tsx', contents: `import { createElement } from 'react'; export function AgentDescriptionPanel(p) { return createElement('div', { 'data-description-version': p.detail.experiment.id }, '版本资料与技能') }` })) } }] })).outputFiles[0].text

function catalog(id = 'first-agent') {
  return { id, name: `名称 ${id}`, notes: '业务用途', source_id: `business:${id}`, repository: '/business', path: `/business/agents/${id}`, branch: 'main', commit: 'c'.repeat(40), asset_commit: 'c'.repeat(40), dirty: false, digest: 'sha256:current', profile: 'web', tag: null, files: ['harness.yaml', 'dsh/presets/demo/AGENTS.md'], versions: [] }
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
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, URL, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : require(name),
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
      if (endpoint === 'agents/business/list') return { ok: true, value: { agents: ['first-agent', 'second-agent'].map(id => catalog(id)), errors: {} } }
      if (endpoint === 'agents/business/detail') return { ok: true, value: { ...catalog(payload.agent_id), source_id: payload.source, tag: 'v1' } }
      if (endpoint === 'agents/runs/index') return { ok: true, value: { experiments: ['001', '002'].map(version => ({ experiment_id: `EXP-${payload.agent_id}-${version}`, runs: [{ run_id: 'run-11111111-1111-4111-8111-111111111111', status: 'completed', effective_verdict: 'failed', created_at: '2026-10-20T08:00:00Z' }] })) } }
      if (endpoint === 'agents/runs/show') return { ok: true, value: { run_id: payload.run_id, manifest: { status: 'completed' }, cases: [{ case_id: 'CASE-008', frozen: { title: '完整读取分页台账' }, trials: [{ verdict: 'failed' }] }, { case_id: 'CASE-012', frozen: { title: '台账服务异常处理' }, trials: [{ verdict: 'inconclusive' }] }] } }
      if (endpoint === 'agents/edit/read') return { ok: true, value: { path: payload.path, kind: payload.path === 'candidate' ? 'directory' : 'text', content: '原始正文', sha256: 'a'.repeat(64), size: 12, editable: !payload.experiment_id.includes('@') } }
      if (endpoint === 'agents/edit/apply') return { ok: false, error: { code: 'conflict', message: '内容已变化' } }
      return { ok: true, value: { proposal: null } }
    } },
  }
  function rawNodes(value) { if (Array.isArray(value)) return value.flatMap(rawNodes); if (!value || typeof value !== 'object') return []; return [value, ...rawNodes(value.props?.children)] }
  function render() { let count = 0; do { if (++count > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.BusinessAgentsPage(props); for (const node of rawNodes(tree).filter(node => node.type === 'dialog')) { const id = node.props['aria-labelledby']; if (!dialogs.has(id)) dialogs.set(id, { open: false, showModal() { this.open = true }, close() { this.open = false } }); if (node.ref) node.ref.current = dialogs.get(id) }; effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 5; index++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function resolved(value) { if (!resolvedComponents.has(value)) resolvedComponents.set(value, value.type(value.props)); return resolvedComponents.get(value) }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object') return []; if (value.type?.name === 'AssetDiffPanel') return [value]; if (typeof value.type === 'function') return nodes(resolved(value)); return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object') return typeof value.type === 'function' && value.type.name !== 'AssetDiffPanel' ? text(resolved(value)) : text(value.props?.children); return typeof value === 'boolean' ? '' : String(value ?? '') }
  const button = name => nodes().find(node => node.type === 'button' && text(node) === name)
  render()
  return { render, settle, nodes, text, button, calls, contexts, navigations, history, assistantTasks, props, listeners, reveals, dialogs, setConfirm: value => { confirm = value } }
}

test('保持详情页布局与三个页签，只读取业务仓，暂无 tag 不伪造版本', async () => {
  const ui = page(); await ui.settle()
  assert.deepEqual(ui.nodes().filter(node => node.props?.role === 'tab').map(node => ui.text(node)), ['概览', '描述与技能', 'Harness 资产'])
  assert.ok(ui.calls.some(call => call.endpoint === 'agents/business/list'))
  assert.equal(ui.calls.some(call => call.endpoint === 'agents/list'), false)
  assert.match(ui.text(ui.render()), /当前工作树/)
  assert.match(ui.text(ui.render()), /业务仓尚未创建 Git tag/)
  const search = ui.nodes().find(node => node.props?.type === 'search')
  search.props.onChange({ target: { value: 'second-agent' } }); ui.render()
  assert.equal(ui.nodes().filter(node => node.props?.className === 'agent-list-card').length, 1)
})

test('tag 选项来自业务仓且切换时传递原生来源，不写入登记', async () => {
  const ui = page({ intercept(endpoint) {
    if (endpoint === 'agents/business/list') return { ok: true, value: { agents: [{ ...catalog(), versions: [{tag:'v1', source_id:'business:first-agent@v1', commit:'c'.repeat(40)}] }], errors: {} } }
  } }); await ui.settle()
  const selector = ui.nodes().find(node => node.type === 'select')
  assert.equal(ui.nodes(selector).filter(node => node.type === 'option').length, 1)
  selector.props.onChange({target:{value:'business:first-agent@v1'}}); await ui.settle()
  assert.ok(ui.calls.some(call => call.endpoint === 'agents/business/detail' && call.payload.source === 'business:first-agent@v1'))
  assert.equal(ui.calls.some(call => /apply|activate|create/.test(call.endpoint)), false)
  ui.button('导出独立运行包').props.onClick(); await ui.settle()
  assert.equal(ui.nodes().find(node => node.props?.['data-deployment']).props['data-deployment'].experiment_id, 'business:first-agent@v1')
  ui.button('关闭导出').props.onClick(); await ui.settle()
  ui.button('查看当前工作树').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /当前工作树/)
})

test('资产编辑冲突保留正文和草稿，未保存时不能切换智能体', async () => {
  const ui = page(); await ui.settle()
  ui.button('Harness 资产').props.onClick(); await ui.settle()
  ui.button('编辑').props.onClick(); await ui.settle()
  const editor = ui.nodes().find(node => node.type === 'textarea')
  editor.props.onChange({target:{value:'编辑后的正文'}}); ui.render()
  await ui.button('保存修改').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /内容已变化/)
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '编辑后的正文')
  const edit = ui.calls.find(call => call.endpoint === 'agents/edit/apply')
  assert.equal(edit.payload.experiment_id, 'business:first-agent')
  assert.equal(edit.payload.edits[0].expected_sha256, 'a'.repeat(64))
  ui.nodes().find(node => node.props?.id === 'agent-list-card-second-agent').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.nodes().find(node => node.props?.id === 'agent-identity')), /名称 first-agent/)
})

test('评测和实例入口携带当前业务来源，独立包直接打开所选来源的导出窗口', async () => {
  const ui = page(); await ui.settle()
  ui.button('发起评测').props.onClick(); await ui.settle()
  assert.equal(ui.navigations.at(-1).source_id, 'business:first-agent')
  assert.equal(ui.navigations.at(-1).experiment_id, 'business:first-agent')
  ui.props.active = true; ui.render(); await ui.settle()
  await ui.button('导出独立运行包').props.onClick()
  await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.nodes().find(node => node.props?.['data-deployment']).props['data-deployment'])), { agent_id: 'first-agent', experiment_id: 'business:first-agent', label: '名称 first-agent' })
  assert.equal(ui.assistantTasks.length, 0)
  ui.button('关闭导出').props.onClick(); await ui.settle()
  assert.equal(ui.nodes().some(node => node.props?.['data-deployment']), false)
})

test('隐藏页面不读取业务目录，恢复可见后读取', async () => {
  const ui = page({ active: false }); await ui.settle()
  assert.equal(ui.calls.length, 0)
  ui.props.active = true; ui.render(); await ui.settle()
  assert.ok(ui.calls.some(call => call.endpoint === 'agents/business/list'))
})

test('SDK 资产保留 SDK 调试与文档入口', async () => {
  const ui = page({ intercept(endpoint) {
    if (endpoint === 'agents/business/list') return {ok:true,value:{agents:[{...catalog(),profile:'sdk'}],errors:{}}}
  } }); await ui.settle()
  assert.ok(ui.button('SDK 调试')); assert.ok(ui.button('接入文档'))
  assert.equal(ui.button('进入对话'), undefined)
  assert.equal(ui.button('发起评测'), undefined)
})
