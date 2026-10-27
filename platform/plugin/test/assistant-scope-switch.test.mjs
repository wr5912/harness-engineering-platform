import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../lib/index.js'

const require = createRequire(import.meta.url)
const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
const [{ ToolRuntime }, { createScope }, { createUserMessage }, { SkillRegistry }, { FileSystemSkillProvider }] = await Promise.all([
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-tools')).href),
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-scope')).href),
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-llm')).href),
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-skill')).href),
  import(pathToFileURL(sdkRequire.resolve('@deepseek-ai/dsh-skill-filesystem')).href),
])

test('真实HTTP管理会话使用原生工具，专用切换与可信Skill可用，普通DSH会话不受影响', async t => {
  const ctx = new Context()
  const assetRoot = mkdtempSync(join(tmpdir(), 'assistant-scope-switch-'))
  writeFileSync(join(assetRoot, 'AGENTS.md'), '管理当前测试数据工作区。')
  for (const name of ['workspace-management', 'user-facing-output', 'compute-variant-research', 'task-builder']) {
    const directory = join(assetRoot, '.agents/skills', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 作用域切换测试技能\n---\n仅办理本测试的管理任务。`)
  }
  const extensionSkills = join(assetRoot, 'extensions/basic/skills')
  mkdirSync(join(extensionSkills, 'basic-data'), { recursive: true })
  writeFileSync(join(extensionSkills, 'basic-data/SKILL.md'), '---\nname: basic-data\ndescription: 声明扩展业务技能\n---\n读取基础模拟数据。')
  writeFileSync(join(assetRoot, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-scope-switch', extensions: [{ id: 'basic', path: 'extensions/basic' }] }))
  const previous = process.env.HARNESS_ASSET_ROOT
  const previousEntry = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_ASSET_ROOT = assetRoot
  process.env.HARNESS_DSH_ENTRY = new URL('../package.json', import.meta.url).pathname
  const agents = new Map(), scopes = [], calls = [], prompts = []
  let loaded, skillProvider
  t.after(async () => {
    await loaded?.dispose()
    for (const scope of scopes) await scope.dispose()
    await skillProvider?.dispose()
    await ctx.fiber.dispose()
    rmSync(assetRoot, { recursive: true, force: true })
    if (previous === undefined) delete process.env.HARNESS_ASSET_ROOT
    else process.env.HARNESS_ASSET_ROOT = previous
    if (previousEntry === undefined) delete process.env.HARNESS_DSH_ENTRY
    else process.env.HARNESS_DSH_ENTRY = previousEntry
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin({ name: 'scope-switch-services', apply(inner) {
    new HostConnectionService(inner, [], {
      isAuthenticated: request => request.headers.authorization === 'Bearer fixture', authenticateApi: () => undefined,
    })
    new SessionStore(inner)
    new SessionProjectionRegistry(inner)
    new SystemPrompt(inner, {})
    new SkillRegistry(inner, {})
    inner.skills.registerProvider(control => skillProvider = new FileSystemSkillProvider(inner, control, {
      includeDefaultRoots: false, customSkillDirs: [join(assetRoot, '.agents/skills'), extensionSkills], watch: false,
    }))
    new ToolRuntime(inner, { mode: 'native' })
    for (const name of ['skill', 'bash', 'read', 'write', 'spawn_agent']) inner.tools.register({
      name, description: '作用域回归工具', parameters: { type: 'object', additionalProperties: true },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{}' }] },
      execute(args, execution) { calls.push({ name, args, agentId: execution.agent.id }); return {} },
    })
    inner.provide('platformMcp', { servers: { get: () => [] }, groups: { get: () => [] } })
    inner.provide('workspaceRegistry', {})
    inner.provide('workspaceController', {})
    inner.provide('settingsController', {})
    inner.provide('agentDefaultModel', {})
    inner.provide('llm', { listConfigurableProviders: () => [] })
    inner.provide('agents', { get: id => agents.get(id) })
    inner.provide('goals', { get: () => undefined })
    // 仅隔离会话调度与模型输入；HTTP、Session投影、插件入口和工具执行均使用真实实现。
    inner.provide('sessionController', {
      async create() {
        const id = `scope-session-${agents.size + 1}`
        const session = inner.sessions.create(id, { meta: { cwd: assetRoot } })
        const agent = { id, session, status: 'idle' }
        const scope = createScope(inner, agent)
        agent.ctx = scope.ctx
        agents.set(id, agent); scopes.push(scope)
        ctx.emit('agent/created', { agent })
        return { sessionId: id }
      },
      async resolveAgent(id) { return { agent: agents.get(id) } },
      async prompt(request) {
        prompts.push(request)
        const agent = agents.get(request.sessionId)
        agent.session.append('user/message', createUserMessage({ content: request.content, source: { kind: 'user' } }), { surfaceOp: 'append' })
        await inner.systemPrompt.assemble({ scope: agent, agent })
        return { accepted: true }
      },
      cancel() { return { accepted: true } },
    })
  } })
  loaded = ctx.plugin({ ...plugin, inject: plugin.inject.filter(name => name !== 'credentials'), apply: plugin.applyTools })
  await loaded
  assert.equal(loaded.state, 2)
  const rpc = async (method, payload) => {
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/harness-platform/assistant/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
      body: JSON.stringify({ type: 'client-request', rpcId: `scope-${method}`, method: `assistant/${method}`, payload }),
    })
    assert.equal(response.status, 200)
    const envelope = await response.json()
    assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result))
    return envelope.result.value
  }
  const created = await rpc('session', { task: '检查算力变体', context: { skill: 'compute-variant-research' } })
  const id = created.session_id, agent = agents.get(id)
  const schemas = async () => (await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map(tool => tool.name).sort()
  let sequence = 0
  const execute = (name, args = {}, target = agent) => ctx.tools.execute({ name, arguments: args, callId: `scope-call-${++sequence}`, agent: target, signal: new AbortController().signal })
  const assertManagement = async () => {
    const names = await schemas()
    for (const name of ['platform_agents', 'platform_instances', 'platform_mcp', 'platform_task', 'skill', 'bash', 'read', 'write']) assert.ok(names.includes(name), `${name} 应可用`)
  }
  const assertCompute = async () => {
    assert.deepEqual(await schemas(), ['platform_agents', 'platform_task', 'skill'])
    assert.equal((await execute('skill', { name: 'compute-variant-research' })).isError, false)
    assert.equal((await execute('skill', { name: 'task-builder' })).isError, true)
    const status = await execute('platform_task', { action: 'status', input: {} })
    assert.equal(status.isError, false, JSON.stringify(status))
    for (const tool of ['platform_instances', 'platform_mcp', 'bash', 'read', 'write', 'spawn_agent']) assert.equal((await execute(tool)).isError, true)
  }
  await assertCompute()
  await rpc('status', { session_id: id })
  await assertCompute()
  await rpc('session', { session_id: id, task: '继续固定任务，不重复发送context' })
  assert.equal((await rpc('status', { session_id: id })).task_context.skill, 'compute-variant-research')
  await assertCompute()

  await rpc('session', { session_id: id, task: '明确结束专用任务', context: {} })
  await rpc('status', { session_id: id })
  assert.ok(ctx.tools.get('bash', agent), '退出专用任务后使用原生 DSH 工具')
  await assertManagement()
  for (const name of ['bash', 'read', 'write']) assert.ok(ctx.tools.get(name, agent), `${name} 应可用`)
  assert.equal((await execute('skill', { name: 'workspace-management' })).isError, false)
  assert.equal((await execute('skill', { name: 'basic-data' })).isError, false, '通用管理允许实际装载的已声明扩展技能')
  const ordinary = agents.get((await ctx.sessionController.create()).sessionId)
  assert.ok((await ctx.systemPrompt.assemble({ scope: ordinary, agent: ordinary })).tools.some(tool => tool.name === 'read'))
  for (const name of ['bash', 'read', 'write']) assert.equal((await execute(name, {}, ordinary)).isError, false, '未激活管理身份的原生Session保持原能力')
  assert.equal((await execute('platform_mcp', { action: 'context', input: {} }, ordinary)).isError, true, '普通原生Session即使在数据工作区也不能调用平台MCP工具')
  assert.equal((await execute('platform_mcp', { action: 'context', input: {} }, { ...ordinary, id })).isError, true, '不能借用管理Session ID绕过执行身份')
  assert.equal((await execute('platform_mcp', { action: 'context', input: {} })).isError, false, '管理Session保持MCP工具访问')
  await rpc('session', { session_id: id, task: '再次进入算力任务', context: { skill: 'compute-variant-research' } })
  await assertCompute()

  await rpc('session', { session_id: id, task: '切换普通构建任务', context: { skill: 'task-builder' } })
  await assertManagement()
  assert.equal((await execute('skill', { name: 'task-builder' })).isError, false)
  // 普通构建任务可读取数据工作区的实际业务技能；不存在的技能仍拒绝。
  assert.equal((await execute('skill', { name: 'compute-variant-research' })).isError, false)
  await rpc('status', { session_id: id })
  await schemas()

  await rpc('session', { session_id: id, task: '返回算力任务', context: { skill: 'compute-variant-research' } })
  await assertCompute()
  // 兼容现场已存在的空task_context记录：剩余execution应切换到普通任务，不能遗留compute声明。
  appendPluginRecord(agent.session, 'plugin:harness-platform/assistant', { kind: 'execution', owner_session_id: id,
    execution: { id: 'previous-task', state: 'cancelled', model_calls: 0, operations: [], plan: { kind: 'business', budget: { max_model_calls: 60 } } } })
  appendPluginRecord(agent.session, 'plugin:harness-platform/assistant', { kind: 'task', task: '历史空上下文', context: {} })
  await rpc('status', { session_id: id })
  await assertManagement()
  await rpc('session', { session_id: id, task: '重新选择算力任务', context: { skill: 'compute-variant-research' } })
  await assertCompute()
  assert.equal(calls.some(call => call.agentId === id && ['bash', 'read', 'write', 'spawn_agent'].includes(call.name)), false)
  assert.equal(prompts.length, 7)
  ctx.emit('agent/disposed', { agent })
  assert.ok(ctx.tools.get('bash', agent), 'agent disposed释放所有平台限制')
  const stop = agent.ctx.tools.presentAs('native')
  stop()
  await rpc('status', { session_id: id })
  await assertCompute()
  await loaded.dispose()
  assert.ok(ctx.tools.get('bash', agent), '插件卸载释放重新安装的scope')
  const stopAfterUnload = agent.ctx.tools.presentAs('native')
  stopAfterUnload()
})
