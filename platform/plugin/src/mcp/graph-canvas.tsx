import { useEffect, useRef, useState } from 'react'

type GraphNode = { id: string; title?: string; operationId?: string; when?: string }
type Graph = { nodes: GraphNode[]; edges: { source: string; target: string; conditional?: boolean }[] }

/** 仅呈现服务端返回的图；配置编辑和执行继续使用现有入口。 */
export function CompositionCanvas({ graph, selected, onSelect, identity }: { graph?: Graph; selected?: string; onSelect(id: string): void; identity: string }) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ pointer: number; x: number; y: number; left: number; top: number } | null>(null)
  useEffect(() => { setView({ scale: 1, x: 0, y: 0 }); drag.current = null }, [identity])
  const nodes = graph?.nodes ?? []
  const title = (node: GraphNode) => node.id === '__start__' ? '开始' : node.id === '__end__' ? '结束' : node.title || node.id
  const width = 640, height = Math.max(300, nodes.length * 104 + 36)
  const positions = new Map(nodes.map((node, index) => [node.id, { x: width / 2 - 132, y: 24 + index * 104 }]))
  const zoom = (amount: number) => setView(value => ({ ...value, scale: Math.max(.4, Math.min(2, Math.round((value.scale + amount) * 10) / 10)) }))
  return <section className="harness-flow-canvas" aria-label="只读编排画布">
    <header><span>LangGraph 流程 <small>只读</small></span><div><button type="button" aria-label="缩小画布" disabled={view.scale <= .4} onClick={() => zoom(-.1)}>−</button><span aria-live="polite">{Math.round(view.scale * 100)}%</span><button type="button" aria-label="放大画布" disabled={view.scale >= 2} onClick={() => zoom(.1)}>＋</button><button type="button" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>适应画布</button></div></header>
    {!nodes.length ? <p className="harness-flow-empty">此版本未提供图结构。可查看版本配置，当前画布不推断执行路径。</p> : <div className="harness-flow-viewport" onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest('[role=button]')) return
      drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: view.x, top: view.y }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }} onPointerMove={event => {
      const current = drag.current
      if (current?.pointer === event.pointerId) setView(value => ({ ...value, x: current.left + event.clientX - current.x, y: current.top + event.clientY - current.y }))
    }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="编排节点与路径">
        <g transform={`translate(${view.x} ${view.y}) translate(${width / 2} ${height / 2}) scale(${view.scale}) translate(${-width / 2} ${-height / 2})`}>
          {(graph?.edges ?? []).map((edge, index) => {
            const from = positions.get(edge.source), to = positions.get(edge.target)
            if (!from || !to) return null
            const y1 = from.y + 66, y2 = to.y
            return <g key={`${edge.source}-${edge.target}-${index}`} className="harness-flow-edge"><path d={`M${from.x + 132} ${y1} C${from.x + 132} ${(y1 + y2) / 2} ${to.x + 132} ${(y1 + y2) / 2} ${to.x + 132} ${y2 - 7}`}/><path d={`m${to.x + 128} ${y2 - 12} 4 5 4-5`}/>{edge.conditional && <text x={from.x + 145} y={(y1 + y2) / 2}>条件</text>}</g>
          })}
          {nodes.map(node => {
            const point = positions.get(node.id)!
            return <g key={node.id} transform={`translate(${point.x} ${point.y})`} className="harness-flow-node" role="button" tabIndex={0} aria-label={title(node)} aria-pressed={selected === node.id} onClick={() => onSelect(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) } }}>
              <rect width="264" height="66" rx="9"/><text x="16" y="27">{title(node).slice(0, 26)}</text><text className="harness-flow-node-subtitle" x="16" y="48">{(node.operationId || (node.id === '__start__' ? '开始' : node.id === '__end__' ? '结束' : node.id)).slice(0, 34)}</text><title>{title(node)}{node.when ? ` · ${node.when}` : ''}</title>
            </g>
          })}
        </g>
      </svg>
    </div>}
    <footer>拖动画布平移，选择节点查看输入、输出和执行回执。</footer>
  </section>
}
