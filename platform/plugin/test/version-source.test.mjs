import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { versionSource, versionSources } from '../src/agents/version-source.ts'
import { assetText } from '../src/agents/asset-text.ts'
import { VERSION_ID, isVariantIdentity } from '../src/version-id.ts'

const id = 'EXP-test-agent-001'
const manifest = 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: test-agent\n  profile_patch: dsh/managed/test.patch.yml\ncredential_environment_keys: [TEST_TOKEN]\n'
test('EXP与VAR共享来源读取并保留Agent捕获，VAR必须声明变体计划', t => {
  const root = mkdtempSync(join(tmpdir(), 'variant-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const variant = 'VAR-test-agent-001-r123456abcdef', exp = join(root, 'evolution/experiments', variant)
  assert.equal(VERSION_ID.exec(variant)[1], 'test-agent')
  assert.equal(VERSION_ID.exec(variant)[2], '001')
  mkdirSync(join(exp, 'candidate'), { recursive: true })
  writeFileSync(join(exp, 'candidate/harness.yaml'), manifest)
  const identity = `agent_id: test-agent\nexperiment_id: ${variant}\n`
  writeFileSync(join(exp, 'change.yaml'), identity)
  assert.throws(() => versionSource(root, variant), /必须声明 compute_variant/)
  writeFileSync(join(exp, 'change.yaml'), identity + 'compute_variant: {strategy: 保留查询}\n')
  assert.equal(versionSource(root, variant).agent_id, 'test-agent')
  assert.ok(versionSources(root).sources[variant])
  assert.equal(isVariantIdentity(variant), true)
  assert.equal(isVariantIdentity(id), false)
  for (const metadata of [{ compute_variant: {} }, { variant_kind: 'exploratory' }, { variant_kind: 'end' }, { kind: 'end' }, { variant: 'end' }]) assert.equal(isVariantIdentity(id, metadata), true)
})

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

test('完整Candidate的约定Profile从同一版本补齐，显式错误不退回，固定提交不借当前文件', t => {
  const root = mkdtempSync(join(tmpdir(), 'version-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const exp = join(root, 'evolution/experiments', id), managed = join(exp, 'candidate/dsh/managed')
  mkdirSync(managed, { recursive: true })
  writeFileSync(join(exp, 'change.yaml'), `agent_id: test-agent\nexperiment_id: ${id}\n`)
  const file = join(exp, 'candidate/harness.yaml'), profile = join(managed, 'web-profile.package.json')
  writeFileSync(file, manifest)
  const git = args => {
    const value = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(value.status, 0, value.stderr); return value.stdout.trim()
  }
  git(['init']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  git(['add', '.']); git(['commit', '-m', 'without profile'])
  const absent = git(['rev-parse', 'HEAD'])
  assert.equal(versionSource(root, id).profile_manifest, undefined)
  writeFileSync(profile, '{"dsh":{"profile":{"bundles":["candidate-profile"]}}}')
  writeFileSync(join(managed, 'web-profile.seed.patch.yml'), '- id: candidate-mcp-provider\n')
  git(['add', '.']); git(['commit', '-m', 'complete candidate with conventional profile'])
  const present = git(['rev-parse', 'HEAD']), expected = `evolution/experiments/${id}/candidate/dsh/managed/web-profile.package.json`
  assert.equal(versionSource(root, id).profile_manifest, expected)
  assert.equal(versionSource(root, id, absent).profile_manifest, undefined)
  rmSync(profile)
  assert.equal(versionSource(root, id).profile_manifest, undefined)
  assert.equal(versionSource(root, id, present).profile_manifest, expected)
  for (const value of ['""', 'null', '../outside']) {
    writeFileSync(file, manifest.replace('  profile_patch:', `  profile_manifest: ${value}\n  profile_patch:`))
    assert.throws(() => versionSource(root, id), /相对路径/)
  }
  writeFileSync(file, manifest)
  symlinkSync(join(managed, 'web-profile.seed.patch.yml'), profile)
  assert.throws(() => versionSource(root, id), /符号链接/)
})

test('SDK来源使用版本声明及自身Profile，旧版本保持Web，未知模式不静默回退', t => {
  const root = mkdtempSync(join(tmpdir(), 'version-sdk-profile-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const exp = join(root, 'evolution/experiments', id), managed = join(exp, 'candidate/dsh/managed')
  mkdirSync(managed, { recursive: true })
  writeFileSync(join(exp, 'change.yaml'), `agent_id: test-agent\nexperiment_id: ${id}\n`)
  const file = join(exp, 'candidate/harness.yaml')
  writeFileSync(file, manifest)
  assert.equal(versionSource(root, id).profile, 'web')
  writeFileSync(join(managed, 'web-profile.package.json'), '{}')
  writeFileSync(join(managed, 'sdk-profile.package.json'), '{}')
  writeFileSync(file, manifest.replace('loadable_assets:\n', 'loadable_assets:\n  profile: sdk\n'))
  const source = versionSource(root, id)
  assert.equal(source.profile, 'sdk')
  assert.equal(source.profile_manifest, `evolution/experiments/${id}/candidate/dsh/managed/sdk-profile.package.json`)
  writeFileSync(file, manifest.replace('loadable_assets:\n', 'loadable_assets:\n  profile: headless\n'))
  assert.throws(() => versionSource(root, id), /只支持 web 或 sdk/)
})
