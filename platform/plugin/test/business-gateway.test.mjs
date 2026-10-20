import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertGateway from '@deepseek-ai/dsh-api-gateway'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { createRequire } from 'node:module'
import * as Runtime from '../lib/business-runtime.js'
import { getBusinessControl, withBusinessContext, configureBusinessControlStateRoot } from '../lib/business-control.js'
import { signBusinessAssertion, verifyBusinessAssertion, registerBusinessReport, setBusinessReportHeaderResolver, allowedBusinessPath, startBusinessGateway } from '../lib/business-gateway.js'
const wsRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-gateway/package.json'))
const WebSocket = wsRequire('ws')
const NativeRemotes = await import(wsRequire.resolve('@deepseek-ai/dsh-api-remotes'))
const binding = { workspaceId: 'workspace-business-test', agentId: 'soc', instanceId: 'soc-business', runtimeGeneration: 'generation-1', sourceDigest: 'fixed-source-1' }
const identity = id => ({ subject: { id, kind: 'human', identitySource: 'http://identity-fixture.invalid' }, evidence: { issuer: 'http://identity-fixture.invalid', externalSubject: id, method: 'bearer', verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), credentialRef: `credential-${id}` }, expiresAt: new Date(Date.now() + 60000).toISOString() })
const initializers = []
function mark(name, options) { (options ? Remote(options) : Remote(name))(Fixture.prototype[name], { kind: 'method', name, private: false, static: false, addInitializer: fn => initializers.push(fn) }) }
class Fixture extends Service {
  static inject = ['remoteAccess']
  rows = new Map(); seen = []; queued = []; createdRequests = []
  constructor(ctx) { super(ctx, 'sessionFixture'); this.typertRemote = bindTypertRemote(this, 'sessionFixture', { namespace: 'session' }); for (const initialize of initializers) initialize.call(this) }
  create(request) { this.seen.push(this.ctx.invocation.peer.principal.kind); this.createdRequests.push(request); const sessionId = `session-${this.rows.size + 1}`; this.rows.set(sessionId, { sessionId }); return { sessionId } }
  list(request) { return { items: [...this.rows.values()].filter(item => this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId })) } }
  page(request) { return this.rows.get(request.address?.sessionId ?? request.sessionId) }
  updateQueue(request) { this.queued.push(request); return { accepted: true } }
  async *follow(request, signal) { yield { sessionId: request.address?.sessionId ?? request.sessionId, kind: this.ctx.invocation.peer.principal.kind }; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }
}
mark('create'); mark('list'); mark('updateQueue'); mark('page', { resources: { session: request => request.address?.sessionId ?? request.sessionId } }); mark('follow', { mode: 'stream', resources: { session: request => request.address?.sessionId ?? request.sessionId } })
async function setup(t) {
  const assetRoot = mkdtempSync(join(tmpdir(), 'business-native-')); mkdirSync(join(assetRoot, 'config'))
  const revokedSubjects = new Set(), trustDelays = new Map(), trustCalls = new Map()
  const provider = createServer(async (req, res) => {
    let text = ''; for await (const bytes of req) text += bytes
    const input = JSON.parse(text), expiresAt = new Date(Date.now() + 60000).toISOString()
    if (req.url === '/trust') { trustCalls.set(input.subjectId, (trustCalls.get(input.subjectId) || 0) + 1); if (trustDelays.has(input.subjectId)) await new Promise(resolve => setTimeout(resolve, trustDelays.get(input.subjectId))) }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/risk' ? { version: 1, scope: { subjectId: input.subjectId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) }, level: 'low', constraints: { deniedOperations: [] }, expiresAt } : { valid: !revokedSubjects.has(input.subjectId), subjectId: input.subjectId, expiresAt }))
  }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => new Promise(resolve => provider.close(resolve)))
  writeFileSync(join(assetRoot, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, authentication: { endpoint: `http://127.0.0.1:${provider.address().port}/auth` }, identityTrust: { endpoint: `http://127.0.0.1:${provider.address().port}/trust` }, riskAssessment: { endpoint: `http://127.0.0.1:${provider.address().port}/risk` }, operations: [{ serverId: 'writes', operationId: 'update', kind: 'write', method: 'POST', target: 'https://business.test/item', confirmation: true }], agents: [{ agentId: 'soc', enabled: true, sourceDigest: binding.sourceDigest, subjects: ['A', 'B'], actions: ['*'] }] }))
  const secret = randomBytes(48); const secretPath = join(assetRoot, 'business.secret'); writeFileSync(secretPath, secret)
  const ctx = new Context(); t.after(async () => { await ctx.fiber.dispose(); rmSync(assetRoot, { recursive: true, force: true }) })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }); await ctx.plugin(TypertRegistry); ctx.typert.resources.register('session', { field: 'sessionId' }); await ctx.plugin(RemoteAccessService)
  await ctx.plugin({ name: 'fixture-tools', apply(ctx) { ctx.provide('tools', { guard() {} }) } })
  await ctx.plugin(SessionStore); await ctx.plugin(ApprovalService, { policy: 'ask' })
  const workspacePath = join(assetRoot, 'workspace'); mkdirSync(workspacePath)
  const workspaceRows = [{ id: 'native-fixed-workspace', path: workspacePath, title: '固定业务工作区', sessionIds: [], createdAt: Date.now(), updatedAt: Date.now() }, { id: 'native-hidden-workspace', path: join(assetRoot, 'other'), title: 'OTHER_PRIVATE_WORKSPACE', sessionIds: [], createdAt: Date.now(), updatedAt: Date.now() }]
  const workspaceRegistry = { list: () => workspaceRows, resolveByPath: path => workspaceRows.find(item => item.path === path), create() { throw new Error('不应登记其他目录') }, archivedSessionIds: [], pinnedSessionIds: [] }
  await ctx.plugin({ name: 'fixture-workspace-storage', apply(ctx) { ctx.provide('workspaceRegistry', workspaceRegistry) } })
  const centerRoot = join(assetRoot, 'center-assets'); mkdirSync(join(centerRoot, 'config'), { recursive: true }); mkdirSync(join(centerRoot, '.local/instances/soc-business'), { recursive: true }); symlinkSync(join(assetRoot, 'config/business-access.json'), join(centerRoot, 'config/business-access.json')); writeFileSync(join(centerRoot, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: binding.workspaceId })); writeFileSync(join(centerRoot, '.local/instances/soc-business/instance.json'), JSON.stringify({ workspace_id: binding.workspaceId, asset_root: centerRoot, agent_id: binding.agentId, web_base_path: '/agents/soc/', business_control: { runtime_generation: binding.runtimeGeneration, source_digest: binding.sourceDigest, origin: `http://127.0.0.1:${ctx.webServer.port}` } })); const coordinator = getBusinessControl(centerRoot); coordinator.registerInstance(binding); const gateway = await startBusinessGateway(centerRoot, { host: '127.0.0.1', port: 0, publicOrigin: 'http://business.localhost:0', sharedSecretFile: secretPath, instances: [{ agentId: binding.agentId, instanceId: binding.instanceId }] }); t.after(() => gateway.close())
  const loaded = ctx.plugin(Runtime, { assetRoot, stateRoot: join(assetRoot, 'runtime-state'), sharedSecretFile: secretPath, coordinatorOrigin: `http://127.0.0.1:${gateway.server.address().port}`, workspacePath, binding }); await loaded
  await ctx.get('connection').refresh(); await ctx.get('connection').refresh()
  assert.equal(loaded.state, 2)
  await ctx.plugin(TypertGateway, {}); await ctx.plugin(WorkspaceController); await ctx.plugin(Fixture); const fixture = ctx.get('sessionFixture'); const control = getBusinessControl(assetRoot)
  const context = id => { const value = identity(id); value.subject.identitySource = `http://127.0.0.1:${provider.address().port}`; value.evidence.issuer = value.subject.identitySource; return control.createContext(value, binding) }
  const headers = (id, path, method = 'POST') => signBusinessAssertion(secret, { binding, context: context(id), snapshot: coordinator.issueSnapshot(binding.instanceId), nonce: randomBytes(24).toString('base64url'), issuedAt: Date.now() }, method, path)
  const rpc = async (id, endpoint, request) => { const path = `/api/${endpoint}`; return fetch(`http://127.0.0.1:${ctx.webServer.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers(id, path) }, body: JSON.stringify({ type: 'client-request', rpcId: randomBytes(8).toString('hex'), method: endpoint, payload: { args: { request } } }) }) }
  return { ctx, control, fixture, headers, rpc, context, secret, coordinator, workspacePath, workspaceRows, workspaceRegistry, trustCalls, delayTrust: (id, delay) => trustDelays.set(id, delay), revoke: id => revokedSubjects.add(id) }
}
test('原生 Connection/Remote/Gateway 非 owner 创建持久归属并隔离列表和历史', async t => {
  const { rpc, fixture, ctx, context } = await setup(t); const a = await (await rpc('A', 'session/create', { workspaceId: 'untrusted-workspace', cwd: '/etc', agentPreset: 'untrusted-preset' })).json(); const b = await (await rpc('B', 'session/create', {})).json()
  assert.equal(a.result.ok, true, JSON.stringify(a)); assert.equal(b.result.ok, true, JSON.stringify(b)); assert.deepEqual(fixture.seen, ['harness-business', 'harness-business'])
  assert.deepEqual(fixture.createdRequests[0], { workspaceId: 'native-fixed-workspace' }); assert.equal(ctx.get('remoteAccess').decide({ principal: { kind: 'harness-business', context: context('A') }, action: 'session/create', resources: [{ kind: 'workspace', id: 'native-hidden-workspace' }], args: { request: { workspaceId: 'native-hidden-workspace' } } }).kind, 'deny')
  const mine = await (await rpc('A', 'session/list', {})).json(); assert.equal(mine.result.ok, true, JSON.stringify(mine)); assert.deepEqual(mine.result.value.items.map(item => item.sessionId), [a.result.value.sessionId])
  assert.equal((await rpc('A', 'session/page', { sessionId: b.result.value.sessionId })).status, 403)
  const own = await (await rpc('A', 'session/page', { sessionId: a.result.value.sessionId })).json(); assert.equal(own.result.value.sessionId, a.result.value.sessionId)
  const ownAddress = await (await rpc('A', 'session/page', { address: { kind: 'session', sessionId: a.result.value.sessionId } })).json(); assert.equal(ownAddress.result.value.sessionId, a.result.value.sessionId)
  assert.equal((await rpc('A', 'session/page', { address: { kind: 'session', sessionId: b.result.value.sessionId } })).status, 403)
  assert.equal((await rpc('A', 'session/page', { address: { kind: 'subagent', sessionId: a.result.value.sessionId, subagentId: 'unopened' } })).status, 403)
})
test('原生 remote.mux WebSocket使用非 owner Peer，未归属 Session 没有流数据', async t => {
  const { ctx, headers, rpc } = await setup(t); const a = await (await rpc('A', 'session/create', {})).json(); const b = await (await rpc('B', 'session/create', {})).json(); const path = '/api/remote.mux'
  const events = []; let wake
  ctx.effect(() => ctx.get('typertGateway').registerRemoteEvents(async function* (signal) { while (!signal.aborted) { while (events.length) yield events.shift(); await new Promise(resolve => { wake = resolve; signal.addEventListener('abort', resolve, { once: true }) }) } }, { home: '/native-fixture' }), 'native event ready fixture')
  const socket = new WebSocket(`ws://127.0.0.1:${ctx.webServer.port}${path}`, { headers: headers('A', path, 'GET') }); await once(socket, 'open'); t.after(() => socket.terminate())
  const received = []; socket.on('message', data => received.push(JSON.parse(data.toString())))
  socket.send(JSON.stringify({ type: 'open', streamId: 'generation', endpoint: '$events', payload: { args: {} } }))
  for (const [streamId, sessionId] of [['own', a.result.value.sessionId], ['other', b.result.value.sessionId]]) socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }))
  const limit = Date.now() + 1000; while (received.length < 3 && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(received.some(frame => frame.type === 'item' && frame.streamId === 'generation' && frame.value.type === 'ready'), JSON.stringify(received)); assert.equal(ctx.get('typertGateway').hasLiveClient(), false)
  for (const [sessionId, message] of [[a.result.value.sessionId, 'A_VISIBLE_EVENT'], [b.result.value.sessionId, 'B_PRIVATE_EVENT']]) events.push({ event: 'api-session/error', args: [sessionId, message], resources: { session: id => id } }); wake?.()
  const eventLimit = Date.now() + 1000; while (!received.some(frame => frame.value?.type === 'emit') && Date.now() < eventLimit) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(received.some(frame => frame.value?.type === 'emit' && frame.value.args[1] === 'A_VISIBLE_EVENT'), JSON.stringify(received)); assert.ok(!received.some(frame => frame.value?.type === 'emit' && frame.value.args[1] === 'B_PRIVATE_EVENT'))
  assert.ok(received.some(frame => frame.type === 'item' && frame.streamId === 'own' && frame.value.kind === 'harness-business'), JSON.stringify(received)); assert.ok(received.some(frame => frame.type === 'error' && frame.streamId === 'other'), JSON.stringify(received)); assert.ok(!received.some(frame => frame.type === 'item' && frame.streamId === 'other'))
  socket.close(); await once(socket, 'close')
})
test('原生工作区仅登记服务端固定目录，创建回执与follow均过滤本人Session', async t => {
  const { ctx, headers, rpc, workspacePath, workspaceRows, workspaceRegistry } = await setup(t)
  const a = await (await rpc('A', 'session/create', {})).json(), b = await (await rpc('B', 'session/create', {})).json(), ownId = a.result.value.sessionId, otherId = b.result.value.sessionId
  workspaceRows[0].sessionIds = [ownId, otherId]; workspaceRegistry.archivedSessionIds.push(ownId, otherId); workspaceRegistry.pinnedSessionIds.push(ownId, otherId)
  for (const [subject, sessionId] of [['A', ownId], ['B', otherId]]) { const registered = await (await rpc(subject, 'workspace/create', { path: workspacePath })).json(); assert.equal(registered.result.ok, true, JSON.stringify(registered)); assert.deepEqual(registered.result.value.workspace.sessionIds, [sessionId]); assert.equal(registered.result.value.created, false) }
  assert.equal((await rpc('A', 'workspace/create', { path: '/etc' })).status, 403); assert.equal((await rpc('A', 'workspace/create', { path: workspacePath, title: '不可更改' })).status, 403)
  const path = '/api/remote.mux', socket = new WebSocket(`ws://127.0.0.1:${ctx.webServer.port}${path}`, { headers: headers('A', path, 'GET') }); await once(socket, 'open'); t.after(() => socket.terminate())
  const received = []; socket.on('message', data => received.push(JSON.parse(data.toString()))); socket.send(JSON.stringify({ type: 'open', streamId: 'workspace', endpoint: 'workspace/follow', payload: { args: {} } }))
  const limit = Date.now() + 1000; while (!received.length && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10))
  const baseline = received.find(frame => frame.type === 'item')?.value; assert.equal(baseline?.type, 'baseline', JSON.stringify(received)); assert.deepEqual(baseline.value.items.map(item => item.workspaceId), ['native-fixed-workspace']); assert.deepEqual(baseline.value.items[0].sessionIds, [ownId]); assert.deepEqual(baseline.value.archivedSessionIds, [ownId]); assert.deepEqual(baseline.value.pinnedSessionIds, [ownId]); assert.ok(!JSON.stringify(baseline).includes('OTHER_PRIVATE_WORKSPACE'))
  socket.close(); await once(socket, 'close')
})
test('慢用户信任复核按凭据去重，撤销只关闭本人Peer且不拖住Agent续租与其他用户', async t => {
  const { ctx, control, context, secret, coordinator, trustCalls, delayTrust, revoke } = await setup(t), connection = ctx.get('connection')
  const a = context('A'), b = context('B'), path = '/api/remote.mux'
  const admit = context => { const admitted = connection.admit({ method: 'GET', url: path, headers: signBusinessAssertion(secret, { binding, context, snapshot: coordinator.issueSnapshot(binding.instanceId), issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') }, 'GET', path) }); assert.ok(!('rejection' in admitted)); return admitted.peer }
  delayTrust('A', 850); revoke('A')
  const peersA = [admit(a), admit(a), admit(a)], peerB = admit(b), before = trustCalls.get('A') || 0
  await connection.refresh()
  // 覆盖一次2秒许可周期；旧串行实现会因三次慢A复核让B一起失去许可。
  await new Promise(resolve => setTimeout(resolve, 2200))
  assert.equal(trustCalls.get('A') - before, 1); assert.ok(peersA.every(peer => peer.signal.aborted)); assert.equal(peerB.signal.aborted, false)
  assert.equal(control.assert(b, 'agent:access', [{ kind: 'agent', id: binding.agentId }]).kind, 'allow'); assert.equal(control.agentStatus(binding.instanceId).authentication.status, 'verified')
})
test('签名绑定方法、路径、实例代次与有效期，拒绝重放', () => {
  const secret = randomBytes(48), issuedAt = Date.now(), assertion = { binding, snapshot: {}, issuedAt, nonce: randomBytes(24).toString('base64url') }, headers = signBusinessAssertion(secret, assertion, 'POST', '/api/session/create')
  assert.equal(verifyBusinessAssertion(secret, headers, 'POST', '/api/session/create', binding, new Map()).nonce, assertion.nonce)
  for (const [method, path, receiver, now] of [['GET', '/api/session/create', binding, issuedAt], ['POST', '/api/session/page', binding, issuedAt], ['POST', '/api/session/create', { ...binding, runtimeGeneration: 'other' }, issuedAt], ['POST', '/api/session/create', binding, issuedAt + 2001]]) assert.throws(() => verifyBusinessAssertion(secret, headers, method, path, receiver, new Map(), now))
  const seen = new Map(); verifyBusinessAssertion(secret, headers, 'POST', '/api/session/create', binding, seen); assert.throws(() => verifyBusinessAssertion(secret, headers, 'POST', '/api/session/create', binding, seen))
})
test('首期业务 Profile停用定时投递和任意Shell并保留HOME数据', () => {
  const patch = Runtime.createBusinessRuntimePatch({ binding }, '/runtime.js'); for (const id of ['schedule', 'ui-schedule', 'tool-schedule', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-web', 'connection']) assert.ok(patch.some(item => item.id === id && item.disabled))
  const client = patch.flatMap(item => item.insert ?? []).find(item => item.id === 'business-client-connection'); assert.equal(client.name, '/opt/dsh/packages/client/connection/lib/client.node.js'); assert.deepEqual(client.isolate, { connection: true })
})


test('原生 ApprovalService 暂停同一次调用，B不能回答A的确认且确认后只派发一次', async t => {
  const { ctx, control, headers, rpc, context, coordinator } = await setup(t)
  // 真实原生瀑布桥先注册；业务answerer须优先处理自己冻结的请求，不能等owner回答。
  await ctx.plugin(NativeRemotes)
  await ctx.plugin({ name: 'late-business-approval', inject: ['connection', 'webServer', 'approval'], apply(ctx) {
    const adapter = Runtime.createBusinessApprovalAdapter(ctx, control)
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/business-control/confirmations', handler: async (req, res) => {
      const admitted = ctx.get('connection').admit(req)
      if ('rejection' in admitted) { res.writeHead(admitted.rejection); res.end(); return }
      try { await adapter.handle(req, res, admitted.peer.principal.context) } finally { await admitted.peer.dispose() }
    } }), 'late business confirmation HTTP fixture')
  } })
  const created = await (await rpc('A', 'session/create', {})).json(); const sessionId = created.result.value.sessionId
  const session = ctx.get('sessions').create(SessionId(sessionId)); session.append('turn/start', { turn: 1 }); const agent = { id: sessionId, session, ctx }
  await ctx.waterfall('tools/pre-execute', { agent }, async () => undefined)
  const owner = control.sessionContext(context('A'), sessionId); const operation = { serverId: 'writes', operationId: 'update', kind: 'write', method: 'POST', target: 'https://business.test/item', args: { value: 'fixed' } }; let dispatched = 0
  const execution = withBusinessContext(owner, () => control.execute(operation, () => { dispatched++; return 'done' }))
  const path = '/api/business-control/confirmations'; const endpoint = `http://127.0.0.1:${ctx.webServer.port}${path}`
  const list = async id => (await fetch(endpoint, { headers: headers(id, path, 'GET') })).json()
  let pending; const until = Date.now() + 1000; while (!pending && Date.now() < until) { pending = (await list('A')).items[0]; if (!pending) await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.ok(pending); assert.equal(dispatched, 0); assert.deepEqual((await list('B')).items, [])
  assert.ok(coordinator.status().riskFacts.some(fact => fact.scope.sessionId === sessionId && fact.source.endsWith('/risk')), '展示确认之前本次风险事实必须已同步到中心')
  // 模拟本人阅读目标后作答，覆盖本地新事实观察及ACK的两个实际心跳周期。
  await new Promise(resolve => setTimeout(resolve, 1200)); assert.ok((await list('A')).items.some(item => item.id === pending.id)); assert.equal(dispatched, 0)
  const answer = (id, allow) => fetch(endpoint, { method: 'POST', headers: { ...headers(id, path), 'content-type': 'application/json' }, body: JSON.stringify({ id: pending.id, allow }) })
  assert.equal((await answer('B', true)).status, 403); assert.equal(dispatched, 0)
  assert.equal((await answer('A', true)).status, 200); assert.equal(await execution, 'done'); assert.equal(dispatched, 1)
  const audit = session.snapshotEvents().filter(event => event.type.startsWith('approval/')); assert.deepEqual(audit.map(event => event.type), ['approval/asked', 'approval/decided']); assert.equal(audit[1].data.outcome, 'allowed-once')
  assert.equal((await answer('A', true)).status, 403)
})


test('受控报告首次读取、重读和下载均检查归属与最新限制，拒绝内容不流给用户', async t => {
  const { ctx, control, headers, rpc, context, coordinator } = await setup(t); const created = await (await rpc('A', 'session/create', {})).json(); const sessionId = created.result.value.sessionId
  let requested = 0, content = '<html><body>正常报告</body></html>'
  const upstream = createServer((req, res) => { requested++; assert.equal(req.headers['x-test-run-id'], 'reports-fixture'); res.setHeader('content-type', 'text/html'); res.end(content) }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => new Promise(resolve => upstream.close(resolve)))
  const origin = `http://127.0.0.1:${upstream.address().port}`, owner = control.sessionContext(context('A'), sessionId)
  const configPath = join(control.assetRoot, 'config/business-access.json'), config = JSON.parse(readFileSync(configPath, 'utf8')); config.operations.push({ serverId: 'reports', operationId: 'publish', kind: 'publish', method: 'POST', target: origin + '/publish' }, { serverId: 'reports', operationId: 'download-report', kind: 'publish', method: 'GET', target: origin + '/reports/{reportFile}' }); writeFileSync(configPath, JSON.stringify(config))
  t.after(setBusinessReportHeaderResolver(control.assetRoot, serverId => { assert.equal(serverId, 'reports'); return { headers: { 'X-Test-Run-Id': 'reports-fixture' }, assertCurrent() {} } }))
  // 报告引用只能在真实发布检测通过后登记，夹具同样经HTTP风险提供方取得有效事实。
  await control.inspect({ ...owner, scope: { ...owner.scope, serverId: 'reports' } }, 'report', content)
  const download = registerBusinessReport(control.assetRoot, owner, origin + '/reports/fixture.html', origin, { serverId: 'reports' }); const path = download.replace('/agents/soc', '')
  const get = id => fetch(`http://127.0.0.1:${ctx.webServer.port}${path}`, { headers: headers(id, path, 'GET') })
  assert.equal((await get('B')).status, 403); assert.equal(requested, 0)
  const first = await get('A'); assert.equal(first.status, 200); assert.match(await first.text(), /正常报告/); assert.match(first.headers.get('content-disposition'), /attachment/); assert.equal(requested, 1)
  config.detection = { reportMarkers: ['SYNTHETIC-BLOCK'] }; writeFileSync(configPath, JSON.stringify(config)); content = '<html>SYNTHETIC-BLOCK</html>'; const blocked = await get('A'); assert.equal(blocked.status, 403); assert.ok(!(await blocked.text()).includes('SYNTHETIC-BLOCK')); assert.equal(requested, 2)
  content = '<html>恢复正常报告</html>'; assert.equal((await get('A')).status, 200); assert.equal(requested, 3)
  coordinator.updateRestriction({ scope: { workspaceId: binding.workspaceId, agentId: binding.agentId, subjectId: 'A' }, deniedActions: ['publish'], active: true, reason: 'test' }); control.acceptSnapshot(coordinator.issueSnapshot(binding.instanceId))
  assert.equal((await get('A')).status, 403); assert.equal(requested, 3)
  assert.throws(() => registerBusinessReport(control.assetRoot, owner, 'https://elsewhere.test/reports/f.html', origin))
})

test('网关未开放原生插件任意HTTP、Shell、定时任务及owner握手入口', () => {
  for (const path of ['/api/files/download', '/api/schedule/list', '/api/remoteEvents/result', '/api/$events/result', '/connect', '/download', '/api/mcp-manager']) assert.equal(allowedBusinessPath(path, 'POST', 'http'), false)
  assert.equal(allowedBusinessPath('/api/remote.mux', 'GET', 'websocket'), true); assert.equal(allowedBusinessPath('/api/session/page', 'POST', 'http'), true)
})


test('独立业务监听真实认证和代理，清除自报主体及凭据，开放资格与基础权限分别生效', async t => {
  const assetRoot = mkdtempSync(join(tmpdir(), 'business-frontdoor-')); t.after(() => rmSync(assetRoot, { recursive: true, force: true })); mkdirSync(join(assetRoot, 'config')); mkdirSync(join(assetRoot, '.local/instances/soc-business'), { recursive: true }); writeFileSync(join(assetRoot, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: binding.workspaceId }))
  const provider = createServer(async (req, res) => { let text = ''; for await (const bytes of req) text += bytes; const input = JSON.parse(text), expiresAt = new Date(Date.now() + 60000).toISOString(); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url === '/auth' ? { authenticated: input.credential === 'A', subjectId: 'A', credentialId: 'fixture-A', expiresAt } : { valid: true, subjectId: input.subjectId, expiresAt })) }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => new Promise(resolve => provider.close(resolve)))
  const config = { schemaVersion: 1, enabled: true, authentication: { endpoint: `http://127.0.0.1:${provider.address().port}/auth` }, identityTrust: { endpoint: `http://127.0.0.1:${provider.address().port}/trust` }, agents: [{ agentId: 'soc', enabled: true, sourceDigest: binding.sourceDigest, subjects: ['A'], actions: ['*'] }, { agentId: 'hidden-agent', enabled: true, subjects: ['B'], actions: ['*'] }] }; const save = () => writeFileSync(join(assetRoot, 'config/business-access.json'), JSON.stringify(config)); save()
  const secret = randomBytes(48), secretPath = join(assetRoot, 'business.secret'); writeFileSync(secretPath, secret); const seen = new Map()
  const upstream = createServer((req, res) => { try { const assertion = verifyBusinessAssertion(secret, req.headers, req.method, req.url, binding, seen); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ subjectId: assertion.context.subject.id, rawCredential: !!req.headers.authorization, path: req.url })) } catch { res.writeHead(403); res.end() } }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => new Promise(resolve => upstream.close(resolve)))
  writeFileSync(join(assetRoot, '.local/instances/soc-business/instance.json'), JSON.stringify({ workspace_id: binding.workspaceId, asset_root: assetRoot, agent_id: 'soc', web_base_path: '/agents/soc/', business_control: { runtime_generation: binding.runtimeGeneration, source_digest: binding.sourceDigest, origin: `http://127.0.0.1:${upstream.address().port}` } }))
  const gateway = await startBusinessGateway(assetRoot, { host: '127.0.0.1', port: 0, publicOrigin: 'http://business.localhost:0', sharedSecretFile: secretPath, instances: [{ agentId: 'soc', instanceId: 'soc-business' }, { agentId: 'hidden-agent', instanceId: 'hidden-instance' }] }); t.after(() => gateway.close()); const frontFetch = (url, options) => new Promise((resolve, reject) => { const request = httpRequest(url, options, response => { const chunks = []; response.on('data', data => chunks.push(data)); response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers }))) }); request.on('error', reject); request.end() }); const origin = `http://127.0.0.1:${gateway.server.address().port}`, path = '/agents/soc/api/session/list', headers = { host: 'business.localhost:0' }
  let runtimeSnapshot; for (let round = 0; round < 2; round++) { const assertion = { binding, ...(runtimeSnapshot ? { snapshot: runtimeSnapshot } : {}), issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') }; const response = await fetch(origin + '/control/' + binding.instanceId, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signBusinessAssertion(secret, assertion, 'POST', '/control/' + binding.instanceId)) }); assert.equal(response.status, 200); runtimeSnapshot = verifyBusinessAssertion(secret, await response.json(), 'RESPONSE', '/control/' + binding.instanceId, binding, new Map()).snapshot }
  const loggedOutPage = await (await frontFetch(origin + '/', { method: 'GET', headers })).text(); assert.ok(!loggedOutPage.includes('/agents/soc/')); assert.ok(!loggedOutPage.includes('/agents/hidden-agent/')); assert.match(loggedOutPage, /手动启动/); const center = getBusinessControl(assetRoot); for (const who of ['A', 'B']) center.updateRisk({ id: `homepage-risk-${who}`, version: 1, scope: { workspaceId: binding.workspaceId, agentId: binding.agentId, subjectId: who }, status: 'assessed', source: 'fixture-source', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), signals: [{ code: 'fixture-evidence', value: who, reason: who === 'A' ? '<script>risk-xss</script>' : 'B_PRIVATE_EVIDENCE' }] }); const ownDirectory = await (await frontFetch(origin + '/', { method: 'GET', headers: { ...headers, authorization: 'Bearer A' } })).text(); for (const label of ['智能体身份', '风险评估', '访问控制', '自动触发', 'Agent认证方式', '可信来源核验状态', 'hmac-sha256', '当前访问者']) assert.ok(ownDirectory.includes(label)); assert.ok(ownDirectory.includes('&lt;script&gt;risk-xss&lt;/script&gt;')); assert.ok(!ownDirectory.includes('<script>risk-xss</script>')); assert.ok(!ownDirectory.includes('B_PRIVATE_EVIDENCE')); assert.ok(ownDirectory.includes('/agents/soc/')); assert.ok(!ownDirectory.includes('/agents/hidden-agent/'));
  assert.equal((await frontFetch(origin + path, { method: 'POST', headers })).status, 401)
  assert.equal((await frontFetch(origin + path, { method: 'POST', headers: { ...headers, authorization: 'Bearer bad', 'x-harness-business-context': 'forged' } })).status, 401)
  const valid = await frontFetch(origin + path, { method: 'POST', headers: { ...headers, authorization: 'Bearer A', 'x-harness-business-context': 'forged' } }); assert.equal(valid.status, 200); assert.deepEqual(await valid.json(), { subjectId: 'A', rawCredential: false, path })
  const login = await frontFetch(origin + '/session', { method: 'POST', headers: { ...headers, authorization: 'Bearer A' } }); assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await frontFetch(origin + path, { method: 'POST', headers: { ...headers, cookie } })).status, 200)
  assert.equal((await frontFetch(origin + '/session', { method: 'DELETE', headers: { ...headers, cookie } })).status, 200); assert.equal((await frontFetch(origin + path, { method: 'POST', headers: { ...headers, cookie } })).status, 401)
  config.agents[0].agentTrust = { enabled: false }; save()
  const revokedHome = await frontFetch(origin + '/', { method: 'GET', headers: { ...headers, authorization: 'Bearer A' } }); assert.equal(revokedHome.status, 200); const revokedHtml = await revokedHome.text(); assert.match(revokedHtml, /身份已撤销/); assert.match(revokedHtml, /agent_trust_revoked/); assert.ok(!revokedHtml.includes('href="/agents/soc/"')); for (const label of ['智能体身份', '风险评估', '访问控制']) assert.ok(revokedHtml.includes(label))
  assert.equal((await frontFetch(origin + path, { method: 'POST', headers: { ...headers, authorization: 'Bearer A' } })).status, 503)
  config.agents[0].agentTrust.enabled = true; save()
  config.agents[0].enabled = false; save(); assert.equal((await frontFetch(origin + path, { method: 'POST', headers: { ...headers, authorization: 'Bearer A' } })).status, 403)
  config.agents[0].enabled = true; config.agents[0].subjects = ['B']; save(); assert.equal((await frontFetch(origin + path, { method: 'POST', headers: { ...headers, authorization: 'Bearer A' } })).status, 403)
})


async function reportFixture(t) {
  const setupResult = await setup(t), { ctx, control, rpc, headers, context } = setupResult
  const created = await (await rpc('A', 'session/create', {})).json(), owner = control.sessionContext(context('A'), created.result.value.sessionId)
  let requested = 0, release; const gate = new Promise(resolve => { release = resolve }); let arrived; const arrival = new Promise(resolve => { arrived = resolve })
  const upstream = createServer(async (req, res) => { requested++; arrived(); await gate; res.setHeader('content-type', 'text/html'); res.end('<html>PRIVATE-REPORT-BODY</html>') }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => { release(); return new Promise(resolve => upstream.close(resolve)) })
  const origin = `http://127.0.0.1:${upstream.address().port}`, configPath = join(control.assetRoot, 'config/business-access.json'), config = JSON.parse(readFileSync(configPath, 'utf8')); config.operations.push({ serverId: 'reports', operationId: 'download-report', kind: 'publish', method: 'GET', target: origin + '/reports/{reportFile}' }); writeFileSync(configPath, JSON.stringify(config))
  let connectionCurrent = true
  t.after(setBusinessReportHeaderResolver(control.assetRoot, () => ({ headers: {}, assertCurrent() { if (!connectionCurrent) throw new Error('报告连接已停用或变化') } })))
  await control.inspect({ ...owner, scope: { ...owner.scope, serverId: 'reports' } }, 'report', '<html>PRIVATE-REPORT-BODY</html>')
  const path = registerBusinessReport(control.assetRoot, owner, origin + '/reports/private.html', origin, { serverId: 'reports' }).replace('/agents/soc', '')
  const get = () => fetch(`http://127.0.0.1:${ctx.webServer.port}${path}`, { headers: headers('A', path, 'GET') })
  const coordinator = setupResult.coordinator
  return { ...setupResult, get, release, arrival, requested: () => requested, coordinator, invalidateConnection: () => { connectionCurrent = false } }
}

test('报告服务范围撤权在下载前阻止上游，等待中撤权不释放正文', async t => {
  const { control, coordinator, get, arrival, release, requested } = await reportFixture(t)
  const restriction = coordinator.updateRestriction({ scope: { workspaceId: binding.workspaceId, agentId: binding.agentId, subjectId: 'A', serverId: 'reports' }, deniedActions: ['publish'], active: true, reason: 'server-scope-test' }); control.acceptSnapshot(coordinator.issueSnapshot(binding.instanceId))
  assert.equal((await get()).status, 403); assert.equal(requested(), 0)
  coordinator.updateRestriction({ ...restriction, active: false }); control.acceptSnapshot(coordinator.issueSnapshot(binding.instanceId))
  const downloading = get(); await arrival; coordinator.updateRestriction({ ...restriction, active: true }); control.acceptSnapshot(coordinator.issueSnapshot(binding.instanceId)); release()
  const blocked = await downloading; assert.equal(blocked.status, 403); assert.ok(!(await blocked.text()).includes('PRIVATE-REPORT-BODY')); assert.equal(requested(), 1)
})

test('报告身份撤销在上游读取前与正文释放前均重新验证', async t => {
  const first = await reportFixture(t); first.revoke('A'); assert.equal((await first.get()).status, 403); assert.equal(first.requested(), 0); first.release()
  const second = await reportFixture(t); const downloading = second.get(); await second.arrival; second.revoke('A'); second.release(); const blocked = await downloading; assert.equal(blocked.status, 403); assert.ok(!(await blocked.text()).includes('PRIVATE-REPORT-BODY')); assert.equal(second.requested(), 1)
})


test('公开入箱共同检测覆盖队列编辑且创建不能夹带初始消息，拒绝发生在原生处理器前', async t => {
  const { rpc, control, fixture } = await setup(t); const created = await (await rpc('A', 'session/create', {})).json(), sessionId = created.result.value.sessionId
  const configPath = join(control.assetRoot, 'config/business-access.json'), config = JSON.parse(readFileSync(configPath, 'utf8')); config.detection = { inputMarkers: ['MOCK_CONTROL_DENY_INPUT'] }; writeFileSync(configPath, JSON.stringify(config))
  assert.equal((await rpc('A', 'session/updateQueue', { sessionId, itemId: 'queued-1', action: { kind: 'edit', content: [{ type: 'text', text: 'MOCK_CONTROL_DENY_INPUT' }] } })).status, 403); assert.equal(fixture.queued.length, 0)
  const safe = await (await rpc('A', 'session/updateQueue', { sessionId, itemId: 'queued-1', action: { kind: 'edit', content: [{ type: 'text', text: '正常编辑内容' }] } })).json(); assert.equal(safe.result.ok, true); assert.equal(fixture.queued.length, 1)
  const removed = await (await rpc('A', 'session/updateQueue', { sessionId, itemId: 'queued-1', action: { kind: 'remove' } })).json(); assert.equal(removed.result.ok, true); assert.equal(fixture.queued.length, 2)
  assert.equal((await rpc('A', 'session/create', { content: [{ type: 'text', text: 'MOCK_CONTROL_DENY_INPUT' }] })).status, 403); assert.equal(fixture.seen.length, 1)
})

test('恢复队列在原生agent/created串行接缝检测失败，不清除旧输入', async t => {
  const { ctx, control, rpc } = await setup(t); const created = await (await rpc('A', 'session/create', {})).json(), sessionId = created.result.value.sessionId
  const configPath = join(control.assetRoot, 'config/business-access.json'), config = JSON.parse(readFileSync(configPath, 'utf8')); config.detection = { inputMarkers: ['MOCK_CONTROL_DENY_INPUT'] }; writeFileSync(configPath, JSON.stringify(config))
  const original = [{ content: [{ type: 'text', text: 'MOCK_CONTROL_DENY_INPUT' }] }], agent = { session: { id: sessionId }, inbox: { nextTurn: original, nextStep: [] } }
  await assert.rejects(ctx.serial('agent/created', { agent, source: 'resume' })); assert.deepEqual(agent.inbox.nextTurn, original)
  await assert.rejects(ctx.serial('agent/created', { agent: { session: { id: 'unassigned-history' }, inbox: { nextTurn: [{ content: [{ type: 'text', text: '正常历史输入' }] }], nextStep: [] } }, source: 'resume' }))
})


test('两个独立状态根经真实控制HTTP同步Session、检测事实、限制与实际版本回执', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-replica-http-')), centerRoot = join(root, 'center'), replicaRoot = join(root, 'replica'); mkdirSync(join(centerRoot, 'config'), { recursive: true }); mkdirSync(join(replicaRoot, 'config'), { recursive: true }); mkdirSync(join(centerRoot, '.local/instances/soc-business'), { recursive: true }); t.after(() => rmSync(root, { recursive: true, force: true }))
  const provider = createServer(async (req, res) => { let text = ''; for await (const bytes of req) text += bytes; const input = JSON.parse(text); res.setHeader('content-type', 'application/json'); const expiresAt = new Date(Date.now() + 60000).toISOString(); res.end(JSON.stringify(req.url === '/risk' ? { version: 1, scope: { subjectId: input.subjectId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) }, level: 'low', constraints: { deniedOperations: [] }, expiresAt } : { valid: true, subjectId: input.subjectId, expiresAt })) }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => new Promise(resolve => provider.close(resolve))); const providerOrigin = `http://127.0.0.1:${provider.address().port}`
  const config = { schemaVersion: 1, enabled: true, authentication: { endpoint: providerOrigin + '/auth' }, identityTrust: { endpoint: providerOrigin + '/trust' }, riskAssessment: { endpoint: providerOrigin + '/risk' }, agents: [{ agentId: 'soc', enabled: true, sourceDigest: binding.sourceDigest, subjects: ['A', 'B'], actions: ['*'] }], detection: { inputMarkers: ['MOCK_CONTROL_DENY_INPUT'] } }; writeFileSync(join(centerRoot, 'config/business-access.json'), JSON.stringify(config)); symlinkSync(join(centerRoot, 'config/business-access.json'), join(replicaRoot, 'config/business-access.json')); writeFileSync(join(centerRoot, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: binding.workspaceId }))
  const secret = randomBytes(48), secretPath = join(root, 'business.secret'); writeFileSync(secretPath, secret); writeFileSync(join(centerRoot, '.local/instances/soc-business/instance.json'), JSON.stringify({ workspace_id: binding.workspaceId, asset_root: centerRoot, agent_id: binding.agentId, web_base_path: '/agents/soc/', business_control: { runtime_generation: binding.runtimeGeneration, source_digest: binding.sourceDigest, origin: 'http://127.0.0.1:1' } }))
  const center = getBusinessControl(centerRoot); center.registerInstance(binding); const gateway = await startBusinessGateway(centerRoot, { host: '127.0.0.1', port: 0, publicOrigin: 'http://business.localhost:0', sharedSecretFile: secretPath, instances: [{ agentId: binding.agentId, instanceId: binding.instanceId }] }); t.after(() => gateway.close())
  const replica = configureBusinessControlStateRoot(replicaRoot, join(root, 'runtime-state')), ctx = new Context(); t.after(() => ctx.fiber.dispose()); let connection
  await ctx.plugin({ name: 'replica-connection-test', apply(ctx) { connection = new Runtime.BusinessConnection(ctx, { assetRoot: replicaRoot, stateRoot: join(root, 'runtime-state'), sharedSecretFile: secretPath, coordinatorOrigin: `http://127.0.0.1:${gateway.server.address().port}`, binding }, replica) } })
  await connection.refresh(); await connection.refresh()
  const credential = identity('A'); credential.subject.identitySource = providerOrigin; credential.evidence.issuer = providerOrigin; const context = center.createContext(credential, binding), snapshot = center.issueSnapshot(binding.instanceId)
  const admitted = connection.admit({ method: 'POST', url: '/api/session/create', headers: signBusinessAssertion(secret, { binding, context, snapshot, issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') }, 'POST', '/api/session/create') }); assert.ok(!('rejection' in admitted)); await admitted.peer.dispose()
  const session = replica.bindSession(context, 'replica-created-session'); assert.equal(center.contextForSession(session.scope.sessionId), undefined); await connection.refresh(); assert.equal(center.contextForSession(session.scope.sessionId).subject.id, 'A')
  await assert.rejects(replica.inspect(session, 'input', 'MOCK_CONTROL_DENY_INPUT')); const startedAt = Date.now(); await connection.refresh(); assert.ok(center.status().riskFacts.some(fact => fact.scope.sessionId === session.scope.sessionId && fact.source === 'local-input-marker')); assert.equal(center.status().instances[0].applied, false); await connection.refresh(); assert.equal(center.status().instances[0].applied, true); assert.ok(Date.now() - startedAt < 2000)
  const restriction = center.updateRestriction({ scope: { workspaceId: binding.workspaceId, agentId: binding.agentId, subjectId: 'A', sessionId: session.scope.sessionId }, deniedActions: ['write'], active: true, reason: 'session-write-test' }); await connection.refresh(); assert.throws(() => replica.assert(session, 'write')); assert.equal(replica.assert(session, 'read').kind, 'allow')
  const other = identity('B'); other.subject.identitySource = providerOrigin; other.evidence.issuer = providerOrigin; const otherContext = replica.bindSession(replica.createContext(other, binding), 'replica-other-session'); await replica.reassess(otherContext, undefined, 'write'); assert.equal(replica.assert(otherContext, 'write').kind, 'allow')
  const fresh = await center.reassess(center.contextForSession(session.scope.sessionId), undefined, 'write'); assert.equal(fresh.status, 'assessed'); center.updateRestriction({ ...restriction, active: false }); await connection.refresh(); assert.equal(replica.assert(session, 'write').kind, 'allow'); await connection.refresh(); assert.equal(center.status().instances[0].applied, true)
})


test('报告连接在解析后停用或下载等待中变化，分别阻止上游和正文释放', async t => {
  const before = await reportFixture(t); before.invalidateConnection(); assert.equal((await before.get()).status, 403); assert.equal(before.requested(), 0); before.release()
  const during = await reportFixture(t); const downloading = during.get(); await during.arrival; during.invalidateConnection(); during.release(); const blocked = await downloading; assert.equal(blocked.status, 403); assert.ok(!(await blocked.text()).includes('PRIVATE-REPORT-BODY')); assert.equal(during.requested(), 1)
})
