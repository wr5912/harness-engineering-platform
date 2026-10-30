import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { businessSourceDigest, readBusinessLaunchConfig, renderBusinessInstance } from './business.ts'
import { mcpCredentialPaths } from '../../../platform/plugin/src/mcp/credential-path.ts'
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
  const mcp = mcpCredentialPaths(assetRoot)
  mkdirSync(mcp.directory, { recursive: true })
  writeFileSync(mcp.file, JSON.stringify({ schemaVersion: 1, sharedToken: 'fixture-token', servers: {} }))
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

test('开发模式从数据根登记读取，不依赖启动配置副本', t => {
  const f = fixture(t)
  const accessFile = join(f.config.assetRoot, 'config/business-access.json')
  for (const [identityMode, accessMode] of [['development', 'anonymous'], ['development', 'authenticated'], ['published', 'anonymous'], ['published', 'authenticated'], ['development', undefined]]) {
    writeFileSync(accessFile, JSON.stringify({ schemaVersion: 1, enabled: true, gateway: { instances: [
      { agentId: f.input.agentId, instanceId: f.input.name, identityMode, accessMode },
    ] } }))
    const result = JSON.parse(execFileSync(process.execPath, [new URL('./business.ts', import.meta.url).pathname, f.file],
      { input: JSON.stringify({ agentId: f.input.agentId, name: f.input.name }), encoding: 'utf8' }))
    assert.equal(result.development, identityMode === 'development')
    assert.equal(result.accessMode, accessMode === 'anonymous' ? 'anonymous' : 'authenticated')
  }
})

test('首次启动失败后的创建模式快照可恢复，网关登记始终优先且不同模式不能覆盖', t => {
  const f = fixture(t), access = join(f.config.assetRoot, 'config/business-access.json')
  const read = target => JSON.parse(execFileSync(process.execPath, [new URL('./business.ts', import.meta.url).pathname, f.file], { input: JSON.stringify(target), encoding: 'utf8' }))
  for (const identity_mode of ['development', 'published']) for (const access_mode of ['anonymous', 'authenticated']) {
    const target = { agentId: f.input.agentId, name: f.input.name, startupModes: { identity_mode, access_mode } }
    const restored = read(target)
    assert.equal(restored.registered, false)
    assert.equal(restored.identityMode, identity_mode)
    assert.equal(restored.accessMode, access_mode)
    const rendered = renderBusinessInstance(readBusinessLaunchConfig(f.file, target), { ...f.input, identityMode: identity_mode, accessMode: access_mode })
    assert.equal(rendered.registration.access_mode, access_mode)
    assert.equal(rendered.registration.identity_mode, identity_mode)
    assert.throws(() => readBusinessLaunchConfig(f.file, { ...target, identityMode: identity_mode === 'development' ? 'published' : 'development' }), /身份模式无效/)
    assert.throws(() => readBusinessLaunchConfig(f.file, { ...target, accessMode: access_mode === 'anonymous' ? 'authenticated' : 'anonymous' }), /访问方式无效/)
  }
  const target = { agentId: f.input.agentId, name: f.input.name, startupModes: { identity_mode: 'development', access_mode: 'anonymous' } }
  assert.throws(() => readBusinessLaunchConfig(f.file, { ...target, startupModes: { identity_mode: 'development' } }), /创建模式快照无效/)
  writeFileSync(access, JSON.stringify({ schemaVersion: 1, enabled: true, gateway: { instances: [{ agentId: target.agentId, instanceId: target.name, identityMode: 'published', accessMode: 'authenticated' }] } }))
  const authoritative = read(target)
  assert.equal(authoritative.registered, true)
  assert.equal(authoritative.identityMode, 'published')
  assert.equal(authoritative.accessMode, 'authenticated')
  assert.equal(read({ ...target, startupModes: { identity_mode: 'development' } }).identityMode, 'published', '已有网关登记不受旧启动快照缺失字段干扰')
  assert.throws(() => readBusinessLaunchConfig(f.file, { ...target, accessMode: 'anonymous' }), /访问方式无效/)
})

test('开发实例两种访问方式均无需签名文件和挂载，混合登记仍只核对当前实例', t => {
  const f = fixture(t), file = join(f.config.assetRoot, 'config/business-access.json')
  rmSync(f.config.sharedSecretFile)
  delete f.config.sharedSecretFile
  writeFileSync(f.file, JSON.stringify(f.config))
  for (const accessMode of ['anonymous', 'authenticated']) {
    const instances = [{ agentId: f.input.agentId, instanceId: f.input.name, identityMode: 'development', accessMode },
      { agentId: 'soc', instanceId: 'published', identityMode: 'published' }]
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, gateway: { instances } }))
    const config = readBusinessLaunchConfig(f.file, f.input)
    const rendered = renderBusinessInstance(config, f.input), compose = yaml.load(rendered.compose), patch = yaml.load(rendered.patch)
    assert.ok(!compose.services.dsh.volumes.some(item => item.target === '/opt/harness-business/shared-secret'))
    const runtime = patch.flatMap(item => item.insert ?? []).find(item => item.id === 'business-runtime')
    assert.equal(runtime.config.sharedSecretFile, undefined)
    assert.throws(() => readBusinessLaunchConfig(f.file, { agentId: 'soc', name: 'published' }), /sharedSecretFile/)
    instances[0].identityMode = 'unexpected'
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, gateway: { instances } }))
    assert.throws(() => readBusinessLaunchConfig(f.file, f.input), /身份模式无效/)
  }
})

test('尚未登记的新开发实例在预检和渲染时无需密钥，启动参数不能覆盖已有发布登记', t => {
  const f = fixture(t), access = join(f.config.assetRoot, 'config/business-access.json')
  rmSync(f.config.sharedSecretFile)
  const input = { ...f.input, identityMode: 'development' }
  const config = readBusinessLaunchConfig(f.file, input)
  const result = JSON.parse(execFileSync(process.execPath, [new URL('./business.ts', import.meta.url).pathname, f.file],
    { input: JSON.stringify({ agentId: input.agentId, name: input.name, identityMode: input.identityMode }), encoding: 'utf8' }))
  assert.equal(result.development, true)
  const rendered = renderBusinessInstance(config, input)
  assert.equal(rendered.runtimeConfig.sharedSecretFile, undefined)
  assert.ok(!yaml.load(rendered.compose).services.dsh.volumes.some(item => item.target === '/opt/harness-business/shared-secret'))
  assert.throws(() => readBusinessLaunchConfig(f.file, { ...input, identityMode: 'published' }), /sharedSecretFile/)
  writeFileSync(access, JSON.stringify({ schemaVersion: 1, enabled: true, gateway: { instances: [
    { agentId: input.agentId, instanceId: input.name, identityMode: 'published' },
  ] } }))
  assert.throws(() => readBusinessLaunchConfig(f.file, input), /身份模式无效/)
  assert.throws(() => renderBusinessInstance(config, input), /身份模式无效/)
})

test('业务访问配置中的相对密钥路径按当前数据根解析并用于容器挂载', t => {
  const f = fixture(t)
  const file = join(f.config.assetRoot, 'config/business-access.json')
  const secret = join(f.config.assetRoot, '.local/business-control-mock/gateway-secret.bin')
  mkdirSync(dirname(secret), { recursive: true })
  writeFileSync(secret, 'b'.repeat(48))
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true, agents: [],
    gateway: { host: '127.0.0.1', port: 53105, publicOrigin: 'http://host.docker.internal:53105',
      sharedSecretFile: '.local/business-control-mock/gateway-secret.bin', instances: [] } }))
  const config = readBusinessLaunchConfig(file)
  assert.equal(config.assetRoot, f.config.assetRoot)
  assert.equal(config.sharedSecretFile, secret)
  assert.equal(config.coordinatorOrigin, 'http://host.docker.internal:53105')
})

test('网页入口保留登记错误并隐藏配置解析细节', t => {
  const f = fixture(t), file = join(f.config.assetRoot, 'config/business-access.json')
  const state = join(f.root, 'instances'), directory = join(state, f.input.name)
  mkdirSync(directory, { recursive: true })
  const selected = { agentId: f.input.agentId, instanceId: f.input.name, sourceDigest: f.input.sourceDigest, accessMode: 'anonymous' }
  const basePath = `/agents/${selected.agentId}/instances/${selected.instanceId}/`
  writeFileSync(join(directory, 'instance.json'), JSON.stringify({ asset_root: f.config.assetRoot, agent_id: selected.agentId,
    web_base_path: basePath, business_control: { runtime_generation: 'generation-test', source_digest: f.input.sourceDigest, origin: 'http://127.0.0.1:53191' } }))
  const run = () => spawnSync(process.execPath, [new URL('./business.ts', import.meta.url).pathname,
    '--entry', f.config.assetRoot, selected.agentId, selected.instanceId], {
    encoding: 'utf8', env: { ...process.env, HARNESS_INSTANCE_STATE_ROOT: state },
  })
  const access = { enabled: true, gateway: { publicOrigin: 'http://business.localhost:53190', instances: [selected] } }
  writeFileSync(file, JSON.stringify(access))
  const success = run()
  assert.equal(success.status, 0, success.stderr)
  assert.deepEqual(JSON.parse(success.stdout), { url: `http://business.localhost:53190${basePath}`, accessMode: 'anonymous' })
  for (const [instances, reason] of [
    [[], '实例未向业务网关开放'],
    [[{ ...selected, sourceDigest: 'sha256:other' }], '业务实例来源与网关登记不一致'],
  ]) {
    writeFileSync(file, JSON.stringify({ ...access, gateway: { ...access.gateway, instances } }))
    const failed = run()
    assert.equal(failed.status, 1)
    assert.ok(failed.stderr.includes(`BUSINESS_STARTUP_ERROR:${reason}`))
  }
  writeFileSync(file, '{"private-secret-value":')
  const malformed = run()
  assert.equal(malformed.status, 1)
  assert.ok(malformed.stderr.includes('BUSINESS_STARTUP_ERROR:业务网页入口配置或实例登记读取失败'))
  assert.ok(!malformed.stderr.includes('private-secret-value'))
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
  assert.equal(patch.find(item => item.id === 'web-runtime').config.publicUrl, 'http://host.docker.internal:53190/agents/soc/instances/business-test/')
  assert.ok(compose.services.dsh.volumes.every(item => item.read_only))
  assert.ok(patch.some(item => item.id === 'mcp-session-manager' && item.disabled))
  assert.ok(!patch.some(item => item.id === 'schedule' && item.disabled), '自动化任务按当前需求开放')
  assert.ok(!patch.some(item => item.id?.startsWith('tool-')), '启动器不得额外停用来源中的原生工具')
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
  assert.equal(result.registration.scheduling_supported, true)
  assert.equal(result.registration.origin, 'http://127.0.0.1:53191')
  assert.ok(!result.patch.includes('a'.repeat(32)))
  assert.ok(!compose.services.dsh.volumes.some(item => item.source === f.config.assetRoot || item.target === '/opt/harness-business-assets'))
  assert.ok(compose.services.dsh.volumes.some(item => item.source === join(f.config.assetRoot, 'config') && item.target === '/opt/harness-business-assets/config' && item.read_only))
  assert.ok(compose.services.dsh.volumes.some(item => item.source === mcpCredentialPaths(f.config.assetRoot).directory && item.target === mcpCredentialPaths('/opt/harness-business-assets').directory && item.read_only))
  assert.ok(!compose.services.dsh.volumes.some(item => /\/(?:agents|evolution|credentials)$/.test(item.source)))
})

test('未迁移的凭据拒绝生成研究挂载，不回退到整个数据根', t => {
  const f = fixture(t)
  rmSync(mcpCredentialPaths(f.config.assetRoot).directory, { recursive: true })
  assert.throws(() => renderBusinessInstance(f.config, f.input), /平台 prepare/)
})

test('业务公开根使用网关来源和实例子路径，不暴露容器监听地址', t => {
  const f = fixture(t)
  const config = { ...f.config, coordinatorOrigin: 'http://192.0.2.20:53105' }
  const input = { ...f.input, name: 'inspection-code-only', agentId: 'inspection-delivery-demo' }
  const patch = yaml.load(renderBusinessInstance(config, input).patch)
  const publicUrl = patch.find(item => item.id === 'web-runtime').config.publicUrl
  assert.equal(publicUrl, 'http://192.0.2.20:53105/agents/inspection-delivery-demo/instances/inspection-code-only/')
  assert.equal(new URL('api/task-examples/artifact', publicUrl).href,
    'http://192.0.2.20:53105/agents/inspection-delivery-demo/instances/inspection-code-only/api/task-examples/artifact')
})

test('免认证来源不会被转为业务实例', t => {
  const f = fixture(t)
  const compose = yaml.load(f.input.compose)
  compose.services.dsh.command.push('/opt/dsh-adapter/verification-home-controls/web-unsafe-no-auth.patch.yml')
  assert.throws(() => renderBusinessInstance(f.config, { ...f.input, compose: yaml.dump(compose) }))
})

test('业务bridge保留宿主别名及既有映射，不重复通用启动器的host-gateway条目', t => {
  const f = fixture(t), compose = yaml.load(f.input.compose)
  compose.services.dsh.extra_hosts = ['host.docker.internal:host-gateway', 'mock.internal:192.0.2.10']
  const result = renderBusinessInstance(f.config, { ...f.input, compose: yaml.dump(compose) })
  const service = yaml.load(result.compose).services.dsh
  assert.deepEqual(service.extra_hosts, ['host.docker.internal:host-gateway', 'mock.internal:192.0.2.10'])
  assert.equal(service.network_mode, undefined)
  assert.deepEqual(service.networks, ['business'])
})

test('开发来源无 MCP seed 或 manager 时沿用 DSH 原生来源装载', t => {
  const f = fixture(t), seed = join(f.managed, 'web-profile.seed.patch.yml')
  rmSync(seed)
  rmSync(mcpCredentialPaths(f.config.assetRoot).directory, { recursive: true })
  for (const source of ['absent', 'native-only']) {
    if (source === 'native-only') writeFileSync(seed, yaml.dump([{ insert: [{ id: 'native-example', name: '/opt/dsh-managed/native-example.mjs' }] }]))
    const result = renderBusinessInstance(readBusinessLaunchConfig(f.file), f.input)
    const compose = yaml.load(result.compose), patch = yaml.load(result.patch)
    assert.ok(compose.services.dsh.command.includes('managed.patch.yml'))
    assert.ok(patch.flatMap(item => item.insert ?? []).some(item => item.id === 'business-runtime'))
    assert.ok(!patch.some(item => item.id === 'mcp-session-manager' || item.id === 'mcp-manager'))
    assert.ok(!patch.flatMap(item => item.insert ?? []).some(item => item.id === 'business-mcp-manager'))
    assert.ok(!compose.services.dsh.volumes.some(item => item.source === mcpCredentialPaths(f.config.assetRoot).directory))
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

test('业务实例从固定 Candidate 声明装载本地工具与定时研判路由', t => {
  const f = fixture(t), matrix = join(f.managed, 'role-tool-matrix.yaml')
  writeFileSync(matrix, `schema_version: "2.0"
runtime_capabilities:
  local_tools:
    - skill
    - analyze_threat_incident
    - analyze_pending_threat_incidents
    - delegate_threat_analysis
    - delegate_fault_analysis
  local_model_routes:
    - provider: threat-analysis-automation
      model: scheduled-batch
    - provider: threat-analysis-delivery
      model: fixed-summary
    - provider: security-operation-delivery
      model: fixed-operation-result
`)
  const before = businessSourceDigest({ managed: f.managed })
  const rendered = renderBusinessInstance(f.config, { ...f.input, sourcePaths: { managed: f.managed } })
  const runtime = yaml.load(rendered.patch).flatMap(item => item.insert ?? []).find(item => item.id === 'business-runtime')
  assert.deepEqual(runtime.config.localTools, ['skill', 'analyze_threat_incident', 'analyze_pending_threat_incidents', 'delegate_threat_analysis', 'delegate_fault_analysis'])
  assert.deepEqual(rendered.localModelRoutes, [{ provider: 'threat-analysis-automation', model: 'scheduled-batch' }, { provider: 'threat-analysis-delivery', model: 'fixed-summary' },
    { provider: 'security-operation-delivery', model: 'fixed-operation-result' }])
  writeFileSync(matrix, readFileSync(matrix, 'utf8') + '# revised\n')
  assert.notEqual(businessSourceDigest({ managed: f.managed }), before)
  writeFileSync(matrix, `runtime_capabilities:\n  local_tools: [skill, skill]\n  local_model_routes: []\n`)
  assert.throws(() => renderBusinessInstance(f.config, f.input), /业务本地能力声明无效/)
})

test('本地适配器声明保留绝对模型ID，provider与非法字符仍按既有边界校验', t => {
  const f = fixture(t), matrix = join(f.managed, 'role-tool-matrix.yaml')
  const route = { provider: 'transformers-serve', model: '/root/autodl-tmp/hep-medium-security/models/Qwen3.5-2B' }
  const declare = routes => writeFileSync(matrix, yaml.dump({ runtime_capabilities: { local_tools: ['read_security_ops_context'], local_model_routes: routes } }))
  declare([{ provider: 'harness-workflow', model: 'hybrid-v1' }, route])
  const originalConfig = readFileSync(f.file)
  const rendered = renderBusinessInstance(f.config, { ...f.input, sourcePaths: { managed: f.managed } })
  assert.deepEqual(rendered.localModelRoutes, [{ provider: 'harness-workflow', model: 'hybrid-v1' }, route])
  assert.deepEqual(readFileSync(f.file), originalConfig, '本地适配器装配不改平台启动配置')
  for (const invalid of [
    { ...route, provider: '/transformers-serve' },
    { ...route, provider: 'transformers serve' },
    { ...route, model: '/root/models/Qwen 3.5-2B' },
    { ...route, model: '/root/models/Qwen3.5-2B?revision=main' },
  ]) {
    declare([invalid])
    assert.throws(() => renderBusinessInstance(f.config, { ...f.input, sourcePaths: { managed: f.managed } }), /业务本地能力声明无效/)
  }
})


test('固定来源中的平台分组连接随部署入口装配，不改写资产或外部地址', t => {
  const f = fixture(t), file = join(f.managed, 'agent.patch.yml')
  writeFileSync(join(f.config.assetRoot, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    gateway: { managementUrl: 'http://current.example/hep/' } }))
  const entries = [{ insert: [{ id: 'analysis', config: { connections: { runtimeGroup: {
    id: 'threat-analysis-runtime', url: 'http://old.example/hep/mcp/groups/threat-analysis-runtime/v2' } }, external: 'http://external.example/mcp' } }] }]
  writeFileSync(file, yaml.dump(entries).replace(/^(\s*)external: /m, (_, indent) => `${indent}watch: !!js process.env.DSH_HARNESS_MODE === 'authoring'\n${indent}external: `))
  const original = readFileSync(file, 'utf8')
  const result = renderBusinessInstance(f.config, { ...f.input, managedPatch: file })
  const patch = yaml.load(result.patch, { schema: yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })) }).find(item => item.id === 'analysis')
  assert.equal(patch.config.connections.runtimeGroup.url, 'http://current.example/hep/mcp/groups/threat-analysis-runtime/v2')
  assert.equal(patch.config.external, 'http://external.example/mcp')
  assert.equal(patch.config.watch, "process.env.DSH_HARNESS_MODE === 'authoring'")
  assert.match(result.patch, /!!js/)
  assert.equal(readFileSync(file, 'utf8'), original)
})
