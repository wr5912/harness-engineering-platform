import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
const program = process.env.HARNESS_PROGRAM_ROOT
if (!program) throw new Error('需要 HARNESS_PROGRAM_ROOT')
const { lfxWorkflow } = await import(`${program}/platform/plugin/src/mcp/lfx-runtime.ts`)
const root = process.env.HARNESS_ASSET_ROOT
const context = () => ({ runId: 'acceptance-fixed', nodeId: 'root', signal: AbortSignal.timeout(120000), shared: {}, call: fn => fn(), map: (items, fn) => Promise.all(items.map(fn)), progress() {} })
async function run(id, input, upstream) {
  const config = { kind: 'workflow', engine: 'lfx', workflow: id, title: id, connections: { ingest: 'ingest', response: 'response', framework: 'framework' } }
  const workflow = lfxWorkflow(root, id, {}, upstream), ctx = context()
  ctx.shared = await workflow.prepare(input, config, ctx.signal)
  return workflow.execute(input, config, ctx)
}
const change = { deviceId: 'fw', configKind: 'ACL', operation: 'ADD', payload: { src_ip: '192.0.2.1', dst_ip: '192.0.2.2', protocol: 'tcp', port: 443, action: 'allow' } }
function fixture({ failPreview = false, loseCreateRead = false, status = 'APPROVED', conflict = false } = {}) {
  const calls = []; let taskReads = 0
  const call = async (connection, operation, args) => {
    calls.push({ connection, operation, args })
    const value = operation === 'get_ingest_dispatch_dispatchable_devices' ? [{ deviceId: 'fw' }]
      : operation === 'get_admin_dispatch_task_policy_configs' ? [{ value: 'ACL' }]
      : operation === 'get_admin_dispatch_task_input_fields' ? []
      : operation === 'preview_admin_dispatch_task' || operation === 'preview_internal_ingest_dispatch' ? { success: !failPreview, online: !failPreview, renderedCommand: failPreview ? null : 'real preview fixture' }
      : operation === 'create_admin_dispatch_task' ? { id: '123' }
      : operation === 'get_admin_dispatch_task_by_id' ? (() => { if (loseCreateRead && ++taskReads === 1) throw new Error('unavailable'); return { task: { id: '123', status }, changes: [change], deviceRuns: [] } })()
      : operation === 'precheck_admin_dispatch_task' ? { overallHasConflict: conflict, perDevice: [{ changeIntroducesHard: conflict }] }
      : operation === 'execute_admin_dispatch_task' ? (() => { throw new Error('ECONNRESET') })()
      : operation === 'get_resp_action_defs' ? [{ actionKey: 'host-lock-screen', enabled: true }, { actionKey: 'block-ip', enabled: true }, { actionKey: 'trigger-scan', enabled: true }]
      : operation === 'get_resp_actions_target_candidates' ? [{ value: 'edr' }]
      : operation === 'get_resp_actions_device_agents' ? [{ agentId: '002', name: 'wishclamAV' }]
      : operation === 'get_admin_ingest_devices_scan_templates' ? [{ value: 'current-template', label: 'Basic Network Scan' }]
      : assert.fail(`未预期调用 ${operation}`)
    return { code: 200, data: value }
  }
  return { calls, call }
}
const writes = f => f.calls.filter(c => /^(create|execute|submit)_/.test(c.operation))

test('策略原生预览分支不写入；设备预检失败也不能建任务', async () => {
  for (const failPreview of [false, true]) {
    const f = fixture({ failPreview }); const result = await run('policy-change', { stop: failPreview ? 'apply' : 'preview', changes: [change] }, f.call)
    assert.equal(result.stage, 'preview'); assert.equal(writes(f).length, 0)
    assert.equal(result.items[0].status, failPreview ? 'blocked' : 'ready')
  }
})
test('建任务后查询失败保留原 ID；不会进入提交或执行', async () => {
  const f = fixture({ loseCreateRead: true }), result = await run('policy-change', { stop: 'apply', changes: [change] }, f.call)
  assert.equal(result.taskId, '123', JSON.stringify({ result, calls: f.calls })); assert.equal(result.stage, 'create-unknown')
  assert.deepEqual(writes(f).map(c => c.operation), ['create_admin_dispatch_task'])
})
test('策略先校验当前配置和字段枚举，无效参数不预览、不写入', async () => {
  const f = fixture()
  const call = async (...args) => args[1] === 'get_admin_dispatch_task_input_fields'
    ? { code: 200, data: [{ fieldName: 'action', enumValuesJson: '["allow","deny"]' }] }
    : f.call(...args)
  await assert.rejects(run('policy-change', { stop: 'apply', changes: [{ ...change, payload: { action: 'invalid' } }] }, call), /当前枚举/)
  assert.equal(f.calls.some(c => c.operation === 'preview_admin_dispatch_task'), false)
  assert.equal(writes(f).length, 0)
})
test('原任务继续执行失去回执：只调用一次并查询原任务；保留未知状态及设备明细', async () => {
  const f = fixture(), result = await run('policy-change', { stop: 'apply', taskId: '123' }, f.call)
  assert.equal(result.taskId, '123'); assert.equal(result.stage, 'execute-unknown')
  assert.deepEqual(writes(f).map(c => c.operation), ['execute_admin_dispatch_task'])
  assert.ok(Array.isArray(result.detail.deviceRuns))
})
test('原任务只查或停在草稿时不提交、不执行；冲突及待审批也不执行', async () => {
  for (const stop of ['preview', 'draft']) {
    const f = fixture(), result = await run('policy-change', { stop, taskId: '123' }, f.call)
    assert.equal(result.detail.task.id, '123'); assert.equal(writes(f).length, 0)
  }
  for (const status of ['DRAFT', 'PENDING_APPROVAL']) {
    const f = fixture({ status, conflict: true }), result = await run('policy-change', { stop: 'apply', taskId: '123' }, f.call)
    assert.equal(result.proceed, false); assert.equal(writes(f).length, 0)
  }
})
test('应急 EDR 准备分支核对实际 agent；不生成下发或执行调用', async () => {
  const f = fixture(), result = await run('emergency-action', { actionKey: 'host-lock-screen', deviceId: 'edr', agentId: '002', params: {}, stop: 'prepare' }, f.call)
  assert.equal(result.stage, 'prepared'); assert.equal(result.agent.agentId, '002'); assert.equal(writes(f).length, 0)
})
test('扫描使用当前模板；没有只建不启入口时停止，不能执行后取消', async () => {
  const f = fixture(), result = await run('emergency-action', { actionKey: 'trigger-scan', deviceId: 'edr', params: { targets: '192.0.2.1' }, stop: 'create-task' }, f.call)
  assert.equal(result.params.profileId, 'current-template'); assert.equal(result.capabilityGap, 'scan-create-without-start'); assert.equal(writes(f).length, 0)
})
test('应急预览失败不能执行', async () => {
  const f = fixture({ failPreview: true }), result = await run('emergency-action', { actionKey: 'block-ip', deviceId: 'edr', params: { src_ip: '192.0.2.1' }, stop: 'execute' }, f.call)
  assert.equal(result.proceed, false); assert.equal(writes(f).length, 0)
})
test('应急硬冲突不能执行；非扫描动作不能请求仅创建扫描任务', async () => {
  const f = fixture(), result = await run('emergency-action', { actionKey: 'block-ip', deviceId: 'edr', params: { src_ip: '192.0.2.1' }, stop: 'execute' }, async (...args) => args[1] === 'preview_internal_ingest_dispatch'
    ? { code: 200, data: { success: true, online: true, precheck: { status: 'CONFLICT', changeIntroducesHard: true } } }
    : f.call(...args))
  assert.equal(result.proceed, false); assert.equal(writes(f).length, 0)
  await assert.rejects(run('emergency-action', { actionKey: 'block-ip', deviceId: 'edr', params: {}, stop: 'create-task' }, f.call), /仅扫描动作/)
  assert.equal(writes(f).length, 0)
})
test('MCP 业务错误保留上游原因和 traceId', async () => {
  const { unpack } = await import('../src/action-api.ts')
  assert.throws(() => unpack({ isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 500, msg: '系统繁忙', traceId: 'trace-test' }) }] }), /500 系统繁忙 traceId=trace-test/)
})
