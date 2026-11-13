import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'

const schema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
const modelSchema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ __dshExpression: value }) }))

export function harnessModelPatch(managed: string, profilePatch: string): any[] {
  const models = new Map<string, any>()
  function collect(rows: any[]) {
    for (const row of rows) {
      if (Array.isArray(row?.insert)) collect(row.insert)
      if (/^(?:agent-default-model|llm-deepseek|llm-deepseek-account|llm-pi-ai)$/.test(row?.id || '')) models.set(row.id, row)
    }
  }
  for (const file of new Set(['web-profile.seed.patch.yml', profilePatch])) {
    const path = join(managed, file)
    if (!existsSync(path)) continue
    const rows = load(readFileSync(path, 'utf8'), { schema: modelSchema })
    if (Array.isArray(rows)) collect(rows)
  }
  return [...models.values()]
}

/** MCP 连接及工具选择来自所选 Harness 的原生 Profile，不从平台执行配置复制。 */
export function harnessMcpConnections(managed: string, profilePatch: string) {
  const config: any = { servers: [], groups: [] }
  function collect(rows: any[]) {
    for (const row of rows) {
      if (Array.isArray(row?.insert)) collect(row.insert)
      if (row?.id === 'mcp-session-manager' || /mcp-manager\.(?:m?js|ts)$/.test(row?.name || '')) Object.assign(config, row.config)
    }
  }
  for (const file of new Set(['web-profile.seed.patch.yml', profilePatch])) {
    const path = join(managed, file)
    if (!existsSync(path)) continue
    const rows = load(readFileSync(path, 'utf8'), { schema })
    if (Array.isArray(rows)) collect(rows)
  }
  config.servers = config.servers.map((server: any) => ({ enabled: true, tools: { mode: 'all', names: [] }, ...server }))
  return config as { servers: any[]; groups: any[]; sharedToken?: string }
}

export function remoteConnection(server: any, version: 1 | 2 = 2) {
  if (!server?.url || server.enabled === false) throw new Error('平台 MCP 连接未配置或已停用')
  const url = new URL(server.url)
  if (version === 1) url.pathname = url.pathname.replace(/\/v2$/, '')
  return { url: url.href, headers: Object.fromEntries((server.headers || []).map((header: any) => [header.name, header.value])) as Record<string, string> }
}

/** 更新已有安装时移除内嵌执行配置，保留用户调整过的连接和凭据。 */
export function migrateStandaloneConnections(value: any, managed: string) {
  if (!['compositions', 'extensions', 'fixedBindings'].some(key => key in value)) return value
  const { compositions: _compositions, extensions: _extensions, fixedBindings: _fixedBindings, ...client } = value
  const native = harnessMcpConnections(managed, value.profilePatch)
  const servers = (value.mcp.servers || []).filter((server: any) => server.id !== 'platform-compositions')
  for (const server of native.servers) if (!servers.some((current: any) => current.id === server.id)) servers.push(server)
  const groups = (value.mcp.groups || []).filter((group: any) => !group.members?.some((member: any) => member.serverId === 'platform-compositions'))
  for (const group of native.groups) if (!groups.some((current: any) => current.id === group.id)) groups.push(group)
  const ids = new Set([...servers, ...groups].map(item => item.id))
  return { ...client, mcp: { ...value.mcp, servers, groups,
    ...(value.mcp.mountServerIds ? { mountServerIds: value.mcp.mountServerIds.filter((id: string) => ids.has(id)) } : {}) } }
}
