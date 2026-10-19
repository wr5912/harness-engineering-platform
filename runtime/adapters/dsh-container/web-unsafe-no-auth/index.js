// 仅适配 source.lock.json 锁定的 HostConnectionService 内部接口；升级 DSH 须重测。
export const name = 'web-unsafe-no-auth'
export const inject = ['connection']

export function apply(ctx) {
  const connection = ctx.connection
  // 无认证模式已向 LAN 浏览器开放 Host API，设置页也需读取同一 Host 文档。
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  })
  const replacements = {
    // rc.2 的 RPC、Fetch 和 WebSocket 从 admit 取得 Peer；沿用本实例既有免认证访问。
    admit: () => ({ peer: connection.browserPeer }),
    requestRejection: () => undefined,
    authorizeIndex: () => true,
    authenticatedUrl: (baseUrl) => {
      const url = new URL(baseUrl)
      if (ctx.webServer?.publicPath) url.pathname = ctx.webServer.publicPath(url.pathname)
      return url.href
    },
  }
  const previous = Object.fromEntries(Object.keys(replacements).map((key) => {
    if (typeof connection[key] !== 'function') throw new Error(`web-unsafe-no-auth: missing ${key}`)
    return [key, Object.getOwnPropertyDescriptor(connection, key)]
  }))
  ctx.effect(() => {
    Object.defineProperties(connection, Object.fromEntries(
      Object.entries(replacements).map(([key, value]) => [key, { configurable: true, value }]),
    ))
    return () => {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(connection, key, descriptor)
        else delete connection[key]
      }
    }
  })
}
