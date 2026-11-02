import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/instances/external-client.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })).outputFiles[0].text
const agent = { id: 'agent-demo', name: '接入助手', system: '测试系统', owner: '责任组' }
const instance = { id: 'instance-demo', agentId: agent.id, name: '远程模拟实例', framework: 'agentscope', endpoint: 'http://127.0.0.1:19200', state: 'registered', entryState: 'enabled', managementMode: 'externally-managed', usageMode: 'shared', revision: 1, bindingDigest: 'binding', createdAt: '2026-11-02T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z' }
const detail = { revision: 'revision-1', agent, instance, policy: { instanceId: instance.id, subjects: ['platform-owner'], actions: ['agent:access', 'session:create', 'session:prompt', 'session:read'], enabled: true }, records: [] }
const identity = { instanceId: instance.id, credentials: [], grants: [], resources: [], issuer: 'https://issuer.example', revision: 'grant-revision' }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function page(respond = () => undefined, items = [instance]) {
  const states = [], dependencies = [], cleanups = [], calls = []
  let cursor = 0, effects = [], changed = false, tree, focused = '', expandedFor = ''
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useMemo(factory, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; states[at] = factory() } return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), Date, Math, URL, crypto: { randomUUID: (() => { let n = 0; return () => `request-${++n}` })() } })
  const props = { active: true, rpc: { async call(_channel, endpoint, payload) {
    calls.push({ endpoint, payload })
    const custom = await respond(endpoint, payload)
    if (custom !== undefined) return custom
    if (endpoint.endsWith('/list')) return { ok: true, value: { revision: 'revision-1', agents: [agent], instances: items, observedAt: '2026-11-02T00:00:00Z' } }
    if (endpoint.endsWith('/detail')) return { ok: true, value: { ...detail, instance: items.find(item => item.id === payload.id) ?? instance } }
    if (endpoint.endsWith('agentAccess/status')) return { ok: true, value: identity }
    if (['save', 'enable', 'verify', 'disable', 'remove'].some(action => endpoint.endsWith('/' + action))) return { ok: true, value: detail }
    throw new Error('unexpected operation: ' + endpoint)
  } } }
  const attach = value => {
    if (Array.isArray(value)) return value.forEach(attach)
    if (!value || typeof value !== 'object') return
    if (value.type === 'dialog' && value.ref && !value.ref.current) value.ref.current = { open: false, showModal() { this.open = true }, close() { this.open = false }, querySelector(selector) { const label = /aria-label="([^"]+)"/.exec(selector)?.[1]; return label && field(label) ? { focus() { focused = label }, closest(name) { return name === 'details' ? { setAttribute() { expandedFor = label } } : null } } : null } }
    attach(value.props?.children)
  }
  function render() {
    let count = 0
    do { if (++count > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.ExternalInstancesPage(props); attach(tree); effects.forEach(effect => effect()) } while (changed)
  }
  async function settle() { for (let n = 0; n < 5; n++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || value.props?.hidden || value.type === 'dialog' && !value.ref?.current?.open) return []; if (typeof value.type === 'function') return nodes(value.type(value.props)); return [value, ...nodes(value.props?.children)] }
  function text(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object') { if (value.props?.hidden || value.type === 'style' || value.type === 'dialog' && !value.ref?.current?.open) return ''; if (typeof value.type === 'function') return text(value.type(value.props)); return value.props?.children === undefined ? '' : text(value.props.children) } return String(value ?? '') }
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label && !node.props.disabled)
  const field = label => nodes().find(node => node.props?.['aria-label'] === label)
  function type(label, value) { assert.ok(field(label), label); field(label).props.onChange({ target: { value } }); render() }
  render()
  return { calls, render, settle, text, nodes, button, type, field, get focused() { return focused }, get expandedFor() { return expandedFor }, setActive(active) { props.active = active; render() } }
}

test('接入列表读取失败与空登记分开，恢复后可登记且不依赖EXP', async () => {
  let failed = true
  const ui = page(endpoint => endpoint.endsWith('/list') && failed ? { ok: false, error: { message: '连接暂时中断' } } : undefined, [])
  await ui.settle()
  assert.match(ui.text(), /接入登记读取失败/)
  assert.doesNotMatch(ui.text(), /尚无接入登记/)
  failed = false; await ui.button('重新读取接入登记').props.onClick(); await ui.settle()
  assert.match(ui.text(), /尚无接入登记/)
  assert.ok(ui.button('登记已有智能体'))
})

test('单一表单保留关闭草稿并提交自定义连接、责任和入口授权', async () => {
  const ui = page(); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  ui.type('接入智能体名称', '新的助手'); ui.type('接入实例名称', '远程实例'); ui.type('接入所属系统', '样本系统'); ui.type('接入责任主体', '维护组')
  assert.equal(ui.button('下一步'), undefined)
  ui.type('接入服务地址', 'http://127.0.0.1:19200'); ui.type('接入目标选择器', 'runtime-agent'); ui.type('接入允许主体', 'platform-owner, user-custom')
  ui.type('接入声明版本', '2.0.8'); ui.type('接入运行位置', '模拟远程主机'); ui.type('接入实例运维责任', '实例维护组')
  ui.button('关闭并保留草稿').props.onClick(); ui.render()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  assert.equal(ui.field('接入服务地址').props.value, 'http://127.0.0.1:19200')
  await ui.button('保存登记').props.onClick(); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint === 'instances/external/save')
  assert.equal(saved.payload.instance.managementMode, 'externally-managed')
  assert.equal(saved.payload.instance.framework, 'agentscope')
  assert.equal(saved.payload.instance.selector, 'runtime-agent')
  assert.equal(saved.payload.instance.name, '远程实例')
  assert.equal(saved.payload.instance.declaredVersion, '2.0.8')
  assert.equal(saved.payload.instance.location, '模拟远程主机')
  assert.equal(saved.payload.instance.instanceOwner, '实例维护组')
  assert.equal(saved.payload.agent.system, '样本系统')
  assert.equal(saved.payload.agent.owner, '维护组')
  assert.ok(saved.payload.policy.actions.includes('agent:access'))
  assert.deepEqual(Array.from(saved.payload.policy.subjects), ['platform-owner', 'user-custom'])
  assert.equal('source' in saved.payload, false)
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
})

test('保存超时只回读原请求，不重复创建或自动启用', async () => {
  const ui = page((endpoint) => {
    if (endpoint.endsWith('/save')) throw new Error('request timeout')
    if (endpoint.endsWith('/request')) return { ok: true, value: { found: true, detail } }
  }); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  ui.type('接入智能体名称', '助手')
  await ui.button('保存登记').props.onClick(); await ui.settle()
  assert.ok(ui.button('核对保存结果')); assert.equal(ui.button('保存登记'), undefined)
  await ui.button('核对保存结果').props.onClick(); await ui.settle()
  const saved = ui.calls.filter(call => call.endpoint.endsWith('/save'))
  const checked = ui.calls.find(call => call.endpoint.endsWith('/request'))
  assert.equal(saved.length, 1)
  assert.equal(checked.payload.requestId, saved[0].payload.requestId)
  assert.equal(ui.calls.some(call => call.endpoint.endsWith('/enable')), false)
  assert.match(ui.text(), /没有重复提交/)
})

for (const lostPhase of ['verify', 'enable']) test(`${lostPhase}已执行但响应丢失时回读该阶段真实请求，锁定草稿且不继续后续操作`, async () => {
  let current = detail
  const ui = page((endpoint, payload) => {
    if (endpoint.endsWith('/save')) {
      current = { ...detail, instance: { ...instance, entryState: 'pending' } }
      return { ok: true, value: current }
    }
    if (endpoint.endsWith('/verify')) {
      current = { ...current, revision: 'verified-revision' }
      if (lostPhase === 'verify') throw new Error('connection lost after verify')
      return { ok: true, value: current }
    }
    if (endpoint.endsWith('/enable')) {
      current = { ...current, revision: 'enabled-revision', instance: { ...current.instance, entryState: 'enabled' } }
      throw new Error('connection lost after enable')
    }
    if (endpoint.endsWith('/request')) return { ok: true, value: { found: true, detail: current } }
    if (endpoint.endsWith('/detail')) return { ok: true, value: current }
  }); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  ui.type('接入智能体名称', '阶段恢复'); ui.type('接入实例框架', 'opencode'); ui.type('接入服务地址', 'http://runtime.example:19200')
  await ui.button('验证并启用访问').props.onClick(); await ui.settle()
  assert.ok(ui.button('核对保存结果'))
  assert.equal(ui.nodes().find(node => node.type === 'fieldset').props.disabled, true)
  ui.type('接入服务地址', 'http://must-not-replay.example')
  assert.equal(ui.field('接入服务地址').props.value, instance.endpoint)
  ui.button('关闭并保留草稿').props.onClick(); ui.render()
  ui.button('编辑接入').props.onClick(); ui.render()
  assert.ok(ui.button('核对保存结果'))
  assert.equal(ui.button('保存登记'), undefined)
  await ui.button('核对保存结果').props.onClick(); await ui.settle()
  const lost = ui.calls.find(call => call.endpoint.endsWith('/' + lostPhase))
  const checked = ui.calls.find(call => call.endpoint.endsWith('/request'))
  assert.equal(checked.payload.requestId, lost.payload.requestId)
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/save')).length, 1)
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/verify')).length, 1)
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/enable')).length, lostPhase === 'verify' ? 0 : 1)
  assert.match(ui.text(), /没有重复提交或继续执行后续操作/)
  assert.match(ui.text(), lostPhase === 'verify' ? /当前入口状态（待验证）/ : /当前入口状态（已启用）/)
})

test('最简OpenCode不展开更多设置即可保存验证启用，默认不额外放权', async () => {
  const ui = page(); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  ui.type('接入智能体名称', '代码助手'); ui.type('接入实例框架', 'opencode'); ui.type('接入服务地址', 'http://runtime.example:19200')
  const more = ui.nodes().find(node => node.type === 'details' && ui.text(node.props.children[0]).includes('更多设置'))
  assert.equal(Boolean(more.props.open), false)
  assert.equal(ui.field('接入目标选择器'), undefined)
  for (const label of ['接入智能体名称', '接入实例框架', '接入服务地址']) {
    assert.equal(ui.field(label).props.required, true)
    assert.equal(ui.field(label).props['aria-required'], 'true')
  }
  await ui.button('验证并启用访问').props.onClick(); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint.endsWith('/save'))
  assert.equal(saved.payload.agent.name, '代码助手')
  assert.equal(saved.payload.agent.system, 'runtime.example')
  assert.equal(saved.payload.agent.owner, '平台管理者')
  assert.equal(saved.payload.instance.name, '代码助手')
  assert.equal(saved.payload.instance.selector, undefined)
  assert.deepEqual(Array.from(saved.payload.policy.subjects), ['platform-owner'])
  assert.deepEqual(ui.calls.filter(call => /\/(save|verify|enable)$/.test(call.endpoint)).map(call => call.endpoint), ['instances/external/save', 'instances/external/verify', 'instances/external/enable'])
})

test('仅名称可保存登记草稿，连接与责任字段使用明确默认值', async () => {
  const ui = page(); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render(); ui.type('接入智能体名称', '稍后连接')
  await ui.button('保存登记').props.onClick(); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint.endsWith('/save'))
  assert.equal(saved.payload.instance.endpoint, '')
  assert.equal(saved.payload.instance.name, '稍后连接')
  assert.equal(saved.payload.agent.system, '未填写')
  assert.equal(saved.payload.agent.owner, '平台管理者')
  assert.equal(ui.calls.some(call => /\/(verify|enable)$/.test(call.endpoint)), false)
})

test('AgentScope启用逐项指出缺少字段并聚焦，清空默认访问主体不自动回填', async () => {
  const ui = page(); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  await ui.button('验证并启用访问').props.onClick(); ui.render()
  assert.equal(ui.focused, '接入智能体名称')
  ui.type('接入智能体名称', '运行助手')
  await ui.button('验证并启用访问').props.onClick(); ui.render()
  assert.equal(ui.focused, '接入服务地址')
  ui.type('接入服务地址', 'http://runtime.example:19200')
  await ui.button('验证并启用访问').props.onClick(); ui.render()
  assert.equal(ui.focused, '接入目标选择器')
  assert.match(ui.text(), /请填写 AgentScope 服务中的 Agent ID/)
  ui.type('接入目标选择器', 'native-agent'); ui.type('接入允许主体', '')
  await ui.button('验证并启用访问').props.onClick(); ui.render()
  assert.equal(ui.focused, '接入允许主体'); assert.equal(ui.expandedFor, '接入允许主体')
  assert.equal(ui.field('接入允许主体').props.value, '')
  assert.equal(ui.calls.some(call => call.endpoint.endsWith('/save')), false)
  ui.type('接入允许主体', 'platform-owner'); ui.type('接入开放操作', '')
  await ui.button('验证并启用访问').props.onClick(); ui.render()
  assert.equal(ui.focused, '接入开放操作')
  assert.match(ui.text(), /保留 agent:access/)
})

test('DSH以两个必填字段序列化目标，框架切换保留各自目标而不混用', async () => {
  const ui = page(); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  ui.type('接入智能体名称', 'DSH助手'); ui.type('接入服务地址', 'http://dsh.example:19200'); ui.type('接入目标选择器', 'as-agent')
  ui.type('接入实例框架', 'dsh')
  await ui.button('验证并启用访问').props.onClick(); ui.render()
  assert.equal(ui.focused, '接入工作区ID')
  assert.equal(ui.field('接入工作区ID').props.required, true)
  ui.type('接入工作区ID', 'workspace-dsh')
  await ui.button('验证并启用访问').props.onClick(); ui.render()
  assert.equal(ui.focused, '接入AgentPreset')
  ui.type('接入AgentPreset', 'standard')
  ui.type('接入实例框架', 'opencode'); assert.equal(ui.field('接入工作目录').props.value, '')
  ui.type('接入工作目录', '/work/code')
  ui.type('接入实例框架', 'agentscope'); assert.equal(ui.field('接入目标选择器').props.value, 'as-agent')
  ui.type('接入实例框架', 'opencode'); assert.equal(ui.field('接入工作目录').props.value, '/work/code')
  ui.type('接入实例框架', 'dsh')
  assert.equal(ui.field('接入工作区ID').props.value, 'workspace-dsh'); assert.equal(ui.field('接入AgentPreset').props.value, 'standard')
  await ui.button('验证并启用访问').props.onClick(); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint.endsWith('/save'))
  assert.deepEqual(JSON.parse(saved.payload.instance.selector), { workspaceId: 'workspace-dsh', agentPreset: 'standard' })
  assert.equal(saved.payload.instance.framework, 'dsh')
})

test('关联对象公共信息只读，编辑不把已有访问范围解释为新登记默认值', async () => {
  const ui = page(); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render(); ui.type('关联已登记智能体', agent.id)
  for (const label of ['接入智能体名称', '接入所属系统', '接入责任主体']) assert.equal(ui.field(label).props.readOnly, true)
  await ui.button('保存登记').props.onClick(); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint.endsWith('/save'))
  assert.equal(saved.payload.agent.id, agent.id); assert.equal(saved.payload.agent.owner, agent.owner)
  ui.button('编辑接入').props.onClick(); ui.render()
  assert.match(ui.text(), /实际值以字段内容为准/)
  assert.doesNotMatch(ui.text(), /新登记默认仅平台管理者/)
  assert.equal(ui.field('关联已登记智能体').props.disabled, true)
})

test('最简保存后验证失败，再改地址重试仍沿用已持久化的公共身份和默认值', async () => {
  let stored
  const ui = page((endpoint, payload) => {
    if (endpoint.endsWith('/save')) {
      stored = { ...detail, revision: 'saved-revision', agent: { ...payload.agent, id: 'new-agent' }, instance: { ...instance, ...payload.instance, id: 'new-instance', agentId: 'new-agent' }, policy: { ...payload.policy, instanceId: 'new-instance' } }
      return { ok: true, value: stored }
    }
    if (endpoint.endsWith('/verify')) return { ok: false, error: { code: 'upstream_error', message: '连接验证失败' } }
  }); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  ui.type('接入智能体名称', '持久化助手'); ui.type('接入实例框架', 'opencode'); ui.type('接入服务地址', 'http://original.example:19200')
  await ui.button('验证并启用访问').props.onClick(); await ui.settle()
  assert.match(ui.text(), /连接验证失败/)
  assert.equal(ui.field('接入所属系统').props.value, 'original.example')
  assert.equal(ui.field('接入所属系统').props.readOnly, true)
  assert.equal(ui.field('接入智能体名称').props.readOnly, true)
  assert.equal(ui.field('接入实例名称').props.value, '持久化助手')
  ui.type('接入服务地址', 'http://replacement.example:19200')
  await ui.button('验证并启用访问').props.onClick(); await ui.settle()
  const saves = ui.calls.filter(call => call.endpoint.endsWith('/save'))
  assert.equal(saves.length, 2)
  assert.equal(saves[1].payload.agent.id, 'new-agent')
  assert.equal(saves[1].payload.agent.system, 'original.example')
  assert.equal(saves[1].payload.agent.owner, '平台管理者')
  assert.equal(saves[1].payload.instance.name, '持久化助手')
  assert.equal(saves[1].payload.instance.agentId, 'new-agent')
  assert.equal(saves[1].payload.instance.endpoint, 'http://replacement.example:19200')
  assert.equal(ui.calls.some(call => call.endpoint.endsWith('/enable')), false)
})

test('版本冲突后读取最新版本仍保留自定义草稿，重试使用新版本与请求标识', async () => {
  let conflict = true
  const ui = page(endpoint => {
    if (endpoint.endsWith('/save') && conflict) { conflict = false; return { ok: false, error: { code: 'conflict', message: '登记已在其他位置更新' } } }
    if (endpoint.endsWith('/list')) return { ok: true, value: { revision: conflict ? 'revision-1' : 'revision-2', agents: [agent], instances: [instance], observedAt: '2026-11-02T00:00:00Z' } }
  }); await ui.settle()
  ui.button('登记已有智能体').props.onClick(); ui.render()
  ui.type('接入智能体名称', '冲突草稿'); ui.type('接入责任主体', '自定义维护组'); ui.type('接入实例名称', '自定义实例')
  await ui.button('保存登记').props.onClick(); await ui.settle()
  assert.match(ui.text(), /登记已在其他位置更新/)
  await ui.button('保留草稿并读取最新版本').props.onClick(); await ui.settle()
  assert.equal(ui.field('接入智能体名称').props.value, '冲突草稿')
  assert.equal(ui.field('接入责任主体').props.value, '自定义维护组')
  assert.equal(ui.field('接入实例名称').props.value, '自定义实例')
  await ui.button('保存登记').props.onClick(); await ui.settle()
  const saves = ui.calls.filter(call => call.endpoint.endsWith('/save'))
  assert.equal(saves[0].payload.revision, 'revision-1'); assert.equal(saves[1].payload.revision, 'revision-2')
  assert.notEqual(saves[0].payload.requestId, saves[1].payload.requestId)
  assert.equal(saves[1].payload.agent.owner, '自定义维护组')
  assert.equal(saves[1].payload.instance.name, '自定义实例')
})

test('较旧详情响应不能切换当前对象，秘密只在创建交付中显示', async () => {
  const old = deferred(), second = { ...instance, id: 'second-instance', name: '第二个实例' }
  const ui = page((endpoint, payload) => {
    if (endpoint.endsWith('/detail') && payload.id === instance.id) return old.promise
    if (endpoint.endsWith('agentAccess/createCredential')) return { ok: true, value: { credential: { id: 'credential-1', clientId: 'client-1', instanceId: second.id, expiresAt: '2026-12-01T00:00:00Z' }, secret: 'only-create-secret' } }
  }, [instance, second]); await ui.settle()
  let buttons = ui.nodes().filter(node => node.type === 'button' && ui.text(node) === '查看接入详情')
  buttons[0].props.onClick(); ui.render(); buttons[1].props.onClick(); ui.render(); await ui.settle()
  old.resolve({ ok: true, value: detail }); await ui.settle()
  const header = ui.nodes().find(node => node.type === 'h2')
  assert.equal(ui.text(header), second.name)
  ui.nodes().find(node => node.props.role === 'tab' && ui.text(node) === '接入与能力').props.onClick(); ui.render()
  assert.equal(ui.field('仅本次交付的实例secret'), undefined)
  await ui.button('创建实例凭据').props.onClick(); await ui.settle()
  assert.equal(ui.field('仅本次交付的实例secret').props.value, 'only-create-secret')
  ui.button('已交付，关闭秘密').props.onClick(); ui.render()
  assert.equal(ui.field('仅本次交付的实例secret'), undefined)
  assert.doesNotMatch(ui.text(), /only-create-secret/)
})

test('入口停用准确确认，访问输入关闭与隐藏后保留且不重放请求', async () => {
  const ui = page(); await ui.settle()
  ui.button('查看接入详情').props.onClick(); ui.render(); await ui.settle()
  ui.button('停用入口').props.onClick(); ui.render()
  assert.match(ui.text(), /不会停止远端进程/)
  await ui.button('确认停用入口').props.onClick(); await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/disable')).length, 1)
  ui.button('访问此实例').props.onClick(); ui.render()
  ui.type('接入实例访问输入', '保留这份待发送内容')
  ui.button('关闭并保留输入').props.onClick(); ui.render(); ui.setActive(false); ui.setActive(true); await ui.settle()
  ui.button('访问此实例').props.onClick(); ui.render()
  assert.equal(ui.field('接入实例访问输入').props.value, '保留这份待发送内容')
  assert.equal(ui.calls.some(call => call.endpoint.endsWith('/invoke')), false)
})
