import { runtimeModule } from './resolve-runtime.ts'

const Native = await runtimeModule('@deepseek-ai/dsh-web-app', '/opt/dsh/packages/bundle/web-app/package.json')
export const name = Native.name
export const Config = Native.Config
export const inject = Native.inject

/** rc.2 原生 publicUrl 统一启动链接、webApp 和 Shell 中的站点地址。 */
export function apply(ctx: any, config: any): void {
  const origin = new URL(ctx.webServer.getOrigin())
  if (origin.hostname === '0.0.0.0' || origin.hostname === '[::]') origin.hostname = '127.0.0.1'
  const publicUrl = config.publicUrl ?? new URL(ctx.webServer.publicPath('/'), origin).href
  Native.apply(ctx, { ...config, publicUrl })
}
