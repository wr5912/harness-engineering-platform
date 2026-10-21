import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/agents/compute-planning-dialog.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })

const modelList = { catalog: { groups: [{ id: 'provider-a', name: '服务 A', models: [
  { id: 'base-one', name: '模型一' }, { id: 'base-two', name: '模型二' },
] }, { id: 'provider-b', name: '服务 B', models: [{ id: 'other', name: '其他模型' }] }] },
  business_allowed: [{ provider: 'provider-a', model: 'base-two' }] }
const savedServer = { id: 'train-123456789abc', name: '训练节点 A', host: 'ssh.example', port: 22,
  user: 'trainer', workDir: '/workspace/train', auth: 'ssh_key', credentialRef: 'ref:training-key' }

function mountedDialog({ models = modelList, servers = [], saveResult, probeResult, storage = new Map() } = {}) {
  const states = [], hooks = [], cleanups = [], calls = [], sent = []
  let cursor = 0, queued = [], changed = false, tree
  const same = (left, right) => Boolean(left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index])))
  const effect = (callback, values) => {
    const index = cursor++
    if (!same(hooks[index], values)) {
      hooks[index] = values
      queued.push(() => { cleanups[index]?.(); cleanups[index] = callback() })
    }
  }
  const react = { ...require('react'),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { const next = typeof value === 'function' ? value(states[index]) : value
        if (!Object.is(next, states[index])) { states[index] = next; changed = true } }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useMemo(factory) { cursor++; return factory() },
    useEffect: effect,
    useLayoutEffect: effect,
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
    require: name => name === 'react' ? react : require(name),
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    requestAnimationFrame: callback => { callback(); return 1 }, cancelAnimationFrame() {},
  })
  const props = { open: true, agentId: 'agent-a', agentName: '智能体 A', experimentId: 'EXP-agent-a-001',
    versionLabel: '版本 001', parentRef: 'git:' + 'a'.repeat(40), runs: [], onClose() {}, onSend: async request => { sent.push(request) },
    rpc: { call: async (_channel, method, body) => { calls.push({ method, body })
      if (method === 'models/list') return { ok: true, value: models }
      if (method === 'agents/training-servers/list') return { ok: true, value: { revision: 'rev-1', servers } }
      if (method === 'agents/training-servers/save') return saveResult ? saveResult(body) : { ok: true, value: { revision: 'rev-2', servers: [...servers, savedServer] } }
      if (method === 'agents/training-servers/probe') return probeResult?.(body) || { ok: true, value: { status: 'ssh_reachable', message: 'SSH 服务标识可达', checked_at: '2026-10-21T00:00:00Z' } }
      throw new Error(`unexpected ${method}`)
    } },
  }
  function render() {
    for (let attempt = 0; attempt < 30; attempt++) {
      cursor = 0; queued = []; changed = false
      tree = module.exports.ComputePlanningDialog(props)
      queued.forEach(run => run())
      if (!changed) return tree
    }
    throw new Error('dialog did not settle')
  }
  async function settle() { for (let attempt = 0; attempt < 6; attempt++) { render(); await new Promise(resolve => setImmediate(resolve)) } render() }
  function nodes(value) {
    if (arguments.length === 0) value = tree
    if (Array.isArray(value)) return value.flatMap(item => nodes(item))
    if (!value || typeof value !== 'object') return []
    return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))]
  }
  function textOf(value) {
    if (arguments.length === 0) value = tree
    if (Array.isArray(value)) return value.map(item => textOf(item)).join('')
    if (!value || typeof value !== 'object') return String(value ?? '')
    return textOf(value.props?.children)
  }
  const button = label => nodes().find(node => node.type === 'button' && textOf(node).includes(label))
  const field = name => nodes().find(node => node.props?.['data-plan-field'] === name && ['input', 'select', 'textarea'].includes(node.type))
  const fill = (name, value) => { assert.ok(field(name), `field ${name}`); field(name).props.onChange({ target: { value } }); render() }
  async function medium() {
    nodes().find(node => node.type === 'input' && node.props?.name === 'compute-type' && node.props.value === 'medium').props.onChange()
    await settle()
    button('下一步：策划配置').props.onClick({ preventDefault() {} })
    await settle()
    const traceLabel = nodes().find(node => node.type === 'label' && textOf(node).includes('先由助手补充轨迹采集方案'))
    nodes(traceLabel).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
    render()
  }
  async function low() {
    nodes().find(node => node.type === 'input' && node.props?.name === 'compute-type' && node.props.value === 'low').props.onChange()
    await settle()
    button('下一步：策划配置').props.onClick({ preventDefault() {} })
    await settle()
    const traceLabel = nodes().find(node => node.type === 'label' && textOf(node).includes('先由助手补充轨迹采集方案'))
    nodes(traceLabel).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
    render()
  }
  render()
  return { medium, low, settle, nodes, textOf, button, field, fill, calls, sent, props, module,
    submit: async () => { nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle() },
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()) }
}

test('模型库只提供当前业务可用目录中的真实模型，并发送提供方与模型 ID', async () => {
  const ui = mountedDialog()
  try {
    await ui.medium()
    ui.button('模型库').props.onClick(); await ui.settle()
    const options = ui.nodes(ui.field('baseModelId')).filter(node => node.type === 'option')
    assert.deepEqual(options.map(option => ui.textOf(option)), ['请选择业务可用模型', '服务 A · 模型二'])
    assert.match(ui.textOf(), /训练适配性、版本、许可与资源要求仍需核实/)
    ui.fill('baseModelId', JSON.stringify(['provider-a', 'base-two']))
    ui.button('稍后配置').props.onClick(); await ui.settle()
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.equal(ui.sent[0].medium.baseModelId, 'provider-a/base-two')
    assert.equal(ui.calls.some(call => call.method.endsWith('/save')), false)
  } finally { ui.cleanup() }
})

test('目录无业务可用模型和已登记连接时阻止引用，仍可改由助手策划', async () => {
  const ui = mountedDialog({ models: { ...modelList, business_allowed: [] } })
  try {
    await ui.medium()
    ui.button('模型库').props.onClick(); ui.button('已登记连接').props.onClick(); await ui.settle()
    assert.match(ui.textOf(), /当前 DSH 目录暂无可用于业务实例的模型/)
    assert.match(ui.textOf(), /当前没有已登记的训练服务器 SSH 连接/)
    await ui.submit()
    assert.equal(ui.sent.length, 0)
    assert.ok(ui.nodes().some(node => /请选择当前业务可用目录中的模型/.test(node.props?.text || '')))
    ui.button('请助手建议').props.onClick(); ui.button('稍后配置').props.onClick(); await ui.settle()
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.equal(ui.sent[0].medium.baseModelMode, 'suggest')
    assert.equal(ui.sent[0].medium.serverMode, 'later')
  } finally { ui.cleanup() }
})

test('新连接仅在显式点击后登记；登记后的选择携带非秘密连接资料', async () => {
  const ui = mountedDialog()
  try {
    await ui.medium()
    ui.fill('serverName', '训练节点 A')
    ui.fill('host', 'ssh.example'); ui.fill('port', '22'); ui.fill('user', 'trainer')
    ui.fill('workDir', '/workspace/train'); ui.fill('credentialRef', 'ref:training-key')
    assert.equal(ui.calls.some(call => call.method.endsWith('/save')), false)
    ui.button('保存为已登记连接').props.onClick(); await ui.settle()
    const save = ui.calls.find(call => call.method.endsWith('/save'))
    assert.equal(save.body.server.credentialRef, 'ref:training-key')
    assert.equal(save.body.server.secret, undefined)
    assert.match(ui.textOf(), /连接资料已登记并选中；SSH 连通性与训练环境仍未验证/)
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.equal(ui.sent[0].medium.serverMode, 'registered')
    assert.equal(ui.sent[0].medium.serverId, savedServer.id)
    assert.equal(ui.sent[0].medium.host, savedServer.host)
    assert.equal(ui.sent[0].medium.credentialRef, savedServer.credentialRef)
  } finally { ui.cleanup() }
})

test('真实 SSH 探测区分服务标识、端口可达与不可达，地址变更使旧结果失效', async () => {
  const ui = mountedDialog({ probeResult: body => ({ ok: true, value: { status: body.host === 'ssh.example' ? 'ssh_reachable' : body.host === 'tcp.example' ? 'port_reachable_unverified' : 'unreachable',
    message: body.host === 'ssh.example' ? 'SSH 服务标识可达' : body.host === 'tcp.example' ? '仅端口可达' : '目标端口不可达', checked_at: '2026-10-21T00:00:00Z' } }) })
  try {
    await ui.medium()
    ui.fill('host', 'ssh.example')
    ui.button('测试连接').props.onClick(); await ui.settle()
    assert.match(ui.textOf(), /SSH 服务标识已确认可达/)
    assert.match(ui.textOf(), /认证、GPU 与训练依赖仍未验证/)
    ui.fill('host', 'tcp.example')
    ui.button('测试连接').props.onClick(); await ui.settle()
    assert.match(ui.textOf(), /端口可达，但 SSH 服务标识未确认/)
    ui.fill('host', 'unreachable.example')
    assert.doesNotMatch(ui.textOf(), /SSH 服务标识已确认可达/)
    ui.button('测试连接').props.onClick(); await ui.settle()
    assert.match(ui.textOf(), /目标端口不可达/)
    assert.equal(ui.calls.filter(call => call.method.endsWith('/probe')).length, 3)
  } finally { ui.cleanup() }
})

test('连接登记写入结果未知时保留草稿，不自动重试', async () => {
  const ui = mountedDialog({ saveResult: () => Promise.reject(new Error('socket closed')) })
  try {
    await ui.medium()
    ui.fill('serverName', '训练节点 A')
    ui.fill('host', 'ssh.example'); ui.fill('port', '22'); ui.fill('user', 'trainer')
    ui.fill('workDir', '/workspace/train')
    ui.button('保存为已登记连接').props.onClick(); await ui.settle()
    assert.match(ui.textOf(), /保存结果待核对/)
    assert.equal(ui.field('host').props.value, 'ssh.example')
    assert.equal(ui.calls.filter(call => call.method.endsWith('/save')).length, 1)
    assert.equal(ui.button('保存为已登记连接').props.disabled, true)
  } finally { ui.cleanup() }
})

test('更多策划补充在中低算力共用草稿，摘要和请求保留验收关注点', async () => {
  const storage = new Map()
  const medium = mountedDialog({ storage })
  try {
    await medium.medium()
    assert.match(medium.textOf(), /更多策划补充（选填）/)
    medium.fill('advanced', '  必须覆盖断线恢复；资源预算 2 GPU。  ')
    assert.match(medium.textOf(), /其他限制必须覆盖断线恢复；资源预算 2 GPU。/)
    medium.button('稍后配置').props.onClick(); await medium.settle()
    await medium.submit()
    assert.equal(medium.sent[0].advanced, '必须覆盖断线恢复；资源预算 2 GPU。')
  } finally { medium.cleanup() }

  const low = mountedDialog({ storage })
  try {
    await low.low()
    low.fill('advanced', '异常必须显式说明，验收时比较延迟')
    assert.match(low.textOf(), /其他限制异常必须显式说明，验收时比较延迟/)
    assert.equal(low.field('advanced').props.value, '异常必须显式说明，验收时比较延迟')
  } finally { low.cleanup() }

  const restored = mountedDialog({ storage })
  try {
    assert.equal(restored.field('advanced').props.value, '异常必须显式说明，验收时比较延迟')
    assert.match(restored.textOf(), /其他限制异常必须显式说明，验收时比较延迟/)
    await restored.submit()
    assert.equal(restored.sent[0].type, 'low')
    assert.equal(restored.sent[0].advanced, '异常必须显式说明，验收时比较延迟')
  } finally { restored.cleanup() }
})
