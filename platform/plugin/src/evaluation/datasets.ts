import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { RunFileError, readRunEvidenceFile, redactRunText } from '../agents/run-files.ts'
import { DECISION_TRACE_DECODER_VERSION, buildDecisionSlices, loadRunTrace, listRunTraceSources, type DecisionSlice, type TraceSourceBundle } from './trace.ts'
import { decisionSourceGroup } from './decision-source-group.ts'
import { DECISION_EXTRACTION_CONTRACT, DECISION_SPLITS, decisionText, validateDecisionInputQuestion, validateDecisionInputEvidence, isDecisionTargetReviewed, validateDecisionLabel, validateDecisionQuestions, validateDecisionTargets, validateDecisionTask, type DecisionQuestion, type DecisionReview, type DecisionTarget, type DecisionTask } from './decision-dataset-contract.ts'

type MapValue = Record<string, any>
type Sample = { state: unknown; workflow: string; task: DecisionTask; questions: Record<string, DecisionQuestion>; targets: Record<string, DecisionTarget>; _meta: MapValue }
type SourceIdentity = { agent_id: string; experiment_id: string; run_id: string }
type Dataset = { schema_version?: number; id: string; run_id: string; agent_id?: string; experiment_id?: string; source_version?: MapValue; path: string; source_sha256: string; source_bundle?: TraceSourceBundle; created_at: string; extractor: MapValue; records: Sample[]; skipped: string[] }
type RecordEligibility = { record_id: string; legacy: boolean; eligible_questions: string[]; reasons: string[]; question_reasons: Record<string, string[]>; export_modes: string[] }
const ID = /^decision-dataset-[0-9a-f-]{36}$/
const HASH = /^[0-9a-f]{64}$/
const RECORD_ID = /^decision-[0-9a-f]{32}$/
const HARNESS_PATHS = ['AGENTS.md', '.agents/skills/decision-sample-extraction/SKILL.md', 'docs/harness-research/decision-samples.md']
const MODES = ['candidates', 'training', 'development', 'calibration', 'test']
// 给原生工具的外层回执及专项合同投影留出空间。
const SOURCE_PAGE_CHARACTERS = 12000
const DECISION_STATE_BYTES = 96 * 1024
const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
function normalized(value: any): any {
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])]))
  return value
}
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
function fail(message: string, code = 'invalid_dataset'): never { throw new RunFileError(code, message) }
function object(value: unknown): MapValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as MapValue : fail('需要 JSON 对象') }
const text = decisionText
function clean<T>(value: T): T { return JSON.parse(redactRunText(JSON.stringify(value))) }
function noSecrets(value: unknown) { if (!equal(value, clean(value))) fail('题目或监督目标包含凭据，请先移除') }

/** 来源身份取自实际 Run 目录及其历史清单，不能用当前 Candidate 或客户端字段替代。 */
async function sourceIdentity(root: string, runId: string, signal?: AbortSignal, bundle?: TraceSourceBundle) {
  const manifests: { path: string; sha256: string; value: MapValue }[] = []
  for (const name of ['run.yaml', 'run.json']) {
    try {
      const file = await readRunEvidenceFile(root, runId, name, signal, 1024 * 1024)
      manifests.push({ path: file.path, sha256: file.source_sha256, value: object(name.endsWith('.yaml') ? loadYaml(file.data.toString()) : JSON.parse(file.data.toString())) })
    } catch (error) { if (!(error instanceof RunFileError) || error.code !== 'not_found') throw error }
  }
  if (!manifests.length) fail('缺少 Run 身份文件')
  const match = /^evolution\/experiments\/((?:EXP|VAR)-([a-z0-9]+(?:-[a-z0-9]+)*)-\d{3}(?:-r[0-9a-f]{12})?)\/runs\/([^/]+)\//.exec(manifests[0]!.path)
  if (!match || match[3] !== runId) fail('Run 来源目录身份无效')
  const identity: SourceIdentity = { agent_id: match[2]!, experiment_id: match[1]!, run_id: runId }
  for (const manifest of manifests) {
    if (manifest.value.run_id !== runId || manifest.value.agent_id !== undefined && manifest.value.agent_id !== identity.agent_id
      || manifest.value.experiment_id !== undefined && manifest.value.experiment_id !== identity.experiment_id) fail('Run 清单与实际 Agent、版本或 Run 来源身份不一致', 'conflict')
    if (bundle && bundle.files.find(file => file.path === manifest.path)?.source_sha256 !== manifest.sha256) fail('Run 身份在来源读取期间发生变化', 'conflict')
  }
  let source_version: MapValue | undefined
  let inputs_sha256: string | null = null
  try {
    const file = await readRunEvidenceFile(root, runId, 'inputs.lock.json', signal, 2 * 1024 * 1024)
    if (bundle && bundle.files.find(entry => entry.path === file.path)?.source_sha256 !== file.source_sha256) fail('Run 冻结输入在来源读取期间发生变化', 'conflict')
    const inputs = object(JSON.parse(file.data.toString())), git = inputs.git_version
    assertSourceIdentity(inputs, identity)
    inputs_sha256 = file.source_sha256
    source_version = { ...(typeof inputs.candidate_sha256 === 'string' ? { candidate_sha256: inputs.candidate_sha256 } : {}),
      ...(git && typeof git === 'object' ? { git_version: { ...(typeof git.commit === 'string' ? { commit: git.commit } : {}), ...(typeof git.dirty === 'boolean' ? { dirty: git.dirty } : {}) } } : {}) }
    if (!Object.keys(source_version).length) source_version = undefined
  } catch (error) { if (!(error instanceof RunFileError) || error.code !== 'not_found') throw error }
  const source_identity_sha256 = digest({ decoder_version: DECISION_TRACE_DECODER_VERSION, identity, manifests: manifests.map(({ path, sha256 }) => ({ path, sha256 })), inputs_sha256 })
  return { identity, source_identity_sha256, ...(source_version ? { source_version } : {}) }
}
function assertSourceIdentity(value: MapValue, identity: SourceIdentity) {
  for (const key of ['agent_id', 'experiment_id', 'run_id'] as const) if (value[key] !== undefined && value[key] !== identity[key]) fail('来源 Agent、版本或 Run 身份与实际 Run 不一致', 'conflict')
}
function pageCursor(value: unknown, total: number) {
  const cursor = value ?? 0
  if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || (cursor as number) > total) fail('来源分页 cursor 无效')
  return cursor as number
}
function pageLimit(value: unknown, fallback: number, maximum: number) {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > maximum) fail(`当前来源分页 limit 必须是 1–${maximum} 的整数（默认 ${fallback}）`)
  return limit as number
}
function requirePageDigest(body: MapValue, cursor: number, expected: string) {
  if (cursor > 0 && !body.source_sha256 || body.source_sha256 !== undefined && body.source_sha256 !== expected) fail('来源摘要缺失或已变化，请重新开始分页', 'conflict')
}
function requireIdentityDigest(body: MapValue, cursor: number, expected: string) {
  if (cursor > 0 && !body.source_identity_sha256 || body.source_identity_sha256 !== undefined && body.source_identity_sha256 !== expected) fail('完整来源身份摘要缺失或已变化，请重新开始读取', 'conflict')
}
const fileIdentityDigest = (origin: Awaited<ReturnType<typeof sourceIdentity>>, bundle: TraceSourceBundle) => digest([origin.source_identity_sha256, bundle.sha256])
function decisionSource(slice: DecisionSlice, identity: SourceIdentity, issues: string[]) {
  const withinLimit = Buffer.byteLength(JSON.stringify(slice.state)) <= DECISION_STATE_BYTES
  return { ...identity, decision_id: slice.id, kind: slice.kind, anchor: slice.anchor, eligible: slice.eligible && !issues.length && withinLimit,
    state: stateOf(slice), observed_action: slice.observed_action, outcome_refs: slice.outcome_refs, context_mode: slice.context_mode,
    limitations: [...slice.limitations, ...issues, ...(!withinLimit ? ['决策输入超过本轮 96 KiB 提取上限，不能截断成训练样本；可分片读取完整来源。'] : [])],
    ...(slice.lineage ? { lineage: slice.lineage } : {}) }
}

/** 仅保留旧调用方的题型校验入口；新版输入和目标分别校验。 */
export function validateDecisionQuestion(raw: unknown) {
  const value = object(raw), question = validateDecisionInputQuestion({ type: value.type, instructions: value.instructions, ...(value.criteria !== undefined ? { criteria: value.criteria } : {}) })
  const result = { ...question, ...validateDecisionLabel(question, value), src: text(value.src, 'src', 200) }
  noSecrets(result)
  return result
}
function storage(root: string) {
  const base = resolve(root, 'evolution/datasets')
  for (const path of [resolve(root, 'evolution'), base]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('数据集目录不得是符号链接', 'path_rejected')
  return base
}
function fileFor(root: string, id: unknown) {
  if (typeof id !== 'string' || !ID.test(id)) fail('数据集 ID 无效')
  const path = join(storage(root), `${id}.json`)
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('数据集不得通过符号链接读写', 'path_rejected')
  return path
}
function read(root: string, id: unknown) {
  const path = fileFor(root, id)
  if (!existsSync(path)) fail('数据集不存在', 'not_found')
  const content = readFileSync(path, 'utf8')
  if (content.length > 4 * 1024 * 1024) fail('数据集过大')
  const dataset = JSON.parse(content) as Dataset
  if (dataset.id !== id || !Array.isArray(dataset.records)) fail('数据集结构无效')
  return { dataset, sha256: digest(content) }
}
function all(root: string): Dataset[] {
  const base = storage(root)
  return existsSync(base) ? readdirSync(base).filter(name => name.endsWith('.json') && ID.test(name.slice(0, -5))).map(name => read(root, name.slice(0, -5)).dataset) : []
}
function write(root: string, dataset: Dataset, create = false) {
  const path = fileFor(root, dataset.id)
  mkdirSync(storage(root), { recursive: true })
  const content = JSON.stringify(clean(dataset), null, 2) + '\n'
  if (content.length > 4 * 1024 * 1024) fail('样本批次超过 4 MiB，请分批保存')
  if (create) writeFileSync(path, content, { flag: 'wx' })
  else { const temp = `${path}.${randomUUID()}.tmp`; writeFileSync(temp, content, { flag: 'wx' }); renameSync(temp, path) }
  return { dataset: clean(dataset), sha256: digest(content), file: `evolution/datasets/${dataset.id}.json` }
}
function stateOf(slice: DecisionSlice) {
  // 当前动作、后果、监督目标及来源位置不属于模型可见输入。
  return clean({ messages: slice.state.messages.map(({ ref: _ref, ...message }) => message), available_tools: slice.state.available_tools ?? null })
}
const groupOf = (slice: DecisionSlice) => slice.source_group_id ?? decisionSourceGroup(stateOf(slice), slice.anchor.session_log)
function contentHash(record: Pick<Sample, 'state' | 'questions' | 'task'>) {
  return digest(normalized([record.state, record.task.semantics, record.questions]))
}
function reviewInputIdentity(dataset: Dataset, record: Sample, sessionId: string) {
  return { session_id: sessionId, dataset_id: dataset.id, record_id: record._meta.id, run_id: dataset.run_id,
    path: dataset.path, trace_sha256: dataset.source_sha256, source_bundle_sha256: dataset.source_bundle?.sha256, state_sha256: digest(record.state) }
}
function identities(datasets: Dataset[]) {
  return new Set(datasets.filter(dataset => dataset.schema_version === 2).flatMap(dataset => dataset.records.flatMap(record => {
    try { return [record._meta.id, `decision-${contentHash(record).slice(0, 32)}`] } catch { return [record._meta?.id] }
  })))
}
function harnessSources(root: string) {
  const paths = HARNESS_PATHS
  const files = paths.map(path => {
    let file = root
    for (const part of path.split('/')) {
      file = join(file, part)
      if (!existsSync(file)) return { path, source_sha256: null }
      if (lstatSync(file).isSymbolicLink()) fail('抽取 Harness 不得通过符号链接读取', 'path_rejected')
    }
    if (!lstatSync(file).isFile() || lstatSync(file).size > 128 * 1024) fail('抽取 Harness 文件无效', 'assistant_assets_missing')
    const content = readFileSync(file, 'utf8')
    if (!content.trim()) fail('抽取 Harness 文件内容为空', 'assistant_assets_missing')
    return { path, source_sha256: digest(content) }
  })
  if (!files[1]!.source_sha256) fail('当前工作区缺少决策样本抽取技能，请先配置管理助手业务资产', 'assistant_assets_missing')
  return { files, sha256: digest(files), skill_path: paths[1]!, skill_sha256: files[1]!.source_sha256 }
}
function questionsAndTask(value: MapValue) {
  const workflow = text(value.workflow, 'workflow', 200), task = validateDecisionTask(value.task), questions = validateDecisionQuestions(value.questions)
  noSecrets({ workflow, task, questions })
  return { workflow, task, questions }
}
function observedTarget(task: DecisionTask, questions: Record<string, DecisionQuestion>, targets: Record<string, DecisionTarget>, action: any) {
  if (task.semantics !== 'observed_action') return
  for (const [key, target] of Object.entries(targets)) if (questions[key]?.type !== 'choice' || target.label !== action?.name || target.probabilities !== undefined) fail('observed_action 仅允许与所选真实动作名一致的 choice 硬标签，不能将观察动作伪装为推荐真值')
}
function timestamp(value: unknown) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
function modelIdentity(value: unknown) {
  const model = object(value)
  const provider = text(model.provider, '实际模型 provider', 200), modelName = text(model.model, '实际模型 model', 200)
  noSecrets(model)
  return { ...model, provider, model: modelName }
}
function validateDatasetEnvelope(dataset: Dataset) {
  if (dataset.schema_version !== 2 || !ID.test(dataset.id) || !timestamp(dataset.created_at) || !HASH.test(dataset.source_sha256) || !dataset.path || !Array.isArray(dataset.records) || dataset.records.length > 40) fail('数据集版本、身份、时间或来源摘要无效')
  if ((dataset.agent_id === undefined) !== (dataset.experiment_id === undefined)) fail('批次来源 Agent 和版本身份必须同时保留')
  const extractor = object(dataset.extractor), harness = object(extractor.harness_sources)
  text(extractor.session_id, '实际抽取 Session', 200)
  modelIdentity(extractor.model)
  if (extractor.skill !== 'decision-sample-extraction' || extractor.skill_path !== HARNESS_PATHS[1] || !HASH.test(extractor.skill_sha256) || extractor.format !== 'decision-dataset-v2') fail('实际抽取技能身份或摘要无效')
  if (!Array.isArray(harness.files) || harness.files.length !== HARNESS_PATHS.length || harness.files.some((file: any, index: number) => !file || file.path !== HARNESS_PATHS[index] || file.source_sha256 !== null && !HASH.test(file.source_sha256)) || harness.sha256 !== digest(harness.files) || harness.files[1].source_sha256 !== extractor.skill_sha256 || harness.skill_path !== extractor.skill_path || harness.skill_sha256 !== extractor.skill_sha256) fail('历史抽取 Harness 来源清单无效')
  if (new Set(dataset.records.map(record => record?._meta?.id)).size !== dataset.records.length) fail('数据集内样本身份重复')
}
function provenanceValid(provenance: MapValue, dataset: Dataset, record: Sample, origin = false): boolean {
  if (provenance.kind === 'model_suggestion') return (origin || record.task.semantics === 'recommended_decision') && typeof provenance.session_id === 'string' && !!provenance.session_id.trim() && HASH.test(provenance.skill_sha256) && provenance.session_id === dataset.extractor.session_id && equal(provenance.model, dataset.extractor.model) && provenance.skill_sha256 === dataset.extractor.skill_sha256 && provenance.calibration === 'uncalibrated'
  if (provenance.kind === 'observed_action') return (origin || record.task.semantics === 'observed_action') && provenance.run_id === dataset.run_id && provenance.decision_id === record._meta.decision_id && provenance.trace_sha256 === dataset.source_sha256 && equal(provenance.ref, record._meta.cutoff)
  if (provenance.kind === 'human_annotation') return timestamp(provenance.annotated_at) && (!provenance.origin || provenanceValid(object(provenance.origin), dataset, record, true))
  if (provenance.kind === 'ai_annotation') return timestamp(provenance.annotated_at) && typeof provenance.session_id === 'string' && !!provenance.session_id.trim()
    && provenance.purpose === 'functional_validation' && typeof provenance.model?.provider === 'string' && typeof provenance.model?.model === 'string'
    && (!provenance.origin || provenanceValid(object(provenance.origin), dataset, record, true))
  return false
}
async function verifySource(root: string, dataset: Dataset, signal?: AbortSignal) {
  validateDatasetEnvelope(dataset)
  if (!dataset.source_bundle || dataset.source_bundle.schema_version !== 1 || !Array.isArray(dataset.source_bundle.files) || dataset.source_bundle.sha256 !== digest(dataset.source_bundle.files)) fail('缺少完整且有效的来源集合摘要，请重新抽取')
  const loaded = await loadRunTrace(root, { run_id: dataset.run_id, path: dataset.path, source_sha256: dataset.source_sha256 }, signal, false)
  if (!equal(loaded.source_bundle.files, dataset.source_bundle.files)) fail('决策来源集合发生变化，请重新抽取', 'conflict')
  const origin = await sourceIdentity(root, dataset.run_id, signal, loaded.source_bundle)
  assertSourceIdentity(dataset, origin.identity)
  if (dataset.source_version !== undefined && !equal(dataset.source_version, origin.source_version)) fail('样本来源版本与 Run 冻结输入不一致', 'conflict')
  if (loaded.source_bundle.issues.length) fail(`来源不再满足抽取合同：${loaded.source_bundle.issues.join('；')}`)
  return { loaded, decisions: buildDecisionSlices(loaded.events), ...origin }
}
function verifyRecord(dataset: Dataset, record: Sample, decisions: DecisionSlice[], identity: SourceIdentity) {
  if (!record || !record._meta || !RECORD_ID.test(record._meta.id) || !HASH.test(record._meta.content_sha256)) fail('样本 ID 或内容摘要无效')
  const slice = decisions.find(value => value.id === record._meta?.decision_id)
  if (!slice?.eligible || Buffer.byteLength(JSON.stringify(slice.state)) > DECISION_STATE_BYTES) fail('所选决策不存在或材料不足，请重新抽取')
  assertSourceIdentity(record._meta, identity)
  if (!equal(record._meta.lineage, slice.lineage)) fail('样本主体或委派来源与固定决策不一致')
  if (dataset.agent_id !== undefined && (record._meta.agent_id !== identity.agent_id || record._meta.experiment_id !== identity.experiment_id)) fail('样本缺少与批次一致的来源 Agent 和版本身份')
  if (record._meta.source_version !== undefined && !equal(record._meta.source_version, dataset.source_version)) fail('样本来源版本与批次不一致')
  if (!equal(record.state, stateOf(slice))) fail('state 与固定来源中的决策前材料不一致')
  if (record._meta.source_group_id !== groupOf(slice)) fail('固定来源组与决策来源不一致，不可改名移除同源关系')
  if (record._meta.run_id !== dataset.run_id || record._meta.trace_path !== dataset.path || record._meta.trace_sha256 !== dataset.source_sha256 || !equal(record._meta.cutoff, slice.anchor) || !equal(record._meta.observed_action, slice.observed_action) || record._meta.context_mode !== slice.context_mode || !equal(record._meta.evidence_refs, slice.context_refs) || !equal(record._meta.outcome_refs, slice.outcome_refs)) fail('样本来源定位与固定决策不一致')
  if (!Array.isArray(record._meta.group_history) || record._meta.group_history.some((group: unknown) => typeof group !== 'string' || !group.trim() || group.length > 200) || !record._meta.group_history.includes(record._meta.group_id) || !record._meta.group_history.includes(record._meta.source_group_id)) fail('人工关联组历史无效，不能擦除已知关联')
  if (!DECISION_SPLITS.includes(record._meta.split)) fail('划分用途无效')
  const parsed = questionsAndTask(record), targets = validateDecisionTargets(parsed.questions, record.targets)
  if (record._meta.content_sha256 !== contentHash(record)) fail('样本内容摘要与当前输入问题不一致')
  noSecrets(targets)
  observedTarget(parsed.task, parsed.questions, targets, slice.observed_action)
  if (!equal(record.questions, parsed.questions) || !equal(record.task, parsed.task) || record.workflow !== parsed.workflow) fail('决策输入合同不一致')
  for (const target of Object.values(targets)) {
    if (!provenanceValid(target.provenance, dataset, record)) fail('监督语义或标签来源与实际抽取来源不一致')
    if (target.status === 'reviewed' && !timestamp(target.reviewed_at)) fail('逐题复核时间缺失或无效')
    if (target.review?.input_evidence) validateDecisionInputEvidence(target.review.input_evidence, reviewInputIdentity(dataset, record, target.review.session_id))
  }
  return slice
}
function links(record: Sample) {
  return [...new Set([record._meta?.source_group_id ?? decisionSourceGroup(record.state, record._meta?.cutoff?.session_log), record._meta?.group_id, ...(Array.isArray(record._meta?.group_history) ? record._meta.group_history : [])].filter((value): value is string => typeof value === 'string' && !!value))]
}
function related(record: Sample, records: Sample[]): Sample[] {
  const known = new Set(links(record)), result = new Set<Sample>()
  let changed = true
  while (changed) { changed = false; for (const item of records) if (!result.has(item) && links(item).some(key => known.has(key))) { result.add(item); links(item).forEach(key => known.add(key)); changed = true } }
  return [...result]
}
function splitConflict(record: Sample, records: Sample[]) {
  const assigned = new Set(related(record, records).map(item => item._meta?.split).filter(split => split && split !== 'unassigned'))
  return assigned.size > 1
}
function sourceError(error: unknown) { return error instanceof Error ? error.message : '无法核对固定来源' }
type CheckedSource = Awaited<ReturnType<typeof verifySource>>
function eligibilityFromSource(dataset: Dataset, datasets: Dataset[], checked: CheckedSource | null, error: string | null = null) {
  const counts = Object.fromEntries(MODES.map(mode => [mode, 0])) as Record<string, number>
  const records: RecordEligibility[] = [], allRecords = datasets.flatMap(item => item.records)
  for (const record of dataset.records) {
    const result: RecordEligibility = { record_id: record._meta?.id ?? '<缺少ID>', legacy: dataset.schema_version !== 2, eligible_questions: [], reasons: [], question_reasons: {}, export_modes: [] }
    const targets = record.targets && typeof record.targets === 'object' ? Object.values(record.targets) : []
    if (result.legacy || !targets.length || targets.some(target => target?.status !== 'rejected')) { counts.candidates!++; result.export_modes.push('candidates') }
    if (result.legacy) result.reasons.push('旧格式只读候选；历史 reviewed 不会自动升级为新版合格样本，请重新抽取')
    else {
      if (error) result.reasons.push(error)
      if (checked) { try { verifyRecord(dataset, record, checked.decisions, checked.identity) } catch (reason) { result.reasons.push(sourceError(reason)) } }
      if (splitConflict(record, allRecords)) result.reasons.push('已知同源或人工关联组存在跨训练、开发、校准与测试用途冲突')
      if (record._meta?.split === 'unassigned') result.reasons.push('尚未显式分配 train、development、calibration 或 test 用途；unassigned 不进入训练')
      for (const [key, target] of Object.entries(record.targets ?? {})) {
        const reasons: string[] = []
        if (target?.status !== 'reviewed') reasons.push(target?.status === 'rejected' ? '该题已拒绝' : '该题尚未逐题复核')
        if (target?.decision_time_reviewed !== true) reasons.push('该题尚未完成决策时点及输入可答性核对')
        if (target?.review?.kind === 'ai_delegated' && !target.review.input_evidence) reasons.push('AI 复核尚缺该会话完整决策输入的读取证据')
        result.question_reasons[key] = reasons
        if (!reasons.length && !result.reasons.length) result.eligible_questions.push(key)
      }
      if (!result.eligible_questions.length && !result.reasons.length) result.reasons.push('尚无已复核且完成决策时点核对的题目')
      if (result.eligible_questions.length) { const mode = record._meta.split === 'train' ? 'training' : record._meta.split; result.export_modes.push(mode); counts[mode]!++ }
    }
    records.push(result)
  }
  return { counts, records, blocked: records.filter(record => record.reasons.length).map(({ record_id, reasons }) => ({ record_id, reasons })) }
}

async function eligibility(root: string, dataset: Dataset, datasets: Dataset[], signal?: AbortSignal) {
  let checked: CheckedSource | null = null, error: string | null = null
  if (dataset.schema_version === 2) { try { checked = await verifySource(root, dataset, signal) } catch (reason) { signal?.throwIfAborted(); error = sourceError(reason) } }
  return eligibilityFromSource(dataset, datasets, checked, error)
}

export function createDecisionDatasetHandler(root: string) {
  const previews = new Map<string, { dataset: Dataset; owner: string; created: number }>()
  async function response(saved: ReturnType<typeof read> & { file?: string }, signal?: AbortSignal) { return { ...saved, eligibility: await eligibility(root, saved.dataset, all(root), signal) } }
  return async function handle(endpoint: string, body: MapValue, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted()
    try {
      if (endpoint === 'datasets/source') {
        const runId = text(body.run_id, 'run_id')
        if (!body.path) {
          if (body.decision_id !== undefined) fail('读取决策分片必须指定 path')
          const origin = await sourceIdentity(root, runId, signal)
          assertSourceIdentity(body, origin.identity)
          const files = await listRunTraceSources(root, runId, signal), source_sha256 = digest([origin, files])
          const cursor = pageCursor(body.cursor, files.length), limit = pageLimit(body.limit, 8, 20)
          requirePageDigest(body, cursor, source_sha256)
          requireIdentityDigest(body, cursor, origin.source_identity_sha256)
          const result = { kind: 'sources', ...origin.identity, ...(origin.source_version ? { source_version: origin.source_version } : {}), source_sha256, source_identity_sha256: origin.source_identity_sha256,
            total_files: files.length, cursor, next_cursor: null as number | null, files: [] as typeof files,
            ...(cursor === 0 ? { extraction_contract: DECISION_EXTRACTION_CONTRACT } : {}),
            instructions: '目录与决策分别分页；next_cursor 非空时携带同一 source_sha256 和 source_identity_sha256 续读。选择 target path 后从 cursor:0 开始读取该文件，不携带目录页的两种摘要；不要将首个文件当作完整 Run。' }
          for (const file of files.slice(cursor, cursor + limit)) {
            if (JSON.stringify({ ...result, files: [...result.files, file] }).length > SOURCE_PAGE_CHARACTERS) break
            result.files.push(file)
          }
          if (!result.files.length && cursor < files.length) fail('单条来源目录信息超过接口上限')
          result.next_cursor = cursor + result.files.length < files.length ? cursor + result.files.length : null
          return result
        }
        const loaded = await loadRunTrace(root, { run_id: runId, path: body.path, ...(body.source_sha256 ? { source_sha256: body.source_sha256 } : {}) }, signal, false)
        const origin = await sourceIdentity(root, runId, signal, loaded.source_bundle)
        assertSourceIdentity(body, origin.identity)
        const decisions = buildDecisionSlices(loaded.events)
        const source_identity_sha256 = fileIdentityDigest(origin, loaded.source_bundle)
        const common = { ...origin.identity, ...(origin.source_version ? { source_version: origin.source_version } : {}), path: loaded.source.path, source_sha256: loaded.source_sha256, source_identity_sha256 }
        if (body.decision_id !== undefined) {
          const slice = decisions.find(value => value.id === body.decision_id)
          if (!slice) fail('所选决策不存在，请核对 path 和 decision_id')
          const content = JSON.stringify(decisionSource(slice, origin.identity, loaded.source_bundle.issues)), cursor = pageCursor(body.cursor, content.length)
          requirePageDigest(body, cursor, loaded.source_sha256)
          requireIdentityDigest(body, cursor, source_identity_sha256)
          const content_sha256 = digest(content)
          if (cursor > 0 && !body.content_sha256 || body.content_sha256 !== undefined && body.content_sha256 !== content_sha256) fail('决策正文摘要缺失或已变化，请重新读取该决策', 'conflict')
          if (cursor > 0 && /[\uDC00-\uDFFF]/.test(content[cursor] ?? '')) fail('分片 cursor 必须使用上次返回的 next_cursor')
          const limit = pageLimit(body.limit, 4000, 6000)
          let end = Math.min(content.length, cursor + limit)
          if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1] ?? '')) end--
          if (end === cursor && cursor < content.length) end = Math.min(content.length, cursor + 2)
          return { kind: 'decision_fragment', ...common, decision_id: slice.id, content_sha256, content_format: 'json',
            total_characters: content.length, cursor, next_cursor: end < content.length ? end : null, complete: end === content.length, fragment: content.slice(cursor, end),
            read_input: end < content.length ? { run_id: runId, path: loaded.source.path, source_sha256: loaded.source_sha256, source_identity_sha256,
              decision_id: slice.id, content_sha256, cursor: end, limit } : null }
        }
        const cursor = pageCursor(body.cursor, decisions.length), limit = pageLimit(body.limit, 3, 3)
        requirePageDigest(body, cursor, loaded.source_sha256)
        requireIdentityDigest(body, cursor, source_identity_sha256)
        const result = { kind: 'decisions', ...common, total_decisions: decisions.length, cursor, next_cursor: null as number | null, decisions: [] as MapValue[],
          source_bundle: loaded.source_bundle, ...(cursor === 0 ? { extraction_contract: DECISION_EXTRACTION_CONTRACT } : {}), warnings: loaded.source.warnings }
        for (const slice of decisions.slice(cursor, cursor + limit)) {
          const complete = decisionSource(slice, origin.identity, loaded.source_bundle.issues), content = JSON.stringify(complete)
          const value = JSON.stringify({ ...result, decisions: [...result.decisions, complete] }).length <= SOURCE_PAGE_CHARACTERS ? complete
            : { ...origin.identity, decision_id: slice.id, kind: slice.kind, anchor: slice.anchor, eligible: complete.eligible, state: null,
              observed_action: { name: slice.observed_action.name }, context_mode: slice.context_mode, detail_required: true,
              ...(complete.lineage ? { lineage_required: true, actor_kind: complete.lineage.kind } : {}),
              content_sha256: digest(content), total_characters: content.length,
              read_input: { run_id: runId, path: loaded.source.path, source_sha256: loaded.source_sha256, source_identity_sha256, decision_id: slice.id, content_sha256: digest(content), cursor: 0, limit: 4000 } }
          if (JSON.stringify({ ...result, decisions: [...result.decisions, value] }).length > SOURCE_PAGE_CHARACTERS) break
          result.decisions.push(value)
        }
        if (!result.decisions.length && cursor < decisions.length) fail('单条决策定位信息超过接口上限')
        result.next_cursor = cursor + result.decisions.length < decisions.length ? cursor + result.decisions.length : null
        return result
      }
      if (endpoint === 'datasets/preview') {
        const harness = harnessSources(root)
        const loaded = await loadRunTrace(root, { run_id: text(body.run_id, 'run_id'), path: text(body.path, 'path'), source_sha256: text(body.source_sha256, 'source_sha256') }, signal, false)
        const origin = await sourceIdentity(root, body.run_id, signal, loaded.source_bundle)
        assertSourceIdentity(body, origin.identity)
        requireIdentityDigest(body, 0, fileIdentityDigest(origin, loaded.source_bundle))
        if (loaded.source_bundle.issues.length) fail(`来源不足：${loaded.source_bundle.issues.join('；')}`)
        const decisions = buildDecisionSlices(loaded.events)
        if (!Array.isArray(body.samples) || body.samples.length > 40) fail('samples 必须是最多 40 条的数组')
        const skipped: string[] = []
        if (body.skipped !== undefined) {
          if (!Array.isArray(body.skipped) || body.skipped.length > 100) fail('skipped 必须是最多 100 个非空跳过原因字符串的数组，不能是对象或字典')
          for (const [index, reason] of body.skipped.entries()) {
            if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) fail(`skipped[${index}] 必须是最多 2000 字符的非空原因字符串，不能是对象`)
            skipped.push(reason.trim())
          }
        }
        const existing = identities(all(root)), records: Sample[] = [], owner = text(body.assistant_session_id, 'assistant_session_id')
        const extractor = { session_id: owner, model: clean(modelIdentity(body.assistant_model)), skill: 'decision-sample-extraction', skill_path: harness.skill_path, skill_sha256: harness.skill_sha256, harness_sources: harness, format: 'decision-dataset-v2' }
        for (const raw of body.samples) {
          const draft = object(raw), slice = decisions.find(value => value.id === draft.decision_id)
          if (!slice?.eligible || Buffer.byteLength(JSON.stringify(slice.state)) > DECISION_STATE_BYTES) fail('决策不存在或材料不足，不能保存训练候选')
          assertSourceIdentity(draft, origin.identity)
          if (draft._meta !== undefined) fail('样本来源 _meta 由服务器生成，不能从客户端提供')
          if (draft.action_name !== slice.observed_action.name) fail('action_name 与所选决策的实际动作不一致，请重新核对 decision_id；工具查询前不能冒称已取得查询结果')
          const parsed = questionsAndTask(draft), state = stateOf(slice), rawTargets = object(draft.targets)
          if (draft.state !== undefined && !equal(draft.state, state)) fail('不能伪造 state；输入只能来自决策前可见材料')
          const targets = validateDecisionTargets(parsed.questions, Object.fromEntries(Object.entries(rawTargets).map(([key, value]) => {
            const target = object(value)
            if (target.provenance && object(target.provenance).kind !== 'model_suggestion' || target.status && target.status !== 'suggested' || target.decision_time_reviewed === true) fail('AI 预览不得自报人工标注、教师聚合或已复核来源')
            return [key, { ...target, provenance: parsed.task.semantics === 'observed_action' ? { kind: 'observed_action', run_id: body.run_id, decision_id: slice.id, trace_sha256: loaded.source_sha256, ref: slice.anchor } : { kind: 'model_suggestion', session_id: owner, model: extractor.model, skill_sha256: harness.skill_sha256, calibration: 'uncalibrated' }, status: 'suggested', decision_time_reviewed: false }]
          })))
          noSecrets(targets); observedTarget(parsed.task, parsed.questions, targets, slice.observed_action)
          const record: Sample = { state, ...parsed, targets, _meta: {} }, content_sha256 = contentHash(record), id = `decision-${content_sha256.slice(0, 32)}`
          if (existing.has(id) || records.some(record => record._meta.id === id)) { skipped.push(`${slice.id}：相同题目已存在，保留既有人工内容`); continue }
          const group = groupOf(slice)
          record._meta = { id, content_sha256, source_group_id: group, group_id: group, group_history: [group], source: 'dsh_run', variant: 'clean', ...origin.identity,
            ...(origin.source_version ? { source_version: origin.source_version } : {}), ...(slice.lineage ? { lineage: slice.lineage } : {}),
            trace_path: loaded.source.path, trace_sha256: loaded.source_sha256, decision_id: slice.id, cutoff: slice.anchor, context_mode: slice.context_mode, evidence_refs: slice.context_refs, observed_action: slice.observed_action, outcome_refs: slice.outcome_refs, limitations: slice.limitations, split: 'unassigned' }
          records.push(record)
        }
        const dataset: Dataset = { schema_version: 2, id: `decision-dataset-${randomUUID()}`, ...origin.identity,
          ...(origin.source_version ? { source_version: origin.source_version } : {}), path: loaded.source.path, source_sha256: loaded.source_sha256, source_bundle: loaded.source_bundle, created_at: new Date().toISOString(), extractor, records, skipped }
        validateDatasetEnvelope(dataset)
        for (const [key, value] of previews) if (Date.now() - value.created > 30 * 60_000) previews.delete(key)
        if (!records.length) return { schema_version: 2, ...origin.identity, count: 0, skipped, message: '没有可保存的候选；未创建数据集文件。' }
        const preview_id = randomUUID(); previews.set(preview_id, { dataset, owner, created: Date.now() })
        return { schema_version: 2, preview_id, ...origin.identity, count: records.length, question_count: records.reduce((sum, record) => sum + Object.keys(record.questions).length, 0), status: 'suggested', records, skipped, file: `evolution/datasets/${dataset.id}.json`, message: '候选已通过预览校验；保存后，训练或留出导出仍需逐题复核及显式分配用途。' }
      }
      if (endpoint === 'datasets/apply') {
        const preview = previews.get(body.preview_id)
        if (!preview || preview.owner !== body.assistant_session_id || Date.now() - preview.created > 30 * 60_000) fail('预览已失效，请重新抽取', 'conflict')
        const checked = await verifySource(root, preview.dataset, signal)
        preview.dataset.records.forEach(record => verifyRecord(preview.dataset, record, checked.decisions, checked.identity))
        // 异步来源读取后再同步检查并写入，避免并发确认覆盖已保存批次。
        const datasets = all(root), existing = identities(datasets)
        if (preview.dataset.records.some(record => existing.has(record._meta.id))) fail('相同题目已被其他任务保存，请重新抽取', 'conflict')
        if (!equal(harnessSources(root), preview.dataset.extractor.harness_sources)) fail('抽取 Harness 来源发生变化，请重新抽取', 'conflict')
        const qualified = eligibilityFromSource(preview.dataset, [...datasets, preview.dataset], checked)
        // 提交前处理取消；提交后直接返回回执，不再引入可取消的异步附带读取。
        signal?.throwIfAborted()
        const saved = write(root, preview.dataset, true); previews.delete(body.preview_id)
        return { ...saved, eligibility: qualified }
      }
      if (endpoint === 'datasets/list') {
        if (body.include_eligibility !== undefined && typeof body.include_eligibility !== 'boolean') fail('include_eligibility 必须是布尔值')
        const datasets = all(root)
        return { datasets: await Promise.all(datasets.filter(dataset => !body.run_id || dataset.run_id === body.run_id).map(async dataset => {
          const qualified = body.include_eligibility === false ? null : await eligibility(root, dataset, datasets, signal)
          return { id: dataset.id, schema_version: dataset.schema_version ?? 1, run_id: dataset.run_id, path: dataset.path,
            ...(dataset.agent_id ? { agent_id: dataset.agent_id, experiment_id: dataset.experiment_id } : {}), created_at: dataset.created_at,
            count: dataset.records.length, reviewed: dataset.schema_version === 2 ? dataset.records.filter(record => Object.values(record.targets ?? {}).some(isDecisionTargetReviewed)).length : dataset.records.filter(record => record._meta?.label_status === 'reviewed').length,
            eligibility_checked: qualified !== null, ...(qualified ? { eligibility: qualified } : {}) }
        })) }
      }
      if (endpoint === 'datasets/read') return response(read(root, body.dataset_id), signal)
      if (endpoint === 'datasets/update' || endpoint === 'datasets/review') {
        const delegated = endpoint === 'datasets/review', now = new Date().toISOString()
        const reviewer: DecisionReview | null = delegated ? { kind: 'ai_delegated' as const, session_id: text(body.assistant_session_id, '实际复核 Session', 200),
          model: modelIdentity(body.assistant_model), reviewed_at: now, purpose: 'functional_validation' as const } : null
        const current = read(root, body.dataset_id)
        if (current.sha256 !== body.expected_sha256) fail('样本已被其他任务修改，当前草稿需重新核对', 'conflict')
        if (current.dataset.schema_version !== 2) fail('旧格式样本只读；请重新抽取为新版批次，不能自动升级历史 reviewed')
        const record = current.dataset.records.find(item => item._meta.id === body.record_id)
        if (!record) fail('样本不存在', 'not_found')
        if (reviewer) {
          try { reviewer.input_evidence = validateDecisionInputEvidence(body.assistant_input_evidence, reviewInputIdentity(current.dataset, record, reviewer.session_id)) }
          catch { fail('AI 复核缺少与本题一致的完整输入读取证据；请在当前会话读完决策输入后重新核对', 'review_input_incomplete') }
        }
        const checked = await verifySource(root, current.dataset, signal)
        verifyRecord(current.dataset, record, checked.decisions, checked.identity)
        if (body.state !== undefined && !equal(body.state, record.state)) fail('state 与固定来源中的决策前材料不一致')
        const parsed = questionsAndTask(body)
        let targetInput = body.targets
        if (reviewer) {
          targetInput = Object.fromEntries(Object.entries(object(body.targets)).map(([key, raw]) => {
            const value = object(raw)
            if (Object.keys(value).some(name => !['label', 'basis', 'probabilities', 'status', 'decision_time_reviewed'].includes(name))) fail('受托复核仅提供标签、依据、概率与复核状态；来源和复核身份由服务器记录')
            if (!['reviewed', 'rejected'].includes(value.status)) fail('受托复核必须明确通过或拒绝该题')
            return [key, { ...value, provenance: record.targets[key]?.provenance ?? { kind: 'ai_annotation', annotated_at: now,
              session_id: reviewer.session_id, model: reviewer.model, purpose: reviewer.purpose } }]
          }))
        }
        const requested = validateDecisionTargets(parsed.questions, targetInput)
        const taskChanged = record.workflow !== parsed.workflow || !equal(record.task, parsed.task)
        const targets = Object.fromEntries(Object.entries(requested).map(([key, target]) => {
          const old = record.targets[key], changed = taskChanged || !equal(record.questions[key], parsed.questions[key]) || !old || !equal([old.label, old.probabilities ?? null, old.basis], [target.label, target.probabilities ?? null, target.basis])
          if (target.provenance.kind === 'human_annotation' && old && !equal(target.provenance, old.provenance)) fail('标签来源由服务器固定，不能伪造人工或教师来源')
          if (old && !equal(target.provenance, old.provenance)) fail('标签来源由服务器固定，请保留原始来源')
          const provenance = changed ? { kind: reviewer ? 'ai_annotation' : 'human_annotation', annotated_at: now,
            ...(reviewer ? { session_id: reviewer.session_id, model: reviewer.model, purpose: reviewer.purpose } : {}),
            ...(old ? { origin: ['human_annotation', 'ai_annotation'].includes(old.provenance.kind) ? old.provenance.origin ?? old.provenance : old.provenance } : {}) } : old!.provenance
          const reviewed = (!changed || delegated) && target.status === 'reviewed'
          const { review: _previousReview, ...value } = target
          const suppliedReview = object(body.targets)[key]?.review
          if (!delegated && suppliedReview !== undefined && suppliedReview !== null && !equal(suppliedReview, old?.review)) fail('复核身份由服务器记录，不可伪造')
          const retainedReview = !delegated && !changed && suppliedReview !== null && old?.review
            && old.status === target.status && old.decision_time_reviewed === target.decision_time_reviewed ? old.review : undefined
          return [key, { ...value, provenance, status: changed && !delegated && target.status !== 'rejected' ? 'suggested' as const : target.status,
            decision_time_reviewed: reviewed && target.decision_time_reviewed === true, reviewed_at: reviewed ? delegated || suppliedReview === null ? now : old?.reviewed_at ?? now : null,
            ...(reviewer ? { review: reviewer } : retainedReview ? { review: retainedReview } : {}) }]
        }))
        noSecrets(targets); observedTarget(parsed.task, parsed.questions, targets, record._meta.observed_action)
        const group = text(body.group_id, 'group_id', 200), split = text(body.split, 'split', 30)
        if (!(DECISION_SPLITS as readonly string[]).includes(split)) fail('划分用途无效')
        const revised: Sample = { state: record.state, ...parsed, targets, _meta: { ...record._meta, group_id: group, group_history: [...new Set([...record._meta.group_history, record._meta.source_group_id, record._meta.group_id, group])], split } }
        revised._meta.content_sha256 = contentHash(revised)
        const datasets = all(root), others = datasets.flatMap(dataset => dataset.records).filter(item => item._meta.id !== record._meta.id)
        if (identities(datasets.map(dataset => ({ ...dataset, records: dataset.records.filter(item => item._meta.id !== record._meta.id) }))).has(`decision-${contentHash(revised).slice(0, 32)}`)) fail('相同内容的题目已存在，请保留一条并合并复核', 'conflict')
        if (splitConflict(revised, [...others, revised])) fail('同一任务分组或已知人工关联组不能跨训练、开发、校准与测试用途')
        // 来源读取可能让出事件循环，写入前必须重新核对乐观锁。
        if (read(root, body.dataset_id).sha256 !== body.expected_sha256) fail('样本已被其他任务修改，当前草稿需重新核对', 'conflict')
        current.dataset.records[current.dataset.records.indexOf(record)] = revised
        const qualified = eligibilityFromSource(current.dataset, datasets.map(dataset => dataset.id === current.dataset.id ? current.dataset : dataset), checked)
        signal?.throwIfAborted()
        return { ...write(root, current.dataset), eligibility: qualified }
      }
      if (endpoint === 'datasets/export') {
        const { dataset, sha256 } = read(root, body.dataset_id), mode = body.mode ?? body.kind ?? 'training'
        if (!MODES.includes(mode)) fail('导出类型必须是 candidates、training、development、calibration 或 test')
        const qualified = await eligibility(root, dataset, all(root), signal), records: Sample[] = []
        if (read(root, body.dataset_id).sha256 !== sha256) fail('样本在导出核对期间发生变化，请重新下载', 'conflict')
        const currentRecords = all(root).flatMap(value => value.records)
        let omitted_question_count = 0
        for (const [index, record] of dataset.records.entries()) {
          const item = qualified.records[index]!
          if (!item.export_modes.includes(mode)) { omitted_question_count += Object.keys(record.questions ?? {}).length; continue }
          if (mode === 'candidates' || item.legacy) { records.push(record); continue }
          if (splitConflict(record, currentRecords)) fail('同源或人工关联组在导出核对期间发生用途冲突，请重新核对', 'conflict')
          const keys = item.eligible_questions
          omitted_question_count += Object.keys(record.questions).length - keys.length
          const projected = { ...record, questions: Object.fromEntries(keys.map(key => [key, record.questions[key]!])), targets: Object.fromEntries(keys.map(key => [key, record.targets[key]!])) }
          projected._meta = { ...record._meta, source_record_content_sha256: record._meta.content_sha256, content_sha256: contentHash(projected) }
          records.push(projected)
        }
        if (!records.length) fail(mode === 'candidates' ? '没有可导出的候选样本' : `尚无符合 ${mode} 用途且完成逐题复核、决策时点核对及来源验证的样本；${qualified.records.flatMap(record => record.reasons).join('；')}`)
        return { filename: `${dataset.id}-${mode === 'candidates' ? 'candidates' : `reviewed-${mode}`}.jsonl`, schema_version: dataset.schema_version ?? 1, count: records.length, question_count: records.reduce((sum, record) => sum + Object.keys(record.questions ?? {}).length, 0), omitted_question_count, blocked: qualified.blocked, eligibility: qualified, content: records.map(record => JSON.stringify(clean({ schema_version: dataset.schema_version ?? 1, ...record, _meta: { ...record._meta, dataset_id: dataset.id, source_bundle_sha256: dataset.source_bundle?.sha256, extractor: dataset.extractor } }))).join('\n') + '\n' }
      }
      fail('未知数据集操作', 'not_found')
    } catch (error) {
      if (error instanceof RunFileError || signal?.aborted) throw error
      fail(sourceError(error))
    }
  }
}
