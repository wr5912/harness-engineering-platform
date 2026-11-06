import { useEffect, useRef, useState } from 'react'
import { graphLayout, type CompositionGraph as Graph } from './graph-layout.ts'

/** 仅呈现服务端返回的图；配置编辑和执行继续使用现有入口。 */
export function CompositionCanvas({ graph, selected, onSelect, identity }: { graph?: Graph; selected?: string; onSelect(id: string): void; identity: string }) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [movedNodes, setMovedNodes] = useState<Record<string, { x: number; y: number }>>({})
  const plane = useRef<SVGGElement>(null)
  const suppressClick = useRef(false)
  const drag = useRef<{ pointer: number; clientX: number; clientY: number; start: DOMPoint; origin: { x: number; y: number }; matrix: DOMMatrix; node?: string } | null>(null)
  useEffect(() => { setView({ scale: 1, x: 0, y: 0 }); setMovedNodes({}); drag.current = null; suppressClick.current = false }, [identity])
  const nodes = graph?.nodes ?? []
  const title = (node: Graph['nodes'][number]) => node.id === '__start__' ? '开始' : node.id === '__end__' ? '结束' : node.title || node.id
  const kinds: Record<string, string> = { composition: '子编排', batch: '批量检查', condition: '条件判断', call: '接口调用', aggregate: '结果汇总', scope: '范围核对' }
  const { width, height, positions } = graphLayout(graph ?? { nodes: [], edges: [] })
  for (const [id, point] of Object.entries(movedNodes)) if (positions.has(id)) positions.set(id, point)
  const zoom = (amount: number) => setView(value => ({ ...value, scale: Math.max(.4, Math.min(2, Math.round((value.scale + amount) * 10) / 10)) }))
  return <section className="harness-flow-canvas" aria-label="编排画布">
    <header><span>控制流程 <small>{graph?.native ? 'LFX 原生流程' : '按执行步骤展示'}</small></span><div><button type="button" aria-label="缩小画布" disabled={view.scale <= .4} onClick={() => zoom(-.1)}>−</button><span aria-live="polite">{Math.round(view.scale * 100)}%</span><button type="button" aria-label="放大画布" disabled={view.scale >= 2} onClick={() => zoom(.1)}>＋</button><button type="button" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>适应画布</button><button type="button" disabled={!Object.keys(movedNodes).length} onClick={() => { setMovedNodes({}); setView({ scale: 1, x: 0, y: 0 }) }}>重置布局</button></div></header>
    {!nodes.length ? <p className="harness-flow-empty">此版本未提供图结构。可查看版本配置，当前画布不推断执行路径。</p> : <div className="harness-flow-viewport" onPointerDown={event => {
      if (event.button !== 0 || drag.current) return
      const node = (event.target as Element).closest<SVGGElement>('.harness-flow-node')
      // 节点用流程坐标，平移用 SVG 坐标，缩放及响应式尺寸均由浏览器矩阵换算。
      const matrix = (node ? plane.current : plane.current?.ownerSVGElement)?.getScreenCTM()?.inverse()
      if (!matrix) return
      const id = node?.dataset.nodeId
      suppressClick.current = false
      drag.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, start: new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix), origin: id ? positions.get(id)! : { x: view.x, y: view.y }, matrix, node: id }
      const target = node ?? event.currentTarget
      target.setPointerCapture?.(event.pointerId)
    }} onPointerMove={event => {
      const current = drag.current
      if (!current || current.pointer !== event.pointerId) return
      if (!suppressClick.current && Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) < 4) return
      suppressClick.current = true
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(current.matrix)
      const position = { x: current.origin.x + point.x - current.start.x, y: current.origin.y + point.y - current.start.y }
      if (current.node) setMovedNodes(value => ({ ...value, [current.node!]: position }))
      else setView(value => ({ ...value, ...position }))
    }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
      <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label="编排节点与路径">
        <g ref={plane} transform={`translate(${view.x} ${view.y}) translate(${width / 2} ${height / 2}) scale(${view.scale}) translate(${-width / 2} ${-height / 2})`}>
          {(graph?.edges ?? []).map((edge, index) => {
            const from = positions.get(edge.source), to = positions.get(edge.target)
            if (!from || !to) return null
            const y1 = from.y + 66, y2 = to.y, back = y2 <= from.y
            const side = Math.max(from.x, to.x) + 288
            return <g key={`${edge.source}-${edge.target}-${index}`} className="harness-flow-edge"><path strokeDasharray={edge.conditional ? '6 4' : undefined} d={back ? `M${from.x + 264} ${from.y + 33} C${side} ${from.y + 33} ${side} ${to.y + 33} ${to.x + 264} ${to.y + 33}` : `M${from.x + 132} ${y1} C${from.x + 132} ${(y1 + y2) / 2} ${to.x + 132} ${(y1 + y2) / 2} ${to.x + 132} ${y2 - 7}`}/>{!back && <path d={`m${to.x + 128} ${y2 - 12} 4 5 4-5`}/>}{edge.conditional && <text x={(from.x + to.x) / 2 + 140} y={back ? to.y + 24 : (y1 + y2) / 2}>{edge.label || (typeof edge.data === 'string' ? edge.data : '条件')}</text>}</g>
          })}
          {nodes.map(node => {
            const point = positions.get(node.id)!
            return <g key={node.id} data-node-id={node.id} transform={`translate(${point.x} ${point.y})`} className="harness-flow-node" role="button" tabIndex={0} aria-label={title(node)} aria-description="可拖动调整位置，也可用方向键移动；回车查看详情" aria-pressed={selected === node.id} onClick={() => { if (!suppressClick.current) onSelect(node.id); suppressClick.current = false }} onKeyDown={event => {
              const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
              if (direction) { event.preventDefault(); const step = event.shiftKey ? 30 : 10; setMovedNodes(value => ({ ...value, [node.id]: { x: point.x + direction[0] * step, y: point.y + direction[1] * step } })) }
              else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) }
            }}>
              <rect width="264" height="66" rx="9"/><text x="16" y="27">{title(node).slice(0, 16)}</text><text className="harness-flow-node-subtitle" x="16" y="48">{(kinds[node.kind ?? ''] || node.operationId || (node.id === '__start__' ? '开始' : node.id === '__end__' ? '结束' : node.id)).slice(0, 34)}</text><title>{title(node)}{node.description ? ` · ${node.description}` : ''}{node.when ? ` · ${node.when}` : ''}</title>
            </g>
          })}
        </g>
      </svg>
    </div>}
    <footer>拖动节点调整位置，拖动空白处平移；聚焦节点后可用方向键移动。布局仅用于当前查看，点击节点查看详情；箭头表示执行方向，虚线表示条件。</footer>
  </section>
}
