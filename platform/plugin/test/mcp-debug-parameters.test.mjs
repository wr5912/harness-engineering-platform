import assert from 'node:assert/strict'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const source = (await build({ entryPoints: [new URL('../../../plugins/mcp-manager/debug-parameters.tsx', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', jsx: 'transform' })).outputFiles[0].text
function moduleFor(confirm = () => true) {
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, window: { confirm } })
  return module.exports
}
const { initialArguments, parameterErrors, templateParameterSchema } = moduleFor()

function editor(schema, initial, draftState = {}, confirm = () => true) {
  const states = []
  let slot, tree
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    Fragment: Symbol('Fragment'),
    useState(value) {
      const i = slot++
      if (!(i in states)) states[i] = value
      return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next }]
    },
    useEffect(effect) { effect() },
  }
  const ParameterEditor = moduleFor(confirm).createParameterEditor(React)
  const props = { schema, value: initial ?? initialArguments(schema), draftState,
    onChange(value) { props.value = value }, onDraftStateChange(value) { props.draftState = value },
    onValidityChange(valid) { props.valid = valid } }
  function nodes(node) {
    if (!arguments.length) node = tree
    return Array.isArray(node) ? node.flatMap(item => nodes(item)) : node && typeof node === 'object'
      ? [node, ...nodes(node.props?.children ?? [])] : []
  }
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'boolean' ? '' : String(node ?? '')
  const render = () => { slot = 0; tree = ParameterEditor(props); return tree }
  const input = label => nodes().find(node => ['input', 'select', 'textarea'].includes(node.type) && node.props['aria-label'] === label)
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label)
  const change = (label, value) => { input(label).props.onChange({ target: { value } }); render() }
  render()
  return { props, render, nodes, text: () => text(tree), input, button, change }
}

test('初始参数只填可靠默认值、固定值及必填示例，保留 0、false、null', () => {
  const schema = { type: 'object', required: ['id', 'example', 'nested', 'complex'], properties: {
    id: { type: 'string' }, example: { type: 'string', examples: ['示例输入'] },
    optionalExample: { type: 'string', examples: ['不应自动提交'] },
    count: { type: 'integer', default: 0 }, enabled: { type: 'boolean', default: false },
    nullable: { type: ['string', 'null'], default: null }, fixed: { const: 'fixed' },
    invalidDefault: { type: 'integer', minimum: 1, default: 0 },
    nested: { type: 'object', properties: { size: { type: 'integer', default: 20 } } },
    optionalObject: { type: 'object', properties: { size: { type: 'integer', default: 20 } } },
    complex: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  } }
  assert.deepEqual(JSON.parse(initialArguments(schema)), { example: '示例输入', count: 0, enabled: false, nullable: null, fixed: 'fixed', nested: { size: 20 } })
  assert.deepEqual(JSON.parse(initialArguments()), {})
  assert.deepEqual(JSON.parse(initialArguments({ type: 'array', default: ['不作为根对象'] })), {})
})

test('基础校验指出具体必填、类型、枚举及嵌套范围，复杂约束留给服务', () => {
  const schema = { type: 'object', required: ['id'], additionalProperties: false, properties: {
    id: { type: 'string', minLength: 2 }, level: { enum: ['high', 'low'] }, count: { type: 'integer', minimum: 1, maximum: 20 },
    nested: { type: 'object', required: ['flag'], properties: { flag: { type: 'boolean' } } },
    items: { type: 'array', minItems: 1, items: { type: 'number' } },
  } }
  assert.match(parameterErrors(schema, '{}').join('\n'), /id：必填/)
  const errors = parameterErrors(schema, JSON.stringify({ id: 'x', level: 'other', count: 1.5, nested: {}, items: ['x'], extra: true })).join('\n')
  for (const phrase of ['id：至少2个字符', 'level：请选择允许的取值', 'count：需要integer类型', 'nested.flag：必填', 'items[1]：需要number类型', 'extra：未定义的字段']) assert.ok(errors.includes(phrase), phrase)
  assert.match(parameterErrors({}, '[]').join(), /必须是 JSON 对象/)
  assert.match(parameterErrors({}, '{').join(), /无法解析/)
  assert.equal(parameterErrors({ $ref: '#/somewhere' }, '{}').length, 0)
  assert.equal(parameterErrors({ type: 'object', const: { first: 1, second: 2 } }, '{"second":2,"first":1}').length, 0)
})

test('表单展示层级、必填和来源，未填写可选字段不提交，false 可以显式填写与移除', () => {
  const ui = editor({ type: 'object', required: ['id'], properties: {
    id: { type: 'string', title: '对象标识', description: '填写实际对象 ID。', maxLength: 40 }, enabled: { type: 'boolean' }, limit: { type: 'integer', default: 20, minimum: 0, maximum: 100 },
  } })
  assert.match(ui.text(), /对象标识 · id \*文本 · 必填/)
  assert.match(ui.text(), /填写实际对象 ID/)
  assert.match(ui.text(), /服务默认值：20/)
  assert.match(ui.text(), /最小值 0 · 最大值 100/)
  assert.match(ui.text(), /最多 40 个字符/)
  ui.change('id', '真实对象')
  ui.change('enabled', 'false')
  assert.deepEqual(JSON.parse(ui.props.value), { limit: 20, id: '真实对象', enabled: false })
  ui.change('enabled', '')
  assert.equal(Object.hasOwn(JSON.parse(ui.props.value), 'enabled'), false)
  ui.change('limit', '0')
  assert.equal(JSON.parse(ui.props.value).limit, 0)
})

test('非法局部 JSON 通过受控草稿恢复，禁止误用旧值或静默切换丢失输入', () => {
  const schema = { type: 'object', properties: { filter: { oneOf: [{ type: 'object' }, { type: 'string' }] } } }
  const first = editor(schema, '{"filter":{"old":true}}')
  first.change('filter JSON', '{"new":')
  assert.equal(first.props.valid, false)
  assert.deepEqual(JSON.parse(first.props.value), { filter: { old: true } })
  first.button('JSON 编辑').props.onClick(); first.render()
  assert.match(first.text(), /原文已保留/)
  const restored = editor(schema, first.props.value, first.props.draftState)
  assert.equal(restored.input('filter JSON').props.value, '{"new":')
  assert.equal(restored.props.valid, false)
  restored.change('filter JSON', '{"new":true}')
  assert.equal(restored.props.valid, true)
  assert.deepEqual(JSON.parse(restored.props.value), { filter: { new: true } })
  restored.button('JSON 编辑').props.onClick(); restored.render()
  assert.equal(restored.input('调用参数 JSON').props.value, restored.props.value)
})

test('数字半输入和非法全文 JSON 保留原文，修正后同步表单', () => {
  const schema = { type: 'object', properties: { limit: { type: 'number', default: 1 } } }
  const first = editor(schema)
  first.change('limit', '1e')
  assert.equal(first.props.valid, false)
  const restored = editor(schema, first.props.value, first.props.draftState)
  assert.equal(restored.input('limit').props.value, '1e')
  restored.change('limit', '1e2')
  assert.equal(restored.props.valid, true)
  assert.equal(JSON.parse(restored.props.value).limit, 100)
  restored.button('JSON 编辑').props.onClick(); restored.render()
  restored.change('调用参数 JSON', '{"limit":')
  assert.match(restored.text(), /参数 JSON 无法解析/)
  restored.button('表单填写').props.onClick(); restored.render()
  assert.equal(restored.input('调用参数 JSON').props.value, '{"limit":')
  assert.match(restored.text(), /请先修正参数 JSON/)
  restored.change('调用参数 JSON', '{"limit":2}')
  restored.button('表单填写').props.onClick(); restored.render()
  assert.equal(restored.input('limit').props.value, '2')
})

test('嵌套对象与数组增删按层级写回同一对象，未编造数字默认值', () => {
  const schema = { type: 'object', properties: { filter: { type: 'object', properties: { keyword: { type: 'string' } } }, ids: { type: 'array', items: { type: 'integer' } } } }
  const ui = editor(schema)
  ui.change('filter.keyword', '告警')
  assert.deepEqual(JSON.parse(ui.props.value), { filter: { keyword: '告警' } })
  ui.button('添加条目').props.onClick(); ui.render()
  assert.deepEqual(JSON.parse(ui.props.value).ids, [null])
  assert.match(parameterErrors(schema, ui.props.value).join(), /ids\[1\]：需要integer类型/)
  ui.change('ids.0', '7')
  assert.deepEqual(JSON.parse(ui.props.value).ids, [7])
  ui.button('删除').props.onClick(); ui.render()
  assert.deepEqual(JSON.parse(ui.props.value).ids, [])
  ui.button('移除此数组').props.onClick(); ui.render()
  assert.equal(Object.hasOwn(JSON.parse(ui.props.value), 'ids'), false)
})

test('恢复默认值须确认覆盖，并清理局部草稿；取消保留原输入', () => {
  const schema = { type: 'object', properties: { limit: { type: 'integer', default: 20 } } }
  const cancelled = editor(schema, '{"limit":5}', {}, () => false)
  cancelled.button('恢复默认值').props.onClick(); cancelled.render()
  assert.equal(JSON.parse(cancelled.props.value).limit, 5)
  const ui = editor(schema, '{"limit":5}', {}, () => true)
  ui.change('limit', '-')
  ui.button('恢复默认值').props.onClick(); ui.render()
  assert.equal(JSON.parse(ui.props.value).limit, 20)
  assert.equal(ui.input('limit').props.value, '20')
  assert.equal(ui.props.valid, true)
})

test('未声明字段或复杂模板默认使用 JSON，已声明无参工具保留清晰空态', () => {
  for (const schema of [{ type: 'object' }, { $ref: '#/input' }, templateParameterSchema('resource://assets/{?tags*}')]) {
    const ui = editor(schema)
    assert.ok(ui.input('调用参数 JSON'))
    assert.equal(ui.button('表单填写').props.disabled, true)
  }
  const empty = editor({ type: 'object', properties: {} })
  assert.match(empty.text(), /没有声明可填写的字段/)
  assert.equal(empty.input('调用参数 JSON'), undefined)
})

test('模板变量提示不复制服务必填规则，名称字段不会写入对象原型', () => {
  const template = templateParameterSchema('resource://assets/{id}{?query,tags,limit}')
  assert.deepEqual(Object.keys(template.properties), ['id', 'query', 'tags', 'limit'])
  assert.equal(template.required, undefined)
  assert.deepEqual(JSON.parse(initialArguments(template)), {})
  assert.match(template.properties.id.description, /类型与必填要求由模板和服务核对/)
  assert.match(templateParameterSchema('resource://assets/{id}{?tags*}').description, /由模板和服务核对/)
  const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object","properties":{"polluted":{"type":"string"}}}}}')
  const ui = editor(schema)
  ui.change('__proto__.polluted', '隔离')
  assert.deepEqual(JSON.parse(ui.props.value), JSON.parse('{"__proto__":{"polluted":"隔离"}}'))
  assert.equal(Object.prototype.polluted, undefined)
})

test('模板变量仅提示字段，不将推测类型作为数字和数组的调用限制', () => {
  const schema = templateParameterSchema('resource://assets/{id}{?limit,tags}')
  assert.equal(parameterErrors(schema, '{"id":1,"limit":10,"tags":["x","y"]}').length, 0)
  assert.equal(parameterErrors(schema, '{"id":"asset-1"}').length, 0)
  assert.deepEqual(JSON.parse(initialArguments(schema)), {})
})
