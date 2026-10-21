import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const bundled = mkdtempSync(join(tmpdir(), 'models-handler-module-'))
await build({ entryPoints: [new URL('../src/models/index.ts', import.meta.url).pathname], outfile: join(bundled, 'index.mjs'),
  bundle: true, platform: 'node', format: 'esm' })
const { createModelsHandler } = await import(`file://${join(bundled, 'index.mjs')}`)
test.after(() => rmSync(bundled, { recursive: true, force: true }))

const sha256 = value => createHash('sha256').update(value).digest('hex')
const one = { provider: 'provider-a', model: 'model-one' }
const two = { provider: 'provider-a', model: 'model-two' }
const three = { provider: 'provider-b', model: 'model-three' }
const catalog = { default: one, routableProviders: ['provider-a', 'provider-b', 'deepseek-account'], failures: [], groups: [
  { id: 'provider-a', name: 'Provider A', models: [
    { id: 'model-one', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'low' } },
    { id: 'model-two', name: 'Model Two' },
  ] },
  { id: 'provider-b', name: 'Provider B', models: [{ id: 'model-three', name: 'Model Three' }] },
  { id: 'deepseek-account', name: 'Account', models: [{ id: 'account-model' }] },
  { id: 'disabled-provider', name: 'Disabled', models: [{ id: 'disabled-model' }] },
] }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'models-handler-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifest = join(root, 'agents/example-agent/manifest.yaml')
  mkdirSync(dirname(manifest), { recursive: true })
  const original = "agent_id: example-agent\nmodel_access:\n  allowed:\n    - provider: legacy-only\n      model: legacy-model\n"
  writeFileSync(manifest, original)
  let platformDefault = one
  let currentCatalog = catalog
  let saved = 0
  let readiness = { 'provider-a': { state: 'ready', message: '业务启动配置可解析' },
    'provider-b': { state: 'missing_api_key', message: '请配置 API Key' },
    'deepseek-account': { state: 'platform_only', message: '仅平台助手' },
    'disabled-provider': { state: 'platform_only', message: '仅平台助手' } }
  const deps = {
    modelCatalog: async () => currentCatalog,
    providerReadiness: async providers => Object.fromEntries(providers.map(provider => [provider, readiness[provider] ?? { state: 'unknown', message: '待核对' }])),
    currentSelection: () => platformDefault,
    saveSelection: async selected => { platformDefault = selected; saved++ },
  }
  const handler = createModelsHandler(root, deps)
  const rpc = (endpoint, payload = {}) => handler(endpoint, payload, new AbortController().signal)
  const file = join(root, 'config/business-model-default.json')
  return { root, file, manifest, original, deps, rpc, get saved() { return saved },
    set catalog(value) { currentCatalog = value }, set readiness(value) { readiness = value } }
}

test('业务可用模型从当前可路由目录派生，排除账号和仅平台模型，旧 Agent 标记不生效', async t => {
  const fx = fixture(t)
  const result = await fx.rpc('list')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value.business_allowed, [one, two, three])
  assert.equal(result.value.business_default, null)
  assert.equal(result.value.business_model_revision, sha256(''))
  assert.equal(result.value.migration_required, false)
  assert.equal(Object.hasOwn(result.value, 'agents'), false)
  assert.equal(readFileSync(fx.manifest, 'utf8'), fx.original)
})

test('平台助手默认模型仍使用 DSH 原生目录与设置', async t => {
  const fx = fixture(t)
  assert.equal((await fx.rpc('saveDefault', { selection: { provider: 'unknown', model: 'unknown' } })).error.code, 'model_unavailable')
  assert.equal((await fx.rpc('saveDefault', { selection: { ...two, reasoningEffort: 'high' } })).error.code, 'invalid_request')
  const selected = { ...one, reasoningEffort: 'high' }
  assert.deepEqual((await fx.rpc('saveDefault', { selection: selected })).value.platform_default, selected)
  assert.deepEqual((await fx.rpc('list')).value.platform_default, selected)
  assert.equal(fx.saved, 1)
})

test('业务默认模型直接保存为 schema 1.2，单文件修订冲突不覆盖', async t => {
  const fx = fixture(t)
  const selected = { ...one, reasoningEffort: 'high' }
  const saved = await fx.rpc('saveBusinessDefault', { selection: selected, revision: sha256('') })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(saved.value.business_default, selected)
  const text = readFileSync(fx.file, 'utf8')
  assert.deepEqual(JSON.parse(text), { schema_version: '1.2', default: selected })
  assert.equal(saved.value.business_model_revision, sha256(text))
  assert.deepEqual((await fx.rpc('list')).value.business_allowed, [one, two, three])
  assert.equal((await fx.rpc('saveBusinessDefault', { selection: two, revision: sha256('') })).error.code, 'conflict')
  assert.equal(readFileSync(fx.file, 'utf8'), text)
  assert.equal((await fx.rpc('saveBusinessModels', {})).error.code, 'method_not_found')
  assert.equal((await fx.rpc('saveAgent', {})).error.code, 'method_not_found')
})

test('业务默认只能选择当前业务目录模型和有效推理档位，不要求另行标记', async t => {
  const fx = fixture(t)
  const call = selected => fx.rpc('saveBusinessDefault', { selection: selected, revision: sha256('') })
  assert.equal((await call(null)).error.code, 'invalid_request')
  assert.equal((await call({ provider: 'deepseek-account', model: 'account-model' })).error.code, 'model_unavailable')
  assert.equal((await call({ provider: 'disabled-provider', model: 'disabled-model' })).error.code, 'model_unavailable')
  assert.equal((await call({ provider: 'missing', model: 'missing' })).error.code, 'model_unavailable')
  assert.equal((await call({ ...one, reasoningEffort: 'invalid' })).error.code, 'invalid_request')
  assert.equal((await call({ ...two, reasoningEffort: 'high' })).error.code, 'invalid_request')
  assert.equal(existsSync(fx.file), false)
  assert.equal((await call(three)).ok, true, '缺 API Key 的业务模型可保存选择，启动时再明确拒绝')
})

test('旧 1.0 和 1.1 只作迁移预选；运行中实例不阻断默认值确认', async t => {
  const fx = fixture(t)
  mkdirSync(dirname(fx.file), { recursive: true })
  const old = `${JSON.stringify({ schema_version: '1.1', allowed: [one], default: one })}\n`
  writeFileSync(fx.file, old)
  const listed = await fx.rpc('list')
  assert.equal(listed.value.migration_required, true)
  assert.equal(listed.value.business_default, null)
  assert.deepEqual(listed.value.legacy_default, one)
  assert.deepEqual(listed.value.business_allowed, [one, two, three])
  mkdirSync(join(fx.root, '.local/instances'), { recursive: true })
  fx.deps.observeInstances = async () => { throw new Error('运行实例不可停止') }
  const saved = await fx.rpc('saveBusinessDefault', { selection: two, revision: sha256(old) })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.deepEqual(JSON.parse(readFileSync(fx.file, 'utf8')), { schema_version: '1.2', default: two })
  writeFileSync(fx.file, JSON.stringify({ schema_version: '1.0', default: one }))
  assert.equal((await fx.rpc('list')).value.migration_required, true)
})

test('原生目录变化会影响只读业务可选范围，已选默认缺失时不能重新保存', async t => {
  const fx = fixture(t)
  const saved = await fx.rpc('saveBusinessDefault', { selection: one, revision: sha256('') })
  assert.equal(saved.ok, true)
  fx.catalog = { ...catalog, routableProviders: ['provider-b'], groups: catalog.groups }
  const listed = await fx.rpc('list')
  assert.deepEqual(listed.value.business_allowed, [three])
  assert.deepEqual(listed.value.business_default, one)
  assert.equal((await fx.rpc('saveBusinessDefault', { selection: one, revision: saved.value.business_model_revision })).error.code, 'model_unavailable')
})

test('配置额外字段、超大文件和符号链接拒绝加载；持锁不回读旧值', async t => {
  const fx = fixture(t)
  mkdirSync(dirname(fx.file), { recursive: true })
  writeFileSync(fx.file, JSON.stringify({ schema_version: '1.2', default: one, allowed: [one] }))
  assert.equal((await fx.rpc('list')).error.code, 'invalid_asset')
  writeFileSync(fx.file, JSON.stringify({ schema_version: '1.2', default: { ...one, hidden: 'value' } }))
  assert.equal((await fx.rpc('list')).error.code, 'invalid_asset')
  writeFileSync(fx.file, `${' '.repeat(16 * 1024)}\n`)
  assert.equal((await fx.rpc('list')).error.code, 'invalid_asset')
  rmSync(fx.file)
  const outside = join(fx.root, 'outside.json')
  writeFileSync(outside, JSON.stringify({ schema_version: '1.2', default: one }))
  symlinkSync(outside, fx.file)
  assert.equal((await fx.rpc('list')).error.code, 'path_rejected')
  rmSync(fx.file)
  writeFileSync(fx.file, JSON.stringify({ schema_version: '1.2', default: one }))
  writeFileSync(`${fx.file}.lock`, '')
  assert.equal((await fx.rpc('list')).error.code, 'busy')
  rmSync(`${fx.file}.lock`)
  assert.equal((await fx.rpc('list')).ok, true)
})

test('并发进程用同一修订版保存默认模型时只有一方成功', async t => {
  const fx = fixture(t)
  const script = join(fx.root, 'writer.mjs')
  writeFileSync(script, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [bundle, root, revision, label, hold] = process.argv.slice(2)
if (hold === 'hold') {
  const original = fs.renameSync
  fs.renameSync = (...args) => {
    fs.writeFileSync(join(root, 'inside-rename'), '')
    const pause = new Int32Array(new SharedArrayBuffer(4))
    const until = Date.now() + 3000
    while (!fs.existsSync(join(root, 'release-rename')) && Date.now() < until) Atomics.wait(pause, 0, 0, 10)
    original(...args)
  }
  syncBuiltinESMExports()
}
const { createModelsHandler } = await import(pathToFileURL(bundle).href)
const selected = { provider: 'provider-a', model: 'model-' + label }
const catalog = { default: selected, routableProviders: ['provider-a'], failures: [], groups: [
  { id: 'provider-a', models: [{ id: 'model-a' }, { id: 'model-b' }] },
] }
const call = createModelsHandler(root, { modelCatalog: async () => catalog, providerReadiness: async () => ({}),
  currentSelection: () => selected, saveSelection: async () => {} })
const response = await call('saveBusinessDefault', { selection: selected, revision }, new AbortController().signal)
console.log(JSON.stringify(response))
`)
  const run = (label, hold) => {
    const child = spawn(process.execPath, [script, join(bundled, 'index.mjs'), fx.root, sha256(''), label, hold ? 'hold' : 'free'])
    let output = '', errors = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { errors += data })
    return new Promise((resolve, reject) => child.on('close', code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(errors || `进程退出码 ${code}`))))
  }
  const first = run('a', true)
  for (let attempt = 0; attempt < 200 && !existsSync(join(fx.root, 'inside-rename')); attempt++) await delay(10)
  assert.ok(existsSync(join(fx.root, 'inside-rename')))
  assert.equal((await fx.rpc('list')).error.code, 'busy')
  const second = run('b', false)
  writeFileSync(join(fx.root, 'release-rename'), '')
  const [saved, stale] = await Promise.all([first, second])
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(stale.error.code, 'conflict', JSON.stringify(stale))
  assert.deepEqual(JSON.parse(readFileSync(fx.file, 'utf8')).default, { provider: 'provider-a', model: 'model-a' })
  assert.equal(existsSync(join(fx.root, 'config/.business-model-policy.lock')), false)
  assert.equal(existsSync(`${fx.file}.lock`), false)
})
