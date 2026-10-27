import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { sharedInstanceIdentity, getBusinessControl } from './core.ts'
import { resolveBusinessInstance, type BusinessGatewayInstance, type RegisteredBusinessInstance } from './instance.ts'
export { resolveBusinessInstance } from './instance.ts'
export type { BusinessGatewayInstance, RegisteredBusinessInstance } from './instance.ts'
import type { BusinessContext, ControlSnapshot, InstanceBinding, ReplicaObservation, AuthenticatedIdentity, AgentAccessRule, RiskFact, Restriction, AgentInstanceStatus, OperationRule } from './contracts.ts'

const CONTEXT_HEADER = 'x-harness-business-context'
const SIGNATURE_HEADER = 'x-harness-business-signature'
const SIGNATURE_TTL_MS = 2_000
export interface BusinessGatewayConfig {
  host: string; port: number; publicOrigin: string; sharedSecretFile: string
  proxyOrigin?: string
  instances: BusinessGatewayInstance[]; managementUrl?: string
}
export interface RuntimeAssertion { context?: BusinessContext; binding: InstanceBinding; snapshot?: ControlSnapshot; observation?: ReplicaObservation; requestDigest?: string; issuedAt: number; nonce: string }

export function readBusinessSecret(path: string): Buffer {
  const value = readFileSync(path)
  if (value.length < 32) throw new Error('业务接入共享密钥必须至少为 32 字节')
  return value
}

/** 只固定 RPC 方法与参数，排除每次传输生成的 JSON-RPC ID。 */
export function businessRpcDigest(value: { method?: unknown; params?: unknown }): string {
  if (!value || typeof value.method !== 'string' || !value.method) throw new Error('业务 MCP 请求体无效')
  const payload = { method: value.method, ...(value.params === undefined ? {} : { params: value.params }) }
  const canonical = JSON.stringify(payload, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  return createHash('sha256').update(canonical).digest('hex')
}

/** 绑定实际接收实例、HTTP 方法和路径；不把入站用户 Header 当作身份。 */
export function signBusinessAssertion(secret: Buffer, assertion: RuntimeAssertion, method: string, path: string): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify(assertion)).toString('base64url')
  return { [CONTEXT_HEADER]: encoded, [SIGNATURE_HEADER]: createHmac('sha256', secret).update(`${method}\n${path}\n${encoded}`).digest('base64url') }
}
export function verifyBusinessAssertion(secret: Buffer, headers: IncomingMessage['headers'], method: string, path: string, binding: InstanceBinding, nonces: Map<string, number>, now = Date.now()): RuntimeAssertion {
  const encoded = headers[CONTEXT_HEADER]; const signature = headers[SIGNATURE_HEADER]
  if (typeof encoded !== 'string' || encoded.length > 256_000 || typeof signature !== 'string') throw new Error('缺少受信业务上下文')
  const expected = createHmac('sha256', secret).update(`${method}\n${path}\n${encoded}`).digest()
  const supplied = Buffer.from(signature, 'base64url')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('业务上下文签名无效')
  const assertion = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as RuntimeAssertion
  if (!Number.isSafeInteger(assertion.issuedAt) || Math.abs(now - assertion.issuedAt) > SIGNATURE_TTL_MS || typeof assertion.nonce !== 'string' || assertion.nonce.length < 16) throw new Error('业务上下文已失效')
  if (!assertion.binding || Object.entries(binding).some(([key, value]) => assertion.binding[key as keyof InstanceBinding] !== value)) throw new Error('业务上下文接收实例不匹配')
  for (const [nonce, expiry] of nonces) if (expiry < now) nonces.delete(nonce)
  if (nonces.has(assertion.nonce)) throw new Error('业务上下文已使用')
  nonces.set(assertion.nonce, now + SIGNATURE_TTL_MS)
  return assertion
}

function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
export function businessRequestHeaders(req: IncomingMessage): Record<string, string | undefined> {
  return { authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined }
}
function rejectSocket(socket: Duplex, status = 401): void { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
/** 业务智能体请求默认全部转发；实例内的业务 Runtime 继续做身份、来源与动作校验。 */
export function allowedBusinessPath(path: string, method: string, transport: 'http' | 'websocket'): boolean {
  void path; void method; void transport
  return true
}
async function readSignedControlRequest(req: IncomingMessage): Promise<IncomingMessage['headers']> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('控制续租必须使用签名JSON信封')
  const chunks: Buffer[] = []; let length = 0
  for await (const raw of req) { const bytes = Buffer.from(raw); length += bytes.length; if (length > 512 * 1024) throw new Error('控制观察超过允许大小'); chunks.push(bytes) }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('控制续租信封无效')
  return value
}
function escapeHtml(value: unknown): string { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }
function renderBusinessGatewayHome(input: { identity?: AuthenticatedIdentity; availableAgents: { agentId: string }[]; anonymousInstances?: BusinessGatewayInstance[]; unavailableCount?: number; rules: AgentAccessRule[]; facts: RiskFact[]; restrictions: Restriction[]; authenticationMessage: string; managementUrl?: string; riskProvider: boolean; agentStatuses: { agentId: string; instanceId: string; pinnedSourceDigest?: string; status: AgentInstanceStatus }[]; operations: readonly OperationRule[] }): string {
  const { identity, availableAgents, rules, facts, restrictions } = input
  const pair = (label: string, value: unknown) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
  const scoped = (scope: { instanceId?: string; sessionId?: string; serverId?: string }) => [scope.instanceId && `实例 ${scope.instanceId}`, scope.sessionId && `会话 ${scope.sessionId}`, scope.serverId && `服务 ${scope.serverId}`].filter(Boolean).join('；') || 'Agent 范围（适用于全部实例）'
  const riskRows = rules.flatMap(rule => input.agentStatuses.filter(item => item.agentId === rule.agentId).map(instance => {
    const own = facts.filter(fact => fact.scope.agentId === rule.agentId && (!fact.scope.instanceId || fact.scope.instanceId === instance.instanceId))
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)), latest = own[0]
    const limits = restrictions.filter(item => item.active && item.scope.agentId === rule.agentId
      && (!item.scope.instanceId || item.scope.instanceId === instance.instanceId))
    const status = !latest ? '待业务事件触发评估' : latest.status === 'unknown' ? '评估结果未知'
      : Date.parse(latest.expiresAt) <= Date.now() ? '最近事实已过期，受保护动作需要重新评估'
      : limits.length ? '当前存在访问限制'
      : latest.signals.some(signal => signal.code.startsWith('deny-')) ? (latest.contentDigest ? '最近一条内容检测拒绝；新内容会重新检查' : '最近一条风险事实含访问限制') : '最近一条评估完成；后续动作按当前实例检查'
    return `<section class="agent-risk"><h3>${escapeHtml(rule.agentId)} · 实例 ${escapeHtml(instance.instanceId)}</h3><p>${escapeHtml(status)}</p>${latest ? `<dl>${pair('最近自动评估', latest.observedAt)}${pair('有效至', latest.expiresAt)}${pair('范围', scoped(latest.scope))}${pair('评估来源', latest.source)}</dl>` : ''}${own.length ? `<ul>${own.map(fact => `<li>${escapeHtml(scoped(fact.scope))}：${fact.signals.length ? fact.signals.map(signal => `${escapeHtml(signal.code)}=${escapeHtml(signal.value)}（${escapeHtml(signal.reason)}）`).join('；') : '此范围最近一次评估没有新增限制'}${fact.status === 'unknown' ? '（未知）' : Date.parse(fact.expiresAt) <= Date.now() ? '（已过期）' : ''}</li>`).join('')}</ul>` : ''}${limits.length ? `<ul>${limits.map(limit => `<li>当前限制 ${escapeHtml(scoped(limit.scope))}：${escapeHtml(limit.deniedActions.join('、'))}；${escapeHtml(limit.reason)}</li>`).join('')}</ul>` : ''}</section>`
  })).join('')
  let management = ''
  if (identity && input.managementUrl) {
    const url = new URL(input.managementUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('现有平台管理入口配置无效')
    management = `<a href="${escapeHtml(url.href)}" rel="noopener noreferrer">打开现有平台管理入口</a>（仍需平台管理登录）`
  }
  const authText: Record<string, string> = { verified: '已验证', unknown: '尚未收到有效实例签名', expired: '实例认证已过期', disabled: 'Agent认证已关闭，禁止业务执行', not_required: '开发调试，不验证发布身份' }
  const trustText: Record<string, string> = { trusted: '身份条件已满足', unknown: '待核验', revoked: '身份已撤销', mismatch: '来源或实例代次不匹配', expired: '身份依据已过期' }
  const auth = identity ? (input.agentStatuses.length ? input.agentStatuses.map(item => item.status.authentication.status === 'not_required'
    ? `<section><h3>${escapeHtml(item.agentId)}</h3><dl>${pair('实例', item.instanceId)}${pair('模式', authText.not_required)}${pair('接入说明', '网关与 Runtime 仍使用签名通道，发布身份尚未验证')}</dl></section>`
    : `<section><h3>${escapeHtml(item.agentId)}</h3><dl>${pair('实例', item.instanceId)}${pair('Agent认证方式', item.status.authentication.method)}${pair('认证状态', authText[item.status.authentication.status] || item.status.authentication.status)}${pair('真实证据', item.status.authentication.evidence || '尚无有效实例签名')}${pair('最近实例签名', item.status.authentication.verifiedAt || '尚无有效签名')}${pair('认证有效至', item.status.authentication.expiresAt || '未知')}</dl></section>`).join('') : '<p>当前没有获准的业务 Agent 实例。</p>') : '<p>登录后展示获准业务 Agent 的实例认证方式和真实签名验证状态。</p>'
  const trust = identity ? (input.agentStatuses.length ? input.agentStatuses.map(item => `<section><h3>${escapeHtml(item.agentId)}</h3><dl>${pair('实例', item.instanceId)}${pair('可信来源核验状态', trustText[item.status.trust.status] || item.status.trust.status)}${pair('判断依据', item.status.trust.reason)}${pair('实际来源摘要', item.status.trust.sourceDigest || '未知')}${pair('已固定来源摘要', item.pinnedSourceDigest || '尚未固定')}${pair('实例代次', item.status.trust.runtimeGeneration || '未知')}${pair('限制版本', item.status.trust.restrictionVersion)}</dl></section>`).join('') : '<p>当前没有可核验的业务 Agent 实例。</p>') : '<p>核对业务智能体的固定来源、实例代次和有效签名；身份条件不满足时直接拒绝，不折算为业务风险分数。</p>'
  const targetLabel = (target: string) => { try { const url = new URL(target); return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?…' : ''}` } catch { return target } }
  const authorization = identity ? (rules.length ? rules.map(rule => {
    const operations = input.operations.filter(operation => (!rule.serverIds || rule.serverIds.includes(operation.serverId)) && (rule.actions.includes('*') || rule.actions.includes(operation.kind)))
    return `<section><h3>${escapeHtml(rule.agentId)}</h3><dl>${pair('Agent基础动作', rule.actions.join('、'))}${pair('服务范围', rule.serverIds?.join('、') || '按已登记操作的实际目标执行')}</dl>${operations.length ? `<ul>${operations.map(operation => `<li>${escapeHtml(operation.serverId)} / ${escapeHtml(operation.operationId)}：${escapeHtml(operation.kind)} · ${escapeHtml(operation.method)} ${escapeHtml(targetLabel(operation.target))}</li>`).join('')}</ul>` : '<p>当前没有已登记且匹配基础授权的工具或资源操作。</p>'}<p>以上是配置的能力范围；实际执行会综合智能体身份、当前风险、运行许可和业务归属作出访问决定。</p></section>`
  }).join('') : input.agentStatuses.some(item => item.status.authentication.status === 'not_required') ? '<p>未发布实例经统一网关全部放行，不做风险评估；无需认证时所有访问者共享实例的数据和会话。</p>' : '<p>当前没有获准的业务 Agent。</p>') : '<p>登录后展示本人可见业务 Agent 的动作、工具和资源范围。</p>'
  const visitor = identity ? `<p class="visitor">当前访问者：${escapeHtml(identity.subject.id)}；会话有效至 ${escapeHtml(identity.expiresAt)}。个人登录用于区分业务上下文，不代替智能体的凭据、可信来源与实例绑定核验。</p>` : input.anonymousInstances?.length ? '<p>无需登录的实例可直接打开；其他业务实例使用个人凭据登录。无需登录的访问者共享同一实例的历史和工作区数据。</p>' : '<p>先使用个人凭据登录；登录身份用于会话隔离，智能体身份、风险评估与访问控制的对象是业务 Agent。</p>'
  const publicLinks = (input.anonymousInstances ?? []).map(item => `<p><a href="/agents/${escapeHtml(item.agentId)}/instances/${escapeHtml(item.instanceId)}/">${escapeHtml(item.agentId)} · ${escapeHtml(item.instanceId)}</a>（无需登录；共享此实例的历史和数据）</p>`).join('')
  const directory = identity ? `<h2>我的业务智能体</h2>${availableAgents.length ? availableAgents.map(item => `<p><a href="/agents/${escapeHtml(item.agentId)}/">${escapeHtml(item.agentId)}</a></p>`).join('') : '<p>当前没有可以进入的已认证业务智能体。</p>'}${publicLinks}${input.unavailableCount ? `<p role="status">${input.unavailableCount} 个已登记实例无法核对，请在平台实例管理检查来源与状态。</p>` : ''}` : publicLinks ? `<h2>无需登录的业务智能体</h2>${publicLinks}` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>统一网关</title><style>body{max-width:1000px;margin:5vh auto;padding:24px;font:16px/1.6 system-ui;background:Canvas;color:CanvasText}h1,h2,h3{line-height:1.3}.notice{padding:14px 18px;border:1px solid #b58b31;border-radius:8px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:24px}.card{padding:20px;border:1px solid #8886;border-radius:10px;min-width:0}.card h2{margin-top:0;font-size:20px}dt{font-weight:600}dd{margin:0 0 10px;overflow-wrap:anywhere}li{overflow-wrap:anywhere}.agent-risk{border-top:1px solid #8884;margin-top:16px}input,button{font:inherit;padding:7px 10px;margin:4px}input{max-width:65%}a{color:LinkText}@media(max-width:900px){.cards{grid-template-columns:1fr}body{padding:16px;margin:1vh auto}}</style></head><body><h1>统一网关</h1><p>所有实例经网关核对来源与接入通道；发布实例另需通过智能体身份签名和访问规则。</p>${visitor}<p class="notice"><strong>原生定时任务已开放。</strong>定时任务尚未纳入检测、防护闭环；到期投递不代表巡检或报表已经执行，需核对实际任务回执。</p><form id="login"><label>${identity ? '更换个人凭据' : '个人访问凭据'} <input id="credential" type="password" autocomplete="off" required></label><button>登录</button></form><p id="message" role="status">${escapeHtml(input.authenticationMessage)}</p>${identity ? '<button id="logout">退出</button>' : ''}${directory}<div class="cards"><section class="card"><h2>智能体身份</h2><h3>认证方式与凭据</h3>${auth}<h3>可信来源与身份状态</h3>${trust}</section><section class="card"><h2>风险评估</h2><p>业务输入、工具执行、报告发布和下载会自动触发评估，并联动访问限制；手动重评仅用于辅助复核。</p><p>${input.riskProvider ? '已配置风险提供方；以下展示当前业务上下文内 Agent 的真实评估记录。' : '尚未接入外部风险提供方；已配置的本地检测规则仍在执行边界运行。'}</p>${identity ? riskRows || '<p>当前没有可核验的实例风险状态。</p>' : '<p>登录后展示本人可见业务 Agent 的自动评估状态、时间、依据和限制。</p>'}</section><section class="card"><h2>访问控制</h2>${authorization}</section></div><p>${management || '功能配置请在平台“统一网关”管理页完成。'}业务入口不提供管理配置写入。</p><script>const output=document.getElementById('message');document.getElementById('login').onsubmit=async e=>{e.preventDefault();const field=document.getElementById('credential');const value=field.value;field.value='';const response=await fetch('/session',{method:'POST',headers:{authorization:'Bearer '+value}});if(response.ok)location.reload();else output.textContent='凭据无效或身份服务不可用。'};const logout=document.getElementById('logout');if(logout)logout.onclick=async()=>{await fetch('/session',{method:'DELETE'});location.reload()};</script></body></html>`
}
function renderInstanceChoice(agentId: string, instances: BusinessGatewayInstance[], unavailableCount = 0): string {
  const links = instances.map(value => `<li><a href="/agents/${escapeHtml(agentId)}/instances/${escapeHtml(value.instanceId)}/">${escapeHtml(value.instanceId)}</a>${value.sourceId ? ` · ${escapeHtml(value.sourceId)}` : ''}</li>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>选择业务实例</title><style>body{max-width:720px;margin:5vh auto;padding:24px;font:16px/1.6 system-ui;background:Canvas;color:CanvasText}li{padding:8px 0;overflow-wrap:anywhere}a{color:LinkText}</style></head><body><h1>${escapeHtml(agentId)}</h1><p>请选择要进入的业务实例。不同版本的历史会话分别保存在各自实例中。</p>${links ? `<ul>${links}</ul>` : '<p>当前没有可进入的实例。</p>'}${unavailableCount ? `<p role="status">${unavailableCount} 个已登记实例无法核对，请在平台实例管理检查来源与状态。</p>` : ''}<p><a href="/">返回统一网关</a></p></body></html>`
}
export interface BusinessGatewayHandle { server: Server; origin: string; close(): Promise<void> }

/** 独立监听只代理已登记 Agent；httpxy 承担 HTTP/WS 协议转发。 */
export async function startBusinessGateway(assetRoot: string, config: BusinessGatewayConfig): Promise<BusinessGatewayHandle> {
  if (config.instances.some(item => !/^[a-z][a-z0-9-]*$/.test(item.agentId) || !/^[a-z][a-z0-9-]*$/.test(item.instanceId)
    || item.accessMode !== undefined && !['authenticated', 'anonymous'].includes(item.accessMode))) throw new Error('业务 Agent、实例名称或访问方式无效')
  const control = getBusinessControl(assetRoot)
  if (!control.enabled()) throw new Error('业务控制尚未启用')
  const secret = readBusinessSecret(config.sharedSecretFile)
  const origin = new URL(config.publicOrigin)
  const proxyOrigin = config.proxyOrigin ? new URL(config.proxyOrigin) : undefined
  for (const value of [origin, proxyOrigin]) if (value && (!['http:', 'https:'].includes(value.protocol) || value.pathname !== '/' || value.search || value.hash || value.username || value.password)) throw new Error('业务公开来源必须是独立 origin')
  const currentInstances = (): BusinessGatewayInstance[] => {
    const access = control.config(), current = access.gateway as Partial<BusinessGatewayConfig> | undefined
    if (!access.enabled) throw new Error('业务网关已关闭')
    if (!current) throw new Error('业务网关登记已移除')
    if (current.publicOrigin !== config.publicOrigin || current.proxyOrigin !== config.proxyOrigin || current.sharedSecretFile !== config.sharedSecretFile
      || current.host !== config.host || current.port !== config.port || !Array.isArray(current.instances)) {
      throw new Error('业务网关监听配置已变化，请重新启动平台后访问')
    }
    if (current.instances.some(item => !item || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.agentId)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.instanceId)
      || item.accessMode !== undefined && !['authenticated', 'anonymous'].includes(item.accessMode)
      || item.identityMode !== undefined && !['development', 'published'].includes(item.identityMode)
      || item.sourceId !== undefined && (typeof item.sourceId !== 'string' || !item.sourceId.startsWith('experiment:'))
      || item.sourceDigest !== undefined && (typeof item.sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.sourceDigest)))) {
      throw new Error('业务实例网关登记无效')
    }
    return current.instances
  }
  const currentManagementUrl = (): string | undefined => {
    const value = control.config().gateway?.managementUrl
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new Error('现有平台管理入口配置无效')
    return value
  }
  const { createProxyServer } = await import('httpxy')
  const proxy = createProxyServer({ xfwd: false, ws: true })
  const sessions = new Map<string, { headers: Record<string, string | undefined>; expiresAt: number }>()
  const connections = new Set<Duplex>()
  const browserConnections = new Map<string, Set<Duplex>>()
  const cookieValue = (req: IncomingMessage, name: string) => req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
  const browserSessionId = (req: IncomingMessage) => cookieValue(req, 'harness-business')
  const lifetime = new AbortController()
  const headerForIdentity = (req: IncomingMessage): Record<string, string | undefined> => {
    if (req.headers.authorization) return businessRequestHeaders(req)
    const key = browserSessionId(req)
    const session = key ? sessions.get(key) : undefined
    if (!session || session.expiresAt <= Date.now()) return {}
    return session.headers
  }
  const requestOrigin = (req: IncomingMessage): URL | undefined => {
    // 门户转发 Host 时可能去掉端口；只接受已配置的代理来源及其协议。
    const expected = proxyOrigin && [proxyOrigin.host, proxyOrigin.hostname].includes(req.headers.host || '')
      && req.headers['x-forwarded-proto'] === proxyOrigin.protocol.slice(0, -1) ? proxyOrigin : origin
    if (req.headers.host !== expected.host && !(expected === proxyOrigin && req.headers.host === expected.hostname)) return undefined
    if (req.headers.origin && req.headers.origin !== expected.origin) return undefined
    return expected
  }
  const assertOrigin = (req: IncomingMessage): URL => {
    const expected = requestOrigin(req)
    if (!expected) throw new Error('业务请求来源无效')
    return expected
  }
  const admit = async (req: IncomingMessage, transport: 'http' | 'websocket') => {
    assertOrigin(req)
    const identity = await control.authenticate({ transport, method: req.method || 'GET', path: req.url || '/', headers: headerForIdentity(req) }, lifetime.signal)
    return identity
  }
  const assertionFor = (instance: RegisteredBusinessInstance, context?: BusinessContext): RuntimeAssertion => ({ binding: instance.binding, context, snapshot: control.issueSnapshot(instance.binding.instanceId), issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') })
  const prepare = async (req: IncomingMessage, transport: 'http' | 'websocket', res?: ServerResponse) => {
    const externalOrigin = assertOrigin(req)
    const url = new URL(req.url || '/', origin)
    const match = /^\/agents\/([a-z0-9-]+)\/instances\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname)
    if (!match) throw new Error('请选择已开放业务实例')
    const selected = currentInstances().find(instance => instance.agentId === match[1] && instance.instanceId === match[2])
    if (!selected) throw new Error('业务实例未开放')
    const instance = resolveBusinessInstance(assetRoot, selected)
    const route = match[3] || '/'
    if (!allowedBusinessPath(route, req.method || 'GET', transport)) throw new Error('业务路径未开放')
    const identity = selected.accessMode === 'anonymous' ? sharedInstanceIdentity(instance.binding) : await admit(req, transport)
    control.registerInstance(instance.binding)
    const context = control.createContext(identity, instance.binding)
    control.assert(context, 'agent:access', [{ kind: 'agent', id: selected.agentId }])
    const path = instance.basePath + route + url.search
    // 代理丢弃调用方凭据与伪造控制 Header，只有此边界签名进入 Runtime。
    for (const name of Object.keys(req.headers)) if (name.startsWith('x-harness-') || ['authorization', 'cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].includes(name)) delete req.headers[name]
    // 受信网关重建公开来源；Runtime 内插件按 X-Forwarded-Host 识别反代，不能继承调用方值。
    req.headers['x-forwarded-host'] = externalOrigin.host
    req.headers['x-forwarded-proto'] = externalOrigin.protocol.replace(':', '')
    req.url = path
    Object.assign(req.headers, signBusinessAssertion(secret, assertionFor(instance, context), req.method || 'GET', path))
    req.headers.host = new URL(instance.origin).host
    return instance
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/' && req.method === 'GET') {
        assertOrigin(req)
        const instances = currentInstances()
        let availableAgents: { agentId: string; instanceId: string }[] = []
        const anonymousInstances: BusinessGatewayInstance[] = []
        const resolvedInstances: BusinessGatewayInstance[] = []
        let unavailableCount = 0, pageStatus = 200, authenticationMessage = ''
        let identity: Awaited<ReturnType<typeof control.authenticate>> | undefined
        if (req.headers.authorization || browserSessionId(req)) {
          try { identity = await admit(req, 'http') } catch (error) { pageStatus = (error as { httpStatus?: number }).httpStatus || 403; authenticationMessage = '当前身份不可用，请重新登录。' }
        }
        for (const selected of instances) {
          if (selected.accessMode === 'anonymous') {
            try {
              const instance = resolveBusinessInstance(assetRoot, selected)
              control.registerInstance(instance.binding)
              const rule = control.config().agents.find(item => item.agentId === selected.agentId)
              if ((selected.identityMode === 'development' || rule?.enabled && (rule.actions.includes('*') || rule.actions.includes('agent:access')))
                && control.agentStatus(instance.binding.instanceId).trust.status === 'trusted') anonymousInstances.push(selected)
            } catch { unavailableCount++ }
            continue
          }
          if (identity) {
            const rule = control.config().agents.find(item => item.agentId === selected.agentId)
            if (selected.identityMode !== 'development' && (!rule?.enabled || !rule.subjects.includes(identity.subject.id)
              || !rule.actions.includes('*') && !rule.actions.includes('agent:access'))) continue
            let instance: RegisteredBusinessInstance
            try { instance = resolveBusinessInstance(assetRoot, selected) }
            catch { unavailableCount++; continue }
            resolvedInstances.push(selected)
            try {
              control.registerInstance(instance.binding)
              if (control.agentStatus(instance.binding.instanceId).trust.status !== 'trusted') continue
              const context = control.createContext(identity, instance.binding)
              control.assert(context, 'agent:access', [{ kind: 'agent', id: selected.agentId }])
              availableAgents.push(selected)
            } catch { /* 无法确认的实例不进入当前身份目录。 */ }
          }
        }
        res.writeHead(pageStatus, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        const rules = identity ? control.config().agents.filter(rule => rule.enabled && rule.subjects.includes(identity.subject.id)) : []
        const status = control.status()
        const visible = (scope: { agentId: string; subjectId?: string }) => !!identity && rules.some(rule => rule.agentId === scope.agentId) && (scope.subjectId === undefined || scope.subjectId === identity.subject.id)
        const agentStatuses = identity ? resolvedInstances.map(item => ({ ...item,
          pinnedSourceDigest: item.sourceDigest ?? rules.find(rule => rule.agentId === item.agentId)?.sourceDigest,
          status: control.agentStatus(item.instanceId) })) : []
        res.end(renderBusinessGatewayHome({ identity, availableAgents: [...new Map(availableAgents.map(item => [item.agentId, item])).values()], anonymousInstances, unavailableCount, rules, facts: identity ? status.riskFacts.filter(fact => fact.scope.subjectId === identity.subject.id && visible(fact.scope)) : [], restrictions: identity ? status.restrictions.filter(item => visible(item.scope)) : [], authenticationMessage, managementUrl: currentManagementUrl(), riskProvider: !!control.config().riskAssessment, agentStatuses, operations: control.config().operations || [] }))
        return
      }
      if (req.url === '/session' && req.method === 'POST') {
        const identity = await admit(req, 'http')
        const bearer = businessRequestHeaders(req)
        if (!bearer.authorization) return json(res, 401, { error: '个人凭据缺失' })
        const previousId = browserSessionId(req)
        if (previousId) { sessions.delete(previousId); for (const socket of browserConnections.get(previousId) || []) socket.destroy(); browserConnections.delete(previousId) }
        const id = randomBytes(32).toString('base64url')
        sessions.set(id, { headers: bearer, expiresAt: Date.parse(identity.expiresAt) })
        res.setHeader('set-cookie', `harness-business=${id}; HttpOnly; SameSite=Strict; Path=/${assertOrigin(req).protocol === 'https:' ? '; Secure' : ''}`)
        return json(res, 200, { subject: identity.subject, expiresAt: identity.expiresAt })
      }
      if (req.url === '/session' && req.method === 'DELETE') {
        assertOrigin(req)
        const key = browserSessionId(req)
        if (key) { sessions.delete(key); for (const socket of browserConnections.get(key) || []) socket.destroy(); browserConnections.delete(key) }
        res.setHeader('set-cookie', 'harness-business=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        return json(res, 200, { ended: true })
      }
      const legacy = /^\/agents\/([a-z0-9-]+)\/$/.exec(req.url || '')
      if (legacy && req.method === 'GET') {
        assertOrigin(req)
        const candidates = currentInstances().filter(item => item.agentId === legacy[1])
        let identity: AuthenticatedIdentity | undefined
        if (req.headers.authorization || browserSessionId(req)) {
          try { identity = await admit(req, 'http') }
          catch (error) { if (!candidates.some(item => item.accessMode === 'anonymous')) throw error }
        }
        if (!identity && !candidates.some(item => item.accessMode === 'anonymous')) throw Object.assign(new Error('个人凭据缺失'), { httpStatus: 401 })
        const available: BusinessGatewayInstance[] = []
        let unavailableCount = 0
        for (const selected of candidates) {
          if (selected.accessMode === 'anonymous') {
            try {
              const instance = resolveBusinessInstance(assetRoot, selected)
              control.registerInstance(instance.binding)
              const rule = control.config().agents.find(item => item.agentId === selected.agentId)
              if ((selected.identityMode === 'development' || rule?.enabled && (rule.actions.includes('*') || rule.actions.includes('agent:access')))
                && control.agentStatus(instance.binding.instanceId).trust.status === 'trusted') available.push(selected)
            } catch { unavailableCount++ }
            continue
          }
          const rule = control.config().agents.find(item => item.agentId === selected.agentId)
          if (!identity || selected.identityMode !== 'development' && (!rule?.enabled || !rule.subjects.includes(identity.subject.id)
            || !rule.actions.includes('*') && !rule.actions.includes('agent:access'))) continue
          let instance: RegisteredBusinessInstance
          try { instance = resolveBusinessInstance(assetRoot, selected) }
          catch { unavailableCount++; continue }
          try {
            control.registerInstance(instance.binding)
            const context = control.createContext(identity, instance.binding)
            control.assert(context, 'agent:access', [{ kind: 'agent', id: selected.agentId }])
            available.push(selected)
          } catch { /* 无法确认的实例不进入当前身份目录。 */ }
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderInstanceChoice(legacy[1], available, unavailableCount))
        return
      }
      // Runtime 定期租约与回执使用同一专用签名，不借用业务用户权限。
      if (req.url?.startsWith('/control/') && req.method === 'POST') {
        const instanceId = req.url.slice('/control/'.length)
        const selected = currentInstances().find(item => item.instanceId === instanceId)
        if (!selected) throw new Error('业务实例未登记')
        const instance = resolveBusinessInstance(assetRoot, selected); control.registerInstance(instance.binding)
        const assertion = verifyBusinessAssertion(secret, await readSignedControlRequest(req), 'POST', req.url, instance.binding, controlNonces)
        control.recordAgentAuthentication(instance.binding)
        if (assertion.snapshot) control.acknowledge(instanceId, assertion.snapshot.restrictionVersion, assertion.snapshot.leaseId)
        if (assertion.observation) control.importReplicaState(instance.binding, assertion.observation)
        const signed = signBusinessAssertion(secret, assertionFor(instance), 'RESPONSE', req.url)
        return json(res, 200, signed)
      }
      const instance = await prepare(req, 'http', res)
      await proxy.web(req, res, { target: instance.origin })
    } catch (error) {
      const status = (error as { httpStatus?: number }).httpStatus || 403
      const match = /^\/agents\/([a-z0-9-]+)(?:\/instances\/[a-z0-9-]+)?\/$/.exec(req.url || '')
      let knownAgent = false
      try { knownAgent = !!match && currentInstances().some(item => item.agentId === match[1]) } catch { /* 配置失效时保持拒绝。 */ }
      if (!res.headersSent && status === 401 && req.method === 'GET' && req.headers.accept?.includes('text/html')
        && requestOrigin(req) && match && knownAgent) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(renderBusinessGatewayHome({ availableAgents: [], rules: [], facts: [], restrictions: [],
          authenticationMessage: '请先登录，再访问业务智能体。', managementUrl: currentManagementUrl(),
          riskProvider: !!control.config().riskAssessment, agentStatuses: [], operations: [] }))
        return
      }
      if (!res.headersSent) json(res, status, { error: '业务访问被拒绝' })
      else res.destroy()
    }
  })
  const controlNonces = new Map<string, number>()
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)) })
  server.on('upgrade', (req, socket, head) => { const sessionId = browserSessionId(req); void prepare(req, 'websocket').then(instance => { if (sessionId) { const owned = browserConnections.get(sessionId) ?? new Set<Duplex>(); owned.add(socket); browserConnections.set(sessionId, owned); socket.once('close', () => { owned.delete(socket); if (!owned.size) browserConnections.delete(sessionId) }) }; return proxy.ws(req, socket as import('node:net').Socket, { target: instance.origin }, head) }).catch(() => rejectSocket(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve() }) })
  return { server, origin: origin.origin, async close() { lifetime.abort(); sessions.clear(); for (const socket of connections) socket.destroy(); await proxy.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
