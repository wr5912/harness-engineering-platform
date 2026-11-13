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
  const { managerSources } = await import('../../../plugin/build.mjs')
  const outfile = join(directory, 'manager.mjs')
  await build({ stdin: { contents: `export * from 'harness-mcp-manager-server'; export { createNativeThreatServices } from ${JSON.stringify(new URL('../src/threat-services.ts', import.meta.url).pathname)}`, resolveDir: process.cwd(), loader: 'ts' },
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

test('真实原生 OpenAPI 发现保留 body.arguments schema，阶段适配准确封装 SOC 请求体', async t => {
  const manager = await managerModule(t)
  const bodies = []
  const args = { incidentId: 'INC-20261015-000001' }
  const { origin } = await serve(t, async (request, response) => {
    if (request.method === 'GET' && request.url === '/openapi.json') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ openapi: '3.0.3', info: { title: '基本 SOC 模拟接口', version: '1' },
        paths: { '/invoke': { post: { operationId: 'ai_soc_mock__lookup', summary: '读取基本模拟事件', requestBody: { required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['arguments'], properties: {
            arguments: { type: 'object', required: ['incidentId'], properties: { incidentId: { type: 'string' } }, additionalProperties: false },
          } } } } }, responses: { 200: { description: '基本模拟结果' } } } } } }))
      return
    }
    if (request.method === 'POST' && request.url === '/invoke') {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', status_code: 200, result: { code: 200, data: args } }))
      return
    }
    response.writeHead(404).end()
  })
  const external = { id: 'soc-basic', serverName: 'soc-basic', enabled: true, specUrl: origin + '/openapi.json', headers: [], tools: { mode: 'all', names: [] } }
  let dispatch
  manager.apply({ provide() {}, webServer: { register: () => () => {} }, connection: { requestRejection: () => undefined }, effect: create => create(), on: () => {} }, {
    servers: { get: () => [external] }, groups: { get: () => [] }, sharedToken: { get: () => '' }, platformDispatch: handler => { dispatch = handler },
  })
  const signal = new AbortController().signal
  const discovery = await dispatch({ action: 'test', serverId: external.id }, signal)
  assert.equal(discovery.status, 200)
  const found = discovery.value.tools.find(tool => tool.name === 'ai_soc_mock__lookup')
  assert.ok(found?.inputSchema?.properties?.body?.properties?.arguments, '发现响应必须保留 HTTP 请求体的输入 schema')
  assert.deepEqual(found.inputSchema.required, ['body'])
  const services = manager.createNativeThreatServices(join(process.cwd(), '../..'), dispatch, undefined,
    () => { throw new Error('本测试禁止调用模型') }, () => [external])
  const called = await services.invoke(external.id, 'ai_soc_mock__lookup', args, signal)
  assert.equal(called.isError, false)
  assert.equal(JSON.parse(called.content[0].text).result.code, 200)
  assert.deepEqual(bodies, [{ arguments: args }], '只能封装一层 arguments，不得丢失或重复封装')
})
