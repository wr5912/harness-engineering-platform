import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyDeployment, verifyInstalledDeployment } from '../verify.mts'

test('安装后的在线核验使用目标入口装载随包环境，忽略安装器的宿主 Python', async t => {
  const prefix = mkdtempSync(join(tmpdir(), 'hep-installed-verify-'))
  t.after(() => rmSync(prefix, { recursive: true, force: true }))
  mkdirSync(join(prefix, 'platform'))
  const launcher = join(prefix, 'platform/dsh-deploy')
  writeFileSync(launcher, `#!/bin/sh
export HARNESS_PYTHON=target-bundled-python
exec '${process.execPath}' -e 'if(process.env.HARNESS_PYTHON!=="target-bundled-python")process.exit(9); console.log(JSON.stringify({ok:true,onlineVerified:true,checks:[],args:process.argv.slice(1),dataRoot:process.env.HARNESS_ASSET_ROOT}))' -- "$@"
`, { mode: 0o755 })
  const before = process.env.HARNESS_PYTHON
  process.env.HARNESS_PYTHON = '/missing-host-python'
  try {
    const result = await verifyInstalledDeployment({ prefix, dataRoot: prefix + '-data', url: 'http://127.0.0.1:18121/hep/' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.args, ['verify', '--prefix', prefix, '--data-root', prefix + '-data', '--url', 'http://127.0.0.1:18121/hep/', '--json'])
    assert.equal(result.dataRoot, prefix + '-data')
    assert.equal(process.env.HARNESS_PYTHON, '/missing-host-python')
    writeFileSync(launcher, '#!/bin/sh\necho \'{"ok":false,"onlineVerified":false,"checks":[{"id":"online-business-instances","status":"mismatch","detail":"实例 soc：HTTP 503"}]}\'\nexit 1\n', { mode: 0o755 })
    assert.equal((await verifyInstalledDeployment({ prefix, dataRoot: prefix + '-data' })).checks[0].detail, '实例 soc：HTTP 503')
    writeFileSync(launcher, '#!/bin/sh\necho "ModuleNotFoundError: yaml" >&2\nexit 1\n', { mode: 0o755 })
    await assert.rejects(verifyInstalledDeployment({ prefix, dataRoot: prefix + '-data' }), /dsh-deploy.*ModuleNotFoundError: yaml/)
  } finally {
    if (before === undefined) delete process.env.HARNESS_PYTHON
    else process.env.HARNESS_PYTHON = before
  }
})

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
