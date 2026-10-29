import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

export const name = 'harness-offline-knowledge'
export const inject = ['web']
export const OFFLINE_KNOWLEDGE_PROVIDER_ID = 'harness-offline-knowledge'
export interface Config { indexPath: string }
interface Source { url: string; finalUrl?: string; path: string; readablePath?: string; readableSha256?: string; sha256: string; bodyKind: 'html' | 'text' }
interface Index { schemaVersion: number; kind: string; sources: Source[] }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const canonical = (value: string) => { const url = new URL(value); url.hash = ''; return url.href }

/** 仅使用已归档资料；未命中不转交公网提供方。 */
export function createOfflineKnowledgeProvider(indexPath: string) {
  const file = resolve(indexPath), root = dirname(file)
  async function local(path: string): Promise<Buffer> {
    const target = await realpath(resolve(root, path))
    const actualRoot = await realpath(root)
    if (target !== actualRoot && !target.startsWith(actualRoot + sep)) throw new Error('离线参考文件超出归档目录')
    return readFile(target)
  }
  return {
    id: OFFLINE_KNOWLEDGE_PROVIDER_ID,
    available: () => true,
    async fetch(request: { url: string }, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const index = JSON.parse(await readFile(file, 'utf8')) as Index
      if (index.schemaVersion !== 1 || index.kind !== 'harness-offline-knowledge' || !Array.isArray(index.sources)) throw new Error('离线参考索引无效，请校验安装包')
      const source = index.sources.find(source => canonical(source.url) === canonical(request.url) || source.finalUrl !== undefined && canonical(source.finalUrl) === canonical(request.url))
      if (!source) throw new Error('此 URL 未包含在离线知识包中；请提供本地资料或重新导出完整离线包')
      const original = await local(source.path)
      if (digest(original) !== source.sha256) throw new Error('离线参考文件摘要不符，请校验安装包')
      const content = source.readablePath ? await local(source.readablePath) : original
      if (source.readablePath && digest(content) !== source.readableSha256) throw new Error('离线参考阅读视图摘要不符，请校验安装包')
      signal?.throwIfAborted()
      return { url: request.url, statusCode: 200, body: { kind: source.readablePath ? 'text' as const : source.bodyKind, content: content.toString('utf8') }, truncated: false }
    },
  }
}

export function apply(ctx: { web: { registerFetchProvider(provider: ReturnType<typeof createOfflineKnowledgeProvider>): () => void }, effect(callback: () => (() => void)): unknown }, config: Config): void {
  if (!config || typeof config.indexPath !== 'string' || !config.indexPath) throw new Error('离线参考资料缺少索引路径')
  ctx.effect(() => ctx.web.registerFetchProvider(createOfflineKnowledgeProvider(config.indexPath)))
}
