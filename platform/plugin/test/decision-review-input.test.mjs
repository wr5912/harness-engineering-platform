import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { collectDecisionReviewInput } from '../src/assistant/decision-review-input.ts'
import { validateDecisionInputEvidence, isDecisionTargetReviewed } from '../src/evaluation/decision-dataset-contract.ts'

// 以下均为合成原生事件夹具，不代表真实标注或完整业务验收。
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const session = 'synthetic-review-session', trace = hash('synthetic-trace'), bundle = hash('synthetic-bundle'), identity = hash('synthetic-source-identity')
const record = { state: { messages: [{ role: 'user', source: { kind: 'user' }, content: '合成材料🧪：选择读取当前状态。' }], available_tools: [] }, _meta: { id: 'synthetic-record', run_id: 'synthetic-run', trace_path: 'evidence/SYNTHETIC/trace.jsonl', trace_sha256: trace, decision_id: 'synthetic-decision' } }
const dataset = { id: 'synthetic-dataset', run_id: record._meta.run_id, path: record._meta.trace_path, source_sha256: trace, source_bundle: { sha256: bundle }, records: [record] }
const call = (seq, action, input, id = `synthetic-call-${seq}`) => ({ seq, type: 'tool/call', data: { callId: id, name: 'platform_agents', arguments: JSON.stringify({ action, input }) } })
const result = (seq, callSeq, value) => ({ seq, type: 'tool/result', data: { message: { role: 'tool', toolCallId: `synthetic-call-${callSeq}`, isError: false, source: { kind: 'tool', callId: `synthetic-call-${callSeq}` }, content: [{ type: 'text', text: JSON.stringify({ domain: 'agents', result: { ok: true, value } }) }] } } })
const boundary = seq => ({ seq, type: 'step/start', data: { id: `step-${seq}` } })
const review = seq => call(seq, 'datasets/review', { dataset_id: dataset.id, record_id: record._meta.id })
const sourceInput = { run_id: dataset.run_id, path: dataset.path }
const sourceCommon = { run_id: dataset.run_id, path: dataset.path, source_sha256: trace, source_identity_sha256: identity }
const fullRead = () => [boundary(0), call(1, 'datasets/read', { dataset_id: dataset.id }), result(2, 1, { dataset }), boundary(3), review(4)]
function fragments({ split, wrongTotal = false } = {}) {
  const content = JSON.stringify({ run_id: dataset.run_id, decision_id: record._meta.decision_id, state: record.state })
  const cut = split ?? content.indexOf('🧪'), digest = hash(content)
  const common = { ...sourceCommon, kind: 'decision_fragment', decision_id: record._meta.decision_id, total_characters: content.length + (wrongTotal ? 1 : 0), content_sha256: digest }
  return [boundary(0), call(1, 'datasets/source', { ...sourceInput, decision_id: record._meta.decision_id, cursor: 0 }), result(2, 1, { ...common, cursor: 0, fragment: content.slice(0, cut), next_cursor: cut, complete: false }),
    boundary(3), call(4, 'datasets/source', { ...sourceInput, decision_id: record._meta.decision_id, cursor: cut, source_sha256: trace, source_identity_sha256: identity, content_sha256: digest }), result(5, 4, { ...common, cursor: cut, fragment: content.slice(cut), next_cursor: null, complete: true }), boundary(6), review(7)]
}
function changeValue(event, apply) { const payload = JSON.parse(event.data.message.content[0].text); apply(payload.result.value, payload); event.data.message.content[0].text = JSON.stringify(payload) }
const collect = events => collectDecisionReviewInput(events, session, dataset, record)

test('真正模型输出的完整dataset state可作证据，proof仅保留摘要和回执定位', () => {
  const proof = collect(fullRead())
  assert.equal(proof.read_method, 'datasets/read'); assert.equal(proof.state_sha256, hash(record.state)); assert.equal(proof.source_bundle_sha256, bundle)
  assert.deepEqual(proof.receipt_refs, [{ call_id: 'synthetic-call-1', call_seq: 1, result_seq: 2 }])
  assert.doesNotMatch(JSON.stringify(proof), /合成材料|messages|available_tools/)
  assert.deepEqual(validateDecisionInputEvidence(proof, { dataset_id: dataset.id, state_sha256: hash(record.state) }), proof)
})

test('仅state_sha或内部raw完整副本不证明模型已读；state_omitted亦拒绝', () => {
  for (const mode of ['no-state', 'omitted', 'raw']) {
    const events = fullRead()
    changeValue(events[2], value => { if (mode !== 'omitted') { value.raw = { state: value.dataset.records[0].state }; delete value.dataset.records[0].state }; if (mode === 'omitted') value.dataset.records[0].state_omitted = true })
    assert.equal(collect(events), null, mode)
  }
})

test('同step读取完整state后才派发review仍不能算模型已看过；下一模型step可接受', () => {
  assert.equal(collect(fullRead().filter(event => event.seq !== 3)), null)
  assert.ok(collect(fullRead()))
  const serialSameStep = fullRead(); serialSameStep[3] = { seq: 3, type: 'step/end', data: {} }
  assert.equal(collect(serialSameStep), null)
})

test('stale request/header不挡后续真实step；无任何模型边界保守拒绝', () => {
  const events = fullRead(); events[0] = { seq: 0, type: 'request/header', data: { header: {} } }
  assert.ok(collect(events))
  assert.equal(collect(fullRead().filter(event => event.type !== 'step/start')), null)
  const precheck = fullRead().filter(event => event.seq !== 4)
  assert.ok(collect(precheck), '明确下一step已经开始的纯预检查可核对已进入模型前缀的正文')
  assert.equal(collect(precheck.filter(event => event.seq !== 3)), null)
})

test('完整source decisions页绑定同Run/path/trace/bundle/decision的真实state', () => {
  const events = [boundary(0), call(1, 'datasets/source', sourceInput), result(2, 1, { ...sourceCommon, kind: 'decisions', source_bundle: { sha256: bundle }, decisions: [{ decision_id: record._meta.decision_id, state: record.state }] }), boundary(3), review(4)]
  assert.equal(collect(events).read_method, 'datasets/source')
  for (const patch of [{ path: 'wrong' }, { run_id: 'wrong' }, { source_sha256: hash('wrong') }, { source_bundle: { sha256: hash('wrong') } }]) {
    const copy = structuredClone(events); changeValue(copy[2], value => Object.assign(value, patch)); assert.equal(collect(copy), null)
  }
  const descriptor = structuredClone(events); changeValue(descriptor[2], value => value.decisions[0].detail_required = true); assert.equal(collect(descriptor), null)
})

test('连续unicode source分片核对UTF16长度、全文SHA和state后才生成证明', () => {
  const proof = collect(fragments())
  assert.equal(proof.read_method, 'datasets/source-fragments'); assert.equal(proof.receipt_refs.length, 2); assert.equal(proof.source_identity_sha256, identity)
  assert.equal(proof.content_sha256.length, 64)
})

test('漏片、total/content/state错误、错source identity或续片缺摘要均拒绝', () => {
  assert.equal(collect(fragments().filter(event => ![4, 5].includes(event.seq))), null)
  assert.equal(collect(fragments({ wrongTotal: true })), null)
  for (const patch of [{ content_sha256: hash('wrong') }, { source_identity_sha256: hash('other-origin') }, { source_sha256: hash('other-trace') }, { decision_id: 'other-decision' }, { run_id: 'other-run' }]) {
    const events = fragments(); changeValue(events.find(event => event.seq === 5), value => Object.assign(value, patch)); assert.equal(collect(events), null)
  }
  const missingDigest = fragments(); const call4 = missingDigest.find(event => event.seq === 4); const args = JSON.parse(call4.data.arguments); delete args.input.source_identity_sha256; call4.data.arguments = JSON.stringify(args)
  assert.equal(collect(missingDigest), null)
  const wrongState = fullRead(); changeValue(wrongState[2], value => value.dataset.records[0].state.messages[0].content = '不同输入'); assert.equal(collect(wrongState), null)
})

test('不可在代理对中间切片；同step新读最后一片仍不能支持该step的review', () => {
  const content = JSON.stringify({ run_id: dataset.run_id, decision_id: record._meta.decision_id, state: record.state })
  assert.equal(collect(fragments({ split: content.indexOf('🧪') + 1 })), null)
  assert.equal(collect(fragments().filter(event => event.seq !== 6)), null)
})

test('用户文字、伪callId、失败回执和错dataset/state/bundle不能冒充读取', () => {
  for (const change of [
    events => events[2].type = 'user/message',
    events => events[2].data.message.source.callId = 'unmatched-call',
    events => events[2].data.message.source.kind = 'user',
    events => events[2].data.message.isError = true,
    events => changeValue(events[2], (_value, payload) => payload.result.ok = false),
    events => changeValue(events[2], value => value.dataset.id = 'other-dataset'),
    events => changeValue(events[2], value => value.dataset.source_bundle.sha256 = hash('other-bundle')),
  ]) { const events = structuredClone(fullRead()); change(events); assert.equal(collect(events), null) }
})

test('validator拒绝改绑/重复或倒序回执；AI旧无proof保持事实但不计复核完成', () => {
  const proof = collect(fullRead())
  assert.throws(() => validateDecisionInputEvidence(proof, { session_id: 'other-session' }), /不一致/)
  assert.throws(() => validateDecisionInputEvidence({ ...proof, receipt_refs: [{ call_id: 'bad', call_seq: 3, result_seq: 2 }] }), /定位/)
  assert.throws(() => validateDecisionInputEvidence({ ...proof, receipt_refs: [...proof.receipt_refs, ...proof.receipt_refs] }), /重复/)
  assert.throws(() => validateDecisionInputEvidence({ ...proof, read_method: 'datasets/source-fragments' }), /摘要/)
  assert.equal(isDecisionTargetReviewed({ status: 'reviewed', review: { kind: 'ai_delegated' } }), false)
  assert.equal(isDecisionTargetReviewed({ status: 'reviewed', review: { kind: 'ai_delegated', input_evidence: proof } }), true)
  assert.equal(isDecisionTargetReviewed({ status: 'reviewed' }), true)
  assert.equal(isDecisionTargetReviewed({ status: 'rejected' }), false)
})


test('模型阅读证明只接受实际成功ToolMessage，错角色、callId或错误字段不生成证明', () => {
  for (const patch of [{ role: 'user' }, { toolCallId: 'other' }, { isError: true }, { isError: undefined }]) {
    const copy = fullRead(); Object.assign(copy[2].data.message, patch); assert.equal(collect(copy), null)
  }
  const failed = fullRead(); failed[2].data.error = { code: 'native-failure' }; assert.equal(collect(failed), null)
  const duplicate = fullRead(); const bad = structuredClone(duplicate[2]); bad.seq = 3; bad.data.message.isError = true; duplicate[3].seq = 4; duplicate[4].seq = 5; duplicate.splice(3,0,bad); assert.equal(collect(duplicate), null)
})
