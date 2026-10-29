import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyDeployment } from '../verify.mts'

test('无关 HTTP 200 不通过在线工作区核验，也不向它发送登录凭据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-verify-'))
  let requests = 0
  const server = createServer((req, res) => { requests++; res.end('ok') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const report = await verifyDeployment({ prefix: join(root, 'program'), dataRoot: join(root, 'data'), url: `http://127.0.0.1:${server.address().port}/hep/` })
    assert.equal(report.onlineVerified, false)
    assert.equal(report.ok, false)
    assert.equal(report.checks.find(check => check.id === 'online-workspace').status, 'mismatch')
    assert.equal(requests, 0)
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }) }
})

test('离线核验检查网关配置与本地密钥，关闭或配置不全不得通过', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hep-verify-gateway-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { initializeBusinessGateway } = await import('../../plugin/src/business-control/configuration.ts')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const file = join(root, 'config/business-access.json')
  const check = async () => (await verifyDeployment({ prefix: join(root, 'program'), dataRoot: root })).checks.find(item => item.id === 'business-gateway')
  assert.equal((await check()).status, 'mismatch')
  initializeBusinessGateway(root, 'http://127.0.0.1:18120/hep/')
  assert.equal((await check()).status, 'ok')
  const access = JSON.parse(readFileSync(file))
  writeFileSync(file, JSON.stringify({ ...access, enabled: false }))
  assert.match((await check()).detail, /未启用/)
  writeFileSync(file, JSON.stringify({ ...access, gateway: { instances: [] } }))
  assert.match((await check()).detail, /配置不完整/)
  writeFileSync(file, JSON.stringify(access))
  writeFileSync(join(root, access.gateway.sharedSecretFile), 'short')
  assert.equal((await check()).status, 'ok', '没有发布实例时核验不依赖签名密钥')
  access.gateway.instances = [{ agentId: 'soc', instanceId: 'dev', identityMode: 'development' },
    { agentId: 'soc', instanceId: 'published', identityMode: 'published' }]
  writeFileSync(file, JSON.stringify(access))
  assert.match((await check()).detail, /密钥无效/)
})
