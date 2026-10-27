import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '../../../runtime/adapters/dsh-web/lib/platform-webserver.mjs'
import * as WebApp from '@deepseek-ai/dsh-web-app'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'

test('平台登录保护原生 API、三个写入域与 MCP，旧 Token/Cookie 被拒绝且退出可撤销会话', async t => {
  const root = new Context()
  const assetRoot = mkdtempSync(join(tmpdir(), 'harness-native-auth-'))
  const previous = process.env.HARNESS_ASSET_ROOT
  process.env.HARNESS_ASSET_ROOT = assetRoot
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(assetRoot, { recursive: true, force: true })
    if (previous === undefined) delete process.env.HARNESS_ASSET_ROOT
    else process.env.HARNESS_ASSET_ROOT = previous
  })
  mkdirSync(join(assetRoot, 'agents/auth-agent'), { recursive: true })
  mkdirSync(join(assetRoot, '.local/credentials'), { recursive: true })
  mkdirSync(join(assetRoot, 'config'), { recursive: true })
  writeFileSync(join(assetRoot, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-auth-test' }))
  copyFileSync(new URL('./fixtures/mcp-compositions.json', import.meta.url), join(assetRoot, 'config/mcp-compositions.json'))
  writeFileSync(join(assetRoot, '.local/credentials/admin.json'), JSON.stringify({ username: 'admin', password: 'admin123' }))
  const index = join(assetRoot, 'index.html')
  writeFileSync(index, '<html><head></head><body>index</body></html>')
  const originalDist = WebApp.internals.resolveDistIndex
  WebApp.internals.resolveDistIndex = () => index
  t.after(() => { WebApp.internals.resolveDistIndex = originalDist })
  // 仅替换凭据持久化、静态页面及未调用的外部 DSH 服务；认证、Cordis、HTTP/RPC/Fetch 均运行真实实现。
  class Credentials extends Service {
    records = new Map()
    constructor(ctx) { super(ctx, 'credentials') }
    async modifyRecord(key, update) {
      const next = await update(this.records.get(key))
      if (next) this.records.set(key, next)
      return this.records.get(key)
    }
  }
  await root.plugin({ name: 'test-credentials', apply(ctx) { new Credentials(ctx) } })
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await root.plugin(Connection)
  await root.plugin({ name: 'test-platform-mcp', apply(ctx) { ctx.provide('platformMcp', { servers: { get: () => [] }, groups: { get: () => [] } }) } })
  // 不执行 Session/模型；支撑新依赖，认证与原生投影注册仍运行真实实现。
  await root.plugin({ name: 'test-assistant-services', apply(ctx) {
    new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, {})
    const workspace = { id: 'auth-workspace', sessionIds: [] }
    ctx.provide('workspaceRegistry', { async create(path) { assert.equal(path, assetRoot); return workspace }, list: () => [workspace] })
    ctx.provide('workspaceController', {})
    ctx.provide('sessionController', { async create() { assert.fail('认证测试不创建会话') } })
    ctx.provide('settingsController', {})
    ctx.provide('agentDefaultModel', {})
    ctx.provide('llm', { listConfigurableProviders: () => [] })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('tools', { register() {} })
    ctx.provide('goals', { get: () => undefined })
    // 空数据工作区仍可验证认证与原生注册；本项不发起管理会话。
    ctx.provide('skills', { async get() { return undefined } })
  } })
  const origin = `http://127.0.0.1:${root.webServer.port}`
  const base = origin + '/hep'
  const runId = 'run-11111111-1111-4111-8111-111111111111'
  const run = join(assetRoot, 'evolution/experiments/EXP-auth-agent-001/runs', runId)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'run.yaml'), `run_id: ${runId}\nstatus: completed\n`)
  writeFileSync(join(run, 'report.md'), '# 认证报告\n\n前缀路径下载验证。\n')
  const downloadPath = `/api/harness-platform/runs/download?run_id=${runId}&kind=report`
  // 在新认证安装前取得旧原生会话，证明迁移不会继续接受它。
  const oldUrl = root.connection.authenticatedUrl(base + '/')
  const oldCookie = await new Promise(resolve => {
    root.webServer.register({ kind: 'exact', path: '/old-auth', handler(req, res) {
      req.url = '/' + new URL(oldUrl).search
      root.connection.authorizeIndex(req, res)
    } })
    fetch(base + '/old-auth', { redirect: 'manual' }).then(response => resolve(response.headers.get('set-cookie').split(';')[0]))
  })
  const loaded = root.plugin(plugin, { openBrowser: false, printUrl: false, surfaceContext: false })
  await loaded
  assert.equal(loaded.state, 2)
  const request = (path, body, cookie) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
  const envelope = method => ({ type: 'client-request', rpcId: 'test-request', method, payload: {} })
  for (const method of ['agents/create', 'instances/run', 'mcp/registerOpenApi', 'mcp/saveCompositionDraft', 'mcp/publishComposition']) {
    assert.equal((await request(`/harness-platform/${method}`, envelope(method))).status, 401)
  }
  assert.equal((await fetch(base + '/api/harness-platform/events')).status, 401)
  const gateway = '/api/harness-platform/mcp'
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-test', version: '1' },
  } }
  assert.equal((await request(gateway, initialize)).status, 401)
  assert.equal((await fetch(base + downloadPath)).status, 401)
  const anonymous = await fetch(oldUrl, { redirect: 'manual' })
  assert.equal(anonymous.status, 303)
  assert.equal(anonymous.headers.get('location'), '/hep/login')
  assert.equal(anonymous.headers.get('set-cookie'), null)
  assert.equal((await request('/harness-platform/inventory', envelope('inventory'), oldCookie)).status, 401)
  const oldConnect = await fetch(base + '/connect' + new URL(oldUrl).search, { redirect: 'manual' })
  assert.equal(oldConnect.status, 401)
  assert.equal(oldConnect.headers.get('set-cookie'), null)
  assert.deepEqual(root.connection.admitConnection({ headers: { host: new URL(base).host, cookie: oldCookie } }), { rejection: 401 })
  assert.equal(root.connection.authenticatedUrl(base + '/?token=discard'), base + '/')
  const login = body => fetch(base + '/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body })
  const loginPage = await fetch(base + '/login')
  assert.equal(loginPage.headers.get('referrer-policy'), 'same-origin')
  assert.match(await loginPage.text(), /action="\/hep\/login"/)
  for (const path of ['/', '/hep']) {
    const redirect = await fetch(origin + path + '?from=entry', { redirect: 'manual' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), '/hep/?from=entry')
  }
  for (const path of ['/login', '/api', gateway, '/harness-platform/inventory', downloadPath]) {
    assert.equal((await fetch(origin + path, { redirect: 'manual' })).status, 404)
  }
  const wrong = await login('username=admin&password=wrong')
  assert.equal(wrong.status, 401)
  assert.match(await wrong.text(), /用户名或密码错误/)
  assert.equal(wrong.headers.get('set-cookie'), null)
  const signedIn = await login('username=admin&password=admin123')
  assert.equal(signedIn.status, 303)
  assert.equal(signedIn.headers.get('location'), '/hep/')
  assert.equal(signedIn.headers.get('referrer-policy'), 'same-origin')
  const setCookie = signedIn.headers.get('set-cookie')
  assert.match(setCookie, /Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000/)
  const cookie = setCookie.split(';')[0]
  const admission = root.connection.admitConnection({ headers: { host: new URL(base).host, cookie } })
  assert.equal(admission.peer, root.connection.browserPeer)
  await admission.release()
  const storedSession = root.credentials.records.get('harness-platform/browser-sessions')
  assert.ok(storedSession.payload.sessions.every(item => /^[a-f0-9]{64}$/.test(item.digest)))
  assert.ok(!JSON.stringify(storedSession).includes(cookie.split('=')[1]))
  assert.ok(!JSON.stringify(storedSession).includes('admin123'))
  assert.equal((await fetch(base + '/', { headers: { cookie } })).status, 200)
  const report = await fetch(base + downloadPath, { headers: { cookie } })
  assert.equal(report.status, 200)
  assert.equal(report.headers.get('content-type'), 'text/markdown; charset=utf-8')
  assert.match(report.headers.get('content-disposition'), /attachment/)
  assert.equal(report.headers.get('cache-control'), 'no-store')
  assert.match(await report.text(), /前缀路径下载验证/)
  const archive = await fetch(base + downloadPath.replace('kind=report', 'kind=archive'), { headers: { cookie } })
  assert.equal(archive.status, 200)
  assert.equal(archive.headers.get('content-type'), 'application/zip')
  assert.equal(Buffer.from(await archive.arrayBuffer()).subarray(0, 2).toString(), 'PK')
  assert.equal((await login('username=admin&username=admin&password=admin123')).status, 401)
  assert.equal((await login('x'.repeat(4097))).status, 413)
  assert.equal((await fetch(base + '/login', { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', origin: 'http://untrusted.invalid',
  }, body: 'username=admin&password=admin123' })).status, 403)
  assert.equal((await fetch(base + '/login', { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', origin: 'null',
  }, body: 'username=admin&password=admin123' })).status, 403)
  const untrustedHost = await new Promise((resolve, reject) => {
    const request = httpRequest(base + '/login', { headers: { host: 'untrusted.invalid' } }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(untrustedHost, 403)
  assert.equal((await fetch(base + '/harness-platform/inventory', { method: 'POST', headers: {
    cookie, origin: 'http://untrusted.invalid', 'content-type': 'application/json',
  }, body: JSON.stringify(envelope('inventory')) })).status, 403)
  assert.equal((await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401)
  const inventory = await request('/harness-platform/inventory', envelope('inventory'), cookie)
  assert.equal((await inventory.json()).result.value.root, assetRoot)
  const events = await fetch(base + '/api/harness-platform/events', { headers: { cookie } })
  assert.equal(events.status, 200)
  assert.match(events.headers.get('content-type'), /^text\/event-stream/)
  const reader = events.body.getReader()
  const initial = new TextDecoder().decode((await reader.read()).value)
  assert.deepEqual(JSON.parse(initial.match(/^data: (.*)$/m)[1]).domains, ['catalog', 'agents', 'instances', 'mcp', 'assistant'])
  await reader.cancel()
  const init = await request(gateway, initialize, cookie)
  assert.equal(init.status, 200)
  assert.equal((await init.json()).result.protocolVersion, '2025-06-18')
  assert.equal((await request(gateway, { jsonrpc: '2.0', method: 'notifications/initialized' }, cookie)).status, 202)
  const tools = await request(gateway, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, cookie)
  const list = (await tools.json()).result.tools
  assert.equal(list.length, 1)
  const call = await request(gateway, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: list[0].name, arguments: {} } }, cookie)
  const failed = await call.json()
  assert.ok(failed.error || failed.result?.isError)
  const logout = await fetch(base + '/logout', { method: 'POST', headers: { cookie, origin }, redirect: 'manual' })
  assert.equal(logout.status, 303)
  assert.equal(logout.headers.get('location'), '/hep/login')
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await request('/harness-platform/inventory', envelope('inventory'), cookie)).status, 401)
  assert.deepEqual(root.connection.admitConnection({ headers: { host: new URL(base).host, cookie } }), { rejection: 401 })
  assert.equal((await fetch(base + downloadPath, { headers: { cookie } })).status, 401)
  const second = await login('username=admin&password=admin123')
  const secondCookie = second.headers.get('set-cookie').split(';')[0]
  await loaded.dispose()
  assert.equal((await request('/harness-platform/inventory', envelope('inventory'), cookie)).status, 404)
  assert.equal((await request(gateway, initialize, cookie)).status, 401)
  assert.equal((await fetch(base + '/api', { method: 'POST', headers: { cookie: secondCookie }, body: '{}' })).status, 401)
  const reloaded = root.plugin(plugin, { openBrowser: false, printUrl: false, surfaceContext: false })
  await reloaded
  assert.equal(reloaded.state, 2)
  assert.equal((await request('/harness-platform/inventory', envelope('inventory'), secondCookie)).status, 200)
  await reloaded.dispose()
  writeFileSync(join(assetRoot, '.local/credentials/admin.json'), JSON.stringify({ username: 'admin', password: 'changed' }))
  const changed = root.plugin(plugin, { openBrowser: false, printUrl: false, surfaceContext: false })
  await changed
  assert.equal(changed.state, 2)
  assert.equal((await request('/harness-platform/inventory', envelope('inventory'), secondCookie)).status, 401)
  assert.equal((await login('username=admin&password=admin123')).status, 401)
  assert.equal((await login('username=admin&password=changed')).status, 303)
  await changed.dispose()
  const records = root.credentials.records
  const key = 'harness-platform/browser-sessions'
  const sessionRecord = records.get(key)
  sessionRecord.payload.sessions.forEach(item => { item.expires = Date.now() - 1 })
  const expired = root.plugin(plugin, { openBrowser: false, printUrl: false, surfaceContext: false })
  await expired
  assert.equal(expired.state, 2)
  assert.equal(records.get(key).payload.sessions.length, 0)
  await expired.dispose()
  records.set(key, { kind: 'grant', payload: { version: 'invalid' } })
  const corrupt = root.plugin(plugin, { openBrowser: false, printUrl: false, surfaceContext: false })
  await assert.rejects(async () => { await corrupt }, /平台会话记录无效/)
  assert.equal(corrupt.state, 3)
  assert.equal((await fetch(base + '/api', { method: 'POST', headers: { cookie: oldCookie }, body: '{}' })).status, 401)
  await corrupt.dispose()
  writeFileSync(join(assetRoot, '.local/credentials/admin.json'), '{invalid')
  const invalid = root.plugin(plugin, { openBrowser: false, printUrl: false, surfaceContext: false })
  await assert.rejects(async () => { await invalid }, /无法读取平台账号配置/)
  assert.equal(invalid.state, 3)
  assert.equal((await fetch(base + '/api', { method: 'POST', headers: { cookie: oldCookie }, body: '{}' })).status, 401)
})
