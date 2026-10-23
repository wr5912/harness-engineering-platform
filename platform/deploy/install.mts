import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { copyTree } from './fsutil.mts'
import { readManifest, verifyEntries } from './manifest.mts'
import { rewriteKnownPaths, scanKnownOldPaths } from './paths.mts'
import { installRuntime } from './runtime.mts'
import { dockerAvailable, loadImage, inspectImage, verifyImageInfo } from './image.mts'
import { assertRealWorkspace } from './data.mts'

export interface InstallOptions {
  bundleRoot: string
  prefix: string
  dataRoot: string
  skipImage: boolean
  skipPrepare: boolean
  allowFixtureData: boolean
  strictPaths: boolean
  start: boolean
  dryRun: boolean
  json: boolean
}

export interface InstallReport {
  status: 'planned' | 'installed'
  prefix: string
  dataRoot: string
  arch: string
  runtime: Record<string, string>
  warnings: string[]
  rewritten: string[]
  oldReferences: Array<{ file: string; pattern: string }>
  image?: { tag?: string; id?: string; loaded: boolean }
  prepare: 'skipped' | 'ok'
  pendingInstances: string[]
  sensitive: boolean
}

function instanceNames(dataRoot: string): string[] {
  const root = join(dataRoot, '.local', 'instances')
  if (!existsSync(root)) return []
  return readdirSync(root).sort()
}

export function install(options: InstallOptions): InstallReport {
  const bundleRoot = resolve(options.bundleRoot)
  const prefix = resolve(options.prefix)
  const dataRoot = resolve(options.dataRoot)
  const manifest = readManifest(join(bundleRoot, 'manifest.json'))
  if (manifest.package.arch !== (process.arch === 'arm64' ? 'arm64' : 'amd64')) {
    throw new Error(`安装包架构为 ${manifest.package.arch}，当前主机为 ${process.arch}；请在对应架构重新打包`)
  }
  const problems = verifyEntries(bundleRoot, manifest.files, ['manifest.json'])
  if (problems.length) throw new Error(`安装包校验失败：\n${problems.slice(0, 20).join('\n')}`)
  if (existsSync(prefix) && readdirSync(prefix).length > 0) throw new Error(`目标程序目录已存在且非空：${prefix}`)
  if (existsSync(dataRoot) && readdirSync(dataRoot).length > 0) throw new Error(`目标数据根已存在且非空：${dataRoot}`)

  const warnings: string[] = []
  const report: InstallReport = {
    status: options.dryRun ? 'planned' : 'installed',
    prefix,
    dataRoot,
    arch: manifest.package.arch,
    runtime: {},
    warnings,
    rewritten: [],
    oldReferences: [],
    image: manifest.image ? { tag: manifest.image.tag, id: manifest.image.id, loaded: false } : undefined,
    prepare: 'skipped',
    pendingInstances: [],
    sensitive: Boolean(manifest.data?.sensitive || manifest.sensitivePaths?.length),
  }
  if (manifest.data) {
    const sourceData = join(bundleRoot, 'data')
    if (!existsSync(sourceData)) throw new Error('安装包声明包含数据根，但缺少 data/ 目录')
    assertRealWorkspace(sourceData, options.allowFixtureData)
  }
  if (options.dryRun) return report

  copyTree(join(bundleRoot, 'program'), prefix)
  let dataCheck: ReturnType<typeof assertRealWorkspace> | undefined
  if (manifest.data) {
    if (!existsSync(join(bundleRoot, 'data'))) throw new Error('安装包声明包含数据根，但缺少 data/ 目录')
    copyTree(join(bundleRoot, 'data'), dataRoot)
    dataCheck = assertRealWorkspace(dataRoot, options.allowFixtureData)
    if (dataCheck.kind === 'fixture') warnings.push('安装的是夹具数据根；管理助手工作区和管理 Skill 不完整')
  }
  if (manifest.source.programRoot !== prefix || manifest.source.dataRoot !== dataRoot || manifest.source.home !== homedir()) {
    const mappings = [{ from: manifest.source.home, to: homedir() }]
    if (manifest.source.programRoot) mappings.push({ from: manifest.source.programRoot, to: prefix })
    if (manifest.source.dataRoot) mappings.push({ from: manifest.source.dataRoot, to: dataRoot })
    const changedMappings = mappings.filter(mapping => mapping.from !== mapping.to)
    const rewritten = rewriteKnownPaths(dataRoot, mappings)
    report.rewritten = rewritten.changed
    report.oldReferences = rewritten.oldReferences
    const remaining = scanKnownOldPaths(dataRoot, changedMappings.map(mapping => mapping.from))
    if (remaining.length && options.strictPaths) throw new Error(`数据根仍包含旧路径：\n${remaining.map(item => item.file + ':' + item.pattern).join('\n')}`)
    report.oldReferences.push(...remaining)
  }
  report.pendingInstances = instanceNames(dataRoot)

  const runtime = installRuntime(bundleRoot, prefix, dataRoot)
  report.runtime = runtime.versions
  warnings.push(...runtime.warnings)

  if (manifest.image && !options.skipImage) {
    if (!dockerAvailable()) {
      warnings.push('Docker 不可用；镜像未导入，业务实例不可用')
    } else {
      const output = loadImage(join(bundleRoot, manifest.image.archive))
      const loaded = output.match(/Loaded image ID: (sha256:[0-9a-f]{64})/)?.[1]
      const target = manifest.image.tag || manifest.image.id || loaded
      if (!target) throw new Error('镜像已导入但无法确定镜像身份')
      const info = inspectImage(target)
      const imageProblems = verifyImageInfo(info, { id: manifest.image.id, arch: manifest.image.arch, fingerprint: manifest.image.fingerprint })
      if (imageProblems.length) throw new Error(`导入镜像校验失败：\n${imageProblems.join('\n')}`)
      report.image = { tag: manifest.image.tag, id: manifest.image.id, loaded: true }
    }
  } else if (manifest.image && options.skipImage) {
    warnings.push('按要求跳过镜像导入')
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [join(prefix, 'runtime', 'node', 'bin'), join(prefix, 'runtime', 'pnpm', 'bin'), join(prefix, 'runtime', 'git'), join(prefix, 'bin'), process.env.PATH || ''].join(':'),
    HARNESS_PROGRAM_ROOT: prefix,
    HARNESS_ASSET_ROOT: dataRoot,
    HARNESS_PYTHON: runtime.python,
  }
  if (existsSync(join(bundleRoot, 'offline', 'python', 'site'))) {
    env.PYTHONPATH = [join(bundleRoot, 'offline', 'python', 'site'), env.PYTHONPATH].filter(Boolean).join(':')
  }
  if (options.skipPrepare) {
    warnings.push('按要求跳过 prepare；平台尚未构建，不能直接启动')
  } else {
    const prepared = spawnSync(runtime.python, [join(prefix, 'platform', 'dsh-platform'), 'prepare', '--offline'], {
      cwd: prefix,
      env,
      stdio: 'inherit',
    })
    if (prepared.status !== 0) throw new Error(`离线 prepare 失败（退出码 ${prepared.status}）`)
    report.prepare = 'ok'
    if (dataCheck?.kind === 'workspace') {
      const patch = join(dataRoot, '.local', 'platform-home', 'profiles', 'harness-platform', 'harness-platform.patch.yml')
      if (!existsSync(patch) || !readFileSync(patch, 'utf8').includes(join(dataRoot, '.agents', 'skills'))) {
        throw new Error('平台 Profile 未装载数据工作区的 .agents/skills；管理助手工作区不完整')
      }
      const locator = join(homedir(), '.config', 'harness-engineering-platform', 'workspace.json')
      if (!existsSync(locator)) {
        mkdirSync(join(homedir(), '.config', 'harness-engineering-platform'), { recursive: true })
        writeFileSync(locator, JSON.stringify({ assetRoot: dataRoot }, null, 2) + '\n', { mode: 0o600 })
      }
    }
  }

  if (options.start) {
    const started = spawnSync(join(prefix, 'bin', 'hep-start'), [], { cwd: prefix, env, stdio: 'inherit' })
    if (started.status !== 0) throw new Error(`平台启动失败（退出码 ${started.status}）`)
  }
  return report
}
