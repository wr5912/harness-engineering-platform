import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { load as yaml } from 'js-yaml'
import { assertAssetPath, atomicWrite, candidateFiles, candidateDigest, dataPath, readGitCandidate, sha256 } from '../tasks/files.ts'
import { AssetOperationError } from '../tasks/asset-error.ts'
import { versionIdentity } from './version-source.ts'
import { VERSION_027_MAPPING } from './version-migration.ts'
import { containsLiteralLlmKey } from '../tasks/llm-key.ts'

type File = { content: Buffer; mode: number }
type Identity = { sha256: string; mode: number } | null
type Row = { path: string; kind: string; base: Identity; source: Identity; target: Identity; result: Identity; resolved: boolean; reason: string; renamed_from?: string; renamed_to?: string }
type Request = { agent_id: string; parent_experiment_id: string; parent_ref: string; target_experiment_id: string; [key: string]: any }
type Operation = { operation_id: string; request: Request; plan: any; snapshot: string; plan_sha256: string; state: string; rows: Row[]; base: any; candidate_sha256: string; receipt?: any; journal?: Row[]; journal_sha256?: string }
const identity = (file?: File): Identity => file ? { sha256: sha256(file.content), mode: file.mode } : null
const equal = (a: Identity, b: Identity) => a?.sha256 === b?.sha256 && a?.mode === b?.mode
const candidate = (root: string, id: string) => dataPath(root, `evolution/experiments/${id}/candidate`)
function fail(message: string, details: Record<string, any> = {}): never { throw new AssetOperationError('fusion_conflict', message, { next_action: 'fusion/status', ...details }) }

function working(root: string, id: string) {
  const dir = candidate(root, id), files = new Map<string, File>()
  let size = 0
  for (const path of candidateFiles(dir)) {
    const file = dataPath(dir, path), content = readFileSync(file)
    assertAssetPath(path, content)
    size += content.length
    if (files.size >= 10_000 || size > 100 * 1024 * 1024) fail('融合资产超出批次大小限制')
    files.set(path, { content, mode: lstatSync(file).mode & 0o111 ? 0o755 : 0o644 })
  }
  return files
}

function fixed(root: string, id: string, ref: string) {
  const files = readGitCandidate(root, id, ref)
  if (!files) fail('固定 Candidate 不可读取，或包含不支持的文件类型', { experiment_id: id, ref })
  for (const [path, file] of files) {
    assertAssetPath(path, file.content)
    dataPath(root, path)
    if (path.split('/').some(part => part.startsWith('.env.'))) fail('环境凭据不能进入融合草稿', { path })
  }
  return files
}

/** 仅沿明确的派生引用寻找相同资产身份；工作树 HEAD 不能代替实际目标。 */
function ancestors(root: string, id: string, ref?: string) {
  const nodes: { id: string; ref?: string }[] = [], seen = new Set<string>()
  while (nodes.length < 64 && !seen.has(`${id}@${ref}`)) {
    seen.add(`${id}@${ref}`)
    nodes.push({ id, ref })
    let change: any
    try {
      if (ref) {
        const read = spawnSync('git', ['show', `${ref.slice(4)}:evolution/experiments/${id}/change.yaml`], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
        if (read.status !== 0) break
        change = yaml(read.stdout)
      } else change = versionIdentity(root, id)
    } catch { break }
    if (!change || !/^EXP-[a-z0-9-]+-\d+(?:-[mf])?(?:-r[0-9a-f]{12})?$/.test(change.parent_experiment_id) || !/^git:[0-9a-f]{40}$/.test(change.parent_ref)) break
    id = change.parent_experiment_id
    ref = change.parent_ref
  }
  return nodes
}

function commonBase(root: string, request: Request) {
  const left = ancestors(root, request.parent_experiment_id, request.parent_ref)
  const right = ancestors(root, request.target_experiment_id)
  const currentId = (id: string) => VERSION_027_MAPPING.find(item => item.from === id)?.to ?? id
  for (const a of left) for (const b of right) {
    if (currentId(a.id) !== currentId(b.id) || !a.ref) continue
    let ref = a.ref
    if (b.ref && a.ref !== b.ref) {
      const merged = spawnSync('git', ['merge-base', a.ref.slice(4), b.ref.slice(4)], { cwd: root, encoding: 'utf8' })
      if (merged.status !== 0) continue
      ref = `git:${merged.stdout.trim()}`
    }
    try {
      const files = fixed(root, a.id, ref)
      // 拒绝跨 Agent 或已丢失身份的祖先树。
      const change = spawnSync('git', ['show', `${ref.slice(4)}:evolution/experiments/${a.id}/change.yaml`], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
      if (change.status === 0 && (yaml(change.stdout) as any)?.agent_id === request.agent_id) return { identity: { experiment_id: a.id, ref, verified: true }, files }
    } catch { /* 无法证明的祖先不用于自动合并。 */ }
  }
  return { identity: { verified: false, reason: '未找到可核验的共同派生来源，所有不同文件需要明确取舍。' }, files: new Map<string, File>() }
}

function text(file?: File) {
  if (!file || file.content.includes(0) || file.content.length > 1024 * 1024) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(file.content); return true } catch { return false }
}

function threeWay(root: string, request: Request) {
  const source = fixed(root, request.parent_experiment_id, request.parent_ref), target = working(root, request.target_experiment_id)
  const base = commonBase(root, request), rows: Row[] = [], results = new Map<string, File>()
  const temporary = mkdtempSync(join(tmpdir(), 'harness-fusion-'))
  try {
    const paths = [...new Set([...base.files.keys(), ...source.keys(), ...target.keys()])].sort()
    for (const path of paths) {
      const a = base.files.get(path), s = source.get(path), t = target.get(path)
      const ai = identity(a), si = identity(s), ti = identity(t)
      let kind = 'conflict', result = t, resolved = false
      if (equal(si, ti)) { kind = 'same'; resolved = true }
      else if (base.identity.verified && equal(ai, si)) { kind = 'target-only'; resolved = true }
      else if (base.identity.verified && equal(ai, ti)) { kind = 'source-only'; result = s; resolved = true }
      else if (base.identity.verified && a && s && t && text(a) && text(s) && text(t)) {
        const mode = s.mode === t.mode ? s.mode : a.mode === s.mode ? t.mode : a.mode === t.mode ? s.mode : null
        if (mode !== null) {
          for (const [name, file] of [['base', a], ['source', s], ['target', t]] as const) atomicWrite(join(temporary, name), file.content)
          const merged = spawnSync('git', ['merge-file', '-p', '--diff3', join(temporary, 'target'), join(temporary, 'base'), join(temporary, 'source')], { maxBuffer: 4 * 1024 * 1024 })
          if (merged.status === 0) { kind = 'auto-merged'; result = { content: merged.stdout, mode }; resolved = true }
        }
      }
      if (!resolved && (!s || !t)) kind = 'delete-or-add-conflict'
      else if (!resolved && (!text(s) || !text(t))) kind = 'binary-conflict'
      // 文件与目录互换也必须明确解决，不把路径前缀当作普通新增。
      if (paths.some(other => other !== path && (other.startsWith(path + '/') || path.startsWith(other + '/')))) { kind = 'type-conflict'; resolved = false; result = t }
      rows.push({ path, kind, base: ai, source: si, target: ti, result: identity(result), resolved, reason: resolved ? kind : '' })
      if (result) results.set(path, result)
    }
    for (const added of rows.filter(row => !row.base && row.source)) {
      const removed = rows.filter(row => row.base && !row.source && equal(row.base, added.source))
      if (removed.length !== 1) continue
      const old = removed[0]!
      added.renamed_from = old.path; old.renamed_to = added.path
      if (!equal(old.base, old.target) || added.target) for (const row of [old, added]) {
        row.kind = 'rename-conflict'; row.resolved = false; row.reason = ''; row.result = row.target
        const file = target.get(row.path)
        if (file) results.set(row.path, file); else results.delete(row.path)
      }
    }
    return { source, target, base, rows, results }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

export function fusionDifference(root: string, request: Request) {
  const { rows, base } = threeWay(root, request)
  return { base: base.identity, files: rows, counts: Object.fromEntries([...new Set(rows.map(row => row.kind))].map(kind => [kind, rows.filter(row => row.kind === kind).length])), target_is_worktree: true }
}

function directory(root: string, id: string) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) fail('operation_id 无效')
  return dataPath(root, `.local/fusion/operations/${id}`)
}
function manifest(root: string, op: Operation) { return dataPath(directory(root, op.operation_id), 'operation.json') }
function digest(op: Operation) { return sha256(JSON.stringify({ request: op.request, plan: op.plan, snapshot: op.snapshot, rows: op.rows, base: op.base, candidate_sha256: op.candidate_sha256 })) }
function save(root: string, op: Operation) { atomicWrite(manifest(root, op), JSON.stringify(op, null, 2) + '\n') }
export function readFusionOperation(root: string, id: string): Operation {
  const op = JSON.parse(readFileSync(dataPath(directory(root, id), 'operation.json'), 'utf8')) as Operation
  if (op.operation_id !== id || op.plan_sha256 !== digest(op)) fail('融合草稿身份或摘要不一致')
  if (op.journal && op.journal_sha256 !== sha256(JSON.stringify(op.journal))) fail('写前记录摘要不一致，不能自动恢复')
  return op
}

export function prepareFusion(root: string, request: Request, plan: any, snapshot: string) {
  const diff = threeWay(root, request), id = randomUUID()
  const op: Operation = { operation_id: id, request, plan, snapshot, plan_sha256: '', state: 'prepared', rows: diff.rows, base: diff.base.identity, candidate_sha256: candidateDigest(candidate(root, request.target_experiment_id)) }
  const dir = directory(root, id)
  // 相同文件不导出，避免把无关资产、凭据或 Runtime 状态带入对比包。
  for (const row of op.rows.filter(row => row.kind !== 'same')) {
    for (const [name, files] of [['base', diff.base.files], ['source', diff.source], ['target', diff.target], ['result', diff.results]] as const) {
      const file = files.get(row.path)
      if (file) {
        if (containsLiteralLlmKey(row.path, file.content.toString('utf8'))) throw new AssetOperationError('secret_rejected', '融合快照包含 LLM API Key 常量', { path: row.path })
        atomicWrite(dataPath(dir, `${name}/${row.path}`), file.content, file.mode)
      }
    }
  }
  op.plan_sha256 = digest(op)
  save(root, op)
  atomicWrite(dataPath(dir, 'README.md'), '# 融合对比草稿\n\noperation.json 是路径、来源、执行位与摘要映射。base/source/target 是固定快照，result 是唯一可编辑输出。缺文件表示该侧不存在。可用 Beyond Compare 打开这四个目录；不需要安装该软件即可完成 Git 自动合并。\n\n修改 result 后须通过 fusion/resolve 提交同一 operation_id、expected_plan_sha256 与 expected_result_sha256；直接编辑草稿不会写入 Candidate。不要修改其他快照或 operation.json。删除通过 decision=delete 明确提交。\n')
  return fusionOperationStatus(root, id)
}

function readSide(root: string, op: Operation, row: Row, side: 'base' | 'source' | 'target' | 'result'): File | undefined {
  const expected = row[side]
  if (!expected) return undefined
  const file = dataPath(directory(root, op.operation_id), `${side}/${row.path}`)
  const actual = readFile(file)
  if (!equal(identity(actual), expected)) fail('草稿快照或输出已变化', { path: row.path, side, expected_sha256: expected.sha256, actual_sha256: actual ? sha256(actual.content) : null, next_action: side === 'result' ? 'fusion/resolve' : 'fusion/prepare' })
  return actual
}
function readFile(file: string): File | undefined {
  if (!existsSync(file)) return undefined
  if (lstatSync(file).isDirectory()) return undefined
  if (!lstatSync(file).isFile()) fail('融合路径不是普通文件')
  return { content: readFileSync(file), mode: lstatSync(file).mode & 0o111 ? 0o755 : 0o644 }
}

export function resolveFusion(root: string, body: any) {
  const op = readFusionOperation(root, body.operation_id)
  if (op.state !== 'prepared' || body.expected_plan_sha256 !== op.plan_sha256) fail('草稿已应用或方案摘要已变化')
  if (!Array.isArray(body.resolutions) || !body.resolutions.length) fail('需要提供 resolutions')
  const seen = new Set<string>()
  // 全批核对后写草稿；只接受映射内路径，不接受任意文件导入。
  const edits: { row: Row; file: File | undefined; reason: string }[] = body.resolutions.map((resolution: any) => {
    const row = op.rows.find(row => row.path === resolution.path && row.kind !== 'same')
    if (!row || seen.has(row.path)) fail('解决项路径不在本次差异中或重复', { path: resolution.path })
    seen.add(row.path)
    if (typeof resolution.reason !== 'string' || !resolution.reason.trim()) fail('文件取舍需要说明 reason', { path: row.path })
    let file: File | undefined
    if (resolution.decision === 'source' || resolution.decision === 'target') file = readSide(root, op, row, resolution.decision)
    else if (resolution.decision === 'delete') file = undefined
    else if (resolution.decision === 'content' && typeof resolution.content === 'string') file = { content: Buffer.from(resolution.content), mode: row.target?.mode ?? row.source?.mode ?? 0o644 }
    else if (resolution.decision === 'result') {
      file = readFile(dataPath(directory(root, op.operation_id), `result/${row.path}`))
      if (!file || sha256(file.content) !== resolution.expected_result_sha256) fail('导入输出摘要不一致', { path: row.path })
    } else fail('未知的文件解决方式', { path: row.path })
    if (resolution.mode !== undefined) {
      if (![0o644, 0o755].includes(resolution.mode) || !file) fail('执行位必须为 644 或 755，且文件存在')
      file = { ...file, mode: resolution.mode }
    }
    if (file && containsLiteralLlmKey(row.path, file.content.toString('utf8'))) throw new AssetOperationError('secret_rejected', '融合输出包含 LLM API Key 常量', { path: row.path })
    return { row, file, reason: resolution.reason }
  })
  const finalPaths = op.rows.filter(row => edits.some(edit => edit.row === row) ? edits.find(edit => edit.row === row)!.file : row.result).map(row => row.path)
  if (finalPaths.some(path => finalPaths.some(other => other.startsWith(path + '/')))) fail('解决项仍存在文件与目录冲突，请同时明确删除旧路径')
  for (const { row, file, reason } of [...edits].sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)))) {
    const path = dataPath(directory(root, op.operation_id), `result/${row.path}`)
    if (file) { atomicWrite(path, file.content, file.mode) } else if (existsSync(path) && lstatSync(path).isFile()) removeFile(path, dataPath(directory(root, op.operation_id), 'result'))
    row.result = identity(file); row.resolved = true; row.reason = reason
  }
  op.plan_sha256 = digest(op)
  save(root, op)
  return fusionOperationStatus(root, op.operation_id)
}

function journalState(root: string, op: Operation) {
  return (op.journal ?? []).map(row => {
    const actual = identity(readFile(dataPath(root, row.path)))
    return { path: row.path, state: equal(actual, row.result) ? 'applied' : equal(actual, row.target) ? 'untouched' : 'changed' }
  })
}

function resultMatches(root: string, op: Operation) {
  const actual = working(root, op.request.target_experiment_id)
  return actual.size === op.rows.filter(row => row.result).length && op.rows.every(row => equal(identity(actual.get(row.path)), row.result))
}

function removeFile(file: string, boundary: string) {
  rmSync(file)
  for (let dir = dirname(file); dir !== boundary && dir.startsWith(boundary + '/'); dir = dirname(dir)) {
    if (readdirSync(dir).length) break
    rmdirSync(dir)
  }
}
export function fusionOperationStatus(root: string, id: string) {
  const op = readFusionOperation(root, id), states = journalState(root, op)
  return { operation_id: id, experiment_id: op.request.target_experiment_id, state: op.state, plan_sha256: op.plan_sha256, base: op.base,
    bundle_path: directory(root, id), candidate_sha256: candidateDigest(candidate(root, op.request.target_experiment_id)),
    conflicts: op.rows.filter(row => !row.resolved), files: op.rows.filter(row => row.kind !== 'same'), journal: states,
    recovery_state: !states.length ? 'not-started' : states.every(row => row.state === 'untouched') ? 'untouched' : states.every(row => row.state === 'applied') ? 'applied' : 'mixed',
    receipt: op.receipt ?? null, next_action: op.state === 'applying' ? 'fusion/recover' : op.state === 'rolled-back' ? 'fusion/prepare' : op.rows.some(row => !row.resolved) ? 'fusion/resolve' : op.state === 'applied' ? 'fusion/verify' : 'fusion/confirm' }
}

export async function confirmFusion(root: string, body: any, check: (op: Operation, drafts: { rel: string; content: Buffer | null }[]) => Promise<string>) {
  const op = readFusionOperation(root, body.operation_id)
  if (body.expected_plan_sha256 !== op.plan_sha256 || body.confirmed !== true) fail('确认需要当前方案摘要和 confirmed=true')
  if (op.state === 'applied') return op.receipt
  if (op.state !== 'prepared') fail('操作曾中断，请先查询并恢复', { next_action: 'fusion/recover' })
  if (op.rows.some(row => !row.resolved)) fail('还有未解决的文件冲突', { next_action: 'fusion/resolve' })
  const prefix = `evolution/experiments/${op.request.target_experiment_id}/candidate/`
  const files = op.rows.filter(row => row.kind !== 'same').map(row => ({ row, file: readSide(root, op, row, 'result') }))
  for (const { row, file } of files) if (file && containsLiteralLlmKey(row.path, file.content.toString('utf8'))) throw new AssetOperationError('secret_rejected', '融合输出包含 LLM API Key 常量', { path: row.path })
  // 提交前验证最终路径集合，避免文件/目录冲突造成半批写入。
  const finalPaths = op.rows.filter(row => row.result).map(row => row.path)
  if (finalPaths.some(path => finalPaths.some(other => other.startsWith(path + '/')))) fail('最终输出仍存在文件与目录冲突')
  const drafts = files.map(({ row, file }) => ({ rel: prefix + row.path, content: file?.content ?? null }))
  const change = await check(op, drafts)
  if (candidateDigest(candidate(root, op.request.target_experiment_id)) !== op.candidate_sha256) fail('目标 Candidate 已变化，请保留草稿并重新预览', { next_action: 'fusion/prepare' })
  if (readFusionOperation(root, op.operation_id).plan_sha256 !== op.plan_sha256) fail('验证期间方案已变化')
  for (const { row } of files) readSide(root, op, row, 'result')
  const changePath = `evolution/experiments/${op.request.target_experiment_id}/change.yaml`, previous = readFile(dataPath(root, changePath))!
  op.journal = files.filter(({ row }) => !equal(row.target, row.result)).map(({ row }) => ({ ...row, path: prefix + row.path }))
  op.journal.push({ path: changePath, kind: 'metadata', target: identity(previous), result: identity({ content: Buffer.from(change), mode: previous.mode }), base: null, source: null, resolved: true, reason: 'fusion creation receipt' })
  op.journal_sha256 = sha256(JSON.stringify(op.journal))
  if (op.journal.length === 1) fail('融合没有实际资产变更')
  for (const row of op.journal) {
    const before = readFile(dataPath(root, row.path))
    if (!equal(identity(before), row.target)) fail('写入前目标摘要或执行位变化', { path: row.path })
    if (before) atomicWrite(dataPath(directory(root, op.operation_id), `before/${row.path}`), before.content)
  }
  atomicWrite(dataPath(directory(root, op.operation_id), 'metadata-result.yaml'), change)
  op.state = 'applying'; save(root, op)
  try {
    // 先删除旧路径，支持显式批准的文件/目录互换；不递归删除用户目录。
    const ordered = [...op.journal].sort((a, b) => Number(Boolean(a.result)) - Number(Boolean(b.result)))
    for (const row of ordered) {
      const to = dataPath(root, row.path)
      if (!equal(identity(readFile(to)), row.target)) fail('写入期间目标已变化', { path: row.path })
      if (!row.result) removeFile(to, candidate(root, op.request.target_experiment_id))
      else {
        const content = row.kind === 'metadata' ? Buffer.from(change) : readSide(root, op, op.rows.find(item => prefix + item.path === row.path)!, 'result')!.content
        atomicWrite(to, content, row.result.mode)
      }
    }
    if (!resultMatches(root, op)) fail('写入后的完整 Candidate 与预期输出不一致')
    op.receipt = { operation_id: op.operation_id, experiment_id: op.request.target_experiment_id, mainline_id: op.request.target_experiment_id, candidate_sha256: candidateDigest(candidate(root, op.request.target_experiment_id)), creation_status: 'integrating' }
    op.state = 'applied'; save(root, op)
    return op.receipt
  } catch (error) {
    // 正常失败也走同一恢复口径，绝不覆盖并行改动。
    rollback(root, op)
    throw error
  }
}

function rollback(root: string, op: Operation) {
  let changed = false
  const ordered = [...(op.journal ?? [])].sort((a, b) => Number(Boolean(a.target)) - Number(Boolean(b.target)) || b.path.localeCompare(a.path))
  for (const row of ordered) {
    const to = dataPath(root, row.path), actual = identity(readFile(to))
    if (equal(actual, row.target)) continue
    if (!equal(actual, row.result)) { changed = true; continue }
    if (!row.target) removeFile(to, candidate(root, op.request.target_experiment_id))
    else {
      const before = readFileSync(dataPath(directory(root, op.operation_id), `before/${row.path}`))
      if (sha256(before) !== row.target.sha256) { changed = true; continue }
      atomicWrite(to, before, row.target.mode)
    }
  }
  op.state = changed ? 'applying' : 'rolled-back'; save(root, op)
}

export function recoverFusion(root: string, body: any) {
  const op = readFusionOperation(root, body.operation_id)
  if (body.expected_plan_sha256 !== op.plan_sha256 || body.confirmed !== true) fail('恢复需要当前摘要和 confirmed=true')
  if (!['applying', 'applied', 'rolled-back'].includes(op.state) || !op.journal) fail('该操作尚无可恢复的写入记录')
  const states = journalState(root, op)
  if (states.some(row => row.state === 'changed')) fail('存在并行修改，不能自动恢复', { paths: states.filter(row => row.state === 'changed').map(row => row.path) })
  if (body.recovery === 'rollback') rollback(root, op)
  else if (body.recovery === 'complete' && states.every(row => row.state === 'applied') && resultMatches(root, op)) {
    op.state = 'applied'
    op.receipt = { operation_id: op.operation_id, experiment_id: op.request.target_experiment_id, mainline_id: op.request.target_experiment_id, candidate_sha256: candidateDigest(candidate(root, op.request.target_experiment_id)), creation_status: 'integrating' }
    save(root, op)
  } else fail('只有全部预期写入及元数据一致时才能补记完成；否则选择 rollback')
  return fusionOperationStatus(root, op.operation_id)
}
