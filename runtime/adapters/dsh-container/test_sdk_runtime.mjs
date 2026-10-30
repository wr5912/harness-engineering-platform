import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from './sdk-preset.mts'
import { sdkExecutionStatus } from './sdk-instance-state.mts'
import { sdkCliSummary, sdkRootOutcome } from './sdk-runner.mts'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function binding(recorded) {
  let listener
  const calls = []
  const ctx = {
    on(name, callback, options) { assert.equal(name, 'agent/created'); assert.equal(options.prepend, true); listener = callback },
    sessionProjections: { stateOf() { return recorded } },
    agentPresets: {
      async select(agent, id) { calls.push(['select', agent, id]) },
      async mount(scope, id) { calls.push(['mount', scope, id]) },
    },
  }
  apply(ctx, { presetId: 'sdk-business' })
  return { listener, calls }
}

test('SDK 新根会话在输入前选择固定业务 Preset，子会话保留原有绑定', async () => {
  const { listener, calls } = binding()
  const agent = { session: { header: {} }, ctx: {} }
  await listener({ agent, source: 'startup' })
  assert.deepEqual(calls, [['select', agent, 'sdk-business']])
  await listener({ agent: { session: { header: { parentSession: 'parent' } } }, source: 'startup' })
  assert.equal(calls.length, 1)
})

test('SDK 恢复使用持久 Preset，不改写已运行会话的选择事件', async () => {
  const { listener, calls } = binding('sdk-business')
  const agent = { session: { header: {} }, ctx: {} }
  await listener({ agent, source: 'resume' })
  assert.deepEqual(calls, [['mount', agent.ctx, 'sdk-business']])
})

test('SDK 恢复来源不一致时明确失败，不退回默认 Agent', async () => {
  const { listener, calls } = binding('another-business')
  await assert.rejects(listener({ agent: { session: { header: {} } }, source: 'resume' }), /不一致/)
  assert.deepEqual(calls, [])
})

test('停止信号只有在确认容器停妥后才成为 stopped', () => {
  assert.equal(sdkExecutionStatus(true, 1, undefined, { state: 'exited', stopped: true }), 'stopped')
  assert.equal(sdkExecutionStatus(true, 1, undefined, { state: 'running', stopped: false }), 'unknown')
  assert.equal(sdkExecutionStatus(true, 1, undefined, { state: 'unknown', stopped: null }), 'unknown')
})

test('Compose 异常退出且无 SDK 最终回执时保留 unknown', () => {
  assert.equal(sdkExecutionStatus(false, 1, undefined, { state: 'running', stopped: false }), 'unknown')
  assert.equal(sdkExecutionStatus(false, 1, undefined, { state: 'exited', stopped: true }), 'unknown')
  assert.equal(sdkExecutionStatus(false, 0, undefined, { state: 'unknown', stopped: null }), 'unknown')
  assert.equal(sdkExecutionStatus(false, 1, { status: 'failed' }, { state: 'exited', stopped: true }), 'failed')
  assert.equal(sdkExecutionStatus(false, 0, { status: 'completed' }, { state: 'exited', stopped: true }), 'completed')
})

test('子任务失败或取消后根会话最终完成，不扩大为整体失败', () => {
  const turn = (sessionId, kind) => ({ sessionId, event: { type: 'turn/end', data: { reason: { kind } } } })
  assert.deepEqual(sdkRootOutcome('root', [turn('root', 'completed'), turn('child', 'error'), turn('root', 'completed')]), { status: 'completed' })
  assert.deepEqual(sdkRootOutcome('root', [turn('child', 'aborted'), turn('root', 'completed')]), { status: 'completed' })
})

test('根会话最后回合错误仍明确失败，缺失回执保留 unknown', () => {
  const turns = [{ sessionId: 'root', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
    { sessionId: 'root', event: { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'root failed' } } } } }]
  assert.deepEqual(sdkRootOutcome('root', turns), { status: 'failed', message: 'root failed' })
  assert.equal(sdkRootOutcome('root', []).status, 'unknown')
})

test('CLI 终态不重复发送超过 1 MiB 的事件数组，函数结果仍保留事件', () => {
  const events = Array.from({ length: 8 }, () => ({ type: 'tool/result', data: { text: 'x'.repeat(256 * 1024) } }))
  const result = { type: 'result', status: 'completed', session_id: 'session-example', final_response: 'ok', events }
  const summary = sdkCliSummary(result)
  assert.equal(summary.event_count, 8)
  assert.equal(Object.hasOwn(summary, 'events'), false)
  assert.ok(JSON.stringify(summary).length < 1024)
  assert.equal(result.events, events)
  assert.ok(JSON.stringify(result).length > 1024 * 1024)
})

test('准备前已有取消标记时不改写旧实例登记，也不启动 Docker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-sdk-prelaunch-'))
  try {
    const target = join(directory, 'instance'); mkdirSync(target)
    const old = JSON.stringify({ profile: 'sdk', status: 'completed', sdk_operation_id: 'old-operation' })
    writeFileSync(join(target, 'instance.json'), old)
    const marker = join(directory, 'stop-requested'); writeFileSync(marker, '')
    const config = join(directory, 'launch.json')
    writeFileSync(config, JSON.stringify({ target, name: 'sdk-example', project: 'sdk-example', contract: {}, identity: {}, manifest: { sdk_operation_id: 'new-operation' } }))
    const executed = spawnSync(process.execPath, [fileURLToPath(new URL('./sdk-instance.mts', import.meta.url)), config], {
      env: { ...process.env, HARNESS_SDK_STOP_FILE: marker }, encoding: 'utf8', timeout: 10000,
    })
    assert.equal(executed.status, 1, executed.stderr)
    const report = JSON.parse(executed.stdout.trim())
    assert.equal(report.status, 'stopped')
    assert.equal(report.runtime_started, false)
    assert.equal(readFileSync(join(target, 'instance.json'), 'utf8'), old)
    assert.equal(existsSync(join(target, 'dsh-home')), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
