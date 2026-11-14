import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 程序位置由启动器固定；业务路径只从显式工作区根解析。 */
export function programRoot(): string {
  return resolve(process.env.HARNESS_PROGRAM_ROOT || fileURLToPath(new URL('../../../', import.meta.url)))
}

export function workspaceIdentity(assetRoot: string): { id: string; root: string; legacyRoots: string[] } {
  const root = resolve(assetRoot)
  const descriptor = join(root, 'workspace.json')
  if (!existsSync(descriptor)) {
    // 保留既有工作区和隔离测试的身份；不回退到另一份用户数据。
    return { id: `workspace-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`, root, legacyRoots: [] }
  }
  const value = JSON.parse(readFileSync(descriptor, 'utf8'))
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !/^workspace-[a-zA-Z0-9-]+$/.test(value.id)
    || !Array.isArray(value.legacyRoots ?? []) || (value.legacyRoots ?? []).some((entry: unknown) => typeof entry !== 'string' || !isAbsolute(entry))) {
    throw new Error(`工作区描述无效：${descriptor}`)
  }
  return { id: value.id, root, legacyRoots: [...new Set<string>(value.legacyRoots ?? [])].map(entry => resolve(entry)) }
}

export function workspaceOwnsCwd(assetRoot: string, cwd?: string | null): boolean {
  if (!cwd || !isAbsolute(cwd)) return false
  const workspace = workspaceIdentity(assetRoot)
  return [workspace.root, ...workspace.legacyRoots].includes(resolve(cwd))
}

/** 管理会话可位于父工作区或两个业务仓，评测/实例的数据归属仍使用 workspaceOwnsCwd。 */
export function managementSessionRoots(assetRoot: string): string[] {
  const workspace = workspaceIdentity(assetRoot)
  const scope = assistantWorkspaceScope(assetRoot)
  const previousBusinessRoots = workspace.legacyRoots.map(previous => join(dirname(previous), 'business-agents'))
  return [...new Set([workspace.root, ...workspace.legacyRoots, ...previousBusinessRoots, scope.manager_workspace_root, scope.roots.business_agents])]
}

export function workspaceOwnsManagementCwd(assetRoot: string, cwd?: string | null): boolean {
  return Boolean(cwd && isAbsolute(cwd) && managementSessionRoots(assetRoot).includes(resolve(cwd)))
}

/** 与 CLI 共用登记归属规则；同名来源不是跨工作区接管实例的依据。 */
export function workspaceOwnsInstance(assetRoot: string, manifest: Record<string, unknown>): boolean {
  const workspace = workspaceIdentity(assetRoot)
  const initialized = existsSync(join(workspace.root, 'workspace.json'))
  const roots = [workspace.root, ...workspace.legacyRoots]
  // 实例必须声明当前 business source 和真实数据根；旧 Experiment/Candidate 挂载不再认领。
  if (typeof manifest.source_id !== 'string' || !/^business:[a-z0-9]+(?:-[a-z0-9]+)*(?:@[a-f0-9]{40})?$/.test(manifest.source_id)) return false
  if (manifest.source_ref !== undefined && (typeof manifest.source_ref !== 'string' || !/^git:[a-f0-9]{40}$/.test(manifest.source_ref))) return false
  if (manifest.workspace_id != null && (!initialized || manifest.workspace_id !== workspace.id)) return false
  if (typeof manifest.asset_root !== 'string' || !isAbsolute(manifest.asset_root) || !roots.includes(resolve(manifest.asset_root))) return false
  return true
}

export function workspaceConfigPath(assetRoot: string, name: string): string {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error('配置文件名无效')
  const mcp = { 'mcp-manager.json': 'manager.json', 'mcp-compositions.json': 'compositions.json' }[name]
  if (mcp && existsSync(join(assetRoot, 'mcp', 'manager.json'))) return join(resolve(assetRoot), 'mcp', mcp)
  const current = join(resolve(assetRoot), 'config', name)
  if (existsSync(join(assetRoot, 'workspace.json')) || existsSync(current)) return current
  const legacy: Record<string, string> = {
    'sources.json': 'runtime/adapters/dsh-container/sources.json',
    'mcp-compositions.json': 'platform/mcp-compositions.json',
    'sites.json': 'runtime/adapters/dsh-web/sites.json',
  }
  return legacy[name] ? join(resolve(assetRoot), legacy[name]) : current
}

/** 业务 Agent 的设计、评测和 Harness 来源根；运行状态仍归数据工作区。 */
export function businessAgentsRoot(assetRoot: string): string {
  const explicit = process.env.HARNESS_BUSINESS_AGENTS_ROOT
  if (explicit) return resolve(explicit)
  const repositories = join(resolve(assetRoot), 'config/repositories.json')
  try {
    const value = JSON.parse(readFileSync(repositories, 'utf8'))
    const entry = Array.isArray(value?.repositories)
      ? value.repositories.find((item: any) => item?.id === 'business-agents')
      : undefined
    if (typeof entry?.path === 'string' && entry.path) return resolve(resolve(assetRoot), entry.path)
  } catch { /* 旧工作区没有来源清单时继续使用相邻仓库。 */ }
  const sibling = resolve(assetRoot, '..', 'business-agents')
  return existsSync(sibling) ? sibling : resolve(assetRoot)
}

export function businessAgentPath(assetRoot: string, agentId: string, relative = ''): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
    throw new Error('业务 Agent 来源路径无效')
  }
  return join(businessAgentsRoot(assetRoot), 'agents', agentId, relative)
}

export interface AssistantWorkspaceScope {
  schema_version: 1
  kind: 'platform-assistant-business-workspace'
  default_repository_id: 'manager-workspace' | 'data'
  allowed_repository_ids: string[]
  business_repository_id: 'business-agents'
  excluded_repository_ids: string[]
  roles: Record<string, string>
  manager_workspace_root: string
  roots: { data: string; business_agents: string }
}

/** 管理会话的真实父目录；后台资产寻址仍以 data Git 根为准。 */
export function managerWorkspaceRoot(assetRoot: string): string {
  const root = resolve(assetRoot)
  const explicit = process.env.HARNESS_MANAGER_WORKSPACE_ROOT
  if (explicit) return resolve(explicit)
  const config = join(root, 'config/assistant-workspace.json')
  if (existsSync(config)) {
    const value = JSON.parse(readFileSync(config, 'utf8'))
    if (typeof value?.workspaceRoot === 'string' && value.workspaceRoot && !isAbsolute(value.workspaceRoot)) return resolve(root, value.workspaceRoot)
  }
  // 单数据根的既有安装继续沿用；新布局由真实 manager-workspace 父目录识别。
  return basename(dirname(root)) === 'manager-workspace' ? dirname(root) : root
}

/** 管理工作区包含两个独立 Git 工作树，程序和 HOME 不作为业务目标。 */
export function assistantWorkspaceScope(assetRoot: string): AssistantWorkspaceScope {
  const root = resolve(assetRoot)
  const path = join(root, 'config/assistant-workspace.json')
  const fallback = {
    schemaVersion: 1,
    kind: 'platform-assistant-business-workspace',
    defaultRepositoryId: basename(dirname(root)) === 'manager-workspace' ? 'manager-workspace' : 'data',
    allowedRepositoryIds: ['data', 'business-agents'],
    businessRepositoryId: 'business-agents',
    excludedRepositoryIds: ['harness-engineering-platform', 'platform-manager-dsh-home'],
    roles: {
      data: 'business-runtime-and-history',
      'business-agents': 'business-definition-acceptance-and-harness',
      'harness-engineering-platform': 'tool-source-only',
      'platform-manager-dsh-home': 'runtime-identity-only',
    },
    workspaceRoot: basename(dirname(root)) === 'manager-workspace' ? '..' : '.',
  }
  let value: any = fallback
  if (existsSync(path)) {
    try { value = JSON.parse(readFileSync(path, 'utf8')) }
    catch { throw new Error(`管理助手业务工作区契约不是有效 JSON：${path}`) }
  }
  const isIds = (input: unknown): input is string[] => Array.isArray(input)
    && input.length > 0 && input.every(item => typeof item === 'string' && /^[a-z][a-z0-9-]*$/.test(item))
  const allowed = new Set(isIds(value?.allowedRepositoryIds) ? value.allowedRepositoryIds : [])
  const excluded = new Set(isIds(value?.excludedRepositoryIds) ? value.excludedRepositoryIds : [])
  const requiredRoles = ['data', 'business-agents', 'harness-engineering-platform', 'platform-manager-dsh-home']
  const configuredWorkspaceRoot = value?.workspaceRoot ?? (value?.defaultRepositoryId === 'manager-workspace' ? '..' : '.')
  const managerRoot = managerWorkspaceRoot(root)
  if (value?.schemaVersion !== 1 || value.kind !== fallback.kind || !['manager-workspace', 'data'].includes(value.defaultRepositoryId)
    || value.businessRepositoryId !== 'business-agents' || !isIds(value.allowedRepositoryIds)
    || value.allowedRepositoryIds.length !== 2 || !allowed.has('data') || !allowed.has('business-agents')
    || !isIds(value.excludedRepositoryIds) || !excluded.has('harness-engineering-platform') || !excluded.has('platform-manager-dsh-home')
    || value.excludedRepositoryIds.some((item: string) => allowed.has(item))
    || typeof configuredWorkspaceRoot !== 'string' || isAbsolute(configuredWorkspaceRoot)
    || value.defaultRepositoryId === 'manager-workspace' && (configuredWorkspaceRoot !== '..' || basename(managerRoot) !== 'manager-workspace' || dirname(root) !== managerRoot)
    || !value.roles || typeof value.roles !== 'object' || Array.isArray(value.roles)
    || requiredRoles.some(item => typeof value.roles[item] !== 'string' || !value.roles[item].trim())) {
    throw new Error(`管理助手业务工作区契约无效：${path}`)
  }
  if (value.defaultRepositoryId === 'manager-workspace') {
    for (const directory of [managerRoot, root, businessAgentsRoot(root)]) {
      if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) {
        throw new Error(`管理助手工作区必须使用真实目录：${directory}`)
      }
    }
    if (dirname(businessAgentsRoot(root)) !== managerRoot) throw new Error('业务仓库必须直接位于管理助手工作区中')
  }
  return {
    schema_version: 1,
    kind: value.kind,
    default_repository_id: value.defaultRepositoryId,
    allowed_repository_ids: [...value.allowedRepositoryIds],
    business_repository_id: 'business-agents',
    excluded_repository_ids: [...value.excludedRepositoryIds],
    roles: { ...value.roles },
    manager_workspace_root: managerRoot,
    roots: { data: root, business_agents: businessAgentsRoot(root) },
  }
}

export function workspaceLocalPath(assetRoot: string, ...parts: string[]): string {
  return join(resolve(assetRoot), '.local', ...parts)
}

export function mcpLocalPath(assetRoot: string, area: string, ...parts: string[]): string {
  if (existsSync(join(assetRoot, 'mcp/manager.json'))) return join(resolve(assetRoot), 'mcp/.local', area, ...parts)
  return area === 'executions' ? workspaceLocalPath(assetRoot, 'mcp-composition-executions', ...parts) : workspaceLocalPath(assetRoot, area, ...parts)
}

/** CLI、实例详情与目录监听共用同一状态位置，不随进程 cwd 改变。 */
export function instanceStateRoot(assetRoot: string, override?: string): string {
  const value = override ?? (process.env.HARNESS_INSTANCE_STATE_ROOT
    || (process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, 'dsh-dev') : workspaceLocalPath(assetRoot, 'instances')))
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) {
    throw new Error('实例状态目录仅支持当前用户的 ~ 或 ~/ 路径')
  }
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  return resolve(assetRoot, expanded)
}

export function defaultAssetRoot(): string {
  if (process.env.HARNESS_ASSET_ROOT) {
    const value = process.env.HARNESS_ASSET_ROOT
    return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)
  }
  const locator = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'harness-engineering-platform/workspace.json')
  if (existsSync(locator)) {
    const value = JSON.parse(readFileSync(locator, 'utf8'))
    if (typeof value?.assetRoot !== 'string' || !isAbsolute(value.assetRoot)) throw new Error('部署定位文件必须包含绝对 assetRoot')
    return resolve(value.assetRoot)
  }
  return join(homedir(), 'harness-engineering-platform-data')
}
