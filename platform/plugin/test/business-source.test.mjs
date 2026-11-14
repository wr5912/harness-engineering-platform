import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { businessList, businessListAsync, businessRead, businessSource, runtimeSource, businessAsset, businessEdit } from '../src/agents/business-source.ts'
import { candidateDigest, sourceInfo } from '../src/tasks/files.ts'

test('业务目录是主线事实源，Git 和工作树变化可区分，Git tag 只读且旧研究来源停用', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const data = join(root, 'data'), business = join(root, 'business'), agent = join(business, 'agents/test-agent')
  mkdirSync(join(data, 'config'), { recursive: true })
  writeFileSync(join(data, 'config/repositories.json'), JSON.stringify({ repositories: [{ id: 'business-agents', path: business }] }))
  mkdirSync(agent, { recursive: true })
  writeFileSync(join(business, 'manifest.yaml'), 'agents:\n- {agent_id: test-agent, path: agents/test-agent, status: active}\n- {agent_id: retired, path: agents/retired, status: archived}\n')
  const harness = 'agent: {id: test-agent, name: 当前业务}\nloadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: test-agent\n  profile_patch: dsh/managed/main.patch.yml\n'
  writeFileSync(join(agent, 'harness.yaml'), harness)
  const git = args => { const value = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: business, encoding: 'utf8' }); assert.equal(value.status, 0, value.stderr); return value.stdout.trim() }
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']); git(['add', '.']); git(['commit', '-m', 'business main'])
  const commit = git(['rev-parse', 'HEAD']), list = businessList(data)
  assert.deepEqual(list.errors, {}); assert.equal(list.agents.length, 1)
  assert.deepEqual(await businessListAsync(data), list)
  const current = list.agents[0]
  assert.equal(current.commit, commit); assert.equal(current.asset_commit, commit); assert.equal(current.dirty, false)
  assert.equal(current.path, agent); assert.equal(current.digest, `sha256:${candidateDigest(agent)}`)
  assert.equal(runtimeSource(data, 'business:test-agent').candidate_root, 'agents/test-agent/dsh')
  const pinned = runtimeSource(data, `business:test-agent@${commit}`, commit)
  assert.equal(pinned.source_id, `business:test-agent@${commit}`)
  assert.equal(pinned.source_commit, commit)
  assert.equal(pinned.candidate_root, 'agents/test-agent/dsh')
  assert.equal(businessSource(data, 'test-agent').repository_root, business)
  assert.equal(sourceInfo(data, `business:test-agent@${commit}`).candidate, agent)
  assert.equal(sourceInfo(data, `business:test-agent@${commit}`).source, `business:test-agent@${commit}`)
  assert.equal(businessRead(data, 'test-agent', 'harness.yaml').content, harness)
  writeFileSync(join(agent, 'harness.yaml'), harness.replace('当前业务', '工作树修改'))
  const changed = businessList(data).agents[0]
  assert.equal(changed.commit, commit); assert.equal(changed.dirty, true); assert.notEqual(changed.digest, current.digest)
  const experiment = join(data, 'evolution/experiments/EXP-test-agent-001')
  mkdirSync(join(experiment, 'candidate'), { recursive: true })
  writeFileSync(join(experiment, 'change.yaml'), 'agent_id: test-agent\nexperiment_id: EXP-test-agent-001\n')
  writeFileSync(join(experiment, 'candidate/harness.yaml'), harness.replace('main.patch.yml', 'research.patch.yml'))
  assert.throws(() => runtimeSource(data, 'experiment:EXP-test-agent-001'), /研究版本已停用/)
  assert.equal(runtimeSource(data, 'business:test-agent').patch, 'main.patch.yml')
  assert.throws(() => runtimeSource(data, 'business:test-agent', commit), /固定提交/)
  git(['tag', 'release/v1'])
  assert.deepEqual(await businessListAsync(data), businessList(data))
  const tagged = businessList(data).agents[0].versions[0]
  assert.equal(tagged.tag, 'release/v1')
  assert.equal(tagged.source_id, 'business:test-agent@release%2Fv1')
  assert.equal(businessRead(data, tagged.source_id, 'harness.yaml').content, harness)
  assert.equal(runtimeSource(data, tagged.source_id, commit).source_commit, commit)
  const immutable = businessAsset(data, tagged.source_id, 'harness.yaml')
  assert.equal(immutable.editable, false)
  assert.throws(() => businessEdit(data, tagged.source_id, [{path: 'harness.yaml', content: harness, expected_sha256: immutable.sha256}]), /只读/)
  const original = businessAsset(data, 'business:test-agent', 'harness.yaml')
  const edits = [{path: original.path, content: harness, expected_sha256: original.sha256}]
  businessEdit(data, 'business:test-agent', edits, true)
  assert.match(businessRead(data, 'test-agent', 'harness.yaml').content, /工作树修改/)
  businessEdit(data, 'business:test-agent', edits)
  assert.equal(businessRead(data, 'test-agent', 'harness.yaml').content, harness)
  assert.throws(() => businessEdit(data, 'business:test-agent', edits), /资产已变化/)
  assert.throws(() => businessRead(data, 'test-agent', '../other'), /不在业务/)

})
