import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { unzipSync } from 'fflate'
import mammoth from 'mammoth'
import { getDocumentProxy } from 'unpdf'
import { DOCUMENT_LIMITS, DocumentParseError } from './types.ts'
import type { DocumentBlock, DocumentWarning, DocumentWorkerInput, DocumentWorkerMessage, ParsedDocument } from './types.ts'

const input = workerData as DocumentWorkerInput
const warnings: DocumentWarning[] = []

function fail(code: string, message: string): never {
  throw new DocumentParseError(code, message, input.sourceSha256, warnings)
}

function paragraphs(text: string): DocumentBlock[] {
  return text.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/u).filter(text => /\S/u.test(text))
    .map((text, i) => ({ kind: 'paragraph', ordinal: i + 1, text }))
}

function checkTextSize(length: number) {
  if (length > DOCUMENT_LIMITS.textCharacters) fail('extracted_text_too_large', '提取文字超过单次读取范围，请拆分文档后读取。')
}

async function readPdf(): Promise<DocumentBlock[]> {
  if (!Buffer.from(input.bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) fail('invalid_document', '文件内容不是有效 PDF，请检查扩展名或重新导出。')
  const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const pdf = await getDocumentProxy(input.bytes, {
    // CMap 和标准字体均取锁定依赖的本地资源，不访问 CDN。
    cMapUrl: join(pdfjsRoot, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(pdfjsRoot, 'standard_fonts') + '/',
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    verbosity: 0,
  })
  try {
    const { info } = await pdf.getMetadata()
    // 空口令 PDF 也可能自动打开；仍须明确要求未加密的知识来源。
    if ((info as { EncryptFilterName?: string }).EncryptFilterName) fail('encrypted_document', 'PDF 使用加密保护，请提供未加密的文件后读取。')
    if (pdf.numPages > DOCUMENT_LIMITS.pdfPages) fail('too_many_pages', 'PDF 超过 1000 页，请拆分后读取。')
    warnings.push({ code: 'pdf_text_only', message: '只提取 PDF 文字；图片、图表、公式及多栏排版的含义需要核对原件，不执行 OCR。' })
    const blocks: DocumentBlock[] = []
    let textLength = 0
    for (let ordinal = 1; ordinal <= pdf.numPages; ordinal++) {
      const page = await pdf.getPage(ordinal)
      try {
        const content = await page.getTextContent()
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('')
        textLength += text.length
        checkTextSize(textLength)
        blocks.push({ kind: 'page', ordinal, text })
        if (!/\S/u.test(text)) warnings.push({ code: 'empty_pdf_page', ordinal, message: `第 ${ordinal} 页没有可提取文字，可能为空白、扫描图像或文字无法解码；请核对原件。` })
      } finally {
        page.cleanup()
      }
    }
    return blocks
  } finally {
    await pdf.loadingTask.destroy()
  }
}

async function readDocx(): Promise<DocumentBlock[]> {
  if (Buffer.from(input.bytes.subarray(0, 8)).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    fail('encrypted_or_unsupported_document', '文件使用加密或旧版 Office 容器。请另存为未加密的 DOCX 后读取。')
  }
  let expandedBytes = 0
  let hasDocument = false
  // 先核对 ZIP 目录中的展开大小，不为此解压第二份内容。
  unzipSync(input.bytes, { filter(file) {
    expandedBytes += file.originalSize
    if (expandedBytes > DOCUMENT_LIMITS.expandedDocxBytes) fail('expanded_document_too_large', 'DOCX 展开后超过 64 MiB，请拆分或移除不需要的图片后读取。')
    if (file.name === 'word/document.xml') hasDocument = true
    return false
  } })
  if (!hasDocument) fail('invalid_document', '文件中没有 DOCX 正文，请检查文件格式或重新导出。')
  const extracted = await mammoth.extractRawText({ buffer: Buffer.from(input.bytes) })
  for (const message of extracted.messages) {
    if (message.type === 'error') fail('invalid_document', 'DOCX 读取时发生错误，请检查文档或重新导出。')
    warnings.push({ code: 'docx_parser_warning', message: message.message })
  }
  checkTextSize(extracted.value.length)
  warnings.push({ code: 'docx_text_only', message: '按正文段落提取 DOCX 文字，不提供排版页码；图片、图表、公式和表格结构需要核对原件。' })
  return paragraphs(extracted.value)
}

async function parse(): Promise<ParsedDocument> {
  let blocks: DocumentBlock[]
  if (input.format === 'pdf') blocks = await readPdf()
  else if (input.format === 'docx') blocks = await readDocx()
  else {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes) }
    catch { fail('invalid_encoding', '文字文件不是有效 UTF-8，请转换为 UTF-8 后读取。') }
    if (text.includes('\0')) fail('invalid_document', '文字文件包含二进制内容，请检查格式或另存为 UTF-8 文本。')
    checkTextSize(text.length)
    blocks = paragraphs(text)
  }
  if (!blocks.some(block => /\S/u.test(block.text))) fail('no_readable_text', input.format === 'pdf'
    ? 'PDF 没有可提取文字，可能是扫描件或文字无法解码。本功能不执行 OCR，请提供文字版或先完成 OCR。'
    : '文档没有可提取的正文文字，请检查原件或另存为文字文件。')
  return { format: input.format, sourceSha256: input.sourceSha256, blocks, warnings }
}

let message: DocumentWorkerMessage
try {
  message = { ok: true, result: await parse() }
} catch (error) {
  const issue = error instanceof DocumentParseError ? error
    : error instanceof Error && error.name === 'PasswordException'
      ? new DocumentParseError('encrypted_document', 'PDF 受密码保护，请提供未加密的文件后读取。', input.sourceSha256, warnings)
      : new DocumentParseError('invalid_document', '文档无法解析，可能已损坏或格式不受支持。请核对原件并重新导出。', input.sourceSha256, warnings)
  message = { ok: false, error: { code: issue.code, message: issue.message, sourceSha256: input.sourceSha256, warnings: issue.warnings } }
}
parentPort?.postMessage(message)
parentPort?.close()
