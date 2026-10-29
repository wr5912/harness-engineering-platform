import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/evaluation/cases-editor.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
function dialog(sourceRun, onCall) {
  const states = [], dependencies = [], cleanups = []
  let cursor, effects, changed, tree, failSave = false, sha = 'initial', generatedId = 'U-NEW-001', closed = 0
  const calls = [], saved = [], listeners = new Set(), dirties = [], busyStates = []
  const modal = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  const react = {
    ...require('react'),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { const next = typeof value === 'function' ? value(states[index]) : value; if (!Object.is(next, states[index])) { states[index] = next; changed = true } }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: index === 0 ? modal : initial }; return states[index] },
    useEffect(effect, deps) { const index = cursor++; if (!dependencies[index] || deps.some((value, at) => value !== dependencies[index][at])) { dependencies[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), window: { confirm: () => true, addEventListener: (name, fn) => { if (name === 'beforeunload') listeners.add(fn) }, removeEventListener: (name, fn) => listeners.delete(fn) } })
  const props = { agentId: 'alpha', experimentId: 'EXP-alpha-001', sourceRun, active: true, onDirty: value => dirties.push(value), onBusy: value => busyStates.push(value), onSaved: value => saved.push(value), onClose: () => closed++, rpc: { call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    await onCall?.(endpoint, payload)
    if (endpoint.endsWith('create-context') || endpoint.endsWith('from-run')) return { ok: true, value: { agent_id: 'alpha', sha256: sha, scenes: ['基础'], ...(sourceRun ? { source_run_id: sourceRun.run_id, source_case_id: sourceRun.case_id } : {}), draft: { case_id: generatedId, title: sourceRun ? '复现输入' : '', scene: '基础', inputs: [sourceRun ? '冻结的用户输入' : ''], expected_behavior: '', fast: false } } }
    if (failSave && endpoint.endsWith('cases/create')) return { ok: false, error: { code: 'conflict', message: '文件已被其他任务修改' } }
    if (endpoint.endsWith('create-preview')) return { ok: true, value: { diff: '+#### U-NEW-001 新用例' } }
    if (endpoint.endsWith('cases/create')) return { ok: true, value: { case: { ...payload, id: payload.case_id }, sha256: 'saved', path: 'agents/alpha/evaluation.md' } }
    throw new Error(`unexpected endpoint ${endpoint}`)
  } } }
  function render() { let count = 0; do { if (++count > 50) throw new Error('render did not settle'); cursor = 0; changed = false; effects = []; tree = module.exports.CaseCreationDialog(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 6; index++) { render(); await new Promise(resolve => setImmediate(resolve)) }; return render() }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.map(item => text(item)).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
  const byLabel = label => nodes().find(node => node.props?.['aria-label'] === label)
  const button = title => nodes().find(node => node.type === 'button' && text(node) === title)
  function change(label, value) { byLabel(label).props.onChange({ target: { value, checked: value } }); render() }
  render()
  return { settle, text, calls, saved, byLabel, button, change, listeners, modal, dirties, busyStates, get closed() { return closed }, setActive(value) { props.active = value; render() }, setFailSave(value) { failSave = value }, setSha(value) { sha = value }, setGeneratedId(value) { generatedId = value }, cleanup() { cleanups.forEach(cleanup => cleanup?.()) } }
}

test('新增对话框先预览再确认，保存回调携带新 Case 供上层立即刷新选择', async () => {
  const ui = dialog()
  try {
    await ui.settle()
    assert.equal(ui.button('确认新增用例').props.disabled, true)
    assert.equal(ui.byLabel('新增用例 ID'), undefined)
    assert.equal(ui.text(ui.byLabel('新增用例编号')), 'U-NEW-001')
    ui.change('新增用例名称', '基础新用例'); ui.change('新增用例第 1 轮输入', '请查询基础目录'); ui.change('新增用例预期行为', '展示基础目录')
    await ui.button('预览差异').props.onClick(); await ui.settle()
    assert.equal(ui.button('确认新增用例').props.disabled, false)
    ui.change('新增用例预期行为', '展示目录并说明范围')
    assert.equal(ui.button('确认新增用例').props.disabled, true, '任何编辑都必须使旧预览失效')
    await ui.button('预览差异').props.onClick(); await ui.settle()
    await ui.button('确认新增用例').props.onClick(); await ui.settle()
    assert.equal(ui.saved[0].case.id, 'U-NEW-001'); assert.equal(ui.closed, 1)
    assert.equal(ui.calls.find(item => item.endpoint.endsWith('cases/create')).payload.expected_sha256, 'initial')
  } finally { ui.cleanup() }
})

test('从 Run 转用例保留来源，预期为空且多轮输入可编辑', async () => {
  const source = { run_id: 'run-11111111-1111-4111-8111-111111111111', case_id: 'U-CASE-001' }
  const ui = dialog(source)
  try {
    await ui.settle()
    assert.equal(ui.calls[0].endpoint, 'agents/cases/from-run')
    assert.equal(ui.byLabel('新增用例预期行为').props.value, '')
    assert.equal(ui.byLabel('新增用例第 1 轮输入').props.value, '冻结的用户输入')
    ui.button('＋ 添加一轮输入').props.onClick(); await ui.settle()
    ui.change('新增用例第 2 轮输入', '请续查同一次结果'); ui.change('新增用例预期行为', '复用前一次标识')
    await ui.button('预览差异').props.onClick(); await ui.settle()
    const preview = ui.calls.find(item => item.endpoint.endsWith('create-preview'))
    assert.equal(preview.payload.source_run_id, source.run_id); assert.equal(preview.payload.source_case_id, source.case_id)
    assert.deepEqual([...preview.payload.inputs], ['冻结的用户输入', '请续查同一次结果'])
  } finally { ui.cleanup() }
})

test('保存冲突保留全部草稿，显式重读后必须再次预览才可保存', async () => {
  const ui = dialog()
  try {
    await ui.settle(); ui.change('新增用例名称', '必须保留的名称'); ui.change('新增用例第 1 轮输入', '新的失败输入'); ui.change('新增用例预期行为', '人工判断的正确行为')
    await ui.button('预览差异').props.onClick(); await ui.settle(); ui.setFailSave(true)
    await ui.button('确认新增用例').props.onClick(); await ui.settle()
    assert.ok(ui.text().includes('当前草稿已保留'))
    assert.equal(ui.byLabel('新增用例名称').props.value, '必须保留的名称')
    assert.equal(ui.byLabel('新增用例预期行为').props.value, '人工判断的正确行为')
    assert.equal(ui.saved.length, 0); assert.equal(ui.closed, 0)
    ui.setSha('new-version'); ui.setGeneratedId('U-NEW-002'); ui.setFailSave(false)
    await ui.button('保留草稿并重读最新版本').props.onClick(); await ui.settle()
    assert.equal(ui.byLabel('新增用例名称').props.value, '必须保留的名称')
    assert.equal(ui.text(ui.byLabel('新增用例编号')), 'U-NEW-002', '新增用例编号冲突时由后端重新分配，用户内容保留')
    assert.equal(ui.button('确认新增用例').props.disabled, true)
    await ui.button('预览差异').props.onClick(); await ui.settle()
    await ui.button('确认新增用例').props.onClick(); await ui.settle()
    assert.equal(ui.calls.filter(item => item.endpoint.endsWith('cases/create')).at(-1).payload.expected_sha256, 'new-version')
    assert.equal(ui.calls.filter(item => item.endpoint.endsWith('cases/create')).at(-1).payload.case_id, 'U-NEW-002')
    assert.equal(ui.saved.length, 1)
  } finally { ui.cleanup() }
})

test('父页面停用时关闭模态层但保留草稿，重新激活不重复读取来源', async () => {
  const ui = dialog()
  try {
    await ui.settle(); assert.equal(ui.modal.open, true); assert.equal(ui.busyStates.at(-1), false)
    ui.change('新增用例名称', '切页仍保留的草稿'); assert.equal(ui.dirties.at(-1), true)
    const reads = ui.calls.length
    ui.setActive(false); await ui.settle(); assert.equal(ui.modal.open, false)
    ui.setActive(true); await ui.settle(); assert.equal(ui.modal.open, true)
    assert.equal(ui.byLabel('新增用例名称').props.value, '切页仍保留的草稿'); assert.equal(ui.calls.length, reads)
  } finally { ui.cleanup() }
  assert.equal(ui.dirties.at(-1), false); assert.equal(ui.busyStates.at(-1), false)
})

test('保存待返回时向父页报告 busy 并阻止关闭，完成后回传新 Case', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = dialog(undefined, async endpoint => { if (endpoint.endsWith('cases/create')) await pending })
  try {
    await ui.settle(); ui.change('新增用例名称', '保存中的用例'); ui.change('新增用例第 1 轮输入', '查询基本状态'); ui.change('新增用例预期行为', '展示基本状态')
    ui.button('预览差异').props.onClick(); await ui.settle()
    ui.button('确认新增用例').props.onClick(); await ui.settle()
    assert.equal(ui.busyStates.at(-1), true); assert.equal(ui.button('关闭').props.disabled, true)
    ui.button('关闭').props.onClick(); await ui.settle(); assert.equal(ui.closed, 0)
    release(); await ui.settle(); assert.equal(ui.saved.length, 1); assert.equal(ui.closed, 1); assert.equal(ui.busyStates.at(-1), false)
  } finally { ui.cleanup() }
})
