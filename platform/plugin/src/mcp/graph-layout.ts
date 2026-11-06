export type CompositionGraph = {
  native?: unknown
  nodes: { id: string; title?: string; operationId?: string; when?: string; kind?: string; description?: string; position?: { x: number; y: number } }[]
  edges: { source: string; target: string; conditional?: boolean; data?: any; label?: string }[]
}

export function graphLayout(graph: CompositionGraph) {
  if (graph.native && graph.nodes.length && graph.nodes.every(node => node.position)) {
    const positions = new Map(graph.nodes.map(node => [node.id, node.position!] as const))
    return { positions, width: Math.max(640, ...graph.nodes.map(node => node.position!.x + 288)), height: Math.max(300, ...graph.nodes.map(node => node.position!.y + 90)) }
  }
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
  const rows: string[][] = []
  for (const node of graph.nodes) (rows[ranks.get(node.id)!] ??= []).push(node.id)
  const width = Math.max(640, ...rows.map(row => row.length * 312 + 16)), height = Math.max(300, rows.length * 124 + 24)
  const positions = new Map(rows.flatMap((row, rank) => row.map((id, column) => [id, { x: (width - row.length * 312) / 2 + column * 312 + 24, y: 24 + rank * 124 }] as const)))
  return { width, height, positions }
}
