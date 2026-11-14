import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

async function loadModule() {
  const temp = mkdtempSync(join(tmpdir(), 'harness-platform-instances-build-'))
  const outfile = join(temp, 'instances.mjs')
  symlinkSync(new URL('../node_modules', import.meta.url), join(temp, 'node_modules'), 'dir')
  await build({
    entryPoints: ['src/instances/index.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  })
  const module = await import(`file://${outfile}?${Date.now()}`)
  return { module, cleanup: () => rmSync(temp, { recursive: true, force: true }) }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-platform-instances-'))
  process.env.HARNESS_PROGRAM_ROOT = root
  const state = join(root, 'state')
  const adapter = join(root, 'runtime/adapters/dsh-container')
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true, agents: [], gateway: {
    host: '127.0.0.1', port: 53105, publicOrigin: 'http://business.example:53105',
    sharedSecretFile: '.local/credentials/business-shared.key', instances: [],
  } }))
  mkdirSync(adapter, { recursive: true })
  mkdirSync(join(state, 'dsh-dev/running-one'), { recursive: true })
  mkdirSync(join(state, 'dsh-dev/unknown-one'), { recursive: true })
  mkdirSync(join(root, 'evolution/experiments/EXP-real-agent-001/runs/run-00000000-0000-4000-8000-000000000000'), { recursive: true })
  const expRoot = join(root, 'evolution/experiments/EXP-real-agent-001')
  writeFileSync(join(expRoot, 'change.yaml'), 'experiment_id: EXP-real-agent-001\nagent_id: real-agent\n')
  mkdirSync(join(expRoot, 'candidate'), { recursive: true })
  writeFileSync(join(expRoot, 'candidate/harness.yaml'), 'loadable_assets:\n  workspace: dsh/workspace\n  preset_root: dsh/presets\n  managed_root: dsh/managed\n  preset_id: real-agent\n  profile_patch: dsh/managed/real.patch.yml\n')
  writeFileSync(join(adapter, 'sources.json'), JSON.stringify({
    schema_version: '1.1',
    sources: { 'EXP-real-agent-001': { agent_id: 'real-agent' } },
  }))
  writeFileSync(join(state, 'dsh-dev/running-one/instance.json'), JSON.stringify({
    name: 'running-one',
    source_id: 'experiment:EXP-real-agent-001',
    image_tag: 'dsh:locked',
    port: 3181,
  }))
  writeFileSync(join(state, 'dsh-dev/unknown-one/instance.json'), JSON.stringify({
    name: 'unknown-one',
    source_id: 'experiment:EXP-real-agent-001',
    image_tag: 'dsh:locked',
    port: 3182,
  }))
  writeFileSync(join(adapter, 'dsh-dev-fixture.cjs'), `#!/usr/bin/env node
const args = process.argv.slice(2)
require('node:fs').appendFileSync(require('node:path').join(__dirname, 'dsh-dev.calls'), JSON.stringify(args) + '\\n')
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\\n')
if (args[0] === 'ps') {
  const statesFile = require('node:path').join(__dirname,'observed-states.json')
  const observedStates = require('node:fs').existsSync(statesFile) ? JSON.parse(require('node:fs').readFileSync(statesFile)) : {}
  const stateRoot = process.env.HARNESS_INSTANCE_STATE_ROOT || (process.env.XDG_STATE_HOME ? require('node:path').join(process.env.XDG_STATE_HOME, 'dsh-dev') : require('node:path').join(process.env.HARNESS_ASSET_ROOT, '.local/instances'))
  const newBusinessFile = require('node:path').join(stateRoot, 'new-business', 'instance.json')
  const newManifest = require('node:fs').existsSync(newBusinessFile) ? JSON.parse(require('node:fs').readFileSync(newBusinessFile)) : null
  const newBusiness = require('node:fs').existsSync(newBusinessFile)
    ? [{name:'new-business', state:require('node:fs').existsSync(require('node:path').join(__dirname,'startup-failed'))?'absent':'running', source_id:'experiment:EXP-real-agent-001', agent_id:'real-agent', port:3199, business_gateway:true,access_mode:newManifest.business_control.access_mode,identity_mode:newManifest.business_control.identity_mode}]
    : []
  out({schema_version:'1.0', instances:[
    {name:'running-one', state:observedStates['running-one']??'running', source_id:'experiment:EXP-real-agent-001', source_kind:'experiment', image_tag:'dsh:locked', agent_id:'real-agent', port:3181, home_volume:'home-running', home_preserved:true, container_name:'running-one', observed_at:'2026-10-13T00:00:00.000Z', mounts:{workspace:'/x'}, mount_modes:{workspace:'ro'}},
    {name:'unknown-one', state:'unknown', source_id:'experiment:EXP-real-agent-001', image_tag:'dsh:locked', agent_id:'real-agent', port:3182, home_volume:null, home_preserved:null, container_name:'unknown-one', observed_at:'2026-10-13T00:00:00.000Z'},
    {name:'absent-one', state:'absent', source_id:'experiment:EXP-real-agent-001', home_volume:'home-absent', home_preserved:true},
    ...newBusiness
  ]})
} else if (args[0] === 'reload') {
  const fs = require('node:fs'), path = require('node:path'), name = args[1]
  const states = path.join(__dirname, 'observed-states.json')
  if (fs.existsSync(states) && JSON.parse(fs.readFileSync(states))[name] === 'stopped') {
    process.stderr.write('已停止的实例不能重载'); process.exit(1)
  }
  const source_id = 'experiment:EXP-real-agent-001'
  const asset = 'sha256:' + (fs.existsSync(path.join(__dirname, 'next-source-digest')) ? 'c' : 'a').repeat(64)
  const generation = 'sha256:' + (fs.existsSync(path.join(__dirname, 'next-generation')) ? 'd' : 'b').repeat(64)
  if (args.includes('--dry-run')) out({name, source_id, current_asset_digest:asset, generation_digest:generation, port:3181})
  else {
    if (args[args.indexOf('--expected-asset-digest')+1] !== asset || args[args.indexOf('--expected-generation-digest')+1] !== generation) {
      process.stderr.write('资产来源或运行代次已变化，请重新预览'); process.exit(1)
    }
    if (name === 'fail-one') { process.stderr.write('实际加载尚未核验'); process.exit(1) }
    out({name, asset_status:{status:fs.existsSync(path.join(__dirname, 'bad-load-receipt'))?'unknown':'current', current_digest:asset,
      loaded:{digest:asset, verification:'runtime-observer', container_id:'container-current', started_at:'new-process', loaded_at:'2026-11-04T00:00:00Z'}}})
  }
} else if (args[0] === 'up') {
  const dry = args.includes('--dry-run')
  const sourceDigest = require('node:fs').existsSync(require('node:path').join(__dirname, 'next-source-digest')) ? 'sha256:' + 'c'.repeat(64) : 'sha256:' + 'a'.repeat(64)
  const business = args.includes('--business-control')
  const name = args[args.indexOf('--name') + 1]
  const source = args[args.indexOf('--source') + 1]
  if (name === 'invalid-assets') { process.stderr.write('dsh-dev failed: ' + JSON.stringify({code:'candidate_assets_invalid',message:'Candidate 装载资产不完整或不安全',stage:'candidate-assets',path:'dsh/workspace/.env',reason:'文件缺失',next_action:'修复来源 Candidate 后重新预览；不会自动重试创建实例'})); process.exit(1) }
  if (dry) out({args, name, source_id:source, image_tag:'dsh:locked', port:3199, mounts:[{container:'/work/harness/workspace', mode:'ro'}], state_dir:'state', ...(business ? { business_control: { source_digest: sourceDigest } } : {})})
  else {
    const delay = require('node:path').join(__dirname, 'delay-start')
    if (require('node:fs').existsSync(delay)) {
      require('node:fs').writeFileSync(delay + '.started', 'started')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
    if (business) {
      const stateRoot = process.env.HARNESS_INSTANCE_STATE_ROOT || (process.env.XDG_STATE_HOME ? require('node:path').join(process.env.XDG_STATE_HOME, 'dsh-dev') : require('node:path').join(process.env.HARNESS_ASSET_ROOT, '.local/instances'))
      const file = require('node:path').join(stateRoot, name, 'instance.json')
      const prior = require('node:fs').existsSync(file) ? JSON.parse(require('node:fs').readFileSync(file)).business_control : {}
      const accessMode = args.includes('--business-access-mode') ? args[args.indexOf('--business-access-mode')+1] : prior.access_mode || 'authenticated'
      const identityMode = args.includes('--business-identity-mode') ? args[args.indexOf('--business-identity-mode')+1] : prior.identity_mode || 'published'
      require('node:fs').mkdirSync(require('node:path').dirname(file), {recursive:true})
      require('node:fs').writeFileSync(file, JSON.stringify({name, source_id:source, agent_id:'real-agent', asset_root:process.env.HARNESS_ASSET_ROOT, port:3199, web_base_path:'/agents/real-agent/instances/' + name + '/', business_control:{source_digest:sourceDigest, runtime_generation:'generation-new', origin:'http://127.0.0.1:3199',access_mode:accessMode,identity_mode:identityMode,launch_config_file:args[args.indexOf('--business-control')+1]}}))
      const accessFile = require('node:path').join(process.env.HARNESS_ASSET_ROOT, 'config/business-access.json')
      const registered = JSON.parse(require('node:fs').readFileSync(accessFile)).gateway.instances.find(item => item.instanceId === name)
      const register = () => require('node:child_process').execFileSync(process.execPath, ['--experimental-strip-types', ${JSON.stringify(new URL('../../../runtime/adapters/dsh-container/business.ts', import.meta.url).pathname)}, '--register', process.env.HARNESS_ASSET_ROOT, name, registered?.sourceDigest || prior.source_digest || ''], {stdio:['ignore','pipe','pipe']})
      const failure = require('node:path').join(__dirname,'fail-next-start'), failed = require('node:path').join(__dirname,'startup-failed')
      if(require('node:fs').existsSync(failure)){require('node:fs').unlinkSync(failure);require('node:fs').writeFileSync(failed,'network unavailable');if(prior.source_digest) register();process.stderr.write('network unavailable');process.exit(1)}
      register()
      require('node:fs').rmSync(failed,{force:true})
    }
    process.stdout.write(JSON.stringify({warning:'first'}) + '\\n' + JSON.stringify({name, dsh_running:true, token:'receipt-secret'}) + '\\n'); process.stderr.write(JSON.stringify({hint:'not a receipt'}) + '\\n') }
} else if (args[0] === 'down') {
  const name = args[1]
  if (name === 'fail-one') { process.stderr.write('stop failed token=secret-token\\n'); process.exit(1) }
  out({name, stopped:true, home_preserved:true})
} else if (args[0] === 'delete') {
  if (['fail-one', 'batch-083'].includes(args[1])) { process.stderr.write('停止实例失败，未执行删除\\n'); process.exit(1) }
  if (args[1] === 'unknown-one') {
    process.stderr.write('实例当前状态无法确认，拒绝停止和删除\\n'); process.exit(1)
  }
  const fs = require('node:fs'), path = require('node:path')
  if (fs.existsSync(path.join(__dirname, 'delay-delete'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  const stateRoot = process.env.HARNESS_INSTANCE_STATE_ROOT || (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'dsh-dev') : path.join(process.env.HARNESS_ASSET_ROOT, '.local/instances'))
  fs.rmSync(path.join(stateRoot, args[1], 'instance.json'), {force:true})
  if (fs.existsSync(path.join(__dirname, 'fail-gateway-commit'))) {
    const access = path.join(process.env.HARNESS_ASSET_ROOT, 'config/business-access.json')
    fs.renameSync(access, access + '.saved'); fs.mkdirSync(access)
  }
  out({name:args[1], deleted:true, home_preserved:true})
} else if (args[0] === 'url') {
  if (!['running-one', 'new-business'].includes(args[1])) { process.stderr.write('实例没有运行中的容器'); process.exit(1) }
  const manifest = JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.XDG_STATE_HOME, 'dsh-dev', args[1], 'instance.json')))
  const entry = manifest.business_control ? JSON.parse(require('node:fs').readFileSync(require('node:path').join(process.env.HARNESS_ASSET_ROOT, 'config/business-access.json'))).gateway.publicOrigin + '/agents/' + manifest.agent_id + '/instances/' + args[1] + '/' : ''
  process.stdout.write(manifest.url_override || entry || ('http://127.0.0.1:' + manifest.port + (manifest.unsafe_no_auth ? '/' : '/?token=transient-test-token')))
} else if (args[0] === 'logs') {
  process.stdout.write('hello token=secret-token Authorization: Bearer bearer-secret {"password":"json-secret"} API_KEY=abc123\\n')
} else {
  process.stderr.write('unknown command ' + args.join(' '))
  process.exit(2)
}
`)
  writeFileSync(join(adapter, 'dsh-dev'), `#!/usr/bin/env python3
import json,os,sys,subprocess
from pathlib import Path
node = ${JSON.stringify(process.execPath)}
script = ${JSON.stringify(join(adapter, 'dsh-dev-fixture.cjs'))}
def load_instance(name):
    state = Path(os.environ['HARNESS_INSTANCE_STATE_ROOT']) if os.environ.get('HARNESS_INSTANCE_STATE_ROOT') else Path(os.environ['XDG_STATE_HOME']) / 'dsh-dev' if os.environ.get('XDG_STATE_HOME') else Path(os.environ['HARNESS_ASSET_ROOT']) / '.local/instances'
    path = state / name / 'instance.json'
    return path.parent, json.loads(path.read_text())
def delete_instance(name, manifest):
    return json.loads(subprocess.check_output([node, script, 'delete', name], text=True))
if __name__ == '__main__':
    os.execv(node, [node, script, *sys.argv[1:]])
`)
  chmodSync(join(adapter, 'dsh-dev'), 0o755)
  return { root, state, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('实例查询接受已有大型装载回执，进程失败不把 stdout 文件清单当错误说明', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const script = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev-fixture.cjs')
  writeFileSync(script, `process.stdout.write(JSON.stringify({instances:[{name:'large-instance',state:'running',asset_status:{loaded:{source_files:Array(20000).fill({path:'dependency.js',sha256:'a'.repeat(64)})}}}]}))`)
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const listed = await handler('list', {}, signal)
  assert.equal(listed.ok, true, JSON.stringify(listed.error))
  assert.equal(listed.value.instances[0].asset_status.loaded.source_files.length, 20000)
  writeFileSync(script, `process.stdout.write('FILE_LIST_SHOULD_NOT_BE_AN_ERROR'.repeat(50000));process.exitCode=2`)
  const failed = await handler('list', {}, signal)
  assert.equal(failed.ok, false)
  assert.doesNotMatch(failed.error.message, /FILE_LIST_SHOULD_NOT_BE_AN_ERROR/)
})

test('重载由同一 CLI 执行并冻结来源与代次；停止、冲突、未知回执和批量失败如实返回', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous })
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const adapter = join(fx.root, 'runtime/adapters/dsh-container')
  const preview = await handler('preview', { operation: 'reload', name: 'running-one' }, signal)
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const request = { operation: 'reload', name: 'running-one', expected_source_id: preview.value.plan.source_id,
    expected_asset_digest: preview.value.plan.current_asset_digest, expected_generation_digest: preview.value.plan.generation_digest }
  const missing = await handler('run', { operation: 'reload', name: 'running-one' }, signal)
  assert.equal(missing.value.ok, false)
  for (const field of ['port', 'model_selection', 'source', 'business_control', 'access_mode', 'identity_mode']) {
    const override = await handler('run', { ...request, [field]: { port: 33000, model_selection: { provider: 'p', model: 'm' }, source: 'experiment:EXP-real-agent-001', business_control: false, access_mode: 'anonymous', identity_mode: 'development' }[field] }, signal)
    assert.equal(override.ok, false, field)
  }
  for (const marker of ['next-source-digest', 'next-generation']) {
    writeFileSync(join(adapter, marker), 'changed')
    const result = await handler('run', request, signal)
    assert.equal(result.value.ok, false)
    assert.match(result.value.error.message, /变化/)
    rmSync(join(adapter, marker))
  }
  writeFileSync(join(adapter, 'observed-states.json'), JSON.stringify({ 'running-one': 'stopped' }))
  const stopped = await handler('run', request, signal)
  assert.equal(stopped.value.ok, false)
  assert.match(stopped.value.error.message, /已停止/)
  rmSync(join(adapter, 'observed-states.json'))
  writeFileSync(join(adapter, 'bad-load-receipt'), 'unknown')
  assert.equal((await handler('run', request, signal)).value.ok, false)
  rmSync(join(adapter, 'bad-load-receipt'))
  const succeeded = await handler('run', { ...request, apply_source_mcp: true }, signal)
  assert.equal(succeeded.value.ok, true, JSON.stringify(succeeded))
  assert.equal(succeeded.value.value.value.asset_status.loaded.verification, 'runtime-observer')
  mkdirSync(join(fx.state, 'dsh-dev/fail-one'))
  writeFileSync(join(fx.state, 'dsh-dev/fail-one/instance.json'), readFileSync(join(fx.state, 'dsh-dev/running-one/instance.json')))
  const batch = await handler('batch', { items: [request, { ...request, name: 'fail-one' }] }, signal)
  assert.equal(batch.value.partial_success, true)
  assert.deepEqual(batch.value.receipts.map(item => item.ok), [true, false])
  const calls = readFileSync(join(adapter, 'dsh-dev.calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const writes = calls.filter(args => args[0] === 'reload' && !args.includes('--dry-run'))
  assert.equal(writes.length, 7)
  assert.ok(writes.some(args => args.includes('--apply-source-mcp')))
  const invalidSync = await handler('preview', { operation: 'start', name: 'running-one', apply_source_mcp: true }, signal)
  assert.equal(invalidSync.ok, false)
  assert.ok(writes.every(args => !args.includes('--port') && !args.includes('--source') && args.includes('--expected-generation-digest')))
  assert.equal(calls.some(args => args[0] === 'up' || args[0] === 'down'), false)
})

test('instances list keeps real observed state and detail run/session links', async () => {
  const { module, cleanup: cleanupModule } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  try {
    const handler = module.createInstancesHandler(fx.root)
    const listed = await handler('list', {}, new AbortController().signal)
    assert.equal(listed.ok, true)
    assert.equal(listed.value.instances[0].state, 'running')
    assert.equal(listed.value.instances[1].state, 'unknown')
    assert.equal(listed.value.instances[2].state, 'absent')
    assert.equal(listed.value.instances[2].home_preserved, true)
    assert.equal(listed.value.instances[0].home_volume, 'home-running')
    const detail = await handler('detail', { name: 'running-one' }, new AbortController().signal)
    assert.equal(detail.ok, true)
    assert.equal(detail.value.runs.length, 1)
    assert.equal(detail.value.session_scope.note.includes('不读取会话内容'), true)
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    fx.cleanup()
    cleanupModule()
  }
})

test('直接地址和操作预览在调用 CLI 前拒绝其它工作区的实例登记', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    fx.cleanup()
    cleanup()
  })
  writeFileSync(join(fx.root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: 'workspace-selected' }))
  writeFileSync(join(fx.state, 'dsh-dev/running-one/instance.json'), JSON.stringify({ name: 'running-one', workspace_id: 'workspace-other', asset_root: fx.root, port: 3181 }))
  const handler = module.createInstancesHandler(fx.root)
  for (const [endpoint, payload] of [['url', { name: 'running-one' }], ['preview', { operation: 'stop', name: 'running-one' }]]) {
    const result = await handler(endpoint, payload, new AbortController().signal)
    assert.equal(result.ok, false)
    assert.match(result.error.message, /不属于当前工作区/)
  }
  assert.throws(() => readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')), /ENOENT/)
})

test('读取与停止共用平台状态词表，SDK完成态可原样确认，未知和原始Docker状态不被误认', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous })
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const statesFile = join(fx.root, 'runtime/adapters/dsh-container/observed-states.json')
  for (const state of ['running', 'stopped', 'completed', 'failed', 'absent']) {
    writeFileSync(statesFile, JSON.stringify({ 'running-one': state }))
    const preview = await handler('preview', { operation: 'stop', name: 'running-one' }, signal)
    assert.equal(preview.value.observed_state, state)
    const stopped = await handler('run', { operation: 'stop', name: 'running-one', expected_source_id: preview.value.source_id, expected_state: preview.value.observed_state }, signal)
    assert.equal(stopped.value.ok, true, `${state}: ${JSON.stringify(stopped)}`)
  }
  const callsFile = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  const downCount = () => readFileSync(callsFile, 'utf8').split('\n').filter(line => line.includes('"down"')).length
  for (const state of ['created', 'exited', 'restarting', 'paused', 'dead', 'removing', 'unknown', 'unexpected', '', null]) {
    writeFileSync(statesFile, JSON.stringify({ 'running-one': state ?? 'unknown' }))
    const listed = await handler('list', {}, signal)
    assert.equal(listed.value.instances.find(row => row.name === 'running-one').state, 'unknown')
    const preview = await handler('preview', { operation: 'stop', name: 'running-one' }, signal)
    assert.equal(preview.ok, false)
    assert.match(preview.error.message, /状态.*(?:未知|无法确认)/)
    const before = downCount()
    const rejected = await handler('run', { operation: 'stop', name: 'running-one', expected_state: state }, signal)
    assert.equal(rejected.ok, false, `${state}: ${JSON.stringify(rejected)}`)
    assert.equal(downCount(), before)
  }
})

test('确认实例操作沿用预览来源，来源被替换时在任何CLI调用前拒绝', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const handler = module.createInstancesHandler(fx.root)
  const signal = new AbortController().signal
  const preview = await handler('preview', { operation: 'stop', name: 'running-one' }, signal)
  assert.equal(preview.ok, true)
  assert.equal(preview.value.observed_state, 'running')
  assert.match(preview.value.observed_at, /^\d{4}-\d\d-\d\dT/)
  const callsFile = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  const beforeStateChange = readFileSync(callsFile, 'utf8')
  const stateChanged = await handler('run', { operation: 'stop', name: 'running-one', expected_source_id: 'experiment:EXP-real-agent-001', expected_state: 'stopped' }, signal)
  assert.equal(stateChanged.value.ok, false)
  assert.match(stateChanged.value.error.message, /实例状态已变化/)
  assert.equal(readFileSync(callsFile, 'utf8').split('\n').filter(line => line.includes('"down"')).length, beforeStateChange.split('\n').filter(line => line.includes('"down"')).length)
  const same = await handler('run', { operation: 'stop', name: 'running-one', expected_source_id: 'experiment:EXP-real-agent-001' }, signal)
  assert.equal(same.ok, true)
  assert.equal(same.value.ok, true)
  const before = readFileSync(callsFile, 'utf8')
  const manifest = join(fx.state, 'dsh-dev/running-one/instance.json')
  writeFileSync(manifest, JSON.stringify({ name: 'running-one', source_id: 'experiment:EXP-another-001', port: 3181 }))
  const changed = await handler('run', { operation: 'restart', name: 'running-one', expected_source_id: 'experiment:EXP-real-agent-001' }, signal)
  assert.equal(changed.value.ok, false)
  assert.match(changed.value.error.message, /实例来源已变化/)
  assert.equal(readFileSync(callsFile, 'utf8'), before, '拒绝后不得停止或重新创建其他来源的实例')
})

test('Web 入口按需读取 CLI 当前链接，保留认证并拒绝非实例地址', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const handler = module.createInstancesHandler(fx.root)
  const path = join(fx.state, 'dsh-dev/running-one/instance.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const request = () => handler('url', { name: 'running-one' }, new AbortController().signal)
  const local = await request()
  assert.equal(local.ok, true)
  assert.equal(new URL(local.value.url).searchParams.get('token'), 'transient-test-token')
  assert.equal(local.value.lan_access, false)
  writeFileSync(path, JSON.stringify({ ...manifest, lan_access: true, unsafe_no_auth: true }))
  assert.deepEqual((await request()).value, { url: 'http://127.0.0.1:3181/', lan_access: true })
  for (const url_override of ['http://example.org:3181/', 'javascript:alert(1)', 'http://127.0.0.1:3182/', 'http://user:password@127.0.0.1:3181/']) {
    writeFileSync(path, JSON.stringify({ ...manifest, url_override }))
    assert.equal((await request()).ok, false)
  }
  for (const name of ['unknown-one', 'missing-one', '../running-one']) assert.equal((await handler('url', { name }, new AbortController().signal)).ok, false)
  const calls = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(calls.every(args => args[0] === 'url' && args[2] === '--non-interactive'))
})

test('业务实例 Web 入口使用已登记网关地址并拒绝地址漂移', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const manifestPath = join(fx.state, 'dsh-dev/running-one/instance.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const accessPath = join(fx.root, 'config/business-access.json')
  mkdirSync(join(fx.root, 'config'), { recursive: true })
  const access = { enabled: true, gateway: { publicOrigin: 'http://business.example:53105', instances: [{ agentId: 'real-agent', instanceId: 'running-one' }] } }
  const entry = 'http://business.example:53105/agents/real-agent/instances/running-one/'
  writeFileSync(accessPath, JSON.stringify(access))
  const businessManifest = { ...manifest, agent_id: 'real-agent', web_base_path: '/agents/real-agent/instances/running-one/', business_control: { runtime_generation: 'current', source_digest: 'sha256:' + 'a'.repeat(64), origin: 'http://127.0.0.1:3181' }, url_override: entry }
  writeFileSync(manifestPath, JSON.stringify(businessManifest))
  const request = () => module.createInstancesHandler(fx.root)('url', { name: 'running-one' }, new AbortController().signal)
  assert.deepEqual((await request()).value, { url: entry, lan_access: false })
  for (const url_override of [
    'http://127.0.0.1:3181/',
    'http://other.example:53105/agents/real-agent/instances/running-one/',
    'http://business.example:53106/agents/real-agent/instances/running-one/',
    'http://business.example:53105/agents/real-agent/',
    'http://business.example:53105/agents/other-agent/',
    `${entry}?token=unexpected`,
  ]) {
    writeFileSync(manifestPath, JSON.stringify({ ...businessManifest, url_override }))
    const result = await request()
    assert.equal(result.ok, false, url_override)
    assert.match(result.error.message, /业务网关地址与登记入口不一致/)
  }
  writeFileSync(manifestPath, JSON.stringify(businessManifest))
  writeFileSync(accessPath, JSON.stringify({ ...access, gateway: { ...access.gateway, instances: [{ agentId: 'real-agent', instanceId: 'running-one', sourceId: 'experiment:EXP-real-agent-001', sourceDigest: 'sha256:' + 'b'.repeat(64) }] } }))
  assert.match((await request()).error.message, /来源与网关登记不一致/)
  writeFileSync(accessPath, JSON.stringify({ ...access, gateway: { ...access.gateway, instances: [] } }))
  assert.match((await request()).error.message, /实例未向业务网关开放/)
})

test('实例写入开始后连接中断仍完成启动及网关登记，已取消请求不再写入', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous; cleanup(); fx.cleanup() })
  const handler = module.createInstancesHandler(fx.root), controller = new AbortController()
  const item = { operation: 'create', name: 'new-business', source: 'experiment:EXP-real-agent-001' }
  const preview = await handler('preview', item, controller.signal)
  assert.equal(preview.ok, true)
  const delay = join(fx.root, 'runtime/adapters/dsh-container/delay-start')
  writeFileSync(delay, 'delay until the client disconnects')
  const action = handler('run', { ...item, expected_source_digest: preview.value.plan.business_control.source_digest }, controller.signal)
  const deadline = Date.now() + 10000
  while (!existsSync(delay + '.started') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(existsSync(delay + '.started'), true)
  controller.abort()
  const result = await action
  assert.equal(result.value.ok, true, JSON.stringify(result))
  assert.equal(JSON.parse(readFileSync(join(fx.root, 'config/business-access.json'))).gateway.instances[0].instanceId, item.name)
  const calls = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8')
  assert.equal((await handler('run', item, controller.signal)).ok, false)
  assert.equal(readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8'), calls)
})

for (const [access_mode, identity_mode] of [['anonymous', 'development'], ['authenticated', 'published']]) test(`首次启动失败后沿原模式恢复并保留HOME：${access_mode}/${identity_mode}`, async t => {
  const { module, cleanup } = await loadModule(), fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous; cleanup(); fx.cleanup() })
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const item = { operation: 'create', name: 'new-business', source: 'experiment:EXP-real-agent-001', access_mode, identity_mode }
  const marker = join(fx.root, 'runtime/adapters/dsh-container/fail-next-start')
  writeFileSync(marker, 'simulate Docker failure after state persistence')
  const preview = await handler('preview', item, signal)
  assert.equal(preview.ok, true, JSON.stringify(preview))
  const failed = await handler('run', { ...item, expected_source_id: item.source, expected_source_digest: preview.value.plan.business_control.source_digest }, signal)
  assert.equal(failed.value.ok, false)
  const accessFile = join(fx.root, 'config/business-access.json')
  assert.equal(JSON.parse(readFileSync(accessFile)).gateway.instances.length, 0, '失败不冒充已登记')
  const manifest = JSON.parse(readFileSync(join(fx.state, 'dsh-dev/new-business/instance.json')))
  assert.equal(manifest.business_control.access_mode, access_mode)
  assert.equal(manifest.business_control.identity_mode, identity_mode)
  const listed = await handler('list', {}, signal), pending = listed.value.instances.find(row => row.name === item.name)
  assert.equal(pending.state, 'absent')
  assert.equal(pending.access_mode, access_mode)
  assert.equal(pending.identity_mode, identity_mode)
  const home = join(fx.state, 'dsh-dev/new-business/dsh-home')
  mkdirSync(home); writeFileSync(join(home, 'session.v4.jsonl'), 'retained-session')
  const next = { operation: 'start', name: item.name }, retry = await handler('preview', next, signal)
  assert.equal(retry.value.access_mode, access_mode)
  assert.equal(retry.value.identity_mode, identity_mode)
  const resumed = await handler('run', { ...next, expected_source_id: item.source, expected_source_digest: retry.value.plan.business_control.source_digest }, signal)
  assert.equal(resumed.value.ok, true, JSON.stringify(resumed))
  const registered = JSON.parse(readFileSync(accessFile)).gateway.instances[0]
  assert.equal(registered.accessMode, access_mode)
  assert.equal(registered.identityMode, identity_mode)
  assert.equal(readFileSync(join(home, 'session.v4.jsonl'), 'utf8'), 'retained-session')
})

test('平台省略网关参数仍创建匿名开发网关实例，原子登记来源并沿用入口', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  mkdirSync(join(fx.root, 'config'), { recursive: true })
  const accessPath = join(fx.root, 'config/business-access.json')
  const originalAccess = JSON.parse(readFileSync(accessPath, 'utf8'))
  writeFileSync(accessPath, JSON.stringify({ ...originalAccess, gateway: { ...originalAccess.gateway, managementUrl: 'http://127.0.0.1:18120' } }))
  const handler = module.createInstancesHandler(fx.root)
  const source = 'experiment:EXP-real-agent-001', name = 'new-business'
  const item = { operation: 'create', name, source }
  const signal = new AbortController().signal
  const preview = await handler('preview', item, signal)
  assert.equal(preview.ok, true)
  assert.equal(preview.value.plan.business_control.source_digest, 'sha256:' + 'a'.repeat(64))
  assert.equal(preview.value.access_mode, 'anonymous')
  assert.equal(preview.value.identity_mode, 'development')
  const result = await handler('run', { ...item, expected_source_id: source, expected_source_digest: preview.value.plan.business_control.source_digest }, signal)
  assert.equal(result.value.ok, true, JSON.stringify(result))
  const access = JSON.parse(readFileSync(accessPath, 'utf8'))
  assert.equal(access.gateway.managementUrl, 'http://127.0.0.1:18120')
  assert.deepEqual(access.gateway.instances, [{ agentId: 'real-agent', instanceId: name, sourceId: source, sourceDigest: 'sha256:' + 'a'.repeat(64), accessMode: 'anonymous', identityMode: 'development' }])
  const entryResult = await handler('url', { name }, signal)
  assert.equal(entryResult.ok, true, JSON.stringify(entryResult))
  assert.deepEqual(entryResult.value, { url: 'http://business.example:53105/agents/real-agent/instances/new-business/', lan_access: false })
  const listed = await handler('list', {}, signal)
  assert.equal(listed.ok, true)
  assert.equal(listed.value.instances.find(row => row.name === name)?.access_url, entryResult.value.url)
  assert.equal(listed.value.instances.find(row => row.name === name)?.access_mode, 'anonymous')
  assert.equal(listed.value.instances.find(row => row.name === name)?.identity_mode, 'development')
  const restart = { operation: 'restart', name }
  const restartPreview = await handler('preview', restart, signal)
  assert.equal(restartPreview.ok, true)
  assert.equal(restartPreview.value.access_mode, 'anonymous')
  assert.equal(restartPreview.value.identity_mode, 'development')
  assert.equal((await handler('run', { ...restart, expected_source_id: source, expected_source_digest: restartPreview.value.plan.business_control.source_digest }, signal)).value.ok, true)
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances.length, 1)
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].accessMode, 'anonymous', '同名实例重启保留无需认证方式')
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].identityMode, 'development', '同名实例重启保留开发阶段')
  const staleAccess = JSON.parse(readFileSync(accessPath, 'utf8'))
  staleAccess.gateway.instances[0].sourceDigest = 'sha256:' + 'a'.repeat(64)
  writeFileSync(accessPath, JSON.stringify(staleAccess))
  writeFileSync(join(fx.root, 'runtime/adapters/dsh-container/next-source-digest'), 'changed')
  const refreshed = await handler('preview', restart, signal)
  assert.equal(refreshed.value.plan.business_control.source_digest, 'sha256:' + 'c'.repeat(64))
  const manifestPath = join(fx.state, 'dsh-dev', name, 'instance.json')
  const interrupted = JSON.parse(readFileSync(manifestPath, 'utf8'))
  interrupted.business_control.source_digest = refreshed.value.plan.business_control.source_digest
  interrupted.asset_reload_attempt = { status: 'unknown' }
  writeFileSync(manifestPath, JSON.stringify(interrupted))
  const recovered = await handler('run', { operation: 'start', name, expected_source_id: source,
    expected_source_digest: refreshed.value.plan.business_control.source_digest }, signal)
  assert.equal(recovered.value.ok, true, JSON.stringify(recovered))
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].sourceDigest,
    refreshed.value.plan.business_control.source_digest, '中断重载后的实例清单摘要变化可沿网关旧登记恢复')
  const settled = JSON.parse(readFileSync(manifestPath, 'utf8'))
  settled.asset_reload_attempt = { status: 'verified' }
  writeFileSync(manifestPath, JSON.stringify(settled))
  writeFileSync(join(fx.root, 'runtime/adapters/dsh-container/fail-next-start'), 'network unavailable')
  const failedRestart = await handler('run', { ...restart, expected_source_digest: refreshed.value.plan.business_control.source_digest }, signal)
  assert.equal(failedRestart.value.ok, false)
  assert.match(failedRestart.value.error.message, /network unavailable/)
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].sourceDigest, 'sha256:' + 'c'.repeat(64), '启动失败后来源登记与已保存的实例一致，允许修复后重试')
  assert.equal((await handler('run', { ...restart, expected_source_digest: refreshed.value.plan.business_control.source_digest }, signal)).value.ok, true)
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].sourceDigest, 'sha256:' + 'c'.repeat(64))
  const conflicting = JSON.parse(readFileSync(accessPath, 'utf8'))
  conflicting.gateway.instances[0].sourceDigest = 'sha256:' + 'b'.repeat(64)
  writeFileSync(accessPath, JSON.stringify(conflicting))
  const callsBeforeConflict = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8')
  const rejected = await handler('run', { ...restart, expected_source_id: source, expected_source_digest: refreshed.value.plan.business_control.source_digest }, signal)
  assert.equal(rejected.value.ok, false)
  assert.match(rejected.value.error.message, /业务网关中同名实例的来源、访问方式或实例阶段不一致/)
  const mutatingCalls = value => value.trim().split('\n').map(line => JSON.parse(line))
    .filter(args => args[0] === 'down' || args[0] === 'up' && !args.includes('--dry-run'))
  assert.deepEqual(mutatingCalls(readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8')),
    mutatingCalls(callsBeforeConflict), '已知来源冲突不得执行 --replace 或 down')
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].sourceDigest, 'sha256:' + 'b'.repeat(64))
  const calls = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(calls.filter(args => args[0] === 'up').every(args => args[args.indexOf('--business-control') + 1] === accessPath))
  assert.ok(calls.filter(args => args[0] === 'up' && args.includes('--business-access-mode')).every(args =>
    args[args.indexOf('--business-access-mode') + 1] === 'anonymous' && args[args.indexOf('--business-identity-mode') + 1] === 'development'))
  assert.ok(calls.filter(args => args.includes('--replace')).every(args => !args.includes('--business-access-mode') && !args.includes('--business-identity-mode')))
  assert.ok(calls.some(args => args[0] === 'up' && args.includes('--replace') && args.includes('--port') && args[args.indexOf('--port') + 1] === '3199'))
  assert.ok(!calls.some(args => args[0] === 'down' && args[1] === name))
})

test('受控实例在网关关闭后仍可删除对应登记，来源冲突则在 CLI 前拒绝', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const sourceDigest = 'sha256:' + 'a'.repeat(64)
  const sourceId = 'experiment:EXP-real-agent-001'
  const instance = name => ({ name, agent_id: 'real-agent', source_id: sourceId, business_control: { source_digest: sourceDigest } })
  const row = name => ({ agentId: 'real-agent', instanceId: name, sourceId, sourceDigest })
  for (const name of ['stopped-business', 'conflict-business']) {
    mkdirSync(join(fx.state, 'dsh-dev', name), { recursive: true })
    writeFileSync(join(fx.state, 'dsh-dev', name, 'instance.json'), JSON.stringify(instance(name)))
  }
  mkdirSync(join(fx.root, 'config'), { recursive: true })
  const accessPath = join(fx.root, 'config/business-access.json')
  writeFileSync(accessPath, JSON.stringify({ schemaVersion: 1, enabled: false, gateway: { instances: [row('stopped-business'),
    { ...row('conflict-business'), sourceDigest: 'sha256:' + 'b'.repeat(64) }] } }))
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const deleted = await handler('run', { operation: 'delete', name: 'stopped-business' }, signal)
  assert.equal(deleted.value.ok, true, JSON.stringify(deleted))
  assert.deepEqual(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances.map(item => item.instanceId), ['conflict-business'])
  const callsPath = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  const callsBeforeConflict = readFileSync(callsPath, 'utf8')
  const rejected = await handler('run', { operation: 'delete', name: 'conflict-business' }, signal)
  assert.equal(rejected.value.ok, false)
  assert.match(rejected.value.error.message, /业务网关中同名实例的来源、访问方式或实例阶段不一致/)
  assert.equal(readFileSync(callsPath, 'utf8'), callsBeforeConflict)
})

test('五路删除等待共享网关锁，串行提交并保留其它登记、配置及 HOME', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous })
  const accessPath = join(fx.root, 'config/business-access.json'), callsPath = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  const sourceId = 'experiment:EXP-real-agent-001', sourceDigest = 'sha256:' + 'a'.repeat(64)
  const names = Array.from({ length: 5 }, (_, index) => `delete-${index}`)
  const config = JSON.parse(readFileSync(accessPath, 'utf8'))
  const other = { agentId: 'other-agent', instanceId: 'keep-business', sourceId: 'experiment:keep', sourceDigest }
  config.gateway.instances = [...names.map(instanceId => ({ agentId: 'real-agent', instanceId, sourceId, sourceDigest })), other]
  config.gateway.externalInstances = [{ instanceId: 'keep-external' }]
  for (const name of names) {
    const directory = join(fx.state, 'dsh-dev', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'instance.json'), JSON.stringify({ name, agent_id: 'real-agent', source_id: sourceId, business_control: { source_digest: sourceDigest } }))
    writeFileSync(join(directory, 'home-marker'), 'retained')
  }
  writeFileSync(accessPath, JSON.stringify(config))
  writeFileSync(`${accessPath}.lock`, 'another writer')
  writeFileSync(join(fx.root, 'runtime/adapters/dsh-container/delay-delete'), '')
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const pending = Promise.all(names.map(name => handler('run', { operation: 'delete', name, expected_source_id: sourceId }, signal)))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(existsSync(callsPath), false, '拿到配置锁前不得调用 DSH 删除')
  assert.ok(names.every(name => existsSync(join(fx.state, 'dsh-dev', name, 'instance.json'))))
  rmSync(`${accessPath}.lock`)
  const results = await pending
  assert.ok(results.every(result => result.value.ok), JSON.stringify(results))
  assert.deepEqual(JSON.parse(readFileSync(accessPath, 'utf8')), { ...config, gateway: { ...config.gateway, instances: [other] } })
  for (const name of names) {
    assert.equal(existsSync(join(fx.state, 'dsh-dev', name, 'instance.json')), false)
    assert.equal(readFileSync(join(fx.state, 'dsh-dev', name, 'home-marker'), 'utf8'), 'retained')
  }
  assert.equal(existsSync(`${accessPath}.lock`), false)
})

test('等待网关锁时可取消，锁内重新读取来源，非锁冲突错误不误报为忙碌', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous })
  const name = 'stopped-business', sourceId = 'experiment:EXP-real-agent-001', sourceDigest = 'sha256:' + 'a'.repeat(64)
  const directory = join(fx.state, 'dsh-dev', name), accessPath = join(fx.root, 'config/business-access.json')
  const callsPath = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'instance.json'), JSON.stringify({ name, agent_id: 'real-agent', source_id: sourceId, business_control: { source_digest: sourceDigest } }))
  const config = JSON.parse(readFileSync(accessPath, 'utf8'))
  config.gateway.instances = [{ agentId: 'real-agent', instanceId: name, sourceId, sourceDigest }]
  writeFileSync(accessPath, JSON.stringify(config))
  writeFileSync(`${accessPath}.lock`, 'another writer')
  const handler = module.createInstancesHandler(fx.root), controller = new AbortController()
  const canceled = handler('run', { operation: 'delete', name }, controller.signal)
  setTimeout(() => controller.abort(), 75)
  assert.equal((await canceled).value.ok, false)
  assert.equal(existsSync(`${accessPath}.lock`), true, '不得移除其它写入者的锁')
  const waiting = handler('run', { operation: 'delete', name }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 75))
  config.gateway.instances[0].sourceDigest = 'sha256:' + 'b'.repeat(64)
  writeFileSync(accessPath, JSON.stringify(config))
  rmSync(`${accessPath}.lock`)
  const conflict = await waiting
  assert.match(conflict.value.error.message, /同名实例的来源/)
  rmSync(join(fx.root, 'config'), { recursive: true })
  const missing = await handler('run', { operation: 'delete', name }, new AbortController().signal)
  assert.match(missing.value.error.message, /ENOENT/)
  assert.doesNotMatch(missing.value.error.message, /正在更新|持续被占用/)
  assert.equal(existsSync(callsPath), false)
  assert.equal(existsSync(join(directory, 'instance.json')), true)
})

test('DSH 删除失败不提交网关配置，网关提交失败则保留实例登记供重试', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous })
  const sourceId = 'experiment:EXP-real-agent-001', sourceDigest = 'sha256:' + 'a'.repeat(64)
  const accessPath = join(fx.root, 'config/business-access.json'), adapter = join(fx.root, 'runtime/adapters/dsh-container')
  const config = JSON.parse(readFileSync(accessPath, 'utf8'))
  config.gateway.instances = ['fail-one', 'stopped-business'].map(instanceId => ({ agentId: 'real-agent', instanceId, sourceId, sourceDigest }))
  for (const row of config.gateway.instances) {
    const directory = join(fx.state, 'dsh-dev', row.instanceId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'instance.json'), JSON.stringify({ name: row.instanceId, agent_id: 'real-agent', source_id: sourceId, business_control: { source_digest: sourceDigest } }))
  }
  writeFileSync(accessPath, JSON.stringify(config))
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const rejected = await handler('run', { operation: 'delete', name: 'fail-one' }, signal)
  assert.equal(rejected.value.ok, false)
  assert.deepEqual(JSON.parse(readFileSync(accessPath, 'utf8')), config)
  const manifestPath = join(fx.state, 'dsh-dev/stopped-business/instance.json'), manifest = readFileSync(manifestPath, 'utf8')
  writeFileSync(join(adapter, 'fail-gateway-commit'), '')
  const failed = await handler('run', { operation: 'delete', name: 'stopped-business' }, signal)
  assert.equal(failed.value.ok, false)
  assert.match(failed.value.error.message, /实例登记已保留.*重试删除/)
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), JSON.parse(manifest))
  rmSync(accessPath, { recursive: true })
  renameSync(`${accessPath}.saved`, accessPath)
  rmSync(join(adapter, 'fail-gateway-commit'))
  const retried = await handler('run', { operation: 'delete', name: 'stopped-business', expected_source_id: sourceId }, signal)
  assert.equal(retried.value.ok, true, JSON.stringify(retried))
  assert.deepEqual(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances.map(row => row.instanceId), ['fail-one'])
  assert.equal(existsSync(manifestPath), false)
  assert.equal(existsSync(`${accessPath}.lock`), false)
})

test('preview uses real sources and rejects invented sources', async () => {
  const { module, cleanup: cleanupModule } = await loadModule()
  const fx = fixture()
  try {
    const handler = module.createInstancesHandler(fx.root)
    const bad = await handler('preview', {
      operation: 'create',
      name: 'stage1-new',
      source: 'experiment:EXP-missing-001',
    }, new AbortController().signal)
    assert.equal(bad.ok, false)
    const good = await handler('preview', {
      operation: 'create',
      name: 'stage1-new',
      source: 'experiment:EXP-real-agent-001',
      expected_source_digest: 'sha256:' + 'a'.repeat(64),
    }, new AbortController().signal)
    assert.equal(good.ok, true)
    assert.equal(good.value.plan.source_id, 'experiment:EXP-real-agent-001')
    assert.equal(good.value.retention.home, '保留')
  } finally {
    fx.cleanup()
    cleanupModule()
  }
})

test('workspace-write requires a declared project workspace and exposes the capability', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous })
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const denied = await handler('preview', {
    operation: 'start', name: 'running-one', workspace_mode: 'workspace-write',
  }, signal)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'workspace_write_unavailable')
  assert.equal(denied.error.details?.workspace_mode, 'read-only')

  const candidate = join(fx.root, 'evolution/experiments/EXP-real-agent-001/candidate/harness.yaml')
  writeFileSync(candidate, readFileSync(candidate, 'utf8') + '\nproject_workspace:\n  path: dsh/workspace/project\n')
  const preview = await handler('preview', {
    operation: 'create', name: 'new-one', source: 'experiment:EXP-real-agent-001', workspace_mode: 'workspace-write',
  }, signal)
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.deepEqual(preview.value.workspace_capability, {
    workspace_mode: 'workspace-write', permission_mode: 'workspace-write', project_workspace_path: 'dsh/workspace/project',
  })
})

test('来源候选逐版本解析，个别声明缺失不阻塞其他条目', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const handler = module.createInstancesHandler(fx.root)
  const harness = join(fx.root, 'evolution/experiments/EXP-real-agent-001/candidate/harness.yaml')
  const original = readFileSync(harness, 'utf8')
  writeFileSync(harness, 'name: incomplete\n')
  const missing = await handler('sources', {}, new AbortController().signal)
  assert.equal(missing.ok, true)
  assert.equal(missing.value.sources[0].selectable, false)
  writeFileSync(harness, original)
  const ready = await handler('sources', {}, new AbortController().signal)
  assert.equal(ready.value.sources[0].selectable, true)
  assert.equal(ready.value.sources[0].agent_id, 'real-agent')
})

test('创建请求必须沿用预览来源，否则在调用 CLI 前拒绝', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const handler = module.createInstancesHandler(fx.root)
  const result = await handler('run', {
    operation: 'create', name: 'new-one', source: 'experiment:EXP-real-agent-001', expected_source_id: 'experiment:EXP-other-002',
  }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.value.ok, false)
  assert.match(result.value.error.message, /预览来源不一致/)
  assert.throws(() => readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')), /ENOENT/)
})

test('确认创建时把预览端口作为显式端口交给 CLI', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const handler = module.createInstancesHandler(fx.root)
  const result = await handler('run', {
    operation: 'create', name: 'port-frozen', source: 'experiment:EXP-real-agent-001', expected_source_id: 'experiment:EXP-real-agent-001', port: 3265, expected_source_digest: 'sha256:' + 'a'.repeat(64),
  }, new AbortController().signal)
  assert.equal(result.value.ok, true)
  const calls = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--port'), calls[0].indexOf('--port') + 2), ['--port', '3265'])
})

test('来源资产预检错误保留结构化阶段、路径和恢复动作，不编造执行端口', async t => {
  const { module, cleanup } = await loadModule(), fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const result = await module.createInstancesHandler(fx.root)('run', {
    operation: 'create', name: 'invalid-assets', source: 'experiment:EXP-real-agent-001',
    expected_source_id: 'experiment:EXP-real-agent-001', port: 3265, expected_source_digest: 'sha256:' + 'a'.repeat(64),
  }, new AbortController().signal)
  assert.equal(result.value.ok, false)
  assert.equal(result.value.error.code, 'candidate_assets_invalid')
  assert.equal(result.value.error.details.stage, 'candidate-assets')
  assert.equal(result.value.error.details.path, 'dsh/workspace/.env')
  assert.match(result.value.error.details.next_action, /修复来源 Candidate/)
  assert.equal(result.value.value, undefined)
  const preview = await module.createInstancesHandler(fx.root)('preview', {
    operation: 'create', name: 'invalid-assets', source: 'experiment:EXP-real-agent-001',
  }, new AbortController().signal)
  assert.equal(preview.ok, false)
  assert.equal(preview.error.code, 'candidate_assets_invalid')
  assert.equal(preview.error.details.path, 'dsh/workspace/.env')
})

test('run parses two stdout JSON objects and redacts bounded logs', async () => {
  const { module, cleanup: cleanupModule } = await loadModule()
  const fx = fixture()
  try {
    const handler = module.createInstancesHandler(fx.root)
    const receipt = await handler('run', {
      operation: 'create',
      name: 'stage1-new',
      source: 'experiment:EXP-real-agent-001',
      expected_source_digest: 'sha256:' + 'a'.repeat(64),
      allow_missing_env: true,
    }, new AbortController().signal)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.value.ok, true, JSON.stringify(receipt))
    assert.equal(receipt.value.value.json_objects.length, 3)
    assert.deepEqual(receipt.value.value.value, { name: 'stage1-new', dsh_running: true, token: '<redacted>' })
    assert.equal(JSON.stringify(receipt).includes('receipt-secret'), false)
    const logs = await handler('logs', { name: 'running-one', tail: 5 }, new AbortController().signal)
    assert.equal(logs.ok, true)
    assert.equal(logs.value.logs.includes('secret-token'), false)
    assert.equal(logs.value.logs.includes('bearer-secret'), false)
    assert.equal(logs.value.logs.includes('json-secret'), false)
    assert.equal(logs.value.logs.includes('abc123'), false)
  } finally {
    fx.cleanup()
    cleanupModule()
  }
})

test('request boundary rejects invalid port, source and booleans', async () => {
  const { module, cleanup: cleanupModule } = await loadModule()
  const fx = fixture()
  try {
    const handler = module.createInstancesHandler(fx.root)
    for (const payload of [
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-agent-001', port: 65536 },
      { operation: 'create', name: 'stage1-new', source: 7 },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-agent-001', allow_missing_env: 'yes' },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-agent-001', access_mode: 'open' },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-agent-001', identity_mode: 'unknown' },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-agent-001', access_mode: 'anonymous', business_control: false },
    ]) {
      const result = await handler('preview', payload, new AbortController().signal)
      assert.equal(result.ok, false)
    }
    const logs = await handler('logs', { name: 'running-one', tail: 0 }, new AbortController().signal)
    assert.equal(logs.ok, false)
  } finally {
    fx.cleanup()
    cleanupModule()
  }
})

test('batch returns per-item partial success and unknown mutation fails closed', async () => {
  const { module, cleanup: cleanupModule } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  try {
    const handler = module.createInstancesHandler(fx.root)
    const unknown = await handler('run', {
      operation: 'stop',
      name: 'unknown-one',
    }, new AbortController().signal)
    assert.equal(unknown.ok, true)
    assert.equal(unknown.value.ok, false)
    assert.match(unknown.value.error.message, /状态未知/)
    const preview = await handler('batch-preview', {
      items: [
        { operation: 'stop', name: 'running-one' },
        { operation: 'stop', name: 'missing-one' },
      ],
    }, new AbortController().signal)
    assert.equal(preview.ok, true)
    assert.equal(preview.value.partial_success, true)
    assert.deepEqual(preview.value.previews.map(item => item.ok), [true, false])
    const batch = await handler('batch', {
      items: [
        { operation: 'stop', name: 'running-one' },
        { operation: 'stop', name: 'fail-one' },
      ],
    }, new AbortController().signal)
    assert.equal(batch.ok, true)
    assert.equal(batch.value.ok, false)
    assert.equal(batch.value.partial_success, true)
    assert.deepEqual(batch.value.receipts.map(item => item.ok), [true, false])
    const callsFile = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
    const before = readFileSync(callsFile, 'utf8')
    const paused = await handler('batch', { items: [
      { operation: 'stop', name: 'unknown-one' },
      { operation: 'stop', name: 'running-one' },
      { operation: 'stop', name: 'fail-one' },
    ] }, new AbortController().signal)
    assert.deepEqual(paused.value.receipts.map(item => item.status), ['unknown', 'not_dispatched', 'not_dispatched'])
    const dispatched = readFileSync(callsFile, 'utf8').slice(before.length).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(dispatched.every(args => !['down', 'up', 'delete', 'reload'].includes(args[0])))
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previous
    fx.cleanup()
    cleanupModule()
  }
})

test('json object parser handles adjacent command reports', async () => {
  const { module, cleanup } = await loadModule()
  try {
    assert.deepEqual(module.parseJsonObjects('x {"a":1}\\n{"b":[2]} tail'), [{ a: 1 }, { b: [2] }])
  } finally {
    cleanup()
  }
})

test('165 项删除委托 CLI 逐项核验，保留失败回执且不扫描全局实例', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const handler = module.createInstancesHandler(fx.root)
  const items = Array.from({ length: 165 }, (_, index) => ({ operation: 'delete', name: `batch-${String(index).padStart(3, '0')}` }))
  const result = await handler('batch', { items }, new AbortController().signal)
  assert.equal(result.ok, true)
  assert.equal(result.value.partial_success, true)
  assert.equal(result.value.receipts.length, 165)
  assert.equal(result.value.receipts.filter(item => item.ok).length, 164)
  assert.equal(result.value.receipts[83].ok, false)
  assert.equal(result.value.receipts[164].value.value.home_preserved, true)
  const running = await handler('run', { operation: 'delete', name: 'running-one' }, new AbortController().signal)
  assert.equal(running.value.ok, true)
  const rejected = await handler('run', { operation: 'delete', name: 'unknown-one' }, new AbortController().signal)
  assert.equal(rejected.value.status, 'unknown')
  assert.match(rejected.value.error.message, /状态无法确认/)
  const calls = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.length, 167)
  assert.ok(calls.every(args => args[0] === 'delete'))
})

test('创建、启动与重启由 CLI 统一访问设置，旧实例保留端口和装载目录', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  writeFileSync(join(fx.state, 'dsh-dev/running-one/instance.json'), JSON.stringify({ name: 'running-one', source_id: 'experiment:EXP-real-agent-001', port: 3181,
    lan_access: false, unsafe_no_auth: false, skip_testing_notice: false, trusted_host: 'example.local:3181', mounts: { plugin_node_modules: '/opt/shared-dependencies' } }))
  const handler = module.createInstancesHandler(fx.root)
  for (const operation of ['start', 'restart']) {
    const result = await handler('preview', { name: 'running-one', operation, lan_access: false, unsafe_no_auth: false, skip_testing_notice: false }, new AbortController().signal)
    assert.equal(result.ok, true)
    const args = result.value.plan.args
    for (const flag of ['--lan-access', '--unsafe-no-auth', '--skip-testing-notice']) assert.equal(args.includes(flag), false)
    for (const [flag, value] of [['--port', '3181'], ['--trusted-host', 'example.local:3181'], ['--plugin-node-modules', '/opt/shared-dependencies']]) assert.equal(args[args.indexOf(flag) + 1], value)
    assert.equal(args.includes('--replace'), operation === 'restart')
  }
  const created = await handler('preview', { name: 'new-one', operation: 'create', source: 'experiment:EXP-real-agent-001' }, new AbortController().signal)
  assert.equal(created.ok, true)
  for (const flag of ['--lan-access', '--unsafe-no-auth', '--skip-testing-notice']) assert.equal(created.value.plan.args.includes(flag), false)
})

test('实例创建预览固定模型投影，执行前拒绝缺失或过期的摘要', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  let revision = 'current'
  let credential = 'credential-first'
  const defaultModel = { provider: 'deepseek-official', model: 'deepseek-chat' }
  const provider = async (agentId, selected) => {
    if (selected && (selected.provider !== defaultModel.provider || selected.model !== defaultModel.model)) {
      throw new Error('该业务智能体未标记此模型为可使用')
    }
    return { policy: { agent_id: agentId, allowed: [defaultModel], default: selected ?? defaultModel, revision },
      environment: { DEEPSEEK_API_KEY: credential } }
  }
  const handler = module.createInstancesHandler(fx.root, provider)
  const signal = new AbortController().signal
  const item = { operation: 'create', name: 'model-new', source: 'experiment:EXP-real-agent-001', model_selection: defaultModel, expected_source_digest: 'sha256:' + 'a'.repeat(64) }
  const preview = await handler('preview', item, signal)
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.value.model_selection, defaultModel)
  assert.match(preview.value.model_policy_hash, /^[0-9a-f]{64}$/)
  const callsPath = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  const callsBefore = readFileSync(callsPath, 'utf8')
  const denied = await handler('preview', { ...item, model_selection: { provider: 'openai', model: 'gpt-5' } }, signal)
  assert.equal(denied.ok, false)
  assert.match(denied.error.message, /未标记此模型/)
  assert.equal(readFileSync(callsPath, 'utf8'), callsBefore)
  const withoutHash = await handler('run', item, signal)
  assert.equal(withoutHash.value.ok, false)
  assert.match(withoutHash.value.error.message, /先预览当前模型设置/)
  assert.equal(readFileSync(callsPath, 'utf8'), callsBefore)
  revision = 'changed'
  const stale = await handler('run', { ...item, expected_model_policy_hash: preview.value.model_policy_hash }, signal)
  assert.equal(stale.value.ok, false)
  assert.match(stale.value.error.message, /模型设置或实例默认模型已变化/)
  assert.equal(readFileSync(callsPath, 'utf8'), callsBefore, '模型投影变化后不得派发创建')
  revision = 'current'
  credential = 'credential-changed'
  const changedCredential = await handler('run', { ...item, expected_model_policy_hash: preview.value.model_policy_hash }, signal)
  assert.equal(changedCredential.value.ok, false)
  assert.match(changedCredential.value.error.message, /模型设置或实例默认模型已变化/)
  assert.equal(readFileSync(callsPath, 'utf8'), callsBefore, '同名凭据的值变化后不得派发创建')
  assert.equal(JSON.stringify(changedCredential).includes(credential), false)
  credential = 'credential-first'
  const current = await handler('run', { ...item, expected_model_policy_hash: preview.value.model_policy_hash }, signal)
  assert.equal(current.value.ok, true)
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.filter(args => args[0] === 'up' && !args.includes('--dry-run')).length, 1)
})

test('已有实例继续使用登记的默认模型，显式选择只影响该实例操作', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const oldModel = { provider: 'deepseek-official', model: 'deepseek-chat' }
  const globalModel = { provider: 'openai', model: 'gpt-5' }
  const manifestPath = join(fx.state, 'dsh-dev/running-one/instance.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, model_policy: { default: oldModel } }))
  const selections = []
  const provider = async (_agentId, selected) => {
    selections.push(selected)
    const effective = selected ?? globalModel
    return { policy: { agent_id: 'real-agent', allowed: [oldModel, globalModel], default: effective }, environment: {} }
  }
  const handler = module.createInstancesHandler(fx.root, provider)
  const signal = new AbortController().signal
  const start = await handler('preview', { operation: 'start', name: 'running-one' }, signal)
  assert.equal(start.ok, true)
  assert.deepEqual(start.value.model_selection, oldModel)
  assert.deepEqual(selections[0], oldModel)
  const started = await handler('run', {
    operation: 'start', name: 'running-one', expected_source_id: 'experiment:EXP-real-agent-001',
    expected_model_policy_hash: start.value.model_policy_hash,
  }, signal)
  assert.equal(started.value.ok, true)
  assert.deepEqual(selections[1], oldModel)
  const restart = await handler('preview', { operation: 'restart', name: 'running-one', model_selection: globalModel }, signal)
  assert.equal(restart.ok, true)
  assert.deepEqual(restart.value.model_selection, globalModel)
  assert.deepEqual(selections[2], globalModel)
  const callsPath = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  const upCount = () => readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(args => args[0] === 'up' && !args.includes('--dry-run')).length
  const before = upCount()
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, model_policy: { default: globalModel } }))
  const stale = await handler('run', {
    operation: 'restart', name: 'running-one', model_selection: globalModel,
    expected_model_policy_hash: restart.value.model_policy_hash,
  }, signal)
  assert.equal(stale.value.ok, false)
  assert.match(stale.value.error.message, /模型设置或实例默认模型已变化/)
  assert.equal(upCount(), before, '登记的实例默认模型变化后不得按过期预览重启')
})

test('重载沿用版本 Candidate 的模型绑定，固定 Git 来源不混入工作树', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const source = 'EXP-real-agent-001', candidate = join(fx.root, 'evolution/experiments', source, 'candidate')
  const manifestPath = join(fx.state, 'dsh-dev/running-one/instance.json')
  const model = { provider: 'fixture-provider', model: 'fixture-model' }
  const manifest = { ...JSON.parse(readFileSync(manifestPath, 'utf8')), model_policy: { default: model } }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writeFileSync(join(candidate, 'binding.txt'), '固定角色绑定')
  const paths = []
  const provider = async (_agent, _selected, path) => {
    paths.push(path)
    assert.equal(readFileSync(join(path, 'binding.txt'), 'utf8'), '固定角色绑定')
    return { policy: { default: model }, environment: {} }
  }
  const handler = module.createInstancesHandler(fx.root, provider), signal = new AbortController().signal
  const request = { operation: 'reload', name: 'running-one' }
  const current = await handler('preview', request, signal)
  assert.equal(current.ok, true, JSON.stringify(current))
  assert.equal(paths[0], candidate)
  mkdirSync(join(fx.root, 'agents/real-agent'), { recursive: true })
  writeFileSync(join(fx.root, 'agents/real-agent/manifest.yaml'), 'agent_id: real-agent\nactive_experiment: EXP-real-agent-001\n')
  writeFileSync(join(fx.root, 'agents/real-agent/evaluation.md'), '# 固定评测\n')
  const git = args => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=验收', '-c', 'user.email=audit@example.test', ...args], { cwd: fx.root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git(['init', '-q']); git(['add', '.']); git(['commit', '-qm', '固定来源'])
  const commit = git(['rev-parse', 'HEAD'])
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, source_ref: `git:${commit}` }))
  writeFileSync(join(candidate, 'binding.txt'), '工作树已修改的角色绑定')
  const fixed = await handler('preview', request, signal)
  assert.equal(fixed.ok, true, JSON.stringify(fixed))
  assert.equal(paths[1], join(fx.root, '.local/evaluation-sources', commit, source, 'evolution/experiments', source, 'candidate'))
  const run = await handler('run', { ...request, expected_model_policy_hash: fixed.value.model_policy_hash,
    expected_asset_digest: fixed.value.plan.current_asset_digest, expected_generation_digest: fixed.value.plan.generation_digest }, signal)
  assert.equal(run.value.ok, true, JSON.stringify(run))
  assert.equal(paths[2], paths[1])
  assert.equal(readFileSync(join(candidate, 'binding.txt'), 'utf8'), '工作树已修改的角色绑定')
})

test('历史实例未记录默认模型时必须显式选择，不能套用新的统一默认', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const unified = { provider: 'deepseek-official', model: 'deepseek-chat' }
  const selected = { provider: 'openai', model: 'gpt-5' }
  const provider = async (agentId, requested) => ({
    policy: { agent_id: agentId, allowed: [unified, selected], default: requested ?? unified }, environment: {},
  })
  const handler = module.createInstancesHandler(fx.root, provider)
  const signal = new AbortController().signal
  const request = { operation: 'start', name: 'running-one' }
  const preview = await handler('preview', request, signal)
  assert.equal(preview.ok, false)
  assert.match(preview.error.message, /未记录默认模型/)
  const callsPath = join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')
  assert.throws(() => readFileSync(callsPath), /ENOENT/)
  const explicit = await handler('preview', { ...request, model_selection: selected }, signal)
  assert.equal(explicit.ok, true)
  assert.deepEqual(explicit.value.model_selection, selected)
  const run = await handler('run', { ...request, model_selection: selected,
    expected_model_policy_hash: explicit.value.model_policy_hash }, signal)
  assert.equal(run.value.ok, true)
})

for (const identity_mode of ['development', 'published']) test(`原则：业务控制关闭时无需登录的 ${identity_mode} 实例仍可创建并更新来源`, async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture(), previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  const file = join(fx.root, 'config/business-access.json')
  const access = JSON.parse(readFileSync(file, 'utf8'))
  access.enabled = false
  writeFileSync(file, JSON.stringify(access))
  const handler = module.createInstancesHandler(fx.root), signal = new AbortController().signal
  const item = { operation: 'create', name: 'new-business', source: 'experiment:EXP-real-agent-001', access_mode: 'anonymous', identity_mode }
  const preview = await handler('preview', item, signal)
  assert.equal(preview.ok, true)
  const created = await handler('run', { ...item, expected_source_digest: preview.value.plan.business_control.source_digest }, signal)
  assert.equal(created.value.ok, true, JSON.stringify(created))
  writeFileSync(join(fx.root, 'runtime/adapters/dsh-container/next-source-digest'), 'changed')
  const restart = { operation: 'restart', name: item.name }
  const updated = await handler('preview', restart, signal)
  const restarted = await handler('run', { ...restart, expected_source_digest: updated.value.plan.business_control.source_digest }, signal)
  assert.equal(restarted.value.ok, true, JSON.stringify(restarted))
  const registered = JSON.parse(readFileSync(file, 'utf8')).gateway.instances[0]
  assert.equal(registered.accessMode, 'anonymous')
  assert.equal(registered.identityMode, identity_mode)
  assert.equal(registered.sourceDigest, 'sha256:' + 'c'.repeat(64))
})

test('新建需要登录的实例拒绝关闭、缺失或不完整的网关，省略参数与批量操作都不能降级直连', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const handler = module.createInstancesHandler(fx.root)
  const signal = new AbortController().signal
  const file = join(fx.root, 'config/business-access.json')
  const original = JSON.parse(readFileSync(file, 'utf8'))
  const item = { operation: 'create', name: 'no-fallback', source: 'experiment:EXP-real-agent-001', access_mode: 'authenticated' }
  const falsePreview = await handler('preview', { ...item, business_control: false }, signal)
  assert.equal(falsePreview.ok, false)
  assert.match(falsePreview.error.message, /必须经过统一网关/)
  for (const access of [{ ...original, enabled: false }, { schemaVersion: 1, enabled: true, agents: [] },
    { ...original, gateway: { instances: [] } }]) {
    writeFileSync(file, JSON.stringify(access))
    for (const business of [{}, { business_control: true }]) {
      const preview = await handler('preview', { ...item, ...business }, signal)
      assert.equal(preview.ok, false)
      const run = await handler('run', { ...item, ...business }, signal)
      assert.equal(run.value.ok, false)
    }
    const batch = await handler('batch', { items: [item, { ...item, name: 'no-fallback-false', business_control: false }] }, signal)
    assert.equal(batch.ok, true)
    assert.equal(batch.value.receipts.every(result => result.ok === false), true)
    assert.equal(readFileSync(file, 'utf8'), JSON.stringify(access))
  }
  assert.throws(() => readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls')), /ENOENT/)
})
