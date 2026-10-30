import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { materializeEvaluationSource, projectMcpFixture, renderMcpFixtureCompose, validateMcpFixture } from './evaluation-source.mts'
import { resolveHarnessRuntime } from '../../../platform/plugin/src/models/harness-runtime.ts'

const adapter = new URL('.', import.meta.url).pathname
const yaml = createRequire(new URL('../../../platform/plugin/package.json', import.meta.url))('js-yaml')
const id = 'EXP-alpha-001-raaaaaaaaaaaa'
const write = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text) }
function command(root, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'eval-source-')), candidate = join(root, `evolution/experiments/${id}/candidate`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'workspace.json', JSON.stringify({ schemaVersion: 1, id: 'workspace-evaluation-fixture', legacyRoots: [] }))
  write(root, '.gitignore', 'node_modules/\n.local/\n')
  write(root, 'agents/alpha/manifest.yaml', `schema_version: '1.0'\nagent_id: alpha\nactive_experiment: ${id}\n`)
  write(root, 'agents/alpha/evaluation.md', '# 评测\n\n#### U-BASIC-001 固定输入\n\n**用户输入**\n\n> 原始问题\n\n**预期**\n\n原始回答\n')
  write(root, `evolution/experiments/${id}/change.yaml`, `schema_version: '1.0'\nexperiment_id: ${id}\nagent_id: alpha\nstatus: active\nbaseline_ref: none:first-experiment\n`)
  write(root, `evolution/experiments/${id}/hypothesis.md`, '验证真实固定来源。\n')
  write(candidate, 'harness.yaml', "schema_version: '1.0'\nloadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: alpha\n  profile_patch: dsh/managed/alpha.patch.yml\ncredential_environment_keys: []\nrole_instructions:\n  alpha: dsh/workspace/AGENTS.md\n")
  write(candidate, 'dsh/workspace/AGENTS.md', '原角色\n')
  write(candidate, 'dsh/presets/alpha/agent.cordis.yml', '[]\n')
  write(candidate, 'dsh/managed/alpha.patch.yml', '[]\n')
  write(candidate, 'dsh/managed/web-profile.seed.patch.yml', '- insert:\n  - id: mcp-session-manager\n    config:\n      servers:\n      - id: readonly\n        serverName: readonly\n        enabled: false\n        url: http://old.test/mcp\n        headers: [{name: Authorization, value: ""}]\n        tools: {mode: selected, names: [get_asset]}\n      groups: [{id: original, members: [{serverId: readonly, names: [get_asset]}]}]\n')
  command(root, ['init', '-q']); command(root, ['config', 'user.name', '验收']); command(root, ['config', 'user.email', 'audit@example.test'])
  command(root, ['add', '.']); command(root, ['commit', '-qm', '固定评测来源'])
  return { root, candidate, ref: 'git:' + command(root, ['rev-parse', 'HEAD']) }
}
const mapping = { schema_version: 1, mode: 'mock', connections: [{ server_id: 'readonly', original_url: 'http://old.test/mcp', url: 'http://127.0.0.1:53001/mcp/', enabled: true }] }

test('固定来源从同一 Git 提交恢复角色与 Case，当前工作树和分支不改写', t => {
  const f = fixture(t), before = command(f.root, ['rev-parse', 'HEAD'])
  write(f.candidate, 'dsh/workspace/AGENTS.md', '当前新角色\n')
  write(f.root, 'agents/alpha/evaluation.md', '当前评测草稿\n')
  const fixed = materializeEvaluationSource(f.root, id, f.ref)
  assert.equal(readFileSync(join(fixed.root, `evolution/experiments/${id}/candidate/dsh/workspace/AGENTS.md`), 'utf8'), '原角色\n')
  assert.match(readFileSync(join(fixed.root, 'agents/alpha/evaluation.md'), 'utf8'), /原始问题/)
  assert.equal(readFileSync(join(f.candidate, 'dsh/workspace/AGENTS.md'), 'utf8'), '当前新角色\n')
  assert.equal(command(f.root, ['rev-parse', 'HEAD']), before)
  assert.equal(materializeEvaluationSource(f.root, id, f.ref).candidate_sha256, fixed.candidate_sha256)
  assert.equal(resolveHarnessRuntime(f.root, 'alpha', join(fixed.root, `evolution/experiments/${id}/candidate`)).role_instructions.alpha, 'dsh/workspace/AGENTS.md')
  write(join(fixed.root, `evolution/experiments/${id}/candidate`), 'untracked.md', '不能混入固定来源')
  assert.throws(() => materializeEvaluationSource(f.root, id, f.ref), /额外或已变化/)
})

test('固定来源依赖复用普通派生的同锁规则，锁漂移时明确缺失而不混用安装物', t => {
  for (const drift of [false, true]) {
    const f = fixture(t), folder = 'dsh/managed/business-plugin'
    write(f.candidate, folder + '/package.json', JSON.stringify({ dependencies: { 'fixture-lib': '1.0.0' }, packageManager: 'npm@10.0.0' }))
    write(f.candidate, folder + '/package-lock.json', '{"lockfileVersion":3,"packages":{}}\n')
    write(f.candidate, folder + '/node_modules/fixture-lib/index.js', 'export const value = 24\n')
    command(f.root, ['add', '.']); command(f.root, ['commit', '-qm', '固定插件锁'])
    const ref = 'git:' + command(f.root, ['rev-parse', 'HEAD'])
    if (drift) write(f.candidate, folder + '/package-lock.json', '{"lockfileVersion":2}\n')
    const fixed = materializeEvaluationSource(f.root, id, ref), manifest = JSON.parse(readFileSync(join(fixed.root, 'snapshot.json')))
    if (drift) {
      assert.equal(manifest.dependency_reuse.reused.length, 0)
      assert.match(manifest.dependency_reuse.skipped[0].reason, /锁已变化/)
    } else {
      assert.equal(manifest.dependency_reuse.reused.length, 1)
      assert.match(readFileSync(join(fixed.root, `evolution/experiments/${id}/candidate/${folder}/node_modules/fixture-lib/index.js`), 'utf8'), /24/)
    }
  }
})

test('Mock 连接映射只改变目标和显式启用状态，保留公开工具名与原来源字节', t => {
  const f = fixture(t), before = readFileSync(join(f.candidate, 'dsh/managed/web-profile.seed.patch.yml'))
  const bytes = Buffer.from(JSON.stringify(mapping, null, 2) + '\n'), projected = projectMcpFixture(f.candidate, bytes)
  const patch = yaml.load(projected.patch)[0]
  assert.equal(projected.metadata.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(projected.metadata.mode, 'mock')
  assert.deepEqual(patch.config.servers[0], { id: 'readonly', serverName: 'readonly', enabled: true,
    url: mapping.connections[0].url, tools: { mode: 'selected', names: ['get_asset'] }, headers: [] })
  assert.deepEqual(readFileSync(join(f.candidate, 'dsh/managed/web-profile.seed.patch.yml')), before)
  assert.throws(() => projectMcpFixture(f.candidate, Buffer.from(JSON.stringify({ ...mapping, connections: [{ ...mapping.connections[0], original_url: 'http://wrong.test/' }] }))), /原链接与固定来源不一致/)
  for (const invalid of [{ ...mapping, mode: 'production' }, { ...mapping, connections: [mapping.connections[0], mapping.connections[0]] },
    { ...mapping, connections: [{ ...mapping.connections[0], headers: [{ name: 'Authorization', value: 'credential' }] }] },
    { ...mapping, connections: [{ ...mapping.connections[0], url: 'https://user:pass@example.test/' }] }]) assert.throws(() => validateMcpFixture(invalid))
})

test('MCP Mock patch在原生启动命令最后加载，挂载只读且不改变已有来源挂载', () => {
  const original = { services: { dsh: { command: ['--profile', 'web', '--patch', '/original.yml', '--no-open'], volumes: [{ source: '/candidate', target: '/opt/dsh-managed', read_only: true }] } } }
  const projected = yaml.load(renderMcpFixtureCompose(yaml.dump(original), '/instance/fixture.yml'))
  assert.deepEqual(projected.services.dsh.command, ['--profile', 'web', '--patch', '/original.yml', '--patch', '/opt/harness-evaluation/mcp.fixture.patch.yml', '--no-open'])
  assert.deepEqual(projected.services.dsh.volumes[0], original.services.dsh.volumes[0])
  assert.equal(projected.services.dsh.volumes[1].read_only, true)
})

test('真实 Run 初始化封存固定来源与同字节 Mock fixture，当前草稿漂移不冒充固定来源', t => {
  const f = fixture(t), path = join(f.root, '.local/fixture.json')
  write(f.root, '.local/fixture.json', JSON.stringify(mapping, null, 2) + '\n')
  write(f.candidate, 'dsh/workspace/AGENTS.md', '未保存的新角色\n')
  const run = spawnSync(process.env.HARNESS_PYTHON ?? 'python3', [join(adapter, 'run_record.py'), '--repo', f.root, 'init', '--source', 'experiment:' + id,
    '--source-ref', f.ref, '--mcp-fixture', path, '--case', 'U-BASIC-001', '--executor', 'api'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const runId = run.stdout.trim(), runDir = join(f.root, `evolution/experiments/${id}/runs/${runId}`)
  const locked = JSON.parse(readFileSync(join(runDir, 'inputs.lock.json')))
  assert.equal(locked.source_ref, f.ref)
  assert.deepEqual(readFileSync(join(runDir, 'evidence/mcp-fixture.json')), readFileSync(path))
  assert.equal(locked.evaluation_cases[0].inputs[0], '原始问题')
  const check = spawnSync(process.env.HARNESS_PYTHON ?? 'python3', ['-c', 'import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from run_record import verify_run_source,read_flat_yaml;root=Path(sys.argv[2]);run=Path(sys.argv[3]);print(json.dumps(verify_run_source(root,read_flat_yaml(run/"run.yaml"),json.loads((run/"inputs.lock.json").read_text()))))', adapter, f.root, runDir], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
  assert.equal(JSON.parse(check.stdout).status, 'matched')
  write(runDir, 'evidence/mcp-fixture.json', JSON.stringify({ ...mapping, connections: [] }))
  const drift = spawnSync(process.env.HARNESS_PYTHON ?? 'python3', ['-c', 'import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from run_record import verify_run_source,read_flat_yaml;root=Path(sys.argv[2]);run=Path(sys.argv[3]);print(json.dumps(verify_run_source(root,read_flat_yaml(run/"run.yaml"),json.loads((run/"inputs.lock.json").read_text()))))', adapter, f.root, runDir], { encoding: 'utf8' })
  assert.equal(JSON.parse(drift.stdout).checks.find(item => item.component === 'mcp_fixture').status, 'changed')
})
