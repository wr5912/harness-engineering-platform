import { join } from 'node:path'

/** 业务规则仍来自数据扩展；此处只接入独立 Runtime 的原生连接和模型服务。 */
export function populateSecurityOperations(ctx: any, options: { root: string; sourceDigest: string }, business: {
  createThreatRuntime?: (...args: any[]) => any
  createNativeThreatServices?: (...args: any[]) => any
  assetAlertsFlow?: any
  createSoc?: (...args: any[]) => any
  workflows?: Record<string, (soc: any) => any>
}) {
  const extension = ctx.platformMcp.compositionExtension
  const threat = business.createThreatRuntime && business.createNativeThreatServices ? business.createThreatRuntime(options.root, business.createNativeThreatServices(options.root,
    (request: any, signal?: AbortSignal) => ctx.platformMcp.dispatch(request, signal), ctx.llm,
    () => ctx.settingsController.describe().namespaces.find((item: any) => item.ns === 'agent-default-model')?.value,
    () => ctx.platformMcp.servers.get()), { stateRoot: join(process.env.DSH_HOME || '/var/lib/dsh', 'standalone/artifacts/security-operations') }) : undefined
  const soc = business.createSoc?.((request: any, signal?: AbortSignal) => ctx.platformMcp.dispatch(request, signal), () => ctx.platformMcp.servers.get())
  const workflows = Object.fromEntries(Object.entries(business.workflows ?? {}).map(([id, create]) => [id, create(soc)]))
  ctx.effect(() => {
    Object.assign(extension, { id: 'security-operations-compositions', sourceDigest: options.sourceDigest, threat, flow: business.assetAlertsFlow, workflows })
    return () => { for (const key of ['id', 'sourceDigest', 'threat', 'flow', 'workflows']) delete extension[key] }
  })
}
