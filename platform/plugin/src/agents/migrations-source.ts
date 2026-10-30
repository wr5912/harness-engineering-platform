import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { strFromU8, unzipSync } from 'fflate'
import { assetText } from './asset-text.ts'
import { dataPath, sha256 } from '../tasks/files.ts'

export type MigrationMap = Record<string, any>
export class MigrationError extends Error { constructor(readonly code: string, message: string) { super(message) } }
export function migrationFail(message: string, code = 'invalid_request'): never { throw new MigrationError(code, message) }
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
export function migrationWrite(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}
const execute = promisify(execFile)
const MAX_FILES = 5000, MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024
const SKIP = new Set(['.git', '.local', '.DS_Store', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.cache', 'cache', 'caches', 'sessions', 'session', 'RuntimeHOME', 'attachments', '.dsh', '.codex', '.claude', '.ssh'])
export function safeSourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\0') || value.split('/').some(p => !p || p === '.' || p === '..')) migrationFail('来源路径必须是普通 POSIX 相对路径')
  return value
}
export function excludedMigrationPath(path: string): string | undefined {
  const parts = path.split('/'), name = parts.at(-1)!
  if (parts.some(p => SKIP.has(p))) return '运行状态、缓存或依赖目录'
  if (/^(?:\.env(?:\..*)?|credentials?(?:\..*)?|id_(?:rsa|ed25519)|.*\.llm-api-key)$/i.test(name)) return '凭据文件'
  if (/\.(?:safetensors|ckpt|pth|pt|gguf|onnx)$/i.test(name) || /^(?:pytorch_model|model|consolidated|adapter_model).*\.bin$/i.test(name)) return '模型权重；未修改的基础模型不进入 Harness 资产'
  return undefined
}
export type SourceEntry = { path: string; bytes: number; sha256?: string; mode?: number; binary?: boolean; excluded?: string }
export type MigrationSource = { schema_version: 1; source_id: string; fingerprint: string; inspected_at: string; provenance: MigrationMap; entries: SourceEntry[]; frameworks: string[]; versions: MigrationMap; warnings: string[] }
function sourceDirectory(root: string, id: unknown) {
  if (typeof id !== 'string' || !/^source-[0-9a-f-]{36}$/.test(id)) migrationFail('source_id 无效')
  return dataPath(root, `.local/migrations/sources/${id}`)
}
export function loadMigrationSource(root: string, id: unknown, fingerprint?: unknown): MigrationSource {
  const file = join(sourceDirectory(root, id), 'manifest.json')
  if (!existsSync(file)) migrationFail('来源快照不存在，请重新清点', 'not_found')
  const source = JSON.parse(readFileSync(file, 'utf8')) as MigrationSource
  if (fingerprint !== undefined && fingerprint !== source.fingerprint) migrationFail('来源指纹不匹配，请读取本次清点结果', 'conflict')
  const actual = sha256(canonical({ provenance: source.provenance, entries: source.entries, frameworks: source.frameworks, versions: source.versions }))
  if (actual !== source.fingerprint) migrationFail('来源快照清单发生变化，请重新清点', 'conflict')
  return source
}
export function migrationSourceBytes(root: string, source: MigrationSource, path: unknown, expected?: unknown): Buffer {
  const relative = safeSourcePath(path), entry = source.entries.find(item => item.path === relative)
  if (!entry || entry.excluded || !entry.sha256) migrationFail('来源文件未纳入可用快照', 'source_rejected')
  const bytes = readFileSync(dataPath(sourceDirectory(root, source.source_id), `files/${relative}`))
  if (sha256(bytes) !== entry.sha256 || (expected !== undefined && expected !== entry.sha256)) migrationFail('来源文件摘要变化，请重新清点', 'conflict')
  return bytes
}
function binary(bytes: Buffer) { return bytes.includes(0) || bytes.toString('utf8').includes('\ufffd') }
export function readMigrationSource(root: string, body: MigrationMap) {
  if (typeof body.fingerprint !== 'string') migrationFail('读取来源必须携带 fingerprint')
  const source = loadMigrationSource(root, body.source_id, body.fingerprint), bytes = migrationSourceBytes(root, source, body.path)
  const entry = source.entries.find(item => item.path === body.path)!
  if (entry.binary) return { source_id: source.source_id, fingerprint: source.fingerprint, ...entry, content: null, note: '二进制文件可通过 source_path 固定摘要复制，不作为文本展示。' }
  const text = assetText(entry.path, bytes.toString('utf8'))
  const offset = body.offset ?? 0, limit = body.limit ?? 64 * 1024
  if (!Number.isInteger(offset) || offset < 0 || offset > text.content.length || !Number.isInteger(limit) || limit < 1 || limit > 128 * 1024) migrationFail('offset 必须位于正文范围内，limit 必须为 1–131072 个字符')
  const content = text.content.slice(offset, offset + limit), next = offset + content.length, truncated = next < text.content.length
  return { source_id: source.source_id, fingerprint: source.fingerprint, ...entry, ...text, content, offset, truncated, total_characters: text.content.length, next_offset: truncated ? next : null,
    read_input: truncated ? { source_id: source.source_id, fingerprint: source.fingerprint, path: entry.path, offset: next, limit } : null }
}
function realSourcePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) migrationFail('请选择本机绝对来源路径')
  const path = resolve(value)
  // 显式来源可以位于数据根以外，但不能借符号链接改变对象。
  let cursor = path
  while (dirname(cursor) !== cursor) { if (lstatSync(cursor).isSymbolicLink()) migrationFail('来源不接受符号链接'); cursor = dirname(cursor) }
  return realpathSync(path)
}
async function git(cwd: string, args: string[], signal?: AbortSignal, buffer = MAX_FILE) {
  return (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'gc.auto=0', ...args], { cwd, encoding: 'buffer', timeout: 60_000, maxBuffer: buffer, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })).stdout as Buffer
}
/** fflate 负责正文解压；中央目录补充它未公开的 Unix 类型和执行位。 */
function zipMetadata(bytes: Buffer) {
  type Entry = { path: string; mode: number; directory: boolean; excluded?: string }
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break
  if (end < Math.max(0, bytes.length - 65557)) migrationFail('ZIP 中央目录不存在或已截断')
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count) migrationFail('暂不支持分卷 ZIP，请提供普通 ZIP 或 TAR')
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) migrationFail('暂不支持 ZIP64，请缩小来源后提供普通 ZIP 或 TAR')
  if (count > MAX_FILES || start + size > end) migrationFail('ZIP 中央目录范围或文件数量无效')
  const entries = new Map<string, Entry>(), paths = new Set<string>()
  let offset = start
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + size || bytes.readUInt32LE(offset) !== 0x02014b50) migrationFail('ZIP 中央目录项无效')
    const nameLength = bytes.readUInt16LE(offset + 28), next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
    if (next > start + size) migrationFail('ZIP 中央目录项被截断')
    const flags = bytes.readUInt16LE(offset + 8), name = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength), !(flags & 0x800)), path = safeSourcePath(name.replace(/\/$/, ''))
    if (paths.has(path)) migrationFail('ZIP 存在重复路径，无法固定唯一来源')
    paths.add(path)
    const host = bytes.readUInt16LE(offset + 4) >>> 8, attributes = bytes.readUInt32LE(offset + 38), unixMode = host === 3 || host === 19 ? attributes >>> 16 : 0
    const type = unixMode & 0o170000, directory = name.endsWith('/') || type === 0o040000 || Boolean(attributes & 0x10)
    const excluded = type && type !== 0o100000 && type !== 0o040000 ? '符号链接或特殊归档项' : flags & 1 ? '加密归档项' : undefined
    const local = bytes.readUInt32LE(offset + 42), compressed = bytes.readUInt32LE(offset + 20), original = bytes.readUInt32LE(offset + 24)
    if (local === 0xffffffff || compressed === 0xffffffff || original === 0xffffffff) migrationFail('暂不支持 ZIP64 目录项，请提供普通 ZIP 或 TAR')
    if (bytes.readUInt16LE(offset + 34) || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28) + compressed > start) migrationFail('ZIP 正文范围无效')
    entries.set(name, { path, mode: unixMode & 0o111 ? 0o755 : 0o644, directory, ...(excluded ? { excluded } : {}) })
    offset = next
  }
  if (offset !== start + size) migrationFail('ZIP 中央目录长度不一致')
  return entries
}
function tarEntries(bytes: Buffer): { path: string; bytes?: Buffer; mode?: number; excluded?: string; size: number }[] {
  const entries: ReturnType<typeof tarEntries> = [], seen = new Set<string>()
  let offset = 0, paxPath: string | undefined, longPath: string | undefined
  const text = (part: Buffer) => part.toString('utf8').replace(/\0.*$/s, '')
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) break
    const checksum = parseInt(text(header.subarray(148, 156)).trim(), 8)
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]
    if (!Number.isFinite(checksum) || sum !== checksum) migrationFail('TAR 头校验失败')
    const size = parseInt(text(header.subarray(124, 136)).trim() || '0', 8), mode = parseInt(text(header.subarray(100, 108)).trim() || '644', 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) migrationFail('TAR 内容长度无效')
    const body = bytes.subarray(offset + 512, offset + 512 + size), type = String.fromCharCode(header[156])
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') { paxPath = /(?:^|\n)\d+ path=([^\n]+)/.exec(body.toString('utf8'))?.[1]; continue }
    if (type === 'g') continue
    if (type === 'L') { longPath = text(body); continue }
    const prefix = text(header.subarray(345, 500)), name = text(header.subarray(0, 100))
    let path = paxPath ?? longPath ?? (prefix ? `${prefix}/${name}` : name); paxPath = longPath = undefined
    path = path.replace(/\/$/, ''); if (path.startsWith('./')) path = path.slice(2)
    if (!path) continue
    safeSourcePath(path)
    if (type === '5') continue
    if (seen.has(path)) migrationFail('归档存在重复路径，无法固定唯一来源')
    seen.add(path)
    entries.push({ path, size, mode, ...(type === '\0' || type === '0' || type === '7' ? { bytes: body } : { excluded: '链接或特殊归档项' }) })
    if (entries.length > MAX_FILES) migrationFail('来源文件数量超过 5000，请缩小范围')
  }
  return entries
}
/** 来源只做版本识别和确定性清点；不执行其中的配置、依赖脚本或业务代码。 */
export async function inspectMigrationSource(root: string, body: MigrationMap, signal?: AbortSignal): Promise<MigrationSource> {
  const input = body.source
  if (!input || typeof input !== 'object') migrationFail('缺少 source')
  const kind = input.kind === 'material' ? 'text' : input.kind
  if (!['local', 'git', 'archive', 'text'].includes(kind)) migrationFail('source.kind 只支持 local/git/archive/text')
  const sourceId = `source-${randomUUID()}`, directory = sourceDirectory(root, sourceId), entries: SourceEntry[] = []
  const files = new Map<string, Buffer>(), provenance: MigrationMap = { kind }, warnings: string[] = []
  let total = 0
  function add(path: string, bytes?: Buffer, mode = 0o644, excluded?: string, size = bytes?.length ?? 0) {
    safeSourcePath(path)
    if (entries.some(item => item.path === path)) migrationFail('来源存在重复路径')
    if (entries.length >= MAX_FILES) migrationFail('来源文件数量超过 5000，请缩小范围')
    excluded ??= excludedMigrationPath(path)
    if (!excluded && size > MAX_FILE) excluded = '单文件超过 8 MiB，请单独选择所需资产'
    if (!excluded && bytes) {
      total += bytes.length
      if (total > MAX_TOTAL) migrationFail('来源有效文件超过 64 MiB，请缩小范围')
      const isBinary = binary(bytes)
      if (assetText(path, bytes.toString('utf8')).redacted) excluded = '包含凭据常量，未保存原文'
      if (!excluded) { files.set(path, bytes); entries.push({ path, bytes: size, mode: mode & 0o111 ? 0o755 : 0o644, sha256: sha256(bytes), binary: isBinary }); return }
    }
    entries.push({ path, bytes: size, ...(excluded ? { excluded } : {}) })
  }
  try {
    if (kind === 'text') {
      if (typeof input.text !== 'string' || !input.text.trim()) migrationFail('文本来源必须提供 text')
      add(safeSourcePath(input.filename ?? 'source.txt'), Buffer.from(input.text))
      provenance.name = input.filename ?? 'source.txt'; provenance.version = typeof input.version === 'string' ? input.version : null
    } else if (kind === 'local') {
      const path = realSourcePath(input.path); provenance.path = path
      function walk(current: string, relative: string) {
        if (signal?.aborted) migrationFail('来源清点已取消', 'aborted')
        const stat = lstatSync(current)
        if (stat.isSymbolicLink()) { add(relative, undefined, 0, '符号链接'); return }
        const reason = relative ? excludedMigrationPath(relative) : undefined
        if (reason) { add(relative, undefined, 0, reason); return }
        if (stat.isDirectory()) for (const name of readdirSync(current).sort()) walk(join(current, name), relative ? `${relative}/${name}` : name)
        else if (stat.isFile()) add(relative || basename(current), stat.size <= MAX_FILE ? readFileSync(current) : undefined, stat.mode, undefined, stat.size)
        else if (relative) add(relative, undefined, 0, '特殊文件')
      }
      const stat = lstatSync(path); walk(path, stat.isDirectory() ? '' : basename(path))
      try {
        provenance.commit = (await git(stat.isDirectory() ? path : dirname(path), ['rev-parse', 'HEAD'], signal)).toString().trim()
        provenance.commit_scope = 'enclosing-repository-reference'
        provenance.content_identity = 'working-tree-snapshot-fingerprint'
      } catch { /* 普通目录无需 Git 身份。 */ }
    } else if (kind === 'archive') {
      const path = realSourcePath(input.path); if (lstatSync(path).size > MAX_TOTAL) migrationFail('归档超过 64 MiB，请缩小范围'); const raw = readFileSync(path); provenance.path = path; provenance.archive_sha256 = sha256(raw)
      if (raw.length > MAX_TOTAL) migrationFail('归档超过 64 MiB，请缩小范围')
      if (raw[0] === 0x50 && raw[1] === 0x4b) {
        const metadata = zipMetadata(raw)
        let expanded = 0, count = 0
        const unpacked = unzipSync(raw, { filter: entry => {
          const meta = metadata.get(entry.name); if (!meta) migrationFail('ZIP 正文与中央目录不一致')
          const { path, mode } = meta
          if (++count > MAX_FILES) migrationFail('归档文件过多')
          if (meta.directory && !meta.excluded) return false
          expanded += entry.originalSize; if (expanded > MAX_TOTAL) migrationFail('归档展开内容超过 64 MiB')
          const reason = meta.excluded ?? excludedMigrationPath(path) ?? (entry.originalSize > MAX_FILE ? '单文件超过 8 MiB' : undefined)
          if (reason) { add(path, undefined, mode, reason, entry.originalSize); return false }
          return true
        } })
        for (const [name, meta] of metadata) {
          if (meta.directory || meta.excluded || entries.some(entry => entry.path === meta.path)) continue
          if (!Object.hasOwn(unpacked, name)) migrationFail('ZIP 正文无法按固定目录读取')
          add(meta.path, Buffer.from(unpacked[name]), meta.mode)
        }
      } else {
        const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: MAX_TOTAL }) : raw
        for (const entry of tarEntries(bytes)) add(entry.path, entry.bytes, entry.mode, entry.excluded, entry.size)
      }
    } else {
      const url = input.url ?? input.path
      if (typeof url !== 'string' || !url.trim() || url.startsWith('-') || /[\r\n]/.test(url) || /https?:\/\/[^/]*@|[?&](?:token|key|password)=/i.test(url)) migrationFail('Git 来源无效或包含凭据，请使用不带凭据的仓库引用')
      const ref = typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : 'HEAD'
      if (ref.startsWith('-') || /[\r\n\0]/.test(ref)) migrationFail('Git ref 无效')
      let repository = url
      const local = isAbsolute(url) && existsSync(url)
      if (local) repository = realSourcePath(url)
      else {
        if (!/^(?:https?:\/\/|ssh:\/\/|git@)/.test(url)) migrationFail('远程 Git 仅接受 HTTPS/SSH 仓库')
        mkdirSync(directory, { recursive: true }); repository = join(directory, 'repository.git')
        await git(root, ['clone', '--bare', '--filter=blob:none', '--', url, repository], signal, 1024 * 1024)
      }
      const commit = (await git(repository, ['rev-parse', '--verify', `${ref}^{commit}`], signal)).toString().trim()
      if (!/^[0-9a-f]{40}$/.test(commit)) migrationFail('Git 来源无法固定到提交')
      provenance.url = url; provenance.requested_ref = ref; provenance.commit = commit
      const tree = (await git(repository, ['ls-tree', '-r', '-l', '-z', commit], signal, MAX_TOTAL)).toString().split('\0').filter(Boolean)
      for (const row of tree) {
        const match = /^(\d+) (\S+) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/.exec(row)
        if (!match) migrationFail('Git 文件清单无法解析')
        const [, mode, type, , size, path] = match
        const reason = type !== 'blob' || mode === '120000' ? '符号链接或子模块' : excludedMigrationPath(path)
        const length = Number(size)
        add(path, !reason && length <= MAX_FILE ? await git(repository, ['show', `${commit}:${path}`], signal) : undefined, parseInt(mode, 8), reason, length || 0)
      }
      if (!local) rmSync(repository, { recursive: true, force: true })
    }
    entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const frameworks = new Set<string>(), versions: MigrationMap = {}
    for (const [path, bytes] of files) {
      if (binary(bytes)) continue
      const text = bytes.toString('utf8')
      if (/(^|\/)(?:opencode\.jsonc?|\.opencode)(?:\/|$)/.test(path) || /["']\$schema["']\s*:\s*["'][^"']*opencode/.test(text)) frameworks.add('OpenCode')
      if (/\bagentscope\b/i.test(text)) frameworks.add('AgentScope')
      if (/(?:@deepseek-ai\/dsh-|agent\.cordis\.ya?ml|preset\.ya?ml)/.test(path + '\n' + text)) frameworks.add('DSH')
      if (/\b(?:langgraph|StateGraph|MessageGraph)\b/.test(text)) frameworks.add('LangGraph')
      if (/\b(?:langchain|create_agent|AgentExecutor)\b/.test(text)) frameworks.add('LangChain')
      if (/(?:^|\/)package\.json$/.test(path)) { try { const pkg = JSON.parse(text); versions[path] = { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, peerDependencies: pkg.peerDependencies, engines: pkg.engines } } catch { warnings.push(`${path} 不是有效 JSON，按普通源码保留`) } }
      if (/(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|uv\.lock|poetry\.lock)$/.test(path)) versions[path] = { sha256: sha256(bytes), note: '按原文固定；准备依赖前须确定目标环境与精确锁定结果' }
    }
    const detected = [...frameworks].sort()
    const source: MigrationSource = { schema_version: 1, source_id: sourceId, inspected_at: new Date().toISOString(), fingerprint: sha256(canonical({ provenance, entries, frameworks: detected, versions })), provenance, entries, frameworks: detected, versions, warnings }
    mkdirSync(join(directory, 'files'), { recursive: true })
    for (const [path, bytes] of files) { const file = dataPath(directory, `files/${path}`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }) }
    migrationWrite(join(directory, 'manifest.json'), source)
    return source
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}
