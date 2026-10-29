import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

// 编译实际页面源码；只隔离原生管理器与提示/模态入口、React 调度和 RPC 网络边界。
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
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Tooltip: props => props.children, Modal: props => props.open ? props.children : null } : require(name), URL, Blob,
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
  const stepInputs = editor.nodes().find(node => typeof node.type === 'function' && node.type.name === 'StepInputFields')
  editor.mount(stepInputs.type, stepInputs.props)
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


async function modelEditor(value, rpc) {
  const ui = await page({ call: async () => ({ ok: true, value: state }) })
  ui.nodes().find(node => node.type === 'button' && ui.text(node).startsWith('threat-inferthreat-infer')).props.onClick(); ui.render()
  ui.button('继续编辑草稿').props.onClick(); ui.render()
  const fields = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'ThreatConfigurationFields')
  ui.mount(fields.type, { ...fields.props, value: { ...stage('infer', 'infer').draft, bindings: value }, rpc })
  const bindings = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'BindingsFields')
  ui.mount(bindings.type, bindings.props)
  const model = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'ThreatModelField')
  const changed = []
  ui.mount(model.type, { ...model.props, change(value) { changed.push(value); ui.props().value = value } })
  await tick(); ui.render()
  return { ui, changed, select: label => ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === label) }
}
const platformModels = { catalog: { groups: [{ id: 'login-model', name: '平台登录', models: [{ id: 'account-model', name: '登录模型', reasoning: { defaultEffort: 'adaptive', efforts: [{ id: 'adaptive', name: '自动推理' }, { id: 'precise', name: '精确推理' }] } }] }], routableProviders: ['login-model'] }, business_allowed: [] }

test('研判模型使用真实平台目录与模型推理档位，不受业务实例范围或硬编码默认限制', async t => {
  const calls = []
  const view = await modelEditor({ socConnectionId: 'soc', reportConnectionId: 'report' }, { call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: platformModels } } })
  const { ui, select, changed } = view; t.after(ui.dispose)
  select('研判模型使用方式').props.onChange({ target: { value: 'explicit' } }); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(changed.at(-1).model)), { provider: '', model: '' })
  assert.equal(select('研判模型').props.required, true)
  assert.equal(select('研判模型').props.value, '')
  assert.match(ui.text(), /登录模型/)
  select('研判模型').props.onChange({ target: { value: JSON.stringify(['login-model', 'account-model']) } }); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(changed.at(-1).model)), { provider: 'login-model', model: 'account-model' })
  const efforts = ui.nodes(select('研判推理档位')).filter(node => node.type === 'option').map(node => node.props.value)
  assert.deepEqual(efforts, ['', 'adaptive', 'precise'])
  select('研判推理档位').props.onChange({ target: { value: 'precise' } }); ui.render()
  assert.equal(changed.at(-1).model.reasoningEffort, 'precise')
  assert.equal(ui.nodes().some(node => node.type === 'input'), false)
  assert.deepEqual(calls, ['models/list'])
})

test('失效研判模型或档位保留原路由，读取失败可重试且不会发起模型调用', async t => {
  const calls = []; let failed = true
  const original = { provider: 'missing-provider', model: 'old-model', reasoningEffort: 'old-effort' }
  const { ui, select, changed } = await modelEditor({ socConnectionId: 'soc', reportConnectionId: 'report', model: original }, { call: async (_channel, endpoint) => {
    calls.push(endpoint)
    return failed ? { ok: false, error: { message: '目录暂不可用' } } : { ok: true, value: platformModels }
  } }); t.after(ui.dispose)
  assert.match(ui.text(), /目录暂不可用/)
  assert.match(ui.text(), /missing-provider \/ old-model/)
  assert.equal(select('研判模型').props.disabled, true)
  assert.equal(select('研判推理档位').props.value, 'old-effort')
  assert.equal(changed.length, 0)
  failed = false; ui.button('重试读取模型').props.onClick(); ui.render(); await tick(); ui.render()
  assert.equal(select('研判模型').props.disabled, false)
  assert.match(ui.text(), /原模型当前不可选/)
  assert.match(ui.text(), /原档位当前不可选：old-effort/)
  assert.equal(changed.length, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(ui.props().value.model)), original)
  assert.deepEqual(calls, ['models/list', 'models/list'])
})

test('取证结果继续下一阶段只带入同一真实Run，不自动执行或选择另一连接', async t => {
  const calls = []
  const runId = 'run-00000000-0000-4000-8000-000000000001'
  const other = stage('other-infer', 'infer'); other.draft.bindings.socConnectionId = 'another-soc'
  const ui = await page({ call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'mcp/executeComposition') return { ok: true, value: { ok: true, result: { run_id: runId, phase_status: 'completed', status: 'evidence_ready', route: 'five_source' } } }
    if (endpoint === 'mcp/dryRunComposition') return { ok: true, value: { mode: 'dry', graph, checks: [], unverified: [], upstreamRequests: 0 } }
    return { ok: true, value: { ...state, compositions: [...state.compositions, other] } }
  } }); t.after(ui.dispose)
  ui.nodes().find(node => node.type === 'button' && ui.text(node).startsWith('threat-collectthreat-collect')).props.onClick(); ui.render()
  ui.nodes().find(node => node.props?.['aria-label'] === '组合事件 ID').props.onChange({ target: { value: 'INC-20261015-000001' } }); ui.render()
  ui.button('实际执行组合工具').props.onClick(); await tick(); ui.render()
  const next = ui.nodes().find(node => node.props?.['aria-label'] === '继续当前运行')
  assert.equal(ui.nodes(next).filter(node => node.type === 'button').length, 1)
  assert.match(ui.text(next), /继续模型研判.*threat-infer/)
  ui.nodes(next).find(node => node.type === 'button').props.onClick(); ui.render()
  assert.match(ui.text(), /已带入上一阶段返回的运行/)
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '组合运行 ID').props.value, runId)
  assert.equal(calls.filter(call => call.endpoint === 'mcp/executeComposition').length, 1)
  assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '组合事件 ID'), false)
  ui.button('测试（dry）').props.onClick(); await tick(); ui.render()
  const dry = calls.find(call => call.endpoint === 'mcp/dryRunComposition')
  assert.equal(dry.payload.compositionId, 'threat-infer')
  assert.deepEqual(JSON.parse(JSON.stringify(dry.payload.input)), { run_id: runId })
  ui.nodes().find(node => node.type === 'button' && ui.text(node).startsWith('threat-reportthreat-report')).props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '组合运行 ID').props.value, '')
  assert.doesNotMatch(ui.text(), /已带入上一阶段返回的运行/)
})

test('失败阶段不提示普通续跑，快速完成分支直接准备回写而不补跑模型', async t => {
  let succeeded = false
  let returned = { run_id: 'run-real', phase_status: 'failed', status: 'evidence_failed', route: 'five_source' }
  const calls = []
  const ui = await page({ call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: endpoint === 'mcp/executeComposition' ? { ok: succeeded, result: returned } : state } } }); t.after(ui.dispose)
  ui.nodes().find(node => node.type === 'button' && ui.text(node).startsWith('threat-collectthreat-collect')).props.onClick(); ui.render()
  ui.nodes().find(node => node.props?.['aria-label'] === '组合事件 ID').props.onChange({ target: { value: 'INC-20261015-000001' } }); ui.render()
  ui.button('实际执行组合工具').props.onClick(); await tick(); ui.render()
  assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '继续当前运行'), false)
  returned = { ...returned, phase_status: 'completed', status: 'completed', route: 'fast_path' }
  ui.button('实际执行组合工具').props.onClick(); await tick(); ui.render()
  assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '继续当前运行'), false)
  succeeded = true
  ui.button('实际执行组合工具').props.onClick(); await tick(); ui.render()
  const next = ui.nodes().find(node => node.props?.['aria-label'] === '继续当前运行')
  assert.match(ui.text(next), /继续结果回写/)
  assert.doesNotMatch(ui.text(next), /继续模型研判/)
  assert.equal(calls.filter(endpoint => endpoint === 'mcp/executeComposition').length, 3)
})

async function stepEditor(config, entries) {
  const ui = await page({ call: async () => ({ ok: true, value: state }) })
  ui.button('继续编辑草稿').props.onClick(); ui.render()
  const fields = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'ThreatConfigurationFields')
  let changed
  ui.mount(fields.type, { ...fields.props, value: config, entries, change(value) { changed = value; ui.props().value = value } })
  return { ui, changed: () => changed }
}
const pinnedStages = ['collect', 'infer'].map(phase => { const config = stage(`pinned-${phase}`, phase).draft; return { id: `pinned-${phase}`, published: config, versions: [{ versionId: `${phase}-v1`, config }] } })

test('步骤key自动生成且不提供编辑，新子步骤按真实入参建立事件与前序Run映射', async t => {
  const view = await stepEditor({ ...parent.draft, steps: [] }, pinnedStages)
  const { ui } = view; t.after(ui.dispose)
  ui.button('增加子步骤').props.onClick(); ui.render()
  assert.equal(view.changed().steps[0].id, 'step1')
  assert.equal(ui.nodes().some(node => node.type === 'input' && node.props.value === 'step1'), false)
  const select = (title, at = 0) => ui.nodes(ui.nodes().filter(node => node.type === 'label' && ui.text(node).startsWith(title))[at]).find(node => node.type === 'select')
  select('已发布子组合').props.onChange({ target: { value: 'pinned-collect' } }); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(view.changed().steps[0].inputMap)), { incident_id: '$input.incident_id' })
  select('固定发布版本').props.onChange({ target: { value: 'collect-v1' } }); ui.render()
  ui.button('增加子步骤').props.onClick(); ui.render()
  assert.equal(view.changed().steps[1].id, 'step2')
  select('已发布子组合', 1).props.onChange({ target: { value: 'pinned-infer' } }); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(view.changed().steps[1].inputMap)), { run_id: '$steps.step1.run_id' })
  assert.equal(view.changed().steps[0].id, 'step1')
})

test('高级映射与旧步骤引用不改写；资产输入不从事件或未知输出推测', async t => {
  const complex = { incident_id: { nested: '$steps.legacy.run_id' } }
  const config = { ...parent.draft, steps: [{ id: 'old-key', compositionId: 'pinned-collect', versionId: 'collect-v1', inputMap: complex }] }
  const { ui } = await stepEditor(config, pinnedStages); t.after(ui.dispose)
  const component = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'StepInputFields')
  const changes = []
  ui.mount(component.type, { ...component.props, change(value) { changes.push(value) } })
  assert.match(ui.text(), /保留已有高级映射/)
  const mapping = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'InputMapping')
  ui.mount(mapping.type, mapping.props)
  assert.equal(ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'DetailDrawer').props.title, '高级输入映射')
  assert.deepEqual(JSON.parse(JSON.stringify(mapping.props.value)), complex)
  assert.equal(changes.length, 0)
  const asset = { id: 'assets', published: { toolName: 'assets', title: '资产查询', description: '', connectionId: 'soc' }, versions: [] }
  asset.versions.push({ versionId: 'asset-v1', config: asset.published })
  ui.mount(component.type, { step: { id: 'asset-step', compositionId: 'assets', versionId: 'asset-v1', inputMap: { asset: '' } }, previous: config.steps, entries: [...pinnedStages, asset], change(value) { changes.push(value) } })
  const options = ui.nodes().filter(node => node.type === 'option')
  assert.equal(options.some(node => String(node.props.value).startsWith('$input') || String(node.props.value).startsWith('$steps')), false)
  assert.match(ui.text(), /资产 ID、主机名或 IP/)
})


test('复合子链不承诺Run输出，常见来源不从复合结果自动制造运行引用', async t => {
  const child = { ...parent.draft, steps: [{ id: 'assets', compositionId: 'assets', versionId: 'asset-v1', inputMap: { asset: '9106' } }] }
  const composite = { id: 'child-chain', published: child, versions: [{ versionId: 'chain-v1', config: child }] }
  const view = await stepEditor({ ...parent.draft, steps: [{ id: 'chain', compositionId: 'child-chain', versionId: 'chain-v1', inputMap: { incident_id: '$input.incident_id' } }, { id: 'next', compositionId: '', versionId: '', inputMap: {} }] }, [...pinnedStages, composite]); const { ui } = view; t.after(ui.dispose)
  const label = ui.nodes().filter(node => node.type === 'label' && ui.text(node).startsWith('已发布子组合'))[1]
  ui.nodes(label).find(node => node.type === 'select').props.onChange({ target: { value: 'pinned-infer' } }); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(view.changed().steps[1].inputMap)), { run_id: '' })
  const input = ui.nodes().filter(node => typeof node.type === 'function' && node.type.name === 'StepInputFields')[1]
  ui.mount(input.type, input.props)
  assert.equal(ui.nodes().filter(node => node.type === 'option').some(node => node.props.value === '$steps.chain.run_id'), false)
  assert.match(ui.text(), /前序步骤尚无可引用的运行结果/)
})

test('高级映射抽屉关页保留非法输入，错误向草稿保存回传而不提交旧映射', async t => {
  const calls = []
  const ui = await page({ call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: state } } }); t.after(ui.dispose)
  ui.button('继续编辑草稿').props.onClick(); ui.render()
  const fields = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'ThreatConfigurationFields')
  fields.props.onValidityChange(false); ui.render()
  assert.equal(ui.button('保存草稿').props.disabled, true)
  assert.equal(ui.button('暂存并返回详情').props.disabled, true)
  ui.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await tick(); ui.render()
  assert.equal(calls.includes('mcp/saveCompositionDraft'), false)
  fields.props.onValidityChange(true); ui.render()
  assert.equal(ui.button('保存草稿').props.disabled, false)
  let validity
  ui.mount(fields.type, { ...fields.props, value: parent.draft, active: true, identity: 'parent:r1', onValidityChange(value) { validity = value } })
  const step = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'StepInputFields')
  ui.mount(step.type, step.props)
  const mapping = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'InputMapping')
  let error
  ui.mount(mapping.type, { ...mapping.props, onValidityChange(value) { error = value } })
  ui.nodes().find(node => node.type === 'textarea').props.onChange({ target: { value: '{bad' }, currentTarget: { setCustomValidity() {} } }); ui.render()
  assert.equal(error, '输入映射必须是 JSON 对象')
  ui.props().active = false; ui.render()
  assert.equal(ui.nodes().find(node => node.type === 'textarea').props.value, '{bad')
  const drawer = ui.nodes().find(node => typeof node.type === 'function' && node.type.name === 'DetailDrawer')
  assert.equal(drawer.props.active, false)
  assert.equal(drawer.props.identity, 'parent:r1:collect')
  assert.match(ui.text(), /未完成的输入仍保留/)
})
