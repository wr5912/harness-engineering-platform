import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { run } from '../fsutil.mts'
import { restoreRepository, snapshotRepository } from '../repository.mts'

test('仓库快照保留历史和 origin，排除工作树改动；安装不覆盖路径映射', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-repository-'))
  try {
    const source = join(root, 'source'), snapshot = join(root, 'snapshot'), installed = join(root, 'installed')
    mkdirSync(source)
    const git = (...args) => run('git', ['-C', source, ...args]).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://example.invalid/repository.git')
    writeFileSync(join(source, 'asset'), 'first')
    git('add', '.'); git('commit', '-m', 'first')
    writeFileSync(join(source, 'asset'), 'second')
    git('commit', '-am', 'second')
    writeFileSync(join(source, 'asset'), 'uncommitted')
    writeFileSync(join(source, 'local-cache'), 'excluded')
    const bundle = join(root, 'repository.bundle')
    const previousMask = process.umask(0o077)
    let result
    try {
      result = snapshotRepository(source, snapshot, bundle)
      assert.equal(process.umask(), 0o077)
    } finally { process.umask(previousMask) }
    assert.equal(statSync(snapshot).mode & 0o777, 0o755)
    assert.equal(statSync(join(snapshot, 'asset')).mode & 0o777, 0o644)
    assert.equal(result.dirty, true)
    assert.equal(readFileSync(join(snapshot, 'asset'), 'utf8'), 'second')
    assert.equal(run('git', ['-C', snapshot, 'rev-list', '--count', 'HEAD']).trim(), '2')
    mkdirSync(installed)
    writeFileSync(join(installed, 'asset'), 'remapped')
    restoreRepository(installed, bundle, result.commit, result.origin)
    assert.equal(readFileSync(join(installed, 'asset'), 'utf8'), 'remapped')
    assert.equal(run('git', ['-C', installed, 'remote', 'get-url', 'origin']).trim(), result.origin)
    assert.equal(run('git', ['-C', installed, 'rev-parse', 'HEAD']).trim(), result.commit)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('当前工作树快照包含增改删、链接和可执行权限，排除忽略文件并保留 Git 基线', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-working-tree-'))
  try {
    const source = join(root, 'source'), target = join(root, 'snapshot')
    mkdirSync(source)
    const git = (...args) => run('git', ['-C', source, ...args]).trim()
    git('init', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', 'https://example.invalid/repository.git')
    writeFileSync(join(source, '.gitignore'), '.local/\n*.llm-api-key\n')
    writeFileSync(join(source, 'changed'), 'old'); writeFileSync(join(source, 'deleted'), 'old')
    mkdirSync(join(source, 'replaced-directory')); writeFileSync(join(source, 'replaced-directory/asset'), 'old')
    git('add', '.'); git('commit', '-m', 'baseline')
    const baseline = git('rev-parse', 'HEAD')
    writeFileSync(join(source, 'changed'), 'new'); rmSync(join(source, 'deleted'))
    writeFileSync(join(source, 'added'), 'new'); chmodSync(join(source, 'added'), 0o755)
    symlinkSync('added', join(source, 'linked'))
    const external = join(root, 'external')
    mkdirSync(external); writeFileSync(join(external, 'asset'), 'external')
    rmSync(join(source, 'replaced-directory'), { recursive: true }); symlinkSync(external, join(source, 'replaced-directory'))
    mkdirSync(join(source, '.local')); writeFileSync(join(source, '.local/cache'), 'excluded')
    writeFileSync(join(source, 'model.llm-api-key'), 'fixture-key')
    const result = snapshotRepository(source, target, join(root, 'repository.bundle'), true)
    assert.equal(result.commit, baseline); assert.equal(result.dirty, true)
    assert.equal(readFileSync(join(target, 'changed'), 'utf8'), 'new')
    assert.equal(readFileSync(join(target, 'added'), 'utf8'), 'new')
    assert.equal(statSync(join(target, 'added')).mode & 0o777, 0o755)
    assert.equal(readlinkSync(join(target, 'linked')), 'added')
    assert.equal(readlinkSync(join(target, 'replaced-directory')), external)
    assert.equal(readFileSync(join(external, 'asset'), 'utf8'), 'external')
    for (const name of ['deleted', '.local', 'model.llm-api-key']) assert.equal(existsSync(join(target, name)), false)
    assert.equal(run('git', ['-C', target, 'rev-parse', 'HEAD']).trim(), baseline)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('浅克隆离线快照保留提交、标签和历史边界，可在无原仓库时恢复', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-shallow-repository-'))
  try {
    const upstream = join(root, 'upstream'), source = join(root, 'source')
    mkdirSync(upstream)
    const git = (...args) => run('git', ['-C', upstream, ...args]).trim()
    git('init', '-b', 'main'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(upstream, 'asset'), 'first'); git('add', '.'); git('commit', '-m', 'first')
    writeFileSync(join(upstream, 'asset'), 'second'); git('commit', '-am', 'second'); git('tag', 'v2')
    run('git', ['clone', '--quiet', '--depth', '1', `file://${upstream}`, source])
    const bundle = join(root, 'repository.bundle'), snapshot = join(root, 'snapshot')
    const result = snapshotRepository(source, snapshot, bundle)
    assert.equal(readFileSync(join(snapshot, 'asset'), 'utf8'), 'second')
    assert.equal(run('git', ['-C', snapshot, 'rev-parse', '--is-shallow-repository']).trim(), 'true')
    rmSync(source, { recursive: true }); rmSync(upstream, { recursive: true })
    const installed = join(root, 'installed'); mkdirSync(installed)
    restoreRepository(installed, bundle, result.commit, result.origin, true)
    assert.equal(run('git', ['-C', installed, 'rev-parse', 'HEAD']).trim(), result.commit)
    assert.equal(run('git', ['-C', installed, 'rev-parse', 'v2']).trim(), result.commit)
    assert.equal(run('git', ['-C', installed, 'rev-list', '--count', 'HEAD']).trim(), '1')
    run('git', ['-C', installed, 'fsck', '--no-reflogs'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
