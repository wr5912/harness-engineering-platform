import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = (await build({ entryPoints: [new URL('../src/mcp/graph-canvas.tsx', import.meta.url).pathname], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })).outputFiles[0].text

function canvas() {
  const states = [], dependencies = [], cleanups = [], selected = [], captured = []
  const surface = new EventTarget()
  let cursor, effects, changed, tree, viewportRef
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = initial
      return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; return states[at] ??= { current: initial } },
    useCallback(callback) { const at = cursor++; return states[at] ??= callback },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  class Point {
    constructor(x, y) { this.x = x; this.y = y }
    matrixTransform(matrix) { return new Point(this.x * matrix.scale, this.y * matrix.scale) }
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, DOMPoint: Point, require: name => name === 'react' ? react : require(name) })
  const graph = { native: true, nodes: [{ id: 'a', position: { x: 100, y: 20 } }, { id: 'b', position: { x: 100, y: 160 } }], edges: [{ source: 'a', target: 'b' }] }
  const props = { graph, identity: 'version-one', onSelect: id => selected.push(id) }
  function items(value) {
    if (!arguments.length) value = tree
    return Array.isArray(value) ? value.flatMap(item => items(item)) : !value || typeof value !== 'object' ? [] : [value, ...items(value.props?.children ?? [])]
  }
  function render() {
    do {
      cursor = 0; effects = []; changed = false; tree = module.exports.CompositionCanvas(props)
      const viewport = items().find(item => item.props?.className === 'harness-flow-viewport')
      if (viewport) viewportRef = viewport.ref
      if (viewportRef) viewportRef.current = viewport ? surface : null
      const plane = items().find(item => item.type === 'g' && item.ref)
      if (plane) plane.ref.current = { getScreenCTM: () => ({ inverse: () => ({ scale: .5 }) }), ownerSVGElement: { getScreenCTM: () => ({ inverse: () => ({ scale: 2 }) }) } }
      effects.forEach(effect => effect())
    } while (changed)
  }
  render()
  const viewport = () => items().find(item => item.props?.className === 'harness-flow-viewport')
  const node = () => items().find(item => item.props?.['data-node-id'] === 'a')
  const event = (x, y, onNode = true, pointerId = 1) => ({ button: 0, pointerId, clientX: x, clientY: y,
    target: { closest: () => onNode ? { dataset: { nodeId: 'a' }, setPointerCapture: id => captured.push(id) } : null }, currentTarget: { setPointerCapture: id => captured.push(id) } })
  const pointer = (handler, e) => { viewport().props[handler](e); render() }
  const start = node().props.transform.match(/-?\d+(?:\.\d+)?/g).map(Number)
  const position = (x = 0, y = 0) => `translate(${start[0] + x} ${start[1] + y})`
  const wheel = (ctrlKey, deltaY) => {
    const event = new Event('wheel', { cancelable: true })
    Object.assign(event, { ctrlKey, deltaY })
    surface.dispatchEvent(event); render()
    return event.defaultPrevented
  }
  return { props, graph, render, items, node, viewport, event, pointer, selected, captured, position, wheel }
}

test('拖动节点按实际矩阵移动并更新连线，小幅点击仍选择，切换版本重置且不改写来源', () => {
  const ui = canvas(), source = JSON.stringify(ui.graph)
  const edge = () => ui.items().find(item => item.type === 'path').props.d
  const otherNode = () => ui.items().find(item => item.props?.['data-node-id'] === 'b').props.transform
  const plane = () => ui.items().find(item => item.type === 'g' && item.ref).props.transform
  const originalEdge = edge()
  const originalOther = otherNode(), originalView = plane()
  ui.pointer('onPointerDown', ui.event(20, 30)); ui.pointer('onPointerMove', ui.event(22, 30)); ui.pointer('onPointerUp', ui.event(22, 30))
  ui.node().props.onClick(); assert.deepEqual(ui.selected, ['a']); assert.equal(ui.node().props.transform, ui.position())
  ui.pointer('onPointerDown', ui.event(20, 30)); ui.pointer('onPointerMove', ui.event(100, 70))
  assert.equal(ui.node().props.transform, ui.position(40, 20)); assert.notEqual(edge(), originalEdge)
  assert.equal(otherNode(), originalOther); assert.equal(plane(), originalView)
  ui.pointer('onPointerUp', ui.event(100, 70)); ui.node().props.onClick(); assert.deepEqual(ui.selected, ['a'])
  ui.render(); assert.equal(ui.node().props.transform, ui.position(40, 20))
  ui.props.identity = 'version-two'; ui.render(); assert.equal(ui.node().props.transform, ui.position())
  assert.equal(JSON.stringify(ui.graph), source); assert.deepEqual(ui.captured, [1, 1])
})

test('平移与节点拖动分离，取消及丢失捕获后停止，方向键与重置布局可用', () => {
  const ui = canvas()
  ui.pointer('onPointerDown', ui.event(20, 30, false)); ui.pointer('onPointerMove', ui.event(50, 50, false))
  const plane = () => ui.items().find(item => item.type === 'g' && item.ref).props.transform
  assert.match(plane(), /^translate\(60 40\)/); assert.equal(ui.node().props.transform, ui.position())
  ui.pointer('onPointerCancel', ui.event(50, 50)); ui.pointer('onPointerMove', ui.event(100, 100)); assert.match(plane(), /^translate\(60 40\)/)
  ui.node().props.onKeyDown({ key: 'ArrowRight', preventDefault() {} }); ui.render(); assert.equal(ui.node().props.transform, ui.position(10, 0))
  ui.node().props.onKeyDown({ key: 'ArrowDown', shiftKey: true, preventDefault() {} }); ui.render(); assert.equal(ui.node().props.transform, ui.position(10, 30))
  ui.pointer('onPointerDown', ui.event(10, 10)); ui.pointer('onLostPointerCapture', ui.event(10, 10)); ui.pointer('onPointerMove', ui.event(100, 100)); assert.equal(ui.node().props.transform, ui.position(10, 30))
  ui.items().find(item => item.type === 'button' && item.props.children === '重置布局').props.onClick(); ui.render()
  assert.equal(ui.node().props.transform, ui.position()); assert.match(plane(), /^translate\(0 0\)/)
})

test('Ctrl＋滚轮复用缩放范围，普通滚轮放行，切换空图移除监听后可重新挂载', () => {
  const ui = canvas()
  const scale = () => Number(ui.items().find(item => item.type === 'g' && item.ref).props.transform.match(/scale\(([^)]+)\)/)[1])
  assert.equal(ui.wheel(false, -120), false); assert.equal(scale(), 1)
  assert.equal(ui.wheel(true, 0), false); assert.equal(scale(), 1)
  assert.equal(ui.wheel(true, -120), true); assert.equal(scale(), 1.1)
  assert.equal(ui.wheel(true, 120), true); assert.equal(scale(), 1)
  for (let index = 0; index < 30; index++) assert.equal(ui.wheel(true, -1), true)
  assert.equal(scale(), 2)
  assert.equal(ui.items().find(item => item.props?.['aria-label'] === '放大画布').props.disabled, true)
  for (let index = 0; index < 30; index++) assert.equal(ui.wheel(true, 1), true)
  assert.equal(scale(), .4)
  assert.equal(ui.items().find(item => item.props?.['aria-label'] === '缩小画布').props.disabled, true)
  ui.items().find(item => item.type === 'button' && item.props.children === '适应画布').props.onClick(); ui.render()
  assert.equal(scale(), 1)
  ui.props.graph = { nodes: [], edges: [] }; ui.render()
  assert.equal(ui.wheel(true, -120), false)
  ui.props.graph = ui.graph; ui.render()
  assert.equal(ui.wheel(true, -120), true); assert.equal(scale(), 1.1)
  ui.props.identity = 'version-two'; ui.render(); assert.equal(scale(), 1)
})
