import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { load as yaml } from 'js-yaml'
import { assertAssetPath, candidateDigest, dataPath, sha256, sourceInfo } from './files.ts'
import { versionSource } from '../agents/version-source.ts'
import { containsLiteralLlmKey } from './llm-key.ts'

export interface TaskAssemblyInput {
  target_source: string
  expected_candidate_sha256: string
  files: { source: string; path: string; target_path?: string; expected_source_sha256: string; expected_target_sha256: string | null }[]
  configuration_edits?: { path: string; content: string; expected_target_sha256: string | null }[]
}

function prepare(root: string, input: TaskAssemblyInput) {
  const identity = sourceInfo(root, input.target_source)
  const target = { ...identity, entry: versionSource(root, identity.id) }
  if (candidateDigest(target.candidate) !== input.expected_candidate_sha256) throw new Error('目标 Candidate 已变化，请重新预览')
  if (!Array.isArray(input.files) || !input.files.length) throw new Error('请选择需要复用的资产文件')
  const seen = new Set<string>()
  const files = input.files.map(item => {
    const source = sourceInfo(root, item.source)
    const targetPath = item.target_path ?? item.path
    assertAssetPath(item.path); assertAssetPath(targetPath)
    const from = dataPath(source.candidate, item.path), to = dataPath(target.candidate, targetPath)
    if (seen.has(to)) throw new Error('装配目标路径重复')
    seen.add(to)
    if (!lstatSync(from).isFile() || lstatSync(from).size > 1024 * 1024) throw new Error('仅支持不超过 1 MiB 的普通资产文件')
    const content = readFileSync(from)
    if (sha256(content) !== item.expected_source_sha256) throw new Error('复用来源已变化，请重新选择')
    if (containsLiteralLlmKey(item.path, content.toString('utf8'))) throw new Error('资产包含 LLM API Key 常量，不能装配')
    const before = existsSync(to) ? readFileSync(to) : null
    if ((before === null ? null : sha256(before)) !== item.expected_target_sha256) throw new Error('装配目标已变化，请重新预览')
    return { from, to, path: targetPath, content, before, mode: lstatSync(from).mode & 0o111 ? 0o755 : 0o644,
      previousMode: before ? lstatSync(to).mode & 0o777 : null, source: source.source, source_path: item.path,
      sha256: sha256(content), operation: before === null ? 'create' : 'replace' }
  })
  for (const edit of input.configuration_edits ?? []) {
    assertAssetPath(edit.path)
    const to = dataPath(target.candidate, edit.path)
    if (seen.has(to)) throw new Error('装配目标路径重复')
    seen.add(to)
    if (typeof edit.content !== 'string' || Buffer.byteLength(edit.content) > 1024 * 1024) throw new Error('配置编辑内容无效或过大')
    if (containsLiteralLlmKey(edit.path, edit.content)) throw new Error('配置不能包含 LLM API Key 常量')
    const before = existsSync(to) ? readFileSync(to) : null
    if ((before === null ? null : sha256(before)) !== edit.expected_target_sha256) throw new Error('装配配置已变化，请重新预览')
    if (/\.ya?ml$/.test(edit.path)) yaml(edit.content)
    if (/\.json$/.test(edit.path)) JSON.parse(edit.content)
    files.push({ from: '', to, path: edit.path, content: Buffer.from(edit.content), before,
      mode: before && lstatSync(to).mode & 0o111 ? 0o755 : 0o644,
      previousMode: before ? lstatSync(to).mode & 0o777 : null, source: target.source, source_path: edit.path,
      sha256: sha256(edit.content), operation: before === null ? 'create' : 'replace' })
  }
  // 用整批草稿检查目标配置的实际文件引用；只声明目录存在不算运行验证。
  const read = (path: string) => files.find(file => file.path === path)?.content.toString('utf8')
    ?? readFileSync(dataPath(target.candidate, path), 'utf8')
  const references = new Set<string>()
  function inspect(value: unknown): void {
    if (typeof value === 'string') {
      for (const [container, relative] of [['/opt/dsh-presets/', 'dsh/presets/'], ['/opt/dsh-managed/', 'dsh/managed/'], ['/work/harness/workspace/', 'dsh/workspace/']]) {
        if (!value.startsWith(container) || value.includes('${')) continue
        const path = relative + value.slice(container.length)
        const file = dataPath(target.candidate, path)
        if (!files.some(item => item.path === path) && !existsSync(file)) throw new Error('目标配置引用了不存在的资产：' + path)
        references.add(path)
      }
    } else if (Array.isArray(value)) value.forEach(inspect)
    else if (value && typeof value === 'object') Object.values(value).forEach(inspect)
  }
  inspect(yaml(read('dsh/managed/' + target.entry.patch)))
  inspect(yaml(read('dsh/presets/' + target.entry.preset)))
  return { target, files, references: [...references] }
}

export async function previewTaskAssembly(root: string, input: TaskAssemblyInput) {
  const { target, files, references } = prepare(root, input)
  return { experiment_id: target.id, source: target.source, candidate_sha256: candidateDigest(target.candidate),
    files: files.map(({ path, source, source_path, sha256, operation }) => ({ path, source, source_path, sha256, operation })),
    bindings: { status: 'declared', referenced_assets: references, runtime_verified: false },
    note: '选定资产和配置引用已核对；实际 Plugin 依赖、MCP 可达性和装载仍须通过新 Session 验证。' }
}

/** 不执行所复用文件。先验证整批摘要，再替换；失败恢复本次写入。 */
export async function applyTaskAssembly(root: string, input: TaskAssemblyInput) {
  const { target, files, references } = prepare(root, input)
  const written: typeof files = []
  try {
    for (const file of files) {
      mkdirSync(dirname(file.to), { recursive: true })
      const temporary = `${file.to}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, file.content, { flag: 'wx', mode: file.mode })
        const current = existsSync(file.to) ? sha256(readFileSync(file.to)) : null
        if (current !== (file.before === null ? null : sha256(file.before))) throw new Error('装配期间目标已被修改，请重新预览')
        renameSync(temporary, file.to)
        written.push(file)
        chmodSync(file.to, file.mode)
      } finally { rmSync(temporary, { force: true }) }
    }
  } catch (error) {
    for (const file of written.reverse()) {
      if (file.before === null) rmSync(file.to)
      else { writeFileSync(file.to, file.before); chmodSync(file.to, file.previousMode!) }
    }
    throw error
  }
  return { experiment_id: target.id, source: target.source, candidate_sha256: candidateDigest(target.candidate),
    files: files.map(({ path, source, source_path, sha256 }) => ({ path, source, source_path, sha256 })),
    bindings: { status: 'declared', referenced_assets: references, runtime_verified: false, preset: target.entry.preset, patch: target.entry.patch,
      required_env_names: target.entry.required_env_names ?? [] },
    next_step: '在目标 Preset/Plugin 配置中绑定所选资产；工具通过 MCP 配置管理接入，再用新 Session 和业务评测核验。' }
}

/** 仅供已授权任务回退调用；固定清单来自 assets/read-fixed，不新增可调用的工具。 */
export function rollbackTaskAssets(root: string, source: string, files: { path: string; expected_sha256: string; original?: { object: string; mode: string } }[], signal?: AbortSignal) {
  const target = sourceInfo(root, source)
  const seen = new Set<string>()
  const prepared = files.map(file => {
    signal?.throwIfAborted()
    assertAssetPath(file.path)
    const to = dataPath(target.candidate, file.path)
    if (seen.has(to) || !/^[a-f0-9]{64}$/.test(file.expected_sha256)) throw new Error('回退文件路径或摘要无效')
    seen.add(to)
    if (!existsSync(to)) throw new Error('文件已被其他操作移除，回退已拒绝；请保留并核对并行改动')
    const stat = lstatSync(to)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('回退只处理本任务修改的普通文件')
    const before = readFileSync(to), previousMode = stat.mode & 0o777
    if (sha256(before) !== file.expected_sha256) throw new Error('文件已被其他操作修改，回退已拒绝；请保留并核对并行改动')
    let content: Buffer | null = null, mode = 0o644
    if (file.original) {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(file.original.object) || !/^100(?:644|755)$/.test(file.original.mode)) throw new Error('固定来源缺少有效文件对象与模式')
      content = execFileSync('git', ['cat-file', 'blob', file.original.object], { cwd: root, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
      mode = Number.parseInt(file.original.mode, 8) & 0o777
    }
    return { ...file, to, before, previousMode, content, mode }
  })
  if (!prepared.length) throw new Error('本任务没有可回退的文件修改')
  const written: typeof prepared = []
  const replace = (path: string, content: Buffer, mode: number) => {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temporary, content, { flag: 'wx', mode }); chmodSync(temporary, mode)
      renameSync(temporary, path)
    } finally { rmSync(temporary, { force: true }) }
  }
  try {
    // 全部文件和固定对象先读取校验完，再开始写入；任何并行冲突都不先覆盖其它文件。
    for (const file of prepared) {
      signal?.throwIfAborted()
      if (sha256(readFileSync(file.to)) !== file.expected_sha256 || (lstatSync(file.to).mode & 0o777) !== file.previousMode) throw new Error('回退期间检测到并行改动')
    }
    for (const file of prepared) {
      signal?.throwIfAborted()
      if (sha256(readFileSync(file.to)) !== file.expected_sha256 || (lstatSync(file.to).mode & 0o777) !== file.previousMode) throw new Error('回退期间检测到并行改动')
      if (file.content === null) rmSync(file.to)
      else replace(file.to, file.content, file.mode)
      written.push(file)
    }
  } catch (error) {
    let conflict = false
    for (const file of written.reverse()) {
      const matches = file.content === null ? !existsSync(file.to) : existsSync(file.to) && sha256(readFileSync(file.to)) === sha256(file.content) && (lstatSync(file.to).mode & 0o777) === file.mode
      if (!matches) { conflict = true; continue }
      replace(file.to, file.before, file.previousMode)
    }
    if (conflict) throw new Error('回退期间出现并行改动，已保留他人文件；请核对实际状态后继续', { cause: error })
    throw error
  }
  // Git 不保存空目录；只清理因删除本任务新文件而形成的空祖先，非空目录原样保留。
  for (const file of prepared.filter(file => file.content === null)) {
    for (let directory = dirname(file.to); directory !== target.candidate; directory = dirname(directory)) {
      try { rmdirSync(directory) } catch { break }
    }
  }
  return { source: target.source, restored: prepared.filter(file => file.content !== null).map(file => ({ path: `candidate/${file.path}`, sha256: sha256(file.content!), mode: file.mode })),
    deleted: prepared.filter(file => file.content === null).map(file => ({ path: `candidate/${file.path}` })) }
}
