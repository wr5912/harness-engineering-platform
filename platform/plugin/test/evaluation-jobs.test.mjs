import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const plugin = new URL('../', import.meta.url).pathname
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const experiment = 'EXP-test-agent-001'
const source = `experiment:${experiment}`
const base = { source, cases: ['U-CASE-001'] }
const childPrefix = `const fs=require('node:fs'),path=require('node:path');
const runId=process.env.HARNESS_EVAL_RUN_ID;
const run=path.join(process.cwd(),'evolution/experiments/${experiment}/runs',runId);
fs.mkdirSync(run,{recursive:true});
const manifest={schema_version:'2.0',run_id:runId,experiment_id:'${experiment}',agent_id:'test-agent',status:'running',created_at:new Date().toISOString()};
fs.writeFileSync(path.join(run,'inputs.lock.json'),JSON.stringify({run_id:runId,source_id:'${source}',evaluation_cases:[{case_id:'U-CASE-001'}]}));
const finish=status=>{manifest.status=status;const temporary=path.join(run,'run.yaml.tmp');fs.writeFileSync(temporary,JSON.stringify(manifest));fs.renameSync(temporary,path.join(run,'run.yaml'));};
finish('running');
`
async function fixture(t, body = "finish('completed');console.log(JSON.stringify({run_id:runId}))", raw = false) {
  const root = mkdtempSync(join(tmpdir(), 'eval-runs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outfile = join(root, 'jobs.mjs')
  await build({ entryPoints: [join(plugin, 'src/evaluation/jobs.ts')], outfile, bundle: true, platform: 'node', format: 'esm' })
  const { createEvaluationJobs, EvaluationJobError } = await import(`file://${outfile}`)
  const script = join(root, 'dsh-eval')
  writeFileSync(script, (raw ? '' : childPrefix) + body)
  const options = { command: () => ({ executable: process.execPath, args: [script] }), environment: () => process.env, redact: text => text.replaceAll('secret-value', '[REDACTED]') }
  return { root, create: (overrides, assetRoot = root) => createEvaluationJobs(assetRoot, { ...options, ...overrides }), EvaluationJobError, script }
}
async function waitFor(fn, accept) {
  let value
  for (let count = 0; count < 150; count++) { value = fn(); if (accept(value)) return value; await delay(20) }
  assert.fail(JSON.stringify(value))
}
const accepted = async (jobs, payload = base) => jobs.start({ ...payload, run_id: jobs.reserve(payload).run_id })
const statePath = (root, id) => join(root, '.local/evaluation-jobs', `${id}.json`)
function seedLegacy(fx, extra = {}, id = randomUUID()) {
  const identity = { schemaVersion: 1, id: `workspace-${randomUUID()}`, legacyRoots: [] }
  if (!existsSync(join(fx.root, 'workspace.json'))) writeFileSync(join(fx.root, 'workspace.json'), JSON.stringify(identity))
  const workspace = JSON.parse(readFileSync(join(fx.root, 'workspace.json'), 'utf8'))
  const job = { job_id: id, workspace_id: workspace.id, asset_root: fx.root, source, cases: base.cases,
    status: 'failed', started_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z', stdout: '', stderr: '', pid: 2147483647, process_start: '1', exit_code: 2, ...extra }
  mkdirSync(join(fx.root, '.local/evaluation-jobs'), { recursive: true })
  writeFileSync(statePath(fx.root, id), JSON.stringify(job)); return job
}
function seedRun(fx, id, { status = 'completed', jobId, inputs = {} } = {}) {
  const run = join(fx.root, `evolution/experiments/${experiment}/runs`, id)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'run.yaml'), JSON.stringify({ schema_version: '2.0', run_id: id, experiment_id: experiment, agent_id: 'test-agent', status }))
  writeFileSync(join(run, 'inputs.lock.json'), JSON.stringify({ run_id: id, source_id: source, evaluation_cases: [{ case_id: 'U-CASE-001' }], ...inputs }))
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ ...(jobId ? { job_id: jobId } : { run_id: id }), instance_stopped: true }))
  return run
}

test('预览只预留唯一Run ID，查询可见准备状态，撤销后迟到start不会启动', async t => {
  const fx = await fixture(t), jobs = fx.create()
  const preview = jobs.reserve(base)
  assert.match(preview.run_id, /^run-[0-9a-f-]{36}$/)
  assert.equal(jobs.status(preview.run_id).status, 'prepared')
  assert.equal(existsSync(statePath(fx.root, preview.run_id)), false)
  assert.deepEqual(jobs.list(), { runs: [], pending: [], errors: [] })
  assert.equal(jobs.cancel(preview.run_id).status, 'cancelled')
  await assert.rejects(jobs.start({ ...base, run_id: preview.run_id }), error => error.code === 'creation_expired')
  assert.throws(() => jobs.status(preview.run_id), error => error.code === 'not_found')
})

test('同一Run并发与磁盘恢复仅启动一次，参数变化冲突，真正创建后返回成功', async t => {
  const fx = await fixture(t), jobs = fx.create()
  let commands = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const controlled = fx.create({ command: async () => { commands++; await gate; return { executable: process.execPath, args: [fx.script] } } })
  const payload = { ...base, run_id: controlled.reserve(base).run_id }
  const one = controlled.start(payload), two = controlled.start({ ...payload })
  await assert.rejects(controlled.start({ ...payload, mode: 'fast' }), error => error.code === 'conflict')
  assert.equal(controlled.status(payload.run_id).run_created, false)
  assert.equal(controlled.list().pending.length, 1)
  assert.equal(controlled.list().runs.length, 0)
  assert.deepEqual(controlled.list().errors, [], '正常准备观察不能被当作读取失败')
  release()
  const [a, b] = await Promise.all([one, two])
  assert.equal(a.run_id, payload.run_id); assert.equal(b.run_id, a.run_id); assert.equal(a.run_created, true)
  assert.equal(commands, 1); assert.equal('job_id' in a, false)
  await waitFor(() => controlled.status(a.run_id), value => value.exit_code === 0)
  const restored = fx.create({ command: () => assert.fail('恢复不得再次启动') })
  assert.equal((await restored.start(payload)).run_id, payload.run_id)
  await assert.rejects(restored.start({ ...payload, cases: ['U-OTHER'] }), error => error.code === 'conflict')
  const second = await accepted(jobs)
  assert.notEqual(second.run_id, a.run_id)
})

test('预留在工作区及服务实例之间隔离，重启后未受理ID必须重新预览', async t => {
  const a = await fixture(t), b = await fixture(t), jobs = a.create()
  const payload = { ...base, run_id: jobs.reserve(base).run_id }
  await assert.rejects(a.create().start(payload), error => error.code === 'creation_expired')
  await assert.rejects(b.create().start(payload), error => error.code === 'creation_expired')
  assert.equal(jobs.status(payload.run_id).status, 'prepared')
})

test('命令准备、spawn及创建前失败全部清理，旧ID不能重试启动', async t => {
  for (const kind of ['command', 'spawn', 'preflight']) await t.test(kind, async t => {
    const fx = await fixture(t, "console.error('前置校验未通过：来源无效');process.exit(2)", true)
    let cleanups = 0
    const jobs = fx.create({ command: () => { if (kind === 'command') throw new Error('来源准备失败'); return { executable: kind === 'spawn' ? '/no-such-evaluator' : process.execPath, args: [fx.script] } }, cleanup: () => { cleanups++ } })
    const payload = { ...base, run_id: jobs.reserve(base).run_id }
    await assert.rejects(jobs.start(payload))
    assert.equal(existsSync(statePath(fx.root, payload.run_id)), false)
    assert.equal(cleanups, 1)
    assert.deepEqual(jobs.list().runs, [])
    await assert.rejects(jobs.start(payload), error => error.code === 'creation_expired')
    assert.throws(() => jobs.status(payload.run_id), error => error.code === 'not_found')
  })
})

test('只删除本请求归属且进程已结束的初始化半成品', async t => {
  const body = `const fs=require('node:fs'),p=require('node:path');const id=process.env.HARNESS_EVAL_RUN_ID;
const folder=p.join(process.cwd(),'evolution/experiments/${experiment}/runs',id);fs.mkdirSync(folder,{recursive:true});
const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8');
fs.writeFileSync(p.join(folder,'.initialization.json'),JSON.stringify({schema_version:'1.0',run_id:id,asset_root:process.cwd(),workspace_id:null,pid:process.pid,process_start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],request_sha256:process.env.HARNESS_EVAL_REQUEST_SHA256}));process.exit(2);`
  const fx = await fixture(t, body, true), jobs = fx.create(), payload = { ...base, run_id: jobs.reserve(base).run_id }
  await assert.rejects(jobs.start(payload), error => error.code === 'creation_failed')
  assert.equal(existsSync(join(fx.root, `evolution/experiments/${experiment}/runs`, payload.run_id)), false)
  assert.equal(existsSync(statePath(fx.root, payload.run_id)), false)
})

test('无归属的半成品保留并报告未知，不能按创建失败删除', async t => {
  const fx = await fixture(t, `const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.join(process.cwd(),'evolution/experiments/${experiment}/runs',process.env.HARNESS_EVAL_RUN_ID),{recursive:true});process.exit(2);`, true)
  const jobs = fx.create(), payload = { ...base, run_id: jobs.reserve(base).run_id }
  await assert.rejects(jobs.start(payload))
  assert.equal(existsSync(statePath(fx.root, payload.run_id)), true)
  assert.equal(jobs.status(payload.run_id).status, 'unknown')
  assert.equal(jobs.list().pending.length, 1)
})

test('Run已commit而执行交接失败仍保留真实失败Run', async t => {
  const fx = await fixture(t, "finish('failed');console.error('执行归属写入失败');process.exit(2)")
  const jobs = fx.create(), result = await accepted(jobs)
  assert.equal(result.run_created, true)
  assert.equal(result.status, 'failed')
  await waitFor(() => jobs.status(result.run_id), value => value.exit_code === 2)
  assert.equal(existsSync(statePath(fx.root, result.run_id)), true)
  assert.equal(jobs.list().runs[0].run_id, result.run_id)
})

test('服务恢复从同一Run查询并取消原进程，Run证据持续保留', async t => {
  const fx = await fixture(t, "process.on('SIGTERM',()=>{finish('cancelled');console.log(JSON.stringify({run_id:runId,cancelled:true,instance_stopped:true}));process.exit(2)});console.error('ready');setInterval(()=>{},1000)")
  const original = fx.create(), result = await accepted(original)
  const restored = fx.create()
  assert.equal(restored.status(result.run_id).status, 'running')
  assert.equal(restored.cancel(result.run_id).status, 'cancelling')
  const end = await waitFor(() => restored.status(result.run_id), value => value.status === 'cancelled')
  assert.equal(end.run_id, result.run_id)
  assert.equal(end.run_created, true)
})

test('准备过程中可撤销，命令返回后不得再spawn', async t => {
  const fx = await fixture(t); let release
  const gate = new Promise(resolve => { release = resolve })
  const jobs = fx.create({ command: async () => { await gate; return { executable: process.execPath, args: [fx.script] } } })
  const payload = { ...base, run_id: jobs.reserve(base).run_id }, task = jobs.start(payload)
  assert.equal(jobs.cancel(payload.run_id).status, 'cancelling')
  assert.equal(jobs.list().pending[0].status, 'cancelling')
  assert.deepEqual(jobs.list().errors, [], '正常取消观察不能被当作读取失败')
  release(); await assert.rejects(task, error => error.code === 'creation_cancelled')
  assert.equal(existsSync(statePath(fx.root, payload.run_id)), false)
})

test('在途或PID归属不明不会被误判失败或清理，取消不向其他进程发送信号', async t => {
  const fx = await fixture(t), old = seedLegacy(fx, { status: 'running', pid: process.pid, process_start: 'wrong-start' })
  const jobs = fx.create()
  assert.equal(jobs.status(old.job_id).status, 'unknown')
  assert.throws(() => jobs.cancel(old.job_id), error => error.code === 'process_identity_unknown')
  assert.equal(existsSync(statePath(fx.root, old.job_id)), true)
  assert.equal(jobs.list().pending[0].legacy_id, old.job_id)
})

test('未经迁移的混合旧数据自动清理确定创建前失败，已有失败Run及坏记录互不影响', async t => {
  const fx = await fixture(t)
  const failed = seedLegacy(fx, { stderr: '前置校验未通过：来源校验失败' })
  const unknown = seedLegacy(fx, { stderr: '旧日志片段不足，阶段无法确认' })
  const completed = seedLegacy(fx, { status: 'completed', exit_code: 0 })
  const runId = `run-${randomUUID()}`, run = seedRun(fx, runId, { status: 'failed', jobId: completed.job_id })
  const before = readFileSync(join(run, 'run.yaml'))
  const badId = randomUUID(); writeFileSync(statePath(fx.root, badId), '{bad json')
  const future = `run-${randomUUID()}`; writeFileSync(statePath(fx.root, future), JSON.stringify({ schema_version: '3.0' }))
  const jobs = fx.create(), listed = jobs.list()
  assert.deepEqual(listed.runs.map(item => item.run_id), [runId])
  assert.equal(listed.runs[0].status, 'failed')
  assert.equal(listed.runs[0].agent_id, 'test-agent')
  assert.equal(existsSync(statePath(fx.root, failed.job_id)), false)
  assert.equal(existsSync(statePath(fx.root, unknown.job_id)), true)
  assert.equal(listed.errors.length, 3)
  assert.deepEqual(readFileSync(join(run, 'run.yaml')), before)
  assert.equal(jobs.status(runId).run_id, runId)
  assert.equal((await jobs.start({ ...base, request_id: completed.job_id })).run_id, runId)
  await assert.rejects(jobs.start({ ...base, request_id: failed.job_id }), error => error.code === 'protocol_changed')
})

test('旧失败没有Run编号但存在无法关联的已提交Run时不清理', async t => {
  const fx = await fixture(t), old = seedLegacy(fx, { stderr: '创建 Run 失败：执行关联无法写入' })
  const id = `run-${randomUUID()}`, run = seedRun(fx, id)
  rmSync(join(run, 'execution.json'))
  const jobs = fx.create(), listed = jobs.list()
  assert.equal(listed.runs.length, 0)
  assert.equal(listed.errors.length, 1)
  assert.equal(existsSync(statePath(fx.root, old.job_id)), true)
  assert.equal(jobs.status(id).run_id, id)
})

test('旧Run与独立CLI Run直接按真实RunID读取，不要求控制记录或数据升级', async t => {
  const fx = await fixture(t), id = `run-${randomUUID()}`, run = seedRun(fx, id)
  const before = readFileSync(join(run, 'run.yaml'))
  assert.equal(fx.create().status(id).run_id, id)
  assert.equal(existsSync(join(fx.root, '.local/evaluation-jobs')), false)
  assert.deepEqual(readFileSync(join(run, 'run.yaml')), before)
})

test('旧Run缺少冻结输入仍可读取关联，损坏输入则局部报错且不清理', async t => {
  const fx = await fixture(t), old = seedLegacy(fx, { status: 'completed', exit_code: 0 })
  const id = `run-${randomUUID()}`, run = seedRun(fx, id, { jobId: old.job_id })
  rmSync(join(run, 'inputs.lock.json'))
  const original = readFileSync(join(run, 'run.yaml'))
  const jobs = fx.create()
  assert.equal(jobs.status(old.job_id).run_id, id)
  assert.equal(jobs.status(old.job_id).frozen_inputs_available, false)
  assert.equal(jobs.status(id).run_id, id)
  assert.equal(jobs.list().runs[0].run_id, id)
  writeFileSync(join(run, 'inputs.lock.json'), '{invalid input')
  assert.throws(() => jobs.status(old.job_id))
  assert.equal(jobs.list().errors.length, 1)
  assert.equal(existsSync(statePath(fx.root, old.job_id)), true)
  assert.deepEqual(readFileSync(join(run, 'run.yaml')), original)
})

test('工作区迁移沿原声明读取旧关联，不接管同名其他根或改写历史来源', async t => {
  const fx = await fixture(t), old = seedLegacy(fx, { status: 'completed', exit_code: 0 })
  const id = `run-${randomUUID()}`; seedRun(fx, id, { jobId: old.job_id })
  const moved = fx.root + '-moved'; t.after(() => rmSync(moved, { recursive: true, force: true }))
  const oldBytes = readFileSync(statePath(fx.root, old.job_id))
  renameSync(fx.root, moved)
  assert.throws(() => fx.create({}, moved).status(old.job_id), error => error.code === 'not_found')
  const descriptor = JSON.parse(readFileSync(join(moved, 'workspace.json'), 'utf8'))
  writeFileSync(join(moved, 'workspace.json'), JSON.stringify({ ...descriptor, legacyRoots: [fx.root] }))
  const migrated = fx.create({}, moved)
  assert.equal(migrated.status(old.job_id).run_id, id)
  assert.deepEqual(readFileSync(statePath(moved, old.job_id)), oldBytes)
  const foreign = { ...JSON.parse(oldBytes), workspace_id: 'workspace-other' }
  writeFileSync(statePath(moved, old.job_id), JSON.stringify(foreign))
  assert.throws(() => migrated.status(old.job_id), error => error.code === 'not_found')
})

test('批量先核对全批预留，部分失败停止后续且旧编号不能整批重放', async t => {
  const fx = await fixture(t); let commands = 0
  const jobs = fx.create({ command: payload => { commands++; if (payload.mode === 'full') throw new Error('准备失败'); return { executable: process.execPath, args: [fx.script] } } })
  const payloads = ['fast', 'full', 'explicit'].map(mode => ({ ...base, mode, source_ref: `git:${'a'.repeat(40)}` }))
  const requests = payloads.map(payload => ({ ...payload, run_id: jobs.reserve(payload).run_id }))
  await assert.rejects(jobs.startBatch([requests[0], { ...requests[1], cases: ['new'] }]), error => error.code === 'conflict')
  assert.equal(commands, 0)
  const result = await jobs.startBatch(requests)
  assert.equal(result.runs.length, 1); assert.equal(result.failed.run_id, requests[1].run_id)
  assert.deepEqual(result.not_started, [requests[2].run_id]); assert.equal(commands, 2)
  await assert.rejects(jobs.start(requests[1]), error => error.code === 'creation_expired')
  await assert.rejects(jobs.start(requests[2]), error => error.code === 'creation_expired')
  assert.equal((await fx.create().start(requests[0])).run_id, requests[0].run_id)
})

test('跨handler等待创建撤销后停止等待，不重放已清理请求', async t => {
  const fx = await fixture(t); let commands = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const original = fx.create({ command: async () => { commands++; await gate; return { executable: process.execPath, args: [fx.script] } } })
  const payload = { ...base, run_id: original.reserve(base).run_id }
  const first = original.start(payload), second = fx.create({ command: () => assert.fail('接管查询不得启动') }).start(payload)
  const outcomes = Promise.allSettled([first, second])
  original.cancel(payload.run_id); release()
  const values = await outcomes
  assert.equal(commands, 1)
  assert.deepEqual(values.map(item => item.status), ['rejected', 'rejected'])
  assert.equal(values[1].reason.code, 'not_found')
})

test('已观察终止但清理曾失败的V2启动可在新handler安全收尾', async t => {
  const fx = await fixture(t, "console.error('前置校验未通过');process.exit(2)", true)
  const original = fx.create({ cleanup: () => { throw new Error('临时目录暂不可删除') } })
  const payload = { ...base, run_id: original.reserve(base).run_id }
  await assert.rejects(original.start(payload), error => error.code === 'cleanup_failed')
  const before = JSON.parse(readFileSync(statePath(fx.root, payload.run_id), 'utf8'))
  assert.equal(before.process_finished, true); assert.equal(before.status, 'unknown')
  const restored = fx.create()
  assert.throws(() => restored.status(payload.run_id), error => error.code === 'not_found')
  assert.equal(existsSync(statePath(fx.root, payload.run_id)), false)
})

test('接管已结束的自有初始化组可清理半成品，无终止依据的前置进程仅待核对', async t => {
  const fx = await fixture(t), jobs = fx.create(), prepared = jobs.reserve(base)
  const state = { schema_version: '2.0', run_id: prepared.run_id, source, workspace_id: 'placeholder', asset_root: fx.root,
    status: 'preparing', started_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:00Z',
    stdout: '', stderr: '', pid: 2147483647, process_start: '1', request_sha256: 'fixed-request' }
  writeFileSync(join(fx.root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-recovery', legacyRoots: [] }))
  state.workspace_id = 'workspace-recovery'
  const folder = join(fx.root, `evolution/experiments/${experiment}/runs`, state.run_id)
  mkdirSync(folder, { recursive: true }); mkdirSync(join(fx.root, '.local/evaluation-jobs'), { recursive: true })
  writeFileSync(join(folder, '.initialization.json'), JSON.stringify({ schema_version: '1.0', run_id: state.run_id,
    workspace_id: state.workspace_id, asset_root: fx.root, pid: 2147483647, process_start: '1', request_sha256: state.request_sha256 }))
  writeFileSync(statePath(fx.root, state.run_id), JSON.stringify(state))
  const restored = fx.create()
  assert.throws(() => restored.status(state.run_id), error => error.code === 'not_found')
  assert.equal(existsSync(folder), false)
  const unknown = { ...state, run_id: `run-${randomUUID()}` }
  writeFileSync(statePath(fx.root, unknown.run_id), JSON.stringify(unknown))
  assert.equal(restored.status(unknown.run_id).status, 'unknown')
  assert.equal(restored.list().pending[0].run_id, unknown.run_id)
  assert.equal(existsSync(statePath(fx.root, unknown.run_id)), true)
})

test('旧failed状态不能掩盖本根仍存活的评测进程，必须保留在途保护', async t => {
  const fx = await fixture(t, "console.log('ready');setInterval(()=>{},1000)", true)
  const proc = spawn(process.execPath, [fx.script], { cwd: fx.root, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  await new Promise((resolve, reject) => { proc.stdout.once('data', resolve); proc.once('error', reject) })
  const stat = readFileSync(`/proc/${proc.pid}/stat`, 'utf8')
  const old = seedLegacy(fx, { status: 'failed', pid: proc.pid, process_start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], stderr: '前置校验未通过' })
  const original = readFileSync(statePath(fx.root, old.job_id)), jobs = fx.create()
  assert.equal(jobs.status(old.job_id).status, 'unknown')
  assert.equal(jobs.list().pending[0].legacy_id, old.job_id)
  assert.deepEqual(readFileSync(statePath(fx.root, old.job_id)), original)
})

test('旧任务取消意图在同handler查询中保持，原状态文件不被改写', async t => {
  const fx = await fixture(t, "process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(process.env.TEST_RUN_MANIFEST,JSON.stringify({run_id:process.env.TEST_RUN_ID,status:'cancelled'}));process.exit(2)},120));console.log('ready');setInterval(()=>{},1000)", true)
  const id = `run-${randomUUID()}`, path = seedRun(fx, id, { status: 'running' })
  const proc = spawn(process.execPath, [fx.script], { cwd: fx.root, env: { ...process.env, TEST_RUN_MANIFEST: join(path, 'run.yaml'), TEST_RUN_ID: id }, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  await new Promise((resolve, reject) => { proc.stdout.once('data', resolve); proc.once('error', reject) })
  const stat = readFileSync(`/proc/${proc.pid}/stat`, 'utf8')
  const old = seedLegacy(fx, { status: 'running', pid: proc.pid, process_start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], exit_code: undefined, run_id: id })
  writeFileSync(join(path, 'execution.json'), JSON.stringify({ job_id: old.job_id }))
  const original = readFileSync(statePath(fx.root, old.job_id)), jobs = fx.create()
  assert.equal(jobs.cancel(id).status, 'cancelling')
  assert.equal(jobs.status(id).status, 'cancelling')
  assert.equal(jobs.status(old.job_id).status, 'cancelling')
  await waitFor(() => jobs.status(old.job_id), value => value.status === 'cancelled')
  assert.deepEqual(readFileSync(statePath(fx.root, old.job_id)), original)
})

test('清理期间状态发生变化时不删除或覆盖并行更新', async t => {
  const fx = await fixture(t)
  const item = seedLegacy(fx, { stderr: '前置校验未通过' }), file = statePath(fx.root, item.job_id)
  const jobs = fx.create({ cleanup: () => { writeFileSync(file, JSON.stringify({ ...item, stderr: '并行写入新观察' })) } })
  assert.equal(jobs.list().runs.length, 0)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).stderr, '并行写入新观察')
})

test('模型凭据拆块或短字符串时不污染运行日志或机器回执', async t => {
  const secret = '8f327eafc0032b13642dd1ab938104'
  const fx = await fixture(t, `process.stderr.write(process.env.MODEL_TOKEN.slice(0,12));setTimeout(()=>{process.stderr.write(process.env.MODEL_TOKEN.slice(12)+'\\n');finish('cancelled');console.log(JSON.stringify({run_id:runId,cancelled:true,instance_stopped:true,cases:{total:1},credential:process.env.MODEL_API_KEY,nested:[{API_KEY:'hidden-value'}]}));process.exit(2)},50)`)
  const jobs = fx.create({ command: () => ({ executable: process.execPath, args: [fx.script], environment: { MODEL_TOKEN: secret, MODEL_API_KEY: '1' } }) })
  const result = await accepted(jobs)
  const finished = await waitFor(() => jobs.status(result.run_id), value => value.exit_code === 2)
  assert.equal(finished.result.run_id, result.run_id); assert.equal(JSON.parse(finished.stdout).cases.total, 1); assert.deepEqual(finished.result.cases, base.cases)
  assert.equal(finished.result.credential, '[REDACTED]'); assert.equal(finished.result.nested[0].API_KEY, '[REDACTED]')
  const persisted = readFileSync(statePath(fx.root, result.run_id), 'utf8')
  assert.equal(persisted.includes(secret), false); assert.equal(persisted.includes(secret.slice(0, 12)), false)
})

const localRoute = { provider: 'security-operation-delivery', model: 'fixed-operation-result' }
const remoteRoute = { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-flash' }
const capabilityContent = routes => JSON.stringify({ runtime_capabilities: { local_tools: [], local_model_routes: routes } })
async function measurementRun(t, { marker = true, legacy = false, declared = true, content = capabilityContent([localRoute]),
  localProof = { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } } = {}) {
  const fx = await fixture(t), saved = seedLegacy(fx, { status: 'completed', exit_code: 0 })
  const run = seedRun(fx, `run-${randomUUID()}`, { jobId: saved.job_id })
  const evidence = join(run, 'evidence/U-CASE-001'), snapshot = join(run, 'evidence/managed/role-tool-matrix.yaml')
  const harness = join(run, 'evidence/analysis/harness.json'), lock = join(run, 'inputs.lock.json')
  mkdirSync(evidence, { recursive: true }); mkdirSync(join(run, 'evidence/managed')); mkdirSync(join(run, 'evidence/analysis'))
  writeFileSync(join(run, 'run.yaml'), 'status: completed\n')
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ job_id: saved.job_id }))
  const sha256 = createHash('sha256').update(content).digest('hex')
  const inputs = { source_id: 'experiment:EXP-test-agent-001', evaluation_cases: [{ case_id: 'U-CASE-001' }],
    harness_trees: { managed: { files: declared ? [{ path: 'role-tool-matrix.yaml', sha256, size: Buffer.byteLength(content) }] : [] } },
    ...(marker ? { managed_role_snapshot: 'evidence/managed/role-tool-matrix.yaml' } : {}) }
  writeFileSync(lock, JSON.stringify(inputs))
  if (declared && marker) writeFileSync(snapshot, content)
  if (legacy) writeFileSync(harness, JSON.stringify({ files: [{ tree: 'managed', path: 'role-tool-matrix.yaml', sha256, content }] }))
  const events = [{ type: 'session', id: 'actual-session' }]
  let seq = 0
  for (const [index, route] of [localRoute, remoteRoute].entries()) {
    const turn = index + 1
    for (const [type, data] of [['turn/start', { turn }], ['step/start', { turn, step: 1 }],
      ['request/header', { header: { config: route } }], ['assistant/message', { turn, step: 1,
        ...(index === 0 ? localProof : { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }) }],
      ['step/end', { turn, step: 1 }], ['turn/end', { turn }]]) events.push({ type, seq: seq++, data })
  }
  writeFileSync(join(evidence, 'trace.jsonl'), events.map(event => JSON.stringify({ session_log: 'session.v4.jsonl', event })).join('\n') + '\n')
  return { ...fx, run, snapshot, harness, lock, content, inputs, status: () => fx.create().status(saved.job_id) }
}

test('新旧Run核对锁定注册声明但仍计代理真实推理，不读取当前Candidate', async t => {
  for (const legacy of [false, true]) {
    const fx = await measurementRun(t, { marker: !legacy, legacy })
    const current = join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh/managed')
    mkdirSync(current, { recursive: true }); writeFileSync(join(current, 'role-tool-matrix.yaml'), capabilityContent([remoteRoute]))
    const beforeLock = readFileSync(fx.lock)
    const status = fx.status()
    assert.equal(status.local_model_routes_verification, 'verified')
    assert.equal(status.actual_model_calls, 2)
    assert.equal(status.observed_model_calls, 2)
    assert.deepEqual(status.token_usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 })
    assert.deepEqual(readFileSync(fx.lock), beforeLock, '查询不能改写旧Run')
  }
  const noDeclaration = await measurementRun(t, { marker: false, declared: false })
  assert.equal(noDeclaration.status().actual_model_calls, 2, '锁中确无声明不凭provider名字排除')
  const none = await measurementRun(t, { localProof: { model_invocation: false } })
  assert.equal(none.status().actual_model_calls, 1, '明确无调用与注册身份区分')
  const unknown = await measurementRun(t, { localProof: {} })
  assert.equal(unknown.status().actual_model_calls, null)
  assert.equal(unknown.status().observed_model_calls, 1)
})

test('新快照缺损不降级legacy，旧声明无可信原文时调用与用量下界保持未知', async t => {
  const invalid = [
    ['missing-snapshot', {}, fx => rmSync(fx.snapshot)],
    ['changed-snapshot', {}, fx => writeFileSync(fx.snapshot, fx.content + ' ')],
    ['snapshot-symlink', {}, fx => { const original = fx.snapshot + '.original'; renameSync(fx.snapshot, original); symlinkSync(original, fx.snapshot) }],
    ['parent-symlink', {}, fx => { const folder = join(fx.run, 'evidence/managed'), original = folder + '.original'; renameSync(folder, original); symlinkSync(original, folder) }],
    ['wrong-pointer', {}, fx => { fx.inputs.managed_role_snapshot = '../candidate/role-tool-matrix.yaml'; writeFileSync(fx.lock, JSON.stringify(fx.inputs)) }],
    ['invalid-capabilities', { content: JSON.stringify({ runtime_capabilities: { local_model_routes: [localRoute] } }) }, () => {}],
    ['missing-legacy', { marker: false, legacy: false }, () => {}],
    ['changed-legacy', { marker: false }, fx => { const value = JSON.parse(readFileSync(fx.harness, 'utf8')); value.files[0].content += ' '; writeFileSync(fx.harness, JSON.stringify(value)) }],
    ['legacy-symlink', { marker: false }, fx => { const original = fx.harness + '.original'; renameSync(fx.harness, original); symlinkSync(original, fx.harness) }],
    ['missing-lock', {}, fx => { delete fx.inputs.harness_trees; writeFileSync(fx.lock, JSON.stringify(fx.inputs)) }],
  ]
  for (const [name, options, mutate] of invalid) await t.test(name, async t => {
    const fx = await measurementRun(t, { legacy: true, ...options })
    mutate(fx)
    const status = fx.status()
    assert.equal(status.local_model_routes_verification, 'unverified')
    assert.equal(status.actual_model_calls, null)
    assert.equal(status.observed_model_calls, null)
    assert.equal(status.failed_model_calls, null)
    assert.equal(status.observed_token_usage, null)
    assert.equal(status.token_usage, null)
    assert.equal(status.model_calls_complete, false)
    assert.ok(status.model_calls_unknown_reasons.some(reason => reason.startsWith('local-model-routes-')))
    assert.match(status.model_calls_basis, /声明尚未核对/)
  })
})
