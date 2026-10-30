import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { versionSource } from '../src/agents/version-source.ts'

const program = fileURLToPath(new URL('../../../', import.meta.url))
const local = join(program, '.local')
mkdirSync(local, { recursive: true })
const buildRoot = mkdtempSync(join(local, 'sdk-create-build-'))
await build({ entryPoints: [fileURLToPath(new URL('../src/agents/create-agent.ts', import.meta.url))], bundle: true, outfile: join(buildRoot, 'create.mjs'), platform: 'node', format: 'esm' })
const { createAgent } = await import(pathToFileURL(join(buildRoot, 'create.mjs')).href)
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))

test('全新工作区首次创建SDK智能体，角色与使用方式回读一致且不启动实例', async t => {
  const oldProgram = process.env.HARNESS_PROGRAM_ROOT, oldPython = process.env.HARNESS_PYTHON
  process.env.HARNESS_PROGRAM_ROOT = program
  process.env.HARNESS_PYTHON ??= '/usr/bin/python3'
  t.after(() => { if (oldProgram === undefined) delete process.env.HARNESS_PROGRAM_ROOT; else process.env.HARNESS_PROGRAM_ROOT = oldProgram; if (oldPython === undefined) delete process.env.HARNESS_PYTHON; else process.env.HARNESS_PYTHON = oldPython })
  const root = mkdtempSync(join(local, 'sdk-create-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(existsSync(join(root, 'agents')), false)
  assert.equal(existsSync(join(root, 'evolution')), false)
  const value = await createAgent(root, { agent_id: 'sdk-create-test', name: 'SDK 创建测试', description: '通过官方 TypeScript SDK 调用', role: '核对输入和真实工具结果。', profile: 'sdk' })
  assert.equal(value.ok, true, JSON.stringify(value))
  assert.equal(value.value.profile, 'sdk')
  assert.equal(value.value.started, false)
  const source = versionSource(root, value.value.experiment_id)
  assert.equal(source.profile, 'sdk')
  assert.match(source.profile_manifest, /sdk-profile\.package\.json$/)
  assert.match(readFileSync(join(root, source.candidate_root, 'workspace/AGENTS.md'), 'utf8'), /核对输入和真实工具结果/)
  const unsupported = await createAgent(root, { agent_id: 'other-sdk', name: '错误模式', description: '错误模式', role: '保持角色。', profile: 'invalid' })
  assert.equal(unsupported.ok, false)
  assert.equal(unsupported.error.code, 'invalid_request')
})

test('新建输入无效时不为全新工作区留下空资产目录', async t => {
  const root = mkdtempSync(join(local, 'sdk-create-invalid-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const invalid = await createAgent(root, { agent_id: 'other-sdk', name: '错误模式', description: '错误模式', role: '保持角色。', profile: 'invalid' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'invalid_request')
  assert.equal(existsSync(join(root, 'agents')), false)
  assert.equal(existsSync(join(root, 'evolution')), false)
})
