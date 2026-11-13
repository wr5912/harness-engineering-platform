import * as manager from 'harness-mcp-manager-server'
import { readStandaloneConfig } from './config.ts'
import { remoteConnection } from './connections.ts'

export const name = 'standalone-agent'
export const inject = ['webServer', 'connection', 'tools', 'agents', 'workspaceRegistry']
export const validateConfiguration = manager.validateConfiguration
export const Config = undefined

/** 装载业务文件与 DSH 原生 MCP 客户端；组合始终由连接的平台执行。 */
export async function apply(ctx: any, options: { home?: string; root?: string } = {}) {
  const home = options.home || process.env.DSH_HOME || '/var/lib/dsh'
  const config = () => readStandaloneConfig(home)
  const connection = (id: string, version: 1 | 2 = 2) => remoteConnection(config().mcp.servers.find(server => server.id === id), version)
  const groupUrl = (id: string) => new URL(ctx.webServer.publicPath(`/mcp/groups/${id}/v2`), ctx.webServer.getOrigin()).href
  // 原生客户端分组只聚合远端连接；不包含平台组合目录或执行器。
  const mountServers = (servers: any[]) => {
    const { mcp } = config()
    if (!Array.isArray(mcp.mountServerIds)) return servers
    return mcp.mountServerIds.flatMap(id => {
      const direct = servers.find(server => server.id === id)
      if (direct) return [{ ...direct, ...mcp.mountOverrides?.[id] }]
      if (!mcp.groups.some(group => group.id === id)) return []
      return [{ id, enabled: true, url: groupUrl(id), headers: [{ name: 'Authorization', value: `Bearer ${mcp.sharedToken}` }],
        tools: { mode: 'all', names: [] }, platformGroup: true, platformToolResources: true,
        ...mcp.mountOverrides?.[id] }]
    })
  }
  manager.apply(ctx, {
    servers: { get: () => config().mcp.servers },
    groups: { get: () => config().mcp.groups },
    sharedToken: { get: () => config().mcp.sharedToken },
    mountServers,
    groupUrl,
    // 使用官方 createMcpToolDefinition 直接调用上游；发现失败仅影响该连接。
    withToolContext: (_execution: any, task: () => any) => task(),
    businessGroupUrl: (id: string) => connection(id).url,
    businessGroupFetch: (id: string) => (input: any, init: any = {}) => {
      const headers = new Headers(init.headers)
      for (const [name, value] of Object.entries(connection(id).headers)) headers.set(name, value)
      return fetch(input, { ...init, headers })
    },
  })
  ctx.mcpSessionManager.groupConnection = connection
  await ctx.workspaceRegistry.create('/work/harness/workspace', config().agentId)
}
