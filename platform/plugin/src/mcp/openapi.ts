import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ManagedDispatch } from './control.ts'
import type { BusinessOperation } from '../business-control/contracts.ts'

const MAX_DOCUMENT = 2 * 1024 * 1024
const MAX_RESULT = 512 * 1024
const methods = new Set(['get', 'post', 'put', 'patch', 'delete'])

export type CredentialRef = { kind: 'file'; path: string }
export type OpenApiConnection = {
  id: string
  name?: string
  specUrl: string
  credentialRef?: CredentialRef
  authHeader?: string
}

export type LoadedOpenApi = {
  connection: OpenApiConnection
  spec: any
  specDigest: string
  base: URL
  operations: Map<string, any>
  tools: { name: string; description: string; inputSchema: any }[]
}

export function publicConnection(connection: OpenApiConnection) {
  return {
    kind: 'openapi',
    id: connection.id,
    name: connection.name ?? connection.id,
    specUrl: connection.specUrl,
    credential_configured: Boolean(connection.credentialRef),
  }
}

function validateId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error('连接 ID 无效')
  return value
}

export function normalizeConnection(value: unknown): OpenApiConnection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('连接配置无效')
  const input = value as Record<string, any>
  const specUrl = validateSpecUrl(String(input.specUrl ?? ''))
  let credentialRef: CredentialRef | undefined
  if (input.credentialRef !== undefined) {
    if (!input.credentialRef || input.credentialRef.kind !== 'file' || typeof input.credentialRef.path !== 'string') {
      throw new Error('凭据只能使用专用文件引用')
    }
    credentialRef = { kind: 'file', path: input.credentialRef.path }
  }
  return {
    id: validateId(String(input.id ?? '')),
    name: typeof input.name === 'string' && input.name ? input.name.slice(0, 80) : undefined,
    specUrl,
    credentialRef,
    authHeader: input.authHeader === undefined ? undefined : validateAuthHeader(String(input.authHeader)),
  }
}

export function validateSpecUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('OpenAPI 规范地址须为不含凭据和片段的 HTTP(S) URL')
  }
  for (const [key, value] of url.searchParams) {
    if (/token|secret|password|credential|apikey|api_key|authorization/i.test(key) || /bearer\s+|token|secret/i.test(value)) {
      throw new Error('OpenAPI 规范地址 query 不得包含凭据')
    }
  }
  return url.href
}

function validateAuthHeader(value: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) throw new Error('凭据 Header 字段名无效')
  return value
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function limitedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('上游响应过大')
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error('上游响应过大')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function credentialOf(connection: OpenApiConnection): Promise<string | undefined> {
  if (!connection.credentialRef) return undefined
  return (await readFile(connection.credentialRef.path, 'utf8')).trim()
}

function authHeaders(connection: OpenApiConnection, token?: string): Record<string, string> {
  if (!token) return {}
  if (connection.authHeader && connection.authHeader.toLowerCase() !== 'authorization') return { [connection.authHeader]: token }
  return { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` }
}

async function fetchWithAuth(connection: OpenApiConnection, url: URL, init: RequestInit = {}, control?: ManagedDispatch, operation?: BusinessOperation) {
  const token = await credentialOf(connection)
  const headers = new Headers(init.headers)
  for (const [name, value] of Object.entries(authHeaders(connection, token))) headers.set(name, value)
  const dispatch = (signal?: AbortSignal) => {
    for (const [name, value] of Object.entries(control?.requestHeaders?.(url.href) ?? {})) headers.set(name, value)
    return fetch(url, { ...init, signal: signal ?? init.signal, headers, redirect: control ? 'error' : init.redirect })
  }
  return { response: await (control && operation ? control(operation, dispatch, init.signal ?? undefined) : dispatch()), token }
}

function resolveObject(spec: any, value: any): any {
  if (!value?.$ref) return value
  const path = String(value.$ref).split('/')
  if (path[0] !== '#' || path[1] !== 'components') throw new Error(`不支持的 OpenAPI 引用：${value.$ref}`)
  const target = path.slice(1).reduce((item, part) => item?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
  if (!target) throw new Error(`OpenAPI 引用不存在：${value.$ref}`)
  return target
}

function schemaOf(spec: any, value: any, seen = new Set<string>()): any {
  // shortcut: 仅保留当前 DSH 工具 Schema 会消费的 OpenAPI 子集；需要强校验再扩展。
  if (!value || typeof value !== 'object') return {}
  if (value.oneOf || value.anyOf || value.allOf || value.not) throw new Error('当前 Schema 子集不支持组合约束')
  if (value.$ref) {
    const prefix = '#/components/schemas/'
    if (!String(value.$ref).startsWith(prefix)) throw new Error(`不支持的 Schema 引用：${value.$ref}`)
    const name = String(value.$ref).slice(prefix.length)
    if (seen.has(name)) throw new Error(`不支持递归 Schema 引用：${value.$ref}`)
    const target = spec.components?.schemas?.[name]
    if (!target) throw new Error(`Schema 引用不存在：${value.$ref}`)
    return schemaOf(spec, target, new Set([...seen, name]))
  }
  const type = value.type ?? (value.properties ? 'object' : value.items ? 'array' : undefined)
  const result: any = {}
  if (value.description) result.description = value.description
  if (['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(type)) result.type = type
  if (result.type === 'object') {
    result.properties = Object.fromEntries(Object.entries(value.properties ?? {}).map(([key, item]) => [key, schemaOf(spec, item, seen)]))
    if (Array.isArray(value.required)) result.required = value.required
  } else if (result.type === 'array' && value.items) result.items = schemaOf(spec, value.items, seen)
  return result
}

function operationUrl(base: URL, path: string): URL {
  return new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base.origin)
}

function operationSchema(spec: any, parameters: any[], body: any): any {
  const properties: Record<string, any> = {}
  const required: string[] = []
  for (const parameter of parameters) {
    properties[parameter.name] = schemaOf(spec, parameter.schema ?? { type: 'string' })
    if (parameter.required || parameter.in === 'path') required.push(parameter.name)
  }
  if (body) {
    const content = body.content?.['application/json']
    if (!content) throw new Error('当前仅支持 application/json 请求体')
    properties.body = schemaOf(spec, content.schema ?? { type: 'object' })
    if (body.required) required.push('body')
  }
  return { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}) }
}

export async function loadOpenApi(connection: OpenApiConnection, signal?: AbortSignal): Promise<LoadedOpenApi> {
  const specUrl = validateSpecUrl(connection.specUrl)
  let response = await fetch(specUrl, { signal })
  if ([401, 403].includes(response.status) && connection.credentialRef) {
    await response.body?.cancel()
    response = (await fetchWithAuth(connection, new URL(specUrl), { signal })).response
  }
  if (!response.ok) throw new Error(`读取 OpenAPI 规范失败：HTTP ${response.status}`)
  const spec = JSON.parse(await limitedText(response, MAX_DOCUMENT))
  if (!spec.openapi || !spec.paths || typeof spec.paths !== 'object') throw new Error('OpenAPI 规范缺少 openapi 或 paths')
  const base = new URL(spec.servers?.[0]?.url ?? '/', specUrl)
  const operations = new Map<string, any>()
  const tools: LoadedOpenApi['tools'] = []
  for (const [path, pathItem] of Object.entries(spec.paths) as [string, any][]) {
    for (const [method, raw] of Object.entries(pathItem) as [string, any][]) {
      if (!methods.has(method)) continue
      const name = String(raw.operationId || `${method}_${path}`).replace(/[^A-Za-z0-9_.-]/g, '_')
      if (operations.has(name)) throw new Error(`OpenAPI 操作名重复：${name}`)
      const parameters = [...(pathItem.parameters ?? []), ...(raw.parameters ?? [])].map(item => resolveObject(spec, item))
      const body = raw.requestBody ? resolveObject(spec, raw.requestBody) : undefined
      const operation = { name, method, path, parameters, body, raw, description: raw.summary || raw.description || `${method.toUpperCase()} ${path}` }
      operations.set(name, operation)
      tools.push({ name, description: operation.description, inputSchema: operationSchema(spec, parameters, body) })
    }
  }
  return { connection, spec, specDigest: digestOf(spec), base, operations, tools }
}

function sanitizeUrl(url: URL): string {
  const safe = new URL(url.href)
  for (const key of [...safe.searchParams.keys()]) {
    if (/token|secret|password|credential|apikey|api_key|authorization/i.test(key)) safe.searchParams.set(key, '[redacted]')
  }
  return safe.href
}

export function redacted(value: any): any {
  if (Array.isArray(value)) return value.map(redacted)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /token|secret|password|credential|authorization/i.test(key) ? '[redacted]' : redacted(item),
  ]))
}

export function appendQueryParameter(query: URLSearchParams, parameter: any, value: any) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ((parameter.style ?? 'form') !== 'form' || parameter.explode === false) throw new Error(`不支持的对象查询参数编码：${parameter.name}`)
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object' && !Array.isArray(item)) throw new Error(`不支持嵌套对象查询参数：${parameter.name}`)
      if (item !== undefined && item !== null) appendQueryParameter(query, { name: key }, item)
    }
  } else {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && typeof item === 'object') throw new Error(`查询参数必须为标量：${parameter.name}`)
      query.append(parameter.name, String(item))
    }
  }
}

export async function callOpenApiOperation(source: LoadedOpenApi, operationId: string, args: Record<string, any>, signal?: AbortSignal, control?: ManagedDispatch) {
  const operation = source.operations.get(operationId)
  if (!operation) throw new Error(`OpenAPI 操作不存在：${operationId}`)
  const url = operationUrl(source.base, operation.path)
  const headers: Record<string, string> = {}
  for (const parameter of operation.parameters) {
    const value = args?.[parameter.name]
    if (value === undefined || value === null) {
      if (parameter.required || parameter.in === 'path') throw new Error(`缺少参数：${parameter.name}`)
      continue
    }
    if (parameter.in === 'path') url.pathname = url.pathname.replace(encodeURIComponent(`{${parameter.name}}`), encodeURIComponent(String(value)))
    if (parameter.in === 'query') appendQueryParameter(url.searchParams, parameter, value)
    if (parameter.in === 'header') headers[parameter.name] = String(value)
  }
  if (operation.body?.required && args.body === undefined) throw new Error('缺少参数：body')
  if (operation.body) headers['content-type'] = 'application/json'
  const { response, token } = await fetchWithAuth(source.connection, url, {
    method: operation.method.toUpperCase(),
    headers,
    body: operation.body && args.body !== undefined ? JSON.stringify(args.body) : undefined,
    signal,
  }, control, { serverId: source.connection.id, operationId, kind: 'write', target: url.href,
    method: operation.method.toUpperCase(), args, schemaDigest: digestOf(operation.raw) })
  let text = await limitedText(response, MAX_RESULT)
  for (const secret of [token]) if (secret) text = text.replaceAll(secret, '[redacted]')
  let json: any
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return {
    ok: response.ok,
    status: response.status,
    url: sanitizeUrl(url),
    json: redacted(json),
    receipt: {
      connectionId: source.connection.id,
      specDigest: source.specDigest,
      operationId,
      method: operation.method.toUpperCase(),
      path: operation.path,
      schemaDigest: digestOf(operation.raw),
    },
  }
}
