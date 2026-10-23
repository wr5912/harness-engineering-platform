import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pack } from './pack.mts'
import { install } from './install.mts'
import { verifyDeployment } from './verify.mts'
import type { Arch } from './manifest.mts'

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)))

type Options = Record<string, string | boolean | undefined>

function parse(argv: string[]): { command: string | undefined; options: Options } {
  const [command, ...rest] = argv
  const options: Options = {}
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index]
    if (!value.startsWith('--')) throw new Error(`无法识别的参数：${value}`)
    const [key, inline] = value.slice(2).split('=', 2)
    if (inline !== undefined) { options[key] = inline; continue }
    const next = rest[index + 1]
    if (next && !next.startsWith('--')) { options[key] = next; index++ }
    else options[key] = true
  }
  return { command, options }
}

function text(options: Options, name: string, fallback?: string): string | undefined {
  const value = options[name]
  if (value === undefined) return fallback
  if (value === true) throw new Error(`选项 --${name} 需要值`)
  return value
}

function flag(options: Options, name: string): boolean {
  return options[name] === true || options[name] === 'true'
}

function validateOptions(command: string, options: Options): void {
  const values: Record<string, string[]> = {
    pack: ['out', 'program-root', 'data-root', 'assets-dir', 'image-archive', 'image-tag', 'image-id', 'image-fingerprint', 'arch'],
    install: ['bundle-root', 'prefix', 'data-root'],
    verify: ['prefix', 'data-root', 'url'],
  }
  const flags: Record<string, string[]> = {
    pack: ['no-image', 'no-data', 'allow-dirty', 'allow-fixture-data', 'keep-staging'],
    install: ['dry-run', 'skip-image', 'skip-prepare', 'strict-paths', 'allow-fixture-data', 'start'],
    verify: [],
  }
  if (!values[command]) throw new Error(`未知命令：${command}`)
  for (const [key, value] of Object.entries(options)) {
    if (['help', 'json', ...flags[command]].includes(key)) {
      if (value !== true && value !== 'true' && value !== 'false') throw new Error(`选项 --${key} 只能使用 true 或 false`)
    } else if (values[command].includes(key)) {
      if (typeof value !== 'string' || !value) throw new Error(`选项 --${key} 需要值`)
    } else throw new Error(`不支持的选项：--${key}`)
  }
}

function archOf(value: string | undefined): Arch {
  const arch = value || (process.arch === 'arm64' ? 'arm64' : 'amd64')
  if (arch !== 'amd64' && arch !== 'arm64') throw new Error('--arch 只能是 amd64 或 arm64')
  return arch
}

function usage(): string {
  return `用法：
  dsh-deploy pack [选项]
    --out <目录>                 输出目录，默认 ./dist
    --program-root <目录>        程序仓库根，默认当前仓库
    --data-root <目录>           完整数据根快照；默认不包含
    --assets-dir <目录>          离线资源目录（node/pnpm/git/dsh/program 依赖）
    --image-archive <tar>        预构建镜像归档；与 --image-tag 二选一
    --image-tag <tag>            从本机 Docker 导出镜像
    --image-id <sha256:...>      期望镜像 ID
    --image-fingerprint <值>     期望构建指纹
    --arch amd64|arm64           包架构，默认当前主机
    --no-image / --no-data       不包含镜像或数据根
    --allow-dirty                允许未提交工作树
    --allow-fixture-data         允许夹具数据根（仅测试；真实部署默认拒绝）
    --keep-staging               保留暂存目录

  dsh-deploy verify [选项]
    --prefix <目录>              程序安装目录
    --data-root <目录>           数据根
    --url <地址>                 可选：检查登录页 HTTP

  dsh-deploy install [选项]
    --bundle-root <目录>         解包后的安装包根目录（install.sh 会传入）
    --prefix <目录>              程序安装目录，默认 ~/work/harness-engineering-platform
    --data-root <目录>           数据根，默认 ~/harness-engineering-platform-data
    --dry-run                    只校验和展示计划，不写入
    --skip-image                 不导入镜像
    --skip-prepare               不执行 prepare（仅用于诊断/分步安装）
    --strict-paths               路径映射后仍有旧路径时失败
    --allow-fixture-data         允许夹具数据根（仅测试；真实部署默认拒绝）
    --start                      安装完成后前台启动平台

安装包必须在相同架构主机上生成和使用；AMD64 与 ARM64 不混用。`
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const { command, options } = parse(argv)
    if (!command || command === '--help' || flag(options, 'help')) { console.log(usage()); return 0 }
    validateOptions(command, options)
    if (command === 'pack') {
      const result = pack({
        programRoot: resolve(text(options, 'program-root', REPO) as string),
        out: resolve(text(options, 'out', join(REPO, 'dist')) as string),
        dataRoot: text(options, 'data-root'),
        assetsDir: text(options, 'assets-dir'),
        imageArchive: text(options, 'image-archive'),
        imageTag: text(options, 'image-tag'),
        imageId: text(options, 'image-id'),
        imageFingerprint: text(options, 'image-fingerprint'),
        includeImage: !flag(options, 'no-image'),
        includeData: Boolean(text(options, 'data-root')) && !flag(options, 'no-data'),
        allowDirty: flag(options, 'allow-dirty'),
        allowFixtureData: flag(options, 'allow-fixture-data'),
        keepStaging: flag(options, 'keep-staging'),
        arch: archOf(text(options, 'arch')),
      })
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    if (command === 'verify') {
      const prefix = text(options, 'prefix', join(homedir(), 'work', 'harness-engineering-platform')) as string
      const dataRoot = text(options, 'data-root', join(homedir(), 'harness-engineering-platform-data')) as string
      const report = await verifyDeployment({ prefix, dataRoot, url: text(options, 'url') })
      if (flag(options, 'json')) console.log(JSON.stringify(report, null, 2))
      else for (const check of report.checks) console.log(`${check.status === 'ok' ? 'OK' : 'FAIL'} ${check.id}: ${check.detail}`)
      return report.ok ? 0 : 1
    }
    if (command === 'install') {
      const bundleRoot = text(options, 'bundle-root')
      if (!bundleRoot) throw new Error('install 需要 --bundle-root（install.sh 会自动传入）')
      const report = install({
        bundleRoot: resolve(bundleRoot),
        prefix: resolve(text(options, 'prefix', join(homedir(), 'work', 'harness-engineering-platform')) as string),
        dataRoot: resolve(text(options, 'data-root', join(homedir(), 'harness-engineering-platform-data')) as string),
        skipImage: flag(options, 'skip-image'),
        skipPrepare: flag(options, 'skip-prepare'),
        allowFixtureData: flag(options, 'allow-fixture-data'),
        strictPaths: flag(options, 'strict-paths'),
        start: flag(options, 'start'),
        dryRun: flag(options, 'dry-run'),
        json: flag(options, 'json'),
      })
      if (flag(options, 'json')) console.log(JSON.stringify(report, null, 2))
      else {
        console.log(`状态：${report.status}`)
        console.log(`程序：${report.prefix}`)
        console.log(`数据根：${report.dataRoot}`)
        console.log(`架构：${report.arch}`)
        if (Object.keys(report.runtime).length) console.log(`运行时：${JSON.stringify(report.runtime)}`)
        if (report.image) console.log(`镜像：${report.image.tag ?? report.image.id ?? ''} loaded=${report.image.loaded}`)
        if (report.rewritten.length) console.log(`路径已重写：${report.rewritten.length} 个文件`)
        if (report.oldReferences.length) console.warn(`仍存在旧路径引用：${report.oldReferences.length} 处`)
        if (report.pendingInstances.length) console.warn(`待重建实例：${report.pendingInstances.join(', ')}`)
        for (const warning of report.warnings) console.warn(`警告：${warning}`)
        if (report.sensitive) console.warn('安装包包含敏感数据根；请限制分发范围。')
      }
      return 0
    }
    throw new Error(`未知命令：${command}`)
  } catch (error) {
    console.error(`dsh-deploy: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
