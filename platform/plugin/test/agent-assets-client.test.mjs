import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
async function component(name, file, props) {
  const states = [], dependencies = []
  let cursor = 0, changed = false, tree, effects = []
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(effect) } },
  }
  const source = (await build({ entryPoints: [new URL(`../src/agents/${file}`, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })).outputFiles[0].text
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: () => null } : require(name) })
  function render() { let count = 0; do { if (++count > 20) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports[name](props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let i = 0; i < 3; i++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function nodes(value = tree) { if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object') return []; return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value = tree) { if (Array.isArray(value)) return value.map(text).join(''); return value && typeof value === 'object' ? text(value.props?.children ?? '') : String(value ?? '') }
  render()
  return { nodes, text, render, settle, setActive(value) { props.active = value; render() }, button: name => nodes().find(node => node.type === 'button' && text(node) === name) }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }

test('新建智能体先预览，冲突保留填写，成功显示独立研究版本且不自动启动', async () => {
  const calls = [], created = [], selected = []
  let conflict = true
  const receipt = { agent_id: 'daily-assistant', experiment_id: 'EXP-daily-assistant-001-r123456789abc', name: '日常助手', note: '角色已创建，尚未启动。', started: false }
  const ui = await component('CreateAgentDialog', 'create-agent-client.tsx', { active: true, onClose() {}, onCreated: value => created.push(value), onSelect: value => selected.push(value), rpc: { async call(channel, endpoint, payload) { calls.push({ endpoint, payload }); return conflict ? { ok: false, error: { code: 'conflict', message: 'ID 已存在' } } : { ok: true, value: receipt } } } })
  const fill = () => { const inputs = ui.nodes().filter(node => node.type === 'input'), areas = ui.nodes().filter(node => node.type === 'textarea'); inputs[0].props.onChange({ target: { value: 'daily-assistant' } }); inputs[1].props.onChange({ target: { value: '日常助手' } }); areas[0].props.onChange({ target: { value: '基本事项整理' } }); areas[1].props.onChange({ target: { value: '请只根据用户给出的基本事项整理待办。' } }); ui.render() }
  fill()
  ui.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(calls.length, 0)
  assert.match(ui.text(), /核对将保存/)
  ui.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await ui.settle()
  assert.match(ui.text(), /ID 已存在.*填写内容已保留/)
  ui.button('返回修改').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.type === 'input').props.value, 'daily-assistant')
  conflict = false
  ui.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); ui.render()
  ui.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await ui.settle()
  assert.equal(created.length, 1)
  assert.equal(calls.every(call => call.endpoint === 'agents/new'), true)
  assert.match(ui.text(), /EXP-daily-assistant-001-r123456789abc/)
  ui.button('查看新智能体').props.onClick()
  assert.equal(selected[0].agent_id, 'daily-assistant')
})

test('资产差异来源切换忽略旧响应，文件选择读取对应只读补丁', async () => {
  const calls = [], firstResponse = deferred()
  const view = path => ({ left: { label: '父版', source: 'experiment:parent', digest: 'a' }, right: { label: '当前版', digest: 'b' }, notes: [], summary: { added: 0, removed: 0, modified: 1, unchanged: 1 }, files: [{ path: 'role.md', status: 'modified' }], ...(path ? { selected: { path, diff: '-old\n+new\n', truncated: false } } : {}) })
  const ui = await component('AssetDiffPanel', 'asset-diff-client.tsx', { experimentId: 'EXP-first-agent-002-r222222222222', baseline: { ref: 'git:' + 'a'.repeat(40), parent_experiment_id: 'EXP-first-agent-001-r111111111111' }, versions: [{ id: 'EXP-first-agent-002-r222222222222' }, { id: 'EXP-first-agent-001-r111111111111' }], rpc: { async call(channel, endpoint, payload) { calls.push({ endpoint, payload }); return calls.length === 1 ? firstResponse.promise : { ok: true, value: view(payload.path) } } } })
  assert.equal(ui.nodes().find(node => node.type === 'section' && node.props['aria-label'] === '资产差异').props.id, 'agent-asset-diff-panel')
  assert.equal(ui.button('关闭差异'), undefined)
  ui.button('比较资产').props.onClick(); ui.render()
  ui.nodes().find(node => node.type === 'select').props.onChange({ target: { value: 'EXP-first-agent-001-r111111111111' } }); ui.render()
  ui.button('比较资产').props.onClick(); await ui.settle()
  firstResponse.resolve({ ok: true, value: { ...view(), left: { label: '过时来源' } } }); await ui.settle()
  assert.doesNotMatch(ui.text(), /过时来源/)
  assert.equal(calls[1].payload.against, 'EXP-first-agent-001-r111111111111')
  ui.button('修改 · role.md').props.onClick(); await ui.settle()
  assert.equal(calls.at(-1).payload.path, 'role.md')
  assert.match(ui.text(), /-old\n\+new/)
  assert.equal(calls.every(call => call.endpoint === 'agents/assets/diff'), true)
  const source = () => ui.nodes().find(node => node.type?.name === 'DetailDrawer' && node.props.title === '本次来源摘要')
  assert.equal(source().props.active, true)
  assert.match(source().props.identity, /EXP-first-agent-002-r222222222222:EXP-first-agent-001-r111111111111/)
  assert.match(ui.text(source()), /experiment:parent/)
  assert.equal(ui.nodes().some(node => node.type === 'details'), false)
  ui.setActive(false)
  assert.equal(source().props.active, false)
})
