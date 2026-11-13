import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createNativeThreatServices } from '../src/threat-services.ts'
import { ensureThreatSource, THREAT_SOURCE_COMMIT, THREAT_SOURCE_DIRECTORY } from '../src/threat/source.ts'

let repository
const active = () => new AbortController().signal
const defaultRoute = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }
const payload = () => ({ model: 'internal-alias', temperature: 0.1, messages: [
  { role: 'system', content: '仅根据基本运维记录给出结构化状态。' },
  { role: 'user', content: '{"asset_id":9107,"status":"ONLINE"}' },
], tools: [{ name: 'basic_status', description: '基础状态样例' }] })
let temporaryHome, previousHome
before(async () => {
  previousHome = process.env.DSH_HOME
  temporaryHome = await mkdtemp(join(tmpdir(), 'threat-native-services-'))
  process.env.DSH_HOME = temporaryHome
  repository = await mkdtemp(join(tmpdir(), 'threat-native-history-'))
  execFileSync('git', ['clone', '--shared', '--no-checkout', process.env.HARNESS_ASSET_ROOT, repository], { stdio: 'ignore' })
})
after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // 只调整本测试临时目录中的只读 Git 制品，以便完整清理。
  async function writable(path) {
    const stat = await lstat(path)
    if (stat.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) }
    else if (!stat.isSymbolicLink()) await chmod(path, 0o600)
  }
  if (repository) await rm(repository, { recursive: true, force: true })
  if (temporaryHome) { await writable(temporaryHome); await rm(temporaryHome, { recursive: true, force: true }) }
})

function nativeModel(chunks) {
  const preparations = [], streams = []
  return { preparations, streams,
    async prepareCall(config, signal) {
      preparations.push({ config, signal })
      return { config: { ...config, model: 'native-resolved-model' }, async *stream(request) {
        streams.push(request)
        for (const chunk of chunks) { request.signal.throwIfAborted(); yield chunk }
      } }
    },
  }
}
const dispatchNotExpected = async () => assert.fail('模型推理不得调用业务工具')

// 网络、凭据和真实模型均在服务边界隔离；下面会导入固定 Git 源码中的真实 inferFrozen。
test('工具分派保留连接、原始参数和同一取消信号；错误回执不暴露管理器细节', async () => {
  const calls = [], signal = active(), args = { incidentId: 'INC-20261015-000001' }
  const value = { status: 'success', result: { code: 200, data: { status: 'OPEN' } } }
  const services = createNativeThreatServices(repository, async (...input) => { calls.push(input); return { status: 200, value } }, {}, () => defaultRoute,
    () => [{ id: 'fixture-soc', endpointUrl: 'http://fixture.invalid/mcp', kind: 'mcp-http' }])
  assert.equal(await services.invoke('fixture-soc', 'incident_lookup', args, signal), value)
  assert.deepEqual(calls[0], [{ action: 'callTool', serverId: 'fixture-soc', toolName: 'incident_lookup', arguments: args, timeoutMs: 120_000 }, signal])
  assert.equal(calls[0][0].arguments, args)
  assert.equal(calls[0][1], signal)
  const failed = createNativeThreatServices(repository, async () => ({ status: 502, value: { error: 'fixture-private-manager-detail' } }), {}, () => defaultRoute)
  await assert.rejects(() => failed.invoke('fixture-soc', 'incident_lookup', {}, signal), error => {
    assert.match(error.message, /依赖工具调用失败.*连接=fixture-soc.*阶段=invocation.*操作=incident_lookup.*MCP调度状态=502/u)
    assert.doesNotMatch(error.message, /fixture-private-manager-detail/)
    return true
  })
})

test('SOC OpenAPI映射body.arguments，规格只发现一次且不改变调用方参数', async () => {
  const calls = [], signal = active()
  const toolName = 'ai_soc_correlate__get_correlate_incident_by_incident_id'
  const args = Object.freeze({ incidentId: 'INC-20261015-000001' })
  const servers = [{ id: 'fixture-soc', specUrl: 'http://fixture.invalid/openapi/v1' }]
  const services = createNativeThreatServices(repository, async (request, receivedSignal) => {
    calls.push({ request, signal: receivedSignal })
    return { status: 200, value: request.action === 'test' ? { tools: [{ name: toolName, inputSchema: { properties: { body: { properties: { arguments: { type: 'object' } } } } } }] } : { code: 200 } }
  }, {}, () => defaultRoute, () => servers)
  await services.invoke('fixture-soc', toolName, args, signal)
  await services.invoke('fixture-soc', toolName, args, signal)
  assert.equal(calls.filter(call => call.request.action === 'test').length, 1)
  const invocations = calls.filter(call => call.request.action === 'callTool')
  assert.equal(invocations.length, 2)
  for (const { request } of invocations) {
    assert.deepEqual(request.arguments, { body: { arguments: args } })
    assert.equal(request.arguments.body.arguments, args)
  }
  assert.ok(calls.every(call => call.signal === signal))
  assert.deepEqual(args, { incidentId: 'INC-20261015-000001' })
})

test('相同连接切换specUrl后重新发现，普通HTTP body不额外增加arguments层', async () => {
  const calls = [], args = Object.freeze({ status: 'NORMAL' })
  let specUrl = 'http://fixture.invalid/openapi/v1', discoveries = 0
  const services = createNativeThreatServices(repository, async request => {
    calls.push(request)
    if (request.action === 'test') {
      discoveries++
      const body = discoveries === 1 ? { properties: { arguments: { type: 'object' } } } : { type: 'object', properties: { status: { type: 'string' } } }
      return { status: 200, value: { tools: [{ name: 'save_basic_status', inputSchema: { properties: { body } } }] } }
    }
    return { status: 200, value: { code: 200 } }
  }, {}, () => defaultRoute, () => [{ id: 'fixture-soc', specUrl }])
  await services.invoke('fixture-soc', 'save_basic_status', args, active())
  specUrl = 'http://fixture.invalid/openapi/v2'
  await services.invoke('fixture-soc', 'save_basic_status', args, active())
  await services.invoke('fixture-soc', 'save_basic_status', args, active())
  assert.equal(discoveries, 2)
  const invocations = calls.filter(request => request.action === 'callTool')
  assert.deepEqual(invocations.map(request => request.arguments), [{ body: { arguments: args } }, { body: args }, { body: args }])
  assert.equal(invocations[1].arguments.body, args)
  assert.deepEqual(args, { status: 'NORMAL' })
})

test('连接身份只固定目标，凭据轮换仍可调用，地址或协议改变在实际调用前拒绝', async () => {
  const server = { id: 'soc', url: 'http://fixture.invalid/mcp', headers: [{ name: 'Authorization', value: 'fixture-token-v1' }], enabled: true }
  const calls = []
  const services = createNativeThreatServices(repository, async request => { calls.push(request); return { status: 200, value: {} } }, {}, () => defaultRoute, () => [server])
  const expected = services.connectionFingerprint('soc')
  assert.match(expected, /^[a-f0-9]{64}$/)
  server.headers[0].value = 'fixture-token-v2'
  server.apiKey = 'fixture-api-key-v2'
  server.loginPassword = 'fixture-password-v2'
  assert.equal(services.connectionFingerprint('soc'), expected)
  await services.invoke('soc', 'basic_status', {}, active(), expected)
  server.url = 'http://other-fixture.invalid/mcp'
  await assert.rejects(() => services.invoke('soc', 'basic_status', {}, active(), expected), /threat_connection_conflict/)
  assert.equal(calls.length, 1)
  server.url = ''; server.specUrl = 'http://fixture.invalid/mcp'
  await assert.rejects(() => services.invoke('soc', 'basic_status', {}, active(), expected), /threat_connection_conflict/)
  assert.equal(calls.length, 1)
  server.specUrl = 'http://fixture.invalid/openapi?api_key=fixture-key-v1&version=1'
  const withQuery = services.connectionFingerprint('soc')
  server.specUrl = 'http://fixture.invalid/openapi?api_key=fixture-key-v2&version=1'
  assert.equal(services.connectionFingerprint('soc'), withQuery)
})

test('OpenAPI发现期间切换同ID目标在callTool前拒绝，不把发现旧规格用于新目标', async () => {
  const server = { id: 'soc', specUrl: 'http://fixture.invalid/openapi/v1' }, calls = []
  const services = createNativeThreatServices(repository, async request => {
    calls.push(request)
    server.specUrl = 'http://fixture.invalid/openapi/v2'
    return { status: 200, value: { tools: [{ name: 'basic_status', inputSchema: { properties: {} } }] } }
  }, {}, () => defaultRoute, () => [server])
  const expected = services.connectionFingerprint('soc')
  await assert.rejects(() => services.invoke('soc', 'basic_status', {}, active(), expected), /threat_connection_conflict/)
  assert.deepEqual(calls.map(request => request.action), ['test'])
})

test('OpenAPI未暴露操作或规格发现失败时拒绝调用，不泄露规格诊断内容', async () => {
  for (const reply of [{ status: 200, value: { tools: [] } }, { status: 502, value: { error: 'fixture-private-spec-detail' } }]) {
    const calls = []
    const services = createNativeThreatServices(repository, async request => { calls.push(request); return reply }, {}, () => defaultRoute,
      () => [{ id: 'fixture-soc', specUrl: 'http://fixture.invalid/openapi' }])
    await assert.rejects(() => services.invoke('fixture-soc', 'absent_operation', {}, active()), error => {
      assert.match(error.message, /(?:依赖工具发现失败|未暴露所需工具)/)
      assert.doesNotMatch(error.message, /fixture-private-spec-detail/)
      return true
    })
    assert.deepEqual(calls.map(request => request.action), ['test'])
  }
})

test('预先取消在外部工具或模型准备前停止，默认模型与显式路由分别解析', async () => {
  let dispatches = 0, defaults = 0, modelPreparations = 0
  const services = createNativeThreatServices(repository, async () => { dispatches++; return { status: 200, value: {} } }, { prepareCall() { modelPreparations++; assert.fail('已取消请求不得采样') } }, () => { defaults++; return defaultRoute })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => services.invoke('fixture-soc', 'incident_lookup', {}, controller.signal), { name: 'AbortError' })
  await assert.rejects(() => services.inferFrozen(payload(), undefined, controller.signal), { name: 'AbortError' })
  assert.equal(dispatches, 0)
  assert.equal(modelPreparations, 0)
  assert.deepEqual(services.resolveModel(), defaultRoute)
  const explicit = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'low' }
  assert.deepEqual(services.resolveModel(explicit), explicit)
  assert.equal(defaults, 1)
  assert.throws(() => createNativeThreatServices(repository, dispatchNotExpected, {}, () => ({})).resolveModel(), /平台默认模型尚未配置/)
})

test('固定源码inferFrozen仅使用两条冻结消息、无工具、一次原生准备并保留实际模型', async () => {
  const model = nativeModel([
    { type: 'text-delta', text: '{"status":' },
    { type: 'text-delta', text: '"normal"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  let defaults = 0
  const services = createNativeThreatServices(repository, dispatchNotExpected, model, () => { defaults++; return defaultRoute })
  const signal = active(), frozen = payload()
  const result = await services.inferFrozen(frozen, undefined, signal)
  assert.deepEqual(result, { model: 'native-resolved-model', choices: [{ message: { content: '{"status":"normal"}' } }] })
  assert.equal(defaults, 1)
  assert.equal(model.preparations.length, 1)
  assert.deepEqual(model.preparations[0].config, { ...defaultRoute, temperature: 0.1 })
  assert.equal(model.preparations[0].signal, signal)
  assert.equal(model.streams.length, 1)
  assert.equal(model.streams[0].signal, signal)
  assert.equal(model.streams[0].system, frozen.messages[0].content)
  assert.deepEqual(model.streams[0].messages, [{ role: 'user', content: [{ type: 'text', text: frozen.messages[1].content }] }])
  assert.equal('tools' in model.streams[0], false)
  assert.equal('toolChoice' in model.streams[0], false)
  // 对照 Git 字节，证明执行的是固定来源制品，而非改写后的工作树副本。
  const source = await ensureThreatSource(repository)
  assert.equal(source.commit, THREAT_SOURCE_COMMIT)
  assert.ok(source.root.startsWith(temporaryHome + '/'))
  assert.deepEqual(await readFile(source.bridgeModule), await readFile(new URL(`../algorithm/${THREAT_SOURCE_DIRECTORY}.mjs`, import.meta.url)))
})

test('显式模型不读取默认路由；非法冻结消息在任何模型准备前拒绝', async () => {
  const model = nativeModel([{ type: 'text-delta', text: '基础状态正常' }, { type: 'finish', reason: { kind: 'stop' } }])
  const services = createNativeThreatServices(repository, dispatchNotExpected, model, () => assert.fail('显式模型不得读取平台默认'))
  const route = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'off' }
  await services.inferFrozen(payload(), route, active())
  assert.deepEqual(model.preparations[0].config, { ...route, temperature: 0.1 })
  for (const messages of [[], [{ role: 'user', content: '基础状态' }, { role: 'system', content: '规则' }], [...payload().messages, { role: 'assistant', content: '额外内容' }]]) {
    await assert.rejects(() => services.inferFrozen({ ...payload(), messages }, route, active()), /invalid frozen model input/)
  }
  assert.equal(model.preparations.length, 1)
})

test('固定源码拒绝无finish、非stop或空白结果，不以部分文本当作成功且不重采样', async () => {
  for (const chunks of [
    [{ type: 'text-delta', text: '基础状态' }],
    [{ type: 'text-delta', text: '基础状态' }, { type: 'finish', reason: { kind: 'length' } }],
    [{ type: 'text-delta', text: '  ' }, { type: 'finish', reason: { kind: 'stop' } }],
  ]) {
    const model = nativeModel(chunks)
    const services = createNativeThreatServices(repository, dispatchNotExpected, model, () => defaultRoute)
    await assert.rejects(() => services.inferFrozen(payload(), undefined, active()), /(?:empty|incomplete) threat-analysis model response/)
    assert.equal(model.preparations.length, 1)
    assert.equal(model.streams.length, 1)
  }
})
