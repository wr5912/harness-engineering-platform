import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import { digest } from '../../../runtime/adapters/dsh-container/instance-assets.ts'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../../../runtime/adapters/dsh-container/instance-load-observer.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs' })).outputFiles[0].text

function observer(t) {
  const root = mkdtempSync(join(tmpdir(), 'hep-load-observer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'plugin.js'), bytes = 'export const name = "plugin"'
  writeFileSync(file, bytes)
  const expected = { nonce: 'one-attempt', source_id: 'experiment:EXP-demo-001', digest: digest('source'), preset_id: 'demo', files: [{ path: file, sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex') }] }
  const receipts = [], local = { options: { name: file }, fiber: { state: 1 } }
  const row = { moduleName: file, enabled: true, fiberState: 1 }
  let tick, active = true, disposed = false
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, process: { pid: 41 }, URL,
    require: name => name === 'node:fs' ? {
      readFileSync(path, ...args) { return path === '/opt/harness-asset-load/expected.json' ? JSON.stringify(expected) : readFileSync(path, ...args) },
      writeFileSync(path, data) { assert.equal(path, '/tmp/hep-asset-load.json'); receipts.push(JSON.parse(data)) },
    } : require(name),
    setInterval(fn) { tick = fn; return 1 }, clearInterval() { disposed = true },
  })
  const ctx = {
    loader: { entries: () => [local, { options: { name: 'external-mcp' }, fiber: { state: 5 } }] },
    agentPresets: {
      async readDocument() { return { content: 'plugins: []' } },
      inspectCompositions() { return active ? [{ id: 'demo' }] : [] },
      async compositionInventory() { return [{ id: 'demo', rows: [row, { moduleName: 'external-mcp', enabled: true, fiberState: 5 }] }] },
    },
    effect(fn) { t.after(fn()) },
  }
  module.exports.apply(ctx)
  return { file, receipts, expected, local, row, setActive(value) { active = value },
    async check() { tick(); for (let index = 0; index < 3; index++) await new Promise(resolve => setImmediate(resolve)) },
    disposed: () => disposed }
}

test('只有挂载字节、Preset 组合和本地插件均就绪才写本进程回执，MCP 故障不成为装载前置条件', async t => {
  const f = observer(t)
  await f.check(); assert.equal(f.receipts.length, 0)
  f.local.fiber.state = 2
  await f.check(); assert.equal(f.receipts.length, 0)
  f.row.fiberState = 2; f.setActive(false)
  await f.check(); assert.equal(f.receipts.length, 0, '仅有 Preset 文档不等于实际组合已装载')
  f.setActive(true)
  await f.check(); assert.equal(f.receipts.length, 1)
  assert.equal(f.receipts[0].digest, f.expected.digest)
  assert.equal(f.receipts[0].files_digest, digest(f.expected.files))
  assert.equal(f.receipts[0].nonce, 'one-attempt')
  assert.equal(f.receipts[0].pid, 41)
  await f.check(); assert.equal(f.receipts.length, 1)
})

test('实际装载期间挂载字节变化不写成功回执', async t => {
  const f = observer(t)
  f.local.fiber.state = 2; f.row.fiberState = 2
  writeFileSync(f.file, 'changed during startup')
  await f.check(); assert.equal(f.receipts.length, 0)
})
