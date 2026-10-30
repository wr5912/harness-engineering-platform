import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const checker = fileURLToPath(new URL('./check_inheritance.mts', import.meta.url))

test('固定 Git 来源的缺失文件失败，同路径修改需要审查', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-inheritance-'))
  const source = 'EXP-example-agent-001'
  const target = 'EXP-example-agent-002'
  const sourceDir = join(root, 'evolution', 'experiments', source, 'candidate')
  const targetDir = join(root, 'evolution', 'experiments', target, 'candidate')
  try {
    mkdirSync(sourceDir, { recursive: true })
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(sourceDir, 'a.txt'), 'old')
    writeFileSync(join(sourceDir, 'b.txt'), 'keep')
    writeFileSync(join(sourceDir, '../change.yaml'), `experiment_id: ${source}\nagent_id: example-agent\n`)
    writeFileSync(join(targetDir, 'a.txt'), 'new')
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'source'], { cwd: root })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const run = () => spawnSync(process.execPath, ['--experimental-strip-types', checker, source, commit, target], { cwd: root, encoding: 'utf8' })
    const missing = run()
    assert.equal(missing.status, 1, missing.stderr)
    assert.match(missing.stdout, /缺失 b\.txt/)
    assert.match(missing.stdout, /需审查 a\.txt/)
    writeFileSync(join(targetDir, 'b.txt'), 'keep')
    const changed = run()
    assert.equal(changed.status, 1, changed.stderr)
    assert.match(changed.stdout, /缺失 0；内容变化 1/)
    writeFileSync(join(targetDir, 'a.txt'), 'old')
    const identical = run()
    assert.equal(identical.status, 0, identical.stderr)
    assert.match(identical.stdout, /缺失 0；内容变化 0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('普通 EXP 可完整继承到 VAR；VAR 和历史 EXP 变体按固定提交拒绝继承', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-variant-inheritance-'))
  const source = 'EXP-example-agent-001-r0123456789ab'
  const target = 'VAR-example-agent-002-r0123456789ab'
  const sourceDir = join(root, 'evolution', 'experiments', source)
  const targetDir = join(root, 'evolution', 'experiments', target)
  const change = id => `experiment_id: ${id}\nagent_id: example-agent\n`
  const commit = () => {
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'source'], { cwd: root })
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  }
  const run = (id, ref, destination = target) => spawnSync(process.execPath, ['--experimental-strip-types', checker, id, ref, destination], { cwd: root, encoding: 'utf8' })
  try {
    mkdirSync(join(sourceDir, 'candidate'), { recursive: true })
    mkdirSync(join(targetDir, 'candidate'), { recursive: true })
    writeFileSync(join(sourceDir, 'candidate/workflow.ts'), 'export const value = "same bytes"\n')
    writeFileSync(join(targetDir, 'candidate/workflow.ts'), 'export const value = "same bytes"\n')
    writeFileSync(join(sourceDir, 'change.yaml'), change(source))
    writeFileSync(join(targetDir, 'change.yaml'), change(target) + 'compute_variant: {kind: medium}\n')
    execFileSync('git', ['init', '-q'], { cwd: root })
    const ordinaryCommit = commit()
    const ordinary = run(source, ordinaryCommit)
    assert.equal(ordinary.status, 0, ordinary.stderr)
    assert.match(ordinary.stdout, /缺失 0；内容变化 0/)
    writeFileSync(join(sourceDir, 'change.yaml'), change(source) + 'compute_variant: {kind: medium}\n')
    const currentVariant = run(source, ordinaryCommit)
    assert.equal(currentVariant.status, 2, currentVariant.stderr)
    assert.match(currentVariant.stderr, /变体不能作为新版本的继承来源/)
    const legacyCommit = commit()
    writeFileSync(join(sourceDir, 'change.yaml'), change(source))
    const legacy = run(source, legacyCommit)
    assert.equal(legacy.status, 2, legacy.stderr)
    assert.match(legacy.stderr, /变体不能作为新版本的继承来源/)
    const variant = run(target, ordinaryCommit, source)
    assert.equal(variant.status, 2, variant.stderr)
    assert.match(variant.stderr, /变体不能作为新版本的继承来源/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
