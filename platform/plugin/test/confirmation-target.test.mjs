import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/assistant/client.tsx', import.meta.url).pathname], write: false, bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
let proposal
const jsx = (type, props) => ({ type, props }), module = { exports: {} }
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require(name) {
  if (name === 'react') return { ...require('react'), useContext: () => false, useState: initial => [initial, () => {}], useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
  return require(name)
} })
const assistant = { subscribe: () => () => {}, getSnapshot: () => ({ sessionId: 's', status: { proposals: [proposal] } }) }
function visible(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(visible).join(' ')
  if (typeof node.type === 'function') return visible(node.type(node.props))
  if (node.type === 'details' && !node.props.open) return visible([node.props.children].flat().find(child => child?.type === 'summary'))
  return visible(node.props?.children)
}
function findButton(node, label) {
  if (node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) return node.map(child => findButton(child, label)).find(Boolean)
  if (typeof node.type === 'function') return findButton(node.type(node.props), label)
  if (node.type === 'button' && node.props.children === label) return node
  return findButton(node.props?.children, label)
}
const render = () => visible(module.exports.AssistantOperations({ assistant, sessionId: 's', rpc: { call() { assert.fail('只渲染确认摘要，不执行操作') } } }))

test('特性、修改和评测确认首屏同时明确智能体与版本，完整证据仍折叠', () => {
  const id = 'EXP-inspection-delivery-demo-001-rf841e4415364'
  for (const change of [
    { action: 'features/apply', preview: { experiment_id: id, features: [{}], evidence_refs: ['只在详情展示'] } },
    { action: 'edit/apply', input: { experiment_id: id, edits: [{}] }, preview: {} },
    { action: 'eval/start', input: { source: `experiment:${id}`, cases: ['U-BUSINESS-001'] }, preview: {} },
  ]) {
    proposal = { id: 'p', domain: 'agents', state: 'awaiting_confirmation', ...change }
    const text = render()
    assert.match(text, /智能体“inspection-delivery-demo”的版本 001/)
    assert.match(text, /暂不执行/)
    assert.doesNotMatch(text, /只在详情展示|rf841e4415364/)
  }
  proposal = { ...proposal, preview: { agent_name: '台账巡检助手' } }
  assert.match(render(), /智能体“台账巡检助手”的版本 001/)
  proposal = { ...proposal, preview: { agent_id: 'actual-agent' } }
  assert.match(render(), /智能体“actual-agent”的版本 001/)
})

test('实例创建和启动提案在一次确认前显示冻结的对象、来源、端口和默认模型', async () => {
  for (const operation of ['create', 'start']) {
    proposal = {
      id: `instance-${operation}`, domain: 'instances', action: 'run', state: 'awaiting_confirmation',
      input: { operation, name: 'security-instance', source: 'experiment:EXP-network-security-expert-001' },
      preview: { ok: true, value: {
        operation, name: 'security-instance',
        plan: { source_id: 'experiment:EXP-network-security-expert-007', port: 53107 },
        model_selection: { provider: 'provider-a', model: 'model-b', reasoningEffort: 'medium' },
      } },
    }
    const text = render()
    assert.match(text, /security-instance/)
    assert.match(text, /智能体“network-security-expert”的版本 007/)
    assert.match(text, /experiment:EXP-network-security-expert-007/)
    assert.match(text, /53107/)
    assert.match(text, /provider-a · model-b/)
    assert.match(text, /推理档位 medium/)
    assert.match(text, operation === 'create' ? /创建实例.*暂不执行/ : /启动实例.*暂不执行/)
    assert.doesNotMatch(text, /版本 001|先预览/)
  }
  proposal = { ...proposal, id: 'instance-create-direct', input: { ...proposal.input, operation: 'create' }, preview: { ...proposal.preview, value: { ...proposal.preview.value, operation: 'create' } } }
  const requests = []
  let refreshes = 0
  const liveAssistant = { ...assistant, refresh: async () => { refreshes++ } }
  const rpc = { async call(_channel, method, body) { requests.push({ method, body }); return { ok: true, value: { state: 'completed' } } } }
  const confirm = findButton(module.exports.AssistantOperations({ assistant: liveAssistant, sessionId: 's', rpc }), '创建实例')
  assert.ok(confirm)
  await confirm.props.onClick()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'assistant/confirm')
  assert.equal(requests[0].body.session_id, 's')
  assert.equal(requests[0].body.proposal_id, 'instance-create-direct')
  assert.equal(refreshes, 1)
})
