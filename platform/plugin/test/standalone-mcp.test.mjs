import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
const sdk = createRequire(process.env.HARNESS_DSH_ENTRY ?? '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json')
const [{ Context }, { ToolRuntime }, { SystemPrompt }, { McpResourceRuntime }, { createScope }] = await Promise.all([
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-mcp-resources', '@deepseek-ai/dsh-scope',
].map(name => import(pathToFileURL(sdk.resolve(name)).href)))
const previousEntry = process.env.HARNESS_DSH_ENTRY
process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
after(() => { if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry })
const directory = await mkdtemp(join(tmpdir(), 'standalone-mcp-'))
after(() => rm(directory, { recursive: true, force: true }))
await symlink(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir')
const buildSource = await readFile(new URL('../build.mjs', import.meta.url), 'utf8')
const start = buildSource.indexOf('export const managerSource ='), end = buildSource.indexOf('\nconst { name } =', start)
assert.ok(start > 0 && end > start)
const adapter = join(directory, 'adapter.mjs')
await writeFile(adapter, "import { readFile } from 'node:fs/promises'; import { resolve } from 'node:path';\n" + buildSource.slice(start, end).replace(/fileURLToPath\(new URL\('..\/..\/plugins\/mcp-manager', import.meta.url\)\)/, JSON.stringify(new URL('../../../plugins/mcp-manager', import.meta.url).pathname)))
const { managerSources } = await import(pathToFileURL(adapter).href)
const outfile = join(directory, 'plugin.mjs')
await build({ entryPoints: [new URL('../src/standalone/plugin.ts', import.meta.url).pathname], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources] })
const standalone = await import(pathToFileURL(outfile).href)
async function serve(t, handler) {
  const server = createServer((request, response) => { Promise.resolve(handler(request, response)).catch(() => response.destroy()) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { origin: `http://127.0.0.1:${server.address().port}`, server }
}
async function until(check, label) {
  const deadline = Date.now() + 3000
  while (!check()) { if (Date.now() > deadline) throw new Error(`未观察到${label}`); await new Promise(resolve => setTimeout(resolve, 10)) }
}
async function fixture(t, mcp, extension) {
  const root = await mkdtemp(join(directory, 'fixture-')), home = join(root, 'home')
  await mkdir(join(home, 'standalone'), { recursive: true })
  const config = { agentId: 'fixture', experimentId: 'EXP-fixture-001', presetId: 'fixture', profilePatch: 'agent.patch.yml', mcp }
  if (extension) {
    const entry = 'runtime/extensions/security-operations-compositions/plugin.mjs'
    await mkdir(join(root, 'runtime/extensions/security-operations-compositions'), { recursive: true })
    await writeFile(join(root, entry), extension)
    config.extensions = [{ id: 'security-operations-compositions', entry, sha256: createHash('sha256').update(extension).digest('hex'), sourceDigest: 'a'.repeat(64) }]
  }
  await writeFile(join(home, 'standalone/config.json'), JSON.stringify(config))
  const routes = [], ctx = new Context()
  const gateway = await serve(t, (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const route = routes.find(item => item.kind === 'exact' ? item.path === path : path.startsWith(item.path))
    if (!route) return response.writeHead(404).end()
    return route.handler(request, response)
  })
  await ctx.plugin({ name: 'standalone-fixture-services', apply(inner) {
    new SystemPrompt(inner, {})
    new ToolRuntime(inner, { mode: 'native' })
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
  return { ctx, agent, emit() { ctx.emit('agent/created', { agent }) } }
}
test('真实 Cordis 插件依赖允许冻结业务扩展读取原生模型与设置服务', async t => {
  const f = await fixture(t, { servers: [], groups: [], sharedToken: 'a'.repeat(64) }, `export function populate(ctx) {
    if (!ctx.llm.fixture || !ctx.settingsController.fixture) throw new Error('缺少原生模型或设置服务');
    ctx.platformMcp.compositionExtension.id = 'fixture-extension';
  }`)
  assert.equal(f.ctx.platformMcp.compositionExtension.id, 'fixture-extension')
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
  const resources = await f.ctx.tools.get('list_mcp_resources', f.agent).execute({ server: 'resource-group' }, exec)
  assert.equal(resources.resources.length, 1)
  assert.match(resources.resources[0].uri, /^mcp-group:\/resource-group\/source\/r\//)
  const templates = await f.ctx.tools.get('list_mcp_resource_templates', f.agent).execute({ server: 'resource-group' }, exec)
  assert.equal(templates.resourceTemplates.length, 1)
  assert.match(templates.resourceTemplates[0].uriTemplate, /^mcp-group:\/resource-group\/source\/t\//)
  const read = await f.ctx.tools.get('read_mcp_resource', f.agent).execute({ server: 'resource-group', uri: resources.resources[0].uri }, exec)
  assert.equal(read.contents[0].text, 'resource-value')
  assert.equal(read.contents[0].uri, resources.resources[0].uri)
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
