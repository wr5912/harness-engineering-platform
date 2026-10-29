import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectLegacyFixedBindings, stageManagedProjections } from '../agent/runtime/projections.mts'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const source = `const definition = { fixedCompositions: { a: {} } };\nfunction fixedCompositionToolName(name,binding) { return name + binding.group_target_digest; }\nexport function registerFixedCompositionTools(ctx,bindings) {\n const aliases = new Map();\n for(const [name,supplied] of Object.entries(bindings)) {\n  const binding = structuredClone(supplied);\n  const alias = fixedCompositionToolName(name,binding);\n  aliases.set(name,{ alias, async execute() { return binding; } });\n }\n return aliases;\n}\n`

test('旧编译接缝保留源别名与业务版本，实际绑定采用部署摘要', async () => {
  const projected = projectLegacyFixedBindings(source, repo)
  assert.equal(projected.changed, true)
  const loaded = await import('data:text/javascript;base64,' + Buffer.from(projected.content).toString('base64'))
  const original = { compositionId: 'a', versionId: 'v1', tool_name: 'call', input_schema: {}, group_target_digest: 'old' }
  const aliases = loaded.registerFixedCompositionTools({ standaloneBindings: { resolve(_name, value) { return { ...value, group_target_digest: 'new' } } } }, { name: original })
  assert.equal(aliases.get('name').alias, 'nameold')
  assert.equal((await aliases.get('name').execute()).group_target_digest, 'new')
  const invalid = loaded.registerFixedCompositionTools({ standaloneBindings: { resolve(_name, value) { return { ...value, versionId: 'v2' } } } }, { name: original })
  await assert.rejects(invalid.get('name').execute(), /不得改变固定组合/)
  assert.equal(projectLegacyFixedBindings(projected.content, repo).changed, false)
})

test('未知旧编译形态明确失败，普通代码和没有固定组合的 SDK 无需投影', () => {
  assert.throws(() => projectLegacyFixedBindings(source.replace('structuredClone(supplied)', 'copy(supplied)'), repo), /编译形态/)
  assert.throws(() => projectLegacyFixedBindings(source.replace('registerFixedCompositionTools', 'unknownTools'), repo), /唯一 SDK/)
  assert.equal(projectLegacyFixedBindings(source.replace('fixedCompositions:', 'unrelated:'), repo).changed, false)
})

test('归档投影不改冻结源文件，伴随数据保留相对路径，清单分别记录源与投影摘要', t => {
  const stage = mkdtempSync(join(tmpdir(), 'agent-projections-'))
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  mkdirSync(join(stage, 'assets/managed/workflow'), { recursive: true })
  writeFileSync(join(stage, 'assets/managed/workflow/index.mjs'), source)
  writeFileSync(join(stage, 'assets/managed/workflow/fixtures.json'), '{"asset":"example"}\n')
  const records = stageManagedProjections(stage, repo)
  assert.equal(records.length, 1)
  assert.notEqual(records[0].sourceSha256, records[0].exportSha256)
  assert.equal(readFileSync(join(stage, 'assets/managed/workflow/index.mjs'), 'utf8'), source)
  assert.equal(readFileSync(join(stage, 'runtime/projections/managed/workflow/fixtures.json'), 'utf8'), '{"asset":"example"}\n')
  assert.notEqual(statSync(join(stage, 'assets/managed/workflow/index.mjs')).ino, statSync(join(stage, 'runtime/projections/managed/workflow/index.mjs')).ino)
  assert.equal(JSON.parse(readFileSync(join(stage, 'runtime/managed-projection.json'))).files[0].sourcePath, 'assets/managed/workflow/index.mjs')
})
