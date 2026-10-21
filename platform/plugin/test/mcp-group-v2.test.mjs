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

async function managerModule(t) {
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
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

async function fixtureMcp(t, id, reads, resourceOnly = false, duplicateTools = false) {
  return serve(t, async (req, res) => {
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name: id, version: '1' }, { capabilities: { ...(resourceOnly ? {} : { tools: {} }), resources: {} } })
      if (!resourceOnly) {
        mcp.server.setRequestHandler('tools/list', async () => ({ tools: duplicateTools
          ? [{ name: 'echo', inputSchema: { type: 'object' } }, { name: 'echo', inputSchema: { type: 'object' } }]
          : [{ name: 'echo', inputSchema: { type: 'object' } }] }))
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
  const groups = [{ id: 'ops', members: servers.map(server => ({ serverId: server.id, names: ['echo'],
    resourceUris: ['fixture:/same', 'fixture:/missing'], resourceTemplates: ['fixture:/item/{id}{?q}'] })) }]
  const { origin, context, token, client, rpcRequests } = await groupServer(t, manager, servers, groups, methods)
  const paths = await (await fetch(`${origin}/api/mcp-manager`)).json()
  assert.equal(paths.groupPaths[0].v2Path, '/hep/mcp/groups/ops/v2')
  const forged = await fetch(`${origin}/mcp/groups/ops/v2`, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'X-Harness-Business-Signature': 'forged', 'content-type': 'application/json',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
  assert.equal(forged.status, 401, '签名无效不能回退到 Bearer')
  const v1 = await client(1), v2 = await client(2)
  assert.deepEqual((await v1.listTools()).tools.map(tool => tool.name), ['mcp__DisplayOne__echo', 'mcp__DisplayTwo__echo'])
  const listed = await v2.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), ['alpha_0id__echo', 'beta__echo'])
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
  const groups = [{ id: 'mixed', members: servers.map(server => ({ serverId: server.id, names: ['echo'] })) }]
  const { client } = await groupServer(t, manager, servers, groups)
  const v2 = await client(2)
  const listed = await v2.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), ['healthy__echo'])
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

test('业务 Session 跳过连接、鉴权和规范发现失败的 MCP 来源，仍校验本地配置', async t => {
  const manager = await managerModule(t)
  const duplicate = await fixtureMcp(t, 'duplicate', [], false, true)
  const sdkRequire = createRequire('/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json')
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
  assert.ok(Date.now() - started < 3000, '不响应来源不得长期阻塞 Session 创建')
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
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Healthy__echo' && active).length, 1,
    '共享 Preset 的新 Session 不得重复注册健康工具')
  assert.ok(transitions.some(([name, active]) => name === 'mcp__Duplicate__echo' && active),
    '重复工具名须触发部分注册后的来源级回滚')
  assert.equal(transitions.filter(([name, active]) => name === 'mcp__Duplicate__echo' && active).length,
    transitions.filter(([name, active]) => name === 'mcp__Duplicate__echo' && !active).length,
    '坏来源不得留下工具注册引用')
  await new Promise(resolve => recovering.listen(port, '127.0.0.1', resolve))
  const second = await session('online', parent)
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
  assert.ok(ctx.tools.get('mcp__Healthy__echo', invalid.agent))
  assert.equal(ctx.tools.get('mcp__Recovering__echo', invalid.agent), undefined)
  mode = 'unauthorized'
  const denied = await session('unauthorized')
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
  const sdkRequire = createRequire('/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json')
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

test('OpenAPI 查询资源模板经分组读取，同时保留原有 GET 工具', async t => {
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
  const { client } = await groupServer(t, manager, servers, groups)
  const v1 = await client(1), v2 = await client(2)
  assert.deepEqual((await v1.listTools()).tools.map(item => item.name), ['mcp__Display__get_item'])
  const templates = (await v2.listResourceTemplates()).resourceTemplates
  assert.equal(templates.length, 1)
  const uri = new UriTemplate(templates[0].uriTemplate).expand({ id: 'A', q: 'x y' })
  const result = await v2.readResource({ uri })
  assert.equal(JSON.parse(result.contents[0].text).q, 'x y')
  assert.equal(calls.at(-1), `${endpoint}/item/A?q=x+y`)
  await assert.rejects(v2.readResource({ uri: uri + '&unknown=1' }))
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
  assert.deepEqual((await v2.listTools()).tools, [])
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
