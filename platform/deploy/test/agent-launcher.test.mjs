import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function fixture(t, profile = 'web') {
  const root = mkdtempSync(join(tmpdir(), 'agent-launcher-')), bin = join(root, 'bin'), log = join(root, 'docker.log'), input = join(root, 'mcp-input')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'runtime')); mkdirSync(join(root, 'state')); mkdirSync(bin)
  copyFileSync(new URL('../agent/runtime/standalone_agent_launcher', import.meta.url), join(root, 'standalone_agent_launcher'))
  writeFileSync(join(root, 'runtime/bundle.env'), `AGENT_ID=fixture\nAGENT_PROFILE=${profile}\n`)
  writeFileSync(join(root, 'state/deployment.env'), 'AGENT_PORT=28027\nAGENT_HOST=127.0.0.1\nCOMPOSE_PROJECT_NAME=launcher-fixture\n')
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
printf '%s port=%s\n' "$*" "$AGENT_PORT" >> "$LAUNCHER_LOG"
if [ "\${*: -1}" = configure-mcp ]; then cat > "$LAUNCHER_INPUT"; exit "$LAUNCHER_CONFIGURE_EXIT"; fi
`, { mode: 0o755 })
  const run = (args, extra = {}) => spawnSync('bash', [join(root, 'standalone_agent_launcher'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, LAUNCHER_LOG: log, LAUNCHER_INPUT: input, LAUNCHER_CONFIGURE_EXIT: '0', ...extra } })
  return { root, log, input, run }
}

test('帮助和错误参数直接显示完整用法，不调用 Docker、不输出 Token', t => {
  const f = fixture(t)
  for (const args of [['-h'], ['--help'], ['start', '-h']]) {
    const r = f.run(args); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /--mcp-server/); assert.match(r.stdout, /用法：\.\/standalone_agent_launcher /); assert.doesNotMatch(r.stdout, /\.\/agent(?: |$)/)
  }
  for (const args of [['unknown'], ['stop', 'extra'], ['start', '--mcp-url'], ['start', '--mcp-url', 'http://test/mcp'], ['restart', '--mcp-server', 'soc'], ['start', '--mcp-server', 'soc', '--mcp-url', 'bad'], ['configure', '--config-file', '/missing'], ['run', '--input-file'], ['configure', '--mcp-token', 'must-not-echo']]) {
    const r = f.run(args); assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /用法：/); assert.doesNotMatch(r.stdout + r.stderr, /must-not-echo/)
  }
  assert.equal(existsSync(f.log), false)
})

test('打开入口使用当前配置的直接地址，无需认证文件或访问 Token', t => {
  const f = fixture(t)
  const result = f.run(['open'], { DISPLAY: '', WAYLAND_DISPLAY: '' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'http://127.0.0.1:28027/assistant/')
  assert.equal(existsSync(f.log), false)
})

test('启动、重启和配置的 MCP 参数通过 stdin 进入当前配置，Docker 参数不携带凭据', t => {
  const f = fixture(t)
  for (const action of ['start', 'restart', 'configure']) {
    const r = f.run([action, '--mcp-server', 'soc', '--mcp-url', 'http://new.test/openapi.json', '--mcp-token', 'test-secret-"-\\-$'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(f.input, 'utf8'), 'soc\0http://new.test/openapi.json\0test-secret-"-\\-$\0')
    assert.doesNotMatch(readFileSync(f.log, 'utf8') + r.stdout + r.stderr, /test-secret/)
    if (action !== 'configure') assert.match(readFileSync(f.log, 'utf8').split('\n').findLast(line => line.includes(' up ')), /up -d --force-recreate --wait dsh/)
  }
  assert.match(readFileSync(f.log, 'utf8'), /up -d --force-recreate --wait dsh/)
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /\bbuild\b/)
  assert.equal(f.run(['configure', '--mcp-server', 'soc', '--mcp-token', '']).status, 0)
  assert.equal(readFileSync(f.input, 'utf8'), 'soc\0\0\0')
  assert.equal(f.run(['configure', '--mcp-server', 'soc', '--mcp-url', 'http://new.test/mcp']).status, 0)
  assert.equal(readFileSync(f.input, 'utf8'), 'soc\0http://new.test/mcp\0')
  const failure = f.run(['restart', '--mcp-server', 'soc', '--mcp-token', 'test-secret'], { LAUNCHER_CONFIGURE_EXIT: '1' })
  assert.equal(failure.status, 2); assert.match(failure.stderr, /用法：/)
})

test('重启重新读取配置文件端口并重新建立映射，SDK 不重放任务', t => {
  const f = fixture(t)
  assert.equal(f.run(['start']).status, 0)
  assert.equal(f.run(['restart']).status, 0)
  writeFileSync(join(f.root, 'state/deployment.env'), 'AGENT_PORT=28028\nAGENT_HOST=127.0.0.1\n')
  assert.equal(f.run(['restart']).status, 0)
  const log = readFileSync(f.log, 'utf8')
  assert.match(log, /up -d --wait dsh port=28027/)
  assert.match(log, /up -d --force-recreate --wait dsh port=28027/)
  assert.match(log, /up -d --force-recreate --wait dsh port=28028/)
  writeFileSync(join(f.root, 'state/deployment.env'), 'AGENT_PORT=65536\n')
  const invalid = f.run(['start']); assert.equal(invalid.status, 2); assert.match(invalid.stderr, /用法：/)
  const sdk = fixture(t, 'sdk'), result = sdk.run(['restart'])
  assert.equal(result.status, 2); assert.match(result.stderr, /不会自动重放/); assert.equal(existsSync(sdk.log), false)
})

test('清理只移除本实例容器和安装介质，保留 Harness、HOME 和配置', t => {
  const f = fixture(t)
  for (const file of ['images/dsh-runtime.tar', 'offline/docker/archive', 'assets/workspace/AGENTS.md', 'state/home/session']) {
    mkdirSync(join(f.root, file, '..'), { recursive: true }); writeFileSync(join(f.root, file), 'retained-or-media')
  }
  const result = f.run(['cleanup'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(f.log, 'utf8'), /down --remove-orphans/)
  assert.doesNotMatch(readFileSync(f.log, 'utf8'), /--rmi|--volumes|\bprune\b/)
  for (const file of ['assets/workspace/AGENTS.md', 'state/home/session', 'state/deployment.env']) assert.ok(existsSync(join(f.root, file)))
  assert.equal(existsSync(join(f.root, 'images')), false)
  assert.equal(existsSync(join(f.root, 'offline')), false)
})
