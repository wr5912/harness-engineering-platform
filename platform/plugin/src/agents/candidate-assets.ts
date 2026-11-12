import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { assertAssetPath, atomicWrite, BOOTSTRAP_ENV, candidateFiles, dataPath } from '../tasks/files.ts'
import { AssetOperationError } from '../tasks/asset-error.ts'
import { versionSource } from './version-source.ts'

export type CandidateChange = { rel: string; content: string | Buffer | null }
const schema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])

/** 编辑、融合、装配和启动共用完整 Candidate 的结构合同；不执行其中的代码。 */
export function assertCandidateAssets(root: string, id: string, webBootstrap = true) {
  const prefix = `evolution/experiments/${id}/candidate/`, candidate = dataPath(root, prefix.slice(0, -1))
  const reject = (path: string, reason: string): never => { throw new AssetOperationError('candidate_assets_invalid', 'Candidate 装载资产不完整或不安全', {
    stage: 'candidate-assets', path, reason, next_action: '修复来源 Candidate 后重新预览；不会自动重试创建实例',
  }) }
  let source: ReturnType<typeof versionSource>
  try { source = versionSource(root, id) }
  catch (error) { reject('harness.yaml', error instanceof Error && error.name === 'Error' ? error.message : '请核对版本身份和 loadable_assets 装载声明及 YAML 格式') }
  const requirePath = (path: string, directory = false) => {
    try {
      const info = lstatSync(dataPath(candidate, path))
      if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) reject(path, directory ? '需要实体目录' : '需要普通单链接文件')
    } catch (error) {
      if (error instanceof AssetOperationError) throw error
      reject(path, '文件或目录缺失，或路径包含符号链接')
    }
  }
  for (const path of ['dsh/workspace', 'dsh/presets', 'dsh/managed']) requirePath(path, true)
  for (const path of ['harness.yaml', `dsh/presets/${source!.preset}`, `dsh/managed/${source!.patch}`,
    ...(source!.guard ? [`dsh/managed/${source!.guard}`] : []),
    ...(source!.profile_manifest ? [source!.profile_manifest.slice(prefix.length)] : []),
    ...Object.values(source!.harness_runtime?.preset_files ?? {}), ...Object.values(source!.harness_runtime?.role_instructions ?? {})] as string[]) {
    requirePath(path)
    if (/\.(?:ya?ml|json)$/.test(path)) {
      try {
        const bytes = readFileSync(dataPath(candidate, path))
        if (bytes.includes(0)) throw new Error('binary')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (path.endsWith('.json')) JSON.parse(text)
        else load(text, { schema })
      } catch { reject(path, '引用配置必须是有效的 YAML/JSON 文本；不执行 !!js') }
    }
  }
  if (source!.harness_runtime?.project_workspace) requirePath(source!.harness_runtime.project_workspace.path, true)
  if (source!.profile === 'web' && webBootstrap) requirePath(BOOTSTRAP_ENV)
  for (const path of candidateFiles(candidate)) {
    try { assertAssetPath(path, path === BOOTSTRAP_ENV ? readFileSync(dataPath(candidate, path)) : undefined) }
    catch (error) { reject(path, (error as Error).message) }
  }
  return source!
}

/** 构造最终文件树，删除、移动及二进制替换也参与检查；原 Candidate 不变。 */
export function validateCandidateChanges(root: string, id: string, changes: CandidateChange[]) {
  const prefix = `evolution/experiments/${id}/candidate/`
  if (!changes.some(change => change.rel.startsWith(prefix))) return
  const temporary = mkdtempSync(join(tmpdir(), 'harness-candidate-check-'))
  try {
    const candidate = dataPath(root, prefix.slice(0, -1))
    atomicWrite(join(temporary, `evolution/experiments/${id}/change.yaml`), readFileSync(dataPath(root, `evolution/experiments/${id}/change.yaml`)))
    const files = new Map(candidateFiles(candidate).map(path => [prefix + path, readFileSync(dataPath(candidate, path))]))
    for (const change of changes.filter(change => change.rel.startsWith(prefix))) {
      if (change.content === null) files.delete(change.rel)
      else files.set(change.rel, Buffer.from(change.content))
    }
    for (const [path, bytes] of files) atomicWrite(dataPath(temporary, path), bytes)
    // 空的装载目录也属于结构；文件/目录冲突仍由 mkdir 报错。
    let project: string | undefined
    try { project = versionSource(temporary, id).harness_runtime?.project_workspace?.path } catch { /* 统一在完整检查中报告装载声明错误。 */ }
    for (const path of ['dsh/workspace', 'dsh/presets', 'dsh/managed', ...(project ? [project] : [])]) {
      if (existsSync(join(candidate, path)) && lstatSync(join(candidate, path)).isDirectory()) mkdirSync(join(temporary, prefix, path), { recursive: true })
    }
    assertCandidateAssets(temporary, id)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}
