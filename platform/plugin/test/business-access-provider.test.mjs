import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
const compiled = mkdtempSync(join(tmpdir(), 'external-access-build-'))
await build({ stdin: { contents: "export * from './src/business-control/core.ts';export * from './src/business-control/reports.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(compiled, 'control.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { BusinessControl, getBusinessControl, withBusinessContext, registerBusinessReport, readBusinessReport, setBusinessReportHeaderResolver } = await import(`file://${join(compiled, 'control.mjs')}`)
test.after(() => rmSync(compiled, { recursive: true, force: true }))
const future = (ms = 60000) => new Date(Date.now() + ms).toISOString()
const binding = { workspaceId: 'workspace', agentId: 'soc', instanceId: 'access-runtime', runtimeGeneration: 'generation-1', sourceDigest: 'sha256:' + 'b'.repeat(64) }
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'external-access-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = { access: [], risk: [], decision: 'allow', policyVersion: 'policy-1', reason: '本次操作符合业务策略', accessMode: 'ready', riskMode: 'ready', denied: [], targetCalls: 0, ttl: 60000, gate: undefined }
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { remote.targetCalls++; res.writeHead(200, { 'content-type': 'text/html' }).end(remote.reportBody ?? '<html>report</html>'); return }
    let text = ''; for await (const bytes of req) text += bytes
    const body = JSON.parse(text); let value
    if (req.url === '/trust') value = { valid: true, subjectId: body.subjectId, expiresAt: future() }
    else if (req.url === '/risk') {
      remote.risk.push(body); if (remote.riskMode === 'down') { res.writeHead(503).end(); return }
      value = { scope: { subjectId: body.subjectId, sessionId: body.sessionId, serverId: body.scope.serverId }, version: 1, expiresAt: future(), level: remote.unknownBody && typeof body.input === 'string' ? 'unknown' : remote.denied.length || remote.bodyHigh && typeof body.input === 'string' ? 'high' : 'low', constraints: { deniedOperations: remote.denyReport && typeof body.input === 'string' && body.input.includes('sensitive') ? ['download'] : remote.denied } }
    } else {
      remote.access.push(body); await remote.gate?.(body)
      if (remote.accessMode === 'down') { res.writeHead(503).end(); return }
      if (remote.accessMode === 'timeout') await new Promise(resolve => setTimeout(resolve, 100))
      if (remote.accessMode === 'json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{'); return }
      const bindingRequest = remote.accessMode === 'replay' ? remote.access[0] : body
      value = { protocolVersion: 1, requestId: bindingRequest.requestId, binding: bindingRequest.binding, decision: remote.denyBody && body.risk.facts.some(fact => fact.contentDigest && fact.level === 'high') ? 'deny' : remote.decision, policyVersion: remote.policyVersion, reason: remote.reason, expiresAt: future(remote.ttl) }
      if (remote.accessMode === 'binding') value.binding = 'other-request'
      if (remote.accessMode === 'expired') value.expiresAt = new Date(0).toISOString()
      if (remote.accessMode === 'invalid') value.decision = 'maybe'
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const operations = [{ serverId: 'soc', operationId: 'update', kind: 'write', method: 'POST', target: origin + '/update' }, { serverId: 'soc', operationId: 'download', kind: 'publish', method: 'GET', target: origin + '/reports/test.html' }]
  const config = { schemaVersion: 1, enabled: true, agents: [{ agentId: 'soc', enabled: true, subjects: ['subject-a'], actions: ['*'], serverIds: ['soc'] }], authentication: { endpoint: origin + '/auth' }, identityTrust: { endpoint: origin + '/trust' }, accessAuthorization: { endpoint: origin + '/access', timeoutMs: 1000 }, operations, gateway: { instances: [{ agentId: binding.agentId, instanceId: binding.instanceId, sourceDigest: binding.sourceDigest }] } }
  mkdirSync(join(root, 'config')); const path = join(root, 'config/business-access.json'); writeFileSync(path, JSON.stringify(config))
  const control = getBusinessControl(root); control.registerInstance(binding)
  const acknowledge = () => { control.recordAgentAuthentication(binding); const snapshot = control.issueSnapshot(binding.instanceId); control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId) }; acknowledge()
  const context = control.bindSession(control.createContext({ subject: { id: 'subject-a', kind: 'human', identitySource: origin }, evidence: { issuer: origin, externalSubject: 'subject-a', method: 'bearer', verifiedAt: new Date().toISOString(), expiresAt: future(), credentialRef: 'fixture' }, expiresAt: future() }, binding), 'session-a')
  const calls = [], op = { ...operations[0], args: { incident: 'INC-1' } }
  return { root, origin, config, control, context, remote, calls, op, save() { writeFileSync(path, JSON.stringify(config)); control.configurationChanged(); acknowledge() }, run(operation = op, dispatch = () => { calls.push(operation.operationId); return 'done' }, signal = new AbortController().signal) { return withBusinessContext(context, () => control.execute(operation, dispatch, signal)) } }
}

test('关闭风险仍逐请求外部授权，协议绑定真实主体操作且收据不保存凭据', async t => {
  const f = await fixture(t); await f.run(); await f.run()
  const [first, second] = f.remote.access
  assert.equal(first.protocolVersion, 1); assert.notEqual(first.requestId, second.requestId); assert.match(first.binding, /^[a-f0-9]{64}$/)
  assert.equal(first.scope.subjectId, 'subject-a'); assert.equal(first.scope.serverId, 'soc'); assert.equal(first.operation.target, f.op.target)
  assert.deepEqual(first.input, f.op.args); assert.deepEqual(first.risk, { enabled: false, status: 'disabled', facts: [] }); assert.equal(first.identity, undefined)
  const event = f.control.status().events.at(-1); assert.equal(event.authorization.source, 'third-party'); assert.equal(event.scope.agentId, 'soc'); assert.equal(event.authorization.provider, f.origin)
})
test('外部有效允许替代手动工具上限，但不越过未绑定原生权限或真实目标', async t => {
  const f = await fixture(t); f.config.agents[0].actions = ['agent:access', 'session:read']; f.config.agents[0].serverIds = []
  f.config.agents[0].toolPolicies = [{ serverId: 'soc', defaultEffect: 'deny', rules: [] }]; f.config.operations[0].confirmation = true; f.save()
  assert.equal(await f.run(), 'done'); assert.throws(() => f.control.assert(f.context, 'read'), { code: 'action_forbidden' })
  await assert.rejects(f.run({ ...f.op, target: f.origin + '/other' }), { code: 'operation_binding_changed' }); assert.equal(f.remote.access.length, 1)
})
test('第三方明确拒绝不能回退手动允许', async t => {
  const f = await fixture(t); f.remote.decision = 'deny'; f.remote.reason = '敏感事件禁止回写'
  await assert.rejects(f.run(), error => error.code === 'tool_policy_denied' && /敏感事件/.test(error.message)); assert.equal(f.calls.length, 0)
  assert.equal(f.control.status().events.at(-1).authorization.source, 'third-party')
})
for (const failure of ['down', 'json', 'binding', 'expired', 'invalid', 'timeout']) test(`外部${failure}响应使用手动兜底`, async t => {
  const f = await fixture(t); f.remote.accessMode = failure; if (failure === 'timeout') f.config.accessAuthorization.timeoutMs = 15; f.save()
  assert.equal(await f.run(), 'done'); assert.equal(f.control.status().events.at(-1).authorization.source, 'manual-fallback')
})
test('外部不可用和未配置都落实手动拒绝', async t => {
  const f = await fixture(t); f.config.agents[0].toolPolicies = [{ serverId: 'soc', defaultEffect: 'deny', rules: [] }]; f.remote.accessMode = 'down'; f.save()
  await assert.rejects(f.run(), { code: 'tool_policy_denied' }); delete f.config.accessAuthorization; f.save(); await assert.rejects(f.run(), { code: 'tool_policy_denied' }); assert.equal(f.calls.length, 0)
})
test('风险不可用暂停无依据条件，有效明确拒绝不因故障被解除', async t => {
  const f = await fixture(t); delete f.config.accessAuthorization; f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.config.agents[0].toolPolicies = [{ serverId: 'soc', defaultEffect: 'allow', rules: [{ when: { riskLevels: ['high'] }, effect: 'deny' }] }]; f.remote.riskMode = 'down'; f.save()
  assert.equal(await f.run(), 'done'); assert.equal(f.control.status().events.at(-1).authorization.source, 'manual-fallback')
  f.config.agents[0].toolPolicies = []; f.save(); f.remote.riskMode = 'ready'; f.remote.denied = ['update']; await assert.rejects(f.run(), { code: 'risk_restricted' })
  f.remote.riskMode = 'down'; await assert.rejects(f.run(), { code: 'risk_restricted' })
})
test('外部授权得到实际风险状态，停用风险不复用旧事实', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
  await f.run(); assert.equal(f.remote.access.at(-1).risk.status, 'assessed'); assert.equal(f.remote.access.at(-1).risk.facts.length, 1)
  f.remote.riskMode = 'down'; await f.run(); assert.equal(f.remote.access.at(-1).risk.status, 'unavailable')
  delete f.config.riskAssessment; f.save(); await f.run(); assert.deepEqual(f.remote.access.at(-1).risk, { enabled: false, status: 'disabled', facts: [] })
})
test('确认后重新决策，拒绝和版本变化均阻止派发', async t => {
  const f = await fixture(t); f.remote.decision = 'confirm'; let prompted = 0
  f.control.setConfirmationHandler(async () => { prompted++; f.remote.decision = 'deny' }); await assert.rejects(f.run(), { code: 'tool_policy_denied' }); assert.equal(prompted, 1); assert.equal(f.remote.access.length, 2)
  f.remote.decision = 'confirm'; f.control.setConfirmationHandler(async () => { f.remote.policyVersion = 'policy-2' }); await assert.rejects(f.run(), { code: 'confirmation_invalid' }); assert.equal(f.calls.length, 0)
  f.control.setConfirmationHandler(async () => {}); assert.equal(await f.run(), 'done'); assert.equal(f.calls.length, 1)
})
test('异步等待期间改变参数或配置不沿用原决定', async t => {
  const f = await fixture(t); f.remote.gate = async () => { f.op.args.incident = 'INC-2' }; await assert.rejects(f.run(), { code: 'authorization_changed' }); assert.equal(f.calls.length, 0)
  f.remote.gate = async () => { f.config.accessAuthorization.endpoint = f.origin + '/access-new'; f.save() }; await assert.rejects(f.run(), { code: 'authorization_changed' }); assert.equal(f.calls.length, 0)
})
test('取消外部等待不会转手动后派发', async t => {
  const f = await fixture(t), controller = new AbortController(); f.remote.gate = async () => controller.abort(new Error('cancelled')); await assert.rejects(f.run(f.op, undefined, controller.signal)); assert.equal(f.calls.length, 0)
})
test('报告异步连接解析期间许可到期，真实fetch前核对且上游零调用', async t => {
  const f = await fixture(t); f.remote.ttl = 250
  const url = registerBusinessReport(f.root, f.context, f.origin + '/reports/test.html', f.origin, { serverId: 'soc', operation: { ...f.config.operations[1] } })
  setBusinessReportHeaderResolver(f.root, async () => { await new Promise(resolve => setTimeout(resolve, 450)); return { headers: {}, assertCurrent() {} } })
  await assert.rejects(readBusinessReport(f.root, f.context, url.split('/').at(-1))); assert.equal(f.remote.targetCalls, 0)
})
test('开发调试沿用放行，不查询外部风险或授权', async t => {
  const f = await fixture(t); f.config.gateway.instances[0].identityMode = 'development'; f.config.agents[0].actions = []; f.save()
  assert.equal(await f.run(), 'done'); assert.equal(f.remote.access.length, 0); assert.equal(f.remote.risk.length, 0)
})


test('确认期间风险恢复后同一请求发送assessed状态，不保留不可用标记', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
  await f.run(); f.remote.access.length = 0; f.calls.length = 0
  f.remote.riskMode = 'down'; f.remote.decision = 'confirm'
  f.control.setConfirmationHandler(async () => { f.remote.riskMode = 'ready' })
  assert.equal(await f.run(), 'done')
  assert.deepEqual(f.remote.access.map(value => value.risk.status), ['unavailable', 'assessed'])
})
test('手动基础动作或服务范围拒绝时，兜底回执也明确拒绝', async t => {
  for (const field of ['actions', 'serverIds']) {
    const f = await fixture(t); f.remote.accessMode = 'down'; f.config.agents[0][field] = []; f.save()
    await assert.rejects(f.run(), { code: field === 'actions' ? 'action_forbidden' : 'server_forbidden' })
    const event = f.control.status().events.at(-1); assert.equal(event.authorization.source, 'manual-fallback'); assert.equal(event.authorization.decision, 'deny')
  }
})

test('外部决策等待期间同范围新风险即使无显式拒绝也使旧允许失效', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
  f.remote.gate = async () => { const fact = f.control.status().riskFacts.at(-1); f.control.updateRisk({ ...fact, version: fact.version + 1, level: 'high', signals: [] }) }
  await assert.rejects(f.run(), { code: 'authorization_changed' }); assert.equal(f.calls.length, 0)
})
test('外部允许进入异步派发后风险或提供方配置变化会中止旧许可', async t => {
  for (const change of ['risk', 'configuration']) {
    const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
    let release, entered; const started = new Promise(resolve => entered = resolve)
    const request = f.run(f.op, async signal => { entered(); await new Promise(resolve => release = resolve); signal.throwIfAborted(); f.calls.push('late'); return 'done' })
    await started
    if (change === 'risk') { const fact = f.control.status().riskFacts.at(-1); f.control.updateRisk({ ...fact, version: fact.version + 1, level: 'high', signals: [] }) }
    else { delete f.config.accessAuthorization; f.config.agents[0].toolPolicies = [{ serverId: 'soc', defaultEffect: 'deny', rules: [] }]; f.save() }
    release(); await assert.rejects(request, { code: 'permission_revoked' }); assert.equal(f.calls.length, 0)
  }
})

test('正常报告评估正文后重决策交付，不重复GET且正文事实不跨操作', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
  const url = registerBusinessReport(f.root, f.context, f.origin + '/reports/test.html', f.origin, { serverId: 'soc', operation: { ...f.config.operations[1] } })
  setBusinessReportHeaderResolver(f.root, () => ({ headers: {}, assertCurrent() {} }))
  const result = await readBusinessReport(f.root, f.context, url.split('/').at(-1))
  assert.equal(Buffer.from(result.body).toString(), '<html>report</html>'); assert.equal(f.remote.targetCalls, 1); assert.equal(f.remote.access.length, 2)
  assert.ok(f.remote.access.at(-1).risk.facts.some(fact => fact.contentDigest))
  const bodyRequest = f.remote.risk.find(value => typeof value.input === 'string')
  assert.deepEqual(Object.keys(bodyRequest.operationBinding).sort(), ['serverId', 'operationId', 'kind', 'method', 'target'].sort()); assert.deepEqual(bodyRequest.conditionRequest, {})
  assert.equal(bodyRequest.operationBinding.target, f.origin + '/reports/test.html')
  await f.run(); assert.ok(f.remote.access.at(-1).risk.facts.every(fact => !fact.contentDigest), '普通工具不得取得上个报告正文事实')
})
test('报告正文高风险可被外部拒绝交付，其他报告不借用旧正文事实', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.remote.bodyHigh = true; f.remote.denyBody = true; f.save()
  const report = () => registerBusinessReport(f.root, f.context, f.origin + '/reports/test.html', f.origin, { serverId: 'soc', operation: { ...f.config.operations[1] } }).split('/').at(-1)
  setBusinessReportHeaderResolver(f.root, () => ({ headers: {}, assertCurrent() {} }))
  await assert.rejects(readBusinessReport(f.root, f.context, report()), { code: 'tool_policy_denied' }); assert.equal(f.remote.targetCalls, 1)
  f.remote.bodyHigh = false; f.remote.reportBody = '<html>other report</html>'
  assert.equal(Buffer.from((await readBusinessReport(f.root, f.context, report())).body).toString(), f.remote.reportBody)
  const bodyFacts = f.remote.access.at(-1).risk.facts.filter(fact => fact.contentDigest); assert.equal(bodyFacts.length, 1); assert.equal(bodyFacts[0].level, 'low')
  assert.equal(f.remote.targetCalls, 2)
})
test('风险服务不可用时使用同操作仍有效high事实执行手动条件拒绝', async t => {
  const f = await fixture(t); delete f.config.accessAuthorization; f.config.riskAssessment = { endpoint: f.origin + '/risk' }
  f.config.agents[0].toolPolicies = [{ serverId: 'soc', defaultEffect: 'allow', rules: [{ when: { riskLevels: ['high'] }, effect: 'deny' }] }]; f.save()
  f.remote.denied = ['unrelated']; await assert.rejects(f.run(), { code: 'tool_policy_denied' })
  f.remote.riskMode = 'down'; await assert.rejects(f.run(), { code: 'tool_policy_denied' }); assert.equal(f.calls.length, 0)
  const other = { ...f.op, args: { incident: 'other' } }; assert.equal(await f.run(other), 'done', '其他输入不借用旧high事实')
})

test('正文明确拒绝绑定本次报告，不跨另一个reportRef或普通工具', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.remote.reportBody = '<html>sensitive report</html>'; f.remote.denyReport = true; f.save()
  const report = () => registerBusinessReport(f.root, f.context, f.origin + '/reports/test.html', f.origin, { serverId: 'soc', operation: { ...f.config.operations[1] } }).split('/').at(-1)
  setBusinessReportHeaderResolver(f.root, () => ({ headers: {}, assertCurrent() {} }))
  await assert.rejects(readBusinessReport(f.root, f.context, report()), error => ['risk_restricted', 'permission_revoked'].includes(error.code))
  const bodyFact = f.control.status().riskFacts.find(fact => fact.contentDigest); assert.ok(bodyFact.operationBinding)
  f.remote.reportBody = '<html>other safe report</html>'
  assert.equal(Buffer.from((await readBusinessReport(f.root, f.context, report())).body).toString(), f.remote.reportBody)
  assert.equal(await f.run(), 'done'); assert.equal(f.remote.targetCalls, 2)
})

test('旧请求允许响应不能复用于另一个Session和参数', async t => {
  const f = await fixture(t); await f.run(); f.config.agents[0].toolPolicies = [{ serverId: 'soc', defaultEffect: 'deny', rules: [] }]; f.save()
  f.remote.accessMode = 'replay'; const second = f.control.bindSession(f.context, 'session-b'); let dispatched = 0
  await assert.rejects(withBusinessContext(second, () => f.control.execute({ ...f.op, args: { incident: 'other' } }, () => { dispatched++ })), { code: 'tool_policy_denied' })
  assert.equal(dispatched, 0); assert.equal(f.control.status().events.at(-1).authorization.source, 'manual-fallback')
})
test('Runtime回执沿原观察通道传输，来源枚举及跨实例范围不能伪造', async t => {
  const f = await fixture(t); await f.run(); f.control.requireSnapshot(binding.instanceId); const original = f.control.exportReplicaState(binding)
  const center = new BusinessControl(f.root, join(f.root, 'replica-center')); center.registerInstance(binding)
  for (const mutate of [value => value.events.at(-1).authorization.source = 'invented', value => value.events.at(-1).authorization.provider = 'http://user:password@example.test/', value => value.events.at(-1).scope.agentId = 'other-agent']) {
    const value = structuredClone(original); mutate(value)
    assert.throws(() => center.importReplicaState(binding, value), { code: 'replica_event_invalid' })
  }
  assert.doesNotThrow(() => center.importReplicaState(binding, original))
})

test('报告正文返回unknown时二次访问决策使用该阶段当前风险状态', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.remote.unknownBody = true; f.save()
  const url = registerBusinessReport(f.root, f.context, f.origin + '/reports/test.html', f.origin, { serverId: 'soc', operation: { ...f.config.operations[1] } })
  setBusinessReportHeaderResolver(f.root, () => ({ headers: {}, assertCurrent() {} }))
  await readBusinessReport(f.root, f.context, url.split('/').at(-1))
  assert.deepEqual(f.remote.access.map(value => value.risk.status), ['assessed', 'unknown']); assert.equal(f.remote.targetCalls, 1)
})

test('风险关闭且报告依据未变化时不重复请求授权或重复确认', async t => {
  const f = await fixture(t); f.remote.decision = 'confirm'; let confirmations = 0
  f.control.setConfirmationHandler(async () => { confirmations++ })
  const url = registerBusinessReport(f.root, f.context, f.origin + '/reports/test.html', f.origin, { serverId: 'soc', operation: { ...f.config.operations[1] } })
  setBusinessReportHeaderResolver(f.root, () => ({ headers: {}, assertCurrent() {} }))
  await readBusinessReport(f.root, f.context, url.split('/').at(-1))
  assert.equal(confirmations, 1); assert.equal(f.remote.access.length, 2, '确认前后各一次，正文交付不重复授权'); assert.equal(f.remote.targetCalls, 1)
})

test('跨提供方风险来源只发送安全origin，内部事实不改且允许拒绝照常执行', async t => {
  const f = await fixture(t); f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
  const originals = [
    ['legacy-private-url', 'https://fixture-user:fixture-password@risk.example.test:8443/private/path?api_key=fixture-value#fixture-fragment'],
    ['legacy-private-file', 'file:///private/path?api_key=fixture-value'],
    ['legacy-private-id', 'private-source-token-fixture-value'],
  ].map(([id, source]) => ({ id, source, version: 1, scope: { ...f.context.scope, serverId: 'soc' },
    status: 'assessed', level: 'high', signals: [], observedAt: new Date().toISOString(), expiresAt: future() }))
  originals.forEach(fact => f.control.updateRisk(fact))
  assert.equal(await f.run(), 'done')
  const facts = f.remote.access.at(-1).risk.facts
  assert.equal(facts.find(fact => fact.id === originals[0].id).source, 'https://risk.example.test:8443')
  for (const original of originals.slice(1)) assert.equal(facts.find(fact => fact.id === original.id).source, '第三方风险评估')
  for (const original of originals) {
    const projected = facts.find(fact => fact.id === original.id)
    assert.deepEqual(projected.scope, original.scope); assert.equal(projected.level, original.level); assert.equal(projected.version, original.version)
    assert.deepEqual(f.control.status().riskFacts.find(fact => fact.id === original.id), original)
  }
  const wire = JSON.stringify(f.remote.access.at(-1))
  assert.doesNotMatch(wire, /fixture-user|fixture-password|api_key|fixture-value|fixture-fragment|private\/path|private-source-token/)
  f.remote.decision = 'deny'; await assert.rejects(f.run(), { code: 'tool_policy_denied' })
  assert.equal(f.calls.length, 1)
  for (const original of originals) assert.deepEqual(f.control.status().riskFacts.find(fact => fact.id === original.id), original)
})
