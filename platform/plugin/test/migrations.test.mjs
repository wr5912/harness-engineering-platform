import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'
import { dump, load } from 'js-yaml'

const program = resolve(new URL('../../../', import.meta.url).pathname)
process.env.HARNESS_PROGRAM_ROOT = program
process.env.HARNESS_PYTHON = '/usr/bin/python3.10'
const built = mkdtempSync(join(tmpdir(), 'migrations-module-'))
await build({ entryPoints: [new URL('../src/agents/migrations.ts', import.meta.url).pathname], outfile: join(built, 'migrations.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createMigrationsHandler } = await import(`file://${join(built, 'migrations.mjs')}`)
await build({ entryPoints: [new URL('../src/agents/asset-build.ts', import.meta.url).pathname], outfile: join(built, 'asset-build.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createAssetBuildHandler } = await import(`file://${join(built, 'asset-build.mjs')}`)
test.after(() => rmSync(built, { recursive: true, force: true }))
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
const write = (root, path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'migration-data-')), source = mkdtempSync(join(tmpdir(), 'migration-source-'))
  for (const path of ['agents', 'evolution/experiments']) mkdirSync(join(root, path), { recursive: true })
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(source, { recursive: true, force: true }) })
  return { root, source, handler: createMigrationsHandler(root) }
}
const cases = [{ id: 'U-MIGRATION-001', title: '保留工作职责', inputs: '请说明分析步骤。', expected_behavior: '先读取用户提供的材料，再给出分析步骤。', fast: true }]
async function sourceAndPreview(fx, overrides = {}) {
  write(fx.source, 'role.md', '先读取用户提供的材料，再给出分析步骤。\n')
  write(fx.source, 'lookup.dat', Buffer.from([0, 1, 2, 3, 255]))
  const source = success(await fx.handler('inspect', { source: { kind: 'local', path: fx.source } }))
  const binary = source.entries.find(entry => entry.path === 'lookup.dat')
  const preview = success(await fx.handler('preview', { source_id: source.source_id, fingerprint: source.fingerprint, target: { kind: 'new-agent', agent_id: 'migrated-agent', name: '材料分析助手', description: '读取材料并分析步骤。', role: '读取用户材料，再分析步骤。' }, files: [{ path: 'dsh/workspace/AGENTS.md', content: '# 材料分析助手\n\n读取用户提供的材料，再给出分析步骤。\n' }, { path: 'dsh/managed/lookup.dat', source_path: 'lookup.dat', source_sha256: binary.sha256 }], mapping: [{ source: 'role.md', target: 'dsh/workspace/AGENTS.md', status: 'converted' }], evaluation_cases: cases, ...overrides }))
  return { source, preview }
}
function git(root, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}
function appendCase(fx, id, expected) {
  const file = join(fx.root, 'agents/migrated-agent/evaluation.md')
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n#### ${id} 补齐迁移行为\n\n**用户输入**\n\n> 请执行并说明：${expected}\n\n**预期**\n\n${expected}\n`)
}
function recordedRun(fx, id, digest, caseIds, run = 'run-22222222-2222-4222-8222-222222222222') {
  // 这里构造既有 Run 文件合同，以验证完成状态消费逻辑；并非真实模型验收。
  const parsed = spawnSync('/usr/bin/python3.10', ['-c', 'import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from evaluation_contract import load_evaluation;print(json.dumps(load_evaluation(Path(sys.argv[2]))))', join(program, 'runtime/research'), join(fx.root, 'agents/migrated-agent/evaluation.md')], { encoding: 'utf8' })
  assert.equal(parsed.status, 0, parsed.stderr)
  const contracts = JSON.parse(parsed.stdout).cases, path = `evolution/experiments/${id}/runs/${run}`
  const json = (file, value) => write(fx.root, `${path}/${file}`, JSON.stringify(value))
  write(fx.root, `${path}/run.yaml`, dump({ run_id: run, experiment_id: id, agent_id: 'migrated-agent', source_id: `experiment:${id}`, status: 'completed' }))
  json('inputs.lock.json', { source_id: `experiment:${id}`, executor: 'api', candidate_sha256: digest, evaluation_cases: caseIds.map(caseId => contracts[caseId]), review_mode: 'none' })
  json('summary.json', { run_id: run, effective_verdict: 'passed', source_verification: { status: 'matched' } })
  write(fx.root, `${path}/results.jsonl`, caseIds.map(caseId => JSON.stringify({ run_id: run, input_id: caseId, execution_status: 'completed', verdict: 'passed' })).join('\n') + '\n')
  for (const caseId of caseIds) {
    json(`evidence/${caseId}/checks.json`, { session_id: `dsh-session-${caseId}`, preset_matches: true, workspace_matches: true })
    json(`evidence/${caseId}/response.json`, { assistant_texts: ['按用例完成当前任务。'] })
  }
}

test('迁移用例输入错误指出具体字段，未创建目标资产', async t => {
  const fx = fixture(t)
  const source = success(await fx.handler('inspect', { source: { kind: 'text', filename: 'role.md', text: '材料分析角色。' } }))
  const { inputs, ...missingInputs } = cases[0]
  const result = await fx.handler('preview', { source_id: source.source_id, fingerprint: source.fingerprint,
    target: { kind: 'new-agent', agent_id: 'migrated-agent', name: '材料分析助手', description: '读取材料。', role: '读取材料。' },
    files: [{ path: 'dsh/workspace/AGENTS.md', content: '读取材料。' }], mapping: [{ source: 'role.md', target: 'dsh/workspace/AGENTS.md', status: 'converted' }], evaluation_cases: [missingInputs] })
  assert.equal(result.ok, false); assert.match(result.error.message, /evaluation_cases\.0\.inputs/)
  assert.equal(existsSync(join(fx.root, 'agents/migrated-agent')), false)
})

test('五类识别器只清点文件和版本，不执行来源脚本；来源快照读取固定摘要', async t => {
  const fx = fixture(t)
  const examples = [
    ['opencode.json', '{"$schema":"https://opencode.ai/config.json","agent":{"review":{"prompt":"只读审阅"}}}', 'OpenCode'],
    ['agent.py', 'from agentscope.agent import ReActAgent\n', 'AgentScope'],
    ['agent.cordis.yml', '- id: "@deepseek-ai/dsh-agent"\n', 'DSH'],
    ['chain.py', 'from langchain.agents import create_agent\n', 'LangChain'],
    ['graph.py', 'from langgraph.graph import StateGraph\n', 'LangGraph'],
  ]
  for (const [filename, content, framework] of examples) {
    const source = success(await fx.handler('inspect', { source: { kind: 'text', filename, text: content } }))
    assert.ok(source.frameworks.includes(framework), framework)
    const read = success(await fx.handler('read', { source_id: source.source_id, fingerprint: source.fingerprint, path: filename }))
    assert.equal(read.content, content); assert.equal(read.redacted, false)
  }
  write(fx.source, 'package.json', JSON.stringify({ name: 'untrusted-source', version: '1.2.3', scripts: { postinstall: 'touch SHOULD-NOT-EXIST' }, dependencies: { '@langchain/langgraph': '1.5.0' } }))
  write(fx.source, '.env', 'DEEPSEEK_API_KEY=do-not-copy')
  write(fx.source, 'settings.json', '{"apiKey":"sk-0123456789abcdef0123456789"}')
  write(fx.source, 'cache/result.json', '{}')
  write(fx.source, 'model.safetensors', 'unmodified weights')
  const source = success(await fx.handler('inspect', { source: { kind: 'local', path: fx.source } }))
  assert.equal(source.versions['package.json'].version, '1.2.3')
  for (const path of ['.env', 'settings.json', 'cache', 'model.safetensors']) assert.ok(source.entries.find(entry => entry.path === path)?.excluded, path)
  assert.equal(existsSync(join(fx.source, 'SHOULD-NOT-EXIST')), false)
  assert.equal(existsSync(join(fx.root, '.local/migrations/sources', source.source_id, 'files/settings.json')), false)
  write(fx.source, 'package.json', '{}')
  const read = success(await fx.handler('read', { source_id: source.source_id, fingerprint: source.fingerprint, path: 'package.json' }))
  assert.match(read.content, /1\.2\.3/)
  assert.equal((await fx.handler('read', { source_id: source.source_id, fingerprint: 'a'.repeat(64), path: 'package.json' })).error.code, 'conflict')
})

test('五个完整来源样例保持框架、依赖版本、技能引用和项目目录', async t => {
  const fx = fixture(t), fixtures = new URL('./fixtures/agent-migration/', import.meta.url).pathname
  for (const [name, framework, entry, pattern] of [
    ['dsh', 'DSH', 'package.json', /0\.2\.1-rc\.2/],
    ['opencode', 'OpenCode', 'opencode.json', /reviewer/],
    ['agentscope', 'AgentScope', 'pyproject.toml', /agentscope==2\.0\.11/],
    ['langchain', 'LangChain', 'package.json', /"langchain":"1\.6\.0"/],
    ['langgraph', 'LangGraph', 'graph.ts', /addEdge\(\['calc_tax', 'calc_shipping'\], 'join'\)/],
  ]) {
    const source = success(await fx.handler('inspect', { source: { kind: 'local', path: join(fixtures, name) } }))
    assert.ok(source.frameworks.includes(framework), `${name}: ${source.frameworks.join(',')}`)
    assert.match(success(await fx.handler('read', { source_id: source.source_id, fingerprint: source.fingerprint, path: entry })).content, pattern)
    if (name === 'dsh') {
      assert.equal(source.versions['package.json'].engines.dsh, '0.2.1-rc.2')
      assert.ok(source.entries.some(file => file.path === '.agents/skills/quote/references/pricing.md' && file.sha256))
    }
    if (name === 'opencode') {
      assert.equal(source.versions['package.json'].devDependencies['opencode-ai'], '1.19.5')
      assert.ok(source.entries.some(file => file.path === 'project/total.test.ts' && file.sha256))
    }
    if (name === 'langgraph') assert.equal(source.versions['package.json'].dependencies['@langchain/langgraph'], '1.5.0')
  }
})

test('分页读取显式续读与来源元信息摘要绑定，非法偏移不会静默遗漏正文', async t => {
  const fx = fixture(t), source = success(await fx.handler('inspect', { source: { kind: 'text', text: '完整的角色指令和工具引用。' } }))
  const first = success(await fx.handler('read', { source_id: source.source_id, fingerprint: source.fingerprint, path: 'source.txt', limit: 4 }))
  assert.equal(first.content, '完整的角'); assert.equal(first.next_offset, 4)
  const second = success(await fx.handler('read', first.read_input))
  assert.equal(second.offset, 4); assert.equal(second.content, '色指令和')
  assert.equal((await fx.handler('read', { ...first.read_input, offset: 1000 })).ok, false)
  const manifest = join(fx.root, '.local/migrations/sources', source.source_id, 'manifest.json'), stored = JSON.parse(readFileSync(manifest))
  stored.frameworks = ['DSH']; writeFileSync(manifest, JSON.stringify(stored))
  assert.equal((await fx.handler('read', first.read_input)).error.code, 'conflict')
})

test('ZIP、TAR和Git都固定原始来源；归档越界、链接和凭据不能成为目标资产', async t => {
  const fx = fixture(t), archive = join(fx.source, 'source.zip')
  writeFileSync(archive, zipSync({ 'agent.md': strToU8('明确职责。'), 'sessions/trace.json': strToU8('{}') }))
  const zipped = success(await fx.handler('inspect', { source: { kind: 'archive', path: archive } }))
  assert.equal(success(await fx.handler('read', { source_id: zipped.source_id, fingerprint: zipped.fingerprint, path: 'agent.md' })).content, '明确职责。')
  assert.ok(zipped.entries.find(entry => entry.path === 'sessions/trace.json').excluded)
  writeFileSync(archive, zipSync({ '../outside': strToU8('bad') }))
  assert.equal((await fx.handler('inspect', { source: { kind: 'archive', path: archive } })).ok, false)
  write(fx.source, 'agent.md', '固定职责。')
  const tar = join(fx.source, 'source.tar')
  assert.equal(spawnSync('tar', ['-cf', tar, '-C', fx.source, 'agent.md']).status, 0)
  const tarred = success(await fx.handler('inspect', { source: { kind: 'archive', path: tar } }))
  assert.equal(tarred.entries[0].path, 'agent.md')
  git(fx.source, ['init']); git(fx.source, ['config', 'user.name', 'Fixture']); git(fx.source, ['config', 'user.email', 'fixture@example.invalid'])
  git(fx.source, ['add', 'agent.md']); git(fx.source, ['commit', '-m', '固定来源'])
  const commit = git(fx.source, ['rev-parse', 'HEAD'])
  const fixed = success(await fx.handler('inspect', { source: { kind: 'git', path: fx.source, ref: 'HEAD' } }))
  assert.equal(fixed.provenance.commit, commit)
  assert.equal(success(await fx.handler('read', { source_id: fixed.source_id, fingerprint: fixed.fingerprint, path: 'agent.md' })).content, '固定职责。')
})

test('ZIP保留Unix执行位且排除链接与特殊项；重复路径不被后项静默覆盖', async t => {
  const fx = fixture(t), archive = join(fx.source, 'source.zip'), script = '#!/bin/sh\nprintf checked\n'
  writeFileSync(archive, zipSync({
    'scripts/check.sh': [strToU8(script), { os: 3, attrs: 0o100755 << 16 }],
    'role.md': [strToU8('按请求使用固定脚本。'), { os: 3, attrs: 0o100644 << 16 }],
    'linked.sh': [strToU8('scripts/check.sh'), { os: 3, attrs: 0o120777 << 16 }],
    'named-pipe': [new Uint8Array(), { os: 3, attrs: 0o010644 << 16 }],
  }))
  const source = success(await fx.handler('inspect', { source: { kind: 'archive', path: archive } }))
  const entry = source.entries.find(item => item.path === 'scripts/check.sh')
  assert.equal(entry.mode, 0o755)
  for (const name of ['linked.sh', 'named-pipe']) {
    assert.match(source.entries.find(item => item.path === name).excluded, /链接或特殊/)
    assert.equal((await fx.handler('read', { source_id: source.source_id, fingerprint: source.fingerprint, path: name })).error.code, 'source_rejected')
    assert.equal(existsSync(join(fx.root, '.local/migrations/sources', source.source_id, 'files', name)), false)
  }
  const preview = success(await fx.handler('preview', { source_id: source.source_id, fingerprint: source.fingerprint,
    target: { kind: 'new-agent', agent_id: 'migrated-agent', name: '脚本助手', description: '按请求使用固定脚本。', role: '按请求使用固定脚本。' },
    files: [{ path: 'dsh/workspace/scripts/check.sh', source_path: entry.path, source_sha256: entry.sha256 }],
    mapping: [{ source: entry.path, target: 'dsh/workspace/scripts/check.sh', status: 'native' }],
  }))
  success(await fx.handler('apply', preview.apply_input))
  const copied = join(fx.root, 'evolution/experiments', preview.experiment_id, 'candidate/dsh/workspace/scripts/check.sh')
  assert.equal(lstatSync(copied).mode & 0o777, 0o755); assert.equal(readFileSync(copied, 'utf8'), script)
  const duplicate = Buffer.from(zipSync({ 'first.txt': strToU8('first'), 'other.txt': strToU8('other') }))
  for (let offset = duplicate.indexOf('other.txt'); offset !== -1; offset = duplicate.indexOf('other.txt', offset + 9)) duplicate.write('first.txt', offset)
  writeFileSync(archive, duplicate)
  const rejected = await fx.handler('inspect', { source: { kind: 'archive', path: archive } })
  assert.equal(rejected.ok, false); assert.match(rejected.error.message, /重复路径/)
  writeFileSync(archive, duplicate.subarray(0, duplicate.length - 4))
  assert.equal((await fx.handler('inspect', { source: { kind: 'archive', path: archive } })).ok, false)
})

test('新Agent由标准创建工具生成EXP，二进制引用复制，预览不发布，幂等且回执可复现', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx)
  assert.match(preview.experiment_id, /^EXP-migrated-agent-001-r[0-9a-f]{12}$/)
  assert.equal(existsSync(join(fx.root, 'agents/migrated-agent')), false)
  const prepared = success(await fx.handler('status', { operation_id: preview.operation_id }))
  assert.equal(prepared.published, false); assert.equal(prepared.state, 'prepared')
  const applied = success(await fx.handler('apply', preview.apply_input))
  assert.equal(applied.published, true); assert.equal(applied.business_verified, false)
  const exp = `evolution/experiments/${preview.experiment_id}`
  assert.equal(preview.target_source.source_id, `experiment:${preview.experiment_id}`)
  assert.equal(preview.target_source.preset, 'migrated-agent/agent.cordis.yml')
  assert.equal(preview.target_source.candidate_root, `${exp}/candidate/dsh`)
  assert.equal(preview.generated_configuration.length, 3)
  for (const file of preview.generated_configuration) {
    const actual = readFileSync(join(fx.root, file.path))
    assert.equal(file.content, actual.toString('utf8'))
    assert.equal(file.sha256, createHash('sha256').update(actual).digest('hex'))
    assert.equal(file.read_input.experiment_id, preview.experiment_id)
  }
  assert.equal(preview.build_contract.preview_action, 'assets/build-preview')
  assert.equal(preview.build_contract.sdk.module, '@harness-platform/workflow-runtime')
  for (const symbol of ['StateGraph', 'defineWorkflow', 'registerWorkflowTool']) assert.ok(preview.build_contract.sdk.exports.includes(symbol))
  assert.match(preview.build_contract.sdk.context.infer, /context\.infer/)
  assert.deepEqual(readFileSync(join(fx.root, exp, 'candidate/dsh/managed/lookup.dat')), Buffer.from([0, 1, 2, 3, 255]))
  const manifest = load(readFileSync(join(fx.root, 'agents/migrated-agent/manifest.yaml'), 'utf8'))
  assert.equal(manifest.active_experiment, preview.experiment_id)
  const harness = load(readFileSync(join(fx.root, exp, 'candidate/harness.yaml'), 'utf8'))
  assert.deepEqual(harness.role_instructions, { 'migrated-agent': 'dsh/workspace/AGENTS.md' })
  const receipt = JSON.parse(readFileSync(join(fx.root, exp, 'evaluation/evidence/migration.json')))
  assert.equal(receipt.source.fingerprint, preview.fingerprint)
  assert.equal(receipt.candidate_sha256, applied.candidate_sha256)
  assert.equal(success(await fx.handler('apply', preview.apply_input)).already_applied, true)
  rmSync(join(fx.root, '.local/migrations'), { recursive: true })
  const restored = success(await createMigrationsHandler(fx.root)('status', { experiment_id: preview.experiment_id }))
  assert.equal(restored.candidate_changed_since_migration, false)
})

test('原生 !!js 仅静态解析且固定来源脚本保留执行位，不在迁移期间执行', async t => {
  const fx = fixture(t)
  write(fx.source, 'scripts/helper.sh', '#!/bin/sh\nprintf checked\n')
  chmodSync(join(fx.source, 'scripts/helper.sh'), 0o755)
  const source = success(await fx.handler('inspect', { source: { kind: 'local', path: fx.source } })), entry = source.entries.find(file => file.path === 'scripts/helper.sh')
  const preview = success(await fx.handler('preview', { source_id: source.source_id, fingerprint: source.fingerprint,
    target: { kind: 'new-agent', agent_id: 'migrated-agent', name: '脚本助手', description: '按请求执行固定脚本。', role: '按用户请求使用脚本。' },
    files: [
      { path: 'dsh/presets/migrated-agent/agent.cordis.yml', content: '- id: persona\n  name: "@deepseek-ai/dsh-persona"\n  config:\n    prefix: !!js globalThis.__migrationUntrustedExecuted = true\n' },
      { path: 'dsh/workspace/.agents/skills/check/scripts/helper.sh', source_path: entry.path, source_sha256: entry.sha256 },
    ], mapping: [{ source: 'scripts/helper.sh', target: 'dsh/workspace/.agents/skills/check/scripts/helper.sh', status: 'native' }] }))
  assert.equal(globalThis.__migrationUntrustedExecuted, undefined)
  success(await fx.handler('apply', preview.apply_input))
  const target = join(fx.root, 'evolution/experiments', preview.experiment_id, 'candidate/dsh/workspace/.agents/skills/check/scripts/helper.sh')
  assert.ok(lstatSync(target).mode & 0o111)
  assert.equal(readFileSync(target, 'utf8'), '#!/bin/sh\nprintf checked\n')
  assert.equal(globalThis.__migrationUntrustedExecuted, undefined)
})

test('部分发布后可凭持久回执恢复；并行修改不被回滚或覆盖', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx)
  const original = fs.renameSync, target = join(fx.root, 'agents/migrated-agent')
  fs.renameSync = (from, to) => { if (to === target) throw new Error('模拟Agent发布中断'); return original(from, to) }
  syncBuiltinESMExports()
  let failed
  try { failed = await fx.handler('apply', preview.apply_input) } finally { fs.renameSync = original; syncBuiltinESMExports() }
  assert.equal(failed.ok, false)
  assert.equal(existsSync(join(fx.root, 'evolution/experiments', preview.experiment_id)), true)
  assert.equal(existsSync(target), false)
  const interrupted = success(await createMigrationsHandler(fx.root)('status', { operation_id: preview.operation_id }))
  assert.equal(interrupted.state, 'failed'); assert.equal(interrupted.resumable, true)
  assert.equal(success(await createMigrationsHandler(fx.root)('apply', preview.apply_input)).state, 'published')
  const current = join(fx.root, 'evolution/experiments', preview.experiment_id, 'candidate/dsh/workspace/AGENTS.md')
  writeFileSync(current, '用户并行修改。')
  assert.equal(success(await fx.handler('apply', preview.apply_input)).already_applied, true)
  assert.equal(readFileSync(current, 'utf8'), '用户并行修改。')
})

test('已有Agent从固定EXP创建新版本，保持active；VAR和已变化暂存资产拒绝继承/发布', async t => {
  const fx = fixture(t), { preview, source } = await sourceAndPreview(fx)
  success(await fx.handler('apply', preview.apply_input))
  git(fx.root, ['init']); git(fx.root, ['config', 'user.name', 'Fixture']); git(fx.root, ['config', 'user.email', 'fixture@example.invalid'])
  git(fx.root, ['add', 'agents', 'evolution']); git(fx.root, ['commit', '-m', '固定业务父版'])
  const ref = `git:${git(fx.root, ['rev-parse', 'HEAD'])}`, manifestFile = join(fx.root, 'agents/migrated-agent/manifest.yaml'), manifestBefore = readFileSync(manifestFile)
  const input = { source_id: source.source_id, fingerprint: source.fingerprint, target: { kind: 'new-version', agent_id: 'migrated-agent', parent_experiment_id: preview.experiment_id, parent_ref: ref, research_question: '迁移后的职责能否保持。' }, files: [{ path: 'dsh/workspace/AGENTS.md', content: '保持职责，并明确解释分析依据。' }], mapping: [{ source: 'role.md', target: 'dsh/workspace/AGENTS.md', status: 'converted' }] }
  const next = success(await fx.handler('preview', input))
  assert.match(next.experiment_id, /^EXP-migrated-agent-002-r[0-9a-f]{12}$/)
  success(await fx.handler('apply', next.apply_input))
  assert.deepEqual(readFileSync(manifestFile), manifestBefore)
  const nextChange = load(readFileSync(join(fx.root, 'evolution/experiments', next.experiment_id, 'change.yaml'), 'utf8'))
  assert.equal(nextChange.parent_ref, ref); assert.equal(nextChange.parent_experiment_id, preview.experiment_id)
  const invalid = success(await fx.handler('preview', input))
  write(fx.root, `.local/migrations/operations/${invalid.operation_id}/stage/evolution/experiments/${invalid.experiment_id}/candidate/dsh/workspace/AGENTS.md`, '并行修改')
  assert.equal((await fx.handler('apply', invalid.apply_input)).error.code, 'conflict')
  assert.equal(existsSync(join(fx.root, 'evolution/experiments', invalid.experiment_id)), false)
  const varId = 'VAR-migrated-agent-001-r111111111111', varDir = join(fx.root, 'evolution/experiments', varId)
  mkdirSync(varDir); writeFileSync(join(varDir, 'change.yaml'), dump({ experiment_id: varId, agent_id: 'migrated-agent', compute_variant: {} }))
  git(fx.root, ['add', 'evolution']); git(fx.root, ['commit', '-m', '变体不可继承'])
  assert.equal((await fx.handler('preview', { ...input, target: { ...input.target, parent_experiment_id: varId, parent_ref: `git:${git(fx.root, ['rev-parse', 'HEAD'])}` } })).ok, false)
})

test('已有Agent可绑定原Case或原Case与新增Case的并集，未知Case拒绝且不改原定义', async t => {
  const fx = fixture(t), { preview, source } = await sourceAndPreview(fx)
  success(await fx.handler('apply', preview.apply_input))
  git(fx.root, ['init']); git(fx.root, ['config', 'user.name', 'Fixture']); git(fx.root, ['config', 'user.email', 'fixture@example.invalid'])
  git(fx.root, ['add', 'agents', 'evolution']); git(fx.root, ['commit', '-m', '固定可复用Case的父版'])
  const evaluation = join(fx.root, 'agents/migrated-agent/evaluation.md'), original = readFileSync(evaluation)
  const input = { source_id: source.source_id, fingerprint: source.fingerprint,
    target: { kind: 'new-version', agent_id: 'migrated-agent', parent_experiment_id: preview.experiment_id, parent_ref: `git:${git(fx.root, ['rev-parse', 'HEAD'])}`, research_question: '迁移后保持既有关键行为，并可验证新行为。' },
    files: [{ path: 'dsh/workspace/AGENTS.md', content: '保持既有分析步骤，并解释分析依据。' }], mapping: [{ source: 'role.md', target: 'dsh/workspace/AGENTS.md', status: 'converted' }], case_ids: ['U-MIGRATION-001'],
  }
  const unknown = await fx.handler('preview', { ...input, case_ids: ['U-NONEXISTENT-001'] })
  assert.equal(unknown.ok, false); assert.match(unknown.error.message, /不存在于目标 Agent/)
  assert.deepEqual(readFileSync(evaluation), original)
  const reused = success(await fx.handler('preview', input))
  assert.deepEqual(reused.evaluation_case_ids, ['U-MIGRATION-001']); assert.deepEqual(reused.uncovered, [])
  const applied = success(await fx.handler('apply', reused.apply_input))
  assert.deepEqual(readFileSync(evaluation), original)
  recordedRun(fx, reused.experiment_id, applied.candidate_sha256, ['U-MIGRATION-001'])
  assert.equal(success(await fx.handler('status', { experiment_id: reused.experiment_id })).completed, true)
  const combined = success(await fx.handler('preview', { ...input, case_ids: ['U-MIGRATION-001', 'U-MIGRATION-001'], evaluation_cases: [{ ...cases[0], id: 'U-MIGRATION-002', inputs: '请执行增强后的分析步骤并解释依据。' }] }))
  assert.deepEqual(combined.evaluation_case_ids, ['U-MIGRATION-001', 'U-MIGRATION-002'])
  const combinedApplied = success(await fx.handler('apply', combined.apply_input))
  const receipt = JSON.parse(readFileSync(join(fx.root, 'evolution/experiments', combined.experiment_id, 'evaluation/evidence/migration.json')))
  assert.deepEqual(receipt.evaluation_case_ids, ['U-MIGRATION-001', 'U-MIGRATION-002'])
  recordedRun(fx, combined.experiment_id, combinedApplied.candidate_sha256, receipt.evaluation_case_ids)
  assert.equal(success(await fx.handler('status', { experiment_id: combined.experiment_id })).completed, true)
  const stale = success(await fx.handler('preview', input))
  appendCase(fx, 'U-MIGRATION-003', '用户新增另一条评测。')
  assert.equal((await fx.handler('apply', stale.apply_input)).error.code, 'conflict')
  assert.equal(existsSync(join(fx.root, 'evolution/experiments', stale.experiment_id)), false)
})

test('未绑定关键Case的草案保留可resolve的待补齐项，原EXP补充真实Case后继续验证', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, { evaluation_cases: undefined })
  assert.deepEqual(preview.evaluation_case_ids, [])
  assert.match(preview.uncovered[0], /尚未绑定迁移关键行为的评测用例/)
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  assert.equal(applied.completed, false)
  const pending = applied.unresolved_items.find(item => /尚未绑定/.test(item.description))
  assert.equal(pending.uncovered_index, 0)
  appendCase(fx, 'U-MIGRATION-001', '先读取材料，再解释分析步骤。')
  const resolved = success(await fx.handler('resolve', { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256,
    resolutions: [{ uncovered_index: pending.uncovered_index, notes: '已补充并关联真实业务行为用例。', case_ids: ['U-MIGRATION-001'] }],
  }))
  assert.deepEqual(resolved.required_case_ids, ['U-MIGRATION-001']); assert.deepEqual(resolved.unresolved_items, [])
  assert.equal(resolved.completed, false)
  recordedRun(fx, id, applied.candidate_sha256, resolved.required_case_ids)
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, true)
})

test('迁移完成必须由当前Candidate的真实API冻结Case、装载证据和有效结论共同支持', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx)
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  const run = 'run-11111111-1111-4111-8111-111111111111', path = `evolution/experiments/${id}/runs/${run}`, caseId = cases[0].id
  const parse = spawnSync('/usr/bin/python3.10', ['-c', 'import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from evaluation_contract import load_evaluation;print(json.dumps(load_evaluation(Path(sys.argv[2]))))', join(program, 'runtime/research'), join(fx.root, 'agents/migrated-agent/evaluation.md')], { encoding: 'utf8' })
  assert.equal(parse.status, 0, parse.stderr)
  const contract = JSON.parse(parse.stdout).cases[caseId]
  const json = (file, value) => write(fx.root, `${path}/${file}`, JSON.stringify(value))
  write(fx.root, `${path}/run.yaml`, dump({ run_id: run, experiment_id: id, agent_id: 'migrated-agent', source_id: `experiment:${id}`, status: 'completed' }))
  const inputs = { source_id: `experiment:${id}`, executor: 'api', candidate_sha256: applied.candidate_sha256, evaluation_cases: [contract], review_mode: 'none' }
  json('inputs.lock.json', inputs)
  const summary = { run_id: run, effective_verdict: 'passed', source_verification: { status: 'matched' } }
  json('summary.json', summary)
  write(fx.root, `${path}/results.jsonl`, JSON.stringify({ run_id: run, input_id: caseId, execution_status: 'completed', verdict: 'passed' }) + '\n')
  json(`evidence/${caseId}/checks.json`, { session_id: 'actual-dsh-session', preset_matches: true, workspace_matches: true })
  json(`evidence/${caseId}/response.json`, { assistant_texts: ['先读取材料，再给出分析步骤。'] })
  const state = () => fx.handler('status', { experiment_id: id }).then(success)
  assert.equal((await state()).completed, true)
  write(fx.root, `${path}/run.yaml`, dump({ run_id: 'run-99999999-9999-4999-8999-999999999999', experiment_id: id, agent_id: 'migrated-agent', source_id: `experiment:${id}`, status: 'completed' }))
  assert.equal((await state()).runtime_verified, false)
  write(fx.root, `${path}/run.yaml`, dump({ run_id: run, experiment_id: id, agent_id: 'migrated-agent', source_id: `experiment:${id}`, status: 'completed' }))
  json('summary.json', { ...summary, effective_verdict: 'unknown' }); assert.equal((await state()).completed, false)
  json('summary.json', summary)
  json('inputs.lock.json', { ...inputs, candidate_sha256: 'f'.repeat(64) }); assert.equal((await state()).runtime_verified, false)
  json('inputs.lock.json', { ...inputs, evaluation_cases: [] }); assert.equal((await state()).completed, false)
  json('inputs.lock.json', inputs)
  json(`evidence/${caseId}/checks.json`, { session_id: 'actual-dsh-session', preset_matches: false, workspace_matches: true }); assert.equal((await state()).runtime_verified, false)
  json(`evidence/${caseId}/checks.json`, { session_id: 'actual-dsh-session', preset_matches: true, workspace_matches: true })
  write(fx.root, `evolution/experiments/${id}/candidate/dsh/workspace/AGENTS.md`, '编辑后需要重新验证。')
  assert.equal((await state()).completed, false)
})

test('目标装载已核实时保留运行证据，后续复核失败仍阻止完成', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx), applied = success(await fx.handler('apply', preview.apply_input))
  const run = 'run-22222222-2222-4222-8222-222222222222', base = `evolution/experiments/${preview.experiment_id}/runs/${run}`
  recordedRun(fx, preview.experiment_id, applied.candidate_sha256, ['U-MIGRATION-001'], run)
  write(fx.root, `${base}/run.yaml`, dump({ run_id: run, experiment_id: preview.experiment_id, agent_id: 'migrated-agent', source_id: `experiment:${preview.experiment_id}`, status: 'failed' }))
  write(fx.root, `${base}/summary.json`, JSON.stringify({ run_id: run, effective_verdict: 'inconclusive', review_status: 'failed', source_verification: { status: 'matched' } }))
  const status = success(await fx.handler('status', { experiment_id: preview.experiment_id }))
  assert.equal(status.runtime_verified, true); assert.equal(status.business_verified, false); assert.equal(status.completed, false)
  assert.ok(status.verification_reasons.every(reason => !reason.includes('尚无覆盖当前 Candidate')))
})

test('状态查询等待Case解析期间发生并行编辑时拒绝返回旧完成判定', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, {
    mapping: [{ source: 'role.md', target: 'DSH角色', status: 'pending' }],
  })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  const resolved = success(await fx.handler('resolve', { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256,
    resolutions: [{ mapping_index: 0, notes: '原生角色已承接来源行为。', case_ids: ['U-MIGRATION-001'] }],
  }))
  recordedRun(fx, id, applied.candidate_sha256, resolved.required_case_ids)
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, true)
  const base = `evolution/experiments/${id}`
  const changes = [
    [`${base}/candidate/dsh/workspace/AGENTS.md`, content => content + '\n并行编辑角色。\n'],
    [`${base}/change.yaml`, content => dump({ ...load(content), research_question: '并行更新迁移引用的版本说明。' })],
    [`${base}/evaluation/evidence/migration.json`, content => JSON.stringify({ ...JSON.parse(content), note: '并行更新来源回执。' })],
    [`${base}/${resolved.resolution.path}`, content => JSON.stringify({ ...JSON.parse(content), created_at: '并行更新解决回执。' })],
    ['agents/migrated-agent/evaluation.md', content => content + '\n并行更新当前评测合同。\n'],
  ]
  for (const [path, edit] of changes) {
    const file = join(fx.root, path), before = readFileSync(file, 'utf8')
    // status 已捕获摘要，Case 解析的异步阶段让出执行后再修改事实源。
    const pending = fx.handler('status', { experiment_id: id })
    writeFileSync(file, edit(before))
    try {
      const result = await pending
      assert.equal(result.ok, false, path)
      assert.equal(result.error.code, 'conflict', path)
      assert.match(result.error.message, /已变化，请重新查询/, path)
      assert.equal(result.value, undefined, path)
    } finally { writeFileSync(file, before) }
  }
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, true)
})

test('状态查询期间平台依赖锁或共享运行源码变化时不沿用旧构建通过状态', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx)
  success(await fx.handler('apply', preview.apply_input))
  const id = preview.experiment_id, candidate = `evolution/experiments/${id}/candidate`
  write(fx.root, `${candidate}/dsh/managed/status-test.ts`, 'export const statusTest = "fixed artifact"\n')
  const builder = createAssetBuildHandler(fx.root), input = { experiment_id: id, entry_path: 'dsh/managed/status-test.ts' }
  const buildPreview = success(await builder('preview', input))
  const compiled = success(await builder('build', { ...input, expected_candidate_sha256: buildPreview.candidate_sha256, expected_preview_sha256: buildPreview.preview_sha256 }))
  recordedRun(fx, id, compiled.candidate_sha256, ['U-MIGRATION-001'])
  const baseline = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(baseline.build.verified, true); assert.equal(baseline.completed, true)
  const originalRead = fs.readFileSync
  let changedPath
  // 只模拟平台文件的读取结果，不修改共享的依赖锁或SDK源码。
  fs.readFileSync = (path, ...args) => {
    const content = originalRead(path, ...args)
    return String(path) !== changedPath ? content : Buffer.isBuffer(content)
      ? Buffer.concat([content, Buffer.from('\n// synthetic concurrent change\n')]) : content + '\n// synthetic concurrent change\n'
  }
  syncBuiltinESMExports()
  try {
    for (const relative of ['platform/plugin/pnpm-lock.yaml', 'runtime/adapters/dsh-web/src/resolve-runtime.ts']) {
      const pending = fx.handler('status', { experiment_id: id })
      changedPath = join(program, relative)
      try {
        const result = await pending
        assert.equal(result.ok, false, relative)
        assert.equal(result.error.code, 'conflict', relative)
        assert.equal(result.value, undefined, relative)
      } finally { changedPath = undefined }
    }
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports() }
  const unchanged = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(unchanged.candidate_sha256, compiled.candidate_sha256)
  assert.equal(unchanged.build.verified, true); assert.equal(unchanged.completed, true)
})

test('原EXP分次解决待补齐项，固定来源不改写，完成验证合并原始与解决项的真实Case', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, {
    mapping: [{ source: 'role.md', target: '待补工具', status: 'pending' }], uncovered: ['恢复中断后任务'],
  })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  const path = `evolution/experiments/${id}`, original = readFileSync(join(fx.root, path, 'evaluation/evidence/migration.json'))
  appendCase(fx, 'U-MIGRATION-002', '正确执行补齐工具。')
  appendCase(fx, 'U-MIGRATION-003', '恢复中断后任务。')
  recordedRun(fx, id, applied.candidate_sha256, [cases[0].id])
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, false)
  const firstInput = { operation_id: preview.operation_id, expected_candidate_sha256: applied.candidate_sha256, resolutions: [{ mapping_index: 0, target: 'dsh/managed/tools.mjs', notes: '已将独立业务工具映射为 DSH 原生工具。', case_ids: ['U-MIGRATION-002'] }] }
  const first = success(await fx.handler('resolve', firstInput))
  assert.equal(first.mapping[0].status, 'converted'); assert.equal(first.mapping[0].target, 'dsh/managed/tools.mjs')
  assert.deepEqual(first.uncovered, ['恢复中断后任务'])
  assert.deepEqual(first.required_case_ids, ['U-MIGRATION-001', 'U-MIGRATION-002'])
  assert.equal(first.completed, false); assert.equal(first.resolution.status, 'current')
  const secondInput = { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256, resolutions: [{ uncovered_index: 0, notes: '已接入任务恢复，并新增独立恢复用例。', case_ids: ['U-MIGRATION-003'] }] }
  const second = success(await fx.handler('resolve', secondInput))
  assert.deepEqual(second.uncovered, [])
  assert.deepEqual(second.required_case_ids, ['U-MIGRATION-001', 'U-MIGRATION-002', 'U-MIGRATION-003'])
  assert.equal(second.resolution.resolutions.length, 2); assert.equal(second.completed, false)
  assert.deepEqual(readFileSync(join(fx.root, path, 'evaluation/evidence/migration.json')), original)
  const change = load(readFileSync(join(fx.root, path, 'change.yaml'), 'utf8'))
  assert.equal(change.migration.resolution_receipt, second.resolution.path)
  const fixed = readFileSync(join(fx.root, path, second.resolution.path))
  assert.equal(success(await fx.handler('resolve', secondInput)).already_resolved, true)
  assert.equal(success(await fx.handler('resolve', { ...secondInput, resolutions: secondInput.resolutions.map(item => ({ ...item, disposition: 'converted' })) })).already_resolved, true)
  assert.deepEqual(readFileSync(join(fx.root, path, second.resolution.path)), fixed)
  recordedRun(fx, id, applied.candidate_sha256, second.required_case_ids, 'run-33333333-3333-4333-8333-333333333333')
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, true)
  rmSync(join(fx.root, '.local/migrations'), { recursive: true })
  const restored = success(await createMigrationsHandler(fx.root)('status', { experiment_id: id }))
  assert.equal(restored.resolution.status, 'current'); assert.equal(restored.completed, true)
})

test('解决项必须指向原待补齐索引和当前Case，错误摘要、重复、缺漏输入均不写回', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, {
    mapping: [{ source: 'role.md', target: '待补工具', status: 'pending' }, { source: 'role.md', target: '原生指令', status: 'native' }], uncovered: ['未覆盖行为'],
  })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  const changeFile = join(fx.root, 'evolution/experiments', id, 'change.yaml'), before = readFileSync(changeFile)
  const input = { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256, resolutions: [{ mapping_index: 0, notes: '已补齐工具。', case_ids: ['U-MIGRATION-001'] }] }
  for (const resolutions of [
    [], [{ mapping_index: 0, notes: '未给验证用例。', case_ids: [] }],
    [{ mapping_index: 0, notes: '指向不存在的用例。', case_ids: ['U-NONEXISTENT-001'] }],
    [{ mapping_index: 0, notes: '对象原型不是业务用例。', case_ids: ['__proto__'] }],
    [{ mapping_index: 0, uncovered_index: 0, notes: '索引不明确。', case_ids: ['U-MIGRATION-001'] }],
    [{ mapping_index: 1, notes: '不是待解决项。', case_ids: ['U-MIGRATION-001'] }],
    [{ mapping_index: -1, notes: '索引越界。', case_ids: ['U-MIGRATION-001'] }],
    [{ uncovered_index: 9, notes: '索引越界。', case_ids: ['U-MIGRATION-001'] }],
    [{ ...input.resolutions[0], disposition: 'unknown' }],
    [{ ...input.resolutions[0], disposition: 'outside-scope', target: '不能覆写目标' }],
    [{ ...input.resolutions[0], disposition: 'outside-scope', source: '不能改写来源' }],
    [{ ...input.resolutions[0], disposition: 'outside-scope', case_ids: [] }],
    [...input.resolutions, ...input.resolutions],
    [{ ...input.resolutions[0], arbitrary_status: 'passed' }],
  ]) assert.equal((await fx.handler('resolve', { ...input, resolutions })).ok, false, JSON.stringify(resolutions))
  assert.equal((await fx.handler('resolve', { ...input, expected_candidate_sha256: 'f'.repeat(64) })).error.code, 'conflict')
  assert.equal((await fx.handler('resolve', { ...input, operation_id: preview.operation_id })).ok, false)
  const cancelled = new AbortController(); cancelled.abort()
  assert.equal((await fx.handler('resolve', input, cancelled.signal)).error.code, 'aborted')
  assert.deepEqual(readFileSync(changeFile), before)
  assert.equal(existsSync(join(fx.root, 'evolution/experiments', id, 'evaluation/evidence/migration-resolutions')), false)
})

test('Candidate更新使旧解决记录和旧Run失效，逐项重新核对后仍须同摘要Run验证', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, {
    mapping: [{ source: 'role.md', target: '待补工具', status: 'pending' }], uncovered: ['未覆盖行为'],
  })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  const entries = [{ mapping_index: 0, notes: '工具已补齐。', case_ids: ['U-MIGRATION-001'] }, { uncovered_index: 0, notes: '未覆盖行为已补齐。', case_ids: ['U-MIGRATION-001'] }]
  const request = { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256, resolutions: entries }
  success(await fx.handler('resolve', request))
  recordedRun(fx, id, applied.candidate_sha256, [cases[0].id])
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, true)
  write(fx.root, `evolution/experiments/${id}/candidate/dsh/workspace/AGENTS.md`, '新的职责，需要重新核对。')
  const expired = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(expired.resolution.status, 'expired'); assert.equal(expired.mapping[0].status, 'pending')
  assert.deepEqual(expired.uncovered, ['未覆盖行为']); assert.equal(expired.completed, false)
  assert.equal((await fx.handler('resolve', request)).error.code, 'conflict')
  const partial = success(await fx.handler('resolve', { ...request, expected_candidate_sha256: expired.candidate_sha256, resolutions: [entries[0]] }))
  assert.equal(partial.resolution.resolutions.length, 1); assert.deepEqual(partial.uncovered, ['未覆盖行为']); assert.equal(partial.completed, false)
  const resolved = success(await fx.handler('resolve', { ...request, expected_candidate_sha256: expired.candidate_sha256, resolutions: [entries[1]] }))
  assert.equal(resolved.resolution.resolutions.length, 2); assert.deepEqual(resolved.uncovered, []); assert.equal(resolved.completed, false)
  recordedRun(fx, id, expired.candidate_sha256, [cases[0].id], 'run-44444444-4444-4444-8444-444444444444')
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, true)
  const record = join(fx.root, 'evolution/experiments', id, resolved.resolution.path), saved = JSON.parse(readFileSync(record))
  writeFileSync(record, JSON.stringify({ ...saved, candidate_sha256: applied.candidate_sha256 }))
  const invalid = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(invalid.resolution.status, 'unreadable'); assert.equal(invalid.completed, false)
})

test('解决项核对期间的并行Candidate编辑被保留且拒绝过期写入', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, { mapping: [{ source: 'role.md', target: '待补工具', status: 'pending' }] })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  const input = { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256, resolutions: [{ mapping_index: 0, notes: '已补齐。', case_ids: ['U-MIGRATION-001'] }] }
  const pending = fx.handler('resolve', input)
  assert.equal((await fx.handler('resolve', input)).error.code, 'conflict')
  const asset = join(fx.root, 'evolution/experiments', id, 'candidate/dsh/workspace/AGENTS.md')
  writeFileSync(asset, '用户并行编辑。')
  assert.equal((await pending).error.code, 'conflict')
  assert.equal(readFileSync(asset, 'utf8'), '用户并行编辑。')
  const state = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(state.resolution.status, 'none'); assert.equal(state.mapping[0].status, 'pending')
})

test('未解决项使用原始索引，分次解决不会重编号，非关键待补齐项保留required标记', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, {
    mapping: [{ source: 'role.md', target: '可选统计', status: 'pending', required: false }], uncovered: ['恢复任务', '输出校验'],
  })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  assert.deepEqual(applied.unresolved_items, [
    { mapping_index: 0, description: 'role.md', target: '可选统计', status: 'pending', required: false },
    { uncovered_index: 0, description: '恢复任务', required: true }, { uncovered_index: 1, description: '输出校验', required: true },
  ])
  const request = { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256 }
  const first = success(await fx.handler('resolve', { ...request, resolutions: [{ uncovered_index: 0, notes: '已验证恢复任务。', case_ids: ['U-MIGRATION-001'] }] }))
  assert.deepEqual(first.uncovered, ['输出校验'])
  assert.equal(first.unresolved_items.find(item => item.description === '输出校验').uncovered_index, 1)
  const second = success(await fx.handler('resolve', { ...request, resolutions: [{ uncovered_index: first.unresolved_items.find(item => item.required).uncovered_index, notes: '已验证输出校验。', case_ids: ['U-MIGRATION-001'] }] }))
  assert.deepEqual(second.uncovered, [])
  assert.deepEqual(second.unresolved_items, [{ mapping_index: 0, description: 'role.md', target: '可选统计', status: 'pending', required: false }])
  recordedRun(fx, id, applied.candidate_sha256, [cases[0].id])
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, true)
})

test('范围边界单列且不声称能力实现，原生承接与转换各保真，关键遗漏仍阻塞完成', async t => {
  const mapping = [
    { source: '实际角色指令', target: '待接入角色', status: 'pending' },
    { source: '实际业务工具', target: '待转换工具', status: 'pending' },
    { source: 'agentscope==2.0.11', target: '无；框架由DSH替代', status: 'omitted' },
  ]
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, { mapping,
    uncovered: ['未执行原框架A/B', '来源依赖的中断恢复尚未实现'], scope_limitations: ['固定来源样例只使用单Agent与Toolkit'],
  })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  const originalFile = join(fx.root, 'evolution/experiments', id, 'evaluation/evidence/migration.json'), original = readFileSync(originalFile)
  appendCase(fx, 'U-MIGRATION-002', '检查固定范围内业务结果。')
  const request = { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256 }
  const resolved = success(await fx.handler('resolve', { ...request, resolutions: [
    { mapping_index: 0, disposition: 'native', target: 'DSH Preset角色', notes: '实际角色已由原生Preset承接。', case_ids: ['U-MIGRATION-001'] },
    { mapping_index: 1, notes: '业务工具已完成转换。', case_ids: ['U-MIGRATION-001'] },
    { mapping_index: 2, disposition: 'outside-scope', notes: '来源框架包由DSH替代，不属于目标运行依赖。', case_ids: ['U-MIGRATION-002'] },
    { uncovered_index: 0, disposition: 'outside-scope', notes: '本次明确验证固定样例的DSH行为，未执行原runtime比较。', case_ids: ['U-MIGRATION-002'] },
  ] }))
  assert.equal(resolved.mapping[0].status, 'native'); assert.equal(resolved.mapping[0].target, 'DSH Preset角色')
  assert.equal(resolved.mapping[1].status, 'converted')
  assert.equal(resolved.mapping[2].source, mapping[2].source); assert.equal(resolved.mapping[2].target, mapping[2].target)
  assert.equal(resolved.mapping[2].status, 'omitted'); assert.equal(resolved.mapping[2].required, false)
  assert.equal(resolved.mapping[2].resolution_disposition, 'outside-scope')
  assert.deepEqual(resolved.uncovered, ['来源依赖的中断恢复尚未实现'])
  assert.equal(resolved.unresolved_items.length, 1); assert.equal(resolved.unresolved_items[0].uncovered_index, 1)
  assert.deepEqual(resolved.required_case_ids, ['U-MIGRATION-001', 'U-MIGRATION-002'])
  assert.equal(resolved.scope_limitations.length, 3)
  for (const limit of resolved.scope_limitations) assert.equal(limit.implemented, false)
  const excludedMapping = resolved.scope_limitations.find(item => item.mapping_index === 2)
  assert.equal(excludedMapping.original_status, 'omitted'); assert.equal(excludedMapping.target, mapping[2].target)
  assert.equal(resolved.scope_limitations.find(item => item.uncovered_index === 0).description, '未执行原框架A/B')
  assert.deepEqual(readFileSync(originalFile), original)
  recordedRun(fx, id, applied.candidate_sha256, ['U-MIGRATION-002'])
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, false)
  recordedRun(fx, id, applied.candidate_sha256, resolved.required_case_ids, 'run-33333333-3333-4333-8333-333333333333')
  const stillMissing = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(stillMissing.completed, false); assert.ok(stillMissing.verification_reasons.some(reason => /未覆盖的关键/.test(reason)))
  const finished = success(await fx.handler('resolve', { ...request, resolutions: [{ uncovered_index: 1, notes: '实际恢复行为已补齐并验证。', case_ids: ['U-MIGRATION-001'] }] }))
  assert.equal(finished.completed, true); assert.equal(finished.scope_limitations.length, 3)
  assert.equal(finished.verification_reasons.length, 0)
  assert.match(finished.note, /不表示这些能力已经实现/)
  write(fx.root, `evolution/experiments/${id}/candidate/dsh/workspace/AGENTS.md`, '更新后重新验证范围与关键行为。')
  const expired = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(expired.resolution.status, 'expired'); assert.equal(expired.completed, false)
  assert.equal(expired.mapping[2].status, 'omitted'); assert.notEqual(expired.mapping[2].required, false)
  assert.deepEqual(expired.scope_limitations, [{ description: '固定来源样例只使用单Agent与Toolkit', origin: 'declared-scope', implemented: false }])
  assert.deepEqual(readFileSync(originalFile), original)
})

test('preview声明的范围限制不充作关键待办，不改变同Candidate的真实Run要求', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, { scope_limitations: ['未执行原框架A/B比较，不声称完整等效'] })
  assert.deepEqual(preview.scope_limitations, ['未执行原框架A/B比较，不声称完整等效'])
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  assert.deepEqual(applied.uncovered, []); assert.deepEqual(applied.unresolved_items, [])
  assert.equal(applied.scope_limitations[0].implemented, false); assert.equal(applied.completed, false)
  recordedRun(fx, id, applied.candidate_sha256, ['U-MIGRATION-001'])
  const state = success(await fx.handler('status', { experiment_id: id }))
  assert.equal(state.completed, true); assert.deepEqual(state.verification_reasons, [])
})

test('改正同一Candidate的处置类型不会移除已绑定的关键Case', async t => {
  const fx = fixture(t), { preview } = await sourceAndPreview(fx, { mapping: [{ source: '框架包元数据', target: '无需带入目标', status: 'omitted' }] })
  const applied = success(await fx.handler('apply', preview.apply_input)), id = preview.experiment_id
  appendCase(fx, 'U-MIGRATION-002', '检查目标运行依赖。')
  const request = { experiment_id: id, expected_candidate_sha256: applied.candidate_sha256 }
  success(await fx.handler('resolve', { ...request, resolutions: [{ mapping_index: 0, notes: '已验证运行依赖。', case_ids: ['U-MIGRATION-002'] }] }))
  const corrected = success(await fx.handler('resolve', { ...request, resolutions: [{ mapping_index: 0, disposition: 'outside-scope', notes: '准确说明为框架替换的边界，未转换该包。', case_ids: ['U-MIGRATION-001'] }] }))
  assert.equal(corrected.mapping[0].status, 'omitted')
  assert.deepEqual(corrected.required_case_ids, ['U-MIGRATION-001', 'U-MIGRATION-002'])
  assert.deepEqual(corrected.resolution.resolutions[0].case_ids, ['U-MIGRATION-001', 'U-MIGRATION-002'])
  recordedRun(fx, id, applied.candidate_sha256, ['U-MIGRATION-001'])
  assert.equal(success(await fx.handler('status', { experiment_id: id })).completed, false)
})
