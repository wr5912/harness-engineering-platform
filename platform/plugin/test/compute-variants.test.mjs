import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { load, dump } from 'js-yaml'

process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
process.env.HARNESS_PYTHON ||= '/usr/bin/python3'
const buildRoot = mkdtempSync(join(tmpdir(), 'compute-variants-build-'))
await build({ stdin: { contents: "export * from './src/agents/compute-variants.ts'; export { createAgentsHandler } from './src/agents/index.ts'; export { createComputeBuildHandler } from './src/agents/compute-build.ts'; export { candidateDigest } from './src/tasks/files.ts'", resolveDir: new URL('../', import.meta.url).pathname, loader: 'ts' }, outfile: join(buildRoot, 'variants.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/dsh-client-connection'] })
const { createAgentsHandler, createComputeVariantsHandler, computeTraceMetrics, createComputeBuildHandler, candidateDigest } = await import(`file://${join(buildRoot, 'variants.mjs')}`)
const parent = 'EXP-alpha-001-r111111111111', variant = 'VAR-alpha-001-r222222222222'
const parentRun = 'run-11111111-1111-4111-8111-111111111111', variantRun = 'run-22222222-2222-4222-8222-222222222222'
const hash = value => createHash('sha256').update(value).digest('hex')
const modelRoles = {
  language: { provider: 'qwen', model: 'qwen3.5-2b', reasoning_effort: 'off' },
  decision: { provider: 'kev', model: 'kev-0.8b', reasoning_effort: 'off', checkpoint_sha256: 'a'.repeat(64), state_constructor_sha256: 'b'.repeat(64), calibration_sha256: 'c'.repeat(64) },
}
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
function git(root, args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim() }
function trace(calls, tokens = 100) {
  const rows = [{ type: 'turn/start', time: 1000, data: { turn: 1 } }]
  for (let index = 1; index <= calls; index++) rows.push(
    { type: 'step/start', time: 1000 + index, data: { turn: 1, step: index } },
    { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' } } } },
    { type: 'assistant/message', time: 2000 + index, data: { turn: 1, step: index, usage: { inputTokens: tokens, outputTokens: 10, totalTokens: tokens + 10 }, message: { content: [{ type: 'text', text: '模拟资产状态正常。' }] } } },
    { type: 'tool/call', data: { callId: `call-${index}`, name: 'mock_status', arguments: '{}' } },
    { type: 'tool/result', data: { message: { source: { callId: `call-${index}` }, content: [{ type: 'text', text: '模拟资产状态正常。' }] } } },
    { type: 'step/end', time: 2000 + index, data: { turn: 1, step: index } },
  )
  rows.push({ type: 'turn/end', time: 1000 + calls * 1000, data: { turn: 1, reason: { kind: 'completed' } } })
  return rows.map(event => ({ session_log: 'root', event }))
}
function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
function completeTrace(calls, tokens = 100, sessionId = 'fixture-session') {
  return [{ session_log: 'root', event: { type: 'session', id: sessionId, delegationDepth: 0 } },
    ...trace(calls, tokens).map((row, seq) => ({ ...row, event: { ...row.event, seq } }))]
}
test('输入资源使用完整 prompt，缓存命中差异不构成上下文优化', () => {
  const metrics = usage => {
    const rows = completeTrace(1)
    rows.find(row => row.event.type === 'assistant/message').event.data.usage = usage
    return computeTraceMetrics(rows, true).values
  }
  // 来自实际两个新 Session 的 DSH 归一分桶；输入总长相同。
  for (const [inputTokens, cacheReadTokens] of [[240, 2176], [496, 1920]]) {
    assert.equal(metrics({ inputTokens, cacheReadTokens, outputTokens: 50, totalTokens: 2466 }).input_tokens, 2416)
  }
  assert.equal(metrics({ inputTokens: 30, outputTokens: 10, totalTokens: 40 }).input_tokens, 30)
  assert.equal(metrics({ inputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3, outputTokens: 10, reasoningTokens: 7 }).input_tokens, null)
  assert.equal(metrics({ inputTokens: 20, outputTokens: 10 }).input_tokens, null)
  for (const usage of [
    { inputTokens: 30, outputTokens: 10, totalTokens: 39 },
    { inputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3, outputTokens: 10, totalTokens: 40 },
    { inputTokens: 20, cacheReadTokens: -1, outputTokens: 10, totalTokens: 30 },
    { inputTokens: 20.5, outputTokens: 10, totalTokens: 30.5 },
    { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 0 },
    { inputTokens: 20, outputTokens: 10, totalTokens: 30, reasoningTokens: 11 },
  ]) {
    const value = metrics(usage)
    assert.equal(value.input_tokens, null); assert.equal(value.total_tokens, null)
  }
})
async function fixture(planOverrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compute-variants-'))
  const path = id => join(root, `evolution/experiments/${id}`)
  write(join(root, 'agents/alpha/evaluation.md'), '# 评测\n\n## 查询\n\n#### U-ONE-001 查询状态\n\n**用户输入**\n\n> 查询模拟资产状态。\n\n**预期**\n\n准确返回状态。\n')
  write(join(path(parent), 'change.yaml'), dump({ experiment_id: parent, agent_id: 'alpha', baseline_ref: 'none:first-experiment' }))
  write(join(path(parent), 'candidate/AGENTS.md'), '完整的模拟查询智能体资产。')
  git(root, ['init']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']); git(root, ['add', '.']); git(root, ['commit', '-m', 'fixed parent'])
  const parentCommit = git(root, ['rev-parse', 'HEAD']), runs = new Map()
  let readHook = null
  const digest = id => hash(readFileSync(join(path(id), 'candidate/AGENTS.md')))
  const handler = createComputeVariantsHandler(root, {
    candidateDigest: digest,
    gitCandidateDigest: (id, ref) => { const result = spawnSync('git', ['show', `${ref.slice(4)}:evolution/experiments/${id}/candidate/AGENTS.md`], { cwd: root }); return result.status === 0 ? hash(result.stdout) : null },
    readRun: async id => { await readHook?.(id); return runs.get(id) },
    createExperiment: async (payload, variantCreation) => {
      assert.equal(payload.parent_ref, `git:${parentCommit}`)
      cpSync(join(path(parent), 'candidate'), join(path(variant), 'candidate'), { recursive: true })
      write(join(path(variant), 'change.yaml'), dump({ experiment_id: variant, agent_id: 'alpha', baseline_ref: payload.parent_ref, parent_ref: payload.parent_ref, parent_experiment_id: parent, compute_variant: variantCreation.plan, variant_kind: 'exploratory', variant_name: variantCreation.name }))
      write(join(path(variant), 'decision.md'), '# Decision\n\ninconclusive\n')
      return { ok: true, value: { experiment_id: variant } }
    },
  })
  const created = success(await handler('create', { parent_experiment_id: parent, parent_ref: `git:${parentCommit}`, strategy: '减少重复查询和模型调用，完整保留查询结果。', case_ids: ['U-ONE-001'], critical_case_ids: ['U-ONE-001'], min_runs_per_case: 1, resource_metric: 'total_tokens', min_resource_reduction_pct: 10, ...planOverrides }))
  git(root, ['add', '.']); git(root, ['commit', '-m', 'freeze variant plan'])
  const plannedCommit = git(root, ['rev-parse', 'HEAD'])
  const body = { experiment_id: variant, parent_run_ids: [parentRun], variant_run_ids: [variantRun] }
  const addRun = (id, experimentId, calls) => {
    const base = join(path(experimentId), 'runs', id)
    const manifest = { run_id: id, experiment_id: experimentId, agent_id: 'alpha', status: 'completed', created_at: new Date(Date.now() + 1000).toISOString() }
    const lock = { created_at: manifest.created_at, candidate_sha256: digest(experimentId), git_version: { commit: plannedCommit, dirty: false }, program_origin: { commit: 'c'.repeat(40), dirty: false }, executor: 'api', review_mode: 'ai', dependency_env: {}, evaluation_cases: [] }
    write(join(base, 'inputs.lock.json'), JSON.stringify(lock))
    for (const [key, file, value] of [['results_sha256', 'results.jsonl', '{}\n'], ['analysis_sha256', 'analysis.json', '{}'], ['report_sha256', 'report.md', '# 原始报告\n完整结果。']]) { write(join(base, file), value); manifest[key] = hash(value) }
    write(join(base, 'run.yaml'), dump(manifest))
    const traceRows = completeTrace(calls, 100, `session-${id.slice(4)}`)
    traceRows[0].event.createdAt = Date.parse(manifest.created_at) + 10
    write(join(base, 'evidence/U-ONE-001/trace.jsonl'), traceRows.map(row => JSON.stringify(row)).join('\n'))
    write(join(base, 'evidence/U-ONE-001/checks.json'), JSON.stringify({ trace_available: true }))
    const view = { run_id: id, manifest, missing: [], image: { image_build_fingerprint: 'same-build', local_image_id: 'same-image' }, cases: [{ case_id: 'U-ONE-001', frozen: { case_id: 'U-ONE-001', title: '查询状态', inputs: ['查询模拟资产状态。'], expected_behavior: '准确返回状态。' }, trials: [{ execution_status: 'completed', verdict: 'passed' }], review: { reviewed_verdict: 'passed' }, actual_routes: [{ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' }], tool_calls: [{ name: 'mock_status', status: 'ok' }], load_observation: { session_id: `session-${id.slice(4)}`, preset_matches: true, workspace_matches: true }, evidence: [{ path: `evolution/experiments/${experimentId}/runs/${id}/report.md`, present: true }] }] }
    write(join(base, 'evidence/dsh-image.json'), JSON.stringify(view.image))
    write(join(base, 'evidence/U-ONE-001/response.json'), JSON.stringify({ assistant_texts: ['模拟资产状态正常。'], turns: [{ route: view.cases[0].actual_routes[0] }] }))
    write(join(base, 'evidence/U-ONE-001/tools.jsonl'), traceRows.filter(row => row.event.type.startsWith('tool/')).map(JSON.stringify).join('\n'))
    runs.set(id, view)
    return { base, lock, view }
  }
  const left = addRun(parentRun, parent, 2), right = addRun(variantRun, variant, 1)
  return { root, path, handler, body, created, left, right, parentCommit, setReadHook: hook => { readHook = hook } }
}
async function withFixture(task, planOverrides = {}) { const fx = await fixture(planOverrides); try { await task(fx) } finally { rmSync(fx.root, { recursive: true, force: true }) } }

test('context 在数据技能迁出后仍返回当前代码生成接口合同，读取不改变研究资产', () => withFixture(async fx => {
  assert.equal(existsSync(join(fx.root, '.agents/skills')), false)
  const change = readFileSync(join(fx.path(variant), 'change.yaml'))
  const candidate = readFileSync(join(fx.path(variant), 'candidate/AGENTS.md'))
  const status = git(fx.root, ['status', '--porcelain'])
  const context = success(await fx.handler('context', { experiment_id: variant }))
  const contract = context.generation_contract
  assert.equal(contract.generation.mode, 'langgraph-aot')
  assert.equal(contract.generation.default_entry_path, 'dsh/managed/compute-workflow/index.ts')
  assert.match(contract.generation.fields.source_run_ids, /固定父版.*诊断轨迹/)
  assert.match(contract.variant_name, /change.yaml.variant_name.*不从 strategy\/research_question 截取/)
  assert.deepEqual(contract.available_tools, ['skill', 'platform_agents'])
  assert.equal(contract.operations.task, undefined)
  assert.match(contract.operations.build, /expected_candidate_sha256.*expected_preview_sha256/)
  assert.match(contract.operations.freeze, /freeze_input=.*evaluation_base_sha256.*expected_preview_sha256/)
  assert.match(contract.operations.evidence, /build_digest.*esm_sha256.*complete=true.*status=completed/)
  assert.match(contract.operations.delivery, /human_confirmed.*用户.*复核/)
  assert.deepEqual(JSON.parse(JSON.stringify(contract)), contract, '接口合同须可无损传给管理助手')
  assert.deepEqual(readFileSync(join(fx.path(variant), 'change.yaml')), change)
  assert.deepEqual(readFileSync(join(fx.path(variant), 'candidate/AGENTS.md')), candidate)
  assert.equal(git(fx.root, ['status', '--porcelain']), status)
  assert.equal(context.workflow_status.generated, false)
  assert.equal(context.loaded.verified, false, '返回生成指导不应伪造源码或装载证据')
}))

test('context 公布的 SDK 导入和节点调用可由真实固定编译器检查，不执行 Candidate', () => withFixture(async fx => {
  const { sdk, generation } = success(await fx.handler('context', { experiment_id: variant })).generation_contract
  const entry = join(fx.path(variant), 'candidate', generation.default_entry_path)
  write(join(fx.root, 'config/sources.json'), JSON.stringify({ sources: { [variant]: { agent_id: 'alpha', candidate_root: `evolution/experiments/${variant}/candidate/dsh` } } }))
  write(entry, `import {${sdk.exports.join(',')}} from '${sdk.module}';
import type {${sdk.types.join(',')}} from '${sdk.module}';
export type PublicTypes = [WorkflowDefinition, WorkflowContext, FixedCompositionBinding];
export const name='contract-fixture'; export const inject=['tools','llm'];
const workflow=defineWorkflow({id:'contract-fixture',toolName:'contract_fixture',description:'仅编译合同',inputSchema:{type:'object'},
  async run(context:WorkflowContext){return runWorkflow(context,[
    {id:'query',async run(_values,ctx){return ctx.callTool('fixture_query',ctx.input)}},
    {id:'judge',async run(values,ctx){return ctx.infer({model:'fixture-model'},{messages:[{role:'user',content:JSON.stringify(values)}]})}},
  ])}});
export const graphExports=[Annotation,StateGraph,START,END,fixedCompositionToolName];
export function apply(ctx:any){registerWorkflowTool(ctx,workflow); throw new Error('本测试不得执行Candidate')}
`)
  const buildHandler = createComputeBuildHandler(fx.root), digest = candidateDigest(join(fx.path(variant), 'candidate'))
  const preview = success(await buildHandler('preview', { experiment_id: variant, expected_candidate_sha256: digest, entry_path: generation.default_entry_path }))
  assert.equal(preview.entry_path, generation.default_entry_path)
  const built = success(await buildHandler('build', { experiment_id: variant, expected_candidate_sha256: digest, expected_preview_sha256: preview.preview_sha256, entry_path: generation.default_entry_path }))
  assert.match(built.esm_sha256, /^[a-f0-9]{64}$/)
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).loaded.verified, false)
}))

function addOrdinaryGraphEvidence(fx, invalidAssociation = false) {
  for (const side of [fx.left, fx.right]) {
    const file = join(side.base, 'evidence/U-ONE-001/trace.jsonl')
    let sequence = 0
    const rows = readFileSync(file, 'utf8').split('\n').map(JSON.parse).map(row => row.event.type === 'session' ? row : { ...row, event: { ...row.event, seq: sequence++ } })
    if (side === fx.right) {
      const session = rows[0].event.id
      const attempt = { execution_id: 'ordinary-mcp-graph', attempt_id: 'inner-model-attempt', role: 'target', session_id: session,
        tool_call_id: invalidAssociation ? 'different-call' : 'call-1', provider: 'deepseek', model: 'deepseek-flash', reasoning_effort: 'off' }
      rows.find(row => row.event.type === 'tool/result').event.data.meta = { graph_execution: {
        execution_id: attempt.execution_id, session_id: session, tool_call_id: attempt.tool_call_id, complete: true, status: 'completed',
        model_attempts: [{ ...attempt, status: 'started', time: 1 }, { ...attempt, status: 'completed', time: 2, usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 } }],
      } }
    }
    write(file, rows.map(JSON.stringify).join('\n'))
    write(join(side.base, 'evidence/U-ONE-001/tools.jsonl'), rows.filter(row => ['tool/call', 'tool/result'].includes(row.event.type)).map(JSON.stringify).join('\n'))
  }
}

test('普通计划的token指标也包含关联MCP图内推理，不能以外层下降误报节省', () => withFixture(async fx => {
  assert.equal(fx.created.plan.generation, undefined)
  assert.equal(fx.created.plan.measurement_schema_version, 2)
  addOrdinaryGraphEvidence(fx)
  const result = success(await fx.handler('compare', fx.body))
  assert.deepEqual(result.comparability.limits, [])
  assert.equal(result.resources.model_calls.variant, 1, '历史已记录响应次数保持原口径')
  assert.equal(result.resources.actual_model_calls.variant, 2)
  assert.equal(result.resources.input_tokens.variant, 1100)
  assert.equal(result.resources.output_tokens.variant, 20)
  assert.equal(result.resources.total_tokens.parent, 220)
  assert.equal(result.resources.total_tokens.variant, 1120, '外层110与图内1010均计入')
  assert.equal(result.resource_evidence.passed, false)
  assert.equal(result.eligible_for_end, false)
}))

test('普通旧计划的图关联未知时token与实际调用保持未知，历史响应指标不能使比较成立', () => withFixture(async fx => {
  addOrdinaryGraphEvidence(fx, true)
  const result = success(await fx.handler('compare', fx.body))
  assert.equal(result.resources.model_calls.variant, 1)
  assert.equal(result.resources.actual_model_calls.variant, null)
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) assert.equal(result.resources[key].variant, null)
  assert.ok(result.comparability.limits.some(message => message.includes('关联图或实际模型请求的完整性未知')))
  assert.ok(result.resource_evidence.limits.some(message => message.includes('关联图或实际模型请求的完整性未知')))
  assert.ok(result.resource_evidence.limits.some(message => message.includes('graph-execution-association-invalid')))
  assert.equal(result.comparability.passed, false)
  assert.equal(result.resource_evidence.passed, false)
  assert.equal(result.eligible_for_end, false)
}, { resource_metric: 'model_calls' }))

test('变体独立名称在预览、创建及回读一致，名称不进入比较计划且绑定预览摘要', () => withFixture(async fx => {
  const saved = load(readFileSync(join(fx.path(variant), 'change.yaml'), 'utf8'))
  assert.equal(saved.variant_name, '资产告警流程固化')
  assert.equal(fx.created.variant_name, saved.variant_name)
  assert.equal(Object.hasOwn(saved.compute_variant, 'variant_name'), false)
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).variant_name, saved.variant_name)
  const input = { parent_experiment_id: parent, parent_ref: `git:${fx.parentCommit}`, strategy: '保留结果并减少中间调度。', case_ids: ['U-ONE-001'], variant_name: '资产告警流程固化' }
  const preview = success(await fx.handler('preview', input))
  assert.equal(preview.variant_name, input.variant_name)
  const changedName = success(await fx.handler('preview', { ...input, variant_name: '资产告警查询合并' }))
  assert.notEqual(changedName.preview_sha256, preview.preview_sha256)
  const stale = await fx.handler('create', { ...input, variant_name: '资产告警查询合并', expected_preview_sha256: preview.preview_sha256 })
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'conflict')
}, { variant_name: '  资产告警流程固化  ' }))

test('旧API缺省生成独立默认名，显式空名及无效名称拒绝且不修改已有变体', () => withFixture(async fx => {
  assert.equal(fx.created.variant_name, '算力变体')
  const file = join(fx.path(variant), 'change.yaml'), before = readFileSync(file, 'utf8')
  const input = { parent_experiment_id: parent, parent_ref: `git:${fx.parentCommit}`, strategy: '完整保留既有结果。', case_ids: ['U-ONE-001'] }
  for (const name of ['', '   ', null, 9, '名'.repeat(81), '名称\n第二行']) {
    for (const method of ['preview', 'create', 'rename']) {
      const result = await fx.handler(method, { ...input, experiment_id: variant, variant_name: name, expected_change_sha256: hash(before) })
      assert.equal(result.ok, false); assert.equal(result.error.code, 'invalid_request')
    }
  }
  assert.equal(readFileSync(file, 'utf8'), before)
}))

test('改名只保存独立名称，额外结论字段不生效，原始事实及已有比较回执继续有效', () => withFixture(async fx => {
  const comparison = success(await fx.handler('compare', fx.body))
  const file = join(fx.path(variant), 'change.yaml'), before = readFileSync(file, 'utf8'), change = load(before)
  const stableFiles = [join(fx.path(parent), 'change.yaml'), join(fx.path(variant), 'candidate/AGENTS.md'), join(fx.path(variant), 'decision.md'),
    join(fx.root, 'agents/alpha/evaluation.md'), join(fx.left.base, 'run.yaml'), join(fx.right.base, 'run.yaml'), join(fx.left.base, 'inputs.lock.json'), join(fx.right.base, 'inputs.lock.json'),
    join(fx.left.base, 'evidence/U-ONE-001/trace.jsonl'), join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl'), join(fx.root, comparison.comparison_receipt.path)]
  const bytes = stableFiles.map(path => readFileSync(path)), head = git(fx.root, ['rev-parse', 'HEAD'])
  const renamed = success(await fx.handler('rename', { experiment_id: variant, variant_name: '查询流程固化版', expected_change_sha256: hash(before),
    variant_kind: 'end', outcome: 'adopt', end_confirmed: true, human_confirmed: true, compute_variant: { strategy: '不应保存' } }))
  const after = readFileSync(file, 'utf8')
  assert.equal(renamed.variant_name, '查询流程固化版')
  assert.equal(renamed.change_sha256, hash(after))
  assert.deepEqual(load(after), { ...change, variant_name: '查询流程固化版' })
  stableFiles.forEach((path, index) => assert.equal(readFileSync(path).equals(bytes[index]), true, path))
  assert.equal(git(fx.root, ['rev-parse', 'HEAD']), head)
  const restored = success(await fx.handler('context', { experiment_id: variant }))
  assert.equal(restored.variant_name, '查询流程固化版')
  assert.equal(restored.workflow_status.compared, true)
  assert.deepEqual(restored.comparison.comparison_receipt, comparison.comparison_receipt)
  assert.deepEqual(restored.comparison.resources, comparison.resources)
  const unchanged = success(await fx.handler('rename', { experiment_id: variant, variant_name: renamed.variant_name, expected_change_sha256: renamed.change_sha256 }))
  assert.equal(unchanged.change_sha256, renamed.change_sha256)
  assert.equal(readFileSync(file, 'utf8'), after)
}))

test('改名拒绝陈旧change摘要，写入锁阻止与研究确认并发', () => withFixture(async fx => {
  const file = join(fx.path(variant), 'change.yaml'), before = readFileSync(file, 'utf8')
  const first = success(await fx.handler('rename', { experiment_id: variant, variant_name: '第一次命名', expected_change_sha256: hash(before) }))
  const after = readFileSync(file, 'utf8')
  const stale = await fx.handler('rename', { experiment_id: variant, variant_name: '陈旧改名', expected_change_sha256: hash(before) })
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'conflict')
  assert.equal(readFileSync(file, 'utf8'), after)
  const compared = success(await fx.handler('compare', fx.body))
  let release, entered, held = false
  const waiting = new Promise(resolve => { entered = resolve })
  fx.setReadHook(() => { if (!held) { held = true; entered(); return new Promise(resolve => { release = resolve }) } })
  const confirming = fx.handler('confirm', { ...fx.body, decision: 'continue', human_confirmed: true, comparison_sha256: compared.comparison_sha256, reason: '继续研究。' })
  await waiting
  const conflict = await fx.handler('rename', { experiment_id: variant, variant_name: '并发改名', expected_change_sha256: first.change_sha256 })
  assert.equal(conflict.ok, false); assert.equal(conflict.error.code, 'conflict')
  release()
  success(await confirming)
  assert.equal(load(readFileSync(file, 'utf8')).variant_name, '第一次命名')
}))

test('普通与旧计划均计入压缩用量，资源增加拒绝 end，旧比较回执不能恢复', () => withFixture(async fx => {
  assert.equal(fx.created.plan.measurement_schema_version, 2)
  const old = success(await fx.handler('compare', fx.body))
  assert.equal(old.resources.total_tokens.parent, 220)
  assert.equal(old.resources.total_tokens.variant, 110)
  const oldReceipt = readFileSync(join(fx.root, old.comparison_receipt.path))
  const file = join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl')
  const rows = readFileSync(file, 'utf8').split('\n').map(JSON.parse)
  rows.splice(2, 0, ...[
    { type: 'compaction/start', data: { compactionId: 'compact' } },
    { type: 'compaction/summary', data: { compactionId: 'compact', llmStreamCall: true, usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 } } },
    { type: 'compaction/end', data: { compactionId: 'compact' } },
  ].map(event => ({ session_log: 'root', event })))
  const save = () => write(file, rows.map((row, index) => JSON.stringify(index ? { ...row, event: { ...row.event, seq: index - 1 } } : row)).join('\n'))
  save()
  write(join(fx.right.base, 'evidence/U-ONE-001/tools.jsonl'), readFileSync(file, 'utf8').split('\n').map(JSON.parse).filter(row => row.event.type.startsWith('tool/')).map(JSON.stringify).join('\n'))
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).workflow_status.compared, false)
  assert.deepEqual(readFileSync(join(fx.root, old.comparison_receipt.path)), oldReceipt)
  for (const legacy of [false, true]) {
    if (legacy) {
      const path = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(path, 'utf8'))
      delete change.compute_variant.measurement_schema_version
      write(path, dump(change)); git(fx.root, ['add', path]); git(fx.root, ['commit', '-m', 'legacy plan fixture'])
      const commit = git(fx.root, ['rev-parse', 'HEAD'])
      for (const side of [fx.left, fx.right]) { side.lock.git_version.commit = commit; write(join(side.base, 'inputs.lock.json'), JSON.stringify(side.lock)) }
    }
    const current = success(await fx.handler('compare', fx.body))
    assert.deepEqual(current.resources.total_tokens, { parent: 220, variant: 1120, reduction_pct: (220 - 1120) / 220 * 100 })
    assert.equal(current.resources.input_tokens.variant, 1100)
    assert.equal(current.resources.output_tokens.variant, 20)
    assert.equal(current.resource_evidence.passed, false)
    assert.equal(current.eligible_for_end, false)
    assert.equal((await fx.handler('confirm', { ...fx.body, human_confirmed: true, decision: 'end', comparison_sha256: current.comparison_sha256, reason: '不能确认资源增加。' })).ok, false)
  }
  delete rows.find(row => row.event.type === 'compaction/summary').event.data.usage
  save()
  const unknown = success(await fx.handler('compare', fx.body))
  assert.equal(unknown.resources.total_tokens.variant, null)
  assert.equal(unknown.eligible_for_end, false)
}))

test('Token 计量沿用继承边界并去重原生事件，辅助标题缺少用量时保持未知', () => {
  const parentRows = completeTrace(1, 100, 'parent')
  const history = trace(1), current = trace(1).map(row => ({ ...row, event: { ...row.event, data: { ...row.event.data, turn: 2 } } }))
  const childRows = [{ session_log: 'child', event: { type: 'session', id: 'child', isSeeded: true } },
    ...[...history, { event: { type: 'session/end-seed', data: { inherited: true } } }, ...current].map((row, seq) => ({ session_log: 'child', event: { ...row.event, seq } }))]
  assert.equal(computeTraceMetrics([...parentRows, ...parentRows, ...childRows], true).values.total_tokens, 220)
  const title = completeTrace(1)
  title.push(...[
    { type: 'session/title-llm-request', data: { titleProvider: 'llm', messageSeqs: [1], route: { provider: 'fixture', model: 'model' } } },
    { type: 'session/title', data: { messageSeqs: [1], source: { kind: 'provider', provider: 'llm', model: { provider: 'fixture', model: 'model' } } } },
  ].map((event, index) => ({ session_log: 'root', event: { ...event, seq: title.length - 1 + index } })))
  assert.equal(computeTraceMetrics(title, true).values.actual_model_calls, 2)
  assert.equal(computeTraceMetrics(title, true).values.total_tokens, null)
})

test('算力确认核对 Decision 摘要，并发正常保存成功后保留正文并显式冲突', () => withFixture(async fx => {
  const compared = success(await fx.handler('compare', fx.body))
  const decisionPath = join(fx.path(variant), 'decision.md'), beforeChange = readFileSync(join(fx.path(variant), 'change.yaml'))
  let release, entered, held = false
  const waiting = new Promise(resolve => { entered = resolve })
  fx.setReadHook(() => { if (!held) { held = true; entered(); return new Promise(resolve => { release = resolve }) } })
  const confirming = fx.handler('confirm', { ...fx.body, decision: 'end', human_confirmed: true, comparison_sha256: compared.comparison_sha256, reason: '核对当前比较。' })
  await waiting
  const content = '# Decision\n\n新保存的研究观察与适用限制。\n'
  const handler = createAgentsHandler(fx.root)
  success(await handler('decision/update', { experiment_id: variant, content, expected_sha256: hash(readFileSync(decisionPath)) }, new AbortController().signal))
  release()
  const confirmed = await confirming
  assert.equal(confirmed.ok, false); assert.equal(confirmed.error.code, 'conflict', JSON.stringify(confirmed))
  assert.equal(readFileSync(decisionPath, 'utf8'), content)
  assert.deepEqual(readFileSync(join(fx.path(variant), 'change.yaml')), beforeChange)
  fx.setReadHook(null)
  const stale = await fx.handler('confirm', { ...fx.body, decision: 'continue', human_confirmed: true, comparison_sha256: compared.comparison_sha256, reason: '旧页面确认。' })
  assert.equal(stale.ok, false); assert.equal(stale.error.code, 'conflict')
}))

test('算力确认写清单失败时恢复原 Decision 或移除本次新文件，并保留并发修改', async t => {
  for (const mode of ['existing', 'missing', 'concurrent']) await t.test(mode, () => withFixture(async fx => {
    const decisionFile = join(fx.path(variant), 'decision.md'), changeFile = join(fx.path(variant), 'change.yaml')
    const oldDecision = readFileSync(decisionFile, 'utf8'), oldChange = readFileSync(changeFile)
    if (mode === 'missing') rmSync(decisionFile)
    const compared = success(await fx.handler('compare', fx.body))
    const rename = fs.renameSync
    const mocked = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === changeFile) {
        if (mode === 'concurrent') writeFileSync(decisionFile, '# 并发保存的研究观察\n')
        throw Object.assign(new Error('fixture rename failed'), { code: 'EIO' })
      }
      return rename(from, to)
    })
    syncBuiltinESMExports()
    let confirmed
    try { confirmed = await fx.handler('confirm', { ...fx.body, decision: 'continue', human_confirmed: true, comparison_sha256: compared.comparison_sha256, reason: '应按原状态回滚。' }) }
    finally { mocked.mock.restore(); syncBuiltinESMExports() }
    assert.equal(confirmed.ok, false)
    assert.deepEqual(readFileSync(changeFile), oldChange)
    assert.equal(existsSync(`${changeFile}.compute-${process.pid}.tmp`), false)
    if (mode === 'missing') assert.equal(existsSync(decisionFile), false, '不留下未保存成功的 Decision')
    else assert.equal(readFileSync(decisionFile, 'utf8'), mode === 'concurrent' ? '# 并发保存的研究观察\n' : oldDecision)
    if (mode === 'concurrent') assert.equal(confirmed.error.code, 'needs_recovery')
    const latest = success(await fx.handler('compare', fx.body))
    success(await fx.handler('confirm', { ...fx.body, decision: 'continue', human_confirmed: true, comparison_sha256: latest.comparison_sha256, reason: '故障恢复后可重新确认。' }))
  }))
})

test('代码生成预览读取固定父版真实轨迹，拒绝把其他版本Run当来源', () => withFixture(async fx => {
  const input = { parent_experiment_id: parent, parent_ref: `git:${fx.parentCommit}`, strategy: '将固定查询顺序生成为 LangGraph 工具', case_ids: ['U-ONE-001'],
    generation: { mode: 'langgraph-aot', source_run_ids: [parentRun] } }
  const preview = success(await fx.handler('preview', input))
  assert.equal(preview.variant_name, 'LangGraph 代码变体')
  assert.equal(preview.plan.generation.entry_path, 'dsh/managed/compute-workflow/index.ts')
  assert.equal(preview.plan.resource_metric, 'actual_model_calls')
  assert.equal(preview.plan.measurement_schema_version, 2)
  assert.equal(preview.plan.generation.source_evidence.length, 1)
  assert.match(preview.plan.generation.source_evidence[0].sha256, /^[a-f0-9]{64}$/)
  const rejected = await fx.handler('preview', { ...input, generation: { ...input.generation, source_run_ids: [variantRun] } })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error.message, /固定父版/)
}))

test('纯代码执行计划保存独立约束，拒绝缺少生成计划或同时变更模型', () => withFixture(async fx => {
  const input = { parent_experiment_id: parent, parent_ref: `git:${fx.parentCommit}`, strategy: '用确定性代码执行完整查询，不调用模型。',
    case_ids: ['U-ONE-001'], execution_mode: 'code-only', resource_metric: 'actual_model_calls', min_resource_reduction_pct: 100,
    generation: { mode: 'langgraph-aot', source_run_ids: [parentRun] } }
  const preview = success(await fx.handler('preview', input))
  assert.equal(preview.plan.execution_mode, 'code-only')
  assert.equal(preview.model_configuration, 'code_only_local_execution')
  assert.equal(preview.plan.min_resource_reduction_pct, 100)
  const created = success(await fx.handler('create', { ...input, expected_preview_sha256: preview.preview_sha256 }))
  assert.equal(created.plan.execution_mode, 'code-only')
  assert.equal(load(readFileSync(join(fx.path(variant), 'change.yaml'), 'utf8')).compute_variant.execution_mode, 'code-only')
  for (const body of [{ ...input, generation: undefined }, { ...input, allow_model_change: true, variant_model: 'other', variant_reasoning_effort: 'off' }, { ...input, execution_mode: 'unknown' }]) {
    assert.equal((await fx.handler('preview', body)).ok, false)
  }
}))

test('混合计划固定双模型及决策产物身份，不能放松既有单模型或纯代码约束', () => withFixture(async fx => {
  const input = { parent_experiment_id: parent, parent_ref: `git:${fx.parentCommit}`, strategy: '语言解释与学习决策分工。',
    case_ids: ['U-ONE-001'], execution_mode: 'hybrid', model_roles: modelRoles,
    generation: { mode: 'langgraph-aot', source_run_ids: [parentRun] } }
  const preview = success(await fx.handler('preview', input))
  assert.equal(preview.plan.execution_mode, 'hybrid')
  assert.equal(preview.model_configuration, 'explicit_model_roles')
  assert.deepEqual(preview.plan.model_roles, modelRoles)
  const created = success(await fx.handler('create', { ...input, expected_preview_sha256: preview.preview_sha256 }))
  assert.deepEqual(created.plan.model_roles, modelRoles)
  for (const body of [
    { ...input, generation: undefined }, { ...input, model_roles: undefined },
    { ...input, allow_model_change: true, variant_model: 'other', variant_reasoning_effort: 'off' },
    { ...input, execution_mode: 'code-only' }, { ...input, execution_mode: undefined },
    { ...input, model_roles: { ...modelRoles, decision: { ...modelRoles.decision, checkpoint_sha256: '' } } },
    { ...input, model_roles: { ...modelRoles, decision: { ...modelRoles.decision, provider: modelRoles.language.provider, model: modelRoles.language.model } } },
  ]) assert.equal((await fx.handler('preview', body)).ok, false)
}))

test('新口径不能把缺少原生事件序号的旧响应统计当实际请求证据', () => withFixture(async fx => {
  for (const side of [fx.left, fx.right]) {
    const file = join(side.base, 'evidence/U-ONE-001/trace.jsonl')
    const rows = readFileSync(file, 'utf8').split('\n').map(JSON.parse)
    for (const row of rows) delete row.event.seq
    write(file, rows.map(JSON.stringify).join('\n'))
  }
  const result = success(await fx.handler('compare', fx.body))
  assert.equal(result.resources.model_calls.parent, 2)
  assert.equal(result.resources.actual_model_calls.parent, null)
  const changePath = join(fx.path(variant), 'change.yaml')
  const change = load(readFileSync(changePath, 'utf8'))
  change.compute_variant.resource_metric = 'actual_model_calls'; change.compute_variant.measurement_schema_version = 2
  write(changePath, dump(change))
  const compared = success(await fx.handler('compare', fx.body))
  assert.equal(compared.resources.actual_model_calls.variant, null)
  assert.equal(compared.eligible_for_end, false)
}))

async function generatedNestedFixture(fx) {
  const changePath = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(changePath, 'utf8'))
  change.compute_variant.generation = { mode: 'langgraph-aot', entry_path: 'dsh/managed/compute-workflow/index.ts', source_run_ids: [parentRun] }
  change.compute_variant.measurement_schema_version = 2
  change.compute_variant.resource_metric = 'actual_model_calls'
  write(changePath, dump(change))
  write(join(fx.root, 'config/sources.json'), JSON.stringify({ sources: { [variant]: { agent_id: 'alpha', candidate_root: `evolution/experiments/${variant}/candidate/dsh` } } }))
  write(join(fx.path(variant), 'candidate/dsh/managed/compute-workflow/index.ts'), `import {defineWorkflow,registerWorkflowTool} from '@harness-platform/workflow-runtime';
export const name='asset-query'; export const inject=['tools'];
const workflow=defineWorkflow({id:'asset-query',toolName:'asset_query',description:'查询',inputSchema:{type:'object'},async run(context){return context.callTool('fixed_composition',context.input)}});
export function apply(ctx:any){registerWorkflowTool(ctx,workflow)}\n`)
  const buildHandler = createComputeBuildHandler(fx.root), digest = candidateDigest(join(fx.path(variant), 'candidate'))
  const preview = success(await buildHandler('preview', { experiment_id: variant, expected_candidate_sha256: digest }))
  const built = success(await buildHandler('build', { experiment_id: variant, expected_candidate_sha256: digest, expected_preview_sha256: preview.preview_sha256 }))
  git(fx.root, ['add', `evolution/experiments/${variant}/candidate`, `evolution/experiments/${variant}/change.yaml`, 'config/sources.json'])
  git(fx.root, ['commit', '-m', 'freeze generated workflow and comparison'])
  const commit = git(fx.root, ['rev-parse', 'HEAD'])
  for (const run of [fx.left, fx.right]) { run.lock.git_version.commit = commit; write(join(run.base, 'inputs.lock.json'), JSON.stringify(run.lock)) }
  function save(run, body) {
    const header = { session_log: 'root', event: { type: 'session', id: run.view.cases[0].load_observation.session_id, delegationDepth: 0, createdAt: Date.parse(run.lock.created_at) + 10 } }
    const rows = [header, ...body.map((row, seq) => ({ ...row, event: { ...row.event, seq } }))]
    write(join(run.base, 'evidence/U-ONE-001/trace.jsonl'), rows.map(JSON.stringify).join('\n'))
    write(join(run.base, 'evidence/U-ONE-001/tools.jsonl'), rows.filter(row => row.event.type.startsWith('tool/')).map(JSON.stringify).join('\n'))
  }
  save(fx.left, trace(3))
  const session = fx.right.view.cases[0].load_observation.session_id
  const childIdentity = { execution_id: 'fixed-child', session_id: session, tool_call_id: 'nested-call', role: 'target' }
  const child = { ...childIdentity, complete: true, source_digest: 'a'.repeat(64), build_digest: 'b'.repeat(64), model_attempts: [
    { ...childIdentity, attempt_id: 'inner-attempt', status: 'preparing', provider: 'proposal-provider', model: 'proposal-model', reasoning_effort: 'off', time: 1 },
    { ...childIdentity, attempt_id: 'inner-attempt', status: 'started', provider: 'deepseek', model: 'deepseek-flash', reasoning_effort: 'off', time: 2 },
    { ...childIdentity, attempt_id: 'inner-attempt', status: 'completed', provider: 'deepseek', model: 'deepseek-flash', reasoning_effort: 'off', time: 3, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
  ] }
  const raw = { ok: true, version: { versionId: 'c'.repeat(64), implementationDigest: child.build_digest, sourceDigest: child.source_digest }, graph_execution: child }
  const step = { call_id: child.tool_call_id, status: 'completed', meta: { graph_execution: child,
    fixed_composition: { composition_id: 'asset-composition', version_id: raw.version.versionId, implementation_digest: raw.version.implementationDigest } }, result: {} }
  const wrapper = { execution_id: 'workflow-wrapper', session_id: session, tool_call_id: 'call-1', workflow_id: 'asset-query',
    complete: true, status: 'completed', esm_sha256: built.esm_sha256, build_digest: built.build_digest, model_attempts: [], trace: [step] }
  function saveVariant() {
    step.result = { isError: false, content: [{ type: 'text', text: JSON.stringify(raw) }] }
    const body = trace(1)
    body.find(row => row.event.type === 'tool/result').event.data.meta = { graph_execution: wrapper }
    save(fx.right, body)
  }
  saveVariant()
  return { built, child, raw, wrapper, saveVariant }
}

async function codeOnlyFixture(fx) {
  const generated = await generatedNestedFixture(fx)
  const changePath = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(changePath, 'utf8'))
  change.compute_variant.execution_mode = 'code-only'
  change.compute_variant.min_resource_reduction_pct = 100
  write(changePath, dump(change))
  git(fx.root, ['add', `evolution/experiments/${variant}/change.yaml`]); git(fx.root, ['commit', '-m', 'freeze code-only execution'])
  const commit = git(fx.root, ['rev-parse', 'HEAD'])
  for (const run of [fx.left, fx.right]) { run.lock.git_version.commit = commit; write(join(run.base, 'inputs.lock.json'), JSON.stringify(run.lock)) }
  generated.child.model_attempts = []
  generated.wrapper.execution_mode = 'code-only'
  function saveCodeOnly() {
    generated.saveVariant()
    const file = join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl')
    const rows = readFileSync(file, 'utf8').split('\n').map(JSON.parse)
    const route = { provider: 'harness-code-only', model: 'workflow-v1', reasoningEffort: 'off' }
    for (const row of rows) {
      if (row.event.type === 'request/header') row.event.data.header.config = route
      if (row.event.type === 'assistant/message') delete row.event.data.usage
    }
    fx.right.view.cases[0].actual_routes = [route]
    write(join(fx.right.base, 'evidence/U-ONE-001/response.json'), JSON.stringify({ assistant_texts: ['模拟资产状态正常。'], turns: [{ route }] }))
    write(file, rows.map(JSON.stringify).join('\n'))
    write(join(fx.right.base, 'evidence/U-ONE-001/tools.jsonl'), rows.filter(row => row.event.type.startsWith('tool/')).map(JSON.stringify).join('\n'))
  }
  saveCodeOnly()
  return { ...generated, saveCodeOnly }
}

async function hybridFixture(fx) {
  const generated = await codeOnlyFixture(fx)
  const changePath = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(changePath, 'utf8'))
  change.compute_variant.execution_mode = 'hybrid'
  change.compute_variant.model_roles = modelRoles
  change.compute_variant.min_resource_reduction_pct = 10
  write(changePath, dump(change))
  git(fx.root, ['add', `evolution/experiments/${variant}/change.yaml`]); git(fx.root, ['commit', '-m', 'freeze hybrid execution'])
  const commit = git(fx.root, ['rev-parse', 'HEAD'])
  for (const run of [fx.left, fx.right]) { run.lock.git_version.commit = commit; write(join(run.base, 'inputs.lock.json'), JSON.stringify(run.lock)) }
  const attempt = (graph, modelRole, name) => {
    const identity = { execution_id: graph.execution_id, session_id: graph.session_id, tool_call_id: graph.tool_call_id,
      role: 'target', model_role: modelRole, ...(modelRole === 'decision' ? { kind: 'typed_decision' } : {}), attempt_id: name, ...modelRoles[modelRole] }
    return [{ ...identity, status: 'started', time: 1 }, { ...identity, status: 'completed', model_invocation: true, time: 2, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }]
  }
  generated.wrapper.execution_mode = 'hybrid'
  generated.wrapper.model_attempts = attempt(generated.wrapper, 'language', 'qwen-request')
  generated.child.model_attempts = attempt(generated.child, 'decision', 'kev-request')
  function saveHybrid() {
    generated.saveCodeOnly()
    const file = join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl')
    const rows = readFileSync(file, 'utf8').split('\n').map(JSON.parse)
    const route = { provider: 'harness-workflow', model: 'hybrid-v1', reasoningEffort: 'off' }
    for (const row of rows) if (row.event.type === 'request/header') row.event.data.header.config = route
    fx.right.view.cases[0].actual_routes = [route]
    write(join(fx.right.base, 'evidence/U-ONE-001/response.json'), JSON.stringify({ assistant_texts: ['模拟资产状态正常。'], turns: [{ route }] }))
    write(file, rows.map(JSON.stringify).join('\n'))
    write(join(fx.right.base, 'evidence/U-ONE-001/tools.jsonl'), rows.filter(row => row.event.type.startsWith('tool/')).map(JSON.stringify).join('\n'))
  }
  saveHybrid()
  return { ...generated, saveHybrid }
}

test('混合比较仅接受固定角色、路由及决策产物，完整计量图内双模型', () => withFixture(async fx => {
  const generated = await hybridFixture(fx)
  const compared = success(await fx.handler('compare', fx.body))
  assert.deepEqual(compared.comparability.limits, [])
  assert.equal(compared.resources.actual_model_calls.variant, 2)
  assert.equal(compared.resources.total_tokens.variant, 14)
  assert.equal(compared.eligible_for_end, true)
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).loaded.verified, true)
  for (const field of ['checkpoint_sha256', 'state_constructor_sha256', 'calibration_sha256', 'model', 'model_role', 'kind']) {
    const original = generated.child.model_attempts.map(attempt => ({ ...attempt }))
    for (const attempt of generated.child.model_attempts) attempt[field] = field.endsWith('_sha256') ? 'd'.repeat(64) : 'unexpected'
    generated.saveHybrid()
    const invalid = success(await fx.handler('compare', fx.body))
    assert.equal(invalid.eligible_for_end, false, field)
    assert.ok(invalid.comparability.limits.some(message => message.includes('双模型角色及产物身份')), field)
    generated.child.model_attempts = original
  }
  generated.wrapper.execution_mode = 'code-only'
  generated.saveHybrid()
  assert.ok(success(await fx.handler('compare', fx.body)).comparability.limits.some(message => message.includes('混合执行模式')))
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).loaded.verified, false)
}))

test('纯代码变体以完整零模型请求通过比较，外层本地回复无供应商Token也确认为零', () => withFixture(async fx => {
  await codeOnlyFixture(fx)
  const compared = success(await fx.handler('compare', fx.body))
  assert.deepEqual(compared.comparability.limits, [])
  assert.equal(compared.resources.actual_model_calls.parent, 3)
  assert.equal(compared.resources.actual_model_calls.variant, 0)
  assert.equal(compared.resources.actual_model_calls.reduction_pct, 100)
  assert.equal(compared.resources.total_tokens.variant, 0)
  assert.ok(compared.notes.some(message => message.includes('本地代码适配器回复') && message.includes('actual_model_calls')))
  assert.equal(compared.resource_evidence.passed, true)
  assert.equal(compared.eligible_for_end, true)
}))

test('纯代码变体不能以图内调用、未知计量或非受控路由通过零调用验收', () => withFixture(async fx => {
  const generated = await codeOnlyFixture(fx)
  const identity = { execution_id: generated.child.execution_id, session_id: generated.child.session_id, tool_call_id: generated.child.tool_call_id,
    role: 'target', attempt_id: 'unexpected-inference', provider: 'deepseek', model: 'deepseek-flash', reasoning_effort: 'off' }
  generated.child.model_attempts = [{ ...identity, status: 'started', time: 1 }, { ...identity, status: 'completed', time: 2, usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }]
  generated.saveCodeOnly()
  const inferred = success(await fx.handler('compare', fx.body))
  assert.equal(inferred.resources.actual_model_calls.variant, 1)
  assert.equal(inferred.resource_evidence.passed, false)
  assert.equal(inferred.eligible_for_end, false)
  generated.child.model_attempts = []
  generated.saveCodeOnly()
  const file = join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl')
  const rows = readFileSync(file, 'utf8').split('\n').map(JSON.parse)
  delete rows.find(row => row.event.type === 'step/end').event.seq
  write(file, rows.map(JSON.stringify).join('\n'))
  const unknown = success(await fx.handler('compare', fx.body))
  assert.equal(unknown.resources.actual_model_calls.variant, null)
  assert.equal(unknown.resource_evidence.passed, false)
  assert.equal(unknown.eligible_for_end, false)
  generated.saveCodeOnly()
  const wrong = readFileSync(file, 'utf8').split('\n').map(JSON.parse)
  wrong.find(row => row.event.type === 'request/header').event.data.header.config.reasoningEffort = 'high'
  write(file, wrong.map(JSON.stringify).join('\n'))
  const routed = success(await fx.handler('compare', fx.body))
  assert.ok(routed.comparability.limits.some(message => message.includes('非受控本地执行路由')))
  assert.equal(routed.resource_evidence.passed, false)
  assert.equal(routed.eligible_for_end, false)
}))

test('纯代码装载须有执行模式回执，历史计划仍拒绝未经允许的路由变化', () => withFixture(async fx => {
  const generated = await codeOnlyFixture(fx)
  delete generated.wrapper.execution_mode
  generated.saveCodeOnly()
  const missingMode = success(await fx.handler('compare', fx.body))
  assert.ok(missingMode.comparability.limits.some(message => message.includes('纯代码执行模式')))
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).loaded.verified, false)
  const changePath = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(changePath, 'utf8'))
  delete change.compute_variant.execution_mode
  write(changePath, dump(change))
  git(fx.root, ['add', `evolution/experiments/${variant}/change.yaml`]); git(fx.root, ['commit', '-m', 'ordinary legacy code plan'])
  const commit = git(fx.root, ['rev-parse', 'HEAD'])
  for (const run of [fx.left, fx.right]) { run.lock.git_version.commit = commit; write(join(run.base, 'inputs.lock.json'), JSON.stringify(run.lock)) }
  const historical = success(await fx.handler('compare', fx.body))
  assert.ok(historical.comparability.limits.some(message => message.includes('未预先允许的模型路由差异')))
  assert.equal(historical.eligible_for_end, false)
}))

test('已构建wrapper嵌套固定MCP子图无需共享ESM，图内实际调用计入且可比/装载通过', () => withFixture(async fx => {
  const nested = await generatedNestedFixture(fx)
  const compared = success(await fx.handler('compare', fx.body))
  assert.deepEqual(compared.comparability.limits, [])
  assert.equal(compared.resources.actual_model_calls.parent, 3)
  assert.equal(compared.resources.actual_model_calls.variant, 2)
  assert.equal(compared.eligible_for_end, true)
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).loaded.verified, true)
  nested.raw.version.implementationDigest = 'd'.repeat(64)
  nested.saveVariant()
  const drift = success(await fx.handler('compare', fx.body))
  assert.ok(drift.comparability.limits.some(message => message.includes('子组合缺少一致的固定版本')))
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).loaded.verified, false)
  nested.raw.version.implementationDigest = nested.child.build_digest
  delete nested.wrapper.workflow_id
  nested.saveVariant()
  const missingWrapper = success(await fx.handler('compare', fx.body))
  assert.ok(missingWrapper.comparability.limits.some(message => message.includes('缺少本次构建工作流')))
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).loaded.verified, false)
  nested.wrapper.workflow_id = 'asset-query'
  nested.wrapper.trace[0].meta.fixed_composition = {}
  nested.raw.version = {}; delete nested.child.build_digest; delete nested.child.source_digest
  nested.saveVariant()
  assert.ok(success(await fx.handler('compare', fx.body)).comparability.limits.some(message => message.includes('子组合缺少一致的固定版本')))
}))

test('图内prepared实际换模型不能伪装成外层同模型，拟议路由不作为实际调用', () => withFixture(async fx => {
  const nested = await generatedNestedFixture(fx)
  assert.equal(success(await fx.handler('compare', fx.body)).comparability.passed, true)
  for (const attempt of nested.child.model_attempts) if (attempt.status !== 'preparing') attempt.model = 'unplanned-inner-model'
  nested.saveVariant()
  const changed = success(await fx.handler('compare', fx.body))
  assert.equal(changed.comparability.passed, false)
  assert.ok(changed.comparability.limits.some(message => message.includes('未预先允许的模型路由差异')))
  assert.equal(changed.eligible_for_end, false)
}))

test('固定完整父版、冻结范围、双Run比较和人工确认 end 闭环', () => withFixture(async fx => {
  assert.equal(readFileSync(join(fx.path(parent), 'candidate/AGENTS.md'), 'utf8'), readFileSync(join(fx.path(variant), 'candidate/AGENTS.md'), 'utf8'))
  assert.equal(fx.created.plan.model_change, null)
  const compared = success(await fx.handler('compare', fx.body))
  assert.deepEqual(compared.comparability.limits, [])
  assert.equal(compared.resources.total_tokens.parent, 220)
  assert.equal(compared.resources.total_tokens.variant, 110)
  assert.equal(compared.eligible_for_end, true)
  assert.equal((await fx.handler('confirm', { ...fx.body, decision: 'end', comparison_sha256: compared.comparison_sha256, reason: '完整核对通过。' })).ok, false)
  const confirmed = success(await fx.handler('confirm', { ...fx.body, decision: 'end', human_confirmed: true, comparison_sha256: compared.comparison_sha256, reason: '已核对所有原始输出和工具结果；仅限该冻结查询任务。' }))
  assert.equal(confirmed.variant_kind, 'end')
  const change = load(readFileSync(join(fx.path(variant), 'change.yaml'), 'utf8'))
  assert.equal(change.end_confirmed, true); assert.equal(change.outcome, 'adopt')
  assert.equal(change.resource_evidence_refs.length, 2)
  assert.match(readFileSync(join(fx.path(variant), 'decision.md'), 'utf8'), /仅限冻结任务范围/)
}))

test('实际机器比较保存不可变回执，未作Decision也能从原始证据恢复，重复比较不覆盖', () => withFixture(async fx => {
  const changeFile = join(fx.path(variant), 'change.yaml'), original = readFileSync(changeFile, 'utf8')
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).workflow_status.compared, false)
  const result = success(await fx.handler('compare', fx.body)), descriptor = result.comparison_receipt
  assert.match(descriptor.path, /\/evaluation\/compute-comparison-[0-9a-f]{64}\.json$/)
  const bytes = readFileSync(join(fx.root, descriptor.path))
  assert.equal(descriptor.sha256, hash(bytes))
  assert.equal(readFileSync(changeFile, 'utf8'), original, '机器比较不修改研究决定或冻结计划')
  const restored = success(await fx.handler('context', { experiment_id: variant }))
  assert.equal(restored.workflow_status.compared, true)
  assert.deepEqual(restored.comparison.comparison_receipt, descriptor)
  assert.deepEqual(restored.comparison.resources, result.resources)
  assert.deepEqual(restored.comparison.parent_run_ids, [parentRun])
  assert.deepEqual(restored.comparison.variant_run_ids, [variantRun])
  const repeated = success(await fx.handler('compare', fx.body))
  assert.deepEqual(repeated.comparison_receipt, descriptor)
  assert.equal(readFileSync(join(fx.root, descriptor.path)).equals(bytes), true)
  assert.equal(readdirSync(join(fx.path(variant), 'evaluation')).filter(name => name.startsWith('compute-comparison-')).length, 1)
}))

test('Decision本身不使实际比较失效，单独的旧Decision不能代替比较回执', () => withFixture(async fx => {
  const changeFile = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(changeFile, 'utf8'))
  change.compute_variant_decision = { candidate_sha256: hash(readFileSync(join(fx.path(variant), 'candidate/AGENTS.md'))) }
  write(changeFile, dump(change))
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).workflow_status.compared, false)
  const result = success(await fx.handler('compare', fx.body))
  success(await fx.handler('confirm', { ...fx.body, decision: 'end', human_confirmed: true, comparison_sha256: result.comparison_sha256, reason: '核对实际业务及资源结果。' }))
  const restored = success(await fx.handler('context', { experiment_id: variant }))
  assert.equal(restored.workflow_status.compared, true)
  assert.deepEqual(restored.comparison.comparison_receipt, result.comparison_receipt)
  assert.notEqual(restored.comparison.comparison_sha256, result.comparison_sha256, '当次确认仍使用当前change并发摘要')
  success(await fx.handler('confirm', { ...fx.body, decision: 'continue', human_confirmed: true, comparison_sha256: restored.comparison.comparison_sha256, reason: '继续扩大研究范围前保留已有比较。' }))
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).workflow_status.compared, true)
}))

test('当前Candidate、计划、原始证据或回执变化使已比较状态失效', async t => {
  for (const [name, mutate] of [
    ['Candidate', fx => write(join(fx.path(variant), 'candidate/AGENTS.md'), '新的未比较资产。')],
    ['计划', fx => { const file = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(file, 'utf8')); change.compute_variant.strategy = '已改变的研究方案'; write(file, dump(change)) }],
    ['原始轨迹', fx => write(join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl'), trace(2).map(JSON.stringify).join('\n'))],
    ['原始报告', fx => write(join(fx.right.base, 'report.md'), '已经改变的报告。')],
    ['回执', (fx, result) => { const file = join(fx.root, result.comparison_receipt.path); rmSync(file); write(file, '{}\n') }],
  ]) await t.test(name, () => withFixture(async fx => {
    const result = success(await fx.handler('compare', fx.body))
    mutate(fx, result)
    const current = success(await fx.handler('context', { experiment_id: variant }))
    assert.equal(current.workflow_status.compared, false)
    assert.equal(current.comparison, null)
    if (name === '回执') {
      const rejected = await fx.handler('compare', fx.body)
      assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'conflict')
      assert.equal(readFileSync(join(fx.root, result.comparison_receipt.path), 'utf8'), '{}\n')
    }
  }))
})

test('构建回执变化使比较失效，比较完成与质量或资源通过分别报告', () => withFixture(async fx => {
  await generatedNestedFixture(fx)
  fx.right.view.cases[0].review.reviewed_verdict = 'failed'
  const result = success(await fx.handler('compare', fx.body))
  assert.equal(result.quality.passed, false); assert.equal(result.eligible_for_end, false)
  assert.equal(success(await fx.handler('context', { experiment_id: variant })).workflow_status.compared, true)
  const file = join(fx.path(variant), 'change.yaml'), change = load(readFileSync(file, 'utf8'))
  change.compute_variant_build.compiler.typescript = 'changed-compiler'
  write(file, dump(change))
  const current = success(await fx.handler('context', { experiment_id: variant }))
  assert.equal(current.workflow_status.built, true, '即便已有构建核对未否定该字段，比较仍绑定完整构建回执')
  assert.equal(current.workflow_status.compared, false)
}))

test('缺少 token 保持 unknown，质量通过不代表资源证据充分', () => withFixture(async fx => {
  const rows = trace(1); delete rows.find(row => row.event.type === 'assistant/message').event.data.usage
  write(join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl'), rows.map(JSON.stringify).join('\n'))
  const value = success(await fx.handler('compare', fx.body))
  assert.equal(value.resources.total_tokens.variant, null)
  assert.equal(value.quality.passed, true); assert.equal(value.eligible_for_end, false)
  assert.ok(value.resource_evidence.limits.some(item => item.includes('token')))
  assert.equal((await fx.handler('confirm', { ...fx.body, decision: 'end', human_confirmed: true, comparison_sha256: value.comparison_sha256, reason: '试图确认' })).ok, false)
  assert.equal(success(await fx.handler('confirm', { ...fx.body, decision: 'inconclusive', human_confirmed: true, comparison_sha256: value.comparison_sha256, reason: '缺少资源数据。' })).variant_kind, 'exploratory')
}))

test('事后计划、模型更换、口径变化与装载缺失分别阻断可比性', () => withFixture(async fx => {
  fx.right.lock.created_at = '2000-01-01T00:00:00Z'
  write(join(fx.right.base, 'inputs.lock.json'), JSON.stringify(fx.right.lock))
  fx.right.view.cases[0].actual_routes[0].model = 'other-model'
  const rows = trace(1); rows.find(row => row.event.type === 'request/header').event.data.header.config.model = 'other-model'
  write(join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl'), rows.map(JSON.stringify).join('\n'))
  fx.right.view.cases[0].frozen.inputs = ['不同输入']
  fx.right.view.cases[0].load_observation.preset_matches = false
  const value = success(await fx.handler('compare', fx.body))
  for (const fragment of ['早于冻结计划', '模型路由差异', '冻结 Case', '装载观察']) assert.ok(value.comparability.limits.some(item => item.includes(fragment)), fragment)
  assert.equal(value.eligible_for_end, false)
}))

test('封存证据变化使人工确认摘要过期，不写 end', () => withFixture(async fx => {
  const value = success(await fx.handler('compare', fx.body))
  write(join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl'), trace(2).map(JSON.stringify).join('\n'))
  const result = await fx.handler('confirm', { ...fx.body, decision: 'end', human_confirmed: true, comparison_sha256: value.comparison_sha256, reason: '旧结论' })
  assert.equal(result.ok, false); assert.equal(result.error.code, 'conflict')
  assert.equal(load(readFileSync(join(fx.path(variant), 'change.yaml'), 'utf8')).variant_kind, 'exploratory')
}))

test('功能回归、未固定Candidate与虚假重复不能获得 end', () => withFixture(async fx => {
  fx.right.view.cases[0].review.reviewed_verdict = 'failed'
  fx.right.view.cases[0].trials.push({ execution_status: 'completed', verdict: 'passed' })
  write(join(fx.path(variant), 'candidate/AGENTS.md'), '尚未评测的修改。')
  const value = success(await fx.handler('compare', fx.body))
  assert.equal(value.quality.passed, false)
  assert.ok(value.comparability.limits.some(item => item.includes('Candidate')))
  assert.ok(value.comparability.limits.some(item => item.includes('一次')))
  assert.equal(value.eligible_for_end, false)
}))

test('两侧全失败即使通过率相同，也不能声明业务近似等效', () => withFixture(async fx => {
  fx.left.view.cases[0].review.reviewed_verdict = 'failed'
  fx.right.view.cases[0].review.reviewed_verdict = 'failed'
  const value = success(await fx.handler('compare', fx.body))
  assert.equal(value.quality.passed, false); assert.equal(value.eligible_for_end, false)
}, { critical_case_ids: [] }))

test('复制另一 Run 的 Session 轨迹不能伪装独立重复证据', () => withFixture(async fx => {
  const path = join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl')
  const rows = readFileSync(path, 'utf8').split('\n').map(JSON.parse)
  rows[0].event.id = fx.left.view.cases[0].load_observation.session_id
  fx.right.view.cases[0].load_observation.session_id = rows[0].event.id
  write(path, rows.map(JSON.stringify).join('\n'))
  const value = success(await fx.handler('compare', fx.body))
  assert.ok(value.comparability.limits.some(item => item.includes('重用了已选 Session')))
  assert.equal(value.eligible_for_end, false)
}))

test('只读预览明确模型继承，Case变化后拒绝按旧摘要创建', () => withFixture(async fx => {
  const body = { parent_experiment_id: parent, parent_ref: `git:${fx.parentCommit}`, strategy: '保留完整结果并减少重复调用。', case_ids: ['U-ONE-001'] }
  const status = git(fx.root, ['status', '--porcelain'])
  const preview = success(await fx.handler('preview', body))
  assert.equal(preview.model_configuration, 'inherited_from_fixed_parent')
  assert.equal(preview.plan.model_change, null)
  assert.equal(git(fx.root, ['status', '--porcelain']), status)
  const evaluation = join(fx.root, 'agents/alpha/evaluation.md')
  write(evaluation, readFileSync(evaluation, 'utf8').replace('准确返回状态。', '准确返回状态和来源。'))
  const result = await fx.handler('create', { ...body, expected_preview_sha256: preview.preview_sha256 })
  assert.equal(result.ok, false); assert.equal(result.error.code, 'conflict')
}))

test('原生工具冻结的多Case参数可预览，归一化不修改调用方顺序', () => withFixture(async fx => {
  const evaluation = join(fx.root, 'agents/alpha/evaluation.md')
  write(evaluation, readFileSync(evaluation, 'utf8') + '\n#### U-TWO-001 查询摘要\n\n**用户输入**\n\n> 查询模拟资产摘要。\n\n**预期**\n\n准确返回摘要。\n')
  const chosen = Object.freeze(['U-TWO-001', 'U-ONE-001'])
  const body = Object.freeze({ parent_experiment_id: parent, parent_ref: `git:${fx.parentCommit}`, strategy: '保留两类任务输出并减少重复调用。', case_ids: chosen, critical_case_ids: chosen })
  const preview = success(await fx.handler('preview', body))
  assert.deepEqual(Object.keys(preview.plan.case_hashes), ['U-ONE-001', 'U-TWO-001'])
  assert.deepEqual(preview.plan.critical_case_ids, ['U-ONE-001', 'U-TWO-001'])
  assert.deepEqual(body.case_ids, ['U-TWO-001', 'U-ONE-001'])
}))

test('旧 Session 改装到新 Run 仍不能作为预冻结后的执行', () => withFixture(async fx => {
  const path = join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl')
  const rows = readFileSync(path, 'utf8').split('\n').map(JSON.parse)
  rows[0].event.createdAt = 1000
  write(path, rows.map(JSON.stringify).join('\n'))
  const value = success(await fx.handler('compare', fx.body))
  assert.ok(value.comparability.limits.some(item => item.includes('原始 Session 早于')))
  assert.equal(value.eligible_for_end, false)
}))

test('汇总工具列表为空也不能隐藏原始工具失败或缺失的tools文件', () => withFixture(async fx => {
  const path = join(fx.right.base, 'evidence/U-ONE-001/trace.jsonl')
  const rows = readFileSync(path, 'utf8').split('\n').map(JSON.parse)
  rows.find(row => row.event.type === 'tool/result').event.data.message.isError = true
  write(path, rows.map(JSON.stringify).join('\n'))
  rmSync(join(fx.right.base, 'evidence/U-ONE-001/tools.jsonl'))
  fx.right.view.cases[0].tool_calls = []
  const value = success(await fx.handler('compare', fx.body))
  assert.ok(value.comparability.limits.some(item => item.includes('tools.jsonl 原始证据缺失')))
  assert.ok(value.comparability.limits.some(item => item.includes('原始工具回执失败')))
  assert.equal(value.eligible_for_end, false)
}))

test('response原始字节变化即使汇总没变也使确认摘要失效', () => withFixture(async fx => {
  const compared = success(await fx.handler('compare', fx.body))
  const path = join(fx.right.base, 'evidence/U-ONE-001/response.json')
  write(path, readFileSync(path, 'utf8') + '\n')
  const result = await fx.handler('confirm', { ...fx.body, decision: 'end', human_confirmed: true, comparison_sha256: compared.comparison_sha256, reason: '旧页面确认' })
  assert.equal(result.ok, false); assert.equal(result.error.code, 'conflict')
}))

test('比较过程中Candidate更改并提交，末端仍拒绝把旧Run用于新Candidate', () => withFixture(async fx => {
  const compared = success(await fx.handler('compare', fx.body))
  fx.setReadHook(id => {
    if (id !== variantRun) return
    write(join(fx.path(variant), 'candidate/AGENTS.md'), '比较期间修改的新资产。')
    git(fx.root, ['add', `evolution/experiments/${variant}/candidate`]); git(fx.root, ['commit', '-m', 'concurrent candidate update'])
  })
  const result = await fx.handler('confirm', { ...fx.body, decision: 'end', human_confirmed: true, comparison_sha256: compared.comparison_sha256, reason: '旧页面确认' })
  assert.equal(result.ok, false); assert.equal(result.error.code, 'conflict')
  assert.equal(load(readFileSync(join(fx.path(variant), 'change.yaml'), 'utf8')).variant_kind, 'exploratory')
}))

test('轨迹按模型响应统计，配置头不增调用，重试/缺采集完整性不伪造费用', () => {
  const rows = trace(2)
  rows.push({ session_log: 'root', event: { type: 'request/header', data: {} } })
  assert.equal(computeTraceMetrics(rows, true).values.model_calls, 2)
  assert.equal(computeTraceMetrics(rows, false).values.model_calls, null)
  rows.push({ session_log: 'root', event: { type: 'assistant/attempt', data: { stream: [] } } })
  assert.equal(computeTraceMetrics(rows, true).values.model_calls, null)
  assert.equal(computeTraceMetrics(rows, true).values.total_tokens, null)
})

test.after(() => rmSync(buildRoot, { recursive: true, force: true }))

test('source公开合同列出当前生成工作流全部文件并按目录SHA读取，context保留目录且不写资产', () => withFixture(async fx => {
  const directory = 'dsh/managed/compute-workflow', base = join(fx.root, `evolution/experiments/${variant}`), changeFile = join(base, 'change.yaml')
  const change = load(readFileSync(changeFile, 'utf8'))
  change.compute_variant.generation = { mode: 'langgraph-aot', entry_path: `${directory}/index.ts`, source_run_ids: [parentRun] }
  write(changeFile, dump(change))
  for (const name of ['index', 'context', 'integration']) write(join(base, `candidate/${directory}/${name}.ts`), `export const name=${JSON.stringify(name)}`)
  write(join(base, `candidate/${directory}/index.mjs`), 'export const compiled=true')
  const before = readFileSync(changeFile, 'utf8')
  const catalog = success(await fx.handler('source', { experiment_id: variant }))
  assert.equal(catalog.files.length, 4); assert.equal(catalog.files[0].entry, true)
  assert.deepEqual(success(await fx.handler('context', { experiment_id: variant })).generated_files, catalog)
  for (const file of catalog.files) {
    const value = success(await fx.handler('source', { experiment_id: variant, path: file.path, expected_sha256: file.sha256 }))
    assert.equal(hash(value.content), file.sha256); assert.equal(value.complete, true)
  }
  assert.equal((await fx.handler('source', { experiment_id: variant, path: 'AGENTS.md', expected_sha256: 'b'.repeat(64) })).ok, false)
  assert.equal(readFileSync(changeFile, 'utf8'), before)
}))
