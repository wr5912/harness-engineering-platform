import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 部署配置在工作区维护，编译产物不固化用户的 URL 前缀。 */
export function sitePath(site: 'assistant' | 'platform'): string {
  // 业务入口由已固定的 Agent 与实例身份推导；历史实例只有 Agent ID。
  const agentId = process.env.HARNESS_BUSINESS_AGENT_ID
  const instanceId = process.env.HARNESS_BUSINESS_INSTANCE_ID
  if (site === 'assistant' && (agentId !== undefined || instanceId !== undefined)) {
    if (!agentId || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(agentId)) throw new Error('无效业务 Agent ID')
    if (instanceId !== undefined && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(instanceId)) throw new Error('无效业务实例 ID')
    return instanceId === undefined ? `/agents/${agentId}/` : `/agents/${agentId}/instances/${instanceId}/`
  }
  const path = process.env.HARNESS_SITES_CONFIG
    || (process.env.HARNESS_ASSET_ROOT ? join(process.env.HARNESS_ASSET_ROOT, 'config', 'sites.json') : undefined)
  const values = path ? JSON.parse(readFileSync(path, 'utf8')) : { assistant: '/assistant/', platform: '/hep/' }
  const value = values[site]
  if (typeof value !== 'string' || !/^\/[a-z][a-z0-9-]*\/$/.test(value)) throw new Error(`无效 ${site} 站点基址`)
  return value
}
