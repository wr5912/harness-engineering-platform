import { join } from 'node:path'

/** 业务规则仍来自数据扩展；此处只接入独立 Runtime 的原生连接和模型服务。 */
export function populateSecurityOperations(ctx: any, options: { root: string; sourceDigest: string }, business: {
  createThreatRuntime: (...args: any[]) => any
  createNativeThreatServices: (...args: any[]) => any
  assetAlertsFlow: any
}) {
  const extension = ctx.platformMcp.compositionExtension
  const threat = business.createThreatRuntime(options.root, business.createNativeThreatServices(options.root,
    (request: any, signal?: AbortSignal) => ctx.platformMcp.dispatch(request, signal), ctx.llm,
    () => ctx.settingsController.describe().namespaces.find((item: any) => item.ns === 'agent-default-model')?.value,
    () => ctx.platformMcp.servers.get()), { stateRoot: join(process.env.DSH_HOME || '/var/lib/dsh', 'standalone/artifacts/security-operations') })
  ctx.effect(() => {
    Object.assign(extension, { id: 'security-operations-compositions', sourceDigest: options.sourceDigest, threat, flow: business.assetAlertsFlow })
    return () => { for (const key of ['id', 'sourceDigest', 'threat', 'flow']) delete extension[key] }
  })
}
