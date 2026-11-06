import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/branding.tsx', import.meta.url).pathname], bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] })).outputFiles[0].text
const module = { exports: {} }
const react = { ...require('react'), useCallback: fn => fn, useEffect() {}, useState: initial => [initial, () => {}],
  useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : require(name) })
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : []
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
const render = (snapshot, read, ensure = () => {}) => module.exports.BrandingSettingsRow({
  form: { getSnapshot: () => snapshot }, describe: { getSnapshot: () => read, ensure },
})

test('首次读取失败退出加载状态，提供原生重试且不允许保存默认值', async () => {
  let retries = 0
  const tree = render({ status: 'loading', writable: false }, { status: 'idle', error: '连接已中断' }, () => { retries++ })
  assert.match(text(tree), /读取配置失败：连接已中断/)
  assert.doesNotMatch(text(tree), /正在读取配置/)
  assert.ok(nodes(tree).filter(node => node.type === 'input').every(node => node.props.disabled))
  const retry = nodes(tree).find(node => node.type === 'button' && text(node) === '重新读取配置')
  assert.equal(retry.props.disabled, false)
  await retry.props.onClick()
  assert.equal(retries, 1)
})

test('重试中禁止重复操作，未装载的配置不伪装为持续加载或可编辑', () => {
  const retrying = render({ status: 'loading', writable: false }, { status: 'loading', error: '连接已中断' })
  assert.equal(nodes(retrying).find(node => node.type === 'button' && text(node) === '正在重试…').props.disabled, true)
  const missing = render({ status: 'unavailable', writable: true }, { status: 'ready', error: null, view: {} })
  assert.match(text(missing), /平台名称配置尚未装载/)
  assert.ok(nodes(missing).filter(node => node.type === 'input').every(node => node.props.disabled))
})

test('成功读取后显示实际值，后续刷新失败标明旧结果并保留编辑入口', () => {
  const snapshot = { status: 'ready', writable: true, value: { branding: { name: '研发平台', subtitle: '' } } }
  const tree = render(snapshot, { status: 'ready', error: '网络异常', view: {} })
  assert.match(text(tree), /当前显示上次读取结果/)
  assert.equal(nodes(tree).find(node => node.type === 'input').props.value, '研发平台')
  assert.ok(nodes(tree).filter(node => node.type === 'input').every(node => !node.props.disabled))
  assert.doesNotMatch(text(render(snapshot, { status: 'ready', error: null, view: {} })), /读取配置失败|正在读取配置/)
})
