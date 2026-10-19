import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, readSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const home = '/var/lib/dsh'
const controls = '/opt/dsh-verification-controls'
const installAnchor = '/opt/dsh/apps/cli/package.json'
const fallbackDir = join(home, 'profiles', 'node_modules')
const installRoot = '/opt/dsh/'

function insideInstall(path, trustedRoot = installRoot) {
  return path.startsWith(trustedRoot) && path !== trustedRoot
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

export function installationClosure(anchor) {
  const links = new Map()
  const first = manifestAt(anchor)
  const appDir = join(anchor, '..')
  if (!insideInstall(realpathSync.native(appDir))) {
    throw new Error('DSH CLI installation anchor escaped image tree')
  }
  links.set(first.name, appDir)
  const queue = [{ anchor, manifest: first }]
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
      if (!insideInstall(realpathSync.native(found))) {
        throw new Error(`DSH dependency resolved outside immutable installation: ${dep}`)
      }
      links.set(dep, found)
      queue.push({ anchor: join(found, 'package.json'), manifest: manifestAt(join(found, 'package.json')) })
    }
  }
  return links
}

function fallbackEntries(dir) {
  const names = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('@')) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('trusted fallback scope is not a real directory')
      }
      const children = readdirSync(join(dir, entry.name), { withFileTypes: true })
      if (children.length === 0) throw new Error('trusted fallback has an empty unknown scope')
      for (const child of children) {
        names.push(`${entry.name}/${child.name}`)
      }
    } else {
      names.push(entry.name)
    }
  }
  return names
}

export function validateFallback(dir, expected, allowEmpty, trustedRoot = installRoot) {
  const actual = fallbackEntries(dir)
  if (allowEmpty && actual.length === 0) return false
  if (actual.length !== expected.size) {
    throw new Error('trusted fallback has missing or extra module entries; use a new isolated volume')
  }
  for (const name of actual) {
    const target = expected.get(name)
    if (!target) throw new Error(`trusted fallback has an unapproved module entry: ${name}`)
    const link = join(dir, name)
    const state = lstatSync(link)
    if (!state.isSymbolicLink() || readlinkSync(link) !== target
      || !insideInstall(realpathSync.native(link), trustedRoot)) {
      throw new Error(`trusted fallback module is not pinned to image installation: ${name}`)
    }
  }
  return true
}

function ensureDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  const state = lstatSync(path)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`verification home path is not a real directory: ${path}`)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readBoundedExisting(path, prior, allowEmpty = false) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('O_NOFOLLOW is required for verification home preparation')
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== prior.dev || opened.ino !== prior.ino
      || (!allowEmpty && opened.size === 0) || opened.size > 64 * 1024) {
      throw new Error(`verification home target is not a bounded stable file: ${path}`)
    }
    const buffer = Buffer.alloc(64 * 1024 + 1)
    let bytes = 0
    while (true) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null)
      if (count === 0) break
      bytes += count
      if (bytes > 64 * 1024) throw new Error(`verification home target grew beyond limit: ${path}`)
    }
    const after = fstatSync(descriptor)
    if (bytes !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`verification home target changed during read: ${path}`)
    }
    return buffer.subarray(0, bytes)
  } finally {
    closeSync(descriptor)
  }
}

export function ensureTarget(path, source, allowEmpty = false, mutable = false, legacySource) {
  const controlledState = lstatSync(source)
  if (!controlledState.isFile() || controlledState.isSymbolicLink() || controlledState.nlink !== 1) {
    throw new Error(`controlled DSH_HOME source is not a single regular file: ${source}`)
  }
  const controlled = readBoundedExisting(source, controlledState, allowEmpty)
  if (!existsSync(path)) writeFileSync(path, controlled, { flag: 'wx', mode: 0o600 })
  const state = lstatSync(path)
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new Error(`verification home target is not a single regular file: ${path}`)
  }
  const existing = readBoundedExisting(path, state, allowEmpty)
  if (!mutable && (existing.length !== controlled.length || sha256(existing) !== sha256(controlled))) {
    // 仅将字节仍匹配固定来源的旧 Schedule manifest 迁移为受控投影。
    // Web cordis.patch.yml 是运行设置，始终保留，不能借迁移覆盖用户修改。
    if (legacySource && existsSync(legacySource)) {
      const legacy = readBoundedExisting(legacySource, lstatSync(legacySource))
      const manifest = JSON.parse(legacy.toString('utf8'))
      const bundles = manifest.dsh?.profile?.bundles
      if (Array.isArray(bundles) && bundles.includes('@deepseek-ai/dsh-experimental-schedule-bundle')) {
        manifest.dsh.profile.bundles = bundles.filter(value => value !== '@deepseek-ai/dsh-experimental-schedule-bundle')
        const projected = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
        if (sha256(existing) === sha256(legacy) && sha256(controlled) === sha256(projected)) {
          const temporary = `${path}.rc2-${process.pid}`
          writeFileSync(temporary, controlled, { flag: 'wx', mode: 0o600 })
          renameSync(temporary, path)
          return
        }
      }
    }
    throw new Error(`verification home target differs from controlled file: ${path}`)
  }
}

export async function prepareControlledHome() {
  const mode = process.env.DSH_HARNESS_MODE
  if (mode !== 'verification') {
    throw new Error('DSH_HARNESS_MODE must be verification')
  }
  ensureDirectory(home)
  ensureDirectory(join(home, 'profiles'))
  ensureDirectory(join(home, 'profiles', 'web'))
  ensureDirectory(fallbackDir)
  ensureDirectory(join(home, 'node_modules'))
  ensureDirectory(join(home, 'profiles', 'web', 'node_modules'))

  const patch = join(controls, 'locked-user.patch.yml')
  ensureTarget(join(home, 'cordis.patch.yml'), patch)
  const seed = '/opt/dsh-profile-seed/web-profile.seed.patch.yml'
  ensureTarget(join(home, 'profiles', 'web', 'cordis.patch.yml'), existsSync(seed) ? seed : patch, false, true)
  ensureTarget(join(home, 'AGENTS.md'), join(controls, 'locked-global.AGENTS.md'), true)
  ensureTarget(join(home, '.env'), join(controls, 'locked-bootstrap.env'))

  const appBoot = createRequire(installAnchor).resolve('@deepseek-ai/dsh-app-boot')
  const { healProfilesModuleFallback } = await import(pathToFileURL(appBoot).href)
  const profileManifest = join(home, 'profiles', 'web', 'package.json')
  ensureTarget(profileManifest, join(controls, 'web-profile.package.json'), false, false,
    '/opt/dsh-profile-seed/web-profile.package.json')

  // 仅 home-init 可写独立 fallback 卷；主 DSH 对这棵树只读挂载。
  // 旧卷已有任何非精确安装 symlink 均拒绝，绝不先调用 healer 修补或执行。
  const expected = installationClosure(installAnchor)
  const existingFallback = validateFallback(fallbackDir, expected, true)
  if (typeof healProfilesModuleFallback === 'function') {
    await healProfilesModuleFallback({ installAnchor, home })
    validateFallback(fallbackDir, expected, false)
  } else if (existingFallback) {
    throw new Error('legacy installation fallback is not valid for native profile resolution')
  }

  console.log(JSON.stringify({
    status: 'controlled-home-targets-prepared',
    dsh_mode: mode,
    dsh_home: home,
    controlled_targets: 5,
    trusted_fallback_modules: expected.size,
    note: 'Controlled HOME targets and writable Web profile settings were prepared; this does not prove DSH loaded a Profile or Plugin.',
  }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await prepareControlledHome()
}
