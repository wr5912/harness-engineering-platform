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
import { effectiveBusinessAccess, platformAddressArgs, processBirth, runningPlatformEntry } from '../src/business-control/runtime-address.ts'

test('内部恢复自动入口不把地址标成显式；反代和用户指定的公开入口保持', () => {
  const state = { host: '127.0.0.1', port: 18121, url: 'http://127.0.0.1:18121/hep/', publicUrl: 'http://127.0.0.1:18121/hep/' }
  const local = ['--host', state.host, '--port', '18121']
  assert.deepEqual(platformAddressArgs(state), local)
  assert.deepEqual(platformAddressArgs({ ...state, url: undefined }), local, '兼容旧迁移回执')
  assert.deepEqual(platformAddressArgs(state, true), [...local, '--public-url', state.publicUrl])
  const nat = { ...state, publicUrl: 'http://192.0.2.1:18121/hep/' }
  assert.deepEqual(platformAddressArgs(nat), [...local, '--public-url', nat.publicUrl])
  const copiedState = { ...state, host: '192.0.2.254', url: 'http://192.0.2.254:18121/hep/', publicUrl: 'http://192.0.2.254:53106/' }
  assert.deepEqual(platformAddressArgs(copiedState), ['--host', copiedState.host, '--port', '18121'], '复制到新环境的旧 HTTP IP 不得作为公开入口复用')
  assert.deepEqual(platformAddressArgs({ ...copiedState, publicUrl: 'https://proxy.example/hep/' }), ['--host', copiedState.host, '--port', '18121', '--public-url', 'https://proxy.example/hep/'], '域名和 HTTPS 公开入口继续保留')
})

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

for (const enabled of [true, false]) test(`业务控制${enabled ? '开启' : '关闭'}时可启动真实业务监听，释放插件时关闭监听`, async t => {
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
  const file = join(root, 'config/business-access.json'), config = JSON.parse(readFileSync(file, 'utf8'))
  config.enabled = enabled
  writeFileSync(file, JSON.stringify(config))
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
    assert.equal(new URL(JSON.parse(readFileSync(join(root, 'config/business-access.json'))).gateway.publicOrigin).hostname, new URL(configured).hostname)
    assert.equal(platformGroupUrl(root, 'test'), `${configured}mcp/groups/test/v2`)
    const access = JSON.parse(readFileSync(join(root, 'config/business-access.json')))
    access.gateway.managementUrlMode = 'explicit'
    writeFileSync(join(root, 'config/business-access.json'), JSON.stringify(access))
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

test('启动以实际地址迁移历史 IP；运行中覆盖旧配置不改变网页与 MCP 入口', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-sync-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  const file = join(root, 'config/business-access.json')
  const old = { schemaVersion: 1, enabled: false, agents: [], gateway: {
    host: '0.0.0.0', port: 53106, publicOrigin: 'http://10.0.160.32:53106',
    managementUrl: 'http://10.0.160.32:18120/hep/', instances: [],
  }, operations: [
    { target: 'http://10.0.160.32:18120/hep/mcp/groups/ops/v2' },
    { target: 'http://10.0.160.32:8000/v1' },
  ] }
  writeFileSync(file, JSON.stringify(old))
  const entry = 'http://172.16.138.228:18121/hep/'
  assert.equal(platformEntryUrl(root, { publicUrl: entry, fallback: entry, host: '0.0.0.0' }), entry)
  const migrated = JSON.parse(readFileSync(file))
  assert.equal(migrated.operations[0].target, `${entry}mcp/groups/ops/v2`, '启动迁移同时更新指向本平台的操作')
  assert.equal(migrated.operations[1].target, old.operations[1].target)
  writeFileSync(file, JSON.stringify(old))
  assert.equal(platformEntryUrl(root), entry)
  assert.equal(platformGroupUrl(root, 'ops'), `${entry}mcp/groups/ops/v2`)
  const effective = effectiveBusinessAccess(root, JSON.parse(readFileSync(file)))
  assert.equal(effective.gateway.publicOrigin, 'http://172.16.138.228:53106')
  assert.equal(effective.gateway.managementUrl, entry)
  assert.equal(effective.operations[0].target, `${entry}mcp/groups/ops/v2`)
  assert.equal(effective.operations[1].target, old.operations[1].target)
  assert.deepEqual(JSON.parse(readFileSync(file)), old, '读取不回写，不能覆盖并发登记')
  for (const publicOrigin of ['https://business.example', 'http://business.example', 'http://192.0.2.1:8080']) {
    const custom = effectiveBusinessAccess(root, { gateway: { ...old.gateway, publicOrigin, publicOriginMode: 'explicit' } })
    assert.equal(custom.gateway.publicOrigin, publicOrigin)
  }
  const explicit = { ...old, gateway: { ...old.gateway, managementUrl: entry, managementUrlMode: 'explicit', publicOriginMode: 'auto' } }
  writeFileSync(file, JSON.stringify(explicit))
  platformEntryUrl(root, { publicUrl: entry, fallback: entry })
  assert.equal(JSON.parse(readFileSync(file)).gateway.managementUrlMode, 'explicit', '显式 HTTP IP 不能在初始化时变成自动入口')
})

test('换环境时旧显式 IP 不再作为管理入口，当前启动入口同步迁移业务分组地址', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-environment-migration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  const file = join(root, 'config/business-access.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], operations: [
    { target: 'http://172.16.138.228:18121/hep/mcp/groups/ops/v2' },
  ], gateway: {
    host: '0.0.0.0', port: 53106, publicOrigin: 'http://172.16.138.228:53106',
    publicOriginMode: 'explicit', managementUrl: 'http://172.16.138.228:18121/hep/', managementUrlMode: 'explicit',
    sharedSecretFile: '.local/credentials/business.key', instances: [],
  }}))
  const current = 'http://127.0.0.1:18120/hep/'
  assert.equal(platformEntryUrl(root, { fallback: current, host: '127.0.0.1' }), current)
  const migrated = JSON.parse(readFileSync(file))
  assert.equal(migrated.gateway.managementUrl, current)
  assert.equal(migrated.gateway.managementUrlMode, 'auto')
  assert.equal(migrated.gateway.publicOrigin, 'http://127.0.0.1:53106')
  assert.equal(migrated.operations[0].target, `${current}mcp/groups/ops/v2`)
  assert.equal(platformGroupUrl(root, 'ops'), `${current}mcp/groups/ops/v2`)
})

test('独立 CLI 只复用存活的当前工作区入口，不采用复制来的进程状态', t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-entry-process-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.local/platform-service'), { recursive: true })
  const file = join(root, '.local/platform-service/state.json')
  const state = { pid: process.pid, birth: processBirth(process.pid), dataRoot: root, publicUrl: 'http://127.0.0.1:18121/hep/' }
  writeFileSync(file, JSON.stringify(state))
  assert.equal(runningPlatformEntry(root), state.publicUrl)
  for (const patch of [{ birth: 'old' }, { dataRoot: `${root}/another` }, { pid: 0 }]) {
    writeFileSync(file, JSON.stringify({ ...state, ...patch }))
    assert.equal(runningPlatformEntry(root), undefined)
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
  assert.deepEqual(after, { ...before, gateway: { ...before.gateway, managementUrl: 'http://127.0.0.1:18120/hep/', managementUrlMode: 'auto' } })
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
