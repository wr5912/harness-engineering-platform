import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeWorkspace, inspectWorkspace, previewWorkspace } from './workspace.ts'
import { createBootstrapServer } from './server.ts'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bootstrap contract '))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, root: join(directory, 'user data'), account: { username: 'basic-user', password: 'fixture-private-password' } }
}

test('省略账号时使用约定默认值，显式无效账号仍拒绝，已有账号不覆盖', async t => {
  const f = fixture(t)
  await assert.rejects(() => initializeWorkspace({ action: 'new', root: f.root, account: { username: '', password: '' } }), /有效的首次登录账号/)
  assert.equal(existsSync(f.root), false)
  await initializeWorkspace({ action: 'new', root: f.root })
  const file = join(f.root, '.local/credentials/admin.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { username: 'admin', password: 'admin123' })
  assert.equal(statSync(file).mode & 0o777, 0o600)
  writeFileSync(file, JSON.stringify(f.account))
  await initializeWorkspace({ action: 'existing', root: f.root })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), f.account)
})

test('新工作区预览无写入，初始化保持空业务并可复用账号，非空目录禁止覆盖', async t => {
  const f = fixture(t)
  const request = { action: 'new', root: f.root, account: f.account }
  const plan = await previewWorkspace(request)
  assert.equal(plan.canApply, true)
  assert.equal(plan.needsAccount, true)
  assert.equal(JSON.stringify(plan).includes(f.account.password), false)
  assert.equal(existsSync(f.root), false)
  await initializeWorkspace(request)
  assert.equal((await inspectWorkspace(f.root)).ready, true)
  assert.equal(existsSync(join(f.root, 'agents')), false)
  assert.equal(existsSync(join(f.root, 'evolution')), false)
  assert.equal(statSync(join(f.root, '.local/credentials/admin.json')).mode & 0o777, 0o600)
  await assert.rejects(() => initializeWorkspace(request), /不会覆盖/)
  const original = readFileSync(join(f.root, '.local/credentials/admin.json'), 'utf8')
  await initializeWorkspace({ action: 'existing', root: f.root, account: { username: 'different', password: 'discard' } })
  assert.equal(readFileSync(join(f.root, '.local/credentials/admin.json'), 'utf8'), original)
})

test('已有非Git数据预览git init且保留文件，损坏身份不得静默覆盖', async t => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'config'), { recursive: true })
  writeFileSync(join(f.root, 'keep.txt'), 'existing data')
  const originalIgnore = '# 保留已有规则\nreports/\n*.llm-api-key\n!local.llm-api-key'
  writeFileSync(join(f.root, '.gitignore'), originalIgnore)
  const plan = await previewWorkspace({ action: 'existing', root: f.root })
  assert.ok(plan.plannedChanges.some(item => item.includes('git init')))
  assert.ok(plan.plannedChanges.some(item => item.includes('追加必要忽略规则')))
  await initializeWorkspace({ action: 'existing', root: f.root, account: f.account })
  assert.equal(readFileSync(join(f.root, 'keep.txt'), 'utf8'), 'existing data')
  const finalIgnore = readFileSync(join(f.root, '.gitignore'), 'utf8')
  assert.equal(finalIgnore, originalIgnore + '\n.local/\n*.llm-api-key\n')
  for (const file of ['.local/credentials/admin.json', '.local/platform-home/session.json', 'local.llm-api-key', 'config/provider.llm-api-key']) {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', file], { cwd: f.root })
  }
  await initializeWorkspace({ action: 'existing', root: f.root })
  assert.equal(readFileSync(join(f.root, '.gitignore'), 'utf8'), finalIgnore)
  writeFileSync(join(f.root, 'workspace.json'), '{"schemaVersion":1,"id":"workspace-test","legacyRoots":["relative"]}')
  assert.equal((await previewWorkspace({ action: 'existing', root: f.root })).canApply, false)
  await assert.rejects(() => initializeWorkspace({ action: 'existing', root: f.root }), /已有文件无效/)
})

test('克隆本地Git历史并保留来源，失败不留下半成品或覆盖目标', async t => {
  const f = fixture(t), source = join(f.directory, 'source')
  mkdirSync(source)
  execFileSync('git', ['init', '--quiet', source])
  writeFileSync(join(source, 'source.txt'), 'fixed source')
  writeFileSync(join(source, '.gitignore'), 'reports/\n')
  execFileSync('git', ['add', 'source.txt', '.gitignore'], { cwd: source })
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: source })
  await initializeWorkspace({ action: 'clone', root: f.root, repositoryUrl: source, account: f.account })
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'fixed source')
  assert.equal(readFileSync(join(f.root, '.gitignore'), 'utf8'), 'reports/\n.local/\n*.llm-api-key\n')
  for (const file of ['.local/credentials/admin.json', 'test.llm-api-key']) execFileSync('git', ['check-ignore', '--quiet', '--', file], { cwd: f.root })
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }))
  const failed = join(f.directory, 'failed')
  await assert.rejects(() => initializeWorkspace({ action: 'clone', root: failed, repositoryUrl: join(f.directory, 'absent'), account: f.account }), /克隆失败/)
  assert.equal(existsSync(failed), false)
  assert.equal(readdirSync(f.directory).some(name => name.startsWith('.harness-clone-')), false)
  await assert.rejects(() => previewWorkspace({ action: 'clone', root: failed, repositoryUrl: 'https://user:private-value@example.invalid/repo' }), error => !error.message.includes('private-value'))
})

test('初始化HTTP要求一次性入口和同源写，prepare失败可重试且成功交接实际根', async t => {
  const f = fixture(t), home = join(f.directory, 'home'), oldHome = process.env.HOME
  process.env.HOME = home
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome })
  let attempts = 0
  const resultFile = join(f.directory, 'result.json')
  const app = await createBootstrapServer({ root: f.root, host: '127.0.0.1', port: 0, token: 'fixture-once', resultFile, programRoot: '/unused', prepare: async root => { assert.equal(root, f.root); if (++attempts === 1) throw new Error('fixture prepare failure') } })
  t.after(() => app.close())
  assert.equal((await fetch(app.url + 'bootstrap/status')).status, 401)
  const authorized = await fetch(app.url + '?bootstrap=fixture-once', { redirect: 'manual' })
  assert.equal(authorized.status, 303)
  const cookie = authorized.headers.get('set-cookie').split(';')[0]
  const headers = { cookie, 'content-type': 'application/json', origin: new URL(app.url).origin }
  const input = { action: 'new', root: f.root, account: f.account, previewRevision: (await previewWorkspace({ action: 'new', root: f.root })).revision }
  const denied = await fetch(app.url + 'bootstrap/apply', { method: 'POST', headers: { ...headers, origin: 'http://elsewhere.invalid' }, body: JSON.stringify(input) })
  assert.equal(denied.status, 403)
  assert.equal(existsSync(f.root), false)
  const failure = await fetch(app.url + 'bootstrap/apply', { method: 'POST', headers, body: JSON.stringify(input) })
  assert.equal(failure.status, 400)
  assert.equal((await failure.json()).error, 'fixture prepare failure')
  assert.equal(existsSync(resultFile), false)
  const state = await (await fetch(app.url + 'bootstrap/status', { headers: { cookie } })).json()
  assert.equal(state.phase, 'idle')
  assert.equal(JSON.stringify(state).includes(f.account.password), false)
  writeFileSync(join(f.root, 'config/sites.json'), JSON.stringify({ assistant: '/assistant/', platform: '/review/' }))
  const customSite = await (await fetch(app.url + 'bootstrap/status', { headers: { cookie } })).json()
  assert.equal(customSite.normalUrl, '/review/')
  const success = await fetch(app.url + 'bootstrap/apply', { method: 'POST', headers, body: JSON.stringify({ action: 'existing', root: f.root, previewRevision: (await previewWorkspace({ action: 'existing', root: f.root })).revision }) })
  assert.equal(success.status, 200)
  assert.equal((await success.json()).normalUrl, '/review/')
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), { root: f.root })
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.config/harness-engineering-platform/workspace.json'), 'utf8')), { assetRoot: f.root })
  assert.equal(attempts, 2)
})

test('克隆的扩展必须先盘点再确认，预览后源码变化阻止装载', async t => {
  const f = fixture(t), source = join(f.directory, 'extension source'), oldHome = process.env.HOME
  process.env.HOME = join(f.directory, 'home')
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome })
  mkdirSync(join(source, 'extensions/basic'), { recursive: true })
  writeFileSync(join(source, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-basic', extensions: [{ id: 'basic', path: 'extensions/basic' }] }))
  writeFileSync(join(source, 'extensions/basic/build.mjs'), '// 基本模拟扩展，测试中不执行。\n')
  execFileSync('git', ['init', '--quiet', source])
  execFileSync('git', ['add', '.'], { cwd: source })
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: source })
  let prepared = 0
  const resultFile = join(f.directory, 'result.json')
  const app = await createBootstrapServer({ root: f.root, host: '127.0.0.1', port: 0, token: 'once', resultFile, programRoot: '/unused', prepare: async () => { prepared++ } })
  t.after(() => app.close())
  const authorized = await fetch(app.url + '?bootstrap=once', { redirect: 'manual' })
  const headers = { cookie: authorized.headers.get('set-cookie').split(';')[0], origin: new URL(app.url).origin, 'content-type': 'application/json' }
  const post = (endpoint, input) => fetch(app.url + 'bootstrap/' + endpoint, { method: 'POST', headers, body: JSON.stringify(input) })
  const clone = { action: 'clone', root: f.root, repositoryUrl: source }
  const first = await (await post('preview', clone)).json()
  const cloned = await (await post('apply', { ...clone, previewRevision: first.revision, account: f.account })).json()
  assert.equal(cloned.requiresReview, true)
  assert.equal(cloned.extensions[0].id, 'basic')
  assert.equal(prepared, 0)
  assert.equal(existsSync(resultFile), false)
  const existing = { action: 'existing', root: f.root }
  const reviewed = await (await post('preview', existing)).json()
  writeFileSync(join(f.root, 'extensions/basic/build.mjs'), '// 更新过的基本模拟扩展。\n')
  const stale = await post('apply', { ...existing, previewRevision: reviewed.revision })
  assert.equal(stale.status, 400)
  assert.equal(prepared, 0)
  const latest = await (await post('preview', existing)).json()
  assert.notEqual(latest.revision, reviewed.revision)
  assert.equal((await post('apply', { ...existing, previewRevision: latest.revision })).status, 200)
  assert.equal(prepared, 1)
})
