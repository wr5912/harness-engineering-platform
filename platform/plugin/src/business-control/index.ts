import type { Context } from '@deepseek-ai/cordis'
import { getBusinessControl } from './core.ts'
import { startBusinessGateway } from './gateway.ts'
import { ensureBusinessSecret } from './secret-file.ts'
import { validateBusinessGateway } from './configuration.ts'
export { ensureBusinessSecret, resolveBusinessSecretFile } from './secret-file.ts'
export { startBusinessGateway, allowedBusinessPath, resolveBusinessInstance, signBusinessAssertion, verifyBusinessAssertion, readBusinessSecret, businessRpcDigest } from './gateway.ts'
export type { BusinessGatewayConfig, BusinessGatewayHandle } from './gateway.ts'

/** 管理平台启动独立业务监听；管理登录、owner Connection及浏览器来源保持独立。 */
export async function applyBusinessGateway(ctx: Context, assetRoot: string): Promise<void> {
  const control = getBusinessControl(assetRoot)
  const gateway = control.config().gateway
  if (!control.enabled() || !gateway) return
  validateBusinessGateway(gateway)
  const config = gateway
  config.sharedSecretFile = ensureBusinessSecret(assetRoot, config.sharedSecretFile)
  const handle = await startBusinessGateway(assetRoot, config)
  control.setAvailable(true)
  ctx.effect(() => () => { control.setAvailable(false); return handle.close() }, '业务网关独立监听')
}

export { registerBusinessReport, readBusinessReport, setBusinessReportHeaderResolver } from './reports.ts'
