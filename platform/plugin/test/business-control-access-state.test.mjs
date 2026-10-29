import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const buildRoot = mkdtempSync(join(tmpdir(), 'gateway-access-state-build-'))
await build({ stdin: { contents: "export * from './src/business-control/core.ts'; export * from './src/business-control/management.ts'", resolveDir: process.cwd(), loader: 'ts' },
  outfile: join(buildRoot, 'control.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { getBusinessControl, createBusinessControlHandler } = await import(`file://${join(buildRoot, 'control.mjs')}`)
const source = (await build({ entryPoints: ['src/business-control/access-state.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'], logLevel: 'silent' })).outputFiles[0].text
const module = { exports: {} }
vm.runInNewContext(source, { module, exports: module.exports, require })
const { GatewayAccessState, matchesGatewayInstanceScope } = module.exports
test.after(() => rmSync(buildRoot, { recursive: true, force: true }))
const future = () => new Date(Date.now() + 60000).toISOString()
const binding = { workspaceId: 'workspace-a', agentId: 'soc', instanceId: 'current-runtime', runtimeGeneration: 'generation-1', sourceDigest: 'sha256:' + 'a'.repeat(64) }
const operations = [
  { serverId: 'soc', operationId: 'query', kind: 'read', method: 'GET', target: 'https://business.example/query' },
  { serverId: 'soc', operationId: 'writeback', kind: 'write', method: 'POST', target: 'https://business.example/writeback' },
]

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-access-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = { schemaVersion: 1, enabled: true,
    agents: [{ agentId: 'soc', enabled: true, subjects: ['subject-a', 'subject-b'], actions: ['*'], serverIds: ['soc'], sourceDigest: binding.sourceDigest }],
    operations, authentication: { endpoint: 'https://identity.example/auth' }, identityTrust: { endpoint: 'https://identity.example/trust' },
    riskAssessment: { endpoint: 'https://risk.example/evaluate', requiredKinds: ['write', 'publish'] },
    detection: { inputMarkers: ['INPUT-MARKER'] }, gateway: { instances: [{ ...binding }] } }
  mkdirSync(join(root, 'config'))
  const path = join(root, 'config/business-access.json')
  writeFileSync(path, JSON.stringify(config))
  const control = getBusinessControl(root)
  control.registerInstance(binding)
  const acknowledge = () => {
    control.recordAgentAuthentication(binding)
    const snapshot = control.issueSnapshot(binding.instanceId)
    control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId)
  }
  acknowledge()
  const context = control.bindSession(control.createContext({ subject: { id: 'subject-a', kind: 'human', identitySource: 'https://identity.example' },
    evidence: { issuer: 'https://identity.example', externalSubject: 'subject-a', method: 'bearer', verifiedAt: new Date().toISOString(), expiresAt: future(), credentialRef: 'fixture' }, expiresAt: future() }, binding), 'session-a')
  const handler = createBusinessControlHandler(root)
  const registration = { phase: 'ready', rows: [{ name: binding.instanceId, agent_id: 'soc', state: 'running' }] }
  return { config, control, context, registration,
    acknowledge,
    save() { writeFileSync(path, JSON.stringify(config)); control.configurationChanged() },
    risk(id, values = {}) { return control.updateRisk({ id, version: 1, scope: { ...context.scope }, status: 'assessed', level: 'high', signals: [], source: 'fixture-provider', observedAt: new Date().toISOString(), expiresAt: future(), ...values }) },
    manual(id, values = {}) { return control.updateRestriction({ id, scope: { ...context.scope, serverId: 'soc' }, deniedActions: ['write'], reason: id, active: true, ...values }) },
    async props(values = {}) {
      const response = await handler('status', {}, new AbortController().signal, { principal: { kind: 'owner' } })
      assert.equal(response.ok, true)
      return { data: response.value, selectedAgentId: 'soc', registration, onNavigateRisk() {}, onNavigateOverview() {}, ...values }
    } }
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object') return []
  if (typeof value.type === 'function') return nodes(value.type(value.props))
  return [value, ...nodes(value.props?.children)]
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value && typeof value === 'object') return value.type === 'style' ? '' : text(typeof value.type === 'function' ? value.type(value.props) : value.props?.children)
  return typeof value === 'boolean' ? '' : String(value ?? '')
}
const render = props => GatewayAccessState(props)
const riskIds = tree => nodes(tree).filter(node => node.props?.['data-risk-id']).map(node => node.props['data-risk-id'])
const manualIds = tree => nodes(tree).filter(node => node.props?.['data-restriction-id']).map(node => node.props['data-restriction-id'])

test('开发记录同步采用真实同步事实，无发布 ACK 且超过租约窗口仍准确显示', async t => {
  const f = await fixture(t)
  f.config.gateway.instances[0].identityMode = 'development'; f.save()
  f.control.recordSynchronization(binding)
  let props = await f.props({ now: Date.now() + 10000 })
  assert.equal(props.data.instances[0].applied, false, '不得制造发布许可 ACK')
  let tree = render(props)
  assert.match(text(tree), /开发记录已同步，无需发布许可回执/)
  assert.doesNotMatch(text(tree), /当前配置应用待核对|回执已过期/)
  f.control.recordSynchronization(binding, '记录同步失败')
  props = await f.props()
  tree = render(props)
  assert.match(text(tree), /记录同步失败，不阻断开发交互/)
  assert.doesNotMatch(text(tree), /开发记录已同步/)
  f.control.recordSynchronization(binding)
  assert.match(text(render(await f.props())), /开发记录已同步，无需发布许可回执/)
})

test('动态区只投影已保存的拒绝信号，高等级本身不等于权限收紧，低等级有拒绝仍显示', async t => {
  const f = await fixture(t)
  f.risk('high-without-denial')
  let tree = render(await f.props())
  assert.equal(tree.props['aria-label'], '运行时限制')
  assert.match(text(tree), /当前访问决定与限制/)
  assert.doesNotMatch(text(tree), /静态|当前动态约束/)
  assert.deepEqual(riskIds(tree), [])
  assert.match(text(tree), /未发现有效自动拒绝信号/)
  assert.doesNotMatch(text(tree), /已放开全部|全部允许|智能体已被禁/)
  f.risk('low-with-denial', { level: 'low', signals: [{ code: 'deny-read', value: 'true', reason: 'query-denied' }] })
  assert.throws(() => f.control.assert(f.context, 'read'), { code: 'risk_restricted' })
  tree = render(await f.props())
  assert.deepEqual(riskIds(tree), ['low-with-denial'])
  assert.match(text(tree), /读取/)
})

test('关闭自动评估后旧事实不列为生效约束，独立手工限制保留，重新开启恢复原事实', async t => {
  const f = await fixture(t)
  f.risk('automatic-deny', { signals: [{ code: 'deny-write', value: 'true', reason: 'automatic' }] })
  f.manual('manual-deny')
  const provider = f.config.riskAssessment
  delete f.config.riskAssessment; f.save()
  let tree = render(await f.props())
  assert.deepEqual(riskIds(tree), [])
  assert.deepEqual(manualIds(tree), ['manual-deny'])
  assert.match(text(tree), /旧自动评估只作历史记录/)
  assert.throws(() => f.control.assert({ ...f.context, scope: { ...f.context.scope, serverId: 'soc' } }, 'write'), { code: 'risk_restricted' })
  f.config.riskAssessment = provider; f.save()
  tree = render(await f.props())
  assert.deepEqual(riskIds(tree), ['automatic-deny'])
  assert.deepEqual(manualIds(tree), ['manual-deny'])
})

test('单次内容检测保留用户会话服务及内容范围，不扩大为整个智能体禁用', async t => {
  const f = await fixture(t)
  const context = { ...f.context, scope: { ...f.context.scope, serverId: 'soc' } }
  f.risk('external-content-bound', { scope: context.scope, contentDigest: createHash('sha256').update(JSON.stringify('INPUT-MARKER')).digest('hex'),
    signals: [{ code: 'deny-all', value: 'true', reason: 'third-party-content-evidence' }] })
  assert.throws(() => f.control.assert(context, 'read', [], 'INPUT-MARKER'), { code: 'risk_restricted' })
  assert.equal(f.control.assert(context, 'read', [], 'different content').kind, 'allow')
  const tree = render(await f.props()), rendered = text(tree)
  assert.equal(riskIds(tree).length, 1)
  assert.match(rendered, /仅相同内容/)
  assert.match(rendered, /接入用户 subject-a · 会话 session-a · 服务 soc/)
  assert.match(rendered, /运行代次 generation-1/)
  assert.match(rendered, /内容依据/)
  assert.doesNotMatch(rendered, /整个智能体.*禁|所有会话.*禁/)
})

test('具体操作拒绝与动作拒绝分开，内容摘要不掩盖核心实际操作ID边界', async t => {
  const f = await fixture(t)
  f.risk('operation-deny', { scope: { ...f.context.scope, serverId: 'soc' }, contentDigest: 'recorded-content-digest',
    signals: [{ code: 'deny-operation', value: 'query', reason: 'specific operation' }] })
  const context = { ...f.context, scope: { ...f.context.scope, serverId: 'soc' } }
  assert.throws(() => f.control.assertOperation(context, { ...operations[0], args: 'other content' }), { code: 'risk_restricted' })
  const tree = render(await f.props())
  assert.match(text(tree), /操作 soc \/ query（读取）/)
  assert.match(text(tree), /不限定内容参数/)
  assert.match(text(tree), /recorded-content-digest/)
})

test('当前范围排除历史实例、其他工作区与运行代次，Agent范围事实可匹配当前实例', async t => {
  const f = await fixture(t)
  const deny = [{ code: 'deny-read', value: 'true', reason: 'scope' }]
  f.risk('other-instance', { scope: { ...f.context.scope, instanceId: 'deleted-runtime' }, signals: deny })
  f.risk('other-workspace', { scope: { ...f.context.scope, workspaceId: 'workspace-b' }, signals: deny })
  f.risk('other-generation', { scope: { ...f.context.scope, runtimeGeneration: 'generation-0' }, signals: deny })
  f.risk('agent-scope', { scope: { workspaceId: binding.workspaceId, agentId: binding.agentId }, signals: deny })
  f.manual('historical-manual', { scope: { ...f.context.scope, instanceId: 'deleted-runtime' } })
  assert.deepEqual(riskIds(render(await f.props())), ['agent-scope'])
  assert.deepEqual(manualIds(render(await f.props())), [])
  assert.equal(matchesGatewayInstanceScope({ ...f.context.scope, runtimeGeneration: 'generation-0' }, binding), false)
  f.registration.rows = []
  const tree = render(await f.props())
  assert.deepEqual(riskIds(tree), [])
  assert.match(text(tree), /没有当前实例登记/)
})

test('不同事实ID的约束叠加，同范围后来的低风险不能掩盖另一条仍有效的拒绝', async t => {
  const f = await fixture(t)
  f.risk('earlier-independent-denial', { version: 1, signals: [{ code: 'deny-read', value: 'true', reason: 'still effective' }] })
  f.risk('later-low-other-id', { version: 20, level: 'low' })
  assert.throws(() => f.control.assert(f.context, 'read'), { code: 'risk_restricted' })
  assert.deepEqual(riskIds(render(await f.props())), ['earlier-independent-denial'])
})

test('同一事实的较新版本解除信号后，输入中残留的旧版本不会重复显示为当前限制', async t => {
  const f = await fixture(t)
  f.risk('reassessed', { signals: [{ code: 'deny-read', value: 'true', reason: 'old' }] })
  const old = f.control.status().riskFacts[0]
  f.risk('reassessed', { version: 2, level: 'low' })
  assert.equal(f.control.assert(f.context, 'read').kind, 'allow')
  const props = await f.props()
  props.data.riskFacts.push(old)
  assert.deepEqual(riskIds(render(props)), [])
})

test('没有事实、未知或过期只提示待评估，测试提供方有明确标识，基础策略不开放不显示宽泛允许', async t => {
  const f = await fixture(t)
  let tree = render(await f.props())
  assert.match(text(tree), /尚无评估记录/)
  assert.equal(f.control.assert(f.context, 'write').kind, 'allow', '没有有效风险事实时按手动基础权限兜底，不捏造评估')
  f.risk('unknown', { status: 'unknown', level: 'unknown' })
  f.risk('expired', { expiresAt: new Date(Date.now() - 1000).toISOString(), signals: [{ code: 'deny-write', value: 'true', reason: 'past' }] })
  f.config.riskAssessment.testRunId = 'isolated-test'; f.config.agents[0].actions = []; f.save()
  tree = render(await f.props())
  assert.deepEqual(riskIds(tree), [])
  assert.match(text(tree), /1 条评估结果未知/)
  assert.match(text(tree), /1 条评估记录已过期/)
  assert.match(text(tree), /测试模拟提供方/)
  assert.throws(() => f.control.assert(f.context, 'read'), { code: 'action_forbidden' })
  assert.doesNotMatch(text(tree), /全部允许|当前许可.*允许|已放开全部/)
})

test('登记或状态读取失败不把旧事实称为当前；回执匹配版本、运行状态和时效才确认同步', async t => {
  const f = await fixture(t)
  f.risk('current-denial', { signals: [{ code: 'deny-read', value: 'true', reason: 'read' }] })
  f.acknowledge()
  let props = await f.props(), tree = render(props)
  assert.match(text(tree), /当前配置已同步/)
  tree = render({ ...props, now: Date.now() + 3000 })
  assert.match(text(tree), /当前配置应用待核对/)
  assert.doesNotMatch(text(tree), /当前配置已同步/)
  tree = render({ ...props, statusError: 'network unavailable' })
  assert.equal(tree.props['data-access-evidence'], 'snapshot')
  assert.match(text(tree), /上次读取的自动拒绝信号/)
  assert.doesNotMatch(text(tree), /当前配置已同步/)
  tree = render({ ...props, registration: { ...f.registration, phase: 'error', error: 'registration unavailable' } })
  assert.deepEqual(riskIds(tree), [])
  assert.match(text(tree), /当前作用范围未知/)
  f.registration.rows[0].state = 'absent'
  tree = render(props)
  assert.match(text(tree), /实例未运行，未确认应用/)
})

test('开发调试不伪造发布阶段约束，页面入口只导航不写入', async t => {
  const f = await fixture(t)
  f.config.gateway.instances[0].identityMode = 'development'; f.save()
  f.risk('development-auto', { signals: [{ code: 'deny-all', value: 'true', reason: 'ignored' }] })
  f.manual('development-manual')
  const called = []
  const tree = render(await f.props({ onNavigateRisk: () => called.push('risk'), onNavigateOverview: () => called.push('overview') }))
  assert.deepEqual(riskIds(tree), [])
  assert.deepEqual(manualIds(tree), [])
  assert.match(text(tree), /开发调试模式/)
  for (const button of nodes(tree).filter(node => node.type === 'button')) button.props.onClick()
  assert.deepEqual(called, ['risk', 'overview'])
  assert.equal(f.control.status().restrictions[0].active, true)
})

test('服务条件只说明已保存设置与当前启停，不把尚未执行的规则显示为已触发', async t => {
  const f = await fixture(t)
  f.config.agents[0].toolPolicies = [
    { serverId: 'soc', defaultEffect: 'allow', rules: [{ when: { scenarioIds: ['incident'] }, effect: 'confirm' }, { operationIds: ['query'], when: {}, effect: 'allow' }] },
    { serverId: 'reports', defaultEffect: 'deny', rules: [] },
  ]; f.save()
  let tree = render(await f.props({ selectedServerId: 'soc' }))
  assert.equal(nodes(tree).filter(node => node.props?.['data-policy-server']).length, 1)
  assert.match(text(tree), /默认按基础权限允许/)
  assert.match(text(tree), /1 条第三方条件已启用/)
  assert.match(text(tree), /尚未执行的规则不表示已经触发/)
  assert.deepEqual(riskIds(tree), [])
  delete f.config.riskAssessment; f.save()
  tree = render(await f.props({ selectedServerId: 'soc' }))
  assert.match(text(tree), /1 条第三方条件已暂停/)
  assert.match(text(tree), /仅执行默认处理、工具或动作规则和人工限制/)
})

test('旧本地marker只展示历史提示，新操作绑定拒绝明确仅同一操作目标和参数', async t => {
  const f = await fixture(t)
  f.risk('retired-marker', { source: 'local-input-marker', signals: [{ code: 'deny-all', value: 'true', reason: 'retired' }] })
  assert.equal(f.control.assert(f.context, 'read').kind, 'allow')
  let tree = render(await f.props())
  assert.deepEqual(riskIds(tree), [])
  assert.match(text(tree), /旧本地标记记录仅作历史依据/)
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const actual = { ...operations[0], args: { key: 'same-input' } }
  f.risk('bound-denial', { scope: { ...f.context.scope, serverId: 'soc' }, operationBinding: { serverId: 'soc', operationId: 'query', kind: 'read', method: 'GET', targetDigest: digest(actual.target), inputDigest: digest(actual.args) }, signals: [{ code: 'deny-operation', value: 'query', reason: 'third-party' }] })
  const scoped = { ...f.context, scope: { ...f.context.scope, serverId: 'soc' } }
  assert.throws(() => f.control.assertOperation(scoped, actual), { code: 'risk_restricted' })
  assert.doesNotThrow(() => f.control.assertOperation(scoped, { ...actual, args: { key: 'other-input' } }))
  tree = render(await f.props())
  assert.deepEqual(riskIds(tree), ['bound-denial'])
  assert.match(text(tree), /仅操作 soc \/ query/)
  assert.match(text(tree), /仅同一操作、目标与相同参数/)
})

test('读取反馈不占正文，登记未确认时仍明确范围未知且不投影旧限制', async t => {
  const f = await fixture(t)
  f.risk('old-denial', { signals: [{ code: 'deny-write', value: 'true', reason: 'past' }] })
  let tree = render(await f.props({ data: null, statusLoading: true, registration: { phase: 'loading', rows: [] } }))
  assert.equal(nodes(tree).filter(node => node.props?.role === 'status' && node.props?.['aria-label']).length, 1)
  assert.doesNotMatch(text(tree), /正在读取|正在核对/)
  tree = render(await f.props({ registration: { ...f.registration, phase: 'loading' } }))
  assert.equal(tree.props['data-access-evidence'], 'unknown')
  assert.deepEqual(riskIds(tree), [])
  assert.match(text(tree), /当前作用范围未知/)
  assert.doesNotMatch(text(tree), /正在读取|正在核对/)
  assert.ok(nodes(tree).some(node => node.props?.['aria-label'] === '核对运行时限制'))
})

test('单次访问回执按当前实例代次和服务展示来源，不冒充长期许可或使用旧实例记录', async t => {
  const f = await fixture(t)
  f.config.accessAuthorization = { endpoint: 'https://access.example/decide' }; f.save()
  const props = await f.props({ selectedServerId: 'soc' })
  const receipt = { source: 'third-party', decision: 'allow', policyVersion: 'policy-current', reason: 'current-request-only', expiresAt: future() }
  props.data.events = [
    { id: 'current', at: new Date().toISOString(), scope: { ...f.context.scope, serverId: 'soc' }, action: 'read', outcome: 'completed', operationId: 'query', authorization: receipt },
    { id: 'old', at: new Date().toISOString(), scope: { ...f.context.scope, runtimeGeneration: 'old-generation', serverId: 'soc' }, action: 'read', outcome: 'completed', authorization: { ...receipt, reason: 'old-private-receipt' } },
    { id: 'other-service', at: new Date().toISOString(), scope: { ...f.context.scope, serverId: 'reports' }, action: 'read', outcome: 'completed', authorization: { ...receipt, reason: 'other-service-receipt' } },
  ]
  const tree = render(props)
  assert.match(text(tree), /第三方优先，手动兜底/)
  assert.match(text(tree), /第三方决定.*current-request-only.*policy-current/s)
  assert.doesNotMatch(text(tree), /old-private-receipt|other-service-receipt/)
  assert.match(text(tree), /不代表智能体永久获准/)
  assert.match(text(tree), /授权方式：第三方优先，手动兜底/)
  assert.equal(nodes(tree).filter(node => node.props?.['data-authorization-source'] === 'third-party').length, 1)
  props.data.events[0].authorization = { ...receipt, source: 'manual-fallback', decision: 'deny', reason: '按已保存策略兜底' }
  assert.match(text(render(props)), /禁止 · 手动兜底/)
  props.data.events[0].authorization.expiresAt = new Date(Date.now() - 1000).toISOString()
  assert.match(text(render(props)), /回执已过期/)
})
