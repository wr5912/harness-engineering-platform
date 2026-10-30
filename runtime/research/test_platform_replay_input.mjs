import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { collectReplayInputs } from './platform-replay-input.mts'
import { redactRunText } from '../../platform/plugin/src/agents/run-files.ts'

// 隔离真实18120的HTTP边界；登录、Node客户端、信封校验、分页及文件写入均执行真实代码。
// 所有来源、账号、Cookie均为测试材料；不调用模型或训练，也不产生正式研究证据。
const sha = value => createHash('sha256').update(value).digest('hex')
const runId = 'run-11111111-1111-4111-8111-111111111111'
const experiment = 'EXP-security-operations-expert-024-r0123456789ab'
const path = `evolution/experiments/${experiment}/runs/${runId}/evidence/UNIT/trace.jsonl`
const sourceSha = sha('unit original trace bytes'), identitySha = sha('unit decoder and full source identity')
const datasetId = 'decision-dataset-11111111-1111-4111-8111-111111111111'
const secondDatasetId = 'decision-dataset-22222222-2222-4222-8222-222222222222'
const recordId = `decision-${'a'.repeat(32)}`, decisionId = `decision-${'b'.repeat(20)}`
const sourceVersion = { candidate_sha256: sha('unit dirty Candidate'), git_version: { commit: 'c'.repeat(40), dirty: true } }
const sourceFiles = [{ path, source_sha256: sourceSha }]
const bundle = { schema_version: 1, sha256: sha(JSON.stringify(sourceFiles)), files: sourceFiles, issues: [] }
const log = 'native-root.v4.jsonl', sessionId = 'session-unit-real-native-shape'
const ref = line => ({ path, line, session_log: log, event_id: null, seq: line === 1 ? null : line + 29, source_sha256: sourceSha, line_sha256: sha(`unit original line ${line}`) })

function documents() {
  const tools = [{ name: 'native-inspection-catalog', parameters: { type: 'object', properties: {} } }]
  const user = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '有哪些巡检目录？😀保留原文' }] }
  const state = { messages: [user], available_tools: tools, route: null }
  const observed = { name: tools[0].name, arguments: {} }
  const selected = { agent_id: 'security-operations-expert', experiment_id: experiment, run_id: runId, decision_id: decisionId,
    kind: 'tool_call', anchor: ref(6), eligible: true, state, observed_action: observed, context_mode: 'actual_request', limitations: [] }
  const content = JSON.stringify(selected), digest = sha(content)
  const request = { run_id: runId, path, source_sha256: sourceSha, source_identity_sha256: identitySha, decision_id: decisionId, content_sha256: digest, cursor: 0, limit: 4000 }
  const descriptor = { ...selected, state: null, observed_action: { name: observed.name }, detail_required: true,
    content_sha256: digest, total_characters: content.length, read_input: request }
  const other = { ...descriptor, decision_id: `decision-${'d'.repeat(20)}` }
  const record = { state, workflow: 'unit-source-workflow', task: { id: 'unit-original-question', semantics: 'recommended_decision' },
    questions: { old: { type: 'choice', criteria: { a: '目录', b: '澄清' } } }, targets: { old: { label: 'a', status: 'reviewed' } },
    _meta: { id: recordId, content_sha256: sha('original platform record bytes'), agent_id: selected.agent_id, experiment_id: experiment,
      run_id: runId, trace_path: path, trace_sha256: sourceSha, decision_id: decisionId, cutoff: selected.anchor,
      source_version: sourceVersion, source_group_id: 'unit-task-root', evidence_refs: [ref(3), ref(4)], observed_action: observed } }
  const dataset = { schema_version: 2, id: datasetId, agent_id: selected.agent_id, experiment_id: experiment, run_id: runId,
    path, source_sha256: sourceSha, source_bundle: bundle, source_version: sourceVersion, records: [record] }
  const rows = [
    { type: 'session', version: 4, id: sessionId, agentPreset: 'security-operations-expert', origin: 'web', isSeeded: false, delegationDepth: 0 },
    { type: 'turn/start', seq: 31, data: { turn: 1 } }, { type: 'user/message', seq: 32, data: user },
    { type: 'request/header', seq: 33, data: { header: { tools } } },
    { type: 'assistant/message', seq: 34, data: { turn: 1, step: 1, message: { content: [] } } },
    { type: 'tool/call', seq: 35, data: { turn: 1, step: 1, name: tools[0].name, arguments: {}, callId: 'native-call' } },
    { type: 'tool/result', seq: 36, data: { future: 'FUTURE_RESULT_MUST_NOT_ENTER_PREFIX' } },
  ].map((event, index) => ({ type: event.type, role: 'target', status: 'valid', event, ref: ref(index + 1) }))
  return { dataset, selected, descriptor, other, content, digest, rows }
}

async function fixture(t, mode = {}) {
  mkdirSync(resolve('.local'), { recursive: true })
  const root = mkdtempSync(resolve('.local/platform-replay-input-test-'))
  for (const directory of ['config', '.local/credentials']) mkdirSync(join(root, directory), { recursive: true })
  const workspace = { id: 'workspace-unit-collector', root, legacyRoots: [] }
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: workspace.id, legacyRoots: [] }))
  const password = 'UNIT_ONLY_ADMIN_PASSWORD', cookie = 'harness_platform_session=UNIT_ONLY_COOKIE'
  writeFileSync(join(root, '.local/credentials/admin.json'), JSON.stringify({ username: 'unit-user', password }), { mode: 0o600 })
  const config = { model: { provider: 'unit', model: '/unit/Qwen3.5-2B', repository: 'Qwen/Qwen3.5-2B', source_kind: 'modelscope', source_url: 'https://www.modelscope.cn/models/Qwen/Qwen3.5-2B', revision: 'unit-fixed' },
    constructor: { state_constructor_sha256: '1'.repeat(64), questions_source_sha256: '2'.repeat(64), language_understanding_source_sha256: '3'.repeat(64) },
    replay_source_sha256: '4'.repeat(64), native_tool_names: { inspection_catalog: 'native-inspection-catalog', schedule_list: 'schedule_list' } }
  const replayConfigFile = join(root, 'replay-config.json'); writeFileSync(replayConfigFile, JSON.stringify(config))
  const docs = documents(), requests = [], rawBodies = []
  let fragmentSplit
  if (mode.fragmentSecret) {
    // dataset本身仍安全；模拟来源服务意外把未脱敏内容拆在两个HTTP片段中。
    docs.selected = { ...docs.selected, state: { ...docs.selected.state, password: 'UNIT_FRAGMENT_LEFT_PART_RIGHT_PART_PRIVATE' } }
    docs.content = JSON.stringify(docs.selected); docs.digest = sha(docs.content)
    fragmentSplit = docs.content.indexOf('UNIT_FRAGMENT_LEFT_PART') + 'UNIT_FRAGMENT_LEFT_PART'.length
    docs.descriptor = { ...docs.descriptor, content_sha256: docs.digest, total_characters: docs.content.length,
      read_input: { ...docs.descriptor.read_input, content_sha256: docs.digest } }
    for (const fragment of [docs.content.slice(0, fragmentSplit), docs.content.slice(fragmentSplit)]) {
      const wire = JSON.stringify({ fragment })
      assert.deepEqual(JSON.parse(redactRunText(wire)), JSON.parse(wire), '单片必须不能独自识别完整凭据，才能覆盖跨片阻断')
    }
  }
  let logins = 0, active = 0, maxActive = 0, sourceHomeReads = 0
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    if (request.url === '/hep/login') {
      logins++
      const fields = new URLSearchParams(body)
      assert.equal(request.method, 'POST'); assert.equal(fields.get('username'), 'unit-user'); assert.equal(fields.get('password'), password)
      assert.equal(request.headers.origin, new URL(url).origin)
      response.writeHead(303, { 'set-cookie': `${cookie}; Path=/; HttpOnly`, location: '/hep/' }); response.end(); return
    }
    assert.equal(request.headers.cookie, cookie)
    const envelope = JSON.parse(body), { method, payload } = envelope
    assert.equal(envelope.type, 'client-request'); assert.equal(typeof envelope.rpcId, 'string')
    assert.equal(request.url, `/hep/harness-platform/${method}`)
    requests.push({ method, payload: structuredClone(payload) }); active++; maxActive = Math.max(maxActive, active)
    const value = (() => {
      if (method === 'inventory') return { root, workspace: { ...workspace, ...(mode.wrongWorkspace ? { id: 'workspace-other' } : {}) }, runs: [] }
      if (method === 'agents/datasets/list') return { datasets: [datasetId, secondDatasetId].map(id => ({ id, schema_version: 2, run_id: runId, path, count: 1 })) }
      if (method === 'agents/datasets/read') {
        const dataset = { ...docs.dataset, id: payload.dataset_id }
        if (mode.unsafeBody) dataset.records = [{ ...dataset.records[0], unit_password: 'UNIT_REAL_LOOKING_SECRET_MUST_NOT_BE_SAVED' }]
        return { dataset, sha256: sha(`unit original platform file ${payload.dataset_id}`), eligibility: { status: 'ready' } }
      }
      if (method === 'agents/datasets/source') {
        if (!payload.decision_id && (payload.cursor ?? 0) === 0) sourceHomeReads++
        const common = { agent_id: docs.selected.agent_id, experiment_id: experiment, run_id: runId, path, source_sha256: sourceSha,
          source_identity_sha256: mode.finalSourceIdentity && sourceHomeReads > 1 ? sha('identity changed after native prefix was read') : identitySha, source_version: sourceVersion }
        if (payload.decision_id) {
          const cursor = payload.cursor ?? 0
          let end = fragmentSplit ? cursor === 0 ? fragmentSplit : docs.content.length : Math.min(docs.content.length, cursor + 73)
          if (end < docs.content.length && /[\uD800-\uDBFF]/.test(docs.content[end - 1])) end--
          const next = end < docs.content.length ? end : null
          return { kind: 'decision_fragment', ...common, decision_id: decisionId, content_sha256: docs.digest,
            content_format: 'json', total_characters: docs.content.length, cursor, next_cursor: mode.fragmentStuck ? cursor : next,
            complete: next === null, fragment: mode.fragmentCorrupt && cursor > 0 ? '!' + docs.content.slice(cursor + 1, end) : docs.content.slice(cursor, end),
            ...(mode.fragmentIdentity && cursor > 0 ? { source_identity_sha256: sha('changed manifest identity') } : {}),
            read_input: next === null ? null : { ...payload, cursor: mode.fragmentStuck ? cursor : end, source_sha256: sourceSha, source_identity_sha256: identitySha, content_sha256: docs.digest } }
        }
        const cursor = payload.cursor ?? 0
        return { kind: 'decisions', ...common, total_decisions: 2, cursor, next_cursor: cursor === 0 ? 1 : null,
          decisions: [cursor === 0 ? docs.other : docs.descriptor], source_bundle: bundle,
          ...(cursor === 0 ? { extraction_contract: { source: { decoder_version: 'decision-trace-lineage-v1' } } } : {}), warnings: [] }
      }
      if (method === 'agents/runs/trace') {
        const cursor = payload.cursor ?? 0, end = Math.min(docs.rows.length, cursor + Math.min(payload.limit ?? 80, 3))
        return { run_id: runId, path, source_sha256: sourceSha, files: [{ path }], source: { path, role: 'target', collection_status: 'available', root_identity: { session_id: sessionId, session_log: log, agent_preset: 'security-operations-expert' } },
          events: docs.rows.slice(cursor, end), decisions: [], total_lines: docs.rows.length, next_cursor: end < docs.rows.length ? end : null, warnings: [] }
      }
      throw new Error(`UNEXPECTED_FIXTURE_ENDPOINT:${method}`)
    })()
    const raw = JSON.stringify({ type: 'server-response', rpcId: mode.wrongRpcId ? 'wrong-rpc' : envelope.rpcId, result: { ok: true, value } }, null, 2) + '\n'
    rawBodies.push(raw)
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(raw); active--
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/hep/`
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, gateway: { managementUrl: url } }))
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }) })
  const options = { url, assetRoot: root, datasetId, recordId, replayConfigFile, out: join(root, 'collected') }
  return { root, url, options, docs, requests, rawBodies, password, cookie, config, stats: () => ({ logins, maxActive }) }
}

function files(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)])
}
function allText(root) { return files(root).map(file => readFileSync(file, 'utf8')).join('\n') }
function assertPartial(out) {
  assert.equal(existsSync(join(out, 'input.json')), false)
  if (existsSync(join(out, 'manifest.json'))) assert.notEqual(JSON.parse(readFileSync(join(out, 'manifest.json'))).status, 'complete')
}

test('真实HTTP认证与完整来源分页保留原生引用、完整分片SHA和平台fileSha，Cookie不落证据', async t => {
  const f = await fixture(t)
  await collectReplayInputs(f.options)
  const saved = JSON.parse(readFileSync(join(f.options.out, 'input.json')))
  assert.equal(saved.input.readback.dataset.id, datasetId)
  assert.equal(saved.input.readback.sha256, sha(`unit original platform file ${datasetId}`))
  assert.notEqual(saved.input.readback.sha256, sha(JSON.stringify(saved.input.readback.dataset)))
  assert.deepEqual(saved.input.source_decision, f.docs.selected)
  assert.equal(sha(JSON.stringify(saved.input.source_decision)), f.docs.digest)
  assert.equal(saved.input.source_page.source_identity_sha256, identitySha)
  assert.deepEqual(saved.config, f.config)
  assert.deepEqual(saved.input.trace_pages.flatMap(page => page.events).map(row => row.ref), [1, 2, 3, 4, 5, 6].map(ref))
  assert.equal(JSON.stringify(saved.input.trace_pages).includes('FUTURE_RESULT_MUST_NOT_ENTER_PREFIX'), false)
  const requests = f.requests.filter(request => request.method === 'agents/datasets/source')
  assert.ok(requests.length > 3)
  assert.equal(requests[1].payload.source_identity_sha256, identitySha)
  for (const request of requests.filter(request => request.payload.decision_id && request.payload.cursor > 0)) {
    assert.equal(request.payload.content_sha256, f.docs.digest); assert.equal(request.payload.source_sha256, sourceSha)
  }
  const evidence = files(f.options.out).map(file => readFileSync(file, 'utf8'))
  assert.ok(f.rawBodies.every(raw => evidence.includes(raw)), '回执原body必须逐字保存，不以JSON重排结果冒充HTTP正文')
  const manifest = JSON.parse(readFileSync(join(f.options.out, 'manifest.json')))
  assert.equal(manifest.complete, true)
  for (const request of manifest.requests) assert.equal(request.response_body_sha256, sha(readFileSync(join(f.options.out, request.response_file))))
  assert.equal(manifest.records[0].platform_file_sha256, saved.input.readback.sha256)
  assert.equal(evidence.join('').includes(f.password), false); assert.equal(evidence.join('').includes(f.cookie), false)
  assert.equal(f.stats().logins, 1)
})

test('batch按Run读取真实批次，include_eligibility:false且复用一个客户端顺序取证', async t => {
  const f = await fixture(t), options = { ...f.options, runId, datasetId: undefined, recordId: undefined }
  await collectReplayInputs(options)
  const listed = f.requests.find(request => request.method === 'agents/datasets/list')
  assert.deepEqual(listed.payload, { run_id: runId, include_eligibility: false })
  const outputs = files(options.out).filter(file => file.endsWith('/input.json'))
  assert.equal(outputs.length, 2)
  assert.deepEqual(outputs.map(file => JSON.parse(readFileSync(file)).input.readback.dataset.id).sort(), [datasetId, secondDatasetId].sort())
  assert.equal(f.stats().logins, 1); assert.equal(f.stats().maxActive, 1)
})

test('URL登记错配先拒绝登录，在线workspace错配不继续读样本', async t => {
  const wrongUrl = await fixture(t)
  await assert.rejects(collectReplayInputs({ ...wrongUrl.options, url: wrongUrl.url.replace('/hep/', '/other/') }), /PLATFORM_MANAGEMENT_URL_MISMATCH/)
  assert.equal(wrongUrl.stats().logins, 0)
  const wrongWorkspace = await fixture(t, { wrongWorkspace: true })
  await assert.rejects(collectReplayInputs(wrongWorkspace.options), /ONLINE_WORKSPACE_MISMATCH/)
  assert.equal(wrongWorkspace.requests.some(request => request.method === 'agents/datasets/read'), false)
  assertPartial(wrongWorkspace.options.out)
})

test('完整分片正文篡改不能通过descriptor摘要，partial保留且不生成可用input', async t => {
  const f = await fixture(t, { fragmentCorrupt: true })
  await assert.rejects(collectReplayInputs(f.options), /FRAGMENT_CONTENT_SHA_MISMATCH/)
  assertPartial(f.options.out)
  assert.ok(files(f.options.out).length > 0)
})

test('分片来源身份漂移或无进展cursor拒绝，不能缓存伪装完整来源', async t => {
  for (const mode of [{ fragmentIdentity: true }, { fragmentStuck: true }]) {
    const f = await fixture(t, mode)
    await assert.rejects(collectReplayInputs(f.options), /FRAGMENT_/)
    assertPartial(f.options.out)
    assert.ok(f.requests.length < 20, '无进展不得无限读取')
  }
})

test('公开回执含未脱敏secret时阻断，不把真实秘密或修改后的投影作为原HTTP证据保存', async t => {
  const f = await fixture(t, { unsafeBody: true })
  await assert.rejects(collectReplayInputs(f.options), /RPC_RESPONSE_UNSAFE/)
  assertPartial(f.options.out)
  assert.equal(allText(f.options.out).includes('UNIT_REAL_LOOKING_SECRET_MUST_NOT_BE_SAVED'), false)
  assert.equal(allText(f.options.out).includes(f.password), false)
  const manifest = JSON.parse(readFileSync(join(f.options.out, 'manifest.json')))
  const blocked = manifest.requests.at(-1)
  assert.equal(blocked.response_body_saved, false)
  assert.equal(Object.hasOwn(blocked, 'response_body_sha256'), false)
})

test('真实RPC信封rpcId错配不能作为成功回执使用', async t => {
  const f = await fixture(t, { wrongRpcId: true })
  await assert.rejects(collectReplayInputs(f.options), /COLLECTION_FAILED/)
  assert.equal(f.requests.length, 1)
  assertPartial(f.options.out)
})

test('跨分片才可识别的秘密在完整检查失败后，全部fragment正文与秘密片段均不落证据', async t => {
  const f = await fixture(t, { fragmentSecret: true })
  await assert.rejects(collectReplayInputs(f.options), /DECISION_CONTENT_UNSAFE/)
  assertPartial(f.options.out)
  const evidence = allText(f.options.out)
  assert.equal(evidence.includes('UNIT_FRAGMENT_LEFT_PART'), false)
  assert.equal(evidence.includes('_RIGHT_PART_PRIVATE'), false)
  const manifest = JSON.parse(readFileSync(join(f.options.out, 'manifest.json')))
  const fragmentRequests = manifest.requests.filter(request => request.endpoint === 'agents/datasets/source' && !request.response_body_saved)
  assert.equal(fragmentRequests.length, 2)
  for (const request of fragmentRequests) {
    assert.equal(Object.hasOwn(request, 'response_file'), false)
    assert.equal(Object.hasOwn(request, 'response_body_sha256'), false)
  }
})

test('最终native prefix读取后来源身份变化仍拒绝，不把先前缓存当作当前稳定来源', async t => {
  const f = await fixture(t, { finalSourceIdentity: true })
  await assert.rejects(collectReplayInputs(f.options), /SOURCE_CHANGED_DURING_COLLECTION/)
  assertPartial(f.options.out)
  const trace = f.requests.filter(request => request.method === 'agents/runs/trace')
  assert.deepEqual(trace.map(request => request.payload.cursor), [0, 3])
  assert.equal(f.requests.at(-1).method, 'agents/datasets/source')
  assert.equal(f.requests.at(-1).payload.cursor, 0)
  const manifest = JSON.parse(readFileSync(join(f.options.out, 'manifest.json')))
  assert.equal(manifest.complete, false)
  assert.equal(manifest.records.length, 0)
})

test('同名out不能覆盖先前取证，Run与dataset身份不能同时选择', async t => {
  const f = await fixture(t)
  await collectReplayInputs(f.options)
  const before = allText(f.options.out)
  await assert.rejects(collectReplayInputs(f.options), /OUTPUT_ALREADY_EXISTS/)
  assert.equal(allText(f.options.out), before)
  const other = { ...f.options, out: join(f.root, 'bad-select'), runId }
  await assert.rejects(collectReplayInputs(other), /SELECT_RUN_OR_DATASET_RECORD/)
  assert.equal(existsSync(join(other.out, 'input.json')), false)
})
