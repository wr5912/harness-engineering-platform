import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const local = resolve('.local/external-conversation-tests'); mkdirSync(local, { recursive: true })
const compiled = mkdtempSync(join(local, 'build-')); symlinkSync(resolve('node_modules'), join(compiled, 'node_modules'), 'dir')
await build({ entryPoints: { access: 'src/instances/external/access.ts', registry: 'src/instances/external/registry.ts', adapter: 'src/instances/external/adapters.ts', conversation: 'src/instances/external/conversation.ts' }, outdir: compiled, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const access = await import(`file://${join(compiled, 'access.mjs')}`), registry = await import(`file://${join(compiled, 'registry.mjs')}`)
const { conversationReply } = await import(`file://${join(compiled, 'conversation.mjs')}`)
test.after(() => rmSync(compiled, { recursive: true, force: true }))
const caller = (subjectId = 'A') => ({ subjectId, source: 'test-provider', expiresAt: new Date(Date.now() + 60000).toISOString() })
const signal = () => new AbortController().signal

async function fixture(t, framework = 'opencode') {
  const root = mkdtempSync(join(local, 'state-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config')); writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, agents: [] }))
  const calls = [], sessions = new Map(); let mode = 'running', onRead
  function complete(id) {
    const rows = sessions.get(id), time = Date.now()
    if (framework === 'opencode') rows.push({ id: 'answer-' + rows.length, type: 'assistant', time: { created: time, completed: time }, finish: 'stop', content: [{ type: 'text', text: '本次真实边界回答' }, { type: 'tool', id: 'tool-' + rows.length, name: 'get_asset', state: { status: 'completed' } }] }, { id: 'idle-' + rows.length, type: 'idle', time: { created: time + 1 }, outcome: 'succeeded' })
    else rows.push({ id: 'answer-' + rows.length, role: 'assistant', finished_at: new Date().toISOString(), finished_reason: 'completed', content: [{ type: 'thinking', text: 'PRIVATE_THINKING' }, { type: 'text', text: '本次真实边界回答' }, { type: 'tool_call', id: 'tool-' + rows.length, name: 'get_asset', state: 'finished' }, { type: 'tool_result', id: 'tool-' + rows.length, state: 'success' }] })
    mode = 'completed'
  }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    const body = raw ? JSON.parse(raw) : null, url = new URL(req.url, 'http://native')
    calls.push({ path: url.pathname, method: req.method, body, headers: req.headers }); res.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/info') return res.end(JSON.stringify({ version: '2.2.5', pid: 1 }))
    if (url.pathname === '/api/session/create') { sessions.set('session-1', []); return res.end(JSON.stringify({ result: { ok: true, value: { sessionId: 'session-1' } } })) }
    if (url.pathname === '/api/session/projections') { onRead?.(url.pathname); return res.end(JSON.stringify({ result: { ok: true, value: { kind: 'sequenced', asOfSeq: 4 } } })) }
    if (url.pathname === '/api/session/page') return res.end(JSON.stringify({ result: { ok: true, value: { records: [], hasMore: false } } }))
    if (url.pathname === '/api/session' && req.method === 'GET') return res.end(JSON.stringify({ data: [...sessions.keys()].map(id => ({ id })) }))
    if (url.pathname === '/openapi.json') return res.end(JSON.stringify({ info: { version: '2.0.8' }, paths: { '/chat/': {}, '/sessions/{session_id}/stream': {} } }))
    if (url.pathname === '/agent/') return res.end(JSON.stringify({ agents: [{ id: 'native-agent' }] }))
    if ((url.pathname === '/api/session' || url.pathname === '/sessions/') && req.method === 'POST') {
      const id = 'session-' + (sessions.size + 1); sessions.set(id, [])
      if (mode === 'dropCreate') return req.socket.destroy()
      return res.end(JSON.stringify(framework === 'opencode' ? { data: { id } } : { session_id: id }))
    }
    if (url.pathname.endsWith('/prompt') || url.pathname === '/chat/') {
      const id = framework === 'opencode' ? url.pathname.split('/')[3] : body.session_id, input = framework === 'opencode' ? body : body.input
      assert.ok(input.id.startsWith('msg_'))
      sessions.get(id).push(framework === 'opencode' ? { id: input.id, type: 'user', time: { created: Date.now() } } : { id: input.id, role: 'user', content: [] })
      if (mode === 'dropPrompt') { complete(id); return req.socket.destroy() }
      if (mode === 'completed') complete(id)
      return res.end(JSON.stringify(framework === 'opencode' ? { data: { id: input.id } } : { status: 'started', session_id: id }))
    }
    if (url.pathname === '/api/session/active') { onRead?.(url.pathname); return res.end(JSON.stringify({ data: mode === 'running' ? Object.fromEntries([...sessions.keys()].map(id => [id, { type: 'running' }])) : {} })) }
    if (url.pathname.endsWith('/permission') || url.pathname.endsWith('/form')) return res.end(JSON.stringify({ data: mode === 'waiting' ? [{ id: 'permission' }] : [] }))
    if (url.pathname.endsWith('/status')) return res.end(JSON.stringify({ status: mode === 'running' ? 'running' : mode === 'waiting' ? 'awaiting_permission' : 'idle' }))
    if (url.pathname.endsWith('/message') || url.pathname.endsWith('/messages')) {
      const id = framework === 'opencode' ? url.pathname.split('/')[3] : url.pathname.split('/')[2], rows = sessions.get(id)
      if (onRead?.(url.pathname, req, res) === false) return
      return res.end(JSON.stringify(framework === 'opencode' ? { data: [...rows].reverse() } : { messages: rows, is_running: mode === 'running', has_more: false }))
    }
    res.writeHead(404); res.end('{}')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const endpoint = `http://127.0.0.1:${server.address().port}`, id = 'remote-one'
  const saved = registry.mutateExternal(root, 'save', { requestId: 'register', revision: registry.externalInstances(root).revision, agent: { id: 'sample-agent', name: '样本', system: '原系统', owner: 'owner' }, instance: { id, name: '原生实例', framework, endpoint, selector: framework === 'agentscope' ? 'native-agent' : framework === 'dsh' ? JSON.stringify({ workspaceId: 'workspace', agentPreset: 'standard' }) : '/workspace', ...(framework === 'agentscope' ? { connectionUserId: 'original-owner' } : {}), managementMode: 'externally-managed', usageMode: 'shared' }, policy: { subjects: ['A', 'B'], actions: ['agent:access', 'session:create', 'session:prompt', 'session:read'], enabled: true } })
  registry.mutateExternal(root, 'verify', { id, requestId: 'verify', revision: saved.revision }, { ok: true, bindingDigest: saved.instance.bindingDigest, adapterVersion: 'test', observedAt: new Date().toISOString(), checks: [] })
  registry.mutateExternal(root, 'enable', { id, requestId: 'enable', revision: registry.externalInstances(root).revision })
  const send = (input, subject = caller()) => access.sendExternalConversation(root, subject, { id, requestId: 'send-one', input: '查询资产', ...input }, signal())
  const status = (requestId = 'send-one', subject = caller()) => access.readExternalConversation(root, subject, { id, requestId }, signal())
  return { root, calls, sessions, send, status, complete, mode: value => { mode = value }, onRead: fn => { onRead = fn }, writes: () => calls.filter(c => c.method === 'POST').length }
}

for (const framework of ['opencode', 'agentscope']) test(`${framework} 首次消息自动创建并等待真实回复，后续消息不认领历史完成`, async t => {
  const f = await fixture(t, framework)
  assert.equal(f.sessions.size, 0)
  const first = await f.send(); assert.equal(first.status, 'running'); assert.ok(first.sessionId); assert.equal(f.sessions.size, 1); assert.equal(f.writes(), 2)
  f.complete('session-1'); const completed = await f.status(); assert.equal(completed.status, 'completed'); assert.equal(completed.messages[0].text, '本次真实边界回答'); assert.equal(completed.tools[0].status, 'completed'); assert.ok(!JSON.stringify(completed).includes('PRIVATE_THINKING'))
  await f.send(); assert.equal(f.writes(), 2)
  f.mode('running'); const second = await f.send({ requestId: 'send-two', sessionId: first.sessionId, input: '第二条' }); assert.equal(second.status, 'running'); assert.deepEqual(second.messages, []); assert.equal(f.sessions.size, 1); assert.equal(f.writes(), 3)
  f.mode('waiting'); const waiting = await f.status('send-two'); assert.equal(waiting.status, 'waiting'); assert.match(waiting.note, /权限/)
  f.complete('session-1'); assert.equal((await f.status('send-two')).status, 'completed'); assert.equal(f.writes(), 3)
  if (framework === 'agentscope') assert.equal(f.calls.find(c => c.path === '/chat/').headers['x-user-id'], 'original-owner')
})

test('创建结果未知不盲建，发送响应丢失通过原生消息锚点恢复且不重放', async t => {
  const create = await fixture(t); create.mode('dropCreate')
  assert.equal((await create.send()).status, 'unknown'); assert.equal((await create.send()).status, 'unknown'); assert.equal(create.writes(), 1); assert.equal((await create.status()).status, 'unknown')
  assert.equal((await create.send({ input: '不同消息' })).status, 'failed'); assert.equal(create.writes(), 1)
  const prompt = await fixture(t); prompt.mode('dropPrompt')
  const result = await prompt.send(); assert.equal(result.status, 'completed'); assert.equal(prompt.writes(), 2)
  assert.equal((await prompt.send()).status, 'completed'); assert.equal(prompt.writes(), 2)
})

test('空输入和无权限不创建；missing状态无副作用，跨主体与绑定漂移不能读取', async t => {
  const f = await fixture(t)
  assert.equal((await f.send({ input: ' ' })).status, 'failed'); assert.equal(f.writes(), 0)
  assert.equal((await f.send({}, caller('C'))).status, 'failed'); assert.equal(f.writes(), 0)
  await assert.rejects(f.status('missing'), error => error.code === 'request_not_found'); assert.equal(f.writes(), 0)
  const sent = await f.send(); await assert.rejects(f.status('send-one', caller('B')), error => error.code === 'request_not_found')
  await assert.rejects(f.send({ sessionId: sent.sessionId, input: '修改' }), error => error.code === 'request_conflict')
  const path = join(f.root, 'config/external-instances.json'), value = JSON.parse(readFileSync(path)); value.instances[0].endpoint += '/changed'; writeFileSync(path, JSON.stringify(value))
  await assert.rejects(f.status(), error => error.code === 'entry_disabled'); assert.equal(f.writes(), 2)
})

test('首次输入非法、入口停用、缺create权限均明确failed且原生HTTP零写，可修正后发送', async t => {
  const invalid = await fixture(t)
  const tooLong = await invalid.send({ input: 'x'.repeat(32001) }); assert.equal(tooLong.status, 'failed'); assert.equal(tooLong.requestId, 'send-one'); assert.match(tooLong.note, /32000/)
  assert.equal((await invalid.send({ sessionId: 'unowned-session' })).status, 'failed'); assert.equal(invalid.writes(), 0)
  assert.equal((await invalid.send()).status, 'running'); assert.equal(invalid.writes(), 2)

  const stopped = await fixture(t)
  registry.mutateExternal(stopped.root, 'disable', { id: 'remote-one', requestId: 'stop-entry', revision: registry.externalInstances(stopped.root).revision })
  assert.equal((await stopped.send()).status, 'failed'); assert.equal(stopped.writes(), 0)
  registry.mutateExternal(stopped.root, 'enable', { id: 'remote-one', requestId: 'restore-entry', revision: registry.externalInstances(stopped.root).revision })
  assert.equal((await stopped.send()).status, 'running'); assert.equal(stopped.writes(), 2)

  const restricted = await fixture(t)
  const actions = registry.externalDetail(restricted.root, 'remote-one').policy.actions
  const setActions = (allowed, suffix) => {
    const detail = registry.externalDetail(restricted.root, 'remote-one')
    registry.mutateExternal(restricted.root, 'save', { agent: detail.agent, instance: detail.instance, policy: { ...detail.policy, actions: allowed }, revision: detail.revision, requestId: 'policy-' + suffix })
    registry.mutateExternal(restricted.root, 'enable', { id: 'remote-one', revision: registry.externalInstances(restricted.root).revision, requestId: 'enable-' + suffix })
  }
  setActions(actions.filter(action => action !== 'session:create'), 'restricted')
  assert.equal((await restricted.send()).status, 'failed'); assert.equal(restricted.writes(), 0)
  setActions(actions, 'restored')
  assert.equal((await restricted.send()).status, 'running'); assert.equal(restricted.writes(), 2)
})

test('prompt已实际执行但首次read连接失败返回unknown并保会话，下次只读恢复', async t => {
  const f = await fixture(t); f.mode('completed')
  f.onRead((path, req, res) => { if (path.endsWith('/message')) { req.socket.destroy(); return false } })
  const result = await f.send(); assert.equal(result.status, 'unknown'); assert.ok(result.sessionId); assert.match(result.note, /读取未完成/); assert.equal(f.writes(), 2)
  const persisted = JSON.parse(readFileSync(join(f.root, '.local/external-instances/sessions.json')))
  assert.equal(persisted.requests.find(row => row.id === 'send-one').state, 'accepted')
  assert.equal(f.sessions.get('session-1').some(row => row.type === 'idle'), true)
  const duplicate = await f.send(); assert.equal(duplicate.status, 'unknown'); assert.equal(duplicate.sessionId, result.sessionId); assert.equal(f.writes(), 2)
  f.onRead(undefined)
  const restored = await f.status(); assert.equal(restored.status, 'completed'); assert.equal(restored.sessionId, result.sessionId); assert.equal(f.writes(), 2)
  assert.equal((await f.send()).status, 'completed'); assert.equal(f.writes(), 2)
})

test('prompt已执行后读取期间入口失效仍为unknown，恢复权限后仅status读取原结果', async t => {
  const f = await fixture(t); f.mode('completed')
  f.onRead(path => { if (path.endsWith('/message')) registry.mutateExternal(f.root, 'disable', { id: 'remote-one', requestId: 'disable-after-prompt', revision: registry.externalInstances(f.root).revision }) })
  const result = await f.send(); assert.equal(result.status, 'unknown'); assert.ok(result.sessionId); assert.deepEqual(result.messages, []); assert.equal(f.writes(), 2)
  f.onRead(undefined)
  registry.mutateExternal(f.root, 'enable', { id: 'remote-one', requestId: 'restore-after-prompt', revision: registry.externalInstances(f.root).revision })
  const restored = await f.status(); assert.equal(restored.status, 'completed'); assert.equal(restored.sessionId, result.sessionId); assert.equal(f.writes(), 2)
})

test('状态读取每个原生异步边界复核风险提供方，不泄漏旧结果', async t => {
  const f = await fixture(t); await f.send(); f.complete('session-1')
  const risk = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, scope: input.scope, level: 'low', expiresAt: new Date(Date.now() + 60000).toISOString(), constraints: { deniedOperations: [] } })) })
  risk.listen(0, '127.0.0.1'); await once(risk, 'listening'); t.after(() => { risk.closeAllConnections(); risk.close() })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path)); config.riskAssessment = { endpoint: `http://127.0.0.1:${risk.address().port}/risk` }; writeFileSync(path, JSON.stringify(config))
  const beforePermissions = f.calls.filter(c => c.path.endsWith('/permission')).length
  f.onRead(pathname => { if (pathname === '/api/session/active') { config.riskAssessment.endpoint += '/changed'; writeFileSync(path, JSON.stringify(config)) } })
  await assert.rejects(f.status(), error => error.code === 'configuration_changed')
  assert.equal(f.calls.filter(c => c.path.endsWith('/permission')).length, beforePermissions); assert.equal(f.writes(), 2)
})

test('prompt风险拒绝后保留已创建会话，回读可确认未派发并复用', async t => {
  const f = await fixture(t); let deny = true
  const risk = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, scope: input.scope, level: 'low', expiresAt: new Date(Date.now() + 60000).toISOString(), constraints: { deniedOperations: deny ? ['session:prompt'] : [] } })) })
  risk.listen(0, '127.0.0.1'); await once(risk, 'listening'); t.after(() => { risk.closeAllConnections(); risk.close() })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path)); config.riskAssessment = { endpoint: `http://127.0.0.1:${risk.address().port}/risk` }; writeFileSync(path, JSON.stringify(config))
  const failed = await f.send(); assert.equal(failed.status, 'failed'); assert.ok(failed.sessionId); assert.equal(f.writes(), 1)
  const read = await f.status(); assert.equal(read.status, 'failed'); assert.equal(read.sessionId, failed.sessionId)
  deny = false; assert.equal((await f.send({ requestId: 'send-two', sessionId: failed.sessionId })).status, 'running'); assert.equal(f.writes(), 2); assert.equal(f.sessions.size, 1)
})

test('保留低层DSH invoke的同步授权复核，投影await后提供方变化不继续派发page', async t => {
  const f = await fixture(t, 'dsh')
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'native-create' }, signal())
  const risk = createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, scope: input.scope, level: 'low', expiresAt: new Date(Date.now() + 60000).toISOString(), constraints: { deniedOperations: [] } })) })
  risk.listen(0, '127.0.0.1'); await once(risk, 'listening'); t.after(() => { risk.closeAllConnections(); risk.close() })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path)); config.riskAssessment = { endpoint: `http://127.0.0.1:${risk.address().port}/risk` }; writeFileSync(path, JSON.stringify(config))
  f.onRead(pathname => { if (pathname.endsWith('/projections')) { config.riskAssessment.endpoint += '/changed'; writeFileSync(path, JSON.stringify(config)) } })
  const read = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:read', sessionId: created.sessionId, requestId: 'native-read' }, signal())
  assert.equal(read.stage, 'unknown'); assert.equal(read.value, undefined)
  assert.equal(f.calls.filter(c => c.path === '/api/session/page').length, 0)
  const state = JSON.parse(readFileSync(join(f.root, '.local/external-instances/sessions.json')))
  assert.equal(state.requests.some(r => r.id === 'native-read'), false)
})

test('规范化严格截至下条user，失败与等待按三框架原生事实表达', () => {
  const oc = (rows, extras = {}) => conversationReply('opencode', 'request', 'user-current', { value: { data: [...rows].reverse() }, ...extras }, true)
  const user = { id: 'user-current', type: 'user', time: { created: 2 } }, later = { id: 'later', type: 'user', time: { created: 3 } }, final = { id: 'answer-later', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'OTHER_TURN' }], time: { created: 4, completed: 4 } }, idle = { id: 'idle', type: 'idle', outcome: 'succeeded', time: { created: 5 } }
  assert.equal(oc([{ ...idle, time: { created: 1 } }, user], { running: true }).status, 'running')
  const bounded = oc([user, later, final, idle]); assert.equal(bounded.status, 'unknown'); assert.deepEqual(bounded.messages, [])
  assert.equal(oc([user, { ...idle, outcome: 'failed' }]).status, 'failed')
  const as = (status, reason) => conversationReply('agentscope', 'request', 'as-user', { status, value: { messages: [{ id: 'old', role: 'assistant', finished_at: '2026-01-01', finished_reason: 'completed' }, { id: 'as-user', role: 'user' }, { id: 'new', role: 'assistant', content: [{ type: 'text', text: 'NEW' }], finished_at: reason ? '2026-01-02' : null, finished_reason: reason }] } }, true)
  assert.equal(as('running', null).status, 'running'); assert.equal(as('awaiting_external_result', null).status, 'waiting'); assert.equal(as('idle', 'error').status, 'failed'); assert.equal(as('idle', null).status, 'unknown')
  const events = [{ type: 'turn/start', seq: 1, data: { turn: 1 } }, { type: 'user/message', seq: 2, data: { source: { kind: 'user', rpcId: 'request' } } }, { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'DSH真实回复' }] } } }, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } }]
  const dsh = rows => conversationReply('dsh', 'request', 'unused', { value: { records: rows.map(event => ({ type: 'event', event })) } }, true)
  assert.equal(dsh(events).status, 'completed'); assert.equal(dsh(events).messages[0].text, 'DSH真实回复')
  assert.equal(dsh([...events.slice(0, 3), { ...events[3], data: { turn: 99, reason: { kind: 'completed' } } }]).status, 'running')
  assert.equal(dsh([...events.slice(0, 3), { ...events[3], data: { turn: 1, reason: { kind: 'blocked' } } }]).status, 'waiting')
  const injected = ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context'].map((kind, index) => ({ type: 'user/message', seq: 2.1 + index / 10, data: { source: { kind } } }))
  assert.equal(dsh([...events, ...injected]).status, 'completed')
  assert.equal(dsh([...events.slice(0, 3), ...injected, { ...events[3], data: { turn: 1, reason: { kind: 'error' } } }]).status, 'failed')
  const nextInput = { type: 'user/message', seq: 2.9, data: { source: { kind: 'user', rpcId: 'later' } } }
  const boundedDsh = dsh([...events, ...injected, nextInput])
  assert.equal(boundedDsh.status, 'unknown'); assert.deepEqual(boundedDsh.messages, [])
})
