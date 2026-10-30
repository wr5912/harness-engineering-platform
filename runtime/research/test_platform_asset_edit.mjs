import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { importCandidateSources } from './platform-asset-edit.mts'
import { createPlatformReadClient } from './platform-replay-input.mts'

// 只隔离平台HTTP边界；实际Node鉴权客户端、RPC信封、CAS载荷与源码字节链均执行。
const sha = value => createHash('sha256').update(value).digest('hex')
const agent = 'synthetic-agent', experiment = 'EXP-synthetic-agent-002-r123456789abc'
const parent = 'EXP-synthetic-agent-001-r123456789abc'
const text = '\uFEFFthrow new Error("SOURCE_MUST_NOT_EXECUTE");\n// 中文😀原字节\n' + 'export const s = `literal $() and quotes "x"`;\n'.repeat(600)
function files(root) { return existsSync(root) ? readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]) : [] }
async function fixture(t, mode = {}) {
  const experiment = mode.experiment ?? 'EXP-synthetic-agent-002-r123456789abc'
  const sourceText = mode.source ?? text
  mkdirSync(resolve('.local'), { recursive: true })
  const root = mkdtempSync(resolve('.local/platform-asset-edit-test-'))
  for (const directory of ['config', '.local/credentials', 'source']) mkdirSync(join(root, directory), { recursive: true })
  const workspace = { id: 'workspace-synthetic-asset-edit', root, legacyRoots: [] }
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ schemaVersion: 1, id: workspace.id, legacyRoots: [] }))
  const password = 'SYNTHETIC_ASSET_PASSWORD', cookie = 'harness_platform_session=SYNTHETIC_ASSET_COOKIE'
  writeFileSync(join(root, '.local/credentials/admin.json'), JSON.stringify({ username: 'synthetic-user', password }), { mode: 0o600 })
  const sourceFile = join(root, 'source/workflow.ts'), sourceManifest = join(root, 'source/manifest.json')
  writeFileSync(sourceFile, sourceText)
  const entry = { path: 'workflow.ts', bytes: Buffer.byteLength(sourceText), sha256: sha(sourceText), ...(Object.hasOwn(mode, 'expected') ? { expected_sha256: mode.expected } : {}), ...(mode.explicitTarget ? { target_path: 'dsh/presets/synthetic-agent/agent.cordis.yml' } : {}) }
  const manifest = { schema_version: 'medium-variant-generated-source/v1', agent, parent_experiment: parent, files: [entry] }
  const rawManifest = JSON.stringify(manifest); writeFileSync(sourceManifest, rawManifest)
  const path = `evolution/experiments/${experiment}/candidate/${entry.target_path ?? 'dsh/managed/compute-workflow/workflow.ts'}`
  const targets = new Map(mode.existing ? [[path, mode.existing]] : []), requests = []
  let logins = 0, applies = 0
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    if (request.url === '/hep/login') {
      logins++; assert.equal(new URLSearchParams(raw).get('password'), password)
      response.writeHead(303, { 'set-cookie': cookie + '; Path=/; HttpOnly', location: '/hep/' }); response.end(); return
    }
    assert.equal(request.headers.cookie, cookie); assert.equal(request.headers.origin, new URL(url).origin)
    const envelope = JSON.parse(raw), { method, payload } = envelope
    requests.push({ method, payload }); assert.equal(request.url, '/hep/harness-platform/' + method)
    let value, error
    if (method === 'inventory') value = { root, workspace }
    else {
      assert.equal(payload.experiment_id, experiment)
      if (method === 'agents/edit/read') {
        assert.equal(payload.path, path)
        const content = targets.get(path), exists = targets.has(path)
        value = { path, exists, editable: true, kind: exists ? 'text' : 'missing', sha256: exists ? sha(content) : null, content: content ?? '' }
      } else {
        assert.ok(['agents/edit/preview', 'agents/edit/apply'].includes(method))
        const [edit] = payload.edits; assert.equal(payload.edits.length, 1); assert.equal(edit.path, path); assert.equal(edit.content, sourceText)
        const before = targets.has(path) ? sha(targets.get(path)) : null
        assert.equal(edit.expected_sha256, before)
        if (method === 'agents/edit/preview') {
          if (mode.previewConflict) error = { code: 'conflict', message: 'synthetic CAS conflict', details: {} }
          else value = { edits: [{ path, before_sha256: before, after_sha256: sha(edit.content), redacted: false }], dry_run: { mode: 'dry' } }
        } else {
          applies++
          if (mode.applyConflict) { targets.set(path, 'OTHER_WRITER'); error = { code: 'conflict', message: 'synthetic CAS conflict', details: {} } }
          else {
            targets.set(path, mode.wrongReadback ? 'DIFFERENT_BYTES' : edit.content)
            if (mode.disconnectAfterApply) { response.destroy(); return }
            value = { written: [{ path, sha256: sha(edit.content) }], dry_run: { mode: 'dry' } }
          }
        }
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: error ? { ok: false, error } : { ok: true, value } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${server.address().port}/hep/`
  writeFileSync(join(root, 'config/business-access.json'), JSON.stringify({ gateway: { managementUrl: url } }))
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); rmSync(root, { recursive: true, force: true }) })
  return { root, path, sourceFile, targets, requests, password, cookie, stats: () => ({ logins, applies }), options: { url, assetRoot: root, agentId: agent, experimentId: experiment, sourceManifest, expectedManifestSha256: sha(rawManifest), out: join(root, 'result') } }
}

test('锁定manifest后经真实HTTP read/preview/CAS/apply/readback逐字导入，保留BOM/Unicode/大源码且不执行', async t => {
  const f = await fixture(t), result = await importCandidateSources(f.options)
  assert.equal(result.status, 'complete'); assert.equal(result.applied, 1); assert.equal(f.targets.get(f.path), text)
  assert.deepEqual(f.requests.map(row => row.method), ['inventory', 'agents/edit/read', 'agents/edit/preview', 'agents/edit/apply', 'agents/edit/read'])
  const receipt = JSON.parse(readFileSync(join(f.options.out, 'receipt.json')))
  assert.equal(receipt.files[0].status, 'applied_and_readback'); assert.equal(receipt.files[0].source_sha256, sha(text)); assert.equal(receipt.files[0].readback_sha256, sha(text))
  const saved = files(f.options.out).map(file => readFileSync(file, 'utf8')).join('\n')
  assert.equal(saved.includes(f.password), false); assert.equal(saved.includes(f.cookie), false); assert.equal(saved.includes('SOURCE_MUST_NOT_EXECUTE'), false)
  assert.ok(receipt.requests.every(row => row.http_status === 200 && /^[0-9a-f]{64}$/.test(row.response_body_sha256) && row.body_saved === false))
})

test('已同字节只读核对，不重复保存；显式target_path仍限定指定Candidate', async t => {
  const f = await fixture(t, { existing: text, explicitTarget: true })
  const result = await importCandidateSources(f.options)
  assert.equal(result.applied, 0); assert.equal(f.stats().applies, 0)
  assert.deepEqual(f.requests.map(row => row.method), ['inventory', 'agents/edit/read'])
  assert.equal(JSON.parse(readFileSync(join(f.options.out, 'receipt.json'))).files[0].status, 'already_identical')
  await assert.rejects(importCandidateSources(f.options), /NEW_ABSOLUTE_OUTPUT_REQUIRED/)
})

test('VAR Candidate 使用相同来源SHA、CAS和写后回读链导入源码', async t => {
  const identity = 'VAR-synthetic-agent-002-r123456789abc'
  const f = await fixture(t, { experiment: identity }), result = await importCandidateSources(f.options)
  assert.equal(result.status, 'complete'); assert.equal(f.targets.get(f.path), text)
  const receipt = JSON.parse(readFileSync(join(f.options.out, 'receipt.json')))
  assert.equal(receipt.experiment_id, identity)
  assert.equal(receipt.files[0].source_sha256, sha(text))
  assert.equal(receipt.files[0].readback_sha256, sha(text))
})

test('写后网络中断先回读，不重发apply；同字节核对不能冒称收到成功写回执', async t => {
  const f = await fixture(t, { disconnectAfterApply: true })
  const result = await importCandidateSources(f.options)
  assert.equal(result.status, 'complete'); assert.equal(result.applied, 0); assert.equal(f.stats().applies, 1)
  const row = JSON.parse(readFileSync(join(f.options.out, 'receipt.json'))).files[0]
  assert.equal(row.apply_acknowledged, false); assert.equal(row.status, 'readback_verified_after_unconfirmed_apply')
})

test('preview冲突不派发apply；apply冲突或回读不同字节保留partial且不自动重试', async t => {
  for (const mode of [{ previewConflict: true }, { applyConflict: true }, { wrongReadback: true }]) {
    const f = await fixture(t, mode)
    await assert.rejects(importCandidateSources(f.options), /PLATFORM_RPC_REJECTED|ASSET_APPLY_NOT_CONFIRMED/)
    assert.equal(f.stats().applies, mode.previewConflict ? 0 : 1)
    assert.equal(JSON.parse(readFileSync(join(f.options.out, 'receipt.json'))).status, 'partial')
  }
})

test('源字节/manifest SHA/目标身份错配先拒绝网络，不写Candidate', async t => {
  const f = await fixture(t)
  for (const experimentId of ['VAR-other-agent-002-r123456789abc', 'VAR-synthetic-agent-002-r123456789ab', '../candidate']) {
    await assert.rejects(importCandidateSources({ ...f.options, experimentId }), /CANDIDATE_IDENTITY_REQUIRED/)
  }
  await assert.rejects(importCandidateSources({ ...f.options, expectedManifestSha256: 'f'.repeat(64) }), /SOURCE_SHA_CHANGED/)
  await assert.rejects(importCandidateSources({ ...f.options, experimentId: parent }), /SOURCE_MANIFEST_IDENTITY_INVALID/)
  writeFileSync(f.sourceFile, text + 'changed')
  await assert.rejects(importCandidateSources(f.options), /SOURCE_SHA_CHANGED/)
  assert.equal(f.stats().logins, 0); assert.equal(existsSync(f.options.out), false)
})

test('已有文件保留生成正文时的expected_sha256，A变成B后拒写而不采用新读SHA', async t => {
  const changed = await fixture(t, { existing: 'BASE_B', expected: sha('BASE_A'), explicitTarget: true })
  await assert.rejects(importCandidateSources(changed.options), /SOURCE_TARGET_BASELINE_CHANGED/)
  assert.equal(changed.targets.get(changed.path), 'BASE_B'); assert.equal(changed.stats().applies, 0)
  assert.deepEqual(changed.requests.map(row => row.method), ['inventory', 'agents/edit/read'])
  const sameBase = await fixture(t, { existing: 'BASE_A', expected: sha('BASE_A'), explicitTarget: true })
  await importCandidateSources(sameBase.options)
  assert.equal(sameBase.targets.get(sameBase.path), text)
  assert.equal(sameBase.requests.find(row => row.method === 'agents/edit/apply').payload.edits[0].expected_sha256, sha('BASE_A'))
})

test('未指定expected仅创建新文件，已有不同文件与非法expected均拒绝', async t => {
  const existing = await fixture(t, { existing: 'EXISTING_WITHOUT_PINNED_BASE' })
  await assert.rejects(importCandidateSources(existing.options), /SOURCE_TARGET_BASELINE_CHANGED/)
  assert.equal(existing.stats().applies, 0)
  for (const expected of ['bad', 12, {}, false]) {
    const invalid = await fixture(t, { expected })
    await assert.rejects(importCandidateSources(invalid.options), /SOURCE_TARGET_BASELINE_INVALID/)
    assert.equal(invalid.stats().logins, 0)
  }
})

test('原只读client仍拒绝edit端点，不能因writer复用共同工厂扩大collector能力', async t => {
  const f = await fixture(t), client = await createPlatformReadClient(f.options)
  try { await assert.rejects(client.rpc('agents/edit/apply', { experiment_id: experiment, edits: [] }), /READONLY_RPC_TARGET_REQUIRED/) }
  finally { await client.close() }
  assert.equal(f.stats().applies, 0); assert.deepEqual(f.requests.map(row => row.method), ['inventory'])
})

test('源文件含凭据常量时不发preview/apply，partial收据不保存源码或凭据', async t => {
  const f = await fixture(t), secret = 'sk-syntheticneverpublish1234567890', unsafe = `export const apiKey = '${secret}'\n`
  writeFileSync(f.sourceFile, unsafe)
  const manifest = { agent, parent_experiment: parent, files: [{ path: 'workflow.ts', sha256: sha(unsafe) }] }, raw = JSON.stringify(manifest)
  writeFileSync(f.options.sourceManifest, raw)
  await assert.rejects(importCandidateSources({ ...f.options, expectedManifestSha256: sha(raw) }), /ASSET_SOURCE_UNSAFE/)
  assert.equal(f.stats().applies, 0); assert.deepEqual(f.requests.map(row => row.method), ['inventory'])
  assert.equal(files(f.options.out).map(file => readFileSync(file, 'utf8')).join('\n').includes(secret), false)
})

test('资产源码中的apiKey变量和Bearer模板保持原字节，不按Run日志规则误判为凭据常量', async t => {
  const source = 'export function headers(options: any) {\n  const apiKey = options.apiKey?.()\n  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}\n}\n'
  const f = await fixture(t, { source })
  const result = await importCandidateSources(f.options)
  assert.equal(result.status, 'complete'); assert.equal(result.applied, 1)
  assert.equal(f.targets.get(f.path), source)
  assert.equal(JSON.parse(readFileSync(join(f.options.out, 'receipt.json'))).files[0].readback_sha256, sha(source))
})

test('实际管理凭据即使藏在普通源码字段中也不能作为资产导入，收据仅保存摘要', async t => {
  const f = await fixture(t), source = `export const innocent = '${f.password}'\n`
  writeFileSync(f.sourceFile, source)
  const raw = JSON.stringify({ agent, parent_experiment: parent, files: [{ path: 'workflow.ts', sha256: sha(source) }] })
  writeFileSync(f.options.sourceManifest, raw)
  await assert.rejects(importCandidateSources({ ...f.options, expectedManifestSha256: sha(raw) }), /ASSET_SOURCE_UNSAFE/)
  assert.equal(f.stats().applies, 0)
  assert.equal(files(f.options.out).map(file => readFileSync(file, 'utf8')).join('\n').includes(f.password), false)
})
