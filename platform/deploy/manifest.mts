import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type Arch = 'amd64' | 'arm64'
export type EntryType = 'file' | 'symlink'

export interface FileEntry {
  path: string
  type: EntryType
  sha256?: string
  target?: string
  mode?: number
}

export interface RuntimeEntry {
  version?: string
  source?: string
  sha256?: string
  path?: string
}

export interface ImageEntry {
  tag?: string
  id?: string
  fingerprint?: string
  arch?: Arch
  archive: string
}

export interface DataEntry {
  commit?: string
  dirty?: boolean
  sensitive: boolean
  kind?: 'workspace' | 'fixture'
  workspaceId?: string
  skills?: number
}

export interface Manifest {
  schemaVersion: 1
  package: {
    name: string
    version: string
    commit: string
    dirty: boolean
    arch: Arch
    createdAt: string
  }
  source: {
    home: string
    programRoot: string
    dataRoot?: string
    programOrigin?: string
    dataOrigin?: string
  }
  files: FileEntry[]
  runtime: Record<string, RuntimeEntry>
  image?: ImageEntry
  data?: DataEntry
  sensitivePaths?: string[]
}

// 同步调用共用小缓冲，不随文件大小或文件数量重新分配读取内存。
const fileHashBuffer = Buffer.allocUnsafe(64 * 1024)

export function sha256File(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const hash = createHash('sha256')
    let length: number
    while ((length = readSync(fd, fileHashBuffer, 0, fileHashBuffer.length, null)) > 0) {
      hash.update(fileHashBuffer.subarray(0, length))
    }
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function portable(value: string): string {
  return value.split(sep).join('/')
}

function walk(root: string, current: string, entries: FileEntry[], skip: Set<string>): void {
  for (const name of readdirSync(current).sort()) {
    if (skip.has(name)) continue
    const absolute = join(current, name)
    const stat = lstatSync(absolute)
    const path = portable(relative(root, absolute))
    if (stat.isSymbolicLink()) {
      entries.push({ path, type: 'symlink', target: readlinkSync(absolute) })
    } else if (stat.isFile()) {
      entries.push({ path, type: 'file', sha256: sha256File(absolute), mode: stat.mode & 0o777 })
    } else if (stat.isDirectory()) {
      walk(root, absolute, entries, skip)
    }
  }
}

export function collectEntries(root: string, skipNames: string[] = []): FileEntry[] {
  const entries: FileEntry[] = []
  walk(root, root, entries, new Set(skipNames))
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

export function readManifest(path: string): Manifest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  if (value?.schemaVersion !== 1 || !value.package || !Array.isArray(value.files)) {
    throw new Error('manifest.json 格式无效')
  }
  if (!['amd64', 'arm64'].includes(value.package.arch)) throw new Error('manifest 架构无效')
  return value
}

export function writeManifest(path: string, manifest: Manifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 })
}

export function verifyEntries(root: string, expected: FileEntry[], ignoreExtra: string[] = []): string[] {
  const actual = collectEntries(root)
  const expectedMap = new Map(expected.map(entry => [entry.path, entry]))
  const actualMap = new Map(actual.map(entry => [entry.path, entry]))
  const problems: string[] = []
  for (const [path, entry] of expectedMap) {
    const found = actualMap.get(path)
    if (!found) { problems.push(`缺少文件：${path}`); continue }
    if (found.type !== entry.type) problems.push(`类型不符：${path}`)
    else if (entry.type === 'file' && found.sha256 !== entry.sha256) problems.push(`摘要不符：${path}`)
    else if (entry.type === 'file' && entry.mode !== undefined && found.mode !== entry.mode) problems.push(`权限不符：${path}`)
    else if (entry.type === 'symlink' && found.target !== entry.target) problems.push(`链接目标不符：${path}`)
  }
  const ignored = new Set(ignoreExtra)
  for (const path of actualMap.keys()) if (!expectedMap.has(path) && !ignored.has(path)) problems.push(`清单外文件：${path}`)
  return problems
}
