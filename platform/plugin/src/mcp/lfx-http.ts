import { redactText } from '../redact.ts'

/** 普通请求和执行流共用错误回执，保留阶段及上游原因，不输出完整请求数据。 */
export async function lfxHttpError(status: number, method: string, path: string, body: AsyncIterable<Uint8Array> | null): Promise<Error> {
  const chunks: Buffer[] = []
  let length = 0
  if (body) for await (const chunk of body) {
    const bytes = Buffer.from(chunk)
    chunks.push(bytes.subarray(0, Math.max(0, 8192 - length)))
    length += bytes.length
    if (length >= 8192) break
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let detail = text
  try {
    const value = JSON.parse(text)
    const reason = value.detail ?? value.message ?? value.error
    detail = typeof reason === 'string' ? reason : Array.isArray(reason)
      ? reason.map(item => typeof item === 'string' ? item : [item.loc?.join('.'), item.msg].filter(Boolean).join(': ')).join('; ')
      : ''
  } catch { /* 非 JSON 响应保留有限的文本诊断。 */ }
  const safe = redactText(detail).replace(/\s+/g, ' ').trim().slice(0, 500)
  return new Error(`LFX 请求失败（${status}，${method} ${path}）${safe ? `：${safe}` : ''}`)
}
