import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { assetText } from '../agents/asset-text.ts'
import type { GeneratedCodeCatalog, GeneratedCodeFile, GeneratedCodeKind, GeneratedCodeRead } from './generated-code.ts'

export interface CodeLocation { root: string; file: string; path: string; kind?: GeneratedCodeKind; entry?: boolean; asset_path?: string; built_sha256?: string }
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const TEXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|md|css|html|map)$/i
const MAX_FILE_BYTES = 16 * 1024 * 1024
export const CODE_PREVIEW_CHARACTERS = 128 * 1024

function checked(root: string, file: string) {
  const base = resolve(root), absolute = resolve(base, file), path = relative(base, absolute)
  if (!file || path === '..' || path.startsWith(`..${sep}`) || path === '' || file.includes('\\')) throw new Error('源码路径不在当前范围内')
  let current = base
  for (const part of path.split(sep)) {
    current = resolve(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('源码路径不能经过符号链接')
  }
  return absolute
}

/** 仅扫描调用方已确认的生成目录；依赖、模型与隐藏目录不作为源码。 */
export function codeDirectory(root: string, directory: string): string[] {
  const absolute = checked(root, directory)
  if (!existsSync(absolute)) return []
  const result: string[] = []
  function walk(path: string) {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || ['node_modules', 'model', 'models', 'checkpoint', 'checkpoints'].includes(item.name) || item.isSymbolicLink()) continue
      const next = resolve(path, item.name)
      if (item.isDirectory()) walk(next)
      else if (item.isFile() && TEXT.test(item.name)) result.push(relative(resolve(root), next).split(sep).join('/'))
    }
  }
  walk(absolute)
  return result
}

function descriptor(location: CodeLocation): GeneratedCodeFile {
  const absolute = checked(location.root, location.file)
  const base = { path: location.path, kind: location.kind ?? (/[cm]?jsx?$/.test(location.file) ? 'artifact' : /tsx?$/.test(location.file) ? 'source' : 'support'), language: location.file.split('.').pop() ?? 'text', entry: Boolean(location.entry), ...(location.asset_path ? { asset_path: location.asset_path } : {}) }
  if (!existsSync(absolute)) return { ...base, bytes: null, sha256: null, missing: true }
  const stat = lstatSync(absolute)
  if (!stat.isFile()) throw new Error('请选择源码文件')
  if (!TEXT.test(location.file) || stat.size > MAX_FILE_BYTES) return { ...base, kind: 'binary', bytes: stat.size, sha256: null }
  return { ...base, bytes: stat.size, sha256: hash(readFileSync(absolute)) }
}

export function codeCatalog(identity: string, locations: CodeLocation[], notes: string[] = []): GeneratedCodeCatalog {
  const paths = new Set<string>()
  return { identity, notes, files: locations.map(location => {
    if (paths.has(location.path)) throw new Error('源码目录存在重复路径')
    paths.add(location.path)
    const file = descriptor(location)
    return location.built_sha256 ? { ...file, built_sha256: location.built_sha256, matches_build: file.sha256 === location.built_sha256 } : file
  }).sort((a, b) => Number(b.entry) - Number(a.entry) || a.path.localeCompare(b.path)) }
}

export function readCode(identity: string, locations: CodeLocation[], path: unknown, expected: unknown): GeneratedCodeRead {
  if (typeof path !== 'string' || typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('读取源码需要目录中的文件路径和 SHA-256')
  const location = locations.find(item => item.path === path)
  if (!location) throw new Error('所选文件不属于当前源码目录')
  const info = descriptor(location)
  if (info.missing) throw new Error('源码文件不存在，请刷新文件目录后重试')
  if (info.kind === 'binary') throw new Error('此文件不提供代码预览，请到资产查看')
  const bytes = readFileSync(checked(location.root, location.file))
  if (hash(bytes) !== expected) throw new Error('源码文件已变化，请刷新文件目录后重试')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const preview = assetText(location.file, text)
  let end = Math.min(preview.content.length, CODE_PREVIEW_CHARACTERS)
  if (end < preview.content.length && /[\uD800-\uDBFF]/.test(preview.content[end - 1])) end--
  const truncated = end < preview.content.length
  return { identity, path, sha256: expected, bytes: bytes.length, content: preview.content.slice(0, end), complete: !truncated && !preview.redacted, truncated, redacted: preview.redacted }
}
