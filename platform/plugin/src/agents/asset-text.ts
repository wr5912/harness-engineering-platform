import { createHash } from 'node:crypto'
import { containsLiteralLlmKey } from '../tasks/llm-key.ts'

/** 源码变量引用保持原文；含凭据常量的文本只能查看脱敏预览。 */
export function assetText(path: string, text: string) {
  let content = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[已隐藏]')
    .replace(/\bBearer[ \t]+([A-Za-z0-9._~+/-]{12,}=*)(?=["'`\s]|$)/gi, 'Bearer [已隐藏]')
    .replace(/((?:password|token|api[_-]?key|secret)["']?\s*[:=]\s*)(["'])([^"'\r\n]*)\2/gi, (raw, prefix, quote, value) => !value || value.includes('${') ? raw : `${prefix}${quote}[已隐藏]${quote}`)
  const redacted = content !== text || containsLiteralLlmKey(path, text)
  if (redacted && content === text) content = '[此文件包含 LLM 凭据常量，请从本地专用凭据文件维护]'
  return { content, redacted, editable: !redacted, sha256: createHash('sha256').update(text).digest('hex'),
    content_sha256: createHash('sha256').update(content).digest('hex'),
    ...(redacted ? { reason: '内容已脱敏，不能以预览替换源码；请在本地维护凭据后重新读取。' } : {}) }
}
