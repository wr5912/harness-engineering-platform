import { createHash } from 'node:crypto'
export const IR_REVIEW_FRAGMENT_CHARACTERS = 3000
export const sha256Text = (value: string) => createHash('sha256').update(value).digest('hex')
const requireValue = (condition: unknown, code: string): void => { if (!condition) throw Object.assign(new Error(code), { code }) }
export function rows(raw: string): any[] { return raw.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) }
export function inputOf(row: any): string { return JSON.stringify({ decision_site_id: row.decision_site_id, contract_version: row.contract_version, state: row.state, question: row.question }) }
export function materialPacket(raw: string, file: string, expected: string, sampleId: string, cursor = 0, limit = IR_REVIEW_FRAGMENT_CHARACTERS): any {
  requireValue(sha256Text(raw) === expected, 'IR_FILE_SHA_CHANGED')
  const matches = rows(raw).filter(row => row.sample_id === sampleId)
  requireValue(matches.length === 1, 'IR_SAMPLE_NOT_UNIQUE')
  const row = matches[0], input = inputOf(row)
  requireValue(Number.isSafeInteger(cursor) && cursor >= 0 && cursor < input.length && Number.isSafeInteger(limit) && limit >= 1 && limit <= IR_REVIEW_FRAGMENT_CHARACTERS, 'IR_CURSOR_INVALID')
  let end = Math.min(cursor + limit, input.length)
  if (end < input.length && /[\uD800-\uDBFF]/.test(input[end - 1]!)) end--
  requireValue(end > cursor && !/[\uDC00-\uDFFF]/.test(input[cursor]!), 'IR_SURROGATE_BOUNDARY')
  return { schema_version: 'ir-ai-review-material/v1', file, file_sha256: expected, sample_id: sampleId,
    state_sha256: sha256Text(JSON.stringify(row.state)), question_sha256: sha256Text(JSON.stringify(row.question)), content_sha256: sha256Text(input),
    total_characters: input.length, cursor, next_cursor: end < input.length ? end : null, complete: end === input.length, fragment: input.slice(cursor, end) }
}

function validUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false
  }
  return true
}
export type IRReviewAnswer = { sample_id: string; status: 'unlabeled' | 'weak' | 'verified' | 'ambiguous' | 'invalid'; value: string | number | boolean | null; basis: string }
export type IRReviewExpected = { file: string; file_sha256: string; sample_id: string; state_sha256: string; question_sha256: string; question: { type: 'choice' | 'noul' | 'score'; criteria?: Record<string, string> | string[] }; source_group_id?: string; trace_sha256?: string }
function parseAnswers(raw: string): IRReviewAnswer[] {
  const answers = rows(raw)
  requireValue(answers.length > 0 && new Set(answers.map(row => row.sample_id)).size === answers.length, 'IR_ANSWER_IDS_INVALID')
  for (const row of answers) requireValue(Object.keys(row).sort().join(',') === 'basis,sample_id,status,value' && typeof row.sample_id === 'string' && row.sample_id.trim()
    && ['unlabeled', 'weak', 'verified', 'ambiguous', 'invalid'].includes(row.status) && typeof row.basis === 'string' && row.basis.trim(), 'IR_ANSWER_INVALID')
  return answers
}
export function answersReadback(raw: string, file: string) { return { schema_version: 'ir-ai-review-answers-readback/v1', file, file_sha256: sha256Text(raw), answers: parseAnswers(raw) } }

type V = Record<string, any>
const decode = (value: any): any => { try { return typeof value === 'string' ? JSON.parse(value) : value } catch { return null } }
const textOf = (message: V): string => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter((block: V) => block.type === 'text').map((block: V) => block.text).join('')
const canon = (value: any): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map((item: any) => JSON.parse(canon(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canon(value[key]))])) : value)
const same = (left: any, right: any): boolean => left !== undefined && right !== undefined && canon(left) === canon(right)
const route = (value: V): V => Object.fromEntries(['provider','model','reasoningEffort'].filter(key => value?.[key] != null).map(key => [key,value[key]]))
export const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
export const materialCommand = (helper: string, file: string, fileSha: string, sampleId: string, cursor: number): string => `node --experimental-strip-types ${quote(helper)} material ${quote(file)} ${quote(fileSha)} ${quote(sampleId)} ${cursor}`
export const readbackCommand = (helper: string, file: string): string => `node --experimental-strip-types ${quote(helper)} readback ${quote(file)}`
export const runsCommand = (actual: string, expected: string): boolean => typeof actual === 'string' && actual.trim() === expected
/** 只审计公开原生日志中的模型工具正文；不把文件系统副本或用户自报当输入回执。 */
export function auditIRReview(events: V[], sessionId: string, helper: string, expected: IRReviewExpected[], answersFile: string): V {
  const ordered = events.filter(event => Number.isSafeInteger(event.seq) && event.seq >= 0).sort((a,b) => a.seq-b.seq), calls = new Map(), successful = new Map(), visible: V[] = [], resultIds = new Set<string>(), ambiguous = new Set<string>()
  for (const event of ordered) {
    if (event.type === 'tool/call') {
      if (calls.has(event.data.callId)) ambiguous.add(event.data.callId)
      calls.set(event.data.callId, { ...event, args: decode(event.data.arguments) })
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message, id = message?.source?.callId, call = calls.get(id)
      if (!call || event.seq <= call.seq) continue
      if (resultIds.has(id)) ambiguous.add(id)
      resultIds.add(id)
      if (message.role !== 'tool' || message.source?.kind !== 'tool' || message.toolCallId !== id) continue
      const result = { call, event, text: textOf(message) }
      visible.push(result)
      if (message.isError === false && event.data.error === undefined && (event.data.isError === undefined || event.data.isError === false)) successful.set(id, result)
    }
  }
  for (const id of ambiguous) successful.delete(id)
  const writes = [...successful.values()].filter(({call,text}) => call.data.name === 'write' && call.args?.file_path === answersFile
    && new RegExp(`^<path>${answersFile.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}</path>\\n<type>file</type>\\n<content>\\n(?:Created|Updated) file\\n</content>$`).test(text.trim()))
  const write = writes.at(-1)
  if (!write) return { ok: false, reason: 'native_answers_write_missing', session_id: sessionId }
  const boundary = ordered.filter(event => event.seq < write.call.seq && ['step/start','request/header'].includes(event.type)).at(-1)?.seq
  const before = [...successful.values()].filter(result => result.event.seq < boundary)
  if (visible.filter(result => result.event.seq < boundary).some(result => /\"(?:observed_action|observed_candidate|targets)\"\s*:/.test(result.text) || result.call.data.name==='read' && expected.some(binding=>binding.file===result.call.args?.file_path))) return {ok:false,reason:'historical_supervision_exposed_before_review',session_id:sessionId}
  const actor = before.filter(({call,text}) => call.data.name === 'platform_agents' && call.args?.action === 'context'
    && (decode(text)?.result ?? decode(text))?.ok === true).map(result => ({ result, value: (decode(result.text)?.result ?? decode(result.text)).value?.assistant })).filter(item => item.value?.session_id === sessionId).at(-1)
  const header = ordered.filter(event => event.type === 'request/header' && event.seq < write.call.seq).at(-1)?.data?.header?.config
  if (boundary === undefined || !actor?.value?.model?.provider || !actor.value.model.model || !same(route(actor.value.model),route(header ?? {}))) return { ok: false, reason: 'actual_actor_or_model_boundary_missing', session_id: sessionId }
  let answers: IRReviewAnswer[]
  try { answers = parseAnswers(write.call.args.content) }
  catch { return { ok: false, reason: 'answers_jsonl_invalid' } }
  const proofs = []
  for (const answer of answers) {
    const binding = expected.find(item=>item.sample_id===answer.sample_id), groups = new Map()
    if (!binding) return {ok:false,reason:'answer_not_in_exact_admitted_set',sample_id:answer.sample_id}
    if (sha256Text(JSON.stringify(binding.question)) !== binding.question_sha256) return {ok:false,reason:'expected_question_sha_mismatch',sample_id:answer.sample_id}
    for (const result of before) {
      if (result.call.data.name !== 'bash' || typeof result.call.args?.command !== 'string') continue
      const packet = decode(result.text.trim())
      if (packet?.schema_version !== 'ir-ai-review-material/v1' || packet.file !== binding.file || packet.file_sha256 !== binding.file_sha256 || packet.sample_id !== binding.sample_id
        || packet.state_sha256 !== binding.state_sha256 || packet.question_sha256 !== binding.question_sha256 || !runsCommand(result.call.args.command,materialCommand(helper,packet.file,packet.file_sha256,packet.sample_id,packet.cursor))) continue
      if (!Number.isSafeInteger(packet.cursor) || packet.cursor<0 || !Number.isSafeInteger(packet.total_characters) || typeof packet.fragment !== 'string' || !packet.fragment.length || !validUtf16(packet.fragment)) continue
      const end = packet.cursor + packet.fragment.length
      if (end>packet.total_characters || (packet.next_cursor===null ? !packet.complete || end!==packet.total_characters : packet.complete!==false || packet.next_cursor!==end || end>=packet.total_characters)) continue
      const key = canon([packet.content_sha256,packet.state_sha256,packet.question_sha256,packet.total_characters])
      if (!groups.has(key)) groups.set(key,{packet,pieces:new Map()})
      groups.get(key).pieces.set(packet.cursor,{ packet,ref:{call_id:result.call.data.callId,call_seq:result.call.seq,result_seq:result.event.seq} })
    }
    let proof: V | undefined
    for (const group of groups.values()) {
      let cursor=0, body='', complete=false;const refs=[]
      while(group.pieces.has(cursor)) {const piece=group.pieces.get(cursor);body+=piece.packet.fragment;refs.push(piece.ref);if(piece.packet.next_cursor===null){complete=piece.packet.complete;break}cursor=piece.packet.next_cursor}
      const content=decode(body), packet=group.packet
      if(complete && body.length===packet.total_characters && sha256Text(body)===packet.content_sha256 && content && sha256Text(JSON.stringify(content.state))===binding.state_sha256 && sha256Text(JSON.stringify(content.question))===packet.question_sha256
        && Object.keys(content).sort().join(',')==='contract_version,decision_site_id,question,state') proof={sample_id:binding.sample_id,file:binding.file,file_sha256:binding.file_sha256,state_sha256:binding.state_sha256,question_sha256:packet.question_sha256,input_sha256:packet.content_sha256,receipt_refs:refs}
    }
    if (!proof) return {ok:false,reason:'complete_input_missing',sample_id:answer.sample_id}
    const question = binding.question
    const valueValid = question.type === 'choice' ? typeof answer.value === 'string' && question.criteria && !Array.isArray(question.criteria) && Object.hasOwn(question.criteria, answer.value)
      : question.type === 'noul' ? typeof answer.value === 'boolean'
      : question.type === 'score' && typeof answer.value === 'number' && Number.isInteger(answer.value) && answer.value >= 0 && Array.isArray(question.criteria) && answer.value < question.criteria.length
    if ((['verified','weak'].includes(answer.status) || answer.value !== null) && !valueValid) return {ok:false,reason:'answer_value_not_in_exact_question',sample_id:answer.sample_id}
    proofs.push({...proof,status:answer.status,value:answer.value,basis:answer.basis,
      ...(binding.source_group_id?{source_group_id:binding.source_group_id}:{}),...(binding.trace_sha256?{trace_sha256:binding.trace_sha256}:{})})

  }
  const writtenSha=sha256Text(write.call.args.content)
  const readback=[...successful.values()].filter(({call,event,text})=>call.data.name==='bash' && call.seq>write.event.seq && runsCommand(call.args?.command,readbackCommand(helper,answersFile)))
    .map(result=>({result,value:decode(result.text.trim())})).find(({value})=>value?.schema_version==='ir-ai-review-answers-readback/v1' && value.file===answersFile && value.file_sha256===writtenSha && same(value.answers,answers))
  return {ok:!!readback,reason:readback?null:'answers_same_sha_readback_missing',session_id:sessionId,model:route(actor.value.model),answers_file:answersFile,answers_sha256:writtenSha,
    actor_ref:{call_id:actor.result.call.data.callId,call_seq:actor.result.call.seq,result_seq:actor.result.event.seq},write_ref:{call_id:write.call.data.callId,call_seq:write.call.seq,result_seq:write.event.seq},
    ...(readback?{readback_ref:{call_id:readback.result.call.data.callId,call_seq:readback.result.call.seq,result_seq:readback.result.event.seq}}:{}),proofs}
}

/** 监督元数据仅由已核对的原生事实派生；保留 answers 原件及 AI 功能主张的范围。 */
export function buildIRAnnotations(audit: V): { sample_id: string; label: V }[] {
  requireValue(audit.ok === true && Array.isArray(audit.proofs) && audit.proofs.length > 0, 'IR_AUDIT_NOT_COMPLETE')
  return audit.proofs.map((proof: V) => ({ sample_id: proof.sample_id, label: { status: proof.status, value: proof.value, source: 'ai_delegated:functional_validation',
    evidence_refs: [{ kind: 'ai_functional_review', purpose: 'functional_validation', session_id: audit.session_id, model: audit.model,
      samples_file: proof.file, samples_sha256: proof.file_sha256, sample_id: proof.sample_id, state_sha256: proof.state_sha256, question_sha256: proof.question_sha256, input_sha256: proof.input_sha256,
      ...(proof.source_group_id ? { source_group_id: proof.source_group_id } : {}), ...(proof.trace_sha256 ? { trace_sha256: proof.trace_sha256 } : {}),
      actor_ref: audit.actor_ref, receipt_refs: proof.receipt_refs, answers_file: audit.answers_file, answers_sha256: audit.answers_sha256, write_ref: audit.write_ref, readback_ref: audit.readback_ref, basis: proof.basis }] } }))
}
