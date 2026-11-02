import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { build } from 'esbuild'
import { importPKCS8, SignJWT } from 'jose'

const local = resolve('.local/agent-access-tests'); mkdirSync(local, { recursive: true })
const compiled = mkdtempSync(join(local, 'build-'))
symlinkSync(resolve('node_modules'), join(compiled, 'node_modules'), 'dir')
await build({ entryPoints: { index: 'src/agent-access/index.ts', connector: 'src/agent-access/connector.ts', registry: 'src/instances/external/registry.ts' }, outdir: compiled, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const { AgentAccessService, createAgentAccessHandler, createAgentAccessManagement } = await import(`file://${join(compiled, 'index.mjs')}`)
const { createResourceConnector } = await import(`file://${join(compiled, 'connector.mjs')}`)
const { externalBindingDigest } = await import(`file://${join(compiled, 'registry.mjs')}`)
test.after(() => rmSync(compiled, { recursive: true, force: true }))

async function fixture(t) {
  const root = mkdtempSync(join(local, 'state-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  let now = Date.now(), count = 0, authorization, lastPath
  const upstream = createServer((req, res) => { count++; authorization = req.headers.authorization; lastPath = req.url; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: req.url, actual: true })) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); t.after(() => { upstream.closeAllConnections(); upstream.close() })
  mkdirSync(join(root, 'config')); writeFileSync(join(root, 'upstream-secret'), 'native-only', { mode: 0o600 })
  const resources = ['assets', 'other'].map(id => ({ id, audience: `https://resource.example/${id}`, endpoint: `http://127.0.0.1:${upstream.address().port}`, credentialFile: 'upstream-secret', tools: [
    { name: 'get_asset', scope: 'assets:read', method: 'GET', path: '/assets/{id}', objectField: 'id', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
    { name: 'update_asset', scope: 'assets:write', method: 'POST', path: '/assets/{id}', objectField: 'id' },
  ] }))
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], preserved: { untouched: true }, agentAccess: { schemaVersion: 1, issuer: 'https://harness.example/agent-access', resources, grants: [
    { instanceId: 'agent-a', resourceId: 'assets', scopes: ['assets:read'], objects: ['A'], enabled: true, version: 1 },
    { instanceId: 'agent-b', resourceId: 'assets', scopes: ['assets:read'], objects: ['B'], enabled: true, version: 1 },
  ] } }))
  const instances = new Map(['agent-a', 'agent-b'].map(id => [id, { id, state: 'registered', bindingDigest: `binding-${id}`, verification: { ok: true, bindingDigest: `binding-${id}` } }]))
  const options = { now: () => now, resolveInstance: id => instances.get(id), authorize: async () => {} }
  const service = new AgentAccessService(root, options)
  const a = service.createCredential('agent-a'), b = service.createCredential('agent-b')
  const issue = async (entry = a) => service.issue(entry.credential.clientId, entry.secret, resources[0].audience, ['assets:read'])
  return { root, service, a, b, issue, options, instances, resources, advance: ms => { now += ms }, count: () => count, authorization: () => authorization, lastPath: () => lastPath }
}

test('独立机器凭据、自身状态、一次秘密交付与 owner 管理', async t => {
  const f = await fixture(t)
  const status = f.service.selfStatus(f.a.credential.clientId, f.a.secret)
  assert.equal(status.instanceId, 'agent-a'); assert.equal(status.runtimeEvidence.sourceIntegrity, 'unknown')
  assert.throws(() => f.service.authenticate(f.a.credential.clientId, f.b.secret), /无效/)
  assert.throws(() => f.service.createCredential('agent-a'), /已有/)
  assert.throws(() => f.service.createCredential('unknown'), /未登记/)
  assert.ok(!JSON.stringify(f.service.status('agent-a')).includes(f.a.secret))
  const persisted = readFileSync(join(f.root, '.local/agent-access/state.json'), 'utf8')
  assert.ok(!persisted.includes(f.a.secret)); assert.ok(persisted.includes('hash'))
  const management = createAgentAccessManagement(f.root, f.options), signal = new AbortController().signal
  assert.equal((await management('status', { instanceId: 'agent-a' }, signal, { principal: { kind: 'service' } })).error.code, 'forbidden')
  assert.equal((await management('status', { instanceId: 'agent-a' }, signal, { principal: { kind: 'owner' } })).ok, true)
})

test('真实资源派发执行 scope、对象与受众检查，上游仅收到原生凭据', async t => {
  const f = await fixture(t), token = (await f.issue()).access_token
  const result = await f.service.dispatch(token, 'assets', 'get_asset', { id: 'A' }, new AbortController().signal)
  assert.equal(result.isError, false); assert.equal(f.count(), 1); assert.equal(f.authorization(), 'Bearer native-only'); assert.equal(f.lastPath(), '/assets/A')
  await assert.rejects(f.service.dispatch(token, 'assets', 'get_asset', { id: 'B' }, new AbortController().signal), /对象/)
  await assert.rejects(f.service.dispatch(token, 'assets', 'update_asset', { id: 'A' }, new AbortController().signal), /授权/)
  await assert.rejects(f.service.verify(token, 'other'), /令牌无效/)
  await assert.rejects(f.service.issue(f.a.credential.clientId, f.a.secret, f.resources[0].audience, ['assets:write']), /超出/)
  assert.equal(f.count(), 1)
  await assert.rejects(f.service.dispatch(token, 'assets', 'get_asset', { id: 'A', url: 'http://unregistered' }, new AbortController().signal), /控制字段/)
})

test('撤销资源授予立即使旧 token 无效，重启保持且不误伤其他实例', async t => {
  const f = await fixture(t), aToken = (await f.issue()).access_token, bToken = (await f.issue(f.b)).access_token
  const status = f.service.status('agent-a')
  f.service.saveGrant({ instanceId: 'agent-a', resourceId: 'assets', scopes: ['assets:read'], objects: ['A'], enabled: false, revision: status.revision })
  const restored = new AgentAccessService(f.root, f.options)
  await assert.rejects(restored.verify(aToken, 'assets'), /授权/)
  assert.equal((await restored.verify(bToken, 'assets')).credential.instanceId, 'agent-b')
  const config = JSON.parse(readFileSync(join(f.root, 'config/business-access.json'), 'utf8'))
  assert.deepEqual(config.preserved, { untouched: true })
  assert.throws(() => f.service.saveGrant({ instanceId: 'agent-a', resourceId: 'assets', scopes: ['assets:read'], enabled: true, revision: status.revision }), /已更新/)
})

test('凭据轮换保留有界窗口，撤 key、绑定变化与过期限制旧 token', async t => {
  const f = await fixture(t), token = (await f.issue()).access_token
  const rotated = f.service.createCredential('agent-a', true)
  assert.equal(f.service.authenticate(rotated.credential.clientId, rotated.secret).id, rotated.credential.id)
  f.service.revokeCredential('agent-a', f.a.credential.id)
  await assert.rejects(f.service.verify(token, 'assets'), /凭据/)
  const fresh = (await f.issue(rotated)).access_token
  f.instances.get('agent-a').bindingDigest = 'changed'
  await assert.rejects(f.service.verify(fresh, 'assets'), /尚未验证/)
  f.instances.get('agent-a').bindingDigest = 'binding-agent-a'
  f.advance(331000)
  await assert.rejects(f.service.verify(fresh, 'assets'), /过期/)
})

test('正常签发密钥轮换与紧急撤销在持有旧公钥时仍生效', async t => {
  const f = await fixture(t), token = (await f.issue()).access_token
  const oldKid = f.service.status('agent-a').signingKeys[0].kid
  await f.service.rotateSigningKey()
  await f.service.verify(token, 'assets')
  f.service.disableSigningKey(oldKid)
  await assert.rejects(new AgentAccessService(f.root, f.options).verify(token, 'assets'), /密钥已停用/)
  assert.equal((await f.issue()).token_type, 'Bearer')
})

test('异步风险判断后再次检查撤权，目标零派发', async t => {
  const f = await fixture(t), token = (await f.issue()).access_token
  const service = new AgentAccessService(f.root, { ...f.options, authorize: async () => { f.service.revokeCredential('agent-a', f.a.credential.id) } })
  await assert.rejects(service.dispatch(token, 'assets', 'get_asset', { id: 'A' }, new AbortController().signal), /凭据/)
  assert.equal(f.count(), 0)
})

test('机器 HTTP 路径不回退管理，表单、缺 token、错误绑定及篡改均拒绝', async t => {
  const f = await fixture(t), handler = createAgentAccessHandler(f.root, f.options)
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.statusCode = 418; res.end('unhandled') } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`, basic = `Basic ${Buffer.from(`${f.a.credential.clientId}:${f.a.secret}`).toString('base64')}`
  const tokenRequest = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', resource: f.resources[0].audience, scope: 'assets:read' }) })
  assert.equal(tokenRequest.status, 200); assert.equal(tokenRequest.headers.get('cache-control'), 'no-store')
  const token = (await tokenRequest.json()).access_token
  assert.equal((await fetch(`${base}/api/agent-access/v1/self/status`, { headers: { authorization: basic } })).status, 200)
  const call = auth => fetch(`${base}/api/agent-access/v1/resources/assets/mcp`, { method: 'POST', headers: { ...(auth ? { authorization: auth } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_asset', arguments: { id: 'A' } } }) })
  assert.equal((await call()).status, 401); assert.equal((await call('Bearer shared-management-token')).status, 401)
  assert.equal((await call(`Bearer ${token.slice(0, -4)}xxxx`)).status, 401)
  assert.equal((await call(`Bearer ${token}`)).status, 200); assert.equal(f.count(), 1)
  assert.equal((await fetch(`${base}/api/agent-access/v1/resources/missing/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403)
})

test('独立 connector 并发领证不串身份，撤销失败仅影响签名资源', async t => {
  const f = await fixture(t), handler = createAgentAccessHandler(f.root, f.options)
  let issues = 0
  const server = createServer(async (req, res) => { if (req.url === '/oauth/token') issues++; await handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  writeFileSync(join(f.root, 'connector-a.secret'), f.a.secret, { mode: 0o600 })
  const connector = createResourceConnector({ instanceId: 'agent-a', clientId: f.a.credential.clientId, secretFile: join(f.root, 'connector-a.secret'), tokenEndpoint: `${base}/oauth/token`, resourceUrl: `${base}/api/agent-access/v1/resources/assets/mcp`, audience: f.resources[0].audience, scopes: ['assets:read'] })
  connector.server.listen(0, '127.0.0.1'); await once(connector.server, 'listening'); t.after(() => { connector.server.closeAllConnections(); connector.server.close() })
  const invoke = id => fetch(`http://127.0.0.1:${connector.server.address().port}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_asset', arguments: { id: 'A' } } }) })
  const responses = await Promise.all([invoke(1), invoke(2), invoke(3)])
  assert.ok(responses.every(response => response.status === 200)); assert.equal(issues, 1); assert.equal(f.count(), 3)
  f.advance(331000)
  assert.equal((await invoke(4)).status, 200); assert.equal(issues, 2); assert.equal(f.count(), 4)
  f.service.revokeCredential('agent-a', f.a.credential.id)
  assert.equal((await invoke(5)).status, 503); assert.equal(f.count(), 4)
  assert.equal((await fetch(f.resources[0].endpoint + '/legacy')).status, 200)
})

test('默认机器授权复用登记与风险提供方，拒绝不会绕过到管理身份', async t => {
  const f = await fixture(t), observations = []
  for (const row of f.instances.values()) {
    Object.assign(row, { framework: 'opencode', endpoint: f.resources[0].endpoint, agentId: 'sample-agent', revision: 1 })
    row.bindingDigest = externalBindingDigest(f.root, row); row.verification.bindingDigest = row.bindingDigest
  }
  writeFileSync(join(f.root, 'config/external-instances.json'), JSON.stringify({ schemaVersion: 1, agents: [], requests: [], instances: [...f.instances.values()].map(row => ({ ...row, agentId: 'sample-agent', revision: 1 })) }))
  const risk = createServer(async (req, res) => {
    let body = ''; for await (const bytes of req) body += bytes
    const input = JSON.parse(body); observations.push(input); res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ version: 1, scope: input.scope, level: 'high', expiresAt: new Date(Date.now() + 60000).toISOString(), constraints: { deniedOperations: ['get_asset'] } }))
  })
  risk.listen(0, '127.0.0.1'); await once(risk, 'listening'); t.after(() => { risk.closeAllConnections(); risk.close() })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path, 'utf8'))
  config.riskAssessment = { endpoint: `http://127.0.0.1:${risk.address().port}/risk` }; writeFileSync(path, JSON.stringify(config))
  const token = (await f.issue()).access_token, defaultService = new AgentAccessService(f.root)
  await assert.rejects(defaultService.dispatch(token, 'assets', 'get_asset', { id: 'A' }, new AbortController().signal), /风险规则/)
  assert.equal(f.count(), 0); assert.equal(observations.length, 1); assert.equal(observations[0].subject.kind, 'service')
  assert.equal(observations[0].subject.id, 'instance:agent-a')
})

test('工具规格验证嵌套参数、路径遍历、重定向与已知秘密脱敏', async t => {
  const f = await fixture(t)
  let config = JSON.parse(readFileSync(join(f.root, 'config/business-access.json'), 'utf8'))
  config.agentAccess.resources[0].tools[0].inputSchema.properties.extra = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false }
  config.agentAccess.grants[0].objects.push('..'); writeFileSync(join(f.root, 'config/business-access.json'), JSON.stringify(config))
  const token = (await f.issue()).access_token
  await assert.rejects(f.service.dispatch(token, 'assets', 'get_asset', { id: 'A', extra: { count: 0 } }, new AbortController().signal), /规格/)
  await assert.rejects(f.service.dispatch(token, 'assets', 'get_asset', { id: '..' }, new AbortController().signal), /路径参数/)
  assert.equal(f.count(), 0)
  const proxy = new AgentAccessService(f.root, { ...f.options, fetch: async (url, input) => { assert.equal(input.redirect, 'error'); assert.equal(input.headers.authorization, 'Bearer native-only'); return new Response(JSON.stringify({ reflected: token, upstream: 'native-only' })) } })
  const result = await proxy.dispatch(token, 'assets', 'get_asset', { id: 'A' }, new AbortController().signal)
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes('native-only'))
  const directory = join(f.root, '.local/agent-access/records')
  const logs = readdirSync(directory).map(file => readFileSync(join(directory, file), 'utf8')).join('')
  assert.ok(!logs.includes(token)); assert.ok(!logs.includes(f.a.secret)); assert.ok(!logs.includes('native-only'))
})

test('必要记录写失败禁止转发，执行后记录失败明确说明已执行', async t => {
  const f = await fixture(t), token = (await f.issue()).access_token, directory = join(f.root, '.local/agent-access/records')
  rmSync(directory, { recursive: true }); writeFileSync(directory, 'blocked')
  await assert.rejects(f.service.dispatch(token, 'assets', 'get_asset', { id: 'A' }, new AbortController().signal), /未派发/)
  assert.equal(f.count(), 0)
  rmSync(directory); mkdirSync(directory)
  const afterExecution = new AgentAccessService(f.root, { ...f.options, fetch: async () => { rmSync(directory, { recursive: true }); writeFileSync(directory, 'blocked'); return new Response('{}') } })
  await assert.rejects(afterExecution.dispatch(token, 'assets', 'get_asset', { id: 'A' }, new AbortController().signal), /已执行.*记录写入失败/)
})

test('拒绝未来签发时间、错误用途、多受众及非法凭据期限', async t => {
  const f = await fixture(t), token = (await f.issue()).access_token
  const [header, encoded] = token.split('.'), claims = JSON.parse(Buffer.from(encoded, 'base64url')), protectedHeader = JSON.parse(Buffer.from(header, 'base64url'))
  const statePath = join(f.root, '.local/agent-access/state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'))
  const key = await importPKCS8(state.keys[0].privateKey, 'RS256')
  const signed = (body, head = protectedHeader) => new SignJWT(body).setProtectedHeader(head).sign(key)
  await assert.rejects(f.service.verify(await signed({ ...claims, iat: claims.iat + 60 }), 'assets'), /声明无效/)
  await assert.rejects(f.service.verify(await signed(claims, { ...protectedHeader, typ: 'status+jwt' }), 'assets'), /令牌无效/)
  await assert.rejects(f.service.verify(await signed({ ...claims, aud: [claims.aud, 'https://other.example/'] }), 'assets'), /声明无效/)
  state.credentials[0].expiresAt = 'not-a-date'; writeFileSync(statePath, JSON.stringify(state))
  assert.throws(() => f.service.authenticate(f.a.credential.clientId, f.a.secret), /无效/)
})

test('上游 HTTP 重定向不会将原生凭据发送到其他目标', async t => {
  const f = await fixture(t); let received = 0
  const trap = createServer((req, res) => { received++; res.end('unexpected') })
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening'); t.after(() => { trap.closeAllConnections(); trap.close() })
  const redirect = createServer((req, res) => { assert.equal(req.headers.authorization, 'Bearer native-only'); res.writeHead(302, { location: `http://127.0.0.1:${trap.address().port}/capture` }); res.end() })
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening'); t.after(() => { redirect.closeAllConnections(); redirect.close() })
  const path = join(f.root, 'config/business-access.json'), config = JSON.parse(readFileSync(path, 'utf8'))
  config.agentAccess.resources[0].endpoint = `http://127.0.0.1:${redirect.address().port}`; writeFileSync(path, JSON.stringify(config))
  const token = (await f.issue()).access_token
  await assert.rejects(f.service.dispatch(token, 'assets', 'get_asset', { id: 'A' }, new AbortController().signal), /结果待确认/)
  assert.equal(received, 0); assert.equal(f.count(), 0)
})

test('凭据正常轮换的旧 key 在十分钟窗口后不可再认证或签发', async t => {
  const f = await fixture(t), next = f.service.createCredential('agent-a', true)
  assert.equal(f.service.authenticate(f.a.credential.clientId, f.a.secret).id, f.a.credential.id)
  f.advance(600001)
  assert.throws(() => f.service.authenticate(f.a.credential.clientId, f.a.secret), /失效/)
  assert.equal((await f.issue(next)).token_type, 'Bearer')
})

test('手改登记目标后自助状态保留验证时间但显示绑定证据失效', async t => {
  const f = await fixture(t), observedAt = new Date().toISOString()
  const instance = { id: 'agent-a', state: 'registered', framework: 'opencode', endpoint: f.resources[0].endpoint, agentId: 'sample-agent', revision: 1 }
  instance.bindingDigest = externalBindingDigest(f.root, instance)
  instance.verification = { ok: true, bindingDigest: instance.bindingDigest, observedAt }
  const path = join(f.root, 'config/external-instances.json'), registry = { schemaVersion: 1, agents: [], requests: [], instances: [instance] }
  writeFileSync(path, JSON.stringify(registry))
  const service = new AgentAccessService(f.root)
  assert.equal(service.selfStatus(f.a.credential.clientId, f.a.secret).runtimeEvidence.endpointVerified, true)
  instance.endpoint = 'http://changed.example/'; writeFileSync(path, JSON.stringify(registry))
  const status = service.selfStatus(f.a.credential.clientId, f.a.secret)
  assert.equal(status.requestAuthentication.result, 'verified')
  assert.equal(status.runtimeEvidence.endpointVerified, false)
  assert.equal(status.runtimeEvidence.endpointVerificationState, 'stale')
  assert.equal(status.runtimeEvidence.lastEndpointVerificationAt, observedAt)
  await assert.rejects(service.issue(f.a.credential.clientId, f.a.secret, f.resources[0].audience, ['assets:read']), /尚未验证/)
})

test('connector 丢弃被授予版本撤销的缓存，恢复授予后无需等待 token 到期', async t => {
  const f = await fixture(t), handler = createAgentAccessHandler(f.root, f.options)
  const server = createServer(async (req, res) => { await handler(req, res) }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`, secretFile = join(f.root, 'connector.secret')
  writeFileSync(secretFile, f.a.secret, { mode: 0o600 })
  const connector = createResourceConnector({ instanceId: 'agent-a', clientId: f.a.credential.clientId, secretFile, tokenEndpoint: `${base}/oauth/token`, resourceUrl: `${base}/api/agent-access/v1/resources/assets/mcp`, audience: f.resources[0].audience, scopes: ['assets:read'] })
  connector.server.listen(0, '127.0.0.1'); await once(connector.server, 'listening'); t.after(() => { connector.server.closeAllConnections(); connector.server.close() })
  const call = () => fetch(`http://127.0.0.1:${connector.server.address().port}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_asset', arguments: { id: 'A' } } }) })
  assert.equal((await call()).status, 200)
  const grant = enabled => f.service.saveGrant({ instanceId: 'agent-a', resourceId: 'assets', scopes: ['assets:read'], objects: ['A'], enabled, revision: f.service.status('agent-a').revision })
  grant(false); assert.equal((await call()).status, 503); assert.equal(f.count(), 1)
  grant(true); assert.equal((await call()).status, 200); assert.equal(f.count(), 2)
})
