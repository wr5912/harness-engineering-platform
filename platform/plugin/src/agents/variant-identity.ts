import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dump, load } from 'js-yaml'
import { VERSION_ID, isVariantIdentity, assertInheritableVersion } from '../version-id.ts'
import { candidateDigest, candidateFiles, dataPath, sha256, sourceInfo } from '../tasks/files.ts'
import { versionIdentity, versionSource } from './version-source.ts'

type MapValue = Record<string, any>
class IdentityError extends Error { constructor(readonly code: string, message: string) { super(message) } }
function fail(message: string, code = 'invalid_request'): never { throw new IdentityError(code, message) }
function canonical(value: any): string {
  const ordered = (item: any): any => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item
  return JSON.stringify(ordered(value))
}
const changePath = (root: string, id: string) => dataPath(root, `evolution/experiments/${id}/change.yaml`)
function matchingTask(source: MapValue, target: MapValue) {
  if (source.agent_id !== target.agent_id || !source.parent_experiment_id || source.parent_experiment_id !== target.parent_experiment_id
    || (source.parent_ref ?? source.baseline_ref) !== (target.parent_ref ?? target.baseline_ref)
    || !source.compute_variant?.case_hashes || !Object.keys(source.compute_variant.case_hashes).length
    || canonical(Object.keys(source.compute_variant.case_hashes).sort()) !== canonical(Object.keys(target.compute_variant?.case_hashes ?? {}).sort())) fail('当前 VAR 必须属于同一 Agent、固定业务父版和评测任务')
  const left = source.compute_variant.generation?.source_run_ids, right = target.compute_variant?.generation?.source_run_ids
  if (Array.isArray(left) && left.length && canonical([...left].sort()) !== canonical(Array.isArray(right) ? [...right].sort() : [])) fail('当前 VAR 的生成依据与原变体不一致')
}
function targetIdentity(root: string, source: MapValue, id: string, checkTask = true) {
  if (!VERSION_ID.test(id) || !id.startsWith('VAR-')) fail('当前变体身份必须为 VAR')
  const target = versionIdentity(root, id)
  if (target.current_variant_id !== undefined) fail('当前 VAR 不能再跳转其他身份，禁止循环或多级映射')
  if (source.agent_id !== target.agent_id) fail('当前 VAR 与原变体不属于同一 Agent')
  if (checkTask) matchingTask(source, target)
  versionSource(root, id)
  return target
}

/** 映射只保存在原 change.yaml；读取历史资产和 Run 时仍使用原始身份。 */
export function currentVariantProjection(root: string, id: string, change: MapValue) {
  if (change.current_variant_id === undefined) return { current_variant_id: null as string | null, is_current: true }
  if (!id.startsWith('EXP-') || !isVariantIdentity(id, change) || typeof change.current_variant_id !== 'string') fail('只有历史 EXP 变体可以指向当前 VAR')
  targetIdentity(root, change, change.current_variant_id, false)
  return { current_variant_id: change.current_variant_id as string, is_current: false }
}

/** 只重定位当前 Candidate 路径和来源引用，不改写 Run 路径或训练来源身份。 */
export function mapCurrentVariantReferences(content: string, source: string, target: string) {
  return content.replaceAll(`evolution/experiments/${source}/candidate`, `evolution/experiments/${target}/candidate`)
    .replaceAll(`experiment:${source}`, `experiment:${target}`)
}
function atomic(file: string, before: string, content: string) {
  if (readFileSync(file, 'utf8') !== before) fail('身份来源在执行期间发生变化，请重新预览', 'conflict')
  const temporary = `${file}.${randomUUID()}.identity.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: lstatSync(file).mode & 0o777 })
    if (readFileSync(file, 'utf8') !== before) fail('身份来源在执行期间发生变化，请重新预览', 'conflict')
    renameSync(temporary, file)
  } finally { rmSync(temporary, { force: true }) }
}
function treeDigest(root: string): string {
  const rows: unknown[] = []
  function walk(path: string) {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name), stat = lstatSync(file)
      if (stat.isSymbolicLink()) fail('迁移目标出现符号链接', 'conflict')
      if (stat.isDirectory()) { rows.push([file.slice(root.length), 'directory']); walk(file) }
      else if (stat.isFile()) rows.push([file.slice(root.length), stat.mode & 0o111, sha256(readFileSync(file))])
    }
  }
  walk(root)
  return sha256(canonical(rows))
}

export function createVariantIdentityMigrationHandler(root: string) {
  type Snapshot = ReturnType<typeof snapshot>
  const previews = new Map<string, { source: string; target: string; mode: 'create' | 'associate'; snapshot: Snapshot }>()
  let busy = false
  function snapshot(id: string, target?: string) {
    const source = sourceInfo(root, id), file = changePath(root, id), content = readFileSync(file, 'utf8'), change = versionIdentity(root, id)
    if (!id.startsWith('EXP-') || !isVariantIdentity(id, change) || !change.compute_variant || typeof change.compute_variant !== 'object') fail('仅迁移已有 compute_variant 计划的历史 EXP 变体，普通业务版本保持原身份')
    const current = currentVariantProjection(root, id, change)
    const parent = change.parent_experiment_id, ref = change.parent_ref ?? change.baseline_ref
    if (typeof parent !== 'string' || !VERSION_ID.test(parent) || typeof ref !== 'string' || !/^git:[0-9a-f]{40}$/i.test(ref)) fail('原变体必须保留固定业务父版')
    const parentChange = versionIdentity(root, parent), fixedParent = versionIdentity(root, parent, ref.slice(4))
    if (parentChange.agent_id !== change.agent_id || fixedParent.agent_id !== change.agent_id) fail('固定业务父版必须属于同一 Agent')
    assertInheritableVersion(parent, parentChange)
    assertInheritableVersion(parent, fixedParent)
    const manifestPath = dataPath(root, `agents/${source.agent_id}/manifest.yaml`)
    const manifest = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
    let targetSnapshot: MapValue | null = null
    if (target && existsSync(changePath(root, target))) {
      const targetChange = targetIdentity(root, change, target, !current.current_variant_id)
      targetSnapshot = { change_sha256: sha256(readFileSync(changePath(root, target))), candidate_sha256: candidateDigest(sourceInfo(root, target).candidate), change: targetChange }
    }
    return { source, content, change, current, candidate_sha256: candidateDigest(source.candidate), manifestPath, manifest, target: targetSnapshot }
  }
  function freshId(agent: string) {
    const directory = dataPath(root, 'evolution/experiments')
    const next = Math.max(0, ...readdirSync(directory).filter(id => id.startsWith('VAR-') && VERSION_ID.exec(id)?.[1] === agent).map(id => Number(VERSION_ID.exec(id)![2]))) + 1
    let id: string
    do { id = `VAR-${agent}-${String(next).padStart(3, '0')}-r${randomBytes(6).toString('hex')}` } while (existsSync(join(directory, id)))
    return id
  }
  function view(source: string, target: string, mode: string, current = false) {
    return { experiment_id: source, current_variant_id: target, is_current: false, mode, already_migrated: current,
      history: { experiment_id: source, runs_preserved: true, git_preserved: true, instances_unchanged: true },
      next_step: '查看当前 VAR；新身份的构建、冻结和独立 Run 分别核对，历史 Run 仍属于原 EXP。' }
  }
  return async (method: string, body: MapValue, signal?: AbortSignal) => {
    try {
      signal?.throwIfAborted()
      if (!['identity-preview', 'identity-apply'].includes(method)) fail('未知变体身份操作')
      if (typeof body.experiment_id !== 'string' || !VERSION_ID.test(body.experiment_id)) fail('experiment_id 格式无效')
      const id = body.experiment_id, requested = body.current_variant_id
      if (requested !== undefined && (typeof requested !== 'string' || !VERSION_ID.test(requested) || !requested.startsWith('VAR-'))) fail('current_variant_id 必须为已有 VAR 身份')
      const initial = snapshot(id, requested)
      if (initial.current.current_variant_id) {
        if (requested && requested !== initial.current.current_variant_id) fail('旧变体已关联其他当前 VAR，不能覆盖映射', 'conflict')
        return { ok: true as const, value: view(id, initial.current.current_variant_id, 'associated', true) }
      }
      if (method === 'identity-preview') {
        if (requested && !initial.target) fail('指定的当前 VAR 不存在')
        const target = requested ?? freshId(initial.source.agent_id), mode = requested ? 'associate' as const : 'create' as const
        const frozen = snapshot(id, target)
        const fingerprint = sha256(canonical({ source: id, target, mode, snapshot: frozen }))
        previews.set(fingerprint, { source: id, target, mode, snapshot: frozen })
        return { ok: true as const, value: { ...view(id, target, mode), preview_sha256: fingerprint,
          candidate_sha256: frozen.candidate_sha256, source_change_sha256: sha256(frozen.content),
          target_candidate_sha256: frozen.target?.candidate_sha256 ?? null,
          candidate_files_count: mode === 'create' ? candidateFiles(frozen.source.candidate).length : 0,
          effects: mode === 'associate' ? ['保留已有 VAR 的全部当前资产，仅保存原 EXP 到当前 VAR 的引用'] : ['将当前 Candidate 和研究计划迁移到新 VAR，不复制历史 Run、比较结论或构建回执'],
          apply_input: { experiment_id: id, current_variant_id: target, expected_preview_sha256: fingerprint } } }
      }
      if (busy) fail('变体身份迁移正在执行', 'conflict')
      const prepared = previews.get(body.expected_preview_sha256)
      if (!prepared || prepared.source !== id || requested && requested !== prepared.target) fail('身份预览不存在或已过期，请重新预览', 'conflict')
      const latest = snapshot(id, prepared.target)
      if (canonical(latest) !== canonical(prepared.snapshot)) fail('变体、当前 VAR 或登记来源已变化，请重新预览', 'conflict')
      if (prepared.mode === 'create' && existsSync(dataPath(root, `evolution/experiments/${prepared.target}`))) fail('VAR 身份已被占用，请重新预览', 'conflict')
      busy = true
      const sourceFile = changePath(root, id), targetRoot = dataPath(root, `evolution/experiments/${prepared.target}`)
      const stage = dataPath(root, `evolution/experiments/.identity-${randomUUID()}`)
      let published = false, publishedDigest: string | null = null, changedManifest: string | null = null
      try {
        if (prepared.mode === 'create') {
          mkdirSync(stage)
          for (const path of candidateFiles(latest.source.candidate)) {
            signal?.throwIfAborted()
            const from = dataPath(latest.source.candidate, path), to = dataPath(stage, `candidate/${path}`), bytes = readFileSync(from)
            let content: string | Buffer = bytes
            if (/\.(?:[cm]?js|tsx?|json|ya?ml|md|txt|toml|sh)$/.test(path) && !bytes.includes(0)) content = mapCurrentVariantReferences(bytes.toString('utf8'), id, prepared.target)
            mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, content); chmodSync(to, lstatSync(from).mode & 0o111 ? 0o755 : 0o644)
          }
          const next: MapValue = { ...latest.change, experiment_id: prepared.target, variant_kind: 'exploratory', status: 'active', outcome: 'inconclusive' }
          for (const key of ['current_variant_id', 'creation', 'decision', 'compute_variant_build', 'compute_variant_decision', 'end_confirmed', 'equivalence_evidence_refs', 'resource_evidence_refs']) delete next[key]
          writeFileSync(join(stage, 'change.yaml'), dump(next, { lineWidth: -1, noRefs: true }))
          writeFileSync(join(stage, 'hypothesis.md'), `# ${next.variant_name ?? prepared.target}\n\n研究策略：${next.compute_variant.strategy ?? '按当前计划进行独立比较'}。\n\n固定父版和任务范围见 [change.yaml](change.yaml)。\n`)
          writeFileSync(join(stage, 'decision.md'), '# Decision\n\n状态：inconclusive\n\n当前身份尚未完成独立评测。\n')
          mkdirSync(join(stage, 'evaluation')); writeFileSync(join(stage, 'evaluation/observations.md'), '# Evaluation Observations\n\n尚未执行当前身份的评测。\n')
          if (canonical(snapshot(id, prepared.target)) !== canonical(latest)) fail('复制期间来源发生变化，请重新预览', 'conflict')
          if (existsSync(targetRoot)) fail('VAR 身份已被占用，请重新预览', 'conflict')
          renameSync(stage, targetRoot); published = true
          publishedDigest = treeDigest(targetRoot)
          versionSource(root, prepared.target)
        }
        const currentDigest = candidateDigest(sourceInfo(root, prepared.target).candidate)
        const mappingContent = dump({ ...latest.change, current_variant_id: prepared.target }, { lineWidth: -1, noRefs: true })
        const manifest = latest.manifest === null ? null : load(latest.manifest) as MapValue
        if (manifest?.active_experiment === id) {
          const nextManifest = dump({ ...manifest, active_experiment: prepared.target }, { lineWidth: -1, noRefs: true })
          atomic(latest.manifestPath, latest.manifest!, nextManifest)
          changedManifest = nextManifest
        }
        atomic(sourceFile, latest.content, mappingContent)
        return { ok: true as const, value: { ...view(id, prepared.target, prepared.mode), source_change_sha256: sha256(mappingContent), current_candidate_sha256: currentDigest } }
      } catch (error) {
        let recovered = true
        if (changedManifest && readFileSync(latest.manifestPath, 'utf8') === changedManifest) atomic(latest.manifestPath, changedManifest, latest.manifest!)
        else if (changedManifest) recovered = false
        if (published) {
          if (publishedDigest && treeDigest(targetRoot) === publishedDigest) rmSync(targetRoot, { recursive: true })
          else recovered = false
        }
        if (!recovered) fail(`迁移未完成且目标发生并发修改，请核对 ${prepared.target} 与原 change.yaml`, 'needs_recovery')
        throw error
      } finally { rmSync(stage, { recursive: true, force: true }); busy = false }
    } catch (error) {
      return { ok: false as const, error: { code: error instanceof IdentityError ? error.code : 'identity_migration_failed', message: error instanceof Error ? error.message : '变体身份迁移失败' } }
    }
  }
}
