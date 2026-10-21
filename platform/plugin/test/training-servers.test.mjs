import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const bundled = mkdtempSync(join(tmpdir(), 'training-servers-module-'))
await build({ entryPoints: [new URL('../src/agents/training-servers.ts', import.meta.url).pathname], outfile: join(bundled, 'index.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external' })
const { createTrainingServersHandler } = await import(`file://${join(bundled, 'index.mjs')}`)
test.after(() => rmSync(bundled, { recursive: true, force: true }))

test('训练连接显式登记、回读与过时版本冲突，配置只保存凭据引用', async t => {
  const root = mkdtempSync(join(tmpdir(), 'training-servers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  const call = createTrainingServersHandler(root)
  const signal = new AbortController().signal
  const empty = await call('list', {}, signal)
  assert.equal(empty.ok, true)
  assert.deepEqual(empty.value.servers, [])
  const server = { name: '训练节点一', host: 'training.example.test', port: 22, user: 'trainer',
    workDir: '/workspace/variant-training', auth: 'ssh_key', credentialRef: 'ref:training-key' }
  const saved = await call('save', { revision: empty.value.revision, server }, signal)
  assert.equal(saved.ok, true)
  assert.equal(saved.value.servers.length, 1)
  assert.match(saved.value.servers[0].id, /^train-/)
  const file = join(root, 'config', 'compute-training-servers.json')
  const content = readFileSync(file, 'utf8')
  assert.ok(content.includes('ref:training-key'))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual((await call('list', {}, signal)).value, saved.value)
  const stale = await call('save', { revision: empty.value.revision, server: { ...server, host: 'other.example.test' } }, signal)
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'conflict')
  const duplicate = await call('save', { revision: saved.value.revision, server }, signal)
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error.code, 'conflict')
  assert.equal((await call('list', {}, signal)).value.servers.length, 1)
})

test('训练连接拒绝密码正文，不写入敏感内容', async t => {
  const root = mkdtempSync(join(tmpdir(), 'training-servers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  const call = createTrainingServersHandler(root)
  const signal = new AbortController().signal
  const empty = await call('list', {}, signal)
  const attempted = await call('save', { revision: empty.value.revision, server: {
    name: '错误连接', host: 'training.example.test', port: 22, user: 'trainer',
    workDir: '/workspace', auth: 'password', credentialRef: 'plaintext-password',
  } }, signal)
  assert.equal(attempted.ok, false)
  assert.equal(attempted.error.code, 'invalid_request')
  assert.equal((await call('list', {}, signal)).value.servers.length, 0)
  const target = join(root, 'outside.json')
  writeFileSync(target, '{}')
  symlinkSync(target, join(root, 'config', 'compute-training-servers.json'))
  const linked = await call('list', {}, signal)
  assert.equal(linked.ok, false)
  assert.equal(linked.error.code, 'invalid_asset')
  assert.equal(readFileSync(target, 'utf8'), '{}')
})

test('连接检查读取真实 SSH 服务标识，不把端口可达当作身份认证', async t => {
  const root = mkdtempSync(join(tmpdir(), 'training-servers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const server = createServer(socket => {
    socket.write('SSH-2.0-')
    setTimeout(() => socket.end('test-server\r\n'), 10)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const call = createTrainingServersHandler(root)
  const signal = new AbortController().signal
  const checked = await call('probe', { host: '127.0.0.1', port: server.address().port }, signal)
  assert.equal(checked.ok, true)
  assert.equal(checked.value.status, 'ssh_reachable')
  assert.match(checked.value.message, /身份认证.*尚未验证/)
  assert.ok(Date.parse(checked.value.checked_at) > 0)
  const invalid = await call('probe', { host: 'https://bad.example', port: 22 }, signal)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'invalid_request')
})

test('两个进程使用同一修订版登记连接时，只有一方成功且读取不会确认持锁旧列表', async t => {
  const root = mkdtempSync(join(tmpdir(), 'training-servers-race-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  const call = createTrainingServersHandler(root)
  const initial = await call('list', {}, new AbortController().signal)
  const script = join(root, 'training-writer.mjs')
  writeFileSync(script, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [bundle, root, revision, label, hold] = process.argv.slice(2)
if (hold === 'hold') {
  const original = fs.renameSync
  fs.renameSync = (...args) => {
    fs.writeFileSync(join(root, 'inside-rename'), '')
    const pause = new Int32Array(new SharedArrayBuffer(4))
    const until = Date.now() + 3000
    while (!fs.existsSync(join(root, 'release-rename')) && Date.now() < until) Atomics.wait(pause, 0, 0, 10)
    original(...args)
  }
  syncBuiltinESMExports()
}
const { createTrainingServersHandler } = await import(pathToFileURL(bundle).href)
const call = createTrainingServersHandler(root)
const server = { name: label, host: label + '.example.test', port: 22, user: 'trainer', workDir: '/workspace', auth: 'ssh_key', credentialRef: '' }
const response = await call('save', { revision, server }, new AbortController().signal)
console.log(JSON.stringify(response))
`)
  const run = (label, hold) => {
    const child = spawn(process.execPath, [script, join(bundled, 'index.mjs'), root, initial.value.revision, label, hold ? 'hold' : 'free'])
    let output = '', errors = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { errors += data })
    return new Promise((resolve, reject) => child.on('close', code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(errors || `进程退出码 ${code}`))))
  }
  const first = run('a', true)
  for (let attempt = 0; attempt < 200 && !existsSync(join(root, 'inside-rename')); attempt++) await delay(10)
  assert.ok(existsSync(join(root, 'inside-rename')), '第一个进程应持锁进入 rename')
  const during = await call('list', {}, new AbortController().signal)
  assert.equal(during.ok, false)
  assert.equal(during.error.code, 'busy')
  assert.match(during.error.message, /确认没有写入进程后移除/)
  const second = run('b', false)
  await delay(100)
  writeFileSync(join(root, 'release-rename'), '')
  const [saved, stale] = await Promise.all([first, second])
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(stale.ok, false, JSON.stringify(stale))
  assert.equal(stale.error.code, 'conflict')
  const file = join(root, 'config', 'compute-training-servers.json')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).servers, saved.value.servers)
  assert.equal(saved.value.revision, (await call('list', {}, new AbortController().signal)).value.revision)
  assert.equal(existsSync(`${file}.lock`), false)
})

test('训练连接残留锁或符号链接锁提示恢复，不读取旧列表或写入锁目标', async t => {
  const root = mkdtempSync(join(tmpdir(), 'training-servers-lock-'))
  const outside = mkdtempSync(join(tmpdir(), 'training-servers-lock-target-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) })
  mkdirSync(join(root, 'config'))
  const target = join(outside, 'target')
  writeFileSync(target, '保留')
  symlinkSync(target, join(root, 'config', 'compute-training-servers.json.lock'))
  const listed = await createTrainingServersHandler(root)('list', {}, new AbortController().signal)
  assert.equal(listed.error.code, 'busy')
  assert.match(listed.error.message, /确认没有写入进程后移除/)
  assert.equal(readFileSync(target, 'utf8'), '保留')
  assert.equal(existsSync(join(root, 'config', 'compute-training-servers.json')), false)
})
