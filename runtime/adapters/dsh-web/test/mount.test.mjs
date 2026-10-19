import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { createMountedWebServer, legacyLanConfig } from '../lib/index.mjs'

const require = createRequire(new URL('../../../../platform/plugin/package.json', import.meta.url))
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
const { default: NativeWebServer } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-host-webserver')).href)
const nativeRequire = createRequire(require.resolve('@deepseek-ai/dsh-host-webserver'))
const { default: z } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/schemastery')).href)

test('既有 LAN 仅兼容明确的 IPv4 wildcard，其他原生配置校验保持有效', () => {
  const schema = legacyLanConfig(NativeWebServer, z)
  assert.equal(schema({ host: '0.0.0.0', port: 3080 }).host, '0.0.0.0')
  assert.equal(schema({ host: '127.0.0.1', port: 3080 }).host, '127.0.0.1')
  for (const host of ['::', '::ffff:0.0.0.0', 'localhost', '*']) {
    assert.throws(() => schema({ host, port: 3080 }))
  }
  for (const port of [-1, 65536]) assert.throws(() => schema({ host: '0.0.0.0', port }))
  assert.throws(() => schema({ host: '0.0.0.0', port: 3080, compression: 'invalid' }))
})

for (const basePath of ['/assistant/', '/hep/']) test(`${basePath} 原生 HTTP、插件资源、SSE 和 upgrade 共同挂载且旧入口拒绝`, async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const productTitle = basePath === '/hep/' ? 'Harness工程平台' : undefined
  await root.plugin(createMountedWebServer(NativeWebServer, basePath, productTitle), { host: '127.0.0.1', port: 0, compression: 'gzip', compressionThresholdBytes: 0 })
  root.provide('clientModules', { async fetchBundle(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
    if (!request.url.includes('rev=current')) return new Response(null, { status: 404 })
    return new Response(request.method === 'HEAD' ? null : `const productTitle = "DeepSeek Harness";\nfetch('/api/echo');\n//# sourceMappingURL=old.map`, {
      headers: { 'content-type': 'application/javascript', 'cache-control': 'public,max-age=31536000,immutable' },
    })
  } })
  const server = root.webServer
  server.register({ kind: 'prefix', path: '/plugins', handler() { throw new Error('未使用公开 fetchBundle') } })
  server.register({ kind: 'exact', path: '/plugins/events', handler(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    setTimeout(() => res.end('data: second\n\n'), 20)
  } })
  server.register({ kind: 'prefix', path: '/api', handler(req, res) { res.end(req.url) } })
  server.register({ kind: 'prefix', path: '/mcp/groups', handler(req, res) { res.end(req.url) } })
  server.registerUpgrade({ path: '/api/socket', handler(req, socket) {
    assert.equal(req.url, '/api/socket?query=1')
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  } })
  server.registerFallback((req, res) => res.end(req.url))
  const origin = `http://127.0.0.1:${server.port}`
  const base = origin + basePath
  for (const path of ['/', basePath.slice(0, -1)]) {
    const response = await fetch(origin + path + '?token=fixture&next=a%2Fb', { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), basePath + '?token=fixture&next=a%2Fb')
  }
  assert.equal(await (await fetch(base + '?entry=1')).text(), '/?entry=1')
  assert.equal(await (await fetch(base + 'api/echo?raw=a%2Fb')).text(), '/api/echo?raw=a%2Fb')
  assert.equal(await (await fetch(base + 'mcp/groups/test')).text(), '/mcp/groups/test')
  for (const path of ['/api/echo', '/mcp/groups/test', '/plugins/test', '/assistant-other/']) {
    assert.equal((await fetch(origin + path, { method: 'POST' })).status, 404)
  }
  const plugin = await fetch(base + 'plugins/example/client.js?rev=current')
  assert.equal(plugin.status, 200)
  assert.equal(plugin.headers.get('cache-control'), 'no-store')
  const code = await plugin.text()
  assert.match(code, /__harnessSiteUrl/)
  assert.ok(!code.includes('sourceMappingURL'))
  assert.ok(code.includes(`const productTitle = ${JSON.stringify(productTitle ?? 'DeepSeek Harness')};`))
  if (productTitle) assert.ok(!code.includes('DeepSeek Harness'))
  assert.equal((await fetch(base + 'plugins/example/client.js?rev=wrong')).status, 404)
  assert.equal((await fetch(base + 'plugins/example/client.js?rev=current', { method: 'POST' })).status, 405)
  assert.equal((await (await fetch(base + 'plugins/example/client.js?rev=current', { method: 'HEAD' })).text()), '')
  const stream = await fetch(base + 'plugins/events')
  assert.equal(stream.headers.get('content-encoding'), null)
  assert.equal(await stream.text(), 'data: first\n\ndata: second\n\n')
  await new Promise((resolve, reject) => {
    const request = httpRequest(base + 'api/socket?query=1', { headers: { connection: 'Upgrade', upgrade: 'websocket' } })
    request.on('upgrade', (response, socket) => { socket.destroy(); assert.equal(response.statusCode, 101); resolve() })
    request.on('response', response => { response.resume(); reject(new Error(`upgrade HTTP ${response.statusCode}`)) })
    request.on('error', reject)
    request.end()
  })
})
