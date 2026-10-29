import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
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
    ctx.provide('workspaceController', {})
    ctx.provide('sessionController', {})
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
  await loaded.dispose()
  const removed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
  assert.equal(removed.status, 404)
})
