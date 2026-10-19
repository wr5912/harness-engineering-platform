import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { load as loadYaml } from 'js-yaml'

const repo = new URL('../../../', import.meta.url).pathname
const plugin = new URL('../', import.meta.url).pathname

async function loadServer() {
  const outdir = mkdtempSync(join(tmpdir(), 'agents-build-'))
  const outfile = join(outdir, 'agents-server.mjs')
  await build({
    entryPoints: [join(plugin, 'src/agents/index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@deepseek-ai/dsh-client-connection'],
  })
  return import(`file://${outfile}`)
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`)
  return result.stdout.trim()
}

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

function copyFixtureFile(root, rel) {
  const target = join(root, rel)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(repo, rel), target)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agents-fixture-'))
  process.env.HARNESS_PROGRAM_ROOT = root
  process.env.HARNESS_ASSET_ROOT = root
  for (const rel of [
    'runtime/adapters/dsh-container/dsh-eval',
    'runtime/adapters/dsh-container/source_contract.py',
    'runtime/adapters/dsh-container/workspace_paths.py',
    'runtime/adapters/dsh-container/scenario_analysis.py',
    'runtime/adapters/dsh-container/run_record.py',
    'runtime/adapters/dsh-container/mutation-receipt.py',
    'runtime/research/evaluation_contract.py',
    'runtime/research/validate_experiment.py',
    'runtime/research/validate_repository.py',
    'runtime/research/inspect_source.py',
  ]) copyFixtureFile(root, rel)
  for (const name of ['Dockerfile', 'apt-mirror.sh', 'build-image.sh', 'dsh-cli.sh']) {
    write(join(root, 'runtime/adapters/dsh-container', name), `${name}\n`)
  }
  write(join(root, 'runtime/adapters/dsh-container/source.lock.json'), JSON.stringify({
    repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
    commit: '21638c5630000000000000000000000000000000',
    tree: '31638c5630000000000000000000000000000000',
    pnpm_lock_sha256: '4'.repeat(64),
    package_manager: 'pnpm@10.0.0',
    node_base: `node:20@sha256:${'5'.repeat(64)}`,
    platform: 'linux/amd64',
    local_image_tag: 'ai-agent-harness/dsh:21638c563',
    cli_version: '0.2.1-rc.2',
    cli_package: '@deepseek-ai/dsh',
  }, null, 2) + '\n')
  write(join(root, 'agents/test-agent/manifest.yaml'), 'schema_version: 1.0\nagent_id: test-agent\nactive_experiment: EXP-test-agent-001\n')
  write(join(root, 'agents/test-agent/evaluation.md'), [
    '# Evaluation',
    '',
    '## 基础',
    '',
    '#### U-CASE-001 基础',
    '**评估档位：** `fast`',
    '',
    '**用户输入**',
    '> ping',
    '',
    '**预期**',
    '返回 pong。',
    '',
  ].join('\n'))
  write(join(root, 'evolution/experiments/EXP-test-agent-001/change.yaml'), 'schema_version: 1.0\nexperiment_id: EXP-test-agent-001\nagent_id: test-agent\nbaseline_ref: none:first-experiment\nstatus: active\nfusion_sources:\n  - EXP-test-agent-000\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/hypothesis.md'), '# Hypothesis\n\n验证基础资产。参考 EXP-test-agent-099 但不声明继承。\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/evaluation/observations.md'), '# Observations\n\n尚未执行。\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/decision.md'), '# Decision\n\n状态：continue\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/candidate/harness.yaml'), 'name: test\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/candidate/roles/analyst/AGENTS.md'), '# Analyst\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh/workspace/input.txt'), 'workspace\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh/managed/test-agent.patch.yml'), 'patch: test\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh/presets/test-agent/preset.yml'), 'preset: test\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/candidate/RuntimeHOME/session.txt'), 'must not copy\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/candidate/history/log.txt'), 'must not copy\n')
  write(join(root, 'evolution/experiments/EXP-test-agent-001/runs/run-11111111-1111-4111-8111-111111111111/run.json'), '{"status":"failed"}\n')
  write(join(root, 'runtime/adapters/dsh-container/sources.json'), JSON.stringify({
    schema_version: '1.1',
    sources: {
      'EXP-test-agent-001': {
        agent_id: 'test-agent',
        candidate_root: 'evolution/experiments/EXP-test-agent-001/candidate/dsh',
        profile: 'web',
        patch: 'test-agent.patch.yml',
        preset: 'test-agent/preset.yml',
        guard: null,
        config_markers: ['test'],
        required_env_names: [],
      },
    },
  }, null, 2) + '\n')
  run(root, 'git', ['init'])
  run(root, 'git', ['config', 'user.email', 'test@example.invalid'])
  run(root, 'git', ['config', 'user.name', 'Test'])
  run(root, 'git', ['add', '.'])
  run(root, 'git', ['commit', '-m', 'fixture'])
  const commit = run(root, 'git', ['rev-parse', 'HEAD'])
  return { root, commit }
}

async function rpc(handler, endpoint, payload = {}) {
  const result = await handler(endpoint, payload, new AbortController().signal)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message} ${JSON.stringify(result.error.details ?? {})}`)
  return result.value
}

async function waitForJob(handler, jobId) {
  for (let index = 0; index < 20; index += 1) {
    const status = await rpc(handler, 'eval/status', { job_id: jobId })
    if (status.status !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('job did not finish')
}

test('experiment readers accept historical IDs and twelve hex suffixes, rejecting other suffixes', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    assert.equal((await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: 'EXP-test-agent-001' })).experiment.id, 'EXP-test-agent-001')
    for (const suffix of ['random', 'r0123456789a', 'r0123456789abc', 'r0123456789AB']) {
      const id = `EXP-test-agent-002-${suffix}`
      write(join(fx.root, `evolution/experiments/${id}/change.yaml`), `experiment_id: ${id}\nagent_id: test-agent\n`)
      await assert.rejects(() => rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: id }), /invalid_request:/)
    }
    const valid = 'EXP-test-agent-002-r0123456789ab'
    write(join(fx.root, `evolution/experiments/${valid}/change.yaml`), `experiment_id: ${valid}\nagent_id: test-agent\n`)
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: valid })
    assert.equal(detail.experiment.id, valid)
    assert.deepEqual(detail.versions.map(item => item.id).sort(), ['EXP-test-agent-001', valid])
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('agents detail reads manifest, selectable versions, real cases, refs and editable files', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const detail = await rpc(createAgentsHandler(fx.root), 'detail', { agent_id: 'test-agent' })
    assert.equal(detail.agent.manifest.agent_id, 'test-agent')
    assert.equal(detail.declared.catalog_source.candidate_root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh')
    assert.equal(detail.loaded_instance.status, 'not_queried')
    assert.equal(detail.evaluation.cases[0].id, 'U-CASE-001')
    assert.equal(detail.fusion.status, 'declared')
    assert.deepEqual(detail.fusion.experiments, ['EXP-test-agent-000'])
    assert.deepEqual(detail.related_references, ['EXP-test-agent-099'])
    assert.ok(detail.editable_files.includes('evolution/experiments/EXP-test-agent-001/candidate/harness.yaml'))
    assert.ok(detail.editable_files.includes('evolution/experiments/EXP-test-agent-001/candidate/roles/analyst/AGENTS.md'))
    assert.equal(detail.verification.runs[0].id, 'run-11111111-1111-4111-8111-111111111111')
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

const sampleFeatures = [{ id: 'route', title: '意图路由', description: '按需求路由到对应能力。', source_refs: ['EXP-test-agent-001'], evidence_refs: [], change: '保留既有路由' }]

function versionRequest(commit, extra = {}) {
  return { agent_id: 'test-agent', parent_experiment_id: 'EXP-test-agent-001', parent_ref: `git:${commit}`, research_question: '在保留既有能力时验证新增行为', ...extra }
}

function fusionPlan(sources = []) {
  return { sources, features: sampleFeatures, conflicts: [], checks: [{ id: 'actual-load', kind: 'load' }, { id: 'route-behavior', kind: 'capability', case_ids: ['U-CASE-001'] }] }
}

function addVersion(root, id, fields) {
  const base = join(root, `evolution/experiments/${id}`)
  cpSync(join(root, 'evolution/experiments/EXP-test-agent-001/candidate'), join(base, 'candidate'), { recursive: true })
  write(join(base, 'change.yaml'), `schema_version: '1.0'\nexperiment_id: ${id}\nagent_id: test-agent\n${fields.includes('baseline_ref:') ? '' : 'baseline_ref: none:first-experiment\n'}${fields}`)
  write(join(base, 'hypothesis.md'), '# 比较\n\n验证并行来源的能力。\n')
  write(join(base, 'evaluation/observations.md'), '# 观察\n\n独立测试夹具。\n')
  write(join(base, 'decision.md'), '# Decision\n\n状态：adopt\n')
  const sourceFile = join(root, 'runtime/adapters/dsh-container/sources.json')
  const sources = JSON.parse(readFileSync(sourceFile, 'utf8'))
  sources.sources[id] = { ...sources.sources['EXP-test-agent-001'], candidate_root: `evolution/experiments/${id}/candidate/dsh` }
  write(sourceFile, JSON.stringify(sources))
}

function commitFixture(root, message) {
  run(root, 'git', ['add', '.'])
  run(root, 'git', ['commit', '-m', message])
  return run(root, 'git', ['rev-parse', 'HEAD'])
}

test('算力变体通过统一智能体路由预览和派生，原父版保持不变', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const context = await rpc(handler, 'compute-variants/context', { experiment_id: 'EXP-test-agent-001' })
    assert.ok(context.cases.some(item => item.case_id === 'U-CASE-001'))
    const input = { ...versionRequest(fx.commit), variant_name: '只读查询精简版', strategy: '减少重复查询，保留任务结果', case_ids: ['U-CASE-001'], critical_case_ids: ['U-CASE-001'], resource_metric: 'model_calls', min_resource_reduction_pct: 10 }
    const before = readFileSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/change.yaml'), 'utf8')
    const preview = await rpc(handler, 'compute-variants/preview', input)
    assert.equal(preview.variant_name, input.variant_name)
    assert.equal(preview.plan.min_runs_per_case, 2)
    assert.equal(preview.plan.model_change, null)
    const created = await rpc(handler, 'compute-variants/create', { ...input, expected_preview_sha256: preview.preview_sha256 })
    const variant = await rpc(handler, 'compute-variants/context', { experiment_id: created.experiment_id })
    assert.equal(variant.parent_experiment_id, 'EXP-test-agent-001')
    assert.equal(variant.fixed_parent_ref, `git:${fx.commit}`)
    assert.equal(variant.variant_kind, 'exploratory')
    assert.equal(variant.variant_name, input.variant_name)
    assert.deepEqual(variant.plan.case_hashes, preview.plan.case_hashes)
    assert.equal(readFileSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/change.yaml'), 'utf8'), before)
    const changeFile = join(fx.root, `evolution/experiments/${created.experiment_id}/change.yaml`)
    const digest = createHash('sha256').update(readFileSync(changeFile)).digest('hex')
    const listed = (await rpc(handler, 'list')).experiments.find(item => item.id === created.experiment_id)
    const detailed = (await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: created.experiment_id })).experiment
    assert.equal(listed.change.variant_name, input.variant_name)
    assert.equal(listed.change_sha256, digest)
    assert.equal(detailed.change_sha256, digest)
    const renamed = await rpc(handler, 'compute-variants/rename', { experiment_id: created.experiment_id, variant_name: '只读查询合并版', expected_change_sha256: digest })
    assert.notEqual(renamed.change_sha256, digest)
    assert.equal(renamed.variant_name, '只读查询合并版')
    const refreshed = (await rpc(handler, 'list')).experiments.find(item => item.id === created.experiment_id)
    assert.equal(refreshed.change.variant_name, renamed.variant_name)
    assert.equal(refreshed.change_sha256, renamed.change_sha256)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('算力 end 只在确认的 Candidate 和计划未改变时排除融合', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const id = 'EXP-test-agent-002'
    const fields = `status: completed\noutcome: adopt\nvariant_kind: end\nparent_experiment_id: EXP-test-agent-001\nbaseline_ref: git:${fx.commit}\nend_confirmed: true\nequivalence_evidence_refs: [agents/test-agent/evaluation.md]\nresource_evidence_refs: [agents/test-agent/evaluation.md]\ncompute_variant:\n  strategy: 保留效果并减少重复调用\n`
    addVersion(fx.root, id, fields)
    const confirmed = commitFixture(fx.root, 'fixed compute candidate')
    const changeFile = join(fx.root, `evolution/experiments/${id}/change.yaml`)
    write(changeFile, readFileSync(changeFile, 'utf8') + `compute_variant_decision:\n  variant_ref: git:${confirmed}\n`)
    commitFixture(fx.root, 'confirm observed compute variant')
    const handler = createAgentsHandler(fx.root)
    const status = async () => (await rpc(handler, 'fusion/preview', versionRequest(fx.commit))).inventory.sources.find(row => row.experiment_id === id).status
    assert.equal(await status(), 'excluded')
    write(join(fx.root, `evolution/experiments/${id}/candidate/dsh/workspace/later.md`), '确认后新增行为\n')
    commitFixture(fx.root, 'changed candidate requires review')
    assert.equal(await status(), 'needs_review')
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('特性确认使用嵌套 YAML 唯一来源，Run index 与新 Run 仍能读取，过时草稿不覆盖资产', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const preview = await rpc(handler, 'features/preview', { experiment_id: 'EXP-test-agent-001', features: sampleFeatures })
    await assert.rejects(() => rpc(handler, 'features/apply', { preview_id: preview.preview_id }), /confirmation_required/)
    await rpc(handler, 'features/apply', { preview_id: preview.preview_id, confirmed: true })
    const change = loadYaml(readFileSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/change.yaml'), 'utf8'))
    assert.deepEqual(change.fusion_sources, ['EXP-test-agent-000'])
    assert.deepEqual(change.features, sampleFeatures)
    assert.equal((await rpc(handler, 'detail', { agent_id: 'test-agent' })).features[0].verification, '尚未验证')
    assert.equal((await rpc(handler, 'runs/index', { agent_id: 'test-agent' })).experiments[0].experiment_id, 'EXP-test-agent-001')
    const runId = run(fx.root, 'python3', ['runtime/adapters/dsh-container/run_record.py', 'init', '--source', 'experiment:EXP-test-agent-001', '--case', 'U-CASE-001', '--review-mode', 'none'])
    assert.match(runId, /^run-/)
    const stale = await rpc(handler, 'features/preview', { experiment_id: 'EXP-test-agent-001', features: [] })
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/harness.yaml'), 'name: changed\n')
    await assert.rejects(() => rpc(handler, 'features/apply', { preview_id: stale.preview_id, confirmed: true }), /conflict/)
    assert.deepEqual(loadYaml(readFileSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/change.yaml'), 'utf8')).features, sampleFeatures)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('融合盘点使用固定来源图，end 必须用户确认等效和资源证据，去掉可恢复的重复祖先', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    addVersion(fx.root, 'EXP-test-agent-002', 'status: completed\noutcome: adopt\n')
    const secondCommit = commitFixture(fx.root, 'parallel capability')
    const changes = {
      'EXP-test-agent-003': `status: completed\noutcome: adopt\nparent_experiment_id: EXP-test-agent-002\nbaseline_ref: git:${secondCommit}\n`,
      'EXP-test-agent-004': `status: completed\noutcome: reject\n`,
      'EXP-test-agent-005': `status: completed\noutcome: adopt\nvariant_kind: end\nparent_experiment_id: EXP-test-agent-001\nbaseline_ref: git:${fx.commit}\nequivalence_evidence_refs:\n  - agents/test-agent/evaluation.md\n`,
      'EXP-test-agent-006': `status: active\nvariant_kind: end\n`,
      'EXP-test-agent-007': `status: completed\noutcome: adopt\nvariant_kind: end\nparent_experiment_id: EXP-test-agent-001\nbaseline_ref: git:${fx.commit}\nend_confirmed: true\nequivalence_evidence_refs:\n  - evolution/experiments/EXP-test-agent-007/evaluation/equivalence.md\nresource_evidence_refs:\n  - evolution/experiments/EXP-test-agent-007/evaluation/resources.md\n`,
    }
    for (const [id, fields] of Object.entries(changes)) addVersion(fx.root, id, fields)
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-007/evaluation/equivalence.md'), '用户确认：本次比较范围内效果等效。\n')
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-007/evaluation/resources.md'), '用户确认：已核对模型及资源差异。\n')
    commitFixture(fx.root, 'recoverable derived versions')
    const value = await rpc(createAgentsHandler(fx.root), 'fusion/preview', versionRequest(fx.commit))
    assert.deepEqual(value.inventory.superseded, ['EXP-test-agent-002'])
    assert.equal(value.inventory.sources.find(row => row.experiment_id.endsWith('003')).status, 'recommended')
    assert.equal(value.inventory.sources.find(row => row.experiment_id.endsWith('004')).status, 'excluded')
    assert.equal(value.inventory.sources.find(row => row.experiment_id.endsWith('005')).status, 'needs_review')
    assert.equal(value.inventory.sources.find(row => row.experiment_id.endsWith('006')).status, 'needs_review')
    assert.equal(value.inventory.sources.find(row => row.experiment_id.endsWith('007')).status, 'excluded')
    assert.equal(value.inventory.sources.some(row => row.experiment_id.endsWith('099')), false)
    assert.equal(value.plan_ready, false)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('固定父版不会读取后来工作树的融合声明，过时完成标记和发生变化的来源不能抑制并行能力', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    addVersion(fx.root, 'EXP-test-agent-002', 'status: completed\noutcome: adopt\n')
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-002/candidate/dsh/workspace/parallel.txt'), 'parallel capability\n')
    const sourceCommit = commitFixture(fx.root, 'source before fusion')
    const parentChange = join(fx.root, 'evolution/experiments/EXP-test-agent-001/change.yaml')
    write(parentChange, `schema_version: '1.0'\nexperiment_id: EXP-test-agent-001\nagent_id: test-agent\nbaseline_ref: none:first-experiment\nstatus: active\nfusion_sources:\n  - experiment_id: EXP-test-agent-002\n    ref: git:${sourceCommit}\ncreation:\n  status: completed\n  candidate_sha256: stale\n  source_sha256: stale\n  plan: {}\n  receipts: []\n`)
    const handler = createAgentsHandler(fx.root)
    const before = await rpc(handler, 'fusion/preview', versionRequest(fx.commit))
    assert.deepEqual(before.inventory.covered, ['EXP-test-agent-001'])
    assert.ok(before.inventory.sources.some(row => row.experiment_id === 'EXP-test-agent-002'))
    const staleCommit = commitFixture(fx.root, 'stale completion cannot establish inheritance')
    const stale = await rpc(handler, 'fusion/preview', versionRequest(staleCommit))
    assert.equal(stale.inventory.covered.includes('EXP-test-agent-002'), false)
    write(parentChange, `schema_version: '1.0'\nexperiment_id: EXP-test-agent-001\nagent_id: test-agent\nbaseline_ref: none:first-experiment\nstatus: active\nfusion_sources:\n  - experiment_id: EXP-test-agent-002\n    ref: git:${sourceCommit}\n`)
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh/workspace/parallel.txt'), 'parallel capability\n')
    const fusedCommit = commitFixture(fx.root, 'fixed declaration with included assets')
    const covered = await rpc(handler, 'fusion/preview', versionRequest(fusedCommit))
    assert.ok(covered.inventory.covered.includes('EXP-test-agent-002'))
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-002/candidate/dsh/workspace/new.txt'), 'later capability\n')
    const changed = await rpc(handler, 'fusion/preview', versionRequest(fusedCommit))
    assert.equal(changed.inventory.covered.includes('EXP-test-agent-002'), false)
    assert.equal(changed.inventory.sources.find(row => row.experiment_id === 'EXP-test-agent-002').status, 'needs_review')
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('确认前不创建，固定来源路径随 Candidate 重定位，重复确认不重建且保留融合状态与原会话', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const sourceFile = join(fx.root, 'runtime/adapters/dsh-container/sources.json')
    const sources = JSON.parse(readFileSync(sourceFile, 'utf8'))
    sources.sources['EXP-test-agent-001'].profile_manifest = 'evolution/experiments/EXP-test-agent-001/candidate/dsh/managed/web-profile.package.json'
    write(sourceFile, JSON.stringify(sources))
    write(join(fx.root, sources.sources['EXP-test-agent-001'].profile_manifest), '{"name":"fixture-profile"}\n')
    run(fx.root, 'git', ['add', '.'])
    run(fx.root, 'git', ['commit', '-m', 'profile'])
    const commit = run(fx.root, 'git', ['rev-parse', 'HEAD'])
    const handler = createAgentsHandler(fx.root)
    const preview = await rpc(handler, 'fusion/preview', versionRequest(commit, { plan: fusionPlan(), assistant_session_id: 'session-fixture' }))
    assert.equal((await rpc(handler, 'list')).experiments.length, 1)
    assert.equal((await rpc(handler, 'fusion/proposal', { agent_id: 'test-agent' })).proposal.assistant_session_id, 'session-fixture')
    const created = await rpc(handler, 'fusion/confirm', { preview_id: preview.preview_id, confirmed: true })
    assert.equal(created.creation_status, 'integrating')
    const source = JSON.parse(readFileSync(sourceFile, 'utf8')).sources[created.experiment_id]
    assert.equal(source.profile_manifest, `evolution/experiments/${created.experiment_id}/candidate/dsh/managed/web-profile.package.json`)
    const status = await rpc(handler, 'fusion/status', { experiment_id: created.experiment_id })
    assert.equal(status.creation.assistant_session_id, 'session-fixture')
    assert.deepEqual(status.creation.plan.features, sampleFeatures)
    await assert.rejects(() => rpc(handler, 'fusion/confirm', { preview_id: preview.preview_id, confirmed: true }), /preview_expired/)
    await assert.rejects(() => rpc(handler, 'fusion/finalize', { experiment_id: created.experiment_id, expected_candidate_sha256: status.candidate_sha256 }), /verification_incomplete/)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('融合方案锁定已选 Case 口径，确认前改变预期必须重新预览', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const preview = await rpc(handler, 'fusion/preview', versionRequest(fx.commit, { plan: fusionPlan() }))
    const evaluation = join(fx.root, 'agents/test-agent/evaluation.md')
    write(evaluation, readFileSync(evaluation, 'utf8').replace('返回 pong。', '返回新标准。'))
    await assert.rejects(() => rpc(handler, 'fusion/confirm', { preview_id: preview.preview_id, confirmed: true }), /conflict/)
    assert.equal((await rpc(handler, 'list')).experiments.length, 1)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('融合必须有封存 Run 的目标来源、资产 hash 与实际 Session 证据，模型声明不构成完成', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const preview = await rpc(handler, 'fusion/preview', versionRequest(fx.commit, { plan: fusionPlan() }))
    const created = await rpc(handler, 'fusion/confirm', { preview_id: preview.preview_id, confirmed: true })
    const id = created.experiment_id
    const status = await rpc(handler, 'fusion/status', { experiment_id: id })
    const expected = { experiment_id: id, expected_candidate_sha256: status.candidate_sha256 }
    const runArgs = ['runtime/adapters/dsh-container/run_record.py']
    const runId = run(fx.root, 'python3', [...runArgs, 'init', '--source', `experiment:${id}`, '--case', 'U-CASE-001', '--review-mode', 'none'])
    const base = join(fx.root, `evolution/experiments/${id}/runs/${runId}`)
    await assert.rejects(() => rpc(handler, 'fusion/verify', { ...expected, check_id: 'actual-load', run_id: runId, loaded: true }), /verification_failed/)
    write(join(base, 'evidence/U-CASE-001/response.json'), '{"assistant_texts":["pong"]}')
    write(join(base, 'evidence/U-CASE-001/trace.jsonl'), '{"event":{"type":"session/created","createdAt":1}}\n')
    write(join(base, 'evidence/U-CASE-001/checks.json'), '{"session_id":"fixture-session","preset_matches":true,"workspace_matches":true}')
    write(join(base, 'evidence/dsh-image.json'), JSON.stringify({ source_id: `experiment:${id}`, local_image_id: `sha256:${'1'.repeat(64)}` }))
    write(join(fx.root, 'trial.json'), JSON.stringify({ run_id: runId, trial_id: 'trial-1', input_id: 'U-CASE-001', execution_status: 'completed', verdict: 'passed', observation: '独立夹具模拟外部 Runtime 的 pong 回执', evidence_ref: 'evidence/U-CASE-001/response.json' }))
    run(fx.root, 'python3', [...runArgs, 'record', '--run', runId, 'trial.json'])
    run(fx.root, 'python3', [...runArgs, 'finalize', '--run', runId, '--status', 'completed'])
    await rpc(handler, 'fusion/verify', { ...expected, check_id: 'actual-load', run_id: runId })
    await rpc(handler, 'fusion/verify', { ...expected, check_id: 'route-behavior', run_id: runId })
    const finished = await rpc(handler, 'fusion/finalize', expected)
    assert.equal(finished.creation_status, 'completed')
    const evaluation = join(fx.root, 'agents/test-agent/evaluation.md')
    const originalEvaluation = readFileSync(evaluation, 'utf8')
    write(evaluation, originalEvaluation.replace('返回 pong。', '返回新标准。'))
    await assert.rejects(() => rpc(handler, 'fusion/verify', { ...expected, check_id: 'route-behavior', run_id: runId }), /evaluation_conflict/)
    await assert.rejects(() => rpc(handler, 'fusion/finalize', expected), /evaluation_conflict/)
    assert.equal((await rpc(handler, 'fusion/status', { experiment_id: id })).creation.status, 'integrating')
    // 未选 Case 的变化不应使本次约定能力的证据作废。
    write(evaluation, originalEvaluation + '\n#### U-CASE-002 未选能力\n\n**用户输入**\n> new input\n\n**预期**\n新的独立标准。\n')
    await rpc(handler, 'fusion/verify', { ...expected, check_id: 'route-behavior', run_id: runId })
    assert.equal((await rpc(handler, 'fusion/finalize', expected)).creation_status, 'completed')
    // 封存证据变化后，旧验证回执不能再次证明完成。
    write(join(base, 'evidence/U-CASE-001/response.json'), '{"assistant_texts":["changed"]}')
    await assert.rejects(() => rpc(handler, 'fusion/finalize', expected), /verification_incomplete/)
    write(join(fx.root, `evolution/experiments/${id}/candidate/dsh/workspace/input.txt`), 'changed')
    await assert.rejects(() => rpc(handler, 'fusion/verify', { ...expected, check_id: 'actual-load', run_id: runId }), /conflict/)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('agents detail prefers active version while preserving explicit selection and newest fallback', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const manifestPath = join(fx.root, 'agents/test-agent/manifest.yaml')
    const manifest = readFileSync(manifestPath, 'utf8')
    cpSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate'), join(fx.root, 'evolution/experiments/EXP-test-agent-010-r123456789abc/candidate'), { recursive: true })
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-010-r123456789abc/change.yaml'), 'experiment_id: EXP-test-agent-010-r123456789abc\nagent_id: test-agent\nbaseline_ref: none:first-experiment\nstatus: active\n')
    const handler = createAgentsHandler(fx.root)
    const latest = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    assert.equal(latest.experiment.id, 'EXP-test-agent-001')
    assert.equal(latest.selection.basis, 'active_experiment')
    assert.deepEqual(latest.versions.map(version => version.id), ['EXP-test-agent-010-r123456789abc', 'EXP-test-agent-001'])
    const older = await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: 'EXP-test-agent-001' })
    assert.equal(older.experiment.id, 'EXP-test-agent-001')
    assert.equal(readFileSync(manifestPath, 'utf8'), manifest)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('融合确认拒绝预览后变化的 Candidate，避免沿用过期覆盖关系', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const preview = await rpc(handler, 'fusion/preview', {
      agent_id: 'test-agent', parent_experiment_id: 'EXP-test-agent-001', parent_ref: `git:${fx.commit}`,
      research_question: '在固定父版上验证基础能力',
      plan: { sources: [], features: [], conflicts: [], checks: [
        { id: 'actual-load', kind: 'load' },
        { id: 'basic-capability', kind: 'capability', case_ids: ['U-CASE-001'] },
      ] },
    })
    assert.deepEqual(preview.inventory.covered, ['EXP-test-agent-001'])
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/dsh/workspace/input.txt'), 'changed after preview\n')
    await assert.rejects(() => rpc(handler, 'fusion/confirm', { preview_id: preview.preview_id, confirmed: true }), /conflict:/)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(fx.root, 'runtime/adapters/dsh-container/sources.json'), 'utf8')).sources), ['EXP-test-agent-001'])
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('未变化的融合预览可创建版本，但缺少真实验证不能完成', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const preview = await rpc(handler, 'fusion/preview', {
      agent_id: 'test-agent', parent_experiment_id: 'EXP-test-agent-001', parent_ref: `git:${fx.commit}`,
      research_question: '建立基础能力的待验证版本',
      plan: { sources: [], features: [], conflicts: [], checks: [
        { id: 'actual-load', kind: 'load' },
        { id: 'basic-capability', kind: 'capability', case_ids: ['U-CASE-001'] },
      ] },
    })
    const created = await rpc(handler, 'fusion/confirm', { preview_id: preview.preview_id, confirmed: true })
    assert.equal(created.creation_status, 'integrating')
    const status = await rpc(handler, 'fusion/status', { experiment_id: created.experiment_id })
    assert.equal(status.creation.status, 'integrating')
    assert.deepEqual(status.creation.receipts, [])
    await assert.rejects(() => rpc(handler, 'fusion/finalize', {
      experiment_id: created.experiment_id, expected_candidate_sha256: status.candidate_sha256,
    }), /verification_incomplete:/)
    await assert.rejects(() => rpc(handler, 'fusion/confirm', { preview_id: preview.preview_id, confirmed: true }), /preview_expired:/)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('create validation failure restores catalog and removes dangling source', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const before = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/sources.json'), 'utf8')
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    write(join(fx.root, 'runtime/research/validate_experiment.py'), 'import sys\nraise SystemExit("bad validator")\n')
    await assert.rejects(
      () => rpc(handler, 'create', {
        agent_id: 'test-agent',
        parent_ref: `git:${fx.commit}`,
        parent_experiment_id: 'EXP-test-agent-001',
        catalog_sha256: detail.declared.source_catalog_sha256,
        research_question: '验证校验失败时不会留下 dangling source',
      }),
      /command_failed:/,
    )
    assert.equal(readFileSync(join(fx.root, 'runtime/adapters/dsh-container/sources.json'), 'utf8'), before)
    const sources = JSON.parse(before).sources
    assert.deepEqual(Object.keys(sources), ['EXP-test-agent-001'])
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('create source_contract failure restores catalog and removes dangling source', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const sourcesPath = join(fx.root, 'runtime/adapters/dsh-container/sources.json')
    const badCatalog = JSON.parse(readFileSync(sourcesPath, 'utf8'))
    badCatalog.sources['EXP-test-agent-001'].preset = 'missing/preset.yml'
    write(sourcesPath, JSON.stringify(badCatalog, null, 2) + '\n')
    run(fx.root, 'git', ['add', 'runtime/adapters/dsh-container/sources.json'])
    run(fx.root, 'git', ['commit', '-m', 'bad preset catalog'])
    const badCommit = run(fx.root, 'git', ['rev-parse', 'HEAD'])

    const handler = createAgentsHandler(fx.root)
    const before = readFileSync(sourcesPath, 'utf8')
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    await assert.rejects(
      () => rpc(handler, 'create', {
        agent_id: 'test-agent',
        parent_ref: `git:${badCommit}`,
        parent_experiment_id: 'EXP-test-agent-001',
        catalog_sha256: detail.declared.source_catalog_sha256,
        research_question: '验证 source_contract 失败时不会留下 dangling source',
      }),
      /command_failed:/,
    )
    assert.equal(readFileSync(sourcesPath, 'utf8'), before)
    assert.deepEqual(Object.keys(JSON.parse(before).sources), ['EXP-test-agent-001'])
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('create keeps files and returns needs_recovery when catalog changed after write', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    write(join(fx.root, 'runtime/research/validate_experiment.py'), [
      'import json',
      'from pathlib import Path',
      'path = Path("runtime/adapters/dsh-container/sources.json")',
      'data = json.loads(path.read_text(encoding="utf-8"))',
      'data["external_change"] = True',
      'path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")',
      'raise SystemExit("bad validator with external catalog change")',
      '',
    ].join('\n'))
    await assert.rejects(
      () => rpc(handler, 'create', {
        agent_id: 'test-agent',
        parent_ref: `git:${fx.commit}`,
        parent_experiment_id: 'EXP-test-agent-001',
        catalog_sha256: detail.declared.source_catalog_sha256,
        research_question: '验证外部 catalog 变化时保留恢复现场',
      }),
      /needs_recovery:/,
    )
    const catalog = JSON.parse(readFileSync(join(fx.root, 'runtime/adapters/dsh-container/sources.json'), 'utf8'))
    const createdId = Object.keys(catalog.sources).find(id => id !== 'EXP-test-agent-001')
    assert.ok(createdId)
    assert.equal(existsSync(join(fx.root, 'evolution/experiments', createdId)), true)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('create copies fixed git parent candidate, validates source and dry-runs dsh-eval', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    const created = await rpc(handler, 'create', {
      agent_id: 'test-agent',
      parent_ref: `git:${fx.commit}`,
      parent_experiment_id: 'EXP-test-agent-001',
      catalog_sha256: detail.declared.source_catalog_sha256,
      research_question: '验证从当前版本派生新 Candidate 后仍能定位 DSH source',
    })
    assert.match(created.experiment_id, /^EXP-test-agent-002-r[0-9a-f]{12}$/)
    assert.equal(created.validation.valid, true)
    assert.deepEqual(created.dry_run.case_ids, ['U-CASE-001'])
    assert.equal(readFileSync(join(fx.root, `evolution/experiments/${created.experiment_id}/candidate/harness.yaml`), 'utf8'), 'name: test\n')
    assert.equal(existsSync(join(fx.root, `evolution/experiments/${created.experiment_id}/candidate/RuntimeHOME/session.txt`)), false)
    const sources = JSON.parse(readFileSync(join(fx.root, 'runtime/adapters/dsh-container/sources.json'), 'utf8'))
    assert.equal(sources.sources[created.experiment_id].candidate_root, `evolution/experiments/${created.experiment_id}/candidate/dsh`)
    assert.equal(readFileSync(join(fx.root, `evolution/experiments/${created.experiment_id}/change.yaml`), 'utf8').includes('parent_experiment_id: "EXP-test-agent-001"'), true)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

for (const changedLock of [false, true]) test(`固定父版派生${changedLock ? '不借用锁已变化的依赖' : '复用匹配锁的忽略依赖并保持相对链接'}`, async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const parent = 'evolution/experiments/EXP-test-agent-001/candidate', pluginPath = 'dsh/managed/local-plugin'
    write(join(fx.root, '.gitignore'), 'node_modules/\n')
    write(join(fx.root, parent, pluginPath, 'package.json'), JSON.stringify({ name: 'local-plugin', packageManager: 'npm@10.0.0', dependencies: { 'fixture-dependency': '1.0.0' } }))
    write(join(fx.root, parent, pluginPath, 'package-lock.json'), JSON.stringify({ name: 'local-plugin', lockfileVersion: 3, packages: { '': { dependencies: { 'fixture-dependency': '1.0.0' } } } }))
    run(fx.root, 'git', ['add', '.'])
    run(fx.root, 'git', ['commit', '-m', 'fixed plugin dependency lock'])
    const commit = run(fx.root, 'git', ['rev-parse', 'HEAD'])
    const modules = join(fx.root, parent, pluginPath, 'node_modules')
    write(join(modules, 'fixture-dependency/package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0', main: 'index.cjs' }))
    write(join(modules, 'fixture-dependency/index.cjs'), 'module.exports={value:"locked-parent"}\n')
    mkdirSync(join(modules, '.bin'), { recursive: true })
    symlinkSync('../fixture-dependency/index.cjs', join(modules, '.bin/fixture-cli'))
    if (changedLock) write(join(fx.root, parent, pluginPath, 'package-lock.json'), JSON.stringify({ name: 'local-plugin', lockfileVersion: 3, packages: { '': { dependencies: { 'fixture-dependency': '2.0.0' } } } }))
    const handler = createAgentsHandler(fx.root)
    const created = await rpc(handler, 'create', { agent_id: 'test-agent', parent_experiment_id: 'EXP-test-agent-001', parent_ref: `git:${commit}`, research_question: '核验固定父版派生后的运行依赖' })
    const child = `evolution/experiments/${created.experiment_id}/candidate`, destination = join(fx.root, child, pluginPath, 'node_modules')
    assert.equal(existsSync(destination), !changedLock)
    assert.equal(created.dependency_reuse.reused.length, changedLock ? 0 : 1)
    if (!changedLock) {
      assert.equal(readlinkSync(join(destination, '.bin/fixture-cli')), '../fixture-dependency/index.cjs')
      assert.equal(run(fx.root, process.execPath, ['-e', "const r=require('node:module').createRequire(process.argv[1]);process.stdout.write(r('fixture-dependency').value)", join(fx.root, child, pluginPath, 'package.json')]), 'locked-parent')
      const before = (await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: created.experiment_id })).candidate_sha256
      write(join(destination, 'fixture-dependency/index.cjs'), 'module.exports={value:"local-only-change"}\n')
      assert.equal((await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: created.experiment_id })).candidate_sha256, before)
      assert.equal(run(fx.root, 'git', ['ls-files', '--others', '--exclude-standard', '--', `${child}/${pluginPath}/node_modules`]), '')
      assert.equal(run(fx.root, 'git', ['ls-files', '--', `${child}/${pluginPath}/node_modules`]), '')
    } else {
      assert.equal(created.dependency_reuse.skipped.length, 1)
      assert.equal(JSON.parse(readFileSync(join(fx.root, child, pluginPath, 'package-lock.json'))).packages[''].dependencies['fixture-dependency'], '1.0.0')
    }
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('新建源码以 null 固定不存在状态，空文件并发创建后拒绝旧预览', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const path = 'candidate/dsh/managed/workflow.ts'
    const missing = await rpc(handler, 'edit/read', { experiment_id: 'EXP-test-agent-001', path })
    assert.equal(missing.exists, false)
    assert.equal(missing.sha256, null)
    const edits = [{ path, content: 'export const workflow = true\n', expected_sha256: null }]
    const preview = await rpc(handler, 'edit/preview', { experiment_id: 'EXP-test-agent-001', edits })
    assert.equal(preview.edits[0].before_sha256, null)
    const actual = join(fx.root, 'evolution/experiments/EXP-test-agent-001', path)
    mkdirSync(dirname(actual), { recursive: true })
    writeFileSync(actual, '')
    await assert.rejects(() => rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits }), /conflict:/)
    assert.equal(readFileSync(actual, 'utf8'), '')
    const existing = await rpc(handler, 'edit/read', { experiment_id: 'EXP-test-agent-001', path })
    assert.equal(existing.exists, true)
    await rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ ...edits[0], expected_sha256: existing.sha256 }] })
    assert.equal(readFileSync(actual, 'utf8'), edits[0].content)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('edit reads existing content, uses preview hash, rejects unsafe writes and preserves runs', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const read = await rpc(handler, 'edit/read', { experiment_id: 'EXP-test-agent-001', path: 'candidate/harness.yaml' })
    assert.equal(read.content, 'name: test\n')
    await assert.rejects(
      () => rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/harness.yaml', content: 'name: changed\n', expected_sha256: 'bad' }] }),
      /conflict:/,
    )
    const preview = await rpc(handler, 'edit/preview', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/harness.yaml', content: 'name: changed\n', expected_sha256: read.sha256 }] })
    assert.equal(preview.edits[0].before_sha256, read.sha256)
    await rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/harness.yaml', content: 'name: changed\n', expected_sha256: preview.edits[0].before_sha256 }] })
    assert.equal(readFileSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/harness.yaml'), 'utf8'), 'name: changed\n')
    await assert.rejects(
      () => rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'evolution/experiments/EXP-test-agent-001/runs/run-11111111-1111-4111-8111-111111111111/run.json', content: '{}', expected_sha256: 'bad' }] }),
      /path_rejected:/,
    )
    for (const path of ['candidate/cache/x', 'candidate/sessions/x', 'candidate/.git/config', 'candidate/nested/key.llm-api-key']) {
      await assert.rejects(
        () => rpc(handler, 'edit/read', { experiment_id: 'EXP-test-agent-001', path }),
        /path_rejected:/,
      )
    }
    const outside = join(fx.root, 'outside.txt')
    writeFileSync(outside, 'outside\n')
    symlinkSync(outside, join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/link.txt'))
    await assert.rejects(
      () => rpc(handler, 'edit/preview', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/link.txt', content: 'nope\n' }] }),
      /path_rejected:/,
    )
    await assert.rejects(
      () => rpc(handler, 'edit/preview', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'decision.md', content: 'LOCAL_LLM_API_KEY=sk-secret' }] }),
      error => error instanceof Error && /secret_rejected:/.test(error.message) && !error.message.includes('sk-secret'),
    )
    const beforeRun = readFileSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs/run-11111111-1111-4111-8111-111111111111/run.json'), 'utf8')
    const evalPreview = await rpc(handler, 'edit/preview', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'evaluation.md', content: [
      '# Evaluation',
      '',
      '#### U-CASE-002 新',
      '**评估档位：** `fast`',
      '',
      '**用户输入**',
      '> pong',
      '',
      '**预期**',
      '返回 ping。',
      '',
    ].join('\n') }] })
    assert.equal(evalPreview.edits[0].changed, true)
    assert.equal(evalPreview.dry_run.mode, 'dry')
    assert.deepEqual(evalPreview.dry_run.case_ids, ['U-CASE-002'])
    assert.match(readFileSync(join(fx.root, 'agents/test-agent/evaluation.md'), 'utf8'), /U-CASE-001/)
    assert.equal(readFileSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs/run-11111111-1111-4111-8111-111111111111/run.json'), 'utf8'), beforeRun)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('资产树展示真实嵌套目录，二进制只读，排除运行目录、密钥和链接', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  const base = 'evolution/experiments/EXP-test-agent-001/candidate'
  try {
    write(join(fx.root, base, 'dsh/workspace/.dsh/skills/nested/SKILL.md'), '# Nested\n')
    write(join(fx.root, base, 'image.bin'), Buffer.from([0, 255, 1]))
    write(join(fx.root, base, 'large.txt'), 'x'.repeat(1024 * 1024 + 1))
    write(join(fx.root, base, 'nested/local.llm-api-key'), 'fixture-secret')
    symlinkSync(join(fx.root, 'agents'), join(fx.root, base, 'link'))
    const handler = createAgentsHandler(fx.root)
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    assert.equal(detail.assets[0].kind, 'directory')
    const paths = JSON.stringify(detail.assets)
    assert.match(paths, /workspace\/\.dsh\/skills\/nested\/SKILL.md/)
    for (const excluded of ['RuntimeHOME', 'history', 'local.llm-api-key', `${base}/link`]) assert.equal(paths.includes(excluded), false)
    const dir = await rpc(handler, 'edit/read', { experiment_id: 'EXP-test-agent-001', path: base })
    assert.equal(dir.editable, false)
    for (const file of ['image.bin', 'large.txt']) {
      const read = await rpc(handler, 'edit/read', { experiment_id: 'EXP-test-agent-001', path: `${base}/${file}` })
      assert.equal(read.editable, false)
      assert.equal(read.content, undefined)
      await assert.rejects(() => rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: `${base}/${file}`, content: 'replacement', expected_sha256: 'bad' }] }), /只读/)
    }
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('直接保存也执行草稿 dry；格式或来源失败不写入，缺失环境仅提示，!!js 不执行', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const experiment_id = 'EXP-test-agent-001'
    const path = 'candidate/harness.yaml'
    const original = await rpc(handler, 'edit/read', { experiment_id, path })
    const apply = content => rpc(handler, 'edit/apply', { experiment_id, edits: [{ path, content, expected_sha256: original.sha256 }] })
    await assert.rejects(() => apply('name: [invalid\n'), /草稿格式无效/)
    const catalogPath = join(fx.root, 'runtime/adapters/dsh-container/sources.json')
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
    catalog.sources[experiment_id].preset = 'missing/preset.yml'
    write(catalogPath, JSON.stringify(catalog))
    await assert.rejects(() => apply('name: valid\n'), /草稿 dry 校验失败/)
    assert.equal((await rpc(handler, 'edit/read', { experiment_id, path })).content, original.content)
    catalog.sources[experiment_id].preset = 'test-agent/preset.yml'
    catalog.sources[experiment_id].required_env_names = ['HARNESS_DRAFT_TEST_MISSING_ENV']
    write(catalogPath, JSON.stringify(catalog))
    const content = 'name: valid\nconfig: !!js |\n  (() => { throw new Error("must not execute") })()\n'
    const saved = await apply(content)
    assert.equal(saved.dry_run.mode, 'dry')
    assert.deepEqual(saved.dry_run.missing_env_names, ['HARNESS_DRAFT_TEST_MISSING_ENV'])
    assert.equal((await rpc(handler, 'edit/read', { experiment_id, path })).content, content)
    assert.equal(readFileSync(join(fx.root, 'evolution/experiments', experiment_id, 'runs/run-11111111-1111-4111-8111-111111111111/run.json'), 'utf8'), '{"status":"failed"}\n')
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('JS 草稿预览和直接保存拒绝真实 Guard 属性片段，同批资产保持原样', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const experiment_id = 'EXP-test-agent-001'
    const harness = await rpc(handler, 'edit/read', { experiment_id, path: 'candidate/harness.yaml' })
    // 真实生成失败形态：把完整 Guard 模块替换成一个对象属性片段。
    const fragment = "  assetAlerts: Object.freeze([\n    'query_asset_related_alerts_readonly',\n    'get_soc_asset_by_asset_id',\n    'list_detect_alert',\n  ]),"
    for (const extension of ['.js', '.mjs', '.cjs']) {
      const path = `candidate/dsh/managed/security-operations-guard${extension}`
      const original = extension === '.cjs' ? 'module.exports = {}\n' : 'export const guard = {}\n'
      const file = join(fx.root, 'evolution/experiments', experiment_id, path)
      write(file, original)
      const read = await rpc(handler, 'edit/read', { experiment_id, path })
      const edits = [
        { path: 'candidate/harness.yaml', content: 'name: must-not-write\n', expected_sha256: harness.sha256 },
        { path, content: fragment, expected_sha256: read.sha256 },
      ]
      for (const endpoint of ['edit/preview', 'edit/apply']) {
        const result = await handler(endpoint, { experiment_id, edits }, new AbortController().signal)
        assert.equal(result.ok, false)
        assert.equal(result.error.code, 'invalid_request')
        assert.match(result.error.message, /JavaScript 草稿语法校验失败/)
        assert.match(result.error.details.reason, /^SyntaxError:/)
        assert.equal(result.error.details.path, `evolution/experiments/${experiment_id}/${path}`)
        assert.equal(result.error.details.checker, 'node --check')
        assert.equal(JSON.stringify(result).includes('assetAlerts'), false, '错误摘要不回显源码行')
        assert.equal(readFileSync(file, 'utf8'), original)
        assert.equal((await rpc(handler, 'edit/read', { experiment_id, path: 'candidate/harness.yaml' })).content, harness.content)
      }
    }
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('JS 草稿只做语法检查，不执行顶层写入或解析未编辑 vendor 和历史模块', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const experiment_id = 'EXP-test-agent-001'
    const base = join(fx.root, 'evolution/experiments', experiment_id, 'candidate')
    const marker = join(fx.root, 'must-not-execute')
    write(join(base, 'dsh/managed/vendor/bundle.mjs'), 'export const broken = ;\n')
    write(join(base, 'dsh/managed/old-guard.js'), 'const broken = ;\n')
    write(join(base, 'history/old-guard.cjs'), 'const broken = ;\n')
    const edits = ['.js', '.mjs', '.cjs'].map(extension => ({
      path: `candidate/dsh/managed/checked${extension}`,
      content: extension === '.cjs'
        ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nmodule.exports = {};\n`
        : `import { writeFileSync } from 'node:fs';\nimport './missing-never-resolved.mjs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\nexport const guard = {};\n`,
      expected_sha256: null,
    }))
    const preview = await rpc(handler, 'edit/preview', { experiment_id, edits })
    assert.ok(preview.dry_run.checks.includes('JavaScript 语法（仅本次草稿）'))
    assert.equal(existsSync(marker), false)
    for (const edit of edits) assert.equal(existsSync(join(fx.root, 'evolution/experiments', experiment_id, edit.path)), false)
    const saved = await rpc(handler, 'edit/apply', { experiment_id, edits })
    assert.ok(saved.dry_run.checks.includes('JavaScript 语法（仅本次草稿）'))
    assert.equal(existsSync(marker), false)
    for (const edit of edits) assert.equal(readFileSync(join(fx.root, 'evolution/experiments', experiment_id, edit.path), 'utf8'), edit.content)
    assert.equal(readFileSync(join(base, 'dsh/managed/vendor/bundle.mjs'), 'utf8'), 'export const broken = ;\n')
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('edit apply rejects traversal, duplicate paths and concurrent same-hash writes', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    await assert.rejects(() => rpc(handler, 'detail', { agent_id: '../../bad' }), /invalid_request:/)
    await assert.rejects(() => rpc(handler, 'cases/list', { agent_id: '../../bad' }), /invalid_request:/)
    await assert.rejects(() => rpc(handler, 'edit/read', { experiment_id: '../../bad', path: 'candidate/harness.yaml' }), /invalid_request:/)
    const read = await rpc(handler, 'edit/read', { experiment_id: 'EXP-test-agent-001', path: 'candidate/harness.yaml' })
    await assert.rejects(
      () => rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [
        { path: 'candidate/harness.yaml', content: 'a\n', expected_sha256: read.sha256 },
        { path: 'evolution/experiments/EXP-test-agent-001/candidate/harness.yaml', content: 'b\n', expected_sha256: read.sha256 },
      ] }),
      /重复路径/,
    )
    const first = rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/harness.yaml', content: 'name: one\n', expected_sha256: read.sha256 }] })
    const second = rpc(handler, 'edit/apply', { experiment_id: 'EXP-test-agent-001', edits: [{ path: 'candidate/harness.yaml', content: 'name: two\n', expected_sha256: read.sha256 }] })
    const results = await Promise.allSettled([first, second])
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
    assert.equal(results.filter(item => item.status === 'rejected' && /conflict:/.test(item.reason.message)).length, 1)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('eval preview, case list, run index and decision update use existing backend contracts', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const cases = await rpc(handler, 'cases/list', { agent_id: 'test-agent' })
    assert.deepEqual(cases.cases.map(item => item.id), ['U-CASE-001'])
    const preview = await rpc(handler, 'eval/preview', { source: 'experiment:EXP-test-agent-001', mode: 'fast', executor: 'api', review: 'none', cases: ['U-CASE-001'] })
    assert.deepEqual(preview.result.case_ids, ['U-CASE-001'])
    const runs = await rpc(handler, 'runs/index', { agent_id: 'test-agent' })
    assert.equal(runs.agent_id, 'test-agent')
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    const saved = await rpc(handler, 'decision/update', { experiment_id: 'EXP-test-agent-001', content: '# Decision\n\n状态：inconclusive\n', expected_sha256: detail.decision.sha256 })
    assert.equal(saved.path, 'evolution/experiments/EXP-test-agent-001/decision.md')
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('从 Run 转入的用例经过普通编辑仍保留来源引用，注释不进入输入与预期', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const path = join(fx.root, 'agents/test-agent/evaluation.md')
    const provenance = '<!-- source_run_id: run-11111111-1111-4111-8111-111111111111; source_case_id: U-ORIGINAL-001 -->'
    write(path, readFileSync(path, 'utf8').replace('**用户输入**', provenance + '\n\n**用户输入**'))
    const handler = createAgentsHandler(fx.root)
    const document = await rpc(handler, 'cases/read', { experiment_id: 'EXP-test-agent-001', case_id: 'U-CASE-001' })
    const saved = await rpc(handler, 'cases/update', { experiment_id: 'EXP-test-agent-001', case_id: 'U-CASE-001', title: '编辑后名称', inputs: ['ping'], expected_behavior: '返回 pong。', fast: true, expected_sha256: document.sha256 })
    assert.ok(readFileSync(path, 'utf8').includes(provenance), '普通用例编辑不应静默删除运行来源')
    assert.deepEqual(saved.case.inputs, ['ping']); assert.equal(saved.case.expected_behavior, '返回 pong。')
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('eval job status parses redacted stdout result', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    write(join(fx.root, 'runtime/adapters/dsh-container/dsh-eval'), 'import json\nprint(json.dumps({"status":"ok","token":"secret-value","api_key":"key-value"}))\n')
    const handler = createAgentsHandler(fx.root)
    const started = await rpc(handler, 'eval/start', { source: 'experiment:EXP-test-agent-001', mode: 'fast', executor: 'api', review: 'none' })
    const status = await waitForJob(handler, started.job_id)
    assert.equal(status.status, 'completed')
    assert.equal(status.result.token, '[REDACTED]')
    assert.equal(status.stdout.includes('secret-value'), false)
    assert.equal(status.result.api_key, '[REDACTED]')
    assert.equal(status.stdout.includes('key-value'), false)
    assert.match(status.log_note, /截断显示/)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

for (const stopped of [true, false]) test(`取消评测等待 CLI 收尾；实例停止${stopped ? '已确认才显示 cancelled' : '未确认显示 failed'}`, async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    write(join(fx.root, 'runtime/adapters/dsh-container/dsh-eval'), [
      'import signal,time,json,sys',
      'def cancelled(*_args):',
      '    time.sleep(.15)',
      `    print(json.dumps({"cancelled":True,"instance_stopped":${stopped ? 'True' : 'False'},"run_id":"run-11111111-1111-4111-8111-111111111111"}),flush=True)`,
      '    raise SystemExit(2)',
      'signal.signal(signal.SIGTERM,cancelled)',
      'print("cancellation-ready",file=sys.stderr,flush=True)',
      'time.sleep(30)',
    ].join('\n'))
    const handler = createAgentsHandler(fx.root)
    const started = await rpc(handler, 'eval/start', { source: 'experiment:EXP-test-agent-001' })
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await rpc(handler, 'eval/status', { job_id: started.job_id })).stderr.includes('cancellation-ready')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const cancelling = await rpc(handler, 'eval/cancel', { job_id: started.job_id })
    assert.equal(cancelling.status, 'cancelling')
    assert.equal((await rpc(handler, 'eval/status', { job_id: started.job_id })).status, 'cancelling')
    assert.equal((await rpc(handler, 'eval/cancel', { job_id: started.job_id })).status, 'cancelling')
    let status
    for (let attempt = 0; attempt < 40; attempt++) {
      status = await rpc(handler, 'eval/status', { job_id: started.job_id })
      if (!['running', 'cancelling'].includes(status.status)) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(status.status, stopped ? 'cancelled' : 'failed')
    assert.equal(status.result.instance_stopped, stopped)
    if (!stopped) assert.match(status.error, /停止尚未确认/)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

for (const legacy of [false, true]) test(`Run evidence reads ${legacy ? 'legacy selection with unknown contract' : 'frozen case'}, redacts and never rewrites records`, async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  const runId = 'run-11111111-1111-4111-8111-111111111111'
  const base = join(fx.root, 'evolution/experiments/EXP-test-agent-001/runs', runId)
  try {
    write(join(base, 'run.yaml'), 'run_id: ' + runId + '\nexperiment_id: EXP-test-agent-001\nagent_id: test-agent\nstatus: completed\nevaluation_ref: agents/test-agent/evaluation.md\n')
    const inputs = JSON.stringify(legacy
      ? { evaluation_selection: { case_ids: ['U-CASE-001'] } }
      : { evaluation_cases: [{ case_id: 'U-CASE-001', inputs: ['ping'] }] })
    write(join(base, 'inputs.lock.json'), inputs)
    write(join(base, 'summary.json'), '{"status":"completed"}')
    const trace = JSON.stringify({ event: { type: 'session/created', createdAt: 1, data: { token: 'fixture-secret-value' } } }) + '\n'
    write(join(base, 'evidence/U-CASE-001/trace.jsonl'), trace)
    const handler = createAgentsHandler(fx.root)
    const shown = await rpc(handler, 'runs/show', { run_id: runId })
    assert.equal(shown.cases[0].case_id, 'U-CASE-001')
    if (legacy) {
      assert.equal(shown.cases[0].frozen, null)
      assert.equal(shown.cases[0].contract_changed, null)
      assert.ok(shown.missing.some(item => item.includes('未冻结 Case 定义')))
    } else assert.equal(shown.cases[0].frozen.inputs[0], 'ping')
    const payload = { run_id: runId, case_id: 'U-CASE-001', filename: 'trace.jsonl' }
    const evidence = await rpc(handler, 'runs/evidence', payload)
    assert.equal(evidence.truncated, false)
    assert.match(evidence.content, /session\/created/)
    assert.match(evidence.content, /REDACTED/)
    assert.equal(evidence.content.includes('fixture-secret-value'), false)
    assert.equal(readFileSync(join(base, 'inputs.lock.json'), 'utf8'), inputs)
    assert.equal(readFileSync(join(base, 'evidence/U-CASE-001/trace.jsonl'), 'utf8'), trace)
    await assert.rejects(() => rpc(handler, 'runs/evidence', { ...payload, filename: '../../inputs.lock.json' }), /not_found:/)
    await assert.rejects(() => rpc(handler, 'runs/evidence', { ...payload, filename: 'tools.jsonl' }), /not_found:/)
    write(join(base, 'evidence/U-CASE-001/tools.jsonl'), JSON.stringify({ event: { type: 'session/created' }, long: 'a'.repeat(70 * 1024) }) + '\n')
    const bounded = await rpc(handler, 'runs/evidence', { ...payload, filename: 'tools.jsonl' })
    assert.equal(bounded.truncated, true)
    assert.ok(Buffer.byteLength(bounded.content) <= 64 * 1024)
    write(join(base, 'evidence/U-CASE-001/tools.jsonl'), JSON.stringify({ token: 'truncated-fixture-secret'.repeat(4000) }) + '\n')
    const partialSecret = await rpc(handler, 'runs/evidence', { ...payload, filename: 'tools.jsonl' })
    assert.equal(partialSecret.truncated, true)
    assert.match(partialSecret.content, /REDACTED/)
    assert.equal(partialSecret.content.includes('truncated-fixture-secret'), false)
    const outside = join(fx.root, 'outside.json')
    write(outside, '{"token":"outside-secret"}')
    symlinkSync(outside, join(base, 'evidence/U-CASE-001/judge.json'))
    await assert.rejects(() => rpc(handler, 'runs/evidence', { ...payload, filename: 'judge.json' }), /path_rejected:/)
    await assert.rejects(() => rpc(handler, 'runs/show', { run_id: runId }), /path_rejected:/)
  } finally {
    await rm(fx.root, { recursive: true, force: true })
  }
})

test('Run 读取不阻塞服务，取消和失败返回明确错误', async t => {
  const { root } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const { createAgentsHandler } = await loadServer()
  write(join(root, 'runtime/adapters/dsh-container/run_record.py'), 'import time, json\ntime.sleep(0.25)\nprint(json.dumps({"experiments": []}))\n')
  const handler = createAgentsHandler(root)
  let settled = false
  const pending = handler('runs/index', { agent_id: 'test-agent' }, new AbortController().signal).then(result => { settled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, 'Python 子进程不应阻塞 Node 事件循环')
  assert.equal((await pending).ok, true)
  const abort = new AbortController()
  const cancelled = handler('runs/index', { agent_id: 'test-agent' }, abort.signal)
  abort.abort()
  assert.equal((await cancelled).ok, false)
  write(join(root, 'runtime/adapters/dsh-container/run_record.py'), 'import sys\nprint("broken run", file=sys.stderr)\nsys.exit(1)\n')
  const failed = await handler('runs/index', { agent_id: 'test-agent' }, new AbortController().signal)
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'run_read_failed')
  assert.match(failed.error.details.reason, /broken run/)
})

test('智能体详情解析不阻塞服务，YAML 顶层校验保留', async t => {
  const { root } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const { createAgentsHandler } = await loadServer()
  write(join(root, 'runtime/adapters/dsh-container/source_contract.py'), 'import time, json\ntime.sleep(0.25)\nprint(json.dumps({"status":"fixture"}))\n')
  const handler = createAgentsHandler(root)
  let settled = false
  const pending = handler('detail', { agent_id: 'test-agent' }, new AbortController().signal).then(result => { settled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false, '合同解析期间应允许其他请求响应')
  assert.equal((await pending).ok, true)
  const manifest = join(root, 'agents/test-agent/manifest.yaml')
  const originalManifest = readFileSync(manifest, 'utf8')
  write(manifest, '- invalid-top-level\n')
  const invalid = await handler('list', {}, new AbortController().signal)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'asset_read_failed')
  write(manifest, originalManifest)
  await rm(join(root, 'evolution/experiments/EXP-test-agent-001/change.yaml'))
  const missing = await handler('detail', { agent_id: 'test-agent' }, new AbortController().signal)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'asset_read_failed')
})

test('用例按选中区块保存，多轮与档位回读一致，冲突和无效内容不改源文件', async t => {
  const { createAgentsHandler } = await loadServer()
  const { root } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'agents/test-agent/evaluation.md')
  const first = readFileSync(file, 'utf8')
  const following = '\n## 第二场景\n\n#### U-CASE-002 保留原文\n\n**用户输入**\n\n> untouched\n\n**预期**\n\n原样保留。\n'
  write(file, first + following)
  const handler = createAgentsHandler(root)
  const base = { experiment_id: 'EXP-test-agent-001', case_id: 'U-CASE-001' }
  const before = await rpc(handler, 'cases/read', base)
  assert.deepEqual(before.case.inputs, ['ping'])
  const update = { ...base, title: '多轮保存', inputs: ['first\n\ncontinued', 'second'], expected_behavior: '返回两轮的真实结果。', fast: false, expected_sha256: before.sha256 }
  const saved = await rpc(handler, 'cases/update', update)
  assert.deepEqual(saved.case.inputs, update.inputs)
  assert.equal(saved.case.title, update.title)
  assert.equal(saved.case.expected_behavior, update.expected_behavior)
  assert.equal(saved.case.tier, 'full')
  assert.equal(saved.case.scene, '基础')
  const current = readFileSync(file, 'utf8')
  assert.ok(current.endsWith(following))
  assert.ok(current.startsWith('# Evaluation\n\n## 基础\n\n'))
  await assert.rejects(() => rpc(handler, 'cases/update', update), /conflict:/)
  await assert.rejects(() => rpc(handler, 'cases/update', { ...update, expected_sha256: saved.sha256, expected_behavior: '预期\n\n#### U-CASE-003 注入新用例\n\n**用户输入**\n> unexpected\n\n**预期**\nno' }), /invalid_request:/)
  assert.equal(readFileSync(file, 'utf8'), current)
  assert.deepEqual((await rpc(handler, 'cases/list', { agent_id: 'test-agent' })).cases.map(row => row.id), ['U-CASE-001', 'U-CASE-002'])
})

test('用例解析与摘要来自同一次读取，解析期间的外部修改不会混入口径', async t => {
  const { createAgentsHandler } = await loadServer()
  const { root } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'agents/test-agent/evaluation.md')
  const parser = join(root, 'runtime/research/evaluation_contract.py')
  write(parser, 'import time\ntime.sleep(0.25)\n' + readFileSync(parser, 'utf8').replace('from __future__ import annotations\n', ''))
  const handler = createAgentsHandler(root)
  const pending = rpc(handler, 'cases/read', { experiment_id: 'EXP-test-agent-001', case_id: 'U-CASE-001' })
  await new Promise(resolve => setTimeout(resolve, 40))
  write(file, readFileSync(file, 'utf8').replace('> ping', '> changed'))
  const read = await pending
  assert.deepEqual(read.case.inputs, ['ping'])
  assert.notEqual(read.sha256, (await rpc(handler, 'cases/read', { experiment_id: 'EXP-test-agent-001', case_id: 'U-CASE-001' })).sha256)
})

test('用例保存保留预期中的普通四级小节，其他 Case 原文不变', async t => {
  const { createAgentsHandler } = await loadServer()
  const { root } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'agents/test-agent/evaluation.md')
  const following = '\n#### U-CASE-002 原样保留\n\n**用户输入**\n\n> second\n\n**预期**\n\n不变。\n'
  write(file, readFileSync(file, 'utf8') + '\n#### 判定细节\n\n旧的详细标准。\n' + following)
  const handler = createAgentsHandler(root)
  const base = { experiment_id: 'EXP-test-agent-001', case_id: 'U-CASE-001' }
  const before = await rpc(handler, 'cases/read', base)
  assert.match(before.case.expected_behavior, /#### 判定细节/)
  const expectedBehavior = '返回新的结果。\n\n#### 判定细节\n\n新的详细标准。'
  const saved = await rpc(handler, 'cases/update', { ...base, title: before.case.title, inputs: before.case.inputs, expected_behavior: expectedBehavior, fast: true, expected_sha256: before.sha256 })
  assert.equal(saved.case.expected_behavior, expectedBehavior)
  const current = readFileSync(file, 'utf8')
  assert.equal((current.match(/#### 判定细节/g) ?? []).length, 1)
  assert.equal(current.includes('旧的详细标准'), false)
  assert.ok(current.endsWith(following))
})

test('运行中 Job 即时返回 stderr 跨数据块输出的 Run ID', async t => {
  const { createAgentsHandler } = await loadServer()
  const { root } = fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const runId = 'run-11111111-1111-4111-8111-111111111111'
  write(join(root, 'runtime/adapters/dsh-container/dsh-eval'), [
    'import sys,time,json',
    'sys.stderr.write("Research Run: run-11111111-1111-");sys.stderr.flush()',
    'time.sleep(0.08)',
    'sys.stderr.write("4111-8111-111111111111\\n");sys.stderr.flush()',
    'time.sleep(0.25)',
    `print(json.dumps({"run_id":"${runId}"}))`,
    '',
  ].join('\n'))
  const handler = createAgentsHandler(root)
  const started = await rpc(handler, 'eval/start', { source: 'experiment:EXP-test-agent-001', mode: 'fast', executor: 'api', review: 'none' })
  let observed
  for (let attempt = 0; attempt < 30; attempt++) {
    observed = await rpc(handler, 'eval/status', { job_id: started.job_id })
    if (observed.run_id) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(observed.run_id, runId)
  assert.equal(observed.status, 'running')
  assert.equal((await waitForJob(handler, started.job_id)).result.run_id, runId)
})

test('特性历史观察引用按所属 Experiment 解析，新保存归一并可通过专用工具读取', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const id = 'EXP-test-agent-001', base = `evolution/experiments/${id}`
    const file = join(fx.root, base, 'change.yaml')
    write(file, readFileSync(file, 'utf8') + '\nfeatures:\n- id: observed\n  title: 观察能力\n  description: 仍未确认\n  evidence_refs:\n  - evaluation/observations.md#limits\n')
    write(join(fx.root, base, 'evaluation/observations.md'), '# 真实观察\n尚未验证业务效果。\n')
    const original = readFileSync(file, 'utf8')
    const handler = createAgentsHandler(fx.root)
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: id })
    assert.equal(detail.features[0].evidence[0].present, true)
    assert.equal(detail.features[0].evidence[0].path, `${base}/evaluation/observations.md`)
    assert.equal(readFileSync(file, 'utf8'), original, '读取兼容不能改写历史资料')
    const source = await rpc(handler, 'features/read-source', { experiment_id: id, ref: detail.features[0].evidence_refs[0] })
    assert.equal(source.path, `${base}/evaluation/observations.md`)
    assert.match(source.content, /尚未验证业务效果/)
    assert.equal(source.source_experiment_id, id)
    assert.ok((await rpc(handler, 'features/read-source', { experiment_id: id })).files.includes(source.path))
    const preview = await rpc(handler, 'features/preview', { experiment_id: id, features: detail.features })
    assert.equal(preview.features[0].evidence_refs[0], `${base}/evaluation/observations.md#limits`)
    await rpc(handler, 'features/apply', { preview_id: preview.preview_id, confirmed: true })
    assert.equal(loadYaml(readFileSync(file, 'utf8')).features[0].evidence_refs[0], `${base}/evaluation/observations.md#limits`)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('特性证据读取拒绝程序路径、凭据、跨 Agent 与符号链接，二进制和大文件不泄露正文', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const id = 'EXP-test-agent-001', folder = join(fx.root, `evolution/experiments/${id}/evaluation`)
    const handler = createAgentsHandler(fx.root)
    write(join(folder, 'small.bin'), Buffer.from([0, 1, 2]))
    write(join(folder, 'large.txt'), 'a'.repeat(1024 * 1024 + 1))
    write(join(folder, 'models.llm-api-key'), 'test-placeholder')
    write(join(folder, 'token-costs.json'), JSON.stringify({ token_count: 12, api_key: 'credential-test-placeholder' }))
    write(join(fx.root, 'evolution/experiments/EXP-other-agent-001/change.yaml'), 'agent_id: other-agent\n')
    write(join(fx.root, 'evolution/experiments/EXP-other-agent-001/evaluation/observations.md'), 'another agent')
    symlinkSync(join(fx.root, 'agents/test-agent/evaluation.md'), join(folder, 'linked.md'))
    for (const ref of ['../../program/file', '/etc/hosts', 'platform/plugin/src/agents/index.ts', 'evaluation/models.llm-api-key', 'evaluation/linked.md', 'evolution/experiments/EXP-other-agent-001/evaluation/observations.md']) {
      await assert.rejects(() => rpc(handler, 'features/read-source', { experiment_id: id, ref }), /path_rejected/)
    }
    for (const ref of ['evaluation/small.bin', 'evaluation/large.txt']) {
      const result = await rpc(handler, 'features/read-source', { experiment_id: id, ref })
      assert.equal(result.kind, 'unpreviewable'); assert.equal(result.content, undefined)
    }
    const costs = await rpc(handler, 'features/read-source', { experiment_id: id, ref: 'evaluation/token-costs.json' })
    assert.match(costs.content, /token_count/)
    assert.ok(!costs.content.includes('credential-test-placeholder'))
    await assert.rejects(() => rpc(handler, 'features/read-source', { experiment_id: id, ref: 'evaluation/missing.md' }), /asset_read_failed/)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('详情派生引用绑定所选版本的可恢复提交，未提交版本不能冒用祖先', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const current = await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: 'EXP-test-agent-001' })
    assert.equal(current.derivation.parent_ref, `git:${fx.commit}`)
    assert.equal(current.derivation.parent_experiment_id, 'EXP-test-agent-001')
    const created = await rpc(handler, 'create', { agent_id: 'test-agent', parent_experiment_id: 'EXP-test-agent-001', parent_ref: `git:${fx.commit}`, research_question: '临时派生' })
    const draft = await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: created.experiment_id })
    assert.equal(draft.baseline.ref, `git:${fx.commit}`)
    assert.equal(draft.derivation.parent_ref, null)
    assert.equal(draft.derivation.parent_experiment_id, created.experiment_id)
    write(join(fx.root, 'evolution/experiments/EXP-test-agent-001/candidate/harness.yaml'), 'name: uncommitted change\n')
    const changed = await rpc(handler, 'detail', { agent_id: 'test-agent', experiment_id: 'EXP-test-agent-001' })
    assert.equal(changed.derivation.parent_ref, null)
    assert.match(changed.derivation.note, /未提交改动/)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})


test('研究资料按固定主题从数据工作区读取，拒绝任意路径、链接与过大资料', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const path = 'docs/harness-research/controlled-improvement.md'
    write(join(fx.root, path), '# 受控改进\n\n先固定来源，再比较任务效果。\n')
    const value = await rpc(handler, 'research/read-reference', { topic: 'controlled-improvement' })
    assert.equal(value.path, path)
    assert.equal(value.sha256, createHash('sha256').update(readFileSync(join(fx.root, path))).digest('hex'))
    assert.match(value.content, /固定来源/)
    await assert.rejects(() => rpc(handler, 'research/read-reference', { topic: '../../AGENTS' }), /invalid_request/)
    await assert.rejects(() => rpc(handler, 'research/read-reference', { topic: 'decision-samples' }), /not_found/)
    write(join(fx.root, 'docs/harness-research/compute-variants.md'), 'a'.repeat(128 * 1024 + 1))
    await assert.rejects(() => rpc(handler, 'research/read-reference', { topic: 'compute-variants' }), /128 KiB/)
    symlinkSync(join(fx.root, path), join(fx.root, 'docs/harness-research/decision-samples.md'))
    await assert.rejects(() => rpc(handler, 'research/read-reference', { topic: 'decision-samples' }), /符号链接/)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('研究检查返回真实校验失败，旧来源清点只读且保留 review_required 和 fail', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root)
    const validation = await rpc(handler, 'research/validate', { experiment_id: 'EXP-test-agent-001' })
    assert.equal(validation.valid, false)
    assert.equal(validation.exit_code, 1)
    assert.ok(validation.errors.length)
    const source = 'evolution/history/imports/basic'
    write(join(fx.root, source, 'README.md'), '# 基础资产\n')
    const passed = await rpc(handler, 'legacy/inspect', { path: source })
    assert.equal(passed.status, 'pass')
    assert.equal(passed.exit_code, 0)
    write(join(fx.root, source, '.env'), 'BASIC_LABEL=demo\n')
    const review = await rpc(handler, 'legacy/inspect', { path: source })
    assert.equal(review.status, 'review_required')
    assert.equal(review.exit_code, 1)
    assert.ok(!JSON.stringify(review).includes('BASIC_LABEL'))
    symlinkSync(join(fx.root, 'agents/test-agent'), join(fx.root, source, 'linked'))
    const failed = await rpc(handler, 'legacy/inspect', { path: source })
    assert.equal(failed.status, 'fail')
    assert.equal(failed.exit_code, 1)
    assert.equal(readFileSync(join(fx.root, source, 'README.md'), 'utf8'), '# 基础资产\n')
    for (const path of ['agents/test-agent', '../outside', 'evolution/history/imports', `${source}/linked`]) {
      await assert.rejects(() => rpc(handler, 'legacy/inspect', { path }), /path_rejected|not_found/)
    }
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('研究假设与观察进入既有摘要和 dry 编辑流程，change.yaml 仍不可任意编辑', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root), experiment_id = 'EXP-test-agent-001'
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    assert.match(detail.change_sha256, /^[0-9a-f]{64}$/)
    for (const path of ['hypothesis.md', 'evaluation/observations.md']) {
      assert.ok(detail.editable_files.includes(`evolution/experiments/${experiment_id}/${path}`))
      const before = await rpc(handler, 'edit/read', { experiment_id, path })
      const content = before.content + '\n追加可核对的观察，未声称真实服务已验收。\n'
      const edits = [{ path, content, expected_sha256: before.sha256 }]
      await rpc(handler, 'edit/preview', { experiment_id, edits })
      await rpc(handler, 'edit/apply', { experiment_id, edits })
      assert.equal((await rpc(handler, 'edit/read', { experiment_id, path })).content, content)
      await assert.rejects(() => rpc(handler, 'edit/apply', { experiment_id, edits }), /conflict/)
    }
    await assert.rejects(() => rpc(handler, 'edit/read', { experiment_id, path: `evolution/experiments/${experiment_id}/change.yaml` }), /path_rejected/)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('结构化 Decision 校验双摘要、保留元数据，失败恢复两文件且并发确认只成功一次', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root), experiment_id = 'EXP-test-agent-003-r0123456789ab'
    const base = join(fx.root, 'evolution/experiments', experiment_id)
    cpSync(join(fx.root, 'evolution/experiments/EXP-test-agent-001'), base, { recursive: true })
    await rm(join(base, 'runs'), { recursive: true, force: true })
    const changePath = join(base, 'change.yaml'), decisionPath = join(base, 'decision.md')
    const originalChange = { schema_version: '1.0', experiment_id, agent_id: 'test-agent', baseline_ref: 'none:first-experiment', status: 'active', retained_extension: { owner: 'user' } }
    write(changePath, JSON.stringify(originalChange))
    const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
    const body = () => ({ experiment_id, content: '# Decision\n\n证据不足，保留限制并继续比较。\n', expected_sha256: hash(decisionPath), expected_change_sha256: hash(changePath), status: 'completed', outcome: 'inconclusive' })
    const beforeDecision = readFileSync(decisionPath, 'utf8'), beforeChange = readFileSync(changePath, 'utf8')
    await assert.rejects(() => rpc(handler, 'decision/update', { ...body(), expected_change_sha256: 'stale' }), /conflict/)
    await assert.rejects(() => rpc(handler, 'decision/update', { ...body(), expected_sha256: 'stale' }), /conflict/)
    await assert.rejects(() => rpc(handler, 'decision/update', { ...body(), status: 'published' }), /invalid_request/)
    await assert.rejects(() => rpc(handler, 'decision/update', { ...body(), content: '# Decision\n' }), /validation_failed/)
    assert.equal(readFileSync(decisionPath, 'utf8'), beforeDecision)
    assert.equal(readFileSync(changePath, 'utf8'), beforeChange)
    const request = body()
    const outcomes = await Promise.allSettled([rpc(handler, 'decision/update', request), rpc(handler, 'decision/update', request)])
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1, outcomes.map(value => value.reason?.message).join('\n'))
    assert.equal(outcomes.filter(value => value.status === 'rejected' && /conflict/.test(value.reason.message)).length, 1)
    const saved = loadYaml(readFileSync(changePath, 'utf8'))
    assert.deepEqual(saved, { ...originalChange, status: 'completed', outcome: 'inconclusive' })
    assert.equal((await rpc(handler, 'research/validate', { experiment_id })).valid, true)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('Decision 预览展示状态与结果变化且不修改文件', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root), experiment_id = 'EXP-test-agent-001'
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    const payload = { experiment_id, content: '# Decision\n\n保留本轮证据不足结论。\n', expected_sha256: detail.decision.sha256, expected_change_sha256: detail.change_sha256, status: 'completed', outcome: 'inconclusive' }
    for (const invalid of [{ status: ['completed'] }, { outcome: ['adopt'] }]) {
      await assert.rejects(() => rpc(handler, 'decision/preview', { ...payload, ...invalid }), /invalid_request/)
    }
    const result = await rpc(handler, 'decision/preview', payload)
    assert.deepEqual(result.change.before, { status: 'active', outcome: null })
    assert.deepEqual(result.change.after, { status: 'completed', outcome: 'inconclusive' })
    assert.equal(result.change.before_sha256, detail.change_sha256)
    const after = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    assert.equal(after.change_sha256, detail.change_sha256)
    assert.equal(after.decision.sha256, detail.decision.sha256)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})

test('取消 Decision 校验不阻塞事件循环并恢复两文件', async () => {
  const { createAgentsHandler } = await loadServer()
  const fx = fixture()
  try {
    const handler = createAgentsHandler(fx.root), experiment_id = 'EXP-test-agent-001'
    const detail = await rpc(handler, 'detail', { agent_id: 'test-agent' })
    const changeFile = join(fx.root, 'evolution/experiments', experiment_id, 'change.yaml')
    const before = readFileSync(changeFile, 'utf8')
    write(join(fx.root, 'runtime/research/validate_experiment.py'), 'import json,time\ntime.sleep(2)\nprint(json.dumps({"valid":True,"errors":[],"warnings":[]}))\n')
    const abort = new AbortController()
    const pending = handler('decision/update', { experiment_id, content: '# Decision\n\n等待校验后保存。\n', expected_sha256: detail.decision.sha256, expected_change_sha256: detail.change_sha256, status: 'completed', outcome: 'inconclusive' }, abort.signal)
    await new Promise(resolve => setTimeout(resolve, 30))
    abort.abort()
    const result = await pending
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'aborted')
    assert.equal(readFileSync(changeFile, 'utf8'), before)
    assert.equal(readFileSync(join(fx.root, detail.decision.path), 'utf8'), detail.decision.content)
  } finally { await rm(fx.root, { recursive: true, force: true }) }
})
