import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { parseEvaluationDocument } from '../evaluation/cases.ts'
import { readRunEvidenceFile } from './run-files.ts'
import { extractGraphExecutions, measureModelUsage, normalizeTokenUsage } from '../evaluation/model-usage.ts'
import type { ModelAttempt } from '../evaluation/model-attempts.ts'
import { inspectComputeBuild } from './compute-build.ts'
import { computeGenerationContract } from './compute-generation-contract.ts'
import { isCodeOnlyModelRoute } from '../workflows/code-only-route.ts'

type Map = Record<string, any>
type Result = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }
export interface ComputeVariantServices {
  createExperiment(payload: Map): Promise<unknown>
  readRun(runId: string, signal?: AbortSignal): Promise<any>
  candidateDigest(experimentId: string): string
  gitCandidateDigest(experimentId: string, ref: string): string | null
}
export type ComputeMetric = 'model_calls' | 'actual_model_calls' | 'input_tokens' | 'output_tokens' | 'total_tokens' | 'elapsed_ms'
type GenerationPlan = { mode: 'langgraph-aot'; entry_path: string; source_run_ids: string[]; fixture_sha256?: string; source_evidence?: { run_id: string; path: string; sha256: string }[] }
export interface ComputePlan {
  schema_version: 1
  created_at: string
  strategy: string
  case_hashes: Record<string, string>
  critical_case_ids: string[]
  min_runs_per_case: number
  max_pass_rate_drop_pp: number
  resource_metric: ComputeMetric
  min_resource_reduction_pct: number
  model_change: { model: string; reasoning_effort: string } | null
  execution_mode?: 'code-only'
  measurement_schema_version?: 2
  generation?: GenerationPlan
}
const EXP = /^EXP-([a-z0-9]+(?:-[a-z0-9]+)*)-\d{3}(?:-r[0-9a-f]{12})?$/
const RUN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const METRICS: ComputeMetric[] = ['model_calls', 'actual_model_calls', 'input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms']
// DSH 21638c563 TokenUsage 的输入/缓存桶互不重叠，reasoning 已包含在输出中。
// 依照 token-meter/turn-usage 的合同，不把缓存命中变化当作上下文变化。
class VariantError extends Error { constructor(readonly code: string, message: string) { super(message) } }
const fail = (message: string): never => { throw new VariantError('invalid_request', message) }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function canonical(value: any): string { return JSON.stringify(normalize(value)) }
function normalize(value: any): any {
  return Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
}
const same = (left: any, right: any) => canonical(left) === canonical(right)
// change_sha256 仅用于当次 Decision 的并发校验；写研究结论不改变实际比较事实。
function comparisonEvidence(result: Map) {
  const { change_sha256: _change, comparison_sha256: _comparison, comparison_receipt: _receipt, ...evidence } = result
  return { schema_version: 1, comparison: evidence }
}
function workflowLoadEvidence(graphs: ReturnType<typeof extractGraphExecutions>, receipt: Map) {
  const fixed = new Set<string>(), nested = new Set<string>()
  let fixedReceipts = true
  for (const graph of graphs.executions) for (const step of Array.isArray(graph.trace) ? graph.trace : []) {
    if (!step || typeof step !== 'object') continue
    let actual = step.result?.structuredContent ?? step.result
    for (const block of Array.isArray(step.result?.content) ? step.result.content : []) if (block?.type === 'text') {
      try { actual = JSON.parse(block.text); break } catch { /* 普通文字不是固定组合执行回执。 */ }
    }
    const child = step.meta?.graph_execution ?? actual?.graph_execution
    const expected = step.meta?.fixed_composition
    if (child?.execution_id) nested.add(child.execution_id)
    if ((!child && !expected) || child?.workflow_id) continue
    if (!child || !expected || typeof expected.composition_id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(expected.composition_id)
      || !/^[0-9a-f]{64}$/.test(expected.version_id ?? '') || !/^[0-9a-f]{64}$/.test(expected.implementation_digest ?? '')
      || !/^[0-9a-f]{64}$/.test(actual?.version?.sourceDigest ?? '') || actual?.ok !== true || step.result?.isError === true || child.complete !== true
      || actual.version?.versionId !== expected.version_id || actual.version?.implementationDigest !== expected.implementation_digest
      || child.build_digest !== expected.implementation_digest || child.source_digest !== actual.version?.sourceDigest) fixedReceipts = false
    else fixed.add(child.execution_id)
  }
  const workflows = graphs.executions.filter(graph => typeof graph.workflow_id === 'string' && graph.workflow_id)
  const wrappers = workflows.filter(graph => !nested.has(graph.execution_id))
  return {
    artifacts: wrappers.length > 0 && wrappers.every(graph => graph.esm_sha256 === receipt.esm_sha256 && graph.build_digest === receipt.build_digest),
    codeOnly: wrappers.length > 0 && wrappers.every(graph => graph.execution_mode === 'code-only'),
    completed: workflows.every(graph => graph.status === 'completed' && graph.complete === true),
    fixedReceipts: fixedReceipts && graphs.executions.filter(graph => !graph.workflow_id).every(graph => fixed.has(graph.execution_id)),
  }
}
const text = (body: Map, key: string) => typeof body[key] === 'string' && body[key].trim() ? body[key].trim() : fail(`${key} 不能为空`)
function variantName(body: Map) {
  const value = text(body, 'variant_name')
  if (value.length > 80 || /[\r\n]/.test(value)) fail('variant_name 必须为不超过 80 个字符的单行名称')
  return value
}
function ids(value: unknown, pattern: RegExp, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(id => typeof id !== 'string' || !pattern.test(id)) || new Set(value).size !== value.length) fail(`${name} 必须为非重复的有效 ID 列表`)
  // 原生工具参数可能被冻结；排序归一化仅操作此处创建的自有数组。
  return [...value as string[]]
}
function number(value: unknown, min: number, max: number, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} 超出允许范围`)
  return value as number
}
function safe(root: string, path: string) {
  const absolute = resolve(root, path), rel = relative(root, absolute)
  if (rel.split(sep).includes('..')) fail('路径必须位于数据工作区')
  let cursor = root
  for (const part of rel.split(sep)) { cursor = join(cursor, part); if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('变体来源不接受符号链接') }
  return absolute
}
function experiment(root: string, id: string) {
  if (!EXP.test(id)) fail('experiment_id 格式无效')
  const file = safe(root, `evolution/experiments/${id}/change.yaml`)
  const content = readFileSync(file, 'utf8'), change = loadYaml(content) as Map
  if (change?.experiment_id !== id || change.agent_id !== EXP.exec(id)![1]) fail('研究版本身份不一致')
  return { file, content, change }
}
function atomic(file: string, content: string) {
  const temporary = `${file}.compute-${process.pid}.tmp`
  writeFileSync(temporary, content, { flag: 'wx' }); renameSync(temporary, file)
}
function head(root: string) { const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null }
async function casesFor(root: string, agentId: string, signal?: AbortSignal) {
  const file = safe(root, `agents/${agentId}/evaluation.md`)
  return parseEvaluationDocument(root, readFileSync(file, 'utf8'), signal)
}
function makePlan(body: Map, cases: Record<string, any>): ComputePlan {
  const selected = ids(body.case_ids, /^U-[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'case_ids')
  if (selected.some(id => !cases[id])) fail('所选 Case 不属于当前评测口径')
  const critical = body.critical_case_ids?.length ? ids(body.critical_case_ids, /^U-[A-Z0-9]+(?:-[A-Z0-9]+)*$/, 'critical_case_ids') : []
  if (critical.some(id => !selected.includes(id))) fail('关键 Case 必须在冻结范围内')
  const minimum = number(body.min_runs_per_case ?? 2, 1, 100, 'min_runs_per_case')
  if (!Number.isInteger(minimum)) fail('最少重复次数必须是整数')
  const metric = body.resource_metric ?? (body.generation ? 'actual_model_calls' : 'total_tokens')
  if (!METRICS.includes(metric)) fail('资源指标无效')
  let modelChange = null
  if (body.allow_model_change === true) modelChange = { model: text(body, 'variant_model'), reasoning_effort: text(body, 'variant_reasoning_effort') }
  let generation: GenerationPlan | undefined
  if (body.generation !== undefined) {
    const value = body.generation
    if (!value || value.mode !== 'langgraph-aot') fail('生成方式必须为 langgraph-aot')
    const entry = value.entry_path ?? 'dsh/managed/compute-workflow/index.ts'
    if (typeof entry !== 'string' || !entry.startsWith('dsh/managed/') || !entry.endsWith('.ts') || entry.includes('\\') || entry.split('/').some(part => !part || part === '.' || part === '..')) fail('生成入口必须位于 Candidate Managed 的 TypeScript 源码中')
    if (value.fixture_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.fixture_sha256)) fail('外部输入样本摘要无效')
    generation = { mode: 'langgraph-aot', entry_path: entry, source_run_ids: ids(value.source_run_ids, RUN, 'source_run_ids').sort(),
      ...(value.fixture_sha256 ? { fixture_sha256: value.fixture_sha256 } : {}) }
  }
  if (body.execution_mode !== undefined && body.execution_mode !== 'code-only') fail('execution_mode 无效')
  if (body.execution_mode === 'code-only' && !generation) fail('纯代码执行必须提供代码生成计划')
  if (body.execution_mode === 'code-only' && (modelChange || body.model_change)) fail('纯代码执行不能指定模型变更')
  return { schema_version: 1, created_at: new Date().toISOString(), strategy: text(body, 'strategy'),
    case_hashes: Object.fromEntries(selected.sort().map(id => [id, hash(canonical(cases[id]))])), critical_case_ids: critical.sort(),
    min_runs_per_case: minimum, max_pass_rate_drop_pp: number(body.max_pass_rate_drop_pp ?? 0, 0, 100, 'max_pass_rate_drop_pp'),
    resource_metric: metric, min_resource_reduction_pct: number(body.min_resource_reduction_pct ?? 10, 0.01, 100, 'min_resource_reduction_pct'), model_change: modelChange,
    ...(generation ? { generation } : {}), ...(body.execution_mode === 'code-only' ? { execution_mode: 'code-only' as const } : {}),
    ...(generation || metric === 'actual_model_calls' ? { measurement_schema_version: 2 as const } : {}) }
}

/** 仅核算原始目标轨迹，包括已采集的子 Session；不将配置快照当作模型调用。 */
export function computeTraceMetrics(rows: Map[], collected: boolean, attempts: ModelAttempt[] = []) {
  const missing: string[] = []
  const empty = Object.fromEntries(METRICS.map(name => [name, null])) as Record<ComputeMetric, number | null>
  if (!collected || !rows.length) return { values: empty, missing: ['目标轨迹缺失或采集完整性未确认'] }
  const groups = new Map<string, Map[]>()
  for (const row of rows) { const key = String(row.session_log ?? 'root'); const events = groups.get(key) ?? []; events.push(row.event ?? row); groups.set(key, events) }
  let calls = 0, input = 0, output = 0, total = 0, inputKnown = true, outputKnown = true, totalKnown = true, callsKnown = true, elapsed = 0, elapsedKnown = true
  for (const events of groups.values()) {
    const messages = events.filter(event => event.type === 'assistant/message')
    const attempts = events.filter(event => event.type === 'assistant/attempt')
    const starts = events.filter(event => event.type === 'step/start').length
    const ends = events.filter(event => event.type === 'step/end').length
    if (attempts.length || events.some(event => /retry|error/.test(event.type)) || starts !== ends || messages.length !== ends || messages.some(event => event.data?.interrupted === true)) {
      callsKnown = false; inputKnown = false; outputKnown = false; totalKnown = false; missing.push('存在重试、未完成步骤或无法一一对应的模型响应，不能推算全部调用和 token')
    }
    calls += messages.length
    for (const event of messages) {
      const usage = normalizeTokenUsage(event.data?.usage)
      if (usage?.input !== null && usage?.input !== undefined) input += usage.input; else inputKnown = false
      if (usage) output += usage.output; else outputKnown = false
      if (usage?.total !== null && usage?.total !== undefined) total += usage.total; else totalKnown = false
    }
    // 对每个 Case 仅取主 Session 的 turn 耗时；子 Session 并行时间不可再相加。
  }
  const rootKey = rows.find(row => (row.event ?? row).type === 'session' && (row.event ?? row).delegationDepth === 0)?.session_log ?? rows.find(row => (row.event ?? row).type === 'turn/start')?.session_log
  const rootEvents = groups.get(String(rootKey ?? 'root')) ?? []
  const pending = new Map<number, number>()
  for (const event of rootEvents) {
    if (event.type === 'turn/start' && Number.isFinite(event.time)) pending.set(event.data?.turn, event.time)
    if (event.type === 'turn/end') {
      const start = pending.get(event.data?.turn)
      if (start === undefined || !Number.isFinite(event.time) || event.time < start || event.data?.reason?.kind !== 'completed') elapsedKnown = false
      else elapsed += event.time - start
      pending.delete(event.data?.turn)
    }
  }
  if (pending.size || !rootEvents.some(event => event.type === 'turn/end')) elapsedKnown = false
  if (!messagesPresent(rows)) { callsKnown = false; inputKnown = false; outputKnown = false; totalKnown = false; missing.push('没有已完成的模型响应') }
  if (!elapsedKnown) missing.push('缺少完整主 Session turn 起止时间')
  const measured = measureModelUsage([{ path: 'trace.jsonl', rows: rows as any }], { attempts })
  const graphs = extractGraphExecutions(rows as any)
  const hasGraphEvidence = attempts.length > 0 || graphs.executions.length > 0 || graphs.unknown_reasons.length > 0
  // 普通和历史计划也可能调用图工具；有图事实时不能只核算外层响应而漏掉图内推理。
  const values = { actual_model_calls: measured.actual_model_calls, model_calls: callsKnown ? calls : null,
    input_tokens: hasGraphEvidence ? measured.token_usage?.input_tokens ?? null : inputKnown ? input : null,
    output_tokens: hasGraphEvidence ? measured.token_usage?.output_tokens ?? null : outputKnown ? output : null,
    total_tokens: hasGraphEvidence ? measured.token_usage?.total_tokens ?? null : totalKnown ? total : null,
    elapsed_ms: elapsedKnown ? elapsed : null }
  if ([values.input_tokens, values.output_tokens, values.total_tokens].some(value => value === null)) missing.push('至少一个模型调用的供应商 token 用量缺失或分桶不一致')
  if (hasGraphEvidence && !measured.model_calls_complete) missing.push(...measured.model_calls_unknown_reasons.map(reason => `关联图及模型请求用量未知：${reason}`))
  return { measurement: measured, values, missing: [...new Set(missing)] }
}
function messagesPresent(rows: Map[]) { return rows.some(row => (row.event ?? row).type === 'assistant/message') }

export function createComputeVariantsHandler(assetRoot: string, services: ComputeVariantServices) {
  const root = resolve(assetRoot)
  let mutating = false
  function saveComparison(result: Map) {
    const content = canonical(comparisonEvidence(result)) + '\n', digest = hash(content)
    const path = `evolution/experiments/${result.experiment_id}/evaluation/compute-comparison-${digest}.json`
    const file = safe(root, path)
    mkdirSync(safe(root, `evolution/experiments/${result.experiment_id}/evaluation`), { recursive: true })
    try { writeFileSync(file, content, { flag: 'wx', mode: 0o444 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readFileSync(file, 'utf8') !== content) throw new VariantError('conflict', '比较回执已存在但内容不一致，未覆盖原始记录')
    }
    return { ...result, comparison_receipt: { path, sha256: digest } }
  }
  async function restoredComparison(id: string, change: Map, digest: string, build: ReturnType<typeof inspectComputeBuild>, signal?: AbortSignal) {
    const directory = safe(root, `evolution/experiments/${id}/evaluation`)
    if (!existsSync(directory) || !change.compute_variant || change.compute_variant.generation && !build.verified) return null
    const files = readdirSync(directory).filter(name => /^compute-comparison-[0-9a-f]{64}\.json$/.test(name))
      .map(name => ({ name, file: safe(root, `evolution/experiments/${id}/evaluation/${name}`) }))
      .filter(item => lstatSync(item.file).isFile()).sort((a, b) => lstatSync(b.file).mtimeMs - lstatSync(a.file).mtimeMs || a.name.localeCompare(b.name))
    for (const item of files) {
      signal?.throwIfAborted()
      try {
        const content = readFileSync(item.file), receiptDigest = hash(content)
        if (item.name !== `compute-comparison-${receiptDigest}.json`) continue
        const receipt = JSON.parse(content.toString()), saved = receipt.comparison
        if (receipt.schema_version !== 1 || saved?.experiment_id !== id || saved.candidate_sha256 !== digest
          || !same(saved.plan, change.compute_variant) || saved.inputs?.parent_experiment_id !== change.parent_experiment_id
          || saved.inputs?.parent_ref !== change.baseline_ref || !same(saved.inputs?.build, change.compute_variant.generation ? { verified: build.verified, receipt: build.receipt } : null)) continue
        const current = await compare({ experiment_id: id, parent_run_ids: saved.parent_run_ids, variant_run_ids: saved.variant_run_ids }, signal)
        if (!same(comparisonEvidence(current), receipt)) continue
        return { ...current, comparison_receipt: { path: relative(root, item.file).split(sep).join('/'), sha256: receiptDigest } }
      } catch {
        if (signal?.aborted) signal.throwIfAborted()
        // 回执、原始证据或当前来源无法核对时，不恢复已比较状态。
      }
    }
    return null
  }
  async function context(body: Map, signal?: AbortSignal) {
    const id = text(body, 'experiment_id'), { change, content } = experiment(root, id)
    const parsed = await casesFor(root, change.agent_id, signal)
    const runs: Map[] = []
    const base = safe(root, 'evolution/experiments')
    for (const item of readdirSync(base, { withFileTypes: true })) {
      if (!item.isDirectory() || EXP.exec(item.name)?.[1] !== change.agent_id) continue
      const dir = safe(root, `evolution/experiments/${item.name}/runs`)
      if (!existsSync(dir)) continue
      for (const run of readdirSync(dir)) {
        if (!RUN.test(run)) continue
        const path = safe(root, `${relative(root, dir)}/${run}/run.yaml`)
        if (!existsSync(path)) continue
        const manifest = loadYaml(readFileSync(path, 'utf8')) as Map
        if (!['completed', 'failed', 'cancelled'].includes(manifest?.status)) continue
        const row: Map = { run_id: run, experiment_id: item.name, status: manifest.status, created_at: manifest.created_at }
        const runDir = relative(root, dir) + `/${run}`
        try {
          const lock = JSON.parse(readFileSync(safe(root, `${runDir}/inputs.lock.json`), 'utf8'))
          if (lock.run_id === run && Array.isArray(lock.evaluation_cases)) {
            const titles = lock.evaluation_cases.map((entry: Map) => entry?.title).filter((title: unknown) => typeof title === 'string' && title.trim()) as string[]
            if (titles.length === 1 && lock.evaluation_cases.length === 1) row.title = titles[0].trim()
            else if (titles.length) row.title = `${titles[0].trim()}等 ${lock.evaluation_cases.length} 项任务`
            else if (lock.evaluation_cases.length) row.title = `覆盖 ${lock.evaluation_cases.length} 项评测任务`
          }
        } catch { /* 冻结用例不可读时保留 Run 身份，不猜测任务标题。 */ }
        if (manifest.status === 'completed') try {
          const summaryContent = readFileSync(safe(root, `${runDir}/summary.json`))
          if (manifest.summary_sha256 && hash(summaryContent) !== manifest.summary_sha256) throw new Error('summary digest mismatch')
          const summary = JSON.parse(summaryContent.toString())
          const verdict = summary.effective_verdict ?? summary.machine_overall_verdict ?? summary.overall_verdict
          if (summary.run_id === run && ['passed', 'failed', 'inconclusive'].includes(verdict)) row.effective_verdict = verdict
        } catch { /* 执行已结束但业务结论不可读时保持未知。 */ }
        runs.push(row)
      }
    }
    const commit = head(root), digest = services.candidateDigest(id)
    const buildState = inspectComputeBuild(root, id)
    let planMatches = false
    if (commit && change.compute_variant) {
      const frozen = spawnSync('git', ['show', `${commit}:evolution/experiments/${id}/change.yaml`], { cwd: root, encoding: 'utf8' })
      try { planMatches = frozen.status === 0 && same((loadYaml(frozen.stdout) as Map)?.compute_variant, change.compute_variant) } catch { /* 尚未冻结。 */ }
    }
    const freeze = { commit, candidate_matches: Boolean(commit && services.gitCandidateDigest(id, `git:${commit}`) === digest), plan_matches: planMatches }
    const loadedRuns: string[] = []
    if (buildState.verified && change.compute_variant?.generation) {
      for (const run of runs.filter(run => run.experiment_id === id && run.status === 'completed').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 6)) {
        try {
          const view = await services.readRun(run.run_id, signal)
          const locked = JSON.parse((await readRunEvidenceFile(root, run.run_id, 'inputs.lock.json', signal)).data.toString())
          if (locked.candidate_sha256 !== digest) continue
          for (const item of view.cases ?? []) {
            if (!item.load_observation?.preset_matches || !item.load_observation?.workspace_matches) continue
            const trace = await readRunEvidenceFile(root, run.run_id, `evidence/${item.case_id}/trace.jsonl`, signal)
            const graphs = extractGraphExecutions(trace.data.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)))
            const load = workflowLoadEvidence(graphs, buildState.receipt)
            if (!graphs.unknown_reasons.length && load.artifacts && load.completed && load.fixedReceipts
              && (change.compute_variant.execution_mode !== 'code-only' || load.codeOnly)) {
              loadedRuns.push(run.run_id); break
            }
          }
        } catch { /* 缺失证据不能推定装载成功。 */ }
      }
    }
    const generation = change.compute_variant?.generation ?? null
    const generated = Boolean(generation && existsSync(safe(root, `evolution/experiments/${id}/candidate/${generation.entry_path}`)))
    const comparison = await restoredComparison(id, change, digest, buildState, signal)
    return { experiment_id: id, agent_id: change.agent_id, variant_name: change.variant_name ?? null, parent_ref: `git:${commit ?? ''}`, parent_experiment_id: change.parent_experiment_id ?? null, fixed_parent_ref: change.baseline_ref ?? null, plan: change.compute_variant ?? null,
      candidate_sha256: digest, generation, generation_contract: computeGenerationContract(), build: { ...(buildState.receipt ?? {}), verified: buildState.verified, reasons: buildState.reasons }, freeze,
      loaded: { verified: loadedRuns.length > 0, run_ids: loadedRuns }, comparison,
      workflow_status: { generated, built: buildState.verified, frozen: freeze.candidate_matches && freeze.plan_matches, loaded: loadedRuns.length > 0,
        compared: comparison !== null },
      variant_kind: change.variant_kind ?? 'exploratory', decision: change.outcome ?? 'inconclusive', change_sha256: hash(content),
      cases: Object.values(parsed.cases).map(item => ({ case_id: item.case_id, title: item.title })), runs: runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
      default_model: 'deepseek-flash', default_reasoning_effort: 'off' }
  }
  async function preview(body: Map, signal?: AbortSignal) {
    const name = body.variant_name === undefined ? body.generation ? 'LangGraph 代码变体' : '算力变体' : variantName(body)
    const parentId = text(body, 'parent_experiment_id'), parent = experiment(root, parentId)
    const parsed = await casesFor(root, parent.change.agent_id, signal), plan = makePlan(body, parsed.cases)
    const parentRef = text(body, 'parent_ref')
    if (!/^git:[0-9a-f]{40}$/.test(parentRef) || !services.gitCandidateDigest(parentId, parentRef)) fail('父版必须是能完整恢复的固定 Git 提交')
    if (plan.generation) {
      const evidence: NonNullable<GenerationPlan['source_evidence']> = []
      for (const runId of plan.generation.source_run_ids) {
        const run = await services.readRun(runId, signal)
        if (run.manifest?.experiment_id !== parentId || run.manifest?.agent_id !== parent.change.agent_id || run.manifest?.status !== 'completed') fail('生成依据必须是固定父版所属的已封存诊断 Run')
        const input = await readRunEvidenceFile(root, runId, 'inputs.lock.json', signal)
        const lock = JSON.parse(input.data.toString())
        if (lock.candidate_sha256 !== services.gitCandidateDigest(parentId, parentRef)) fail('诊断 Run 的实际 Candidate 与固定父版不一致')
        if (lock.external_inputs?.fixture_sha256) {
          if (plan.generation.fixture_sha256 && plan.generation.fixture_sha256 !== lock.external_inputs.fixture_sha256) fail('诊断 Run 的外部输入样本不一致')
          plan.generation.fixture_sha256 = lock.external_inputs.fixture_sha256
        }
        let matched = false
        for (const item of run.cases ?? []) {
          if (!plan.case_hashes[item.case_id]) continue
          const trace = await readRunEvidenceFile(root, runId, `evidence/${item.case_id}/trace.jsonl`, signal)
          if (!trace.data.length) fail('生成依据缺少实际执行轨迹')
          evidence.push({ run_id: runId, path: trace.path, sha256: trace.source_sha256 }); matched = true
        }
        if (!matched) fail('诊断 Run 未覆盖本次生成的任务范围')
      }
      plan.generation.source_evidence = evidence
    }
    const value = { parent_experiment_id: parentId, parent_ref: parentRef, agent_id: parent.change.agent_id, variant_name: name, plan,
      model_configuration: plan.execution_mode === 'code-only' ? 'code_only_local_execution' : 'inherited_from_fixed_parent',
      notes: [plan.execution_mode === 'code-only' ? '完整继承固定父版；派生后需实现纯代码会话适配与工作流，业务全链模型请求次数必须为零。' : '完整继承固定父版；策略与模型差异仅记录为研究计划，不自动修改模型路由或业务资产。', '运行前需将该计划固定到数据仓库 Git；历史 Run 只能事后观察。'] }
    const { created_at: _createdAt, ...frozenPlan } = plan
    return { ...value, preview_sha256: hash(canonical({ ...value, plan: frozenPlan })) }
  }
  async function compare(body: Map, signal?: AbortSignal) {
    const id = text(body, 'experiment_id'), { change, content } = experiment(root, id)
    const plan = change.compute_variant as ComputePlan
    if (!plan || plan.schema_version !== 1 || !plan.case_hashes || !Number.isFinite(Date.parse(plan.created_at))) fail('当前版本尚未建立冻结的算力变体计划')
    if (plan.execution_mode !== undefined && plan.execution_mode !== 'code-only') fail('execution_mode 无效')
    if (plan.execution_mode === 'code-only' && (!plan.generation || plan.model_change)) fail('纯代码执行计划必须包含代码生成且不能指定模型变更')
    const parentIds = ids(body.parent_run_ids, RUN, 'parent_run_ids'), variantIds = ids(body.variant_run_ids, RUN, 'variant_run_ids')
    if (parentIds.some(id => variantIds.includes(id))) fail('父版和变体不能使用同一个 Run')
    const limits: string[] = [], resourceLimits: string[] = [], proof: Map[] = []
    const caseIds = Object.keys(plan.case_hashes).sort()
    const parentDigest = services.gitCandidateDigest(change.parent_experiment_id, change.baseline_ref)
    const currentDigest = services.candidateDigest(id)
    let graphUsageComplete = true, codeOnlyEvidencePassed = true
    if (!parentDigest) limits.push('固定父版不能完整恢复')
    const workflowBuild = plan.generation ? inspectComputeBuild(root, id) : null
    if (workflowBuild && !workflowBuild.verified) limits.push('工作流源码、共享执行器或构建产物已变化 / 尚未构建')
    const observedSessions = new Set<string>()
    const rows: { side: 'parent' | 'variant'; run: any; lock: any; cases: any[] }[] = []
    for (const [side, runIds] of [['parent', parentIds], ['variant', variantIds]] as const) for (const runId of runIds) {
      const run = await services.readRun(runId, signal)
      const issues = (message: string) => limits.push(`${runId}: ${message}`)
      if (run.run_id !== runId || run.manifest?.agent_id !== change.agent_id || run.manifest?.experiment_id !== (side === 'parent' ? change.parent_experiment_id : id)) issues('Run 不属于所选父版 / 变体')
      if (run.manifest?.status !== 'completed') issues('Run 未成功封存')
      if (run.missing?.length) issues('Run 缺少原始证据')
      let lock: Map = {}
      try {
        const frozen = await readRunEvidenceFile(root, runId, 'inputs.lock.json', signal)
        lock = JSON.parse(frozen.data.toString())
        proof.push({ run_id: runId, file: frozen.path, sha256: frozen.source_sha256 })
      } catch { issues('inputs.lock.json 缺失或无法解析') }
      if (lock.candidate_sha256 !== (side === 'parent' ? parentDigest : currentDigest)) issues('实际 Candidate 与固定父版 / 当前变体不同')
      if (plan.generation?.fixture_sha256) {
        if (lock.external_inputs?.fixture_sha256 !== plan.generation.fixture_sha256 || !['mock-replay', 'replay'].includes(lock.external_inputs?.mode)) issues('外部输入样本或来源模式不符合冻结计划')
        try {
          const external = await readRunEvidenceFile(root, runId, 'evidence/external-inputs.json', signal)
          proof.push({ run_id: runId, file: external.path, sha256: external.source_sha256 })
          if (external.source_sha256 !== plan.generation.fixture_sha256) issues('实际封存外部输入样本摘要不一致')
        } catch { issues('外部输入样本未封存') }
      }
      if (!Number.isFinite(Date.parse(lock.created_at)) || Date.parse(lock.created_at) < Date.parse(plan.created_at)) issues('Run 早于冻结计划，属于事后观察')
      const plannedCommit = lock.git_version?.commit
      if (typeof plannedCommit !== 'string' || !/^[0-9a-f]{40}$/.test(plannedCommit)) issues('Run 没有固定计划来源提交')
      else {
        const frozenPlan = spawnSync('git', ['show', `${plannedCommit}:evolution/experiments/${id}/change.yaml`], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })
        let samePlan = false
        try { samePlan = frozenPlan.status === 0 && same((loadYaml(frozenPlan.stdout) as Map)?.compute_variant, plan) } catch { /* 无法恢复计划。 */ }
        if (!samePlan) issues('运行提交中未固定同一变体计划，不能作预注册比较')
      }
      for (const [key, file] of [['results_sha256', 'results.jsonl'], ['analysis_sha256', 'analysis.json'], ['report_sha256', 'report.md']] as const) {
        try { const item = await readRunEvidenceFile(root, runId, file, signal); proof.push({ run_id: runId, file: item.path, sha256: item.source_sha256 }); if (run.manifest[key] !== item.source_sha256) issues(`${file} 封存摘要缺失或不一致`) }
        catch { issues(`${file} 缺失`) }
      }
      for (const file of ['run.yaml', 'evidence/dsh-image.json']) {
        try { const evidence = await readRunEvidenceFile(root, runId, file, signal); proof.push({ run_id: runId, file: evidence.path, sha256: evidence.source_sha256 }) }
        catch { issues(`${file} 来源文件缺失`) }
      }
      const selected: any[] = []
      for (const caseId of caseIds) {
        const item = run.cases?.find((item: any) => item.case_id === caseId)
        if (!item) continue
        if (hash(canonical(item.frozen)) !== plan.case_hashes[caseId]) issues(`${caseId} 冻结 Case 与预定口径不一致`)
        if (!item.load_observation?.preset_matches || !item.load_observation?.workspace_matches) issues(`${caseId} 缺少正确装载观察`)
        if (!item.evidence?.length || item.evidence.some((entry: any) => !entry.present)) issues(`${caseId} 结果证据缺失`)
        if (item.tool_calls?.some((call: any) => call.status !== 'ok')) issues(`${caseId} 工具结果失败或未知`)
        if (!item.actual_routes?.length || item.actual_routes.some((route: any) => !route?.provider || !route?.model || !route?.reasoningEffort)) issues(`${caseId} 实际模型路由缺失`)
        if (side === 'variant' && plan.model_change && item.actual_routes?.some((route: any) => route.model !== plan.model_change!.model || route.reasoningEffort !== plan.model_change!.reasoning_effort)) issues(`${caseId} 实际模型不符合显式模型变更计划`)
        // 一个 Case 的证据目录只记录一次执行；不能把重复结果行当成独立重复试验。
        if (item.trials?.length !== 1) issues(`${caseId} 需要每 Run 一次且证据独立的 Trial`)
        const trial = item.trials?.[0]
        const verdict = item.review?.reviewed_verdict ?? trial?.verdict
        if (trial?.execution_status !== 'completed' || !['passed', 'failed'].includes(verdict)) issues(`${caseId} 功能结论未确定`)
        const originalFiles = new Map<string, Buffer>()
        for (const file of ['response.json', 'tools.jsonl']) {
          try { const evidence = await readRunEvidenceFile(root, runId, `evidence/${caseId}/${file}`, signal); proof.push({ run_id: runId, file: evidence.path, sha256: evidence.source_sha256 }); originalFiles.set(file, evidence.data) }
          catch { issues(`${caseId}/${file} 原始证据缺失`) }
        }
        let actualRoutes = item.actual_routes
        let codeOnlyVerified = false
        let metrics = { values: Object.fromEntries(METRICS.map(key => [key, null])) as Record<ComputeMetric, number | null>, missing: ['未取得目标执行轨迹'] }
        try {
          const trace = await readRunEvidenceFile(root, runId, `evidence/${caseId}/trace.jsonl`, signal)
          const checksFile = await readRunEvidenceFile(root, runId, `evidence/${caseId}/checks.json`, signal)
          const checks = JSON.parse(checksFile.data.toString())
          proof.push({ run_id: runId, file: trace.path, sha256: trace.source_sha256 }, { run_id: runId, file: checksFile.path, sha256: checksFile.source_sha256 })
          const traceRows = trace.data.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
          const computed = computeTraceMetrics(traceRows, checks.trace_available === true)
          metrics = computed
          const graphs = extractGraphExecutions(traceRows)
          const usage = computed.measurement ?? measureModelUsage([{ path: 'trace.jsonl', rows: traceRows }])
          if ((graphs.executions.length || graphs.unknown_reasons.length) && !usage.model_calls_complete) {
            graphUsageComplete = false
            issues(`${caseId} 关联图或实际模型请求的完整性未知`)
            resourceLimits.push(`${runId}/${caseId}: 关联图或实际模型请求的完整性未知`)
          }
          if (plan.measurement_schema_version === 2) {
            metrics.values.actual_model_calls = usage.actual_model_calls
            metrics.values.input_tokens = usage.token_usage?.input_tokens ?? null
            metrics.values.output_tokens = usage.token_usage?.output_tokens ?? null
            metrics.values.total_tokens = usage.token_usage?.total_tokens ?? null
            if (!usage.model_calls_complete) resourceLimits.push(...usage.model_calls_unknown_reasons.map(message => `${runId}/${caseId}: ${message}`))
          }
          if (side === 'variant' && workflowBuild) {
            const load = workflowLoadEvidence(graphs, workflowBuild.receipt ?? {})
            if (graphs.unknown_reasons.length || !load.artifacts) issues(`${caseId} 缺少本次构建工作流的真实装载与调用证据`)
            if (!load.completed) issues(`${caseId} 图执行失败或取消，不能仅凭外层工具回执判为完成`)
            if (!load.fixedReceipts) issues(`${caseId} 子组合缺少一致的固定版本、实现或完整执行回执`)
            if (plan.execution_mode === 'code-only' && !load.codeOnly) issues(`${caseId} 缺少纯代码执行模式的工作流回执`)
          }
          const rootSession = traceRows.map(row => row.event ?? row).find(event => event.type === 'session' && event.delegationDepth === 0)
          if (!Number.isFinite(rootSession?.createdAt) || rootSession.createdAt < Date.parse(plan.created_at) || rootSession.createdAt < Date.parse(lock.created_at)) issues(`${caseId} 原始 Session 早于冻结计划或当前 Run，不能复用为新重复`)
          const toolRows = traceRows.filter(row => ['tool/call', 'tool/result'].includes((row.event ?? row).type))
          const pendingTools = new Map<string, Map>()
          for (const row of toolRows) {
            const event = row.event ?? row, data = event.data ?? {}
            if (event.type === 'tool/call') {
              if (!data.callId) issues(`${caseId} 原始工具调用缺少身份`)
              else pendingTools.set(`${row.session_log}:${data.callId}`, data)
            } else {
              const key = `${row.session_log}:${data.message?.source?.callId}`
              if (!pendingTools.has(key) || !data.message || data.error || data.message.isError) issues(`${caseId} 原始工具回执失败、未知或不能配对`)
              pendingTools.delete(key)
            }
          }
          if (pendingTools.size) issues(`${caseId} 原始工具调用没有完整回执`)
          const savedTools = originalFiles.get('tools.jsonl')
          if (savedTools && !same(savedTools.toString().split('\n').filter(Boolean).map(line => JSON.parse(line)), toolRows)) issues(`${caseId} tools.jsonl 与原始 Session 工具轨迹不一致`)
          const sessionId = rootSession?.id
          if (!sessionId || sessionId !== item.load_observation?.session_id) issues(`${caseId} 缺少与装载观察一致的原始 Session 身份`)
          else if (observedSessions.has(sessionId)) issues(`${caseId} 重用了已选 Session，不能作为独立重复 Run`)
          else observedSessions.add(sessionId)
          const snapshots = traceRows.map(row => row.event ?? row).filter(event => event.type === 'request/header').map(event => event.data?.header?.config)
          if (!snapshots.length || snapshots.some(route => !route?.provider || !route?.model || !route?.reasoningEffort)) issues(`${caseId} 完整轨迹缺少明确的模型路由`)
          else actualRoutes = snapshots
          const graphRoutes = graphs.attempts.filter(attempt => attempt.status !== 'preparing' && attempt.status !== 'local' && attempt.model_invocation !== false)
          if (graphRoutes.some(route => !route.provider || !route.model || !route.reasoning_effort)) issues(`${caseId} 图内实际模型请求缺少明确路由`)
          actualRoutes = [...(actualRoutes ?? []), ...graphRoutes.map(route => ({ provider: route.provider, model: route.model, reasoningEffort: route.reasoning_effort }))]
          if (side === 'variant' && plan.model_change && actualRoutes.some((route: Map) => route?.model !== plan.model_change!.model || route?.reasoningEffort !== plan.model_change!.reasoning_effort)) issues(`${caseId} 中间步骤、子 Session 或图内模型不符合显式计划`)
          if (side === 'variant' && plan.execution_mode === 'code-only') {
            const localRoutes = actualRoutes?.length > 0 && actualRoutes.every((route: Map) => isCodeOnlyModelRoute(route) && route.reasoningEffort === 'off')
            if (!localRoutes) issues(`${caseId} 纯代码变体包含非受控本地执行路由`)
            codeOnlyVerified = localRoutes && usage.model_calls_complete && usage.actual_model_calls === 0
          }
        } catch { issues(`${caseId} 原始轨迹或工具证据缺失 / 无法解析`); metrics = { values: Object.fromEntries(METRICS.map(key => [key, null])) as Record<ComputeMetric, number | null>, missing: ['原始轨迹或工具证据无法核算'] } }
        if (side === 'variant' && plan.execution_mode === 'code-only' && !codeOnlyVerified) {
          codeOnlyEvidencePassed = false
          resourceLimits.push(`${runId}/${caseId}: 纯代码变体必须完整证明业务模型请求次数为零`)
        }
        resourceLimits.push(...metrics.missing.map(message => `${runId}/${caseId}: ${message}`))
        selected.push({ case_id: caseId, verdict: trial?.execution_status === 'completed' ? verdict : 'inconclusive', metrics: metrics.values, actual_routes: actualRoutes, evidence: item.evidence })
      }
      rows.push({ side, run, lock, cases: selected })
    }
    const first = rows[0]
    for (const row of rows) {
      for (const key of ['executor', 'review_mode', 'dependency_env']) if (row.lock[key] === undefined || !same(row.lock[key], first.lock[key])) limits.push(`${row.run.run_id}: ${key} 缺失或不同`)
      if (!same(row.lock.external_inputs ?? null, first.lock.external_inputs ?? null)) limits.push(`${row.run.run_id}: 外部输入样本或来源模式不同`)
      const origin = row.lock.program_origin, base = first.lock.program_origin
      if (!origin?.commit || origin.dirty !== false || !base?.commit || origin.commit !== base.commit) limits.push(`${row.run.run_id}: 程序版本未冻结或不同`)
      for (const key of ['image_build_fingerprint', 'local_image_id']) if (!row.run.image?.[key] || row.run.image[key] !== first.run.image?.[key]) limits.push(`${row.run.run_id}: 实际镜像缺失或不同`)
    }
    const caseRows = caseIds.map(caseId => {
      const groups = (side: string) => rows.filter(row => row.side === side).flatMap(row => row.cases.filter(item => item.case_id === caseId))
      const parent = groups('parent'), variant = groups('variant')
      if (parent.length !== variant.length || parent.length < plan.min_runs_per_case) limits.push(`${caseId}: 独立 Run 数量不足或两侧不平衡（${parent.length}/${variant.length}，至少 ${plan.min_runs_per_case}）`)
      const routes = (entries: any[]) => [...new Set(entries.flatMap(item => item.actual_routes ?? []).map(route => canonical([route.provider, route.model, route.reasoningEffort])))].sort()
      if (plan.execution_mode === 'code-only') {
        if (parent.some(item => !same(routes([item]), routes(parent.slice(0, 1))))) limits.push(`${caseId}: 父版独立 Run 的实际模型路由不同`)
      } else if (!plan.model_change && !same(routes(parent), routes(variant))) limits.push(`${caseId}: 未预先允许的模型路由差异`)
      const rate = (entries: any[]) => entries.length && entries.every(item => ['passed', 'failed'].includes(item.verdict)) ? entries.filter(item => item.verdict === 'passed').length / entries.length * 100 : null
      const a = rate(parent), b = rate(variant), drop = a === null || b === null ? null : a - b
      const critical = plan.critical_case_ids.includes(caseId)
      const qualityPassed = drop !== null && a! > 0 && b! > 0 && drop <= plan.max_pass_rate_drop_pp && (!critical || b === 100)
      const mean = (entries: any[], key: ComputeMetric) => entries.length && entries.every(item => item.metrics[key] !== null) ? entries.reduce((sum, item) => sum + item.metrics[key], 0) / entries.length : null
      const metrics = Object.fromEntries(METRICS.map(key => { const before = mean(parent, key), after = mean(variant, key); return [key, { parent: before, variant: after, reduction_pct: before !== null && after !== null && before > 0 ? (before - after) / before * 100 : null }] }))
      return { case_id: caseId, parent_runs: parent.length, variant_runs: variant.length, parent_pass_rate: a, variant_pass_rate: b, critical, quality_passed: qualityPassed, metrics }
    })
    // 每 Case 等权，避免容易用例或长轨迹因重复较多支配结论。
    const resources = Object.fromEntries(METRICS.map(key => { const values = caseRows.map(row => row.metrics[key]); const avg = (side: 'parent' | 'variant') => values.every(value => value[side] !== null) ? values.reduce((sum, value) => sum + value[side]!, 0) / values.length : null; const parent = avg('parent'), variant = avg('variant'); return [key, { parent, variant, reduction_pct: parent !== null && variant !== null && parent > 0 ? (parent - variant) / parent * 100 : null }] }))
    const qualityPassed = caseRows.every(row => row.quality_passed)
    const reduction = resources[plan.resource_metric].reduction_pct
    const resourcePassed = graphUsageComplete && codeOnlyEvidencePassed && reduction !== null && reduction >= plan.min_resource_reduction_pct
    if (reduction === null) resourceLimits.push('目标资源指标缺少完整数据或父版基数为零')
    const result = { experiment_id: id, candidate_sha256: currentDigest, parent_candidate_sha256: parentDigest, plan, parent_run_ids: parentIds, variant_run_ids: variantIds, change_sha256: hash(content),
      inputs: { parent_experiment_id: change.parent_experiment_id, parent_ref: change.baseline_ref, build: workflowBuild ? { verified: workflowBuild.verified, receipt: workflowBuild.receipt } : null },
      quality: { passed: qualityPassed, cases: caseRows }, resources, comparability: { passed: limits.length === 0, limits: [...new Set(limits)] },
      resource_evidence: { passed: resourcePassed, limits: [...new Set(resourceLimits)] },
      eligible_for_end: !limits.length && qualityPassed && resourcePassed,
      notes: ['结果仅适用于预先冻结的任务范围和所选独立 Run；不是对所有任务的统计等效证明。',
        ...(plan.execution_mode === 'code-only' ? ['历史 model_calls 统计会话回复次数，包含本地代码适配器回复；业务零推理以完整 actual_model_calls 为零核验。'] : []),
        'token、模型响应次数与耗时属于已记录资源指标；未测量硬件算力、供应商费用或不可见的外部模型调用。', '人工确认需完整审阅原始输出和工具结果；表格只汇总证据，不替代业务判断。', '依赖环境记录仅含变量配置状态；外部数据状态、网络负载与供应商变化未被完整控制，资源改善不能单独归因于 Harness。'], proof }
    return { ...result, comparison_sha256: hash(canonical(result)) }
  }
  return async (method: string, body: Map, signal?: AbortSignal): Promise<Result> => {
    const mutation = ['create', 'confirm', 'rename'].includes(method)
    if (mutation && mutating) return { ok: false, error: { code: 'conflict', message: '算力变体写入正在进行，请稍后重试' } }
    if (mutation) mutating = true
    try {
      if (signal?.aborted) throw new VariantError('aborted', '变体操作已取消')
      if (method === 'context') return { ok: true, value: await context(body, signal) }
      if (method === 'preview') return { ok: true, value: await preview(body, signal) }
      if (method === 'rename') {
        const id = text(body, 'experiment_id'), name = variantName(body)
        const expected = text(body, 'expected_change_sha256')
        if (!/^[a-f0-9]{64}$/.test(expected)) fail('expected_change_sha256 格式无效')
        const current = experiment(root, id)
        if (!current.change.compute_variant && !['exploratory', 'end'].includes(current.change.variant_kind)) fail('所选研究版本未声明为算力变体')
        if (hash(current.content) !== expected) throw new VariantError('conflict', '研究版本已被修改，请重新读取后改名')
        if (current.change.variant_name === name) return { ok: true, value: { experiment_id: id, variant_name: name, change_sha256: expected } }
        const content = dumpYaml({ ...current.change, variant_name: name }, { lineWidth: -1, noRefs: true })
        atomic(current.file, content)
        return { ok: true, value: { experiment_id: id, variant_name: name, change_sha256: hash(content) } }
      }
      if (method === 'create') {
        const prepared = await preview(body, signal)
        if (body.expected_preview_sha256 && body.expected_preview_sha256 !== prepared.preview_sha256) throw new VariantError('conflict', '父版、Case 或计划已变化，请重新预览')
        const { plan, parent_experiment_id: parentId, parent_ref: parentRef } = prepared
        const created = await services.createExperiment({ agent_id: prepared.agent_id, parent_experiment_id: parentId, parent_ref: parentRef, research_question: plan.strategy, ...(body.catalog_sha256 ? { catalog_sha256: body.catalog_sha256 } : {}) }) as Result
        if (!created.ok) return created
        const id = created.value.experiment_id, next = experiment(root, id)
        next.change.compute_variant = plan; next.change.variant_kind = 'exploratory'; next.change.variant_name = prepared.variant_name
        atomic(next.file, dumpYaml(next.change, { lineWidth: -1, noRefs: true }))
        return { ok: true, value: { ...created.value, plan, variant_kind: 'exploratory', variant_name: prepared.variant_name } }
      }
      if (method === 'compare') {
        const result = await compare(body, signal)
        signal?.throwIfAborted()
        return { ok: true, value: saveComparison(result) }
      }
      if (method === 'confirm') {
        if (body.human_confirmed !== true) fail('需要明确确认已审阅任务效果、完整输出与工具结果')
        const reason = text(body, 'reason'), result = await compare(body, signal)
        if (result.comparison_sha256 !== body.comparison_sha256) throw new VariantError('conflict', '计划或证据已变化，请重新比较')
        const decision = body.decision
        if (!['end', 'continue', 'inconclusive'].includes(decision)) fail('decision 必须是 end / continue / inconclusive')
        if (decision === 'end' && !result.eligible_for_end) fail('任务效果、资源收益或可比性证据不足，不能确认 end')
        const id = result.experiment_id, current = experiment(root, id)
        if (hash(current.content) !== result.change_sha256) throw new VariantError('conflict', '研究版本已被修改，请重新读取')
        const commit = head(root)
        if (decision === 'end' && (!commit || services.gitCandidateDigest(id, `git:${commit}`) !== services.candidateDigest(id))) fail('确认 end 前需将当前变体 Candidate 固定到可恢复 Git 提交')
        if (services.candidateDigest(id) !== result.candidate_sha256) throw new VariantError('conflict', 'Candidate 在比较期间发生变化，请重新评测并比较')
        const refs = [...result.parent_run_ids, ...result.variant_run_ids].map(runId => result.proof.find(item => item.run_id === runId && item.file.endsWith('/report.md'))?.file).filter(Boolean)
        current.change.variant_kind = decision === 'end' ? 'end' : 'exploratory'
        current.change.end_confirmed = decision === 'end'
        current.change.outcome = decision === 'end' ? 'adopt' : decision
        current.change.equivalence_evidence_refs = refs
        current.change.resource_evidence_refs = result.proof.filter(item => item.file.endsWith('/trace.jsonl')).map(item => item.file)
        current.change.compute_variant_decision = { candidate_sha256: result.candidate_sha256, parent_run_ids: result.parent_run_ids, variant_run_ids: result.variant_run_ids, comparison_sha256: result.comparison_sha256, confirmed_at: new Date().toISOString(), ...(decision === 'end' ? { variant_ref: `git:${commit}` } : {}) }
        // Decision 保留结论、解释和引用，逐次比较数字仍由不可变 Run 重新计算。
        const decisionFile = safe(root, `evolution/experiments/${id}/decision.md`)
        const decisionText = `# Decision\n\n状态：${current.change.outcome}\n\n${reason}\n\n变体类型：${current.change.variant_kind}。比较计划、所选 Run 和确认身份见 [change.yaml](change.yaml)。\n\n仅限冻结任务范围的观察性结论，不代表其他任务上的统计等效。\n`
        const oldDecision = existsSync(decisionFile) ? readFileSync(decisionFile, 'utf8') : null
        atomic(decisionFile, decisionText)
        try { atomic(current.file, dumpYaml(current.change, { lineWidth: -1, noRefs: true })) }
        catch (error) { if (oldDecision !== null) atomic(decisionFile, oldDecision); throw error }
        return { ok: true, value: { experiment_id: id, variant_kind: current.change.variant_kind, decision: current.change.outcome } }
      }
      return { ok: false, error: { code: 'method_not_found', message: '未知算力变体操作' } }
    } catch (error) {
      return { ok: false, error: { code: (error as any)?.code ?? 'variant_operation_failed', message: error instanceof VariantError ? error.message : '算力变体操作失败，请检查固定来源及 Run 证据' } }
    } finally { if (mutation) mutating = false }
  }
}
