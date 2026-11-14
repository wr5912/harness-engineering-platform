import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { dump, load, FAILSAFE_SCHEMA, Type } from 'js-yaml'
process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
import { initializeStandalone, configureStandalone, configureMcpConnection, projectManagedPatch, prepareStandaloneSdk } from '../src/standalone/bootstrap.ts'
import { readStandaloneConfig } from '../src/standalone/config.ts'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'standalone-runtime-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'bundle'), home = join(directory, 'home'), installation = join(directory, 'image-cli')
  mkdirSync(join(root, 'config-seed'), { recursive: true })
  mkdirSync(join(root, 'assets/managed'), { recursive: true })
  mkdirSync(join(root, 'runtime'), { recursive: true })
  writeFileSync(join(root, 'runtime/package.json'), JSON.stringify({ type: 'module' }))
  writeFileSync(join(root, 'runtime/standalone-plugin.js'), `export { validateConfiguration } from ${JSON.stringify(new URL('../lib/mcp-manager.js', import.meta.url).href)};`)
  mkdirSync(installation, { recursive: true })
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ name: '@fixture/cli', dependencies: { '@deepseek-ai/dsh-client-connection': '*' } }))
  const connection = join(installation, 'node_modules/@deepseek-ai/dsh-client-connection')
  mkdirSync(connection, { recursive: true })
  writeFileSync(join(connection, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-client-connection', exports: { './package.json': './package.json', './client': { default: './client.browser.js' } }, dsh: { client: { inject: [], platform: 'web', immediately: true } } }))
  writeFileSync(join(connection, 'client.browser.js'), '// 同镜像原生浏览器连接\n')
  writeFileSync(join(root, 'assets/managed/agent.patch.yml'), '- id: agent-default-model\n  config: {provider: old, model: old}\n- insert:\n    - id: business-tools\n      name: /opt/dsh-managed/tools.mjs\n    - id: mcp-session-manager\n      name: /opt/dsh-managed/mcp-manager.mjs\n      config:\n        servers:\n          - id: group-one\n            url: http://platform.test/mcp/groups/group-one/v2\n')
  const seed = { agentId: 'demo', experimentId: 'EXP-demo-001', presetId: 'demo', profilePatch: 'agent.patch.yml', modelPatch: [{ id: 'agent-default-model', config: { provider: 'api', model: 'model-a' } }], mcp: { servers: [], groups: [{ id: 'group-one', members: [] }], sharedToken: 'a'.repeat(64) } }
  writeFileSync(join(root, 'config-seed/standalone.json'), JSON.stringify(seed))
  writeFileSync(join(root, 'config-seed/environment.llm-api-key'), JSON.stringify({ DEMO_LLM_API_KEY: 'fixture-value' }))
  return { root, home, seed, installAnchor: join(installation, 'package.json') }
}

test('新 HOME 原生初始化一次，冻结业务配置保留，模型与 MCP 当前配置不会被重启种子覆盖', t => {
  const f = fixture(t)
  assert.equal(initializeStandalone(f).initialized, true)
  const first = readStandaloneConfig(f.home)
  assert.equal(first.mcp.mountServerIds, undefined)
  const runtime = readFileSync(join(f.home, 'standalone/runtime.patch.yml'), 'utf8')
  assert.match(runtime, /business-tools/)
  assert.doesNotMatch(runtime, /mcp-manager\.mjs|provider: old|business-runtime/)
  assert.match(runtime, /standalone-plugin\.js/)
  assert.match(runtime, /standalone\/connection\/index\.mjs/)
  const connection = JSON.parse(readFileSync(join(f.home, 'standalone/connection/package.json')))
  assert.deepEqual(connection.dsh.client, { inject: [], platform: 'web', immediately: true })
  assert.equal(connection.name, '@deepseek-ai/dsh-client-connection')
  assert.equal(realpathSync(join(f.home, 'standalone/connection/client.browser.js')), join(dirname(f.installAnchor), 'node_modules/@deepseek-ai/dsh-client-connection/client.browser.js'))
  const schema = FAILSAFE_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: expression => expression })])
  const web = load(runtime, { schema }).flatMap(row => row.insert ?? []).find(row => row.id === 'web-runtime')
  assert.deepEqual(web.inject, ['webStartup'])
  assert.equal(web.config.publicUrl, 'ctx.webStartup.publicUrl')
  const changed = { ...first, mcp: { ...first.mcp, sharedToken: 'b'.repeat(64) } }
  writeFileSync(join(f.home, 'standalone/config.json'), JSON.stringify(changed))
  writeFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), '# 原生UI保存的新模型\n[]\n')
  writeFileSync(join(f.root, 'assets/managed/agent.patch.yml'), '- insert:\n    - id: changed-business-ui\n      name: /opt/dsh-managed/changed-ui.mjs\n')
  assert.equal(initializeStandalone(f).initialized, false)
  const restarted = readFileSync(join(f.home, 'standalone/runtime.patch.yml'), 'utf8')
  assert.match(restarted, /changed-business-ui/)
  assert.doesNotMatch(restarted, /business-tools/)
  assert.equal(readStandaloneConfig(f.home).mcp.sharedToken, 'b'.repeat(64))
  assert.match(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), /原生UI保存/)
  assert.equal(existsSync(join(f.home, 'profiles/node_modules/@fixture/cli')), true)
})

test('原生目录布局在 HOME 生成投影，重启读取新资产且保留当前模型、连接和会话', t => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'harness/dsh'), { recursive: true })
  renameSync(join(f.root, 'assets/managed'), join(f.root, 'harness/dsh/managed'))
  mkdirSync(join(f.root, 'harness/dsh/presets'), { recursive: true })
  mkdirSync(join(f.root, 'config'), { recursive: true })
  renameSync(join(f.root, 'config-seed'), join(f.root, 'config/seed'))
  writeFileSync(join(f.root, 'harness/harness.yaml'), 'loadable_assets: {}\n')
  const patch = join(f.root, 'harness/dsh/managed/agent.patch.yml')
  const original = readFileSync(patch)
  assert.equal(initializeStandalone(f).initialized, true)
  assert.deepEqual(readFileSync(patch), original)
  assert.equal(realpathSync(join(f.home, 'standalone/managed/agent.patch.yml')), patch)
  const model = join(f.home, 'profiles/standalone/cordis.patch.yml')
  writeFileSync(model, '- id: agent-default-model\n  config: {provider: api, model: current-model}\n')
  const config = readStandaloneConfig(f.home)
  writeFileSync(join(f.home, 'session'), 'keep session')
  writeFileSync(patch, original + '\n- id: newly-added-business-tool\n  name: /opt/dsh-managed/new.mjs\n')
  assert.equal(initializeStandalone(f).initialized, false)
  assert.match(readFileSync(join(f.home, 'standalone/runtime.patch.yml'), 'utf8'), /newly-added-business-tool/)
  assert.match(readFileSync(model, 'utf8'), /current-model/)
  assert.deepEqual(readStandaloneConfig(f.home).mcp, config.mcp)
  assert.equal(readFileSync(join(f.home, 'session'), 'utf8'), 'keep session')
})

test('独立 Web 访问声明随 Harness 读取，不支持的模式明确报错而非静默匿名运行', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'assets/harness.yaml'), 'standalone:\n  web:\n    access: anonymous-lan\n')
  initializeStandalone(f)
  writeFileSync(join(f.root, 'assets/harness.yaml'), 'standalone:\n  web:\n    access: authenticated\n')
  assert.throws(() => initializeStandalone(f), /standalone.web.access/)
})

test('初始化保留 Harness 直连 MCP，已有连接优先，平台地址保持原样，重配后重启不覆盖', async t => {
  const f = fixture(t)
  const direct = { id: 'report-write', enabled: true, serverName: 'report-write', url: 'http://external.test/mcp', headers: [{ name: 'X-API-Key', value: 'fixture-key' }], tools: { mode: 'selected', names: ['save', 'get'] } }
  const existing = { id: 'existing', enabled: true, url: 'http://current.test/mcp', tools: { mode: 'all', names: [] } }
  f.seed.mcp.servers = [existing]
  writeFileSync(join(f.root, 'config-seed/standalone.json'), JSON.stringify(f.seed))
  writeFileSync(join(f.root, 'assets/managed/agent.patch.yml'), dump([{ id: 'mcp-session-manager', config: { servers: [
    { id: 'group-one', url: 'http://old-platform.test/mcp/groups/group-one/v2' },
    direct, { ...existing, url: 'http://stale.test/mcp' }, { id: 'minimal', url: 'http://minimal.test/mcp' }, { id: 'disabled', enabled: false, url: 'http://disabled.test/mcp' },
  ] } }]))
  initializeStandalone(f)
  const first = readStandaloneConfig(f.home)
  assert.deepEqual(first.mcp.servers.map(server => server.id), ['existing', 'group-one', 'report-write', 'minimal', 'disabled'])
  assert.equal(first.mcp.servers[1].url, 'http://old-platform.test/mcp/groups/group-one/v2')
  assert.equal(first.mcp.servers[4].enabled, false)
  assert.equal(first.mcp.mountServerIds, undefined)
  await configureMcpConnection({ id: 'report-write', url: 'http://new.test/mcp', token: 'new-token' }, f)
  const changed = readStandaloneConfig(f.home)
  assert.equal(initializeStandalone(f).initialized, false)
  assert.deepEqual(readStandaloneConfig(f.home), changed)
  assert.equal(changed.mcp.servers[2].url, 'http://new.test/mcp')
  assert.deepEqual(changed.mcp.servers[2].headers, [...direct.headers, { name: 'Authorization', value: 'Bearer new-token' }])
})

test('已有安装升级移除嵌入执行配置，恢复远程连接并保留原生模型及会话', t => {
  const f = fixture(t)
  initializeStandalone(f)
  const current = readStandaloneConfig(f.home)
  const legacy = { ...current, compositions: { flows: ['old-flow'] }, extensions: ['old-runtime'], fixedBindings: [], mcp: { ...current.mcp, servers: [{ id: 'platform-compositions', url: 'http://localhost/embedded' }], groups: [{ id: 'local-executor', members: [{ serverId: 'platform-compositions' }] }], mountServerIds: ['local-executor'] } }
  writeFileSync(join(f.home, 'standalone/config.json'), JSON.stringify(legacy))
  writeFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), '# 用户原生模型\n[]\n')
  mkdirSync(join(f.home, 'sessions'), { recursive: true })
  writeFileSync(join(f.home, 'sessions/retained.json'), '{"id":"retained"}')
  assert.equal(initializeStandalone(f).initialized, false)
  const migrated = readStandaloneConfig(f.home)
  assert.deepEqual(migrated.mcp.servers.map(row => row.id), ['group-one'])
  assert.equal(migrated.mcp.servers[0].url, 'http://platform.test/mcp/groups/group-one/v2')
  assert.deepEqual(migrated.mcp.groups, [])
  assert.equal('compositions' in migrated, false)
  assert.equal('extensions' in migrated, false)
  assert.equal('fixedBindings' in migrated, false)
  assert.match(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), /用户原生模型/)
  assert.equal(readFileSync(join(f.home, 'sessions/retained.json'), 'utf8'), '{"id":"retained"}')
})

test('明确重配仅更新模型/MCP，保留业务身份及专用凭据路径', async t => {
  const f = fixture(t)
  initializeStandalone(f)
  const path = join(f.root, 'replacement.json')
  writeFileSync(path, JSON.stringify({ modelPatch: [{ id: 'agent-default-model', config: { provider: 'new-api', model: '本地模型' } }], environment: { DEMO_LLM_API_KEY: 'new-value', MODEL_DISPLAY_NAME: '业务智能体' } }))
  assert.equal((await configureStandalone(path, f)).restartRequired, true)
  assert.equal(readStandaloneConfig(f.home).agentId, 'demo')
  assert.match(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), /new-api/)
  const environment = readFileSync(join(f.home, 'standalone/environment.llm-api-key'), 'utf8')
  assert.equal(environment, JSON.stringify({ DEMO_LLM_API_KEY: 'new-value', MODEL_DISPLAY_NAME: '业务智能体' }, null, 2) + '\n')
  const config = readFileSync(join(f.home, 'standalone/config.json'), 'utf8')
  assert.equal(config, JSON.stringify(JSON.parse(config), null, 2) + '\n')
  assert.ok(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8').includes('本地模型'))
  writeFileSync(path, JSON.stringify({ agentId: 'different' }))
  await assert.rejects(configureStandalone(path, f), /只接受/)
  assert.equal(readStandaloneConfig(f.home).agentId, 'demo')
})

test('业务 Patch 的 JS 表达式作为数据保留，剥离仅限平台包装而保留业务 Guard', () => {
  const result = projectManagedPatch('- insert:\n    - id: business-guard\n      name: /opt/dsh-managed/guard.mjs\n      config:\n        enabled: !!js process.env.ENABLED\n    - id: harness-model-runtime\n      name: /opt/runtime/business-runtime.js\n')
  assert.equal(result[0].insert[0].id, 'business-guard')
  assert.equal(result[0].insert.length, 1)
  assert.equal(result[0].insert[0].config.enabled.__dshExpression, 'process.env.ENABLED')
})

test('仅重配 MCP 时不回写过期模型种子，原生设置页面的新模型保持', async t => {
  const f = fixture(t)
  initializeStandalone(f)
  const native = '# 原生UI当前配置与JS表达式保持原字节\n- id: agent-default-model\n  config: {provider: native-ui, model: model-from-ui}\n- id: llm-deepseek\n  config:\n    apiKey: !!js process.env.MODEL_API_KEY\n'
  writeFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), native)
  const path = join(f.root, 'mcp-only.json')
  writeFileSync(path, JSON.stringify({ mcp: { servers: [], groups: [], sharedToken: 'c'.repeat(64) } }))
  await configureStandalone(path, f)
  assert.equal(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), native)
  assert.equal(readStandaloneConfig(f.home).mcp.sharedToken, 'c'.repeat(64))
})

test('业务连接配置保留原生平台地址，不投影成本地执行器', () => {
  const rows = projectManagedPatch('- insert:\n    - id: threat-analysis\n      name: /opt/dsh-managed/threat.mjs\n      config:\n        connections:\n          runtimeGroup:\n            id: selected\n            url: http://platform:18120/hep/mcp/groups/selected/v2\n        external: http://independent-mcp/mcp\n')
  const plugin = rows[0].insert[0]
  assert.equal(plugin.inject, undefined)
  assert.equal(plugin.config.connections.runtimeGroup.url, 'http://platform:18120/hep/mcp/groups/selected/v2')
  assert.equal(plugin.config.external, 'http://independent-mcp/mcp')
})

test('当前模型仅保存在原生设置，MCP配置中不维护另一份可编辑模型副本', t => {
  const f = fixture(t)
  initializeStandalone(f)
  const persisted = JSON.parse(readFileSync(join(f.home, 'standalone/config.json')))
  assert.equal(persisted.modelPatch, undefined)
  assert.equal(persisted.defaultModel, undefined)
  assert.match(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), /model-a/)
})


test('MCP 重配使用真实管理器校验，坏地址和重复工具不会覆盖当前配置或凭据', async t => {
  const f = fixture(t)
  initializeStandalone(f)
  const configBefore = readFileSync(join(f.home, 'standalone/config.json'), 'utf8')
  const environmentBefore = readFileSync(join(f.home, 'standalone/environment.llm-api-key'), 'utf8')
  const modelBefore = readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8')
  const path = join(f.root, 'invalid.json')
  const server = { id: 'test', enabled: true, url: 'not-a-url', tools: { mode: 'all', names: [] } }
  writeFileSync(path, JSON.stringify({ mcp: { servers: [server], groups: [], sharedToken: 'a'.repeat(64) }, environment: { DEMO_LLM_API_KEY: 'must-not-save' } }))
  await assert.rejects(configureStandalone(path, f), /Invalid URL/)
  server.url = 'http://127.0.0.1:1/mcp'
  server.tools = { mode: 'selected', names: ['same', 'same'] }
  writeFileSync(path, JSON.stringify({ mcp: { servers: [server], groups: [], sharedToken: 'a'.repeat(64) } }))
  await assert.rejects(configureStandalone(path, f), /工具名重复/)
  assert.equal(readFileSync(join(f.home, 'standalone/config.json'), 'utf8'), configBefore)
  assert.equal(readFileSync(join(f.home, 'standalone/environment.llm-api-key'), 'utf8'), environmentBefore)
  assert.equal(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), modelBefore)
  server.tools = { mode: 'all', names: [] }
  writeFileSync(path, JSON.stringify({ mcp: { servers: [server], groups: [], sharedToken: 'a'.repeat(64) } }))
  await configureStandalone(path, f)
  assert.equal(readStandaloneConfig(f.home).mcp.servers[0].url, server.url, '保存格式合法配置不探测不可达的外部服务')
})

test('SDK 独立环境使用原生SDK组合和固定Preset，初始化及重配不自动提交输入', async t => {
  const f = fixture(t)
  f.seed.profile = 'sdk'
  const sdk = join(dirname(f.installAnchor), 'node_modules/@deepseek-ai/dsh-sdk-client')
  mkdirSync(sdk, { recursive: true })
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-sdk-client', type: 'module' }))
  writeFileSync(join(f.root, 'config-seed/standalone.json'), JSON.stringify(f.seed))
  writeFileSync(join(f.root, 'runtime/sdk-profile.patch.yml'), readFileSync(new URL('../../../runtime/adapters/dsh-container/sdk-profile.patch.yml', import.meta.url)))
  mkdirSync(join(f.root, 'sdk'), { recursive: true })
  writeFileSync(join(f.root, 'sdk/example.ts'), 'import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client"\n')
  writeFileSync(join(f.root, 'assets/harness.yaml'), 'loadable_assets:\n  preset_id: demo\n')
  initializeStandalone(f)
  const manifest = JSON.parse(readFileSync(join(f.home, 'profiles/standalone/package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'])
  const runtime = readFileSync(join(f.home, 'standalone/runtime.patch.yml'), 'utf8')
  assert.match(runtime, /sdk-preset.mts/)
  assert.match(runtime, /host: 127\.0\.0\.1/)
  assert.match(runtime, /port: 0/)
  assert.doesNotMatch(runtime, /container-web-app|web-runtime|webStartup/)
  assert.equal(existsSync(join(f.home, 'standalone/input.json')), false)
  const options = prepareStandaloneSdk(f)
  assert.equal(options.profile, 'standalone')
  assert.equal(options.provider, 'api')
  assert.equal(options.model, 'model-a')
  assert.equal(JSON.stringify(options).includes('fixture-value'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'standalone/sdk-options.json'), 'utf8')), options)
  assert.equal(existsSync(join(f.home, 'sessions')), false)
  const config = join(f.root, 'new-model.json')
  writeFileSync(config, JSON.stringify({ defaultModel: { provider: 'new-api', model: 'new-model' } }))
  await configureStandalone(config, f)
  assert.equal(prepareStandaloneSdk(f).model, 'new-model')
  writeFileSync(join(f.root, 'sdk/example.ts'), '// 更新后的原生 SDK 示例\n')
  assert.equal(initializeStandalone(f).initialized, false)
  assert.equal(readFileSync(join(f.home, 'standalone/sdk-app/example.ts'), 'utf8'), '// 更新后的原生 SDK 示例\n')
  assert.equal(prepareStandaloneSdk(f).model, 'new-model')
  assert.equal(existsSync(join(f.home, 'standalone/input.json')), false)
})

test('已有内嵌组合配置迁移为原生客户端，重配不再保存组合或派生服务', async t => {
  const f = fixture(t)
  f.seed.mcp.servers = [{ id: 'soc', enabled: true, specUrl: 'http://old.test/openapi.json' }]
  f.seed.mcp.groups = [{ id: 'policy-response', members: [{ serverId: 'platform-compositions', names: ['policy_change', 'get_composition_run'] }] }]
  f.seed.compositions = { schema_version: '1.0', compositions: [{ id: 'policy', published: { toolName: 'policy_change', title: '策略变更', description: '', connectionId: 'soc' } }] }
  writeFileSync(join(f.root, 'config-seed/standalone.json'), JSON.stringify(f.seed))
  initializeStandalone(f)
  await configureMcpConnection({ id: 'soc', url: 'http://new.test/openapi.json', token: 'new-key' }, f)
  const current = readStandaloneConfig(f.home)
  assert.equal(current.mcp.servers[0].specUrl, 'http://new.test/openapi.json')
  assert.equal(current.mcp.servers[0].apiKey, 'new-key')
  assert.deepEqual(current.mcp.groups, [])
  assert.equal(current.compositions, undefined)
  assert.equal(current.mcp.servers.some(server => server.id === 'platform-compositions'), false)
  await assert.rejects(configureStandalone({ mcp: { ...current.mcp, groups: [{ id: 'bad', members: [{ serverId: 'missing', names: ['query'] }] }] } }, f), /分组成员/)
  assert.deepEqual(readStandaloneConfig(f.home), current)
})

test('MCP 参数更新同一当前配置，按 ID 保留其他连接与原生模型，支持 OpenAPI 和 Bearer', async t => {
  const f = fixture(t)
  f.seed.mcp.servers = [
    { id: 'soc', enabled: true, specUrl: 'http://old.test/openapi.json', apiKey: 'old-key', authType: 'credential', authHeader: 'X-API-Key' },
    { id: 'direct', enabled: true, url: 'http://old.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer old-key' }, { name: 'X-Trace', value: 'preserve' }], tools: { mode: 'all', names: [] } },
  ]
  writeFileSync(join(f.root, 'config-seed/standalone.json'), JSON.stringify(f.seed))
  initializeStandalone(f)
  const model = readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8')
  await configureMcpConnection({ id: 'soc', url: 'http://new.test/openapi.json', token: 'new-key' }, f)
  let current = readStandaloneConfig(f.home)
  assert.equal(current.mcp.servers[0].specUrl, 'http://new.test/openapi.json')
  assert.equal(current.mcp.servers[0].apiKey, 'new-key')
  assert.equal(current.mcp.servers[0].authHeader, 'X-API-Key')
  assert.deepEqual(current.mcp.servers[1], f.seed.mcp.servers[1])
  await configureMcpConnection({ id: 'direct', url: 'http://new.test/mcp' }, f)
  assert.equal(readStandaloneConfig(f.home).mcp.servers[1].headers[0].value, 'Bearer old-key')
  await configureMcpConnection({ id: 'direct', token: 'Bearer replacement' }, f)
  current = readStandaloneConfig(f.home)
  assert.deepEqual(current.mcp.servers[1].headers, [{ name: 'X-Trace', value: 'preserve' }, { name: 'Authorization', value: 'Bearer replacement' }])
  assert.equal(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), model)
  await configureMcpConnection({ id: 'direct', token: '' }, f)
  assert.deepEqual(readStandaloneConfig(f.home).mcp.servers[1].headers, [{ name: 'X-Trace', value: 'preserve' }])
  const before = readFileSync(join(f.home, 'standalone/config.json'), 'utf8')
  for (const input of [{ id: 'missing', token: 'value' }, { id: 'soc' }, { id: 'soc', url: 'invalid' }, { id: 'soc', url: 'file:///tmp/private' }, { id: 'soc', token: 'bad\r\nvalue' }]) {
    await assert.rejects(configureMcpConnection(input, f))
    assert.equal(readFileSync(join(f.home, 'standalone/config.json'), 'utf8'), before)
  }
})
