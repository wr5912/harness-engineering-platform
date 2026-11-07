import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { documentOperation as operation } from '../src/agents/document-operations.ts'
import { sha256 } from '../src/tasks/files.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'document-operations-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
  write('README.md', '[说明](docs/old.md)\n')
  write('docs/old.md', '# 使用说明\n')
  return { root, write, call: (action, input) => operation(root, action, input), hash: path => sha256(readFileSync(join(root, path))) }
}
function changes(f) {
  return [{ kind: 'move', path: 'docs/old.md', to: 'docs/new.md', expected_sha256: f.hash('docs/old.md') },
    { kind: 'update', path: 'README.md', content: '[说明](docs/new.md)\n', expected_sha256: f.hash('README.md') }]
}

test('只读体检不建状态；移动与直接引用同批预览、执行、查询、幂等及恢复', t => {
  const f = fixture(t)
  f.write('docs/orphan.md', '可能被动态使用的文档。')
  const inspected = f.call('inspect', { path: 'docs' })
  assert.equal(inspected.complete, true)
  assert.equal(inspected.findings.find(row => row.path === 'docs/orphan.md').group, '需判断')
  assert.equal(existsSync(join(f.root, '.local')), false)
  const prepared = f.call('prepare', { changes: changes(f) })
  assert.equal(prepared.state, 'prepared'); assert.equal(existsSync(join(f.root, 'docs/old.md')), true)
  const receipt = f.call('apply', prepared.apply_input)
  assert.equal(receipt.state, 'applied'); assert.equal(existsSync(join(f.root, 'docs/old.md')), false)
  assert.match(readFileSync(join(f.root, 'README.md'), 'utf8'), /new.md/)
  assert.deepEqual(f.call('apply', prepared.apply_input), receipt)
  assert.equal(f.call('status', prepared.apply_input).state, 'applied')
  assert.equal(f.call('recover', prepared.apply_input).state, 'recovered')
  assert.equal(readFileSync(join(f.root, 'docs/old.md'), 'utf8'), '# 使用说明\n')
  assert.equal(existsSync(join(f.root, 'docs/new.md')), false)
})

test('直接引用和配置消费者不得悬空，摘要、目标冲突及并行恢复保护', t => {
  const f = fixture(t)
  assert.throws(() => f.call('prepare', { changes: [changes(f)[0]] }), /仍引用/)
  f.write('manifest.json', '{"entry":"docs/old.md"}')
  assert.throws(() => f.call('prepare', { changes: changes(f) }), /manifest.json/)
  rmSync(join(f.root, 'manifest.json'))
  const prepared = f.call('prepare', { changes: changes(f) })
  f.write('docs/consumer.md', '[新增引用](old.md)')
  assert.throws(() => f.call('apply', prepared.apply_input), /引用已变化/)
  rmSync(join(f.root, 'docs/consumer.md'))
  f.write('docs/new.md', '并行写入')
  assert.throws(() => f.call('prepare', { changes: changes(f) }), /不能覆盖/)
  rmSync(join(f.root, 'docs/new.md'))
  f.call('apply', prepared.apply_input)
  f.write('docs/new.md', '同事修改')
  assert.throws(() => f.call('recover', prepared.apply_input), /并行修改/)
  assert.equal(readFileSync(join(f.root, 'docs/new.md'), 'utf8'), '同事修改')
})

test('后项写入失败撤回先前修改，保留未涉及的文件', t => {
  const f = fixture(t)
  f.write('occupied', '这是文件，不是目录')
  const original = readFileSync(join(f.root, 'README.md'), 'utf8')
  const prepared = f.call('prepare', { changes: [
    { kind: 'update', path: 'README.md', content: original + '\n新增说明', expected_sha256: f.hash('README.md') },
    { kind: 'update', path: 'occupied/new.md', content: '无法写入', expected_sha256: null },
  ] })
  assert.throws(() => f.call('apply', prepared.apply_input))
  assert.equal(readFileSync(join(f.root, 'README.md'), 'utf8'), original)
  assert.equal(readFileSync(join(f.root, 'occupied'), 'utf8'), '这是文件，不是目录')
  assert.equal(f.call('status', prepared.apply_input).state, 'recovered')
})

test('专用事实源、HOME、符号链接、凭据不进入通用写入或扫描正文', t => {
  const f = fixture(t)
  symlinkSync(join(f.root, 'docs/old.md'), join(f.root, 'docs/alias.md'))
  f.write('config/key.md', '不读取')
  const inspected = f.call('inspect', { path: '.' })
  assert.ok(inspected.unscanned.some(row => row.path === 'docs/alias.md'))
  assert.ok(!inspected.scanned_files.includes('config/key.md'))
  for (const path of ['agents/alpha/evaluation.md', 'evolution/experiments/EXP-a/candidate/README.md', '.local/home/readme.md', '../escape.md', 'docs/alias.md', 'config/key.md']) {
    assert.throws(() => f.call('prepare', { changes: [{ kind: 'update', path, content: '改动', expected_sha256: null }] }))
  }
})
