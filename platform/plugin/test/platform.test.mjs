import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPlatformHandler } from '../lib/index.js'

test('模块分派保留认证 peer、取消信号与负载；未知操作不触发模块', async () => {
  const calls = []
  const handler = createPlatformHandler('/unused', Object.fromEntries(['agents', 'instances', 'mcp'].map(domain =>
    [domain, async (...args) => { calls.push({ domain, args }); return { ok: true, value: domain } }])))
  const signal = new AbortController().signal
  const peer = { id: 'authenticated-peer' }
  const payload = { name: 'selected' }
  for (const domain of ['agents', 'instances', 'mcp']) {
    assert.equal((await handler(`${domain}/list`, payload, signal, peer)).value, domain)
    assert.deepEqual(calls.at(-1), { domain, args: ['list', payload, signal, peer] })
  }
  assert.equal((await handler('other/list', {}, signal, peer)).error.code, 'not_found')
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal((await handler('instances/delete', {}, cancelled.signal, peer)).error.code, 'aborted')
  assert.equal(calls.length, 3)
})

test('当前账号只读查询返回配置中的用户名且不回传密码', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-account-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.local/credentials'), { recursive: true })
  writeFileSync(join(root, '.local/credentials/admin.json'), JSON.stringify({ username: 'platform-owner', password: 'local-test-secret' }))
  const handler = createPlatformHandler(root, { agents: async () => { throw new Error('unexpected domain') }, instances: async () => { throw new Error('unexpected domain') }, mcp: async () => { throw new Error('unexpected domain') } })
  const signal = new AbortController().signal
  assert.deepEqual(await handler('auth/current', {}, signal), { ok: true, value: { username: 'platform-owner' } })
  assert.equal((await handler('auth/current', { password: true }, signal)).error.code, 'invalid_request')
})

test('智能体详情一次观察返回当前版本实例和同 Agent 全部实际装载，失败时保持未知', async () => {
  const observed = [
    { name: 'alpha-current', agent_id: 'alpha', source_id: 'experiment:EXP-alpha-002', state: 'running' },
    { name: 'alpha-older', agent_id: 'alpha', source_id: 'experiment:EXP-alpha-001', state: 'stopped' },
    { name: 'beta-current', agent_id: 'beta', source_id: 'experiment:EXP-beta-001', state: 'running' },
  ]
  let unavailable = false
  let reads = 0
  const handler = createPlatformHandler('/unused', {
    agents: async () => ({ ok: true, value: { agent: { id: 'alpha' }, experiment: { id: 'EXP-alpha-002' }, loaded_instance: { status: 'not_queried' } } }),
    instances: async endpoint => {
      assert.equal(endpoint, 'list')
      reads++
      return unavailable ? { ok: false, error: { message: '实例观察不可用' } } : { ok: true, value: { instances: observed } }
    },
    mcp: async () => { throw new Error('unexpected mcp read') },
  })
  const signal = new AbortController().signal
  const actual = await handler('agents/detail', { agent_id: 'alpha' }, signal)
  assert.equal(actual.ok, true)
  assert.equal(reads, 1)
  assert.deepEqual(actual.value.loaded_instance.instances, [observed[0]])
  assert.deepEqual(actual.value.loaded_instance.agent_instances, observed.slice(0, 2))
  unavailable = true
  const unknown = await handler('agents/detail', { agent_id: 'alpha' }, signal)
  assert.deepEqual(unknown.value.loaded_instance, { status: 'unknown', reason: '实例观察不可用' })
  assert.equal(reads, 2)
})

test('首页按冻结 Run 创建时间排序，保留失败状态，不以目录编号或文件时间推断最近结果', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-home-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'agents/test-agent'), { recursive: true })
  const records = [
    ['EXP-test-agent-001', 'run-00000000-0000-4000-8000-000000000001', '2026-10-13T01:00:00Z', 'failed'],
    ['EXP-test-agent-099', 'run-00000000-0000-4000-8000-000000000099', '2026-10-12T01:00:00Z', 'completed'],
    ['EXP-test-agent-002', 'run-00000000-0000-4000-8000-000000000002', '2026-10-11T01:00:00Z', 'cancelled'],
    ['EXP-test-agent-003', 'run-00000000-0000-4000-8000-000000000003', '2026-10-10T01:00:00Z', 'running'],
  ]
  for (const [experiment, id, created, status] of records) {
    const path = join(root, 'evolution/experiments', experiment)
    mkdirSync(join(path, 'runs', id), { recursive: true })
    writeFileSync(join(path, 'change.yaml'), `status: active\n`)
    writeFileSync(join(path, 'runs', id, 'run.yaml'), `run_id: ${id}\ncreated_at: ${created}\nstatus: ${status}\n`)
    writeFileSync(join(path, 'runs', id, 'summary.json'), JSON.stringify({ effective_verdict: status === 'completed' ? 'failed' : 'passed' }))
  }
  const handler = createPlatformHandler(root, {
    instances: async () => ({ ok: false, error: { message: 'Docker 暂不可用' } }),
    mcp: async () => ({ ok: true, value: { connections: [] } }),
  })
  const signal = new AbortController().signal
  const response = await handler('home', {}, signal)
  assert.equal(response.ok, true)
  assert.equal(response.value.recent_runs[0].experiment_id, 'EXP-test-agent-001')
  assert.equal(response.value.recent_runs[0].status, 'failed')
  assert.equal(response.value.recent_runs[0].agent_id, 'test-agent')
  assert.equal(response.value.recent_runs[0].effective_verdict, null, '失败 Run 的部分 summary 不得提升为业务通过')
  assert.equal(response.value.recent_runs[1].status, 'completed')
  assert.equal(response.value.recent_runs[1].effective_verdict, 'failed')
  assert.equal(response.value.recent_runs[2].effective_verdict, null, '取消 Run 没有整体结论')
  assert.equal(response.value.recent_runs[3].effective_verdict, null, '运行中 Run 没有整体结论')
  assert.equal(response.value.instances.ok, false)
  assert.equal(response.value.mcp.value.connections.length, 0)
  assert.equal((await handler('home', { root: '/etc' }, signal)).error.code, 'invalid_request')
})
