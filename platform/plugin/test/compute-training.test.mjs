import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { trainingFixture } from './fixtures/decision-training.mjs'
import { dump, load } from 'js-yaml'

const compiled = mkdtempSync(join(tmpdir(), 'compute-training-test-'))
await build({ entryPoints: [new URL('../src/agents/compute-training.ts', import.meta.url).pathname], outfile: join(compiled, 'training.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { inspectDecisionTraining, archiveDecisionTraining } = await import(`file://${join(compiled, 'training.mjs')}`)
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

test('归档只回收引用闭包，清除工作目录后可独立恢复并复用，不重训或修改原回执', async t => {
  const f = fixture(t), id = 'VAR-alpha-001-r123456abcdef', base = `evolution/experiments/${id}`
  const changePath = join(f.root, base, 'change.yaml')
  mkdirSync(join(f.root, base, 'candidate'), { recursive: true })
  writeFileSync(changePath, dump({ experiment_id: id, agent_id: 'alpha', compute_variant: f.plan }))
  const original = readFileSync(join(f.root, f.plan.decision_training.path))
  writeFileSync(join(f.root, 'evaluation/training-fixture/private-do-not-copy.txt'), 'unreferenced runtime state')
  assert.equal((await inspectDecisionTraining(f.root, f.plan, id)).verified, false)
  const archived = await archiveDecisionTraining(f.root, id)
  assert.equal(archived.reused, false)
  assert.deepEqual(readFileSync(join(f.root, f.plan.decision_training.path)), original)
  const plan = load(readFileSync(changePath, 'utf8')).compute_variant
  assert.equal((await inspectDecisionTraining(f.root, plan, id)).verified, true)
  assert.equal(existsSync(join(f.root, archived.receipt.path, '../private-do-not-copy.txt')), false)
  const restored = mkdtempSync(join(tmpdir(), 'training-restored-'))
  t.after(() => rmSync(restored, { recursive: true, force: true }))
  mkdirSync(join(restored, 'evolution/experiments'), { recursive: true })
  cpSync(join(f.root, base), join(restored, base), { recursive: true })
  rmSync(join(f.root, 'evaluation'), { recursive: true, force: true })
  rmSync(join(f.root, '.local'), { recursive: true, force: true })
  assert.equal((await inspectDecisionTraining(restored, plan, id)).verified, true)
  const before = readFileSync(changePath)
  assert.equal((await archiveDecisionTraining(f.root, id)).reused, true)
  assert.deepEqual(readFileSync(changePath), before)
  writeFileSync(join(f.root, plan.decision_training.path), '{}')
  await assert.rejects(() => archiveDecisionTraining(f.root, id), /摘要不匹配/)
  assert.deepEqual(readFileSync(changePath), before)
})

test('显式恢复依赖保持源码与资源的相对目录，摘要失效和非法补充不得更新计划', async t => {
  const f = fixture(t), id = 'VAR-alpha-001-r123456abcdef', base = `evolution/experiments/${id}`
  const changePath = join(f.root, base, 'change.yaml')
  mkdirSync(join(f.root, base, 'candidate'), { recursive: true })
  const put = (path, content) => {
    mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), content)
    return { path, sha256: createHash('sha256').update(content).digest('hex') }
  }
  const resource = put('.local/source/assets/contract.json', '{"version":1}')
  const tokenizer = put('.local/source/assets/tokenizer_config.json', '{"eos_token":"<|endoftext|>","pad_token":"[PAD]"}')
  f.receipt.artifacts.state_constructor = put('.local/source/scripts/build.py', 'resource = "../assets/contract.json"')
  f.plan.model_roles.decision.state_constructor_sha256 = f.receipt.artifacts.state_constructor.sha256
  f.save()
  writeFileSync(changePath, dump({ experiment_id: id, agent_id: 'alpha', compute_variant: f.plan }))
  const before = readFileSync(changePath)
  await assert.rejects(() => archiveDecisionTraining(f.root, id, undefined, [{ ...resource, sha256: '0'.repeat(64) }]), /材料变化/)
  await assert.rejects(() => archiveDecisionTraining(f.root, id, undefined, [{ path: '../secret', sha256: resource.sha256 }]), /数据根内/)
  assert.deepEqual(readFileSync(changePath), before)
  await archiveDecisionTraining(f.root, id, undefined, [resource, tokenizer])
  const plan = load(readFileSync(changePath, 'utf8')).compute_variant
  const receipt = JSON.parse(readFileSync(join(f.root, plan.decision_training.path), 'utf8'))
  assert.equal(receipt.artifacts.state_constructor.path.includes('/.local/'), false)
  assert.equal(receipt.supporting_files[0].path, join(receipt.artifacts.state_constructor.path, '../../assets/contract.json'))
  assert.equal(readFileSync(join(f.root, receipt.supporting_files[1].path), 'utf8'), '{"eos_token":"<|endoftext|>","pad_token":"[PAD]"}')
  rmSync(join(f.root, '.local'), { recursive: true, force: true })
  assert.equal((await inspectDecisionTraining(f.root, plan, id)).verified, true)
  const archivedPlan = readFileSync(changePath)
  assert.equal((await archiveDecisionTraining(f.root, id, undefined, [resource])).reused, true)
  assert.deepEqual(readFileSync(changePath), archivedPlan)
  assert.equal((await archiveDecisionTraining(f.root, id)).reused, true)
  writeFileSync(join(f.root, receipt.supporting_files[0].path), 'changed')
  assert.match((await inspectDecisionTraining(f.root, plan, id)).reasons.join(), /摘要不匹配/)
})

test('补充归档保持持久目录布局，不嵌套旧归档或重复原始依赖，Git 可收录完整闭包', async t => {
  const f = fixture(t), id = 'VAR-alpha-001-r123456abcdef', base = `evolution/experiments/${id}`, change = join(f.root, base, 'change.yaml')
  mkdirSync(join(f.root, base, 'candidate'), { recursive: true })
  const put = (name, content) => {
    const path = `.local/source/${name}`
    mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), content)
    return { path, sha256: createHash('sha256').update(content).digest('hex') }
  }
  const first = put('assets/first.json', '{}'), second = put('assets/second.json', '{"round":2}')
  f.receipt.artifacts.state_constructor = put('scripts/build.py', 'resource = "../assets/first.json"')
  f.plan.model_roles.decision.state_constructor_sha256 = f.receipt.artifacts.state_constructor.sha256
  f.save(); writeFileSync(change, dump({ experiment_id: id, agent_id: 'alpha', compute_variant: f.plan }))
  await archiveDecisionTraining(f.root, id, undefined, [first])
  const archived = await archiveDecisionTraining(f.root, id, undefined, [first, second])
  const receipt = JSON.parse(readFileSync(join(f.root, archived.receipt.path), 'utf8'))
  assert.equal(receipt.supporting_files.length, 2)
  const materials = join(archived.receipt.path, '../materials')
  assert.equal(receipt.artifacts.state_constructor.path, `${materials}/local-source/source/scripts/build.py`)
  assert.equal(receipt.supporting_files[0].path, `${materials}/local-source/source/assets/first.json`)
  assert.equal(receipt.supporting_files[1].path, `${materials}/local-source/source/assets/second.json`)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: f.root }).status, 0)
  writeFileSync(join(f.root, '.gitignore'), '.local/\n')
  for (const ref of archived.files) assert.equal(spawnSync('git', ['check-ignore', ref.path], { cwd: f.root }).status, 1, ref.path)
  rmSync(join(f.root, '.local'), { recursive: true, force: true })
  rmSync(join(f.root, 'evaluation'), { recursive: true, force: true })
  assert.equal((await inspectDecisionTraining(f.root, load(readFileSync(change, 'utf8')).compute_variant, id)).verified, true)
  assert.equal((await archiveDecisionTraining(f.root, id, undefined, [first, second])).reused, true)
})

test('.local恢复先零写入预览，只归档引用闭包，拒绝Session与凭据并保护冲突目标', async t => {
  const f = fixture(t), id = 'VAR-alpha-001-r123456abcdef', base = `evolution/experiments/${id}`, change = join(f.root, base, 'change.yaml')
  mkdirSync(join(f.root, base, 'candidate'), { recursive: true })
  const local = '.local/training-fixture/'
  cpSync(join(f.root, 'evaluation/training-fixture'), join(f.root, local), { recursive: true })
  const receipt = JSON.stringify(f.receipt).replaceAll('evaluation/training-fixture/', local)
  writeFileSync(join(f.root, local, 'receipt.json'), receipt)
  f.plan.decision_training = { path: local + 'receipt.json', sha256: createHash('sha256').update(receipt).digest('hex') }
  writeFileSync(change, dump({ experiment_id: id, agent_id: 'alpha', compute_variant: f.plan }))
  const before = readFileSync(change)
  const cli = new URL('../../../runtime/research/compute-assets.mts', import.meta.url).pathname
  const request = join(f.root, 'request.json'); writeFileSync(request, '{"training_files":[]}')
  const runCli = (method, extra = []) => {
    const result = spawnSync(process.execPath, ['--experimental-transform-types', cli, method, '--asset-root', f.root, '--experiment-id', id, '--request', request, ...extra], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout)
  }
  const dry = runCli('training-preview'), preview = dry.archive
  assert.equal(preview.dry_run, true)
  assert.deepEqual(preview.files.map(file => file.path), preview.files.map(file => file.path).sort((left, right) => left.localeCompare(right)))
  assert.equal(runCli('training-preview').preview_sha256, dry.preview_sha256)
  assert.deepEqual(readFileSync(change), before)
  assert.equal(existsSync(join(f.root, base, 'evaluation')), false)
  assert.equal(existsSync(join(f.root, '.local/training-archive')), false)
  const privateFile = (path, content = 'not training material') => {
    mkdirSync(join(f.root, path, '..'), { recursive: true }); writeFileSync(join(f.root, path), content)
    return { path, sha256: createHash('sha256').update(content).digest('hex') }
  }
  for (const path of ['.local/sessions/run/session.jsonl', '.local/credentials.json', '.local/ssh/id_ed25519', '.local/server-api-key.secret']) {
    const ref = privateFile(path)
    await assert.rejects(() => archiveDecisionTraining(f.root, id, undefined, [ref], true), /Session、凭据/)
  }
  const literal = privateFile('.local/server-settings.json', JSON.stringify({ password: 'synthetic-fixture-only' }))
  await assert.rejects(() => archiveDecisionTraining(f.root, id, undefined, [literal], true), /凭据常量/)
  const added = privateFile('.local/training-fixture/recovery-config.json', '{"layers":2}')
  await assert.rejects(() => archiveDecisionTraining(f.root, id, undefined, [added], false, dry.preview_sha256), /预览已变化/)
  assert.deepEqual(readFileSync(change), before)
  assert.equal(existsSync(join(f.root, base, 'evaluation')), false)
  assert.equal(existsSync(join(f.root, '.local/training-archive')), false)
  const destination = join(f.root, preview.receipt.path)
  mkdirSync(join(destination, '..'), { recursive: true }); writeFileSync(destination, 'parallel archive')
  await assert.rejects(() => archiveDecisionTraining(f.root, id), /冲突/)
  assert.equal(readFileSync(destination, 'utf8'), 'parallel archive')
  assert.deepEqual(readFileSync(change), before)
  rmSync(join(f.root, base, 'evaluation'), { recursive: true })
  const archived = runCli('training-archive', ['--expected-preview-sha256', dry.preview_sha256])
  assert.equal(archived.files.some(ref => /sessions|credentials|secret|server-settings/.test(ref.path)), false)
  rmSync(join(f.root, '.local'), { recursive: true })
  const plan = load(readFileSync(change, 'utf8')).compute_variant
  assert.equal((await inspectDecisionTraining(f.root, plan, id)).verified, true)
  assert.equal((await archiveDecisionTraining(f.root, id)).reused, true)
  assert.equal(runCli('training-archive', ['--expected-preview-sha256', dry.preview_sha256]).reused, true)
})

test('原始训练回执含凭据常量时不复制回执或更新计划', async t => {
  const f = fixture(t), id = 'VAR-alpha-001-r123456abcdef', base = `evolution/experiments/${id}`
  f.receipt.password = 'synthetic-fixture-only'; f.save()
  mkdirSync(join(f.root, base, 'candidate'), { recursive: true })
  const change = join(f.root, base, 'change.yaml')
  writeFileSync(change, dump({ experiment_id: id, agent_id: 'alpha', compute_variant: f.plan }))
  const before = readFileSync(change)
  await assert.rejects(() => archiveDecisionTraining(f.root, id, undefined, [], true), /回执包含凭据常量/)
  assert.deepEqual(readFileSync(change), before)
  assert.equal(existsSync(join(f.root, base, 'evaluation')), false)
})
