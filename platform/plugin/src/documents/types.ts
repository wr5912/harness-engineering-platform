export type DocumentFormat = 'markdown' | 'text' | 'pdf' | 'docx'

export interface DocumentBlock {
  kind: 'page' | 'paragraph'
  /** PDF 页码或纯文本段落序号，从 1 开始；DOCX 不提供排版页码。 */
  ordinal: number
  text: string
}

export interface DocumentWarning {
  code: string
  message: string
  ordinal?: number
}

export interface ParsedDocument {
  format: DocumentFormat
  /** 原始文件字节的 SHA-256，不是提取文本的摘要。 */
  sourceSha256: string
  blocks: DocumentBlock[]
  warnings: DocumentWarning[]
}

export type DocumentResult = ParsedDocument

export interface ParseDocumentInput {
  bytes: Uint8Array
  filename: string
  signal?: AbortSignal
}

// 小型知识集的单次解析边界；超限明确失败，不静默截断来源。
export const DOCUMENT_LIMITS = {
  bytes: 32 * 1024 * 1024,
  expandedDocxBytes: 64 * 1024 * 1024,
  pdfPages: 1000,
  textCharacters: 16 * 1024 * 1024,
  timeoutMs: 30_000,
} as const

export class DocumentParseError extends Error {
  readonly code: string
  readonly sourceSha256?: string
  readonly warnings: DocumentWarning[]

  constructor(code: string, message: string, sourceSha256?: string, warnings: DocumentWarning[] = []) {
    super(message)
    this.name = 'DocumentParseError'
    this.code = code
    this.sourceSha256 = sourceSha256
    this.warnings = warnings
  }
}

export interface DocumentWorkerInput {
  bytes: Uint8Array
  format: DocumentFormat
  sourceSha256: string
}

export type DocumentWorkerMessage =
  | { ok: true; result: ParsedDocument }
  | { ok: false; error: { code: string; message: string; sourceSha256: string; warnings: DocumentWarning[] } }
