import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  return { root, create: (overrides, assetRoot = root) => createEvaluationJobs(assetRoot, { ...options, ...overrides }), EvaluationJobError, script }
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
  const started = await before.start({ source: 'experiment:EXP-test-agent-001', cases: ['U-CASE-001'] })
  await waitFor(() => before.status(started.job_id), job => job.stderr.includes('ready'))
  const restored = fx.create()
  assert.equal(restored.status(started.job_id).status, 'running')
  assert.deepEqual(restored.list().map(job => job.job_id), [started.job_id])
  assert.equal(restored.cancel(started.job_id).status, 'cancelling')
  const final = await waitFor(() => restored.status(started.job_id), job => job.status === 'cancelled')
  assert.equal(final.result.instance_stopped, true)
  assert.equal(final.actual_model_calls, null)
})

test('工作区迁移后读取历史评测及 Run，不改写来源', async t => {
  const fx = await fixture(t, '')
  const identity = { schemaVersion: 1, id: `workspace-${randomUUID()}`, legacyRoots: [] }
  writeFileSync(join(fx.root, 'workspace.json'), JSON.stringify(identity))
  const jobs = fx.create()
  const payload = { source: 'experiment:EXP-test-agent-001', cases: ['U-CASE-001'] }
  const started = await jobs.start(payload)
  await waitFor(() => jobs.status(started.job_id), job => job.status === 'completed')
  const runId = `run-${randomUUID()}`
  const run = join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs', runId)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ job_id: started.job_id }))
  writeFileSync(join(run, 'run.yaml'), 'status: completed\n')
  writeFileSync(join(run, 'inputs.lock.json'), JSON.stringify({ source_id: payload.source, evaluation_cases: [{ case_id: 'U-CASE-001' }] }))
  const moved = `${fx.root}-moved`
  t.after(() => rmSync(moved, { recursive: true, force: true }))
  renameSync(fx.root, moved)
  const descriptor = join(moved, 'workspace.json')
  const noSpawn = { command: () => assert.fail('历史任务重试不得启动新进程') }
  assert.throws(() => fx.create(noSpawn, moved).status(started.job_id), error => error.code === 'not_found')
  writeFileSync(descriptor, JSON.stringify({ ...identity, legacyRoots: [fx.root] }))
  const restored = fx.create(noSpawn, moved)
  assert.deepEqual(restored.list().map(job => job.job_id), [started.job_id])
  const retried = restored.status(started.job_id)
  assert.equal(retried.run_id, runId)
  assert.equal(retried.asset_root, fx.root)
  assert.equal(retried.status, 'completed')
  assert.deepEqual(retried.cases, payload.cases)
  const path = join(moved, '.local/evaluation-jobs', `${started.job_id}.json`)
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(stored.asset_root, fx.root)
  for (const foreign of [
    { ...stored, workspace_id: `workspace-${randomUUID()}` },
    { ...stored, asset_root: `${fx.root}-other-clone` },
    { ...stored, job_id: randomUUID() },
  ]) {
    writeFileSync(path, JSON.stringify(foreign))
    assert.throws(() => restored.status(started.job_id), error => error.code === 'not_found')
    assert.throws(() => restored.cancel(started.job_id), error => error.code === 'not_found')
  }
})

test('目录迁移后按当前目录确认并取消评测进程，不使用旧路径中的同名克隆', async t => {
  const fx = await fixture(t, "process.on('SIGTERM',()=>process.exit(2));console.log('ready');setInterval(()=>{},1000)")
  const identity = { schemaVersion: 1, id: `workspace-${randomUUID()}`, legacyRoots: [fx.root] }
  writeFileSync(join(fx.root, 'workspace.json'), JSON.stringify(identity))
  const proc = spawn(process.execPath, [fx.script], { cwd: fx.root, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  await new Promise((resolve, reject) => { proc.stdout.once('data', resolve); proc.once('error', reject) })
  const stat = readFileSync(`/proc/${proc.pid}/stat`, 'utf8')
  const id = randomUUID(), now = new Date().toISOString()
  const directory = join(fx.root, '.local/evaluation-jobs')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({ job_id: id, workspace_id: identity.id, asset_root: fx.root,
    source: 'experiment:EXP-test-agent-001', status: 'running', started_at: now, updated_at: now, stdout: '', stderr: '',
    pid: proc.pid, process_start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }))
  const moved = `${fx.root}-moved`
  t.after(() => rmSync(moved, { recursive: true, force: true }))
  renameSync(fx.root, moved)
  mkdirSync(fx.root)
  writeFileSync(join(fx.root, 'workspace.json'), JSON.stringify(identity))
  const restored = fx.create({}, moved)
  assert.equal(restored.status(id).status, 'running')
  assert.equal(restored.status(id).asset_root, fx.root)
  const path = join(moved, '.local/evaluation-jobs', `${id}.json`)
  const stored = readFileSync(path, 'utf8')
  writeFileSync(fx.script, readFileSync(join(moved, 'dsh-eval')))
  const other = spawn(process.execPath, [fx.script], { cwd: fx.root, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (other.exitCode === null) other.kill('SIGKILL') })
  await new Promise((resolve, reject) => { other.stdout.once('data', resolve); other.once('error', reject) })
  const otherStat = readFileSync(`/proc/${other.pid}/stat`, 'utf8')
  writeFileSync(path, JSON.stringify({ ...JSON.parse(stored), pid: other.pid,
    process_start: otherStat.slice(otherStat.lastIndexOf(')') + 2).split(' ')[19] }))
  assert.throws(() => restored.cancel(id), error => error.code === 'process_identity_unknown')
  assert.equal(other.exitCode, null)
  const otherExited = new Promise(resolve => other.once('exit', resolve))
  other.kill('SIGTERM')
  assert.equal(await otherExited, 2)
  writeFileSync(path, stored)
  const exited = new Promise(resolve => proc.once('exit', resolve))
  assert.equal(restored.cancel(id).status, 'cancelling')
  assert.equal(await exited, 2)
  assert.equal(JSON.parse(readFileSync(join(moved, '.local/evaluation-jobs', `${id}.json`), 'utf8')).asset_root, fx.root)
})

test('模型凭据拆成多个输出块时，运行中与完成后的 Job 日志均不保留片段', async t => {
  const secret = 'credential-fragment-938104'
  const fx = await fixture(t, [
    "process.stderr.write('started\\n')",
    'process.stderr.write(process.env.MODEL_API_KEY.slice(0, 12))',
    'setTimeout(()=>{process.stderr.write(process.env.MODEL_API_KEY.slice(12));process.stderr.write("\\n");process.stderr.write(process.env.MODEL_API_KEY.slice(0,12)+"\\n");process.stdout.write(process.env.MODEL_API_KEY.slice(0,12)+"\\n");setTimeout(()=>process.exit(0),50)},100)',
  ].join('\n'))
  const jobs = fx.create({ command: () => ({ executable: process.execPath, args: [fx.script], environment: { MODEL_API_KEY: secret } }) })
  const started = await jobs.start({ source: 'experiment:EXP-test-agent-001' })
  const running = await waitFor(() => jobs.status(started.job_id), job => job.stderr.includes('started'))
  assert.equal(running.stderr.includes(secret.slice(0, 12)), false)
  const finished = await waitFor(() => jobs.status(started.job_id), job => job.status === 'completed')
  assert.equal(finished.stderr.includes(secret), false)
  assert.equal(finished.stderr.includes(secret.slice(0, 12)), false)
  assert.equal(finished.stdout.includes(secret.slice(0, 12)), false)
  assert.match(finished.stderr, /\[REDACTED\]/)
  const persisted = readFileSync(join(fx.root, '.local/evaluation-jobs', `${started.job_id}.json`), 'utf8')
  assert.equal(persisted.includes(secret.slice(0, 12)), false)
})

test('业务未通过的已结束 Run 保持 completed 执行状态，列表可从磁盘恢复', async t => {
  const fx = await fixture(t, 'console.log(JSON.stringify({run_id:process.env.TEST_RUN_ID}));process.exit(1)')
  const runId = `run-${randomUUID()}`
  const run = join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs', runId)
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ instance_stopped: true }))
  writeFileSync(join(run, 'run.yaml'), 'status: completed\n')
  writeFileSync(join(run, 'inputs.lock.json'), JSON.stringify({ source_id: 'experiment:EXP-test-agent-001', evaluation_cases: [] }))
  writeFileSync(join(run, 'summary.json'), JSON.stringify({ effective_verdict: 'failed' }))
  const previous = process.env.TEST_RUN_ID
  process.env.TEST_RUN_ID = runId
  t.after(() => { if (previous === undefined) delete process.env.TEST_RUN_ID; else process.env.TEST_RUN_ID = previous })
  const jobs = fx.create()
  const started = await jobs.start({ source: 'experiment:EXP-test-agent-001' })
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ job_id: started.job_id, instance_stopped: true }))
  const finished = await waitFor(() => fx.create().status(started.job_id), job => job.exit_code === 1)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.summary.effective_verdict, 'failed')
  assert.equal(fx.create().list()[0].status, 'completed')
  assert.equal(fx.create().list()[0].run_id, runId)
})

test('过时 PID 的取消拒绝向当前进程发信号', async t => {
  const fx = await fixture(t, '')
  const jobs = fx.create()
  const started = await jobs.start({ source: 'experiment:EXP-test-agent-001' })
  const final = await waitFor(() => jobs.status(started.job_id), job => job.status === 'completed')
  const path = join(fx.root, '.local/evaluation-jobs', `${started.job_id}.json`)
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  Object.assign(stored, { status: 'running', pid: process.pid, process_start: 'not-this-process' })
  writeFileSync(path, JSON.stringify(stored))
  const restored = fx.create()
  assert.throws(() => restored.cancel(started.job_id), error => error.code === 'process_identity_unknown')
  assert.equal(restored.status(started.job_id).status, 'failed')
})

test('未捕获 stdout 的 Job 从已有 Run 恢复固定来源、Session 和产物结论', async t => {
  const fx = await fixture(t, '')
  const jobs = fx.create()
  const started = await jobs.start({ source: 'experiment:EXP-test-agent-001' })
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

test('历史交付截止时间不再取消评测，手动取消仍有效', async t => {
  const fx = await fixture(t, ["process.on('SIGTERM',()=>{console.log(JSON.stringify({cancelled:true,instance_stopped:true}));process.exit(2)})", "console.error('ready')", 'setInterval(()=>{},1000)'].join('\n'))
  const jobs = fx.create()
  const started = await jobs.start({ source: 'experiment:EXP-test-agent-001', cases: ['U-CASE-001'] })
  await waitFor(() => jobs.status(started.job_id), job => job.stderr.includes('ready'))
  const file = join(fx.root, '.local/evaluation-jobs', `${started.job_id}.json`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...saved, deadline_at: '2020-01-01T00:00:00Z' }))
  const restored = fx.create()
  assert.equal(restored.status(started.job_id).status, 'running')
  assert.equal(restored.cancel(started.job_id).status, 'cancelling')
  await waitFor(() => restored.status(started.job_id), job => job.status === 'cancelled')
})

test('同一请求并发与磁盘恢复只启动一次，改参数被拒绝，明确新请求可独立运行', async t => {
  const fx = await fixture(t, 'console.log("done")')
  let commands = 0, ready
  const gate = new Promise(resolve => { ready = resolve })
  const jobs = fx.create({ command: async () => { commands++; await gate; return { executable: process.execPath, args: [fx.script] } } })
  const payload = { request_id: randomUUID(), source: 'experiment:EXP-test-agent-001', cases: ['U-CASE-001'], mode: 'full' }
  const one = jobs.start(payload), duplicate = jobs.start({ ...payload })
  await assert.rejects(jobs.start({ ...payload, mode: 'fast' }), error => error.code === 'conflict')
  ready()
  const [first, second] = await Promise.all([one, duplicate])
  assert.equal(first.job_id, payload.request_id)
  assert.equal(second.job_id, first.job_id)
  assert.equal(commands, 1)
  await waitFor(() => jobs.status(first.job_id), job => job.status === 'completed')
  const recovered = await fx.create().start({ mode: payload.mode, cases: payload.cases, source: payload.source, request_id: payload.request_id })
  assert.equal(recovered.job_id, first.job_id)
  assert.equal(recovered.status, 'completed')
  await assert.rejects(fx.create().start({ ...payload, cases: ['U-CASE-002'] }), error => error.code === 'conflict')
  const fresh = await jobs.start({ ...payload, request_id: randomUUID() })
  assert.notEqual(fresh.job_id, first.job_id)
  assert.equal(commands, 2)
  await waitFor(() => jobs.status(fresh.job_id), job => job.status === 'completed')
})

test('受理前准备失败允许同一请求重试且没有残留任务', async t => {
  const fx = await fixture(t, '')
  let fail = true
  const jobs = fx.create({ command: () => {
    if (fail) throw new Error('来源尚未就绪')
    return { executable: process.execPath, args: [fx.script] }
  } })
  const payload = { request_id: randomUUID(), source: 'experiment:EXP-test-agent-001' }
  await assert.rejects(jobs.start(payload), /来源尚未就绪/)
  assert.deepEqual(jobs.list(), [])
  fail = false
  const accepted = await jobs.start(payload)
  assert.equal(accepted.job_id, payload.request_id)
  await waitFor(() => jobs.status(accepted.job_id), job => job.status === 'completed')
})

const localRoute = { provider: 'security-operation-delivery', model: 'fixed-operation-result' }
const remoteRoute = { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-flash' }
const capabilityContent = routes => JSON.stringify({ runtime_capabilities: { local_tools: [], local_model_routes: routes } })
async function measurementRun(t, { marker = true, legacy = false, declared = true, content = capabilityContent([localRoute]) } = {}) {
  const fx = await fixture(t, '')
  const jobs = fx.create(), started = await jobs.start({ source: 'experiment:EXP-test-agent-001' })
  await waitFor(() => jobs.status(started.job_id), job => job.status === 'completed')
  const run = join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs', `run-${randomUUID()}`)
  const evidence = join(run, 'evidence/U-CASE-001'), snapshot = join(run, 'evidence/managed/role-tool-matrix.yaml')
  const harness = join(run, 'evidence/analysis/harness.json'), lock = join(run, 'inputs.lock.json')
  mkdirSync(evidence, { recursive: true }); mkdirSync(join(run, 'evidence/managed')); mkdirSync(join(run, 'evidence/analysis'))
  writeFileSync(join(run, 'run.yaml'), 'status: completed\n')
  writeFileSync(join(run, 'execution.json'), JSON.stringify({ job_id: started.job_id }))
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
      ['request/header', { header: { config: route } }], ['assistant/message', { turn, step: 1, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }],
      ['step/end', { turn, step: 1 }], ['turn/end', { turn }]]) events.push({ type, seq: seq++, data })
  }
  writeFileSync(join(evidence, 'trace.jsonl'), events.map(event => JSON.stringify({ session_log: 'session.v4.jsonl', event })).join('\n') + '\n')
  return { ...fx, run, snapshot, harness, lock, content, inputs, status: () => fx.create().status(started.job_id) }
}

test('新Run按锁定普通快照排除纯本地请求，旧Run仅用同SHA原文，不读取当前Candidate', async t => {
  for (const legacy of [false, true]) {
    const fx = await measurementRun(t, { marker: !legacy, legacy })
    const current = join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh/managed')
    mkdirSync(current, { recursive: true }); writeFileSync(join(current, 'role-tool-matrix.yaml'), capabilityContent([remoteRoute]))
    const beforeLock = readFileSync(fx.lock)
    const status = fx.status()
    assert.equal(status.local_model_routes_verification, 'verified')
    assert.equal(status.actual_model_calls, 1)
    assert.equal(status.observed_model_calls, 1)
    assert.deepEqual(status.token_usage, { input_tokens: 5, output_tokens: 2, total_tokens: 7 })
    assert.deepEqual(readFileSync(fx.lock), beforeLock, '查询不能改写旧Run')
  }
  const noDeclaration = await measurementRun(t, { marker: false, declared: false })
  assert.equal(noDeclaration.status().actual_model_calls, 2, '锁中确无声明不凭provider名字排除')
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
