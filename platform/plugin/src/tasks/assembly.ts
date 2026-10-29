import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { load as yaml } from 'js-yaml'
import { assertAssetPath, candidateDigest, dataPath, sha256, sourceInfo } from './files.ts'
import { containsLiteralLlmKey } from './llm-key.ts'

export interface TaskAssemblyInput {
  target_source: string
  expected_candidate_sha256: string
  files: { source: string; path: string; target_path?: string; expected_source_sha256: string; expected_target_sha256: string | null }[]
  configuration_edits?: { path: string; content: string; expected_target_sha256: string | null }[]
}

function prepare(root: string, input: TaskAssemblyInput) {
  const target = sourceInfo(root, input.target_source)
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
