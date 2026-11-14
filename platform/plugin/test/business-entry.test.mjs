import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { startBusinessGateway } from '../lib/business-gateway.js'
import { checkBusinessGatewayEntry } from '../src/business-control/entry.ts'
import { BUSINESS_TRANSPORT_HEADER, BUSINESS_TRANSPORT_VERSION } from '../src/business-control/contracts.ts'
import { checkRunningBusinessEntries } from '../../business-readiness.mts'
import { platformGroupUrl } from '../src/business-control/group-link.ts'
import { businessAccess } from '../src/business-control/registration.ts'
import { bindPlatformEntry } from '../src/business-control/runtime-address.ts'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'business-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const loaded = { version: undefined, status: 403, type: 'text/plain', requests: [] }
  const sourceDigest = 'sha256:' + 'a'.repeat(64)
  const runtime = createServer((req, res) => {
    loaded.requests.push(req.headers)
    if (loaded.hang) return
    if (loaded.version) res.setHeader(BUSINESS_TRANSPORT_HEADER, loaded.version)
    res.writeHead(loaded.status, { 'content-type': loaded.type, ...(loaded.status === 302 ? { location: '/unexpected' } : {}) })
    res.end(loaded.type === 'text/html' ? `<html><head>${loaded.metaVersion ? `<meta name="${BUSINESS_TRANSPORT_HEADER}" content="${loaded.metaVersion}">` : ''}</head>业务对话</html>` : '业务访问被拒绝')
  })
  await new Promise(resolve => runtime.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => runtime.close(resolve)))
  const reserve = createServer()
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve))
  const port = reserve.address().port
  await new Promise(resolve => reserve.close(resolve))
  const config = { schemaVersion: 1, enabled: true, agents: [], authentication: { endpoint: 'http://127.0.0.1:1/auth' }, identityTrust: { endpoint: 'http://127.0.0.1:1/trust' }, gateway: {
    host: '127.0.0.1', port, publicOrigin: `http://127.0.0.1:${port}`, instances: [
      { agentId: 'soc', instanceId: 'soc-business', sourceId: 'business:soc', sourceDigest, identityMode: 'development', accessMode: 'anonymous' },
    ],
  } }
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, '.local/instances/soc-business'), { recursive: true })
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-fixture' }))
  writeFileSync(join(root, '.local/instances/soc-business/instance.json'), JSON.stringify({
    workspace_id: 'workspace-fixture', asset_root: root, agent_id: 'soc', source_id: 'business:soc', web_base_path: '/agents/soc/instances/soc-business/',
    business_control: { runtime_generation: 'generation-fixture', source_digest: sourceDigest, origin: `http://127.0.0.1:${runtime.address().port}` },
  }))
  const save = () => writeFileSync(join(root, 'config/business-access.json'), JSON.stringify(config))
  save()
  const gateway = await startBusinessGateway(root, structuredClone(config.gateway))
  t.after(() => gateway.close())
  const check = () => checkBusinessGatewayEntry(root, 'soc', 'soc-business')
  return { root, loaded, config, save, check, runtime }
}

test('运行中同步含旧 IP 的数据仓后，真实业务网关与实例入口仍可用', async t => {
  const { root, loaded, config, save, check } = await fixture(t)
  bindPlatformEntry(root, 'http://127.0.0.1:18121/hep/')
  loaded.version = BUSINESS_TRANSPORT_VERSION
  loaded.status = 200
  loaded.type = 'text/html'
  config.gateway.publicOrigin = `http://10.0.160.32:${config.gateway.port}`
  config.gateway.managementUrl = 'http://10.0.160.32:18120/hep/'
  save()
  const result = await check()
  assert.equal(result.ready, true, result.detail)
  assert.equal(result.url, `http://127.0.0.1:${config.gateway.port}/agents/soc/instances/soc-business/`)
  assert.equal(platformGroupUrl(root, 'soc'), 'http://127.0.0.1:18121/hep/mcp/groups/soc/v2')
  assert.equal((await businessAccess(root)).gateway.publicOrigin, `http://127.0.0.1:${config.gateway.port}`)
})

test('新网关与未重载 Runtime 不得通过入口核验；重载后恢复且无需外部 MCP', async t => {
  const { root, loaded, check } = await fixture(t)
  const before = await check()
  assert.equal(before.ready, false)
  assert.equal(before.httpStatus, 403)
  assert.match(before.detail, /Runtime 接入版本未报告.*重载/)
  assert.ok(loaded.requests[0]['x-harness-business-context'], '真实网关发送开发上下文')
  assert.equal(loaded.requests[0]['x-harness-business-signature'], undefined)
  Object.assign(loaded, { version: BUSINESS_TRANSPORT_VERSION, status: 200, type: 'text/html' })
  assert.equal((await check()).ready, true)

  const cli = join(root, 'runtime/adapters/dsh-container/dsh-dev')
  mkdirSync(dirname(cli), { recursive: true })
  const previousPython = process.env.HARNESS_PYTHON
  process.env.HARNESS_PYTHON = process.execPath
  t.after(() => { if (previousPython === undefined) delete process.env.HARNESS_PYTHON; else process.env.HARNESS_PYTHON = previousPython })
  const observation = [
    { name: 'soc-business', agent_id: 'soc', state: 'running', business_gateway: true },
    { name: 'stopped', state: 'stopped', business_gateway: true },
  ]
  const observe = () => writeFileSync(cli, `#!/bin/false\nconsole.log(${JSON.stringify(JSON.stringify({ instances: observation }))})\n`, { mode: 0o755 })
  observe()
  assert.equal((await checkRunningBusinessEntries(root, root)).length, 1)
  assert.equal((await checkRunningBusinessEntries(root, root))[0].ready, true)
  loaded.version = undefined; loaded.status = 403
  assert.equal((await checkRunningBusinessEntries(root, root))[0].ready, false, '网关已监听不能掩盖旧 Runtime')
  observation.push({ name: 'unknown', state: 'unknown' }); observe()
  assert.equal((await checkRunningBusinessEntries(root, root))[1].ready, false, '状态未知不能当作没有运行实例')
})

test('原生 Fetch 首页通过文件装载的版本标记完成入口核对', async t => {
  const { loaded, check } = await fixture(t)
  Object.assign(loaded, { status: 200, type: 'text/html', metaVersion: BUSINESS_TRANSPORT_VERSION })
  assert.equal((await check()).ready, true)
  loaded.metaVersion = '1'
  assert.equal((await check()).ready, false)
  loaded.metaVersion = undefined
  assert.equal((await check()).ready, false)
})

test('HTTP 拒绝、重定向及非网页响应各自报告，不把当前版本的拒绝误判为版本问题', async t => {
  const { loaded, check } = await fixture(t)
  loaded.version = BUSINESS_TRANSPORT_VERSION
  for (const status of [401, 403, 500, 302]) {
    loaded.status = status
    const before = loaded.requests.length, result = await check()
    assert.equal(result.ready, false)
    assert.match(result.detail, new RegExp(`HTTP ${status}`))
    assert.doesNotMatch(result.detail, /重载/)
    assert.equal(loaded.requests.length, before + 1, '不跟随重定向')
  }
  loaded.status = 200
  assert.match((await check()).detail, /未返回 HTML/)
  loaded.type = 'text/html'; loaded.version = '1'
  const outdated = await check()
  assert.equal(outdated.ready, false)
  assert.match(outdated.detail, new RegExp(`版本为 1.*需要 ${BUSINESS_TRANSPORT_VERSION}`))
})

test('开启认证时既检查网关登录拒绝，也确认真实 Runtime 装载版本', async t => {
  const { config, save, loaded, check } = await fixture(t)
  config.gateway.instances[0].accessMode = 'authenticated'; save()
  assert.equal((await check()).ready, false, '网关 401 不代表 Runtime 已更新')
  loaded.version = BUSINESS_TRANSPORT_VERSION
  const result = await check()
  assert.equal(result.ready, true)
  assert.equal(result.httpStatus, 401)
  assert.equal(loaded.requests.at(-1).authorization, undefined, '检查不携带用户凭据')
})

test('入口检查超时显示实际失败阶段和地址，恢复后可直接重试', async t => {
  const { config, save, loaded, check, runtime } = await fixture(t)
  config.gateway.instances[0].accessMode = 'authenticated'; save()
  loaded.hang = true
  const result = await check()
  assert.equal(result.ready, false)
  assert.match(result.detail, /业务 Runtime检查超时（5 秒）/)
  assert.ok(result.detail.includes(`http://127.0.0.1:${runtime.address().port}/agents/soc/instances/soc-business/`))
  loaded.hang = false
  loaded.version = BUSINESS_TRANSPORT_VERSION
  assert.equal((await check()).ready, true)
})

test('网关拒绝发生在转发前时，不误报当前 Runtime 需要重载', async t => {
  const { config, save, loaded, check } = await fixture(t)
  config.gateway.instances[0].identityMode = 'published'; save()
  loaded.version = BUSINESS_TRANSPORT_VERSION
  const result = await check()
  assert.equal(result.ready, false)
  assert.equal(result.httpStatus, 403)
  assert.equal(result.runtimeVersion, BUSINESS_TRANSPORT_VERSION)
  assert.doesNotMatch(result.detail, /重载/)
  assert.equal(loaded.requests.length, 1, '只需直查 Runtime，无转发请求')
})
