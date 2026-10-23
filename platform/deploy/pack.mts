import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { copyTree, ensureEmptyDir, removeTree, run, tarCreate } from './fsutil.mts'
import { collectEntries, sha256File, writeManifest, type Arch, type Manifest, type RuntimeEntry } from './manifest.mts'
import { collectSystemGit } from './git.mts'
import { expectedImage, inspectImage, inspectImageArchive, saveImage, verifyImageInfo } from './image.mts'
import { assertRealWorkspace } from './data.mts'

export interface PackOptions {
  programRoot: string
  out: string
  dataRoot?: string
  assetsDir?: string
  imageArchive?: string
  imageTag?: string
  imageId?: string
  imageFingerprint?: string
  includeImage: boolean
  includeData: boolean
  allowDirty: boolean
  keepStaging: boolean
  allowFixtureData: boolean
  arch: Arch
}

function versionOf(programRoot: string): string {
  const path = join(programRoot, 'VERSION.md')
  if (!existsSync(path)) return 'unknown'
  const match = readFileSync(path, 'utf8').match(/`(\d+\.\d+\.\d+)`/)
  return match ? match[1] : 'unknown'
}

function commitOf(programRoot: string): { commit: string; dirty: boolean } {
  try {
    const commit = run('git', ['-C', programRoot, 'rev-parse', 'HEAD']).trim()
    const dirty = run('git', ['-C', programRoot, 'status', '--porcelain']).trim().length > 0
    return { commit, dirty }
  } catch {
    return { commit: 'unknown', dirty: true }
  }
}

function copyAsset(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true })
  // 打包暂存只读；同一文件系统复用离线资源的 inode，避免重复复制大安装树。
  if (statSync(source).dev === statSync(dirname(target)).dev) {
    try { run('/bin/cp', ['-al', '--', source, target]); return }
    catch { removeTree(target) }
  }
  copyTree(source, target)
}

function copyProgram(programRoot: string, staging: string, assetsDir?: string): void {
  const target = join(staging, 'program')
  mkdirSync(target, { recursive: true })
  const skipNames = new Set(['node_modules', 'lib', '__pycache__', '.pytest_cache', '.git', 'dist', 'coverage', '.local', 'test'])
  const copy = (relative: string): void => {
    const source = join(programRoot, relative)
    const destination = join(target, relative)
    copyTree(source, destination, sourcePath => {
      const name = basename(sourcePath)
      if (skipNames.has(name)) return false
      if (name.startsWith('test_') && relative.includes('dsh-container')) return false
      if (name.endsWith('.test.mjs')) return false
      return true
    })
  }
  for (const name of ['platform', 'runtime', 'plugins']) copy(name)
  for (const name of ['README.md', 'VERSION.md', 'CHANGELOG.md']) {
    const source = join(programRoot, name)
    if (existsSync(source)) copyTree(source, join(target, name))
  }
  if (assetsDir) {
    const preparedPlugin = join(assetsDir, 'program', 'platform', 'plugin', 'node_modules')
    const preparedWeb = join(assetsDir, 'program', 'runtime', 'adapters', 'dsh-web', 'node_modules')
    if (!existsSync(preparedPlugin)) throw new Error(`离线资源缺少平台插件依赖：${preparedPlugin}`)
    if (!existsSync(preparedWeb)) throw new Error(`离线资源缺少 Web 适配器依赖：${preparedWeb}`)
    copyAsset(preparedPlugin, join(target, 'platform', 'plugin', 'node_modules'))
    copyAsset(preparedWeb, join(target, 'runtime', 'adapters', 'dsh-web', 'node_modules'))
  }
}

function copyData(dataRoot: string, staging: string): void {
  const target = join(staging, 'data')
  mkdirSync(target, { recursive: true })
  const runtime = ['.local/platform-home', '.local/instances', '.local/npm-cache', '.local/evaluation-jobs', '.local/platform-start.log', '.local/platform-start.pid']
  copyTree(dataRoot, target, sourcePath => {
    const stat = lstatSync(sourcePath)
    if (stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) return false
    const path = relative(dataRoot, sourcePath).split(sep).join('/')
    return !runtime.some(prefix => path === prefix || path.startsWith(prefix + '/'))
  })
}

function copyImage(options: PackOptions, staging: string): Manifest['image'] {
  if (!options.includeImage) return undefined
  const expected = expectedImage(resolve(options.programRoot), options.arch)
  if (options.imageTag && options.imageTag !== expected.tag) throw new Error(`镜像标签不符合锁定 Runtime：期望 ${expected.tag}，实际 ${options.imageTag}`)
  if (options.imageFingerprint && options.imageFingerprint !== expected.fingerprint) throw new Error('镜像构建指纹不符合锁定 Runtime')
  const target = join(staging, 'images')
  mkdirSync(target, { recursive: true })
  if (options.imageArchive) {
    const archive = resolve(options.imageArchive)
    if (!existsSync(archive)) throw new Error(`镜像归档不存在：${archive}`)
    const info = inspectImageArchive(archive, expected.tag)
    const problems = verifyImageInfo(info, { id: options.imageId, arch: options.arch, fingerprint: expected.fingerprint })
    if (info.os !== 'linux') problems.push(`镜像系统不符：${info.os ?? '未知'}`)
    if (problems.length) throw new Error(`镜像归档与锁定 Runtime 不符：\n${problems.join('\n')}`)
    const fileName = basename(archive)
    copyAsset(archive, join(target, fileName))
    return {
      tag: expected.tag,
      id: info.id,
      fingerprint: expected.fingerprint,
      arch: options.arch,
      archive: `images/${fileName}`,
    }
  }
  if (!options.imageTag) throw new Error('打包镜像需要 --image-archive 或 --image-tag')
  const info = inspectImage(options.imageTag)
  const problems = verifyImageInfo(info, { id: options.imageId, arch: options.arch, fingerprint: expected.fingerprint })
  if (info.os !== 'linux') problems.push(`镜像系统不符：${info.os ?? '未知'}`)
  if (problems.length) throw new Error(`镜像与锁定 Runtime 不符：\n${problems.join('\n')}`)
  const archiveName = `${options.imageTag.replace(/[^A-Za-z0-9_.-]+/g, '_')}.tar`
  saveImage(options.imageTag, join(target, archiveName))
  return {
    tag: expected.tag,
    id: info.id,
    fingerprint: expected.fingerprint,
    arch: options.arch,
    archive: `images/${archiveName}`,
  }
}

export function pack(options: PackOptions): { archive: string; size: number } {
  const programRoot = resolve(options.programRoot)
  const out = resolve(options.out)
  mkdirSync(out, { recursive: true })
  const { commit, dirty } = commitOf(programRoot)
  if (dirty && !options.allowDirty) {
    throw new Error('工作树存在未提交改动；请先提交或显式使用 --allow-dirty')
  }
  if (!options.assetsDir || !existsSync(join(options.assetsDir, 'dsh', 'apps', 'cli', 'lib', 'bin.js'))) {
    throw new Error('离线资源缺少已构建的 DSH CLI：--assets-dir dsh/apps/cli/lib/bin.js')
  }
  const packageName = `harness-engineering-platform-${versionOf(programRoot)}-${commit.slice(0, 12)}-${options.arch}`
  const staging = join(out, '.staging', packageName)
  if (existsSync(staging)) removeTree(staging)
  ensureEmptyDir(staging)
  copyProgram(programRoot, staging, options.assetsDir)
  copyTree(join(programRoot, 'platform', 'deploy', 'install.sh'), join(staging, 'install.sh'))

  const offline = join(staging, 'offline')
  mkdirSync(offline, { recursive: true })
  const runtime: Record<string, RuntimeEntry> = {}
  for (const name of ['node', 'pnpm', 'python', 'dsh', 'docker']) {
    const source = options.assetsDir ? join(options.assetsDir, name) : undefined
    if (source && existsSync(source)) {
      copyAsset(source, join(offline, name))
      runtime[name] = { path: `offline/${name}` }
    }
  }
  if (!existsSync(join(offline, 'node'))) throw new Error('安装包缺少离线 Node 资源：--assets-dir offline/node')
  if (!existsSync(join(offline, 'pnpm'))) throw new Error('安装包缺少离线 pnpm 资源：--assets-dir offline/pnpm')

  const gitSource = options.assetsDir ? join(options.assetsDir, 'git') : undefined
  if (gitSource && existsSync(gitSource)) {
    if (!existsSync(join(gitSource, 'git')) || (existsSync(join(gitSource, 'root')) && !existsSync(join(gitSource, 'root', 'usr', 'bin', 'git')))) {
      throw new Error('Git 离线资源缺少可执行入口或包内二进制')
    }
    copyAsset(gitSource, join(offline, 'git'))
    let version = 'unknown'
    try { version = run(join(offline, 'git', 'git'), ['--version']).trim() } catch { /* 跨架构打包不能在当前主机执行目标架构 Git */ }
    runtime.git = { path: 'offline/git', version, source: 'bundle' }
  } else {
    const collected = collectSystemGit(join(offline, 'git'))
    runtime.git = { path: 'offline/git', version: collected.version, source: collected.source }
  }

  const dataRoot = options.includeData && options.dataRoot ? resolve(options.dataRoot) : undefined
  let dataCheck: ReturnType<typeof assertRealWorkspace> | undefined
  if (dataRoot) {
    dataCheck = assertRealWorkspace(dataRoot, options.allowFixtureData)
    copyData(dataRoot, staging)
  }
  const image = copyImage(options, staging)
  const files = collectEntries(staging)
  const manifest: Manifest = {
    schemaVersion: 1,
    package: {
      name: packageName,
      version: versionOf(programRoot),
      commit,
      dirty,
      arch: options.arch,
      createdAt: new Date().toISOString(),
    },
    source: {
      home: homedir(),
      programRoot,
      dataRoot,
    },
    files,
    runtime,
    image,
    data: dataRoot && dataCheck ? { sensitive: true, kind: dataCheck.kind, workspaceId: dataCheck.workspaceId, skills: dataCheck.skills } : undefined,
    sensitivePaths: options.includeData ? ['data/.local'] : undefined,
  }
  writeManifest(join(staging, 'manifest.json'), manifest)
  const archive = join(out, `${packageName}.tar.gz`)
  tarCreate(staging, archive)
  const checksum = `${sha256File(archive)}  ${basename(archive)}\n`
  writeFileSync(`${archive}.sha256`, checksum, { mode: 0o644 })
  const size = statSync(archive).size
  if (!options.keepStaging) removeTree(join(out, '.staging'))
  return { archive, size }
}
