import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { assistantProjection } from '../src/assistant/index.ts'
import { TOOL_INPUT_JSON_RETRY_POLICY } from '../src/assistant/tool-input-recovery.ts'

const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-session'))
const { snapshotJsonValue } = await import(sdkRequire.resolve('@deepseek-ai/dsh-util-values'))
const { createUserMessage } = await import(sdkRequire.resolve('@deepseek-ai/dsh-llm'))

test('管理会话的用户输入、重试清理和任务收尾都可写入原生 JSON 检查点并冷恢复', async t => {
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
  assert.equal(state().closing_task_id, execution.id)
  user()
  assert.equal(Object.hasOwn(state(), 'closing_task_id'), false)
  record({ kind: 'execution', owner_session_id: session.id, execution: { ...execution, state: 'failed' } })
  assert.equal(Object.hasOwn(state(), 'closing_task_id'), false)
})
