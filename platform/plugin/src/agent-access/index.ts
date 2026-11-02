import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { AccessError, type AgentAccessOptions } from './contracts.ts'
import { AgentAccessService } from './service.ts'
export { AgentAccessService } from './service.ts'
export { AccessError } from './contracts.ts'
export type { AgentAccessOptions, AccessResource, ResourceTool, ResourceGrant } from './contracts.ts'

const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let length = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > 1024 * 1024) throw new AccessError('invalid_request', '请求过大', 413)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
function basic(req: IncomingMessage) {
  const value = req.headers.authorization
  if (!value?.startsWith('Basic ')) throw new AccessError('invalid_client', '需要实例客户端认证', 401)
  const encoded = value.slice(6)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new AccessError('invalid_client', '客户端认证格式无效', 401)
  const decoded = Buffer.from(encoded, 'base64').toString('utf8'), separator = decoded.indexOf(':')
  if (separator < 1 || separator === decoded.length - 1) throw new AccessError('invalid_client', '客户端认证格式无效', 401)
  return { clientId: decodeURIComponent(decoded.slice(0, separator)), secret: decodeURIComponent(decoded.slice(separator + 1)) }
}
function bearer(req: IncomingMessage) {
  const value = req.headers.authorization
  if (!value?.startsWith('Bearer ') || value.length > 16384) throw new AccessError('invalid_token', '此资源必须提供 Harness 访问凭证', 401)
  return value.slice(7)
}

/** 独立机器入口，匹配的路径始终在此终结，不能降级到管理身份。 */
export function createAgentAccessHandler(assetRoot: string, options: AgentAccessOptions = {}) {
  const service = new AgentAccessService(assetRoot, options)
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? '/', 'http://internal').pathname
    const resourceMatch = /^\/api\/agent-access\/v1\/resources\/([a-z0-9-]+)\/mcp$/.exec(path)
    if (path !== '/oauth/token' && path !== '/api/agent-access/v1/self/status' && !path.startsWith('/api/agent-access/v1/resources/')) return false
    try {
      if (path === '/api/agent-access/v1/self/status') {
        if (req.method !== 'GET') throw new AccessError('method_not_allowed', '只允许 GET', 405)
        const { clientId, secret } = basic(req)
        send(res, 200, service.selfStatus(clientId, secret)); return true
      }
      if (req.method !== 'POST') throw new AccessError('method_not_allowed', '只允许 POST', 405)
      if (path === '/oauth/token') {
        if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) throw new AccessError('invalid_request', '令牌请求必须使用表单编码')
        const params = new URLSearchParams(await body(req))
        const allowed = ['grant_type', 'resource', 'scope']
        if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw new AccessError('invalid_request', '令牌请求包含未知或重复参数')
        if (params.get('grant_type') !== 'client_credentials') throw new AccessError('unsupported_grant_type', '仅支持客户端凭据授权')
        const { clientId, secret } = basic(req)
        const result = await service.issue(clientId, secret, params.get('resource') ?? '', (params.get('scope') ?? '').split(' ').filter(Boolean))
        send(res, 200, result); return true
      }
      if (!resourceMatch) throw new AccessError('invalid_target', '签名资源路径无效', 404)
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AccessError('invalid_request', 'MCP 请求必须使用 JSON')
      const token = bearer(req), resourceId = resourceMatch[1], current = await service.verify(token, resourceId)
      const input = JSON.parse(await body(req))
      if (!input || input.jsonrpc !== '2.0' || typeof input.method !== 'string' || Array.isArray(input)) throw new AccessError('invalid_request', 'MCP 请求格式无效')
      if (input.method.startsWith('notifications/')) { res.writeHead(202, { 'cache-control': 'no-store' }); res.end(); return true }
      let result: unknown
      if (input.method === 'initialize') {
        const protocolVersion = input.params?.protocolVersion
        if (!['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'].includes(protocolVersion)) throw new AccessError('unsupported_protocol', 'MCP 协议版本不受支持')
        result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'harness-protected-resource', version: '1.0.0' } }
      } else if (input.method === 'tools/list') {
        result = { tools: current.resource.tools.filter(tool => current.scopes.includes(tool.scope)).map(tool => ({ name: tool.name,
          description: tool.description ?? tool.name, inputSchema: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false } })) }
      } else if (input.method === 'tools/call') {
        if (typeof input.params?.name !== 'string') throw new AccessError('invalid_request', '缺少工具名称')
        const abort = new AbortController()
        res.once('close', () => { if (!res.writableEnded) abort.abort() })
        result = await service.dispatch(token, resourceId, input.params.name, input.params.arguments ?? {}, AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]))
      } else if (input.method === 'ping') result = {}
      else throw new AccessError('method_not_found', '未开放此 MCP 方法', 404)
      send(res, 200, { jsonrpc: '2.0', id: input.id, result }); return true
    } catch (error) {
      const known = error instanceof AccessError, status = known ? error.status : error instanceof SyntaxError ? 400 : 503
      if (!known || !['result_unknown', 'result_recording_failed', 'upstream_error', 'upstream_response_too_large'].includes(error.code)) {
        try { service.recordDenial(known ? error.code : status === 400 ? 'invalid_request' : 'temporarily_unavailable', resourceMatch?.[1]) } catch { /* 记录故障时不派发，也不将秘密带入错误响应。 */ }
      }
      if (status === 401) res.setHeader('www-authenticate', path === '/oauth/token' || path.endsWith('/self/status') ? 'Basic realm="harness-instance"' : 'Bearer realm="harness-resource"')
      send(res, status, { error: known ? error.code : status === 400 ? 'invalid_request' : 'temporarily_unavailable', error_description: known ? error.message : status === 400 ? '请求格式无效' : '机器访问服务暂不可用' })
      return true
    }
  }
}

export function createAgentAccessManagement(assetRoot: string, options: AgentAccessOptions = {}): ConnectionRpcHandler {
  const service = new AgentAccessService(assetRoot, options)
  return async (endpoint, payload, signal, peer) => {
    try {
      if (peer?.principal?.kind !== 'owner') throw new AccessError('forbidden', '实例机器身份管理仅供平台 owner 使用', 403)
      signal.throwIfAborted()
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AccessError('invalid_request', '请求参数必须是对象')
      const request = payload as Record<string, unknown>
      const instanceId = typeof request.instanceId === 'string' ? request.instanceId : ''
      let value: unknown
      if (endpoint === 'status') value = service.status(instanceId)
      else if (endpoint === 'createCredential' || endpoint === 'rotateCredential') value = service.createCredential(instanceId, endpoint === 'rotateCredential')
      else if (endpoint === 'revokeCredential') value = service.revokeCredential(instanceId, String(request.credentialId ?? ''))
      else if (endpoint === 'saveGrant') value = service.saveGrant(request)
      else if (endpoint === 'disableResourceAccess') value = service.disableResourceAccess(instanceId, String(request.revision ?? ''))
      else if (endpoint === 'rotateSigningKey') value = await service.rotateSigningKey()
      else if (endpoint === 'disableSigningKey') value = service.disableSigningKey(String(request.kid ?? ''))
      else return { ok: false, error: { code: 'not_found', message: '未知实例机器身份操作', details: {} } }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: { code: error instanceof AccessError ? error.code : 'agent_access_failed', message: error instanceof AccessError ? error.message : '机器身份操作失败，请核对服务状态', details: {} } }
    }
  }
}
