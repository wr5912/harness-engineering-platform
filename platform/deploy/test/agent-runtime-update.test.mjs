import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { updateAgentRuntime } from '../agent/runtime/update.mts'
import { collectEntries, verifyEntries } from '../manifest.mts'

const program = new URL('../../../', import.meta.url).pathname
const image = { tag: 'dsh:current', id: 'sha256:current', fingerprint: 'current' }
function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-runtime-update-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const root = join(parent, 'installed'), harness = join(parent, 'business/agents/alpha')
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
  for (const directory of ['workspace', 'managed', 'presets']) mkdirSync(join(harness, 'dsh', directory), { recursive: true })
  put(join(harness, 'harness.yaml'), 'agent: {id: alpha}\nloadable_assets:\n  preset_id: alpha\n  profile_patch: dsh/managed/main.yml\n')
  put(join(harness, 'dsh/managed/main.yml'), '- id: mcp-session-manager\n  config:\n    servers:\n    - {id: platform, url: "http://platform.test/hep/mcp/groups/inspection/v2"}\n    groups: []\n')
  put(join(harness, 'dsh/workspace/deployment.env.example'), '# 通知地址\nNOTIFICATIONS_URL=nats://default.test:4222\n')
  mkdirSync(join(root, 'assets'), { recursive: true })
  symlinkSync(join(harness, 'harness.yaml'), join(root, 'assets/harness.yaml'))
  put(join(root, 'runtime/lfx/server.py'), 'legacy local executor')
  put(join(root, 'mcp/compositions/flow.json'), 'frozen flow')
  put(join(root, 'agent'), 'old launcher')
  put(join(root, 'manifest.json'), JSON.stringify({ kind: 'standalone-agent', schemaVersion: 1,
    package: { arch: 'amd64' }, source: { agentId: 'alpha', experimentId: 'EXP-alpha-001', profile: 'web' }, extensions: ['old'] }))
  put(join(root, 'state/deployment.env'), 'AGENT_PORT=18506\nCOMPOSE_PROJECT_NAME=keep-project\nAGENT_UID=1012\nNOTIFICATIONS_URL=nats://onsite.test:4222\n')
  const config = { agentId: 'alpha', profilePatch: 'main.yml', compositions: [{ flow: 'local' }], extensions: ['local'],
    fixedBindings: ['local'], mcp: { servers: [{ id: 'platform-compositions', url: 'http://local' }, { id: 'own', url: 'http://own.test/mcp', headers: [{name: 'Authorization', value: 'keep-secret'}] }], groups: [] } }
  put(join(root, 'config-seed/standalone.json'), JSON.stringify(config))
  put(join(root, 'state/home/standalone/config.json'), JSON.stringify(config))
  put(join(root, 'state/home/sessions/keep.jsonl'), 'keep conversation bytes')
  put(join(root, 'state/home/settings.json'), 'keep native model bytes')
  return { root, harness, put }
}

test('旧真实安装布局迁移为平台 MCP 客户端，共用镜像且保留连接、端口、模型、会话与可恢复备份', async t => {
  const f = fixture(t), result = await updateAgentRuntime(f.root, program, image)
  for (const path of ['runtime', 'mcp', 'assets', 'config-seed']) assert.equal(existsSync(join(f.root, path)), false)
  assert.equal(readFileSync(join(result.backup, 'runtime/lfx/server.py'), 'utf8'), 'legacy local executor')
  const config = JSON.parse(readFileSync(join(f.root, 'state/home/standalone/config.json')))
  for (const key of ['compositions', 'extensions', 'fixedBindings']) assert.equal(key in config, false)
  assert.deepEqual(config.mcp.servers.map(server => server.id), ['own', 'platform'])
  assert.equal(config.mcp.servers[0].headers[0].value, 'keep-secret')
  assert.match(readFileSync(join(f.root, 'config/deployment.env'), 'utf8'), /AGENT_PORT=18506\nCOMPOSE_PROJECT_NAME=keep-project/)
  const deployment = readFileSync(join(f.root, 'config/deployment.env'), 'utf8')
  assert.match(deployment, /# 通知地址\nNOTIFICATIONS_URL=nats:\/\/default.test:4222/)
  assert.ok(deployment.lastIndexOf('NOTIFICATIONS_URL=nats://onsite.test:4222') > deployment.indexOf('NOTIFICATIONS_URL=nats://default.test:4222'))
  assert.equal(readFileSync(join(f.root, 'state/home/sessions/keep.jsonl'), 'utf8'), 'keep conversation bytes')
  assert.equal(readFileSync(join(f.root, 'state/home/settings.json'), 'utf8'), 'keep native model bytes')
  const manifest = JSON.parse(readFileSync(join(f.root, 'manifest.json')))
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.source.experimentId, 'business:alpha')
  assert.equal(manifest.image.tag, image.tag)
  const stateFiles = collectEntries(f.root).filter(entry => entry.path.startsWith('state/')).map(entry => entry.path)
  assert.deepEqual(verifyEntries(f.root, manifest.files, [...stateFiles, '.env', 'manifest.json', 'SHA256SUMS']), [])
  const compose = JSON.parse(readFileSync(join(f.root, 'config/compose.yaml')))
  assert.equal(compose.services.dsh.environment.HOME, '/var/lib/dsh')
  await updateAgentRuntime(f.root, program, image)
  assert.equal(readFileSync(join(f.root, 'state/home/sessions/keep.jsonl'), 'utf8'), 'keep conversation bytes')
})

test('升级失败恢复安装文件与现场连接，业务 Harness 不受影响', async t => {
  const f = fixture(t), before = readFileSync(join(f.root, 'manifest.json'))
  f.put(join(f.root, 'state/home/standalone/config.json'), '{invalid current config')
  await assert.rejects(updateAgentRuntime(f.root, program, image), /JSON/)
  assert.deepEqual(readFileSync(join(f.root, 'manifest.json')), before)
  assert.equal(readFileSync(join(f.root, 'agent'), 'utf8'), 'old launcher')
  assert.equal(readFileSync(join(f.root, 'runtime/lfx/server.py'), 'utf8'), 'legacy local executor')
  assert.equal(readFileSync(join(f.root, 'state/home/standalone/config.json'), 'utf8'), '{invalid current config')
  assert.equal(existsSync(join(f.root, 'harness')), false)
  assert.equal(existsSync(join(f.harness, 'harness.yaml')), true)
})
