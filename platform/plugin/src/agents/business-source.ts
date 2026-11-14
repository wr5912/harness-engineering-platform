import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, lstatSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { businessAgentsRoot } from '../workspace.ts'
import { candidateDigest, candidateFiles, dataPath, atomicWrite, sha256, assertAssetPath } from '../tasks/files.ts'
import { harnessSource } from './version-source.ts'
import { assetText } from './asset-text.ts'
import { AssetOperationError } from '../tasks/asset-error.ts'

const assetSchema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
function git(repository: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr.trim() || '业务仓 Git 读取失败')
  return result.stdout.trim()
}

export function businessIdentity(selector: string) {
  const value = selector.replace(/^business:/, ''), separator = value.indexOf('@')
  const id = separator < 0 ? value : value.slice(0, separator)
  if (!AGENT_ID.test(id)) throw new Error('业务智能体 ID 无效')
  return { id, tag: separator < 0 ? undefined : decodeURIComponent(value.slice(separator + 1)) }
}

/** 固定版本缓存的目录名就是其提交；恢复完整来源身份后再核对依赖。 */
export function businessSourceSelector(root: string, selector: string, candidatePath?: string) {
  const { id, tag } = businessIdentity(selector)
  if (tag !== undefined || !candidatePath) return selector
  const cacheRoot = resolve(dataPath(root, '.local/business-sources'))
  const cached = relative(cacheRoot, resolve(candidatePath)).replaceAll('\\', '/').split('/')
  if (/^[a-f0-9]{40}$/.test(cached[0] ?? '') && cached[2] === 'agents' && cached[3] === id && cached.length === 4) {
    return `business:${id}@${cached[0]}`
  }
  return selector
}

export function businessVersions(root: string, id: string) {
  if (!AGENT_ID.test(id)) throw new Error('业务智能体 ID 无效')
  const repository = businessAgentsRoot(root)
  return git(repository, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:strip=2)', 'refs/tags']).split('\n').filter(Boolean).flatMap(tag => {
    const result = spawnSync('git', ['cat-file', '-e', `refs/tags/${tag}:agents/${id}/harness.yaml`], { cwd: repository })
    return result.status === 0 ? [{ tag, source_id: `business:${id}@${encodeURIComponent(tag)}`, commit: git(repository, ['rev-parse', `refs/tags/${tag}^{commit}`]) }] : []
  })
}

/** Git tag 只物化为本机运行缓存，业务仓仍是唯一资产来源。 */
export function businessSource(root: string, selector: string): Record<string, any> {
  const { id, tag } = businessIdentity(selector)
  if (!AGENT_ID.test(id)) throw new Error('业务智能体 ID 无效')
  const origin = businessAgentsRoot(root), base = `agents/${id}`
  let repository = origin, commit: string | undefined
  if (tag !== undefined) {
    if (!tag) throw new Error('Git tag 不能为空')
    const pinnedCommit = /^[0-9a-f]{40}$/.test(tag)
    commit = git(origin, ['rev-parse', '--verify', pinnedCommit ? `${tag}^{commit}` : `refs/tags/${tag}^{commit}`])
    const parent = dataPath(root, '.local/business-sources')
    repository = join(parent, commit, id)
    if (!existsSync(join(repository, base, 'harness.yaml'))) {
      mkdirSync(join(parent, commit), { recursive: true })
      const temporary = mkdtempSync(join(parent, commit, `${id}-`))
      try {
        const archive = spawnSync('git', ['archive', commit, '--', base], { cwd: origin, maxBuffer: 256 * 1024 * 1024 })
        if (archive.status !== 0) throw new Error(`${pinnedCommit ? 'Git commit' : 'Git tag'} 中没有该智能体的 Harness`)
        const unpack = spawnSync('tar', ['-xf', '-', '-C', temporary], { input: archive.stdout })
        if (unpack.status !== 0) throw new Error('业务 Harness 缓存展开失败')
        try { renameSync(temporary, repository) } catch (error) { if (!existsSync(join(repository, base, 'harness.yaml'))) throw error }
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
  }
  const read = (path: string, optional = false) => {
    const file = dataPath(repository, path)
    return optional && !existsSync(file) ? undefined : readFileSync(file, 'utf8')
  }
  const text = read(`${base}/harness.yaml`)!
  const harness = load(text) as Record<string, any>
  if (harness?.agent?.id !== id) throw new Error('业务 Harness 与智能体 ID 不一致')
  return { ...harnessSource(id, base, harness, read, text), source_kind: 'business',
    source_id: `business:${id}${tag === undefined ? '' : `@${encodeURIComponent(tag)}`}`, repository_root: repository,
    business_repository: origin, ...(tag === undefined ? {} : { tag, source_commit: commit }) }
}

export function runtimeSource(root: string, selector: string, commit?: string): Record<string, any> {
  if (selector.startsWith('business:')) {
    const source = businessSource(root, selector)
    if (commit && source.source_commit !== commit.replace(/^git:/, '')) throw new Error('固定提交与业务 Git tag 不一致')
    return source
  }
  throw new Error('研究版本已停用，请选择 business-agents 中的智能体或 Git tag')
}

export function businessSources(root: string) {
  const repository = businessAgentsRoot(root)
  const file = join(repository, 'manifest.yaml')
  const manifest = existsSync(file) ? load(readFileSync(file, 'utf8')) as Record<string, any> : {}
  const sources: Record<string, Record<string, any>> = {}, errors: Record<string, string> = {}
  for (const entry of manifest.agents ?? []) {
    if (entry.status !== 'active') continue
    const id = entry.agent_id
    try {
      if (entry.path !== `agents/${id}`) throw new Error('业务仓索引路径与智能体 ID 不一致')
      sources[id] = businessSource(root, id)
    } catch (error) { errors[id] = (error as Error).message }
  }
  return { repository, sources, errors }
}

export function businessDetail(root: string, selector: string, revision?: { branch: string | null; commit: string | null; asset_commit: string | null; dirty: boolean; versions: ReturnType<typeof businessVersions> }) {
  const source = businessSource(root, selector), repository = source.repository_root, id = source.agent_id as string
  const path = `agents/${id}`, directory = dataPath(repository, path)
  const harness = load(readFileSync(dataPath(directory, 'harness.yaml'), 'utf8')) as Record<string, any>
  const files = candidateFiles(directory).sort()
  const origin = source.business_repository
  const info = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: origin, encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : null
  }
  return { id, name: harness.agent.name ?? id, notes: harness.agent.notes ?? null, source_id: source.source_id,
    repository: origin, path: directory, tag: source.tag ?? null,
    ...(revision ?? { branch: source.tag ? null : info(['branch', '--show-current']), commit: source.source_commit ?? info(['rev-parse', 'HEAD']),
    asset_commit: source.source_commit ?? info(['log', '-1', '--format=%H', '--', path]), dirty: !source.tag && Boolean(info(['status', '--porcelain', '--', path])),
    versions: businessVersions(root, id) }),
    digest: `sha256:${candidateDigest(directory)}`, profile: source.profile, harness, files }
}

export function businessList(root: string) {
  const catalog = businessSources(root)
  return { repository: catalog.repository, errors: catalog.errors,
    agents: Object.keys(catalog.sources).sort().map(id => businessDetail(root, id)) }
}

/** HTTP 列表异步读取 Git，避免同步子进程阻塞同一进程的网关及健康检查。 */
export async function businessListAsync(root: string, signal?: AbortSignal) {
  const catalog = businessSources(root), runGit = promisify(execFile)
  const info = async (args: string[]) => {
    try { return (await runGit('git', args, { cwd: catalog.repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, signal })).stdout.trim() }
    catch (error) { signal?.throwIfAborted(); return null }
  }
  const [branch, commit, tagNames] = await Promise.all([
    info(['branch', '--show-current']), info(['rev-parse', 'HEAD']),
    info(['for-each-ref', '--sort=-creatordate', '--format=%(refname:strip=2)', 'refs/tags']),
  ])
  if (tagNames === null) throw new Error('业务仓 Git tag 读取失败')
  const tags = await Promise.all(tagNames.split('\n').filter(Boolean).map(async tag => {
    const commit = await info(['rev-parse', `refs/tags/${tag}^{commit}`])
    if (commit === null) throw new Error(`业务 Git tag 无法解析：${tag}`)
    return { tag, commit }
  }))
  const agents = await Promise.all(Object.keys(catalog.sources).sort().map(async id => {
    const path = `agents/${id}`
    const [asset_commit, dirty, versions] = await Promise.all([
      info(['log', '-1', '--format=%H', '--', path]), info(['status', '--porcelain', '--', path]),
      Promise.all(tags.map(async tag => await info(['cat-file', '-e', `refs/tags/${tag.tag}:${path}/harness.yaml`]) === null ? null
        : { tag: tag.tag, source_id: `business:${id}@${encodeURIComponent(tag.tag)}`, commit: tag.commit })),
    ])
    return businessDetail(root, id, { branch, commit, asset_commit, dirty: Boolean(dirty), versions: versions.filter(value => value !== null) })
  }))
  return { repository: catalog.repository, errors: catalog.errors, agents }
}

export function businessRead(root: string, id: string, path: string) {
  const detail = businessDetail(root, id)
  if (!detail.files.includes(path)) throw new Error('文件不在业务 Harness 资产中')
  const bytes = readFileSync(dataPath(detail.path, path))
  if (bytes.includes(0) || bytes.length > 2 * 1024 * 1024) return { path, content: null, message: '此文件请在业务仓中查看' }
  return { path, ...assetText(path, bytes.toString('utf8')) }
}

function assetLocation(root: string, selector: string, path: string) {
  const source = businessSource(root, selector), base = `agents/${source.agent_id}/`
  const rel = path.startsWith(base) ? path.slice(base.length) : path
  const file = dataPath(dataPath(source.repository_root, base.slice(0, -1)), rel)
  assertAssetPath(rel)
  return { source, file, rel, path: base + rel }
}

export function businessAsset(root: string, selector: string, path: string) {
  const target = assetLocation(root, selector, path)
  if (!existsSync(target.file)) return { path: target.path, kind: 'missing', content: '', sha256: null, editable: !target.source.tag }
  const stat = lstatSync(target.file)
  if (!stat.isFile()) return { path: target.path, kind: 'directory', editable: false }
  const bytes = readFileSync(target.file), text = !bytes.includes(0) && bytes.length <= 2 * 1024 * 1024
  return { path: target.path, size: bytes.length, kind: text ? 'text' : 'binary',
    ...(text ? assetText(target.path, bytes.toString('utf8')) : { sha256: sha256(bytes), editable: false }),
    ...(target.source.tag ? { editable: false, reason: 'Git tag 为只读快照；请切换到当前工作树编辑。' } : {}) }
}

/** 同一批先核对、后写入；失败恢复原文件，不向数据仓保存 Harness 副本。 */
export function businessEdit(root: string, selector: string, edits: Record<string, any>[], preview = false) {
  if (!Array.isArray(edits) || !edits.length) throw new AssetOperationError('invalid_request', '缺少 edits')
  const paths = new Set<string>()
  const rows = edits.map(edit => {
    const target = assetLocation(root, selector, edit.path)
    if (target.source.tag) throw new AssetOperationError('read_only', 'Git tag 为只读快照，请编辑当前工作树')
    if (paths.has(target.path)) throw new AssetOperationError('invalid_request', '同一次写入不能包含重复路径')
    paths.add(target.path)
    if (edit.move_to) throw new AssetOperationError('invalid_request', '请在业务仓中移动资产文件')
    const before = existsSync(target.file) ? readFileSync(target.file) : null
    if (edit.expected_sha256 !== (before === null ? null : sha256(before))) throw new AssetOperationError('conflict', '资产已变化，请重新读取后保存')
    if (edit.content !== null && typeof edit.content !== 'string') throw new AssetOperationError('invalid_request', 'content 必须为文本或 null')
    if (edit.content !== null) {
      assertAssetPath(target.rel, edit.content)
      if (/\.ya?ml$/.test(target.rel)) load(edit.content, { schema: assetSchema })
      if (!assetText(target.rel, edit.content).editable) throw new AssetOperationError('invalid_request', '凭据请通过运行配置维护')
      if (target.rel === 'harness.yaml' && (load(edit.content) as any)?.agent?.id !== target.source.agent_id) throw new AssetOperationError('invalid_request', 'Harness 的智能体 ID 不能改变')
    } else if (target.rel === 'harness.yaml') throw new AssetOperationError('invalid_request', '不能删除 Harness 声明')
    return { ...target, before, content: edit.content as string | null }
  })
  if (!preview) {
    const written: typeof rows = []
    try {
      for (const row of rows) { written.push(row); if (row.content === null) rmSync(row.file); else atomicWrite(row.file, row.content) }
    } catch (error) {
      for (const row of written.reverse()) { if (row.before === null) rmSync(row.file, { force: true }); else atomicWrite(row.file, row.before) }
      throw error
    }
  }
  return { written: rows.map(row => ({ path: row.path, sha256: row.content === null ? null : sha256(row.content) })),
    edits: rows.map(row => ({ path: row.path, diff: `--- ${row.path}\n+++ ${row.path}\n@@\n${row.before?.toString('utf8').split('\n').map(line => '-' + line).join('\n') ?? ''}\n${row.content?.split('\n').map(line => '+' + line).join('\n') ?? ''}` })), dry_run: preview }
}
