import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { dataPath, sha256 } from '../tasks/files.ts'

function pluginLock(directory: string, manifest: Record<string, any>): string | null {
  const manager = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : null
  const npm = ['npm-shrinkwrap.json', 'package-lock.json'].find(file => existsSync(join(directory, file)))
  const options = [npm && { manager: 'npm', file: npm }, existsSync(join(directory, 'pnpm-lock.yaml')) && { manager: 'pnpm', file: 'pnpm-lock.yaml' },
    existsSync(join(directory, 'yarn.lock')) && { manager: 'yarn', file: 'yarn.lock' }].filter((value): value is { manager: string; file: string } => Boolean(value))
  return (manager ? options.find(option => option.manager === manager) : options.length === 1 ? options[0] : undefined)?.file ?? null
}

/** 依赖仍是被忽略的本地安装物；只复用与固定父版清单及锁逐字节一致的安装目录。 */
export function reuseParentDependencies(root: string, parentExperiment: string, candidate: string) {
  const reused: Record<string, any>[] = [], skipped: Record<string, any>[] = []
  const managed = join(candidate, 'dsh/managed')
  if (!existsSync(managed)) return { reused, skipped }
  for (const plugin of readdirSync(managed, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    const relativePlugin = `dsh/managed/${plugin.name}`, target = join(managed, plugin.name), manifestFile = join(target, 'package.json')
    if (!existsSync(manifestFile) || !lstatSync(manifestFile).isFile()) continue
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, any>
    if (!Object.keys((manifest.dependencies as Record<string, any> | undefined) ?? {}).length) continue
    const donor = join(root, 'evolution/experiments', parentExperiment, 'candidate', relativePlugin), modules = join(donor, 'node_modules'), destination = join(target, 'node_modules')
    const unavailable = (reason: string) => skipped.push({ plugin: relativePlugin, reason })
    if (existsSync(destination)) { unavailable('固定父版已有依赖目录，不覆盖来源资产'); continue }
    try {
      dataPath(root, relative(root, donor).split(sep).join('/'))
      const donorManifest = join(donor, 'package.json'), selectedLock = pluginLock(target, manifest)
      if (!selectedLock || !existsSync(donorManifest)) { unavailable('父版本地清单缺失、已变化或锁文件不明确'); continue }
      dataPath(root, relative(root, donorManifest).split(sep).join('/'))
      if (!readFileSync(donorManifest).equals(readFileSync(manifestFile))) { unavailable('父版本地清单缺失、已变化或锁文件不明确'); continue }
      const donorLock = pluginLock(donor, JSON.parse(readFileSync(donorManifest, 'utf8'))), targetLock = join(target, selectedLock)
      if (donorLock !== selectedLock || !existsSync(join(donor, selectedLock))) { unavailable('父版本地选定锁与固定父版不同'); continue }
      dataPath(root, relative(root, targetLock).split(sep).join('/')); dataPath(root, relative(root, join(donor, selectedLock)).split(sep).join('/'))
      const manifestBytes = readFileSync(manifestFile), lockBytes = readFileSync(targetLock)
      if (!readFileSync(join(donor, selectedLock)).equals(lockBytes) || !existsSync(modules)) { unavailable('父版本地锁已变化或依赖目录不可用'); continue }
      const ignored = (path: string) => spawnSync('git', ['check-ignore', '-q', '--', relative(root, path).split(sep).join('/') + '/'], { cwd: root }).status === 0
      if (!ignored(modules) || !ignored(destination)) { unavailable('本地依赖目录未被 Git 忽略'); continue }
      const installed = realpathSync(modules)
      if (!lstatSync(installed).isDirectory()) { unavailable('父版本地依赖不是可用目录'); continue }
      const safeLinks = (directory: string): boolean => readdirSync(directory, { withFileTypes: true }).every(item => {
        const path = join(directory, item.name)
        if (item.isSymbolicLink()) {
          const link = readlinkSync(path), resolved = relative(installed, realpathSync(path))
          return !link.startsWith('/') && resolved !== '..' && !resolved.startsWith(`..${sep}`)
        }
        return !item.isDirectory() || safeLinks(path)
      })
      if (!safeLinks(installed)) { unavailable('依赖含无法随目录保持的外部链接'); continue }
      cpSync(installed, destination, { recursive: true, dereference: false, verbatimSymlinks: true })
      if (!readFileSync(donorManifest).equals(manifestBytes) || !readFileSync(join(donor, selectedLock)).equals(lockBytes)) {
        rmSync(destination, { recursive: true, force: true }); unavailable('复制期间父版清单或锁发生变化'); continue
      }
      reused.push({ plugin: relativePlugin, lockfile: selectedLock, package_sha256: sha256(manifestBytes), lock_sha256: sha256(lockBytes), method: 'copy' })
    } catch {
      rmSync(destination, { recursive: true, force: true })
      unavailable('父版本地依赖无法安全复用；仍需按既有依赖检查处理')
    }
  }
  return { reused, skipped }
}

