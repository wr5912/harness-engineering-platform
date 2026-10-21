import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

// 运行实际客户端产物，只替换 React 的状态调度和 Portal 容器。
function editor({ fetch = async () => { throw new Error('未预期的 MCP 管理请求') } } = {}) {
  const require = createRequire(import.meta.url)
  const states = [], dependencies = []
  const clipboard = []
  let registration, cursor, effects, changed
  const react = {
    ...require('react'),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], value => {
        states[index] = typeof value === 'function' ? value(states[index]) : value
        changed = true
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = { current: initial }
      return states[index]
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (!dependencies[index] || deps.some((value, at) => value !== dependencies[index][at])) {
        dependencies[index] = deps
        effects.push(effect)
      }
    },
  }
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    .replace('return module.exports;}});', 'return { ...module.exports, Manager };}});')
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { registration = value } }, addEventListener() {}, removeEventListener() {}, confirm: () => true },
    structuredClone, URL, location: { origin: 'http://127.0.0.1:3090' },
    document: { baseURI: 'http://127.0.0.1:3090/hep/' },
    navigator: { clipboard: { writeText: async value => { clipboard.push(value) } } },
    fetch,
  })
  const { Manager } = registration.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? {} : name === 'react' ? react
    : name === 'react-dom' ? { ...require(name), createPortal: element => element } : require(name))
  const server = { id: 'biz-soc-framework', description: '', enabled: true,
    specUrl: 'http://127.0.0.1:18080/v3/api-docs/mcp', authType: 'credential',
    authHeader: 'X-API-Key', apiKey: 'fixture-credential', tools: { mode: 'all', names: [] } }
  const groups = [{ id: 'research', members: [{ serverId: 'platform-compositions', names: ['query_asset_related_alerts'] }] }]
  const writes = [], selections = []
  const props = { view: 'servers', toolbarTarget: {}, onValidationError: () => { props.view = 'servers' },
    onSelectServerId: id => { selections.push(id); props.selectedServerId = id },
    form: { state: { status: 'ready', writable: true, revision: 'r1', value: { servers: [server], groups, sharedToken: '' } } },
    publishedService: { id: 'platform-compositions', platformComposition: true, enabled: true,
      description: '工具组合编排（已发布）', publishedTools: [{ name: 'query_asset_related_alerts' }],
      tools: { mode: 'all', names: ['query_asset_related_alerts'] } },
    write: async (ops, revision) => {
      writes.push({ ops, revision })
      return revision === props.form.state.revision ? { ok: true }
        : { ok: false, error: { message: '配置版本冲突' } }
    },
  }
  let tree
  function render() {
    do {
      cursor = 0; effects = []; changed = false
      tree = Manager(props)
      effects.forEach(effect => effect())
    } while (changed)
    return tree
  }
  function renderBeforeEffects() {
    const previousDependencies = dependencies.slice()
    cursor = 0; effects = []; changed = false
    tree = Manager(props)
    dependencies.splice(0, dependencies.length, ...previousDependencies)
    return tree
  }
  function nodes(value) {
    if (arguments.length === 0) value = tree
    if (Array.isArray(value)) return value.flatMap(item => nodes(item))
    if (!value || typeof value !== 'object') return []
    return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))]
  }
  function text(value) {
    if (Array.isArray(value)) return value.map(text).join('')
    if (value?.type === 'style') return ''
    return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
  }
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label)
  const serviceButton = name => nodes().find(node => node.props?.className === 'mcp-list-item' && text(node).startsWith(name))
  const input = label => {
    if (!nodes().some(node => node.type === 'label' && text(node) === label)) {
      button('连接配置')?.props.onClick()
      render()
    }
    return nodes(nodes().find(node => node.type === 'label' && text(node) === label))
      .find(node => node.type === 'input')
  }
  render()
  return { render, nodes, text, button, serviceButton, input, writes, selections, copied: clipboard, clipboard, server, groups,
    refreshValue: (value = props.form.state.value, revision = props.form.state.revision) => {
      props.form.state.value = structuredClone(value)
      props.form.state.revision = revision
      render()
    },
    setPublishedTools: names => {
      props.publishedService = { ...props.publishedService, tools: { mode: 'all', names },
        publishedTools: names.map(name => ({ toolName: name })) }
      render()
    },
    setView: value => { props.view = value; render() }, getView: () => props.view,
    setServerId: value => { props.selectedServerId = value; render() },
    replaceDraftServersBeforeEffects: servers => { states[0] = { ...states[0], servers: structuredClone(servers) }; return renderBeforeEffects() } }
}

test('自动生成的已发布组合服务不参与原生服务保存校验或持久化', async () => {
  const ui = editor()
  assert.match(ui.text(ui.serviceButton('工具组合编排')), /已发布工具目录.*连接与工具发现待检查.*本页尚未检查/)
  ui.input('描述（可选）').props.onChange({ target: { value: '18080' } })
  ui.render()
  ui.serviceButton('工具组合编排').props.onClick()
  ui.render()
  assert.match(ui.text(ui.render()), /已发布组合生成的服务.*已发布工具.*query_asset_related_alerts/)
  assert.equal(ui.input('ID'), undefined)
  assert.equal(ui.button('保存更改').props.disabled, false)
  await ui.button('保存更改').props.onClick()
  ui.render()
  assert.equal(ui.writes.length, 1)
  const { ops, revision } = ui.writes[0]
  assert.equal(revision, 'r1')
  assert.deepEqual(ops.find(op => op.path[0] === 'servers').value, [{ ...ui.server, description: '18080' }])
  assert.deepEqual(ops.find(op => op.path[0] === 'groups').value, ui.groups)
  assert.match(ui.text(ui.render()), /配置已保存/)
})

test('非空服务详情按原型层级呈现服务选择、状态摘要和真实发现结果', async () => {
  const ui = editor({ fetch: async () => ({ ok: true, json: async () => ({ tools: [{ name: 'lookup', description: '读取测试资产' }], resources: { resources: [] } }) }) })
  assert.ok(ui.nodes().some(node => node.props?.className === 'mcp-mobile-service-picker'))
  const statusCards = () => ui.nodes().filter(node => node.type === 'article' && node.props?.children).map(ui.text)
  assert.equal(statusCards().length, 3)
  assert.match(statusCards()[2], /业务验证范围.*未验证.*请核对实际调用与目标业务结果/)
  assert.match(ui.text(ui.render()), /待检查.*待核对.*尚未检查当前配置/)
  ui.button('连接测试').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  ui.render()
  assert.match(ui.text(ui.render()), /连接状态.*规范已读取.*工具发现.*1 个工具.*已发现的工具.*lookup.*读取测试资产/)
  assert.match(statusCards()[2], /业务验证范围.*未验证.*请核对实际调用与目标业务结果/)
  assert.match(ui.text(ui.render()), /实际调用和业务结果待验证/)
  ui.button('连接配置').props.onClick()
  ui.render()
  assert.ok(ui.input('ID'))
})

test('服务列表区分检查成功、失败和未保存配置', async () => {
  const ui = editor({ fetch: async () => ({ ok: true, json: async () => ({ tools: [{ name: 'lookup' }], resources: { resources: [] } }) }) })
  assert.match(ui.text(ui.serviceButton('biz-soc-framework')), /连接与工具发现待检查.*本页尚未检查/)
  ui.setView('connection')
  await ui.button('发现工具与资源').props.onClick()
  ui.setView('servers')
  assert.match(ui.text(ui.serviceButton('biz-soc-framework')), /规范已读取 · 已发现 1 个工具.*最近检查/)
  assert.match(ui.text(ui.render()), /实际调用和业务结果待验证/)
  ui.button('连接配置').props.onClick()
  ui.render()
  const typeField = ui.nodes().find(node => node.type === 'select' && node.props.value === 'openapi')
  assert.ok(typeField)
  typeField.props.onChange({ target: { value: 'mcp' } })
  ui.render()
  assert.match(ui.text(ui.serviceButton('biz-soc-framework')), /当前修改未保存.*保存当前配置后再检查/)
  assert.doesNotMatch(ui.text(ui.serviceButton('biz-soc-framework')), /最近检查/)

  const failed = editor({ fetch: async () => ({ ok: false, json: async () => ({ error: '连接超时' }) }) })
  failed.setView('connection')
  await failed.button('发现工具与资源').props.onClick()
  failed.setView('servers')
  assert.match(failed.text(failed.serviceButton('biz-soc-framework')), /检查失败，连接与工具发现待核对.*最近检查/)
  assert.doesNotMatch(failed.text(failed.serviceButton('biz-soc-framework')), /规范已读取/)
})

test('列表中的其他服务不完整时定位该服务和具体字段，且不写入配置', async () => {
  const ui = editor()
  ui.button('＋ 新增服务器').props.onClick()
  ui.render()
  ui.input('ID').props.onChange({ target: { value: 'unfinished' } })
  ui.render()
  ui.nodes().find(node => node.type === 'button' && ui.text(node).startsWith('biz-soc-framework')).props.onClick()
  ui.render()
  assert.equal(ui.input('ID').props.value, 'biz-soc-framework')
  ui.setView('groups')
  ui.refreshValue()
  await ui.button('保存更改').props.onClick()
  ui.render()
  assert.equal(ui.writes.length, 0)
  assert.equal(ui.getView(), 'servers')
  assert.equal(ui.input('ID').props.value, 'unfinished')
  assert.match(ui.text(ui.render()), /第 2 项服务：请填写 OpenAPI 接口规范地址/)
  ui.input('ID').props.onChange({ target: { value: ' unfinished ' } })
  ui.render()
  await ui.button('保存更改').props.onClick()
  ui.render()
  assert.equal(ui.writes.length, 0)
  assert.match(ui.text(ui.render()), /第 2 项服务：ID 须为 1–32/)
  ui.refreshValue({ servers: [{ ...ui.server, description: '外部更新' }], groups: ui.groups, sharedToken: '' })
  assert.equal(ui.nodes().filter(node => node.props?.className === 'mcp-list-item').length, 3)
  assert.match(ui.text(ui.render()), /配置已在其他位置更新，当前草稿已保留/)
  assert.equal(ui.input('ID').props.value, ' unfinished ')
  assert.equal(ui.writes.length, 0)
})

test('无修改时同步外部配置，未保存草稿保留输入和原版本并明确拒绝过期保存', async () => {
  const ui = editor()
  ui.refreshValue({ servers: [{ ...ui.server, description: '外部更新' }], groups: ui.groups, sharedToken: '' }, 'r2')
  assert.equal(ui.nodes().filter(node => node.props?.className === 'mcp-list-item').length, 2)
  ui.nodes().find(node => node.type === 'button' && ui.text(node).startsWith('biz-soc-framework')).props.onClick()
  ui.render()
  assert.equal(ui.input('描述（可选）').props.value, '外部更新')
  ui.input('描述（可选）').props.onChange({ target: { value: '本地草稿' } })
  ui.render()
  ui.refreshValue({ servers: [{ ...ui.server, description: '其他编辑者更新' }], groups: ui.groups, sharedToken: '' }, 'r3')
  assert.equal(ui.input('描述（可选）').props.value, '本地草稿')
  assert.match(ui.text(ui.render()), /配置已在其他位置更新，当前草稿已保留/)
  await ui.button('保存更改').props.onClick()
  ui.render()
  assert.equal(ui.writes.length, 1)
  assert.equal(ui.writes[0].revision, 'r2')
  assert.equal(ui.writes[0].ops.find(op => op.path[0] === 'servers').value[0].description, '本地草稿')
  assert.equal(ui.input('描述（可选）').props.value, '本地草稿')
  assert.match(ui.text(ui.render()), /配置版本冲突/)
})

test('MCP 分组入口使用当前站点基址与 v2 路径', async () => {
  const ui = editor()
  ui.refreshValue({ servers: [ui.server], groups: ui.groups, sharedToken: 'fixture-token' })
  ui.setView('groups')
  assert.match(ui.text(ui.render()), /http:\/\/127\.0\.0\.1:3090\/hep\/mcp\/groups\/research\/v2/)
  await ui.button('复制分组链接').props.onClick()
  assert.deepEqual(ui.copied, ['http://127.0.0.1:3090/hep/mcp/groups/research/v2'])
})

test('旧分组重复成员需显式合并并保存后才可复制 v2 链接', async () => {
  const ui = editor()
  const group = { id: 'legacy', members: [
    { serverId: ui.server.id, names: ['first', 'shared'], resourceUris: ['fixture:/one'], resourceTemplates: ['fixture:/item/{id}'] },
    { serverId: ui.server.id, names: ['shared', 'second'], resourceUris: ['fixture:/one', 'fixture:/two'], resourceTemplates: ['fixture:/other/{id}'] },
  ] }
  ui.refreshValue({ servers: [ui.server], groups: [group], sharedToken: 'fixture-token' })
  ui.setView('groups')
  assert.match(ui.text(ui.render()), /重复成员，v2 链接不可用/)
  assert.equal(ui.button('复制分组链接').props.disabled, true)
  assert.doesNotMatch(ui.text(ui.render()), /http:\/\/127\.0\.0\.1:3090\/hep\/mcp\/groups\/legacy\/v2/)
  const second = ui.nodes().find(node => node.type === 'label' && node.props?.className === 'mcp-check' && ui.text(node).startsWith('second'))
  assert.equal(ui.nodes(second).find(node => node.type === 'input').props.disabled, true)
  ui.button('合并同源成员').props.onClick()
  ui.render()
  assert.match(ui.text(ui.render()), /重复成员已在草稿中合并/)
  assert.equal(ui.button('复制分组链接').props.disabled, true)
  const mergedChoice = ui.nodes().find(node => node.type === 'label' && node.props?.className === 'mcp-check' && ui.text(node).startsWith('second'))
  assert.equal(ui.nodes(mergedChoice).find(node => node.type === 'input').props.disabled, false)
  await ui.button('保存更改').props.onClick()
  const saved = ui.writes.at(-1).ops.find(op => op.path[0] === 'groups').value[0]
  assert.equal(saved.members.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(saved.members[0])), {
    serverId: ui.server.id, names: ['first', 'shared', 'second'],
    resourceUris: ['fixture:/one', 'fixture:/two'],
    resourceTemplates: ['fixture:/item/{id}', 'fixture:/other/{id}'],
  })
  assert.equal(ui.button('复制分组链接').props.disabled, true)
  ui.refreshValue({ servers: [ui.server], groups: [saved], sharedToken: 'fixture-token' }, 'r2')
  assert.equal(ui.button('复制分组链接').props.disabled, false)
  await ui.button('复制分组链接').props.onClick()
  assert.deepEqual(ui.copied, ['http://127.0.0.1:3090/hep/mcp/groups/legacy/v2'])
})

test('新分组保存前不提供可复制链接，现有链接仅使用已保存配置', () => {
  const ui = editor()
  ui.setView('groups')
  assert.equal(ui.button('复制分组链接').props.disabled, true)
  assert.match(ui.text(ui.render()), /请生成并保存统一访问 Token/)
  ui.button('＋ 新增分组').props.onClick()
  ui.render()
  ui.input('分组 ID').props.onChange({ target: { value: 'new-group' } })
  ui.render()
  assert.match(ui.text(ui.render()), /此分组尚未保存/)
  assert.equal(ui.button('复制分组链接').props.disabled, true)
  const existing = editor()
  existing.refreshValue({ servers: [existing.server], groups: existing.groups, sharedToken: 'fixture-token' })
  existing.setView('groups')
  const checked = existing.nodes().find(node => node.type === 'label' && node.props?.className === 'mcp-check'
    && existing.text(node).startsWith('query_asset_related_alerts'))
  existing.nodes(checked).find(node => node.type === 'input').props.onChange()
  existing.render()
  assert.match(existing.text(existing.render()), /当前草稿尚未保存；链接仍使用上次保存的配置/)
  assert.equal(existing.button('复制分组链接').props.disabled, false)
})

test('已发布组合更名后保留旧分组选择并标记当前未发现', () => {
  const ui = editor()
  ui.setView('groups')
  assert.doesNotMatch(ui.text(ui.render()), /已选来源 platform-compositions 不在服务列表中/)
  assert.doesNotMatch(ui.text(ui.render()), /query_asset_related_alerts（当前未发现）/)
  ui.setPublishedTools(['replacement_query'])
  assert.match(ui.text(ui.render()), /query_asset_related_alerts（当前未发现）/)
  assert.match(ui.text(ui.render()), /replacement_query/)
  assert.doesNotMatch(ui.text(ui.render()), /已选来源 platform-compositions 不在服务列表中/)
})

test('分组三类选择保留草稿；发现后失效项可见，三个页签不重复显示总述', async () => {
  let discovered = { tools: [{ name: 'query_asset' }], resources: { resources: [{ uri: 'soc://asset/9106' }] },
    resourceTemplates: { resourceTemplates: [{ uriTemplate: 'soc://asset/{id}' }] } }
  const ui = editor({ fetch: async (_url, init) => {
    assert.equal(JSON.parse(init.body).action, 'test')
    return { ok: true, json: async () => discovered }
  } })
  const heading = () => ui.nodes().filter(node => node.props?.className === 'mcp-heading')
  assert.equal(heading().length, 0)
  ui.setView('groups')
  assert.equal(heading().length, 0)
  ui.button('发现工具与资源').props.onClick()
  await new Promise(resolve => setImmediate(resolve)); ui.render()
  const choice = label => ui.nodes().find(node => node.type === 'label' && node.props?.className === 'mcp-check' && ui.text(node).startsWith(label))
  for (const label of ['query_asset', 'soc://asset/9106', 'soc://asset/{id}']) {
    assert.ok(choice(label), label)
    ui.nodes(choice(label)).find(node => node.type === 'input').props.onChange()
    ui.render()
  }
  const beforeSave = ui.text(ui.render())
  assert.match(beforeSave, /2 个工具 · 1 个资源 · 1 个模板/)
  await ui.button('保存更改').props.onClick()
  const member = ui.writes.at(-1).ops.find(op => op.path[0] === 'groups').value[0].members.find(item => item.serverId === 'biz-soc-framework')
  assert.deepEqual(JSON.parse(JSON.stringify(member)), { serverId: 'biz-soc-framework', names: ['query_asset'],
    resourceUris: ['soc://asset/9106'], resourceTemplates: ['soc://asset/{id}'] })
  ui.nodes(choice('query_asset')).find(node => node.type === 'input').props.onChange()
  ui.render()
  await ui.button('保存更改').props.onClick()
  const resourcesOnly = ui.writes.at(-1).ops.find(op => op.path[0] === 'groups').value[0].members.find(item => item.serverId === 'biz-soc-framework')
  assert.deepEqual(JSON.parse(JSON.stringify(resourcesOnly)), { serverId: 'biz-soc-framework', names: [],
    resourceUris: ['soc://asset/9106'], resourceTemplates: ['soc://asset/{id}'] })
  discovered = { tools: [], resources: { resources: [] }, resourceTemplates: { resourceTemplates: [] } }
  ui.button('发现工具与资源').props.onClick()
  await new Promise(resolve => setImmediate(resolve)); ui.render()
  assert.equal((ui.text(ui.render()).match(/当前未发现/g) ?? []).length, 2)
  ui.setView('connection')
  assert.equal(heading().length, 0)
})

test('深链按服务 ID 恢复，失效 ID 不静默选中其他服务', () => {
  const ui = editor()
  ui.setServerId('platform-compositions')
  assert.match(ui.text(ui.render()), /已发布组合生成的服务.*已发布工具.*query_asset_related_alerts/)
  assert.equal(ui.input('ID'), undefined)
  ui.setServerId('missing-server')
  assert.equal(ui.input('ID'), undefined)
  ui.setServerId('biz-soc-framework')
  assert.equal(ui.input('ID').props.value, 'biz-soc-framework')
  ui.serviceButton('工具组合编排').props.onClick()
  assert.equal(ui.selections.at(-1), 'platform-compositions')
})

test('深链服务在配置重排或删除后仍绑定原 ID，不显示其他服务详情', () => {
  const ui = editor()
  const other = { ...ui.server, id: 'other-server', serverName: '其他服务' }
  ui.refreshValue({ servers: [ui.server, other], groups: ui.groups, sharedToken: '' }, 'r2')
  ui.setServerId('biz-soc-framework')
  assert.equal(ui.input('ID').props.value, 'biz-soc-framework')
  ui.refreshValue({ servers: [other, ui.server], groups: ui.groups, sharedToken: '' }, 'r3')
  assert.equal(ui.input('ID').props.value, 'biz-soc-framework')
  ui.refreshValue({ servers: [other], groups: ui.groups, sharedToken: '' }, 'r4')
  assert.equal(ui.input('ID'), undefined)
  assert.match(ui.text(ui.render()), /指定服务不存在/)
})

test('深链服务重排后的首帧从 ID 派生详情和编辑对象', () => {
  const ui = editor()
  const other = { ...ui.server, id: 'other-server', serverName: '其他服务' }
  ui.setServerId('biz-soc-framework')
  ui.button('连接配置').props.onClick(); ui.render()
  ui.replaceDraftServersBeforeEffects([other, ui.server])
  assert.equal(ui.input('ID').props.value, 'biz-soc-framework')
  assert.equal(ui.serviceButton('biz-soc-framework').props['aria-current'], 'true')
  ui.input('描述（可选）').props.onChange({ target: { value: '绑定原服务' } })
  ui.render()
  assert.equal(ui.input('描述（可选）').props.value, '绑定原服务')
  ui.replaceDraftServersBeforeEffects([other])
  assert.equal(ui.nodes().find(node => node.type === 'input' && node.props.placeholder === '例如 sec-ops-api'), undefined)
  assert.match(ui.text(ui.nodes()), /指定服务不存在/)
})

test('深链服务改名后可继续编辑，路由随 ID 更新', () => {
  const ui = editor()
  ui.setServerId('biz-soc-framework')
  ui.input('ID').props.onChange({ target: { value: 'renamed-server' } })
  ui.render()
  assert.equal(ui.selections.at(-1), 'renamed-server')
  assert.equal(ui.input('ID').props.value, 'renamed-server')
})

test('主动删除深链服务后改选下一可用服务', () => {
  const ui = editor()
  ui.setServerId('biz-soc-framework')
  ui.button('连接配置').props.onClick(); ui.render()
  ui.button('删除服务器').props.onClick(); ui.render()
  assert.equal(ui.selections.at(-1), 'platform-compositions')
  assert.match(ui.text(ui.render()), /已发布组合生成的服务/)
  assert.equal(ui.serviceButton('工具组合编排').props['aria-current'], 'true')
})

test('配置冲突后复制完整草稿，读取最新内容并保留原草稿供手工重应用', async () => {
  const ui = editor()
  ui.input('描述（可选）').props.onChange({ target: { value: '本地修改' } })
  ui.render()
  ui.refreshValue({ servers: [{ ...ui.server, description: '另一会话的修改' }], groups: ui.groups, sharedToken: '' }, 'r2')
  assert.match(ui.text(ui.render()), /配置版本冲突/)
  assert.equal(ui.button('读取最新配置').props.disabled, true)
  ui.button('复制本地草稿').props.onClick()
  await new Promise(setImmediate)
  ui.render()
  assert.equal(JSON.parse(ui.clipboard.at(-1)).servers[0].description, '本地修改')
  assert.equal(ui.button('读取最新配置').props.disabled, false)
  ui.button('读取最新配置').props.onClick()
  ui.render()
  assert.equal(ui.input('描述（可选）').props.value, '另一会话的修改')
  assert.ok(ui.button('复制保留草稿'))
  ui.button('复制保留草稿').props.onClick()
  await new Promise(setImmediate)
  assert.equal(JSON.parse(ui.clipboard.at(-1)).servers[0].description, '本地修改')
  assert.equal(ui.writes.length, 0)
})
