import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { parseDocument, DocumentParseError, DOCUMENT_LIMITS } from '../src/documents/index.ts'
import { pdfBytes, docxBytes } from './document-fixtures.mjs'

test('UTF-8 Markdown/TXT 保留段落全文，摘要绑定原始字节且不转移调用方缓冲区', async () => {
  const bytes = Buffer.from('# 使用说明\r\n\r\n第一段中文\r\n保留换行\r\n\r\n末段')
  const before = Buffer.from(bytes)
  const result = await parseDocument({ filename: '知识.MD', bytes })
  assert.equal(result.format, 'markdown')
  assert.equal(result.sourceSha256, createHash('sha256').update(before).digest('hex'))
  assert.deepEqual(result.blocks, [
    { kind: 'paragraph', ordinal: 1, text: '# 使用说明' },
    { kind: 'paragraph', ordinal: 2, text: '第一段中文\n保留换行' },
    { kind: 'paragraph', ordinal: 3, text: '末段' },
  ])
  assert.deepEqual(bytes, before)
  assert.deepEqual(result.warnings, [])
  const long = '连续长段落'.repeat(12_000)
  assert.equal((await parseDocument({ filename: 'long.txt', bytes: Buffer.from(long) })).blocks[0].text, long)
})

test('中文 PDF 逐页提取，本地 CMap 可用，空白/扫描页保留页码与警示', async () => {
  const result = await parseDocument({ filename: '知识.pdf', bytes: pdfBytes(['中文知识集', '', null, '业务智能体资料']) })
  assert.equal(result.format, 'pdf')
  assert.deepEqual(result.blocks.map(({ kind, ordinal, text }) => ({ kind, ordinal, text: text.trim() })), [
    { kind: 'page', ordinal: 1, text: '中文知识集' },
    { kind: 'page', ordinal: 2, text: '' },
    { kind: 'page', ordinal: 3, text: '' },
    { kind: 'page', ordinal: 4, text: '业务智能体资料' },
  ])
  assert.deepEqual(result.warnings.filter(w => w.code === 'empty_pdf_page').map(w => w.ordinal), [2, 3])
  assert.ok(result.warnings.some(w => w.code === 'pdf_text_only' && w.message.includes('不执行 OCR')))
})

test('真实 DOCX 提取纯文本段落，不伪造 Word 排版页码', async () => {
  const result = await parseDocument({ filename: '知识.docx', bytes: docxBytes(['业务说明', '中文段落，保留 & 符号', '第三段']) })
  assert.equal(result.format, 'docx')
  assert.deepEqual(result.blocks.map(({ kind, ordinal, text }) => ({ kind, ordinal, text: text.trim() })), [
    { kind: 'paragraph', ordinal: 1, text: '业务说明' },
    { kind: 'paragraph', ordinal: 2, text: '中文段落，保留 & 符号' },
    { kind: 'paragraph', ordinal: 3, text: '第三段' },
  ])
  assert.ok(result.warnings.some(w => w.code === 'docx_text_only' && w.message.includes('不提供排版页码')))
})

test('加密、损坏、扫描件和空正文均明确失败，不能当作已读取成功', async () => {
  const brokenXml = unzipSync(docxBytes())
  brokenXml['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>残缺正文')
  const cases = [
    ['加密.pdf', pdfBytes(['秘密'], { encrypted: true }), 'encrypted_document'],
    // Ghostscript 生成的有效空用户口令 PDF，解析器可打开也必须明确报告加密。
    ['空口令加密.pdf', readFileSync(new URL('./fixtures/document-password-empty.pdf', import.meta.url)), 'encrypted_document'],
    ['损坏.pdf', Buffer.from('%PDF-1.7\nnot a pdf'), 'invalid_document'],
    ['扫描.pdf', pdfBytes([null]), 'no_readable_text'],
    ['空白.pdf', pdfBytes(['']), 'no_readable_text'],
    ['损坏.docx', Buffer.from('not a docx'), 'invalid_document'],
    ['残缺正文.docx', zipSync(brokenXml), 'invalid_document'],
    ['空白.docx', docxBytes(['']), 'no_readable_text'],
    ['旧版.docx', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'encrypted_or_unsupported_document'],
    ['乱码.txt', Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'invalid_encoding'],
    ['二进制.txt', Buffer.from('hello\0world'), 'invalid_document'],
    ['空白.txt', Buffer.from('\n \n'), 'no_readable_text'],
  ]
  for (const [filename, bytes, code] of cases) {
    await assert.rejects(parseDocument({ filename, bytes }), error => {
      assert.ok(error instanceof DocumentParseError, filename)
      assert.equal(error.code, code, filename)
      assert.equal(error.sourceSha256, createHash('sha256').update(bytes).digest('hex'))
      if (code === 'no_readable_text' && filename.endsWith('.pdf')) assert.ok(error.warnings.some(w => w.code === 'empty_pdf_page'))
      return true
    })
  }
})

test('DOCX 仅提取链接文字，不访问文档中的互联网或本地服务引用', async t => {
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.end('不应读取') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const files = unzipSync(docxBytes())
  files['word/document.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="external"><w:r><w:t>外部知识链接</w:t></w:r></w:hyperlink></w:p></w:body></w:document>')
  files['word/_rels/document.xml.rels'] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="http://127.0.0.1:${server.address().port}/knowledge"/></Relationships>`)
  const result = await parseDocument({ filename: 'external.docx', bytes: zipSync(files) })
  assert.equal(result.blocks[0].text.trim(), '外部知识链接')
  assert.equal(requests, 0)
})

test('格式、源文件大小和页数上限在返回完整结果前核对，超限不静默截断', async () => {
  await assert.rejects(parseDocument({ filename: 'old.doc', bytes: Buffer.from('text') }), { code: 'unsupported_format' })
  await assert.rejects(parseDocument({ filename: 'empty.txt', bytes: Buffer.alloc(0) }), { code: 'empty_document' })
  await assert.rejects(parseDocument({ filename: 'large.txt', bytes: Buffer.alloc(DOCUMENT_LIMITS.bytes + 1) }), { code: 'document_too_large' })
  await assert.rejects(parseDocument({ filename: 'pages.pdf', bytes: pdfBytes(['中文'], { pageCount: DOCUMENT_LIMITS.pdfPages + 1 }) }), { code: 'too_many_pages' })
  const expanded = Buffer.from(docxBytes())
  const centralDirectory = expanded.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  expanded.writeUInt32LE(DOCUMENT_LIMITS.expandedDocxBytes + 1, centralDirectory + 24)
  await assert.rejects(parseDocument({ filename: 'expanded.docx', bytes: expanded }), { code: 'expanded_document_too_large' })
})

test('取消会终止解析 Worker 并保持 Host 事件循环可用，取消后可继续读取', async t => {
  const reason = new Error('用户取消文档读取')
  const controller = new AbortController()
  let timerRan = false
  const terminate = Worker.prototype.terminate
  const stop = t.mock.method(Worker.prototype, 'terminate', function () { return terminate.call(this) })
  const started = Date.now()
  const parsing = parseDocument({ filename: '大文档.docx', bytes: docxBytes(Array(60_000).fill('中文知识片段')), signal: controller.signal })
  setTimeout(() => { timerRan = true; controller.abort(reason) }, 250)
  await assert.rejects(parsing, error => error === reason)
  assert.equal(timerRan, true)
  assert.equal(stop.mock.callCount(), 1, '取消调用真实 Worker.terminate，不能只丢弃晚到的解析结果')
  assert.ok(Date.now() - started < 5000, '取消应终止 CPU 解析，无需等解析超时')
  const followup = await parseDocument({ filename: '继续.txt', bytes: Buffer.from('仍可读取') })
  assert.equal(followup.blocks[0].text, '仍可读取')
  const cancelled = AbortSignal.abort(reason)
  await assert.rejects(parseDocument({ filename: '取消.txt', bytes: Buffer.from('未读取'), signal: cancelled }), error => error === reason)
})

test('构建后的独立 Worker 使用同一本地依赖与资源，不引入 canvas 渲染依赖', async () => {
  const built = await import('../lib/document-parser.js')
  const result = await built.parseDocument({ filename: 'built.pdf', bytes: pdfBytes(['构建后的中文资料']) })
  assert.equal(result.blocks[0].text.trim(), '构建后的中文资料')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dependencies.unpdf, '2.0.0')
  assert.equal(manifest.dependencies.mammoth, '1.13.0')
  assert.equal(manifest.dependencies['pdfjs-dist'], '6.4.299')
  const lock = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')
  assert.doesNotMatch(lock, /^  '@napi-rs\/canvas(?:-|@)/m, 'lock 不包含原生渲染依赖解析项')
})
