import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = (await build({ entryPoints: [new URL('../src/mcp/client.tsx', import.meta.url).pathname], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', 'harness-mcp-manager-client', '@deepseek-ai/dsh-client-ui-primitives'] })).outputFiles[0].text
const oldId = 'a'.repeat(64), currentId = 'b'.repeat(64)
const oldConfig = { toolName: 'find_asset', title: '旧发布标题', description: '旧版说明', connectionId: 'source-one' }
const currentConfig = { ...oldConfig, title: '当前发布标题', description: '当前说明' }

function workbench(initialTarget = { page: 'mcp', tab: 'composition', composition_id: 'composition-one', version: 'published', version_id: oldId }, { execute, action, readCatalog, extraCompositions = [] } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], navigations = [], copied = []
  let cursor, effects, changed, tree, listener
  let catalog = { revision: 'r1', connections: [{ kind: 'openapi', id: 'source-one' }], extension: null,
    compositions: [{ id: 'composition-one', published: { ...currentConfig, publishedAt: '2026-10-20T00:00:00Z' }, publishedVersionId: currentId,
      versions: [{ versionId: oldId, config: oldConfig, publishedAt: '2026-10-19T00:00:00Z' }, { versionId: currentId, config: currentConfig, publishedAt: '2026-10-20T00:00:00Z' }],
      graphs: { published: { nodes: [], edges: [] } } }, ...extraCompositions] }
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial
      return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) {
      dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(`${compiled}\nmodule.exports.CompositionPage = CompositionPage;`, {
    module, exports: module.exports, URL, structuredClone, requestAnimationFrame: callback => callback(),
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: element => element }
      : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Tooltip: props => props.children } : name === 'harness-mcp-manager-client' ? { Manager: () => null } : require(name),
    window: { addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { async writeText(value) { copied.push(value) } } },
    document: { baseURI: 'http://localhost:3090/hep/' },
  })
  const props = { target: initialTarget, active: true, configuration: { status: 'ready' }, onCatalogChange() {}, onContext() {},
    onNavigate(value) { navigations.push(value); props.target = value; changed = true },
    updates: { subscribe(value) { listener = value; return () => { listener = undefined } }, getSnapshot: () => ({ domains: ['mcp'] }), invalidate() {} },
    rpc: { async call(_channel, endpoint, payload) {
      calls.push({ endpoint, payload })
      if (endpoint === 'mcp/list') return readCatalog ? readCatalog(catalog) : { ok: true, value: structuredClone(catalog) }
      if (action && ['mcp/dryRunComposition', 'mcp/publishComposition', 'mcp/executeComposition'].includes(endpoint)) return action(endpoint, payload)
      if (endpoint === 'mcp/saveCompositionDraft') {
        if (payload.revision !== catalog.revision) return { ok: false, error: { message: '编排目录已变化，请刷新后重试' } }
        catalog = { ...catalog, revision: 'r3', compositions: catalog.compositions.map(entry => entry.id === payload.compositionId ? { ...entry, draft: payload.draft } : entry) }
        return { ok: true, value: structuredClone(catalog) }
      }
      if (endpoint === 'mcp/executeComposition' && execute) return execute(payload)
      throw new Error(`未处理的 RPC ${endpoint}`)
    } },
  }
  function render() { let count = 0; do { if (++count > 30) throw new Error('渲染未收敛'); cursor = 0; effects = []; changed = false; tree = module.exports.CompositionPage(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 5; index++) { render(); await new Promise(setImmediate) }; render() }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []
    return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(item => text(item)).join(''); return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
  const button = label => nodes().find(node => node.type === 'button' && text(node) === label)
  render()
  return { render, settle, nodes, text, button, calls, navigations, copied,
    setActive(value) { props.active = value; render() }, setTarget(value) { props.target = value; render() }, externalUpdate(value) { catalog = value; listener?.(); render() } }
}

test('组合深链恢复冻结发布版本，失效版本不回退到当前发布', async () => {
  const ui = workbench()
  await ui.settle()
  assert.match(ui.text(), /旧发布标题/)
  assert.match(ui.text(), /历史发布版本，只读查看/)
  assert.equal(ui.button('测试（dry）'), undefined)
  assert.ok(ui.button('查看配置'))
  assert.equal(ui.nodes().some(node => node.type === 'summary' && ui.text(node) === '冻结版本配置'), false)
  ui.setTarget({ page: 'mcp', tab: 'composition', composition_id: 'composition-one', version: 'published', version_id: currentId })
  await ui.settle()
  assert.match(ui.text(), /当前发布标题/)
  assert.ok(ui.button('测试（dry）'))
  ui.setTarget({ page: 'mcp', tab: 'composition', composition_id: 'composition-one', version: 'published', version_id: 'c'.repeat(64) })
  await ui.settle()
  assert.match(ui.text(), /已不存在，请重新选择/)
  assert.equal(ui.button('测试（dry）'), undefined)
  assert.equal(ui.calls.some(call => call.endpoint !== 'mcp/list'), false)
})

test('组合目录冲突后保留草稿，读取最新并手工重应用再保存', async () => {
  const ui = workbench({ page: 'mcp', tab: 'composition', composition_id: 'composition-one', version: 'published', version_id: currentId })
  await ui.settle()
  ui.button('解锁编辑').props.onClick(); ui.render()
  const title = () => ui.nodes().find(node => node.type === 'input' && node.props.value?.includes('标题'))
  title().props.onChange({ target: { value: '我的草稿标题' } }); ui.render()
  const latest = { revision: 'r2', connections: [{ kind: 'openapi', id: 'source-one' }], extension: null,
    compositions: [{ id: 'composition-one', draft: { ...currentConfig, title: '另一会话标题' }, published: currentConfig,
      publishedVersionId: currentId, versions: [{ versionId: oldId, config: oldConfig }, { versionId: currentId, config: currentConfig }], graphs: { draft: { nodes: [], edges: [] }, published: { nodes: [], edges: [] } } }] }
  ui.externalUpdate(latest); await ui.settle()
  assert.match(ui.text(), /编排目录版本冲突/)
  ui.button('复制本地草稿').props.onClick(); await new Promise(setImmediate)
  assert.equal(JSON.parse(ui.copied.at(-1)).title, '我的草稿标题')
  ui.button('以最新版本继续编辑').props.onClick(); ui.render()
  assert.equal(title().props.value, '另一会话标题')
  title().props.onChange({ target: { value: '手工合并后的标题' } }); ui.render()
  ui.nodes().find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await ui.settle()
  const save = ui.calls.find(call => call.endpoint === 'mcp/saveCompositionDraft')
  assert.equal(save.payload.revision, 'r2')
  assert.equal(save.payload.draft.title, '手工合并后的标题')
  assert.match(ui.text(), /手工合并后的标题/)
})

test('执行 A 时路由切换到 B，旧回执不会显示在 B 或解除 B 的忙碌状态', async () => {
  const versionB = 'd'.repeat(64)
  const target = id => ({ page: 'mcp', tab: 'composition', composition_id: id, version: 'published', version_id: id === 'composition-one' ? currentId : versionB })
  const pending = new Map()
  const ui = workbench(target('composition-one'), {
    extraCompositions: [{ id: 'composition-two', published: { ...currentConfig, title: '组合 B' }, publishedVersionId: versionB,
      versions: [{ versionId: versionB, config: { ...currentConfig, title: '组合 B' } }], graphs: { published: { nodes: [], edges: [] } } }],
    execute: payload => new Promise(resolve => pending.set(payload.compositionId, resolve)),
  })
  await ui.settle()
  const assetInput = () => ui.nodes().find(node => node.props?.['aria-label'] === '组合查询资产')
  assetInput().props.onChange({ target: { value: 'asset-a' } }); ui.render()
  ui.button('实际执行组合工具').props.onClick(); ui.render()
  assert.ok(pending.has('composition-one'))
  ui.setTarget(target('composition-two')); await ui.settle()
  assert.match(ui.text(), /组合 B/)
  assert.doesNotMatch(ui.text(), /正在处理…/)
  assetInput().props.onChange({ target: { value: 'asset-b' } }); ui.render()
  ui.button('实际执行组合工具').props.onClick(); ui.render()
  assert.ok(pending.has('composition-two'))
  pending.get('composition-one')({ ok: true, value: { mode: 'live', ok: true, result: { asset: { id: 'A-marker' }, trace: [] } } })
  await ui.settle()
  assert.match(ui.text(), /正在处理…/)
  assert.doesNotMatch(ui.text(), /A-marker|组合执行成功/)
  pending.get('composition-two')({ ok: true, value: { mode: 'live', ok: true, result: { asset: { id: 'B-marker' }, trace: [] } } })
  await ui.settle()
  assert.match(ui.text(), /B-marker/)
  assert.doesNotMatch(ui.text(), /A-marker/)
})

test('发布说明使用可聚焦图标，移除常驻面板并保留测试操作', async () => {
  const ui = workbench({ page: 'mcp', tab: 'composition', composition_id: 'composition-one', version: 'published', version_id: currentId }); await ui.settle()
  const icon = ui.nodes().find(node => node.type === 'button' && node.props?.['aria-label'] === '调用与发布说明')
  assert.equal(icon.props.type, 'button')
  const tooltip = ui.nodes().find(node => node.props?.openOnClick && node.props?.label?.includes('仅列出并执行已发布版本'))
  assert.ok(tooltip.props.portal)
  assert.equal(ui.nodes().some(node => node.props?.className === 'harness-composition-publish'), false)
  assert.ok(ui.button('测试（dry）'))
})

test('编排首次读取不冒充空目录，刷新已有内容只在标题显示轻量状态', async () => {
  const ui = workbench()
  const loading = () => ui.nodes().filter(node => node.type?.name === 'LoadingIndicator')
  assert.equal(loading().length, 1)
  assert.equal(loading()[0].props.label, '读取编排目录')
  assert.doesNotMatch(ui.text(), /正在读取|暂无编排/)
  await ui.settle()
  assert.match(ui.text(), /旧发布标题/)
  ui.button('刷新').props.onClick(); ui.render()
  assert.match(ui.text(), /旧发布标题/)
  assert.equal(loading().length, 1)
  assert.equal(loading()[0].props.label, '刷新编排目录')
  assert.doesNotMatch(ui.text(), /正在处理|正在读取/)
  await ui.settle()
  assert.equal(loading().length, 0)
  assert.match(ui.text(), /旧发布标题/)
})

for (const [endpoint, button] of [['dryRunComposition', '测试（dry）'], ['publishComposition', '发布工具'], ['executeComposition', '实际执行组合工具']]) {
  test(`组合 ${endpoint} 在途固定提交输入，完成后改输入清除回执`, async () => {
    let release, sent
    const draft = { id: 'composition-draft', draft: currentConfig, graphs: { draft: { nodes: [], edges: [] } } }
    const ui = workbench({ page: 'mcp', tab: 'composition', composition_id: draft.id, version: 'draft' }, { extraCompositions: [draft], action: (_endpoint, payload) => {
      sent = payload
      return new Promise(resolve => { release = resolve })
    } })
    await ui.settle()
    const input = () => ui.nodes().find(node => node.props?.['aria-label'] === '组合查询资产')
    input().props.onChange({ target: { value: 'asset-A' } }); ui.render()
    ui.button(button).props.onClick(); ui.render()
    assert.equal(sent.input.asset, 'asset-A')
    assert.equal(input().props.disabled, true)
    input().props.onChange({ target: { value: 'asset-B' } }); ui.render()
    assert.equal(input().props.value, 'asset-A')
    // 发布回执需包含真实目录 DTO；此处只核对冻结输入，不模拟成功发布。
    release({ ok: false, error: { message: 'fixture：执行已结束' } }); await ui.settle()
    assert.equal(input().props.disabled, false)
    input().props.onChange({ target: { value: 'asset-B' } }); ui.render()
    assert.equal(input().props.value, 'asset-B')
    assert.doesNotMatch(ui.text(), /组合执行成功/)
  })
}

test('组合隐藏通知不读取，恢复补一批，在途多次更新只顺序补一批', async () => {
  let block = false, release, concurrent = 0, maxConcurrent = 0, reads = 0
  const ui = workbench(undefined, { readCatalog: async catalog => {
    reads++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent)
    if (block) await new Promise(resolve => { release = resolve })
    concurrent--; return { ok: true, value: structuredClone(catalog) }
  } })
  await ui.settle(); const initial = reads
  ui.setActive(false)
  for (let count = 0; count < 3; count++) ui.externalUpdate({ revision: 'r2', compositions: [], connections: [] })
  await ui.settle(); assert.equal(reads, initial)
  block = true; ui.setActive(true); await ui.settle(); assert.equal(reads, initial + 1)
  for (let count = 0; count < 3; count++) ui.externalUpdate({ revision: 'r3', compositions: [], connections: [] })
  await ui.settle(); assert.equal(reads, initial + 1)
  block = false; release(); await ui.settle()
  assert.equal(reads, initial + 2)
  assert.equal(maxConcurrent, 1)
})

test('阶段组合按已有运行恢复时，在途运行ID同样不可更换', async () => {
  let release, sent
  const stage = { id: 'stage-infer', draft: { ...currentConfig, kind: 'threat-stage', stage: 'infer', bindings: { socConnectionId: 'source-one', reportConnectionId: 'source-one' } }, graphs: { draft: { nodes: [], edges: [] } } }
  const ui = workbench({ page: 'mcp', tab: 'composition', composition_id: stage.id, version: 'draft' }, { extraCompositions: [stage], action: (_endpoint, payload) => {
    sent = payload; return new Promise(resolve => { release = resolve })
  } })
  await ui.settle()
  const input = () => ui.nodes().find(node => node.props?.['aria-label'] === '组合运行 ID')
  input().props.onChange({ target: { value: 'run-A' } }); ui.render()
  ui.button('测试（dry）').props.onClick(); ui.render()
  assert.equal(sent.input.run_id, 'run-A')
  assert.equal(input().props.disabled, true)
  input().props.onChange({ target: { value: 'run-B' } }); ui.render()
  assert.equal(input().props.value, 'run-A')
  release({ ok: false, error: { message: 'fixture：阶段校验结束' } }); await ui.settle()
  assert.equal(input().props.disabled, false)
})
