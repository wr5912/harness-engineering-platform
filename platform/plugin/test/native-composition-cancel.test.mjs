import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function bounded(promise, label = '协议事件') {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`未在限定时间观察到${label}`)), 5000) })]) }
  finally { clearTimeout(timer) }
}

async function managerModule(t) {
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  // 原生管理器的 Schemastery/Scope 仍来自已安装的标准 DSH Runtime。
  process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
  t.after(() => { if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry })
  const directory = await mkdtemp(join(tmpdir(), 'native-composition-manager-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
  // 仅载入生产构建插件的定义，不执行 build.mjs 顶层的整套构建。
  const source = await readFile(new URL('../build.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export const managerSource =')
  const end = source.indexOf('\nconst { name } =', start)
  assert.ok(start > 0 && end > start, '构建插件定义边界应保持明确')
  const adapter = join(directory, 'adapter.mjs')
  await writeFile(adapter, "import { readFile } from 'node:fs/promises'; import { resolve } from 'node:path';\n" + source.slice(start, end).replace(/fileURLToPath\(new URL\('..\/..\/plugins\/mcp-manager', import.meta.url\)\)/, JSON.stringify(new URL('../../../plugins/mcp-manager', import.meta.url).pathname)))
  const { managerSources } = await import(pathToFileURL(adapter).href)
  const outfile = join(directory, 'manager.mjs')
  await build({ stdin: { contents: "export * from 'harness-mcp-manager-server'; export { createMcpHandler } from './src/mcp/index.ts'", resolveDir: process.cwd(), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources] })
  return import(pathToFileURL(outfile).href)
}

async function serve(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => response.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

function waitForAbort(signal, started, aborted) {
  assert.ok(signal instanceof AbortSignal, '必须收到 SDK 实际取消信号')
  started.resolve()
  return new Promise((_, reject) => {
    const cancel = () => { aborted.resolve(); reject(new DOMException('测试调用已取消', 'AbortError')) }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
  })
}

test('真实原生 MCP 分组把 SDK 取消传入平台组合客户端，组合调用保持长超时', async t => {
  const manager = await managerModule(t)
  const started = deferred(), aborted = deferred()
  let observed, forwarded
  const platformClient = {
    listTools: async () => ({ tools: [{ name: 'wait', description: '基本模拟等待', inputSchema: { type: 'object', properties: {} } }] }),
    callTool: (params, options) => {
      forwarded = params
      observed = options
      return waitForAbort(options?.signal, started, aborted)
    },
  }
  const routes = []
  const { server, origin } = await serve(t, (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const route = routes.find(route => route.kind === 'exact' ? path === route.path : path.startsWith(route.path))
    if (!route) { response.writeHead(404).end(); return }
    return route.handler(request, response)
  })
  const token = '0'.repeat(64)
  const service = { id: 'platform-compositions', serverName: 'compositions', platformComposition: true, enabled: true, tools: { mode: 'all', names: ['wait'] } }
  const context = { webServer: { port: server.address().port, register: route => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined }, effect: create => create(), on: () => {}, provide(name, value) { this[name] = value } }
  manager.apply(context, { servers: { get: () => [service] }, groups: { get: () => [{ id: 'composed', members: [{ serverId: service.id, names: ['wait'] }] }] },
    sharedToken: { get: () => token }, platformClient })
  // 与当前 DSH mcp-client 的 connectGeneration 相同，自动协商现代协议。
  const client = new Client({ name: 'local-composition-cancel', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  t.after(() => client.close())
  const transport = new StreamableHTTPClientTransport(new URL('/mcp/groups/composed', origin), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await client.connect(transport)
  assert.equal(transport.protocolVersion, '2026-07-28')
  const discovered = await client.listTools()
  assert.deepEqual(discovered.tools.map(tool => tool.name), ['mcp__compositions__wait'])
  const group = context.mcpSessionManager.currentGroup('composed')
  assert.match(group.targetDigest, /^[0-9a-f]{64}$/)
  assert.equal(discovered._meta['io.deepseek.dsh/mcp-group-target'].digest, group.targetDigest)
  await assert.rejects(() => client.callTool({ name: 'mcp__compositions__wait', arguments: {}, _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: 'f'.repeat(64) } } }))
  assert.equal(observed, undefined, '目标身份不符在业务派发之前拒绝')
  const controller = new AbortController()
  const pending = client.callTool({ name: 'mcp__compositions__wait', arguments: {}, _meta: { harness: { versionId: 'fixed-version' },
    'io.deepseek.dsh/mcp-group-target': { digest: group.targetDigest } } }, { signal: controller.signal, timeout: 5000 })
  const rejected = assert.rejects(pending)
  await bounded(Promise.race([started.promise, pending.then(() => { throw new Error('平台调用未进入等待即结束') }, error => { throw error })]), '平台客户端进入')
  assert.equal(observed.signal.aborted, false)
  assert.equal(observed.timeout, 36 * 60_000)
  assert.equal(forwarded._meta.harness.versionId, 'fixed-version')
  controller.abort()
  await rejected
  await bounded(aborted.promise, `平台客户端取消（协商协议 ${transport.protocolVersion}）`)
  assert.equal(observed.signal.aborted, true)

  // 外层 Agent 配置尚未创建 Session；单独核对当前构建产物包含组合专属的配置。
  const artifact = await readFile(new URL('../lib/mcp-manager.js', import.meta.url), 'utf8')
  assert.match(artifact, /timeout:\s*server\.platformComposition\s*\?\s*36\s*\*\s*(?:6e4|60_000|60000)/)
})

test('v2 分组资源读取将 SDK 取消传到实际来源', async t => {
  const manager = await managerModule(t)
  const started = deferred(), aborted = deferred()
  const sourceUri = 'soc://assets/9106'
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'resource-source', version: '1' }, { capabilities: { resources: {} } })
    server.server.setRequestHandler('resources/list', async () => ({ resources: [{ uri: sourceUri, name: '资产 9106' }] }))
    server.server.setRequestHandler('resources/read', async (_request, context) =>
      waitForAbort(context.mcpReq.signal, started, aborted))
    return server
  })
  t.after(() => protocol.close())
  const upstream = await serve(t, toNodeHandler(protocol))
  const routes = []
  const gateway = await serve(t, (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const route = routes.find(item => item.kind === 'exact' ? path === item.path : path.startsWith(item.path))
    if (!route) { response.writeHead(404).end(); return }
    return route.handler(request, response)
  })
  const service = { id: 'soc-source', serverName: 'external-name', url: `${upstream.origin}/mcp`,
    enabled: true, headers: [], tools: { mode: 'all', names: [] } }
  const token = '4'.repeat(64)
  const context = { webServer: { port: gateway.server.address().port, register: route => { routes.push(route); return () => {} } },
    connection: { requestRejection: () => undefined }, effect: create => create(), on: () => {}, provide(name, value) { this[name] = value } }
  manager.apply(context, { servers: { get: () => [service] }, groups: { get: () => [{ id: 'asset-group',
    members: [{ serverId: service.id, names: [], resourceUris: [sourceUri], resourceTemplates: [] }] }] },
    sharedToken: { get: () => token } })
  const client = new Client({ name: 'resource-cancel-test', version: '1' }, { versionNegotiation: { mode: 'auto' } })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/groups/asset-group/v2', gateway.origin),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const listed = await client.listResources()
  assert.equal(listed.resources.length, 1)
  assert.match(listed.resources[0].uri, /^mcp-group:\/asset-group\/soc-source\/r\//)
  const controller = new AbortController()
  const pending = client.readResource({ uri: listed.resources[0].uri }, { signal: controller.signal, timeout: 5000 })
  const rejected = assert.rejects(pending)
  await bounded(started.promise, '来源资源读取进入')
  controller.abort()
  await rejected
  await bounded(aborted.promise, '来源资源读取取消')
})

test('原生 dispatch 调用真实外部 MCP 时保留认证 Header 并把取消传至服务端', async t => {
  const manager = await managerModule(t)
  const started = deferred(), aborted = deferred()
  let observedSignal, authorized = false, calls = 0
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'basic-local-mock', version: '1' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'wait', inputSchema: { type: 'object', properties: {} } }] }))
    server.server.setRequestHandler('tools/call', async (_request, context) => {
      calls++
      observedSignal = context.mcpReq.signal
      return waitForAbort(observedSignal, started, aborted)
    })
    return server
  })
  t.after(() => protocol.close())
  const node = toNodeHandler(protocol)
  const { origin } = await serve(t, (request, response) => {
    authorized = request.headers['x-mock-credential'] === 'basic-test-value'
    if (!authorized) { response.writeHead(401).end(); return }
    return node(request, response)
  })
  const external = { id: 'basic-mock', serverName: 'basic-mock', enabled: true, url: origin + '/mcp',
    headers: [{ name: 'X-Mock-Credential', value: 'basic-test-value' }], tools: { mode: 'all', names: [] } }
  let dispatch
  manager.apply({ webServer: { register: () => () => {} }, connection: { requestRejection: () => undefined }, effect: create => create(), on: () => {}, provide() {} }, {
    servers: { get: () => [external] }, groups: { get: () => [] }, sharedToken: { get: () => '' }, platformDispatch: handler => { dispatch = handler },
  })
  const controller = new AbortController()
  const pending = dispatch({ action: 'callTool', serverId: external.id, toolName: 'wait', arguments: {}, timeoutMs: 5000 }, controller.signal)
  await bounded(started.promise)
  controller.abort()
  const reply = await pending
  await bounded(aborted.promise)
  assert.equal(reply.status, 400)
  assert.equal(authorized, true)
  assert.equal(observedSignal.aborted, true)
  assert.equal(calls, 1, '取消不能重试业务调用')
})

test('原生管理器与平台网关一致展开 OpenAPI form/explode 对象查询参数', async t => {
  const manager = await managerModule(t)
  const expected = [['assetId', '9106'], ['pageNum', '2'], ['label', '基础 & 模拟'], ['enabled', 'false'], ['tags', 'a'], ['tags', 'b']]
  const observed = []
  const { origin } = await serve(t, (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/openapi.json') return response.end(JSON.stringify({
      openapi: '3.0.0', info: { title: '基础查询模拟', version: '1' }, servers: [{ url: origin }],
      paths: { '/alerts': { get: { operationId: 'list_alerts', parameters: [{
        name: 'req', in: 'query', required: true, style: 'form', explode: true,
        schema: { type: 'object', properties: { assetId: { type: 'string' }, pageNum: { type: 'integer' }, label: { type: 'string' }, enabled: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } } } },
      }], responses: { 200: { description: '基本模拟查询结果' } } } } },
    }))
    if (url.pathname !== '/alerts') return response.writeHead(404).end('{}')
    const query = [...url.searchParams]
    observed.push(query)
    response.writeHead(JSON.stringify(query) === JSON.stringify(expected) ? 200 : 422).end(JSON.stringify({ query }))
  })
  const service = { id: 'basic-query', specUrl: origin + '/openapi.json', enabled: true }
  const args = { req: { assetId: '9106', pageNum: 2, label: '基础 & 模拟', enabled: false, tags: ['a', 'b'] } }
  let dispatch
  manager.apply({ webServer: { register: () => () => {} }, connection: { requestRejection: () => undefined }, effect: create => create(), on: () => {}, provide() {} }, {
    servers: { get: () => [service] }, groups: { get: () => [] }, sharedToken: { get: () => '' }, platformDispatch: handler => { dispatch = handler },
  })
  const native = await dispatch({ action: 'callTool', serverId: service.id, toolName: 'list_alerts', arguments: args })
  assert.equal(native.status, 200)
  assert.equal(native.value.isError, false)
  assert.deepEqual(JSON.parse(native.value.content[0].text).query, expected)

  const root = await mkdtemp(join(tmpdir(), 'native-object-query-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const gateway = manager.createMcpHandler(root, { stateFile: join(root, 'state.json') })
  assert.equal((await gateway('registerOpenApi', service)).ok, true)
  const result = await gateway('callTool', { connectionId: service.id, toolName: 'list_alerts', arguments: args })
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, true)
  assert.deepEqual(result.value.json.query, expected)
  assert.deepEqual(observed, [expected, expected], '两条真实 HTTP 请求采用同一对象展开语义')
})
