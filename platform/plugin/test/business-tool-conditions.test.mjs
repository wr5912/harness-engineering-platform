import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const buildRoot = mkdtempSync(join(tmpdir(), 'business-tool-conditions-build-'))
await build({ stdin: { contents: "export * from './src/business-control/management.ts'; export * from './src/business-control/core.ts'", resolveDir: process.cwd(), loader: 'ts' }, outfile: join(buildRoot, 'control.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { createBusinessControlHandler, getBusinessControl, withBusinessContext } = await import(`file://${join(buildRoot, 'control.mjs')}`)
test.after(() => rmSync(buildRoot, { recursive: true, force: true }))
const future = () => new Date(Date.now() + 60000).toISOString()
const binding = { workspaceId: 'workspace', agentId: 'soc', instanceId: 'conditions-runtime', runtimeGeneration: 'generation-1', sourceDigest: 'sha256:' + 'a'.repeat(64) }
const owner = { principal: { kind: 'owner' } }
const operations = [
  { serverId: 'soc', operationId: 'query', kind: 'read', method: 'GET', target: 'https://business.example/query' },
  { serverId: 'soc', operationId: 'writeback', kind: 'write', method: 'POST', target: 'https://business.example/writeback' },
  { serverId: 'reports', operationId: 'publish', kind: 'publish', method: 'POST', target: 'https://business.example/publish' },
]
const operation = (id = 'query', args = { text: 'normal' }) => ({ ...operations.find(item => item.operationId === id), args })
const policy = (rules = [], defaultEffect = 'allow', serverId = 'soc') => ({ serverId, defaultEffect, rules })
const rule = (when, effect, values = {}) => ({ when, effect, ...values })

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'business-tool-conditions-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = { version: 1, level: 'low', evidence: undefined, denied: [], riskCalls: [], revoked: false, unavailable: false, gate: undefined, expiresAt: undefined }
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (request.url === '/trust') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ valid: !remote.revoked, subjectId: body.subjectId, expiresAt: future() })); return }
    remote.riskCalls.push(body); await remote.gate?.(body)
    if (remote.unavailable) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ scope: { subjectId: body.subjectId, ...(remote.omitScope ? {} : { sessionId: body.sessionId, serverId: body.scope.serverId }) },
      version: remote.version, level: remote.level, expiresAt: remote.expiresAt ?? future(), constraints: { deniedOperations: remote.denied },
      ...(remote.evidence !== undefined ? { conditionEvidence: remote.evidence } : {}) }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const config = { schemaVersion: 1, enabled: true, agents: [{ agentId: 'soc', enabled: true, subjects: ['subject-a', 'subject-b'], actions: ['*'], serverIds: ['soc', 'reports'] }],
    operations: structuredClone(operations), authentication: { endpoint: origin + '/auth' }, identityTrust: { endpoint: origin + '/trust' }, riskAssessment: { endpoint: origin + '/risk', requiredKinds: ['write', 'publish'] },
    detection: { inputMarkers: ['RETIRED-MARKER'], operationMarkers: ['RETIRED-MARKER'], reportMarkers: ['RETIRED-MARKER'] },
    gateway: { instances: [{ agentId: binding.agentId, instanceId: binding.instanceId, sourceDigest: binding.sourceDigest }] } }
  mkdirSync(join(root, 'config'))
  const path = join(root, 'config/business-access.json')
  writeFileSync(path, JSON.stringify(config))
  const control = getBusinessControl(root)
  control.registerInstance(binding)
  const acknowledge = () => { control.recordAgentAuthentication(binding); const snapshot = control.issueSnapshot(binding.instanceId); control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId) }
  acknowledge()
  const context = control.bindSession(control.createContext({ subject: { id: 'subject-a', kind: 'human', identitySource: origin },
    evidence: { issuer: origin, externalSubject: 'subject-a', method: 'bearer', verifiedAt: new Date().toISOString(), expiresAt: future(), credentialRef: 'fixture-user' }, expiresAt: future() }, binding), 'session-a')
  const handler = createBusinessControlHandler(root)
  const calls = []
  return { root, path, config, remote, context, control, calls, acknowledge,
    save() { writeFileSync(path, JSON.stringify(config)); control.configurationChanged(); acknowledge() },
    run(op = operation(), dispatch = () => { calls.push(op.operationId); return 'ok' }) { return withBusinessContext(context, () => control.execute(op, dispatch)) },
    call(endpoint, payload = {}) { return handler(endpoint, payload, new AbortController().signal, owner) } }
}

test('纯工具和动作条件无需风险提供方，默认拒绝仅作用于实际执行且不影响聊天归属', async t => {
  const f = await fixture(t)
  delete f.config.riskAssessment
  f.config.agents[0].toolPolicies = [policy([rule({}, 'allow', { operationIds: ['query'], kinds: ['read'] })], 'deny')]; f.save()
  assert.equal(f.control.assert(f.context, 'session:prompt').kind, 'allow')
  assert.equal(await f.run(), 'ok')
  await assert.rejects(f.run(operation('writeback')), error => error.code === 'tool_policy_denied' && /默认处理.*禁止/.test(error.message))
  assert.equal(await f.run(operation('publish')), 'ok', '其他服务保持原基础权限')
  assert.equal(f.remote.riskCalls.length, 0)
  assert.deepEqual(f.calls, ['query', 'publish'])
})

test('工具及动作先筛选，字段间AND中明确不匹配不等待无关场景证据，数组内为OR', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([
    rule({ riskLevels: ['high'], scenarioIds: ['production'] }, 'deny', { operationIds: ['query'] }),
    rule({ scenarioIds: ['absent-evidence'] }, 'deny', { operationIds: ['writeback'] }),
  ])]; f.save()
  assert.equal(await f.run(), 'ok', 'low已明确排除high AND scene，不因缺scene误阻断')
  assert.deepEqual(f.remote.riskCalls[0].conditionRequest, { riskLevels: ['high'], scenarioIds: ['production'] })
  f.config.agents[0].toolPolicies[0].rules = [rule({ riskLevels: ['low', 'high'], scenarioIds: ['production', 'incident'] }, 'deny')]; f.save()
  f.remote.evidence = { scenarioIds: ['incident'] }; f.remote.version++
  await assert.rejects(f.run(), { code: 'tool_policy_denied' })
  assert.equal(f.calls.length, 1)
})

test('业务场景和敏感标签仅消费第三方明确代码，缺字段未知，显式空数组表示不匹配', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ scenarioIds: ['production'], operationTags: ['sensitive'] }, 'deny')])]; f.save()
  assert.equal(await f.run(operation('query', { text: 'production sensitive 自然语言不能代替证据' })), 'ok', '缺少第三方条件时暂停该条件并按手动默认处理')
  f.remote.evidence = { scenarioIds: [], operationTags: [] }; f.remote.version++
  assert.equal(await f.run(), 'ok')
  f.remote.evidence = { scenarioIds: ['production'], operationTags: ['sensitive'] }; f.remote.version++
  await assert.rejects(f.run(), error => error.code === 'tool_policy_denied' && /第三方业务场景.*敏感/.test(error.message))
  assert.equal(f.calls.length, 2)
})

test('明确unknown可以匹配，提供方失效保留有效依据，依据过期后才手动兜底', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ riskLevels: ['unknown'] }, 'deny')])]; f.save()
  f.remote.level = 'unknown'; await assert.rejects(f.run(), { code: 'tool_policy_denied' })
  f.remote.expiresAt = new Date(Date.now() - 1000).toISOString()
  await assert.rejects(f.run(), { code: 'tool_policy_denied' }, '已有同操作有效unknown事实仍匹配手动拒绝')
  const saved = f.control.status().riskFacts[0]
  f.control.updateRisk({ ...saved, version: saved.version + 1, expiresAt: new Date(0).toISOString() })
  assert.equal(await f.run(), 'ok'); assert.equal(f.calls.length, 1)
})

test('同一Agent服务的规则禁止优先于确认与允许，其他Agent策略不跨界且基础拒绝不可被条件允许越过', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({}, 'allow'), rule({}, 'confirm'), rule({}, 'deny')])]; f.save()
  let confirms = 0
  f.control.setConfirmationHandler(async () => { confirms++ })
  await assert.rejects(f.run(), { code: 'tool_policy_denied' })
  assert.equal(confirms, 0)
  f.config.agents[0].toolPolicies = [policy([rule({}, 'allow')])]
  f.config.agents.push({ agentId: 'helper', enabled: true, subjects: [], actions: ['*'], toolPolicies: [policy([], 'deny')] }); f.save()
  assert.equal(await f.run(), 'ok')
  f.config.agents[0].actions = ['read']; f.save()
  await assert.rejects(f.run(operation('writeback')), { code: 'action_forbidden' })
  f.config.agents[0].actions = ['*']; f.config.agents[0].serverIds = ['reports']; f.save()
  await assert.rejects(f.run(), { code: 'server_forbidden' })
})

test('允许条件不能越过第三方明确拒绝或独立人工限制', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ riskLevels: ['low'] }, 'allow')], 'deny')]; f.save()
  f.remote.denied = ['query']
  await assert.rejects(f.run(), { code: 'risk_restricted' })
  f.remote.denied = []; f.remote.version++
  f.control.updateRestriction({ scope: f.context.scope, deniedActions: ['read'], reason: 'manual', active: true })
  await assert.rejects(f.run(), { code: 'risk_restricted' })
  assert.equal(f.calls.length, 0)
})

test('同Session同版本的新绑定拒绝仅约束相同工具和参数，其他请求不串扰，legacy宽范围拒绝仍有效', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ riskLevels: ['low'] }, 'allow')])]; f.save()
  const a = operation('query', { text: 'A' }), b = operation('query', { text: 'B' }), other = operation('writeback', { text: 'A' })
  f.remote.denied = ['query']
  await assert.rejects(f.run(a), { code: 'risk_restricted' })
  f.remote.denied = []
  assert.equal(await f.run(b), 'ok')
  assert.equal(await f.run(other), 'ok')
  assert.equal(f.remote.version, 1)
  const facts = f.control.status().riskFacts
  assert.equal(new Set(facts.map(fact => fact.id)).size, 3)
  assert.ok(facts.every(fact => fact.operationBinding))
  assert.equal(f.control.assert(f.context, 'session:prompt').kind, 'allow')
  const scoped = { ...f.context, scope: { ...f.context.scope, serverId: 'soc' } }
  assert.throws(() => f.control.assertOperation(scoped, a), { code: 'risk_restricted' })
  assert.doesNotThrow(() => f.control.assertOperation(scoped, b))
  f.control.updateRisk({ id: 'legacy-wide', version: 1, scope: f.context.scope, status: 'assessed', level: 'high', source: 'legacy-provider',
    signals: [{ code: 'deny-write', value: 'true', reason: 'legacy scope-level refusal' }], observedAt: new Date().toISOString(), expiresAt: future() })
  await assert.rejects(f.run(operation('writeback', { text: 'new independent request' })), { code: 'risk_restricted' })
})

test('第三方响应省略Session或服务不能扩大新绑定事实，同用户另一Session保持独立许可', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ riskLevels: ['low'] }, 'allow')])]; f.save()
  const second = f.control.bindSession(f.context, 'session-b')
  f.remote.omitScope = true
  f.remote.denied = ['query']
  await assert.rejects(f.run(), { code: 'risk_restricted' })
  f.remote.denied = []
  assert.equal(await withBusinessContext(second, () => f.control.execute(operation(), () => 'session-b-ok')), 'session-b-ok')
  const facts = f.control.status().riskFacts
  assert.equal(facts.length, 2)
  assert.deepEqual(new Set(facts.map(fact => fact.scope.sessionId)), new Set(['session-a', 'session-b']))
  assert.ok(facts.every(fact => fact.scope.serverId === 'soc'))
  assert.equal(f.remote.version, 1)
})

test('关闭自动评估暂停第三方条件，默认处理与纯工具确认继续，重新开启后恢复条件', async t => {
  const f = await fixture(t), provider = f.config.riskAssessment
  f.config.agents[0].toolPolicies = [policy([rule({ riskLevels: ['low'] }, 'allow', { operationIds: ['query'] }), rule({}, 'confirm', { kinds: ['write'] })], 'deny')]; f.save()
  assert.equal(await f.run(), 'ok')
  const riskCalls = f.remote.riskCalls.length
  delete f.config.riskAssessment; f.save()
  await assert.rejects(f.run(), { code: 'tool_policy_denied' })
  await assert.rejects(f.run(operation('writeback')), error => error.code === 'confirmation_required' && /确认/.test(error.message))
  assert.equal(f.remote.riskCalls.length, riskCalls)
  f.config.riskAssessment = provider; f.save()
  assert.equal(await f.run(), 'ok')
})

test('条件确认复用同一次执行并提供明确原因，成功只派发一次且旧全局确认不能被allow绕过', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ operationTags: ['sensitive'] }, 'confirm')])]; f.save()
  f.remote.evidence = { operationTags: ['sensitive'] }
  const reasons = []
  f.control.setConfirmationHandler(async (_context, _operation, _signal, reason) => { reasons.push(reason) })
  assert.equal(await f.run(), 'ok')
  assert.equal(reasons.length, 1)
  assert.match(reasons[0], /第三方危险或敏感操作标签.*确认/)
  assert.deepEqual(f.calls, ['query'])
  f.config.agents[0].toolPolicies = [policy([rule({}, 'allow')])]; f.config.operations[0].confirmation = true; f.save()
  assert.equal(await f.run(), 'ok')
  assert.match(reasons[1], /基础执行设置要求确认/)
  assert.equal(reasons.length, 2)
})

test('确认期间规则、参数或身份变化均不派发，拒绝说明与变化对象保持一致', async t => {
  for (const kind of ['policy', 'args', 'identity']) await t.test(kind, async child => {
    const f = await fixture(child), actual = operation()
    f.config.agents[0].toolPolicies = [policy([rule({}, 'confirm')])]; f.save()
    f.control.setConfirmationHandler(async () => {
      if (kind === 'policy') { f.config.agents[0].toolPolicies = [policy([], 'deny')]; f.save() }
      if (kind === 'args') actual.args.text = 'changed-after-confirmation'
      if (kind === 'identity') f.remote.revoked = true
    })
    await assert.rejects(f.run(actual), { code: kind === 'identity' ? 'identity_invalid' : 'confirmation_invalid' })
    assert.equal(f.calls.length, 0)
  })
})

test('不能把其他参数的旧条件事实用于本次请求，评估等待期间参数变化也被绑定检查拒绝', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ scenarioIds: ['incident'] }, 'allow')], 'deny')]; f.save()
  f.remote.evidence = { scenarioIds: ['incident'] }
  assert.equal(await f.run(operation('query', { text: 'first' })), 'ok')
  f.remote.unavailable = true
  await assert.rejects(f.run(operation('query', { text: 'other' })), { code: 'tool_policy_denied' })
  f.remote.unavailable = false
  const actual = operation('query', { text: 'before-wait' })
  f.remote.gate = async () => { actual.args.text = 'changed-during-assessment' }
  await assert.rejects(f.run(actual), { code: 'authorization_changed' })
  assert.equal(f.calls.length, 1)
})

test('执行中同一绑定的新第三方条件收紧为确认时，未确认的在途请求尽力取消且不重放', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [policy([rule({ operationTags: ['sensitive'] }, 'confirm')])]; f.save()
  f.remote.evidence = { operationTags: [] }
  let started, dispatched = 0
  const entered = new Promise(resolve => { started = resolve })
  const pending = f.run(operation(), signal => {
    dispatched++; started()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await entered
  const fact = f.control.status().riskFacts.find(fact => fact.operationBinding)
  f.control.updateRisk({ ...fact, version: fact.version + 1, conditionEvidence: { operationTags: ['sensitive'] } })
  await assert.rejects(pending, { code: 'permission_revoked' })
  assert.equal(dispatched, 1)
})

test('服务条件写回唯一配置并完整投影；重复服务、空条件列表和表达式拒绝且不破坏原文件', async t => {
  const f = await fixture(t)
  const policies = [policy([rule({ riskLevels: ['unknown'], scenarioIds: ['incident'], operationTags: ['sensitive'] }, 'confirm', { operationIds: ['query'], kinds: ['read'] })], 'deny')]
  const status = (await f.call('status')).value
  const saved = await f.call('saveConfiguration', { revision: status.revision, enabled: true, agents: [{ ...f.config.agents[0], toolPolicies: policies }] })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value.configuration.agents[0].toolPolicies, policies)
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).agents[0].toolPolicies, policies)
  const before = readFileSync(f.path, 'utf8')
  for (const invalid of [[...policies, ...policies], [policy([rule({ scenarioIds: [] }, 'allow')])], [policy([rule({ expression: 'args.secret === true' }, 'deny')])]]) {
    const response = await f.call('saveConfiguration', { revision: saved.value.revision, enabled: true, agents: [{ ...f.config.agents[0], toolPolicies: invalid }] })
    assert.equal(response.ok, false)
    assert.match(response.error.message, /工具条件规则无效/)
    assert.equal(readFileSync(f.path, 'utf8'), before)
  }
})

test('旧本地marker不再判断业务风险，三方无拒绝即可执行，历史marker事实保留但不约束', async t => {
  const f = await fixture(t)
  for (const stage of ['input', 'operation', 'report']) await f.control.inspect(f.context, stage, 'RETIRED-MARKER')
  assert.ok(f.control.status().riskFacts.every(fact => !fact.source.startsWith('local-')))
  for (const stage of ['input', 'operation', 'report']) f.control.updateRisk({ id: `old-${stage}`, version: 1, scope: f.context.scope, status: 'assessed', level: 'high',
    signals: [{ code: 'deny-all', value: 'true', reason: 'retired' }, { code: 'deny-operation', value: 'query', reason: 'retired' }], source: `local-${stage}-marker`, observedAt: new Date().toISOString(), expiresAt: future() })
  assert.equal(await f.run(operation('query', { text: 'RETIRED-MARKER' })), 'ok')
  assert.equal(f.control.status().riskFacts.filter(fact => fact.source.startsWith('local-')).length, 3)
  f.remote.denied = ['query']; f.remote.version++
  await assert.rejects(f.run(), { code: 'risk_restricted' })
})
