import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'

const installAnchor = '/opt/dsh/apps/cli/package.json'
const installRoot = '/opt/dsh/'
const runtimeRoot = '/opt/dsh-standalone/'

function insideInstall(path, roots) {
  return [roots].flat().some(root => path === resolve(root) || path.startsWith(resolve(root) + sep))
}

function manifestAt(anchor) {
  const state = statSync(anchor)
  if (!state.isFile() || state.size === 0 || state.size > 64 * 1024) {
    throw new Error(`DSH installation manifest is not bounded: ${anchor}`)
  }
  const manifest = JSON.parse(readFileSync(anchor, 'utf8'))
  if (!manifest || typeof manifest.name !== 'string' || !manifest.name) {
    throw new Error(`DSH installation manifest has no package name: ${anchor}`)
  }
  return manifest
}

export function installationClosure(anchor, trustedRoots = [installRoot, runtimeRoot]) {
  const links = new Map()
  const first = manifestAt(anchor)
  const appDir = realpathSync.native(join(anchor, '..'))
  if (!insideInstall(appDir, trustedRoots)) {
    throw new Error('DSH CLI installation anchor escaped image tree')
  }
  links.set(first.name, appDir)
  const queue = [{ anchor: join(appDir, 'package.json'), manifest: first }]
  for (let head = 0; head < queue.length; head += 1) {
    if (queue.length > 1024) throw new Error('DSH installation closure exceeds 1024 packages')
    const current = queue[head]
    for (const dep of [
      ...Object.keys(current.manifest.dependencies ?? {}),
      ...Object.keys(current.manifest.peerDependencies ?? {}),
    ]) {
      if (links.has(dep)) continue
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(dep)) {
        throw new Error(`DSH installation dependency name is invalid: ${dep}`)
      }
      let found
      for (const path of createRequire(current.anchor).resolve.paths(dep) ?? []) {
        const candidate = join(path, dep)
        if (existsSync(join(candidate, 'package.json'))) {
          found = candidate
          break
        }
      }
      if (!found) continue // 与锁定官方 healer 的 declared-but-uninstalled 处理一致。
      // 与 Node 默认解析一致，直接投影实体安装位置，避免叠加 pnpm 链接层级。
      found = realpathSync.native(found)
      if (!insideInstall(found, trustedRoots)) {
        throw new Error(`DSH dependency resolved outside immutable installation: ${dep}`)
      }
      links.set(dep, found)
      queue.push({ anchor: join(found, 'package.json'), manifest: manifestAt(join(found, 'package.json')) })
    }
  }
  return links
}

/** 插件复用同一标准镜像的 CLI 与锁定扩展依赖，不依赖宿主 node_modules。 */
export function runtimeInstallationClosure(anchor = installAnchor, runtime = runtimeRoot, sharedPackages = []) {
  const roots = anchor === installAnchor ? [installRoot, runtime] : [dirname(anchor), runtime]
  const links = installationClosure(anchor, roots)
  const require = createRequire(anchor)
  for (const name of sharedPackages) {
    const manifest = (require.resolve.paths(name) ?? []).map(directory => join(directory, name, 'package.json')).find(existsSync)
    if (!manifest) throw new Error(`当前标准镜像缺少官方共享模块 ${name}`)
    for (const [dependency, target] of installationClosure(manifest, roots)) links.set(dependency, target)
  }
  const dependencies = join(runtime, 'dependencies')
  const manifest = join(dependencies, 'package.json')
  if (existsSync(manifest)) {
    for (const name of Object.keys(manifestAt(manifest).dependencies ?? {})) {
      const target = realpathSync.native(join(dependencies, 'node_modules', name))
      manifestAt(join(target, 'package.json'))
      if (!insideInstall(target, runtime)) throw new Error(`Standard Runtime dependency escaped image installation: ${name}`)
      links.set(name, target)
    }
  }
  return links
}

/** 两种生命周期入口共用同一实体依赖图和链接规则；重启刷新镜像升级后的链接。 */
export function projectRuntimePackages(directory, packages) {
  mkdirSync(directory, { recursive: true })
  for (const [name, target] of packages) {
    const link = join(directory, name)
    mkdirSync(dirname(link), { recursive: true })
    if (existsSync(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) continue
    rmSync(link, { recursive: true, force: true })
    symlinkSync(target, link, 'dir')
  }
}
