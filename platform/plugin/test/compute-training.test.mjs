import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { trainingFixture } from './fixtures/decision-training.mjs'

const compiled = mkdtempSync(join(tmpdir(), 'compute-training-test-'))
await build({ entryPoints: [new URL('../src/agents/compute-training.ts', import.meta.url).pathname], outfile: join(compiled, 'training.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { inspectDecisionTraining } = await import(`file://${join(compiled, 'training.mjs')}`)
test.after(() => rmSync(compiled, { recursive: true, force: true }))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'training-receipt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, ...trainingFixture(root, ['run-fixed']) }
}
test('训练材料绑定来源、四分区、成功作业及三个实际工件', async t => {
  const f = fixture(t), result = await inspectDecisionTraining(f.root, f.plan)
  assert.equal(result.verified, true)
  assert.deepEqual(result.dataset_counts, { train: 1, development: 1, calibration: 1, test: 1 })
  assert.deepEqual(await inspectDecisionTraining(f.root, { execution_mode: 'code-only' }), { required: false, verified: false, reasons: [] })
  delete f.plan.decision_training
  assert.match((await inspectDecisionTraining(f.root, f.plan)).reasons.join(), /缺少本次 KEV/)
})
test('公开模型身份、失败作业、零优化步、缺失日志和错误来源不能证明训练完成', async t => {
  for (const [name, change, reason] of [
    ['failed', f => { f.receipt.training.exit_code = 1 }, /训练未成功/],
    ['zero-step', f => { f.receipt.training.optimizer_steps = 0 }, /优化步骤/],
    ['log', f => { f.receipt.training.log.sha256 = '0'.repeat(64) }, /摘要不匹配/],
    ['source', f => { f.receipt.source_run_ids = ['other-run'] }, /来源 Run/],
    ['checkpoint', f => { f.plan.model_roles.decision.checkpoint_sha256 = 'a'.repeat(64) }, /绑定不一致/],
    ['calibration', f => { f.receipt.calibration.status = 'not_run' }, /calibration 尚未完成/],
    ['test', f => { f.receipt.test.exit_code = 1 }, /test 尚未完成/],
  ]) await t.test(name, async t => {
    const f = fixture(t); change(f); f.save()
    const result = await inspectDecisionTraining(f.root, f.plan)
    assert.equal(result.verified, false); assert.match(result.reasons.join(), reason)
  })
})
test('原生 KEV 接受非空对象状态，保留原数据及跨分区输入核验', async t => {
  const f = fixture(t)
  for (const [split, row] of Object.entries(f.rows)) {
    row.state = { '用户输入指令': `任务 ${split}`, '背景信息': [] }
    f.receipt.datasets[split] = f.file(`${split}.jsonl`, JSON.stringify(row))
  }
  f.save()
  assert.equal((await inspectDecisionTraining(f.root, f.plan)).verified, true)
  f.rows.test.state = f.rows.train.state
  f.receipt.datasets.test = f.file('test.jsonl', JSON.stringify(f.rows.test)); f.save()
  assert.match((await inspectDecisionTraining(f.root, f.plan)).reasons.join(), /决策输入泄漏/)
  for (const state of [null, '', '  ', {}, [], 1, false]) {
    f.rows.test.state = state
    f.receipt.datasets.test = f.file('test.jsonl', JSON.stringify(f.rows.test)); f.save()
    assert.match((await inspectDecisionTraining(f.root, f.plan)).reasons.join(), /state\/questions/)
  }
})
test('拒绝空分区、重复身份、来源组泄漏和不同身份下相同决策输入泄漏', async t => {
  for (const [name, change, reason] of [
    ['empty', f => { f.receipt.datasets.test = f.file('test.jsonl', '\n') }, /数据为空/],
    ['id', f => { f.rows.test._meta.id = f.rows.train._meta.id }, /唯一记录身份/],
    ['group', f => { f.rows.test._meta.group_id = f.rows.train._meta.group_id }, /来源组泄漏/],
    ['input', f => { f.rows.test.state = f.rows.train.state }, /决策输入泄漏/],
  ]) await t.test(name, async t => {
    const f = fixture(t); change(f)
    if (name !== 'empty') f.receipt.datasets.test = f.file('test.jsonl', JSON.stringify(f.rows.test))
    f.save(); assert.match((await inspectDecisionTraining(f.root, f.plan)).reasons.join(), reason)
  })
})
test('训练材料不得越界或通过符号链接引用，摘要变化失效', async t => {
  const f = fixture(t)
  f.plan.decision_training.path = '../receipt.json'
  assert.match((await inspectDecisionTraining(f.root, f.plan)).reasons.join(), /越出/)
  f.save()
  symlinkSync(join(f.root, f.plan.decision_training.path), join(f.root, 'linked.json'))
  f.plan.decision_training.path = 'linked.json'
  assert.match((await inspectDecisionTraining(f.root, f.plan)).reasons.join(), /符号链接/)
  f.save(); f.file('train.log', 'changed log')
  assert.match((await inspectDecisionTraining(f.root, f.plan)).reasons.join(), /摘要不匹配/)
})
