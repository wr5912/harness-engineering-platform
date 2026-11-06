import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { planMcpMigration, applyMcpMigration } from '../mcp-migrate.mts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-migrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, value) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)) }
  put('workspace.json', { extensions: [{ id: 'security-operations-compositions', path: 'extensions/security-operations' }] })
  put('config/mcp-manager.json', { servers: ['master', 'ingest', 'graph'].map(name => ({ id: 'ai-soc-' + name })) })
  put('config/mcp-compositions.json', { schema_version: '1.0', compositions: [] })
  put('.local/credentials/mcp-manager/credentials.json', { revision: 7, servers: {} })
  symlinkSync('mcp-manager/credentials.json', join(root, '.local/credentials/mcp-manager.json'))
  put('extensions/security-operations/src/threat/source.ts', "export const test = 1\n")
  return { root, put }
}

test('MCP 分拆迁移保留凭据及身份，激活失败恢复旧文件与链接', async t => {
  const { root } = fixture(t)
  const original = readFileSync(join(root, 'workspace.json'), 'utf8')
  await assert.rejects(applyMcpMigration(planMcpMigration(root), async () => { throw new Error('activation failed') }), /activation failed/)
  assert.equal(readFileSync(join(root, 'workspace.json'), 'utf8'), original)
  assert.equal(readlinkSync(join(root, '.local/credentials/mcp-manager.json')), 'mcp-manager/credentials.json')
  assert.equal(existsSync(join(root, 'config/mcp-manager.json')), true)
  assert.equal(existsSync(join(root, 'mcp/manager.json')), false)
  await applyMcpMigration(planMcpMigration(root))
  assert.equal(JSON.parse(readFileSync(join(root, 'mcp/compositions.json'))).compositions.length, 4)
  assert.equal(JSON.parse(readFileSync(join(root, 'mcp/compositions/inspection-status/composition.json'))).draft.workflow, 'inspection-status')
  assert.equal(JSON.parse(readFileSync(join(root, '.local/credentials/mcp-manager.json'))).revision, 7)
  assert.equal(planMcpMigration(root).complete, true)
})

test('来源并行变化及目标冲突均不覆盖', async t => {
  const { root, put } = fixture(t), plan = planMcpMigration(root)
  put('workspace.json', '{}')
  await assert.rejects(applyMcpMigration(plan), /来源已变化/)
  assert.equal(existsSync(join(root, 'config/mcp-manager.json')), true)
  put('mcp/compositions.json', '{}')
  assert.throws(() => planMcpMigration(root), /来源不符|已有数据/)
})

test('旧构建缓存的 node_modules 链接不遍历，迁移失败也完整恢复', async t => {
  const { root, put } = fixture(t)
  put('dependencies/package.json', '{}')
  put('.local/security-operations-compositions-build/cache/index.mjs', 'export {}')
  symlinkSync(join(root, 'dependencies'), join(root, '.local/security-operations-compositions-build/cache/node_modules'))
  const plan = planMcpMigration(root)
  assert.equal(plan.sources.some(item => item.path.endsWith('/node_modules/package.json')), false)
  await assert.rejects(applyMcpMigration(plan, async () => { throw new Error('rollback') }), /rollback/)
  assert.equal(readlinkSync(join(root, '.local/security-operations-compositions-build/cache/node_modules')), join(root, 'dependencies'))
})
