import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { managedState, ownsPort, processBirth, restoreManagedProcess } from '../lifecycle.mts'
import { workspaceIdentity, instanceStateRoot, workspaceLocalPath, workspaceOwnsCwd, mcpLocalPath } from '../plugin/src/workspace.ts'

export type UpdateOptions = { programRoot: string; dataRoot: string; dryRun?: boolean; interruptSessions?: boolean; clientOnly?: boolean }
type ServiceState = NonNullable<ReturnType<typeof managedState>>
export type BusyItem = { kind: string; id: string; state: string }
export type UpdateInspection = {
  state: ServiceState; workspaceId: string; environment: NodeJS.ProcessEnv; busy: BusyItem[]
  command?: string[]
  pendingActivation?: boolean
  overlay?: { path: string; text: string }; extensions?: Array<{ entry: string; output: string }>
}
export type UpdateEntry = { source: string; target: string }
export interface UpdateServices {
  inspect(options: UpdateOptions): Promise<UpdateInspection>
  build(options: UpdateOptions, stage: string, inspection: UpdateInspection): Promise<UpdateEntry[]>
  lifecycle(action: 'stop' | 'start' | 'restore', options: UpdateOptions, inspection: UpdateInspection): Promise<void>
  verify(options: UpdateOptions): Promise<UpdateInspection>
}
export type UpdateReport = {
  status: 'planned' | 'busy' | 'unchanged' | 'applied' | 'failed'; programRoot: string; dataRoot: string; workspaceId: string
  pid: number; activation: 'none' | 'native-hmr' | 'next-sdk-operation' | 'managed-restart'; busy: BusyItem[]
  changed: string[]; stage?: string; receipt?: string; error?: string; recovery?: 'verified' | 'unknown'
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const sha = (path: string) => existsSync(path) ? hash(readFileSync(path)) : null
function atomic(path: string, value: string | Uint8Array, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.update-${process.pid}-${randomUUID()}`
  try { writeFileSync(temporary, value, { mode }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}
function files(path: string): string[] {
  if (!existsSync(path)) return []
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`更新来源不能是符号链接：${path}`)
  return stat.isDirectory() ? readdirSync(path).sort().filter(name => !['node_modules', '.git', '__pycache__'].includes(name)).flatMap(name => files(join(path, name))) : stat.isFile() ? [path] : []
}
function sourceSnapshot(options: UpdateOptions) {
  const roots = ['platform/plugin/src', 'platform/plugin/assets', 'platform/plugin/business', 'platform/mcp/lfx', 'plugins/mcp-manager', 'runtime/adapters/dsh-web/src', 'platform/profile']
  const selected = roots.flatMap(path => files(join(options.programRoot, path)))
  for (const folder of ['platform/plugin', 'runtime/adapters/dsh-web']) for (const name of ['package.json', 'pnpm-lock.yaml', 'build.mjs']) selected.push(join(options.programRoot, folder, name))
  for (const name of ['platform/dsh-platform-internal.py', 'platform/dsh-platform', 'platform/lifecycle.mts', 'platform/deploy/update.mts']) selected.push(join(options.programRoot, name))
  for (const name of ['workspace.json', 'AGENTS.md']) if (existsSync(join(options.dataRoot, name))) selected.push(join(options.dataRoot, name))
  for (const extension of options.clientOnly ? [] : json(join(options.dataRoot, 'workspace.json')).extensions ?? []) {
    const directory = resolve(options.dataRoot, extension.path)
    if (!directory.startsWith(options.dataRoot + '/') || !(extension.path === 'mcp' || extension.path.startsWith('extensions/'))) throw new Error('扩展路径不属于当前数据根')
    selected.push(...files(join(directory, 'src')), join(directory, 'build.mjs'), join(directory, 'package.json'))
    if (extension.path === 'mcp') for (const entry of readdirSync(join(directory, 'compositions'))) {
      selected.push(...files(join(directory, 'compositions', entry, 'src')))
      const flow = join(directory, 'compositions', entry, 'flow.json'); if (existsSync(flow)) selected.push(flow)
    }
  }
  return hash([...new Set(selected)].sort().map(path => `${path}\0${sha(path)}`).join('\n'))
}
function liveSnapshot(options: UpdateOptions) {
  if (options.clientOnly) {
    const path = join(options.programRoot, 'platform/plugin/lib/client.js')
    return Object.fromEntries(files(path).map(file => [file, sha(file)]))
  }
  const overlay = join(options.dataRoot, '.local/platform-home/profiles/harness-platform/harness-platform.patch.yml')
  const activeExtensions = existsSync(overlay) ? readFileSync(overlay, 'utf8').split('\n').flatMap(line => {
    const value = line.match(/^\s+name: (.+)$/)?.[1]
    if (!value?.includes('/.local/build-cache/')) return []
    const path = JSON.parse(value)
    if (typeof path !== 'string' || ![join(options.dataRoot, '.local/build-cache'), join(options.dataRoot, 'mcp/.local/build-cache')].some(root => path.startsWith(root + '/'))) throw new Error('已加载扩展缓存不属于当前数据根')
    return files(dirname(path))
  }) : []
  return Object.fromEntries([
    ...files(join(options.programRoot, 'platform/plugin/lib')),
    ...files(join(options.programRoot, 'runtime/adapters/dsh-web/lib')),
    ...['runtime.js', 'mcp-manager.js'].map(name => join(options.programRoot, 'platform/plugin/business', name)).filter(existsSync),
    ...files(join(options.dataRoot, '.local/platform-home/profiles/harness-platform')).filter(path => !path.includes('/node_modules/') && !path.endsWith('/node_modules')),
    ...activeExtensions,
  ].map(path => [path, sha(path)]))
}
function extensionSnapshot(inspection: UpdateInspection) {
  return Object.fromEntries((inspection.extensions ?? []).flatMap(extension => files(extension.output)).map(path => [path, sha(path)]))
}
function sameSnapshot(before: Record<string, string | null>, after: Record<string, string | null>) { return JSON.stringify(before) === JSON.stringify(after) }
function processEnvironment(pid: number): NodeJS.ProcessEnv {
  return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
}
function command(program: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log?: string; timeout?: number }) {
  const result = spawnSync(program, args, { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: options.timeout ?? 120_000, maxBuffer: 16 * 1024 * 1024 })
  if (options.log) writeFileSync(options.log, (result.stdout ?? '') + (result.stderr ?? ''), { mode: 0o600 })
  if (result.error || result.status !== 0) throw new Error(`更新步骤未完成：${program.split('/').at(-1)}（退出码 ${result.status ?? 'unknown'}）${options.log ? `；详见 ${options.log}` : ''}`)
  return result.stdout
}
function preparedProfile(options: UpdateOptions, environment: NodeJS.ProcessEnv) {
  for (const directory of ['platform/plugin', 'runtime/adapters/dsh-web']) {
    const root = join(options.programRoot, directory)
    if (sha(join(root, 'pnpm-lock.yaml')) !== sha(join(root, 'node_modules/.pnpm/lock.yaml')) || !sha(join(root, 'pnpm-lock.yaml'))) throw new Error('已装依赖与锁文件不符；请先完成平台 prepare，当前更新未应用')
  }
  if (options.clientOnly) return {}
  // 只调用现有渲染与兼容检查，不调用会修改运行目录的 prepare。
  const script = `import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('platform_update_source',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nhome=m.platform_home();m.global_dsh(home);r=m.rendered_profile();p=home/'profiles'/m.PROFILE_NAME\na=(p/'package.json').read_text();r['package.json']=m.merged_profile_manifest(a,r['package.json'])\nassert json.loads(a)==json.loads(r['package.json']), 'Profile依赖合同变化，需要prepare'\nassert (p/'pnpm-workspace.yaml').read_text()==r['pnpm-workspace.yaml'], 'Profile模板变化，需要prepare'\nassert (p/'node_modules/@ai-agent-harness/harness-platform').resolve()==m.PLUGIN, 'Profile程序链接不符'\nassert m.normalized_mcp_patch(p)==(p/'cordis.patch.yml').read_text(), '用户Patch需要prepare'\nprint(json.dumps({'overlay':r[m.PLATFORM_PATCH],'extensions':[{'entry':str(m.asset_root()/e['path']/'build.mjs'),'output':str(m.extension_output(e,path_only=True))} for e in m.workspace_extensions()]}))\n`
  const value = JSON.parse(command(environment.HARNESS_PYTHON || '/usr/bin/python3.10', ['-c', script, join(options.programRoot, 'platform/dsh-platform-internal.py')], { cwd: options.programRoot, env: environment }))
  const path = join(options.dataRoot, '.local/platform-home/profiles/harness-platform/harness-platform.patch.yml')
  // 依赖与 Runtime 合同已在上方核对；渲染后的模板与程序制品一起暂存、应用和回滚。
  return { overlay: { path, text: value.overlay as string }, extensions: value.extensions as Array<{ entry: string; output: string }> }
}

/** 只读取已有会话与操作，不创建管理任务。凭据仅留在本次HTTP连接内。 */
export async function readUpdateActivity(options: UpdateOptions, state: ServiceState, workspaceId: string): Promise<BusyItem[]> {
  const url = new URL(state.publicUrl ?? state.url), account = json(join(options.dataRoot, '.local/credentials/admin.json'))
  const request = { redirect: 'error' as const, signal: AbortSignal.timeout(30_000) }
  // 启停通过同步子进程执行，旧连接的关闭事件可能尚未处理；核验不得复用上一进程的连接。
  const headers = { origin: url.origin, connection: 'close' }
  const authenticate = () => fetch(new URL('login', url), { ...request, signal: AbortSignal.timeout(30_000), redirect: 'manual', method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: account.username, password: account.password }) })
  let login = await authenticate()
  // 启动器可先返回 bootstrap；认证路由尚未装载时等待，不把错误凭据当成启动延迟。
  for (let attempt = 0; attempt < 60 && [404, 503].includes(login.status); attempt++) {
    await login.body?.cancel(); await delay(500); login = await authenticate()
  }
  const cookieName = `dsh-auth-${createHash('sha256').update(url.host).digest('base64url')}`
  const cookie = login.headers.getSetCookie().filter(value => value.startsWith(`${cookieName}=`) || value.startsWith('harness_platform_session=') && !/Max-Age=0(?:;|$)/i.test(value)).map(value => value.split(';')[0]).join('; ')
  if (login.status !== 303 || !cookie) throw new Error(`更新前平台认证失败（HTTP ${login.status}），未应用`)
  async function rpc(endpoint: string, payload: object, native = false) {
    const response = await fetch(new URL(`${native ? 'api' : 'harness-platform'}/${endpoint}`, url), { ...request, signal: AbortSignal.timeout(native ? 120_000 : 30_000), method: 'POST', headers: { ...headers, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: `platform-update-${randomUUID()}`, method: endpoint, payload }) })
      .catch(error => { throw new Error(`更新前只读核对失败：${endpoint}（${error.cause?.code ?? error.name}）`) })
    if (!response.ok) throw new Error(`更新前只读核对失败：${endpoint} HTTP ${response.status}`)
    const value = await response.json() as any
    if (value?.result?.ok !== true) throw new Error(`更新前只读核对失败：${endpoint}`)
    return value.result.value
  }
  const inventory = await rpc('inventory', {})
  if (inventory?.root !== options.dataRoot || inventory.workspace?.id !== workspaceId || inventory.workspace?.root !== options.dataRoot) throw new Error('在线工作区身份不符，未应用')
  // 仅客户端更新保留所有会话；无需扫描不会阻塞这次更新的历史记录。
  const [sessions, evaluations, operations] = await Promise.all([options.clientOnly || options.interruptSessions ? Promise.resolve({ items: [] }) : rpc('session/list', { args: { _request: {} } }, true), rpc('agents/eval/list', {}), rpc('agents/sdk/list', {})])
  const evaluationRuns = Array.isArray(evaluations?.runs) ? [...evaluations.runs, ...(Array.isArray(evaluations.pending) ? evaluations.pending : [])] : evaluations?.jobs
  if (!Array.isArray(sessions?.items) || !Array.isArray(evaluationRuns) || !Array.isArray(operations)
    || evaluations?.pending !== undefined && !Array.isArray(evaluations.pending)
    || evaluations?.errors !== undefined && !Array.isArray(evaluations.errors)) throw new Error('在途状态响应不完整，不能判断为空闲')
  for (const error of evaluations.errors ?? []) {
    // 历史 Run 的证据读取失败与进程在途分开核对，避免阻塞修复读取器本身。
    const id = /^evaluation-jobs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(error.path ?? '')?.[1]
    let finished = false
    try {
      const path = join(workspaceLocalPath(options.dataRoot, 'evaluation-jobs'), `${id}.json`)
      const job = json(path)
      const birth = Number.isInteger(job.pid) && job.pid > 1 ? processBirth(job.pid) : undefined
      finished = !!id && error.code === 'run_read_failed' && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()
        && job.schema_version === undefined && job.job_id === id && job.workspace_id === workspaceId && workspaceOwnsCwd(options.dataRoot, job.asset_root)
        && ['completed', 'failed', 'cancelled'].includes(job.status) && Number.isInteger(job.pid) && job.pid > 1
        && typeof job.process_start === 'string' && /^\d+$/.test(job.process_start)
        && (!existsSync(`/proc/${job.pid}`) || !!birth && birth !== job.process_start)
    } catch {}
    if (!finished) throw new Error('评测状态存在未核对项，不能判断为空闲')
  }
  const busy: BusyItem[] = options.clientOnly ? [{ kind: 'session', id: '*', state: 'client-update-preserved-not-enumerated' }]
    : options.interruptSessions ? [{ kind: 'session', id: '*', state: 'interruption-authorized-not-enumerated' }] : []
  for (const session of sessions.items) {
    if (typeof session.sessionId !== 'string' || typeof session.running !== 'boolean') throw new Error('会话运行状态缺失，不能判断为空闲')
    if (session.running) busy.push({ kind: 'session', id: session.sessionId, state: 'running' })
    const hint = session.projections?.values?.harnessPlatformAssistant
    // 子会话由 DSH 子代理路由持有，继承的助手投影不是独立管理会话；运行状态仍在上方核对。
    if (hint?.workspace_id === workspaceId && session.origin !== 'subagent') {
      const current = await rpc('assistant/status', { session_id: session.sessionId })
      if (typeof current?.running !== 'boolean' || !Array.isArray(current.proposals) || !current.submissions || typeof current.submissions !== 'object') throw new Error('管理会话状态不完整，不能判断为空闲')
      if (current.running || current.proposals?.some((item: any) => item.state === 'running') || Object.values(current.submissions ?? {}).some((item: any) => ['pending', 'unknown'].includes(item.state))) busy.push({ kind: 'assistant', id: session.sessionId, state: 'pending' })
    }
  }
  for (const run of evaluationRuns) {
    const id = run.run_id ?? run.legacy_id ?? run.job_id
    if (typeof id !== 'string' || !['preparing', 'running', 'cancelling', 'unknown', 'completed', 'failed', 'cancelled'].includes(run.status)) throw new Error('评测运行状态不完整，不能判断为空闲')
    if (['preparing', 'running', 'cancelling', 'unknown'].includes(run.status)) busy.push({ kind: 'evaluation', id, state: run.status })
  }
  for (const operation of operations) {
    if (typeof operation.id !== 'string' || !['starting', 'running', 'stopping', 'completed', 'failed', 'stopped', 'unknown'].includes(operation.status)) throw new Error('SDK任务状态不完整，不能判断为空闲')
    if (['starting', 'running', 'stopping'].includes(operation.status)) busy.push({ kind: 'sdk', id: operation.id, state: operation.status })
    else if (operation.status === 'unknown') {
      let alive = false
      try { alive = !!operation.worker_pid && readFileSync(`/proc/${operation.worker_pid}/cmdline`, 'utf8').split('\0').includes(workspaceLocalPath(options.dataRoot, 'sdk-operations', operation.id)) }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('未知SDK worker的存活状态无法核对，未应用') }
      const file = join(instanceStateRoot(options.dataRoot), operation.instance_id, 'instance.json')
      if (existsSync(file)) {
        const instance = json(file)
        if (instance.sdk_operation_id === operation.id) {
          const found = spawnSync('docker', ['inspect', '--format', '{{json .State.Running}}', operation.instance_id], { encoding: 'utf8', timeout: 10_000 })
          if (found.error || found.status !== 0 && !/No such (object|container)/i.test(found.stderr)) throw new Error('未知SDK实例的存活状态无法核对，未应用')
          alive ||= found.status === 0 && found.stdout.trim() === 'true'
        }
      }
      if (alive) busy.push({ kind: 'sdk', id: operation.id, state: 'unknown-live' })
    }
  }
  const directory = mcpLocalPath(options.dataRoot, 'executions')
  let receipts: string[]
  try { receipts = readdirSync(directory).filter(name => name.endsWith('.json')).sort() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('组合执行回执目录无法读取，不能判断为空闲')
    receipts = []
  }
  for (const name of receipts) {
    let saved: { execution_id?: string; workspace_id?: string }
    try { saved = json(join(directory, name)) }
    catch { throw new Error('组合执行回执无法读取，不能判断为空闲') }
    if (!saved || saved.workspace_id !== workspaceId || typeof saved.execution_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(saved.execution_id) || `${saved.execution_id}.json` !== name) throw new Error('组合执行回执身份不符，不能判断为空闲')
    // 磁盘running可能来自已退出的旧进程，只以当前服务器的只读核对为准。
    const current = await rpc('mcp/compositionExecution', { execution_id: saved.execution_id })
    if (current?.execution_id !== saved.execution_id || current.workspace_id !== workspaceId || !['running', 'responded', 'unknown'].includes(current.state)) throw new Error('组合执行状态不完整，不能判断为空闲')
    if (current.state === 'running') busy.push({ kind: 'composition', id: saved.execution_id, state: 'running' })
  }
  const runs = join(options.dataRoot, 'mcp/.local/runs')
  if (existsSync(runs)) for (const name of readdirSync(runs).filter(name => /^run-[0-9a-f-]{36}\.json$/.test(name))) {
    const saved = json(join(runs, name))
    if (saved.engine !== 'workflow' || !['accepted', 'running'].includes(saved.status)) continue
    const current = await rpc('mcp/compositionRun', { run_id: saved.run_id })
    if (!current || current.run_id !== saved.run_id) throw new Error('工作流运行状态无法核对，未应用')
    if (['accepted', 'running'].includes(current.status)) busy.push({ kind: 'workflow', id: saved.run_id, state: current.status })
  }
  return busy
}
async function inspect(options: UpdateOptions): Promise<UpdateInspection> {
  const state = managedState(options.dataRoot, options.programRoot)
  if (!state || !state.detached || !ownsPort(state.pid, state.host, state.port)) throw new Error('更新只支持当前已启动并受管的本机平台')
  const environment = processEnvironment(state.pid)
  if (environment.HARNESS_PROGRAM_ROOT !== options.programRoot || environment.HARNESS_ASSET_ROOT !== options.dataRoot || environment.DSH_HOME !== join(options.dataRoot, '.local/platform-home') || !environment.HOME || !isAbsolute(environment.HOME)) throw new Error('进程程序根、数据根或HOME身份不符，未应用')
  const workspaceId = workspaceIdentity(options.dataRoot).id
  const prepared = preparedProfile(options, environment)
  const command = [readlinkSync(`/proc/${state.pid}/exe`), ...readFileSync(`/proc/${state.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(1)]
  // 原地构建可能先于 update；启动记录之后写入的服务端制品不能视为已装载。
  const started = statSync(join(options.dataRoot, '.local/platform-service/state.json')).mtimeMs
  const pendingActivation = !options.clientOnly && Object.keys(liveSnapshot(options)).some(path => path.endsWith('.js')
    && !['client.js', 'sdk-worker.js'].includes(path.split('/').at(-1)!) && statSync(path).mtimeMs > started)
  return { state, workspaceId, environment, command, pendingActivation, ...prepared, busy: await readUpdateActivity(options, state, workspaceId) }
}
async function build(options: UpdateOptions, stage: string, inspection: UpdateInspection): Promise<UpdateEntry[]> {
  const output = join(stage, 'artifacts'), environment = { ...inspection.environment, HEP_OFFLINE: '1' }
  const requirements = join(options.programRoot, 'platform/mcp/lfx/requirements.txt')
  if (!options.clientOnly && existsSync(requirements)) {
    const directory = join(options.programRoot, '.local/lfx', sha(requirements)!)
    const python = join(directory, 'bin/python'), ready = join(directory, '.ready')
    if (!existsSync(ready)) {
      command('uv', ['venv', '--python', '3.12', directory], { cwd: options.programRoot, env: inspection.environment, log: join(stage, 'lfx-venv.log'), timeout: 300_000 })
      command('uv', ['pip', 'sync', '--python', python, requirements], { cwd: options.programRoot, env: inspection.environment, log: join(stage, 'lfx-dependencies.log'), timeout: 300_000 })
      command(python, ['-c', 'from importlib.metadata import version; assert version("lfx") == "1.13.1"; import hep_lfx'], { cwd: join(options.programRoot, 'platform/mcp/lfx'), env: inspection.environment, log: join(stage, 'lfx-check.log') })
      writeFileSync(ready, sha(requirements)!)
    }
  }
  command(process.execPath, ['build.mjs', '--out-dir', output], { cwd: join(options.programRoot, 'platform/plugin'), env: environment, log: join(stage, 'build.log'), timeout: 300_000 })
  for (const extension of inspection.extensions ?? []) if (!existsSync(join(extension.output, 'plugin.js'))) command(process.execPath, [extension.entry], { cwd: options.programRoot, env: environment, log: join(stage, `extension-${hash(extension.entry).slice(0, 10)}.log`) })
  const entries: UpdateEntry[] = []
  for (const file of files(output)) {
    const path = relative(output, file)
    const target = path.startsWith('dsh-web/') ? join(options.programRoot, 'runtime/adapters/dsh-web/lib', path.slice(8))
      : path.startsWith('business/') ? join(options.programRoot, 'platform/plugin/business', path.slice(9)) : join(options.programRoot, 'platform/plugin/lib', path)
    if (options.clientOnly && target !== join(options.programRoot, 'platform/plugin/lib/client.js')) continue
    if (path.startsWith('business/')) writeFileSync(file, readFileSync(file, 'utf8').replaceAll("'../", "'../lib/").replaceAll('"../', '"../lib/'))
    if (path === 'composition-source-index.json') {
      const value = json(file)
      value.artifacts = [{ path: 'platform/plugin/lib/index.js', sha256: sha(join(output, 'index.js')) }]
      writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
    }
    entries.push({ source: file, target })
  }
  if (inspection.overlay) { const file = join(stage, 'harness-platform.patch.yml'); writeFileSync(file, inspection.overlay.text); entries.push({ source: file, target: inspection.overlay.path }) }
  return entries
}
async function lifecycle(action: 'stop' | 'start' | 'restore', options: UpdateOptions, inspection: UpdateInspection) {
  if (action === 'restore') { await restoreManagedProcess(inspection.state, inspection.command ?? [], inspection.environment); return }
  const args = action === 'start' ? ['start', '--host', inspection.state.host, '--port', String(inspection.state.port), '--public-url', inspection.state.publicUrl ?? inspection.state.url] : ['stop']
  command(join(options.programRoot, 'platform/dsh-platform'), args, { cwd: options.programRoot, env: inspection.environment, timeout: 120_000 })
}
const defaults: UpdateServices = { inspect, build, lifecycle, verify: inspect }

/** 本机源码制品更新；历史数据和安装清单始终由原工作区维护。 */
export async function updatePlatform(input: UpdateOptions, services: UpdateServices = defaults): Promise<UpdateReport> {
  const options = { ...input, programRoot: realpathSync(input.programRoot), dataRoot: realpathSync(input.dataRoot) }
  const observed = await services.inspect(options)
  const report: UpdateReport = { status: options.dryRun ? 'planned' : 'unchanged', programRoot: options.programRoot, dataRoot: options.dataRoot, workspaceId: observed.workspaceId, pid: observed.state.pid, activation: 'none', busy: observed.busy, changed: [] }
  if (options.dryRun) { if (observed.busy.length && !options.clientOnly) report.status = 'busy'; return report }
  const base = join(options.programRoot, '.local/platform-updates'), lock = join(base, 'update.lock')
  mkdirSync(base, { recursive: true, mode: 0o700 })
  try { mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, birth: processBirth(process.pid) })) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let stale = false
    try { const owner = json(join(lock, 'owner.json')); stale = !!owner.birth && processBirth(owner.pid) !== owner.birth } catch { /* 不清理来源未知的锁。 */ }
    if (!stale) throw new Error('另一个平台更新仍在执行，请稍后重试')
    rmSync(lock, { recursive: true }); return updatePlatform(input, services)
  }
  const stage = join(base, randomUUID()); mkdirSync(stage, { mode: 0o700 }); report.stage = stage
  let stopped = false, applied = false
  const backups: Array<{ target: string; path: string; mode: number; existed: boolean }> = []
  try {
    const source = sourceSnapshot(options), live = liveSnapshot(options)
    const entries = await services.build(options, stage, observed)
    if (options.clientOnly && entries.some(entry => entry.target !== join(options.programRoot, 'platform/plugin/lib/client.js'))) throw new Error('仅客户端更新包含其他目标，未应用')
    const staged = entries.map(entry => sha(entry.source)), extensions = extensionSnapshot(observed)
    if (sourceSnapshot(options) !== source || !sameSnapshot(liveSnapshot(options), live)) throw new Error('源码、Profile或运行制品在构建期间变化；保留构建结果，未应用')
    const current = await services.inspect(options)
    if (current.state.pid !== observed.state.pid || current.state.birth !== observed.state.birth || current.workspaceId !== observed.workspaceId) throw new Error('受管进程在构建期间变化，未应用')
    report.busy = current.busy
    if (JSON.stringify(current.overlay) !== JSON.stringify(observed.overlay) || JSON.stringify(current.extensions) !== JSON.stringify(observed.extensions)) throw new Error('生成Profile来源在更新准备期间变化；保留构建结果，未应用')
    if (sourceSnapshot(options) !== source || !sameSnapshot(liveSnapshot(options), live) || !sameSnapshot(extensionSnapshot(observed), extensions) || entries.some((entry, index) => sha(entry.source) !== staged[index])) throw new Error('应用前来源或制品摘要变化；保留构建结果，未应用')
    const changed = entries.filter(entry => sha(entry.source) !== sha(entry.target))
    report.changed = changed.map(entry => relative(options.programRoot, entry.target))
    const pendingActivation = !options.clientOnly && current.pendingActivation
    if (!changed.length && !pendingActivation) return report
    const clientOnly = !pendingActivation && changed.every(entry => entry.target === join(options.programRoot, 'platform/plugin/lib/client.js'))
    const workerOnly = !pendingActivation && changed.every(entry => entry.target === join(options.programRoot, 'platform/plugin/lib/sdk-worker.js'))
    const blocking = current.busy.filter(item => !options.interruptSessions || !['session', 'assistant'].includes(item.kind))
    if (!clientOnly && !workerOnly && blocking.length) { report.status = 'busy'; return report }
    report.activation = clientOnly ? 'native-hmr' : workerOnly ? 'next-sdk-operation' : 'managed-restart'
    for (const [index, entry] of changed.entries()) {
      const existed = existsSync(entry.target), path = join(stage, 'backup', String(index)), mode = existed ? statSync(entry.target).mode & 0o777 : 0o644
      if (existed) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(entry.target), { mode: 0o600 }) }
      backups.push({ target: entry.target, path, mode, existed })
    }
    if (report.activation === 'managed-restart') { stopped = true; await services.lifecycle('stop', options, observed) }
    applied = true
    for (const entry of changed) atomic(entry.target, readFileSync(entry.source), backups.find(item => item.target === entry.target)!.mode)
    if (stopped) { await services.lifecycle('start', options, observed); stopped = false }
    const verified = await services.verify(options)
    if (verified.workspaceId !== observed.workspaceId) throw new Error('更新后工作区身份不符')
    if (report.activation !== 'managed-restart' && verified.state.pid !== observed.state.pid) throw new Error('无需启停的更新不应改变平台进程')
    if (verified.state.host !== observed.state.host || verified.state.port !== observed.state.port || verified.state.publicUrl !== observed.state.publicUrl
      || verified.environment.HOME !== observed.environment.HOME || verified.environment.DSH_HOME !== observed.environment.DSH_HOME) throw new Error('更新后监听地址或平台HOME发生变化')
    report.pid = verified.state.pid; report.status = 'applied'
    return report
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.message : '更新失败'
    if (applied || stopped) {
      let restored = false
      try {
        if (!applied) {
          try { await services.verify(options); restored = true; stopped = false } catch { /* 停止已生效时按原参数恢复。 */ }
        }
        if (!restored) {
          if (report.activation === 'managed-restart') { stopped = true; await services.lifecycle('stop', options, observed) }
          for (const backup of backups) if (backup.existed) atomic(backup.target, readFileSync(backup.path), backup.mode); else rmSync(backup.target, { force: true })
          if (stopped) { await services.lifecycle('restore', options, observed); stopped = false }
          await services.verify(options); restored = true
        }
      } catch { /* 回执明确保留恢复未确认，不覆盖原始失败。 */ }
      report.recovery = restored ? 'verified' : 'unknown'
      throw new Error(`${report.error}；旧制品${restored ? '已恢复并核验' : '恢复未确认，请查看保留目录'}：${stage}`)
    }
    throw error
  } finally {
    report.receipt = join(stage, 'receipt.json')
    writeFileSync(report.receipt, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    rmSync(lock, { recursive: true, force: true })
  }
}
