import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inventory, run } from './query.mjs'

test('只列出符合身份格式的真实资产目录并稳定排序', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-asset-query-'))
  try {
    mkdirSync(join(root, 'agents', 'second-agent'), { recursive: true })
    mkdirSync(join(root, 'agents', 'first-agent'), { recursive: true })
    mkdirSync(join(root, 'agents', 'Invalid_Name'))
    mkdirSync(join(root, 'evolution', 'experiments', 'EXP-first-agent-002'), { recursive: true })
    mkdirSync(join(root, 'evolution', 'experiments', 'EXP-first-agent-001'))
    mkdirSync(join(root, 'evolution', 'experiments', 'EXP-first-agent-003-r123456789abc'))
    mkdirSync(join(root, 'evolution', 'experiments', 'EXP-first-agent-004-rinvalid'))
    for (const id of ['EXP-first-agent-001', 'EXP-first-agent-002', 'EXP-first-agent-003-r123456789abc']) {
      writeFileSync(join(root, 'evolution', 'experiments', id, 'change.yaml'), 'schema_version: "1.0"\n')
    }
    assert.deepEqual(inventory(root), {
      schema_version: '1.0',
      agents: ['first-agent', 'second-agent'],
      experiments: ['EXP-first-agent-001', 'EXP-first-agent-002', 'EXP-first-agent-003-r123456789abc'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('已删除但仅剩 Git 忽略产物的 Experiment 不计入清单', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-asset-query-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n__pycache__/\n')
    const base = join(root, 'evolution', 'experiments')
    mkdirSync(join(base, 'EXP-first-agent-001'), { recursive: true })
    writeFileSync(join(base, 'EXP-first-agent-001', 'change.yaml'), 'schema_version: "1.0"\n')
    mkdirSync(join(base, 'EXP-first-agent-002', 'candidate', 'node_modules'), { recursive: true })
    writeFileSync(join(base, 'EXP-first-agent-002', 'candidate', 'node_modules', 'cache.js'), '')
    mkdirSync(join(base, 'EXP-first-agent-003', '__pycache__'), { recursive: true })
    writeFileSync(join(base, 'EXP-first-agent-003', '__pycache__', 'cache.pyc'), '')
    assert.deepEqual(inventory(root).experiments, ['EXP-first-agent-001'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('有 Git 可见文件但缺少 change.yaml 的 Experiment 明确失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-asset-query-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: root })
    const path = 'evolution/experiments/EXP-first-agent-001/hypothesis.md'
    mkdirSync(join(root, 'evolution', 'experiments', 'EXP-first-agent-001'), { recursive: true })
    writeFileSync(join(root, path), '# hypothesis\n')
    assert.throws(() => inventory(root), /缺少 change.yaml/)
    execFileSync('git', ['add', '--', path], { cwd: root })
    rmSync(join(root, path))
    assert.throws(() => inventory(root), /缺少 change.yaml/)
    assert.match(run(['inventory'], root).output, /EXPERIMENT_MANIFEST_MISSING/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('帮助和参数错误均不依赖资产目录', () => {
  assert.equal(run(['--help'], undefined).exitCode, 0)
  assert.equal(run(['unexpected'], undefined).exitCode, 2)
  assert.equal(run(['inventory'], undefined).exitCode, 1)
})

test('缺少资产目录时返回空清单，不虚构 Agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-asset-query-'))
  try {
    const result = run(['inventory'], root)
    assert.equal(result.exitCode, 0)
    assert.deepEqual(JSON.parse(result.output), { schema_version: '1.0', agents: [], experiments: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('错误的根路径不能伪装成空资产清单', () => {
  const result = run(['inventory'], join(tmpdir(), 'nonexistent-harness-root-for-test'))
  assert.equal(result.exitCode, 1)
  assert.match(result.output, /ENOENT/)
})
