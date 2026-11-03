import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { runtimeRequire } from '../../../../../runtime/adapters/dsh-web/src/resolve-runtime.ts'
import { adapterHeaders, redactExternalValue, targetUrl } from './adapters.ts'
import { externalBindingDigest, externalConnectionUserId, externalEndpoint, ExternalAccessError, getExternalInstance, identifier, text, upstreamHeaders } from './registry.ts'
import type { ExternalDiscoveryChoices, ExternalDiscoveryRequest, ExternalDiscoveryResult, ExternalDiscoveryTarget, ExternalInstance } from './types.ts'

const limit = 8 * 1024 * 1024
function failure(status?: number, code?: string): ExternalDiscoveryChoices {
  if (status === 401) return { status: 'unauthorized', items: [], message: '原服务未接受连接身份，请选择有效连接凭据或联系原系统管理员。' }
  if (status === 403 || code === 'remote-access/denied') return { status: 'forbidden', items: [], message: '当前连接身份没有目标发现权限，请联系原系统管理员提供可发现的入口、连接身份或明确目标。' }
  if (status === 404 || code && /not-found|service-unavailable|signature-invalid/.test(code)) return { status: 'unsupported', items: [], message: '此入口未提供已适配的目标发现接口，请联系原系统管理员核对入口或提供明确目标。' }
  return { status: 'failed', items: [], message: '目标发现未完成，请核对服务地址、连接身份和服务状态后重试；未创建远端对象。' }
}
function choices(items: ExternalDiscoveryTarget[]): ExternalDiscoveryChoices {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('duplicate target')
  return items.length ? { status: 'ready', items } : { status: 'empty', items, message: '原服务确认当前身份没有可见目标，请联系原系统管理员。' }
}
const label = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
function target(id: unknown, name?: unknown): ExternalDiscoveryTarget {
  if (typeof id !== 'string' || !id.trim()) throw new Error('missing native identity')
  return { id, name: label(name) ?? id }
}
async function readJson(response: Response): Promise<any> {
  let size = 0, raw = ''
  if (!response.body) throw new Error('empty response')
  const decoder = new TextDecoder()
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > limit) throw new Error('response too large'); raw += decoder.decode(chunk, { stream: true }) }
  return JSON.parse(raw + decoder.decode())
}
async function httpChoices(instance: ExternalInstance, headers: Record<string, string>, path: string, signal: AbortSignal, parse: (value: any) => ExternalDiscoveryTarget[], method?: string): Promise<ExternalDiscoveryChoices> {
  try {
    const response = await fetch(targetUrl(instance, path), { method: method ? 'POST' : 'GET', headers,
      ...(method ? { body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: {} } }) } : {}), redirect: 'error', signal })
    if (!response.ok) { await response.body?.cancel(); return failure(response.status) }
    const value = await readJson(response)
    if (method && value?.result?.ok !== true) return failure(undefined, value?.result?.error?.code)
    return choices(parse(method ? value.result.value : value))
  } catch { return failure() }
}
/** 原生Workspace只有Remote流；只取首个baseline并取消，不调用有写入作用的initializeDefault。 */
async function workspaces(instance: ExternalInstance, headers: Record<string, string>, signal: AbortSignal): Promise<ExternalDiscoveryChoices> {
  const require = runtimeRequire('@deepseek-ai/dsh-api-gateway/package.json')
  const WebSocket = createRequire(require.resolve('@deepseek-ai/dsh-api-gateway/package.json'))('ws')
  const url = targetUrl(instance, 'api/remote.mux'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new Promise(resolve => {
    const socket = new WebSocket(url, { headers, maxPayload: limit, followRedirects: false }), streamId = randomUUID()
    let settled = false
    const finish = (result: ExternalDiscoveryChoices) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', aborted)
      if (socket.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.close() }
      else socket.terminate()
      resolve(result)
    }
    const aborted = () => finish(failure())
    signal.addEventListener('abort', aborted, { once: true })
    socket.on('open', () => { if (signal.aborted) return aborted(); socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'workspace/follow', payload: { args: {} } })) })
    socket.on('unexpected-response', (_req: unknown, res: { statusCode?: number; resume(): void }) => { res.resume(); finish(failure(res.statusCode)) })
    socket.on('error', () => finish(failure()))
    socket.on('close', () => finish(failure()))
    socket.on('message', (raw: Buffer) => {
      try {
        const frame = JSON.parse(raw.toString('utf8'))
        if (frame.streamId !== streamId) return
        if (frame.type === 'error') return finish(failure(undefined, frame.error?.code))
        if (frame.type !== 'item' || frame.value?.type !== 'baseline' || !Array.isArray(frame.value.value?.items)) throw new Error('invalid baseline')
        finish(choices(frame.value.value.items.map((row: any) => ({ ...target(row.workspaceId, row.title), ...(label(row.path) ? { path: row.path } : {}) }))))
      } catch { finish(failure()) }
    })
    if (signal.aborted) aborted()
  })
}

export async function discoverExternal(root: string, input: ExternalDiscoveryRequest, signal: AbortSignal): Promise<ExternalDiscoveryResult> {
  if (!['dsh', 'agentscope', 'opencode'].includes(input.framework)) throw new ExternalAccessError('invalid_request', '请选择支持的原框架')
  const endpoint = externalEndpoint(input.endpoint), credentialRef = text(input.credentialRef, '凭据引用', true)
  if (credentialRef) identifier(credentialRef, '凭据引用')
  const connection = { framework: input.framework, endpoint, ...(credentialRef ? { credentialRef } : {}), ...(input.connectionUserId ? { connectionUserId: text(input.connectionUserId, '原系统用户标识') } : {}) }
  const material = upstreamHeaders(root, connection as ExternalInstance)
  const existing = input.id ? getExternalInstance(root, identifier(input.id, '实例标识')) : undefined
  if (input.id && (!existing || existing.state === 'removed')) throw new ExternalAccessError('not_found', '接入实例不存在或已移除', 404)
  // 只沿用同一已登记连接的旧上下文，不将派生值物化为新配置而使旧会话失效。
  const inherited = input.framework === 'agentscope' && existing?.framework === 'agentscope'
    && existing.endpoint === endpoint && (existing.credentialRef ?? '') === credentialRef && !existing.connectionUserId
    && !connection.connectionUserId && !Object.keys(material).some(name => name.toLowerCase() === 'x-user-id')
  if (input.framework === 'agentscope') connection.connectionUserId = externalConnectionUserId(root, inherited ? existing! : connection, material)
  const instance = { ...connection, bindingDigest: externalBindingDigest(root, connection, material) } as ExternalInstance
  const headers = { ...adapterHeaders(root, instance, material), origin: new URL(endpoint).origin }
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(10000)])
  const result: ExternalDiscoveryResult = { framework: input.framework, endpoint, observedAt: new Date().toISOString(), status: 'unavailable', ...(!inherited && connection.connectionUserId ? { connectionUserId: connection.connectionUserId } : {}) }
  try {
    if (input.framework === 'dsh') {
      const groups = await Promise.allSettled([workspaces(instance, headers, lifetime), httpChoices(instance, headers, 'api/agentPresets/list', lifetime, value => {
        if (!Array.isArray(value?.presets)) throw new Error('invalid roster')
        return value.presets.map((row: any) => ({ ...target(row.id, row.name), ...(label(row.description) ? { description: row.description } : {}), ...(typeof row.isDefault === 'boolean' ? { isDefault: row.isDefault } : {}), ...(label(row.broken) ? { unavailableReason: row.broken } : {}) }))
      }, 'agentPresets/list')])
      result.workspaces = groups[0].status === 'fulfilled' ? groups[0].value : failure()
      result.presets = groups[1].status === 'fulfilled' ? groups[1].value : failure()
      const presets = result.presets.items.filter(row => !row.unavailableReason)
      if (result.workspaces.status === 'ready' && result.presets.status === 'ready' && presets.length) {
        result.status = 'selection_required'
        const workspace = result.workspaces.items.length === 1 ? result.workspaces.items[0] : undefined, preset = presets.length === 1 ? presets[0] : undefined
        if (workspace || preset) result.selector = JSON.stringify({ ...(workspace ? { workspaceId: workspace.id } : {}), ...(preset ? { agentPreset: preset.id } : {}) })
        if (workspace && preset) result.status = 'selected'
      }
    } else if (input.framework === 'agentscope') {
      result.agents = await httpChoices(instance, headers, 'agent/', lifetime, value => {
        if (!Array.isArray(value?.agents)) throw new Error('invalid agents')
        return value.agents.map((row: any) => target(row.id ?? row.agent_id, row.data?.name ?? row.name))
      })
      if (result.agents.status === 'ready') { result.status = result.agents.items.length === 1 ? 'selected' : 'selection_required'; if (result.status === 'selected') result.selector = result.agents.items[0].id }
    } else {
      for (const path of ['api/info', 'api/session']) {
        const response = await fetch(targetUrl(instance, path), { headers, redirect: 'error', signal: lifetime })
        if (!response.ok) { await response.body?.cancel(); result.message = failure(response.status).message; return result }
        const value = await readJson(response)
        if (path === 'api/info' && (typeof value?.version !== 'string' || !value.version.startsWith('2.') || !Number.isInteger(value.pid))) { result.message = '目标未确认为已适配的 OpenCode v2 Server，请核对原服务入口。'; return result }
      }
      result.status = 'selected'
    }
  } catch { signal.throwIfAborted(); result.message = failure().message }
  signal.throwIfAborted()
  if (externalBindingDigest(root, instance) !== instance.bindingDigest) throw new ExternalAccessError('credential_changed', '连接凭据在发现期间已变化，请重新探测', 409)
  return redactExternalValue(result, material)
}
