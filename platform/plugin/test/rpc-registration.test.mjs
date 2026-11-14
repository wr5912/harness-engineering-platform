import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as plugin from '../lib/index.js'

test('真实 Cordis 提供方 Fiber 无 webServer 注入时，插件仍经原生 RPC 载体注册且可卸载', async t => {
  const root = new Context()
  const assetRoot = mkdtempSync(join(tmpdir(), 'harness-platform-rpc-'))
  const previous = process.env.HARNESS_ASSET_ROOT
  process.env.HARNESS_ASSET_ROOT = assetRoot
  t.after(async () => {
    await root.fiber.dispose()
    rmSync(assetRoot, { recursive: true, force: true })
    if (previous === undefined) delete process.env.HARNESS_ASSET_ROOT
    else process.env.HARNESS_ASSET_ROOT = previous
  })
  mkdirSync(join(assetRoot, 'agents/rpc-agent'), { recursive: true })
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // 只隔离认证持久化；Cordis、Connection 注册、认证判定和 HTTP 桥均执行真实实现。
  await root.plugin({
    name: 'connection-provider',
    apply(ctx) {
      new HostConnectionService(ctx, [], {
        isAuthenticated: request => request.headers.authorization === 'Bearer fixture',
        authenticateApi: () => undefined,
      })
    },
  })
  await root.plugin({ name: 'test-platform-mcp', apply(ctx) { ctx.provide('platformMcp', { servers: { get: () => [] }, groups: { get: () => [] } }) } })
  // 本项不发起 Session 或模型请求；提供平台新依赖，投影与提示词仍使用原生服务。
  await root.plugin({ name: 'test-assistant-services', apply(ctx) {
    new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, {})
    ctx.provide('workspaceRegistry', {})
    ctx.provide('workingDirectory', {})
    ctx.provide('platformBranding', () => ({ name: 'Harness 工程平台', subtitle: '' }))
    ctx.provide('workspaceController', {})
    ctx.provide('sessionController', {})
    ctx.provide('sessionQuery', { async readSession() { assert.fail('注册测试不读取 Session 历史') } })
    ctx.provide('sessionPersistence', {})
    ctx.provide('sessionProjectionCache', {})
    ctx.provide('sessions', {})
    ctx.provide('settingsController', {})
    ctx.provide('agentDefaultModel', {})
    ctx.provide('llm', { listConfigurableProviders: () => [] })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('tools', { register() {} })
    ctx.provide('goals', { get: () => undefined })
    // 空数据工作区仍可验证认证与原生注册；本项不发起管理会话。
    ctx.provide('skills', { async get() { return undefined } })
    ctx.provide('attachments', { fileHostPath: () => undefined, async *readFileStream() { assert.fail('注册测试不读取附件') } })
    new LocalFileSystem(ctx, { cwd: assetRoot, diffBasisMaxBytes: 1024 * 1024 })
  } })
  // 此项只验证注册方 Fiber；完整登录入口由 native-auth 与真实全局 DSH 验证。
  const loaded = root.plugin({ ...plugin, inject: plugin.inject.filter(name => name !== 'credentials'), apply: plugin.applyTools })
  await loaded
  assert.equal(loaded.state, 2)
  const url = `http://127.0.0.1:${root.webServer.port}/harness-platform/inventory`
  const payload = JSON.stringify({ type: 'client-request', rpcId: 'fixture-request', method: 'inventory', payload: {} })
  const unauthenticated = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
  assert.equal(unauthenticated.status, 401)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
    body: payload,
  })
  assert.equal(response.status, 200)
  const envelope = await response.json()
  assert.equal(envelope.result.ok, true)
  assert.equal(envelope.result.value.root, assetRoot)
  assert.equal(envelope.result.value.agents[0].id, 'rpc-agent')
  // 读取失败也不得发布“数据已变化”，否则页面收到通知后会无限重读。
  const abort = new AbortController()
  // applyTools 不挂载 WebApp 的共享 HTTP 载体，直接经过原生 Connection 的共享 Fetch 分发。
  const events = await root.connection.createSharedFetchHandler('api').fetch(new Request('http://fixture/api/harness-platform/events', { signal: abort.signal }), { principal: { kind: 'owner' } })
  assert.equal(events.status, 200, await (events.status === 200 ? Promise.resolve('') : events.text()))
  assert.match(events.headers.get('content-type'), /^text\/event-stream/)
  const reader = events.body.getReader(), frames = []
  const receive = (async () => {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        for (const line of new TextDecoder().decode(chunk.value).split('\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)))
      }
    } catch (error) { if (!abort.signal.aborted) throw error }
  })()
  try {
    for (let attempt = 0; !frames.length && attempt < 100; attempt++) await delay(10)
    assert.equal(frames.length, 1)
    const rpc = endpoint => fetch(`http://127.0.0.1:${root.webServer.port}/harness-platform/agents/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
      body: JSON.stringify({ type: 'client-request', rpcId: endpoint, method: `agents/${endpoint}`, payload: {} }),
    }).then(response => { assert.equal(response.status, 200); return response.json() })
    for (const endpoint of ['business/list', 'business/detail', 'business/read']) await rpc(endpoint)
    await delay(200)
    assert.equal(frames.length, 1, '业务资产读取不触发失效通知')
    await rpc('business/save')
    for (let attempt = 0; frames.length < 2 && attempt < 200; attempt++) await delay(10)
    assert.equal(frames.length, 2, '写入仍通知页面重新读取')
    assert.deepEqual(frames[1].domains, ['agents', 'catalog'])
  } finally { abort.abort(); await receive }
  await loaded.dispose()
  const removed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
  assert.equal(removed.status, 404)
})
