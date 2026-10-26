import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { McpConfigStore } from '../src/mcp/store.ts'
import { connectionIssue, assertConnectionReady } from '../../../plugins/mcp-manager/connection.ts'

process.env.HARNESS_DSH_ENTRY ??= new URL('../package.json', import.meta.url).pathname
const { validateConfiguration } = await import('../lib/mcp-manager.js')

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
  assert.equal(statSync(secretFile).uid, process.geteuid?.() === 0 ? 1000 : process.getuid())
  assert.throws(() => store.mutate([{ op: 'set', path: ['groups'], value: [] }], original.revision), /已变化/)
  assert.equal(store.view().value.groups.length, 1)
})

test('root 初始化保留其他凭据私有，业务 UID 可在保存前后读取 MCP 凭据', { skip: process.geteuid?.() !== 0 }, t => {
  const { root, secretFile } = fixture(t)
  chmodSync(root, 0o755)
  for (const directory of [join(root, '.local'), join(root, '.local/credentials')]) chmodSync(directory, 0o700)
  const admin = join(root, '.local/credentials/admin.json')
  writeFileSync(admin, '{}', { mode: 0o600 })
  const store = new McpConfigStore(root, () => {})
  function check() {
    const result = spawnSync('/bin/cat', [secretFile], { uid: 1000, gid: 1000 })
    assert.equal(result.status, 0, result.error?.message || result.stderr?.toString())
    assert.equal(statSync(secretFile).mode & 0o777, 0o600)
    assert.equal(statSync(secretFile).uid, 1000)
    assert.equal(statSync(admin).mode & 0o777, 0o600)
    assert.equal(statSync(admin).uid, 0)
    assert.equal(statSync(join(root, '.local')).mode & 0o777, 0o711)
  }
  check()
  store.mutate([{ op: 'set', path: ['sharedToken'], value: 'b'.repeat(64) }], store.view().revision)
  check()
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
  const store = new McpConfigStore(root, validateConfiguration)
  const empty = store.view()
  assert.equal(empty.value.servers[0].headers[0].value, '')
  assert.equal(empty.value.sharedToken, '')
  assert.match(connectionIssue(empty.value.servers[0]), /Header/)
  assert.throws(() => assertConnectionReady(empty.value.servers[0]), /补全并保存/)
  const saved = store.mutate([
    { op: 'set', path: ['sharedToken'], value: 'b'.repeat(64) },
    { op: 'set', path: ['servers', '0', 'headers', '0', 'value'], value: 'Bearer fixture-private' },
  ], empty.revision)
  assert.equal(saved.value.sharedToken, 'b'.repeat(64))
  assert.equal(saved.value.servers[0].headers[0].value, 'Bearer fixture-private')
  assert.equal(connectionIssue(saved.value.servers[0]), undefined)
  assert.deepEqual(JSON.parse(readFileSync(secretFile, 'utf8')),
    { schemaVersion: 1, sharedToken: 'b'.repeat(64),
      servers: { first: { headers: { Authorization: 'Bearer fixture-private' } } } })
  assert.equal(statSync(secretFile).mode & 0o777, 0o600)
  assert.ok(!readFileSync(publicFile, 'utf8').includes('fixture-private'))
})

test('真实配置校验允许待补充登录和无授权来源，仍拒绝非法结构', () => {
  const login = { id: 'login', enabled: true, specUrl: 'http://localhost/spec', authType: 'login', tools: { mode: 'all', names: [] } }
  const publicServer = { id: 'public', enabled: true, url: 'http://localhost/mcp', headers: [], tools: { mode: 'all', names: [] } }
  const value = { servers: [login, publicServer], groups: [{ id: 'group', members: [{ serverId: 'login', names: ['echo'] }] }], sharedToken: '' }
  validateConfiguration(value)
  assert.match(connectionIssue(login), /登录/)
  assert.equal(connectionIssue(publicServer), undefined)
  assert.throws(() => validateConfiguration({ ...value, servers: [{ ...publicServer, headers: [{ name: 'bad header', value: '' }] }] }), /Header/)
})

test('平台 MCP 入口不暴露原生 Settings 配置，业务入口保留自身配置合同', async () => {
  const previous = process.env.HARNESS_DSH_ENTRY
  process.env.HARNESS_DSH_ENTRY ??= new URL('../package.json', import.meta.url).pathname
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
