import { VERSION_ID } from '../version-id.ts'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { workspaceIdentity, workspaceLocalPath, workspaceOwnsCwd } from '../workspace.ts'
import { measureRunModelUsage, type UsageTrace } from './model-usage.ts'

type MapValue = Record<string, any>
type Job = {
  job_id: string; workspace_id: string; asset_root: string; source: string; cases?: unknown;
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  started_at: string; updated_at: string; stdout: string; stderr: string;
  pid?: number; process_start?: string; run_id?: string; exit_code?: number | null;
  error?: string; result?: MapValue | null;
  request_sha256?: string;
}
type Options = {
  command(payload: MapValue, jobId: string): Promise<{ executable: string; args: string[]; environment?: NodeJS.ProcessEnv; dispose?: () => void }> | { executable: string; args: string[]; environment?: NodeJS.ProcessEnv; dispose?: () => void };
  environment(): NodeJS.ProcessEnv; redact(text: string): string; onChange?: () => void;
  cleanup?: (jobId: string) => void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RUN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FINAL = new Set(['completed', 'failed', 'cancelled'])
const LOG_LIMIT = 16 * 1024
function requestDigest(payload: MapValue): string {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
  const { request_id: _requestId, ...input } = payload
  return createHash('sha256').update(JSON.stringify(normalize(input))).digest('hex')
}

/** 子进程可能只输出密钥前缀后换行；这些已知片段也不能进入持久 Job 日志。 */
export function redactKnownValues(value: string, secrets: readonly string[]): string {
  let text = value
  for (const secret of secrets) {
    text = text.replaceAll(secret, '[REDACTED]')
    for (let length = secret.length - 1; length >= 4; length -= 1) {
      text = text.replaceAll(secret.slice(0, length), '[REDACTED]')
    }
  }
  return text
}

export class EvaluationJobError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function processStart(pid: number): string | undefined {
  try {
    // /proc stat 的 comm 可以含空格和括号，starttime 是右括号之后的第 20 项。
    const value = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 2).split(' ')
    if (fields[0] === 'Z') return undefined
    return fields[19]
  } catch { return undefined }
}

function ownsProcess(job: Job, root: string): boolean {
  if (!job.pid || !job.process_start || processStart(job.pid) !== job.process_start) return false
  try {
    return statSync(`/proc/${job.pid}`).uid === process.getuid?.()
      && realpathSync(`/proc/${job.pid}/cwd`) === realpathSync(root)
      && readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').split('\0').some(arg => arg.endsWith('/dsh-eval'))
  } catch { return false }
}

/** Job 只持久保存运行关联；任务事实、Case 进度和 Session 从既有 Run 回读。 */
export function createEvaluationJobs(assetRoot: string, options: Options) {
  const root = resolve(assetRoot)
  const identity = workspaceIdentity(root)
  const directory = workspaceLocalPath(root, 'evaluation-jobs')
  const live = new Map<string, { process: ReturnType<typeof spawn>; job: Job }>()
  const starting = new Map<string, { digest: string; promise: Promise<any> }>()
  const pathFor = (id: string) => {
    if (!UUID.test(id)) throw new EvaluationJobError('invalid_request', '评测任务 ID 格式无效')
    return join(directory, `${id}.json`)
  }
  function save(job: Job, notify = true) {
    mkdirSync(directory, { recursive: true })
    const path = pathFor(job.job_id)
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    if (notify) options.onChange?.()
  }
  function read(id: string): Job {
    const active = live.get(id)
    if (active) return active.job
    const path = pathFor(id)
    if (!existsSync(path)) throw new EvaluationJobError('not_found', '评测任务不存在')
    const job = JSON.parse(readFileSync(path, 'utf8')) as Job
    if (!workspaceOwnsCwd(root, job.asset_root) || job.workspace_id !== identity.id || job.job_id !== id)
      throw new EvaluationJobError('not_found', '评测任务不属于当前工作区')
    return job
  }
  function runDirectory(job: Job): string | undefined {
    const experiments = join(root, 'evolution/experiments')
    if (!existsSync(experiments)) return undefined
    const selected = job.source.startsWith('experiment:') ? [job.source.slice('experiment:'.length)] : readdirSync(experiments)
    for (const experiment of selected) {
      if (!VERSION_ID.test(experiment)) continue
      const runs = join(experiments, experiment, 'runs')
      if (!existsSync(runs)) continue
      for (const name of job.run_id ? [job.run_id] : readdirSync(runs)) {
        if (!RUN.test(name)) continue
        const run = join(runs, name)
        if (job.run_id === name && existsSync(join(run, 'run.yaml'))) return run
        try {
          const receipt = JSON.parse(readFileSync(join(run, 'execution.json'), 'utf8'))
          if (receipt.job_id === job.job_id) { job.run_id = name; return run }
        } catch { /* 尚未创建或不是当前 Job 的 Run。 */ }
      }
    }
  }
  function receipt(job: Job): MapValue {
    const run = runDirectory(job)
    const result: MapValue = { job_id: job.job_id, source: job.source, cases: job.cases ?? [],
      actual_model_calls: null, token_usage: null, observed_token_usage: null, token_usage_complete: false,
      token_usage_note: '尚未取得可核验轨迹，总 Token 和费用未知。',
      model_calls_complete: false, model_calls_basis: '轨迹请求头仅在配置变化时产生，不能据此推算实际模型调用或内部重试次数。' }
    if (!run) return result
    let inputs: MapValue, manifest: MapValue
    try {
      inputs = JSON.parse(readFileSync(join(run, 'inputs.lock.json'), 'utf8'))
      manifest = loadYaml(readFileSync(join(run, 'run.yaml'), 'utf8')) as MapValue
    } catch { return result }
    Object.assign(result, { run_id: job.run_id, run_status: manifest.status,
      source: inputs.source_id, cases: inputs.evaluation_cases?.map((item: MapValue) => item.case_id),
      candidate_sha256: inputs.candidate_sha256, evaluation_sha256: inputs.evaluation_sha256,
      program_origin: inputs.program_origin, evaluation_implementation: inputs.evaluation_implementation,
      source_ref: inputs.source_ref, mcp_fixture: inputs.mcp_fixture,
      sessions: [], instance_name: null })
    try {
      const execution = JSON.parse(readFileSync(join(run, 'execution.json'), 'utf8'))
      for (const name of ['instance_name', 'instance_stopped', 'failure_reason', 'deadline_at']) result[name] = execution[name]
    } catch {}
    const sessions = new Set<string>()
    const traces: UsageTrace[] = []
    const walk = (folder: string) => {
      if (!existsSync(folder)) return
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name === 'checks.json') {
          try {
            const checks = JSON.parse(readFileSync(path, 'utf8'))
            if (checks.session_id) sessions.add(checks.session_id)
            if (checks.judge?.session_id) sessions.add(checks.judge.session_id)
          } catch { /* 写入尚未完成的检查文件等待下次查询。 */ }
        } else if (entry.name === 'trace.jsonl' || entry.name === 'judge-trace.jsonl') {
          try { traces.push({ path, rows: readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) }) }
          catch { traces.push({ path, rows: [{}] }) }
        }
      }
    }
    walk(join(run, 'evidence'))
    Object.assign(result, measureRunModelUsage(run, inputs, traces))
    result.sessions = [...sessions]
    try { result.summary = JSON.parse(readFileSync(join(run, 'summary.json'), 'utf8')) } catch {}
    try { result.artifacts = JSON.parse(readFileSync(join(run, 'artifacts/index.json'), 'utf8')).artifacts } catch {}
    return result
  }
  function status(id: string) {
    const job = read(id)
    const actual = receipt(job)
    const alive = live.has(id) || ownsProcess(job, root)
    if (job.status === 'failed' && job.exit_code === 1 && actual.run_status === 'completed') {
      // dsh-eval 用退出码 1 表示业务结论未通过；Run 已完成仍是一次已结束的执行。
      job.status = 'completed'
    }
    if (!FINAL.has(job.status)) {
      if (!alive && FINAL.has(actual.run_status)) {
        job.status = actual.run_status
      } else if (!alive) {
        job.status = 'failed'
        job.error = '评测进程已停止；已有 Run 和部分证据已保留。请核对报告后新建复测，不重复执行未知状态动作。'
      }
    }
    if (FINAL.has(job.status)) options.cleanup?.(id)
    save(job, false)
    return { ...job, result: { ...job.result, ...actual }, stdout: options.redact(job.stdout), stderr: options.redact(job.stderr), ...actual,
      log_note: '日志为截断显示；Case、来源和 Session 从 Run 回读；模型请求按持久尝试结算核对，轨迹不完整时总数保持未知。' }
  }
  function list() {
    if (!existsSync(directory)) return []
    return readdirSync(directory)
      .filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.json'))
      .map(name => {
        const persisted = read(name.slice(0, -5))
        const job = FINAL.has(persisted.status) ? persisted : status(persisted.job_id)
        return { job_id: job.job_id, source: job.source, status: job.status, run_id: job.run_id ?? job.result?.run_id,
          started_at: job.started_at, updated_at: job.updated_at, error: job.error }
      })
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
  }
  function cancel(id: string) {
    const job = read(id)
    if (FINAL.has(job.status)) return { status: job.status }
    const active = live.get(id)
    if (job.status !== 'cancelling') {
      if (active) active.process.kill('SIGTERM')
      else if (ownsProcess(job, root)) process.kill(job.pid!, 'SIGTERM')
      else throw new EvaluationJobError('process_identity_unknown', '无法确认评测进程归属，已保留证据；未向其他进程发送信号。')
      job.status = 'cancelling'
      job.updated_at = new Date().toISOString()
      save(job)
    }
    return { status: job.status }
  }
  async function start(payload: MapValue) {
    const id = payload.request_id ?? randomUUID()
    pathFor(id)
    const digest = requestDigest(payload)
    const pending = starting.get(id)
    if (pending) {
      if (pending.digest !== digest) throw new EvaluationJobError('conflict', '同一评测请求不能更换参数，请新建评测。')
      return pending.promise
    }
    if (existsSync(pathFor(id))) {
      const job = read(id)
      if (job.request_sha256 !== digest) throw new EvaluationJobError('conflict', '同一评测请求不能更换参数，请新建评测。')
      return { job_id: id, status: job.status, started_at: job.started_at }
    }
    const promise = launch(payload, id, digest)
    starting.set(id, { digest, promise })
    try { return await promise } finally { starting.delete(id) }
  }
  async function launch(payload: MapValue, id: string, digest: string) {
    const command = await options.command(payload, id)
    let disposed = false
    const dispose = () => { if (!disposed) { disposed = true; command.dispose?.() } }
    const now = new Date().toISOString()
    const job: Job = { job_id: id, workspace_id: identity.id, asset_root: root,
      request_sha256: digest,
      source: String(payload.source), cases: payload.cases, status: 'running', started_at: now, updated_at: now,
      stdout: '', stderr: '' }
    mkdirSync(directory, { recursive: true })
    try { writeFileSync(pathFor(id), JSON.stringify(job, null, 2) + '\n', { mode: 0o600, flag: 'wx' }) }
    catch (error) {
      dispose()
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = read(id)
        if (existing.request_sha256 === digest) return { job_id: id, status: existing.status, started_at: existing.started_at }
        throw new EvaluationJobError('conflict', '同一评测请求不能更换参数，请新建评测。')
      }
      throw error
    }
    const secrets = Object.values(command.environment ?? {}).filter((value): value is string => typeof value === 'string' && value.length > 0)
    const redactJob = (value: string) => options.redact(redactKnownValues(value, secrets))
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(command.executable, command.args, { cwd: root,
        env: { ...options.environment(), ...command.environment, HARNESS_EVAL_JOB_ID: id },
        stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      dispose()
      job.status = 'failed'
      job.error = redactJob((error as Error).message)
      save(job)
      throw new Error(job.error)
    }
    const pending = { stdout: '', stderr: '' }
    const active = { process: proc, job }
    live.set(id, active)
    proc.on('spawn', () => { job.pid = proc.pid; job.process_start = proc.pid ? processStart(proc.pid) : undefined; save(job) })
    const append = (field: 'stdout' | 'stderr', chunk: unknown) => {
      const raw = secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), pending[field] + String(chunk))
      let held = 0
      for (const secret of secrets) for (let length = 1; length < secret.length; length += 1) {
        if (raw.endsWith(secret.slice(0, length))) held = Math.max(held, length)
      }
      pending[field] = raw.slice(raw.length - held)
      const visible = raw.slice(0, raw.length - held)
      if (!visible) return
      job[field] = options.redact(job[field] + redactKnownValues(visible, secrets)).slice(-LOG_LIMIT)
      const run = job.stderr.match(/(?:^|\n)Research Run: (run-[0-9a-f-]+)(?:\n|$)/)?.[1]
      if (run && RUN.test(run)) job.run_id = run
      job.updated_at = new Date().toISOString()
      save(job)
    }
    const flushPending = () => {
      for (const field of ['stdout', 'stderr'] as const) if (pending[field]) {
        job[field] = redactJob(job[field] + '[REDACTED]').slice(-LOG_LIMIT)
        pending[field] = ''
      }
    }
    proc.stdout!.setEncoding('utf8').on('data', chunk => append('stdout', chunk))
    proc.stderr!.setEncoding('utf8').on('data', chunk => append('stderr', chunk))
    proc.on('error', error => { job.status = 'failed'; job.error = redactJob(error.message); dispose(); save(job) })
    proc.on('close', code => {
      dispose()
      flushPending()
      job.exit_code = code
      job.updated_at = new Date().toISOString()
      try { job.result = JSON.parse(job.stdout) } catch { job.result = null }
      job.status = job.result?.cancelled === true ? job.result.instance_stopped === true ? 'cancelled' : 'failed' : code === 0 ? 'completed' : 'failed'
      if (job.result?.cancelled === true && job.result.instance_stopped !== true) job.error = '取消后的实例停止尚未确认，请核对 Run 与实例状态。'
      live.delete(id)
      save(job)
    })
    return { job_id: id, status: job.status, started_at: now }
  }
  return { start, status, cancel, list }
}
