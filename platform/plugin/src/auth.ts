import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { loginBrandingScriptHash, loginCarouselScriptHash, loginThemeScriptHash, loginPage } from './login.tsx'
import { workspaceLocalPath } from './workspace.ts'
import { DEFAULT_BRANDING, type Branding } from './branding-defaults.ts'

declare module '@deepseek-ai/dsh-host-webserver' {
  interface WebServer {
    readonly basePath: string
    publicPath(path: string): string
  }
}

const KEY = credentialKey('harness-platform', 'browser-sessions')
const LEGACY_COOKIE = 'harness_platform_session'
const MAX_AGE = 30 * 24 * 60 * 60
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
interface Session { digest: string; authority: string; expires: number }
interface Sessions { version: 1; account: string; sessions: Session[] }

function stored(record: CredentialRecord | undefined, account: string): Sessions {
  if (!record) return { version: 1, account, sessions: [] }
  const value = record.kind === 'grant' ? record.payload as Sessions : undefined
  if (!value || value.version !== 1 || typeof value.account !== 'string' || !Array.isArray(value.sessions)
    || !value.sessions.every(session => session && /^[a-f0-9]{64}$/.test(session.digest)
      && typeof session.authority === 'string' && Number.isSafeInteger(session.expires))) {
    throw new Error('平台会话记录无效，认证未启用。')
  }
  return { version: 1, account, sessions: value.account === account
    ? value.sessions.filter(session => session.expires > Date.now()) : [] }
}

function accountAt(assetRoot: string): { username: string; password: string } {
  try {
    const account = JSON.parse(readFileSync(workspaceLocalPath(assetRoot, 'credentials', 'admin.json'), 'utf8'))
    if (typeof account.username !== 'string' || !account.username.trim() || account.username.length > 256
      || typeof account.password !== 'string' || !account.password || account.password.length > 1024) throw new Error()
    return account
  } catch {
    throw new Error('无法读取平台账号配置，请检查数据工作区 .local/credentials/admin.json。')
  }
}

/** 已通过平台认证的 RPC 仅返回账号显示所需字段。 */
export function currentAccount(assetRoot: string) {
  return { username: accountAt(assetRoot).username }
}

function formBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) { chunks.length = 0; reject(new Error('body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('body aborted')))
  })
}

export async function applyAuthentication(ctx: Context, assetRoot: string, branding: () => Branding = () => DEFAULT_BRANDING) {
  const connection = ctx.connection
  const nativeAdmission = connection.admit.bind(connection)
  let active = false
  let sessions = new Map<string, Session>()
  const header = (req: ConnectionTrustRequest, name: string) => {
    const value = req.headers instanceof Headers ? req.headers.get(name) : req.headers[name]
    return typeof value === 'string' ? value : undefined
  }
  const authority = (req: ConnectionTrustRequest) => `${ctx.webServer.protocol}//${header(req, 'host')?.toLowerCase()}`
  // 使用 DSH 原生名称，让依赖 Connection 认证的插件取得同一浏览器身份。
  const cookieName = (req: ConnectionTrustRequest) => `dsh-auth-${createHash('sha256').update(new URL(authority(req)).host).digest('base64url')}`
  const sessionValue = (req: ConnectionTrustRequest) => {
    const cookies = (header(req, 'cookie') ?? '').split(';').map(value => value.trim())
    const name = cookies.some(value => value.startsWith(`${cookieName(req)}=`)) ? cookieName(req) : LEGACY_COOKIE
    const values = cookies.filter(value => value.startsWith(`${name}=`)).map(value => value.slice(name.length + 1))
    if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0])) return undefined
    return values[0]
  }
  const sessionOf = (req: ConnectionTrustRequest) => {
    const value = sessionValue(req), session = value ? sessions.get(hash(value)) : undefined
    return session && session.expires > Date.now() && session.authority === authority(req) ? session : undefined
  }
  const fence = (req: ConnectionTrustRequest) => {
    const admission = nativeAdmission(req)
    return 'rejection' in admission && admission.rejection === 403
  }
  const rejection = (req: ConnectionTrustRequest) => fence(req) ? 403 : active && sessionOf(req) ? undefined : 401
  const redirect = (res: ServerResponse, location: string, cookie?: string | string[]) => {
    res.writeHead(303, { 'cache-control': 'no-store', 'referrer-policy': 'same-origin', location,
      ...(cookie ? { 'set-cookie': cookie } : {}) })
    res.end()
  }
  // rc.2 的 API、RPC 和 WebSocket 都通过 admit 取得 Peer；仅覆盖 requestRejection 会留下旧 Cookie 入口。
  // 初始化失败或卸载后仍拒绝访问，不退回原生 Token 或 /connect 认证。
  Object.defineProperties(connection, {
    admit: { configurable: true, value: (req: ConnectionTrustRequest) => {
      const status = rejection(req)
      return status ? { rejection: status } : { peer: connection.browserPeer }
    } },
    requestRejection: { configurable: true, value: rejection },
    authorizeConnect: { configurable: true, value: (req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(fence(req) ? 403 : 401)
      res.end()
    } },
    authorizeIndex: { configurable: true, value: (req: IncomingMessage, res: ServerResponse) => {
      if (fence(req)) { res.writeHead(403); res.end(); return false }
      if (!active || !sessionOf(req)) { redirect(res, ctx.webServer.publicPath('/login')); return false }
      if (new URL(req.url ?? '/', 'http://platform.invalid').searchParams.has('token')) {
        redirect(res, ctx.webServer.publicPath('/')); return false
      }
      migrateCookie(req, res)
      res.setHeader('cache-control', 'no-store')
      return true
    } },
    authenticatedUrl: { configurable: true, value: (base: string) => {
      const url = new URL(base)
      url.searchParams.delete('token')
      return url.href
    } },
  })
  ctx.effect(() => () => { active = false; sessions.clear() })
  const account = accountAt(assetRoot)
  const accountDigest = hash(JSON.stringify([account.username, account.password]))
  const update = async (mutate: (sessions: Session[]) => Session[]) => {
    const record = await ctx.credentials.modifyRecord(KEY, async current => {
      const value = stored(current, accountDigest)
      return { kind: 'grant', payload: { ...value, sessions: mutate(value.sessions) } }
    })
    if (!record) throw new Error('平台会话记录无法保存。')
    sessions = new Map(stored(record, accountDigest).sessions.map(session => [session.digest, session]))
  }
  await update(value => value)
  const cookieHeader = (req: ConnectionTrustRequest, value: string, age: number, name = cookieName(req)) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${ctx.webServer.protocol === 'https:' ? '; Secure' : ''}`
  const migrateCookie = (req: ConnectionTrustRequest, res: ServerResponse) => {
    const session = sessionOf(req)
    if (session && !(header(req, 'cookie') ?? '').split(';').some(value => value.trim().startsWith(`${cookieName(req)}=`))) {
      res.setHeader('set-cookie', [cookieHeader(req, sessionValue(req)!, Math.max(0, Math.floor((session.expires - Date.now()) / 1000))), cookieHeader(req, '', 0, LEGACY_COOKIE)])
    }
  }
  const html = (res: ServerResponse, status = 200, error = '') => {
    let preference: 'light' | 'dark' | 'system' = 'system'
    try {
      const value = ctx.settingsController.describe().namespaces.find(item => item.ns === 'ui-theme')?.value
      const selected = value && typeof value === 'object' && !Array.isArray(value) ? value.preference : undefined
      if (selected === 'light' || selected === 'dark') preference = selected
    } catch {} // 配置暂不可读时仍保留登录入口，按系统主题显示。
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      // no-referrer 会使浏览器表单的 Origin 变成 null，导致同源登录被拒绝。
      'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'sha256-${loginThemeScriptHash}' 'sha256-${loginCarouselScriptHash}' 'sha256-${loginBrandingScriptHash}'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` })
    res.end(loginPage(ctx.webServer.publicPath('/login'), error, preference, branding(), ctx.webServer.publicPath('/api/harness-platform/branding')))
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/harness-platform/branding', handler(req, res) {
    if (!active) { res.writeHead(503); res.end(); return }
    if (fence(req)) { res.writeHead(403); res.end(); return }
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
    const { name, subtitle } = branding()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ name, subtitle }))
  } }))
  for (const path of ['/login', '/logout']) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, async handler(req, res) {
      if (!active) { res.writeHead(503); res.end(); return }
      if (fence(req)) { res.writeHead(403); res.end(); return }
      if (path === '/login' && req.method === 'GET') {
        if (sessionOf(req)) { migrateCookie(req, res); redirect(res, ctx.webServer.publicPath('/')) }
        else html(res)
        return
      }
      if (req.method !== 'POST') { res.writeHead(405, { allow: path === '/login' ? 'GET, POST' : 'POST' }); res.end(); return }
      if (req.headers.origin?.toLowerCase() !== authority(req)) { res.writeHead(403); res.end(); return }
      if (path === '/logout') {
        const session = sessionOf(req)
        if (!session) { res.writeHead(401); res.end(); return }
        sessions.delete(session.digest)
        try { await update(value => value.filter(item => item.digest !== session.digest)) }
        catch { res.writeHead(503); res.end(); return }
        redirect(res, ctx.webServer.publicPath('/login'), [cookieHeader(req, '', 0), cookieHeader(req, '', 0, LEGACY_COOKIE)])
        return
      }
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        res.writeHead(415); res.end(); return
      }
      let body: string
      try { body = await formBody(req) }
      catch { html(res, 413, '登录信息过长或请求未完成。'); return }
      const fields = new URLSearchParams(body)
      const theme = fields.get('theme')
      if (fields.getAll('theme').length > 1 || theme && theme !== 'light' && theme !== 'dark') {
        html(res, 400, '主题选择无效，请刷新后重试。'); return
      }
      const matches = fields.getAll('username').length === 1 && fields.getAll('password').length === 1
        && timingSafeEqual(Buffer.from(hash(JSON.stringify([fields.get('username'), fields.get('password')]))), Buffer.from(accountDigest))
      if (!matches) { html(res, 401, '用户名或密码错误。'); return }
      if (theme) {
        try { await ctx.settingsController.update('ui-theme', { preference: theme }, undefined) }
        catch { html(res, 503, '暂时无法保存主题设置，请重试。'); return }
      }
      const value = randomBytes(32).toString('base64url')
      const session = { digest: hash(value), authority: authority(req), expires: Date.now() + MAX_AGE * 1000 }
      try { await update(items => [...items, session]) }
      catch { html(res, 503, '暂时无法保存登录状态，请重试。'); return }
      redirect(res, ctx.webServer.publicPath('/'), [cookieHeader(req, value, MAX_AGE), cookieHeader(req, '', 0, LEGACY_COOKIE)])
    } }))
  }
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  })
  active = true
}
