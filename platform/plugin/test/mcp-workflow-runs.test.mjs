import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { workflowRuns } from '../src/mcp/workflow-runs.ts'

test('重复请求共用准备和运行，独立请求共享有界并发，报告与失败记录可恢复', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-workflow-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = workflowRuns(root)
  let preparations = 0, executions = 0, current = 0, peak = 0
  const request = { config: { workflow: 'check', kind: 'workflow' }, input: { scope: 'all' }, catalog: { compositions: [] }, version: { implementationDigest: 'a'.repeat(64) }, executionId: 'same-request', compositionId: 'check' }
  const workflow = { artifacts: result => [{ id: 'report', filename: 'report.md', contentType: 'text/markdown', body: String(result.count) }] }
  const snapshot = { scope: ['asset-1'], assets: [{ id: 'asset-1', status: 'online' }], rules: [{ id: 1 }], connection_fingerprints: { master: 'frozen' } }
  const prepare = async () => { preparations++; await delay(5); return snapshot }
  const execute = async context => {
    executions++
    const results = await context.map(Array.from({ length: 25 }, (_, i) => i), i => context.call(async () => {
      current++; peak = Math.max(peak, current); await delay(3); current--; return i
    }))
    context.progress({ completed: results.length, result: { items: results.map(id => ({ id, facts: ['source'] })) } })
    return { ok: true, result: { count: results.length } }
  }
  const [first, second] = await Promise.all([store.start(request, workflow, execute, prepare), store.start(request, workflow, execute, prepare)])
  assert.equal(first.status, 'accepted')
  assert.equal(first.run_id, second.run_id)
  assert.equal(preparations, 1)
  for (let i = 0; i < 100 && store.active().length; i++) await delay(5)
  const completed = store.inspect(first.run_id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.count, 25)
  assert.equal(peak, 8)
  assert.equal(completed.metrics.peak_concurrency, 8)
  assert.equal(completed.metrics.requests, 25)
  assert.equal(completed.nodes.root.result.items, undefined)
  assert.deepEqual(store.details(first.run_id, 'root', 20, 3).items.map(item => item.id), [20, 21, 22])
  assert.throws(() => store.details(first.run_id, 'root', -1), /分页/)
  assert.equal(completed.plan, undefined)
  assert.equal(completed.snapshot, undefined)
  assert.deepEqual(store.read(first.run_id).snapshot, snapshot)
  assert.equal(completed.artifacts[0].body, undefined)
  assert.equal(store.artifact(first.run_id, 'report').body, '25')
  assert.equal((await store.start(request, workflow, execute, prepare)).run_id, first.run_id)
  assert.equal(executions, 1)
  assert.equal(preparations, 1)
  await assert.rejects(store.start({ ...request, input: { scope: 'different' } }, workflow, execute, prepare), /执行标识/)
  const path = join(root, 'mcp/.local/runs', first.run_id + '.json')
  const record = JSON.parse(readFileSync(path)); record.status = 'running'; writeFileSync(path, JSON.stringify(record))
  assert.equal(store.inspect(first.run_id).status, 'interrupted')
  assert.equal(store.inspect(first.run_id).nodes.root.completed, 25)
  assert.equal(store.artifact(first.run_id, 'report').body, '25')
  const failed = await store.start({ ...request, executionId: 'failure' }, workflow, async context => { context.progress({ status: 'completed', value: 7 }); throw new Error('upstream unavailable') })
  for (let i = 0; i < 100 && store.active().length; i++) await delay(5)
  assert.equal(store.inspect(failed.run_id).status, 'failed')
  assert.equal(store.inspect(failed.run_id).nodes.root.value, 7)
})

test('排队运行保留各自调用上下文', async t => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const local = new AsyncLocalStorage()
  const root = mkdtempSync(join(tmpdir(), 'mcp-workflow-context-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = workflowRuns(root), observed = []
  const request = { config: { workflow: 'check', kind: 'workflow' }, input: {}, catalog: { compositions: [] }, version: { implementationDigest: 'b'.repeat(64) }, compositionId: 'check' }
  for (const id of ['a', 'b', 'c', 'd']) await local.run(id, () => store.start({ ...request, executionId: id }, {}, async () => {
    await delay(15); observed.push(local.getStore()); return { result: { id: local.getStore() } }
  }, async () => { await delay(5) }))
  for (let i = 0; i < 100 && store.active().length; i++) await delay(5)
  assert.deepEqual(observed.sort(), ['a', 'b', 'c', 'd'])
})

test('原生嵌套组合的明细从已保存结果分页读取，保留未知项且不重跑', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-workflow-details-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = workflowRuns(root)
  const result = { checks: { routine: { checks: {
    status: { items: [{ id: 'online', status: 'normal' }] },
    baseline: { items: [{ id: 'missing-evidence', status: 'unknown' }] },
  } }, vulnerabilities: { items: [{ id: 'unavailable', status: 'unknown' }] } } }
  const id = 'run-00000000-0000-4000-8000-000000000001'
  mkdirSync(join(root, 'mcp/.local/runs'), { recursive: true })
  const path = join(root, 'mcp/.local/runs', id + '.json')
  const original = JSON.stringify({ engine: 'workflow', status: 'completed', result, artifacts: [], nodes: {
    root: { status: 'completed' }, 'root/routine': { status: 'completed' }, 'root/routine/baseline': { status: 'completed' },
  } })
  writeFileSync(path, original)
  assert.equal(store.details(id, 'root').total, 3)
  assert.deepEqual(store.details(id, 'root', 1, 1).items, [{ id: 'missing-evidence', status: 'unknown' }])
  assert.equal(store.details(id, 'root/routine').total, 2)
  assert.deepEqual(store.details(id, 'root/routine/baseline').items, result.checks.routine.checks.baseline.items)
  assert.throws(() => store.details(id, 'root/absent'), /节点不存在/)
  assert.equal(readFileSync(path, 'utf8'), original)
})
