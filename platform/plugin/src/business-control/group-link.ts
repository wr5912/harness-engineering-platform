import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceConfigPath } from '../workspace.ts'

/** 管理入口是可编辑来源；浏览器链接、公告与业务 Runtime 共用它。 */
export function platformEntryUrl(assetRoot: string, startup?: { fallback: string; publicUrl?: string }): string {
  const path = join(assetRoot, 'config', 'business-access.json')
  const access = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, enabled: false, agents: [] }
  const configured = access.gateway?.managementUrl || startup?.publicUrl || startup?.fallback
  if (typeof configured !== 'string') throw new Error('业务网关缺少平台管理入口')
  const base = new URL(configured)
  const sitesPath = workspaceConfigPath(assetRoot, 'sites.json')
  const basePath = existsSync(sitesPath) ? JSON.parse(readFileSync(sitesPath, 'utf8')).platform : base.pathname
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('平台站点基址无效')
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search
    || base.pathname !== basePath) throw new Error('平台管理入口与站点基址不一致')
  base.hash = ''
  if (startup?.publicUrl && new URL(startup.publicUrl).href !== base.href) {
    throw new Error('DSH publicUrl 与 config/business-access.json 的 gateway.managementUrl 不一致，请统一平台入口')
  }
  if (startup && !access.gateway?.managementUrl) {
    access.gateway ??= {}
    access.gateway.managementUrl = base.href
    const temporary = `${path}.${process.pid}.tmp`
    mkdirSync(join(assetRoot, 'config'), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  }
  return base.href
}

export function platformGroupUrl(assetRoot: string, groupId: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(groupId)) throw new Error('平台 MCP 分组 ID 无效')
  return new URL(`mcp/groups/${groupId}/v2`, platformEntryUrl(assetRoot)).href
}

/** 组形态的地址必须与当前受信平台入口逐字一致，禁止落到任意同形 URL。 */
export function platformGroupServer(assetRoot: string, server: { id?: string; url?: string }): boolean {
  if (!server.url) return false
  const url = new URL(server.url)
  if (!/\/mcp\/groups\/[^/]+\/v2$/.test(url.pathname)) return false
  if (url.href !== platformGroupUrl(assetRoot, server.id ?? '')) throw new Error('平台 MCP 分组连接地址与受信入口不一致')
  return true
}
