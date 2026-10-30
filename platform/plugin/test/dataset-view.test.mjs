import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/evaluation/dataset-view.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
const baseQuestion = { type: 'choice', instructions: '选择基本查询', criteria: { read: '读取基本状态', ask: '补充测试标识' } }
const target = label => ({ label, provenance: { kind: 'model_suggestion', model: 'test-model' }, basis: '待核对的建议', status: 'suggested', decision_time_reviewed: false })
const record = (id, instruction) => ({ state: { request: '查询基础测试资产' }, workflow: '安全事件处置', task: { id: '资产查询', semantics: 'recommended_decision' }, questions: { action: { ...baseQuestion, instructions: instruction }, needs_review: { type: 'noul', instructions: '是否需要人工复核？' } }, targets: { action: target('read'), needs_review: target(true) }, _meta: { id, source_group_id: 'fixed-task-basic', group_id: 'task-basic', split: 'unassigned', cutoff: { line: 141, session_log: 'session.v4.jsonl' }, trace_path: 'evidence/C-1/trace.jsonl', observed_action: { name: 'get_inspection_result' } } })
// 夹具返回服务端 DTO；页面应消费 counts/reasons，不根据本地字段重算资格。
const eligibility = dataset => {
  const counts = { candidates: dataset.records.length, training: 0, development: 0, calibration: 0, test: 0 }
  if (dataset.schema_version === 2) for (const item of dataset.records) {
    const mode = item._meta.split === 'train' ? 'training' : item._meta.split
    if (Object.hasOwn(counts, mode) && mode !== 'candidates' && Object.values(item.targets).some(value => value.status === 'reviewed')) counts[mode]++
  }
  return { counts, records: dataset.records.map(item => ({ record_id: item._meta.id, legacy: dataset.schema_version !== 2, reasons: ['尚需核对来源和明确数据用途'], eligible_questions: [], question_reasons: { action: ['本题尚未合格'] }, export_modes: ['candidates'] })), blocked: [{ record_id: dataset.records[0]._meta.id, reasons: ['固定来源与另一个留出批次关联'] }] }
}
function workbench({ handler } = {}) {
  const states = [], deps = [], cleanups = [], calls = [], downloads = [], blobs = [], dirty = [], confirms = [], answers = [], sources = [], reextractions = []
  let cursor, effects, changed, tree, errorMessage = ''
  const documents = new Map(['dataset-a', 'dataset-b'].map((id, index) => [id, { dataset: { schema_version: 2, id, run_id: 'run-a', records: [record(`${id}-1`, `第一题 ${index}`), record(`${id}-2`, `第二题 ${index}`)], extractor: {}, skipped: [] }, sha256: `${id}-v1` }]))
  const listeners = new Set(), updates = { subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback) }, getSnapshot: () => ({ domains: ['agents'] }) }
  const react = { ...require('react'),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], next => { const value = typeof next === 'function' ? next(states[index]) : next; if (!Object.is(value, states[index])) { states[index] = value; changed = true } }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect(effect, dependencies) { const index = cursor++; if (!deps[index] || dependencies.some((value, at) => value !== deps[index][at])) { deps[index] = dependencies; effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() }) } },
  }
  const window = { confirm: text => { confirms.push(text); return answers.shift() ?? true }, document: { createElement: () => { const link = { click: () => downloads.push({ href: link.href, filename: link.download }) }; return link } } }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: () => null } : require(name), window, Blob, URL: { createObjectURL: blob => { blobs.push(blob); return `blob:${blobs.length}` }, revokeObjectURL() {} }, setTimeout: callback => { callback(); return 1 } })
  const result = value => ({ ...structuredClone(value), eligibility: eligibility(value.dataset) })
  const original = async (action, input) => {
    if (action === 'list') return { datasets: [...documents.values()].map(value => ({ id: value.dataset.id, created_at: '2026-10-16', count: value.dataset.records.length, reviewed: 0 })) }
    if (action === 'read') return result(documents.get(input.dataset_id))
    if (action === 'update') {
      if (errorMessage) throw new Error(errorMessage)
      const value = documents.get(input.dataset_id), item = value.dataset.records.find(entry => entry._meta.id === input.record_id)
      assert.equal(input.expected_sha256, value.sha256)
      item.workflow = input.workflow; item.task = structuredClone(input.task); item.questions = structuredClone(input.questions); item.targets = structuredClone(input.targets)
      item._meta = { ...item._meta, group_id: input.group_id, split: input.split }; value.sha256 += '-next'; return result(value)
    }
    if (action === 'export') return { filename: `${input.dataset_id}-${input.kind}.jsonl`, count: input.kind === 'candidates' ? 2 : 1, question_count: input.kind === 'candidates' ? 4 : 1, omitted_question_count: input.kind === 'candidates' ? 0 : 3, content: `${JSON.stringify({ kind: input.kind, saved: true })}\n` }
    throw new Error(`unknown ${action}`)
  }
  const props = { runId: 'run-a', active: true, updates, onDirty: value => dirty.push(value), onSource: source => sources.push(source), onReextract: () => reextractions.push(true), rpc: { call: async (_channel, endpoint, input) => {
    const action = endpoint.replace('agents/datasets/', ''); calls.push({ action, input })
    try { return { ok: true, value: await (handler ? handler(action, input, original) : original(action, input)) } } catch (error) { const [code, ...message] = error.message.split(': '); return { ok: false, error: { code, message: message.join(': ') } } }
  } } }
  function render() { let turns = 0; do { if (++turns > 60) throw new Error('render did not settle'); cursor = 0; effects = []; changed = false; tree = module.exports.DecisionDatasetView(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 7; index++) { render(); await new Promise(resolve => setImmediate(resolve)) }; return render() }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.map(item => text(item)).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
  const byLabel = label => nodes().find(node => node.props?.['aria-label'] === label), button = title => nodes().find(node => node.type === 'button' && text(node) === title), download = title => nodes().find(node => node.type === 'button' && text(node).startsWith(`下载${title} JSONL`))
  function change(label, value) { byLabel(label).props.onChange({ target: { value } }); render() }
  function check(index = 1, value = true) { byLabel(`已核对第 ${index} 题输入与监督目标`).props.onChange({ target: { checked: value } }); render() }
  function review(index = 1) { check(index); button(`确认第 ${index} 题已复核`).props.onClick(); render() }
  async function save() { button('保存本条修改与复核').props.onClick(); await settle() }
  render()
  return { settle, render, nodes, text, byLabel, button, download, change, check, review, save, calls, downloads, blobs, dirty, confirms, answers, documents, sources, reextractions, notify() { [...listeners].forEach(listener => listener()) }, setError(value) { errorMessage = value }, setRun(value) { props.runId = value; render() }, setActive(value) { props.active = value; render() }, cleanup() { cleanups.forEach(cleanup => cleanup?.()) } }
}
async function open(ui, id = 'dataset-a') { await ui.settle(); ui.change('样本批次', id); await ui.settle() }

test('AI 委托复核显示真实身份，不替用户勾选人工声明，改用途保留AI记录', async () => {
  const ui = workbench()
  try {
    const review = { kind: 'ai_delegated', session_id: 'synthetic-review-session', model: { provider: 'fixture', model: 'reviewer', reasoningEffort: null }, reviewed_at: '2026-10-29T00:00:00.000Z', purpose: 'functional_validation' }
    const item = ui.documents.get('dataset-a').dataset.records[0].targets.action
    Object.assign(item, { status: 'reviewed', decision_time_reviewed: true, reviewed_at: review.reviewed_at, review, provenance: { kind: 'ai_annotation' } })
    await open(ui)
    assert.match(ui.text(), /AI 委托复核.*功能验证/)
    assert.match(ui.text(), /待补齐输入复核/); assert.match(ui.text(), /0 \/ 2 题已复核/); assert.match(ui.text(), /尚缺完整输入的阅读证据/)
    assert.match(ui.text(), /fixture\/reviewer/); assert.match(ui.text(), /synthetic-review-session/)
    assert.equal(ui.byLabel('已核对第 1 题输入与监督目标').props.checked, false)
    assert.equal(ui.button('确认第 1 题已复核').props.disabled, true)
    ui.change('决策数据用途', 'train'); await ui.save()
    const split = ui.calls.filter(call => call.action === 'update').at(-1).input
    assert.deepEqual(JSON.parse(JSON.stringify(split.targets.action.review)), review)
    assert.equal(split.targets.action.decision_time_reviewed, true)
    ui.review(); await ui.save()
    assert.equal(ui.calls.filter(call => call.action === 'update').at(-1).input.targets.action.review, null)
  } finally { ui.cleanup() }
})

test('多命名题分离输入与目标，显示业务语义、实际动作、逐题来源和服务端限制', async () => {
  const ui = workbench()
  try {
    await open(ui); assert.equal(ui.byLabel('决策业务流程').props.value, '安全事件处置'); assert.equal(ui.byLabel('第 1 题名称').props.value, 'action'); assert.equal(ui.byLabel('第 2 题名称').props.value, 'needs_review')
    assert.equal(ui.byLabel('第 2 题题型').props.value, 'noul'); assert.equal(ui.byLabel('第 2 题标签 JSON').props.value, 'true')
    assert.match(ui.text(), /实际动作只供对照.*model_suggestion/s); assert.match(ui.text(ui.byLabel('样本决策时点')), /第 141 行.*session.v4.jsonl.*get_inspection_result/s)
    assert.match(ui.text(), /固定来源与另一个留出批次关联/); assert.match(ui.text(ui.byLabel('第 1 题导出限制')), /本题尚未合格/)
    ui.change('决策监督语义', 'observed_action'); assert.match(ui.text(), /不能因此认定该行为正确或最佳/)
  } finally { ui.cleanup() }
})

test('样本来源显示固定历史版本与Run，dirty记录不展示成当前父版', async () => {
  const ui = workbench()
  try {
    const value = ui.documents.get('dataset-a')
    value.dataset.agent_id = 'security-operations-expert'
    value.dataset.experiment_id = 'EXP-security-operations-expert-024-rad80a907c628'
    value.dataset.run_id = 'run-e6ffe4c8-932b-4b6a-b9fb-1f802f536408'
    value.dataset.records[0]._meta = { ...value.dataset.records[0]._meta, ...Object.fromEntries(['agent_id', 'experiment_id', 'run_id'].map(key => [key, value.dataset[key]])), source_version: { git_version: { dirty: true } } }
    await open(ui)
    const text = ui.text(ui.byLabel('样本决策时点'))
    assert.match(text, /EXP-security-operations-expert-024-rad80a907c628/)
    assert.match(text, /run-e6ffe4c8-932b-4b6a-b9fb-1f802f536408/)
    assert.match(text, /历史 Run 使用了未提交的 Candidate/)
  } finally { ui.cleanup() }
})

test('保存冲突保留逐题标签、依据、分组与用途草稿', async () => {
  const ui = workbench()
  try {
    await open(ui); ui.change('第 1 题标签 JSON', '"ask"'); ui.change('第 1 题标签依据', '需要保留的人工依据'); ui.change('决策任务分组', 'task-revised'); ui.change('决策数据用途', 'development'); ui.setError('conflict: 样本已被其他任务修改'); await ui.save()
    assert.match(ui.text(), /草稿已保留/); assert.equal(ui.byLabel('第 1 题标签依据').props.value, '需要保留的人工依据'); assert.equal(ui.byLabel('决策任务分组').props.value, 'task-revised'); assert.equal(ui.byLabel('第 1 题标签 JSON').props.value, '"ask"'); assert.equal(ui.dirty.at(-1), true)
    assert.equal(ui.calls.find(item => item.action === 'update').input.expected_sha256, 'dataset-a-v1'); assert.equal(ui.documents.get('dataset-a').dataset.records[0].targets.action.status, 'suggested')
  } finally { ui.cleanup() }
})

test('逐题复核需要保存，未分配不启用训练，导出仅含合格题目', async () => {
  const ui = workbench()
  try {
    await open(ui); assert.equal(ui.download('已复核训练').props.disabled, true); ui.review(); assert.equal(ui.calls.some(item => item.action === 'update'), false); await ui.save(); assert.equal(ui.download('已复核训练').props.disabled, true)
    ui.change('决策数据用途', 'train'); await ui.save()
    const records = ui.documents.get('dataset-a').dataset.records; assert.equal(records[0].targets.action.status, 'reviewed'); assert.equal(records[0].targets.needs_review.status, 'suggested'); assert.equal(records[1].targets.action.status, 'suggested'); assert.equal(ui.download('已复核训练').props.disabled, false)
    ui.download('候选').props.onClick(); await ui.settle(); ui.download('已复核训练').props.onClick(); await ui.settle()
    assert.deepEqual(ui.calls.filter(item => item.action === 'export').map(item => item.input.kind), ['candidates', 'training']); assert.deepEqual(ui.downloads.map(item => item.filename), ['dataset-a-candidates.jsonl', 'dataset-a-training.jsonl']); assert.match(ui.text(), /含 1 题；3 题不满足该用途，未导出/)
  } finally { ui.cleanup() }
})

test('修改题目规则标签概率依据需先保存再复核，只撤销受影响题目', async () => {
  const ui = workbench()
  try {
    await open(ui); ui.review(1); ui.review(2); await ui.save()
    for (const [label, value] of [['第 1 题问题', '下一步选择哪种查询？'], ['第 1 题规则 JSON', '{"read":"查询资产","ask":"补充资料"}'], ['第 1 题标签 JSON', '"ask"'], ['第 1 题概率 JSON', '{"read":0.2,"ask":0.8}'], ['第 1 题标签依据', '新增可核对依据']]) {
      ui.change(label, value); assert.equal(ui.byLabel('已核对第 1 题输入与监督目标').props.checked, false); assert.equal(ui.byLabel('已核对第 1 题输入与监督目标').props.disabled, true); assert.equal(ui.byLabel('已核对第 2 题输入与监督目标').props.checked, true); assert.match(ui.text(), /请先保存修改，再核对并复核本题/)
      await ui.save(); assert.equal(ui.byLabel('已核对第 1 题输入与监督目标').props.disabled, false); ui.review(); await ui.save()
    }
    const update = ui.calls.filter(item => item.action === 'update').at(-1).input; assert.deepEqual(JSON.parse(JSON.stringify(update.targets.action.probabilities)), { read: 0.2, ask: 0.8 }); assert.equal(update.targets.action.status, 'reviewed'); assert.equal(update.targets.needs_review.status, 'reviewed')
    ui.change('决策业务任务', '新的业务任务'); assert.equal(ui.byLabel('已核对第 2 题输入与监督目标').props.checked, false)
  } finally { ui.cleanup() }
})

test('可选概率不补onehot，支持新增score命名题并保存、移除', async () => {
  const ui = workbench()
  try {
    await open(ui); assert.equal(ui.byLabel('第 1 题概率 JSON').props.value, ''); ui.button('添加命名决策题').props.onClick(); ui.render()
    ui.change('第 3 题名称', 'severity'); ui.change('第 3 题题型', 'score'); ui.change('第 3 题问题', '材料支持哪个风险等级？'); ui.change('第 3 题规则 JSON', '["低","中","高"]'); ui.change('第 3 题标签 JSON', '1'); ui.change('第 3 题标签依据', '材料支持中等风险'); await ui.save()
    const input = ui.calls.filter(item => item.action === 'update').at(-1).input; assert.equal(Object.hasOwn(input.targets.action, 'probabilities'), false); assert.equal(input.questions.severity.type, 'score'); assert.equal(input.targets.severity.label, 1); assert.equal(Object.hasOwn(input.questions.action, 'label'), false)
    ui.button('移除第 3 题').props.onClick(); ui.render(); await ui.save(); assert.equal(ui.byLabel('第 3 题名称'), undefined)
  } finally { ui.cleanup() }
})

test('非法JSON不发送更新，服务端分组跨用途错误显示且保留草稿', async () => {
  const ui = workbench()
  try {
    await open(ui); ui.change('第 1 题规则 JSON', '{broken'); await ui.save(); assert.match(ui.text(), /草稿已保留/); assert.equal(ui.calls.filter(item => item.action === 'update').length, 0)
    assert.match(ui.text(ui.nodes().find(node => node.props?.className === 'harness-dataset-savebar')), /第 1 题的候选或等级规则不是有效 JSON.*草稿已保留/s)
    assert.equal(ui.nodes().filter(node => node.props?.role === 'alert').length, 1)
    ui.change('第 1 题规则 JSON', JSON.stringify(baseQuestion.criteria)); ui.change('决策数据用途', 'test'); ui.setError('invalid_dataset: 同源任务不能跨训练、开发、校准与测试用途'); await ui.save(); assert.match(ui.text(), /同源任务不能跨/); assert.equal(ui.byLabel('决策数据用途').props.value, 'test')
  } finally { ui.cleanup() }
})

test('拒绝切换保留草稿，迟到旧批次响应不覆盖新批次', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve })
  const ui = workbench({ handler: async (action, input, original) => { if (action === 'read' && input.dataset_id === 'dataset-a') await waiting; return original(action, input) } })
  try {
    await ui.settle(); ui.change('样本批次', 'dataset-a'); await ui.settle(); ui.change('样本批次', 'dataset-b'); await ui.settle(); release(); await ui.settle(); assert.equal(ui.byLabel('样本批次').props.value, 'dataset-b'); assert.equal(ui.byLabel('第 1 题问题').props.value, '第一题 1')
    ui.change('第 1 题标签依据', '保留草稿'); ui.answers.push(false); ui.change('样本批次', 'dataset-a'); await ui.settle(); assert.equal(ui.byLabel('样本批次').props.value, 'dataset-b'); assert.equal(ui.byLabel('第 1 题标签依据').props.value, '保留草稿')
    ui.answers.push(false); ui.nodes().find(node => node.type === 'button' && ui.text(node).includes('第二题 1')).props.onClick(); await ui.settle(); assert.equal(ui.byLabel('第 1 题标签依据').props.value, '保留草稿')
  } finally { ui.cleanup() }
})

test('切换Run后的迟到导出不污染当前消息', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve })
  const ui = workbench({ handler: async (action, input, original) => { if (action === 'export') await waiting; return original(action, input) } })
  try { await open(ui); ui.download('候选').props.onClick(); await ui.settle(); ui.setRun('run-b'); await ui.settle(); release(); await ui.settle(); assert.equal(ui.byLabel('样本批次').props.value, ''); assert.ok(!ui.text().includes('已下载 2 条候选样本')) } finally { ui.cleanup() }
})

test('刷新更新干净记录，冲突保留草稿，显式重读后使用新摘要', async () => {
  const ui = workbench()
  try {
    await open(ui); const server = ui.documents.get('dataset-a'); server.dataset.records[0].targets.action.basis = '另一窗口的新依据'; server.sha256 = 'dataset-a-v2'; ui.button('刷新样本').props.onClick(); await ui.settle(); assert.equal(ui.byLabel('第 1 题标签依据').props.value, '另一窗口的新依据')
    ui.change('第 1 题标签依据', '未保存草稿'); server.dataset.records[0].targets.action.basis = '另一窗口第二次保存'; server.sha256 = 'dataset-a-v3'; ui.button('刷新样本').props.onClick(); await ui.settle(); assert.equal(ui.byLabel('第 1 题标签依据').props.value, '未保存草稿'); assert.match(ui.text(), /其他窗口修改.*草稿保留/)
    ui.button('重新读取本批次').props.onClick(); await ui.settle(); assert.equal(ui.byLabel('第 1 题标签依据').props.value, '另一窗口第二次保存'); ui.change('第 1 题标签依据', '继续编辑'); await ui.save(); assert.equal(ui.calls.filter(item => item.action === 'update').at(-1).input.expected_sha256, 'dataset-a-v3')
  } finally { ui.cleanup() }
})

test('保存后迟到旧刷新不撤销复核，订阅使用当前摘要', async () => {
  let hold = false, release; const waiting = new Promise(resolve => { release = resolve })
  const ui = workbench({ handler: async (action, input, original) => { if (action === 'read' && hold) { hold = false; const old = await original(action, input); await waiting; return old }; return original(action, input) } })
  try {
    await open(ui); hold = true; ui.button('刷新样本').props.onClick(); await ui.settle(); ui.review(); await ui.save(); release(); await ui.settle(); assert.equal(ui.byLabel('已核对第 1 题输入与监督目标').props.checked, true)
    ui.change('第 1 题标签依据', '基于新摘要编辑'); ui.notify(); await ui.settle(); assert.ok(!ui.text().includes('其他窗口修改')); await ui.save(); assert.equal(ui.calls.filter(item => item.action === 'update').at(-1).input.expected_sha256, 'dataset-a-v1-next')
  } finally { ui.cleanup() }
})

test('各用途资格完全消费服务端结果，来源警示与留出下载可见', async () => {
  const ui = workbench({ handler: async (action, input, original) => { const value = await original(action, input); if (action === 'read') { value.eligibility.counts = { candidates: 2, training: 0, development: 1, calibration: 1, test: 1 }; value.warnings = ['来源身份文件已改变'] }; return value } })
  try {
    const item = ui.documents.get('dataset-a').dataset.records[0]; item._meta.split = 'train'; item.targets.action.status = 'reviewed'; item.targets.action.decision_time_reviewed = true
    await open(ui); assert.equal(ui.download('已复核训练').props.disabled, true); assert.match(ui.text(), /来源身份文件已改变/)
    for (const title of ['已复核开发', '已复核校准', '已复核测试']) { assert.equal(ui.download(title).props.disabled, false); ui.download(title).props.onClick(); await ui.settle() }; assert.deepEqual(ui.calls.filter(item => item.action === 'export').map(item => item.input.kind), ['development', 'calibration', 'test'])
  } finally { ui.cleanup() }
})

test('旧格式只读保留原标签与复核，可下载候选及重新抽取', async () => {
  const ui = workbench()
  try {
    const dataset = ui.documents.get('dataset-a').dataset; delete dataset.schema_version; delete dataset.records[0].targets; dataset.records[0].questions = { decision: { ...baseQuestion, label: 'read', src: 'legacy-source' } }; dataset.records[0]._meta.label_status = 'reviewed'
    await open(ui); assert.match(ui.text(), /旧格式样本，仅供阅读和候选下载/); assert.match(ui.text(), /legacy-source/); assert.equal(ui.byLabel('决策业务流程'), undefined); assert.equal(ui.button('保存本条修改与复核'), undefined); assert.equal(ui.download('已复核训练').props.disabled, true)
    ui.download('候选').props.onClick(); await ui.settle(); ui.button('按当前合同重新抽取').props.onClick(); assert.equal(ui.reextractions.length, 1); assert.equal(ui.calls.some(item => item.action === 'update'), false)
  } finally { ui.cleanup() }
})

test('查看原始轨迹并返回时保留样本选择、标签草稿', async () => {
  const ui = workbench()
  try {
    await open(ui); ui.change('第 1 题标签依据', '来源查看前的草稿'); ui.button('定位原始轨迹（保留草稿）').props.onClick(); assert.deepEqual(JSON.parse(JSON.stringify(ui.sources)), [{ path: 'evidence/C-1/trace.jsonl', line: 141 }])
    ui.setActive(false); await ui.settle(); ui.setActive(true); await ui.settle(); assert.equal(ui.byLabel('第 1 题标签依据').props.value, '来源查看前的草稿'); assert.equal(ui.byLabel('样本批次').props.value, 'dataset-a'); assert.equal(ui.confirms.length, 0); assert.equal(ui.dirty.at(-1), true)
  } finally { ui.cleanup() }
})


test('损坏v2问题或目标保留原始数据与阻塞提示，不补成可编辑监督值', async () => {
  for (const corrupt of [record => { record.targets = null }, record => { record.targets.action = null }, record => { record.questions.action = null }]) {
    const ui = workbench()
    try {
      const record = ui.documents.get('dataset-a').dataset.records[0]; corrupt(record)
      const before = JSON.stringify(record)
      await open(ui)
      assert.match(ui.text(), /本条结构损坏，仅供阅读和候选下载/)
      assert.match(ui.text(), /不会补造缺失的问题或目标/)
      assert.equal(ui.byLabel('第 1 题标签 JSON'), undefined); assert.equal(ui.button('保存本条修改与复核'), undefined)
      assert.equal(ui.download('候选').props.disabled, false)
      assert.equal(JSON.stringify(ui.documents.get('dataset-a').dataset.records[0]), before)
      assert.equal(ui.calls.some(item => item.action === 'update'), false)
    } finally { ui.cleanup() }
  }
})


test('样本阅读按材料、逐题复核、保存组织，高级编辑默认收起且原文在详情中保留', async () => {
  const ui = workbench()
  await ui.settle()
  ui.change('样本批次', 'dataset-a'); await ui.settle()
  const drawer = ui.nodes().find(node => node.type?.name === 'DetailDrawer' && node.props.title === '实际动作与证据定位')
  assert.equal(drawer.props.identity, 'run-a:dataset-a:dataset-a-1')
  assert.equal(drawer.props.active, true)
  const advanced = ui.nodes().filter(node => node.type === 'details' && node.props.className === 'harness-dataset-advanced')
  assert.ok(advanced.length > 0); assert.ok(advanced.every(node => !node.props.open))
  assert.ok(ui.byLabel('决策前输入（各题共享）'))
  assert.match(ui.text(), /查询基础测试资产/)
  const body = ui.text(ui.byLabel('当前决策样本')); assert.ok(body.indexOf('当前可见任务材料') >= 0); assert.ok(body.indexOf('当前可见任务材料') < body.indexOf('逐题复核')); assert.ok(body.indexOf('逐题复核') < body.indexOf('保存与后续用途'))
  assert.equal(ui.calls.find(call => call.action === 'list').input.include_eligibility, false)
  assert.ok(ui.nodes().some(node => node.type?.name === 'DetailDrawer' && node.props.title === '完整原始输入与工具目录'))
  assert.match(ui.text(), /固定来源与另一个留出批次关联/)
})

test('可读答案控件保持choice和noul类型，保存后继续下一条不会串草稿', async () => {
  const ui = workbench()
  try {
    await open(ui)
    ui.change('第 1 题答案', 'ask'); ui.change('第 2 题答案', 'false')
    assert.equal(ui.byLabel('第 1 题标签 JSON').props.value, '"ask"')
    assert.equal(ui.byLabel('第 2 题标签 JSON').props.value, 'false')
    ui.button('保存并查看下一条').props.onClick(); await ui.settle()
    const sent = ui.calls.filter(call => call.action === 'update').at(-1).input
    assert.equal(sent.record_id, 'dataset-a-1'); assert.equal(sent.targets.action.label, 'ask'); assert.equal(sent.targets.needs_review.label, false)
    assert.equal(ui.byLabel('第 1 题问题').props.value, '第二题 0')
    assert.equal(ui.byLabel('第 1 题答案').props.value, 'read')
    assert.equal(ui.dirty.at(-1), false)
  } finally { ui.cleanup() }
})

test('决策上下文保持原角色和顺序，最新用户请求直接可读，其余按需展开', async () => {
  const ui = workbench()
  try {
    const source = ui.documents.get('dataset-a').dataset.records[0]
    source.state = { messages: [{ role: 'system', content: '系统约定' }, { role: 'user', content: '上一轮请求' }, { role: 'tool', content: '工具结果' }, { role: 'user', content: '本轮用户请求' }], available_tools: [] }
    await open(ui)
    const messages = ui.nodes().filter(node => node.type === 'details' && node.props.className === 'harness-dataset-message')
    assert.equal(messages.length, 4)
    assert.equal(messages.filter(node => node.props.open).length, 1)
    assert.match(ui.text(messages.find(node => node.props.open)), /用户角色消息（来源未记录）.*本轮用户请求/s)
    const history = ui.nodes().find(node => node.props?.className === 'harness-dataset-history')
    assert.equal(ui.byLabel('样本决策时点').props.open, undefined)
    assert.match(ui.text(history), /系统约定.*上一轮请求.*工具结果/s)
    assert.deepEqual(source.state.messages.map(message => message.role), ['system', 'user', 'tool', 'user'])
  } finally { ui.cleanup() }
})

test('父委派与运行注入保持来源身份，不把role:user一概称为真人请求', async () => {
  const ui = workbench()
  try {
    const source = ui.documents.get('dataset-a').dataset.records[0]
    source.state = { messages: [
      { role: 'user', source: { kind: 'user' }, content: '真人请求' },
      { role: 'user', source: { kind: 'subagent', senderSessionId: 'synthetic-parent' }, content: '父智能体下发的子任务' },
      { role: 'user', source: { kind: 'context' }, content: '运行状态更新' },
      { role: 'user', source: { kind: 'skill-catalog' }, content: '技能目录更新' },
    ], available_tools: [] }
    await open(ui)
    const messages = ui.nodes().filter(node => node.type === 'details' && node.props.className === 'harness-dataset-message')
    const primary = messages.find(node => node.props.open)
    assert.match(ui.text(primary), /父智能体委派.*父智能体下发的子任务/s)
    assert.doesNotMatch(ui.text(primary), /用户请求/)
    assert.match(ui.text(messages.find(node => ui.text(node).includes('运行状态更新'))), /运行上下文/)
    assert.match(ui.text(messages.find(node => ui.text(node).includes('技能目录更新'))), /技能目录/)
    assert.equal(source.state.messages[1].source.kind, 'subagent')
  } finally { ui.cleanup() }
})

test('仅运行注入可见时仍展示可核对正文，并在正文前说明缺少用户请求', async () => {
  const ui = workbench()
  try {
    const row = ui.documents.get('dataset-a').dataset.records[0]
    row.state = { messages: [{ role: 'user', source: { kind: 'context' }, content: '合成当前待处理任务材料' }], available_tools: [] }
    await open(ui)
    const messages = ui.byLabel('决策前输入（各题共享）')
    assert.match(ui.text(messages), /来源未记录用户请求.*运行上下文.*合成当前待处理任务材料/s)
    const primary = ui.nodes(messages).find(node => node.type === 'details' && node.props.open)
    assert.ok(primary)
    assert.doesNotMatch(ui.text(primary), /用户请求/)
    assert.equal(row.state.messages[0].source.kind, 'context')
  } finally { ui.cleanup() }
})

test('样本批次区分慢读、读取失败、成功空和恢复后的有记录状态', async () => {
  let release, phase = 'pending'
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ handler: async (action, input, original) => {
    if (action === 'list') {
      if (phase === 'pending') await pending
      if (phase === 'failed') throw new Error('read_error: 测试读取中断')
      if (phase === 'empty') return { datasets: [] }
    }
    return original(action, input)
  } })
  try {
    assert.match(ui.text(), /正在读取样本批次/)
    assert.doesNotMatch(ui.text(), /此 Run 尚无样本/)
    phase = 'failed'; release(); await ui.settle()
    assert.match(ui.text(), /样本批次读取失败/)
    assert.doesNotMatch(ui.text(), /此 Run 尚无样本/)
    phase = 'empty'; ui.button('刷新样本').props.onClick(); await ui.settle()
    assert.match(ui.text(), /此 Run 尚无样本/)
    assert.doesNotMatch(ui.text(), /测试读取中断|样本批次读取失败/)
    phase = 'ready'; ui.button('刷新样本').props.onClick(); await ui.settle()
    assert.doesNotMatch(ui.text(), /此 Run 尚无样本|测试读取中断/)
    assert.match(ui.text(), /2026/)
    await open(ui); ui.change('决策业务流程', '保留编辑'); ui.setError('conflict: 并发冲突'); await ui.save()
    assert.match(ui.text(), /并发冲突/)
    ui.button('刷新样本').props.onClick(); await ui.settle()
    assert.match(ui.text(), /并发冲突/, '列表成功不能清除独立的保存冲突')
  } finally { ui.cleanup() }
})

test('所选批次读取失败后刷新恢复同一对象并清除已解决的错误', async () => {
  let failing = true
  const ui = workbench({ handler: async (action, input, original) => {
    if (action === 'read' && failing) throw new Error('read_error: 测试读取中断')
    return original(action, input)
  } })
  try {
    await open(ui)
    assert.match(ui.text(), /测试读取中断/)
    assert.equal(ui.byLabel('样本批次').props.value, 'dataset-a')
    assert.equal(ui.byLabel('当前决策样本'), undefined)
    failing = false; ui.button('刷新样本').props.onClick(); await ui.settle()
    assert.equal(ui.byLabel('样本批次').props.value, 'dataset-a')
    assert.ok(ui.byLabel('当前决策样本'))
    assert.doesNotMatch(ui.text(), /测试读取中断/)
  } finally { ui.cleanup() }
})

test('样本隐藏通知只记脏，恢复与首次慢读取通知单飞合并；失败可再恢复', async () => {
  const waiting = []
  let slow = true, fail = false, concurrent = 0, maximum = 0
  const ui = workbench({ handler(action, input, original) {
    if (action !== 'list') return original(action, input)
    if (fail) throw new Error('unavailable: 样本列表暂不可读')
    if (!slow) return original(action, input)
    concurrent++; maximum = Math.max(maximum, concurrent)
    return new Promise(resolve => waiting.push(async () => { concurrent--; resolve(await original(action, input)) }))
  } })
  try {
    await ui.settle(); assert.equal(concurrent, 1)
    ui.notify(); ui.notify(); ui.notify(); await ui.settle(); assert.equal(concurrent, 1)
    const before = ui.calls.length; slow = false; waiting.splice(0).forEach(release => release()); await ui.settle()
    assert.equal(ui.calls.length, before + 1); assert.equal(maximum, 1)
    ui.setActive(false); ui.notify(); ui.notify(); await ui.settle(); const hidden = ui.calls.length
    ui.notify(); await ui.settle(); assert.equal(ui.calls.length, hidden)
    ui.setActive(true); await ui.settle(); assert.equal(ui.calls.length, hidden + 1)
    fail = true; ui.notify(); await ui.settle(); assert.match(ui.text(), /样本列表暂不可读/)
    fail = false; ui.notify(); await ui.settle(); assert.doesNotMatch(ui.text(), /样本列表暂不可读/)
  } finally { ui.cleanup() }
})
