import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { copyTree, run, safeRelative } from './fsutil.mts'
import { snapshotRepository } from './repository.mts'
import type { Manifest } from './manifest.mts'
import { managerHome } from '../manager-home.mts'

/** 只追加未入库的原生状态，不能覆盖选定提交中的 Harness 文件。 */
export function copyManagerState(source: string, target: string): void {
  const transient = new Set(['.git', 'node_modules', 'cache', 'tmp', 'logs', '.cache', '__pycache__', 'runtime', 'backups', '.local'])
  const files = run('git', ['-C', source, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  for (const file of files) {
    if (file.split('/').some(part => transient.has(part))) continue
    if (/^profiles\/[^/]+\/(cordis\.yml|harness-platform\.(patch\.yml|sources\.json))$/.test(file)) continue
    const path = safeRelative(file)
    copyTree(join(source, path), join(target, path))
  }
}

/** 在标准 hep-lab 工作区打包时，四个独立资产仓与控制仓一起交付。 */
export function packWorkspace(program: string, data: string, staging: string, workingTree = false): Manifest['workspace'] {
  const root = dirname(program)
  if (!existsSync(join(root, '.hep-lab/sources.json'))) return undefined
  const repositories: NonNullable<Manifest['workspace']>['repositories'] = []
  for (const [name, source, path] of [
    ['control', root, '.'],
    ['manager-home', managerHome(data), 'platform-manager-dsh-home'],
    ['business', join(dirname(data), 'business-agents'), 'manager-workspace/business-agents'],
  ] as const) {
    const target = join(staging, 'workspace', path)
    const repository = snapshotRepository(source, target, join(staging, `repositories/${name}.bundle`), workingTree)
    rmSync(join(target, '.git'), { recursive: true, force: true })
    if (name === 'manager-home') copyManagerState(source, target)
    repositories.push({ name, source, path, ...repository })
  }
  const managerWorkspace = join(staging, 'workspace/manager-workspace')
  mkdirSync(managerWorkspace, { recursive: true })
  const marker = join(dirname(data), '.manager-workspace')
  if (existsSync(marker)) copyTree(marker, join(managerWorkspace, '.manager-workspace'))
  return { sourceRoot: root, repositories }
}

export function workspaceTargets(manifest: Manifest, prefix: string, dataRoot: string): { root: string; managerHome: string; business: string } | undefined {
  if (!manifest.workspace) return undefined
  const root = dirname(resolve(prefix))
  if (resolve(dataRoot) !== join(root, 'manager-workspace/harness-engineering-platform-data')) {
    throw new Error('五仓包的数据目录须为程序同级的 manager-workspace/harness-engineering-platform-data')
  }
  return { root, managerHome: join(root, 'platform-manager-dsh-home'), business: join(root, 'manager-workspace/business-agents') }
}

/** 现场配置保留，随包替换的业务仓引用则必须指向本次恢复的提交。 */
export function alignBusinessRepository(manifest: Manifest, prefix: string, dataRoot: string): void {
  const workspace = workspaceTargets(manifest, prefix, dataRoot)
  const business = manifest.workspace?.repositories.find(repository => repository.name === 'business')
  if (!workspace || !business) return
  const file = join(dataRoot, 'config/repositories.json')
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schemaVersion: 1, repositories: [] }
  if (!Array.isArray(config.repositories)) throw new Error(`${file} 的 repositories 必须为数组`)
  let entry = config.repositories.find((item: { id: string }) => item.id === 'business-agents')
  if (!entry) config.repositories.push(entry = { id: 'business-agents', url: business.origin })
  Object.assign(entry, { path: relative(dataRoot, workspace.business), ref: 'main', commit: business.commit })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
}
