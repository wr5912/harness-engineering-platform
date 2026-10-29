import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createPlatformUpdates, PLATFORM_DOMAINS } from '../src/realtime/client.ts'
import { createPlatformEvents } from '../src/realtime/index.ts'

const encoder = new TextEncoder()
const frame = (revision, domains, ids = []) => `data: ${JSON.stringify({ revision, domains, ids })}\n\n`

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await delay(1)
  }
  assert.fail('事件流未完成预期的状态转换')
}

function connection() {
  const requests = [], streams = []
  let generationListener, generationDisposals = 0
  const updates = createPlatformUpdates({ generation: { subscribe(listener) {
    generationListener = listener
    return () => { generationDisposals++; generationListener = undefined }
  } } }, { retryMs: 0, fetch: async (url, init) => {
    assert.equal(url, 'api/harness-platform/events')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.method ?? 'GET', 'GET')
    assert.equal(init.body, undefined)
    let controller
    const body = new ReadableStream({ start(value) { controller = value } })
    // 与原生 fetch 一样，取消请求会打断挂起的 body.read。
    init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
    requests.push({ url, signal: init.signal })
    streams.push({ body, send: text => controller.enqueue(encoder.encode(text)), close: () => controller.close() })
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  } })
  return { updates, requests, streams, generation: () => generationListener?.(), disposals: () => generationDisposals }
}

test('事件流跨 chunk 解析 CRLF 帧，忽略未知领域、非法标识和无效 JSON', async t => {
  const fixture = connection()
  const seen = []
  fixture.updates.subscribe(() => seen.push(fixture.updates.getSnapshot()))
  t.after(() => fixture.updates.stop())
  fixture.updates.start()
  await until(() => fixture.streams[0]?.body.locked)
  const stream = fixture.streams[0]
  const first = frame(1, ['agents'], ['EXP-mock-001']).replaceAll('\n', '\r\n')
  const boundary = first.indexOf('\r\n') + 1
  stream.send(first.slice(0, 13))
  stream.send(first.slice(13, boundary))
  assert.equal(fixture.updates.getSnapshot().connected, false)
  stream.send(first.slice(boundary))
  await until(() => fixture.updates.getSnapshot().connected)
  assert.deepEqual(seen[0].domains, PLATFORM_DOMAINS)
  assert.deepEqual(seen[0].ids, ['EXP-mock-001'])
  stream.send(': keepalive\n\n' + frame(2, ['unknown-domain'])
    + 'data: invalid-json\n\n' + frame(3, ['mcp'], ['invalid id'])
    + frame(4, ['mcp'], ['mock-soc-readonly']))
  await until(() => seen.length === 2)
  assert.deepEqual(seen[1].domains, ['mcp'])
  assert.deepEqual(seen[1].ids, ['mock-soc-readonly'])
  assert.equal(fixture.requests.length, 1)
})

test('事件流重连使所有页面失效，stop 中断读取、释放锁和订阅且不重试业务', async () => {
  const fixture = connection()
  const { updates, streams, requests } = fixture
  try {
    updates.start()
    await until(() => streams[0]?.body.locked)
    streams[0].send(frame(1, ['agents']))
    await until(() => updates.getSnapshot().connected)
    streams[0].send(frame(2, ['mcp']))
    await until(() => updates.getSnapshot().domains.length === 1)
    streams[0].close()
    await until(() => streams[1]?.body.locked)
    assert.equal(streams[0].body.locked, false)
    assert.equal(updates.getSnapshot().connected, false)
    streams[1].send(frame(3, ['instances'], ['mock-instance']))
    await until(() => updates.getSnapshot().connected)
    assert.deepEqual(updates.getSnapshot().domains, PLATFORM_DOMAINS)
    assert.deepEqual(updates.getSnapshot().ids, ['mock-instance'])
    fixture.generation()
    assert.deepEqual(updates.getSnapshot().domains, PLATFORM_DOMAINS)
    assert.equal(requests.length, 2)
    updates.stop()
    await until(() => !streams[1].body.locked)
    assert.equal(requests[1].signal.aborted, true)
    assert.equal(fixture.disposals(), 1)
    assert.equal(updates.getSnapshot().connected, false)
    await delay(5)
    assert.equal(requests.length, 2)
  } finally { updates.stop() }
})

test('服务端通知仅含领域与稳定 ID，请求取消后释放 SSE 监听', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = createPlatformEvents('/tmp/platform-events-readonly-test', { docker: false })
  t.after(() => events.dispose())
  const abort = new AbortController()
  const response = await events.fetch(new Request('http://fixture.local/api/harness-platform/events', { signal: abort.signal }))
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  const reader = response.body.getReader()
  const decode = result => JSON.parse(new TextDecoder().decode(result.value).match(/^data: (.*)$/m)[1])
  assert.deepEqual(decode(await reader.read()).domains, PLATFORM_DOMAINS)
  const next = reader.read()
  events.notify(['mcp'], ['mock-soc-readonly', '../private-file', 'unreturned file content'])
  t.mock.timers.tick(100)
  assert.deepEqual(decode(await next), { revision: 1, domains: ['mcp'], ids: ['mock-soc-readonly'] })
  abort.abort()
  assert.equal((await reader.read()).done, true)
  // 若取消未移除监听，后续通知会向关闭的 controller 写入并抛错。
  events.notify(['instances'], ['mock-instance'])
  assert.doesNotThrow(() => t.mock.timers.tick(100))
  reader.releaseLock()
  assert.equal(response.body.locked, false)
})


test('独立工作区版本声明和组合变更均通知，忽略原生HOME内容', async t => {
  const root = mkdtempSync(join(tmpdir(), 'workspace events '))
  for (const folder of ['config', 'evolution/experiments/EXP-demo-001/candidate', '.local/instances/basic/dsh-home']) mkdirSync(join(root, folder), { recursive: true })
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-events', legacyRoots: [] }))
  writeFileSync(join(root, 'evolution/experiments/EXP-demo-001/candidate/harness.yaml'), '{}')
  writeFileSync(join(root, 'config/mcp-compositions.json'), '{}')
  const events = createPlatformEvents(root, { docker: false, stateRoot: join(root, '.local/instances') })
  events.start()
  t.after(() => { events.dispose(); rmSync(root, { recursive: true, force: true }) })
  const abort = new AbortController()
  const response = await events.fetch(new Request('http://fixture.local/events', { signal: abort.signal }))
  const reader = response.body.getReader()
  t.after(() => { abort.abort(); reader.releaseLock() })
  await reader.read()
  const readChange = async path => {
    writeFileSync(join(root, path), JSON.stringify({ changed: path }))
    const data = await Promise.race([reader.read(), delay(3000).then(() => { throw new Error('工作区配置变更通知超时') })])
    return JSON.parse(new TextDecoder().decode(data.value).match(/^data: (.*)$/m)[1])
  }
  assert.ok((await readChange('config/mcp-compositions.json')).domains.includes('mcp'))
  assert.ok((await readChange('evolution/experiments/EXP-demo-001/candidate/harness.yaml')).domains.includes('catalog'))
  writeFileSync(join(root, '.local/instances/basic/dsh-home/session.json'), '{}')
  let notified = false
  const pending = reader.read().then(() => { notified = true })
  await delay(200)
  assert.equal(notified, false)
  abort.abort()
  await pending
})

test('持续通知按最小间隔合并，不把每次写入放大成一帧', async t => {
  const events = createPlatformEvents('/tmp/platform-events-throttle-test', { docker: false, minIntervalMs: 300 })
  t.after(() => events.dispose())
  const abort = new AbortController()
  const response = await events.fetch(new Request('http://fixture.local/events', { signal: abort.signal }))
  const reader = response.body.getReader()
  t.after(() => { abort.abort(); reader.releaseLock() })
  const decode = result => JSON.parse(new TextDecoder().decode(result.value).match(/^data: (.*)$/m)[1])
  await reader.read()
  const startedAt = Date.now()
  events.notify(['agents'])
  assert.deepEqual(decode(await reader.read()).domains, ['agents'])
  assert.ok(Date.now() - startedAt >= 90, '首次通知保留 100ms 合并窗口')
  events.notify(['mcp']); events.notify(['instances'])
  const merged = decode(await reader.read())
  assert.ok(Date.now() - startedAt >= 300, '最小间隔内不得发送第二帧')
  assert.deepEqual(new Set(merged.domains), new Set(['mcp', 'instances']))
})

test('Run 延迟清单和完成摘要通知列表，高频轨迹不触发刷新', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform run events '))
  const runs = join(root, 'evolution/experiments/EXP-demo-001/runs')
  mkdirSync(runs, { recursive: true })
  const events = createPlatformEvents(root, { docker: false, minIntervalMs: 100 })
  let count = 0
  const unsubscribe = events.subscribe(() => { count++ })
  events.start()
  t.after(() => { unsubscribe(); events.dispose(); rmSync(root, { recursive: true, force: true }) })
  const run = join(runs, 'run-11111111-1111-4111-8111-111111111111')
  mkdirSync(join(run, 'evidence/U-1'), { recursive: true })
  await until(() => count === 1)
  await delay(150)
  count = 0
  writeFileSync(join(run, 'evidence/U-1/checks.json'), '{}')
  writeFileSync(join(run, 'evidence/U-1/trace.jsonl'), '{}')
  await delay(600)
  assert.equal(count, 0, 'Run 内部证据写入不得触发 agents/catalog 失效')
  for (const file of ['run.yaml', 'summary.json', 'inputs.lock.json', 'analysis.json']) {
    writeFileSync(join(run, file), '{}')
    await until(() => count > 0)
    await delay(150)
    count = 0
  }
  mkdirSync(join(runs, 'run-22222222-2222-4222-8222-222222222222'))
  await until(() => count === 1)
})
