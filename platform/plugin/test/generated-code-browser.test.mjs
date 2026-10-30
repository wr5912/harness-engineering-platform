import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/components/generated-code-browser.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
const file = (path, entry = false) => ({ path, entry, kind: path.endsWith('.js') ? 'artifact' : 'source', language: 'ts', sha256: path.padEnd(64, 'a'), bytes: 42, asset_path: `candidate/${path}` })
const catalog = (identity = 'server-one') => ({ identity, notes: ['实际文件清单'], files: [file('src/index.ts', true), file('src/context.ts'), file('dist/index.js')] })
const read = (file, identity = 'server-one') => ({ identity, path: file.path, sha256: file.sha256, bytes: file.bytes, complete: true, truncated: false, redacted: false, content: `SOURCE:${file.path}` })
function browser(overrides = {}) {
  const states = [], deps = [], cleanups = []; let cursor, effects, changed, tree
  const props = { identity: 'object-one', loadCatalog: async () => catalog(), loadFile: async file => read(file), ...overrides }
  const react = { ...require('react'),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { const next = typeof value === 'function' ? value(states[i]) : value; if (!Object.is(next, states[i])) { states[i] = next; changed = true } }] },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i] },
    useEffect(effect, values) { const i = cursor++; if (!deps[i] || values.some((value, at) => value !== deps[i][at])) { deps[i] = values; effects.push(() => { cleanups[i]?.(); cleanups[i] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, Error, require: name => name === 'react' ? react : require(name) })
  const resolve = value => Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object' && typeof value.type === 'function' ? resolve(value.type(value.props)) : value && typeof value === 'object' ? { ...value, props: { ...value.props, children: resolve(value.props?.children ?? '') } } : value
  function render() { let count = 0; do { if (++count > 30) throw new Error('render did not settle'); cursor = 0; effects = []; changed = false; tree = resolve(module.exports.GeneratedCodeBrowser(props)); effects.forEach(effect => effect()) } while (changed) }
  async function settle() { for (let i = 0; i < 5; i++) { render(); await new Promise(resolve => setImmediate(resolve)) }; render() }
  function nodes(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children ?? [])] : [] }
  function text(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? value.type === 'style' ? '' : text(value.props?.children ?? '') : String(value ?? '') }
  const button = name => nodes().find(node => node.type === 'button' && text(node) === name)
  const select = path => { nodes().find(node => node.type === 'select').props.onChange({ target: { value: path } }); render() }
  render()
  return { props, settle, render, nodes, text, button, select, close: () => cleanups.forEach(cleanup => cleanup?.()) }
}
test('共享浏览器列出多文件树、入口、类型、完整SHA并切换和跳转资产', async () => {
  const opened = [], ui = browser({ onOpenAsset: path => opened.push(path) })
  try {
    await ui.settle(); assert.match(ui.text(), /3 个相关文件/); assert.match(ui.text(), /SOURCE:src\/index.ts/)
    assert.equal(ui.nodes().filter(node => node.type === 'option').length, 3)
    assert.match(ui.text(), /入口/); assert.match(ui.text(), /源码（2）/); assert.match(ui.text(), /构建产物（1）/)
    ui.select('src/context.ts'); await ui.settle(); assert.match(ui.text(), /SOURCE:src\/context.ts/); assert.doesNotMatch(ui.text(), /SOURCE:src\/index.ts/)
    ui.button('到资产查看或编辑此文件').props.onClick(); assert.deepEqual(opened, ['candidate/src/context.ts'])
    assert.equal(ui.nodes().find(node => node.type === 'pre').props.tabIndex, 0)
    const css = ui.nodes().find(node => node.type === 'style').props.children
    assert.match(css, /max-width:600px/); assert.match(css, /minmax\(0,1fr\)/); assert.match(css, /overflow:auto;white-space:pre/)
  } finally { ui.close() }
})
test('失败可重试，截断脱敏不能被称为完整文件，目录失败保留清单说明', async () => {
  let attempts = 0, catalogs = 0
  const ui = browser({ loadCatalog: async () => { if (catalogs++) throw new Error('目录读取失败'); return catalog() }, loadFile: async file => { if (!attempts++) throw new Error('暂时无法读取'); return { ...read(file), complete: false, truncated: true, redacted: true } } })
  try {
    await ui.settle(); assert.match(ui.text(), /暂时无法读取/)
    ui.button('重试读取文件').props.onClick(); await ui.settle(); assert.match(ui.text(), /内容已脱敏/); assert.doesNotMatch(ui.text(), /完整文件内容/)
    ui.button('刷新文件目录').props.onClick(); await ui.settle(); assert.match(ui.text(), /以下保留上次文件清单/)
  } finally { ui.close() }
})
test('迟到文件/目录不得覆盖新选择或另一对象，相同路径也核身份与SHA', async () => {
  let resolveOld, resolveDirectory
  const ui = browser({ loadFile: file => file.entry ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(read(file)) })
  try {
    await ui.settle(); ui.select('src/context.ts'); await ui.settle()
    resolveOld(read(file('src/index.ts', true))); await ui.settle()
    assert.match(ui.text(), /SOURCE:src\/context.ts/); assert.doesNotMatch(ui.text(), /SOURCE:src\/index.ts/)
    ui.props.loadCatalog = () => new Promise(resolve => { resolveDirectory = resolve })
    ui.button('刷新文件目录').props.onClick(); await ui.settle()
    ui.props.identity = 'object-two'; ui.props.loadCatalog = async () => catalog('server-two'); ui.props.loadFile = async file => read(file, 'server-two'); await ui.settle()
    resolveDirectory(catalog('server-one')); await ui.settle()
    assert.match(ui.text(), /SOURCE:src\/context.ts/)
    ui.props.loadFile = async file => ({ ...read(file, 'server-two'), sha256: 'bad' }); ui.select('dist/index.js'); await ui.settle()
    assert.match(ui.text(), /读取结果与当前文件不一致/); assert.doesNotMatch(ui.text(), /SOURCE:dist/)
  } finally { ui.close() }
})

test('文件读取在途刷新目录失败时结束loading并可重试，旧文件回执不复活', async () => {
  let catalogs = 0, fileReads = 0, release
  const ui = browser({ loadCatalog: async () => { if (catalogs++) throw new Error('目录刷新失败'); return catalog() }, loadFile: file => ++fileReads === 1 ? new Promise(resolve => { release = () => resolve(read(file)) }) : Promise.resolve(read(file)) })
  try {
    await ui.settle(); assert.match(ui.text(), /正在读取所选文件/)
    ui.button('刷新文件目录').props.onClick(); await ui.settle()
    assert.match(ui.text(), /目录刷新失败/); assert.doesNotMatch(ui.text(), /正在读取所选文件/)
    assert.ok(ui.button('重试读取文件'))
    release(); await ui.settle(); assert.doesNotMatch(ui.text(), /SOURCE:src\/index.ts/)
    ui.button('重试读取文件').props.onClick(); await ui.settle()
    assert.match(ui.text(), /SOURCE:src\/index.ts/); assert.doesNotMatch(ui.text(), /正在读取所选文件/)
  } finally { ui.close() }
})
