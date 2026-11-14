import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { collectEntries, verifyEntries } from '../manifest.mts'
import { execFileSync } from 'node:child_process'
const programRoot = fileURLToPath(new URL('../../../', import.meta.url))
const { build } = createRequire(join(programRoot, 'platform/plugin/package.json'))('esbuild')

test('复制到其他目录的 compiled worker 仍从显式程序根装载运行器脚本', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runtime-compiled-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  symlinkSync(join(programRoot, 'platform/plugin/node_modules'), join(root, 'node_modules'), 'dir')
  const outfile = join(root, 'relocated/plugin/lib/agent-deployment-worker.mjs')
  await build({ entryPoints: [join(programRoot, 'platform/deploy/agent/runtime/index.mts')], outfile, platform: 'node', format: 'esm', bundle: true, packages: 'external' })
  const { writeLegacyRuntimeBundle, refreshAgentPreview } = await import(pathToFileURL(outfile).href)
  const staging = join(root, 'bundle')
  mkdirSync(join(staging, 'assets/managed'), { recursive: true })
  writeFileSync(join(staging, 'assets/managed/probe.mjs'), 'export const name="source-companion";\n')
  const options = { programRoot, imageTag: 'fixture/runtime:amd64', arch: 'amd64', agentId: 'demo', experimentId: 'EXP-demo-001', presetId: 'demo', profilePatch: 'demo.patch.yml' }
  await writeLegacyRuntimeBundle(staging, options)
  for (const name of ['install.sh', 'standalone_agent_launcher', 'README.md']) assert.deepEqual(readFileSync(join(staging, name)), readFileSync(join(programRoot, 'platform/deploy/agent/runtime', name)))
  assert.match(readFileSync(join(staging, 'runtime/compose.yaml'), 'utf8'), /fixture\/runtime:amd64/)
  const mounts = JSON.parse(readFileSync(join(staging, 'runtime/compose.yaml'))).services.dsh.volumes
  assert.ok(mounts.some(mount => mount.source === './state/home/profiles/node_modules' && mount.target === '/opt/node_modules' && mount.read_only))
  assert.ok(readFileSync(join(staging, 'runtime/standalone-bootstrap.js')).byteLength > 0)
  mkdirSync(join(staging, 'config-seed'))
  mkdirSync(join(staging, 'state/home'), { recursive: true })
  writeFileSync(join(staging, 'state/home/retained'), 'session-and-config')
  writeFileSync(join(staging, 'config-seed/standalone.json'), JSON.stringify(options))
  for (const path of ['runtime/lfx', 'runtime/extensions', 'mcp/compositions']) {
    mkdirSync(join(staging, path), { recursive: true })
    writeFileSync(join(staging, path, 'legacy.json'), '{}')
  }
  const preview = { agentId: options.agentId, experimentId: options.experimentId, candidateSha256: 'f'.repeat(64), arch: options.arch }
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ kind: 'standalone-agent', source: preview, package: { arch: options.arch }, image: { tag: options.imageTag }, files: collectEntries(staging, ['state']) }))
  const compose = JSON.parse(readFileSync(join(staging, 'runtime/compose.yaml')))
  delete compose.services.dsh.environment.HOME
  writeFileSync(join(staging, 'runtime/compose.yaml'), JSON.stringify(compose))
  await assert.rejects(refreshAgentPreview(staging, programRoot, { ...preview, candidateSha256: 'a'.repeat(64) }), /不一致/)
  await refreshAgentPreview(staging, programRoot, preview)
  for (const path of ['runtime/lfx', 'runtime/extensions', 'mcp/compositions']) assert.equal(existsSync(join(staging, path)), false)
  assert.equal(readFileSync(join(staging, 'state/home/retained'), 'utf8'), 'session-and-config')
  assert.equal(readFileSync(join(staging, 'assets/managed/probe.mjs'), 'utf8'), 'export const name="source-companion";\n')
  const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'))
  assert.equal(JSON.parse(readFileSync(join(staging, 'runtime/compose.yaml'))).services.dsh.environment.HOME, '/var/lib/dsh')
  assert.deepEqual(verifyEntries(staging, manifest.files, ['manifest.json', 'SHA256SUMS', 'state/home/retained']), [])
  assert.equal(manifest.files.some(file => file.path.startsWith('state/')), false)
  execFileSync('sha256sum', ['-c', 'SHA256SUMS', '--quiet'], { cwd: staging })
  manifest.source.profile = 'sdk'
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(refreshAgentPreview(staging, programRoot, preview), /仅支持 Web 包/)
  await assert.rejects(writeLegacyRuntimeBundle(join(root, 'missing-root'), { ...options, programRoot: undefined }), /明确的平台程序根/)
})


test('旧原生预览刷新后只保留统一启动入口，清单与校验和可用且不改现场配置', async t => {
  const { writeRuntimeBundle, refreshAgentPreview } = await import('../agent/runtime/index.mts')
  const root = mkdtempSync(join(tmpdir(), 'agent-preview-launcher-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const preview = { agentId: 'demo', experimentId: 'business:demo', candidateSha256: 'f'.repeat(64), arch: 'arm64' }
  await writeRuntimeBundle(root, { ...preview, programRoot, imageTag: 'fixture:arm64', presetId: 'demo', profilePatch: 'demo.patch.yml' })
  renameSync(join(root, 'standalone_agent_launcher'), join(root, 'agent'))
  mkdirSync(join(root, 'state/home'), { recursive: true })
  writeFileSync(join(root, 'state/home/retained'), 'session-and-config')
  const deployment = readFileSync(join(root, 'config/deployment.env'))
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ kind: 'standalone-agent', schemaVersion: 2, source: preview, package: { arch: preview.arch }, files: collectEntries(root, ['state']) }))
  await refreshAgentPreview(root, programRoot, preview)
  assert.equal(existsSync(join(root, 'agent')), false)
  assert.equal(existsSync(join(root, 'standalone_agent_launcher')), true)
  assert.deepEqual(readFileSync(join(root, 'config/deployment.env')), deployment)
  assert.equal(readFileSync(join(root, 'state/home/retained'), 'utf8'), 'session-and-config')
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json')))
  assert.deepEqual(verifyEntries(root, manifest.files, ['manifest.json', 'SHA256SUMS', 'state/home/retained']), [])
  execFileSync('sha256sum', ['-c', 'SHA256SUMS', '--quiet'], { cwd: root })
})
