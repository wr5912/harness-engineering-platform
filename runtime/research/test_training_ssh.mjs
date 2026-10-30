import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, connect } from 'node:net'
import { shellQuote, readCommandCard, readSshCredential, readForwardMappings, launchScript, statusScript } from './training-ssh.mts'
import { readTrainingServerDirectory, resolveTrainingServerCredentialPath } from '../../platform/plugin/src/agents/training-servers.ts'

// 只隔离OpenSSH网络边界；AskPass、命令卡、POSIX runner、/proc身份和文件摘要均执行真实代码。
const cli = fileURLToPath(new URL('./training-ssh.mts', import.meta.url))
function fixture(t) {
  mkdirSync(resolve('.local'), { recursive: true })
  const root = mkdtempSync(resolve('.local/training-ssh-test-'))
  for (const path of ['config', '.local/credentials/training-servers', 'remote', 'bin']) mkdirSync(join(root, path), { recursive: true })
  const server = { id: 'train-123456789abc', name: 'unit local transport', host: 'fixture.invalid', port: 2222, user: 'unit', workDir: join(root, 'remote'), auth: 'password', credentialRef: 'ref:training-server/unit' }
  writeFileSync(join(root, 'config/compute-training-servers.json'), JSON.stringify({ schemaVersion: 1, servers: [server] }))
  const password = 'UNIT_ONLY_PRIVATE_VALUE'
  writeFileSync(join(root, '.local/credentials/training-servers/unit.json'), JSON.stringify({ schema_version: 1, kind: 'ssh_password', password }), { mode: 0o600 })
  writeFileSync(join(root, 'bin/ssh'), `#!${process.execPath}\nconst fs=require('fs'),cp=require('child_process'),args=process.argv.slice(2);const secret=cp.spawnSync(process.env.SSH_ASKPASS,['fixture password:'],{encoding:'utf8'});if(secret.status!==0||secret.stdout.trim()!==${JSON.stringify(password)})process.exit(255);fs.appendFileSync(${JSON.stringify(join(root, 'wire.jsonl'))},JSON.stringify({args,askpass:process.env.SSH_ASKPASS,force:process.env.SSH_ASKPASS_REQUIRE})+'\\n');if(args.includes('-N')){const servers=args.flatMap((value,index)=>value==='-L'?[args[index+1]]:[]).map(value=>{const [host,port]=value.split(':');const s=require('net').createServer(socket=>socket.end('LOCAL_TUNNEL_FIXTURE'));s.on('error',()=>process.exit(255));s.listen(Number(port),host);return s});process.on('SIGTERM',()=>{for(const s of servers)s.close();process.exit(0)})}else{const child=cp.spawn('sh',['-s'],{stdio:['pipe','inherit','inherit']});child.stdin.end(fs.readFileSync(0));child.on('close',code=>process.exit(code??255))}\n`, { mode: 0o700 })
  writeFileSync(join(root, 'bin/scp'), `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2),parts=args.slice(-2).map(x=>x.includes('fixture.invalid:')?x.split('fixture.invalid:')[1]:x);fs.copyFileSync(parts[0],parts[1]);\n`, { mode: 0o700 })
  const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH }
  const run = (...args) => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args, '--asset-root', root], { encoding: 'utf8', env, timeout: 15000 })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, server, password, env, run }
}

test('连接目录保持原保存合同，专用引用只在CLI解析；凭据JSON错误不会反射正文', t => {
  const f = fixture(t)
  assert.deepEqual(readTrainingServerDirectory(f.root).servers, [f.server])
  assert.equal(resolveTrainingServerCredentialPath(f.root, f.server.credentialRef), join(f.root, '.local/credentials/training-servers/unit.json'))
  assert.throws(() => resolveTrainingServerCredentialPath(f.root, 'ref:training-server/../outside'), /专用凭据引用/)
  assert.equal(readSshCredential(f.root, f.server.credentialRef).password, f.password)
  writeFileSync(join(f.root, '.local/credentials/training-servers/unit.json'), '{"password":"' + f.password)
  const result = f.run('exec', '--server-id', f.server.id, '--card', join(f.root, 'missing'), '--receipt', join(f.root, 'missing.json'))
  assert.equal((result.stderr + result.stdout).includes(f.password), false)
  assert.throws(() => readSshCredential(f.root, f.server.credentialRef), /^Error: SSH_CREDENTIAL_JSON_INVALID$/)
})

test('命令卡保留argv/env/unset与shell字面值，不执行插值或向工作区外派发', t => {
  const f = fixture(t), card = join(f.root, 'card.json')
  const value = { cwd: f.server.workDir, argv: ['printf', '%s', "$(touch must-not-exist)'你好"], env: { VALUE: '原文' }, unset_env: ['INHERITED'] }
  writeFileSync(card, JSON.stringify(value))
  assert.deepEqual(readCommandCard(card, f.server.workDir), value)
  assert.equal(spawnSync('sh', ['-c', `printf '%s' ${shellQuote(value.argv[2])}`], { encoding: 'utf8' }).stdout, value.argv[2])
  assert.equal(existsSync(join(f.root, 'must-not-exist')), false)
  writeFileSync(card, JSON.stringify({ ...value, cwd: dirnameOutside(f.server.workDir) }))
  assert.throws(() => readCommandCard(card, f.server.workDir), /OUTSIDE_SERVER_WORKDIR/)
})
function dirnameOutside(path) { return resolve(path, '..') }

test('普通native Job可执行CLI：真实runner写入PID/出生时间/退出状态，原始输出及回收摘要可核对', t => {
  const f = fixture(t), card = join(f.root, 'card.json'), receipt = join(f.root, 'receipt.json')
  writeFileSync(card, JSON.stringify({ cwd: f.server.workDir, argv: ['sh', '-c', 'printf "真实输出:%s\\n" "$VALUE"; test -z "${TO_BE_REMOVED+x}"; printf actual-artifact > artifact.bin'], env: { VALUE: '保留原文' }, unset_env: ['TO_BE_REMOVED'] }))
  f.env.TO_BE_REMOVED = 'inherited'
  const result = f.run('exec', '--server-id', f.server.id, '--card', card, '--receipt', receipt)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /真实输出:保留原文/)
  const saved = JSON.parse(readFileSync(receipt))
  assert.equal(saved.status, 'completed'); assert.equal(saved.exit_code, 0)
  assert.ok(saved.pid > 0); assert.match(saved.start_time, /^\d+$/)
  assert.equal((result.stdout + result.stderr + readFileSync(receipt) + readFileSync(join(f.root, 'wire.jsonl'))).includes(f.password), false)
  assert.equal(f.run('exec', '--server-id', f.server.id, '--card', card, '--receipt', receipt).status, 1)
  assert.equal(f.run('status', '--receipt', receipt).status, 0)
  const local = join(f.root, 'collected.bin'), transferred = join(f.root, 'transfer.json')
  const copy = f.run('transfer', '--server-id', f.server.id, '--direction', 'download', '--local', local, '--remote', join(f.server.workDir, 'artifact.bin'), '--receipt', transferred)
  assert.equal(copy.status, 0, copy.stderr)
  assert.equal(readFileSync(local, 'utf8'), 'actual-artifact')
  assert.match(JSON.parse(readFileSync(transferred)).sha256, /^[a-f0-9]{64}$/)
})

test('失败保留实际exit，远端取消核验所属进程组；PID错配不能误杀其他进程', async t => {
  const f = fixture(t), card = join(f.root, 'failure.json'), receipt = join(f.root, 'failure-receipt.json')
  writeFileSync(card, JSON.stringify({ cwd: f.server.workDir, argv: ['sh', '-c', 'exit 7'], env: {}, unset_env: [] }))
  const failed = f.run('exec', '--server-id', f.server.id, '--card', card, '--receipt', receipt)
  assert.equal(failed.status, 7, failed.stderr)
  assert.equal(JSON.parse(readFileSync(receipt)).exit_code, 7)
  const directory = join(f.server.workDir, 'owned-test'), digest = 'a'.repeat(64)
  const long = { cwd: f.server.workDir, argv: ['sleep', '20'], env: {}, unset_env: [] }
  assert.equal(spawnSync('sh', ['-s'], { input: launchScript(long, directory, digest), encoding: 'utf8' }).status, 0)
  t.after(() => spawnSync('sh', ['-s'], { input: statusScript({ remote: directory, card_sha256: digest }, true) }))
  const observed = () => spawnSync('sh', ['-s'], { input: statusScript({ remote: directory, card_sha256: digest }), encoding: 'utf8' })
  assert.match(observed().stdout, /HSSH_STATE=running/)
  const actualStart = readFileSync(join(directory, 'start-time'), 'utf8')
  writeFileSync(join(directory, 'start-time'), '1\n')
  assert.match(spawnSync('sh', ['-s'], { input: statusScript({ remote: directory, card_sha256: digest }, true), encoding: 'utf8' }).stdout, /identity_mismatch/)
  writeFileSync(join(directory, 'start-time'), actualStart)
  assert.match(observed().stdout, /HSSH_STATE=running/)
  const cancelled = spawnSync('sh', ['-s'], { input: statusScript({ remote: directory, card_sha256: digest }, true), encoding: 'utf8' })
  assert.match(cancelled.stdout, /HSSH_STATE=cancelled/)
  await delay(100)
  assert.match(observed().stdout, /HSSH_STATE=cancelled/)
})

test('子进程尚未响应TERM时保持stopping，不把runner已退出说成远端全部停止', t => {
  const f = fixture(t), directory = join(f.server.workDir, 'stubborn-child'), digest = 'b'.repeat(64)
  const card = { cwd: f.server.workDir, argv: ['sh', '-c', 'trap "" TERM; sleep 20'], env: {}, unset_env: [] }
  assert.equal(spawnSync('sh', ['-s'], { input: launchScript(card, directory, digest), encoding: 'utf8' }).status, 0)
  const pid = Number(readFileSync(join(directory, 'pid'), 'utf8'))
  t.after(() => spawnSync('/bin/kill', ['-KILL', '--', `-${pid}`]))
  const stopped = spawnSync('sh', ['-s'], { input: statusScript({ remote: directory, card_sha256: digest }, true), encoding: 'utf8' })
  assert.match(stopped.stdout, /HSSH_STATE=stopping/)
  assert.match(spawnSync('sh', ['-s'], { input: statusScript({ remote: directory, card_sha256: digest }), encoding: 'utf8' }).stdout, /HSSH_STATE=stopping/)
})

async function freePort() {
  const listener = createServer()
  await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const port = listener.address().port
  await new Promise(done => listener.close(done))
  return port
}
async function waitFor(check) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(30) }
  throw new Error('FIXTURE_WAIT_TIMEOUT')
}

test('forward显式双映射由前台SSH持有，status核对实际PID监听；原生Job的TERM关闭隧道并清AskPass', async t => {
  const f = fixture(t), mappings = join(f.root, 'mappings.json'), receipt = join(f.root, 'forward.json')
  const ports = [await freePort(), await freePort()]
  writeFileSync(mappings, JSON.stringify(ports.map((local_port, index) => ({ bind_address: '127.0.0.1', local_port, remote_port: 18881 + index }))))
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, 'forward', '--asset-root', f.root, '--server-id', f.server.id, '--mappings', mappings, '--receipt', receipt], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })))
  t.after(() => child.kill('SIGTERM'))
  let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const active = await waitFor(() => { try { const saved = JSON.parse(readFileSync(receipt)); return saved.status === 'running' && saved } catch { return false } })
  assert.equal(active.listeners_verified, true); assert.ok(active.pid > 0); assert.match(active.start_time, /^\d+$/)
  assert.equal(f.run('status', '--receipt', receipt).status, 0)
  const wire = JSON.parse(readFileSync(join(f.root, 'wire.jsonl'), 'utf8').trim())
  assert.ok(wire.args.includes('ExitOnForwardFailure=yes')); assert.ok(wire.args.includes('ForkAfterAuthentication=no'))
  assert.ok(wire.args.includes('ControlMaster=no')); assert.ok(wire.args.includes('ControlPath=none'))
  for (const [index, port] of ports.entries()) {
    assert.ok(wire.args.includes(`127.0.0.1:${port}:127.0.0.1:${18881 + index}`))
    const data = await new Promise((done, fail) => { const socket = connect(port, '127.0.0.1'); let text = ''; socket.on('data', data => { text += data }); socket.on('end', () => done(text)); socket.on('error', fail) })
    assert.equal(data, 'LOCAL_TUNNEL_FIXTURE')
  }
  writeFileSync(receipt, JSON.stringify({ ...active, pid: process.pid, start_time: '1' }))
  const mismatched = f.run('cancel', '--receipt', receipt)
  assert.equal(mismatched.status, 1); assert.match(mismatched.stderr, /FORWARD_CONTROL_BINDING_MISMATCH/)
  writeFileSync(receipt, JSON.stringify(active))
  child.kill('SIGTERM')
  assert.equal((await closed).code, 0, output)
  const stopped = JSON.parse(readFileSync(receipt))
  assert.equal(stopped.status, 'closed'); assert.equal(stopped.listeners_verified, false)
  assert.equal(existsSync(wire.askpass), false)
  assert.equal((output + readFileSync(receipt) + JSON.stringify(wire)).includes(f.password), false)
  assert.equal(existsSync(join(f.server.workDir, '.harness-training-ssh')), false)
})

test('forward无默认bind、越界端口拒绝；端口占用以真实SSH失败留回执，不误报running', async t => {
  const f = fixture(t), mappings = join(f.root, 'bad-mappings.json'), receipt = join(f.root, 'failed-forward.json')
  for (const value of [[{ local_port: 18881, remote_port: 18881 }], [{ bind_address: '127.0.0.1', local_port: 65536, remote_port: 18881 }]]) {
    writeFileSync(mappings, JSON.stringify(value)); assert.throws(() => readForwardMappings(mappings), /FORWARD_MAPPING_INVALID/)
  }
  const listener = createServer()
  await new Promise(done => listener.listen(0, '127.0.0.1', done)); t.after(() => listener.close())
  writeFileSync(mappings, JSON.stringify([{ bind_address: '127.0.0.1', local_port: listener.address().port, remote_port: 18881 }]))
  const failed = f.run('forward', '--server-id', f.server.id, '--mappings', mappings, '--receipt', receipt)
  assert.equal(failed.status, 1, failed.stderr)
  assert.equal(JSON.parse(readFileSync(receipt)).status, 'failed')
  assert.equal(JSON.parse(readFileSync(receipt)).exit_code, 255)
  assert.equal(JSON.parse(readFileSync(receipt)).listeners_verified, false)
  assert.equal(f.run('status', '--receipt', receipt).status, 255)
  assert.equal(JSON.parse(readFileSync(receipt)).status, 'failed')
  const wire = JSON.parse(readFileSync(join(f.root, 'wire.jsonl'), 'utf8').trim())
  assert.equal(existsSync(wire.askpass), false)
})

test('forward cancel只停止已核验的本地SSH，读取closed回执不再连接远端', async t => {
  const f = fixture(t), mappings = join(f.root, 'mappings.json'), receipt = join(f.root, 'forward.json')
  writeFileSync(mappings, JSON.stringify([{ bind_address: '127.0.0.1', local_port: await freePort(), remote_port: 18882 }]))
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, 'forward', '--asset-root', f.root, '--server-id', f.server.id, '--mappings', mappings, '--receipt', receipt], { env: f.env, stdio: 'ignore' })
  const closed = new Promise(done => child.once('close', code => done(code)))
  t.after(() => child.kill('SIGTERM'))
  await waitFor(() => { try { return JSON.parse(readFileSync(receipt)).status === 'running' } catch { return false } })
  const cancelled = f.run('cancel', '--receipt', receipt)
  assert.equal(cancelled.status, 0, cancelled.stderr)
  assert.equal(JSON.parse(cancelled.stdout).status, 'closed')
  assert.equal(await closed, 0)
  assert.equal(f.run('status', '--receipt', receipt).status, 0)
  assert.equal(JSON.parse(readFileSync(receipt)).status, 'closed')
  assert.equal(readFileSync(join(f.root, 'wire.jsonl'), 'utf8').trim().split('\n').length, 1)
})

test('独立PID命名空间通过共享owner socket核状态与取消，不把另一个Job的PID当本地PID', async t => {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--', 'true'], { encoding: 'utf8' })
  if (probe.status !== 0) { t.skip('当前测试环境未提供可用bwrap；18120原生Job另行实际核验'); return }
  const f = fixture(t), mappings = join(f.root, 'mappings.json'), receipt = join(f.root, 'forward.json')
  writeFileSync(mappings, JSON.stringify([{ bind_address: '127.0.0.1', local_port: await freePort(), remote_port: 18882 }]))
  const owner = spawn(process.execPath, ['--experimental-strip-types', cli, 'forward', '--asset-root', f.root, '--server-id', f.server.id, '--mappings', mappings, '--receipt', receipt], { env: f.env, stdio: 'ignore' })
  const ended = new Promise(done => owner.once('close', code => done(code)))
  t.after(() => owner.kill('SIGTERM'))
  await waitFor(() => { try { return JSON.parse(readFileSync(receipt)).status === 'running' } catch { return false } })
  function sandbox(action) {
    return spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--bind', f.root, f.root, '--',
      process.execPath, '--experimental-strip-types', cli, action, '--asset-root', f.root, '--receipt', receipt], { env: f.env, encoding: 'utf8', timeout: 10000 })
  }
  const status = sandbox('status')
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).status, 'running')
  assert.equal(JSON.parse(status.stdout).listeners_verified, true)
  const cancel = sandbox('cancel')
  assert.equal(cancel.status, 0, cancel.stderr)
  assert.equal(JSON.parse(cancel.stdout).status, 'closed')
  assert.equal(await ended, 0)
})

test('owner控制通道不可达时保持unknown，不覆盖仍在运行的回执或误停其他namespace进程', async t => {
  const f = fixture(t), mappings = join(f.root, 'mappings.json'), receipt = join(f.root, 'forward.json')
  writeFileSync(mappings, JSON.stringify([{ bind_address: '127.0.0.1', local_port: await freePort(), remote_port: 18882 }]))
  const owner = spawn(process.execPath, ['--experimental-strip-types', cli, 'forward', '--asset-root', f.root, '--server-id', f.server.id, '--mappings', mappings, '--receipt', receipt], { env: f.env, stdio: 'ignore' })
  const ended = new Promise(done => owner.once('close', code => done(code)))
  t.after(() => owner.kill('SIGTERM'))
  const active = await waitFor(() => { try { const value = JSON.parse(readFileSync(receipt)); return value.status === 'running' && value } catch { return false } })
  rmSync(active.control_socket)
  for (const action of ['status', 'cancel']) {
    const result = f.run(action, '--receipt', receipt)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(JSON.parse(result.stdout).status, 'unknown')
    assert.equal(JSON.parse(result.stdout).error, 'FORWARD_OWNER_UNREACHABLE')
    assert.deepEqual(JSON.parse(readFileSync(receipt)), active)
    assert.equal(owner.exitCode, null)
  }
  owner.kill('SIGTERM'); assert.equal(await ended, 0)
})

test('forward收到TERM仍存活时持续显示stopping，保留实际监听而不退回running', async t => {
  const f = fixture(t), mappings = join(f.root, 'mappings.json'), receipt = join(f.root, 'forward.json')
  const fakeSsh = join(f.root, 'bin/ssh'), original = readFileSync(fakeSsh, 'utf8')
  const handler = "process.on('SIGTERM',()=>{for(const s of servers)s.close();process.exit(0)})"
  assert.ok(original.includes(handler))
  writeFileSync(fakeSsh, original.replace(handler, "process.on('SIGTERM',()=>{})"), { mode: 0o700 })
  writeFileSync(mappings, JSON.stringify([{ bind_address: '127.0.0.1', local_port: await freePort(), remote_port: 18882 }]))
  const owner = spawn(process.execPath, ['--experimental-strip-types', cli, 'forward', '--asset-root', f.root, '--server-id', f.server.id, '--mappings', mappings, '--receipt', receipt], { env: f.env, stdio: 'ignore' })
  const ended = new Promise(done => owner.once('close', done))
  let active
  try {
    active = await waitFor(() => { try { const value = JSON.parse(readFileSync(receipt)); return value.status === 'running' && value } catch { return false } })
    const cancelled = f.run('cancel', '--receipt', receipt)
    assert.equal(cancelled.status, 1, cancelled.stderr)
    assert.equal(JSON.parse(cancelled.stdout).status, 'stopping')
    for (let index = 0; index < 2; index++) {
      const observed = f.run('status', '--receipt', receipt)
      assert.equal(observed.status, 1, observed.stderr)
      assert.equal(JSON.parse(observed.stdout).status, 'stopping')
      assert.equal(JSON.parse(observed.stdout).listeners_verified, true)
      assert.equal(owner.exitCode, null)
    }
  } finally {
    // 只回收本测试故意忽略TERM的替身；生产SSH或模型服务不参与此夹具。
    if (active) {
      const stat = readFileSync(`/proc/${active.pid}/stat`, 'utf8'), start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      assert.equal(start, active.start_time)
      process.kill(active.pid, 'SIGKILL')
    }
    owner.kill('SIGTERM')
    await ended
  }
})
