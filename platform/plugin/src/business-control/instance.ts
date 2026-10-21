import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { instanceStateRoot, workspaceIdentity, workspaceOwnsInstance } from '../workspace.ts'
import type { InstanceBinding } from './contracts.ts'

export interface BusinessGatewayInstance { agentId: string; instanceId: string; sourceId?: string; sourceDigest?: string; accessMode?: 'authenticated' | 'anonymous'; identityMode?: 'development' | 'published' }
export interface RegisteredBusinessInstance { binding: InstanceBinding; origin: string; basePath: string }

/** 平台链接与网关代理共用同一份实例来源核对。 */
export function resolveBusinessInstance(assetRoot: string, selected: BusinessGatewayInstance): RegisteredBusinessInstance {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selected.instanceId)) throw new Error('业务实例名称无效')
  const manifest = JSON.parse(readFileSync(join(instanceStateRoot(assetRoot), selected.instanceId, 'instance.json'), 'utf8'))
  if (!workspaceOwnsInstance(assetRoot, manifest) || manifest.agent_id !== selected.agentId) throw new Error('业务实例归属不匹配')
  const registration = manifest.business_control
  if (!registration || typeof registration.runtime_generation !== 'string' || !registration.runtime_generation || typeof registration.source_digest !== 'string' || !registration.source_digest) throw new Error('实例没有已核对的业务接入登记')
  if (selected.sourceId && manifest.source_id !== selected.sourceId || selected.sourceDigest && registration.source_digest !== selected.sourceDigest) throw new Error('业务实例来源与网关登记不一致')
  const url = new URL(registration.origin)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('业务实例接入地址无效')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error('业务 Runtime 必须使用本机或私网地址')
  const expectedBase = `/agents/${selected.agentId}/instances/${selected.instanceId}/`
  if (manifest.web_base_path !== expectedBase) throw new Error('业务实例 Web 基址与实例入口不一致')
  return { origin: url.origin, basePath: expectedBase.replace(/\/$/, ''), binding: { workspaceId: workspaceIdentity(assetRoot).id, agentId: selected.agentId, instanceId: selected.instanceId, runtimeGeneration: registration.runtime_generation, sourceDigest: registration.source_digest } }
}
