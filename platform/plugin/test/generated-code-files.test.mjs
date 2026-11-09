import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { computeCodeSource } from '../src/agents/compute-source.ts'
import { publishCompositionVersion } from '../src/mcp/compositions.ts'
import { freezeLfxBundle, lfxDigest } from '../src/mcp/lfx-assets.ts'
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
const nativeFlow = (id = 'result') => ({ data: { nodes: [{ id, position: { x: 0, y: 0 }, data: { id, type: 'TestComponent', node: { display_name: '检查结果', is_output: true, outputs: [{ name: 'result' }], template: { code: { value: 'raise RuntimeError("查看禁止执行")' } } } } }], edges: [] } })
const lfxConfig = id => ({ kind: 'workflow', workflow: id, engine: 'lfx', toolName: id, title: id, description: '', connections: {} })

test('编排源码仅展开同源LFX包、批量内部流程和固定子编排，不扫描平台或无关模块', () => {
  const f = fixture(), config = lfxConfig('parent'), child = lfxConfig('leaf')
  try {
    f.put('mcp/compositions/leaf/flow.json', JSON.stringify(nativeFlow()))
    child.flowDigest = freezeLfxBundle(f.root, 'leaf', child)
    const childEntry = { id: 'leaf' }; publishCompositionVersion(childEntry, child)
    const native = nativeFlow('batch')
    native.data.nodes[0].data.type = 'HepBatch'
    native.data.nodes[0].data.node.template.body = { show: true, value: nativeFlow('nested') }
    const childNode = nativeFlow('child').data.nodes[0]; childNode.data.type = 'HepChild'; childNode.data.node.is_output = false
    Object.assign(childNode.data.node.template, { composition_id: { value: 'leaf' }, version_id: { value: childEntry.publishedVersionId } })
    native.data.nodes.push(childNode)
    native.metadata = { hep: { modules: { own: 'compositions/parent/src/own.py' } } }
    f.put('mcp/compositions/parent/flow.json', JSON.stringify(native))
    f.put('mcp/compositions/parent/src/own.py', 'value = 1')
    f.put('mcp/src/unused.py', 'UNRELATED'); f.put('platform/plugin/src/mcp/executor.ts', 'PLATFORM')
    const catalog = { schema_version: '1.0', compositions: [{ id: 'parent', draft: config }, childEntry] }
    const request = { selection: { id: 'parent', version: 'draft' } }
    const before = compositionCodeSource(f.root, catalog, request)
    assert.equal(before.files[0].path, 'flow.json'); assert.equal(before.files[0].entry, true)
    assert.ok(before.files.some(file => file.path === 'components/batch/components/nested.py'))
    assert.ok(before.files.some(file => file.path === `children/${encodeURIComponent('leaf:' + childEntry.publishedVersionId)}/flow.json`))
    assert.ok(before.files.some(file => file.label.includes('检查结果') && file.path.endsWith('nested.py')))
    assert.equal(before.files.some(file => /unused|executor|build/.test(file.path)), false)
    const own = before.files.find(file => file.path === 'modules/own.py')
    assert.equal(compositionCodeSource(f.root, catalog, { ...request, path: own.path, expected_sha256: own.sha256 }).content, 'value = 1')
    f.put('mcp/compositions.json', JSON.stringify(catalog))
    const fixed = { ...config, flowDigest: freezeLfxBundle(f.root, 'parent', config) }
    catalog.compositions[0].published = fixed
    catalog.compositions[0].versions = [{ versionId: 'parent-v1', config: fixed }]
    const published = { selection: { id: 'parent', version: 'published', versionId: 'parent-v1' } }
    const frozen = compositionCodeSource(f.root, catalog, published)
    f.put('mcp/compositions/parent/src/own.py', 'value = 2'); f.put('mcp/compositions/leaf/flow.json', '{}')
    assert.deepEqual(compositionCodeSource(f.root, catalog, published), frozen)
    assert.notEqual(compositionCodeSource(f.root, catalog, request).identity, before.identity)
    assert.throws(() => compositionCodeSource(f.root, catalog, { ...request, path: own.path, expected_sha256: own.sha256 }), /已变化/)
    assert.throws(() => compositionCodeSource(f.root, catalog, { ...published, path: 'platform/plugin/src/mcp/executor.ts', expected_sha256: sha('PLATFORM') }), /不属于/)
    f.put(`mcp/compositions/parent/versions/${fixed.flowDigest}/bundle.json`, '{}')
    assert.throws(() => compositionCodeSource(f.root, catalog, published), /摘要/)
    assert.throws(() => compositionCodeSource(f.root, catalog, { selection: { id: 'parent', version: 'published', versionId: 'missing' } }), /不存在/)
  } finally { f.close() }
})

test('固定发布包的JavaScript业务模块按原执行字节展示', () => {
  const f = fixture()
  try {
    const bundle = { engine: 'lfx==1.13.1', flow: { data: { nodes: [{ id: 'result', data: { id: 'result', node: { is_output: true, template: { code: { value: 'class Result: pass' } } } }, position: { x: 0, y: 0 } }], edges: [] } }, modules: {}, children: {}, typescript: 'export const fixed = 1;\n' }
    const config = { title: '业务模块', engine: 'lfx', workflow: 'parent', flowDigest: lfxDigest(bundle) }
    f.put(`mcp/compositions/parent/versions/${config.flowDigest}/bundle.json`, JSON.stringify(bundle))
    const catalog = { schema_version: '1.0', compositions: [{ id: 'parent', published: config }] }, selection = { id: 'parent', version: 'published' }
    const file = compositionCodeSource(f.root, catalog, { selection }).files.find(file => file.path === 'execution.js')
    assert.equal(file.kind, 'artifact')
    assert.equal(compositionCodeSource(f.root, catalog, { selection, path: file.path, expected_sha256: file.sha256 }).content, bundle.typescript)
  } finally { f.close() }
})

test('非LFX历史版本仅展示固定定义，内存视图保留路径、脱敏及摘要校验', () => {
  const f = fixture(), config = { title: '当前', toolName: 'current', connectionId: 'soc' }, historical = { ...config, title: '历史' }
  try {
    const catalog = { schema_version: '1.0', compositions: [{ id: 'old', published: config, versions: [{ versionId: 'v1', config: historical }] }] }
    const request = { selection: { id: 'old', version: 'published', versionId: 'v1' } }
    const view = compositionCodeSource(f.root, catalog, request)
    assert.deepEqual(view.files.map(file => file.path), ['composition.json'])
    assert.match(compositionCodeSource(f.root, catalog, { ...request, path: view.files[0].path, expected_sha256: view.files[0].sha256 }).content, /历史/)
    assert.match(view.notes.join(''), /未保存可核实/)
    const content = 'const password="private-example";'+ 'x'.repeat(CODE_PREVIEW_CHARACTERS)
    const location = { root: f.root, file: 'virtual.js', path: 'virtual.js', content, label: '业务组件' }
    assert.equal(codeCatalog('v', [location]).files[0].label, '业务组件')
    const read = readCode('v', [location], location.path, sha(content))
    assert.equal(read.redacted, true); assert.equal(read.truncated, true); assert.equal(read.complete, false)
    assert.throws(() => codeCatalog('v', [{ ...location, file: '../outside.py' }]), /不在当前范围/)
    assert.throws(() => readCode('v', [location], location.path, 'a'.repeat(64)), /已变化/)
    assert.equal(readCode('v', [{ ...location, content: '' }], location.path, sha('')).content, '')
  } finally { f.close() }
})

test('MCP公开handler仅读取所选编排执行资产，拒绝目录外路径和陈旧SHA', async () => {
  const f = fixture(), output = join(f.root, 'handler.mjs'), loaded = 'a'.repeat(64)
  const program = fileURLToPath(new URL('../../../', import.meta.url))
  try {
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(f.root, 'node_modules'), 'dir')
    await build({ entryPoints: [fileURLToPath(new URL('../src/mcp/index.ts', import.meta.url))], outfile: output, bundle: true, packages: 'external', platform: 'node', format: 'esm', define: { __PLATFORM_MCP_IMPLEMENTATION_DIGEST__: JSON.stringify(loaded) } })
    f.put('workspace.json', JSON.stringify({ schemaVersion: 1, id: 'workspace-source-test', extensions: [{ id: 'selected', path: 'extensions/selected' }] }))
    f.put('extensions/selected/src/index.ts', 'export const main=true')
    f.put('extensions/selected/src/context.ts', 'export const context=true')
    f.put('compositions.json', JSON.stringify({ schema_version: '1.0', compositions: [{ id: 'c-one', draft: lfxConfig('c-one') }] }))
    f.put('mcp/compositions/c-one/flow.json', JSON.stringify(nativeFlow()))
    const { createMcpHandler } = await import(`file://${output}`)
    process.env.HARNESS_PROGRAM_ROOT = program
    const handler = createMcpHandler(f.root, { compositionsFile: join(f.root, 'compositions.json'), extension: { id: 'selected' } })
    const selection = { id: 'c-one', version: 'draft' }
    const catalog = await handler('compositionSource', { selection })
    assert.equal(catalog.ok, true)
    const files = catalog.value.files
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
