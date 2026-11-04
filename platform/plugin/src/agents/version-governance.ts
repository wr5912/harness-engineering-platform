import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { load } from 'js-yaml'
import { VERSION_ID, isVariantIdentity, validVersionId, versionRole } from '../version-id.ts'
import { candidateDigest, sha256 } from '../tasks/files.ts'
import { instanceStateRoot, workspaceLocalPath, workspaceOwnsInstance } from '../workspace.ts'

export class VersionGovernanceError extends Error {
  readonly code: string
  constructor(message: string, code = 'version_governance') { super(message); this.code = code }
}

export function versionGovernance(root: string, agent: string) {
  const directory = join(root, 'evolution/experiments')
  const versions = (existsSync(directory) ? readdirSync(directory).sort() : []).filter(id => {
    if (!validVersionId(id) || !id.startsWith('EXP-') || VERSION_ID.exec(id)![1] !== agent) return false
    const file = join(directory, id, 'change.yaml')
    return existsSync(file) && !isVariantIdentity(id, load(readFileSync(file, 'utf8')) as Record<string, unknown>)
  })
  const generation = Math.max(0, ...versions.map(id => Number(VERSION_ID.exec(id)![2])))
  const managed = versions.some(id => versionRole(id))
  const mainlines = versions.filter(id => versionRole(id) === 'm' && Number(VERSION_ID.exec(id)![2]) === generation)
  return { agent_id: agent, generation, managed, versions, mainline_id: mainlines.length === 1 ? mainlines[0]! : null,
    conflict: managed && mainlines.length !== 1 }
}

export function versionAccess(root: string, id: string) {
  const match = VERSION_ID.exec(id)
  if (!match || !validVersionId(id)) throw new VersionGovernanceError('版本 ID 无效')
  const change = join(root, 'evolution/experiments', id, 'change.yaml')
  if (isVariantIdentity(id, existsSync(change) ? load(readFileSync(change, 'utf8')) as Record<string, unknown> : {})) {
    return { role: null, generation: Number(match[2]), historical: false, editable: true, reason: '', mainline_id: null }
  }
  const state = versionGovernance(root, match[1]!)
  const historical = (state.managed || match[1] === 'security-operations-expert') && Number(match[2]) < state.generation || match[1] === 'security-operations-expert' && Number(match[2]) < 27
  const role = versionRole(id)
  const identity = existsSync(change) ? load(readFileSync(change, 'utf8')) as Record<string, unknown> : {}
  const reason = identity.assets_retired ? '特性当前资产已清理，只读历史；按 archived_ref 派生或复现。'
    : identity.current_version_id ? '旧身份只读；当前资产见迁移后的版本，历史来源按 archived_ref 读取。'
    : historical ? '历史代资产只读，仍可从固定来源派生或复现。'
    : state.managed && !role ? '旧身份只读，请先完成当前版本身份迁移。' : ''
  return { role, generation: Number(match[2]), historical, editable: !reason, reason, mainline_id: state.mainline_id }
}

export function assertVersionEditable(root: string, id: string) {
  const access = versionAccess(root, id)
  if (!access.editable) throw new VersionGovernanceError(access.reason)
}

export function featureDispositionsPending(root: string, agent: string) {
  const state = versionGovernance(root, agent)
  const main = state.mainline_id ? load(readFileSync(join(root, 'evolution/experiments', state.mainline_id, 'change.yaml'), 'utf8')) as Record<string, any> : {}
  return state.versions.filter(id => versionRole(id) === 'f' && Number(VERSION_ID.exec(id)![2]) === state.generation)
    .filter(id => !(load(readFileSync(join(root, 'evolution/experiments', id, 'change.yaml'), 'utf8')) as Record<string, unknown>).assets_retired)
    .filter(id => {
      try { return !(Array.isArray(main.fusion_sources) ? main.fusion_sources : []).some((source: Record<string, any>) => source?.experiment_id === id && source.merged_at
        && source.candidate_sha256 === candidateDigest(join(root, 'evolution/experiments', id, 'candidate'))) }
      catch { return true }
    })
}

export function versionInstanceDependencies(root: string, ids: string[]) {
  const dependencies: { name: string; source_id: string }[] = []
  const directory = instanceStateRoot(root)
  if (existsSync(directory)) for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(directory, entry.name, 'instance.json')
    if (!existsSync(file)) continue
    if (lstatSync(file).isSymbolicLink()) throw new VersionGovernanceError('实例登记不能是符号链接')
    const instance = JSON.parse(readFileSync(file, 'utf8'))
    if (workspaceOwnsInstance(root, instance) && ids.some(id => instance.source_id === `experiment:${id}`)) dependencies.push({ name: entry.name, source_id: instance.source_id })
  }
  return dependencies
}

export function featureDispositions(root: string, agent: string, input: unknown) {
  const unresolved = featureDispositionsPending(root, agent)
  const rows = input === undefined ? [] : input
  if (!Array.isArray(rows)) throw new VersionGovernanceError('feature_dispositions 必须是数组', 'invalid_request')
  const seen = new Set<string>()
  const dispositions = rows.map(row => {
    if (!row || typeof row !== 'object' || !unresolved.includes(row.experiment_id) || seen.has(row.experiment_id)
      || !['defer', 'reject'].includes(row.decision) || typeof row.reason !== 'string' || !row.reason.trim()) throw new VersionGovernanceError('逐项说明未合并特性的 defer/reject 处置及原因，不能自报已合并', 'invalid_request')
    seen.add(row.experiment_id)
    return { experiment_id: row.experiment_id as string, decision: row.decision as string, reason: row.reason.trim() as string,
      candidate_sha256: candidateDigest(join(root, 'evolution/experiments', row.experiment_id, 'candidate')) }
  })
  if (unresolved.some(id => !seen.has(id))) throw new VersionGovernanceError(`创建下一代前须明确处置未合并特性：${unresolved.filter(id => !seen.has(id)).join('、')}`)
  return dispositions
}

export function allocateVersion(root: string, agent: string, parent?: string, requested?: unknown, options: { version_role?: unknown; create_next_generation?: unknown; feature_dispositions?: unknown } = {}) {
  if (requested !== undefined && (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1 || requested > 999)) throw new VersionGovernanceError('version_number 必须是 1–999 的整数', 'invalid_request')
  const state = versionGovernance(root, agent)
  if (state.conflict) throw new VersionGovernanceError('当前代主线不唯一或缺失，请先核对版本身份')
  if (parent && isVariantIdentity(parent, existsSync(join(root, 'evolution/experiments', parent, 'change.yaml')) ? load(readFileSync(join(root, 'evolution/experiments', parent, 'change.yaml'), 'utf8')) as Record<string, unknown> : {})) throw new VersionGovernanceError('变体不能作为新版本的继承来源', 'invalid_request')
  if (parent && (VERSION_ID.exec(parent)?.[1] !== agent || !state.versions.includes(parent))) throw new VersionGovernanceError('父版必须是本 Agent 的非变体版本')
  if (options.create_next_generation !== undefined && typeof options.create_next_generation !== 'boolean') throw new VersionGovernanceError('create_next_generation 必须为布尔值', 'invalid_request')
  if (options.version_role !== undefined && !['m', 'f'].includes(String(options.version_role))) throw new VersionGovernanceError('version_role 必须为 m 或 f', 'invalid_request')
  let generation: number, role: 'm' | 'f'
  if (state.managed) {
    if (!parent) throw new VersionGovernanceError('缺少固定父版')
    if (options.create_next_generation) {
      if (parent !== state.mainline_id) throw new VersionGovernanceError('创建下一代须从当前主线继承')
      featureDispositions(root, agent, options.feature_dispositions)
    }
    generation = state.generation + (options.create_next_generation ? 1 : 0)
    role = options.create_next_generation ? 'm' : 'f'
  } else {
    if (options.create_next_generation || options.version_role !== undefined) throw new VersionGovernanceError('既有无角色版本先完成明确的身份迁移；其他 Agent 保留旧创建合同')
    if (agent === 'security-operations-expert' && state.generation >= 27) throw new VersionGovernanceError('先按 027 迁移计划建立现有 m/f 身份，不能额外创建主线')
    // 未迁移的其他 Agent 保留原有创建合同，不批量回溯其身份。
    if (agent !== 'security-operations-expert' && state.generation > 0) {
      const number = requested ?? state.generation + 1
      if (Number(number) > 999) throw new VersionGovernanceError('版本编号已达 999')
      return `EXP-${agent}-${String(number).padStart(3, '0')}-r${randomBytes(6).toString('hex')}`
    }
    generation = agent === 'security-operations-expert' ? Math.max(27, state.generation) : 1
    role = 'm'
  }
  if (generation > 999) throw new VersionGovernanceError('版本编号已达 999，不能再产生下一代')
  if (requested !== undefined && requested !== generation) throw new VersionGovernanceError(`本次只能创建 ${String(generation).padStart(3, '0')}-${role}，不能跳代或回写历史代`)
  if (options.version_role !== undefined && options.version_role !== role) throw new VersionGovernanceError(`本次操作的角色为 ${role}；下一代主线须明确 create_next_generation`)
  let id: string
  do { id = `EXP-${agent}-${String(generation).padStart(3, '0')}-${role}-r${randomBytes(6).toString('hex')}` } while (existsSync(join(root, 'evolution/experiments', id)))
  return id
}

export function governanceSnapshot(root: string, agent: string, exclude?: string) {
  return sha256(JSON.stringify(versionGovernance(root, agent).versions.filter(id => id !== exclude).map(id => {
    const directory = join(root, 'evolution/experiments', id)
    return [id, sha256(readFileSync(join(directory, 'change.yaml'))), existsSync(join(directory, 'candidate')) ? candidateDigest(join(directory, 'candidate')) : null]
  })))
}

export async function withVersionLock<T>(root: string, agent: string, operation: () => Promise<T>): Promise<T> {
  const file = workspaceLocalPath(root, 'version-governance', `${agent}.lock`)
  mkdirSync(dirname(file), { recursive: true })
  let fd: number
  try { fd = openSync(file, 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new VersionGovernanceError('该 Agent 正在创建或采纳版本，请稍后重试；异常退出留下的锁须先核对进程再清理', 'conflict'); throw error }
  try { writeFileSync(fd, String(process.pid)); return await operation() }
  finally { closeSync(fd); rmSync(file, { force: true }) }
}
