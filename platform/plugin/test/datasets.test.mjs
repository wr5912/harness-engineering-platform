import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { normalizeDecisionModelSubmission } from '../src/evaluation/decision-dataset-contract.ts'

const repo = new URL('../../../', import.meta.url).pathname
process.env.HARNESS_PROGRAM_ROOT = repo
const buildRoot = mkdtempSync(join(tmpdir(), 'decision-dataset-build-'))
await build({ entryPoints: [new URL('../src/evaluation/datasets.ts', import.meta.url).pathname], outfile: join(buildRoot, 'datasets.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createDecisionDatasetHandler, validateDecisionQuestion } = await import(`file://${join(buildRoot, 'datasets.mjs')}`)
const runId = 'run-11111111-1111-4111-8111-111111111111'
const runId2 = 'run-22222222-2222-4222-8222-222222222222'
const owner = 'session-dataset-owner'
const secret = 'sk-' + 'fixturedecisiontoken123456789'
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function envelope(type, data, seq, log = 'session.v4.jsonl') { return { session_log: log, event: { type, seq, time: 1700000000000 + seq, data } } }
function traceEvents(user = `查询测试资产的巡检状态。 Authorization: Bearer ${secret}`) {
  const messages = [{ role: 'system', content: '仅查询基本巡检数据。' }, { role: 'user', content: user }]
  return [
    envelope('session', { id: 'session-fixture' }, 0),
    envelope('user/message', { message: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } }, 1),
    envelope('step/start', { id: 'step-1' }, 2),
    envelope('request/header', { header: { config: { provider: 'fixture', model: 'basic-model' }, messages, tools: [{ name: 'get_asset_status', description: '读取基本测试资产状态' }, { name: 'get_inspection_status', description: '读取基本巡检状态' }] } }, 3),
    envelope('tool/call', { callId: 'call-a', name: 'get_asset_status', arguments: { asset_id: 'test-asset', api_key: secret } }, 4),
    envelope('tool/result', { message: { source: { kind: 'tool', callId: 'call-a' }, content: [{ type: 'text', text: 'FUTURE_RESULT_A' }] } }, 5),
    envelope('tool/call', { callId: 'call-b', name: 'get_inspection_status', arguments: { asset_id: 'test-asset' } }, 6),
    envelope('tool/result', { message: { source: { kind: 'tool', callId: 'call-b' }, content: [{ type: 'text', text: 'FUTURE_RESULT_B' }] } }, 7),
  ]
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'decision-datasets-'))
  write(join(root, '.agents/skills/decision-sample-extraction/SKILL.md'), '---\nname: decision-sample-extraction\n---\n\n从当前轨迹提取候选，保留人工复核。\n')
  write(join(root, 'AGENTS.md'), '平台管理助手，使用数据侧抽取方法。\n')
  write(join(root, 'docs/harness-research/decision-samples.md'), '保持决策前材料，逐题复核，不能评价不可见答复。\n')
  const base = id => `evolution/experiments/EXP-alpha-001-r0123456789ab/runs/${id}`
  const path = `${base(runId)}/evidence/U-BASIC-001/trace.jsonl`
  const raw = traceEvents().map(value => JSON.stringify(value)).join('\n') + '\n'
  function createRun(id, trace = raw) {
    write(join(root, base(id), 'run.yaml'), `run_id: ${id}\nagent_id: alpha\nstatus: completed\n`)
    write(join(root, base(id), 'inputs.lock.json'), JSON.stringify({ evaluation_cases: [{ case_id: 'U-BASIC-001', inputs: ['查询基本资产状态'], expected_behavior: '展示基本状态。' }] }))
    write(join(root, base(id), 'evidence/U-BASIC-001/checks.json'), JSON.stringify({ trace_available: true }))
    write(join(root, base(id), 'evidence/U-BASIC-001/trace.jsonl'), trace)
  }
  createRun(runId)
  return { root, path, raw, handle: createDecisionDatasetHandler(root), createRun, base }
}
async function withFixture(run) { const fx = fixture(); try { await run(fx) } finally { await rm(fx.root, { recursive: true, force: true }) } }
async function source(fx, extra = {}) { return fx.handle('datasets/source', { run_id: runId, path: fx.path, ...extra }) }
const question = (changes = {}) => ({ type: 'choice', instructions: '根据当前输入，下一步应使用哪种只读查询？', criteria: { get_asset_status: '查询基本资产状态', get_inspection_status: '查询基本巡检状态' }, ...changes })
const target = (changes = {}) => ({ label: 'get_asset_status', basis: '根据用户输入提出候选，仍需人工复核。', ...changes })
function draft(src, changes = {}) { return { decision_id: src.decisions[0].decision_id, action_name: src.decisions[0].observed_action.name, workflow: '资产巡检', task: { id: 'inspection-read', semantics: 'recommended_decision' }, questions: { route: question() }, targets: { route: target() }, ...changes } }
async function preview(fx, src, samples, changes = {}) {
  return fx.handle('datasets/preview', { run_id: src.run_id, path: src.path, source_sha256: src.source_sha256, samples: samples ?? [draft(src)], assistant_session_id: owner, assistant_model: { provider: 'fixture', model: 'basic-model' }, ...changes })
}
async function apply(fx, value, session = owner) { return fx.handle('datasets/apply', { preview_id: value.preview_id, assistant_session_id: session }) }
function updatePayload(saved, record = saved.dataset.records[0], changes = {}) {
  return { dataset_id: saved.dataset.id, expected_sha256: saved.sha256, record_id: record._meta.id, workflow: record.workflow, task: record.task, questions: record.questions, targets: Object.fromEntries(Object.entries(record.targets).map(([key, value]) => [key, { ...value, status: 'reviewed', decision_time_reviewed: true }])), group_id: record._meta.group_id, split: 'train', ...changes }
}
const save = async fx => apply(fx, await preview(fx, await source(fx)))
// Handler 单测的受信任注入夹具；原生会话到证明的核对由 decision-review-input.test 独立覆盖。
function inputEvidence(saved, sessionId, record = saved.dataset.records[0]) {
  return { schema_version: 1, session_id: sessionId, dataset_id: saved.dataset.id, record_id: record._meta.id,
    run_id: saved.dataset.run_id, path: saved.dataset.path, trace_sha256: saved.dataset.source_sha256,
    source_bundle_sha256: saved.dataset.source_bundle.sha256, state_sha256: createHash('sha256').update(JSON.stringify(record.state)).digest('hex'),
    read_method: 'datasets/read', receipt_refs: [{ call_id: 'synthetic-read', call_seq: 2, result_seq: 3 }] }
}
const reviewed = async (fx, value, changes = {}) => fx.handle('datasets/update', updatePayload(value, undefined, changes))
const exported = (fx, dataset, mode = 'training') => fx.handle('datasets/export', { dataset_id: dataset.id, mode })

test('Skill 注入来源进入样本输入，同源任务分组不随 Skill 目录变化', () => withFixture(async fx => {
  async function extract(task, catalog) {
    const rows = traceEvents(task)
    rows[3].event.data.header.messages.unshift({ role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: catalog })
    fx.createRun(runId, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    return (await preview(fx, await source(fx))).records[0]
  }
  const first = await extract('巡检任务甲', '目录版本一')
  const changedSkill = await extract('巡检任务甲', '目录版本二')
  const changedTask = await extract('巡检任务乙', '目录版本一')
  assert.equal(first.state.messages[0].source.kind, 'skill-catalog')
  assert.equal(first._meta.source_group_id, changedSkill._meta.source_group_id)
  assert.notEqual(first._meta.source_group_id, changedTask._meta.source_group_id)
  assert.notEqual(first._meta.content_sha256, changedSkill._meta.content_sha256)
}))

// 从真实 JSONL 与文件夹来源进入，避免仅断言字符串或模拟保存后的资格结果。
test('v2完整闭环：输入与targets分离，多命名题逐题复核后只导出合格题子集', () => withFixture(async fx => {
  const listing = await fx.handle('datasets/source', { run_id: runId })
  assert.equal(listing.files[0].role, 'target'); assert.equal(listing.extraction_contract.schema_version, 2)
  const src = await source(fx)
  const proposed = await preview(fx, src, [draft(src, { questions: { route: question(), enough: { type: 'noul', instructions: '当前材料是否足以选择只读查询？' }, urgency: { type: 'score', instructions: '当前任务的处理紧迫程度？', criteria: ['常规处理', '优先处理'] } }, targets: { route: target(), enough: target({ label: true }), urgency: target({ label: 0 }) } })])
  assert.equal(proposed.question_count, 3); assert.equal(proposed.records[0].targets.route.status, 'suggested')
  assert.equal((await fx.handle('datasets/list', {})).datasets.length, 0)
  const saved = await apply(fx, proposed), record = saved.dataset.records[0]
  assert.equal(saved.dataset.schema_version, 2)
  assert.equal(record.questions.route.label, undefined); assert.equal(record.questions.route.src, undefined)
  assert.equal(record.targets.route.provenance.kind, 'model_suggestion'); assert.equal(record.targets.route.provenance.session_id, owner)
  assert.equal(record.targets.route.decision_time_reviewed, false)
  assert.equal(saved.eligibility.counts.training, 0); assert.equal(saved.eligibility.counts.candidates, 1)
  const read = await fx.handle('datasets/read', { dataset_id: saved.dataset.id }); assert.equal(read.sha256, saved.sha256)
  await assert.rejects(() => exported(fx, saved.dataset), /尚无符合/)
  assert.equal((await exported(fx, saved.dataset, 'candidates')).question_count, 3)
  const reviewedOnlyRoute = await fx.handle('datasets/update', updatePayload(saved, undefined, { targets: { ...record.targets, route: { ...record.targets.route, status: 'reviewed', decision_time_reviewed: true } } }))
  assert.deepEqual(reviewedOnlyRoute.eligibility.records[0].eligible_questions, ['route'])
  const training = await exported(fx, saved.dataset), trained = JSON.parse(training.content)
  assert.equal(training.count, 1); assert.equal(training.question_count, 1); assert.equal(training.omitted_question_count, 2)
  assert.deepEqual(Object.keys(trained.questions), ['route']); assert.deepEqual(Object.keys(trained.targets), ['route'])
  assert.equal(trained.targets.route.provenance.kind, 'model_suggestion', '人工核对不伪造建议的原始来源')
  assert.match(trained._meta.extractor.skill_sha256, /^[0-9a-f]{64}$/)
  assert.equal(trained._meta.split, 'train')
}))

test('三题型软标签完整有限归一，label最大值允许平票；硬标签不自动补one-hot', () => withFixture(async fx => {
  const src = await source(fx)
  const proposed = await preview(fx, src, [draft(src, { questions: { route: question(), enough: { type: 'noul', instructions: '可选择查询吗？' }, urgency: { type: 'score', instructions: '紧迫程度？', criteria: ['低', '高'] } }, targets: { route: target({ probabilities: { get_asset_status: 0.5, get_inspection_status: 0.5 } }), enough: target({ label: false, probabilities: { false: 0.7, true: 0.3 } }), urgency: target({ label: 1, probabilities: { 0: 0.2, 1: 0.8 } }) } })])
  assert.equal(proposed.records[0].targets.route.provenance.calibration, 'uncalibrated')
  const saved = await apply(fx, proposed); await reviewed(fx, saved)
  assert.equal(JSON.parse((await exported(fx, saved.dataset)).content).targets.urgency.probabilities['1'], 0.8)
  const hard = await preview(fx, src, [draft(src, { questions: { route: question({ instructions: '另外一个只读查询决策？' }) } })])
  assert.equal(Object.hasOwn(hard.records[0].targets.route, 'probabilities'), false)
  for (const probabilities of [{ get_asset_status: 1 }, { get_asset_status: 0.8, get_inspection_status: 0.8 }, { get_asset_status: NaN, get_inspection_status: 1 }, { get_asset_status: Infinity, get_inspection_status: 0 }, { get_asset_status: -0.1, get_inspection_status: 1.1 }, { get_asset_status: 0.1, get_inspection_status: 0.9 }]) await assert.rejects(() => preview(fx, src, [draft(src, { targets: { route: target({ probabilities }) } })]), /probabilities|label/)
  for (const changes of [{ questions: {} }, { targets: { other: target() } }, { questions: { route: { ...question(), label: 'get_asset_status' } } }, { task: { id: 'x', semantics: 'gold' } }]) await assert.rejects(() => preview(fx, src, [draft(src, changes)]))
}))

test('三候选六位小数的舍入概率可保存，原始概率不被静默归一化', () => withFixture(async fx => {
  const src = await source(fx), probabilities = { a: 0.333333, b: 0.333333, c: 0.333333 }
  const saved = await apply(fx, await preview(fx, src, [draft(src, { questions: { route: question({ criteria: { a: '资产信息', b: '巡检信息', c: '补充资料' } }) }, targets: { route: target({ label: 'a', probabilities }) } })]))
  assert.deepEqual(saved.dataset.records[0].targets.route.probabilities, probabilities)
  await reviewed(fx, saved)
  assert.deepEqual(JSON.parse((await exported(fx, saved.dataset)).content).targets.route.probabilities, probabilities)
}))

test('观察动作与推荐语义明确区分，观察动作不能生成虚假的推荐标签或概率分布', () => withFixture(async fx => {
  const src = await source(fx), task = { id: 'actual-route', semantics: 'observed_action' }
  const saved = await apply(fx, await preview(fx, src, [draft(src, { task })]))
  assert.equal(saved.dataset.records[0].targets.route.provenance.kind, 'observed_action')
  assert.equal(saved.dataset.records[0].task.semantics, 'observed_action')
  await reviewed(fx, saved)
  assert.equal(JSON.parse((await exported(fx, saved.dataset)).content).targets.route.label, 'get_asset_status')
  for (const targets of [{ route: target({ label: 'get_inspection_status' }) }, { route: target({ probabilities: { get_asset_status: 1, get_inspection_status: 0 } }) }]) await assert.rejects(() => preview(fx, src, [draft(src, { task, targets })]), /observed_action/)
}))

test('模型不得伪造人工/教师来源、复核状态或不可见输入，动作定位精确', () => withFixture(async fx => {
  const src = await source(fx)
  for (const provenance of [{ kind: 'teacher_distribution', sample_count: 10 }, { kind: 'human_annotation' }]) await assert.rejects(() => preview(fx, src, [draft(src, { targets: { route: target({ provenance }) } })]), /不得自报/)
  await assert.rejects(() => preview(fx, src, [draft(src, { targets: { route: target({ status: 'reviewed', decision_time_reviewed: true }) } })]), /不得自报/)
  await assert.rejects(() => preview(fx, src, [draft(src, { state: { injected: 'FUTURE_RESULT_A' } })]), /不能伪造 state/)
  for (const action_name of [undefined, 'respond', 'get_inspection_status']) await assert.rejects(() => preview(fx, src, [draft(src, { action_name })]), /action_name.*实际动作/)
  await assert.rejects(() => preview(fx, src, [draft(src, { decision_id: 'invented' })]), /不存在|材料不足/)
}))

test('人工改题/改标签/改依据撤销该题复核，再次复核保留原始来源', () => withFixture(async fx => {
  let saved = await reviewed(fx, await save(fx)), original = saved.dataset.records[0].targets.route.provenance
  const targetBefore = saved.dataset.records[0].targets.route
  const edited = await fx.handle('datasets/update', updatePayload(saved, undefined, { targets: { route: { ...targetBefore, label: 'get_inspection_status', basis: '人工核对巡检范围后改标。' } } }))
  assert.equal(edited.dataset.records[0].targets.route.status, 'suggested')
  assert.equal(edited.dataset.records[0].targets.route.decision_time_reviewed, false)
  assert.equal(edited.dataset.records[0].targets.route.provenance.kind, 'human_annotation')
  assert.deepEqual(edited.dataset.records[0].targets.route.provenance.origin, original)
  await assert.rejects(() => exported(fx, saved.dataset), /尚无符合/)
  saved = await reviewed(fx, edited)
  assert.equal(JSON.parse((await exported(fx, saved.dataset)).content).targets.route.label, 'get_inspection_status')
  const changedQuestion = await fx.handle('datasets/update', updatePayload(saved, undefined, { questions: { route: question({ instructions: '人工修改后应该选择哪个查询？' }) } }))
  assert.equal(changedQuestion.dataset.records[0].targets.route.status, 'suggested')
  assert.equal(changedQuestion.dataset.records[0].targets.route.reviewed_at, null)
}))

test('未完成输入可答性核对不能复核，AI不能在update伪造来源', () => withFixture(async fx => {
  const saved = await save(fx), targetBefore = saved.dataset.records[0].targets.route
  for (const decision_time_reviewed of [undefined, false, 'true']) await assert.rejects(() => fx.handle('datasets/update', updatePayload(saved, undefined, { targets: { route: { ...targetBefore, status: 'reviewed', decision_time_reviewed } } })), /核对|逐题复核/)
  await assert.rejects(() => fx.handle('datasets/update', updatePayload(saved, undefined, { targets: { route: { ...targetBefore, provenance: { kind: 'human_annotation' }, status: 'reviewed', decision_time_reviewed: true } } })), /来源/)
}))

test('并行工具共享前缀；当前动作、未来结果与凭据不会混进state；原始Run字节不改', () => withFixture(async fx => {
  const src = await source(fx)
  assert.equal(src.decisions.length, 2); assert.deepEqual(src.decisions[0].state, src.decisions[1].state)
  for (const text of ['FUTURE_RESULT_A', 'FUTURE_RESULT_B', 'call-a', secret]) assert.equal(JSON.stringify(src.decisions[0].state).includes(text), false)
  const saved = await save(fx); assert.equal(JSON.stringify(saved).includes(secret), false)
  assert.equal(readFileSync(join(fx.root, fx.path), 'utf8'), fx.raw)
}))

test('角色、采集状态、Run身份和Case归属不足不能预览', () => withFixture(async fx => {
  const judge = `${fx.base(runId)}/evidence/U-BASIC-001/judge-trace.jsonl`
  write(join(fx.root, judge), fx.raw); write(join(fx.root, fx.base(runId), 'evidence/U-BASIC-001/judge.json'), '{}')
  assert.ok((await source(fx, { path: judge })).decisions.every(item => !item.eligible))
  await assert.rejects(async () => preview(fx, await source(fx, { path: judge })), /来源不足/)
  const mutations = [
    ['inputs.lock.json', JSON.stringify({ evaluation_cases: [{ case_id: 'another-case' }] })],
    ['evidence/U-BASIC-001/checks.json', JSON.stringify({ trace_available: false })],
    ['run.yaml', `run_id: ${runId2}\nstatus: completed\n`],
  ]
  for (const [path, value] of mutations) {
    fx.createRun(runId); write(join(fx.root, fx.base(runId), path), value)
    if (path === 'run.yaml') { await assert.rejects(() => source(fx), /Run.*身份不一致/); continue }
    const src = await source(fx); assert.ok(src.decisions.every(item => !item.eligible))
    await assert.rejects(() => preview(fx, src), /来源不足/)
  }
  fx.createRun(runId, 'invalid-json-line\n' + fx.raw)
  await assert.rejects(async () => preview(fx, await source(fx)), /不存在|材料不足/)
}))

test('预览后变更任一来源依赖，即使trace不变也拒绝apply且无半个数据集', async () => {
  for (const path of ['run.yaml', 'inputs.lock.json', 'evidence/U-BASIC-001/checks.json', 'evidence/U-BASIC-001/judge.json']) await withFixture(async fx => {
    const proposed = await preview(fx, await source(fx))
    const absolute = join(fx.root, fx.base(runId), path)
    write(absolute, path.endsWith('yaml') ? `run_id: ${runId}\nstatus: completed\nchanged: true\n` : path.endsWith('inputs.lock.json') ? JSON.stringify({ evaluation_cases: [{ case_id: 'U-BASIC-001' }], changed: true }) : JSON.stringify({ trace_available: true, changed: true }))
    await assert.rejects(() => apply(fx, proposed), /来源集合发生变化/)
    assert.equal((await fx.handle('datasets/list', {})).datasets.length, 0)
  })
})

test('Harness技能、AGENTS和直接方法来源在确认前固定，历史保存后不要求当前方法永久不变', async () => {
  for (const path of ['AGENTS.md', '.agents/skills/decision-sample-extraction/SKILL.md', 'docs/harness-research/decision-samples.md']) await withFixture(async fx => {
    const proposed = await preview(fx, await source(fx))
    write(join(fx.root, path), '修改后的方法。\n')
    await assert.rejects(() => apply(fx, proposed), /Harness 来源发生变化/)
    const saved = await apply(fx, await preview(fx, await source(fx)))
    write(join(fx.root, path), '后续方法改进。\n')
    const confirmed = await reviewed(fx, saved)
    assert.equal(confirmed.eligibility.counts.training, 1)
    assert.equal((await exported(fx, saved.dataset)).count, 1)
  })
  await withFixture(async fx => {
    await rm(join(fx.root, 'docs/harness-research/decision-samples.md'))
    const proposed = await preview(fx, await source(fx))
    write(join(fx.root, 'docs/harness-research/decision-samples.md'), '新建方法。\n')
    await assert.rejects(() => apply(fx, proposed), /Harness 来源发生变化/)
  })
})

test('保存后来源失效/伪造state/来源定位损坏，read说明阻塞，review与合格导出均拒绝', async () => {
  for (const mutate of [
    (fx, saved) => write(join(fx.root, fx.base(runId), 'inputs.lock.json'), '{"evaluation_cases":[]}'),
    (fx, saved) => write(join(fx.root, fx.base(runId), 'evidence/U-BASIC-001/checks.json'), '{"trace_available":false}'),
    (fx, saved) => { saved.dataset.records[0].state.messages.push({ role: 'assistant', content: 'FUTURE_RESULT_A' }); write(join(fx.root, saved.file), JSON.stringify(saved.dataset)) },
    (fx, saved) => { saved.dataset.records[0].state = null; write(join(fx.root, saved.file), JSON.stringify(saved.dataset)) },
    (fx, saved) => { saved.dataset.records[0]._meta.source_group_id = 'forged-independent'; write(join(fx.root, saved.file), JSON.stringify(saved.dataset)) },
    (fx, saved) => { saved.dataset.records[0]._meta.observed_action.name = 'invented'; write(join(fx.root, saved.file), JSON.stringify(saved.dataset)) },
  ]) await withFixture(async fx => {
    const saved = await reviewed(fx, await save(fx)); mutate(fx, saved)
    const current = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
    assert.equal(current.eligibility.counts.training, 0)
    assert.ok(current.eligibility.records[0].reasons.length)
    await assert.rejects(() => fx.handle('datasets/update', updatePayload(current)), /来源|state|定位/)
    await assert.rejects(() => exported(fx, saved.dataset), /尚无符合/)
    assert.equal((await exported(fx, saved.dataset, 'candidates')).count, 1)
  })
})

test('同源改组不能绕过跨批次留出，source_group_id与关联历史不可经API改写', async () => {
  for (const split of ['development', 'calibration', 'test']) await withFixture(async fx => {
    const src = await source(fx), first = await save(fx)
    const second = await apply(fx, await preview(fx, src, [draft(src, { decision_id: src.decisions[1].decision_id, action_name: src.decisions[1].observed_action.name, questions: { another: question({ instructions: '是否需要额外查询巡检记录？' }) }, targets: { another: target() } })]))
    await reviewed(fx, first, { split })
    const unassigned = await reviewed(fx, second, { split: 'unassigned', group_id: 'renamed-task', source_group_id: 'forged', group_history: [] })
    assert.equal(unassigned.dataset.records[0]._meta.source_group_id, first.dataset.records[0]._meta.source_group_id)
    assert.ok(unassigned.dataset.records[0]._meta.group_history.includes(first.dataset.records[0]._meta.group_id))
    await assert.rejects(() => reviewed(fx, unassigned, { split: 'train', group_id: 'another-independent-name' }), /同一任务分组|人工关联组/)
    await assert.rejects(() => exported(fx, second.dataset), /尚无符合/)
    const heldOut = await exported(fx, first.dataset, split); assert.equal(heldOut.count, 1)
    assert.equal(JSON.parse(heldOut.content)._meta.split, split)
  })
})

test('人工关联分组改名不会擦除关联，跨不同来源任务也按传递关系保留隔离', () => withFixture(async fx => {
  const first = await save(fx)
  fx.createRun(runId2, traceEvents('一个完全不同的资产任务').map(value => JSON.stringify(value)).join('\n') + '\n')
  const src2 = await source(fx, { run_id: runId2, path: `${fx.base(runId2)}/evidence/U-BASIC-001/trace.jsonl` })
  const second = await apply(fx, await preview(fx, src2))
  const mergedFirst = await reviewed(fx, first, { group_id: 'related-industry-task', split: 'test' })
  const mergedSecond = await reviewed(fx, second, { group_id: 'related-industry-task', split: 'unassigned' })
  const renamed = await reviewed(fx, mergedSecond, { group_id: 'new-visible-name', split: 'unassigned' })
  assert.ok(renamed.dataset.records[0]._meta.group_history.includes('related-industry-task'))
  await assert.rejects(() => reviewed(fx, renamed, { group_id: 'yet-another-name', split: 'train' }), /人工关联组/)
  assert.equal((await exported(fx, mergedFirst.dataset, 'test')).count, 1)
}))

test('unassigned不进入任何合格导出，显式train与留出用途分别下载', () => withFixture(async fx => {
  let saved = await reviewed(fx, await save(fx), { split: 'unassigned' })
  for (const mode of ['training', 'development', 'calibration', 'test']) await assert.rejects(() => exported(fx, saved.dataset, mode), /尚无符合/)
  saved = await reviewed(fx, saved, { split: 'development' })
  assert.equal(saved.eligibility.counts.development, 1); assert.equal(saved.eligibility.counts.training, 0)
  assert.equal((await exported(fx, saved.dataset, 'development')).count, 1)
  await assert.rejects(() => exported(fx, saved.dataset), /尚无符合/)
}))

test('旧reviewed批次只读、候选下载保留事实；重新抽取创建v2而不静默升级旧资产', () => withFixture(async fx => {
  const saved = await save(fx), legacy = structuredClone(saved.dataset), record = legacy.records[0]
  delete legacy.schema_version; delete legacy.source_bundle
  record.questions = { decision: { ...question(), label: 'get_asset_status', src: 'old-source' } }; delete record.targets
  record._meta.label_status = 'reviewed'; record._meta.decision_time_reviewed = true; record._meta.split = 'train'
  write(join(fx.root, saved.file), JSON.stringify(legacy))
  const current = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
  assert.equal(current.eligibility.records[0].legacy, true); assert.equal(current.eligibility.counts.training, 0)
  assert.equal((await exported(fx, legacy, 'candidates')).count, 1)
  await assert.rejects(() => fx.handle('datasets/update', { dataset_id: legacy.id, expected_sha256: current.sha256, record_id: record._meta.id }), /旧格式.*只读/)
  await assert.rejects(() => exported(fx, legacy), /旧格式只读候选/)
  const reextracted = await save(fx); assert.equal(reextracted.dataset.schema_version, 2); assert.notEqual(reextracted.dataset.id, legacy.id)
  assert.equal(readFileSync(join(fx.root, saved.file), 'utf8'), JSON.stringify(legacy))
}))

test('导出来源核对期间撤销复核或新增跨批次留出，不能使用过期资格', () => withFixture(async fx => {
  const saved = await reviewed(fx, await save(fx))
  const pending = exported(fx, saved.dataset)
  const revoked = structuredClone(saved.dataset)
  revoked.records[0].targets.route.status = 'suggested'
  revoked.records[0].targets.route.decision_time_reviewed = false
  write(join(fx.root, saved.file), JSON.stringify(revoked))
  await assert.rejects(() => pending, /导出核对期间发生变化/)
  write(join(fx.root, saved.file), JSON.stringify(saved.dataset))
  const pendingGroup = exported(fx, saved.dataset)
  const heldOut = structuredClone(saved.dataset)
  heldOut.id = 'decision-dataset-33333333-3333-4333-8333-333333333333'
  heldOut.records[0]._meta.split = 'test'
  write(join(fx.root, `evolution/datasets/${heldOut.id}.json`), JSON.stringify(heldOut))
  await assert.rejects(() => pendingGroup, /导出核对期间发生用途冲突/)
}))

test(' owner、轨迹摘要与并发乐观锁保持隔离；重复不覆盖人工内容', () => withFixture(async fx => {
  const src = await source(fx), first = await preview(fx, src), second = await preview(fx, src)
  await assert.rejects(() => apply(fx, first, 'different-session'), /预览已失效/)
  const results = await Promise.allSettled([apply(fx, first), apply(fx, second)])
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1)
  const saved = results.find(item => item.status === 'fulfilled').value
  const requests = await Promise.allSettled([reviewed(fx, saved), reviewed(fx, saved)])
  assert.equal(requests.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(requests.filter(item => item.status === 'rejected').length, 1)
  const again = await preview(fx, src); assert.equal(again.count, 0)
  const changed = await preview(fx, src, [draft(src, { questions: { route: question({ instructions: '另一个问题应当如何决定？' }) } })])
  writeFileSync(join(fx.root, fx.path), fx.raw + JSON.stringify(envelope('turn/end', { reason: 'completed' }, 8)) + '\n')
  await assert.rejects(() => apply(fx, changed), /轨迹.*变化/)
}))

test('跨Run相同state与问题去重，人工修改后的题目也不能重复抽取', () => withFixture(async fx => {
  const saved = await save(fx)
  fx.createRun(runId2)
  const src = await source(fx, { run_id: runId2, path: `${fx.base(runId2)}/evidence/U-BASIC-001/trace.jsonl` })
  assert.equal((await preview(fx, src)).count, 0)
  const questions = { route: question({ instructions: '人工修订后的任务选择？' }) }
  const edited = await fx.handle('datasets/update', updatePayload(saved, undefined, { questions }))
  assert.equal((await preview(fx, src, [draft(src, { questions })])).count, 0)
  assert.equal(edited.dataset.records[0].questions.route.instructions, questions.route.instructions)
}))

function normalizedContent(value) {
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (Array.isArray(value)) return value.map(normalizedContent)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizedContent(value[key])]))
  return value
}
function recordHash(record) { return createHash('sha256').update(JSON.stringify(normalizedContent([record.state, record.task.semantics, record.questions]))).digest('hex') }

test('完整envelope不可省略模型/Session/技能身份，伪造空来源不能借undefined相等变成合格样本', async () => {
  await withFixture(async fx => {
    const src = await source(fx)
    for (const assistant_model of [undefined, null, {}, { provider: 'fixture' }, { provider: '', model: 'x' }]) await assert.rejects(() => preview(fx, src, undefined, { assistant_model }), /JSON 对象|实际模型/)
  })
  for (const mutate of [
    dataset => { dataset.extractor = {}; dataset.records[0].targets.route.provenance = { kind: 'model_suggestion', calibration: 'uncalibrated' } },
    dataset => { delete dataset.extractor.session_id; delete dataset.records[0].targets.route.provenance.session_id },
    dataset => { dataset.extractor.model = {}; dataset.records[0].targets.route.provenance.model = {} },
    dataset => { dataset.records[0]._meta.id = 'fake-id' },
    dataset => { dataset.records[0]._meta.content_sha256 = 'a'.repeat(64) },
    dataset => { dataset.records[0].targets.route.reviewed_at = null },
  ]) await withFixture(async fx => {
    const saved = await reviewed(fx, await save(fx)); mutate(saved.dataset)
    write(join(fx.root, saved.file), JSON.stringify(saved.dataset))
    const current = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
    assert.equal(current.eligibility.counts.training, 0)
    assert.ok(current.eligibility.blocked.length)
    await assert.rejects(() => exported(fx, saved.dataset), /尚无符合/)
  })
})

test('语义从观察动作翻成推荐决策后不能继续持观察来源通过验证', () => withFixture(async fx => {
  const src = await source(fx), saved = await reviewed(fx, await apply(fx, await preview(fx, src, [draft(src, { task: { id: 'observed', semantics: 'observed_action' } })])))
  saved.dataset.records[0].task.semantics = 'recommended_decision'
  saved.dataset.records[0]._meta.content_sha256 = recordHash(saved.dataset.records[0])
  write(join(fx.root, saved.file), JSON.stringify(saved.dataset))
  const current = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
  assert.equal(current.eligibility.counts.training, 0)
  assert.match(current.eligibility.blocked[0].reasons.join(' '), /监督语义或标签来源/)
  await assert.rejects(() => exported(fx, saved.dataset), /监督语义或标签来源/)
}))

test('部分题导出重算投影摘要，同时保留完整来源样本摘要和身份', () => withFixture(async fx => {
  const src = await source(fx), saved = await apply(fx, await preview(fx, src, [draft(src, { questions: { route: question(), another: question({ instructions: '另外一个判断题？' }) }, targets: { route: target(), another: target() } })]))
  const record = saved.dataset.records[0]
  await fx.handle('datasets/update', updatePayload(saved, undefined, { targets: { ...record.targets, route: { ...record.targets.route, status: 'reviewed', decision_time_reviewed: true } } }))
  const output = JSON.parse((await exported(fx, saved.dataset)).content)
  assert.equal(output._meta.id, record._meta.id)
  assert.equal(output._meta.source_record_content_sha256, record._meta.content_sha256)
  assert.notEqual(output._meta.content_sha256, output._meta.source_record_content_sha256)
  assert.equal(output._meta.content_sha256, recordHash(output))
  const original = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
  assert.equal(original.dataset.records[0]._meta.content_sha256, record._meta.content_sha256)
  assert.deepEqual(Object.keys(original.dataset.records[0].questions), ['route', 'another'])
}))

test('null目标作为记录级阻塞可读且全列表不崩溃，候选仍可下载定位问题', async () => {
  for (const value of [null, { route: null }]) await withFixture(async fx => {
    const saved = await reviewed(fx, await save(fx))
    saved.dataset.records[0].targets = value
    write(join(fx.root, saved.file), JSON.stringify(saved.dataset))
    const read = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
    assert.equal(read.eligibility.counts.training, 0); assert.equal(read.eligibility.counts.candidates, 1)
    assert.ok(read.eligibility.blocked.length)
    const list = await fx.handle('datasets/list', {})
    assert.equal(list.datasets.length, 1); assert.equal(list.datasets[0].eligibility.counts.training, 0)
    await assert.rejects(() => exported(fx, saved.dataset), /尚无符合/)
    assert.equal((await exported(fx, saved.dataset, 'candidates')).count, 1)
  })
})

test('旧题型校验兼容入口拒绝非法标签、空候选和重复等级', () => {
  const legacy = changes => ({ ...question(), label: 'get_asset_status', src: 'fixture', ...changes })
  for (const value of [legacy({ label: 'missing' }), legacy({ criteria: { only: '唯一候选' }, label: 'only' }), legacy({ criteria: { a: '重复', b: '重复' }, label: 'a' }), legacy({ type: 'noul', label: 'true', criteria: undefined }), legacy({ type: 'score', criteria: ['低', '高'], label: 2 }), legacy({ type: 'score', criteria: ['低', '低'], label: 0 }), legacy({ instructions: '' })]) assert.throws(() => validateDecisionQuestion(value))
  assert.equal(validateDecisionQuestion(legacy({ type: 'noul', criteria: { false: '不继续', true: '继续' }, label: true })).label, true)
  assert.equal(validateDecisionQuestion(legacy({ type: 'score', criteria: ['低', '高'], label: 0 })).label, 0)
})


async function withFsHook(method, hook, action) {
  const original = fs[method]
  fs[method] = (...args) => hook(original, ...args)
  syncBuiltinESMExports()
  try { return await action() }
  finally { fs[method] = original; syncBuiltinESMExports() }
}

test('apply提交后取消仍返回真实成功回执，提交前取消不写入且预览仍可重试', async () => {
  await withFixture(async fx => {
    const proposed = await preview(fx, await source(fx)), controller = new AbortController(), file = join(fx.root, proposed.file)
    const saved = await withFsHook('writeFileSync', (original, ...args) => {
      const result = original(...args)
      if (args[0] === file) controller.abort(new Error('提交后取消'))
      return result
    }, () => fx.handle('datasets/apply', { preview_id: proposed.preview_id, assistant_session_id: owner }, controller.signal))
    assert.equal(controller.signal.aborted, true)
    assert.equal(saved.dataset.schema_version, 2)
    assert.equal(saved.eligibility.counts.candidates, 1)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, saved.dataset.id)
    assert.equal((await fx.handle('datasets/read', { dataset_id: saved.dataset.id })).sha256, saved.sha256)
  })
  await withFixture(async fx => {
    const proposed = await preview(fx, await source(fx)), controller = new AbortController()
    const methodFile = join(fx.root, 'docs/harness-research/decision-samples.md')
    await assert.rejects(() => withFsHook('readFileSync', (original, ...args) => {
      const result = original(...args)
      if (args[0] === methodFile) controller.abort(new Error('提交前取消'))
      return result
    }, () => fx.handle('datasets/apply', { preview_id: proposed.preview_id, assistant_session_id: owner }, controller.signal)), /提交前取消/)
    assert.equal(controller.signal.aborted, true)
    assert.equal((await fx.handle('datasets/list', {})).datasets.length, 0)
    assert.equal((await apply(fx, proposed)).dataset.records.length, 1)
  })
})

test('update提交后取消仍回报已保存，最终乐观锁后提交前取消保持文件字节不变', async () => {
  await withFixture(async fx => {
    const saved = await save(fx), controller = new AbortController(), file = join(fx.root, saved.file)
    const changed = await withFsHook('renameSync', (original, ...args) => {
      const result = original(...args)
      if (args[1] === file) controller.abort(new Error('提交后取消'))
      return result
    }, () => fx.handle('datasets/update', updatePayload(saved), controller.signal))
    assert.equal(controller.signal.aborted, true)
    assert.equal(changed.dataset.records[0].targets.route.status, 'reviewed')
    assert.equal(changed.eligibility.counts.training, 1)
    const current = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
    assert.equal(current.sha256, changed.sha256); assert.notEqual(current.sha256, saved.sha256)
  })
  await withFixture(async fx => {
    const saved = await save(fx), controller = new AbortController(), file = join(fx.root, saved.file), before = readFileSync(file, 'utf8')
    let reads = 0
    await assert.rejects(() => withFsHook('readFileSync', (original, ...args) => {
      const result = original(...args)
      // 初始批次读取、全批次分组读取之后，第三次是最终乐观锁读取。
      if (args[0] === file && ++reads === 3) controller.abort(new Error('提交前取消'))
      return result
    }, () => fx.handle('datasets/update', updatePayload(saved), controller.signal)), /提交前取消/)
    assert.equal(controller.signal.aborted, true); assert.equal(reads, 3)
    assert.equal(readFileSync(file, 'utf8'), before)
    const current = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
    assert.equal(current.sha256, saved.sha256)
    assert.equal(current.dataset.records[0].targets.route.status, 'suggested')
  })
})


test('预览合同声明顶层参数与同path限制，skipped字符串原因确认后完整保存并回读', () => withFixture(async fx => {
  const src = await source(fx), contract = src.extraction_contract.preview
  assert.deepEqual(contract.required_fields, ['run_id', 'path', 'source_sha256', 'samples'])
  assert.match(contract.source_path, /同一条 path/)
  assert.equal(contract.skipped.type, 'string[]'); assert.equal(contract.skipped.max_items, 100); assert.equal(contract.skipped.max_item_length, 2000)
  const skipped = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 条来源缺少足够输入，保留跳过原因。`)
  const proposed = await preview(fx, src, undefined, { skipped })
  assert.deepEqual(proposed.skipped, skipped)
  const saved = await apply(fx, proposed), current = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
  assert.deepEqual(saved.dataset.skipped, skipped)
  assert.deepEqual(current.dataset.skipped, skipped)
  assert.deepEqual(JSON.parse(readFileSync(join(fx.root, saved.file), 'utf8')).skipped, skipped)
}))

test('skipped字典、对象数组、超量或无效原因均明确拒绝，不静默丢失或截断', () => withFixture(async fx => {
  const src = await source(fx)
  for (const skipped of [{ decision_1: '缺少输入' }, [{ decision_id: 'decision_1', reason: '缺少输入' }], Array.from({ length: 101 }, (_, index) => `跳过 ${index}`), [''], ['   '], [null], [3], ['x'.repeat(2001)], null]) {
    await assert.rejects(() => preview(fx, src, undefined, { skipped }), /skipped.*(?:数组|非空原因字符串)/)
  }
  assert.equal((await fx.handle('datasets/list', {})).datasets.length, 0)
  const proposed = await preview(fx, src)
  assert.deepEqual(proposed.skipped, [])
  assert.deepEqual((await apply(fx, proposed)).dataset.skipped, [])
}))

test('模型逐题传输复用公开v2来源、三题型和两种监督语义，保存仍待逐题复核', () => withFixture(async fx => {
  const src = await source(fx)
  const variants = [
    { semantics: 'recommended_decision', question: question(), target: target() },
    { semantics: 'recommended_decision', question: { type: 'noul', instructions: '可见材料是否包含资产标识？' }, target: target({ label: true, probabilities: { true: 0.8, false: 0.2 } }) },
    { semantics: 'recommended_decision', question: { type: 'score', instructions: '当前查询目标的明确程度？', criteria: ['不明确', '较明确', '明确'] }, target: target({ label: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } }) },
    { semantics: 'observed_action', question: question({ instructions: '该决策实际选择了哪个动作？' }), target: target() },
  ]
  for (const variant of variants) {
    const flat = { run_id: runId, path: src.path, source_sha256: src.source_sha256, decision_id: src.decisions[0].decision_id, action_name: src.decisions[0].observed_action.name,
      workflow: '基础资产核对', task: { id: 'inspection-read', semantics: variant.semantics }, question_name: 'decision', question: variant.question, target: variant.target }
    const input = normalizeDecisionModelSubmission(flat)
    assert.deepEqual(input.samples, [{ decision_id: flat.decision_id, action_name: flat.action_name, workflow: flat.workflow, task: flat.task, questions: { decision: variant.question }, targets: { decision: variant.target } }])
    assert.equal(Object.hasOwn(input, 'question_name'), false)
    const proposed = await fx.handle('datasets/preview', { ...input, assistant_session_id: owner, assistant_model: { provider: 'fixture', model: 'basic-model' } })
    const saved = await apply(fx, proposed), record = saved.dataset.records[0]
    assert.equal(record.targets.decision.status, 'suggested'); assert.equal(record.targets.decision.decision_time_reviewed, false)
    assert.equal(record._meta.split, 'unassigned'); assert.equal(saved.eligibility.counts.training, 0)
    assert.equal(record.task.semantics, variant.semantics)
    assert.equal(record.targets.decision.provenance.kind, variant.semantics === 'observed_action' ? 'observed_action' : 'model_suggestion')
    assert.equal(record.targets.decision.label, variant.target.label)
    assert.equal(record._meta.trace_sha256, src.source_sha256)
    assert.equal(JSON.stringify(record.state).includes('FUTURE_RESULT_A'), false)
  }
  const legacy = { run_id: runId, path: src.path, source_sha256: src.source_sha256, samples: [draft(src, { questions: { route: question({ instructions: '旧批量接口仍可保存新的题目吗？' }) } })] }
  assert.equal(normalizeDecisionModelSubmission(legacy), legacy)
  assert.equal((await fx.handle('datasets/preview', { ...legacy, assistant_session_id: owner, assistant_model: { provider: 'fixture', model: 'basic-model' } })).count, 1)
  const skipped = normalizeDecisionModelSubmission({ run_id: runId, path: src.path, source_sha256: src.source_sha256, skipped: ['其余决策没有足够材料，不抽取。'] })
  assert.deepEqual(skipped.samples, [])
  const empty = await fx.handle('datasets/preview', { ...skipped, assistant_session_id: owner, assistant_model: { provider: 'fixture', model: 'basic-model' } })
  assert.equal(empty.count, 0); assert.equal(empty.preview_id, undefined)
}))

test('逐题适配不修JSON或放宽来源与标签校验，错误输入不会生成预览或数据集', () => withFixture(async fx => {
  const src = await source(fx)
  const flat = { run_id: runId, path: src.path, source_sha256: src.source_sha256, decision_id: src.decisions[0].decision_id, action_name: src.decisions[0].observed_action.name,
    workflow: '基础资产核对', task: { id: 'inspection-read', semantics: 'recommended_decision' }, question_name: 'route', question: question(), target: target() }
  assert.throws(() => normalizeDecisionModelSubmission({ ...flat, samples: [] }), /不能混用/)
  const partial = { ...flat }; delete partial.question_name
  assert.throws(() => normalizeDecisionModelSubmission(partial), /缺少 question_name/)
  for (const change of [
    { source_sha256: '0'.repeat(64) }, { decision_id: 'not-a-real-decision' }, { action_name: 'respond' }, { question_name: '__proto__' },
    { question: { ...question(), criteria: { a: 1, b: 2 } } },
    { target: target({ probabilities: { get_asset_status: '0.8', get_inspection_status: '0.2' } }) },
    { target: target({ status: 'reviewed', decision_time_reviewed: true }) }, { target: target({ provenance: { kind: 'human_annotation' } }) },
    { task: { id: 'actual-action', semantics: 'observed_action' }, target: target({ label: 'get_inspection_status' }) },
  ]) await assert.rejects(() => fx.handle('datasets/preview', { ...normalizeDecisionModelSubmission({ ...flat, ...change }), assistant_session_id: owner, assistant_model: { provider: 'fixture', model: 'basic-model' } }))
  assert.equal((await fx.handle('datasets/list', {})).datasets.length, 0)
}))

test('可信child来源完整lineage只入监督元数据，与根任务同组；长path大前缀仍可分片保存', () => withFixture(async fx => {
  const caseId = `U-${'LONG'.repeat(50)}`, rootLog = 'session.v4.jsonl', childLog = 'descendants/child-session/session.v4.jsonl'
  const tracePath = `${fx.base(runId)}/evidence/${caseId}/trace.jsonl`, childTask = `核对已授权的子任务。${'x'.repeat(18000)}`
  const message = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const rootTask = '根任务用户原文，不应补入子任务输入。'
  const header = (log, meta) => ({ session_log: log, event: { type: 'session', seq: 0, ...meta } })
  const rows = [
    header(rootLog, { id: 'root-session', delegationDepth: 0, agentPreset: 'root-preset', createdAt: 100 }),
    envelope('user/message', message(rootTask), 1, rootLog), envelope('step/start', { turn: 1, step: 1 }, 2, rootLog),
    envelope('request/header', { header: { messages: [message(rootTask)], tools: [{ name: 'delegate_fault_analysis' }] } }, 3, rootLog),
    envelope('tool/call', { callId: 'delegate-call', name: 'delegate_fault_analysis', arguments: { prompt: '核对已授权的子任务。' } }, 4, rootLog),
    envelope('subagent/catalog', { version: 0, childId: 'child-session', childCreatedAt: 200, mode: 'continuable' }, 5, rootLog),
    envelope('tool/result', { message: { role: 'tool', toolCallId: 'delegate-call', source: { kind: 'tool', callId: 'delegate-call' }, content: [{ type: 'text', text: 'started subagent child-session' }] } }, 6, rootLog),
    header(childLog, { id: 'child-session', origin: 'subagent', parentSession: 'root-session', delegationDepth: 1, agentPreset: 'fault-preset', isSeeded: false, createdAt: 200 }),
    envelope('subagent/descriptor', { version: 3, provider: 'spawn', mode: 'continuable' }, 1, childLog),
    envelope('user/message', message(childTask), 2, childLog), envelope('step/start', { turn: 1, step: 1 }, 3, childLog),
    envelope('request/header', { header: { messages: [message(childTask)], tools: [{ name: 'get_asset_status' }] } }, 4, childLog),
    envelope('tool/call', { callId: 'child-read', name: 'get_asset_status', arguments: { asset_id: 'observed-asset' } }, 5, childLog),
    envelope('tool/result', { message: { role: 'tool', toolCallId: 'child-read', source: { kind: 'tool', callId: 'child-read' }, content: [{ type: 'text', text: '实际子查询结果' }] } }, 6, childLog),
  ]
  write(join(fx.root, fx.base(runId), 'inputs.lock.json'), JSON.stringify({ run_id: runId, evaluation_cases: [{ case_id: caseId }] }))
  write(join(fx.root, fx.base(runId), `evidence/${caseId}/checks.json`), JSON.stringify({ trace_available: true, session_id: 'root-session', root_session_log: rootLog, session_preset: 'root-preset' }))
  const raw = rows.map(JSON.stringify).join('\n') + '\n'; write(join(fx.root, tracePath), raw)
  const src = await source(fx, { path: tracePath })
  assert.ok(JSON.stringify(src).length <= 16000)
  const child = src.decisions.find(decision => decision.anchor.session_log === childLog)
  assert.equal(child.eligible, true); assert.equal(child.detail_required, true)
  assert.equal(child.lineage, undefined, 'descriptor不重复整份长lineage')
  assert.equal(child.lineage_required, true); assert.equal(child.actor_kind, 'delegated_task')
  let cursor = 0, text = ''
  do {
    const page = await source(fx, { ...child.read_input, cursor })
    assert.ok(JSON.stringify(page).length <= 16000)
    text += page.fragment; cursor = page.next_cursor
  } while (cursor !== null)
  const full = JSON.parse(text)
  assert.equal(full.lineage.actor_session_id, 'child-session')
  assert.equal(full.lineage.delegation.call_id, 'delegate-call')
  assert.equal(full.lineage.delegation.task_content_sha256, createHash('sha256').update(childTask).digest('hex'))
  assert.equal(full.state.messages.find(item => item.role === 'user').source.kind, 'subagent')
  assert.equal(JSON.stringify(full.state).includes(rootTask), false)
  assert.equal(full.state.lineage, undefined)
  const childPreview = await preview(fx, src, [draft(src, { decision_id: child.decision_id, action_name: child.observed_action.name })])
  const childSaved = await apply(fx, childPreview)
  const rootPreview = await preview(fx, src, [draft(src, { decision_id: src.decisions[0].decision_id, action_name: src.decisions[0].observed_action.name })])
  const rootSaved = await apply(fx, rootPreview)
  assert.deepEqual(childSaved.dataset.records[0]._meta.lineage, full.lineage)
  assert.equal(rootSaved.dataset.records[0]._meta.lineage, undefined)
  assert.equal(childSaved.dataset.records[0]._meta.source_group_id, rootSaved.dataset.records[0]._meta.source_group_id)
  const stored = join(fx.root, childSaved.file), tampered = JSON.parse(readFileSync(stored, 'utf8'))
  tampered.records[0]._meta.lineage.actor_session_id = 'forged-actor'; write(stored, JSON.stringify(tampered))
  const read = await fx.handle('datasets/read', { dataset_id: tampered.id })
  assert.ok(read.eligibility.records[0].reasons.some(reason => /主体或委派来源/.test(reason)))
  assert.equal(readFileSync(join(fx.root, tracePath), 'utf8'), raw)
}))

test('受托AI复核真实记录身份，改标可同次复核且保留原始来源，不伪装人工', () => withFixture(async fx => {
  const saved = await save(fx), original = saved.dataset.records[0].targets.route.provenance
  const input = updatePayload(saved), model = { provider: 'fixture-reviewer', model: 'review-model' }
  input.targets = { route: { label: 'get_inspection_status', basis: '按当前输入和工具能力复核巡检查询；仅用于功能验证。', status: 'reviewed', decision_time_reviewed: true } }
  const evidence = inputEvidence(saved, 'session-actual-reviewer')
  const result = await fx.handle('datasets/review', { ...input, assistant_session_id: 'session-actual-reviewer', assistant_model: model, assistant_input_evidence: evidence })
  const target = result.dataset.records[0].targets.route
  assert.equal(target.provenance.kind, 'ai_annotation'); assert.deepEqual(target.provenance.origin, original)
  assert.equal(target.provenance.session_id, 'session-actual-reviewer'); assert.deepEqual(target.provenance.model, model)
  assert.equal(target.status, 'reviewed'); assert.equal(target.decision_time_reviewed, true)
  assert.deepEqual(target.review, { kind: 'ai_delegated', session_id: 'session-actual-reviewer', model, purpose: 'functional_validation', reviewed_at: target.reviewed_at, input_evidence: evidence })
  assert.equal(result.eligibility.counts.training, 1)
  const exported = await fx.handle('datasets/export', { dataset_id: result.dataset.id, mode: 'training' })
  const exportedRecord = JSON.parse(exported.content.trim())
  assert.deepEqual(exportedRecord.targets.route.review.input_evidence, evidence)
  assert.equal(exportedRecord._meta.dataset_id, result.dataset.id)
  assert.equal(exportedRecord._meta.source_bundle_sha256, result.dataset.source_bundle.sha256)
  assert.equal(result.dataset.records[0]._meta.dataset_id, undefined, '导出身份投影不回写固定原件')
  const regrouped = await fx.handle('datasets/update', updatePayload(result, undefined, { split: 'development' }))
  assert.deepEqual(regrouped.dataset.records[0].targets.route.review, target.review, '仅改用途不能冒充人工复核')
  const human = updatePayload(regrouped)
  human.targets.route.review = null
  await new Promise(resolve => setTimeout(resolve, 5))
  const confirmed = await fx.handle('datasets/update', human)
  assert.equal(confirmed.dataset.records[0].targets.route.review, undefined)
  assert.notEqual(confirmed.dataset.records[0].targets.route.reviewed_at, target.reviewed_at, '明确人工接管使用本次复核时间')
}))

test('受托复核拒绝伪造身份字段、缺失真实会话或时点核对，并沿用来源与并发检查', () => withFixture(async fx => {
  const saved = await save(fx), input = updatePayload(saved)
  input.targets = { route: { label: 'get_asset_status', basis: saved.dataset.records[0].targets.route.basis, status: 'reviewed', decision_time_reviewed: true } }
  const context = { assistant_session_id: 'session-reviewer', assistant_model: { provider: 'fixture', model: 'reviewer' }, assistant_input_evidence: inputEvidence(saved, 'session-reviewer') }
  await assert.rejects(() => fx.handle('datasets/review', input), /Session/)
  await assert.rejects(() => fx.handle('datasets/review', { ...input, ...context, assistant_input_evidence: undefined }), /完整输入读取证据/)
  for (const change of [{ session_id: 'forged' }, { dataset_id: 'forged' }, { state_sha256: 'f'.repeat(64) }, { source_bundle_sha256: 'f'.repeat(64) }]) {
    await assert.rejects(() => fx.handle('datasets/review', { ...input, ...context, assistant_input_evidence: { ...context.assistant_input_evidence, ...change } }), /完整输入读取证据/)
  }
  for (const change of [{ provenance: { kind: 'human_annotation' } }, { review: { kind: 'human' } }, { status: 'suggested' }, { decision_time_reviewed: false }]) {
    await assert.rejects(() => fx.handle('datasets/review', { ...input, ...context, targets: { route: { ...input.targets.route, ...change } } }), /受托|核对|复核/)
  }
  const result = await fx.handle('datasets/review', { ...input, ...context })
  assert.equal(result.dataset.records[0].targets.route.provenance.kind, 'model_suggestion', '未改标签仍保留原模型建议来源')
  await assert.rejects(() => fx.handle('datasets/review', { ...input, ...context }), /其他任务修改/)
  const forged = updatePayload(result); forged.targets.route.review = { ...result.dataset.records[0].targets.route.review, session_id: 'forged' }
  await assert.rejects(() => fx.handle('datasets/update', forged), /复核身份|input_evidence.session_id/)
  write(join(fx.root, fx.path), fx.raw + '\n')
  await assert.rejects(() => fx.handle('datasets/review', { ...input, ...context, expected_sha256: result.sha256 }), /来源|摘要|轨迹/)
}))

test('旧AI复核缺少输入证明保持原件，列表与导出不视为完成', () => withFixture(async fx => {
  const saved = await save(fx), value = JSON.parse(readFileSync(join(fx.root, saved.file), 'utf8'))
  const target = value.records[0].targets.route
  Object.assign(target, { status: 'reviewed', decision_time_reviewed: true, reviewed_at: '2026-10-26T00:00:00.000Z',
    review: { kind: 'ai_delegated', session_id: 'legacy-ai-reviewer', model: { provider: 'fixture', model: 'reviewer' }, reviewed_at: '2026-10-26T00:00:00.000Z', purpose: 'functional_validation' } })
  const original = JSON.stringify(value)
  write(join(fx.root, saved.file), original)
  const read = await fx.handle('datasets/read', { dataset_id: value.id })
  assert.equal(read.dataset.records[0].targets.route.review.session_id, 'legacy-ai-reviewer')
  assert.equal(read.eligibility.counts.training, 0)
  assert.ok(read.eligibility.records[0].question_reasons.route.some(reason => /读取|阅读|输入/.test(reason)))
  const list = await fx.handle('datasets/list', { include_eligibility: false })
  assert.equal(list.datasets[0].reviewed, 0)
  await assert.rejects(() => exported(fx, value), /尚无符合/)
  assert.equal(readFileSync(join(fx.root, saved.file), 'utf8'), original)
}))

test('批次导航可只读存储摘要，不能把未核对的列表计数当作训练资格', () => withFixture(async fx => {
  const saved = await reviewed(fx, await save(fx))
  write(join(fx.root, fx.path), fx.raw + '\n')
  const listed = await fx.handle('datasets/list', { run_id: runId, include_eligibility: false })
  assert.equal(listed.datasets[0].path, fx.path)
  assert.equal(listed.datasets[0].reviewed, 1)
  assert.equal(listed.datasets[0].eligibility_checked, false)
  assert.equal(listed.datasets[0].eligibility, undefined)
  const selected = await fx.handle('datasets/read', { dataset_id: saved.dataset.id })
  assert.equal(selected.eligibility.counts.training, 0)
  await assert.rejects(() => fx.handle('datasets/list', { include_eligibility: 'false' }), /布尔值/)
}))

test('人工修改拒绝理由仍保留排除状态，不因内容变化回到候选', () => withFixture(async fx => {
  const saved = await save(fx), input = updatePayload(saved)
  input.targets.route = { ...input.targets.route, basis: '这道题的条件不足，应排除。', status: 'rejected', decision_time_reviewed: false }
  const result = await fx.handle('datasets/update', input)
  assert.equal(result.dataset.records[0].targets.route.status, 'rejected')
  assert.equal(result.eligibility.counts.candidates, 0)
}))
