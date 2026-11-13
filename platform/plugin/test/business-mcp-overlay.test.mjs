import { executeNative } from './fixtures/native-tool.mjs'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// 沿用现有MCP测试的来源夹具，只在临时目录转译待测模块，不写lib/business制品。
async function sourceManager(t) {
  const directory = mkdtempSync(join(tmpdir(), 'business-manager-source-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  const { managerSources } = await import('../build.mjs')
  const output = join(directory, 'manager.mjs')
  await build({ entryPoints: [new URL('../src/mcp/manager.ts', import.meta.url).pathname], outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources],
    define: { __PLATFORM_MCP_IMPLEMENTATION_DIGEST__: JSON.stringify('fixture-only-source-module') } })
  return import(pathToFileURL(output).href)
}
import { configureBusinessControlStateRoot, getBusinessControl, sharedInstanceIdentity } from '../lib/business-control.js'
import { resolveBusinessInstance } from '../lib/business-gateway.js'
import { McpConfigStore } from '../src/mcp/store.ts'
import { mcpCredentialPaths } from '../src/mcp/credential-path.ts'
import { runtimeModule } from '../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'

const [{ Context }, { SystemPrompt }, { ToolRuntime }, { apply: applyNativeToolExecutor }, { createScope, scopeParentOf }] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-scope',
].map(name => runtimeModule(name)))

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
  mkdirSync(mcpCredentialPaths(root).directory, { recursive: true })
  const stateRoot = mkdtempSync(join(tmpdir(), 'business-mcp-state-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  configureBusinessControlStateRoot(root, stateRoot)
  const binding = { workspaceId: 'workspace-fixture', agentId: 'soc', instanceId: 'soc-instance',
    runtimeGeneration: 'generation-1', sourceDigest: `sha256:${'a'.repeat(64)}` }
  writeFileSync(join(root, 'config', 'sites.json'), JSON.stringify({ platform: '/hep/' }))
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: false,
    agents: [], gateway: { managementUrl: 'http://127.0.0.1:18120/hep/', instances: [
      { agentId: binding.agentId, instanceId: binding.instanceId, sourceDigest: binding.sourceDigest,
        accessMode: 'anonymous', identityMode: 'published' },
    ] } }))
  const control = getBusinessControl(root)
  control.registerInstance(binding)
  control.bindSession(control.createContext(sharedInstanceIdentity(binding), binding), 'session-fixture')
  const execution = { agent: { session: { id: 'session-fixture' } }, callId: 'fixture-call' }
  const publicFile = join(root, 'config', 'mcp-manager.json')
  const secretFile = mcpCredentialPaths(root).file
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
  const { apply } = await sourceManager(t)
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
    { 'io.deepseek.dsh/mcp-group-target': { version: 2, digest: oldDigest } }, execution), /MCP 分组目标已变化/)
  assert.ok(!readFileSync(publicFile, 'utf8').includes(secret))
  assert.ok(!readFileSync(publicFile, 'utf8').includes('fixture-replaced-credential'))
  assert.equal(statSync(secretFile).mode & 0o777, 0o600)
  view = store.mutate([{ op: 'set', path: ['servers', '0', 'enabled'], value: false }], view.revision)
  assert.equal(context.platformMcp.servers.get()[0].enabled, false)
  await assert.rejects(context.mcpSessionManager.callGroupTool('candidate-group', 2, 'source__echo', {},
    { 'io.deepseek.dsh/mcp-group-target': { version: 2, digest: oldDigest } }, execution), /MCP 分组目标已变化/)
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
  assert.deepEqual(readdirSync(root).sort(), ['.local', 'config'])
  assert.deepEqual(readdirSync(join(root, '.local')), ['credentials'])
  assert.deepEqual(readdirSync(join(root, '.local/credentials')), ['mcp-manager'])
})

test('平台保存后的新业务 Session 装载当前连接，旧 Session 在目标变化和停用时拒绝调用', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'business-mcp-session-'))
  const root = join(directory, 'runtime-inputs')
  mkdirSync(root)
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
    rmSync(directory, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'config'))
  mkdirSync(mcpCredentialPaths(root).directory, { recursive: true })
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
  const secretFile = mcpCredentialPaths(root).file
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
      sharedSecretFile: join(directory, 'business.secret'), managementUrl: 'http://127.0.0.1:18120/hep/' },
  }))
  writeFileSync(join(root, 'config', 'sites.json'), JSON.stringify({ platform: '/hep/' }))
  writeFileSync(join(directory, 'business.secret'), randomBytes(48))
  const { binding } = resolveBusinessInstance(root, { agentId: 'soc', instanceId: 'soc-instance' })
  rmSync(join(root, '.local/instances'), { recursive: true })
  configureBusinessControlStateRoot(root, join(directory, 'business-state'))
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
    new ToolRuntime(inner); applyNativeToolExecutor(inner)
  } })
  await services
  const businessManager = await sourceManager(t)
  loaded = ctx.plugin({ name: 'business-mcp-overlay-test', inject: ['businessRuntime', 'webServer', 'connection', 'tools'],
    apply(inner) { businessManager.apply(inner, { servers: { get: () => candidate }, groups: { get: () => [] },
      sharedToken: { get: () => 'b'.repeat(64) } }) } })
  await loaded
  const preset = {}
  // 源码转译/后台发现可能超过控制通道2秒租期；夹具模拟真实网关心跳，不改生产期限或拒绝断言。
  function heartbeat() {
    control.recordAgentAuthentication(binding)
    const current = control.issueSnapshot(binding.instanceId)
    control.acknowledge(binding.instanceId, current.restrictionVersion, current.leaseId)
  }
  async function newSession(id) {
    heartbeat()
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
  heartbeat()
  const oldCall = await executeNative(ctx, { name, arguments: {}, callId: 'old-call', agent: first,
    signal: new AbortController().signal })
  assert.equal(oldCall.isError, true)
  assert.match(JSON.stringify(oldCall), /目标已变化|已停用|连接或工具范围已变化/)
  assert.deepEqual(calls, [], '旧 Session 不得触达新目标')
  const second = await newSession('session-B')
  await waitForTool(second, previousTool)
  assert.ok(ctx.tools.get(name, second), '保存后新 Session 保留 Candidate 工具名并装载新目标')
  heartbeat()
  const currentCall = await executeNative(ctx, { name, arguments: {}, callId: 'current-call', agent: second,
    signal: new AbortController().signal })
  assert.equal(currentCall.isError, false, JSON.stringify(currentCall))
  assert.deepEqual(calls, [{ path: '/b/echo', hasCurrentCredential: true }])
  assert.ok(!readFileSync(publicFile, 'utf8').includes('fixture-current-private'))
  assert.equal(statSync(secretFile).mode & 0o777, 0o600)
  view = store.mutate([{ op: 'set', path: ['servers', '0', 'enabled'], value: false }], view.revision)
  heartbeat()
  const disabledCall = await executeNative(ctx, { name, arguments: {}, callId: 'disabled-call', agent: second,
    signal: new AbortController().signal })
  assert.equal(disabledCall.isError, true)
  assert.match(JSON.stringify(disabledCall), /目标已变化|已停用|连接或工具范围已变化/)
  assert.equal(calls.length, 1, '平台停用后旧 Session 不得继续触达目标')
  const third = await newSession('session-C')
  for (let i = 0; i < 300 && ctx.tools.get(name, third); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(ctx.tools.get(name, third), undefined, '停用后的新 Session 不得装载工具')
  assert.deepEqual(readdirSync(root).sort(), ['.local', 'config'], '业务读取根仅含真实挂载输入，不含 workspace.json/研究材料')
  assert.deepEqual(readdirSync(join(root, '.local')), ['credentials'])
  assert.deepEqual(readdirSync(join(root, '.local/credentials')), ['mcp-manager'])
})

test('显式组引用仅投影所选成员，缺组/成员/取消/未知Session不分发且不新增主子客户端', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-group-reference-'))
  const previousRoot = process.env.HARNESS_ASSET_ROOT, previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_ASSET_ROOT = root
  process.env.HARNESS_DSH_ENTRY ??= new URL('../package.json', import.meta.url).pathname
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HARNESS_ASSET_ROOT; else process.env.HARNESS_ASSET_ROOT = previousRoot
    if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'config'))
  mkdirSync(mcpCredentialPaths(root).directory, { recursive: true })
  writeFileSync(mcpCredentialPaths(root).file, JSON.stringify({ schemaVersion: 1, sharedToken: 'a'.repeat(64), servers: { member: { apiKey: 'fixture-private' } } }))
  writeFileSync(join(root, 'config/sites.json'), JSON.stringify({ platform: '/hep/' }))
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: false, agents: [],
    gateway: { managementUrl: 'http://127.0.0.1:18120/hep/', instances: [{ agentId: 'soc', instanceId: 'fixture', sourceDigest: 'fixed', identityMode: 'development', accessMode: 'anonymous' }] } }))
  const names = ['one', 'two', 'three', 'four', 'five', 'six'], uri = 'http://fixture.invalid/tasks/{taskId}'
  const group = { id: 'declared-reference', members: [{ serverId: 'member', names, resourceUris: [], resourceTemplates: [uri] }] }
  const platform = { schemaVersion: 1, servers: [{ id: 'member', enabled: true, authType: 'credential', specUrl: 'http://fixture.invalid/openapi', tools: { mode: 'all', names: [] } }],
    groups: [group, { id: 'not-declared', members: [{ serverId: 'member', names: ['extra'] }] }] }
  const file = join(root, 'config/mcp-manager.json')
  writeFileSync(file, JSON.stringify(platform))
  const { apply, validateConfiguration } = await sourceManager(t)
  assert.throws(() => validateConfiguration({ servers: [], groups: [group], sharedToken: '' }), /分组成员/,
    '孤立旧种子在缺成员连接时确实非法，不能单独部署')
  const control = getBusinessControl(root), binding = { workspaceId: 'fixture-workspace', agentId: 'soc', instanceId: 'fixture', runtimeGeneration: 'one', sourceDigest: 'fixed' }
  control.registerInstance(binding)
  control.bindSession(control.createContext(sharedInstanceIdentity(binding), binding), 'fixture-session')
  const fetches = [], originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { fetches.push(args); throw new Error('fixture must not dispatch') }
  t.after(() => { globalThis.fetch = originalFetch })
  const handlers = {}, runtime = { groupUrl: id => `http://127.0.0.1:18120/hep/mcp/groups/${id}/v2`, groupFetch: () => fetch }
  const context = { get: key => key === 'businessRuntime' ? runtime : undefined, effect: create => create(),
    on(name, handler) { handlers[name] = handler }, provide(name, value) { this[name] = value },
    webServer: { publicPath: path => path, register: () => () => {} }, connection: { requestRejection: () => undefined } }
  const registered = []
  const agent = depth => ({ id: `agent-${depth}`, session: { id: 'fixture-session', header: { delegationDepth: depth } },
    ctx: { effect: create => create(), tools: { register: tool => { registered.push(tool.name); return () => {} } } } })
  apply(context, { servers: { get: () => [] }, groups: { get: () => [group] }, sharedToken: { get: () => '' } })
  assert.deepEqual(context.platformMcp.groups.get(), [group])
  assert.doesNotThrow(() => validateConfiguration({ servers: context.platformMcp.servers.get(),
    groups: context.platformMcp.groups.get(), sharedToken: '' }), '真实原生schema在依赖解析后通过，不放宽校验')
  assert.equal(context.platformMcp.servers.get().length, 1)
  assert.deepEqual(context.platformMcp.servers.get()[0].tools, { mode: 'selected', names })
  assert.equal(context.platformMcp.servers.get()[0].apiKey, 'fixture-private')
  assert.equal(context.mcpSessionManager.currentGroup('not-declared', 2), undefined)
  const target = context.mcpSessionManager.currentGroup(group.id, 2)
  assert.ok(target?.targetDigest)
  await handlers['agent/created']({ agent: agent(0) })
  await handlers['agent/created']({ agent: agent(1) })
  assert.deepEqual(registered, [], '主子均不额外挂载组内部来源')
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(context.mcpSessionManager.callGroupTool(group.id, 2, 'one', {},
    { 'io.deepseek.dsh/mcp-group-target': { version: 2, digest: target.targetDigest } },
    { agent: agent(0), callId: 'cancelled', signal: aborted.signal }), /abort/i)
  await assert.rejects(context.mcpSessionManager.callGroupTool(group.id, 2, 'one', {},
    { 'io.deepseek.dsh/mcp-group-target': { version: 2, digest: target.targetDigest } },
    { agent: { id: 'unknown', session: { id: 'unbound' } }, callId: 'unknown' }), /Session/)
  assert.deepEqual(fetches, [])
  globalThis.fetch = async (input, options) => {
    const url = String(input)
    assert.ok(url.startsWith('http://fixture.invalid/'), '禁止访问实际外部来源')
    if (url.endsWith('/openapi')) return Response.json({ openapi: '3.0.0', info: { title: 'fixture', version: '1' }, servers: [{ url: 'http://fixture.invalid' }],
      paths: Object.fromEntries([...names.map(name => [`/${name}`, { post: { operationId: name, responses: { 200: { description: 'ok' } } } }]),
        ['/tasks/{taskId}', { get: { operationId: 'task', parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } }]]) })
    fetches.push({ url, signal: options?.signal })
    return Response.json({ code: 200, data: { fixture: true } })
  }
  const directory = await context.mcpSessionManager.listGroupTools(group.id, 2)
  assert.equal(directory.tools.length, 7, '六个已选工具和单模板，不包含未声明平台组')
  assert.equal(directory.tools.filter(tool => tool._meta['io.deepseek.dsh/mcp-group-tool'].kind === 'template').length, 1)
  assert.ok(directory.tools.every(tool => tool._meta['io.deepseek.dsh/mcp-group-tool'].serverId === 'member'))
  const selected = directory.tools.find(tool => tool.name === 'one')
  await context.mcpSessionManager.callGroupTool(group.id, 2, selected.name, {}, selected._meta,
    { agent: agent(0), callId: 'fixture-leaf', signal: new AbortController().signal })
  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].url, 'http://fixture.invalid/one')
  fetches.length = 0
  for (const change of [() => { platform.groups = [] }, () => { platform.groups = [{ ...group, members: [] }] }, () => { platform.groups = [{ ...group, members: [] }]; platform.servers = [] }]) {
    change(); writeFileSync(file, JSON.stringify(platform))
    if (!platform.servers.length) writeFileSync(mcpCredentialPaths(root).file, JSON.stringify({ schemaVersion: 1, sharedToken: 'a'.repeat(64), servers: {} }))
    assert.deepEqual(context.platformMcp.groups.get(), [])
    assert.deepEqual(context.platformMcp.servers.get(), [])
    assert.equal(context.mcpSessionManager.currentGroup(group.id, 2), undefined)
  }
  assert.deepEqual(fetches, [])
})
