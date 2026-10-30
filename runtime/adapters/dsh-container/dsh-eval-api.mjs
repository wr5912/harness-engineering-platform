#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SAFETY_STOP_REASONS,
  assertSessionIdentity,
  judgeCase,
  parseArchive,
  result,
  saveCaseResult,
  saveEvidence,
  saveSessionTrace,
  toolEvents,
  turnsFromTrace,
  withCaseTimeout,
} from './dsh-eval-common.mjs'

const ANALYSIS_TOOLS = ['glob', 'grep', 'read']
const ROUTE_FIELDS = ['maxTokens', 'model', 'provider', 'reasoningEffort']

async function readInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.cases)) throw new Error('invalid-payload')
  for (const name of ['auth_url', 'workspace', 'preset_id', 'judge_preset_id', 'evidence_root']) {
    if (typeof payload[name] !== 'string' || payload[name] === '') throw new Error('invalid-payload')
  }
  if (!Number.isInteger(payload.timeout_ms) || payload.timeout_ms < 1) throw new Error('invalid-payload')
  if (payload.operation === 'review') {
    if (!Array.isArray(payload.scenes) || payload.scenes.length === 0) throw new Error('invalid-payload')
    const route = payload.model_route
    if (!route || typeof route !== 'object' || Array.isArray(route)
      || Object.keys(route).some(key => !ROUTE_FIELDS.includes(key))
      || typeof route.provider !== 'string' || route.provider === ''
      || typeof route.model !== 'string' || route.model === ''
      || (Object.hasOwn(route, 'maxTokens')
        && (!Number.isInteger(route.maxTokens) || route.maxTokens < 1))
      || (Object.hasOwn(route, 'reasoningEffort') && typeof route.reasoningEffort !== 'string')) {
      throw new Error('invalid-model-route')
    }
    for (const scene of payload.scenes) {
      const fields = scene && typeof scene === 'object' ? Object.keys(scene).sort().join(',') : ''
      const repair = fields === 'prior_prompts,prompt,scene_id,session_id'
      if (!scene || typeof scene !== 'object' || (!repair && fields !== 'prompt,scene_id')
        || !/^scene-[0-9]+$/.test(scene.scene_id ?? '')
        || typeof scene.prompt !== 'string' || scene.prompt === ''
        || (repair && (typeof scene.session_id !== 'string' || scene.session_id === ''
          || !Array.isArray(scene.prior_prompts) || scene.prior_prompts.length === 0
          || scene.prior_prompts.some(prompt => typeof prompt !== 'string' || prompt === '')))) {
        throw new Error('invalid-scene')
      }
    }
  }
  for (const item of payload.cases) {
    if (!item || typeof item !== 'object' || !/^U-[A-Z0-9-]+$/.test(item.case_id ?? '')
      || !Array.isArray(item.inputs) || item.inputs.length === 0
      || item.inputs.some(input => typeof input !== 'string' || input === '')
      || typeof item.expected_behavior !== 'string' || item.expected_behavior === '') {
      throw new Error('invalid-case')
    }
  }
  return payload
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function poll(action, accept, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('case-hard-timeout')
    try {
      const value = await action(signal)
      if (accept(value)) return value
    } catch (error) {
      if (SAFETY_STOP_REASONS.has(error?.message)) throw error
      lastError = error
    }
    await delay(300)
  }
  throw Object.assign(new Error('poll-timeout'), {
    rpc_method: lastError?.rpc_method, http_status: lastError?.http_status,
    error_code: lastError?.error_code ?? lastError?.message,
    runtime_diagnostic: lastError?.runtime_diagnostic,
  })
}

async function authenticate(authUrl, signal) {
  const baseUrl = new URL(authUrl)
  baseUrl.search = ''
  baseUrl.hash = ''
  const response = await fetch(authUrl, { redirect: 'manual', signal })
  if (response.status === 200 && !new URL(authUrl).searchParams.has('token')) {
    return { baseUrl, cookie: '' }
  }
  if (response.status !== 303) throw new Error('auth-redirect-failed')
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  const cookie = setCookie?.split(';', 1)[0]
  if (!cookie) throw new Error('auth-cookie-missing')
  return { baseUrl, cookie }
}

async function rpc(connection, method, args, signal) {
  const response = await fetch(new URL(`api/${method}`, connection.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: connection.cookie },
    signal,
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-eval-${randomUUID()}`,
      method,
      payload: { args },
    }),
  })
  if (!response.ok) throw Object.assign(new Error('runtime-rpc-failed'), {
    rpc_method: method, http_status: response.status,
  })
  const body = await response.json()
  if (!body?.result?.ok) {
    const error = body?.result?.error
    // 保留原生错误身份与已知的插件装载事实；不复制任意错误正文或配置。
    const plugin = error?.code === 'agent-preset/invalid' && /^([a-z0-9-]+) \((\/opt\/dsh-managed\/[A-Za-z0-9_./-]+)\): never started$/.exec(error?.details?.reason ?? error?.message ?? '')
    throw Object.assign(new Error('runtime-rpc-failed'), {
      rpc_method: method, http_status: response.status,
      error_code: typeof error?.code === 'string' && /^[a-zA-Z0-9_/-]{1,120}$/.test(error.code) ? error.code : null,
      ...(plugin ? { runtime_diagnostic: { plugin: plugin[1], entrypoint: plugin[2], reason: 'never started' } } : {}),
    })
  }
  return body.result.value
}

/** 只保留原生装载诊断的插件定位与缺失服务，不复制任意异常正文或配置。 */
function presetDiagnostics(broken) {
  const diagnostics = []
  let unknown_detail_count = 0
  for (const line of broken.split('\n')) {
    const row = /^([a-zA-Z0-9_./-]{1,100}) \(((?:file:\/\/)?\/opt\/[A-Za-z0-9_./-]+|@deepseek-ai\/[a-z0-9-]+|cordis:include)\): (never started|waiting for ([A-Za-z][A-Za-z0-9]*(?:, [A-Za-z][A-Za-z0-9]*)*))$/.exec(line)
    if (!row) { unknown_detail_count++; continue }
    diagnostics.push({ plugin: row[1], entrypoint: row[2], reason: row[4] ? 'waiting for services' : 'never started',
      ...(row[4] ? { missing_services: row[4].split(', ') } : {}) })
  }
  return { diagnostics, ...(unknown_detail_count ? { unknown_detail_count } : {}) }
}

async function presetReadiness(connection, presetId, signal) {
  try {
    const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5000)])
    const roster = await rpc(connection, 'agentPresets/list', {}, bounded)
    const selected = Array.isArray(roster?.presets) ? roster.presets.filter(row => row?.id === presetId) : []
    if (selected.length !== 1 || selected[0].broken !== undefined && typeof selected[0].broken !== 'string') return { source: 'agentPresets/list', preset_id: presetId, status: 'unknown' }
    return { source: 'agentPresets/list', preset_id: presetId,
      status: selected[0].broken === undefined ? 'ready' : 'broken',
      ...(selected[0].broken === undefined ? {} : presetDiagnostics(selected[0].broken)) }
  } catch (error) {
    return { source: 'agentPresets/list', preset_id: presetId, status: 'unknown',
      ...(typeof error?.error_code === 'string' ? { error_code: error.error_code } : {}) }
  }
}

async function exportSession(connection, sessionId, signal) {
  const url = new URL('api/session.export', connection.baseUrl)
  url.searchParams.set('sessionId', sessionId)
  url.searchParams.set('includeDescendants', 'true')
  const response = await fetch(url, { headers: { cookie: connection.cookie }, signal })
  if (!response.ok) throw Object.assign(new Error('session-export-failed'), {
    rpc_method: 'session.export', http_status: response.status,
  })
  return parseArchive(new Uint8Array(await response.arrayBuffer()), connection.archiveCodec)
}

async function listSessions(connection, signal) {
  const value = await rpc(connection, 'session/list', { _request: {} }, signal)
  if (!Array.isArray(value?.items)) throw new Error('session-list-failed')
  return value.items
}

async function createWorkspace(connection, workspacePath, signal) {
  const value = await rpc(connection, 'workspace/create', { request: { path: workspacePath } }, signal)
  const workspace = value?.workspace
  if (typeof workspace?.workspaceId !== 'string' || workspace.path !== workspacePath) {
    throw new Error('identity-drift')
  }
  return workspace
}

async function createSession(connection, payload, workspace, presetId, signal, onCreated, title = `评测 ${presetId}`) {
  const preset_readiness = await presetReadiness(connection, presetId, signal)
  let created
  try { created = await rpc(connection, 'session/create', {
    request: { workspaceId: workspace.workspaceId, agentPreset: presetId },
  }, signal) } catch (error) { error.preset_readiness = preset_readiness; throw error }
  if (typeof created?.sessionId === 'string') await onCreated?.({
    session_id: created.sessionId, workspace_id: workspace.workspaceId,
    session_preset: created.agentPreset, session_workspace: payload.workspace, preset_readiness,
  })
  if (typeof created?.sessionId !== 'string' || created.agentPreset !== presetId) {
    throw new Error('identity-drift')
  }
  // Case 已有固定名称，通过原生公开能力固定标题，避免额外生成评测会话标题。
  const renamed = await rpc(connection, 'session/rename', { request: { sessionId: created.sessionId, title } }, signal)
  if (renamed?.title !== title || !Number.isSafeInteger(renamed.seq) || renamed.seq < 0) throw new Error('session-title-pin-failed')
  const summary = await poll(
    async pollSignal => (await listSessions(connection, pollSignal))
      .find(item => item.sessionId === created.sessionId),
    item => item !== undefined,
    payload.timeout_ms,
    signal,
  )
  return {
    session_id: created.sessionId,
    workspace_id: workspace.workspaceId,
    session_title: title,
    preset_readiness,
    ...assertSessionIdentity(summary, presetId, payload.workspace),
  }
}

async function selectSessionRoute(connection, sessionId, route, signal) {
  const requested = {
    sessionId,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
  const value = await rpc(connection, 'session/selectModel', { request: requested }, signal)
  const selected = value?.selected
  const expected = { ...requested }
  delete expected.sessionId
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)
    || Object.keys(selected).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, item]) => selected[key] !== item)) {
    throw new Error('analysis-route-selection-failed')
  }
}

async function promptSession(connection, sessionId, input, inputs, timeoutMs, signal, onArchive, onStep) {
  const requestId = randomUUID()
  onStep?.('prompt', { request_id: requestId, session_id: sessionId, input_index: inputs.length - 1 })
  const accepted = await rpc(connection, 'session/prompt', {
    request: {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: input }],
    },
  }, signal)
  if (accepted?.accepted !== true) throw new Error('prompt-not-accepted')
  onStep?.('trace-export', { last_successful_step: 'prompt-accepted' })
  let archive
  const turns = await poll(async () => {
    archive = await exportSession(connection, sessionId, signal)
    await onArchive?.(archive)
    return turnsFromTrace(archive, inputs)
  }, value => value !== null, timeoutMs, signal)
  return { archive, turns }
}

function analysisToolAccesses(archive, toolNames) {
  if (!Array.isArray(toolNames) || toolNames.length !== new Set(toolNames).size
    || [...toolNames].sort().join(',') !== ANALYSIS_TOOLS.join(',')) {
    throw new Error('analysis-tools-invalid')
  }
  const calls = new Map()
  const sessionLogs = new Map()
  const completed = new Set()
  const accesses = []
  for (const { event, session_log } of toolEvents(archive)) {
    if (event?.type === 'tool/call') {
      const { callId, name, arguments: encoded } = event.data ?? {}
      if (typeof callId !== 'string' || calls.has(callId) || !ANALYSIS_TOOLS.includes(name)
        || typeof encoded !== 'string') throw new Error('analysis-tools-invalid')
      let args
      try {
        args = JSON.parse(encoded)
      } catch {
        throw new Error('analysis-tools-invalid')
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('analysis-tools-invalid')
      }
      const access = { name, arguments: args }
      calls.set(callId, access)
      sessionLogs.set(access, session_log)
      accesses.push(access)
    } else if (event?.type === 'tool/result') {
      const source = event.data?.message?.source
      const callId = source?.kind === 'tool' ? source.callId : undefined
      if (typeof callId !== 'string' || !calls.has(callId) || completed.has(callId)
        || sessionLogs.get(calls.get(callId)) !== session_log) {
        throw new Error('analysis-tools-invalid')
      }
      const message = event.data?.message
      // DSH v4 使用 tool 消息；旧轨迹是 user 消息中的嵌套 tool-result。
      const nativeResult = message?.role === 'tool'
      const result = nativeResult ? message : message?.content?.[0]
      if (!Array.isArray(message?.content) || message.content.length === 0
        || (nativeResult ? message.content.some(block => block?.type === 'tool-result')
          : message.role !== 'user' || message.content.length !== 1 || result?.type !== 'tool-result')
        || result.toolCallId !== callId
        || typeof result.isError !== 'boolean') {
        throw new Error('analysis-tools-invalid')
      }
      const access = calls.get(callId)
      if (result.isError) {
        // 原生参数校验可能拒绝一次只读尝试；仅在同一文件随后成功重读时恢复。
        if (!nativeResult || access.name !== 'read'
          || event.data?.error?.name !== 'ToolArgsError' || event.data.error.code !== 'INVALID_ARGS') {
          throw new Error('analysis-tools-invalid')
        }
        analysisReadPath(access.arguments.file_path)
        access.result = { is_error: true, error_code: 'INVALID_ARGS', recovered_by: null }
        completed.add(callId)
        continue
      }
      if (event.data?.error !== undefined) throw new Error('analysis-tools-invalid')
      access.result = { is_error: false }
      if (access.name === 'read') {
        const { path, offset, lines, totalLines } = event.data?.meta ?? {}
        if (typeof path !== 'string' || path === '' || !Number.isInteger(offset) || offset < 1
          || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)
          || (totalLines === 0 && (offset !== 1 || lines.length !== 0))
          || lines.some((line, index) => !line || typeof line !== 'object'
            || line.number !== offset + index || typeof line.text !== 'string')) {
          throw new Error('analysis-tools-invalid')
        }
        access.result.read = {
          path,
          offset,
          line_numbers: lines.map(line => line.number),
          total_lines: totalLines,
        }
      }
      completed.add(callId)
    }
  }
  if (!accesses.length || completed.size !== calls.size) throw new Error('analysis-tools-invalid')
  for (const [index, access] of accesses.entries()) {
    if (!access.result.is_error) continue
    const path = analysisReadPath(access.arguments.file_path)
    const recovered = accesses.findIndex((item, next) => next > index && item.name === 'read'
      && item.result.is_error === false && sessionLogs.get(item) === sessionLogs.get(access)
      && analysisReadPath(item.arguments.file_path) === path)
    if (recovered < 0) throw new Error('analysis-tools-invalid')
    access.result.recovered_by = recovered
  }
  return accesses
}

function analysisReadPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('analysis-tools-invalid')
  let path = posix.normalize(value)
  if (path.startsWith('/work/evaluation-run/')) path = path.slice('/work/evaluation-run/'.length)
  if (posix.isAbsolute(path) || ['.', '..'].includes(path) || path.startsWith('../')) {
    throw new Error('analysis-tools-invalid')
  }
  return path
}

async function runCase(connection, payload, item, workspace, signal, traceState) {
  traceState.stage = 'target-session-create'
  const session = await createSession(connection, payload, workspace, payload.preset_id, signal, async created => {
    traceState.session = created
    traceState.stage = 'target-session-verify'
    traceState.last_successful_step = 'target-session-created'
    await saveEvidence(payload.evidence_root, item, { inputs: item.inputs, assistant_texts: [], session_id: created.session_id }, null, {
      schema_version: '1.0', case_id: item.case_id, transport: 'api', ...created,
      completed: false, stage: traceState.stage, last_successful_step: traceState.last_successful_step,
    })
  }, `评测 ${item.case_id}`)
  traceState.session = session
  traceState.last_successful_step = 'target-session-verified'
  let completed
  for (let index = 0; index < item.inputs.length; index += 1) {
    completed = await promptSession(
      connection, session.session_id, item.inputs[index], item.inputs.slice(0, index + 1),
      payload.timeout_ms, signal, async archive => {
        traceState.targetArchive = archive
        const turns = turnsFromTrace(archive, item.inputs.slice(0, index + 1)) ?? []
        await saveEvidence(payload.evidence_root, item, {
          inputs: item.inputs, assistant_texts: turns.map(turn => turn.assistant_text),
          session_id: session.session_id, turns,
        }, archive, {
          schema_version: '1.0', case_id: item.case_id, transport: 'api', ...session,
          completed: false, stage: traceState.stage, last_successful_step: traceState.last_successful_step,
        })
      }, (step, metadata) => {
        traceState.stage = `target-${step}`
        Object.assign(traceState, metadata)
      },
    )
  }
  const { archive, turns } = completed
  traceState.last_successful_step = 'target-turns-completed'
  const response = {
    inputs: item.inputs,
    assistant_texts: turns.map(turn => turn.assistant_text),
    session_id: session.session_id,
    turns,
  }
  const checks = {
    schema_version: '1.0',
    case_id: item.case_id,
    transport: 'api',
    expected_behavior: item.expected_behavior,
    ...session,
    trace_format: 'dsh-session-export-envelope-v1',
    root_session_log: archive.rootName,
    guard: payload.declared_guard ? {
      declared: payload.declared_guard, status: 'unknown',
      reason: 'Runtime Session API 未提供可核验的 Guard 激活信息；Preset 和 Workspace 匹配不能替代插件激活证据。',
    } : { declared: null, status: 'not-declared' },
    completed: turns.every(turn => turn.turn_reason === 'completed'),
  }
  if (!checks.completed) {
    await saveEvidence(payload.evidence_root, item, response, archive, checks)
    return result(item, 'error', 'inconclusive', 'DSH Turn 未正常完成。', 'turn-not-completed')
  }
  const judge = await judgeCase(item, response, archive, async input => {
    let judgeSession
    try {
      traceState.stage = 'judge-session-create'
      judgeSession = await createSession(
        connection, payload, workspace, payload.judge_preset_id, signal, async created => {
          traceState.judgeSession = created
          traceState.stage = 'judge-session-verify'
          traceState.last_successful_step = 'judge-session-created'
          await saveEvidence(payload.evidence_root, item, response, archive, checks, {
            response: null, archive: null, checks: { ...created, completed: false, stage: traceState.stage },
          })
        }, `评审 ${item.case_id}`,
      )
      traceState.judgeSession = judgeSession
      const judged = await promptSession(
        connection, judgeSession.session_id, input, [input], payload.timeout_ms, signal,
        async archive => {
          traceState.judgeArchive = archive
          await saveEvidence(payload.evidence_root, item, response, traceState.targetArchive, checks, {
            response: null, archive, checks: { ...judgeSession, completed: false },
          })
        }, (step, metadata) => {
          traceState.stage = `judge-${step}`
          Object.assign(traceState, metadata)
        },
      )
      return { ...judged, session: judgeSession }
    } catch (error) {
      error.judge_evidence = { archive: traceState.judgeArchive, session: judgeSession ?? traceState.judgeSession }
      error.evaluation_context = {
        failure_stage: traceState.stage, last_successful_step: traceState.last_successful_step ?? null,
        rpc_method: error?.rpc_method ?? null, http_status: error?.http_status ?? null,
        error_code: error?.error_code ?? null, runtime_diagnostic: error?.runtime_diagnostic, preset_readiness: error?.preset_readiness,
        request_id: traceState.request_id ?? null,
      }
      throw error
    }
  })
  checks.judge = judge.checks
  if (signal?.aborted) throw new Error('case-hard-timeout')
  await saveEvidence(payload.evidence_root, item, response, archive, checks, judge)
  if (!judge.available) {
    return result(item, 'completed', 'inconclusive', '评审未产生有效结论，需人工判定。')
  }
  const limitation = judge.checks.same_route_as_target ? ' 同一路由自评，仅作研究辅助。' : ''
  return result(item, 'completed', judge.response.verdict,
    `语义判定：${judge.response.reason}${limitation}`)
}

/** 交付实例的新业务 Session 使用同一 API 传输、身份检查与轨迹导出；不运行评审模型。 */
async function main() {
  const payload = await readInput()
  const connection = await authenticate(payload.auth_url)
  const workspace = await createWorkspace(connection, payload.workspace)
  if (payload.operation === 'review') {
    const results = []
    for (const scene of payload.scenes) {
      let latestArchive = null
      let sessionId = scene.session_id ?? null
      let failure = null
      const attempt = (scene.prior_prompts?.length ?? 0) + 1
      try {
        const session = scene.session_id === undefined
          ? await createSession(connection, payload, workspace, payload.judge_preset_id, undefined, undefined, `复核 ${scene.scene_id}`)
          : {
              session_id: scene.session_id,
              workspace_id: workspace.workspaceId,
              ...assertSessionIdentity(
                (await listSessions(connection)).find(item => item.sessionId === scene.session_id),
                payload.judge_preset_id,
                payload.workspace,
              ),
            }
        sessionId = session.session_id
        await selectSessionRoute(connection, session.session_id, payload.model_route)
        const inputs = [...(scene.prior_prompts ?? []), scene.prompt]
        const completed = await withCaseTimeout(
          signal => promptSession(
            connection, session.session_id, scene.prompt, inputs, payload.timeout_ms, signal,
            archive => { latestArchive = archive },
          ),
          payload.timeout_ms,
        )
        const turn = turnsFromTrace(completed.archive, inputs)?.at(-1)
        if (!turn || turn.turn_reason !== 'completed') throw new Error('analysis-turn-invalid')
        if (!turn.route || typeof turn.route !== 'object'
          || Object.keys(turn.route).length !== Object.keys(payload.model_route).length
          || Object.entries(payload.model_route).some(([key, value]) => turn.route[key] !== value)) {
          throw new Error('analysis-route-mismatch')
        }
        const toolAccesses = analysisToolAccesses(completed.archive, turn.tool_names)
        results.push({
          scene_id: scene.scene_id,
          text: turn.assistant_text,
          session_id: session.session_id,
          route: turn.route,
          tool_names: ANALYSIS_TOOLS,
          tool_accesses: toolAccesses,
        })
      } catch (error) {
        const reason = /^[a-z0-9-]+$/.test(error?.message ?? '') ? error.message : 'scene-review-error'
        failure = reason
        results.push({ scene_id: scene.scene_id, error: reason })
      } finally {
        await saveSessionTrace(join(payload.evidence_root, scene.scene_id, `attempt-${String(attempt).padStart(2, '0')}`), latestArchive, {
          operation: 'review', session_id: sessionId, attempt,
          status: failure ? 'error' : 'completed', failure_reason: failure,
          trace_available: Boolean(latestArchive),
        })
      }
    }
    process.stdout.write(`${JSON.stringify({ schema_version: '1.0', operation: 'review', results })}\n`)
    return
  }
  const rows = []
  let stopReason
  for (const item of payload.cases) {
    const traceState = { targetArchive: null, judgeArchive: null, judgeSession: null, session: null, stage: 'target-session-create' }
    try {
      rows.push(await withCaseTimeout(
        signal => runCase(connection, payload, item, workspace, signal, traceState),
        payload.timeout_ms * (item.inputs.length + 2), true,
      ))
    } catch (error) {
      const reason = SAFETY_STOP_REASONS.has(error?.message) ? error.message : `api-${traceState.stage}-failed`
      const targetArchive = traceState.targetArchive ?? (traceState.judgeSession ? null : error?.archive ?? null)
      let turns = []
      if (targetArchive) {
        try { turns = turnsFromTrace(targetArchive, item.inputs) ?? [] } catch { /* 原始轨迹仍完整保存，失配不抹去证据。 */ }
      }
      await saveEvidence(payload.evidence_root, item,
        { inputs: item.inputs, assistant_texts: turns.map(turn => turn.assistant_text), session_id: traceState.session?.session_id ?? null, turns }, targetArchive,
        { schema_version: '1.0', case_id: item.case_id, transport: 'api', ...traceState.session, completed: false,
          failure_reason: reason, failure_stage: traceState.stage, last_successful_step: traceState.last_successful_step ?? null,
          request_id: traceState.request_id ?? null, input_index: traceState.input_index ?? null,
          rpc_method: error?.rpc_method ?? null, http_status: error?.http_status ?? null,
          error_code: error?.error_code ?? (/^[a-z0-9-]+$/.test(error?.message ?? '') ? error.message : error?.name ?? 'Error'),
          runtime_diagnostic: error?.runtime_diagnostic,
          preset_readiness: error?.preset_readiness ?? traceState.session?.preset_readiness,
          trace_available: Boolean(targetArchive) },
        traceState.judgeSession ? { response: null, archive: traceState.judgeArchive, checks: { ...traceState.judgeSession, unavailable_reason: reason, trace_available: Boolean(traceState.judgeArchive) } } : null)
      rows.push(result(item, 'error', 'inconclusive',
        SAFETY_STOP_REASONS.has(reason) ? '评测身份或证据失配，已停止。' : `Runtime API 在 ${traceState.stage} 阶段未完成，未产生语义结论。`,
        reason))
      if (SAFETY_STOP_REASONS.has(reason)) {
        stopReason = reason
        await saveCaseResult(payload.evidence_root, rows.at(-1))
        break
      }
    }
    await saveCaseResult(payload.evidence_root, rows.at(-1))
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: '1.0',
    executor: 'api',
    rows,
    ...(stopReason ? { stop_reason: stopReason } : {}),
  })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  const reason = /^[a-z0-9-]+$/.test(error?.message ?? '') ? error.message : (error?.name ?? 'Error')
  process.stderr.write(`dsh-eval-api failed: ${reason}\n`)
  process.exitCode = 2
})
