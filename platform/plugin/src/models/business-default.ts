import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

type ModelRoute = Pick<ModelSelection, 'provider' | 'model'>
export type BusinessDefault = { default: ModelSelection | null; revision: string; migrationRequired: boolean; legacyDefault: ModelSelection | null }

const emptyRevision = createHash('sha256').update('').digest('hex')
const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex')
const modelIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/

export class BusinessDefaultError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function configDirectory(root: string, create: boolean): string {
  const directory = join(root, 'config')
  try {
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BusinessDefaultError('path_rejected', '业务默认模型配置目录必须是实体目录')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (create) {
      try { mkdirSync(directory, { mode: 0o700 }) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      const stat = lstatSync(directory)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BusinessDefaultError('path_rejected', '业务默认模型配置目录必须是实体目录')
    }
  }
  return directory
}

export function businessPolicyLockFile(root: string): string {
  return join(configDirectory(root, true), '.business-model-policy.lock')
}

function modelFile(root: string, create: boolean): string {
  return join(configDirectory(root, create), 'business-model-default.json')
}

function fileText(file: string): string | null {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new BusinessDefaultError('path_rejected', '业务默认模型配置必须是实体文件')
    if (stat.size > 16 * 1024) throw new BusinessDefaultError('invalid_asset', '业务默认模型配置文件过大')
    const text = readFileSync(file, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > 16 * 1024) throw new BusinessDefaultError('invalid_asset', '业务默认模型配置文件过大')
    return text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function selection(value: unknown): ModelSelection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))
    || typeof item.provider !== 'string' || !modelIdentifier.test(item.provider)
    || typeof item.model !== 'string' || !modelIdentifier.test(item.model)
    || (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string' || !modelIdentifier.test(item.reasoningEffort)))) return null
  return item.reasoningEffort === undefined
    ? { provider: item.provider, model: item.model }
    : { provider: item.provider, model: item.model, reasoningEffort: item.reasoningEffort as string }
}

function legacyDefault(value: Record<string, unknown>): ModelSelection | null {
  const selected = value.default === null ? null : selection(value.default)
  if (value.default !== null && !selected) throw new BusinessDefaultError('invalid_asset', '旧业务默认模型配置格式无效')
  if (value.schema_version === '1.1') {
    if (!Array.isArray(value.allowed) || value.allowed.length > 200) throw new BusinessDefaultError('invalid_asset', '旧业务模型范围格式无效')
    const allowed = value.allowed.map(item => {
      const route = selection(item)
      return route && !route.reasoningEffort ? route as ModelRoute : null
    })
    if (allowed.some(item => !item || item.provider === 'deepseek-account')
      || new Set(allowed.map(item => `${item?.provider}\0${item?.model}`)).size !== allowed.length
      || (allowed.length > 0 && (!selected || !allowed.some(item => item?.provider === selected.provider && item?.model === selected.model)))
      || (allowed.length === 0 && selected)) throw new BusinessDefaultError('invalid_asset', '旧业务模型范围格式无效')
  }
  return selected
}

function decode(text: string | null): BusinessDefault {
  if (text === null) return { default: null, revision: emptyRevision, migrationRequired: false, legacyDefault: null }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new BusinessDefaultError('invalid_asset', '业务默认模型配置无法解析') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BusinessDefaultError('invalid_asset', '业务默认模型配置格式无效')
  const value = parsed as Record<string, unknown>
  const revision = revisionOf(text)
  if ((value.schema_version === '1.0' && Object.keys(value).length === 2 && Object.hasOwn(value, 'default'))
    || (value.schema_version === '1.1' && Object.keys(value).length === 3 && Object.hasOwn(value, 'allowed') && Object.hasOwn(value, 'default'))) {
    return { default: null, revision, migrationRequired: true, legacyDefault: legacyDefault(value) }
  }
  if (value.schema_version !== '1.2' || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'default')) {
    throw new BusinessDefaultError('invalid_asset', '业务默认模型配置格式无效')
  }
  const selected = value.default === null ? null : selection(value.default)
  if (value.default !== null && (!selected || selected.provider === 'deepseek-account')) {
    throw new BusinessDefaultError('invalid_asset', '业务默认模型配置格式无效')
  }
  return { default: selected, revision, migrationRequired: false, legacyDefault: null }
}

/** 旧 1.0/1.1 文件只供迁移显示，不产生新的默认选择。 */
export function readBusinessDefault(root: string): BusinessDefault {
  const file = modelFile(root, false)
  const lock = `${file}.lock`
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let attempt = 0; attempt < 5; attempt++) {
    if (fileText(lock) === null) {
      const observed = fileText(file)
      if (fileText(lock) === null && fileText(file) === observed) return decode(observed)
    }
    Atomics.wait(pause, 0, 0, 10)
  }
  throw new BusinessDefaultError('busy', '业务默认模型配置正在保存或保存锁未释放；确认没有写入进程后移除 business-model-default.json.lock，再重试')
}

/** 调用方须先持有 config/.business-model-policy.lock，和实例启动互斥。 */
export async function saveBusinessDefault(root: string, defaultModel: ModelSelection | null,
  revision: string, signal?: AbortSignal): Promise<BusinessDefault> {
  const selected = defaultModel === null ? null : selection(defaultModel)
  if (!selected || selected.provider === 'deepseek-account') {
    throw new BusinessDefaultError('invalid_request', '请选择目录中可用于业务智能体的模型')
  }
  const file = modelFile(root, true)
  const lockFile = `${file}.lock`
  let lock: number | undefined
  for (let attempt = 0; attempt <= 120; attempt++) {
    if (signal?.aborted) throw new BusinessDefaultError('aborted', '模型操作已取消')
    try { lock = openSync(lockFile, 'wx', 0o600); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 120) throw new BusinessDefaultError('busy', '业务默认模型配置正在保存或保存锁未释放；确认没有写入进程后移除 business-model-default.json.lock，再重试')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  if (lock === undefined) throw new BusinessDefaultError('busy', '业务默认模型配置保存锁未释放')
  try {
    const current = decode(fileText(file))
    if (current.revision !== revision) throw new BusinessDefaultError('conflict', '业务默认模型配置已变化，请刷新后重试')
    if (signal?.aborted) throw new BusinessDefaultError('aborted', '模型操作已取消')
    const text = `${JSON.stringify({ schema_version: '1.2', default: selected }, null, 2)}\n`
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
      chmodSync(temporary, 0o600)
      if (decode(fileText(file)).revision !== revision) throw new BusinessDefaultError('conflict', '业务默认模型配置已变化，请刷新后重试')
      renameSync(temporary, file)
    } finally { rmSync(temporary, { force: true }) }
    return { default: selected, revision: revisionOf(text), migrationRequired: false, legacyDefault: null }
  } finally { closeSync(lock); rmSync(lockFile, { force: true }) }
}
