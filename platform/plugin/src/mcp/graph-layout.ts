export type CompositionGraph = {
  native?: unknown
  nodes: { id: string; title?: string; operationId?: string; when?: string; kind?: string; role?: 'input' | 'output'; description?: string; position?: { x: number; y: number } }[]
  edges: { source: string; target: string; conditional?: boolean; data?: any; label?: string }[]
}

export function graphNode(node: CompositionGraph['nodes'][number]) {
  const terminal = node.id === '__start__' || node.id === '__end__'
  const title = node.id === '__start__' ? '开始' : node.id === '__end__' ? '结束' : node.title || node.id
  const category = terminal ? node.id === '__start__' ? 'input' : 'output' : node.kind === 'condition' ? 'condition' : node.role || 'process'
  const shape = terminal ? 'terminal' : category === 'condition' ? 'diamond' : category === 'input' || category === 'output' ? 'parallelogram' : 'rect'
  const width = terminal ? 120 : 240, textWidth = shape === 'diamond' ? 144 : shape === 'parallelogram' ? 176 : width - 32
  const lines: string[] = []
  let line = '', size = 0
  for (const character of title) {
    const advance = /[\x00-\xff]/.test(character) ? /[MW@%]/.test(character) ? 13 : 8 : 14
    if (character === '\n' || size + advance > textWidth) { lines.push(line); line = ''; size = 0 }
    if (character !== '\n') { line += character; size += advance }
  }
  if (line || !lines.length) lines.push(line)
  if (lines.length > 1 && Array.from(lines.at(-1)!).length < 3) {
    const last = lines.pop()!, previous = Array.from(lines.pop()!)
    const split = Math.ceil((previous.length + Array.from(last).length) / 2)
    lines.push(previous.slice(0, split).join(''), previous.slice(split).join('') + last)
  }
  const height = terminal ? 40 : shape === 'diamond' ? Math.max(96, lines.length * 50 - 4) : Math.max(56, lines.length * 20 + 24)
  return { title, category, shape, width, height, lines }
}

export function graphLayout(graph: CompositionGraph) {
  const geometry = new Map(graph.nodes.map(node => [node.id, graphNode(node)]))
  const ids = new Set(graph.nodes.map(node => node.id)), ranks = new Map<string, number>(), pending = new Set(ids)
  // 先排无环主流程；回边保留在原图中，不反复抬高节点层级。
  while (pending.size) {
    const ready = [...pending].filter(id => graph.edges.every(edge => edge.target !== id || !ids.has(edge.source) || !pending.has(edge.source)))
    if (!ready.length) ready.push([...pending][0])
    for (const id of ready) {
      const sources = graph.edges.filter(edge => edge.target === id && ranks.has(edge.source)).map(edge => ranks.get(edge.source)! + 1)
      ranks.set(id, Math.max(0, ...sources)); pending.delete(id)
    }
  }
  const outgoing = new Map([...ids].map(id => [id, graph.edges.filter(edge => edge.source === id && ranks.has(edge.target) && ranks.get(edge.target)! > ranks.get(id)!)]))
  const depth = new Map<string, number>()
  for (const [id] of [...ranks].reverse()) depth.set(id, 1 + Math.max(0, ...outgoing.get(id)!.map(edge => depth.get(edge.target)!)))
  const rows: string[][] = []
  for (const node of graph.nodes) (rows[ranks.get(node.id)!] ??= []).push(node.id)
  const occupied = rows.map(() => new Set<number>()), columns = new Map<string, number>()
  function place(id: string, column: number) {
    if (columns.has(id)) return
    const row = occupied[ranks.get(id)!]
    while (row.has(column)) column++
    columns.set(id, column); row.add(column)
    // 最长后续路径先占主干，短分支在右侧复用空列；汇合节点只放置一次。
    const children = [...outgoing.get(id)!].sort((a, b) => depth.get(b.target)! - depth.get(a.target)!)
    children.forEach((edge, index) => place(edge.target, column + (index ? 1 : 0)))
  }
  for (const [id] of ranks) place(id, 0)
  const contentWidth = (Math.max(0, ...columns.values()) + 1) * 296 - 56
  const returns = graph.edges.filter(edge => ranks.has(edge.source) && ranks.has(edge.target) && ranks.get(edge.target)! <= ranks.get(edge.source)!).length
  const width = Math.max(640, contentWidth + Math.max(80, 48 + returns * 32))
  const positions = new Map<string, { x: number; y: number }>()
  let y = 24
  for (const row of rows) {
    for (const id of row) positions.set(id, { x: (width - contentWidth) / 2 + columns.get(id)! * 296 + (240 - geometry.get(id)!.width) / 2, y })
    y += Math.max(...row.map(id => geometry.get(id)!.height)) + (row.some(id => geometry.get(id)!.category === 'condition') ? 32 : 24)
  }
  return { width, height: Math.max(300, y), positions, geometry, ranks }
}

export function graphRoutes(graph: CompositionGraph, layout: ReturnType<typeof graphLayout>) {
  const { positions, geometry, ranks } = layout
  const boxes = graph.nodes.map(node => ({ id: node.id, ...positions.get(node.id)!, ...geometry.get(node.id)! }))
  const center = (id: string) => positions.get(id)!.x + geometry.get(id)!.width / 2
  let returnLane = 0
  return graph.edges.map(edge => {
    const from = positions.get(edge.source), to = positions.get(edge.target)
    if (!from || !to) return undefined
    const source = geometry.get(edge.source)!, target = geometry.get(edge.target)!
    const x1 = center(edge.source), y1 = from.y + source.height, targetCenter = center(edge.target)
    let x2 = targetCenter
    // 汇合线按来源顺序接入不同位置，避免多条边叠成一条无法追踪的线。
    if (target.shape === 'rect' || target.shape === 'parallelogram') {
      const direction = Math.sign(x1 - targetCenter)
      const incoming = graph.edges.filter(item => item.target === edge.target && positions.has(item.source) && Math.sign(center(item.source) - targetCenter) === direction)
        .sort((a, b) => Math.abs(center(a.source) - targetCenter) - Math.abs(center(b.source) - targetCenter))
      if (direction) x2 += direction * (incoming.indexOf(edge) + 1) * Math.min(28, (target.width / 2 - 24) / incoming.length)
    }
    const y2 = to.y - 3
    const exit = from.x + (x2 > x1 ? source.width : 0), middle = from.y + source.height / 2
    const sideClear = !boxes.some(box => box.id !== edge.source && box.id !== edge.target && box.x < Math.max(exit, x2) + 8
      && box.x + box.width > Math.min(exit, x2) - 8 && box.y < y2 && box.y + box.height > middle)
    let path: string, labelX = x1 + 28, labelY = (y1 + to.y) / 2
    if (to.y <= y1) {
      const side = Math.max(...boxes.map(box => box.x + box.width)) + 24 + returnLane++ * 16
      const bottom = Math.max(y1, ...boxes.filter(box => ranks.get(box.id) === ranks.get(edge.source)).map(box => box.y + box.height)) + 12
      path = `M${x1} ${y1} L${x1} ${bottom - 6} Q${x1} ${bottom} ${x1 + 6} ${bottom} L${side - 6} ${bottom} Q${side} ${bottom} ${side} ${bottom - 6} L${side} ${to.y - 18} Q${side} ${to.y - 12} ${side - 6} ${to.y - 12} L${x2 + 6} ${to.y - 12} Q${x2} ${to.y - 12} ${x2} ${y2}`
      labelY = bottom
    } else if (source.category === 'condition' && Math.abs(x1 - x2) > 1 && ranks.get(edge.target) === ranks.get(edge.source)! + 1 && sideClear) {
      path = `M${exit} ${middle} C${(exit + x2) / 2} ${middle} ${x2} ${middle} ${x2} ${y2}`
      labelX = (exit + x2) / 2; labelY = middle - 14
    } else {
      // 前向跨层边沿空列下降，在目标上一层的空隙转弯；只有真正的回边走外侧。
      const turnY = Math.max(y1, to.y - 24)
      const obstacles = boxes.filter(box => box.id !== edge.source && box.id !== edge.target)
      const blocked = (x: number) => obstacles.some(box => x > box.x - 8 && x < box.x + box.width + 8 && box.y < turnY && box.y + box.height > y1)
      let rail = x1
      let prefix = `M${x1} ${y1}`
      if (blocked(rail)) {
        const candidates = boxes.flatMap(box => [box.x - 16, box.x + box.width + 16]).sort((a, b) => Math.abs(a - x1) - Math.abs(b - x1))
        rail = candidates.find(x => !blocked(x))!
        const exitY = Math.min(turnY, Math.max(y1, ...boxes.filter(box => ranks.get(box.id) === ranks.get(edge.source)).map(box => box.y + box.height)) + 12)
        prefix += ` L${x1} ${exitY} L${rail} ${exitY}`
      }
      path = Math.abs(rail - x2) < 1 ? `${prefix} L${x2} ${y2}` : `${prefix} L${rail} ${turnY} C${rail} ${(turnY + y2) / 2} ${x2} ${(turnY + y2) / 2} ${x2} ${y2}`
    }
    return { path, x: x2, y: y2, labelX, labelY }
  })
}
