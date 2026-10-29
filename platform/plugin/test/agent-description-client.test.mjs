import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/agents/description-client.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', 'react-dom'] })
const source = compiled.outputFiles[0].text
const plainModule = { exports: {} }
vm.runInNewContext(source, { module: plainModule, exports: plainModule.exports, require })
const { replaceDescriptionField } = plainModule.exports

test('表单只替换目标 YAML 字段，保留其他属性、注释及换行', () => {
  const harness = '# 版本资料\nagent:\n  id: inspection\n  name: 旧名称\n  owner: personal # 保留\nloadable_assets:\n  workspace: dsh/workspace\n'
  assert.equal(replaceDescriptionField(harness, 'name', '新名称', 'agent'), harness.replace('name: 旧名称', 'name: "新名称"'))
  const preset = 'description: |\n  旧简介\n  第二行\n\nmodel: existing # 保留\n'
  assert.equal(replaceDescriptionField(preset, 'description', '新简介\n新第二行'), 'description: "新简介\\n新第二行"\n\nmodel: existing # 保留\n')
  assert.throws(() => replaceDescriptionField('agent: {name: old, id: inspection}\n', 'name', 'new', 'agent'), /资产编辑器/)
})

function mount({ failApply = false, delay, readOnly = () => false } = {}) {
  const states = [], dependencies = [], cleanups = [], calls = [], dirty = [], listeners = new Map()
  const base = 'evolution/experiments/EXP-inspection-002/candidate'
  const files = new Map([
    [base + '/harness.yaml', '# 保留\nagent:\n  id: inspection\n  name: 第二版本\nloadable_assets:\n  preset_root: custom/presets\n  preset_id: inspection-v2\n  workspace: custom/workspace\n'],
    [base + '/custom/presets/inspection-v2/preset.yml', 'description: 第二版本简介\nmodel: original\n'],
    [base + '/custom/workspace/.agents/skills/inspect/SKILL.md', '---\nname: inspect\ndescription: 原技能说明\nowner: 保留\n---\n# 技能正文\n保持原文。\n'],
  ])
  let cursor = 0, effects = [], changed = false, tree, confirm = false
  const modalEvents = []
  const modal = { open: false, showModal() { this.open = true; modalEvents.push('show') }, close() { this.open = false; modalEvents.push('close') } }
  const react = { ...require('react'),
    useState(initial) { const at = cursor++; if (!(at in states)) states[at] = typeof initial === 'function' ? initial() : initial; return [states[at], value => { const next = typeof value === 'function' ? value(states[at]) : value; if (!Object.is(next, states[at])) { states[at] = next; changed = true } }] },
    useRef(initial) { const at = cursor++; if (!(at in states)) states[at] = { current: initial }; return states[at] },
    useEffect(effect, deps) { const at = cursor++; if (!dependencies[at] || deps.some((value, index) => !Object.is(value, dependencies[at][index]))) { dependencies[at] = deps; effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === 'react' ? react : require(name), URL, document: { activeElement: { focus() {} } }, window: { location: { hostname: 'preview.example' }, confirm: () => confirm, addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) } })
  const props = { agentId: 'inspection', detail: { experiment: { id: 'EXP-inspection-002' }, candidate_sha256: 'digest-v2', editable_files: [...files.keys()], features: [] }, onSaved() {}, onEditAsset() {}, onDirtyChange: value => dirty.push(value),
    rpc: { call: async (_channel, endpoint, body) => {
      calls.push({ endpoint, body })
      if (delay) await delay(endpoint, body)
      if (endpoint === 'instances/list') return { ok: true, value: { instances: [{ name: 'selected-version', state: 'running', source_id: 'experiment:EXP-inspection-002' }, { name: 'other-version', state: 'running', source_id: 'experiment:EXP-inspection-001' }] } }
      if (endpoint === 'instances/url') return { ok: true, value: { url: 'http://127.0.0.1:18501/assistant/', lan_access: true } }
      if (endpoint === 'agents/edit/read') return { ok: true, value: { path: body.path, kind: 'text', sha256: 'original-digest', content: files.get(body.path), ...(readOnly(body.path) ? { editable: false, reason: '内容已脱敏，仅提供只读预览。' } : {}) } }
      if (endpoint === 'agents/edit/preview') return { ok: true, value: { edits: body.edits.map(edit => ({ ...edit, diff: '真实差异预览' })), dry_run: {} } }
      if (endpoint === 'agents/edit/apply') {
        if (failApply) return { ok: false, error: { message: '文件摘要发生冲突' } }
        for (const edit of body.edits) files.set(edit.path, edit.content)
        return { ok: true, value: { written: body.edits, dry_run: {} } }
      }
      throw new Error('unexpected ' + endpoint)
    } },
  }
  function render() { let attempts = 0; do { if (++attempts > 30) throw new Error('render loop'); cursor = 0; effects = []; changed = false; tree = module.exports.AgentDescriptionPanel(props); const dialog = nodes(tree).find(node => node.type === 'dialog'); if (dialog?.ref) dialog.ref.current = modal; effects.forEach(effect => effect()) } while (changed); return tree }
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children)]
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
  async function settle() { for (let i = 0; i < 8; i++) { render(); await new Promise(resolve => setImmediate(resolve)) } render() }
  const button = label => nodes(tree).find(node => node.type === 'button' && text(node) === label)
  const fields = () => nodes(tree).filter(node => ['input', 'textarea'].includes(node.type))
  render()
  return { settle, render, button, fields, calls, dirty, listeners, files, modal, modalEvents, text: () => text(tree), nodes: () => nodes(tree), setConfirm(value) { confirm = value }, cleanup() { cleanups.forEach(fn => fn?.()) }, props, base }
}

test('描述读取选中版本自定义资产路径，已有字段经预览保存回同一文件', async () => {
  const ui = mount()
  try {
    await ui.settle()
    assert.match(ui.text(), /第二版本简介/)
    assert.equal(ui.calls.some(call => call.endpoint === 'agents/description'), false)
    assert.ok(ui.calls.every(call => call.body.experiment_id === 'EXP-inspection-002'))
    ui.button('编辑资料').props.onClick(); ui.render()
    ui.fields()[0].props.onChange({ target: { value: '表单新名称' } }); ui.render()
    ui.fields()[1].props.onChange({ target: { value: '表单新简介' } }); ui.render()
    assert.equal(ui.dirty.at(-1), true)
    assert.ok(ui.listeners.has('beforeunload'))
    assert.equal(ui.button('保存修改').props.disabled, true)
    ui.button('校验与预览').props.onClick(); await ui.settle()
    assert.equal(ui.button('保存修改').props.disabled, false)
    ui.button('保存修改').props.onClick(); await ui.settle()
    const saved = ui.calls.find(call => call.endpoint === 'agents/edit/apply').body
    assert.equal(saved.experiment_id, 'EXP-inspection-002')
    assert.equal(saved.edits.length, 2)
    assert.ok(saved.edits.every(edit => edit.expected_sha256 === 'original-digest'))
    assert.match(ui.files.get(ui.base + '/harness.yaml'), /# 保留\nagent:\n  id: inspection\n  name: "表单新名称"/)
    assert.match(ui.files.get(ui.base + '/custom/presets/inspection-v2/preset.yml'), /description: "表单新简介"\nmodel: original/)
    assert.equal(ui.dirty.at(-1), false)
  } finally { ui.cleanup() }
})

test('描述和技能表单沿用资产只读决定，可编辑字段仍能单独保存', async () => {
  const ui = mount({ readOnly: path => path.endsWith('/harness.yaml') || path.endsWith('/SKILL.md') })
  try {
    await ui.settle()
    assert.match(ui.text(), /内容已脱敏，仅提供只读预览/)
    assert.equal(ui.button('编辑').props.disabled, true)
    ui.button('查看').props.onClick(); ui.render()
    assert.match(ui.text(), /技能正文/)
    ui.button('关闭').props.onClick(); ui.render()
    ui.button('编辑资料').props.onClick(); ui.render()
    assert.equal(ui.fields()[0].props.disabled, true)
    assert.equal(ui.fields()[1].props.disabled, false)
    ui.fields()[1].props.onChange({ target: { value: '可独立更新的简介' } }); ui.render()
    ui.button('校验与预览').props.onClick(); await ui.settle()
    ui.button('保存修改').props.onClick(); await ui.settle()
    const saved = ui.calls.find(call => call.endpoint === 'agents/edit/apply').body.edits
    assert.equal(saved.length, 1)
    assert.ok(saved[0].path.endsWith('/preset.yml'))
    assert.equal(ui.calls.some(call => ['agents/edit/preview', 'agents/edit/apply'].includes(call.endpoint) && call.body.edits.some(edit => /harness.yaml|SKILL.md/.test(edit.path))), false)
  } finally { ui.cleanup() }
  const readonly = mount({ readOnly: () => true })
  try {
    await readonly.settle()
    assert.equal(readonly.button('编辑资料').props.disabled, true)
    assert.equal(readonly.button('编辑').props.disabled, true)
    assert.equal(readonly.calls.some(call => ['agents/edit/preview', 'agents/edit/apply'].includes(call.endpoint)), false)
  } finally { readonly.cleanup() }
})

test('技能表单保存保留无关元数据与正文，冲突后保留输入和关闭保护', async () => {
  const ui = mount({ failApply: true })
  try {
    await ui.settle()
    ui.button('编辑').props.onClick(); ui.render()
    ui.fields()[1].props.onChange({ target: { value: '更新技能说明' } }); ui.render()
    ui.button('校验与预览').props.onClick(); await ui.settle()
    const preview = ui.calls.find(call => call.endpoint === 'agents/edit/preview').body.edits[0]
    assert.match(preview.content, /description: "更新技能说明"\nowner: 保留\n---\n# 技能正文\n保持原文。\n$/)
    ui.button('保存修改').props.onClick(); await ui.settle()
    assert.match(ui.text(), /文件摘要发生冲突.*草稿已保留/)
    assert.equal(ui.fields()[1].props.value, '更新技能说明')
    ui.button('取消').props.onClick(); ui.render()
    assert.equal(ui.fields()[1].props.value, '更新技能说明')
    assert.equal(ui.calls.filter(call => call.endpoint === 'agents/edit/apply').length, 1)
    ui.setConfirm(true); ui.button('取消').props.onClick(); ui.render()
    assert.equal(ui.fields().length, 0)
    assert.equal(ui.dirty.at(-1), false)
    assert.equal(ui.nodes().some(node => node.type === 'button' && /删除/.test(String(node.props.children))), false)
  } finally { ui.cleanup() }
})

test('编辑期间资产摘要变化保留草稿并阻止旧预览保存', async () => {
  const ui = mount()
  try {
    await ui.settle()
    ui.button('编辑资料').props.onClick(); ui.render()
    ui.fields()[0].props.onChange({ target: { value: '本地草稿' } }); ui.render()
    ui.button('校验与预览').props.onClick(); await ui.settle()
    const reads = ui.calls.filter(call => call.endpoint === 'agents/edit/read').length
    ui.props.detail = { ...ui.props.detail, candidate_sha256: 'other-writer-digest' }
    ui.render(); await ui.settle()
    assert.equal(ui.fields()[0].props.value, '本地草稿')
    assert.equal(ui.button('保存修改').props.disabled, true)
    assert.equal(ui.calls.filter(call => call.endpoint === 'agents/edit/read').length, reads)
    assert.match(ui.text(), /保存依据已变化，草稿仍保留/)
    assert.equal(ui.calls.some(call => call.endpoint === 'agents/edit/apply'), false)
    ui.setConfirm(true); ui.button('取消').props.onClick(); await ui.settle()
    assert.ok(ui.calls.filter(call => call.endpoint === 'agents/edit/read').length > reads)
  } finally { ui.cleanup() }
})


test('新增技能只创建选中工作区的新文件，预览和保存携带不存在校验', async () => {
  const ui = mount()
  try {
    await ui.settle()
    ui.button('新增技能').props.onClick(); ui.render()
    ui.fields()[0].props.onChange({ target: { value: '../outside' } }); ui.render()
    ui.fields()[2].props.onChange({ target: { value: '新技能说明' } }); ui.render()
    ui.fields()[3].props.onChange({ target: { value: '# 新技能\n读取真实输入。\n' } }); ui.render()
    ui.button('校验与预览').props.onClick(); await ui.settle()
    assert.match(ui.text(), /小写 kebab-case/)
    assert.equal(ui.calls.some(call => call.endpoint === 'agents/edit/preview'), false)
    ui.fields()[0].props.onChange({ target: { value: 'new-inspection' } }); ui.render()
    ui.button('校验与预览').props.onClick(); await ui.settle()
    const edit = ui.calls.find(call => call.endpoint === 'agents/edit/preview').body.edits[0]
    assert.equal(edit.path, ui.base + '/custom/workspace/.agents/skills/new-inspection/SKILL.md')
    assert.equal(edit.expected_sha256, null)
    assert.match(edit.content, /name: "new-inspection"\ndescription: "新技能说明"\n---\n# 新技能/)
    ui.button('保存修改').props.onClick(); await ui.settle()
    assert.equal(ui.files.get(edit.path), edit.content)
  } finally { ui.cleanup() }
})

test('资料预览只关联同版本实例，接入地址只读取得且缺少标准字段不冒充完整导出', async () => {
  const ui = mount()
  try {
    await ui.settle()
    ui.button('预览与导出').props.onClick(); await ui.settle()
    assert.equal(ui.calls.filter(call => call.endpoint === 'instances/url').length, 1)
    assert.equal(ui.calls.find(call => call.endpoint === 'instances/url').body.name, 'selected-version')
    const choice = ui.nodes().find(node => typeof node.type === 'function' && node.props?.label === '预览接入实例')
    assert.equal(choice.props.options.some(option => option.value === 'other-version'), false)
    assert.match(ui.text(), /http:\/\/preview.example:18501\/assistant\//)
    assert.equal(ui.button('下载标准描述（未接入）').props.disabled, true)
    assert.equal(ui.button('下载版本资料 JSON').props.disabled, undefined)
    assert.equal(ui.calls.some(call => /save|apply/.test(call.endpoint)), false)
  } finally { ui.cleanup() }
})


test('切到其他页面关闭原生 modal 并保留草稿，回到描述页重新打开', async () => {
  const ui = mount()
  try {
    await ui.settle()
    ui.button('编辑资料').props.onClick(); ui.render()
    ui.fields()[0].props.onChange({ target: { value: '跨页保留的草稿' } }); ui.render()
    assert.equal(ui.modal.open, true)
    ui.props.active = false; ui.render()
    assert.equal(ui.modal.open, false)
    assert.equal(ui.fields()[0].props.value, '跨页保留的草稿')
    ui.props.active = true; ui.render()
    assert.equal(ui.modal.open, true)
    assert.equal(ui.fields()[0].props.value, '跨页保留的草稿')
    assert.deepEqual(ui.modalEvents, ['show', 'close', 'show'])
    assert.equal(ui.calls.some(call => call.endpoint === 'agents/edit/apply'), false)
  } finally { ui.cleanup() }
})


test('关联实例与接入地址分阶段提供轻量读取反馈，失败恢复提示仍可见', async () => {
  let releaseList, failUrl
  const list = new Promise(resolve => { releaseList = resolve })
  const url = new Promise((_, reject) => { failUrl = reject })
  const ui = mount({ delay(endpoint) { if (endpoint === 'instances/list') return list; if (endpoint === 'instances/url') return url } })
  try {
    await ui.settle()
    ui.button('预览与导出').props.onClick(); await ui.settle()
    assert.ok(ui.nodes().some(node => node.type?.name === 'LoadingIndicator' && node.props.label === '读取版本关联实例'))
    assert.doesNotMatch(ui.text(), /正在读取/)
    releaseList(); await ui.settle()
    assert.ok(ui.nodes().some(node => node.type?.name === 'LoadingIndicator' && node.props.label === '读取所选实例接入信息'))
    failUrl(new Error('实例地址暂不可读')); await ui.settle()
    assert.equal(ui.nodes().some(node => node.type?.name === 'LoadingIndicator'), false)
    assert.match(ui.text(), /接入信息暂不可用：请到实例管理核对状态/)
    assert.equal(ui.calls.some(call => /save|apply|create/.test(call.endpoint)), false)
  } finally { ui.cleanup() }
})
