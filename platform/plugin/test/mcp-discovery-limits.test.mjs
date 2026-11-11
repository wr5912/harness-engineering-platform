import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
const folder = mkdtempSync(join(tmpdir(), 'mcp-discovery-test-')), outfile = join(folder, 'discovery.mjs')
await build({ stdin: { contents: `export * from '../../plugins/mcp-manager/discovery.ts'; export * from '../../plugins/mcp-manager/limits.ts'; export * from '../../plugins/mcp-manager/openapi.ts'`,
  resolveDir: new URL('../', import.meta.url).pathname, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm' })
const { discover, DiscoveryBudget, limitedText, loadOpenApi } = await import(outfile)
test.after(() => rmSync(folder, { recursive: true, force: true }))

const tick = () => new Promise(resolve => setImmediate(resolve))
test('流式响应超限即取消；目录预算覆盖字节和深度', async () => {
  let cancelled = false
  const response = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)) }, cancel() { cancelled = true } }))
  await assert.rejects(limitedText(response, 1500), /1500/)
  assert.equal(cancelled, true)
  assert.throws(() => new DiscoveryBudget('test').value('x'.repeat(8 * 1024 * 1024), '/tool'), /累计目录字节/)
  let value = {}; for (let i = 0; i < 66; i++) value = { child: value }
  assert.throws(() => new DiscoveryBudget('test').value(value, '/tool'), /嵌套深度/)
})

test('共享发现独立取消，最后调用者取消上游，全局最多四个执行', async () => {
  const a = new AbortController(), b = new AbortController()
  let starts = 0, upstream
  const run = server => new Promise((resolve, reject) => {
    starts++; upstream = server.platformSignal
    upstream.addEventListener('abort', () => reject(upstream.reason), { once: true })
  })
  const first = discover({ id: 'shared', platformWorkspaceId: 'w', platformSignal: a.signal }, 'test', run)
  const second = discover({ id: 'shared', platformWorkspaceId: 'w', platformSignal: b.signal }, 'test', run)
  const stoppedA = assert.rejects(first), stoppedB = assert.rejects(second)
  await tick(); assert.equal(starts, 1)
  a.abort(); await stoppedA; assert.equal(upstream.aborted, false)
  b.abort(); await stoppedB; assert.equal(upstream.aborted, true)
  await tick()
  const controllers = Array.from({ length: 8 }, () => new AbortController())
  let active = 0, peak = 0
  const calls = controllers.map((controller, i) => discover({ id: `queue-${i}`, platformSignal: controller.signal }, 'test', server => new Promise((resolve, reject) => {
    active++; peak = Math.max(peak, active)
    server.platformSignal.addEventListener('abort', () => { active--; reject(server.platformSignal.reason) }, { once: true })
  })))
  const settled = Promise.allSettled(calls)
  await tick(); assert.equal(active, 4)
  controllers.forEach(controller => controller.abort())
  await settled; await tick(); assert.equal(active, 0); assert.equal(peak, 4)
})

test('小型共享引用文档拒绝指数展开，正常文档仍能发现', async t => {
  const schemas = { Leaf: { type: 'string' } }
  for (let i = 22; i >= 0; i--) {
    const ref = { $ref: `#/components/schemas/${i === 22 ? 'Leaf' : `N${i + 1}`}` }
    schemas[`N${i}`] = { type: 'object', properties: { a: ref, b: ref } }
  }
  let schema = { $ref: '#/components/schemas/N0' }
  const server = createServer((req, res) => res.end(JSON.stringify({ openapi: '3.0.0', paths: { '/example': { post: {
    operationId: 'example', requestBody: { content: { 'application/json': { schema } } }, responses: {},
  } } }, components: { schemas } })))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const config = { id: 'bounded', specUrl: `http://127.0.0.1:${server.address().port}/spec` }
  await assert.rejects(loadOpenApi(config), /累计展开节点|嵌套深度|累计目录字节/)
  schema = { type: 'object', properties: { name: { type: 'string' } } }
  assert.equal((await loadOpenApi(config)).tools.length, 1)
})
