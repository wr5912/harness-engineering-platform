import { useCallback, useEffect, useRef, useState } from 'react'
import { graphLayout, graphRoutes, type CompositionGraph as Graph } from './graph-layout.ts'

/** 仅呈现服务端返回的图；配置编辑和执行继续使用现有入口。 */
export function CompositionCanvas({ graph, selected, onSelect, identity }: { graph?: Graph; selected?: string; onSelect(id: string): void; identity: string }) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [movedNodes, setMovedNodes] = useState<Record<string, { x: number; y: number }>>({})
  const [surface, setSurface] = useState({ width: 640, height: 480 })
  const viewport = useRef<HTMLDivElement>(null)
  const plane = useRef<SVGGElement>(null)
  const suppressClick = useRef(false)
  const drag = useRef<{ pointer: number; clientX: number; clientY: number; start: DOMPoint; origin: { x: number; y: number }; matrix: DOMMatrix; node?: string } | null>(null)
  useEffect(() => { setView({ scale: 1, x: 0, y: 0 }); setMovedNodes({}); drag.current = null; suppressClick.current = false }, [identity])
  const nodes = graph?.nodes ?? []
  const layout = graphLayout(graph ?? { nodes: [], edges: [] })
  const { width, height, positions, geometry } = layout
  for (const [id, point] of Object.entries(movedNodes)) if (positions.has(id)) positions.set(id, point)
  const routes = graphRoutes(graph ?? { nodes: [], edges: [] }, layout)
  const zoom = useCallback((amount: number) => setView(value => ({ ...value, scale: Math.max(.4, Math.min(2, Math.round((value.scale + amount) * 10) / 10)) })), [])
  const hasNodes = nodes.length > 0
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return
      event.preventDefault()
      zoom(event.deltaY < 0 ? .1 : -.1)
    }
    // 使用非被动监听，阻止 Ctrl＋滚轮同时触发浏览器整页缩放。
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [hasNodes, zoom])
  useEffect(() => {
    const element = viewport.current
    if (!element || typeof ResizeObserver === 'undefined') return
    // SVG 单位跟随视口像素，长流程保持可读字号，通过平移继续浏览。
    const observer = new ResizeObserver(([entry]) => setSurface({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasNodes])
  return <section className="harness-flow-canvas" aria-label="编排画布">
    <header><div className="harness-flow-heading"><span>控制流程 <small>{graph?.native ? 'LFX 原生流程' : '按执行步骤展示'}</small></span><ul className="harness-flow-legend" aria-label="节点类型图例">{[['input', '输入'], ['process', '处理'], ['condition', '判断'], ['output', '输出']].map(([kind, label]) => <li key={kind} data-kind={kind}><i aria-hidden="true"/>{label}</li>)}</ul></div><div><button type="button" aria-label="缩小画布" disabled={view.scale <= .4} onClick={() => zoom(-.1)}>−</button><span aria-live="polite">{Math.round(view.scale * 100)}%</span><button type="button" aria-label="放大画布" disabled={view.scale >= 2} onClick={() => zoom(.1)}>＋</button><button type="button" onClick={() => { const scale = Math.max(.4, Math.floor(Math.min(1, surface.width / width, surface.height / height) * 10) / 10); setView({ scale, x: 0, y: (surface.height - height) * scale / 2 }) }}>适应画布</button><button type="button" disabled={!Object.keys(movedNodes).length} onClick={() => { setMovedNodes({}); setView({ scale: 1, x: 0, y: 0 }) }}>重置布局</button></div></header>
    {!nodes.length ? <p className="harness-flow-empty">此版本未提供图结构。可查看版本配置，当前画布不推断执行路径。</p> : <div ref={viewport} className="harness-flow-viewport" onPointerDown={event => {
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
      <svg viewBox={`${(width - surface.width) / 2} 0 ${surface.width} ${surface.height}`} role="group" aria-label="编排节点与路径">
        <g ref={plane} transform={`translate(${view.x} ${view.y}) translate(${width / 2} ${surface.height / 2}) scale(${view.scale}) translate(${-width / 2} ${-surface.height / 2})`}>
          {(graph?.edges ?? []).map((edge, index) => {
            const route = routes[index]
            if (!route) return null
            const { path, x: x2, y: y2, labelX, labelY } = route
            const label = edge.label || (typeof edge.data === 'string' ? edge.data : '条件')
            const labelWidth = Array.from(label).reduce((size, character) => size + (/[\x00-\xff]/.test(character) ? 7 : 12), 16)
            return <g key={`${edge.source}-${edge.target}-${index}`} className="harness-flow-edge" data-source={edge.source} data-target={edge.target}><path d={path}/><path d={`M${x2 - 4} ${y2 - 5} l4 6 4-6`}/>{edge.conditional && <g className="harness-flow-edge-label" transform={`translate(${labelX} ${labelY})`}><rect x={-labelWidth / 2} y={-10} width={labelWidth} height={20} rx={4}/><text textAnchor="middle" dominantBaseline="central">{label}</text></g>}</g>
          })}
          {nodes.map(node => {
            const point = positions.get(node.id)!
            const { title, category, shape, width: w, height: h, lines } = geometry.get(node.id)!
            return <g key={node.id} data-node-id={node.id} data-kind={category} transform={`translate(${point.x} ${point.y})`} className="harness-flow-node" role="button" tabIndex={0} aria-label={title} aria-description="可拖动调整位置，也可用方向键移动；回车查看详情" aria-pressed={selected === node.id} onClick={() => { if (!suppressClick.current) onSelect(node.id); suppressClick.current = false }} onKeyDown={event => {
              const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
              if (direction) { event.preventDefault(); const step = event.shiftKey ? 30 : 10; setMovedNodes(value => ({ ...value, [node.id]: { x: point.x + direction[0] * step, y: point.y + direction[1] * step } })) }
              else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id) }
            }}>
              {shape === 'diamond' ? <polygon className="harness-flow-shape" points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`}/> : shape === 'parallelogram' ? <polygon className="harness-flow-shape" points={`16,0 ${w},0 ${w - 16},${h} 0,${h}`}/> : <rect className="harness-flow-shape" width={w} height={h} rx={shape === 'terminal' ? h / 2 : 4}/>}
              <text textAnchor="middle" dominantBaseline="central">{lines.map((line, index) => <tspan key={index} x={w / 2} y={h / 2 + (index - (lines.length - 1) / 2) * 20}>{line}</tspan>)}</text><title>{title}{node.description ? ` · ${node.description}` : ''}{node.when ? ` · ${node.when}` : ''}</title>
            </g>
          })}
        </g>
      </svg>
    </div>}
    <footer>按住 Ctrl 并滚动鼠标滚轮缩放；拖动空白处平移，拖动节点或用方向键调整位置。布局仅用于当前查看；箭头表示执行方向，连线旁显示条件，颜色区分节点类型。</footer>
  </section>
}
