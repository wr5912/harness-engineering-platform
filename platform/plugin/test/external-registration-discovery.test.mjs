import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const buildRoot = mkdtempSync(join(tmpdir(), 'external-discovery-build-'))
await Promise.all(['registry', 'discovery', 'adapters'].map(name => build({ entryPoints: [`src/instances/external/${name}.ts`], outfile: join(buildRoot, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })))
const registry = await import(`file://${join(buildRoot, 'registry.mjs')}`)
const { discoverExternal } = await import(`file://${join(buildRoot, 'discovery.mjs')}`)
const { probeExternal } = await import(`file://${join(buildRoot, 'adapters.mjs')}`)
const require = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-gateway/package.json'))
const { WebSocketServer } = require('ws')
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))
const signal = () => new AbortController().signal
let serial = 0
function dataRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'external-discovery-'))
  mkdirSync(join(root, 'config')); mkdirSync(join(root, '.local/credentials/external'), { recursive: true })
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], untouched: { yes: true } }))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function save(root, instance, agent, policy) {
  return registry.mutateExternal(root, 'save', { revision: registry.externalInstances(root).revision, requestId: `save-${++serial}`, instance, ...(agent === undefined ? {} : { agent }), ...(policy === undefined ? {} : { policy }) })
}
async function upstream(t) {
  const root = dataRoot(t), calls = [], state = { workspaces: [{ workspaceId: 'workspace-one', title: '分析工作区', path: '/workspace' }], presets: [{ id: 'preset-one', name: '分析助手', description: '处理分析任务', isDefault: true }], agents: [{ id: 'native-record-id', data: { id: 'different-inner-id', name: '原生业务助手', invite_config: { invite_description: '这是邀请用途说明' } } }], httpStatus: 200, wsStatus: 101, wsCode: undefined, canceled: 0, quiet: false, version: '2.2.5' }
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    calls.push({ path: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : undefined })
    res.setHeader('content-type', 'application/json')
    if (state.httpStatus !== 200) { res.writeHead(state.httpStatus); return res.end('{}') }
    if (req.url === '/native/api/agentPresets/list') {
      if (state.presetStatus) { res.writeHead(state.presetStatus); return res.end('{}') }
      return res.end(JSON.stringify({ result: { ok: true, value: { presets: state.presets } } }))
    }
    if (req.url === '/native/agent/') return res.end(JSON.stringify({ agents: state.agents }))
    if (req.url === '/native/api/info') return res.end(JSON.stringify({ version: state.version, pid: 123 }))
    if (req.url === '/native/api/session') return res.end(JSON.stringify({ data: [] }))
    if (req.url === '/native/api/session/list') return res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }))
    res.writeHead(404); res.end('{}')
  })
  const wss = new WebSocketServer({ noServer: true }), canceled = once(wss, 'discovery-canceled')
  server.on('upgrade', (req, socket, head) => {
    calls.push({ path: req.url, method: req.method, headers: req.headers })
    if (state.wsStatus !== 101) { socket.end(`HTTP/1.1 ${state.wsStatus} Refused\r\nContent-Length: 0\r\n\r\n`); return }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', raw => {
        const frame = JSON.parse(raw.toString()); calls.push({ frame })
        if (frame.type === 'cancel') { state.canceled++; wss.emit('discovery-canceled') }
        if (frame.type !== 'open' || state.quiet) return
        if (state.wsCode) ws.send(JSON.stringify({ type: 'error', streamId: frame.streamId, error: { code: state.wsCode } }))
        else ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items: state.workspaces, archivedSessionIds: [], pinnedSessionIds: [] } } }))
      })
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); server.close() })
  const endpoint = `http://127.0.0.1:${server.address().port}/native`
  return { root, state, calls, endpoint, canceled, discover: (framework, rest = {}, abort = signal()) => discoverExternal(root, { framework, endpoint, ...rest }, abort) }
}

test('后台最少登记补默认值；仅名称草稿补连接不改公共信息', t => {
  const root = dataRoot(t)
  const draft = save(root, { framework: 'agentscope' }, { name: '待连接助手' })
  assert.equal(draft.instance.state, 'draft'); assert.equal(draft.instance.name, '待连接助手')
  assert.equal(draft.agent.system, '未填写'); assert.equal(draft.agent.owner, '平台管理者')
  assert.deepEqual(draft.policy.subjects, ['platform-owner']); assert.ok(draft.policy.actions.includes('session:prompt'))
  const connected = save(root, { id: draft.instance.id, framework: 'agentscope', endpoint: 'http://remote.example:8080', selector: 'native-agent', connectionUserId: 'existing-user' })
  assert.deepEqual(connected.agent, draft.agent); assert.equal(connected.instance.name, draft.instance.name)
  assert.equal(connected.instance.connectionUserId, 'existing-user'); assert.equal(connected.instance.managementMode, 'externally-managed')
  const first = save(root, { framework: 'opencode', endpoint: 'http://another.example:4096' }, { name: '直接连接' })
  assert.equal(first.agent.system, 'another.example'); assert.equal(first.instance.name, '直接连接')
  const linked = save(root, { framework: 'opencode', agentId: first.agent.id })
  assert.equal(linked.agent.id, first.agent.id)
  const unnamed = save(root, { framework: 'opencode', endpoint: 'http://unnamed.example' })
  assert.equal(unnamed.agent.name, 'OpenCode 接入')
  assert.throws(() => save(root, { id: first.instance.id, framework: 'opencode' }, { name: '改名' }), error => error.code === 'conflict')
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'config/business-access.json'))).untouched, { yes: true })
})

test('聚焦编辑保留省略的目标及元数据；显式空只清对应字段，CAS仍生效', t => {
  const root = dataRoot(t)
  const original = save(root, { framework: 'agentscope', endpoint: 'http://remote.example', selector: 'native', credentialRef: 'upstream', connectionUserId: 'original-user', location: '原运行位置', declaredVersion: '2.0.8', description: '原说明', instanceOwner: '原实例责任人' }, { name: '原助手' })
  const edited = save(root, { id: original.instance.id }, undefined, { subjects: ['platform-owner', 'another'], actions: ['agent:access'], enabled: true })
  assert.equal(edited.instance.framework, 'agentscope')
  for (const key of ['endpoint', 'selector', 'credentialRef', 'connectionUserId', 'location', 'declaredVersion', 'description', 'instanceOwner']) assert.equal(edited.instance[key], original.instance[key], key)
  const cleared = save(root, { id: original.instance.id, framework: 'agentscope', description: '', declaredVersion: '', location: '', instanceOwner: '' })
  assert.equal(cleared.instance.description, undefined); assert.equal(cleared.instance.declaredVersion, undefined); assert.equal(cleared.instance.location, ''); assert.equal(cleared.instance.instanceOwner, '')
  assert.equal(cleared.instance.selector, 'native')
  assert.throws(() => registry.mutateExternal(root, 'disable', { id: original.instance.id, revision: original.revision, requestId: 'stale' }), error => error.code === 'conflict')
})

test('旧绑定摘要兼容；AS明确连接上下文参与绑定并与凭据头一致', t => {
  const root = dataRoot(t), credentialPath = join(root, '.local/credentials/external/upstream.json')
  const material = { Authorization: 'Bearer fixture-only-value' }; writeFileSync(credentialPath, JSON.stringify({ headers: material }))
  const instance = { framework: 'agentscope', endpoint: 'http://native.example', selector: 'agent', credentialRef: 'upstream' }
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  assert.equal(registry.externalBindingDigest(root, instance), hash({ framework: instance.framework, endpoint: instance.endpoint, selector: instance.selector, credentialRef: instance.credentialRef, credentialDigest: hash(material) }))
  assert.equal(registry.externalConnectionUserId(root, { ...instance, id: 'old-instance' }), 'harness-old-instance')
  assert.notEqual(registry.externalBindingDigest(root, { ...instance, connectionUserId: 'explicit-user' }), registry.externalBindingDigest(root, instance))
  writeFileSync(credentialPath, JSON.stringify({ headers: { ...material, 'X-User-ID': 'original-user' } }))
  assert.equal(registry.externalConnectionUserId(root, instance), 'original-user')
  assert.equal(registry.externalConnectionUserId(root, { ...instance, connectionUserId: 'original-user' }), 'original-user')
  assert.throws(() => registry.externalConnectionUserId(root, { ...instance, connectionUserId: 'different-user' }), error => error.code === 'connection_identity_conflict')
  assert.deepEqual(registry.externalCredentialRefs(root), ['upstream'])
  writeFileSync(credentialPath, JSON.stringify({ headers: { 'X-User-ID': 'one', 'x-user-id': 'two' } }))
  assert.throws(() => registry.upstreamHeaders(root, instance), error => error.code === 'invalid_credential')
})

test('已有AS连接发现沿用旧上下文，不物化派生用户或改变会话绑定', async t => {
  const f = await upstream(t)
  const before = save(f.root, { framework: 'agentscope', endpoint: f.endpoint, selector: 'native-record-id' }, { name: '旧连接' })
  const discovered = await f.discover('agentscope', { id: before.instance.id })
  assert.equal(discovered.status, 'selected')
  assert.equal(discovered.connectionUserId, undefined)
  assert.equal(f.calls.find(row => row.path === '/native/agent/').headers['x-user-id'], 'harness-' + before.instance.id)
  const after = save(f.root, { id: before.instance.id, endpoint: f.endpoint, selector: discovered.selector, connectionUserId: '' })
  assert.equal(after.instance.bindingDigest, before.instance.bindingDigest)
  await assert.rejects(f.discover('agentscope', { id: before.instance.id, endpoint: 'http://different.example' }), error => error.code === 'connection_identity_required')
})

test('DSH同一凭据与Origin发现原生Workspace/Preset，唯一自动选择且取消只读流', { timeout: 2000 }, async t => {
  const f = await upstream(t)
  writeFileSync(join(f.root, '.local/credentials/external/remote.json'), JSON.stringify({ headers: { Cookie: 'fixture-cookie=discovery-only-value' } }))
  const result = await f.discover('dsh', { credentialRef: 'remote' })
  assert.equal(result.status, 'selected'); assert.deepEqual(JSON.parse(result.selector), { workspaceId: 'workspace-one', agentPreset: 'preset-one' })
  assert.equal(result.workspaces.items[0].name, '分析工作区'); assert.equal(result.presets.items[0].description, '处理分析任务')
  const requests = f.calls.filter(row => row.path)
  assert.deepEqual(new Set(requests.map(row => row.path)), new Set(['/native/api/agentPresets/list', '/native/api/remote.mux']))
  for (const request of requests) { assert.equal(request.headers.cookie, 'fixture-cookie=discovery-only-value'); assert.equal(request.headers.origin, new URL(f.endpoint).origin) }
  assert.deepEqual(requests.find(row => row.method === 'POST').body.payload, { args: {} })
  await f.canceled; assert.equal(f.state.canceled, 1)
  assert.equal(registry.externalInstances(f.root).instances.length, 0)
})

test('DSH核已发现的实际目标；受限入口保留管理员目标并明确只读验证边界', async t => {
  const f = await upstream(t)
  let row = save(f.root, { framework: 'dsh', endpoint: f.endpoint, selector: JSON.stringify({ workspaceId: 'workspace-one', agentPreset: 'preset-one' }) }, { name: '原生目标' })
  assert.equal((await probeExternal(f.root, row.instance, signal())).ok, true)
  row = save(f.root, { id: row.instance.id, framework: 'dsh', selector: JSON.stringify({ workspaceId: 'missing', agentPreset: 'preset-one' }) })
  assert.equal((await probeExternal(f.root, row.instance, signal())).ok, false)
  f.state.wsCode = 'remote-access/denied'
  row = save(f.root, { id: row.instance.id, framework: 'dsh', selector: JSON.stringify({ workspaceId: 'workspace-one', agentPreset: 'preset-one' }) })
  const limited = await probeExternal(f.root, row.instance, signal())
  assert.equal(limited.ok, true)
  assert.match(limited.checks.map(row => row.detail).join(' '), /受限入口|无法列举/)
  f.state.wsCode = undefined; f.state.presetStatus = 403
  assert.equal((await probeExternal(f.root, row.instance, signal())).ok, true)
  f.state.presetStatus = 503
  assert.equal((await probeExternal(f.root, row.instance, signal())).ok, false)
  assert.equal(f.calls.some(row => row.path?.includes('session/create')), false)
})

test('DSH多目标按名称返回，默认标记不替用户选；加载失败Preset保留原因', async t => {
  const f = await upstream(t)
  f.state.presets.push({ id: 'preset-extra', name: '其他助手' })
  const oneWorkspace = await f.discover('dsh')
  assert.equal(oneWorkspace.status, 'selection_required')
  assert.deepEqual(JSON.parse(oneWorkspace.selector), { workspaceId: 'workspace-one' })
  f.state.presets.pop()
  f.state.workspaces.push({ workspaceId: 'workspace-two', title: '第二工作区', path: '/second' })
  f.state.presets.push({ id: 'preset-two', name: '第二助手', isDefault: false }, { id: 'broken', name: '不可用助手', broken: 'missing plugin' })
  const result = await f.discover('dsh')
  assert.equal(result.status, 'selection_required'); assert.equal(result.selector, undefined)
  assert.equal(result.workspaces.items[1].name, '第二工作区'); assert.equal(result.presets.items[0].isDefault, true); assert.equal(result.presets.items[2].unavailableReason, 'missing plugin')
})

test('发现明确区分无权限、未认证、不支持、空列表与响应失败', async t => {
  const f = await upstream(t)
  f.state.wsCode = 'remote-access/denied'; f.state.httpStatus = 403
  let result = await f.discover('dsh'); assert.equal(result.workspaces.status, 'forbidden'); assert.equal(result.presets.status, 'forbidden'); assert.equal(result.status, 'unavailable')
  f.state.wsCode = undefined; f.state.wsStatus = 401; f.state.httpStatus = 401
  result = await f.discover('dsh'); assert.equal(result.workspaces.status, 'unauthorized'); assert.equal(result.presets.status, 'unauthorized')
  f.state.wsStatus = 404; f.state.httpStatus = 404
  result = await f.discover('dsh'); assert.equal(result.workspaces.status, 'unsupported'); assert.equal(result.presets.status, 'unsupported')
  f.state.wsStatus = 101; f.state.httpStatus = 200; f.state.workspaces = []; f.state.presets = []
  result = await f.discover('dsh'); assert.equal(result.workspaces.status, 'empty'); assert.equal(result.presets.status, 'empty')
  f.state.workspaces = [{ title: '无实际ID' }]; f.state.presets = [{}]
  result = await f.discover('dsh'); assert.equal(result.workspaces.status, 'failed'); assert.equal(result.presets.status, 'failed')
})

test('AS从凭据读取真实用户上下文，选择顶层记录ID，不投影内部配置/邀请说明', async t => {
  const f = await upstream(t)
  const credentials = { Authorization: 'Bearer discovery-secret-fixture', 'X-User-ID': 'real-existing-user' }
  writeFileSync(join(f.root, '.local/credentials/external/remote.json'), JSON.stringify({ headers: credentials }))
  const result = await f.discover('agentscope', { credentialRef: 'remote' })
  assert.equal(result.status, 'selected'); assert.equal(result.selector, 'native-record-id'); assert.equal(result.connectionUserId, 'real-existing-user')
  assert.deepEqual(result.agents.items, [{ id: 'native-record-id', name: '原生业务助手' }])
  assert.equal(f.calls[0].headers['x-user-id'], 'real-existing-user'); assert.equal(f.calls[0].headers.authorization, credentials.Authorization)
  assert.equal(JSON.stringify(result).includes('discovery-secret-fixture'), false)
  const before = f.calls.length
  await assert.rejects(f.discover('agentscope', { credentialRef: 'remote', connectionUserId: 'other-user' }), error => error.code === 'connection_identity_conflict')
  await assert.rejects(f.discover('agentscope'), error => error.code === 'connection_identity_required')
  assert.equal(f.calls.length, before)
})

test('AS多Agent与空列表来自同一原生身份；不从嵌套data.id猜记录ID', async t => {
  const f = await upstream(t), connection = { connectionUserId: 'real-user' }
  f.state.agents.push({ id: 'second', data: { name: '第二助手' } })
  let result = await f.discover('agentscope', connection); assert.equal(result.status, 'selection_required'); assert.equal(result.selector, undefined); assert.equal(result.agents.items[1].name, '第二助手')
  f.state.agents = []; result = await f.discover('agentscope', connection); assert.equal(result.agents.status, 'empty')
  f.state.agents = [{ data: { id: 'not-a-record-id', name: '内部配置' } }]; result = await f.discover('agentscope', connection); assert.equal(result.agents.status, 'failed')
})

test('OpenCode实际识别v2及Session入口，地址认证或协议错误不表示已连接', async t => {
  const f = await upstream(t)
  let result = await f.discover('opencode'); assert.equal(result.status, 'selected'); assert.deepEqual(f.calls.map(row => row.path), ['/native/api/info', '/native/api/session'])
  f.state.httpStatus = 401; result = await f.discover('opencode'); assert.equal(result.status, 'unavailable'); assert.match(result.message, /连接身份/)
  f.state.httpStatus = 200; f.state.version = '1.0.0'; result = await f.discover('opencode'); assert.equal(result.status, 'unavailable'); assert.match(result.message, /v2/)
})

test('取消未完成的原生发现会关闭WS，不创建或重放业务对象', async t => {
  const f = await upstream(t); f.state.quiet = true
  await assert.rejects(f.discover('dsh', {}, AbortSignal.timeout(30)), error => error.name === 'TimeoutError')
  assert.ok(f.calls.filter(row => row.path).every(row => row.path.endsWith('remote.mux') || row.path.endsWith('agentPresets/list')))
})
