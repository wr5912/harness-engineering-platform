import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runtimeRequire } from '../adapters/dsh-web/src/resolve-runtime.ts'
import { finalizeIRReview } from './ir-review.mts'
import { answersReadback, inputOf, IR_REVIEW_FRAGMENT_CHARACTERS, materialCommand, materialPacket, readbackCommand, sha256Text as sha } from './ir-review-evidence.mts'

// 本测试只替换HTTP/WS服务边界；实际运行公开DSH Node客户端、原生mux和分页协议。
// 所有账户、事件和模型身份均为合成材料，不构成真实18120的复核证据。
const helper = resolve('runtime/research/ir-review.mts'), session = 'synthetic-ir-review-session'
const model = { provider: 'synthetic-provider', model: 'synthetic-review-model', reasoningEffort: 'high' }
const gatewayRequire = createRequire(runtimeRequire('@deepseek-ai/dsh-api-gateway').resolve('@deepseek-ai/dsh-api-gateway'))
const { WebSocketServer } = (await import(pathToFileURL(gatewayRequire.resolve('ws')).href)).default

function files(root) { return existsSync(root) ? readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]) : [] }
function allText(root) { return files(root).map(file => readFileSync(file, 'utf8')).join('\n') }
async function fixture(t, mode = {}) {
  mkdirSync(resolve('.local'), { recursive: true })
  const root = mkdtempSync(resolve('.local/ir-review-test-'))
  for (const directory of ['config', '.local/credentials']) mkdirSync(join(root, directory), { recursive: true })
  const workspace = { id: 'workspace-synthetic-ir-review', root, legacyRoots: [] }
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: workspace.id, legacyRoots: [] }))
  const password = 'SYNTHETIC_ONLY_ADMIN_PASSWORD', cookie = 'harness_platform_session=SYNTHETIC_ONLY_COOKIE'
  writeFileSync(join(root, '.local/credentials/admin.json'), JSON.stringify({ username: 'synthetic-user', password }), { mode: 0o600 })
  const irFile = join(root, 'original-ir.jsonl'), idsFile = join(root, 'admitted-ids.json'), answersFile = join(root, 'answers.jsonl')
  const row = { sample_id: 'synthetic-sample-1', decision_site_id: 'main_route.route', contract_version: 'synthetic-contract', state: { user_text: '精确独立材料🦉'.repeat(360) },
    question: { type: 'choice', instructions: '按当前问题判断', criteria: { ask: '需要澄清', answer: '直接回答' } }, label: { status: 'unlabeled', value: null },
    observed_action: { name: 'DO_NOT_EXPOSE_OLD_ACTION' }, provenance: { source_group_id: 'synthetic-source-family', trace_sha256: 'a'.repeat(64) } }
  const ir = JSON.stringify(row) + '\n', ids = JSON.stringify([row.sample_id]), answer = { sample_id: row.sample_id, status: 'verified', value: 'ask', basis: '根据完整材料及当前候选独立判断。' }, answers = JSON.stringify(answer) + '\n'
  writeFileSync(irFile, ir); writeFileSync(idsFile, ids); writeFileSync(answersFile, answers)
  const events = [], append = (type, data) => events.push({ seq: events.length, time: 1 + events.length, type, data })
  const call = (name, args) => { const id = 'synthetic-call-' + events.length; append('tool/call', { callId: id, name, arguments: args }); return id }
  const result = (id, text) => append('tool/result', { message: { role: 'tool', toolCallId: id, isError: false, source: { kind: 'tool', callId: id }, content: [{ type: 'text', text }] } })
  append('request/header', { header: { config: { ...model, private_configuration: 'PRIVATE_NATIVE_HEADER_DO_NOT_PERSIST' }, system: 'PRIVATE_NATIVE_SYSTEM_DO_NOT_PERSIST' } })
  const context = call('platform_agents', { action: 'context', input: {} })
  result(context, JSON.stringify({ ok: true, value: { assistant: { session_id: session, model: mode.wrongActor ? { ...model, model: 'forged' } : model } } }))
  let cursor = 0
  while (cursor !== null) {
    const packet = materialPacket(ir, irFile, sha(ir), row.sample_id, cursor)
    if (mode.missingLast && packet.complete) break
    const id = call('bash', { command: materialCommand(helper, irFile, sha(ir), row.sample_id, cursor) })
    result(id, JSON.stringify(packet)); cursor = packet.next_cursor
  }
  append('step/start', { id: 'new-step-after-complete-input' })
  const write = call('write', { file_path: answersFile, content: answers })
  result(write, `<path>${answersFile}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`)
  const read = call('bash', { command: readbackCommand(helper, answersFile) })
  result(read, JSON.stringify({ ...answersReadback(answers, answersFile), ...(mode.wrongReadback ? { file_sha256: 'f'.repeat(64) } : {}) }))
  if (mode.hiddenHistoryGap) events.splice(2, 1)
  const cursorCut = events.at(-1).seq, requests = [], sockets = new Set()
  let logins = 0, followCount = 0
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    if (request.url === '/hep/login') {
      logins++; assert.equal(new URLSearchParams(raw).get('password'), password)
      assert.equal(request.headers.origin, new URL(url).origin)
      response.writeHead(303, { 'set-cookie': cookie + '; Path=/; HttpOnly', location: '/hep/' }); response.end(); return
    }
    assert.equal(request.headers.cookie, cookie); assert.equal(request.headers.origin, new URL(url).origin)
    const envelope = JSON.parse(raw), { method, payload } = envelope
    requests.push({ url: request.url, method, payload })
    let rpcResult
    if (request.url === '/hep/harness-platform/inventory') rpcResult = { ok: true, value: { root, workspace } }
    else {
      assert.equal(request.url, '/hep/api/session/page'); assert.equal(method, 'session/page')
      const q = payload.args.request
      assert.equal(q.throughSeq, cursorCut, '分页cut必须取自follow开帧')
      assert.deepEqual(q.address, { kind: 'session', sessionId: session })
      const before = events.filter(e => e.seq < q.beforeSeq), selected = before.slice(-3)
      rpcResult = { ok: true, value: { records: selected.map(event => ({ type: 'event', event })), hasMore: before.length > selected.length } }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: rpcResult }))
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.url, '/hep/api/remote.mux'); assert.equal(request.headers.cookie, cookie); assert.equal(request.headers.origin, new URL(url).origin)
    wss.handleUpgrade(request, socket, head, ws => { sockets.add(ws); ws.on('close', () => sockets.delete(ws)); wss.emit('connection', ws, request) })
  })
  wss.on('connection', ws => ws.on('message', raw => {
    const frame = JSON.parse(raw.toString())
    if (frame.type !== 'open') return
    followCount++; assert.equal(frame.endpoint, 'session/follow'); assert.equal(frame.payload.args.request.address.sessionId, session)
    const records = events.slice(-3).map(event => ({ type: 'event', event }))
    ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'snapshot', header: { version: 4, id: session, createdAt: 1, isSeeded: false },
      cursor: cursorCut, records, hasMore: events.length > records.length, projections: { asOfSeq: cursorCut, values: {} } } }))
  }))
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/hep/`
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ gateway: { managementUrl: url } }))
  t.after(async () => { for (const socket of sockets) socket.terminate(); wss.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }) })
  const options = { url, assetRoot: root, sessionId: session, helperPath: helper, irFile, expectedIRSha256: sha(ir), sampleIdsFile: idsFile, expectedIdsSha256: sha(ids),
    answersFile, expectedAnswersSha256: sha(answers), out: join(root, 'finalized') }
  return { root, irFile, ir, row, answersFile, answers, options, requests, events, password, cookie, stats: () => ({ logins, followCount }) }
}

test('material/readback通过真实CLI给出可拼接精确材料与答案字节摘要，隐藏旧监督', async t => {
  const f = await fixture(t)
  let cursor = 0, text = '', continuations = 0
  while (cursor !== null) {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', helper, 'material', f.irFile, sha(f.ir), f.row.sample_id, String(cursor)], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const packet = JSON.parse(child.stdout); assert.ok(packet.fragment.length <= IR_REVIEW_FRAGMENT_CHARACTERS)
    if (packet.next_cursor !== null) {
      continuations++; assert.equal(packet.next_read_command, materialCommand(helper, f.irFile, sha(f.ir), f.row.sample_id, packet.next_cursor))
    } else assert.equal(Object.hasOwn(packet, 'next_read_command'), false)
    text += packet.fragment; cursor = packet.next_cursor
  }
  assert.ok(continuations > 0, '长题仍需明确可执行的同绑定续读命令')
  assert.equal(text, inputOf(f.row)); assert.doesNotMatch(text, /DO_NOT_EXPOSE_OLD_ACTION|observed_action|unlabeled/)
  const rb = spawnSync(process.execPath, ['--experimental-strip-types', helper, 'readback', f.answersFile], { encoding: 'utf8' })
  assert.equal(rb.status, 0, rb.stderr); assert.equal(JSON.parse(rb.stdout).file_sha256, sha(f.answers))
  const bad = spawnSync(process.execPath, ['--experimental-strip-types', helper, 'material', f.irFile, 'f'.repeat(64), f.row.sample_id, '0'], { encoding: 'utf8' })
  assert.equal(bad.status, 2); assert.match(bad.stderr, /REVIEW_SOURCE_FILE_CHANGED/); assert.equal(bad.stdout, '')
  assert.equal(f.stats().logins, 0, '材料回读不访问远端也不执行材料文本')
})

test('1625字符完整题一次展示且无需续读', async t => {
  const f = await fixture(t), row = { ...f.row, state: { user_text: '' } }
  row.state.user_text = 'x'.repeat(1625 - inputOf(row).length)
  const raw = JSON.stringify(row) + '\n'; writeFileSync(f.irFile, raw)
  const child = spawnSync(process.execPath, ['--experimental-strip-types', helper, 'material', f.irFile, sha(raw), row.sample_id, '0'], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const packet = JSON.parse(child.stdout)
  assert.equal(packet.total_characters, 1625); assert.equal(packet.fragment, inputOf(row)); assert.equal(packet.complete, true); assert.equal(packet.next_cursor, null)
  assert.equal(Object.hasOwn(packet, 'next_read_command'), false)
})

test('公开Node client以follow cut完整分页，finalize从实际合成actor及原生write/readback派生annotations', async t => {
  const f = await fixture(t), result = await finalizeIRReview(f.options)
  assert.equal(result.status, 'complete'); assert.equal(result.annotations, 1); assert.deepEqual(result.model, model)
  const annotation = JSON.parse(readFileSync(join(f.options.out, 'annotations.jsonl'), 'utf8'))
  assert.equal(annotation.sample_id, f.row.sample_id); assert.equal(annotation.label.value, 'ask')
  assert.equal(annotation.label.source, 'ai_delegated:functional_validation'); assert.deepEqual(annotation.label.evidence_refs[0].model, model)
  assert.equal(annotation.label.evidence_refs[0].answers_sha256, sha(f.answers))
  const receipt = JSON.parse(readFileSync(join(f.options.out, 'receipt.json'), 'utf8'))
  const expectedSources = Object.fromEntries(['ir-review.mts', 'ir-review-evidence.mts', 'platform-replay-input.mts'].map(name => [name, sha(readFileSync(new URL(name, import.meta.url)))]))
  assert.deepEqual(receipt.tool_sources, expectedSources); assert.equal(receipt.helper_sha256, expectedSources['ir-review.mts'])
  assert.equal(receipt.session_cut.events, f.events.length); assert.ok(receipt.session_cut.pages.length > 3)
  assert.deepEqual(readdirSync(f.options.out).sort(), ['annotations.jsonl', 'receipt.json'])
  assert.doesNotMatch(allText(f.options.out), /PRIVATE_NATIVE_|SYNTHETIC_ONLY_ADMIN_PASSWORD|SYNTHETIC_ONLY_COOKIE|"header"|"system"/)
  assert.equal(readFileSync(f.irFile, 'utf8'), f.ir); assert.equal(readFileSync(f.answersFile, 'utf8'), f.answers)
  assert.equal(f.stats().logins, 1); assert.equal(f.stats().followCount, 1)
  const before = allText(f.options.out)
  await assert.rejects(finalizeIRReview(f.options), /OUTPUT_ALREADY_EXISTS/); assert.equal(allText(f.options.out), before)
})

test('历史缺seq、actor错配及readback摘要错配均阻断；不生成annotations，不落完整原生日志', async t => {
  for (const mode of [{ hiddenHistoryGap: true }, { wrongActor: true }, { wrongReadback: true }, { missingLast: true }]) {
    const f = await fixture(t, mode)
    await assert.rejects(finalizeIRReview(f.options), /SESSION_HISTORY_INCOMPLETE|IR_REVIEW_NATIVE_EVIDENCE_REJECTED/)
    assert.equal(existsSync(join(f.options.out, 'annotations.jsonl')), false)
    const receipt = JSON.parse(readFileSync(join(f.options.out, 'receipt.json'), 'utf8')); assert.equal(receipt.status, 'blocked')
    if (mode.missingLast) { assert.equal(receipt.audit.reason, 'complete_input_missing'); assert.equal(receipt.audit.sample_id, f.row.sample_id) }
    assert.doesNotMatch(allText(f.options.out), /PRIVATE_NATIVE_|SYNTHETIC_ONLY_COOKIE|SYNTHETIC_ONLY_ADMIN_PASSWORD/)
    assert.equal(readFileSync(f.irFile, 'utf8'), f.ir)
  }
})

test('IR/准入IDs/答案SHA与helper路径均为调用方固定绑定，错配先拒绝网络', async t => {
  const f = await fixture(t)
  for (const patch of [{ expectedIRSha256: 'f'.repeat(64) }, { expectedIdsSha256: 'f'.repeat(64) }, { expectedAnswersSha256: 'f'.repeat(64) }, { helperPath: f.irFile }]) {
    await assert.rejects(finalizeIRReview({ ...f.options, ...patch }), /REVIEW_SOURCE_FILE_CHANGED|REVIEW_HELPER_PATH_MISMATCH/)
    assert.equal(existsSync(f.options.out), false)
  }
  assert.equal(f.stats().logins, 0)
})
