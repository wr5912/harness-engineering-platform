import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const programRoot = fileURLToPath(new URL('../../../', import.meta.url))
const { build } = createRequire(join(programRoot, 'platform/plugin/package.json'))('esbuild')

test('复制到其他目录的 compiled worker 仍从显式程序根装载运行器脚本', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-runtime-compiled-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const outfile = join(root, 'relocated/plugin/lib/agent-deployment-worker.mjs')
  await build({ entryPoints: [join(programRoot, 'platform/deploy/agent/runtime/index.mts')], outfile, platform: 'node', format: 'esm', bundle: true, packages: 'external' })
  const { writeRuntimeBundle, refreshAgentPreview } = await import(pathToFileURL(outfile).href)
  const staging = join(root, 'bundle')
  mkdirSync(join(staging, 'assets/managed'), { recursive: true })
  writeFileSync(join(staging, 'assets/managed/probe.mjs'), 'export const name="source-companion";\n')
  const options = { programRoot, imageTag: 'fixture/runtime:amd64', arch: 'amd64', agentId: 'demo', experimentId: 'EXP-demo-001', presetId: 'demo', profilePatch: 'demo.patch.yml' }
  await writeRuntimeBundle(staging, options)
  for (const name of ['install.sh', 'agent', 'README.md']) assert.deepEqual(readFileSync(join(staging, name)), readFileSync(join(programRoot, 'platform/deploy/agent/runtime', name)))
  assert.match(readFileSync(join(staging, 'runtime/compose.yaml'), 'utf8'), /fixture\/runtime:amd64/)
  const mounts = JSON.parse(readFileSync(join(staging, 'runtime/compose.yaml'))).services.dsh.volumes
  assert.ok(mounts.some(mount => mount.source === './state/home/profiles/node_modules' && mount.target === '/opt/node_modules' && mount.read_only))
  assert.ok(readFileSync(join(staging, 'runtime/standalone-bootstrap.js')).byteLength > 0)
  mkdirSync(join(staging, 'config-seed'))
  mkdirSync(join(staging, 'state/home'), { recursive: true })
  writeFileSync(join(staging, 'state/home/retained'), 'session-and-config')
  writeFileSync(join(staging, 'config-seed/standalone.json'), JSON.stringify(options))
  const preview = { agentId: options.agentId, experimentId: options.experimentId, candidateSha256: 'f'.repeat(64), arch: options.arch }
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ kind: 'standalone-agent', source: preview, package: { arch: options.arch }, image: { tag: options.imageTag } }))
  await assert.rejects(refreshAgentPreview(staging, programRoot, { ...preview, candidateSha256: 'a'.repeat(64) }), /不一致/)
  await refreshAgentPreview(staging, programRoot, preview)
  assert.equal(readFileSync(join(staging, 'state/home/retained'), 'utf8'), 'session-and-config')
  assert.equal(readFileSync(join(staging, 'assets/managed/probe.mjs'), 'utf8'), 'export const name="source-companion";\n')
  const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'))
  manifest.source.profile = 'sdk'
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(refreshAgentPreview(staging, programRoot, preview), /仅支持 Web 包/)
  await assert.rejects(writeRuntimeBundle(join(root, 'missing-root'), { ...options, programRoot: undefined }), /明确的平台程序根/)
})
