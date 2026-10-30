import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fixture, write, command } from './agent-fixture.mjs'
import { agentCandidateDigest, inspectAgentSnapshot } from '../agent/snapshot.mts'
import { sha256File } from '../manifest.mts'
import { packAgent, previewAgentPackage } from '../agent/pack.mts'
import { tarExtract } from '../fsutil.mts'
import { createOfflineKnowledgeProvider } from '../../plugin/src/standalone-knowledge/index.ts'

function sdkFixture(t) {
  const f = fixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8').replace('loadable_assets:\n', 'loadable_assets:\n  profile: sdk\n'))
  write(join(f.candidate, 'sdk/example.ts'), "import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'\n// 当前版本示例。\n")
  write(join(f.candidate, 'sdk/README.md'), '# 当前版本 TypeScript SDK 接入\n\n会话与调用说明由该版本维护。\n')
  for (const name of ['sdk-runner.mts', 'sdk-preset.mts', 'sdk-profile.patch.yml', 'sdk-module-links.mts', 'prepare-verification-home.mjs']) {
    write(join(f.program, 'runtime/adapters/dsh-container', name), readFileSync(new URL(`../../../runtime/adapters/dsh-container/${name}`, import.meta.url), 'utf8'))
  }
  return f
}

test('SDK 独立包保留官方运行入口、示例与文档，无业务 Web 端口和网页探针', async t => {
  const f = sdkFixture(t)
  assert.equal(previewAgentPackage(f.input).profile, 'sdk')
  const result = await packAgent(f.input), root = join(f.root, 'sdk-package')
  tarExtract(result.archive, root)
  assert.equal(result.manifest.source.profile, 'sdk')
  const compose = JSON.parse(readFileSync(join(root, 'runtime/compose.yaml'), 'utf8'))
  assert.equal(compose.services.dsh.ports, undefined)
  assert.equal(compose.services.dsh.healthcheck, undefined)
  assert.equal(compose.services.dsh.environment.STANDALONE_PORT, undefined)
  assert.ok(compose.services.dsh.volumes.some(volume => volume.target === '/opt/node_modules' && volume.read_only === true))
  assert.deepEqual(compose.services.dsh.command, ['sdk-run', '/var/lib/dsh/standalone/input.json'])
  assert.equal(existsSync(join(root, 'runtime/web')), false)
  assert.ok(existsSync(join(root, 'runtime/sdk-runner.mts')))
  assert.ok(existsSync(join(root, 'runtime/sdk-preset.mts')))
  assert.ok(existsSync(join(root, 'runtime/sdk-module-links.mts')))
  assert.ok(existsSync(join(root, 'runtime/prepare-verification-home.mjs')))
  assert.match(readFileSync(join(root, 'sdk/example.ts'), 'utf8'), /from '@deepseek-ai\/dsh-sdk-client'/)
  assert.match(readFileSync(join(root, 'SDK使用说明.md'), 'utf8'), /\[sdk\/README\.md\]\(sdk\/README\.md\)/)
  assert.equal(JSON.parse(readFileSync(join(root, 'config-seed/standalone.json'), 'utf8')).profile, 'sdk')
  command('bash', ['-n', join(root, 'agent')])
  command('bash', ['-n', join(root, 'install.sh')])
})

test('SDK 版本修改后的示例与指南原字节进入包及来源摘要，装配运行器不覆盖内容', async t => {
  const f = sdkFixture(t), before = previewAgentPackage(f.input)
  const example = "// 版本专有示例，保持原始 CRLF。\r\nimport { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'\r\n"
  const guide = '# 版本专有接入说明\n\n本版本的输入约定与通用模板不同。\n'
  write(join(f.candidate, 'sdk/example.ts'), example)
  write(join(f.candidate, 'sdk/README.md'), guide)
  const snapshot = inspectAgentSnapshot(f.input)
  assert.notEqual(snapshot.candidateSha256, before.candidateSha256)
  assert.equal(snapshot.omitted.some(path => path === 'sdk/example.ts' || path === 'sdk/README.md'), false)
  await assert.rejects(packAgent({ ...f.input, expectedCandidateSha256: before.candidateSha256 }), /版本资产已变化/)
  const result = await packAgent(f.input), root = join(f.root, 'sdk-source-bytes')
  tarExtract(result.archive, root)
  assert.equal(readFileSync(join(root, 'sdk/example.ts'), 'utf8'), example)
  assert.equal(readFileSync(join(root, 'sdk/README.md'), 'utf8'), guide)
  assert.equal(result.manifest.source.candidateSha256, agentCandidateDigest(f.candidate))
  for (const path of ['sdk/example.ts', 'sdk/README.md']) {
    assert.equal(result.manifest.source.files.find(file => file.sourcePath === path)?.sha256, sha256File(join(f.candidate, path)))
    assert.equal(result.manifest.files.find(file => file.path === path)?.sha256, sha256File(join(root, path)))
  }
})

test('SDK 包完整承接主子角色模型投影及 Candidate 外层业务项目，不回写源资产', async t => {
  const f = sdkFixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8') + '\nmodel_bindings:\n  main: {provider: api, model: main-model}\n  presets:\n    reviewer: {provider: api, model: review-model}\nrole_instructions:\n  alpha-main: roles/main.md\n  reviewer: dsh/workspace/reviewer.md\nproject_workspace:\n  path: project\n')
  write(join(f.candidate, 'dsh/presets/reviewer/agent.cordis.yml'), '[]\n')
  write(join(f.candidate, 'roles/main.md'), '# 主角色\n')
  write(join(f.candidate, 'dsh/workspace/reviewer.md'), '# 评审角色\n')
  write(join(f.candidate, 'project/package.json'), '{"name":"sdk-project","private":true}\n')
  write(join(f.program, 'platform/plugin/lib/model-binding-runtime.js'), 'export {}\n')
  const sourcePreset = readFileSync(join(f.candidate, 'dsh/presets/alpha-main/agent.cordis.yml'), 'utf8')
  const snapshot = inspectAgentSnapshot(f.input)
  assert.ok(snapshot.files.some(file => file.path === 'assets/candidate/project/package.json'))
  assert.ok(snapshot.files.some(file => file.path === 'assets/candidate/roles/main.md'))
  const result = await packAgent(f.input), root = join(f.root, 'sdk-roles')
  tarExtract(result.archive, root)
  const main = readFileSync(join(root, 'runtime/projections/presets/alpha-main/agent.cordis.yml'), 'utf8')
  const reviewer = readFileSync(join(root, 'runtime/projections/presets/reviewer/agent.cordis.yml'), 'utf8')
  assert.match(main, /main-model/)
  assert.match(main, /\/opt\/harness-candidate\/roles\/main.md/)
  assert.match(reviewer, /review-model/)
  assert.equal(readFileSync(join(f.candidate, 'dsh/presets/alpha-main/agent.cordis.yml'), 'utf8'), sourcePreset)
  const compose = JSON.parse(readFileSync(join(root, 'runtime/compose.yaml'), 'utf8'))
  assert.ok(compose.services.dsh.volumes.some(volume => volume.target === '/opt/dsh-presets' && volume.source === './runtime/projections/presets'))
  assert.ok(compose.services.dsh.volumes.some(volume => volume.target === '/opt/harness-candidate' && volume.source === './assets/candidate'))
  for (const name of ['workspace', 'presets', 'managed']) {
    assert.deepEqual(readdirSync(join(root, 'assets/candidate/dsh', name)), [], '只读父层内须预建空的子挂载点')
  }
  const candidateMounts = compose.services.dsh.volumes.filter(volume => volume.target.startsWith('/opt/harness-candidate'))
  assert.equal(candidateMounts[0].target, '/opt/harness-candidate')
  assert.ok(candidateMounts.every(volume => volume.read_only))
  assert.equal(agentCandidateDigest(f.candidate), snapshot.candidateSha256)
  assert.ok(compose.services.dsh.volumes.some(volume => volume.target === '/opt/harness-model-runtime/model-binding-runtime.mjs'))
})

test('SDK 运行资产缺失、未知 Profile 与导出期间变化明确拒绝', async t => {
  const f = sdkFixture(t), harness = join(f.candidate, 'harness.yaml')
  const original = readFileSync(harness, 'utf8')
  write(harness, original.replace('profile: sdk', 'profile: other'))
  assert.throws(() => previewAgentPackage(f.input), /profile/)
  write(harness, original + '\nrole_instructions:\n  alpha-main: roles/missing.md\n')
  assert.throws(() => previewAgentPackage(f.input), /SDK 运行资产/)
  write(harness, original)
  write(harness, original.replace('profile: sdk', 'profile: sdk\n  profile_manifest: dsh/managed/sdk-profile.package.json'))
  write(join(f.candidate, 'dsh/managed/sdk-profile.package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', 'unhandled-bundle'] } } }))
  assert.throws(() => previewAgentPackage(f.input), /额外或不同的 bundle/)
  write(join(f.candidate, 'dsh/managed/sdk-profile.package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } } }))
  write(harness, original)
  await assert.rejects(packAgent(f.input, { onProgress(progress) {
    if (progress.stage === 'snapshot') write(join(f.candidate, 'dsh/workspace/AGENTS.md'), '导出时变化')
  } }), /版本资产在导出期间变化/)
})

for (const location of ['roles/main.md', 'project/README.md', 'dsh/workspace/AGENTS.md', 'dsh/presets/reference.md', 'dsh/managed/reference.md']) {
  test(`离线 SDK 包按实际冻结清单收集 ${location} 的参考，提供方可按原 URL 读取`, async t => {
    const f = sdkFixture(t), harness = join(f.candidate, 'harness.yaml')
    const declaration = location.startsWith('roles/') ? '\nrole_instructions:\n  alpha-main: roles/main.md\n'
      : location.startsWith('project/') ? '\nproject_workspace:\n  path: project\n' : ''
    write(harness, readFileSync(harness, 'utf8') + declaration)
    const url = 'https://docs.agent-fixture.test/business-rules.md'
    write(join(f.candidate, location), `# 业务正文\n\n任务前阅读[业务规则](${url})。\n`)
    write(join(f.candidate, 'dsh/workspace/reference.md'), '# 固定规则\n\n输出必须保留 source_revision。\n')
    write(join(f.candidate, 'unselected.md'), '不属于装载资产的参考 https://docs.agent-fixture.test/unselected.md\n')
    write(join(f.program, 'platform/plugin/lib/model-binding-runtime.js'), 'export {}\n')
    const input = { ...f.input, mode: 'offline', knowledgeSources: [{ url, path: 'dsh/workspace/reference.md' }] }
    const preview = previewAgentPackage(input)
    assert.deepEqual(preview.knowledge.references.filter(ref => ref.required).map(ref => ref.url), [url])
    const result = await packAgent(input), root = join(f.root, 'offline-sdk')
    tarExtract(result.archive, root)
    assert.equal(result.manifest.knowledge.sources.length, 1)
    assert.equal(result.manifest.knowledge.references.some(ref => ref.url.endsWith('/unselected.md')), false)
    const fetched = await createOfflineKnowledgeProvider(join(root, 'assets/workspace/knowledge/offline/index.json')).fetch({ url })
    assert.equal(fetched.statusCode, 200)
    assert.match(fetched.body.content, /source_revision/)
    await assert.rejects(packAgent({ ...input, knowledgeSources: [{ url, path: '../outside.md' }] }), /已冻结/)
  })
}

test('外层角色的必需离线参考缺失时明确拒绝出包', async t => {
  const f = sdkFixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8') + '\nrole_instructions:\n  alpha-main: roles/main.md\n')
  write(join(f.candidate, 'roles/main.md'), '请阅读[必需规则](https://docs.agent-fixture.test/missing.md)。\n')
  write(join(f.program, 'platform/plugin/lib/model-binding-runtime.js'), 'export {}\n')
  assert.equal(previewAgentPackage({ ...f.input, mode: 'offline' }).knowledge.references.filter(ref => ref.required).length, 1)
  await assert.rejects(packAgent({ ...f.input, mode: 'offline' }), /运行必需的离线知识尚未补齐/)
})

test('SDK 外层项目的 Node 与 Python 依赖不会被当作零依赖，已准备依赖按项目位置打包', async t => {
  const f = sdkFixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8') + '\nproject_workspace:\n  path: project\n')
  write(join(f.candidate, 'project/package.json'), JSON.stringify({ name: 'business-project', dependencies: { 'fixture-sdk-lib': '1.0.0' }, peerDependencies: { '@deepseek-ai/dsh-sdk-client': '*' } }))
  write(join(f.candidate, 'project/requirements.txt'), 'fixture_py_lib==1.0.0\n')
  const before = previewAgentPackage(f.input)
  assert.equal(before.resourceReady, false)
  assert.ok(before.dependencyPackages.some(item => item.path === 'candidate/project' && item.dependencies.includes('fixture-sdk-lib') && !item.dependencies.includes('@deepseek-ai/dsh-sdk-client')))
  assert.ok(before.dependencyPackages.some(item => item.path === 'python/candidate/project' && !item.ready))
  write(join(f.candidate, 'project/node_modules/fixture-sdk-lib/index.js'), 'export const ready = true\n')
  write(join(f.candidate, 'project/vendor/site-packages/fixture_py_lib/__init__.py'), 'READY = True\n')
  write(join(f.program, 'platform/plugin/lib/model-binding-runtime.js'), 'export {}\n')
  const result = await packAgent(f.input), root = join(f.root, 'sdk-project-dependencies')
  tarExtract(result.archive, root)
  assert.ok(existsSync(join(root, 'assets/candidate/project/node_modules/fixture-sdk-lib/index.js')))
  assert.ok(existsSync(join(root, 'runtime/python/candidate/project/site-packages/fixture_py_lib/__init__.py')))
})
