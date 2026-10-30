import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, waitForEvaluationTree } from './evaluation-wait.mts'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('只等待已有根Agent，不创建或恢复Session，无子任务时按原生稳定序列结束', async () => {
  const agent = { session: { seq: 4 }, status: 'idle', whenIdle: async () => {} }
  await waitForEvaluationTree({ agents: { get: id => id === 'root' ? agent : undefined }, get: () => undefined }, 'root', new AbortController().signal)
  await assert.rejects(waitForEvaluationTree({ agents: { get: () => undefined } }, 'absent', new AbortController().signal), /not-live/)
})

test('子任务完成回报后必须再等根后续回合，不能用根首次idle提前返回', async () => {
  const child = deferred(), root = deferred()
  let idleCalls = 0, childCalls = 0, done = false
  const agent = { session: { seq: 7 }, status: 'idle', whenIdle: async () => { if (++idleCalls > 1) await root.promise } }
  const ctx = { agents: { get: () => agent }, get: () => ({ waitForChildren: async () => { if (++childCalls === 1) { await child.promise; return true } return false } }) }
  const waiting = waitForEvaluationTree(ctx, 'root', new AbortController().signal).then(() => { done = true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(done, false)
  agent.status = 'running'; agent.session.seq++
  child.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false)
  assert.equal(idleCalls, 2)
  agent.status = 'idle'; agent.session.seq++
  root.resolve()
  await waiting
  assert.equal(done, true)
})

test('子任务查询期间根seq变化必须重查稳定边界，会话身份替换必须失败', async () => {
  let calls = 0
  const agent = { session: { seq: 1 }, status: 'idle', whenIdle: async () => {} }
  const ctx = { agents: { get: () => agent }, get: () => ({ waitForChildren: async () => { if (++calls === 1) agent.session.seq++; return false } }) }
  await waitForEvaluationTree(ctx, 'root', new AbortController().signal)
  assert.equal(calls, 2)
  const original = deferred(); let selected = agent
  agent.whenIdle = () => original.promise
  const wait = waitForEvaluationTree({ ...ctx, agents: { get: () => selected } }, 'root', new AbortController().signal)
  selected = { ...agent }; original.resolve()
  await assert.rejects(wait, /replaced/)
})

test('HTTP取消只停止等待，不取消业务Agent或伪造完成', async () => {
  const child = deferred(), controller = new AbortController()
  const agent = { session: { seq: 1 }, status: 'idle', whenIdle: async () => {} }
  const waiting = waitForEvaluationTree({ agents: { get: () => agent }, get: () => ({ waitForChildren: () => child.promise }) }, 'root', controller.signal)
  await Promise.resolve(); await Promise.resolve()
  controller.abort(new Error('request-cancelled'))
  await assert.rejects(waiting, /request-cancelled/)
  assert.equal(agent.status, 'idle')
  child.resolve(false)
})

test('通过原生connection注册只读等待入口，错误不泄露任意内部正文', async () => {
  let route
  const agent = { status: 'idle', session: { seq: 1 }, whenIdle: async () => { throw new Error('private internal failure') } }
  const ctx = { agents: { get: () => agent }, get: () => undefined,
    connection: { fetch: { register: value => { route = value } } } }
  apply(ctx)
  assert.equal(route.path, '/api/evaluation.wait')
  assert.deepEqual(route.methods, ['GET'])
  assert.equal((await route.fetch(new Request('http://runtime/api/evaluation.wait'))).status, 400)
  const response = await route.fetch(new Request('http://runtime/api/evaluation.wait?sessionId=root'))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'evaluation-wait-failed' })
})
