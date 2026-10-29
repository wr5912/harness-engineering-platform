import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { dataPath } from '../tasks/files.ts'
import { DOCUMENT_LIMITS, parseDocument } from '../documents/index.ts'

const MAX_BYTES = DOCUMENT_LIMITS.bytes
const inputSchema = z.object({
  path: z.string().min(1).max(4096),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(512).max(32768).default(16000),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
const cursorSchema = z.object({ source: z.string(), sha256: z.string(), block: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).strict()
type DocumentServices = { attachments: Pick<AttachmentStore, 'fileHostPath' | 'readFileStream'>, fs: Pick<FileSystem, 'processPathFromHostPath'> }
export type DocumentReader = (input: unknown, agent: Agent, signal: AbortSignal) => Promise<unknown>

/** 来源只来自受信任数据根或当前 Session 的原生文件块，不接受外部 Session/附件标识。 */
export function createDocumentReader(assetRoot: string, services: DocumentServices): DocumentReader {
  const root = resolve(assetRoot)
  return async (value, agent, signal) => {
    const input = inputSchema.parse(value)
    signal.throwIfAborted()
    const refs: FileAttachmentRef[] = []
    for (const message of agent.session.deriveMessages()) {
      if (message.role !== 'user') continue
      for (const block of message.content) if (block.type === 'file') refs.push(block.attachment)
    }
    const attachment = refs.find(ref => {
      const hostPath = services.attachments.fileHostPath(ref)
      return hostPath !== undefined && services.fs.processPathFromHostPath(hostPath) === input.path
    })
    let bytes: Uint8Array
    let filename: string
    const sourceKind = attachment ? 'attachment' : 'workspace'
    if (attachment) {
      if (attachment.bytes > MAX_BYTES) throw new Error('文档超过 32 MiB，请拆分后读取')
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of services.attachments.readFileStream(attachment, signal)) {
        signal.throwIfAborted()
        size += chunk.byteLength
        if (size > MAX_BYTES) throw new Error('文档超过 32 MiB，请拆分后读取')
        chunks.push(chunk)
      }
      // 原生流在 EOF 核对附件摘要；完整消费后才能使用正文。
      bytes = Buffer.concat(chunks)
      filename = attachment.name
    } else {
      const path = isAbsolute(input.path) ? relative(root, input.path) : input.path
      if (path.split('/').some(part => ['.git', '.local', '.env'].includes(part) || part.endsWith('.llm-api-key'))) throw new Error('此路径不是可导入的知识文档')
      const location = dataPath(root, path)
      const file = await open(location, 'r')
      try {
        const stat = await file.stat()
        if (!stat.isFile()) throw new Error('请选择文档文件')
        if (stat.size > MAX_BYTES) throw new Error('文档超过 32 MiB，请拆分后读取')
        // 有界读取，文件在读取期间增长也不能绕过大小限制。
        const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1))
        let size = 0
        while (size < buffer.length) {
          signal.throwIfAborted()
          const read = await file.read(buffer, size, buffer.length - size)
          if (!read.bytesRead) break
          size += read.bytesRead
        }
        if (size > MAX_BYTES || size > stat.size) throw new Error('文档在读取期间发生变化，请重试')
        bytes = buffer.subarray(0, size)
        filename = basename(location)
      } finally { await file.close() }
    }
    signal.throwIfAborted()
    const document = await parseDocument({ bytes, filename, signal })
    const source = createHash('sha256').update(`${sourceKind}:${input.path}`).digest('hex')
    if (input.source_sha256 && input.source_sha256 !== document.sourceSha256) throw new Error('文档已变化，请从第一页重新读取并核对来源')
    let blockIndex = 0, offset = 0
    if (input.cursor) {
      let cursor
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))) }
      catch { throw new Error('文档分页游标无效，请从第一页重新读取') }
      if (cursor.source !== source || cursor.sha256 !== document.sourceSha256) throw new Error('游标与当前文档或版本不一致，请从第一页重新读取')
      blockIndex = cursor.block
      offset = cursor.offset
      if (blockIndex >= document.blocks.length || offset > document.blocks[blockIndex].text.length) throw new Error('文档分页位置无效')
    }
    const blocks = []
    let remaining = input.limit
    while (blockIndex < document.blocks.length && remaining > 0 && blocks.length < 32) {
      const block = document.blocks[blockIndex]
      let end = Math.min(block.text.length, offset + remaining)
      // 分片不能拆开 UTF-16 代理对，重组后的正文与来源保持一致。
      if (end < block.text.length && /[\uD800-\uDBFF]/.test(block.text[end - 1])) end--
      if (end === offset && block.text.length > offset) break
      blocks.push({ ...block, text: block.text.slice(offset, end), start_offset: offset, end_offset: end })
      remaining -= end - offset
      if (end === block.text.length) { blockIndex++; offset = 0 } else offset = end
    }
    const hasMore = blockIndex < document.blocks.length
    signal.throwIfAborted()
    return {
      path: input.path, filename, source_kind: sourceKind, source_sha256: document.sourceSha256,
      format: document.format, extraction: 'text-only', blocks_total: document.blocks.length,
      blocks, warnings: document.warnings, has_more: hasMore,
      ...(hasMore ? { next_cursor: Buffer.from(JSON.stringify({ source, sha256: document.sourceSha256, block: blockIndex, offset })).toString('base64url') } : {}),
    }
  }
}
