import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dump, load } from 'js-yaml'
import { atomicWrite, candidateDigest, dataPath, gitCandidateDigest, sha256 } from '../tasks/files.ts'
import { workspaceConfigPath } from '../workspace.ts'
import { versionIdentity, versionSource } from './version-source.ts'
import { VersionGovernanceError, versionInstanceDependencies, withVersionLock } from './version-governance.ts'

const AGENT = 'security-operations-expert'
export const VERSION_027_MAPPING = [
  ['reab20c48f610', 'm'], ['r0318e00a959b', 'f'], ['r058697202fb8', 'f'],
].map(([suffix, role]) => ({ from: `EXP-${AGENT}-027-${suffix}`, to: `EXP-${AGENT}-027-${role}-${suffix}` }))
type MapValue = Record<string, any>
type Write = { path: string; before: string | null; after: string }
const yaml = (value: unknown) => dump(value, { lineWidth: -1, noRefs: true })

/** 只映射完整身份和 Candidate 路径；历史文本及固定 Git 引用不参与替换。 */
function currentReference(root: string, value: string): string {
  for (const { from, to } of VERSION_027_MAPPING) {
    if (value === from) return to
    if (value === `experiment:${from}`) return `experiment:${to}`
    const prefix = `evolution/experiments/${from}/candidate`
    if (value === prefix || value.startsWith(prefix + '/')) return `evolution/experiments/${to}/candidate` + value.slice(prefix.length)
    const absolute = join(root, prefix)
    if (value === absolute || value.startsWith(absolute + '/')) return join(root, `evolution/experiments/${to}/candidate`) + value.slice(absolute.length)
  }
  return value
}

function mapReferences(root: string, value: any, fields: string[], path: string[] = []): any {
  if (typeof value === 'string') {
    const updated = currentReference(root, value)
    if (updated !== value) fields.push(path.join('.'))
    return updated
  }
  if (Array.isArray(value)) return value.map((item, index) => mapReferences(root, item, fields, [...path, String(index)]))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const updatedKey = currentReference(root, key)
    if (updatedKey !== key && Object.hasOwn(value, updatedKey)) throw new VersionGovernanceError('当前配置已包含迁移目标，不能覆盖现有键')
    if (updatedKey !== key) fields.push([...path, key].join('.'))
    return [updatedKey, mapReferences(root, item, fields, [...path, updatedKey])]
  }))
  return value
}

export function planVersion027Migration(root: string) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  const commit = head.stdout.trim()
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(commit)) throw new VersionGovernanceError('迁移前须固定完整来源到 Git')
  const writes: Write[] = [], moves: { from: string; to: string; candidate_sha256: string }[] = []
  const references: { path: string; fields: string[] }[] = []
  for (const { from, to } of VERSION_027_MAPPING) {
    const source = `evolution/experiments/${from}`, target = `evolution/experiments/${to}`
    const change = versionIdentity(root, from)
    if (change.current_version_id || existsSync(dataPath(root, target))) throw new VersionGovernanceError('迁移目标已存在或旧身份已迁移，请先核对当前目录')
    versionSource(root, from, commit)
    const candidate = dataPath(root, `${source}/candidate`)
    const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', `${source}/candidate`], { cwd: root, encoding: 'utf8' })
    if (dirty.status !== 0 || dirty.stdout.trim()) throw new VersionGovernanceError(`先固定完整 Candidate 再迁移：${from}`)
    const digest = candidateDigest(candidate)
    if (gitCandidateDigest(root, from, `git:${commit}`) !== digest) throw new VersionGovernanceError(`先固定完整 Candidate 再迁移：${from}`)
    moves.push({ from: `${source}/candidate`, to: `${target}/candidate`, candidate_sha256: digest })
    const changeFile = `${source}/change.yaml`, before = readFileSync(dataPath(root, changeFile), 'utf8')
    writes.push({ path: changeFile, before, after: yaml({ ...change, current_version_id: to, archived_ref: `git:${commit}` }) })
    // 新身份不能继承旧身份的验收结论或回执；历史原件继续留在旧目录。
    const { creation, outcome, fusion_sources, ...identity } = change
    if (Array.isArray(fusion_sources)) identity.fusion_sources = fusion_sources.map(source => typeof source === 'string' ? source : { experiment_id: source.experiment_id, ref: source.ref })
    writes.push({ path: `${target}/change.yaml`, before: null, after: yaml({ ...identity, experiment_id: to, status: 'active', outcome: 'inconclusive' }) })
    for (const entry of readdirSync(dataPath(root, source), { withFileTypes: true })) {
      if (entry.name === 'change.yaml' || !entry.isFile() || !['hypothesis.md', 'decision.md'].includes(entry.name)) continue
      const text = readFileSync(dataPath(root, `${source}/${entry.name}`), 'utf8')
      writes.push({ path: `${target}/${entry.name}`, before: null, after: entry.name === 'decision.md'
        ? `# Decision\n\n身份迁移后尚未验收；旧身份结论见 ${source}/decision.md。\n` : text })
    }
  }
  const manifest = `agents/${AGENT}/manifest.yaml`
  const referenceFiles = [manifest, 'config/business-runtime.json', 'config/business-access.json',
    'config/sources.json', 'config/sites.json', 'config/mcp-manager.json']
  for (const [name, path] of [['sources.json', 'runtime/adapters/dsh-container/sources.json'], ['sites.json', 'runtime/adapters/dsh-web/sites.json']]) {
    if (workspaceConfigPath(root, name!) === join(root, path!)) referenceFiles.push(path!)
  }
  for (const path of referenceFiles) {
    const file = dataPath(root, path)
    if (!existsSync(file)) continue
    const before = readFileSync(file, 'utf8'), fields: string[] = []
    const parsed = path.endsWith('.json') ? JSON.parse(before) : load(before)
    const updated = mapReferences(root, parsed, fields)
    if (fields.length) {
      references.push({ path, fields })
      writes.push({ path, before, after: path.endsWith('.json') ? JSON.stringify(updated, null, 2) + '\n' : yaml(updated) })
    }
  }
  const dependencies = versionInstanceDependencies(root, VERSION_027_MAPPING.map(item => item.from))
  const summary = { mapping: VERSION_027_MAPPING, source_ref: `git:${commit}`, moves, references, dependencies,
    writes: writes.map(({ path, before, after }) => ({ path, before_sha256: before === null ? null : sha256(before), after_sha256: sha256(after) })),
    preserved: ['旧身份及固定 Git 来源', '旧目录的 Run、归档与研究原文', '实例实际加载登记，不冒充已重载'],
    ready: true }
  return { ...summary, plan_sha256: sha256(JSON.stringify(summary)), writes }
}

export async function applyVersion027Migration(root: string, input: MapValue) {
  if (input.confirmed !== true) throw new VersionGovernanceError('请先确认迁移预览', 'confirmation_required')
  return withVersionLock(root, AGENT, async () => {
    const plan = planVersion027Migration(root)
    if (typeof input.expected_plan_sha256 !== 'string' || plan.plan_sha256 !== input.expected_plan_sha256) throw new VersionGovernanceError('迁移计划或当前引用已变化，请重新预览', 'conflict')
    const moved: typeof plan.moves = [], written: Write[] = []
    try {
      for (const move of plan.moves) {
        if (candidateDigest(dataPath(root, move.from)) !== move.candidate_sha256) throw new VersionGovernanceError('迁移前 Candidate 已变化', 'conflict')
        mkdirSync(dirname(dataPath(root, move.to)), { recursive: true })
        renameSync(dataPath(root, move.from), dataPath(root, move.to)); moved.push(move)
      }
      for (const write of plan.writes) {
        const file = dataPath(root, write.path)
        if (write.before === null ? existsSync(file) : readFileSync(file, 'utf8') !== write.before) throw new VersionGovernanceError('写入前引用已变化，请重新预览', 'conflict')
        atomicWrite(file, write.after); written.push(write)
      }
    } catch (error) {
      for (const write of written.reverse()) {
        const file = dataPath(root, write.path)
        if (readFileSync(file, 'utf8') !== write.after) continue
        if (write.before === null) rmSync(file); else atomicWrite(file, write.before)
      }
      for (const move of moved.reverse()) renameSync(dataPath(root, move.to), dataPath(root, move.from))
      for (const { to } of VERSION_027_MAPPING) {
        const target = dataPath(root, `evolution/experiments/${to}`)
        if (existsSync(target) && !readdirSync(target).length) rmSync(target, { recursive: true })
      }
      throw error
    }
    return { mapping: plan.mapping, plan_sha256: plan.plan_sha256, migrated: true, note: '身份与当前引用已迁移，历史证据未改写；新 m 仍须独立装载和验收。' }
  })
}

export function version027MigrationPreview(root: string) {
  const { writes, ...plan } = planVersion027Migration(root)
  return { ...plan, writes: writes.map(({ path, before, after }) => ({ path, before_sha256: before === null ? null : sha256(before), after_sha256: sha256(after) })) }
}
