import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { managerSources } from '../build.mjs'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { runtimeModule } from '../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'
const [{ Context }, { ToolRuntime }, { apply: applyNativeToolExecutor }, { SystemPrompt }, { McpResourceRuntime }, { createScope }] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-mcp-resources', '@deepseek-ai/dsh-scope',
].map(name => runtimeModule(name)))
const previousEntry = process.env.HARNESS_DSH_ENTRY
process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
after(() => { if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry })
const directory = await mkdtemp(join(tmpdir(), 'standalone-mcp-'))
after(() => rm(directory, { recursive: true, force: true }))
await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir')
const outfile = join(directory, 'plugin.mjs')
await build({ entryPoints: [new URL('../src/standalone/plugin.ts', import.meta.url).pathname], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources] })
const standalone = await import(pathToFileURL(outfile).href)
async function serve(t, handler, host = '127.0.0.1') {
  const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => response.destroy()) })
  await new Promise(resolve => server.listen(0, host, resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { origin: `http://${host}:${server.address().port}`, server }
}
async function until(check, label) {
  const deadline = Date.now() + 3000
  while (!await check()) { if (Date.now() > deadline) throw new Error(`未观察到${label}`); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function fixture(t, mcp) {
  const root = await mkdtemp(join(directory, 'fixture-')), home = join(root, 'home')
  await mkdir(join(home, 'standalone'), { recursive: true })
  const config = { agentId: 'fixture', experimentId: 'EXP-fixture-001', presetId: 'fixture', profilePatch: 'agent.patch.yml', mcp }
  await writeFile(join(home, 'standalone/config.json'), JSON.stringify(config))
  const routes = [], ctx = new Context()
  const gateway = await serve(t, (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const route = routes.find(item => item.kind === 'exact' ? item.path === path : path.startsWith(item.path))
    if (!route) return response.writeHead(404).end()
    return route.handler(request, response)
  }, '127.0.0.2')
  await ctx.plugin({ name: 'standalone-fixture-services', apply(inner) {
    new SystemPrompt(inner, {})
    new ToolRuntime(inner); applyNativeToolExecutor(inner)
    new McpResourceRuntime(inner)
    inner.provide('webServer', { port: gateway.server.address().port, getOrigin: () => gateway.origin, publicPath: path => path,
      register(route) { routes.push(route); return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) } } })
    inner.provide('connection', { requestRejection: () => undefined })
    inner.provide('agents', {})
    inner.provide('workspaceRegistry', { create: async () => {} })
    inner.provide('llm', { fixture: true })
    inner.provide('settingsController', { fixture: true })
  } })
  const loaded = await ctx.plugin(standalone, { home, root })
  const preset = {}, agent = { id: 'fixture-agent' }, scope = createScope(ctx, agent, { parent: preset })
  agent.ctx = scope.ctx
  t.after(async () => { await scope.dispose(); await loaded.dispose(); await ctx.fiber.dispose() })
  return { ctx, agent, home, root, emit() { ctx.emit('agent/created', { agent }) } }
}
test('组合发现、调用、状态、明细和报告全部请求远端平台，智能体不装配执行器', async t => {
  const calls = [], names = ['run_probe', 'get_composition_run', 'get_composition_details', 'get_composition_artifact']
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'platform', version: '1' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler('tools/list', async () => ({ tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) }))
    server.server.setRequestHandler('tools/call', async request => {
      calls.push(request.params)
      const result = request.params.name === 'run_probe' ? { run_id: 'platform-run', status: 'running' }
        : request.params.name === 'get_composition_run' ? { status: 'completed' }
        : request.params.name === 'get_composition_details' ? { items: ['remote-detail'] }
        : { body: '<p>platform report</p>' }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
    })
    return server
  })
  t.after(() => protocol.close())
  const upstream = await serve(t, toNodeHandler(protocol))
  const f = await fixture(t, { servers: [{ id: 'business', enabled: true, url: upstream.origin + '/mcp', tools: { mode: 'all', names: [] } }], groups: [], sharedToken: 'a'.repeat(64) })
  f.emit()
  await until(() => names.every(name => f.ctx.tools.get(`mcp__business__${name}`, f.agent)), '平台组合工具')
  const signal = new AbortController().signal
  const admitted = await f.ctx.tools.resolve({ agent: f.agent, modelSelection: {}, signal })
  t.after(() => admitted.dispose())
  assert.deepEqual(f.ctx.tools.schemas(f.agent, admitted).filter(tool => tool.name.startsWith('mcp__business__')).map(tool => tool.name).sort(), names.map(name => `mcp__business__${name}`).sort())
  const call = async name => (await f.ctx.tools.get(`mcp__business__${name}`, f.agent, admitted).execute({ run_id: 'platform-run' }, { agent: f.agent, signal, toolSet: admitted })).structuredContent
  assert.equal((await call(names[0])).status, 'running')
  assert.equal((await call(names[1])).status, 'completed')
  assert.deepEqual((await call(names[2])).items, ['remote-detail'])
  assert.equal((await call(names[3])).body, '<p>platform report</p>')
  assert.deepEqual(calls.map(call => call.name), names)
  assert.equal(f.ctx.get('platformMcp'), undefined)
  assert.equal(f.ctx.get('standaloneBindings'), undefined)
  await assert.rejects(readFile(join(f.home, 'mcp/.local/runs/platform-run.json')), { code: 'ENOENT' })
})

test('按名称选择分组工具时，原生客户端发现与调用使用相同挂载范围', async t => {
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'selected-upstream', version: '1' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler('tools/list', async () => ({ tools: ['ping', 'other'].map(name => ({ name, inputSchema: { type: 'object' } })) }))
    server.server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    return server
  })
  t.after(() => protocol.close())
  const upstream = await serve(t, toNodeHandler(protocol))
  const f = await fixture(t, { servers: [{ id: 'source', enabled: true, url: upstream.origin + '/mcp', tools: { mode: 'all', names: [] } }],
    groups: [{ id: 'selected', members: [{ serverId: 'source', names: ['ping', 'other'] }] }], sharedToken: 'a'.repeat(64),
    mountServerIds: ['selected'], mountOverrides: { selected: { tools: { mode: 'selected', names: ['ping'] } } } })
  f.emit()
  await until(() => f.ctx.tools.get('mcp__selected__ping', f.agent), '所选分组工具')
  assert.equal(f.ctx.tools.get('mcp__selected__other', f.agent), undefined)
  const result = await f.ctx.tools.get('mcp__selected__ping', f.agent).execute({}, { agent: f.agent, signal: new AbortController().signal })
  assert.equal(result.content[0].text, 'pong')
})
test('纯资源分组通过实际 SDK 挂载原生资源和模板，读取保持公开分组 URI', async t => {
  const uri = 'fixture://asset/one', template = 'fixture://asset/{id}'
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'resource-only', version: '1' }, { capabilities: { resources: {} } })
    server.server.setRequestHandler('resources/list', async () => ({ resources: [{ uri, name: '一号资产' }] }))
    server.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [{ uriTemplate: template, name: '资产模板' }] }))
    server.server.setRequestHandler('resources/read', async request => ({ contents: [{ uri: request.params.uri, text: 'resource-value', mimeType: 'text/plain' }] }))
    return server
  })
  t.after(() => protocol.close())
  const upstream = await serve(t, toNodeHandler(protocol))
  const f = await fixture(t, { servers: [{ id: 'source', enabled: true, url: upstream.origin + '/mcp', headers: [], tools: { mode: 'all', names: [] } }],
    groups: [{ id: 'resource-group', members: [{ serverId: 'source', names: [], resourceUris: [uri], resourceTemplates: [template] }] }], sharedToken: 'b'.repeat(64), mountServerIds: ['resource-group'] })
  f.emit()
  await until(() => f.ctx.tools.get('list_mcp_resources', f.agent), '原生资源工具')
  const exec = { agent: f.agent, signal: new AbortController().signal }
  let resources
  await until(async () => {
    try { resources = await f.ctx.tools.get('list_mcp_resources', f.agent).execute({ server: 'resource-group' }, exec); return true }
    catch (error) { if (!error.message.includes('server is disconnected')) throw error; return false }
  }, '原生资源连接就绪')
  assert.equal(resources.resources.length, 1)
  assert.match(resources.resources[0].uri, /^mcp-group:\/resource-group\/source\/r\//)
  const templates = await f.ctx.tools.get('list_mcp_resource_templates', f.agent).execute({ server: 'resource-group' }, exec)
  assert.equal(templates.resourceTemplates.length, 1)
  assert.match(templates.resourceTemplates[0].uriTemplate, /^mcp-group:\/resource-group\/source\/t\//)
  const read = await f.ctx.tools.get('read_mcp_resource', f.agent).execute({ server: 'resource-group', uri: resources.resources[0].uri }, exec)
  assert.equal(read.contents[0].text, 'resource-value')
  assert.equal(read.contents[0].uri, resources.resources[0].uri)
})
test('修改 MCP 地址后按唯一同路径资源重新绑定，歧义与未选资源不装载', async t => {
  const old = 'http://old.invalid:1234', current = 'http://current.invalid:5678'
  const reads = []
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'moved-resources', version: '1' }, { capabilities: { resources: {} } })
    server.server.setRequestHandler('resources/list', async () => ({ resources: [
      { uri: current + '/status', name: 'get_status' },
      { uri: current + '/ambiguous', name: 'ambiguous_one' },
      { uri: 'http://other.invalid/ambiguous', name: 'ambiguous_two' },
      { uri: current + '/unselected', name: 'unselected' },
    ] }))
    server.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [
      { uriTemplate: current + '/items/{id}', name: 'get_item' },
    ] }))
    server.server.setRequestHandler('resources/read', async request => {
      reads.push(request.params.uri)
      return { contents: [{ uri: request.params.uri, text: 'moved-resource', mimeType: 'text/plain' }] }
    })
    return server
  })
  t.after(() => protocol.close())
  const upstream = await serve(t, toNodeHandler(protocol))
  const f = await fixture(t, { servers: [{ id: 'source', enabled: true, url: upstream.origin + '/mcp', tools: { mode: 'all', names: [] } }],
    groups: [{ id: 'moved', members: [{ serverId: 'source', names: [], resourceUris: [old + '/status', old + '/ambiguous'],
      resourceTemplates: [old + '/items/{id}'] }] }], sharedToken: 'e'.repeat(64), mountServerIds: ['moved'] })
  f.emit()
  await until(() => f.ctx.tools.get('mcp__moved__get_item', f.agent), '迁移后的资源工具')
  const exec = { agent: f.agent, signal: new AbortController().signal }
  const resources = await f.ctx.tools.get('list_mcp_resources', f.agent).execute({ server: 'moved' }, exec)
  assert.equal(resources.resources.length, 1)
  await f.ctx.tools.get('read_mcp_resource', f.agent).execute({ server: 'moved', uri: resources.resources[0].uri }, exec)
  const result = await f.ctx.tools.get('mcp__moved__get_item', f.agent).execute({ id: 'one' }, exec)
  assert.equal(result.content[0].text, 'moved-resource')
  assert.deepEqual(reads, [current + '/status', current + '/items/one'])
  for (const name of ['ambiguous_one', 'ambiguous_two', 'unselected']) assert.equal(f.ctx.tools.get(`mcp__moved__${name}`, f.agent), undefined)
  const unselected = 'mcp-group:/moved/source/r/' + Buffer.from(current + '/unselected').toString('base64url')
  await assert.rejects(f.ctx.tools.get('read_mcp_resource', f.agent).execute({ server: 'moved', uri: unselected }, exec))
})
test('失效来源仍在等待时，健康 MCP 工具已在原生 Agent 作用域可用', async t => {
  let slowStarted = false, releaseSlow
  const blocked = new Promise(resolve => { releaseSlow = resolve })
  const slow = await serve(t, async (_request, response) => { slowStarted = true; await blocked; response.writeHead(503).end() })
  t.after(() => releaseSlow())
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'healthy', version: '1' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }))
    server.server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    return server
  })
  t.after(() => protocol.close())
  const fast = await serve(t, toNodeHandler(protocol))
  const f = await fixture(t, { servers: [slow, fast].map((source, index) => ({ id: index ? 'healthy' : 'slow', enabled: true, url: source.origin + '/mcp', tools: { mode: 'all', names: [] } })), groups: [], sharedToken: 'c'.repeat(64) })
  f.emit()
  await until(() => slowStarted && f.ctx.tools.get('mcp__healthy__ping', f.agent), '健康工具先于失效来源完成装载')
  const result = await f.ctx.tools.get('mcp__healthy__ping', f.agent).execute({}, { agent: f.agent, signal: new AbortController().signal })
  assert.equal(result.content[0].text, 'pong')
  releaseSlow()
})

test('超过发现并发上限的本地分组同时装载，不占用其上游发现所需的队列名额', async t => {
  const protocol = createMcpHandler(() => {
    const server = new McpServer({ name: 'shared-upstream', version: '1' }, { capabilities: { tools: {} } })
    server.server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }))
    server.server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    return server
  })
  t.after(() => protocol.close())
  const upstream = await serve(t, toNodeHandler(protocol))
  const groups = Array.from({ length: 6 }, (_, index) => ({ id: `group-${index}`, members: [{ serverId: 'source', names: ['ping'] }] }))
  const f = await fixture(t, { servers: [{ id: 'source', enabled: true, url: upstream.origin + '/mcp', tools: { mode: 'all', names: [] } }],
    groups, sharedToken: 'f'.repeat(64), mountServerIds: groups.map(group => group.id) })
  f.emit()
  await until(() => groups.every(group => f.ctx.tools.get(`mcp__${group.id}__ping`, f.agent)), '全部分组工具装载')
  for (const group of groups) {
    const result = await f.ctx.tools.get(`mcp__${group.id}__ping`, f.agent).execute({}, { agent: f.agent, signal: new AbortController().signal })
    assert.equal(result.content[0].text, 'pong')
  }
})
