import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createInventoryHandler, inventory } from '../lib/index.js'

const runId = 'run-29a07c38-49b2-4c98-ae83-dc41e0cdd2ad'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harness-platform-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('查询真实目录、Run 归属与来源，过滤不符合资产合同的名称和普通文件', t => {
  const root = fixture(t)
  for (const path of ['agents/test-agent', 'agents/z-agent', 'agents/Invalid',
    `evolution/experiments/EXP-test-agent-001/runs/${runId}`,
    `evolution/experiments/EXP-test-agent-003-r123456789abc/runs/${runId}`,
    'evolution/experiments/EXP-test-agent-001/runs/run-invalid',
    'evolution/experiments/EXP-test-agent-002', 'evolution/experiments/not-an-experiment']) {
    mkdirSync(join(root, path), { recursive: true })
  }
  for (const id of ['EXP-test-agent-001', 'EXP-test-agent-002', 'EXP-test-agent-003-r123456789abc']) writeFileSync(join(root, `evolution/experiments/${id}/change.yaml`), `experiment_id: ${id}\nagent_id: test-agent\n`)
  writeFileSync(join(root, 'agents/file-agent'), '')
  const result = inventory(root)
  assert.equal(result.root, root)
  assert.equal(result.schema_version, '1.0')
  assert.ok(Number.isFinite(Date.parse(result.observed_at)))
  assert.deepEqual(result.agents, [{ id: 'test-agent', path: 'agents/test-agent' }, { id: 'z-agent', path: 'agents/z-agent' }])
  assert.deepEqual(result.experiments.map(item => item.id), ['EXP-test-agent-001', 'EXP-test-agent-002', 'EXP-test-agent-003-r123456789abc'])
  assert.deepEqual(result.runs, [
    { id: runId, experiment_id: 'EXP-test-agent-001', path: `evolution/experiments/EXP-test-agent-001/runs/${runId}` },
    { id: runId, experiment_id: 'EXP-test-agent-003-r123456789abc', path: `evolution/experiments/EXP-test-agent-003-r123456789abc/runs/${runId}` },
  ])
})

test('空仓库是成功查询；缺失根与不可读取 Run 路径是失败', async t => {
  const root = fixture(t)
  assert.deepEqual(inventory(root).agents, [])
  assert.deepEqual(inventory(root).experiments, [])
  assert.deepEqual(inventory(root).runs, [])
  const missing = await createInventoryHandler(join(root, 'missing'))('inventory', {}, new AbortController().signal)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'asset_read_failed')
  assert.equal(missing.error.details.filesystem_code, 'ENOENT')
  mkdirSync(join(root, 'evolution/experiments/EXP-test-agent-001'), { recursive: true })
  writeFileSync(join(root, 'evolution/experiments/EXP-test-agent-001/change.yaml'), 'experiment_id: EXP-test-agent-001\nagent_id: test-agent\n')
  writeFileSync(join(root, 'evolution/experiments/EXP-test-agent-001/runs'), '')
  const unreadable = await createInventoryHandler(root)('inventory', {}, new AbortController().signal)
  assert.equal(unreadable.ok, false)
  assert.equal(unreadable.error.details.filesystem_code, 'ENOTDIR')
})

test('RPC 查询固定来源，每次刷新读取当前目录，拒绝任意路径和未知操作', async t => {
  const root = fixture(t)
  const handler = createInventoryHandler(root)
  const signal = new AbortController().signal
  assert.equal((await handler('inventory', {}, signal)).value.agents.length, 0)
  mkdirSync(join(root, 'agents/new-agent'), { recursive: true })
  assert.equal((await handler('inventory', {}, signal)).value.agents[0].id, 'new-agent')
  assert.equal((await handler('inventory', { root: '/tmp' }, signal)).error.code, 'invalid_request')
  assert.equal((await handler('delete', {}, signal)).error.code, 'not_found')
  assert.equal((await handler('inventory', [], signal)).error.code, 'invalid_request')
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal((await handler('inventory', {}, cancelled.signal)).error.code, 'aborted')
})
