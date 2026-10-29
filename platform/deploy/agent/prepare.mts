import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { collectEntries } from '../manifest.mts'
import { expectedImage, inspectImage, inspectImageArchive, verifyImageInfo } from '../image.mts'
import { copyTree } from '../fsutil.mts'
import { inspectAgentSnapshot, assertDependencyArchitecture, dependencyEntries } from './snapshot.mts'
import { agentCommand } from './process.mts'
import type { AgentPackageHooks, AgentPackageInput, AgentResourceManifest } from './types.mts'

export function defaultAgentResourcesDir(input: Pick<AgentPackageInput, 'programRoot' | 'arch'>): string {
  return join(resolve(input.programRoot), '.local/deploy-assets', input.arch)
}

export function inspectAgentResources(input: AgentPackageInput): { directory: string; manifest?: AgentResourceManifest; issues: Array<{ code: string; message: string }> } {
  const directory = resolve(input.resourcesDir ?? defaultAgentResourcesDir(input)), issues: Array<{ code: string; message: string }> = []
  const manifestPath = join(directory, 'resources.json')
  let manifest: AgentResourceManifest | undefined
  try {
    if (!existsSync(manifestPath)) throw new Error('目标架构运行资源尚未准备')
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest?.schemaVersion !== 1 || manifest.arch !== input.arch || !manifest.image?.archive || !Array.isArray(manifest.docker?.files)) throw new Error('目标架构资源清单无效')
    const expected = expectedImage(input.programRoot, input.arch)
    if (manifest.image.tag !== expected.tag || manifest.image.fingerprint !== expected.fingerprint) throw new Error('目标架构资源与锁定 DSH Runtime 不一致，请重新准备')
    if (!existsSync(join(directory, manifest.image.archive))) throw new Error('目标架构资源缺少标准镜像归档')
    if (!manifest.docker.files.length || manifest.docker.files.some(file => !existsSync(join(directory, 'docker', file.path)))) throw new Error('目标架构资源缺少 Docker 或 Compose 离线文件')
  } catch (error) { issues.push({ code: 'resources_missing', message: error instanceof Error ? error.message : '运行资源检查失败' }) }
  return { directory, manifest, issues }
}

async function download(url: string, target: string, hooks: AgentPackageHooks): Promise<void> {
  hooks.signal?.throwIfAborted()
  mkdirSync(dirname(target), { recursive: true })
  // 在线准备机使用 curl 的既有代理/证书设置；仅限制建连，不限制大文件传输总时长。
  await agentCommand('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '20', '--output', target, url], { signal: hooks.signal })
  chmodSync(target, 0o600)
}

function elfArchitecture(path: string, arch: string): void {
  const bytes = readFileSync(path)
  if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes.readUInt16LE(18) !== (arch === 'arm64' ? 183 : 62)) throw new Error('Docker／Compose 二进制与目标架构不一致')
}

export interface PrepareAgentInput extends AgentPackageInput { imageArchive?: string; dockerAssetsDir?: string }

/** 只准备选定版本的依赖，另一架构需要导入该架构在线准备机生成的资源。 */
export async function prepareAgentResources(input: PrepareAgentInput, hooks: AgentPackageHooks = {}): Promise<{ resourcesDir: string; manifest: AgentResourceManifest }> {
  hooks.signal?.throwIfAborted()
  const target = resolve(input.resourcesDir ?? defaultAgentResourcesDir(input))
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('运行资源目标必须是普通目录')
    if (readdirSync(target).length) {
      let current: AgentResourceManifest | undefined
      try { current = JSON.parse(readFileSync(join(target, 'resources.json'), 'utf8')) } catch { /* 非本工具生成的目录不能替换。 */ }
      if (current?.schemaVersion !== 1 || current.arch !== input.arch) throw new Error('目标目录不是该架构的运行资源缓存；未覆盖现有内容，请选择空目录')
    }
  }
  mkdirSync(dirname(target), { recursive: true })
  const staging = mkdtempSync(join(dirname(target), '.prepare-'))
  try {
    const expected = expectedImage(input.programRoot, input.arch)
    hooks.onProgress?.({ stage: 'resources', message: '正在准备锁定的标准 DSH 镜像' })
    const imageArchive = 'images/dsh-runtime.tar'
    mkdirSync(join(staging, 'images'), { recursive: true })
    let info
    if (input.imageArchive) {
      info = inspectImageArchive(input.imageArchive, expected.tag)
      await agentCommand('/bin/cp', ['--', input.imageArchive, join(staging, imageArchive)], { signal: hooks.signal })
    } else {
      if (input.arch !== (process.arch === 'arm64' ? 'arm64' : 'amd64')) throw new Error('另一架构资源须在对应架构在线准备机生成，或通过 --image-archive 和 --docker-assets 导入；不会混用当前主机镜像')
      info = inspectImage(expected.tag)
      const problems = verifyImageInfo(info, { arch: input.arch, fingerprint: expected.fingerprint })
      if (problems.length) throw new Error(`标准镜像不可用：${problems.join('；')}`)
      await agentCommand('docker', ['save', '-o', join(staging, imageArchive), expected.tag], { signal: hooks.signal })
    }
    const imageProblems = verifyImageInfo(info, { arch: input.arch, fingerprint: expected.fingerprint })
    if (info.os !== 'linux') imageProblems.push('标准镜像不是 Linux 镜像')
    if (imageProblems.length) throw new Error(`标准镜像资源不匹配：${imageProblems.join('；')}`)

    hooks.onProgress?.({ stage: 'resources', message: '正在准备 Docker 和 Compose 离线资源' })
    const docker = join(staging, 'docker')
    mkdirSync(docker)
    let dockerVersion: string | undefined, composeVersion: string | undefined
    if (input.dockerAssetsDir) copyTree(resolve(input.dockerAssetsDir), docker)
    else {
      dockerVersion = (await agentCommand('docker', ['version', '--format', '{{.Client.Version}}'], { signal: hooks.signal })).trim()
      composeVersion = (await agentCommand('docker', ['compose', 'version', '--short'], { signal: hooks.signal })).trim().replace(/^v/, '')
      if (!/^\d+\.\d+\.\d+$/.test(dockerVersion) || !/^\d+\.\d+\.\d+$/.test(composeVersion)) throw new Error('无法解析当前 Docker／Compose 官方版本，请指定 --docker-assets')
      const machine = input.arch === 'arm64' ? 'aarch64' : 'x86_64'
      await download(`https://download.docker.com/linux/static/stable/${machine}/docker-${dockerVersion}.tgz`, join(docker, `docker-${dockerVersion}.tgz`), hooks)
      await download(`https://github.com/docker/compose/releases/download/v${composeVersion}/docker-compose-linux-${machine}`, join(docker, 'docker-compose'), hooks)
    }
    const archives = collectEntries(docker).filter(file => /^docker-[^/]+\.tgz$/.test(file.path))
    if (archives.length !== 1 || !existsSync(join(docker, 'docker-compose'))) throw new Error('Docker 离线资源必须包含一个 docker-*.tgz 和 docker-compose')
    const extracted = join(staging, '.docker-check')
    mkdirSync(extracted)
    await agentCommand('tar', ['-xzf', join(docker, archives[0].path), '-C', extracted, 'docker/docker', 'docker/dockerd'], { signal: hooks.signal })
    elfArchitecture(join(extracted, 'docker/docker'), input.arch)
    elfArchitecture(join(extracted, 'docker/dockerd'), input.arch)
    elfArchitecture(join(docker, 'docker-compose'), input.arch)
    chmodSync(join(docker, 'docker-compose'), 0o755)
    rmSync(extracted, { recursive: true })

    const snapshot = inspectAgentSnapshot({ ...input, resourcesDir: input.resourcesDir ?? target })
    const dependencies: AgentResourceManifest['dependencies'] = []
    for (const dependency of snapshot.dependencies) {
      hooks.signal?.throwIfAborted()
      hooks.onProgress?.({ stage: 'dependencies', message: `正在收集业务依赖 ${dependency.name}` })
      if (!dependency.ready || !dependency.modulesPath) throw new Error(`业务依赖尚未准备：${dependency.path}；${dependency.reason ?? '请在目标架构按该包锁文件安装依赖后重试'}`)
      assertDependencyArchitecture(dependency.modulesPath, input.arch)
      const destination = join(staging, 'dependencies', dependency.path, dependency.kind === 'python' ? 'site-packages' : 'node_modules')
      mkdirSync(dirname(destination), { recursive: true })
      await agentCommand('/bin/cp', ['-a', '--no-preserve=ownership', '--', dependency.modulesPath, destination], { signal: hooks.signal })
      dependencies.push({ path: dependency.path, lockSha256: dependency.lockSha256, files: dependencyEntries(destination) })
    }
    const manifest: AgentResourceManifest = { schemaVersion: 1, arch: input.arch, createdAt: new Date().toISOString(),
      image: { tag: expected.tag, id: info.id, fingerprint: expected.fingerprint, arch: input.arch, archive: imageArchive },
      docker: { version: dockerVersion, composeVersion, files: collectEntries(docker) }, dependencies }
    writeFileSync(join(staging, 'resources.json'), JSON.stringify(manifest, null, 2) + '\n')
    hooks.signal?.throwIfAborted()
    if (existsSync(target)) {
      const previous = `${target}.previous-${process.pid}`
      if (existsSync(previous)) throw new Error('运行资源备份目录已存在，请先核对上次准备结果')
      renameSync(target, previous)
      try { renameSync(staging, target) } catch (error) { renameSync(previous, target); throw error }
      rmSync(previous, { recursive: true, force: true })
    } else renameSync(staging, target)
    return { resourcesDir: target, manifest }
  } finally { if (existsSync(staging)) rmSync(staging, { recursive: true, force: true }) }
}
