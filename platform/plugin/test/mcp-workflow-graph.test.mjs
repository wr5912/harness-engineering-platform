import assert from 'node:assert/strict'
import test from 'node:test'
import { compileWorkflow, defineWorkflow, workflowStructure, START, END } from '../src/mcp/workflow-graph.ts'
import { nestedWorkflowGraph } from '../src/mcp/nested.ts'
import { compositionConfig, publishCompositionVersion } from '../src/mcp/compositions.ts'
import { graphLayout, graphNode, graphRoutes } from '../src/mcp/graph-layout.ts'

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

function routePoints(path) {
  let start
  const points = []
  for (const command of path.match(/[MLCQ][^MLCQ]*/g)) {
    const values = command.slice(1).match(/-?\d+(?:\.\d+)?/g).map(Number)
    const controls = Array.from({ length: values.length / 2 }, (_, i) => ({ x: values[i * 2], y: values[i * 2 + 1] }))
    if (command[0] === 'M') { start = controls[0]; points.push(start); continue }
    for (let i = 1; i <= 100; i++) {
      const t = i / 100, u = 1 - t, curve = [start, ...controls]
      while (curve.length > 1) for (let j = 0, count = curve.length - 1; j < count; j++) {
        curve[j] = { x: curve[j].x * u + curve[j + 1].x * t, y: curve[j].y * u + curve[j + 1].y * t }
        if (j === count - 1) curve.pop()
      }
      points.push(curve[0])
    }
    start = controls.at(-1)
  }
  return points
}

function assertClear(graph, layout, routes) {
  routes.forEach((route, index) => {
    const edge = graph.edges[index]
    for (const point of routePoints(route.path)) for (const node of graph.nodes) {
      if (node.id === edge.source || node.id === edge.target) continue
      const box = { ...layout.positions.get(node.id), ...layout.geometry.get(node.id) }
      assert(!(point.x > box.x + .1 && point.x < box.x + box.width - .1 && point.y > box.y + .1 && point.y < box.y + box.height - .1), `${edge.source}->${edge.target} 穿过 ${node.id}`)
    }
  })
}

test('同层短分支占用条件侧面通道时从底部绕行，不穿过相邻节点', () => {
  const graph = { nodes: ['root', 'a', 'b', 'choose', 'leaf', 'work', 'out', 'end'].map(id => ({ id, kind: ['root', 'choose'].includes(id) ? 'condition' : 'action' })),
    edges: [['root', 'a'], ['a', 'choose'], ['root', 'b'], ['b', 'leaf'], ['choose', 'work'], ['work', 'end'], ['choose', 'out']].map(([source, target]) => ({ source, target })) }
  const layout = graphLayout(graph), routes = graphRoutes(graph, layout)
  assert.equal(layout.positions.get('choose').y, layout.positions.get('leaf').y)
  assertClear(graph, layout, routes)
  const source = layout.positions.get('choose'), shape = layout.geometry.get('choose')
  assert(routes.at(-1).path.startsWith(`M${source.x + shape.width / 2} ${source.y + shape.height}`))
})

test('四路分支的短路径在目标上方汇合，前向边不折返、不绕到图外、不叠用入口', () => {
  const graph = { nodes: ['input', 'scope', 'mode', 'explicit', 'pairs-explicit', 'rules', 'pairs-rules', 'rulesError', 'noRules', 'selected-result', 'summary'].map(id => ({ id, kind: id === 'mode' ? 'condition' : 'scope' })),
    edges: [['input', 'scope'], ['scope', 'mode'], ['mode', 'explicit'], ['explicit', 'pairs-explicit'], ['pairs-explicit', 'selected-result'], ['mode', 'rules'], ['rules', 'pairs-rules'], ['pairs-rules', 'selected-result'], ['mode', 'rulesError'], ['rulesError', 'selected-result'], ['mode', 'noRules'], ['noRules', 'selected-result'], ['selected-result', 'summary']].map(([source, target]) => ({ source, target })) }
  const before = structuredClone(graph), layout = graphLayout(graph), routes = graphRoutes(graph, layout)
  assertClear(graph, layout, routes)
  for (const route of routes) {
    const points = routePoints(route.path)
    assert(points.every((point, i) => !i || point.y >= points[i - 1].y - .01), '前向边不得向上折返')
  }
  for (const source of ['rulesError', 'noRules']) {
    const route = routes[graph.edges.findIndex(edge => edge.source === source)]
    const sourceX = layout.positions.get(source).x + 120
    assert(routePoints(route.path).every(point => point.x <= sourceX + .01), '短分支应沿本列下降')
  }
  const incoming = routes.filter((_, i) => graph.edges[i].target === 'selected-result')
  assert.equal(new Set(incoming.map(route => route.x)).size, 4)
  assert.deepEqual(graph, before)
})

test('跨层直通通道被中间节点占用时从邻近空隙绕行，拖动后按实际位置重新计算', () => {
  const graph = { nodes: ['a', 'b', 'c', 'd'].map(id => ({ id })), edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd']].map(([source, target]) => ({ source, target })) }
  const layout = graphLayout(graph), routes = graphRoutes(graph, layout)
  assertClear(graph, layout, routes)
  assert(routePoints(routes[3].path).some(point => Math.abs(point.x - (layout.positions.get('a').x + 120)) > 120))
  const previous = routes[3].path
  layout.positions.set('c', { ...layout.positions.get('c'), x: layout.positions.get('c').x + 296 })
  const moved = graphRoutes(graph, layout)
  assertClear(graph, layout, moved)
  assert.notEqual(moved[2].path, routes[2].path)
  assert.equal(moved[3].path, previous)
})

test('多条回边与自环使用独立外侧通道，箭头落到目标且适应画布包含通道', () => {
  const graph = { nodes: ['a', 'b', 'c'].map(id => ({ id })), edges: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'b'], ['c', 'c']].map(([source, target]) => ({ source, target })) }
  const layout = graphLayout(graph), routes = graphRoutes(graph, layout)
  assertClear(graph, layout, routes)
  const right = Math.max(...graph.nodes.map(node => layout.positions.get(node.id).x + 240))
  const rails = routes.slice(2).map(route => Math.max(...routePoints(route.path).map(point => point.x)))
  assert.equal(new Set(rails).size, 3)
  assert(rails.every(x => x > right && x < layout.width))
  routes.forEach((route, i) => {
    assert.equal(route.y, layout.positions.get(graph.edges[i].target).y - 3)
    assert.deepEqual(routePoints(route.path).at(-1), { x: route.x, y: route.y })
  })
})

test('纵向布局以最长路径为主干，短分支复用空列，忽略原生网格且不改写流程', () => {
  const spine = ['input', 'resolve', 'preview', 'choose-preview', 'draft', 'choose-draft', 'submit', 'approval', 'choose-execute', 'execute', 'observe', 'result']
  const branches = ['preview-result', 'draft-result', 'waiting-result'], conditions = ['choose-preview', 'choose-draft', 'choose-execute']
  const graph = { native: true, nodes: [...spine, ...branches].map(id => ({ id, kind: conditions.includes(id) ? 'condition' : 'action', role: id === 'input' ? 'input' : id === 'result' || branches.includes(id) ? 'output' : undefined, position: { x: 9000, y: 9000 } })),
    edges: [...spine.slice(1).map((id, index) => ({ source: spine[index], target: id })), ...branches.map((id, index) => ({ source: conditions[index], target: id, conditional: true }))] }
  const before = structuredClone(graph), layout = graphLayout(graph), x = layout.positions.get('input').x
  assert(spine.every(id => layout.positions.get(id).x === x))
  assert(branches.every(id => layout.positions.get(id).x > x))
  assert.equal(new Set(branches.map(id => layout.positions.get(id).x)).size, 1)
  for (const edge of graph.edges) assert(layout.positions.get(edge.source).y + layout.geometry.get(edge.source).height < layout.positions.get(edge.target).y)
  for (const [index, a] of graph.nodes.entries()) for (const b of graph.nodes.slice(index + 1)) {
    const p = layout.positions.get(a.id), q = layout.positions.get(b.id), ga = layout.geometry.get(a.id), gb = layout.geometry.get(b.id)
    assert(p.x + ga.width <= q.x || q.x + gb.width <= p.x || p.y + ga.height <= q.y || q.y + gb.height <= p.y)
  }
  assert(layout.height <= 1140, `布局高度 ${layout.height} 应比 1480px 预览缩短约 25%`)
  assert.deepEqual(graphLayout(graph), layout); assert.deepEqual(graph, before)
})

test('节点形状按类型区分，长标题完整换行并扩展高度，显式首尾仍为胶囊', () => {
  const title = '这是需要完整显示的很长条件名称，继续核对设备参数和审批结果后是否执行？'
  const condition = graphNode({ id: 'choose', kind: 'condition', title })
  assert.equal(condition.shape, 'diamond'); assert.equal(condition.lines.join(''), title)
  assert(condition.height > 96)
  assert.equal(graphNode({ id: 'in', role: 'input' }).shape, 'parallelogram')
  assert.equal(graphNode({ id: 'out', role: 'output' }).category, 'output')
  assert.equal(graphNode({ id: 'call', kind: 'call' }).shape, 'rect')
  assert.equal(graphNode({ id: START }).shape, 'terminal')
})
