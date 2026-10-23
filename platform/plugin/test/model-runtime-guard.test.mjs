import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = mkdtempSync(join(tmpdir(), 'model-runtime-guard-'))
await Promise.all([
  build({ entryPoints: [new URL('../src/models/runtime.ts', import.meta.url).pathname], outfile: join(bundled, 'runtime.mjs'),
    bundle: true, platform: 'node', format: 'esm' }),
  build({ entryPoints: [new URL('../src/business-control/core.ts', import.meta.url).pathname], outfile: join(bundled, 'core.mjs'),
    bundle: true, platform: 'node', format: 'esm' }),
])
const { apply } = await import(`file://${join(bundled, 'runtime.mjs')}`)
const { getBusinessControl } = await import(`file://${join(bundled, 'core.mjs')}`)
test.after(() => rmSync(bundled, { recursive: true, force: true }))

test('同一业务实例的目标与评测 Session 均只可调用启动时业务目录模型', async () => {
  const listeners = new Map()
  apply({ on: (event, listener) => listeners.set(event, listener) }, {
    agentId: 'example-agent', allowed: [{ provider: 'provider-a', model: 'model-one' }],
  })
  const stream = listeners.get('llm/stream')
  assert.equal(typeof stream, 'function')
  const emitted = []
  const next = async function* () { emitted.push('dispatched'); yield 'ok' }
  for (const sessionId of ['target-session', 'evaluation-judge-session']) {
    await assert.rejects(async () => {
      for await (const _chunk of stream({ provider: 'provider-a', model: 'model-two', sessionId }, next)) {}
    }, /当前不可使用模型 provider-a\/model-two/)
  }
  assert.deepEqual(emitted, [])
  const received = []
  for await (const chunk of stream({ provider: 'provider-a', model: 'model-one', sessionId: 'evaluation-judge-session' }, next)) received.push(chunk)
  assert.deepEqual(received, ['ok'])
  assert.deepEqual(emitted, ['dispatched'])
})

test('来源固定的本地适配器精确放行，平台模型目录仍只含外部模型', async () => {
  const allowed = [{ provider: 'catalog-model', model: 'catalog-route' }]
  const localRoutes = [{ provider: 'threat-analysis-automation', model: 'scheduled-batch' }, { provider: 'threat-analysis-delivery', model: 'fixed-summary' },
    { provider: 'security-operation-delivery', model: 'fixed-operation-result' }]
  const listeners = new Map()
  apply({ on: (event, listener) => listeners.set(event, listener) }, { agentId: 'soc', allowed, localRoutes })
  const stream = listeners.get('llm/stream')
  const next = async function* () { yield 'dispatched' }
  for (const route of [...allowed, ...localRoutes]) {
    const received = []
    for await (const chunk of stream(route, next)) received.push(chunk)
    assert.deepEqual(received, ['dispatched'])
  }
  assert.deepEqual(allowed, [{ provider: 'catalog-model', model: 'catalog-route' }])
  for (const route of [{ provider: 'threat-analysis-delivery', model: 'other' },
    { provider: 'threat-analysis-automation', model: 'other' },
    { provider: 'unknown-provider', model: 'fixed-summary' }, { provider: 'catalog-model', model: 'unknown' }]) {
    await assert.rejects(async () => { for await (const _ of stream(route, next)) {} }, /当前不可使用模型/)
  }
})

test('无需认证的共享 Session 可用主模型和固定本地路由，未知 Session 不可进入本地路由', async t => {
  const root = mkdtempSync(join(tmpdir(), 'business-local-route-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'config'))
  const digest = 'sha256:' + 'a'.repeat(64)
  const binding = { workspaceId: 'workspace-model', agentId: 'soc', instanceId: 'soc-business', runtimeGeneration: 'generation-1', sourceDigest: digest }
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ schemaVersion: 1, enabled: true,
    agents: [{ agentId: 'soc', enabled: true, subjects: ['A'], sourceDigest: digest,
      actions: ['agent:access', 'session:create', 'session:read', 'session:prompt', 'read'] }],
    gateway: { instances: [{ agentId: 'soc', instanceId: 'soc-business', sourceDigest: digest, accessMode: 'anonymous' }] } }))
  const control = getBusinessControl(root)
  control.registerInstance(binding)
  control.recordAgentAuthentication(binding)
  const snapshot = control.issueSnapshot(binding.instanceId)
  control.acknowledge(binding.instanceId, snapshot.restrictionVersion, snapshot.leaseId)
  const expiresAt = new Date(Date.now() + 60000).toISOString(), subjectId = 'visitor-' + 'x'.repeat(32)
  const guest = control.createContext({ subject: { id: subjectId, kind: 'human', identitySource: 'gateway-anonymous' },
    evidence: { issuer: 'gateway-anonymous', externalSubject: subjectId, method: 'anonymous', verifiedAt: new Date().toISOString(), expiresAt }, expiresAt }, binding)
  control.bindSession(guest, 'guest-session')
  const listeners = new Map()
  apply({ on: (event, listener) => listeners.set(event, listener) }, { agentId: 'soc', assetRoot: root,
    allowed: [{ provider: 'catalog', model: 'chat' }], localRoutes: [{ provider: 'threat-analysis-delivery', model: 'fixed-summary' }] })
  const stream = listeners.get('llm/stream'), next = async function* () { yield 'dispatched' }
  const received = []
  for await (const chunk of stream({ provider: 'catalog', model: 'chat', sessionId: 'guest-session' }, next)) received.push(chunk)
  assert.deepEqual(received, ['dispatched'])
  const local = []
  for await (const chunk of stream({ provider: 'threat-analysis-delivery', model: 'fixed-summary', sessionId: 'guest-session' }, next)) local.push(chunk)
  assert.deepEqual(local, ['dispatched'])
  for (const sessionId of ['unknown-session', undefined]) {
    await assert.rejects(async () => {
      for await (const _ of stream({ provider: 'threat-analysis-delivery', model: 'fixed-summary', sessionId }, next)) {}
    }, /缺少受信 Session 归属|缺少当前 Session/)
  }
})
