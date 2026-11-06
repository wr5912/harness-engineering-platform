import assert from 'node:assert/strict'
import test from 'node:test'
import { compileWorkflow, defineWorkflow, workflowStructure, START, END } from '../src/mcp/workflow-graph.ts'
import { nestedWorkflowGraph } from '../src/mcp/nested.ts'
import { compositionConfig, publishCompositionVersion } from '../src/mcp/compositions.ts'
import { graphLayout } from '../src/mcp/graph-layout.ts'

test('结构查询不执行；条件只走选中分支，批量内部仍来自同一执行图', async () => {
  const visited = []
  const inner = compileWorkflow([
    { id: 'choose', title: '选择', kind: 'condition', run: () => { visited.push('choose'); return {} }, route: { select: state => state.input.ok ? '有证据' : '缺少证据', paths: { '有证据': 'read', '缺少证据': 'unknown' } } },
    ...['read', 'unknown'].map(id => ({ id, title: id, kind: 'call', run: () => { visited.push(id); return { result: { status: id } } } })),
  ], [{ source: START, target: 'choose' }, { source: 'read', target: END }, { source: 'unknown', target: END }])
  const workflow = defineWorkflow(() => compileWorkflow([{ id: 'batch', title: '逐项处理', kind: 'batch', subgraph: inner, run: async state => ({ result: (await inner.invoke({ input: state.input, values: {} })).result }) }], [{ source: START, target: 'batch' }, { source: 'batch', target: END }]))
  const structure = await workflow.structure({})
  assert.deepEqual(visited, [])
  assert.equal(structure.nodes.find(node => node.id === 'batch').subgraph.edges.filter(edge => edge.conditional).length, 2)
  const result = await workflow.execute({ ok: false }, {}, { signal: AbortSignal.timeout(3000), nodeId: 'root', progress() {} })
  assert.equal(result.status, 'unknown')
  assert.deepEqual(visited, ['choose', 'unknown'])
})

test('父组合的图与运行共用输入依赖；独立步骤并行、汇合等待、单项失败保留', async () => {
  const catalog = { schema_version: '1.0', compositions: ['a', 'b', 'c'].map(id => {
    const entry = { id }; publishCompositionVersion(entry, compositionConfig({ kind: 'workflow', workflow: id, toolName: id, title: id, description: '' })); return entry
  }) }
  const config = compositionConfig({ kind: 'composite', workflow: 'parent', toolName: 'parent', title: 'parent', description: '', steps: catalog.compositions.map(entry => ({ id: entry.id, compositionId: entry.id, versionId: entry.publishedVersionId, inputMap: entry.id === 'c' ? { evidence: '$steps.a.value' } : { scope: '$input.scope' } })) })
  let active = 0, peak = 0, aggregated = 0
  const finished = new Set()
  const graph = nestedWorkflowGraph(config, catalog, async (_child, input, step) => {
    if (step.id === 'c') { assert(finished.has('a')); assert.equal(input.evidence, 7) }
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, step.id === 'a' ? 5 : 10))
    active--; finished.add(step.id)
    if (step.id === 'b') throw new Error('upstream offline')
    return { value: 7 }
  }, async values => { aggregated++; assert.equal(finished.size, 3); return values })
  const structure = await workflowStructure(graph)
  assert.equal(finished.size, 0)
  const layout = graphLayout(structure)
  assert.equal(layout.positions.get('a').y, layout.positions.get('b').y)
  assert(layout.positions.get('c').y > layout.positions.get('a').y)
  assert.equal(structure.nodes.find(node => node.id === 'a').versionId, catalog.compositions[0].publishedVersionId)
  const state = await graph.invoke({ input: { scope: 'selected' }, values: {} })
  assert.equal(peak, 2); assert.equal(aggregated, 1)
  assert.equal(state.result.b.status, 'failed'); assert.equal(state.result.b.error, 'upstream offline')
})

test('布局保留条件和回边，不改写实际图', () => {
  const graph = { nodes: ['start', 'left', 'right', 'end'].map(id => ({ id })), edges: [{ source: 'start', target: 'left', conditional: true }, { source: 'start', target: 'right', conditional: true }, { source: 'left', target: 'end' }, { source: 'right', target: 'end' }, { source: 'end', target: 'left', conditional: true }] }
  const before = structuredClone(graph), layout = graphLayout(graph)
  assert.equal(layout.positions.size, 4)
  assert.deepEqual(graph, before)
})
