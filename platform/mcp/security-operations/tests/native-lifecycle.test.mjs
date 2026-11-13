import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { build } from 'esbuild'

test('真实 Cordis 生命周期保持已发布服务身份，扩展前后原生分组只发现当前可执行工具', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'composition-plugin-lifecycle-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const previousRoot = process.env.HARNESS_ASSET_ROOT, previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_ASSET_ROOT = temporary
  process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
  t.after(() => {
    if (previousRoot === undefined) delete process.env.HARNESS_ASSET_ROOT; else process.env.HARNESS_ASSET_ROOT = previousRoot
    if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry
  })
  await writeFile(join(temporary, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-native-lifecycle' }))
  await mkdir(join(temporary, 'config'))
  await writeFile(join(temporary, 'config/mcp-compositions.json'), JSON.stringify({ schema_version: '1.0', compositions: [{ id: 'collect-sample', published: {
    toolName: 'collect_sample', title: '基本取证样例', description: '', connectionId: 'platform-compositions', kind: 'threat-stage', stage: 'collect', bindings: { socConnectionId: 'soc', reportConnectionId: 'report' },
  } }] }))
  const { managerSources } = await import('../../../plugin/build.mjs')
  await symlink(join(process.env.HARNESS_PROGRAM_ROOT, 'platform/plugin/node_modules'), join(temporary, 'node_modules'), 'dir')
  const module = join(temporary, 'manager.mjs')
  await build({ entryPoints: [new URL('../../../plugin/src/mcp/manager.ts', import.meta.url).pathname], outfile: module, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources] })
  const manager = await import(pathToFileURL(module).href)
  const extensionOutput = execFileSync(process.execPath, [new URL('../build.mjs', import.meta.url).pathname], { encoding: 'utf8' }).trim()
  const extension = await import(pathToFileURL(join(extensionOutput, 'plugin.js')).href)
  const routes = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const route = routes.find(value => value.kind === 'exact' ? path === value.path : path.startsWith(value.path))
    if (!route) return response.writeHead(404).end()
    Promise.resolve(route.handler(request, response)).catch(() => response.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const context = new Context()
  context.provide('agents', {})
  context.provide('tools', {})
  context.provide('webServer', { port: server.address().port, register: route => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } })
  context.provide('connection', { requestRejection: () => undefined })
  context.provide('llm', {})
  context.provide('settingsController', { describe: () => ({ namespaces: [] }) })
  const token = '0'.repeat(64)
  const config = { servers: [], groups: [{ id: 'saved-group', members: [{ serverId: 'platform-compositions', names: ['collect_sample'] }] }], sharedToken: token }
  await mkdir(join(temporary, '.local/credentials'), { recursive: true })
  await writeFile(join(temporary, 'config/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, servers: config.servers, groups: config.groups }))
  await writeFile(join(temporary, '.local/credentials/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, sharedToken: token, servers: {} }))
  const managerFiber = await context.plugin(manager, config)
  t.after(() => managerFiber.dispose())
  assert.ok(context.platformMcp, '平台必须先成功提供服务，扩展才可通过原生注入装载')
  const client = new Client({ name: 'basic-lifecycle-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp/groups/saved-group`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  t.after(() => client.close())
  assert.deepEqual((await client.listTools()).tools, [])
  const extensionFiber = await context.plugin(extension)
  assert.equal(context.platformMcp.compositionExtension.id, 'security-operations-compositions')
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['mcp__compositions__collect_sample'])
  await extensionFiber.dispose()
  assert.deepEqual((await client.listTools()).tools, [])
  // 普通未知服务引用仍应被原有 snapshot 校验拒绝。
  const configuration = join(temporary, 'config/mcp-manager.json')
  const saved = await readFile(configuration, 'utf8')
  await writeFile(configuration, JSON.stringify({ schemaVersion: 1, servers: [], groups: [{ id: 'invalid-group', members: [{ serverId: 'missing-server', names: ['basic'] }] }] }))
  assert.throws(() => context.platformMcp.groups.get(), /invalid-group: 分组成员、工具或资源选择无效/)
  await writeFile(configuration, saved)
  assert.deepEqual((await client.listTools()).tools, [])
})
