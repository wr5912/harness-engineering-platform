import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { versionSource } from '../agents/version-source.ts'
import { dataPath, sourceInfo } from '../tasks/files.ts'
import { instanceStateRoot, programRoot, workspaceIdentity, workspaceLocalPath, workspaceOwnsInstance } from '../workspace.ts'
import { redactRunText } from '../agents/run-files.ts'

export type SdkOperation = {
  id: string; request_id: string; fingerprint: string; workspace_id: string; source: string; instance_id: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopping' | 'stopped' | 'unknown'
  created_at: string; updated_at: string; worker_pid?: number; session_id?: string; final_response?: string
  events: unknown[]; error?: string; runtime_started?: boolean
}
export type SdkModelPolicy = (agentId: string, selected?: { provider: string; model: string; reasoningEffort?: string }, candidatePath?: string) => Promise<{ policy: unknown; environment: Record<string, string> }>
const ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ACTIVE = new Set(['starting', 'running', 'stopping', 'unknown'])
export function saveSdkOperation(directory: string, operation: SdkOperation) {
  operation.updated_at = new Date().toISOString()
  const temporary = join(directory, `operation-${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify(operation), { mode: 0o600 })
  renameSync(temporary, join(directory, 'operation.json'))
}
export function readSdkOperation(directory: string): SdkOperation {
  return JSON.parse(readFileSync(join(directory, 'operation.json'), 'utf8'))
}
export function sdkInstance(root: string, operation: SdkOperation): Record<string, any> | undefined {
  const file = join(instanceStateRoot(root), operation.instance_id, 'instance.json')
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8'))
}
/** 停止前核对本次运行身份，旧操作不能停止后来同名的实例。 */
export async function stopSdkInstance(root: string, operation: SdkOperation, cli: string, environment: NodeJS.ProcessEnv) {
  const current = sdkInstance(root, operation)
  if (current) {
    if (!workspaceOwnsInstance(root, current) || current.profile !== 'sdk' || current.source_id !== operation.source
      || current.sdk_operation_id !== operation.id) throw new Error('实例已被替换或不属于本次 SDK 执行，未停止当前实例；请核对原操作结果')
    await promisify(execFile)(process.env.HARNESS_PYTHON || 'python3', [cli, '--repo', root, 'down', operation.instance_id], { env: environment, timeout: 30_000 })
  } else {
    const result = await promisify(execFile)('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 10_000 })
    if (result.stdout.split('\n').includes(operation.instance_id)) throw new Error('同名容器缺少本次 SDK 归属登记，未停止该容器')
  }
}
function text(body: Record<string, unknown>, name: string) {
  if (typeof body[name] !== 'string' || !body[name].trim()) throw new Error(`缺少 ${name}`)
  return body[name] as string
}
function operationId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('操作标识格式无效')
  return value
}
function workerAlive(operation: SdkOperation, directory: string) {
  if (!operation.worker_pid) return false
  try {
    return readFileSync(`/proc/${operation.worker_pid}/cmdline`, 'utf8').split('\0').includes(directory)
  } catch { return false }
}

/** SDK 调试记录是运行状态，不创建或改写研究 Run。 */
export function createSdkHandler(root: string, options: { modelPolicy?: SdkModelPolicy; worker?: string; cli?: string; onChange?: () => void } = {}): ConnectionRpcHandler {
  const base = workspaceLocalPath(root, 'sdk-operations')
  const workspace = workspaceIdentity(root)
  const read = (id: string) => {
    const directory = join(base, operationId(id))
    const operation = readSdkOperation(directory)
    if (operation.workspace_id !== workspace.id) throw new Error('操作不属于当前工作区')
    if ((['running', 'stopping'].includes(operation.status) || operation.status === 'starting'
      && Date.now() - Date.parse(operation.updated_at) > 30_000) && !workerAlive(operation, directory)) {
      operation.status = 'unknown'
      operation.error = '执行进程已断开，结果尚未核对；请停止原实例后再执行，平台不会自动重跑。'
      saveSdkOperation(directory, operation)
    }
    return operation
  }
  const list = () => !existsSync(base) ? [] : readdirSync(base).filter(name => ID.test(name)).flatMap(id => {
    try { return [read(id)] } catch { return [] }
  }).sort((a, b) => b.created_at.localeCompare(a.created_at))
  return async (endpoint, payload) => {
    try {
      const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
      if (endpoint === 'status') return { ok: true, value: read(operationId(body.operation_id)) }
      if (endpoint === 'list') return { ok: true, value: list().filter(item => !body.source || item.source === String(body.source).replace(/^(?!experiment:)/, 'experiment:')) }
      if (endpoint === 'guide' || endpoint === 'start') {
        const source = sourceInfo(root, text(body, 'source'))
        if (versionSource(root, source.id).profile !== 'sdk') throw new Error('该版本使用 Web 方式，请选择 TypeScript SDK 版本')
        if (endpoint === 'guide') {
          const readAsset = (file: string) => readFileSync(dataPath(root, `evolution/experiments/${source.id}/candidate/${file}`), 'utf8')
          return { ok: true, value: { workspace_id: workspace.id, profile: 'sdk', source: source.source,
            markdown: readAsset('sdk/README.md'), example: readAsset('sdk/example.ts') } }
        }
        const id = operationId(body.request_id), instance = text(body, 'instance_id'), input = text(body, 'input')
        if (!NAME.test(instance) || instance.length > 100) throw new Error('实例名必须是小写 kebab-case，且不超过 100 个字符')
        if (Buffer.byteLength(input) > 128 * 1024) throw new Error('调试输入超过 128 KiB，请缩短后重试')
        if (body.session_id !== undefined && (typeof body.session_id !== 'string' || !body.session_id.trim() || body.session_id.length > 256)) throw new Error('Session 标识必须为不超过 256 个字符的非空字符串')
        const request = { source: source.source, instance_id: instance, input, ...(body.session_id ? { session_id: body.session_id } : {}) }
        const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
        const directory = join(base, id)
        if (existsSync(directory)) {
          const previous = read(id)
          if (previous.fingerprint !== fingerprint) throw new Error('同一请求标识已用于其他输入，请使用新的请求标识')
          return { ok: true, value: previous }
        }
        if (list().some(item => item.instance_id === instance && ACTIVE.has(item.status))) throw new Error('该实例已有执行或待核对操作，请先查看或停止原操作')
        const worker = options.worker ?? join(programRoot(), 'platform/plugin/lib/sdk-worker.js')
        if (!existsSync(worker)) throw new Error('SDK 调试程序尚未构建，请先构建平台插件')
        mkdirSync(base, { recursive: true, mode: 0o700 })
        mkdirSync(directory, { mode: 0o700 })
        const now = new Date().toISOString()
        const operation: SdkOperation = { id, request_id: id, fingerprint, workspace_id: workspace.id, source: source.source,
          instance_id: instance, status: 'starting', created_at: now, updated_at: now, events: [] }
        saveSdkOperation(directory, operation)
        try {
          writeFileSync(join(directory, 'input.json'), JSON.stringify({ input, ...(body.session_id ? { session_id: body.session_id } : {}) }), { mode: 0o600 })
          const projected = options.modelPolicy ? await options.modelPolicy(source.agent_id, undefined, source.candidate) : undefined
          if (existsSync(join(directory, 'stop-requested'))) {
            operation.status = 'stopped'; saveSdkOperation(directory, operation)
            return { ok: true, value: operation }
          }
          if (projected) writeFileSync(join(directory, 'model-policy.json'), JSON.stringify(projected.policy), { mode: 0o600 })
          writeFileSync(join(directory, 'worker.json'), JSON.stringify({ root, program: programRoot(), cli: options.cli,
            secret_env_keys: Object.keys(projected?.environment ?? {}), model_policy: Boolean(projected) }), { mode: 0o600 })
          const descriptor = openSync(join(directory, 'worker.log'), 'a', 0o600)
          try {
            const child = spawn(process.execPath, [worker, directory], { detached: true, stdio: ['ignore', descriptor, descriptor],
              cwd: root, env: { ...process.env, ...projected?.environment, HARNESS_PROGRAM_ROOT: programRoot(), HARNESS_ASSET_ROOT: root } })
            await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
            child.unref()
          } finally { closeSync(descriptor) }
          options.onChange?.()
          return { ok: true, value: read(id) }
        } catch (error) {
          operation.status = 'failed'; operation.error = redactRunText((error as Error).message)
          saveSdkOperation(directory, operation)
          throw error
        }
      }
      if (endpoint === 'stop') {
        const id = operationId(body.operation_id), directory = join(base, id), operation = read(id)
        if (!ACTIVE.has(operation.status)) return { ok: true, value: operation }
        writeFileSync(join(directory, 'stop-requested'), '', { mode: 0o600 })
        if (workerAlive(operation, directory)) process.kill(operation.worker_pid!, 'SIGTERM')
        else if (operation.status === 'starting') {
          operation.status = 'stopping'; saveSdkOperation(directory, operation)
        }
        else {
          // Worker 不在时仍核对并停止原容器，避免将结果未知当作已停止。
          await stopSdkInstance(root, operation, options.cli ?? join(programRoot(), 'runtime/adapters/dsh-container/dsh-dev'), { ...process.env, HARNESS_ASSET_ROOT: root })
          operation.status = 'stopped'; saveSdkOperation(directory, operation)
        }
        options.onChange?.()
        return { ok: true, value: read(id) }
      }
      throw new Error('未知 SDK 操作')
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      return { ok: false, error: { code: missing ? 'not_found' : 'sdk_operation_failed', message: missing ? 'SDK 调试操作或接入资料不存在' : redactRunText((error as Error).message), details: {} } }
    }
  }
}
