import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { run } from './fsutil.mts'
import { sha256Text } from './manifest.mts'
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

export function expectedImage(programRoot: string, arch: Arch): { tag: string; fingerprint: string } {
  const script = join(programRoot, 'runtime', 'adapters', 'dsh-container', 'source_contract.py')
  return JSON.parse(run('python3', [script, '--image-identity-for', `linux/${arch}`]))
}

export function inspectImageArchive(archive: string, tag: string): ImageInfo {
  const manifest = JSON.parse(run('tar', ['-xOf', archive, 'manifest.json'])) as Array<{
    Config: string
    RepoTags?: string[]
  }>
  const entries = Array.isArray(manifest) ? manifest.filter(entry => entry.RepoTags?.includes(tag)) : []
  if (entries.length !== 1) throw new Error(`镜像归档必须包含且只包含一个标准标签：${tag}`)
  const configPath = entries[0].Config
  const match = /^(?:blobs\/sha256\/)?([0-9a-f]{64})(?:\.json)?$/.exec(configPath)
  if (!match) throw new Error(`镜像归档配置路径无效：${configPath}`)
  const content = run('tar', ['-xOf', archive, configPath])
  if (sha256Text(content) !== match[1]) throw new Error('镜像归档配置摘要不符')
  const config = JSON.parse(content) as {
    architecture?: string
    os?: string
    config?: { Labels?: Record<string, string> }
  }
  let id = `sha256:${match[1]}`
  try {
    const index = JSON.parse(run('tar', ['-xOf', archive, 'index.json'])) as {
      manifests?: Array<{ digest: string }>
    }
    const readBlob = (digest: string): { config?: { digest?: string }; manifests?: Array<{ digest: string }> } => {
      if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('镜像 OCI 清单摘要格式无效')
      const body = run('tar', ['-xOf', archive, `blobs/sha256/${digest.slice(7)}`])
      if (`sha256:${sha256Text(body)}` !== digest) throw new Error('镜像 OCI 清单摘要不符')
      return JSON.parse(body)
    }
    const matches = (index.manifests ?? []).filter(entry => {
      const image = readBlob(entry.digest)
      return image.config?.digest === id || image.manifests?.some(child => readBlob(child.digest).config?.digest === id)
    })
    if (matches.length !== 1) throw new Error('镜像 OCI 索引无法唯一定位标准镜像')
    id = matches[0].digest
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('index.json')) throw error
  }
  return {
    id,
    arch: config.architecture,
    os: config.os,
    labels: config.config?.Labels ?? {},
    repoTags: entries[0].RepoTags,
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

export function loadVerifiedImage(archive: string, expected: { tag?: string; id?: string; arch?: Arch; fingerprint?: string }): ImageInfo {
  const output = loadImage(archive)
  const targets = [...output.matchAll(/^Loaded image(?: ID)?:\s*(.+)\s*$/gm)].map(match => match[1].trim())
  const loaded = new Map(targets.map(target => {
    const info = inspectImage(target)
    return [info.id, info] as const
  }))
  const target = expected.tag || expected.id
  const info = target ? inspectImage(target) : loaded.size === 1 ? [...loaded.values()][0] : undefined
  if (!info) throw new Error(`镜像归档包含 ${loaded.size} 个可定位镜像；请指定 --image-tag 或 --image-id 后重新打包`)
  if (!loaded.has(info.id)) throw new Error('指定镜像不属于本次导入的归档')
  const problems = verifyImageInfo(info, expected)
  if (problems.length) throw new Error(`导入镜像校验失败：\n${problems.join('\n')}`)
  return info
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
