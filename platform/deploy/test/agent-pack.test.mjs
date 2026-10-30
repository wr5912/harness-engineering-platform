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
import { agentCommand } from '../agent/process.mts'
import { candidateDigest, candidateFiles } from '../../plugin/src/tasks/files.ts'

import { fixture, write, elf, command } from './agent-fixture.mjs'

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
  assert.equal(existsSync(join(staging, 'assets/workspace/.env')), false)
})

test('未承接的迁移运行声明在独立包预览和打包前明确拒绝，不能静默改变行为', async t => {
  const f = fixture(t), harness = join(f.candidate, 'harness.yaml')
  write(harness, readFileSync(harness, 'utf8') + '\nrole_instructions:\n  alpha-main: dsh/workspace/AGENTS.md\n')
  assert.throws(() => previewAgentPackage(f.input), /当前.*独立运行包尚未适配/)
  await assert.rejects(packAgent(f.input), /当前.*独立运行包尚未适配/)
  assert.equal(existsSync(join(f.out, 'manifest.json')), false)
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
  assert.equal(result.manifest.source.paths.preset, 'assets/presets/alpha-main/agent.cordis.yml')
  assert.equal(JSON.stringify(result.manifest).includes('private-package-fixture'), false)
  assert.equal(JSON.stringify(result.manifest).includes('mcp-fixture-token'), false)
  assert.ok(messages.includes('completed'))
  const extracted = join(f.root, 'extracted')
  tarExtract(result.archive, extracted)
  assert.equal(readFileSync(join(extracted, 'assets/workspace/AGENTS.md'), 'utf8'), '# 当前已保存且未提交的业务规则\n')
  assert.ok(existsSync(join(extracted, 'install.sh')))
  assert.ok(existsSync(join(extracted, 'agent')))
  assert.deepEqual(verifyEntries(extracted, result.manifest.files, ['manifest.json', 'SHA256SUMS']), [])
  command('sha256sum', ['-c', 'SHA256SUMS', '--quiet'], extracted)
  assert.equal(JSON.parse(readFileSync(join(extracted, 'config-seed/environment.llm-api-key'), 'utf8')).TEST_MODEL_KEY, 'private-package-fixture')
  assert.equal(readFileSync(join(extracted, '.gitignore'), 'utf8').includes('*.llm-api-key'), true)
  assert.equal(existsSync(join(extracted, 'assets/workspace/RuntimeHOME')), false)
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
  write(join(f.resources, 'docker/docker-compose'), '已变化')
  await assert.rejects(packAgent(f.input), /资源校验失败/)
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

test('匹配声明的目标依赖缓存按实际摘要进入包，缓存被修改会拒绝生成', async t => {
  const f = fixture(t)
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
  assert.equal(readFileSync(join(extracted, 'assets/managed/local-provider/node_modules/fixture/index.js'), 'utf8'), 'export default "prepared-target-dependency"\n')
  write(join(modules, 'fixture/index.js'), '已发生变化')
  await assert.rejects(packAgent(f.input), /依赖资源已变化/)
})

test('离线包可使用已冻结的本地资料补齐必需 URL，不改源资产', async t => {
  const f = fixture(t)
  const url = 'https://docs.example.test/reference/guide.md'
  write(join(f.candidate, 'dsh/workspace/AGENTS.md'), `# 业务\n\n## 参考资料\n\n[运行手册](${url})\n`)
  write(join(f.candidate, 'dsh/workspace/knowledge/guide.md'), '# 固定手册\n\n离线应读取本地规则。\n')
  const result = await packAgent({ ...f.input, mode: 'offline', knowledgeSources: [{ url, path: 'dsh/workspace/knowledge/guide.md' }] })
  assert.equal(result.manifest.knowledge.sources.length, 1)
  assert.equal(result.manifest.knowledge.missing.length, 0)
  assert.equal(existsSync(join(f.candidate, 'dsh/workspace/knowledge/offline')), false)
  const extracted = join(f.root, 'offline')
  tarExtract(result.archive, extracted)
  const seed = JSON.parse(readFileSync(join(extracted, 'config-seed/standalone.json'), 'utf8'))
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
  assert.equal(JSON.parse(readFileSync(join(extracted, 'config-seed/environment.llm-api-key'), 'utf8')).TEST_MODEL_KEY, 'synthetic-fixture-value')
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

test('明确 Python 环境声明不会被当作零依赖，便携库归档后设置容器 PYTHONPATH', async t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/workspace/tools/requirements.txt'), 'fixture_lib==1.0.0\n')
  let preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.ok(preview.dependencyPackages.some(item => item.kind === 'python' && !item.ready))
  assert.ok(preview.issues.some(item => /site-packages/.test(item.message)))
  write(join(f.candidate, 'dsh/workspace/tools/vendor/site-packages/fixture_lib/__init__.py'), 'VALUE = 1\n')
  write(join(f.candidate, 'dsh/workspace/.venv/pyvenv.cfg'), '宿主解释器信息，不应部署\n')
  symlinkSync('/usr/bin/python3', join(f.candidate, 'dsh/workspace/.venv/python'))
  assert.throws(() => candidateFiles(f.candidate), /符号链接/)
  assert.doesNotThrow(() => candidateFiles(f.candidate, ['.venv', 'venv']))
  preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, true)
  const result = await packAgent(f.input)
  const extracted = join(f.root, 'python-package')
  tarExtract(result.archive, extracted)
  assert.ok(existsSync(join(extracted, 'runtime/python/workspace/tools/site-packages/fixture_lib/__init__.py')))
  assert.equal(existsSync(join(extracted, 'assets/workspace/.venv')), false)
  const environment = JSON.parse(readFileSync(join(extracted, 'config-seed/environment.llm-api-key'), 'utf8'))
  assert.equal(environment.PYTHONPATH, '/opt/standalone/runtime/python/workspace/tools/site-packages')
})

test('宿主原生 Python 扩展、glibc 或未知 pyproject 环境需明确准备目标依赖', t => {
  const f = fixture(t)
  write(join(f.candidate, 'dsh/managed/decision/pyproject.toml'), '[project]\nname="decision"\ndependencies=["fixture-lib"]\n')
  write(join(f.candidate, 'dsh/managed/decision/vendor/site-packages/native.so'), elf('amd64'))
  const preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.ok(preview.issues.some(item => /原生 Python/.test(item.message)))
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
  assert.equal(preview.resourceReady, true)
  assert.deepEqual(preview.dependencyPackages.find(item => item.kind === 'python').dependencies, ['fixture-lib'])
  write(declaration, '[project]\nname="task"\ndynamic=["dependencies"]\n')
  preview = previewAgentPackage(f.input)
  assert.equal(preview.resourceReady, false)
  assert.ok(preview.issues.some(item => /未解析/.test(item.message)))
})
