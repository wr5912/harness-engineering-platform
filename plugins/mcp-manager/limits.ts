export const MAX_CATALOG_BYTES = 8 * 1024 * 1024
export const MAX_CATALOG_ITEMS = 2000
const MAX_NODES = 100_000
const MAX_DEPTH = 64

/** 预算按完整发现累计；共享引用的每次输出都计费。 */
export class DiscoveryBudget {
  private nodes = 0
  private bytes = 0
  constructor(private readonly source: string) {}

  fail(kind: string, limit: number, location: string): never {
    throw new Error(`${this.source}：发现目录超出${kind}上限 ${limit}（${location}）；请缩小接口规范或分组后重新发现`)
  }

  node(depth: number, location: string) {
    if (depth > MAX_DEPTH) this.fail('嵌套深度', MAX_DEPTH, location)
    if (++this.nodes > MAX_NODES) this.fail('累计展开节点', MAX_NODES, location)
  }

  value(value: unknown, location: string, depth = 0): void {
    this.node(depth, location)
    if (value === undefined) return
    if (value && typeof value === 'object') {
      this.bytes += 2
      for (const [key, item] of Object.entries(value)) {
        this.bytes += Buffer.byteLength(JSON.stringify(key)) + 2
        this.value(item, location, depth + 1)
      }
    } else this.bytes += Buffer.byteLength(JSON.stringify(value))
    if (this.bytes > MAX_CATALOG_BYTES) this.fail('累计目录字节', MAX_CATALOG_BYTES, location)
  }
}

export async function limitedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  let done = false, bytes = 0, text = ''
  const decoder = new TextDecoder()
  try {
    if (Number(response.headers.get('content-length')) > limit) throw new Error(`上游响应超过 ${limit} 字节上限`)
    while (true) {
      const next = await reader.read()
      if (next.done) { done = true; return text + decoder.decode() }
      bytes += next.value.byteLength
      if (bytes > limit) throw new Error(`上游响应超过 ${limit} 字节上限（已读取 ${bytes} 字节）；请缩小响应`)
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
