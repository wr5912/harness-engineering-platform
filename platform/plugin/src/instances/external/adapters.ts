import { randomUUID } from 'node:crypto'
import { ExternalAccessError, externalBindingDigest, externalConnectionUserId, externalEndpoint, object, upstreamHeaders } from './registry.ts'
import type { ExternalInstance, ExternalInvocation, ExternalInvocationResult, ExternalVerification } from './types.ts'

export const EXTERNAL_ADAPTER_VERSION = '1.0.0'
export function targetUrl(instance: ExternalInstance, path: string): URL {
  const base = externalEndpoint(instance.endpoint) + '/'
  // path 只由适配器生成；调用者不能替换 origin 或逃出登记 basePath。
  const url = new URL(path.replace(/^\//, ''), base)
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname)) throw new ExternalAccessError('invalid_target', '目标不属于登记范围')
  return url
}
export function snapshotExternalCredentials(root: string, instance: ExternalInstance): Record<string, string> {
  const headers = upstreamHeaders(root, instance)
  if (externalBindingDigest(root, instance, headers) !== instance.bindingDigest) throw new ExternalAccessError('credential_changed', '上游凭据材料已变化，请重新验证接入', 409)
  return headers
}
export function redactExternalValue(value: any, credentials: Record<string, string>): any {
  const secrets = Object.entries(credentials).filter(([name]) => name.toLowerCase() !== 'x-user-id').flatMap(([name, value]) => [value, value.replace(/^(?:Bearer|Basic)\s+/i, ''), ...(/^cookie$/i.test(name) ? value.split(';').map(item => item.trim().slice(item.indexOf('=') + 1)) : [])]).filter(value => value.length >= 8)
  const redacted = (item: any): any => typeof item === 'string' ? secrets.reduce((value, secret) => value.replaceAll(secret, '[已隐藏凭据]'), item)
    : Array.isArray(item) ? item.map(redacted) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, value]) => [key, redacted(value)])) : item
  return redacted(value)
}
export function adapterHeaders(root: string, instance: ExternalInstance, credentials = snapshotExternalCredentials(root, instance)): Record<string, string> {
  const headers = { ...credentials, 'content-type': 'application/json' }
  if (instance.framework === 'agentscope') {
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'x-user-id') delete (headers as Record<string, string>)[name]
    Object.assign(headers, { 'x-user-id': externalConnectionUserId(root, instance, credentials) })
  }
  if (instance.framework === 'opencode' && instance.selector) Object.assign(headers, { 'x-opencode-directory': instance.selector })
  return headers
}
export async function adapterFetch(root: string, instance: ExternalInstance, path: string, init: RequestInit, signal: AbortSignal, credentials?: Record<string, string>, beforeDispatch?: () => void): Promise<Response> {
  const url = targetUrl(instance, path), headers = adapterHeaders(root, instance, credentials)
  beforeDispatch?.()
  return fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) })
}
async function json(response: Response): Promise<any> {
  if (!response.ok) throw new ExternalAccessError('upstream_error', `上游接口返回 HTTP ${response.status}`, 502)
  const data = await response.text()
  if (data.length > 8 * 1024 * 1024) throw new ExternalAccessError('response_too_large', '上游结果过大，请在原系统查看', 502)
  try { return JSON.parse(data) } catch { throw new ExternalAccessError('invalid_upstream_response', '上游未返回有效 JSON', 502) }
}
async function dshRpc(root: string, instance: ExternalInstance, method: string, args: unknown, signal: AbortSignal, credentials?: Record<string, string>, beforeDispatch?: () => void) {
  const result = await json(await adapterFetch(root, instance, `api/${method}`, { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) }, signal, credentials, beforeDispatch))
  if (!result?.result?.ok) throw new ExternalAccessError('upstream_rpc_error', 'DSH 原生接口未确认成功', 502)
  return result.result.value
}
export async function probeExternal(root: string, instance: ExternalInstance, signal: AbortSignal): Promise<ExternalVerification> {
  const result: ExternalVerification = { ok: false, bindingDigest: instance.bindingDigest, adapterVersion: EXTERNAL_ADAPTER_VERSION, observedAt: new Date().toISOString(), checks: [] }
  try {
    if (instance.framework === 'dsh') {
      await dshRpc(root, instance, 'session/list', { _request: {} }, signal)
      let selector: any
      try { selector = JSON.parse(instance.selector ?? '{}') } catch { throw new ExternalAccessError('invalid_selector', 'DSH 目标选择器须包含 workspaceId 和 agentPreset') }
      if (typeof selector.workspaceId !== 'string' || !selector.workspaceId.trim() || typeof selector.agentPreset !== 'string' || !selector.agentPreset.trim()) throw new ExternalAccessError('invalid_selector', 'DSH 目标选择器须包含 workspaceId 和 agentPreset')
      const { discoverExternal } = await import('./discovery.ts')
      const targets = await discoverExternal(root, { framework: 'dsh', endpoint: instance.endpoint, credentialRef: instance.credentialRef }, signal)
      for (const [name, group, selected] of [['工作区', targets.workspaces, selector.workspaceId], ['Preset', targets.presets, selector.agentPreset]] as const) {
        if (group?.status === 'ready') {
          if (!group.items.some(row => row.id === selected && !row.unavailableReason)) throw new ExternalAccessError('target_mismatch', `所选 DSH ${name}不存在或不可用`)
          result.checks.push({ name: `target-${name}`, ok: true, detail: `原生发现已确认所选${name}` })
        } else if (group?.status === 'empty') throw new ExternalAccessError('target_mismatch', `原系统确认没有可见 DSH ${name}，所选目标不存在`)
        else if (group?.status === 'forbidden' || group?.status === 'unsupported') {
          result.checks.push({ name: `configured-target-${name}`, ok: true, detail: `连接已核对；受限入口无法列举${name}，目标采用管理员配置，实际新 Session 调用另行核对` })
        } else throw new ExternalAccessError('target_unverified', `当前连接无法核实 DSH ${name}；请修复连接或认证后重试，未将读取失败视为可用目标`)
      }
      result.checks.push({ name: 'native-api', ok: true, detail: 'DSH 原生 Session 接口可访问；业务结果仍需真实调用验证' })
    } else if (instance.framework === 'agentscope') {
      if (!instance.selector) throw new ExternalAccessError('invalid_selector', '请选择 AgentScope 的实际 agent_id')
      const schema = await json(await adapterFetch(root, instance, 'openapi.json', { method: 'GET' }, signal))
      if (!schema.paths?.['/chat/'] || !schema.paths?.['/sessions/{session_id}/stream']) throw new ExternalAccessError('unsupported_api', '目标未提供已适配的 AgentScope Service 接口')
      const targets = await json(await adapterFetch(root, instance, 'agent/', { method: 'GET' }, signal))
      if (!Array.isArray(targets.agents) || !targets.agents.some((target: any) => target.agent_id === instance.selector || target.id === instance.selector)) throw new ExternalAccessError('target_mismatch', '目标 Agent 与登记不一致或当前服务身份不可见')
      result.observedVersion = schema.info?.version
      result.checks.push({ name: 'native-api', ok: true, detail: 'AgentScope Service 的目标、消息和 Session 事件接口已识别' })
    } else {
      const health = await json(await adapterFetch(root, instance, 'api/info', { method: 'GET' }, signal))
      if (typeof health.version !== 'string' || !health.version.startsWith('2.') || !Number.isInteger(health.pid)) throw new ExternalAccessError('target_mismatch', '目标未确认为已适配的 OpenCode v2 Server')
      await json(await adapterFetch(root, instance, 'api/session', { method: 'GET' }, signal))
      result.observedVersion = health.version
      result.checks.push({ name: 'native-api', ok: true, detail: 'OpenCode 原生健康和 Session 接口已识别' })
    }
    result.checks.push({ name: 'scope', ok: true, detail: '共享使用；已适配 API 入口，不代表内部工具、任务取消或原生 Web 已受控' })
    result.ok = true
  } catch (error) {
    result.checks.push({ name: 'native-api', ok: false, detail: error instanceof ExternalAccessError ? error.message : '目标连接、认证或响应解析失败；未执行业务请求' })
  }
  return result
}
export async function invokeAdapter(root: string, instance: ExternalInstance, input: ExternalInvocation, upstreamSessionId: string | undefined, signal: AbortSignal, options: { beforeDispatch?: () => void; messageId?: string } = {}): Promise<ExternalInvocationResult> {
  const credentials = snapshotExternalCredentials(root, instance)
  const guard = options.beforeDispatch
  let value: any, accepted = false
  if (instance.framework === 'dsh') {
    if (input.operation === 'session:create') {
      const selector = object(JSON.parse(instance.selector ?? '{}'))
      value = await dshRpc(root, instance, 'session/create', { request: { workspaceId: selector.workspaceId, agentPreset: selector.agentPreset } }, signal, credentials, guard)
      upstreamSessionId = value.sessionId
    } else if (input.operation === 'session:prompt') {
      value = await dshRpc(root, instance, 'session/prompt', { request: { sessionId: upstreamSessionId, requestId: input.requestId, mode: 'queue', content: [{ type: 'text', text: input.input }] } }, signal, credentials, guard)
      accepted = value.accepted === true
    } else {
      const projection = await dshRpc(root, instance, 'session/projections', { request: { sessionId: upstreamSessionId } }, signal, credentials, guard)
      if (projection?.kind !== 'sequenced' || !Number.isSafeInteger(projection.asOfSeq)) throw new ExternalAccessError('upstream_state_unknown', 'DSH 当前会话游标不可确认，请在原生实例核对', 502)
      value = await dshRpc(root, instance, 'session/page', { request: { address: { kind: 'session', sessionId: upstreamSessionId }, throughSeq: projection.asOfSeq, maxMessages: options.messageId ? 200 : 50 } }, signal, credentials, guard)
      // 普通业务访问只呈现消息和工具结果，不把原生研究上下文、系统提示和请求快照作为答案返回。
      if (Array.isArray(value.records)) value = { ...value, records: value.records.filter((row: any) => row.type === 'event' && (
        row.event?.type === 'user/message' && row.event.data?.source?.kind === 'user'
        || ['assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end'].includes(row.event?.type))) }
    }
  } else if (instance.framework === 'agentscope') {
    if (input.operation === 'session:create') {
      value = await json(await adapterFetch(root, instance, 'sessions/', { method: 'POST', body: JSON.stringify({ agent_id: instance.selector }) }, signal, credentials, guard)); upstreamSessionId = value.session_id
    } else if (input.operation === 'session:prompt') {
      value = await json(await adapterFetch(root, instance, 'chat/', { method: 'POST', body: JSON.stringify({ agent_id: instance.selector, session_id: upstreamSessionId, input: { ...(options.messageId ? { id: options.messageId } : {}), name: 'user', role: 'user', content: [{ type: 'text', text: input.input }] } }) }, signal, credentials, guard)); accepted = value.status === 'started'
    } else value = await json(await adapterFetch(root, instance, `sessions/${encodeURIComponent(upstreamSessionId!)}/messages?agent_id=${encodeURIComponent(instance.selector!)}${options.messageId ? '&limit=200' : ''}`, { method: 'GET' }, signal, credentials, guard))
  } else {
    if (input.operation === 'session:create') {
      value = await json(await adapterFetch(root, instance, 'api/session', { method: 'POST', body: JSON.stringify(instance.selector ? { location: { directory: instance.selector } } : {}) }, signal, credentials, guard)); upstreamSessionId = value.data?.id
    } else if (input.operation === 'session:prompt') {
      value = await json(await adapterFetch(root, instance, `api/session/${encodeURIComponent(upstreamSessionId!)}/prompt`, { method: 'POST', body: JSON.stringify({ ...(options.messageId ? { id: options.messageId } : {}), text: input.input }) }, signal, credentials, guard))
      accepted = true
    } else value = await json(await adapterFetch(root, instance, `api/session/${encodeURIComponent(upstreamSessionId!)}/message${options.messageId ? '?limit=200' : ''}`, { method: 'GET' }, signal, credentials, guard))
  }
  if (input.operation === 'session:create' && (typeof upstreamSessionId !== 'string' || !upstreamSessionId)) throw new ExternalAccessError('invalid_upstream_response', '上游未返回有效 Session 标识', 502)
  return { requestId: input.requestId, stage: accepted ? 'accepted' : 'responded', value: redactExternalValue(value, credentials), upstreamSessionId,
    ...(accepted ? { note: '上游已受理；请读取会话或订阅事件确认执行结果。' } : {}) }
}
/** 只读本次回复所需的原生消息和等待事实，不改变原 Runtime 任务。 */
export async function readConversationSnapshot(root: string, instance: ExternalInstance, nativeId: string, requestId: string, messageId: string, signal: AbortSignal, beforeDispatch: () => void) {
  const response = await invokeAdapter(root, instance, { id: instance.id, operation: 'session:read', requestId }, nativeId, signal, { beforeDispatch, messageId })
  const credentials = snapshotExternalCredentials(root, instance), nativePath = encodeURIComponent(nativeId)
  const get = async (path: string) => json(await adapterFetch(root, instance, path, { method: 'GET' }, signal, credentials, beforeDispatch))
  if (instance.framework === 'agentscope') {
    const status = await get(`sessions/${nativePath}/status?agent_id=${encodeURIComponent(instance.selector!)}`)
    return { value: response.value, status: status.status }
  }
  if (instance.framework === 'opencode') {
    const active = await get('api/session/active'), permission = await get(`api/session/${nativePath}/permission`), form = await get(`api/session/${nativePath}/form`)
    return { value: response.value, running: active.data?.[nativeId]?.type === 'running', waiting: permission.data?.length > 0 || form.data?.length > 0 }
  }
  return { value: response.value }
}
export function eventPath(instance: ExternalInstance, nativeSessionId: string): string {
  if (instance.framework === 'agentscope') return `sessions/${encodeURIComponent(nativeSessionId)}/stream?agent_id=${encodeURIComponent(instance.selector!)}`
  // OpenCode 的全局事件流会泄漏其他会话，只经适配器过滤后发给调用者。
  if (instance.framework === 'opencode') return 'api/event'
  throw new ExternalAccessError('unsupported_operation', '此 DSH 适配器暂未开放原生事件流，请读取会话结果', 409)
}
