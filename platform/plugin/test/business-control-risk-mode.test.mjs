import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const buildRoot = mkdtempSync(join(tmpdir(), 'business-risk-mode-build-'))
await build({ stdin: { contents: "export * from './src/business-control/management.ts'; export * from './src/business-control/core.ts'; export * from './src/business-control/reports.ts'; export { registerBusinessInboxChecks } from './src/business-control/runtime.ts'; export { managedDispatch } from './src/mcp/control.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(buildRoot, 'control.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { createBusinessControlHandler, getBusinessControl, withBusinessContext, registerBusinessInboxChecks, registerBusinessReport, readBusinessReport, setBusinessReportHeaderResolver, managedDispatch } = await import(`file://${join(buildRoot, 'control.mjs')}`)
test.after(() => rmSync(buildRoot, { recursive: true, force: true }))
const owner = { principal: { kind: 'owner' } }
const future = () => new Date(Date.now() + 60000).toISOString()
const binding = { workspaceId: 'workspace', agentId: 'soc', instanceId: 'risk-mode-runtime', runtimeGeneration: 'generation-1', sourceDigest: 'sha256:' + 'a'.repeat(64) }

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'business-risk-mode-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = { revoked: false, denied: [], version: 1, riskCalls: 0, trustCalls: 0, trustGate: undefined, reportCalls: 0, reportBody: '<html>REPORT-MARKER</html>', denyMarked: false, evidence: undefined, riskInputs: [] }
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/reports/off.html') {
      remote.reportCalls++; response.writeHead(200, { 'content-type': 'text/html' }).end(remote.reportBody); return
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    let result
    if (request.url === '/trust') {
      remote.trustCalls++; await remote.trustGate?.()
      result = { valid: !remote.revoked, subjectId: body.subjectId, expiresAt: future() }
    } else {
      remote.riskCalls++
      remote.riskInputs.push(body)
      const denied = remote.denyMarked && /INPUT-MARKER|REPORT-MARKER/.test(JSON.stringify(body.input)) ? ['*'] : remote.denied
      if (remote.denyMarked) remote.version++
      result = { scope: { subjectId: body.subjectId, sessionId: body.sessionId }, version: remote.version, expiresAt: future(), level: denied.length ? 'high' : 'low', constraints: { deniedOperations: denied }, ...(remote.evidence !== undefined ? { conditionEvidence: remote.evidence } : {}) }
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const config = { schemaVersion: 1, enabled: true, agents: [{ agentId: 'soc', enabled: true, subjects: ['subject-a'], actions: ['*'], serverIds: ['soc'] }],
    operations: [{ serverId: 'soc', operationId: 'download', kind: 'publish', method: 'GET', target: origin + '/reports/off.html' }],
    detection: { inputMarkers: ['INPUT-MARKER'], reportMarkers: ['REPORT-MARKER'] },
    gateway: { instances: [{ agentId: binding.agentId, instanceId: binding.instanceId, sourceDigest: binding.sourceDigest }] },
    authentication: { endpoint: origin + '/authenticate' }, identityTrust: { endpoint: origin + '/trust' } }
  mkdirSync(join(root, 'config'))
  const path = join(root, 'config', 'business-access.json')
  writeFileSync(path, JSON.stringify(config))
  const control = getBusinessControl(root)
  control.registerInstance(binding); control.recordAgentAuthentication(binding)
  const snapshot = control.issueSnapshot(binding.instanceId)
  control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId)
  const context = control.bindSession(control.createContext({ subject: { id: 'subject-a', kind: 'human', identitySource: origin }, evidence: { issuer: origin, externalSubject: 'subject-a', method: 'bearer', verifiedAt: new Date().toISOString(), expiresAt: future(), credentialRef: 'ref:test-user' }, expiresAt: future() }, binding), 'session-a')
  const handler = createBusinessControlHandler(root)
  return { root, control, config, remote, context, origin,
    save() { writeFileSync(path, JSON.stringify(config)); control.configurationChanged() },
    restrict(reason = 'manual') { return control.updateRestriction({ scope: { ...context.scope, serverId: 'soc' }, deniedActions: ['write'], active: true, reason }) },
    call(endpoint, payload) { return handler(endpoint, payload, new AbortController().signal, owner) },
    release(restriction) { return handler('release', { restrictionId: restriction.id, sessionId: 'session-a', action: 'write' }, new AbortController().signal, owner) } }
}

test('关闭风险评估后可显式解除所选手工限制，其他限制仍有效且不重放业务', async t => {
  const f = await fixture(t), first = f.restrict('first'), second = f.restrict('second')
  assert.equal((await f.call('reassess', { sessionId: 'session-a', action: 'write' })).error.code, 'risk_provider_unavailable')
  const released = await f.release(first)
  assert.equal(released.ok, true)
  assert.equal(released.value.change.currentPermission, 'deny')
  assert.equal(released.value.change.reason, 'risk_restricted')
  assert.equal(released.value.change.businessReplayed, false)
  assert.equal(f.control.status().restrictions.find(value => value.id === first.id).active, false)
  assert.equal(f.control.status().restrictions.find(value => value.id === second.id).active, true)
  const final = await f.release(second)
  assert.equal(final.ok, true)
  assert.equal(final.value.change.currentPermission, 'allow')
  assert.equal(f.remote.riskCalls, 0)
  assert.ok(f.remote.trustCalls >= 2, '显式解除仍重新核对用户身份')
})

test('关闭评估时真实 Inbox 接缝不运行自动检测，基础拒绝仍生效；重新开启按第三方拒绝', async t => {
  const f = await fixture(t)
  let checkInbox
  registerBusinessInboxChecks({ on(event, callback) { assert.equal(event, 'agent/created'); checkInbox = callback } }, f.control, binding)
  const event = { agent: { session: { id: 'session-a' }, inbox: { nextTurn: [{ content: [{ type: 'text', text: 'INPUT-MARKER' }] }], nextStep: [] } } }
  await checkInbox(event)
  assert.equal(f.remote.riskCalls, 0)
  assert.deepEqual(f.control.status().riskFacts, [])
  f.config.agents[0].actions = ['read']; f.save()
  await assert.rejects(checkInbox(event), { code: 'action_forbidden' })
  f.config.agents[0].actions = ['*']; f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
  f.remote.denyMarked = true
  await assert.rejects(checkInbox(event), { code: 'risk_restricted' })
  assert.equal(f.control.status().riskFacts[0].source, f.origin + '/risk')
})

test('关闭评估时真实报告下载按基础与手工限制执行，重新开启后第三方拒绝正文', async t => {
  const f = await fixture(t)
  t.after(setBusinessReportHeaderResolver(f.root, () => ({ headers: {}, assertCurrent() {} })))
  const path = registerBusinessReport(f.root, f.context, f.origin + '/reports/off.html', f.origin, { serverId: 'soc' })
  const id = path.split('/').at(-1)
  const report = await readBusinessReport(f.root, f.context, id)
  assert.equal(Buffer.from(report.body).toString(), f.remote.reportBody)
  assert.equal(f.remote.reportCalls, 1)
  assert.equal(f.remote.riskCalls, 0)
  assert.deepEqual(f.control.status().riskFacts, [])
  const restriction = f.control.updateRestriction({ scope: { ...f.context.scope, serverId: 'soc' }, deniedActions: ['publish'], active: true, reason: 'manual-report' })
  await assert.rejects(readBusinessReport(f.root, f.context, id), { code: 'risk_restricted' })
  assert.equal(f.remote.reportCalls, 1)
  f.control.updateRestriction({ ...restriction, active: false })
  f.config.agents[0].actions = ['read']; f.save()
  await assert.rejects(readBusinessReport(f.root, f.context, id), { code: 'action_forbidden' })
  assert.equal(f.remote.reportCalls, 1)
  f.config.agents[0].actions = ['*']; f.config.riskAssessment = { endpoint: f.origin + '/risk' }; f.save()
  f.remote.denyMarked = true
  await assert.rejects(readBusinessReport(f.root, f.context, id), { code: 'risk_restricted' })
  assert.equal(f.remote.reportCalls, 2)
  assert.ok(f.control.status().riskFacts.some(fact => fact.source === f.origin + '/risk'))
})

test('条件化发布经真实managedDispatch保留原操作证据完成报告登记，独立下载按本次证据重验', async t => {
  const f = await fixture(t)
  t.after(setBusinessReportHeaderResolver(f.root, () => ({ headers: {}, assertCurrent() {} })))
  f.config.riskAssessment = { endpoint: f.origin + '/risk' }
  f.config.operations.push({ serverId: 'soc', operationId: 'publish-report', kind: 'publish', method: 'POST', target: f.origin + '/publish' })
  f.config.agents[0].toolPolicies = [{ serverId: 'soc', defaultEffect: 'deny', rules: [{ kinds: ['publish'], when: { scenarioIds: ['reporting'] }, effect: 'allow' }] }]
  f.remote.evidence = { scenarioIds: ['reporting'] }; f.save()
  const body = '<html>已生成的正常业务报告</html>'
  const actual = { ...f.config.operations[1], args: { fileContentBase64: Buffer.from(body).toString('base64') } }
  const result = await withBusinessContext(f.context, () => managedDispatch(f.root)(actual, async () => ({ report_url: f.origin + '/reports/off.html' })))
  assert.match(result.report_url, /^\/agents\/soc\/instances\/risk-mode-runtime\/api\/business-control\/reports\//)
  assert.equal(f.remote.riskInputs[0].input, body, '第三方接收规范化后的实际发布正文')
  const report = await readBusinessReport(f.root, f.context, result.report_url.split('/').at(-1))
  assert.equal(Buffer.from(report.body).toString(), f.remote.reportBody)
  assert.equal(f.remote.reportCalls, 1)
  const bindings = f.control.status().riskFacts.flatMap(fact => fact.operationBinding ? [fact.operationBinding] : [])
  assert.ok(bindings.some(binding => binding.operationId === 'publish-report'))
  assert.ok(bindings.some(binding => binding.operationId === 'download'))
  assert.ok(bindings.every(binding => binding.inputDigest && binding.targetDigest && !Object.hasOwn(binding, 'target')))
})

test('风险关闭时解除仍受当前静态策略、身份与实例来源约束，拒绝时保留原限制', async t => {
  const cases = [
    ['action', f => { f.config.agents[0].actions = ['read'] }, 'action_forbidden'],
    ['subject', f => { f.config.agents[0].subjects = [] }, 'invalid_scope'],
    ['server', f => { f.config.agents[0].serverIds = [] }, 'invalid_scope'],
    ['instance', f => { f.config.gateway.instances = [] }, 'instance_not_registered'],
    ['source', f => { f.config.gateway.instances[0].sourceDigest = 'sha256:' + 'b'.repeat(64) }, 'agent_source_mismatch'],
    ['identity', f => { f.remote.revoked = true }, 'identity_invalid'],
  ]
  for (const [name, change, code] of cases) await t.test(name, async child => {
    const f = await fixture(child), restriction = f.restrict()
    change(f); f.save()
    const response = await f.release(restriction)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, code)
    assert.equal(f.control.status().restrictions.find(value => value.id === restriction.id).active, true)
    assert.equal(f.remote.riskCalls, 0)
  })
})

test('开启评估时解除仍先核对风险，动态拒绝未解除前保留手工限制', async t => {
  const f = await fixture(t), restriction = f.restrict()
  f.config.riskAssessment = { endpoint: f.origin + '/risk', requiredKinds: ['write', 'publish'] }; f.save()
  f.remote.denied = ['write']
  assert.equal((await f.release(restriction)).error.code, 'risk_restricted')
  assert.equal(f.control.status().restrictions[0].active, true)
  f.remote.denied = []; f.remote.version++
  const response = await f.release(restriction)
  assert.equal(response.ok, true)
  assert.equal(response.value.change.currentPermission, 'allow')
  assert.equal(f.remote.riskCalls, 2)
})

test('关闭风险后的解除等待身份核对时，其他修改不能被旧限制快照覆盖', async t => {
  const f = await fixture(t), restriction = f.restrict()
  let entered, unblock
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  f.remote.trustGate = () => { entered(); return gate }
  const pending = f.release(restriction); await started
  f.control.updateRestriction({ ...restriction, reason: 'changed-during-identity-check' })
  unblock()
  const response = await pending
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'conflict')
  assert.equal(f.control.status().restrictions[0].reason, 'changed-during-identity-check')
  assert.equal(f.control.status().restrictions[0].active, true)
})

test('等待解除期间重新开启风险评估，恢复后的风险拒绝不能被关闭时的请求绕过', async t => {
  const f = await fixture(t), restriction = f.restrict()
  let entered, unblock
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  f.remote.trustGate = () => { entered(); return gate }
  const pending = f.release(restriction); await started
  f.config.riskAssessment = { endpoint: f.origin + '/risk', requiredKinds: ['write'] }; f.remote.denied = ['write']; f.save()
  unblock()
  const response = await pending
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'risk_restricted')
  assert.equal(f.control.status().restrictions[0].active, true)
  assert.equal(f.remote.riskCalls, 1)
})
