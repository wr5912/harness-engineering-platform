import type { Context } from '@deepseek-ai/cordis'
import { getBusinessControl } from './core.ts'
import { startBusinessGateway, type BusinessGatewayConfig } from './gateway.ts'
import { ensureBusinessSecret } from './secret-file.ts'
export { ensureBusinessSecret, resolveBusinessSecretFile } from './secret-file.ts'
export { startBusinessGateway, allowedBusinessPath, resolveBusinessInstance, signBusinessAssertion, verifyBusinessAssertion, readBusinessSecret, businessRpcDigest } from './gateway.ts'
export type { BusinessGatewayConfig, BusinessGatewayHandle } from './gateway.ts'

/** 管理平台启动独立业务监听；管理登录、owner Connection及浏览器来源保持独立。 */
export async function applyBusinessGateway(ctx: Context, assetRoot: string): Promise<void> {
  const control = getBusinessControl(assetRoot)
  const gateway = control.config().gateway
  if (!control.enabled() || !gateway) return
  const config = gateway as unknown as BusinessGatewayConfig
  if (typeof config.host !== 'string' || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535
    || typeof config.publicOrigin !== 'string' || typeof config.sharedSecretFile !== 'string' || !Array.isArray(config.instances)) throw new Error('业务网关配置无效')
  config.sharedSecretFile = ensureBusinessSecret(assetRoot, config.sharedSecretFile)
  const handle = await startBusinessGateway(assetRoot, config)
  control.setAvailable(true)
  ctx.effect(() => () => { control.setAvailable(false); return handle.close() }, '业务网关独立监听')
}

export { registerBusinessReport, readBusinessReport, setBusinessReportHeaderResolver } from './reports.ts'
