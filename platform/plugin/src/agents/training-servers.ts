import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { workspaceConfigPath } from '../workspace.ts'

type Server = {
  id: string; name: string; host: string; port: number; user: string
  workDir: string; auth: 'ssh_key' | 'password'; credentialRef: string
}
type Directory = { schemaVersion: 1; servers: Server[] }

const EMPTY = JSON.stringify({ schemaVersion: 1, servers: [] }, null, 2) + '\n'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const result = (value: Record<string, unknown>): ConnectionRpcResult<Record<string, unknown>> => ({ ok: true, value })
const failure = (code: string, message: string): ConnectionRpcResult<never> => ({ ok: false, error: { code, message, details: {} } })

class DirectoryError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function directoryFile(root: string): string {
  const file = workspaceConfigPath(root, 'compute-training-servers.json')
  const parent = dirname(file)
  const statOf = (path: string) => {
    try { return lstatSync(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const parentStat = statOf(parent)
  if (parentStat) {
    const stat = parentStat
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DirectoryError('invalid_asset', '训练连接配置目录无效')
  }
  const fileStat = statOf(file)
  if (fileStat) {
    const stat = fileStat
    if (!stat.isFile() || stat.isSymbolicLink()) throw new DirectoryError('invalid_asset', '训练连接配置必须是普通文件')
  }
  return file
}

function lockExists(file: string): boolean {
  try { lstatSync(file); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function acquireDirectoryLock(file: string, signal?: AbortSignal): Promise<number> {
  for (let attempt = 0; attempt <= 120; attempt++) {
    if (signal?.aborted) throw new DirectoryError('aborted', '训练连接操作已取消')
    try { return openSync(file, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 120) throw new DirectoryError('busy', '训练连接列表正在保存或保存锁未释放；确认没有写入进程后移除 compute-training-servers.json.lock，再重试')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw new DirectoryError('busy', '训练连接列表保存锁未释放')
}

function server(value: unknown, idRequired: boolean): Server {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DirectoryError('invalid_request', '训练连接格式无效')
  const item = value as Record<string, unknown>
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  const host = typeof item.host === 'string' ? item.host.trim() : ''
  const user = typeof item.user === 'string' ? item.user.trim() : ''
  const workDir = typeof item.workDir === 'string' ? item.workDir.trim() : ''
  const credentialRef = typeof item.credentialRef === 'string' ? item.credentialRef.trim() : ''
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)
    || !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host) || host.length > 255
    || !Number.isInteger(item.port) || (item.port as number) < 1 || (item.port as number) > 65535
    || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)
    || !workDir.startsWith('/') || /[\x00-\x1f\x7f]/.test(workDir)
    || !['ssh_key', 'password'].includes(String(item.auth))
    || (credentialRef && !/^ref:[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(credentialRef))) {
    throw new DirectoryError('invalid_request', '训练连接信息无效；只保存有效主机、目录和 ref: 凭据引用')
  }
  const id = typeof item.id === 'string' ? item.id : ''
  if (idRequired && !/^train-[a-f0-9-]{12,36}$/.test(id)) throw new DirectoryError('invalid_asset', '训练连接 ID 无效')
  return { id, name, host, port: item.port as number, user, workDir,
    auth: item.auth as Server['auth'], credentialRef }
}

function readDirectory(root: string, underLock = false): { file: string; text: string; revision: string; directory: Directory } {
  const file = directoryFile(root)
  let text: string | undefined
  const read = () => existsSync(file) ? readFileSync(file, 'utf8') : EMPTY
  if (underLock) text = read()
  else {
    const lock = `${file}.lock`
    const pause = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!lockExists(lock)) {
        const observed = read()
        if (!lockExists(lock) && read() === observed) { text = observed; break }
      }
      Atomics.wait(pause, 0, 0, 10)
    }
    if (text === undefined) throw new DirectoryError('busy', '训练连接列表正在保存或保存锁未释放；确认没有写入进程后移除 compute-training-servers.json.lock，再重试')
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new DirectoryError('invalid_asset', '训练连接配置 JSON 无法解析') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DirectoryError('invalid_asset', '训练连接配置格式无效')
  const source = value as Record<string, unknown>
  if (source.schemaVersion !== 1 || !Array.isArray(source.servers)) throw new DirectoryError('invalid_asset', '训练连接配置版本或列表无效')
  let servers: Server[]
  try { servers = source.servers.map(item => server(item, true)) }
  catch { throw new DirectoryError('invalid_asset', '训练连接配置条目无效') }
  if (new Set(servers.map(item => item.id)).size !== servers.length) throw new DirectoryError('invalid_asset', '训练连接 ID 重复')
  return { file, text, revision: digest(text), directory: { schemaVersion: 1, servers } }
}

async function probe(host: string, port: number, signal?: AbortSignal): Promise<'ssh_reachable' | 'port_reachable_unverified' | 'unreachable'> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    let connected = false, settled = false, received = ''
    let timer: ReturnType<typeof setTimeout>
    const finish = (state: 'ssh_reachable' | 'port_reachable_unverified' | 'unreachable' | 'aborted') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (state === 'aborted') reject(new DirectoryError('aborted', '连接检查已取消'))
      else resolve(state)
    }
    const abort = () => finish('aborted')
    timer = setTimeout(() => finish(connected ? 'port_reachable_unverified' : 'unreachable'), 3000)
    timer.unref()
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('connect', () => { connected = true })
    socket.on('data', data => {
      received += data.toString('utf8')
      if (received.split('\n').some(line => /^SSH-\d\.\d-/.test(line.trim()))) finish('ssh_reachable')
      else if (received.length > 1024) finish('port_reachable_unverified')
    })
    socket.once('error', () => finish('unreachable'))
    socket.once('close', () => finish(connected ? 'port_reachable_unverified' : 'unreachable'))
    if (signal?.aborted) abort()
  })
}

/** 训练资源只登记连接资料与凭据引用；策划提交不创建连接。 */
export function createTrainingServersHandler(root: string): ConnectionRpcHandler {
  const assetRoot = realpathSync(resolve(root))
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return failure('aborted', '训练连接操作已取消')
    try {
      if (endpoint === 'probe') {
        const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
        const host = typeof body.host === 'string' ? body.host.trim() : ''
        const port = body.port
        if (!/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host) || host.length > 255
          || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
          return failure('invalid_request', '请填写有效的 SSH 主机和端口')
        }
        const status = await probe(host, port as number, signal)
        const message = status === 'ssh_reachable' ? '已收到 SSH 服务标识；身份认证、训练依赖与 GPU 尚未验证。'
          : status === 'port_reachable_unverified' ? '端口可达但未识别 SSH 服务；身份认证与训练环境尚未验证。'
            : '主机端口不可达；请核对网络、地址和端口。'
        return result({ status, message, checked_at: new Date().toISOString() })
      }
      if (endpoint === 'list') {
        const current = readDirectory(assetRoot)
        return result({ revision: current.revision, servers: current.directory.servers })
      }
      if (endpoint !== 'save') return failure('method_not_found', '未知训练连接操作')
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure('invalid_request', '训练连接请求格式无效')
      const body = payload as Record<string, unknown>
      const next = server(body.server, false)
      if (signal?.aborted) return failure('aborted', '训练连接操作已取消')
      const file = directoryFile(assetRoot)
      mkdirSync(dirname(file), { recursive: true })
      directoryFile(assetRoot)
      const lockFile = `${file}.lock`
      const lock = await acquireDirectoryLock(lockFile, signal)
      try {
        const current = readDirectory(assetRoot, true)
        if (body.revision !== current.revision) return failure('conflict', '训练连接列表已变化，请刷新后重试')
        if (current.directory.servers.some(item => item.host === next.host && item.port === next.port && item.user === next.user)) {
          return failure('conflict', '该 SSH 连接已登记，请选择现有连接')
        }
        next.id = `train-${randomUUID()}`
        const servers = [...current.directory.servers, next]
        const text = JSON.stringify({ schemaVersion: 1, servers }, null, 2) + '\n'
        const temporary = `${current.file}.${randomUUID()}.tmp`
        try {
          writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
          if (readDirectory(assetRoot, true).revision !== current.revision) return failure('conflict', '训练连接列表已变化，请刷新后重试')
          renameSync(temporary, current.file)
        } finally { rmSync(temporary, { force: true }) }
        return result({ revision: digest(text), servers })
      } finally { closeSync(lock); rmSync(lockFile, { force: true }) }
    } catch (error) {
      return error instanceof DirectoryError ? failure(error.code, error.message) : failure('training_servers_failed', '训练连接操作失败')
    }
  }
}
