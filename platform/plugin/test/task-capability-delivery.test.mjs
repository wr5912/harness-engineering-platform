import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'node:http'
import { zipSync, strToU8 } from 'fflate'
import { discoverTaskCapabilities } from '../src/tasks/capabilities.ts'
import { applyTaskAssembly, previewTaskAssembly } from '../src/tasks/assembly.ts'
import { candidateDigest, sha256 } from '../src/tasks/files.ts'

const program = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const adapter = join(program, 'runtime/adapters/dsh-container'), python = process.env.HARNESS_PYTHON || 'python3'
const sourceId = 'EXP-inspection-task-001-r123456abcdef', targetId = 'EXP-inspection-task-002-r123456abcdef'
function write(root, path, body) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return file }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'task delivery ')); t.after(() => rmSync(root, { recursive: true, force: true }))
  write(root, 'workspace.json', JSON.stringify({ schemaVersion: 1, id: 'workspace-task-test' }))
  for (const id of [sourceId, targetId]) {
    const candidate = `evolution/experiments/${id}/candidate`
    write(root, `${candidate}/dsh/workspace/AGENTS.md`, '只读巡检测试资产。')
    write(root, `${candidate}/dsh/managed/task.patch.yml`, '- name: cordis:include\n  config:\n    path: /opt/dsh-presets/inspection-task/agent.cordis.yml\n')
    write(root, `${candidate}/dsh/presets/inspection-task/agent.cordis.yml`, '- name: "@deepseek-ai/dsh-agent"\n')
    write(root, `evolution/experiments/${id}/change.yaml`, `experiment_id: ${id}\nagent_id: inspection-task\nbaseline_ref: "none:first-experiment"\n`)
    write(root, `${candidate}/harness.yaml`, 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: inspection-task\n  profile_patch: dsh/managed/task.patch.yml\n')
  }
  write(root, `evolution/experiments/${sourceId}/candidate/dsh/workspace/.agents/skills/inspection/SKILL.md`, '# 巡检\n查询指定设备并核对完整性。\n')
  return root
}
function assemblyInput(root) {
  const path = 'dsh/workspace/.agents/skills/inspection/SKILL.md'
  return { target_source: `experiment:${targetId}`, expected_candidate_sha256: candidateDigest(join(root, `evolution/experiments/${targetId}/candidate`)), files: [{ source: `experiment:${sourceId}`, path, expected_source_sha256: sha256(readFileSync(join(root, `evolution/experiments/${sourceId}/candidate/${path}`))), expected_target_sha256: null }] }
}

test('能力目录读取实际来源和原生 MCP，区分发现与验证并过滤凭据', async t => {
  const root = fixture(t)
  const result = await discoverTaskCapabilities(root, { nativeServers: () => [{ id: 'inspection', url: 'https://private.invalid/mcp', token: 'do-not-output', enabled: true, tools: { names: ['list_devices'] } }] })
  assert.equal(result.sources.length, 2); assert.equal(result.sources[0].skills[0].name, 'inspection')
  assert.equal(result.mcp[0].verification, 'configured'); assert.deepEqual(result.mcp[0].tools, ['list_devices'])
  assert.doesNotMatch(JSON.stringify(result), /do-not-output|private.invalid/)
  const digest = execFileSync(python, ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from run_record import candidate_digest; print(candidate_digest(Path(sys.argv[2])))', adapter, join(root, `evolution/experiments/${sourceId}/candidate`)], { encoding: 'utf8', env: { ...process.env, HARNESS_PROGRAM_ROOT: program } }).trim()
  assert.equal(result.sources[0].candidate_sha256, digest)
  assert.equal(result.sources[0].candidate_sha256_basis, 'run-content-path-mode')
})

test('能力目录等待实际工具发现与固定版本引用，不从配置名字猜schema', async t => {
  const root = fixture(t), schema = { type: 'object', properties: { assetId: { type: 'integer' } }, required: ['assetId'] }
  let requested
  const result = await discoverTaskCapabilities(root, { server_id: 'soc-readonly', nativeServers: () => [{ id: 'soc-readonly', tools: { names: ['get_asset'] } }],
    discoveredTools: async serverId => { requested = serverId; return [{ server_id: serverId, name: 'get_asset', inputSchema: schema, headers: { Authorization: 'secret-value' } }] },
    compositionBindings: async () => [{ composition_id: 'asset-alerts', version_id: 'v-fixed', tool_name: 'query_asset_alerts', url: 'https://private.invalid' }],
  })
  assert.equal(requested, 'soc-readonly')
  assert.deepEqual(result.mcp[0].tool_schemas, [{ name: 'get_asset', inputSchema: schema, verification: 'discovered' }])
  assert.deepEqual(result.composition_bindings, [{ composition_id: 'asset-alerts', version_id: 'v-fixed', tool_name: 'query_asset_alerts', verification: 'published' }])
  assert.doesNotMatch(JSON.stringify(result), /secret-value|private.invalid|Authorization/)
})

test('能力目录只保留来源一致且完整的原生分组固定绑定，不输出凭据或猜补分组', async t => {
  const root = fixture(t), version = 'a'.repeat(64), implementation = 'b'.repeat(64)
  const fixed = { group_id: 'research-tools', group_target_digest: 'c'.repeat(64), tool_name: 'mcp__compositions__query_asset_alerts', compositionId: 'asset-alerts', versionId: version, expectedImplementationDigest: implementation, input_schema: { type: 'object' } }
  const entry = { composition_id: 'asset-alerts', version_id: version, tool_name: 'query_asset_alerts', source_digest: implementation }
  const result = await discoverTaskCapabilities(root, { compositionBindings: async () => [
    { ...entry, fixed_binding: { ...fixed, token: 'do-not-output' } },
    { ...entry, fixed_binding: { ...fixed, versionId: 'd'.repeat(64) } },
    { ...entry, fixed_binding: { ...fixed, group_target_digest: undefined } },
    { ...entry, fixed_binding_unavailable: '尚无可核验原生分组' },
  ] })
  assert.deepEqual(result.composition_bindings[0].fixed_binding, fixed)
  for (const binding of result.composition_bindings.slice(1)) assert.equal(binding.fixed_binding, undefined)
  assert.equal(result.composition_bindings[3].fixed_binding_unavailable, '尚无可核验原生分组')
  assert.doesNotMatch(JSON.stringify(result), /do-not-output|token/)
})

test('能力目录接受分组 v2 固定绑定并保留旧版默认值', async t => {
  const root = fixture(t), version = 'a'.repeat(64), implementation = 'b'.repeat(64)
  const entry = { composition_id: 'asset-alerts', version_id: version, tool_name: 'query_asset_alerts', source_digest: implementation }
  const fixed = { group_id: 'research-tools', group_link_version: 2, group_target_digest: 'c'.repeat(64),
    tool_name: 'query_asset_alerts', compositionId: 'asset-alerts', versionId: version,
    expectedImplementationDigest: implementation, input_schema: { type: 'object' } }
  const result = await discoverTaskCapabilities(root, { compositionBindings: async () => [
    { ...entry, fixed_binding: { ...fixed, token: 'do-not-output' } },
    { ...entry, fixed_binding: { ...fixed, tool_name: 'mcp__compositions__query_asset_alerts' } },
  ] })
  assert.deepEqual(result.composition_bindings[0].fixed_binding, fixed)
  assert.equal(result.composition_bindings[1].fixed_binding, undefined)
  assert.doesNotMatch(JSON.stringify(result), /do-not-output/)
})

test('装配预览无写入，应用复制真实 Skill 并核对配置引用，拒绝重复应用和来源漂移', async t => {
  const root = fixture(t), input = assemblyInput(root), target = join(root, `evolution/experiments/${targetId}/candidate/${input.files[0].path}`)
  assert.equal((await previewTaskAssembly(root, input)).bindings.status, 'declared'); assert.equal(existsSync(target), false)
  const receipt = await applyTaskAssembly(root, input)
  assert.equal(receipt.experiment_id, targetId); assert.equal(receipt.bindings.runtime_verified, false); assert.match(readFileSync(target, 'utf8'), /完整性/)
  await assert.rejects(applyTaskAssembly(root, input), /已变化/)
  const second = fixture(t), next = assemblyInput(second); next.files[0].expected_source_sha256 = '0'.repeat(64)
  await assert.rejects(previewTaskAssembly(second, next), /来源已变化/)
})

test('整批装配先检查配置绑定，缺失依赖或越界路径不得部分写入', async t => {
  const root = fixture(t), input = assemblyInput(root), config = 'dsh/presets/inspection-task/agent.cordis.yml'
  input.configuration_edits = [{ path: config, content: '- name: cordis:include\n  config:\n    path: /opt/dsh-managed/missing.mjs\n', expected_target_sha256: sha256(readFileSync(join(root, `evolution/experiments/${targetId}/candidate/${config}`))) }]
  await assert.rejects(applyTaskAssembly(root, input), /不存在的资产/)
  assert.equal(existsSync(join(root, `evolution/experiments/${targetId}/candidate/${input.files[0].path}`)), false)
  delete input.configuration_edits; input.files[0].target_path = '../escape.md'; await assert.rejects(applyTaskAssembly(root, input), /相对路径/)
  input.files[0].target_path = 'dsh/workspace/.env'; await assert.rejects(applyTaskAssembly(root, input), /不能作为装配资产/)
  input.files[0].target_path = 'dsh/workspace/link/report.md'; symlinkSync(tmpdir(), join(root, `evolution/experiments/${targetId}/candidate/dsh/workspace/link`))
  await assert.rejects(applyTaskAssembly(root, input), /符号链接/)
})
