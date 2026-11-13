import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { launchAddress, managedState, platformNodeOptions, processBirth, processHeapMb, renderAutostartUnit } from './lifecycle.mts'
import { handoffService } from './bootstrap/server.ts'
import { platformGroupUrl } from './plugin/src/business-control/group-link.ts'

test('平台 Node 堆上限默认 8 GiB，支持自定义并保留其他选项，重复启动不累加', () => {
  for (const [original, heapMb] of [['', undefined], ['--stack-trace-limit=42 --max-old-space-size=1024', undefined], ['--stack-trace-limit=42', 6144]]) {
    const options = platformNodeOptions(original, heapMb)
    assert.equal(platformNodeOptions(options, heapMb), options)
    const child = spawnSync(process.execPath, ['-p', 'JSON.stringify({ heap: require("node:v8").getHeapStatistics().heap_size_limit, stack: Error.stackTraceLimit })'], {
      env: { ...process.env, NODE_OPTIONS: options }, encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    const actual = JSON.parse(child.stdout)
    const reference = spawnSync(process.execPath, [`--max-old-space-size=${heapMb ?? 8192}`, '-p', 'require("node:v8").getHeapStatistics().heap_size_limit'], { env: { ...process.env, NODE_OPTIONS: options }, encoding: 'utf8' })
    assert.equal(reference.status, 0, reference.stderr)
    assert.equal(actual.heap, Number(reference.stdout))
    if (original) assert.equal(actual.stack, 42)
  }
})

test('-h、--help 和子命令帮助说明默认堆上限与启动参数，不启动平台', () => {
  for (const args of [['-h'], ['--help'], ['start', '-h'], ['restart', '--help'], ['autostart', 'enable', '-h']]) {
    const result = spawnSync(join(import.meta.dirname, 'dsh-platform'), args, { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /--max-old-space-size MiB/)
    assert.match(result.stdout, /8192 MiB（8 GiB）/)
    assert.match(result.stdout, /restart --max-old-space-size 8192/)
  }
})

test('读取运行进程堆参数，以命令行覆盖 NODE_OPTIONS，退出后保持未知', async () => {
  const child = spawn(process.execPath, ['--max-old-space-size=4096', '-e', 'setInterval(() => {}, 1000)'], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' }, stdio: 'ignore',
  })
  try {
    await new Promise(resolve => child.once('spawn', resolve))
    assert.equal(processHeapMb(child.pid), 4096)
  } finally { child.kill(); await new Promise(resolve => child.once('exit', resolve)) }
  assert.equal(processHeapMb(child.pid), undefined)
})

test('自启动单元固定程序根、数据根和用户服务入口', () => {
  const unit = renderAutostartUnit('/opt/hep root', '/srv/hep data', '/opt/node/bin:/usr/bin')
  assert.match(unit, /WorkingDirectory=\/opt\/hep\\x20root/)
  assert.match(unit, /HARNESS_ASSET_ROOT=\/srv\/hep data/)
  assert.match(unit, /ExecStart="\/opt\/hep root\/platform\/dsh-platform" start --foreground/)
  assert.match(unit, /WantedBy=default\.target/)
  assert.match(unit, /TimeoutStartSec=10min/)
})

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
    const nat = launchAddress(root, '127.0.0.1', '18221', 'https://platform.example/Tools/hep_1/')
    assert.equal(nat.url, 'http://127.0.0.1:18221/Tools/hep_1/')
    assert.equal(nat.publicUrl, 'https://platform.example/Tools/hep_1/')
    for (const url of ['ftp://platform.example/Tools/hep_1/', 'https://user:pass@platform.example/Tools/hep_1/',
      'https://platform.example/Tools/hep_1/?key=example', 'https://platform.example/Tools/hep_1/#section',
      'https://platform.example/wrong/', 'http://0.0.0.0/Tools/hep_1/']) {
      assert.throws(() => launchAddress(root, '127.0.0.1', '18221', url))
    }
    assert.equal(readFileSync(file, 'utf8'), before)
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
  for (const file of ['platform/dsh-platform', 'platform/tool-env.sh', 'platform/lifecycle.mts', 'platform/business-readiness.mts', 'platform/manager-home.mts', 'platform/plugin/src/manager-home.ts', 'platform/plugin/src/workspace.ts', 'platform/plugin/src/version-id.ts', ...['configuration.ts', 'entry.ts', 'contracts.ts', 'instance.ts', 'group-link.ts', 'secret-file.ts'].map(file => `platform/plugin/src/business-control/${file}`)]) {
    const target = join(repo, file)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(new URL('../' + file, import.meta.url), target)
  }
  mkdirSync(join(data, 'config'), { recursive: true })
  writeFileSync(join(data, 'workspace.json'), '{}')
  writeFileSync(join(data, 'config/sites.json'), '{"platform":"/hep/"}')
  const health = join(data, 'fixture-health.txt')
  writeFileSync(join(repo, 'platform/dsh-platform-internal.py'), `import http.server, json, os, pathlib, sys, time
host = sys.argv[sys.argv.index('--host')+1]
port = int(sys.argv[sys.argv.index('--port')+1])
if '--dry-run' in sys.argv:
    if pathlib.Path(${JSON.stringify(join(data, 'fixture-invalid.txt'))}).exists():
        print('扩展尚未按当前来源构建', file=sys.stderr); sys.exit(1)
    print(json.dumps({'dry': True})); sys.exit(0)
if os.environ.get('HEP_FIXTURE_FAIL_START'):
    print('fixture startup failure Authorization: Bearer fixture-secret https://example.invalid/?token=fixture-query', file=sys.stderr); sys.exit(7)
pathlib.Path(${JSON.stringify(join(data, 'fixture-node-options.txt'))}).write_text(os.environ.get('NODE_OPTIONS', ''))
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = pathlib.Path(${JSON.stringify(health)})
        mode = path.read_text() if path.exists() else 'running'
        if mode == 'stall': time.sleep(2)
        self.send_response(503 if mode == 'failed' else 200)
        if mode == 'initializing': self.send_header('x-harness-bootstrap', '1')
        self.end_headers()
        try: self.wfile.write(b'ready')
        except BrokenPipeError: pass
http.server.ThreadingHTTPServer((host, port), Handler).serve_forever()
`)
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  const file = join(data, 'config/business-access.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], gateway: { managementUrl: `http://127.0.0.1:${port}/hep/` } }))
  const env = { ...process.env, HARNESS_ASSET_ROOT: data, HARNESS_PYTHON: process.env.HARNESS_PYTHON ?? 'python3' }
  const cli = (...args) => spawnSync(join(repo, 'platform/dsh-platform'), args, { env, encoding: 'utf8', timeout: 15_000 })
  const cliWithEnv = (overrides, ...args) => spawnSync(join(repo, 'platform/dsh-platform'), args, { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15_000 })
  const state = () => JSON.parse(cli('status', '--json').stdout)
  try {
    const dry = cli('start', '--dry-run')
    assert.equal(dry.status, 0, dry.stderr || dry.stdout)
    assert.equal(JSON.parse(dry.stdout).node_heap_mb, 8192)
    assert.equal(managedState(data, repo), undefined)
    const first = cli('start')
    assert.equal(first.status, 0, first.stderr || first.stdout)
    assert.match(first.stdout, /启动预检通过/)
    assert.match(first.stdout, /平台启动中/)
    const pid = state().pid
    assert.equal(state().nodeHeapMb, 8192)
    assert.match(readFileSync(join(data, 'fixture-node-options.txt'), 'utf8'), /--max-old-space-size=8192$/)
    assert.equal(state().status, 'running')
    assert.equal(cli('start').status, 0)
    assert.equal(state().pid, pid)
    for (const mode of ['failed', 'stall']) {
      writeFileSync(health, mode)
      const before = readFileSync(file, 'utf8')
      assert.equal(state().status, 'unavailable')
      const unavailable = cli('start')
      assert.notEqual(unavailable.status, 0)
      assert.match(unavailable.stderr, /HTTP 未就绪/)
      assert.equal(managedState(data, repo).pid, pid, '探测失败不能擅自终止原进程')
      assert.equal(readFileSync(file, 'utf8'), before)
    }
    writeFileSync(health, 'initializing')
    assert.equal(state().status, 'initializing')
    assert.match(cli('start').stdout, /等待初始化/)
    writeFileSync(health, 'running')
    const invalid = join(data, 'fixture-invalid.txt')
    writeFileSync(invalid, 'stale')
    const blocked = cli('restart')
    assert.notEqual(blocked.status, 0)
    assert.match(blocked.stderr, /扩展尚未按当前来源构建/)
    assert.equal(state().pid, pid, '启动检查失败必须保留正在运行的平台')
    assert.equal(state().status, 'running')
    rmSync(invalid)
    for (const value of ['0', '-1', '1.5', 'no', 'Infinity', '9007199254740992']) {
      const rejected = cli('restart', '--max-old-space-size', value)
      assert.notEqual(rejected.status, 0)
      assert.match(rejected.stderr, /正整数/)
      assert.equal(state().pid, pid, '无效堆上限不能停止原平台')
    }
    const mismatch = cli('start', '--max-old-space-size', '6144')
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /需要重启生效/)
    assert.equal(state().pid, pid)
    const custom = cli('restart', '--max-old-space-size', '6144')
    assert.equal(custom.status, 0, custom.stderr || custom.stdout)
    assert.equal(state().nodeHeapMb, 6144)
    assert.match(readFileSync(join(data, 'fixture-node-options.txt'), 'utf8'), /--max-old-space-size=6144$/)
    assert.equal(cli('restart').status, 0)
    assert.notEqual(state().pid, pid)
    assert.equal(state().nodeHeapMb, 6144, '未指定堆上限时沿用上次设置')
    const publicUrl = 'https://platform.example/hep/'
    const nat = cli('restart', '--host', '127.0.0.1', '--port', String(port), '--public-url', publicUrl)
    assert.equal(nat.status, 0, nat.stderr || nat.stdout)
    assert.equal(state().status, 'running', '健康检查访问本机监听，不请求不可达的公网示例地址')
    assert.equal(state().url, `http://127.0.0.1:${port}/hep/`)
    assert.equal(state().publicUrl, publicUrl)
    assert.equal(platformGroupUrl(data, 'example'), publicUrl + 'mcp/groups/example/v2')
    assert.equal(cli('restart').status, 0)
    assert.equal(state().publicUrl, publicUrl)
    assert.equal(state().port, port)
    assert.equal(cli('stop').status, 0)
    assert.equal(state().status, 'stopped')
    assert.equal(cli('stop').status, 0)
    writeFileSync(invalid, 'stale')
    const blockedStart = cli('start')
    assert.notEqual(blockedStart.status, 0)
    assert.match(blockedStart.stderr, /扩展尚未按当前来源构建/)
    assert.equal(state().status, 'stopped', '普通启动预检失败不能拉起子进程')
    rmSync(invalid)
    const log = join(data, '.local/platform-service/platform.log')
    writeFileSync(log, 'old failure token=old-secret\n')
    const failedStart = cliWithEnv({ HEP_FIXTURE_FAIL_START: '1' }, 'start')
    assert.notEqual(failedStart.status, 0)
    assert.match(failedStart.stderr, /fixture startup failure/)
    assert.match(failedStart.stderr, /\[REDACTED\]/)
    assert.doesNotMatch(failedStart.stderr, /fixture-secret|fixture-query|old-secret/)
    assert.match(failedStart.stderr, /日志：/)
    assert.equal(cli('start').status, 0)
    assert.equal(state().nodeHeapMb, 6144, '停止后再启动保留堆上限')
    assert.equal(state().publicUrl, publicUrl, '停止后启动仍保留公开入口')
    assert.equal(state().port, port, '停止后启动复用此前本机监听端口')
    assert.equal(cli('stop').status, 0)
    const foreground = spawn(join(repo, 'platform/dsh-platform'), ['start', '--foreground'], { env, stdio: 'ignore' })
    const foregroundExit = new Promise(resolve => foreground.once('exit', resolve))
    for (let n = 0; n < 50 && state().status !== 'running'; n++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(state().status, 'running')
    assert.equal(cli('stop').status, 0)
    await foregroundExit
    const occupied = spawn(process.env.HARNESS_PYTHON ?? 'python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { stdio: 'ignore' })
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      const before = readFileSync(file, 'utf8')
      assert.notEqual(cli('start').status, 0)
      assert.equal(readFileSync(file, 'utf8'), before)
      assert.ok(processBirth(occupied.pid))
    } finally { occupied.kill(); await new Promise(resolve => occupied.once('exit', resolve)) }
  } finally { cli('stop'); rmSync(root, { recursive: true, force: true }) }
})
