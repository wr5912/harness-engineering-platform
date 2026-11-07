import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/assistant/workspace-file-search.tsx', import.meta.url).pathname], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })

function fixture(listFiles) {
  const states = [], deps = [], cleanups = [], opened = []
  let cursor, effects, changed, tree, mounted = 'session-one'
  const props = { sessionId: mounted, absolutePath: '/workspace', listFiles,
    sidebar: { mounted: { getSnapshot: () => mounted, subscribe: () => () => {} }, openResource: address => opened.push(address) } }
  const react = { ...require('react'),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { const next = typeof value === 'function' ? value(states[i]) : value; if (!Object.is(next, states[i])) { states[i] = next; changed = true } }] },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i] },
    useId: () => 'file-search-test', useSyncExternalStore: (_subscribe, read) => read(),
    useEffect(effect, values) { const i = cursor++; if (!deps[i] || values.some((value, at) => value !== deps[i][at])) { deps[i] = values; effects.push(() => { cleanups[i]?.(); cleanups[i] = effect() }) } },
  }
  const primitives = { FileTypeIcon: () => null, Tooltip: props => props.children, MenuSurface: props => require('react').createElement('div', props),
    useAnchoredPosition: () => ({ left: 12, top: 80 }), useDismissOnOutsidePointer: () => {} }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, document: { body: {} }, Error, AbortController, setTimeout, clearTimeout,
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name) })
  const resolve = value => Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object' && typeof value.type === 'function' ? resolve(value.type(value.props))
    : value && typeof value === 'object' ? { ...value, props: { ...value.props, children: resolve(value.props?.children ?? '') } } : value
  function render() { let count = 0; do { if (++count > 30) throw new Error('render did not settle'); cursor = 0; effects = []; changed = false; tree = resolve(module.exports.WorkspaceFileSearch(props)); effects.forEach(effect => effect()) } while (changed) }
  function nodes(value = tree) { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children ?? [])] : [] }
  function text(value = tree) { return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? value.type === 'style' ? '' : text(value.props?.children ?? '') : String(value ?? '') }
  const press = name => { const button = nodes().find(node => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name || node.props.title === name)); assert.ok(button, `button ${name}`); button.props.onClick(); render() }
  const query = value => { nodes().find(node => node.type === 'input').props.onChange({ target: { value } }); render() }
  const settle = async (ms = 0) => { await new Promise(resolve => setTimeout(resolve, ms)); render() }
  render()
  return { props, opened, nodes, text, render, press, query, settle, mount: value => { mounted = value; render() }, close: () => cleanups.forEach(cleanup => cleanup?.()) }
}

test('关键字原样交给原生递归检索；目录逐级浏览，文件交给原生预览', async () => {
  const calls = []
  const ui = fixture(async (session, query) => {
    calls.push([session, query])
    return { ok: true, value: query.endsWith('/') ? [{ path: '未展开/中文 report.md', kind: 'file' }] : [{ path: '未展开', kind: 'directory' }] }
  })
  try {
    ui.press('查找文件和文件夹'); assert.match(ui.text(), /输入关键字/); assert.equal(calls.length, 0)
    ui.query('  未展开  '); await ui.settle(230); assert.deepEqual(calls, [['session-one', '未展开']])
    ui.press('未展开'); await ui.settle(230); assert.equal(calls.at(-1)[1], '未展开/')
    ui.press('返回上级'); assert.equal(ui.nodes().find(node => node.type === 'input').props.value, '')
    ui.query('REPORT'); await ui.settle(230); assert.equal(calls.at(-1)[1], 'REPORT')
    ui.press('未展开'); await ui.settle(230); ui.press('未展开/中文 report.md')
    assert.equal(ui.opened.length, 1); assert.match(ui.opened[0], /^dsh-resource:\/\/file\/session\/session-one\//)
    assert.match(ui.opened[0], /%E4%B8%AD%E6%96%87/); assert.match(ui.opened[0], /%20/)
    assert.equal(ui.nodes().some(node => node.props.role === 'dialog'), false)
  } finally { ui.close() }
})

test('防抖合并输入；迟到结果和关闭后的回执不能覆盖新查询', async () => {
  const calls = []
  const ui = fixture((session, query, signal) => new Promise(resolve => calls.push({ session, query, signal, resolve })))
  try {
    ui.press('查找文件和文件夹'); ui.query('a'); ui.query('ab'); await ui.settle(230)
    assert.equal(calls.length, 1); assert.equal(calls[0].query, 'ab')
    ui.query('new'); assert.equal(calls[0].signal.aborted, true); await ui.settle(230)
    calls[1].resolve({ ok: true, value: [{ kind: 'file', path: 'new.txt' }] }); await ui.settle()
    calls[0].resolve({ ok: true, value: [{ kind: 'file', path: 'old.txt' }] }); await ui.settle()
    assert.match(ui.text(), /new.txt/); assert.doesNotMatch(ui.text(), /old.txt/)
    ui.query('closing'); await ui.settle(230); ui.press('关闭文件查找'); assert.equal(calls[2].signal.aborted, true)
    calls[2].resolve({ ok: true, value: [{ kind: 'file', path: 'late.txt' }] }); await ui.settle()
    assert.doesNotMatch(ui.text(), /late.txt/); assert.equal(ui.opened.length, 0)
  } finally { ui.close() }
})

test('检索失败明确提示并可重试；空结果及原生数量限制如实展示', async () => {
  let attempts = 0
  const ui = fixture(async () => {
    attempts++
    if (attempts === 1) throw new Error('连接断开')
    if (attempts === 2) return { ok: false, error: { message: '目录不可读取' } }
    return { ok: true, value: attempts === 3 ? [] : Array.from({ length: 20 }, (_, i) => ({ kind: 'file', path: `same-name/${i}/REPORT.md` })) }
  })
  try {
    ui.press('查找文件和文件夹'); ui.query('REPORT'); await ui.settle(230); assert.match(ui.text(), /连接断开/)
    ui.press('重试'); await ui.settle(230); assert.match(ui.text(), /目录不可读取/)
    ui.press('重试'); await ui.settle(230); assert.match(ui.text(), /当前检索范围内没有匹配项/)
    ui.query('report'); await ui.settle(230); assert.equal(ui.nodes().filter(node => node.type === 'li').length, 20)
    assert.match(ui.text(), /最多显示 20 项/); assert.match(ui.text(), /same-name\/19\/REPORT.md/)
    ui.press('清空'); assert.match(ui.text(), /输入关键字/)
  } finally { ui.close() }
})

test('切换会话或工作区取消请求且隐藏面板；旧结果不能打开错误会话', async () => {
  const calls = []
  const ui = fixture((session, query, signal) => new Promise(resolve => calls.push({ session, query, signal, resolve })))
  try {
    ui.press('查找文件和文件夹'); ui.query('secret'); await ui.settle(230)
    ui.mount('session-two'); assert.equal(calls[0].signal.aborted, true)
    calls[0].resolve({ ok: true, value: [{ kind: 'file', path: 'secret.txt' }] }); await ui.settle()
    assert.equal(ui.nodes().some(node => node.props.role === 'dialog'), false)
    ui.props.sessionId = 'session-two'; ui.render(); ui.press('查找文件和文件夹'); ui.query('new'); await ui.settle(230)
    ui.props.absolutePath = '/other-workspace'; ui.render(); assert.equal(calls[1].signal.aborted, true)
    assert.equal(ui.nodes().some(node => node.props.role === 'dialog'), false); assert.equal(ui.opened.length, 0)
  } finally { ui.close() }
})
