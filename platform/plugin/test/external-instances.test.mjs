import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const buildRoot = mkdtempSync(join(tmpdir(), 'external-build-'))
await build({ entryPoints: ['src/instances/external/index.ts'], outfile: join(buildRoot, 'external.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
await build({ entryPoints: ['src/instances/external/registry.ts'], outfile: join(buildRoot, 'registry.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
await build({ entryPoints: ['src/instances/external/access.ts'], outfile: join(buildRoot, 'access.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
await build({ entryPoints: ['src/business-control/providers.ts'], outfile: join(buildRoot, 'providers.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const external = await import(`file://${join(buildRoot, 'external.mjs')}`)
const registry = await import(`file://${join(buildRoot, 'registry.mjs')}`)
const access = await import(`file://${join(buildRoot, 'access.mjs')}`)
const { HttpRiskAssessmentProvider } = await import(`file://${join(buildRoot, 'providers.mjs')}`)
const { WebSocketServer } = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-gateway/package.json'))('ws')
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))
const owner = { principal: { kind: 'owner' } }, signal = () => new AbortController().signal
const caller = (subjectId = 'A') => ({ subjectId, source: 'test-provider', expiresAt: new Date(Date.now() + 60000).toISOString() })
let serial = 0
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'external-instance-')); mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], untouched: { preserved: true } }))
  const calls = [], sessionRows = new Map()
  const upstream = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk
    calls.push({ path: req.url, method: req.method, headers: req.headers, input: input ? JSON.parse(input) : null })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"message","data":{"sessionID":"ses_other","text":"OTHER_PRIVATE"}}\r\n\r\n')
      res.write('data: {"type":"message","data":{"sessionID":"ses_other","text":"CONFLICT_PRIVATE"},"metadata":{"sessionID":"ses_1"}}\r\n\r\n')
      res.write('data: {"type":"message","data":{"sessionID":"ses_1","text":"CURRENT_SESSION"}}\r\n\r\n')
      if (req.headers.authorization) res.write(`data: ${JSON.stringify({ type: 'message', data: { sessionID: 'ses_1', echo: req.headers.authorization } })}\n\n`)
      return
    }
    if (req.url === '/api/info') return res.end(JSON.stringify({ version: '2.2.5', pid: process.pid }))
    if (req.url === '/openapi.json') return res.end(JSON.stringify({ info: { version: '2.0.8' }, paths: { '/chat/': {}, '/sessions/{session_id}/stream': {} } }))
    if (req.url === '/agent/') return res.end(JSON.stringify({ agents: [{ id: 'agentscope-native' }] }))
    if (req.url === '/sessions/' && req.method === 'POST') return res.end(JSON.stringify({ session_id: 'agentscope-session' }))
    if (req.url === '/chat/' && req.method === 'POST') {
      const data = JSON.parse(input)
      if (!Array.isArray(data.input?.content) || data.input.content[0]?.type !== 'text' || typeof data.input.content[0]?.text !== 'string') { res.writeHead(422); return res.end('{}') }
      return res.end(JSON.stringify({ status: 'started', session_id: data.session_id }))
    }
    if (req.url === '/sessions/agentscope-session/messages?agent_id=agentscope-native') return res.end(JSON.stringify({ messages: [{ content: [{ type: 'text', text: 'AgentScope 结果' }] }] }))
    if (req.url === '/api/session/list') return res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }))
    if (req.url === '/api/agentPresets/list') return res.end(JSON.stringify({ result: { ok: true, value: { presets: [{ id: 'standard', name: '标准助手' }] } } }))
    if (req.url === '/api/session/create') return res.end(JSON.stringify({ result: { ok: true, value: { sessionId: 'session-dsh-native' } } }))
    if (req.url === '/api/session/projections') return res.end(JSON.stringify({ result: { ok: true, value: { kind: 'sequenced', asOfSeq: 2, values: {} } } }))
    if (req.url === '/api/session/page') {
      const request = JSON.parse(input).payload.args.request
      if (request.address?.kind !== 'session' || request.throughSeq !== 2) { res.writeHead(422); return res.end('{}') }
      return res.end(JSON.stringify({ result: { ok: true, value: { records: [], hasMore: false } } }))
    }
    if (req.url === '/api/session' && req.method === 'GET') return res.end(JSON.stringify({ data: [...sessionRows.values()] }))
    if (req.url === '/api/session' && req.method === 'POST') { const id = `ses_${sessionRows.size + 1}`; sessionRows.set(id, { id }); return res.end(JSON.stringify({ data: { id } })) }
    if (/^\/api\/session\/ses_\d+\/prompt$/.test(req.url)) return res.end(JSON.stringify({ data: { id: 'inbox-test' } }))
    if (/^\/api\/session\/ses_\d+\/message$/.test(req.url)) return res.end(JSON.stringify({ data: [{ text: '真实上游测试返回' }] }))
    res.writeHead(404); res.end('{}')
  })
  const streams = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (req, socket, head) => streams.handleUpgrade(req, socket, head, ws => ws.on('message', raw => {
    const frame = JSON.parse(raw.toString())
    if (frame.type === 'open' && frame.endpoint === 'workspace/follow') ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: [{ workspaceId: 'native-workspace', title: '原生工作区', path: '/workspace' }], archivedSessionIds: [], pinnedSessionIds: [] } } }))
  })))
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => { for (const ws of streams.clients) ws.terminate(); streams.close(); upstream.closeAllConnections(); upstream.close(); rmSync(root, { recursive: true, force: true }) })
  const endpoint = `http://127.0.0.1:${upstream.address().port}`, handler = external.createExternalInstancesHandler(root)
  async function rpc(action, payload = {}) { const result = await handler(action, payload, signal(), owner); if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result.value }
  const revision = () => registry.externalInstances(root).revision
  const save = async (overrides = {}) => rpc('save', { revision: revision(), requestId: `save-${++serial}`, agent: { id: 'test-agent', name: '测试智能体', system: '原系统', owner: '原责任人' }, instance: { id: 'remote-one', name: '远程样本', framework: 'opencode', endpoint, managementMode: 'externally-managed', usageMode: 'shared', ...overrides }, policy: { enabled: true, subjects: ['A', 'B', 'platform-owner'], actions: ['agent:access', 'session:create', 'session:prompt', 'session:read', 'session:events'] } })
  const mutate = (action, id = 'remote-one') => rpc(action, { id, revision: revision(), requestId: `${action}-${++serial}` })
  const enable = async () => { await save(); const checked = await mutate('verify'); assert.equal(checked.instance.verification.ok, true); return mutate('enable') }
  return { root, calls, handler, rpc, revision, save, mutate, enable, endpoint }
}

test('无 EXP 登记、一对多、元数据修改、草稿和移除均不接管上游生命周期', async t => {
  const f = await fixture(t)
  const first = await f.save(); assert.equal(first.instance.entryState, 'pending'); assert.equal(first.instance.managementMode, 'externally-managed')
  await f.save({ id: 'remote-two' }); assert.equal(registry.externalInstances(f.root).agents.length, 1); assert.equal(registry.externalInstances(f.root).instances.length, 2)
  await f.save({ id: 'draft-one', endpoint: '' }); assert.equal(registry.getExternalInstance(f.root, 'draft-one').state, 'draft')
  await f.enable(); const modified = await f.save({ location: '同机模拟远程', instanceOwner: '实例运维' }); assert.equal(modified.instance.entryState, 'enabled'); assert.ok(modified.instance.activation)
  await f.mutate('disable'); await f.mutate('remove'); assert.equal(registry.getExternalInstance(f.root, 'remote-one').state, 'removed')
  assert.equal(registry.externalInstances(f.root).instances.some(row => row.id === 'remote-one'), false)
  assert.deepEqual(f.calls.map(row => row.path), ['/api/info', '/api/session'])
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'config/business-access.json'))).untouched, { preserved: true })
})

test('管理 RPC 拒绝非 owner；幂等请求不重复登记，冲突与未知 schema 明确失败', async t => {
  const f = await fixture(t)
  const denied = await f.handler('list', {}, signal(), { principal: { kind: 'service' } }); assert.equal(denied.ok, false); assert.equal(denied.error.code, 'forbidden')
  const payload = { revision: f.revision(), requestId: 'stable-create', agent: { name: '一次登记', system: '原系统', owner: 'owner' }, instance: { name: '实例', framework: 'opencode', endpoint: f.endpoint, managementMode: 'externally-managed', usageMode: 'shared' }, policy: { enabled: true, subjects: ['A'], actions: ['agent:access'] } }
  const first = await f.rpc('save', payload), second = await f.rpc('save', payload); assert.equal(first.instance.id, second.instance.id)
  await assert.rejects(f.rpc('save', { ...payload, instance: { ...payload.instance, name: '别的请求' } }), error => error.code === 'conflict')
  const raw = JSON.parse(readFileSync(join(f.root, 'config/external-instances.json'))); raw.schemaVersion = 99; writeFileSync(join(f.root, 'config/external-instances.json'), JSON.stringify(raw))
  await assert.rejects(f.rpc('list'), error => error.code === 'invalid_schema')
})

test('配置修订和手工目标变更使旧验证失效；策略部分提交不能开放入口', async t => {
  const f = await fixture(t); await f.enable(); const old = f.revision()
  await f.save({ endpoint: `${f.endpoint}/different` })
  await assert.rejects(f.rpc('disable', { id: 'remote-one', revision: old, requestId: 'stale' }), error => error.code === 'conflict')
  assert.equal(registry.isExternalEnabled(f.root, registry.getExternalInstance(f.root, 'remote-one')), false)
  await f.enable()
  const configPath = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(configPath)); config.externalInstances[0].subjects = ['C']; writeFileSync(configPath, JSON.stringify(config))
  assert.equal(registry.isExternalEnabled(f.root, registry.getExternalInstance(f.root, 'remote-one')), false)
  await f.enable()
  const path = join(f.root, 'config/external-instances.json'), raw = JSON.parse(readFileSync(path)); raw.instances[0].endpoint += '/changed'; writeFileSync(path, JSON.stringify(raw))
  assert.equal(registry.isExternalEnabled(f.root, registry.getExternalInstance(f.root, 'remote-one')), false)
})

test('OpenCode v2 原生创建、受理和结果分开，幂等与会话归属服务端生效', async t => {
  const f = await fixture(t); await f.enable()
  const invoke = input => access.invokeExternal(f.root, caller(), { id: 'remote-one', requestId: `invoke-${++serial}`, ...input }, signal())
  const created = await invoke({ operation: 'session:create' }); assert.equal(created.stage, 'responded'); assert.ok(created.sessionId)
  const prompted = { id: 'remote-one', operation: 'session:prompt', sessionId: created.sessionId, input: '查询资产', requestId: 'prompt-one' }
  const accepted = await access.invokeExternal(f.root, caller(), prompted, signal()); assert.equal(accepted.stage, 'accepted')
  await access.invokeExternal(f.root, caller(), prompted, signal()); assert.equal(f.calls.filter(row => row.path.endsWith('/prompt')).length, 1)
  const result = await invoke({ operation: 'session:read', sessionId: created.sessionId }); assert.equal(result.value.data[0].text, '真实上游测试返回')
  await assert.rejects(access.invokeExternal(f.root, caller('B'), { ...prompted, operation: 'session:read', requestId: 'cross-subject' }, signal()), error => error.code === 'session_forbidden')
  assert.equal(f.calls.some(row => row.path.includes('prompt_async')), false)
})

test('未授权、停入口和缺失必要认证均在业务转发前拒绝', async t => {
  const f = await fixture(t); await f.enable(); const before = f.calls.length
  await assert.rejects(access.invokeExternal(f.root, caller('C'), { id: 'remote-one', operation: 'session:create', requestId: 'forbidden' }, signal()), error => error.code === 'forbidden')
  await f.mutate('disable')
  await assert.rejects(access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'disabled' }, signal()), error => error.code === 'entry_disabled')
  assert.equal(f.calls.length, before)
  const handler = external.createExternalAccessHandler(f.root), server = createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { handler.close(); server.closeAllConnections(); server.close() })
  const denied = await fetch(`http://127.0.0.1:${server.address().port}/api/external-instances/v1/remote-one/invoke`, { method: 'POST', body: JSON.stringify({ operation: 'session:create', requestId: 'http-1' }) })
  assert.equal(denied.status, 503); assert.equal(f.calls.length, before)
})

test('风险明确拒绝、无效时效与判断期间撤权不派发业务请求', async t => {
  const f = await fixture(t); await f.enable(); let mode = 'deny', waiting, release
  const provider = createServer(async (req, res) => {
    let input = ''; for await (const chunk of req) input += chunk
    const request = JSON.parse(input)
    if (mode === 'wait') { waiting?.(); await new Promise(resolve => { release = resolve }) }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, scope: request.scope, level: 'low', constraints: { deniedOperations: mode === 'deny' ? ['*'] : [] }, expiresAt: mode === 'nan' ? 'not-a-date' : new Date(Date.now() + 60000).toISOString() }))
  }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => { provider.closeAllConnections(); provider.close() })
  const configPath = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(configPath)); config.riskAssessment = { endpoint: `http://127.0.0.1:${provider.address().port}/risk` }; writeFileSync(configPath, JSON.stringify(config))
  const before = f.calls.length, invoke = () => access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: `risk-${++serial}` }, signal())
  await assert.rejects(invoke(), error => error.code === 'risk_denied'); mode = 'nan'; await assert.rejects(invoke(), error => error.code === 'risk_unknown')
  mode = 'wait'; const started = new Promise(resolve => { waiting = resolve }), pending = invoke(); await started; await f.mutate('disable'); release(); await assert.rejects(pending, error => error.code === 'entry_disabled')
  assert.equal(f.calls.length, before)
})

async function riskProvider(t, respond = () => ({})) {
  const requests = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const input = JSON.parse(text); requests.push({ path: req.url, input })
    const result = await respond(req.url, input)
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: 1, scope: input.scope, level: 'low', constraints: { deniedOperations: [] }, expiresAt: new Date(Date.now() + 60000).toISOString(), ...result.body }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  return { requests, endpoint: `http://127.0.0.1:${server.address().port}` }
}

test('外部风险覆盖供 owner、HTTP 与机器主体共用，既有 DSH 风险仍用全局提供方', async t => {
  const f = await fixture(t); await f.enable(); const provider = await riskProvider(t)
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path))
  config.riskAssessment = { endpoint: provider.endpoint + '/legacy', testRunId: 'legacy-fixture' }
  config.externalAccess = { riskAssessment: { endpoint: provider.endpoint + '/external', testRunId: 'external-fixture' } }
  writeFileSync(path, JSON.stringify(config))
  assert.ok((await f.rpc('invoke', { id: 'remote-one', operation: 'session:create', requestId: 'override-owner' })).sessionId)
  const handler = external.createExternalAccessHandler(f.root, { authenticate: async () => caller('B') })
  const server = createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { handler.close(); server.closeAllConnections(); server.close() })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/external-instances/v1/remote-one/invoke`, { method: 'POST', body: JSON.stringify({ operation: 'session:create', requestId: 'override-http' }) })
  assert.equal(response.status, 200); assert.ok((await response.json()).sessionId)
  await f.mutate('disable')
  await access.authorizeExternalOperation(f.root, { instanceId: 'remote-one', operation: { serverId: 'sample-assets', operationId: 'get_asset', kind: 'read', target: 'http://resource.invalid/assets/A-1', method: 'GET' }, args: { id: 'A-1' } }, signal())
  assert.deepEqual(provider.requests.map(row => row.path), ['/external', '/external', '/external'])
  assert.deepEqual(provider.requests.map(row => row.input.subjectId), ['platform-owner', 'B', 'instance:remote-one'])
  assert.equal(provider.requests[2].input.subject.kind, 'service')
  for (const { input } of provider.requests) {
    assert.equal(input.binding.kind, 'external-controlled'); assert.equal(input.scope.instanceId, 'remote-one')
    assert.equal(input.testRunId, 'external-fixture'); assert.equal('sourceDigest' in input.binding, false); assert.equal('runtimeGeneration' in input.scope, false)
  }
  assert.equal(provider.requests[2].input.operation.operationId, 'get_asset'); assert.deepEqual(provider.requests[2].input.input, { id: 'A-1' })
  const legacy = new HttpRiskAssessmentProvider(config.riskAssessment)
  await legacy.assess({ context: { subject: { id: 'legacy-subject' }, scope: { workspaceId: 'legacy-workspace', agentId: 'legacy-agent', instanceId: 'legacy-instance', runtimeGeneration: 'legacy-generation', subjectId: 'legacy-subject' }, sourceDigest: 'legacy-source' }, action: 'read', validatedArgs: {} }, signal())
  assert.equal(provider.requests.at(-1).path, '/legacy'); assert.equal(provider.requests.at(-1).input.testRunId, 'legacy-fixture')
  assert.deepEqual(JSON.parse(readFileSync(path)).riskAssessment, config.riskAssessment)
})

test('显式外部风险拒绝、不可达或无效配置均不回退全局风险，也不派发业务', async t => {
  const f = await fixture(t); await f.enable(); let mode = 'deny'
  const provider = await riskProvider(t, path => path === '/external' ? mode === 'deny' ? { body: { constraints: { deniedOperations: ['*'] } } } : { status: 503 } : {})
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path)), before = f.calls.length
  config.riskAssessment = { endpoint: provider.endpoint + '/legacy' }; config.externalAccess = { riskAssessment: { endpoint: provider.endpoint + '/external' } }
  const invoke = () => access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: `override-failure-${++serial}` }, signal())
  writeFileSync(path, JSON.stringify(config)); await assert.rejects(invoke(), error => error.code === 'risk_denied')
  mode = 'unavailable'; await assert.rejects(invoke(), error => error.code === 'provider_unavailable')
  const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening'); const port = reserved.address().port
  await new Promise(resolve => reserved.close(resolve))
  config.externalAccess = { riskAssessment: { endpoint: `http://127.0.0.1:${port}/unreachable` } }
  writeFileSync(path, JSON.stringify(config)); await assert.rejects(invoke(), error => error.code === 'risk_unavailable')
  for (const invalid of [null, false, [], { riskAssessment: null }, { riskAssessment: {} }, { riskAssessment: { endpoint: '' } }, { riskAssessment: { endpoint: 'ftp://invalid/risk' } }, { riskAssessment: { endpoint: provider.endpoint, timeoutMs: 0 } }, { riskAssessment: { endpoint: provider.endpoint, testRunId: false } }]) {
    config.externalAccess = invalid; writeFileSync(path, JSON.stringify(config))
    await assert.rejects(invoke(), error => error.code === 'invalid_provider_config')
  }
  assert.equal(provider.requests.some(row => row.path === '/legacy'), false); assert.equal(f.calls.length, before)
})

test('外部风险覆盖在途变化禁止派发，未选中的全局风险变化不误伤当前决定', async t => {
  const f = await fixture(t); await f.enable(); let enter, release
  const provider = await riskProvider(t, async () => { enter(); await new Promise(resolve => { release = resolve }); return {} })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path))
  config.riskAssessment = { endpoint: provider.endpoint + '/legacy' }; config.externalAccess = { riskAssessment: { endpoint: provider.endpoint + '/external' } }; writeFileSync(path, JSON.stringify(config))
  let entered = new Promise(resolve => { enter = resolve })
  const invoke = () => access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: `override-change-${++serial}` }, signal())
  const before = f.calls.length, pending = invoke(); await entered
  config.externalAccess.riskAssessment.endpoint = provider.endpoint + '/replacement'; writeFileSync(path, JSON.stringify(config)); release()
  await assert.rejects(pending, error => error.code === 'configuration_changed'); assert.equal(f.calls.length, before)
  entered = new Promise(resolve => { enter = resolve }); const next = invoke(); await entered
  config.riskAssessment.endpoint = provider.endpoint + '/legacy-updated'; writeFileSync(path, JSON.stringify(config)); release()
  assert.ok((await next).sessionId)
  assert.deepEqual(provider.requests.map(row => row.path), ['/external', '/replacement'])
})

test('无外部风险覆盖时继续使用现有全局风险配置', async t => {
  const f = await fixture(t); await f.enable()
  const provider = await riskProvider(t, () => ({ body: { constraints: { deniedOperations: ['*'] } } }))
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path))
  config.riskAssessment = { endpoint: provider.endpoint + '/legacy' }
  for (const externalAccess of [undefined, {}]) {
    config.externalAccess = externalAccess; writeFileSync(path, JSON.stringify(config))
    await assert.rejects(access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: `legacy-risk-${++serial}` }, signal()), error => error.code === 'risk_denied')
  }
  assert.deepEqual(provider.requests.map(row => row.path), ['/legacy', '/legacy'])
})

test('机器授权返回的同步派发复核检查所选提供方、有效期与当前实例绑定', async t => {
  const f = await fixture(t); await f.enable(); const provider = await riskProvider(t)
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path))
  config.externalAccess = { riskAssessment: { endpoint: provider.endpoint + '/external' } }; writeFileSync(path, JSON.stringify(config))
  const request = { instanceId: 'remote-one', operation: { serverId: 'sample-assets', operationId: 'get_asset', kind: 'read', target: 'http://resource.invalid/assets/A-1', method: 'GET' }, args: { id: 'A-1' } }
  const check = await access.authorizeExternalOperation(f.root, request, signal())
  assert.equal(typeof check, 'function'); check()
  config.externalAccess.riskAssessment.endpoint = provider.endpoint + '/replacement'; writeFileSync(path, JSON.stringify(config))
  assert.throws(check, error => error.code === 'configuration_changed')
  const fresh = await access.authorizeExternalOperation(f.root, request, signal()), now = Date.now
  try { Date.now = () => now() + 120000; assert.throws(fresh, error => error.code === 'authorization_expired') }
  finally { Date.now = now }
  await f.save({ selector: '/changed-after-authorization' })
  assert.throws(fresh, error => error.code === 'configuration_changed')
})

test('HTTP 不接受目标替换，平台身份 Header 不透传到上游', async t => {
  const f = await fixture(t); await f.enable()
  const handler = external.createExternalAccessHandler(f.root, { authenticate: async () => caller() }), server = createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { handler.close(); server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/api/external-instances/v1/remote-one/invoke`
  const denied = await fetch(url, { method: 'POST', body: JSON.stringify({ operation: 'session:create', requestId: 'replace', endpoint: 'http://wrong' }) }); assert.equal(denied.status, 400)
  const created = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer caller-private', 'x-harness-owner': 'true', cookie: 'management-secret=private' }, body: JSON.stringify({ operation: 'session:create', requestId: 'safe-request' }) }); assert.equal(created.status, 200)
  const request = f.calls.find(row => row.method === 'POST'); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined); assert.equal(request.headers['x-harness-owner'], undefined)
})

test('OpenCode 全局 SSE 过滤其他会话，停入口关闭现有流且重连拒绝', async t => {
  const f = await fixture(t); await f.enable()
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'stream-create' }, signal())
  const handler = external.createExternalAccessHandler(f.root, { authenticate: async () => caller() }), server = createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { handler.close(); server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/api/external-instances/v1/remote-one/events?sessionId=${created.sessionId}`
  const response = await fetch(url), reader = response.body.getReader(), first = new TextDecoder().decode((await reader.read()).value)
  assert.equal(response.status, 200); assert.match(first, /CURRENT_SESSION/); assert.doesNotMatch(first, /OTHER_PRIVATE|CONFLICT_PRIVATE/)
  await f.mutate('disable')
  const end = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('撤权后流未关闭')), 1500))]); assert.equal(end.done, true)
  const reconnect = await fetch(url); assert.equal(reconnect.status, 403)
  const records = registry.readExternalRecords(f.root, 'remote-one'); assert.ok(records.some(row => row.stage === 'connection_closed' && row.reason.includes('task_state_independent')))
})

test('上游专用秘密不进入适配结果或普通访问记录', async t => {
  const f = await fixture(t), secret = 'dedicated-upstream-private-token'
  mkdirSync(join(f.root, '.local/credentials/external'), { recursive: true }); writeFileSync(join(f.root, '.local/credentials/external/upstream-one.json'), JSON.stringify({ headers: { Authorization: `Bearer ${secret}` } }))
  await f.save({ credentialRef: 'upstream-one' }); await f.mutate('verify'); await f.mutate('enable')
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'secret-create' }, signal())
  assert.equal(f.calls.find(row => row.method === 'POST').headers.authorization, `Bearer ${secret}`)
  assert.doesNotMatch(JSON.stringify(created), new RegExp(secret)); assert.doesNotMatch(JSON.stringify(registry.readExternalRecords(f.root, 'remote-one')), new RegExp(secret))
})

test('AgentScope 2.0.8 Msg数组与查询归属、DSH rc.5地址和游标遵循原生合同', async t => {
  const f = await fixture(t)
  await f.save({ framework: 'agentscope', selector: 'agentscope-native' }); await f.mutate('verify'); await f.mutate('enable')
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'as-create' }, signal())
  const accepted = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:prompt', sessionId: created.sessionId, input: '检查数组消息', requestId: 'as-prompt' }, signal())
  assert.equal(accepted.stage, 'accepted')
  const read = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:read', sessionId: created.sessionId, requestId: 'as-read' }, signal())
  assert.equal(read.value.messages[0].content[0].text, 'AgentScope 结果')
  await f.save({ framework: 'dsh', selector: JSON.stringify({ workspaceId: 'native-workspace', agentPreset: 'standard' }) }); await f.mutate('verify'); await f.mutate('enable')
  const dsh = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'dsh-create' }, signal())
  const page = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:read', sessionId: dsh.sessionId, requestId: 'dsh-page' }, signal())
  assert.equal(page.stage, 'responded'); assert.deepEqual(page.value.records, [])
})

test('风险事实在第三方授权等待期间到期时，不复用最初允许结果', async t => {
  const f = await fixture(t); await f.enable()
  const provider = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const input = JSON.parse(text)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/risk') return res.end(JSON.stringify({ version: 1, scope: input.scope, level: 'low', constraints: { deniedOperations: [] }, expiresAt: new Date(Date.now() + 30).toISOString() }))
    await new Promise(resolve => setTimeout(resolve, 80))
    res.end(JSON.stringify({ protocolVersion: 1, requestId: input.requestId, binding: input.binding, decision: 'allow', expiresAt: new Date(Date.now() + 60000).toISOString() }))
  }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => { provider.closeAllConnections(); provider.close() })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path)), base = `http://127.0.0.1:${provider.address().port}`
  config.riskAssessment = { endpoint: base + '/risk' }; config.accessAuthorization = { endpoint: base + '/authorize' }; writeFileSync(path, JSON.stringify(config))
  const before = f.calls.length
  await assert.rejects(access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'expired-in-wait' }, signal()), error => error.code === 'authorization_expired')
  assert.equal(f.calls.length, before)
})

test('SSE授权等待中更换目标并重新启用，仍不得向原目标订阅', async t => {
  const f = await fixture(t); await f.enable()
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'race-stream-create' }, signal())
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const provider = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const input = JSON.parse(text); enter(); await new Promise(resolve => { release = resolve })
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, scope: input.scope, level: 'low', constraints: { deniedOperations: [] }, expiresAt: new Date(Date.now() + 60000).toISOString() }))
  }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => { provider.closeAllConnections(); provider.close() })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path)); config.riskAssessment = { endpoint: `http://127.0.0.1:${provider.address().port}/risk` }; writeFileSync(path, JSON.stringify(config))
  const handler = external.createExternalAccessHandler(f.root, { authenticate: async () => caller() }), server = createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { handler.close(); server.closeAllConnections(); server.close() })
  const pending = fetch(`http://127.0.0.1:${server.address().port}/api/external-instances/v1/remote-one/events?sessionId=${created.sessionId}`)
  await entered; await f.save({ selector: '/changed-workspace' }); await f.mutate('verify'); await f.mutate('enable'); release()
  const response = await pending; assert.equal(response.status, 409); assert.equal(f.calls.filter(row => row.path === '/api/event').length, 0)
})

test('同一凭据引用的材料替换或丢失使验证失效，不将新权限带入旧绑定', async t => {
  const f = await fixture(t), directory = join(f.root, '.local/credentials/external'); mkdirSync(directory, { recursive: true })
  const path = join(directory, 'credential-one.json'); writeFileSync(path, JSON.stringify({ headers: { Authorization: 'Bearer old-dedicated-material' } }))
  await f.save({ credentialRef: 'credential-one' }); await f.mutate('verify'); await f.mutate('enable')
  const previous = registry.getExternalInstance(f.root, 'remote-one'), before = f.calls.length
  writeFileSync(path, JSON.stringify({ headers: { Authorization: 'Bearer new-dedicated-material' } }))
  const changed = registry.getExternalInstance(f.root, 'remote-one'); assert.notEqual(changed.bindingDigest, previous.bindingDigest); assert.equal(registry.externalInstances(f.root).instances[0].entryState, 'pending')
  await assert.rejects(access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'stale-material' }, signal()), error => error.code === 'entry_disabled')
  assert.equal(f.calls.length, before)
  rmSync(path); assert.equal(registry.externalInstances(f.root).instances[0].entryState, 'pending')
})

test('SSE对上游反射的实际认证材料脱敏，凭据更新后关闭原流', async t => {
  const f = await fixture(t), directory = join(f.root, '.local/credentials/external'); mkdirSync(directory, { recursive: true })
  const path = join(directory, 'stream-credential.json'), secret = 'stream-private-auth-material'; writeFileSync(path, JSON.stringify({ headers: { Authorization: `Bearer ${secret}` } }))
  await f.save({ credentialRef: 'stream-credential' }); await f.mutate('verify'); await f.mutate('enable')
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'secret-stream-create' }, signal())
  const handler = external.createExternalAccessHandler(f.root, { authenticate: async () => caller() }), server = createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { handler.close(); server.closeAllConnections(); server.close() })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/external-instances/v1/remote-one/events?sessionId=${created.sessionId}`), reader = response.body.getReader(), first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /已隐藏凭据/); assert.doesNotMatch(first, new RegExp(secret))
  writeFileSync(path, JSON.stringify({ headers: { Authorization: 'Bearer changed-private-material' } }))
  const ended = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('凭据变化后原流未关闭')), 1500))]); assert.equal(ended.done, true)
})

test('业务总开关关闭时新入口拒绝且已开放SSE结束，列表明确已停用', async t => {
  const f = await fixture(t); await f.enable()
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'global-create' }, signal())
  const handler = external.createExternalAccessHandler(f.root, { authenticate: async () => caller() }), server = createServer((req, res) => void handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { handler.close(); server.closeAllConnections(); server.close() })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/external-instances/v1/remote-one/events?sessionId=${created.sessionId}`), reader = response.body.getReader(); await reader.read()
  const configPath = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(configPath)); config.enabled = false; writeFileSync(configPath, JSON.stringify(config))
  const before = f.calls.length
  await assert.rejects(access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'global-deny' }, signal()), error => error.code === 'entry_disabled')
  assert.equal(registry.externalInstances(f.root).instances[0].entryState, 'disabled'); assert.equal(f.calls.length, before)
  const ended = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('总开关关闭后原流未结束')), 1500))]); assert.equal(ended.done, true)
})

test('事件订阅首次派发复核风险有效期与配置，并准确记录未派发', async t => {
  const f = await fixture(t); await f.enable()
  const created = await access.invokeExternal(f.root, caller(), { id: 'remote-one', operation: 'session:create', requestId: 'stream-dispatch-session' }, signal())
  const provider = await riskProvider(t, async () => ({ body: { expiresAt: new Date(Date.now() + 250).toISOString() } }))
  const file = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(file))
  config.externalAccess = { riskAssessment: { endpoint: provider.endpoint + '/external' } }
  writeFileSync(file, JSON.stringify(config))
  const realAppend = fs.appendFileSync, realNow = Date.now
  for (const mode of ['expired', 'changed']) {
    let injected = false
    fs.appendFileSync = (path, data, ...args) => {
      const row = String(data)
      if (String(path).startsWith(f.root) && row.includes('"operation":"session:events"') && row.includes('"stage":"dispatching"')) {
        injected = true
        if (mode === 'expired') Date.now = () => realNow() + 1000
        else { config.externalAccess.riskAssessment.endpoint = provider.endpoint + '/replacement'; writeFileSync(file, JSON.stringify(config)) }
      }
      return realAppend(path, data, ...args)
    }
    syncBuiltinESMExports()
    try {
      const before = f.calls.filter(call => call.path === '/api/event').length
      await assert.rejects(access.streamExternal(f.root, caller(), 'remote-one', created.sessionId, { headersSent: false, writableEnded: false, end() {} }, signal()), error => error.code === (mode === 'expired' ? 'authorization_expired' : 'configuration_changed'))
      assert.equal(injected, true)
      assert.equal(f.calls.filter(call => call.path === '/api/event').length, before)
      const record = registry.readExternalRecords(f.root, 'remote-one')[0]
      assert.equal(record.stage, 'not_dispatched'); assert.equal(record.result, 'deny')
    } finally { fs.appendFileSync = realAppend; Date.now = realNow; syncBuiltinESMExports() }
  }
})
