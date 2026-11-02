import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AccessError, type AccessEvent, type AgentAccessConfiguration, type CredentialMetadata } from './contracts.ts'

export interface Credential extends CredentialMetadata { hash: string }
export interface SigningKey { kid: string; privateKey: string; publicJwk: Record<string, unknown>; status: 'active' | 'retiring' | 'revoked'; retireAt?: string }
export interface MachineState { schemaVersion: 1; credentials: Credential[]; keys: SigningKey[]; currentKid?: string }
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const statePath = (root: string) => join(root, '.local/agent-access/state.json')
export function readState(root: string): MachineState {
  const path = statePath(root)
  if (!existsSync(path)) return { schemaVersion: 1, credentials: [], keys: [] }
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value.schemaVersion !== 1 || !Array.isArray(value.credentials) || !Array.isArray(value.keys)) throw new AccessError('state_invalid', '机器访问状态格式无效', 503)
  return value
}
/** 与原有管理写入口使用同名排他锁；未知配置字段原样保留。 */
export function atomicUpdate<T>(path: string, update: (raw: string) => { text: string; result: T }): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lock = `${path}.lock`, temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let fd: number
  try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AccessError('conflict', '配置正在更新，请刷新后重试', 409)
    throw error
  }
  try {
    const result = update(existsSync(path) ? readFileSync(path, 'utf8') : '')
    writeFileSync(temporary, result.text, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
    return result.result
  } finally { closeSync(fd); rmSync(lock, { force: true }); rmSync(temporary, { force: true }) }
}
export function updateState<T>(root: string, update: (state: MachineState) => T): T {
  return atomicUpdate(statePath(root), raw => {
    const state = raw ? JSON.parse(raw) as MachineState : { schemaVersion: 1 as const, credentials: [], keys: [] }
    if (state.schemaVersion !== 1 || !Array.isArray(state.credentials) || !Array.isArray(state.keys)) throw new AccessError('state_invalid', '机器访问状态格式无效', 503)
    const result = update(state)
    return { text: JSON.stringify(state, null, 2) + '\n', result }
  })
}
export function readConfiguration(root: string): { config: AgentAccessConfiguration; revision: string } {
  const path = join(root, 'config/business-access.json')
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const value = raw ? JSON.parse(raw) : {}
  if (value.agentAccess === undefined) return { config: { schemaVersion: 1, issuer: '', resources: [], grants: [] }, revision: digest(raw) }
  const config = value.agentAccess
  if (config.schemaVersion !== 1 || typeof config.issuer !== 'string' || !Array.isArray(config.resources) || !Array.isArray(config.grants)) throw new AccessError('config_invalid', '实例资源访问配置无效', 503)
  return { config, revision: digest(raw) }
}
export function updateConfiguration<T>(root: string, revision: string, update: (config: AgentAccessConfiguration) => T): T {
  return atomicUpdate(join(root, 'config/business-access.json'), raw => {
    if (digest(raw) !== revision) throw new AccessError('conflict', '配置已更新，请刷新后重试', 409)
    const parent = raw ? JSON.parse(raw) : { schemaVersion: 1, enabled: false, agents: [] }
    const config: AgentAccessConfiguration = parent.agentAccess ?? { schemaVersion: 1, issuer: '', resources: [], grants: [] }
    if (config.schemaVersion !== 1 || !Array.isArray(config.resources) || !Array.isArray(config.grants)) throw new AccessError('config_invalid', '实例资源访问配置无效', 503)
    const result = update(config)
    parent.agentAccess = config
    return { text: JSON.stringify(parent, null, 2) + '\n', result }
  })
}
export function recordEvent(root: string, event: AccessEvent): void {
  const directory = join(root, '.local/agent-access/records')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // 只接收固定元数据；正文、token、凭据不进入持久记录。
  const { requestId, at, instanceId, credentialId, resourceId, operation, jti, grantVersion, stage, reason, httpStatus } = event
  appendFileSync(join(directory, `${at.slice(0, 10)}.jsonl`), JSON.stringify({ requestId, at, instanceId, credentialId, resourceId, operation, jti, grantVersion, stage, reason, httpStatus }) + '\n', { mode: 0o600 })
  const cutoff = new Date(Date.parse(at) - 30 * 86400000).toISOString().slice(0, 10)
  for (const file of readdirSync(directory)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) rmSync(join(directory, file))
}
export function readEvents(root: string, instanceId?: string): AccessEvent[] {
  const directory = join(root, '.local/agent-access/records')
  if (!existsSync(directory)) return []
  const cutoff = Date.now() - 30 * 86400000
  const files = readdirSync(directory).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && Date.parse(file.slice(0, 10)) >= cutoff).sort().reverse()
  const result: AccessEvent[] = []
  for (const file of files) {
    const rows = readFileSync(join(directory, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AccessEvent)
    result.push(...rows.reverse().filter(row => !instanceId || row.instanceId === instanceId))
    if (result.length >= 500) break
  }
  return result.slice(0, 500)
}
