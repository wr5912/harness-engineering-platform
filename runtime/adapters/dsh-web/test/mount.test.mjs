import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sitePath } from '../src/sites.ts'
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

for (const basePath of ['/assistant/', '/hep/', '/agents/security-operations-expert/', '/agents/security-operations-expert/instances/business-test/']) test(`${basePath} 原生 HTTP、插件资源、SSE 和 upgrade 共同挂载且旧入口拒绝`, async t => {
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
  assert.equal(server.publicPath('/api/echo'), basePath + 'api/echo')
  assert.equal(server.publicPath(basePath + 'api/echo'), basePath + 'api/echo')
  if (basePath.startsWith('/agents/')) {
    assert.equal((await fetch(origin + '/assistant/api/echo')).status, 404)
    assert.equal((await fetch(origin + '/agents/other-agent/api/echo')).status, 404)
    if (basePath.includes('/instances/')) {
      assert.equal((await fetch(origin + '/agents/security-operations-expert/api/echo')).status, 404)
      assert.equal((await fetch(origin + '/agents/security-operations-expert/instances/other/api/echo')).status, 404)
    }
  }
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


test('业务 Agent 与实例身份派生入口，历史 Agent 入口及平台站点配置保留', t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-business-site-'))
  const siteConfig = join(root, 'sites.json'), oldAgent = process.env.HARNESS_BUSINESS_AGENT_ID,
    oldInstance = process.env.HARNESS_BUSINESS_INSTANCE_ID, oldSites = process.env.HARNESS_SITES_CONFIG
  t.after(() => {
    if (oldAgent === undefined) delete process.env.HARNESS_BUSINESS_AGENT_ID; else process.env.HARNESS_BUSINESS_AGENT_ID = oldAgent
    if (oldInstance === undefined) delete process.env.HARNESS_BUSINESS_INSTANCE_ID; else process.env.HARNESS_BUSINESS_INSTANCE_ID = oldInstance
    if (oldSites === undefined) delete process.env.HARNESS_SITES_CONFIG; else process.env.HARNESS_SITES_CONFIG = oldSites
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(siteConfig, JSON.stringify({ assistant: '/existing-assistant/', platform: '/existing-platform/' }))
  process.env.HARNESS_SITES_CONFIG = siteConfig
  process.env.HARNESS_BUSINESS_AGENT_ID = 'security-operations-expert'
  delete process.env.HARNESS_BUSINESS_INSTANCE_ID
  assert.equal(sitePath('assistant'), '/agents/security-operations-expert/')
  process.env.HARNESS_BUSINESS_INSTANCE_ID = 'business-test'
  assert.equal(sitePath('assistant'), '/agents/security-operations-expert/instances/business-test/')
  assert.equal(sitePath('platform'), '/existing-platform/')
  for (const invalid of ['', '../other', 'instance/other', 'instance--other', 'Instance', '1instance']) {
    process.env.HARNESS_BUSINESS_INSTANCE_ID = invalid
    assert.throws(() => sitePath('assistant'), /无效业务实例 ID/)
  }
  process.env.HARNESS_BUSINESS_INSTANCE_ID = 'business-test'
  for (const invalid of ['../other', 'agent/other', 'agent--other', 'Agent']) {
    process.env.HARNESS_BUSINESS_AGENT_ID = invalid
    assert.throws(() => sitePath('assistant'), /无效业务 Agent ID/)
  }
  delete process.env.HARNESS_BUSINESS_AGENT_ID
  assert.throws(() => sitePath('assistant'), /无效业务 Agent ID/)
  delete process.env.HARNESS_BUSINESS_INSTANCE_ID
  assert.equal(sitePath('assistant'), '/existing-assistant/')
})

test('多段业务挂载仍拒绝空路径段及缺失末尾斜线', () => {
  for (const invalid of ['/agents//soc/', '//agents/soc/', '/agents/soc']) assert.throws(() => createMountedWebServer(NativeWebServer, invalid), /无效 Web 基址/)
})

test('首次大插件转换期间控制请求继续响应，并发同资源共用转换结果', async t => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  await root.plugin(createMountedWebServer(NativeWebServer, '/agents/soc/'), { host: '127.0.0.1', port: 0 })
  let requested
  const started = new Promise(resolve => { requested = resolve })
  const source = Array.from({ length: 40000 }, (_, index) => `function item${index}(x){const result=x+${index};return result*result}`).join('\n') + "\nfetch('/api/heartbeat')"
  root.provide('clientModules', { async fetchBundle() {
    requested()
    return new Response(source, { headers: { 'content-type': 'application/javascript' } })
  } })
  const server = root.webServer
  server.register({ kind: 'prefix', path: '/plugins', handler() { throw new Error('未使用公开 fetchBundle') } })
  let heartbeats = 0
  server.register({ kind: 'exact', path: '/api/heartbeat', handler(_req, res) { heartbeats++; res.end('alive') } })
  const origin = `http://127.0.0.1:${server.port}/agents/soc/`
  let transformed = false
  const resources = Promise.all([1, 2].map(() => fetch(origin + 'plugins/large.js').then(response => response.text())))
    .then(results => { transformed = true; return results })
  await started
  const before = performance.now()
  assert.equal(await (await fetch(origin + 'api/heartbeat')).text(), 'alive')
  assert.equal(transformed, false, '大插件尚在转换时控制响应必须已送达')
  assert.ok(performance.now() - before < 2000, '控制请求不能等待AST完成而耗尽两秒租约')
  const [first, second] = await resources
  assert.equal(first, second)
  assert.match(first, /__harnessSiteUrl/)
  assert.equal(heartbeats, 1)
})
