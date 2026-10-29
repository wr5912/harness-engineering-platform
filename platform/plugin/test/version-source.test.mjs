import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { versionSource, versionSources } from '../src/agents/version-source.ts'
import { assetText } from '../src/agents/asset-text.ts'

const id = 'EXP-test-agent-001'
const manifest = 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: test-agent\n  profile_patch: dsh/managed/test.patch.yml\ncredential_environment_keys: [TEST_TOKEN]\n'
test('版本当前解析不依赖登记，固定提交不借用工作树，历史登记仅从同一提交兼容', t => {
  const root = mkdtempSync(join(tmpdir(), 'version-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const exp = join(root, 'evolution/experiments', id)
  mkdirSync(join(exp, 'candidate'), { recursive: true })
  writeFileSync(join(exp, 'change.yaml'), `agent_id: test-agent\nexperiment_id: ${id}\n`)
  writeFileSync(join(exp, 'candidate/harness.yaml'), manifest)
  const git = args => {
    const value = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(value.status, 0, value.stderr)
    return value.stdout.trim()
  }
  git(['init']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  git(['add', '.']); git(['commit', '-m', 'version without registry'])
  const fixed = git(['rev-parse', 'HEAD'])
  assert.equal(versionSource(root, id, fixed).patch, 'test.patch.yml')
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'config/sources.json'), '{broken registry')
  assert.deepEqual(versionSource(root, id).optional_env_names, ['TEST_TOKEN'])
  writeFileSync(join(exp, 'candidate/harness.yaml'), manifest.replace('test.patch.yml', 'current.patch.yml'))
  assert.equal(versionSource(root, id, fixed).patch, 'test.patch.yml')
  writeFileSync(join(exp, 'candidate/harness.yaml'), 'name: old\n')
  writeFileSync(join(root, 'config/sources.json'), JSON.stringify({ sources: { [id]: { patch: 'old.patch.yml', preset: 'test-agent/old.yml', guard: null } } }))
  git(['add', '.']); git(['commit', '-m', 'historical registry'])
  const old = git(['rev-parse', 'HEAD'])
  assert.equal(versionSource(root, id, old).patch, 'old.patch.yml')
  assert.throws(() => versionSource(root, id), /缺少.*装载声明/)
  assert.ok(versionSources(root).errors[id])
  writeFileSync(join(exp, 'candidate/harness.yaml'), manifest.replace('dsh/managed/test.patch.yml', '../outside'))
  assert.throws(() => versionSource(root, id), /相对路径/)
  writeFileSync(join(exp, 'change.yaml'), 'agent_id: wrong-agent\nexperiment_id: wrong\n')
  assert.throws(() => versionSource(root, id), /身份不一致/)
})

test('源码变量引用原样可编辑，凭据常量只读且正文摘要与源码摘要分开', () => {
  const code = 'const authorization = `Bearer ${options.token}`;\n'
  const view = assetText('bridge.ts', code)
  assert.equal(view.content, code)
  assert.equal(view.editable, true)
  assert.equal(view.redacted, false)
  assert.equal(view.sha256, view.content_sha256)
  assert.equal(assetText('bridge.ts', "const token = '';\n").editable, true)
  const secret = 'Bearer fixture-secret-literal-12345'
  const masked = assetText('bridge.ts', `const authorization = '${secret}'`)
  assert.equal(masked.editable, false)
  assert.equal(masked.redacted, true)
  assert.notEqual(masked.sha256, masked.content_sha256)
  assert.equal(masked.content.includes(secret), false)
})
