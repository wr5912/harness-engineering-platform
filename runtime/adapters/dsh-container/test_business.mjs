import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { businessSourceDigest, readBusinessLaunchConfig, renderBusinessInstance } from './business.ts'
const require = createRequire(new URL('../../../platform/plugin/package.json', import.meta.url))
const yaml = require('js-yaml')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'business-startup-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const pluginRoot = join(root, 'plugin'), assetRoot = join(root, 'data'), managed = join(root, 'managed')
  mkdirSync(join(pluginRoot, 'lib'), { recursive: true }); mkdirSync(join(assetRoot, 'config'), { recursive: true }); mkdirSync(managed)
  mkdirSync(join(pluginRoot, 'business'))
  writeFileSync(join(pluginRoot, 'lib/business-runtime.js'), ''); writeFileSync(join(pluginRoot, 'lib/mcp-manager.js'), '')
  for (const name of ['package.json', 'runtime.js', 'mcp-manager.js']) writeFileSync(join(pluginRoot, 'business', name), name === 'package.json' ? '{}' : '')
  writeFileSync(join(assetRoot, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true }))
  const secret = join(root, 'business-secret'); writeFileSync(secret, 'a'.repeat(32))
  const file = join(root, 'launch.json'), config = { assetRoot, pluginRoot, sharedSecretFile: secret, coordinatorOrigin: 'http://host.docker.internal:53190' }
  writeFileSync(file, JSON.stringify(config))
  writeFileSync(join(managed, 'web-profile.package.json'), '{}')
  writeFileSync(join(managed, 'web-profile.seed.patch.yml'), yaml.dump([{ insert: [{ id: 'mcp-session-manager', name: 'file:///opt/dsh-managed/mcp-manager/index.mjs',
    config: { servers: [{ id: 'soc', url: 'http://host.docker.internal:53101/mcp' }], groups: [] } }] }]))
  const input = { name: 'business-test', agentId: 'soc', workspaceId: 'workspace-test', sourceDigest: 'sha256:fixed', runtimeGeneration: 'generation-test',
    port: 53191, profileManifest: join(managed, 'web-profile.package.json'), basePath: '/assistant/',
    compose: yaml.dump({ services: { 'home-init': { network_mode: 'none' }, dsh: { image: 'standard-image', network_mode: 'host',
      command: ['--patch', 'managed.patch.yml', '--no-open', '--host', '127.0.0.1', '--port', '53191'], environment: [], volumes: [] } } }) }
  return { root, config, file, input, managed }
}

test('启动配置只读核验，拒绝容器不可达协调器、未构建插件及短密钥', t => {
  const f = fixture(t)
  assert.equal(readBusinessLaunchConfig(f.file).assetRoot, f.config.assetRoot)
  for (const config of [{ ...f.config, coordinatorOrigin: 'http://127.0.0.1:53190' }, { ...f.config, coordinatorOrigin: 'http://host.docker.internal:53190/path' }]) {
    writeFileSync(f.file, JSON.stringify(config)); assert.throws(() => readBusinessLaunchConfig(f.file))
  }
  writeFileSync(f.file, JSON.stringify(f.config)); writeFileSync(f.config.sharedSecretFile, 'short')
  assert.throws(() => readBusinessLaunchConfig(f.file))
})

test('业务渲染改独立bridge和回环映射，标准镜像及MCP配置保持，所有代码与策略只读装载', t => {
  const f = fixture(t), result = renderBusinessInstance(readBusinessLaunchConfig(f.file), f.input), compose = yaml.load(result.compose), patch = yaml.load(result.patch)
  assert.equal(compose.services.dsh.image, 'standard-image')
  assert.equal(compose.services['home-init'].network_mode, 'none')
  assert.equal(compose.services.dsh.network_mode, undefined)
  assert.deepEqual(compose.services.dsh.ports, ['127.0.0.1:53191:53191'])
  assert.deepEqual(compose.services.dsh.networks, ['business'])
  assert.ok(compose.services.dsh.environment.includes('HARNESS_BUSINESS_AGENT_ID=soc'))
  assert.ok(compose.services.dsh.environment.includes('HARNESS_BUSINESS_INSTANCE_ID=business-test'))
  assert.equal(compose.services.dsh.command[compose.services.dsh.command.indexOf('--host') + 1], '127.0.0.1')
  assert.equal(patch.find(item => item.id === 'webserver').config.host, '0.0.0.0')
  assert.ok(compose.services.dsh.volumes.every(item => item.read_only))
  assert.ok(patch.some(item => item.id === 'mcp-session-manager' && item.disabled))
  assert.ok(patch.some(item => item.id === 'schedule' && item.disabled))
  const manager = patch.flatMap(item => item.insert ?? []).find(item => item.id === 'business-mcp-manager')
  assert.equal(manager.config.servers[0].url, 'http://host.docker.internal:53101/mcp')
  assert.deepEqual(manager.inject, ['businessRuntime'])
  const runtime = patch.flatMap(item => item.insert ?? []).find(item => item.id === 'business-runtime')
  assert.equal(runtime.name, '/opt/harness-platform/business/runtime.js')
  assert.equal(manager.name, '/opt/harness-platform/business/mcp-manager.js')
  assert.equal(runtime.config.stateRoot, '/var/lib/dsh/business-control-state')
  assert.equal(runtime.config.assetRoot, '/opt/harness-business-assets')
  assert.equal(runtime.config.basePath, '/agents/soc/instances/business-test/')
  assert.equal(result.registration.runtime_generation, 'generation-test')
  assert.equal(result.registration.scheduling_supported, false)
  assert.equal(result.registration.origin, 'http://127.0.0.1:53191')
  assert.ok(!result.patch.includes('a'.repeat(32)))
})

test('免认证来源不会被转为业务实例', t => {
  const f = fixture(t)
  const compose = yaml.load(f.input.compose)
  compose.services.dsh.command.push('/opt/dsh-adapter/verification-home-controls/web-unsafe-no-auth.patch.yml')
  assert.throws(() => renderBusinessInstance(f.config, { ...f.input, compose: yaml.dump(compose) }))
})

test('开发来源无 MCP seed 或 manager 时沿用 DSH 原生来源装载', t => {
  const f = fixture(t), seed = join(f.managed, 'web-profile.seed.patch.yml')
  rmSync(seed)
  for (const source of ['absent', 'native-only']) {
    if (source === 'native-only') writeFileSync(seed, yaml.dump([{ insert: [{ id: 'native-example', name: '/opt/dsh-managed/native-example.mjs' }] }]))
    const result = renderBusinessInstance(readBusinessLaunchConfig(f.file), f.input)
    const compose = yaml.load(result.compose), patch = yaml.load(result.patch)
    assert.ok(compose.services.dsh.command.includes('managed.patch.yml'))
    assert.ok(patch.flatMap(item => item.insert ?? []).some(item => item.id === 'business-runtime'))
    assert.ok(!patch.some(item => item.id === 'mcp-session-manager' || item.id === 'mcp-manager'))
    assert.ok(!patch.flatMap(item => item.insert ?? []).some(item => item.id === 'business-mcp-manager'))
  }
})

test('显式 MCP manager 来源冲突或配置无效时拒绝接管', t => {
  const f = fixture(t)
  writeFileSync(join(f.managed, 'web-profile.seed.patch.yml'), '[]')
  assert.doesNotThrow(() => renderBusinessInstance(f.config, f.input))
  for (const rows of [
    [{ insert: [{ id: 'mcp-session-manager', name: 'file:///opt/dsh-managed/mcp-manager/index.mjs' },
      { id: 'mcp-session-manager', name: 'file:///opt/dsh-managed/mcp-manager/index.mjs', config: {} }] }],
    [{ insert: [{ id: 'mcp-session-manager', name: 'unexpected.mjs', config: {} }] }],
    [{ insert: [{ id: 'mcp-session-manager', name: 'file:///opt/dsh-managed/mcp-manager/index.mjs', config: null }] }],
    [{ id: 'mcp-session-manager', name: 'unexpected.mjs', config: {} }],
  ]) {
    writeFileSync(join(f.managed, 'web-profile.seed.patch.yml'), yaml.dump(rows))
    assert.throws(() => renderBusinessInstance(f.config, f.input), /业务来源 MCP manager 声明冲突或配置无效/)
  }
})

test('受控业务入口拒绝不符合 Web 路径合同的 Agent 或实例 ID', t => {
  const f = fixture(t)
  for (const invalid of ['1soc', 'soc--other', 'soc/other']) {
    assert.throws(() => renderBusinessInstance(f.config, { ...f.input, agentId: invalid }), /业务实例登记参数无效/)
    assert.throws(() => renderBusinessInstance(f.config, { ...f.input, name: invalid }), /业务实例登记参数无效/)
  }
})

test('资产身份按内容固定，安装缓存不成为另一份可编辑资产', t => {
  const f = fixture(t), paths = { managed: f.managed }
  const first = businessSourceDigest(paths)
  mkdirSync(join(f.managed, 'node_modules')); writeFileSync(join(f.managed, 'node_modules/cache'), 'temporary')
  assert.equal(businessSourceDigest(paths), first)
  writeFileSync(join(f.managed, 'package-lock.json'), '{}')
  assert.notEqual(businessSourceDigest(paths), first)
  const seed = join(f.managed, 'web-profile.seed.patch.yml'), original = readFileSync(seed)
  renderBusinessInstance(f.config, f.input)
  assert.deepEqual(readFileSync(seed), original)
})

test('业务实例只从固定 Candidate 声明装载本地能力，定时自动研判不在受控清单', t => {
  const f = fixture(t), matrix = join(f.managed, 'role-tool-matrix.yaml')
  writeFileSync(matrix, `schema_version: "2.0"
runtime_capabilities:
  local_tools:
    - skill
    - analyze_threat_incident
    - delegate_threat_analysis
    - delegate_fault_analysis
  local_model_routes:
    - provider: threat-analysis-delivery
      model: fixed-summary
    - provider: security-operation-delivery
      model: fixed-operation-result
`)
  const before = businessSourceDigest({ managed: f.managed })
  const rendered = renderBusinessInstance(f.config, { ...f.input, sourcePaths: { managed: f.managed } })
  const runtime = yaml.load(rendered.patch).flatMap(item => item.insert ?? []).find(item => item.id === 'business-runtime')
  assert.deepEqual(runtime.config.localTools, ['skill', 'analyze_threat_incident', 'delegate_threat_analysis', 'delegate_fault_analysis'])
  assert.deepEqual(rendered.localModelRoutes, [{ provider: 'threat-analysis-delivery', model: 'fixed-summary' },
    { provider: 'security-operation-delivery', model: 'fixed-operation-result' }])
  assert.ok(!runtime.config.localTools.includes('analyze_pending_threat_incidents'))
  writeFileSync(matrix, readFileSync(matrix, 'utf8') + '# revised\n')
  assert.notEqual(businessSourceDigest({ managed: f.managed }), before)
  writeFileSync(matrix, `runtime_capabilities:\n  local_tools: [skill, skill]\n  local_model_routes: []\n`)
  assert.throws(() => renderBusinessInstance(f.config, f.input), /业务本地能力声明无效/)
})
