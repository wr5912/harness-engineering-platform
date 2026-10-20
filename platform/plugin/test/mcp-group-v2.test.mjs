import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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

async function serve(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => response.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

async function fixtureMcp(t, id, reads, resourceOnly = false) {
  return serve(t, async (req, res) => {
    const handler = createMcpHandler(() => {
      const mcp = new McpServer({ name: id, version: '1' }, { capabilities: { ...(resourceOnly ? {} : { tools: {} }), resources: {} } })
      if (!resourceOnly) {
        mcp.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }))
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
