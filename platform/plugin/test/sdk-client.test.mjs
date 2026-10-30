import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/agents/sdk-client.tsx', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
const source = bundled.outputFiles[0].text
const version = 'experiment:EXP-sdk-demo-001'
const guide = { workspace_id: 'workspace-one', markdown: '# 接入说明\n\n通过官方 SDK 调用。', example: 'new DeepSeekHarness({ profile: "sdk" })' }
const operation = { id: 'operation-one', workspace_id: guide.workspace_id, source: version, instance_id: 'sdk-demo-sdk', status: 'completed', final_response: '已完成', session_id: 'session-one', events: [{ method: 'session.event' }] }

function ui({ stored = new Map(), intercept, active = true, initialTab = 'debug', initialInstance } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], timers = new Map()
  let cursor = 0, effects = [], changed = false, tree, timerId = 0
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }, localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) }
  const modal = { open: false, showModal() { this.open = true }, close() { this.open = false } }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : require(name), localStorage, crypto: webcrypto, Uint8Array, setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) })
  const props = { active, source: version, agentId: 'sdk-demo', label: 'SDK 示例', initialTab, initialInstance, onClose() { props.active = false; changed = true }, rpc: { async call(channel, endpoint, payload) {
    calls.push({ channel, endpoint, payload })
    const result = intercept?.(endpoint, payload)
    if (result !== undefined) return await result
    if (endpoint === 'agents/sdk/guide') return { ok: true, value: guide }
    if (endpoint === 'agents/sdk/list') return { ok: true, value: [] }
    if (endpoint === 'instances/list') return { ok: true, value: { instances: [] } }
    if (endpoint === 'agents/sdk/status') return { ok: true, value: { ...operation, id: payload.operation_id } }
    if (endpoint === 'agents/sdk/start') return { ok: true, value: { ...operation, id: payload.request_id, instance_id: payload.instance_id } }
    if (endpoint === 'agents/sdk/stop') return { ok: true, value: { ...operation, id: payload.operation_id, status: 'stopped' } }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  } } }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...nodes(value.props?.children)] }
  function text(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(item => text(item)).join(''); if (value && typeof value === 'object') return text(value.props?.children); return typeof value === 'boolean' ? '' : String(value ?? '') }
  function render() { let count = 0; do { if (++count > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.SdkDebugDialog(props); tree.ref.current = modal; effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 8; index++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function button(name) { return nodes().find(item => item.type === 'button' && text(item) === name) }
  const input = () => nodes().find(item => item.type === 'textarea')
  function submit() { nodes().find(item => item.type === 'form').props.onSubmit({ preventDefault() {} }); render() }
  function cleanup() { cleanups.forEach(fn => fn?.()) }
  render()
  return { calls, props, render, settle, nodes, text, button, input, submit, stored, modal, timers, cleanup }
}

test('SDK调试恢复草稿和既有操作，只查询状态而不重放任务', async t => {
  const stored = new Map([[`harness-sdk:${guide.workspace_id}:${version}:`, JSON.stringify({ input: '保留的输入', instance: 'sdk-existing', operation_id: 'operation-one' })]])
  const page = ui({ stored }); t.after(page.cleanup); await page.settle()
  assert.equal(page.input().props.value, '保留的输入')
  assert.match(page.text(), /执行完成.*已完成/s)
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/start'), false)
  page.button('用于继续会话').props.onClick(); page.render()
  assert.equal(page.nodes().find(item => item.type === 'input' && item.props.placeholder === '留空创建新会话').props.value, 'session-one')
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/start'), false)
  page.button('关闭').props.onClick(); page.render()
  assert.equal(page.modal.open, false)
  assert.match(stored.get(`harness-sdk:${guide.workspace_id}:${version}:`), /保留的输入/)
})

test('SDK启动回执丢失后不自动重放，手动确认沿用同一请求身份', async t => {
  let submissions = 0
  const page = ui({ intercept(endpoint, payload) {
    if (endpoint === 'agents/sdk/start') {
      if (++submissions === 1) return Promise.reject(new Error('transport closed'))
      return { ok: true, value: { ...operation, id: payload.request_id } }
    }
  } }); t.after(page.cleanup); await page.settle()
  page.input().props.onChange({ target: { value: '运行一次' } }); page.render(); page.submit(); await page.settle()
  assert.equal(submissions, 1)
  assert.match(page.text(), /启动回执尚未收到/)
  assert.equal(page.button('启动并调试').props.disabled, true)
  page.button('重新确认本次请求').props.onClick(); page.render(); await page.settle()
  assert.equal(submissions, 2)
  const calls = page.calls.filter(item => item.endpoint === 'agents/sdk/start')
  assert.equal(calls[0].payload.request_id, calls[1].payload.request_id)
  assert.match(page.text(), /执行完成/)
})

test('SDK工作区切换不恢复其他工作区的输入和操作', async t => {
  const stored = new Map([[`harness-sdk:old-workspace:${version}:`, JSON.stringify({ input: '旧工作区内容', instance: 'old-instance', operation_id: 'old-operation' })]])
  const page = ui({ stored }); t.after(page.cleanup); await page.settle()
  assert.equal(page.input().props.value, '')
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/status'), false)
  assert.doesNotMatch(page.text(), /旧工作区内容/)
})

test('SDK状态回执错版本时不恢复操作或Session，不能停止其他目标的操作', async t => {
  const stored = new Map([[`harness-sdk:${guide.workspace_id}:${version}:`, JSON.stringify({ input: '当前输入', instance: 'sdk-demo-sdk', operation_id: 'operation-one' })]])
  const page = ui({ stored, intercept(endpoint) { if (endpoint === 'agents/sdk/status') return { ok: true, value: { ...operation, source: 'experiment:EXP-other-001', final_response: '其他任务结果' } } } }); t.after(page.cleanup); await page.settle()
  assert.match(page.text(), /调试回执与当前工作区或版本不一致.*已忽略该记录/s)
  assert.doesNotMatch(page.text(), /其他任务结果/)
  assert.equal(page.button('停止并核对原执行'), undefined)
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/start' || item.endpoint === 'agents/sdk/stop'), false)
})

test('SDK停止调用后台停止接口，切换文档保留当前输入', async t => {
  const page = ui({ intercept(endpoint, payload) { if (endpoint === 'agents/sdk/start') return { ok: true, value: { ...operation, id: payload.request_id, status: 'running' } } } }); t.after(page.cleanup); await page.settle()
  page.input().props.onChange({ target: { value: '需要保留的输入' } }); page.render(); page.submit(); await page.settle()
  page.button('接入文档').props.onClick(); page.render()
  assert.match(page.text(), /TypeScript 示例/)
  page.button('调试').props.onClick(); page.render()
  assert.equal(page.input().props.value, '需要保留的输入')
  page.button('停止本次执行').props.onClick(); page.render(); await page.settle()
  assert.equal(page.calls.filter(item => item.endpoint === 'agents/sdk/stop').length, 1)
  assert.match(page.text(), /已停止/)
})

test('SDK结果未知提供停止核对，实例身份冲突时保留未知且不重跑', async t => {
  const stored = new Map([[`harness-sdk:${guide.workspace_id}:${version}:`, JSON.stringify({ input: '原任务', instance: 'sdk-demo-sdk', operation_id: 'operation-one' })]])
  const page = ui({ stored, intercept(endpoint) {
    if (endpoint === 'agents/sdk/status') return { ok: true, value: { ...operation, status: 'unknown', final_response: undefined } }
    if (endpoint === 'agents/sdk/stop') return { ok: false, error: { code: 'sdk_operation_failed', message: '同名实例的运行身份已变化，未停止当前实例' } }
  } }); t.after(page.cleanup); await page.settle()
  assert.ok(page.button('停止并核对原执行'))
  page.button('停止并核对原执行').props.onClick(); page.render(); await page.settle()
  assert.match(page.text(), /结果待核对.*同名实例的运行身份已变化/s)
  assert.equal(page.button('启动并调试').props.disabled, true)
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/start'), false)
})

test('固定实例仅显示自身历史，忽略旧草稿中的其他实例和Session', async t => {
  const fixed = 'sdk-fixed', foreign = { ...operation, id: 'foreign-operation', instance_id: 'sdk-other', session_id: 'foreign-session' }
  const stored = new Map([[`harness-sdk:${guide.workspace_id}:${version}:${fixed}`, JSON.stringify({ input: '保留测试输入', instance: foreign.instance_id, session: foreign.session_id, operation_id: foreign.id, submission: { source: version, instance_id: foreign.instance_id, request_id: foreign.id, input: '其他输入' } })]])
  const own = { ...operation, instance_id: fixed }
  const page = ui({ initialInstance: fixed, stored, intercept(endpoint) { if (endpoint === 'agents/sdk/list') return { ok: true, value: [own, foreign] } } }); t.after(page.cleanup); await page.settle()
  const instance = page.nodes().find(item => item.props?.['aria-label'] === '实例名称')
  const session = page.nodes().find(item => item.props?.['aria-label'] === '恢复 Session（可选）')
  assert.equal(instance.props.value, fixed)
  assert.equal(instance.props.disabled, true)
  assert.equal(session.props.value, '')
  assert.equal(page.input().props.value, '保留测试输入')
  assert.ok(page.button(`${fixed} · 执行完成`))
  assert.equal(page.button(`${foreign.instance_id} · 执行完成`), undefined)
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/status' || item.endpoint === 'agents/sdk/start'), false)
  assert.equal(JSON.parse(stored.get(`harness-sdk:${guide.workspace_id}:${version}:${fixed}`)).submission, null)
})

test('固定实例恢复回执仍核对实际instance_id，错误回执不带入Session或操作', async t => {
  const fixed = 'sdk-fixed', key = `harness-sdk:${guide.workspace_id}:${version}:${fixed}`
  const stored = new Map([[key, JSON.stringify({ input: '当前输入', instance: fixed, session: 'foreign-session', operation_id: operation.id })]])
  const page = ui({ initialInstance: fixed, stored }); t.after(page.cleanup); await page.settle()
  assert.match(page.text(), /调试回执与当前实例不一致/)
  assert.equal(page.nodes().find(item => item.props?.['aria-label'] === '恢复 Session（可选）').props.value, '')
  assert.equal(page.button('查询执行状态'), undefined)
  assert.equal(page.button('停止并核对原执行'), undefined)
  assert.equal(JSON.parse(stored.get(key)).operation_id, undefined)
})

test('切换历史或手动切换实例清除旧Session和重提请求，继续会话同步实例', async t => {
  const second = { ...operation, id: 'operation-two', instance_id: 'sdk-second', session_id: 'session-two' }
  const page = ui({ intercept(endpoint) { if (endpoint === 'agents/sdk/list') return { ok: true, value: [operation, second] } } }); t.after(page.cleanup); await page.settle()
  const session = () => page.nodes().find(item => item.props?.['aria-label'] === '恢复 Session（可选）')
  const instance = () => page.nodes().find(item => item.props?.['aria-label'] === '实例名称')
  session().props.onChange({ target: { value: 'old-session' } }); page.render()
  page.button('sdk-second · 执行完成').props.onClick(); page.render()
  assert.equal(instance().props.value, 'sdk-second')
  assert.equal(session().props.value, '')
  page.button('用于继续会话').props.onClick(); page.render()
  assert.equal(session().props.value, 'session-two')
  instance().props.onChange({ target: { value: 'sdk-third' } }); page.render()
  assert.equal(session().props.value, '')
  page.button('用于继续会话').props.onClick(); page.render()
  assert.equal(instance().props.value, 'sdk-second')
  assert.equal(session().props.value, 'session-two')
  const record = JSON.parse(page.stored.get(`harness-sdk:${guide.workspace_id}:${version}:`))
  assert.equal(record.submission, null)
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/start'), false)
})

test('迟到guide期间禁止编辑，恢复草稿后用户输入不会被覆盖', async t => {
  let resolveGuide
  const stored = new Map([[`harness-sdk:${guide.workspace_id}:${version}:`, JSON.stringify({ input: '保存的草稿', instance: 'sdk-demo-sdk' })]])
  const page = ui({ stored, intercept(endpoint) { if (endpoint === 'agents/sdk/guide') return new Promise(resolve => { resolveGuide = resolve }) } }); t.after(page.cleanup)
  assert.equal(page.input().props.disabled, true)
  assert.equal(page.nodes().find(item => item.props?.['aria-label'] === '恢复 Session（可选）').props.disabled, true)
  resolveGuide({ ok: true, value: guide }); await page.settle()
  assert.equal(page.input().props.value, '保存的草稿')
  assert.equal(page.input().props.disabled, false)
  page.input().props.onChange({ target: { value: '新的用户输入' } }); page.render(); await page.settle()
  assert.equal(page.input().props.value, '新的用户输入')
  assert.equal(JSON.parse(stored.get(`harness-sdk:${guide.workspace_id}:${version}:`)).input, '新的用户输入')
  assert.equal(page.calls.some(item => item.endpoint === 'agents/sdk/start'), false)
})
