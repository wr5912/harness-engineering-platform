import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/instances/client.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })).outputFiles[0].text

const defaultModel = { provider: 'provider-a', model: 'base-model' }
const alternateModel = { provider: 'provider-a', model: 'variant-model' }
const previewHash = 'a'.repeat(64)
const modelList = { catalog: { groups: [{ id: 'provider-a', name: '模型服务 A', models: [{ id: 'base-model', name: '基础模型' }, { id: 'variant-model', name: '变体模型' }] }, { id: 'provider-b', name: '模型服务 B', models: [{ id: 'other-model', name: '其他模型' }] }] }, business_allowed: [defaultModel, alternateModel, { provider: 'provider-b', model: 'other-model' }], business_default: defaultModel }

function page({ instances = [{ name: 'basic-instance', agent_id: 'basic-agent', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084, model_policy: { default: defaultModel } }], respond, target } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], copied = [], navigations = []
  let cursor = 0, effects = [], changed = false, tree, listener
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useMemo(factory, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; states[at] = factory() } return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, URL, require: name => name === 'react' ? react : require(name), window: { location: { hostname: '127.0.0.1' } }, navigator: { clipboard: { async writeText(value) { copied.push(value) } } } })
  const props = {
    target,
    onNavigate(target) { navigations.push(target) },
    updates: { subscribe(fn) { listener = fn; return () => { listener = undefined } }, getSnapshot: () => ({ domains: ['instances'] }) },
    rpc: { async call(_channel, endpoint, payload) {
      calls.push({ endpoint, payload })
      const result = await respond?.(endpoint, payload)
      if (result !== undefined) return result
      if (endpoint === 'instances/list') return { ok: true, value: { instances } }
      if (endpoint === 'instances/sources') return { ok: true, value: { sources: [
        { source_id: 'experiment:EXP-basic-001', experiment_id: 'EXP-basic-001', agent_id: 'basic-agent', selectable: true, reason: '已登记' },
        { source_id: 'experiment:EXP-other-002', experiment_id: 'EXP-other-002', agent_id: 'other-agent', selectable: true, reason: '已登记' },
      ] } }
      if (endpoint === 'agents/list') return { ok: true, value: { agents: [{ id: 'basic-agent', name: '基础助手' }, { id: 'other-agent', name: '其他助手' }, { id: 'empty-agent', name: '无版本助手' }] } }
      if (endpoint === 'agents/runs/index') return { ok: true, value: { experiments: payload.agent_id === 'basic-agent' ? [{ experiment_id: 'EXP-basic-001', runs: [{ run_id: 'run-00000000-0000-4000-8000-000000000001', status: 'completed', created_at: '2026-10-21T01:00:00.000Z', title: '基础能力验证', case_scope: '3 项已选用例', case_counts: { total: 3, passed: 1, failed: 1, inconclusive: 1, mixed: 0, pending: 0 }, effective_verdict: 'failed' }] }] : [{ experiment_id: 'EXP-other-002', runs: [] }] } }
      if (endpoint === 'models/list') return { ok: true, value: modelList }
      if (endpoint === 'instances/detail') return { ok: true, value: { instance: instances.find(item => item.name === payload.name), runs: [{ id: `run-${payload.name}`, path: `runs/run-${payload.name}` }], session_scope: { home_volume: `${payload.name}-home`, preserved: true, note: '会话保存在独立 HOME 中。' } } }
      if (endpoint === 'instances/logs') return { ok: true, value: { logs: `${payload.name}: runtime ready` } }
      if (endpoint === 'instances/url') return { ok: true, value: { url: `http://127.0.0.1:${instances.find(item => item.name === payload.name).port}/assistant/`, lan_access: false } }
      if (endpoint === 'instances/preview') return { ok: true, value: { operation: payload.operation, name: payload.name, plan: { source_id: 'experiment:EXP-basic-001', port: payload.port ?? instances.find(item => item.name === payload.name)?.port ?? 3199 }, ...(['create', 'start', 'restart'].includes(payload.operation) ? { model_selection: payload.model_selection ?? instances.find(item => item.name === payload.name)?.model_policy?.default ?? defaultModel, model_policy_hash: previewHash } : {}), ...(payload.operation === 'stop' ? { observed_state: instances.find(item => item.name === payload.name)?.state ?? 'running', observed_at: '2026-10-21T01:00:00.000Z' } : {}) } }
      if (endpoint === 'instances/run') return { ok: true, value: { ...payload, ok: true } }
      throw new Error('unexpected operation')
    } },
  }
  function render() { let count = 0; do { if (++count > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.InstancesPage(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 5; index++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object' || value.props?.hidden) return []; if (typeof value.type === 'function') return nodes(value.type(value.props)); return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(text).join(''); return value && typeof value === 'object' ? value.props?.hidden ? '' : text(value.props?.children) : String(value ?? '') }
  const button = name => nodes().find(node => node.type === 'button' && text(node) === name && !node.props.disabled)
  const buttons = name => nodes().filter(node => node.type === 'button' && text(node) === name)
  const tab = name => nodes().find(node => node.props?.role === 'tab' && text(node) === name)
  render()
  return { render, settle, text, nodes, button, buttons, tab, calls, copied, navigations, setTarget(next) { props.target = next; render() }, invalidate() { listener() } }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function openCreate(ui) {
  ui.button('新建实例').props.onClick({ currentTarget: { focus() {} } })
}

function chooseAgent(ui, value) {
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '来源智能体')
    .props.onChange({ target: { value } })
  ui.render()
}

test('实例首次读取失败不误报空列表，重试成功后才显示真实空态', async () => {
  let failed = true
  const ui = page({ instances: [], respond(endpoint) {
    if (endpoint === 'instances/list' && failed) return { ok: false, error: { message: '暂时无法连接' } }
  } })
  await ui.settle()
  assert.match(ui.text(), /当前无法确认是否有实例/)
  assert.doesNotMatch(ui.text(), /暂无实例。点击右上角/)
  failed = false
  ui.button('重新读取').props.onClick()
  await ui.settle()
  assert.match(ui.text(), /暂无实例。点击右上角/)
})

test('非空实例列表保留原型的搜索、状态筛选与表格层级，智能体 ID 可定位实例', async () => {
  const ui = page({ instances: [{ name: 'basic-instance', agent_id: 'basic-agent', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084 }] })
  await ui.settle()
  const filter = ui.nodes().find(node => node.props?.className === 'instance-filter-row')
  const labels = ui.nodes(filter).filter(node => node.type === 'label')
  assert.deepEqual(labels.map(node => ui.text(node).slice(0, 2)), ['搜索', '状态'])
  assert.ok(ui.nodes().some(node => node.type === 'table' && node.props.className === 'instance-table'))
  assert.match(ui.text(), /1 个业务实例.*basic-instance.*共 1 条记录/)
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '搜索实例').props.onChange({ target: { value: 'basic-agent' } })
  ui.render()
  assert.match(ui.text(), /basic-instance/)
})

test('实例列表实时刷新保留待确认预览，确认后仅执行原目标一次', async () => {
  const ui = page()
  await ui.settle()
  await ui.button('重启').props.onClick(); await ui.settle()
  assert.ok(ui.button('确认重启 1 项'))
  const reads = ui.calls.filter(call => call.endpoint === 'instances/list').length
  ui.invalidate(); await ui.settle()
  assert.ok(ui.calls.filter(call => call.endpoint === 'instances/list').length > reads)
  assert.ok(ui.button('确认重启 1 项'), '实时列表更新不能无提示清空用户当前预览')
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
  await ui.button('确认重启 1 项').props.onClick(); await ui.settle()
  const writes = ui.calls.filter(call => call.endpoint === 'instances/run')
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ endpoint: 'instances/run', payload: { operation: 'restart', name: 'basic-instance', model_selection: defaultModel, expected_model_policy_hash: previewHash, expected_source_id: 'experiment:EXP-basic-001', port: 3084 } }])
  assert.match(ui.text(), /成功 1 项/)
})

test('实时刷新后的显式取消仍关闭预览，不执行实例操作', async () => {
  const ui = page()
  await ui.settle()
  await ui.button('重启').props.onClick(); await ui.settle()
  ui.invalidate(); await ui.settle()
  ui.button('取消').props.onClick(); ui.render()
  assert.equal(ui.button('确认重启 1 项'), undefined)
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
})

test('创建弹窗填写后只请求预览，返回修改与关闭均不创建实例', async () => {
  const ui = page()
  const input = label => ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === label)
  const select = label => ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)
  await ui.settle()
  assert.equal(input('实例名'), undefined)
  assert.equal(ui.button('新建实例').props['aria-expanded'], false)
  openCreate(ui); await ui.settle()
  assert.ok(ui.nodes().some(node => node.type === 'dialog' && node.props.id === 'instance-create'))
  assert.match(ui.text(), /创建业务实例.*通过可读名称选择来源/)
  assert.equal(ui.buttons('查看创建预览')[0].props.disabled, true)
  for (const [label, value] of [['实例名', 'new-instance'], ['端口', '3088']]) {
    input(label).props.onChange({ target: { value } }); ui.render()
  }
  chooseAgent(ui, '基础助手 · basic-agent')
  select('选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  assert.match(ui.text(), /现有业务实例不会因创建操作而停止或切换版本/)
  await ui.button('查看创建预览').props.onClick(); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.endpoint === 'instances/preview').payload)), { operation: 'create', name: 'new-instance', source: 'experiment:EXP-basic-001', port: 3088, model_selection: defaultModel })
  assert.match(ui.text(), /确认创建业务实例.*来源版本.*EXP-basic-001.*验证范围.*3 项已选用例.*最近 Run：最近评测未通过.*新增独立业务访问入口 127\.0\.0\.1:3088/)
  assert.match(ui.text(), /现有 1 个运行中业务实例保持当前状态.*创建不代表业务验证通过/)
  assert.ok(ui.button('确认创建'))
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
  ui.button('返回修改').props.onClick(); ui.render()
  assert.equal(ui.button('确认创建'), undefined)
  assert.equal(input('实例名').props.value, 'new-instance')
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
  ui.nodes().find(node => node.type === 'button' && node.props['aria-label'] === '关闭创建实例').props.onClick(); ui.render()
  assert.equal(input('实例名'), undefined)
})

test('单实例停止预览展示业务中断与数据保留影响，保持运行不派发', async () => {
  const ui = page({ respond(endpoint, payload) {
    if (endpoint === 'instances/preview' && payload.operation === 'stop') return { ok: true, value: {
      operation: 'stop', name: payload.name, source_id: 'experiment:EXP-basic-001', port: 3084, observed_state: 'running', observed_at: '2026-10-21T01:00:00.000Z',
      retention: { registration: '保留登记', home: '保留数据', runs: '保留运行记录' },
    } }
  } })
  await ui.settle()
  await ui.button('停止').props.onClick(); await ui.settle()
  assert.match(ui.text(), /停止业务实例？.*basic-instance.*本次预览状态.*运行中.*观察于/)
  assert.match(ui.text(), /业务访问将中断.*进行中的业务请求可能终止/)
  assert.match(ui.text(), /实例配置：保留登记；HOME 数据：保留数据.*已有运行记录：保留运行记录/)
  assert.match(ui.text(), /独立评测任务不在本次停止范围内/)
  assert.ok(ui.button('确认停止'))
  ui.button('保持运行').props.onClick(); ui.render()
  assert.equal(ui.button('确认停止'), undefined)
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
})

test('来源深链预选精确版本，刷新目录不改写用户后来选择的版本', async () => {
  const ui = page({ target: { page: 'instances', source_id: 'experiment:EXP-other-002', agent_id: 'other-agent' } })
  const select = label => ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)
  await ui.settle()
  assert.equal(select('选择来源版本').props.value, 'experiment:EXP-other-002')
  assert.match(ui.text(), /此版本尚无评测记录.*EXP-other-002/)
  chooseAgent(ui, '基础助手 · basic-agent')
  select('选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  ui.nodes().find(node => node.type === 'button' && node.props['aria-label'] === '关闭创建实例').props.onClick(); ui.render()
  openCreate(ui); await ui.settle()
  assert.match(ui.text(), /最近评测未通过.*EXP-basic-001.*3 项已选用例/)
  assert.equal(select('选择来源版本').props.value, 'experiment:EXP-basic-001')
})

test('来源评测读取失败保留准确来源并允许重新核对', async () => {
  let failed = true
  const ui = page({ target: { page: 'instances', source_id: 'experiment:EXP-basic-001', agent_id: 'basic-agent' }, respond(endpoint) {
    if (endpoint === 'agents/runs/index' && failed) return { ok: false, error: { message: '评测索引暂不可用' } }
  } })
  await ui.settle()
  assert.match(ui.text(), /最近评测读取失败.*EXP-basic-001.*读取原因：评测索引暂不可用/)
  assert.doesNotMatch(ui.text(), /此版本尚无评测记录/)
  failed = false
  ui.button('重新核对评测').props.onClick()
  await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint === 'agents/runs/index').length, 2)
  assert.match(ui.text(), /最近评测未通过.*EXP-basic-001.*3 项已选用例/)
  assert.doesNotMatch(ui.text(), /读取原因：评测索引暂不可用/)
})

test('来源 Run 执行失败或取消时区分业务结论，创建预览冻结记录与核对时间', async () => {
  for (const [status, label] of [['failed', '最近评测执行失败'], ['cancelled', '最近评测已取消']]) {
    const ui = page({ target: { page: 'instances', source_id: 'experiment:EXP-basic-001', agent_id: 'basic-agent' }, respond(endpoint) {
      if (endpoint === 'agents/runs/index') return { ok: true, value: { experiments: [{ experiment_id: 'EXP-basic-001', runs: [{
        run_id: `run-${status}`, status, created_at: '2026-10-20T10:00:00Z', title: '当前来源评测',
        case_scope: '1 项已选用例', case_counts: { total: 1, passed: 1, failed: 0, inconclusive: 0, mixed: 0, pending: 0 }, effective_verdict: null,
      }] }] } }
    } })
    await ui.settle()
    assert.match(ui.text(), new RegExp(`${label}.*EXP-basic-001.*当前来源评测.*Run 记录于.*核对于`))
    assert.doesNotMatch(ui.text(), /最近评测尚无最终结论|最近评测通过/)
    ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '实例名').props.onChange({ target: { value: `new-${status}` } })
    ui.render()
    await ui.button('查看创建预览').props.onClick(); await ui.settle()
    assert.match(ui.text(), new RegExp(`确认创建业务实例.*验证范围.*最近 Run：${label}.*记录于.*核对于`))
  }
})

test('已成功读取的来源评测可手动刷新，展示新的最近 Run', async () => {
  let title = '旧评测'
  const ui = page({ target: { page: 'instances', source_id: 'experiment:EXP-basic-001', agent_id: 'basic-agent' }, respond(endpoint) {
    if (endpoint === 'agents/runs/index') return { ok: true, value: { experiments: [{ experiment_id: 'EXP-basic-001', runs: [{
      run_id: `run-${title}`, status: 'completed', created_at: '2026-10-20T10:00:00Z', title,
      case_scope: '1 项已选用例', case_counts: { total: 1, passed: 1, failed: 0, inconclusive: 0, mixed: 0, pending: 0 }, effective_verdict: 'passed',
    }] }] } }
  } })
  await ui.settle()
  assert.match(ui.text(), /旧评测.*核对于/)
  title = '新评测'
  ui.button('重新核对评测').props.onClick(); await ui.settle()
  assert.match(ui.text(), /新评测.*核对于/)
  assert.doesNotMatch(ui.text(), /旧评测/)
  assert.equal(ui.calls.filter(call => call.endpoint === 'agents/runs/index').length, 2)
})

test('同页编辑保留选择；离开后再次从同一来源入口进入会恢复外部预选', async () => {
  const original = { page: 'instances', source_id: 'experiment:EXP-other-002', agent_id: 'other-agent' }
  const ui = page({ target: original })
  const select = label => ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)
  await ui.settle()
  chooseAgent(ui, '基础助手 · basic-agent')
  select('选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  ui.setTarget({ page: 'instances' })
  ui.setTarget(original)
  assert.equal(select('选择来源版本').props.value, 'experiment:EXP-basic-001', '当前实例页内返回来源链接不应覆盖手工编辑')
  ui.setTarget({ page: 'agents', agent_id: 'other-agent' })
  ui.setTarget(original)
  assert.equal(select('选择来源版本').props.value, 'experiment:EXP-other-002', '重新从智能体页进入时使用外部预选')
})

test('创建自动端口从预览冻结到执行请求，失效预览不能执行', async () => {
  const ui = page()
  const input = label => ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === label)
  const select = label => ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)
  await ui.settle()
  openCreate(ui); await ui.settle()
  input('实例名').props.onChange({ target: { value: 'new-auto' } }); ui.render()
  chooseAgent(ui, '基础助手 · basic-agent')
  select('选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  await ui.button('查看创建预览').props.onClick(); await ui.settle()
  assert.match(ui.text(), /访问端口.*3199/)
  await ui.button('确认创建').props.onClick(); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.endpoint === 'instances/run').payload)), {
    operation: 'create', name: 'new-auto', source: 'experiment:EXP-basic-001', model_selection: defaultModel, expected_model_policy_hash: previewHash, expected_source_id: 'experiment:EXP-basic-001', port: 3199,
  })

  const invalid = page({ respond(endpoint, payload) {
    if (endpoint === 'instances/preview') return { ok: true, value: { name: payload.name, operation: 'create', plan: { source_id: payload.source } } }
  } })
  await invalid.settle()
  openCreate(invalid); await invalid.settle()
  invalid.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '实例名').props.onChange({ target: { value: 'invalid-auto' } }); invalid.render()
  chooseAgent(invalid, '基础助手 · basic-agent')
  invalid.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await invalid.settle()
  await invalid.button('查看创建预览').props.onClick(); await invalid.settle()
  assert.match(invalid.text(), /预览缺少有效端口/)
  assert.equal(invalid.button('确认创建'), undefined)
  assert.equal(invalid.calls.some(call => call.endpoint === 'instances/run'), false)
})

test('创建回执到达后等待登记回读，并展示实际登记来源而非提交来源', async () => {
  const instances = [{ name: 'basic-instance', agent_id: 'basic-agent', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084 }]
  const readback = deferred()
  let holdReadback = false
  const ui = page({ instances, respond(endpoint, payload) {
    if (endpoint === 'instances/run') {
      instances.push({ name: payload.name, agent_id: 'basic-agent', state: 'running', source_id: payload.source, port: payload.port })
      return { ok: true, value: { name: payload.name, operation: payload.operation, ok: true, requested_source_id: payload.source } }
    }
    if (endpoint === 'instances/list' && holdReadback) return readback.promise
  } })
  await ui.settle()
  openCreate(ui); await ui.settle()
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '实例名').props.onChange({ target: { value: 'readback-instance' } }); ui.render()
  chooseAgent(ui, '基础助手 · basic-agent')
  ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  await ui.button('查看创建预览').props.onClick(); await ui.settle()
  holdReadback = true
  const execution = ui.button('确认创建').props.onClick()
  await ui.settle()
  assert.match(ui.text(), /操作回执：成功 1 项.*操作回执已收到，正在读取实例登记|操作回执已收到，正在读取实例登记.*操作回执：成功 1 项/)
  assert.match(ui.text(), /当前登记来源：正在核对/)
  assert.doesNotMatch(ui.text(), /正在读取操作预览|尚未观察到/)
  assert.equal(ui.buttons('关闭')[0].props.disabled, false, '执行回执已收到时可关闭弹窗并等待只读回查')
  assert.equal(ui.buttons('新建实例')[0].props.disabled, true, '回查未结束时不开始另一次创建')
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/run').length, 1)
  readback.resolve({ ok: true, value: { instances: instances.map(item => item.name === 'readback-instance' ? { ...item, source_id: 'experiment:EXP-other-002' } : item) } })
  await execution; await ui.settle()
  assert.match(ui.text(), /提交来源：experiment:EXP-basic-001；当前登记来源（核对于 .*）：experiment:EXP-other-002/)
  assert.match(ui.text(), /当前登记与本次操作预期不一致/)
  assert.ok(ui.button('重新读取实例登记'))
  assert.equal(ui.buttons('关闭')[0].props.disabled, false)
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/run').length, 1)
})

test('创建回执成功但登记读取失败时保持未知，手动重读只读取不重放创建', async () => {
  const instances = [{ name: 'basic-instance', agent_id: 'basic-agent', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084 }]
  let failReadback = true
  let created = false
  const ui = page({ instances, respond(endpoint, payload) {
    if (endpoint === 'instances/run') {
      created = true
      instances.push({ name: payload.name, agent_id: 'basic-agent', state: 'running', source_id: payload.source, port: payload.port })
      return { ok: true, value: { name: payload.name, operation: payload.operation, ok: true, requested_source_id: payload.source } }
    }
    if (endpoint === 'instances/list' && created && failReadback) return { ok: false, error: { message: '登记读取暂时失败' } }
  } })
  await ui.settle()
  openCreate(ui); await ui.settle()
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '实例名').props.onChange({ target: { value: 'retry-instance' } }); ui.render()
  chooseAgent(ui, '基础助手 · basic-agent')
  ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  await ui.button('查看创建预览').props.onClick(); await ui.settle()
  await ui.button('确认创建').props.onClick(); await ui.settle()
  assert.match(ui.text(), /操作回执：成功 1 项/)
  assert.match(ui.text(), /当前登记来源.*未知，登记读取未完成/)
  assert.match(ui.text(), /操作回执已成功，但当前实例登记未知/)
  assert.ok(ui.button('重新读取实例登记'))
  failReadback = false
  await ui.button('重新读取实例登记').props.onClick(); await ui.settle()
  assert.match(ui.text(), /当前登记来源（核对于 .*）：experiment:EXP-basic-001/)
  assert.doesNotMatch(ui.text(), /操作回执已成功，但当前实例登记未知/)
  assert.equal(ui.button('重新读取实例登记'), undefined)
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/run').length, 1)
})

test('执行回读被实时列表刷新覆盖时仍使用本次回读结果核对登记', async () => {
  const instances = [{ name: 'basic-instance', agent_id: 'basic-agent', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084 }]
  const delayedReadback = deferred()
  let submitted = false, held = false
  const ui = page({ instances, respond(endpoint, payload) {
    if (endpoint === 'instances/run') {
      submitted = true
      instances.push({ name: payload.name, agent_id: 'basic-agent', state: 'running', source_id: payload.source, port: payload.port })
      return { ok: true, value: { name: payload.name, operation: payload.operation, ok: true, requested_source_id: payload.source } }
    }
    if (endpoint === 'instances/list' && submitted && !held) { held = true; return delayedReadback.promise }
  } })
  await ui.settle()
  openCreate(ui); await ui.settle()
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '实例名').props.onChange({ target: { value: 'race-instance' } }); ui.render()
  chooseAgent(ui, '基础助手 · basic-agent')
  ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  await ui.button('查看创建预览').props.onClick(); await ui.settle()
  const execution = ui.button('确认创建').props.onClick()
  await ui.settle()
  assert.match(ui.text(), /当前登记来源：正在核对/)
  ui.invalidate(); await ui.settle()
  delayedReadback.resolve({ ok: true, value: { instances: instances.map(item => item.name === 'race-instance' ? { ...item, source_id: 'experiment:EXP-other-002' } : item) } })
  await execution; await ui.settle()
  assert.match(ui.text(), /当前登记来源（核对于 .*）：experiment:EXP-basic-001；登记状态：运行中/)
  assert.doesNotMatch(ui.text(), /当前登记来源（核对于 .*）：experiment:EXP-other-002/)
  assert.doesNotMatch(ui.text(), /当前实例登记未知/)
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/run').length, 1)
})

test('停止成功后回读登记状态、来源和时间，仍仅执行一次停止', async () => {
  const instances = [{ name: 'basic-instance', agent_id: 'basic-agent', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084 }]
  const ui = page({ instances, respond(endpoint, payload) {
    if (endpoint === 'instances/run') {
      instances[0] = { ...instances[0], state: 'absent' }
      return { ok: true, value: { name: payload.name, operation: payload.operation, ok: true } }
    }
  } })
  await ui.settle()
  await ui.button('停止').props.onClick(); await ui.settle()
  await ui.button('确认停止').props.onClick(); await ui.settle()
  assert.match(ui.text(), /当前登记状态（核对于 .*）：无容器；登记来源：experiment:EXP-basic-001/)
  assert.doesNotMatch(ui.text(), /当前登记与本次操作预期不一致/)
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/run').length, 1)
})

test('统一业务默认用于新实例预选，切换来源智能体仍共享可用范围', async () => {
  const ui = page()
  const select = label => ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)
  const input = label => ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === label)
  await ui.settle()
  const initialReads = ui.calls.filter(call => call.endpoint === 'models/list').length
  openCreate(ui); await ui.settle()
  assert.ok(ui.calls.filter(call => call.endpoint === 'models/list').length > initialReads, '打开表单时重新读取模型范围')
  chooseAgent(ui, '基础助手 · basic-agent')
  assert.equal(select('新实例默认模型').props.value, JSON.stringify(['provider-a', 'base-model']))
  chooseAgent(ui, '其他助手 · other-agent')
  input('实例名').props.onChange({ target: { value: 'other-instance' } }); ui.render()
  select('选择来源版本').props.onChange({ target: { value: 'experiment:EXP-other-002' } }); await ui.settle()
  assert.equal(select('新实例默认模型').props.value, JSON.stringify(['provider-a', 'base-model']))
  assert.equal(ui.buttons('查看创建预览')[0].props.disabled, false)
  assert.deepEqual(ui.nodes(select('新实例默认模型')).filter(node => node.type === 'option' && node.props.value).map(node => node.props.value),
    [JSON.stringify(['provider-a', 'base-model']), JSON.stringify(['provider-a', 'variant-model']), JSON.stringify(['provider-b', 'other-model'])])
  select('新实例默认模型').props.onChange({ target: { value: JSON.stringify(['provider-b', 'other-model']) } }); ui.render()
  await ui.button('查看创建预览').props.onClick(); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.endpoint === 'instances/preview').payload.model_selection)), { provider: 'provider-b', model: 'other-model' })
})

test('业务模型目录为空时创建入口说明原因且不派发预览', async () => {
  const ui = page({ respond(endpoint) {
    if (endpoint === 'models/list') return { ok: true, value: { ...modelList, business_allowed: [], business_default: null, migration_required: true } }
  } })
  await ui.settle()
  openCreate(ui); await ui.settle()
  chooseAgent(ui, '基础助手 · basic-agent')
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '实例名').props.onChange({ target: { value: 'new-instance' } }); ui.render()
  ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); ui.render()
  assert.match(ui.text(), /尚无可供业务实例使用的模型.*设置 → 模型/)
  assert.equal(ui.button('查看创建预览'), undefined)
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/preview'), false)
})

test('实例详情更改默认模型需预览重启或启动，回执冻结所选模型和配置摘要', async () => {
  const ui = page()
  await ui.settle()
  await ui.button('详情').props.onClick(); await ui.settle()
  assert.match(ui.text(), /登记默认模型.*模型服务 A · 基础模型/)
  const beforeReads = ui.calls.filter(call => call.endpoint === 'models/list').length
  ui.button('更改默认模型').props.onClick(); await ui.settle()
  assert.ok(ui.calls.filter(call => call.endpoint === 'models/list').length > beforeReads, '打开实例模型编辑时重新读取授权')
  assert.equal(ui.button('预览并重启'), undefined, '与当前登记相同时无需重启')
  const chooser = ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '实例默认模型')
  chooser.props.onChange({ target: { value: JSON.stringify(['provider-a', 'variant-model']) } }); ui.render()
  await ui.button('预览并重启').props.onClick(); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.endpoint === 'instances/preview').payload)), { operation: 'restart', name: 'basic-instance', model_selection: alternateModel })
  assert.match(ui.text(), /默认模型.*模型服务 A · 变体模型/)
  await ui.button('确认重启 1 项').props.onClick(); await ui.settle()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.endpoint === 'instances/run').payload)), { operation: 'restart', name: 'basic-instance', model_selection: alternateModel, expected_model_policy_hash: previewHash, expected_source_id: 'experiment:EXP-basic-001', port: 3084 })
  assert.match(ui.text(), /尚未从实例登记核对到所选默认模型/)
  assert.match(ui.text(), /已有 Session 的模型不会在此处自动切换|当前 Session 的实际模型需单独核对/)

  const stopped = page({ instances: [{ name: 'stopped-instance', agent_id: 'basic-agent', state: 'stopped', source_id: 'experiment:EXP-basic-001', port: 3086, model_policy: { default: defaultModel } }] })
  await stopped.settle()
  await stopped.button('详情').props.onClick(); await stopped.settle()
  stopped.button('更改默认模型').props.onClick(); await stopped.settle()
  stopped.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '实例默认模型').props.onChange({ target: { value: JSON.stringify(['provider-a', 'variant-model']) } }); stopped.render()
  await stopped.button('预览并启动').props.onClick(); await stopped.settle()
  assert.equal(stopped.calls.find(call => call.endpoint === 'instances/preview').payload.operation, 'start')
})

test('实例重启后回读到新登记默认模型才结束模型编辑', async () => {
  const instances = [{ name: 'basic-instance', agent_id: 'basic-agent', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084, model_policy: { default: defaultModel } }]
  const ui = page({ instances, respond(endpoint, payload) {
    if (endpoint === 'instances/run') instances[0] = { ...instances[0], model_policy: { default: payload.model_selection } }
  } })
  await ui.settle()
  await ui.button('详情').props.onClick(); await ui.settle()
  ui.button('更改默认模型').props.onClick(); await ui.settle()
  ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === '实例默认模型').props.onChange({ target: { value: JSON.stringify(['provider-a', 'variant-model']) } }); ui.render()
  await ui.button('预览并重启').props.onClick(); await ui.settle()
  await ui.button('确认重启 1 项').props.onClick(); await ui.settle()
  assert.doesNotMatch(ui.text(), /尚未从实例登记核对到所选默认模型/)
  assert.match(ui.text(), /登记默认模型.*模型服务 A · 变体模型/)
  assert.equal(ui.button('取消更改'), undefined)
})

test('模型目录读取失败或预览缺少模型摘要时不派发实例操作', async () => {
  let failModels = true
  const ui = page({ respond(endpoint, payload) {
    if (endpoint === 'models/list' && failModels) return { ok: false, error: { message: '模型目录暂时不可用' } }
    if (endpoint === 'instances/preview') return { ok: true, value: { name: payload.name, operation: payload.operation, plan: { source_id: payload.source, port: 3199 }, model_selection: payload.model_selection } }
  } })
  await ui.settle()
  openCreate(ui); await ui.settle()
  assert.match(ui.text(), /模型目录暂时不可用/)
  failModels = false
  ui.button('刷新模型').props.onClick(); await ui.settle()
  const select = label => ui.nodes().find(node => node.type === 'select' && node.props['aria-label'] === label)
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '实例名').props.onChange({ target: { value: 'new-instance' } }); ui.render()
  chooseAgent(ui, '基础助手 · basic-agent')
  select('选择来源版本').props.onChange({ target: { value: 'experiment:EXP-basic-001' } }); await ui.settle()
  await ui.button('查看创建预览').props.onClick(); await ui.settle()
  assert.match(ui.text(), /预览未确认所选模型及配置摘要/)
  assert.equal(ui.button('确认创建'), undefined)
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/run'), false)
})

test('失效来源保持原值并显示字段错误，无可用版本时不能直接创建', async () => {
  const ui = page({ target: { page: 'instances', source_id: 'experiment:EXP-missing-003', agent_id: 'empty-agent' } })
  await ui.settle()
  ui.button('手动输入来源表达式').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '来源').props.value, 'experiment:EXP-missing-003')
  assert.match(ui.text(), /该来源不在当前登记中/)
  assert.match(ui.text(), /没有可用的已登记来源/)
  assert.equal(ui.buttons('查看创建预览')[0].props.disabled, true)
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/preview'), false)
})

test('批量预览失败不阻止其它目标；执行回执区分成功、失败、未知和未派发', async () => {
  const instances = ['one', 'two', 'three', 'four', 'five'].map(name => ({ name, state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084 }))
  const ui = page({ instances, respond(endpoint, payload) {
    if (endpoint === 'instances/batch-preview') return { ok: true, value: { previews: payload.items.map(item => item.name === 'two'
      ? { name: item.name, operation: item.operation, ok: false, error: { message: '来源不可用' } }
      : { name: item.name, operation: item.operation, ok: true, value: { name: item.name, operation: item.operation, source_id: 'experiment:EXP-basic-001', observed_state: 'running', observed_at: '2026-10-21T01:00:00.000Z', retention: { home: '保留', sessions: '保留', source: '保留', runs: '保留', registration: '保留' } } }) } }
    if (endpoint === 'instances/run' && payload.name === 'three') return { ok: true, value: { name: payload.name, operation: payload.operation, ok: false, error: { message: '停止失败' } } }
    if (endpoint === 'instances/run' && payload.name === 'four') throw new Error('连接断开')
  } })
  await ui.settle()
  ui.nodes().find(node => node.type === 'input' && node.props['aria-label'] === '全选当前列表实例').props.onChange({ target: { checked: true } }); ui.render()
  await ui.button('停止').props.onClick(); await ui.settle()
  assert.match(ui.text(), /共选择 5 项 · 可确认 4 项 · 预览失败 1 项/)
  assert.match(ui.text(), /来源不可用/)
  assert.ok(ui.button('确认停止 4 项'))
  await ui.button('确认停止 4 项').props.onClick(); await ui.settle()
  assert.match(ui.text(), /成功 1 项，失败 1 项，结果未知 1 项，未派发 2 项/)
  assert.deepEqual(ui.calls.filter(call => call.endpoint === 'instances/run').map(call => call.payload.name), ['one', 'three', 'four'])
  ui.button('关闭').props.onClick(); ui.render()
  for (const [index, name, outcome] of [[0, 'one', '成功'], [1, 'two', '未派发'], [2, 'three', '失败'], [3, 'four', '结果未知'], [4, 'five', '未派发']]) {
    await ui.buttons('详情')[index].props.onClick(); await ui.settle()
    ui.tab('操作回执').props.onClick(); ui.render()
    const panel = ui.nodes().find(node => node.props?.id === 'instance-panel-receipts')
    assert.match(ui.text(panel), new RegExp(`${name} · 停止 · ${outcome}`))
    assert.equal(ui.nodes(panel).filter(node => node.props?.className === 'instance-receipt-ok' || node.props?.className === 'instance-receipt-bad').length, 1, '只显示当前实例的逐项结果')
  }
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'instances', instance_name: 'five', tab: 'receipts' })
})

test('操作回执仅在本页会话可回看，目标不符的成功响应按未知结果呈现', async () => {
  const ui = page({ respond(endpoint, payload) {
    if (endpoint === 'instances/run') return { ok: true, value: { name: 'another-instance', operation: payload.operation, ok: true } }
  } })
  await ui.settle()
  await ui.button('重启').props.onClick(); await ui.settle()
  await ui.button('确认重启 1 项').props.onClick(); await ui.settle()
  assert.match(ui.text(), /结果未知 1 项/)
  assert.match(ui.text(), /操作回执目标与提交目标不一致/)
  ui.button('关闭').props.onClick(); ui.render()
  await ui.button('详情').props.onClick(); await ui.settle()
  ui.tab('操作回执').props.onClick(); ui.render()
  const panel = ui.nodes().find(node => node.props?.id === 'instance-panel-receipts')
  assert.match(ui.text(panel), /basic-instance · 重启 · 结果未知/)
  assert.doesNotMatch(ui.text(panel), /another-instance/)

  const fresh = page({ target: { page: 'instances', instance_name: 'basic-instance', tab: 'receipts' } })
  await fresh.settle()
  assert.equal(fresh.tab('操作回执').props['aria-selected'], true)
  assert.match(fresh.text(), /本页尚无此实例的操作回执/)
})

test('实例详情深链恢复指定页签，关闭后返回实例列表', async () => {
  const ui = page({ target: { page: 'instances', instance_name: 'basic-instance', tab: 'logs' } })
  await ui.settle()
  assert.equal(ui.tab('运行日志').props['aria-selected'], true)
  ui.tab('概览').props.onClick(); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'instances', instance_name: 'basic-instance', tab: 'overview' })
  ui.button('关闭详情').props.onClick(); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'instances' })
  assert.equal(ui.tab('概览'), undefined)
})

test('无效实例深链提供返回列表入口并清除错误', async () => {
  const ui = page({ instances: [], target: { page: 'instances', instance_name: 'missing-instance' }, respond(endpoint) {
    if (endpoint === 'instances/detail') return { ok: false, error: { message: '实例不存在' } }
  } })
  await ui.settle()
  assert.match(ui.text(), /登记已不存在|实例不存在/)
  ui.button('返回实例列表').props.onClick(); ui.render()
  assert.deepEqual(JSON.parse(JSON.stringify(ui.navigations.at(-1))), { page: 'instances' })
  assert.doesNotMatch(ui.text(), /登记已不存在|实例不存在/)
})

test('实例详情按任务切换页签，嵌入地址取自接口且刷新后保留代码与当前页签', async () => {
  const ui = page()
  await ui.settle()
  await ui.button('详情').props.onClick(); await ui.settle()
  assert.ok(ui.nodes().some(node => node.props?.role === 'tablist' && node.props['aria-label'] === '实例详情'))
  assert.equal(ui.tab('概览').props['aria-selected'], true)
  assert.equal(ui.text().includes('basic-instance: runtime ready'), false, '默认概览不铺开运行日志')
  ui.tab('网站嵌入').props.onClick(); ui.render()
  await ui.button('生成 iframe 代码').props.onClick(); await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/url').length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.find(call => call.endpoint === 'instances/url').payload)), { name: 'basic-instance' })
  assert.match(ui.text(), /src="http:\/\/127\.0\.0\.1:3084\/assistant\/"/)
  await ui.button('复制嵌入代码').props.onClick(); await ui.settle()
  assert.equal(ui.copied.length, 1)
  assert.match(ui.copied[0], /<iframe\n  src="http:\/\/127\.0\.0\.1:3084\/assistant\/"/)
  ui.invalidate(); await ui.settle()
  assert.equal(ui.tab('网站嵌入').props['aria-selected'], true)
  assert.match(ui.text(), /src="http:\/\/127\.0\.0\.1:3084\/assistant\/"/)
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/url').length, 1, '后台刷新不能重新生成或清空用户已取得的嵌入代码')
  ui.tab('运行日志').props.onClick(); ui.render()
  assert.match(ui.text(), /basic-instance: runtime ready/)
})

test('切换实例重置为概览，不沿用前一个实例的嵌入代码或日志', async () => {
  const ui = page({ instances: [
    { name: 'basic-instance', state: 'running', source_id: 'experiment:EXP-basic-001', port: 3084 },
    { name: 'other-instance', state: 'running', source_id: 'experiment:EXP-other-002', port: 3085 },
  ] })
  await ui.settle()
  await ui.buttons('详情')[0].props.onClick(); await ui.settle()
  ui.tab('网站嵌入').props.onClick(); ui.render()
  await ui.button('生成 iframe 代码').props.onClick(); await ui.settle()
  ui.tab('运行日志').props.onClick(); ui.render()
  assert.match(ui.text(), /basic-instance: runtime ready/)
  await ui.buttons('详情')[1].props.onClick(); await ui.settle()
  assert.equal(ui.tab('概览').props['aria-selected'], true)
  assert.equal(ui.text().includes('basic-instance: runtime ready'), false)
  ui.tab('网站嵌入').props.onClick(); ui.render()
  assert.equal(ui.button('复制嵌入代码'), undefined)
  assert.equal(ui.text().includes('src="http://127.0.0.1:3084/assistant/"'), false)
  ui.tab('运行日志').props.onClick(); ui.render()
  assert.match(ui.text(), /other-instance: runtime ready/)
})

test('关闭详情后忽略迟到的后台详情与嵌入地址回执', async () => {
  const pendingDetail = deferred(), pendingUrl = deferred()
  let detailReads = 0
  const ui = page({ respond(endpoint) {
    if (endpoint === 'instances/detail' && ++detailReads > 1) return pendingDetail.promise
    if (endpoint === 'instances/url') return pendingUrl.promise
  } })
  await ui.settle()
  await ui.button('详情').props.onClick(); await ui.settle()
  ui.tab('网站嵌入').props.onClick(); ui.render()
  ui.button('生成 iframe 代码').props.onClick(); await ui.settle()
  ui.invalidate(); await ui.settle()
  ui.button('关闭详情').props.onClick(); ui.render()
  pendingDetail.resolve({ ok: true, value: { instance: { name: 'basic-instance', state: 'running', port: 3084 }, runs: [], session_scope: { note: '迟到的详情' } } })
  pendingUrl.resolve({ ok: true, value: { url: 'http://127.0.0.1:3084/assistant/', lan_access: false } })
  await ui.settle()
  assert.equal(ui.tab('概览'), undefined, '关闭后的迟到回执不能重新打开详情')
  assert.equal(ui.text().includes('迟到的详情'), false)
  assert.equal(ui.text().includes('<iframe'), false)
})

test('实例登记消失时清理已生成的嵌入代码，也忽略进行中地址请求的迟到回执', async () => {
  const instances = [{ name: 'basic-instance', state: 'running', port: 3084 }]
  const pendingUrl = deferred()
  let registered = true, delayUrl = false
  const ui = page({ instances, respond(endpoint) {
    if (endpoint === 'instances/list') return { ok: true, value: { instances: registered ? instances : [] } }
    if (endpoint === 'instances/url' && delayUrl) return pendingUrl.promise
  } })
  await ui.settle()
  await ui.button('详情').props.onClick(); await ui.settle()
  ui.tab('网站嵌入').props.onClick(); ui.render()
  await ui.button('生成 iframe 代码').props.onClick(); await ui.settle()
  assert.ok(ui.button('复制嵌入代码'))

  registered = false
  ui.invalidate(); await ui.settle()
  assert.match(ui.text(), /登记已不存在/)
  assert.equal(ui.button('复制嵌入代码'), undefined)
  assert.equal(ui.text().includes('<iframe'), false)
  assert.equal(ui.buttons('生成 iframe 代码')[0].props.disabled, true)

  registered = true
  ui.invalidate(); await ui.settle()
  delayUrl = true
  ui.button('生成 iframe 代码').props.onClick(); await ui.settle()
  registered = false
  ui.invalidate(); await ui.settle()
  pendingUrl.resolve({ ok: true, value: { url: 'http://127.0.0.1:3084/assistant/', lan_access: false } })
  await ui.settle()
  assert.match(ui.text(), /登记已不存在/)
  assert.equal(ui.button('复制嵌入代码'), undefined)
  assert.equal(ui.text().includes('<iframe'), false, '登记消失后迟到的地址不能重新形成嵌入代码')
  assert.equal(ui.buttons('生成 iframe 代码')[0].props.disabled, true)
})

test('日志失败保留详情概览，错误仅在运行日志中显示；未运行或无端口时禁止生成嵌入代码', async () => {
  const ui = page({ instances: [
    { name: 'stopped-instance', state: 'stopped', port: 3084 },
    { name: 'no-port-instance', state: 'running' },
  ], respond(endpoint) {
    if (endpoint === 'instances/logs') return { ok: false, error: { message: 'container logs unavailable' } }
  } })
  await ui.settle()
  for (let index = 0; index < 2; index++) {
    await ui.buttons('详情')[index].props.onClick(); await ui.settle()
    assert.equal(ui.tab('概览').props['aria-selected'], true)
    assert.equal(ui.text().includes('container logs unavailable'), false)
    ui.tab('运行日志').props.onClick(); ui.render()
    assert.match(ui.text(), /container logs unavailable/)
    ui.tab('网站嵌入').props.onClick(); ui.render()
    assert.equal(ui.buttons('生成 iframe 代码')[0].props.disabled, true)
  }
  assert.equal(ui.calls.some(call => call.endpoint === 'instances/url'), false)
})
