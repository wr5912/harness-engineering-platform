import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { build } from 'esbuild'
import { platformEntryUrl, platformGroupUrl } from '../src/business-control/group-link.ts'
import { initializeBusinessGateway } from '../src/business-control/configuration.ts'

test('空白工作区由实际启动入口初始化，默认启用完整业务网关', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-empty-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(platformEntryUrl(root, { fallback: 'http://127.0.0.1:18120/' }), 'http://127.0.0.1:18120/')
  assert.equal(platformGroupUrl(root, 'test'), 'http://127.0.0.1:18120/mcp/groups/test/v2')
  const access = JSON.parse(readFileSync(join(root, 'config/business-access.json')))
  assert.equal(access.enabled, true)
  assert.equal(access.gateway.port, 53105)
  assert.equal(access.gateway.publicOrigin, 'http://127.0.0.1:53105')
  assert.deepEqual(access.gateway.instances, [])
  assert.ok(readFileSync(join(root, access.gateway.sharedSecretFile)).length >= 32)
})

test('已有配置内容不变时仍修复 Runtime 读取权限且不重写内容', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-permissions-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  initializeBusinessGateway(root, 'http://127.0.0.1:18120/hep/')
  const file = join(root, 'config/business-access.json')
  const before = readFileSync(file)
  chmodSync(file, 0o644)
  const inode = statSync(file).ino
  initializeBusinessGateway(root, 'http://127.0.0.1:18120/hep/')
  assert.deepEqual(readFileSync(file), before)
  assert.equal(statSync(file).ino, inode)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  if (process.geteuid?.() === 0) assert.equal(statSync(file).uid, 1000)
})

test('默认初始化配置可启动真实业务监听，释放插件时关闭监听', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-listener-'))
  const reserved = createServer()
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve))
  const port = reserved.address().port
  await new Promise(resolve => reserved.close(resolve))
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  symlinkSync(new URL('../node_modules', import.meta.url), join(root, 'node_modules'), 'dir')
  await build({ entryPoints: ['src/business-control/index.ts'], outfile: join(root, 'gateway.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const { applyBusinessGateway } = await import(`file://${join(root, 'gateway.mjs')}`)
  initializeBusinessGateway(root, 'http://127.0.0.1:18120/hep/', '127.0.0.1', port)
  await applyBusinessGateway(ctx, root)
  const response = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /业务|智能体/)
  await ctx.fiber.dispose()
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`))
})

test('平台入口保留域名、反代和子路径，所有分组由同一入口派生', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  for (const [base, configured] of [['/hep/', 'http://172.16.138.228:18120/hep/'], ['/tools/hep/', 'https://proxy.example/tools/hep/']]) {
    writeFileSync(join(root, 'config/sites.json'), JSON.stringify({ platform: base }))
    writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], gateway: { managementUrl: configured } }))
    assert.equal(platformEntryUrl(root, { publicUrl: configured, host: '0.0.0.0', fallback: `http://0.0.0.0:18120${base}` }), configured)
    assert.equal(JSON.parse(readFileSync(join(root, 'config/business-access.json'))).gateway.host, '0.0.0.0')
    assert.equal(platformGroupUrl(root, 'test'), `${configured}mcp/groups/test/v2`)
    assert.throws(() => platformEntryUrl(root, { publicUrl: 'https://other.example/', fallback: configured }), /不一致/)
  }
  writeFileSync(join(root, 'config/sites.json'), JSON.stringify({ platform: '/hep/' }))
  for (const origin of ['http://127.0.0.1:18120', 'http://172.16.138.229:18120']) {
    writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], gateway: {} }))
    assert.equal(platformEntryUrl(root, { fallback: `${origin}/hep/` }), `${origin}/hep/`)
    assert.equal(platformGroupUrl(root, 'test'), `${origin}/hep/mcp/groups/test/v2`)
    assert.equal(JSON.parse(readFileSync(join(root, 'config/business-access.json'))).gateway.managementUrl, `${origin}/hep/`)
  }
})

test('启动补齐旧配置缺失字段，保留关闭开关、已有登记、自定义地址和密钥', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-existing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  const file = join(root, 'config/business-access.json')
  const before = { schemaVersion: 1, enabled: false, agents: [], gateway: {
    host: '127.0.0.2', port: 53106, publicOrigin: 'https://business.example',
    sharedSecretFile: 'existing.key', instances: [{ agentId: 'test', instanceId: 'existing', accessMode: 'anonymous' }],
  } }
  writeFileSync(join(root, 'existing.key'), Buffer.alloc(48, 7))
  writeFileSync(file, JSON.stringify(before))
  platformEntryUrl(root, { fallback: 'http://127.0.0.1:18120/hep/' })
  const after = JSON.parse(readFileSync(file))
  assert.deepEqual(after, { ...before, gateway: { ...before.gateway, managementUrl: 'http://127.0.0.1:18120/hep/' } })
  assert.deepEqual(readFileSync(join(root, 'existing.key')), Buffer.alloc(48, 7))
  const saved = readFileSync(file, 'utf8')
  platformEntryUrl(root, { fallback: 'http://127.0.0.1:18120/hep/' })
  assert.equal(readFileSync(file, 'utf8'), saved)
  for (const gateway of ['invalid', [], { port: 70000 }, { publicOrigin: 'http://localhost/path' }]) {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], gateway }))
    const invalid = readFileSync(file, 'utf8')
    assert.throws(() => platformEntryUrl(root, { fallback: 'http://127.0.0.1:18120/hep/' }), /配置|publicOrigin/)
    assert.equal(readFileSync(file, 'utf8'), invalid, '配置无效时不得覆盖原文件')
  }
})
