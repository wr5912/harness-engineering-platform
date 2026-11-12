import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { collectEntries, sha256File } from '../../manifest.mts'
import { safeRelative } from '../../fsutil.mts'
import { copyAgentSnapshot } from '../snapshot.mts'
import { stageManagedProjections } from './projections.mts'
import type { AgentPackageManifest, AgentSourceSnapshot } from '../types.mts'

/** 同一运行版本的资产修复保留现场连接、依赖、镜像和 HOME；冲突不覆盖，应用失败恢复。 */
export function refreshAgentAssets(root: string, programRoot: string, snapshot: AgentSourceSnapshot, arch: string, imageTag: string) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as AgentPackageManifest
  if (manifest.kind !== 'standalone-agent' || manifest.source.agentId !== snapshot.agentId
    || manifest.source.experimentId !== snapshot.experimentId || manifest.package.arch !== arch
    || manifest.image.tag !== imageTag || (snapshot.source.profile ?? 'web') !== manifest.source.profile
    || manifest.source.profile === 'sdk') throw new Error('资产更新仅支持同一智能体、版本、架构和标准镜像的 Web 安装')
  if (manifest.source.paths.profilePatch !== `assets/managed/${snapshot.source.patch}`
    || manifest.source.paths.preset !== `assets/presets/${snapshot.source.preset}`) throw new Error('运行入口变化，请重新导出安装包')
  const before = new Map(manifest.source.files.map(file => [file.path, file]))
  const after = new Map(snapshot.files.map(file => [file.path, file]))
  const paths = [...new Set([...before.keys(), ...after.keys()])]
  for (const path of paths) {
    safeRelative(path)
    if (!path.startsWith('assets/')) throw new Error('资产更新路径必须位于 assets')
    const old = before.get(path), next = after.get(path), target = join(root, path)
    if (old ? !existsSync(target) || !lstatSync(target).isFile() || sha256File(target) !== old.sha256 || (lstatSync(target).mode & 0o777) !== old.mode : existsSync(target)) {
      throw new Error(`安装资产有现场修改或冲突，未覆盖：${path}`)
    }
    if (old?.sha256 === next?.sha256) continue
    if (/(?:lock\.(?:json|ya?ml)|yarn\.lock|requirements[^/]*\.txt)$/.test(path)) throw new Error(`依赖锁变化，请重新准备并导出安装包：${path}`)
    if (path.endsWith('/package.json')) {
      const previous = old ? JSON.parse(readFileSync(target, 'utf8')) : {}
      const current = next ? JSON.parse(readFileSync(join(snapshot.candidate, next.sourcePath), 'utf8')) : {}
      for (const key of ['dependencies', 'optionalDependencies']) if (JSON.stringify(previous[key] ?? {}) !== JSON.stringify(current[key] ?? {})) throw new Error(`运行依赖变化，请重新准备并导出安装包：${path}`)
    }
  }
  const changed = paths.filter(path => before.get(path)?.sha256 !== after.get(path)?.sha256 || before.get(path)?.mode !== after.get(path)?.mode)
  if (!changed.length) return { assetsUpdated: root, changed: 0, restartRequired: false }
  const backups = join(root, 'state/asset-updates')
  mkdirSync(backups, { recursive: true, mode: 0o700 })
  const backup = mkdtempSync(join(backups, 'update-'))
  chmodSync(backup, 0o700)
  const prepared = join(backup, 'prepared')
  copyAgentSnapshot(snapshot, prepared)
  const metadata = ['manifest.json', 'SHA256SUMS', 'runtime/managed-projection.json']
  const copy = (from: string, to: string) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); chmodSync(to, lstatSync(from).mode & 0o777) }
  for (const path of [...metadata, ...changed.filter(path => before.has(path))]) if (existsSync(join(root, path))) copy(join(root, path), join(backup, 'original', path))
  const projection = join(root, 'runtime/projections/managed'), savedProjection = join(backup, 'projection')
  let projectionMoved = false
  try {
    if (existsSync(projection)) { renameSync(projection, savedProjection); projectionMoved = true }
    for (const path of changed) {
      const target = join(root, path)
      if (after.has(path)) { copy(join(prepared, path), `${target}.update-${process.pid}`); renameSync(`${target}.update-${process.pid}`, target) }
      else rmSync(target)
    }
    const projected = stageManagedProjections(root, programRoot)
    const mounts = JSON.parse(readFileSync(join(root, 'runtime/compose.yaml'), 'utf8')).services.dsh.volumes
    if (mounts.find((mount: any) => mount.target === '/opt/dsh-managed')?.source !== (projected.length ? './runtime/projections/managed' : './assets/managed')) throw new Error('资产的挂载方式变化，请重新导出安装包')
    const replaced = new Set([...changed, 'runtime/managed-projection.json'])
    manifest.files = manifest.files.filter(file => !replaced.has(file.path) && !file.path.startsWith('runtime/projections/managed/'))
    for (const path of changed.filter(path => after.has(path))) {
      const file = after.get(path)!
      manifest.files.push({ path, type: 'file', sha256: file.sha256, mode: file.mode })
    }
    if (existsSync(projection)) manifest.files.push(...collectEntries(projection).map(file => ({ ...file, path: `runtime/projections/managed/${file.path}` })))
    if (existsSync(join(root, 'runtime/managed-projection.json'))) manifest.files.push({ path: 'runtime/managed-projection.json', type: 'file', sha256: sha256File(join(root, 'runtime/managed-projection.json')), mode: lstatSync(join(root, 'runtime/managed-projection.json')).mode & 0o777 })
    manifest.source = { ...manifest.source, candidateSha256: snapshot.candidateSha256, commit: snapshot.git.commit, dirty: snapshot.git.dirty, files: snapshot.files, omitted: snapshot.omitted }
    manifest.files.sort((a, b) => a.path.localeCompare(b.path))
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    const checksums = [...manifest.files.filter(file => file.type === 'file'), { path: 'manifest.json', sha256: sha256File(join(root, 'manifest.json')) }].map(file => {
      const escaped = /[\\\n]/.test(file.path)
      return `${escaped ? '\\' : ''}${file.sha256}  ${file.path.replaceAll('\\', '\\\\').replaceAll('\n', '\\n')}`
    })
    writeFileSync(join(root, 'SHA256SUMS'), checksums.join('\n') + '\n', { mode: 0o600 })
  } catch (error) {
    for (const path of changed) {
      rmSync(`${join(root, path)}.update-${process.pid}`, { force: true })
      if (before.has(path)) copy(join(backup, 'original', path), join(root, path))
      else rmSync(join(root, path), { force: true })
    }
    rmSync(projection, { recursive: true, force: true })
    if (projectionMoved) renameSync(savedProjection, projection)
    for (const path of metadata) {
      if (existsSync(join(backup, 'original', path))) copy(join(backup, 'original', path), join(root, path))
      else rmSync(join(root, path), { force: true })
    }
    throw error
  } finally { rmSync(prepared, { recursive: true, force: true }) }
  return { assetsUpdated: root, changed: changed.length, backup, restartRequired: true }
}
