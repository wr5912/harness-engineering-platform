import { isLocalModelRoute, modelInvocationEvidence, normalizeTokenUsage, type ModelAttempt, type ModelRole } from './model-attempts.ts'
import { parseLocalCapabilities, type LocalModelRoute } from '../business-control/local-capabilities.ts'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export { normalizeTokenUsage } from './model-attempts.ts'
export type { ModelAttempt } from './model-attempts.ts'
type Event = { type: string; seq?: number; data?: Record<string, any>; [key: string]: any }
type Role = ModelRole
export type UsageTrace = { path: string; rows: { session_log?: string; event?: Event }[] }
type Session = { id: string; seeded: boolean; role: Role; events: Map<number, Event> }

/** 只读本次 Run 的原文字节；历史记录不从当前 Candidate 补写声明。 */
function lockedLocalModelRoutes(run: string, inputs: Record<string, any>): LocalModelRoute[] {
  const managed = inputs.harness_trees?.managed
  if (!managed || !Array.isArray(managed.files) || managed.files.some((item: any) => !item || typeof item !== 'object'))
    throw new Error('local-model-routes-lock-missing')
  const declarations = managed.files.filter((item: any) => item.path === 'role-tool-matrix.yaml')
  const marked = Object.hasOwn(inputs, 'managed_role_snapshot')
  if (!declarations.length && !marked) return []
  if (declarations.length !== 1) throw new Error('local-model-routes-lock-invalid')
  const declaration = declarations[0]
  if (!/^[0-9a-f]{64}$/.test(declaration.sha256 ?? '') || !Number.isSafeInteger(declaration.size)
    || declaration.size < 0 || declaration.size > 64 * 1024) throw new Error('local-model-routes-lock-invalid')
  let bytes: Buffer
  if (marked) {
    if (inputs.managed_role_snapshot !== 'evidence/managed/role-tool-matrix.yaml')
      throw new Error('local-model-routes-snapshot-invalid')
    if (['evidence', 'evidence/managed'].some(name => !existsSync(join(run, name)) || !lstatSync(join(run, name)).isDirectory()))
      throw new Error('local-model-routes-snapshot-invalid')
    const path = join(run, inputs.managed_role_snapshot)
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error('local-model-routes-snapshot-missing')
    bytes = readFileSync(path)
  } else {
    if (['evidence', 'evidence/analysis'].some(name => !existsSync(join(run, name)) || !lstatSync(join(run, name)).isDirectory()))
      throw new Error('local-model-routes-legacy-missing')
    const path = join(run, 'evidence/analysis/harness.json')
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error('local-model-routes-legacy-missing')
    let harness: Record<string, any>
    try { harness = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('local-model-routes-legacy-invalid') }
    const sources = Array.isArray(harness?.files) ? harness.files.filter((item: any) => item?.tree === 'managed'
      && item.path === 'role-tool-matrix.yaml') : []
    if (sources.length !== 1 || typeof sources[0].content !== 'string' || sources[0].sha256 !== declaration.sha256)
      throw new Error('local-model-routes-legacy-invalid')
    bytes = Buffer.from(sources[0].content, 'utf8')
  }
  if (bytes.length !== declaration.size || createHash('sha256').update(bytes).digest('hex') !== declaration.sha256)
    throw new Error('local-model-routes-digest-mismatch')
  const content = bytes.toString('utf8')
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('local-model-routes-invalid')
  try { return parseLocalCapabilities(content).localModelRoutes }
  catch { throw new Error('local-model-routes-invalid') }
}

/** 按封存声明核算一个 Run；无法核对时不把混有本地事件的数值当作调用下界。 */
export function measureRunModelUsage(run: string, inputs: Record<string, any>, files: UsageTrace[]) {
  try {
    const localModelRoutes = lockedLocalModelRoutes(run, inputs)
    return { ...measureModelUsage(files, { localModelRoutes }), local_model_routes_verification: 'verified' as const }
  } catch (error) {
    const measured = measureModelUsage(files)
    const reason = error instanceof Error && /^local-model-routes-[a-z-]+$/.test(error.message)
      ? error.message : 'local-model-routes-invalid'
    return { ...measured, actual_model_calls: null, observed_model_calls: null,
      failed_model_calls: null, observed_failed_model_calls: null, auxiliary_model_calls: null,
      auxiliary_requests_observed: null, model_calls_by_role: null, model_calls_by_model_role: null,
      model_calls_complete: false, local_model_routes_verification: 'unverified' as const,
      model_calls_unknown_reasons: [...new Set([...measured.model_calls_unknown_reasons, reason])],
      model_calls_basis: '本 Run 的本地能力声明尚未核对，实际模型调用及可核验下界未知；不从当前 Candidate 回填，也不把原记录数解释为真实 LLM 下界。',
      token_usage: null, observed_token_usage: null, token_usage_complete: false,
      token_usage_note: '本 Run 的本地能力声明尚未核对，总 Token 与可核验用量下界未知。' }
  }
}

/** 只读取原始 tool/result 的结构化回执，核对其原生 Session/调用身份。 */
export function extractGraphExecutions(rows: UsageTrace['rows']) {
  const sessionIds = new Map<string, string>(), calls = new Map<string, string>()
  const seeded = new Set<string>(), seedEnds = new Map<string, number>()
  const executions = new Map<string, Record<string, any>>(), unknown = new Set<string>()
  function visit(execution: any, session: string | undefined, callId: string | undefined, knownCall: boolean, ancestors = new Set<string>()) {
    if (!execution || typeof execution !== 'object' || typeof execution.execution_id !== 'string' || !Array.isArray(execution.model_attempts)) {
      unknown.add('graph-execution-invalid'); return
    }
    if (!session || !callId || !knownCall || execution.session_id !== session || execution.tool_call_id !== callId) {
      unknown.add('graph-execution-association-invalid'); return
    }
    if (ancestors.has(execution.execution_id)) { unknown.add('graph-execution-cycle'); return }
    if (execution.complete !== true) unknown.add('graph-execution-incomplete')
    if (execution.model_attempts.some((attempt: ModelAttempt) => !attempt || typeof attempt !== 'object' || attempt.execution_id !== execution.execution_id
      || attempt.session_id !== session || attempt.tool_call_id !== callId)) {
      unknown.add('graph-attempt-association-invalid'); return
    }
    const previous = executions.get(execution.execution_id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(execution)) unknown.add('graph-execution-conflict')
    else executions.set(execution.execution_id, execution)
    if (execution.trace !== undefined && !Array.isArray(execution.trace)) { unknown.add('graph-execution-trace-invalid'); return }
    for (const child of execution.trace ?? []) {
      if (!child || typeof child !== 'object') continue
      const nested = [child.meta?.graph_execution, child.result?.graph_execution].filter(value => value !== undefined)
      for (const value of nested) visit(value, session, child.call_id, typeof child.call_id === 'string', new Set([...ancestors, execution.execution_id]))
    }
  }
  for (const row of rows) {
    const log = row.session_log ?? '', event = row.event
    if (event?.type === 'session' && typeof event.id === 'string') {
      sessionIds.set(log, event.id)
      if (event.isSeeded === true) seeded.add(log)
    }
    if (event?.type === 'session/end-seed' && event.data?.inherited === true && Number.isSafeInteger(event.seq) && event.seq! >= 0) {
      seedEnds.set(log, Math.min(seedEnds.get(log) ?? event.seq!, event.seq!))
    }
  }
  for (const log of seeded) if (!seedEnds.has(log)) unknown.add('seed-boundary-missing')
  for (const row of rows) {
    const log = row.session_log ?? '', event = row.event, data = event?.data ?? {}, session = sessionIds.get(log)
    // 与主 Session 计量共用继承分界；旧图保留父身份，不在子 Session 重新关联或收费。
    if (seeded.has(log) && !seedEnds.has(log) || seedEnds.has(log) && event?.seq! <= seedEnds.get(log)!) continue
    if (event?.type === 'tool/call' && typeof data.callId === 'string' && session) calls.set(`${session}:${data.callId}`, data.name)
    if (event?.type !== 'tool/result') continue
    const callId = data.message?.source?.callId ?? data.message?.toolCallId ?? data.callId
    const candidates: any[] = [data.meta?.graph_execution, data.message?.structuredContent?.graph_execution, data.structuredContent?.graph_execution]
    for (const block of Array.isArray(data.message?.content) ? data.message.content : []) if (block?.type === 'text' && typeof block.text === 'string') {
      try { candidates.push(JSON.parse(block.text)?.graph_execution) } catch { /* 普通文字结果不作为图事实。 */ }
    }
    for (const execution of candidates.filter(value => value !== undefined)) visit(execution, session, callId, calls.has(`${session}:${callId}`))
  }
  return { executions: [...executions.values()], attempts: [...executions.values()].flatMap(value => value.model_attempts) as ModelAttempt[], unknown_reasons: [...unknown] }
}

/** 基于锁定 DSH 的持久请求尝试结算计数；不把配置头、Step 或 Token 样本推成请求。 */
export function measureModelUsage(files: UsageTrace[], options: { attempts?: ModelAttempt[]; requireSessionTrace?: boolean; localModelRoutes?: readonly LocalModelRoute[] } = {}) {
  const sessions = new Map<string, Session>()
  const unknown = new Set<string>()
  const byRole: Partial<Record<Role, number>> & Record<'target' | 'judge' | 'analysis', number> = { target: 0, judge: 0, analysis: 0 }
  const byModelRole = { language: 0, decision: 0 }
  let failed = 0, tokensKnown = true, tokenSamples = 0, auxiliary = 0, auxiliaryRequests = 0
  const tokens = { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
  const graphs = files.map(file => extractGraphExecutions(file.rows))
  for (const graph of graphs) graph.unknown_reasons.forEach(reason => unknown.add(reason))
  for (const file of files) {
    if (!file.rows.length) unknown.add('session-trace-empty')
    const logs = new Map<string, UsageTrace['rows']>()
    for (const row of file.rows) {
      if (typeof row.session_log !== 'string' || !row.event) { unknown.add('trace-envelope-missing'); continue }
      const rows = logs.get(row.session_log) ?? []
      rows.push(row); logs.set(row.session_log, rows)
    }
    for (const rows of logs.values()) {
      const header = rows.find(row => row.event?.type === 'session')?.event
      if (typeof header?.id !== 'string') { unknown.add('session-header-missing'); continue }
      const session = sessions.get(header.id) ?? { id: header.id, seeded: header.isSeeded === true,
        role: file.path.includes('/analysis/') ? 'analysis' : file.path.endsWith('/judge-trace.jsonl') ? 'judge' : 'target', events: new Map<number, Event>() }
      for (const row of rows) {
        const event = row.event!
        if (event.type === 'session') continue
        if (!Number.isSafeInteger(event.seq) || event.seq! < 0) { unknown.add('session-event-sequence-missing'); continue }
        const previous = session.events.get(event.seq!)
        if (previous && JSON.stringify(previous) !== JSON.stringify(event)) unknown.add('session-event-conflict')
        session.events.set(event.seq!, event)
      }
      sessions.set(header.id, session)
    }
  }
  function addUsage(sample: any) {
    const value = normalizeTokenUsage(sample)
    if (!value || value.input === null || value.total === null) { tokensKnown = false; return }
    tokens.input_tokens += value.input
    tokens.output_tokens += value.output
    tokens.total_tokens += value.total
    tokenSamples++
  }
  function sampleOf(data: any) {
    return data?.usage ?? [...(Array.isArray(data?.stream) ? data.stream : [])].reverse()
      .find(item => item?.chunk?.type === 'usage')?.chunk?.usage
  }
  function factsOf(data: any) {
    const stream = Array.isArray(data?.stream) ? data.stream : []
    return [{ model_invocation: data?.model_invocation },
    ...[data?.usage, ...stream.filter((item: any) => item?.chunk?.type === 'usage').map((item: any) => item.chunk.usage)]
      .filter(usage => usage !== undefined).map(usage => ({ usage }))]
  }
  function count(session: Session, event: Event) {
    byRole[session.role] = (byRole[session.role] ?? 0) + 1
    if (event.type === 'assistant/attempt' || event.data?.interrupted === true) { failed++; tokensKnown = false }
    addUsage(sampleOf(event.data))
  }
  function settle(session: Session, event: Event, route: any, reason: string) {
    const evidence = modelInvocationEvidence(route, factsOf(event.data))
    if (evidence === 'invoked') count(session, event)
    else if (evidence !== 'none') {
      unknown.add(evidence === 'conflict' ? 'model-invocation-evidence-conflict' : reason)
      tokensKnown = false
    }
    return evidence
  }
  const sessionsWithGraphs = new Set(graphs.flatMap(graph => graph.executions.map(execution => execution.session_id)))
  for (const session of sessions.values()) {
    const all = [...session.events].sort(([a], [b]) => a - b).map(([, event]) => event)
    const marker = all.find(event => event.type === 'session/end-seed' && event.data?.inherited === true)
    if (session.seeded && !marker) { unknown.add('seed-boundary-missing'); continue }
    const events = marker ? all.filter(event => event.seq! > marker.seq!) : all
    let previousSeq = marker?.seq ?? -1
    let turn: number | undefined, nativeRoute: any
    let step: { turn: number; step: number; state: 'open' | 'message' | 'attempt' | 'retry'; headers: any[] } | undefined
    const compacting = new Map<string, boolean>()
    const titleRequests = new Map<string, { count: number; controlled: boolean }>()
    let automaticTitlePending = false
    function settledRoute(data: any) {
      const source = data.message?.source
      // 图调用可能更新同一 Session 的 Header；结算里的实际模型身份优先。
      if (source?.kind === 'model' && typeof source.provider === 'string' && source.provider
        && typeof source.model === 'string' && source.model) return { provider: source.provider, model: source.model }
      if (sessionsWithGraphs.has(session.id)) return undefined
      const candidates = [...new Map((step?.headers ?? []).map(route => [JSON.stringify(route), route])).values()]
      return candidates.length === 1 ? candidates[0] : candidates.length === 0 ? nativeRoute : undefined
    }
    for (const event of events) {
      if (event.seq !== previousSeq + 1) unknown.add('session-events-incomplete')
      previousSeq = event.seq!
      const data = event.data ?? {}
      if (event.type === 'request/header' && step?.state === 'open') step.headers.push(data.header?.config)
      if (event.type === 'session/title' && data.source?.kind === 'fallback') {
        automaticTitlePending = true
      } else if (event.type === 'session/title' && data.source?.kind === 'user') {
        automaticTitlePending = false
      } else if (event.type === 'session/title-llm-request') {
        const controlled = isLocalModelRoute(data.route)
        if (controlled) automaticTitlePending = false
        else auxiliaryRequests++
        const key = JSON.stringify([data.titleProvider, data.messageSeqs, data.route?.provider, data.route?.model])
        const previous = titleRequests.get(key)
        titleRequests.set(key, { count: (previous?.count ?? 0) + 1, controlled })
      } else if (event.type === 'session/title' && data.source?.kind === 'provider') {
        automaticTitlePending = false
        if (!data.source.model) continue
        const key = JSON.stringify([data.source.provider, data.messageSeqs, data.source.model.provider, data.source.model.model])
        const pending = titleRequests.get(key)
        if (!pending?.count) unknown.add('auxiliary-title-request-boundary-missing')
        else {
          pending.count--
          if (settle(session, event, data.source.model, 'auxiliary-title-invocation-unproven') === 'invoked') auxiliary++
        }
      } else if (event.type === 'turn/start') {
        if (turn !== undefined || step) unknown.add('turn-boundary-invalid')
        turn = data.turn
      } else if (event.type === 'step/start') {
        if (step || turn !== data.turn) unknown.add('step-boundary-invalid')
        step = { turn: data.turn, step: data.step, state: 'open', headers: [] }
      } else if (event.type === 'session-log-deepseek/delivery-accepted') {
        // 只有 Session/水位的 HTTP 接受不能唯一归属某个原生、标题或图尝试。
        if (data.sessionId === session.id && data.sessionFormatVersion === 4 && Number.isSafeInteger(data.throughSeq))
          unknown.add('delivery-request-association-unproven')
      } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        if (!step || step.turn !== data.turn || step.step !== data.step || step.state !== 'open') unknown.add('attempt-boundary-invalid')
        else {
          const route = settledRoute(data)
          settle(session, event, route, 'attempt-invocation-unproven')
          nativeRoute = route
          step.state = event.type === 'assistant/message' ? 'message' : 'attempt'
        }
      } else if (event.type === 'llm/retry') {
        if (!step || step.turn !== data.turn || step.step !== data.step || step.state !== 'attempt') unknown.add('retry-boundary-invalid')
        else step.state = 'retry' // 本地 adapter 错误也可重试；重试事件不补造模型调用。
      } else if (event.type === 'llm/retry-started') {
        if (!step || step.turn !== data.turn || step.step !== data.step || step.state !== 'retry') unknown.add('retry-boundary-invalid')
        else { step.state = 'open'; step.headers = [] }
      } else if (event.type === 'step/end') {
        if (!step || step.turn !== data.turn || step.step !== data.step || step.state === 'open') unknown.add('attempt-settlement-missing')
        step = undefined
      } else if (event.type === 'turn/end') {
        if (turn !== data.turn || step) unknown.add('turn-boundary-invalid')
        turn = undefined
      } else if (event.type === 'compaction/start') compacting.set(data.compactionId, false)
      else if (event.type === 'compaction/summary') {
        settle(session, event, data, 'compaction-request-count-unknown')
        if (!compacting.has(data.compactionId)) unknown.add('compaction-boundary-missing')
        compacting.set(data.compactionId, true)
      } else if (event.type === 'compaction/end') {
        if (!compacting.get(data.compactionId) || data.error !== undefined) unknown.add('compaction-request-count-unknown')
        compacting.delete(data.compactionId)
      }
    }
    if (step || turn !== undefined || compacting.size) unknown.add('request-lifecycle-in-progress')
    if ([...titleRequests.values()].some(item => item.count > 0 && !item.controlled)) unknown.add('auxiliary-title-request-outcome-missing')
    if (automaticTitlePending) unknown.add('auxiliary-title-generation-unsettled')
  }
  // 图事实用全局 attempt ID 合并生命周期；重复回执和重复导出不会再次收费。
  const attempts = new Map<string, ModelAttempt[]>()
  for (const attempt of [...graphs.flatMap(graph => graph.attempts), ...(options.attempts ?? [])]) {
    if (!attempt || typeof attempt.attempt_id !== 'string' || !attempt.attempt_id || typeof attempt.execution_id !== 'string' || !attempt.execution_id
      || !Number.isFinite(attempt.time) || !['preparing', 'started', 'completed', 'failed', 'cancelled', 'local'].includes(attempt.status)) {
      unknown.add('graph-attempt-invalid'); continue
    }
    const rows = attempts.get(attempt.attempt_id) ?? []
    if (!rows.some(row => JSON.stringify(row) === JSON.stringify(attempt))) rows.push(attempt)
    attempts.set(attempt.attempt_id, rows)
  }
  for (const rows of attempts.values()) {
    const identity = (row: ModelAttempt) => JSON.stringify([row.execution_id, row.role ?? 'target', row.parent_run_id, row.case_id, row.session_id, row.tool_call_id,
      row.model_role, row.kind, row.checkpoint_sha256, row.state_constructor_sha256, row.calibration_sha256])
    if (rows.some(row => identity(row) !== identity(rows[0]))) { unknown.add('graph-attempt-identity-conflict'); continue }
    const ordered = [...rows].sort((a, b) => a.time - b.time)
    const terminal = ordered.filter(row => ['completed', 'failed', 'cancelled', 'local'].includes(row.status))
    const last = terminal.at(-1)
    const started = ordered.some(row => row.status === 'started')
    const role = rows[0].role ?? 'target'
    if (!['target', 'judge', 'analysis', 'generation'].includes(role)) { unknown.add('graph-attempt-role-invalid'); continue }
    const modelRole = rows[0].model_role
    if (modelRole !== undefined && !['language', 'decision'].includes(modelRole)
      || rows[0].kind !== undefined && rows[0].kind !== 'typed_decision'
      || modelRole === 'decision' && rows[0].kind !== 'typed_decision'
      || rows[0].kind === 'typed_decision' && (modelRole !== 'decision'
        || ['checkpoint_sha256', 'state_constructor_sha256', 'calibration_sha256'].some(key => !/^[0-9a-f]{64}$/.test((rows[0] as any)[key] ?? '')))) {
      unknown.add('graph-attempt-model-role-invalid'); continue
    }
    const evidence = modelInvocationEvidence(last ?? ordered.at(-1), ordered.map(row => ({ ...row,
      model_invocation: ['preparing', 'started'].includes(row.status) ? undefined : row.model_invocation })))
    if (evidence === 'none') continue
    if (evidence !== 'invoked') {
      unknown.add(evidence === 'conflict' ? 'model-invocation-evidence-conflict' : 'graph-attempt-invocation-unproven')
      tokensKnown = false
      if (!last) unknown.add('graph-attempt-unsettled')
      continue
    }
    if (!started) unknown.add('graph-attempt-start-missing')
    byRole[role] = (byRole[role] ?? 0) + 1
    if (modelRole) byModelRole[modelRole]++
    if (!last) { unknown.add('graph-attempt-unsettled'); tokensKnown = false; continue }
    if (last.status !== 'completed') { failed++; tokensKnown = false }
    if (terminal.some(row => row.status !== last.status || row.provider !== last.provider || row.model !== last.model || JSON.stringify(row.usage) !== JSON.stringify(last.usage))) unknown.add('graph-attempt-settlement-conflict')
    addUsage(last.usage)
  }
  if (options.requireSessionTrace !== false && (!files.length || !sessions.size)) unknown.add('session-trace-missing')
  const observed = Object.values(byRole).reduce((sum, value) => sum + value, 0)
  return { actual_model_calls: unknown.size ? null : observed, observed_model_calls: observed,
    failed_model_calls: unknown.size ? null : failed, observed_failed_model_calls: failed,
    auxiliary_model_calls: auxiliary, auxiliary_requests_observed: auxiliaryRequests,
    model_calls_by_role: byRole, model_calls_by_model_role: byModelRole, model_calls_complete: unknown.size === 0,
    model_calls_basis: '按实际调用标记与正向供应商用量核对根/子请求、压缩、标题和图尝试；Session/seq与attempt去重，注册位置不证明零推理，重试、HTTP错误或未归属HTTP记录不补调用。',
    model_calls_unknown_reasons: [...unknown], token_usage: tokensKnown && !unknown.size ? tokens : null,
    observed_token_usage: tokenSamples ? tokens : null,
    token_usage_complete: tokensKnown && !unknown.size,
    token_usage_note: tokensKnown && !unknown.size
      ? '当前已采集请求的供应商 Token 用量；未核算实际费用。'
      : '总 Token 未知；observed_token_usage 仅为已采集且有供应商结算的用量下界，辅助标题不保存 Token 结算，在途或缺失用量不按零计。',
    hard_cap_supported: false }
}
