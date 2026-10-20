import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SESSION_FORMAT_VERSION, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { prepareConversation } from '../src/conversation.ts'
import { createAssistant } from '../src/assistant/index.ts'

test('进入管理对话只切回原生会话面板，保留侧栏与工作区分组偏好', () => {
  for (const activePanelId of [null, 'settings']) {
    const calls = []
    const layout = {
      panelInfo: { getSnapshot: () => ({ activePanelId }) },
      selectPanel: id => calls.push(id),
      toggleSidebar: () => assert.fail('不得更改侧栏偏好'),
    }
    prepareConversation(layout)
    assert.deepEqual(calls, activePanelId === null ? [] : [null])
  }
})

test('首页新任务按原生实际状态收起，不反向展开已折叠的侧栏', () => {
  for (const sidebarCollapsed of [true, false]) {
    let toggles = 0
    const layout = {
      panelInfo: { getSnapshot: () => ({ activePanelId: null }) },
      selectPanel: () => assert.fail('当前已经是会话面板'),
      toggleSidebar: () => toggles++,
    }
    prepareConversation(layout, sidebarCollapsed)
    assert.equal(toggles, sidebarCollapsed ? 0 : 1)
  }
})

test('助手写操作等待用户确认，原生记录恢复状态且失败回执不标记成功', async t => {
  const root = new Context()
  const assetRoot = mkdtempSync(join(tmpdir(), 'conversation-data-'))
  writeFileSync(join(assetRoot, 'AGENTS.md'), '管理当前数据工作区的业务资产。')
  for (const name of ['workspace-management', 'user-facing-output']) {
    const directory = join(assetRoot, '.agents/skills', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试管理技能\n---\n仅处理本测试的业务请求。`)
  }
  const skills = { async get(name, options) {
    assert.equal(options.cwd, assetRoot)
    const path = join(assetRoot, '.agents/skills', name, 'SKILL.md')
    return existsSync(path) ? { name, path, content: readFileSync(path, 'utf8'), invocation: { modelInvocable: true } } : undefined
  } }
  let projections
  await root.plugin({ name: 'test-projections', apply(ctx) { projections = new SessionProjectionRegistry(ctx) } })
  const session = Session.create('session-platform-test', undefined, {
    version: SESSION_FORMAT_VERSION, id: 'session-platform-test', createdAt: 0, isSeeded: false, cwd: assetRoot,
  })
  const calls = []
  const tools = new Map()
  const assistant = createAssistant(assetRoot, async (endpoint, input) => {
    calls.push({ endpoint, input })
    return { ok: false, error: { code: 'fixture_failure', message: '模拟操作失败', details: {} } }
  }, {
    controller: { resolveAgent: async () => ({ agent: { session } }) },
    projections, skills,
    systemPrompt: new SystemPrompt(root, {}),
    record: (target, type, value) => appendPluginRecord(target, type, value),
    notify() {},
  })
  t.after(async () => { await assistant.dispose(); await root.fiber.dispose(); rmSync(assetRoot, { recursive: true, force: true }) })
  assistant.registerTools({ register: tool => tools.set(tool.name, tool) })
  appendPluginRecord(session, 'plugin:harness-platform/assistant', { kind: 'workspace' })
  const controller = new AbortController()
  let finished = false
  const draft = { toolName: 'basic_read', title: '基础查询', description: '仅基础模拟数据', connectionId: 'mock-basic' }
  const execution = tools.get('platform_mcp').execute({ action: 'saveCompositionDraft', input: { draft } }, { agent: { id: session.id, session }, signal: controller.signal })
    .then(value => { finished = true; return value })
  const status = async () => (await assistant.handler('status', { session_id: session.id }, controller.signal)).value
  let state
  for (let i = 0; i < 10; i++) {
    state = await status()
    if (state.proposals.length) break
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(state.proposals[0].state, 'awaiting_confirmation')
  assert.equal(finished, false)
  assert.equal(calls.length, 0)
  const response = await assistant.handler('confirm', { session_id: session.id, proposal_id: state.proposals[0].id }, controller.signal)
  assert.equal(response.ok, true)
  assert.equal(response.value.state, 'failed')
  assert.equal(response.value.continuation, 'resumed')
  assert.equal((await execution).state, 'failed')
  assert.equal((await status()).proposals[0].state, 'failed')
  assert.deepEqual(calls, [{ endpoint: 'mcp/saveCompositionDraft', input: { draft, confirmed: true } }])
})
