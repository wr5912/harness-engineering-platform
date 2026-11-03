import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import test from 'node:test'

const plugin = resolve(import.meta.dirname, '..'), root = resolve(plugin, '../..')
const watched = ['platform/plugin/lib/index.js', 'platform/plugin/lib/client.js', 'platform/plugin/business/runtime.js',
  'runtime/adapters/dsh-web/lib/index.mjs'].map(file => resolve(root, file))
const snapshot = () => watched.map(file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null)
test('隔离构建不覆盖平台、业务薄入口或原生 Web 的已装载制品，且输出引用可解析', t => {
  const directory = mkdtempSync(join(tmpdir(), 'hep-build-verification-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const before = snapshot()
  execFileSync(process.execPath, ['build.mjs', '--out-dir', directory], { cwd: plugin, stdio: 'pipe' })
  assert.deepEqual(snapshot(), before)
  for (const file of ['index.js', 'client.js', 'agent-access-connector.js', 'dsh-web/index.mjs']) assert.ok(existsSync(join(directory, file)), file)
  for (const file of ['business/runtime.js', 'business/mcp-manager.js']) {
    const content = readFileSync(join(directory, file), 'utf8')
    const reference = /from\s+["']([^"']+)["']/.exec(content)?.[1]
    assert.ok(reference)
    assert.ok(existsSync(resolve(directory, 'business', reference)), file)
  }
})
test('非法输出参数在任何构建副作用前拒绝', () => {
  const before = snapshot()
  assert.throws(() => execFileSync(process.execPath, ['build.mjs', '--out-dir'], { cwd: plugin, stdio: 'pipe' }))
  assert.throws(() => execFileSync(process.execPath, ['build.mjs', '--unsupported'], { cwd: plugin, stdio: 'pipe' }))
  assert.deepEqual(snapshot(), before)
})
