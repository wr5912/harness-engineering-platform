import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectEntries, sha256File, verifyEntries } from '../manifest.mts'
import { tarExtract } from '../fsutil.mts'
import { previewAgentPackage, packAgent } from '../agent/pack.mts'
import { agentCandidateDigest, assertDependencyArchitecture, copyAgentSnapshot, inspectAgentSnapshot } from '../agent/snapshot.mts'
import { agentSeed } from '../agent/seed.mts'
import { readBusinessDefault, BusinessDefaultError } from '../../plugin/src/models/business-default.ts'
import { validateStandaloneConfig } from '../../plugin/src/standalone/config.ts'
import { agentCommand } from '../agent/process.mts'
import { candidateDigest, candidateFiles } from '../../plugin/src/tasks/files.ts'

import { fixture, write, elf, command, catalog, exportRecord } from './agent-fixture.mjs'

test('独立包 CLI 的业务默认模型读取可由原生 Node 直接装载', t => {
  const f = fixture(t)
  assert.equal(readBusinessDefault(f.root).default, null)
  assert.equal(new BusinessDefaultError('busy', 'fixture').code, 'busy')
})

test('原生 DSH peer 由目标 Runtime 提供，不依赖打包主机安装目录', t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/managed/native-plugin/package.json'), JSON.stringify({
    name: 'native-plugin', peerDependencies: { '@deepseek-ai/cordis': '*', '@deepseek-ai/schemastery': '*', react: '*' },
    dsh: { client: { platform: 'web' } },
  }))
  assert.deepEqual(inspectAgentSnapshot(f.input).dependencies, [])
})

test('单 Agent 快照读取实际未提交字节、保留来源身份，排除其他 Agent 和运行态', t => {
  const f = fixture(t)
  const source = inspectAgentSnapshot(f.input)
  assert.equal(source.git.dirty, true)
  assert.equal(source.source.preset_id, 'alpha-main')
  assert.equal(source.candidateSha256, agentCandidateDigest(f.candidate))
  assert.equal(source.candidateSha256, candidateDigest(f.candidate))
  assert.ok(source.files.some(file => file.path === 'assets/workspace/AGENTS.md'))
  assert.ok(source.omitted.includes('dsh/workspace/.env'))
  assert.equal(source.files.some(file => /private|RuntimeHOME|\.env$/.test(file.path)), false)
  const staging = join(f.root, 'staging')
  copyAgentSnapshot(source, staging)
  assert.equal(readFileSync(join(staging, 'assets/workspace/AGENTS.md'), 'utf8'), '# 当前已保存且未提交的业务规则\n')
  const seed = agentSeed(source, { environment: { TEST_MODEL_KEY: 'replacement-fixture-value' } })
  assert.equal(seed.environment.TEST_MODEL_KEY, 'replacement-fixture-value')
  assert.deepEqual(seed.mcp, { servers: [], groups: [] })
  assert.deepEqual(agentSeed(source, { mcp: { servers: [{ id: 'fixture' }], sharedToken: 'fixture-token' } }).mcp,
    { servers: [{ id: 'fixture' }], groups: [], sharedToken: 'fixture-token' })
  assert.equal(existsSync(join(staging, 'assets/workspace/.env')), false)
})

test('仅配置模型的独立包生成可初始化的空 MCP 配置，不要求调用方补齐可选字段', async t => {
  const f = fixture(t)
  const modelPatch = [{ name: '本地验收模型' }]
  write(join(f.candidate, 'dsh/workspace/deployment.env.example'), '# 通知服务\nBUSINESS_NATS_URL=nats://notifications.test:4222\n')
  const result = await packAgent({ ...f.input, seed: { modelPatch } })
  const extracted = join(f.root, 'model-only')
  tarExtract(result.archive, extracted)
  const json = readFileSync(join(extracted, 'config/seed/standalone.json'), 'utf8')
  const seed = JSON.parse(json)
  assert.equal(json, JSON.stringify(seed, null, 2) + '\n')
  assert.ok(json.includes('本地验收模型'))
  assert.equal(/\\u[0-9a-f]{4}/i.test(json), false)
  assert.match(readFileSync(join(extracted, 'config/deployment.env'), 'utf8'), /# 通知服务\nBUSINESS_NATS_URL=nats:\/\/notifications\.test:4222/)
  const config = validateStandaloneConfig(seed)
  assert.deepEqual(config.modelPatch, modelPatch)
  assert.deepEqual(config.mcp.servers, [])
  assert.deepEqual(config.mcp.groups, [])
})

test('控制仓指定证据目录后，独立包导出记录不回写数据仓', async t => {
  const f = fixture(t), evidenceDir = join(f.root, 'release/evidence')
  const result = await packAgent({ ...f.input, evidenceDir })
  assert.equal(existsSync(join(evidenceDir, result.manifest.package.name + '.export.json')), true)
  assert.equal(existsSync(join(f.input.assetRoot, '.local/artifacts/agent-deployments', result.manifest.package.name + '.export.json')), false)
})

test('出包保留原生模型及环境表达式，显式投影覆盖对应配置', t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/managed/alpha.patch.yml'), '- id: llm-pi-ai\n  config:\n    providers:\n      local:\n        baseURL: !!js process.env.MODEL_URL\n- id: agent-default-model\n  config: {provider: local, model: qwen}\n')
  const source = inspectAgentSnapshot(f.input)
  const seed = agentSeed(source)
  assert.deepEqual(seed.modelPatch[0].config.providers.local.baseURL, { __dshExpression: 'process.env.MODEL_URL' })
  assert.equal(seed.modelPatch[1].config.model, 'qwen')
  const replacement = { id: 'llm-pi-ai', config: { providers: {} } }
  assert.deepEqual(agentSeed(source, { modelPatch: [replacement], defaultModel: { provider: 'other', model: 'new' } }).modelPatch,
    [replacement, { id: 'agent-default-model', config: { provider: 'other', model: 'new' } }])
})

test('未承接的迁移运行声明在独立包预览和打包前明确拒绝，不能静默改变行为', async t => {
  const f = fixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8') + '\nrole_instructions:\n  alpha-main: dsh/workspace/AGENTS.md\n')
  assert.throws(() => previewAgentPackage(f.input), /当前.*独立运行包尚未适配/)
  await assert.rejects(packAgent(f.input), /当前.*独立运行包尚未适配/)
  assert.equal(existsSync(join(f.out, 'manifest.json')), false)
})

test('预览和打包拒绝缺少不可变镜像身份的旧资源清单', async t => {
  const f = fixture(t), path = join(f.resources, 'resources.json')
  const resource = JSON.parse(readFileSync(path, 'utf8'))
  delete resource.image.id
  write(path, JSON.stringify(resource))
  const preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  await assert.rejects(packAgent(f.input), /镜像 ID|资源/)
})

test('单 Agent 包归档、SHA与安装脚本完整，凭据不进入 manifest 或普通预览', async t => {
  const f = fixture(t), messages = []
  const preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, true)
  assert.equal(JSON.stringify(preview).includes('synthetic-fixture-value'), false)
  const result = await packAgent({ ...f.input, expectedCandidateSha256: preview.candidateSha256,
    seed: { environment: { TEST_MODEL_KEY: 'private-package-fixture' }, mcp: { servers: [], groups: [], sharedToken: 'mcp-fixture-token' } } }, { onProgress: value => messages.push(value.stage) })
  assert.equal(result.sha256, sha256File(result.archive))
  assert.equal(result.manifest.kind, 'standalone-agent')
  assert.equal(result.manifest.source.dirty, true)
  assert.equal(result.manifest.source.paths.preset, 'harness/dsh/presets/alpha-main/agent.cordis.yml')
  assert.equal(JSON.stringify(result.manifest).includes('private-package-fixture'), false)
  assert.equal(JSON.stringify(result.manifest).includes('mcp-fixture-token'), false)
  assert.ok(messages.includes('completed'))
  assert.ok(messages.indexOf('cleanup') < messages.indexOf('completed'))
  assert.deepEqual(readdirSync(join(f.out, '.staging')), [])
  const extracted = join(f.root, 'extracted')
  tarExtract(result.archive, extracted)
  assert.equal(readFileSync(join(extracted, 'harness/dsh/workspace/AGENTS.md'), 'utf8'), '# 当前已保存且未提交的业务规则\n')
  assert.equal(existsSync(join(extracted, 'install.sh')), false)
  assert.ok(existsSync(join(extracted, 'standalone_agent_launcher')))
  const compose = JSON.parse(readFileSync(join(extracted, 'config/compose.yaml'), 'utf8'))
  for (const service of Object.values(compose.services)) {
    assert.equal(service.environment.HOME, '/var/lib/dsh'); assert.equal(service.environment.DSH_HOME, '/var/lib/dsh')
    assert.equal(service.image, result.manifest.image.id)
    assert.equal(service.pull_policy, 'never')
    assert.equal(service.build, undefined)
  }
  const healthcheck = compose.services.dsh.healthcheck
  assert.equal(healthcheck.start_period, '180s')
  assert.equal(healthcheck.retries, 30)
  assert.deepEqual(readdirSync(extracted).sort(), ['config', 'harness', 'images', 'manifest.json', 'standalone_agent_launcher'])
  assert.ok(result.manifest.source.harnessSha256)
  assert.ok(exportRecord(f, result).sourceFiles.length > 0)
  assert.equal(readFileSync(result.archive + '.sha256', 'utf8').split(' ')[0], result.sha256)
  assert.equal(JSON.parse(readFileSync(join(extracted, 'config/seed/environment.llm-api-key'), 'utf8')).TEST_MODEL_KEY, 'private-package-fixture')
  assert.equal(existsSync(join(extracted, '.gitignore')), false)
  assert.equal(existsSync(join(extracted, 'harness/dsh/workspace/RuntimeHOME')), false)
})

test('版本变化、镜像资源变化和取消不会留下可下载半包', async t => {
  const f = fixture(t)
  const preview = previewAgentPackage(f.input)
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), '# 新输入\n')
  await assert.rejects(packAgent({ ...f.input, expectedCandidateSha256: preview.candidateSha256 }), /资产已变化/)
  const controller = new AbortController()
  await assert.rejects(packAgent(f.input, { signal: controller.signal, onProgress(value) { if (value.stage === 'snapshot') controller.abort(new Error('用户取消测试')) } }), /用户取消测试/)
  assert.deepEqual(readdirSync(join(f.out, '.staging')), [])
  assert.equal(readdirSync(f.out).some(name => name.endsWith('.tar.gz') || name.endsWith('.partial')), false)
  write(join(f.resources, 'images/dsh-runtime.tar'), '已变化')
  await assert.rejects(packAgent(f.input), /tar|镜像|归档/)
})

test('原生依赖区分目标架构，符号链接不得引用包外依赖', t => {
  const root = mkdtempSync(join(tmpdir(), 'dependency-arch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  write(join(root, 'native.node'), elf('arm64'))
  assert.doesNotThrow(() => assertDependencyArchitecture(root, 'arm64'))
  assert.throws(() => assertDependencyArchitecture(root, 'amd64'), /架构不符/)
  symlinkSync('/etc/passwd', join(root, 'external'))
  assert.throws(() => assertDependencyArchitecture(root, 'arm64'), /包外符号链接/)
})

test('标准镜像覆盖的依赖不复制主机缓存，缓存变化不影响出包', async t => {
  const f = fixture(t)
  catalog(f, { fixture: '1.0.0' })
  const packageFile = join(f.candidate, 'dsh/managed/local-provider/package.json')
  write(packageFile, JSON.stringify({ name: 'local-provider', dependencies: { fixture: '1.0.0' } }))
  const modules = join(f.resources, 'dependencies/managed/local-provider/node_modules')
  write(join(modules, 'fixture/index.js'), 'export default "prepared-target-dependency"\n')
  const manifest = JSON.parse(readFileSync(join(f.resources, 'resources.json'), 'utf8'))
  manifest.dependencies.push({ path: 'managed/local-provider', lockSha256: sha256File(packageFile), files: collectEntries(modules) })
  write(join(f.resources, 'resources.json'), JSON.stringify(manifest))
  assert.equal(previewAgentPackage(f.input).resourceReady, true)
  const result = await packAgent(f.input)
  const extracted = join(f.root, 'prepared-dependencies')
  tarExtract(result.archive, extracted)
  assert.equal(existsSync(join(extracted, 'harness/dsh/managed/local-provider/node_modules')), false)
  write(join(modules, 'fixture/index.js'), '已发生变化')
  assert.ok((await packAgent(f.input)).archive)
})

test('离线包可使用已冻结的本地资料补齐必需 URL，不改源资产', async t => {
  const f = fixture(t)
  const url = 'https://docs.example.test/reference/guide.md'
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), `# 业务\n\n## 参考资料\n\n[运行手册](${url})\n`)
  write(join(f.candidate, 'dsh/workspace/knowledge/guide.md'), '# 固定手册\n\n离线应读取本地规则。\n')
  const result = await packAgent({ ...f.input, mode: 'offline', knowledgeSources: [{ url, path: 'dsh/workspace/knowledge/guide.md' }] })
  assert.equal(exportRecord(f, result).knowledge.sources.length, 1)
  assert.equal(exportRecord(f, result).knowledge.missing.length, 0)
  assert.equal(existsSync(join(f.candidate, 'dsh/workspace/knowledge/offline')), false)
  const extracted = join(f.root, 'offline')
  tarExtract(result.archive, extracted)
  const seed = JSON.parse(readFileSync(join(extracted, 'config/seed/standalone.json'), 'utf8'))
  assert.equal(seed.offlineKnowledge.indexPath, '/work/harness/workspace/knowledge/offline/index.json')
  await assert.rejects(packAgent({ ...f.input, mode: 'offline', knowledgeSources: [{ url, path: '../other.md' }] }), /已冻结/)
})

test('工作区环境随资产提前冻结，知识收集期间的源文件修改不混入已冻结种子', async t => {
  const f = fixture(t), original = previewAgentPackage(f.input)
  const result = await packAgent({ ...f.input, expectedCandidateSha256: original.candidateSha256 }, { onProgress(progress) {
    if (progress.stage === 'knowledge') write(join(f.candidate, 'dsh/workspace/.env'), 'TEST_MODEL_KEY="later-fixture-value"\n')
  } })
  const extracted = join(f.root, 'frozen-environment')
  tarExtract(result.archive, extracted)
  assert.equal(result.manifest.source.candidateSha256, original.candidateSha256)
  assert.equal(JSON.parse(readFileSync(join(extracted, 'config/seed/environment.llm-api-key'), 'utf8')).TEST_MODEL_KEY, 'synthetic-fixture-value')
  assert.notEqual(agentCandidateDigest(f.candidate), original.candidateSha256)
  await assert.rejects(packAgent(f.input, { onProgress(progress) {
    if (progress.stage === 'snapshot') write(join(f.candidate, 'dsh/workspace/.env'), 'TEST_MODEL_KEY="changed-before-freeze"\n')
  } }), /版本资产在导出期间变化/)
})

test('命令取消会结束子进程而非仅忽略完成回执', async () => {
  const controller = new AbortController()
  const started = Date.now()
  const operation = agentCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
  setTimeout(() => controller.abort(new Error('中止命令测试')), 30)
  await assert.rejects(operation, /中止命令测试/)
  assert.ok(Date.now() - started < 3000)
})

test('Python 依赖由标准镜像提供，不复制宿主 venv 或 vendor', async t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/workspace/tools/requirements.txt'), 'fixture_lib==1.0.0\n')
  let preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.ok(preview.dependencyPackages.some(item => item.kind === 'python' && !item.ready))
  assert.ok(preview.issues.some(item => /标准镜像/.test(item.message)))
  write(join(f.candidate, 'dsh/workspace/tools/vendor/site-packages/fixture_lib/__init__.py'), 'VALUE = 1\n')
  write(join(f.candidate, 'dsh/workspace/.venv/pyvenv.cfg'), '宿主解释器信息，不应部署\n')
  symlinkSync('/usr/bin/python3', join(f.candidate, 'dsh/workspace/.venv/python'))
  assert.throws(() => candidateFiles(f.candidate), /符号链接/)
  assert.doesNotThrow(() => candidateFiles(f.candidate, ['.venv', 'venv']))
  catalog(f, {}, 'fixture_lib==1.0.0\n')
  preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, true)
  const result = await packAgent(f.input)
  const extracted = join(f.root, 'python-package')
  tarExtract(result.archive, extracted)
  assert.equal(existsSync(join(extracted, 'runtime')), false)
  assert.equal(existsSync(join(extracted, 'harness/dsh/workspace/.venv')), false)
  const environment = JSON.parse(readFileSync(join(extracted, 'config/seed/environment.llm-api-key'), 'utf8'))
  assert.equal(environment.PYTHONPATH, undefined)
})

test('宿主原生 Python 扩展、glibc 或未知 pyproject 环境需明确准备目标依赖', t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/managed/decision/pyproject.toml'), '[project]\nname="decision"\ndependencies=["fixture-lib"]\n')
  write(join(f.candidate, 'dsh/managed/decision/vendor/site-packages/native.so'), elf('amd64'))
  const preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.ok(preview.issues.some(item => /标准镜像/.test(item.message)))
  const libraries = join(f.root, 'libraries')
  write(join(libraries, 'libc.so.6'), elf('amd64'))
  assert.throws(() => assertDependencyArchitecture(libraries, 'amd64'), /glibc/)
})

test('pyproject 的包 extras 不截断依赖名，动态环境声明不伪装成空依赖', t => {
  const f = fixture(t)
  const declaration = join(f.candidate, 'dsh/workspace/python-task/pyproject.toml')
  write(declaration, '[project]\nname="task"\ndependencies=["fixture-lib[extra]>=1.0"]\n')
  write(join(f.candidate, 'dsh/workspace/python-task/vendor/site-packages/fixture_lib/__init__.py'), 'VALUE = 1\n')
  let preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.deepEqual(preview.dependencyPackages.find(item => item.kind === 'python').dependencies, ['fixture-lib'])
  write(declaration, '[project]\nname="task"\ndynamic=["dependencies"]\n')
  preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.ok(preview.issues.some(item => /未解析/.test(item.message)))
})
