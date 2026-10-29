import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { getBusinessControl, withBusinessContext } from '../lib/business-control.js'
import { businessAssertionHeaders, businessRpcDigest, resolveBusinessInstance, signBusinessAssertion } from '../lib/business-gateway.js'

test('业务 RPC 摘要递归忽略对象键顺序，保留数组顺序与 JSON 序列化语义', () => {
  const first = { method: 'tools/call', params: { name: 'source__echo', arguments: { nested: { z: 1, a: 2 }, values: [1, 2] },
    _meta: { target: { version: 2, digest: 'fixed' } }, omitted: undefined } }
  const reordered = { method: 'tools/call', params: { _meta: { target: { digest: 'fixed', version: 2 } },
    arguments: { values: [1, 2], nested: { a: 2, z: 1 } }, name: 'source__echo' } }
  assert.equal(businessRpcDigest(first), businessRpcDigest(reordered))
  assert.equal(businessRpcDigest({ method: 'tools/call', params: { values: [undefined], omitted: undefined } }),
    businessRpcDigest({ method: 'tools/call', params: { values: [null] } }))
  assert.notEqual(businessRpcDigest(first), businessRpcDigest({ ...reordered,
    params: { ...reordered.params, arguments: { ...reordered.params.arguments, values: [2, 1] } } }))
})

test('v2 分组只接受固定实例签名与当前受信 Session，签名不降级也不可重放', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-group-v2-'))
  const previousRoot = process.env.HARNESS_ASSET_ROOT
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_ASSET_ROOT = root
  process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
  t.after(() => { if (previousRoot === undefined) delete process.env.HARNESS_ASSET_ROOT; else process.env.HARNESS_ASSET_ROOT = previousRoot
    if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry
    rmSync(root, { recursive: true, force: true }) })
  const { apply } = await import('../lib/mcp-manager.js')
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, '.local', 'instances', 'soc-instance'), { recursive: true })
  const secret = randomBytes(48), secretFile = join(root, 'business.secret')
  writeFileSync(secretFile, secret)
  writeFileSync(join(root, 'config', 'sites.json'), JSON.stringify({ platform: '/hep/' }))
  const sourceDigest = `sha256:${'a'.repeat(64)}`, generation = 'generation-1'
  writeFileSync(join(root, '.local', 'instances', 'soc-instance', 'instance.json'), JSON.stringify({
    asset_root: root, agent_id: 'soc', web_base_path: '/agents/soc/instances/soc-instance/', business_control: { runtime_generation: generation,
      source_digest: sourceDigest, origin: 'http://127.0.0.1:44001' },
  }))
  const sourceCalls = []
  const sourceServer = createServer(async (request, response) => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    response.setHeader('content-type', 'application/json')
    if (request.url === '/openapi.json') return response.end(JSON.stringify({ openapi: '3.0.0',
      info: { title: '业务来源', version: '1' }, servers: [{ url: sourceOrigin }], paths: {
        '/echo': { get: { operationId: 'echo', responses: { 200: { description: 'ok' } } } },
      } }))
    if (request.url === '/trust') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      return response.end(JSON.stringify({ valid: true, subjectId: body.subjectId, expiresAt }))
    }
    if (request.url === '/echo') {
      sourceCalls.push({ method: request.method, path: request.url })
      return response.end(JSON.stringify({ reached: true }))
    }
    response.writeHead(404).end()
  })
  await new Promise(resolve => sourceServer.listen(0, '127.0.0.1', resolve))
  t.after(async () => { sourceServer.closeAllConnections(); await new Promise(resolve => sourceServer.close(resolve)) })
  const sourceOrigin = `http://127.0.0.1:${sourceServer.address().port}`
  const access = { schemaVersion: 1, enabled: true,
    agents: [{ agentId: 'soc', enabled: true, subjects: ['A'], actions: ['*'], sourceDigest }],
    authentication: { endpoint: `${sourceOrigin}/authenticate` }, identityTrust: { endpoint: `${sourceOrigin}/trust` },
    operations: [{ serverId: 'source', operationId: 'echo', kind: 'resource', target: `${sourceOrigin}/echo`, method: 'GET' }],
    gateway: { instances: [{ agentId: 'soc', instanceId: 'soc-instance', sourceDigest }], sharedSecretFile: secretFile,
      managementUrl: 'http://127.0.0.1:44002/hep/#/gateway' },
  }
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(access))
  const routes = []
  const context = { webServer: { publicPath: path => `/hep${path}`, register: route => { routes.push({ ...route, path: `/hep${route.path}` }); return () => {} } },
    connection: { requestRejection: () => undefined, admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, effect: create => create(), on() {}, get: () => undefined,
    provide(name, value) { this[name] = value } }
  const servers = [{ id: 'source', serverName: 'display-source', enabled: true, specUrl: `${sourceOrigin}/openapi.json`,
    tools: { mode: 'all', names: [] } }, { id: 'unreachable', enabled: true, url: 'http://127.0.0.1:1/mcp',
    tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'soc-tools', members: [{ serverId: 'source', names: ['echo'],
    resourceUris: [`${sourceOrigin}/echo`] }, { serverId: 'unreachable', names: ['offline_tool'] }] }], token = 'a'.repeat(64)
  mkdirSync(join(root, '.local', 'credentials'), { recursive: true })
  writeFileSync(join(root, 'config', 'mcp-manager.json'), JSON.stringify({ schemaVersion: 1, servers, groups }))
  writeFileSync(join(root, '.local', 'credentials', 'mcp-manager.json'), JSON.stringify({ schemaVersion: 1,
    sharedToken: token, servers: {} }), { mode: 0o600 })
  apply(context, { servers: { get: () => servers }, groups: { get: () => groups }, sharedToken: { get: () => token } })
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const route = routes.find(item => url.pathname.startsWith(item.path))
    if (!route) return response.writeHead(404).end()
    request.url = request.url.slice('/hep'.length)
    return route.handler(request, response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const url = new URL(`http://127.0.0.1:${server.address().port}/hep/mcp/groups/soc-tools/v2`)
  access.gateway.managementUrl = `${url.origin}/hep/#/gateway`
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(access))
  const { binding } = resolveBusinessInstance(root, { agentId: 'soc', instanceId: 'soc-instance' })
  const control = getBusinessControl(root)
  control.setAvailable(true)
  control.registerInstance(binding)
  control.recordAgentAuthentication(binding)
  const snapshot = control.issueSnapshot(binding.instanceId)
  control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId)
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const identity = { subject: { id: 'A', kind: 'human', identitySource: sourceOrigin },
    evidence: { issuer: sourceOrigin, externalSubject: 'A', method: 'fixture', verifiedAt: new Date().toISOString(), expiresAt }, expiresAt }
  const base = control.createContext(identity, binding)
  const business = { ...base, scope: { ...base.scope, sessionId: 'session-A' } }
  // 此处仅借用 groupFetch，模拟真实 Runtime 独立运行的发布心跳。
  const heartbeat = setInterval(() => {
    if (control.isDevelopmentInstance(binding)) return
    control.recordAgentAuthentication(binding)
    const current = control.issueSnapshot(binding.instanceId)
    control.acknowledge(binding.instanceId, current.restrictionVersion, current.leaseId)
  }, 250)
  t.after(() => clearInterval(heartbeat))
  const signed = session => async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const body = method === 'POST' ? await new Request(input, init).clone().json() : undefined
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    for (const [key, value] of Object.entries(signBusinessAssertion(secret, { binding,
      ...(session ? { context: session } : {}), ...(body ? { requestDigest: businessRpcDigest(body) } : {}),
      issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') },
    method, url.pathname))) headers.set(key, value)
    return fetch(input, { ...init, headers })
  }
  const connect = async transport => {
    const client = new Client({ name: 'business-group-v2-test', version: '1' })
    await client.connect(transport)
    t.after(() => client.close())
    return client
  }
  const allowed = await connect(new StreamableHTTPClientTransport(url, { fetch: signed(business) }))
  assert.equal((await allowed.listResources()).resources.length, 1)
  const { BusinessConnection } = await import('../lib/business-runtime.js')
  control.bindSession(base, 'session-A')
  const runtimeFetch = BusinessConnection.prototype.groupFetch.call({ businessConfig: { assetRoot: root, binding, sharedSecretFile: secretFile },
    control, secret }, 'soc-tools', 'session-A')
  const throughRuntime = await connect(new StreamableHTTPClientTransport(url, { fetch: runtimeFetch }))
  const resources = (await throughRuntime.listResources()).resources
  assert.equal(resources.length, 1)
  assert.equal((await throughRuntime.listResources(undefined,
    { signal: new AbortController().signal, timeout: 20_000 })).resources.length, 1)
  assert.equal((await throughRuntime.listResourceTemplates(undefined,
    { signal: new AbortController().signal, timeout: 20_000 })).resourceTemplates.length, 0)
  const nativeMcp = createRequire(process.env.HARNESS_DSH_ENTRY)('@modelcontextprotocol/client')
  const nativeClient = new nativeMcp.Client({ name: 'native-business-test', version: '1' },
    { versionNegotiation: { mode: 'auto' } })
  await nativeClient.connect(new nativeMcp.StreamableHTTPClientTransport(url, { fetch: (input, init) => {
    control.recordAgentAuthentication(binding)
    const current = control.issueSnapshot(binding.instanceId)
    control.acknowledge(binding.instanceId, current.restrictionVersion, current.leaseId)
    return runtimeFetch(input, init)
  } }))
  t.after(() => nativeClient.close())
  assert.equal((await nativeClient.listResources(undefined,
    { signal: new AbortController().signal, timeout: 20_000 })).resources.length, 1)
  assert.equal((await nativeClient.listResourceTemplates(undefined,
    { signal: new AbortController().signal, timeout: 20_000 })).resourceTemplates.length, 0)
  const targetDigest = context.mcpSessionManager.currentGroup('soc-tools', 2).targetDigest
  const nativeResult = await nativeClient.callTool({ name: 'source__echo', arguments: { nested: { z: 1, a: 2 } },
    _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: targetDigest }, nested: { z: 1, a: 2 } } })
  assert.deepEqual(nativeResult.content, [{ type: 'text', text: '{"reached":true}' }])
  assert.equal((await nativeClient.readResource({ uri: resources[0].uri })).contents[0].text, '{"reached":true}')
  const toolResult = await throughRuntime.callTool({ name: 'source__echo', arguments: { nested: { z: 1, a: 2 } },
    _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: targetDigest }, nested: { z: 1, a: 2 } } })
  assert.deepEqual(toolResult.content, [{ type: 'text', text: '{"reached":true}' }], '真实 SDK callTool 应通过签名并派发到来源工具')
  assert.deepEqual(sourceCalls, Array.from({ length: 3 }, () => ({ method: 'GET', path: '/echo' })))
  assert.equal((await throughRuntime.readResource({ uri: resources[0].uri })).contents[0].text, '{"reached":true}')
  await assert.rejects(runtimeFetch(`${url.origin}/hep/mcp/groups/other/v2`, { method: 'POST' }), /目标已变化/)
  const absentSession = BusinessConnection.prototype.groupFetch.call({ businessConfig: { assetRoot: root, binding },
    control, secret }, 'soc-tools', 'session-missing')
  await assert.rejects(absentSession(url, { method: 'POST' }), /缺少当前 Session/)
  context.get = name => name === 'businessRuntime' ? { binding } : undefined
  const execute = sessionId => context.mcpSessionManager.callGroupTool('soc-tools', 2, 'unknown', {}, undefined,
    { agent: { session: { id: sessionId } }, callId: 'tool-call', signal: new AbortController().signal })
  await assert.rejects(withBusinessContext(business, () => execute('missing')), /缺少受信 Session 归属/)
  control.bindSession(base, 'session-B')
  await assert.rejects(withBusinessContext(business, () => execute('session-B')), /Session 与当前上下文不一致/)
  await assert.rejects(withBusinessContext({ ...business, subject: { ...business.subject, id: 'other-subject' } },
    () => execute('session-A')), /主体或实例与当前上下文不一致/)
  context.get = () => undefined
  const startupOnly = await connect(new StreamableHTTPClientTransport(url, { fetch: signed(undefined) }))
  const startupTools = await startupOnly.listTools()
  const expectedNames = startupTools.tools.map(tool => tool.name)
  assert.deepEqual(expectedNames, ['echo'])
  assert.deepEqual(startupTools.tools[0]._meta['io.deepseek.dsh/mcp-group-tool'], {
    serverId: 'source', kind: 'tool', sourceName: 'echo',
  })
  const discovery = await (await fetch(new URL('/hep/api/mcp-manager', url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test', serverId: 'source' }) })).json()
  assert.equal(discovery.resources.resources[0].groupToolName, 'echo')
  const resourceAlias = `source__resource_echo_${createHash('sha256').update('r\0' + sourceOrigin + '/echo').digest('hex').slice(0, 12)}`
  assert.equal((await throughRuntime.callTool({ name: resourceAlias, arguments: {},
    _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: targetDigest } } })).content[0].text, '{"reached":true}')
  assert.deepEqual(startupTools._meta['io.deepseek.dsh/mcp-group-discovery'], { unavailable: ['unreachable'] })
  await assert.rejects(startupOnly.listResources())
  const bearerOnly = await connect(new StreamableHTTPClientTransport(url,
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  assert.equal((await bearerOnly.listResources()).resources.length, 1)
  assert.equal((await bearerOnly.callTool({ name: 'source__echo', arguments: {} })).content[0].text, '{"reached":true}')
  assert.equal((await bearerOnly.readResource({ uri: resources[0].uri })).contents[0].text, '{"reached":true}')
  const legacy = await connect(new StreamableHTTPClientTransport(new URL(url.href.replace(/\/v2$/, '')),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  assert.equal((await legacy.callTool({ name: 'mcp__display-source__echo', arguments: {} })).content[0].text,
    '{"reached":true}', 'v1 Token 链接仍可调用旧名称')
  const headers = signBusinessAssertion(secret, { binding, issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') },
    'POST', url.pathname)
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} })
  const request = () => fetch(url, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body })
  assert.notEqual((await request()).status, 401)
  assert.equal((await request()).status, 401, '相同签名不得重复使用')
  const wrong = signBusinessAssertion(secret, { binding, issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') },
    'POST', '/hep/mcp/groups/other/v2')
  assert.equal((await fetch(url, { method: 'POST', headers: { ...wrong, Authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body })).status, 401)
  const changed = signBusinessAssertion(secret, { binding, context: business,
    requestDigest: businessRpcDigest({ method: 'resources/list' }), issuedAt: Date.now(),
    nonce: randomBytes(24).toString('base64url') }, 'POST', url.pathname)
  const replaced = await fetch(url, { method: 'POST', headers: { ...changed, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2,
    method: 'resources/read', params: { uri: 'mcp-group:/soc-tools/other/r/ZmFrZQ' } }) })
  assert.match(await replaced.text(), /业务 MCP 请求内容与签名不一致/, '签名后的 RPC 方法和参数不得替换')
  access.gateway.instances[0].sourceDigest = `sha256:${'f'.repeat(64)}`
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(access))
  const staleList = await signed(undefined)(url, { method: 'POST', headers: { 'content-type': 'application/json',
    accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3,
    method: 'tools/list', params: {} }) })
  assert.equal(staleList.status, 401, '实例来源 pin 变化后旧签名不得列出分组工具')
  access.gateway.instances[0].sourceDigest = sourceDigest
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(access))
  assert.deepEqual((await startupOnly.listTools()).tools.map(tool => tool.name), expectedNames)
  // 同一连接、同一工具与参数切换为开发模式；删除密钥并等待超过旧签名窗口。
  access.gateway.instances[0].identityMode = 'development'
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(access))
  rmSync(secretFile)
  await new Promise(resolve => setTimeout(resolve, 2100))
  const args = { nested: { z: 1, a: 2 } }
  for (const client of [throughRuntime, nativeClient]) {
    const result = await client.callTool({ name: 'echo', arguments: args,
      _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: targetDigest } } })
    assert.notEqual(result.isError, true)
    assert.equal(result.content[0].text, '{"reached":true}')
  }
  const unsignedHeaders = { ...businessAssertionHeaders({ binding, context: business }), Authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const devRequest = headers => fetch(url, { method: 'POST', headers, body })
  assert.notEqual((await devRequest(unsignedHeaders)).status, 401)
  assert.equal((await (await devRequest({ ...unsignedHeaders, Authorization: 'Bearer wrong' })).json()).stage, 'token')
  for (const key of ['workspaceId', 'runtimeGeneration', 'sourceDigest']) {
    const response = await devRequest({ ...unsignedHeaders, ...businessAssertionHeaders({ binding: { ...binding, [key]: 'wrong' }, context: business }) })
    assert.equal((await response.json()).stage, 'binding')
  }
  const withoutSession = await connect(new StreamableHTTPClientTransport(url, { fetch: BusinessConnection.prototype.groupFetch.call(
    { businessConfig: { assetRoot: root, binding }, control }, 'soc-tools') }))
  assert.deepEqual((await withoutSession.listTools()).tools.map(tool => tool.name), expectedNames)
  await assert.rejects(withoutSession.callTool({ name: 'echo', arguments: args }), /缺少受信 Session/)
  access.gateway.instances[0].identityMode = 'published'
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(access))
  assert.equal((await (await devRequest(unsignedHeaders)).json()).stage, 'signature', '发布模式不能沿用开发 Bearer 接入')
})
