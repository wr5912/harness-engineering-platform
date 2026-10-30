import { VERSION_ID } from './version-id.ts'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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

/** 与 CLI 共用登记归属规则；同名来源不是跨工作区接管实例的依据。 */
export function workspaceOwnsInstance(assetRoot: string, manifest: Record<string, unknown>): boolean {
  const workspace = workspaceIdentity(assetRoot)
  const initialized = existsSync(join(workspace.root, 'workspace.json'))
  const roots = [workspace.root, ...workspace.legacyRoots]
  if (manifest.workspace_id != null && (!initialized || manifest.workspace_id !== workspace.id)) return false
  if (manifest.asset_root != null && (typeof manifest.asset_root !== 'string' || !isAbsolute(manifest.asset_root) || !roots.includes(resolve(manifest.asset_root)))) return false
  // UUID 可随 Git 克隆；缺少路径的旧登记仍须由 Candidate 挂载确认。
  if (manifest.asset_root != null) return true
  if (!initialized) return true
  if (typeof manifest.source_id !== 'string' || !manifest.source_id.startsWith('experiment:') || !VERSION_ID.test(manifest.source_id.slice('experiment:'.length))) return false
  const mounts = manifest.mounts as Record<string, unknown> | undefined
  const values = ['workspace', 'presets', 'managed'].map(key => mounts?.[key])
  if (values.some(value => value != null && (typeof value !== 'string' || !isAbsolute(value)))) return false
  const paths = values.filter((value): value is string => typeof value === 'string').map(value => resolve(value))
  return paths.length > 0 && roots.some(root => {
    const prefix = join(root, 'evolution/experiments', (manifest.source_id as string).slice(11), 'candidate')
    return paths.every(path => path === prefix || path.startsWith(prefix + '/'))
  })
}

export function workspaceConfigPath(assetRoot: string, name: string): string {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new Error('配置文件名无效')
  const current = join(resolve(assetRoot), 'config', name)
  if (existsSync(join(assetRoot, 'workspace.json')) || existsSync(current)) return current
  const legacy: Record<string, string> = {
    'sources.json': 'runtime/adapters/dsh-container/sources.json',
    'mcp-compositions.json': 'platform/mcp-compositions.json',
    'sites.json': 'runtime/adapters/dsh-web/sites.json',
  }
  return legacy[name] ? join(resolve(assetRoot), legacy[name]) : current
}

export function workspaceLocalPath(assetRoot: string, ...parts: string[]): string {
  return join(resolve(assetRoot), '.local', ...parts)
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
  const locator = join(homedir(), '.config/harness-engineering-platform/workspace.json')
  if (existsSync(locator)) {
    const value = JSON.parse(readFileSync(locator, 'utf8'))
    if (typeof value?.assetRoot !== 'string' || !isAbsolute(value.assetRoot)) throw new Error('部署定位文件必须包含绝对 assetRoot')
    return resolve(value.assetRoot)
  }
  return join(homedir(), 'harness-engineering-platform-data')
}
