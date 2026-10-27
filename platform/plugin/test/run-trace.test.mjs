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
