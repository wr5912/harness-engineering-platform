export type Soc = ((connection: string, operation: string, args: Record<string, any>, signal: AbortSignal, expected?: string) => Promise<any>) & { fingerprint?: (connection: string) => string; describe?: (connection: string, operation: string, signal: AbortSignal) => Promise<any>; propose?: (input: any, signal: AbortSignal) => Promise<any> }

export function unpack(value: any): any {
  const content = value?.contents ?? value?.content
  const nested = value?.structuredContent ?? (Array.isArray(content) ? JSON.parse(content.filter(item => item.type === 'text' || typeof item.text === 'string').map(item => item.text).join('\n')) : undefined)
  if (nested !== undefined) {
    const result = unpack(nested)
    if (value.isError || value.ok === false) throw new Error(String(result.msg ?? result.message ?? result.error ?? '上游调用失败'))
    return result
  }
  if (!value || typeof value !== 'object') throw new Error('上游返回格式无效')
  if (value.isError || value.ok === false || value.code !== undefined && ![0, 200, '0', '200'].includes(value.code)) throw new Error([value.code, value.msg ?? value.message ?? value.error ?? '上游业务失败', value.traceId && `traceId=${value.traceId}`].filter(item => item !== undefined && item !== false).join(' '))
  return value
}

export function data(value: any): any { return value.data ?? value }
export function rows(value: any): any[] {
  const result = value.rows ?? data(value)?.records ?? data(value)?.rows ?? data(value)?.list ?? data(value)
  if (!Array.isArray(result)) throw new Error('上游缺少列表，不能按空结果继续')
  return result
}

export function api(soc: Soc, config: any, context: any) {
  return async (alias: string, operation: string, args: Record<string, any>, read = false) => {
    const connection = config.connections[alias]
    if (!connection) throw new Error(`缺少连接：${alias}`)
    for (let attempt = 0; ; attempt++) {
      try {
        const value = await context.call(() => soc(connection, operation, args, context.signal, context.shared?.connection_fingerprints?.[connection]))
        return unpack(value)
      } catch (error: any) {
        if (!read || attempt === 2 || context.signal.aborted || !/ECONNRESET|ETIMEDOUT|fetch failed|\b50[234]\b|\b429\b/.test(error.message)) throw error
      }
    }
  }
}

export function prepare(soc: Soc, input: any, config: any) {
  return { connection_fingerprints: Object.fromEntries(Object.values(config.connections).map((id: any) => [id, soc.fingerprint?.(id)])) }
}

export function validateParameters(schema: any, params: any) {
  const issues: string[] = []
  for (const name of schema?.required ?? []) if (params[name] === undefined || params[name] === '') issues.push(`缺少 ${name}`)
  for (const [name, rule] of Object.entries<any>(schema?.properties ?? {})) {
    const value = params[name]
    if (value === undefined) continue
    if (rule.type === 'integer' ? !Number.isInteger(value) : rule.type === 'array' ? !Array.isArray(value) : rule.type && typeof value !== rule.type) issues.push(`${name} 类型不符`)
    if (rule.enum && !rule.enum.includes(value)) issues.push(`${name} 不在当前枚举中`)
    if (typeof value === 'number' && (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) issues.push(`${name} 超出允许范围`)
  }
  if (issues.length) throw new Error(issues.join('；'))
}
