import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'

const adapter = new URL('../../../runtime/adapters/dsh-container/', import.meta.url).pathname
const modules = new URL('../node_modules', import.meta.url).pathname
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

test('原生review输入接受固定源码任务和既有场景，拒绝任意目录或任务名称', () => {
  const payload = { auth_url: 'http://127.0.0.1:1/', workspace: '/work/evaluation-run', preset_id: 'scenario-analysis',
    judge_preset_id: 'scenario-analysis', evidence_root: '/evidence', timeout_ms: 1000, cases: [], operation: 'review',
    model_route: { provider: 'fixture', model: 'review' } }
  const source = `import { readInput } from ${JSON.stringify(pathToFileURL(join(adapter, 'dsh-eval-api.mjs')).href)}; readInput().then(value => process.stdout.write(value.scenes[0].scene_id)).catch(error => { process.stderr.write(error.message); process.exitCode = 2 })`
  for (const id of ['source-diagnosis', 'scene-01', '../source-diagnosis', 'source-diagnosis/child', 'arbitrary']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      input: JSON.stringify({ ...payload, scenes: [{ scene_id: id, prompt: '{}' }] }), encoding: 'utf8',
    })
    assert.equal(result.status, ['source-diagnosis', 'scene-01'].includes(id) ? 0 : 2, result.stderr)
    if (result.status === 0) assert.equal(result.stdout, id)
    else assert.equal(result.stderr, 'invalid-scene')
  }
})

async function fixture(t, failure) {
  const directory = mkdtempSync(join(tmpdir(), 'eval-api-recovery-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const name of ['dsh-eval-api.mjs', 'dsh-eval-common.mjs', 'evaluation-wait.mts']) copyFileSync(join(adapter, name), join(directory, name))
  symlinkSync(modules, join(directory, 'node_modules'))
  const evidence = join(directory, 'evidence')
  mkdirSync(evidence)
  const sessions = new Map()
  const server = createServer(async (request, response) => {
    if (request.url === '/assistant/') { response.end('ready'); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)).payload.args : null
    const method = new URL(request.url, 'http://localhost').pathname.slice('/assistant/api/'.length)
    const reply = value => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result: { ok: true, value } })) }
    if (method.split('?')[0] === failure || failure === 'judge-create' && method === 'session/create' && sessions.size === 1) { response.writeHead(503); response.end(); return }
    if (method === 'evaluation.wait') {
      if (failure === 'partial') return
      const sessionId = new URL(request.url, 'http://localhost').searchParams.get('sessionId')
      assert.ok(sessions.has(sessionId))
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ session_id: sessionId, settled: true }))
      return
    }
    if (method === 'workspace/create') return reply({ workspace: { workspaceId: 'workspace-test', path: '/work/harness/workspace' } })
    if (method === 'session/create') {
      const sessionId = `session-${sessions.size + 1}`
      sessions.set(sessionId, { preset: input.request.agentPreset, inputs: [] })
      return reply({ sessionId, agentPreset: input.request.agentPreset })
    }
    if (method === 'session/list') return reply({ items: [...sessions].map(([sessionId, session]) => ({ sessionId,
      cwd: '/work/harness/workspace', projections: { values: { agentPreset: session.preset } } })) })
    if (method === 'session/rename') {
      sessions.get(input.request.sessionId).title = input.request.title
      return reply({ title: input.request.title, seq: 1 })
    }
    if (method === 'session/prompt') {
      assert.ok(sessions.get(input.request.sessionId).title, '必须在业务与评审 prompt 前固定已有 Case 标题')
      sessions.get(input.request.sessionId).inputs.push(input.request.content[0].text)
      return reply({ accepted: true })
    }
    if (method.startsWith('session.export')) {
      const id = new URL(request.url, 'http://localhost').searchParams.get('sessionId')
      const session = sessions.get(id)
      const events = [{ type: 'session/title', data: { title: session.title, source: { kind: 'user' }, messageSeqs: [] } }, ...session.inputs.flatMap((text, index) => [
        { type: 'user/message', data: { id: `message-${index}`, source: { kind: 'user' }, content: [{ type: 'text', text }] } },
        { type: 'request/header', data: { header: { config: { provider: 'test', model: 'test', reasoningEffort: 'off' }, tools: [] } } },
        { type: 'tool/call', data: { callId: `call-${index}`, name: 'read', arguments: '{}' } },
        ...(failure === 'partial' ? [] : [
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成' }] } } },
          { type: 'turn/end', data: { reason: { kind: 'completed' }, turn: index } },
        ]),
      ])]
      response.end(Buffer.from(zipSync({ 'session.jsonl': strToU8(events.map(event => JSON.stringify(event)).join('\n') + '\n') })))
      return
    }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const payload = { auth_url: `http://127.0.0.1:${server.address().port}/assistant/`, workspace: '/work/harness/workspace',
    preset_id: 'test-agent', judge_preset_id: 'evaluation-judge', timeout_ms: 1000, evidence_root: evidence,
    cases: [{ case_id: 'U-CASE-001', inputs: ['请检查'], expected_behavior: '返回结果' }] }
  const proc = spawn(process.execPath, [join(directory, 'dsh-eval-api.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  proc.stdout.on('data', chunk => { stdout += chunk })
  proc.stderr.on('data', chunk => { stderr += chunk })
  const completed = new Promise(resolve => proc.on('close', code => resolve({ code, stdout, stderr })))
  proc.stdin.end(JSON.stringify(payload))
  t.after(() => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  return { proc, completed, evidence, checks: () => JSON.parse(readFileSync(join(evidence, 'U-CASE-001/checks.json'), 'utf8')) }
}

for (const [failure, stage, session] of [
  ['session/create', 'target-session-create', null],
  ['session/prompt', 'target-prompt', 'session-1'],
  ['session/list', 'target-session-verify', 'session-1'],
  ['session/rename', 'target-session-verify', 'session-1'],
  ['session.export', 'target-trace-export', 'session-1'],
  ['evaluation.wait', 'target-trace-export', 'session-1'],
]) test(`API ${failure} 失败保留阶段、请求和已创建的 Session`, async t => {
  const fx = await fixture(t, failure)
  const result = await fx.completed
  assert.equal(result.code, 0, result.stderr)
  const row = JSON.parse(result.stdout).rows[0]
  assert.equal(row.failure_reason, `api-${stage}-failed`)
  assert.equal(fx.checks().failure_stage, stage)
  assert.equal(fx.checks().http_status, 503)
  assert.equal(fx.checks().session_id ?? null, session)
  if (stage === 'target-prompt' || stage === 'target-trace-export') assert.match(fx.checks().request_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(JSON.parse(readFileSync(join(fx.evidence, 'U-CASE-001/case-result.json'), 'utf8')), row)
})

test('独立评审创建失败保留业务回答和失败阶段，不伪造业务失败', async t => {
  const fx = await fixture(t, 'judge-create')
  const result = await fx.completed
  assert.equal(result.code, 0, result.stderr)
  const row = JSON.parse(result.stdout).rows[0]
  assert.equal(row.execution_status, 'completed')
  assert.equal(row.verdict, 'inconclusive')
  assert.equal(fx.checks().judge.failure_stage, 'judge-session-create')
  assert.equal(fx.checks().judge.http_status, 503)
  assert.match(readFileSync(join(fx.evidence, 'U-CASE-001/response.json'), 'utf8'), /完成/)
})

test('API 尚未完成的部分轨迹在外部取消前已落盘', async t => {
  const fx = await fixture(t, 'partial')
  const trace = join(fx.evidence, 'U-CASE-001/trace.jsonl')
  const deadline = Date.now() + 5000
  while ((!existsSync(trace) || !readFileSync(trace, 'utf8').includes('tool/call')) && Date.now() < deadline) await delay(20)
  assert.match(readFileSync(trace, 'utf8'), /tool\/call/)
  assert.equal(fx.checks().session_id, 'session-1')
  fx.proc.kill('SIGTERM')
  await fx.completed
  assert.match(readFileSync(trace, 'utf8'), /tool\/call/)
})
