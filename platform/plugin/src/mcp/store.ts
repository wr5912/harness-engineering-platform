import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { prepareBusinessRuntimeFile } from '../business-control/secret-file.ts'
import { mcpCredentialFile, mcpCredentialPaths } from './credential-path.ts'

type Document = { schemaVersion: 1; servers: any[]; groups: any[] }
type Secrets = { schemaVersion: 1; sharedToken: string; servers: Record<string, {
  apiKey?: string; loginUsername?: string; loginPassword?: string; headers?: Record<string, string>
}> }
export type McpConfiguration = { servers: any[]; groups: any[]; sharedToken: string }
export type McpConfigurationView = { revision: string; value: McpConfiguration; publicUrl?: string }

/** Runtime 只读取平台已有分组凭据，不把它投影进 Candidate。 */
export function readMcpSharedToken(assetRoot: string): string {
  const { value } = readJson(mcpCredentialFile(assetRoot))
  if (typeof value?.sharedToken !== 'string' || !value.sharedToken) throw new Error('MCP 分组凭据不可用')
  return value.sharedToken
}

function readJson(path: string): { raw: string; value: any } {
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('MCP 数据配置或本地凭据不存在；请运行平台 prepare 完成迁移')
    throw error
  }
  try { return { raw, value: JSON.parse(raw) } }
  catch { throw new Error('MCP 数据配置或本地凭据 JSON 无效') }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

const serverFields = new Set(['id', 'serverName', 'description', 'enabled', 'specUrl', 'authType', 'authHeader',
  'loginUrl', 'loginTokenPath', 'url', 'headers', 'managementUrl', 'tools'])
const groupFields = new Set(['id', 'members'])
const memberFields = new Set(['serverId', 'names', 'resourceUris', 'resourceTemplates'])
const privateFields = new Set(['apiKey', 'loginUsername', 'loginPassword', 'headers'])
const credentialFields = ['apiKey', 'loginUsername', 'loginPassword'] as const
function onlyFields(value: Record<string, any>, fields: Set<string>): boolean {
  return Object.keys(value).every(key => fields.has(key))
}

function checkDocument(document: any, secrets: any): asserts document is Document {
  if (!isRecord(document) || !onlyFields(document, new Set(['schemaVersion', 'servers', 'groups']))
    || document.schemaVersion !== 1 || !Array.isArray(document.servers) || !Array.isArray(document.groups)
    || !isRecord(secrets) || secrets.schemaVersion !== 1 || typeof secrets.sharedToken !== 'string'
    || !onlyFields(secrets, new Set(['schemaVersion', 'sharedToken', 'servers']))
    || !isRecord(secrets.servers)) throw new Error('MCP 数据配置或本地凭据结构无效')
  for (const server of document.servers) {
    if (!isRecord(server) || !onlyFields(server, serverFields) || typeof server.id !== 'string'
      || server.tools !== undefined && (!isRecord(server.tools) || !onlyFields(server.tools, new Set(['mode', 'names'])))
      || server.headers !== undefined && (!Array.isArray(server.headers)
        || server.headers.some((header: unknown) => !isRecord(header) || !onlyFields(header, new Set(['name']))
          || typeof header.name !== 'string'))) throw new Error('MCP 服务公开配置含无效字段或凭据')
    for (const field of ['specUrl', 'loginUrl', 'url', 'managementUrl']) {
      if (!server[field]) continue
      let url: URL
      try { url = new URL(server[field]) } catch { throw new Error('MCP 服务地址无效') }
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|passw(?:or)?d|credential|auth|signature|api[-_]?key/i.test(key))) {
        throw new Error('MCP 服务地址包含凭据参数；请改用受控凭据字段')
      }
    }
  }
  for (const group of document.groups) {
    if (!isRecord(group) || !onlyFields(group, groupFields) || typeof group.id !== 'string'
      || !Array.isArray(group.members) || group.members.some((member: unknown) => !isRecord(member)
        || !onlyFields(member, memberFields))) throw new Error('MCP 分组公开配置含无效字段')
  }
  for (const [id, value] of Object.entries(secrets.servers)) {
    if (!document.servers.some(server => server.id === id) || !isRecord(value) || !onlyFields(value, privateFields)
      || credentialFields.some(key => value[key] !== undefined && typeof value[key] !== 'string')
      || value.headers !== undefined && (!isRecord(value.headers)
        || Object.entries(value.headers).some(([name, item]) => typeof item !== 'string'
          || !document.servers.find((server: any) => server.id === id)?.headers?.some((header: { name: string }) => header.name === name)))) {
      throw new Error('MCP 本地凭据与服务配置不一致')
    }
  }
}

function merge(document: Document, secrets: Secrets): McpConfiguration {
  return { servers: document.servers.map(server => {
    const privateValue = secrets.servers[server.id] ?? {}
    return { ...server,
      ...Object.fromEntries(credentialFields.filter(key => Object.hasOwn(privateValue, key)).map(key => [key, privateValue[key]])),
      ...(server.headers !== undefined ? { headers: server.headers.map((header: { name: string }) => ({
        ...header, value: privateValue.headers?.[header.name] ?? '',
      })) } : {}),
    }
  }), groups: document.groups, sharedToken: secrets.sharedToken }
}

function split(value: McpConfiguration): { document: Document; secrets: Secrets } {
  const privateServers: Secrets['servers'] = Object.create(null)
  const publicServers = value.servers.map(server => {
    const copy = structuredClone(server)
    const privateValue: Secrets['servers'][string] = {}
    for (const key of credentialFields) {
      if (copy[key] !== undefined) {
        if (typeof copy[key] !== 'string') throw new Error('MCP 凭据字段必须是字符串')
        privateValue[key] = copy[key]
        delete copy[key]
      }
    }
    if (copy.headers !== undefined) {
      if (!Array.isArray(copy.headers)) throw new Error('MCP Header 配置无效')
      const values: Record<string, string> = Object.create(null)
      copy.headers = copy.headers.map((header: any) => {
        if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') {
          throw new Error('MCP Header 配置无效')
        }
        values[header.name] = header.value
        return { name: header.name }
      })
      if (Object.keys(values).length) privateValue.headers = values
    }
    if (Object.keys(privateValue).length) privateServers[server.id] = privateValue
    return copy
  })
  return { document: { schemaVersion: 1, servers: publicServers, groups: structuredClone(value.groups) },
    secrets: { schemaVersion: 1, sharedToken: value.sharedToken, servers: privateServers } }
}

function atomicReplace(path: string, content: string, mode: number, business = false): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const file = openSync(temporary, 'wx', mode)
  try {
    try { writeFileSync(file, content); fchmodSync(file, mode); fsyncSync(file) }
    finally { closeSync(file) }
    if (business) prepareBusinessRuntimeFile(temporary)
    renameSync(temporary, path)
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

/** 数据仓库保存服务和分组，本地忽略文件只保存凭据；原生 Profile 不承载当前事实。 */
export class McpConfigStore {
  private readonly publicFile: string
  private readonly assetRoot: string
  private readonly validate: (value: McpConfiguration) => void
  constructor(assetRoot: string, validate: (value: McpConfiguration) => void) {
    this.assetRoot = assetRoot
    this.publicFile = join(assetRoot, 'config', 'mcp-manager.json')
    this.validate = validate
  }
  private get secretFile(): string { return mcpCredentialFile(this.assetRoot) }
  private get lockFile(): string {
    const paths = mcpCredentialPaths(this.assetRoot)
    return this.secretFile === paths.legacyFile ? paths.legacyLock : paths.lock
  }
  private readView(publicData = readJson(this.publicFile), privateData = readJson(this.secretFile)): McpConfigurationView {
    checkDocument(publicData.value, privateData.value)
    const value = merge(publicData.value, privateData.value as Secrets)
    this.validate(value)
    return { revision: createHash('sha256').update(publicData.raw).update('\0').update(privateData.raw).digest('hex'), value }
  }
  view(): McpConfigurationView {
    const pause = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 5; attempt++) {
      if (existsSync(this.lockFile)) { Atomics.wait(pause, 0, 0, 10); continue }
      const publicData = readJson(this.publicFile), privateData = readJson(this.secretFile)
      if (existsSync(this.lockFile)
        || publicData.raw !== readFileSync(this.publicFile, 'utf8')
        || privateData.raw !== readFileSync(this.secretFile, 'utf8')) { Atomics.wait(pause, 0, 0, 10); continue }
      return this.readView(publicData, privateData)
    }
    throw new Error('MCP 配置正在保存或保存锁未释放，请稍后重试')
  }
  mutate(ops: any[], revision: string): McpConfigurationView {
    if (!Array.isArray(ops) || typeof revision !== 'string') throw new Error('MCP 保存需要原始版本和修改操作')
    const lockFile = this.lockFile
    let lock: number
    try { lock = openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('MCP 配置正在保存或保存锁未释放，请稍后重试')
      throw error
    }
    try { return this.mutateLocked(ops, revision) }
    finally { closeSync(lock); unlinkSync(lockFile) }
  }
  private mutateLocked(ops: any[], revision: string): McpConfigurationView {
    const current = this.readView()
    if (current.revision !== revision) throw new Error('MCP 配置已变化；请刷新后重试')
    const next = structuredClone(current.value) as Record<string, any>
    for (const op of ops) {
      const path = op?.path
      if (!Array.isArray(path) || !path.length || !['servers', 'groups', 'sharedToken'].includes(path[0])
        || path.some((part: unknown) => !/^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_-]+$/.test(String(part)))
        || !['set', 'unset'].includes(op.op)) throw new Error('MCP 修改路径或操作无效')
      let parent: any = next
      for (const part of path.slice(0, -1)) {
        if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw new Error('MCP 修改路径不存在')
        parent = parent[part]
      }
      const key = path.at(-1)
      if (parent === null || typeof parent !== 'object' || Array.isArray(parent) && !/^\d+$/.test(String(key))) {
        throw new Error('MCP 修改路径无效')
      }
      if (op.op === 'set') parent[key] = structuredClone(op.value)
      else if (Array.isArray(parent)) parent.splice(Number(key), 1)
      else delete parent[key]
    }
    if (!Array.isArray(next.servers) || !Array.isArray(next.groups) || typeof next.sharedToken !== 'string') {
      throw new Error('MCP 配置字段无效')
    }
    this.validate(next as McpConfiguration)
    const { document, secrets } = split(next as McpConfiguration)
    checkDocument(document, secrets)
    const publicRaw = JSON.stringify(document, null, 2) + '\n'
    const privateRaw = JSON.stringify(secrets, null, 2) + '\n'
    const previousSecret = readFileSync(this.secretFile, 'utf8')
    const publicMode = statSync(this.publicFile).mode & 0o777
    atomicReplace(this.secretFile, privateRaw, 0o600, true)
    try { atomicReplace(this.publicFile, publicRaw, publicMode) }
    catch (error) { atomicReplace(this.secretFile, previousSecret, 0o600, true); throw error }
    return this.readView()
  }
}
