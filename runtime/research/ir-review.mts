import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlatformReadClient } from './platform-replay-input.mts'
import { answersReadback, auditIRReview, buildIRAnnotations, IR_REVIEW_FRAGMENT_CHARACTERS, materialCommand, materialPacket, rows, type IRReviewExpected } from './ir-review-evidence.mts'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[0-9a-f]{64}$/
function check(value: unknown, code: string): asserts value { if (!value) throw Error(code) }
function textFile(path: string) {
  check(isAbsolute(path), 'ABSOLUTE_REVIEW_PATH_REQUIRED')
  const bytes = readFileSync(path)
  return { bytes, sha256: sha(bytes), text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
}
function pinnedFile(path: string, expected: string) {
  check(hashPattern.test(expected), 'EXPECTED_FILE_SHA_REQUIRED')
  const file = textFile(path); check(file.sha256 === expected, 'REVIEW_SOURCE_FILE_CHANGED'); return file
}
export interface FinalizeIRReviewOptions {
  url: string; assetRoot: string; sessionId: string; helperPath: string
  irFile: string; expectedIRSha256: string; sampleIdsFile: string; expectedIdsSha256: string
  answersFile: string; expectedAnswersSha256: string; out: string
}

/** 元数据只由已锁原IR、实际Session证据与同SHA答案派生；不信任模型声明的actor。 */
export async function finalizeIRReview(options: FinalizeIRReviewOptions) {
  check(isAbsolute(options.out) && isAbsolute(options.helperPath), 'ABSOLUTE_REVIEW_PATH_REQUIRED')
  check(realpathSync(options.helperPath) === realpathSync(fileURLToPath(import.meta.url)), 'REVIEW_HELPER_PATH_MISMATCH')
  check(typeof options.sessionId === 'string' && !!options.sessionId.trim(), 'REVIEW_SESSION_ID_REQUIRED')
  check(!existsSync(options.out), 'OUTPUT_ALREADY_EXISTS')
  const original = pinnedFile(options.irFile, options.expectedIRSha256), selection = pinnedFile(options.sampleIdsFile, options.expectedIdsSha256), answers = pinnedFile(options.answersFile, options.expectedAnswersSha256)
  const ids = JSON.parse(selection.text)
  check(Array.isArray(ids) && ids.length > 0 && ids.every(id => typeof id === 'string' && id.trim()) && new Set(ids).size === ids.length, 'ADMITTED_SAMPLE_IDS_INVALID')
  const samples = rows(original.text), expected: IRReviewExpected[] = []
  for (const id of ids) {
    const matches = samples.filter(row => row.sample_id === id)
    check(matches.length === 1, 'ADMITTED_SAMPLE_NOT_UNIQUE_IN_IR')
    const row = matches[0]
    check(row.label?.status === 'unlabeled' && row.label.value === null && row.state && row.question, 'ORIGINAL_UNLABELED_IR_REQUIRED')
    expected.push({ file: options.irFile, file_sha256: original.sha256, sample_id: id, state_sha256: sha(JSON.stringify(row.state)), question_sha256: sha(JSON.stringify(row.question)), question: row.question,
      ...(row.provenance?.source_group_id ? { source_group_id: row.provenance.source_group_id } : {}), ...(row.provenance?.trace_sha256 ? { trace_sha256: row.provenance.trace_sha256 } : {}) })
  }
  const decodedAnswers = answersReadback(answers.text, options.answersFile)
  check(decodedAnswers.answers.every(answer => ids.includes(answer.sample_id)), 'ANSWER_NOT_IN_ADMITTED_IDS')
  mkdirSync(dirname(options.out), { recursive: true }); mkdirSync(options.out, { mode: 0o700 })
  const receipt: any = { schema_version: 'ir-ai-review-finalize/v1', status: 'blocked',
    session_id: options.sessionId, helper_path: options.helperPath, helper_sha256: sha(readFileSync(options.helperPath)),
    tool_sources: Object.fromEntries(['ir-review.mts', 'ir-review-evidence.mts', 'platform-replay-input.mts'].map(name => [name, sha(readFileSync(new URL(name, import.meta.url)))])),
    ir_file: options.irFile, ir_file_sha256: original.sha256, sample_ids_file: options.sampleIdsFile, sample_ids_sha256: selection.sha256, admitted_samples: ids.length,
    answers_file: options.answersFile, answers_sha256: answers.sha256, annotations_written: 0 }
  let client: Awaited<ReturnType<typeof createPlatformReadClient>> | undefined
  try {
    // 原生follow/page结果只在本作用域内存中使用；不安装原HTTP/Session落盘观察器。
    client = await createPlatformReadClient({ url: options.url, assetRoot: options.assetRoot })
    const history = await client.readSessionEvents(options.sessionId)
    receipt.platform = { url: client.url, workspace: client.workspace }
    receipt.session_cut = { cursor: history.cursor, events: history.events.length, decoded_events_sha256: sha(JSON.stringify(history.events)), pages: history.pages }
    const audit = auditIRReview(history.events, options.sessionId, options.helperPath, expected, options.answersFile)
    receipt.audit = { ok: audit.ok, reason: audit.reason,
      ...(typeof audit.sample_id === 'string' ? { sample_id: audit.sample_id } : {}),
      ...(audit.model ? { model: audit.model } : {}), ...(audit.actor_ref ? { actor_ref: audit.actor_ref } : {}), ...(audit.write_ref ? { write_ref: audit.write_ref } : {}), ...(audit.readback_ref ? { readback_ref: audit.readback_ref } : {}),
      proofs: (audit.proofs ?? []).map((proof: any) => ({ sample_id: proof.sample_id, status: proof.status, value: proof.value, state_sha256: proof.state_sha256, question_sha256: proof.question_sha256,
        input_sha256: proof.input_sha256, basis_sha256: sha(proof.basis), receipt_refs: proof.receipt_refs })) }
    check(audit.ok === true, 'IR_REVIEW_NATIVE_EVIDENCE_REJECTED')
    check(audit.answers_sha256 === answers.sha256, 'ANSWERS_NOT_SAME_AS_NATIVE_WRITE_READBACK')
    const annotations = buildIRAnnotations(audit), body = annotations.map(row => JSON.stringify(row)).join('\n') + '\n'
    check(client.isSafeText(body) && client.isSafeText(JSON.stringify(receipt)), 'ANNOTATION_EVIDENCE_UNSAFE')
    pinnedFile(options.irFile, original.sha256); pinnedFile(options.sampleIdsFile, selection.sha256); pinnedFile(options.answersFile, answers.sha256)
    writeFileSync(join(options.out, 'annotations.jsonl'), body, { flag: 'wx', mode: 0o600 })
    Object.assign(receipt, { status: 'complete', annotations_written: annotations.length, annotations_file: 'annotations.jsonl', annotations_sha256: sha(body) })
    writeFileSync(join(options.out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return { status: 'complete', out: options.out, annotations: annotations.length, annotations_sha256: receipt.annotations_sha256, session_id: options.sessionId, model: audit.model }
  } catch (error) {
    receipt.error_code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'IR_FINALIZE_FAILED'
    // 不持久化完整原生日志、request/header、system或任何原生私有配置。
    writeFileSync(join(options.out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    throw new Error(receipt.error_code)
  } finally { await client?.close() }
}

export async function main(args: string[]) {
  const [mode, ...rest] = args
  if (mode === 'material') {
    check(rest.length === 3 || rest.length === 4, 'MATERIAL_ARGUMENTS_REQUIRED')
    const [file, expected, sampleId, offset = '0'] = rest
    const raw = pinnedFile(file!, expected!)
    const value = materialPacket(raw.text, file!, expected!, sampleId!, Number(offset), IR_REVIEW_FRAGMENT_CHARACTERS)
    if (value.next_cursor !== null) value.next_read_command = materialCommand(fileURLToPath(import.meta.url), file!, expected!, sampleId!, value.next_cursor)
    process.stdout.write(JSON.stringify(value) + '\n'); return
  }
  if (mode === 'readback') {
    check(rest.length === 1, 'READBACK_FILE_REQUIRED')
    const file = textFile(rest[0]!); process.stdout.write(JSON.stringify(answersReadback(file.text, rest[0]!)) + '\n'); return
  }
  check(mode === 'finalize' && rest.length % 2 === 0, 'IR_REVIEW_MODE_REQUIRED')
  const names = new Set(['url', 'asset-root', 'session-id', 'helper-path', 'ir-file', 'expected-ir-sha256', 'sample-ids-file', 'expected-ids-sha256', 'answers-file', 'expected-answers-sha256', 'out']), values: Record<string, string> = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]!.replace(/^--/, '')
    check(rest[index]!.startsWith('--') && names.has(key) && !Object.hasOwn(values, key) && rest[index + 1], 'CANONICAL_FINALIZE_ARGUMENTS_REQUIRED')
    values[key] = rest[index + 1]!
  }
  check(Object.keys(values).length === names.size, 'FINALIZE_BINDINGS_REQUIRED')
  const result = await finalizeIRReview({ url: values.url!, assetRoot: values['asset-root']!, sessionId: values['session-id']!, helperPath: values['helper-path']!, irFile: values['ir-file']!, expectedIRSha256: values['expected-ir-sha256']!,
    sampleIdsFile: values['sample-ids-file']!, expectedIdsSha256: values['expected-ids-sha256']!, answersFile: values['answers-file']!, expectedAnswersSha256: values['expected-answers-sha256']!, out: values.out! })
  process.stdout.write(JSON.stringify(result) + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'IR_REVIEW_FAILED'; process.stderr.write(JSON.stringify({ status: 'blocked', error_code: code }) + '\n'); process.exitCode = 2 })
}
