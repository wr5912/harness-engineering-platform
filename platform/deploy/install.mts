import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { copyTree } from './fsutil.mts'
import { readManifest, verifyEntries } from './manifest.mts'
import { rewriteDeploymentAddress, rewriteKnownPaths, scanKnownOldPaths } from './paths.mts'
import { installRuntime } from './runtime.mts'
import { dockerAvailable, loadVerifiedImage } from './image.mts'
import { assertRealWorkspace } from './data.mts'
import { restoreRepository } from './repository.mts'
import { prepareDeploymentFirewall } from './firewall.mts'

export interface InstallOptions {
  bundleRoot: string
  prefix: string
  dataRoot: string
  host?: string
  port: number
  gatewayPort?: number
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
  if (manifest.image && (!manifest.image.tag || !manifest.image.id || !manifest.image.fingerprint || manifest.image.arch !== manifest.package.arch)) {
    throw new Error('安装包镜像身份不完整或架构不符；请使用标准 Runtime 镜像重新打包')
  }
  if (existsSync(prefix) && readdirSync(prefix).length > 0) throw new Error(`目标程序目录已存在且非空：${prefix}`)
  if (existsSync(dataRoot) && readdirSync(dataRoot).length > 0) throw new Error(`目标数据根已存在且非空：${dataRoot}`)
  if (prefix === dataRoot || prefix.startsWith(dataRoot + sep) || dataRoot.startsWith(prefix + sep)) throw new Error('程序目录和数据根必须相互独立')

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


  const targets = [prefix, ...(manifest.data ? [dataRoot] : [])].map(path => ({ path, existed: existsSync(path) }))
  let env: NodeJS.ProcessEnv
  try {
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
    if (options.host && rewriteDeploymentAddress(dataRoot, options.host, options.port, options.gatewayPort)) {
      report.rewritten.push(join(dataRoot, 'config', 'business-access.json'))
    }
    report.pendingInstances = instanceNames(dataRoot)

    const runtime = installRuntime(bundleRoot, prefix, dataRoot)
    mkdirSync(join(prefix, '.local'), { recursive: true })
    writeFileSync(join(prefix, '.local/installation.json'), JSON.stringify(manifest), { mode: 0o600 })
    report.runtime = runtime.versions
    warnings.push(...runtime.warnings)

    env = runtime.env

    if (manifest.image && !options.skipImage) {
      if (!dockerAvailable()) {
        throw new Error('Docker 不可用；无法导入标准 Runtime 镜像。请启动 Docker 后重试，或显式使用 --skip-image')
      } else {
        const info = loadVerifiedImage(join(bundleRoot, manifest.image.archive), manifest.image)
        report.image = { tag: manifest.image.tag, id: info.id, loaded: true }
      }
    } else if (manifest.image && options.skipImage) {
      warnings.push('按要求跳过镜像导入')
    }

    const previousPath = process.env.PATH
    process.env.PATH = env.PATH
    try {
      if (manifest.source.programOrigin) restoreRepository(prefix, join(bundleRoot, 'repositories/program.bundle'), manifest.package.commit, manifest.source.programOrigin)
      if (manifest.data?.commit && manifest.source.dataOrigin) restoreRepository(dataRoot, join(bundleRoot, 'repositories/data.bundle'), manifest.data.commit, manifest.source.dataOrigin)
    } finally { process.env.PATH = previousPath }
    if (options.skipPrepare) {
      warnings.push('按要求跳过 prepare；平台尚未构建，不能直接启动')
    } else {
      const prepared = spawnSync(join(prefix, 'platform', 'dsh-platform'), ['prepare', '--offline'], {
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
  } catch (error) {
    for (const target of targets) {
      rmSync(target.path, { recursive: true, force: true })
      if (target.existed) mkdirSync(target.path, { recursive: true })
    }
    throw error
  }

  if (options.start) {
    if (options.host) {
      const gatewayPath = join(dataRoot, 'config/business-access.json')
      const access = existsSync(gatewayPath) ? JSON.parse(readFileSync(gatewayPath, 'utf8')) : undefined
      try {
        warnings.push(prepareDeploymentFirewall(options.host, [options.port,
          ...(access?.enabled === true && access.gateway ? [access.gateway.port] : [])]))
      } catch (error) {
        throw new Error(`安装目录已保留；${error instanceof Error ? error.message : '防火墙配置失败'}`)
      }
    }
    const args = options.host ? ['--host', options.host, '--port', String(options.port)] : []
    const started = spawnSync(join(prefix, 'platform', 'dsh-platform'), ['start', ...args], { cwd: prefix, env, stdio: 'inherit' })
    if (started.status !== 0) throw new Error(`平台启动失败（退出码 ${started.status}）；安装目录已保留，可重试 ${prefix}/platform/dsh-platform start`)
  }
  return report
}
