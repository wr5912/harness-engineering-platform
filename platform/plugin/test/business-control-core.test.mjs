import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { build } from 'esbuild'

const buildRoot = mkdtempSync(join(tmpdir(), 'business-control-test-build-'))
const entry = new URL('../src/business-control/core.ts', import.meta.url).pathname
await Promise.all(['core.mjs', 'second.mjs'].map(name => build({ entryPoints: [entry], outfile: join(buildRoot, name), bundle: true, platform: 'node', format: 'esm' })))
const { BusinessControl, getBusinessControl, withBusinessContext, currentBusinessContext, matchesOperationTarget, configureBusinessControlStateRoot, sharedInstanceIdentity } = await import(`file://${join(buildRoot, 'core.mjs')}`)
const second = await import(`file://${join(buildRoot, 'second.mjs')}`)
test.after(() => rmSync(buildRoot, { recursive: true, force: true }))

const deadline = () => new Date(Date.now() + 60000).toISOString()
const binding = { workspaceId: 'workspace-test', agentId: 'soc', instanceId: 'shared-runtime', runtimeGeneration: 'generation-1', sourceDigest: 'sha256:' + 'a'.repeat(64) }
const operations = [
  { serverId: 'soc', operationId: 'query', kind: 'read', target: 'https://upstream.example/assets/{id}', method: 'GET', queryParameters: ['page'], schemaDigest: 'schema-1' },
  { serverId: 'soc', operationId: 'writeback', kind: 'write', target: 'https://upstream.example/events/{id}', method: 'PUT', schemaDigest: 'schema-1' },
  { serverId: 'reports', operationId: 'publish', kind: 'publish', target: 'https://upstream.example/reports', method: 'POST' },
]
const operation = (id = 'query') => ({ ...operations.find(item => item.operationId === id),
  target: id === 'query' ? 'https://upstream.example/assets/asset-9?page=2' : id === 'writeback' ? 'https://upstream.example/events/event-9' : 'https://upstream.example/reports', args: { value: 'normal' } })
function authenticatedSnapshot(control, instance = binding) {
  control.recordAgentAuthentication(instance)
  const lease = control.issueSnapshot(instance.instanceId)
  control.acknowledge(instance.instanceId, lease.restrictionVersion, lease.leaseId)
  return control.issueSnapshot(instance.instanceId)
}

async function fixture(t, { remote = true, confirmation = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'business-control-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const upstream = { denied: {}, version: 1, level: 'low', riskCalls: [], revoked: new Set(), trustGate: undefined, unavailable: false, requests: 0, assessInput: undefined }
  let origin
  {
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (upstream.unavailable) { response.writeHead(503).end(); return }
      let result
      if (request.url === '/authenticate') {
        const subjectId = body.credential === 'a' || body.credential === 'a-rotated' ? 'subject-a' : body.credential === 'b' ? 'subject-b' : undefined
        result = { authenticated: !!subjectId, subjectId, credentialId: `credential-${body.credential}`, expiresAt: deadline() }
      } else if (request.url === '/trust') {
        await upstream.trustGate?.()
        result = { valid: !upstream.revoked.has(body.credentialId), subjectId: body.subjectId, expiresAt: deadline() }
      } else {
        upstream.riskCalls.push(body)
        const denied = upstream.assessInput ? upstream.assessInput(body) : upstream.denied[body.subjectId] ?? []
        if (upstream.assessInput) upstream.version++
        result = { scope: { subjectId: body.subjectId, ...(body.sessionId ? { sessionId: body.sessionId } : {}) }, version: upstream.version,
          expiresAt: deadline(), level: upstream.assessInput && denied.length ? 'high' : upstream.level, constraints: { deniedOperations: denied }, reasons: ['synthetic_test'] }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
    t.after(() => { server.closeAllConnections(); server.close() })
  }
  const config = { schemaVersion: 1, enabled: true,
    agents: [{ agentId: 'soc', enabled: true, subjects: ['subject-a', 'subject-b'], actions: ['*'], serverIds: ['soc', 'reports'], sourceDigest: binding.sourceDigest }],
    gateway: { instances: [{ agentId: binding.agentId, instanceId: binding.instanceId, sourceId: 'experiment:EXP-soc-001', sourceDigest: binding.sourceDigest }] },
    operations: operations.map(item => ({ ...item, ...(confirmation && item.kind === 'write' ? { confirmation: true } : {}) })),
    detection: { inputMarkers: ['TEST-INJECT'], operationMarkers: ['TEST-PARAM'], reportMarkers: ['TEST-SENSITIVE'] },
    authentication: { endpoint: `${origin}/authenticate` }, identityTrust: { endpoint: `${origin}/trust` },
    ...(remote ? { riskAssessment: { endpoint: `${origin}/risk`, requiredKinds: ['write', 'publish'] } } : {}) }
  mkdirSync(join(root, 'config'))
  writeFileSync(join(root, 'config', 'business-access.json'), JSON.stringify(config))
  const control = getBusinessControl(root)
  control.registerInstance(binding)
  authenticatedSnapshot(control)
  const identity = id => ({ subject: { id, kind: 'human', identitySource: origin ?? 'fixture' },
    evidence: { issuer: origin ?? 'fixture', externalSubject: id, method: 'bearer', verifiedAt: new Date().toISOString(), expiresAt: deadline(), credentialRef: `credential-${id === 'subject-a' ? 'a' : 'b'}` }, expiresAt: deadline() })
  const a = control.bindSession(control.createContext(identity('subject-a'), binding), 'session-a')
  const b = control.bindSession(control.createContext(identity('subject-b'), binding), 'session-b')
  return { control, root, a, b, config, upstream, origin, identity,
    run: (context, op = operation(), dispatch = () => { upstream.requests++; return 'ok' }) => withBusinessContext(context, () => control.execute(op, dispatch)) }
}

test('独立 bundle 共用 singleton 与 ALS；未启用旧研究模式保留，业务缺上下文拒绝', async t => {
  const f = await fixture(t)
  assert.equal(second.getBusinessControl(f.root), f.control)
  assert.equal(withBusinessContext(f.a, () => second.currentBusinessContext()), f.a)
  assert.equal(currentBusinessContext(), undefined)
  await assert.rejects(f.control.execute(operation(), () => assert.fail('禁止派发')), { code: 'business_context_missing' })
  assert.equal(await withBusinessContext(f.control.managementContext(), () => f.control.execute(operation(), () => 'managed')), 'managed')
  await assert.rejects(withBusinessContext(structuredClone(f.control.managementContext()), () => f.control.execute(operation(), () => assert.fail())), { code: 'identity_unavailable' })
  const legacyRoot = mkdtempSync(join(tmpdir(), 'business-control-legacy-')); t.after(() => rmSync(legacyRoot, { recursive: true, force: true }))
  assert.equal(await getBusinessControl(legacyRoot).execute(operation(), () => 'legacy'), 'legacy')
})

test('无需认证共享实例允许读取，不运行本地内容判定，切换认证方式仍撤回旧主体', async t => {
  const f = await fixture(t)
  f.config.gateway.instances[0].accessMode = 'anonymous'
  writeFileSync(join(f.root, 'config/business-access.json'), JSON.stringify(f.config))
  const subjectId = 'visitor-' + 'x'.repeat(32), expiresAt = deadline()
  const guest = f.control.bindSession(f.control.createContext({
    subject: { id: subjectId, kind: 'human', identitySource: 'gateway-anonymous' },
    evidence: { issuer: 'gateway-anonymous', externalSubject: subjectId, method: 'anonymous',
      verifiedAt: new Date().toISOString(), expiresAt }, expiresAt,
  }, binding), 'guest-session')
  const before = f.upstream.riskCalls.length
  assert.equal(await f.control.inspect(guest, 'input', '普通聊天', undefined, 'session:prompt'), undefined)
  assert.equal(f.upstream.riskCalls.length, before)
  assert.equal(f.control.assert(guest, 'session:prompt').kind, 'allow')
  assert.equal(f.control.assert(guest, 'read').kind, 'allow')
  assert.equal(await f.control.inspect(guest, 'input', 'TEST-INJECT', undefined, 'session:prompt'), undefined)
  assert.deepEqual(f.control.status().riskFacts, [])
  f.config.gateway.instances[0].accessMode = 'authenticated'
  writeFileSync(join(f.root, 'config/business-access.json'), JSON.stringify(f.config))
  assert.throws(() => f.control.assert(guest, 'session:prompt'))
  await assert.rejects(f.control.inspect(guest, 'input', '切换后消息', undefined, 'session:prompt'), { code: 'identity_source_changed' })
  assert.equal(f.upstream.riskCalls.length, before)
})

test('开发调试实例核对固定来源，无控制租约或发布规则仍可聊天', async t => {
  const f = await fixture(t)
  const path = join(f.root, 'config/business-access.json')
  f.config.agents = []
  f.config.gateway.instances[0].identityMode = 'development'
  writeFileSync(path, JSON.stringify(f.config))
  const control = new BusinessControl(f.root)
  assert.equal(control.agentStatus(binding.instanceId).authentication.status, 'not_required')
  assert.equal(control.agentStatus(binding.instanceId).trust.status, 'trusted')
  assert.equal(control.assert(f.a, 'session:prompt').kind, 'allow')
  const snapshot = control.issueSnapshot(binding.instanceId)
  assert.equal(control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId), true)
  assert.equal(control.agentStatus(binding.instanceId).trust.status, 'trusted')
  assert.equal(control.assert(f.a, 'session:prompt').kind, 'allow')
  assert.equal(control.assert(f.a, 'read').kind, 'allow')
  control.recordAgentAuthentication(binding)
  assert.deepEqual(control.agentStatus(binding.instanceId).authentication, { method: 'none', status: 'not_required' })
  f.config.gateway.instances[0].sourceDigest = 'sha256:' + 'b'.repeat(64)
  writeFileSync(path, JSON.stringify(f.config))
  assert.equal(control.agentStatus(binding.instanceId).trust.status, 'mismatch')
  assert.throws(() => control.assert(f.a, 'session:prompt'), { code: 'agent_source_mismatch' })
  f.config.gateway.instances[0].sourceDigest = binding.sourceDigest
  delete f.config.gateway.instances[0].identityMode
  writeFileSync(path, JSON.stringify(f.config))
  assert.equal(control.agentStatus(binding.instanceId).authentication.status, 'unknown', '历史缺字段按发布模式执行')
  assert.throws(() => control.assert(f.a, 'session:prompt'), { code: 'agent_closed' })
})

test('未发布实例全部放行，不访问认证与风险服务，也不受发布动作和确认策略限制', async t => {
  const f = await fixture(t, { confirmation: true })
  f.config.gateway.instances[0].identityMode = 'development'
  f.config.gateway.instances[0].accessMode = 'anonymous'
  Object.assign(f.config.agents[0], { enabled: false, subjects: [], actions: [], serverIds: [], agentTrust: { enabled: false } })
  writeFileSync(join(f.root, 'config/business-access.json'), JSON.stringify(f.config))
  const control = f.control
  const snapshot = control.issueSnapshot(binding.instanceId)
  control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId)
  const context = control.bindSession(control.createContext(sharedInstanceIdentity(binding), binding), 'shared-development')
  f.upstream.unavailable = true
  for (const action of ['agent:access', 'session:prompt', 'read', 'write', 'publish']) assert.equal(control.assert(context, action).kind, 'allow')
  await control.inspect(context, 'input', 'TEST-INJECT')
  assert.equal(await f.run(context, { ...operation('writeback'), operationId: 'unregistered', args: { value: 'TEST-PARAM' } }), 'ok')
  assert.equal(await f.run(context, { ...operation('publish'), args: { fileContentBase64: 'invalid' } }), 'ok')
  assert.deepEqual(f.upstream.riskCalls, [])
  assert.equal(control.agentStatus(binding.instanceId).trust.status, 'trusted')
  assert.throws(() => control.acceptContext({ ...context, sourceDigest: 'different' }), { code: 'instance_binding_mismatch' })
})

test('开发实例更新来源保留同代次会话，发布实例和其他代次不迁移', async t => {
  const f = await fixture(t)
  const path = join(f.root, 'config/business-access.json')
  const next = { ...binding, sourceDigest: 'sha256:' + 'c'.repeat(64) }
  f.config.gateway.instances[0].identityMode = 'development'
  writeFileSync(path, JSON.stringify(f.config))
  f.control.registerInstance(next)
  f.config.gateway.instances[0].sourceDigest = next.sourceDigest
  writeFileSync(path, JSON.stringify(f.config))
  const context = f.control.createContext(f.identity('subject-a'), next)
  assert.equal(f.control.sessionContext(context, 'session-a').sourceDigest, next.sourceDigest)
  assert.throws(() => f.control.acceptContext(f.a), { code: 'instance_binding_mismatch' })
  const newer = { ...next, runtimeGeneration: 'new-generation' }
  f.control.registerInstance(newer)
  assert.throws(() => f.control.sessionContext(f.control.createContext(f.identity('subject-a'), newer), 'session-a'), { code: 'resource_unavailable' })
  f.config.gateway.instances[0].identityMode = 'published'
  writeFileSync(path, JSON.stringify(f.config))
  f.control.registerInstance(binding)
  assert.throws(() => f.control.sessionContext(f.control.createContext(f.identity('subject-a'), binding), 'session-a'), { code: 'resource_unavailable' })
})

test('持久会话和资源严格归属，不认领历史记录，同人凭据轮换不改变归属', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.control.listSessions(f.a), ['session-a'])
  assert.throws(() => f.control.sessionContext(f.a, 'session-b'), { code: 'resource_unavailable' })
  assert.throws(() => f.control.sessionContext(f.a, 'historical'), { code: 'resource_unavailable' })
  f.control.bindResource(f.a, { kind: 'report', id: 'report-a' })
  assert.equal(f.control.assert(f.a, 'read', [{ kind: 'report', id: 'report-a' }]).kind, 'allow')
  assert.throws(() => f.control.assert(f.b, 'read', [{ kind: 'report', id: 'report-a' }]), { code: 'resource_unavailable' })
  const rotated = f.identity('subject-a'); rotated.evidence.credentialRef = 'rotated-credential'
  assert.equal(f.control.sessionContext(f.control.createContext(rotated, binding), 'session-a').subject.id, 'subject-a')
  const restored = new BusinessControl(f.root)
  authenticatedSnapshot(restored)
  assert.equal(restored.contextForSession('session-a').sourceDigest, binding.sourceDigest)
  assert.equal(restored.contextForSession('session-a').identity.evidence.credentialRef, 'rotated-credential')
  assert.equal(restored.contextForSession('historical'), undefined)
  assert.throws(() => restored.acceptContext({ ...f.a, scope: { ...f.a.scope, runtimeGeneration: 'another-generation' } }), { code: 'instance_binding_mismatch' })
})

test('原生子 Session 只保留不可改写的父归属，重载后仍能校验双重归属', async t => {
  const f = await fixture(t)
  const child = f.control.bindSession(f.a, 'child-session', 'session-a')
  assert.equal(child.subject.id, 'subject-a')
  assert.equal(f.control.parentSessionId(f.a, 'child-session'), 'session-a')
  assert.throws(() => f.control.parentSessionId(f.b, 'child-session'), { code: 'resource_unavailable' })
  f.control.bindSession(f.a, 'second-parent')
  assert.throws(() => f.control.bindSession(f.a, 'nested-child', 'child-session'), { code: 'session_invalid' })
  assert.throws(() => f.control.bindSession(f.a, 'child-session', 'second-parent'), { code: 'session_parent_mismatch' })
  assert.throws(() => f.control.bindSession(f.b, 'foreign-child', 'session-a'), { code: 'resource_unavailable' })
  const reloaded = new BusinessControl(f.root)
  authenticatedSnapshot(reloaded)
  assert.equal(reloaded.parentSessionId(f.a, 'child-session'), 'session-a')
})

test('真实提供方认证及撤销，过期凭据拒绝，认证材料不写状态事件', async t => {
  const f = await fixture(t, { remote: true })
  const auth = token => f.control.authenticate({ transport: 'http', method: 'POST', path: '/sessions', headers: { authorization: `Bearer ${token}` } })
  const a = await auth('a'), rotated = await auth('a-rotated')
  assert.equal(a.subject.id, rotated.subject.id)
  await assert.rejects(auth('bad'), { code: 'credential_invalid' })
  assert.equal(await f.run(f.a), 'ok')
  f.upstream.revoked.add('credential-a')
  await assert.rejects(f.run(f.a), { code: 'identity_invalid' })
  assert.equal(f.upstream.requests, 1)
  const expired = structuredClone(f.b); expired.identity.expiresAt = new Date(0).toISOString()
  assert.throws(() => f.control.acceptContext(expired), { code: 'identity_expired' })
  const state = readFileSync(join(f.root, '.local/business-control/state.json'), 'utf8')
  assert.ok(!state.includes('Bearer ')); assert.ok(!state.includes('a-rotated'))
})

test('真实目标模板仅允许声明段与查询键，拒绝主机、方法及 schema 漂移', async t => {
  const f = await fixture(t, { remote: true })
  assert.equal(f.control.operationKind('soc', 'query'), 'read')
  assert.equal(await f.run(f.a), 'ok')
  for (const altered of [
    { target: 'https://upstream.example.evil/assets/asset-9?page=2' }, { target: 'https://upstream.example/assets/asset-9?unexpected=yes' },
    { method: 'POST' }, { schemaDigest: 'schema-2' }, { kind: 'write' },
  ]) await assert.rejects(f.run(f.a, { ...operation(), ...altered }), { code: 'operation_binding_changed' })
  assert.equal(f.upstream.requests, 1)
  assert.equal(matchesOperationTarget('https://upstream.example/assets/{id}', 'https://upstream.example/assets/a%2Fb'), false)
  assert.equal(matchesOperationTarget('https://upstream.example/assets/{id}', 'https://upstream.example/assets/a/other'), false)
})

test('仅限制 A 写回，A 查询和 B 写回继续；清除后重新计算许可', async t => {
  const f = await fixture(t, { remote: true })
  f.upstream.denied['subject-a'] = ['write']; f.upstream.version++
  await assert.rejects(f.run(f.a, operation('writeback')), { code: 'risk_restricted' })
  assert.equal(await f.run(f.a), 'ok')
  assert.equal(await f.run(f.b, operation('writeback')), 'ok')
  assert.equal(f.upstream.requests, 2)
  f.upstream.denied['subject-a'] = []; f.upstream.version++
  // 解除必须先评估，不能把上次拒绝后留存的许可快照恢复为允许。
  await f.control.reassess(f.a)
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  const restriction = f.control.update({ scope: f.a.scope, deniedActions: ['write'], reason: 'manual', active: true })
  await assert.rejects(f.run(f.a, operation('writeback')), { code: 'risk_restricted' })
  f.control.update({ ...restriction, active: false })
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
})

test('组合叶子重验与异步等待后的撤权均在派发前阻断', async t => {
  const f = await fixture(t, { remote: true })
  assert.equal(await f.run(f.a), 'ok')
  f.control.update({ scope: f.a.scope, deniedActions: ['write'], reason: 'between-leaves', active: true })
  await assert.rejects(f.run(f.a, operation('writeback')), { code: 'risk_restricted' })
  assert.equal(f.upstream.requests, 1)
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  f.upstream.trustGate = () => { entered(); return new Promise(resolve => { release = resolve }) }
  const pending = f.run(f.b, operation('writeback'))
  await started
  f.control.update({ scope: f.b.scope, deniedActions: ['write'], reason: 'during-trust-wait', active: true })
  release()
  await assert.rejects(pending, { code: 'risk_restricted' })
  assert.equal(f.upstream.requests, 1)
})

test('风险与限制版本持久单调，迟到事实不覆盖新事实，未知／过期按手动基础兜底', async t => {
  const f = await fixture(t)
  const fact = { id: 'fact-a', version: 5, scope: f.a.scope, status: 'assessed', signals: [{ code: 'deny-write', value: 'true', reason: 'test' }],
    source: 'fixture', observedAt: new Date().toISOString(), expiresAt: deadline() }
  assert.equal(f.control.updateRisk(fact), true)
  const version = f.control.status().restrictionVersion
  assert.equal(f.control.updateRisk({ ...fact, version: 4, signals: [] }), false)
  assert.throws(() => f.control.assert(f.a, 'write'), { code: 'risk_restricted' })
  const restored = new BusinessControl(f.root)
  assert.equal(restored.status().restrictionVersion, version)
  authenticatedSnapshot(restored)
  restored.updateRisk({ ...fact, version: 6, status: 'unknown', signals: [] })
  assert.equal(restored.assert(f.a, 'write').kind, 'allow')
  assert.equal(restored.assert(f.a, 'read').kind, 'allow')
  restored.updateRisk({ ...fact, version: 7, signals: [], expiresAt: new Date(0).toISOString() })
  assert.equal(restored.assert(f.a, 'write').kind, 'allow')
})

test('输入、参数及报告按第三方明确拒绝阻断；第三方恢复后正常内容继续', async t => {
  const f = await fixture(t, { remote: true })
  f.upstream.assessInput = body => JSON.stringify(body.input).includes('TEST-') ? ['*'] : []
  assert.equal(await f.run(f.a, operation('publish')), 'ok')
  await assert.rejects(f.run(f.b, { ...operation('publish'), args: { content: 'TEST-SENSITIVE' } }), { code: 'risk_restricted' })
  assert.equal(f.upstream.requests, 1)
  assert.equal(await f.run(f.b, operation('publish')), 'ok')
  await assert.rejects(f.run(f.a, { ...operation('writeback'), args: { content: 'TEST-PARAM' } }), { code: 'risk_restricted' })
  await f.control.inspect(f.a, 'input', 'TEST-INJECT')
  assert.throws(() => f.control.assert(f.a, 'session:prompt'), { code: 'risk_restricted' })
  await f.control.inspect(f.a, 'input', 'normal restored input')
  assert.equal(f.control.assert(f.a, 'session:prompt').kind, 'allow')
  assert.equal(f.upstream.requests, 2)
  assert.ok(f.control.status().riskFacts.every(fact => !fact.source.startsWith('local-')))
})

test('两秒快照、回执、迟到和重启：未同步实例拒绝，版本不能倒退', async t => {
  const f = await fixture(t)
  const replica = new BusinessControl(f.root, join(f.root, 'lease-replica'))
  replica.registerInstance(binding)
  authenticatedSnapshot(replica)
  const a = replica.bindSession(replica.createContext(f.identity('subject-a'), binding), 'session-a')
  replica.requireSnapshot(binding.instanceId)
  assert.throws(() => replica.assert(a, 'read'), { code: 'control_snapshot_expired' })
  const old = f.control.issueSnapshot(binding.instanceId)
  assert.equal(replica.acceptSnapshot(old), true)
  assert.equal(f.control.acknowledge(binding.instanceId, old.restrictionVersion, old.leaseId), true)
  assert.equal(f.control.status().instances[0].applied, true)
  f.control.update({ scope: f.a.scope, deniedActions: ['write'], active: true, reason: 'restrict' })
  assert.equal(f.control.acknowledge(binding.instanceId, old.restrictionVersion, old.leaseId), false)
  const fresh = f.control.issueSnapshot(binding.instanceId)
  assert.equal(replica.acceptSnapshot(fresh), true)
  assert.equal(replica.acceptSnapshot(old), false)
  assert.equal(replica.assert(a, 'read').kind, 'allow')
  await new Promise(resolve => setTimeout(resolve, 2050))
  assert.throws(() => replica.assert(a, 'read'), { code: 'control_snapshot_expired' })
  assert.equal(replica.acceptSnapshot(fresh), false)
  const restored = new BusinessControl(f.root, join(f.root, 'lease-replica')); restored.requireSnapshot(binding.instanceId)
  assert.throws(() => restored.assert(restored.contextForSession('session-a'), 'read'), { code: 'control_snapshot_expired' })
})

test('必要确认等待同一个调用；撤权、变参使确认失效，成功仅派发一次', async t => {
  const f = await fixture(t, { remote: true, confirmation: true })
  let confirmations = 0
  f.control.setConfirmationHandler(async () => { confirmations++ })
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  assert.equal(confirmations, 1); assert.equal(f.upstream.requests, 1)
  f.control.setConfirmationHandler(async () => {
    f.control.update({ scope: f.a.scope, deniedActions: ['write'], active: true, reason: 'revoked-during-confirmation' })
  })
  await assert.rejects(f.run(f.a, operation('writeback')), { code: 'confirmation_invalid' })
  const changed = operation('writeback')
  f.control.setConfirmationHandler(async () => { changed.args = { value: 'changed' } })
  await assert.rejects(f.run(f.b, changed), { code: 'confirmation_invalid' })
  assert.equal(f.upstream.requests, 1)
})

test('首次风险先同步中心再冻结确认，跨观察等待可答复，冻结前撤权或变参仍零派发', async t => {
  const f = await fixture(t, { confirmation: true })
  const replica = new BusinessControl(f.root, join(f.root, 'first-confirmation-replica'))
  replica.registerInstance(binding); replica.requireSnapshot(binding.instanceId)
  replica.acceptSnapshot(authenticatedSnapshot(f.control))
  const context = replica.bindSession(replica.createContext(f.identity('subject-a'), binding), 'first-confirmation-session')
  const synchronize = () => {
    f.control.importReplicaState(binding, replica.exportReplicaState(binding))
    replica.acceptSnapshot(authenticatedSnapshot(f.control))
  }
  const initialVersion = replica.status().restrictionVersion
  let shownVersion, confirmations = 0
  const heartbeat = setInterval(synchronize, 200); t.after(() => clearInterval(heartbeat))
  replica.setConfirmationHandler(async () => {
    confirmations++; shownVersion = replica.status().restrictionVersion
    assert.ok(shownVersion > initialVersion)
    await new Promise(resolve => setTimeout(resolve, 750))
    assert.equal(replica.status().restrictionVersion, shownVersion)
  }, async () => synchronize())
  const run = op => withBusinessContext(context, () => replica.execute(op, () => { f.upstream.requests++; return 'ok' }))
  assert.equal(await run(operation('writeback')), 'ok')
  assert.equal(confirmations, 1); assert.equal(f.upstream.requests, 1)
  replica.setConfirmationHandler(async () => { confirmations++ }, async () => {
    f.control.updateRestriction({ scope: context.scope, deniedActions: ['write'], active: true, reason: 'revoked-before-display' })
    synchronize()
  })
  await assert.rejects(run(operation('writeback')), { code: 'risk_restricted' })
  assert.equal(confirmations, 1); assert.equal(f.upstream.requests, 1)
  const changed = operation('writeback')
  replica.setConfirmationHandler(async () => { confirmations++ }, async () => { changed.args = { value: 'changed-before-display' }; synchronize() })
  await assert.rejects(run(changed), { code: 'confirmation_invalid' })
  assert.equal(confirmations, 1); assert.equal(f.upstream.requests, 1)
})

test('派发后撤权尽力取消，未知结果不自动重发；插件失效拒绝', async t => {
  const f = await fixture(t, { remote: true })
  let started
  const reached = new Promise(resolve => { started = resolve })
  const pending = f.run(f.a, operation('writeback'), signal => {
    f.upstream.requests++; started()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  await reached
  f.control.update({ scope: f.a.scope, deniedActions: ['write'], active: true, reason: 'revoke-in-flight' })
  await assert.rejects(pending, { code: 'permission_revoked' })
  assert.equal(f.upstream.requests, 1)
  assert.equal(f.control.status().events.at(-1).outcome, 'unknown')
  f.control.setAvailable(false)
  await assert.rejects(f.run(f.b), { code: 'authorization_unavailable' })
})

test('独立状态根的两 Runtime 检测不推进权威版本，中心快照不抹掉本地拒绝', async t => {
  const f = await fixture(t)
  const secondBinding = { ...binding, instanceId: 'runtime-two', runtimeGeneration: 'generation-2' }
  f.control.registerInstance(secondBinding)
  authenticatedSnapshot(f.control, secondBinding)
  const replicas = [binding, secondBinding].map((instance, index) => {
    const replica = new BusinessControl(f.root, join(f.root, `runtime-state-${index}`))
    replica.registerInstance(instance); replica.requireSnapshot(instance.instanceId)
    assert.equal(replica.acceptSnapshot(f.control.issueSnapshot(instance.instanceId)), true)
    return replica
  })
  const localFact = { id: 'replica-risk', version: 1, scope: f.a.scope, status: 'assessed',
    signals: [{ code: 'deny-write', value: 'true', reason: 'local_detection' }], source: 'runtime', observedAt: new Date().toISOString(), expiresAt: deadline() }
  replicas[0].updateRisk(localFact)
  assert.equal(replicas[0].status().restrictionVersion, f.control.status().restrictionVersion)
  assert.equal(replicas[0].acceptSnapshot(f.control.issueSnapshot(binding.instanceId)), true)
  const replicaA = replicas[0].bindSession(replicas[0].createContext(f.identity('subject-a'), binding), 'session-a')
  assert.throws(() => replicas[0].assert(replicaA, 'write'), { code: 'risk_restricted' })
  await f.control.reassess(f.a)
  assert.equal(f.control.assert(f.a, 'write').kind, 'allow')
  assert.equal(replicas[1].status().riskFacts.length, 0)
  f.control.update({ scope: f.b.scope, deniedActions: ['write'], active: true, reason: 'central_restriction' })
  for (let index = 0; index < replicas.length; index++) {
    assert.equal(replicas[index].acceptSnapshot(f.control.issueSnapshot(index ? secondBinding.instanceId : binding.instanceId)), true)
    assert.equal(replicas[index].status().restrictionVersion, f.control.status().restrictionVersion)
  }
  assert.throws(() => replicas[0].assert(replicaA, 'write'), { code: 'risk_restricted' })
  assert.throws(() => replicas[0].update({ scope: replicaA.scope, deniedActions: [], active: false, reason: 'replica-write' }), { code: 'coordinator_write_required' })
  assert.equal(JSON.parse(readFileSync(join(f.root, '.local/business-control/state.json'))).localRiskFacts['replica-risk'], undefined)
  assert.equal(JSON.parse(readFileSync(join(f.root, 'runtime-state-0/state.json'))).localRiskFacts['replica-risk'].version, 1)
})

test('Runtime 默认服务别名跨 bundle 固定到独立 HOME，冲突目录拒绝', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-control-alias-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const control = configureBusinessControlStateRoot(root, join(root, 'runtime-state'))
  assert.equal(second.getBusinessControl(root), control)
  assert.throws(() => configureBusinessControlStateRoot(root, join(root, 'another-state')), { code: 'control_state_root_conflict' })
})

test('两个真实独立 Runtime 进程各自单写，协调器更新仍可应用且本地拒绝保留', async t => {
  const f = await fixture(t)
  const bindings = [binding, { ...binding, instanceId: 'runtime-process-two', runtimeGeneration: 'generation-2' }]
  f.control.registerInstance(bindings[1])
  authenticatedSnapshot(f.control, bindings[1])
  const script = `import { createInterface } from 'node:readline';
    const { getBusinessControl } = await import(process.argv[1]); let control;
    for await (const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      if(request.init) {
        control=getBusinessControl(request.root,request.stateRoot); control.registerInstance(request.binding); control.requireSnapshot(request.binding.instanceId);
        control.acceptSnapshot(request.snapshot); control.updateRisk(request.fact);
      } else control.acceptSnapshot(request.snapshot);
      console.log(JSON.stringify({version:control.status().restrictionVersion,facts:control.status().riskFacts.map(f=>f.id)}));
    }`
  const children = bindings.map((instance, index) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, `file://${join(buildRoot, 'core.mjs')}`], { stdio: ['pipe', 'pipe', 'pipe'] })
    t.after(() => child.kill())
    const lines = createInterface({ input: child.stdout })
    const send = value => new Promise((resolve, reject) => {
      lines.once('line', line => resolve(JSON.parse(line)))
      child.once('error', reject)
      child.stdin.write(JSON.stringify(value) + '\n')
    })
    return { child, send, instance, index }
  })
  for (const { send, instance, index } of children) {
    const reply = await send({ init: true, root: f.root, stateRoot: join(f.root, `process-state-${index}`), binding: instance,
      snapshot: f.control.issueSnapshot(instance.instanceId), fact: { id: `local-process-${index}`, version: 1,
        scope: { ...f.a.scope, instanceId: instance.instanceId, runtimeGeneration: instance.runtimeGeneration }, status: 'assessed',
        signals: [{ code: 'deny-write', value: 'true', reason: 'local' }], source: 'local', observedAt: new Date().toISOString(), expiresAt: deadline() } })
    assert.equal(reply.version, 0)
  }
  f.control.update({ scope: f.a.scope, deniedActions: ['publish'], active: true, reason: 'central-update' })
  for (const { send, instance, index, child } of children) {
    const reply = await send({ snapshot: f.control.issueSnapshot(instance.instanceId) })
    assert.equal(reply.version, 1)
    assert.ok(reply.facts.includes(`local-process-${index}`))
    child.stdin.end()
  }
  const authority = JSON.parse(readFileSync(join(f.root, '.local/business-control/state.json')))
  assert.equal(authority.restrictionVersion, 1)
  assert.deepEqual(authority.localRiskFacts, {})
})

test('关闭配置撤回已有业务访问，资源读取包含在read限制中', async t => {
  const f = await fixture(t)
  f.control.update({ scope: f.a.scope, deniedActions: ['read'], active: true, reason: 'read-restricted' })
  assert.throws(() => f.control.assert(f.a, 'resource'), { code: 'risk_restricted' })
  const version = f.control.status().restrictionVersion
  writeFileSync(join(f.root, 'config/business-access.json'), JSON.stringify({ ...f.config, enabled: false }))
  f.control.configurationChanged()
  assert.equal(f.control.status().restrictionVersion, version + 1)
  await assert.rejects(f.run(f.b), { code: 'business_disabled' })
  assert.throws(() => f.control.assert(f.b, 'read'), { code: 'business_disabled' })
  assert.equal(await f.control.execute(operation(), () => 'legacy-research'), 'legacy-research')
})

test('Runtime归属、风险和执行观察汇入中心，重复同步不推进版本，跨主体覆盖被拒绝', async t => {
  const f = await fixture(t, { remote: true })
  const replica = new BusinessControl(f.root, join(f.root, 'observation-replica'))
  replica.registerInstance(binding)
  authenticatedSnapshot(replica)
  const context = replica.bindSession(replica.createContext(f.identity('subject-a'), binding), 'replica-session-a')
  replica.requireSnapshot(binding.instanceId)
  replica.acceptSnapshot(f.control.issueSnapshot(binding.instanceId))
  assert.equal(await withBusinessContext(context, () => replica.execute(operation(), () => 'real-dispatch-result')), 'real-dispatch-result')
  const observation = replica.exportReplicaState(binding)
  assert.deepEqual(observation.sessions.map(value => value.sessionId), ['replica-session-a'])
  assert.equal(observation.events.at(-1).outcome, 'completed')
  assert.equal(replica.status().restrictionVersion, 0)
  f.control.importReplicaState(binding, observation)
  const version = f.control.status().restrictionVersion
  assert.equal(f.control.contextForSession('replica-session-a').subject.id, 'subject-a')
  assert.equal(f.control.status().events.at(-1).outcome, 'completed')
  assert.equal(f.control.status().riskFacts.length, 1)
  f.control.importReplicaState(binding, observation)
  assert.equal(f.control.status().restrictionVersion, version)
  assert.equal(f.control.status().events.filter(value => value.id === observation.events[0].id).length, 1)
  assert.equal(replica.acceptSnapshot(f.control.issueSnapshot(binding.instanceId)), true)
  const malicious = structuredClone(observation)
  malicious.sessions[0].sessionId = 'session-b'
  await assert.rejects(Promise.resolve().then(() => f.control.importReplicaState(binding, malicious)), { code: 'replica_session_conflict' })
  assert.equal(f.control.status().restrictionVersion, version)
  assert.equal(new BusinessControl(f.root).contextForSession('replica-session-a').identity.evidence.credentialRef, 'credential-a')
  assert.ok(!JSON.stringify(observation).includes('Bearer '))
})

test('每个业务事件自动评估并保留高风险level，解除事实后新事件重新评估恢复', async t => {
  const f = await fixture(t, { remote: true })
  f.upstream.level = 'high'
  await f.control.inspect(f.a, 'input', '正常输入')
  assert.equal(await f.run(f.a), 'ok')
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  assert.equal(await f.run(f.a, operation('publish')), 'ok')
  assert.deepEqual(f.upstream.riskCalls.map(item => item.phase), ['input', 'execute', 'execute', 'report'])
  assert.equal(f.upstream.riskCalls[0].scope.agentId, binding.agentId)
  assert.equal(f.upstream.riskCalls[0].scope.instanceId, binding.instanceId)
  assert.equal(f.upstream.riskCalls[0].scope.runtimeGeneration, binding.runtimeGeneration)
  assert.equal(f.upstream.riskCalls[0].sourceDigest, binding.sourceDigest)
  assert.equal(f.upstream.riskCalls[0].operationBinding, undefined)
  const actual = operation('writeback')
  assert.deepEqual(f.upstream.riskCalls[2].operationBinding, { serverId: actual.serverId, operationId: actual.operationId,
    target: actual.target, method: actual.method, kind: actual.kind })
  assert.deepEqual(f.upstream.riskCalls[2].input, actual.args)
  assert.equal(f.upstream.riskCalls[2].scope.serverId, actual.serverId)
  assert.equal(f.control.status().riskFacts[0].level, 'high')
  assert.equal(f.control.status().riskFacts[0].source, `${f.origin}/risk`)
  assert.deepEqual(f.control.status().riskFacts[0].signals, [])
  f.upstream.denied['subject-a'] = ['write']; f.upstream.version++
  await assert.rejects(f.run(f.a, operation('writeback')), { code: 'risk_restricted' })
  f.upstream.denied['subject-a'] = []; f.upstream.level = 'low'; f.upstream.version++
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  assert.equal(f.control.status().riskFacts[0].level, 'low')
})

test('Agent认证与信任独立于用户凭据及风险版本，撤销、来源错和过期均阻断', async t => {
  const f = await fixture(t)
  const invalidPath = join(f.root, 'config/business-access.json')
  for (const fields of [{ agentAuthentication: { enabled: true, method: 'bearer' } }, { agentAuthentication: { enabled: 1, method: 'hmac-sha256' } },
    { agentTrust: { enabled: 'false' } }, { agentAuthentication: null }, { agentTrust: false }]) {
    writeFileSync(invalidPath, JSON.stringify({ ...f.config, agents: [{ ...f.config.agents[0], ...fields }] }))
    assert.throws(() => f.control.config(), { code: 'control_config_invalid' })
  }
  writeFileSync(invalidPath, JSON.stringify(f.config))
  assert.equal(f.control.agentStatus(binding.instanceId).authentication.status, 'verified')
  assert.equal(f.control.agentStatus(binding.instanceId).trust.status, 'trusted')
  const restored = new BusinessControl(f.root)
  assert.equal(restored.agentStatus(binding.instanceId).authentication.status, 'unknown')
  assert.throws(() => restored.assert(f.a, 'read'), { code: 'agent_authentication_unknown' })
  const configPath = join(f.root, 'config/business-access.json')
  const change = rule => { writeFileSync(configPath, JSON.stringify({ ...f.config, agents: [rule] })); f.control.configurationChanged() }
  change({ ...f.config.agents[0], agentTrust: { enabled: false } })
  assert.equal(f.control.agentStatus(binding.instanceId).trust.status, 'revoked')
  assert.throws(() => f.control.assert(f.a, 'read'), { code: 'agent_trust_revoked' })
  change({ ...f.config.agents[0], sourceDigest: 'sha256:' + 'b'.repeat(64) })
  assert.equal(f.control.agentStatus(binding.instanceId).trust.status, 'trusted', '实例 pin 优先于旧 Agent 默认 pin')
  assert.equal(f.control.assert(f.a, 'read').kind, 'allow')
  writeFileSync(configPath, JSON.stringify({ ...f.config, gateway: { instances: [{ ...f.config.gateway.instances[0], sourceDigest: 'sha256:' + 'b'.repeat(64) }] } }))
  f.control.configurationChanged()
  assert.equal(f.control.agentStatus(binding.instanceId).trust.status, 'mismatch')
  assert.throws(() => f.control.assert(f.a, 'read'), { code: 'agent_source_mismatch' })
  change({ ...f.config.agents[0], agentAuthentication: { enabled: false, method: 'hmac-sha256' } })
  assert.equal(f.control.agentStatus(binding.instanceId).authentication.status, 'disabled')
  change(f.config.agents[0])
  assert.equal(f.control.agentStatus(binding.instanceId).trust.status, 'trusted')
  f.control.update({ scope: f.a.scope, deniedActions: ['write'], active: true, reason: 'A-only' })
  assert.equal(f.control.agentStatus(binding.instanceId).trust.status, 'trusted')
  assert.equal(f.control.assert(f.b, 'read').kind, 'allow')
  await new Promise(resolve => setTimeout(resolve, 2050))
  assert.equal(f.control.agentStatus(binding.instanceId).authentication.status, 'expired')
  assert.equal(f.control.agentStatus(binding.instanceId).trust.status, 'expired')
  assert.throws(() => f.control.assert(f.b, 'read'), { code: 'agent_authentication_expired' })
})

test('风险未启用时正常执行静态许可，显式重评仍不可用；启用后无有效事实仍按手动基础兜底', async t => {
  const f = await fixture(t, { remote: false })
  assert.equal(f.control.assert(f.a, 'write').kind, 'allow')
  assert.equal(f.control.assert(f.a, 'publish').kind, 'allow')
  for (const [stage, input, action] of [['input', 'TEST-INJECT', 'session:prompt'], ['operation', 'TEST-PARAM', 'write'], ['report', 'TEST-SENSITIVE', 'publish']]) {
    assert.equal(await f.control.inspect(f.a, stage, input, undefined, action), undefined)
  }
  assert.equal(await f.run(f.a), 'ok')
  assert.equal(await f.run(f.a, { ...operation('writeback'), args: { value: 'TEST-PARAM' } }), 'ok')
  assert.equal(await f.run(f.a, { ...operation('publish'), args: { value: 'TEST-SENSITIVE' } }), 'ok')
  assert.equal(f.upstream.requests, 3)
  assert.equal(f.upstream.riskCalls.length, 0)
  assert.deepEqual(f.control.status().riskFacts, [])
  await assert.rejects(f.control.reassess(f.a), { code: 'risk_provider_unavailable' })
  const withProvider = await fixture(t)
  assert.equal(withProvider.control.assert(withProvider.a, 'write').kind, 'allow')
  assert.equal(await withProvider.run(withProvider.a, operation('writeback')), 'ok')
})

test('关闭自动风险后旧拒绝事实和检测标记不参与许可，手工限制与静态策略仍生效', async t => {
  const f = await fixture(t)
  f.control.updateRisk({ id: 'retired-input-marker', version: 1, scope: f.a.scope, status: 'assessed', level: 'high', source: 'local-input-marker', observedAt: new Date().toISOString(), expiresAt: deadline(), signals: [{ code: 'deny-all', value: 'true', reason: 'retired' }] })
  const fact = { version: 1, scope: f.a.scope, status: 'assessed', level: 'high', source: 'fixture', observedAt: new Date().toISOString(), expiresAt: deadline() }
  f.control.updateRisk({ ...fact, id: 'old-global-risk', signals: [{ code: 'deny-all', value: 'true', reason: 'old-auto' }] })
  f.control.updateRisk({ ...fact, id: 'old-operation-risk', signals: [{ code: 'deny-operation', value: 'query', reason: 'old-operation-auto' }] })
  assert.throws(() => f.control.assert(f.a, 'read'), { code: 'risk_restricted' })
  delete f.config.riskAssessment
  const configPath = join(f.root, 'config', 'business-access.json')
  const save = () => { writeFileSync(configPath, JSON.stringify(f.config)); f.control.configurationChanged() }
  save()
  const historical = f.control.status().riskFacts
  assert.equal(f.control.assert(f.a, 'read', [], 'TEST-INJECT').kind, 'allow')
  assert.equal(await f.run(f.a), 'ok', '操作ID的旧动态拒绝也不应生效')
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  assert.equal(await f.run(f.a, operation('publish')), 'ok')
  for (const [stage, input] of [['input', 'TEST-INJECT'], ['operation', 'TEST-PARAM'], ['report', 'TEST-SENSITIVE']]) assert.equal(await f.control.inspect(f.a, stage, input), undefined)
  assert.deepEqual(f.control.status().riskFacts, historical, '关闭时保留历史，但不新增或续期自动标记事实')
  const restriction = f.control.updateRestriction({ scope: f.a.scope, deniedActions: ['write'], active: true, reason: 'manual-remains' })
  await assert.rejects(f.run(f.a, operation('writeback')), { code: 'risk_restricted' })
  assert.equal(await f.run(f.a), 'ok')
  assert.equal(await f.run(f.b, operation('writeback')), 'ok')
  assert.equal(f.control.status().restrictions.find(value => value.id === restriction.id).active, true)
  f.config.agents[0].actions = ['read']; save()
  await assert.rejects(f.run(f.b, operation('writeback')), { code: 'action_forbidden' })
  f.config.agents[0].actions = ['*']; f.config.agents[0].serverIds = ['soc']; save()
  await assert.rejects(f.run(f.b, operation('publish')), { code: 'server_forbidden' })
  await assert.rejects(f.run(f.b, { ...operation(), target: 'https://other.example/assets/asset-9' }), { code: 'operation_binding_changed' })
  f.upstream.revoked.add('credential-b')
  await assert.rejects(f.run(f.b), { code: 'identity_invalid' })
  f.upstream.revoked.clear()
  f.config.gateway.instances[0].sourceDigest = 'sha256:' + 'b'.repeat(64); save()
  await assert.rejects(f.run(f.b), { code: 'agent_source_mismatch' })
  assert.equal(f.upstream.riskCalls.length, 0)
})

test('风险开关往返不删除事实，重新开启恢复动态拒绝及未知过期时的手动兜底边界', async t => {
  const f = await fixture(t), provider = { ...f.config.riskAssessment }
  const setRisk = enabled => { if (enabled) f.config.riskAssessment = { ...provider }; else delete f.config.riskAssessment; writeFileSync(join(f.root, 'config', 'business-access.json'), JSON.stringify(f.config)); f.control.configurationChanged() }
  f.upstream.denied['subject-a'] = ['write']
  await assert.rejects(f.run(f.a, operation('writeback')), { code: 'risk_restricted' })
  const denied = f.control.status().riskFacts
  setRisk(false)
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  assert.deepEqual(f.control.status().riskFacts, denied)
  assert.equal(f.upstream.riskCalls.length, 1)
  setRisk(true)
  assert.throws(() => f.control.assert(f.a, 'write'), { code: 'risk_restricted' })
  f.upstream.denied['subject-a'] = []; f.upstream.version++
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  f.upstream.level = 'unknown'; f.upstream.version++
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  const reads = f.upstream.riskCalls.length
  setRisk(false); assert.equal(await f.run(f.a, operation('writeback')), 'ok')
  assert.equal(f.upstream.riskCalls.length, reads)
  setRisk(true); assert.equal(f.control.assert(f.a, 'write').kind, 'allow')
  const current = f.control.status().riskFacts[0]
  f.control.updateRisk({ ...current, version: current.version + 1, status: 'assessed', level: 'low', signals: [], expiresAt: new Date(0).toISOString() })
  assert.equal(f.control.assert(f.a, 'write').kind, 'allow')
  setRisk(false); assert.equal(f.control.assert(f.a, 'write').kind, 'allow')
  setRisk(true); assert.equal(f.control.assert(f.a, 'write').kind, 'allow')
  f.config.riskAssessment.requiredKinds = ['read']; writeFileSync(join(f.root, 'config', 'business-access.json'), JSON.stringify(f.config)); f.control.configurationChanged()
  assert.equal(f.control.assert(f.a, 'read').kind, 'allow')
  assert.equal(f.control.assert(f.a, 'write').kind, 'allow')
  f.config.riskAssessment.endpoint = 'http://127.0.0.1:1/unavailable'; f.config.riskAssessment.requiredKinds = ['write']; writeFileSync(join(f.root, 'config', 'business-access.json'), JSON.stringify(f.config)); f.control.configurationChanged()
  assert.equal(await f.run(f.a, operation('writeback')), 'ok')
})

test('同ID风险按最高版本合并，中心解除可恢复且未确认本地新拒绝仍保留', async t => {
  const f = await fixture(t), replica = new BusinessControl(f.root, join(f.root, 'risk-merge-replica'))
  replica.registerInstance(binding); authenticatedSnapshot(replica)
  const context = replica.bindSession(replica.createContext(f.identity('subject-a'), binding), 'session-a')
  replica.requireSnapshot(binding.instanceId); replica.acceptSnapshot(f.control.issueSnapshot(binding.instanceId))
  const fact = { id: 'same-risk', version: 1, scope: context.scope, status: 'assessed', level: 'high',
    signals: [{ code: 'deny-operation', value: '*', reason: 'first-assessment' }], source: 'provider', observedAt: new Date().toISOString(), expiresAt: deadline() }
  replica.updateRisk(fact); f.control.updateRisk(fact)
  assert.equal(replica.acceptSnapshot(f.control.issueSnapshot(binding.instanceId)), true)
  assert.throws(() => replica.assert(context, 'read'), { code: 'risk_restricted' })
  f.control.updateRisk({ ...fact, version: 2, level: 'low', signals: [] })
  assert.equal(replica.acceptSnapshot(f.control.issueSnapshot(binding.instanceId)), true)
  assert.equal(replica.assert(context, 'read').kind, 'allow')
  replica.updateRisk({ ...fact, version: 3 })
  assert.equal(replica.acceptSnapshot(f.control.issueSnapshot(binding.instanceId)), true)
  assert.throws(() => replica.assert(context, 'write'), { code: 'risk_restricted' })
  replica.updateRisk({ ...fact, version: 4, level: 'low', signals: [] })
  assert.equal(replica.assert(context, 'write').kind, 'allow')
  f.control.importReplicaState(binding, replica.exportReplicaState(binding))
  assert.equal(replica.acceptSnapshot(f.control.issueSnapshot(binding.instanceId)), true)
  assert.equal(replica.status().riskFacts.filter(value => value.id === fact.id).length, 1)
  assert.equal(replica.status().riskFacts.find(value => value.id === fact.id).version, 4)
  assert.equal(replica.updateRisk({ ...fact, version: 3 }), false)
  assert.throws(() => replica.updateRisk({ ...fact, version: 4 }), { code: 'risk_fact_version_conflict' })
  assert.equal(replica.assert(context, 'write').kind, 'allow')
})

test('报告Base64正文交第三方评估，第三方拒绝或格式无效时接收计数为零', async t => {
  const f = await fixture(t), sensitive = Buffer.from('<html>TEST-SENSITIVE</html>').toString('base64')
  f.upstream.assessInput = body => String(body.input).includes('TEST-SENSITIVE') ? ['publish'] : []
  for (const args of [{ fileContentBase64: sensitive }, { body: { fileContentBase64: sensitive } }]) {
    await assert.rejects(f.run(f.a, { ...operation('publish'), args }), { code: 'risk_restricted' })
  }
  assert.equal(f.upstream.requests, 0)
  const normal = '<html>正常可发布报告</html>'
  assert.equal(await f.run(f.a, { ...operation('publish'), args: { body: { fileContentBase64: Buffer.from(normal).toString('base64') } } }), 'ok')
  assert.equal(f.upstream.requests, 1)
  assert.equal(f.upstream.riskCalls.at(-1).input, normal)
  for (const value of ['not-base64!', Buffer.from([0xff, 0xfe]).toString('base64'), Buffer.alloc(1024 * 1024 + 1).toString('base64')]) {
    await assert.rejects(f.run(f.a, { ...operation('publish'), args: { fileContentBase64: value } }), { code: 'report_content_invalid' })
  }
  assert.equal(f.upstream.requests, 1)
})

test('既有匿名历史映射到同实例共享访问，保留原归属与资源并隔离其他实例和登录用户', async t => {
  const f = await fixture(t)
  f.config.gateway.instances[0].accessMode = 'anonymous'
  writeFileSync(join(f.root, 'config/business-access.json'), JSON.stringify(f.config))
  const guest = id => f.control.createContext({ subject: { id, kind: 'human', identitySource: 'gateway-anonymous' },
    evidence: { issuer: 'gateway-anonymous', externalSubject: id, method: 'anonymous', verifiedAt: new Date().toISOString(), expiresAt: deadline() }, expiresAt: deadline() }, binding)
  const oldId = 'visitor-' + 'o'.repeat(32), old = f.control.bindSession(guest(oldId), 'legacy-guest')
  f.control.bindResource(old, { kind: 'attachment', id: 'legacy-data' })
  const visitor = guest('visitor-' + 'n'.repeat(32))
  assert.ok(f.control.listSessions(visitor).includes('legacy-guest'))
  assert.equal(f.control.sessionContext(visitor, 'legacy-guest').subject.id, visitor.subject.id)
  assert.equal(f.control.assert(f.control.sessionContext(visitor, 'legacy-guest'), 'session:read', [{ kind: 'attachment', id: 'legacy-data' }]).kind, 'allow')
  assert.equal(f.control.bindSession(visitor, 'legacy-child', 'legacy-guest').subject.id, visitor.subject.id)
  assert.ok(f.control.listSessions(visitor).includes('legacy-child'))
  assert.equal(f.control.listSessions(f.a).includes('legacy-guest'), false)
  const other = { ...binding, instanceId: 'other-runtime' }; f.control.registerInstance(other)
  assert.throws(() => f.control.sessionContext({ ...visitor, scope: { ...visitor.scope, instanceId: other.instanceId } }, 'legacy-guest'), { code: 'resource_unavailable' })
  assert.equal(f.control.contextForSession('legacy-guest').subject.id, sharedInstanceIdentity(binding).subject.id)
  assert.ok(f.control.listSessions(visitor).includes('session-a'), '同实例的既有登录会话也共享')
  const persisted = JSON.parse(readFileSync(join(f.root, '.local/business-control/state.json'), 'utf8'))
  assert.equal(persisted.sessions['legacy-guest'].subjectId, oldId)
  f.config.gateway.instances[0].accessMode = 'authenticated'
  writeFileSync(join(f.root, 'config/business-access.json'), JSON.stringify(f.config))
  assert.throws(() => f.control.sessionContext(visitor, 'legacy-guest'), { code: 'resource_unavailable' })
})
