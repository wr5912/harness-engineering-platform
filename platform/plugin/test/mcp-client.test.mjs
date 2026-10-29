import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

// 运行实际客户端产物，只替换 React 的状态调度和 Portal 容器。
function editor({ fetch = async () => { throw new Error('未预期的 MCP 管理请求') }, clipboardFailure = false } = {}) {
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
    navigator: { clipboard: { writeText: async value => { if (clipboardFailure) throw new Error('denied'); clipboard.push(value) } } },
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
    onOpenView: (view, serverId, groupId) => { props.view = view; props.selectedServerId = serverId; props.selectedGroupId = groupId },
    onSelectServerId: id => { selections.push(id); props.selectedServerId = id },
    onSelectGroupId: id => { props.selectedServerId = undefined; props.selectedGroupId = id },
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
    if (typeof value === 'boolean') return ''
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
    setServerId: value => { props.selectedGroupId = undefined; props.selectedServerId = value; render() },
    setGroupId: value => { props.selectedServerId = undefined; props.selectedGroupId = value; render() },
    replaceDraftServersBeforeEffects: servers => { states[0] = { ...states[0], servers: structuredClone(servers) }; return renderBeforeEffects() } }
}

function serviceSelection(ui, serverId) {
  const root = () => ui.nodes().find(node => node.type === 'details' && node.props['data-server-id'] === serverId)
  const nodes = () => ui.nodes(root())
  const input = () => nodes().find(node => node.type === 'input' && node.props.type === 'search')
  const choices = section => {
    const parent = section ? nodes().find(node => node.type === 'section'
      && ui.nodes(node).some(child => child.type === 'h4' && ui.text(child) === section)) : root()
    if (!parent) return []
    return ui.nodes(parent).filter(node => node.props?.className?.split(' ').includes('mcp-check'))
  }
  return { root, input, choices,
    clear: () => nodes().find(node => node.type === 'button' && node.props['aria-label'] === '清空筛选'),
    query: value => { input().props.onChange({ target: { value } }); ui.render() },
    sectionText: title => ui.text(nodes().find(node => node.type === 'section'
      && ui.nodes(node).some(child => child.type === 'h4' && ui.text(child) === title))),
  }
}

test('自动生成的已发布组合服务不参与原生服务保存校验或持久化', async () => {
  const ui = editor()
  assert.match(ui.text(ui.serviceButton('工具组合编排')), /由已发布组合生成.*目录已发布/)
  assert.doesNotMatch(ui.text(ui.serviceButton('工具组合编排')), /连接已验证/)
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
  assert.equal(statusCards().length, 2)
  assert.equal(ui.button('最近检查'), undefined)
  assert.match(ui.text(ui.render()), /待检查.*待核对.*实际调用和业务结果待验证/)
  ui.button('连接测试').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  ui.render()
  assert.match(ui.text(ui.render()), /连接状态.*规范已读取.*工具发现.*1 个工具.*已发现的工具.*lookup.*读取测试资产/)
  assert.equal(ui.button('最近检查'), undefined)
  assert.match(ui.text(ui.render()), /最近检查/)
  assert.match(ui.text(ui.render()), /实际调用和业务结果待验证/)
  ui.button('连接配置').props.onClick()
  ui.render()
  assert.ok(ui.input('ID'))
})


test('服务描述与名称相同时不重复展示，连接配置仍保留资料维护入口', () => {
  const ui = editor()
  ui.server.description = ui.server.id
  ui.refreshValue()
  const header = ui.nodes().find(node => node.props?.className === 'mcp-card-head' && ui.text(node).includes(ui.server.id))
  assert.equal(ui.text(header).split(ui.server.id).length - 1, 1)
  const selected = ui.serviceButton(ui.server.id)
  assert.equal(ui.nodes(selected).some(node => node.props?.className === 'mcp-service-desc'), false)
  ui.button('连接配置').props.onClick(); ui.render()
  assert.equal(ui.input('描述（可选）').props.value, ui.server.id)
})

test('服务列表区分检查成功、失败和未保存配置', async () => {
  const ui = editor({ fetch: async () => ({ ok: true, json: async () => ({ tools: [{ name: 'lookup' }], resources: { resources: [] } }) }) })
  const badge = (page, name) => page.nodes(page.serviceButton(name)).find(node => node.props?.className === 'mcp-service-badge')
  assert.equal(ui.text(badge(ui, 'biz-soc-framework')), '连接待检查')
  assert.equal(badge(ui, 'biz-soc-framework').props['data-state'], 'neutral')
  assert.doesNotMatch(ui.text(ui.serviceButton('biz-soc-framework')), /连接已验证/)
  ui.setView('connection')
  await ui.button('发现工具与资源').props.onClick()
  ui.setView('servers')
  assert.equal(ui.text(badge(ui, 'biz-soc-framework')), '规范已读取')
  assert.equal(badge(ui, 'biz-soc-framework').props['data-state'], 'verified')
  assert.doesNotMatch(ui.text(ui.serviceButton('biz-soc-framework')), /连接已验证/)
  assert.match(ui.text(ui.render()), /实际调用和业务结果待验证/)
  ui.button('连接配置').props.onClick()
  ui.render()
  const typeField = ui.nodes().find(node => node.type === 'select' && node.props.value === 'openapi')
  assert.ok(typeField)
  typeField.props.onChange({ target: { value: 'mcp' } })
  ui.render()
  assert.equal(ui.text(badge(ui, 'biz-soc-framework')), '修改未保存')
  assert.equal(badge(ui, 'biz-soc-framework').props['data-state'], 'changed')
  assert.doesNotMatch(ui.text(ui.serviceButton('biz-soc-framework')), /规范已读取/)

  const failed = editor({ fetch: async () => ({ ok: false, json: async () => ({ error: '连接超时' }) }) })
  failed.setView('connection')
  await failed.button('发现工具与资源').props.onClick()
  failed.setView('servers')
  assert.equal(failed.text(badge(failed, 'biz-soc-framework')), '检查失败')
  assert.equal(badge(failed, 'biz-soc-framework').props['data-state'], 'failed')
  assert.doesNotMatch(failed.text(failed.serviceButton('biz-soc-framework')), /规范已读取/)

  const disconnected = editor({ fetch: async () => ({ ok: false, json: async () => ({ error: 'Error POSTing to endpoint' }) }) })
  disconnected.button('连接测试').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  disconnected.render()
  assert.match(disconnected.text(disconnected.render()), /连接测试失败.*检查服务地址、网络与凭据后重试/)
  assert.doesNotMatch(disconnected.text(disconnected.render()), /Error POSTing to endpoint/)
})

test('原生 MCP 成功检查后才标记连接已验证，列表身份和选中态保持真实配置', async () => {
  const ui = editor({ fetch: async () => ({ ok: true, json: async () => ({ tools: [{ name: 'save_result' }] }) }) })
  ui.refreshValue({ servers: [{ id: 'mock-threat-report', description: '测试报告保存', url: 'http://127.0.0.1:53001/mcp', enabled: true }], groups: ui.groups, sharedToken: '' })
  const item = () => ui.serviceButton('mock-threat-report')
  assert.match(ui.text(item()), /mock-threat-report.*测试报告保存.*连接待检查/)
  assert.equal(item().props['data-server-id'], 'mock-threat-report')
  assert.equal(item().props['aria-current'], 'true')
  ui.setView('connection')
  await ui.button('发现工具与资源').props.onClick()
  ui.setView('servers')
  assert.match(ui.text(item()), /连接已验证/)
  assert.doesNotMatch(ui.text(item()), /报告文件服务/)
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
  assert.ok(ui.nodes(ui.render()).some(node => node.props?.className === 'mcp-copy-feedback' && ui.text(node) === '已复制。'))
})

test('分组复制失败在按钮旁提供可选取的原链接，切换对象不显示旧反馈', async () => {
  const ui = editor({ clipboardFailure: true })
  ui.refreshValue({ servers: [ui.server], groups: ui.groups, sharedToken: 'fixture-token' })
  ui.setView('groups')
  await ui.button('复制分组链接').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /无法自动复制/)
  assert.equal(ui.nodes().find(node => node.type === 'textarea' && node.props.readOnly)?.props.value,
    'http://127.0.0.1:3090/hep/mcp/groups/research/v2')
  ui.button('＋ 新增分组').props.onClick(); ui.render()
  assert.ok(!ui.nodes().some(node => node.props?.className === 'mcp-copy-feedback'))
})

test('MCP 管理的连接、诊断和来源请求使用当前 DSH 子路径', async () => {
  const actions = []
  const ui = editor({ fetch: async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:3090/hep/api/mcp-manager')
    assert.equal(init.credentials, 'same-origin')
    actions.push(JSON.parse(init.body).action)
    return { ok: true, json: async () => ({ tools: [], resources: { resources: [] }, items: [] }) }
  } })
  ui.button('连接测试').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  ui.setView('connection')
  await ui.button('发现工具与资源').props.onClick()

  delete ui.server.specUrl
  ui.server.managementUrl = 'http://127.0.0.1:18080/api'
  ui.refreshValue()
  ui.setView('connection')
  ui.input('来源名称').props.onChange({ target: { value: 'fixture' } })
  ui.render()
  await ui.button('创建来源').props.onClick()
  assert.deepEqual(actions, ['test', 'test', 'create', 'sources'])
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

test('分组地址与上游发现状态分别显示，来源失败不误报可用', async () => {
  const ui = editor({ fetch: async () => { throw new Error('fixture 上游不可达') } })
  const group = { id: 'selected', members: [{ serverId: ui.server.id, names: ['lookup'] }] }
  ui.refreshValue({ servers: [ui.server], groups: [group], sharedToken: 'fixture-token' }, 'r2')
  ui.setView('groups')
  assert.equal(ui.button('复制分组链接').props.disabled, false)
  assert.match(ui.text(ui.render()), /分组地址已生成.*链接存在只证明访问入口/)
  assert.match(ui.text(ui.render()), /尚未检查当前配置/)
  ui.button('发现工具与资源').props.onClick()
  await new Promise(resolve => setImmediate(resolve)); ui.render()
  assert.match(ui.text(ui.render()), /来源 biz-soc-framework 最近一次发现失败/)
  assert.match(ui.text(ui.render()), /fixture 上游不可达/)
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

test('服务内关键词同时筛选三类项目，勾选状态不影响大小写、中文及字面匹配', async () => {
  let requests = 0
  const ui = editor({ fetch: async () => {
    requests++
    return { ok: true, json: async () => ({
      tools: ['query_Asset', 'inspect_asset', '列出资产', 'other_tool'].map(name => ({ name })),
      resources: { resources: ['soc://asset/selected', 'soc://asset/open', 'soc://资产/1', 'soc://other'].map(uri => ({ uri })) },
      resourceTemplates: { resourceTemplates: ['soc://asset/{id}', 'soc://资产/{id}', 'soc://other/{id}'].map(uriTemplate => ({ uriTemplate })) },
    }) }
  } })
  const group = { id: 'selected', members: [{ serverId: ui.server.id, names: ['query_Asset', 'archived_tool'],
    resourceUris: ['soc://asset/selected'], resourceTemplates: ['soc://asset/{id}'] }] }
  ui.refreshValue({ servers: [ui.server], groups: [group], sharedToken: 'fixture-token' })
  ui.setView('groups')
  const service = serviceSelection(ui, ui.server.id)
  assert.ok(service.input().props['aria-label'].includes(ui.server.id))
  assert.equal(service.input().props.placeholder, '按名称、标识、URI、HTTP 方法或路径筛选')
  assert.equal(service.clear(), undefined)
  ui.button('发现工具与资源').props.onClick()
  await new Promise(resolve => setImmediate(resolve)); ui.render()
  service.query('  AsSeT  ')
  assert.deepEqual(service.choices('工具').map(ui.text), ['query_Asset', 'inspect_asset'])
  assert.deepEqual(service.choices('资源 URI').map(ui.text), ['soc://asset/selected', 'soc://asset/open'])
  assert.deepEqual(service.choices('资源模板').map(ui.text), ['soc://asset/{id}'])
  assert.deepEqual(service.choices('工具').map(node => ui.nodes(node).find(child => child.type === 'input').props.checked), [true, false])
  service.query('资产')
  assert.deepEqual(service.choices().map(ui.text), ['列出资产', 'soc://资产/1', 'soc://资产/{id}'])
  service.query('.*')
  assert.equal(service.choices().length, 0, '关键词中的正则符号只按字面匹配')
  assert.equal((ui.text(service.root()).match(/没有匹配项。/g) ?? []).length, 3)
  service.query('   ')
  assert.equal(service.choices().length, 12)
  assert.equal(requests, 1, '关键词输入不能重新发现上游')
  assert.equal(ui.writes.length, 0, '关键词输入不能自动保存配置')
  assert.doesNotMatch(ui.text(ui.render()), /当前草稿尚未保存；链接仍使用上次保存的配置/)
})

test('筛选不丢失不可见选择，保存只反映勾选操作，内置清空恢复列表与焦点', async () => {
  const ui = editor()
  const member = { serverId: ui.server.id, names: ['match_tool', 'hidden_tool'],
    resourceUris: ['soc://match/1', 'soc://hidden/1'], resourceTemplates: ['soc://match/{id}', 'soc://hidden/{id}'] }
  const group = { id: 'selected', members: [member] }
  ui.refreshValue({ servers: [ui.server], groups: [group], sharedToken: 'fixture-token' })
  ui.setView('groups')
  const service = serviceSelection(ui, ui.server.id)
  service.query('match')
  assert.equal(service.choices().length, 3)
  assert.equal(ui.writes.length, 0)
  assert.doesNotMatch(ui.text(ui.render()), /当前草稿尚未保存；链接仍使用上次保存的配置/)
  const matchedTool = service.choices('工具')[0]
  ui.nodes(matchedTool).find(node => node.type === 'input').props.onChange()
  ui.render()
  await ui.button('保存更改').props.onClick()
  ui.render()
  const saved = ui.writes[0].ops.find(op => op.path[0] === 'groups').value[0].members[0]
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { ...member, names: ['hidden_tool'] })
  assert.equal(service.input().props.value, 'match', '保存不能清除当前筛选条件')
  assert.equal(ui.text(service.clear()), '×')
  assert.equal(service.clear().props.type, 'button')
  let focused = 0
  service.clear().props.onClick({ currentTarget: { previousElementSibling: { focus: () => focused++ } } })
  ui.render()
  assert.equal(focused, 1)
  assert.equal(service.input().props.value, '')
  assert.equal(service.clear(), undefined)
  assert.equal(service.choices().length, 5)
  const restored = service.choices('工具').find(node => ui.text(node).startsWith('hidden_tool'))
  assert.equal(ui.nodes(restored).find(node => node.type === 'input').props.checked, true)
  assert.equal(ui.writes.length, 1, '清空只更新筛选，不额外写入配置')
})

test('服务筛选按 ID 隔离，切换分组和页签及服务重排后保留，重新加载时清空', () => {
  const ui = editor()
  const other = { ...ui.server, id: 'other-server' }
  const groups = ['first-group', 'second-group'].map(id => ({ id, members: [
    { serverId: ui.server.id, names: ['first_tool', 'shared_tool'] },
    { serverId: other.id, names: ['second_tool', 'shared_tool'] },
  ] }))
  const value = { servers: [ui.server, other], groups, sharedToken: 'fixture-token' }
  ui.refreshValue(value, 'r2')
  ui.setView('groups')
  const first = serviceSelection(ui, ui.server.id), second = serviceSelection(ui, other.id)
  first.query('first')
  assert.equal(second.input().props.value, '')
  assert.equal(second.choices().length, 2)
  second.query('second')
  assert.deepEqual(first.choices().map(ui.text), ['first_tool'])
  assert.deepEqual(second.choices().map(ui.text), ['second_tool'])
  ui.setView('connection'); ui.setView('groups')
  ui.serviceButton('second-group').props.onClick(); ui.render()
  assert.equal(first.input().props.value, 'first')
  assert.equal(second.input().props.value, 'second')
  ui.refreshValue({ ...value, servers: [other, ui.server] }, 'r3')
  assert.equal(first.input().props.value, 'first')
  assert.equal(second.input().props.value, 'second')
  assert.deepEqual(first.choices().map(ui.text), ['first_tool'])
  assert.deepEqual(second.choices().map(ui.text), ['second_tool'])
  assert.equal(ui.writes.length, 0)
  const reloaded = editor()
  reloaded.refreshValue(value)
  reloaded.setView('groups')
  assert.equal(serviceSelection(reloaded, ui.server.id).input().props.value, '')
  assert.equal(serviceSelection(reloaded, other.id).input().props.value, '')
})

test('筛选无匹配不混淆未发现或已知空列表，已保存的失效项目仍保持原状态', async () => {
  const ui = editor({ fetch: async () => ({ ok: true, json: async () => ({
    tools: [], resources: { resources: [] }, resourceTemplates: { resourceTemplates: [] },
  }) }) })
  const group = { id: 'selected', members: [{ serverId: ui.server.id, names: ['saved_tool'] }] }
  ui.refreshValue({ servers: [ui.server], groups: [group], sharedToken: 'fixture-token' })
  ui.setView('groups')
  const service = serviceSelection(ui, ui.server.id)
  service.query('unmatched')
  assert.match(service.sectionText('工具'), /没有匹配项。/)
  for (const title of ['资源 URI', '资源模板']) {
    assert.match(service.sectionText(title), /尚未发现，或此服务未提供该列表。/)
    assert.doesNotMatch(service.sectionText(title), /没有匹配项。/)
  }
  ui.button('发现工具与资源').props.onClick()
  await new Promise(resolve => setImmediate(resolve)); ui.render()
  assert.match(service.sectionText('工具'), /没有匹配项。/)
  for (const title of ['资源 URI', '资源模板']) {
    assert.match(service.sectionText(title), /没有可选项目。/)
    assert.doesNotMatch(service.sectionText(title), /没有匹配项。|尚未发现/)
  }
  service.query('saved')
  assert.match(ui.text(service.choices()[0]), /saved_tool（当前未发现）/)
  assert.equal(ui.nodes(service.choices()[0]).find(node => node.type === 'input').props.checked, true)
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


test('分组保留发现元数据，按资源名称、标题与发布工具标识搜索且仍保存 URI', async () => {
  const ui = editor({ fetch: async () => ({ ok: true, json: async () => ({ tools: [],
    resources: { resources: [{ name: 'getAssetList', title: '查询设备目录', uri: 'soc://inventory', groupToolName: 'getAssetList' }] },
    resourceTemplates: { resourceTemplates: [{ name: 'getAsset', title: '查询设备详情', uriTemplate: 'soc://inventory/{id}', groupToolName: 'getAsset' }] },
  }) }) })
  ui.refreshValue({ servers: [ui.server], groups: [{ id: 'named', members: [] }], sharedToken: 'fixture-token' })
  ui.setView('groups')
  ui.button('发现工具与资源').props.onClick()
  await new Promise(resolve => setImmediate(resolve)); ui.render()
  const service = serviceSelection(ui, ui.server.id)
  for (const keyword of ['GETASSETLIST', '查询设备目录', 'soc://inventory', 'mcp__named__getAssetList']) {
    service.query(keyword)
    assert.equal(service.choices('资源 URI').length, 1)
    assert.match(ui.text(service.choices('资源 URI')[0]), /查询设备目录.*getAssetList.*soc:\/\/inventory.*mcp__named__getAssetList/)
  }
  ui.nodes(service.choices('资源 URI')[0]).find(node => node.type === 'input').props.onChange()
  service.query('getAsset')
  assert.equal(service.choices('资源模板').length, 1)
  ui.nodes(service.choices('资源模板')[0]).find(node => node.type === 'input').props.onChange()
  ui.render()
  await ui.button('保存更改').props.onClick()
  const saved = ui.writes.at(-1).ops.find(op => op.path[0] === 'groups').value[0].members[0]
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), { serverId: ui.server.id, names: [], resourceUris: ['soc://inventory'], resourceTemplates: ['soc://inventory/{id}'] })
})

test('分组提示同名来源并展示 DSH 最终名称和原始长度，筛选不改变选择', async () => {
  const groupId = 'long-group-identifier', raw = 'get_a_very_long_emergency_action_result_with_details'
  const finalName = 'mcp__long-group-identifier__get_a_very_long_emergency_a_0123456789ab'
  const ui = editor({ fetch: async () => ({ ok: true, json: async () => ({ tools: [
    { name: 'echo', groupToolName: 'echo' },
    { name: raw, groupToolName: raw, groupPublicNames: { [groupId]: finalName } },
  ], resources: { resources: [{ name: 'echo', uri: 'fixture:/echo' }] }, resourceTemplates: { resourceTemplates: [] } }) }) })
  const server = { ...ui.server }; delete server.specUrl
  ui.refreshValue({ servers: [server], groups: [{ id: groupId,
    members: [{ serverId: server.id, names: ['echo', raw], resourceUris: ['fixture:/echo'], resourceTemplates: [] }] }], sharedToken: 'fixture-token' })
  ui.setView('groups'); ui.button('发现工具与资源').props.onClick()
  await new Promise(setImmediate); ui.render()
  assert.match(ui.text(ui.render()), /以下同名接口不会发布.*echo.*biz-soc-framework\/names\/echo.*biz-soc-framework\/resourceUris/)
  const service = serviceSelection(ui, server.id)
  service.query(finalName)
  assert.equal(service.choices('工具').length, 1)
  assert.ok(ui.text(service.choices('工具')[0]).includes(`DSH：${finalName}`))
  assert.ok(ui.text(service.choices('工具')[0]).includes(`展开前 ${`mcp__${groupId}__${raw}`.length} 字符，由 DSH 缩短`))
  assert.equal(ui.writes.length, 0)
  service.query('echo')
  assert.equal(service.choices().length, 2)
  assert.ok(service.choices().every(choice => ui.nodes(choice).find(node => node.type === 'input').props.checked))
})

test('OpenAPI 同一操作只显示一张卡片，分别保存工具与资源选择，原生 MCP 保持独立', async () => {
  const operation = { method: 'GET', path: '/items/{id}' }
  const fetch = async () => ({ ok: true, json: async () => ({
    tools: [{ name: 'get_item', title: '查询条目', groupToolName: 'get_item', httpOperation: operation },
      { name: 'save_item', httpOperation: { method: 'POST', path: '/items' } }],
    resources: { resources: [{ name: 'list_items', uri: 'fixture:/items', httpOperation: { method: 'GET', path: '/items' } }] },
    resourceTemplates: { resourceTemplates: [{ name: 'get_item', title: '查询条目', uriTemplate: 'fixture:/items/{id}',
      groupToolName: 'get_item', httpOperation: operation }] },
  }) })
  const ui = editor({ fetch })
  ui.refreshValue({ servers: [ui.server], groups: [{ id: 'http', members: [{ serverId: ui.server.id,
    names: ['get_item'], resourceUris: [], resourceTemplates: ['fixture:/items/{id}'] }] }], sharedToken: 'fixture-token' })
  ui.setView('groups'); ui.button('发现工具与资源').props.onClick()
  await new Promise(setImmediate); ui.render()
  const service = serviceSelection(ui, ui.server.id)
  service.query('GET /items/{id}')
  assert.equal(service.choices('工具').length, 1)
  assert.equal(service.choices('资源模板').length, 0)
  assert.equal(service.choices().length, 1)
  const card = () => service.choices()[0]
  assert.match(ui.text(card()), /GET.*\/items\/\{id\}/)
  assert.match(ui.text(card()), /工具调用.*资源模板读取/)
  assert.match(ui.text(card()), /get_item/)
  assert.match(ui.text(card()), /mcp__http__get_item/)
  const toggles = () => ui.nodes(card()).filter(node => node.type === 'input')
  assert.deepEqual(toggles().map(node => node.props.checked), [true, true])
  toggles()[0].props.onChange(); ui.render()
  assert.deepEqual(toggles().map(node => node.props.checked), [false, true])
  assert.match(ui.text(card()), /get_item/)
  await ui.button('保存更改').props.onClick()
  const member = () => JSON.parse(JSON.stringify(ui.writes.at(-1).ops.find(op => op.path[0] === 'groups').value[0].members[0]))
  assert.deepEqual(member(), { serverId: ui.server.id, names: [], resourceUris: [], resourceTemplates: ['fixture:/items/{id}'] })
  toggles()[0].props.onChange(); ui.render()
  toggles()[1].props.onChange(); ui.render()
  assert.deepEqual(toggles().map(node => node.props.checked), [true, false])
  await ui.button('保存更改').props.onClick()
  assert.deepEqual(member(), { serverId: ui.server.id, names: ['get_item'], resourceUris: [], resourceTemplates: [] })
  service.query('get_item')
  assert.equal(service.choices().length, 1, '操作 ID 可搜索到同一接口卡片')
  service.query('GET /items')
  assert.equal(service.choices('资源 URI').length, 1)
  service.query('POST /items')
  assert.equal(service.choices('工具').length, 1)
  assert.equal(service.choices('资源 URI').length, 0)
  const nativeServer = { ...ui.server }; delete nativeServer.specUrl
  const native = editor({ fetch })
  native.refreshValue({ servers: [nativeServer], groups: [{ id: 'http', members: [] }], sharedToken: 'fixture-token' })
  native.setView('groups'); native.button('发现工具与资源').props.onClick()
  await new Promise(setImmediate); native.render()
  const nativeService = serviceSelection(native, nativeServer.id)
  assert.equal(native.nodes().filter(node => node.props?.className === 'mcp-http-operation').length, 0)
  assert.equal(nativeService.choices('工具').length, 2)
  assert.equal(nativeService.choices('资源模板').length, 1)
  assert.equal(native.nodes().filter(node => node.props?.className === 'mcp-check mcp-operation').length, 0)
})

test('分组调试使用已保存目标，切换目标或配置版本后丢弃旧发现和执行回执', async () => {
  const requests = [], pending = []
  const ui = editor({ fetch: async (_url, request) => {
    requests.push(JSON.parse(request.body))
    return new Promise(resolve => pending.push(data => resolve({ ok: true, json: async () => data })))
  } })
  ui.refreshValue({ servers: [ui.server], groups: ui.groups, sharedToken: 'fixture' })
  ui.setView('groups')
  const debug = ui.button('调试分组')
  assert.equal(debug.props.disabled, false)
  debug.props.onClick(); ui.render()
  assert.equal(ui.getView(), 'connection')
  assert.match(ui.text(ui.render()), /mcp\/groups\/research\/v2/)
  const discover = () => ui.button('发现工具与资源')
  const first = discover().props.onClick()
  assert.deepEqual(requests[0], { groupId: 'research', action: 'test' })
  ui.setServerId('biz-soc-framework')
  pending.shift()({ tools: [{ name: 'stale-group' }] }); await first; ui.render()
  assert.doesNotMatch(ui.text(ui.render()), /stale-group/)
  ui.setGroupId('research')
  const second = discover().props.onClick()
  pending.shift()({ tools: [{ name: 'group_tool', inputSchema: { type: 'object', properties: { incidentId: { type: 'string' } } } }], resources: { resources: [{ name: 'resource', uri: 'group:/one' }] }, resourceTemplates: { resourceTemplates: [{ name: 'template', uriTemplate: 'group:/{id}' }] } })
  await second; ui.render()
  assert.match(ui.text(ui.render()), /group_tool.*incidentId/s)
  ui.nodes().find(node => node.type === 'select' && ui.nodes(node).some(child => child.props?.value === 'group_tool')).props.onChange({ target: { value: 'group_tool' } }); ui.render()
  const calling = ui.button('测试工具').props.onClick()
  assert.deepEqual(requests.at(-1), { groupId: 'research', action: 'callTool', toolName: 'group_tool', sourceId: '', arguments: {} })
  ui.refreshValue({ servers: [ui.server], groups: ui.groups, sharedToken: 'fixture' }, 'r2')
  pending.shift()({ content: [{ type: 'text', text: 'stale-receipt' }] }); await calling; ui.render()
  assert.doesNotMatch(ui.text(ui.render()), /stale-receipt|group_tool/)
  ui.setGroupId('removed')
  assert.match(ui.text(ui.render()), /调试目标不存在或尚未保存/)
  assert.equal(discover().props.disabled, true)
})

test('统一调试按对象与工具保留参数，切换类型不串用调用输入', async () => {
  const requests = []
  const ui = editor({ fetch: async (_url, request) => {
    const payload = JSON.parse(request.body); requests.push(payload)
    return { ok: true, json: async () => payload.action === 'test' ? { tools: [{ name: 'one' }, { name: 'two' }], resourceTemplates: { resourceTemplates: [{ name: 'template', uriTemplate: 'test:/{id}' }] }, resources: { resources: [] } } : { content: [{ type: 'text', text: 'actual-receipt' }] } }
  } })
  ui.setView('connection')
  await ui.button('发现工具与资源').props.onClick(); ui.render()
  const toolSelect = () => ui.nodes().find(node => node.type === 'select' && ui.nodes(node).some(child => child.props?.value === 'two'))
  const args = () => ui.nodes().find(node => node.type === 'textarea' && node.props['aria-label'] === '调用参数 JSON')
  args().props.onChange({ target: { value: '{"name":"first"}' } }); ui.render()
  toolSelect().props.onChange({ target: { value: 'two' } }); ui.render()
  assert.equal(args().props.value, '{}')
  args().props.onChange({ target: { value: '{"name":"second"}' } }); ui.render()
  toolSelect().props.onChange({ target: { value: 'one' } }); ui.render()
  assert.equal(args().props.value, '{"name":"first"}')
  ui.button('资源模板').props.onClick(); ui.render()
  const template = ui.nodes().find(node => node.type === 'select' && ui.nodes(node).some(child => child.props?.value === 'test:/{id}'))
  template.props.onChange({ target: { value: 'test:/{id}' } }); ui.render()
  ui.nodes().find(node => node.type === 'textarea' && node.props['aria-label'] === '模板参数 JSON').props.onChange({ target: { value: '{"id":"resource"}' } }); ui.render()
  ui.button('工具').props.onClick(); ui.render()
  assert.equal(args().props.value, '{"name":"first"}')
  ui.button('测试工具').props.onClick(); await new Promise(setImmediate); ui.render()
  assert.equal(requests.at(-1).toolName, 'one')
  assert.deepEqual(requests.at(-1).arguments, { name: 'first' })
  ui.setGroupId('research'); await ui.button('发现工具与资源').props.onClick(); ui.render()
  args().props.onChange({ target: { value: '{"scope":"group"}' } }); ui.render()
  ui.setServerId('biz-soc-framework'); await ui.button('发现工具与资源').props.onClick(); ui.render()
  assert.equal(args().props.value, '{"name":"first"}')
})

test('旧兼容管理结果随服务或保存版本失效，迟到回执不进入其他服务', async () => {
  let delay = false, finish
  const ui = editor({ fetch: async (_url, request) => {
    const payload = JSON.parse(request.body)
    if (delay) return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ receipt: 'late-from-a' }) }) })
    return { ok: true, json: async () => ({ receipt: `legacy-${payload.serverId}` }) }
  } })
  const servers = [{ ...ui.server, managementUrl: 'http://127.0.0.1:18080/legacy-a' },
    { ...ui.server, id: 'legacy-b', managementUrl: 'http://127.0.0.1:18080/legacy-b' }]
  ui.refreshValue({ servers, groups: ui.groups, sharedToken: 'fixture' })
  ui.setServerId(ui.server.id); ui.setView('connection')
  await ui.button('读取来源').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /legacy-biz-soc-framework/)
  ui.setServerId('legacy-b')
  assert.doesNotMatch(ui.text(ui.render()), /legacy-biz-soc-framework/)
  await ui.button('读取来源').props.onClick(); ui.render()
  assert.match(ui.text(ui.render()), /legacy-legacy-b/)
  ui.refreshValue({ servers, groups: ui.groups, sharedToken: 'fixture' }, 'r2')
  assert.doesNotMatch(ui.text(ui.render()), /legacy-legacy-b/)
  ui.setServerId(ui.server.id); delay = true
  const pending = ui.button('读取来源').props.onClick()
  ui.setServerId('legacy-b')
  finish(); await pending; ui.render()
  assert.doesNotMatch(ui.text(ui.render()), /late-from-a/)
})

test('能力切换保留原调用身份，迟到成功只回到提交工具且不覆盖正在查看的工具', async () => {
  const pending = new Map()
  const ui = editor({ fetch: async (_url, request) => {
    const payload = JSON.parse(request.body)
    if (payload.action === 'test') return { ok: true, json: async () => ({ tools: [{ name: 'one' }, { name: 'two' }] }) }
    return new Promise(resolve => pending.set(payload.toolName, () => resolve({ ok: true, json: async () => ({ receipt: `completed-${payload.toolName}` }) })))
  } })
  ui.setView('connection'); await ui.button('发现工具与资源').props.onClick(); ui.render()
  const select = () => ui.nodes().find(node => node.type === 'select' && ui.nodes(node).some(child => child.props?.value === 'two'))
  ui.button('测试工具').props.onClick(); ui.render()
  select().props.onChange({ target: { value: 'two' } }); ui.render()
  assert.equal(ui.button('测试工具').props.disabled, false)
  ui.button('测试工具').props.onClick(); ui.render()
  pending.get('one')(); await new Promise(setImmediate); ui.render()
  assert.doesNotMatch(ui.text(ui.render()), /completed-one/)
  assert.equal(ui.button('测试工具').props.disabled, true, 'one 完成不应解除 two 的忙状态')
  select().props.onChange({ target: { value: 'one' } }); ui.render()
  assert.match(ui.text(ui.render()), /completed-one/)
  pending.get('two')(); await new Promise(setImmediate); ui.render()
  assert.doesNotMatch(ui.text(ui.render()), /completed-two/)
  select().props.onChange({ target: { value: 'two' } }); ui.render()
  assert.match(ui.text(ui.render()), /completed-two/)
  assert.equal(ui.button('测试工具').props.disabled, false)
})

test('连接工具范围从目录选择，筛选不改选择且连续勾选不丢目录', async () => {
  let calls = 0
  const ui = editor({ fetch: async () => { calls++; return { ok: true, json: async () => ({ tools: [{ name: 'one', description: '读取事件' }, { name: 'two', description: '更新事件' }] }) } } })
  delete ui.server.specUrl
  ui.server.url = 'http://127.0.0.1:18080/mcp'
  ui.server.headers = []
  ui.server.tools = { mode: 'selected', names: ['legacy'] }
  ui.refreshValue()
  ui.button('连接测试').props.onClick(); await new Promise(setImmediate); ui.render()
  ui.button('连接配置').props.onClick(); ui.render()
  const scope = () => ui.nodes().find(node => node.props?.['data-tool-scope'] === true)
  const choices = () => ui.nodes(scope()).filter(node => node.props?.className === 'mcp-check')
  const choose = (name, checked) => { const choice = choices().find(node => ui.text(node).startsWith(name)); ui.nodes(choice).find(node => node.type === 'input').props.onChange({ target: { checked } }); ui.render() }
  assert.equal(ui.input('工具原名（逗号分隔）'), undefined)
  assert.equal(choices().length, 3)
  assert.match(ui.text(scope()), /legacy（尚未核对）/)
  choose('one', true); choose('two', true)
  assert.equal(choices().length, 3)
  assert.equal(ui.nodes(scope()).filter(node => node.type === 'input' && node.props.checked).length, 3)
  const search = ui.nodes(scope()).find(node => node.props?.type === 'search')
  search.props.onChange({ target: { value: '读取' } }); ui.render()
  assert.equal(choices().length, 1)
  assert.equal(ui.nodes(choices()[0]).find(node => node.type === 'input').props.checked, true)
  search.props.onChange({ target: { value: '' } }); ui.render()
  assert.equal(choices().length, 3)
  assert.equal(ui.nodes(scope()).filter(node => node.type === 'input' && node.props.checked).length, 3)
  assert.equal(calls, 1, '选择与筛选不重新发现或执行工具')
  assert.equal(ui.writes.length, 0)
  ui.input('MCP URL').props.onChange({ target: { value: 'http://127.0.0.1:19090/mcp' } }); ui.render()
  assert.match(ui.text(scope()), /请保存连接配置/)
  assert.equal(choices().length, 3, '连接变化仍保留已有勾选，但不沿用旧目录')
  assert.ok(choices().every(node => ui.text(node).includes('尚未核对')))
})
