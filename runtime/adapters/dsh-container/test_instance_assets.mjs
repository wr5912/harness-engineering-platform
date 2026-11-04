import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { appliedFiles, assetStatus, digest, generationDigest, sourceAssets, verifyFiles } from './instance-assets.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hep-instance-assets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (name, content = name) => { const file = join(root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content); return file }
  put('workspace/AGENTS.md'); put('workspace/.agents/skills/demo/SKILL.md')
  put('presets/demo/preset.yml'); put('managed/demo.patch.yml'); put('managed/plugin/src/index.ts'); put('managed/plugin/lib/index.js')
  put('profile.json', '{"dependencies":{}}'); put('model.patch.yml'); put('roles/main.md')
  const contract = { workspace: join(root, 'workspace'), presets: join(root, 'presets'), managed: join(root, 'managed'), profile_manifest: join(root, 'profile.json'),
    candidate_source_root: root, harness_runtime: { role_instructions: { main: 'roles/main.md' }, harness_sha256: 'raw-metadata' }, patch: '/opt/dsh-managed/demo.patch.yml', image: { build_fingerprint: 'locked' } }
  const manifest = { name: 'demo', source_id: 'experiment:EXP-demo-001', target_preset: 'demo', session_preset: 'demo', mode: 'verification', port: 18501,
    model_policy: { default: { provider: 'p', model: 'm' } }, mounts: { workspace: contract.workspace, presets: contract.presets, managed: contract.managed }, web_profile_manifest: contract.profile_manifest }
  const source = () => sourceAssets(contract, manifest, root)
  return { root, put, contract, manifest, source }
}

test('装载闭包覆盖提示词、Skill、插件源码、制品、依赖和运行配置', t => {
  const { root, put, contract, manifest, source } = fixture(t)
  put('dependency/index.js'); contract.asset_dependencies = { mounts: [{ source: join(root, 'dependency'), target: '/opt/dependency' }] }
  for (const file of ['workspace/AGENTS.md', 'workspace/.agents/skills/demo/SKILL.md', 'presets/demo/preset.yml', 'managed/demo.patch.yml',
    'managed/plugin/src/index.ts', 'managed/plugin/lib/index.js', 'dependency/index.js', 'roles/main.md', 'profile.json', 'model.patch.yml']) {
    const before = source().digest; put(file, `changed ${file}`); assert.notEqual(source().digest, before, file)
  }
  const before = source().digest; manifest.model_policy.default.model = 'other'; assert.notEqual(source().digest, before)
})

test('评测、备注、Session、缓存及未装载工作副本不进入摘要', t => {
  const { put, contract, source } = fixture(t)
  const before = source().digest
  for (const file of ['evaluation.md', 'workspace/evaluation.md', 'workspace/project.ts', 'managed/evaluation.md', 'managed/notes.md', 'managed/备注.md',
    'managed/plugin/cache/item', 'managed/plugin/sessions/session.json', 'workspace/.agents/skills/demo/notes.md', 'session.json']) put(file, 'changed')
  contract.harness_runtime.harness_sha256 = 'metadata-only'
  assert.equal(source().digest, before)
})

test('适配层实际装载的固定模型配置与引导配置变化进入摘要', t => {
  const { root, put, contract, manifest, source } = fixture(t)
  delete contract.harness_runtime; delete manifest.model_policy
  manifest.adapter_root = join(root, 'adapter')
  const files = ['runtime-compat/index.js', 'runtime-model.patch.yml', 'instance-load-observer.ts', 'instance-assets.ts', 'instance-load.patch.yml',
    'verification-home-controls/web-base-path.patch.yml', 'verification-home-controls/locked-user.patch.yml',
    'verification-home-controls/locked-global.AGENTS.md', 'verification-home-controls/locked-bootstrap.env', 'verification-home-controls/module-deny/package.json']
  for (const file of files) put(`adapter/${file}`)
  for (const file of ['runtime-model.patch.yml', 'verification-home-controls/locked-bootstrap.env', 'verification-home-controls/module-deny/package.json']) {
    const before = source().digest; put(`adapter/${file}`, 'changed'); assert.notEqual(source().digest, before, file)
  }
})

test('旧实例与不同运行代次必须未知，只有当前代次真实回执可判当前或待重载', t => {
  const { root, put, contract, manifest, source } = fixture(t)
  const generation = { id: 'container-a', started_at: '2026-11-04T00:00:00Z', running: true }
  const state = () => assetStatus(contract, manifest, generation, 'running', root)
  assert.equal(state().status, 'unknown')
  manifest.asset_load = { verification: 'runtime-observer', container_id: generation.id, started_at: generation.started_at, digest: source().digest }
  assert.equal(state().status, 'unknown', '不完整旧回执不充当实际加载证据')
  Object.assign(manifest.asset_load, { ok: true, source_id: manifest.source_id, preset_id: manifest.session_preset, files_digest: digest([]), loaded_at: generation.started_at, pid: 10 })
  assert.equal(state().status, 'current')
  put('managed/plugin/src/index.ts', 'new code'); assert.equal(state().status, 'pending_reload')
  generation.id = 'container-b'; assert.equal(state().status, 'unknown')
  assert.equal(assetStatus(contract, manifest, { ...generation, running: false }, 'stopped', root).status, 'unknown')
})

test('代次摘要覆盖实例参数与代次，不因加载回执或尝试记录变动而冲突', t => {
  const { manifest } = fixture(t), generation = { id: 'a', started_at: 'time', running: true }
  const before = generationDigest(manifest, generation)
  manifest.asset_load = { anything: 'receipt' }; manifest.asset_reload_attempt = { status: 'unknown' }
  assert.equal(generationDigest(manifest, generation), before)
  assert.notEqual(generationDigest(manifest, { ...generation, started_at: 'new' }), before)
  manifest.port++; assert.notEqual(generationDigest(manifest, generation), before)
})

test('实际装载清单使用投影而非编辑源，容器字节不符就拒绝核验', t => {
  const { root, put, contract, manifest } = fixture(t)
  put('projection/demo/preset.yml', 'projected'); manifest.mounts.presets = join(root, 'projection')
  assert.notDeepEqual(appliedFiles(contract, manifest, root), sourceAssets(contract, manifest, root).files)
  const file = put('actual.js', 'const actual = true')
  const sha256 = sourceAssets({ ...contract, presets: join(root, 'projection') }, manifest, root).files[0].sha256
  assert.throws(() => verifyFiles([{ path: file, sha256 }]), /挂载内容/)
})

test('依赖循环链接可以按有限闭包核验，缺失资产不能冒充相同版本', t => {
  const { root, contract, source } = fixture(t)
  symlinkSync(root, join(root, 'managed/ancestor'), 'dir')
  assert.ok(source().files.length > 0)
  contract.presets = join(root, 'missing'); assert.throws(source)
})


test('状态摘要复用 stat 缓存，仍检测同尺寸改写、增删和链接目标变化，verifyFiles 直接读字节', t => {
  const { root, put, contract, manifest } = fixture(t), cache = Object.create(null)
  const source = () => sourceAssets(contract, manifest, root, cache)
  const initial = source(), file = realpathSync(join(root, 'managed/plugin/lib/index.js'))
  const cached = cache[file]
  assert.equal(cached.sha256, initial.files.find(item => item.path.endsWith('/lib/index.js')).sha256)
  cached.sha256 = 'a'.repeat(64)
  assert.equal(source().files.find(item => item.path.endsWith('/lib/index.js')).sha256, cached.sha256, 'stat 不变时复用摘要，避免重新读取依赖')
  cache[file] = { ...cached, sha256: initial.files.find(item => item.path.endsWith('/lib/index.js')).sha256 }
  const bytes = 'x'.repeat('managed/plugin/lib/index.js'.length)
  put('managed/plugin/lib/index.js', bytes)
  utimesSync(file, new Date(0), new Date(0))
  const rewritten = source()
  assert.notEqual(rewritten.digest, initial.digest)
  assert.throws(() => verifyFiles([{ path: file, sha256: initial.files.find(item => item.path.endsWith('/lib/index.js')).sha256 }]), /挂载内容/)
  put('managed/plugin/new.js', 'added')
  assert.notEqual(source().digest, rewritten.digest)
  rmSync(join(root, 'managed/plugin/new.js'))
  assert.equal(source().digest, rewritten.digest)
  put('dependency-a/item.js', 'a'); put('dependency-b/item.js', 'b')
  symlinkSync(join(root, 'dependency-a'), join(root, 'dependency'))
  contract.asset_dependencies = { mounts: [{ source: join(root, 'dependency'), target: '/opt/dependency' }] }
  const beforeLink = source().digest
  rmSync(join(root, 'dependency')); symlinkSync(join(root, 'dependency-b'), join(root, 'dependency'))
  assert.notEqual(source().digest, beforeLink)
})

test('状态列出相对加载回执的增删、修改、配置变化和检查时间，旧回执说明清单缺失', t => {
  const { root, put, contract, manifest, source } = fixture(t)
  const initial = source(), generation = { id: 'current', started_at: '2026-11-04T00:00:00Z', running: true }
  manifest.asset_load = { verification: 'runtime-observer', ok: true, source_id: manifest.source_id, preset_id: manifest.session_preset,
    digest: initial.digest, files_digest: digest([]), source_files: initial.files, configuration_digest: initial.configuration_digest,
    loaded_at: generation.started_at, pid: 10, container_id: generation.id, started_at: generation.started_at }
  put('managed/plugin/src/index.ts', 'modified'); put('managed/plugin/new.js', 'added')
  rmSync(join(root, 'managed/plugin/lib/index.js')); manifest.port++
  const status = assetStatus(contract, manifest, generation, 'running', root)
  assert.equal(status.status, 'pending_reload')
  assert.ok(Number.isFinite(Date.parse(status.checked_at)))
  assert.deepEqual(status.changed_files, [
    { path: '/opt/dsh-managed/plugin/new.js', change: 'added' },
    { path: '/opt/dsh-managed/plugin/src/index.ts', change: 'modified' },
    { path: '/opt/dsh-managed/plugin/lib/index.js', change: 'removed' },
    { path: '运行配置', change: 'modified' },
  ])
  delete manifest.asset_load.source_files
  assert.match(assetStatus(contract, manifest, generation, 'running', root).reason, /旧回执未记录逐项清单/)
})

test('跨进程状态检查复用派生缓存，CAS 与 source 绕过缓存，缓存损坏可重建', t => {
  const { root, put, contract, manifest, source } = fixture(t)
  const inspect = (operation = 'status', extra = {}) => {
    const result = spawnSync(process.execPath, [new URL('./instance-assets.mts', import.meta.url).pathname, operation], {
      input: JSON.stringify({ contract, manifest, directory: root, state: 'running', ...extra }), encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const initial = source().digest, cachePath = join(root, 'asset-file-cache.json')
  assert.equal(inspect().current_digest, initial)
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
  cache[realpathSync(join(root, 'managed/plugin/lib/index.js'))].sha256 = 'a'.repeat(64)
  writeFileSync(cachePath, JSON.stringify(cache))
  assert.notEqual(inspect().current_digest, initial, '另一进程使用相同 stat 的缓存')
  assert.equal(inspect('status', { cache: false }).current_digest, initial)
  assert.equal(inspect('source').digest, initial)
  cache[realpathSync(join(root, 'managed/plugin/lib/index.js'))].sha256 = 'invalid'
  writeFileSync(cachePath, JSON.stringify(cache))
  assert.equal(inspect().current_digest, initial)
  writeFileSync(cachePath, 'broken')
  assert.equal(inspect().current_digest, initial)
  put('managed/plugin/added.js')
  const added = inspect().current_digest
  assert.notEqual(added, initial)
  rmSync(join(root, 'managed/plugin/added.js'))
  assert.equal(inspect().current_digest, initial)
})


test('身份迁移只改变期望来源，不改写实际加载回执', t => {
  const { root, contract, manifest, source } = fixture(t)
  const generation = { id: 'same-container', started_at: 'same-start', running: true }
  contract.source_id = manifest.source_id
  manifest.asset_load = { verification: 'runtime-observer', ok: true, source_id: manifest.source_id, preset_id: manifest.session_preset,
    digest: source().digest, files_digest: digest([]), loaded_at: generation.started_at, pid: 10, container_id: generation.id, started_at: generation.started_at }
  const loaded = JSON.stringify(manifest.asset_load)
  assert.equal(assetStatus(contract, manifest, generation, 'running', root).status, 'current')
  contract.source_id = 'experiment:EXP-demo-001-m-r0123456789ab'
  assert.equal(assetStatus(contract, manifest, generation, 'running', root).status, 'pending_reload')
  assert.equal(JSON.stringify(manifest.asset_load), loaded)
})
