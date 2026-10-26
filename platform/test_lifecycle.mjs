import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { launchAddress, managedState, processBirth } from './lifecycle.mts'
import { handoffService } from './bootstrap/server.ts'

test('地址配置只读校验，允许已有多级站点基址', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-address-'))
  try {
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config/sites.json'), '{"platform":"/Tools/hep_1/"}')
    const file = join(root, 'config/business-access.json')
    writeFileSync(file, '{"gateway":{"managementUrl":"http://127.0.0.1:18220/Tools/hep_1/"}}')
    const before = readFileSync(file, 'utf8')
    assert.equal(launchAddress(root).port, 18220)
    assert.equal(launchAddress(root, '127.0.0.1', '18221').url, 'http://127.0.0.1:18221/Tools/hep_1/')
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.throws(() => launchAddress(root, '192.0.2.10'), /不属于本机/)
    assert.throws(() => launchAddress(root, '0.0.0.0'), /具体 IPv4/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('过期 PID 不归属服务；活动记录必须匹配程序和数据根', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-state-'))
  try {
    mkdirSync(join(root, '.local/platform-service'), { recursive: true })
    const file = join(root, '.local/platform-service/state.json')
    const state = { pid: process.pid, birth: 'expired', programRoot: '/other', dataRoot: root }
    writeFileSync(file, JSON.stringify(state))
    assert.equal(managedState(root), undefined)
    state.birth = processBirth(process.pid)
    writeFileSync(file, JSON.stringify(state))
    assert.throws(() => managedState(root), /另一程序目录/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('浏览器选择其他数据根后迁移受管进程记录和安装默认目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-handoff-'))
  const from = join(root, 'old'), to = join(root, 'new'), program = join(root, 'program')
  try {
    mkdirSync(join(from, '.local/platform-service'), { recursive: true })
    mkdirSync(join(program, 'bin'), { recursive: true })
    writeFileSync(join(from, '.local/platform-service/state.json'), JSON.stringify({ pid: process.ppid, birth: processBirth(process.ppid), programRoot: program, dataRoot: from }))
    writeFileSync(join(program, 'bin/hep-env.sh'), `export HARNESS_ASSET_ROOT=\${HARNESS_ASSET_ROOT:-'${from}'}\n`)
    handoffService(from, to, program)
    assert.equal(managedState(to, program).dataRoot, to)
    assert.equal(managedState(from, program), undefined)
    assert.ok(readFileSync(join(program, 'bin/hep-env.sh'), 'utf8').includes(to))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('统一入口后台启停、重复启动、重启、只读预检与端口冲突', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hep-lifecycle-'))
  const repo = join(root, 'program with spaces'), data = join(root, 'data')
  for (const file of ['platform/dsh-platform', 'platform/tool-env.sh', 'platform/lifecycle.mts', 'platform/plugin/src/workspace.ts', 'platform/plugin/src/business-control/group-link.ts']) {
    const target = join(repo, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(new URL('../' + file, import.meta.url), target)
  }
  mkdirSync(join(data, 'config'), { recursive: true })
  writeFileSync(join(data, 'workspace.json'), '{}')
  writeFileSync(join(data, 'config/sites.json'), '{"platform":"/hep/"}')
  writeFileSync(join(repo, 'platform/dsh-platform-internal.py'), `import http.server, json, sys
host = sys.argv[sys.argv.index('--host')+1]
port = int(sys.argv[sys.argv.index('--port')+1])
if '--dry-run' in sys.argv:
    print(json.dumps({'dry': True})); sys.exit(0)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ready')
http.server.HTTPServer((host, port), Handler).serve_forever()
`)
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const file = join(data, 'config/business-access.json')
  writeFileSync(file, JSON.stringify({ gateway: { managementUrl: `http://127.0.0.1:${port}/hep/` } }))
  const env = { ...process.env, HARNESS_ASSET_ROOT: data, HARNESS_PYTHON: '/usr/bin/python3' }
  const cli = (...args) => spawnSync(join(repo, 'platform/dsh-platform'), args, { env, encoding: 'utf8', timeout: 15_000 })
  const state = () => JSON.parse(cli('status', '--json').stdout)
  try {
    assert.equal(cli('start', '--dry-run').status, 0)
    assert.equal(managedState(data, repo), undefined)
    const first = cli('start')
    assert.equal(first.status, 0, first.stderr)
    const pid = state().pid
    assert.equal(state().status, 'running')
    assert.equal(cli('start').status, 0)
    assert.equal(state().pid, pid)
    assert.equal(cli('restart').status, 0)
    assert.notEqual(state().pid, pid)
    assert.equal(cli('stop').status, 0)
    assert.equal(state().status, 'stopped')
    assert.equal(cli('stop').status, 0)
    const foreground = spawn(join(repo, 'platform/dsh-platform'), ['start', '--foreground'], { env, stdio: 'ignore' })
    const foregroundExit = new Promise(resolve => foreground.once('exit', resolve))
    for (let n = 0; n < 50 && state().status !== 'running'; n++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(state().status, 'running')
    assert.equal(cli('stop').status, 0)
    await foregroundExit
    const occupied = spawn('/usr/bin/python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { stdio: 'ignore' })
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      const before = readFileSync(file, 'utf8')
      assert.notEqual(cli('start').status, 0)
      assert.equal(readFileSync(file, 'utf8'), before)
      assert.ok(processBirth(occupied.pid))
    } finally { occupied.kill(); await new Promise(resolve => occupied.once('exit', resolve)) }
  } finally { cli('stop'); rmSync(root, { recursive: true, force: true }) }
})
