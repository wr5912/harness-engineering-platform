import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { expectedImage, inspectImage, inspectImageArchive, verifyImageInfo } from '../image.mts'
import { inspectAgentSnapshot } from './snapshot.mts'
import { runtimeDependencies } from './dependencies.mts'
import { agentCommand } from './process.mts'
import type { AgentPackageHooks, AgentPackageInput, AgentResourceManifest } from './types.mts'

export function defaultAgentResourcesDir(input: Pick<AgentPackageInput, 'programRoot' | 'arch'>): string {
  return join(resolve(input.programRoot), '.local/deploy-assets', input.arch)
}
export function inspectAgentResources(input: AgentPackageInput): { directory: string; manifest?: AgentResourceManifest; issues: Array<{ code: string; message: string }> } {
  const directory = resolve(input.resourcesDir ?? defaultAgentResourcesDir(input)), issues: Array<{ code: string; message: string }> = []
  let manifest: AgentResourceManifest | undefined
  try {
    if (!existsSync(join(directory, 'resources.json'))) throw new Error('目标架构运行资源尚未准备')
    manifest = JSON.parse(readFileSync(join(directory, 'resources.json'), 'utf8'))
    if (![1, 2].includes(manifest?.schemaVersion ?? 0)) throw new Error(`资源清单无效：${directory}/resources.json 的 schemaVersion 期望 1 或 2，实际 ${manifest?.schemaVersion ?? '缺失'}`)
    if (manifest?.arch !== input.arch) throw new Error(`资源清单无效：${directory}/resources.json 的 arch 期望 ${input.arch}，实际 ${manifest?.arch ?? '缺失'}；请准备匹配架构的资源`)
    if (!manifest.image?.archive) throw new Error(`资源清单无效：${directory}/resources.json 缺少 image.archive；请重新准备资源`)
    for (const key of ['id', 'fingerprint'] as const) if (!/^sha256:[0-9a-f]{64}$/.test(manifest.image[key] ?? '')) throw new Error(`资源清单 image.${key} 无效：期望 sha256: 加 64 位小写十六进制，实际 ${manifest.image[key] ?? '缺失'}；请重新准备标准 Runtime 镜像`)
    const expected = expectedImage(input.programRoot, input.arch)
    for (const key of ['tag', 'fingerprint'] as const) if (manifest.image[key] !== expected[key]) throw new Error(`资源清单 image.${key} 与标准 Runtime 不一致：期望 ${expected[key]}，实际 ${manifest.image[key] ?? '缺失'}；请重新准备资源`)
    if (!existsSync(join(directory, manifest.image.archive))) throw new Error(`目标架构资源缺少标准镜像归档：${join(directory, manifest.image.archive)}`)
  } catch (error) { issues.push({ code: 'resources_missing', message: error instanceof Error ? error.message : '运行资源检查失败' }) }
  return { directory, manifest, issues }
}
export interface PrepareAgentInput extends AgentPackageInput { imageArchive?: string }

/** 目标机预装 Docker；准备机只归档已含全部依赖的共享标准镜像。 */
export async function prepareAgentResources(input: PrepareAgentInput, hooks: AgentPackageHooks = {}): Promise<{ resourcesDir: string; manifest: AgentResourceManifest }> {
  hooks.signal?.throwIfAborted()
  const target = resolve(input.resourcesDir ?? defaultAgentResourcesDir(input))
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) throw new Error('运行资源目标必须是普通目录')
    if (readdirSync(target).length) {
      let current: AgentResourceManifest | undefined
      try { current = JSON.parse(readFileSync(join(target, 'resources.json'), 'utf8')) } catch { /* 保留非本工具目录。 */ }
      if (![1, 2].includes(current?.schemaVersion ?? 0) || current?.arch !== input.arch) throw new Error('目标目录不是该架构的运行资源缓存；请选择空目录')
    }
  }
  const snapshot = inspectAgentSnapshot(input)
  const missing = runtimeDependencies(input, snapshot).filter(item => !item.ready)
  if (missing.length) throw new Error(missing.map(item => `${item.name}：${item.reason}`).join('；'))
  mkdirSync(dirname(target), { recursive: true })
  const staging = mkdtempSync(join(dirname(target), '.prepare-'))
  try {
    const expected = expectedImage(input.programRoot, input.arch)
    hooks.onProgress?.({ stage: 'resources', message: '正在准备包含通用适配器与依赖的标准 DSH 镜像' })
    const imageArchive = 'images/dsh-runtime.tar'
    mkdirSync(join(staging, 'images'), { recursive: true })
    let info
    if (input.imageArchive) {
      info = inspectImageArchive(input.imageArchive, expected.tag)
      await agentCommand('/bin/cp', ['--', input.imageArchive, join(staging, imageArchive)], { signal: hooks.signal })
    } else {
      if (input.arch !== (process.arch === 'arm64' ? 'arm64' : 'amd64')) throw new Error('另一架构资源须在对应在线准备机生成，或通过 --image-archive 导入')
      info = inspectImage(expected.tag)
      const problems = verifyImageInfo(info, { arch: input.arch, fingerprint: expected.fingerprint })
      if (problems.length) throw new Error(`标准镜像不可用：${problems.join('；')}`)
      await agentCommand('docker', ['save', '-o', join(staging, imageArchive), expected.tag], { signal: hooks.signal })
    }
    const problems = verifyImageInfo(info, { arch: input.arch, fingerprint: expected.fingerprint })
    if (info.os !== 'linux') problems.push('标准镜像不是 Linux 镜像')
    if (problems.length) throw new Error(`标准镜像资源不匹配：${problems.join('；')}`)
    const manifest: AgentResourceManifest = { schemaVersion: 2, arch: input.arch, createdAt: new Date().toISOString(),
      image: { tag: expected.tag, id: info.id, fingerprint: expected.fingerprint, arch: input.arch, archive: imageArchive },
      dependencies: [] }
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
  } finally { rmSync(staging, { recursive: true, force: true }) }
}
