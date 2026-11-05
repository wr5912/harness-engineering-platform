import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applyVersion027Migration, VERSION_027_MAPPING, version027MigrationPreview } from '../src/agents/version-migration.ts'
import { instanceDesiredSource, versionSource } from '../src/agents/version-source.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'version-migration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, content) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const git = args => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  const [main, partial, absent] = VERSION_027_MAPPING
  const source = `evolution/experiments/${main.from}`
  write(`${source}/change.yaml`, `agent_id: security-operations-expert\nexperiment_id: ${main.from}\n`)
  write(`${source}/candidate/harness.yaml`, 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: test-agent\n  profile_patch: dsh/managed/test.patch.yml\n')
  write(`${source}/candidate/dsh/workspace/AGENTS.md`, 'fixture rules\n')
  write(`${source}/runs/run-historical/observations.md`, `historical ${main.from}\n`)
  write(`evolution/experiments/${partial.from}/candidate/fragment.txt`, 'partial source\n')
  write('agents/security-operations-expert/manifest.yaml', `agent_id: security-operations-expert\nactive_experiment: ${main.from}\n`)
  write('config/sources.json', JSON.stringify({ sources: { [main.from]: { path: `${source}/candidate` }, [partial.from]: { path: 'historical' } } }))
  git(['add', '.']); git(['commit', '-m', 'fixed source'])
  return { root, write, git, main, partial, absent, source }
}

test('迁移只包含完整固定资产，残片和缺失版本不阻塞或被补造；历史可读且重试无写入', async t => {
  const { root, main, partial, absent, source } = fixture(t)
  const preview = version027MigrationPreview(root)
  assert.equal(preview.ready, true)
  assert.deepEqual(preview.mapping, [main])
  assert.deepEqual(preview.inventory.map(row => row.status), ['ready', 'partial', 'absent'])
  assert.ok(preview.writes.every(row => !('after' in row)))
  assert.ok(existsSync(join(root, source, 'candidate')))
  const result = await applyVersion027Migration(root, { confirmed: true, expected_plan_sha256: preview.plan_sha256 })
  assert.equal(result.migrated, true)
  assert.equal(existsSync(join(root, source, 'candidate')), false)
  assert.equal(existsSync(join(root, `evolution/experiments/${partial.to}`)), false)
  assert.equal(existsSync(join(root, `evolution/experiments/${absent.to}`)), false)
  assert.equal(versionSource(root, main.from, preview.source_ref.slice(4)).agent_id, 'security-operations-expert')
  assert.equal(versionSource(root, main.to).agent_id, 'security-operations-expert')
  assert.equal(instanceDesiredSource(root, { source_id: `experiment:${main.from}` }), `experiment:${main.to}`)
  assert.equal(instanceDesiredSource(root, { source_id: `experiment:${main.from}`, source_ref: preview.source_ref }), `experiment:${main.from}`)
  assert.equal(readFileSync(join(root, source, 'runs/run-historical/observations.md'), 'utf8'), `historical ${main.from}\n`)
  const config = JSON.parse(readFileSync(join(root, 'config/sources.json'), 'utf8'))
  assert.equal(config.sources[main.to].path, `evolution/experiments/${main.to}/candidate`)
  assert.deepEqual(config.sources[partial.from], { path: 'historical' })
  const repeated = version027MigrationPreview(root)
  assert.equal(repeated.ready, true)
  assert.deepEqual(repeated.moves, [])
  assert.deepEqual(repeated.writes, [])
  assert.equal((await applyVersion027Migration(root, { confirmed: true, expected_plan_sha256: repeated.plan_sha256 })).migrated, false)
})

test('未提交资产和目标冲突在预检中明确阻塞，不能执行或重写来源', async t => {
  const { root, write, main, source } = fixture(t)
  write(`${source}/candidate/dsh/workspace/AGENTS.md`, 'parallel draft\n')
  let plan = version027MigrationPreview(root)
  assert.equal(plan.ready, false)
  assert.equal(plan.inventory[0].status, 'blocked')
  assert.match(plan.inventory[0].reason, /并行修改/)
  await assert.rejects(applyVersion027Migration(root, { confirmed: true, expected_plan_sha256: plan.plan_sha256 }), /预检未通过/)
  assert.equal(readFileSync(join(root, source, 'candidate/dsh/workspace/AGENTS.md'), 'utf8'), 'parallel draft\n')
  write(`evolution/experiments/${main.to}/existing.txt`, 'existing target\n')
  plan = version027MigrationPreview(root)
  assert.match(plan.inventory[0].reason, /目标已存在/)
})

test('预览后引用变化拒绝执行，不移动 Candidate', async t => {
  const { root, write, source } = fixture(t)
  const plan = version027MigrationPreview(root)
  write('config/sources.json', '{}')
  await assert.rejects(applyVersion027Migration(root, { confirmed: true, expected_plan_sha256: plan.plan_sha256 }), /重新预览/)
  assert.ok(existsSync(join(root, source, 'candidate')))
})
