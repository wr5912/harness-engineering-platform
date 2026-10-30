import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFile, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// 只替换 DSH 的外部 HTTP 协议；评测入口、归因校验和证据写入均运行实际源码。
const adapter = dirname(fileURLToPath(import.meta.url))
const plugin = fileURLToPath(new URL('../../../platform/plugin/', import.meta.url))
const { zipSync, strToU8 } = createRequire(join(plugin, 'package.json'))('fflate')
const route = { provider: 'deepseek-official', model: 'fixture-review', maxTokens: 1024, reasoningEffort: 'high' }
const workspace = '/fixture/workspace'
const firstPrompt = '检查本次执行证据。'

function toolPair(callId, name, sessionId, options = {}) {
  const rows = [
    { type: 'tool/call', data: { callId, name, arguments: JSON.stringify(name === 'read'
      ? { file_path: 'evidence/checks.json' } : { path: 'evidence' }) } },
    { type: 'tool/result', data: {
      message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false }] },
      meta: { path: 'evidence/checks.json', offset: 1, lines: [{ number: 1, text: sessionId }], totalLines: 1 },
    } },
  ]
  if (options.nativeTools) rows[1].data.message = {
    role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false,
    content: [{ type: 'text', text: sessionId }],
  }
  options.mutateTool?.(rows, name)
  return rows
}

function archive(session, options, snapshot) {
  const events = session.prompts.flatMap((prompt, index) => [
    { type: 'user/message', data: { id: `user-${index}`, source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] } },
    { type: 'request/header', data: { header: { config: options.routeMismatch ? { ...(session.route ?? route), model: 'unexpected-model' } : session.route ?? route, tools: ['glob', 'grep', 'read'].map(name => ({ name })) } } },
    ...toolPair(`${session.id}-read-${index}`, options.invalidTools ? 'shell' : 'read', session.id, options),
    ...(options.nativeTools ? toolPair(`${session.id}-grep-${index}`, 'grep', session.id, options) : []),
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `归因结果 ${index + 1}` }] } } },
    ...(!options.incomplete && !(options.incompleteLast && index === session.prompts.length - 1) ? [{ type: 'turn/end', data: { reason: { kind: 'completed' }, turn: index + 1 } }] : []),
  ])
  const delegatedComplete = options.delegated && session.treeSettled === session.prompts.length
  if (delegatedComplete) events.push(
    { type: 'turn/start', data: { turn: session.prompts.length + 1 } },
    { type: 'user/message', data: { id: 'child-report', source: { kind: 'subagent', sessionId: 'delegated-child' }, content: [{ type: 'text', text: '子任务最终报告' }] } },
    { type: 'request/header', data: { header: { config: session.route ?? route, tools: ['glob', 'grep', 'read'].map(name => ({ name })) } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '委派后最终回答' }] } } },
    { type: 'turn/end', data: { reason: { kind: options.rootFinalFailure ? 'error' : 'completed' }, turn: session.prompts.length + 1 } },
  )
  if (options.crossTurn) events.push({ type: 'user/message', data: { id: 'unexpected-user', source: { kind: 'user' }, content: [{ type: 'text', text: '不属于本次请求的额外用户输入' }] } })
  const descendants = [
    { type: 'fixture/snapshot', data: { snapshot } },
    ...toolPair(`${session.id}-child-glob`, 'glob', session.id, options),
  ]
  if (delegatedComplete) descendants.push({ type: 'request/usage', data: { usage: { inputTokens: 37, outputTokens: 11 } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' }, turn: 1 } })
  const encode = rows => strToU8(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  return zipSync({ [`${session.id}.jsonl`]: encode(events), 'descendants/review-child.jsonl': encode(descendants),
    ...(options.childReadRetry ? { 'z-descendants/read-retry.jsonl': encode(toolPair(`${session.id}-child-retry`, 'read', session.id, { nativeTools: true })) } : {}) })
}

async function fixture(t, scenario = () => ({}), selectedRoute = route) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-review-trace-'))
  // 原始两份运行模块保持逐字节一致，依赖通过临时 node_modules 链接解析。
  for (const name of ['dsh-eval-api.mjs', 'dsh-eval-common.mjs', 'evaluation-wait.mts']) await copyFile(join(adapter, name), join(directory, name))
  await symlink(join(plugin, 'node_modules'), join(directory, 'node_modules'), 'dir')
  const sessions = new Map(), requests = [], exportCounts = new Map(), treeWaits = []
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture')
      if (url.pathname === '/assistant/' && request.method === 'GET') {
        response.end('fixture runtime')
        return
      }
      if (url.pathname === '/assistant/api/evaluation.wait') {
        const sessionId = url.searchParams.get('sessionId')
        const session = sessions.get(sessionId)
        assert.ok(session, '任务树等待只能使用已经创建的会话')
        treeWaits.push(sessionId)
        const options = scenario(session.prompts.at(-1), session)
        if (options.incomplete || options.incompleteLast) return
        if (options.delegated) await new Promise(resolve => setTimeout(resolve, 650))
        session.treeSettled = session.prompts.length
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ session_id: sessionId, settled: true }))
        return
      }
      if (url.pathname === '/assistant/api/session.export') {
        const session = sessions.get(url.searchParams.get('sessionId'))
        assert.ok(session, '导出必须指向已创建的 Session')
        assert.equal(url.searchParams.get('includeDescendants'), 'true')
        const snapshot = (exportCounts.get(session.id) ?? 0) + 1
        exportCounts.set(session.id, snapshot)
        const options = scenario(session.prompts.at(-1), session)
        if (options.noArchive) { response.writeHead(503); response.end(); return }
        response.writeHead(200, { 'content-type': 'application/zip' })
        response.end(archive(session, options, snapshot))
        return
      }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const method = url.pathname.slice('/assistant/api/'.length)
      assert.equal(envelope.method, method)
      assert.equal(envelope.type, 'client-request')
      const args = envelope.payload.args
      requests.push({ method, args })
      let value
      if (method === 'agentPresets/list') {
        const options = scenario(undefined, { preset: 'target', prompts: [] })
        if (options.readinessUnavailable) { response.writeHead(503); response.end(); return }
        value = { presets: [{ id: 'target', isDefault: true, ...(options.presetBroken === undefined ? {} : { broken: options.presetBroken }) }, { id: 'reviewer', isDefault: false }] }
      }
      else if (method === 'workspace/create') value = { workspace: { workspaceId: 'review-workspace', path: args.request.path } }
      else if (method === 'session/create') {
        const error = scenario(undefined, { preset: args.request.agentPreset, prompts: [] }).createError
        if (error) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ result: { ok: false, error } }))
          return
        }
        const id = `review-${sessions.size + 1}`
        sessions.set(id, { id, preset: args.request.agentPreset, prompts: [] })
        value = { sessionId: id, agentPreset: args.request.agentPreset }
      } else if (method === 'session/rename') {
        const session = sessions.get(args.request.sessionId)
        assert.ok(session)
        assert.equal(session.prompts.length, 0, '新评测 Session 必须在首条模型请求前固定标题')
        assert.equal(typeof args.request.title, 'string')
        assert.ok(args.request.title.trim())
        session.title = args.request.title
        value = { sessionId: session.id, title: session.title, seq: 1 }
      } else if (method === 'session/list') value = { items: [...sessions.values()].map(session => ({ sessionId: session.id, cwd: workspace, projections: { values: { agentPreset: session.preset } } })) }
      else if (method === 'session/selectModel') {
        const { sessionId, ...selected } = args.request
        assert.ok(sessions.has(sessionId))
        sessions.get(sessionId).route = selectedRoute
        value = { selected }
      } else if (method === 'session/prompt') {
        const session = sessions.get(args.request.sessionId)
        assert.ok(session)
        session.prompts.push(args.request.content[0].text)
        value = { accepted: true }
      } else throw new Error(`未实现的外部 RPC: ${method}`)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ result: { ok: true, value } }))
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const evidenceRoot = join(directory, 'evidence')
  async function run(scenes, timeoutMs = 2000, operation = 'review') {
    const child = spawn(process.execPath, [join(directory, 'dsh-eval-api.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000)
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`实际评测驱动失败: ${code ?? signal} ${Buffer.concat(stderr).toString('utf8')}`)))
    })
    child.stdin.end(JSON.stringify({ operation, auth_url: `http://127.0.0.1:${server.address().port}/assistant/`, workspace,
      preset_id: 'target', judge_preset_id: 'reviewer', evidence_root: evidenceRoot, timeout_ms: timeoutMs, cases: operation === 'review' ? [] : scenes, scenes: operation === 'review' ? scenes : [], model_route: selectedRoute }))
    try { await completion } finally { clearTimeout(timer) }
    return JSON.parse(Buffer.concat(stdout).toString('utf8'))
  }
  async function evidence(scene, attempt = 1) {
    const base = attempt === null ? join(evidenceRoot, scene) : join(evidenceRoot, scene, `attempt-${String(attempt).padStart(2, '0')}`)
    const readRows = async name => (await readFile(join(base, name), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    return { checks: JSON.parse(await readFile(join(base, 'checks.json'), 'utf8')), trace: await readRows('trace.jsonl'), tools: await readRows('tools.jsonl') }
  }
  async function judgeEvidence(caseId) {
    const base = join(evidenceRoot, caseId)
    const trace = (await readFile(join(base, 'judge-trace.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
    return { trace, ...JSON.parse(await readFile(join(base, 'judge.json'), 'utf8')) }
  }
  return { run, runTarget: (cases, timeoutMs) => run(cases, timeoutMs, 'evaluate'), evidence, judgeEvidence, sessions, requests, exportCounts, treeWaits, evidenceRoot }
}

test('真实 session/create 失败保留原生错误码与插件定位，不把配置正文写入证据', async t => {
  const reason = 'security-operations-guard (/opt/dsh-managed/security-operations-guard.mjs): never started'
  const runtime = await fixture(t, () => ({ createError: { code: 'agent-preset/invalid', message: reason,
    details: { reason, configuration: '不得复制此配置正文' } } }))
  const response = await runtime.runTarget([{ case_id: 'U-LOAD-001', inputs: [firstPrompt], expected_behavior: '实际装载目标。' }])
  assert.equal(response.rows[0].execution_status, 'error')
  const saved = await runtime.evidence('U-LOAD-001', null)
  assert.equal(saved.checks.error_code, 'agent-preset/invalid')
  assert.equal(saved.checks.http_status, 200)
  assert.deepEqual(saved.checks.runtime_diagnostic, { plugin: 'security-operations-guard', entrypoint: '/opt/dsh-managed/security-operations-guard.mjs', reason: 'never started' })
  assert.equal(saved.checks.trace_available, false)
  assert.equal(JSON.stringify(saved).includes('不得复制此配置正文'), false)
  assert.equal(runtime.requests.some(request => request.method === 'session/prompt'), false)
})

test('原生Preset roster保留多插件missing service诊断，Session失败仍保存真实阶段与error_code', async t => {
  const reason = 'security-operations-guard (/opt/dsh-managed/security-operations-guard.mjs): waiting for mcpSessionManager\npolicy-selection-runtime (/opt/dsh-managed/policy-selection-runtime.mjs): waiting for mcpSessionManager, userQuestions'
  const runtime = await fixture(t, () => ({ presetBroken: reason, createError: { code: 'agent-preset/invalid', message: reason, details: { reason } } }))
  await runtime.runTarget([{ case_id: 'U-LOAD-002', inputs: [firstPrompt], expected_behavior: '目标需真实装载。' }])
  const saved = await runtime.evidence('U-LOAD-002', null)
  assert.equal(saved.checks.failure_stage, 'target-session-create')
  assert.equal(saved.checks.error_code, 'agent-preset/invalid')
  assert.equal(saved.checks.preset_readiness.status, 'broken')
  assert.deepEqual(saved.checks.preset_readiness.diagnostics.map(row => row.missing_services), [['mcpSessionManager'], ['mcpSessionManager', 'userQuestions']])
  assert.ok(runtime.requests.findIndex(row => row.method === 'agentPresets/list') < runtime.requests.findIndex(row => row.method === 'session/create'))
})

test('任意broken正文与配置不进入证据，readiness接口失败保持unknown而不假报ready', async t => {
  const secret = 'Bearer unit-private-do-not-copy'
  const broken = await fixture(t, () => ({ presetBroken: `arbitrary error password=${secret}`, createError: { code: 'agent-preset/invalid', message: secret, details: { configuration: secret } } }))
  await broken.runTarget([{ case_id: 'U-LOAD-003', inputs: [firstPrompt], expected_behavior: '来源不冒充。' }])
  const hidden = await broken.evidence('U-LOAD-003', null)
  assert.equal(hidden.checks.preset_readiness.status, 'broken')
  assert.equal(hidden.checks.preset_readiness.unknown_detail_count, 1)
  assert.equal(JSON.stringify(hidden).includes(secret), false)
  const missing = await fixture(t, () => ({ readinessUnavailable: true, createError: { code: 'agent-preset/invalid', message: secret } }))
  await missing.runTarget([{ case_id: 'U-LOAD-004', inputs: [firstPrompt], expected_behavior: '未知不当作通过。' }])
  assert.equal((await missing.evidence('U-LOAD-004', null)).checks.preset_readiness.status, 'unknown')
})

test('真实 review 驱动保存根与子 Session 轨迹，同 Session repair 使用独立 attempt 且保留首次证据', async t => {
  const runtime = await fixture(t)
  const first = await runtime.run([{ scene_id: 'scene-1', prompt: firstPrompt }])
  const sessionId = first.results[0].session_id
  assert.equal(first.results[0].text, '归因结果 1')
  assert.equal(runtime.sessions.size, 1)
  assert.equal(runtime.requests.filter(row => row.method === 'session/rename').length, 1)
  assert.equal(runtime.sessions.get(sessionId).title, '复核 scene-1')
  const before = await runtime.evidence('scene-1')
  assert.deepEqual(before.checks, { operation: 'review', session_id: sessionId, attempt: 1, status: 'completed', failure_reason: null, trace_available: true })
  assert.ok(before.trace.some(row => row.session_log === `${sessionId}.jsonl`))
  assert.ok(before.trace.some(row => row.session_log === 'descendants/review-child.jsonl'))
  assert.equal(before.tools.length, 4)

  const repaired = await runtime.run([{ scene_id: 'scene-1', prompt: '补充检查，修正归因结果。', prior_prompts: [firstPrompt], session_id: sessionId }])
  assert.equal(repaired.results[0].session_id, sessionId)
  assert.equal(repaired.results[0].text, '归因结果 2')
  assert.equal(runtime.requests.filter(row => row.method === 'session/create').length, 1)
  assert.equal(runtime.requests.filter(row => row.method === 'session/rename').length, 1, '同 Session repair 不重复建立或重命名会话')
  const after = await runtime.evidence('scene-1', 2)
  assert.equal(after.checks.attempt, 2)
  assert.equal(after.checks.status, 'completed')
  assert.equal(after.trace.filter(row => row.event.type === 'user/message').length, 2)
  assert.equal(after.tools.length, 6)
  assert.deepEqual(await runtime.evidence('scene-1', 1), before)
})

test('证据复核沿用实际非DeepSeek路由与推理档位，仍核对原生选择和请求轨迹', async t => {
  const selected = { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2.6-flash', reasoningEffort: 'off' }
  const runtime = await fixture(t, () => ({}), selected)
  const result = await runtime.run([{ scene_id: 'scene-1', prompt: firstPrompt }])
  assert.equal(result.results[0].error, undefined)
  assert.deepEqual(result.results[0].route, selected)
  assert.deepEqual(runtime.requests.find(row => row.method === 'session/selectModel').args.request,
    { sessionId: result.results[0].session_id, ...selected })
  const saved = await runtime.evidence('scene-1')
  assert.deepEqual(saved.trace.find(row => row.event.type === 'request/header').event.data.header.config, selected)
})

test('归因 route 或工具校验失败仍保存已经取得的原始轨迹及工具事件', async t => {
  const runtime = await fixture(t, prompt => ({ routeMismatch: prompt === '错误路由', invalidTools: prompt === '越界工具' }))
  const response = await runtime.run([{ scene_id: 'scene-1', prompt: '错误路由' }, { scene_id: 'scene-2', prompt: '越界工具' }])
  assert.deepEqual(response.results.map(row => row.error), ['analysis-route-mismatch', 'analysis-tools-invalid'])
  for (const [index, reason] of ['analysis-route-mismatch', 'analysis-tools-invalid'].entries()) {
    const saved = await runtime.evidence(`scene-${index + 1}`)
    assert.equal(saved.checks.status, 'error')
    assert.equal(saved.checks.failure_reason, reason)
    assert.equal(saved.checks.trace_available, true)
    assert.ok(saved.trace.length > 0)
    assert.equal(saved.tools.length, 4)
  }
  const routeFailure = await runtime.evidence('scene-1')
  assert.equal(routeFailure.trace.find(row => row.event.type === 'request/header').event.data.header.config.model, 'unexpected-model')
  const toolsFailure = await runtime.evidence('scene-2')
  assert.ok(toolsFailure.tools.some(row => row.event.type === 'tool/call' && row.event.data.name === 'shell'))
})

test('DSH v4 原生工具回执保留调用关联及 read 行覆盖，支持 read、grep 和 glob', async t => {
  const runtime = await fixture(t, () => ({ nativeTools: true }))
  const response = await runtime.run([{ scene_id: 'scene-9', prompt: firstPrompt }])
  const result = response.results[0]
  assert.equal(result.error, undefined)
  assert.deepEqual(result.tool_accesses.map(access => access.name).sort(), ['glob', 'grep', 'read'])
  assert.deepEqual(result.tool_accesses.find(access => access.name === 'read'), { name: 'read', arguments: { file_path: 'evidence/checks.json' },
    result: { is_error: false, read: { path: 'evidence/checks.json', offset: 1, line_numbers: [1], total_lines: 1 } } })
  const saved = await runtime.evidence('scene-9')
  assert.equal(saved.checks.status, 'completed')
  assert.ok(saved.tools.filter(row => row.event.type === 'tool/result').every(row => row.event.data.message.role === 'tool'))
})

test('原生read参数错误必须由同文件的后续成功读取恢复，失败尝试保留且不计覆盖', async t => {
  const runtime = await fixture(t, prompt => ({ nativeTools: true, childReadRetry: prompt === 'other-session', mutateTool: (rows, name) => {
    if (prompt === 'grep-error') {
      if (name === 'grep') {
        rows[1].data.message.isError = true
        rows[1].data.error = { name: 'ToolArgsError', code: 'INVALID_ARGS' }
        rows.push(...toolPair(`${rows[0].data.callId}-retry`, 'grep', 'retry', { nativeTools: true }))
      }
      return
    }
    if (name !== 'read') return
    const call = rows[0].data
    call.arguments = JSON.stringify({ file_path: 'evidence/checks.json', offset: '1</tool_call>' })
    rows[1].data.message.isError = true
    rows[1].data.error = { name: 'ToolArgsError', code: prompt === 'other-error' ? 'FAILED' : 'INVALID_ARGS' }
    delete rows[1].data.meta
    if (prompt === 'unrecovered' || prompt === 'other-session') return
    const retry = toolPair(`${call.callId}-retry`, 'read', 'retry evidence', { nativeTools: true })
    if (prompt === 'different-file') retry[0].data.arguments = JSON.stringify({ file_path: 'evidence/other.json' })
    if (prompt === 'outside-run') call.arguments = JSON.stringify({ file_path: '/etc/hostname', offset: '1' })
    if (prompt === 'prior-success') rows.unshift(...retry)
    else rows.push(...retry)
  } }))
  const recovered = await runtime.run([{ scene_id: 'scene-1', prompt: 'recovered' }])
  assert.equal(recovered.results[0].error, undefined)
  const accesses = recovered.results[0].tool_accesses
  const failed = accesses.findIndex(access => access.result.is_error === true)
  assert.ok(failed >= 0)
  assert.deepEqual(accesses[failed].result, { is_error: true, error_code: 'INVALID_ARGS', recovered_by: failed + 1 })
  assert.equal(accesses[failed + 1].result.is_error, false)
  assert.equal(accesses[failed].result.read, undefined)
  const saved = await runtime.evidence('scene-1')
  assert.ok(saved.tools.some(row => row.event.type === 'tool/result' && row.event.data.message.isError === true))
  assert.ok(saved.tools.some(row => row.event.type === 'tool/result' && row.event.data.message.isError === false))
  for (const [index, reason] of ['unrecovered', 'different-file', 'prior-success', 'other-error', 'outside-run', 'other-session', 'grep-error'].entries()) {
    const response = await runtime.run([{ scene_id: `scene-${index + 2}`, prompt: reason }])
    assert.equal(response.results[0].error, 'analysis-tools-invalid', reason)
  }
})

test('DSH v4 回执异常关联、错误、歧义嵌套或缺少读取元数据不能成为有效证据', async t => {
  const mutations = [
    rows => { rows[1].data.message.toolCallId = 'other-call' },
    rows => { rows[1].data.message.source.callId = 'other-call' },
    rows => { rows[1].data.message.isError = true },
    rows => { delete rows[1].data.message.isError },
    rows => { rows[1].data.message.isError = 'false' },
    rows => { rows[1].data.message.role = 'assistant' },
    rows => { rows[1].data.message.role = 'assistant'; rows[1].data.message.content = [{ type: 'tool-result', toolCallId: rows[0].data.callId, isError: false }] },
    rows => { delete rows[1].data.message.role; rows[1].data.message.content = [{ type: 'tool-result', toolCallId: rows[0].data.callId, isError: false }] },
    rows => { rows[1].data.message.content = [] },
    rows => { rows[1].data.message.content = [{ type: 'tool-result', toolCallId: rows[0].data.callId, isError: false }] },
    rows => { rows[1].data.error = { message: 'read failed' } },
    rows => { delete rows[1].data.meta },
    rows => { rows[1].data.meta.lines[0].number = 2 },
    rows => { rows.push(structuredClone(rows[1])) },
  ]
  const runtime = await fixture(t, prompt => ({ nativeTools: true, mutateTool: (rows, name) => {
    if (name === 'read') mutations[Number(prompt)](rows)
  } }))
  const response = await runtime.run(mutations.map((_, index) => ({ scene_id: `scene-${index + 1}`, prompt: String(index) })))
  assert.equal(response.results.length, mutations.length)
  for (const [index, result] of response.results.entries()) {
    assert.equal(result.error, 'analysis-tools-invalid', `mutation ${index}`)
    const saved = await runtime.evidence(`scene-${index + 1}`)
    assert.equal(saved.checks.status, 'error')
    assert.equal(saved.checks.trace_available, true)
  }
})

test('归因等待超时保存最后一个完整取得的 archive 快照', async t => {
  const runtime = await fixture(t, () => ({ incomplete: true }))
  const response = await runtime.run([{ scene_id: 'scene-1', prompt: firstPrompt }], 800)
  assert.equal(response.results[0].error, 'case-hard-timeout')
  const saved = await runtime.evidence('scene-1')
  const count = runtime.exportCounts.get('review-1')
  assert.ok(count >= 2, '必须经过多次真实导出轮询')
  assert.equal(saved.trace.find(row => row.event.type === 'fixture/snapshot').event.data.snapshot, count)
  assert.equal(saved.checks.failure_reason, 'case-hard-timeout')
  assert.equal(saved.checks.trace_available, true)
  assert.ok(saved.tools.length > 0)
  assert.equal(saved.trace.some(row => row.event.type === 'turn/end'), false)
})

test('始终无法取得 archive 时保留失败检查并明确 trace_available=false', async t => {
  const runtime = await fixture(t, () => ({ noArchive: true }))
  const response = await runtime.run([{ scene_id: 'scene-1', prompt: firstPrompt }], 400)
  assert.equal(response.results[0].error, 'case-hard-timeout')
  const saved = await runtime.evidence('scene-1')
  assert.equal(saved.checks.trace_available, false)
  assert.equal(saved.checks.status, 'error')
  assert.equal(saved.checks.failure_reason, 'case-hard-timeout')
  assert.equal(saved.checks.session_id, 'review-1')
  assert.deepEqual(saved.trace, [])
  assert.deepEqual(saved.tools, [])
})

test('真实业务多轮 Case 次轮超时保留首轮与最后取得的部分轨迹', async t => {
  const secondPrompt = '继续执行第二轮，但保持未结束。'
  const runtime = await fixture(t, prompt => ({ incompleteLast: prompt === secondPrompt }))
  const response = await runtime.runTarget([{ case_id: 'U-TARGET-001', inputs: [firstPrompt, secondPrompt], expected_behavior: '完成两轮任务。' }], 700)
  assert.equal(response.rows[0].execution_status, 'error')
  assert.equal(response.rows[0].verdict, 'inconclusive')
  const saved = await runtime.evidence('U-TARGET-001', null)
  assert.equal(saved.checks.trace_available, true)
  assert.equal(saved.checks.completed, false)
  const users = saved.trace.filter(row => row.event.type === 'user/message')
  assert.deepEqual(users.map(row => row.event.data.content[0].text), [firstPrompt, secondPrompt])
  assert.equal(saved.trace.filter(row => row.event.type === 'turn/end').length, 1, '已完成首轮必须保留，第二轮仍未完成')
  assert.ok(saved.trace.some(row => row.session_log === 'descendants/review-child.jsonl'))
  assert.equal(saved.trace.find(row => row.event.type === 'fixture/snapshot').event.data.snapshot, runtime.exportCounts.get('review-1'))
  assert.equal(saved.tools.length, 6)
  assert.equal(runtime.sessions.size, 1, '目标失败后不应启动评审 Session')
})

test('业务 Case 次轮一直无法导出时仍保留首轮成功取得的归档', async t => {
  const secondPrompt = '第二轮导出接口不可用。'
  const runtime = await fixture(t, prompt => ({ noArchive: prompt === secondPrompt }))
  const response = await runtime.runTarget([{ case_id: 'U-TARGET-002', inputs: [firstPrompt, secondPrompt], expected_behavior: '完成两轮任务。' }], 500)
  assert.equal(response.rows[0].execution_status, 'error')
  const saved = await runtime.evidence('U-TARGET-002', null)
  assert.equal(saved.checks.trace_available, true)
  assert.deepEqual(saved.trace.filter(row => row.event.type === 'user/message').map(row => row.event.data.content[0].text), [firstPrompt])
  assert.equal(saved.trace.filter(row => row.event.type === 'turn/end').length, 1)
  assert.equal(saved.tools.length, 4)
})

test('业务语义评审超时独立保存 judge 的部分轨迹，不覆盖目标 Session', async t => {
  const runtime = await fixture(t, (_prompt, session) => ({ incomplete: session.preset === 'reviewer' }))
  const response = await runtime.runTarget([{ case_id: 'U-TARGET-003', inputs: [firstPrompt], expected_behavior: '完成目标任务。' }], 700)
  assert.equal(response.rows[0].execution_status, 'completed')
  assert.equal(response.rows[0].verdict, 'inconclusive')
  const target = await runtime.evidence('U-TARGET-003', null)
  const judge = await runtime.judgeEvidence('U-TARGET-003')
  assert.ok(target.trace.some(row => row.session_log === 'review-1.jsonl'))
  assert.ok(!target.trace.some(row => row.session_log === 'review-2.jsonl'))
  assert.ok(judge.trace.some(row => row.session_log === 'review-2.jsonl'))
  assert.ok(!judge.trace.some(row => row.session_log === 'review-1.jsonl'))
  assert.equal(target.trace.filter(row => row.event.type === 'turn/end').length, 1)
  assert.equal(judge.trace.some(row => row.event.type === 'turn/end'), false)
  assert.equal(judge.checks.session_id, 'review-2')
  assert.equal(judge.checks.unavailable_reason, 'task-tree-wait-timeout')
  assert.equal(judge.trace.find(row => row.event.type === 'fixture/snapshot').event.data.snapshot, runtime.exportCounts.get('review-2'))
})

test('根首轮结束后仍等待委派及根后续回合，封存最终回复和子任务用量', async t => {
  const runtime = await fixture(t, (_prompt, session) => ({ delegated: session.preset === 'target' }))
  const response = await runtime.runTarget([{ case_id: 'U-DELEGATE-001', inputs: [firstPrompt], expected_behavior: '等待实际子任务结果。' }])
  assert.equal(response.rows[0].execution_status, 'completed')
  const saved = await runtime.evidence('U-DELEGATE-001', null)
  const reply = JSON.parse(await readFile(join(runtime.evidenceRoot, 'U-DELEGATE-001', 'response.json'), 'utf8'))
  assert.deepEqual(reply.assistant_texts, ['委派后最终回答'])
  assert.equal(reply.turns[0].turn, 2)
  assert.equal(saved.trace.filter(row => row.event.type === 'turn/end' && row.session_log === 'review-1.jsonl').length, 2)
  assert.ok(saved.trace.some(row => row.event.type === 'request/usage' && row.session_log === 'descendants/review-child.jsonl'))
  assert.ok(runtime.exportCounts.get('review-1') >= 3, '首轮快照已经完成也不能提前结束等待')
  assert.deepEqual(runtime.treeWaits, ['review-1', 'review-2'])
  assert.equal(runtime.requests.filter(row => row.method === 'session/prompt' && row.args.request.sessionId === 'review-1').length, 1, '等待不得重放原输入')
})

test('委派回报后的根回合失败保留失败，不由首个completed覆盖', async t => {
  const runtime = await fixture(t, (_prompt, session) => ({ delegated: session.preset === 'target', rootFinalFailure: true }))
  const response = await runtime.runTarget([{ case_id: 'U-DELEGATE-002', inputs: [firstPrompt], expected_behavior: '最终根回合必须成功。' }])
  assert.equal(response.rows[0].execution_status, 'error')
  assert.equal(response.rows[0].failure_reason, 'turn-not-completed')
  const saved = await runtime.evidence('U-DELEGATE-002', null)
  assert.equal(saved.checks.completed, false)
  assert.equal(runtime.sessions.size, 1, '最终失败不启动语义评审')
})

test('judge 的跨轮安全错误保留原始归属，目标 trace 与 judge-trace 各自指向正确 Session', async t => {
  const runtime = await fixture(t, (_prompt, session) => ({ crossTurn: session.preset === 'reviewer' }))
  const response = await runtime.runTarget([{ case_id: 'U-TARGET-004', inputs: [firstPrompt], expected_behavior: '完成目标任务。' }], 700)
  assert.equal(response.rows[0].execution_status, 'error')
  assert.equal(response.stop_reason, 'evidence-cross-turn')
  const target = await runtime.evidence('U-TARGET-004', null)
  const judge = await runtime.judgeEvidence('U-TARGET-004')
  assert.equal(target.checks.trace_available, true)
  assert.ok(target.trace.some(row => row.session_log === 'review-1.jsonl'))
  assert.ok(!target.trace.some(row => row.session_log === 'review-2.jsonl'))
  assert.deepEqual(target.trace.filter(row => row.event.type === 'user/message').map(row => row.event.data.content[0].text), [firstPrompt])
  assert.ok(judge.trace.some(row => row.session_log === 'review-2.jsonl'))
  assert.ok(!judge.trace.some(row => row.session_log === 'review-1.jsonl'))
  assert.equal(judge.checks.session_id, 'review-2')
  assert.equal(judge.checks.unavailable_reason, 'evidence-cross-turn')
  assert.ok(judge.trace.some(row => row.event.type === 'user/message' && row.event.data.content[0].text === '不属于本次请求的额外用户输入'))
})
