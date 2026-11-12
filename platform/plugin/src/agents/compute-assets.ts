import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { load } from 'js-yaml'
import { assertAssetPath, candidateDigest, candidateFiles, dataPath, sha256, sourceInfo } from '../tasks/files.ts'
import { assetText } from './asset-text.ts'
import { isComputeEntry } from './compute-generation-contract.ts'
import { versionSource } from './version-source.ts'
import { validateCandidateChanges } from './candidate-assets.ts'

type Edit = { path: string; expected_sha256: string; move_to?: string; content?: string | null }
type Rpc = (endpoint: string, body: Record<string, any>) => Promise<any>
function require(value: unknown, message: string): asserts value { if (!value) throw Error(message) }

/** 只生成现有 edit 的批次；不执行 Candidate，也不依据静态不可达自动删除业务 Skill。 */
export function previewComputeAssets(root: string, experimentId: string, request: { edits: Edit[]; required_paths: string[] }) {
  const source = sourceInfo(root, experimentId), prefix = `evolution/experiments/${source.id}/candidate/`
  const changePath = `evolution/experiments/${source.id}/change.yaml`, changeBytes = readFileSync(dataPath(root, changePath))
  const candidateHash = candidateDigest(source.candidate)
  const entry = (load(changeBytes.toString('utf8')) as any)?.compute_variant?.generation?.entry_path
  require(isComputeEntry(entry), '请先在既有 compute_variant.generation 中设置模块入口')
  const module = entry.split('/').slice(0, 3).join('/') + '/'
  require(Array.isArray(request.edits) && request.edits.length && Array.isArray(request.required_paths), '必须提供逐文件 edits 和明确的动态依赖 required_paths')
  const files = candidateFiles(source.candidate, ['.local']), names = new Set(files), moves = new Map<string, string>(), removed = new Set<string>()
  const changes = new Map<string, Edit>(), texts = new Map<string, string>()
  function path(value: string) { assertAssetPath(value); dataPath(source.candidate, value); require(!value.split('/').includes('.local'), '不能整理运行工作目录'); return value }
  function text(name: string) {
    const bytes = readFileSync(dataPath(source.candidate, name))
    require(bytes.length <= 1024 * 1024 && !bytes.includes(0), `只能编辑不超过 1 MiB 的文本：${name}`)
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    require(assetText(name, content).editable, `文件包含凭据常量，不能整理：${name}`)
    return content
  }
  for (const edit of request.edits) {
    path(edit.path)
    require(names.has(edit.path) && !changes.has(edit.path) && /^[a-f0-9]{64}$/.test(edit.expected_sha256), '整理仅接受已有文件、唯一来源和 SHA-256')
    require(sha256(readFileSync(dataPath(source.candidate, edit.path))) === edit.expected_sha256, `来源摘要变化：${edit.path}`)
    require(edit.content === undefined || edit.content === null || typeof edit.content === 'string', 'content 必须为完整正文或 null')
    if (edit.move_to) {
      path(edit.move_to)
      require(edit.content !== null && edit.path.startsWith('dsh/managed/') && edit.move_to.startsWith(module) && edit.path !== entry, '只归拢 Managed 文件到当前模块，入口保持稳定')
      require(!existsSync(dataPath(source.candidate, edit.move_to)) && ![...moves.values()].includes(edit.move_to), `目标已存在，不能覆盖：${edit.move_to}`)
      moves.set(edit.path, edit.move_to)
    }
    if (edit.content === null) { require(edit.path !== entry, '不能删除当前工作流入口'); removed.add(edit.path) }
    else texts.set(edit.path, edit.content ?? text(edit.path))
    changes.set(edit.path, edit)
  }
  const finalPath = (name: string) => moves.get(name) ?? name
  const finalNames = new Set(files.filter(name => !removed.has(name)).map(finalPath))
  const loadable = versionSource(root, source.id)
  const roots = ['harness.yaml', entry, `dsh/managed/${loadable.patch}`, `dsh/presets/${loadable.preset}`,
    ...(loadable.guard ? [`dsh/managed/${loadable.guard}`] : []),
    ...(loadable.profile_manifest ? [loadable.profile_manifest.slice(prefix.length)] : []),
    ...(names.has('dsh/workspace/AGENTS.md') ? ['dsh/workspace/AGENTS.md'] : []), ...request.required_paths.map(path)]
  for (const name of roots) require(finalNames.has(finalPath(name)), `明确依赖不能删除或缺失：${name}`)
  function target(name: string) {
    return [name, name.replace(/\.[cm]?js$/, '.ts'), `${name}.ts`, `${name}.mjs`, `${name}.json`, `${name}/package.json`, `${name}/index.ts`].find(value => names.has(value))
  }
  function reference(value: string, from: string) {
    if (value.startsWith('/opt/dsh-managed/')) return { name: target('dsh/managed/' + value.slice(17)), kind: 'managed' }
    if (value.startsWith('/workspace/')) return { name: target('dsh/workspace/' + value.slice(11)), kind: 'workspace' }
    if (value.startsWith('.agents/')) return { name: target('dsh/workspace/' + value), kind: 'workspace-relative' }
    if (value.startsWith('/opt/dsh-presets/')) return { name: target('dsh/presets/' + value.slice(17)), kind: 'preset' }
    if (value.startsWith('./') || value.startsWith('../')) return { name: target(posix.normalize(posix.join(posix.dirname(from), value))), kind: 'relative' }
    return target(value) ? { name: target(value), kind: 'candidate' } : { name: target(posix.join(posix.dirname(from), value)), kind: 'relative' }
  }
  const references: { from: string; to: string }[] = []
  for (const name of files) {
    if (removed.has(name)) continue
    let content = texts.get(name)
    if (content === undefined) {
      const bytes = readFileSync(dataPath(source.candidate, name))
      if (bytes.length > 1024 * 1024 || bytes.includes(0)) continue
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { continue }
    }
    const before = content
    // shortcut: 只改完整路径词元；迁移动态路径时由调用方显式编辑，并用 required_paths 保留依赖。
    content = content.replace(/(["'`])([^"'`\r\n]+)\1|(?<=\]\()[^\s)]+(?=\))|(?<![\w/.-])(?:\/opt\/dsh-managed\/|\/opt\/dsh-presets\/|\/workspace\/|dsh\/managed\/|dsh\/workspace\/)[\w./-]+/g, (raw, quote, literal) => {
      const value = literal ?? raw
      if (quote && !/[./]/.test(value)) return raw
      const ref = reference(value, name)
      if (!ref.name) return raw
      require(!removed.has(ref.name), `仍有依赖引用：${name} → ${ref.name}`)
      const destination = finalPath(ref.name), from = finalPath(name)
      references.push({ from, to: destination })
      if (destination === ref.name && from === name) return raw
      let next = ref.kind === 'managed' ? '/opt/dsh-managed/' + destination.slice(12)
        : ref.kind === 'workspace' ? '/workspace/' + destination.slice(14)
          : ref.kind === 'workspace-relative' ? destination.slice(14)
          : ref.kind === 'preset' ? '/opt/dsh-presets/' + destination.slice(12)
          : ref.kind === 'relative' ? posix.relative(posix.dirname(from), destination) : destination
      if (ref.kind === 'relative' && !next.startsWith('.')) next = './' + next
      if (/\.[cm]?js$/.test(value) && ref.name.endsWith('.ts')) next = next.replace(/\.ts$/, value.slice(value.lastIndexOf('.')))
      return quote ? quote + next + quote : next
    })
    for (const deleted of removed) {
      const skill = /(?:^|\/)\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(deleted)?.[1]
      require(!content.includes(deleted) && !(skill && new RegExp(`(?<![\\w-])${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(content)), `仍有路径或 Skill 引用：${name} → ${deleted}`)
    }
    if (content !== before || changes.has(name)) {
      require(assetText(finalPath(name), content).editable, `文件包含凭据常量，不能整理：${name}`)
      texts.set(name, content)
      if (!changes.has(name)) changes.set(name, { path: name, expected_sha256: sha256(readFileSync(dataPath(source.candidate, name))) })
    }
  }
  const edits = [...changes.values()].map(edit => ({ path: prefix + edit.path, expected_sha256: edit.expected_sha256,
    ...(edit.move_to ? { move_to: prefix + edit.move_to } : {}), content: edit.content === null ? null : texts.get(edit.path)! }))
  validateCandidateChanges(root, source.id, edits.flatMap(edit => [
    ...(edit.move_to ? [{ rel: edit.path, content: null }] : []), { rel: edit.move_to ?? edit.path, content: edit.content },
  ]))
  require(candidateDigest(source.candidate) === candidateHash && readFileSync(dataPath(root, changePath)).equals(changeBytes), '预览期间来源变化，请重新核对')
  const result = { schema_version: 'compute-assets/v1', experiment_id: source.id, candidate_sha256: candidateHash,
    change_sha256: sha256(changeBytes), edits, required_paths: roots.map(finalPath), references,
    notes: ['仅改显式文件及其直接路径引用；静态分析不证明动态 Skill 或拼接路径无用，调用方须列明并核对实际依赖。整理后须重新构建，旧构建摘要失效。'] }
  return { ...result, preview_sha256: sha256(JSON.stringify(result)) }
}

/** 使用现有 edit 的校验与失败回滚；先核对全部文件，已完成批次可安全重复回读。 */
export async function applyComputeAssets(root: string, preview: ReturnType<typeof previewComputeAssets>, expected: string, rpc: Rpc) {
  const { preview_sha256, ...body } = preview
  require(expected === preview_sha256 && sha256(JSON.stringify(body)) === expected, '整理预览摘要变化')
  const source = sourceInfo(root, preview.experiment_id), prefix = `evolution/experiments/${source.id}/candidate/`
  const changePath = `evolution/experiments/${source.id}/change.yaml`
  require(sha256(readFileSync(dataPath(root, changePath))) === preview.change_sha256, '整理期间研究计划变化，请重新预览')
  for (const edit of preview.edits) {
    require(edit.path.startsWith(prefix) && (!edit.move_to || edit.move_to.startsWith(prefix)), '整理预览越出目标 Candidate')
    assertAssetPath(edit.path.slice(prefix.length)); if (edit.move_to) assertAssetPath(edit.move_to.slice(prefix.length))
  }
  function complete() {
    return preview.edits.every(edit => {
      const destination = dataPath(root, edit.move_to ?? edit.path), original = dataPath(root, edit.path)
      return edit.content === null ? !existsSync(original) : existsSync(destination) && lstatSync(destination).isFile()
        && sha256(readFileSync(destination)) === sha256(edit.content) && (!edit.move_to || !existsSync(original))
    })
  }
  if (complete()) return { reused: true, readback: true, preview_sha256 }
  require(candidateDigest(source.candidate) === preview.candidate_sha256, 'Candidate 已变化，未执行整理；请保留原预览并重新核对')
  const payload = { experiment_id: source.id, edits: preview.edits, expected_candidate_sha256: preview.candidate_sha256, expected_change_sha256: preview.change_sha256 }
  await rpc('edit/preview', payload)
  await rpc('edit/apply', payload)
  require(complete(), '保存后回读未通过，请保留预览并核对文件；不要覆盖并行修改')
  return { reused: false, readback: true, preview_sha256 }
}
