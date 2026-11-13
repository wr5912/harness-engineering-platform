import { seedThreatCompositions } from '../src/templates.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { build } from 'esbuild'

const incident = 'INC-20261015-000001'
const runId = 'run-12345678-1234-4234-8234-123456789012'
const root = process.env.HARNESS_ASSET_ROOT
const bindings = { socConnectionId: 'soc-test', reportConnectionId: 'report-test', model: { provider: 'test-provider', model: 'original-model', reasoningEffort: 'off' } }
const modulePromise = (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nested-composition-module-'))
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir')
  const outfile = join(dir, 'index.mjs')
  await build({ stdin: { contents: "export * from './src/mcp/index.ts'; export * from './src/mcp/compositions.ts'; export * from './src/mcp/nested.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm' })
  return import(outfile)
})()

async function setup(overrides = {}) {
  const module = await modulePromise
  const dir = await mkdtemp(join(tmpdir(), 'nested-composition-'))
  const file = join(dir, 'compositions.json')
  await writeFile(file, JSON.stringify({ schema_version: '1.0', compositions: [] }))
  const calls = []
  let result
  const runtime = {
    async execute(stage, actualBindings, input, signal) {
      calls.push({ stage, bindings: structuredClone(actualBindings), input: structuredClone(input), signal })
      if (stage === 'collect') result = { run_id: runId, incident_id: incident, judgement_id: 'judgement-1', status: 'evidence_ready', route: 'five_source', phase_status: 'completed', artifacts: [], trace: [] }
      const override = overrides[stage]
      if (override) result = await override(result, { stage, bindings: actualBindings, input, signal })
      else if (stage === 'infer') result = { ...result, status: 'completed', validation: { status: 'failed' }, phase_status: 'completed' }
      else if (stage === 'writeback') result = { ...result, storage: { summary: { status: 'saved', action: result.status === 'completed' ? 'result' : 'fail' } } }
      else if (stage === 'report') result = { ...result, delivery: { download_url: 'https://example.test/reports/basic.html', markdown: '基本模拟报告' } }
      return structuredClone(result)
    },
    async inspect(id) { assert.equal(id, runId); return result },
    async artifact(id, artifactId) { assert.equal(id, runId); assert.equal(artifactId, 'report.html'); return { filename: 'report.html', contentType: 'text/html', body: '<h1>基本模拟报告</h1>' } },
  }
  const handler = module.createMcpHandler(dir, { compositionsFile: file, servers: () => [{ id: 'soc-test', url: 'http://127.0.0.1:1/soc', enabled: true }, { id: 'report-test', url: 'http://127.0.0.1:1/report', enabled: true }], extension: { id: 'fixture-security', threat: runtime, seed: seedThreatCompositions } })
  const rpc = (endpoint, payload, signal = new AbortController().signal) => handler(endpoint, payload, signal, undefined)
  const listed = await rpc('list', {})
  const seeded = await rpc('seedThreatCompositions', { revision: listed.value.revision, bindings })
  assert.equal(seeded.ok, true)
  return { module, dir, file, calls, rpc, handler, seeded: seeded.value }
}

async function publishChildren(fixture) {
  let listed = fixture.seeded
  for (const id of ['threat-collect', 'threat-infer', 'threat-writeback', 'threat-report']) {
    const response = await fixture.rpc('publishComposition', { compositionId: id, version: 'draft', revision: listed.revision, input: id === 'threat-collect' ? { incident_id: incident } : { run_id: runId } })
    assert.equal(response.ok, true, JSON.stringify(response))
    listed = response.value
  }
  return listed
}

async function publishParent(fixture) {
  let listed = await publishChildren(fixture)
  const parent = listed.compositions.find(entry => entry.id === 'threat-analysis')
  const draft = { ...parent.draft, steps: parent.draft.steps.map(step => ({ ...step, versionId: listed.compositions.find(entry => entry.id === step.compositionId).publishedVersionId })) }
  listed = (await fixture.rpc('saveCompositionDraft', { compositionId: parent.id, draft, revision: listed.revision })).value
  const published = await fixture.rpc('publishComposition', { compositionId: parent.id, version: 'draft', revision: listed.revision, input: { incident_id: incident } })
  assert.equal(published.ok, true, JSON.stringify(published))
  assert.deepEqual(fixture.calls, [], '发布只做结构校验，不应认领、调模型或保存报告')
  return published.value
}

test('模板仅创建五个草稿，父发布要求具体子版本，图来自已选子组合', async () => {
  const originalBindings = structuredClone(bindings)
  const f = await setup()
  assert.equal(f.seeded.compositions.length, 5)
  assert.ok(f.seeded.compositions.every(entry => entry.draft && !entry.published))
  for (const entry of f.seeded.compositions.filter(entry => entry.draft.kind === 'threat-stage')) {
    assert.deepEqual(entry.draft.bindings, entry.draft.stage === 'infer' ? originalBindings : { socConnectionId: bindings.socConnectionId, reportConnectionId: bindings.reportConnectionId })
  }
  assert.deepEqual(bindings, originalBindings, '模板不得修改调用方传入的公共绑定对象')
  const early = await f.rpc('publishComposition', { compositionId: 'threat-analysis', version: 'draft', revision: f.seeded.revision, input: { incident_id: incident } })
  assert.equal(early.ok, false)
  assert.match(early.error.message, /子组合已下架或删除/)
  const published = await publishParent(f)
  const entry = published.compositions.find(item => item.id === 'threat-analysis')
  assert.equal(entry.versions.length, 1)
  assert.deepEqual(entry.graphs.published.nodes.filter(node => node.operationId).map(node => node.id), ['collect', 'infer', 'writeback', 'report'])
  assert.equal(entry.graphs.published.nodes.find(node => node.id === 'infer').when, 'five_source')
  assert.equal(entry.published.steps[1].inputMap.run_id, '$steps.collect.run_id')
})

test('固定发布版本调用执行原版本，缺少版本或名称不匹配不调用上游', async () => {
  const f = await setup()
  let listed = await publishChildren(f)
  const original = listed.compositions.find(entry => entry.id === 'threat-collect')
  listed = (await f.rpc('saveCompositionDraft', { compositionId: original.id, revision: listed.revision,
    draft: { ...original.published, title: '后来发布的采集阶段' } })).value
  listed = (await f.rpc('publishComposition', { compositionId: original.id, version: 'draft', revision: listed.revision, input: { incident_id: incident } })).value
  const current = listed.compositions.find(entry => entry.id === original.id)
  assert.notEqual(current.publishedVersionId, original.publishedVersionId)
  const request = { toolName: original.published.toolName, compositionId: original.id, versionId: original.publishedVersionId, input: { incident_id: incident } }
  const frozen = await f.rpc('callPublishedComposition', request)
  assert.equal(frozen.ok, true, JSON.stringify(frozen))
  assert.equal(frozen.value.version.versionId, original.publishedVersionId)
  const latest = await f.rpc('callPublishedComposition', { toolName: request.toolName, input: request.input })
  assert.equal(latest.value.version.versionId, current.publishedVersionId)
  assert.equal(f.calls.length, 2)
  for (const invalid of [{ ...request, versionId: undefined }, { ...request, versionId: '0'.repeat(64) }, { ...request, toolName: 'other_tool' }]) {
    assert.equal((await f.rpc('callPublishedComposition', invalid)).ok, false)
  }
  assert.equal(f.calls.length, 2, '无效固定引用不能退回执行当前版本')
})

test('快判跳过完整模型阶段，回写失败仍保存报告；共享同一运行', async () => {
  const f = await setup({ collect: result => ({ ...result, route: 'fast_classification', status: 'completed' }), writeback: result => ({ ...result, phase_status: 'failed', storage: { summary: { status: 'failed' } } }) })
  await publishParent(f)
  const response = await f.rpc('callPublishedComposition', { toolName: 'analyze_threat_incident', input: { incident_id: incident } })
  assert.equal(response.ok, true)
  assert.equal(response.value.ok, false)
  assert.deepEqual(f.calls.map(call => call.stage), ['collect', 'writeback', 'report'])
  assert.ok(f.calls.slice(1).every(call => call.input.run_id === runId))
  assert.equal(response.value.result.trace.find(step => step.step === 'infer').status, 'skipped')
  assert.equal(response.value.result.trace.find(step => step.step === 'writeback').status, 'failed')
  assert.equal(response.value.result.delivery.download_url, 'https://example.test/reports/basic.html')
})

test('完整路径调用四个真实子图，可解析但校验失败仍进入回写和报告', async () => {
  const f = await setup()
  await publishParent(f)
  const client = f.module.createPublishedCompositionClient(f.dir, f.handler)
  const tools = (await client.listTools()).tools
  assert.equal(tools.length, 8)
  assert.equal(tools.filter(tool => tool.annotations.readOnlyHint === false).length, 5)
  assert.equal(tools.filter(tool => tool.annotations.readOnlyHint === true).length, 3)
  assert.deepEqual(tools.find(tool => tool.name === 'analyze_threat_incident').inputSchema.required, ['incident_id'])
  const called = await client.callTool({ name: 'analyze_threat_incident', arguments: { incident_id: incident } })
  const value = JSON.parse(called.content[0].text)
  assert.equal(called.isError, false)
  assert.deepEqual(f.calls.map(call => call.stage), ['collect', 'infer', 'writeback', 'report'])
  assert.equal(value.result.validation.status, 'failed')
  assert.equal(value.result.storage.summary.action, 'result')
  assert.equal((await f.rpc('compositionRun', { run_id: runId })).value.run_id, runId)
  assert.deepEqual((await f.rpc('compositionArtifact', { run_id: runId, artifactId: 'report.html' })).value, { filename: 'report.html', contentType: 'text/html', body: '<h1>基本模拟报告</h1>' })
  const invalid = await client.callTool({ name: 'threat_infer', arguments: { run_id: runId, judgement_id: 'forged' } })
  assert.equal(invalid.isError, true)
  assert.equal(f.calls.length, 4)
})

test('已认领的失败只进失败回写；认领失败不调用后续阶段', async () => {
  for (const claimed of [true, false]) {
    const f = await setup({ collect: result => ({ ...result, judgement_id: claimed ? 'judgement-1' : undefined, status: claimed ? 'evidence_failed' : 'claim_failed', phase_status: 'failed' }) })
    await publishParent(f)
    const response = await f.rpc('callPublishedComposition', { toolName: 'analyze_threat_incident', input: { incident_id: incident } })
    assert.equal(response.ok, true)
    assert.equal(response.value.ok, false)
    assert.deepEqual(f.calls.map(call => call.stage), claimed ? ['collect', 'writeback'] : ['collect'])
    if (claimed) assert.equal(response.value.result.storage.summary.action, 'fail')
  }
})

test('全部条件跳过时不调用子组合、不捏造运行身份，已发布MCP返回受控失败', async () => {
  const f = await setup()
  const parent = f.seeded.compositions.find(entry => entry.id === 'threat-analysis')
  const saved = await f.rpc('saveCompositionDraft', { compositionId: parent.id, revision: f.seeded.revision,
    draft: { ...parent.draft, steps: parent.draft.steps.map(step => step.id === 'collect' ? { ...step, when: 'claimed' } : step) },
  })
  assert.equal(saved.ok, true)
  f.seeded = saved.value
  await publishParent(f)
  const client = f.module.createPublishedCompositionClient(f.dir, f.handler)
  const tool = (await client.listTools()).tools.find(item => item.name === 'analyze_threat_incident')
  const called = await client.callTool({ name: tool.name, arguments: { incident_id: incident } })
  const value = JSON.parse(called.content[0].text)
  assert.equal(called.isError, true)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'composition_not_executed')
  assert.deepEqual(f.calls, [])
  assert.deepEqual(value.result.stepValues, {})
  assert.ok(value.result.trace.every(step => step.status === 'skipped'))
  assert.equal(Object.hasOwn(value.result, 'run_id'), false)
  assert.deepEqual(value.version.definition.outputSchema.required, ['stepValues', 'trace'])
})

test('图状态保留ID在保存前拒绝且目录保持可读；未选择子版本的普通草稿仍可保存', async () => {
  const f = await setup()
  const parent = f.seeded.compositions.find(entry => entry.id === 'threat-analysis')
  assert.ok(parent.draft.steps.every(step => step.versionId === ''))
  const saved = await f.rpc('saveCompositionDraft', { compositionId: parent.id, revision: f.seeded.revision, draft: parent.draft })
  assert.equal(saved.ok, true)
  assert.ok(saved.value.compositions.every(entry => !entry.published))
  const before = await readFile(f.file, 'utf8')
  for (const reserved of ['input', 'stepValues', 'latest', 'trace', 'receipts', 'errors', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
    const rejected = await f.rpc('saveCompositionDraft', { compositionId: parent.id, revision: saved.value.revision,
      draft: { ...parent.draft, steps: parent.draft.steps.map((step, index) => index ? step : { ...step, id: reserved }) },
    })
    assert.equal(rejected.ok, false, reserved)
    assert.match(rejected.error.message, /保留字段/)
    assert.equal(await readFile(f.file, 'utf8'), before, reserved)
    const listed = await f.rpc('list', {})
    assert.equal(listed.ok, true, reserved)
    assert.equal(listed.value.revision, saved.value.revision, reserved)
    assert.equal(listed.value.compositions.length, 5)
  }
  assert.deepEqual(f.calls, [])
})

test('已发布父引用固定子版本，新子草稿与新发布均不漂移；旧快照不可覆盖', async () => {
  const f = await setup()
  let listed = await publishParent(f)
  const original = listed.compositions.find(entry => entry.id === 'threat-infer')
  const updated = { ...original.published, title: '新研判阶段', bindings: { ...bindings, model: { ...bindings.model, model: 'new-model' } } }
  listed = (await f.rpc('saveCompositionDraft', { compositionId: original.id, draft: updated, revision: listed.revision })).value
  listed = (await f.rpc('publishComposition', { compositionId: original.id, version: 'draft', revision: listed.revision, input: { run_id: runId } })).value
  assert.equal(listed.compositions.find(entry => entry.id === original.id).versions.length, 2)
  const parent = listed.compositions.find(entry => entry.id === 'threat-analysis')
  assert.equal(parent.published.steps[1].versionId, original.publishedVersionId)
  await f.rpc('callPublishedComposition', { toolName: 'analyze_threat_incident', input: { incident_id: incident } })
  assert.equal(f.calls.find(call => call.stage === 'infer').bindings.model.model, 'original-model')
  const { catalog, revision } = f.module.readCompositions(f.file)
  catalog.compositions.find(entry => entry.id === original.id).versions.shift()
  assert.throws(() => f.module.writeCompositions(f.file, catalog, revision), /不可修改或移除/)
})

test('原生发布客户端取消传入阶段，已认领失败使用独立有界信号收尾一次', async () => {
  const f = await setup({ collect: async (result, { signal }) => {
    assert.equal(signal.aborted, false)
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    return { ...result, status: 'evidence_failed', phase_status: 'unknown' }
  } })
  await publishParent(f)
  const controller = new AbortController()
  const client = f.module.createPublishedCompositionClient(f.dir, f.handler)
  const pending = client.callTool({ name: 'analyze_threat_incident', arguments: { incident_id: incident } }, { signal: controller.signal })
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await pending
  assert.deepEqual(f.calls.map(call => call.stage), ['collect', 'writeback'])
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(f.calls[1].signal.aborted, false)
})

test('阶段叶子明确报告失败、未知及认领409；完成后的软校验失败保持成功', async () => {
  const cases = [
    { name: '业务阶段失败', stage: 'infer', result: { status: 'model_failed', phase_status: 'failed' }, ok: false },
    { name: '模型响应未知', stage: 'infer', result: { status: 'model_failed', phase_status: 'unknown' }, ok: false },
    { name: '认领409', stage: 'collect', result: { status: 'claim_failed', phase_status: 'failed', error_code: 409, judgement_id: undefined }, ok: false },
    { name: '认领业务失败不能被阶段completed掩盖', stage: 'collect', result: { status: 'claim_failed', phase_status: 'completed', error_code: 409, judgement_id: undefined }, ok: false },
    { name: '已完成但输出校验失败', stage: 'infer', result: { status: 'completed', phase_status: 'completed', validation: { status: 'failed' } }, ok: true },
  ]
  for (const item of cases) {
    const f = await setup({ [item.stage]: result => ({ ...result, ...item.result }) })
    await publishChildren(f)
    if (item.stage !== 'collect') await f.rpc('callPublishedComposition', { toolName: 'threat_collect', input: { incident_id: incident } })
    const client = f.module.createPublishedCompositionClient(f.dir, f.handler)
    const called = await client.callTool({ name: `threat_${item.stage}`, arguments: item.stage === 'collect' ? { incident_id: incident } : { run_id: runId } })
    const value = JSON.parse(called.content[0].text)
    assert.equal(value.ok, item.ok, item.name)
    assert.equal(called.isError, !item.ok, item.name)
    assert.equal(value.result.status, item.result.status, item.name)
    assert.equal(value.result.phase_status, item.result.phase_status, item.name)
    if (item.result.validation) assert.deepEqual(value.result.validation, item.result.validation)
    if (item.result.error_code) assert.equal(value.result.error_code, 409)
  }
})

test('拒绝循环、未来输出引用、额外参数和重复认领阶段', async () => {
  const module = await modulePromise
  const leaf = { toolName: 'collect', title: '取证', description: '', connectionId: 'platform-compositions', kind: 'threat-stage', stage: 'collect', bindings }
  const catalog = { schema_version: '1.0', compositions: [{ id: 'leaf', versions: [{ versionId: 'v1', config: leaf }] }] }
  const step = { id: 'collect', compositionId: 'leaf', versionId: 'v1', inputMap: { incident_id: '$input.incident_id' } }
  const composite = { toolName: 'parent', title: '父组合', description: '', connectionId: 'platform-compositions', kind: 'composite', steps: [step] }
  assert.throws(() => module.validateNested({ ...composite, steps: [{ ...step, inputMap: { incident_id: '$steps.future.incident_id' } }] }, catalog), /前序/)
  assert.throws(() => module.validateNested({ ...composite, steps: [{ ...step, inputMap: { incident_id: '$input.incident_id', arbitrary: true } }] }, catalog), /未声明字段/)
  assert.throws(() => module.validateNested({ ...composite, steps: [step, { ...step, id: 'again' }] }, catalog), /不能重复/)
  const recursive = { ...composite, steps: [{ ...step, compositionId: 'parent' }] }
  assert.throws(() => module.validateNested(recursive, { schema_version: '1.0', compositions: [{ id: 'parent', versions: [{ versionId: 'v1', config: recursive }] }] }), /循环/)
})
