import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectStandaloneBoundary, stageManagedProjections } from '../agent/runtime/projections.mts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const source = `const definition = { fixedCompositions: { a: {} } };\nfunction fixedCompositionToolName(name,binding) { return name + binding.group_target_digest; }\nexport function registerFixedCompositionTools(ctx,bindings) {\n const aliases = new Map();\n for(const [name,supplied] of Object.entries(bindings)) {\n  const binding = structuredClone(supplied);\n  const alias = fixedCompositionToolName(name,binding);\n  aliases.set(name,{ alias, async execute() { return binding; } });\n }\n return aliases;\n}\n`

test('独立部署不装载平台 Guard，也不需要 businessRuntime 占位服务', async () => {
  const code = `export const name='security-operations-guard'; export const inject=['tools','businessRuntime']; export const helper=42; export function apply(ctx){ctx.get('businessRuntime'); ctx.tools.guard(()=> 'denied')}`
  const projected = projectStandaloneBoundary(code, repo)
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(projected.content).toString('base64'))
  assert.deepEqual(loaded.inject, [])
  assert.equal(loaded.helper, 42)
  loaded.apply(new Proxy({}, { get() { throw new Error('平台 Guard 不应运行') } }))
  const ui = projectStandaloneBoundary(`export const inject=['webServer','businessRuntime']; export function apply() {}`, repo)
  assert.doesNotMatch(ui.content, /businessRuntime/)
})

test('独立威胁工具使用原生 MCP 连接，不依赖平台 Session 身份', async () => {
  const code = `export function runtimeGroupConnection(ctx,config,sessionId){return ctx.get('businessRuntime').groupFetch(config.connections.runtimeGroup.id,sessionId)}`
  const projected = projectStandaloneBoundary(code, repo)
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(projected.content).toString('base64'))
  const direct = () => {}
  assert.deepEqual(loaded.runtimeGroupConnection({ mcpSessionManager: { groupUrl: id => 'http://local/' + id, groupFetch: () => direct } }, { connections: { runtimeGroup: { id: 'soc', url: 'http://old-platform/' } } }), { groupUrl: 'http://local/soc', fetch: direct })
  assert.equal(projectStandaloneBoundary(projected.content, repo).changed, false)
})

test('业务固定版本和工具别名不因独立部署被改写', () => {
  assert.deepEqual(projectStandaloneBoundary(source, repo), { content: source, changed: false })
})

test('归档投影不改冻结源文件，伴随数据保留相对路径，清单分别记录源与投影摘要', t => {
  const stage = mkdtempSync(join(tmpdir(), 'agent-projections-'))
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  mkdirSync(join(stage, 'assets/managed/workflow'), { recursive: true })
  const guarded = source + `export const name='security-operations-guard'; export const inject=['businessRuntime']; export function apply(ctx){ctx.get('businessRuntime')}`
  writeFileSync(join(stage, 'assets/managed/workflow/index.mjs'), guarded)
  writeFileSync(join(stage, 'assets/managed/workflow/fixtures.json'), '{"asset":"example"}\n')
  const records = stageManagedProjections(stage, repo)
  assert.equal(records.length, 1)
  assert.notEqual(records[0].sourceSha256, records[0].exportSha256)
  assert.equal(readFileSync(join(stage, 'assets/managed/workflow/index.mjs'), 'utf8'), guarded)
  assert.equal(readFileSync(join(stage, 'runtime/projections/managed/workflow/fixtures.json'), 'utf8'), '{"asset":"example"}\n')
  assert.notEqual(statSync(join(stage, 'assets/managed/workflow/index.mjs')).ino, statSync(join(stage, 'runtime/projections/managed/workflow/index.mjs')).ino)
  assert.equal(JSON.parse(readFileSync(join(stage, 'runtime/managed-projection.json'))).files[0].sourcePath, 'assets/managed/workflow/index.mjs')
  assert.deepEqual(stageManagedProjections(stage, repo), records)
  assert.equal(readFileSync(join(stage, 'assets/managed/workflow/index.mjs'), 'utf8'), guarded)
})
