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
  platform: 'node', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'], logLevel: 'silent', plugins: [{ name: 'object-selector-contract', setup(builder) { builder.onLoad({ filter: /business-control\/window\.tsx$/ }, () => ({ loader: 'tsx', contents: `import React from 'react'; export function GatewayWindows({ children }) { return children }; export function GatewayWindow({ title, trigger, children, active, identity, footer, editing, open, onOpenChange, onClose, closeLabel }) { return <aside data-detail-drawer={title} data-drawer-active={active} data-drawer-identity={identity} data-window-editing={editing} data-window-open={open}>{trigger !== null && <button type="button" onClick={() => onOpenChange?.(true)}>{trigger ?? title}</button>}<section role={open ? 'dialog' : undefined}>{children}</section>{footer}<button type="button" onClick={() => { onOpenChange?.(false); onClose?.() }}>{closeLabel ?? (editing ? '暂存并返回' : '关闭')}</button></aside> }` })); builder.onLoad({ filter: /components\/search-select\.tsx$/ }, () => ({ loader: 'tsx', contents: `import React from 'react'; export function SearchSelect(props) { return <label>{props.label}<select value={props.value} onChange={event => props.onChange(event.target.value)}>{props.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></label> }` })) } }] })).outputFiles[0].text
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
    if (remote.trustValid && request.url === '/trust') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ valid: true, subjectId: body.subjectId, expiresAt: future() })); return }
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
  const patched = await f.call('saveConfiguration', { revision: saved.value.revision, enabled: true, agents: saved.value.configuration.agents, riskAssessment: { timeoutMs: 900 } })
  assert.equal(patched.ok, true, JSON.stringify(patched))
  const preserved = JSON.parse(readFileSync(f.path, 'utf8')).riskAssessment
  assert.equal(preserved.timeoutMs, 900)
  assert.equal(preserved.testRunId, 'isolated-gateway')
  assert.deepEqual(preserved.requiredKinds, ['read', 'write', 'publish'])
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

function page({ active = true, statusHandler, saveHandler, catalogHandler, probeHandler, instanceHandler, mcpConfigurationHandler, mcpListHandler, protocolHandler } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], navigations = [], downloads = [], intervals = new Map()
  let cursor = 0, scope = '', effects = [], changed = false, tree, current = uiStatus(), saveConflict = false
  const hookKey = () => scope ? `${scope}/${cursor++}` : cursor++
  const react = { ...require('react'),
    useState(initial) { const at = hookKey(); if (!(at in states)) states[at] = initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = hookKey(); if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useLayoutEffect(effect, deps) { const at = hookKey(); if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
    useEffect(effect, deps) { const at = hookKey(); if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  const documentState = { activeElement: null, body: {}, querySelector: () => null, createElement: () => ({ href: '', download: '', click() { downloads.push({ href: this.href, filename: this.download }) } }) }
  vm.runInNewContext(clientSource, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: ({ text }) => react.createElement('div', null, text) } : require(name), URL,
    window: { confirm: () => true, addEventListener() {}, removeEventListener() {}, requestAnimationFrame: fn => fn() }, document: documentState,
    setInterval: fn => { const id = intervals.size + 1; intervals.set(id, fn); return id }, clearInterval: id => intervals.delete(id) })
  const props = { active, onNavigate: value => navigations.push(value), rpc: { async call(channel, endpoint, payload) {
    calls.push({ channel, endpoint, payload })
    if (endpoint === 'mcp/control/providerProtocol') return protocolHandler ? protocolHandler(payload) : { ok: false, error: { message: '规范暂不可读' } }
    if (endpoint === 'instances/list') return instanceHandler ? instanceHandler() : { ok: true, value: { observed_at: new Date().toISOString(), instances: current.instances.map(value => ({ name: value.instanceId, agent_id: value.agentId, state: 'running' })) } }
    if (endpoint === 'agents/list') return catalogHandler ? catalogHandler() : { ok: true, value: {
      agents: [{ id: 'soc', name: '安全运营专家', active_experiment: 'EXP-soc-001', version_count: 1 }, { id: 'helper', name: '业务助手', version_count: 0 }],
      experiments: [{ id: 'EXP-soc-001', agent_id: 'soc' }] } }
    if (endpoint === 'agents/description') return { ok: true, value: { agentId: payload.agent_id, source: { experimentId: 'EXP-soc-001', basis: 'active_experiment' }, name: '安全运营专家', description: '当前资产说明', skills: [] } }
    if (endpoint === 'mcp/configuration') return mcpConfigurationHandler ? mcpConfigurationHandler() : { ok: true, value: { servers: [] } }
    if (endpoint === 'mcp/list') return mcpListHandler ? mcpListHandler() : { ok: true, value: { connections: [] } }
    if (endpoint === 'mcp/control/probeProvider' && probeHandler) return probeHandler(payload)
    if (endpoint === 'mcp/control/status' && statusHandler) return statusHandler()
    if (endpoint === 'mcp/control/saveConfiguration' && saveHandler) return saveHandler(payload)
    if (endpoint === 'mcp/control/saveConfiguration' && saveConflict) return { ok: false, error: { code: 'conflict', message: '配置已变化，草稿保留' } }
    return { ok: true, value: structuredClone(current) }
  } } }
  function render() { let count = 0; do { if (++count > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; scope = ''; tree = module.exports.BusinessControlPage(props); nodes(tree); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); render() } }
  function component(value) { const previousCursor = cursor, previousScope = scope; cursor = 0; scope = `${value.type.name}:${value.props.kind ?? value.props.title ?? value.key ?? ''}`; try { return value.type(value.props) } finally { cursor = previousCursor; scope = previousScope } }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; if (typeof value.type === 'function') return nodes(component(value)); return [value, ...nodes(value.props?.children)] }
  function text(value) { if (value?.type === 'style') return ''; if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object' && typeof value.type === 'function') return text(component(value)); return value && typeof value === 'object' ? text(value.props?.children) : typeof value === 'boolean' ? '' : String(value ?? '') }
  const button = title => nodes().find(value => value.type === 'button' && text(value) === title)
  const tab = id => nodes().find(value => value.type === 'button' && value.props?.['data-gateway-tab'] === id)
  render()
  // 模拟旧版页面升级时仍保留的内存草稿，不恢复面向用户的 JSON 编辑入口。
  const restoreLegacyDraft = agents => { const at = states.findIndex(value => value && typeof value === 'object' && typeof value.agents === 'string' && typeof value.base === 'string'); assert.ok(at >= 0); states[at] = { ...states[at], agents }; render() }
  return { render, settle, nodes, text, button, tab, calls, navigations, downloads, documentState, props, intervals, restoreLegacyDraft, current: value => { current = value }, conflict: () => { saveConflict = true } }
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
  assert.match(rendered, /管理范围与验证边界/)
  assert.match(rendered, /自动检测与防护闭环尚待验证/)
  assert.match(rendered, /待核对/)
  assert.doesNotMatch(rendered, /许可租期上限 2 秒/)
  ui.tab('identity').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /许可租期上限 2 秒/)
  assert.equal(ui.intervals.size, 1)
  ui.props.active = false; ui.render()
  assert.equal(ui.intervals.size, 0)
})

test('混合实例 UI 区分发布身份与开发同步，开发失联不显示为许可失败', async () => {
  const status = uiStatus()
  status.instances[0].identityMode = 'published'
  status.instances[0].applied = true
  status.instances.push({ ...binding, instanceId: 'dev-runtime', identityMode: 'development', applied: false,
    synchronization: { lastAttemptAt: new Date().toISOString(), lastError: '控制记录同步失败，请稍后核对' } })
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(status) }), instanceHandler: () => ({ ok: true, value: { instances: status.instances.map(value => ({ name: value.instanceId, agent_id: value.agentId, state: 'running' })) } }) }); await ui.settle()
  let rendered = ui.text(ui.render())
  const chart = title => ui.nodes().find(node => node.props?.className === 'harness-gateway-chart' && ui.text(node).startsWith(title))
  assert.match(ui.nodes(chart('身份核验')).find(node => node.props?.role === 'img').props['aria-label'], /共 1 个实例/)
  assert.match(ui.text(chart('配置同步')), /已同步1.*待核对1/s)
  assert.match(rendered, /配置同步失败/)
  assert.doesNotMatch(rendered, /回执已过期/)
  assert.match(rendered, /开发调试，无需许可租约/)
  assert.match(rendered, /最近记录同步\s*尚无回执/)
  assert.match(rendered, /控制记录同步失败，请稍后核对/)
  assert.match(rendered, /同步失联不阻断交互/)
  status.instances[1].synchronization = { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() }
  ui.button('刷新状态').props.onClick(); await ui.settle()
  rendered = ui.text(ui.render())
  assert.match(rendered, /记录同步正常/)
  assert.match(ui.text(chart('配置同步')), /已同步2.*待核对0/s)
  assert.equal(ui.nodes().some(node => node.props?.className === 'harness-gateway-attention'), false)
  assert.doesNotMatch(rendered, /控制记录同步失败/)
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
  const open = () => ui.nodes(ui.nodes().find(value => value.type === 'label' && ui.text(value) === '开放业务入口')).find(value => value.type === 'input')
  open().props.onChange({ target: { checked: false } }); ui.render()
  holdStatus = true; ui.button('刷新状态').props.onClick()
  ui.button('预览配置').props.onClick(); confirmPreview(ui)
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
  const textarea = () => ui.nodes().find(value => value.type === 'textarea' && value.props['aria-label'] === 'Agent 原始配置')
  const read = ui.nodes(ui.nodes().find(node => node.type === 'label' && ui.text(node) === '查询信息')).find(node => node.type === 'input')
  read.props.onChange({ target: { checked: true } }); ui.render()
  const draft = textarea().props.value
  ui.current(uiStatus('revision-2')); ui.conflict()
  const form = ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置')
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
  assert.ok(ui.nodes().some(value => value.type === 'main' && value.props['aria-label'] === '统一网关管理'))
  assert.deepEqual(ui.nodes().filter(value => value.props?.role === 'tab').map(value => ui.text(value)), ['运行概览', '智能体身份', '风险评估', '访问控制'])
  assert.equal(ui.tab('overview').props['aria-selected'], true)
  assert.equal(ui.nodes().filter(value => value.type === 'fieldset' && value.props.className !== 'harness-gateway-subject-picker').length, 0)
  assert.doesNotMatch(ui.text(ui.render()), /实例与身份回执|配置应用与管理范围|配置应用回执/)
  assert.match(ui.text(ui.render()), /管理范围与验证边界/)
  ui.tab('identity').props.onClick(); ui.render()
  assert.deepEqual(ui.nodes().filter(value => value.type === 'legend').map(value => ui.text(value)), ['1．智能体身份'])
  assert.match(ui.text(ui.render()), /安全运营专家/)
  assert.match(ui.text(ui.render()), /身份核验依据/)
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
  assert.match(content, /前往运行处置/)
  assert.match(content, /历史与完整评估依据 · 0 条/)
  assert.doesNotMatch(content, /查看全部风险事实|查看覆盖范围与限制/)
  assert.match(content, /风险判断由第三方提供方负责/)
  assert.doesNotMatch(content, /手动添加限制或辅助重评|当前限制与需核对事项/)
  assert.match(content, /测试模拟提供方/)
  assert.doesNotMatch(content, /低风险（已评估范围）/)
  ui.tab('authorization').props.onClick(); ui.render()
  assert.ok(ui.nodes().some(value => value.props?.['aria-label'] === '工具与资源操作允许清单'))
  const value = uiStatus('revision-2')
  value.riskFacts = [{ id: 'agent-risk', version: 1, scope: { workspaceId: binding.workspaceId, agentId: 'soc' }, status: 'assessed', level: 'high',
    source: 'test', signals: [], observedAt: new Date().toISOString(), expiresAt: future() }]
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  ui.tab('overview').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /有效高风险1/)
  value.riskFacts[0].expiresAt = new Date(Date.now() - 1).toISOString()
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /已过期1/)
  ui.tab('risk').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /当前评估已超过有效期/)
  assert.match(ui.text(ui.render()), /不能据此推断访问已允许或已阻止/)
  value.riskFacts[0].expiresAt = future(); value.riskFacts[0].level = 'unknown'; value.riskFacts[0].status = 'unknown'
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /当前评估包含未知结果/)
  value.riskFacts[0].level = 'low'; value.riskFacts[0].status = 'assessed'
  ui.current(value); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /当前范围已有有效评估/)
})

test('身份撤销和风险提供方共用草稿，三类配置保存保持原revision及持久字段兼容', async () => {
  const ui = page(); await ui.settle()
  ui.tab('identity').props.onClick(); ui.render()
  const trust = ui.nodes().find(value => value.type === 'label' && ui.text(value).includes('允许该智能体身份'))
  ui.nodes(trust).find(value => value.type === 'input').props.onChange({ target: { checked: false } }); ui.render()
  ui.tab('risk').props.onClick(); ui.render()
  ui.nodes().find(value => value.type === 'input' && value.props['aria-label'] === 'Agent 风险评估提供方超时（毫秒）').props.onChange({ target: { value: '950' } }); ui.render()
  ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); confirmPreview(ui)
  await ui.settle()
  const call = ui.calls.find(value => value.endpoint === 'mcp/control/saveConfiguration')
  assert.equal(call.payload.revision, 'revision-1')
  assert.equal(call.payload.agents[0].agentTrust.enabled, false)
  assert.equal(call.payload.riskAssessment.timeoutMs, 950)
  assert.equal(Object.hasOwn(call.payload.riskAssessment, 'requiredKinds'), false)
  assert.equal(Object.hasOwn(call.payload.riskAssessment, 'testRunId'), false)
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
  assert.match(ui.text(group('允许访问的服务 1')), /inspection/)
  ui.nodes().find(node => node.type === 'select' && node.props.value === '' && ui.nodes(node).some(option => option.type === 'option' && option.props.value === 'reports')).props.onChange({ target: { value: 'reports' } }); ui.render()
  checkbox('允许的动作 1', '修改数据').props.onChange({ target: { checked: true } }); ui.render()
  const method = () => ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '方法 1')
  assert.equal(method().props.value, 'TOOLS/CALL')
  method().props.onChange({ target: { value: 'GET' } }); ui.render()
  await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.match(ui.text(group('允许访问的服务 1')), /reports/)
  assert.equal(checkbox('允许的动作 1', '修改数据').props.checked, true)
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
  const draft = () => JSON.parse(ui.nodes().find(value => value.props?.['aria-label'] === 'Agent 原始配置').props.value)[0]
  ui.nodes().find(node => node.props?.['aria-label'] === '移除服务 old-service').props.onClick(); ui.render()
  assert.deepEqual(Array.from(draft().serverIds), [])
  ui.nodes().find(node => node.props?.['aria-label'] === 'MCP 服务范围').props.onChange({ target: { value: 'registered' } }); ui.render()
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
  const trust = () => ui.nodes(ui.nodes().find(value => value.type === 'label' && ui.text(value).includes('允许该智能体身份'))).find(value => value.type === 'input')
  trust().props.onChange({ target: { checked: false } }); ui.render()
  ui.tab('risk').props.onClick(); ui.render()
  assert.equal(selectedFieldsets()[0].props['aria-label'], '风险评估提供方配置')
  assert.match(ui.text(ui.render()), /有未保存更改/)
  assert.ok(ui.nodes(ui.tab('identity')).some(value => value.props?.['aria-label'] === '有未保存更改'))
  ui.tab('identity').props.onClick(); ui.render()
  assert.equal(trust().props.checked, false)
  assert.equal(ui.nodes().filter(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置').length, 1)
  ui.tab('overview').props.onClick(); ui.render()
  assert.ok(ui.nodes().some(value => value.props?.['aria-label'] === '运行概览'))
  assert.equal(selectedFieldsets().length, 0)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('访问控制按单个智能体编辑，预览与确认保存分开', async () => {
  const ui = page(); await ui.settle()
  assert.ok(ui.nodes().some(value => value.props?.['aria-label'] === '统一网关状态概览'))
  assert.ok(ui.nodes().some(value => value.props?.className === 'harness-table-scroll harness-gateway-overview-table'))
  ui.tab('authorization').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '业务智能体')?.props.value, '0')
  assert.equal(ui.nodes().some(value => value.props?.['aria-label'] === '业务入口'), false)
  ui.button('Agent高级设置').props.onClick(); ui.render()
  const open = ui.nodes().find(value => value.type === 'label' && ui.text(value) === '开放该智能体的访问权限')
  ui.nodes(open).find(value => value.type === 'input').props.onChange({ target: { checked: false } }); ui.render()
  const form = () => ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '统一网关配置')
  form().props.onSubmit({ preventDefault() {} }); ui.render()
  assert.ok(ui.nodes().some(value => value.props?.role === 'dialog'))
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
  ui.button('返回修改').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(value => value.props?.['data-detail-drawer'] === '确认保存业务访问配置').props['data-window-open'], false)
  assert.equal(ui.nodes().find(value => value.props?.['data-detail-drawer'] === 'Agent高级设置').props['data-window-open'], true)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
  form().props.onSubmit({ preventDefault() {} }); confirmPreview(ui); await ui.settle()
  assert.equal(ui.calls.filter(value => value.endpoint === 'mcp/control/saveConfiguration').length, 1)
  assert.equal(ui.calls.find(value => value.endpoint === 'mcp/control/saveConfiguration').payload.agents[0].enabled, false)
})

test('运行限制可多选已获准用户，按用户分别收紧且多选不携带 Session ID', async () => {
  const ui = page(); await ui.settle(); ui.tab('overview').props.onClick(); ui.render()
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
  const form = ui.nodes().find(value => value.type === 'form' && value.props['aria-label'] === '手动运行限制配置')
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
  ui.nodes().find(node => node.type === 'form' && node.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); ui.render()
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
  assert.match(ui.text(ui.render()), /暂无已登记业务实例/)
  assert.doesNotMatch(ui.text(ui.render()), /配置 0\/0 已应用/)
  ui.tab('identity').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /尚未配置业务 Agent/)
  assert.match(ui.text(ui.render()), /尚未配置智能体身份/)
  assert.ok(ui.button('配置首个 Agent'))
  ui.button('配置首个 Agent').props.onClick(); ui.render()
  assert.equal(ui.tab('identity').props['aria-selected'], true)
  ui.tab('authorization').props.onClick(); ui.render()
  const agents = JSON.parse(ui.nodes().find(value => value.type === 'textarea' && value.props['aria-label'] === 'Agent 原始配置').props.value)
  assert.equal(agents.length, 1)
  assert.equal(agents[0].enabled, false)
  assert.equal(agents[0].agentTrust.enabled, false)
  assert.equal(ui.calls.some(value => value.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('选择器复用资产列表，搜索保留已选值，更换身份不继承来源或自动开放', async () => {
  let saved
  const initial = uiStatus(); initial.configuration.agents[0].sourceDigest = 'sha256:old-source'
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(initial) }), saveHandler: payload => { saved = payload; return { ok: true, value: uiStatus('saved') } } }); await ui.settle()
  ui.tab('identity').props.onClick(); ui.render()
  const selector = () => ui.nodes().find(value => value.type === 'select' && value.props['aria-label'] === '选择智能体 1')
  const search = () => ui.nodes().find(value => value.type === 'input' && value.props.type === 'search')
  const id = () => ui.nodes(ui.nodes().find(value => value.type === 'label' && ui.text(value) === 'Agent ID')).find(value => value.type === 'input')
  const draft = () => { ui.tab('authorization').props.onClick(); ui.render()
    const value = JSON.parse(ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 原始配置').props.value)
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
  assert.match(ui.text(ui.nodes().find(node => node.props?.['data-gateway-source-digest'] === 'soc')), /sha256:old-source/)
  assert.equal(ui.nodes().some(node => node.type === 'input' && node.props.value === 'sha256:old-source'), false)
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


test('网关只用当前实例登记生成关注项与分布，历史绑定仍可只读核对', async () => {
  const status = uiStatus()
  status.instances[0].applied = true
  status.instances.push({ ...binding, instanceId: 'deleted-instance', applied: false })
  const ui = page({ statusHandler: async () => ({ ok: true, value: structuredClone(status) }), instanceHandler: async () => ({ ok: true, value: { observed_at: '2026-10-28T00:00:00Z', instances: [{ name: binding.instanceId, agent_id: binding.agentId, state: 'running' }] } }) })
  await ui.settle()
  assert.equal(ui.nodes().some(node => node.props?.className === 'harness-gateway-attention'), false)
  assert.match(ui.text(ui.render()), /历史网关记录.*1 项已不在当前实例登记/)
  assert.equal(ui.button('查看实例'), undefined)
  const table = ui.nodes().find(node => node.props?.className === 'harness-table-scroll harness-gateway-overview-table')
  assert.doesNotMatch(ui.text(table), /deleted-instance/)
  const reads = ui.calls.filter(call => call.endpoint === 'instances/list').length
  Array.from(ui.intervals.values())[0](); await ui.settle()
  assert.equal(ui.calls.filter(call => call.endpoint === 'instances/list').length, reads, '一秒回执轮询不能反复运行实例登记CLI')
})

test('关注项跳转前重新核对登记，已移除实例说明原因并提供列表恢复入口', async () => {
  let reads = 0
  const status = uiStatus()
  status.instances[0].acknowledgement = { at: new Date(Date.now() - 60000).toISOString(), restrictionVersion: 0, leaseId: 'old-lease' }
  const ui = page({ statusHandler: async () => ({ ok: true, value: structuredClone(status) }), instanceHandler: async () => ({ ok: true, value: { instances: ++reads === 1 ? [{ name: binding.instanceId, agent_id: binding.agentId, state: 'running' }] : [] } }) })
  await ui.settle()
  assert.match(ui.text(ui.nodes().find(node => node.props?.className === 'harness-gateway-attention')), /回执已过期/)
  await ui.button('查看实例').props.onClick(); await ui.settle()
  assert.equal(ui.navigations.length, 0, '先在当前页面说明对象已移除，避免无原因跳页')
  assert.match(ui.text(ui.render()), /已不在当前登记中.*历史核对/)
  ui.button('前往实例列表').props.onClick()
  assert.deepEqual({ ...ui.navigations.at(-1) }, { page: 'instances' })
  assert.equal(ui.calls.some(call => ['instances/detail', 'instances/logs'].includes(call.endpoint)), false)
})

test('登记读取失败保留上次快照并说明范围未知，不用旧绑定显示当前异常', async () => {
  let fail = false
  const ui = page({ instanceHandler: async () => fail ? { ok: false, error: { message: '登记读取失败' } } : { ok: true, value: { observed_at: '2026-10-28T00:00:00Z', instances: [{ name: binding.instanceId, agent_id: binding.agentId, state: 'running' }] } } })
  await ui.settle(); fail = true
  ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /当前实例范围未知.*上次实例登记快照（当前状态待核对）/s)
  assert.equal(ui.nodes().some(node => node.props?.className === 'harness-gateway-attention'), false)
  assert.equal(ui.nodes().some(node => node.props?.className === 'harness-gateway-charts'), false)
  assert.equal(ui.button('查看实例'), undefined)
})


test('网关资料与配置分别使用非模态窗口，当前操作保留工作面', async () => {
  const value = uiStatus()
  value.instances.push({ ...binding, instanceId: 'removed-runtime', applied: false })
  value.restrictions = [
    { id: 'released', active: false, scope: { ...binding, subjectId: 'subject-a' }, deniedActions: ['write'], reason: 'released-record' },
  ]
  value.riskFacts = [{ id: 'expired-fact', version: 3, scope: binding, status: 'assessed', level: 'high', signals: [{ code: 'test', value: true, reason: 'expired-evidence' }], observedAt: '2026-10-20T00:00:00Z', expiresAt: '2026-10-21T00:00:00Z' }]
  value.sessionTrustFacts = [
    { agentId: 'soc', instanceId: binding.instanceId, sessionId: 'session-a', subjectId: 'subject-a', state: 'expired', observedAt: '2026-10-20T00:00:00Z' },
    { agentId: 'helper', instanceId: 'helper-runtime', sessionId: 'other-session', subjectId: 'other-subject', state: 'expired', observedAt: '2026-10-20T00:00:00Z' },
  ]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }), instanceHandler: () => ({ ok: true, value: { observed_at: new Date().toISOString(), instances: [{ name: binding.instanceId, agent_id: binding.agentId, state: 'running' }] } }) })
  await ui.settle()
  const drawers = () => ui.nodes().filter(node => node.props?.['data-detail-drawer'])
  assert.ok(drawers().some(node => node.props['data-detail-drawer'] === '历史网关记录'))
  assert.ok(drawers().some(node => node.props['data-detail-drawer'] === '最近操作与执行结果'))
  assert.ok(drawers().some(node => String(node.props['data-detail-drawer']).includes('来源与代次')))
  ui.tab('identity').props.onClick(); ui.render(); await ui.settle()
  const identity = drawers().find(node => node.props['data-detail-drawer'] === '身份核验依据')
  assert.equal(identity.props['data-drawer-identity'], 'soc')
  assert.match(ui.text(identity), /会话身份事实.*session-a/s)
  assert.doesNotMatch(ui.text(identity), /other-session/)
  assert.ok(drawers().some(node => node.props['data-detail-drawer'] === '配置智能体身份与可信来源' && node.props['data-window-editing']))
  ui.tab('overview').props.onClick(); ui.render()
  const released = drawers().find(node => node.props['data-detail-drawer'] === '已解除限制')
  ui.tab('risk').props.onClick(); ui.render()
  for (const title of ['评估范围与历史依据']) {
    const drawer = drawers().find(node => node.props['data-detail-drawer'] === title)
    assert.ok(drawer, title)
    assert.equal(drawer.props['data-drawer-active'], true)
    assert.equal(ui.nodes(drawer).filter(node => ['form', 'input', 'select', 'textarea', 'details'].includes(node.type)).length, 0, `${title}只承载旁路资料`)
  }
  assert.match(ui.text(released), /released-record/)
  assert.doesNotMatch(ui.text(released), /current-restriction/)
  assert.ok(ui.nodes().some(node => node.type === 'section' && node.props['aria-label'] === '智能体风险摘要'))
  assert.equal(ui.button('查看智能体风险摘要'), undefined)
  const evidence = drawers().find(node => node.props['data-detail-drawer'] === '评估范围与历史依据')
  assert.match(ui.text(evidence), /版本 3.*expired-evidence/s)
  assert.ok(ui.button('前往运行处置'))
  assert.equal(ui.nodes(evidence).some(node => node.type === 'button' && ui.text(node) === '前往运行处置'), false)
  assert.equal(ui.nodes().some(node => node.props?.id === 'gateway-reassess'), false)
  ui.tab('overview').props.onClick(); ui.render()
  assert.ok(ui.nodes().some(node => node.type === 'section' && node.props.id === 'gateway-reassess'))
  ui.props.active = false; ui.render()
  assert.ok(drawers().every(node => node.props['data-drawer-active'] === false))
  assert.equal(ui.calls.filter(call => ['mcp/control/restrict', 'mcp/control/release', 'mcp/control/reassess', 'mcp/control/saveConfiguration'].includes(call.endpoint)).length, 0)
})


test('当前配置回执对应运行登记，同范围不同ID风险事实均保留', async () => {
  const value = uiStatus()
  value.instances[0].applied = true
  const scope = { workspaceId: binding.workspaceId, agentId: binding.agentId, instanceId: binding.instanceId }
  value.riskFacts = [
    { id: 'old-high', scope, version: 1, status: 'assessed', level: 'high', signals: [], observedAt: new Date(Date.now() - 10000).toISOString(), expiresAt: future() },
    { id: 'new-low', scope, version: 2, status: 'assessed', level: 'low', signals: [], observedAt: new Date().toISOString(), expiresAt: future() },
  ]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }), instanceHandler: () => ({ ok: true, value: { instances: [{ name: binding.instanceId, agent_id: binding.agentId, state: 'absent' }] } }) })
  await ui.settle()
  const chart = title => ui.nodes().find(node => node.props?.className === 'harness-gateway-chart' && ui.text(node).startsWith(title))
  assert.match(ui.text(chart('配置同步')), /已同步0/)
  assert.match(ui.text(chart('风险评估')), /有效高风险1.*有效低风险1/s)
  const table = ui.nodes().find(node => String(node.props?.className).includes('harness-gateway-overview-table'))
  assert.match(ui.text(table), /未运行，无实时回执/)
  assert.equal(ui.nodes(table).some(node => node.props?.['data-state'] === 'success'), false)
  assert.equal(ui.nodes().some(node => node.props?.className === 'harness-gateway-attention'), false)
  ui.tab('risk').props.onClick(); ui.render()
  const notice = ui.nodes().find(node => node.props?.className === 'harness-gateway-risk-notice')
  assert.match(ui.text(notice), /当前评估范围内存在高风险/)
  const evidence = ui.nodes().find(node => node.props?.['data-detail-drawer'] === '评估范围与历史依据')
  assert.match(ui.text(evidence), /版本 1/)
  assert.match(ui.text(evidence), /版本 2/)
})

test('身份配置独立窗口关闭保留草稿，隐藏提供方错误打开对应窗口', async () => {
  const ui = page(); await ui.settle(); ui.tab('identity').props.onClick(); ui.render()
  const window = title => ui.nodes().find(node => node.props?.['data-detail-drawer'] === title)
  ui.button('配置智能体身份与可信来源').props.onClick(); ui.render()
  assert.equal(window('配置智能体身份与可信来源').props['data-window-open'], true)
  const timeout = () => ui.nodes().find(node => node.props?.['data-gateway-field'] === 'authentication-timeout')
  timeout().props.onChange({ target: { value: '0' } }); ui.render()
  ui.nodes(window('配置智能体身份与可信来源')).find(node => node.type === 'button' && ui.text(node) === '暂存并返回').props.onClick(); ui.render()
  assert.equal(window('配置智能体身份与可信来源').props['data-window-open'], false)
  assert.equal(timeout().props.value, '0')
  ui.tab('authorization').props.onClick(); ui.render(); ui.nodes().find(node => node.type === 'form' && node.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(ui.tab('identity').props['aria-selected'], true)
  assert.equal(window('配置智能体身份与可信来源').props['data-window-open'], true)
  assert.match(ui.text(ui.render()), /提供方超时必须为 1 至 60000 毫秒/)
  assert.equal(ui.calls.some(call => call.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('操作定义窗口保持各自草稿，当前处理区常显且不使用正文折叠', async () => {
  const value = uiStatus(); value.configuration.operations = [
    { serverId: 'one', operationId: 'first', kind: 'read', method: 'GET', target: 'http://127.0.0.1/one' },
    { serverId: 'two', operationId: 'second', kind: 'read', method: 'GET', target: 'http://127.0.0.1/two' },
  ]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }) }); await ui.settle()
  ui.tab('overview').props.onClick(); ui.render()
  assert.ok(ui.nodes().some(node => node.type === 'section' && node.props.id === 'gateway-reassess'))
  assert.equal(ui.nodes().filter(node => node.type === 'details').length, 0)
  ui.tab('authorization').props.onClick(); ui.render()
  assert.deepEqual(ui.nodes().filter(node => node.type === 'details').map(node => node.props.className), [])
  const selector = () => ui.nodes().find(node => node.props?.['aria-label'] === '选择要编辑的操作')
  ui.nodes().find(node => node.props?.['aria-label'] === '操作 ID 1').props.onChange({ target: { value: 'first-draft' } }); ui.render()
  selector().props.onChange({ target: { value: '1' } }); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '操作 ID 2').props.value, 'second')
  ui.nodes().find(node => node.props?.['aria-label'] === '操作 ID 2').props.onChange({ target: { value: 'second-draft' } }); ui.render()
  selector().props.onChange({ target: { value: '0' } }); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '操作 ID 1').props.value, 'first-draft')
  ui.button('移除操作').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '操作 ID 1').props.value, 'second-draft')
  assert.equal(ui.calls.some(call => call.endpoint === 'mcp/control/saveConfiguration'), false)
})

test('非模态确认摘要随当前草稿更新，确认提交同一份最新配置', async () => {
  const ui = page(); await ui.settle(); ui.tab('authorization').props.onClick(); ui.render()
  const subjects = () => ui.nodes(ui.nodes().find(node => node.type === 'label' && ui.text(node).startsWith('允许使用此智能体的接入用户 ID'))).find(node => node.type === 'input')
  subjects().props.onChange({ target: { value: 'preview-user' } }); ui.render()
  ui.nodes().find(node => node.type === 'form' && node.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); ui.render()
  const confirmation = () => ui.nodes().find(node => node.props?.['data-detail-drawer'] === '确认保存业务访问配置')
  assert.equal(confirmation().props['data-window-open'], true)
  assert.match(ui.text(confirmation()), /preview-user/)
  subjects().props.onChange({ target: { value: 'latest-user' } }); ui.render()
  assert.match(ui.text(confirmation()), /latest-user/); assert.doesNotMatch(ui.text(confirmation()), /preview-user/)
  confirmPreview(ui); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint === 'mcp/control/saveConfiguration').payload
  assert.deepEqual(Array.from(saved.agents[0].subjects), ['latest-user'])
})

test('风险页分别呈现未配置与已配置无结果，自动刷新完整结果且不改风险草稿', async () => {
  let snapshot = uiStatus()
  snapshot.configuration.riskAssessment = { configured: false, endpoint: '', endpointHidden: false, mode: 'unconfigured', requiredKinds: ['write'] }
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(snapshot) }) }); await ui.settle(); ui.tab('risk').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /尚未配置.*当前实例尚无动态评估结果；请先配置风险评估提供方/s)
  const endpoint = () => ui.nodes().find(node => node.props?.['data-gateway-field'] === 'riskAssessment-endpoint')
  endpoint().props.onChange({ target: { value: 'http://127.0.0.1/draft-provider' } }); ui.render()
  snapshot.configuration.riskAssessment = { configured: true, endpoint: 'http://127.0.0.1/saved-provider', endpointHidden: false, mode: 'external-provider', requiredKinds: ['write'] }
  for (const tick of ui.intervals.values()) tick(); await ui.settle()
  assert.match(ui.text(ui.render()), /已配置 · 外部提供方.*有待保存的风险配置.*已配置提供方，当前实例尚无动态评估结果/s)
  const now = Date.now()
  const fact = (id, level, status = 'assessed') => ({ id, version: 1, source: 'provider', scope: { ...binding, subjectId: id, sessionId: `session-${id}` }, level, status, observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), signals: [] })
  snapshot.riskFacts = [fact('low', 'low'), fact('high', 'high'), fact('unknown', 'unknown', 'unknown'), { ...fact('expired', 'high'), expiresAt: new Date(now - 1).toISOString() }]
  for (const tick of ui.intervals.values()) tick(); await ui.settle()
  const table = () => ui.nodes().find(node => String(node.props?.className).includes('harness-gateway-risk-table'))
  const result = ui.text(table()); for (const label of ['有效低风险', '有效高风险', '未知', '已过期']) assert.ok(result.includes(label), label)
  assert.ok(result.includes('session-low')); assert.ok(result.includes('有效至')); assert.ok(result.includes('版本 1'))
  snapshot.riskFacts = [{ ...fact('latest', 'low'), version: 2 }]
  for (const tick of ui.intervals.values()) tick(); await ui.settle()
  assert.match(ui.text(table()), /session-latest.*有效低风险.*版本 2/s)
  assert.doesNotMatch(ui.text(table()), /session-high/)
  assert.equal(endpoint().props.value, 'http://127.0.0.1/draft-provider')
  assert.equal(ui.nodes().some(node => node.props?.id === 'gateway-reassess'), false)
  assert.equal(ui.calls.some(call => /saveConfiguration|restrict|release|reassess/.test(call.endpoint)), false)
})

test('关闭自动评估后旧有效高风险仅作记录，概览不再催评估且人工限制保留', async () => {
  const value = uiStatus(); value.configuration.riskAssessment = { configured: false, endpoint: '', endpointHidden: false, mode: 'unconfigured', requiredKinds: ['write'] }
  value.riskFacts = [{ id: 'old-deny', version: 4, source: 'provider', scope: binding, status: 'assessed', level: 'high', signals: [{ code: 'deny', value: 'write', reason: 'old-automatic-signal' }], observedAt: new Date().toISOString(), expiresAt: future() }]
  value.restrictions = [{ id: 'manual-keep', active: true, scope: { ...binding, subjectId: 'subject-a' }, deniedActions: ['write'], reason: 'manual-still-active' }]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }) }); await ui.settle()
  assert.match(ui.text(ui.render()), /自动评估已关闭.*已记录评估不参与当前许可/s)
  const riskChart = ui.nodes().find(node => node.props?.className === 'harness-gateway-chart' && ui.text(node).startsWith('风险评估'))
  assert.match(ui.text(riskChart), /高风险记录1/)
  assert.doesNotMatch(ui.text(riskChart), /有效高风险|有效低风险/)
  assert.match(ui.nodes(riskChart).find(node => node.type === 'svg').props['aria-label'], /条评估/)
  assert.match(ui.text(ui.render()), /manual-still-active/)
  assert.equal(ui.button('辅助重评当前 Session').props.disabled, true)
  assert.match(ui.text(ui.render()), /辅助重评不可用；手动限制仍然可用/)
  assert.equal(ui.nodes().some(node => node.props?.className === 'harness-gateway-risk-notice'), false)
  ui.tab('risk').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /已记录评估（当前不参与许可）.*old-automatic-signal/s)
  assert.match(ui.text(ui.render()), /自动风险评估已关闭.*基础工具权限与人工限制仍然生效/s)
  assert.doesNotMatch(ui.text(ui.render()), /当前评估范围内存在高风险|需要复核当前许可|请重新评估/)
  assert.equal(value.riskFacts.length, 1)
})

test('风险提供方与Agent摘要直接展示，预览只有一个入口且旧工作区/代次只在历史保留', async () => {
  const value = uiStatus(); const now = Date.now()
  const fact = (id, scope, reason) => ({ id, version: 1, source: 'provider', scope, status: 'assessed', level: 'low', observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(), signals: [{ code: 'observed', value: 'true', reason }] })
  value.riskFacts = [fact('current', binding, 'current-generation'), fact('old-generation', { ...binding, runtimeGeneration: 'old-generation' }, 'old-generation-evidence'), fact('other-workspace', { ...binding, workspaceId: 'old-workspace' }, 'other-workspace-evidence')]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }) }); await ui.settle(); ui.tab('risk').props.onClick(); ui.render()
  assert.equal(ui.nodes().filter(node => node.type === 'h2' && ui.text(node) === 'Agent 风险评估提供方').length, 1)
  assert.ok(ui.nodes().some(node => node.type === 'form' && node.props.id === 'gateway-risk-provider'))
  assert.ok(ui.nodes().some(node => node.type === 'section' && node.props['aria-label'] === '智能体风险摘要'))
  assert.equal(ui.button('查看智能体风险摘要'), undefined)
  assert.equal(ui.nodes().some(node => node.props?.['data-detail-drawer'] === '配置风险评估提供方与检测范围'), false)
  const timeout = () => ui.nodes().find(node => node.props?.['data-gateway-field'] === 'riskAssessment-timeout')
  timeout().props.onChange({ target: { value: '900' } }); ui.render()
  assert.equal(ui.nodes().filter(node => node.type === 'button' && ui.text(node) === '预览配置').length, 1)
  const table = ui.nodes().find(node => String(node.props?.className).includes('harness-gateway-risk-table'))
  assert.match(ui.text(table), /current-generation/); assert.doesNotMatch(ui.text(table), /old-generation-evidence|other-workspace-evidence/)
  const history = ui.nodes().find(node => node.props?.['data-detail-drawer'] === '评估范围与历史依据')
  assert.match(ui.text(history), /old-generation-evidence/); assert.match(ui.text(history), /other-workspace-evidence/)
  assert.equal(ui.calls.some(call => /saveConfiguration|restrict|release|reassess/.test(call.endpoint)), false)
})

test('授权页静态编辑和动态只读共用Agent选择，草稿不能冒充已生效动态事实', async () => {
  const value = uiStatus(), helper = { ...binding, agentId: 'helper', instanceId: 'helper-runtime', runtimeGeneration: 'helper-generation', applied: true }
  value.configuration.agents.push({ agentId: 'helper', enabled: true, subjects: ['helper-user'], actions: ['read'] }); value.instances.push(helper)
  const fact = (id, scope, reason) => ({ id, version: 1, source: 'provider', scope, status: 'assessed', level: 'high', observedAt: new Date().toISOString(), expiresAt: future(), signals: [{ code: 'deny-read', value: 'true', reason }] })
  value.riskFacts = [fact('one', binding, 'selected-agent-signal'), fact('two', helper, 'helper-only-signal')]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }), instanceHandler: () => ({ ok: true, value: { instances: value.instances.map(instance => ({ name: instance.instanceId, agent_id: instance.agentId, state: 'running' })) } }) }); await ui.settle(); ui.tab('authorization').props.onClick(); ui.render()
  const dynamic = () => ui.nodes().find(node => node.props?.['aria-label'] === '运行时限制')
  assert.ok(ui.nodes().some(node => node.type === 'h3' && ui.text(node) === '手动基础范围与条件规则'))
  assert.match(ui.text(dynamic()), /selected-agent-signal/); assert.doesNotMatch(ui.text(dynamic()), /helper-only-signal/)
  const original = ui.text(dynamic())
  ui.button('Agent高级设置').props.onClick(); ui.render()
  const enabled = ui.nodes(ui.nodes().find(node => node.type === 'label' && ui.text(node) === '开放该智能体的访问权限')).find(node => node.type === 'input')
  enabled.props.onChange({ target: { checked: false } }); ui.render()
  assert.equal(ui.text(dynamic()), original)
  assert.equal(ui.nodes(dynamic()).some(node => ['input', 'select', 'textarea', 'form'].includes(node.type)), false)
  ui.nodes().find(node => node.props?.['aria-label'] === '业务智能体').props.onChange({ target: { value: '1' } }); ui.render()
  assert.match(ui.text(dynamic()), /helper-only-signal/); assert.doesNotMatch(ui.text(dynamic()), /selected-agent-signal/)
  assert.equal(ui.calls.some(call => /saveConfiguration|restrict|release|reassess/.test(call.endpoint)), false)
})

function serviceSelector(ui) { return ui.nodes(ui.nodes().find(node => node.type === 'label' && ui.text(node).startsWith('选择 MCP 服务'))).find(node => node.type === 'select') }
function policyField(ui, name) { return ui.nodes().find(node => node.props?.['data-gateway-field'] === `tool-policies-0-${name}`) }
function policyDraft(ui) { return JSON.parse(ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 原始配置').props.value)[0] }

test('MCP选择只改查看上下文，服务规则与未知旧服务在同一草稿保留', async () => {
  const value = uiStatus(); value.configuration.agents[0].serverIds = ['inspection']; value.configuration.agents[0].actions = ['read', 'legacy-action']
  value.configuration.agents[0].toolPolicies = [{ serverId: 'legacy-service', defaultEffect: 'confirm', rules: [{ when: { scenarioIds: ['legacy-scene'], operationTags: ['partner-tag'] }, effect: 'deny' }] }]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }), mcpConfigurationHandler: () => ({ ok: true, value: { servers: [{ id: 'inspection', serverName: '巡检服务', description: '只读巡检工具', enabled: true, tools: { mode: 'selected', names: ['list'] }, headers: { secret: 'synthetic-private-config' } }, { id: 'reports', serverName: '报告服务', enabled: true }] } }) }); await ui.settle(); ui.tab('authorization').props.onClick(); ui.render(); await ui.settle()
  const original = ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 原始配置').props.value
  serviceSelector(ui).props.onChange({ target: { value: 'inspection' } }); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 原始配置').props.value, original)
  assert.match(ui.text(serviceSelector(ui)), /巡检服务|报告服务/); assert.doesNotMatch(ui.text(ui.render()), /synthetic-private-config/)
  policyField(ui, 'default').props.onChange({ target: { value: 'deny' } }); ui.render()
  assert.deepEqual(Array.from(policyDraft(ui).actions), ['read', 'legacy-action']); assert.deepEqual(Array.from(policyDraft(ui).serverIds), ['inspection'])
  serviceSelector(ui).props.onChange({ target: { value: 'legacy-service' } }); ui.render(); assert.equal(policyField(ui, 'default').props.value, 'confirm')
  serviceSelector(ui).props.onChange({ target: { value: 'inspection' } }); ui.render(); assert.equal(policyField(ui, 'default').props.value, 'deny')
  assert.deepEqual(policyDraft(ui).toolPolicies.find(policy => policy.serverId === 'legacy-service'), value.configuration.agents[0].toolPolicies[0])
  assert.equal(ui.calls.some(call => /discover|dispatch|saveConfiguration/.test(call.endpoint)), false)
})

test('条件规则自然句式列表一次只编辑一条，组合条件完整进入保存payload且不扩基础权限', async () => {
  const value = uiStatus(); value.configuration.agents[0].serverIds = ['inspection']; value.configuration.agents[0].actions = ['read']
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }) }); await ui.settle(); ui.tab('authorization').props.onClick(); ui.render()
  ui.button('添加条件规则').props.onClick(); ui.render()
  ui.nodes().find(node => node.type === 'form' && node.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['data-detail-drawer'] === '确认保存业务访问配置').props['data-window-open'], false)
  const risk = policyField(ui, 'rule-0-risk'); ui.nodes(risk).find(node => node.type === 'label' && ui.text(node) === '高风险').props.children[0].props.onChange({ target: { checked: true } }); ui.render()
  ui.nodes(policyField(ui, 'rule-0-kinds')).find(node => node.type === 'label' && ui.text(node) === '修改数据').props.children[0].props.onChange({ target: { checked: true } }); ui.render()
  policyField(ui, 'rule-0-effect').props.onChange({ target: { value: 'allow' } }); ui.render()
  assert.match(ui.text(ui.render()), /修改数据超出当前智能体的通用范围/)
  ui.nodes().find(node => node.props?.['aria-label'] === '规则 1 适用情况').props.onChange({ target: { value: 'combined' } }); ui.render()
  policyField(ui, 'rule-0-scenarios').props.onChange({ target: { value: 'incident-response, night-review' } }); ui.render()
  ui.nodes().find(node => node.type === 'label' && ui.text(node) === '敏感操作').props.children[0].props.onChange({ target: { checked: true } }); ui.render()
  policyField(ui, 'rule-0-tags').props.onChange({ target: { value: 'partner-tag' } }); ui.render()
  ui.button('添加条件规则').props.onClick(); ui.render()
  assert.equal(ui.nodes().filter(node => node.props?.className === 'harness-gateway-policy-rule').length, 1)
  ui.nodes().find(node => node.props?.['aria-label'] === '规则 2 适用情况').props.onChange({ target: { value: 'any' } }); ui.render()
  const operationMode = ui.nodes(ui.nodes().find(node => node.type === 'label' && ui.text(node).startsWith('适用的操作'))).find(node => node.type === 'select')
  operationMode.props.onChange({ target: { value: 'all' } }); ui.render(); policyField(ui, 'rule-1-effect').props.onChange({ target: { value: 'confirm' } }); ui.render()
  const summaries = () => ui.nodes().filter(node => node.type === 'button' && node.props['aria-pressed'] !== undefined && String(node.props.title ?? '').startsWith('当'))
  assert.equal(summaries().length, 2); summaries()[0].props.onClick(); ui.render()
  assert.equal(policyField(ui, 'rule-0-scenarios').props.value, 'incident-response, night-review')
  assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '规则 1 适用情况').props.value, 'combined')
  ui.nodes().find(node => node.type === 'form' && node.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); ui.render(); confirmPreview(ui); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint === 'mcp/control/saveConfiguration').payload.agents[0]
  assert.deepEqual(Array.from(saved.actions), ['read']); assert.deepEqual(Array.from(saved.serverIds), ['inspection'])
  assert.deepEqual(JSON.parse(JSON.stringify(saved.toolPolicies[0].rules[0])), { kinds: ['write'], when: { riskLevels: ['high'], scenarioIds: ['incident-response', 'night-review'], operationTags: ['sensitive', 'partner-tag'] }, effect: 'allow' })
  assert.equal(saved.toolPolicies[0].rules[1].effect, 'confirm')
})

test('非法原始配置只读保留，预览定位原文，重新读取恢复且不关闭窗口', async () => {
  const invalidAgents = [
    ...[null, 'broken', [{ serverId: 'inspection', defaultEffect: 'allow' }], [{ serverId: 'inspection', defaultEffect: 'allow', rules: [{ when: null, effect: 'deny' }] }], [{ serverId: 'inspection', defaultEffect: 'allow', rules: [{ when: 'high', effect: 'deny' }] }]].map(toolPolicies => [{ ...uiStatus().configuration.agents[0], toolPolicies }]),
    ...[null, 'read'].map(actions => [{ ...uiStatus().configuration.agents[0], actions }]),
    '[{"agentId":',
  ]
  for (const agents of invalidAgents) {
    const ui = page(); await ui.settle(); ui.tab('authorization').props.onClick(); ui.render()
    const original = ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 原始配置').props.value
    ui.restoreLegacyDraft(typeof agents === 'string' ? agents : JSON.stringify(agents, null, 2))
    ui.button('Agent高级设置').props.onClick(); ui.render()
    const raw = () => ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 原始配置')
    const text = raw().props.value
    assert.equal(text, typeof agents === 'string' ? agents : JSON.stringify(agents, null, 2))
    assert.equal(raw().props.readOnly, true); assert.equal(raw().props.onChange, undefined)
    assert.match(ui.text(ui.render()), /原始配置格式异常|服务规则格式异常/)
    ui.nodes().find(node => node.type === 'form' && node.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); ui.render()
    assert.equal(ui.nodes().find(node => node.props?.['data-detail-drawer'] === 'Agent高级设置').props['data-window-open'], true)
    assert.equal(raw().props.value, text)
    assert.match(ui.text(ui.render()), /重新读取状态.*修复配置来源/)
    assert.equal(ui.calls.some(call => call.endpoint === 'mcp/control/saveConfiguration'), false)
    await ui.button('刷新状态').props.onClick(); await ui.settle()
    assert.equal(raw().props.value, text, '重新读取保留旧版未保存原稿')
    ui.button('放弃草稿并读取当前配置').props.onClick(); ui.render()
    assert.equal(raw().props.value, original)
    assert.equal(ui.nodes().find(node => node.props?.['data-detail-drawer'] === 'Agent高级设置').props['data-window-open'], true)
  }
})

test('risk仅显示连接与结果，不提供内部要求或fixture输入，旧本地marker仅留历史', async () => {
  const value = uiStatus(); value.riskFacts = [{ id: 'retired', source: 'local-input-marker', version: 1, scope: binding, status: 'assessed', level: 'high', observedAt: new Date().toISOString(), expiresAt: future(), signals: [{ code: 'deny-all', value: 'true', reason: 'retired-marker-only' }] }]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }) }); await ui.settle(); ui.tab('risk').props.onClick(); ui.render()
  const provider = ui.nodes().find(node => node.props?.id === 'gateway-risk-provider')
  assert.equal(ui.nodes(provider).filter(node => node.type === 'input').length, 3)
  assert.equal(ui.nodes(provider).some(node => node.type === 'textarea' || node.props?.className === 'harness-gateway-inline-footer'), false)
  assert.equal(ui.button('预览配置'), undefined)
  assert.doesNotMatch(ui.text(ui.nodes().find(node => node.props?.['aria-label'] === '智能体风险摘要')), /retired-marker-only|高风险（已评估范围）/)
  assert.match(ui.text(ui.nodes().find(node => node.props?.['data-detail-drawer'] === '评估范围与历史依据')), /旧本地测试记录.*retired-marker-only/s)
  ui.nodes().find(node => node.props?.['data-gateway-field'] === 'riskAssessment-timeout').props.onChange({ target: { value: '950' } }); ui.render()
  assert.equal(ui.nodes().filter(node => node.type === 'button' && ui.text(node) === '预览配置').length, 1)
  ui.tab('authorization').props.onClick(); ui.render()
  ui.button('Agent高级设置').props.onClick(); ui.render()
  assert.equal(ui.nodes().some(node => node.props?.['data-gateway-field'] === 'requiredKinds'), false)
  assert.doesNotMatch(ui.text(ui.render()), /工作区访问设置|fixture ID|必须自动评估的动作/)
  assert.equal(ui.nodes().filter(node => node.type === 'button' && ui.text(node) === 'Agent高级设置').length, 1)
})

test('业务入口只在概览编辑，Agent高级设置无服务或无Agent时仍唯一可达', async () => {
  const ui = page(); await ui.settle()
  const entry = ui.nodes().find(node => node.props?.['aria-label'] === '业务入口')
  assert.match(ui.text(entry), /所有业务实例.*不控制 DSH 工作区读写和会话权限.*不停止容器/)
  const toggle = ui.nodes(entry).find(node => node.props?.role === 'switch')
  toggle.props.onChange({ target: { checked: false } }); ui.render()
  assert.equal(ui.nodes(ui.tab('overview')).some(node => node.props?.['aria-label'] === '有未保存更改'), true)
  assert.equal(ui.nodes(ui.tab('authorization')).some(node => node.props?.['aria-label'] === '有未保存更改'), false)
  ui.button('预览配置').props.onClick(); ui.render(); confirmPreview(ui); await ui.settle()
  assert.equal(ui.calls.find(call => call.endpoint === 'mcp/control/saveConfiguration').payload.enabled, false)
  ui.tab('authorization').props.onClick(); ui.render()
  assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '业务入口'), false)
  assert.equal(ui.nodes().filter(node => node.type === 'button' && ui.text(node) === 'Agent高级设置').length, 1)
  const empty = uiStatus(); empty.configuration.agents = []
  ui.current(empty); await ui.button('刷新状态').props.onClick(); await ui.settle()
  assert.equal(ui.nodes().filter(node => node.type === 'button' && ui.text(node) === 'Agent高级设置').length, 1)
  ui.button('Agent高级设置').props.onClick(); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['data-detail-drawer'] === 'Agent高级设置').props['data-window-open'], true)
})

test('机器来源与原始配置只读，中文权限编辑保留未知动作和系统操作绑定', async () => {
  const value = uiStatus(); value.configuration.agents[0] = { ...value.configuration.agents[0], sourceDigest: 'sha256:legacy-source', actions: ['read', 'session:read', 'historical-action'] }
  value.configuration.operations = [{ serverId: 'inspection', operationId: 'inspect', kind: 'read', method: 'GET', target: 'http://127.0.0.1/items', schemaDigest: 'sha256:schema', queryParameters: ['page'] }]
  const ui = page({ statusHandler: () => ({ ok: true, value: structuredClone(value) }) }); await ui.settle(); ui.tab('identity').props.onClick(); ui.render()
  assert.match(ui.text(ui.nodes().find(node => node.props?.['data-gateway-source-digest'] === 'soc')), /sha256:legacy-source/)
  assert.equal(ui.nodes().some(node => node.type === 'input' && node.props.value === 'sha256:legacy-source'), false)
  ui.tab('authorization').props.onClick(); ui.render(); ui.button('Agent高级设置').props.onClick(); ui.render()
  const raw = ui.nodes().find(node => node.props?.['aria-label'] === 'Agent 原始配置')
  assert.equal(raw.props.readOnly, true); assert.equal(raw.props.onChange, undefined)
  const labels = ui.nodes().filter(node => node.type === 'label').map(node => ui.text(node)).join('\n')
  assert.doesNotMatch(labels, /session:read|agent:access|historical-action/)
  assert.match(labels, /读取会话/); assert.match(ui.text(ui.render()), /未识别的历史权限.*原值已保留/)
  ui.nodes(ui.nodes().find(node => node.type === 'label' && ui.text(node) === '查询信息')).find(node => node.type === 'input').props.onChange({ target: { checked: false } }); ui.render()
  ui.button('操作定义').props.onClick(); ui.render()
  const operations = ui.nodes().find(node => node.props?.['aria-label'] === '操作原始配置')
  assert.equal(operations.props.readOnly, true); assert.equal(operations.props.onChange, undefined)
  ui.nodes().find(node => node.props?.['aria-label'] === '必要确认 1').props.onChange({ target: { checked: true } }); ui.render()
  ui.nodes().find(node => node.type === 'form' && node.props['aria-label'] === '统一网关配置').props.onSubmit({ preventDefault() {} }); ui.render(); confirmPreview(ui); await ui.settle()
  const saved = ui.calls.find(call => call.endpoint === 'mcp/control/saveConfiguration').payload
  assert.equal(saved.agents[0].sourceDigest, 'sha256:legacy-source')
  assert.deepEqual(Array.from(saved.agents[0].actions), ['session:read', 'historical-action'])
  assert.equal(saved.operations[0].schemaDigest, 'sha256:schema')
  assert.deepEqual(Array.from(saved.operations[0].queryParameters), ['page'])
  assert.equal(saved.operations[0].confirmation, true)
})

test('访问控制提供方与既有手动策略共存保存，探测只确认HTTP且移除不丢兜底', async t => {
  const f = await fixture(t), first = (await f.call('status')).value
  const before = structuredClone(f.config.agents)
  const saved = await f.call('saveConfiguration', { revision: first.revision, enabled: true, agents: first.configuration.agents,
    accessAuthorization: { endpoint: `${f.origin}/authorize`, timeoutMs: 750 } })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.configuration.providers.accessAuthorization, true)
  assert.equal(saved.value.configuration.accessAuthorization.endpoint, `${f.origin}/authorize`)
  assert.deepEqual(JSON.parse(readFileSync(f.path)).agents, before)
  assert.deepEqual(JSON.parse(readFileSync(f.path)).riskAssessment, f.config.riskAssessment)
  const probe = await f.call('probeProvider', { kind: 'accessAuthorization' })
  assert.equal(probe.ok, true); assert.equal(probe.value.httpStatus, 405); assert.equal(probe.value.contractChecked, false)
  assert.equal(f.remote.riskCalls.length, 0)
  const removed = await f.call('saveConfiguration', { revision: saved.value.revision, enabled: true, agents: saved.value.configuration.agents, accessAuthorization: null })
  assert.equal(removed.ok, true); assert.equal(removed.value.configuration.accessAuthorization.configured, false)
  assert.deepEqual(JSON.parse(readFileSync(f.path)).agents, before)
})

test('两份提供方规范只读返回程序侧同一Markdown，owner与kind边界保留', async t => {
  const f = await fixture(t), previousRoot = process.env.HARNESS_PROGRAM_ROOT
  process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
  t.after(() => { if (previousRoot === undefined) delete process.env.HARNESS_PROGRAM_ROOT; else process.env.HARNESS_PROGRAM_ROOT = previousRoot })
  const before = readFileSync(f.path, 'utf8')
  for (const kind of ['risk-assessment', 'access-control']) {
    const response = await f.call('providerProtocol', { kind })
    assert.equal(response.ok, true); assert.equal(response.value.kind, kind)
    const content = readFileSync(new URL(`../../../docs/platform-design/${response.value.filename}`, import.meta.url), 'utf8')
    assert.equal(response.value.content, content); assert.match(response.value.sha256, /^[a-f0-9]{64}$/)
    assert.equal((await f.call('providerProtocol', { kind }, { principal: { kind: 'harness-business' } })).error.code, 'forbidden')
  }
  assert.equal((await f.call('providerProtocol', { kind: '../credentials' })).error.code, 'invalid_request')
  assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.remote.riskCalls.length, 0)
})

test('第三方优先入口与默认关闭手动兜底同页，提供方草稿参与跨页保存校验', async () => {
  let saved
  const ui = page({ saveHandler(payload) { saved = payload; return { ok: true, value: uiStatus('saved') } } })
  await ui.settle(); ui.tab('authorization').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /第三方访问控制服务.*当前使用手动兜底策略/s)
  const manual = () => ui.nodes().find(node => node.props?.['data-detail-drawer'] === '手动兜底策略')
  assert.equal(manual().props['data-window-open'], false)
  ui.button('手动兜底策略').props.onClick(); ui.render(); assert.equal(manual().props['data-window-open'], true)
  const provider = () => ui.nodes().find(node => node.props?.['data-gateway-field'] === 'accessAuthorization-endpoint')
  const enabled = ui.nodes(ui.nodes().find(node => node.type === 'label' && ui.text(node) === '启用访问控制提供方')).find(node => node.type === 'input')
  enabled.props.onChange({ target: { checked: true } }); ui.render()
  const invalidForm = () => ui.nodes().find(node => node.props?.['aria-label'] === '第三方访问控制配置')
  invalidForm().props.onSubmit({ preventDefault() {} }); ui.render()
  assert.match(ui.text(ui.render()), /访问控制：请填写提供方地址/)
  assert.equal(manual().props['data-window-open'], false, '提供方字段校验失败应露出主区字段，不能仍被手动窗口遮住')
  provider().props.onChange({ target: { value: 'https://authorization.example/decide' } }); ui.render()
  const before = policyDraft(ui)
  invalidForm().props.onSubmit({ preventDefault() {} }); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['data-detail-drawer'] === '确认保存业务访问配置').props['data-window-open'], true)
  assert.doesNotMatch(ui.text(ui.render()), /访问控制：请填写提供方地址/)
  confirmPreview(ui); await ui.settle()
  assert.equal(saved.accessAuthorization.endpoint, 'https://authorization.example/decide')
  assert.deepEqual(JSON.parse(JSON.stringify(saved.agents[0])), JSON.parse(JSON.stringify(before)))
})

test('接口规范查看和下载复用同一回执，失败可重读且不保存配置', async () => {
  let failed = true
  const content = '# 访问控制协议\n\n只读规范正文。\n', filename = '25_第三方访问控制接口协议.md'
  const ui = page({ protocolHandler: ({ kind }) => failed ? { ok: false, error: { message: '规范暂不可读' } }
    : { ok: true, value: { kind, title: '访问控制协议', filename, content, version: '1.0', sha256: 'a'.repeat(64) } } })
  await ui.settle(); ui.tab('authorization').props.onClick(); ui.render()
  ui.button('查看接口规范').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /规范暂不可读/)
  failed = false; await ui.button('重新读取').props.onClick(); await ui.settle()
  assert.match(ui.text(ui.render()), /只读规范正文/)
  await ui.button('下载本规范').props.onClick(); await ui.settle()
  assert.equal(ui.downloads.length, 1); assert.equal(ui.downloads[0].filename, filename)
  assert.equal(decodeURIComponent(ui.downloads[0].href.split(',')[1]), content)
  assert.equal(ui.calls.filter(call => call.endpoint === 'mcp/control/providerProtocol').length, 2)
  assert.equal(ui.calls.some(call => /saveConfiguration|restrict|release|reassess/.test(call.endpoint)), false)
})

test('外部主授权配窄兜底仍能手动收紧和解除，解除结果不冒充本次第三方允许', async t => {
  const f = await fixture(t)
  f.remote.trustValid = true
  f.config.accessAuthorization = { endpoint: f.origin + '/authorize' }
  f.config.agents[0].actions = ['agent:access', 'session:read', 'session:create', 'session:prompt', 'read']
  f.config.agents[0].serverIds = ['fallback-only']
  delete f.config.riskAssessment
  writeFileSync(f.path, JSON.stringify(f.config)); f.control.configurationChanged()
  const scope = { ...binding, subjectId: 'subject-a', serverId: 'soc' }; delete scope.sourceDigest
  const restricted = await f.call('restrict', { scope, deniedActions: ['write'], reason: 'temporary-stop' })
  assert.equal(restricted.ok, true)
  const restriction = restricted.value.restrictions.find(item => item.active)
  const released = await f.call('release', { restrictionId: restriction.id, sessionId: 'session-a', action: 'write' })
  assert.equal(released.ok, true)
  assert.equal(released.value.restrictions.find(item => item.id === restriction.id).active, false)
  assert.equal(released.value.change.currentPermission, 'unknown')
  assert.equal(released.value.change.reason, 'external_authorization_required')
  assert.equal(released.value.change.businessReplayed, false)
  assert.equal(f.remote.businessCalls, 0); assert.equal(f.remote.riskCalls.length, 0)
})

test('显式解除遇风险服务不可用按手动核对，辅助重评仍不伪造结果', async t => {
  const f = await fixture(t)
  f.remote.trustValid = true
  f.config.riskAssessment = { endpoint: 'http://127.0.0.1:1/unavailable', timeoutMs: 25 }
  writeFileSync(f.path, JSON.stringify(f.config)); f.control.configurationChanged()
  const restriction = f.control.updateRestriction({ scope: { workspaceId: binding.workspaceId, agentId: 'soc', instanceId: binding.instanceId, runtimeGeneration: binding.runtimeGeneration, subjectId: 'subject-a', serverId: 'soc' }, deniedActions: ['write'], reason: 'manual', active: true })
  assert.equal((await f.call('reassess', { sessionId: 'session-a', action: 'write' })).error.code, 'risk_provider_unavailable')
  const released = await f.call('release', { restrictionId: restriction.id, sessionId: 'session-a', action: 'write' })
  assert.equal(released.ok, true); assert.equal(released.value.change.source, 'manual-fallback')
  assert.equal(released.value.restrictions.find(item => item.id === restriction.id).active, false)
  assert.equal(released.value.change.businessReplayed, false); assert.equal(f.remote.businessCalls, 0)
})

test('规范重读移除重试按钮后返焦关闭入口，助手焦点、关闭及迟到回执不抢焦', async () => {
  for (const destination of ['body', 'assistant', 'closed', 'inactive']) {
    let retry, first = true, focusCount = 0
    const ui = page({ protocolHandler: ({ kind }) => {
      if (first) { first = false; return { ok: false, error: { message: '读取失败' } } }
      return new Promise(resolve => { retry = () => resolve({ ok: true, value: { kind, title: '规范', filename: 'protocol.md', content: '# 规范\n', version: '1.0', sha256: 'a'.repeat(64) } }) })
    } })
    await ui.settle(); ui.tab('authorization').props.onClick(); ui.render()
    ui.button('查看接口规范').props.onClick(); await ui.settle()
    const root = ui.nodes().find(node => node.props?.className === 'harness-gateway-protocol-actions')
    const retryElement = { isConnected: true }, assistantElement = { isConnected: true }
    const closeElement = { focus() { focusCount++; ui.documentState.activeElement = closeElement } }
    const windowElement = { open: true, contains: element => element === retryElement, querySelector: () => closeElement }
    root.ref.current = { querySelector: () => windowElement }
    ui.documentState.activeElement = retryElement
    ui.button('重新读取').props.onClick(); ui.render()
    ui.documentState.activeElement = destination === 'assistant' ? assistantElement : ui.documentState.body
    if (destination === 'closed') windowElement.open = false
    if (destination === 'inactive') { ui.props.active = false; ui.render() }
    retry(); await ui.settle()
    assert.equal(focusCount, destination === 'body' ? 1 : 0, destination)
  }
})
