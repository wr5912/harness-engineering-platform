import { VERSION_ID } from '../version-id.ts'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { workspaceIdentity, workspaceLocalPath, workspaceOwnsCwd } from '../workspace.ts'
import { measureRunModelUsage, type UsageTrace } from './model-usage.ts'

type MapValue = Record<string, any>
type RunControl = {
  schema_version?: '2.0'; run_id?: string; job_id?: string;
  workspace_id: string; asset_root: string; source: string; cases?: unknown;
  status: 'prepared' | 'preparing' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  started_at: string; updated_at: string; stdout: string; stderr: string;
  pid?: number; process_start?: string; owner_pid?: number; owner_start?: string;
  exit_code?: number | null; process_finished?: boolean; error?: string; result?: MapValue | null; request_sha256?: string;
}
type Run = { path: string; id: string; manifest: MapValue; inputs: MapValue; frozen_inputs_available: boolean }
type Options = {
  command(payload: MapValue, runId: string): Promise<{ executable: string; args: string[]; environment?: NodeJS.ProcessEnv; dispose?: () => void }> | { executable: string; args: string[]; environment?: NodeJS.ProcessEnv; dispose?: () => void };
  environment(): NodeJS.ProcessEnv; redact(text: string): string; onChange?: () => void;
  cleanup?: (runId: string) => void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const RUN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FINAL = new Set(['completed', 'failed', 'cancelled'])
const LOG_LIMIT = 16 * 1024
function requestDigest(payload: MapValue): string {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
  const { request_id: _requestId, run_id: _runId, job_id: _jobId, ...input } = payload
  return createHash('sha256').update(JSON.stringify(normalize(input))).digest('hex')
}

/** 子进程可能只输出密钥前缀后换行；这些已知片段也不能进入持久运行日志。 */
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

/** JSON 的类型与标识属于回执合同；短凭据仅匹配完整字符串，不能替换数字或 ID 中的字符。 */
function redactReceipt(value: any, secrets: readonly string[], redact: (text: string) => string): any {
  const text = (input: string) => redact(secrets.includes(input) ? '[REDACTED]'
    : redactKnownValues(input, secrets.filter(secret => secret.length >= 4)))
  if (typeof value === 'string') return text(value)
  if (Array.isArray(value)) return value.map(item => redactReceipt(item, secrets, redact))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [text(key), /^(?:api[_-]?key|token|password|secret)$/i.test(key)
      ? '[REDACTED]' : redactReceipt(item, secrets, redact)]))
  return value
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

function ownsProcess(job: RunControl, root: string): boolean {
  if (!job.pid || !job.process_start || processStart(job.pid) !== job.process_start) return false
  try {
    return statSync(`/proc/${job.pid}`).uid === process.getuid?.()
      && realpathSync(`/proc/${job.pid}/cwd`) === realpathSync(root)
      && readFileSync(`/proc/${job.pid}/cmdline`, 'utf8').split('\0').some(arg => arg.endsWith('/dsh-eval'))
  } catch { return false }
}

/** 运行控制复用唯一 Run ID；旧任务只在当前数据根内兼容读取。 */
export function createEvaluationJobs(assetRoot: string, options: Options) {
  const root = resolve(assetRoot), identity = workspaceIdentity(root), realRoot = realpathSync(root)
  const directory = workspaceLocalPath(root, 'evaluation-jobs')
  const prepared = new Map<string, { digest: string; payload: MapValue }>()
  const live = new Map<string, { process: ReturnType<typeof spawn>; job: RunControl }>()
  const starting = new Map<string, { digest: string; promise: Promise<any> }>()
  const legacyCancelling = new Set<string>()
  const keyFor = (job: RunControl) => job.schema_version === '2.0' ? job.run_id! : job.job_id!
  const pathFor = (id: string) => {
    if (typeof id !== 'string' || (!UUID.test(id) && !RUN.test(id))) throw new EvaluationJobError('invalid_request', '评测编号格式无效')
    return join(directory, `${id}.json`)
  }
  function ordinary(path: string) {
    const actual = realpathSync(path)
    return actual.startsWith(realRoot + '/') && !lstatSync(path).isSymbolicLink() && lstatSync(path).isFile()
  }
  function save(job: RunControl, notify = true) {
    if (job.schema_version !== '2.0') return
    mkdirSync(directory, { recursive: true })
    const path = pathFor(keyFor(job))
    writeFileSync(`${path}.tmp`, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    if (notify) options.onChange?.()
  }
  function read(id: string): RunControl {
    const active = live.get(id)
    if (active) return active.job
    const path = pathFor(id)
    if (!existsSync(path)) throw new EvaluationJobError('not_found', '未找到可继续的运行记录，请重新预览。')
    if (!ordinary(path)) throw new EvaluationJobError('invalid_record', '评测运行状态不是普通文件')
    let job: RunControl
    try { job = JSON.parse(readFileSync(path, 'utf8')) as RunControl } catch { throw new EvaluationJobError('invalid_record', '评测运行状态无法解析，原文件已保留') }
    const known = RUN.test(id) ? job.schema_version === '2.0' && job.run_id === id && !job.job_id
      : job.schema_version === undefined && job.job_id === id
    if (!known || typeof job.source !== 'string' || !['preparing', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'unknown'].includes(job.status))
      throw new EvaluationJobError('invalid_record', '评测运行状态格式无法识别')
    if (!workspaceOwnsCwd(root, job.asset_root) || job.workspace_id !== identity.id)
      throw new EvaluationJobError('not_found', '评测运行不属于当前工作区')
    return job
  }
  function experiments() {
    const path = join(root, 'evolution/experiments')
    return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(item => VERSION_ID.test(item.name) && item.isDirectory() && !item.isSymbolicLink()).map(item => item.name) : []
  }
  function inspectRun(path: string, id: string): Run | undefined {
    const manifestPath = join(path, 'run.yaml'), inputPath = join(path, 'inputs.lock.json')
    if (!existsSync(manifestPath)) return undefined
    if (lstatSync(path).isSymbolicLink() || !ordinary(manifestPath) || (existsSync(inputPath) && !ordinary(inputPath))) throw new EvaluationJobError('run_read_failed', 'Run 清单或冻结输入无法核对，已保留现场')
    let manifest: MapValue, inputs: MapValue, frozenInputsAvailable = existsSync(inputPath)
    try {
      manifest = loadYaml(readFileSync(manifestPath, 'utf8')) as MapValue
      if (manifest?.recovery_note && frozenInputsAvailable && statSync(inputPath).size === 0) frozenInputsAvailable = false
      inputs = frozenInputsAvailable ? JSON.parse(readFileSync(inputPath, 'utf8')) as MapValue : {}
    }
    catch { throw new EvaluationJobError('run_read_failed', 'Run 清单或冻结输入无法解析，原文件已保留') }
    // 旧 Run 可以缺少冻结输入中的 run_id，但已有身份声明不能与目录不一致。
    if (!manifest || (manifest.run_id != null && manifest.run_id !== id) || (inputs.run_id != null && inputs.run_id !== id)
      || !['planned', 'running', 'completed', 'failed', 'cancelled'].includes(manifest.status)) throw new EvaluationJobError('run_read_failed', 'Run 身份或状态与目录不一致')
    return { path, id, manifest, inputs, frozen_inputs_available: frozenInputsAvailable }
  }
  function runDirectory(job: RunControl): Run | undefined {
    const id = job.schema_version === '2.0' ? job.run_id : job.run_id ?? job.result?.run_id
    const selected = job.source.startsWith('experiment:') && VERSION_ID.test(job.source.slice(11)) ? [job.source.slice(11)] : experiments()
    if (id && RUN.test(id)) for (const experiment of selected) {
      const path = join(root, 'evolution/experiments', experiment, 'runs', id)
      if (existsSync(path)) { const run = inspectRun(path, id); if (run) { if (job.schema_version === '2.0' && (run.manifest.run_id !== id || run.inputs.run_id !== id)) throw new EvaluationJobError('run_read_failed', '新 Run 缺少一致的清单与输入身份'); return run } }
    }
    if (job.schema_version === '2.0') return undefined
    // 旧请求可能没有捕获 Run 输出；只查所属版本的原 execution 或已核验恢复关联。
    let uncertainty = ''
    for (const experiment of selected) {
      const folder = join(root, 'evolution/experiments', experiment, 'runs')
      if (!existsSync(folder)) continue
      for (const name of readdirSync(folder)) {
        if (!RUN.test(name)) continue
        const path = join(folder, name), execution = join(path, 'execution.json')
        if (lstatSync(path).isSymbolicLink()) { uncertainty = '旧 Run 目录无法核对'; continue }
        if (existsSync(execution)) {
          if (!ordinary(execution)) { uncertainty = '旧执行关联无法核对'; continue }
          let record: MapValue
          try { record = JSON.parse(readFileSync(execution, 'utf8')) } catch {
            const run = inspectRun(path, name), recovered = run?.manifest
            const recoveredId = /^\.local\/evaluation-jobs\/([0-9a-f-]+)\.json$/.exec(recovered?.recovery_source ?? '')?.[1]
            if (recoveredId && UUID.test(recoveredId) && existsSync(pathFor(recoveredId)) && ordinary(pathFor(recoveredId))
              && createHash('sha256').update(readFileSync(pathFor(recoveredId))).digest('hex') === recovered?.recovery_source_sha256) {
              if (recoveredId === job.job_id) return run
              continue
            }
            uncertainty = '旧执行关联无法解析，原文件已保留'; continue
          }
          if (record.job_id === job.job_id) return inspectRun(path, name)
        } else if (!job.source.startsWith('experiment:') || experiment === job.source.slice(11)) {
          uncertainty = '存在缺少执行关联的 Run 或初始化目录，未清理旧请求'
        }
      }
    }
    if (uncertainty) throw new EvaluationJobError('run_read_failed', uncertainty)
    return undefined
  }
  function receipt(job: RunControl, run?: Run, full = true): MapValue {
    const result: MapValue = { run_id: run?.id ?? (job.schema_version === '2.0' ? job.run_id : null), run_created: Boolean(run), source: job.source, cases: job.cases ?? [],
      actual_model_calls: null, token_usage: null, observed_token_usage: null, token_usage_complete: false,
      token_usage_note: '尚未取得可核验轨迹，总 Token 和费用未知。', model_calls_complete: false,
      model_calls_basis: '轨迹请求头仅在配置变化时产生，不能据此推算实际模型调用或内部重试次数。' }
    if (!run) return result
    const { inputs, manifest } = run
    Object.assign(result, { run_status: manifest.status, frozen_inputs_available: run.frozen_inputs_available, recovery_note: manifest.recovery_note, experiment_id: manifest.experiment_id ?? run.path.split('/').at(-3), agent_id: manifest.agent_id,
      source: inputs.source_id ?? job.source, cases: inputs.evaluation_cases?.map((item: MapValue) => item.case_id) ?? (manifest.recovery_note ? [] : job.cases ?? []),
      candidate_sha256: inputs.candidate_sha256, evaluation_sha256: inputs.evaluation_sha256,
      program_origin: inputs.program_origin, evaluation_implementation: inputs.evaluation_implementation,
      source_ref: inputs.source_ref, evaluation_source: inputs.evaluation_source, mcp_fixture: inputs.mcp_fixture, sessions: [], instance_name: null })
    try { const execution = JSON.parse(readFileSync(join(run.path, 'execution.json'), 'utf8')); for (const name of ['instance_name', 'instance_stopped', 'failure_reason', 'deadline_at']) result[name] = execution[name] } catch {}
    if (!full) return result
    const sessions = new Set<string>(), traces: UsageTrace[] = []
    const walk = (folder: string) => {
      if (!existsSync(folder)) return
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path)
        else if (entry.name === 'checks.json') {
          try { const checks = JSON.parse(readFileSync(path, 'utf8')); if (checks.session_id) sessions.add(checks.session_id); if (checks.judge?.session_id) sessions.add(checks.judge.session_id) } catch {}
        } else if (entry.name === 'trace.jsonl' || entry.name === 'judge-trace.jsonl') {
          try { traces.push({ path, rows: readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) }) } catch { traces.push({ path, rows: [{}] }) }
        }
      }
    }
    walk(join(run.path, 'evidence'))
    Object.assign(result, measureRunModelUsage(run.path, inputs, traces)); result.sessions = [...sessions]
    try { result.summary = JSON.parse(readFileSync(join(run.path, 'summary.json'), 'utf8')) } catch {}
    try { result.artifacts = JSON.parse(readFileSync(join(run.path, 'artifacts/index.json'), 'utf8')).artifacts } catch {}
    return result
  }
  function processGone(pid?: number, start?: string): boolean {
    if (!pid) return false
    try { const actual = readFileSync(`/proc/${pid}/stat`, 'utf8'); const fields = actual.slice(actual.lastIndexOf(')') + 2).split(' '); return fields[0] === 'Z' || Boolean(start && fields[19] !== start) }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH' }
  }
  function groupGone(pid: number): boolean {
    try { process.kill(-pid, 0); return false } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  }
  function cleanupInitial(job: RunControl) {
    const id = keyFor(job), file = pathFor(id)
    const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    if (before !== undefined) { const stored = JSON.parse(before); if (!ordinary(file) || stored.schema_version !== '2.0' || stored.run_id !== id || stored.request_sha256 !== job.request_sha256 || stored.workspace_id !== identity.id || !workspaceOwnsCwd(root, stored.asset_root)) throw new EvaluationJobError('cleanup_failed', '运行状态归属已变化，未清理') }
    if (runDirectory(job)) return
    const experiment = job.source.startsWith('experiment:') ? job.source.slice(11) : ''
    if (VERSION_ID.test(experiment)) {
      const path = join(root, 'evolution/experiments', experiment, 'runs', id)
      if (existsSync(path)) {
        if (lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(realRoot + '/')) throw new EvaluationJobError('cleanup_failed', '初始化目录归属无法核对，现场已保留')
        const markerPath = join(path, '.initialization.json')
        const marker = existsSync(markerPath) && ordinary(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null
        if (!marker || marker.schema_version !== '1.0' || marker.run_id !== id || marker.request_sha256 !== job.request_sha256 || !workspaceOwnsCwd(root, marker.asset_root)
          || (marker.workspace_id !== identity.id && !(marker.workspace_id == null && !existsSync(join(root, 'workspace.json'))))
          || !processGone(marker.pid, marker.process_start) || !groupGone(marker.pid)
          || existsSync(join(path, 'execution.json')) || existsSync(join(path, 'results.jsonl')) || existsSync(join(path, 'summary.json')))
          throw new EvaluationJobError('cleanup_failed', '初始化进程或半成品归属尚未确认，现场已保留')
        rmSync(path, { recursive: true })
      }
    }
    options.cleanup?.(id)
    if (before !== undefined && existsSync(file) && readFileSync(file, 'utf8') !== before) throw new EvaluationJobError('cleanup_failed', '清理期间运行状态发生变化，未删除状态文件')
    if (existsSync(file)) unlinkSync(file)
    options.onChange?.()
  }
  function cleanupLegacy(job: RunControl, run?: Run): boolean {
    if (job.schema_version === '2.0' || run || job.status !== 'failed' || !Number.isInteger(job.exit_code) || !job.exit_code || !processGone(job.pid, job.process_start)
      || live.has(keyFor(job)) || starting.has(keyFor(job)) || job.run_id || job.result?.run_id) return false
    const text = `${job.stdout}\n${job.stderr}\n${job.error ?? ''}`
    if (!/(?:前置校验未通过|缺少运行时环境变量|创建 Run 失败)/.test(text) || /(?:Research Run:|run-[0-9a-f]{8}-)/.test(text)) return false
    const path = pathFor(keyFor(job)), before = readFileSync(path, 'utf8')
    if (runDirectory(job) || readFileSync(path, 'utf8') !== before) return false
    options.cleanup?.(keyFor(job))
    if (readFileSync(path, 'utf8') !== before || runDirectory(job)) return false
    unlinkSync(path); options.onChange?.(); return true
  }
  function cleanupFailedCreation(job: RunControl) {
    try { cleanupInitial(job) }
    catch (error) { const message = options.redact((error as Error).message), changed = job.status !== 'unknown' || job.error !== message; job.status = 'unknown'; job.error = message; const file = pathFor(keyFor(job)); if (changed && existsSync(file)) { let current: MapValue = {}; try { current = JSON.parse(readFileSync(file, 'utf8')) } catch {} if (current.run_id === job.run_id && current.request_sha256 === job.request_sha256 && current.workspace_id === job.workspace_id && current.asset_root === job.asset_root) save(job) } throw new EvaluationJobError('cleanup_failed', message) }
  }
  function recoverFailedCreation(job: RunControl): boolean {
    if (job.schema_version !== '2.0' || live.has(keyFor(job)) || starting.has(keyFor(job)) || !(job.pid ? processGone(job.pid, job.process_start) : job.process_finished === true)) return false
    let confirmed = job.process_finished === true && Number.isInteger(job.exit_code)
    if (!confirmed && job.source.startsWith('experiment:') && VERSION_ID.test(job.source.slice(11))) {
      const markerPath = join(root, 'evolution/experiments', job.source.slice(11), 'runs', job.run_id!, '.initialization.json')
      if (existsSync(markerPath) && ordinary(markerPath)) { const marker = JSON.parse(readFileSync(markerPath, 'utf8')); confirmed = marker.schema_version === '1.0' && marker.run_id === job.run_id && marker.request_sha256 === job.request_sha256 && processGone(marker.pid, marker.process_start) && groupGone(marker.pid) }
    }
    if (!confirmed) return false
    cleanupFailedCreation(job); return true
  }
  function snapshot(job: RunControl, full = true): MapValue {
    const run = runDirectory(job), id = keyFor(job)
    if (!run) { try { if (recoverFailedCreation(job)) throw new EvaluationJobError('not_found', '原评测创建失败，临时数据已清理，请重新预览。') } catch (error) { if ((error as EvaluationJobError).code !== 'cleanup_failed') throw error } }
    if (cleanupLegacy(job, run)) throw new EvaluationJobError('not_found', '此旧启动请求未生成 Run，失败临时数据已清理。')
    const alive = live.has(id) || ownsProcess(job, root)
    let state: RunControl['status'] = legacyCancelling.has(id) ? 'cancelling' : job.status
    if (run && FINAL.has(run.manifest.status)) state = run.manifest.status
    else if (alive && FINAL.has(state)) state = 'unknown'
    else if (!FINAL.has(state) && !alive && !starting.has(id)
      && !(state === 'preparing' && !job.pid && job.owner_pid && job.owner_start && !processGone(job.owner_pid, job.owner_start))) state = 'unknown'
    if (FINAL.has(state)) legacyCancelling.delete(id)
    const actual = receipt(job, run, full)
    const { job_id: _legacyId, ...safe } = job
    return { ...safe, ...(job.schema_version === '2.0' ? {} : { legacy_id: job.job_id }), status: state,
      result: { ...job.result, ...actual }, ...actual, stdout: options.redact(job.stdout ?? ''), stderr: options.redact(job.stderr ?? ''),
      log_note: '日志为截断显示；来源、Case 与执行证据从对应 Run 回读。' }
  }
  function committedById(id: string): Run | undefined {
    if (!RUN.test(id)) return undefined
    for (const experiment of experiments()) {
      const path = join(root, 'evolution/experiments', experiment, 'runs', id)
      if (existsSync(path)) { const run = inspectRun(path, id); if (run) return run }
    }
  }
  function control(id: string): RunControl | undefined {
    if (existsSync(pathFor(id)) || live.has(id)) return read(id)
    const run = committedById(id)
    if (run) {
      try { const execution = JSON.parse(readFileSync(join(run.path, 'execution.json'), 'utf8')); if (UUID.test(execution.job_id ?? '') && existsSync(pathFor(execution.job_id))) return read(execution.job_id) } catch (error) { if (error instanceof EvaluationJobError) throw error }
    }
  }
  function status(id: string): MapValue {
    pathFor(id)
    const reservation = prepared.get(id)
    if (reservation) return { run_id: id, run_created: false, status: 'prepared', source: reservation.payload.source }
    const job = control(id)
    if (job) return snapshot(job)
    const run = committedById(id)
    if (run) {
      const source = run.inputs.source_id ?? run.manifest.source_id ?? `experiment:${run.manifest.experiment_id}`
      let execution: MapValue = {}
      try { execution = JSON.parse(readFileSync(join(run.path, 'execution.json'), 'utf8')) } catch {
        if (!FINAL.has(run.manifest.status)) throw new EvaluationJobError('run_read_failed', '运行中的执行记录无法读取，进程状态未知')
      }
      const known = FINAL.has(run.manifest.status) ? run.manifest.status : ownsProcess(execution as RunControl, root) ? 'running' : 'unknown'
      const observed = { source, status: known, started_at: run.manifest.created_at, updated_at: run.manifest.finished_at ?? run.manifest.created_at, stdout: '', stderr: '' } as RunControl
      const actual = receipt(observed, run)
      return { ...observed, ...actual, result: actual }
    }
    throw new EvaluationJobError('not_found', '未找到可继续的运行记录，请重新预览。')
  }
  function list() {
    const runs = new Map<string, any>(), pending: any[] = [], errors: { path: string; message: string; code?: string }[] = []
    if (!existsSync(directory)) return { runs: [], pending, errors }
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json') || (!UUID.test(name.slice(0, -5)) && !RUN.test(name.slice(0, -5)))) continue
      try {
        const job = read(name.slice(0, -5))
        const value = snapshot(job, false)
        // 已删除版本的终态旧启动回执保留原文件，不再作为当前 Run 的读取故障。
        if (job.schema_version === undefined && job.source.startsWith('experiment:') && VERSION_ID.test(job.source.slice(11))
          && !existsSync(join(root, 'evolution/experiments', job.source.slice(11))) && FINAL.has(job.status)
          && processGone(job.pid, job.process_start) && !live.has(keyFor(job)) && !starting.has(keyFor(job))) continue
        if (value.run_created && value.run_id) runs.set(value.run_id, value)
        else { if (!FINAL.has(value.status)) pending.push(value); if (value.status !== 'preparing' && value.status !== 'cancelling' && value.status !== 'running') errors.push({ path: `evaluation-jobs/${name}`, message: '旧启动状态待核对，未重放或清理。', code: 'observation_unknown' }) }
      }
      catch (error) { if ((error as EvaluationJobError).code !== 'not_found') errors.push({ path: `evaluation-jobs/${name}`, message: options.redact((error as Error).message), code: (error as EvaluationJobError).code }) }
    }
    return { runs: [...runs.values()].sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '')), pending, errors }
  }
  function remove(ids: unknown) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !RUN.test(id)) || new Set(ids).size !== ids.length)
      throw new EvaluationJobError('invalid_request', '请选择不重复的有效评测记录')
    const deleted: string[] = [], failed: { run_id: string; code: string; message: string }[] = []
    for (const id of ids as string[]) {
      try {
        const matches = experiments().map(experiment => join(root, 'evolution/experiments', experiment, 'runs', id)).filter(path => existsSync(path))
        if (!matches.length) throw new EvaluationJobError('not_found', '评测记录已不存在，请刷新列表核对')
        if (matches.length !== 1) throw new EvaluationJobError('conflict', '存在重复的评测编号，无法确定删除目标')
        if (realpathSync(matches[0]) !== join(realRoot, matches[0].slice(root.length + 1))) throw new EvaluationJobError('run_read_failed', '评测目录包含符号链接，无法核对删除目标')
        const run = inspectRun(matches[0], id)
        if (!run || !FINAL.has(run.manifest.status)) throw new EvaluationJobError('run_active', '评测尚未结束或状态未知，请先取消并刷新状态')
        const job = control(id)
        let execution: MapValue = {}
        const executionPath = join(run.path, 'execution.json')
        if (existsSync(executionPath)) {
          if (!ordinary(executionPath)) throw new EvaluationJobError('run_read_failed', '执行记录不是普通文件')
          try { execution = JSON.parse(readFileSync(executionPath, 'utf8')) }
          catch { throw new EvaluationJobError('run_read_failed', '执行记录无法解析，无法核对进程状态') }
        }
        const key = job ? keyFor(job) : id
        if (live.has(key) || starting.has(key) || prepared.has(id) || (job?.pid && !processGone(job.pid, job.process_start))
          || (execution.pid && !processGone(execution.pid, execution.process_start)))
          throw new EvaluationJobError('run_active', '评测进程仍在运行，请稍后刷新再删除')
        if (job && runDirectory(job)?.path !== run.path) throw new EvaluationJobError('conflict', '运行控制与评测记录不一致，已保留原记录')
        if (job && existsSync(pathFor(key))) unlinkSync(pathFor(key))
        rmSync(run.path, { recursive: true })
        deleted.push(id)
      } catch (error) {
        failed.push({ run_id: id, code: (error as EvaluationJobError).code ?? 'delete_failed', message: options.redact((error as Error).message) })
      }
    }
    if (deleted.length) options.onChange?.()
    return { deleted, failed }
  }
  function cancel(id: string) {
    pathFor(id)
    if (prepared.delete(id)) return { run_id: id, run_created: false, status: 'cancelled' }
    const job = control(id)
    if (!job) throw new EvaluationJobError('process_identity_unknown', '没有可核验的运行控制状态；已有 Run 已保留。')
    const view = snapshot(job)
    if (FINAL.has(view.status)) return { run_id: view.run_id, run_created: view.run_created, status: view.status }
    if (view.status === 'cancelling') return { run_id: view.run_id, run_created: view.run_created, status: 'cancelling' }
    const active = live.get(keyFor(job))
    if (job.status !== 'cancelling') {
      if (active) active.process.kill('SIGTERM')
      else if (ownsProcess(job, root)) process.kill(job.pid!, 'SIGTERM')
      else if (!(job.schema_version === '2.0' && job.status === 'preparing' && !job.pid && job.owner_pid && job.owner_start && !processGone(job.owner_pid, job.owner_start)))
        throw new EvaluationJobError('process_identity_unknown', '无法确认评测进程归属；未向其他进程发送信号。')
      if (job.schema_version !== '2.0') legacyCancelling.add(keyFor(job))
      job.status = 'cancelling'; job.updated_at = new Date().toISOString(); save(job)
    }
    return { run_id: view.run_id, run_created: view.run_created, status: job.status }
  }
  function reserve(payload: MapValue) {
    const run_id = `run-${randomUUID()}`
    prepared.set(run_id, { digest: requestDigest(payload), payload: structuredClone(payload) })
    return { run_id, status: 'prepared', run_created: false }
  }
  function existing(payload: MapValue) {
    const id = payload.run_id
    pathFor(id)
    const digest = requestDigest(payload), pending = starting.get(id), reservation = prepared.get(id)
    if (pending) { if (pending.digest !== digest) throw new EvaluationJobError('conflict', '同一 Run ID 不能更换评测参数'); return { pending: pending.promise } }
    if (existsSync(pathFor(id))) { const job = read(id); if (job.request_sha256 !== digest) throw new EvaluationJobError('conflict', '同一 Run ID 不能更换评测参数'); return { value: snapshot(job) } }
    if (!reservation || reservation.digest !== digest) {
      if (reservation) throw new EvaluationJobError('conflict', '预览参数已变化，请重新预览')
      throw new EvaluationJobError('creation_expired', '预览已失效，请重新预览取得新的 Run ID；原请求不会重新启动。')
    }
    return { reservation }
  }
  function waitForCreated(id: string) {
    return new Promise<any>((resolveCreated, rejectCreated) => {
      const observe = () => {
        try { const value = status(id); if (value.run_created) { clearInterval(timer); resolveCreated(value) } else if (value.status === 'unknown') { clearInterval(timer); rejectCreated(new EvaluationJobError('observation_unknown', '原评测创建状态待核对，请仅查询原 Run ID')) } }
        catch (error) { clearInterval(timer); rejectCreated(error) }
      }
      const timer = setInterval(observe, 50)
      observe()
    })
  }
  async function start(payload: MapValue) {
    if (!payload.run_id && typeof payload.request_id === 'string') {
      pathFor(payload.request_id)
      if (existsSync(pathFor(payload.request_id))) return snapshot(read(payload.request_id))
      throw new EvaluationJobError('protocol_changed', '旧启动请求不存在，请先 eval/preview 获取 run_id；不会重新执行旧请求。')
    }
    if (typeof payload.run_id !== 'string' || !RUN.test(payload.run_id)) throw new EvaluationJobError('invalid_request', '请先预览并提交 run-<UUIDv4> 格式的 run_id')
    const found = existing(payload)
    if (found.pending) return found.pending
    if (found.value) return found.value.run_created ? found.value : waitForCreated(payload.run_id)
    const id = payload.run_id, digest = requestDigest(payload)
    prepared.delete(id)
    const promise = launch(payload, id, digest)
    starting.set(id, { digest, promise })
    try { return await promise } finally { starting.delete(id) }
  }
  async function launch(payload: MapValue, id: string, digest: string) {
    const now = new Date().toISOString()
    const job: RunControl = { schema_version: '2.0', run_id: id, workspace_id: identity.id, asset_root: root,
      source: String(payload.source), cases: payload.cases, request_sha256: digest, status: 'preparing',
      owner_pid: process.pid, owner_start: processStart(process.pid), started_at: now, updated_at: now, stdout: '', stderr: '' }
    mkdirSync(directory, { recursive: true })
    try { writeFileSync(pathFor(id), JSON.stringify(job, null, 2) + '\n', { mode: 0o600, flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return waitForCreated(id); throw error }
    let command: Awaited<ReturnType<Options['command']>>
    try { command = await options.command(payload, id) }
    catch (error) { job.process_finished = true; job.exit_code = -1; cleanupFailedCreation(job); throw error }
    let disposed = false
    const dispose = () => { if (!disposed) { disposed = true; command.dispose?.() } }
    if (read(id).status === 'cancelling') { dispose(); job.process_finished = true; job.exit_code = -1; cleanupFailedCreation(job); throw new EvaluationJobError('creation_cancelled', '评测创建已取消') }
    const secrets = Object.entries(command.environment ?? {}).filter(([key]) => key !== 'HARNESS_PROGRAM_ROOT').map(([, value]) => value).filter((value): value is string => typeof value === 'string' && value.length > 0)
    const redactJob = (value: string) => options.redact(redactKnownValues(value, secrets))
    return new Promise<any>((resolveCreated, rejectCreated) => {
      let settled = false, output = '', pending = { stdout: '', stderr: '' }, timer: ReturnType<typeof setInterval>
      const settle = (error?: Error) => {
        if (settled) return
        let run: Run | undefined
        try {
          run = runDirectory(job)
          if (run) {
            job.status = FINAL.has(run.manifest.status) ? run.manifest.status : job.status === 'cancelling' ? 'cancelling' : 'running'; save(job)
            const value = snapshot(job)
            settled = true; clearInterval(timer); resolveCreated(value); return
          }
        } catch (observed) { if (!error) error = observed as Error }
        if (error) { settled = true; clearInterval(timer); rejectCreated(error) }
      }
      let proc: ReturnType<typeof spawn>
      try { proc = spawn(command.executable, command.args, { cwd: root,
        env: { ...options.environment(), ...command.environment, HARNESS_EVAL_RUN_ID: id, HARNESS_EVAL_REQUEST_SHA256: digest }, stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch (error) { dispose(); job.process_finished = true; job.exit_code = -1; try { cleanupFailedCreation(job) } catch (cleanup) { settle(cleanup as Error); return } settle(new EvaluationJobError('creation_failed', redactJob((error as Error).message))); return }
      const active = { process: proc, job }; live.set(id, active)
      timer = setInterval(() => settle(), 50)
      proc.on('spawn', () => { job.pid = proc.pid; job.process_start = proc.pid ? processStart(proc.pid) : undefined; save(job); if (job.status === 'cancelling') proc.kill('SIGTERM') })
      const append = (field: 'stdout' | 'stderr', chunk: unknown) => {
        if (field === 'stdout') output = (output + String(chunk)).slice(-LOG_LIMIT)
        const raw = secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), pending[field] + String(chunk))
        let held = 0
        for (const secret of secrets) for (let length = 1; length < secret.length; length++) if (raw.endsWith(secret.slice(0, length))) held = Math.max(held, length)
        pending[field] = raw.slice(raw.length - held)
        const visible = raw.slice(0, raw.length - held)
        if (visible) { job[field] = options.redact(job[field] + redactKnownValues(visible, secrets)).slice(-LOG_LIMIT); job.updated_at = new Date().toISOString(); save(job) }
        settle()
      }
      proc.stdout!.setEncoding('utf8').on('data', chunk => append('stdout', chunk))
      proc.stderr!.setEncoding('utf8').on('data', chunk => append('stderr', chunk))
      proc.on('error', error => { job.error = redactJob(error.message) })
      proc.on('close', code => {
        dispose(); clearInterval(timer)
        for (const field of ['stdout', 'stderr'] as const) if (pending[field]) { job[field] = redactJob(job[field] + '[REDACTED]'); pending[field] = '' }
        job.exit_code = code; job.process_finished = true; job.updated_at = new Date().toISOString()
        try { job.result = redactReceipt(JSON.parse(output), secrets, options.redact); job.stdout = JSON.stringify(job.result) } catch { job.result = null }
        output = ''; live.delete(id)
        let run: Run | undefined
        try { run = runDirectory(job) } catch (error) { job.status = 'unknown'; job.error = options.redact((error as Error).message); save(job); settle(error as Error); return }
        if (!run) {
          const reason = job.error || job.stderr.trim() || '创建 Run 前评测进程已结束，请重新预览。'
          try { const cancelled = job.status === 'cancelling'; cleanupFailedCreation(job); settle(new EvaluationJobError(cancelled ? 'creation_cancelled' : 'creation_failed', cancelled ? '评测创建已取消' : reason)) }
          catch (error) { settle(error as Error) }
          return
        }
        job.status = job.result?.cancelled === true ? job.result.instance_stopped === true ? 'cancelled' : 'failed'
          : FINAL.has(run.manifest.status) ? run.manifest.status : code === 0 ? 'completed' : 'failed'
        if (job.result?.cancelled === true && job.result.instance_stopped !== true) job.error = '取消后的实例停止尚未确认，请核对 Run 与实例状态。'
        save(job); settle()
      })
    })
  }
  function lookup(payload: MapValue) {
    if (payload.run_id) { const found = existing(payload); return found.value ?? (found.pending ? { run_id: payload.run_id, status: 'preparing', run_created: false } : { run_id: payload.run_id, status: 'prepared', run_created: false }) }
    if (payload.request_id && existsSync(pathFor(payload.request_id))) return snapshot(read(payload.request_id))
    return undefined
  }
  async function startBatch(requests: unknown, _preview?: (request: MapValue) => Promise<void>, signal?: AbortSignal) {
    if (!Array.isArray(requests) || !requests.length || requests.length > 8 || requests.some(item => !item || typeof item !== 'object' || !RUN.test(item.run_id ?? '') || typeof item.source_ref !== 'string' || !/^git:[0-9a-f]{40}$/.test(item.source_ref))
      || new Set(requests.map(item => item.run_id)).size !== requests.length) throw new EvaluationJobError('invalid_request', '批量评测需要1–8个不同的预览 Run ID 与固定 source_ref')
    requests.forEach(existing)
    const runs: any[] = []
    for (let index = 0; index < requests.length; index++) {
      try { signal?.throwIfAborted(); runs.push(await start(requests[index])) }
      catch (error) { const not_started = requests.slice(index + 1).map(item => item.run_id); not_started.forEach(id => prepared.delete(id)); return { runs, failed: { run_id: requests[index].run_id, code: (error as EvaluationJobError).code ?? 'creation_failed', message: options.redact((error as Error).message) }, not_started } }
    }
    return { runs, failed: null, not_started: [] }
  }
  return { reserve, start, status, cancel, list, lookup, startBatch, remove }
}
