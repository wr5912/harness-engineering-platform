import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import * as standalone from '../lib/standalone-connection.js'
import { runtimeModule } from '../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'

const { Context } = await runtimeModule('@deepseek-ai/cordis')

test('独立原生连接无需 Token 或 Cookie，保留共享 Peer、二进制传输及请求大小边界', async t => {
  const routes = [], ctx = new Context()
  const server = createServer((req, res) => {
    const route = routes.find(route => req.url.startsWith(route.path))
    if (!route) return res.writeHead(404).end()
    Promise.resolve(route.handler(req, res)).catch(() => res.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await ctx.fiber.dispose() })
  await ctx.plugin({ name: 'standalone-carrier-fixture', apply(inner) {
    inner.provide('webServer', { host: '127.0.0.1', protocol: 'http:', register(route) { routes.push(route); return () => routes.splice(routes.indexOf(route), 1) } })
  } })
  await ctx.plugin(standalone, { trustedHosts: [], maxRequestBodyBytes: 8 })
  const connection = ctx.get('connection'), address = `http://127.0.0.1:${server.address().port}`
  const request = { headers: { host: new URL(address).host } }
  assert.equal(connection.authorizeIndex(request, {}), true)
  assert.equal(connection.authenticatedUrl(address), address)
  assert.equal(connection.admit(request).peer.principal.kind, 'owner')
  assert.equal(connection.admit(request).peer, connection.admit(request).peer)
  assert.equal(connection.admit({ headers: { host: 'unexpected.invalid' } }).rejection, 403)
  await connection.fetch.register({ path: '/api/echo', methods: ['POST'], requestBody: 'buffered', fetch: async request => new Response(await request.arrayBuffer()) })
  await connection.fetch.register({ path: '/api/upload', methods: ['POST'], requestBody: 'streaming', fetch: async request => new Response(await request.arrayBuffer()) })
  const response = await fetch(address + '/api/echo', { method: 'POST', body: Buffer.from([0, 1, 255]) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 1, 255]))
  assert.equal((await fetch(address + '/api/echo', { method: 'POST', body: 'too-large' })).status, 413)
  assert.equal((await fetch(address + '/api/upload', { method: 'POST', body: 'streaming-upload' })).status, 200)
})
