import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { instanceStateRoot, workspaceIdentity, workspaceOwnsInstance } from '../workspace.ts'
import { getBusinessControl } from './core.ts'
import type { BusinessContext, ControlSnapshot, InstanceBinding, ReplicaObservation, AuthenticatedIdentity, AgentAccessRule, RiskFact, Restriction, AgentInstanceStatus, OperationRule } from './contracts.ts'

const CONTEXT_HEADER = 'x-harness-business-context'
const SIGNATURE_HEADER = 'x-harness-business-signature'
const SIGNATURE_TTL_MS = 2_000
export interface BusinessGatewayConfig {
  host: string; port: number; publicOrigin: string; sharedSecretFile: string
  instances: { agentId: string; instanceId: string }[]; managementUrl?: string
}
export interface RuntimeAssertion { context?: BusinessContext; binding: InstanceBinding; snapshot?: ControlSnapshot; observation?: ReplicaObservation; issuedAt: number; nonce: string }
export interface RegisteredBusinessInstance { binding: InstanceBinding; origin: string; basePath: string }

export function readBusinessSecret(path: string): Buffer {
  const value = readFileSync(path)
  if (value.length < 32) throw new Error('业务接入共享密钥必须至少为 32 字节')
  return value
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

/** 使用既有实例登记；不接受客户端指定上游或以同名实例继承旧代次。 */
export function resolveBusinessInstance(assetRoot: string, selected: { agentId: string; instanceId: string }): RegisteredBusinessInstance {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selected.instanceId)) throw new Error('业务实例名称无效')
  const manifest = JSON.parse(readFileSync(join(instanceStateRoot(assetRoot), selected.instanceId, 'instance.json'), 'utf8'))
  if (!workspaceOwnsInstance(assetRoot, manifest) || manifest.agent_id !== selected.agentId) throw new Error('业务实例归属不匹配')
  const registration = manifest.business_control
  if (!registration || typeof registration.runtime_generation !== 'string' || !registration.runtime_generation || typeof registration.source_digest !== 'string' || !registration.source_digest) throw new Error('实例没有已核对的业务接入登记')
  const url = new URL(registration.origin)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('业务实例接入地址无效')
  // 业务 Runtime 必须位于本机或容器私网，公开监听不是可信上下文边界。
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error('业务 Runtime 必须使用本机或私网地址')
  const basePath = typeof manifest.web_base_path === 'string' ? manifest.web_base_path.replace(/\/$/, '') : ''
  return { origin: url.origin, basePath, binding: { workspaceId: workspaceIdentity(assetRoot).id, agentId: selected.agentId, instanceId: selected.instanceId, runtimeGeneration: registration.runtime_generation, sourceDigest: registration.source_digest } }
}

function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
export function businessRequestHeaders(req: IncomingMessage): Record<string, string | undefined> {
  return { authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined }
}
function rejectSocket(socket: Duplex, status = 401): void { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) }
/** 只开放首期真实纳管入口；原生插件自注册HTTP不能因签名自动获得授权。 */
export function allowedBusinessPath(path: string, method: string, transport: 'http' | 'websocket'): boolean {
  if (transport === 'websocket') return method === 'GET' && path === '/api/remote.mux'
  if (path.startsWith('/api/')) return (method === 'POST' && /^\/api\/(?:session|remoteAccess)\/[A-Za-z]+$/.test(path))
    || (method === 'POST' && path === '/api/workspace/create')
    || (['GET', 'POST'].includes(method) && path === '/api/business-control/confirmations')
    || (method === 'GET' && /^\/api\/business-control\/reports\/[a-f0-9-]{36}$/.test(path))
  return ['GET', 'HEAD'].includes(method) && (path === '/' || /^\/(?:plugins|assets|sessions?|conversation)(?:\/|$)/.test(path) || /^\/(?:favicon\.(?:ico|svg|png)|manifest\.webmanifest)$/.test(path))
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
function renderBusinessGatewayHome(input: { identity?: AuthenticatedIdentity; availableAgents: { agentId: string }[]; rules: AgentAccessRule[]; facts: RiskFact[]; restrictions: Restriction[]; authenticationMessage: string; managementUrl?: string; riskProvider: boolean; agentStatuses: { agentId: string; instanceId: string; status: AgentInstanceStatus }[]; operations: readonly OperationRule[] }): string {
  const { identity, availableAgents, rules, facts, restrictions } = input
  const pair = (label: string, value: unknown) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`
  const scoped = (scope: { sessionId?: string; serverId?: string }) => [scope.sessionId && `会话 ${scope.sessionId}`, scope.serverId && `服务 ${scope.serverId}`].filter(Boolean).join('；') || 'Agent 范围'
  const riskRows = rules.map(rule => {
    const own = facts.filter(fact => fact.scope.agentId === rule.agentId).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)), latest = own[0]
    const limits = restrictions.filter(item => item.active && item.scope.agentId === rule.agentId)
    const status = !latest ? '待业务事件触发评估' : latest.status === 'unknown' ? '评估结果未知'
      : Date.parse(latest.expiresAt) <= Date.now() ? '最近事实已过期，受保护动作需要重新评估'
      : limits.length ? '当前存在访问限制'
      : latest.signals.some(signal => signal.code.startsWith('deny-')) ? (latest.contentDigest ? '最近一次内容检测拒绝；新内容会重新检查' : '当前风险事实含访问限制') : '最近一次评估完成，后续动作继续自动检查'
    return `<section class="agent-risk"><h3>${escapeHtml(rule.agentId)}</h3><p>${escapeHtml(status)}</p>${latest ? `<dl>${pair('最近自动评估', latest.observedAt)}${pair('有效至', latest.expiresAt)}${pair('范围', scoped(latest.scope))}${pair('评估来源', latest.source)}</dl>` : ''}${own.length ? `<ul>${own.map(fact => `<li>${escapeHtml(scoped(fact.scope))}：${fact.signals.length ? fact.signals.map(signal => `${escapeHtml(signal.code)}=${escapeHtml(signal.value)}（${escapeHtml(signal.reason)}）`).join('；') : '此范围最近一次评估没有新增限制'}${fact.status === 'unknown' ? '（未知）' : Date.parse(fact.expiresAt) <= Date.now() ? '（已过期）' : ''}</li>`).join('')}</ul>` : ''}${limits.length ? `<ul>${limits.map(limit => `<li>当前限制 ${escapeHtml(scoped(limit.scope))}：${escapeHtml(limit.deniedActions.join('、'))}；${escapeHtml(limit.reason)}</li>`).join('')}</ul>` : ''}</section>`
  }).join('')
  let management = ''
  if (identity && input.managementUrl) {
    const url = new URL(input.managementUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('现有平台管理入口配置无效')
    management = `<a href="${escapeHtml(url.href)}" rel="noopener noreferrer">打开现有平台管理入口</a>（仍需平台管理登录）`
  }
  const authText: Record<string, string> = { verified: '已验证', unknown: '尚未收到有效实例签名', expired: '实例认证已过期', disabled: 'Agent认证已关闭，禁止业务执行' }
  const trustText: Record<string, string> = { trusted: '身份条件已满足', unknown: '待核验', revoked: '身份已撤销', mismatch: '来源或实例代次不匹配', expired: '身份依据已过期' }
  const auth = identity ? (input.agentStatuses.length ? input.agentStatuses.map(item => `<section><h3>${escapeHtml(item.agentId)}</h3><dl>${pair('实例', item.instanceId)}${pair('Agent认证方式', item.status.authentication.method)}${pair('认证状态', authText[item.status.authentication.status] || item.status.authentication.status)}${pair('真实证据', item.status.authentication.evidence || '尚无有效实例签名')}${pair('最近实例签名', item.status.authentication.verifiedAt || '尚无有效签名')}${pair('认证有效至', item.status.authentication.expiresAt || '未知')}</dl></section>`).join('') : '<p>当前没有获准的业务 Agent 实例。</p>') : '<p>登录后展示获准业务 Agent 的实例认证方式和真实签名验证状态。</p>'
  const trust = identity ? (input.agentStatuses.length ? input.agentStatuses.map(item => `<section><h3>${escapeHtml(item.agentId)}</h3><dl>${pair('可信来源核验状态', trustText[item.status.trust.status] || item.status.trust.status)}${pair('判断依据', item.status.trust.reason)}${pair('实际来源摘要', item.status.trust.sourceDigest || '未知')}${pair('已固定来源摘要', rules.find(rule => rule.agentId === item.agentId)?.sourceDigest || '尚未固定')}${pair('实例代次', item.status.trust.runtimeGeneration || '未知')}${pair('限制版本', item.status.trust.restrictionVersion)}</dl></section>`).join('') : '<p>当前没有可核验的业务 Agent 实例。</p>') : '<p>核对业务智能体的固定来源、实例代次和有效签名；身份条件不满足时直接拒绝，不折算为业务风险分数。</p>'
  const targetLabel = (target: string) => { try { const url = new URL(target); return `${url.protocol}//${url.host}${url.pathname}${url.search ? '?…' : ''}` } catch { return target } }
  const authorization = identity ? (rules.length ? rules.map(rule => {
    const operations = input.operations.filter(operation => (!rule.serverIds || rule.serverIds.includes(operation.serverId)) && (rule.actions.includes('*') || rule.actions.includes(operation.kind)))
    return `<section><h3>${escapeHtml(rule.agentId)}</h3><dl>${pair('Agent基础动作', rule.actions.join('、'))}${pair('服务范围', rule.serverIds?.join('、') || '按已登记操作的实际目标执行')}</dl>${operations.length ? `<ul>${operations.map(operation => `<li>${escapeHtml(operation.serverId)} / ${escapeHtml(operation.operationId)}：${escapeHtml(operation.kind)} · ${escapeHtml(operation.method)} ${escapeHtml(targetLabel(operation.target))}</li>`).join('')}</ul>` : '<p>当前没有已登记且匹配基础授权的工具或资源操作。</p>'}<p>以上是配置的能力范围；实际执行会综合智能体身份、当前风险、运行许可和业务归属作出访问决定。</p></section>`
  }).join('') : '<p>当前没有获准的业务 Agent。</p>') : '<p>登录后展示本人可见业务 Agent 的动作、工具和资源范围。</p>'
  const visitor = identity ? `<p class="visitor">当前访问者：${escapeHtml(identity.subject.id)}；会话有效至 ${escapeHtml(identity.expiresAt)}。个人登录用于区分业务上下文，不代替智能体的凭据、可信来源与实例绑定核验。</p>` : '<p>先使用个人凭据登录；登录身份用于会话隔离，智能体身份、风险评估与访问控制的对象是业务 Agent。</p>'
  const directory = identity ? `<h2>我的业务智能体</h2>${availableAgents.length ? availableAgents.map(item => `<p><a href="/agents/${escapeHtml(item.agentId)}/">${escapeHtml(item.agentId)}</a></p>`).join('') : '<p>当前没有可以进入的业务智能体。</p>'}` : ''
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>统一网关</title><style>body{max-width:1000px;margin:5vh auto;padding:24px;font:16px/1.6 system-ui;background:Canvas;color:CanvasText}h1,h2,h3{line-height:1.3}.notice{padding:14px 18px;border:1px solid #b58b31;border-radius:8px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:24px}.card{padding:20px;border:1px solid #8886;border-radius:10px;min-width:0}.card h2{margin-top:0;font-size:20px}dt{font-weight:600}dd{margin:0 0 10px;overflow-wrap:anywhere}li{overflow-wrap:anywhere}.agent-risk{border-top:1px solid #8884;margin-top:16px}input,button{font:inherit;padding:7px 10px;margin:4px}input{max-width:65%}a{color:LinkText}@media(max-width:900px){.cards{grid-template-columns:1fr}body{padding:16px;margin:1vh auto}}</style></head><body><h1>统一网关</h1><p>先核验智能体身份，再结合实时风险与访问策略决定是否允许操作。</p>${visitor}<p class="notice"><strong>首期仅支持即时任务。</strong>定时任务尚未纳入检测、防护闭环；巡检与报表需要手动启动，可能延迟或漏执行。空闲期间不执行周期巡检。</p><form id="login"><label>${identity ? '更换个人凭据' : '个人访问凭据'} <input id="credential" type="password" autocomplete="off" required></label><button>登录</button></form><p id="message" role="status">${escapeHtml(input.authenticationMessage)}</p>${identity ? '<button id="logout">退出</button>' : ''}${directory}<div class="cards"><section class="card"><h2>智能体身份</h2><h3>认证方式与凭据</h3>${auth}<h3>可信来源与身份状态</h3>${trust}</section><section class="card"><h2>风险评估</h2><p>业务输入、工具执行、报告发布和下载会自动触发评估，并联动访问限制；手动重评仅用于辅助复核。</p><p>${input.riskProvider ? '已配置风险提供方；以下展示当前业务上下文内 Agent 的真实评估记录。' : '尚未接入外部风险提供方；已配置的本地检测规则仍在执行边界运行。'}</p>${identity ? riskRows || '<p>当前没有可展示的业务评估记录。</p>' : '<p>登录后展示本人可见业务 Agent 的自动评估状态、时间、依据和限制。</p>'}</section><section class="card"><h2>访问控制</h2>${authorization}</section></div><p>${management || '功能配置请在平台“统一网关”管理页完成。'}业务入口不提供管理配置写入。</p><script>const output=document.getElementById('message');document.getElementById('login').onsubmit=async e=>{e.preventDefault();const field=document.getElementById('credential');const value=field.value;field.value='';const response=await fetch('/session',{method:'POST',headers:{authorization:'Bearer '+value}});if(response.ok)location.reload();else output.textContent='凭据无效或身份服务不可用。'};const logout=document.getElementById('logout');if(logout)logout.onclick=async()=>{await fetch('/session',{method:'DELETE'});location.reload()};</script></body></html>`
}
export interface BusinessGatewayHandle { server: Server; origin: string; close(): Promise<void> }

/** 独立监听只代理已登记 Agent；httpxy 承担 HTTP/WS 协议转发。 */
export async function startBusinessGateway(assetRoot: string, config: BusinessGatewayConfig): Promise<BusinessGatewayHandle> {
  if (config.instances.some(item => !/^[a-z][a-z0-9-]*$/.test(item.agentId) || !/^[a-z][a-z0-9-]*$/.test(item.instanceId))) throw new Error('业务 Agent 或实例名称无效')
  const control = getBusinessControl(assetRoot)
  if (!control.enabled()) throw new Error('业务控制尚未启用')
  const secret = readBusinessSecret(config.sharedSecretFile)
  const origin = new URL(config.publicOrigin)
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('业务公开来源必须是独立 origin')
  const { createProxyServer } = await import('httpxy')
  const proxy = createProxyServer({ xfwd: false, ws: true })
  const sessions = new Map<string, { headers: Record<string, string | undefined>; expiresAt: number }>()
  const connections = new Set<Duplex>()
  const browserConnections = new Map<string, Set<Duplex>>()
  const browserSessionId = (req: IncomingMessage) => req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('harness-business='))?.slice(17)
  const lifetime = new AbortController()
  const headerForIdentity = (req: IncomingMessage): Record<string, string | undefined> => {
    if (req.headers.authorization) return businessRequestHeaders(req)
    const key = browserSessionId(req)
    const session = key ? sessions.get(key) : undefined
    if (!session || session.expiresAt <= Date.now()) return {}
    return session.headers
  }
  const admit = async (req: IncomingMessage, transport: 'http' | 'websocket') => {
    if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin)) throw new Error('业务请求来源无效')
    const identity = await control.authenticate({ transport, method: req.method || 'GET', path: req.url || '/', headers: headerForIdentity(req) }, lifetime.signal)
    return identity
  }
  const assertionFor = (instance: RegisteredBusinessInstance, context?: BusinessContext): RuntimeAssertion => ({ binding: instance.binding, context, snapshot: control.issueSnapshot(instance.binding.instanceId), issuedAt: Date.now(), nonce: randomBytes(24).toString('base64url') })
  const prepare = async (req: IncomingMessage, transport: 'http' | 'websocket') => {
    const identity = await admit(req, transport)
    const url = new URL(req.url || '/', origin)
    const match = /^\/agents\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname)
    if (!match) throw new Error('请选择已开放业务智能体')
    const selected = config.instances.find(instance => instance.agentId === match[1])
    if (!selected) throw new Error('业务智能体未开放')
    const instance = resolveBusinessInstance(assetRoot, selected)
    control.registerInstance(instance.binding)
    const context = control.createContext(identity, instance.binding)
    control.assert(context, 'agent:access', [{ kind: 'agent', id: selected.agentId }])
    const route = match[2] || '/'
    if (!allowedBusinessPath(route, req.method || 'GET', transport)) throw new Error('业务路径未开放')
    const path = instance.basePath + route + url.search
    // 代理丢弃调用方凭据与伪造控制 Header，只有此边界签名进入 Runtime。
    for (const name of Object.keys(req.headers)) if (name.startsWith('x-harness-') || ['authorization', 'cookie', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].includes(name)) delete req.headers[name]
    req.url = path
    Object.assign(req.headers, signBusinessAssertion(secret, assertionFor(instance, context), req.method || 'GET', path))
    req.headers.host = new URL(instance.origin).host
    return instance
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/' && req.method === 'GET') {
        if (req.headers.host !== origin.host) throw new Error('业务请求来源无效')
        let availableAgents: { agentId: string; instanceId: string }[] = []
        let authenticated = false, pageStatus = 200, authenticationMessage = ''
        let identity: Awaited<ReturnType<typeof control.authenticate>> | undefined
        if (req.headers.authorization || browserSessionId(req)) {
          try { identity = await admit(req, 'http') } catch (error) { pageStatus = (error as { httpStatus?: number }).httpStatus || 403; authenticationMessage = '当前身份不可用，请重新登录。' }
        }
        if (identity) {
          authenticated = true
          for (const selected of config.instances) {
            const rule = control.config().agents.find(item => item.agentId === selected.agentId)
            if (!rule?.enabled || !rule.subjects.includes(identity.subject.id)) continue
            const instance = resolveBusinessInstance(assetRoot, selected); control.registerInstance(instance.binding)
            if (control.agentStatus(instance.binding.instanceId).trust.status !== 'trusted') continue
            const context = control.createContext(identity, instance.binding)
            try { control.assert(context, 'agent:access', [{ kind: 'agent', id: selected.agentId }]); availableAgents.push(selected) }
            catch (error) { if ((error as { httpStatus?: number }).httpStatus !== 403) throw error }
          }
        }
        res.writeHead(pageStatus, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        const rules = identity ? control.config().agents.filter(rule => rule.enabled && rule.subjects.includes(identity.subject.id)) : []
        const status = control.status()
        const visible = (scope: { agentId: string; subjectId?: string }) => !!identity && rules.some(rule => rule.agentId === scope.agentId) && (scope.subjectId === undefined || scope.subjectId === identity.subject.id)
        const agentStatuses = identity ? config.instances.filter(item => rules.some(rule => rule.agentId === item.agentId)).map(item => ({ ...item, status: control.agentStatus(item.instanceId) })) : []
        res.end(renderBusinessGatewayHome({ identity, availableAgents, rules, facts: identity ? status.riskFacts.filter(fact => fact.scope.subjectId === identity.subject.id && visible(fact.scope)) : [], restrictions: identity ? status.restrictions.filter(item => visible(item.scope)) : [], authenticationMessage, managementUrl: config.managementUrl, riskProvider: !!control.config().riskAssessment, agentStatuses, operations: control.config().operations || [] }))
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
        res.setHeader('set-cookie', `harness-business=${id}; HttpOnly; SameSite=Strict; Path=/${origin.protocol === 'https:' ? '; Secure' : ''}`)
        return json(res, 200, { subject: identity.subject, expiresAt: identity.expiresAt })
      }
      if (req.url === '/session' && req.method === 'DELETE') {
        if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin)) throw new Error('业务请求来源无效')
        const key = browserSessionId(req)
        if (key) { sessions.delete(key); for (const socket of browserConnections.get(key) || []) socket.destroy(); browserConnections.delete(key) }
        res.setHeader('set-cookie', 'harness-business=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
        return json(res, 200, { ended: true })
      }
      // Runtime 定期租约与回执使用同一专用签名，不借用业务用户权限。
      if (req.url?.startsWith('/control/') && req.method === 'POST') {
        const instanceId = req.url.slice('/control/'.length)
        const selected = config.instances.find(item => item.instanceId === instanceId)
        if (!selected) throw new Error('业务实例未登记')
        const instance = resolveBusinessInstance(assetRoot, selected); control.registerInstance(instance.binding)
        const assertion = verifyBusinessAssertion(secret, await readSignedControlRequest(req), 'POST', req.url, instance.binding, controlNonces)
        control.recordAgentAuthentication(instance.binding)
        if (assertion.snapshot) control.acknowledge(instanceId, assertion.snapshot.restrictionVersion, assertion.snapshot.leaseId)
        if (assertion.observation) control.importReplicaState(instance.binding, assertion.observation)
        const signed = signBusinessAssertion(secret, assertionFor(instance), 'RESPONSE', req.url)
        return json(res, 200, signed)
      }
      const instance = await prepare(req, 'http')
      await proxy.web(req, res, { target: instance.origin })
    } catch (error) {
      if (!res.headersSent) json(res, (error as { httpStatus?: number }).httpStatus || 403, { error: '业务访问被拒绝' })
      else res.destroy()
    }
  })
  const controlNonces = new Map<string, number>()
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)) })
  server.on('upgrade', (req, socket, head) => { const sessionId = browserSessionId(req); void prepare(req, 'websocket').then(instance => { if (sessionId) { const owned = browserConnections.get(sessionId) ?? new Set<Duplex>(); owned.add(socket); browserConnections.set(sessionId, owned); socket.once('close', () => { owned.delete(socket); if (!owned.size) browserConnections.delete(sessionId) }) }; return proxy.ws(req, socket as import('node:net').Socket, { target: instance.origin }, head) }).catch(() => rejectSocket(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve() }) })
  return { server, origin: origin.origin, async close() { lifetime.abort(); sessions.clear(); for (const socket of connections) socket.destroy(); await proxy.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
