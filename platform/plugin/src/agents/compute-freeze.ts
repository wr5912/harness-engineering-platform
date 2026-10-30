import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { load } from 'js-yaml'
import { candidateFiles, dataPath, sourceInfo } from '../tasks/files.ts'
import { workspaceConfigPath } from '../workspace.ts'
import { parseEvaluationDocument } from '../evaluation/cases.ts'
import { containsLiteralLlmKey } from '../tasks/llm-key.ts'

type Body = Record<string, any>
type Result = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
class FreezeError extends Error { constructor(readonly code: string, message: string) { super(message) } }
function git(root: string, args: string[], env: Record<string, string> = {}, input?: string | Buffer) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
    cwd: root, env: { ...process.env, ...env }, input: typeof input === 'string' ? Buffer.from(input) : input, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new FreezeError('freeze_failed', '数据 Git 操作失败，请检查仓库、身份与并行修改')
  return result.stdout
}
function headFile(root: string, head: string, path: string): Buffer | null {
  const result = spawnSync('git', ['show', `${head}:${path}`], { cwd: root, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}
function cases(content: string) {
  const headings = [...content.matchAll(/^#### (U-[A-Z0-9-]+)[^\r\n]*\r?$/gm)]
  return new Map(headings.map((item, index) => {
    const start = item.index!, bodyStart = start + item[0].length
    let end = headings[index + 1]?.index ?? content.length
    const nextSection = /^#{1,3} /m.exec(content.slice(bodyStart, end))
    if (nextSection) end = bodyStart + nextSection.index
    return [item[1], { start, end, text: content.slice(start, end) }]
  }))
}
function selectCases(base: string, current: string, selected: string[], catalog: { case_id: string; scene: string }[]) {
  const original = cases(base), changed = cases(current)
  if (selected.some(id => !changed.has(id))) throw new FreezeError('invalid_request', '所选 Case 正文缺失')
  let value = base
  for (const id of selected.filter(id => original.has(id)).sort((a, b) => original.get(b)!.start - original.get(a)!.start)) {
    const entry = original.get(id)!
    value = value.slice(0, entry.start) + changed.get(id)!.text + value.slice(entry.end)
  }
  for (const id of selected.filter(id => !original.has(id))) {
    const block = changed.get(id)!, scene = catalog.find(item => item.case_id === id)?.scene
    if (!scene) throw new FreezeError('invalid_request', '新增 Case 缺少有效的场景合同')
    const targetHeadings = [...value.matchAll(/^## ([^\r\n]+)\r?$/gm)]
    const section = targetHeadings.findIndex(item => item[1].trim() === scene)
    // 权威解析器将首个二级标题前的 Case 归为“未分组”；插入时保持这项语义。
    const position = section >= 0 ? targetHeadings[section + 1]?.index ?? value.length
      : scene === '未分组' ? targetHeadings[0]?.index ?? value.length : value.length
    const heading = section < 0 && scene !== '未分组' ? `## ${scene}\n\n` : ''
    const prefix = value.slice(0, position)
    const separator = prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n'
    value = prefix + separator + heading + block.text.trimEnd() + '\n\n' + value.slice(position)
  }
  return value
}
function canonical(value: any): string {
  const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])])) : item
  return JSON.stringify(normalize(value))
}

/** 临时索引只物化目标投影；真实索引的无关条目与所有工作树内容保持原样。 */
export function createComputeFreezeHandler(assetRoot: string) {
  const root = resolve(assetRoot)
  let busy = false
  async function prepare(body: Body, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const source = sourceInfo(root, body.experiment_id)
    const head = git(root, ['rev-parse', 'HEAD']).toString().trim()
    const branch = git(root, ['symbolic-ref', '--quiet', 'HEAD']).toString().trim()
    if (!branch.startsWith('refs/heads/')) throw new FreezeError('invalid_request', '冻结需要数据仓库当前本地分支')
    const indexFile = resolve(root, git(root, ['rev-parse', '--git-path', 'index']).toString().trim())
    const indexBytes = existsSync(indexFile) ? readFileSync(indexFile) : null
    const base = `evolution/experiments/${source.id}`
    const change = load(readFileSync(dataPath(root, `${base}/change.yaml`), 'utf8')) as Body
    if (change?.experiment_id !== source.id || change.agent_id !== source.agent_id) throw new FreezeError('invalid_request', '冻结目标身份不一致')
    const planHashes = change.compute_variant?.case_hashes
    const selected = body.case_ids ?? (planHashes ? Object.keys(planHashes) : null)
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length
      || selected.some(id => typeof id !== 'string' || !/^U-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(id))
      || planHashes && (selected.some(id => !planHashes[id]) || selected.length !== Object.keys(planHashes).length)) throw new FreezeError('invalid_request', '请明确选择真实 Case；变体 Case 必须完整对应本次确认计划')
    const caseIds = [...selected].sort()
    const entries = new Map<string, { content: Buffer; mode: string }>()
    const researchRoot = dataPath(root, `${base}/evaluation`)
    const researchFiles = existsSync(researchRoot) ? candidateFiles(researchRoot).map(path => `${base}/evaluation/${path}`) : []
    const researchDocuments = ['hypothesis.md', 'decision.md'].map(path => `${base}/${path}`)
    const existingDocuments = researchDocuments.filter(path => existsSync(dataPath(root, path)))
    for (const path of [...candidateFiles(source.candidate).map(path => `${base}/candidate/${path}`), `${base}/change.yaml`, ...existingDocuments, ...researchFiles]) {
      const file = dataPath(root, path)
      const content = readFileSync(file)
      if (containsLiteralLlmKey(path, content.toString('utf8'))) throw new FreezeError('secret_rejected', '冻结对象包含 LLM API Key 常量')
      entries.set(path, { content, mode: lstatSync(file).mode & 0o111 ? '100755' : '100644' })
    }
    const evaluationPath = `agents/${source.agent_id}/evaluation.md`, originalEvaluation = headFile(root, head, evaluationPath)
    if (!originalEvaluation) throw new FreezeError('invalid_request', '评测定义缺少 Git 基准，不能局部冻结')
    const evaluationBase = hash(originalEvaluation)
    if (body.evaluation_base_sha256 && body.evaluation_base_sha256 !== evaluationBase) throw new FreezeError('conflict', '评测 Git 基准已变化，请重新预览')
    const currentEvaluation = readFileSync(dataPath(root, evaluationPath), 'utf8')
    const currentCases = await parseEvaluationDocument(root, currentEvaluation, signal)
    const projectedEvaluation = selectCases(originalEvaluation.toString(), currentEvaluation, caseIds, currentCases.catalog)
    const projectedCases = await parseEvaluationDocument(root, projectedEvaluation, signal)
    for (const id of caseIds) if (!currentCases.cases[id] || planHashes && hash(canonical(currentCases.cases[id])) !== planHashes[id]
      || canonical(currentCases.cases[id]) !== canonical(projectedCases.cases[id])
      || canonical(currentCases.catalog.find(item => item.case_id === id)) !== canonical(projectedCases.catalog.find(item => item.case_id === id))) throw new FreezeError('conflict', '所选 Case 与冻结计划或章节口径不同，请重新确认计划')
    entries.set(evaluationPath, { content: Buffer.from(projectedEvaluation), mode: '100644' })
    // 删除只属于当前 Candidate 的旧文件；运行记录与其他 Experiment 均不进入提交。
    const trackedPaths = new Set(git(root, ['ls-tree', '-r', '-z', '--name-only', head]).toString().split('\0').filter(Boolean))
    const trackedOwned = [...trackedPaths].filter(path => path.startsWith(`${base}/candidate/`) || researchDocuments.includes(path))
    const deleted = trackedOwned.filter(path => !entries.has(path) && !existsSync(dataPath(root, path)))
    const paths = [...entries.keys(), ...deleted].sort()
    const staged = git(root, ['diff', '--cached', '--name-only', '-z', '--', ...paths]).toString().split('\0').filter(Boolean)
    if (staged.length) throw new FreezeError('conflict', '冻结目标已有暂存修改，请先处理这些路径的暂存状态')
    const temp = mkdtempSync(join(tmpdir(), 'compute-freeze-')), tempIndex = join(temp, 'index')
    const env = { GIT_INDEX_FILE: tempIndex }
    try {
      git(root, ['read-tree', head], env)
      const objectDirectory = join(temp, 'objects'); mkdirSync(objectDirectory)
      const projected = [...entries].map(([path, entry], index) => {
        const file = join(objectDirectory, String(index)); writeFileSync(file, entry.content)
        return { path, entry, file }
      })
      // 一次散列固定字节，不读取属性过滤器；再以 NUL 分隔一次更新临时索引。
      const objects = git(root, ['hash-object', '-w', '--no-filters', '--stdin-paths'], {}, projected.map(item => item.file).join('\n') + '\n').toString().trim().split('\n')
      if (objects.length !== projected.length || objects.some(object => !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(object))) throw new FreezeError('freeze_failed', '批量 Git 对象结果不完整')
      const indexRecords = projected.map((item, index) => `${item.entry.mode} ${objects[index]}\t${item.path}\0`)
        .concat(deleted.map(path => `0 ${'0'.repeat(head.length)}\t${path}\0`))
      git(root, ['update-index', '-z', '--index-info'], env, Buffer.from(indexRecords.join('')))
      const tree = git(root, ['write-tree'], env).toString().trim()
      const diff = git(root, ['diff-tree', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--stat', '-p', head, tree, '--', ...paths]).toString()
      const files = paths.map(path => ({ path, operation: entries.has(path) ? trackedPaths.has(path) ? 'update' : 'create' : 'delete', sha256: entries.has(path) ? hash(entries.get(path)!.content) : null }))
      const value = { experiment_id: source.id, branch, head, tree, case_ids: caseIds,
        case_hashes: Object.fromEntries(caseIds.map(id => [id, hash(canonical(currentCases.cases[id]))])),
        evaluation_base_sha256: evaluationBase, files, diff,
        notes: ['仅冻结所列 Candidate、研究计划、本版本 evaluation 研究资料和选定 Case；运行记录与其他版本不进入提交，不推送、不运行 Git hooks。'] }
      const previewHash = hash(JSON.stringify(value))
      return { value: { ...value, preview_sha256: previewHash, freeze_input: { experiment_id: source.id, case_ids: caseIds, evaluation_base_sha256: evaluationBase, expected_preview_sha256: previewHash } }, entries, paths, deleted, temp, tempIndex, indexFile, indexBytes, branch, head, tree }
    } catch (error) { rmSync(temp, { recursive: true, force: true }); throw error }
  }
  return async (method: string, body: Body, signal?: AbortSignal): Promise<Result> => {
    if (!['preview', 'freeze'].includes(method)) return { ok: false, error: { code: 'method_not_found', message: '未知数据冻结操作' } }
    if (method === 'freeze' && busy) return { ok: false, error: { code: 'conflict', message: '数据正在冻结' } }
    if (method === 'freeze') busy = true
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined, lock: number | undefined, ownsLock = false, newCommit: string | undefined, headMoved = false
    try {
      prepared = await prepare(body, signal)
      if (method === 'preview') return { ok: true, value: prepared.value }
      if (!body.evaluation_base_sha256 || !Array.isArray(body.case_ids) || body.expected_preview_sha256 !== prepared.value.preview_sha256) throw new FreezeError('conflict', '请先确认同一份冻结预览、Case 与评测基准')
      signal?.throwIfAborted()
      const lockPath = `${prepared.indexFile}.lock`
      try { lock = openSync(lockPath, 'wx'); ownsLock = true } catch { throw new FreezeError('conflict', '数据 Git 索引正在被其他操作使用') }
      const currentIndex = existsSync(prepared.indexFile) ? readFileSync(prepared.indexFile) : null
      if (hash(currentIndex ?? '') !== hash(prepared.indexBytes ?? '') || git(root, ['rev-parse', 'HEAD']).toString().trim() !== prepared.head || git(root, ['symbolic-ref', 'HEAD']).toString().trim() !== prepared.branch) throw new FreezeError('conflict', '数据 Git HEAD、分支或索引已变化，请重新预览')
      // 真实索引从原快照出发，仅更新本次提交路径，保留其他用户的暂存条目。
      const mergedIndex = join(prepared.temp, 'merged-index')
      if (prepared.indexBytes) writeFileSync(mergedIndex, prepared.indexBytes)
      else git(root, ['read-tree', prepared.head], { GIT_INDEX_FILE: mergedIndex })
      const commitEntries = git(root, ['ls-files', '--stage', '-z', '--', ...prepared.paths], { GIT_INDEX_FILE: prepared.tempIndex })
      git(root, ['update-index', '-z', '--index-info'], { GIT_INDEX_FILE: mergedIndex }, Buffer.concat([commitEntries,
        Buffer.from(prepared.deleted.map(path => `0 ${'0'.repeat(prepared!.head.length)}\t${path}\0`).join(''))]))
      // 建树过程无工作树写入；最后重新核对所有投影，防止预览期间的并行目标修改。
      const refreshed = await prepare(body, signal)
      try { if (refreshed.value.preview_sha256 !== prepared.value.preview_sha256) throw new FreezeError('conflict', '冻结期间目标内容发生变化') }
      finally { rmSync(refreshed.temp, { recursive: true, force: true }) }
      const headTree = git(root, ['rev-parse', `${prepared.head}^{tree}`]).toString().trim()
      if (headTree === prepared.tree) return { ok: true, value: { experiment_id: body.experiment_id, commit: prepared.head, unchanged: true, files: prepared.value.files } }
      newCommit = git(root, ['commit-tree', prepared.tree, '-p', prepared.head], {}, `冻结 ${body.experiment_id} 的算力变体计划与资产\n`).toString().trim()
      git(root, ['update-ref', prepared.branch, newCommit, prepared.head]); headMoved = true
      writeFileSync(lock, readFileSync(mergedIndex))
      closeSync(lock); lock = undefined
      renameSync(lockPath, prepared.indexFile)
      ownsLock = false
      return { ok: true, value: { experiment_id: body.experiment_id, commit: newCommit, parent: prepared.head, files: prepared.value.files, case_ids: prepared.value.case_ids } }
    } catch (error) {
      if (headMoved && prepared && newCommit) {
        try { git(root, ['update-ref', prepared.branch, prepared.head, newCommit]); headMoved = false } catch { /* 其他提交已前进时不回退。 */ }
      }
      return { ok: false, error: { code: signal?.aborted ? 'aborted' : error instanceof FreezeError ? error.code : 'freeze_failed',
        message: signal?.aborted ? '冻结已取消' : error instanceof FreezeError ? error.message : '数据冻结失败，请检查 Git 身份与目标状态' } }
    } finally {
      if (lock !== undefined) closeSync(lock)
      if (prepared) { if (ownsLock) rmSync(`${prepared.indexFile}.lock`, { force: true }); rmSync(prepared.temp, { recursive: true, force: true }) }
      if (method === 'freeze') busy = false
    }
  }
}
