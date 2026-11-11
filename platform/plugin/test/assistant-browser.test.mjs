import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { parseBrowserInput, platformAuthCookie, createBrowserInspector } from '../src/assistant/browser.ts'
import { assistantActionContract } from '../src/assistant/tool-contracts.ts'

test('页面核验输入只允许登记目标和受限定位器', () => {
  const value = parseBrowserInput({
    target: { kind: 'platform', page: 'mcp' },
    actions: [{ action: 'click', locator: { kind: 'role', value: 'button', name: '发现工具', exact: true } }],
    screenshot: { scope: 'viewport' },
  })
  assert.equal(value.target.kind, 'platform')
  assert.throws(() => parseBrowserInput({
    target: { kind: 'platform', page: 'mcp' },
    actions: [{ action: 'click', locator: { kind: 'css', value: '.danger' } }],
  }))
  assert.throws(() => parseBrowserInput({
    target: { kind: 'url', url: 'http://127.0.0.1:18120' },
  }))
  const contract = assistantActionContract('browser', 'inspect')
  assert.equal(contract.input_schema.$defs.locator.properties.kind.enum.includes('test_id'), true)
})

test('平台页面登录使用现有账号，只返回有效的原生会话 Cookie，HTTP 失败保留状态码', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-auth-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '.local/credentials'), { recursive: true })
  const account = { username: 'test-owner', password: 'fixture-password' }
  await writeFile(join(root, '.local/credentials/admin.json'), JSON.stringify(account))
  let status = 303, cookies = ['harness_platform_session=; Max-Age=0', 'dsh-auth-fixture=fixture-session; HttpOnly; Max-Age=60']
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, 'http://platform.test/hep/login')
    assert.equal(options.headers.origin, 'http://platform.test')
    assert.equal(options.redirect, 'manual')
    assert.deepEqual(Object.fromEntries(options.body), account)
    return new Response('private response body', { status, headers: cookies.map(value => ['set-cookie', value]) })
  })
  const target = 'http://platform.test/hep/#/home', signal = new AbortController().signal
  assert.deepEqual(await platformAuthCookie(root, target, signal), { name: 'dsh-auth-fixture', value: 'fixture-session', url: 'http://platform.test' })
  cookies = ['harness_platform_session=; Max-Age=0']
  await assert.rejects(platformAuthCookie(root, target, signal), /未返回有效会话 Cookie/)
  status = 401
  await assert.rejects(platformAuthCookie(root, target, signal), error => /HTTP 401/.test(error.message) && !error.message.includes(account.password) && !error.message.includes('private response'))
})

test('真实容器浏览器保留登录、页面操作、截图及失败证据，追踪不保存 Cookie', { skip: !process.env.HEP_BROWSER_TEST_IMAGE }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-driver-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cookie = 'fixture-cookie-browser-not-for-evidence'
  const server = createServer(async (req, res) => {
    if (req.url === '/hep/login' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk
      const form = new URLSearchParams(body)
      if (form.get('password') !== 'fixture-password') { res.writeHead(401); res.end(); return }
      res.writeHead(303, { 'set-cookie': `dsh-auth-fixture=${cookie}; Path=/; HttpOnly; SameSite=Strict`, location: '/hep/' }); res.end(); return
    }
    if (!req.headers.cookie?.includes(`dsh-auth-fixture=${cookie}`)) { res.writeHead(401); res.end('登录态缺失'); return }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<main class="harness-platform"><h1>浏览器验收</h1><input aria-label="测试输入"><button onclick="document.querySelector(\'p\').textContent=\'操作完成\'">核对</button><p>待执行</p><h2 style="width:50px;height:50px;margin:0">中</h2><h2 style="width:50px;height:50px;margin:0">文</h2></main>')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, '.local/credentials'), { recursive: true })
  await writeFile(join(root, 'config/business-access.json'), JSON.stringify({ gateway: { managementUrl: `http://127.0.0.1:${server.address().port}/hep/` } }))
  await writeFile(join(root, '.local/credentials/admin.json'), JSON.stringify({ username: 'test-owner', password: 'fixture-password' }))
  const previous = { DSH_IMAGE_TAG: process.env.DSH_IMAGE_TAG, HARNESS_PROGRAM_ROOT: process.env.HARNESS_PROGRAM_ROOT }
  process.env.DSH_IMAGE_TAG = process.env.HEP_BROWSER_TEST_IMAGE
  process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const inspect = createBrowserInspector(root, () => { throw new Error('不应调用其他平台接口') })
  const target = { kind: 'platform', page: 'home' }, signal = new AbortController().signal
  const result = await inspect({ target, actions: [
    { action: 'fill', locator: { kind: 'label', value: '测试输入' }, value: 'fixture-input-value' },
    { action: 'press', locator: { kind: 'label', value: '测试输入' }, key: 'Tab' },
    { action: 'click', locator: { kind: 'role', value: 'button', name: '核对' } },
    { action: 'wait_for', text: '操作完成' },
  ], screenshot: { scope: 'full_page' } }, signal)
  assert.equal(result.ok, true)
  assert.ok(result._screenshot.bytes.length > 100)
  assert.match(await readFile(join(result.evidence.path, 'snapshot.txt'), 'utf8'), /操作完成/)
  const actions = await readFile(join(result.evidence.path, 'actions.json'), 'utf8')
  assert.ok(!actions.includes('fixture-input-value'))
  const trace = unzipSync(await readFile(join(result.evidence.path, 'trace.zip')))
  const metadata = Object.entries(trace).filter(([name]) => /\.(?:trace|network)$/.test(name)).map(([, bytes]) => strFromU8(bytes)).join('\n')
  assert.ok(!metadata.includes(cookie))
  const element = await inspect({ target, screenshot: { scope: 'element', locator: { kind: 'role', value: 'heading', name: '浏览器验收' } } }, signal)
  assert.equal(element.ok, true)
  const glyphs = []
  for (const name of ['中', '文']) {
    const glyph = await inspect({ target, screenshot: { scope: 'element', locator: { kind: 'role', value: 'heading', name, exact: true } } }, signal)
    assert.equal(glyph.ok, true)
    glyphs.push(glyph._screenshot.bytes)
  }
  assert.notDeepEqual(glyphs[0], glyphs[1], '中文应渲染不同字形，不能全部显示为缺字方框')
  const failure = await inspect({ target, actions: [{ action: 'wait_for', text: '不存在的测试文本' }], timeout_ms: 1000 }, signal)
  assert.equal(failure.ok, false)
  assert.equal(failure.stage, 'action')
  assert.equal(failure.error.code, 'browser_action')
  assert.ok(failure.evidence.files.includes('result.json'))
})
