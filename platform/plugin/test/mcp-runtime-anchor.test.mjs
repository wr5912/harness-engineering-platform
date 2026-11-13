import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { build } from 'esbuild'

test('MCP 从当前 Runtime 原生客户端闭包加载作用域，保留父作用域隔离和释放', async t => {
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  const entry = previousEntry ?? '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
  process.env.HARNESS_DSH_ENTRY = entry
  t.after(() => { if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry })
  const host = createRequire(entry), native = createRequire(host.resolve('@deepseek-ai/dsh-mcp-client'))
  const [{ Context }, { ToolRuntime }, { apply: applyNativeToolExecutor }, { SystemPrompt }, { createScope, scopeParentOf }] = await Promise.all([
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool-executor-native', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-scope',
  ].map(name => import(pathToFileURL(native.resolve(name)).href)))
  const parentDirectory = resolve('.local/mcp-runtime-anchor-tests'); mkdirSync(parentDirectory, { recursive: true })
  const directory = mkdtempSync(join(parentDirectory, 'build-')); t.after(() => rmSync(directory, { recursive: true, force: true }))
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir')
  const { managerSources } = await import('../build.mjs')
  const output = join(directory, 'manager.mjs')
  await build({ stdin: { contents: "export * from 'harness-mcp-manager-server'", resolveDir: process.cwd(), loader: 'ts' }, outfile: output,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources], logLevel: 'silent' })
  const manager = await import(pathToFileURL(output).href)
  assert.equal(manager.name, 'mcp-session-manager')
  const external = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({
    openapi: '3.0.0', info: { title: 'scope-fixture', version: '1' }, paths: { '/echo': { get: { operationId: 'echo', responses: { 200: { description: 'ok' } } } } },
  })) })
  external.listen(0, '127.0.0.1'); await once(external, 'listening')
  t.after(() => { external.closeAllConnections(); external.close() })
  const ctx = new Context(), scopes = []
  t.after(async () => { for (const scope of scopes) await scope.dispose(); await ctx.fiber.dispose() })
  await ctx.plugin({ name: 'scope-anchor-native-services', apply(inner) {
    inner.provide('webServer', { register: () => () => {}, publicPath: path => path })
    inner.provide('connection', { requestRejection: () => undefined })
    new SystemPrompt(inner, {}); new ToolRuntime(inner); applyNativeToolExecutor(inner)
  } })
  const server = { id: 'rc5', serverName: 'Rc5', enabled: true, specUrl: `http://127.0.0.1:${external.address().port}/openapi.json`, tools: { mode: 'all', names: [] } }
  await ctx.plugin({ name: 'scope-anchor-manager', inject: ['webServer', 'connection', 'tools'], apply(inner) {
    manager.apply(inner, { servers: { get: () => [server] }, groups: { get: () => [] }, sharedToken: { get: () => '' }, withToolContext: (_execution, run) => run() })
  } })
  const parentA = {}, parentB = {}, agentA = { id: 'a', session: { id: 'a' } }, agentB = { id: 'b', session: { id: 'b' } }
  await ctx.plugin({ name: 'scope-anchor-agents', inject: ['tools', 'systemPrompt'], apply(inner) {
    for (const [agent, parent] of [[agentA, parentA], [agentB, parentB]]) { const scope = createScope(inner, agent, { parent }); agent.ctx = scope.ctx; scopes.push(scope) }
  } })
  assert.equal(scopeParentOf(agentA), parentA)
  await ctx.serial('agent/created', { agent: agentA })
  for (let attempt = 0; attempt < 200 && !ctx.tools.get('mcp__Rc5__echo', agentA); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(ctx.tools.get('mcp__Rc5__echo', agentA), '当前 Runtime 的父作用域可以看到 MCP 工具')
  assert.equal(ctx.tools.get('mcp__Rc5__echo', agentB), undefined, '兄弟作用域不获得工具')
  await scopes[0].dispose()
  assert.equal(ctx.tools.get('mcp__Rc5__echo', agentA), undefined, '最后使用者释放后清理作用域工具')
})
