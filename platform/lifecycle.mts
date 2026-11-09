import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultAssetRoot } from './plugin/src/workspace.ts'
import { platformEntryUrl, validatePlatformEntryUrl } from './plugin/src/business-control/group-link.ts'
import { initializeBusinessGateway } from './plugin/src/business-control/configuration.ts'
import { prepareBusinessRuntimeFile } from './plugin/src/business-control/secret-file.ts'
import { reportBusinessReadiness } from './business-readiness.mts'

const programRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const autostartService = 'harness-engineering-platform.service'
const autostartMarker = '# Managed by harness-engineering-platform dsh-platform autostart.'
type State = { pid: number; birth: string; programRoot: string; dataRoot: string; url: string; publicUrl?: string; host: string; port: number; log: string; phase: string; detached: boolean }
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
function atomic(path: string, value: unknown, business = false) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  if (business) prepareBusinessRuntimeFile(temporary)
  renameSync(temporary, path)
}

export function processBirth(pid: number): string | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')
    return fields[0] === 'Z' ? undefined : fields[19]
  } catch { return undefined }
}

export function managedState(dataRoot: string, expectedProgram = programRoot): State | undefined {
  const path = join(dataRoot, '.local/platform-service/state.json')
  if (!existsSync(path)) return undefined
  const state = json(path) as State
  if (!Number.isInteger(state.pid) || state.pid <= 1 || !state.birth) throw new Error('平台进程记录无效；请检查 state.json')
  if (processBirth(state.pid) !== state.birth) return undefined
  if (state.dataRoot !== resolve(dataRoot) || state.programRoot !== resolve(expectedProgram)) {
    throw new Error('该数据根绑定了另一程序目录；请使用原启动入口停止后再切换')
  }
  return state
}

/** 核对监听 socket 归属；初始化服务器是受管进程的子进程。 */
export function ownsPort(pid: number, host: string, port: number): boolean {
  try {
    const address = host.split('.').reverse().map(n => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()
    const sockets = new Set(readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
      .filter(row => row[1] === `${address}:${port.toString(16).padStart(4, '0').toUpperCase()}` && row[3] === '0A').map(row => `socket:[${row[9]}]`))
    const pids = [pid]
    for (let index = 0; index < pids.length; index++) {
      const current = pids[index]
      for (const fd of readdirSync(`/proc/${current}/fd`)) {
        try { if (sockets.has(readlinkSync(`/proc/${current}/fd/${fd}`))) return true } catch { /* fd 已关闭。 */ }
      }
      const children = readFileSync(`/proc/${current}/task/${current}/children`, 'utf8').trim()
      if (children) pids.push(...children.split(' ').map(Number))
    }
  } catch { /* 进程退出或尚未监听。 */ }
  return false
}

async function httpPhase(url: string): Promise<'running' | 'initializing' | 'unavailable'> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
    void response.body?.cancel().catch(() => {})
    return [200, 302, 303].includes(response.status)
      ? (response.headers.get('x-harness-bootstrap') ? 'initializing' : 'running') : 'unavailable'
  } catch { return 'unavailable' }
}

export function launchAddress(dataRoot: string, host?: string, port?: string, publicUrl?: string): { host: string; port: number; url: string; publicUrl: string } {
  let configured: URL | undefined
  const access = join(dataRoot, 'config/business-access.json')
  if (existsSync(access) && json(access).gateway?.managementUrl !== undefined) configured = new URL(platformEntryUrl(dataRoot))
  let previous: State | undefined
  try {
    const stored = json(join(dataRoot, '.local/platform-service/state.json')) as State
    if (stored.programRoot === programRoot && stored.dataRoot === resolve(dataRoot)) previous = stored
  } catch { /* 首次启动没有历史监听地址。 */ }
  const local = (value: string) => Object.values(networkInterfaces()).flat().some(item => item?.address === value)
  const separate = configured && (configured.protocol === 'https:' || !local(configured.hostname)
    || previous?.publicUrl === configured.href && previous.publicUrl !== previous.url)
  if (!host && separate && previous && local(previous.host)) host = previous.host
  if (!host && (!configured || separate)) {
    const route = spawnSync('ip', ['-j', '-4', 'route', 'get', '1.1.1.1'], { encoding: 'utf8', timeout: 5000 })
    try { host = JSON.parse(route.stdout)[0].prefsrc } catch { throw new Error('无法确定本机 IPv4，请指定 --host') }
  }
  host ??= configured!.hostname
  if (isIP(host) !== 4 || host === '0.0.0.0' || host === '255.255.255.255' || Number(host.split('.')[0]) >= 224) throw new Error('--host 必须是具体 IPv4 地址')
  if (!local(host)) throw new Error(`监听地址 ${host} 不属于本机；请用 --host 指定本机地址`)
  const number = port === undefined ? Number(separate ? previous?.port ?? 18120 : configured?.port || (configured ? 80 : 18120)) : Number(port)
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('--port 必须是 1 至 65535 的整数')
  const sites = join(dataRoot, 'config/sites.json')
  const base = existsSync(sites) ? json(sites).platform : '/hep/'
  if (typeof base !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error('config/sites.json 的平台基址无效')
  const url = `http://${host}:${number}${base}`
  if (publicUrl && new URL(publicUrl).hash) throw new Error('--public-url 不能包含片段')
  const entry = validatePlatformEntryUrl(dataRoot, publicUrl ?? (separate ? configured!.href : url))
  if (new URL(entry).pathname !== base) throw new Error('平台管理入口与站点基址不一致')
  return { host, port: number, url, publicUrl: entry }
}

function privateArgs(args: string[]) { return [join(programRoot, 'platform/dsh-platform-internal.py'), ...args] }
function python() { return process.env.HARNESS_PYTHON || 'python3' }
function systemdQuote(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('\n', '\\n')}"`
}
function systemdPath(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '%%').replaceAll(/\s/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
}
export function renderAutostartUnit(root = programRoot, dataRoot = defaultAssetRoot(), runtimePath = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':')) {
  return [autostartMarker, '[Unit]', 'Description=Harness Engineering Platform', '', '[Service]', 'Type=simple',
    `WorkingDirectory=${systemdPath(root)}`, `Environment=${systemdQuote(`HARNESS_PROGRAM_ROOT=${root}`)}`,
    `Environment=${systemdQuote(`HARNESS_ASSET_ROOT=${dataRoot}`)}`, `Environment=${systemdQuote(`PATH=${runtimePath}`)}`,
    `ExecStart=${systemdQuote(join(root, 'platform/dsh-platform'))} start --foreground`, 'Restart=on-failure', 'RestartSec=5s',
    'TimeoutStartSec=10min', 'TimeoutStopSec=45s', 'KillMode=control-group', '', '[Install]', 'WantedBy=default.target', ''].join('\n')
}
function commandResult(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`无法执行 ${command}：${result.error.message}`)
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) throw new Error(output || `${command} 退出码 ${result.status ?? '未知'}`)
  return output
}
function systemctl(args: string[]) { return commandResult('systemctl', ['--user', ...args]) }
function stripLauncherPrefix(value: string): string {
  return value.replace(/^dsh-platform:\s*/gm, '')
}
function runStartPreflight(args: string[]): string {
  const result = spawnSync(python(), privateArgs([...args, '--dry-run']), { encoding: 'utf8' })
  if (result.error) throw new Error(`无法执行启动预检：${result.error.message}`)
  const output = stripLauncherPrefix(`${result.stderr ?? ''}${result.stdout ?? ''}`).trim()
  if (result.status !== 0) throw new Error(output || '启动预检未通过')
  return `${result.stdout ?? ''}`.trim()
}
function preflightSummary(output: string, dataRoot: string): string {
  try {
    const value = JSON.parse(output) as Record<string, unknown>
    if (value.mode === 'initialization') return `启动预检通过：数据根尚未初始化，将进入浏览器引导（${dataRoot}）`
    const dsh = typeof value.dsh_version === 'string' ? `DSH ${value.dsh_version}` : `Python ${python()}`
    const profile = typeof value.profile === 'string' ? `Profile ${value.profile}` : 'Profile 待读取'
    const home = typeof value.home === 'string' ? `HOME ${value.home}` : `数据根 ${dataRoot}`
    const repository = typeof value.repository === 'string' ? `程序根 ${value.repository}` : `程序根 ${programRoot}`
    const assets = typeof value.asset_root === 'string' ? `数据根 ${value.asset_root}` : `数据根 ${dataRoot}`
    return `启动预检通过：${repository}；${assets}；Python ${python()}；${dsh}；${profile}；${home}`
  } catch {
    return `启动预检通过：程序根 ${programRoot}；数据根 ${dataRoot}；Python ${python()}`
  }
}
function redactDiagnostic(value: string): string {
  return value
    .replace(/((?:password|token|secret|api[-_ ]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^,\s]+)/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+|\bbearer\s+)[^\s,]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|secret|password|api[-_]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
}
function startupDiagnostic(log: string, offset = 0): string {
  let descriptor: number | undefined
  try {
    const size = statSync(log).size
    const lower = Math.max(0, Math.min(offset, size))
    const start = Math.max(lower, size - 64 * 1024)
    const buffer = Buffer.alloc(size - start)
    descriptor = openSync(log, 'r')
    readSync(descriptor, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean)
    const matches = lines.filter(line => /dsh-platform:|error|fail|failure|incompatible|invalid|cannot|无法|失败|不兼容|错误|异常/i.test(line))
    return matches.slice(-3).map(line => redactDiagnostic(stripLauncherPrefix(line))).join('\n')
  } catch {
    return ''
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}
function probe(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) return { available: false, status: undefined, output: result.error.message }
  return { available: true, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}
function autostartUnitPath() { return join(homedir(), '.config/systemd/user', autostartService) }
function ensureLinger() {
  if (typeof process.getuid !== 'function') throw new Error('当前系统不支持 Linux 用户自启动')
  const uid = String(process.getuid())
  const state = probe('loginctl', ['show-user', uid, '-p', 'Linger'])
  if (state.available && state.status === 0 && state.output === 'Linger=yes') return
  commandResult('loginctl', ['enable-linger', uid])
}
function autostartStatus(dataRoot: string, asJson: boolean) {
  const unitPath = autostartUnitPath()
  const unit = existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : undefined
  const enabled = probe('systemctl', ['--user', 'is-enabled', autostartService])
  const active = probe('systemctl', ['--user', 'is-active', autostartService])
  const linger = typeof process.getuid === 'function' ? probe('loginctl', ['show-user', String(process.getuid()), '-p', 'Linger']) : undefined
  const result = { service: autostartService, unitPath, unitOwned: unit?.includes(autostartMarker) ?? false,
    enabled: enabled.status === 0 ? enabled.output.split('\n')[0] || 'enabled' : unit ? 'disabled' : 'not-installed',
    active: active.status === 0 ? active.output.split('\n')[0] || 'active' : 'inactive',
    linger: linger?.status === 0 ? linger.output : 'unknown', programRoot, dataRoot: resolve(dataRoot) }
  console.log(asJson ? JSON.stringify(result, null, 2) : `自启动：${result.enabled}\n服务：${result.active}\n用户驻留：${result.linger}\n单元：${result.unitPath}`)
  return 0
}
function manageAutostart(subcommand: string, dataRoot: string, asJson: boolean) {
  if (process.platform !== 'linux') throw new Error('自启动当前只支持 Linux systemd；AMD64 与 ARM64 使用同一套入口')
  const unitPath = autostartUnitPath(), directory = dirname(unitPath)
  const existing = existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : undefined
  if (subcommand === 'status') return autostartStatus(dataRoot, asJson)
  if (subcommand !== 'enable' && subcommand !== 'disable') throw new Error(`未知自启动操作：${subcommand}`)
  if (existing && !existing.includes(autostartMarker)) throw new Error(`已有非平台管理的 systemd 单元：${unitPath}；未覆盖`)
  if (subcommand === 'disable') {
    if (!existing) return 0
    systemctl(['disable', autostartService]); rmSync(unitPath); systemctl(['daemon-reload'])
    console.log('平台自启动已停用（未停止当前平台进程）'); return 0
  }
  systemctl(['show-environment']); ensureLinger(); mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${unitPath}.${process.pid}.tmp`
  writeFileSync(temporary, renderAutostartUnit(programRoot, dataRoot), { mode: 0o600 })
  try { renameSync(temporary, unitPath); systemctl(['daemon-reload']); systemctl(['enable', autostartService]) }
  catch (error) {
    rmSync(temporary, { force: true });
    if (existing === undefined) rmSync(unitPath, { force: true }); else writeFileSync(unitPath, existing, { mode: 0o600 })
    try { systemctl(['daemon-reload']) } catch { /* 保留原始失败。 */ }
    throw error
  }
  console.log(`平台自启动已启用：${unitPath}\n数据根：${resolve(dataRoot)}\n当前进程不会被重启`); return 0
}
async function lock(directory: string): Promise<() => void> {
  mkdirSync(dirname(directory), { recursive: true })
  for (let attempt = 0; attempt < 600; attempt++) {
    try {
      mkdirSync(directory)
      atomic(join(directory, 'owner.json'), { pid: process.pid, birth: processBirth(process.pid) })
      let released = false
      return () => { if (!released) { released = true; rmSync(directory, { recursive: true, force: true }) } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = json(join(directory, 'owner.json'))
        if (processBirth(owner.pid) !== owner.birth) { rmSync(directory, { recursive: true, force: true }); continue }
      } catch {
        if (existsSync(directory) && Date.now() - statSync(directory).mtimeMs > 5000 && !existsSync(join(directory, 'owner.json'))) rmSync(directory, { recursive: true, force: true })
      }
      await delay(100)
    }
  }
  throw new Error('另一个启停操作仍在执行，请稍后重试')
}

async function stop(dataRoot: string) {
  const state = managedState(dataRoot)
  if (!state) return
  try { process.kill(state.detached ? -state.pid : state.pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  for (let n = 0; n < 300; n++) {
    // 保留上次监听地址，公开入口使用 NAT/反代时下次启动仍可复用原端口。
    if (processBirth(state.pid) !== state.birth) return
    await delay(100)
  }
  throw new Error(`平台 PID ${state.pid} 未在 30 秒内退出；请检查日志 ${state.log}，未强制终止`)
}

/** 恢复更新前已验证的运行命令；旧制品可能与当前源码的缓存路径不同，不能重新渲染Profile。 */
export async function restoreManagedProcess(original: State, command: string[], environment: NodeJS.ProcessEnv): Promise<State> {
  if (!original.detached || !isAbsolute(command[0] ?? '') || command[command.indexOf('--profile') + 1] !== 'harness-platform'
    || command[command.indexOf('--patch') + 1] !== join(original.dataRoot, '.local/platform-home/profiles/harness-platform/harness-platform.patch.yml')
    || environment.HARNESS_PROGRAM_ROOT !== original.programRoot || environment.HARNESS_ASSET_ROOT !== original.dataRoot
    || environment.DSH_HOME !== join(original.dataRoot, '.local/platform-home') || !isAbsolute(environment.HOME ?? '')) throw new Error('原平台启动身份不完整，未执行恢复')
  const service = join(original.dataRoot, '.local/platform-service'), unlock = await lock(join(service, 'operation.lock'))
  try {
    if (managedState(original.dataRoot, original.programRoot)) throw new Error('平台已有受管进程，未覆盖恢复')
    const fd = openSync(original.log, 'a', 0o600)
    const child = spawn(command[0], command.slice(1), { cwd: original.dataRoot, env: environment, detached: true, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    let failure: Error | undefined
    child.on('error', error => { failure = error })
    if (!child.pid) throw new Error('原平台命令无法启动，恢复未确认')
    const state = { ...original, pid: child.pid, birth: processBirth(child.pid)!, phase: 'starting' }
    atomic(join(service, 'state.json'), state)
    try {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (failure || processBirth(state.pid) !== state.birth) throw new Error(`原平台启动失败；日志：${state.log}`)
        if (ownsPort(state.pid, state.host, state.port) && await httpPhase(state.url) === 'running') {
          state.phase = 'running'; atomic(join(service, 'state.json'), state)
          return state
        }
        await delay(100)
      }
      throw new Error(`原平台恢复等待超过60秒；日志：${state.log}`)
    } finally { child.unref() }
  } finally { unlock() }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args
  if (!command || command === '--help') {
    console.log('用法：dsh-platform prepare [--offline] | start [--foreground] [--host IPv4] [--port 18120] [--public-url URL] [--dry-run] | stop | restart [--host IPv4] [--port 18120] [--public-url URL] | status [--json] | autostart enable|disable|status [--json]')
    return 0
  }
  const dataRoot = defaultAssetRoot()
  process.env.HARNESS_PROGRAM_ROOT = programRoot
  process.env.HARNESS_ASSET_ROOT = dataRoot
  if (command === 'autostart') {
    const [subcommand = 'status', ...autostartArgs] = rest
    if (autostartArgs.some(arg => arg !== '--json') || autostartArgs.filter(arg => arg === '--json').length > 1) throw new Error('自启动仅支持一次 --json')
    return manageAutostart(subcommand, dataRoot, autostartArgs.includes('--json'))
  }
  const flags = new Set<string>(), values: Record<string, string> = {}
  const allowed: Record<string, string[]> = { prepare: ['--offline'], start: ['--foreground', '--dry-run', '--host', '--port', '--public-url'], restart: ['--foreground', '--host', '--port', '--public-url'], stop: [], status: ['--json'] }
  if (!allowed[command]) throw new Error(`未知命令：${command}`)
  for (let n = 0; n < rest.length; n++) {
    const key = rest[n]
    if (!allowed[command].includes(key) || flags.has(key)) throw new Error(`不支持或重复的选项：${key}`)
    flags.add(key)
    if (['--host', '--port', '--public-url'].includes(key)) {
      if (!rest[n + 1] || rest[n + 1].startsWith('--')) throw new Error(`${key} 需要值`)
      values[key] = rest[++n]
    }
  }
  if (command === 'prepare') {
    const result = spawnSync(python(), privateArgs(['prepare', ...(flags.has('--offline') || process.env.HEP_OFFLINE === '1' ? ['--offline'] : [])]), { stdio: 'inherit' })
    if (result.error) throw new Error('无法执行 Python 3.10+；请检查 HARNESS_PYTHON')
    return result.status ?? 1
  }
  if (command === 'status') {
    const state = managedState(dataRoot)
    let status = state ? 'starting' : 'stopped'
    if (state && ownsPort(state.pid, state.host, state.port)) status = await httpPhase(state.url)
    console.log(flags.has('--json') ? JSON.stringify({ status, ...state }, null, 2) : `${status}${state ? ` ${state.publicUrl ?? state.url}\nPID：${state.pid}\n日志：${state.log}` : ''}`)
    return 0
  }
  const address = command === 'stop' ? undefined : launchAddress(dataRoot, values['--host'], values['--port'], values['--public-url'])
  const startArgs = address ? ['start', '--host', address.host, '--port', String(address.port), '--public-url', address.publicUrl] : []
  if (flags.has('--dry-run')) return spawnSync(python(), privateArgs([...startArgs, '--dry-run']), { stdio: 'inherit' }).status ?? 1
  const service = join(dataRoot, '.local/platform-service')
  const unlock = await lock(join(service, 'operation.lock'))
  try {
    if (command === 'restart') {
      try {
        const checked = runStartPreflight(startArgs)
        console.log(preflightSummary(checked, dataRoot))
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}；原平台进程已保留`)
      }
    }
    if (command === 'stop' || command === 'restart') await stop(dataRoot)
    if (command === 'stop') { console.log('平台已停止'); return 0 }
    const existing = managedState(dataRoot)
    if (existing) {
      if (existing.url !== address!.url) throw new Error(`平台已使用 ${existing.url} 启动；请用 restart 修改地址`)
      if ((existing.publicUrl ?? existing.url) !== address!.publicUrl) throw new Error('平台公开入口已变化；请用 restart 应用地址')
      if (!ownsPort(existing.pid, existing.host, existing.port)) throw new Error(`平台进程仍在启动但尚未监听；请检查日志 ${existing.log}`)
      const phase = await httpPhase(existing.url)
      if (phase === 'unavailable') throw new Error(`平台进程仍在监听，但 HTTP 未就绪：${existing.url}；请检查日志 ${existing.log}`)
      console.log(`平台${phase === 'initializing' ? '等待初始化' : '已启动'}：${existing.publicUrl ?? existing.url}\nPID：${existing.pid}\n日志：${existing.log}`)
      if (phase === 'running') await reportBusinessReadiness(programRoot, dataRoot)
      return 0
    }
    const checked = runStartPreflight(startArgs)
    console.log(preflightSummary(checked, dataRoot))
    const accessPath = join(dataRoot, 'config/business-access.json')
    const before = existsSync(accessPath) ? readFileSync(accessPath, 'utf8') : undefined
    let saved: string | undefined
    // 数据尚未初始化时由浏览器引导建立配置，不能预先制造不完整数据根。
    if (existsSync(join(dataRoot, 'workspace.json'))) {
      initializeBusinessGateway(dataRoot, address!.publicUrl, address!.host)
      saved = readFileSync(accessPath, 'utf8')
    }
    const log = join(service, 'platform.log')
    const logOffset = existsSync(log) ? statSync(log).size : 0
    const foreground = flags.has('--foreground')
    const fd = foreground ? undefined : openSync(log, 'a', 0o600)
    const child = spawn(python(), privateArgs(startArgs), { detached: true, stdio: foreground ? 'inherit' : ['ignore', fd!, fd!], env: process.env })
    if (fd !== undefined) closeSync(fd)
    let failure: Error | undefined
    child.on('error', error => { failure = error })
    const exited = new Promise<number>(resolveExit => child.on('exit', code => resolveExit(code ?? 1)))
    if (!child.pid) {
      if (saved && readFileSync(accessPath, 'utf8') === saved) {
        if (before === undefined) rmSync(accessPath); else writeFileSync(accessPath, before, { mode: 0o600 })
      }
      throw new Error('无法执行 Python 3.10+；平台未启动')
    }
    const state: State = { pid: child.pid, birth: processBirth(child.pid)!, programRoot, dataRoot, ...address!, log, phase: 'starting', detached: true }
    atomic(join(service, 'state.json'), state)
    const forward = (signal: NodeJS.Signals) => { if (processBirth(state.pid) === state.birth) process.kill(-state.pid, signal) }
    const sigint = () => forward('SIGINT'), sigterm = () => forward('SIGTERM')
    process.on('SIGINT', sigint); process.on('SIGTERM', sigterm)
    try {
      const timeout = foreground ? 10 * 60_000 : 60_000
      const startedAt = Date.now()
      const deadline = startedAt + timeout
      let nextProgressAt = startedAt + 5_000
      console.log(`平台启动中：${address!.publicUrl ?? address!.url}\nPID：${state.pid}\n日志：${log}`)
      while (Date.now() < deadline) {
        if (failure || processBirth(state.pid) !== state.birth) {
          const detail = failure?.message || startupDiagnostic(log, logOffset)
          throw new Error(`平台启动失败${detail ? `：\n${detail}` : ''}\n日志：${log}`)
        }
        if (ownsPort(state.pid, state.host, state.port)) {
          const phase = await httpPhase(state.url)
          if (phase !== 'unavailable') {
            state.phase = phase
            atomic(join(service, 'state.json'), state)
            console.log(`平台${state.phase === 'initializing' ? '等待初始化' : '已启动'}：${state.publicUrl ?? state.url}\nPID：${state.pid}\n日志：${log}`)
            if (state.phase === 'running') await reportBusinessReadiness(programRoot, dataRoot)
            unlock()
            if (foreground) return await exited
            child.unref()
            return 0
          }
        }
        if (!foreground && Date.now() >= nextProgressAt) {
          const elapsed = Math.floor((Date.now() - startedAt) / 1000)
          console.log(`平台仍在启动（已等待 ${elapsed} 秒）；日志：${log}`)
          nextProgressAt += 5_000
        }
        await delay(100)
      }
      const detail = startupDiagnostic(log, logOffset)
      throw new Error(`平台启动等待超过 ${foreground ? '10 分钟' : '60 秒'}${detail ? `；最近诊断：\n${detail}` : ''}\n日志：${log}`)
    } catch (error) {
      child.unref()
      if (saved && readFileSync(accessPath, 'utf8') === saved && processBirth(state.pid) !== state.birth) {
        if (before === undefined) rmSync(accessPath); else writeFileSync(accessPath, before, { mode: 0o600 })
      }
      throw error
    } finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm) }
  } finally { unlock() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }).catch(error => { console.error(`dsh-platform: ${error.message}`); process.exitCode = 1 })
}
