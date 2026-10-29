import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/agents/compute-planning-dialog.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })

const savedServer = { id: 'train-123456789abc', name: '训练节点 A', host: 'ssh.example', port: 22,
  user: 'trainer', workDir: '/workspace/train', auth: 'ssh_key', credentialRef: 'ref:training-key' }

function mountedDialog({ servers = [], saveResult, probeResult, onSend, storage = new Map() } = {}) {
  const states = [], hooks = [], cleanups = [], calls = [], sent = [], closed = [], dirty = []
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
    versionLabel: '版本 001', parentRef: 'git:' + 'a'.repeat(40), runs: [], onClose() { closed.push(true) }, onDirtyChange: value => dirty.push(value), onSend: async request => { sent.push(request); await onSend?.(request) },
    rpc: { call: async (_channel, method, body) => { calls.push({ method, body })
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
  const byLabel = label => nodes().find(node => node.props?.['aria-label'] === label)
  const edit = (label, value) => { assert.ok(byLabel(label), `label ${label}`); byLabel(label).props.onChange({ target: { value } }); render() }
  const field = name => nodes().find(node => node.props?.['data-plan-field'] === name && ['input', 'select', 'textarea'].includes(node.type))
  const fill = (name, value) => { assert.ok(field(name), `field ${name}`); field(name).props.onChange({ target: { value } }); render() }
  async function medium() {
    button('中算力').props.onClick(); await settle()
  }
  async function low() {
    button('低算力').props.onClick(); await settle()
  }
  render()
  return { medium, low, settle, render, nodes, textOf, button, byLabel, edit, field, fill, calls, sent, closed, dirty, storage, props, module,
    submit: async () => { nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await settle() },
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()) }
}

test('小尺寸 LLM 与决策模型按 HF、ModelScope、本地及待确定来源完整发送，不读取推理目录', async () => {
  const ui = mountedDialog()
  const models = [
    { kind: 'llm', source: 'huggingface', baseModel: 'https://huggingface.co/org/summary-small', revision: 'hf-r1', purpose: '事件摘要' },
    { kind: 'llm', source: 'modelscope', baseModel: 'org/extraction-small', revision: 'ms-r2', purpose: '字段抽取' },
    { kind: 'decision', source: 'local', baseModel: '/models/event-classifier', revision: 'local-v3', purpose: '事件分类' },
    { kind: 'decision', source: 'unspecified', baseModel: '', revision: '', purpose: '由助手建议辅助决策模型' },
  ]
  try {
    await ui.medium()
    assert.equal(ui.button('模型库'), undefined)
    assert.equal(ui.field('baseModelId'), undefined)
    assert.match(ui.textOf(), /Hugging Face、ModelScope 仓库.*本地模型目录/)
    assert.match(ui.textOf(), /本次不下载或训练模型/)
    for (let index = 0; index < models.length; index++) {
      ui.button('添加模型').props.onClick({ currentTarget: { closest: () => null } }); await ui.settle()
      const prefix = `模型 ${index + 1}`
      ui.edit(`${prefix} 类型`, models[index].kind)
      ui.edit(`${prefix} 来源`, models[index].source)
      ui.edit(`${prefix} 基模型`, models[index].baseModel)
      ui.edit(`${prefix} 版本`, models[index].revision)
      ui.edit(`${prefix} 用途`, models[index].purpose)
    }
    assert.deepEqual(ui.nodes(ui.byLabel('模型 1 来源')).filter(node => node.type === 'option').map(node => node.props.value), ['unspecified', 'huggingface', 'modelscope', 'local'])
    assert.equal(ui.byLabel('模型 3 基模型').props.placeholder, '/path/to/downloaded-model')
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].medium.models)), models)
    assert.equal('baseModelMode' in ui.sent[0].medium, false)
    assert.equal('baseModelId' in ui.sent[0].medium, false)
    assert.equal('revision' in ui.sent[0].medium, false)
    assert.equal(ui.calls.some(call => call.method === 'models/list'), false)
    assert.equal(ui.calls.some(call => /\/(save|probe)$/.test(call.method)), false)
  } finally { ui.cleanup() }
})

test('用户添加的模型行完整发送，来源、Revision、类型及空白建议均保留', async () => {
  const ui = mountedDialog()
  try {
    await ui.medium()
    for (let index = 0; index < 4; index++) { ui.button('添加模型').props.onClick({ currentTarget: { closest: () => null } }); await ui.settle() }
    ui.edit('模型 1 来源', 'huggingface')
    ui.edit('模型 2 类型', 'decision'); ui.edit('模型 2 版本', 'revision-pending-model')
    ui.edit('模型 3 类型', 'decision')
    await ui.submit()
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].medium.models)), [
      { kind: 'llm', source: 'huggingface', baseModel: '', revision: '', purpose: '' },
      { kind: 'decision', source: 'unspecified', baseModel: '', revision: 'revision-pending-model', purpose: '' },
      { kind: 'decision', source: 'unspecified', baseModel: '', revision: '', purpose: '' },
      { kind: 'llm', source: 'unspecified', baseModel: '', revision: '', purpose: '' },
    ])
    assert.equal(ui.calls.some(call => call.method === 'models/list'), false)
  } finally { ui.cleanup() }
})

test('未选模型可交助手建议，缺失的已登记训练连接仍须修正后发送', async () => {
  const ui = mountedDialog()
  try {
    await ui.medium()
    ui.button('已登记连接').props.onClick(); await ui.settle()
    assert.match(ui.textOf(), /当前没有已登记的训练服务器 SSH 连接/)
    await ui.submit()
    assert.equal(ui.sent.length, 0)
    assert.ok(ui.nodes().some(node => /请选择仍在已登记列表中的训练服务器连接/.test(node.props?.text || '')))
    ui.button('稍后配置').props.onClick(); await ui.settle()
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.deepEqual(Array.from(ui.sent[0].medium.models), [])
    assert.equal(ui.sent[0].medium.serverMode, 'later')
    assert.equal(ui.calls.some(call => call.method === 'models/list'), false)
  } finally { ui.cleanup() }
})

test('新连接仅在显式点击后登记；登记后的选择携带非秘密连接资料', async () => {
  const ui = mountedDialog()
  try {
    await ui.medium()
    ui.button('新连接').props.onClick(); await ui.settle()
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
    ui.button('新连接').props.onClick(); await ui.settle()
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
    ui.button('新连接').props.onClick(); await ui.settle()
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

test('更多策划补充只维护输入与请求一份值，切模式和恢复保留验收关注点', async () => {
  const storage = new Map()
  const medium = mountedDialog({ storage })
  try {
    await medium.medium()
    assert.match(medium.textOf(), /更多策划补充（选填）/)
    medium.fill('advanced', '  必须覆盖断线恢复；资源预算 2 GPU。  ')
    assert.equal(medium.field('advanced').props.value.trim(), '必须覆盖断线恢复；资源预算 2 GPU。')
    assert.match(medium.textOf(), /待补充与核验/)
    assert.doesNotMatch(medium.textOf(), /核对本次策划摘要/)
    medium.button('稍后配置').props.onClick(); await medium.settle()
    await medium.submit()
    assert.equal(medium.sent[0].advanced, '必须覆盖断线恢复；资源预算 2 GPU。')
  } finally { medium.cleanup() }

  const low = mountedDialog({ storage })
  try {
    await low.low()
    low.fill('advanced', '异常必须显式说明，验收时比较延迟')
    assert.equal(low.field('advanced').props.value, '异常必须显式说明，验收时比较延迟')
  } finally { low.cleanup() }

  const restored = mountedDialog({ storage })
  try {
    assert.equal(restored.field('advanced').props.value, '异常必须显式说明，验收时比较延迟')
    assert.match(restored.textOf(), /待补充与核验/)
    await restored.submit()
    assert.equal(restored.sent[0].type, 'low')
    assert.equal(restored.sent[0].advanced, '异常必须显式说明，验收时比较延迟')
  } finally { restored.cleanup() }
})


test('多模型自由建议切换模式后保留，发送独立快照且不连接或登记资源', async () => {
  const ui = mountedDialog()
  try {
    await ui.medium()
    ui.button('添加模型').props.onClick({ currentTarget: { closest: () => null } })
    await ui.settle()
    ui.nodes().find(node => node.props?.['aria-label'] === '模型 1 基模型').props.onChange({ target: { value: 'org/decision-model' } }); await ui.settle()
    ui.nodes().find(node => node.props?.['aria-label'] === '模型 1 用途').props.onChange({ target: { value: '复杂分类' } }); await ui.settle()
    ui.button('添加模型').props.onClick({ currentTarget: { closest: () => null } }); await ui.settle()
    ui.nodes().find(node => node.props?.['aria-label'] === '模型 2 用途').props.onChange({ target: { value: '仅给出分工，由助手建议基模型' } }); await ui.settle()
    ui.nodes().find(node => node.props?.['aria-label'] === '模型组合偏好').props.onChange({ target: { value: '分别比较后组合' } }); await ui.settle()
    ui.button('低算力').props.onClick(); await ui.settle()
    assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '模型 1 基模型'), false)
    ui.button('中算力').props.onClick(); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '模型 1 基模型').props.value, 'org/decision-model')
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].medium.models)), [{ kind: 'llm', source: 'unspecified', baseModel: 'org/decision-model', revision: '', purpose: '复杂分类' }, { kind: 'llm', source: 'unspecified', baseModel: '', revision: '', purpose: '仅给出分工，由助手建议基模型' }])
    assert.equal(ui.sent[0].medium.combinationPreference, '分别比较后组合')
    assert.equal(ui.sent[0].medium.serverMode, 'later')
    assert.equal(ui.calls.some(call => /\/(save|probe)$/.test(call.method)), false)
  } finally { ui.cleanup() }
})


function deferred() {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const modelClick = { currentTarget: { closest: () => null } }

test('模型建议和组合偏好作为草稿恢复，新增与编辑删除保持独立身份', async () => {
  const storage = new Map()
  const original = mountedDialog({ storage })
  try {
    await original.settle()
    assert.equal(original.dirty.at(-1), false)
    original.edit('模型组合偏好', '仅组合偏好也应保存')
    assert.equal(original.dirty.at(-1), true)
    original.edit('模型组合偏好', '')
    assert.equal(original.dirty.at(-1), false)
    original.button('添加模型').props.onClick(modelClick); await original.settle()
    assert.equal(original.dirty.at(-1), true)
    original.edit('模型 1 基模型', 'org/model-a'); original.edit('模型 1 来源', 'huggingface'); original.edit('模型 1 版本', 'revision-a'); original.edit('模型 1 用途', '分类')
    original.button('添加模型').props.onClick(modelClick); await original.settle()
    original.edit('模型 2 基模型', '/models/model-b'); original.edit('模型 2 类型', 'decision'); original.edit('模型 2 来源', 'local')
    original.edit('模型组合偏好', '分别比较后组合')
  } finally { original.cleanup() }
  const restored = mountedDialog({ storage })
  try {
    await restored.settle()
    assert.equal(restored.dirty.at(-1), true)
    assert.equal(restored.byLabel('模型组合偏好').props.value, '分别比较后组合')
    assert.equal(restored.byLabel('模型 1 基模型').props.value, 'org/model-a')
    assert.equal(restored.byLabel('模型 2 基模型').props.value, '/models/model-b')
    assert.equal(restored.byLabel('模型 2 类型').props.value, 'decision')
    assert.equal(restored.byLabel('模型 1 来源').props.value, 'huggingface')
    assert.equal(restored.byLabel('模型 1 版本').props.value, 'revision-a')
    assert.equal(restored.byLabel('模型 2 来源').props.value, 'local')
    restored.button('添加模型').props.onClick(modelClick); await restored.settle()
    restored.edit('模型 3 基模型', 'org/model-c'); restored.edit('模型 3 来源', 'modelscope')
    assert.equal(restored.byLabel('模型 1 基模型').props.value, 'org/model-a')
    assert.equal(restored.byLabel('模型 2 基模型').props.value, '/models/model-b')
    restored.edit('模型 1 基模型', 'org/model-a-edited')
    assert.equal(restored.byLabel('模型 3 基模型').props.value, 'org/model-c')
    restored.button('移除模型 2').props.onClick(modelClick); await restored.settle()
    assert.equal(restored.byLabel('模型 1 基模型').props.value, 'org/model-a-edited')
    assert.equal(restored.byLabel('模型 2 基模型').props.value, 'org/model-c')
    assert.equal(restored.byLabel('模型 3 基模型'), undefined)
    await restored.submit()
    assert.deepEqual(Array.from(restored.sent[0].medium.models, row => row.baseModel), ['org/model-a-edited', 'org/model-c'])
    assert.deepEqual(Array.from(restored.sent[0].medium.models, row => row.source), ['huggingface', 'modelscope'])
    assert.equal(restored.sent[0].medium.models[0].revision, 'revision-a')
    assert.equal(restored.sent[0].medium.combinationPreference, '分别比较后组合')
    assert.equal(storage.size, 0, '成功后只清理已经发送的草稿')
  } finally { restored.cleanup() }
})

test('旧自定义基模型迁移为待确定来源的训练建议，保留目标、版本及训练连接原字段', async () => {
  const storage = new Map(), old = mountedDialog({ storage })
  try {
    await old.settle(); old.fill('goal', '旧草稿的原目标'); old.fill('advanced', '保留原验收要求'); old.nodes(old.nodes().find(node => node.type === 'label' && old.textOf(node).startsWith('变体名称'))).find(node => node.type === 'input').props.onChange({ target: { value: '旧草稿变体名称' } }); old.render()
    old.button('新连接').props.onClick(); await old.settle()
    old.fill('serverName', '旧训练节点'); old.fill('host', 'legacy.example'); old.fill('port', '2222'); old.fill('user', 'legacy-user')
    old.fill('workDir', '/workspace/legacy'); old.fill('credentialRef', 'ref:legacy-key')
  } finally { old.cleanup() }
  const [key, value] = [...storage.entries()][0], saved = JSON.parse(value)
  delete saved.draft.modelSuggestions; delete saved.draft.combinationPreference; delete saved.draft.previousInferenceModel; delete saved.draft.previousInferenceRevision
  Object.assign(saved.draft.medium, { baseModelMode: 'custom', baseModelId: 'org/legacy-model', revision: 'legacy-r1' })
  saved.draft.low = { uncovered: 'request_human', requirements: '旧低算力补充要求' }
  storage.set(key, JSON.stringify(saved))
  const restored = mountedDialog({ storage })
  try {
    await restored.settle()
    assert.equal(restored.field('goal').props.value, '旧草稿的原目标')
    assert.equal(restored.field('advanced').props.value, '保留原验收要求')
    assert.equal(restored.nodes(restored.nodes().find(node => node.type === 'label' && restored.textOf(node).startsWith('变体名称'))).find(node => node.type === 'input').props.value, '旧草稿变体名称')
    assert.equal(restored.byLabel('模型组合偏好').props.value, '')
    assert.equal(restored.byLabel('模型 1 基模型').props.value, 'org/legacy-model')
    assert.equal(restored.byLabel('模型 1 来源').props.value, 'unspecified')
    assert.equal(restored.byLabel('模型 1 类型').props.value, 'decision')
    assert.equal(restored.byLabel('模型 1 版本').props.value, 'legacy-r1')
    assert.doesNotMatch(restored.textOf(), /旧草稿中的推理模型引用/)
    const migrated = JSON.parse(storage.get(key)).draft
    for (const field of ['serverMode', 'serverId', 'serverName', 'host', 'port', 'user', 'workDir', 'auth', 'credentialRef']) assert.equal(migrated.medium[field], saved.draft.medium[field], field)
    assert.deepEqual(migrated.low, saved.draft.low)
    assert.equal(migrated.medium.baseModelId, undefined)
    await restored.submit()
    assert.equal(restored.sent.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(restored.sent[0].medium.models)), [{ kind: 'decision', source: 'unspecified', baseModel: 'org/legacy-model', revision: 'legacy-r1', purpose: '训练基模型参考' }])
    assert.equal(restored.sent[0].medium.host, 'legacy.example')
    assert.equal(restored.sent[0].medium.port, 2222)
    assert.equal(restored.sent[0].medium.credentialRef, 'ref:legacy-key')
    assert.equal('baseModelId' in restored.sent[0].medium, false)
    assert.equal(restored.calls.some(call => call.method === 'models/list'), false)
  } finally { restored.cleanup() }
})

test('旧推理目录引用及原版本只读保留，已有模型建议不丢失且旧引用不进入请求', async () => {
  const storage = new Map(), original = mountedDialog({ storage })
  try {
    await original.settle(); original.fill('goal', '保留旧目录策划目标'); original.fill('advanced', '保留旧目录验收说明')
  } finally { original.cleanup() }
  const [key, value] = [...storage.entries()][0], saved = JSON.parse(value)
  Object.assign(saved.draft.medium, { baseModelMode: 'catalog', baseModelId: 'provider-a/base-two', revision: 'old-api-revision' })
  saved.draft.modelSuggestions = [{ id: 4, kind: 'llm', baseModel: 'org/training-small', revision: 'weights-r3', purpose: '保留已有模型分工' }]
  saved.draft.combinationPreference = '旧组合偏好'
  delete saved.draft.previousInferenceModel; delete saved.draft.previousInferenceRevision
  storage.set(key, JSON.stringify(saved))
  const restored = mountedDialog({ storage })
  let persisted
  try {
    await restored.settle()
    assert.equal(restored.field('goal').props.value, '保留旧目录策划目标')
    assert.equal(restored.field('advanced').props.value, '保留旧目录验收说明')
    assert.match(restored.textOf(), /旧草稿中的推理模型引用.*provider-a\/base-two.*原版本：old-api-revision/s)
    assert.equal(restored.field('baseModelId'), undefined)
    assert.equal(restored.byLabel('模型 1 基模型').props.value, 'org/training-small')
    assert.equal(restored.byLabel('模型 1 来源').props.value, 'unspecified')
    assert.equal(restored.byLabel('模型 1 版本').props.value, 'weights-r3')
    assert.equal(restored.byLabel('模型组合偏好').props.value, '旧组合偏好')
    const migrated = JSON.parse(storage.get(key)).draft
    assert.equal(migrated.previousInferenceModel, 'provider-a/base-two')
    assert.equal(migrated.previousInferenceRevision, 'old-api-revision')
    assert.equal(migrated.medium.baseModelId, undefined)
    persisted = new Map(storage)
    await restored.submit()
    assert.deepEqual(JSON.parse(JSON.stringify(restored.sent[0].medium.models)), [{ kind: 'llm', source: 'unspecified', baseModel: 'org/training-small', revision: 'weights-r3', purpose: '保留已有模型分工' }])
    assert.doesNotMatch(JSON.stringify(restored.sent[0]), /provider-a\/base-two|old-api-revision|previousInference|baseModelMode|baseModelId/)
    assert.equal(restored.calls.some(call => call.method === 'models/list'), false)
  } finally { restored.cleanup() }
  const reopened = mountedDialog({ storage: persisted })
  try {
    await reopened.settle()
    assert.match(reopened.textOf(), /provider-a\/base-two.*原版本：old-api-revision/s)
    reopened.button('移除旧引用').props.onClick(); await reopened.settle()
    assert.doesNotMatch(reopened.textOf(), /旧草稿中的推理模型引用/)
    const cleared = JSON.parse(persisted.get(key)).draft
    assert.equal(cleared.previousInferenceModel, null)
    assert.equal(cleared.previousInferenceRevision, '')
  } finally { reopened.cleanup() }
})

test('未知发送结果重挂载后仍冻结并保留请求编号，核对前不重发', async () => {
  const storage = new Map(), request = deferred()
  const original = mountedDialog({ storage, onSend: () => request.promise })
  let requestId, inflight
  try {
    await original.settle(); original.fill('goal', '这次请求结果需要核对')
    await original.submit(); await original.submit()
    assert.equal(original.sent.length, 1, '发送中重复提交不调用消费者')
    assert.equal(original.button('暂存并关闭').props.disabled, true)
    assert.equal(original.byLabel('暂存并关闭策划弹窗').props.disabled, true)
    original.nodes().find(node => node.type === 'dialog').props.onCancel({ preventDefault() {} })
    assert.equal(original.closed.length, 0)
    inflight = new Map(storage)
    assert.equal(JSON.parse([...inflight.values()][0]).status, 'sending')
    requestId = original.sent[0].requestId
    request.reject(new Error('socket closed')); await original.settle()
    assert.match(original.textOf(), /发送结果待核对，请勿重复发送/)
    assert.equal(JSON.parse([...storage.values()][0]).status, 'unknown')
  } finally { original.cleanup() }
  const interrupted = mountedDialog({ storage: inflight })
  try {
    await interrupted.settle(); await interrupted.submit()
    assert.match(interrupted.textOf(), /发送结果待核对，请勿重复发送/)
    assert.ok(interrupted.textOf().includes(requestId))
    assert.equal(interrupted.sent.length, 0, '发送中的持久草稿恢复为未知，不自动重发')
  } finally { interrupted.cleanup() }
  const restored = mountedDialog({ storage })
  try {
    await restored.settle()
    assert.equal(restored.sent.length, 0, '恢复草稿不自动调用消费者')
    assert.ok(restored.textOf().includes(requestId))
    assert.equal(restored.nodes().find(node => node.type === 'fieldset').props.disabled, true)
    assert.equal(restored.nodes().find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
    restored.fill('goal', '不能覆盖未知请求'); await restored.submit()
    assert.equal(restored.field('goal').props.value, '这次请求结果需要核对')
    assert.equal(restored.sent.length, 0)
    assert.equal(restored.button('暂存并关闭').props.disabled, false)
    assert.equal(restored.byLabel('暂存并关闭策划弹窗').props.disabled, false)
    restored.nodes().find(node => node.type === 'dialog').props.onCancel({ preventDefault() {} })
    assert.equal(restored.closed.length, 1, '未知结果允许离开窗口去核对')
    restored.button('我已核对，确认未送达').props.onClick(); await restored.settle()
    await restored.submit()
    assert.equal(restored.sent.length, 1)
    assert.equal(restored.sent[0].requestId, requestId, '未编辑的显式重试沿用请求编号')
    assert.equal(storage.size, 0)
  } finally { restored.cleanup() }
})

test('明确未发送保留输入并允许显式重试，成功后清理草稿', async () => {
  let attempt = 0
  const ui = mountedDialog({ onSend: async () => { if (++attempt === 1) throw Object.assign(new Error('本地核对尚未通过'), { definitelyNotSent: true }) } })
  try {
    await ui.settle(); ui.fill('goal', '明确未发送仍保留目标')
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.match(ui.textOf(), /明确未发送/)
    assert.equal(ui.closed.length, 0)
    assert.equal(ui.field('goal').props.value, '明确未发送仍保留目标')
    assert.equal(ui.nodes().find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, false)
    await ui.submit()
    assert.equal(ui.sent.length, 2)
    assert.equal(ui.sent[0].requestId, ui.sent[1].requestId)
    assert.equal(ui.closed.length, 1)
    assert.equal(ui.storage.size, 0)
  } finally { ui.cleanup() }
})

test('保存训练连接期间页尾与关闭按钮禁用，ESC也不关闭', async () => {
  const save = deferred(), ui = mountedDialog({ saveResult: () => save.promise })
  try {
    await ui.settle(); ui.button('新连接').props.onClick(); await ui.settle()
    ui.fill('serverName', savedServer.name); ui.fill('host', savedServer.host); ui.fill('port', '22')
    ui.fill('user', savedServer.user); ui.fill('workDir', savedServer.workDir)
    ui.button('保存为已登记连接').props.onClick(); await ui.settle()
    assert.equal(ui.button('暂存并关闭').props.disabled, true)
    assert.equal(ui.byLabel('暂存并关闭策划弹窗').props.disabled, true)
    let prevented = false
    ui.nodes().find(node => node.type === 'dialog').props.onCancel({ preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(ui.closed.length, 0)
    assert.equal(ui.calls.filter(call => call.method.endsWith('/save')).length, 1)
    save.resolve({ ok: true, value: { revision: 'rev-2', servers: [savedServer] } }); await ui.settle()
    assert.equal(ui.button('暂存并关闭').props.disabled, false)
    assert.equal(ui.byLabel('暂存并关闭策划弹窗').props.disabled, false)
    ui.nodes().find(node => node.type === 'dialog').props.onCancel({ preventDefault() {} })
    assert.equal(ui.closed.length, 1)
  } finally { ui.cleanup() }
})

test('模型建议区域关闭且引用待确定时可继续策划，保留已填用途而不要求推理目录', async () => {
  const ui = mountedDialog()
  try {
    await ui.settle(); ui.button('添加模型').props.onClick(modelClick); await ui.settle()
    ui.edit('模型 1 用途', '由助手建议适合分类的模型')
    const section = () => ui.nodes().find(node => node.type === 'details' && ui.nodes(node).includes(ui.byLabel('模型 1 来源')))
    section().props.onToggle({ currentTarget: { open: false } }); ui.render()
    assert.equal(section().props.open, false)
    await ui.submit()
    assert.equal(ui.sent.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].medium.models)), [{ kind: 'llm', source: 'unspecified', baseModel: '', revision: '', purpose: '由助手建议适合分类的模型' }])
    assert.equal(ui.calls.some(call => call.method === 'models/list'), false)
  } finally { ui.cleanup() }
})

test('旧对象发送的迟到成功或失败不覆盖新对象草稿', async t => {
  for (const outcome of ['success', 'failure']) await t.test(outcome, async () => {
    const pending = deferred(), storage = new Map(), ui = mountedDialog({ storage, onSend: () => pending.promise })
    try {
      await ui.settle(); ui.fill('goal', '旧对象目标'); await ui.submit()
      const oldKey = [...storage.keys()][0]
      ui.props.open = false; ui.props.agentId = 'agent-b'; ui.props.agentName = '智能体 B'; ui.props.experimentId = 'EXP-agent-b-002'; ui.render(); await ui.settle()
      ui.props.open = true; ui.render(); await ui.settle(); ui.fill('goal', '新对象不能被清空')
      const closes = ui.closed.length
      if (outcome === 'success') pending.resolve(); else pending.reject(new Error('旧对象连接中断'))
      await ui.settle()
      assert.equal(ui.field('goal').props.value, '新对象不能被清空')
      assert.equal(ui.closed.length, closes)
      assert.doesNotMatch(ui.textOf(), /旧对象连接中断/)
      const newKey = [...storage.keys()].find(key => key !== oldKey)
      assert.equal(JSON.parse(storage.get(newKey)).draft.goal, '新对象不能被清空')
      if (outcome === 'success') assert.equal(storage.has(oldKey), false)
    } finally { ui.cleanup() }
  })
})

async function revisionOnlyLegacyDraft(mode, revision) {
  const storage = new Map(), original = mountedDialog({ storage })
  try {
    await original.settle(); original.fill('goal', `${mode} 旧草稿目标`); original.fill('advanced', '保留旧修订版验收要求')
  } finally { original.cleanup() }
  const [key, value] = [...storage.entries()][0], saved = JSON.parse(value)
  Object.assign(saved.draft.medium, { baseModelMode: mode, baseModelId: '', revision })
  delete saved.draft.modelSuggestions; delete saved.draft.previousInferenceModel; delete saved.draft.previousInferenceRevision
  storage.set(key, JSON.stringify(saved))
  return { storage, key }
}

test('旧自定义草稿仅有 Revision 仍迁为训练建议，再挂载不丢失或重复且发送保留', async () => {
  const revision = 'legacy-weights-revision-only', { storage, key } = await revisionOnlyLegacyDraft('custom', revision)
  for (let phase = 0; phase < 2; phase++) {
    const ui = mountedDialog({ storage })
    try {
      await ui.settle()
      assert.equal(ui.field('goal').props.value, 'custom 旧草稿目标')
      assert.equal(ui.field('advanced').props.value, '保留旧修订版验收要求')
      assert.equal(ui.byLabel('模型 1 基模型').props.value, '')
      assert.equal(ui.byLabel('模型 1 版本').props.value, revision)
      assert.equal(ui.byLabel('模型 1 类型').props.value, 'decision')
      assert.equal(ui.byLabel('模型 1 来源').props.value, 'unspecified')
      assert.equal(ui.byLabel('模型 2 基模型'), undefined)
      assert.doesNotMatch(ui.textOf(), /旧草稿中的推理模型引用/)
      const migrated = JSON.parse(storage.get(key)).draft
      assert.equal(migrated.modelSuggestions.length, 1)
      assert.equal(migrated.modelSuggestions[0].revision, revision)
      assert.equal(migrated.medium.revision, undefined)
      if (phase === 1) {
        await ui.submit()
        assert.deepEqual(JSON.parse(JSON.stringify(ui.sent[0].medium.models)), [{ kind: 'decision', source: 'unspecified', baseModel: '', revision, purpose: '训练基模型参考' }])
        assert.equal('revision' in ui.sent[0].medium, false)
      }
      assert.equal(ui.calls.some(call => call.method === 'models/list'), false)
    } finally { ui.cleanup() }
  }
})

test('旧目录草稿无模型 ID 但有 Revision 仍可只读核对，再挂载保留且不进入发送', async () => {
  const revision = 'legacy-inference-revision-only', { storage, key } = await revisionOnlyLegacyDraft('catalog', revision)
  for (let phase = 0; phase < 2; phase++) {
    const ui = mountedDialog({ storage })
    try {
      await ui.settle()
      assert.equal(ui.field('goal').props.value, 'catalog 旧草稿目标')
      assert.equal(ui.field('advanced').props.value, '保留旧修订版验收要求')
      assert.match(ui.textOf(), /旧草稿中的推理模型引用.*未填写模型引用.*原版本：legacy-inference-revision-only/s)
      assert.ok(ui.button('移除旧引用'))
      assert.equal(ui.field('baseModelId'), undefined)
      assert.equal(ui.byLabel('模型 1 基模型'), undefined)
      const migrated = JSON.parse(storage.get(key)).draft
      assert.equal(migrated.previousInferenceModel, null)
      assert.equal(migrated.previousInferenceRevision, revision)
      assert.deepEqual(migrated.modelSuggestions, [])
      assert.equal(migrated.medium.revision, undefined)
      if (phase === 1) {
        await ui.submit()
        assert.deepEqual(Array.from(ui.sent[0].medium.models), [])
        assert.doesNotMatch(JSON.stringify(ui.sent[0]), /legacy-inference-revision-only|previousInference|baseModelMode|baseModelId/)
      }
      assert.equal(ui.calls.some(call => call.method === 'models/list'), false)
    } finally { ui.cleanup() }
  }
})
