import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function fixture(t, mappings = '') {
  const directory = mkdtempSync(join(tmpdir(), 'agent-install-port-')), source = join(directory, 'source'), prefix = join(directory, 'installed'), bin = join(directory, 'bin'), log = join(directory, 'docker.log')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(source, 'runtime'), { recursive: true }); mkdirSync(bin)
  copyFileSync(new URL('../agent/runtime/install.sh', import.meta.url), join(source, 'install.sh'))
  writeFileSync(join(source, 'runtime/bundle.env'), `AGENT_ID=port-fixture\nAGENT_ARCH=${process.arch === 'arm64' ? 'arm64' : 'amd64'}\nIMAGE_TAG=fixture\nIMAGE_ID=sha256:fixture\nIMAGE_FINGERPRINT=fixture\n`)
  writeFileSync(join(source, 'agent'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$PORT_TEST_AGENT_LOG"\n')
  const files = ['install.sh', 'runtime/bundle.env', 'agent']
  writeFileSync(join(source, 'SHA256SUMS'), files.map(path => `${createHash('sha256').update(readFileSync(join(source, path))).digest('hex')}  ${path}`).join('\n') + '\n')
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$PORT_TEST_DOCKER_LOG"
case "$1" in
  compose|info|load) exit 0 ;;
  ps) if [ -n "$PORT_TEST_MAPPINGS" ]; then echo fixture-id; fi ;;
  inspect) if [ "$PORT_TEST_INSPECT_FAIL" = 1 ]; then exit 1; fi; printf '%s\\n' "$PORT_TEST_MAPPINGS" ;;
  image) case "$5" in '{{.Architecture}}') echo "$PORT_TEST_ARCH" ;; '{{.Id}}') echo sha256:fixture ;; *) echo fixture ;; esac ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 })
  const execute = (args = [], extra = {}) => spawnSync('/bin/bash', [join(source, 'install.sh'), '--prefix', prefix, '--host', '127.0.0.1', ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, PORT_TEST_DOCKER_LOG: log, PORT_TEST_AGENT_LOG: join(directory, 'agent.log'), PORT_TEST_MAPPINGS: mappings, PORT_TEST_ARCH: process.arch === 'arm64' ? 'arm64' : 'amd64', ...extra },
  })
  return { directory, source, prefix, log, execute }
}
async function listen(t, host, port = 0, ipv6Only = false) {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host, port, ipv6Only }, resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  return server.address().port
}
function tcpPorts() {
  const ports = new Set()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] === '0A') ports.add(parseInt(fields[1].split(':')[1], 16))
  }
  return ports
}

test('显式端口识别仅绑定 LAN 地址的监听，失败前不创建安装目录', async t => {
  const lan = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address
  if (!lan) return t.skip('当前主机没有 LAN IPv4 地址')
  const port = await listen(t, lan), f = fixture(t), result = f.execute(['--port', String(port)])
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /端口已被占用/)
  assert.equal(existsSync(f.prefix), false)
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /^load|stop|restart/m)
})

test('显式端口识别 IPv6-only LISTEN，不依赖 IPv4 回环连接', async t => {
  let port
  try { port = await listen(t, '::1', 0, true) } catch (error) { if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) return t.skip('当前主机未启用 IPv6'); throw error }
  const f = fixture(t), result = f.execute(['--port', String(port)])
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /端口已被占用/)
  assert.equal(existsSync(f.prefix), false)
})

test('Docker TCP 映射即使没有宿主监听也占用端口，UDP 映射不影响 TCP', t => {
  const occupied = tcpPorts(), unbound = [...Array(10500)].map((_, index) => 18500 + index).find(value => !occupied.has(value))
  const nat = fixture(t, `3080/tcp ${unbound}\n53/udp ${unbound + 1}\n`), result = nat.execute(['--port', String(unbound)])
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /端口已被占用/)
  assert.equal(existsSync(nat.prefix), false); assert.match(readFileSync(nat.log, 'utf8'), /inspect --format/)
  const udpPort = unbound
  const udp = fixture(t, `53/udp ${udpPort}\n`), allowed = udp.execute(['--port', String(udpPort)])
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.match(readFileSync(join(udp.prefix, 'state/deployment.env'), 'utf8'), new RegExp(`AGENT_PORT=${udpPort}\n`))
})

test('自动分配跳过全部监听及 Docker 映射，保留服务并选择下一个空闲端口', async t => {
  const occupied = tcpPorts(), first = [...Array(10500)].map((_, index) => 18500 + index).find(port => !occupied.has(port))
  const bound = await listen(t, '0.0.0.0', first), dockerPort = bound + 1
  const all = tcpPorts(); all.add(dockerPort)
  const expected = [...Array(10500)].map((_, index) => 18500 + index).find(port => !all.has(port))
  const f = fixture(t, `3080/tcp ${dockerPort}\n`), result = f.execute()
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(join(f.prefix, 'state/deployment.env'), 'utf8'), new RegExp(`AGENT_PORT=${expected}\n`))
  assert.equal(tcpPorts().has(bound), true)
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /stop|restart|kill|remove|rm /)
})

test('无效显式端口和 Docker 端口核对失败均在复制前退出', t => {
  const invalid = fixture(t), result = invalid.execute(['--port', '65536'])
  assert.equal(result.status, 2); assert.match(result.stderr, /端口无效/); assert.equal(existsSync(invalid.prefix), false)
  const unavailable = fixture(t, '3080/tcp 18500\n'), failure = unavailable.execute([], { PORT_TEST_INSPECT_FAIL: '1' })
  assert.equal(failure.status, 2); assert.match(failure.stderr, /Docker 已有端口映射/); assert.equal(existsSync(unavailable.prefix), false)
})
