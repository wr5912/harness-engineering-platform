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
  assert.deepEqual(readNavigation('#/mcp'), { page: 'mcp' })
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
  './conversation.ts': 'export const prepareConversation = () => {}',
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
    window, URL, URLSearchParams, document: { baseURI: 'http://127.0.0.1:3090/' } })
  const render = () => { let count = 0; do { if (++count > 20) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports[component](props); effects.forEach(effect => effect()) } while (changed); return tree }
  function nodes(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.flatMap(item => nodes(item)) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : [] }
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
  render()
  return { render, nodes, text, location, listeners, button: title => nodes().find(node => node.type === 'button' && text(node) === title) }
}

test('一级导航可直接进入统一网关，单一管理页面保持挂载并随路由启停', async () => {
  const source = await clientModule('../src/client.tsx', 'export { PlatformPage }', shellViews)
  const contexts = [], state = { busy: false }, inventory = { inventory: { root: '/fixture-assets' } }
  const assistant = { subscribe() {}, getSnapshot: () => state, restore() {}, updateContext: value => contexts.push(value), reveal() {} }
  const ui = renderPage(source, 'PlatformPage', { assistant, catalog: { subscribe() {}, getSnapshot: () => inventory }, updates: {}, rpc: {}, mcpForm: {},
    enterConversation() {}, showNativeConversation() {}, useSessionStatus: select => select(new Map()), renderSlot() {} })
  const gateway = () => ui.nodes().filter(node => node.type?.name === 'BusinessControlPage')
  assert.equal(ui.nodes().filter(node => node.type === 'button' && ui.text(node) === '统一网关').length, 1)
  assert.equal(gateway().length, 1)
  assert.equal(gateway()[0].props.active, false)
  ui.button('统一网关').props.onClick(); ui.render()
  assert.equal(ui.location.hash, '#/gateway')
  assert.equal(ui.button('统一网关').props['aria-current'], 'page')
  assert.equal(gateway()[0].props.active, true)
  assert.deepEqual({ ...contexts.at(-1) }, { page: 'gateway' })
  ui.button('MCP 管理').props.onClick(); ui.render()
  assert.equal(gateway().length, 1, '切换页面保持管理表单挂载以保留草稿')
  assert.equal(gateway()[0].props.active, false)
  ui.location.hash = '#/gateway'; ui.listeners.get('hashchange')(); ui.render()
  assert.equal(gateway()[0].props.active, true)
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
