import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** CLI 与实例管理共用同一业务公开入口合同。 */
export function businessGatewayEntry(assetRoot: string, agentId: string, instanceId: string): string {
  const access = JSON.parse(readFileSync(join(assetRoot, 'config/business-access.json'), 'utf8'))
  const gateway = access.gateway
  if (access.enabled !== true || !gateway?.instances?.some((value: { agentId: string; instanceId: string }) => value.agentId === agentId && value.instanceId === instanceId)) throw new Error('实例未向业务网关开放')
  const origin = new URL(gateway.publicOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('业务网关公开来源无效')
  return `${origin.origin}/agents/${agentId}/`
}
