import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { dump, load } from 'js-yaml'

const built = mkdtempSync(join(tmpdir(), 'variant-identity-module-'))
await build({ entryPoints: [new URL('../src/agents/variant-identity.ts', import.meta.url).pathname], outfile: join(built, 'identity.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createVariantIdentityMigrationHandler, currentVariantProjection } = await import(`file://${join(built, 'identity.mjs')}`)
test.after(() => rmSync(built, { recursive: true, force: true }))
const parent = 'EXP-alpha-001-r111111111111', legacy = 'EXP-alpha-002-r222222222222', current = 'VAR-alpha-001-r333333333333'
const run = 'run-11111111-1111-4111-8111-111111111111'
const relative = id => `evolution/experiments/${id}`
const write = (root, path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body) }
const readChange = (root, id) => load(readFileSync(join(root, relative(id), 'change.yaml'), 'utf8'))
const writeChange = (root, id, change) => write(root, `${relative(id)}/change.yaml`, dump(change, { lineWidth: -1, noRefs: true }))
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
function git(root, args) { const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim() }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'variant-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const harness = 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: alpha\n  profile_patch: dsh/managed/alpha.patch.yml\n'
  function candidate(id, content = 'export const answer = 42\n') {
    write(root, `${relative(id)}/candidate/harness.yaml`, harness)
    write(root, `${relative(id)}/candidate/dsh/workspace/AGENTS.md`, '只读查询。\n')
    write(root, `${relative(id)}/candidate/dsh/managed/workflow.ts`, content)
  }
  write(root, 'agents/alpha/manifest.yaml', `agent_id: alpha\nactive_experiment: ${legacy}\n`)
  candidate(parent)
  writeChange(root, parent, { experiment_id: parent, agent_id: 'alpha', baseline_ref: 'none:first-experiment' })
  git(root, ['init']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid'])
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixed ordinary parent'])
  const parentRef = `git:${git(root, ['rev-parse', 'HEAD'])}`
  const plan = { strategy: '减少重复查询', case_hashes: { 'U-QUERY-001': 'a'.repeat(64) }, generation: { source_run_ids: [run] }, execution_mode: 'code-only' }
  function variant(id, content) {
    candidate(id, content)
    writeChange(root, id, { experiment_id: id, agent_id: 'alpha', baseline_ref: parentRef, parent_ref: parentRef, parent_experiment_id: parent,
      variant_name: '查询变体', variant_kind: 'end', status: 'completed', outcome: 'adopt', compute_variant: plan,
      compute_variant_build: { esm_sha256: 'b'.repeat(64) }, compute_variant_decision: { variant_ref: 'git:' + 'c'.repeat(40) }, end_confirmed: true })
  }
  variant(legacy)
  write(root, `${relative(legacy)}/candidate/dsh/managed/paths.json`, JSON.stringify({ current: `${relative(legacy)}/candidate/dsh/workspace`, source: `experiment:${legacy}`, trace: `${relative(legacy)}/runs/${run}/trace.jsonl`, origin_experiment_id: legacy }))
  write(root, `${relative(legacy)}/candidate/model.bin`, Buffer.from([0, 1, 2, 3]))
  write(root, `${relative(legacy)}/runs/${run}/run.yaml`, `run_id: ${run}\nexperiment_id: ${legacy}\n`)
  write(root, `${relative(legacy)}/runs/${run}/session.jsonl`, '原始 Session。\n')
  write(root, `${relative(legacy)}/evaluation/compute-comparison.json`, '{"historical":true}\n')
  git(root, ['add', '.']); git(root, ['commit', '-m', 'legacy variant with historical evidence'])
  return { root, variant, parentRef, frozen: git(root, ['rev-parse', 'HEAD']), handler: createVariantIdentityMigrationHandler(root) }
}

test('创建当前VAR身份只迁移当前资产和计划，原Run/Git/Session保持历史身份，重复执行不再写', async t => {
  const fx = fixture(t), legacyBefore = readFileSync(join(fx.root, relative(legacy), 'change.yaml'))
  const preview = success(await fx.handler('identity-preview', { experiment_id: legacy }))
  assert.match(preview.current_variant_id, /^VAR-alpha-001-r[0-9a-f]{12}$/)
  assert.equal(existsSync(join(fx.root, relative(preview.current_variant_id))), false)
  assert.deepEqual(readFileSync(join(fx.root, relative(legacy), 'change.yaml')), legacyBefore)
  const result = success(await fx.handler('identity-apply', preview.apply_input)), id = result.current_variant_id
  const next = readChange(fx.root, id), old = readChange(fx.root, legacy)
  assert.equal(old.current_variant_id, id)
  assert.equal(next.experiment_id, id); assert.equal(next.parent_experiment_id, parent); assert.equal(next.parent_ref, fx.parentRef)
  assert.deepEqual(next.compute_variant, old.compute_variant)
  assert.equal(next.variant_kind, 'exploratory'); assert.equal(next.outcome, 'inconclusive')
  assert.equal(next.compute_variant_build, undefined); assert.equal(next.compute_variant_decision, undefined); assert.equal(next.end_confirmed, undefined)
  assert.equal(existsSync(join(fx.root, relative(id), 'runs')), false)
  assert.equal(existsSync(join(fx.root, relative(id), 'evaluation/compute-comparison.json')), false)
  assert.deepEqual(readFileSync(join(fx.root, relative(id), 'candidate/model.bin')), Buffer.from([0, 1, 2, 3]))
  const paths = JSON.parse(readFileSync(join(fx.root, relative(id), 'candidate/dsh/managed/paths.json')))
  assert.equal(paths.current, `${relative(id)}/candidate/dsh/workspace`); assert.equal(paths.source, `experiment:${id}`)
  assert.equal(paths.trace, `${relative(legacy)}/runs/${run}/trace.jsonl`); assert.equal(paths.origin_experiment_id, legacy)
  assert.match(readFileSync(join(fx.root, relative(legacy), `runs/${run}/run.yaml`), 'utf8'), new RegExp(legacy))
  assert.equal(git(fx.root, ['show', `${fx.frozen}:${relative(legacy)}/change.yaml`]).includes('current_variant_id'), false)
  assert.equal(load(readFileSync(join(fx.root, 'agents/alpha/manifest.yaml'))).active_experiment, id)
  assert.deepEqual(currentVariantProjection(fx.root, legacy, old), { current_variant_id: id, is_current: false })
  const before = readFileSync(join(fx.root, relative(legacy), 'change.yaml'))
  const repeated = success(await createVariantIdentityMigrationHandler(fx.root)('identity-apply', preview.apply_input))
  assert.equal(repeated.already_migrated, true); assert.equal(repeated.current_variant_id, id)
  assert.deepEqual(readFileSync(join(fx.root, relative(legacy), 'change.yaml')), before)
})

test('关联已有VAR优先保留其更新资产，不复制覆盖，后续当前计划变化不破坏历史跳转', async t => {
  const fx = fixture(t); fx.variant(current, 'export const answer = "new current implementation"\n')
  const revised = readChange(fx.root, current); revised.compute_variant.case_hashes['U-QUERY-001'] = 'e'.repeat(64); writeChange(fx.root, current, revised)
  const before = readFileSync(join(fx.root, relative(current), 'candidate/dsh/managed/workflow.ts'))
  const preview = success(await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: current }))
  assert.equal(preview.mode, 'associate')
  assert.equal(success(await fx.handler('identity-apply', preview.apply_input)).current_variant_id, current)
  assert.deepEqual(readFileSync(join(fx.root, relative(current), 'candidate/dsh/managed/workflow.ts')), before)
  assert.equal(readChange(fx.root, current).variant_kind, 'end', '关联不修改已有VAR状态')
  const updated = readChange(fx.root, current); updated.compute_variant.case_hashes['U-NEW-002'] = 'd'.repeat(64); writeChange(fx.root, current, updated)
  assert.equal(currentVariantProjection(fx.root, legacy, readChange(fx.root, legacy)).current_variant_id, current)
  assert.equal(success(await fx.handler('identity-apply', preview.apply_input)).already_migrated, true)
})

test('预览后源资产、已有VAR或登记来源变化拒绝执行，普通版本及错任务拒绝迁移', async t => {
  const fx = fixture(t)
  const ordinary = await fx.handler('identity-preview', { experiment_id: parent }); assert.equal(ordinary.ok, false)
  const preview = success(await fx.handler('identity-preview', { experiment_id: legacy }))
  write(fx.root, `${relative(legacy)}/candidate/dsh/managed/workflow.ts`, 'changed\n')
  assert.equal((await fx.handler('identity-apply', preview.apply_input)).error.code, 'conflict')
  assert.equal(existsSync(join(fx.root, relative(preview.current_variant_id))), false)
  fx.variant(current)
  const associate = success(await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: current }))
  write(fx.root, `${relative(current)}/candidate/dsh/managed/workflow.ts`, 'new target edit\n')
  assert.equal((await fx.handler('identity-apply', associate.apply_input)).error.code, 'conflict')
  const wrong = readChange(fx.root, current); wrong.compute_variant.case_hashes = { 'U-OTHER-001': 'f'.repeat(64) }; writeChange(fx.root, current, wrong)
  assert.equal((await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: current })).ok, false)
  wrong.compute_variant.case_hashes = readChange(fx.root, legacy).compute_variant.case_hashes
  wrong.compute_variant.generation.source_run_ids = ['run-99999999-9999-4999-8999-999999999999']; writeChange(fx.root, current, wrong)
  assert.equal((await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: current })).ok, false, 'Case范围相同仍须保留原诊断Run依据')
  assert.equal(readChange(fx.root, legacy).current_variant_id, undefined)
})

test('拒绝跨Agent、非VAR、循环、多级及冲突映射，不新增外部身份台账', async t => {
  const fx = fixture(t); fx.variant(current)
  for (const id of [legacy, parent, '../outside', 'VAR-other-001-r123456abcdef']) assert.equal((await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: id })).ok, false)
  const loop = readChange(fx.root, current); loop.current_variant_id = current; writeChange(fx.root, current, loop)
  assert.equal((await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: current })).ok, false)
  delete loop.current_variant_id; writeChange(fx.root, current, loop)
  success(await fx.handler('identity-apply', success(await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: current })).apply_input))
  assert.equal((await fx.handler('identity-preview', { experiment_id: legacy, current_variant_id: 'VAR-alpha-002-r444444444444' })).error.code, 'conflict')
  assert.equal(readdirSync(fx.root).includes('aliases.json'), false)
})

test('发布映射失败完整恢复登记并移除本次新VAR，不删除并发修改', async t => {
  const fx = fixture(t), preview = success(await fx.handler('identity-preview', { experiment_id: legacy }))
  const original = fs.renameSync, manifest = readFileSync(join(fx.root, 'agents/alpha/manifest.yaml'))
  fs.renameSync = function (from, to) { if (to === join(fx.root, relative(legacy), 'change.yaml')) throw new Error('模拟原声明写入失败'); return original(from, to) }
  syncBuiltinESMExports()
  let failed
  try { failed = await fx.handler('identity-apply', preview.apply_input) }
  finally { fs.renameSync = original; syncBuiltinESMExports() }
  assert.equal(failed.ok, false)
  assert.deepEqual(readFileSync(join(fx.root, 'agents/alpha/manifest.yaml')), manifest)
  assert.equal(readChange(fx.root, legacy).current_variant_id, undefined)
  assert.equal(existsSync(join(fx.root, relative(preview.current_variant_id))), false)
  assert.equal(readdirSync(join(fx.root, 'evolution/experiments')).some(name => name.startsWith('.identity-')), false)
})
