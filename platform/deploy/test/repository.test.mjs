import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const result = snapshotRepository(source, snapshot, bundle)
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
