/** 三个任务样例的受限业务工具；输出来自实际接口或可核查执行回执。 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'task-example-tools'
export const inject = ['tools', 'connection', 'webServer', 'webApp']
type Row = { asset_id: string; hostname: string; asset_type: string; risk_score: number }
type SourceDocument = { url: string; path: string; sha256: string }
type Config = { kind: 'inspection' | 'research' | 'training'; presetId?: string; workflowTool?: string; assetUrl?: string; sourceUrls?: string[]; sourceDocuments?: SourceDocument[] }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const runPattern = /^task-[0-9a-f-]{36}$/
const safeCell = (value: unknown) => String(value).replace(/[\r\n|]/g, ' ').slice(0, 500)
const columns = { run_id: { type: 'string' }, action: { type: 'string' }, cursor: { type: 'number' }, source: { type: 'string' }, summaries: { type: 'object', additionalProperties: { type: 'string' } }, train_py: { type: 'string', description: '仅candidate动作：修改后的完整train.py，其余上游文件不可更改。' } }
const trainingCommit = '228791fb499afffb54b46200aca536f79142f117'


/** 同一进程组运行 uv 与训练子进程，取消和超时均清理整个组并保留有限输出。 */
export async function runTrainingProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout: number; maxBytes?: number; onSpawn?: (pid: number) => Promise<void>
}): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', bytes = 0, reason = ''
    let receipt = Promise.resolve()
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal) } catch (error: any) { if (error.code !== 'ESRCH') reason ||= 'process-cleanup-failed' }
    }
    const stop = (code: string) => { reason ||= code; killGroup('SIGTERM') }
    const aborted = () => terminate('cancelled')
    // 不依赖直属 uv 退出后的 close 事件：其子进程也可能仍持有输出管道。
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const forceCleanup = () => { if (!forceTimer) forceTimer = setTimeout(() => killGroup('SIGKILL'), 250) }
    const terminate = (code: string) => { stop(code); forceCleanup() }
    options.signal?.addEventListener('abort', aborted, { once: true })
    const capture = (kind: 'stdout' | 'stderr', value: Buffer) => {
      const limit = options.maxBytes ?? 1024 * 1024
      const kept = value.subarray(0, Math.max(0, limit - bytes)).toString()
      if (kind === 'stdout') stdout += kept; else stderr += kept
      bytes += value.length
      if (bytes > limit) terminate('output-limit')
    }
    child.stdout?.on('data', value => capture('stdout', value))
    child.stderr?.on('data', value => capture('stderr', value))
    child.on('spawn', () => { if (options.onSpawn && child.pid) receipt = options.onSpawn(child.pid).catch(() => { terminate('process-receipt-failed') }) })
    child.on('error', (error: any) => { reason ||= error.code || 'spawn-error' })
    child.on('exit', () => { killGroup('SIGTERM'); forceCleanup() })
    const timeout = setTimeout(() => terminate('timeout'), options.timeout)
    child.on('close', async (code, signal) => {
      await receipt
      clearTimeout(timeout); if (forceTimer) clearTimeout(forceTimer)
      options.signal?.removeEventListener('abort', aborted)
      // close 后仍可能有未持有 stdout 的孙进程，最终再检查和清理一次。
      killGroup('SIGKILL')
      if (reason || code !== 0 || signal) reject(Object.assign(new Error(reason || 'process-failed'), { code: reason || 'process-failed', stdout, stderr }))
      else resolve({ stdout, stderr })
    })
    // abort可能与spawn同时到达；不让第一次检查与监听注册之间留下窗口。
    if (options.signal?.aborted) terminate('cancelled')
  })
}

const execute = runTrainingProcess

function safeTrainingLog(value: unknown): string {
  return String(value ?? '').replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|token|secret)\s*[:=]\s*)[^\s,"']+/gi, '$1[REDACTED]')
}

async function fileDigest(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function apply(ctx: any, config: Config) {
  const base = join(process.env.DSH_HOME || '/var/lib/dsh', 'task-example-artifacts')
  const workspaceRoot = process.cwd()
  const subjectPreset = config.presetId ?? { inspection: 'daily-inspection-assistant', research: 'multi-step-research-analyst', training: 'autonomous-training-researcher' }[config.kind]
  if (config.workflowTool !== undefined && (typeof config.workflowTool !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(config.workflowTool))) throw new Error('workflowTool 必须是明确的工具名')
  const allowedTools = [...new Set(['task_' + config.kind, ...(config.workflowTool ? [config.workflowTool] : [])])]
  const isSubject = (agent: any) => agent?.session?.header?.agentPreset === subjectPreset
  function artifactUrl(id: string, file: string) {
    const url = new URL('api/task-examples/artifact', ctx.webApp.getAdvertisedUrl())
    url.searchParams.set('run_id', id)
    url.searchParams.set('file', file)
    return url.href
  }
  ctx.on('agent/pre-step', ({ agent }: any, next: () => unknown) => {
    if (isSubject(agent)) agent.ctx.tools.restrict({ allow: allowedTools })
    return next()
  })
  ctx.tools.guard((execution: any) => isSubject(execution.agent) && !allowedTools.includes(execution.name) ? '任务只允许已绑定业务工具' : undefined)
  async function save(id: string, value: any) {
    value.run_id ||= id
    await mkdir(join(base, id), { recursive: true })
    const temporary = join(base, id, `state-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(value, null, 2))
    await rename(temporary, join(base, id, 'state.json'))
  }
  async function state(id: string, session: string) {
    if (!runPattern.test(id)) throw new Error('运行 ID 无效')
    const value = JSON.parse(await readFile(join(base, id, 'state.json'), 'utf8'))
    if (value.session_id !== session) throw new Error('该任务属于另一 Session')
    return value
  }
  async function get(url: string, signal: AbortSignal) {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
    if (!response.ok) throw new Error(`外部资料读取失败: HTTP ${response.status}`)
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('资料超过读取上限') }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }
  async function readSourceDocument(document: SourceDocument) {
    if (!/^references\/[a-z0-9-]+\.md$/.test(document.path) || !/^[0-9a-f]{64}$/.test(document.sha256)) throw new Error('固定资料路径或摘要配置无效')
    const file = resolve(workspaceRoot, document.path)
    const info = await lstat(file)
    if (!info.isFile() || info.size > 2 * 1024 * 1024 || await realpath(file) !== file) throw new Error('固定资料必须是工作区references内的普通文件')
    const bytes = await readFile(file)
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) throw new Error('固定资料摘要不匹配，请核对已绑定版本；未尝试联网替代')
    return bytes.toString('utf8')
  }
  async function report(id: string, value: any, content: string, csv?: string) {
    const bytes = Buffer.from(content)
    await writeFile(join(base, id, 'report.md'), bytes)
    if (csv) await writeFile(join(base, id, 'devices.csv'), csv)
    value.report_sha256 = digest(content); value.completed_at = new Date().toISOString()
    await save(id, value)
    return { run_id: id, completed: true, source_kind: value.source_kind, report_sha256: value.report_sha256, markdown: content, ...(csv ? { csv } : {}),
      download_url: artifactUrl(id, 'report.md'),
      ...(csv ? { csv_url: artifactUrl(id, 'devices.csv') } : {}) }
  }
  const fixedTrainingFiles = ['prepare.py', 'pyproject.toml', 'uv.lock']
  async function trainingPreflight(signal: AbortSignal) {
    const workspace = join(process.env.DSH_HOME || '/var/lib/dsh', 'autoresearch')
    const checks = { nvidia_gpu: false, pytorch_cuda: false, uv: false, fixed_source: false, fixed_evaluation_files: false, prepared_data: false }
    const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, ...(process.env.CUDA_VISIBLE_DEVICES ? { CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES } : {}) }
    try { const r = await execute('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 5000, env, signal }); checks.nvidia_gpu = Boolean(r.stdout.trim()) } catch {}
    try { await execute('uv', ['--version'], { timeout: 5000, env, signal }); checks.uv = true } catch {}
    try { const r = await execute('git', ['rev-parse', 'HEAD'], { cwd: workspace, timeout: 5000, env, signal }); checks.fixed_source = r.stdout.trim() === trainingCommit } catch {}
    if (checks.fixed_source) try {
      await execute('git', ['diff', '--exit-code', trainingCommit, '--', ...fixedTrainingFiles], { cwd: workspace, timeout: 5000, env, signal })
      checks.fixed_evaluation_files = true
    } catch {}
    if (checks.fixed_source && checks.uv && checks.nvidia_gpu) try { await execute('uv', ['run', '--no-sync', 'python', '-c', 'import torch; assert torch.cuda.is_available()'], { cwd: workspace, timeout: 20_000, env, signal }); checks.pytorch_cuda = true } catch {}
    try {
      const cache = join(env.HOME, '.cache/autoresearch')
      const shards = (await readdir(join(cache, 'data'))).filter(file => /^shard_\d{5}\.parquet$/.test(file))
      const required = [join(cache, 'tokenizer/tokenizer.pkl'), join(cache, 'tokenizer/token_bytes.pt'), ...shards.map(file => join(cache, 'data', file))]
      checks.prepared_data = shards.includes('shard_06542.parquet') && shards.length >= 2 && (await Promise.all(required.map(path => stat(path)))).every(value => value.isFile() && value.size > 0)
    } catch {}
    signal.throwIfAborted()
    return { workspace, env, checks, ready: Object.values(checks).every(Boolean) }
  }
  async function trainingInputs(workspace: string, home: string) {
    const cache = join(home, '.cache/autoresearch')
    const dataFiles = (await readdir(join(cache, 'data'))).filter(file => /^shard_\d{5}\.parquet$/.test(file)).sort()
    const paths = [...fixedTrainingFiles.map(file => ['source/' + file, join(workspace, file)]),
      ...['tokenizer.pkl', 'token_bytes.pt'].map(file => ['tokenizer/' + file, join(cache, 'tokenizer', file)]),
      ...dataFiles.map(file => ['data/' + file, join(cache, 'data', file)])]
    return Object.fromEntries(await Promise.all(paths.map(async ([key, path]) => [key, await fileDigest(path)])))
  }
  const processAlive = (pid: unknown) => {
    if (!Number.isInteger(pid) || Number(pid) < 1) return false
    try { process.kill(Number(pid), 0); return true } catch (error: any) { return error.code !== 'ESRCH' }
  }
  async function restoreTrainingScript(id: string, value: any, workspace: string) {
    const file = value.best ? 'best-train.py' : 'attempt-0/train.py'
    const script = await readFile(join(base, id, file), 'utf8')
    const expected = value.best?.script_sha256 ?? value.attempts[0]?.script_sha256
    if (digest(script) !== expected) throw new Error('回退源码摘要不匹配，需要人工核对')
    await writeFile(join(workspace, 'train.py'), script)
  }
  async function trainingStatus(id: string, session: string) {
    const value = await state(id, session)
    const active = value.attempts?.find((attempt: any) => attempt.status === 'running')
    // 进程仍活跃时只查询；重启后确认原进程已经消失才恢复已记录的代码。
    if (active && !processAlive(active.owner_pid) && !processAlive(active.process_id)) {
      active.status = 'interrupted'; active.failure = 'process-ended-without-receipt'; active.finished_at = new Date().toISOString()
      try { await restoreTrainingScript(id, value, value.workspace); active.rollback = 'restored' }
      catch { active.rollback = 'needs-intervention' }
      await save(id, value)
      const directory = join(base, id, `attempt-${active.index}`)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'failure.txt'), '训练进程结束但没有完整回执；保留原尝试并按既有代码摘要回退。')
      const rows = value.attempts.map((attempt: any) => [attempt.script_sha256, attempt.val_bpb ?? '', attempt.status, attempt.kind].join('\t'))
      await writeFile(join(base, id, 'results.tsv'), 'source_sha256\tval_bpb\tstatus\tkind\n' + rows.join('\n') + '\n')
      try {
        const lock = JSON.parse(await readFile(join(base, 'training.lock'), 'utf8'))
        if (lock.run_id === id && !processAlive(lock.owner_pid)) await unlink(join(base, 'training.lock'))
      } catch {}
    }
    return { ...value, resumable: Boolean(value.best) && value.candidates_used < 3 && Date.now() - Date.parse(value.created_at) < 60 * 60_000
      && !value.attempts?.some((attempt: any) => attempt.status === 'running') && !value.fixed_inputs_changed,
      note: '恢复不会重置候选次数和任务时限；未知进程不重复启动。' }
  }
  async function training(args: any, session: string, signal: AbortSignal) {
    if (args.action === 'status') return trainingStatus(args.run_id || '', session)
    if (!['preflight', 'baseline', 'candidate'].includes(args.action)) throw new Error('训练动作必须为preflight、baseline、candidate或status')
    const indexPath = join(base, 'training-session-' + digest(session) + '.json')
    let existing: any
    try { existing = JSON.parse(await readFile(indexPath, 'utf8')) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    if (args.action === 'baseline' && existing) throw new Error(`本 Session 已使用一次基线；请用 status 查询 ${existing.run_id}，不能重新开始以重置预算`)
    let value = args.action === 'candidate' ? await state(args.run_id || '', session) : undefined
    if (value && (existing?.run_id !== args.run_id || value.source_kind !== 'real_training')) throw new Error('候选必须属于本 Session 已登记的训练任务')
    if (value?.fixed_inputs_changed || value?.attempts?.some((attempt: any) => attempt.status === 'running')) throw new Error('先前训练或固定输入状态未确认，先查询 status，不能重复发起')
    if (value && (!value.best || value.candidates_used >= 3)) throw new Error('必须先有有效基线，且候选实验最多三次')
    if (value && Date.now() - Date.parse(value.created_at) >= 60 * 60_000) throw new Error('训练任务总时限已到')
    const preflight = await trainingPreflight(signal)
    if (args.action === 'preflight' || !preflight.ready) return { ready: preflight.ready, checks: preflight.checks,
      status: preflight.ready ? 'ready' : 'training-resource-unavailable', inference_api_is_training_backend: false,
      fixed_source: trainingCommit, required_next: '在实例HOME/autoresearch准备已审阅的固定来源、依赖及训练/验证数据；预检全部通过后才允许baseline和candidate。没有训练执行回执时不生成训练指标。' }
    if (args.action === 'candidate' && (typeof args.train_py !== 'string' || !args.train_py.trim() || Buffer.byteLength(args.train_py) > 128 * 1024)) throw new Error('候选必须提供不超过128KiB的train.py')
    if (args.action === 'candidate' && /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+)\b/.test(args.train_py)) throw new Error('训练源码不能包含API密钥或访问凭据')
    await mkdir(base, { recursive: true })
    const lockPath = join(base, 'training.lock')
    let lock
    try { lock = await open(lockPath, 'wx') } catch (error: any) { if (error.code === 'EEXIST') throw new Error('训练工作区已占用或存在未确认的中断，请先查询原任务状态'); throw error }
    const id = args.action === 'baseline' ? `task-${randomUUID()}` : args.run_id
    await lock.writeFile(JSON.stringify({ run_id: id, owner_pid: process.pid }))
    try {
      // 同一目录的train.py是共享执行入口，必须在独占锁内重读状态和核对冻结输入。
      if (args.action === 'candidate') value = await state(id, session)
      const script = join(preflight.workspace, 'train.py')
      const previous = await readFile(script, 'utf8')
      const frozen = await trainingInputs(preflight.workspace, preflight.env.HOME)
      if (args.action === 'baseline') {
        const upstream = await execute('git', ['show', `${trainingCommit}:train.py`], { cwd: preflight.workspace, env: preflight.env, timeout: 5000, signal })
        if (digest(previous) !== digest(upstream.stdout)) throw new Error('基线train.py必须与固定上游版本一致')
        value = { session_id: session, source_kind: 'real_training', created_at: new Date().toISOString(), workspace: preflight.workspace,
          fixed_source: trainingCommit, fixed_inputs: frozen, attempts: [], best: null, candidates_used: 0 }
        await save(id, value)
        await writeFile(indexPath, JSON.stringify({ run_id: id }), { flag: 'wx' })
      } else {
        if (JSON.stringify(frozen) !== JSON.stringify(value.fixed_inputs)) throw new Error('固定评估、数据或依赖与基线不一致，不能比较指标')
        if (digest(previous) !== value.best.script_sha256) throw new Error('当前训练代码与已保留版本不一致，需要先核对')
        if (value.candidates_used >= 3) throw new Error('候选实验最多三次')
      }
      const remaining = 60 * 60_000 - (Date.now() - Date.parse(value.created_at))
      if (remaining <= 0) throw new Error('训练任务总时限已到')
      const attempt: any = { index: value.attempts.length, kind: args.action, status: 'running', owner_pid: process.pid,
        started_at: new Date().toISOString(), script_sha256: digest(args.action === 'candidate' ? args.train_py : previous) }
      if (args.action === 'candidate') value.candidates_used++
      value.attempts.push(attempt); await save(id, value)
      const attemptPath = join(base, id, `attempt-${attempt.index}`); await mkdir(attemptPath, { recursive: true })
      await writeFile(join(attemptPath, 'train.py'), args.action === 'candidate' ? args.train_py : previous)
      let accepted = false
      try {
        if (args.action === 'candidate') await writeFile(script, args.train_py)
        const result = await execute('uv', ['run', '--no-sync', 'train.py'], { cwd: preflight.workspace, env: preflight.env, signal, timeout: Math.min(600_000, remaining),
          onSpawn: async pid => { attempt.process_id = pid; await save(id, value) } })
        await writeFile(join(attemptPath, 'stdout.log'), safeTrainingLog(result.stdout)); await writeFile(join(attemptPath, 'stderr.log'), safeTrainingLog(result.stderr))
        const after = await trainingInputs(preflight.workspace, preflight.env.HOME)
        if (JSON.stringify(after) !== JSON.stringify(value.fixed_inputs)) { value.fixed_inputs_changed = true; throw new Error('固定评估、数据或依赖发生变化，本次指标不接受') }
        if (digest(await readFile(script, 'utf8')) !== attempt.script_sha256) throw new Error('运行期间train.py发生变化，本次指标不接受')
        const metrics = [...result.stdout.matchAll(/^val_bpb:\s*([0-9]+(?:\.[0-9]+)?)\s*$/gm)]
        if (metrics.length !== 1 || !Number.isFinite(Number(metrics[0][1]))) throw new Error('真实训练未返回唯一有效val_bpb')
        attempt.val_bpb = Number(metrics[0][1]); attempt.metric_source = 'executed_train_stdout'
        const improved = !value.best || attempt.val_bpb < value.best.val_bpb
        if (improved) { await writeFile(join(base, id, 'best-train.py'), await readFile(script)); value.best = { index: attempt.index, val_bpb: attempt.val_bpb, script_sha256: attempt.script_sha256 } }
        accepted = improved; attempt.status = accepted ? 'keep' : 'discard'
      } catch (error: any) {
        attempt.status = signal.aborted ? 'cancelled' : 'failed'; attempt.failure = error.code || error.name || 'training-error'
        // 退出非零时同样复核固定输入，不能把候选已修改的评估文件当作下一轮基准。
        try { if (JSON.stringify(await trainingInputs(preflight.workspace, preflight.env.HOME)) !== JSON.stringify(value.fixed_inputs)) value.fixed_inputs_changed = true }
        catch { value.fixed_inputs_changed = true }
        if (error.stdout !== undefined) await writeFile(join(attemptPath, 'stdout.log'), safeTrainingLog(error.stdout))
        if (error.stderr !== undefined) await writeFile(join(attemptPath, 'stderr.log'), safeTrainingLog(error.stderr))
        else await writeFile(join(attemptPath, 'failure.txt'), safeTrainingLog(error.message))
      } finally {
        if (!accepted) { await writeFile(script, previous); attempt.rollback = 'restored' }
        attempt.finished_at = new Date().toISOString(); await save(id, value)
        const rows = value.attempts.map((a: any) => [a.script_sha256, a.val_bpb ?? '', a.status, a.kind].join('\t'))
        await writeFile(join(base, id, 'results.tsv'), 'source_sha256\tval_bpb\tstatus\tkind\n' + rows.join('\n') + '\n')
      }
      return { run_id: id, attempt, best: value.best, candidates_used: value.candidates_used, max_candidates: 3, source_kind: 'real_training',
        fixed_inputs_changed: Boolean(value.fixed_inputs_changed), metric_source: 'executed_train_stdout', independently_evaluated: false,
        results_url: artifactUrl(id, 'results.tsv'),
        ...(value.best ? { best_code_url: artifactUrl(id, 'best-train.py') } : {}),
        artifacts: ['results.tsv', ...(value.best ? ['best-train.py'] : []), `attempt-${attempt.index}/stdout.log`] }
    } finally { await lock.close(); await unlink(lockPath) }
  }
  // 使用原生 Fetch 入口，保留实例认证和子路径适配。
  ctx.connection.fetch.register({ path: '/api/task-examples/artifact', methods: ['GET'], requestBody: 'buffered', fetch: async (request: Request) => {
    try {
      const url = new URL(request.url), id = url.searchParams.get('run_id') || '', file = url.searchParams.get('file') || ''
      const allowedFile = ['report.md', 'devices.csv', 'results.tsv', 'best-train.py'].includes(file) || /^attempt-(?:0|[1-9]\d*)\/(?:stdout\.log|stderr\.log|failure\.txt|train\.py)$/.test(file)
      if (!runPattern.test(id) || !allowedFile) return new Response('参数无效', { status: 400 })
      const metadata = JSON.parse(await readFile(join(base, id, 'state.json'), 'utf8'))
      if (!metadata.session_id || metadata.run_id !== id) return new Response('任务记录无效', { status: 404 })
      const bytes = await readFile(join(base, id, file))
      return new Response(bytes, { headers: { 'content-type': file.endsWith('.csv') ? 'text/csv; charset=utf-8' : file.endsWith('.tsv') ? 'text/tab-separated-values; charset=utf-8' : file.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${id}-${file}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    } catch { return new Response('产物尚不存在', { status: 404 }) }
  } })
  const taskLocks = new Map<string, Promise<unknown>>()
  async function serializeTask(key: string, operation: () => Promise<unknown>) {
    const previous = taskLocks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    taskLocks.set(key, current)
    try { return await current } finally { if (taskLocks.get(key) === current) taskLocks.delete(key) }
  }
  ctx.tools.register({ name: `task_${config.kind}`, description: config.kind === 'inspection'
    ? '基础资产台账只读巡检：start固定资产快照，page按cursor读完分页，report校验已读取完整集合并生成实际Markdown/CSV报告。数据来自基础Mock，不能称为真实设备健康检测。'
    : config.kind === 'research' ? '多步骤资料研究：start创建任务，collect按明确配置读取在线正文或校验本地固定官方资料快照，report用comparison给出跨来源比较结论、summaries保留各URL的相关依据，生成带来源的报告；资料须全部读取，不自动切换数据来源。'
      : '自主训练研究：preflight核查真实GPU、固定来源、uv/PyTorch与数据；baseline建立一次真实基线，candidate只修改train.py并实际训练评估，最多三个候选、单次十分钟、总时限一小时。更优保留、失败回退，status读取原运行。没有真实算力时只报告缺口，不产生模拟指标。',
    parameters: { type: 'object', properties: config.kind === 'research' ? { ...columns, comparison: { type: 'string', description: 'report必填：综合全部已读来源，横向比较用途、任务机制、运行与许可前提，给出当前平台可借鉴及不可直接采用的结论；不是两份摘要的重复拼接。' } } : columns, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args: any, execution: any) {
      return serializeTask(args.run_id || execution.agent.session.header.id, async () => {
      const session = execution.agent.session.header.id, signal = execution.signal
      if (config.kind === 'training') {
        return training(args, session, signal)
      }
      if (args.action === 'start') {
        const id = `task-${randomUUID()}`
        const value: any = { session_id: session, created_at: new Date().toISOString(), source_kind: config.kind === 'inspection' ? 'basic_mock' : 'live_public_documents', read: [] }
        if (config.kind === 'inspection') {
          const all = JSON.parse(await get(config.assetUrl || 'http://127.0.0.1:53001/api/v1/assets', signal))
          if (!Array.isArray(all)) throw new Error('资产接口未返回列表')
          value.rows = all.filter((r: any) => /^asset-000[1-5]$/.test(r.asset_id)).map((r: any): Row => ({ asset_id: r.asset_id, hostname: r.hostname, asset_type: r.asset_type, risk_score: r.risk_score }))
          if (value.rows.length !== 5 || new Set(value.rows.map((r: Row) => r.asset_id)).size !== 5) throw new Error('固定基础资产范围不完整，不能生成全量报告')
          value.source_sha256 = digest(JSON.stringify(value.rows))
        } else if (config.sourceDocuments !== undefined) {
          if (config.sourceUrls !== undefined || !config.sourceDocuments.length || config.sourceDocuments.some(document => !/^https:\/\//.test(document.url) || !/^references\/[a-z0-9-]+\.md$/.test(document.path) || !/^[0-9a-f]{64}$/.test(document.sha256))
            || new Set(config.sourceDocuments.map(document => document.url)).size !== config.sourceDocuments.length) throw new Error('固定资料快照配置无效，不能与在线来源同时配置')
          value.source_kind = 'fixed_public_document_snapshot'
          value.source_documents = config.sourceDocuments.map(document => ({ ...document }))
          value.sources = value.source_documents.map((document: SourceDocument) => document.url)
        } else value.sources = config.sourceUrls || []
        await save(id, value)
        return { run_id: id, source_kind: value.source_kind, ...(value.rows ? { total: value.rows.length, next_cursor: 0, source_sha256: value.source_sha256 } : { sources: value.sources }) }
      }
      const id = args.run_id || '', value = await state(id, session)
      if (args.action === 'status') return { run_id: id, read: value.read, completed: Boolean(value.completed_at), source_kind: value.source_kind }
      if (config.kind === 'inspection' && args.action === 'page') {
        const cursor = args.cursor
        if (!Number.isInteger(cursor) || cursor < 0 || cursor >= value.rows.length || cursor % 2) throw new Error('分页cursor无效')
        const rows = value.rows.slice(cursor, cursor + 2)
        value.read = [...new Set([...value.read, ...rows.map((r: Row) => r.asset_id)])]
        await save(id, value)
        return { run_id: id, rows, next_cursor: cursor + 2 < value.rows.length ? cursor + 2 : null, total: value.rows.length, source_kind: value.source_kind }
      }
      if (config.kind === 'inspection' && args.action === 'report') {
        const missing = value.rows.filter((r: Row) => !value.read.includes(r.asset_id)).map((r: Row) => r.asset_id)
        if (missing.length) throw new Error(`尚未读取全部设备，不能交付完整报告；缺少 ${missing.join('、')}`)
        const rows: Row[] = value.rows
        const text = `# 基础资产台账巡检报告\n\n来源：基础模拟接口，未连接或检测真实设备。\n\n运行：${id}\n\n设备总数：${rows.length}\n\n| 设备ID | 状态 | 名称 | 类型 | 台账风险分值 |\n| --- | --- | --- | --- | --- |\n${rows.map(r => `| ${r.asset_id} | 台账已记录 | ${safeCell(r.hostname)} | ${safeCell(r.asset_type)} | ${r.risk_score} |`).join('\n')}\n\n摘要：已核对全部 ${rows.length} 台指定基础资产的台账记录；本报告不提供实时设备健康结论。\n`
        const csv = 'device_id,status,hostname,asset_type,risk_score\n' + rows.map(r => [r.asset_id, '台账已记录', r.hostname, r.asset_type, r.risk_score].map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\n') + '\n'
        return { ...await report(id, value, text, csv), device_count: rows.length, device_ids: rows.map(r => r.asset_id) }
      }
      if (config.kind === 'research' && args.action === 'collect') {
        if (!value.sources.includes(args.source)) throw new Error('资料不在本任务固定来源范围内')
        if (value.documents?.[args.source]) return { run_id: id, source: args.source, source_kind: value.source_kind, ...value.documents[args.source], reused_snapshot: true }
        const document = value.source_documents?.find((item: SourceDocument) => item.url === args.source)
        if (value.source_kind === 'fixed_public_document_snapshot' && !document) throw new Error('固定资料登记缺失；未尝试联网替代')
        const content = document ? await readSourceDocument(document) : await get(args.source, signal)
        value.documents ||= {}; value.documents[args.source] = { sha256: digest(content), content: content.slice(0, 24_000), read_at: new Date().toISOString() }
        value.read = [...new Set([...value.read, args.source])]; await save(id, value)
        return { run_id: id, source: args.source, source_kind: value.source_kind, ...value.documents[args.source], truncated: content.length > 24_000 }
      }
      if (config.kind === 'research' && args.action === 'report') {
        if (!value.sources.length || value.sources.some((url: string) => !value.read.includes(url))) throw new Error('还有资料未读取，不能交付完整报告')
        if (value.sources.some((url: string) => typeof args.summaries?.[url] !== 'string' || !args.summaries[url].trim())) throw new Error('报告须逐项包含已读来源的结论')
        if (typeof args.comparison !== 'string' || !args.comparison.trim()) throw new Error('报告须包含跨来源比较结论，不能仅拼接逐项摘要')
        value.comparison = args.comparison.trim()
        value.summaries = Object.fromEntries(value.sources.map((url: string) => [url, args.summaries[url].trim()]))
        const basis = value.source_kind === 'fixed_public_document_snapshot' ? '本报告依据已校验摘要的官方固定提交资料快照；资料时点以各原始链接中的提交为准，本次没有实时访问网站。' : '本报告依据本次实际读取的在线资料；读取时点见各来源。'
        const text = '# 多步骤业务资料调研报告\n\n## 比较结论\n\n' + value.comparison + '\n\n' + basis + '\n\n## 来源要点与依据\n\n' + value.sources.map((url: string, i: number) => `### 来源 ${i + 1}\n\n${value.summaries[url]}\n\n来源：[原始资料](${url})；读取时间：${value.documents[url].read_at}；摘要：${value.documents[url].sha256}\n`).join('\n')
        return { ...await report(id, value, text), source_count: value.sources.length, note: '已完成来源完整性校验；语义准确性需由独立评测核对。' }
      }
      throw new Error('本业务不支持此动作')
      })
    },
  })
}
