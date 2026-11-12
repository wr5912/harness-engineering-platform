import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { assertAssetPath, candidateDigest, dataPath, sha256, sourceInfo } from './files.ts'
import { assertInheritableVersion } from '../version-id.ts'
import { versionIdentity, versionSource } from '../agents/version-source.ts'
import { assertVersionEditable, VersionGovernanceError } from '../agents/version-governance.ts'
import { containsLiteralLlmKey } from './llm-key.ts'
import { AssetOperationError } from './asset-error.ts'
import { validateCandidateChanges } from '../agents/candidate-assets.ts'

const schema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
const yaml = (text: string) => load(text, { schema })

export interface TaskAssemblyInput {
  target_source: string
  expected_candidate_sha256: string
  files: { source: string; path: string; target_path?: string; expected_source_sha256: string; expected_target_sha256: string | null }[]
  configuration_edits?: { path: string; content: string; expected_target_sha256: string | null }[]
}

function prepare(root: string, input: TaskAssemblyInput) {
  const context = { stage: 'target', path: '' }
  try { return prepareAssets(root, input, context) }
  catch (error) {
    if (error instanceof AssetOperationError || error instanceof VersionGovernanceError) throw error
    const message = (error as Error).message
    const pathError = ['路径必须是工作区内的 POSIX 相对路径', '不允许符号链接路径', 'Candidate 不能包含符号链接', '运行状态、依赖、环境凭据和 LLM API Key 不能作为装配资产', 'dsh/workspace/.env 必须与 Runtime 注释型占位模板逐字节一致，不能写入环境变量或凭据'].includes(message)
    throw new AssetOperationError('assembly_validation_failed', pathError ? message : '装配预检失败，请核对该阶段的来源、路径和配置格式', { ...context, filesystem_code: (error as NodeJS.ErrnoException).code ?? null, next_action: 'tasks/assembly-preview' })
  }
}

function prepareAssets(root: string, input: TaskAssemblyInput, context: { stage: string; path: string }) {
  const reject = (message: string, details: Record<string, any> = {}): never => { throw new AssetOperationError('assembly_validation_failed', message, { ...context, ...details, next_action: 'tasks/assembly-preview' }) }
  const identity = sourceInfo(root, input.target_source)
  assertVersionEditable(root, identity.id)
  const target = { ...identity, entry: versionSource(root, identity.id) }
  const actual = candidateDigest(target.candidate)
  if (actual !== input.expected_candidate_sha256) reject('目标 Candidate 已变化，请重新预览', { expected_sha256: input.expected_candidate_sha256, actual_sha256: actual })
  if (!Array.isArray(input.files) || !input.files.length) reject('请选择需要复用的资产文件')
  const seen = new Set<string>()
  const files = input.files.map(item => {
    context.stage = 'source'; context.path = item.path
    const source = sourceInfo(root, item.source)
    if (source.id !== target.id) {
      try { assertInheritableVersion(source.id, versionIdentity(root, source.id)) }
      catch (error) { reject((error as Error).message) }
    }
    const targetPath = item.target_path ?? item.path
    assertAssetPath(item.path); assertAssetPath(targetPath)
    const from = dataPath(source.candidate, item.path), to = dataPath(target.candidate, targetPath)
    if (seen.has(to)) reject('装配目标路径重复')
    seen.add(to)
    if (!lstatSync(from).isFile() || lstatSync(from).size > 1024 * 1024) reject('仅支持不超过 1 MiB 的普通资产文件')
    const content = readFileSync(from)
    assertAssetPath(item.path, content); assertAssetPath(targetPath, content)
    if (sha256(content) !== item.expected_source_sha256) reject('复用来源已变化，请重新选择', { expected_sha256: item.expected_source_sha256, actual_sha256: sha256(content) })
    if (containsLiteralLlmKey(item.path, content.toString('utf8'))) reject('资产包含 LLM API Key 常量，不能装配')
    context.stage = 'target-file'; context.path = targetPath
    const before = existsSync(to) ? readFileSync(to) : null
    if ((before === null ? null : sha256(before)) !== item.expected_target_sha256) reject('装配目标已变化，请重新预览', { expected_sha256: item.expected_target_sha256, actual_sha256: before === null ? null : sha256(before) })
    return { from, to, path: targetPath, content, before, mode: lstatSync(from).mode & 0o111 ? 0o755 : 0o644,
      previousMode: before ? lstatSync(to).mode & 0o777 : null, source: source.source, source_path: item.path,
      sha256: sha256(content), operation: before === null ? 'create' : 'replace' }
  })
  for (const edit of input.configuration_edits ?? []) {
    context.stage = 'configuration'; context.path = edit.path
    assertAssetPath(edit.path)
    const to = dataPath(target.candidate, edit.path)
    if (seen.has(to)) reject('装配目标路径重复')
    seen.add(to)
    if (typeof edit.content !== 'string' || Buffer.byteLength(edit.content) > 1024 * 1024) reject('配置编辑内容无效或过大')
    assertAssetPath(edit.path, edit.content)
    if (containsLiteralLlmKey(edit.path, edit.content)) reject('配置不能包含 LLM API Key 常量')
    const before = existsSync(to) ? readFileSync(to) : null
    if ((before === null ? null : sha256(before)) !== edit.expected_target_sha256) reject('装配配置已变化，请重新预览', { expected_sha256: edit.expected_target_sha256, actual_sha256: before === null ? null : sha256(before) })
    if (/\.ya?ml$/.test(edit.path)) yaml(edit.content)
    if (/\.json$/.test(edit.path)) JSON.parse(edit.content)
    files.push({ from: '', to, path: edit.path, content: Buffer.from(edit.content), before,
      mode: before && lstatSync(to).mode & 0o111 ? 0o755 : 0o644,
      previousMode: before ? lstatSync(to).mode & 0o777 : null, source: target.source, source_path: edit.path,
      sha256: sha256(edit.content), operation: before === null ? 'create' : 'replace' })
  }
  validateCandidateChanges(root, target.id, files.map(file => ({ rel: `evolution/experiments/${target.id}/candidate/${file.path}`, content: file.content })))
  // 用整批草稿检查目标配置的实际文件引用；只声明目录存在不算运行验证。
  const read = (path: string) => {
    context.stage = 'configuration-references'; context.path = path
    return files.find(file => file.path === path)?.content.toString('utf8') ?? readFileSync(dataPath(target.candidate, path), 'utf8')
  }
  const references = new Set<string>()
  function inspect(value: unknown): void {
    if (typeof value === 'string') {
      for (const [container, relative] of [['/opt/dsh-presets/', 'dsh/presets/'], ['/opt/dsh-managed/', 'dsh/managed/'], ['/work/harness/workspace/', 'dsh/workspace/']]) {
        if (!value.startsWith(container) || value.includes('${')) continue
        const path = relative + value.slice(container.length)
        const file = dataPath(target.candidate, path)
        if (!files.some(item => item.path === path) && !existsSync(file)) reject('目标配置引用了不存在的资产', { path })
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
      if (!existsSync(file.to) || sha256(readFileSync(file.to)) !== file.sha256 || (lstatSync(file.to).mode & 0o111 ? 0o755 : 0o644) !== file.mode) continue
      if (file.before === null) rmSync(file.to)
      else { writeFileSync(file.to, file.before); chmodSync(file.to, file.previousMode!) }
    }
    throw new AssetOperationError('assembly_apply_failed', '装配写入失败；已恢复未被并行修改的本次写入，请核对实际状态后继续', { stage: 'write', filesystem_code: (error as NodeJS.ErrnoException).code ?? null, next_action: 'tasks/assembly-preview' })
  }
  return { experiment_id: target.id, source: target.source, candidate_sha256: candidateDigest(target.candidate),
    files: files.map(({ path, source, source_path, sha256 }) => ({ path, source, source_path, sha256 })),
    bindings: { status: 'declared', referenced_assets: references, runtime_verified: false, preset: target.entry.preset, patch: target.entry.patch,
      required_env_names: target.entry.required_env_names ?? [] },
    next_step: '在目标 Preset/Plugin 配置中绑定所选资产；工具通过 MCP 配置管理接入，再用新 Session 和业务评测核验。' }
}
