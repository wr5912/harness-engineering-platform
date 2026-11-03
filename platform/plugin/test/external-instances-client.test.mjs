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

function page(respond = () => undefined, items = [instance], { storage = new Map(), username = 'owner', workspaceId = 'workspace-test' } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = []
  const timers = new Map(); let timerId = 0
  let cursor = 0, effects = [], changed = false, tree, focused = '', expandedFor = ''
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useMemo(factory, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; states[at] = factory() } return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), Date, Math, URL, AbortController, AbortSignal, sessionStorage: { getItem(key) { return storage.get(key) ?? null }, setItem(key, value) { storage.set(key, value) } }, setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) }, crypto: { randomUUID: (() => { let n = 0; return () => `request-${++n}` })() } })
  const props = { active: true, rpc: { async call(_channel, endpoint, payload) {
    calls.push({ endpoint, payload })
    const custom = await respond(endpoint, payload)
    if (custom !== undefined) return custom
    if (endpoint === 'auth/current') return { ok: true, value: { username } }
    if (endpoint.endsWith('/credentials')) return { ok: true, value: { refs: ['existing-native-credential'] } }
    if (endpoint.endsWith('/discover')) return { ok: true, value: { framework: payload.framework, endpoint: payload.endpoint, observedAt: '2026-11-03T00:00:00Z', status: 'selected', selector: payload.framework === 'agentscope' ? 'native-agent' : payload.framework === 'dsh' ? JSON.stringify({ workspaceId: 'workspace-one', agentPreset: 'standard' }) : undefined, agents: payload.framework === 'agentscope' ? { status: 'ready', items: [{ id: 'native-agent', name: '远端助手' }] } : undefined, workspaces: payload.framework === 'dsh' ? { status: 'ready', items: [{ id: 'workspace-one', name: '默认工作区' }] } : undefined, presets: payload.framework === 'dsh' ? { status: 'ready', items: [{ id: 'standard', name: '标准助手' }] } : undefined } }
    if (endpoint.endsWith('/conversation/send')) return { ok: true, value: { requestId: payload.requestId, sessionId: payload.sessionId ?? 'native-session', status: 'running', messages: [], tools: [] } }
    if (endpoint.endsWith('/conversation/status')) return { ok: true, value: { requestId: payload.requestId, sessionId: 'native-session', status: 'completed', messages: [{ id: 'assistant-final', role: 'assistant', text: '本次真实结果' }], tools: [] } }
    if (endpoint.endsWith('/list')) return { ok: true, value: { revision: 'revision-1', workspaceId, agents: [agent], instances: items, observedAt: '2026-11-02T00:00:00Z' } }
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
  return { calls, storage, dispose() { for (const cleanup of cleanups) cleanup?.() }, render, settle, text, nodes, button, type, field, async tick() { const entries = [...timers.entries()].filter(([, item]) => item.ms < 20000); for (const [id, item] of entries) { if (timers.delete(id)) item.fn() }; await settle() }, get focused() { return focused }, get expandedFor() { return expandedFor }, setActive(active) { props.active = active; render() } }
}

async function openRegistration(ui, framework = 'agentscope') {
  await ui.settle(); ui.button('登记已有智能体').props.onClick(); ui.render()
  if (framework !== 'agentscope') ui.type('接入实例框架', framework)
}
async function openDetail(ui, index = 0) {
  await ui.settle(); ui.nodes().filter(node => node.type === 'button' && ui.text(node) === '查看接入详情')[index].props.onClick(); ui.render(); await ui.settle()
}
async function findTarget(ui) { await ui.button('查找智能体').props.onClick(); await ui.settle() }
function tab(ui, name) { ui.nodes().find(node => node.props.role === 'tab' && ui.text(node) === name).props.onClick(); ui.render() }
const conversationResult = (payload, status, text = '') => ({ requestId: payload.requestId, sessionId: 'native-session', status, messages: text ? [{ id: 'assistant-final', role: 'assistant', text }] : [], tools: [] })

test('读取失败与空登记分开，恢复后可登记且不依赖EXP', async () => {
  let failed = true
  const ui = page(endpoint => endpoint.endsWith('/list') && failed ? { ok: false, error: { message: '连接暂时中断' } } : undefined, [])
  await ui.settle(); assert.match(ui.text(), /接入登记读取失败/); assert.doesNotMatch(ui.text(), /尚无接入登记/)
  failed = false; await ui.button('重新读取接入登记').props.onClick(); await ui.settle()
  assert.match(ui.text(), /尚无接入登记/); assert.ok(ui.button('登记已有智能体'))
})

test('登记只呈现连接与目标，归属和授权不再塞入普通表单', async () => {
  const ui = page(); await openRegistration(ui)
  for (const label of ['接入所属系统', '接入责任主体', '接入运行位置', '接入实例运维责任', '接入声明版本', '接入允许主体', '接入开放操作', '关联已登记智能体', '接入目标选择器']) assert.equal(ui.field(label), undefined, label)
  for (const label of ['接入实例框架', '接入服务地址']) { assert.equal(ui.field(label).props.required, true); assert.equal(ui.field(label).props['aria-required'], 'true') }
  assert.equal(ui.field('接入智能体名称').props.required, undefined)
  assert.equal(ui.button('下一步'), undefined); assert.doesNotMatch(ui.text(), /更多设置/)
})

test('唯一AgentScope目标按名称自动选，ID自动保存且仅引用已有凭据', async () => {
  const ui = page(); await openRegistration(ui)
  ui.type('接入服务地址', 'http://as.example:8000'); ui.type('接入连接凭据', 'existing-native-credential'); await findTarget(ui)
  assert.equal(ui.field('接入智能体选择').props.value, 'native-agent'); assert.match(ui.text(ui.field('接入智能体选择')), /远端助手/)
  assert.equal(ui.field('接入智能体名称').props.value, ''); assert.equal(ui.field('接入智能体名称').props.placeholder, '远端助手')
  await ui.button('验证并接入').props.onClick(); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint.endsWith('/save')).payload
  assert.equal(saved.agent.name, '远端助手'); assert.equal(saved.instance.selector, 'native-agent'); assert.equal(saved.instance.credentialRef, 'existing-native-credential')
  for (const key of ['system', 'owner']) assert.equal(key in saved.agent, false)
  assert.equal('policy' in saved, false); assert.equal('managementMode' in saved.instance, false); assert.equal('usageMode' in saved.instance, false)
  assert.equal(ui.calls.find(call => call.endpoint.endsWith('/discover')).payload.connectionUserId, undefined)
})

test('最简OpenCode仅服务地址即可验证启用，默认事实由后端提供', async () => {
  const ui = page(); await openRegistration(ui, 'opencode'); ui.type('接入服务地址', 'http://code.example:4096')
  await ui.button('验证并接入').props.onClick(); await ui.settle()
  const payload = ui.calls.find(call => call.endpoint.endsWith('/save')).payload
  assert.deepEqual(Object.keys(payload.agent), []); assert.equal(payload.instance.endpoint, 'http://code.example:4096')
  assert.equal('name' in payload.instance, false); assert.equal('policy' in payload, false)
  assert.deepEqual(ui.calls.filter(call => /\/(save|verify|enable)$/.test(call.endpoint)).map(call => call.endpoint), ['instances/external/save', 'instances/external/verify', 'instances/external/enable'])
})

test('关闭登记保留名称和原账号草稿，不重放发现/保存', async () => {
  const ui = page(); await openRegistration(ui)
  ui.type('接入智能体名称', '我的助手'); ui.type('接入服务地址', 'http://native.example'); ui.type('接入原系统账号', 'remote-user')
  ui.button('关闭并保留草稿').props.onClick(); ui.render(); ui.button('登记已有智能体').props.onClick(); ui.render()
  assert.equal(ui.field('接入智能体名称').props.value, '我的助手'); assert.equal(ui.field('接入原系统账号').props.value, 'remote-user')
  assert.equal(ui.calls.some(call => /\/(save|discover)$/.test(call.endpoint)), false)
  await ui.button('保存草稿').props.onClick(); await ui.settle()
  assert.equal(ui.calls.find(call => call.endpoint.endsWith('/save')).payload.instance.connectionUserId, 'remote-user')
  assert.equal(ui.calls.some(call => /\/(verify|enable)$/.test(call.endpoint)), false)
})

test('DSH多项按名称选并序列化，切框架清旧目标', async () => {
  const ui = page((endpoint, payload) => endpoint.endsWith('/discover') ? { ok: true, value: { framework: 'dsh', endpoint: payload.endpoint, status: 'selection_required', workspaces: { status: 'ready', items: [{ id: 'workspace-a', name: '项目甲' }, { id: 'workspace-b', name: '项目乙' }] }, presets: { status: 'ready', items: [{ id: 'research', name: '研究助手' }, { id: 'standard', name: '标准助手' }] } } } : undefined)
  await openRegistration(ui, 'dsh'); ui.type('接入服务地址', 'http://dsh.example'); await findTarget(ui)
  assert.equal(ui.field('接入工作区选择').props.value, '')
  ui.type('接入工作区选择', 'workspace-b'); ui.type('接入智能体选择', 'research')
  await ui.button('保存草稿').props.onClick(); await ui.settle()
  assert.deepEqual(JSON.parse(ui.calls.find(call => call.endpoint.endsWith('/save')).payload.instance.selector), { workspaceId: 'workspace-b', agentPreset: 'research' })
  ui.button('登记已有智能体').props.onClick(); ui.render(); ui.type('接入服务地址', 'http://dsh-other.example'); await findTarget(ui)
  ui.type('接入工作区选择', 'workspace-a'); ui.type('接入智能体选择', 'standard'); ui.type('接入实例框架', 'agentscope')
  assert.equal(ui.field('接入智能体选择'), undefined); assert.equal(ui.field('接入目标选择器'), undefined)
})

for (const [state, expected] of [['empty', '没有可用对象'], ['unauthorized', '需要有效的原系统认证'], ['forbidden', '当前账号无权查看'], ['unsupported', '原系统暂不支持查询'], ['failed', '查询失败']]) test(`发现${state}说明准确，只有失败才展示管理员目标回退`, async () => {
  const ui = page((endpoint, payload) => endpoint.endsWith('/discover') ? { ok: true, value: { framework: 'agentscope', endpoint: payload.endpoint, status: 'unavailable', agents: { status: state, items: [] } } } : undefined)
  await openRegistration(ui); assert.equal(ui.field('接入目标选择器'), undefined)
  ui.type('接入服务地址', 'http://as.example'); await findTarget(ui); assert.match(ui.text(), new RegExp(expected)); assert.ok(ui.field('接入目标选择器'))
  ui.type('接入目标选择器', 'administrator-known-agent'); await ui.button('保存草稿').props.onClick(); await ui.settle()
  assert.equal(ui.calls.find(call => call.endpoint.endsWith('/save')).payload.instance.selector, 'administrator-known-agent')
})

test('漏地址或未选目标聚焦当前操作，不先保存', async () => {
  const ui = page(); await openRegistration(ui)
  await ui.button('验证并接入').props.onClick(); ui.render(); assert.equal(ui.focused, '接入服务地址')
  ui.type('接入服务地址', 'http://as.example'); await ui.button('验证并接入').props.onClick(); ui.render()
  assert.equal(ui.focused, '发现远端智能体'); assert.match(ui.text(), /查找并选择/); assert.equal(ui.calls.some(call => call.endpoint.endsWith('/save')), false)
})

test('保存超时只查原请求，不重复创建或自动启用', async () => {
  const ui = page(endpoint => { if (endpoint.endsWith('/save')) throw new Error('request timeout'); if (endpoint.endsWith('/request')) return { ok: true, value: { found: true, detail } } })
  await openRegistration(ui); ui.type('接入智能体名称', '助手'); await ui.button('保存草稿').props.onClick(); await ui.settle()
  assert.ok(ui.button('核对保存结果')); assert.equal(ui.button('保存草稿'), undefined)
  await ui.button('核对保存结果').props.onClick(); await ui.settle()
  const saved = ui.calls.filter(call => call.endpoint.endsWith('/save')), checked = ui.calls.find(call => call.endpoint.endsWith('/request'))
  assert.equal(saved.length, 1); assert.equal(checked.payload.requestId, saved[0].payload.requestId); assert.equal(ui.calls.some(call => call.endpoint.endsWith('/enable')), false)
})

for (const lostPhase of ['verify', 'enable']) test(`${lostPhase}响应丢失回读真实阶段ID，锁草稿不继续写入`, async () => {
  let current = detail
  const ui = page(endpoint => {
    if (endpoint.endsWith('/save')) { current = { ...detail, instance: { ...instance, entryState: 'pending' } }; return { ok: true, value: current } }
    if (endpoint.endsWith('/verify')) { current = { ...current, revision: 'verified' }; if (lostPhase === 'verify') throw new Error('lost verify'); return { ok: true, value: current } }
    if (endpoint.endsWith('/enable')) { current = { ...current, revision: 'enabled', instance: { ...instance, entryState: 'enabled' } }; throw new Error('lost enable') }
    if (endpoint.endsWith('/request') || endpoint.endsWith('/detail')) return { ok: true, value: endpoint.endsWith('/request') ? { found: true, detail: current } : current }
  })
  await openRegistration(ui, 'opencode'); ui.type('接入服务地址', 'http://code.example'); await ui.button('验证并接入').props.onClick(); await ui.settle()
  assert.ok(ui.button('核对保存结果')); assert.equal(ui.nodes().find(node => node.type === 'fieldset').props.disabled, true)
  ui.type('接入服务地址', 'http://do-not-send.example'); assert.equal(ui.field('接入服务地址').props.value, instance.endpoint)
  ui.button('关闭并保留草稿').props.onClick(); ui.render(); ui.button('编辑实例名称').props.onClick(); ui.render()
  assert.ok(ui.button('核对保存结果')); await ui.button('核对保存结果').props.onClick(); await ui.settle()
  assert.equal(ui.calls.find(call => call.endpoint.endsWith('/request')).payload.requestId, ui.calls.find(call => call.endpoint.endsWith('/' + lostPhase)).payload.requestId)
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/save')).length, 1); assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/enable')).length, lostPhase === 'verify' ? 0 : 1)
  assert.match(ui.text(), /没有重复提交或继续执行后续操作/)
})

test('连接/名称/授权独立表单，保存只传所属字段', async () => {
  const ui = page(); await openDetail(ui); ui.button('编辑实例名称').props.onClick(); ui.render(); assert.equal(ui.field('接入服务地址'), undefined)
  ui.type('接入实例名称', '新实例名'); await ui.button('保存修改').props.onClick(); await ui.settle()
  let payload = ui.calls.filter(call => call.endpoint.endsWith('/save')).at(-1).payload
  assert.deepEqual(Object.keys(payload.instance).sort(), ['id', 'name']); assert.equal(payload.agent.id, agent.id); assert.equal('name' in payload.agent, false); assert.equal('policy' in payload, false)
  tab(ui, '访问授权'); ui.button('编辑入口授权').props.onClick(); ui.render(); assert.equal(ui.field('接入实例名称'), undefined)
  ui.type('接入允许主体', ''); await ui.button('保存修改').props.onClick(); ui.render(); assert.equal(ui.focused, '接入允许主体')
  ui.type('接入允许主体', 'owner-real'); await ui.button('保存修改').props.onClick(); await ui.settle()
  payload = ui.calls.filter(call => call.endpoint.endsWith('/save')).at(-1).payload
  assert.deepEqual(Object.keys(payload.instance), ['id']); assert.deepEqual(Array.from(payload.policy.subjects), ['owner-real']); assert.equal(payload.policy.enabled, true)
  tab(ui, '接入与能力'); ui.button('修改连接').props.onClick(); ui.render(); assert.equal(ui.field('接入允许主体'), undefined); assert.equal(ui.field('接入智能体名称'), undefined)
  await findTarget(ui); assert.equal(ui.calls.find(call => call.endpoint.endsWith('/discover')).payload.id, instance.id)
  await ui.button('保存草稿').props.onClick(); await ui.settle(); payload = ui.calls.filter(call => call.endpoint.endsWith('/save')).at(-1).payload
  assert.equal('policy' in payload, false); assert.equal('name' in payload.instance, false); assert.equal(payload.instance.credentialRef, ''); assert.equal(payload.instance.connectionUserId, '')
})

test('冲突读取后保留草稿，以新revision/requestId重试', async () => {
  let conflict = true
  const ui = page(endpoint => { if (endpoint.endsWith('/save') && conflict) { conflict = false; return { ok: false, error: { code: 'conflict', message: '登记已在其他位置更新' } } }; if (endpoint.endsWith('/list')) return { ok: true, value: { revision: conflict ? 'revision-1' : 'revision-2', workspaceId: 'workspace-test', agents: [agent], instances: [instance], observedAt: '2026-11-03T00:00:00Z' } } })
  await openRegistration(ui); ui.type('接入智能体名称', '冲突草稿'); await ui.button('保存草稿').props.onClick(); await ui.settle()
  await ui.button('保留草稿并读取最新版本').props.onClick(); await ui.settle(); assert.equal(ui.field('接入智能体名称').props.value, '冲突草稿')
  await ui.button('保存草稿').props.onClick(); await ui.settle()
  const saves = ui.calls.filter(call => call.endpoint.endsWith('/save')); assert.equal(saves[1].payload.revision, 'revision-2'); assert.notEqual(saves[0].payload.requestId, saves[1].payload.requestId)
})

test('保存后验证失败，重试只传持久agent ID不重写公共身份', async () => {
  const ui = page((endpoint, payload) => { if (endpoint.endsWith('/save')) return { ok: true, value: { ...detail, agent: { id: 'saved-agent', name: '已保存助手', system: 'original.example', owner: '原责任组' }, instance: { ...instance, ...payload.instance, id: 'saved-instance', agentId: 'saved-agent' } } }; if (endpoint.endsWith('/verify')) return { ok: false, error: { message: '连接验证失败' } } })
  await openRegistration(ui, 'opencode'); ui.type('接入服务地址', 'http://original.example'); await ui.button('验证并接入').props.onClick(); await ui.settle()
  assert.equal(ui.field('接入智能体名称').props.readOnly, true); ui.type('接入服务地址', 'http://replacement.example')
  await ui.button('验证并接入').props.onClick(); await ui.settle()
  const payload = ui.calls.filter(call => call.endpoint.endsWith('/save')).at(-1).payload
  assert.deepEqual(Object.keys(payload.agent), ['id']); assert.equal(payload.agent.id, 'saved-agent'); assert.equal(payload.instance.id, 'saved-instance')
})

test('旧详情晚响应不切对象，secret仅创建交付一次', async () => {
  const old = deferred(), second = { ...instance, id: 'second-instance', name: '第二个实例' }
  const ui = page((endpoint, payload) => { if (endpoint.endsWith('/detail') && payload.id === instance.id) return old.promise; if (endpoint.endsWith('agentAccess/createCredential')) return { ok: true, value: { credential: { id: 'credential-1', clientId: 'client-1', instanceId: second.id, expiresAt: '2026-12-01T00:00:00Z' }, secret: 'only-create-secret' } } }, [instance, second])
  await ui.settle(); const buttons = ui.nodes().filter(node => node.type === 'button' && ui.text(node) === '查看接入详情')
  buttons[0].props.onClick(); ui.render(); buttons[1].props.onClick(); ui.render(); await ui.settle(); old.resolve({ ok: true, value: detail }); await ui.settle()
  assert.equal(ui.text(ui.nodes().find(node => node.type === 'h2')), second.name)
  tab(ui, '接入与能力'); assert.equal(ui.field('仅本次交付的实例secret'), undefined)
  await ui.button('创建实例凭据').props.onClick(); await ui.settle(); assert.equal(ui.field('仅本次交付的实例secret').props.value, 'only-create-secret')
  ui.button('已交付，关闭秘密').props.onClick(); ui.render(); assert.equal(ui.field('仅本次交付的实例secret'), undefined); assert.doesNotMatch(ui.text(), /only-create-secret/)
})

test('首次发送自动建会话并轮询，本次结果只显示assistant', async () => {
  const ui = page(); await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render()
  assert.equal(ui.field('接入访问会话标识'), undefined)
  for (const name of ['创建会话', '核对会话结果', '发送请求']) assert.equal(ui.button(name), undefined)
  ui.type('接入实例访问输入', '用户任务不得作为答复'); await ui.button('发送').props.onClick(); await ui.settle()
  assert.match(ui.text(), /本次处理完成/); assert.match(ui.text(), /本次真实结果/); assert.equal(ui.field('接入实例访问输入').props.value, '')
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/conversation/send')).length, 1)
  const sent = ui.calls.find(call => call.endpoint.endsWith('/conversation/send')), read = ui.calls.find(call => call.endpoint.endsWith('/conversation/status'))
  assert.equal(sent.payload.sessionId, undefined); assert.equal(read.payload.requestId, sent.payload.requestId); assert.equal(ui.calls.some(call => call.endpoint.endsWith('/invoke')), false)
})

test('发送丢响应自动只读恢复，不重发且不混入user文本', async () => {
  let req
  const ui = page((endpoint, payload) => { if (endpoint.endsWith('/conversation/send')) { req = payload.requestId; throw new Error('connection lost') }; if (endpoint.endsWith('/conversation/status')) return { ok: true, value: { ...conversationResult(payload, 'completed'), messages: [{ id: 'u1', role: 'user', text: '不得渲染为答复' }, { id: 'a1', role: 'assistant', text: '真实assistant答复' }] } } })
  await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render(); ui.type('接入实例访问输入', '任务'); await ui.button('发送').props.onClick(); await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/conversation/send')).length, 1); assert.equal(ui.calls.find(call => call.endpoint.endsWith('/conversation/status')).payload.requestId, req)
  const result = ui.field('本次智能体结果'); assert.match(ui.text(result), /真实assistant答复/); assert.doesNotMatch(ui.text(result), /不得渲染为答复/)
})

test('读取失败暂停保输入，关闭停poll重开只读同请求', async () => {
  let failed = true
  const ui = page((endpoint, payload) => endpoint.endsWith('/conversation/status') ? failed ? Promise.reject(new Error('offline')) : { ok: true, value: conversationResult(payload, 'completed', '恢复结果') } : undefined)
  await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render(); ui.type('接入实例访问输入', '保留任务'); await ui.button('发送').props.onClick(); await ui.settle()
  assert.ok(ui.button('继续读取结果')); assert.equal(ui.button('发送'), undefined); assert.equal(ui.field('接入实例访问输入').props.value, '保留任务')
  ui.button('关闭并保留会话').props.onClick(); ui.render(); const reads = ui.calls.filter(call => call.endpoint.endsWith('/conversation/status')).length
  await ui.tick(); assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/conversation/status')).length, reads)
  failed = false; ui.button('访问此实例').props.onClick(); ui.render(); await ui.settle(); assert.match(ui.text(), /恢复结果/); assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/conversation/send')).length, 1)
})

test('切对象各自保留输入与会话，迟到发送不串到另一实例', async () => {
  const pending = deferred(), second = { ...instance, id: 'second-instance', name: '第二个实例' }
  const ui = page(endpoint => endpoint.endsWith('/conversation/send') ? pending.promise : undefined, [instance, second])
  await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render(); ui.type('接入实例访问输入', '甲任务'); const sending = ui.button('发送').props.onClick(); ui.render()
  ui.button('关闭并保留会话').props.onClick(); ui.render(); await openDetail(ui, 1); ui.button('访问此实例').props.onClick(); ui.render(); ui.type('接入实例访问输入', '乙草稿')
  const sent = ui.calls.find(call => call.endpoint.endsWith('/conversation/send')); pending.resolve({ ok: true, value: conversationResult(sent.payload, 'completed', '甲结果') }); await sending; await ui.settle()
  assert.equal(ui.field('接入实例访问输入').props.value, '乙草稿'); assert.equal(ui.field('本次智能体结果'), undefined)
  ui.button('关闭并保留会话').props.onClick(); ui.render(); await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render(); assert.match(ui.text(ui.field('本次智能体结果')), /甲结果/)
  ui.button('关闭并保留会话').props.onClick(); ui.render(); await openDetail(ui, 1); ui.button('访问此实例').props.onClick(); ui.render(); assert.equal(ui.field('接入实例访问输入').props.value, '乙草稿')
})

test('连续任务沿用自动返回会话并使用不同requestId', async () => {
  const ui = page(); await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render()
  ui.type('接入实例访问输入', '第一轮'); await ui.button('发送').props.onClick(); await ui.settle(); ui.type('接入实例访问输入', '第二轮'); await ui.button('发送').props.onClick(); await ui.settle()
  const sends = ui.calls.filter(call => call.endpoint.endsWith('/conversation/send'))
  assert.equal(sends.length, 2); assert.equal(sends[1].payload.sessionId, 'native-session'); assert.notEqual(sends[0].payload.requestId, sends[1].payload.requestId)
})

test('关闭重开已发现草稿保留目标名称和观测时间，改连接后清旧目标', async () => {
  const ui = page(); await openRegistration(ui, 'dsh'); ui.type('接入服务地址', 'http://dsh.example'); await findTarget(ui)
  ui.button('关闭并保留草稿').props.onClick(); ui.render(); ui.button('登记已有智能体').props.onClick(); ui.render()
  assert.equal(ui.field('接入工作区选择').props.value, 'workspace-one'); assert.equal(ui.field('接入智能体选择').props.value, 'standard')
  assert.match(ui.text(ui.field('接入工作区选择')), /默认工作区/); assert.match(ui.text(ui.field('接入智能体选择')), /标准助手/); assert.match(ui.text(), /查询时间/)
  ui.type('接入服务地址', 'http://another.example'); assert.equal(ui.field('接入工作区选择'), undefined)
  await ui.button('验证并接入').props.onClick(); ui.render(); assert.equal(ui.focused, '发现远端智能体')
})

test('关闭中的发现晚响应不能修改保留草稿，重开不自动发现', async () => {
  const pending = deferred(), ui = page(endpoint => endpoint.endsWith('/discover') ? pending.promise : undefined)
  await openRegistration(ui); ui.type('接入服务地址', 'http://as.example'); const discovering = ui.button('查找智能体').props.onClick(); ui.render()
  ui.button('关闭并保留草稿').props.onClick(); ui.render(); ui.button('登记已有智能体').props.onClick(); ui.render()
  pending.resolve({ ok: true, value: { framework: 'agentscope', endpoint: 'http://as.example', status: 'selected', selector: 'stale-agent', agents: { status: 'ready', items: [{ id: 'stale-agent', name: '过时目标' }] } } }); await discovering; await ui.settle()
  assert.equal(ui.field('接入智能体选择'), undefined); assert.equal(ui.field('接入智能体名称').props.value, '')
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/discover')).length, 1)
})

test('处理中轮询只读下一状态，主动继续读取也不重新发送', async () => {
  let reads = 0
  const ui = page((endpoint, payload) => endpoint.endsWith('/conversation/status') ? ++reads === 1 ? { ok: true, value: conversationResult(payload, 'running') } : reads === 2 ? Promise.reject(new Error('offline')) : { ok: true, value: conversationResult(payload, 'completed', '最终结果') } : undefined)
  await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render(); ui.type('接入实例访问输入', '任务'); await ui.button('发送').props.onClick(); await ui.settle()
  assert.match(ui.text(), /正在处理/); assert.equal(ui.button('发送'), undefined); await ui.tick(); assert.ok(ui.button('继续读取结果'))
  ui.button('继续读取结果').props.onClick(); ui.render(); await ui.settle(); assert.match(ui.text(), /最终结果/)
  assert.equal(ui.calls.filter(call => call.endpoint.endsWith('/conversation/send')).length, 1)
  const ids = ui.calls.filter(call => call.endpoint.endsWith('/conversation/status')).map(call => call.payload.requestId); assert.equal(new Set(ids).size, 1)
})

test('自定义显示名称不被发现或切目标覆盖，自动名不留在下一框架草稿', async () => {
  const ui = page(); await openRegistration(ui); ui.type('接入服务地址', 'http://as.example'); ui.type('接入智能体名称', '我定义的名称'); await findTarget(ui)
  ui.type('接入智能体选择', 'native-agent'); assert.equal(ui.field('接入智能体名称').props.value, '我定义的名称')
  ui.type('接入智能体名称', ''); assert.equal(ui.field('接入智能体名称').props.placeholder, '远端助手')
  ui.type('接入实例框架', 'opencode'); assert.equal(ui.field('接入智能体名称').props.value, ''); assert.notEqual(ui.field('接入智能体名称').props.placeholder, '远端助手')
})

test('具名开放操作保留现有未知字段，勾选修改不默认补授权', async () => {
  const ui = page(endpoint => endpoint.endsWith('/detail') ? { ok: true, value: { ...detail, policy: { ...detail.policy, actions: ['agent:access', 'session:read', 'web:access'] } } } : undefined)
  await openDetail(ui); tab(ui, '访问授权'); ui.button('编辑入口授权').props.onClick(); ui.render()
  assert.equal(ui.field('接入开放操作'), undefined)
  assert.equal(ui.field('入口操作-发送消息').props.checked, false)
  ui.field('入口操作-访问实例').props.onChange({ target: { checked: false } }); ui.render(); await ui.button('保存修改').props.onClick(); ui.render(); assert.equal(ui.focused, '入口操作-访问实例')
  ui.field('入口操作-访问实例').props.onChange({ target: { checked: true } }); ui.render()
  ui.field('入口操作-发送消息').props.onChange({ target: { checked: true } }); ui.render(); await ui.button('保存修改').props.onClick(); await ui.settle()
  const payload = ui.calls.find(call => call.endpoint.endsWith('/save')).payload
  assert.deepEqual(Array.from(payload.policy.actions).sort(), ['agent:access', 'session:prompt', 'session:read', 'web:access']); assert.equal(payload.policy.actions.includes('session:create'), false)
})

test('刷新在途发送恢复原request/session引用，只读状态而不重放', async () => {
  const storage = new Map(), pending = deferred(), first = page(endpoint => endpoint.endsWith('/conversation/send') ? pending.promise : undefined, [instance], { storage })
  await openDetail(first); first.button('访问此实例').props.onClick(); first.render(); first.type('接入实例访问输入', '刷新前任务'); first.button('发送').props.onClick(); first.render()
  const requestId = first.calls.find(call => call.endpoint.endsWith('/conversation/send')).payload.requestId
  assert.match([...storage.values()].join(''), new RegExp(requestId)); first.dispose()
  const restored = page(undefined, [instance], { storage }); await restored.settle()
  assert.match(restored.text(), /本次真实结果/)
  assert.equal(restored.calls.some(call => call.endpoint.endsWith('/conversation/send')), false)
  assert.equal(restored.calls.find(call => call.endpoint.endsWith('/conversation/status')).payload.requestId, requestId)
  assert.doesNotMatch([...storage.values()].join(''), /本次真实结果/)
})

test('已完成后输入下一条草稿，刷新只读恢复即使先断网也不清新草稿', async () => {
  const storage = new Map(), first = page(undefined, [instance], { storage })
  await openDetail(first); first.button('访问此实例').props.onClick(); first.render(); first.type('接入实例访问输入', '上一轮'); await first.button('发送').props.onClick(); await first.settle()
  first.type('接入实例访问输入', '下一条尚未发送'); first.dispose()
  let failed = true
  const restored = page((endpoint, payload) => endpoint.endsWith('/conversation/status') ? failed ? Promise.reject(new Error('offline')) : { ok: true, value: conversationResult(payload, 'completed', '上一轮结果') } : undefined, [instance], { storage })
  await restored.settle(); assert.equal(restored.field('接入实例访问输入').props.value, '下一条尚未发送')
  failed = false; restored.button('继续读取结果').props.onClick(); restored.render(); await restored.settle()
  assert.equal(restored.field('接入实例访问输入').props.value, '下一条尚未发送'); assert.match(restored.text(), /上一轮结果/)
  assert.equal(restored.calls.some(call => call.endpoint.endsWith('/conversation/send')), false)
})

test('刷新验证阶段恢复真实阶段ID和锁定表单，查结果不重新保存启用', async () => {
  const storage = new Map(), pending = deferred(), first = page(endpoint => endpoint.endsWith('/verify') ? pending.promise : undefined, [instance], { storage })
  await openRegistration(first, 'opencode'); first.type('接入服务地址', 'http://code.example'); first.button('验证并接入').props.onClick(); await first.settle()
  const requestId = first.calls.find(call => call.endpoint.endsWith('/verify')).payload.requestId; first.dispose()
  const restored = page(endpoint => endpoint.endsWith('/request') ? { ok: true, value: { found: true, detail } } : undefined, [instance], { storage }); await restored.settle()
  assert.ok(restored.button('核对保存结果')); assert.equal(restored.nodes().find(node => node.type === 'fieldset').props.disabled, true)
  await restored.button('核对保存结果').props.onClick(); await restored.settle()
  assert.equal(restored.calls.find(call => call.endpoint.endsWith('/request')).payload.requestId, requestId)
  assert.equal(restored.calls.some(call => /\/(save|verify|enable)$/.test(call.endpoint)), false)
})

test('登记刷新保留发现名称与草稿，账号和工作区分别隔离', async () => {
  const storage = new Map(), first = page(undefined, [instance], { storage })
  await openRegistration(first, 'dsh'); first.type('接入服务地址', 'http://dsh.example'); await findTarget(first); first.type('接入智能体名称', '自己的草稿')
  first.button('关闭并保留草稿').props.onClick(); first.render(); first.dispose()
  const restored = page(undefined, [instance], { storage }); await openRegistration(restored)
  assert.equal(restored.field('接入智能体名称').props.value, '自己的草稿'); assert.equal(restored.field('接入智能体选择').props.value, 'standard')
  assert.match(restored.text(restored.field('接入智能体选择')), /标准助手/); restored.dispose()
  for (const scope of [{ username: 'another-owner' }, { workspaceId: 'another-workspace' }]) {
    const isolated = page(undefined, [instance], { storage, ...scope }); await openRegistration(isolated)
    assert.equal(isolated.field('接入服务地址').props.value, ''); assert.equal(isolated.field('接入智能体名称').props.value, ''); isolated.dispose()
  }
})

test('无法读取身份时不开放操作，存储禁用明确本页保留边界', async () => {
  const waiting = deferred(), pending = page(endpoint => endpoint === 'auth/current' ? waiting.promise : undefined)
  await pending.settle(); assert.equal(pending.button('登记已有智能体'), undefined); pending.dispose()
  const unavailable = page(undefined, [instance], { storage: { get() { throw new Error('disabled') }, set() { throw new Error('disabled') } } })
  await openRegistration(unavailable); assert.match(unavailable.text(), /刷新后无法恢复/)
  unavailable.type('接入智能体名称', '当前页草稿'); unavailable.button('关闭并保留草稿').props.onClick(); unavailable.render(); unavailable.button('登记已有智能体').props.onClick(); unavailable.render()
  assert.equal(unavailable.field('接入智能体名称').props.value, '当前页草稿')
})

test('实例名空值必填定位；消息过长在投递前拒绝，可编辑重试', async () => {
  const ui = page(); await openDetail(ui); ui.button('编辑实例名称').props.onClick(); ui.render(); assert.equal(ui.field('接入实例名称').props.required, true)
  ui.type('接入实例名称', ''); await ui.button('保存修改').props.onClick(); ui.render(); assert.equal(ui.focused, '接入实例名称'); assert.equal(ui.calls.some(call => call.endpoint.endsWith('/save')), false)
  ui.button('关闭并保留草稿').props.onClick(); ui.render(); ui.button('访问此实例').props.onClick(); ui.render(); assert.equal(ui.field('接入实例访问输入').props.maxLength, 32000)
  ui.type('接入实例访问输入', 'a'.repeat(32001)); await ui.button('发送').props.onClick(); ui.render(); assert.match(ui.text(), /不能超过 32000/)
  assert.equal(ui.calls.some(call => call.endpoint.endsWith('/conversation/send')), false); assert.equal(ui.field('接入实例访问输入').props.disabled, false)
  ui.type('接入实例访问输入', '缩短后任务'); await ui.button('发送').props.onClick(); await ui.settle(); assert.match(ui.text(), /本次处理完成/)
})

test('后端明确未派发失败保留输入及已创建会话，可修正后新请求', async () => {
  let first = true
  const ui = page((endpoint, payload) => { if (endpoint.endsWith('/conversation/send') && first) { first = false; return { ok: true, value: { ...conversationResult(payload, 'failed'), note: '原系统明确拒绝，未派发' } } } })
  await openDetail(ui); ui.button('访问此实例').props.onClick(); ui.render(); ui.type('接入实例访问输入', '被拒任务'); await ui.button('发送').props.onClick(); await ui.settle()
  assert.match(ui.text(), /本次处理未完成/); assert.equal(ui.field('接入实例访问输入').props.disabled, false); assert.equal(ui.field('接入实例访问输入').props.value, '被拒任务')
  ui.type('接入实例访问输入', '已修正任务'); await ui.button('发送').props.onClick(); await ui.settle()
  const sends = ui.calls.filter(call => call.endpoint.endsWith('/conversation/send')); assert.equal(sends.length, 2); assert.equal(sends[1].payload.sessionId, 'native-session'); assert.notEqual(sends[0].payload.requestId, sends[1].payload.requestId)
})

test('明确未派发failed刷新仍可修改重试，不查不存在的账本锁住草稿', async () => {
  const storage = new Map(), first = page((endpoint, payload) => endpoint.endsWith('/conversation/send') ? { ok: true, value: { ...conversationResult(payload, 'failed'), sessionId: undefined, note: '输入无效，未派发' } } : undefined, [instance], { storage })
  await openDetail(first); first.button('访问此实例').props.onClick(); first.render(); first.type('接入实例访问输入', '需修正任务'); await first.button('发送').props.onClick(); await first.settle(); first.dispose()
  const restored = page(undefined, [instance], { storage }); await restored.settle()
  assert.equal(restored.field('接入实例访问输入').props.disabled, false); assert.equal(restored.field('接入实例访问输入').props.value, '需修正任务'); assert.ok(restored.button('发送'))
  assert.equal(restored.calls.some(call => call.endpoint.endsWith('/conversation/status')), false)
})

test('关闭的未发送登记草稿不会被其他停用操作标成保存待核对', async () => {
  const storage = new Map(), pending = deferred(), first = page(endpoint => endpoint.endsWith('/disable') ? pending.promise : undefined, [instance], { storage })
  await openRegistration(first); first.type('接入智能体名称', '尚未投递草稿'); first.button('关闭并保留草稿').props.onClick(); first.render()
  await openDetail(first); first.button('停用入口').props.onClick(); first.render(); first.button('确认停用入口').props.onClick(); first.render(); await first.settle(); first.dispose()
  const restored = page(undefined, [instance], { storage }); await openRegistration(restored)
  assert.equal(restored.field('接入智能体名称').props.value, '尚未投递草稿'); assert.ok(restored.button('保存草稿')); assert.equal(restored.button('核对保存结果'), undefined)
  assert.equal(restored.calls.some(call => call.endpoint.endsWith('/request')), false)
})
