import { instanceStateRoot, programRoot, workspaceConfigPath, workspaceOwnsInstance } from '../workspace.ts'
import { businessGatewayEntry } from '../business-control/entry.ts'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

const execFile = promisify(execFileCallback)
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SECRET_RE = /(Bearer\s+)[^\s,)"']+|(token=)[^\s&)"']+|("(?:api[_-]?key|token|password|secret)"\s*:\s*")[^"]+(")|((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,)"']+/gi
const LOG_LIMIT = 20000

export type InstanceOperation = 'create' | 'start' | 'stop' | 'restart' | 'delete'

export interface InstanceActionRequest {
  operation: InstanceOperation
  name: string
  source?: string
  expected_source_id?: string
  mode?: 'eval'
  port?: number
  allow_missing_env?: boolean
}

export interface BatchActionRequest {
  operation: InstanceOperation
  items: InstanceActionRequest[]
}

export interface InstanceActionReceipt {
  name: string
  operation: InstanceOperation | string
  ok: boolean
  value?: unknown
  error?: { code: string, message: string, details?: unknown }
}

type InstanceRecord = Record<string, unknown> & {
  name?: unknown
  state?: unknown
  source_id?: unknown
  home_volume?: unknown
  home_preserved?: unknown
}

function ok<T>(value: T): ConnectionRpcResult<T> {
  return { ok: true, value }
}

function failure(code: string, message: string, details: Record<string, unknown> = {}): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

function payloadObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('请求参数必须是对象')
  return payload as Record<string, unknown>
}

function assertName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('实例名必须是小写 kebab-case')
  return name
}

function assertSource(source: unknown): string {
  if (typeof source !== 'string' || !source.trim()) throw new Error('来源必须是非空字符串')
  return source
}

function optionalPort(port: unknown): number | undefined {
  if (port === undefined) return undefined
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1..65535 的有限整数')
  }
  return port
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是 boolean`)
  return value
}

function dshDev(): string {
  return join(programRoot(), 'runtime/adapters/dsh-container/dsh-dev')
}

function redact(text: string): string {
  return text.replace(SECRET_RE, (_match, bearerPrefix, tokenPrefix, jsonPrefix, jsonSuffix, secretPrefix) =>
    `${bearerPrefix || tokenPrefix || jsonPrefix || secretPrefix}<redacted>${jsonSuffix || ''}`)
}

function bounded(text: string, limit = LOG_LIMIT): string {
  const clean = redact(text)
  return clean.length <= limit ? clean : clean.slice(-limit)
}

export function parseJsonObjects(text: string): unknown[] {
  const values: unknown[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (start === -1) {
      if (char === '{' || char === '[') {
        start = index
        depth = 1
      }
      continue
    }
    if (escape) {
      escape = false
      continue
    }
    if (char === '\\') {
      escape = inString
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1
    if (depth === 0) {
      values.push(JSON.parse(text.slice(start, index + 1)))
      start = -1
    }
  }
  return values
}

async function runDsh(assetRoot: string, args: string[], signal?: AbortSignal) {
  try {
    return await execFile(process.env.HARNESS_PYTHON || 'python3', [dshDev(), ...args], {
      cwd: assetRoot,
      env: { ...process.env, HARNESS_ASSET_ROOT: resolve(assetRoot), HARNESS_PROGRAM_ROOT: programRoot() },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      signal,
    })
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string, stderr?: string }
    throw Object.assign(new Error(bounded(failed.stderr || failed.stdout || failed.message)), {
      code: failed.code,
      stdout: bounded(failed.stdout || ''),
      stderr: bounded(failed.stderr || ''),
    })
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function ensureRealSource(assetRoot: string, source: string): Promise<void> {
  const catalog = await readJson(workspaceConfigPath(assetRoot, 'sources.json'))
  const sources = catalog?.sources
  const id = source.startsWith('experiment:') ? source.slice('experiment:'.length) : source
  if (!sources || typeof sources !== 'object' || !(id in sources)) throw new Error(`未找到真实来源：${source}`)
}

async function manifestFor(assetRoot: string, name: string): Promise<Record<string, unknown> | null> {
  const manifest = await readJson(join(instanceStateRoot(assetRoot), name, 'instance.json'))
  if (manifest && !workspaceOwnsInstance(assetRoot, manifest)) throw new Error(`实例 ${name} 不属于当前工作区或缺少可确认的迁移来源`)
  return manifest
}

async function listInstances(assetRoot: string, signal?: AbortSignal): Promise<{
  schema_version: '1.0'
  observed_at: string
  state_root: string
  instances: InstanceRecord[]
}> {
  const result = await runDsh(assetRoot, ['ps', '--all'], signal)
  const parsed = JSON.parse(result.stdout || '{}') as { instances?: Record<string, unknown>[] }
  const observedAt = new Date().toISOString()
  return {
    schema_version: '1.0',
    observed_at: observedAt,
    state_root: instanceStateRoot(assetRoot),
    instances: (parsed.instances || []).map(instance => ({ observed_at: observedAt, ...instance }) as InstanceRecord),
  }
}

async function instanceState(assetRoot: string, name: string, signal?: AbortSignal): Promise<string | null> {
  const listing = await listInstances(assetRoot, signal)
  const item = listing.instances.find(instance => instance.name === name)
  return typeof item?.state === 'string' ? item.state : null
}

async function assertKnownForMutation(assetRoot: string, name: string, signal?: AbortSignal): Promise<void> {
  const state = await instanceState(assetRoot, name, signal)
  if (state === 'unknown') throw new Error(`实例 ${name} 状态未知，拒绝执行生命周期操作`)
}

async function requestForUp(assetRoot: string, request: InstanceActionRequest): Promise<InstanceActionRequest & { manifest?: any }> {
  const manifest = request.operation === 'create' ? undefined : await manifestFor(assetRoot, request.name)
  return {
    ...request, manifest,
    source: request.source || (manifest ? assertSource(manifest.source_id) : undefined),
    port: request.port ?? optionalPort(manifest?.port),
  }
}

function upArgs(request: InstanceActionRequest & { manifest?: any }, dryRun = false): string[] {
  const args = ['up', '--name', request.name, '--source', request.source || '', '--mode', 'eval']
  if (request.port) args.push('--port', String(request.port))
  if (dryRun) args.push('--dry-run')
  if (request.operation === 'restart') args.push('--replace')
  if (request.allow_missing_env) args.push('--allow-missing-env')
  if (request.manifest?.trusted_host) args.push('--trusted-host', request.manifest.trusted_host)
  if (request.manifest?.mounts?.analysis_workspace) args.push('--analysis-workspace', request.manifest.mounts.analysis_workspace)
  if (request.manifest?.mounts?.plugin_node_modules) args.push('--plugin-node-modules', request.manifest.mounts.plugin_node_modules)
  return args
}

function parseCommandOutput(stdout: string, stderr: string) {
  const json_objects = [...parseJsonObjects(redact(stdout)), ...parseJsonObjects(redact(stderr))]
  return {
    json_objects,
    value: json_objects.at(-1) ?? {},
    stdout: bounded(stdout),
    stderr: bounded(stderr),
  }
}

async function previewOne(assetRoot: string, request: InstanceActionRequest, signal?: AbortSignal) {
  const name = assertName(request.name)
  if (request.operation === 'create' || request.operation === 'start' || request.operation === 'restart') {
    const prepared = await requestForUp(assetRoot, request)
    const source = prepared.source
    if (!source) throw new Error('创建、启动或重启需要来源')
    await ensureRealSource(assetRoot, source)
    const result = await runDsh(assetRoot, upArgs({ ...prepared, name, source }, true), signal)
    return { operation: request.operation, name, plan: JSON.parse(result.stdout), retention: retention(request.operation) }
  }
  const manifest = await manifestFor(assetRoot, name)
  if (!manifest) throw new Error(`未找到实例 ${name}`)
  return {
    operation: request.operation,
    name,
    source_id: manifest.source_id,
    image_tag: manifest.image_tag,
    port: manifest.port,
    mounts: manifest.mounts,
    retention: retention(request.operation),
  }
}

function retention(operation: InstanceOperation) {
  return {
    home: '保留',
    sessions: '保留在 HOME 卷',
    source: '保留',
    runs: '保留',
    registration: operation === 'delete' ? '删除本实例管理登记' : '保留',
  }
}

const locks = new Map<string, Promise<unknown>>()

async function withInstanceLock<T>(names: string[], fn: () => Promise<T>): Promise<T> {
  const key = [...new Set(names)].sort().join(',')
  const previous = locks.get(key) || Promise.resolve()
  let release!: () => void
  const current = previous.catch(() => undefined).then(() => new Promise<void>(resolveRelease => {
    release = resolveRelease
  }))
  locks.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

async function runOne(assetRoot: string, request: InstanceActionRequest, signal?: AbortSignal): Promise<InstanceActionReceipt> {
  const name = assertName(request.name)
  try {
    return await withInstanceLock([name], async () => {
      if (request.expected_source_id !== undefined) {
        const current = await manifestFor(assetRoot, name)
        if (current?.source_id !== request.expected_source_id) throw new Error('实例来源已变化，请刷新后重新预览；本次未执行。')
      }
      // delete 在 CLI 内按目标实例核验容器状态，避免逐项扫描整个实例列表。
      if (request.operation !== 'create' && request.operation !== 'delete') await assertKnownForMutation(assetRoot, name, signal)
      if (request.operation === 'create' || request.operation === 'start' || request.operation === 'restart') {
        const prepared = await requestForUp(assetRoot, request)
        const source = prepared.source
        if (!source) throw new Error('创建、启动或重启需要来源')
        await ensureRealSource(assetRoot, source)
        const result = await runDsh(assetRoot, upArgs({ ...prepared, name, source }), signal)
        return { name, operation: request.operation, ok: true, value: parseCommandOutput(result.stdout, result.stderr) }
      }
      const command = request.operation === 'delete' ? 'delete' : 'down'
      const result = await runDsh(assetRoot, [command, name], signal)
      return { name, operation: request.operation, ok: true, value: parseCommandOutput(result.stdout, result.stderr) }
    })
  } catch (error) {
    return {
      name,
      operation: request.operation,
      ok: false,
      error: { code: 'operation_failed', message: (error as Error).message },
    }
  }
}

async function detail(assetRoot: string, name: string, signal?: AbortSignal) {
  const listing = await listInstances(assetRoot, signal)
  const instance = listing.instances.find(item => item.name === name)
  if (!instance) throw new Error(`未找到实例 ${name}`)
  const sourceId = typeof instance.source_id === 'string' ? instance.source_id : ''
  const experiment = sourceId.startsWith('experiment:') ? sourceId.slice('experiment:'.length) : null
  const runs = experiment ? await listRuns(assetRoot, experiment) : []
  return {
    instance,
    runs,
    session_scope: {
      home_volume: instance.home_volume,
      preserved: instance.home_preserved,
      note: '会话数据位于实例 HOME；平台不读取会话内容或凭据。',
    },
  }
}

async function listRuns(assetRoot: string, experiment: string) {
  try {
    const base = join(assetRoot, 'evolution/experiments', experiment, 'runs')
    const entries = await readdir(base, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && RUN_ID.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({ id: entry.name, experiment_id: experiment, path: `evolution/experiments/${experiment}/runs/${entry.name}` }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function actionRequest(payload: unknown): InstanceActionRequest {
  const object = payloadObject(payload)
  const operation = object.operation
  if (!['create', 'start', 'stop', 'restart', 'delete'].includes(String(operation))) {
    throw new Error('未知实例操作')
  }
  const request: InstanceActionRequest = {
    operation: operation as InstanceOperation,
    name: assertName(object.name),
    port: optionalPort(object.port),
    allow_missing_env: optionalBoolean(object.allow_missing_env, 'allow_missing_env'),
  }
  if (object.source !== undefined) request.source = assertSource(object.source)
  if (object.expected_source_id !== undefined) request.expected_source_id = assertSource(object.expected_source_id)
  if (object.mode !== undefined) {
    if (object.mode !== 'eval') throw new Error('mode 只能是 eval')
    request.mode = 'eval'
  }
  return request
}

function invalidItem(item: unknown, error: unknown): InstanceActionReceipt {
  const object = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
  return {
    name: typeof object.name === 'string' ? object.name : '<invalid>',
    operation: typeof object.operation === 'string' ? object.operation : '<invalid>',
    ok: false,
    error: { code: 'invalid_request', message: (error as Error).message },
  }
}

export function createInstancesHandler(assetRoot: string): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    if (signal.aborted) return failure('aborted', '实例操作已取消')
    try {
      if (endpoint === 'list') return ok(await listInstances(assetRoot, signal))
      if (endpoint === 'url') {
        const name = assertName(payloadObject(payload).name)
        const manifest = await manifestFor(assetRoot, name)
        if (!manifest) throw new Error(`未找到实例 ${name}`)
        const port = optionalPort(manifest.port)
        if (!port) throw new Error('实例未记录有效 Web 端口')
        const result = await runDsh(assetRoot, ['url', name, '--non-interactive'], signal)
        const url = new URL(result.stdout.trim())
        if (manifest.business_control) {
          if (typeof manifest.agent_id !== 'string') throw new Error('业务实例缺少 Agent 登记')
          const entry = businessGatewayEntry(assetRoot, manifest.agent_id, name)
          if (url.href !== entry) throw new Error('实例返回的业务网关地址与登记入口不一致')
          return ok({ url: entry, lan_access: false })
        }
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port || 80) !== port || url.username || url.password) {
          throw new Error('实例返回的 Web 地址与登记端口不一致')
        }
        return ok({ url: url.href, lan_access: manifest.lan_access === true })
      }
      if (endpoint === 'logs') {
        const object = payloadObject(payload)
        const name = assertName(object.name)
        const tail = object.tail === undefined ? 200 : object.tail
        if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 1 || tail > 500) {
          throw new Error('tail 必须是 1..500 的有限整数')
        }
        const result = await runDsh(assetRoot, ['logs', name, '--tail', String(tail)], signal)
        return ok({ name, logs: bounded(result.stdout), stderr: bounded(result.stderr) })
      }
      if (endpoint === 'detail') {
        const object = payloadObject(payload)
        return ok(await detail(assetRoot, assertName(object.name), signal))
      }
      if (endpoint === 'preview') return ok(await previewOne(assetRoot, actionRequest(payload), signal))
      if (endpoint === 'batch-preview') {
        const object = payloadObject(payload)
        if (!Array.isArray(object.items)) throw new Error('批量预览需要 items')
        const previews = []
        for (const item of object.items) {
          try {
            const request = actionRequest(item)
            previews.push({ name: request.name, operation: request.operation, ok: true,
              value: await previewOne(assetRoot, request, signal) })
          } catch (error) {
            previews.push(invalidItem(item, error))
          }
        }
        return ok({
          ok: previews.every(item => item.ok),
          partial_success: previews.some(item => item.ok) && previews.some(item => !item.ok),
          previews,
        })
      }
      if (endpoint === 'run') return ok(await runOne(assetRoot, actionRequest(payload), signal))
      if (endpoint === 'batch') {
        const object = payloadObject(payload)
        if (!Array.isArray(object.items)) throw new Error('批量操作需要 items')
        const receipts: InstanceActionReceipt[] = []
        for (const item of object.items) {
          try {
            receipts.push(await runOne(assetRoot, actionRequest(item), signal))
          } catch (error) {
            receipts.push(invalidItem(item, error))
          }
        }
        return ok({
          ok: receipts.every(item => item.ok),
          partial_success: receipts.some(item => item.ok) && receipts.some(item => !item.ok),
          receipts,
        })
      }
      return failure('not_found', '未知的实例操作')
    } catch (error) {
      return failure('instances_failed', (error as Error).message)
    }
  }
}
