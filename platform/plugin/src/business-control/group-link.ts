import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 从既有平台入口与站点基址导出唯一可用的业务分组目标。 */
export function platformGroupUrl(assetRoot: string, groupId: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(groupId)) throw new Error('平台 MCP 分组 ID 无效')
  const access = JSON.parse(readFileSync(join(assetRoot, 'config', 'business-access.json'), 'utf8'))
  const sites = JSON.parse(readFileSync(join(assetRoot, 'config', 'sites.json'), 'utf8'))
  const basePath = sites.platform
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('平台站点基址无效')
  const configured = access.gateway?.managementUrl
  if (typeof configured !== 'string') throw new Error('业务网关缺少平台管理入口')
  const base = new URL(configured)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search
    || base.pathname !== basePath) throw new Error('平台管理入口与站点基址不一致')
  base.hash = ''
  return new URL(`mcp/groups/${groupId}/v2`, base).href
}

/** 组形态的地址必须与当前受信平台入口逐字一致，禁止落到任意同形 URL。 */
export function platformGroupServer(assetRoot: string, server: { id?: string; url?: string }): boolean {
  if (!server.url) return false
  const url = new URL(server.url)
  if (!/\/mcp\/groups\/[^/]+\/v2$/.test(url.pathname)) return false
  if (url.href !== platformGroupUrl(assetRoot, server.id ?? '')) throw new Error('平台 MCP 分组连接地址与受信入口不一致')
  return true
}
