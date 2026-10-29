import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { assetText } from './asset-text.ts'

const execute = promisify(execFile)
const EXPERIMENT = /^EXP-([a-z0-9]+(?:-[a-z0-9]+)*)-\d{3}(?:-r[0-9a-f]{12})?$/
const EXCLUDED = new Set(['node_modules', '.git', '__pycache__', 'RuntimeHOME', 'history', 'sessions', 'cache', 'runs'])
const PREVIEW_BYTES = 128 * 1024
type JsonMap = Record<string, unknown>
type Entry = { path: string; object: string; size: number; mode: string; file?: string }
export type AssetDiffFile = { path: string; status: 'added' | 'removed' | 'modified'; before_size: number | null; after_size: number | null; mode_changed: boolean }
export type AssetDiffView = {
  experiment_id: string
  left: { label: string; source: string; experiment_id?: string; digest: string }
  right: { label: string; source: string; experiment_id: string; digest: string }
  files: AssetDiffFile[]
  summary: { added: number; removed: number; modified: number; unchanged: number }
  selected?: { path: string; kind: 'text' | 'binary'; before: string | null; after: string | null; diff: string; truncated: boolean; redacted?: boolean }
  notes: string[]
}
export type FixedAssetView = {
  agent_id: string; experiment_id: string; ref: string; commit: string; candidate_digest: string
  candidate_digest_basis: 'git-object-path-mode'
  files: Array<Omit<Entry, 'file'>>
  selected?: { path: string; object: string; size: number; kind: 'text' | 'binary' | 'oversize'; content: string | null; truncated: boolean; sha256?: string; redacted?: boolean; content_sha256?: string }
  notes: string[]
}

class DiffError extends Error { constructor(readonly code: string, message: string) { super(message) } }
function fail(message: string): never { throw new DiffError('invalid_request', message) }
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DiffError('aborted', '资产比较已取消') }
function hash(data: string | Buffer) { return createHash('sha256').update(data).digest('hex') }
function excluded(path: string) {
  return path.split('/').some(name => EXCLUDED.has(name) || name === '.env' || name.startsWith('.env.') || name.endsWith('.llm-api-key'))
}
function experimentId(value: unknown): string {
  if (typeof value !== 'string' || !EXPERIMENT.test(value)) fail('experiment_id 格式无效')
  return value
}
function assertNoLinks(root: string, path: string) {
  const rel = relative(root, path)
  if (rel.split(sep).includes('..')) fail('路径必须在仓库内')
  let cursor = root
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) throw new DiffError('path_rejected', '资产比较不读取符号链接')
  }
}
function change(root: string, id: string) {
  const file = join(root, 'evolution/experiments', id, 'change.yaml')
  if (!existsSync(file)) throw new DiffError('not_found', '研究版本不存在')
  assertNoLinks(root, file)
  const value = loadYaml(readFileSync(file, 'utf8')) as JsonMap
  const expectedAgent = EXPERIMENT.exec(id)![1]
  if (!value || value.agent_id !== expectedAgent) fail('研究版本身份不一致')
  return value
}
async function git(root: string, args: string[], signal?: AbortSignal) {
  cancelled(signal)
  try { return (await execute('git', args, { cwd: root, signal, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 20_000 })).stdout }
  catch (error) {
    cancelled(signal)
    if (error instanceof DiffError) throw error
    throw new DiffError('baseline_unavailable', '无法读取固定 Git 来源，请核对提交和父研究版本')
  }
}
function objectId(data: Buffer, algorithm: string) {
  return createHash(algorithm).update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex')
}
function workingFiles(root: string, id: string, algorithm: string, signal?: AbortSignal) {
  const base = join(root, 'evolution/experiments', id, 'candidate')
  if (!existsSync(base)) throw new DiffError('not_found', '研究版本没有 Candidate 资产')
  assertNoLinks(root, base)
  const files: Entry[] = []
  let bytes = 0
  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      cancelled(signal)
      const file = join(directory, name)
      const path = relative(base, file).split(sep).join('/')
      if (excluded(path)) continue
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new DiffError('path_rejected', 'Candidate 含符号链接，无法确定完整比较来源')
      if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) {
        bytes += stat.size
        if (files.length >= 10_000 || bytes > 128 * 1024 * 1024) throw new DiffError('limit_exceeded', 'Candidate 超出本次比较的 10000 文件或 128 MiB 范围')
        files.push({ path, object: objectId(readFileSync(file), algorithm), size: stat.size, mode: stat.mode & 0o111 ? '100755' : '100644', file })
      }
    }
  }
  visit(base)
  return files
}
async function fixedFiles(root: string, commit: string, id: string, signal?: AbortSignal) {
  const prefix = `evolution/experiments/${id}/candidate/`
  const listing = await git(root, ['ls-tree', '-r', '-z', '--long', commit, '--', prefix], signal)
  const files: Entry[] = []
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record)
    if (!match || !match[5].startsWith(prefix)) throw new DiffError('baseline_unavailable', 'Git 资产目录格式无法解析')
    const path = match[5].slice(prefix.length)
    if (excluded(path)) continue
    if (match[1] === '120000' || match[2] !== 'blob') throw new DiffError('path_rejected', '固定来源含符号链接或子模块，不能作为普通资产比较')
    files.push({ path, object: match[3], size: Number(match[4]), mode: match[1] })
  }
  if (!files.length) throw new DiffError('baseline_unavailable', '固定提交中没有指定父研究版本的 Candidate 资产')
  return files
}
function digest(files: Entry[]) {
  const entries = files.map(({ path, object, mode }) => [path, object, mode])
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return hash(JSON.stringify(entries))
}
function decode(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer) } catch { return null }
}
function textPreview(text: string) {
  const view = assetText('source', text), clean = view.content, data = Buffer.from(clean, 'utf8')
  if (data.length <= PREVIEW_BYTES) return { ...view, truncated: false }
  // 流式解码保留末尾未完成字节，截断预览不会引入半个 UTF-8 字符。
  const content = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, PREVIEW_BYTES), { stream: true })
  return { ...view, content, content_sha256: hash(content), truncated: true, editable: false }
}

/** 读取固定提交中的 Candidate，不 checkout、不生成可编辑源码副本。 */
export async function readFixedAsset(rootPath: string, payload: JsonMap, signal?: AbortSignal): Promise<ConnectionRpcResult<FixedAssetView>> {
  try {
    cancelled(signal)
    const root = resolve(rootPath), id = experimentId(payload.experiment_id)
    const agentId = EXPERIMENT.exec(id)![1]
    if (payload.agent_id !== agentId) fail('固定来源的 Experiment 不属于请求的 Agent')
    if (typeof payload.ref !== 'string' || !/^git:[a-f0-9]{40}$/i.test(payload.ref)) fail('ref 必须是 git:<40 位固定提交>')
    if (payload.path !== undefined && (typeof payload.path !== 'string' || payload.path.includes('\\') || payload.path.split('/').some(part => !part || part === '.' || part === '..') || excluded(payload.path))) fail('path 必须是 Candidate 内未被排除的相对文件路径')
    const commit = payload.ref.slice(4).toLowerCase()
    const rawChange = await git(root, ['show', `${commit}:evolution/experiments/${id}/change.yaml`], signal)
    const fixedChange = loadYaml(rawChange.toString('utf8')) as JsonMap
    if (!fixedChange || fixedChange.agent_id !== agentId || fixedChange.experiment_id !== undefined && fixedChange.experiment_id !== id) fail('固定提交的 Agent 或 Experiment 身份不一致')
    const files = await fixedFiles(root, commit, id, signal)
    if (files.length > 10_000) throw new DiffError('limit_exceeded', '固定 Candidate 超出 10000 文件读取范围')
    const value: FixedAssetView = {
      agent_id: agentId, experiment_id: id, ref: `git:${commit}`, commit, candidate_digest: digest(files), files,
      candidate_digest_basis: 'git-object-path-mode',
      notes: ['candidate_digest 汇总固定 Git 文件路径、blob 对象与执行模式；不是运行内容摘要，不能与 detail 或 tasks/capabilities 的 candidate_sha256 比较来判断漂移。装配 expected_candidate_sha256 使用目标 detail/capabilities 返回值；单文件 expected_source_sha256 使用 selected.sha256。', '只读固定提交中的 Candidate；不读取环境凭据、Session、Run、缓存或依赖目录。', '文本预览脱敏且最多 128 KiB；超过 1 MiB 的文件仅返回 Git 对象摘要与大小。预览不构成另一份可编辑来源。'],
    }
    if (payload.path !== undefined) {
      const entry = files.find(item => item.path === payload.path)
      if (!entry) throw new DiffError('not_found', '固定 Candidate 中不存在指定文件')
      const selected = { path: entry.path, object: entry.object, size: entry.size }
      if (entry.size > 1024 * 1024) value.selected = { ...selected, kind: 'oversize', content: null, truncated: true }
      else {
        const data = await git(root, ['cat-file', 'blob', entry.object], signal), text = decode(data)
        value.selected = text === null
          ? { ...selected, kind: 'binary', content: null, truncated: false, sha256: hash(data) }
          : { ...selected, kind: 'text', ...textPreview(text), sha256: hash(data) }
      }
    }
    cancelled(signal)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof DiffError) return { ok: false, error: { code: error.code, message: error.message, details: {} } }
    return { ok: false, error: { code: 'asset_read_failed', message: '固定来源读取失败，请核对来源元数据', details: {} } }
  }
}
async function previewDiff(before: string, after: string, path: string, signal?: AbortSignal) {
  const temporary = mkdtempSync(join(tmpdir(), 'harness-asset-diff-'))
  try {
    const left = join(temporary, 'before'), right = join(temporary, 'after')
    writeFileSync(left, before, { mode: 0o600 }); writeFileSync(right, after, { mode: 0o600 })
    const args = ['--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--unified=3', '--', left, right]
    let output: string
    try { output = (await execute('git', args, { encoding: 'utf8', signal, maxBuffer: 2 * 1024 * 1024 })).stdout }
    catch (error) {
      cancelled(signal)
      const result = error as Error & { code?: number; stdout?: string }
      if (result.code !== 1 || typeof result.stdout !== 'string') throw new DiffError('diff_failed', '文本差异生成失败')
      output = result.stdout
    }
    return output.replaceAll(`a${left}`, `a/${path}`).replaceAll(`b${right}`, `b/${path}`).replaceAll(left, `before/${path}`).replaceAll(right, `after/${path}`)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

/** 只读比较当前 Candidate 与固定 Baseline 或同 Agent 的指定 Candidate。 */
export async function readAssetDiff(rootPath: string, payload: JsonMap, signal?: AbortSignal): Promise<ConnectionRpcResult<AssetDiffView>> {
  try {
    const root = resolve(rootPath), id = experimentId(payload.experiment_id)
    const current = change(root, id), agentId = current.agent_id
    const against = payload.against ?? 'baseline'
    if (typeof against !== 'string') fail('against 必须是 baseline 或研究版本 ID')
    const algorithm = (await git(root, ['rev-parse', '--show-object-format'], signal)).toString().trim()
    if (!['sha1', 'sha256'].includes(algorithm)) throw new DiffError('baseline_unavailable', 'Git 对象摘要格式不受支持')
    const rightFiles = workingFiles(root, id, algorithm, signal)
    let leftFiles: Entry[] = [], leftCommit = '', leftId: string | undefined, leftSource = '', leftLabel = ''
    if (against !== 'baseline') {
      leftId = experimentId(against)
      if (change(root, leftId).agent_id !== agentId) fail('只能比较同一智能体的研究版本')
      leftFiles = workingFiles(root, leftId, algorithm, signal)
      leftSource = `experiment:${leftId}`; leftLabel = `${leftId}（工作树）`
    } else if (current.baseline_ref === 'none:first-experiment') {
      leftSource = 'none:first-experiment'; leftLabel = '首个研究版本（空来源）'
    } else {
      if (typeof current.baseline_ref !== 'string' || !/^git:[a-f0-9]{40}$/i.test(current.baseline_ref)) {
        throw new DiffError('baseline_unavailable', '当前 Baseline 尚不支持读取；请选择同一智能体的具体研究版本比较')
      }
      leftCommit = current.baseline_ref.slice(4)
      const requested = payload.baseline_experiment_id ?? current.parent_experiment_id
      leftId = requested ? experimentId(requested) : id
      if (EXPERIMENT.exec(leftId)![1] !== agentId) fail('Baseline 研究版本不属于当前智能体')
      const rawChange = await git(root, ['show', `${leftCommit}:evolution/experiments/${leftId}/change.yaml`], signal)
      const fixedChange = loadYaml(rawChange.toString()) as JsonMap
      if (!fixedChange || fixedChange.agent_id !== agentId) fail('固定 Baseline 的 Agent 身份不一致')
      leftFiles = await fixedFiles(root, leftCommit, leftId, signal)
      leftSource = `git:${leftCommit}`; leftLabel = `${leftId} @ ${leftCommit.slice(0, 12)}`
    }
    const leftMap = new Map(leftFiles.map(item => [item.path, item])), rightMap = new Map(rightFiles.map(item => [item.path, item]))
    const files: AssetDiffFile[] = [], summary = { added: 0, removed: 0, modified: 0, unchanged: 0 }
    for (const path of [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort()) {
      const before = leftMap.get(path), after = rightMap.get(path)
      if (before?.object === after?.object && before?.mode === after?.mode) { summary.unchanged++; continue }
      const status = !before ? 'added' : !after ? 'removed' : 'modified'
      summary[status]++
      files.push({ path, status, before_size: before?.size ?? null, after_size: after?.size ?? null, mode_changed: !!before && !!after && before.mode !== after.mode })
    }
    const value: AssetDiffView = {
      experiment_id: id,
      left: { label: leftLabel, source: leftSource, ...(leftId ? { experiment_id: leftId } : {}), digest: digest(leftFiles) },
      right: { label: `${id}（工作树）`, source: `experiment:${id}`, experiment_id: id, digest: digest(rightFiles) },
      files, summary,
      notes: ['比较仅包含 Candidate；不包含 Run、Session、缓存、依赖目录和 .env/LLM 凭据文件。', '工作树版本可能包含未提交修改；内容摘要对应本次读取，比较不会修改或切换运行实例。'],
    }
    if (payload.path !== undefined) {
      if (typeof payload.path !== 'string' || !files.some(item => item.path === payload.path)) fail('path 必须来自本次差异文件列表')
      const path = payload.path, before = leftMap.get(path), after = rightMap.get(path)
      const read = async (entry?: Entry) => {
        if (!entry) return Buffer.alloc(0)
        if (!entry.file) return await git(root, ['cat-file', 'blob', entry.object], signal)
        assertNoLinks(root, entry.file)
        return readFileSync(entry.file)
      }
      // 文件列表已保存摘要；预览前再次核对，避免把新内容显示为上一次摘要。
      const beforeData = await read(before), afterData = await read(after)
      if ((before && objectId(beforeData, algorithm) !== before.object) || (after && objectId(afterData, algorithm) !== after.object)) throw new DiffError('conflict', '比较期间资产发生变化，请重新比较')
      const beforeText = decode(beforeData), afterText = decode(afterData)
      if (beforeText === null || afterText === null) value.selected = { path, kind: 'binary', before: null, after: null, diff: '二进制文件仅比较内容摘要和大小。', truncated: false }
      else {
        const beforePreview = textPreview(beforeText), afterPreview = textPreview(afterText)
        value.selected = { path, kind: 'text', before: beforePreview.content, after: afterPreview.content,
          diff: await previewDiff(beforePreview.content, afterPreview.content, path, signal), truncated: beforePreview.truncated || afterPreview.truncated, redacted: beforePreview.redacted || afterPreview.redacted }
      }
    }
    cancelled(signal)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof DiffError) return { ok: false, error: { code: error.code, message: error.message, details: {} } }
    return { ok: false, error: { code: 'asset_diff_failed', message: '资产比较失败，请核对来源文件是否完整', details: {} } }
  }
}
