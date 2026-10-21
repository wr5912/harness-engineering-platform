import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

async function loadModule() {
  const temp = mkdtempSync(join(tmpdir(), 'harness-platform-instances-build-'))
  const outfile = join(temp, 'instances.mjs')
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
  mkdirSync(adapter, { recursive: true })
  mkdirSync(join(state, 'dsh-dev/running-one'), { recursive: true })
  mkdirSync(join(state, 'dsh-dev/unknown-one'), { recursive: true })
  mkdirSync(join(root, 'evolution/experiments/EXP-real-001/runs/run-00000000-0000-4000-8000-000000000000'), { recursive: true })
  writeFileSync(join(adapter, 'sources.json'), JSON.stringify({
    schema_version: '1.1',
    sources: { 'EXP-real-001': { agent_id: 'real-agent' } },
  }))
  writeFileSync(join(state, 'dsh-dev/running-one/instance.json'), JSON.stringify({
    name: 'running-one',
    source_id: 'experiment:EXP-real-001',
    image_tag: 'dsh:locked',
    port: 3181,
  }))
  writeFileSync(join(state, 'dsh-dev/unknown-one/instance.json'), JSON.stringify({
    name: 'unknown-one',
    source_id: 'experiment:EXP-real-001',
    image_tag: 'dsh:locked',
    port: 3182,
  }))
  writeFileSync(join(adapter, 'dsh-dev-fixture.cjs'), `#!/usr/bin/env node
const args = process.argv.slice(2)
require('node:fs').appendFileSync(require('node:path').join(__dirname, 'dsh-dev.calls'), JSON.stringify(args) + '\\n')
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\\n')
if (args[0] === 'ps') {
  const newBusinessFile = require('node:path').join(process.env.XDG_STATE_HOME, 'dsh-dev', 'new-business', 'instance.json')
  const newBusiness = require('node:fs').existsSync(newBusinessFile)
    ? [{name:'new-business', state:'running', source_id:'experiment:EXP-real-001', agent_id:'real-agent', port:3199, business_gateway:true}]
    : []
  out({schema_version:'1.0', instances:[
    {name:'running-one', state:'running', source_id:'experiment:EXP-real-001', source_kind:'experiment', image_tag:'dsh:locked', agent_id:'real-agent', port:3181, home_volume:'home-running', home_preserved:true, container_name:'running-one', observed_at:'2026-10-13T00:00:00.000Z', mounts:{workspace:'/x'}, mount_modes:{workspace:'ro'}},
    {name:'unknown-one', state:'unknown', source_id:'experiment:EXP-real-001', image_tag:'dsh:locked', agent_id:'real-agent', port:3182, home_volume:null, home_preserved:null, container_name:'unknown-one', observed_at:'2026-10-13T00:00:00.000Z'},
    {name:'absent-one', state:'absent', source_id:'experiment:EXP-real-001', home_volume:'home-absent', home_preserved:true},
    ...newBusiness
  ]})
} else if (args[0] === 'up') {
  const dry = args.includes('--dry-run')
  const business = args.includes('--business-control')
  const name = args[args.indexOf('--name') + 1]
  const source = args[args.indexOf('--source') + 1]
  if (dry) out({args, name, source_id:source, image_tag:'dsh:locked', port:3199, mounts:[{container:'/work/harness/workspace', mode:'ro'}], state_dir:'state', ...(business ? { business_control: { source_digest: 'sha256:' + 'a'.repeat(64) } } : {})})
  else {
    if (business) {
      const file = require('node:path').join(process.env.XDG_STATE_HOME, 'dsh-dev', name, 'instance.json')
      require('node:fs').mkdirSync(require('node:path').dirname(file), {recursive:true})
      require('node:fs').writeFileSync(file, JSON.stringify({name, source_id:source, agent_id:'real-agent', asset_root:process.env.HARNESS_ASSET_ROOT, port:3199, web_base_path:'/agents/real-agent/instances/' + name + '/', business_control:{source_digest:'sha256:' + 'a'.repeat(64), runtime_generation:'generation-new', origin:'http://127.0.0.1:3199', launch_config_file:args[args.indexOf('--business-control')+1]}}))
    }
    process.stdout.write(JSON.stringify({warning:'first'}) + '\\n' + JSON.stringify({name, dsh_running:true, token:'receipt-secret'}) + '\\n'); process.stderr.write(JSON.stringify({hint:'not a receipt'}) + '\\n') }
} else if (args[0] === 'down') {
  const name = args[1]
  if (name === 'fail-one') { process.stderr.write('stop failed token=secret-token\\n'); process.exit(1) }
  out({name, stopped:true, home_preserved:true})
} else if (args[0] === 'delete') {
  if (['running-one', 'unknown-one', 'batch-083'].includes(args[1])) {
    process.stderr.write('只允许删除已停止实例；目标状态不是 stopped 或查询失败\\n'); process.exit(1)
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
  writeFileSync(join(adapter, 'dsh-dev'), `#!/usr/bin/env python3\nimport os,sys\nos.execv(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, ${JSON.stringify(join(adapter, 'dsh-dev-fixture.cjs'))}, *sys.argv[1:]])\n`)
  chmodSync(join(adapter, 'dsh-dev'), 0o755)
  return { root, state, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

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
  const stateChanged = await handler('run', { operation: 'stop', name: 'running-one', expected_source_id: 'experiment:EXP-real-001', expected_state: 'stopped' }, signal)
  assert.equal(stateChanged.value.ok, false)
  assert.match(stateChanged.value.error.message, /实例状态已变化/)
  assert.equal(readFileSync(callsFile, 'utf8').split('\n').filter(line => line.includes('"down"')).length, beforeStateChange.split('\n').filter(line => line.includes('"down"')).length)
  const same = await handler('run', { operation: 'stop', name: 'running-one', expected_source_id: 'experiment:EXP-real-001' }, signal)
  assert.equal(same.ok, true)
  assert.equal(same.value.ok, true)
  const before = readFileSync(callsFile, 'utf8')
  const manifest = join(fx.state, 'dsh-dev/running-one/instance.json')
  writeFileSync(manifest, JSON.stringify({ name: 'running-one', source_id: 'experiment:EXP-another-001', port: 3181 }))
  const changed = await handler('run', { operation: 'restart', name: 'running-one', expected_source_id: 'experiment:EXP-real-001' }, signal)
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
  writeFileSync(accessPath, JSON.stringify({ ...access, gateway: { ...access.gateway, instances: [{ agentId: 'real-agent', instanceId: 'running-one', sourceId: 'experiment:EXP-real-001', sourceDigest: 'sha256:' + 'b'.repeat(64) }] } }))
  assert.match((await request()).error.message, /来源与网关登记不一致/)
  writeFileSync(accessPath, JSON.stringify({ ...access, gateway: { ...access.gateway, instances: [] } }))
  assert.match((await request()).error.message, /实例未向业务网关开放/)
})

test('平台创建受控实例后原子登记来源，沿用当前管理入口并可读回网关地址', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  const previous = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = fx.state
  t.after(() => { fx.cleanup(); cleanup(); if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous })
  mkdirSync(join(fx.root, 'config'), { recursive: true })
  const accessPath = join(fx.root, 'config/business-access.json')
  writeFileSync(accessPath, JSON.stringify({ schemaVersion: 1, enabled: true, gateway: { publicOrigin: 'http://business.example:53105', managementUrl: 'http://127.0.0.1:18120', instances: [] } }))
  const handler = module.createInstancesHandler(fx.root)
  const source = 'experiment:EXP-real-001', name = 'new-business'
  const item = { operation: 'create', name, source, business_control: true, access_mode: 'anonymous' }
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
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].accessMode, 'anonymous', '同名实例重启保留访客访问方式')
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].identityMode, 'development', '同名实例重启保留开发阶段')
  const conflicting = JSON.parse(readFileSync(accessPath, 'utf8'))
  conflicting.gateway.instances[0].sourceDigest = 'sha256:' + 'b'.repeat(64)
  writeFileSync(accessPath, JSON.stringify(conflicting))
  const callsBeforeConflict = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8')
  const rejected = await handler('run', { ...restart, expected_source_id: source, expected_source_digest: restartPreview.value.plan.business_control.source_digest }, signal)
  assert.equal(rejected.value.ok, false)
  assert.match(rejected.value.error.message, /业务网关中同名实例的来源、访问方式或实例阶段不一致/)
  const mutatingCalls = value => value.trim().split('\n').map(line => JSON.parse(line))
    .filter(args => args[0] === 'down' || args[0] === 'up' && !args.includes('--dry-run'))
  assert.deepEqual(mutatingCalls(readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8')),
    mutatingCalls(callsBeforeConflict), '已知来源冲突不得执行 --replace 或 down')
  assert.equal(JSON.parse(readFileSync(accessPath, 'utf8')).gateway.instances[0].sourceDigest, 'sha256:' + 'b'.repeat(64))
  const calls = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(calls.filter(args => args[0] === 'up').every(args => args[args.indexOf('--business-control') + 1] === accessPath))
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
  const sourceId = 'experiment:EXP-real-001'
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
      source: 'experiment:EXP-real-001',
    }, new AbortController().signal)
    assert.equal(good.ok, true)
    assert.equal(good.value.plan.source_id, 'experiment:EXP-real-001')
    assert.equal(good.value.retention.home, '保留')
  } finally {
    fx.cleanup()
    cleanupModule()
  }
})

test('来源候选只读来自当前登记，并标明 Candidate 缺失或可读取', async t => {
  const { module, cleanup } = await loadModule()
  const fx = fixture()
  t.after(() => { fx.cleanup(); cleanup() })
  const handler = module.createInstancesHandler(fx.root)
  const missing = await handler('sources', {}, new AbortController().signal)
  assert.equal(missing.ok, true)
  assert.equal(missing.value.sources[0].source_id, 'experiment:EXP-real-001')
  assert.equal(missing.value.sources[0].selectable, false)
  writeFileSync(join(fx.root, 'runtime/adapters/dsh-container/sources.json'), JSON.stringify({
    schema_version: '1.1', sources: { 'EXP-real-001': { agent_id: 'real-agent', candidate_root: 'evolution/experiments/EXP-real-001/candidate/dsh' } },
  }))
  mkdirSync(join(fx.root, 'evolution/experiments/EXP-real-001/candidate/dsh'), { recursive: true })
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
    operation: 'create', name: 'new-one', source: 'experiment:EXP-real-001', expected_source_id: 'experiment:EXP-other-002',
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
    operation: 'create', name: 'port-frozen', source: 'experiment:EXP-real-001', expected_source_id: 'experiment:EXP-real-001', port: 3265,
  }, new AbortController().signal)
  assert.equal(result.value.ok, true)
  const calls = readFileSync(join(fx.root, 'runtime/adapters/dsh-container/dsh-dev.calls'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--port'), calls[0].indexOf('--port') + 2), ['--port', '3265'])
})

test('run parses two stdout JSON objects and redacts bounded logs', async () => {
  const { module, cleanup: cleanupModule } = await loadModule()
  const fx = fixture()
  try {
    const handler = module.createInstancesHandler(fx.root)
    const receipt = await handler('run', {
      operation: 'create',
      name: 'stage1-new',
      source: 'experiment:EXP-real-001',
      allow_missing_env: true,
    }, new AbortController().signal)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.value.ok, true)
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
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-001', port: 65536 },
      { operation: 'create', name: 'stage1-new', source: 7 },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-001', allow_missing_env: 'yes' },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-001', access_mode: 'open' },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-001', identity_mode: 'unknown' },
      { operation: 'create', name: 'stage1-new', source: 'experiment:EXP-real-001', access_mode: 'anonymous', business_control: false },
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
  for (const name of ['running-one', 'unknown-one']) {
    const rejected = await handler('run', { operation: 'delete', name }, new AbortController().signal)
    assert.equal(rejected.value.ok, false)
    assert.match(rejected.value.error.message, /只允许删除已停止实例/)
  }
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
  writeFileSync(join(fx.state, 'dsh-dev/running-one/instance.json'), JSON.stringify({ name: 'running-one', source_id: 'experiment:EXP-real-001', port: 3181,
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
  const created = await handler('preview', { name: 'new-one', operation: 'create', source: 'experiment:EXP-real-001' }, new AbortController().signal)
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
  const item = { operation: 'create', name: 'model-new', source: 'experiment:EXP-real-001', model_selection: defaultModel }
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
    operation: 'start', name: 'running-one', expected_source_id: 'experiment:EXP-real-001',
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
