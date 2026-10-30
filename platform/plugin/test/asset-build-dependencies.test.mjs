import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { dump, load } from 'js-yaml'
import { zipSync, strToU8 } from 'fflate'
import { inspectAgentSnapshot } from '../../deploy/agent/snapshot.mts'

process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
const built = mkdtempSync(join(tmpdir(), 'asset-build-module-'))
await build({ stdin: { contents: "export * from './src/agents/asset-build.ts'; export * from './src/agents/asset-dependencies.ts'; export {candidateDigest} from './src/tasks/files.ts'", resolveDir: new URL('../', import.meta.url).pathname, loader: 'ts' }, outfile: join(built, 'module.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createAssetBuildHandler, inspectAssetBuild, assetBuildReviewEvidence, createAssetDependenciesHandler, resolvePreparedAssetDependencies, candidateDigest } = await import(`file://${join(built, 'module.mjs')}`)
test.after(() => rmSync(built, { recursive: true, force: true }))
const id = 'EXP-alpha-001-r123456abcdef', experiment = `evolution/experiments/${id}`, base = `${experiment}/candidate`, entry = 'dsh/managed/plugin/index.ts'
const write = (root, path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value) }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'asset-build-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, `${base}/harness.yaml`, 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: alpha\n  profile_patch: dsh/managed/alpha.patch.yml\n')
  write(root, `${experiment}/change.yaml`, dump({ experiment_id: id, agent_id: 'alpha', status: 'draft', marker: '保留原合同' }))
  write(root, `${base}/dsh/workspace/AGENTS.md`, '遵循输入规则。\n')
  write(root, `${base}/dsh/presets/alpha/agent.cordis.yml`, '[]\n')
  write(root, `${base}/dsh/managed/alpha.patch.yml`, '[]\n')
  write(root, `${base}/${entry}`, "export const name='alpha'; export const inject=[]; export function apply(ctx:any){ctx.value=1}\n")
  return { root, candidate: join(root, base), change: () => load(readFileSync(join(root, `${experiment}/change.yaml`), 'utf8')) }
}
test('普通EXP构建不执行模块或package scripts，保留DSH原生共享模块引用', async t => {
  const f = fixture(t), marker = join(f.root, 'executed'), handler = createAssetBuildHandler(f.root)
  write(f.root, `${base}/${entry}`, `import {writeFileSync} from 'node:fs'; import {Context} from '@deepseek-ai/cordis'; writeFileSync(${JSON.stringify(marker)},'bad'); export const name='alpha'; export const inject=[]; export function apply(ctx:Context){return {ctx,Context}}\n`)
  write(f.root, `${base}/package.json`, JSON.stringify({ scripts: { build: `touch ${marker}` } }))
  const digest = candidateDigest(f.candidate), preview = await handler('preview', { experiment_id: id, entry_path: entry })
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(existsSync(marker), false)
  assert.equal(existsSync(join(f.candidate, entry.replace('.ts', '.mjs'))), false)
  const result = await handler('build', { experiment_id: id, entry_path: entry, expected_candidate_sha256: digest, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(existsSync(marker), false)
  const output = readFileSync(join(f.candidate, result.value.output_path), 'utf8')
  assert.match(output, /@deepseek-ai\/cordis/); assert.doesNotMatch(output, /class Context/)
  assert.equal(inspectAssetBuild(f.root, id, entry).verified, true)
  const evidence = assetBuildReviewEvidence(f.root, id)
  assert.equal(evidence.generated.length, 1)
  assert.equal(evidence.generated[0].sha256, result.value.esm_sha256)
  assert.ok(evidence.sources.some(item => item.origin === 'candidate' && item.path === entry && item.content.includes('writeFileSync')))
  assert.ok(evidence.sources.some(item => item.origin === 'platform' && item.path === 'runtime/adapters/dsh-web/src/resolve-runtime.ts'))
  assert.equal(existsSync(marker), false)
  assert.equal(f.change().marker, '保留原合同'); assert.equal(f.change().compute_variant_build, undefined)
  write(f.root, `${base}/${entry}`, 'export const value=2\n')
  assert.equal(inspectAssetBuild(f.root, id, entry).verified, false)
  assert.deepEqual(assetBuildReviewEvidence(f.root, id).generated, [])
})
test('审读分类复用实际构建核验，陈旧制品、依赖与回执回退全文', async t => {
  const f = fixture(t), handler = createAssetBuildHandler(f.root)
  write(f.root, `${base}/dsh/managed/handwritten.mjs`, 'export const handwritten=true\n')
  const preview = await handler('preview', { experiment_id: id, entry_path: entry })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const result = await handler('build', { experiment_id: id, entry_path: entry, expected_candidate_sha256: preview.value.candidate_sha256, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(result.ok, true, JSON.stringify(result))
  const before = candidateDigest(f.candidate), output = join(f.candidate, result.value.output_path), artifact = readFileSync(output)
  const changePath = join(f.root, `${experiment}/change.yaml`), change = readFileSync(changePath, 'utf8')
  const evidence = assetBuildReviewEvidence(f.root, id)
  assert.equal(evidence.candidate_sha256, before)
  assert.deepEqual(evidence.generated.map(item => item.path), [result.value.output_path])
  assert.equal(candidateDigest(f.candidate), before)
  const bridge = spawnSync(process.execPath, ['--experimental-transform-types', join(process.env.HARNESS_PROGRAM_ROOT, 'runtime/adapters/dsh-container/harness-runtime.mts'), '--build-evidence', f.root, id], { encoding: 'utf8', env: process.env })
  assert.equal(bridge.status, 0, bridge.stderr)
  assert.deepEqual(JSON.parse(bridge.stdout), evidence)
  for (const mutation of ['esm', 'compiler', 'platform', 'build-digest', 'entry', 'dependencies']) {
    const changed = load(change)
    const receipt = changed.asset_builds[entry]
    if (mutation === 'esm') writeFileSync(output, 'export const changed=true\n')
    if (mutation === 'compiler') receipt.compiler.typescript = 'stale'
    if (mutation === 'platform') receipt.platform_sources[0].sha256 = 'a'.repeat(64)
    if (mutation === 'build-digest') receipt.build_digest = 'a'.repeat(64)
    if (mutation === 'entry') receipt.source_files = []
    if (mutation === 'dependencies') write(f.root, `${base}/dsh/managed/plugin/package.json`, '{"dependencies":{"example":"1.2.3"}}')
    writeFileSync(changePath, dump(changed, { lineWidth: -1, noRefs: true }))
    assert.deepEqual(assetBuildReviewEvidence(f.root, id).generated, [], mutation)
    writeFileSync(output, artifact)
    writeFileSync(changePath, change)
    rmSync(join(f.candidate, 'dsh/managed/plugin/package.json'), { force: true })
  }
  assert.equal(candidateDigest(f.candidate), before)
  const legacy = load(change), receipt = legacy.asset_builds[entry]
  delete receipt.source_inputs_version
  const keys = ['schema_version', 'entry_path', 'output_path', 'compiler', 'dependencies_sha256', 'source_files', 'source_sha256', 'platform_sources', 'platform_sources_sha256']
  receipt.build_digest = createHash('sha256').update(JSON.stringify(Object.fromEntries(keys.map(key => [key, receipt[key]])))).digest('hex')
  writeFileSync(changePath, dump(legacy))
  assert.equal(inspectAssetBuild(f.root, id, entry).verified, false)
  assert.ok(inspectAssetBuild(f.root, id, entry).reasons.some(reason => reason.includes('完整记录实际输入')))
  assert.deepEqual(assetBuildReviewEvidence(f.root, id).generated, [])
  const noReceipt = load(change); delete noReceipt.asset_builds
  writeFileSync(changePath, dump(noReceipt))
  assert.deepEqual(assetBuildReviewEvidence(f.root, id).generated, [])
})
test('完整构建输入包含声明文件背后的实际JS和JSON，不执行源码', async t => {
  const f = fixture(t), handler = createAssetBuildHandler(f.root), marker = join(f.root, 'source-executed')
  const helperSource = `\uFEFFimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'bad'); export const business=42\n`
  write(f.root, `${base}/support/helper.mjs`, helperSource)
  write(f.root, `${base}/support/helper.d.mts`, 'export declare const business:number\n')
  write(f.root, `${base}/support/data.json`, '{"route":"bulk"}\n')
  write(f.root, `${base}/${entry}`, "import {business} from '../../../support/helper.mjs'; import data from '../../../support/data.json'; export function apply(){return {business,data}}\n")
  const preview = await handler('preview', { experiment_id: id, entry_path: entry })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.value.source_inputs_version, 1)
  for (const path of [entry, 'support/helper.mjs', 'support/helper.d.mts', 'support/data.json']) assert.ok(preview.value.source_files.some(item => item.path === path), path)
  const result = await handler('build', { experiment_id: id, entry_path: entry, expected_candidate_sha256: preview.value.candidate_sha256, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(existsSync(marker), false)
  assert.equal(inspectAssetBuild(f.root, id, entry).verified, true)
  const helperEvidence = assetBuildReviewEvidence(f.root, id).sources.find(item => item.path === 'support/helper.mjs')
  assert.equal(helperEvidence.content, helperSource)
  assert.equal(createHash('sha256').update(helperEvidence.content).digest('hex'), helperEvidence.sha256)
  write(f.root, `${base}/support/helper.mjs`, 'export const business=99\n')
  assert.equal(inspectAssetBuild(f.root, id, entry).verified, false)
  assert.deepEqual(assetBuildReviewEvidence(f.root, id).generated, [])
})
test('编译首次发现凭据输入即拒绝，不生成会在全文审读中泄露正文的制品', async t => {
  const f = fixture(t), handler = createAssetBuildHandler(f.root)
  write(f.root, `${base}/dsh/managed/plugin/.env.json`, '{"test":"fixture-only"}\n')
  write(f.root, `${base}/${entry}`, "import data from './.env.json'; export function apply(){return data}\n")
  const preview = await handler('preview', { experiment_id: id, entry_path: entry })
  assert.equal(preview.ok, false, JSON.stringify(preview))
  assert.equal(preview.error.code, 'invalid_request')
  assert.match(preview.error.message, /不能读取凭据文件/)
  assert.doesNotMatch(JSON.stringify(preview), /fixture-only/)
  const result = await handler('build', { experiment_id: id, entry_path: entry })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(existsSync(join(f.candidate, entry.replace('.ts', '.mjs'))), false)
  assert.equal(f.change().asset_builds, undefined)
  assert.equal(inspectAssetBuild(f.root, id, entry).verified, false)
  const evidence = assetBuildReviewEvidence(f.root, id)
  assert.deepEqual(evidence.generated, [])
  assert.deepEqual(evidence.sources, [])
  assert.equal(evidence.candidate_sha256, candidateDigest(f.candidate))
  assert.doesNotMatch(JSON.stringify({ harness_review: evidence }), /fixture-only/)
})
test('类型错误、外部源码导入和陈旧CAS不能落盘', async t => {
  const f = fixture(t), handler = createAssetBuildHandler(f.root)
  write(f.root, `${base}/${entry}`, 'const value:number="bad"; export {value}\n')
  assert.equal((await handler('preview', { experiment_id: id, entry_path: entry })).error.code, 'build_failed')
  write(f.root, `${base}/${entry}`, "export const name='alpha'; export function apply(){}\n")
  const digest = candidateDigest(f.candidate), preview = await handler('preview', { experiment_id: id, entry_path: entry })
  write(f.root, `${base}/${entry}`, 'export function apply(){return 2}\n')
  assert.equal((await handler('build', { experiment_id: id, entry_path: entry, expected_candidate_sha256: digest, expected_preview_sha256: preview.value.preview_sha256 })).error.code, 'conflict')
  assert.equal(existsSync(join(f.candidate, entry.replace('.ts', '.mjs'))), false)
  write(f.root, 'outside.ts', 'export const secret=1\n')
  write(f.root, `${base}/${entry}`, `export {secret} from ${JSON.stringify(join(f.root, 'outside.ts'))}\n`)
  assert.equal((await handler('preview', { experiment_id: id, entry_path: entry })).ok, false)
})
test('普通EXP生成制品复用原生Cordis、消息工厂与工具输出校验，workflow SDK保留真实执行摘要', async t => {
  const f = fixture(t), handler = createAssetBuildHandler(f.root)
  const marker = join(f.root, 'source-script-ran')
  write(f.root, `${base}/package.json`, JSON.stringify({ scripts: { build: `touch ${marker}` } }))
  write(f.root, `${base}/${entry}`, "import {Context} from '@deepseek-ai/cordis'; import {createUserMessage} from '@deepseek-ai/dsh-llm'; import {validateJsonSchemaValue,ToolOutputError} from '@deepseek-ai/dsh-tools'; export const name='alpha'; export const inject=[]; export function apply(){return {Context,createUserMessage,validateJsonSchemaValue,ToolOutputError}}; export function message(text:string){return createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})}; export function output(value:unknown){const violations=validateJsonSchemaValue({type:'object',properties:{quantity:{type:'integer'}},required:['quantity'],additionalProperties:false},value);if(violations.length)throw new ToolOutputError('guarded',violations);return value}\n")
  let preview = await handler('preview', { experiment_id: id, entry_path: entry })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  let result = await handler('build', { experiment_id: id, entry_path: entry, expected_candidate_sha256: preview.value.candidate_sha256, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(result.ok, true, JSON.stringify(result))
  const plugin = await import(`file://${join(f.candidate, result.value.output_path)}`)
  const require = createRequire(import.meta.url), nativeRequire = createRequire(require.resolve('@deepseek-ai/dsh-api-session-controller'))
  const { Context } = await import(new URL(require.resolve('@deepseek-ai/cordis'), 'file:').href)
  const { createUserMessage } = await import(new URL(nativeRequire.resolve('@deepseek-ai/dsh-llm'), 'file:').href)
  const { validateJsonSchemaValue, ToolOutputError } = await import(new URL(nativeRequire.resolve('@deepseek-ai/dsh-tools'), 'file:').href)
  assert.deepEqual(plugin.apply(), { Context, createUserMessage, validateJsonSchemaValue, ToolOutputError })
  const message = plugin.message('来自真实原生工厂')
  assert.equal(message.role, 'user'); assert.equal(typeof message.id, 'string'); assert.ok(message.id)
  assert.deepEqual(message.content, [{ type: 'text', text: '来自真实原生工厂' }])
  assert.equal(Object.isFrozen(message), true); assert.equal(Object.isFrozen(message.content[0]), true)
  assert.deepEqual(plugin.output({ quantity: 12 }), { quantity: 12 })
  assert.throws(() => plugin.output({ quantity: 'wrong' }), error => error instanceof ToolOutputError && error.violations.length > 0)
  assert.equal(existsSync(marker), false)
  write(f.root, `${base}/${entry}`, "import {defineWorkflow,registerWorkflowTool} from '@harness-platform/workflow-runtime'; export const name='graph'; export const inject=['tools','llm']; export function apply(ctx:any){registerWorkflowTool(ctx,defineWorkflow({id:'route',toolName:'route',description:'route',inputSchema:{type:'object'},async run(c){return c.input.quantity>=10?{route:'bulk'}:{route:'regular'}}}))}\n")
  preview = await handler('preview', { experiment_id: id, entry_path: entry })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  result = await handler('build', { experiment_id: id, entry_path: entry, expected_candidate_sha256: preview.value.candidate_sha256, expected_preview_sha256: preview.value.preview_sha256 })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.value.platform_sources.some(item => item.path === 'platform/plugin/src/workflows/runtime.ts'))
  const graph = await import(`file://${join(f.candidate, result.value.output_path)}?graph`)
  let tool; graph.apply({ tools: { register(value) { tool = value } } })
  const response = await tool.execute({ quantity: 10 }, { signal: new AbortController().signal, callId: 'actual', token: Symbol(), agent: { session: { id: 'session' } } })
  assert.equal(response.ok, true); assert.equal(response.result.route, 'bulk')
  assert.equal(response.graph_execution.build_digest, result.value.build_digest)
  assert.equal(response.graph_execution.esm_sha256, result.value.esm_sha256)
  assert.equal(inspectAssetBuild(f.root, id).verified, true)
})
function fakeEnvironment(f, extra = {}) {
  const identity = spawnSync('/usr/bin/python3.10', [join(process.env.HARNESS_PROGRAM_ROOT, 'runtime/adapters/dsh-container/source_contract.py'), '--image-identity-for', 'linux/amd64'], { encoding: 'utf8' })
  assert.equal(identity.status, 0, identity.stderr)
  const parsed = JSON.parse(identity.stdout), tag = extra.sourceTag ?? parsed.tag, fingerprint = parsed.fingerprint, calls = [], imageId = `sha256:${'a'.repeat(64)}`
  const command = async (name, args, options) => {
    calls.push({ name, args })
    if (args.includes('--image-identity-for')) return JSON.stringify({ tag, fingerprint })
    if (name === 'docker' && args[0] === 'image') return JSON.stringify({ Id: imageId, Config: { Labels: { 'org.ai-agent-harness.dsh.image-build-fingerprint': fingerprint } } })
    if (name === 'docker' && args.includes('python3')) return JSON.stringify(extra.target ?? { python_version: '3.11.2', python_abi: 'cp311', os: 'linux', libc: 'glibc-2.36', architecture: 'x86_64' })
    if (name === 'docker' && args.includes('npm')) {
      const volume = args[args.indexOf('-v') + 1], directory = volume.slice(0, -':/prepare:rw'.length)
      assert.deepEqual(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).scripts, {})
      assert.ok(args.includes('--ignore-scripts'))
      if (args.includes('--package-lock-only')) write(directory, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/example': { version: '1.2.3', resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz', integrity: 'sha512-test' } } }))
      else {
        write(directory, 'node_modules/example/package.json', '{"name":"example","version":"1.2.3","types":"index.d.ts","main":"index.js"}')
        write(directory, 'node_modules/example/index.d.ts', 'export declare const value:number\n')
        write(directory, 'node_modules/example/index.js', 'exports.value=3\n')
        await extra.afterInstall?.()
      }
      return ''
    }
    if (extra.command) return extra.command(name, args, options)
    throw new Error(`Unexpected command ${name} ${args}`)
  }
  return { calls, command, imageId, tag }
}
function standaloneCache(f, dependency) {
  const resources = join(f.root, '.local/export-resources'), destination = join(resources, 'dependencies', dependency.path, dependency.kind === 'python' ? 'site-packages' : 'node_modules')
  mkdirSync(dirname(destination), { recursive: true }); cpSync(dependency.modulesPath, destination, { recursive: true })
  write(resources, 'resources.json', JSON.stringify({ image: { tag: dependency.preparedTarget?.image, id: dependency.preparedTarget?.imageId },
    dependencies: [{ path: dependency.path, lockSha256: dependency.lockSha256, preparedTarget: dependency.preparedTarget }] }))
  rmSync(join(f.root, '.local/asset-dependencies', id, 'current.json'))
  return { resources, destination }
}
test('Node精确锁生成与只读挂载回执可供普通构建使用，篡改和镜像变化保持pending', async t => {
  const f = fixture(t)
  write(f.root, `${base}/dsh/managed/plugin/package.json`, JSON.stringify({ name: 'plugin', dependencies: { example: '^1.2.0' }, scripts: { preinstall: 'never execute' } }))
  assert.equal(resolvePreparedAssetDependencies(f.root, id).status, 'pending')
  const env = fakeEnvironment(f), prepared = await createAssetDependenciesHandler(f.root, { command: env.command })({ experiment_id: id })
  assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.equal(prepared.value.status, 'ready')
  assert.deepEqual(prepared.value.generated_locks, ['dsh/managed/plugin/package-lock.json'])
  assert.equal(prepared.value.mounts[0].target, '/opt/dsh-managed/plugin/node_modules')
  assert.equal(resolvePreparedAssetDependencies(f.root, id, { image_id: 'other' }).status, 'pending')
  write(f.root, `${base}/${entry}`, "import {value} from 'example'; export function apply(){return value}\n")
  assert.equal((await createAssetBuildHandler(f.root)('preview', { experiment_id: id, entry_path: entry })).ok, true)
  write(f.root, `${base}/dsh/managed/other/index.ts`, "import {value} from 'example'; export function apply(){return value}\n")
  assert.equal((await createAssetBuildHandler(f.root)('preview', { experiment_id: id, entry_path: 'dsh/managed/other/index.ts' })).ok, false)
  const snapshot = inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online' })
  assert.equal(snapshot.dependencies.find(item => item.path === 'managed/plugin').modulesPath, prepared.value.mounts[0].source)
  assert.equal(snapshot.dependencies.find(item => item.path === 'managed/plugin').ready, true)
  const dependency = snapshot.dependencies.find(item => item.path === 'managed/plugin'), cache = standaloneCache(f, dependency)
  const standalone = () => inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online', resourcesDir: cache.resources }).dependencies.find(item => item.path === dependency.path)
  assert.equal(standalone().modulesPath, cache.destination); assert.equal(standalone().ready, true)
  assert.deepEqual(standalone().preparedTarget, dependency.preparedTarget)
  write(f.root, `${base}/dsh/managed/plugin/package-lock.json`, '{}\n')
  assert.equal(standalone().ready, false)
  write(prepared.value.mounts[0].source, 'example/index.js', 'changed')
  assert.equal(resolvePreparedAssetDependencies(f.root, id).status, 'pending')
})
test('Node安装Hook依赖和不完整声明选择不能报告准备完成', async t => {
  const f = fixture(t)
  write(f.root, `${base}/dsh/managed/plugin/package.json`, '{"dependencies":{"example":"1.2.3"}}')
  let env
  env = fakeEnvironment(f, { afterInstall() {
    const call = env.calls.find(call => call.args.includes('--package-lock-only')), directory = call.args[call.args.indexOf('-v') + 1].slice(0, -':/prepare:rw'.length)
    const lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8')); lock.packages['node_modules/example'].hasInstallScript = true
    write(directory, 'package-lock.json', JSON.stringify(lock))
  } })
  const handler = createAssetDependenciesHandler(f.root, { command: env.command })
  assert.equal((await handler({ experiment_id: id, declaration_paths: [] })).error.code, 'invalid_request')
  const result = await handler({ experiment_id: id })
  assert.equal(result.ok, false); assert.match(result.error.message, /安装 Hook/)
  assert.equal(existsSync(join(f.candidate, 'dsh/managed/plugin/package-lock.json')), false)
  assert.equal(resolvePreparedAssetDependencies(f.root, id).status, 'pending')
})
test('Managed根级声明按Node祖先目录规则供子插件使用', async t => {
  const f = fixture(t)
  write(f.root, `${base}/dsh/managed/package.json`, '{"dependencies":{"example":"1.2.3"}}')
  write(f.root, `${base}/${entry}`, "import {value} from 'example'; export function apply(){return value}\n")
  const env = fakeEnvironment(f), prepared = await createAssetDependenciesHandler(f.root, { command: env.command })({ experiment_id: id })
  assert.equal(prepared.value.mounts[0].target, '/opt/dsh-managed/node_modules')
  assert.equal((await createAssetBuildHandler(f.root)('preview', { experiment_id: id, entry_path: entry })).ok, true)
  const snapshot = inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online' })
  assert.equal(snapshot.dependencies.find(item => item.path === 'managed').ready, true)
  const cache = standaloneCache(f, snapshot.dependencies.find(item => item.path === 'managed'))
  assert.equal(inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online', resourcesDir: cache.resources }).dependencies.find(item => item.path === 'managed').ready, true)
})
test('Workspace根级Node依赖使用独立挂载并可由资源缓存恢复', async t => {
  const f = fixture(t)
  write(f.root, `${base}/dsh/workspace/package.json`, '{"dependencies":{"example":"1.2.3"}}')
  const env = fakeEnvironment(f), prepared = await createAssetDependenciesHandler(f.root, { command: env.command })({ experiment_id: id })
  assert.equal(prepared.value.mounts[0].target, '/work/harness/workspace/node_modules')
  const input = { programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online' }
  const dependency = inspectAgentSnapshot(input).dependencies.find(item => item.path === 'workspace')
  assert.equal(dependency.ready, true)
  const cache = standaloneCache(f, dependency)
  assert.equal(inspectAgentSnapshot({ ...input, resourcesDir: cache.resources }).dependencies.find(item => item.path === 'workspace').ready, true)
})
test('独立部署不会复用另一标准Runtime准备的业务依赖', async t => {
  const f = fixture(t)
  write(f.root, `${base}/dsh/managed/plugin/package.json`, '{"dependencies":{"example":"1.2.3"}}')
  const env = fakeEnvironment(f, { sourceTag: 'old-standard-runtime' })
  assert.equal((await createAssetDependenciesHandler(f.root, { command: env.command })({ experiment_id: id })).value.status, 'ready')
  const snapshot = inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online' })
  assert.equal(snapshot.dependencies.find(item => item.path === 'managed/plugin').ready, false)
})
test('准备期间Candidate变化不写锁；并行请求不会解除另一个请求的锁', async t => {
  const f = fixture(t)
  write(f.root, `${base}/dsh/managed/plugin/package.json`, '{"dependencies":{"example":"1.2.3"}}')
  let release, entered
  const reached = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const env = fakeEnvironment(f, { async afterInstall() { entered(); await gate } }), handler = createAssetDependenciesHandler(f.root, { command: env.command })
  const first = handler({ experiment_id: id }); await reached
  assert.equal((await handler({ experiment_id: id })).error.code, 'conflict')
  assert.equal((await handler({ experiment_id: id })).error.code, 'conflict')
  write(f.root, `${base}/new-file.txt`, '并行变化'); release()
  assert.equal((await first).error.code, 'conflict')
  assert.equal(existsSync(join(f.candidate, 'dsh/managed/plugin/package-lock.json')), false)
})
test('未准备Python和本地安装来源保持真实pending，不执行来源脚本', async t => {
  const f = fixture(t), env = fakeEnvironment(f)
  write(f.root, `${base}/dsh/managed/python/requirements.txt`, '-e /untrusted/project\n')
  const result = await createAssetDependenciesHandler(f.root, { command: env.command })({ experiment_id: id })
  assert.equal(result.ok, false); assert.equal(result.value.status, 'pending')
  assert.match(result.error.message, /Python 依赖/)
  assert.equal(existsSync(join(f.candidate, 'dsh/managed/python/requirements.lock.txt')), false)
})
test('Python extras声明按目标ABI下载wheel，生成锁后与普通实例及独立部署共用', async t => {
  const f = fixture(t), python = '/usr/bin/python3.10', declaration = 'dsh/managed/python/pyproject.toml'
  write(f.root, `${base}/${declaration}`, '[project]\nname="python-tool"\nversion="1.0.0"\ndependencies = ["quote-tool[extra]==1.2.3"]\n[build-system]\nbuild-backend="must-not-execute"\n')
  const env = fakeEnvironment(f, { command(name, args) {
    if (args.includes('download')) {
      assert.ok(args.includes('--only-binary=:all:')); assert.equal(args[args.indexOf('--abi') + 1], 'cp311')
      assert.equal(readFileSync(args[args.indexOf('-r') + 1], 'utf8'), 'quote-tool[extra]==1.2.3\n')
      const wheel = zipSync({ 'quote_tool/__init__.py': strToU8('VALUE = 42\n'), 'quote_tool-1.2.3.dist-info/METADATA': strToU8('Name: quote-tool\nVersion: 1.2.3\n'), 'quote_tool-1.2.3.dist-info/WHEEL': strToU8('Wheel-Version: 1.0\nTag: py3-none-any\n') })
      write(args[args.indexOf('--dest') + 1], 'quote_tool-1.2.3-py3-none-any.whl', wheel)
      return ''
    }
    const result = spawnSync(python, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout
  } })
  const old = process.env.HARNESS_PYTHON; process.env.HARNESS_PYTHON = python
  t.after(() => { if (old === undefined) delete process.env.HARNESS_PYTHON; else process.env.HARNESS_PYTHON = old })
  const prepared = await createAssetDependenciesHandler(f.root, { command: env.command })({ experiment_id: id })
  assert.equal(prepared.ok, true, JSON.stringify(prepared)); assert.equal(prepared.value.status, 'ready')
  assert.match(readFileSync(join(f.candidate, 'dsh/managed/python/requirements.lock.txt'), 'utf8'), /^quote-tool==1\.2\.3 --hash=sha256:[a-f0-9]{64}\n$/)
  assert.match(prepared.value.environment.PYTHONPATH, /^\/opt\/harness-python\/[a-f0-9]+\/site-packages$/)
  const imported = spawnSync(python, ['-c', 'import quote_tool;print(quote_tool.VALUE)'], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: prepared.value.mounts[0].source, PYTHONDONTWRITEBYTECODE: '1' } })
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout.trim(), '42')
  const snapshot = inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online' })
  assert.equal(snapshot.dependencies.find(item => item.path === 'python/managed/python').modulesPath, prepared.value.mounts[0].source)
  assert.equal(snapshot.dependencies.find(item => item.path === 'python/managed/python').ready, true)
  const dependency = snapshot.dependencies.find(item => item.path === 'python/managed/python'), cache = standaloneCache(f, dependency)
  const standalone = () => inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'amd64', mode: 'online', resourcesDir: cache.resources }).dependencies.find(item => item.path === dependency.path)
  assert.equal(standalone().modulesPath, cache.destination); assert.equal(standalone().ready, true)
  assert.deepEqual(standalone().preparedTarget, dependency.preparedTarget)
  write(f.root, `${base}/${declaration}`, readFileSync(join(f.candidate, declaration), 'utf8') + '# changed\n')
  assert.equal(standalone().ready, false)
  assert.equal(inspectAgentSnapshot({ programRoot: process.env.HARNESS_PROGRAM_ROOT, assetRoot: f.root, experimentId: id, agentId: 'alpha', arch: 'arm64', mode: 'online' }).dependencies[0].ready, false)
})
test('来源宣称已准备Python时仍核对wheel平台、Python ABI与标准镜像指纹', async t => {
  const f = fixture(t), declaration = 'dsh/managed/python/requirements.txt'
  write(f.root, `${base}/${declaration}`, 'quote-tool==1.2.3\n')
  write(f.root, `${base}/dsh/managed/python/requirements.lock.txt`, 'quote-tool==1.2.3 --hash=sha256:' + 'c'.repeat(64) + '\n')
  const preparedPath = '.local/prepared/site-packages'
  write(f.root, `${preparedPath}/quote_tool/__init__.py`, 'VALUE=42\n')
  write(f.root, `${preparedPath}/quote_tool-1.2.3.dist-info/METADATA`, 'Name: quote-tool\nVersion: 1.2.3\n')
  write(f.root, `${preparedPath}/quote_tool-1.2.3.dist-info/WHEEL`, 'Tag: cp311-cp311-manylinux_2_39_x86_64\n')
  const env = fakeEnvironment(f), handler = createAssetDependenciesHandler(f.root, { command: env.command })
  const target = { image: env.tag, image_id: env.imageId, python_version: '3.11.2', python_abi: 'cp311', os: 'linux', libc: 'glibc-2.36', architecture: 'x86_64' }
  const request = { experiment_id: id, prepared_python: [{ declaration_path: declaration, path: preparedPath, target }] }
  const incompatible = await handler(request); assert.equal(incompatible.ok, false); assert.match(incompatible.error.message, /ABI|libc/)
  write(f.root, `${preparedPath}/quote_tool-1.2.3.dist-info/WHEEL`, 'Tag: py3-none-any\n')
  assert.equal((await handler(request)).value.status, 'ready')
  request.prepared_python[0].target = { ...target, python_abi: 'cp310' }
  assert.equal((await handler(request)).ok, false)
})
