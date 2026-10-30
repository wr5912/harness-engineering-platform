import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const MAX_DEPTH = 128
const MAX_BYTES = 1024 * 1024

class ArgumentShape {
  private depth = 0
  private quoted = false
  private escaped = false
  private bytes = 0

  accept(delta: string): string | undefined {
    this.bytes += Buffer.byteLength(delta)
    if (this.bytes > MAX_BYTES) return '参数超过 1 MiB，请拆分操作'
    for (const char of delta) {
      if (this.quoted) {
        if (this.escaped) this.escaped = false
        else if (char === '\\') this.escaped = true
        else if (char === '"') this.quoted = false
      } else if (char === '"') this.quoted = true
      else if (char === '{' || char === '[') {
        if (++this.depth > MAX_DEPTH) return `参数嵌套超过 ${MAX_DEPTH} 层，请简化参数结构`
      } else if (char === '}' || char === ']') this.depth--
    }
  }
}

/** 使用原生迭代器关闭取消模型生成；不执行或自动重放异常请求中的工具。 */
export async function* guardToolArguments(stream: AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk> {
  // shortcut: 原生扩展点在增量解析之后；单个响应片段的解析耗时仍需由上游适配器约束。
  const calls = new Map<number, ArgumentShape>()
  let issue: string | undefined
  for await (const chunk of stream) {
    if (chunk.type === 'tool-call-delta') {
      let shape = calls.get(chunk.index)
      if (!shape) calls.set(chunk.index, shape = new ArgumentShape())
      issue = shape.accept(chunk.argumentsDelta)
    } else if (chunk.type === 'block-end') {
      // 有些适配器只发送完整参数；结束块也须检查实际交给工具的内容。
      if (chunk.block.type === 'tool-call') issue = new ArgumentShape().accept(chunk.block.arguments)
      calls.delete(chunk.index)
    }
    if (issue) break
    yield chunk
  }
  if (issue) yield { type: 'finish', reason: { kind: 'error', failure: {
    code: 'TOOL_ARGUMENT_LIMIT', message: `模型生成的工具${issue}。本轮请求已停止，工具未执行；可重新发起请求。`,
  } } }
}
