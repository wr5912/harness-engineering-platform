import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { HttpFetchProvider } from '../../plugin/src/standalone-knowledge/native-fetch.ts'
import { DocumentParseError, parseDocument } from '../../plugin/src/documents/index.ts'

export interface KnowledgeRoot { root: string; label: string; include?: string[] }
export interface KnowledgeReference { source: string; line: number; url: string; kind: 'document' | 'service' | 'asset' | 'ambiguous'; required: boolean }
export interface KnowledgeIssue { source?: string; line?: number; url?: string; code: string; message: string; required: boolean }
export interface ArchivedKnowledgeSource {
  url: string; finalUrl: string; path: string; sha256: string; format: 'html' | 'text' | 'pdf' | 'docx';
  bodyKind: 'html' | 'text'; acquiredAt: string; representation: 'decoded-utf8' | 'original-bytes'; readablePath?: string; readableSha256?: string; providedFrom?: string
}
export interface KnowledgeManifest {
  schemaVersion: 1; kind: 'harness-offline-knowledge'; mode: 'online' | 'offline'; indexPath: 'index.json';
  sources: ArchivedKnowledgeSource[]; references: KnowledgeReference[]; missing: KnowledgeIssue[]; warnings: KnowledgeIssue[]
}
export interface KnowledgeInspection { files: string[]; references: KnowledgeReference[]; missing: KnowledgeIssue[]; warnings: KnowledgeIssue[] }
export interface KnowledgeFetchResult { url: string; statusCode: number; bytes: Uint8Array; contentType: string; representation?: 'decoded-utf8' | 'original-bytes'; truncated?: boolean }
export interface KnowledgeOptions {
  roots: KnowledgeRoot[]; mode: 'online' | 'offline'; outDir: string; signal?: AbortSignal;
  onProgress?: (progress: { stage: string; message: string; completed?: number; total?: number }) => void;
  localSources?: Array<{ url: string; path: string }>
  fetcher?: (url: string, signal?: AbortSignal) => Promise<KnowledgeFetchResult>
}

const EXCLUDED = new Set(['.git', '.local', 'node_modules', '__pycache__', 'sessions', 'cache', 'RuntimeHOME'])
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.yaml', '.yml'])
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const within = (root: string, path: string) => path === root || path.startsWith(root + sep)
const hasCredential = (url: URL) => Boolean(url.username || url.password || [...url.searchParams.keys()].some(key => /token|password|secret|credential|api.?key|signature|^key$|^auth$/i.test(key)))

function safeUrl(value: string): string | undefined {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return undefined; url.hash = ''; return url.href }
  catch { return undefined }
}
function displayUrl(value: string): string {
  const url = new URL(value)
  url.username = ''; url.password = ''
  for (const key of [...url.searchParams.keys()]) if (/token|password|secret|credential|api.?key|signature|^key$|^auth$/i.test(key)) url.searchParams.set(key, '[已隐藏]')
  return url.href
}
function generatedArchive(directory: string): boolean {
  try { return JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')).kind === 'harness-offline-knowledge' } catch { return false }
}
function walk(root: string, directory = root, result: string[] = []): string[] {
  if (!existsSync(directory)) return result
  for (const name of readdirSync(directory).sort()) {
    if (EXCLUDED.has(name) || name.endsWith('.llm-api-key') || /^\.env(?:\.|$)/.test(name)) continue
    const path = join(directory, name), stat = lstatSync(path)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) { if (!generatedArchive(path)) walk(root, path, result) }
    else if (stat.isFile()) result.push(path)
  }
  return result
}
function classification(url: URL, line: string): KnowledgeReference['kind'] {
  const path = url.pathname.toLowerCase()
  if (/(?:^|\.)example\.(?:com|org|net)$|\.invalid$/i.test(url.hostname)) return 'ambiguous'
  if (/\.(?:png|jpe?g|gif|svg|webp|zip|tar|gz|whl|exe|gguf|safetensors|bin|onnx)(?:$|\?)/.test(path)) return 'asset'
  if (/\.(?:md|markdown|txt|pdf|docx|html?)$/.test(path) || /(?:^|\/)(?:docs?|documentation|reference|guides?|manual|wiki|readme|learn)(?:\/|$)/i.test(path)
    || /^(?:docs|documentation)\./.test(url.hostname) || /(?:^|\.)(?:arxiv\.org|doi\.org|readthedocs\.io)$/.test(url.hostname)
    || url.hostname === 'gist.github.com' || /github\.com$/.test(url.hostname) && /\/blob\//.test(path)) return 'document'
  if (/^api\./.test(url.hostname) || /\/mcp(?:\/|$)|\/v\d(?:\/|$)|\/api(?:\/|$)/.test(path) || /(?:base[_-]?url|endpoint|服务地址|接口地址|curl\s|mcp[_-]?(?:url|server)|api[_-]?url)/i.test(line)) return 'service'
  if (/参考|资料|文档|阅读|reference|documentation|official docs|read more/i.test(line)) return 'document'
  return 'ambiguous'
}

/** 仅检查已选对象的真实文件；不联网，也不执行 Skill 或配置。 */
export function inspectKnowledge(input: { roots: KnowledgeRoot[]; mode: 'online' | 'offline' }): KnowledgeInspection {
  const roots = input.roots.map(root => ({ ...root, root: resolve(root.root) }))
  const files: string[] = [], references: KnowledgeReference[] = [], missing: KnowledgeIssue[] = [], warnings: KnowledgeIssue[] = []
  const seenFiles = new Set<string>(), seenRefs = new Set<string>()
  for (const root of roots) {
    if (!existsSync(root.root)) { missing.push({ source: root.label, code: 'missing_root', message: '所选知识来源目录不存在', required: true }); continue }
    const selected = root.include ? root.include.flatMap(path => { const full = resolve(root.root, path); if (!within(root.root, full) || !existsSync(full)) return []; return lstatSync(full).isFile() ? [full] : walk(root.root, full) }) : walk(root.root)
    for (const file of selected) {
      if (seenFiles.has(file)) continue
      seenFiles.add(file)
      const sourceRoot = roots.find(candidate => within(candidate.root, file)) ?? root
      const source = `${sourceRoot.label}/${relative(sourceRoot.root, file).split(sep).join('/')}`
      files.push(source)
      if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase()) || lstatSync(file).size > 2 * 1024 * 1024) continue
      const text = readFileSync(file, 'utf8')
      if (text.includes('\0')) continue
      for (const [offset, line] of text.split(/\r?\n/).entries()) {
        for (const match of line.matchAll(/https?:\/\/[^\s<>"'`\])}]+/gi)) {
          const candidate = match[0].replace(/[.,，。；;]+$/, ''), normalized = safeUrl(candidate)
          if (!normalized) continue
          const url = new URL(normalized), kind = classification(url, line)
          const key = `${source}:${offset + 1}:${normalized}`
          if (seenRefs.has(key)) continue
          seenRefs.add(key)
          if (hasCredential(url)) { (kind === 'document' ? missing : warnings).push({ source, line: offset + 1, url: displayUrl(normalized), code: 'credential_url', message: '文档引用含连接凭据，未自动下载；请提供不含凭据的本地材料', required: kind === 'document' }); continue }
          references.push({ source, line: offset + 1, url: normalized, kind, required: kind === 'document' })
        }
        // Markdown 的明确本地依赖不能越过已选对象边界读取。
        for (const [, target] of line.matchAll(/\]\(([^)]+)\)/g)) {
          const path = target.split(/\s+['"]/)[0].split('#')[0]
          if (!path || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path) || path.includes('${')) continue
          let decoded: string
          try { decoded = decodeURIComponent(path) } catch { continue }
          const absolute = resolve(dirname(file), decoded)
          if (!roots.some(root => within(root.root, absolute)) || !existsSync(absolute)) missing.push({ source, line: offset + 1, code: 'missing_local_reference', message: `本地引用未包含在所选资产中：${path}`, required: true })
          else if (!roots.some(root => within(realpathSync(root.root), realpathSync(absolute))) || lstatSync(absolute).isSymbolicLink()) missing.push({ source, line: offset + 1, code: 'linked_local_reference', message: '本地引用是符号链接，不能作为独立知识副本', required: true })
          else if (lstatSync(absolute).isFile() && !seenFiles.has(absolute)) selected.push(absolute)
          else if (lstatSync(absolute).isDirectory() && !generatedArchive(absolute)) selected.push(...walk(absolute))
        }
      }
    }
  }
  for (const ref of references) {
    if (ref.kind === 'service') warnings.push({ ...ref, code: 'external_service', message: '此引用是运行时服务，知识快照不能替代该服务', required: false })
    else if (ref.kind === 'ambiguous') warnings.push({ ...ref, code: 'unclassified_reference', message: '此引用不能静态确认为必需文档，未自动抓取；请核对实际用途', required: false })
    else if (ref.kind === 'asset') warnings.push({ ...ref, code: 'external_asset', message: '此引用是外部资源或模型工件，需按实际运行依赖核对', required: false })
  }
  warnings.push({ code: 'static_coverage', message: '静态检查不能证明动态拼接地址、搜索结果、未声明路径或隐含背景知识已齐全；仍需离线业务验证', required: false })
  return { files, references, missing, warnings }
}

async function defaultFetcher(url: string, signal?: AbortSignal): Promise<KnowledgeFetchResult> {
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)])
  const provider = new HttpFetchProvider({ maxResponseBytes: 32 * 1024 * 1024, maxBodyChars: 16 * 1024 * 1024, timeoutMs: 30000, maxRedirects: 5, userAgent: 'harness-offline-knowledge/1.0' })
  try {
    const result = await provider.fetch({ url }, requestSignal)
    return { url: result.url, statusCode: result.statusCode, bytes: Buffer.from(result.body.content, 'utf8'), contentType: result.body.kind === 'html' ? 'text/html' : 'text/plain', representation: 'decoded-utf8', truncated: result.truncated }
  } catch (error) {
    // 原生公开 HTTP 提供方不接受二进制；仅在它已通过目的地址检查后补充文档下载。
    if ((error as { code?: string }).code !== 'WEB_UNSUPPORTED_CONTENT_TYPE' || !/\.(?:pdf|docx)(?:[?#]|$)/i.test(url)) throw error
    const response = await fetch(url, { signal: requestSignal, redirect: 'error', headers: { 'user-agent': 'harness-offline-knowledge/1.0' } })
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength
      if (size > 32 * 1024 * 1024) throw new Error('文档超过 32 MiB')
      chunks.push(chunk)
    }
    return { url: response.url, statusCode: response.status, bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') ?? '', representation: 'original-bytes' }
  }
}

function cachedSources(roots: KnowledgeRoot[]): Map<string, { directory: string; source: ArchivedKnowledgeSource }> {
  const sources = new Map<string, { directory: string; source: ArchivedKnowledgeSource }>()
  function visit(directory: string) {
    if (!existsSync(directory)) return
    if (generatedArchive(directory)) {
      const index = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8')) as KnowledgeManifest
      for (const source of index.sources ?? []) {
        if (typeof source?.url !== 'string' || typeof source.path !== 'string' || typeof source.sha256 !== 'string' || !['html', 'text', 'pdf', 'docx'].includes(source.format)) continue
        const file = resolve(directory, source.path)
        if (within(directory, file) && existsSync(file) && within(realpathSync(directory), realpathSync(file)) && !lstatSync(file).isSymbolicLink() && hash(readFileSync(file)) === source.sha256) sources.set(source.url, { directory, source })
      }
      return
    }
    for (const name of readdirSync(directory)) { const path = join(directory, name); if (!EXCLUDED.has(name) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) visit(path) }
  }
  for (const root of roots) visit(resolve(root.root))
  return sources
}

/** 归档结果是不可编辑制品；不修改原 Skill、原件或业务 Candidate。 */
export async function collectKnowledge(options: KnowledgeOptions): Promise<KnowledgeManifest> {
  options.signal?.throwIfAborted()
  const inspection = inspectKnowledge(options), cached = cachedSources(options.roots)
  const manifest: KnowledgeManifest = { schemaVersion: 1, kind: 'harness-offline-knowledge', mode: options.mode, indexPath: 'index.json', sources: [], references: inspection.references, missing: inspection.missing, warnings: inspection.warnings }
  if (options.mode === 'online') return manifest
  const outDir = resolve(options.outDir)
  mkdirSync(outDir, { recursive: true })
  const documents = [...new Set(inspection.references.filter(ref => ref.required).map(ref => ref.url))]
  for (const [position, url] of documents.entries()) {
    options.signal?.throwIfAborted()
    options.onProgress?.({ stage: 'knowledge', message: '正在收集离线参考资料', completed: position, total: documents.length })
    const directory = join(outDir, 'sources', hash(url))
    try {
      const local = options.localSources?.find(source => safeUrl(source.url) === url)
      const previous = local ? undefined : cached.get(url)
      let providedFrom: string | undefined = previous?.source.providedFrom
      let result: KnowledgeFetchResult
      if (local) {
        const path = resolve(local.path)
        const owner = options.roots.find(root => within(resolve(root.root), path))
        if (!isAbsolute(local.path) || !owner || !existsSync(path) || !lstatSync(path).isFile() || !within(realpathSync(owner.root), realpathSync(path))) throw new Error('本地资料不在冻结资产内')
        const mime: Record<string, string> = { '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
        const contentType = mime[extname(path).toLowerCase()]
        if (!contentType) throw new Error('本地资料格式不支持')
        if (lstatSync(path).size > 32 * 1024 * 1024) throw new Error('本地资料超过 32 MiB')
        providedFrom = `${owner.label}/${relative(owner.root, path).split(sep).join('/')}`
        result = { url, statusCode: 200, bytes: readFileSync(path), contentType, representation: 'original-bytes' }
      } else if (previous) {
        const source = previous.source
        const path = resolve(previous.directory, source.path)
        result = { url: source.finalUrl, statusCode: 200, bytes: readFileSync(path), contentType: ({ html: 'text/html', text: 'text/plain', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })[source.format], representation: source.representation }
      } else result = await (options.fetcher ?? defaultFetcher)(url, options.signal)
      options.signal?.throwIfAborted()
      if (result.statusCode < 200 || result.statusCode >= 300) throw new Error(`HTTP ${result.statusCode}`)
      if (result.truncated) throw new Error('来源读取被截断')
      if (hasCredential(new URL(result.url))) throw new Error('重定向地址含凭据')
      if (result.bytes.byteLength > 32 * 1024 * 1024) throw new Error('文档超过 32 MiB')
      const mime = result.contentType.split(';')[0].trim().toLowerCase()
      const binaryFormat = mime === 'application/pdf' ? 'pdf' : mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? 'docx' : undefined
      const format = binaryFormat ?? (/^(?:text\/html|application\/xhtml\+xml)$/.test(mime) ? 'html' : /^text\//.test(mime) ? 'text' : undefined)
      if (!format) throw new Error('返回内容不是支持的知识文档')
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `body.${format === 'text' ? 'txt' : format}`)
      writeFileSync(path, result.bytes)
      const source: ArchivedKnowledgeSource = { url, finalUrl: result.url, path: relative(outDir, path).split(sep).join('/'), sha256: hash(result.bytes), format, bodyKind: format === 'html' ? 'html' : 'text', acquiredAt: previous?.source.acquiredAt ?? new Date().toISOString(), representation: result.representation ?? 'original-bytes', ...(providedFrom ? { providedFrom } : {}) }
      if (binaryFormat) {
        const parsed = await parseDocument({ bytes: result.bytes, filename: `body.${binaryFormat}`, signal: options.signal })
        const text = parsed.blocks.map(block => `## ${block.kind === 'page' ? 'page' : 'paragraph'}-${block.ordinal}\n\n${block.text}`).join('\n\n')
        const readable = join(directory, 'readable.md')
        writeFileSync(readable, text + '\n')
        source.readablePath = relative(outDir, readable).split(sep).join('/')
        source.readableSha256 = hash(readFileSync(readable))
        for (const warning of parsed.warnings) manifest.warnings.push({ url, code: warning.code, message: warning.message, required: false })
      } else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)
        if (!/\S/u.test(text) || text.includes('\0')) throw new Error('来源没有可读正文')
      }
      manifest.sources.push(source)
    } catch (error) {
      options.signal?.throwIfAborted()
      // 仅说明受控错误，不复制上游回显、URL 查询或连接凭据。
      const webReasons: Record<string, string> = {
        WEB_FETCH_TIMEOUT: '读取超时', WEB_FETCH_TOO_LARGE: '资料超过读取范围', WEB_INVALID_URL: '资料地址无效',
        WEB_BLOCKED_URL: '原生网页读取不支持此目标地址', WEB_REDIRECT_BLOCKED: '资料跳转到未支持的地址',
        WEB_UNSUPPORTED_CONTENT_TYPE: '资料格式不支持', WEB_PROVIDER_ERROR: '无法连接资料来源',
      }
      const fixedReasons = new Set(['来源读取被截断', '重定向地址含凭据', '文档超过 32 MiB', '返回内容不是支持的知识文档', '来源没有可读正文', '本地资料不在冻结资产内', '本地资料格式不支持', '本地资料超过 32 MiB'])
      const issue = error as { code?: string; message?: string }
      const reason = error instanceof DocumentParseError ? error.message : webReasons[issue.code ?? '']
        ?? (issue.message && (/^HTTP \d{3}$/.test(issue.message) || fixedReasons.has(issue.message)) ? issue.message : '未能完整读取资料')
      manifest.missing.push({ url, code: error instanceof DocumentParseError ? error.code : 'unavailable_reference', message: `${reason}；请提供本地快照或可读版本后重试`, required: true })
    }
  }
  options.signal?.throwIfAborted()
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(manifest, null, 2) + '\n')
  const lines = manifest.sources.map((source, i) => `${i + 1}. [${source.url}](${source.readablePath ?? source.path}) — SHA-256: ${source.sha256}`)
  writeFileSync(join(outDir, 'README.md'), `# 离线参考资料\n\n此目录由打包器生成，不直接编辑。\n\n${lines.join('\n')}\n\n${manifest.missing.length ? `未解决资料：${manifest.missing.length} 项。\n` : ''}`)
  options.onProgress?.({ stage: 'knowledge', message: '离线参考资料检查完成', completed: documents.length, total: documents.length })
  return manifest
}
