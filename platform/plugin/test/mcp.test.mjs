import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { publishCompositionVersion } from '../src/mcp/compositions.ts'
import { registerFixedCompositionTools, withFixedCompositionExecution } from '../src/workflows/fixed-composition.ts'

async function loadMcpModule(native = false) {
  process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
  const outdir = await mkdtemp(join(tmpdir(), 'mcp-module-'))
  const outfile = join(outdir, 'index.mjs')
  await symlink(join(process.cwd(), 'node_modules'), join(outdir, 'node_modules'), 'dir')
  await build({
    entryPoints: [native ? 'src/mcp/native.ts' : 'src/mcp/index.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    plugins: native ? [(await import('../build.mjs')).managerSources] : [],
  })
  return import(outfile)
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function jsonRpc(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : undefined }
}

async function withFixture(fn) {
  const calls = []
  let baseUrl = ''
  const spec = () => ({
    openapi: '3.0.0',
    info: { title: 'fixture', version: '1.0.0' },
    servers: [{ url: baseUrl }],
    paths: {
      '/assets/{asset}': {
        get: {
          operationId: 'get_asset',
          parameters: [{ name: 'asset', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
      '/alerts': {
        get: {
          operationId: 'list_alerts',
          parameters: [
            { name: 'assetId', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
        },
      },
    },
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    const authed = req.headers.authorization === 'Bearer secret-token'
    calls.push({ path: url.pathname, search: url.search, authed })
    if (url.pathname === '/openapi.json') {
      if (!authed) return res.writeHead(401).end('auth required')
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(spec()))
    }
    if (!authed) return res.writeHead(403).end('forbidden')
    if (url.pathname.startsWith('/assets/')) {
      const asset = decodeURIComponent(url.pathname.slice('/assets/'.length))
      if (asset === 'bad') return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'missing' }))
      if (asset === 'missing-id') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: asset }))
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'asset-123', name: asset, echo: 'secret-token' }))
    }
    if (url.pathname === '/alerts') {
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        alerts: [
          { id: 'a1', assetId: url.searchParams.get('assetId') },
          { id: 'a2', assetId: url.searchParams.get('assetId') },
          { id: 'a3', assetId: url.searchParams.get('assetId') },
        ],
      }))
    }
    res.writeHead(404).end('not found')
  })
  const port = await listen(server)
  baseUrl = `http://127.0.0.1:${port}`
  try {
    await fn({ baseUrl, calls })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function withServer(handler, fn) {
  const server = createServer(handler)
  const port = await listen(server)
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

async function setup(module, baseUrl) {
  const temp = await mkdtemp(join(tmpdir(), 'mcp-test-'))
  const credentialPath = join(temp, 'token.txt')
  await writeFile(credentialPath, 'secret-token\n', 'utf8')
  const compositionsFile = join(temp, 'compositions.json')
  await writeFile(compositionsFile, await readFile(new URL('./fixtures/mcp-compositions.json', import.meta.url)))
  const handler = module.createMcpHandler(join(process.cwd(), '../..'), { stateFile: join(temp, 'state.json'), compositionsFile })
  const rpc = (endpoint, payload) => handler(endpoint, payload, new AbortController().signal, undefined)
  const registered = await rpc('registerOpenApi', {
    id: 'security-readonly-api',
    title: 'Security Readonly API',
    specUrl: `${baseUrl}/openapi.json`,
    credentialRef: { kind: 'file', path: credentialPath },
  })
  assert.equal(registered.ok, true)
  return { handler, rpc, temp, compositionsFile }
}

async function compositionRequest(rpc, endpoint, input, selection) {
  const listed = await rpc('list', {})
  assert.equal(listed.ok, true)
  const request = selection ?? { compositionId: listed.value.compositions[0].id, version: 'published' }
  return rpc(endpoint, { ...request, revision: listed.value.revision, input }, new AbortController().signal)
}

test('MCP 组合执行两次真实 HTTP 调用并映射参数', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc } = await setup(module, baseUrl)
    const result = await compositionRequest(rpc, 'executeComposition', { asset: 'host-a', limit: 2 })
    assert.equal(result.ok, true)
    assert.equal(result.value.ok, true)
    assert.equal(result.value.result.alerts.length, 2)
    assert.equal(result.value.result.trace[1].mappedArguments.assetId, 'asset-123')
    assert.equal(calls.filter(call => call.path === '/assets/host-a').length, 1)
    assert.equal(calls.filter(call => call.path === '/alerts' && call.search.includes('assetId=asset-123')).length, 1)
    assert.equal(JSON.stringify(result).includes('secret-token'), false)
  })
})

test('前置失败时停止第二步', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc } = await setup(module, baseUrl)
    const result = await compositionRequest(rpc, 'executeComposition', { asset: 'bad', limit: 2 })
    assert.equal(result.ok, true)
    assert.equal(result.value.ok, false)
    assert.equal(result.value.result.trace[1].status, 'skipped')
    assert.equal(calls.some(call => call.path === '/alerts'), false)
  })
})

test('编译图作为结构来源；dry 校验不读取规格或调用上游', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc } = await setup(module, baseUrl)
    const listed = await rpc('list', {})
    const graph = listed.value.compositions[0].graphs.published
    assert.deepEqual(graph.nodes.filter(node => node.operationId).map(node => node.operationId), ['get_asset', 'list_alerts'])
    assert.equal(graph.nodes.find(node => node.id === 'listAlerts').input.assetId, '$state.assetId')
    assert.ok(graph.edges.some(edge => edge.source === 'getAsset' && edge.target === 'listAlerts' && edge.conditional))
    const dry = await compositionRequest(rpc, 'dryRunComposition', { asset: ' host-a ', limit: 2 })
    assert.equal(dry.ok, true)
    assert.equal(dry.value.mode, 'dry')
    assert.equal(dry.value.input.asset, 'host-a')
    assert.equal(dry.value.upstreamRequests, 0)
    assert.equal((await compositionRequest(rpc, 'dryRunComposition', { asset: 'host-a', limit: 21 })).ok, false)
    assert.equal((await compositionRequest(rpc, 'dryRunComposition', { asset: 'host-a', extra: true })).ok, false)
    assert.deepEqual(calls, [])
    await rpc('deleteConnection', { connectionId: 'security-readonly-api' })
    assert.equal((await compositionRequest(rpc, 'dryRunComposition', { asset: 'host-a' })).ok, false)
  })
})

test('LangGraph 缺少映射 ID 时结束图并保留第一步回执', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc } = await setup(module, baseUrl)
    const result = await compositionRequest(rpc, 'executeComposition', { asset: 'missing-id' })
    assert.equal(result.value.ok, false)
    assert.equal(result.value.error.code, 'mapping_failed')
    assert.equal(result.value.receipts.length, 1)
    assert.equal(result.value.result.trace[1].status, 'skipped')
    assert.equal(calls.some(call => call.path === '/alerts'), false)
  })
})

test('Gateway 生命周期发现和调用使用同一执行入口与 digest', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl }) => {
    const { handler, rpc } = await setup(module, baseUrl)
    const server = createServer(module.createMcpGatewayRequestHandler(process.cwd(), handler))
    const port = await listen(server)
    const url = `http://127.0.0.1:${port}`
    try {
      const init = await jsonRpc(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      assert.equal(init.status, 200)
      assert.equal(init.body.result.serverInfo.name, 'harness-platform-mcp-composition')
      const notified = await jsonRpc(url, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      assert.equal(notified.status, 202)
      const listed = await jsonRpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      assert.equal(listed.status, 200)
      assert.equal(listed.body.result.tools[0].name, 'query_asset_related_alerts')
      const gatewayCall = await jsonRpc(url, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'query_asset_related_alerts', arguments: { asset: 'host-a', limit: 2 } },
      })
      assert.equal(gatewayCall.status, 200)
      const gatewayValue = JSON.parse(gatewayCall.body.result.content[0].text)
      const guiValue = await compositionRequest(rpc, 'executeComposition', { asset: 'host-a', limit: 2 })
      assert.equal(gatewayValue.ok, true)
      assert.equal(gatewayValue.version.digest, guiValue.value.version.digest)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

test('只读组合拒绝同名 POST 操作', async () => {
  const module = await loadMcpModule()
  await withServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    if (url.pathname === '/openapi.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'fixture', version: '1.0.0' },
      servers: [{ url: `http://${req.headers.host}` }],
      paths: {
        '/assets': { post: { operationId: 'get_asset', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } } } },
        '/alerts': { get: { operationId: 'list_alerts', parameters: [{ name: 'assetId', in: 'query', required: true, schema: { type: 'string' } }] } },
      },
    }))
    res.writeHead(500).end('should not call')
  }, async baseUrl => {
    const temp = await mkdtemp(join(tmpdir(), 'mcp-readonly-'))
    const rpc = module.createMcpHandler(join(process.cwd(), '../..'), { stateFile: join(temp, 'state.json'), compositionsFile: join(process.cwd(), 'test/fixtures/mcp-compositions.json') })
    assert.equal((await rpc('registerOpenApi', { id: 'security-readonly-api', specUrl: `${baseUrl}/openapi.json` })).ok, true)
    const result = await compositionRequest(rpc, 'executeComposition', { asset: 'host-a' })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /非 GET/)
  })
})

test('连接登记可重载和删除，重启后状态回到 unknown', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl }) => {
    const temp = await mkdtemp(join(tmpdir(), 'mcp-state-'))
    const credentialPath = join(temp, 'secret-ref.txt')
    const stateFile = join(temp, 'state.json')
    await writeFile(credentialPath, 'secret-token\n', 'utf8')
    const first = module.createMcpHandler(process.cwd(), { stateFile })
    assert.equal((await first('registerOpenApi', { id: 'security-readonly-api', specUrl: `${baseUrl}/openapi.json`, credentialRef: { kind: 'file', path: credentialPath } })).ok, true)
    assert.equal((await readFile(stateFile, 'utf8')).includes('secret-token'), false)

    const second = module.createMcpHandler(process.cwd(), { stateFile })
    const listed = await second('list', {})
    assert.equal(listed.ok, true)
    assert.equal(listed.value.connections[0].status.specLoaded, 'unknown')
    assert.equal(listed.value.connections[0].status.toolCallSucceeded, 'unknown')

    assert.equal((await second('deleteConnection', { connectionId: 'security-readonly-api' })).ok, true)
    const afterDelete = await module.createMcpHandler(process.cwd(), { stateFile })('list', {})
    assert.equal(afterDelete.value.connections.length, 0)
  })
})

test('HTTP MCP 登记、发现 tools/list 与单工具试跑', async () => {
  const module = await loadMcpModule()
  const seen = []
  let sessionSeq = 0
  await withServer(async (req, res) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      const body = JSON.parse(text)
      const session = req.headers['mcp-session-id']
      const protocol = req.headers['mcp-protocol-version']
      seen.push({ method: body.method, accept: req.headers.accept, session, protocol })
      if (!String(req.headers.accept).includes('application/json') || !String(req.headers.accept).includes('text/event-stream')) return res.writeHead(406).end('bad accept')
      if (body.method === 'initialize') {
        const issued = `session-${++sessionSeq}`
        return res.writeHead(200, { 'content-type': 'application/json', 'Mcp-Session-Id': issued }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } } }))
      }
      if (!session || protocol !== '2024-11-05') return res.writeHead(428).end('missing session or protocol')
      if (body.method === 'notifications/initialized') return res.writeHead(202).end()
      if (body.method === 'tools/list') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', required: ['body'], properties: { body: { type: 'object' } } } }, { name: 'fail', inputSchema: { type: 'object' } }, { name: 'sse', inputSchema: { type: 'object' } }] } }))
      if (body.method === 'tools/call' && body.params.name === 'fail') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'failed' }], isError: true } }))
      if (body.method === 'tools/call' && body.params.name === 'sse') return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(body.params.arguments) }] } })}\n\n`)
      if (body.method === 'tools/call') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(body.params.arguments) }] } }))
      res.writeHead(404).end()
    })
  }, async baseUrl => {
    const rpc = module.createMcpHandler(process.cwd(), { stateFile: join(await mkdtemp(join(tmpdir(), 'mcp-http-state-')), 'state.json') })
    assert.equal((await rpc('registerMcp', { id: 'managed-mcp', endpointUrl: baseUrl })).ok, true)
    const listed = await rpc('refreshSpec', { connectionId: 'managed-mcp' }, new AbortController().signal)
    assert.equal(listed.ok, true)
    assert.equal(listed.value.tools[0].name, 'echo')
    const called = await rpc('callTool', { connectionId: 'managed-mcp', toolName: 'echo', arguments: { body: { ok: true } } }, new AbortController().signal)
    assert.equal(called.ok, true)
    assert.equal(called.value.status.toolCallSucceeded, true)
    const failed = await rpc('callTool', { connectionId: 'managed-mcp', toolName: 'fail', arguments: {} }, new AbortController().signal)
    assert.equal(failed.ok, true)
    assert.equal(failed.value.status.toolCallSucceeded, false)
    const sse = await rpc('callTool', { connectionId: 'managed-mcp', toolName: 'sse', arguments: { body: { ok: 'sse' } } }, new AbortController().signal)
    assert.equal(sse.ok, true)
    assert.equal(JSON.parse(sse.value.content[0].text).body.ok, 'sse')
    assert.deepEqual(seen.slice(0, 3).map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list'])
    assert.equal(seen[1].session, 'session-1')
    assert.equal(seen[2].session, 'session-1')
    assert.equal(seen[1].protocol, '2024-11-05')
  })
})

test('MCP 自定义凭据 Header 保持原始 secret 且错误脱敏', async () => {
  const module = await loadMcpModule()
  const temp = await mkdtemp(join(tmpdir(), 'mcp-custom-header-'))
  const credentialPath = join(temp, 'token.txt')
  await writeFile(credentialPath, 'secret-token\n', 'utf8')
  const headers = []
  await withServer(async (req, res) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      headers.push(req.headers['x-api-key'])
      const body = JSON.parse(text)
      if (req.headers['x-api-key'] !== 'secret-token') return res.writeHead(401).end('bad secret-token')
      if (body.method === 'initialize') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }))
      if (body.method === 'notifications/initialized') return res.writeHead(202).end()
      if (body.method === 'tools/list') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'upstream secret-token failed' } }))
      res.writeHead(404).end()
    })
  }, async baseUrl => {
    const rpc = module.createMcpHandler(process.cwd(), { stateFile: join(temp, 'state.json') })
    assert.equal((await rpc('registerMcp', { id: 'custom-mcp', endpointUrl: baseUrl, authHeader: 'X-Api-Key', credentialRef: { kind: 'file', path: credentialPath } })).ok, true)
    const result = await rpc('refreshSpec', { connectionId: 'custom-mcp' }, new AbortController().signal)
    assert.equal(result.ok, false)
    assert.equal(headers.includes('secret-token'), true)
    assert.equal(JSON.stringify(result).includes('Bearer secret-token'), false)
    assert.equal(JSON.stringify(result).includes('secret-token'), false)
  })
})

test('OpenAPI 单工具试跑校验必填 header 和 body', async () => {
  const module = await loadMcpModule()
  await withServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    if (url.pathname === '/openapi.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'fixture', version: '1.0.0' },
      servers: [{ url: `http://${req.headers.host}` }],
      paths: {
        '/needs-header': { get: { operationId: 'needs_header', parameters: [{ name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } }] } },
        '/needs-body': { post: { operationId: 'needs_body', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
    }))
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
  }, async baseUrl => {
    const rpc = module.createMcpHandler(process.cwd(), { stateFile: join(await mkdtemp(join(tmpdir(), 'mcp-required-')), 'state.json') })
    assert.equal((await rpc('registerOpenApi', { id: 'tool-api', specUrl: `${baseUrl}/openapi.json` })).ok, true)
    const missingHeader = await rpc('callTool', { connectionId: 'tool-api', toolName: 'needs_header', arguments: {} }, new AbortController().signal)
    assert.equal(missingHeader.ok, false)
    assert.match(missingHeader.error.message, /缺少参数：X-Tenant/)
    const missingBody = await rpc('callTool', { connectionId: 'tool-api', toolName: 'needs_body', arguments: {} }, new AbortController().signal)
    assert.equal(missingBody.ok, false)
    assert.match(missingBody.error.message, /缺少参数：body/)
  })
})

test('取消贯通规范加载，失败不写成成功状态', async () => {
  const module = await loadMcpModule()
  await withServer((req, res) => {
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'), 100)
  }, async baseUrl => {
    const rpc = module.createMcpHandler(process.cwd(), { stateFile: join(await mkdtemp(join(tmpdir(), 'mcp-abort-')), 'state.json') })
    await rpc('registerOpenApi', { id: 'security-readonly-api', specUrl: `${baseUrl}/openapi.json` })
    const result = await rpc('refreshSpec', { connectionId: 'security-readonly-api' }, AbortSignal.timeout(1))
    assert.equal(result.ok, false)
    const listed = await rpc('list', {})
    assert.equal(listed.value.connections[0].status.specLoaded, false)
  })
})

test('原生 Gateway 只注册 connection.fetch，不重复注册 RPC，且 GET 不支持', async () => {
  const module = await loadMcpModule()
  const calls = { fetch: [], rpc: [] }
  module.applyMcpGateway({
    connection: {
      fetch: { register: config => calls.fetch.push(config) },
      rpc: { handle: (...args) => calls.rpc.push(args) },
    },
  }, process.cwd(), module.createMcpHandler(process.cwd(), { stateFile: join(await mkdtemp(join(tmpdir(), 'mcp-gateway-')), 'state.json') }))
  assert.equal(calls.rpc.length, 0)
  assert.equal(calls.fetch[0].path, '/api/harness-platform/mcp')
  assert.deepEqual(calls.fetch[0].methods, ['POST'])
  assert.equal(calls.fetch[0].requestBody, 'buffered')
  assert.equal((await calls.fetch[0].fetch(new Request('http://fixture.local/api/harness-platform/mcp'))).status, 405)
  const init = await calls.fetch[0].fetch(new Request('http://fixture.local/api/harness-platform/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'bad-version' } }),
  }))
  assert.equal((await init.json()).result.protocolVersion, '2025-06-18')
  const notification = await calls.fetch[0].fetch(new Request('http://fixture.local/api/harness-platform/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  }))
  assert.equal(notification.status, 202)
  const batch = await calls.fetch[0].fetch(new Request('http://fixture.local/api/harness-platform/mcp', {
    method: 'POST',
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]),
  }))
  assert.equal(batch.status, 400)
})

test('凭据不进入规范 URL、错误或运行结果', async () => {
  const module = await loadMcpModule()
  const rpc = module.createMcpHandler(process.cwd(), { stateFile: join(await mkdtemp(join(tmpdir(), 'mcp-leak-')), 'state.json') })
  const rejected = await rpc('registerOpenApi', { id: 'security-readonly-api', specUrl: 'http://127.0.0.1/openapi.json?token=secret-token' })
  assert.equal(rejected.ok, false)
  await withFixture(async ({ baseUrl }) => {
    const { rpc: authed } = await setup(module, baseUrl)
    const result = await compositionRequest(authed, 'executeComposition', { asset: 'host-a', limit: 1 })
    assert.equal(JSON.stringify(result).includes('secret-token'), false)
  })
})

test('OpenAPI 自定义凭据 Header 不加 Bearer 且结果按 literal 脱敏', async () => {
  const module = await loadMcpModule()
  const temp = await mkdtemp(join(tmpdir(), 'mcp-openapi-custom-'))
  const credentialPath = join(temp, 'token.txt')
  await writeFile(credentialPath, 'secret-token\n', 'utf8')
  const seen = []
  await withServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    seen.push(req.headers['x-api-key'])
    if (req.headers['x-api-key'] !== 'secret-token') return res.writeHead(401).end('bad auth')
    if (url.pathname === '/openapi.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'fixture', version: '1.0.0' },
      servers: [{ url: `http://${req.headers.host}` }],
      paths: { '/echo': { get: { operationId: 'echo_secret' } } },
    }))
    if (url.pathname === '/echo') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ echoed: 'secret-token' }))
    res.writeHead(404).end()
  }, async baseUrl => {
    const rpc = module.createMcpHandler(process.cwd(), { stateFile: join(temp, 'state.json') })
    assert.equal((await rpc('registerOpenApi', { id: 'custom-openapi', specUrl: `${baseUrl}/openapi.json`, authHeader: 'X-Api-Key', credentialRef: { kind: 'file', path: credentialPath } })).ok, true)
    const result = await rpc('callTool', { connectionId: 'custom-openapi', toolName: 'echo_secret', arguments: {} }, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.equal(seen.includes('secret-token'), true)
    assert.equal(JSON.stringify(result).includes('Bearer secret-token'), false)
    assert.equal(JSON.stringify(result).includes('secret-token'), false)
  })
})

test('同 ID 重新登记会排除另一种连接类型，默认状态写入工作区本地目录', async () => {
  const module = await loadMcpModule()
  const assetRoot = await mkdtemp(join(tmpdir(), 'mcp-asset-root-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'mcp-xdg-state-'))
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateRoot
  try {
    await withServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture.local')
      if (url.pathname === '/openapi.json') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture', version: '1.0.0' }, paths: {} }))
      res.writeHead(404).end()
    }, async baseUrl => {
      const rpc = module.createMcpHandler(assetRoot)
      assert.equal((await rpc('registerOpenApi', { id: 'same-id', specUrl: `${baseUrl}/openapi.json` })).ok, true)
      assert.equal((await rpc('registerMcp', { id: 'same-id', endpointUrl: baseUrl })).ok, true)
      const listed = await rpc('list', {})
      assert.equal(listed.value.connections.length, 1)
      assert.equal(listed.value.connections[0].kind, 'mcp-http')
      assert.equal((await readdir(join(assetRoot, '.local', 'state'))).includes('mcp-connections.json'), true)
      assert.deepEqual(await readdir(stateRoot), [])
    })
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
  }
})


test('平台接入传入仓库根目录时组合回执仍含实际实现摘要', async () => {
  const module = await loadMcpModule()
  const temp = await mkdtemp(join(tmpdir(), 'mcp-root-digest-'))
  const handler = module.createMcpHandler(join(process.cwd(), '../..'), { stateFile: join(temp, 'state.json'), compositionsFile: join(process.cwd(), 'test/fixtures/mcp-compositions.json') })
  const result = await handler('list', {})
  assert.equal(result.ok, true)
  assert.match(result.value.implementation.sourceDigest, /^[0-9a-f]{64}$/)
  assert.match(result.value.implementation.gitCommit, /^[0-9a-f]{40}$/)
})

test('多版本列表每次只读取四项 Git 来源，慢 Git 不阻塞事件循环且 dirty 实时更新', async () => {
  const module = await loadMcpModule()
  const root = await mkdtemp(join(tmpdir(), 'mcp-list-git-'))
  const compositions = []
  for (let index = 0; index < 2; index++) {
    const entry = { id: `composition-${index}` }
    publishCompositionVersion(entry, { toolName: `query_${index}`, title: `组合 ${index}`, description: '', connectionId: 'source' })
    compositions.push(entry)
  }
  const compositionsFile = join(root, 'compositions.json')
  await writeFile(compositionsFile, JSON.stringify({ schema_version: '1.0', compositions }))
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', 'compositions.json'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: root })

  const bin = await mkdtemp(join(tmpdir(), 'mcp-git-wrapper-')), callsFile = join(bin, 'git-calls.log')
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  await writeFile(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$MCP_GIT_CALLS_FILE"\nsleep 0.05\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
  const previousPath = process.env.PATH, previousCallsFile = process.env.MCP_GIT_CALLS_FILE
  process.env.PATH = `${bin}:${previousPath}`
  process.env.MCP_GIT_CALLS_FILE = callsFile
  try {
    const rpc = module.createMcpHandler(root, { compositionsFile })
    const firstRequest = rpc('list', {})
    assert.equal(await Promise.race([firstRequest.then(() => 'list'), new Promise(resolve => setTimeout(() => resolve('timer'), 20))]), 'timer')
    const first = await firstRequest
    assert.equal(first.ok, true)
    assert.equal(first.value.implementation.gitDirty, false)
    assert.equal(first.value.compositions.length, 2)
    assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 4)

    await writeFile(join(root, 'untracked.txt'), '工作区变化')
    const second = await rpc('list', {})
    assert.equal(second.ok, true)
    assert.equal(second.value.implementation.gitDirty, true)
    assert.deepEqual(second.value.compositions.map(entry => entry.binding), first.value.compositions.map(entry => entry.binding))
    assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 8)

    const fixed = await rpc('callPublishedComposition', { ...second.value.compositions[0].binding, toolName: 'query_0', input: { asset: 'host-a' } })
    assert.equal(fixed.ok, false)
    assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 12)

    const missingRoot = await module.createMcpHandler(join(root, 'missing'), { compositionsFile })('list', {})
    assert.equal(missingRoot.ok, true)
    assert.equal(missingRoot.value.implementation.gitCommit, 'unknown')
    assert.equal(missingRoot.value.implementation.gitDirty, 'unknown')
    assert.deepEqual(missingRoot.value.compositions.map(entry => entry.binding), second.value.compositions.map(entry => entry.binding))
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousCallsFile === undefined) delete process.env.MCP_GIT_CALLS_FILE
    else process.env.MCP_GIT_CALLS_FILE = previousCallsFile
  }
})

test('平台 MCP 读取原插件的已保存配置，不建立第二份连接登记', async () => {
  const module = await loadMcpModule()
  let servers = [{ id: 'original', specUrl: 'http://127.0.0.1:8080/openapi.json', enabled: true },
    { id: 'disabled', url: 'http://127.0.0.1:8080/mcp', enabled: false }]
  const handler = module.createMcpHandler(join(process.cwd(), '../..'), { servers: () => servers, compositionsFile: join(process.cwd(), 'test/fixtures/mcp-compositions.json') })
  const list = () => handler('list', {}, new AbortController().signal)
  assert.deepEqual((await list()).value.connections.map(item => item.id), ['original'])
  for (const endpoint of ['registerOpenApi', 'registerMcp', 'deleteConnection', 'refreshSpec', 'callTool']) {
    assert.equal((await handler(endpoint, {}, new AbortController().signal)).error.code, 'use_mcp_manager')
  }
  servers = [{ id: 'replacement', url: 'http://127.0.0.1:8080/mcp', enabled: true }]
  assert.deepEqual((await list()).value.connections.map(item => item.id), ['replacement'])
})

test('编排草稿持久化，旧发布版保持可调用，dry 发布后 Gateway 切换版本', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc, handler, compositionsFile, temp } = await setup(module, baseUrl)
    const original = (await rpc('list', {})).value
    const entry = original.compositions[0]
    const draft = { ...entry.published, toolName: 'query_asset_alerts_v2', title: '新版资产告警' }
    const saved = await rpc('saveCompositionDraft', { compositionId: entry.id, revision: original.revision, draft })
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.value.compositions[0].published, entry.published)
    assert.equal(saved.value.compositions[0].draft.toolName, draft.toolName)
    assert.notEqual(saved.value.revision, original.revision)
    const reload = module.createMcpHandler(join(process.cwd(), '../..'), { compositionsFile, stateFile: join(temp, 'state.json') })
    assert.deepEqual((await reload('list', {})).value.compositions, saved.value.compositions)
    const gateway = module.createMcpGatewayFetchHandler(process.cwd(), handler)
    const request = async (method, params) => (await gateway(new Request('http://fixture.local', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }))).json()
    assert.deepEqual((await request('tools/list')).result.tools.map(item => item.name), ['query_asset_related_alerts'])
    assert.equal((await request('tools/call', { name: draft.toolName, arguments: { asset: 'host-a' } })).error.code, -32602)
    const dry = await compositionRequest(rpc, 'dryRunComposition', { asset: 'host-a' }, { compositionId: entry.id, version: 'draft' })
    assert.equal(dry.value.version.definition.toolName, draft.toolName)
    assert.equal(dry.value.upstreamRequests, 0)
    assert.deepEqual(calls, [])
    const old = await request('tools/call', { name: entry.published.toolName, arguments: { asset: 'host-a' } })
    assert.equal(JSON.parse(old.result.content[0].text).version.definition.toolName, entry.published.toolName)
    calls.length = 0
    const published = await rpc('publishComposition', { compositionId: entry.id, version: 'draft', revision: saved.value.revision, input: { asset: 'host-a' } })
    assert.equal(published.ok, true)
    assert.equal(published.value.dry.upstreamRequests, 0)
    assert.deepEqual(calls, [])
    assert.equal(published.value.compositions[0].draft, undefined)
    assert.equal(published.value.compositions[0].published.toolName, draft.toolName)
    assert.ok(published.value.compositions[0].published.publishedAt)
    assert.deepEqual((await request('tools/list')).result.tools.map(item => item.name), [draft.toolName])
    assert.equal((await request('tools/call', { name: entry.published.toolName, arguments: { asset: 'host-a' } })).error.code, -32602)
    const current = await request('tools/call', { name: draft.toolName, arguments: { asset: 'host-a' } })
    assert.equal(JSON.parse(current.result.content[0].text).version.definition.toolName, draft.toolName)
    assert.deepEqual((await reload('list', {})).value.compositions, published.value.compositions)
  })
})

test('已发布编排服务与 Gateway 共用工具和执行路径，草稿发布后即时切换', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc, handler } = await setup(module, baseUrl)
    const client = module.createPublishedCompositionClient(join(process.cwd(), '../..'), handler)
    const original = (await rpc('list', {})).value
    assert.equal(original.publishedService.id, 'platform-compositions')
    assert.deepEqual(original.publishedService.tools.names, ['query_asset_related_alerts'])
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), original.publishedService.tools.names)
    assert.deepEqual(await client.listResources(), { resources: [] })
    const entry = original.compositions[0]
    const draft = { ...entry.published, toolName: 'published_service_v2' }
    const saved = await rpc('saveCompositionDraft', { compositionId: entry.id, revision: original.revision, draft })
    assert.deepEqual(saved.value.publishedService.tools.names, ['query_asset_related_alerts'])
    await assert.rejects(client.callTool({ name: draft.toolName, arguments: { asset: 'host-a' } }), /Unknown tool/)
    const result = await client.callTool({ name: entry.published.toolName, arguments: { asset: 'host-a', limit: 2 } })
    assert.equal(result.isError, false)
    assert.equal(JSON.parse(result.content[0].text).result.alerts.length, 2)
    assert.equal(calls.filter(call => call.path.startsWith('/assets/')).length, 1)
    assert.equal(calls.filter(call => call.path === '/alerts').length, 1)
    calls.length = 0
    const published = await rpc('publishComposition', { compositionId: entry.id, version: 'draft', revision: saved.value.revision, input: { asset: 'host-a' } })
    assert.equal(published.ok, true)
    assert.deepEqual(published.value.publishedService.tools.names, [draft.toolName])
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [draft.toolName])
    await assert.rejects(client.callTool({ name: entry.published.toolName, arguments: { asset: 'host-a' } }), /Unknown tool/)
    assert.deepEqual(calls, [])
  })
})

test('多个编排独立选择，未发布草稿不进入发现列表且使用自己的连接', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc, handler, temp } = await setup(module, baseUrl)
    const original = (await rpc('list', {})).value
    const missingDraft = { ...original.compositions[0].published, toolName: 'another_query', title: '另一编排', connectionId: 'another-api' }
    const created = await rpc('saveCompositionDraft', { revision: original.revision, draft: missingDraft })
    assert.equal(created.ok, true)
    assert.equal(created.value.compositions.length, 2)
    const entry = created.value.compositions[1]
    const selection = { compositionId: entry.id, version: 'draft' }
    assert.equal((await compositionRequest(rpc, 'dryRunComposition', { asset: 'host-a' }, selection)).ok, false)
    const before = JSON.stringify((await rpc('list', {})).value.compositions)
    assert.equal((await rpc('publishComposition', { ...selection, revision: created.value.revision, input: { asset: 'host-a' } })).ok, false)
    assert.equal(JSON.stringify((await rpc('list', {})).value.compositions), before)
    assert.deepEqual(calls, [])
    const gateway = module.createMcpGatewayFetchHandler(process.cwd(), handler)
    const discovered = async () => (await (await gateway(new Request('http://fixture.local', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }))).json()).result.tools.map(item => item.name)
    assert.deepEqual(await discovered(), ['query_asset_related_alerts'])
    await rpc('registerOpenApi', { id: 'another-api', specUrl: `${baseUrl}/openapi.json`, credentialRef: { kind: 'file', path: join(temp, 'token.txt') } })
    assert.equal((await compositionRequest(rpc, 'dryRunComposition', { asset: 'host-a' }, selection)).ok, true)
    const executed = await compositionRequest(rpc, 'executeComposition', { asset: 'host-a' }, selection)
    assert.equal(executed.value.version.definition.connectionId, 'another-api')
    assert.equal(executed.ok, true)
    assert.equal(executed.value.ok, true)
    assert.ok(executed.value.receipts.every(receipt => receipt.connectionId === 'another-api'))
    const callCount = calls.length
    const published = await rpc('publishComposition', { ...selection, revision: created.value.revision, input: { asset: 'host-a' } })
    assert.equal(published.ok, true)
    assert.equal(calls.length, callCount)
    assert.deepEqual(await discovered(), ['query_asset_related_alerts', 'another_query'])
  })
})

test('目录冲突、重复工具名及非法配置不覆盖草稿和已发布内容', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl }) => {
    const { rpc, compositionsFile } = await setup(module, baseUrl)
    const initial = (await rpc('list', {})).value
    const entry = initial.compositions[0]
    const draft = { ...entry.published, title: '正在编辑' }
    const saved = await rpc('saveCompositionDraft', { compositionId: entry.id, revision: initial.revision, draft })
    assert.equal(saved.ok, true)
    const before = await readFile(compositionsFile, 'utf8')
    for (const endpoint of ['saveCompositionDraft', 'publishComposition', 'dryRunComposition', 'executeComposition']) {
      const stale = await rpc(endpoint, { compositionId: entry.id, version: 'draft', revision: initial.revision, draft, input: { asset: 'host-a' } })
      assert.equal(stale.ok, false)
      assert.match(stale.error.message, /已变化/)
    }
    for (const invalid of [{ ...draft, toolName: 'bad name' }, { ...draft, title: '' }, { ...draft, connectionId: '' }, { ...draft, description: 4 }]) {
      assert.equal((await rpc('saveCompositionDraft', { revision: saved.value.revision, draft: invalid })).ok, false)
    }
    assert.equal((await rpc('saveCompositionDraft', { revision: saved.value.revision, draft })).ok, false)
    assert.equal((await rpc('dryRunComposition', { compositionId: entry.id, version: 'missing', revision: saved.value.revision, input: { asset: 'host-a' } })).ok, false)
    assert.equal((await rpc('publishComposition', { compositionId: entry.id, version: 'published', revision: saved.value.revision, input: { asset: 'host-a' } })).ok, false)
    assert.equal(await readFile(compositionsFile, 'utf8'), before)
    const publishing = rpc('publishComposition', { compositionId: entry.id, version: 'draft', revision: saved.value.revision, input: { asset: 'host-a' } })
    const concurrent = await rpc('saveCompositionDraft', { compositionId: entry.id, revision: saved.value.revision, draft: { ...draft, title: '并发新草稿' } })
    assert.equal(concurrent.ok, true)
    assert.equal((await publishing).ok, false)
    const after = (await rpc('list', {})).value.compositions[0]
    assert.equal(after.draft.title, '并发新草稿')
    assert.deepEqual(after.published, entry.published)
  })
})

test('空目录可新建草稿，损坏目录拒绝保存，未登记依赖发布失败保留草稿', async () => {
  const module = await loadMcpModule()
  const root = await mkdtemp(join(tmpdir(), 'composition-empty-'))
  const compositionsFile = join(root, 'platform/mcp-compositions.json')
  const rpc = module.createMcpHandler(root, { stateFile: join(root, 'connections.json') })
  const initial = (await rpc('list', {})).value
  assert.deepEqual(initial.compositions, [])
  const draft = { toolName: 'first_query', title: '第一个编排', description: '', connectionId: 'missing-api' }
  const saved = await rpc('saveCompositionDraft', { revision: initial.revision, draft })
  assert.equal(saved.ok, true)
  const entry = saved.value.compositions[0]
  const before = await readFile(compositionsFile, 'utf8')
  assert.equal((await rpc('publishComposition', { compositionId: entry.id, version: 'draft', revision: saved.value.revision, input: { asset: 'host-a' } })).ok, false)
  assert.equal(await readFile(compositionsFile, 'utf8'), before)
  await writeFile(compositionsFile, '{broken')
  assert.equal((await rpc('saveCompositionDraft', { revision: saved.value.revision, draft })).ok, false)
  assert.equal(await readFile(compositionsFile, 'utf8'), '{broken')
})

test('未装载业务扩展时目录可读、业务工具不暴露且种子不写入；装载后恢复同一发布版本', async () => {
  const module = await loadMcpModule()
  const root = await mkdtemp(join(tmpdir(), 'composition-extension-boundary-'))
  const compositionsFile = join(root, 'compositions.json')
  const config = { toolName: 'collect_sample', title: '基本取证样例', description: '', connectionId: 'platform-compositions', kind: 'threat-stage', stage: 'collect', bindings: { socConnectionId: 'soc', reportConnectionId: 'report' } }
  await writeFile(compositionsFile, JSON.stringify({ schema_version: '1.0', compositions: [{ id: 'collect-sample', published: config }] }))
  const extension = {}
  const rpc = module.createMcpHandler(root, { compositionsFile, extension, servers: () => [] })
  const original = await readFile(compositionsFile, 'utf8')
  const listed = await rpc('list', {})
  assert.equal(listed.ok, true)
  assert.equal(listed.value.compositions.length, 1)
  assert.equal(listed.value.extension, null)
  assert.equal(listed.value.publishedService.id, 'platform-compositions')
  assert.deepEqual(listed.value.publishedService.tools.names, [])
  assert.equal((await rpc('seedThreatCompositions', { revision: listed.value.revision, bindings: config.bindings })).ok, false)
  assert.equal(await readFile(compositionsFile, 'utf8'), original)
  const gateway = module.createMcpGatewayFetchHandler(root, rpc)
  const discover = async () => (await (await gateway(new Request('http://fixture.local', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }))).json()).result.tools
  assert.deepEqual(await discover(), [])
  extension.id = 'fixture-extension'
  extension.threat = { execute() { throw new Error('仅验证发现，不得执行') }, inspect() {}, artifact() {} }
  assert.deepEqual((await discover()).map(tool => tool.name), ['collect_sample'])
  delete extension.id
  delete extension.threat
  assert.deepEqual(await discover(), [])
  assert.equal(await readFile(compositionsFile, 'utf8'), original)
})

test('MCP元数据固定旧版本与实现，发布指针变化不换工具，连接或摘要变化在上游调用前拒绝', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc, handler } = await setup(module, baseUrl)
    const listed = (await rpc('list', {})).value, entry = listed.compositions[0], binding = entry.binding
    assert.match(binding.expectedImplementationDigest, /^[0-9a-f]{64}$/)
    const gateway = module.createPublishedCompositionClient(process.cwd(), handler)
    const discovered = await gateway.listTools()
    assert.deepEqual(discovered.tools[0]._meta.harness, binding)
    const saved = await rpc('saveCompositionDraft', { compositionId: entry.id, revision: listed.revision,
      draft: { ...entry.published, toolName: 'query_new_version', title: '新的发布指针' } })
    assert.equal((await rpc('publishComposition', { compositionId: entry.id, version: 'draft', revision: saved.value.revision, input: { asset: 'host-a' } })).ok, true)
    const execution = { execution_id: 'fixed-execution', session_id: 'target-session', tool_call_id: 'call-1' }
    const fixed = await gateway.callTool({ name: entry.published.toolName, arguments: { asset: 'host-a' }, _meta: { harness: { ...binding, execution } } })
    const result = JSON.parse(fixed.content[0].text)
    assert.equal(fixed.isError, false)
    assert.equal(result.version.versionId, binding.versionId)
    assert.equal(result.graph_execution.execution_id, execution.execution_id)
    assert.equal(result.graph_execution.session_id, execution.session_id)
    assert.equal(result.graph_execution.complete, true)
    const before = calls.length
    const conflict = await rpc('callPublishedComposition', { ...binding, toolName: entry.published.toolName, expectedImplementationDigest: '0'.repeat(64), input: { asset: 'host-a' } })
    assert.equal(conflict.error.code, 'conflict'); assert.equal(calls.length, before)
    await rpc('registerOpenApi', { id: 'security-readonly-api', specUrl: `${baseUrl}/changed-spec.json` })
    const moved = await rpc('callPublishedComposition', { ...binding, toolName: entry.published.toolName, input: { asset: 'host-a' } })
    assert.equal(moved.error.code, 'conflict'); assert.equal(calls.length, before)
  })
})

test('实现摘要排除Git HEAD、dirty和发布时间，父组合递归锁子版本与扩展实现', async () => {
  const module = await loadMcpModule(), root = await mkdtemp(join(tmpdir(), 'composition-binding-stable-'))
  const child = { id: 'child' }, parent = { id: 'parent' }
  const config = { toolName: 'child_old', title: '子组合', description: '', connectionId: 'platform-compositions', kind: 'threat-stage', stage: 'collect', bindings: { socConnectionId: 'soc', reportConnectionId: 'report' } }
  publishCompositionVersion(child, config)
  publishCompositionVersion(parent, { toolName: 'parent_tool', title: '父组合', description: '', connectionId: 'platform-compositions', kind: 'composite',
    steps: [{ id: 'collect', compositionId: child.id, versionId: child.publishedVersionId, inputMap: { incident_id: '$input.incident_id' } }] })
  const catalog = { schema_version: '1.0', compositions: [child, parent] }, compositionsFile = join(root, 'compositions.json')
  await writeFile(compositionsFile, JSON.stringify(catalog))
  const extension = { id: 'fixed-extension', sourceDigest: '1'.repeat(64), threat: { execute() { throw new Error('不得执行') } } }
  const rpc = module.createMcpHandler(root, { compositionsFile, extension })
  const binding = async () => (await rpc('list', {})).value.compositions.find(item => item.id === 'parent').binding
  const first = await binding()
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'add', 'compositions.json'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: root })
  await writeFile(join(root, 'unrelated.txt'), '无关工作区变化')
  publishCompositionVersion(child, { ...config, toolName: 'child_new' })
  parent.published.publishedAt = new Date(Date.now() + 1000).toISOString()
  await writeFile(compositionsFile, JSON.stringify(catalog))
  assert.deepEqual(await binding(), first)
  extension.sourceDigest = '2'.repeat(64)
  assert.notEqual((await binding()).expectedImplementationDigest, first.expectedImplementationDigest)
})

test('阶段模型观察上下文由执行器传递，父子图回执合并同一执行身份', async () => {
  const module = await loadMcpModule(), root = await mkdtemp(join(tmpdir(), 'composition-observer-'))
  const config = { toolName: 'infer_tool', title: '推理', description: '', connectionId: 'platform-compositions', kind: 'threat-stage', stage: 'infer', bindings: { socConnectionId: 'soc', reportConnectionId: 'report' } }
  const entry = { id: 'infer' }; publishCompositionVersion(entry, config)
  const compositionsFile = join(root, 'compositions.json')
  await writeFile(compositionsFile, JSON.stringify({ schema_version: '1.0', compositions: [entry] }))
  let failAfterModel = false
  const extension = { id: 'observer', sourceDigest: 'a'.repeat(64), threat: { async execute(stage, bindings, input, signal, execution) {
    assert.equal(execution.parent_run_id, 'run-parent')
    const { recordAttempt, ...identity } = execution
    await recordAttempt({ ...identity, attempt_id: 'attempt-one', status: 'started', time: 1 })
    await recordAttempt({ ...identity, attempt_id: 'attempt-one', status: 'completed', time: 2, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } })
    if (failAfterModel) throw new Error('阶段在模型完成后失败')
    return { run_id: input.run_id, phase_status: 'completed', status: 'completed', llm_invoked: true }
  } } }
  const rpc = module.createMcpHandler(root, { compositionsFile, extension })
  const binding = (await rpc('list', {})).value.compositions[0].binding
  const result = await rpc('callPublishedComposition', { ...binding, toolName: config.toolName, input: { run_id: 'run-11111111-1111-4111-8111-111111111111' },
    execution: { execution_id: 'test-graph', parent_run_id: 'run-parent', session_id: 'target', tool_call_id: 'call' } })
  assert.equal(result.ok, true)
  assert.equal(result.value.graph_execution.complete, true)
  assert.equal(result.value.graph_execution.model_attempts.length, 2)
  assert.equal(result.value.graph_execution.model_attempts[1].execution_id, 'test-graph')
  failAfterModel = true
  const failed = await rpc('callPublishedComposition', { ...binding, toolName: config.toolName, input: { run_id: 'run-11111111-1111-4111-8111-111111111111' },
    execution: { execution_id: 'test-failed-graph', parent_run_id: 'run-parent', session_id: 'target', tool_call_id: 'failed-call' } })
  assert.equal(failed.ok, true)
  assert.equal(failed.value.ok, false)
  assert.equal(failed.value.graph_execution.model_attempts.length, 2)
  assert.equal(failed.value.graph_execution.complete, true)
})

test('Candidate固定工具复用原生组认证和官方MCP传输，发布后仍执行旧版并在实现冲突前阻止业务请求', async () => {
  const module = await loadMcpModule()
  await withFixture(async ({ baseUrl, calls }) => {
    const { rpc, handler } = await setup(module, baseUrl), entry = (await rpc('list', {})).value.compositions[0]
    const platform = module.createPublishedCompositionClient(process.cwd(), handler)
    const tool = (await platform.listTools()).tools[0], groupDigest = 'f'.repeat(64), token = 'private-group-fixture-token'
    const originalName = `mcp__compositions__${tool.name}`
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end()
      if (req.method !== 'POST') return res.writeHead(405).end()
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const request = JSON.parse(Buffer.concat(chunks).toString())
      if (request.method === 'tools/call') {
        assert.equal(request.params._meta['io.deepseek.dsh/mcp-group-target'].digest, groupDigest)
        request.params.name = request.params.name.replace('mcp__compositions__', '')
      }
      const gateway = module.createMcpGatewayFetchHandler(process.cwd(), handler)
      const response = await gateway(new Request('http://fixture.local', { method: 'POST', body: JSON.stringify(request) }))
      let body = await response.text()
      if (request.method === 'tools/list') {
        const parsed = JSON.parse(body)
        parsed.result.tools = parsed.result.tools.map(item => ({ ...item, name: `mcp__compositions__${item.name}` }))
        parsed.result._meta = { 'io.deepseek.dsh/mcp-group-target': { digest: groupDigest } }
        body = JSON.stringify(parsed)
      }
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(body)
    })
    const port = await listen(server), previousAnchor = process.env.DSH_MCP_CLIENT_ANCHOR
    process.env.DSH_MCP_CLIENT_ANCHOR = join(process.cwd(), 'package.json')
    const definitions = new Map(), nativeTool = { name: originalName }
    const ctx = { webServer: { port, publicPath: path => `/hep${path}` },
      mcpSessionManager: { currentGroup: () => ({ token, targetDigest: groupDigest }) },
      tools: { register: definition => definitions.set(definition.name, definition), get: name => name === originalName ? nativeTool : definitions.get(name) } }
    try {
      const fixed = { group_id: 'fixed', group_target_digest: groupDigest, tool_name: originalName, ...entry.binding, input_schema: tool.inputSchema }
      const aliases = registerFixedCompositionTools(ctx, { [originalName]: fixed })
      const selected = definitions.get(aliases.get(originalName))
      const listed = (await rpc('list', {})).value
      const saved = await rpc('saveCompositionDraft', { compositionId: entry.id, revision: listed.revision, draft: { ...entry.published, title: '当前发布的新版本' } })
      await rpc('publishComposition', { compositionId: entry.id, version: 'draft', revision: saved.value.revision, input: { asset: 'host-a' } })
      const exec = { callId: 'inner-call', agent: { session: { id: 'target-session' } }, signal: new AbortController().signal }
      const value = await withFixedCompositionExecution({ execution_id: 'outer-workflow', parent_run_id: 'run-parent', case_id: 'U-ONE-001' },
        () => selected.execute({ asset: 'host-a' }, exec))
      assert.equal(value.isError, false)
      const actual = JSON.parse(value.content[0].text)
      assert.equal(actual.version.versionId, entry.binding.versionId)
      assert.equal(actual.graph_execution.session_id, exec.agent.session.id)
      assert.equal(actual.graph_execution.tool_call_id, exec.callId)
      assert.equal(actual.graph_execution.parent_run_id, 'run-parent')
      const before = calls.length
      const badAlias = registerFixedCompositionTools(ctx, { [originalName]: { ...fixed, expectedImplementationDigest: '0'.repeat(64) } }).get(originalName)
      assert.equal((await definitions.get(badAlias).execute({ asset: 'host-a' }, exec)).isError, true)
      assert.equal(calls.length, before)
      const lost = registerFixedCompositionTools(ctx, { [originalName]: fixed }, { clientFactory: async () => ({
        async listTools() { return { tools: [{ name: originalName }], _meta: { 'io.deepseek.dsh/mcp-group-target': { digest: groupDigest } } } },
        async callTool() { throw new Error('private-transport-detail') }, async close() {},
      }) }).get(originalName)
      const unknown = await definitions.get(lost).execute({ asset: 'host-a' }, exec)
      assert.equal(unknown.isError, true)
      assert.equal(JSON.parse(unknown.content[0].text).graph_execution.complete, false)
      assert.doesNotMatch(JSON.stringify(unknown), /private-/)
    } finally {
      if (previousAnchor === undefined) delete process.env.DSH_MCP_CLIENT_ANCHOR; else process.env.DSH_MCP_CLIENT_ANCHOR = previousAnchor
      await new Promise(resolve => server.close(resolve))
    }
  })
})
