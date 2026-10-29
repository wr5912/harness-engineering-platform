import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { navigationHash, readNavigation } from '../src/navigation.ts'

test('页面定位保留精确 Agent、版本、Run 与用例，未知地址回首页', () => {
  const target = { page: 'evaluation', agent_id: 'test01', experiment_id: 'EXP-test01-002', run_id: 'run-11111111-1111-4111-8111-111111111111', case_id: 'U-IDENTITY-001', tab: 'runs' }
  assert.deepEqual(readNavigation(navigationHash(target)), target)
  assert.deepEqual(readNavigation('#/unknown'), { page: 'home' })
  assert.deepEqual(readNavigation('#/agents?agent_id=../../outside&tab=assets'), { page: 'agents', tab: 'assets' })
})

test('评测 Run 子视图可随 URL 往返，用例深链优先定位逐例结果', () => {
  for (const run_tab of ['results', 'trace', 'files', 'datasets']) {
    const target = { page: 'evaluation', tab: 'runs', run_id: 'run-11111111-1111-4111-8111-111111111111', run_tab }
    assert.deepEqual(readNavigation(navigationHash(target)), target)
  }
  const caseRoute = '#/evaluation?tab=runs&run_id=run-11111111-1111-4111-8111-111111111111&case_id=U-IDENTITY-001&run_tab=trace'
  assert.deepEqual(readNavigation(caseRoute), { page: 'evaluation', tab: 'runs', run_id: 'run-11111111-1111-4111-8111-111111111111', case_id: 'U-IDENTITY-001' })
  assert.deepEqual(readNavigation(navigationHash({ page: 'evaluation', tab: 'runs', run_id: 'run-11111111-1111-4111-8111-111111111111', case_id: 'U-IDENTITY-001', run_tab: 'trace' })), { page: 'evaluation', tab: 'runs', run_id: 'run-11111111-1111-4111-8111-111111111111', case_id: 'U-IDENTITY-001' })
  assert.deepEqual(readNavigation('#/evaluation?tab=runs&run_id=run-11111111-1111-4111-8111-111111111111&run_tab=missing'), { page: 'evaluation', tab: 'runs', run_id: 'run-11111111-1111-4111-8111-111111111111' })
  assert.equal(navigationHash({ page: 'agents', tab: 'overview', run_id: 'run-11111111-1111-4111-8111-111111111111', run_tab: 'trace' }), '#/agents?run_id=run-11111111-1111-4111-8111-111111111111&tab=overview')
})

test('智能体列表视图独立于右侧详情页签并随地址往返恢复', () => {
  for (const list_view of ['agents', 'variants']) {
    const target = { page: 'agents', agent_id: 'test01', experiment_id: 'EXP-test01-002', list_view, tab: 'compute-variants' }
    assert.deepEqual(readNavigation(navigationHash(target)), target)
  }
})

test('旧链接保留原样，非法列表视图在读取和写入时均忽略', () => {
  const target = { page: 'agents', agent_id: 'test01', tab: 'assets' }
  assert.equal(navigationHash(target), '#/agents?agent_id=test01&tab=assets')
  assert.deepEqual(readNavigation(navigationHash(target)), target)
  for (const list_view of ['all', 'VARIANTS', '', '../../outside']) {
    assert.deepEqual(readNavigation(`#/agents?agent_id=test01&tab=assets&list_view=${encodeURIComponent(list_view)}`), target)
    assert.equal(navigationHash({ ...target, list_view }), navigationHash(target))
  }
})

test('统一网关有独立稳定路由，旧 MCP 地址保持原样', () => {
  assert.equal(navigationHash({ page: 'gateway' }), '#/gateway')
  assert.deepEqual(readNavigation('#/gateway'), { page: 'gateway' })
  for (const tab of ['identity', 'risk', 'authorization']) {
    const target = { page: 'gateway', tab }
    assert.deepEqual(readNavigation(navigationHash(target)), target)
  }
  assert.deepEqual(readNavigation('#/mcp'), { page: 'mcp' })
})

test('评测 Job、实例来源与 MCP 组合版本可精确往返，非法动作意图被忽略', () => {
  for (const target of [
    { page: 'evaluation', agent_id: 'demo', experiment_id: 'EXP-demo-001', job_id: '550e8400-e29b-41d4-a716-446655440000', tab: 'jobs' },
    { page: 'evaluation', agent_id: 'demo', experiment_id: 'EXP-demo-001', intent: 'start_eval' },
    { page: 'instances', instance_name: 'demo-001', source_id: 'experiment:EXP-demo-001', tab: 'logs' },
    { page: 'mcp', server_id: 'my-server', tab: 'servers' },
    { page: 'mcp', group_id: 'inspection-readonly', tab: 'connection' },
    { page: 'mcp', composition_id: 'risk-query', version: 'published', version_id: 'a'.repeat(64), tab: 'compositions' },
  ]) assert.deepEqual(readNavigation(navigationHash(target)), target)
  assert.deepEqual(readNavigation('#/evaluation?intent=delete&job_id=../../outside'), { page: 'evaluation' })
  assert.deepEqual(readNavigation('#/mcp?version=unknown'), { page: 'mcp' })
})

const require = createRequire(import.meta.url)
const shellViews = {
  './catalog.ts': 'export const createCatalog = () => {}',
  './home.tsx': 'export const HomePage = () => null; export const PlatformLogo = () => null',
  './agents/client.tsx': 'export const AgentsPage = () => null',
  './evaluation/client.tsx': 'export const EvaluationPage = () => null',
  './instances/client.tsx': 'export const InstancesPage = () => null',
  './mcp/client.tsx': 'export const McpPage = () => null',
  './business-control/ui.tsx': 'export const BusinessControlPage = () => null',
  './theme.ts': 'export const platformTheme = ""',
  './conversation.ts': 'export const prepareConversation = () => {}; export const bindNewConversation = () => {}',
  './assistant/client.tsx': 'export const AssistantConversation = () => null; export const AssistantOperations = () => null; export const PlatformOperationCard = () => null; export const createAssistant = () => {}',
  './realtime/client.ts': 'export const createPlatformUpdates = () => {}',
}
async function clientModule(path, exports, stubs) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  return (await build({ stdin: { contents: source + '\n' + exports, resolveDir: new URL(path, import.meta.url).pathname.replace(/\/[^/]+$/, ''), loader: 'tsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent',
    plugins: [{ name: 'isolated-child-views', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => stubs[args.path] === undefined ? undefined : { path: args.path, namespace: 'child-view' })
      builder.onLoad({ filter: /.*/, namespace: 'child-view' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    } }] })).outputFiles[0].text
}

function renderPage(source, component, props, initialHash = '#/mcp') {
  const states = [], dependencies = [], listeners = new Map()
  let cursor = 0, effects = [], changed = false, tree
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial; return [states[at], value => { states[at] = typeof value === 'function' ? value(states[at]) : value; changed = true }] },
    useRef(initial) { const at = cursor++; states[at] ??= { current: initial }; return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => value !== dependencies[at][index])) { dependencies[at] = deps; effects.push(effect) } },
    useLayoutEffect() {}, useCallback: value => value, useMemo: factory => factory(), useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
  const location = { hash: initialHash }, window = { location, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    history: { pushState(_state, _unused, hash) { location.hash = hash }, replaceState(_state, _unused, hash) { location.hash = hash } } }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : name === 'react-dom' ? {} : require(name),
    window, URL, URLSearchParams, document: { baseURI: 'http://127.0.0.1:3090/', addEventListener() {}, removeEventListener() {} } })
  const render = () => { let count = 0; do { if (++count > 20) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports[component](props); effects.forEach(effect => effect()) } while (changed); return tree }
  function nodes(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.flatMap(item => nodes(item)) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
  render()
  return { render, nodes, text, location, listeners, button: title => nodes().find(node => node.type === 'button' && text(node) === title) }
}
function themeStore(initial = 'light') {
  let scheme = initial
  const listeners = new Set()
  const writes = []
  return { writes, getScheme: () => scheme, setScheme(value) { scheme = value; writes.push(value); listeners.forEach(listener => listener()) },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) } }
}

test('一级导航可直接进入统一网关，单一管理页面保持挂载并随路由启停', async () => {
  const source = await clientModule('../src/client.tsx', 'export { PlatformPage }', shellViews)
  const contexts = [], state = { busy: false }, inventory = { inventory: { root: '/fixture-assets' } }
  const assistant = { subscribe() {}, getSnapshot: () => state, restore() {}, updateContext: value => contexts.push(value), reveal() {} }
  const theme = themeStore()
  const props = { assistant, theme, catalog: { subscribe() {}, getSnapshot: () => inventory }, updates: {}, rpc: { call: async () => ({ ok: true, value: { username: 'operator' } }) }, mcpForm: {},
    enterConversation() {}, showNativeConversation() {}, useSessionStatus: select => select(new Map()), renderSlot() {} }
  const ui = renderPage(source, 'PlatformPage', props)
  const gateway = () => ui.nodes().filter(node => node.type?.name === 'BusinessControlPage')
  const desktopNavigation = ui.nodes().find(node => node.type === 'nav' && node.props.className === 'harness-nav')
  const mobileNavigation = ui.nodes().find(node => node.type === 'nav' && node.props.className === 'harness-menu-navigation')
  const titles = ['首页', '管理对话', '智能体管理', '评测中心', '实例管理', '统一网关', 'MCP 管理']
  assert.deepEqual(ui.nodes(desktopNavigation).filter(node => node.type === 'button').map(ui.text), titles)
  assert.deepEqual(ui.nodes(mobileNavigation).filter(node => node.type === 'button').map(ui.text), titles)
  assert.equal(gateway().length, 1)
  assert.equal(gateway()[0].props.active, false)
  assert.equal(ui.nodes().some(node => node.type?.name === 'AgentsPage'), false, '尚未打开的页面不应在后台发起读取')
  ui.button('统一网关').props.onClick(); ui.render()
  assert.equal(ui.location.hash, '#/gateway')
  assert.equal(ui.button('统一网关').props['aria-current'], 'page')
  assert.equal(gateway()[0].props.active, true)
  assert.deepEqual({ ...contexts.at(-1) }, { page: 'gateway' })
  ui.button('MCP 管理').props.onClick(); ui.render()
  assert.equal(gateway().length, 1, '切换页面保持管理表单挂载以保留草稿')
  assert.equal(gateway()[0].props.active, false)
  assert.equal(ui.nodes().some(node => node.type?.name === 'McpPage'), true)
  ui.location.hash = '#/gateway'; ui.listeners.get('hashchange')(); ui.render()
  assert.equal(gateway()[0].props.active, true)
  const menu = () => ui.nodes().find(node => node.props?.className === 'harness-account-toggle')
  const actions = () => ui.nodes().find(node => node.props?.className === 'harness-account-actions')
  assert.equal(menu().props['aria-expanded'], false)
  menu().props.onClick(); ui.render()
  assert.equal(menu().props['aria-expanded'], true)
  assert.equal(actions().props['data-open'], true)
  ui.nodes().find(node => node.type === 'nav' && node.props.className === 'harness-menu-navigation').props.children[2].props.onClick(); ui.render()
  assert.equal(ui.location.hash, '#/agents')
  assert.equal(ui.nodes().find(node => node.props?.className === 'harness-current-module').props.children, '智能体管理')
  assert.equal(menu().props['aria-expanded'], false, '页面切换关闭导航菜单')
  menu().props.onClick(); ui.render()
  ui.nodes().find(node => node.props?.className === 'harness-account').props.onKeyDown({ key: 'Escape' }); ui.render()
  assert.equal(menu().props['aria-expanded'], false, 'Escape 关闭导航菜单')
  const brand = () => ui.nodes().find(node => node.props?.className === 'harness-brand')
  assert.equal(brand().props.href, '#/home')
  brand().props.onClick({ preventDefault() {} }); ui.render()
  assert.equal(ui.location.hash, '#/home', '品牌返回首页')
  const themeButton = () => ui.nodes().find(node => node.props?.className === 'harness-theme-toggle')
  assert.equal(themeButton().props['aria-label'], '切换到深色主题')
  themeButton().props.onClick(); ui.render()
  assert.deepEqual(theme.writes, ['dark'], '主题只写入 DSH 主题服务')
  assert.equal(themeButton().props['aria-label'], '切换到浅色主题')
  ui.button('智能体管理').props.onClick(); ui.render()
  assert.equal(themeButton().props['aria-label'], '切换到浅色主题', '导航切换后主题状态跟随服务')
  const restored = renderPage(source, 'PlatformPage', props, ui.location.hash)
  assert.equal(restored.nodes().find(node => node.props?.className === 'harness-theme-toggle').props['aria-label'], '切换到浅色主题', '刷新恢复 DSH 当前主题')
  const headerAssistant = ui.nodes().find(node => node.props?.className === 'harness-assistant-toggle')
  const floatingAssistant = ui.nodes().find(node => node.props?.className === 'harness-assistant-launch')
  assert.equal(headerAssistant.props['aria-expanded'], false)
  assert.equal(floatingAssistant.props['aria-expanded'], false)
  headerAssistant.props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.className === 'harness-assistant-launch').props['aria-expanded'], true, '顶部与右下入口共用助手状态')
})

test('浮窗分别显示当前 A 与固定任务 B 的名称、重复版本和精确对象入口', async () => {
  const source = await clientModule('../src/client.tsx', 'export { PlatformPage }', shellViews)
  const current = 'EXP-agent-a-003-r111111111111'
  const fixed = 'EXP-agent-b-003-r333333333333'
  const rows = { agents: [{ id: 'agent-a', name: '巡检助手' }, { id: 'agent-b', name: '维修助手' }], experiments: [
    { id: current, agent_id: 'agent-a', change: { variant_name: '快速巡检' } },
    { id: 'EXP-agent-a-003-r222222222222', agent_id: 'agent-a', change: { variant_name: '完整巡检' } },
    { id: fixed, agent_id: 'agent-b', change: { variant_name: '远程维修' } },
  ] }
  const calls = []
  const props = { assistant: { subscribe() {}, getSnapshot: () => ({ busy: false, status: { task_context: { agent_id: 'agent-b', source_id: `experiment:${fixed}` } } }), restore() {}, updateContext() {}, reveal() {} }, theme: themeStore(),
    catalog: { subscribe() {}, getSnapshot: () => ({ inventory: { root: '/fixture-assets' } }) },
    updates: { subscribe() { return () => {} }, getSnapshot: () => ({ domains: [] }) },
    rpc: { async call(_channel, operation) { calls.push(operation); return { ok: true, value: operation === 'agents/list' ? rows : { username: 'operator' } } } },
    enterConversation() {}, showNativeConversation() {}, useSessionStatus: select => select(new Map()), renderSlot() {} }
  const ui = renderPage(source, 'PlatformPage', props, `#/agents?agent_id=agent-a&experiment_id=${current}&tab=overview`)
  ui.nodes().find(node => node.props?.className === 'harness-assistant-toggle').props.onClick()
  ui.render()
  await Promise.resolve(); await Promise.resolve()
  ui.render()
  const context = ui.nodes().find(node => node.props?.className === 'harness-assistant-context')
  const content = ui.text(context)
  assert.match(content, /当前查看：智能体管理 · 巡检助手 · 快速巡检 · 版本 003 · 111111/)
  assert.match(content, /原任务固定对象：维修助手 · 远程维修 · 版本 003/)
  assert.doesNotMatch(content, /原任务固定对象：巡检助手/)
  assert.equal(calls.filter(operation => operation === 'agents/list').length, 1, '对象名称一次批量读取')
  const currentLink = ui.nodes().find(node => node.type === 'a' && ui.text(node) === '定位当前对象')
  const fixedLink = ui.nodes().find(node => node.type === 'a' && ui.text(node) === '查看任务对象')
  assert.equal(currentLink.props.href, `#/agents?agent_id=agent-a&experiment_id=${current}&tab=overview`)
  assert.equal(fixedLink.props.href, `#/agents?agent_id=agent-b&experiment_id=${fixed}&tab=overview`)
  assert.match(content, new RegExp(`当前查看 · 版本 ID${current}`), '完整身份可按需查看')
  fixedLink.props.onClick({ preventDefault() {} }); ui.render()
  assert.equal(ui.location.hash, fixedLink.props.href, '查看 B 不会把 A 的名称或版本拼到固定对象')

  const unknown = renderPage(source, 'PlatformPage', { ...props, rpc: { async call(_channel, operation) { return { ok: true, value: operation === 'agents/list' ? { agents: rows.agents.slice(0, 1), experiments: rows.experiments.slice(0, 2) } : { username: 'operator' } } } } },
    `#/agents?agent_id=agent-a&experiment_id=${current}`)
  unknown.nodes().find(node => node.props?.className === 'harness-assistant-toggle').props.onClick()
  unknown.render(); await Promise.resolve(); await Promise.resolve(); unknown.render()
  const unknownText = unknown.text(unknown.nodes().find(node => node.props?.className === 'harness-assistant-context'))
  assert.match(unknownText, new RegExp(`原任务固定对象：agent-b · ${fixed}`), '未知 B 使用自己的稳定 ID')
})

test('MCP 工作区仅保留四个工具页签，统一网关使用顶部一级入口', async () => {
  const source = await clientModule('../src/mcp/client.tsx', '', {
    'harness-mcp-manager-client': 'export const Manager = () => null',
    './threat-editor.tsx': 'export const compositionTestInput = () => {}; export const isThreatComposition = () => false; export const ThreatConfigurationFields = () => null; export const ThreatRunResult = () => null; export const threatEditorStyle = ""',
  })
  const state = { status: 'ready', revision: 'revision-1', value: {} }
  const ui = renderPage(source, 'McpPage', { form: { subscribe() {}, getSnapshot: () => state },
    rpc: { async call() { return { ok: true, value: {} } } } })
  const tabs = ui.nodes().find(node => node.type === 'nav' && node.props.className === 'harness-mcp-tabs')
  assert.deepEqual(Array.from(tabs.props.children, node => ui.text(node)), ['服务列表', '工具与资源分组', '工具与资源调试', '工具组合编排'])
  assert.equal(ui.nodes().some(node => node.type === 'button' && ui.text(node).includes('统一网关')), false)
  ui.button('工具组合编排').props.onClick(); ui.render()
  assert.equal(ui.button('工具组合编排').props['aria-current'], 'page')
  assert.equal(ui.nodes().some(node => node.type?.name === 'BusinessControlPage'), false)
})
