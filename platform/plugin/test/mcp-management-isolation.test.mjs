import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createAssistant } from '../src/assistant/index.ts'
import { managementSkills } from '../src/assistant/business-assets.ts'

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const [{ ToolRuntime }, { createScope }] = await Promise.all([
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-scope',
].map(name => import(pathToFileURL(sdkRequire.resolve(name)).href)))

test('平台管理 Session 不等待失联 MCP 来源，仍可调用平台工具', { timeout: 8000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-management-isolation-'))
  const previousRoot = process.env.HARNESS_ASSET_ROOT
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_ASSET_ROOT = root
  process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
  const timers = new Set()
  let requests = 0
  const external = createServer((_req, res) => {
    requests++
    const timer = setTimeout(() => {
      timers.delete(timer)
      res.writeHead(503).end()
    }, 3000)
    timers.add(timer)
  })
  await new Promise(resolve => external.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer)
    external.closeAllConnections()
    await new Promise(resolve => external.close(resolve))
    if (previousRoot === undefined) delete process.env.HARNESS_ASSET_ROOT
    else process.env.HARNESS_ASSET_ROOT = previousRoot
    if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY
    else process.env.HARNESS_DSH_ENTRY = previousEntry
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'config'), { recursive: true })
  mkdirSync(join(root, '.local/credentials'), { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '管理当前测试数据工作区。')
  for (const name of managementSkills) {
    const path = join(root, '.agents/skills', name, 'SKILL.md')
    mkdirSync(join(root, '.agents/skills', name), { recursive: true })
    writeFileSync(path, `---\nname: ${name}\ndescription: 管理测试技能\n---\n办理测试工作区的管理任务。`)
  }
  const source = `http://127.0.0.1:${external.address().port}/mcp`
  const offlineServer = { id: 'offline', serverName: 'Offline', enabled: true, url: source,
    tools: { mode: 'all', names: [] } }
  writeFileSync(join(root, 'config/mcp-manager.json'), JSON.stringify({ schemaVersion: 1, servers: [
    offlineServer,
  ], groups: [] }))
  writeFileSync(join(root, '.local/credentials/mcp-manager.json'), JSON.stringify({ schemaVersion: 1,
    sharedToken: 'a'.repeat(64), servers: {} }), { mode: 0o600 })

  const ctx = new Context(), agents = new Map(), scopes = [], platformCalls = [], preset = {}
  const services = ctx.plugin({ name: 'mcp-management-test-services', apply(inner) {
    inner.provide('webServer', { publicPath: path => path, register: () => () => {} })
    inner.provide('connection', { requestRejection: () => undefined })
    new SessionStore(inner)
    new SessionProjectionRegistry(inner)
    new SystemPrompt(inner, {})
    new ToolRuntime(inner, { mode: 'native' })
  } })
  await services
  const manager = await import('../lib/platform-mcp-manager.js')
  const loaded = ctx.plugin({ name: 'mcp-management-test-manager', inject: ['webServer', 'connection', 'tools'], apply(inner) {
    manager.apply(inner, { servers: { get: () => [offlineServer] }, groups: { get: () => [] },
      sharedToken: { get: () => 'a'.repeat(64) } })
  } })
  await loaded
  const controller = {
    async create() {
      const id = `management-${agents.size + 1}`
      const session = ctx.sessions.create(id, { meta: { cwd: root } })
      const agent = { id, session, status: 'idle' }
      const scope = createScope(ctx, agent, { parent: preset })
      agent.ctx = scope.ctx
      agents.set(id, agent)
      scopes.push(scope)
      await ctx.serial('agent/created', { agent })
      return { sessionId: id }
    },
    async resolveAgent(id) { return { agent: agents.get(id) } },
    async prompt() { return { accepted: true } },
    cancel() { return { accepted: true } },
  }
  const skills = { async get(name, options) {
    assert.equal(options.cwd, root)
    const path = join(root, '.agents/skills', name, 'SKILL.md')
    return { name, path, content: readFileSync(path, 'utf8'), invocation: { modelInvocable: true } }
  } }
  const assistant = createAssistant(root, async (endpoint, input) => {
    platformCalls.push({ endpoint, input })
    return { ok: true, value: { endpoint } }
  }, { controller, skills, projections: ctx.sessionProjections, systemPrompt: ctx.systemPrompt,
    record(session, type, value) { appendPluginRecord(session, type, value) }, notify() {} })
  assistant.registerTools(ctx.tools)
  t.after(async () => {
    await assistant.dispose()
    for (const scope of scopes) await scope.dispose()
    await loaded.dispose()
    await services.dispose()
    await ctx.fiber.dispose()
  })

  const deadline = AbortSignal.timeout(1500)
  const started = performance.now()
  const created = await Promise.race([
    assistant.handler('session', { task: '检查平台状态' }, new AbortController().signal),
    new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('管理 Session 等待外部 MCP 超时')), { once: true })),
  ])
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.ok(performance.now() - started < 1500, '管理 Session 创建不得等待外部发现')
  const agent = agents.get(created.value.session_id)
  assert.equal(agent.session.header.cwd, root, '原生 Session 固定使用数据仓库工作区')
  assert.equal(requests, 0, '管理会话创建不能探测失联来源')
  assert.equal(ctx.tools.get('mcp__Offline__echo', agent), undefined)
  const status = await ctx.tools.execute({ name: 'platform_task', arguments: { action: 'status', input: {} },
    callId: 'management-status', agent, signal: new AbortController().signal })
  assert.equal(status.isError, false, JSON.stringify(status))
  const listed = await ctx.tools.execute({ name: 'platform_agents', arguments: { action: 'list', input: {} },
    callId: 'management-agents', agent, signal: new AbortController().signal })
  assert.equal(listed.isError, false, JSON.stringify(listed))
  assert.ok(platformCalls.some(call => call.endpoint === 'agents/list'), '平台工具仍能到达平台业务入口')
  assert.equal(requests, 0, '平台工具调用不能触发外部发现')
  assert.ok(ctx.tools.get('platform_task', agent), '平台工具仍由原生 ToolRuntime 装载')
})
