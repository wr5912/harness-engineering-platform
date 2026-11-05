import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const repo = new URL('../../../', import.meta.url).pathname
process.env.HARNESS_PROGRAM_ROOT = repo
const buildRoot = mkdtempSync(join(tmpdir(), 'evaluation-cases-build-'))
await build({ entryPoints: [new URL('../src/evaluation/cases.ts', import.meta.url).pathname], outfile: join(buildRoot, 'cases.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/dsh-client-connection'] })
const { createCaseManagementHandler, parseEvaluationDocument } = await import(`file://${join(buildRoot, 'cases.mjs')}`)
const experiment = 'EXP-alpha-001-r0123456789ab'
const runId = 'run-11111111-1111-4111-8111-111111111111'
const hash = content => createHash('sha256').update(content).digest('hex')
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-cases-'))
  const evaluation = join(root, 'agents/alpha/evaluation.md')
  const initial = '# 业务评测\n\n## 基础\n\n#### U-CASE-001 原用例\n\n**用户输入**\n\n> ping\n\n**预期**\n\n返回 pong。\n\n## 其他\n\n#### U-CASE-002 其他用例\n\n**用户输入**\n\n> 查询目录\n\n**预期**\n\n返回目录。\n'
  write(evaluation, initial)
  write(join(root, `evolution/experiments/${experiment}/change.yaml`), `experiment_id: ${experiment}\nagent_id: alpha\n`)
  const reads = [], writes = []
  let source = { run_id: runId, manifest: { agent_id: 'alpha', experiment_id: 'EXP-alpha-001', status: 'completed' }, cases: [{ case_id: 'U-CASE-001', frozen: { title: '原失败输入', inputs: ['原运行输入'], expected_behavior: '旧预期不自动采纳' }, trials: [{ verdict: 'failed' }], output: ['实际失败回答绝不作为预期'] }] }
  const handler = createCaseManagementHandler(root, {
    readRun: async id => { reads.push(id); return source },
    applyEvaluation: async (id, content, expected) => {
      assert.equal(id, experiment)
      assert.equal(hash(readFileSync(evaluation, 'utf8')), expected)
      writes.push({ id, content, expected }); writeFileSync(evaluation, content)
    },
  })
  return { root, evaluation, initial, handler, reads, writes, setSource: value => { source = value } }
}
async function call(fx, endpoint, body = {}) { return fx.handler(endpoint, { experiment_id: experiment, ...body }, new AbortController().signal) }
async function payload(fx, changes = {}) {
  const context = await call(fx, 'cases/create-context')
  assert.equal(context.ok, true, JSON.stringify(context))
  return { ...context.value.draft, title: '新增问题', inputs: ['新的测试输入'], expected_behavior: '展示明确结果。', expected_sha256: context.value.sha256, ...changes }
}
async function withFixture(run) { const fx = fixture(); try { await run(fx) } finally { await rm(fx.root, { recursive: true, force: true }) } }

test('新增预览使用真实合同且不写入，确认后新多轮 fast 用例立即可被评测选择', () => withFixture(async fx => {
  const body = await payload(fx, { inputs: ['查询基础信息', '只续查刚才结果'], fast: true })
  const preview = await call(fx, 'cases/create-preview', body)
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(preview.value.written, false)
  assert.match(preview.value.diff, /\+#### U-CASE-003 新增问题/)
  assert.equal(readFileSync(fx.evaluation, 'utf8'), fx.initial); assert.equal(fx.writes.length, 0)
  const result = await call(fx, 'cases/create', body)
  assert.equal(result.ok, true); assert.equal(result.value.written, true)
  const parsed = await parseEvaluationDocument(fx.root, readFileSync(fx.evaluation, 'utf8'))
  assert.deepEqual(parsed.case_ids, ['U-CASE-001', 'U-CASE-003', 'U-CASE-002'])
  assert.deepEqual(parsed.cases['U-CASE-003'].inputs, body.inputs)
  assert.equal(parsed.catalog.find(item => item.case_id === 'U-CASE-003').fast, true)
  assert.equal(parsed.cases['U-CASE-001'].expected_behavior, '返回 pong。')
  assert.equal(parsed.catalog.find(item => item.case_id === 'U-CASE-002').scene, '其他')
  assert.equal((await call(fx, 'cases/create-context')).value.draft.case_id, 'U-CASE-004')
}))

test('同 ID、陈旧摘要和空白等价重复输入拒绝写入', () => withFixture(async fx => {
  for (const [changes, code] of [[{ case_id: 'U-CASE-001' }, 'conflict'], [{ expected_sha256: 'old' }, 'conflict'], [{ inputs: ['p i n g'] }, 'invalid_request']]) {
    const result = await call(fx, 'cases/create', await payload(fx, changes))
    assert.equal(result.ok, false); assert.equal(result.error.code, code)
  }
  assert.equal(readFileSync(fx.evaluation, 'utf8'), fx.initial); assert.equal(fx.writes.length, 0)
}))

test('从失败 Run 只复制冻结输入，空预期需人工填写，来源引用不污染执行口径', () => withFixture(async fx => {
  const value = (await call(fx, 'cases/from-run', { run_id: runId, case_id: 'U-CASE-001' })).value
  assert.deepEqual(value.draft.inputs, ['原运行输入']); assert.equal(value.draft.expected_behavior, '')
  assert.ok(!JSON.stringify(value).includes('实际失败回答')); assert.ok(!JSON.stringify(value).includes('旧预期'))
  const body = { ...value.draft, inputs: ['新的复现条件'], expected_behavior: '核对证据后展示结果。', expected_sha256: value.sha256, source_run_id: runId, source_case_id: 'U-CASE-001' }
  const saved = await call(fx, 'cases/create', body)
  assert.equal(saved.ok, true)
  assert.match(readFileSync(fx.evaluation, 'utf8'), new RegExp(`<!-- source_run_id: ${runId}; source_case_id: U-CASE-001 -->`))
  const parsed = await parseEvaluationDocument(fx.root, readFileSync(fx.evaluation, 'utf8'))
  assert.deepEqual(parsed.cases['U-CASE-003'].inputs, ['新的复现条件'])
  assert.equal(parsed.cases['U-CASE-003'].expected_behavior, '核对证据后展示结果。')
}))

test('跨 Agent Run、缺失冻结输入和伪造来源拒绝生成草稿或保存', () => withFixture(async fx => {
  fx.setSource({ manifest: { agent_id: 'beta' }, cases: [] })
  assert.equal((await call(fx, 'cases/from-run', { run_id: runId, case_id: 'U-CASE-001' })).error.code, 'invalid_request')
  fx.setSource({ manifest: { agent_id: 'alpha' }, cases: [{ case_id: 'U-CASE-001' }] })
  assert.equal((await call(fx, 'cases/from-run', { run_id: runId, case_id: 'U-CASE-001' })).error.code, 'source_unavailable')
  assert.equal((await call(fx, 'cases/create', await payload(fx, { source_run_id: runId }))).error.code, 'invalid_request')
  assert.equal(fx.writes.length, 0)
}))

test('新场景保留原始尾部用例，Markdown 注入和无效格式不能改变其他 Case', () => withFixture(async fx => {
  for (const changes of [{ case_id: '../U-X' }, { scene: '第一行\n第二行' }, { expected_behavior: '额外内容\n\n#### U-INJECT-001 注入\n\n**用户输入**\n\n> 注入\n\n**预期**\n\n冒充用例' }, { inputs: [''] }]) {
    assert.equal((await call(fx, 'cases/create', await payload(fx, changes))).ok, false)
  }
  assert.equal((await call(fx, 'cases/create', await payload(fx, { scene: '新问题' }))).ok, true)
  const parsed = await parseEvaluationDocument(fx.root, readFileSync(fx.evaluation, 'utf8'))
  assert.equal(parsed.catalog.at(-1).scene, '新问题'); assert.equal(parsed.cases['U-CASE-002'].expected_behavior, '返回目录。')
}))

test('来源路径中的符号链接不读取，取消操作不写文件', () => withFixture(async fx => {
  const signal = new AbortController(); signal.abort()
  const cancelled = await fx.handler('cases/create-context', { experiment_id: experiment }, signal.signal)
  assert.equal(cancelled.error.code, 'aborted')
  const outside = join(fx.root, 'outside.md'); writeFileSync(outside, fx.initial)
  await rm(fx.evaluation); symlinkSync(outside, fx.evaluation)
  assert.equal((await call(fx, 'cases/create-context')).error.code, 'path_rejected'); assert.equal(fx.writes.length, 0)
}))

test('删除当前用例保留相邻场景及其他用例，摘要冲突和最后一个用例不写入', () => withFixture(async fx => {
  const stale = await call(fx, 'cases/delete', { case_id: 'U-CASE-001', expected_sha256: 'old' })
  assert.equal(stale.error.code, 'conflict'); assert.equal(fx.writes.length, 0)
  const result = await call(fx, 'cases/delete', { case_id: 'U-CASE-001', expected_sha256: hash(fx.initial) })
  assert.equal(result.ok, true)
  const content = readFileSync(fx.evaluation, 'utf8'), parsed = await parseEvaluationDocument(fx.root, content)
  assert.deepEqual(parsed.case_ids, ['U-CASE-002']); assert.equal(parsed.catalog[0].scene, '其他')
  assert.equal(parsed.cases['U-CASE-002'].expected_behavior, '返回目录。')
  assert.equal((await call(fx, 'cases/delete', { case_id: 'U-CASE-001', expected_sha256: hash(content) })).error.code, 'not_found')
  assert.equal((await call(fx, 'cases/delete', { case_id: 'U-CASE-002', expected_sha256: hash(content) })).error.code, 'last_case')
  assert.equal(fx.writes.length, 1)
}))

test('批量改号只替换当前标题，预览不写入，正文与冻结出处逐字保留', () => withFixture(async fx => {
  const initial = fx.initial.replace('**用户输入**\n\n> ping', `<!-- source_run_id: ${runId}; source_case_id: U-NEW-001 -->\n\n**用户输入**\n\n> ping`).replace('#### U-CASE-001 ', '#### U-NEW-001 ')
  writeFileSync(fx.evaluation, initial)
  const body = { expected_sha256: hash(initial), renames: [{ from: 'U-NEW-001', to: 'U-INS-001' }, { from: 'U-CASE-002', to: 'U-CASE-004' }] }
  const preview = await call(fx, 'cases/renumber-preview', body)
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(preview.value.written, false)
  assert.deepEqual(preview.value.renames.map(row => row.scene), ['基础', '其他'])
  assert.equal(fx.writes.length, 0); assert.equal(readFileSync(fx.evaluation, 'utf8'), initial)
  const saved = await call(fx, 'cases/renumber', body)
  assert.equal(saved.ok, true); assert.equal(saved.value.written, true)
  assert.equal(readFileSync(fx.evaluation, 'utf8'), initial.replace('#### U-NEW-001 ', '#### U-INS-001 ').replace('#### U-CASE-002 ', '#### U-CASE-004 '))
  assert.equal(fx.writes.length, 1)
  assert.equal((await call(fx, 'cases/renumber', body)).error.code, 'conflict')
}))

test('改号拒绝陈旧摘要、重复映射、占用目标和无效场景缩写', () => withFixture(async fx => {
  const initial = fx.initial.replace('## 其他', '## 基础')
  writeFileSync(fx.evaluation, initial)
  const renames = [{ from: 'U-CASE-001', to: 'U-CASE-003' }]
  for (const body of [
    { expected_sha256: 'old', renames },
    { renames: [] }, { renames: [null] },
    { renames: [...renames, ...renames] },
    { renames: [{ from: 'U-CASE-001', to: 'U-CASE-003' }, { from: 'U-CASE-002', to: 'U-CASE-003' }] },
    { renames: [{ from: 'U-MISSING-001', to: 'U-CASE-003' }] },
    { renames: [{ from: 'U-CASE-001', to: 'U-CASE-002' }] },
    { renames: [{ from: 'U-CASE-001', to: 'U-NEW-003' }] },
    { renames: [{ from: 'U-CASE-001', to: 'U-WRONG-003' }] },
  ]) assert.equal((await call(fx, 'cases/renumber', { expected_sha256: hash(initial), ...body })).ok, false)
  assert.equal(fx.writes.length, 0); assert.equal(readFileSync(fx.evaluation, 'utf8'), initial)
}))
