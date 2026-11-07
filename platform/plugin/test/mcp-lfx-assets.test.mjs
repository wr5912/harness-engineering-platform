import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freezeLfxBundle, lfxCanvas, lfxDependencies, loadLfxBundle, validateLfxFlow } from '../src/mcp/lfx-assets.ts'
import { assertPublishedDependencies, compositionConfig, compositionReferences, publishCompositionVersion } from '../src/mcp/compositions.ts'
import { graphLayout } from '../src/mcp/graph-layout.ts'
import { lfxWorkflow } from '../src/mcp/lfx-runtime.ts'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const program = fileURLToPath(new URL('../../../', import.meta.url))
const python = join(program, '.local/lfx', createHash('sha256').update(readFileSync(join(program, 'platform/mcp/lfx/requirements.txt'))).digest('hex'), 'bin/python')

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

test('静态读取保留原生节点、端口和位置，画布仅按连接关系布局，不执行组件代码', t => {
  const root = workspace(t), native = flow(); native.data.nodes[0].data.type = 'HepInput'; save(root, 'leaf', native)
  const bundle = loadLfxBundle(root, 'leaf', config('leaf')), canvas = lfxCanvas(bundle.flow)
  assert.deepEqual(canvas.native, native)
  assert.deepEqual(canvas.nodes[1].position, native.data.nodes[1].position)
  assert.equal(canvas.nodes[0].role, 'input'); assert.equal(canvas.nodes[1].role, 'output')
  const layout = graphLayout(canvas)
  assert(layout.positions.get('result').y > layout.positions.get('input').y)
  assert.deepEqual(canvas.edges[0].data, native.data.edges[0].data)
  const bad = structuredClone(native); bad.data.edges[0].data.sourceHandle.name = 'missing'
  assert.throws(() => validateLfxFlow(bad), /端口/)
  bad.data.edges = []; bad.data.nodes[1].data.node.is_output = false
  assert.throws(() => validateLfxFlow(bad), /至少一个结果节点/)
  native.data.nodes.push(node('branch-result', true))
  assert.doesNotThrow(() => validateLfxFlow(native))
})

test('条件重复或缺失的 go/stop 标签采用继续/返回，保留明确标签与原生端口', () => {
  const native = flow(), source = native.data.nodes[0].data.node
  source.metadata = { kind: 'condition' }
  source.outputs = [{ name: 'go', display_name: '是否继续？' }, { name: 'stop', display_name: '是否继续？' }]
  native.data.edges = ['go', 'stop'].map(name => ({ ...native.data.edges[0], data: { sourceHandle: { id: 'input', name }, targetHandle: { id: 'result', fieldName: 'value' } } }))
  const before = structuredClone(native), canvas = lfxCanvas(native)
  assert.deepEqual(canvas.edges.map(edge => edge.label), ['继续', '返回'])
  assert.deepEqual(canvas.edges.map(edge => edge.data), native.data.edges.map(edge => edge.data))
  assert.deepEqual(native, before)
  source.outputs[0].display_name = '已批准'; source.outputs[1].display_name = '等待审批'
  assert.deepEqual(lfxCanvas(native).edges.map(edge => edge.label), ['已批准', '等待审批'])
  source.outputs.forEach(output => { delete output.display_name })
  assert.deepEqual(lfxCanvas(native).edges.map(edge => edge.label), ['继续', '返回'])
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

test('Python 模块仅允许本编排和 MCP 共用源码，禁止跨包及符号链接逃逸', t => {
  const root = workspace(t), native = flow()
  save(root, 'leaf', native)
  for (const name of ['compositions/leaf/src', 'compositions/sibling/src', 'src']) mkdirSync(join(root, 'mcp', name), { recursive: true })
  const own = join(root, 'mcp/compositions/leaf/src/own.py'), shared = join(root, 'mcp/src/shared.py'), other = join(root, 'mcp/compositions/sibling/src/private.py')
  for (const file of [own, shared, other]) writeFileSync(file, 'value = 1')
  const check = path => { native.metadata = { hep: { modules: { code: path } } }; save(root, 'leaf', native); return loadLfxBundle(root, 'leaf', config('leaf')) }
  assert.equal(check('compositions/leaf/src/own.py').modules.code, 'value = 1')
  assert.equal(check('src/shared.py').modules.code, 'value = 1')
  assert.throws(() => check('compositions/sibling/src/private.py'), /本编排或 MCP 共用源码/)
  symlinkSync(other, join(root, 'mcp/compositions/leaf/src/link.py'))
  assert.throws(() => check('compositions/leaf/src/link.py'), /本编排或 MCP 共用源码/)
})

test('TypeScript 静态打包不执行；固定发布后组件及其共用依赖保持原字节', async t => {
  const root = workspace(t), native = flow(), own = join(root, 'mcp/compositions/typed/src')
  native.metadata = { hep: { typescript: 'src/index.ts' } }; save(root, 'typed', native)
  mkdirSync(own, { recursive: true }); mkdirSync(join(root, 'mcp/src'), { recursive: true })
  const shared = join(root, 'mcp/src/value.ts')
  writeFileSync(shared, 'export const value = 1')
  writeFileSync(join(own, 'index.ts'), 'import { value } from "../../../src/value.ts"; export function create() { return { prepare: async () => ({ value }), components: { echo: () => ({ value }) } } }')
  const first = freezeLfxBundle(root, 'typed', config('typed')), fixed = { ...config('typed'), flowDigest: first }
  writeFileSync(shared, 'export const value = 2')
  assert.notEqual(freezeLfxBundle(root, 'typed', config('typed')), first)
  const workflow = lfxWorkflow(root, 'typed', { inputSchema: {}, sourceDigest: 'current', connections: () => [] }, async () => undefined)
  assert.equal((await workflow.prepare({}, fixed, new AbortController().signal)).value, 1)
  assert.equal((await workflow.prepare({}, config('typed'), new AbortController().signal)).value, 2)
  writeFileSync(join(own, 'index.ts'), 'throw new Error("静态阶段禁止导入"); export function create() {}')
  assert.doesNotThrow(() => freezeLfxBundle(root, 'typed', config('typed')))
  save(root, 'sibling', flow()); mkdirSync(join(root, 'mcp/compositions/sibling/src'), { recursive: true })
  writeFileSync(join(root, 'mcp/compositions/sibling/src/private.ts'), 'export const value = 3')
  writeFileSync(join(own, 'index.ts'), 'import { value } from "../../sibling/src/private.ts"; export { value }')
  assert.throws(() => freezeLfxBundle(root, 'typed', config('typed')), /本编排或 MCP 共用源码/)
})

test('官方 HTTP 嵌套流程执行冻结 TS 组件，状态轮询不复用旧回执', { skip: !existsSync(python) }, t => {
  const root = workspace(t)
  const native = JSON.parse(execFileSync(python, ['-c', `
import json
from test_runtime import node, custom, flow, edge
from hep_lfx import HepInput
body=' async def build(self)->Data:\\n  from hep_lfx import component\\n  return Data(data=await component("read",payload(self.value),self._id))\\n'
print(json.dumps(flow([node(HepInput,'input'),custom('first',body),custom('second',body,output=True)],[edge('input','first'),edge('first','second')])))
`], { cwd: join(program, 'platform/mcp/lfx'), encoding: 'utf8' }))
  native.metadata = { hep: { typescript: 'src/index.ts' } }; save(root, 'typed', native)
  const source = join(root, 'mcp/compositions/typed/src')
  mkdirSync(source)
  writeFileSync(join(source, 'index.ts'), `export function create(invoke) { return { components: { read: async (input, config, context) => {
    const state = await context.call(() => invoke('master', 'status', {id:1}, context.signal));
    return { values: [...(input.values ?? []), state.value], frozen: 1 };
  } } } }`)
  const fixed = { ...config('typed'), flowDigest: freezeLfxBundle(root, 'typed', config('typed')) }
  const child = { id: 'typed' }; publishCompositionVersion(child, fixed)
  writeFileSync(join(root, 'mcp/compositions.json'), JSON.stringify({ schema_version: '1.0', compositions: [child] }))
  const parent = JSON.parse(execFileSync(python, ['-c', `
import json
from test_runtime import node, flow, edge
from hep_lfx import HepInput, HepChild
print(json.dumps(flow([node(HepInput,'input'),node(HepChild,'child',output=True,composition_id='typed',version_id=${JSON.stringify(child.publishedVersionId)})],[edge('input','child')])))
`], { cwd: join(program, 'platform/mcp/lfx'), encoding: 'utf8' }))
  save(root, 'parent', parent)
  const parentFixed = { ...config('parent'), flowDigest: freezeLfxBundle(root, 'parent', config('parent')) }
  writeFileSync(join(source, 'index.ts'), 'throw new Error("不得加载已修改的草稿")')
  const script = `
import assert from 'node:assert/strict';
import { lfxWorkflow } from ${JSON.stringify(new URL('../src/mcp/lfx-runtime.ts', import.meta.url).href)};
try {
  const config = ${JSON.stringify(parentFixed)}, nodes = []; let calls = 0;
  const workflow = lfxWorkflow(${JSON.stringify(root)},'parent', {inputSchema:{},sourceDigest:'test',connections:()=>[]},async()=>({value:++calls}));
  const signal = AbortSignal.timeout(30000), shared = await workflow.prepare({}, config, signal);
  const result = await workflow.execute({}, config, {runId:'test',nodeId:'root',signal,shared,call:fn=>fn(),progress(value){nodes.push({id:this.nodeId,...value})}});
  assert.deepEqual(result,{values:[1,2],frozen:1}); assert.equal(calls,2);
  assert.ok(nodes.some(node=>node.id==='root/child/second' && node.status==='completed'));
  process.exit(0);
} catch(error) { console.error(error); process.exit(1); }
`
  execFileSync(process.execPath, ['--input-type=module', '-'], { input: script, timeout: 40_000, env: { ...process.env, HARNESS_PROGRAM_ROOT: program } })
})
