import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { Client, StreamableHTTPClientTransport, UriTemplate } from '@modelcontextprotocol/client'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

async function waitFor(check) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(check(), '后台 MCP 工具状态应收敛')
}

async function managerModule(t) {
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_DSH_ENTRY ??= new URL('../package.json', import.meta.url).pathname
  t.after(() => { if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry })
  const directory = await mkdtemp(join(tmpdir(), 'mcp-group-v2-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  const source = await readFile(new URL('../build.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export const managerSource =')
  const end = source.indexOf('\nconst { name } =', start)
  assert.ok(start > 0 && end > start)
  const adapter = join(directory, 'adapter.mjs')
  await writeFile(adapter, "import { readFile } from 'node:fs/promises'; import { resolve } from 'node:path';\n"
    + source.slice(start, end).replace(/fileURLToPath\(new URL\('..\/..\/plugins\/mcp-manager', import.meta.url\)\)/,
      JSON.stringify(new URL('../../../plugins/mcp-manager', import.meta.url).pathname)))
  const { managerSources } = await import(pathToFileURL(adapter).href)
  const outfile = join(directory, 'manager.mjs')
  await build({ stdin: { contents: "export * from 'harness-mcp-manager-server'", resolveDir: process.cwd(), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources] })
  return import(pathToFileURL(outfile).href)
}

async function rawOpenApiModule(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-openapi-signal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const outfile = join(directory, 'openapi.mjs')
  await build({ entryPoints: [new URL('../../../plugins/mcp-manager/openapi.ts', import.meta.url).pathname],
    outfile, bundle: true, platform: 'node', format: 'esm' })
  return import(pathToFileURL(outfile).href)
}

async function serve(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => response.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

async function fixtureMcp(t, id, reads, resourceOnly = false, duplicateTools = false, state = {}) {
  return serve(t, async (req, res) => {
    if (state.hanging) return
    if (state.offline) return res.writeHead(503).end()
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name: id, version: '1' }, { capabilities: { ...(resourceOnly ? {} : { tools: {} }), resources: {} } })
      if (!resourceOnly) {
        mcp.server.setRequestHandler('tools/list', async () => ({ tools: state.tools ?? (duplicateTools
          ? [{ name: 'echo', inputSchema: { type: 'object' } }, { name: 'echo', inputSchema: { type: 'object' } }]
          : [{ name: 'echo', inputSchema: { type: 'object' } }]) }))
        mcp.server.setRequestHandler('tools/call', async request => ({ content: [{ type: 'text', text: `${id}:${request.params.arguments.value}` }] }))
      }
      mcp.server.setRequestHandler('resources/list', async () => ({ resources: [{ name: 'same', uri: 'fixture:/same' }] }))
      mcp.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [
        { name: 'item', uriTemplate: 'fixture:/item/{id}{?q}' },
        { name: 'pair', uriTemplate: 'fixture:/pair/{left,right}' },
      ] }))
      mcp.server.setRequestHandler('resources/read', async request => {
        reads.push({ id, uri: request.params.uri })
        return { contents: [{ uri: request.params.uri, text: id }] }
      })
      return mcp
    })
    try { await toNodeHandler(handler)(req, res) } finally { await handler.close() }
  })
}

test('v2 调用按来源路由，健康工具与资源工具不等待无关挂起成员', async t => {
  const manager = await managerModule(t), reads = [], other = { tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }
  const healthy = await fixtureMcp(t, 'healthy', reads)
  const hanging = await fixtureMcp(t, 'other', reads, false, false, other)
  const servers = [
    { id: 'healthy', enabled: true, url: healthy, tools: { mode: 'all', names: [] } },
    { id: 'other', enabled: true, url: hanging, tools: { mode: 'all', names: [] } },
  ]
  const groups = [{ id: 'isolation', members: [
    { serverId: 'healthy', names: ['echo'], resourceUris: ['fixture:/same'], resourceTemplates: [] },
    { serverId: 'other', names: ['slow'], resourceUris: [], resourceTemplates: [] },
  ] }]
  const { context } = await groupServer(t, manager, servers, groups)
  // 原生直接调用不要求先对全部成员做发现。
  other.hanging = true
  const call = (name, args) => context.mcpSessionManager.callGroupTool('isolation', 2, name, args, undefined, { signal: AbortSignal.timeout(1500) })
  assert.equal((await call('echo', { value: 'ok' })).content[0].text, 'healthy:ok')
  other.hanging = false
  const catalog = await context.mcpSessionManager.listGroupTools('isolation', 2)
  assert.ok(catalog.tools.some(tool => tool.name === 'same'))
  other.hanging = true
  assert.equal((await call('same', {})).content[0].text, 'healthy')
  await assert.rejects(call('slow', {}), /timeout|aborted/i, '只取消真正挂起的目标调用')
})

async function groupServer(t, manager, servers, groups, methods = [], rpcRequests = []) {
  const routes = []
  const origin = await serve(t, (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const route = routes.find(item => item.kind === 'exact' ? item.path === path : path.startsWith(item.path))
    if (!route) return response.writeHead(404).end()
    return route.handler(request, response)
  })
  const token = '0'.repeat(64)
  const context = { webServer: { register: route => { routes.push(route); return () => {} }, publicPath: path => `/hep${path}` },
    connection: { requestRejection: () => undefined }, effect: create => create(), on: () => {},
    provide(name, value) { this[name] = value } }
  manager.apply(context, { servers: { get: () => servers }, groups: { get: () => groups }, sharedToken: { get: () => token },
    groupUrl: id => new URL(`/mcp/groups/${id}/v2`, origin).href,
    withGroupRequest: (req, method, run, rpcRequest) => {
      if (req.url.endsWith('/v2')) { methods.push(method); rpcRequests.push(rpcRequest) }
      return run()
    } })
  const client = async version => {
    const value = new Client({ name: 'group-v2-test', version: '1' }, { versionNegotiation: { mode: 'auto' } })
    const path = `/mcp/groups/${groups[0].id}${version === 2 ? '/v2' : ''}`
    await value.connect(new StreamableHTTPClientTransport(new URL(path, origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    t.after(() => value.close())
    return value
  }
  return { origin, context, token, client, rpcRequests }
}

test('v2 分组名称与显示名解耦，资源代理隔离同 URI 来源并拒绝失效选择', async t => {
  const manager = await managerModule(t), reads = [], methods = []
  const first = await fixtureMcp(t, 'first', reads), second = await fixtureMcp(t, 'second', reads)
  const servers = [
    { id: 'alpha_id', serverName: 'DisplayOne', enabled: true, url: first, tools: { mode: 'all', names: [] } },
    { id: 'beta', serverName: 'DisplayTwo', enabled: true, url: second, tools: { mode: 'all', names: [] } },
  ]
  const groups = [{ id: 'ops', members: servers.map((server, index) => ({ serverId: server.id, names: index ? [] : ['echo'],
    resourceUris: ['fixture:/same', 'fixture:/missing'], resourceTemplates: ['fixture:/item/{id}{?q}'] })) }]
  const { origin, context, token, client, rpcRequests } = await groupServer(t, manager, servers, groups, methods)
  const paths = await (await fetch(`${origin}/api/mcp-manager`)).json()
  assert.equal(paths.groupPaths[0].v2Path, '/hep/mcp/groups/ops/v2')
  const forged = await fetch(`${origin}/mcp/groups/ops/v2`, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'X-Harness-Business-Signature': 'forged', 'content-type': 'application/json',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
  assert.equal(forged.status, 401, '签名无效不能回退到 Bearer')
  const v1 = await client(1), v2 = await client(2)
  assert.deepEqual((await v1.listTools()).tools.map(tool => tool.name), ['mcp__DisplayOne__echo'])
  const listed = await v2.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), ['echo'])
  assert.deepEqual(listed.tools[0]._meta[manager.GROUP_TOOL_META_KEY], { serverId: 'alpha_id', kind: 'tool', sourceName: 'echo' })
  assert.ok(listed._meta[manager.GROUP_DISCOVERY_META_KEY].unavailable.some(value => value.includes('工具名冲突：same')))
  assert.equal(listed.tools.length, 1)
  const digest = context.mcpSessionManager.currentGroup('ops', 2).targetDigest
  assert.equal(listed._meta['io.deepseek.dsh/mcp-group-target'].digest, digest)
  assert.equal((await v2.callTool({ name: 'alpha_0id__echo', arguments: { value: 'ok' },
    _meta: { 'io.deepseek.dsh/mcp-group-target': { digest } } })).content[0].text, 'first:ok')
  const resourceList = await v2.listResources()
  assert.deepEqual(resourceList._meta['io.deepseek.dsh/mcp-group-target'], { digest, version: 2 })
  const resources = resourceList.resources
  assert.equal(resources.length, 2)
  assert.notEqual(resources[0].uri, resources[1].uri)
  assert.equal(resources[0].uri.startsWith('mcp-group:/ops/alpha_id/r/'), true)
  assert.equal((await v2.readResource({ uri: resources[1].uri })).contents[0].text, 'second')
  const templateList = await v2.listResourceTemplates()
  assert.deepEqual(templateList._meta['io.deepseek.dsh/mcp-group-target'], { digest, version: 2 })
  const templates = templateList.resourceTemplates
  assert.equal(templates.length, 2)
  const proxy = new UriTemplate(templates[0].uriTemplate).expand({ id: 'host/1', q: 'a,b' })
  assert.equal((await v2.readResource({ uri: proxy })).contents[0].uri, proxy)
  assert.deepEqual(reads.at(-1), { id: 'first', uri: 'fixture:/item/host%2F1?q=a%2Cb' })
  const arrayProxy = new UriTemplate(templates[0].uriTemplate).expand({ id: 'host', q: ['a', 'b'] })
  await v2.readResource({ uri: arrayProxy })
  assert.deepEqual(reads.at(-1), { id: 'first', uri: 'fixture:/item/host?q=a,b' })
  await assert.rejects(v2.readResource({ uri: new UriTemplate(templates[0].uriTemplate).expand({ q: 'missing-id' }) }))
  await assert.rejects(v2.readResource({ uri: 'mcp-group:/wrong/alpha_id/r/' + Buffer.from('fixture:/same').toString('base64url') }))
  await assert.rejects(v2.readResource({ uri: 'mcp-group:/ops/alpha_id/r/' + Buffer.from('fixture:/missing').toString('base64url') }))
  assert.deepEqual(methods.slice(0, 5), ['tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list'])
  assert.deepEqual(rpcRequests.slice(0, 5).map(request => request.method), methods.slice(0, 5))
  assert.equal(rpcRequests[1].params.name, 'alpha_0id__echo')
  assert.equal(rpcRequests[3].params.uri, resources[1].uri)
  const before = digest, old = context.mcpSessionManager.currentGroup('ops').targetDigest
  servers[0].serverName = 'Renamed'
  assert.equal(context.mcpSessionManager.currentGroup('ops', 2).targetDigest, before)
  assert.notEqual(context.mcpSessionManager.currentGroup('ops').targetDigest, old)
})

test('v2 分组保留可达来源，标出不可达来源；平台可关闭管理 Agent 自动装载', async t => {
  const manager = await managerModule(t), reads = []
  const healthy = await fixtureMcp(t, 'healthy', reads)
  const servers = [
    { id: 'healthy', enabled: true, url: healthy, tools: { mode: 'all', names: [] } },
    { id: 'unreachable', enabled: true, url: 'http://127.0.0.1:1/mcp', tools: { mode: 'all', names: [] } },
  ]
  const groups = [{ id: 'mixed', members: servers.map((server, index) => ({ serverId: server.id, names: index ? ['offline_tool'] : ['echo'] })) }]
  const { client } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2)
  const listed = await v2.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), ['echo'])
  assert.deepEqual(listed._meta[manager.GROUP_DISCOVERY_META_KEY], { unavailable: ['unreachable'] })
  const events = []
  const ctx = { effect: callback => callback(), webServer: { register: () => () => {}, publicPath: path => path },
    connection: { requestRejection: () => undefined }, on: name => events.push(name), provide() {} }
  manager.apply(ctx, { servers: { get: () => servers }, groups: { get: () => groups },
    sharedToken: { get: () => '0'.repeat(64) }, autoMountServers: false })
  assert.equal(events.includes('agent/created'), false)
  const defaultEvents = []
  manager.apply({ ...ctx, on: name => defaultEvents.push(name) }, { servers: { get: () => servers },
    groups: { get: () => groups }, sharedToken: { get: () => '0'.repeat(64) } })
  assert.equal(defaultEvents.includes('agent/created'), true)
})

test('v2 拒绝跨来源、上游重复和旧名冲突，离线来源不让出名称且不影响其他工具', async t => {
  const manager = await managerModule(t), reads = [], state = {}
  const first = await fixtureMcp(t, 'first', reads, false, true)
  const second = await fixtureMcp(t, 'second', reads, false, false, state)
  const third = await fixtureMcp(t, 'third', reads, false, false, { tools: [
    { name: 'same', inputSchema: { type: 'object' } },
    { name: 'first__echo', inputSchema: { type: 'object' } },
    { name: 'healthy', inputSchema: { type: 'object' } },
  ] })
  const servers = [first, second, third].map((url, index) => ({ id: ['first', 'second', 'third'][index],
    enabled: true, url, tools: { mode: 'all', names: [] } }))
  const groups = [{ id: 'conflicts', members: [
    { serverId: 'first', names: ['echo'] },
    { serverId: 'second', names: ['echo'], resourceUris: ['fixture:/same'] },
    { serverId: 'third', names: ['same', 'first__echo', 'healthy'] },
  ] }]
  const { client } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2)
  assert.deepEqual((await v2.listTools()).tools.map(tool => tool.name), ['healthy'])
  for (const name of ['echo', 'same', 'first__echo', 'second__echo']) {
    await assert.rejects(v2.callTool({ name, arguments: {} }), /冲突/)
  }
  state.offline = true
  assert.deepEqual((await v2.listTools()).tools.map(tool => tool.name), ['healthy'])
  await assert.rejects(v2.callTool({ name: 'same', arguments: {} }), /冲突/)
  assert.equal((await v2.callTool({ name: 'healthy', arguments: { value: 'ok' } })).content[0].text, 'third:ok')
  groups[0].members = [{ serverId: 'third', names: ['same', 'healthy'] }]
  assert.deepEqual((await v2.listTools()).tools.map(tool => tool.name), ['same', 'healthy'])
  assert.equal(reads.length, 0)
})

test('业务 Session 跳过连接、鉴权和规范发现失败的 MCP 来源，仍校验本地配置', async t => {
  const manager = await managerModule(t)
  const duplicate = await fixtureMcp(t, 'duplicate', [], false, true)
  const sdkRequire = createRequire(process.env.HARNESS_DSH_ENTRY || new URL('../package.json', import.meta.url))
  const [{ Context }, { ToolRuntime }, { createScope }, { SystemPrompt }] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-system-prompt',
  ].map(name => import(pathToFileURL(sdkRequire.resolve(name)).href)))
  const healthy = await serve(t, (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    openapi: '3.0.0', info: { title: 'healthy', version: '1' }, paths: {
      '/echo': { get: { operationId: 'echo', responses: { 200: { description: 'ok' } } } },
    },
  })))
  const hanging = await serve(t, () => {})
  const reserved = createServer()
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve))
  const port = reserved.address().port
  await new Promise(resolve => reserved.close(resolve))
  let mode = 'healthy'
  const recovering = createServer((_req, res) => mode === 'unauthorized' ? res.writeHead(401).end() :
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(
    mode === 'invalid' ? { openapi: '3.0.0' } : { openapi: '3.0.0', info: { title: 'recovering', version: '1' },
      paths: { '/echo': { get: { operationId: 'echo', responses: { 200: { description: 'ok' } } } } } },
  )))
  t.after(async () => { if (recovering.listening) { recovering.closeAllConnections(); await new Promise(resolve => recovering.close(resolve)) } })
  const servers = [
    { id: 'healthy', serverName: 'Healthy', enabled: true, specUrl: `${healthy}/openapi.json`, tools: { mode: 'all', names: [] } },
    { id: 'recovering', serverName: 'Recovering', enabled: true, specUrl: `http://127.0.0.1:${port}/openapi.json`,
      tools: { mode: 'all', names: [] } },
    { id: 'hanging', serverName: 'Hanging', enabled: true, url: hanging, platformTimeoutMs: 150,
      tools: { mode: 'all', names: [] } },
    { id: 'hanging-api', serverName: 'HangingApi', enabled: true, specUrl: `${hanging}/openapi.json`, platformTimeoutMs: 150,
      tools: { mode: 'all', names: [] } },
    { id: 'duplicate', serverName: 'Duplicate', enabled: true, url: duplicate, tools: { mode: 'all', names: [] } },
  ]
  const ctx = new Context(), scopes = new Set(), transitions = []
  const services = ctx.plugin({ name: 'mcp-mount-test-services', apply(inner) {
    inner.provide('webServer', { register: () => () => {}, publicPath: path => path })
    inner.provide('connection', { requestRejection: () => undefined })
    new SystemPrompt(inner, {})
    new ToolRuntime(inner, { mode: 'native' })
  } })
  await services
  const loaded = ctx.plugin({ name: 'mcp-mount-test', inject: ['webServer', 'connection', 'tools'], apply(inner) {
    manager.apply(inner, { servers: { get: () => servers }, groups: { get: () => [] },
      sharedToken: { get: () => '' }, withToolContext: (_execution, run) => run(),
      onManagedTool: (name, registered) => transitions.push([name, registered]) })
  } })
  await loaded
  t.after(async () => {
    for (const scope of scopes) await scope.dispose()
    await loaded.dispose()
    await services.dispose()
    await ctx.fiber.dispose()
  })
  async function session(id, parent = {}) {
    const agent = { id, session: { id } }
    const scope = createScope(ctx, agent, { parent })
    agent.ctx = scope.ctx
    scopes.add(scope)
    await ctx.serial('agent/created', { agent })
    return { agent, scope }
  }
  const parent = {}
  const started = Date.now()
  const first = await session('offline', parent)
  assert.ok(Date.now() - started < 100, 'Session 创建不能等待外部 MCP 发现')
  await waitFor(() => transitions.some(([name, active]) => name === 'mcp__Duplicate__echo' && !active))
  assert.ok(ctx.tools.get('mcp__Healthy__echo', first.agent), '可达来源照常注册')
  assert.equal(ctx.tools.get('mcp__Recovering__echo', first.agent), undefined, '不可达来源不得注册工具')
  assert.equal(ctx.tools.get('mcp__Hanging__echo', first.agent), undefined)
  assert.equal(ctx.tools.get('mcp__HangingApi__echo', first.agent), undefined)
  assert.equal(ctx.tools.get('mcp__Duplicate__echo', first.agent), undefined, '部分注册成功的坏来源必须回滚')
  assert.equal(ctx.mcpSessionManager.resolveTool('recovering', 'echo'), undefined)
  assert.equal(ctx.mcpSessionManager.resolveTool('duplicate', 'echo'), undefined)
  const [stillOffline, concurrentOffline] = await Promise.all([
    session('still-offline', parent), session('concurrent-offline', parent),
  ])
  assert.ok(ctx.tools.get('mcp__Healthy__echo', stillOffline.agent))
  assert.ok(ctx.tools.get('mcp__Healthy__echo', concurrentOffline.agent))
  await waitFor(() => transitions.filter(([name, active]) => name === 'mcp__Duplicate__echo' && !active).length >= 2)
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Healthy__echo' && active).length, 1,
    '共享 Preset 的新 Session 不得重复注册健康工具')
  assert.ok(transitions.some(([name, active]) => name === 'mcp__Duplicate__echo' && active),
    '重复工具名须触发部分注册后的来源级回滚')
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Duplicate__echo' && active).length,
    transitions.filter(([name, active]) => name === 'mcp__Duplicate__echo' && !active).length,
    '坏来源不得留下工具注册引用')
  await new Promise(resolve => recovering.listen(port, '127.0.0.1', resolve))
  const second = await session('online', parent)
  await waitFor(() => ctx.tools.get('mcp__Recovering__echo', second.agent))
  assert.ok(ctx.tools.get('mcp__Recovering__echo', second.agent), '后续新 Session 可重新发现恢复的来源')
  assert.equal(ctx.mcpSessionManager.resolveTool('recovering', 'echo'), 'mcp__Recovering__echo')
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Healthy__echo' && active).length, 1)
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Recovering__echo' && active).length, 1)
  await first.scope.dispose(); scopes.delete(first.scope)
  await stillOffline.scope.dispose(); scopes.delete(stillOffline.scope)
  await concurrentOffline.scope.dispose(); scopes.delete(concurrentOffline.scope)
  assert.ok(ctx.mcpSessionManager.resolveTool('healthy', 'echo'), '仍有 Session 时健康工具保持可用')
  await second.scope.dispose(); scopes.delete(second.scope)
  assert.equal(ctx.mcpSessionManager.resolveTool('healthy', 'echo'), undefined)
  assert.equal(ctx.mcpSessionManager.resolveTool('recovering', 'echo'), undefined)
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Healthy__echo' && !active).length, 1)
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Recovering__echo' && !active).length, 1)
  mode = 'invalid'
  const invalid = await session('invalid-spec')
  await waitFor(() => ctx.tools.get('mcp__Healthy__echo', invalid.agent))
  assert.ok(ctx.tools.get('mcp__Healthy__echo', invalid.agent))
  assert.equal(ctx.tools.get('mcp__Recovering__echo', invalid.agent), undefined)
  mode = 'unauthorized'
  const denied = await session('unauthorized')
  await waitFor(() => ctx.tools.get('mcp__Healthy__echo', denied.agent))
  assert.ok(ctx.tools.get('mcp__Healthy__echo', denied.agent))
  assert.equal(ctx.tools.get('mcp__Recovering__echo', denied.agent), undefined)
  servers.push({ ...servers[0] })
  await assert.rejects(session('duplicate-local-id'), /MCP 服务器 ID 或名称重复\/无效/)
})

test('原始 OpenAPI 发现尊重调用方取消信号，包括登录授权过程', async t => {
  const { loadOpenApi } = await rawOpenApiModule(t)
  const hanging = await serve(t, () => {})
  const started = Date.now()
  await assert.rejects(loadOpenApi({ id: 'spec-hangs', specUrl: `${hanging}/openapi.json`,
    platformSignal: AbortSignal.timeout(120) }), error => error.name === 'TimeoutError')
  assert.ok(Date.now() - started < 2000, '规范读取不能等待内部 20 秒超时')
  const unauthorized = await serve(t, (request, response) => {
    if (request.url === '/login') return
    response.writeHead(401).end()
  })
  const loginStarted = Date.now()
  await assert.rejects(loadOpenApi({ id: 'login-hangs', specUrl: `${unauthorized}/openapi.json`,
    authType: 'login', loginUrl: `${unauthorized}/login`, loginUsername: 'fixture', loginPassword: 'fixture',
    loginTokenPath: 'token', platformSignal: AbortSignal.timeout(120) }), error => error.name === 'TimeoutError')
  assert.ok(Date.now() - loginStarted < 2000, '登录授权不能等待内部 20 秒超时')
})

test('原生 MCP 桥沿用 DSH 的非致命启动与无工具注册状态', async t => {
  const manager = await managerModule(t)
  const sdkRequire = createRequire(process.env.HARNESS_DSH_ENTRY || new URL('../package.json', import.meta.url))
  const [{ Context }, { ToolRuntime }, { createScope }, { SystemPrompt }] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-system-prompt',
  ].map(name => import(pathToFileURL(sdkRequire.resolve(name)).href)))
  const routes = []
  const denied = await serve(t, (_request, response) => response.writeHead(401).end())
  const invalid = await serve(t, (_request, response) => response.writeHead(200, {
    'content-type': 'application/json',
  }).end('{"not":"mcp"}'))
  const origin = await serve(t, (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const route = routes.find(item => item.kind === 'exact' ? item.path === path : path.startsWith(item.path))
    if (!route) return response.writeHead(404).end()
    return route.handler(request, response)
  })
  const ctx = new Context()
  const services = ctx.plugin({ name: 'native-mcp-mount-services', apply(inner) {
    inner.provide('webServer', { port: Number(new URL(origin).port), publicPath: path => path,
      register: route => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } })
    inner.provide('connection', { requestRejection: () => undefined })
    new SystemPrompt(inner, {})
    new ToolRuntime(inner, { mode: 'native' })
  } })
  await services
  const loaded = ctx.plugin({ name: 'native-mcp-mount', inject: ['webServer', 'connection', 'tools'], apply(inner) {
    manager.apply(inner, { servers: { get: () => [{ id: 'offline', serverName: 'Offline', enabled: true,
      url: 'http://127.0.0.1:65531/mcp', tools: { mode: 'all', names: [] } },
    { id: 'denied', serverName: 'Denied', enabled: true, url: denied, tools: { mode: 'all', names: [] } },
    { id: 'invalid', serverName: 'Invalid', enabled: true, url: invalid, tools: { mode: 'all', names: [] } }] },
    groups: { get: () => [] }, sharedToken: { get: () => '' } })
  } })
  await loaded
  const agent = { id: 'native-offline', session: { id: 'native-offline' } }
  const scope = createScope(ctx, agent, { parent: {} })
  agent.ctx = scope.ctx
  t.after(async () => { await scope.dispose(); await loaded.dispose(); await services.dispose(); await ctx.fiber.dispose() })
  await ctx.serial('agent/created', { agent })
  assert.equal(ctx.tools.get('mcp__Offline__echo', agent), undefined)
  assert.equal(ctx.mcpSessionManager.resolveTool('offline', 'echo'), undefined)
  assert.equal(ctx.tools.get('mcp__Denied__echo', agent), undefined)
  assert.equal(ctx.tools.get('mcp__Invalid__echo', agent), undefined)
})

test('原生 MCP 的同名工具与资源不合并，冲突项不发布也不能通过旧名调用', async t => {
  const manager = await managerModule(t)
  const upstream = await serve(t, async (req, res) => {
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name: 'native', version: '1' }, { capabilities: { tools: {}, resources: {} } })
      mcp.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }))
      mcp.server.setRequestHandler('resources/list', async () => ({ resources: [{ name: 'echo', uri: 'fixture:/echo' }] }))
      mcp.server.setRequestHandler('resources/read', async () => ({ contents: [{ uri: 'fixture:/echo', text: 'resource' }] }))
      return mcp
    })
    try { await toNodeHandler(handler)(req, res) } finally { await handler.close() }
  })
  const servers = [{ id: 'native', enabled: true, url: upstream, tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'native', members: [{ serverId: 'native', names: ['echo'], resourceUris: ['fixture:/echo'], resourceTemplates: [] }] }]
  const { client } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2), listed = await v2.listTools()
  assert.equal(listed.tools.length, 0)
  assert.match(listed._meta[manager.GROUP_DISCOVERY_META_KEY].unavailable.join(), /native\/tool\/echo.*native\/resource\/echo/)
  await assert.rejects(v2.callTool({ name: 'echo', arguments: {} }), /冲突/)
  await assert.rejects(v2.callTool({ name: 'native__echo', arguments: {} }), /冲突/)
})

test('OpenAPI 同一操作只发布一个工具，保留资源读取与已选包装工具调用', async t => {
  const manager = await managerModule(t), calls = []
  let endpoint = ''
  endpoint = await serve(t, (req, res) => {
    const url = new URL(req.url, endpoint || 'http://localhost')
    if (url.pathname === '/openapi.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      openapi: '3.0.0', info: { title: 'resource-query', version: '1' }, servers: [{ url: endpoint }],
      paths: { '/item/{id}': { get: { operationId: 'get_item', parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
      ] } } },
    }))
    calls.push(url.href)
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: url.pathname.split('/').at(-1), q: url.searchParams.get('q') }))
  })
  const servers = [{ id: 'api', serverName: 'Display', enabled: true, specUrl: `${endpoint}/openapi.json`, tools: { mode: 'all', names: [] } }]
  const template = `${endpoint}/item/{id}{?q}`
  const groups = [{ id: 'api-group', members: [{ serverId: 'api', names: ['get_item'], resourceUris: [], resourceTemplates: [template] }] }]
  const { client, context, origin } = await groupServer(t, manager, servers, groups)
  const v1 = await client(1), v2 = await client(2)
  assert.deepEqual((await v1.listTools()).tools.map(item => item.name), ['mcp__Display__get_item'])
  const discover = await (await fetch(`${origin}/api/mcp-manager`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'test', serverId: 'api' }) })).json()
  assert.deepEqual(discover.tools[0].httpOperation, { method: 'GET', path: '/item/{id}' })
  assert.deepEqual(discover.resourceTemplates.resourceTemplates[0].httpOperation, discover.tools[0].httpOperation)
  assert.equal(discover.resourceTemplates.resourceTemplates[0].groupToolName, 'get_item')
  assert.equal(discover.tools[0].groupPublicNames['api-group'], 'mcp__api-group__get_item')
  const alias = 'api__template_get_item_' + (await import('node:crypto')).createHash('sha256').update(`t\0${template}`).digest('hex').slice(0, 12)
  const originalDigest = context.mcpSessionManager.currentGroup('api-group', 2).targetDigest
  assert.deepEqual((await v2.listTools()).tools.map(item => item.name), ['get_item'])
  assert.deepEqual((await context.mcpSessionManager.listGroupTools('api-group', 2)).tools.map(item => item.name), ['get_item'])
  assert.equal(context.mcpSessionManager.currentGroup('api-group', 2).targetDigest, originalDigest)
  assert.equal(JSON.parse((await v2.callTool({ name: alias, arguments: { id: 'A', q: 'legacy' } })).content[0].text).q, 'legacy')
  await assert.rejects(v2.callTool({ name: alias, arguments: { id: 'A' } }), /参数/)
  const templates = (await v2.listResourceTemplates()).resourceTemplates
  assert.equal(templates.length, 1)
  const uri = new UriTemplate(templates[0].uriTemplate).expand({ id: 'A', q: 'x y' })
  const result = await v2.readResource({ uri })
  assert.equal(JSON.parse(result.contents[0].text).q, 'x y')
  assert.equal(calls.at(-1), `${endpoint}/item/A?q=x+y`)
  await assert.rejects(v2.readResource({ uri: uri + '&unknown=1' }))
  groups[0].members[0].names = []
  assert.deepEqual((await v2.listTools()).tools.map(item => item.name), ['get_item'])
  assert.equal(JSON.parse((await v2.callTool({ name: alias, arguments: { id: 'A', q: 'resource-only' } })).content[0].text).q, 'resource-only')
  groups[0].members[0].names = ['get_item']
  servers[0].tools = { mode: 'selected', names: [] }
  assert.deepEqual((await v2.listTools()).tools.map(item => item.name), ['get_item'], '来源未开放原工具时仍发布所选资源工具')
  servers[0].tools = { mode: 'all', names: [] }
  groups[0].members[0].resourceTemplates = []
  assert.deepEqual((await v2.listTools()).tools.map(item => item.name), ['get_item'])
  await assert.rejects(v2.callTool({ name: alias, arguments: { id: 'A', q: 'removed' } }))
  groups[0].members = []
  assert.deepEqual((await v2.listTools()).tools, [])
})

test('v2 分组可列出并读取包含多个普通变量的来源资源模板', async t => {
  const manager = await managerModule(t), reads = []
  const endpoint = await fixtureMcp(t, 'multi-variable', reads)
  const servers = [{ id: 'source', serverName: 'Display', enabled: true, url: endpoint,
    tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'templates', members: [{ serverId: 'source', names: [], resourceUris: [],
    resourceTemplates: ['fixture:/pair/{left,right}'] }] }]
  const { client } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2)
  const listed = (await v2.listResourceTemplates()).resourceTemplates
  assert.equal(listed.length, 1)
  const uri = new UriTemplate(listed[0].uriTemplate).expand({ left: 'A', right: 'B' })
  assert.equal((await v2.readResource({ uri })).contents[0].uri, uri)
  assert.deepEqual(reads, [{ id: 'multi-variable', uri: 'fixture:/pair/A,B' }])
})

test('旧分组可继续读取同一服务重复成员，v2 拒绝歧义来源', async t => {
  const manager = await managerModule(t), reads = []
  const endpoint = await fixtureMcp(t, 'legacy', reads)
  const servers = [{ id: 'legacy', serverName: 'Display', enabled: true, url: endpoint, tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'legacy-group', members: [
    { serverId: 'legacy', names: ['echo'] }, { serverId: 'legacy', names: ['echo'] },
  ] }]
  const { context, client } = await groupServer(t, manager, servers, groups)
  const v1 = await client(1)
  assert.deepEqual((await v1.listTools()).tools.map(tool => tool.name), ['mcp__Display__echo', 'mcp__Display__echo'])
  assert.match(context.mcpSessionManager.currentGroup('legacy-group').targetDigest, /^[0-9a-f]{64}$/)
  assert.throws(() => context.mcpSessionManager.currentGroup('legacy-group', 2), /服务 ID 重复/)
})

test('分组允许只有 Resource 能力的服务，工具发现不要求上游 tools 能力', async t => {
  const manager = await managerModule(t), reads = []
  const endpoint = await fixtureMcp(t, 'resource-only', reads, true)
  const servers = [{ id: 'resource', serverName: 'ResourceOnly', enabled: true, url: endpoint, tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'assets', members: [{ serverId: 'resource', names: [], resourceUris: ['fixture:/same'], resourceTemplates: [] }] }]
  const { client } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2)
  const alias = (await v2.listTools()).tools[0]
  assert.equal(alias.name, 'same')
  assert.equal((await v2.callTool({ name: alias.name, arguments: {} })).content[0].text, 'resource-only')
  const uri = (await v2.listResources()).resources[0].uri
  assert.equal((await v2.readResource({ uri })).contents[0].text, 'resource-only')
})

test('v2 工具代理将 SDK 取消传到实际来源', async t => {
  const manager = await managerModule(t)
  const within = async (promise, label) => {
    let timer
    try { await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000) })]) }
    finally { clearTimeout(timer) }
  }
  let started, aborted
  const entered = new Promise(resolve => { started = resolve })
  const cancelled = new Promise(resolve => { aborted = resolve })
  const endpoint = await serve(t, async (req, res) => {
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name: 'cancel-source', version: '1' }, { capabilities: { tools: {} } })
      mcp.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'wait', inputSchema: { type: 'object' } }] }))
      mcp.server.setRequestHandler('tools/call', async (_request, extra) => {
        started()
        return new Promise((_resolve, reject) => {
          const cancel = () => { aborted(); reject(new DOMException('已取消', 'AbortError')) }
          if (extra.mcpReq.signal.aborted) cancel()
          else extra.mcpReq.signal.addEventListener('abort', cancel, { once: true })
        })
      })
      return mcp
    })
    try { await toNodeHandler(handler)(req, res) } finally { await handler.close() }
  })
  const servers = [{ id: 'source', serverName: 'Display', enabled: true, url: endpoint, tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'cancel', members: [{ serverId: 'source', names: ['wait'] }] }]
  const { client } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2)
  const digest = (await v2.listTools())._meta['io.deepseek.dsh/mcp-group-target'].digest
  const controller = new AbortController()
  const pending = v2.callTool({ name: 'source__wait', arguments: {},
    _meta: { 'io.deepseek.dsh/mcp-group-target': { digest } } }, { signal: controller.signal, timeout: 5000 })
  const rejected = assert.rejects(pending)
  await within(entered, '来源工具未启动')
  controller.abort()
  await rejected
  await within(cancelled, '来源工具未取消')
})


test('资源工具复用真实读取、参数约束和同进程分派，正文可供 DSH 模型读取', async t => {
  const manager = await managerModule(t), reads = []
  const endpoint = await fixtureMcp(t, 'source text', reads)
  const servers = [{ id: 'source', enabled: true, url: endpoint, tools: { mode: 'selected', names: [] } }]
  const groups = [{ id: 'bridge', members: [{ serverId: 'source', names: [], resourceUris: ['fixture:/same'],
    resourceTemplates: ['fixture:/item/{id}{?q}'] }] }]
  const { client, context, origin } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2)
  const admin = await (await fetch(`${origin}/api/mcp-manager`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'test', serverId: 'source' }) })).json()
  assert.equal(admin.resources.resources[0].name, 'same')
  const tools = (await v2.listTools()).tools
  assert.equal(tools.length, 2)
  const fixed = tools.find(tool => tool.name === admin.resources.resources[0].groupToolName)
  const template = tools.find(tool => tool.name === admin.resourceTemplates.resourceTemplates[0].groupToolName)
  assert.ok(fixed); assert.ok(template)
  assert.deepEqual(template.inputSchema.required, ['id'])
  assert.deepEqual((await context.mcpSessionManager.listGroupTools('bridge', 2)).tools, tools)
  const result = await context.mcpSessionManager.callGroupTool('bridge', 2, fixed.name, {}, undefined, {})
  assert.deepEqual(result.content, [{ type: 'text', text: 'source text' }])
  assert.equal(result.structuredContent.contents[0].uri.startsWith('mcp-group:/bridge/source/r/'), true)
  assert.equal(result.structuredContent.contents[0].text, 'source text')
  const runtime = createRequire(process.env.HARNESS_DSH_ENTRY)
  const { createMcpToolDefinition } = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-mcp-client')).href)
  const definition = createMcpToolDefinition({}, { name: fixed.name, rawName: fixed.name, inputSchema: fixed.inputSchema,
    call: args => context.mcpSessionManager.callGroupTool('bridge', 2, fixed.name, args, undefined, {}) })
  const value = await definition.execute({}, {})
  assert.deepEqual(definition.output.render({}, value), [{ type: 'text', text: 'source text' }])
  const called = await v2.callTool({ name: template.name, arguments: { id: 'A/B', q: ['x,y', 'z'] } })
  assert.equal(called.content[0].text, 'source text')
  assert.deepEqual(reads.at(-1), { id: 'source text', uri: 'fixture:/item/A%2FB?q=x%2Cy,z' })
  const before = reads.length
  await assert.rejects(v2.callTool({ name: template.name, arguments: { q: 'missing path' } }), /参数/)
  await assert.rejects(v2.callTool({ name: template.name, arguments: { id: 'A', unknown: 1 } }), /参数/)
  await assert.rejects(v2.callTool({ name: fixed.name, arguments: { uri: 'fixture:/other' } }), /参数/)
  assert.equal(reads.length, before)
  groups[0].members[0].resourceUris = []
  await assert.rejects(context.mcpSessionManager.callGroupTool('bridge', 2, fixed.name, {}, undefined, {}), /范围/)
  assert.equal(reads.length, before)
})

test('OpenAPI 资源工具保留参数类型、必填查询参数与说明，并隔离未选操作', async t => {
  const manager = await managerModule(t), calls = []
  let endpoint
  endpoint = await serve(t, (req, res) => {
    const url = new URL(req.url, endpoint)
    if (url.pathname === '/openapi.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      openapi: '3.0.0', servers: [{ url: endpoint }], paths: {
        '/items/{id}': { get: { operationId: 'lookup', summary: '查询条目', parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: '条目编号' },
          { name: 'active', in: 'query', required: true, schema: { type: 'boolean' }, description: '是否启用' },
          { name: 'filter', in: 'query', schema: { type: 'object', properties: { q: { type: 'string' }, page: { type: 'integer' } } } },
        ] } }, '/unused': { get: { operationId: 'unselected' } }, '/status': { get: { operationId: 'status' } },
      },
    }))
    calls.push(url.href)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: url.pathname.split('/').at(-1), active: url.searchParams.get('active') }))
  })
  const servers = [{ id: 'api', enabled: true, specUrl: `${endpoint}/openapi.json`, tools: { mode: 'selected', names: [] } }]
  const groups = [{ id: 'typed', members: [{ serverId: 'api', names: [], resourceUris: [`${endpoint}/status`],
    resourceTemplates: [`${endpoint}/items/{id}{?active,filter}`] }] }]
  const { client, context } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2), listed = (await v2.listTools()).tools
  assert.equal(listed.length, 2)
  const template = listed.find(tool => tool._meta[manager.GROUP_TOOL_META_KEY].kind === 'template')
  assert.equal(template.title, '查询条目')
  assert.deepEqual(template.inputSchema.required, ['id', 'active'])
  assert.equal(template.inputSchema.properties.id.type, 'integer')
  assert.equal(template.inputSchema.properties.active.type, 'boolean')
  assert.equal(template.inputSchema.properties.id.description, '条目编号')
  assert.equal(JSON.parse((await v2.callTool({ name: template.name, arguments: { id: 7, active: false } })).content[0].text).active, 'false')
  assert.equal(calls.at(-1), `${endpoint}/items/7?active=false`)
  const args = { id: 8, active: true, filter: { q: 'a & 中', page: 2 } }
  await v2.callTool({ name: template.name, arguments: args })
  assert.equal(calls.at(-1), `${endpoint}/items/8?active=true&q=a+%26+%E4%B8%AD&page=2`)
  await context.mcpSessionManager.callGroupTool('typed', 2, template.name, args, undefined, {})
  assert.equal(calls.at(-1), `${endpoint}/items/8?active=true&q=a+%26+%E4%B8%AD&page=2`)
  const before = calls.length
  await assert.rejects(context.mcpSessionManager.callGroupTool('typed', 2, template.name, { id: 7 }, undefined, {}), /active/)
  await assert.rejects(v2.callTool({ name: template.name, arguments: { id: '7', active: true } }), /id/)
  await assert.rejects(v2.callTool({ name: 'api__unselected', arguments: {} }), /范围/)
  assert.equal(calls.length, before)
})

test('三类发现遍历全部分页，模板不支持与坏来源不阻塞其他资源工具，二进制保留原文', async t => {
  const manager = await managerModule(t)
  let templatesSupported = true
  const endpoint = await serve(t, async (req, res) => {
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name: 'paged', version: '1' }, { capabilities: { tools: {}, resources: {} } })
      mcp.server.setRequestHandler('tools/list', async request => ({ tools: [{ name: request.params?.cursor ? 'second' : 'first', inputSchema: { type: 'object' } }],
        ...(!request.params?.cursor ? { nextCursor: 'next' } : {}) }))
      mcp.server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'second tool' }] }))
      mcp.server.setRequestHandler('resources/list', async request => ({ resources: [{ name: request.params?.cursor ? 'binary' : 'first', uri: request.params?.cursor ? 'fixture:/binary' : 'fixture:/first' }],
        ...(!request.params?.cursor ? { nextCursor: 'next' } : {}) }))
      mcp.server.setRequestHandler('resources/templates/list', async request => {
        if (!templatesSupported) throw new Error('unavailable')
        return { resourceTemplates: [{ name: request.params?.cursor ? 'second_template' : 'unsupported', uriTemplate: request.params?.cursor ? 'fixture:/{id}' : 'fixture:/{id*}' }],
          ...(!request.params?.cursor ? { nextCursor: 'next' } : {}) }
      })
      mcp.server.setRequestHandler('resources/read', async request => ({ contents: [{ uri: request.params.uri, mimeType: 'application/octet-stream', blob: 'AAEC' }] }))
      return mcp
    })
    try { await toNodeHandler(handler)(req, res) } finally { await handler.close() }
  })
  const servers = [{ id: 'paged', enabled: true, url: endpoint, tools: { mode: 'all', names: [] } },
    { id: 'offline', enabled: true, url: 'http://127.0.0.1:1/mcp', tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'pages', members: [{ serverId: 'paged', names: ['second'], resourceUris: ['fixture:/binary'],
    resourceTemplates: ['fixture:/{id*}', 'fixture:/{id}'] }, { serverId: 'offline', names: [], resourceUris: ['fixture:/missing'] }] }]
  const { client, origin } = await groupServer(t, manager, servers, groups), v2 = await client(2)
  const admin = await (await fetch(`${origin}/api/mcp-manager`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'test', serverId: 'paged' }) })).json()
  assert.equal(admin.tools.length, 2); assert.equal(admin.resources.resources.length, 2); assert.equal(admin.resourceTemplates.resourceTemplates.length, 2)
  const list = await v2.listTools()
  assert.equal(list.tools.length, 3)
  assert.ok(list._meta[manager.GROUP_DISCOVERY_META_KEY].unavailable.some(value => value.includes('不支持')))
  assert.equal((await v2.callTool({ name: 'paged__second', arguments: {} })).content[0].text, 'second tool')
  const resource = list.tools.find(tool => tool._meta[manager.GROUP_TOOL_META_KEY].kind === 'resource')
  const result = await v2.callTool({ name: resource.name, arguments: {} })
  assert.match(result.content[0].text, /二进制/)
  assert.equal(result.structuredContent.contents[0].blob, 'AAEC')
  assert.equal(result.structuredContent.contents[0].mimeType, 'application/octet-stream')
  templatesSupported = false
  assert.equal((await v2.listTools()).tools.length, 2)
  assert.equal((await v2.callTool({ name: resource.name, arguments: {} })).structuredContent.contents[0].blob, 'AAEC')
})


test('分组调试通过实际已发布 v2 端点发现、调用、读 URI 与模板，拒绝混淆目标', async t => {
  const manager = await managerModule(t), reads = [], methods = []
  const upstream = await fixtureMcp(t, 'debug', reads)
  const servers = [{ id: 'source', enabled: true, url: upstream, tools: { mode: 'all', names: [] } }]
  const groups = [{ id: 'debug-group', members: [{ serverId: 'source', names: ['echo'], resourceUris: ['fixture:/same'], resourceTemplates: ['fixture:/item/{id}{?q}'] }] }]
  const { origin, client } = await groupServer(t, manager, servers, groups, methods)
  const post = async input => {
    const response = await fetch(`${origin}/api/mcp-manager`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupId: 'debug-group', ...input }) })
    return { status: response.status, value: await response.json() }
  }
  const discovered = await post({ action: 'test' })
  assert.equal(discovered.status, 200)
  const actual = await client(2)
  assert.deepEqual(discovered.value.tools.map(tool => tool.name), (await actual.listTools()).tools.map(tool => tool.name))
  assert.ok(methods.includes('tools/list') && methods.includes('resources/list'), '已初始化的 SDK 客户端访问实际分组端点')
  assert.match(JSON.stringify((await post({ action: 'callTool', toolName: 'echo', arguments: { value: 'ok' } })).value), /debug:ok/)
  const resource = discovered.value.resources.resources[0]
  assert.equal((await post({ action: 'readResource', uri: resource.uri })).status, 200)
  const template = discovered.value.resourceTemplates.resourceTemplates[0]
  assert.equal((await post({ action: 'readResource', uriTemplate: template.uriTemplate, arguments: { id: 'one', q: 'a b' } })).status, 200)
  assert.deepEqual(reads.map(read => read.uri), ['fixture:/same', 'fixture:/item/one?q=a%20b'])
  assert.equal((await post({ action: 'readResource', uriTemplate: 'fixture:/unselected/{id}', arguments: { id: 'one' } })).status, 400)
  assert.equal((await post({ action: 'readResource', uriTemplate: template.uriTemplate, arguments: [] })).status, 400)
  assert.equal((await post({ action: 'readResource', uriTemplate: template.uriTemplate, arguments: {} })).status, 400)
  assert.equal((await post({ action: 'test', serverId: 'source' })).status, 400)
  assert.equal((await post({ action: 'test', groupId: 'unsaved-draft' })).status, 404)
  assert.equal((await post({ action: 'refresh' })).status, 400)
})
