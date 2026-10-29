import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { assertNoBundledGlibc, copyTree, ensureEmptyDir, isGlibcLibrary, removeTree, run, tarCreate, tarList } from './fsutil.mts'
import { collectEntries, sha256File, writeManifest, type Arch, type Manifest, type RuntimeEntry } from './manifest.mts'
import { assertGitBundle, collectSystemGit } from './git.mts'
import { expectedImage, inspectImage, inspectImageArchive, saveImage, verifyImageInfo } from './image.mts'
import { assertRealWorkspace, copyDataDependencies } from './data.mts'
import { snapshotRepository } from './repository.mts'
import { collectPlatformKnowledge } from './knowledge/platform.mts'

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
    try { run('/bin/cp', ['-al', '--', source, target], { timeout: 0 }); return }
    catch { removeTree(target) }
  }
  copyTree(source, target)
}

function copyProgram(programRoot: string, staging: string, assetsDir?: string): void {
  const target = join(staging, 'program')
  snapshotRepository(programRoot, target, join(staging, 'repositories/program.bundle'))
  removeTree(join(target, '.git'))
  if (assetsDir) {
    const preparedPlugin = join(assetsDir, 'program', 'platform', 'plugin', 'node_modules')
    const preparedWeb = join(assetsDir, 'program', 'runtime', 'adapters', 'dsh-web', 'node_modules')
    if (!existsSync(preparedPlugin)) throw new Error(`离线资源缺少平台插件依赖：${preparedPlugin}`)
    if (!existsSync(preparedWeb)) throw new Error(`离线资源缺少 Web 适配器依赖：${preparedWeb}`)
    copyAsset(preparedPlugin, join(target, 'platform', 'plugin', 'node_modules'))
    copyAsset(preparedWeb, join(target, 'runtime', 'adapters', 'dsh-web', 'node_modules'))
  }
}

function copyData(dataRoot: string, staging: string): ReturnType<typeof snapshotRepository> {
  const target = join(staging, 'data')
  const repository = snapshotRepository(dataRoot, target, join(staging, 'repositories/data.bundle'))
  removeTree(join(target, '.git'))
  const credentials = join(dataRoot, '.local/credentials')
  if (existsSync(credentials)) copyTree(credentials, join(target, '.local/credentials'))
  const userPatch = '.local/platform-home/profiles/harness-platform/cordis.patch.yml'
  if (existsSync(join(dataRoot, userPatch))) copyTree(join(dataRoot, userPatch), join(target, userPatch))
  return repository
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
  const tag = options.imageTag ?? expected.tag
  const info = inspectImage(tag)
  const problems = verifyImageInfo(info, { id: options.imageId, arch: options.arch, fingerprint: expected.fingerprint })
  if (info.os !== 'linux') problems.push(`镜像系统不符：${info.os ?? '未知'}`)
  if (problems.length) throw new Error(`镜像与锁定 Runtime 不符：\n${problems.join('\n')}`)
  const archiveName = `${tag.replace(/[^A-Za-z0-9_.-]+/g, '_')}.tar`
  saveImage(tag, join(target, archiveName))
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
  // 所需资源先检查，再建立仓库快照，避免留下半包。

  const offline = join(staging, 'offline')
  mkdirSync(offline, { recursive: true })
  const runtime: Record<string, RuntimeEntry> = {}
  console.error('pack: 正在收集目标架构离线资源')
  for (const name of ['node', 'pnpm', 'python', 'dsh', 'docker']) {
    const source = options.assetsDir ? join(options.assetsDir, name) : undefined
    if (source && existsSync(source)) {
      if (name === 'python') {
        assertNoBundledGlibc(source)
        for (const archive of readdirSync(source).filter(name => name.endsWith('.tar.gz'))) {
          const bundled = tarList(join(source, archive)).find(isGlibcLibrary)
          if (bundled) throw new Error(`Python 离线归档包含 glibc 或动态加载器：${bundled}；请重新收集资源，使用目标系统 glibc`)
        }
      }
      copyAsset(source, join(offline, name))
      runtime[name] = { path: `offline/${name}` }
    }
  }
  if (!existsSync(join(offline, 'node'))) throw new Error('安装包缺少离线 Node 资源：--assets-dir offline/node')
  if (!existsSync(join(offline, 'pnpm'))) throw new Error('安装包缺少离线 pnpm 资源：--assets-dir offline/pnpm')

  const gitSource = options.assetsDir ? join(options.assetsDir, 'git') : undefined
  if (gitSource && existsSync(gitSource)) {
    assertGitBundle(gitSource)
    copyAsset(gitSource, join(offline, 'git'))
    let version = 'unknown'
    if (options.arch === (process.arch === 'arm64' ? 'arm64' : 'amd64')) {
      version = run(join(offline, 'git', 'git'), ['--version']).trim()
    }
    runtime.git = { path: 'offline/git', version, source: 'bundle' }
  } else {
    if (options.arch !== (process.arch === 'arm64' ? 'arm64' : 'amd64')) throw new Error('跨架构打包必须提供目标架构的 git 离线资源')
    const collected = collectSystemGit(join(offline, 'git'))
    runtime.git = { path: 'offline/git', version: collected.version, source: collected.source }
  }

  const dataRoot = options.includeData && options.dataRoot ? resolve(options.dataRoot) : undefined
  let dataCheck: ReturnType<typeof assertRealWorkspace> | undefined
  let dataRepository: ReturnType<typeof snapshotRepository> | undefined
  for (const name of ['python', 'dsh']) if (!existsSync(join(offline, name))) throw new Error(`安装包缺少离线 ${name} 资源`)
  console.error('pack: 正在生成程序和数据仓库快照')
  copyProgram(programRoot, staging, options.assetsDir)
  copyTree(join(staging, 'program/platform/deploy/install.sh'), join(staging, 'install.sh'))
  if (dataRoot) {
    dataCheck = assertRealWorkspace(dataRoot, options.allowFixtureData)
    dataRepository = copyData(dataRoot, staging)
    copyDataDependencies(join(staging, 'data'), options.assetsDir!)
    const knowledge = collectPlatformKnowledge(staging)
    if (knowledge) runtime.knowledge = knowledge
  }
  console.error('pack: 正在核对并收集标准 Runtime 镜像')
  const image = copyImage(options, staging)
  console.error('pack: 正在计算文件清单与摘要；大量依赖文件可能耗时较长')
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
      programOrigin: run('git', ['-C', programRoot, 'remote', 'get-url', 'origin']).trim(),
      dataOrigin: dataRepository?.origin,
    },
    files,
    runtime,
    image,
    data: dataRoot && dataCheck ? { commit: dataRepository?.commit, dirty: dataRepository?.dirty, sensitive: true, kind: dataCheck.kind, workspaceId: dataCheck.workspaceId, skills: dataCheck.skills } : undefined,
    sensitivePaths: options.includeData ? ['data/.local'] : undefined,
  }
  writeManifest(join(staging, 'manifest.json'), manifest)
  const archive = join(out, `${packageName}.tar.gz`)
  console.error('pack: 正在压缩安装包')
  tarCreate(staging, archive)
  console.error('pack: 正在计算安装包校验和')
  const checksum = `${sha256File(archive)}  ${basename(archive)}\n`
  writeFileSync(`${archive}.sha256`, checksum, { mode: 0o644 })
  const size = statSync(archive).size
  if (!options.keepStaging) removeTree(join(out, '.staging'))
  return { archive, size }
}
