import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

async function fixture(t) {
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
  t.after(() => { if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previousEntry })
  const root = await mkdtemp(join(tmpdir(), 'business-mcp-execution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await symlink(join(process.cwd(), 'node_modules'), join(root, 'node_modules'), 'dir')
  const source = await readFile(new URL('../build.mjs', import.meta.url), 'utf8')
  const adapter = join(root, 'adapter.mjs')
  const start = source.indexOf('export const managerSource ='), end = source.indexOf('\nconst { name } =', start)
  await writeFile(adapter, "import { readFile } from 'node:fs/promises'; import { resolve } from 'node:path';\n" + source.slice(start, end)
    .replace(/fileURLToPath\(new URL\('..\/..\/plugins\/mcp-manager', import.meta.url\)\)/, JSON.stringify(new URL('../../../plugins/mcp-manager', import.meta.url).pathname)))
  const { managerSources } = await import(pathToFileURL(adapter).href)
  const output = join(root, 'execution.mjs')
  await build({ stdin: { contents: "export * from 'harness-mcp-manager-server'; export { createMcpHandler, createPublishedCompositionClient } from './src/mcp/index.ts'; export { publishedCompositionService } from './src/mcp/compositions.ts'; export * from './src/business-control/core.ts'; export { managedDispatch } from './src/mcp/control.ts'", resolveDir: process.cwd(), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [managerSources] })
  const module = await import(pathToFileURL(output).href)
  const calls = [], observedHeaders = [], options = { method: 'post', path: '/writeback' }
  let origin
  const server = createServer(async (req, res) => {
    const bytes = []; for await (const chunk of req) bytes.push(chunk)
    const body = bytes.length ? JSON.parse(Buffer.concat(bytes)) : {}
    const url = new URL(req.url, origin)
    res.setHeader('content-type', 'application/json')
    const expiresAt = new Date(Date.now() + 60000).toISOString()
    if (url.pathname === '/authenticate') return res.end(JSON.stringify({ authenticated: true, subjectId: body.credential, credentialId: body.credential, expiresAt }))
    if (url.pathname === '/trust') return res.end(JSON.stringify({ valid: true, subjectId: body.subjectId, expiresAt }))
    if (url.pathname === '/risk') return res.end(JSON.stringify({ version: 1, expiresAt,
      scope: { subjectId: body.subjectId }, level: 'low', constraints: { deniedOperations: [] }, reasons: [] }))
    if (url.pathname === '/openapi.json') {
      options.onSpec?.()
      await options.specGate
      return res.end(JSON.stringify({ openapi: '3.0.0', info: { title: '控制验收', version: '1' }, servers: [{ url: origin }], paths: {
      '/query': { get: { operationId: 'query', responses: { 200: { description: 'ok' } } } },
      '/assets/{asset}': { get: { operationId: 'get_asset', parameters: [{ name: 'asset', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } },
      '/alerts': { get: { operationId: 'list_alerts', parameters: [{ name: 'assetId', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } },
      [options.path]: { [options.method]: { operationId: 'writeback', requestBody: options.method === 'post' ? { content: { 'application/json': { schema: { type: 'object' } } } } : undefined, responses: { 200: { description: 'ok' } } } },
      } }))
    }
    calls.push({ method: req.method, path: url.pathname })
    observedHeaders.push({ testRunId: req.headers['x-test-run-id'], subjectId: req.headers['x-control-subject-id'] })
    if (url.pathname.startsWith('/assets/')) return res.end(JSON.stringify({ id: 'asset-1', name: 'basic' }))
    if (url.pathname === '/alerts') return res.end(JSON.stringify({ alerts: [{ id: 'alert-1' }] }))
    res.end(JSON.stringify({ code: 200, result: 'ok' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  t.after(() => { server.closeAllConnections(); server.close() })
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    agents: [{ agentId: 'soc', enabled: true, subjects: ['a', 'b'], actions: ['*'], serverIds: ['soc'], sourceDigest: 'fixed' }],
    authentication: { endpoint: origin + '/authenticate' }, identityTrust: { endpoint: origin + '/trust' },
    riskAssessment: { endpoint: origin + '/risk', testRunId: 'isolated-business-test' },
    operations: [{ serverId: 'soc', operationId: 'query', kind: 'resource', target: origin + '/query', method: 'GET' },
      { serverId: 'soc', operationId: 'get_asset', kind: 'read', target: origin + '/assets/{asset}', method: 'GET' },
      { serverId: 'soc', operationId: 'list_alerts', kind: 'read', target: origin + '/alerts', method: 'GET', queryParameters: ['assetId'] },
      { serverId: 'soc', operationId: 'writeback', kind: 'write', target: origin + '/writeback', method: 'POST' }],
  }))
  const control = module.getBusinessControl(root)
  const binding = { workspaceId: 'workspace', agentId: 'soc', instanceId: 'shared', runtimeGeneration: 'one', sourceDigest: 'fixed' }
  control.registerInstance(binding)
  // 本文件验证MCP执行合同；真实签名握手另由网关HTTP和容器验收覆盖。
  control.recordAgentAuthentication(binding)
  const snapshot = control.issueSnapshot(binding.instanceId)
  control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId)
  const identities = {}
  for (const id of ['a', 'b']) {
    const identity = await control.authenticate({ transport: 'http', method: 'POST', path: '/', headers: { authorization: `Bearer ${id}` } })
    identities[id] = control.bindSession(control.createContext(identity, binding), `session-${id}`)
  }
  const service = { id: 'soc', specUrl: origin + '/openapi.json', enabled: true, tools: { mode: 'all', names: [] } }
  let dispatch
  module.apply({ webServer: { register: () => () => {} }, connection: { requestRejection: () => undefined }, effect: create => create(), on() {}, provide() {} }, {
    servers: { get: () => [service] }, groups: { get: () => [] }, sharedToken: { get: () => '' }, platformExecute: module.managedDispatch(root), platformDispatch: value => { dispatch = value },
  })
  const run = (id, request) => module.withBusinessContext(identities[id], () => dispatch({ serverId: 'soc', ...request }))
  return { module, root, origin, calls, observedHeaders, options, control, identities, service, dispatch, run }
}

test('真实原生OpenAPI执行只收紧A写入，A资源查询与B写入继续，目标账本可核对', async t => {
  const f = await fixture(t)
  f.control.updateRestriction({ scope: { workspaceId: 'workspace', agentId: 'soc', subjectId: 'a' }, deniedActions: ['write'], reason: 'synthetic', active: true })
  assert.equal((await f.run('a', { action: 'callTool', toolName: 'writeback', arguments: { body: { value: 'normal' } } })).status, 400)
  assert.deepEqual(f.calls, [])
  assert.equal((await f.run('a', { action: 'readResource', uri: f.origin + '/query' })).status, 200)
  assert.equal((await f.run('b', { action: 'callTool', toolName: 'writeback', arguments: { body: { value: 'normal' } } })).status, 200)
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/query' }, { method: 'POST', path: '/writeback' }])
  assert.deepEqual(f.observedHeaders, [{ testRunId: 'isolated-business-test', subjectId: 'a' }, { testRunId: 'isolated-business-test', subjectId: 'b' }])
  const headers = f.module.managedDispatch(f.root).requestHeaders
  assert.deepEqual(headers(f.origin), {}, '无业务上下文不注入主体标签')
  assert.deepEqual(f.module.withBusinessContext(f.identities.a, () => headers('http://another-origin.invalid/')), {}, '测试标签不外泄到其他来源')
  assert.equal((await f.dispatch({ action: 'callTool', serverId: 'soc', toolName: 'writeback', arguments: {} })).status, 400, '无可信主体的入口不得退回owner')
})

test('同一specUrl和operationId改变真实目标或方法时，未授权请求没有到达目标', async t => {
  const f = await fixture(t)
  for (const change of [{ path: '/other-target', method: 'post' }, { path: '/writeback', method: 'get' }]) {
    Object.assign(f.options, change)
    const result = await f.run('a', { action: 'callTool', toolName: 'writeback', arguments: { body: {} } })
    assert.equal(result.status, 400)
  }
  assert.deepEqual(f.calls, [])
})

test('独立handler调用也走相同控制，外部关联session_id不能赋予业务主体', async t => {
  const f = await fixture(t)
  const handler = f.module.createMcpHandler(f.root, { stateFile: join(f.root, 'connections.json') })
  assert.equal((await handler('registerOpenApi', { id: 'soc', specUrl: f.origin + '/openapi.json' })).ok, true)
  const call = () => handler('callTool', { connectionId: 'soc', toolName: 'writeback', arguments: { body: {} }, execution: { session_id: 'session-a' } })
  assert.equal((await call()).ok, false)
  assert.deepEqual(f.calls, [])
  assert.equal((await f.module.withBusinessContext(f.identities.a, call)).ok, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.observedHeaders[0].subjectId, 'a')
})

test('规格或检测异步等待期间停用连接，最终派发重新读取当前配置且上游零请求', async t => {
  const f = await fixture(t)
  let started, release
  const waiting = new Promise(resolve => { started = resolve })
  f.options.onSpec = () => started()
  f.options.specGate = new Promise(resolve => { release = resolve })
  const pending = f.run('a', { action: 'callTool', toolName: 'writeback', arguments: { body: {} } })
  await waiting
  f.service.enabled = false
  release()
  assert.equal((await pending).status, 400)
  assert.deepEqual(f.calls, [])
})

test('已发布组合保留真实业务上下文，在真实叶子授权；撤销A查询不影响B且拒绝请求零到达', async t => {
  const f = await fixture(t)
  const catalog = { schema_version: '1.0', compositions: [{ id: 'asset-alerts', published: {
    toolName: 'asset_alerts', title: '基础只读查询', description: '', connectionId: 'soc',
  } }] }
  const compositionsFile = join(f.root, 'config/mcp-compositions.json')
  await writeFile(compositionsFile, JSON.stringify(catalog))
  const handler = f.module.createMcpHandler(f.root, { servers: () => [f.service], compositionsFile })
  const platformClient = f.module.createPublishedCompositionClient(f.root, handler)
  const published = f.module.publishedCompositionService(catalog)
  let dispatch
  f.module.apply({ webServer: { register: () => () => {} }, connection: { requestRejection: () => undefined }, effect: create => create(), on() {}, provide() {} }, {
    servers: { get: () => [f.service, published] }, groups: { get: () => [] }, sharedToken: { get: () => '' }, platformClient,
    platformExecute: f.module.managedDispatch(f.root), platformDispatch: value => { dispatch = value },
  })
  const run = id => f.module.withBusinessContext(f.identities[id], () => dispatch({ action: 'callTool', serverId: published.id,
    toolName: 'asset_alerts', arguments: { asset: 'basic' } }))
  const first = await run('a')
  assert.equal(first.status, 200)
  assert.equal(first.value.isError, false, JSON.stringify(first.value))
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/assets/basic' }, { method: 'GET', path: '/alerts' }])
  f.control.updateRestriction({ scope: { workspaceId: 'workspace', agentId: 'soc', subjectId: 'a' }, deniedActions: ['read'], reason: 'synthetic', active: true })
  const denied = await run('a')
  assert.equal(denied.value.isError, true)
  assert.equal(f.calls.length, 2, 'A的受限组合没有派发任何叶子请求')
  const other = await run('b')
  assert.equal(other.value.isError, false)
  assert.equal(f.calls.length, 4)
})
