import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { HttpFetchProvider } from '../../plugin/src/standalone-knowledge/native-fetch.ts'
import { collectKnowledge } from '../knowledge/index.mts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-native-fetch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push(request.url)
    if (request.url === '/docs/slow.html') await new Promise(resolve => setTimeout(resolve, 500))
    if (response.destroyed) return
    if (request.url === '/docs/redirect.html') { response.writeHead(302, { location: '/docs/page.html' }); response.end(); return }
    response.writeHead(request.url === '/docs/missing.html' ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><h1>原生默认采集</h1><p>保留页面原文。</p><script>globalThis.__nativeCollectExecuted=true</script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`, input = join(root, 'workspace')
  await mkdir(input)
  return { root, input, origin, requests, options: { roots: [{ root: input, label: 'business' }], outDir: join(root, 'offline'), mode: 'offline' } }
}

function localResolverBoundary(t) {
  const original = HttpFetchProvider.prototype.fetch, resolved = []
  // 仅替换每个真实原生实例的地址 resolver；HTTP、重定向、正文读取和错误路径仍执行原实现。
  t.mock.method(HttpFetchProvider.prototype, 'fetch', function (request, signal) {
    this.resolveAddresses = async (hostname, callSignal) => { callSignal.throwIfAborted(); resolved.push(hostname); assert.equal(hostname, '127.0.0.1'); return [{ address: '127.0.0.1', family: 4 }] }
    return original.call(this, request, signal)
  })
  return resolved
}

test('CLI 默认采集路径静态装载真实原生 HTTP 提供方，无 DSH 入口也可归档并跟随相对重定向', async t => {
  const f = await fixture(t), resolved = localResolverBoundary(t), previous = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_DSH_ENTRY = '/missing/source-wrapper/dsh'
  t.after(() => { if (previous === undefined) delete process.env.HARNESS_DSH_ENTRY; else process.env.HARNESS_DSH_ENTRY = previous })
  const skill = `[参考](${f.origin}/docs/redirect.html)\n`
  await writeFile(join(f.input, 'SKILL.md'), skill)
  const result = await collectKnowledge(f.options)
  assert.deepEqual(result.missing, []); assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].finalUrl, f.origin + '/docs/page.html')
  assert.equal(result.sources[0].representation, 'decoded-utf8')
  assert.match(await readFile(join(f.options.outDir, result.sources[0].path), 'utf8'), /原生默认采集[\s\S]*<script>/)
  assert.equal(await readFile(join(f.input, 'SKILL.md'), 'utf8'), skill)
  assert.deepEqual(f.requests, ['/docs/redirect.html', '/docs/page.html'])
  assert.equal(resolved.length, 2); assert.equal(globalThis.__nativeCollectExecuted, undefined)
})

test('默认采集保留原生公开网络限制，在线模式不调用原生 HTTP', async t => {
  const f = await fixture(t)
  await writeFile(join(f.input, 'SKILL.md'), `[参考](${f.origin}/docs/page.html)\n`)
  const online = await collectKnowledge({ ...f.options, mode: 'online' })
  assert.deepEqual(online.missing, []); assert.deepEqual(f.requests, [])
  const offline = await collectKnowledge(f.options)
  assert.equal(offline.sources.length, 0)
  assert.equal(offline.missing.length, 1); assert.match(offline.missing[0].message, /原生网页读取不支持此目标地址/)
  assert.deepEqual(f.requests, [])
})

test('默认原生 HTTP 的错误状态与取消不会生成成功资料', async t => {
  const f = await fixture(t); localResolverBoundary(t)
  await writeFile(join(f.input, 'SKILL.md'), `[参考](${f.origin}/docs/missing.html)\n`)
  const missing = await collectKnowledge(f.options)
  assert.equal(missing.sources.length, 0); assert.equal(missing.missing.length, 1); assert.match(missing.missing[0].message, /HTTP 404/)
  await writeFile(join(f.input, 'SKILL.md'), `[参考](${f.origin}/docs/slow.html)\n`)
  const controller = new AbortController(), pending = collectKnowledge({ ...f.options, outDir: join(f.root, 'cancelled'), signal: controller.signal })
  setTimeout(() => controller.abort(new Error('用户取消默认原生采集')), 30)
  await assert.rejects(pending, /用户取消默认原生采集/)
})
