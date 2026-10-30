import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
process.env.HARNESS_DSH_ENTRY ??= '/opt/dsh/npm/lib/node_modules/@deepseek-ai/dsh/package.json'
import { initializeStandalone, configureStandalone, projectManagedPatch, prepareStandaloneSdk } from '../src/standalone/bootstrap.ts'
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
  writeFileSync(join(installation, 'package.json'), JSON.stringify({ name: '@fixture/cli', dependencies: {} }))
  writeFileSync(join(root, 'assets/managed/agent.patch.yml'), '- id: agent-default-model\n  config: {provider: old, model: old}\n- insert:\n    - id: business-tools\n      name: /opt/dsh-managed/tools.mjs\n    - id: mcp-session-manager\n      name: /opt/dsh-managed/mcp-manager.mjs\n      config:\n        servers:\n          - id: group-one\n')
  const seed = { agentId: 'demo', experimentId: 'EXP-demo-001', presetId: 'demo', profilePatch: 'agent.patch.yml', modelPatch: [{ id: 'agent-default-model', config: { provider: 'api', model: 'model-a' } }], mcp: { servers: [], groups: [{ id: 'group-one', members: [] }], sharedToken: 'a'.repeat(64) } }
  writeFileSync(join(root, 'config-seed/standalone.json'), JSON.stringify(seed))
  writeFileSync(join(root, 'config-seed/environment.llm-api-key'), JSON.stringify({ DEMO_LLM_API_KEY: 'fixture-value' }))
  return { root, home, seed, installAnchor: join(installation, 'package.json') }
}

test('新 HOME 原生初始化一次，冻结业务配置保留，模型与 MCP 当前配置不会被重启种子覆盖', t => {
  const f = fixture(t)
  assert.equal(initializeStandalone(f).initialized, true)
  const first = readStandaloneConfig(f.home)
  assert.deepEqual(first.mcp.mountServerIds, ['group-one'])
  const runtime = readFileSync(join(f.home, 'standalone/runtime.patch.yml'), 'utf8')
  assert.match(runtime, /business-tools/)
  assert.doesNotMatch(runtime, /mcp-manager\.mjs|provider: old|business-runtime/)
  assert.match(runtime, /standalone-plugin\.js/)
  const changed = { ...first, mcp: { ...first.mcp, sharedToken: 'b'.repeat(64) } }
  writeFileSync(join(f.home, 'standalone/config.json'), JSON.stringify(changed))
  writeFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), '# 原生UI保存的新模型\n[]\n')
  assert.equal(initializeStandalone(f).initialized, false)
  assert.equal(readStandaloneConfig(f.home).mcp.sharedToken, 'b'.repeat(64))
  assert.match(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), /原生UI保存/)
  assert.equal(existsSync(join(f.home, 'profiles/node_modules/@fixture/cli')), true)
})

test('明确重配仅更新模型/MCP，保留业务身份及专用凭据路径', async t => {
  const f = fixture(t)
  initializeStandalone(f)
  const path = join(f.root, 'replacement.json')
  writeFileSync(path, JSON.stringify({ modelPatch: [{ id: 'agent-default-model', config: { provider: 'new-api', model: 'model-b' } }], environment: { DEMO_LLM_API_KEY: 'new-value' } }))
  assert.equal((await configureStandalone(path, f)).restartRequired, true)
  assert.equal(readStandaloneConfig(f.home).agentId, 'demo')
  assert.match(readFileSync(join(f.home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), /new-api/)
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'standalone/environment.llm-api-key'))), { DEMO_LLM_API_KEY: 'new-value' })
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

test('选定分组的业务连接配置动态指向本地桥，其他外部服务地址保持原值', () => {
  const rows = projectManagedPatch('- insert:\n    - id: threat-analysis\n      name: /opt/dsh-managed/threat.mjs\n      config:\n        connections:\n          runtimeGroup:\n            id: selected\n            url: http://old-platform:18120/hep/mcp/groups/selected/v2\n        external: http://independent-mcp/mcp\n', ['selected'])
  const plugin = rows[0].insert[0]
  assert.deepEqual(plugin.inject, ['webServer'])
  assert.equal(plugin.config.external, 'http://independent-mcp/mcp')
  const ctx = { webServer: { publicPath: path => '/assistant' + path, getOrigin: () => 'http://172.27.0.2:3080' } }
  const actual = new Function('ctx', `return (${plugin.config.connections.runtimeGroup.url.__dshExpression})`)(ctx)
  assert.equal(actual, 'http://172.27.0.2:3080/assistant/mcp/groups/selected/v2')
  assert.doesNotMatch(actual, /old-platform|18120/)
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
  assert.equal(existsSync(join(f.home, 'standalone/input.json')), false)
})
