import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { run } from '../fsutil.mts'
import { restoreRepository } from '../repository.mts'
import { packWorkspace, workspaceTargets } from '../workspace.mts'

test('五仓快照保留业务 tags、独立 HOME 和现场状态，HEAD 模式不混入 Harness 改动', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-five-repos-'))
  const write = (path, content) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content) }
  const git = (path, ...args) => run('git', ['-C', path, ...args]).trim()
  const repository = (path, files, remote = 'origin') => {
    mkdirSync(path, { recursive: true }); git(path, 'init', '-b', 'main')
    git(path, 'config', 'user.name', 'fixture'); git(path, 'config', 'user.email', 'fixture@example.invalid')
    git(path, 'remote', 'add', remote, 'https://example.invalid/' + remote + '.git')
    for (const [file, content] of Object.entries(files)) write(join(path, file), content)
    git(path, 'add', '.'); git(path, 'commit', '-m', 'baseline')
  }
  try {
    const home = join(root, 'platform-manager-dsh-home'), business = join(root, 'manager-workspace/business-agents')
    repository(root, { '.hep-lab/sources.json': '{}', '.gitignore': 'harness-engineering-platform/\nplatform-manager-dsh-home/\nmanager-workspace/\nstaging/\n' })
    repository(home, { 'profiles/harness-platform/package.json': '{}', 'AGENTS.md': 'committed', '.gitignore': '.credentials.yaml\nsessions/\nnode_modules/\n' })
    repository(business, { 'agents/example/harness.yaml': 'native' }, 'gitlab')
    git(business, 'tag', '-a', 'example-v1', '-m', 'release')
    write(join(home, 'AGENTS.md'), 'uncommitted')
    write(join(home, '.credentials.yaml'), 'fixture-secret')
    write(join(home, 'sessions/saved.json'), '{}')
    write(join(home, 'node_modules/excluded'), 'cache')
    const staging = join(root, 'staging'), data = join(root, 'manager-workspace/harness-engineering-platform-data')
    const previous = process.env.HARNESS_MANAGER_DSH_HOME
    process.env.HARNESS_MANAGER_DSH_HOME = home
    let workspace
    try { workspace = packWorkspace(join(root, 'harness-engineering-platform'), data, staging) }
    finally { if (previous === undefined) delete process.env.HARNESS_MANAGER_DSH_HOME; else process.env.HARNESS_MANAGER_DSH_HOME = previous }
    assert.deepEqual(workspace.repositories.map(repo => repo.name), ['control', 'manager-home', 'business'])
    const targetHome = join(staging, 'workspace/platform-manager-dsh-home')
    assert.equal(readFileSync(join(targetHome, 'AGENTS.md'), 'utf8'), 'committed')
    assert.equal(readFileSync(join(targetHome, '.credentials.yaml'), 'utf8'), 'fixture-secret')
    assert.ok(existsSync(join(targetHome, 'sessions/saved.json')))
    assert.ok(!existsSync(join(targetHome, 'node_modules')))
    const target = join(staging, 'workspace/manager-workspace/business-agents'), info = workspace.repositories[2]
    restoreRepository(target, join(staging, 'repositories/business.bundle'), info.commit, info.origin)
    assert.equal(git(target, 'tag', '--list'), 'example-v1')
    assert.equal(git(target, 'status', '--porcelain'), '')
    assert.equal(git(target, 'remote', 'get-url', 'origin'), info.origin)
    assert.equal(workspaceTargets({ workspace }, '/opt/hep/harness-engineering-platform', '/opt/hep/manager-workspace/harness-engineering-platform-data').root, '/opt/hep')
    assert.throws(() => workspaceTargets({ workspace }, '/opt/hep/harness-engineering-platform', '/other/data'), /五仓包的数据目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
