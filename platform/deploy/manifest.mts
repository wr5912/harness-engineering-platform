import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from 'node:fs'
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
  }
  files: FileEntry[]
  runtime: Record<string, RuntimeEntry>
  image?: ImageEntry
  data?: DataEntry
  sensitivePaths?: string[]
}

export function sha256File(path: string): string {
  // Node readFileSync 有 2GiB 上限；安装包本身可能超过该值，大文件用系统 sha256sum。
  if (lstatSync(path).size > 1024 * 1024 * 1024) {
    const result = spawnSync('sha256sum', [path], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
    if (result.status !== 0) throw new Error(`sha256sum 失败：${path}`)
    const digest = result.stdout.trim().split(/\s+/)[0]
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`sha256sum 输出无效：${path}`)
    return digest
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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
    else if (entry.type === 'symlink' && found.target !== entry.target) problems.push(`链接目标不符：${path}`)
  }
  const ignored = new Set(ignoreExtra)
  for (const path of actualMap.keys()) if (!expectedMap.has(path) && !ignored.has(path)) problems.push(`清单外文件：${path}`)
  return problems
}
