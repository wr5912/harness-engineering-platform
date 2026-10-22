import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { McpConfigStore } from '../src/mcp/store.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, '.local', 'credentials'), { recursive: true })
  const server = { id: 'first', enabled: true, url: 'http://127.0.0.1:18080/mcp',
    headers: [{ name: 'Authorization' }], tools: { mode: 'all', names: [] } }
  const group = { id: 'group', members: [{ serverId: 'first', names: ['echo'] }] }
  const publicFile = join(root, 'config', 'mcp-manager.json')
  const secretFile = join(root, '.local', 'credentials', 'mcp-manager.json')
  writeFileSync(publicFile, JSON.stringify({ schemaVersion: 1, servers: [server], groups: [group] }))
  writeFileSync(secretFile, JSON.stringify({ schemaVersion: 1, sharedToken: 'a'.repeat(64),
    servers: { first: { headers: { Authorization: 'Bearer fixture-private' } } } }), { mode: 0o600 })
  const store = new McpConfigStore(root, value => {
    assert.equal(value.servers[0].id, 'first')
    assert.equal(value.groups[0].members[0].serverId, 'first')
  })
  return { root, publicFile, secretFile, store }
}

test('MCP 保存共用数据仓库版本，凭据只进本地文件，旧版本拒绝覆盖', t => {
  const { publicFile, secretFile, store } = fixture(t)
  const original = store.view()
  assert.equal(original.value.servers[0].headers[0].value, 'Bearer fixture-private')
  const changed = store.mutate([{ op: 'set', path: ['servers', '0', 'description'], value: '已更新' }], original.revision)
  assert.notEqual(changed.revision, original.revision)
  assert.equal(store.view().value.servers[0].description, '已更新')
  assert.ok(!readFileSync(publicFile, 'utf8').includes('fixture-private'))
  assert.ok(readFileSync(secretFile, 'utf8').includes('fixture-private'))
  assert.equal(statSync(secretFile).mode & 0o777, 0o600)
  assert.throws(() => store.mutate([{ op: 'set', path: ['groups'], value: [] }], original.revision), /已变化/)
  assert.equal(store.view().value.groups.length, 1)
})

test('MCP 保存锁阻止并行写；未知字段与地址凭据不能进入公开配置', t => {
  const { root, publicFile, store } = fixture(t)
  const original = store.view(), before = readFileSync(publicFile, 'utf8')
  const lock = join(root, '.local', 'credentials', 'mcp-manager.lock')
  const fd = openSync(lock, 'wx', 0o600)
  try { assert.throws(() => store.mutate([{ op: 'set', path: ['groups'], value: [] }], original.revision), /正在保存/) }
  finally { closeSync(fd); unlinkSync(lock) }
  for (const [path, value] of [
    [['servers', '0', 'private_note'], 'fixture-private'],
    [['groups', '0', 'sharedToken'], 'fixture-private'],
    [['servers', '0', 'url'], 'http://127.0.0.1:18080/mcp?signature=fixture-private'],
  ]) {
    assert.throws(() => store.mutate([{ op: 'set', path, value }], original.revision), /无效字段|凭据参数/)
    assert.equal(readFileSync(publicFile, 'utf8'), before)
  }
})

test('本地凭据为空时可装载，并在界面保存时补充到本地文件', t => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-store-empty-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, '.local', 'credentials'), { recursive: true })
  const server = { id: 'first', enabled: true, url: 'http://127.0.0.1:18080/mcp',
    headers: [{ name: 'Authorization' }], tools: { mode: 'all', names: [] } }
  const publicFile = join(root, 'config', 'mcp-manager.json')
  const secretFile = join(root, '.local', 'credentials', 'mcp-manager.json')
  writeFileSync(publicFile, JSON.stringify({ schemaVersion: 1, servers: [server], groups: [] }))
  writeFileSync(secretFile, JSON.stringify({ schemaVersion: 1, sharedToken: '', servers: {} }), { mode: 0o600 })
  const store = new McpConfigStore(root, () => {})
  const empty = store.view()
  assert.equal(empty.value.servers[0].headers[0].value, '')
  assert.equal(empty.value.sharedToken, '')
  const saved = store.mutate([
    { op: 'set', path: ['sharedToken'], value: 'b'.repeat(64) },
    { op: 'set', path: ['servers', '0', 'headers', '0', 'value'], value: 'Bearer fixture-private' },
  ], empty.revision)
  assert.equal(saved.value.sharedToken, 'b'.repeat(64))
  assert.equal(saved.value.servers[0].headers[0].value, 'Bearer fixture-private')
  assert.deepEqual(JSON.parse(readFileSync(secretFile, 'utf8')),
    { schemaVersion: 1, sharedToken: 'b'.repeat(64),
      servers: { first: { headers: { Authorization: 'Bearer fixture-private' } } } })
  assert.equal(statSync(secretFile).mode & 0o777, 0o600)
  assert.ok(!readFileSync(publicFile, 'utf8').includes('fixture-private'))
})

test('平台 MCP 入口不暴露原生 Settings 配置，业务入口保留自身配置合同', async () => {
  const previous = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_DSH_ENTRY = '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
  try {
    const platform = await import('../lib/platform-mcp-manager.js')
    const business = await import('../lib/mcp-manager.js')
    assert.equal(platform.name, 'mcp-session-manager')
    assert.equal(typeof platform.apply, 'function')
    assert.equal(platform.Config, undefined)
    assert.ok(business.Config)
  } finally {
    if (previous === undefined) delete process.env.HARNESS_DSH_ENTRY
    else process.env.HARNESS_DSH_ENTRY = previous
  }
})
