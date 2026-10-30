import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultAssetRoot } from './plugin/src/workspace.ts'
import { platformEntryUrl } from './plugin/src/business-control/group-link.ts'
import { initializeBusinessGateway } from './plugin/src/business-control/configuration.ts'
import { prepareBusinessRuntimeFile } from './plugin/src/business-control/secret-file.ts'
import { reportBusinessReadiness } from './business-readiness.mts'

const programRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
type State = { pid: number; birth: string; programRoot: string; dataRoot: string; url: string; host: string; port: number; log: string; phase: string; detached: boolean }
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

export function launchAddress(dataRoot: string, host?: string, port?: string): { host: string; port: number; url: string } {
  let configured: URL | undefined
  const access = join(dataRoot, 'config/business-access.json')
  if (existsSync(access) && json(access).gateway?.managementUrl !== undefined) configured = new URL(platformEntryUrl(dataRoot))
  if (!host && !configured) {
    const route = spawnSync('ip', ['-j', '-4', 'route', 'get', '1.1.1.1'], { encoding: 'utf8', timeout: 5000 })
    try { host = JSON.parse(route.stdout)[0].prefsrc } catch { throw new Error('无法确定本机 IPv4，请指定 --host') }
  }
  host ??= configured!.hostname
  if (isIP(host) !== 4 || host === '0.0.0.0' || host === '255.255.255.255' || Number(host.split('.')[0]) >= 224) throw new Error('--host 必须是具体 IPv4 地址')
  if (!Object.values(networkInterfaces()).flat().some(item => item?.address === host)) throw new Error(`监听地址 ${host} 不属于本机；请用 --host 指定本机地址`)
  const number = port === undefined ? Number(configured?.port || (configured?.protocol === 'https:' ? 443 : configured ? 80 : 18120)) : Number(port)
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error('--port 必须是 1 至 65535 的整数')
  if (configured?.protocol === 'https:') throw new Error('当前启动器直接提供 HTTP；请将 managementUrl 配置为本机 HTTP 入口')
  const sites = join(dataRoot, 'config/sites.json')
  const base = existsSync(sites) ? json(sites).platform : '/hep/'
  if (typeof base !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error('config/sites.json 的平台基址无效')
  return { host, port: number, url: `http://${host}:${number}${base}` }
}

function privateArgs(args: string[]) { return [join(programRoot, 'platform/dsh-platform-internal.py'), ...args] }
function python() { return process.env.HARNESS_PYTHON || 'python3' }
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
    if (processBirth(state.pid) !== state.birth) { rmSync(join(dataRoot, '.local/platform-service/state.json'), { force: true }); return }
    await delay(100)
  }
  throw new Error(`平台 PID ${state.pid} 未在 30 秒内退出；请检查日志 ${state.log}，未强制终止`)
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args
  if (!command || command === '--help') {
    console.log('用法：dsh-platform prepare [--offline] | start [--foreground] [--host IPv4] [--port 18120] [--dry-run] | stop | restart [--host IPv4] [--port 18120] | status [--json]')
    return 0
  }
  const flags = new Set<string>(), values: Record<string, string> = {}
  const allowed: Record<string, string[]> = { prepare: ['--offline'], start: ['--foreground', '--dry-run', '--host', '--port'], restart: ['--foreground', '--host', '--port'], stop: [], status: ['--json'] }
  if (!allowed[command]) throw new Error(`未知命令：${command}`)
  for (let n = 0; n < rest.length; n++) {
    const key = rest[n]
    if (!allowed[command].includes(key) || flags.has(key)) throw new Error(`不支持或重复的选项：${key}`)
    flags.add(key)
    if (['--host', '--port'].includes(key)) {
      if (!rest[n + 1] || rest[n + 1].startsWith('--')) throw new Error(`${key} 需要值`)
      values[key] = rest[++n]
    }
  }
  const dataRoot = defaultAssetRoot()
  process.env.HARNESS_PROGRAM_ROOT = programRoot
  process.env.HARNESS_ASSET_ROOT = dataRoot
  if (command === 'prepare') {
    const result = spawnSync(python(), privateArgs(['prepare', ...(flags.has('--offline') || process.env.HEP_OFFLINE === '1' ? ['--offline'] : [])]), { stdio: 'inherit' })
    if (result.error) throw new Error('无法执行 Python 3.10+；请检查 HARNESS_PYTHON')
    return result.status ?? 1
  }
  if (command === 'status') {
    const state = managedState(dataRoot)
    let status = state ? 'starting' : 'stopped'
    if (state && ownsPort(state.pid, state.host, state.port)) status = await httpPhase(state.url)
    console.log(flags.has('--json') ? JSON.stringify({ status, ...state }, null, 2) : `${status}${state ? ` ${state.url}\nPID：${state.pid}\n日志：${state.log}` : ''}`)
    return 0
  }
  const address = command === 'stop' ? undefined : launchAddress(dataRoot, values['--host'], values['--port'])
  const startArgs = address ? ['start', '--host', address.host, '--port', String(address.port)] : []
  if (flags.has('--dry-run')) return spawnSync(python(), privateArgs([...startArgs, '--dry-run']), { stdio: 'inherit' }).status ?? 1
  const service = join(dataRoot, '.local/platform-service')
  const unlock = await lock(join(service, 'operation.lock'))
  try {
    if (command === 'stop' || command === 'restart') await stop(dataRoot)
    if (command === 'stop') { console.log('平台已停止'); return 0 }
    const existing = managedState(dataRoot)
    if (existing) {
      if (existing.url !== address!.url) throw new Error(`平台已使用 ${existing.url} 启动；请用 restart 修改地址`)
      if (!ownsPort(existing.pid, existing.host, existing.port)) throw new Error(`平台进程仍在启动但尚未监听；请检查日志 ${existing.log}`)
      const phase = await httpPhase(existing.url)
      if (phase === 'unavailable') throw new Error(`平台进程仍在监听，但 HTTP 未就绪：${existing.url}；请检查日志 ${existing.log}`)
      console.log(`平台${phase === 'initializing' ? '等待初始化' : '已启动'}：${existing.url}\nPID：${existing.pid}\n日志：${existing.log}`)
      if (phase === 'running') await reportBusinessReadiness(programRoot, dataRoot)
      return 0
    }
    const accessPath = join(dataRoot, 'config/business-access.json')
    const before = existsSync(accessPath) ? readFileSync(accessPath, 'utf8') : undefined
    let saved: string | undefined
    // 数据尚未初始化时由浏览器引导建立配置，不能预先制造不完整数据根。
    if (existsSync(join(dataRoot, 'workspace.json'))) {
      initializeBusinessGateway(dataRoot, address!.url, address!.host)
      saved = readFileSync(accessPath, 'utf8')
    }
    const log = join(service, 'platform.log')
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
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (failure || processBirth(state.pid) !== state.birth) throw new Error(`平台启动失败；日志：${log}`)
        if (ownsPort(state.pid, state.host, state.port)) {
          const phase = await httpPhase(state.url)
          if (phase !== 'unavailable') {
            state.phase = phase
            atomic(join(service, 'state.json'), state)
            console.log(`平台${state.phase === 'initializing' ? '等待初始化' : '已启动'}：${state.url}\nPID：${state.pid}\n日志：${log}`)
            if (state.phase === 'running') await reportBusinessReadiness(programRoot, dataRoot)
            unlock()
            if (foreground) return await exited
            child.unref()
            return 0
          }
        }
        await delay(100)
      }
      throw new Error(`平台启动等待超过 60 秒；请用 status 和日志检查：${log}`)
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
