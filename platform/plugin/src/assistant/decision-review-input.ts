import { createHash } from 'node:crypto'
import { validateDecisionInputEvidence, type DecisionInputEvidence, type DecisionInputEvidenceBinding } from '../evaluation/decision-dataset-contract.ts'

type Value = Record<string, any>
type NativeEvent = { seq: number; type: string; data?: any }
type ReadCall = { seq: number; call_id: string; action: string; input: Value }
function last<T>(values: readonly T[], matches: (value: T) => boolean): T | undefined { for (let index = values.length - 1; index >= 0; index--) if (matches(values[index]!)) return values[index] }
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const object = (value: unknown): Value | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : null
const json = (value: unknown): Value | null => { try { return object(typeof value === 'string' ? JSON.parse(value) : value) } catch { return null } }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
function stateHash(value: unknown): string | null { try { return object(value) && Array.isArray((value as Value).messages) ? hash(value) : null } catch { return null } }
function messageJson(message: Value): Value | null {
  if (typeof message.content === 'string') return json(message.content)
  if (!Array.isArray(message.content)) return null
  return json(message.content.filter((block: Value) => block?.type === 'text' && typeof block.text === 'string').map((block: Value) => block.text).join(''))
}
function validUtf16(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
    } else if (code >= 0xDC00 && code <= 0xDFFF) return false
  }
  return true
}

/** 只核对实际模型可见工具正文；不读取操作记录中的内部 raw dispatch 数据。 */
export function collectDecisionReviewInput(events: readonly unknown[], sessionId: string, dataset: Value, record: Value): DecisionInputEvidence | null {
  const meta = object(record?._meta), currentState = stateHash(record?.state)
  if (!meta || !currentState || !sha(dataset?.source_sha256) || !sha(dataset?.source_bundle?.sha256)
    || meta.run_id !== dataset.run_id || meta.trace_path !== dataset.path || meta.trace_sha256 !== dataset.source_sha256
    || typeof meta.decision_id !== 'string') return null
  const binding: DecisionInputEvidenceBinding = { session_id: sessionId, dataset_id: dataset.id, record_id: meta.id,
    run_id: dataset.run_id, path: dataset.path, trace_sha256: dataset.source_sha256, source_bundle_sha256: dataset.source_bundle.sha256, state_sha256: currentState }
  const ordered = events.map(object).filter((event): event is Value => !!event && typeof event.type === 'string' && sequence(event.seq)).sort((left, right) => left.seq - right.seq) as NativeEvent[]
  const parsedCalls = ordered.filter(event => event.type === 'tool/call').map(event => ({ event, args: json(event.data?.arguments) }))
  const currentReview = last(parsedCalls, ({ event, args }) => event.data?.name === 'platform_agents' && args?.action === 'datasets/review'
    && args.input?.dataset_id === dataset.id && args.input?.record_id === meta.id)?.event
  const beforeReview = ordered.filter(event => !currentReview || event.seq < currentReview.seq)
  // request/header 在原生日志中可能仅在配置或工具合同变化时出现；每次请求的 step/start 仍是必要边界。
  const boundary = last(beforeReview, event => ['request/header', 'step/start'].includes(event.type))?.seq
  if (boundary === undefined) return null
  const calls = new Map<string, ReadCall>(), ambiguous = new Set<string>(), results = new Set<string>()
  const proofs: DecisionInputEvidence[] = []
  const fragments = new Map<string, { total: number; content: string; identity: string; pieces: Map<number, { text: string; next: number | null; complete: boolean; ref: DecisionInputEvidence['receipt_refs'][number] }> }>()
  const add = (proof: DecisionInputEvidence) => { try { proofs.push(validateDecisionInputEvidence(proof, binding)) } catch { /* 不完整或歧义证据不升级为可写证明。 */ } }
  const matches = (value: Value) => value.run_id === binding.run_id && value.path === binding.path && value.source_sha256 === binding.trace_sha256
  const requestMatches = (input: Value, value: Value) => input.run_id === binding.run_id && input.path === binding.path
    && (input.source_sha256 === undefined || input.source_sha256 === value.source_sha256)
    && (input.source_identity_sha256 === undefined || input.source_identity_sha256 === value.source_identity_sha256)
    && (input.content_sha256 === undefined || input.content_sha256 === value.content_sha256)
  for (const event of ordered) {
    if (event.seq >= boundary) break
    if (event.type === 'tool/call') {
      const id = event.data?.callId
      if (typeof id !== 'string' || !id.trim()) continue
      if (calls.has(id)) { ambiguous.add(id); continue }
      const args = json(event.data?.arguments), input = object(args?.input)
      if (event.data?.name !== 'platform_agents' || !input || !['datasets/read', 'datasets/source'].includes(args?.action)) continue
      calls.set(id, { seq: event.seq, call_id: id, action: args!.action, input }); continue
    }
    if (event.type !== 'tool/result') continue
    const message = object(event.data?.message), id = message?.source?.callId, call = calls.get(id)
    if (!message || message.source?.kind !== 'tool' || !call || event.seq <= call.seq || ambiguous.has(id)) continue
    if (results.has(id)) { ambiguous.add(id); continue }
    results.add(id)
    const payload = messageJson(message), receipt = object(payload?.result ?? payload), value = object(receipt?.value)
    if (!payload || !receipt || !value || receipt.ok !== true || message.role !== 'tool' || message.toolCallId !== id || message.isError !== false || event.data?.isError === true || event.data?.error
      || ['failed', 'cancelled', 'unknown'].includes(payload.state) || payload.domain !== undefined && payload.domain !== 'agents'
      || payload.action !== undefined && payload.action !== call.action) continue
    const ref = { call_id: call.call_id, call_seq: call.seq, result_seq: event.seq }
    if (call.action === 'datasets/read') {
      const seen = object(value.dataset), rows = seen?.records
      if (call.input.dataset_id !== binding.dataset_id || call.input.run_id !== undefined && call.input.run_id !== binding.run_id
        || !seen || seen.id !== binding.dataset_id || seen.run_id !== binding.run_id || seen.path !== binding.path || seen.source_sha256 !== binding.trace_sha256
        || seen.source_bundle?.sha256 !== binding.source_bundle_sha256 || !Array.isArray(rows)) continue
      const matching = rows.filter(row => row?._meta?.id === binding.record_id)
      const item = matching[0]
      if (matching.length !== 1 || item.state_omitted === true || item.state === null || item._meta.decision_id !== meta.decision_id
        || item._meta.run_id !== binding.run_id || item._meta.trace_path !== binding.path || item._meta.trace_sha256 !== binding.trace_sha256
        || stateHash(item.state) !== binding.state_sha256) continue
      add({ schema_version: 1, ...binding, read_method: 'datasets/read', receipt_refs: [ref] }); continue
    }
    if (!matches(value) || !requestMatches(call.input, value) || !sha(value.source_identity_sha256)) continue
    if (value.kind === 'decisions') {
      if (value.source_bundle?.sha256 !== binding.source_bundle_sha256 || !Array.isArray(value.decisions)) continue
      const matching = value.decisions.filter((decision: Value) => decision?.decision_id === meta.decision_id), item = matching[0]
      if (matching.length !== 1 || item.detail_required === true || item.state_omitted === true || stateHash(item.state) !== binding.state_sha256) continue
      add({ schema_version: 1, ...binding, read_method: 'datasets/source', receipt_refs: [ref], source_identity_sha256: value.source_identity_sha256 }); continue
    }
    if (value.kind !== 'decision_fragment' || call.input.decision_id !== meta.decision_id || value.decision_id !== meta.decision_id
      || !sha(value.content_sha256) || !sequence(value.cursor) || !sequence(value.total_characters) || value.total_characters === 0
      || (call.input.cursor ?? 0) !== value.cursor || typeof value.fragment !== 'string' || !value.fragment.length || !validUtf16(value.fragment)) continue
    if (value.cursor > 0 && (call.input.source_sha256 !== value.source_sha256 || call.input.source_identity_sha256 !== value.source_identity_sha256 || call.input.content_sha256 !== value.content_sha256)) continue
    const end = value.cursor + value.fragment.length
    if (end > value.total_characters || value.next_cursor === null && (value.complete !== true || end !== value.total_characters)
      || value.next_cursor !== null && (value.complete !== false || !sequence(value.next_cursor) || value.next_cursor !== end || end >= value.total_characters)) continue
    const key = JSON.stringify([value.source_sha256, value.source_identity_sha256, value.content_sha256, value.total_characters])
    if (!fragments.has(key)) fragments.set(key, { total: value.total_characters, content: value.content_sha256, identity: value.source_identity_sha256, pieces: new Map() })
    const group = fragments.get(key)!
    group.pieces.set(value.cursor, { text: value.fragment, next: value.next_cursor, complete: value.complete, ref })
    let cursor = 0, content = '', complete = false
    const refs: DecisionInputEvidence['receipt_refs'] = []
    while (group.pieces.has(cursor)) {
      const piece = group.pieces.get(cursor)!
      content += piece.text; refs.push(piece.ref)
      if (piece.next === null) { complete = piece.complete; break }
      cursor = piece.next
    }
    if (!complete || content.length !== group.total || hash(content) !== group.content) continue
    const document = json(content)
    if (!document || document.decision_id !== meta.decision_id || document.run_id !== binding.run_id || stateHash(document.state) !== binding.state_sha256) continue
    add({ schema_version: 1, ...binding, read_method: 'datasets/source-fragments', receipt_refs: refs, content_sha256: group.content, source_identity_sha256: group.identity })
  }
  return proofs.filter(proof => proof.receipt_refs.every(ref => !ambiguous.has(ref.call_id)))
    .sort((left, right) => Math.max(...right.receipt_refs.map(ref => ref.result_seq)) - Math.max(...left.receipt_refs.map(ref => ref.result_seq)))[0] ?? null
}
