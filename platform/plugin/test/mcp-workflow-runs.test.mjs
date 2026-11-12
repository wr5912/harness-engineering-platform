import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { workflowRuns } from '../src/mcp/workflow-runs.ts'

test('节点完成或失败在返回前落盘，后继不依赖延迟进度定时器', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-workflow-persist-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = workflowRuns(root)
  const request = { config: {}, input: {}, catalog: {}, version: {}, executionId: 'persist', compositionId: 'check' }
  const completed = await store.start(request, { responseMode: 'complete' }, async context => {
    const path = join(root, 'mcp/.local/runs', context.runId + '.json')
    for (const status of ['completed', 'failed']) {
      context.progress.call({ ...context, nodeId: status }, { status: 'running' })
      context.progress.call({ ...context, nodeId: status }, { status, result: { items: [{ fact: status }] } })
      const saved = JSON.parse(readFileSync(path, 'utf8')).nodes[status]
      assert.equal(saved.status, status)
      assert.deepEqual(saved.result.items, [{ fact: status }])
    }
    return { checked: true }
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.result.checked, true)
})

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

test('直接checks结果兼容routine包装及批次节点路径，读取已保存明细不重跑', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-workflow-direct-details-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = workflowRuns(root), id = 'run-00000000-0000-4000-8000-000000000002'
  const result = { checks: { status: { items: [{ id: 'online' }] }, baseline: { items: [{ id: 'baseline-unknown' }] }, vulnerabilities: { items: [{ id: 'asset-1' }] } } }
  mkdirSync(join(root, 'mcp/.local/runs'), { recursive: true })
  writeFileSync(join(root, 'mcp/.local/runs', id + '.json'), JSON.stringify({ engine: 'workflow', status: 'completed', result, artifacts: [], nodes: {
    root: {}, 'root/routine': {}, 'root/routine/baseline/summary': {}, 'root/routine/status': {}, 'root/summary': {}, 'root/vulnerabilities/assets': {}, 'root/vulnerabilities/assets[0]/assess': {},
  }}))
  assert.deepEqual(store.details(id, 'root/routine/baseline/summary').items, result.checks.baseline.items)
  assert.deepEqual(store.details(id, 'root/routine/status').items, result.checks.status.items)
  assert.equal(store.details(id, 'root/summary').total, 3)
  assert.deepEqual(store.details(id, 'root/vulnerabilities/assets').items, result.checks.vulnerabilities.items)
  assert.deepEqual(store.details(id, 'root/vulnerabilities/assets[0]/assess').items, result.checks.vulnerabilities.items)
})

test('准备与执行共用请求计数和并发额度，重复请求不重新准备', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-preparation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runs = workflowRuns(root), workflow = {}
  const request = { config: { workflow: 'test' }, compositionId: 'test', input: {}, catalog: {}, version: {}, executionId: 'same-request' }
  let active = 0, peak = 0, preparations = 0, preparationCall
  const call = async () => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve))
    active--
  }
  const prepare = async context => {
    preparations++; preparationCall = context.call
    await Promise.all(Array.from({ length: 12 }, () => context.call(call)))
    return { scope: { count: 1 } }
  }
  const execute = async context => {
    assert.equal(context.call, preparationCall)
    await context.call(call)
    return { status: 'completed' }
  }
  const first = await runs.start(request, workflow, execute, prepare)
  assert.equal(first.status, 'accepted')
  for (let i = 0; i < 100 && runs.active().length; i++) await delay(5)
  const completed = runs.inspect(first.run_id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.metrics.requests, 13)
  assert.equal(completed.metrics.peak_concurrency, 8)
  assert.equal(peak, 8)
  assert.equal((await runs.start(request, workflow, execute, prepare)).run_id, first.run_id)
  assert.equal(preparations, 1)
})

test('准备失败不创建已接受运行，原请求可在修复后重试', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-preparation-failure-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runs = workflowRuns(root), workflow = {}
  const request = { config: {}, compositionId: 'test', input: {}, catalog: {}, version: {}, executionId: 'retry-request' }
  await assert.rejects(runs.start(request, workflow, async () => ({}), async context => context.call(async () => { throw new Error('范围缺失') })), /范围缺失/)
  assert.deepEqual(runs.active(), [])
  assert.equal((await runs.start(request, workflow, async () => ({}))).status, 'accepted')
  for (let i = 0; i < 100 && runs.active().length; i++) await delay(5)
})

test('get_composition_run有界投影可完整解析并保留原结果与分页入口', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-workflow-summary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'mcp/.local/runs'), { recursive: true })
  const id = 'run-00000000-0000-4000-8000-000000000099'
  const items = Array.from({ length: 500 }, (_, i) => ({ id: i, status: i % 3 ? 'normal' : 'unknown', facts: { blob: 'x'.repeat(500) } }))
  const nodes = { root: { status: 'failed', result: { checks: { routine: { checks: { status: { items } } } } } }, ...Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`root/n${i}`, { status: i === 3 ? 'failed' : i < 3 ? 'running' : 'completed', result: { items } }])) }
  const original = {
    engine: 'workflow', run_id: id, composition_id: 'inspection-routine', workflow: 'inspection-routine', status: 'failed',
    created_at: '2026-11-11T11:30:24.502Z', started_at: '2026-11-11T11:30:24.585Z', finished_at: '2026-11-11T11:40:15.685Z',
    error: 'terminated', input: { scope: { all: true }, huge: 'h'.repeat(200_000) }, progress: { completed: 20, total: 108, huge: 'p'.repeat(100_000) }, metrics: { requests: 310, peak_concurrency: 8, huge: 'm'.repeat(100_000) },
    version: { versionId: 'v1', toolName: 'inspection_routine', definition: { huge: 'z'.repeat(200_000) }, implementationDigest: 'd'.repeat(64) },
    scope: { requested: { all: true }, count: 108, frozen_at: '2026-11-11T11:30:23.717Z', assetIds: Array.from({ length: 500 }, (_, i) => i + 1) },
    result: { huge: 'r'.repeat(100_000), checks: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`c${i}`, { status: 'unknown', items, nested: { huge: 'n'.repeat(100_000) } }])) },
    nodes, artifacts: [{ id: 'report', filename: 'inspection-report.html', contentType: 'text/html', body: 'x'.repeat(100_000) }],
    metrics: { requests: 310, peak_concurrency: 8, elapsed_ms: 592256 },
  }
  writeFileSync(join(root, 'mcp/.local/runs', id + '.json'), JSON.stringify(original))
  const store = workflowRuns(root), summary = store.summary(id)
  const encoded = JSON.stringify({ ok: true, result: summary })
  assert.doesNotThrow(() => JSON.parse(encoded))
  assert.ok(encoded.length < 200_000, 'bounded output size')
  assert.equal(summary.status, 'failed')
  assert.equal(summary.error, 'terminated')
  assert.equal(summary.scope.count, 108)
  assert.equal(summary.scope.assetIds.length, 200)
  assert.equal(summary.scope.assetIds_truncated, 300)
  assert.equal(summary.nodes_summary.total, 801)
  assert.ok(summary.nodes_summary.failed.includes('root/n3'))
  assert.equal(summary.nodes_summary.completed, 796)
  assert.equal(summary.result.checks_truncated, 100)
  assert.equal(summary.result.huge, undefined)
  assert.equal(summary.input.huge, undefined)
  assert.equal(summary.progress.huge, undefined)
  assert.equal(summary.metrics.huge, undefined)
  assert.equal(summary.result.checks.c0.nested, undefined)
  assert.ok(encoded.length <= 24 * 1024, 'summary budget')
  assert.equal(summary.artifacts[0].body, undefined)
  assert.equal(summary.version.definition, undefined)
  assert.equal(store.read(id).version.definition.huge.length, 200_000)
  assert.equal(store.details(id, 'root/n0', 0, 2).items.length, 2)
  assert.equal(store.artifact(id, 'report').body.length, 100_000)
})
