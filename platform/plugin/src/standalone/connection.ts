import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { existsSync } from 'node:fs'
import { runtimeModule } from '../../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'

const manifest = '/opt/dsh/packages/client/connection/package.json'
const Native = await runtimeModule('@deepseek-ai/dsh-client-connection', existsSync(manifest) ? manifest : undefined)
export const name = 'standalone-connection'
export const inject = ['webServer']
export const Config = Native.Config

/** 独立实例共享原生 owner Peer；不签发登录身份、Cookie 或访问 Token。 */
export function apply(ctx: any, config: any) {
  const connection = new Native.HostConnectionService(ctx, config.trustedHosts ?? [], {
    isAuthenticated: () => true,
    authenticateApi: () => undefined,
    authorizeIndex: () => true,
    authenticatedUrl: (base: string) => base,
    authorizeConnect: (_req: any, res: any) => { res.writeHead(302, { location: './api/remote.mux' }); res.end() },
  })
  const handler = connection.createSharedFetchHandler(Native.API_PATH)
  ctx.on('webserver/index-inject', (table: any[]) => table.push({ kind: 'global', name: '__DSH_CONNECTION_RECOVERY__', value: config.recovery }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: Native.API_PATH, handler: async (req: any, res: any) => {
    const admission = connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('forbidden'); return }
    await ctx.waterfall('connection/request', req, res, async () => {
      const abort = new AbortController()
      res.once('close', () => { if (!res.writableFinished) abort.abort() })
      const method = req.method || 'GET'
      const url = new URL(req.url || '/', 'http://dsh.internal')
      const bounded = handler.requestBodyMode({ method, url }) === 'buffered'
      let received = 0
      const body = req.pipe(new Transform({ transform(chunk, _encoding, callback) {
        received += chunk.length
        if (bounded && received > (config.maxRequestBodyBytes ?? 314572800)) callback(Object.assign(new Error('request body too large'), { status: 413 }))
        else callback(null, chunk)
      } }))
      try {
        const response = await handler.fetch(new Request(url, {
          method, headers: req.headers,
          ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(body) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
          signal: abort.signal,
        } as RequestInit), admission.peer)
        res.writeHead(response.status, Object.fromEntries(response.headers))
        if (response.body) await pipeline(Readable.fromWeb(response.body as any), res)
        else res.end()
      } catch (error: any) {
        if (!res.headersSent) { res.writeHead(error.status === 413 || error.cause?.status === 413 ? 413 : 500); res.end('request failed') }
        else res.destroy()
      } finally { body.destroy() }
    })
  } }), 'standalone connection: native API carrier')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: Native.CONNECT_PATH,
    handler: (req: any, res: any) => connection.authorizeConnect(req, res) }))
}
