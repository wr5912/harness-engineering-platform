import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { collectEntries, sha256File, writeChecksums } from '../../manifest.mts'
import { stageManagedProjections } from './projections.mts'

/** 旧版开发实例直接链接原生 Harness 时，只刷新装载投影，不覆盖链接源。 */
export function refreshLinkedAgentAssets(root: string, programRoot: string, dependencyProjection?: string) {
  const manifestFile = join(root, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  if (manifest.kind !== 'standalone-agent' || manifest.schemaVersion !== 1 || manifest.source?.profile !== 'web')
    throw new Error('仅支持使用软链接 Harness 的旧版 Web 实例')
  const harnessLink = join(root, 'assets/harness.yaml')
  if (!lstatSync(harnessLink).isSymbolicLink()) throw new Error('assets/harness.yaml 必须是 Harness 软链接')
  const harnessRoot = dirname(realpathSync(harnessLink))
  for (const name of ['managed', 'presets', 'workspace']) {
    const path = join(root, 'assets', name)
    if (!lstatSync(path).isSymbolicLink() || realpathSync(path) !== realpathSync(join(harnessRoot, 'dsh', name)))
      throw new Error(`assets/${name} 必须链接到同一 Harness`)
  }
  const composeFile = join(root, 'runtime/compose.yaml')
  const compose = JSON.parse(readFileSync(composeFile, 'utf8'))
  const mounts = compose.services?.dsh?.volumes
  if (!Array.isArray(mounts) || !mounts.some((mount: any) => mount.target === '/opt/dsh-managed'))
    throw new Error('未找到标准 managed 挂载')
  const backupRoot = join(root, 'state/asset-updates')
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
  const backup = mkdtempSync(join(backupRoot, 'linked-'))
  const metadata = ['manifest.json', 'SHA256SUMS', 'agent', 'runtime/compose.yaml', 'runtime/managed-projection.json', 'runtime/linked-assets.json']
  const originals = new Map(metadata.map(path => [path, existsSync(join(root, path)) ? readFileSync(join(root, path)) : null]))
  for (const [path, bytes] of originals) if (bytes) {
    mkdirSync(dirname(join(backup, path)), { recursive: true })
    writeFileSync(join(backup, path), bytes, { mode: 0o600 })
  }
  const projection = join(root, 'runtime/projections/managed')
  const hadProjection = existsSync(projection)
  if (hadProjection) renameSync(projection, join(backup, 'projection'))
  try {
    const projected = stageManagedProjections(root, programRoot)
    // 旧实例有时仅在投影中安装插件依赖。独立挂载依赖，避免写入软链接仓库。
    const dependencies = dependencyProjection ?? (hadProjection ? join(backup, 'projection') : undefined)
    const dependencyMounts: Array<{ source: string; target: string; type: string; read_only: boolean }> = []
    if (dependencies) for (const plugin of readdirSync(dependencies, { withFileTypes: true })) {
      if (!plugin.isDirectory() || !existsSync(join(root, 'assets/managed', plugin.name, 'package.json'))) continue
      const from = join(dependencies, plugin.name, 'node_modules')
      if (!existsSync(from) || existsSync(join(root, 'assets/managed', plugin.name, 'node_modules'))) continue
      const destination = join(root, 'state/managed-dependencies', plugin.name, 'node_modules')
      mkdirSync(dirname(destination), { recursive: true })
      if (!existsSync(destination)) cpSync(from, destination, { recursive: true })
      dependencyMounts.push({ type: 'bind', source: `./state/managed-dependencies/${plugin.name}/node_modules`,
        target: `/opt/dsh-managed/${plugin.name}/node_modules`, read_only: true })
    }
    for (const service of Object.values(compose.services) as any[]) for (const mount of service.volumes ?? []) {
      // 旧 profile 的绝对目标路径保留，只纠正仓库迁移后的宿主来源。
      if (typeof mount.source === 'string' && mount.source === mount.target
        && mount.source.endsWith(`/agents/${manifest.source.agentId}`)) mount.source = harnessRoot
    }
    for (const service of Object.values(compose.services) as any[]) {
      if (!service.volumes?.some((mount: any) => mount.target === '/opt/dsh-managed')) continue
      // assets 的绝对软链接必须在容器内同样可达；旧 profile 目标继续保留。
      if (!service.volumes.some((mount: any) => mount.target === harnessRoot))
        service.volumes.push({ type: 'bind', source: harnessRoot, target: harnessRoot, read_only: true })
      for (const mount of dependencyMounts) if (!service.volumes.some((current: any) => current.target === mount.target)) service.volumes.push(mount)
      const nested = service.volumes.filter((mount: any) => /^\/opt\/dsh-managed\/[^/]+\/node_modules$/.test(mount.target))
      if (nested.length && !existsSync(projection)) cpSync(realpathSync(join(root, 'assets/managed')), projection,
        { recursive: true, filter: source => basename(source) !== 'node_modules' })
      for (const mount of nested) mkdirSync(join(projection, mount.target.slice('/opt/dsh-managed/'.length)), { recursive: true })
      service.volumes.find((mount: any) => mount.target === '/opt/dsh-managed').source = existsSync(projection)
        ? './runtime/projections/managed' : './assets/managed'
    }
    writeFileSync(composeFile, JSON.stringify(compose, null, 2) + '\n', { mode: 0o600 })
    // Compose 只指定 dsh 时会复用旧 init；挂载变化必须同时重建依赖容器。
    const launcher = join(root, 'agent')
    if (existsSync(launcher)) writeFileSync(launcher, readFileSync(launcher, 'utf8')
      .replaceAll('compose up -d --force-recreate --wait dsh', 'compose up -d --force-recreate --always-recreate-deps --wait dsh'))
    writeFileSync(join(root, 'runtime/linked-assets.json'), JSON.stringify({ harnessRoot, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
    const replaced = (path: string) => path.startsWith('assets/') || path.startsWith('runtime/projections/managed/')
      || ['agent', 'runtime/compose.yaml', 'runtime/managed-projection.json', 'runtime/linked-assets.json'].includes(path)
    manifest.files = manifest.files.filter((entry: any) => !replaced(entry.path))
    manifest.files.push(...collectEntries(join(root, 'assets')).map(entry => ({ ...entry, path: `assets/${entry.path}` })))
    if (existsSync(projection)) manifest.files.push(...collectEntries(projection).map(entry => ({ ...entry, path: `runtime/projections/managed/${entry.path}` })))
    for (const name of ['compose.yaml', 'managed-projection.json', 'linked-assets.json']) {
      const path = `runtime/${name}`, file = join(root, path)
      if (existsSync(file)) manifest.files.push({ path, type: 'file', sha256: sha256File(file), mode: lstatSync(file).mode & 0o777 })
    }
    if (existsSync(launcher)) manifest.files.push({ path: 'agent', type: 'file', sha256: sha256File(launcher), mode: lstatSync(launcher).mode & 0o777 })
    manifest.files.sort((a: any, b: any) => a.path.localeCompare(b.path))
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    writeChecksums(root, manifest.files)
    return { assetsUpdated: resolve(root), harnessRoot, projected: projected.length, backup, restartRequired: true }
  } catch (error) {
    rmSync(projection, { recursive: true, force: true })
    if (hadProjection) renameSync(join(backup, 'projection'), projection)
    for (const [path, bytes] of originals) {
      if (bytes) writeFileSync(join(root, path), bytes, { mode: 0o600 })
      else rmSync(join(root, path), { force: true })
    }
    throw error
  }
}
