import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DEFAULT_LIMITS, decodeMountPath, fileSnapshot } from './tree-digest.mjs'

const adapter = fileURLToPath(new URL('.', import.meta.url))
test('Node and Python produce the same exact mount tree digest', () => {
  const candidate = mkdtempSync(join(tmpdir(), 'dsh-mount-identity-'))
  try {
    for (const name of ['workspace', 'presets', 'managed']) {
      const root = join(candidate, name)
      mkdirSync(join(root, '中文 子目录'), { recursive: true })
      writeFileSync(join(root, 'z.txt'), '基础模拟数据\n')
      writeFileSync(join(root, '中文 子目录', 'a.bin'), Buffer.from([0, 1, 127, 255]))
      chmodSync(join(root, 'z.txt'), 0o755)
      const nodeDigest = fileSnapshot(root).tree_sha256
      const pythonDigest = execFileSync(process.env.HARNESS_PYTHON ?? 'python3', ['-c', [
        'import runpy,sys', 'from pathlib import Path',
        'sys.path.insert(0,sys.argv[1])',
        'module=runpy.run_path(str(Path(sys.argv[1])/"mutation-receipt.py"))',
        'root=Path(sys.argv[2])',
        'print(module["snapshot"](root,allowed_roots={root})["tree_sha256"])',
      ].join('\n'), adapter, root], {
        encoding: 'utf8',
      }).trim()
      assert.equal(nodeDigest, pythonDigest)
    }
  } finally { rmSync(candidate, { recursive: true, force: true }) }
})

test('Linux mountinfo escapes are decoded before exact target matching', () => {
  assert.equal(decodeMountPath('/work/harness/workspace'), '/work/harness/workspace')
  assert.equal(decodeMountPath('/work/space\\040name'), '/work/space name')
  assert.equal(decodeMountPath('/path\\134slash'), '/path\\slash')
})

test('source lock contains no fabricated registry image digest', () => {
  const lock = JSON.parse(readFileSync(`${adapter}/source.lock.json`, 'utf8'))
  assert.equal('registry_digest' in lock, false)
  assert.equal('local_image_id' in lock, false)
})

test('a sparse file over 64 MiB is rejected before content buffering', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-limit-'))
  try {
    const asset = join(root, 'oversized.bin')
    writeFileSync(asset, '')
    truncateSync(asset, DEFAULT_LIMITS.maxFileBytes + 1)
    assert.throws(() => fileSnapshot(root), /64 MiB limit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('total bytes, depth, and nodes fail closed under narrowed test limits', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-limits-'))
  try {
    writeFileSync(join(root, 'a.txt'), '12345')
    writeFileSync(join(root, 'b.txt'), '12345')
    assert.throws(() => fileSnapshot(root, { maxFileBytes: 5, maxTotalBytes: 8 }), /total byte limit/)
    assert.throws(() => fileSnapshot(root, { maxNodes: 2 }), /node limit/)
    mkdirSync(join(root, 'one/two/three'), { recursive: true })
    assert.throws(() => fileSnapshot(root, { maxDepth: 2 }), /depth limit/)
    assert.throws(() => fileSnapshot(root, { maxFileBytes: DEFAULT_LIMITS.maxFileBytes + 1 }), /cannot be widened/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the default 256-level directory bound rejects level 257', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-deep-'))
  try {
    let folder = root
    for (let index = 0; index < DEFAULT_LIMITS.maxDepth + 1; index++) {
      folder = join(folder, 'd')
      mkdirSync(folder)
    }
    assert.throws(() => fileSnapshot(root), /depth limit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('special mode bits are retained in the canonical digest', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-mode-'))
  try {
    const asset = join(root, 'mode.txt')
    writeFileSync(asset, 'x')
    chmodSync(asset, 0o1755)
    const record = [{
      mode: '1755',
      path: 'mode.txt',
      sha256: createHash('sha256').update('x').digest('hex'),
      size: 1,
    }]
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(record)).digest('hex')}`
    assert.equal(fileSnapshot(root).tree_sha256, expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
