import type { IncomingMessage, ServerResponse } from 'node:http'
import { Worker } from 'node:worker_threads'
export { transformClientUrls } from './client-urls.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => any

/** 在原生注册边界挂载站点；协议、路由所有者与流式响应继续由 DSH 执行。 */
export function createMountedWebServer(NativeWebServer: any, basePath: string, productTitle?: string, configSchema = NativeWebServer.Config): any {
  if (!/^\/(?:[a-z][a-z0-9-]*\/)+$/.test(basePath)) throw new Error(`无效 Web 基址：${basePath}`)
  const prefix = basePath.slice(0, -1)
  return class MountedWebServer extends NativeWebServer {
    static Config = configSchema
    readonly basePath = basePath
    private readonly siteContext: any
    private readonly clientSources = new Map<string, Promise<string>>()
    private clientWorker?: Worker
    private clientRequestId = 0
    private clientClosed = false
    private readonly clientRequests = new Map<number, { resolve(code: string): void; reject(error: Error): void }>()

    constructor(ctx: any, config: any) {
      super(ctx, config)
      this.siteContext = ctx
      ctx.effect(() => () => {
        this.clientClosed = true
        const worker = this.clientWorker
        if (worker) this.failClientWorker(worker)
        return worker?.terminate()
      }, 'web adapter: client URL transformer')
    }

    private failClientWorker(worker: Worker): void {
      if (this.clientWorker !== worker) return
      this.clientWorker = undefined
      for (const request of this.clientRequests.values()) request.reject(new Error('客户端路径转换不可用'))
      this.clientRequests.clear()
    }

    /** 大插件包的 AST 解析不占用承载业务租约与控制握手的主线程。 */
    private transformClient(source: string): Promise<string> {
      if (this.clientClosed) return Promise.reject(new Error('Web 服务已关闭'))
      if (!this.clientWorker) {
        const worker = this.clientWorker = new Worker(new URL('./client-urls-worker.mjs', import.meta.url))
        worker.on('message', (result: { id: number; code?: string }) => {
          const request = this.clientRequests.get(result.id)
          if (!request) return
          this.clientRequests.delete(result.id)
          if (typeof result.code === 'string') request.resolve(result.code)
          else request.reject(new Error('客户端路径转换失败'))
          if (!this.clientRequests.size) worker.unref()
        })
        worker.on('error', () => this.failClientWorker(worker))
        worker.on('exit', () => this.failClientWorker(worker))
      }
      const worker = this.clientWorker, id = ++this.clientRequestId
      return new Promise<string>((resolve, reject) => {
        this.clientRequests.set(id, { resolve, reject })
        worker.ref()
        try { worker.postMessage({ id, source }) }
        catch { this.failClientWorker(worker); void worker.terminate() }
      })
    }

    publicPath(path: string): string {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('公开站内路径须以单个 / 开头')
      return path === prefix || path.startsWith(basePath) ? path : prefix + path
    }

    private logical(req: IncomingMessage): void {
      req.url = (req.url ?? '/').slice(prefix.length) || '/'
    }

    private resource(resource: (request: Request, peer?: any) => Promise<Response>) {
      return (request: Request, peer?: any) => {
        const url = new URL(request.url)
        url.pathname = url.pathname.slice(prefix.length) || '/'
        return resource(new Request(url, request), peer)
      }
    }

    register(route: any): () => void {
      if (route.resource) {
        const resource = route.kind === 'prefix' && route.path === '/plugins'
          ? async (request: Request, peer?: any) => this.clientResponse(request, await route.resource(request, peer))
          : route.resource
        return super.register({ ...route, path: this.publicPath(route.path), resource: this.resource(resource) })
      }
      const handler: Handler = route.kind === 'prefix' && route.path === '/plugins'
        ? (req, res) => this.serveClients(req, res)
        : route.handler
      return super.register({ ...route, path: this.publicPath(route.path), handler: (req: IncomingMessage, res: ServerResponse) => {
        this.logical(req)
        return handler(req, res)
      } })
    }

    registerUpgrade(route: any): () => void {
      return super.registerUpgrade({ ...route, path: this.publicPath(route.path), handler: (req: IncomingMessage, socket: any, head: Buffer) => {
        this.logical(req)
        return route.handler(req, socket, head)
      } })
    }

    registerFallback(handler: Handler | { resource: (request: Request, peer?: any) => Promise<Response> }): () => void {
      if (typeof handler !== 'function') {
        const resource = this.resource(handler.resource)
        return super.registerFallback({ resource: (request: Request, peer?: any) => {
          const url = new URL(request.url)
          if ((url.pathname === '/' || url.pathname === prefix) && ['GET', 'HEAD'].includes(request.method)) {
            return new Response(null, { status: 302, headers: { location: basePath + url.search, 'cache-control': 'no-store' } })
          }
          if (!url.pathname.startsWith(basePath)) return new Response(null, { status: 404 })
          return resource(request, peer)
        } })
      }
      return super.registerFallback((req: IncomingMessage, res: ServerResponse) => {
        const raw = req.url ?? '/'
        const at = raw.indexOf('?')
        const path = at < 0 ? raw : raw.slice(0, at)
        if ((path === '/' || path === prefix) && ['GET', 'HEAD'].includes(req.method ?? '')) {
          res.writeHead(302, { location: basePath + (at < 0 ? '' : raw.slice(at)), 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (!path.startsWith(basePath)) { res.writeHead(404); res.end(); return }
        this.logical(req)
        return handler(req, res)
      })
    }

    /** 原生 Fetch 与旧 Node 路由共用客户端出口，其他资源与失败响应保持原合同。 */
    private async clientResponse(request: Request, response: Response): Promise<Response> {
      if (!response.ok || !/(?:javascript|ecmascript)/.test(response.headers.get('content-type') ?? '')) return response
      const headers = new Headers(response.headers)
      // 新入口不复用旧 immutable 响应，转换器重启或 HMR 后均重新取实际字节。
      headers.set('cache-control', 'no-store')
      headers.delete('content-length')
      let body: string | undefined
      if (request.method !== 'HEAD' && response.body) {
        const source = await response.text()
        const url = new URL(request.url), key = url.pathname + url.search
        let code = this.clientSources.get(key)
        if (code === undefined) {
          code = this.transformClient(source).then(code => {
            // 当前原生布局在构建时固定产品名；平台沿原有标题投影更换品牌。
            return productTitle === undefined ? code : code.replace('const productTitle = "DeepSeek Harness";', `const productTitle = ${JSON.stringify(productTitle)};`)
          })
          this.clientSources.set(key, code)
          void code.catch(() => { if (this.clientSources.get(key) === code) this.clientSources.delete(key) })
          if (this.clientSources.size > 16) this.clientSources.delete(this.clientSources.keys().next().value!)
        }
        body = await code
      }
      return new Response(body, { status: response.status, statusText: response.statusText, headers })
    }

    private async serveClients(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const registry = this.siteContext.get('clientModules')
      if (!registry?.fetchBundle) throw new Error('当前 Runtime 缺少 clientModules.fetchBundle')
      const request = new Request(new URL(req.url ?? '/', 'http://dsh.invalid'), { method: req.method })
      const response = await this.clientResponse(request, await registry.fetchBundle(request))
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(req.method === 'HEAD' || !response.body ? undefined : Buffer.from(await response.arrayBuffer()))
    }
  }
}

/** 保留既有明确配置的 IPv4 LAN 监听；未来网关私网部署使用原生具体地址。 */
export function legacyLanConfig(NativeWebServer: any, z: any): any {
  return z.object({
    ...NativeWebServer.Config.dict,
    host: z.union([z.const('0.0.0.0'), NativeWebServer.Config.dict.host]).required(),
  })
}
