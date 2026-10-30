import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { computeCodeSource } from '../src/agents/compute-source.ts'
import { compositionCodeSource } from '../src/mcp/source.ts'
import { codeCatalog, readCode, CODE_PREVIEW_CHARACTERS } from '../src/components/generated-code-files.ts'

const sha = text => createHash('sha256').update(text).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'generated-code-'))
  const put = (file, content) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), content) }
  return { root, put, close: () => rmSync(root, { recursive: true, force: true }) }
}
test('算力变体目录包含11份TS与实际ESM，只读当前工作流，模型另归资产', () => {
  const f = fixture(), id = 'VAR-alpha-001-r123456789abc', directory = 'dsh/managed/compute-workflow', prefix = `evolution/experiments/${id}/candidate/`
  try {
    const names = ['index', ...Array.from({ length: 10 }, (_, i) => `helper-${i}`)]
    for (const name of names) f.put(`${prefix}${directory}/${name}.ts`, `export const name=${JSON.stringify(name)}`)
    f.put(`${prefix}${directory}/index.js`, 'export const compiled=true')
    f.put(`${prefix}${directory}/model/head.pt`, 'model-binary')
    f.put(`${prefix}dsh/managed/other/index.ts`, 'PRIVATE_OTHER_WORKFLOW')
    const generation = { entry_path: `${directory}/index.ts` }, build = { entry_path: `${directory}/index.ts`, source_files: names.slice(0, 9).map(name => ({ path: `${directory}/${name}.ts` })), output_path: `${directory}/index.js` }
    const catalog = computeCodeSource(f.root, id, generation, build)
    assert.equal(catalog.files.length, 12)
    assert.equal(catalog.files.filter(file => file.kind === 'source').length, 11)
    assert.equal(catalog.files[0].entry, true)
    for (const file of catalog.files) {
      const read = computeCodeSource(f.root, id, generation, build, { path: file.path, expected_sha256: file.sha256 })
      assert.equal(read.complete, true); assert.equal(sha(read.content), file.sha256)
    }
    assert.throws(() => computeCodeSource(f.root, id, generation, build, { path: 'dsh/managed/other/index.ts', expected_sha256: sha('PRIVATE_OTHER_WORKFLOW') }), /不属于/)
    assert.throws(() => computeCodeSource(f.root, id, generation, build, { path: `${directory}/index.ts`, expected_sha256: 'a'.repeat(64) }), /已变化/)
    symlinkSync(join(f.root, `${prefix}dsh/managed/other`), join(f.root, `${prefix}${directory}/link`))
    assert.equal(computeCodeSource(f.root, id, generation, build).files.length, 12)
  } finally { f.close() }
})
test('完整原文件SHA与截断脱敏预览分开，大ESM保持可读且UTF16不劈开', () => {
  const f = fixture()
  try {
    const text = 'x'.repeat(CODE_PREVIEW_CHARACTERS - 1) + '😀' + '\nconst password="private-example";'
    f.put('code/index.js', text)
    const locations = [{ root: f.root, file: 'code/index.js', path: 'index.js' }]
    const read = readCode('one', locations, 'index.js', sha(text))
    assert.equal(read.sha256, sha(text)); assert.equal(read.truncated, true); assert.equal(read.redacted, true); assert.equal(read.complete, false)
    assert.equal(read.content.length, CODE_PREVIEW_CHARACTERS - 1)
    assert.equal(/[\uD800-\uDBFF]$/.test(read.content), false)
    assert.throws(() => readCode('one', locations, '../code/index.js', sha(text)), /不属于/)
    assert.throws(() => codeCatalog('one', [{ root: f.root, file: '../outside.ts', path: 'outside.ts' }]), /不在当前范围/)
    symlinkSync(join(f.root, 'code/index.js'), join(f.root, 'code/link.ts'))
    assert.throws(() => codeCatalog('one', [{ root: f.root, file: 'code/link.ts', path: 'link.ts' }]), /符号链接/)
    const missing = codeCatalog('one', [{ root: f.root, file: 'code/missing.ts', path: 'missing.ts' }])
    assert.equal(missing.files[0].missing, true)
  } finally { f.close() }
})
test('编排仅关联匹配loaded摘要的真实构建清单，固定历史配置不回退published', () => {
  const f = fixture(), loaded = 'a'.repeat(64), original = 'export const graph=true', current = 'export const graph=false'
  const file = 'platform/plugin/src/mcp/executor.ts', extension = 'extensions/selected/src/index.ts'
  const config = { title: '当前', toolName: 'current', connectionId: 'soc' }, historical = { title: '历史', toolName: 'history', connectionId: 'soc' }
  const catalog = { schema_version: '1.0', compositions: [{ id: 'c-one', published: config, versions: [{ versionId: 'old-version', config: historical }] }] }
  try {
    f.put(file, current)
    f.put('platform/plugin/lib/composition-source-index.json', JSON.stringify({ schema_version: 1, source_digest: loaded, files: [{ path: file, sha256: sha(original) }] }))
    f.put('workspace.json', JSON.stringify({ extensions: [{ id: 'selected', path: 'extensions/selected' }, { id: 'other', path: 'extensions/other' }] }))
    f.put(extension, 'export const business=true'); f.put('extensions/selected/build.mjs', '// 构建脚本'); f.put('extensions/other/src/index.ts', 'OTHER_PRIVATE')
    const request = { selection: { id: 'c-one', version: 'published', versionId: 'old-version' } }
    const result = compositionCodeSource(f.root, catalog, { id: 'selected', sourceDigest: 'b'.repeat(64) }, request, f.root, loaded)
    assert.equal(result.files.length, 3); assert.equal(result.files.find(item => item.path === file).matches_build, false)
    assert.equal(result.files.find(item => item.path === 'workspace/extensions/selected/build.mjs').kind, 'support')
    assert.equal(result.files.some(item => item.path.includes('other')), false)
    assert.notEqual(result.identity, compositionCodeSource(f.root, catalog, undefined, { selection: { id: 'c-one', version: 'published' } }, f.root, loaded).identity)
    assert.throws(() => compositionCodeSource(f.root, catalog, undefined, { selection: { id: 'c-one', version: 'published', versionId: 'missing' } }, f.root, loaded), /不存在/)
    const mismatch = compositionCodeSource(f.root, catalog, undefined, request, f.root, 'c'.repeat(64))
    assert.equal(mismatch.files.length, 0); assert.match(mismatch.notes.join(''), /尚无.*匹配/)
    assert.throws(() => compositionCodeSource(f.root, catalog, { id: 'selected' }, { ...request, path: 'workspace/extensions/other/src/index.ts', expected_sha256: sha('OTHER_PRIVATE') }, f.root, loaded), /不属于/)
  } finally { f.close() }
})

test('MCP公开handler按已保存编排版本读取所有登记扩展源码，拒绝目录外路径和陈旧SHA', async () => {
  const f = fixture(), output = join(f.root, 'handler.mjs'), loaded = 'a'.repeat(64)
  const program = fileURLToPath(new URL('../../../', import.meta.url))
  try {
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(f.root, 'node_modules'), 'dir')
    await build({ entryPoints: [fileURLToPath(new URL('../src/mcp/index.ts', import.meta.url))], outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', define: { __PLATFORM_MCP_IMPLEMENTATION_DIGEST__: JSON.stringify(loaded) } })
    f.put('workspace.json', JSON.stringify({ schemaVersion: 1, id: 'workspace-source-test', extensions: [{ id: 'selected', path: 'extensions/selected' }] }))
    f.put('extensions/selected/src/index.ts', 'export const main=true')
    f.put('extensions/selected/src/context.ts', 'export const context=true')
    f.put('compositions.json', JSON.stringify({ schema_version: '1.0', compositions: [{ id: 'c-one', draft: { toolName: 'find_asset', title: '资产查询', description: '', connectionId: 'soc' } }] }))
    const { createMcpHandler } = await import(`file://${output}`)
    process.env.HARNESS_PROGRAM_ROOT = program
    const handler = createMcpHandler(f.root, { compositionsFile: join(f.root, 'compositions.json'), extension: { id: 'selected' } })
    const selection = { id: 'c-one', version: 'draft' }
    const catalog = await handler('compositionSource', { selection })
    assert.equal(catalog.ok, true)
    const files = catalog.value.files.filter(file => file.path.startsWith('workspace/'))
    assert.equal(files.length, 2)
    for (const file of files) {
      const value = await handler('compositionSource', { selection, path: file.path, expected_sha256: file.sha256 })
      assert.equal(value.ok, true); assert.equal(sha(value.value.content), file.sha256)
    }
    assert.equal((await handler('compositionSource', { selection, path: 'workspace/workspace.json', expected_sha256: 'b'.repeat(64) })).ok, false)
    assert.equal((await handler('compositionSource', { selection, path: files[0].path, expected_sha256: 'b'.repeat(64) })).ok, false)
    assert.equal((await handler('compositionSource', { selection: { ...selection, version: 'published', versionId: 'missing' } })).ok, false)
  } finally { f.close() }
})
