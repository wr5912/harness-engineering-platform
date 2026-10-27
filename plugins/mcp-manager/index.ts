import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createRequire } from 'node:module'
import { callOpenApiTool, loadOpenApi, readOpenApiResource, validateAuthHeader, validateSpecUrl } from './openapi.mjs'
import { assertConnectionReady, connectionIssue } from './connection.ts'
export { assertConnectionReady } from './connection.ts'

const runtimeRequire = createRequire('/opt/dsh/packages/mcp/mcp-client/package.json')
const z = runtimeRequire('@deepseek-ai/schemastery')
const { Client, StreamableHTTPClientTransport, UriTemplate } = runtimeRequire('@modelcontextprotocol/client')
const { McpServer, createMcpHandler } = runtimeRequire('@modelcontextprotocol/server')
const { toNodeHandler } = runtimeRequire('@modelcontextprotocol/node')
const { createScope, scopeParentOf } = await import(runtimeRequire.resolve('@deepseek-ai/dsh-scope'))
const McpClient = await import(runtimeRequire.resolve('@deepseek-ai/dsh-mcp-client'))
const { validateJsonSchemaValue } = await import(runtimeRequire.resolve('@deepseek-ai/dsh-tools'))

export const name = 'mcp-session-manager'
export const inject = ['agents', 'webServer', 'connection', 'tools']

const key = z.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/)
const toolPolicy = z.object({
  mode: z.union([z.const('all'), z.const('selected')]).default('all'),
  names: z.array(z.string()).default([]),
})
const serverSchema = z.object({
  id: key,
  serverName: z.string(),
  description: z.string(),
  enabled: z.boolean().default(true),
  specUrl: z.string(),
  apiKey: z.string(),
  authType: z.string(),
  authHeader: z.string(),
  loginUrl: z.string(),
  loginUsername: z.string(),
  loginPassword: z.string(),
  loginTokenPath: z.string(),
  url: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  managementUrl: z.string(),
  tools: toolPolicy,
})
const groupSchema = z.object({
  id: key,
  members: z.array(z.object({ serverId: key, names: z.array(z.string()).default([]),
    resourceUris: z.array(z.string()).default([]), resourceTemplates: z.array(z.string()).default([]) })).default([]),
})
export const Config = z.object({
  servers: z.array(serverSchema).default([]).volatile(),
  groups: z.array(groupSchema).default([]).volatile(),
  sharedToken: z.string().default('').volatile(),
})

const namePattern = /^[A-Za-z0-9_-]{1,32}$/
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const MAX_BODY = 64 * 1024
const MAX_RESPONSE = 1024 * 1024

function serverFingerprint(server: any): string {
  // platformClient 是装载时注入的本地组合执行器，不是可编辑连接身份。
  const { platformClient, ...connection } = server
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex')
}

function validateUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('MCP 地址须为不含凭据、查询参数和片段的 HTTP(S) URL')
  }
  return url.href
}

function snapshot(config: any) {
  const servers = structuredClone(config.servers.get()) as any[]
  const groups = structuredClone(config.groups.get()) as any[]
  const sharedToken = config.sharedToken.get() as string
  if (sharedToken && !/^[0-9a-f]{64}$/.test(sharedToken)) throw new Error('统一 Token 格式无效；请在工具分组页重新生成')
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const server of servers) {
    const serverName = server.serverName || server.id
    if (!namePattern.test(server.id) || !namePattern.test(serverName)
      || ids.has(server.id) || names.has(serverName)) throw new Error('MCP 服务器 ID 或名称重复/无效')
    ids.add(server.id)
    names.add(serverName)
    if (server.specUrl) {
      validateSpecUrl(server.specUrl)
      if (server.url || server.managementUrl || server.headers?.length) throw new Error(`${server.id}: OpenAPI 与现成 MCP 连接不能混用`)
      if (server.authType === 'login') {
        if (server.loginUrl) validateSpecUrl(server.loginUrl)
        if (server.loginTokenPath && !server.loginTokenPath.split('.').every((part: string) => /^[A-Za-z_][\w-]*$/.test(part))) throw new Error(`${server.id}: 凭据字段路径无效`)
      } else if (server.authType === 'credential') {
        validateAuthHeader(server.authHeader ?? 'Authorization')
      } else if (server.authType) throw new Error(`${server.id}: 不支持的授权方式`)
      continue
    }
    if (server.url) validateUrl(server.url)
    if (server.managementUrl) validateUrl(server.managementUrl)
    if (server.enabled && !server.url) throw new Error(`${server.id}: 缺少 MCP URL`)
    const headerNames = new Set<string>()
    for (const header of server.headers ?? []) {
      const name = header.name?.toLowerCase()
      if (!headerNamePattern.test(header.name) || /[\r\n]/.test(header.value) || headerNames.has(name)) {
        throw new Error(`${server.id}: 请求 Header 无效或重复`)
      }
      headerNames.add(name)
    }
    if (server.tools.mode === 'selected' && new Set(server.tools.names).size !== server.tools.names.length) {
      throw new Error(`${server.id}: 工具名重复`)
    }
  }
  const groupIds = new Set<string>()
  for (const group of groups) {
    if (!namePattern.test(group.id) || groupIds.has(group.id)) throw new Error('MCP 分组 ID 重复/无效')
    groupIds.add(group.id)
    for (const member of group.members) {
      const selections = [member.names ?? [], member.resourceUris ?? [], member.resourceTemplates ?? []]
      if (!ids.has(member.serverId) || !selections.some(items => items.length)
        || selections.some(items => items.some((item: unknown) => typeof item !== 'string' || !item)
          || new Set(items).size !== items.length)) {
        throw new Error(`${group.id}: 分组成员、工具或资源选择无效/重复`)
      }
    }
  }
  return { servers: servers.map(server => {
    const expected = serverFingerprint(server)
    const groupTransport = config.platformTransportForServer?.(server)
    const assertCurrent = () => {
      const current = config.servers.get().find((item: any) => item.id === server.id)
      if (!current || current.enabled === false || serverFingerprint(current) !== expected) throw new Error('MCP 当前连接或工具范围已变化')
    }
    return { ...server, ...(groupTransport ? { platformFetch: groupTransport.fetch, platformGroup: true } : {}),
      platformToolResources: Boolean(config.withToolContext), platformAssertCurrent: assertCurrent,
      platformRequestHeaders: config.platformExecute?.requestHeaders,
      platformExecute: config.platformExecute ? (operation: any, dispatch: (signal: AbortSignal) => Promise<any>, signal?: AbortSignal) =>
        config.platformExecute(operation, (controlledSignal: AbortSignal) => { assertCurrent(); return dispatch(controlledSignal) }, signal) : undefined }
  }), groups, sharedToken }
}

/** 平台数据仓库保存前复用与实际装载相同的配置校验。 */
export function validateConfiguration(value: { servers: any[]; groups: any[]; sharedToken: string }): void {
  snapshot({ servers: { get: () => value.servers }, groups: { get: () => value.groups },
    sharedToken: { get: () => value.sharedToken }, platformClient: {} })
}

function resolvedUrl(server: any): string | undefined {
  return server.url ? validateUrl(server.url) : undefined
}

function serverName(server: any): string { return server.serverName || server.id }

// 与锁定 DSH mcp-client 的 publicToolName 合同一致；真实可见性另由注册表确认。
function publicToolName(name: string, rawName: string): string {
  const joined = `mcp__${name}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${name}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

async function serverTools(server: any): Promise<any[]> {
  if (server.specUrl) {
    const source = await loadOpenApi(server)
    return server.platformToolResources ? source.businessTools : source.tools
  }
  return withClient(server, client => listCatalog(client, 'tools', server.platformSignal))
}

async function listCatalog(client: any, kind: 'tools' | 'resources' | 'resourceTemplates', signal?: AbortSignal): Promise<any[]> {
  const capability = kind === 'tools' ? 'tools' : 'resources'
  if (typeof client.getServerCapabilities === 'function' && !client.getServerCapabilities()?.[capability]) return []
  const method = kind === 'tools' ? 'listTools' : kind === 'resources' ? 'listResources' : 'listResourceTemplates'
  const items: any[] = [], cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client[method](cursor ? { cursor } : undefined, { signal })
    items.push(...page[kind])
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('MCP 发现分页游标重复')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return items
}

async function withClient<T>(server: any, run: (client: any) => Promise<T>): Promise<T> {
  assertConnectionReady(server)
  const url = resolvedUrl(server)
  if (!url) throw new Error(`${server.id}: MCP URL 未配置`)
  const client = new Client({ name: 'dsh-web-mcp-manager', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(server.platformFetch ? { fetch: server.platformFetch } : {}),
    requestInit: { signal: server.platformSignal, headers: { ...Object.fromEntries((server.headers ?? []).map(({ name, value }: any) => [name, value])),
      ...server.platformRequestHeaders?.(url) } },
  })
  try {
    await client.connect(transport, { signal: server.platformSignal })
    return await run(client)
  } finally {
    await client.close()
  }
}

async function callManagedTool(server: any, name: string, args: any, meta?: Record<string, unknown>): Promise<any> {
  if (server.enabled === false) throw new Error('MCP 服务器已停用')
  if (server.tools?.mode === 'selected' && !server.tools.names.includes(name)) throw new Error('工具不属于当前 MCP 范围')
  if (server.specUrl) return callOpenApiTool(await loadOpenApi(server), name, args)
  return withClient(server, async client => {
    const tool = (await listCatalog(client, 'tools', server.platformSignal)).find((item: any) => item.name === name)
    if (!tool) throw new Error('工具不属于当前 MCP 范围')
    const dispatch = (signal?: AbortSignal) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, {
      signal: signal ?? server.platformSignal, timeout: server.platformComposition ? 36 * 60_000 : server.platformTimeoutMs ?? 60_000,
    })
    if (server.platformComposition) {
      // 已发布组合保留固定版本与业务上下文；真实目标授权在每个叶子派发时执行。
      server.platformAssertCurrent?.()
      return dispatch()
    }
    if (server.platformGroup) {
      // 平台分组的叶子派发已经完成业务授权；外层连接不代表实际来源。
      server.platformAssertCurrent?.()
      return dispatch()
    }
    return server.platformExecute ? server.platformExecute({ serverId: server.id, operationId: name,
      kind: 'write', target: resolvedUrl(server), method: 'tools/call', args,
      schemaDigest: createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex'),
    }, dispatch, server.platformSignal) : dispatch()
  })
}

async function readManagedResource(server: any, uri: string, args?: Record<string, unknown>): Promise<any> {
  if (server.enabled === false) throw new Error('MCP 服务器已停用')
  if (server.specUrl) return readOpenApiResource(await loadOpenApi(server), uri, args)
  return withClient(server, client => {
    const dispatch = (signal?: AbortSignal) => client.readResource({ uri }, { signal: signal ?? server.platformSignal })
    if (server.platformGroup) {
      server.platformAssertCurrent?.()
      return dispatch()
    }
    return server.platformExecute ? server.platformExecute({ serverId: server.id, operationId: 'resources/read',
      kind: 'resource', target: resolvedUrl(server), method: 'resources/read', args: { uri },
    }, dispatch, server.platformSignal) : dispatch()
  })
}

function send(res: any, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function bodyOf(req: any): Promise<any> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求超过 64 KiB')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function bearerAccepted(req: any, sharedToken: string): boolean {
  if (!sharedToken) return false
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7))
  const expected = Buffer.from(sharedToken)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

type Target = { kind: 'agent'; server: any } | { kind: 'group'; group: any; servers: any[] }
type GroupTarget = Extract<Target, { kind: 'group' }>
type GroupVersion = 1 | 2

export const GROUP_TARGET_META_KEY = 'io.deepseek.dsh/mcp-group-target'
export const GROUP_DISCOVERY_META_KEY = 'io.deepseek.dsh/mcp-group-discovery'
export const GROUP_TOOL_META_KEY = 'io.deepseek.dsh/mcp-group-tool'
/** 与既有业务 MCP 桥使用同一身份合同，凭据轮换不改变目标摘要。 */
export function groupTargetDigest(target: GroupTarget, version: GroupVersion = 1): string {
  if (version === 2 && new Set(target.group.members.map((member: any) => member.serverId)).size !== target.group.members.length) {
    throw new Error('MCP v2 分组服务 ID 重复')
  }
  const members = target.group.members.map((member: any) => {
    const server = target.servers.find(item => item.id === member.serverId)
    let endpoint = server?.specUrl || server?.url || ''
    if (endpoint) {
      const url = new URL(endpoint); url.username = ''; url.password = ''
      for (const key of [...url.searchParams.keys()]) if (/token|secret|password|credential|authorization|api[-_]?key/i.test(key)) url.searchParams.delete(key)
      url.searchParams.sort(); endpoint = url.href
    }
    if (version === 2) return { serverId: member.serverId, enabled: server?.enabled,
      kind: server?.specUrl ? 'openapi' : 'mcp', endpoint, tools: server?.tools,
      names: [...member.names].sort(), resourceUris: [...(member.resourceUris ?? [])].sort(),
      resourceTemplates: [...(member.resourceTemplates ?? [])].sort() }
    // v1 保持原有字段、排序与序列化次序，旧绑定按原合同核对。
    return { serverId: member.serverId, serverName: server && serverName(server), enabled: server?.enabled,
      kind: server?.specUrl ? 'openapi' : 'mcp', endpoint, names: [...member.names].sort(),
      resourceUris: [...(member.resourceUris ?? [])].sort(), resourceTemplates: [...(member.resourceTemplates ?? [])].sort() }
  }).sort((a: any, b: any) => a.serverId.localeCompare(b.serverId))
  return createHash('sha256').update(JSON.stringify(version === 1 ? { id: target.group.id, members }
    : { id: target.group.id, version, naming: 'group-boundary-v1', members })).digest('hex')
}

function v2ToolName(serverId: string, rawName: string): string {
  return `${serverId.replaceAll('_', '_0')}__${rawName}`
}

function resourceToolName(serverId: string, kind: 'r' | 't', item: any): string {
  const type = kind === 'r' ? 'resource' : 'template'
  const uri = kind === 'r' ? item.uri : item.uriTemplate
  const label = String(item.name || type).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  const hash = createHash('sha256').update(`${kind}\0${uri}`).digest('hex').slice(0, 12)
  return v2ToolName(serverId, `${type}_${label}_${hash}`)
}

function discoveryMetadata(server: any, kind: 'tools' | 'r' | 't', items: any[], groups: string[] = []): any[] {
  return items.map(item => ({ ...item, groupToolName: item.name,
    groupPublicNames: Object.fromEntries(groups.map(id => [id, publicToolName(id, item.name)])) }))
}

const groupResourceBindings = new Map<string, { digest: string; resources: any[] }>()

/** 发布名只属于分组；来源身份保存在映射和元数据中，不从公开名称反向拆解。 */
async function groupToolBindings(target: GroupTarget, signal?: AbortSignal, unavailable: string[] = []): Promise<any[]> {
  const catalogs = await Promise.all(target.group.members.map(async (member: any) => {
    const server = target.servers.find(item => item.id === member.serverId && item.enabled)
    if (!server) return []
    const selected = member.names.filter((name: string) => server.tools?.mode !== 'selected' || server.tools.names.includes(name))
    let tools: any[] = []
    if (selected.length) try { tools = await serverTools({ ...server, platformSignal: signal ?? server.platformSignal }) }
    catch (error) { if (signal?.aborted) throw error; unavailable.push(server.id) }
    // 暂时离线或失效的已选名称仍占用身份，防止同名工具悄然换成其他来源。
    return selected.flatMap((name: string) => {
      const matches = tools.filter(tool => tool.name === name)
      return (matches.length ? matches : [undefined]).map(tool => ({ server, sourceName: name, tool,
        name, kind: 'tool', aliases: [v2ToolName(server.id, name)] }))
    })
  }))
  const bindings = catalogs.flat()
  const resources = await resourceToolsFor(target, signal, unavailable)
  const digest = groupTargetDigest(target, 2), previous = groupResourceBindings.get(target.group.id)
  // 保留已发现的资源身份，短暂离线不能把它的名称交给另一个来源。
  if (previous?.digest === digest) for (const resource of previous.resources) {
    if (!resources.some(item => item.uri === resource.uri)) resources.push({ ...resource, tool: undefined })
  }
  groupResourceBindings.set(target.group.id, { digest, resources })
  for (const resource of resources) {
    const { server, kind, item, tool } = resource
    const equivalent = server.specUrl && bindings.find(binding => binding.server.id === server.id && binding.sourceName === item.name
      && (binding.tool?.httpOperation?.method === item.httpOperation?.method && binding.tool?.httpOperation?.path === item.httpOperation?.path))
    const alias = resourceToolName(server.id, kind, item)
    if (equivalent) {
      equivalent.aliases.push(alias)
      equivalent.aliasResources = { ...equivalent.aliasResources, [alias]: { ...resource, kind: kind === 'r' ? 'resource' : 'template' } }
      continue
    }
    bindings.push({ ...resource, name: item.name, sourceName: item.name, kind: kind === 'r' ? 'resource' : 'template', aliases: [alias] })
  }
  const counts = new Map<string, any[]>()
  for (const binding of bindings) {
    const matches = counts.get(binding.name) ?? []
    matches.push(binding); counts.set(binding.name, matches)
  }
  for (const [name, matches] of counts) {
    const aliases = bindings.filter(binding => binding.name !== name && binding.aliases.includes(name))
    if (matches.length + aliases.length < 2) continue
    unavailable.push(`工具名冲突：${name}（${[...matches, ...aliases].map(item => `${item.server.id}/${item.kind}/${item.sourceName}`).join('、')}）；请调整分组选择`)
    for (const binding of matches) binding.conflict = true
  }
  for (const binding of bindings) if (binding.tool) {
    const sourceUri = binding.item && (binding.item.uri ?? binding.item.uriTemplate)
    binding.tool = { ...binding.tool, name: binding.name, _meta: { ...binding.tool._meta, [GROUP_TOOL_META_KEY]: {
      serverId: binding.server.id, kind: binding.kind, sourceName: binding.sourceName, ...(sourceUri ? { sourceUri } : {}) } } }
  }
  return bindings
}

async function toolsFor(target: Target, version: GroupVersion = 1, signal?: AbortSignal, unavailable: string[] = []): Promise<any[]> {
  if (target.kind === 'agent') {
    const tools = await serverTools({ ...target.server, platformSignal: signal ?? target.server.platformSignal })
    return tools.filter((tool: any) => !target.server.tools || target.server.tools.mode === 'all'
      || target.server.tools.names.includes(tool.name))
  }
  if (version === 2) return (await groupToolBindings(target, signal, unavailable))
    .filter(binding => !binding.conflict && binding.tool).map(binding => binding.tool)
  const result: any[] = []
  const catalogs = await Promise.all(target.group.members.filter(member => member.names.length).map(async member => {
    const server = target.servers.find(item => item.id === member.serverId && item.enabled)
    if (!server) return { member, server, tools: [] as any[] }
    const tools = await serverTools({ ...server, platformSignal: signal ?? server.platformSignal })
    return { member, server, tools }
  }))
  for (const { member, server, tools } of catalogs) {
    for (const tool of tools) {
      if (member.names.includes(tool.name)) {
        const name = `mcp__${serverName(server)}__${tool.name}`
        result.push({ ...tool, name })
      }
    }
  }
  return result
}

function toolOwner(target: Target, name: string, version: GroupVersion = 1): { server: any; rawName: string } | undefined {
  if (target.kind === 'agent') {
    if (target.server.tools.mode === 'selected' && !target.server.tools.names.includes(name)) return
    return { server: target.server, rawName: name }
  }
  for (const member of target.group.members) {
    const server = target.servers.find(item => item.id === member.serverId && item.enabled)
    if (!server) continue
    const prefix = version === 1 ? `mcp__${serverName(server)}__` : `${server.id.replaceAll('_', '_0')}__`
    if (name.startsWith(prefix) && member.names.includes(name.slice(prefix.length))) {
      if (version === 2 && server.tools?.mode === 'selected' && !server.tools.names.includes(name.slice(prefix.length))) continue
      return { server, rawName: name.slice(prefix.length) }
    }
  }
}

function groupResourceUri(groupId: string, serverId: string, kind: 'r' | 't', sourceUri: string): string {
  return `mcp-group:/${groupId}/${serverId}/${kind}/${Buffer.from(sourceUri, 'utf8').toString('base64url')}`
}

function sourceTemplate(value: string): { template: any; variableNames: string[]; requiredNames: string[] } {
  const expressions = value.match(/\{[^{}]*\}/g) ?? []
  if (!expressions.length || value.replace(/\{[^{}]*\}/g, '').includes('{') || value.replace(/\{[^{}]*\}/g, '').includes('}')
    || expressions.some(expression => !/^\{[+#./?&]?[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*\}$/.test(expression))) {
    throw new Error('不支持的 Resource URI 模板')
  }
  const template = new UriTemplate(value)
  const variableNames = template.variableNames as string[]
  if (new Set(variableNames).size !== variableNames.length) throw new Error('Resource URI 模板变量重复')
  const requiredNames = template.parts.flatMap((part: any) => typeof part === 'string' || ['?', '&'].includes(part.operator) ? [] : part.names)
  return { template, variableNames, requiredNames }
}

async function resourceCatalog(server: any, kind: 'r' | 't'): Promise<any[]> {
  if (server.specUrl) {
    const source = await loadOpenApi(server)
    return kind === 'r' ? source.resources : source.resourceTemplates
  }
  return withClient(server, client => listCatalog(client, kind === 'r' ? 'resources' : 'resourceTemplates', server.platformSignal))
}

async function discoverServer(server: any, groups: string[] = []): Promise<any> {
  if (server.specUrl) {
    const source = await loadOpenApi(server)
    return { tools: discoveryMetadata(server, 'tools', source.tools, groups),
      resources: { resources: discoveryMetadata(server, 'r', source.resources, groups) },
      resourceTemplates: { resourceTemplates: discoveryMetadata(server, 't', source.resourceTemplates, groups) } }
  }
  return withClient(server, async client => {
    const [tools, resources, templates] = await Promise.allSettled(
      (['tools', 'resources', 'resourceTemplates'] as const).map(kind => listCatalog(client, kind, server.platformSignal)))
    if ([tools, resources, templates].every(result => result.status === 'rejected')) throw new Error('MCP 工具与资源发现均未完成')
    return { tools: tools.status === 'fulfilled' ? discoveryMetadata(server, 'tools', tools.value, groups) : [],
      ...(tools.status === 'rejected' ? { toolsUnavailable: true } : {}),
      resources: { resources: resources.status === 'fulfilled' ? discoveryMetadata(server, 'r', resources.value, groups) : [],
        ...(resources.status === 'rejected' ? { unavailable: true } : {}) },
      resourceTemplates: { resourceTemplates: templates.status === 'fulfilled' ? discoveryMetadata(server, 't', templates.value, groups) : [],
        ...(templates.status === 'rejected' ? { unavailable: true } : {}) } }
  })
}

async function selectedResources(target: GroupTarget, kind: 'r' | 't', signal?: AbortSignal, unavailable: string[] = []): Promise<any[]> {
  const result: any[] = []
  const uris = new Set<string>()
  const catalogs = await Promise.all(target.group.members.map(async member => {
    const selected = kind === 'r' ? member.resourceUris ?? [] : member.resourceTemplates ?? []
    const server = target.servers.find(item => item.id === member.serverId && item.enabled)
    if (!server || !selected.length) return { member, server, selected, catalog: [] as any[] }
    let catalog: any[]
    try { catalog = await resourceCatalog({ ...server, platformSignal: signal ?? server.platformSignal }, kind) }
    catch (error) {
      if (signal?.aborted) throw error
      return { member, server, selected, catalog: [] as any[], failed: true }
    }
    return { member, server, selected, catalog }
  }))
  for (const { server, selected, catalog, failed } of catalogs) {
    if (!server) continue
    if (failed) unavailable.push(server.id)
    for (const uri of selected) if (!catalog.some(item => (kind === 'r' ? item.uri : item.uriTemplate) === uri)) {
      unavailable.push(`${server.id}: ${uri}（已选资源当前不可用）`)
    }
    for (const item of catalog) {
      const sourceUri = kind === 'r' ? item.uri : item.uriTemplate
      if (!selected.includes(sourceUri)) continue
      const uri = groupResourceUri(target.group.id, server.id, kind, sourceUri)
      if (uris.has(uri)) throw new Error('MCP 分组 Resource URI 重复')
      uris.add(uri)
      let parsed: ReturnType<typeof sourceTemplate> | undefined
      if (kind === 't') {
        try { parsed = sourceTemplate(sourceUri) }
        catch { unavailable.push(`${server.id}: ${sourceUri}（不支持的资源模板）`); continue }
      }
      result.push({ server, kind, item, uri, parsed })
    }
  }
  return result
}

async function resourcesFor(target: GroupTarget, kind: 'r' | 't', signal?: AbortSignal, unavailable: string[] = []): Promise<any[]> {
  return (await selectedResources(target, kind, signal, unavailable)).map(({ item, uri, parsed }) => kind === 'r'
    ? { ...item, uri } : { ...item, uriTemplate: `${uri}{?${parsed.variableNames.join(',')}}` })
}

async function resourceToolsFor(target: GroupTarget, signal?: AbortSignal, unavailable: string[] = []): Promise<any[]> {
  const selected = (await Promise.all((['r', 't'] as const).map(kind => selectedResources(target, kind, signal, unavailable)))).flat()
  return selected.map(binding => {
    const { server, kind, item, parsed } = binding
    const inputSchema = kind === 'r' ? { type: 'object', properties: {}, additionalProperties: false }
      : server.specUrl ? item.inputSchema : { type: 'object', properties: Object.fromEntries(parsed.variableNames.map((name: string) =>
        [name, { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }])),
        required: parsed.requiredNames, additionalProperties: false }
    return { ...binding, tool: { name: item.name,
      ...(item.title ? { title: item.title } : {}), description: [item.description || item.title || item.name,
        `读取资源：${kind === 'r' ? item.uri : item.uriTemplate}`].filter(Boolean).join('\n'), inputSchema,
      annotations: { readOnlyHint: true } } }
  })
}

async function callSelectedTool(target: Target, version: GroupVersion, name: string, args: any, meta?: Record<string, unknown>, signal?: AbortSignal,
  assertCurrent?: () => void): Promise<any> {
  let owner = target.kind === 'group' && version === 2 ? undefined : toolOwner(target, name, version)
  if (target.kind === 'group' && version === 2) {
    const bindings = await groupToolBindings(target, signal)
    const matches = bindings.filter(binding => binding.name === name || binding.aliases.includes(name))
    if (matches.length > 1 || matches.some(binding => binding.conflict)) throw new Error('MCP 分组工具名冲突，请调整分组选择并重新发现')
    const binding = matches[0]?.aliasResources?.[name] ?? matches[0]
    if (!binding?.tool) throw new Error('工具不属于当前 MCP 范围或来源当前不可用')
    owner = { server: binding.server, rawName: binding.sourceName }
    if (binding.kind !== 'tool') {
      const { tool, uri, parsed, server } = binding
      const violations = validateJsonSchemaValue(tool.inputSchema, args, '')
      if (violations.length) throw new Error(`资源工具参数无效：${violations.join('; ')}`)
      const query = Object.entries(args).map(([key, value]) => `${key}=${(Array.isArray(value) ? value : [value]).map(item => encodeURIComponent(String(item))).join(',')}`).join('&')
      const response = await readGroupResource(target, parsed && query && !server.specUrl ? `${uri}?${query}` : uri, signal, assertCurrent,
        server.specUrl ? args : undefined)
      // DSH 将嵌入资源显示为占位符；正文通过 text 交给模型，原始内容保留在 structuredContent。
      return { content: response.contents.map((item: any) => ({ type: 'text', text: typeof item.text === 'string' ? item.text
        : `资源 ${item.uri} 返回二进制内容（${item.mimeType || '未知类型'}），请通过资源读取接口获取。` })),
        structuredContent: response }
    }
  }
  if (!owner) throw new Error('工具不属于当前 MCP 范围')
  assertCurrent?.()
  return callManagedTool({ ...owner.server, platformSignal: signal ?? owner.server.platformSignal }, owner.rawName, args, meta)
}

function parseProxyResourceUri(uri: string): { groupId: string; serverId: string; kind: 'r' | 't'; sourceUri: string; query?: string } {
  const match = /^mcp-group:\/([A-Za-z0-9_-]{1,32})\/([A-Za-z0-9_-]{1,32})\/([rt])\/([A-Za-z0-9_-]+)(?:\?([^#]*))?$/.exec(uri)
  if (!match || match[3] === 'r' && match[5] !== undefined) throw new Error('Resource URI 不属于当前 MCP 分组')
  const encoded = match[4], decoded = Buffer.from(encoded, 'base64url')
  if (decoded.toString('base64url') !== encoded) throw new Error('Resource URI 编码无效')
  const sourceUri = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  if (!sourceUri) throw new Error('Resource URI 编码无效')
  return { groupId: match[1], serverId: match[2], kind: match[3] as 'r' | 't', sourceUri, query: match[5] }
}

function templateValues(query: string | undefined, variableNames: string[]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null)
  if (query === undefined || !query) return result
  for (const pair of query.split('&')) {
    const match = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(pair)
    if (!match || !variableNames.includes(match[1]) || Object.hasOwn(result, match[1]) || /%(?![0-9A-Fa-f]{2})|\+/.test(match[2])) {
      throw new Error('Resource URI 模板参数无效或重复')
    }
    try {
      result[match[1]] = match[2].includes(',')
        ? match[2].split(',').map(value => decodeURIComponent(value)) : decodeURIComponent(match[2])
    } catch { throw new Error('Resource URI 模板参数编码无效') }
  }
  return result
}

async function readGroupResource(target: GroupTarget, uri: string, signal?: AbortSignal, assertCurrent?: () => void,
  args?: Record<string, unknown>): Promise<any> {
  const proxy = parseProxyResourceUri(uri)
  const member = target.group.members.find((item: any) => item.serverId === proxy.serverId)
  const selected = proxy.kind === 'r' ? member?.resourceUris ?? [] : member?.resourceTemplates ?? []
  const server = target.servers.find(item => item.id === proxy.serverId && item.enabled)
  if (proxy.groupId !== target.group.id || !server || !selected.includes(proxy.sourceUri)) throw new Error('Resource URI 不属于当前 MCP 分组')
  const sources = (await resourceCatalog({ ...server, platformSignal: signal ?? server.platformSignal }, proxy.kind)).filter(item =>
    (proxy.kind === 'r' ? item.uri : item.uriTemplate) === proxy.sourceUri)
  if (sources.length !== 1) throw new Error(sources.length ? '来源 Resource URI 重复' : '已选 Resource 在来源中不可用')
  let upstreamUri = proxy.sourceUri
  if (proxy.kind === 't' && args === undefined) {
    const { template, variableNames, requiredNames } = sourceTemplate(proxy.sourceUri)
    const values = templateValues(proxy.query, variableNames)
    if (requiredNames.some(name => !Object.hasOwn(values, name))) throw new Error('Resource URI 模板缺少路径参数')
    upstreamUri = template.expand(values)
  }
  assertCurrent?.()
  server.platformAssertCurrent?.()
  const response = await readManagedResource({ ...server, platformSignal: signal ?? server.platformSignal }, upstreamUri, args)
  return { ...response, contents: response.contents?.map((item: any) => ({ ...item, uri })) ?? [] }
}

function assertGroupTarget(target: GroupTarget, currentTarget: (() => Target | undefined) | undefined,
  version: GroupVersion, request?: any): void {
  const digest = groupTargetDigest(target, version)
  const expected = request?.params?._meta?.[GROUP_TARGET_META_KEY]?.digest
  const current = currentTarget?.()
  if (expected !== undefined && expected !== digest || currentTarget && (!current || current.kind !== 'group'
    || groupTargetDigest(current, version) !== digest)) throw new Error('MCP 分组目标已变化')
}

async function serveMcp(req: any, res: any, target: Target, currentTarget?: () => Target | undefined,
  version: GroupVersion = 1, withGroupRequest?: (req: any, rpcMethod: string, run: () => Promise<any>, rpcRequest: any) => Promise<any>): Promise<void> {
  const digest = target.kind === 'group' ? groupTargetDigest(target, version) : undefined
  let wireRequest: any
  const runRequest = (method: string, rpcRequest: any, run: () => Promise<any>) => withGroupRequest
    ? withGroupRequest(req, method, run, wireRequest ?? rpcRequest) : run()
  const agentDigest = (value: any) => JSON.stringify([value?.id, value?.enabled, value?.specUrl, value?.url, value?.tools])
  const assertTarget = (request?: any) => {
    const current = currentTarget?.()
    if (target.kind === 'group') assertGroupTarget(target, currentTarget, version, request)
    if (target.kind === 'agent' && currentTarget && (!current || current.kind !== 'agent' || current.server.enabled === false
      || agentDigest(current.server) !== agentDigest(target.server))) throw new Error('MCP 服务器目标已变化或已停用')
  }
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: target.kind === 'group' ? target.group.id : serverName(target.server),
      version: '0.1.0' }, { capabilities: target.kind === 'agent' || target.kind === 'group' && version === 2
        ? { tools: {}, resources: {} } : { tools: {} } })
    mcp.server.setRequestHandler('tools/list', async (request: any, extra: any) => runRequest('tools/list', request, async () => {
      const unavailable: string[] = []
      const tools = await toolsFor(target, version, extra?.mcpReq?.signal ?? extra?.signal, unavailable); assertTarget()
      return { tools, ...(digest ? { _meta: { [GROUP_TARGET_META_KEY]: version === 1 ? { digest } : { digest, version },
        ...(unavailable.length ? { [GROUP_DISCOVERY_META_KEY]: { unavailable } } : {}) } } : {}) }
    }))
    mcp.server.setRequestHandler('tools/call', async (request: any, extra: any) => runRequest('tools/call', request, async () => {
      assertTarget(request)
      const response = await callSelectedTool(target, version, request.params.name, request.params.arguments ?? {}, request.params._meta,
        extra?.mcpReq?.signal ?? extra?.signal, () => assertTarget(request))
      assertTarget(request)
      return response
    }))
    if (target.kind === 'agent' || target.kind === 'group' && version === 2) {
      mcp.server.setRequestHandler('resources/list', async (request: any, extra: any) => runRequest('resources/list', request, async () => {
        const signal = extra?.mcpReq?.signal ?? extra?.signal
        const unavailable: string[] = []
        const resources = target.kind === 'group' ? await resourcesFor(target, 'r', signal, unavailable)
          : (await resourceCatalog({ ...target.server, platformSignal: signal }, 'r'))
        assertTarget(); return { resources, ...(digest ? { _meta: { [GROUP_TARGET_META_KEY]: { digest, version },
          ...(unavailable.length ? { [GROUP_DISCOVERY_META_KEY]: { unavailable } } : {}) } } : {}) }
      }))
      mcp.server.setRequestHandler('resources/templates/list', async (request: any, extra: any) => runRequest('resources/templates/list', request, async () => {
        const signal = extra?.mcpReq?.signal ?? extra?.signal
        const unavailable: string[] = []
        const resourceTemplates = target.kind === 'group' ? await resourcesFor(target, 't', signal, unavailable)
          : (await resourceCatalog({ ...target.server, platformSignal: signal }, 't'))
        assertTarget(); return { resourceTemplates, ...(digest ? { _meta: { [GROUP_TARGET_META_KEY]: { digest, version },
          ...(unavailable.length ? { [GROUP_DISCOVERY_META_KEY]: { unavailable } } : {}) } } : {}) }
      }))
      mcp.server.setRequestHandler('resources/read', async (request: any, extra: any) => runRequest('resources/read', request, async () => {
        assertTarget(request)
        const response = target.kind === 'group' ? await readGroupResource(target, request.params.uri, extra?.mcpReq?.signal ?? extra?.signal, () => assertTarget(request))
          : await readManagedResource({ ...target.server, platformSignal: extra?.mcpReq?.signal ?? extra?.signal }, request.params.uri)
        assertTarget(request); return response
      }))
    }
    return mcp
  })
  try {
    await toNodeHandler({ fetch: async (request, options) => {
      // SDK 会提取现代协议的信封字段；签名必须核对传输原文。
      if (withGroupRequest && request.method === 'POST') {
        try { wireRequest = await request.clone().json() } catch { /* 由 SDK 返回协议解析错误。 */ }
      }
      return handler.fetch(request, wireRequest === undefined ? options : { ...options, parsedBody: wireRequest })
    } })(req, res)
  } finally {
    await handler.close()
  }
}

async function upstream(server: any, method: string, path: string, data?: unknown): Promise<any> {
  if (!server.managementUrl) throw new Error(`${server.id}: 未设置 OpenAPI 管理地址`)
  const root = validateUrl(server.managementUrl)
  const target = new URL(path, root.endsWith('/') ? root : `${root}/`)
  const dispatch = (signal?: AbortSignal) => fetch(target, {
    method,
    headers: data === undefined ? {} : { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: signal ?? server.platformSignal ?? AbortSignal.timeout(20_000),
    redirect: 'error',
  })
  const response = server.platformExecute && path.endsWith('/invoke')
    ? await server.platformExecute({ serverId: server.id, operationId: path.split('/').at(-2),
      kind: 'write', target: target.href, method, args: data }, dispatch, server.platformSignal)
    : await dispatch()
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new Error('上游响应超过 1 MiB')
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE) throw new Error('上游响应超过 1 MiB')
  let parsed: any
  try { parsed = text ? JSON.parse(text) : {} } catch { throw new Error('上游返回非 JSON') }
  if (!response.ok) throw new Error(`上游 HTTP ${response.status}: ${JSON.stringify(parsed).slice(0, 500)}`)
  return parsed
}

async function manage(server: any, request: any): Promise<any> {
  assertConnectionReady(server)
  const { action, sourceId, toolName } = request
  const source = typeof sourceId === 'string' && /^[0-9a-fA-F-]{36}$/.test(sourceId) ? sourceId : undefined
  const tool = typeof toolName === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(toolName) ? toolName : undefined
  const prefix = '/api/v1/mcp-resources'
  if (action === 'sources') return upstream(server, 'GET', prefix)
  if (action === 'create' && typeof request.name === 'string' && typeof request.specUrl === 'string') {
    return upstream(server, 'POST', prefix, { name: request.name, spec_url: validateUrl(request.specUrl) })
  }
  if (!source) throw new Error('OpenAPI 来源 ID 无效')
  if (action === 'refresh') return upstream(server, 'POST', `${prefix}/${source}/refresh`)
  if (action === 'toggle' && typeof request.enabled === 'boolean') {
    return upstream(server, 'PATCH', `${prefix}/${source}`, { enabled: request.enabled })
  }
  if (action === 'components') return upstream(server, 'GET', `${prefix}/${source}/components`)
  if (action === 'logs') return upstream(server, 'GET', `${prefix}/${source}/logs`)
  if ((action === 'preview' || action === 'invoke') && tool) {
    return upstream(server, 'POST', `${prefix}/${source}/tools/${tool}/${action}`, { arguments: request.arguments ?? {} })
  }
  throw new Error('不支持的 OpenAPI 管理操作')
}

export function apply(ctx: any, config: any): void {
  const publicPath = (path: string) => ctx.webServer.publicPath?.(path) ?? path
  const agents = new Map<string, Target>()
  const agentToken = randomBytes(32).toString('hex')
  const mounted = new Map<object, { version: string; ready: Promise<any[]>; users: number;
    unavailable: Set<string>; retry?: Promise<void> }>()
  const registeredTools = new Map<string, number>()
  const registeredResourceServers = new Map<string, number>()
  snapshot(config)
  const currentGroup = (id: string): Extract<Target, { kind: 'group' }> | undefined => {
    const current = snapshot(config), group = current.groups.find(item => item.id === id)
    return group ? { kind: 'group', group, servers: current.servers } : undefined
  }
  ctx.provide('mcpSessionManager', {
    ...(config.businessGroupUrl && config.businessGroupFetch ? {
      groupUrl: (id: string) => config.businessGroupUrl(id),
      groupFetch: (id: string, sessionId?: string) => config.businessGroupFetch(id, sessionId),
    } : {}),
    currentGroup(id: string, version: GroupVersion = 1) {
    const target = currentGroup(id)
    return target ? { id, version, token: config.sharedToken.get(), targetDigest: groupTargetDigest(target, version) } : undefined
  }, resolveTool(serverId: string, rawName: string) {
    const server = snapshot(config).servers.find(item => item.id === serverId && item.enabled !== false)
    if (!server || server.tools?.mode === 'selected' && !server.tools.names.includes(rawName)) return undefined
    const name = publicToolName(serverName(server), rawName)
    return (registeredTools.get(`${serverId}\0${name}`) ?? 0) > 0 ? name : undefined
  }, async listGroupTools(id: string, version: GroupVersion = 2) {
    const target = currentGroup(id)
    if (!target) throw new Error('MCP 分组不存在')
    const unavailable: string[] = []
    const tools = await toolsFor(target, version, undefined, unavailable)
    assertGroupTarget(target, () => currentGroup(id), version)
    const digest = groupTargetDigest(target, version)
    return { tools, _meta: { [GROUP_TARGET_META_KEY]: version === 1 ? { digest } : { digest, version },
      ...(unavailable.length ? { [GROUP_DISCOVERY_META_KEY]: { unavailable } } : {}) } }
  }, async callGroupTool(id: string, version: GroupVersion, name: string, args: any,
    meta: Record<string, unknown> | undefined, exec: any) {
    const dispatch = async () => {
      const target = currentGroup(id)
      if (!target) throw new Error('MCP 分组不存在')
      const request = { params: { _meta: meta } }
      assertGroupTarget(target, () => currentGroup(id), version, request)
      const response = await callSelectedTool(target, version, name, args, meta, exec?.signal,
        () => assertGroupTarget(target, () => currentGroup(id), version, request))
      assertGroupTarget(target, () => currentGroup(id), version, request)
      return response
    }
    if (version === 2 && config.withToolContext) {
      if (!exec?.agent?.session?.id || !exec?.callId) throw new Error('MCP 分组调用缺少原生 Session 身份')
      return config.withToolContext(exec, dispatch)
    }
    return dispatch()
  } })

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/mcp/groups', handler: async (req: any, res: any) => {
    const route = /^\/mcp\/groups\/([A-Za-z0-9_-]{1,32})(?:\/(v2))?$/.exec(new URL(req.url, 'http://localhost').pathname)
    if (!route) return send(res, 404, { error: 'group endpoint not found' })
    const id = route[1], version: GroupVersion = route[2] === 'v2' ? 2 : 1
    const signed = version === 2 && (req.headers['x-harness-business-context'] !== undefined
      || req.headers['x-harness-business-signature'] !== undefined)
    if (signed) {
      // 签名存在时必须验证；无效签名不能降级为 Bearer 身份。
      try {
        if (!config.acceptGroupTransport || !await config.acceptGroupTransport(req)) return send(res, 401, { error: 'invalid business assertion' })
      } catch { return send(res, 401, { error: 'invalid business assertion' }) }
    } else if (!bearerAccepted(req, config.sharedToken.get())) return send(res, 401, { error: 'Bearer token required' })
    try {
      const current = snapshot(config)
      const group = current.groups.find(item => item.id === id)
      if (!group) return send(res, 404, { error: 'group not found' })
      await serveMcp(req, res, { kind: 'group', group, servers: current.servers }, () => currentGroup(id), version,
        config.withGroupRequest)
    } catch (error) { if (!res.headersSent) send(res, 502, { error: String(error) }); else res.destroy() }
  } }), 'mcp-manager.groups')

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/mcp/agents', handler: async (req: any, res: any) => {
    if (!bearerAccepted(req, agentToken)) return send(res, 401, { error: 'Bearer token required' })
    const id = new URL(req.url, 'http://localhost').pathname.split('/')[3]
    const target = agents.get(id)
    if (!target) return send(res, 404, { error: 'agent MCP endpoint not found' })
    try { await serveMcp(req, res, target, () => {
      const server = snapshot(config).servers.find(item => item.id === (target as Extract<Target, { kind: 'agent' }>).server.id)
      return server ? { kind: 'agent', server } : undefined
    }) }
    catch (error) { if (!res.headersSent) send(res, 502, { error: String(error) }); else res.destroy() }
  } }), 'mcp-manager.agents')

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/mcp-manager', handler: async (req: any, res: any) => {
    const rejected = ctx.connection.requestRejection(req)
    if (rejected) return send(res, rejected, { error: 'unauthorized' })
    if (config.withManagement) {
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission || admission.peer.principal.kind !== 'owner') return send(res, 403, { error: 'management owner required' })
    }
    try {
      const current = snapshot(config)
      if (req.method === 'GET') return send(res, 200, {
        servers: current.servers.map(server => ({ id: server.id, enabled: server.enabled,
          addressConfigured: Boolean(server.specUrl || resolvedUrl(server)), managementConfigured: Boolean(server.managementUrl), configurationIssue: connectionIssue(server) })),
        groupPaths: current.groups.map(group => ({ id: group.id, path: publicPath(`/mcp/groups/${group.id}`),
          v2Path: publicPath(`/mcp/groups/${group.id}/v2`) })),
        tokenConfigured: Boolean(current.sharedToken),
      })
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const request = await bodyOf(req)
      const server = current.servers.find(item => item.id === request.serverId)
      if (!server) return send(res, 404, { error: 'MCP server not found' })
      if (request.action === 'callTool') {
        if (typeof request.toolName !== 'string' || !request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) return send(res, 400, { error: '工具名称或参数无效' })
        return send(res, 200, await callManagedTool(server, request.toolName, request.arguments))
      }
      if (request.action === 'test') {
        return send(res, 200, await discoverServer(server, current.groups.filter(group =>
          group.members.some((member: any) => member.serverId === server.id)).map(group => group.id)))
      }
      if (request.action === 'resources' || request.action === 'resourceTemplates' || request.action === 'readResource') {
        if (request.action === 'readResource') return send(res, 200, await readManagedResource(server, request.uri))
        const kind = request.action === 'resources' ? 'r' : 't'
        return send(res, 200, { [request.action]: discoveryMetadata(server, kind, await resourceCatalog(server, kind)) })
      }
      return send(res, 200, await manage(server, request))
    } catch (error) { send(res, 400, { error: error instanceof Error ? error.message : String(error) }) }
  } }), 'mcp-manager.admin')

  const loadServers = async (selected: any[], preset: object, scopes: any[], unavailable: Set<string>) => {
    const enabled = selected.filter(server => server.enabled && !connectionIssue(server) && (server.platformComposition || server.specUrl || resolvedUrl(server)))
    // 并发发现有界执行；单个上游失败时，其余工具仍可装载。
    const discoveries = config.withToolContext ? await Promise.allSettled(enabled.map(server => {
      const timeoutMs = Number.isSafeInteger(server.platformTimeoutMs) && server.platformTimeoutMs > 0
        ? Math.min(server.platformTimeoutMs, 10_000) : 10_000
      const timeout = AbortSignal.timeout(timeoutMs)
      return serverTools({ ...server, platformSignal: server.platformSignal
        ? AbortSignal.any([server.platformSignal, timeout]) : timeout })
    })) : []
    for (const [index, server] of enabled.entries()) {
      let discoveredTools: any[] = []
      if (config.withToolContext) {
        const result = discoveries[index]
        if (result.status === 'rejected') {
          if (server.platformSignal?.aborted) throw result.reason
          const status = result.reason instanceof Error ? result.reason.message.match(/\bHTTP\s+([1-5]\d\d)\b/)?.[1] : undefined
          ctx.logger?.warn(`MCP 服务 ${server.id} 工具发现失败${status ? `（HTTP ${status}）` : ''}；本次 Session 不装载该服务，请在 MCP 管理检查连接`)
          unavailable.add(server.id)
          continue
        }
        discoveredTools = result.value
      }
      const id = randomUUID()
      const scope = createScope(ctx, preset)
      scopes.push(scope)
      try {
        agents.set(id, { kind: 'agent', server })
        scope.ctx.effect(() => () => { agents.delete(id) }, 'mcp-manager.agent-endpoint')
        if (config.withToolContext) {
          if (server.platformGroup) scope.ctx.inject(['mcpResources'], (inner: any) => {
            inner.mcpResources.register(server.id, { request: (request: any, execution: any) => config.withToolContext(execution, async () => {
              server.platformAssertCurrent?.()
              const active = { ...server, platformSignal: execution.signal }
              const result = await withClient(active, client => {
                if (request.method === 'resources/list') return client.listResources(request.cursor ? { cursor: request.cursor } : undefined, { signal: execution.signal })
                if (request.method === 'resources/templates/list') return client.listResourceTemplates(request.cursor ? { cursor: request.cursor } : undefined, { signal: execution.signal })
                if (request.method === 'resources/read' && typeof request.uri === 'string') return client.readResource({ uri: request.uri }, { signal: execution.signal })
                throw new Error('不支持的 MCP Resource 操作')
              })
              server.platformAssertCurrent?.()
              return result
            }) })
            inner.effect(() => {
              const count = (registeredResourceServers.get(server.id) ?? 0) + 1
              registeredResourceServers.set(server.id, count)
              if (count === 1) config.onManagedResourceServer?.(server.id, true)
              return () => {
                const remaining = (registeredResourceServers.get(server.id) ?? 1) - 1
                if (remaining) registeredResourceServers.set(server.id, remaining)
                else { registeredResourceServers.delete(server.id); config.onManagedResourceServer?.(server.id, false) }
              }
            }, 'mcp-manager.group-resources')
          })
          // 直接复用原生工具桥；避免进程内 HTTP loopback 丢失每次调用的业务主体。
          for (const tool of discoveredTools.filter((item: any) => server.tools.mode === 'all' || server.tools.names.includes(item.name))) {
            const publicName = publicToolName(serverName(server), tool.name)
            scope.ctx.effect(() => {
              const unregister = scope.ctx.tools.register(McpClient.createMcpToolDefinition(scope.ctx, {
              name: publicName, rawName: tool.name,
              description: tool.description ?? '', inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
              call: (args: any, execution: any) => config.withToolContext(execution, async () => {
                const latest = snapshot(config).servers.find(item => item.id === server.id && item.enabled !== false)
                if (!latest || JSON.stringify([latest.specUrl, latest.url]) !== JSON.stringify([server.specUrl, server.url])) throw new Error('MCP 服务器目标已变化或已停用')
                return callManagedTool({ ...latest, platformSignal: execution.signal }, tool.name, args)
              }),
              }))
              const registration = `${server.id}\0${publicName}`
              const count = registeredTools.get(registration) ?? 0
              registeredTools.set(registration, count + 1)
              if (count === 0) config.onManagedTool?.(publicName, true)
              return () => {
                const remaining = (registeredTools.get(registration) ?? 1) - 1
                if (remaining) registeredTools.set(registration, remaining)
                else { registeredTools.delete(registration); config.onManagedTool?.(publicName, false) }
                return unregister()
              }
            })
          }
        } else await scope.ctx.plugin(McpClient, McpClient.Config({
          transport: 'streamable-http',
          serverName: serverName(server),
          url: `http://127.0.0.1:${ctx.webServer.port}${publicPath(`/mcp/agents/${id}`)}`,
          headers: { Authorization: `Bearer ${agentToken}` },
        }))
        unavailable.delete(server.id)
      } catch (error) {
        scopes.pop()
        await scope.dispose()
        unavailable.add(server.id)
        ctx.logger?.warn(`MCP 服务 ${server.id} 工具注册失败；本次 Session 不装载该服务，请检查工具定义`)
      }
    }
  }

  if (config.autoMountServers !== false) ctx.on('agent/created', ({ agent }: any) => {
    const preset = scopeParentOf(agent)
    if (!preset) return
    const current = snapshot(config)
    const version = JSON.stringify([current.servers, current.sharedToken])
    let entry = mounted.get(preset)
    const reused = entry?.version === version
    if (!reused) {
      const previous = entry
      const unavailable = new Set<string>()
      const ready = (async () => {
        if (previous) {
          await previous.retry?.catch(() => {})
          await Promise.all((await previous.ready.catch(() => [])).map(scope => scope.dispose()))
        }
        const scopes: any[] = []
        try {
          await loadServers(current.servers, preset, scopes, unavailable)
          return scopes
        } catch (error) {
          await Promise.all(scopes.map(scope => scope.dispose()))
          throw error
        }
      })()
      entry = { version, users: 0, ready, unavailable }
      mounted.set(preset, entry)
    }
    const active = entry!
    const release = async () => {
      active.users--
      if (active.users === 0) {
        if (mounted.get(preset) === active) mounted.delete(preset)
        await active.retry?.catch(() => {})
        await Promise.all((await active.ready.catch(() => [])).map(scope => scope.dispose()))
      }
    }
    active.users++
    agent.ctx.effect(() => release, 'mcp-manager.agent')
    // 外部发现只负责补充工具，不能阻塞原生 Session 创建和普通对话。
    void (async () => {
      try {
        await active.ready
        if (active.users === 0) return
        if (reused && active.unavailable.size) {
          active.retry ??= (async () => {
            const scopes = await active.ready
            const added: any[] = []
            const pending = new Set(active.unavailable)
            try {
              await loadServers(current.servers.filter(server => pending.has(server.id)), preset, added, active.unavailable)
              scopes.push(...added)
            } catch (error) {
              for (const id of pending) active.unavailable.add(id)
              await Promise.all(added.map(scope => scope.dispose()))
              throw error
            }
          })().finally(() => { active.retry = undefined })
          await active.retry
        }
      }
      catch (error) {
        ctx.logger?.warn('MCP 工具装载未完成；智能体继续运行，请在 MCP 管理检查连接')
      }
    })()
  }, { prepend: true })
}
