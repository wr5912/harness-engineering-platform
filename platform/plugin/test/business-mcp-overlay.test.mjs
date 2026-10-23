import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { getBusinessControl } from '../lib/business-control.js'
import { resolveBusinessInstance } from '../lib/business-gateway.js'
import { McpConfigStore } from '../src/mcp/store.ts'

const sdkRequire = createRequire(process.env.HARNESS_DSH_ENTRY || new URL('../package.json', import.meta.url))
const [{ Context }, { SystemPrompt }, { ToolRuntime }, { createScope, scopeParentOf }] = await Promise.all([
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/cordis')).href),
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-system-prompt')).href),
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-tools')).href),
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-scope')).href),
])

test('受控业务仅投影 Candidate 重叠连接，平台保存收缩新目录并拒绝旧分组目标', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-mcp-overlay-'))
  const previousRoot = process.env.HARNESS_ASSET_ROOT
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_ASSET_ROOT = root
  process.env.HARNESS_DSH_ENTRY ??= new URL('../package.json', import.meta.url).pathname
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HARNESS_ASSET_ROOT
    else process.env.HARNESS_ASSET_ROOT = previousRoot
    if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY
    else process.env.HARNESS_DSH_ENTRY = previousEntry
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, '.local', 'credentials'), { recursive: true })
  writeFileSync(join(root, 'config', 'sites.json'), JSON.stringify({ platform: '/hep/' }))
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: false,
    agents: [], gateway: { managementUrl: 'http://127.0.0.1:18120/hep/' } }))
  const publicFile = join(root, 'config', 'mcp-manager.json')
  const secretFile = join(root, '.local', 'credentials', 'mcp-manager.json')
  const sourceA = 'http://127.0.0.1:18101/openapi.json'
  const sourceB = 'http://127.0.0.1:18102/openapi.json'
  const secret = 'fixture-private-credential'
  const platformServers = [
    { id: 'source', serverName: 'platform-label', enabled: true, specUrl: sourceA,
      authType: 'credential', tools: { mode: 'selected', names: ['echo', 'platform-only'] } },
    { id: 'platform-only', enabled: true, url: 'http://127.0.0.1:18103/mcp', tools: { mode: 'all', names: [] } },
  ]
  writeFileSync(publicFile, JSON.stringify({ schemaVersion: 1, servers: platformServers, groups: [
    { id: 'platform-only-group', members: [{ serverId: 'platform-only', names: ['write'] }] },
  ] }))
  writeFileSync(secretFile, JSON.stringify({ schemaVersion: 1, sharedToken: 'a'.repeat(64),
    servers: { source: { apiKey: secret } } }), { mode: 0o600 })
  const candidate = [
    { id: 'source', serverName: 'candidate-label', enabled: true, specUrl: 'http://127.0.0.1:1/old.json',
      tools: { mode: 'selected', names: ['echo', 'candidate-only'] } },
    { id: 'candidate-only', serverName: 'candidate-only', enabled: false,
      url: 'http://old-host:18120/hep/mcp/groups/candidate-only/v2', tools: { mode: 'all', names: [] } },
  ]
  const candidateGroups = [{ id: 'candidate-group', members: [{ serverId: 'source', names: ['echo'] }] }]
  const events = []
  const businessRuntime = { groupUrl: id => `http://127.0.0.1:18120/hep/mcp/groups/${id}/v2`, groupFetch: () => fetch }
  const context = {
    get: name => name === 'businessRuntime' ? businessRuntime : undefined,
    effect: effect => effect(),
    on: name => events.push(name),
    provide(name, value) { this[name] = value },
    webServer: { publicPath: path => path, register: () => () => {} },
    connection: { requestRejection: () => undefined },
  }
  const { apply } = await import('../lib/mcp-manager.js')
  apply(context, { servers: { get: () => candidate }, groups: { get: () => candidateGroups },
    sharedToken: { get: () => 'b'.repeat(64) } })
  assert.ok(events.includes('agent/created'), '业务 Runtime 必须保留新 Session 自动装载')
  assert.equal(context.platformMcp.configuration, undefined, '业务 Runtime 不提供平台编辑入口')
  const projected = context.platformMcp.servers.get()
  assert.deepEqual(projected.map(server => server.id), ['source', 'candidate-only'])
  assert.equal(projected[0].serverName, 'candidate-label')
  assert.equal(projected[0].specUrl, sourceA)
  assert.deepEqual(projected[0].tools, { mode: 'selected', names: ['echo'] })
  assert.equal(projected[1].url, businessRuntime.groupUrl('candidate-only'), '分组身份不变，旧宿主地址由当前平台入口派生')
  assert.equal(createHash('sha256').update(projected[0].apiKey).digest('hex'), createHash('sha256').update(secret).digest('hex'))
  assert.equal(context.mcpSessionManager.currentGroup('platform-only-group', 2), undefined)
  const oldDigest = context.mcpSessionManager.currentGroup('candidate-group', 2).targetDigest
  const store = new McpConfigStore(root, () => {})
  let view = store.view()
  view = store.mutate([{ op: 'set', path: ['servers', '0', 'specUrl'], value: sourceB },
    { op: 'set', path: ['servers', '0', 'apiKey'], value: 'fixture-replaced-credential' }], view.revision)
  assert.equal(context.platformMcp.servers.get()[0].specUrl, sourceB, '保存后新目录应使用平台当前目标')
  assert.notEqual(context.mcpSessionManager.currentGroup('candidate-group', 2).targetDigest, oldDigest)
  await assert.rejects(context.mcpSessionManager.callGroupTool('candidate-group', 2, 'source__echo', {},
    { 'io.deepseek.dsh/mcp-group-target': { version: 2, digest: oldDigest } }), /MCP 分组目标已变化/)
  assert.ok(!readFileSync(publicFile, 'utf8').includes(secret))
  assert.ok(!readFileSync(publicFile, 'utf8').includes('fixture-replaced-credential'))
  assert.equal(statSync(secretFile).mode & 0o777, 0o600)
  view = store.mutate([{ op: 'set', path: ['servers', '0', 'enabled'], value: false }], view.revision)
  assert.equal(context.platformMcp.servers.get()[0].enabled, false)
  await assert.rejects(context.mcpSessionManager.callGroupTool('candidate-group', 2, 'source__echo', {},
    { 'io.deepseek.dsh/mcp-group-target': { version: 2, digest: oldDigest } }), /MCP 分组目标已变化/)
  store.mutate([{ op: 'set', path: ['servers'], value: platformServers.slice(1) }], view.revision)
  assert.equal(context.platformMcp.servers.get()[0].enabled, false, '平台服务移除后不能回退 Candidate 旧地址')
  assert.equal(context.platformMcp.servers.get()[0].specUrl, undefined)
  const restarted = { get: context.get, effect: context.effect, on: context.on,
    provide: context.provide, webServer: context.webServer, connection: context.connection }
  apply(restarted, { servers: { get: () => candidate }, groups: { get: () => candidateGroups },
    sharedToken: { get: () => 'b'.repeat(64) } })
  assert.equal(restarted.platformMcp.servers.get()[0].enabled, false, '业务实例重启时缺少同 ID 平台服务仍须停用')
  assert.equal(restarted.platformMcp.servers.get()[0].specUrl, undefined)
  assert.equal(restarted.platformMcp.servers.get()[1].url, businessRuntime.groupUrl('candidate-only'), '重启仍使用当前平台入口')
})

test('平台保存后的新业务 Session 装载当前连接，旧 Session 在目标变化和停用时拒绝调用', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-mcp-session-'))
  const previousRoot = process.env.HARNESS_ASSET_ROOT
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_ASSET_ROOT = root
  process.env.HARNESS_DSH_ENTRY ??= new URL('../package.json', import.meta.url).pathname
  let loaded, services
  const ctx = new Context()
  const scopes = []
  t.after(async () => {
    for (const scope of scopes) await scope.dispose()
    await loaded?.dispose()
    await services?.dispose()
    await ctx.fiber.dispose()
    if (previousRoot === undefined) delete process.env.HARNESS_ASSET_ROOT
    else process.env.HARNESS_ASSET_ROOT = previousRoot
    if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY
    else process.env.HARNESS_DSH_ENTRY = previousEntry
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, '.local', 'credentials'), { recursive: true })
  mkdirSync(join(root, '.local', 'instances', 'soc-instance'), { recursive: true })
  const calls = []
  let origin
  const source = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/a/openapi.json' || request.url === '/b/openapi.json') {
      const prefix = request.url.slice(0, 2)
      return response.end(JSON.stringify({ openapi: '3.0.0', info: { title: '业务来源', version: '1' },
        servers: [{ url: origin }], paths: { [`${prefix}/echo`]: { get: { operationId: 'echo', responses: { 200: { description: 'ok' } } } } } }))
    }
    if (request.url === '/trust') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      return response.end(JSON.stringify({ valid: true, subjectId: body.subjectId,
        expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    }
    if (request.url === '/b/echo') {
      calls.push({ path: request.url, hasCurrentCredential: request.headers.authorization?.includes('fixture-current-private') === true })
      return response.end(JSON.stringify({ reached: 'b' }))
    }
    response.writeHead(404).end()
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  t.after(async () => { source.closeAllConnections(); await new Promise(resolve => source.close(resolve)) })
  origin = `http://127.0.0.1:${source.address().port}`
  const publicFile = join(root, 'config', 'mcp-manager.json')
  const secretFile = join(root, '.local', 'credentials', 'mcp-manager.json')
  writeFileSync(publicFile, JSON.stringify({ schemaVersion: 1, servers: [
    { id: 'source', serverName: 'platform-name', enabled: true, specUrl: `${origin}/a/openapi.json`,
      authType: 'credential', tools: { mode: 'all', names: [] } },
    { id: 'extra', enabled: true, url: 'http://127.0.0.1:1/mcp', tools: { mode: 'all', names: [] } },
  ], groups: [] }))
  writeFileSync(secretFile, JSON.stringify({ schemaVersion: 1, sharedToken: 'a'.repeat(64),
    servers: { source: { apiKey: 'fixture-old-private' } } }), { mode: 0o600 })
  const sourceDigest = `sha256:${'a'.repeat(64)}`
  writeFileSync(join(root, '.local', 'instances', 'soc-instance', 'instance.json'), JSON.stringify({ asset_root: root,
    agent_id: 'soc', web_base_path: '/agents/soc/instances/soc-instance/',
    business_control: { runtime_generation: 'generation-1', source_digest: sourceDigest, origin: 'http://127.0.0.1:44001' } }))
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    agents: [{ agentId: 'soc', enabled: true, subjects: ['A'], actions: ['*'], sourceDigest }],
    authentication: { endpoint: `${origin}/authenticate` },
    identityTrust: { endpoint: `${origin}/trust` },
    operations: [{ serverId: 'source', operationId: 'echo', kind: 'resource', target: `${origin}/b/echo`, method: 'GET' }],
    gateway: { instances: [{ agentId: 'soc', instanceId: 'soc-instance', sourceDigest }],
      sharedSecretFile: join(root, 'business.secret'), managementUrl: 'http://127.0.0.1:18120/hep/' },
  }))
  writeFileSync(join(root, 'config', 'sites.json'), JSON.stringify({ platform: '/hep/' }))
  writeFileSync(join(root, 'business.secret'), randomBytes(48))
  const { binding } = resolveBusinessInstance(root, { agentId: 'soc', instanceId: 'soc-instance' })
  const control = getBusinessControl(root)
  control.setAvailable(true)
  control.registerInstance(binding)
  control.recordAgentAuthentication(binding)
  const snapshot = control.issueSnapshot(binding.instanceId)
  control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId)
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const identity = { subject: { id: 'A', kind: 'human', identitySource: origin },
    evidence: { issuer: origin, externalSubject: 'A', method: 'fixture', verifiedAt: new Date().toISOString(), expiresAt }, expiresAt }
  const base = control.createContext(identity, binding)
  const candidate = [{ id: 'source', serverName: 'candidate-name', enabled: true,
    specUrl: 'http://127.0.0.1:1/old.json', tools: { mode: 'selected', names: ['echo'] } }]
  services = ctx.plugin({ name: 'business-mcp-overlay-services', apply(inner) {
    inner.provide('webServer', { publicPath: path => path, register: () => () => {} })
    inner.provide('connection', { requestRejection: () => undefined })
    inner.provide('businessRuntime', { binding, groupUrl: id => `${origin}/mcp/groups/${id}/v2`, groupFetch: () => fetch })
    new SystemPrompt(inner, {})
    new ToolRuntime(inner, { mode: 'native' })
  } })
  await services
  const businessManager = await import('../lib/mcp-manager.js')
  loaded = ctx.plugin({ name: 'business-mcp-overlay-test', inject: ['businessRuntime', 'webServer', 'connection', 'tools'],
    apply(inner) { businessManager.apply(inner, { servers: { get: () => candidate }, groups: { get: () => [] },
      sharedToken: { get: () => 'b'.repeat(64) } }) } })
  await loaded
  const preset = {}
  async function newSession(id) {
    const agent = { id, session: { id } }
    const scope = createScope(ctx, agent, { parent: preset })
    agent.ctx = scope.ctx
    assert.equal(scopeParentOf(agent), preset)
    scopes.push(scope)
    control.bindSession(base, id)
    await ctx.serial('agent/created', { agent })
    return agent
  }
  const name = 'mcp__candidate-name__echo'
  async function waitForTool(agent, previous) {
    for (let i = 0; i < 300 && (!ctx.tools.get(name, agent) || ctx.tools.get(name, agent) === previous); i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(ctx.tools.get(name, agent), '后台发现完成后应注册工具')
    assert.notEqual(ctx.tools.get(name, agent), previous)
  }
  const first = await newSession('session-A')
  await waitForTool(first)
  assert.ok(ctx.mcpSessionManager, '业务 manager 应完成装载')
  assert.deepEqual(ctx.platformMcp.servers.get().map(server => server.id), ['source'])
  assert.ok(ctx.tools.get(name, first), `首个 Session 装载 Candidate 固定工具名，当前工具=${JSON.stringify(ctx.tools.schemas(first).map(tool => tool.name))}`)
  assert.equal(ctx.tools.get('mcp__platform-name__echo', first), undefined)
  assert.equal(ctx.tools.get('mcp__extra__echo', first), undefined)
  const store = new McpConfigStore(root, () => {})
  const previousTool = ctx.tools.get(name, first)
  let view = store.view()
  view = store.mutate([{ op: 'set', path: ['servers', '0', 'specUrl'], value: `${origin}/b/openapi.json` },
    { op: 'set', path: ['servers', '0', 'apiKey'], value: 'fixture-current-private' }], view.revision)
  const oldCall = await ctx.tools.execute({ name, arguments: {}, callId: 'old-call', agent: first,
    signal: new AbortController().signal })
  assert.equal(oldCall.isError, true)
  assert.match(JSON.stringify(oldCall), /目标已变化|已停用/)
  assert.deepEqual(calls, [], '旧 Session 不得触达新目标')
  const second = await newSession('session-B')
  await waitForTool(second, previousTool)
  assert.ok(ctx.tools.get(name, second), '保存后新 Session 保留 Candidate 工具名并装载新目标')
  const currentCall = await ctx.tools.execute({ name, arguments: {}, callId: 'current-call', agent: second,
    signal: new AbortController().signal })
  assert.equal(currentCall.isError, false, JSON.stringify(currentCall))
  assert.deepEqual(calls, [{ path: '/b/echo', hasCurrentCredential: true }])
  assert.ok(!readFileSync(publicFile, 'utf8').includes('fixture-current-private'))
  assert.equal(statSync(secretFile).mode & 0o777, 0o600)
  view = store.mutate([{ op: 'set', path: ['servers', '0', 'enabled'], value: false }], view.revision)
  const disabledCall = await ctx.tools.execute({ name, arguments: {}, callId: 'disabled-call', agent: second,
    signal: new AbortController().signal })
  assert.equal(disabledCall.isError, true)
  assert.match(JSON.stringify(disabledCall), /目标已变化|已停用/)
  assert.equal(calls.length, 1, '平台停用后旧 Session 不得继续触达目标')
  const third = await newSession('session-C')
  for (let i = 0; i < 300 && ctx.tools.get(name, third); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(ctx.tools.get(name, third), undefined, '停用后的新 Session 不得装载工具')
})
