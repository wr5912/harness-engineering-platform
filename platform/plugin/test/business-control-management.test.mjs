import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const buildRoot = mkdtempSync(join(tmpdir(), 'business-control-management-build-'))
await build({ stdin: { contents: "export * from './src/business-control/management.ts'; export * from './src/business-control/core.ts'", resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(buildRoot, 'management.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { createBusinessControlHandler, getBusinessControl } = await import(`file://${join(buildRoot, 'management.mjs')}`)
const clientSource = (await build({ entryPoints: ['src/business-control/ui.tsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'], logLevel: 'silent' })).outputFiles[0].text
test.after(() => rmSync(buildRoot, { recursive: true, force: true }))

const owner = { principal: { kind: 'owner' } }
const binding = { workspaceId: 'workspace-test', agentId: 'soc', instanceId: 'shared-runtime', runtimeGeneration: 'generation-1', sourceDigest: 'sha256:' + 'a'.repeat(64) }
const future = () => new Date(Date.now() + 60000).toISOString()
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'business-control-management-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = { version: 1, denied: [], riskCalls: [], businessCalls: 0, probeCalls: 0, gate: undefined }
  const server = createServer(async (request, response) => {
    if (request.method === 'OPTIONS') { remote.probeCalls++; response.writeHead(request.url === '/missing' ? 404 : 405); response.end(); return }
    if (request.url === '/business') { remote.businessCalls++; response.end('{}'); return }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    remote.riskCalls.push(body)
    await remote.gate?.()
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ scope: { subjectId: body.subjectId, sessionId: body.sessionId }, version: remote.version,
      expiresAt: future(), level: remote.denied.length ? 'high' : 'low', constraints: { deniedOperations: remote.denied }, reasons: ['synthetic-test'] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const config = { schemaVersion: 1, enabled: true,
    agents: [{ agentId: 'soc', enabled: true, subjects: ['subject-a', 'subject-b'], actions: ['*'], serverIds: ['soc'], sourceDigest: binding.sourceDigest,
      agentAuthentication: { enabled: true, method: 'hmac-sha256' }, agentTrust: { enabled: true } }],
    authentication: { endpoint: `${origin}/authenticate?private=DO_NOT_RETURN` }, identityTrust: { endpoint: `${origin}/trust` },
    riskAssessment: { endpoint: `${origin}/risk?private=DO_NOT_RETURN` },
    gateway: { sharedSecretFile: '/private/no-return', signingKey: 'DO_NOT_RETURN', instances: [{ agentId: binding.agentId, instanceId: binding.instanceId, sourceId: 'experiment:EXP-soc-001', sourceDigest: binding.sourceDigest }] },
    operations: [{ serverId: 'soc', operationId: 'writeback', kind: 'write', method: 'POST', target: origin + '/business' }],
    preservedValue: { nested: 'DO_NOT_RETURN' } }
  mkdirSync(join(root, 'config'))
  const path = join(root, 'config', 'business-access.json')
  writeFileSync(path, JSON.stringify(config))
  const control = getBusinessControl(root)
  control.registerInstance(binding)
  control.recordAgentAuthentication(binding)
  const initialSnapshot = control.issueSnapshot(binding.instanceId)
  control.acknowledge(binding.instanceId, initialSnapshot.restrictionVersion, initialSnapshot.leaseId)
  const context = subjectId => control.createContext({ subject: { id: subjectId, kind: 'human', identitySource: origin },
    evidence: { issuer: origin, externalSubject: subjectId, method: 'bearer', verifiedAt: new Date().toISOString(), expiresAt: future(), credentialRef: 'opaque-reference' }, expiresAt: future() }, binding)
  control.bindSession(context('subject-a'), 'session-a')
  control.bindSession(context('subject-b'), 'session-b')
  const handler = createBusinessControlHandler(root)
  return { root, path, origin, config, control, remote, handler,
    call: (endpoint, payload = {}, peer = owner) => handler(endpoint, payload, new AbortController().signal, peer) }
}

test('管理读取与写入均要求实际 owner Peer，缺失及请求自报身份拒绝', async t => {
  const f = await fixture(t)
  for (const peer of [undefined, { principal: { kind: 'harness-business' } }, { principal: { kind: 'service' } }]) {
    for (const endpoint of ['status', 'saveConfiguration', 'restrict', 'reassess', 'release']) {
      const response = await f.handler(endpoint, { principal: { kind: 'owner' } }, new AbortController().signal, peer)
      assert.equal(response.ok, false)
      assert.equal(response.error.code, 'forbidden')
    }
  }
  assert.equal(f.remote.riskCalls.length, 0)
  assert.equal(f.control.status().restrictions.length, 0)
})

test('状态只返回可编辑公开投影、真实 ACK 和定时任务未覆盖边界', async t => {
  const f = await fixture(t)
  let value = (await f.call('status')).value
  assert.equal(value.enabled, true)
  assert.equal(value.configuration.operationCount, 1)
  assert.equal(value.coverage.schedules, false)
  assert.equal(value.coverage.leaseMs, 2000)
  assert.equal(value.instances[0].applied, true)
  assert.equal(value.instances[0].identityMode, 'published')
  assert.doesNotMatch(JSON.stringify(value), /DO_NOT_RETURN|sharedSecretFile|signingKey/)
  assert.equal(value.configuration.authentication.endpointHidden, true)
  assert.equal(value.configuration.authentication.endpoint, '')
  assert.match(value.configuration.identityTrust.endpoint, /\/trust$/)
  assert.equal(value.agentStatuses[0].authentication.status, 'verified')
  assert.equal(value.agentStatuses[0].trust.status, 'trusted')
  const snapshot = f.control.issueSnapshot(binding.instanceId)
  assert.ok(f.control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId))
  value = (await f.call('status')).value
  assert.equal(value.instances[0].applied, true)
  assert.equal(value.instances[0].acknowledgement.restrictionVersion, snapshot.restrictionVersion)
  await f.call('reassess', { sessionId: 'session-a', action: 'write' })
  assert.doesNotMatch(JSON.stringify((await f.call('status')).value), /DO_NOT_RETURN|\/risk\?private/)
})

test('开发调试身份模式在管理状态中明确呈现，来源仍取实例登记且无需 Agent 规则', async t => {
  const f = await fixture(t)
  f.config.gateway.instances[0].identityMode = 'development'
  f.config.agents = []
  writeFileSync(f.path, JSON.stringify(f.config))
  const status = (await f.call('status')).value
  assert.equal(status.instances[0].identityMode, 'development')
  assert.equal(status.instances[0].pinnedSourceDigest, binding.sourceDigest)
  assert.deepEqual(status.agentStatuses[0].authentication, { method: 'none', status: 'not_required' })
  assert.equal(status.agentStatuses[0].trust.status, 'trusted')
  assert.equal(status.configuration.agents.length, 0)
})

test('提供方 HTTP 响应探测仅发 OPTIONS，区分路径响应且不改配置或发业务请求', async t => {
  const f = await fixture(t)
  const before = readFileSync(f.path, 'utf8')
  const saved = await f.call('probeProvider', { kind: 'identityTrust' })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.source, 'saved')
  assert.equal(saved.value.network, 'httpResponded')
  assert.equal(saved.value.httpStatus, 405)
  assert.equal(saved.value.contractChecked, false)
  assert.equal(saved.value.businessChecked, false)
  const missing = await f.call('probeProvider', { kind: 'riskAssessment', endpoint: `${f.origin}/missing`, timeoutMs: 60000 })
  assert.equal(missing.value.source, 'draft')
  assert.equal(missing.value.httpStatus, 404)
  assert.equal(missing.value.effectiveTimeoutMs, 3000)
  const forbidden = await f.call('probeProvider', { kind: 'identityTrust' }, { principal: { kind: 'harness-business' } })
  assert.equal(forbidden.error.code, 'forbidden')
  assert.equal((await f.call('probeProvider', { kind: 'identityTrust', endpoint: `${f.origin}/trust?token=private` })).error.code, 'invalid_request')
  assert.equal(f.remote.probeCalls, 2)
  assert.equal(f.remote.riskCalls.length, 0)
  assert.equal(f.remote.businessCalls, 0)
  assert.equal(readFileSync(f.path, 'utf8'), before)
})

test('业务访问配置使用唯一文件与原子 revision 写入，冲突和锁保留当前文件', async t => {
  const f = await fixture(t)
  const first = (await f.call('status')).value
  const payload = { revision: first.revision, enabled: false, agents: first.configuration.agents }
  const snapshot = f.control.issueSnapshot(binding.instanceId)
  assert.ok(f.control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId))
  const saved = await f.call('saveConfiguration', payload)
  assert.equal(saved.ok, true)
  assert.notEqual(saved.value.revision, first.revision)
  assert.ok(saved.value.restrictionVersion > first.restrictionVersion)
  assert.equal(saved.value.instances[0].applied, false)
  const current = readFileSync(f.path, 'utf8')
  const config = JSON.parse(current)
  assert.equal(config.enabled, false)
  assert.deepEqual(config.gateway, f.config.gateway)
  assert.deepEqual(config.riskAssessment, f.config.riskAssessment)
  assert.deepEqual(config.preservedValue, f.config.preservedValue)
  assert.equal((await f.call('saveConfiguration', { ...payload, enabled: true })).error.code, 'conflict')
  assert.equal(readFileSync(f.path, 'utf8'), current)
  writeFileSync(f.path + '.lock', 'other-writer')
  assert.equal((await f.call('saveConfiguration', { ...payload, revision: saved.value.revision })).error.code, 'conflict')
  assert.equal(readFileSync(f.path + '.lock', 'utf8'), 'other-writer')
  assert.equal(readFileSync(f.path, 'utf8'), current)
  rmSync(f.path + '.lock')
  const illegal = await f.call('saveConfiguration', { ...payload, revision: saved.value.revision, gateway: {} })
  assert.equal(illegal.error.code, 'invalid_request')
})

test('基础授权校验合法动作及明确主体，不能写入任意权限字段', async t => {
  const f = await fixture(t)
  const first = (await f.call('status')).value
  for (const agents of [[{ ...first.configuration.agents[0], actions: ['admin:write'] }],
    [{ ...first.configuration.agents[0], subjects: ['*'] }],
    [{ ...first.configuration.agents[0], arbitrary: 'value' }],
    [first.configuration.agents[0], first.configuration.agents[0]]]) {
    assert.equal((await f.call('saveConfiguration', { revision: first.revision, enabled: true, agents })).error.code, 'invalid_request')
  }
})

test('三类配置写回唯一来源，Agent 开关真实生效，用户接入与旧私有字段保留', async t => {
  const f = await fixture(t)
  const old = JSON.parse(readFileSync(f.path, 'utf8'))
  old.authentication.privateSetting = 'preserve-private-authentication'
  old.riskAssessment.privateSetting = 'preserve-private-risk'
  old.operations[0].privateSetting = 'preserve-private-operation'
  old.operations[0].target += '?token=DO_NOT_RETURN'
  old.operations[0].schemaDigest = 'fixed-schema-digest'
  old.operations[0].queryParameters = ['page']
  writeFileSync(f.path, JSON.stringify(old))
  const before = (await f.call('status')).value
  const endpoint = new URL('/api/v1/control/risk/evaluate', old.identityTrust.endpoint).href
  const saved = await f.call('saveConfiguration', { revision: before.revision, enabled: true,
    agents: before.configuration.agents.map(value => ({ ...value, agentAuthentication: { enabled: false, method: 'hmac-sha256' }, agentTrust: { enabled: false } })),
    authentication: { timeoutMs: 750 }, riskAssessment: { endpoint, timeoutMs: 800, testRunId: 'isolated-gateway', requiredKinds: ['read', 'write', 'publish'] },
    operations: before.configuration.operations.map(value => ({ ...value, confirmation: true })),
    detection: { inputMarkers: ['INPUT,WITH,COMMA'], operationMarkers: ['OPERATION-MARKER'], reportMarkers: ['REPORT-MARKER'] } })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const current = JSON.parse(readFileSync(f.path, 'utf8'))
  assert.equal(current.authentication.endpoint, old.authentication.endpoint)
  assert.equal(current.authentication.privateSetting, old.authentication.privateSetting)
  assert.equal(current.riskAssessment.privateSetting, old.riskAssessment.privateSetting)
  assert.equal(current.operations[0].privateSetting, old.operations[0].privateSetting)
  assert.equal(before.configuration.operations[0].targetHidden, true)
  assert.equal(before.configuration.operations[0].target, '')
  assert.equal(current.operations[0].target, old.operations[0].target)
  assert.equal(current.operations[0].schemaDigest, old.operations[0].schemaDigest)
  assert.deepEqual(current.operations[0].queryParameters, old.operations[0].queryParameters)
  assert.equal(current.operations[0].confirmation, true)
  assert.deepEqual(current.riskAssessment.requiredKinds, ['read', 'write', 'publish'])
  assert.deepEqual(current.detection.inputMarkers, ['INPUT,WITH,COMMA'])
  assert.deepEqual(current.gateway, old.gateway)
  assert.equal(saved.value.agentStatuses[0].authentication.status, 'disabled')
  assert.equal(saved.value.agentStatuses[0].trust.status, 'revoked')
  assert.equal(saved.value.configuration.riskAssessment.mode, 'test-mock')
  assert.equal(saved.value.configuration.riskAssessment.endpoint, endpoint)
  assert.doesNotMatch(JSON.stringify(saved.value), /DO_NOT_RETURN|preserve-private|sharedSecretFile|signingKey/)
  assert.equal(f.remote.riskCalls.length, 0, '保存配置不能假造连接验证或自动调用提供方')
  assert.equal((await f.call('saveConfiguration', { revision: before.revision, enabled: true, agents: before.configuration.agents })).error.code, 'conflict')
})

test('实例来源 pin 独立于旧 Agent 默认值及用户提供方配置，信任撤销由真实核心计算', async t => {
  const f = await fixture(t)
  let status = (await f.call('status')).value
  const changed = await f.call('saveConfiguration', { revision: status.revision, enabled: true,
    agents: status.configuration.agents.map(value => ({ ...value, sourceDigest: 'different-source' })), authentication: null, identityTrust: null })
  assert.equal(changed.ok, true)
  assert.equal(changed.value.agentStatuses[0].authentication.status, 'verified')
  assert.equal(changed.value.agentStatuses[0].trust.status, 'trusted')
  assert.equal(changed.value.instances[0].pinnedSourceDigest, binding.sourceDigest)
  assert.equal(changed.value.configuration.authentication.configured, false)
  const mismatched = JSON.parse(readFileSync(f.path, 'utf8'))
  mismatched.gateway.instances[0].sourceDigest = 'sha256:' + 'b'.repeat(64)
  writeFileSync(f.path, JSON.stringify(mismatched))
  status = (await f.call('status')).value
  assert.equal(status.agentStatuses[0].trust.status, 'mismatch')
  const revoked = await f.call('saveConfiguration', { revision: status.revision, enabled: true,
    agents: status.configuration.agents.map(value => ({ ...value, sourceDigest: binding.sourceDigest, agentTrust: { enabled: false } })) })
  assert.equal(revoked.value.agentStatuses[0].trust.status, 'revoked')
  assert.equal(f.remote.riskCalls.length, 0)
})

test('提供方和执行目标不接受凭据或敏感地址，错误不回显请求，失败不改配置', async t => {
  const f = await fixture(t), before = (await f.call('status')).value
  const raw = readFileSync(f.path, 'utf8'), common = { revision: before.revision, enabled: true, agents: before.configuration.agents }
  for (const endpoint of ['http://user:DO_NOT_RETURN@localhost/auth', 'http://localhost/auth?token=DO_NOT_RETURN', 'http://localhost/auth#DO_NOT_RETURN', 'file:///DO_NOT_RETURN']) {
    const response = await f.call('saveConfiguration', { ...common, authentication: { endpoint } })
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'invalid_request')
    assert.doesNotMatch(JSON.stringify(response), /DO_NOT_RETURN/)
    assert.equal(readFileSync(f.path, 'utf8'), raw)
  }
  for (const authentication of [{ timeoutMs: 0 }, { timeoutMs: 60001 }, { apiKey: 'DO_NOT_RETURN' }]) {
    assert.equal((await f.call('saveConfiguration', { ...common, authentication })).error.code, 'invalid_request')
  }
  assert.equal((await f.call('saveConfiguration', { ...common, riskAssessment: { requiredKinds: ['admin'] } })).error.code, 'invalid_request')
  assert.equal((await f.call('saveConfiguration', { ...common, operations: [{ ...before.configuration.operations[0], target: 'http://localhost/data?api_key=DO_NOT_RETURN' }] })).error.code, 'invalid_request')
  assert.equal((await f.call('saveConfiguration', { ...common, agents: [{ ...before.configuration.agents[0], agentAuthentication: { enabled: true, method: 'oauth' } }] })).error.code, 'invalid_request')
  assert.equal(readFileSync(f.path, 'utf8'), raw)
})

test('运行收紧必须限定已有实例和主体，且动作属于基础许可', async t => {
  const f = await fixture(t)
  const scope = { ...binding, subjectId: 'subject-a' }; delete scope.sourceDigest
  for (const invalid of [{ workspaceId: binding.workspaceId, agentId: 'soc' }, { ...scope, subjectId: '*' },
    { ...scope, instanceId: 'missing' }, { ...scope, sessionId: 'session-b' }, { ...scope, unknown: true }]) {
    const response = await f.call('restrict', { scope: invalid, deniedActions: ['write'], reason: 'synthetic-test' })
    assert.equal(response.ok, false)
  }
  assert.equal((await f.call('restrict', { scope, deniedActions: ['admin'], reason: 'synthetic-test' })).error.code, 'invalid_request')
  const result = await f.call('restrict', { scope, deniedActions: ['write'], reason: 'synthetic-test' })
  assert.equal(result.ok, true)
  assert.equal(result.value.restrictions.length, 1)
  assert.deepEqual(result.value.restrictions[0].scope, scope)
  assert.throws(() => f.control.assert(f.control.contextForSession('session-a'), 'write'), { code: 'risk_restricted' })
  assert.equal((await f.call('reassess', { sessionId: 'session-b', action: 'write' })).ok, true)
  assert.equal(f.control.assert(f.control.contextForSession('session-b'), 'write').kind, 'allow')
  assert.equal(f.control.assert(f.control.contextForSession('session-a'), 'read').kind, 'allow')
  const config = JSON.parse(readFileSync(f.path, 'utf8'))
  config.agents[0].actions = ['read', 'session:read']
  writeFileSync(f.path, JSON.stringify(config))
  assert.equal((await f.call('restrict', { scope, deniedActions: ['write'], reason: 'synthetic-test' })).error.code, 'action_forbidden')
})

test('解除先按当前 Session 重评，风险仍高保留限制，恢复不重放业务', async t => {
  const f = await fixture(t)
  const scope = { workspaceId: binding.workspaceId, agentId: binding.agentId, subjectId: 'subject-a', sessionId: 'session-a' }
  const restricted = await f.call('restrict', { scope, deniedActions: ['write', 'publish'], reason: 'synthetic-test' })
  const id = restricted.value.restrictions[0].id
  assert.equal((await f.call('release', { restrictionId: id, sessionId: 'session-b', action: 'write' })).error.code, 'invalid_scope')
  assert.equal(f.remote.riskCalls.length, 0)
  assert.equal((await f.call('release', { restrictionId: id, sessionId: 'session-a', action: 'read' })).error.code, 'invalid_request')
  f.remote.denied = ['write']
  assert.equal((await f.call('release', { restrictionId: id, sessionId: 'session-a', action: 'write' })).error.code, 'risk_restricted')
  assert.equal(f.control.status().restrictions[0].active, true)
  f.remote.denied = []; f.remote.version++
  const released = await f.call('release', { restrictionId: id, sessionId: 'session-a', action: 'write' })
  assert.equal(released.ok, true)
  assert.equal(released.value.restrictions[0].active, false)
  assert.equal(released.value.change.businessReplayed, false)
  assert.deepEqual(f.remote.riskCalls.slice(-2).map(value => value.operation), ['write', 'publish'])
  assert.equal(f.remote.businessCalls, 0)
})

test('恢复保留其他限制；评估等待期间发生的限制修改不能被旧快照覆盖', async t => {
  const f = await fixture(t)
  const scope = { workspaceId: binding.workspaceId, agentId: binding.agentId, subjectId: 'subject-a' }
  await f.call('restrict', { scope, deniedActions: ['write'], reason: 'first' })
  await f.call('restrict', { scope, deniedActions: ['write'], reason: 'second' })
  const [first, second] = f.control.status().restrictions
  const released = await f.call('release', { restrictionId: first.id, sessionId: 'session-a', action: 'write' })
  assert.equal(released.value.change.currentPermission, 'deny')
  assert.equal(f.control.status().restrictions.find(value => value.id === second.id).active, true)
  let unblock, entered
  const started = new Promise(resolve => { entered = resolve })
  f.remote.gate = () => { entered(); return new Promise(resolve => { unblock = resolve }) }
  const pending = f.call('release', { restrictionId: second.id, sessionId: 'session-a', action: 'write' })
  await started
  f.control.updateRestriction({ ...second, reason: 'updated-during-assessment' })
  unblock()
  assert.equal((await pending).error.code, 'conflict')
  assert.equal(f.control.status().restrictions.find(value => value.id === second.id).reason, 'updated-during-assessment')
  assert.equal(f.remote.businessCalls, 0)
})

function uiStatus(revision = 'revision-1') {
  const provider = { configured: true, endpoint: 'http://127.0.0.1:53101/api/v1/control/risk/evaluate', endpointHidden: false, mode: 'test-mock' }
  return { enabled: true, restrictionVersion: 1, instances: [{ ...binding, applied: false }], restrictions: [], riskFacts: [], events: [], revision, sessionTrustFacts: [],
    agentStatuses: [{ agentId: 'soc', instanceId: binding.instanceId, authentication: { method: 'hmac-sha256', status: 'unknown' }, trust: { status: 'unknown', reason: 'agent_authentication_unknown', restrictionVersion: 1 } }],
    configuration: { schemaVersion: 1, enabled: true, agents: [{ agentId: 'soc', enabled: true, subjects: ['subject-a'], actions: ['write'] }],
      authentication: provider, identityTrust: provider, riskAssessment: { ...provider, requiredKinds: ['write', 'publish'] }, detection: { inputMarkers: [], operationMarkers: [], reportMarkers: [] },
      operations: [], providers: { authentication: true, identityTrust: true, riskAssessment: true }, operationCount: 1 },
    coverage: { immediate: true, schedules: false, leaseMs: 2000, acknowledgementDeadlineMs: 2000 } }
}

function page({ active = true, statusHandler, saveHandler, catalogHandler, probeHandler } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], intervals = new Map()
  let cursor = 0, effects = [], changed = false, tree, current = uiStatus(), saveConflict = false
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(clientSource, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), URL,
    window: { confirm: () => true, addEventListener() {}, removeEventListener() {}, requestAnimationFrame: fn => fn() }, document: { querySelector: () => null },
    setInterval: fn => { const id = intervals.size + 1; intervals.set(id, fn); return id }, clearInterval: id => intervals.delete(id) })
  const props = { active, rpc: { async call(channel, endpoint, payload) {
    calls.push({ channel, endpoint, payload })
    if (endpoint === 'agents/list') return catalogHandler ? catalogHandler() : { ok: true, value: {
      agents: [{ id: 'soc', name: '安全运营专家', active_experiment: 'EXP-soc-001', version_count: 1 }, { id: 'helper', name: '业务助手', version_count: 0 }],
      experiments: [{ id: 'EXP-soc-001', agent_id: 'soc' }] } }
    if (endpoint === 'agents/description') return { ok: true, value: { agentId: payload.agent_id, source: { experimentId: 'EXP-soc-001', basis: 'active_experiment' }, name: '安全运营专家', description: '当前资产说明', skills: [] } }
    if (endpoint === 'mcp/control/probeProvider' && probeHandler) return probeHandler(payload)
    if (endpoint === 'mcp/control/status' && statusHandler) return statusHandler()
    if (endpoint === 'mcp/control/saveConfiguration' && saveHandler) return saveHandler(payload)
    if (endpoint === 'mcp/control/saveConfiguration' && saveConflict) return { ok: false, error: { code: 'conflict', message: '配置已变化，草稿保留' } }
    return { ok: true, value: structuredClone(current) }
  } } }
  function render() { let count = 0; do { if (++count > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.BusinessControlPage(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; if (typeof value.type === 'function') return nodes(value.type(value.props)); return [value, ...nodes(value.props?.children)] }
  function text(value) { if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object' && typeof value.type === 'function') return text(value.type(value.props)); return value && typeof value === 'object' ? text(value.props?.children) : typeof value === 'boolean' ? '' : String(value ?? '') }
  const button = title => nodes().find(value => value.type === 'button' && text(value) === title)
  const tab = id => nodes().find(value => value.type === 'button' && value.props?.['data-gateway-tab'] === id)
  render()
  return { render, settle, nodes, text, button, tab, calls, props, intervals, current: value => { current = value }, conflict: () => { saveConflict = true } }
}
function confirmPreview(ui) {
  ui.render()
  assert.ok(ui.button('确认保存业务访问配置'), '预览应列出配置并要求确认保存')
  ui.button('确认保存业务访问配置').props.onClick()
  ui.render()
}

test('运行权限 UI 区分原生定时任务、待验证闭环及真实应用回执', async () => {
  const ui = page(); await ui.settle()
  const rendered = ui.text(ui.render())
  assert.match(rendered, /原生定时任务已开放/)
  assert.match(rendered, /展开范围与来源说明/)
  assert.match(rendered, /自动检测与防护闭环尚待验证/)
  assert.match(rendered, /待核对/)
  assert.match(rendered, /许可租期上限 2 秒/)
  assert.equal(ui.intervals.size, 1)
  ui.props.active = false; ui.render()
  assert.equal(ui.intervals.size, 0)
})

test('一级常驻页面从未激活进入时发起读取，慢响应不会被每秒轮询永远丢弃', async () => {
  const replies = []
  const ui = page({ active: false, statusHandler: () => new Promise(resolve => replies.push(resolve)) })
  assert.equal(ui.calls.length, 0)
  ui.props.active = true; ui.render()
  const statusCalls = () => ui.calls.filter(call => call.endpoint === 'mcp/control/status')
  assert.equal(statusCalls().length, 1)
  for (const poll of ui.intervals.values()) { poll(); poll(); poll() }
  assert.equal(statusCalls().length, 1, '前一读取未完成时不重复发起或推进请求编号')
  replies[0]({ ok: true, value: uiStatus() }); await ui.settle()
  assert.match(ui.text(ui.render()), /智能体身份/)
  assert.doesNotMatch(ui.text(ui.render()), /正在读取统一网关状态/)
  for (const poll of ui.intervals.values()) poll()
  assert.equal(statusCalls().length, 2)
})

test('状态刷新失败时旧事实在四视图中明确标记为历史读取', async () => {
  let fail = false
  const ui = page({ statusHandler: () => fail ? { ok: false, error: { message: '状态读取失败' } } : { ok: true, value: uiStatus() } })
  await ui.settle()
  fail = true; ui.button('刷新状态').props.onClick(); await ui.settle()
  for (const tab of ['overview', 'identity', 'risk', 'authorization']) {
    ui.tab(tab).props.onClick(); ui.render()
    assert.match(ui.text(ui.render()), /上次成功读取的状态.*当前许可需重新核对/)
  }
})

test('保存中离开统一网关，后台回执完成后返回清除忙状态并保留保存事实', async () => {
  let resolveSave, savedPayload, resolveOldStatus, holdStatus = false
  const saved = uiStatus('revision-saved'); saved.enabled = false; saved.configuration.enabled = false
  const ui = page({ saveHandler: payload => { savedPayload = payload; return new Promise(resolve => { resolveSave = resolve }) },
    statusHandler: () => holdStatus ? new Promise(resolve => { resolveOldStatus = resolve }) : Promise.resolve({ ok: true, value: savedPayload ? saved : uiStatus() }) })
  await ui.settle()
  ui.tab('authorization').props.onClick(); ui.render()
  const open = () => ui.nodes(ui.nodes().find(value => value.type === 'label' && ui.text(value) === '开放即时业务访问')).find(value => value.type === 'input')
  open().props.onChange({ target: { checked: false } }); ui.render()
  holdStatus = true; ui.button('刷新状态').props.onClick()
  ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); confirmPreview(ui)
  assert.equal(ui.button('刷新状态').props.disabled, true)
  ui.props.active = false; ui.render()
  assert.equal(ui.intervals.size, 0)
  resolveSave({ ok: true, value: saved }); await ui.settle()
  assert.equal(ui.button('刷新状态').props.disabled, false)
  assert.equal(ui.button('放弃草稿并读取当前配置'), undefined)
  assert.equal(open().props.checked, false)
  assert.match(ui.text(ui.render()), /配置已保存/)
  resolveOldStatus({ ok: true, value: uiStatus() }); await ui.settle()
  assert.equal(open().props.checked, false, '离开前发出的旧读取不能覆盖保存回执')
  holdStatus = false; ui.props.active = true; ui.render(); await ui.settle()
  assert.equal(ui.button('刷新状态').props.disabled, false)
  assert.equal(open().props.checked, false)
  assert.equal(ui.button('保存业务访问配置'), undefined)
  assert.doesNotMatch(ui.text(ui.render()), /当前草稿已保留/)
  assert.equal(savedPayload.revision, 'revision-1')
  assert.equal(savedPayload.enabled, false)
})

test('外部更新和保存冲突均保留运行权限草稿，刷新不会静默覆盖', async () => {
  const ui = page(); await ui.settle()
  ui.tab('authorization').props.onClick(); ui.render()
  const textarea = () => ui.nodes().find(value => value.type === 'textarea' && value.props['aria-label'] === 'Agent 规则 JSON')
  const draft = '[{"agentId":"soc","enabled":true,"subjects":["subject-a"],"actions":["read"]}]'
  textarea().props.onChange({ target: { value: draft } }); ui.render()
  ui.current(uiStatus('revision-2')); ui.conflict()
  const form = ui.nodes().find(value => value.type === 'form' && ui.nodes(value).some(node => node.type === 'textarea'))
  form.props.onSubmit({ preventDefault() {} }); confirmPreview(ui); await ui.settle()
  assert.equal(textarea().props.value, draft)
  assert.match(ui.text(ui.render()), /当前草稿已保留/)
  assert.equal(ui.button('预览配置').props.disabled, true)
  assert.equal(ui.calls.find(call => call.endpoint === 'mcp/control/saveConfiguration').payload.revision, 'revision-1')
  await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.equal(textarea().props.value, draft)
  ui.button('放弃草稿并读取当前配置').props.onClick(); ui.render()
  assert.notEqual(textarea().props.value, draft)
  assert.equal(ui.text(ui.render()).includes('当前草稿已保留'), false)
})

test('统一网关四视图边界明确，身份与配置分离，风险未知不冒充低风险', async () => {
  const ui = page(); await ui.settle()
  assert.equal(ui.nodes().find(value => value.type === 'h1' && ui.text(value) === '统一网关')?.type, 'h1')
  assert.deepEqual(ui.nodes().filter(value => value.props?.role === 'tab').map(value => ui.text(value)), ['运行概览', '智能体身份', '风险评估', '访问控制'])
  assert.equal(ui.tab('overview').props['aria-selected'], true)
  assert.equal(ui.nodes().filter(value => value.type === 'fieldset' && value.props.className !== 'harness-gateway-subject-picker').length, 0)
  assert.match(ui.text(ui.render()), /实例与身份回执/)
  ui.tab('identity').props.onClick(); ui.render()
  assert.deepEqual(ui.nodes().filter(value => value.type === 'legend').map(value => ui.text(value)), ['1．智能体身份'])
  assert.match(ui.text(ui.render()), /安全运营专家/)
  assert.match(ui.text(ui.render()), /代次/)
  assert.match(ui.text(ui.render()), /待核对/)
  assert.match(ui.text(ui.render()), /配置智能体身份与可信来源/)
  const identity = ui.nodes().find(value => value.type === 'fieldset')
  assert.ok(ui.nodes(identity).some(value => value.props?.['aria-label'] === '认证方式与凭据'))
  assert.ok(ui.nodes(identity).some(value => value.props?.['aria-label'] === '可信来源与身份状态'))
  assert.equal(ui.button('身份信任'), undefined)
  assert.match(ui.text(ui.render()), /辅助：接入用户认证与状态核验/)
  assert.doesNotMatch(ui.text(ui.render()), /测试 fixture ID（可选）/)
  ui.tab('risk').props.onClick(); ui.render()
  const content = ui.text(ui.render())
  assert.match(content, /当前没有可用于判断许可的评估事实/)
  assert.match(content, /选择会话并辅助重评/)
  assert.match(content, /查看评估依据（0）/)
  assert.match(content, /按业务事件实时自动评估各 Agent/)
  assert.doesNotMatch(content, /当前限制/)
  assert.match(content, /测试模拟提供方/)
  assert.doesNotMatch(content, /低风险（已评估范围）/)
  ui.tab('authorization').props.onClick(); ui.render()
  assert.ok(ui.nodes().some(value => value.props?.['aria-label'] === '工具与资源操作允许清单'))
  const value = uiStatus('revision-2')
  value.riskFacts = [{ id: 'agent-risk', version: 1, scope: { workspaceId: binding.workspaceId, agentId: 'soc' }, status: 'assessed', level: 'high',
    source: 'test', signals: [], observedAt: new Date().toISOString(), expiresAt: future() }]
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  ui.tab('overview').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /高风险（已评估范围）/)
  assert.match(ui.text(ui.render()), /人工限制 0/)
  value.riskFacts[0].expiresAt = new Date(Date.now() - 1).toISOString()
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /评估已过期/)
  const overview = () => ui.nodes().find(node => node.props?.['data-summary'] === 'risk')
  assert.equal(ui.text(overview()), '评估已过期')
  ui.tab('risk').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /当前评估已超过有效期/)
  assert.match(ui.text(ui.render()), /不能据此推断访问已允许或已阻止/)
  value.riskFacts[0].expiresAt = future(); value.riskFacts[0].level = 'unknown'; value.riskFacts[0].status = 'unknown'
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.equal(ui.text(overview()), '存在未知评估')
  value.riskFacts[0].level = 'low'; value.riskFacts[0].status = 'assessed'
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.equal(ui.text(overview()), '已评估范围内 0 项高风险')
})

test('身份撤销和风险提供方共用草稿，三类配置保存保持原revision及持久字段兼容', async () => {
  const ui = page(); await ui.settle()
  ui.tab('identity').props.onClick(); ui.render()
  const trust = ui.nodes().find(value => value.type === 'label' && ui.text(value).includes('允许该智能体身份'))
  ui.nodes(trust).find(value => value.type === 'input').props.onChange({ target: { checked: false } }); ui.render()
  ui.tab('risk').props.onClick(); ui.render()
  const providerLabel = ui.nodes().find(value => value.type === 'label' && ui.text(value) === 'Agent 风险评估提供方超时（毫秒）')
  ui.nodes(providerLabel).find(value => value.type === 'input').props.onChange({ target: { value: '950' } }); ui.render()
  ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); confirmPreview(ui)
  await ui.settle()
  const call = ui.calls.find(value => value.endpoint === 'mcp/control/saveConfiguration')
  assert.equal(call.payload.revision, 'revision-1')
  assert.equal(call.payload.agents[0].agentTrust.enabled, false)
  assert.equal(call.payload.riskAssessment.timeoutMs, 950)
  assert.deepEqual(Array.from(call.payload.riskAssessment.requiredKinds), ['write', 'publish'])
  assert.ok(Object.hasOwn(call.payload, 'operations'))
  assert.ok(Object.hasOwn(call.payload, 'detection'))
  assert.equal(ui.calls.filter(value => value.endpoint === 'mcp/control/reassess').length, 0)
})

test('访问范围从已登记操作选择服务与动作，刷新保留草稿并按所选值保存', async () => {
  const ui = page(); await ui.settle()
  ui.tab('authorization').props.onClick(); ui.render()
  const status = uiStatus()
  status.configuration.agents[0].serverIds = ['inspection']
  status.configuration.agents[0].actions = ['read']
  status.configuration.operations = [
    { serverId: 'inspection', operationId: 'list', kind: 'read', method: 'TOOLS/CALL', target: 'http://127.0.0.1/inspection' },
    { serverId: 'reports', operationId: 'create', kind: 'write', method: 'POST', target: 'http://127.0.0.1/reports' },
  ]
  ui.current(status); await ui.button('刷新状态').props.onClick(); await ui.settle()
  const group = label => ui.nodes().find(value => value.props?.role === 'group' && value.props['aria-label'] === label)
  const checkbox = (label, name) => ui.nodes(group(label)).find(value => value.type === 'label' && ui.text(value).includes(name)).props.children[0]
  assert.equal(checkbox('允许访问的服务 1', 'inspection').props.checked, true)
  checkbox('允许访问的服务 1', 'reports').props.onChange({ target: { checked: true } }); ui.render()
  checkbox('允许的动作 1', '写入（write）').props.onChange({ target: { checked: true } }); ui.render()
  const method = () => ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '方法 1')
  assert.equal(method().props.value, 'TOOLS/CALL')
  method().props.onChange({ target: { value: 'GET' } }); ui.render()
  await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.equal(checkbox('允许访问的服务 1', 'reports').props.checked, true)
  assert.equal(checkbox('允许的动作 1', '写入（write）').props.checked, true)
  assert.equal(method().props.value, 'GET')
  ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); confirmPreview(ui)
  await ui.settle()
  const saved = ui.calls.find(value => value.endpoint === 'mcp/control/saveConfiguration').payload
  assert.deepEqual(Array.from(saved.agents[0].serverIds), ['inspection', 'reports'])
  assert.deepEqual(Array.from(saved.agents[0].actions), ['read', 'write'])
  assert.equal(saved.operations[0].method, 'GET')
})

test('不限定服务与限定为空保持不同授权语义，当前配置中已移除的服务仍可取消', async () => {
  const ui = page(); await ui.settle()
  ui.tab('authorization').props.onClick(); ui.render()
  const status = uiStatus()
  status.configuration.agents[0].serverIds = ['old-service']
  ui.current(status); await ui.button('刷新状态').props.onClick(); await ui.settle()
  const group = () => ui.nodes().find(value => value.props?.role === 'group' && value.props['aria-label'] === '允许访问的服务 1')
  const checkbox = label => ui.nodes(group()).find(value => value.type === 'label' && ui.text(value).includes(label)).props.children[0]
  assert.equal(checkbox('old-service').props.checked, true)
  checkbox('old-service').props.onChange({ target: { checked: false } }); ui.render()
  const draft = () => JSON.parse(ui.nodes().find(value => value.props?.['aria-label'] === 'Agent 规则 JSON').props.value)[0]
  assert.deepEqual(Array.from(draft().serverIds), [])
  checkbox('仅允许所选服务').props.onChange({ target: { checked: false } }); ui.render()
  assert.equal(Object.hasOwn(draft(), 'serverIds'), false)
})

test('统一网关四视图切换保留草稿，运行概览仅在首页呈现', async () => {
  const ui = page(); await ui.settle()
  const selectedFieldsets = () => ui.nodes().filter(value => value.type === 'fieldset' && value.props.className !== 'harness-gateway-subject-picker')
  assert.ok(ui.nodes().some(value => value.props?.['aria-label'] === '统一网关状态概览'))
  assert.equal(selectedFieldsets().length, 0)
  assert.ok(ui.nodes().some(value => value.props?.['aria-label'] === '运行概览'))
  ui.tab('identity').props.onClick(); ui.render()
  assert.equal(selectedFieldsets().length, 1)
  assert.match(ui.text(selectedFieldsets()[0]), /1．智能体身份/)
  assert.equal(ui.nodes().some(value => value.props?.['aria-label'] === '运行概览'), false)
  const pin = () => ui.nodes(ui.nodes().find(value => value.type === 'label' && ui.text(value).includes('旧实例默认固定来源'))).find(value => value.type === 'input')
  pin().props.onChange({ target: { value: 'sha256:draft-source' } }); ui.render()
  ui.tab('risk').props.onClick(); ui.render()
  assert.match(ui.text(selectedFieldsets()[0]), /2．风险评估/)
  assert.match(ui.text(ui.render()), /有未保存更改/)
  assert.ok(ui.nodes(ui.tab('identity')).some(value => value.props?.['aria-label'] === '有未保存更改'))
  ui.tab('identity').props.onClick(); ui.render()
  assert.equal(pin().props.value, 'sha256:draft-source')
  assert.equal(ui.nodes().filter(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置').length, 1)
  ui.tab('overview').props.onClick(); ui.render()
  assert.ok(ui.nodes().some(value => value.props?.['aria-label'] === '运行概览'))
  assert.equal(selectedFieldsets().length, 0)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('访问控制按单个智能体编辑，预览与确认保存分开', async () => {
  const ui = page(); await ui.settle()
  assert.ok(ui.nodes().some(value => value.props?.className === 'harness-gateway-mobile-status'))
  assert.ok(ui.nodes().some(value => value.props?.className === 'harness-table-scroll harness-gateway-overview-table'))
  ui.tab('authorization').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '业务智能体')?.props.value, '0')
  assert.ok(ui.nodes().some(value => value.props?.className === 'harness-gateway-switch-row'))
  const open = ui.nodes().find(value => value.type === 'label' && ui.text(value) === '开放即时业务访问')
  ui.nodes(open).find(value => value.type === 'input').props.onChange({ target: { checked: false } }); ui.render()
  const form = () => ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置')
  form().props.onSubmit({ preventDefault() {} }); ui.render()
  assert.ok(ui.nodes().some(value => value.props?.role === 'dialog'))
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
  ui.button('返回修改').props.onClick(); ui.render()
  assert.equal(ui.nodes().some(value => value.props?.role === 'dialog'), false)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
  form().props.onSubmit({ preventDefault() {} }); confirmPreview(ui); await ui.settle()
  assert.equal(ui.calls.filter(value => value.endpoint === 'mcp/control/saveConfiguration').length, 1)
  assert.equal(ui.calls.find(value => value.endpoint === 'mcp/control/saveConfiguration').payload.enabled, false)
})

test('运行限制可多选已获准用户，按用户分别收紧且多选不携带 Session ID', async () => {
  const ui = page(); await ui.settle()
  const status = uiStatus()
  status.configuration.agents[0].subjects = ['subject-a', 'subject-b']
  ui.current(status); await ui.button('刷新状态').props.onClick(); await ui.settle()
  const picker = () => ui.nodes().find(value => value.type === 'fieldset' && value.props.className === 'harness-gateway-subject-picker')
  const option = id => ui.nodes(picker()).find(value => value.type === 'label' && ui.text(value).includes(id)).props.children[0]
  const session = () => ui.nodes().find(value => value.type === 'input' && value.props.maxLength === 500 && value.props.disabled !== undefined)
  option('subject-a').props.onChange({ target: { checked: true } }); ui.render()
  session().props.onChange({ target: { value: 'session-a' } }); ui.render()
  option('subject-b').props.onChange({ target: { checked: true } }); ui.render()
  assert.equal(session().props.value, '')
  assert.equal(session().props.disabled, true)
  const reason = ui.nodes().find(value => value.type === 'label' && ui.text(value).includes('收紧依据'))
  ui.nodes(reason).find(value => value.type === 'input').props.onChange({ target: { value: '人工风险限制' } }); ui.render()
  const form = ui.nodes().find(value => value.type === 'form' && value.props.className === 'harness-composition-editor')
  form.props.onSubmit({ preventDefault() {} }); await ui.settle()
  const calls = ui.calls.filter(value => value.endpoint === 'mcp/control/restrict')
  assert.deepEqual(calls.map(value => value.payload.scope.subjectId), ['subject-a', 'subject-b'])
  assert.ok(calls.every(value => !Object.hasOwn(value.payload.scope, 'sessionId')))
  assert.match(ui.text(ui.render()), /2 \/ 2 位接入用户的限制已保存/)
})

test('跨页保存先校验隐藏配置并定位错误页，HTTP 探测仅发送只读请求', async () => {
  const ui = page({ probeHandler: () => ({ ok: true, value: { network: 'httpResponded', httpStatus: 405, checkedAt: new Date().toISOString(), durationMs: 3, contractChecked: false, businessChecked: false } }) }); await ui.settle()
  ui.tab('identity').props.onClick(); ui.render()
  const endpoint = ui.nodes().find(value => value.type === 'input' && value.props['data-gateway-field'] === 'authentication-endpoint')
  endpoint.props.onChange({ target: { value: 'ftp://invalid' } }); ui.render()
  ui.tab('risk').props.onClick(); ui.render()
  ui.button('预览配置').props.onClick(); ui.render()
  assert.equal(ui.tab('identity').props['aria-selected'], true)
  assert.match(ui.text(ui.render()), /提供方地址必须是无凭据/)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
  const corrected = ui.nodes().find(value => value.type === 'input' && value.props['data-gateway-field'] === 'authentication-endpoint')
  corrected.props.onChange({ target: { value: 'http://127.0.0.1:53101/api/v1/control/authenticate' } }); ui.render()
  ui.button('测试 HTTP 响应').props.onClick(); await ui.settle()
  const probe = ui.calls.find(value => value.endpoint === 'mcp/control/probeProvider')
  assert.equal(probe.payload.kind, 'authentication')
  assert.equal(probe.payload.endpoint, 'http://127.0.0.1:53101/api/v1/control/authenticate')
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('空配置仍有三类功能和首个 Agent 配置入口，不假造实例或风险状态', async () => {
  const ui = page(); await ui.settle()
  const empty = uiStatus()
  empty.enabled = false; empty.configuration.enabled = false; empty.configuration.agents = []; empty.instances = []; empty.agentStatuses = []
  ui.current(empty); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /配置尚无目标实例/)
  assert.doesNotMatch(ui.text(ui.render()), /配置 0\/0 已应用/)
  ui.tab('identity').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /尚未配置业务 Agent/)
  assert.match(ui.text(ui.render()), /尚无评估/)
  assert.ok(ui.button('配置首个 Agent'))
  ui.button('配置首个 Agent').props.onClick(); ui.render()
  assert.equal(ui.tab('identity').props['aria-selected'], true)
  ui.tab('authorization').props.onClick(); ui.render()
  const agents = JSON.parse(ui.nodes().find(value => value.type === 'textarea' && value.props['aria-label'] === 'Agent 规则 JSON').props.value)
  assert.equal(agents.length, 1)
  assert.equal(agents[0].enabled, false)
  assert.equal(agents[0].agentTrust.enabled, false)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('选择器复用资产列表，搜索保留已选值，更换身份不继承来源或自动开放', async () => {
  let saved
  const ui = page({ saveHandler: payload => { saved = payload; return { ok: true, value: uiStatus('saved') } } }); await ui.settle()
  ui.tab('identity').props.onClick(); ui.render()
  const selector = () => ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '选择智能体 1')
  const search = () => ui.nodes().find(value => value.type === 'input' && value.props.type === 'search')
  const id = () => ui.nodes(ui.nodes().find(value => value.type === 'label' && ui.text(value) === 'Agent ID')).find(value => value.type === 'input')
  const draft = () => { ui.tab('authorization').props.onClick(); ui.render()
    const value = JSON.parse(ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 规则 JSON').props.value)
    ui.tab('identity').props.onClick(); ui.render(); return value }
  assert.equal(id().props.readOnly, true)
  assert.match(ui.text(selector()), /安全运营专家（soc）/)
  assert.match(ui.text(ui.render()), /EXP-soc-001/)
  assert.match(ui.text(ui.render()), /shared-runtime/)
  search().props.onChange({ target: { value: '业务助手' } }); ui.render()
  assert.match(ui.text(selector()), /安全运营专家（soc）/)
  assert.match(ui.text(selector()), /业务助手（helper）/)
  search().props.onChange({ target: { value: 'no-match' } }); ui.render()
  assert.equal(selector().props.value, 'soc')
  assert.doesNotMatch(ui.text(selector()), /业务助手/)
  ui.nodes(ui.nodes().find(value => value.type === 'label' && ui.text(value).includes('旧实例默认固定来源'))).find(value => value.type === 'input').props.onChange({ target: { value: 'sha256:old-source' } }); ui.render()
  const trust = ui.nodes().find(value => value.type === 'label' && ui.text(value).includes('允许该智能体身份'))
  ui.nodes(trust).find(value => value.type === 'input').props.onChange({ target: { checked: true } }); ui.render()
  search().props.onChange({ target: { value: 'HELPER' } }); ui.render()
  selector().props.onChange({ target: { value: 'helper' } }); ui.render()
  assert.equal(id().props.value, 'helper')
  assert.equal(draft()[0].enabled, false)
  assert.equal(draft()[0].agentTrust.enabled, false)
  assert.equal(Object.hasOwn(draft()[0], 'sourceDigest'), false)
  ui.tab('risk').props.onClick(); ui.render()
  ui.tab('identity').props.onClick(); ui.render()
  await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.equal(selector().props.value, 'helper')
  ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); confirmPreview(ui); await ui.settle()
  assert.equal(saved.agents[0].agentId, 'helper')
  assert.equal(saved.agents[0].enabled, false)
  assert.equal(Object.hasOwn(saved.agents[0], 'name'), false)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/reassess'), false)
})

test('已配置身份缺失或资产列表读取失败时保留原值，重试与空目录分别呈现', async () => {
  let mode = 'missing'
  const ui = page({ catalogHandler: () => mode === 'failure' ? { ok: false, error: { code: 'unavailable', message: '资产目录暂不可用' } }
    : { ok: true, value: { agents: mode === 'empty' ? [] : [{ id: 'helper', name: '业务助手' }], experiments: [] } } }); await ui.settle()
  ui.tab('identity').props.onClick(); ui.render()
  const selector = () => ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '选择智能体 1')
  assert.equal(selector().props.value, 'soc')
  assert.match(ui.text(selector()), /soc（当前未找到，保留配置）/)
  assert.match(ui.text(ui.render()), /原配置已保留/)
  mode = 'failure'; await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.equal(selector().props.value, 'soc')
  assert.equal(selector().props.disabled, true)
  assert.match(ui.text(ui.render()), /资产目录暂不可用/)
  mode = 'empty'; ui.button('重试智能体列表').props.onClick(); await ui.settle()
  assert.equal(selector().props.disabled, false)
  assert.equal(selector().props.value, 'soc')
  assert.match(ui.text(ui.render()), /当前没有可选智能体/)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('切页后的迟到资产列表不会覆盖新列表，选择器不因后台读取改写草稿', async () => {
  const pending = []
  const ui = page({ catalogHandler: () => new Promise(resolve => pending.push(resolve)) }); await ui.settle()
  ui.props.active = false; ui.render()
  ui.props.active = true; ui.render()
  pending[1]({ ok: true, value: { agents: [{ id: 'soc', name: '当前目录' }], experiments: [] } }); await ui.settle()
  pending[0]({ ok: true, value: { agents: [{ id: 'soc', name: '过时目录' }], experiments: [] } }); await ui.settle()
  ui.tab('identity').props.onClick(); ui.render()
  const selector = ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '选择智能体 1')
  assert.match(ui.text(selector), /当前目录/)
  assert.doesNotMatch(ui.text(selector), /过时目录/)
  assert.equal(selector.props.value, 'soc')
})
