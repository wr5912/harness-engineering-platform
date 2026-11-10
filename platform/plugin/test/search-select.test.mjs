import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = (await build({ entryPoints: [new URL('../src/components/search-select.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'], logLevel: 'silent' })).outputFiles[0].text

// 沿用页面测试的 Hook 调度方式，运行真实选择器；布局只替换浏览器边界。
function selector(overrides = {}, viewport = 1200) {
  const states = [], dependencies = [], cleanups = [], elements = new WeakMap(), events = new Map(), changes = []
  let cursor = 0, effects, changed, tree, focused = 0, scrolled = 0
  const props = { value: 'first', label: '工具', options: [
    { value: 'first', label: '第一项', description: '很长的说明。'.repeat(80) + '最后的搜索词' },
    { value: 'disabled', label: '不可用项', disabled: true }, { value: 'last', label: '最后一项' },
  ], onChange: value => { changes.push(value); props.value = value }, ...overrides }
  function effect(run, deps) {
    const index = cursor++
    if (!deps || !dependencies[index] || deps.some((value, at) => !Object.is(value, dependencies[index][at]))) {
      dependencies[index] = deps
      effects.push(() => { cleanups[index]?.(); cleanups[index] = run() })
    }
  }
  const react = { ...require('react'),
    useId() { const index = cursor++; return `search-${index}` },
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => {
      const next = typeof value === 'function' ? value(states[index]) : value
      if (!Object.is(next, states[index])) { states[index] = next; changed = true }
    }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect: effect, useLayoutEffect: effect,
  }
  const window = { innerWidth: viewport, innerHeight: 900,
    addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) }
  const document = { body: {}, addEventListener: (name, callback) => events.set(name, callback), removeEventListener: name => events.delete(name) }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, window, document,
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: value => value } : require(name) })
  function nodes(value) {
    if (arguments.length === 0) value = tree
    if (Array.isArray(value)) return value.flatMap(nodes)
    if (!value || typeof value !== 'object') return []
    return [value, ...nodes(value.props?.children)]
  }
  function render() {
    let count = 0
    do {
      if (++count > 20) throw new Error('选择器发生渲染循环')
      cursor = 0; effects = []; changed = false; tree = module.exports.SearchSelect(props)
      for (const node of nodes()) if (node.ref) {
        if (!elements.has(node.ref)) elements.set(node.ref, {
          getClientRects: () => [{}], getBoundingClientRect: () => ({ left: 100, top: 100, bottom: 140, width: 160 }),
          closest: () => null, contains: () => false, focus: () => focused++,
          querySelector: () => ({ scrollIntoView: () => scrolled++ }),
        })
        node.ref.current = elements.get(node.ref)
      }
      effects.forEach(run => run())
    } while (changed)
    return tree
  }
  const node = role => nodes().find(item => item.props?.role === role)
  const key = (target, key) => target.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {},
    nativeEvent: { isComposing: false }, target: { closest: () => null } })
  const open = () => { node('combobox').props.onClick(); render() }
  render()
  return { props, render, nodes, node, key, open, events, changes, window,
    get focused() { return focused }, get scrolled() { return scrolled } }
}

test('MCP 可扩展下拉宽度并限制描述行数，搜索仍匹配完整描述', () => {
  const ui = selector({ popupMinWidth: 560, descriptionLines: 2 }); ui.open()
  const popup = ui.nodes().find(node => node.props?.className === 'hep-search-popup')
  assert.equal(popup.props.style.width, 560)
  const description = ui.nodes().find(node => node.type === 'small')
  assert.equal(description.props.style.WebkitLineClamp, 2)
  assert.match(description.props.children, /最后的搜索词$/)
  ui.nodes().find(node => node.props?.['aria-label'] === '搜索工具').props.onChange({ target: { value: '最后的搜索词' } }); ui.render()
  assert.equal(ui.nodes().filter(node => node.props?.role === 'option').length, 1)
  assert.equal(ui.node('option').props['aria-selected'], true)
})

test('服务候选的 OpenAPI 规范地址可搜索并完整显示', () => {
  const specUrl = 'http://172.16.138.223:18087/v3/api-docs/mcp'
  const ui = selector({ value: 'soc', options: [{ value: 'soc', label: 'ai-soc-correlate', group: '服务', description: `OpenAPI 规范地址：${specUrl}` }] })
  ui.open()
  assert.equal(ui.nodes().find(node => node.type === 'small').props.children, `服务 · OpenAPI 规范地址：${specUrl}`)
  ui.nodes().find(node => node.props?.['aria-label'] === '搜索工具').props.onChange({ target: { value: '18087/v3/api-docs/mcp' } }); ui.render()
  assert.equal(ui.nodes().filter(node => node.props?.role === 'option').length, 1)
  assert.equal(ui.node('option').props['aria-selected'], true)
})

test('工具接口地址独立完整展示，方法、路径及完整 URL 均可搜索', () => {
  const detail = 'POST https://business.example/api/v2/items/{id}/lookup'
  const ui = selector({ descriptionLines: 2, options: [
    { value: 'first', label: '查询条目', detail, description: '很长的说明。'.repeat(80) },
    { value: 'other', label: '其他工具' },
  ] })
  assert.ok(ui.node('combobox').props.title.startsWith(detail + '\n'))
  ui.open()
  const lines = ui.nodes().filter(node => node.type === 'small')
  assert.equal(lines[0].props.children, detail)
  assert.equal(lines[0].props.style, undefined)
  assert.equal(lines[1].props.style.WebkitLineClamp, 2)
  for (const query of ['post', '/v2/items/{id}', detail.slice(5)]) {
    ui.nodes().find(node => node.props?.['aria-label'] === '搜索工具').props.onChange({ target: { value: query } }); ui.render()
    assert.equal(ui.nodes().filter(node => node.props?.role === 'option').length, 1)
    assert.equal(ui.node('option').props['aria-selected'], true)
  }
})

test('默认选择器保持既有宽度及完整描述，扩展菜单在窄屏保持12px边界', () => {
  const regular = selector(); regular.open()
  assert.equal(regular.nodes().find(node => node.props?.className === 'hep-search-popup').props.style.width, 240)
  assert.equal(regular.nodes().find(node => node.type === 'small').props.style, undefined)
  const mobile = selector({ popupMinWidth: 560, descriptionLines: 2 }, 390); mobile.open()
  const { width, left } = mobile.nodes().find(node => node.props?.className === 'hep-search-popup').props.style
  assert.equal(width, 366); assert.equal(left, 12)
})

test('方向键跳过禁用候选，Enter提交身份并关闭弹层及恢复焦点', () => {
  const ui = selector(); ui.open()
  const popup = () => ui.nodes().find(node => node.props?.className === 'hep-search-popup')
  ui.key(popup(), 'ArrowDown'); ui.render()
  ui.key(popup(), 'ArrowDown'); ui.render()
  assert.equal(ui.nodes().find(node => node.props?.['data-active']).props.children[0].props.children[0].props.children, '最后一项')
  ui.key(popup(), 'Enter'); ui.render()
  assert.deepEqual(ui.changes, ['last'])
  assert.equal(ui.node('combobox').props['aria-expanded'], false)
  assert.ok(ui.focused >= 2); assert.equal(ui.scrolled, 2)
})

test('分类浏览不切换已选身份，外部切换和禁用关闭旧菜单', () => {
  const ui = selector({ groups: ['迭代版本', '算力变体'], options: [
    { value: 'first', label: '版本1', group: '迭代版本' }, { value: 'variant', label: '变体1', group: '算力变体' },
  ] }); ui.open()
  assert.equal(ui.nodes().find(node => node.props?.className === 'hep-search-popup').props.style.width, 320)
  ui.nodes().find(node => node.type === 'button' && node.props.children?.[0] === '算力变体').props.onClick(); ui.render()
  assert.equal(ui.node('option').props.children[0].props.children[0].props.children, '变体1')
  assert.deepEqual(ui.changes, []); assert.equal(ui.props.value, 'first')
  ui.props.value = 'variant'; ui.render()
  assert.equal(ui.node('combobox').props['aria-expanded'], false)
  ui.open(); ui.props.disabled = true; ui.render()
  assert.equal(ui.node('combobox').props['aria-expanded'], false)
})

test('Escape关闭并恢复焦点，窗口变化重新约束宽度', () => {
  const ui = selector({ popupMinWidth: 560 }); ui.open()
  ui.window.innerWidth = 390; ui.events.get('resize')(); ui.render()
  const popup = ui.nodes().find(node => node.props?.className === 'hep-search-popup')
  assert.equal(popup.props.style.width, 366)
  ui.key(popup, 'Escape'); ui.render()
  assert.equal(ui.node('combobox').props['aria-expanded'], false)
  assert.ok(ui.focused >= 2)
})
