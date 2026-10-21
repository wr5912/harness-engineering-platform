import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const plugin = new URL('../', import.meta.url).pathname
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'eval-jobs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outfile = join(root, 'jobs.mjs')
  await build({ entryPoints: [join(plugin, 'src/evaluation/jobs.ts')], outfile, bundle: true, platform: 'node', format: 'esm' })
  const { createEvaluationJobs, EvaluationJobError } = await import(`file://${outfile}`)
  const script = join(root, 'dsh-eval')
  writeFileSync(script, body)
  const options = { command: () => ({ executable: process.execPath, args: [script] }),
    environment: () => process.env, redact: text => text.replaceAll('secret-value', '[REDACTED]') }
  return { root, create: () => createEvaluationJobs(root, options), EvaluationJobError }
}

async function waitFor(fn, accept) {
  let value
  for (let count = 0; count < 100; count++) {
    value = fn()
    if (accept(value)) return value
    await delay(20)
  }
  assert.fail(JSON.stringify(value))
}

test('新建管理器从磁盘查询并取消同一评测进程，回执继续保留', async t => {
  const fx = await fixture(t, [
    "process.on('SIGTERM',()=>{console.log(JSON.stringify({cancelled:true,instance_stopped:true}));process.exit(2)})",
    "console.error('ready')", 'setInterval(()=>{},1000)',
  ].join('\n'))
  const before = fx.create()
  const started = before.start({ source: 'experiment:EXP-test-agent-001', cases: ['U-CASE-001'] })
  await waitFor(() => before.status(started.job_id), job => job.stderr.includes('ready'))
  const restored = fx.create()
  assert.equal(restored.status(started.job_id).status, 'running')
  assert.deepEqual(restored.list().map(job => job.job_id), [started.job_id])
  assert.equal(restored.cancel(started.job_id).status, 'cancelling')
  const final = await waitFor(() => restored.status(started.job_id), job => job.status === 'cancelled')
  assert.equal(final.result.instance_stopped, true)
  assert.equal(final.actual_model_calls, null)
  assert.equal(final.hard_cap_supported, false)
})

test('业务未通过的已结束 Run 保持 completed 执行状态，列表可从磁盘恢复', async t => {
  const fx = await fixture(t, 'console.log(JSON.stringify({run_id:process.env.TEST_RUN_ID}));process.exit(1)')
  const operation = randomUUID()
  const runId = `run-${randomUUID()}`
  const run = join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs', runId)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ job_id: operation, instance_stopped: true }))
  writeFileSync(join(run, 'run.yaml'), 'status: completed\n')
  writeFileSync(join(run, 'inputs.lock.json'), JSON.stringify({ source_id: 'experiment:EXP-test-agent-001', evaluation_cases: [] }))
  writeFileSync(join(run, 'summary.json'), JSON.stringify({ effective_verdict: 'failed' }))
  const previous = process.env.TEST_RUN_ID
  process.env.TEST_RUN_ID = runId
  t.after(() => { if (previous === undefined) delete process.env.TEST_RUN_ID; else process.env.TEST_RUN_ID = previous })
  const jobs = fx.create()
  jobs.start({ source: 'experiment:EXP-test-agent-001', task_budget: { operation_id: operation } })
  const finished = await waitFor(() => fx.create().status(operation), job => job.exit_code === 1)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.summary.effective_verdict, 'failed')
  assert.equal(fx.create().list()[0].status, 'completed')
  assert.equal(fx.create().list()[0].run_id, runId)
})

test('过时 PID 的取消拒绝向当前进程发信号', async t => {
  const fx = await fixture(t, '')
  const jobs = fx.create()
  const started = jobs.start({ source: 'experiment:EXP-test-agent-001' })
  const final = await waitFor(() => jobs.status(started.job_id), job => job.status === 'completed')
  const path = join(fx.root, '.local/evaluation-jobs', `${started.job_id}.json`)
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  Object.assign(stored, { status: 'running', pid: process.pid, process_start: 'not-this-process' })
  writeFileSync(path, JSON.stringify(stored))
  const restored = fx.create()
  assert.throws(() => restored.cancel(started.job_id), error => error.code === 'process_identity_unknown')
  assert.equal(restored.status(started.job_id).status, 'failed')
  assert.equal(final.hard_cap_supported, false)
})

test('同一持久操作 ID 重试只查询原 Job，不重复启动；改来源拒绝复用', async t => {
  const fx = await fixture(t, "console.error('started-once');setTimeout(()=>process.exit(0),100)")
  const jobs = fx.create()
  const operation = randomUUID()
  const payload = { source: 'experiment:EXP-test-agent-001', cases: ['U-CASE-001'], task_budget: { operation_id: operation } }
  const first = jobs.start(payload)
  const repeated = jobs.start(payload)
  assert.equal(first.job_id, operation)
  assert.equal(repeated.job_id, first.job_id)
  const final = await waitFor(() => jobs.status(first.job_id), job => job.status === 'completed')
  assert.equal((final.stderr.match(/started-once/g) ?? []).length, 1)
  assert.equal(fx.create().start(payload).job_id, operation)
  assert.throws(() => fx.create().start({ ...payload, source: 'experiment:EXP-other-agent-001' }), error => error.code === 'conflict')
})

test('截止时间传入执行环境并触发取消，重建管理器不重置期限', async t => {
  const fx = await fixture(t, [
    "process.on('SIGTERM',()=>{console.log(JSON.stringify({cancelled:true,instance_stopped:true}));process.exit(2)})",
    "console.error(process.env.HARNESS_EVAL_DEADLINE_AT)", 'setInterval(()=>{},1000)',
  ].join('\n'))
  const jobs = fx.create()
  const deadline = new Date(Date.now() + 300).toISOString()
  const started = jobs.start({ source: 'experiment:EXP-test-agent-001', task_budget: { deadline_at: deadline } })
  const final = await waitFor(() => fx.create().status(started.job_id), job => job.status === 'cancelled')
  assert.match(final.stderr, new RegExp(deadline.replaceAll('.', '\\.')))
})

test('未捕获 stdout 的 Job 从已有 Run 恢复固定来源、Session 和产物结论', async t => {
  const fx = await fixture(t, '')
  const jobs = fx.create()
  const started = jobs.start({ source: 'experiment:EXP-test-agent-001' })
  await waitFor(() => jobs.status(started.job_id), job => job.status === 'completed')
  const jobPath = join(fx.root, '.local/evaluation-jobs', `${started.job_id}.json`)
  const stored = JSON.parse(readFileSync(jobPath, 'utf8'))
  Object.assign(stored, { status: 'running', stdout: '', result: null, run_id: undefined })
  writeFileSync(jobPath, JSON.stringify(stored))
  const runId = `run-${randomUUID()}`
  const run = join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs', runId)
  const evidence = join(run, 'evidence/U-CASE-001')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ job_id: started.job_id, instance_name: 'eval-owned', instance_stopped: true }))
  writeFileSync(join(run, 'run.yaml'), 'status: completed\n')
  writeFileSync(join(run, 'inputs.lock.json'), JSON.stringify({ source_id: 'experiment:EXP-test-agent-001', candidate_sha256: 'fixed-candidate',
    program_origin: { commit: 'fixed-program' }, evaluation_sha256: 'fixed-cases', evaluation_cases: [{ case_id: 'U-CASE-001' }] }))
  writeFileSync(join(run, 'summary.json'), JSON.stringify({ overall_verdict: 'passed' }))
  writeFileSync(join(evidence, 'checks.json'), JSON.stringify({ session_id: 'existing-session', trace_available: true }))
  writeFileSync(join(evidence, 'trace.jsonl'), JSON.stringify({ event: { type: 'request/header' } }) + '\n')
  const restored = fx.create().status(started.job_id)
  assert.equal(restored.status, 'completed')
  assert.equal(restored.run_id, runId)
  assert.equal(restored.candidate_sha256, 'fixed-candidate')
  assert.deepEqual(restored.sessions, ['existing-session'])
  assert.equal(restored.actual_model_calls, null)
})
