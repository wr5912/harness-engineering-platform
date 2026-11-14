import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { stageStandalone, runtimeFiles, sdkFiles } from '../../dsh-container/stage-standalone.mts'

test('构建清单可复现，镜像只装入当前输出并保留旧进程文件', t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const temporary = mkdtempSync(join(tmpdir(), 'web-build-outputs-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const first = join(temporary, 'first'), second = join(temporary, 'second')
  mkdirSync(first)
  writeFileSync(join(first, 'chunk-OBSOLETE.mjs'), 'old process artifact')
  for (const output of [first, second]) execFileSync(process.execPath, ['build.mjs', '--out-dir', output], { cwd: root })
  const manifest = JSON.parse(readFileSync(join(first, 'build.outputs.json'), 'utf8'))
  assert.deepEqual(manifest, JSON.parse(readFileSync(join(second, 'build.outputs.json'), 'utf8')))
  assert.equal(existsSync(join(first, 'chunk-OBSOLETE.mjs')), true)
  assert.equal(manifest.files.includes('chunk-OBSOLETE.mjs'), false)
  assert.ok(manifest.files.includes('container-webserver.mjs'))
  for (const file of manifest.files) assert.deepEqual(readFileSync(join(first, file)), readFileSync(join(second, file)))

  const program = join(temporary, 'program'), adapter = join(program, 'runtime/adapters/dsh-container')
  mkdirSync(adapter, { recursive: true })
  mkdirSync(join(program, 'platform/plugin/lib'), { recursive: true })
  for (const file of runtimeFiles) writeFileSync(join(program, 'platform/plugin/lib', file), 'export {}')
  for (const file of sdkFiles) writeFileSync(join(adapter, file), '')
  for (const directory of ['standalone-deps', 'runtime-compat']) mkdirSync(join(adapter, directory))
  cpSync(first, join(program, 'runtime/adapters/dsh-web/lib'), { recursive: true })
  const staged = join(temporary, 'staged')
  stageStandalone(staged, program)
  assert.deepEqual(readdirSync(join(staged, 'web')).sort(), ['build.outputs.json', ...manifest.files].sort())
  writeFileSync(join(program, 'runtime/adapters/dsh-web/lib/build.outputs.json'), JSON.stringify({ schemaVersion: 1, files: ['../outside.mjs'] }))
  assert.throws(() => stageStandalone(join(temporary, 'invalid'), program), /Web 构建输出清单无效.*build.outputs.json/)
})
