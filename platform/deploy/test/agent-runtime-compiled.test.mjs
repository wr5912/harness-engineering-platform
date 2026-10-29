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
  const { writeRuntimeBundle } = await import(pathToFileURL(outfile).href)
  const staging = join(root, 'bundle')
  mkdirSync(join(staging, 'assets/managed'), { recursive: true })
  writeFileSync(join(staging, 'assets/managed/probe.mjs'), 'export const name="source-companion";\n')
  const options = { programRoot, imageTag: 'fixture/runtime:amd64', arch: 'amd64', agentId: 'demo', experimentId: 'EXP-demo-001', presetId: 'demo', profilePatch: 'demo.patch.yml' }
  await writeRuntimeBundle(staging, options)
  for (const name of ['install.sh', 'agent']) assert.deepEqual(readFileSync(join(staging, name)), readFileSync(join(programRoot, 'platform/deploy/agent/runtime', name)))
  assert.match(readFileSync(join(staging, 'runtime/compose.yaml'), 'utf8'), /fixture\/runtime:amd64/)
  assert.ok(readFileSync(join(staging, 'runtime/standalone-bootstrap.js')).byteLength > 0)
  await assert.rejects(writeRuntimeBundle(join(root, 'missing-root'), { ...options, programRoot: undefined }), /明确的平台程序根/)
})
