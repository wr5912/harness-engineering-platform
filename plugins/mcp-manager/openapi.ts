import { createHash } from 'node:crypto'

const MAX_DOCUMENT = 2 * 1024 * 1024
const MAX_RESULT = 1024 * 1024
const methods = new Set(['get', 'post', 'put', 'patch', 'delete'])

export function validateSpecUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('OpenAPI 规范地址须为不含凭据和片段的 HTTP(S) URL')
  }
  return url.href
}

async function limitedText(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('上游响应过大')
  const body = await response.arrayBuffer()
  if (body.byteLength > limit) throw new Error('上游响应过大')
  return new TextDecoder().decode(body)
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
  // shortcut: 仅保留 DSH 支持的约束；需要严格校验完整 OpenAPI Schema 时扩展 Runtime 子集。
  if (!value || typeof value !== 'object') return {}
  if (value.$ref) {
    const prefix = '#/components/schemas/'
    if (!String(value.$ref).startsWith(prefix)) throw new Error(`不支持的 Schema 引用：${value.$ref}`)
    const name = String(value.$ref).slice(prefix.length)
    const original = spec.components?.schemas?.[name]
    if (!original) throw new Error(`Schema 不存在：${name}`)
    // shortcut: 递归引用退化为任意 JSON；需要保留递归约束时再扩展 DSH Schema 支持。
    if (seen.has(name)) return {}
    return schemaOf(spec, original, new Set([...seen, name]))
  }
  const type = value.type ?? (value.properties ? 'object' : value.items ? 'array' : undefined)
  const result: any = {}
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  if (['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) result.type = type
  if (result.type === 'object') {
    result.properties = Object.fromEntries(Object.entries(value.properties ?? {}).map(([key, item]) => [key, schemaOf(spec, item, seen)]))
    if (Array.isArray(value.required)) result.required = value.required
    if (typeof value.additionalProperties === 'boolean') result.additionalProperties = value.additionalProperties
  } else if (result.type === 'array' && value.items) result.items = schemaOf(spec, value.items, seen)
  else if (['string', 'number', 'integer', 'boolean', 'null'].includes(result.type)) {
    const matches = (item: any) => result.type === 'null' ? item === null :
      result.type === 'integer' ? Number.isInteger(item) : typeof item === result.type
    if (Array.isArray(value.enum) && value.enum.length && value.enum.every(matches)) result.enum = value.enum
    if (value.const !== undefined && matches(value.const) && (!result.enum || result.enum.includes(value.const))) result.const = value.const
  }
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
    if (parameter.description) properties[parameter.name].description = parameter.description
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

function authHeaders(spec: any, operation: any, apiKey?: string): Record<string, string> {
  if (!apiKey) return {}
  const names = Object.keys((operation.security ?? spec.security ?? [])[0] ?? {})
  if (!names.length) return { Authorization: `Bearer ${apiKey}` }
  const scheme = spec.components?.securitySchemes?.[names[0]]
  if (scheme?.type === 'apiKey' && scheme.in === 'header') return { [scheme.name]: apiKey }
  if (scheme?.type === 'http' && scheme.scheme?.toLowerCase() === 'bearer') return { Authorization: `Bearer ${apiKey}` }
  throw new Error('当前仅支持 Header API Key 或 Bearer 认证')
}

export function validateAuthHeader(value: string): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) throw new Error('凭据 Header 字段名无效')
  return value
}

const loginCache = new Map<string, { config: string; token?: string; pending?: Promise<string> }>()

function loginState(server: any) {
  const id = String(server.id || server.specUrl)
  const config = JSON.stringify([server.specUrl, server.loginUrl, server.loginUsername, server.loginPassword, server.loginTokenPath])
  let state = loginCache.get(id)
  if (!state || state.config !== config) {
    state = { config }
    loginCache.set(id, state)
  }
  return state
}

async function loginToken(server: any): Promise<string> {
  const state = loginState(server)
  if (state.token) return state.token
  if (!state.pending) state.pending = (async () => {
    const response = await fetch(validateSpecUrl(server.loginUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: server.loginUsername, password: server.loginPassword }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`登录授权失败：HTTP ${response.status}`)
    const result = JSON.parse(await limitedText(response, MAX_RESULT))
    const token = String(server.loginTokenPath || 'token').split('.').reduce((value: any, part: string) => value?.[part], result)
    if (typeof token !== 'string' || !token) throw new Error('登录响应缺少凭据字段')
    state.token = token
    return token
  })().finally(() => { state.pending = undefined })
  return state.pending
}

async function authorizedFetch(server: any, url: URL, init: RequestInit, spec?: any, operation?: any, controlled?: any) {
  const request = async () => {
    const headers = new Headers(init.headers)
    let credential = server.apiKey || ''
    if (server.authType === 'login') {
      credential = await loginToken(server)
      for (const [name, value] of Object.entries(spec ? authHeaders(spec, operation, credential) :
        { Authorization: credential })) headers.set(name, value)
    } else if (server.authType === 'credential') {
      if (credential) headers.set(validateAuthHeader(server.authHeader ?? 'Authorization'), credential)
    } else {
      for (const [name, value] of Object.entries(spec ? authHeaders(spec, operation, credential) :
        credential ? { Authorization: `Bearer ${credential}` } : {})) headers.set(name, value)
    }
    const dispatch = (signal?: AbortSignal) => {
      for (const [name, value] of Object.entries(server.platformRequestHeaders?.(url.href) ?? {})) headers.set(name, String(value))
      return fetch(url, { ...init, signal: signal ?? init.signal, headers, redirect: controlled ? 'error' : init.redirect })
    }
    const response = controlled && server.platformExecute
      ? await server.platformExecute(controlled, dispatch, init.signal)
      : await dispatch()
    return { response, credential }
  }
  let result = await request()
  // 已派发的业务写请求不因 401 自动重放；规格发现仍可刷新凭据重试。
  if (result.response.status === 401 && server.authType === 'login' && !controlled) {
    const state = loginState(server)
    if (state.token === result.credential) state.token = undefined
    result = await request()
  }
  return result
}

export async function loadOpenApi(server: any): Promise<any> {
  const specUrl = validateSpecUrl(server.specUrl)
  let response = await fetch(specUrl, { signal: AbortSignal.timeout(20_000) })
  let retriedWithAuth = false
  if ([401, 403].includes(response.status) && (server.authType === 'login' || server.apiKey)) {
    await response.body?.cancel()
    response = (await authorizedFetch(server, new URL(specUrl), { signal: AbortSignal.timeout(20_000) })).response
    retriedWithAuth = true
  }
  if (!response.ok) throw new Error(`读取 OpenAPI 规范失败：HTTP ${response.status}（${retriedWithAuth ? '凭据重试' : '匿名访问'}）`)
  const spec = JSON.parse(await limitedText(response, MAX_DOCUMENT))
  if (!spec.openapi || !spec.paths || typeof spec.paths !== 'object') throw new Error('OpenAPI 规范缺少 openapi 或 paths')
  const base = new URL(spec.servers?.[0]?.url ?? '/', specUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('OpenAPI servers[0].url 无效')
  }
  const tools: any[] = []
  const resources: any[] = []
  const resourceTemplates: any[] = []
  const operations = new Map<string, any>()
  const readable: any[] = []
  for (const [path, pathItem] of Object.entries(spec.paths) as [string, any][]) {
    for (const [method, raw] of Object.entries(pathItem) as [string, any][]) {
      if (!methods.has(method)) continue
      const name = String(raw.operationId || `${method}_${path}`).replace(/[^A-Za-z0-9_.-]/g, '_')
      if (operations.has(name)) throw new Error(`OpenAPI 操作名重复：${name}`)
      const parameters = [...(pathItem.parameters ?? []), ...(raw.parameters ?? [])].map(item => resolveObject(spec, item))
      const body = raw.requestBody ? resolveObject(spec, raw.requestBody) : undefined
      const uri = operationUrl(base, path).href
      const description = raw.summary || raw.description || `${method.toUpperCase()} ${path}`
      const item = { name, method, path, parameters, body, raw, uri, description }
      operations.set(name, item)
      if (method === 'get' && !body && parameters.every(parameter => parameter.in === 'path')) {
        readable.push(item)
        const info = { name, description, mimeType: 'application/json' }
        if (parameters.length) resourceTemplates.push({ ...info, uriTemplate: uri.replace(/%7B/gi, '{').replace(/%7D/gi, '}') })
        else resources.push({ ...info, uri })
      } else {
        tools.push({ name, description, inputSchema: operationSchema(spec, parameters, body) })
      }
    }
  }
  const businessTools = [...tools, ...readable.map(item => ({ name: item.name, description: item.description,
    inputSchema: operationSchema(spec, item.parameters, item.body) }))]
  return { spec, base, tools, businessTools, resources, resourceTemplates, operations, readable, server }
}

async function execute(source: any, item: any, args: any): Promise<{ response: Response; text: string; uri: string }> {
  const url = operationUrl(source.base, item.path)
  for (const parameter of item.parameters) {
    const value = args?.[parameter.name]
    if (value === undefined || value === null) {
      if (parameter.required || parameter.in === 'path') throw new Error(`缺少参数：${parameter.name}`)
      continue
    }
    if (parameter.in === 'path') url.pathname = url.pathname.replace(encodeURIComponent(`{${parameter.name}}`), encodeURIComponent(String(value)))
    if (parameter.in === 'query') for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(parameter.name, String(entry))
  }
  const headers: Record<string, string> = {}
  for (const parameter of item.parameters.filter((entry: any) => entry.in === 'header')) {
    if (args?.[parameter.name] !== undefined) headers[parameter.name] = String(args[parameter.name])
  }
  if (item.body) headers['content-type'] = 'application/json'
  const controlled = { serverId: source.server.id, operationId: item.name, kind: 'write',
    target: url.href, method: item.method.toUpperCase(), args,
    schemaDigest: createHash('sha256').update(JSON.stringify(item.raw)).digest('hex') }
  const { response, credential } = await authorizedFetch(source.server, url, { method: item.method.toUpperCase(), headers,
    body: item.body && args?.body !== undefined ? JSON.stringify(args.body) : undefined,
    signal: AbortSignal.timeout(20_000) }, source.spec, item.raw, controlled)
  const raw = await limitedText(response, MAX_RESULT)
  let text = raw
  for (const secret of [credential, source.server.apiKey, source.server.loginPassword]) {
    if (secret) text = text.replaceAll(secret, '[redacted]')
  }
  return { response, text, uri: url.href }
}

export async function callOpenApiTool(source: any, name: string, args: any): Promise<any> {
  const item = source.operations.get(name)
  if (!item || source.readable.includes(item) && !source.server.platformToolResources) throw new Error('工具不属于当前 OpenAPI 范围')
  const { response, text } = await execute(source, item, args)
  return { content: [{ type: 'text', text: text || `HTTP ${response.status}` }], isError: !response.ok }
}

export async function readOpenApiResource(source: any, uri: string): Promise<any> {
  const request = new URL(uri)
  if (request.search || request.hash) throw new Error('Resource URI 不属于当前 OpenAPI 范围')
  for (const item of source.readable) {
    const template = new URL(item.uri)
    if (request.origin !== template.origin) continue
    const expected = template.pathname.split('/').map(decodeURIComponent)
    const actual = request.pathname.split('/')
    if (expected.length !== actual.length) continue
    const args: Record<string, string> = {}
    if (!expected.every((part, index) => {
      const variable = /^\{([^{}]+)\}$/.exec(part)
      if (variable) { args[variable[1]] = decodeURIComponent(actual[index]); return true }
      return part === actual[index]
    })) continue
    const { response, text } = await execute(source, item, args)
    if (!response.ok) throw new Error(`Resource 读取失败：HTTP ${response.status}`)
    return { contents: [{ uri, mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/json', text }] }
  }
  throw new Error('Resource URI 不属于当前 OpenAPI 范围')
}
