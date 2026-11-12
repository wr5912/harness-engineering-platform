import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function fixture(t, projects = ['hep-agent-cleanup-fixture']) {
  const root = mkdtempSync(join(tmpdir(), 'agent-cleanup-')), bin = join(root, 'bin'), log = join(root, 'docker.log')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['state/home', 'runtime', 'images', 'offline', 'assets', 'bin']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ kind: 'standalone-agent' }))
  writeFileSync(join(root, 'runtime/compose.yaml'), '{}')
  writeFileSync(join(root, 'state/deployment.env'), 'COMPOSE_PROJECT_NAME=hep-agent-cleanup-fixture\n')
  writeFileSync(join(root, 'state/home/session'), 'retained')
  const containers = projects.map((project, index) => ({ Id: String(index), Config: { Labels: {
    'com.docker.compose.project': project, 'com.docker.compose.project.working_dir': root,
    'com.docker.compose.project.config_files': join(root, 'runtime/compose.yaml'),
  } }, Mounts: [{ Source: root, Destination: '/opt/standalone' }] }))
  const save = () => writeFileSync(join(root, 'containers.json'), JSON.stringify(containers))
  save()
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.CLEANUP_ROOT;
fs.appendFileSync(process.env.CLEANUP_LOG, args.join(' ') + '\\n');
const containers = JSON.parse(fs.readFileSync(path.join(root, 'containers.json')));
if (args[0] === 'inspect') console.log(JSON.stringify(containers));
else if (args[0] === 'ps') console.log(containers.filter(c => !args.includes('--filter') || args.at(-1).endsWith('=' + c.Config.Labels['com.docker.compose.project'])).map(c => c.Id).join('\\n'));
else if (args[0] === 'network') { if (process.env.CLEANUP_NETWORK_STUCK) console.log('leftover-network'); }
else if (args[0] === 'compose') {
  if (process.env.CLEANUP_EXIT) process.exit(Number(process.env.CLEANUP_EXIT));
  if (!process.env.CLEANUP_STUCK) fs.writeFileSync(path.join(root, 'containers.json'), JSON.stringify(containers.filter(c => c.Config.Labels['com.docker.compose.project'] !== args[args.indexOf('--project-name') + 1])));
} else process.exit(2);
`, { mode: 0o755 })
  const run = extra => spawnSync(process.execPath, ['--experimental-strip-types', 'platform/deploy/cli.mts', 'agent-cleanup', '--prefix', root], {
    encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, CLEANUP_ROOT: root, CLEANUP_LOG: log, COMPOSE_PROJECT_NAME: 'unrelated-project', ...extra },
  })
  return { root, log, containers, save, run }
}

test('维护工具清理旧安装，失败保留介质和 HOME，成功核对容器已移除', t => {
  const { root, log, run } = fixture(t)
  assert.notEqual(run({ CLEANUP_EXIT: '1' }).status, 0)
  assert.ok(existsSync(join(root, 'images')))
  assert.ok(existsSync(join(root, 'state/home/session')))
  const result = run({})
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).retained, ['image', 'assets', 'config-seed', 'state'])
  assert.match(readFileSync(log, 'utf8'), /--env-file .*state\/deployment.env .* down --remove-orphans/)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /--rmi|--volumes|\bprune\b/)
  for (const dir of ['images', 'offline']) assert.equal(existsSync(join(root, dir)), false)
  for (const dir of ['assets', 'state/home']) assert.ok(existsSync(join(root, dir)))
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ kind: 'platform' }))
  const before = readFileSync(log, 'utf8')
  assert.notEqual(run({}).status, 0)
  assert.equal(readFileSync(log, 'utf8'), before)
})

test('没有安装身份文件的探针及同目录旧项目均按实际归属清理', t => {
  const { root, run } = fixture(t, ['hep-exp027-export-probe', 'hep-agent-old-project'])
  rmSync(join(root, 'state/deployment.env'))
  const result = run({})
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).projects, ['hep-exp027-export-probe', 'hep-agent-old-project'])
  assert.equal(readFileSync(join(root, 'state/home/session'), 'utf8'), 'retained')
})

test('同项目存在其他安装的容器时，在任何删除前拒绝', t => {
  const { root, log, containers, save, run } = fixture(t)
  containers.push({ ...containers[0], Id: 'foreign', Mounts: [{ Source: '/other-installation', Destination: '/opt/standalone' }] })
  save()
  assert.notEqual(run({}).status, 0)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /\bcompose\b/)
  assert.ok(existsSync(join(root, 'images')))
})

test('Docker 报成功但仍残留容器时不宣称完成，不删除介质', t => {
  const { root, run } = fixture(t)
  const result = run({ CLEANUP_STUCK: '1' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /仍有目标容器残留/)
  assert.ok(existsSync(join(root, 'images')))
})

test('清理后仍残留网络时同样保留介质并报告失败', t => {
  const { root, run } = fixture(t)
  const result = run({ CLEANUP_NETWORK_STUCK: '1' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /仍有目标网络残留/)
  assert.ok(existsSync(join(root, 'images')))
})

test('没有安装身份和实际容器的原始交付包不能被当作旧安装清理', t => {
  const { root, log, run } = fixture(t, [])
  rmSync(join(root, 'state/deployment.env'))
  assert.notEqual(run({}).status, 0)
  assert.doesNotMatch(readFileSync(log, 'utf8'), /\bcompose\b/)
  assert.ok(existsSync(join(root, 'images')))
})
