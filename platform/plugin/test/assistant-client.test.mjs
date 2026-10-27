import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'

const output = await mkdtemp(join(tmpdir(), 'harness-assistant-client-'))
const file = join(output, 'assistant.mjs')
await build({ entryPoints: [new URL('../src/assistant/client.tsx', import.meta.url).pathname], outfile: file, bundle: true, platform: 'node', format: 'esm' })
const { createAssistant } = await import(`file://${file}`)
after(() => rm(output, { recursive: true, force: true }))

function fixture(call, selection, rows = {}, config = {}) {
  const retained = []
  const opened = []
  const references = []
  const nativeCreates = []
  const selectionListeners = new Set()
  const assistant = createAssistant({
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: selection }), subscribe: listener => { selectionListeners.add(listener); return () => selectionListeners.delete(listener) } } } },
    workspaces: { create: async request => { assert.deepEqual(request, { path: '/repo' }); return { workspaceId: 'project' } } },
    sessions: { list: { getSnapshot: () => ({ byId: rows }), subscribe: () => () => {} }, async refresh() { Object.assign(rows, config.refreshedRows) }, async create(request) {
      nativeCreates.push(request)
      await config.beforeCreate?.(request)
      const id = request.sessionId ?? config.sessionIds?.[nativeCreates.length - 1] ?? `session-${nativeCreates.length}`
      rows[id] = { cwd: request.cwd ?? '/repo' }
      return id
    }, retain(id, options) {
      if (!rows[id]) throw new Error(`sessions.retain: unknown session ${id}`)
      retained.push([id, options.source])
      const reference = { sessionId: id, ready: config.ready?.(id) ?? Promise.resolve({}), released: 0, release() { this.released++ } }
      references.push(reference)
      return reference
    }, async using(id, options, operation) {
      const reference = this.retain(id, options)
      try { await reference.ready; return await operation(reference) }
      finally { reference.release() }
    } },
    uiWorkspace: { openSession: id => opened.push(id) },
  }, { call: (channel, endpoint, body) => endpoint === 'assistant/configuration' ? Promise.resolve(config.configuration ?? { ok: true, value: { ready: true } }) : call(channel, endpoint, body) }, () => '/repo', () => config.legacyRoots ?? [])
  return { assistant, retained, opened, references, nativeCreates, setSelection(id) { selection = id; selectionListeners.forEach(listener => listener()) } }
}

test('每个新任务使用独立 Session；融合确认可以续接原任务，切换后释放旧引用', async () => {
  const calls = []
  const f = fixture(async (channel, endpoint, body) => {
    calls.push([channel, endpoint, body])
    return { ok: true, value: endpoint === 'assistant/session' ? { session_id: body.session_id } : { proposals: [] } }
  })
  await f.assistant.create('检查版本', { page: 'agents', experiment_id: 'EXP-a' })
  await f.assistant.create('检查实例', { page: 'instances', instance_name: 'one' })
  assert.deepEqual(f.nativeCreates[0], { workspaceId: 'project' })
  assert.equal(calls[0][2].session_id, 'session-1')
  assert.equal(f.assistant.getSnapshot().sessionId, 'session-2')
  assert.equal(f.references[1].released, 1)
  await f.assistant.create('继续融合', { page: 'agents', session_id: 'session-1' })
  assert.equal(f.assistant.getSnapshot().sessionId, 'session-1')
  assert.deepEqual(f.opened, ['session-1', 'session-2', 'session-1'])
  assert.equal(calls.filter(([, endpoint]) => endpoint === 'assistant/session')[2][2].session_id, 'session-1')
  assert.equal(f.nativeCreates.length, 2, '续接不另建会话')
  assert.equal(calls.some(([channel]) => channel !== '/harness-platform'), false)
  f.assistant.dispose()
  assert.ok(f.references.every(item => item.released === 1))
})

test('状态读取丢弃过时响应，重连恢复同会话，不创建或投递任务', async () => {
  const pending = []
  let creates = 0
  const f = fixture(async (_channel, endpoint) => {
    if (endpoint === 'assistant/session') { creates++; return { ok: true, value: { session_id: 'session-a' } } }
    if (pending.length < 1) return { ok: true, value: { proposals: [] } }
    return new Promise(resolve => pending.push(resolve))
  }, undefined, {}, { sessionIds: ['session-a'] })
  await f.assistant.create('检查')
  pending.push(null)
  const first = f.assistant.refresh()
  const second = f.assistant.refresh()
  pending[2]({ ok: true, value: { proposals: [{ id: 'p', state: 'completed' }] } })
  await second
  pending[1]({ ok: true, value: { proposals: [{ id: 'p', state: 'awaiting_confirmation' }] } })
  await first
  assert.equal(f.assistant.getSnapshot().status.proposals[0].state, 'completed')
  pending.splice(0)
  const retainedBeforeReconnect = f.retained.length
  await f.assistant.reconnect()
  assert.equal(creates, 1)
  assert.equal(f.retained.length, retainedBeforeReconnect + 1)
  assert.equal(f.retained.at(-1)[0], 'session-a')
  assert.equal(f.references[1].released, 1)
  f.assistant.dispose()
})

test('会话创建失败保留当前选择，错误可见；上下文同步不重新启动任务', async () => {
  let fail = false
  const contexts = []
  const f = fixture(async (_channel, endpoint, body) => {
    if (endpoint === 'assistant/session') return fail ? { ok: false, error: { message: '模型不可用' } } : { ok: true, value: { session_id: 'existing' } }
    if (endpoint === 'assistant/context') contexts.push(body)
    return { ok: true, value: { proposals: [] } }
  }, undefined, {}, { sessionIds: ['existing', 'next'] })
  await f.assistant.create('第一个任务')
  contexts.splice(0)
  f.assistant.updateContext({ page: 'mcp', composition_id: 'c' })
  await Promise.resolve()
  assert.deepEqual(contexts, [{ session_id: 'existing', context: { page: 'mcp', composition_id: 'c' } }])
  fail = true
  await assert.rejects(f.assistant.create('第二个任务'), /模型不可用/)
  assert.equal(f.assistant.getSnapshot().sessionId, 'existing')
  assert.equal(f.assistant.getSnapshot().error, '模型不可用')
  assert.equal(f.assistant.getSnapshot().busy, false)
  f.assistant.dispose()
})

test('快速切换页面时按顺序同步上下文，最终保留最后选中的对象', async () => {
  const writes = []
  let release
  const f = fixture(async (_channel, endpoint, body) => {
    if (endpoint === 'assistant/session') return { ok: true, value: { session_id: 'session-a' } }
    if (endpoint === 'assistant/context') {
      writes.push(body.context)
      if (body.context.page === 'agents') await new Promise(resolve => { release = resolve })
    }
    return { ok: true, value: { proposals: [] } }
  }, undefined, {}, { sessionIds: ['session-a'] })
  await f.assistant.create()
  writes.splice(0)
  f.assistant.updateContext({ page: 'agents', experiment_id: 'EXP-a' })
  f.assistant.updateContext({ page: 'instances', instance_name: 'one' })
  f.assistant.updateContext({ page: 'mcp', composition_id: 'latest' })
  assert.equal(writes.length, 1)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes.at(-1), { page: 'mcp', composition_id: 'latest' })
  f.assistant.dispose()
})

test('刷新后跟随原生当前会话，其他工作区保留聊天且不注入平台上下文', async () => {
  for (const cwd of ['/repo', '/another-project']) {
    const endpoints = []
    const f = fixture(async (_channel, endpoint) => {
      endpoints.push(endpoint)
      return { ok: true, value: { proposals: [] } }
    }, 'last-session', { 'last-session': { cwd } })
    f.assistant.restore()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.assistant.getSnapshot().sessionId, 'last-session')
    assert.equal(f.assistant.getSnapshot().platformContext, cwd === '/repo')
    assert.equal(endpoints.includes('assistant/session'), false)
    if (cwd !== '/repo') {
      f.assistant.updateContext({ page: 'agents' })
      await f.assistant.refresh()
      assert.deepEqual(endpoints, [])
    }
    f.assistant.dispose()
  }
})

test('跟随原生侧栏选择且不重复导航，归档清空当前选择后释放浮窗引用', async () => {
  const f = fixture(async () => ({ ok: true, value: { proposals: [] } }), undefined, { 'native-session': { cwd: '/repo' } })
  f.setSelection('native-session')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.assistant.getSnapshot().sessionId, 'native-session')
  assert.deepEqual(f.opened, [])
  f.setSelection(undefined)
  assert.equal(f.assistant.getSnapshot().sessionId, undefined)
  assert.equal(f.assistant.getSnapshot().reference, undefined)
  assert.equal(f.references[0].released, 1)
  f.assistant.dispose()
})

test('列表通知未到时先完成原生登记与绑定，再向同一Session投递一次真实任务', async () => {
  let register, open, startedCreate, startedOpen
  const registration = new Promise(resolve => { register = resolve })
  const opening = new Promise(resolve => { open = resolve })
  const createStarted = new Promise(resolve => { startedCreate = resolve })
  const openStarted = new Promise(resolve => { startedOpen = resolve })
  const calls = []
  // fixture 刻意不发 Session list 通知；create 返回前按原生合同登记身份。
  const f = fixture(async (_channel, endpoint, body) => {
    calls.push([endpoint, body])
    return { ok: true, value: endpoint === 'assistant/session' ? { session_id: body.session_id } : { proposals: [] } }
  }, undefined, {}, {
    sessionIds: ['session-race'],
    beforeCreate() { startedCreate(); return registration },
    ready() { startedOpen(); return opening },
  })
  const creating = f.assistant.create('你好', { page: 'home' })
  await createStarted
  assert.deepEqual(calls, [])
  assert.deepEqual(f.retained, [])
  register()
  await openStarted
  assert.deepEqual(calls, [])
  assert.equal(f.retained[0][0], 'session-race')
  open()
  await creating
  assert.deepEqual(calls.filter(([endpoint]) => endpoint === 'assistant/session'), [
    ['assistant/session', { task: '你好', context: { page: 'home' }, session_id: 'session-race' }],
  ])
  assert.deepEqual(f.nativeCreates, [{ workspaceId: 'project' }])
  assert.equal(f.assistant.getSnapshot().sessionId, 'session-race')
  assert.equal(f.assistant.getSnapshot().error, '')
  assert.equal(f.assistant.getSnapshot().busy, false)
  f.assistant.dispose()
  assert.ok(f.references.every(item => item.released === 1))
})

test('新会话绑定失败不投递任务，保留已有选择和Host已登记的Session', async () => {
  const calls = []
  const rows = { existing: { cwd: '/repo' } }
  const f = fixture(async (_channel, endpoint) => {
    calls.push(endpoint)
    return { ok: true, value: { proposals: [] } }
  }, 'existing', rows, {
    sessionIds: ['created-but-unavailable'],
    ready: id => id === 'created-but-unavailable' ? Promise.reject(new Error('history open failed')) : Promise.resolve({}),
  })
  f.assistant.restore()
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.assistant.create('你好'), /history open failed/)
  assert.equal(calls.includes('assistant/session'), false)
  assert.equal(f.assistant.getSnapshot().sessionId, 'existing')
  assert.equal(f.assistant.getSnapshot().busy, false)
  assert.equal(f.references[0].released, 0)
  assert.equal(f.references[1].released, 1)
  assert.deepEqual(rows['created-but-unavailable'], { cwd: '/repo' })
  f.assistant.dispose()
})

test('retain同步失败后解除选择锁，原生恢复错误可见且后续选择仍能联动', async () => {
  const f = fixture(async () => ({ ok: true, value: { proposals: [] } }), undefined, { known: { cwd: '/repo' } })
  await assert.rejects(f.assistant.select('unknown'), /sessions.retain: unknown session/)
  f.setSelection('unknown-native')
  await new Promise(resolve => setImmediate(resolve))
  assert.match(f.assistant.getSnapshot().error, /unknown-native/)
  f.setSelection('known')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.assistant.getSnapshot().sessionId, 'known')
  assert.equal(f.assistant.getSnapshot().error, '')
  assert.deepEqual(f.opened, [])
  f.assistant.dispose()
})

test('组合确认卡片显示实际冻结版本与工具身份', async () => {
  const compiled = await build({ entryPoints: ['src/assistant/client.tsx'], write: false, bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
  const versionId = '1'.repeat(64)
  const proposal = { id: 'proposal-fixed', state: 'awaiting_confirmation', domain: 'mcp', action: 'callPublishedComposition',
    preview: { action: 'callPublishedComposition', compositionId: 'composition-fixed', versionId, toolName: 'basic_status', title: '基础状态' } }
  const assistant = { subscribe: () => () => {}, getSnapshot: () => ({ sessionId: 'session-fixed', status: { proposals: [proposal] } }) }
  const jsx = (type, props) => ({ type, props })
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require(name) {
    if (name === 'react') return { createContext: value => ({ value }), useContext: context => context.value, useState: initial => [initial, () => {}], useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    throw new Error(`unexpected import: ${name}`)
  } })
  const render = node => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node !== 'object') return String(node)
    if (Array.isArray(node)) return node.map(render).join(' ')
    if (typeof node.type === 'function') return render(node.type(node.props))
    return render(node.props?.children)
  }
  const text = render(module.exports.AssistantOperations({ assistant, rpc: { call() { assert.fail('渲染不能执行操作') } }, sessionId: 'session-fixed' }))
  assert.match(text, /固定发布版本/)
  assert.ok(text.includes(versionId))
  assert.ok(text.includes('composition-fixed') && text.includes('basic_status'))
  assert.match(text, /执行工具组合/)
  assert.match(text, /暂不执行/)
})

test('原生回执消费真实参数与结果，完成提案不重复进dock，只有dock保留确认入口', async () => {
  const compiled = await build({ entryPoints: ['src/assistant/client.tsx'], write: false, bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
  let proposals = []
  const assistant = { subscribe: () => () => {}, getSnapshot: () => ({ sessionId: 's', status: { proposals } }) }
  const jsx = (type, props) => ({ type, props }), module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require(name) {
    if (name === 'react') return { createContext: value => ({ value }), useContext: context => context.value, useState: initial => [initial, () => {}], useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    throw new Error(`unexpected import: ${name}`)
  } })
  const nodes = []
  const render = node => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node !== 'object') return String(node)
    if (Array.isArray(node)) return node.map(render).join(' ')
    if (typeof node.type === 'function') return render(node.type(node.props))
    nodes.push(node); return render(node.props?.children)
  }
  const props = { phase: 'result', toolName: 'platform_agents', callId: 'read-1', sessionId: 's', assistant, rpc: { call() { assert.fail('渲染不得执行操作') } } }
  const block = { args: { text: () => 'detail', value: () => ({ agent_id: 'daily-inspection-assistant' }) }, call: null, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ kind: 'platform-operation', domain: 'agents', action: 'detail', state: 'completed', result: { ok: true, value: { agent: { name: '巡检助手' }, experiment: { id: 'EXP-a-003' }, evaluation: { cases: [{}] } } } }) }] }
  const text = render(module.exports.PlatformOperationCard({ ...props, block }))
  assert.match(text, /读取智能体详情.*巡检助手/); assert.match(text, /1 个测试用例/)
  assert.equal(nodes.some(node => node.type === 'section'), false, '只读回执为可展开单行，不再绘制大卡片')
  assert.doesNotMatch(text, /已返回操作结果/)
  proposals = [{ id: 'p', domain: 'agents', action: 'create', state: 'completed', result: { ok: true } }]
  assert.equal(module.exports.AssistantOperations({ assistant, rpc: props.rpc, sessionId: 's' }), null)
  proposals = [{ ...proposals[0], state: 'awaiting_confirmation', preview: { parent_experiment_id: 'EXP-a-001' } }]
  const dockText = render(module.exports.AssistantOperations({ assistant, rpc: props.rpc, sessionId: 's' }))
  assert.equal((dockText.match(/创建研究版本/g) ?? []).length, 1)
  const toolText = render(module.exports.PlatformOperationCard({ ...props, block: { ...block, meta: { ...proposals[0], kind: 'platform-operation', proposal_id: 'p' } } }))
  assert.doesNotMatch(toolText, /暂不执行/, '同一提案原生轨迹不重复绘制确认按钮')
  const errorText = render(module.exports.PlatformOperationCard({ ...props, toolName: 'platform_task', block: { ...block, args: { text: () => 'start', value: () => ({}) }, isError: true, content: [{ type: 'text', text: '已有未结束任务' }] } }))
  assert.match(errorText, /启动交付任务.*已有未结束任务/)
})

test('确认首屏仅展示决策摘要、具体交付与重要预算，完整事实可展开并提供暂不执行', async () => {
  const compiled = await build({ entryPoints: ['src/assistant/client.tsx'], write: false, bundle: true, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
  const plan = { goal: '构建只读巡检助手：完整需求包括五台模拟设备的分页查询与正式报告下载。', agent_id: 'daily-inspection-assistant', source: 'experiment:EXP-daily-inspection-assistant-002-r123456789abc', evaluation_case_ids: ['U-PRIVATE-BUSINESS-CASE'], allowed_actions: [{ domain: 'agents', action: 'create' }], budget: { timeout_minutes: 30, max_repair_rounds: 3, max_model_calls: 60 }, deliverables: ['Markdown 报告和设备 CSV'], artifact_paths: ['artifacts/U-PRIVATE-BUSINESS-CASE/report.md'], instance_name: 'delivery-test' }
  let proposal = { id: 'p', domain: 'task', action: 'start', state: 'awaiting_confirmation', preview: { plan, agent_name: '日常巡检整理助手', candidate_sha256: 'a'.repeat(64) } }
  let execution, refreshes = 0
  const assistant = { subscribe: () => () => {}, getSnapshot: () => ({ sessionId: 's', status: { proposals: proposal ? [proposal] : [], execution } }), refresh: async () => { refreshes++ }, applySettlement: (_id, receipt) => { proposal = { ...proposal, ...receipt } } }
  const requests = [], rpc = { async call(_channel, method, body) { requests.push({ method, body }); return { ok: true, value: { state: 'cancelled' } } } }
  const jsx = (type, props) => ({ type, props }), module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require(name) {
    if (name === 'react') return { createContext: value => ({ value }), useContext: context => context.value, useState: initial => [initial, () => {}], useSyncExternalStore: (_subscribe, snapshot) => snapshot() }
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    throw new Error(`unexpected import: ${name}`)
  } })
  let nodes = []
  const render = (node, all = false) => {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node !== 'object') return String(node)
    if (Array.isArray(node)) return node.map(child => render(child, all)).join(' ')
    if (typeof node.type === 'function') return render(node.type(node.props), all)
    nodes.push(node)
    if (node.type === 'details' && !node.props.open && !all) return render([node.props.children].flat().find(child => child?.type === 'summary'), all)
    return render(node.props.children, all)
  }
  const view = () => module.exports.AssistantOperations({ assistant, rpc, sessionId: 's' })
  const visible = render(view())
  assert.match(visible, /日常巡检整理助手.*版本 002/)
  assert.match(visible, /Markdown 报告.*设备 CSV.*可访问的智能体实例/)
  assert.match(visible, /30.*分钟.*3.*轮.*60.*次/)
  assert.match(visible, /不能实时硬封顶/)
  assert.match(visible, /开始构建并验证/)
  assert.doesNotMatch(visible, /U-PRIVATE-BUSINESS-CASE|daily-inspection-assistant|a{64}/)
  const all = render(view(), true)
  assert.ok(all.includes(plan.goal)); assert.match(all, /U-PRIVATE-BUSINESS-CASE|a{64}/)
  await nodes.find(node => node.type === 'button' && node.props.children === '暂不执行').props.onClick()
  assert.equal(requests[0].method, 'assistant/reject'); assert.equal(requests[0].body.proposal_id, 'p')
  assert.equal(view(), null, '取消回执立即移出输入区')
  proposal = { ...proposal, state: 'awaiting_confirmation' }
  let finishRefresh
  assistant.refresh = () => new Promise(resolve => { finishRefresh = resolve })
  rpc.call = async () => ({ ok: true, value: { id: 'p', state: 'completed', continuation: 'requires_user_message' } })
  nodes = []; render(view())
  const confirming = nodes.find(node => node.type === 'button' && node.props.children === '开始构建并验证').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(view(), null, '确认成功后无需等待状态刷新即可收起')
  finishRefresh(); await confirming
  assistant.refresh = async () => { refreshes++ }
  proposal = { id: 'dataset', domain: 'agents', action: 'datasets/apply', state: 'awaiting_confirmation', preview: { status: 'suggested', count: 1, records: [{ workflow: '安全事件处置', questions: { action: {}, needs_review: {} }, targets: { action: { basis: '只在完整详情展示的标签依据' } } }] } }
  nodes = []
  const sample = render(view())
  assert.match(sample, /保存 1 条样本/); assert.match(sample, /人员逐题复核/); assert.match(sample, /安全事件处置/); assert.match(sample, /2.*道命名决策题/); assert.doesNotMatch(sample, /只在完整详情/)
  proposal = { id: 'mcp', domain: 'mcp', action: 'saveConfiguration', state: 'awaiting_confirmation', preview: { action: 'saveConfiguration', input: { ops: [{ op: 'set', path: ['servers', 'test', 'enabled'], value: false }] } } }
  assert.match(render(view()), /停用连接.*不可调用/)
  const fullFreezeDiff = '冻结差异开始\n' + '+ compiled-esm-confirmation '.repeat(100000) + '\n冻结差异结束'
  proposal = { id: 'freeze', domain: 'agents', action: 'compute-variants/freeze', state: 'awaiting_confirmation', input: { experiment_id: 'EXP-alpha-002' },
    preview: { ok: true, value: { experiment_id: 'EXP-alpha-002', files: [{ path: 'candidate/dsh/managed/compute-workflow/index.mjs', sha256: 'd'.repeat(64) }], diff: fullFreezeDiff, preview_sha256: 'f'.repeat(64) } } }
  const freezeDetails = render(view(), true)
  assert.ok(freezeDetails.includes(fullFreezeDiff), '原生确认界面使用持久完整差异，不使用模型投影或截断版本')
  assert.match(freezeDetails, /确认冻结本次数据差异/)
  proposal = undefined
  execution = { plan, state: 'paused', repair_rounds: 1, model_calls: 46, deadline_at: '2020-01-01T00:00:00Z', operations: [] }
  rpc.call = async () => { execution = { ...execution, state: 'budget_exhausted', reason: '任务总时限已耗尽' }; return { ok: false, error: { message: execution.reason } } }
  nodes = []; render(view())
  const beforeRefresh = refreshes
  await nodes.find(node => node.type === 'button' && node.props.children === '恢复任务').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(refreshes, beforeRefresh + 1, '恢复被后端拒绝后也必须刷新持久状态')
  nodes = []; const exhausted = render(view())
  assert.match(exhausted, /额度已用尽/); assert.doesNotMatch(exhausted, /恢复任务/)
})


test('迁移前原生会话按服务端提供的旧根恢复平台上下文', async () => {
  const calls = []
  const f = fixture(async (_channel, endpoint, body) => { calls.push({ endpoint, body }); return { ok: true, value: { proposals: [] } } }, 'legacy', { legacy: { cwd: '/old-repo' } }, { legacyRoots: ['/old-repo'] })
  f.assistant.restore()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(f.assistant.getSnapshot().platformContext, true)
  assert.ok(calls.some(call => call.endpoint === 'assistant/status'))
  f.assistant.dispose()
})


test('续接迁移旧会话时保留原 cwd，拒绝把外部会话收编为管理任务', async () => {
  const f = fixture(async (_channel, endpoint, body) => ({ ok: true, value: endpoint === 'assistant/session' ? { session_id: body.session_id } : { proposals: [] } }), undefined, { legacy: { cwd: '/old-repo' }, foreign: { cwd: '/another-project' } }, { legacyRoots: ['/old-repo'] })
  await f.assistant.create('继续任务', { session_id: 'legacy' })
  assert.equal(f.assistant.getSnapshot().sessionId, 'legacy')
  assert.equal(f.nativeCreates.length, 0)
  await assert.rejects(() => f.assistant.create('继续任务', { session_id: 'foreign' }), /不属于当前工作区/)
  assert.equal(f.nativeCreates.length, 0)
  f.assistant.dispose()
})

test('续接前刷新未到达的历史会话目录，不通过新建接口收编', async () => {
  const f = fixture(async (_channel, endpoint, body) => ({ ok: true, value: endpoint === 'assistant/session' ? { session_id: body.session_id } : { proposals: [] } }), undefined, {}, { legacyRoots: ['/old-repo'], refreshedRows: { legacy: { cwd: '/old-repo' } } })
  await f.assistant.create('继续任务', { session_id: 'legacy' })
  assert.equal(f.assistant.getSnapshot().sessionId, 'legacy')
  assert.equal(f.nativeCreates.length, 0)
  f.assistant.dispose()
})


test('配置缺失在创建原生工作区和会话之前提示，既有会话仍可查看', async () => {
  const f = fixture(async () => ({ ok: true, value: { proposals: [] } }), 'existing', { existing: { cwd: '/repo' } }, { configuration: { ok: true, value: { ready: false, message: '当前工作区未配置平台管理助手，请连接或克隆已有数据仓库。' } } })
  await f.assistant.select('existing', false)
  await assert.rejects(f.assistant.create('新任务'), /未配置平台管理助手/)
  assert.equal(f.nativeCreates.length, 0)
  assert.equal(f.assistant.getSnapshot().sessionId, 'existing')
  assert.match(f.assistant.getSnapshot().error, /连接或克隆/)
  f.assistant.dispose()
})

test('确认回执优先于在途旧状态，刷新失败保持结算且显式提示，跨会话回执被忽略', async () => {
  let fail = false, pending, hold = false
  const f = fixture(async (_channel, endpoint) => {
    if (endpoint !== 'assistant/status') return { ok: true, value: { session_id: 's' } }
    if (fail) throw new Error('offline')
    if (hold) return new Promise(resolve => { pending = resolve })
    return { ok: true, value: { proposals: [{ id: 'p', state: 'awaiting_confirmation' }] } }
  }, undefined, {}, { sessionIds: ['s'] })
  await f.assistant.create('继续')
  hold = true
  const refresh = f.assistant.refresh()
  f.assistant.applySettlement('s', { id: 'p', state: 'completed' })
  pending({ ok: true, value: { proposals: [{ id: 'p', state: 'awaiting_confirmation' }] } }); await refresh
  assert.equal(f.assistant.getSnapshot().status.proposals[0].state, 'completed')
  fail = true; await f.assistant.refresh()
  assert.match(f.assistant.getSnapshot().statusError, /读取失败/)
  assert.equal(f.assistant.getSnapshot().status.proposals[0].state, 'completed')
  f.assistant.applySettlement('other-session', { id: 'p', state: 'running' })
  assert.equal(f.assistant.getSnapshot().status.proposals[0].state, 'completed')
  hold = false; fail = false; await f.assistant.refresh()
  assert.equal(f.assistant.getSnapshot().statusError, '')
  f.assistant.dispose()
})
