import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { assistantProjection } from '../src/assistant/index.ts'
import { TOOL_INPUT_JSON_RETRY_POLICY } from '../src/assistant/tool-input-recovery.ts'
import { compactAssistantHistory } from '../src/assistant/history-cache.ts'

const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session'))
const { snapshotJsonValue } = await import(sdkRequire.resolve('@deepseek-ai/dsh-util-values'))
const { createUserMessage } = await import(sdkRequire.resolve('@deepseek-ai/dsh-llm'))

test('管理会话的用户输入、重试清理和退役任务记录都可写入原生 JSON 检查点并冷恢复', async t => {
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  ctx.sessionProjections.register(assistantProjection)
  t.after(() => ctx.fiber.dispose())
  const session = ctx.sessions.create('session-projection-cache')
  const state = () => ctx.sessionProjections.stateOf(session, 'harnessPlatformAssistant')
  const check = () => {
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    assert.notEqual(snapshotJsonValue(checkpoint), undefined, '不能让一个投影阻止整份会话缓存写入')
    assert.deepEqual(JSON.parse(JSON.stringify(checkpoint)), checkpoint)
    const cold = ctx.sessionProjections.restore({}, session.snapshotEvents(), 0, session.header, 0)
    assert.deepEqual(cold.checkpoint.harnessPlatformAssistant.val, state())
  }
  const append = (type, data) => { session.append(type, data); check() }
  const record = data => { appendPluginRecord(session, 'plugin:harness-platform/assistant', data); check() }
  const user = () => {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '查看会话' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    check()
  }
  const retry = () => append('llm/retry', { turn: 1, step: 1, provider: 'basic', retry: 1, retryId: 'retry-basic', maxRetries: 2, delayMs: 1, policyKey: TOOL_INPUT_JSON_RETRY_POLICY })
  check()
  record({ kind: 'task', task: '检查会话', context: {} })
  record({ kind: 'task', context: {} })
  assert.equal(Object.hasOwn(state(), 'task'), false)
  user()
  append('turn/start', { turn: 1 })
  retry()
  assert.equal(state().extraction_json_retry.retry, 1)
  append('step/start', { turn: 1, step: 2 })
  assert.equal(Object.hasOwn(state(), 'extraction_json_retry'), false)
  retry()
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(Object.hasOwn(state(), 'extraction_json_retry'), false)
  const execution = { id: 'task-basic', owner_session_id: session.id, state: 'running', plan: { agent_id: 'inspection' } }
  record({ kind: 'execution', owner_session_id: session.id, execution })
  record({ kind: 'execution', owner_session_id: session.id, execution: { ...execution, state: 'completed' } })
  assert.equal(Object.hasOwn(state(), 'execution'), false)
  assert.equal(Object.hasOwn(state(), 'closing_task_id'), false)
  user()
  assert.equal(Object.hasOwn(state(), 'closing_task_id'), false)
  record({ kind: 'execution', owner_session_id: session.id, execution: { ...execution, state: 'failed' } })
  assert.equal(Object.hasOwn(state(), 'closing_task_id'), false)
})

test('历史缓存覆盖父工作区、业务仓和旧数据根，排除程序仓会话', async t => {
  const base = mkdtempSync(join(tmpdir(), 'manager-history-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const manager = join(base, 'manager-workspace'), data = join(manager, 'harness-engineering-platform-data')
  const business = join(manager, 'business-agents'), legacy = join(base, 'old-data')
  mkdirSync(data, { recursive: true }); mkdirSync(business)
  writeFileSync(join(data, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-history', legacyRoots: [legacy] }))
  const rows = [manager, data, business, legacy, join(base, 'harness-engineering-platform')].map((cwd, index) => ({
    header: { id: `session-${index}`, cwd }, revision: index, formatStatus: 'ready',
  }))
  const written = new Set(), closed = []
  const services = {
    sessions: { get() {}, messageProjections: {} }, agents: { get() {} },
    sessionPersistence: {
      async list() { return rows }, async stat(id) { return rows.find(row => row.header.id === id) },
      async open(id) { const row = rows.find(row => row.header.id === id); return {
        header: row.header, inheritedEventCount: 0, async read() { return { events: [], eventState: {} } }, async close() { closed.push(id) },
      } },
    },
    sessionProjectionCache: {
      cachedSnapshot(header) { return written.has(header.id) }, hydratePrepared() {}, async write(session) { written.add(session.header.id) },
    },
  }
  const result = await compactAssistantHistory(data, services, (id, events, header) => ({ header }), new AbortController().signal)
  assert.deepEqual(result, { written: 4, skipped: 1, failed: 0 })
  assert.deepEqual([...written], rows.slice(0, 4).map(row => row.header.id))
  assert.equal(closed.length, 4)
})
