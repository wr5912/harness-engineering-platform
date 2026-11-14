import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { resolvePreparedAssetDependencies, createAssetDependenciesHandler } from '../src/agents/asset-dependencies.ts'
import { businessSource } from '../src/agents/business-source.ts'
import { runtimeDependencies } from '../../deploy/agent/dependencies.mts'

const programRoot = new URL('../../../', import.meta.url).pathname
process.env.HARNESS_PROGRAM_ROOT = programRoot
function fixture(t, manifest = { dependencies: { 'pinyin-pro': '^3.29.0' } }) {
  const root = mkdtempSync(join(tmpdir(), 'standard-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const data = join(root, 'data'), business = join(root, 'business'), candidate = join(business, 'agents/demo')
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  put(join(data, 'config/repositories.json'), JSON.stringify({ repositories: [{ id: 'business-agents', path: business }] }))
  put(join(business, 'manifest.yaml'), 'agents:\n- {agent_id: demo, path: agents/demo, status: active}\n')
  put(join(candidate, 'harness.yaml'), 'agent: {id: demo}\nloadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: demo\n  profile_patch: dsh/managed/demo.patch.yml\n')
  put(join(candidate, 'dsh/managed/voice/package.json'), JSON.stringify(manifest))
  const git = spawnSync('git', ['init', '-b', 'main'], { cwd: business, encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  return { data, candidate, put, snapshot: { candidate, dependencies: [{ kind: 'node', path: 'managed/voice', dependencies: Object.keys(manifest.dependencies ?? manifest.optionalDependencies ?? {}) }] } }
}

test('实例和独立包使用相同标准依赖，无宿主回执时也可运行', async t => {
  const f = fixture(t)
  const managed = resolvePreparedAssetDependencies(f.data, 'business:demo', {}, f.candidate)
  assert.equal(managed.status, 'ready', managed.reasons.join(';'))
  assert.deepEqual(managed.mounts, []); assert.deepEqual(managed.environment, {})
  assert.equal(runtimeDependencies({ programRoot }, f.snapshot)[0].ready, true)
  const result = await createAssetDependenciesHandler(f.data, { command: () => assert.fail('不得运行安装器') })({ experiment_id: 'business:demo' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(existsSync(join(f.data, '.local/asset-dependencies')), false)
})

test('修改业务 Harness 后两条路径继续复用标准 Runtime，不要求依赖回执或重建', async t => {
  const f = fixture(t)
  const before = resolvePreparedAssetDependencies(f.data, 'business:demo', {}, f.candidate)
  f.put(join(f.candidate, 'dsh/workspace/AGENTS.md'), '# 业务助手\n使用更新后的业务规则。\n')
  f.put(join(f.candidate, 'dsh/workspace/skills/inspection/SKILL.md'), '# 巡检\n通过平台 MCP 执行巡检。\n')
  f.put(join(f.candidate, 'dsh/managed/demo.patch.yml'), 'model: local/updated-model\nmcp:\n  servers:\n    platform:\n      type: streamable-http\n      url: http://platform.example/mcp\n')
  const after = resolvePreparedAssetDependencies(f.data, 'business:demo', {}, f.candidate)
  assert.equal(after.status, 'ready', after.reasons.join(';'))
  assert.ok(before.receipt.declarations_sha256)
  assert.equal(after.receipt.declarations_sha256, before.receipt.declarations_sha256)
  assert.deepEqual(after.mounts, [])
  assert.equal(runtimeDependencies({ programRoot }, f.snapshot)[0].ready, true)
  const result = await createAssetDependenciesHandler(f.data, { command: () => assert.fail('Harness 修改不得触发安装器') })({ experiment_id: 'business:demo' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(existsSync(join(f.data, '.local/asset-dependencies')), false)
})

test('固定业务 Candidate 不能因调用方省略版本而回退到当前工作树', t => {
  const f = fixture(t)
  const commit = spawnSync('git', ['add', '.'], { cwd: join(f.data, '..', 'business'), encoding: 'utf8' })
  assert.equal(commit.status, 0, commit.stderr)
  const saved = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: join(f.data, '..', 'business'), encoding: 'utf8' })
  assert.equal(saved.status, 0, saved.stderr)
  const hash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: join(f.data, '..', 'business'), encoding: 'utf8' })
  assert.equal(hash.status, 0, hash.stderr)
  const source = businessSource(f.data, 'business:demo'), cached = join(f.data, '.local/business-sources', hash.stdout.trim(), 'demo', 'agents', 'demo')
  assert.ok(source.repository_root)
  cpSync(f.candidate, cached, { recursive: true })
  const result = resolvePreparedAssetDependencies(f.data, 'business:demo', {}, cached)
  assert.equal(result.status, 'ready', result.reasons.join(';'))
})

for (const manifest of [{ dependencies: { 'pinyin-pro': '^99.0.0' } }, { optionalDependencies: { 'not-in-standard-runtime': '1.0.0' } }]) {
  test(`镜像缺少兼容依赖时两条路径均拒绝，旧回执不能绕过：${JSON.stringify(manifest)}`, async t => {
    const f = fixture(t, manifest)
    f.put(join(f.data, '.local/asset-dependencies/business:demo/current.json'), JSON.stringify({ digest: 'a'.repeat(64), status: 'ready' }))
    const managed = resolvePreparedAssetDependencies(f.data, 'business:demo')
    assert.equal(managed.status, 'pending'); assert.match(managed.reasons.join(';'), /标准 Runtime 镜像.*重建共享标准镜像/)
    const [name, version] = Object.entries(manifest.dependencies ?? manifest.optionalDependencies)[0]
    assert.ok(managed.reasons.join(';').includes(`${name}（声明 ${version}，标准镜像 `))
    assert.deepEqual(managed.mounts, [])
    assert.equal(runtimeDependencies({ programRoot }, f.snapshot)[0].ready, false)
    const result = await createAssetDependenciesHandler(f.data, { command: () => assert.fail('不得补装依赖') })({ experiment_id: 'business:demo' })
    assert.equal(result.ok, false); assert.equal(result.error.code, 'dependency_pending')
  })
}

test('Python 镜像锁在实例和导出中一致，兼容哈希锁且拒绝未包含的版本', t => {
  const f = fixture(t)
  const path = join(f.candidate, 'dsh/workspace/tools/requirements.lock.txt')
  const requirement = 'packaging==25.0 --hash=sha256:' + 'a'.repeat(64)
  f.put(path, requirement + '\n')
  const snapshot = { candidate: f.candidate, dependencies: [{ kind: 'python', path: 'python/workspace/tools', requirements: [requirement], dependencies: ['packaging'] }] }
  assert.equal(resolvePreparedAssetDependencies(f.data, 'business:demo').status, 'ready')
  assert.equal(runtimeDependencies({ programRoot }, snapshot)[0].ready, true)
  f.put(path, 'packaging==999.0\n'); snapshot.dependencies[0].requirements = ['packaging==999.0']
  assert.equal(resolvePreparedAssetDependencies(f.data, 'business:demo').status, 'pending')
  assert.equal(runtimeDependencies({ programRoot }, snapshot)[0].ready, false)
})

test('来源或声明读取失败保留具体原因，不替换为笼统的依赖错误', t => {
  const f = fixture(t)
  f.put(join(f.candidate, 'dsh/managed/voice/package.json'), '{invalid-json')
  const result = resolvePreparedAssetDependencies(f.data, 'business:demo', {}, f.candidate)
  assert.equal(result.status, 'pending')
  assert.match(result.reasons.join(';'), /business:demo/)
  assert.match(result.reasons.join(';'), /managed\/voice\/package.json/)
  assert.match(result.reasons.join(';'), /JSON/)
})
