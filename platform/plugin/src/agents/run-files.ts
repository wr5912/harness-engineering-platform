import { VERSION_ID } from '../version-id.ts'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, open } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { zip, type AsyncZippable } from 'fflate'

const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const EXP_ID = VERSION_ID
const PREVIEW_LIMIT = 64 * 1024
const FINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
type JsonMap = Record<string, unknown>
type RunLocation = { root: string; directory: string; path: string; id: string }
type FileEntry = { path: string; local: string; size: number; kind: 'text' | 'binary' }

export class RunFileError extends Error {
  readonly code: string
  readonly details: JsonMap
  constructor(code: string, message: string, details: JsonMap = {}) { super(message); this.code = code; this.details = details }
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new RunFileError('aborted', '下载或文件查询已取消')
}

async function optionalStat(path: string) {
  try { return await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function assertNoLinks(root: string, path: string) {
  const rel = relative(root, path)
  if (rel.split(sep).includes('..') || resolve(root, rel) !== path) throw new RunFileError('path_rejected', '路径不在 Run 内')
  let cursor = root
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if ((await lstat(cursor)).isSymbolicLink()) throw new RunFileError('path_rejected', 'Run 不得通过符号链接读取文件')
  }
}

async function locateRun(root: string, runId: string, signal?: AbortSignal): Promise<RunLocation> {
  checkCancelled(signal)
  if (!RUN_ID.test(runId)) throw new RunFileError('invalid_request', 'run_id 必须是 run-<UUIDv4>')
  const absoluteRoot = resolve(root)
  const base = join(absoluteRoot, 'evolution/experiments')
  const entries = await readdir(base, { withFileTypes: true })
  const matches: string[] = []
  for (const entry of entries) {
    if (!EXP_ID.test(entry.name)) continue
    const path = join(base, entry.name, 'runs', runId)
    if (await optionalStat(path)) { await assertNoLinks(absoluteRoot, path); matches.push(path) }
  }
  if (!matches.length) throw new RunFileError('not_found', '未找到 Run')
  if (matches.length !== 1) throw new RunFileError('conflict', 'Run ID 重复，无法确定证据来源')
  const directory = matches[0]
  if (!(await lstat(directory)).isDirectory()) throw new RunFileError('path_rejected', 'Run 必须是目录')
  return { root: absoluteRoot, directory, path: relative(absoluteRoot, directory).split(sep).join('/'), id: runId }
}

function decodeText(data: Uint8Array): string | null {
  if (data.includes(0)) return null
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) } catch { return null }
}

const secretKey = /^(?:.*(?:api[_-]?key|password|passwd|secret|authorization|cookie|credential)|(?:access[_-]?|refresh[_-]?)?token)$/i
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, secretKey.test(key) && !/(?:_configured|_ref)$/.test(key) ? '[REDACTED]' : redactValue(entry)]))
  return typeof value === 'string' ? redactPatterns(value) : value
}
function redactPatterns(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"'&\\]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|password|passwd|secret|authorization|cookie|(?:access[_-]?|refresh[_-]?)?token)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,"'&}]+)/gi, '$1"[REDACTED]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

/** 只处理导出副本；完整文本不截断。 */
export function redactRunText(text: string): string {
  try { return JSON.stringify(redactValue(JSON.parse(text)), null, 2) + (text.endsWith('\n') ? '\n' : '') }
  catch {
    return text.split('\n').map(line => {
      if (/^\s*\{/.test(line)) {
        try { return JSON.stringify(redactValue(JSON.parse(line))) } catch { /* 普通日志继续按文本脱敏。 */ }
      }
      return redactPatterns(line)
    }).join('\n')
  }
}

async function filesInRun(location: RunLocation, signal?: AbortSignal): Promise<FileEntry[]> {
  const files: FileEntry[] = []
  async function visit(directory: string) {
    checkCancelled(signal)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name)
      const stat = await lstat(file)
      if (stat.isSymbolicLink()) throw new RunFileError('path_rejected', 'Run 包含符号链接，拒绝导出外部内容')
      if (stat.isDirectory()) await visit(file)
      else if (stat.isFile()) {
        const local = relative(location.directory, file).split(sep).join('/')
        // 识别文本只读文件头；完整导出另行读取全部字节。
        const handle = await open(file, 'r')
        const sample = Buffer.alloc(Math.min(8192, stat.size))
        try { await handle.read(sample, 0, sample.length, 0) } finally { await handle.close() }
        // 文件头可能在 UTF-8 字符中间结束，允许解码时去掉末尾的不完整字符。
        let kind: 'text' | 'binary' = 'text'
        try {
          if (sample.includes(0)) kind = 'binary'
          else new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true })
        } catch { kind = 'binary' }
        files.push({ path: `${location.path}/${local}`, local, size: stat.size, kind })
      }
    }
  }
  await visit(location.directory)
  return files
}

async function runStatus(location: RunLocation) {
  const yaml = join(location.directory, 'run.yaml')
  const legacy = join(location.directory, 'run.json')
  for (const file of [yaml, legacy]) {
    const stat = await optionalStat(file)
    if (!stat) continue
    await assertNoLinks(location.root, file)
    if (!stat.isFile()) throw new RunFileError('path_rejected', 'Run 元数据必须为普通文件')
    const content = await readFile(file, 'utf8')
    const manifest = (file === yaml ? loadYaml(content) : JSON.parse(content)) as JsonMap | null
    return { sealed: FINAL_STATUSES.has(String(manifest?.status)), status: String(manifest?.status ?? 'unknown') }
  }
  return { sealed: false, status: 'unknown' }
}

async function coverage(location: RunLocation, files: FileEntry[], signal?: AbortSignal) {
  const paths = new Map(files.map(file => [file.local, file]))
  const missing = ['inputs.lock.json', 'results.jsonl', 'summary.json', 'analysis.json', 'report.md'].filter(file => !paths.has(file))
  if (!paths.has('run.yaml') && !paths.has('run.json')) missing.unshift('run.yaml')
  const notes = ['下载仅包含实际保存的证据；文件缺失或未采集的执行轨迹无法从历史记录补回。']
  const unavailable = new Set<string>()
  for (const file of files.filter(file => file.local.endsWith('/checks.json'))) {
    checkCancelled(signal)
    try {
      const checks = JSON.parse((await readLocalFile(location, file.local, signal)).data.toString()) as JsonMap
      if (checks.trace_available === false) {
        const trace = file.local.replace(/checks\.json$/, 'trace.jsonl')
        unavailable.add(trace)
        missing.push(`${trace}（检查记录表明轨迹未取得）`)
      }
    } catch (error) {
      if (error instanceof RunFileError) throw error
      notes.push(`${file.local} 无法解析，采集状态未知。`)
    }
  }
  const traceFiles = files.filter(file => /(?:^|\/)(?:trace|judge-trace)\.jsonl$/.test(file.local) && file.size > 0 && !unavailable.has(file.local))
  const tracePresent = traceFiles.length > 0
  if (!tracePresent) notes.push('该 Run 未保存可用的非空 Session 轨迹；不能据此推断工具调用过程。')
  let attributionStatus = 'unknown'
  if (paths.has('inputs.lock.json')) {
    try {
      const inputs = JSON.parse((await readLocalFile(location, 'inputs.lock.json', signal)).data.toString()) as JsonMap
      const reviewMode = inputs.review_mode ?? (inputs.selection_mode === 'full' ? 'ai' : inputs.selection_mode ? 'none' : undefined)
      const cases = Array.isArray(inputs.evaluation_cases) ? inputs.evaluation_cases as JsonMap[] : []
      for (const item of cases) {
        const trace = `evidence/${String(item.case_id)}/trace.jsonl`
        if (!(paths.get(trace)?.size) && !unavailable.has(trace)) missing.push(`${trace}（未保存非空执行轨迹）`)
      }
      if (reviewMode === 'none') attributionStatus = 'not_requested'
      else if (reviewMode === 'ai') {
        const available = traceFiles.some(file => file.local.startsWith('evidence/analysis/'))
        attributionStatus = available ? 'collected' : 'missing'
        if (!available) missing.push('evidence/analysis/（场景归因轨迹未采集）')
      }
    } catch (error) {
      if (error instanceof RunFileError) throw error
      notes.push('冻结输入无法解析，场景归因的请求范围未知。')
    }
  }
  if (attributionStatus === 'unknown') notes.push('旧 Run 未记录复核模式，场景归因采集范围未知。')
  return { scope: 'Run 目录内所有已保存普通文件', missing: [...new Set(missing)], trace_present: tracePresent, attribution_status: attributionStatus, notes }
}

async function readLocalFile(location: RunLocation, path: string, signal?: AbortSignal, maxBytes?: number) {
  checkCancelled(signal)
  const local = path.startsWith(`${location.path}/`) ? path.slice(location.path.length + 1) : path
  if (!local || local.startsWith('/') || local.includes('\\') || local.split('/').some(part => part === '..' || part === '.' || !part)) {
    throw new RunFileError('path_rejected', '文件路径必须位于所选 Run 内')
  }
  const file = resolve(location.directory, local)
  if (!file.startsWith(`${location.directory}${sep}`)) throw new RunFileError('path_rejected', '文件路径必须位于所选 Run 内')
  const stat = await optionalStat(file)
  if (!stat) throw new RunFileError('not_found', 'Run 中没有此文件')
  await assertNoLinks(location.root, file)
  if (!stat.isFile()) throw new RunFileError('path_rejected', '只能读取 Run 内的普通文件')
  if (local.endsWith('.llm-api-key')) throw new RunFileError('path_rejected', '凭据文件不作为 Run 证据导出')
  if (maxBytes !== undefined && stat.size > maxBytes) throw new RunFileError('file_too_large', '证据文件超过本次读取上限', { path: `${location.path}/${local}`, size: stat.size, max_bytes: maxBytes })
  const data = await readFile(file, { signal })
  checkCancelled(signal)
  return { data, path: `${location.path}/${local}`, local }
}

/** 供确定性证据解析器使用；调用方必须在返回浏览器或模型前脱敏。 */
export async function readRunEvidenceFile(root: string, runId: string, path: string, signal?: AbortSignal, maxBytes = 32 * 1024 * 1024) {
  const location = await locateRun(root, runId, signal)
  const file = await readLocalFile(location, path, signal, maxBytes)
  return { ...file, source_sha256: sha256(file.data) }
}

export async function readRunReport(root: string, runId: string, signal?: AbortSignal) {
  const location = await locateRun(root, runId, signal)
  if (!(await optionalStat(join(location.directory, 'report.md')))) return { path: `${location.path}/report.md`, content: '', present: false }
  const file = await readLocalFile(location, 'report.md', signal)
  const content = decodeText(file.data)
  if (content === null) throw new RunFileError('file_not_text', '报告不是 UTF-8 文本')
  return { path: file.path, content: redactRunText(content), present: true }
}

export async function listRunFiles(root: string, runId: string, signal?: AbortSignal) {
  const location = await locateRun(root, runId, signal)
  const files = await filesInRun(location, signal)
  return { files: files.filter(file => !file.local.endsWith('.llm-api-key')).map(({ local, ...file }) => file),
    ...(await runStatus(location)), coverage: await coverage(location, files, signal) }
}

export async function previewRunFile(root: string, runId: string, path: string, signal?: AbortSignal) {
  const location = await locateRun(root, runId, signal)
  const file = await readLocalFile(location, path, signal)
  const text = decodeText(file.data)
  if (text === null) throw new RunFileError('file_not_text', '二进制文件请下载查看')
  const redacted = Buffer.from(redactRunText(text))
  // 预览固定 64 KiB，下载接口始终读取完整文件。
  return { path: file.path, content: redacted.subarray(0, PREVIEW_LIMIT).toString('utf8'), truncated: redacted.length > PREVIEW_LIMIT }
}

function sha256(data: Uint8Array) { return createHash('sha256').update(data).digest('hex') }
async function archive(location: RunLocation, signal?: AbortSignal) {
  if (!(await runStatus(location)).sealed) throw new RunFileError('run_not_sealed', 'Run 封存后才能下载完整执行包')
  const files = await filesInRun(location, signal)
  const zipped: AsyncZippable = {}
  const manifestFiles: JsonMap[] = []
  const omitted: string[] = []
  for (const file of files) {
    checkCancelled(signal)
    if (file.local.endsWith('.llm-api-key')) { omitted.push(file.local); continue }
    const { data } = await readLocalFile(location, file.local, signal)
    const text = decodeText(data)
    const exported = text === null ? data : Buffer.from(redactRunText(text))
    zipped[`${location.id}/${file.local}`] = exported
    manifestFiles.push({ path: file.local, source_sha256: sha256(data), export_sha256: sha256(exported),
      source_size: data.length, export_size: exported.length, redacted: !data.equals(exported), kind: text === null ? 'binary' : 'text' })
  }
  zipped['export-manifest.json'] = Buffer.from(JSON.stringify({ schema_version: '1.0', run_id: location.id,
    source_path: location.path, exported_at: new Date().toISOString(), coverage: await coverage(location, files, signal), omitted,
    note: '文本在导出副本中脱敏，二进制按原字节导出；源 Run 未改写。', files: manifestFiles }, null, 2) + '\n')
  return new Promise<Uint8Array>((resolveArchive, reject) => {
    checkCancelled(signal)
    let cancel: () => void
    const aborted = () => { cancel?.(); reject(new RunFileError('aborted', '下载已取消')) }
    signal?.addEventListener('abort', aborted, { once: true })
    cancel = zip(zipped, { level: 6 }, (error, data) => {
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolveArchive(data)
    })
    if (signal?.aborted) aborted()
  })
}

export function createRunDownloadHandler(root: string) {
  return async (request: Request): Promise<Response> => {
    try {
      const query = new URL(request.url).searchParams
      const location = await locateRun(root, query.get('run_id') ?? '', request.signal)
      const kind = query.get('kind')
      let data: Uint8Array, filename: string, contentType: string
      if (kind === 'archive') {
        data = await archive(location, request.signal); filename = `${location.id}.zip`; contentType = 'application/zip'
      } else if (kind === 'report' || kind === 'file') {
        const file = await readLocalFile(location, kind === 'report' ? 'report.md' : query.get('path') ?? '', request.signal)
        const text = decodeText(file.data)
        data = text === null ? file.data : Buffer.from(redactRunText(text))
        filename = kind === 'report' ? `${location.id}-report.md` : file.local.split('/').at(-1)!
        contentType = kind === 'report' ? 'text/markdown; charset=utf-8' : text === null ? 'application/octet-stream' : 'text/plain; charset=utf-8'
      } else throw new RunFileError('invalid_request', 'kind 必须为 archive、report 或 file')
      checkCancelled(request.signal)
      return new Response(data as BodyInit, { headers: { 'content-type': contentType,
        'content-disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`,
        'cache-control': 'no-store', 'content-length': String(data.byteLength), 'x-content-type-options': 'nosniff' } })
    } catch (error) {
      const known = error instanceof RunFileError
      const code = known ? error.code : 'download_failed'
      const status = code === 'not_found' ? 404 : code === 'conflict' || code === 'run_not_sealed' ? 409 : code === 'aborted' ? 499 : known ? 400 : 500
      return Response.json({ error: { code, message: known ? error.message : 'Run 下载失败' } }, { status, headers: { 'cache-control': 'no-store' } })
    }
  }
}
