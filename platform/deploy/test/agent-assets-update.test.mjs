import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectEntries, sha256File } from '../manifest.mts'
import { agentCandidateDigest } from '../agent/snapshot.mts'
import { refreshAgentAssets } from '../agent/runtime/assets.mts'
import { stageManagedProjections } from '../agent/runtime/projections.mts'
const programRoot = fileURLToPath(new URL('../../../', import.meta.url))

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'agent-assets-update-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'installed'), candidate = join(temporary, 'candidate')
  const put = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
  put(join(candidate, 'dsh/managed/ui/index.js'), "export const inject=['webServer','businessRuntime']; export const value='old';")
  put(join(candidate, 'dsh/managed/ui/package.json'), '{"dependencies":{},"scripts":{"build":"old"}}')
  put(join(candidate, 'dsh/managed/ui/removed.txt'), 'old asset')
  const snapshot = () => ({ agentId: 'demo', experimentId: 'EXP-demo', candidate, candidateSha256: agentCandidateDigest(candidate),
    source: { profile: 'web', patch: 'demo.patch.yml', preset: 'demo/agent.cordis.yml' },
    files: collectEntries(candidate).map(file => ({ path: file.path.replace(/^dsh\//, 'assets/'), sourcePath: file.path, sha256: file.sha256, mode: file.mode })),
    omitted: [], dependencies: [], git: { commit: 'fixture', dirty: true } })
  cpSync(join(candidate, 'dsh'), join(root, 'assets'), { recursive: true })
  stageManagedProjections(root, programRoot)
  put(join(root, 'runtime/compose.yaml'), JSON.stringify({ services: { dsh: { volumes: [{ target: '/opt/dsh-managed', source: './runtime/projections/managed' }] } } }))
  const original = snapshot()
  put(join(root, 'manifest.json'), JSON.stringify({ kind: 'standalone-agent', source: { ...original, profile: 'web', paths: { profilePatch: 'assets/managed/demo.patch.yml', preset: 'assets/presets/demo/agent.cordis.yml' } }, package: { arch: 'amd64' }, image: { tag: 'runtime:fixed' }, files: collectEntries(root) }))
  put(join(root, 'SHA256SUMS'), 'original checksums')
  put(join(root, 'state/home/session'), 'keep conversation')
  put(join(root, 'state/standalone.json'), 'keep local connection and port')
  return { root, candidate, put, snapshot, update: () => refreshAgentAssets(root, programRoot, snapshot(), 'amd64', 'runtime:fixed') }
}

test('更新资产和投影、增删文件及清单，同时保留连接、会话和旧版备份', t => {
  const f = fixture(t)
  f.put(join(f.candidate, 'dsh/managed/ui/index.js'), "export const inject=['webServer','businessRuntime']; export const value='new';")
  f.put(join(f.candidate, 'dsh/managed/ui/package.json'), '{"dependencies":{},"scripts":{"build":"new"}}')
  f.put(join(f.candidate, 'dsh/managed/ui/added.txt'), 'new asset')
  rmSync(join(f.candidate, 'dsh/managed/ui/removed.txt'))
  const result = f.update()
  assert.equal(result.changed, 4)
  assert.equal(readFileSync(join(f.root, 'state/home/session'), 'utf8'), 'keep conversation')
  assert.equal(readFileSync(join(f.root, 'state/standalone.json'), 'utf8'), 'keep local connection and port')
  assert.match(readFileSync(join(f.root, 'runtime/projections/managed/ui/index.js'), 'utf8'), /value='new'/)
  assert.doesNotMatch(readFileSync(join(f.root, 'runtime/projections/managed/ui/index.js'), 'utf8'), /businessRuntime/)
  assert.equal(existsSync(join(f.root, 'assets/managed/ui/removed.txt')), false)
  assert.match(readFileSync(join(result.backup, 'original/assets/managed/ui/index.js'), 'utf8'), /value='old'/)
  const manifest = JSON.parse(readFileSync(join(f.root, 'manifest.json')))
  assert.equal(manifest.source.candidateSha256, f.snapshot().candidateSha256)
  for (const entry of manifest.files.filter(entry => entry.type === 'file')) assert.equal(sha256File(join(f.root, entry.path)), entry.sha256)
  assert.match(readFileSync(join(f.root, 'SHA256SUMS'), 'utf8'), new RegExp(sha256File(join(f.root, 'manifest.json')) + '  manifest.json'))
  assert.equal(f.update().restartRequired, false)
})

test('现场修改、依赖或运行身份变化均拒绝覆盖', t => {
  const f = fixture(t)
  f.put(join(f.root, 'assets/managed/ui/index.js'), 'local change')
  assert.throws(f.update, /现场修改/)
  cpSync(join(f.candidate, 'dsh/managed/ui/index.js'), join(f.root, 'assets/managed/ui/index.js'))
  f.put(join(f.candidate, 'dsh/managed/ui/package.json'), '{"dependencies":{"new-library":"1"}}')
  assert.throws(f.update, /运行依赖变化/)
  assert.throws(() => refreshAgentAssets(f.root, programRoot, f.snapshot(), 'arm64', 'runtime:fixed'), /同一智能体/)
})

test('挂载方式变化时恢复资产、原投影和清单，不留下半次更新', t => {
  const f = fixture(t), oldManifest = readFileSync(join(f.root, 'manifest.json'))
  const oldProjection = readFileSync(join(f.root, 'runtime/projections/managed/ui/index.js'))
  f.put(join(f.candidate, 'dsh/managed/ui/index.js'), "export const value='native';")
  assert.throws(f.update, /挂载方式变化/)
  assert.deepEqual(readFileSync(join(f.root, 'manifest.json')), oldManifest)
  assert.deepEqual(readFileSync(join(f.root, 'runtime/projections/managed/ui/index.js')), oldProjection)
  assert.match(readFileSync(join(f.root, 'assets/managed/ui/index.js'), 'utf8'), /value='old'/)
  assert.equal(readFileSync(join(f.root, 'SHA256SUMS'), 'utf8'), 'original checksums')
})
