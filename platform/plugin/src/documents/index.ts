import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { Worker } from 'node:worker_threads'
import { DOCUMENT_LIMITS, DocumentParseError } from './types.ts'
import type { DocumentFormat, DocumentWorkerMessage, ParseDocumentInput, ParsedDocument } from './types.ts'

export { DOCUMENT_LIMITS, DocumentParseError } from './types.ts'
export type { DocumentBlock, DocumentFormat, DocumentResult, DocumentWarning, ParseDocumentInput, ParsedDocument } from './types.ts'

function documentFormat(filename: string): DocumentFormat {
  const formats: Record<string, DocumentFormat> = { '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text', '.pdf': 'pdf', '.docx': 'docx' }
  const format = formats[extname(filename).toLowerCase()]
  if (!format) throw new DocumentParseError('unsupported_format', '暂不支持此文档格式。请选择 UTF-8 Markdown、TXT、文字型 PDF 或 DOCX。')
  return format
}

/** 只解析调用方已授权取得的字节；来源权限、分页与文件保存由调用方负责。 */
export async function parseDocument({ bytes, filename, signal }: ParseDocumentInput): Promise<ParsedDocument> {
  signal?.throwIfAborted()
  if (!bytes.byteLength) throw new DocumentParseError('empty_document', '文档为空，请提供有内容的文件。')
  if (bytes.byteLength > DOCUMENT_LIMITS.bytes) throw new DocumentParseError('document_too_large', '文档超过 32 MiB，请拆分后读取。')
  const format = documentFormat(filename)
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  // 保留调用方的原始字节；Worker 独占副本，PDF.js 也可能转移其 ArrayBuffer。
  const copied = new Uint8Array(bytes)
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './document-parser-worker.js', import.meta.url), {
    workerData: { bytes: copied, format, sourceSha256 },
    transferList: [copied.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 512 },
    // 独立 Node 24 文件入口无需继承 Host 的 eval、测试或 V8 命令行参数。
    execArgv: [],
    // 解析器的底层控制台输出不进入 Host 日志或模型上下文。
    stdout: true,
    stderr: true,
  })
  worker.stdout.resume()
  worker.stderr.resume()
  return await new Promise<ParsedDocument>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown, result?: ParsedDocument) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      // 等待实际终止后才返回取消/结果，CPU 密集解析不会遗留在后台。
      void worker.terminate().then(() => result ? resolve(result) : reject(error), reject)
    }
    const abort = () => finish(signal?.reason ?? new DOMException('文档读取已取消。', 'AbortError'))
    const timeout = setTimeout(() => finish(new DocumentParseError('parse_timeout', '文档解析超过 30 秒，已停止。请拆分文档或另存为文字文件后重试。', sourceSha256)), DOCUMENT_LIMITS.timeoutMs)
    worker.once('message', (message: DocumentWorkerMessage) => {
      if (message.ok) finish(undefined, message.result)
      else finish(new DocumentParseError(message.error.code, message.error.message, message.error.sourceSha256, message.error.warnings))
    })
    worker.once('error', () => finish(new DocumentParseError('parser_failed', '文档解析器未能完成读取。请检查文件是否损坏，或拆分、另存后重试。', sourceSha256)))
    worker.once('exit', code => {
      if (!settled) finish(new DocumentParseError('parser_failed', `文档解析器在返回结果前退出（${code}）。请拆分或另存文档后重试。`, sourceSha256))
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
