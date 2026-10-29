import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/evaluation/trace-view.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
const file = 'evolution/experiments/EXP-alpha-001/runs/run-basic/evidence/C-1/trace.jsonl'
const event = (line, session = 'root.jsonl') => ({ ref: { path: file, line, session_log: session, seq: line, event_id: null, source_sha256: 'source-fixed', line_sha256: 'line-fixed' }, type: 'user/message', role: 'target', status: 'valid', event: { type: 'user/message', data: { content: [{ type: 'text', text: `基础事件 ${line}` }] } } })
const result = (events = [event(1)], next_cursor = 1) => ({ files: [{ path: file, role: 'target', size: 100, warnings: [] }], path: file, source_sha256: 'source-fixed', events, decisions: [], total_lines: 2, next_cursor, warnings: [] })

function ui(handler, focus, path) {
  const states = [], deps = [], cleanups = [], calls = [], evidence = []
  let cursor, effects, changed, tree
  const react = {
    ...require('react'),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { const next = typeof value === 'function' ? value(states[index]) : value; if (!Object.is(next, states[index])) { states[index] = next; changed = true } }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect(effect, next) { const index = cursor++; if (!deps[index] || next.some((value, at) => value !== deps[index][at])) { deps[index] = next; effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: () => null } : require(name) })
  const props = { runId: 'run-a', focus, path, send: async (endpoint, payload) => { calls.push({ endpoint, payload }); return handler(endpoint, payload) }, onEvidence: path => evidence.push(path) }
  function render() { let rounds = 0; do { if (++rounds > 40) throw new Error('渲染未收敛'); cursor = 0; effects = []; changed = false; tree = module.exports.RunTraceView(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let at = 0; at < 5; at++) { render(); await new Promise(resolve => setImmediate(resolve)) }; return render() }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...nodes(value.props?.children)] }
  function text(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(item => text(item)).join(''); return value && typeof value === 'object' ? text(value.props?.children ?? '') : String(value ?? '') }
  render()
  return { render, settle, nodes, text, calls, evidence, button: name => nodes().find(node => node.type === 'button' && text(node) === name), setRun(value) { props.runId = value; render() }, cleanup() { cleanups.forEach(cleanup => cleanup?.()) } }
}

test('结构化轨迹分页固定源摘要并隔离展示父子 Session，证据链接保持真实路径', async () => {
  const view = ui(async (_endpoint, payload) => payload.cursor ? result([event(2, 'descendants/child.jsonl')], null) : result())
  await view.settle()
  assert.equal(view.calls[0].endpoint, 'runs/trace')
  assert.ok(view.text().includes('root.jsonl'))
  view.button('继续加载轨迹').props.onClick()
  await view.settle()
  assert.equal(view.calls[1].payload.cursor, 1)
  assert.equal(view.calls[1].payload.source_sha256, 'source-fixed')
  assert.ok(view.text().includes('descendants/child.jsonl'))
  assert.equal(view.button('继续加载轨迹'), undefined)
  view.button('查看来源文件').props.onClick()
  assert.deepEqual(view.evidence, [file])
  view.cleanup()
})

test('切换 Run 后忽略旧请求，失败明确显示而不把已有轨迹误配给新 Run', async () => {
  let resolveOld
  const view = ui(async (_endpoint, payload) => payload.run_id === 'run-a' ? new Promise(resolve => { resolveOld = resolve }) : { ok: false, error: { message: '未采集轨迹' } })
  view.setRun('run-b')
  await view.settle()
  resolveOld(result())
  await view.settle()
  assert.ok(view.text().includes('未采集轨迹'))
  assert.equal(view.text().includes('基础事件 1'), false)
  assert.equal(view.nodes().some(node => node.props?.['aria-label'] === 'Session root.jsonl'), false)
  view.cleanup()
})


test('样本来源定位从指定轨迹行加载并展开，刷新仍保留时点', async () => {
  const view = ui(async (_endpoint, payload) => result([event(payload.cursor + 1)], null), { path: file, line: 141, source_sha256: 'source-fixed' })
  await view.settle()
  assert.equal(view.calls[0].payload.path, file); assert.equal(view.calls[0].payload.cursor, 140); assert.equal(view.calls[0].payload.source_sha256, 'source-fixed')
  const focused = view.nodes().find(node => node.props?.id === 'harness-trace-focused-source')
  assert.equal(focused.props.children.props.open, true)
  assert.match(view.text(), /样本来源定位.*第 141 行/s)
  view.button('刷新轨迹').props.onClick(); await view.settle(); assert.equal(view.calls.at(-1).payload.cursor, 140); assert.equal(view.calls.at(-1).payload.source_sha256, 'source-fixed')
  view.cleanup()
})


test('来源摘要不一致时显示真实错误，不把变动轨迹当成原样本证据', async () => {
  const view = ui(async () => ({ ok: false, error: { message: '轨迹来源摘要已改变' } }), { path: file, line: 141, source_sha256: 'source-old' })
  await view.settle()
  assert.equal(view.calls[0].payload.source_sha256, 'source-old'); assert.match(view.text(), /轨迹来源摘要已改变/)
  assert.equal(view.nodes().some(node => node.props?.id === 'harness-trace-focused-source'), false)
  view.button('刷新轨迹').props.onClick(); await view.settle(); assert.equal(view.calls.at(-1).payload.source_sha256, 'source-old')
  view.cleanup()
})


test('产物文件嵌入模式锁定选中来源，刷新不退回其他轨迹文件', async () => {
  const selected = file.replace('C-1', 'C-2')
  const view = ui(async (_endpoint, payload) => ({ ...result(), path: selected, files: [{ path: file, role: 'target', size: 100, warnings: [] }, { path: selected, role: 'judge', size: 100, warnings: [] }] }), undefined, selected)
  try {
    await view.settle()
    assert.equal(view.calls[0].payload.path, selected)
    assert.equal(view.nodes().some(node => node.props?.['aria-label'] === '结构化轨迹来源'), false)
    assert.ok(view.nodes().some(node => node.props?.['aria-label'] === '结构化轨迹 Session'))
    view.button('刷新轨迹').props.onClick(); await view.settle()
    assert.equal(view.calls.at(-1).payload.path, selected)
  } finally { view.cleanup() }
})


test('轨迹事件保留原位选择，长事件与定位合为单个按行绑定的旁路抽屉', async () => {
  const view = ui(async () => result([event(1)], null))
  try {
    await view.settle()
    const drawer = view.nodes().find(node => node.type?.name === 'DetailDrawer')
    assert.equal(drawer.props.title, '第 1 行事件与证据详情')
    assert.equal(drawer.props.identity, `run-a:${file}:1`)
    assert.equal(drawer.props.active, true)
    assert.match(view.text(drawer), /原始事件（脱敏副本）/)
    assert.match(view.text(drawer), /证据定位与原始摘要/)
    assert.equal(view.nodes().filter(node => node.type === 'details').length, 1)
  } finally { view.cleanup() }
})
