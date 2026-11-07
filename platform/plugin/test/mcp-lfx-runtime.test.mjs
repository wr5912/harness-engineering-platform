import assert from 'node:assert/strict'
import test from 'node:test'
import { lfxCallbacks } from '../src/mcp/lfx-runtime.ts'
import { compositionConfig, compositionVersionId, publishedCompositionService, publishCompositionVersion } from '../src/mcp/compositions.ts'
import { compositionReadonly } from '../src/mcp/definition.ts'

const context = () => ({ signal: new AbortController().signal, runId: 'test', nodeId: 'root', shared: { connection_fingerprints: { soc: 'fixed' } }, call: call => call(), progress() {} })

test('写入工作流的只读声明保存在固定版本及公开目录，原有巡检保持只读', () => {
  const read = compositionConfig({ kind: 'workflow', workflow: 'check', toolName: 'check', title: '检查', description: '' })
  const write = compositionConfig({ ...read, readonly: false })
  assert.equal(compositionReadonly(read), true)
  assert.equal(compositionReadonly(write), false)
  assert.notEqual(compositionVersionId(read), compositionVersionId(write))
  const entry = { id: 'check' }; publishCompositionVersion(entry, write)
  const service = publishedCompositionService({ compositions: [entry] })
  assert.equal(compositionReadonly(service.publishedTools[0]), false)
  assert.ok(service.builtinTools.every(compositionReadonly))
  assert.throws(() => compositionConfig({ ...write, readonly: 'false' }), /只读声明/)
})

test('写入失去回执不重试，相同参数的独立调用不合并，轮询读取新状态', async () => {
  let writes = 0, reads = 0
  const callback = lfxCallbacks({ connections: { soc: 'soc' } }, context(), async (connection, operation, args, signal, fingerprint) => {
    assert.equal(connection, 'soc'); assert.equal(fingerprint, 'fixed'); assert.equal(signal.aborted, false)
    if (operation === 'submit') { writes++; throw new Error('ECONNRESET') }
    return { state: ++reads }
  })
  const invoke = operation => callback({ action: 'invoke', connection: 'soc', operation, arguments: { id: 1 } })
  await assert.rejects(invoke('submit'), /ECONNRESET/)
  assert.equal(writes, 1)
  await assert.rejects(invoke('submit'), /ECONNRESET/)
  assert.equal(writes, 2)
  assert.deepEqual(await invoke('status'), { state: 1 })
  assert.deepEqual(await invoke('status'), { state: 2 })
  await assert.rejects(callback({ action: 'invoke', connection: 'other' }), /未绑定/)
  assert.equal(writes, 2)
})

test('TypeScript 组件按冻结模块与节点派发，等待组件不会占用上游并发额度', async () => {
  const ctx = context(), events = []
  ctx.progress = function (value) { events.push({ node: this.nodeId, value }) }
  const callback = lfxCallbacks({ connections: {} }, ctx, async () => assert.fail('不应调用上游'), {
    frozen: { echo: async (input, config, current) => { current.progress.call(current, { result: input }); return { ...input, node: current.nodeId } } },
  })
  assert.deepEqual(await callback({ action: 'component', module_digest: 'frozen', name: 'echo', node_id: 'root/child/step', input: { ok: true } }), { ok: true, node: 'root/child/step' })
  assert.deepEqual(events, [{ node: 'root/child/step', value: { result: { ok: true } } }])
  await assert.rejects(callback({ action: 'component', module_digest: 'changed', name: 'echo', node_id: 'root' }), /冻结包/)
  await assert.rejects(callback({ action: 'component', module_digest: 'frozen', name: 'missing', node_id: 'root' }), /冻结包/)
  await assert.rejects(callback({ action: 'component', module_digest: 'frozen', name: 'toString', node_id: 'root' }), /冻结包/)
})
