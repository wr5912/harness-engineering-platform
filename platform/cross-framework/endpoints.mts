import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 复用隔离验收服务写出的地址，避免假定宿主机 Docker 网桥。 */
export function readSampleEndpoints(root: string) {
  const file = join(root, '.local/endpoints.json')
  let input: Record<string, unknown>
  try { input = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('请先启动隔离验收服务，确认 .local/endpoints.json 有效') }
  const endpoints = {} as Record<'origin' | 'fixture' | 'model', string>
  for (const key of ['origin', 'fixture', 'model'] as const) {
    try {
      if (typeof input?.[key] !== 'string') throw new Error()
      const url = new URL(input[key])
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error()
      endpoints[key] = url.href.replace(/\/$/, '')
    } catch { throw new Error(`隔离验收地址配置无效：.local/endpoints.json 的 ${key}`) }
  }
  return endpoints
}
