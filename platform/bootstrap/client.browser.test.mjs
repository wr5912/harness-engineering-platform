import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

// 浏览器依赖按现有本地验收环境提供；正常源码校验无需安装浏览器。
const modulePath = process.env.HARNESS_BROWSER_MODULE
const program = fileURLToPath(new URL('../../', import.meta.url))
const evidence = process.env.HARNESS_BOOTSTRAP_EVIDENCE
const browserTest = (name, run) => test(name, { skip: !modulePath && '设置 HARNESS_BROWSER_MODULE 后执行隔离浏览器验收', timeout: 45_000 }, run)

async function fixture(t, { delay = 150, failPrepareOnce = false, existingWorkspace = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-bootstrap-ui-'))
  const home = join(directory, 'home'), root = join(directory, 'data'), result = join(directory, 'result.json')
  await mkdir(home)
  if (existingWorkspace) {
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-fixture', legacyRoots: [], extensions: [] }))
    await writeFile(join(root, 'config/sites.json'), JSON.stringify({ assistant: '/assistant/', platform: '/hep/' }))
    await writeFile(join(root, 'config/sources.json'), JSON.stringify({ schema_version: '1.1', sources: {} }))
    await writeFile(join(root, 'config/mcp-compositions.json'), JSON.stringify({ schema_version: '1.0', compositions: [] }))
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', root])
  }
  const launcher = join(directory, 'serve.mjs')
  await writeFile(launcher, `
import { createBootstrapServer } from ${JSON.stringify(pathToFileURL(join(program, 'platform/bootstrap/server.ts')).href)}
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
let prepareCount=0
const instance = await createBootstrapServer({root:${JSON.stringify(root)},host:'127.0.0.1',port:0,token:'fixture-onboarding',resultFile:${JSON.stringify(result)},programRoot:${JSON.stringify(program)},prepare:async root=>{await writeFile(${JSON.stringify(join(directory, 'prepare-started'))},root);await new Promise(resolve=>setTimeout(resolve,${delay}));if(${failPrepareOnce}&&++prepareCount===1)throw new Error('fixture prepare 失败，请重试');}})
const port = Number(new URL(instance.url).port)
instance.server.on('close',async()=>{const selected=JSON.parse(await readFile(${JSON.stringify(result)},'utf8')).root;const base=JSON.parse(await readFile(selected+'/config/sites.json','utf8')).platform;createServer((req,res)=>{res.setHeader('content-type','text/html; charset=utf-8');if(req.url===base+'login')res.end('<form><input id="login-account"></form>');else if(req.url===base)res.end('<h1>平台已就绪</h1>');else{res.statusCode=404;res.end('没有此入口')}}).listen(port,'127.0.0.1')})
console.log(JSON.stringify({url:instance.url}))
`)
  const child = spawn(process.execPath, [launcher], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let browser
  t.after(async () => { await browser?.close(); child.kill('SIGKILL'); await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)); await rm(directory, { recursive: true, force: true }) })
  let stderr = ''
  child.stderr.on('data', value => { stderr += value.toString() })
  const url = await new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout.on('data', value => { stdout += value; try { resolve(JSON.parse(stdout.trim()).url) } catch {} })
    child.once('exit', code => reject(new Error(`隔离引导服务提前退出 ${code}: ${stderr}`)))
    child.once('error', reject)
  })
  const { chromium } = await import(modulePath.startsWith('/') ? pathToFileURL(modulePath).href : modulePath)
  browser = await chromium.launch({ headless: true, ...(process.env.HARNESS_BROWSER_EXECUTABLE ? { executablePath: process.env.HARNESS_BROWSER_EXECUTABLE } : {}), args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1320, height: 1120 } })
  const requests = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.method() === 'POST') requests.push({ url: request.url(), data: request.postDataJSON() }) })
  await page.goto(`${url}?bootstrap=fixture-onboarding`)
  await page.waitForFunction(() => document.querySelector('#root').value.length > 0)
  return { directory, root, result, page, requests, errors, url }
}

async function account(page) {
  await page.fill('#username', 'fixture-user')
  await page.fill('#password', 'fixture-only-password')
  await page.fill('#password-confirm', 'fixture-only-password')
}
async function preview(page) {
  await page.click('#preview')
  await page.waitForFunction(() => !document.querySelector('#apply').disabled || !document.querySelector('#error').hidden)
}
async function screenshot(page, name) {
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, name), fullPage: true }) }
}
async function entered(page) {
  try { await page.getByRole('heading', { name: '平台已就绪' }).waitFor({ timeout: 10_000 }) }
  catch { throw new Error(`平台尚未接续：${await page.locator('body').innerText()}`) }
}

browserTest('已有工作区完成状态检查后自动预览，填写账号即可确认初始化', async t => {
  const fx = await fixture(t, { existingWorkspace: true }), { page } = fx
  await page.waitForFunction(() => !document.querySelector('#plan').hidden && !document.querySelector('#apply').disabled)
  assert.match(await page.locator('#changes').innerText(), /本地账号文件/)
  await assert.rejects(stat(join(fx.root, '.local/credentials/admin.json')), { code: 'ENOENT' })
  await account(page)
  assert.equal(await page.locator('#apply').isEnabled(), true)
  await screenshot(page, 'bootstrap-existing-preview.png')
  assert.equal('account' in fx.requests.find(request => request.url.endsWith('/preview')).data, false)
  await page.click('#refresh')
  await page.waitForFunction(() => !document.querySelector('#plan').hidden && !document.querySelector('#apply').disabled)
  await page.click('#apply')
  await entered(page)
  assert.equal(fx.requests.filter(request => request.url.endsWith('/preview')).length, 2)
  assert.equal(fx.requests.filter(request => request.url.endsWith('/apply')).length, 1)
  assert.deepEqual(fx.errors, [])
})

browserTest('引导页预览、刷新失效、密码边界与空白工作区进入平台', async t => {
  const fx = await fixture(t), { page } = fx
  assert.equal(await page.locator('input[name=action]').count(), 3)
  assert.match(await page.locator('#initial-checks').innerText(), /首次初始化需要填写账号与密码/)
  assert.equal(await page.locator('#apply').isDisabled(), true)
  await screenshot(page, 'bootstrap-desktop.png')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await screenshot(page, 'bootstrap-mobile.png')
  await page.setViewportSize({ width: 1320, height: 1120 })
  await page.check('input[value=new]')
  await account(page)
  await page.fill('#root', join(fx.directory, 'alternate'))
  await preview(page)
  assert.equal(await page.locator('#apply').isEnabled(), true)
  const firstPreview = fx.requests.find(request => request.url.endsWith('/preview'))
  assert.equal('account' in firstPreview.data, false)
  assert.equal(JSON.stringify(firstPreview.data).includes('fixture-only-password'), false)
  await page.click('#refresh')
  await page.waitForFunction(root => document.querySelector('#root').value === root && document.querySelector('#apply').disabled, fx.root)
  assert.equal(await page.locator('#plan').isHidden(), true)
  await preview(page)
  await page.fill('#password-confirm', 'different')
  await page.click('#apply')
  assert.match(await page.locator('#error').innerText(), /不一致/)
  assert.equal(fx.requests.some(request => request.url.endsWith('/apply')), false)
  await account(page)
  await screenshot(page, 'bootstrap-preview.png')
  await page.click('#apply')
  await entered(page)
  assert.equal(fx.requests.filter(request => request.url.endsWith('/apply')).length, 1)
  assert.equal(JSON.parse(await readFile(fx.result, 'utf8')).root, fx.root)
  assert.equal(JSON.parse(await readFile(join(fx.root, 'workspace.json'), 'utf8')).schemaVersion, 1)
  assert.equal((await stat(join(fx.root, '.local/credentials/admin.json'))).mode & 0o777, 0o600)
  assert.deepEqual(fx.errors, [])
})

browserTest('克隆检查不覆盖已有目录，失败后修改仓库地址可重试', async t => {
  const fx = await fixture(t), { page } = fx
  const occupied = join(fx.directory, 'occupied')
  await mkdir(occupied); await writeFile(join(occupied, 'keep.txt'), '保留原文件')
  await page.check('input[value=clone]')
  await page.fill('#root', occupied)
  await page.fill('#repository', join(fx.directory, 'missing-git'))
  await preview(page)
  assert.match(await page.locator('#error').innerText(), /不会覆盖/)
  assert.equal(await readFile(join(occupied, 'keep.txt'), 'utf8'), '保留原文件')
  await page.fill('#root', fx.root)
  await preview(page); await account(page); await page.click('#apply')
  await page.waitForFunction(() => !document.querySelector('#error').hidden && document.querySelector('#error').textContent.includes('克隆失败'))
  await page.waitForFunction(() => !document.querySelector('#preview').disabled)
  assert.equal(await page.locator('#apply').isDisabled(), true)
  assert.equal(await page.locator('#password').inputValue(), '')
  await assert.rejects(stat(fx.root), { code: 'ENOENT' })
  const source = join(fx.directory, 'source')
  await mkdir(source)
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', source])
  await writeFile(join(source, 'source.txt'), '独立克隆测试')
  execFileSync('git', ['-C', source, 'add', 'source.txt'])
  execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  await page.fill('#repository', source)
  await preview(page); await account(page); await page.click('#apply')
  await entered(page)
  assert.equal(await readFile(join(fx.root, 'source.txt'), 'utf8'), '独立克隆测试')
  assert.deepEqual(fx.errors, [])
})

browserTest('初始化期间刷新页面仍显示处理中并等待真实登录入口', async t => {
  const fx = await fixture(t, { delay: 2600 }), { page } = fx
  await page.check('input[value=new]')
  await preview(page); await account(page); await page.click('#apply')
  await page.waitForFunction(() => !document.querySelector('#progress').hidden)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('正在初始化'))
  assert.equal(await page.locator('#apply').isDisabled(), true)
  await screenshot(page, 'bootstrap-preparing.png')
  await entered(page)
  assert.deepEqual(fx.errors, [])
})

browserTest('含扩展的克隆必须重新预览实际源码后才能准备平台', async t => {
  const fx = await fixture(t), { page } = fx
  const source = join(fx.directory, 'with-extension')
  await mkdir(join(source, 'extensions/basic'), { recursive: true })
  await writeFile(join(source, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-fixture', legacyRoots: [], extensions: [{ id: 'basic', path: 'extensions/basic' }] }))
  await writeFile(join(source, 'extensions/basic/build.mjs'), '// 仅供只读确认的基础示例；验收使用注入的 prepare，不执行此文件。\n')
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', source])
  execFileSync('git', ['-C', source, 'add', '.'])
  execFileSync('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  await page.check('input[value=clone]'); await page.fill('#repository', source)
  await preview(page); await account(page); await page.click('#apply')
  await page.waitForFunction(() => document.querySelector('input[value=existing]').checked && document.querySelector('#error').textContent.includes('仓库已克隆'))
  assert.equal(await page.locator('#apply').isDisabled(), true)
  await assert.rejects(stat(join(fx.directory, 'prepare-started')), { code: 'ENOENT' })
  await preview(page)
  assert.match(await page.locator('#extensions').innerText(), /basic.*extensions\/basic/)
  assert.equal(await page.locator('#account').isHidden(), true)
  await screenshot(page, 'bootstrap-extension-review.png')
  await page.click('#apply'); await entered(page)
  assert.equal(fx.requests.filter(request => request.url.endsWith('/apply')).length, 2)
  assert.ok(fx.requests.filter(request => request.url.endsWith('/apply')).every(request => /^[a-f0-9]{64}$/.test(request.data.previewRevision)))
  assert.deepEqual(fx.errors, [])
})

browserTest('准备失败保留已初始化工作区并可从已有目录重新预览', async t => {
  const fx = await fixture(t, { failPrepareOnce: true }), { page } = fx
  await page.check('input[value=new]')
  await preview(page); await account(page); await page.click('#apply')
  await page.waitForFunction(() => document.querySelector('input[value=existing]').checked && document.querySelector('#error').textContent.includes('prepare 失败'))
  const workspace = await readFile(join(fx.root, 'workspace.json'), 'utf8')
  await preview(page)
  assert.equal(await page.locator('#account').isHidden(), true)
  await page.click('#apply'); await entered(page)
  assert.equal(await readFile(join(fx.root, 'workspace.json'), 'utf8'), workspace)
  assert.deepEqual(fx.errors, [])
})

browserTest('已有工作区按 sites 配置接续自定义平台前缀', async t => {
  const fx = await fixture(t), { page } = fx
  const sites = JSON.stringify({ assistant: '/assistant/', platform: '/review/' })
  await mkdir(join(fx.root, 'config'), { recursive: true })
  await writeFile(join(fx.root, 'config/sites.json'), sites)
  await preview(page); await account(page); await page.click('#apply')
  await entered(page)
  assert.equal(new URL(page.url()).pathname, '/review/')
  assert.equal(await readFile(join(fx.root, 'config/sites.json'), 'utf8'), sites)
  assert.equal((await page.request.get(new URL('/hep/login', fx.url).href)).status(), 404)
  assert.deepEqual(fx.errors, [])
})
