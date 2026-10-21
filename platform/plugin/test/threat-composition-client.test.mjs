import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

// 编译实际页面源码；只隔离原生管理器入口、React 调度和 RPC 网络边界。
const compiled = await build({
  stdin: { contents: readFileSync(new URL('../src/mcp/client.tsx', import.meta.url), 'utf8') + '\nexport { CompositionPage };', resolveDir: new URL('../src/mcp/', import.meta.url).pathname, loader: 'tsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'manager-boundary', setup(builder) {
    builder.onResolve({ filter: /^harness-mcp-manager-client$/ }, () => ({ path: 'manager', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function Manager() { return null }' }))
  } }],
})
const require = createRequire(import.meta.url)
function client() {
  const states = [], deps = [], cleanups = []
  let cursor = 0, changed = false, effects = [], tree, Component, props
  const react = { ...require('react'),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { const next = typeof value === 'function' ? value(states[index]) : value; if (next !== states[index]) { states[index] = next; changed = true } }]
    },
    useRef(initial) { const index = cursor++; return states[index] ??= { current: initial } },
    useEffect(effect, next = []) { const index = cursor++; if (!deps[index] || next.some((value, at) => value !== deps[index][at])) { deps[index] = next; effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), URL, Blob,
    window: { addEventListener() {}, removeEventListener() {} }, requestAnimationFrame: callback => callback(),
    document: { baseURI: 'http://127.0.0.1:3090/hep/' } })
  // 子组件通过实际页面元素传出，保持与生产引用相同的函数。
  function mount(component, value) { cleanups.forEach(cleanup => cleanup?.()); states.length = deps.length = cleanups.length = 0; Component = component; props = value; return render() }
  function render() { for (let i = 0; i < 20; i++) { cursor = 0; effects = []; changed = false; tree = Component(props); effects.forEach(effect => effect()); if (!changed) return tree } throw new Error('render did not settle') }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object') return []; return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? value.props?.children === undefined ? '' : text(value.props.children) : String(value ?? '') }
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label)
  return { exports: module.exports, mount, render, nodes, text, button, props: () => props, dispose: () => cleanups.forEach(cleanup => cleanup?.()) }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const graph = { nodes: [{ id: 'compiled-stage', title: '实际编译阶段', operationId: 'infer', input: { run_id: '$input.run_id' }, output: 'run' }], edges: [{ source: '__start__', target: 'compiled-stage' }, { source: 'compiled-stage', target: '__end__' }] }
const stage = (id, phase) => ({ id, draft: { kind: 'threat-stage', stage: phase, toolName: id, title: id, description: '', connectionId: 'platform-compositions', bindings: { socConnectionId: 'soc', reportConnectionId: 'report' } }, graphs: { draft: graph } })
const parent = { id: 'threat-analysis', draft: { kind: 'composite', toolName: 'threat-analysis', title: '总组合', description: '', connectionId: 'platform-compositions', steps: [{ id: 'collect', compositionId: 'threat-collect', versionId: '', inputMap: { incident_id: '$input.incident_id' } }] }, graphs: { draft: graph } }
const state = { extension: { id: 'fixture-security', seed: true, flow: true, stages: true }, revision: 'r1', connections: [{ id: 'soc', kind: 'openapi' }, { id: 'report', kind: 'mcp-http' }], compositions: [parent, ...['collect', 'infer', 'writeback', 'report'].map(phase => stage(`threat-${phase}`, phase))] }

async function page(rpc) {
  const ui = client()
  ui.mount(ui.exports.CompositionPage, { rpc, configuration: {}, active: true, onCatalogChange() {} })
  await tick(); ui.render()
  return ui
}

test('页面读取已有编排，阶段测试使用run_id并显示服务端编译节点', async t => {
  const calls = []
  const ui = await page({ call: async (channel, endpoint, payload) => {
    calls.push({ channel, endpoint, payload })
    return { ok: true, value: endpoint === 'mcp/dryRunComposition' ? { mode: 'dry', graph, checks: [], unverified: [], upstreamRequests: 0 } : state }
  } })
  t.after(ui.dispose)
  assert.equal(ui.button('威胁分析样例'), undefined)
  assert.equal(calls.some(call => call.endpoint === 'mcp/seedThreatCompositions'), false)
  assert.ok(ui.nodes().some(node => node.props?.['aria-label'] === '组合事件 ID'))
  ui.nodes().find(node => node.type === 'button' && ui.text(node).startsWith('threat-inferthreat-infer')).props.onClick(); ui.render()
  const input = ui.nodes().find(node => node.props?.['aria-label'] === '组合运行 ID')
  input.props.onChange({ target: { value: 'run-basic' } }); ui.render()
  ui.button('测试（dry）').props.onClick(); await tick(); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.endpoint === 'mcp/dryRunComposition').payload.input)), { run_id: 'run-basic' })
  assert.match(ui.text(), /实际编译阶段/)
  assert.equal(calls.some(call => call.endpoint === 'mcp/executeComposition'), false)
})

test('编排只列一次，草稿与发布状态并存且发布版本仍可选择', async t => {
  const draft = { toolName: 'query_assets', title: '资产查询草稿', description: '', connectionId: 'soc' }
  const published = { ...draft, title: '资产查询发布版', publishedAt: '2026-10-16T00:00:00Z' }
  const ui = await page({ call: async () => ({ ok: true, value: { ...state, compositions: [
    { id: 'both', draft, published, graphs: { draft: graph, published: graph } },
    { id: 'published-only', published: { ...published, title: '已发布的另一编排' }, graphs: { published: graph } },
    { id: 'draft-only', draft: { ...draft, title: '新草稿' }, graphs: { draft: graph } },
  ] } }) })
  t.after(ui.dispose)
  const list = () => ui.nodes().find(node => node.props?.['aria-label'] === '工具编排列表')
  const rows = () => ui.nodes(list()).filter(node => node.type === 'li')
  assert.equal(rows().length, 3)
  assert.match(ui.text(rows()[0]), /已发布.*正在编辑/)
  assert.equal(ui.nodes(list()).filter(node => node.type === 'section').length, 1)
  assert.ok(ui.button('当前发布版本'))
  ui.button('当前发布版本').props.onClick(); ui.render()
  assert.equal(ui.button('当前发布版本').props['aria-pressed'], true)
  assert.equal(ui.nodes(rows()[0]).find(node => node.type === 'button').props['aria-current'], 'true')
  assert.ok(ui.nodes().some(node => node.type === 'h2' && ui.text(node) === '资产查询发布版'))
  ui.nodes(rows()[1]).find(node => node.type === 'button').props.onClick(); ui.render()
  assert.ok(ui.nodes().some(node => node.type === 'h2' && ui.text(node) === '已发布的另一编排'))
  assert.equal(ui.button('编辑草稿'), undefined)
})

test('总组合固定子版本可编辑，切换引用清空旧版本，非法映射不覆盖有效草稿', async t => {
  const ui = await page({ call: async () => ({ ok: true, value: state }) })
  t.after(ui.dispose)
  ui.button('继续编辑草稿').props.onClick(); ui.render()
  const fields = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'ThreatConfigurationFields')
  let changed
  const config = { ...parent.draft, steps: [{ ...parent.draft.steps[0], versionId: 'old-version' }] }
  const entries = [{ id: 'threat-collect', published: stage('threat-collect', 'collect').draft, versions: [{ versionId: 'old-version' }, { versionId: 'new-version' }] }, { id: 'threat-infer', published: stage('threat-infer', 'infer').draft, versions: [{ versionId: 'infer-version' }] }]
  const editor = ui
  editor.mount(fields.type, { ...fields.props, value: config, entries, change: value => { changed = value } })
  const select = title => editor.nodes(editor.nodes().find(node => node.type === 'label' && editor.text(node).startsWith(title))).find(node => node.type === 'select')
  assert.equal(select('固定发布版本').props.required, undefined)
  select('固定发布版本').props.onChange({ target: { value: 'new-version' } })
  assert.equal(changed.steps[0].versionId, 'new-version')
  select('已发布子组合').props.onChange({ target: { value: 'threat-infer' } })
  assert.equal(changed.steps[0].compositionId, 'threat-infer')
  assert.equal(changed.steps[0].versionId, '')
  const mapping = editor.nodes().find(node => typeof node.type === 'function' && node.type.name === 'InputMapping')
  let accepted, validity
  editor.mount(mapping.type, { value: mapping.props.value, change: value => { accepted = value } })
  const target = { setCustomValidity: value => { validity = value } }
  editor.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: '[' }, currentTarget: target })
  editor.render()
  assert.equal(accepted, undefined)
  assert.equal(validity, '输入映射必须是 JSON 对象')
  assert.equal(editor.nodes().find(node => node.type === 'textarea').props['aria-invalid'], true)
  editor.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: '{"run_id":"$steps.collect.run_id"}' }, currentTarget: target })
  assert.deepEqual(JSON.parse(JSON.stringify(accepted)), { run_id: '$steps.collect.run_id' })
  assert.equal(validity, '')
  editor.mount(fields.type, { ...fields.props, value: { ...stage('threat-infer', 'infer').draft, bindings: { socConnectionId: 'soc', reportConnectionId: 'report', model: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' } } }, entries, change: value => { changed = value } })
  assert.equal(editor.nodes().find(node => typeof node.type === 'function' && node.type.name === 'BindingsFields').props.model, true)
  select('业务阶段').props.onChange({ target: { value: 'collect' } })
  assert.equal(changed.stage, 'collect')
  assert.equal(changed.bindings.model, undefined)
})

async function runView(execution, rpc) {
  const pageUi = await page({ call: async (_channel, endpoint) => ({ ok: true, value: endpoint === 'mcp/executeComposition' ? execution : state }) })
  pageUi.nodes().find(node => node.type === 'button' && pageUi.text(node).startsWith('threat-collectthreat-collect')).props.onClick(); pageUi.render()
  pageUi.nodes().find(node => node.props?.['aria-label'] === '组合事件 ID').props.onChange({ target: { value: 'INC-20261015-000001' } }); pageUi.render()
  pageUi.button('实际执行组合工具').props.onClick(); await tick(); pageUi.render()
  const result = pageUi.nodes().find(node => typeof node.type === 'function' && node.type.name === 'ThreatRunResult')
  pageUi.mount(result.type, { execution, rpc })
  return { ui: pageUi, dispose() { pageUi.dispose() } }
}

test('阶段完成不会显示整体成功，运行产物只读获取且HTML按文本呈现', async t => {
  const calls = []
  const execution = { ok: true, result: { phase_status: 'completed', status: 'model_failed', run_id: 'run-basic', validation: { status: 'failed' }, artifacts: [{ id: 'report.html', name: '基础报告', content_type: 'text/html', bytes: 20 }], delivery: { markdown: '基础模拟研判摘要', storage: { report: { status: 'failed', download_url: 'file:///tmp/basic-report.html' } } } } }
  const view = await runView(execution, { call: async (_channel, endpoint, payload) => { calls.push({ endpoint, payload }); return { ok: true, value: { filename: 'report.html', contentType: 'text/html', body: '<h1>基础报告</h1>' } } } })
  t.after(view.dispose)
  const { ui } = view
  assert.match(ui.text(), /阶段状态：completed · 研判状态：model_failed/)
  assert.doesNotMatch(ui.text(), /组合执行成功/)
  assert.ok(ui.nodes().some(node => node.props?.role === 'alert' && ui.text(node) === '输出校验未通过，以下模型内容需要人工复核，不能视为已核实结论。'))
  assert.ok(ui.nodes().some(node => node.type === 'pre' && node.props.children === execution.result.delivery.markdown))
  assert.equal(ui.nodes().some(node => node.type === 'a' && node.props.href.startsWith('file:')), false)
  await ui.button('基础报告').props.onClick(); await tick(); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ endpoint: 'mcp/compositionArtifact', payload: { run_id: 'run-basic', artifactId: 'report.html' } }])
  assert.ok(ui.nodes().some(node => node.type === 'pre' && node.props.children === '<h1>基础报告</h1>'))
  assert.equal(ui.nodes().some(node => node.props?.dangerouslySetInnerHTML || node.type === 'iframe'), false)
})

test('切换运行后旧上下文响应不能覆盖新运行状态', async t => {
  let resolve
  const view = await runView({ result: { run_id: 'run-first', phase_status: 'completed', status: 'evidence_ready' } }, { call: () => new Promise(done => { resolve = done }) })
  t.after(view.dispose)
  const { ui } = view
  ui.button('刷新运行上下文').props.onClick()
  ui.props().execution = { result: { run_id: 'run-next', phase_status: 'failed', status: 'model_failed' } }
  ui.render()
  resolve({ ok: true, value: { run_id: 'run-first', phase_status: 'completed', status: 'completed' } })
  await tick(); ui.render()
  assert.match(ui.text(), /run-next/)
  assert.match(ui.text(), /研判状态：model_failed/)
  assert.doesNotMatch(ui.text(), /run-first/)
})
