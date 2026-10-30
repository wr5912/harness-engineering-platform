import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const built = mkdtempSync(join(tmpdir(), 'run-trace-build-'))
await build({ entryPoints: [new URL('../src/evaluation/trace.ts', import.meta.url).pathname], outfile: join(built, 'trace.mjs'), bundle: true, platform: 'node', format: 'esm' })
const api = await import(`file://${join(built, 'trace.mjs')}`)
const runId = 'run-11111111-1111-4111-8111-111111111111'
const relativeRun = `evolution/experiments/EXP-alpha-001/runs/${runId}`
const hash = value => createHash('sha256').update(value).digest('hex')
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'run-trace-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  write(join(root, relativeRun, 'run.yaml'), `run_id: ${runId}\nstatus: completed\n`)
  write(join(root, relativeRun, 'inputs.lock.json'), JSON.stringify({ evaluation_cases: [{ case_id: 'C-1' }] }))
  write(join(root, relativeRun, 'evidence/C-1/checks.json'), JSON.stringify({ trace_available: true }))
  const path = `${relativeRun}/evidence/C-1/trace.jsonl`
  return { root, path, file: join(root, path), base: join(root, relativeRun) }
}
const row = (type, data = {}, seq = 1, session_log = 'root.jsonl') => ({ session_log, event: { type, seq, data } })
const encode = rows => rows.map(item => JSON.stringify(item)).join('\n') + '\n'
const parse = rows => api.parseTraceText(encode(rows), { path: 'evidence/C-1/trace.jsonl', role: 'target', collection_status: 'available' })
const user = text => ({ source: { kind: 'user' }, id: `user-${text}`, content: [{ type: 'text', text }] })
const answer = text => ({ message: { role: 'assistant', content: [{ type: 'text', text }] } })

test('逐行分页覆盖 64 KiB 后的尾部，坏行和超大行显式保留，原件与摘要保持不变', async t => {
  const f = fixture(t)
  const raw = [JSON.stringify(row('user/message', user('正常输入'))), ...Array.from({ length: 180 }, (_, index) => JSON.stringify(row('fixture/unknown', { body: 'x'.repeat(800), index }, index + 2))), '{broken', JSON.stringify(row('user/message', user('a'.repeat(140 * 1024)))), JSON.stringify(row('turn/end', { tail: '末尾仍然可读', token: 'fixture-secret-value' }, 200))].join('\n') + '\n'
  write(f.file, raw)
  const events = []
  let cursor = 0, pages = 0, sha
  do {
    const page = await api.readRunTrace(f.root, { run_id: runId, path: f.path, cursor, limit: 31, ...(sha ? { source_sha256: sha } : {}) })
    assert.equal(page.source.role, 'target')
    assert.equal(page.total_lines, 184)
    sha = page.source_sha256
    events.push(...page.events); cursor = page.next_cursor; pages++
  } while (cursor !== null)
  assert.ok(pages > 2)
  assert.equal(events.length, 184)
  assert.equal(new Set(events.map(event => event.ref.line)).size, 184)
  assert.equal(events.at(-3).status, 'malformed')
  assert.equal(events.at(-2).status, 'oversized')
  assert.equal(events[1].status, 'unknown')
  assert.match(JSON.stringify(events.at(-1)), /末尾仍然可读/)
  assert.equal(JSON.stringify(events).includes('fixture-secret-value'), false)
  assert.equal(events[0].ref.line_sha256, hash(raw.split('\n')[0]))
  assert.equal(sha, hash(raw))
  assert.equal(readFileSync(f.file, 'utf8'), raw)
})

test('来源角色依赖冻结 Case 和真实采集副文件，未知和子 Session 不冒充目标', async t => {
  const f = fixture(t)
  write(f.file, encode([row('user/message', user('hello')), row('request/header'), row('tool/call', { callId: 'a', name: 'read', arguments: '{}' }), row('user/message', user('child'), 1, 'descendants/child.jsonl'), row('request/header', {}, 2, 'descendants/child.jsonl'), row('tool/call', { callId: 'b', name: 'read', arguments: '{}' }, 3, 'descendants/child.jsonl')]))
  write(join(f.base, 'evidence/C-1/judge-trace.jsonl'), encode([row('turn/end')]))
  write(join(f.base, 'evidence/C-1/judge.json'), '{"checks":{"session_id":"judge"}}')
  write(join(f.base, 'evidence/analysis/scene-01/attempt-01/trace.jsonl'), encode([row('turn/end')]))
  write(join(f.base, 'evidence/analysis/scene-01/attempt-01/checks.json'), '{"operation":"review","trace_available":true}')
  write(join(f.base, 'evidence/unknown/trace.jsonl'), encode([row('turn/end')]))
  const files = await api.listRunTraceSources(f.root, runId)
  assert.deepEqual(files.map(file => file.role).sort(), ['analysis', 'judge', 'target', 'unknown'])
  assert.equal((await api.loadRunTrace(f.root, { run_id: runId })).source.path, f.path, '默认先展示目标轨迹，不能按文件名字典序先展示 judge')
  const loaded = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  const decisions = api.buildDecisionSlices(loaded.events)
  assert.equal(decisions[0].role, 'target'); assert.equal(decisions[0].eligible, true)
  assert.equal(decisions[1].role, 'unknown'); assert.equal(decisions[1].eligible, false)
  assert.equal(JSON.stringify(decisions[0].state).includes('child'), false)
  write(join(f.base, 'evidence/C-1/checks.json'), '{"trace_available":false}')
  assert.equal(api.buildDecisionSlices((await api.loadRunTrace(f.root, { run_id: runId, path: f.path })).events)[0].eligible, false)
})

test('同批并行工具共用请求前缀，保留注入来源，排除当前模型动作与未来结果', () => {
  const rows = parse([
    row('user/message', user('用户当前任务'), 1),
    row('user/message', { source: { kind: 'context' }, content: [{ type: 'text', text: '不应混入用户输入的系统上下文' }] }, 2),
    row('step/start', { turn: 1, step: 1 }, 3),
    row('request/header', { header: { config: { model: 'fixture' }, tools: [{ name: 'read' }, { name: 'inspect' }] } }, 4),
    row('assistant/message', { message: { content: [{ type: 'text', text: '当前模型输出' }, { type: 'tool-call', toolName: 'read' }] } }, 5),
    row('tool/call', { callId: 'a', name: 'read', arguments: '{"path":"basic.txt"}' }, 6),
    row('tool/call', { callId: 'b', name: 'inspect', arguments: '{}' }, 7),
    row('tool/result', { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'text', text: '未来结果A' }] } }, 8),
    row('tool/result', { message: { source: { kind: 'tool', callId: 'b' }, content: [{ type: 'text', text: '未来结果B' }] } }, 9),
    row('step/start', { turn: 1, step: 2 }, 10),
    row('request/header', { header: { config: { model: 'fixture' }, tools: [] } }, 11),
    row('assistant/message', answer('最终回答'), 12),
  ])
  const [a, b, final] = api.buildDecisionSlices(rows)
  assert.equal(a.context_mode, 'reconstructed')
  assert.deepEqual(a.state, b.state)
  assert.deepEqual(a.context_refs, b.context_refs)
  assert.equal(a.eligible, true)
  assert.equal(JSON.stringify(a.state).includes('当前模型输出'), false)
  assert.equal(JSON.stringify(a.state).includes('未来结果'), false)
  assert.equal(JSON.stringify(a.state).includes('系统上下文'), true)
  assert.equal(a.state.messages[1].source.kind, 'context')
  assert.ok(a.context_refs.every(ref => ref.line < a.anchor.line))
  assert.equal(a.outcome.result.message.content[0].text, '未来结果A')
  assert.ok(JSON.stringify(final.state).includes('未来结果A'))
  assert.equal(JSON.stringify(final.state).includes('最终回答'), false)
})

test('优先实际请求 messages，事件流不按时间排序混入其他 Session，坏行使后继训练候选失效', () => {
  const rows = parse([
    row('user/message', user('重建输入'), 1),
    row('request/header', { header: { config: { model: 'actual' }, tools: [{ name: 'read' }], messages: [{ role: 'system', content: '实际系统上下文' }, { role: 'user', content: '实际用户请求' }] } }, 2),
    row('tool/call', { name: 'read', callId: 'a', arguments: '{}' }, 3),
    row('tool/result', { message: { source: { kind: 'tool', callId: 'a' }, content: '其他Session结果' } }, 1, 'descendants/child.jsonl'),
    row('tool/result', { message: { source: { kind: 'tool', callId: 'a' }, content: '本Session结果' } }, 4),
  ])
  const decision = api.buildDecisionSlices(rows)[0]
  assert.equal(decision.context_mode, 'actual_request')
  assert.equal(decision.state.messages[1].content, '实际用户请求')
  assert.equal(decision.outcome.result.message.content, '本Session结果')
  const bad = api.parseTraceText(encode([row('user/message', user('hi')), row('request/header')]) + '{bad}\n' + encode([row('tool/call', { name: 'read', callId: 'a' })]), { path: 'trace.jsonl', role: 'target' })
  assert.equal(api.buildDecisionSlices(bad)[0].eligible, false)
})

test('实际请求保留渐进加载的 Skill 来源与正文，排除提供方私有回放状态', () => {
  const messages = [
    { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: 'inspection: 巡检技能目录' },
    { role: 'user', source: { kind: 'user' }, content: '执行巡检' },
    { role: 'user', source: { kind: 'instructions', form: 'instructions', path: 'SKILL.md' }, content: '必须先查目录' },
    { role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture', replayState: { hidden: 'PRIVATE_REPLAY' } }, content: '已加载' },
  ]
  const [slice] = api.buildDecisionSlices(parse([row('request/header', { header: { messages } }, 0), row('tool/call', { name: 'list', callId: 'a' }, 1)]))
  assert.equal(slice.context_mode, 'actual_request')
  assert.equal(slice.state.messages[0].source.form, 'catalog')
  assert.equal(slice.state.messages[2].source.path, 'SKILL.md')
  assert.equal(slice.state.messages[2].content, '必须先查目录')
  assert.equal(JSON.stringify(slice.state).includes('PRIVATE_REPLAY'), false)
})

test('DSH surface 按决策时刻保留 Skill 目录、已加载正文及工具变更，替换后不复活旧正文', () => {
  const events = [
    { type: 'user/message', data: { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: 'inspection: 巡检技能目录' }] }, surfaceOp: 'append' },
    { type: 'user/message', data: { role: 'user', ...user('执行巡检') }, surfaceOp: 'append' },
    { type: 'request/header', data: { header: { tools: [{ name: 'skill' }] } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 's', name: 'skill', arguments: '{}' }] } }, surfaceOp: 'append' },
    { type: 'tool/call', data: { callId: 's', name: 'skill', arguments: '{}' } },
    { type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 's' }, content: [{ type: 'text', text: '<skill_content name="inspection">SKILL_BODY_V1</skill_content>' }] } }, surfaceOp: 'append', sourceEventSeqs: [4] },
    { type: 'developer/message', data: { message: { role: 'developer', content: [{ type: 'tool-removal', toolName: 'skill' }] } }, surfaceOp: 'append' },
    { type: 'request/header', data: { header: { tools: [{ name: 'list' }] } } },
    { type: 'tool/call', data: { callId: 'l', name: 'list', arguments: '{}' } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'context', form: 'notice', summary: '正文已压缩' }, content: [{ type: 'text', text: 'SKILL_SUMMARY' }] }, surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 }, sourceEventSeqs: [5] },
    { type: 'request/header', data: { header: {} } },
    { type: 'assistant/message', data: answer('结束'), surfaceOp: 'append' },
  ]
  const slices = source => api.buildDecisionSlices(parse(source.map((event, seq) => ({ session_log: 'root.jsonl', event: { ...event, seq } }))))
  const input = slice => ({ ...slice.state, messages: slice.state.messages.map(({ ref, ...message }) => message) })
  const [first, loaded, replaced] = slices(events)
  assert.ok([first, loaded, replaced].every(slice => slice.eligible))
  assert.equal(first.state.messages[0].source.kind, 'skill-catalog')
  assert.equal(JSON.stringify(first.state).includes('SKILL_BODY'), false)
  assert.equal(JSON.stringify(loaded.state).includes('SKILL_BODY_V1'), true)
  assert.equal(loaded.state.messages.at(-1).content[0].type, 'tool-removal')
  assert.deepEqual(loaded.state.available_tools, [{ name: 'list' }])
  assert.equal(JSON.stringify(replaced.state).includes('SKILL_BODY'), false)
  assert.equal(JSON.stringify(replaced.state).includes('SKILL_SUMMARY'), true)
  const changed = structuredClone(events)
  changed[5].data.message.content[0].text = 'SKILL_BODY_V2'
  assert.deepEqual(input(slices(changed)[0]), input(first))
  assert.notDeepEqual(input(slices(changed)[1]), input(loaded))
  assert.deepEqual(input(slices(changed)[2]), input(replaced))
  const invalid = structuredClone(events)
  invalid[9].sourceEventSeqs = [4]
  assert.equal(slices(invalid)[0].eligible, true)
  assert.equal(slices(invalid)[2].eligible, false)
  assert.match(slices(invalid)[2].limitations.join(' '), /surface 合同/)
  const empty = structuredClone(events)
  empty[9] = { type: 'developer/message', data: { message: { role: 'developer', content: [] } }, surfaceOp: { op: 'replace', startSeq: 5, endSeq: 5 }, sourceEventSeqs: [5] }
  assert.equal(JSON.stringify(slices(empty)[2].state).includes('SKILL_BODY'), false)
})

test('请求头之后的原生工具加载和 Skill 上下文进入当前输入，当前输出不进入', () => {
  const events = [
    { type: 'user/message', data: { role: 'user', ...user('执行巡检') }, surfaceOp: 'append' },
    { type: 'request/header', data: { header: { tools: [{ name: 'skill', description: '读取 Skill', parameters: { type: 'object' } }] } } },
    { type: 'developer/message', data: { headerSeq: 1, message: { role: 'developer', content: [{ type: 'tool-addition', toolName: 'skill' }] } }, surfaceOp: 'append' },
    { type: 'user/message', data: { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text: 'VISIBLE_SKILL_CATALOG' }] }, surfaceOp: 'append' },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 's', name: 'skill', arguments: '{"name":"inspection"}' }] } }, surfaceOp: 'append' },
    { type: 'tool/call', data: { callId: 's', name: 'skill', arguments: '{"name":"inspection"}' } },
  ]
  const [slice] = api.buildDecisionSlices(parse(events.map((event, seq) => ({ session_log: 'root.jsonl', event: { ...event, seq } }))))
  assert.equal(slice.eligible, true)
  assert.equal(slice.state.messages[1].content[0].type, 'tool-addition')
  assert.equal(slice.state.messages[2].source.kind, 'skill-catalog')
  assert.equal(JSON.stringify(slice.state).includes('VISIBLE_SKILL_CATALOG'), true)
  assert.equal(slice.state.messages.some(message => message.role === 'assistant'), false)
})

test('历史工具选择只保留一次，保留并行工具结果的 callId 关联，思维块不进入输入', () => {
  const rows = parse([
    row('user/message', user('基础巡检'), 1),
    row('step/start', { step: 1 }, 2),
    row('request/header', { header: { tools: [{ name: 'list' }] } }, 3),
    row('assistant/message', { message: { content: [{ type: 'thinking', text: '隐式思维不应进入样本' }, { type: 'tool-call', id: 'a', name: 'list', arguments: '{}' }, { type: 'tool-call', id: 'b', name: 'inspect', arguments: '{}' }] } }, 4),
    row('tool/call', { callId: 'a', name: 'list', arguments: '{}' }, 5),
    row('tool/result', { message: { source: { kind: 'tool', callId: 'a' }, content: [{ type: 'text', text: '列表结果' }] } }, 6),
    row('tool/call', { callId: 'b', name: 'inspect', arguments: '{}' }, 7),
    row('tool/result', { message: { source: { kind: 'tool', callId: 'b' }, content: [{ type: 'text', text: '巡检结果' }] } }, 8),
    row('step/start', { step: 2 }, 9),
    row('assistant/message', answer('基础任务完成'), 10),
  ])
  const [a, b, final] = api.buildDecisionSlices(rows)
  assert.deepEqual(a.state.messages, b.state.messages)
  assert.equal(JSON.stringify(a.state).includes('列表结果'), false)
  assert.equal(final.state.messages.filter(message => message.role === 'assistant').length, 1)
  assert.deepEqual(final.state.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['a', 'b'])
  assert.equal(JSON.stringify(final.state).includes('隐式思维'), false)
  const actual = parse([row('request/header', { header: { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list', arguments: '{}' } }] }, { role: 'tool', content: '已完成', tool_call_id: 'a', name: 'list' }] } }), row('assistant/message', answer('已完成'))])
  const slice = api.buildDecisionSlices(actual)[0]
  assert.equal(slice.state.messages[0].tool_calls[0].id, 'a')
  assert.equal(slice.state.messages[1].tool_call_id, 'a')
  assert.equal(slice.state.messages[1].name, 'list')
})

test('轮次结束后不复用上一轮请求作为新任务截点，缺边界时不进入训练候选', () => {
  const rows = parse([row('user/message', user('旧任务')), row('request/header'), row('assistant/message', answer('旧回答')), row('turn/end'), row('user/message', user('新任务')), row('tool/call', { name: 'read', callId: 'new', arguments: '{}' })])
  const next = api.buildDecisionSlices(rows).at(-1)
  assert.equal(next.request_ref, null)
  assert.equal(next.eligible, false)
  assert.ok(JSON.stringify(next.state).includes('新任务'))
  assert.match(next.limitations.join(' '), /保守截点/)
})

test('源变化、文件上限、路径越界、符号链接和取消均明确拒绝，不回退到预览', async t => {
  const f = fixture(t)
  write(f.file, encode([row('turn/end')]))
  const first = await api.readRunTrace(f.root, { run_id: runId })
  write(f.file, encode([row('turn/end', { changed: true })]))
  await assert.rejects(() => api.readRunTrace(f.root, { run_id: runId, source_sha256: first.source_sha256 }), error => error.code === 'conflict')
  await assert.rejects(() => api.readRunTrace(f.root, { run_id: runId, path: '../../outside/trace.jsonl' }), error => error.code === 'not_found')
  truncateSync(f.file, 33 * 1024 * 1024)
  await assert.rejects(() => api.loadRunTrace(f.root, { run_id: runId }), error => error.code === 'file_too_large')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => api.readRunTrace(f.root, { run_id: runId }, controller.signal), error => error.code === 'aborted')
  await assert.rejects(() => api.readRunTrace(f.root, { run_id: runId, cursor: -1 }), error => error.code === 'invalid_request')
  write(join(f.root, 'outside.txt'), 'outside')
  symlinkSync(join(f.root, 'outside.txt'), join(f.base, 'evidence/linked.jsonl'))
  await assert.rejects(() => api.readRunTrace(f.root, { run_id: runId }), error => error.code === 'path_rejected')
})

test('没有 Session 轨迹返回采集缺口，不生成决策或伪造训练样本', async t => {
  const f = fixture(t)
  const page = await api.readRunTrace(f.root, { run_id: runId })
  assert.deepEqual(page.events, []); assert.deepEqual(page.decisions, [])
  assert.equal(page.next_cursor, null)
  assert.match(page.warnings[0], /未保存/)
})

test('界面页预算明确省略超大决策预览，完整切片函数仍保留原始上下文', async t => {
  const f = fixture(t)
  write(f.file, encode([...Array.from({ length: 20 }, (_, index) => row('user/message', user(`${index} ${'x'.repeat(10000)}`), index)), row('request/header', { header: { tools: [] } }, 30), row('assistant/message', answer('基本总结'), 31)]))
  const loaded = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  const complete = api.buildDecisionSlices(loaded.events)[0]
  assert.equal(complete.eligible, true)
  assert.ok(Buffer.byteLength(JSON.stringify(complete.state)) > 128 * 1024)
  const page = await api.readRunTrace(f.root, { run_id: runId, path: f.path, cursor: 21 })
  assert.equal(page.decisions[0].eligible, false)
  assert.deepEqual(page.decisions[0].state.messages, [])
  assert.match(page.decisions[0].limitations.at(-1), /界面单页预算/)
  assert.ok(Buffer.byteLength(JSON.stringify({ events: page.events, decisions: page.decisions })) < 256 * 1024)
})


test('来源集合固定身份、冻结Case、采集副文件以及不存在状态，trace不变也能识别依赖变化', async t => {
  const f = fixture(t)
  write(f.file, encode([row('user/message', user('当前任务')), row('request/header'), row('tool/call', { callId: 'a', name: 'read', arguments: '{}' })]))
  const before = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  assert.deepEqual(before.source_bundle.issues, [])
  assert.equal(before.source_bundle.files.length, 6)
  assert.equal(before.source_bundle.files.find(file => file.path.endsWith('/run.json')).source_sha256, null)
  assert.equal(before.source_bundle.files.find(file => file.path.endsWith('/judge.json')).source_sha256, null)
  write(join(f.base, 'evidence/C-1/judge.json'), '{}')
  const added = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  assert.equal(added.source_sha256, before.source_sha256)
  assert.notEqual(added.source_bundle.sha256, before.source_bundle.sha256)
  write(join(f.base, 'inputs.lock.json'), JSON.stringify({ evaluation_cases: [{ case_id: 'different' }] }))
  const changedCase = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  assert.equal(changedCase.source.role, 'unknown')
  assert.match(changedCase.source_bundle.issues.join(' '), /目标智能体 Case/)
  write(join(f.base, 'run.yaml'), 'run_id: run-22222222-2222-4222-8222-222222222222\nstatus: running\n')
  write(join(f.base, 'evidence/C-1/checks.json'), '{}')
  const invalid = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  assert.match(invalid.source_bundle.issues.join(' '), /run_id.*不一致/)
  assert.match(invalid.source_bundle.issues.join(' '), /尚未封存/)
  assert.match(invalid.source_bundle.issues.join(' '), /没有确认可用/)
})

function delegatedRows() {
  const rootId = 'root-bound-session', childId = 'child-bound-session', rootLog = 'session.v4.jsonl'
  const childLog = `subagents/${childId}/session.v4.jsonl`, prompt = '只查询资产A的已有状态。', delegatedText = `${prompt}\n回传给父智能体，不执行写入。`
  const native = (log, event) => ({ session_log: log, event })
  const headers = [native(rootLog, { type: 'session', version: 4, id: rootId, createdAt: 100, delegationDepth: 0, isSeeded: false, agentPreset: 'alpha' })]
  const parent = [
    row('user/message', { role: 'user', ...user('真人根任务：调查资产A，不授权执行。') }, 0, rootLog),
    row('request/header', { header: { messages: [{ role: 'user', source: { kind: 'user' }, content: '真人根任务：调查资产A，不授权执行。' }], tools: [{ name: 'delegate_fault_analysis' }] } }, 1, rootLog),
    row('tool/call', { callId: 'delegate-call', name: 'delegate_fault_analysis', arguments: JSON.stringify({ prompt }) }, 2, rootLog),
    row('subagent/catalog', { version: 0, childId, childCreatedAt: 200, mode: 'continuable', label: '只读调查' }, 3, rootLog),
    row('tool/result', { message: { role: 'tool', source: { kind: 'tool', callId: 'delegate-call' }, toolCallId: 'delegate-call', content: [{ type: 'text', text: `started subagent ${childId}` }], isError: false } }, 4, rootLog),
  ]
  const child = [
    native(childLog, { type: 'session', version: 4, id: childId, createdAt: 200, parentSession: rootId, delegationDepth: 1, isSeeded: false, origin: 'subagent', agentPreset: 'alpha-readonly' }),
    row('agent-preset/selected', { agentPreset: 'alpha-readonly' }, 0, childLog),
    row('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: '只读调查' }, 1, childLog),
    native(childLog, { type: 'user/message', seq: 2, data: { role: 'user', ...user(delegatedText) }, surfaceOp: 'append' }),
    row('step/start', { turn: 1, step: 1 }, 3, childLog),
    row('request/header', { header: { config: { provider: 'fixture', model: 'fixture' }, tools: [{ name: 'read_asset', parameters: { type: 'object' } }] } }, 4, childLog),
    row('tool/call', { callId: 'read-call', name: 'read_asset', arguments: { id: 'asset-A' } }, 5, childLog),
    row('tool/result', { message: { role: 'tool', source: { kind: 'tool', callId: 'read-call' }, content: [{ type: 'text', text: 'FUTURE_ASSET_RESULT' }] } }, 6, childLog),
  ]
  return { rows: [...headers, ...parent, ...child], rootId, childId, rootLog, childLog, delegatedText }
}
function parseDelegated(value, extra = {}) {
  return api.parseTraceText(encode(value.rows), { path: 'evidence/C-1/trace.jsonl', role: 'target', collection_status: 'available',
    root_identity: { session_id: value.rootId, session_log: value.rootLog, agent_preset: 'alpha' }, ...extra })
}

test('可信采集根、父子header与委派callId回执共同恢复子决策，父任务不冒充真人且同源分组', () => {
  const value = delegatedRows(), raw = encode(value.rows)
  const [parent, child] = api.buildDecisionSlices(parseDelegated(value))
  assert.equal(parent.eligible, true); assert.equal(child.eligible, true)
  assert.equal(child.role, 'target')
  assert.equal(child.lineage.actor_session_id, value.childId)
  assert.equal(child.lineage.root_session_id, value.rootId)
  assert.equal(child.lineage.parent_session_id, value.rootId)
  assert.equal(child.lineage.delegation.call_id, 'delegate-call')
  assert.equal(child.lineage.delegation.task_content_sha256, hash(value.delegatedText))
  assert.equal(child.anchor.source_sha256, hash(raw), '不改写原始trace摘要')
  assert.equal(child.state.messages[0].content[0].text, value.delegatedText)
  assert.equal(child.state.messages[0].source.kind, 'subagent')
  assert.equal(child.state.messages[0].source.senderSessionId, value.rootId)
  assert.equal(child.state.messages[0].source.delegationCallId, 'delegate-call')
  assert.equal(JSON.stringify(child.state).includes('真人根任务'), false)
  assert.equal(JSON.stringify(child.state).includes('FUTURE_ASSET_RESULT'), false)
  assert.equal(child.source_group_id, `task-${hash(JSON.stringify(parent.state.messages[0].content).normalize('NFKC').replace(/\s+/g, ' ').trim()).slice(0, 24)}`)
  assert.equal(parent.source_group_id, undefined, '未受影响root不增加分组覆盖字段')
  assert.equal(child.outcome.refs.length, 1)
})

test('缺采集身份、错父子header、错catalog、错callId或伪任务不能靠subagents目录取得target身份', () => {
  const changes = [
    value => { value.rows[0].event.id = 'another-root' },
    value => { value.rows.find(row => row.session_log === value.childLog && row.event.type === 'session').event.parentSession = 'another-parent' },
    value => { value.rows.find(row => row.event.type === 'subagent/catalog').event.data.childId = 'another-child' },
    value => { value.rows.find(row => row.event.type === 'subagent/catalog').event.data.childCreatedAt++ },
    value => { value.rows.find(row => row.event.type === 'tool/result').event.data.message.source.callId = 'another-call' },
    value => { value.rows.find(row => row.event.type === 'subagent/descriptor').event.data.provider = 'unknown' },
    value => { value.rows.find(row => row.event.type === 'agent-preset/selected').event.data.agentPreset = 'another-preset' },
    value => { value.rows.find(row => row.session_log === value.childLog && row.event.type === 'user/message').event.data.content[0].text = '伪造的其他任务' },
    value => { value.rows = value.rows.filter(row => row.event.type !== 'subagent/catalog') },
    value => { value.rows.find(row => row.session_log === value.childLog && row.event.type === 'session').event.isSeeded = true },
  ]
  for (const change of changes) {
    const value = delegatedRows(); change(value)
    const child = api.buildDecisionSlices(parseDelegated(value)).at(-1)
    assert.equal(child.role, 'unknown'); assert.equal(child.eligible, false)
    assert.equal(child.lineage, undefined)
  }
  assert.equal(api.buildDecisionSlices(parseDelegated(delegatedRows(), { root_identity: undefined })).at(-1).role, 'unknown')
  for (const role of ['judge', 'analysis', 'unknown']) assert.equal(api.buildDecisionSlices(parseDelegated(delegatedRows(), { role })).at(-1).role, 'unknown')
  const flat = delegatedRows()
  flat.rows = flat.rows.filter(row => row.event.type !== 'subagent/catalog')
  for (const row of flat.rows) if (row.session_log === flat.childLog) row.session_log = 'orphan-flat.jsonl'
  assert.equal(api.buildDecisionSlices(parseDelegated(flat)).at(-1).role, 'unknown', '无可信链的flat日志也不能继承target')
})

test('可信子树仍按各自前缀完整性判断，不补未来结果或把未知执行写成成功', () => {
  const missing = delegatedRows()
  missing.rows.pop()
  const child = api.buildDecisionSlices(parseDelegated(missing)).at(-1)
  assert.equal(child.eligible, true, '完整前缀可保留已观察动作，不声称结果已取得')
  assert.equal(child.outcome.status, 'missing')
  assert.match(child.limitations.join(' '), /子工具结果未保存/)
  const bad = delegatedRows(), raw = encode(bad.rows)
  const childAt = raw.indexOf(JSON.stringify(bad.rows.find(row => row.session_log === bad.childLog && row.event.type === 'step/start')))
  const text = raw.slice(0, childAt) + '{broken}\n' + raw.slice(childAt)
  const parsed = api.parseTraceText(text, { path: 'evidence/C-1/trace.jsonl', role: 'target', collection_status: 'available', root_identity: { session_id: bad.rootId, session_log: bad.rootLog, agent_preset: 'alpha' } })
  assert.equal(api.buildDecisionSlices(parsed).at(-1).eligible, false)
})

test('实际Run来源使用checks固定根身份，未登记到冻结Case的来源不提升子树', async t => {
  const f = fixture(t), value = delegatedRows()
  write(f.file, encode(value.rows))
  write(join(f.base, 'evidence/C-1/checks.json'), JSON.stringify({ trace_available: true, session_id: value.rootId, root_session_log: value.rootLog, session_preset: 'alpha' }))
  const loaded = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  assert.equal(api.buildDecisionSlices(loaded.events).at(-1).eligible, true)
  write(join(f.base, 'evidence/C-1/checks.json'), JSON.stringify({ trace_available: true, session_id: 'wrong-root', root_session_log: value.rootLog, session_preset: 'alpha' }))
  assert.equal(api.buildDecisionSlices((await api.loadRunTrace(f.root, { run_id: runId, path: f.path })).events).at(-1).eligible, false)
})

test('单来源读取保持完整来源集合与决策，不枚举无关Case；仍核对角色、摘要和路径', async t => {
  const f = fixture(t)
  write(f.file, encode([row('user/message', user('读取当前巡检目录')), row('tool/call', { callId: 'read-current', name: 'list_inspections', arguments: {} }, 2)]))
  const catalog = await api.loadRunTrace(f.root, { run_id: runId, path: f.path })
  const selected = await api.loadRunTrace(f.root, { run_id: runId, path: f.path }, undefined, false)
  assert.deepEqual(selected.source_bundle, catalog.source_bundle)
  assert.deepEqual(selected.events, catalog.events)
  assert.deepEqual(selected.source, catalog.source)
  symlinkSync('/missing-unrelated-source', join(f.base, 'evidence/unrelated-case'))
  const withoutUnrelated = await api.loadRunTrace(f.root, { run_id: runId, path: 'evidence/C-1/trace.jsonl' }, undefined, false)
  assert.deepEqual(withoutUnrelated.source_bundle, catalog.source_bundle)
  await assert.rejects(() => api.loadRunTrace(f.root, { run_id: runId, path: f.path, source_sha256: '0'.repeat(64) }, undefined, false), /轨迹在读取期间发生变化/)
  await assert.rejects(() => api.loadRunTrace(f.root, { run_id: runId, path: 'inputs.lock.json' }, undefined, false), /不是 Session 轨迹/)
  await assert.rejects(() => api.loadRunTrace(f.root, { run_id: runId, path: '../outside/trace.jsonl' }, undefined, false), error => ['path_rejected', 'not_found'].includes(error.code))
})
