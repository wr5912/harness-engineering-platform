import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/business-control/overview.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })).outputFiles[0].text
const module = { exports: {} }
vm.runInNewContext(source, { module, exports: module.exports, require })
const { currentRiskFacts, identityBucket, riskBucket } = module.exports
const now = Date.parse('2026-10-28T08:00:00Z')
const fact = (id, scope, patch = {}) => ({ id, scope, version: 1, status: 'assessed', level: 'low', observedAt: '2026-10-28T07:59:00Z', expiresAt: '2026-10-28T08:01:00Z', ...patch })

test('概览发布身份统计排除开发实例，缺少身份事实保留待核验', () => {
  assert.equal(identityBucket({ identityMode: 'development' }), 'development')
  assert.equal(identityBucket({}, { authentication: { status: 'not_required' }, trust: { status: 'trusted' } }), 'development')
  assert.equal(identityBucket({ identityMode: 'published' }), 'unknown')
  assert.equal(identityBucket({}, { authentication: { status: 'verified' }, trust: { status: 'trusted' } }), 'verified')
  assert.equal(identityBucket({}, { authentication: { status: 'verified' }, trust: { status: 'mismatch' } }), 'abnormal')
  assert.equal(identityBucket({}, { authentication: { status: 'expired' }, trust: { status: 'trusted' } }), 'unknown')
})

test('风险图同一事实取最新版本，保留不同用户、会话及内容的独立记录', () => {
  const scope = { workspaceId: 'workspace', agentId: 'agent', subjectId: 'a', sessionId: 'one' }
  const values = [fact('updated', scope), fact('updated', { sessionId: 'one', agentId: 'agent', subjectId: 'a', workspaceId: 'workspace' }, { version: 2, level: 'high' }), fact('other-user', { ...scope, subjectId: 'b' }), fact('other-session', { ...scope, sessionId: 'two' }), fact('content-a', scope, { contentDigest: 'a' }), fact('content-b', scope, { contentDigest: 'b' })]
  const rows = currentRiskFacts(values, now)
  assert.equal(rows.length, 5)
  assert.equal(rows.find(row => row.fact.id === 'updated').fact.version, 2)
  assert.equal(rows.find(row => row.fact.id === 'updated').bucket, 'high')
  assert.equal(values.length, 6, '只读投影不得改写历史事实')
})

test('同范围的新低风险事实不会隐藏另一条仍有效的高风险约束', () => {
  const scope = { workspaceId: 'workspace', agentId: 'agent', subjectId: 'a', sessionId: 'one' }
  const rows = currentRiskFacts([
    fact('local-marker', scope, { level: 'high', signals: [{ code: 'deny-write', value: 'true', reason: 'local-marker' }] }),
    fact('external-provider', scope, { level: 'low', observedAt: '2026-10-28T07:59:30Z', signals: [] }),
  ], now)
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.fact.id === 'local-marker').bucket, 'high')
  assert.equal(rows.find(row => row.fact.id === 'external-provider').bucket, 'low')
})

test('风险过期、未知和无效有效期独立表达，不填成有效低风险', () => {
  assert.equal(riskBucket(fact('valid', {}), now), 'low')
  assert.equal(riskBucket(fact('expired', {}, { expiresAt: '2026-10-28T08:00:00Z' }), now), 'expired')
  assert.equal(riskBucket(fact('unknown', {}, { status: 'unknown' }), now), 'unknown')
  assert.equal(riskBucket(fact('invalid', {}, { expiresAt: '' }), now), 'unknown')
  assert.equal(riskBucket(fact('missing', {}, { level: undefined }), now), 'unknown')
})
