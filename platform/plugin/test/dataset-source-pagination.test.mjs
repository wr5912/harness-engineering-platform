import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { build } from 'esbuild'

process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
const buildRoot = mkdtempSync(join(tmpdir(), 'dataset-source-pagination-build-'))
await build({ entryPoints: [new URL('../src/evaluation/datasets.ts', import.meta.url).pathname], outfile: join(buildRoot, 'datasets.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createDecisionDatasetHandler } = await import(`file://${join(buildRoot, 'datasets.mjs')}`)
after(() => rm(buildRoot, { recursive: true, force: true }))

const identity = { agent_id: 'alpha', experiment_id: 'EXP-alpha-001-r0123456789ab', run_id: 'run-11111111-1111-4111-8111-111111111111' }
const sourceVersion = { candidate_sha256: 'a'.repeat(64), git_version: { commit: 'b'.repeat(40), dirty: true } }
const owner = 'session-pagination-fixture'
const tools = ['get_asset_status', 'get_inspection_status', 'get_graph_context', 'get_report_status']
  .map(name => ({ name, description: `只读能力 ${name}`, inputSchema: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] } }))
const hash = value => createHash('sha256').update(value).digest('hex')
function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }
function traceEvents(user) {
  const envelope = (type, data, seq) => ({ session_log: 'session.v4.jsonl', event: { type, seq, time: 1700000000000 + seq, data } })
  return [
    envelope('session', { id: 'session-pagination' }, 0),
    envelope('user/message', { message: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] } }, 1),
    envelope('step/start', { id: 'step-1' }, 2),
    envelope('request/header', { header: { config: { provider: 'fixture', model: 'basic-model' }, messages: [{ role: 'system', content: '仅查询基本资产与巡检状态。' }, { role: 'user', source: { kind: 'user' }, content: user }], tools } }, 3),
    envelope('tool/call', { callId: 'call-a', name: 'get_asset_status', arguments: { asset_id: 'asset-1' } }, 4),
    envelope('tool/result', { message: { source: { kind: 'tool', callId: 'call-a' }, content: [{ type: 'text', text: 'FUTURE_RESULT_A' }] } }, 5),
    envelope('tool/call', { callId: 'call-b', name: 'get_inspection_status', arguments: { asset_id: 'asset-1' } }, 6),
    envelope('tool/result', { message: { source: { kind: 'tool', callId: 'call-b' }, content: [{ type: 'text', text: 'FUTURE_RESULT_B' }] } }, 7),
  ]
}
function fixture(t, { count = 3, largeUser } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dataset-source-pagination-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = `evolution/experiments/${identity.experiment_id}/runs/${identity.run_id}`
  const caseId = index => `U-BASIC-${String(index).padStart(3, '0')}`
  const path = index => `${base}/evidence/${caseId(index)}/trace.jsonl`
  const manifest = values => Object.entries({ ...identity, status: 'completed', ...values }).map(([key, value]) => `${key}: ${value}`).join('\n') + '\n'
  write(join(root, 'AGENTS.md'), '管理身份读取决策前材料。\n')
  write(join(root, '.agents/skills/decision-sample-extraction/SKILL.md'), '---\nname: decision-sample-extraction\n---\n\n保留来源与人工逐题复核。\n')
  write(join(root, 'docs/harness-research/decision-samples.md'), '输入与目标分开，AI建议不等于人工真值。\n')
  write(join(root, base, 'run.yaml'), manifest())
  write(join(root, base, 'inputs.lock.json'), JSON.stringify({ ...sourceVersion, evaluation_cases: Array.from({ length: count }, (_, index) => ({ case_id: caseId(index), inputs: [`查询测试资产${index}。`], expected_behavior: '只读返回实际状态。' })) }))
  for (let index = 0; index < count; index++) {
    const events = traceEvents(index === 0 && largeUser !== undefined ? largeUser : `查询测试资产${index}的状态。`)
    const raw = events.map(value => JSON.stringify(value)).join('\n') + '\n'
    assert.ok(raw.split('\n').every(line => Buffer.byteLength(line) < 128 * 1024), '长前缀保持在真实JSONL行读取上限内')
    write(join(root, path(index)), raw)
    write(join(root, base, 'evidence', caseId(index), 'checks.json'), JSON.stringify({ trace_available: true }))
  }
  return { root, base, path, caseId, manifest, handle: createDecisionDatasetHandler(root) }
}
const source = (f, args = {}) => f.handle('datasets/source', { run_id: identity.run_id, ...args })
function assertBounded(page) { assert.ok(JSON.stringify(page).length <= 16000, `${page.kind} 回执超出公开字符预算`) }
function assertIdentity(value) { for (const [key, expected] of Object.entries(identity)) assert.equal(value[key], expected) }
async function readAllFragments(f, input) {
  let cursor = 0, content = '', first, pages = 0, request = { ...input, cursor: 0 }
  do {
    const page = await source(f, request)
    first ??= page
    assertBounded(page); assertIdentity(page)
    assert.equal(page.kind, 'decision_fragment')
    assert.equal(page.cursor, cursor)
    assert.equal(page.content_sha256, first.content_sha256)
    assert.equal(page.total_characters, first.total_characters)
    assert.equal(/[\uD800-\uDBFF]$/.test(page.fragment), false, '不能切断高代理项')
    assert.equal(/^[\uDC00-\uDFFF]/.test(page.fragment), false, '不能从低代理项开始')
    content += page.fragment; pages++
    assert.equal(page.complete, page.next_cursor === null)
    if (page.next_cursor !== null) {
      assert.ok(page.next_cursor > cursor)
      assert.equal(page.read_input.cursor, page.next_cursor)
      assert.equal(page.read_input.source_sha256, page.source_sha256)
      assert.equal(page.read_input.source_identity_sha256, page.source_identity_sha256)
      assert.equal(page.read_input.content_sha256, page.content_sha256)
      assert.equal(page.read_input.limit, input.limit ?? 4000)
      request = page.read_input
    } else assert.equal(page.read_input, null)
    cursor = page.next_cursor
  } while (cursor !== null)
  assert.equal(content.length, first.total_characters)
  assert.equal(hash(content), first.content_sha256)
  return { decision: JSON.parse(content), content, pages }
}
const draft = decision => ({
  decision_id: decision.decision_id, action_name: decision.observed_action.name, workflow: '资产只读查询', task: { id: 'asset-read', semantics: 'recommended_decision' },
  questions: { route: { type: 'choice', instructions: '下一步应查询哪类实际信息？', criteria: { get_asset_status: '查询资产状态', get_inspection_status: '查询巡检状态' } } },
  targets: { route: { label: 'get_asset_status', basis: '当前只读请求的候选建议，仍待人工逐题核对。' } },
})
async function preview(f, page, extra = {}) {
  return f.handle('datasets/preview', { run_id: identity.run_id, path: page.path, source_sha256: page.source_sha256,
    assistant_session_id: owner, assistant_model: { provider: 'fixture', model: 'basic-model' }, samples: [draft(page.decisions[0])], ...extra })
}

test('130条target来源可完整分页，每页有真实身份与预算，摘要固定且不重复首目录', async t => {
  const f = fixture(t, { count: 130 })
  const first = await source(f)
  assert.equal(first.kind, 'sources'); assertIdentity(first); assertBounded(first)
  assert.equal(first.total_files, 130)
  assert.ok(first.files.length > 0 && first.files.length <= 8)
  assert.equal(first.extraction_contract.schema_version, 2)
  assert.deepEqual(first.source_version, sourceVersion)
  const seen = new Set()
  let page = first
  while (true) {
    assertBounded(page); assertIdentity(page)
    assert.equal(page.source_sha256, first.source_sha256)
    for (const file of page.files) { assert.equal(file.role, 'target'); assert.equal(seen.has(file.path), false); seen.add(file.path) }
    if (page.next_cursor === null) break
    const cursor = page.next_cursor
    page = await source(f, { cursor, source_sha256: first.source_sha256, source_identity_sha256: first.source_identity_sha256, limit: 20 })
    assert.equal(page.cursor, cursor)
    assert.ok(page.files.length > 0 && page.files.length <= 20)
    assert.equal(Object.hasOwn(page, 'extraction_contract'), false)
  }
  assert.equal(seen.size, 130)
  await assert.rejects(source(f, { cursor: first.next_cursor }), /摘要/)
  await assert.rejects(source(f, { cursor: first.next_cursor, source_sha256: '0'.repeat(64) }), /摘要/)
  for (const args of [{ limit: 21 }, { limit: 0 }, { cursor: -1 }, { cursor: 131 }, { cursor: 1.5 }]) await assert.rejects(source(f, args), /分页/)
  const selected = await source(f, { path: first.files[0].path })
  assert.equal(selected.kind, 'decisions'); assertIdentity(selected); assertBounded(selected)
  assert.equal(Object.hasOwn(selected, 'files'), false)
  assert.ok(selected.decisions[0].state.messages.length > 0)
  assert.deepEqual(selected.decisions[0].state.available_tools, tools)
  assert.notEqual(selected.source_sha256, first.source_sha256, '目录与文件摘要不可混用')
  await assert.rejects(source(f, { path: first.files[0].path, source_sha256: first.source_sha256 }), /变化|摘要/)
})

test('约50k前缀经descriptor分片完整可读，保留状态工具来源且无未来结果', async t => {
  const user = '原始中文事实：' + 'x'.repeat(2700) + '😀A'.repeat(8000) + 'z'.repeat(23000) + '；原始尾部事实。'
  assert.ok(user.length > 45000)
  const f = fixture(t, { largeUser: user })
  const page = await source(f, { path: f.path(0) })
  assertBounded(page)
  assert.equal(page.kind, 'decisions')
  const descriptor = page.decisions[0]
  assert.equal(descriptor.detail_required, true)
  assert.equal(descriptor.state, null)
  assert.equal(descriptor.eligible, true, '完整材料低于96KiB，分页不应改变提取资格')
  assertIdentity(descriptor)
  assert.equal(descriptor.read_input.run_id, identity.run_id)
  assert.equal(descriptor.read_input.path, f.path(0))
  assert.equal(descriptor.read_input.source_sha256, page.source_sha256)
  assert.equal(descriptor.read_input.source_identity_sha256, page.source_identity_sha256)
  assert.match(descriptor.read_input.content_sha256, /^[0-9a-f]{64}$/)
  const full = await readAllFragments(f, descriptor.read_input)
  assert.ok(full.pages > 10)
  assertIdentity(full.decision)
  assert.equal(full.decision.decision_id, descriptor.decision_id)
  assert.equal(full.decision.state.messages.find(message => message.role === 'user').content, user)
  assert.deepEqual(full.decision.state.available_tools, tools)
  assert.equal(JSON.stringify(full.decision.state).includes('FUTURE_RESULT_A'), false)
  assert.equal(JSON.stringify(full.decision.state).includes('FUTURE_RESULT_B'), false)
  const first = await source(f, descriptor.read_input)
  await assert.rejects(source(f, { ...descriptor.read_input, cursor: first.next_cursor, source_sha256: undefined }), /摘要/)
  await assert.rejects(source(f, { ...descriptor.read_input, cursor: first.next_cursor, source_identity_sha256: undefined }), /来源身份摘要/)
  await assert.rejects(source(f, { ...descriptor.read_input, cursor: first.next_cursor, content_sha256: undefined }), /摘要/)
  await assert.rejects(source(f, { ...descriptor.read_input, cursor: first.next_cursor, content_sha256: '0'.repeat(64) }), /正文摘要/)
  write(join(f.root, f.base, 'evidence', f.caseId(0), 'checks.json'), JSON.stringify({ trace_available: false }))
  await assert.rejects(source(f, { ...descriptor.read_input, cursor: first.next_cursor }), /来源身份摘要|正文摘要/)
})

test('超过96KiB的材料可完整读取，但不能通过分页截断取得训练资格', async t => {
  const user = '原始超预算事实：' + 'x'.repeat(105000) + '；不得丢失的最后事实。'
  const f = fixture(t, { count: 1, largeUser: user })
  const page = await source(f, { path: f.path(0) })
  const descriptor = page.decisions[0]
  assertBounded(page)
  assert.equal(descriptor.detail_required, true)
  assert.equal(descriptor.eligible, false)
  const full = await readAllFragments(f, descriptor.read_input)
  assert.equal(full.decision.state.messages.find(message => message.role === 'user').content, user)
  assert.match(full.decision.limitations.join('\n'), /96 KiB/)
  await assert.rejects(preview(f, page), /材料不足|96 KiB|完整输入/)
})

test('目录、文件及预览拒绝伪造身份，Run清单必须与真实目录一致', async t => {
  const f = fixture(t)
  const page = await source(f, { path: f.path(0) })
  for (const forged of [{ agent_id: 'other' }, { experiment_id: 'EXP-alpha-002-r0123456789ab' }]) {
    await assert.rejects(source(f, forged), /身份/)
    await assert.rejects(source(f, { path: f.path(0), ...forged }), /身份/)
    await assert.rejects(preview(f, page, forged), /身份/)
    await assert.rejects(preview(f, page, { samples: [{ ...draft(page.decisions[0]), ...forged }] }), /身份/)
  }
  const manifestPath = join(f.root, f.base, 'run.yaml')
  for (const forged of [{ agent_id: 'other' }, { experiment_id: 'EXP-alpha-002-r0123456789ab' }, { run_id: 'run-22222222-2222-4222-8222-222222222222' }]) {
    write(manifestPath, f.manifest(forged))
    await assert.rejects(source(f), /身份/)
    await assert.rejects(source(f, { path: f.path(0) }), /身份/)
  }
  write(manifestPath, f.manifest())
  const directory = await source(f)
  const lockPath = join(f.root, f.base, 'inputs.lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')); lock.git_version.commit = 'c'.repeat(40)
  write(lockPath, JSON.stringify(lock))
  await assert.rejects(source(f, { cursor: 1, source_sha256: directory.source_sha256, source_identity_sha256: directory.source_identity_sha256 }), /摘要/)
})

test('文件决策页和正文续片同时绑定历史Candidate及dirty，即使trace和正文摘要不变也拒绝改绑', async t => {
  const f = fixture(t, { count: 1, largeUser: 'x'.repeat(50000) })
  const lockPath = join(f.root, f.base, 'inputs.lock.json'), original = readFileSync(lockPath, 'utf8')
  for (const mutation of [{ candidate_sha256: 'c'.repeat(64) }, { git_version: { ...sourceVersion.git_version, dirty: false } }]) {
    write(lockPath, original)
    const first = await source(f, { path: f.path(0), limit: 1 }), input = first.decisions[0].read_input
    assert.equal(first.next_cursor, 1)
    const fragment = await source(f, input)
    const nextPage = { path: first.path, source_sha256: first.source_sha256, source_identity_sha256: first.source_identity_sha256, cursor: first.next_cursor, limit: 1 }
    const nextFragment = { ...input, cursor: fragment.next_cursor }
    await assert.rejects(source(f, { ...nextPage, source_identity_sha256: undefined }), /来源身份摘要/)
    write(lockPath, JSON.stringify({ ...JSON.parse(original), ...mutation }))
    const changed = await source(f, { path: f.path(0), limit: 1 })
    assert.equal(changed.source_sha256, first.source_sha256, 'trace字节及其摘要不变')
    assert.equal(changed.decisions[0].content_sha256, first.decisions[0].content_sha256, '正文与标签可见输入不变')
    assert.notEqual(changed.source_identity_sha256, first.source_identity_sha256)
    await assert.rejects(source(f, nextPage), /来源身份摘要/)
    await assert.rejects(source(f, nextFragment), /来源身份摘要/)
    await assert.rejects(preview(f, first, { source_identity_sha256: first.source_identity_sha256 }), /来源身份摘要/)
  }
})

test('inputs.lock声明的Run、Agent及版本身份必须与实际Run及清单一致', async t => {
  const f = fixture(t, { count: 1 }), page = await source(f, { path: f.path(0) })
  const lockPath = join(f.root, f.base, 'inputs.lock.json'), original = readFileSync(lockPath, 'utf8')
  for (const forged of [{ run_id: 'run-22222222-2222-4222-8222-222222222222' }, { agent_id: 'other' }, { experiment_id: 'EXP-alpha-002-r0123456789ab' }]) {
    write(lockPath, JSON.stringify({ ...JSON.parse(original), ...forged }))
    await assert.rejects(source(f), /来源.*身份|身份.*Run/)
    await assert.rejects(source(f, { path: f.path(0) }), /来源.*身份|身份.*Run/)
    await assert.rejects(preview(f, page), /来源.*身份|身份.*Run/)
  }
  write(lockPath, JSON.stringify({ ...JSON.parse(original), ...identity }))
  assertIdentity(await source(f, { path: f.path(0) }))
})

test('解码合同版本变化使完整来源身份过期，原始trace摘要保持不变', async t => {
  const f = fixture(t, { count: 1 }), first = await source(f, { path: f.path(0), limit: 1 })
  const output = join(buildRoot, 'datasets-next-decoder.mjs')
  await build({ entryPoints: [new URL('../src/evaluation/datasets.ts', import.meta.url).pathname], outfile: output, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'fixture-next-decoder-version', setup(builder) { builder.onLoad({ filter: /evaluation[\\/]trace\.ts$/ }, args => {
      const content = readFileSync(args.path, 'utf8'), declaration = /export const DECISION_TRACE_DECODER_VERSION = '[^']+'/
      assert.ok(declaration.test(content))
      return { contents: content.replace(declaration, "export const DECISION_TRACE_DECODER_VERSION = 'unit-fixture-next-decoder'"), loader: 'ts', resolveDir: dirname(args.path) }
    }) } }] })
  const next = (await import(`file://${output}`)).createDecisionDatasetHandler(f.root)
  const changed = await next('datasets/source', { run_id: identity.run_id, path: f.path(0), limit: 1 })
  assert.equal(changed.source_sha256, first.source_sha256)
  assert.equal(changed.source_bundle.sha256, first.source_bundle.sha256)
  assert.notEqual(changed.source_identity_sha256, first.source_identity_sha256)
  await assert.rejects(next('datasets/source', { run_id: identity.run_id, path: f.path(0), cursor: first.next_cursor,
    source_sha256: first.source_sha256, source_identity_sha256: first.source_identity_sha256 }), /来源身份摘要/)
})

test('新样本保存服务器来源和dirty历史版本，历史缺身份v2读取不改写原件', async t => {
  const f = fixture(t)
  const page = await source(f, { path: f.path(0) })
  const proposed = await preview(f, page, { source_version: { candidate_sha256: '0'.repeat(64), git_version: { commit: '0'.repeat(40), dirty: false } } })
  assertIdentity(proposed); assertIdentity(proposed.records[0]._meta)
  assert.deepEqual(proposed.records[0]._meta.source_version, sourceVersion)
  assert.equal(proposed.records[0].targets.route.status, 'suggested')
  assert.equal(proposed.records[0].targets.route.decision_time_reviewed, false)
  const saved = await f.handle('datasets/apply', { preview_id: proposed.preview_id, assistant_session_id: owner })
  assertIdentity(saved.dataset); assertIdentity(saved.dataset.records[0]._meta)
  assert.deepEqual(saved.dataset.source_version, sourceVersion)
  assert.deepEqual(saved.dataset.records[0]._meta.source_version, sourceVersion)
  assert.equal(saved.eligibility.counts.training, 0)
  const file = join(f.root, saved.file)
  const legacy = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['agent_id', 'experiment_id', 'source_version']) { delete legacy[key]; delete legacy.records[0]._meta[key] }
  write(file, JSON.stringify(legacy, null, 2) + '\n')
  const before = readFileSync(file, 'utf8')
  const read = await f.handle('datasets/read', { dataset_id: legacy.id })
  assert.equal(read.dataset.schema_version, 2)
  assert.equal(Object.hasOwn(read.dataset, 'agent_id'), false)
  assert.equal(Object.hasOwn(read.dataset.records[0]._meta, 'experiment_id'), false)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(read.sha256, hash(before))
})
