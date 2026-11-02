import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { authenticateExternal, invokeExternal, streamExternal, type ExternalCaller } from './access.ts'
import { probeExternal } from './adapters.ts'
import { externalDetail, externalInstances, ExternalAccessError, getExternalInstance, mutateExternal, object, readExternalRecords, text } from './registry.ts'
import type { ExternalInvocation } from './types.ts'
export { authorizeExternalOperation } from './access.ts'
export { getExternalInstance, externalInstances, externalDetail } from './registry.ts'

export function createExternalInstancesHandler(assetRoot: string): ConnectionRpcHandler {
  return async (endpoint, payload, signal, peer) => {
    try {
      if (peer?.principal?.kind !== 'owner') throw new ExternalAccessError('forbidden', '接入管理仅供平台管理者使用', 403)
      signal.throwIfAborted()
      const input = object(payload ?? {})
      if (endpoint === 'list') return { ok: true, value: externalInstances(assetRoot) }
      if (endpoint === 'detail') return { ok: true, value: externalDetail(assetRoot, text(input.id, '实例标识')) }
      if (endpoint === 'records') return { ok: true, value: { records: readExternalRecords(assetRoot, text(input.id, '实例标识')) } }
      if (endpoint === 'request') {
        const list = externalInstances(assetRoot), requestId = text(input.requestId, '请求标识')
        const instance = list.instances.find(instance => readExternalRecords(assetRoot, instance.id).some(record => record.requestId === requestId))
        return { ok: true, value: instance ? { found: true, detail: externalDetail(assetRoot, instance.id) } : { found: false, note: '尚无匹配回执，请保留草稿与原请求标识。' } }
      }
      if (endpoint === 'invoke') return { ok: true, value: await invokeExternal(assetRoot, { subjectId: 'platform-owner', source: 'authenticated-platform-owner', expiresAt: new Date(Date.now() + 60000).toISOString() }, input as ExternalInvocation, signal) }
      if (endpoint === 'verify') {
        const instance = getExternalInstance(assetRoot, text(input.id, '实例标识'))
        if (!instance || instance.state === 'removed') throw new ExternalAccessError('not_found', '接入实例不存在', 404)
        const verification = await probeExternal(assetRoot, instance, signal)
        signal.throwIfAborted()
        return { ok: true, value: mutateExternal(assetRoot, 'verify', input, verification) }
      }
      if (['save', 'enable', 'disable', 'remove'].includes(endpoint)) return { ok: true, value: mutateExternal(assetRoot, endpoint as 'save' | 'enable' | 'disable' | 'remove', input) }
      throw new ExternalAccessError('not_found', '未知的接入实例操作', 404)
    } catch (error) { return { ok: false, error: { code: error instanceof ExternalAccessError ? error.code : 'external_failed', message: error instanceof ExternalAccessError ? error.message : '接入操作未完成，请核对配置、凭据文件或依赖状态。', details: {} } } }
  }
}
export interface ExternalHttpOptions { authenticate?: (req: IncomingMessage, signal: AbortSignal) => Promise<ExternalCaller> }
async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new ExternalAccessError('body_too_large', '请求内容过大', 413); chunks.push(chunk) }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { if (error instanceof ExternalAccessError) throw error; throw new ExternalAccessError('invalid_request', '请求正文必须为 JSON 对象') }
}
export function createExternalAccessHandler(assetRoot: string, options: ExternalHttpOptions = {}) {
  const lifetime = new AbortController()
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://external.invalid')
    if (!url.pathname.startsWith('/api/external-instances/v1/')) return false
    const match = /^\/api\/external-instances\/v1\/([a-z0-9-]+)\/(invoke|events|status)$/.exec(url.pathname)
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, lifetime.signal])
    res.once('close', () => abort.abort())
    const send = (status: number, value: unknown) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); if (!res.writableEnded) res.end(JSON.stringify(value)) }
    try {
      if (!match) throw new ExternalAccessError('not_found', '接入路由不存在', 404)
      const authenticate = () => options.authenticate ? options.authenticate(req, signal) : authenticateExternal(assetRoot, req, signal)
      const caller = await authenticate()
      if (match[2] === 'events' && req.method === 'GET') await streamExternal(assetRoot, caller, match[1], text(url.searchParams.get('sessionId'), '会话标识'), res, signal, authenticate)
      else if (match[2] === 'invoke' && req.method === 'POST') {
        const input = await body(req)
        if (Object.keys(input).some(key => !['operation', 'sessionId', 'input', 'requestId'].includes(key))) throw new ExternalAccessError('invalid_request', '调用不能替换登记目标、身份或上游请求头')
        const result = await invokeExternal(assetRoot, caller, { ...input, id: match[1] } as ExternalInvocation, signal)
        send(result.stage === 'accepted' ? 202 : result.stage === 'unknown' ? 502 : 200, result)
      } else if (match[2] === 'status' && req.method === 'GET') {
        const { assertExternalAccess } = await import('./access.ts')
        const { instance } = assertExternalAccess(assetRoot, match[1], caller, 'agent:access')
        send(200, { instanceId: instance.id, entryState: instance.entryState, verification: instance.verification, observedAt: new Date().toISOString(), usageMode: instance.usageMode })
      } else throw new ExternalAccessError('method_not_allowed', '此入口不支持该请求方法', 405)
    } catch (error) { send(error instanceof ExternalAccessError ? error.status : 503, { error: error instanceof ExternalAccessError ? error.code : 'dependency_failed', message: error instanceof ExternalAccessError ? error.message : '依赖暂不可用；未自动改为直连。' }) }
    return true
  }
  return Object.assign(handler, { close: () => lifetime.abort() })
}
