import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = mkdtempSync(join(tmpdir(), 'models-projection-module-'))
await build({ entryPoints: [new URL('../src/models/projection.ts', import.meta.url).pathname], outfile: join(bundled, 'projection.mjs'),
  bundle: true, platform: 'node', format: 'esm' })
const { modelProviderReadiness, projectModelPolicy } = await import(`file://${join(bundled, 'projection.mjs')}`)
test.after(() => rmSync(bundled, { recursive: true, force: true }))

function assertDshPolicyAccepted(policy, root) {
  const policyFile = join(root, 'model-policy-preview.json')
  writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 })
  const script = `import importlib.util, pathlib, sys
from importlib.machinery import SourceFileLoader
spec = importlib.util.spec_from_loader('dsh_dev_model_contract', SourceFileLoader('dsh_dev_model_contract', sys.argv[1]))
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)
dev.read_model_policy(sys.argv[2], 'example-agent', repo=pathlib.Path(sys.argv[3]))
`
  const command = spawnSync('/usr/bin/python3', ['-c', script, new URL('../../../runtime/adapters/dsh-container/dsh-dev', import.meta.url).pathname, policyFile, root],
    { encoding: 'utf8' })
  assert.equal(command.status, 0, command.stderr || command.stdout)
}

function fixture(access) {
  const root = mkdtempSync(join(tmpdir(), 'hep-model-projection-'))
  mkdirSync(join(root, 'agents', 'example-agent'), { recursive: true })
  mkdirSync(join(root, 'config'))
  const manifest = `agent_id: example-agent\nmodel_access:\n  allowed:\n    - provider: legacy-only\n      model: legacy-model\n`
  writeFileSync(join(root, 'agents', 'example-agent', 'manifest.yaml'), manifest)
  const defaultFile = join(root, 'config', 'business-model-default.json')
  writeFileSync(defaultFile, `${JSON.stringify({ schema_version: '1.2', default: access.default })}\n`)
  return { root, manifest, defaultFile, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('平台投影从当前目录派生业务可选模型与凭据引用，忽略 Agent 旧标记', async () => {
  const source = fixture({ allowed: [{ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'acme', model: 'small' }], default: { provider: 'acme', model: 'small' } })
  try {
    const credentials = []
    const result = await projectModelPolicy(source.root, 'example-agent', {
      sessionController: { modelCatalog: async () => ({ default: { provider: 'deepseek-official', model: 'deepseek-flash' }, routableProviders: ['deepseek-official', 'acme'], failures: [], groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-v4-pro', name: 'Pro' }] },
        { id: 'acme', name: 'Acme', models: [{ id: 'small', name: 'Small' }, { id: 'large', name: 'Large' }] },
      ] }) },
      settingsController: { describe: () => ({ namespaces: [
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] } },
        { ns: 'llm-pi-ai', value: { providers: { acme: { api: 'openai-completions', baseURL: 'https://example.test/v1', apiKeyEnv: 'ACME_API_KEY', models: [{ id: 'small' }, { id: 'large' }] } } } },
      ] }) },
      credentials: { resolve: async ref => { credentials.push(ref); return { value: `secret-for-${ref}` } } },
      llm: { listConfigurableProviders: () => [{ provider: 'acme', settingsNs: 'llm-pi-ai', nativeAuth: { env: ['ACME_API_KEY'], oauth: false } }] },
    })
    assert.deepEqual(result.policy.allowed, [{ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'acme', model: 'small' }, { provider: 'acme', model: 'large' }])
    assert.equal(result.policy.manifest_sha256, createHash('sha256').update(source.manifest).digest('hex'))
    assert.deepEqual(result.policy.patch.find(item => item.id === 'llm-deepseek').config.models.map(item => item.id), ['deepseek-flash', 'deepseek-v4-pro'])
    assert.deepEqual(result.policy.patch.find(item => item.id === 'llm-pi-ai').config.providers.acme.models.map(item => item.id), ['small', 'large'])
    assert.deepEqual(credentials.sort(), ['ACME_API_KEY', 'DEEPSEEK_API_KEY'])
    assert.equal(JSON.stringify(result.policy).includes('secret-for-'), false)
  } finally { source.cleanup() }
})

test('实例显式模型覆盖统一默认，未标记模型与缺省选择均被拒绝', async () => {
  const flash = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const pro = { provider: 'deepseek-official', model: 'deepseek-pro' }
  const source = fixture({ allowed: [flash, pro], default: flash })
  const services = {
    sessionController: { modelCatalog: async () => ({ default: flash, routableProviders: ['deepseek-official'], failures: [], groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash' }, { id: 'deepseek-pro' }] },
    ] }) },
    settingsController: { describe: () => ({ namespaces: [{ ns: 'llm-deepseek', value: {} }] }) },
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    llm: { listConfigurableProviders: () => [] },
  }
  try {
    assert.deepEqual((await projectModelPolicy(source.root, 'example-agent', services)).policy.default, flash)
    assert.deepEqual((await projectModelPolicy(source.root, 'example-agent', services, pro)).policy.default, pro)
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', services, { provider: 'deepseek-official', model: 'other' }), /不在当前业务可用目录/)
    rmSync(source.defaultFile)
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', services), /选择业务智能体统一默认模型/)
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', services, pro), /选择业务智能体统一默认模型/)
  } finally { source.cleanup() }
})

test('统一默认修订变化进入实例投影，即使实例显式模型未变也使旧预览失效', async () => {
  const flash = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const pro = { provider: 'deepseek-official', model: 'deepseek-pro' }
  const source = fixture({ allowed: [flash, pro], default: flash })
  const services = {
    sessionController: { modelCatalog: async () => ({ default: flash, routableProviders: ['deepseek-official'], failures: [], groups: [
      { id: 'deepseek-official', models: [{ id: flash.model }, { id: pro.model }] },
    ] }) },
    settingsController: { describe: () => ({ namespaces: [{ ns: 'llm-deepseek', value: {} }] }) },
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    llm: { listConfigurableProviders: () => [] },
  }
  try {
    const original = (await projectModelPolicy(source.root, 'example-agent', services, pro)).policy
    writeFileSync(source.defaultFile, `${JSON.stringify({ schema_version: '1.2', default: pro })}\n`)
    const changed = (await projectModelPolicy(source.root, 'example-agent', services, pro)).policy
    assert.deepEqual(original.default, changed.default)
    assert.notEqual(original.business_model_revision, changed.business_model_revision)
    assertDshPolicyAccepted(changed, source.root)
  } finally { source.cleanup() }
})

test('旧 1.0 默认不会为新实例生效，即使显式指定模型也须先确认新默认', async () => {
  const selected = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const source = fixture({ allowed: [selected], default: selected })
  try {
    writeFileSync(source.defaultFile, `${JSON.stringify({ schema_version: '1.0', default: selected })}\n`)
    const services = {
      sessionController: { modelCatalog: async () => ({ default: selected, routableProviders: ['deepseek-official'], failures: [], groups: [
        { id: 'deepseek-official', models: [{ id: selected.model }] },
      ] }) },
      settingsController: { describe: () => ({ namespaces: [{ ns: 'llm-deepseek', value: {} }] }) },
      credentials: { resolve: async () => ({ value: 'key' }) },
      llm: { listConfigurableProviders: () => [] },
    }
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', services, selected), /旧配置不会自动生效/)
  } finally { source.cleanup() }
})

test('未选提供方缺密钥或动态端点不阻断已就绪默认模型，选中时仍拒绝', async () => {
  const ready = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const other = { provider: 'acme', model: 'small' }
  const source = fixture({ allowed: [ready, other], default: ready })
  const base = {
    sessionController: { modelCatalog: async () => ({ default: ready, routableProviders: ['deepseek-official', 'acme'], failures: [], groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash' }] },
      { id: 'acme', name: 'Acme', models: [{ id: 'small' }] },
    ] }) },
    settingsController: { describe: () => ({ namespaces: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      { ns: 'llm-pi-ai', value: { providers: { acme: { apiKeyEnv: 'ACME_API_KEY', api: 'openai-completions' } } } },
    ] }) },
    credentials: { resolve: async ref => ref === 'DEEPSEEK_API_KEY' ? { value: 'ready-key' } : undefined },
    llm: { listConfigurableProviders: () => [{ provider: 'acme', settingsNs: 'llm-pi-ai', nativeAuth: { env: ['ACME_API_KEY'], oauth: false } }] },
  }
  try {
    const projected = await projectModelPolicy(source.root, 'example-agent', base)
    assert.deepEqual(projected.policy.allowed, [ready, other])
    assert.deepEqual(projected.policy.default, ready)
    assert.deepEqual(projected.policy.credential_refs, ['DEEPSEEK_API_KEY'])
    assert.deepEqual(Object.keys(projected.environment), ['DEEPSEEK_API_KEY'])
    assert.deepEqual(projected.policy.patch.find(item => item.id === 'llm-pi-ai').config.providers.acme.models, [{ id: 'small' }])
    assert.equal(projected.policy.patch.find(item => item.id === 'llm-pi-ai').config.providers.acme.apiKeyEnv, undefined)
    assertDshPolicyAccepted(projected.policy, source.root)
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', base, other), /尚无业务实例可解析的 API Key/)

    const dynamic = { ...base,
      credentials: { resolve: async ref => ref === 'ACME_API_KEY' ? { value: 'other-key' }
        : ref === 'DEEPSEEK_API_KEY' ? { value: 'ready-key' } : undefined },
      llm: { listConfigurableProviders: () => [{ provider: 'acme', settingsNs: 'llm-pi-ai', nativeAuth: { env: ['ACME_API_KEY'], oauth: false }, baseURLEnv: ['ACME_BASE_URL'] }] },
    }
    const withMissingEndpoint = await projectModelPolicy(source.root, 'example-agent', dynamic)
    assert.deepEqual(withMissingEndpoint.policy.credential_refs, ['DEEPSEEK_API_KEY'])
    assert.deepEqual(Object.keys(withMissingEndpoint.environment), ['DEEPSEEK_API_KEY'])
    assert.equal(withMissingEndpoint.policy.patch.find(item => item.id === 'llm-pi-ai').config.providers.acme.apiKeyEnv, undefined)
    assertDshPolicyAccepted(withMissingEndpoint.policy, source.root)
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', dynamic, other), /动态端点未配置/)
  } finally { source.cleanup() }
})

test('模型从平台目录移除时拒绝生成业务启动投影', async () => {
  const source = fixture({ allowed: [{ provider: 'acme', model: 'small' }], default: { provider: 'acme', model: 'small' } })
  try {
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', {
      sessionController: { modelCatalog: async () => ({ default: { provider: 'other', model: 'one' }, groups: [], routableProviders: [], failures: [] }) },
      settingsController: { describe: () => ({ namespaces: [] }) },
      credentials: { resolve: async () => undefined },
      llm: { listConfigurableProviders: () => [] },
    }), /不在当前业务可用目录/)
  } finally { source.cleanup() }
})

test('DSH 内置提供方的空配置仍能投影所选模型，并按原生凭据名称传入', async () => {
  const source = fixture({ allowed: [{ provider: 'xiaomi-token-plan-cn', model: 'mimo-v2-flash' }], default: { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2-flash' } })
  try {
    const services = {
      sessionController: { modelCatalog: async () => ({ default: { provider: 'xiaomi-token-plan-cn', model: 'mimo-v2-flash' }, routableProviders: ['xiaomi-token-plan-cn'], failures: [], groups: [
        { id: 'xiaomi-token-plan-cn', name: 'MiMo', models: [{ id: 'mimo-v2-flash', name: 'MiMo Flash' }] },
      ] }) },
      settingsController: { describe: () => ({ namespaces: [{ ns: 'llm-pi-ai', value: { providers: { 'xiaomi-token-plan-cn': {} } } }] }) },
      credentials: { resolve: async ref => ref === 'XIAOMI_TOKEN_PLAN_CN_API_KEY' ? { value: 'credential-value' } : undefined },
      llm: { listConfigurableProviders: () => [{ provider: 'xiaomi-token-plan-cn', settingsNs: 'llm-pi-ai', nativeAuth: { env: ['XIAOMI_TOKEN_PLAN_CN_API_KEY'], oauth: true } }] },
    }
    const result = await projectModelPolicy(source.root, 'example-agent', services)
    assert.deepEqual(result.policy.credential_refs, ['XIAOMI_TOKEN_PLAN_CN_API_KEY'])
    assert.deepEqual(result.policy.patch.find(item => item.id === 'llm-pi-ai').config.providers['xiaomi-token-plan-cn'].models, [{ id: 'mimo-v2-flash' }])
    assert.equal(result.environment.XIAOMI_TOKEN_PLAN_CN_API_KEY, 'credential-value')
    assert.equal(JSON.stringify(result.policy).includes('credential-value'), false)
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', { ...services, credentials: { resolve: async () => undefined } }), /尚无业务实例可解析的 API Key/)
  } finally { source.cleanup() }
})

test('动态端点变量随模型环境投影，连接状态保留实际调用待核对', async () => {
  const source = fixture({ allowed: [{ provider: 'azure', model: 'gpt-4o' }], default: { provider: 'azure', model: 'gpt-4o' } })
  try {
    const services = {
      sessionController: { modelCatalog: async () => ({ default: { provider: 'azure', model: 'gpt-4o' }, routableProviders: ['azure'], failures: [], groups: [
        { id: 'azure', name: 'Azure', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
      ] }) },
      settingsController: { describe: () => ({ namespaces: [{ ns: 'llm-pi-ai', value: { providers: { azure: {} } } }] }) },
      credentials: { resolve: async ref => ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL'].includes(ref) ? { value: `value-for-${ref}` } : undefined },
      llm: { listConfigurableProviders: () => [{ provider: 'azure', settingsNs: 'llm-pi-ai',
        nativeAuth: { env: ['AZURE_OPENAI_API_KEY'], oauth: false }, baseURLEnv: ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'] }] },
    }
    const readiness = await modelProviderReadiness(['azure'], services)
    assert.equal(readiness.azure.state, 'runtime_check')
    const projected = await projectModelPolicy(source.root, 'example-agent', services)
    assert.deepEqual(projected.policy.credential_refs, ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_BASE_URL'])
    assert.equal(projected.environment.AZURE_OPENAI_BASE_URL, 'value-for-AZURE_OPENAI_BASE_URL')
    assert.equal(JSON.stringify(projected.policy).includes('value-for-'), false)
    const missingEndpoint = { ...services, credentials: { resolve: async ref => ref === 'AZURE_OPENAI_API_KEY' ? { value: 'api-key' } : undefined } }
    assert.equal((await modelProviderReadiness(['azure'], missingEndpoint)).azure.state, 'unknown')
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', missingEndpoint), /动态端点未配置/)
  } finally { source.cleanup() }
})

test('原生授权变量与端点变量分开判断，不把 Cloudflare 账号 ID 当成 API Key', async () => {
  const services = {
    settingsController: { describe: () => ({ namespaces: [{ ns: 'llm-pi-ai', value: { providers: { 'cloudflare-ai-gateway': {} } } }] }) },
    credentials: { resolve: async ref => ref === 'CLOUDFLARE_ACCOUNT_ID' ? { value: 'account-id' } : undefined },
    llm: { listConfigurableProviders: () => [{ provider: 'cloudflare-ai-gateway', settingsNs: 'llm-pi-ai',
      nativeAuth: { env: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'], oauth: false },
      baseURLEnv: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'] }] },
  }
  assert.equal((await modelProviderReadiness(['cloudflare-ai-gateway'], services))['cloudflare-ai-gateway'].state, 'missing_api_key')
})

test('目录连接状态由原生设置和凭据解析得出，响应不包含凭据或引用', async () => {
  const services = {
    settingsController: { describe: () => ({ namespaces: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      { ns: 'llm-pi-ai', value: { providers: { 'xiaomi-token-plan-cn': {}, acme: { headers: { Authorization: 'Bearer hidden' } } } } },
    ] }) },
    credentials: { resolve: async ref => ref === 'DEEPSEEK_API_KEY' ? { value: 'credential-value' } : undefined },
    llm: { listConfigurableProviders: () => [
      { provider: 'xiaomi-token-plan-cn', settingsNs: 'llm-pi-ai', nativeAuth: { env: ['XIAOMI_TOKEN_PLAN_CN_API_KEY'], oauth: true } },
      { provider: 'acme', settingsNs: 'llm-pi-ai', nativeAuth: { env: [], oauth: false } },
    ] },
  }
  const ids = ['deepseek-official', 'xiaomi-token-plan-cn', 'deepseek-account', 'acme', 'missing']
  const status = await modelProviderReadiness(ids, services)
  assert.deepEqual(ids.map(id => status[id].state), ['ready', 'missing_api_key', 'platform_only', 'platform_only', 'unknown'])
  assert.match(status['xiaomi-token-plan-cn'].message, /设置 → 模型/)
  assert.equal(JSON.stringify(status).includes('credential-value'), false)
  assert.equal(JSON.stringify(status).includes('Bearer hidden'), false)
  assert.equal(JSON.stringify(status).includes('DEEPSEEK_API_KEY'), false)
  const resolved = await modelProviderReadiness(['xiaomi-token-plan-cn'], {
    ...services, credentials: { resolve: async () => ({ value: 'credential-value' }) },
  })
  assert.equal(resolved['xiaomi-token-plan-cn'].state, 'ready')
})

test('凭据解析失败返回未知状态，缺密钥时业务启动投影拒绝生成', async () => {
  const source = fixture({ allowed: [{ provider: 'deepseek-official', model: 'deepseek-flash' }], default: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  try {
    const services = {
      sessionController: { modelCatalog: async () => ({ default: { provider: 'deepseek-official', model: 'deepseek-flash' }, groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
      ], failures: [], routableProviders: ['deepseek-official'] }) },
      settingsController: { describe: () => ({ namespaces: [{ ns: 'llm-deepseek', value: {} }] }) },
      credentials: { resolve: async () => undefined },
      llm: { listConfigurableProviders: () => [] },
    }
    const status = await modelProviderReadiness(['deepseek-official'], services)
    assert.equal(status['deepseek-official'].state, 'missing_api_key')
    await assert.rejects(projectModelPolicy(source.root, 'example-agent', services), /尚无业务实例可解析的 API Key/)
    const failed = await modelProviderReadiness(['deepseek-official'], { ...services, credentials: { resolve: async () => { throw new Error('Bearer secret') } } })
    assert.equal(failed['deepseek-official'].state, 'unknown')
    assert.equal(JSON.stringify(failed).includes('Bearer secret'), false)
  } finally { source.cleanup() }
})
