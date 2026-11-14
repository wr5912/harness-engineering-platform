import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { assistantWorkspaceScope } from '../workspace.ts'
import { sameRepositorySource, transportCandidates } from '../../../repository-remotes.mjs'

export interface RepositorySnapshot {
  id: string
  url: string | null
  ref: string | null
  commit: string | null
  workspace: string
  agent_path?: string
  dirty: boolean
  kind?: 'workspace' | 'repository'
  canonical_url?: string | null
  effective_transport_url?: string | null
  transport_candidates?: string[]
}
export type RepositoryChoice = Partial<RepositorySnapshot> & { id: string; available: boolean; error?: string }
interface Declaration { id: string; url: string; ref: string; commit: string; path: string; agent_path?: string }
const inside = (root: string, target: string) => { const path = relative(root, target); return path === '' || !path.startsWith('../') && path !== '..' && !isAbsolute(path) }
function git(path: string, args: string[]) {
  try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).trim() }
  catch { throw new Error('无法核对目标 Git 仓库') }
}
function publicRepositoryUrl(value: string | null): string | null {
  if (!value?.includes('://')) return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'ssh:') url.username = ''
    url.password = ''; url.search = ''; url.hash = ''
    return url.href
  } catch { return null }
}
function optionalGit(path: string, args: string[]) { try { return git(path, args) || null } catch { return null } }
function sourceFields(url: string | null) {
  if (!url) return { canonical_url: null, effective_transport_url: null, transport_candidates: [] as string[] }
  const candidates = transportCandidates(url)
  return { canonical_url: url, effective_transport_url: candidates[0] ?? url, transport_candidates: candidates }
}
function declarations(root: string): Declaration[] {
  const path = join(root, 'config/repositories.json')
  if (!existsSync(path)) return []
  let config: any
  try { config = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('config/repositories.json 不是有效 JSON') }
  if (config?.schemaVersion !== 1 || !Array.isArray(config.repositories)) throw new Error('仓库登记 schemaVersion 或 repositories 无效')
  const ids = new Set(['data'])
  for (const item of config.repositories) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(item.id) || ids.has(item.id)
      || typeof item.url !== 'string' || !item.url || typeof item.path !== 'string' || !item.path
      || typeof item.ref !== 'string' || !item.ref || !/^[0-9a-f]{40}$/.test(item.commit)) throw new Error('仓库登记字段无效或 ID 重复')
    if (item.url.includes('://')) {
      let url: URL
      try { url = new URL(item.url) } catch { throw new Error('仓库地址无效') }
      if (!['http:', 'https:', 'ssh:', 'file:'].includes(url.protocol) || url.password || url.search || url.hash || ['http:', 'https:'].includes(url.protocol) && url.username) throw new Error('仓库地址不能携带凭据或查询参数')
    }
    if (item.agent_path !== undefined && (typeof item.agent_path !== 'string' || !item.agent_path || isAbsolute(item.agent_path) || item.agent_path.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..'))) throw new Error('agent_path 必须是仓库内相对路径')
    ids.add(item.id)
  }
  return config.repositories
}
export function resolveRepository(root: string, requestedId?: string): RepositorySnapshot {
  const data = realpathSync(root)
  const scope = assistantWorkspaceScope(data)
  const id = requestedId ?? scope.default_repository_id
  if (id === 'manager-workspace' && scope.default_repository_id === 'manager-workspace') {
    return { id, kind: 'workspace', workspace: scope.manager_workspace_root, url: null, ref: null, commit: null, dirty: false }
  }
  if (id !== 'data' && !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('目标仓库未登记')
  if (!scope.allowed_repository_ids.includes(id)) throw new Error('目标仓库不在管理助手业务工作区')
  if (id === 'data') {
    const repository = optionalGit(data, ['rev-parse', '--show-toplevel']) === data
    const url = repository ? publicRepositoryUrl(optionalGit(data, ['remote', 'get-url', 'origin'])) : null
    return { id, workspace: data, ...sourceFields(url), url,
      ref: repository ? optionalGit(data, ['symbolic-ref', '--short', '-q', 'HEAD']) : null,
      commit: repository ? optionalGit(data, ['rev-parse', 'HEAD']) : null,
      dirty: repository && Boolean(git(data, ['status', '--porcelain'])) }
  }
  const entry = declarations(data).find(item => item.id === id)
  if (!entry) throw new Error('目标仓库未登记')
  const path = resolve(data, entry.path)
  let workspace: string
  try { workspace = realpathSync(path) } catch { throw new Error('目标仓库目录不存在') }
  if (inside(data, workspace) || inside(workspace, data)) throw new Error('目标仓库必须与数据仓库独立')
  if (realpathSync(git(workspace, ['rev-parse', '--show-toplevel'])) !== workspace) throw new Error('目标必须是 Git 工作树根目录')
  const remotes = git(workspace, ['remote']).split('\n').filter(Boolean)
  if (!remotes.some(remote => sameRepositorySource(git(workspace, ['remote', 'get-url', remote]), entry.url))) throw new Error('目标仓库远端与登记不一致')
  const commit = git(workspace, ['rev-parse', 'HEAD'])
  const refCommit = git(workspace, ['rev-parse', '--verify', `${entry.ref}^{commit}`])
  if (commit !== entry.commit || refCommit !== commit) throw new Error(`目标仓库 HEAD、ref 与锁定提交不一致：${workspace}，HEAD=${commit}，${entry.ref}=${refCommit}，登记 commit=${entry.commit}`)
  if (entry.agent_path && !inside(workspace, realpathSync(join(workspace, entry.agent_path)))) throw new Error('agent_path 超出目标仓库')
  return { id, url: entry.url, ...sourceFields(entry.url), ref: entry.ref, commit, workspace, ...(entry.agent_path ? { agent_path: entry.agent_path } : {}), dirty: Boolean(git(workspace, ['status', '--porcelain'])) }
}

/** 当前来源策略独立于历史 Session 中冻结的 repository 快照。 */
export function currentRepositorySource(root: string, requestedId = 'business-agents') {
  const data = realpathSync(root)
  const scope = assistantWorkspaceScope(data)
  if (requestedId === 'manager-workspace' || !scope.allowed_repository_ids.includes(requestedId)) return null
  if (requestedId === 'data') {
    const repository = optionalGit(data, ['rev-parse', '--show-toplevel']) === data
    const url = repository ? publicRepositoryUrl(optionalGit(data, ['remote', 'get-url', 'origin'])) : null
    return url ? { repository_id: requestedId, ...sourceFields(url) } : null
  }
  const entry = declarations(data).find(item => item.id === requestedId)
  return entry ? { repository_id: requestedId, ...sourceFields(entry.url) } : null
}
export function listRepositories(root: string): { repositories: RepositoryChoice[]; default_repository_id: string } {
  const defaultRepository = resolveRepository(root)
  const repositories: RepositoryChoice[] = [{ ...defaultRepository, available: true }]
  if (defaultRepository.id !== 'data') repositories.push({ ...resolveRepository(root, 'data'), available: true })
  for (const entry of declarations(root)) {
    try { repositories.push({ ...resolveRepository(root, entry.id), available: true }) }
    catch (error) { repositories.push({ id: entry.id, workspace: resolve(root, entry.path), ...sourceFields(entry.url), available: false, error: error instanceof Error ? error.message : '目标仓库不可用' }) }
  }
  return { repositories, default_repository_id: defaultRepository.id }
}
