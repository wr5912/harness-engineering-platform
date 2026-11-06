import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freezeLfxBundle, lfxCanvas, lfxDependencies, loadLfxBundle, validateLfxFlow } from '../src/mcp/lfx-assets.ts'
import { assertPublishedDependencies, compositionConfig, compositionReferences, publishCompositionVersion } from '../src/mcp/compositions.ts'
import { graphLayout } from '../src/mcp/graph-layout.ts'

const node = (id, output = false) => ({ id, position: { x: 30, y: 100 }, data: { id, type: 'TestComponent', node: { display_name: id, is_output: output, outputs: [{ name: 'result', display_name: '结果' }], template: { code: { value: 'raise RuntimeError("静态读取禁止执行")' }, value: {} } } } })
const flow = () => ({ data: { nodes: [node('input'), node('result', true)], edges: [{ source: 'input', target: 'result', data: { sourceHandle: { id: 'input', name: 'result' }, targetHandle: { id: 'result', fieldName: 'value' } } }] } })
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'hep-lfx-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function save(root, id, native) {
  const dir = join(root, 'mcp/compositions', id)
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'flow.json'), JSON.stringify(native))
}
const config = id => compositionConfig({ kind: 'workflow', workflow: id, engine: 'lfx', toolName: id, title: id, description: '', connections: { master: 'master' } })

test('静态读取与画布直接使用原生节点、端口和位置，不执行组件代码', t => {
  const root = workspace(t), native = flow(); save(root, 'leaf', native)
  const bundle = loadLfxBundle(root, 'leaf', config('leaf')), canvas = lfxCanvas(bundle.flow)
  assert.deepEqual(canvas.native, native)
  assert.deepEqual(graphLayout(canvas).positions.get('result'), native.data.nodes[1].position)
  assert.deepEqual(canvas.edges[0].data, native.data.edges[0].data)
  const bad = structuredClone(native); bad.data.edges[0].data.sourceHandle.name = 'missing'
  assert.throws(() => validateLfxFlow(bad), /端口/)
  bad.data.edges = []; bad.data.nodes[1].data.node.is_output = false
  assert.throws(() => validateLfxFlow(bad), /唯一/)
})

test('发布快照冻结源码；修改草稿不会改变旧版本，重新冻结采用当前草稿', t => {
  const root = workspace(t), native = flow(), module = join(root, 'mcp/compositions/leaf/src/own.py')
  save(root, 'leaf', native); mkdirSync(join(module, '..'), { recursive: true }); writeFileSync(module, 'value = 1')
  native.metadata = { hep: { modules: { own: 'compositions/leaf/src/own.py' } } }; save(root, 'leaf', native)
  const first = freezeLfxBundle(root, 'leaf', config('leaf')), published = { ...config('leaf'), flowDigest: first }
  writeFileSync(module, 'value = 2'); native.data.nodes[0].position.x = 900; save(root, 'leaf', native)
  assert.equal(loadLfxBundle(root, 'leaf', published).modules.own, 'value = 1')
  const second = freezeLfxBundle(root, 'leaf', published)
  assert.notEqual(second, first)
  assert.equal(loadLfxBundle(root, 'leaf', { ...published, flowDigest: second }).modules.own, 'value = 2')
  const file = join(root, 'mcp/compositions/leaf/versions', first, 'bundle.json')
  writeFileSync(file, readFileSync(file, 'utf8').replace('value = 1', 'value = 3'))
  assert.throws(() => loadLfxBundle(root, 'leaf', published), /摘要/)
})

test('原生固定子编排参与发布、下架和删除依赖检查，父绑定可包含子绑定的超集', t => {
  const root = workspace(t), child = { id: 'leaf' }; save(root, 'leaf', flow())
  publishCompositionVersion(child, { ...config('leaf'), flowDigest: freezeLfxBundle(root, 'leaf', config('leaf')) })
  const native = flow(); native.data.nodes[1].data.type = 'HepChild'
  Object.assign(native.data.nodes[1].data.node.template, { composition_id: { value: 'leaf' }, version_id: { value: child.publishedVersionId } })
  save(root, 'parent', native)
  const parent = { ...config('parent'), connections: { master: 'master', admin: 'admin' } }, catalog = { schema_version: '1.0', compositions: [child, { id: 'parent', draft: parent }] }
  writeFileSync(join(root, 'mcp/compositions.json'), JSON.stringify(catalog))
  assert.equal(Object.keys(loadLfxBundle(root, 'parent', parent).children).length, 1)
  const dependencies = value => lfxDependencies(root, value)
  assertPublishedDependencies(catalog, parent, new Set(), dependencies)
  assert.deepEqual(compositionReferences(catalog, 'leaf', false, dependencies), [{ id: 'parent', title: 'parent' }])
  delete child.published
  assert.throws(() => assertPublishedDependencies(catalog, parent, new Set(), dependencies), /下架/)
  assert.throws(() => loadLfxBundle(root, 'parent', { ...parent, connections: { master: 'wrong' } }, catalog), /连接绑定/)
})
