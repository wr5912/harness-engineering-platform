import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { build, transform } from 'esbuild'

const require = createRequire(import.meta.url)
async function load(entry) {
  const result = await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', loader: { '.svg': 'dataurl' } })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, Buffer, Headers, URL, URLSearchParams })
  return module.exports
}
const { loginPage, loginCarouselScript, loginCarouselScriptHash } = await load('../src/login.tsx')

const tags = (html, tag) => Array.from(html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi')), match => match[0])
const hasHidden = tag => /\shidden(?:\s|=|>)/i.test(tag)

test('登录页 CSS 保留原始文本，服务端渲染不转义布局语法', async () => {
  const css = loginPage('/hep/login').match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1]
  assert.ok(css)
  assert.doesNotMatch(css, /&(?:quot|gt|lt|amp);/)
  const result = await transform(css, { loader: 'css', logLevel: 'silent' })
  assert.deepEqual(result.warnings, [])
})

test('登录页静态输出四项平台特性，无 JavaScript 时首项可读且轮播控制隐藏', () => {
  const html = loginPage('/hep/login')
  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /data-login-carousel/)
  const slides = tags(html, '[a-z][\\w-]*').filter(tag => /class="[^"]*\blogin-feature-slide\b/.test(tag))
  assert.equal(slides.length, 4)
  assert.equal(slides.filter(tag => /data-active="true"/.test(tag)).length, 1)
  assert.match(slides[0], /data-active="true"/)
  assert.match(slides[0], /aria-hidden="false"/)
  assert.ok(slides.slice(1).every(tag => /data-active="false"/.test(tag) && /aria-hidden="true"/.test(tag)))
  const controls = tags(html, '[a-z][\\w-]*').find(tag => /data-carousel-controls/.test(tag))
  assert.ok(controls)
  assert.ok(hasHidden(controls))
})

test('轮播控件为普通按钮，唯一提交入口仍属于用户名密码 POST 表单', () => {
  const html = loginPage('/hep/login')
  const buttons = tags(html, 'button')
  assert.ok(buttons.length > 1)
  assert.equal(buttons.filter(tag => /type="submit"/.test(tag)).length, 1)
  assert.ok(buttons.every(tag => /type="(?:button|submit)"/.test(tag)))
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i)?.[0]
  assert.ok(form)
  assert.match(form, /method="post"/i)
  assert.match(form, /action="\/hep\/login"/)
  assert.equal(tags(form, 'button').length, 1)
  assert.match(form, /<button\b[^>]*type="submit"/)
  const inputs = tags(form, 'input')
  const username = inputs.find(tag => /\bname="username"/.test(tag))
  const password = inputs.find(tag => /\bname="password"/.test(tag))
  assert.ok(username)
  assert.ok(password)
  assert.match(username, /autocomplete="username"/i)
  assert.match(password, /\btype="password"/i)
  assert.match(password, /autocomplete="current-password"/i)
})

test('登录跳转地址及服务端错误按 HTML 转义，不产生额外脚本或可执行错误标签', () => {
  const action = '/hep/login?return="/><script>alert("action")</script>&route=alpha'
  const error = '<img src=x onerror="alert(1)">&无法登录'
  const html = loginPage(action, error)
  assert.match(html, /action="\/hep\/login\?return=&quot;\/&gt;&lt;script&gt;alert\(&quot;action&quot;\)&lt;\/script&gt;&amp;route=alpha"/)
  assert.match(html, /role="alert"[^>]*>&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&amp;无法登录/)
  assert.equal(html.includes(action), false)
  assert.equal(html.includes(error), false)
  assert.equal(tags(html, 'script').length, 1)
})

test('页面只内嵌唯一轮播脚本，其实际字节与 CSP 使用的 SHA256 摘要一致', () => {
  const html = loginPage('/hep/login')
  const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
  assert.equal(scripts.length, 1)
  assert.doesNotMatch(scripts[0][1], /\bsrc\s*=/i)
  assert.equal(scripts[0][2], loginCarouselScript)
  assert.equal(createHash('sha256').update(scripts[0][2]).digest('base64'), loginCarouselScriptHash)
})

// 仅替换 DOM、媒体查询和时钟边界；执行页面真实输出的脚本，不重写轮播状态迁移。
function eventTarget(tag = '') {
  const attributes = new Map(Array.from(tag.matchAll(/\s([\w-]+)="([^"]*)"/g), match => [match[1], match[2]]))
  const listeners = new Map()
  return { hidden: hasHidden(tag), textContent: '',
    dataset: Object.fromEntries(Array.from(attributes).filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])),
    setAttribute(name, value) { attributes.set(name, String(value)) },
    getAttribute(name) { return attributes.get(name) ?? null },
    removeAttribute(name) { attributes.delete(name) },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener) },
    emit(type, values = {}) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...values }
      listeners.get(type)?.forEach(listener => listener(event))
      return event
    },
  }
}

function carousel({ reducedMotion = false, missingRoot = false } = {}) {
  const html = loginPage('/hep/login')
  const elements = tags(html, '[a-z][\\w-]*').map(eventTarget)
  const find = attribute => elements.find(element => element.getAttribute(attribute) !== null)
  const slides = elements.filter(element => element.getAttribute('data-carousel-slide') !== null)
  const dots = elements.filter(element => element.getAttribute('data-carousel-to') !== null)
  const root = find('data-login-carousel')
  const controls = find('data-carousel-controls')
  const content = find('data-carousel-content')
  const playback = find('data-carousel-playback')
  const previous = find('data-carousel-previous')
  const next = find('data-carousel-next')
  root.querySelectorAll = selector => selector === '[data-carousel-slide]' ? slides : selector === '[data-carousel-to]' ? dots : []
  root.querySelector = selector => find(selector.slice(1, -1)) ?? null
  const form = eventTarget(), document = eventTarget(), window = eventTarget(), motion = eventTarget()
  document.hidden = false
  document.querySelector = selector => selector === '[data-login-carousel]' ? missingRoot ? null : root : selector === '.harness-login form' ? form : null
  motion.matches = reducedMotion
  window.matchMedia = () => motion
  let now = 0, sequence = 0
  const timers = new Map()
  window.setTimeout = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + delay }); return id }
  window.clearTimeout = id => timers.delete(id)
  const advance = duration => {
    const until = now + duration
    for (;;) {
      const first = Array.from(timers).sort((a, b) => a[1].at - b[1].at)[0]
      if (!first || first[1].at > until) break
      now = first[1].at; timers.delete(first[0]); first[1].callback()
    }
    now = until
  }
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)[1]
  vm.runInNewContext(script, { document, window })
  return { root, slides, dots, controls, content, playback, previous, next, form, document, window, motion, advance,
    pending: () => timers.size,
    active: () => {
      assert.equal(slides.filter(slide => slide.dataset.active === 'true').length, 1)
      return slides.findIndex(slide => slide.dataset.active === 'true')
    },
  }
}

test('真实脚本按七秒轮播，悬停暂缓，暂停与恢复保持当前特性及单一定时器', () => {
  const ui = carousel()
  assert.equal(ui.controls.hidden, false)
  assert.equal(ui.active(), 0)
  assert.equal(ui.pending(), 1)
  ui.advance(6999); assert.equal(ui.active(), 0)
  ui.advance(1); assert.equal(ui.active(), 1)
  assert.equal(ui.pending(), 1)
  ui.root.emit('mouseenter'); ui.advance(14000)
  assert.equal(ui.active(), 1)
  assert.equal(ui.pending(), 0)
  ui.root.emit('mouseleave'); ui.advance(7000)
  assert.equal(ui.active(), 2)
  ui.playback.emit('click'); ui.advance(14000)
  assert.equal(ui.active(), 2)
  assert.equal(ui.playback.getAttribute('aria-pressed'), 'true')
  ui.playback.emit('click'); ui.advance(7000)
  assert.equal(ui.active(), 3)
  ui.advance(7000); assert.equal(ui.active(), 0)
  assert.equal(ui.pending(), 1)
})

test('手动选项、前后与方向键切换会暂停自动播放，其他键保持默认行为', () => {
  const ui = carousel()
  ui.dots[2].emit('click')
  assert.equal(ui.active(), 2)
  assert.equal(ui.dots[2].getAttribute('aria-current'), 'true')
  assert.equal(ui.content.getAttribute('aria-live'), 'polite')
  ui.advance(14000); assert.equal(ui.active(), 2)
  ui.next.emit('click'); assert.equal(ui.active(), 3)
  ui.next.emit('click'); assert.equal(ui.active(), 0)
  ui.previous.emit('click'); assert.equal(ui.active(), 3)
  assert.equal(ui.root.emit('keydown', { key: 'ArrowRight' }).defaultPrevented, true)
  assert.equal(ui.active(), 0)
  assert.equal(ui.root.emit('keydown', { key: 'ArrowLeft' }).defaultPrevented, true)
  assert.equal(ui.active(), 3)
  assert.equal(ui.root.emit('keydown', { key: 'Tab' }).defaultPrevented, false)
  assert.equal(ui.active(), 3)
  assert.equal(ui.pending(), 0)
})

test('焦点或登录输入停止自动切换，输入监听不读取凭据，页面隐藏时清理计时', () => {
  const ui = carousel()
  ui.root.emit('focusin', { target: ui.dots[0] })
  assert.equal(ui.pending(), 0)
  ui.playback.emit('click')
  const input = Object.defineProperty({}, 'value', { get() { assert.fail('轮播不能读取登录凭据') } })
  ui.form.emit('input', { target: input })
  ui.advance(14000); assert.equal(ui.active(), 0)
  assert.equal(ui.pending(), 0)
  const page = carousel()
  page.advance(7000); assert.equal(page.active(), 1)
  page.document.hidden = true; page.document.emit('visibilitychange'); page.advance(14000)
  assert.equal(page.active(), 1)
  assert.equal(page.pending(), 0)
  page.document.hidden = false; page.document.emit('visibilitychange'); page.advance(7000)
  assert.equal(page.active(), 2)
  page.window.emit('pagehide'); assert.equal(page.pending(), 0)
  page.window.emit('pageshow'); assert.equal(page.pending(), 1)
})

test('减少动态效果默认暂停且仍可手动查看，缺少轮播区域时安全降级', () => {
  const ui = carousel({ reducedMotion: true })
  assert.equal(ui.pending(), 0)
  ui.advance(14000); assert.equal(ui.active(), 0)
  ui.dots[3].emit('click'); assert.equal(ui.active(), 3)
  const changed = carousel()
  changed.advance(7000); assert.equal(changed.active(), 1)
  changed.motion.matches = true; changed.motion.emit('change'); changed.advance(14000)
  assert.equal(changed.active(), 1)
  assert.equal(changed.pending(), 0)
  const missing = carousel({ missingRoot: true })
  assert.equal(missing.controls.hidden, true)
  assert.equal(missing.pending(), 0)
})

test('真实登录 HTTP 的 CSP 允许且仅允许当前脚本，错误登录、成功登录及退出保持原认证流程', async t => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const Connection = await import('@deepseek-ai/dsh-client-connection')
  const { default: WebServer } = await import('../../../runtime/adapters/dsh-web/lib/platform-webserver.mjs')
  const { applyAuthentication } = await load('../src/auth.ts')
  const root = new Context()
  const assetRoot = mkdtempSync(join(tmpdir(), 'harness-login-page-'))
  t.after(async () => { await root.fiber.dispose(); rmSync(assetRoot, { recursive: true, force: true }) })
  mkdirSync(join(assetRoot, '.local/credentials'), { recursive: true })
  writeFileSync(join(assetRoot, '.local/credentials/admin.json'), JSON.stringify({ username: 'login-test', password: 'fixture-password' }))
  // 只替换凭据持久化，不启动模型或业务网关；Cordis、WebServer、Connection、认证与 HTTP 均为真实实现。
  class Credentials extends Service {
    records = new Map()
    constructor(ctx) { super(ctx, 'credentials') }
    async modifyRecord(key, update) {
      const next = await update(this.records.get(key))
      if (next) this.records.set(key, next)
      return this.records.get(key)
    }
  }
  await root.plugin({ name: 'login-test-credentials', apply(ctx) { new Credentials(ctx) } })
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await root.plugin(Connection)
  await root.plugin({ name: 'login-test-auth', inject: ['connection', 'credentials', 'webServer'], apply(ctx) { return applyAuthentication(ctx, assetRoot) } })
  const origin = `http://127.0.0.1:${root.webServer.port}`
  const base = origin + root.webServer.publicPath('/')
  const loginUrl = origin + root.webServer.publicPath('/login')
  const login = password => fetch(loginUrl, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ username: 'login-test', password }) })
  const page = await fetch(loginUrl)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('referrer-policy'), 'same-origin')
  const html = await page.text()
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
  assert.equal(scripts.length, 1)
  const digest = createHash('sha256').update(scripts[0][1]).digest('base64')
  const policy = page.headers.get('content-security-policy')
  const scriptSources = policy.match(/(?:^|;)\s*script-src\s+([^;]+)/)?.[1].trim().split(/\s+/)
  assert.deepEqual(scriptSources, [`'sha256-${digest}'`])
  const wrong = await login('incorrect-fixture-password')
  assert.equal(wrong.status, 401)
  assert.equal(wrong.headers.get('set-cookie'), null)
  assert.match(await wrong.text(), /用户名或密码错误/)
  const success = await login('fixture-password')
  assert.equal(success.status, 303)
  assert.equal(success.headers.get('location'), root.webServer.publicPath('/'))
  const cookieHeader = success.headers.get('set-cookie')
  assert.match(cookieHeader, /HttpOnly; SameSite=Strict/)
  const cookie = cookieHeader.split(';')[0]
  const signedIn = await fetch(loginUrl, { redirect: 'manual', headers: { cookie } })
  assert.equal(signedIn.status, 303)
  assert.equal(new URL(signedIn.headers.get('location'), origin).href, base)
  const logout = await fetch(origin + root.webServer.publicPath('/logout'), { method: 'POST', redirect: 'manual', headers: { origin, cookie } })
  assert.equal(logout.status, 303)
  assert.equal(logout.headers.get('location'), root.webServer.publicPath('/login'))
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
  const signedOut = await fetch(loginUrl, { redirect: 'manual', headers: { cookie } })
  assert.equal(signedOut.status, 200)
  assert.match(await signedOut.text(), /action="\/hep\/login"/)
})
