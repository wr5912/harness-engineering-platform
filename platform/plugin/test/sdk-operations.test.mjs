import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const program = resolve(new URL('../../../', import.meta.url).pathname)
const base = join(program, '.local/sdk-operation-tests')
mkdirSync(base, { recursive: true })
const compiled = mkdtempSync(join(base, 'compiled-'))
await build({ entryPoints: [new URL('../src/sdk/operations.ts', import.meta.url).pathname], outfile: join(compiled, 'operations.mjs'), bundle: true, platform: 'node', format: 'esm' })
await build({ entryPoints: [new URL('../src/sdk/worker.ts', import.meta.url).pathname], outfile: join(compiled, 'worker.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createSdkHandler } = await import(`file://${join(compiled, 'operations.mjs')}`)
process.env.HARNESS_PROGRAM_ROOT = program
process.env.HARNESS_PYTHON = '/usr/bin/python3.10'
const source = 'experiment:EXP-sdk-test-001-r123456abcdef'
function fixture(t, { slow = false, fail = false, modelPolicy } = {}) {
  const root = mkdtempSync(join(base, 'workspace-'))
  const candidate = join(root, 'evolution/experiments', source.slice(11), 'candidate')
  mkdirSync(join(candidate, 'sdk'), { recursive: true })
  writeFileSync(join(candidate, '../change.yaml'), `agent_id: sdk-test\nexperiment_id: ${source.slice(11)}\n`)
  writeFileSync(join(candidate, 'harness.yaml'), 'loadable_assets:\n  profile: sdk\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: sdk-test\n  profile_patch: dsh/managed/sdk.patch.yml\ncredential_environment_keys: []\n')
  writeFileSync(join(candidate, 'sdk/README.md'), '# SDK 接入\n唯一指南正文。\n')
  writeFileSync(join(candidate, 'sdk/example.ts'), "import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'\n")
  const cli = join(root, 'fake-cli.py')
  writeFileSync(cli, `import json,sys,time,signal,os\nfrom pathlib import Path\na=sys.argv\nif 'down' in a: sys.exit(0)\np=Path(${JSON.stringify(root)})/'calls'\np.write_text(p.read_text()+'1' if p.exists() else '1')\nreg=Path(os.environ['HARNESS_ASSET_ROOT'])/'.local/instances/sdk-demo'\nreg.mkdir(parents=True,exist_ok=True)\n(reg/'instance.json').write_text(json.dumps({'profile':'sdk','source_id':'experiment:EXP-sdk-test-001-r123456abcdef','sdk_operation_id':os.environ.get('HARNESS_SDK_OPERATION_ID'),'asset_root':os.environ['HARNESS_ASSET_ROOT']}))\nprint(json.dumps({'event':'started'}),flush=True)\nsignal.signal(signal.SIGTERM,lambda *_:sys.exit(0))\ntime.sleep(${slow ? '20' : '0.1'})\n${fail ? "print(json.dumps({'profile':'sdk','name':'sdk-demo','status':'failed','message':os.environ.get('SDK_TEST_KEY','failure')}),flush=True);sys.exit(1)" : "print(json.dumps({'name':'sdk-demo','profile':'sdk','status':'completed','session_id':'session-sdk-test','final_response':'SDK调用完成'}),flush=True)"}\n`)
  const handler = createSdkHandler(root, { worker: join(compiled, 'worker.mjs'), cli, modelPolicy })
  const rpc = (method, body) => handler(method, body, new AbortController().signal, undefined)
  t.after(async () => {
    const listed = await rpc('list', {})
    for (const op of listed.value ?? []) if (['starting', 'running', 'unknown', 'stopping'].includes(op.status)) {
      await rpc('stop', { operation_id: op.id })
      await terminal(rpc, op.id).catch(() => {})
    }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, candidate, rpc, handler, cli }
}
const request = (id, extra = {}) => ({ request_id: id, source, instance_id: 'sdk-demo', input: '执行测试', ...extra })
async function terminal(rpc, id) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const status = await rpc('status', { operation_id: id })
    assert.equal(status.ok, true, JSON.stringify(status))
    if (['completed', 'failed', 'stopped', 'unknown'].includes(status.value.status)) return status.value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('SDK 操作未结束')
}

test('SDK调试从持久记录回读结果，回执丢失后同一请求不重复执行', async t => {
  const fx = fixture(t)
  const started = await fx.rpc('start', request('sdk-request-1'))
  assert.equal(started.ok, true, JSON.stringify(started))
  const done = await terminal(fx.rpc, 'sdk-request-1')
  assert.equal(done.status, 'completed'); assert.equal(done.final_response, 'SDK调用完成')
  assert.equal(done.session_id, 'session-sdk-test'); assert.equal(done.events[0].event, 'started')
  const recovered = createSdkHandler(fx.root)
  const repeated = await recovered('start', request('sdk-request-1'), new AbortController().signal)
  assert.equal(repeated.ok, true); assert.equal(repeated.value.id, done.id)
  assert.equal(readFileSync(join(fx.root, 'calls'), 'utf8'), '1')
  assert.equal((await fx.rpc('start', request('sdk-request-1', { input: '其他任务' }))).ok, false)
})

test('同实例互斥且停止会结束真实SDK调试进程，状态可查询', async t => {
  const fx = fixture(t, { slow: true })
  assert.equal((await fx.rpc('start', request('sdk-stop-1'))).ok, true)
  while (!(await fx.rpc('status', { operation_id: 'sdk-stop-1' })).value.worker_pid) await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await fx.rpc('start', request('sdk-stop-2'))).ok, false)
  assert.equal((await fx.rpc('stop', { operation_id: 'sdk-stop-1' })).ok, true)
  assert.equal((await terminal(fx.rpc, 'sdk-stop-1')).status, 'stopped')
})

test('调试错误保留失败，模型环境凭据不进入操作记录', async t => {
  const secret = 'sdk-fixture-private-value'
  const fx = fixture(t, { fail: true, modelPolicy: async () => ({ policy: { default: { provider: 'fixture', model: 'fixture' } }, environment: { SDK_TEST_KEY: secret } }) })
  await fx.rpc('start', request('sdk-failed-1'))
  const done = await terminal(fx.rpc, 'sdk-failed-1')
  assert.equal(done.status, 'failed'); assert.match(done.error, /REDACTED/)
  assert.equal(readFileSync(join(fx.root, '.local/sdk-operations/sdk-failed-1/operation.json'), 'utf8').includes(secret), false)
})

test('指南读取所选版本唯一资产并提供工作区身份，无效路径不产生操作', async t => {
  const fx = fixture(t)
  const guide = await fx.rpc('guide', { source })
  assert.equal(guide.ok, true); assert.match(guide.value.workspace_id, /^workspace-/)
  assert.equal(guide.value.markdown, '# SDK 接入\n唯一指南正文。\n')
  assert.match(guide.value.example, /dsh-sdk-client/)
  assert.equal((await fx.rpc('start', request('../invalid'))).ok, false)
  assert.deepEqual((await fx.rpc('list', {})).value, [])
})

test('Web版本拒绝SDK调用，持久运行记录丢进程后标记未知且不重跑', async t => {
  const fx = fixture(t)
  const file = join(fx.candidate, 'harness.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace('profile: sdk', 'profile: web'))
  assert.equal((await fx.rpc('start', request('sdk-wrong-profile'))).ok, false)
  const directory = join(fx.root, '.local/sdk-operations/sdk-lost-1')
  mkdirSync(directory, { recursive: true })
  const guideFile = readFileSync(file, 'utf8').replace('profile: web', 'profile: sdk'); writeFileSync(file, guideFile)
  const guide = await fx.rpc('guide', { source })
  const instance = join(fx.root, '.local/instances/sdk-demo'); mkdirSync(instance, { recursive: true }); writeFileSync(join(instance, 'instance.json'), JSON.stringify({ profile: 'sdk', source_id: source, sdk_operation_id: 'sdk-lost-1', asset_root: fx.root }))
  writeFileSync(join(directory, 'operation.json'), JSON.stringify({ id: 'sdk-lost-1', workspace_id: guide.value.workspace_id, instance_id: 'sdk-demo', source, status: 'running', worker_pid: 99999999, created_at: new Date().toISOString(), events: [] }))
  assert.equal((await fx.rpc('status', { operation_id: 'sdk-lost-1' })).value.status, 'unknown')
  assert.equal((await fx.rpc('start', request('sdk-new-after-lost'))).ok, false)
  assert.equal((await fx.rpc('stop', { operation_id: 'sdk-lost-1' })).value.status, 'stopped')
})

test('旧SDK操作不能停止后来同名的Web实例或另一SDK执行代次', async t => {
  const fx = fixture(t)
  await fx.rpc('start', request('sdk-old-operation'))
  await terminal(fx.rpc, 'sdk-old-operation')
  const directory = join(fx.root, '.local/sdk-operations/sdk-old-operation')
  const operation = JSON.parse(readFileSync(join(directory, 'operation.json'), 'utf8'))
  operation.status = 'unknown'; writeFileSync(join(directory, 'operation.json'), JSON.stringify(operation))
  const manifestFile = join(fx.root, '.local/instances/sdk-demo/instance.json')
  for (const replacement of [{ profile: 'web', sdk_operation_id: 'sdk-old-operation' }, { profile: 'sdk', sdk_operation_id: 'sdk-new-operation' }]) {
    writeFileSync(manifestFile, JSON.stringify({ ...replacement, source_id: source, asset_root: fx.root }))
    const stopped = await fx.rpc('stop', { operation_id: 'sdk-old-operation' })
    assert.equal(stopped.ok, false); assert.match(stopped.error.message, /已被替换|不属于/)
    assert.equal((await fx.rpc('status', { operation_id: 'sdk-old-operation' })).value.status, 'unknown')
  }
  // 测试清理只结束旧操作记录，不对替换后的实例执行停止。
  operation.status = 'stopped'; writeFileSync(join(directory, 'operation.json'), JSON.stringify(operation))
})

test('执行进程丢失完成回执时保持结果未知，官方自定义Session ID可提交恢复', async t => {
  const fx = fixture(t)
  const code = readFileSync(fx.cli, 'utf8').replace("print(json.dumps({'name':'sdk-demo','profile':'sdk','status':'completed','session_id':'session-sdk-test','final_response':'SDK调用完成'}),flush=True)", 'sys.exit(1)')
  writeFileSync(fx.cli, code)
  const started = await fx.rpc('start', request('sdk-no-receipt', { session_id: 'Caller_SessionA' }))
  assert.equal(started.ok, true)
  assert.equal((await terminal(fx.rpc, 'sdk-no-receipt')).status, 'unknown')
  assert.equal((await fx.rpc('start', request('sdk-no-receipt-again'))).ok, false)
  assert.equal((await fx.rpc('stop', { operation_id: 'sdk-no-receipt' })).ok, true)
})

test('复用已完成实例在准备阶段立即停止，只结束本次CLI而不停止旧代次', async t => {
  const fx = fixture(t)
  const instance = join(fx.root, '.local/instances/sdk-demo')
  mkdirSync(instance, { recursive: true })
  const old = { profile: 'sdk', source_id: source, sdk_operation_id: 'old-completed-operation', status: 'completed', asset_root: fx.root }
  writeFileSync(join(instance, 'instance.json'), JSON.stringify(old))
  writeFileSync(fx.cli, readFileSync(fx.cli, 'utf8').replace("if 'down' in a: sys.exit(0)", `if 'down' in a: Path(${JSON.stringify(join(fx.root, 'downs'))}).write_text('1');sys.exit(0)`)
    .replace("reg=Path(os.environ", "time.sleep(20)\nreg=Path(os.environ"))
  assert.equal((await fx.rpc('start', request('sdk-preparing-stop'))).ok, true)
  while (!(await fx.rpc('status', { operation_id: 'sdk-preparing-stop' })).value.worker_pid) await new Promise(resolve => setTimeout(resolve, 20))
  await fx.rpc('stop', { operation_id: 'sdk-preparing-stop' })
  assert.equal((await terminal(fx.rpc, 'sdk-preparing-stop')).status, 'stopped')
  assert.deepEqual(JSON.parse(readFileSync(join(instance, 'instance.json'), 'utf8')), old)
  assert.equal(existsSync(join(fx.root, 'downs')), false)
})

test('超过1MiB的最终响应不会因分块读取丢失完成回执', async t => {
  const fx = fixture(t)
  writeFileSync(fx.cli, readFileSync(fx.cli, 'utf8').replace("'final_response':'SDK调用完成'", "'final_response':('x'*(2*1024*1024))"))
  await fx.rpc('start', request('sdk-large-response'))
  const done = await terminal(fx.rpc, 'sdk-large-response')
  assert.equal(done.status, 'completed'); assert.equal(done.final_response.length, 2 * 1024 * 1024)
})
