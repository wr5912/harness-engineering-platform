import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import { run } from './fsutil.mts'
import type { Arch } from './manifest.mts'

export interface ImageInfo {
  id: string
  arch?: string
  os?: string
  labels?: Record<string, string>
  repoTags?: string[]
}

export function dockerAvailable(): boolean {
  try {
    run('docker', ['version', '--format', '{{.Server.Arch}}'], { timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

export function inspectImage(target: string): ImageInfo {
  const output = run('docker', ['image', 'inspect', target])
  const values = JSON.parse(output) as Array<{
    Id: string
    Architecture?: string
    Os?: string
    Config?: { Labels?: Record<string, string> }
    RepoTags?: string[]
  }>
  if (!Array.isArray(values) || values.length !== 1) throw new Error(`无法唯一定位镜像：${target}`)
  const value = values[0]
  return {
    id: value.Id,
    arch: value.Architecture,
    os: value.Os,
    labels: value.Config?.Labels ?? {},
    repoTags: value.RepoTags ?? [],
  }
}

export function saveImage(target: string, archive: string): ImageInfo {
  const info = inspectImage(target)
  run('docker', ['save', '-o', archive, target])
  if (!existsSync(archive)) throw new Error(`docker save 未生成镜像归档：${archive}`)
  return info
}

export function loadImage(archive: string): string {
  return run('docker', ['load', '-i', archive])
}

export function expectedArch(arch: Arch): string {
  return arch === 'arm64' ? 'arm64' : 'amd64'
}

export function verifyImageInfo(info: ImageInfo, expected: { id?: string; arch?: Arch; fingerprint?: string }): string[] {
  const problems: string[] = []
  if (expected.id && info.id !== expected.id) problems.push(`镜像 ID 不符：期望 ${expected.id}，实际 ${info.id}`)
  if (expected.arch && info.arch !== expectedArch(expected.arch)) problems.push(`镜像架构不符：期望 ${expected.arch}，实际 ${info.arch ?? '未知'}`)
  if (expected.fingerprint) {
    const actual = info.labels?.['org.ai-agent-harness.dsh.image-build-fingerprint']
    if (actual !== expected.fingerprint) problems.push(`镜像构建指纹不符：期望 ${expected.fingerprint}，实际 ${actual ?? '缺失'}`)
  }
  return problems
}

export function imageArchiveName(tag: string | undefined, archive: string): string {
  return tag ? `${tag.replace(/[^A-Za-z0-9_.-]+/g, '_')}.tar` : basename(archive)
}
