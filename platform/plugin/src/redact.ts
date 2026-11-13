const secretKey = /^(?:.*(?:api[_-]?key|password|passwd|secret|authorization|cookie|credential)|(?:access[_-]?|refresh[_-]?)?token)$/i
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, secretKey.test(key) && !/(?:_configured|_ref)$/.test(key) ? '[REDACTED]' : redactValue(entry)]))
  return typeof value === 'string' ? redactPatterns(value) : value
}
function redactPatterns(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"'&\\]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|password|passwd|secret|authorization|cookie|(?:access[_-]?|refresh[_-]?)?token)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,"'&}]+)/gi, '$1"[REDACTED]"')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
}

/** 对日志或导出副本隐藏凭据，完整文本不截断。 */
export function redactText(text: string): string {
  try { return JSON.stringify(redactValue(JSON.parse(text)), null, 2) + (text.endsWith('\n') ? '\n' : '') }
  catch {
    return text.split('\n').map(line => {
      if (/^\s*\{/.test(line)) {
        try { return JSON.stringify(redactValue(JSON.parse(line))) } catch { /* 普通日志继续按文本脱敏。 */ }
      }
      return redactPatterns(line)
    }).join('\n')
  }
}
