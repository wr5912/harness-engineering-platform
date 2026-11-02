import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export interface ConnectorConfiguration {
  instanceId: string
  clientId: string
  secretFile: string
  tokenEndpoint: string
  resourceUrl: string
  audience: string
  scopes: string[]
  host?: string
  port?: number
}
/** 一个进程只绑定一个实例和一个资源；模型不能选择目标或声明。 */
export function createResourceConnector(config: ConnectorConfiguration) {
  for (const input of [config.tokenEndpoint, config.resourceUrl]) {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('connector 目标配置无效')
  }
  if (!config.instanceId || !config.clientId || !config.secretFile || !config.audience || !config.scopes.length) throw new Error('connector 缺少固定实例与资源配置')
  let cache: { token: string; expiresAt: number; secret: string } | undefined
  let pending: Promise<string> | undefined
  async function acquire(signal: AbortSignal): Promise<string> {
    const secret = readFileSync(config.secretFile, 'utf8').trim()
    if (cache?.secret === secret && cache.expiresAt > Date.now()) return cache.token
    if (pending) return pending
    pending = (async () => {
      const response = await fetch(config.tokenEndpoint, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', resource: config.audience, scope: config.scopes.join(' ') }), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
      if (!response.ok) throw new Error(`签名资源凭证申请失败（HTTP ${response.status}）`)
      const result = await response.json() as { access_token?: unknown; expires_in?: unknown; token_type?: unknown }
      if (typeof result.access_token !== 'string' || typeof result.expires_in !== 'number' || result.expires_in <= 0 || result.token_type !== 'Bearer') throw new Error('签发响应无效')
      cache = { token: result.access_token, secret, expiresAt: Date.now() + Math.max(1, result.expires_in * 0.9) * 1000 }
      return cache.token
    })()
    try { return await pending } finally { pending = undefined }
  }
  async function handler(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    if (req.url !== '/mcp' || req.method !== 'POST') { send(404, { error: 'not_found' }); return }
    const abort = new AbortController(); res.once('close', () => { if (!res.writableEnded) abort.abort() })
    try {
      let text = ''
      for await (const chunk of req) { text += chunk; if (text.length > 1024 * 1024) { send(413, { error: 'request_too_large' }); return } }
      const input = JSON.parse(text)
      if (!input || input.jsonrpc !== '2.0' || !['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(input.method)) { send(400, { error: 'invalid_request' }); return }
      const invoke = async () => fetch(config.resourceUrl, { method: 'POST', headers: { authorization: `Bearer ${await acquire(abort.signal)}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: text, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) })
      let response = await invoke()
      let invalidated = response.status === 401
      if (response.status === 403) {
        try { invalidated = (await response.clone().json() as { error?: unknown }).error === 'invalid_token' } catch { /* 非结构化拒绝不重试。 */ }
      }
      // 专用资源入口的凭证失效在业务派发前返回；只重取一次，不重放结果未知请求。
      if (invalidated) { cache = undefined; response = await invoke() }
      if (response.status === 202) { res.writeHead(202); res.end(); return }
      const result = await response.text()
      // 错误只回传平台结构化结果，绝不回显长期 key 或 token。
      res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(result)
    } catch {
      send(503, { error: 'signed_resource_unavailable', message: '该签名资源暂不可用；其他原有服务继续按原方式调用' })
    }
  }
  return { handler, server: createServer((req, res) => { void handler(req, res) }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as ConnectorConfiguration
  const connector = createResourceConnector(config)
  connector.server.listen(config.port ?? 0, config.host ?? '127.0.0.1', () => {
    // 配置、地址和实例秘密不写入启动日志。
    process.stdout.write(JSON.stringify({ event: 'connector-ready', port: (connector.server.address() as { port: number }).port }) + '\n')
  })
}
