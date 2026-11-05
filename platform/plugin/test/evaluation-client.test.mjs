import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/evaluation/client.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
const runA = 'run-11111111-1111-4111-8111-111111111111'
const runB = 'run-22222222-2222-4222-8222-222222222222'
const expA = 'EXP-alpha-001'
const reviewContract = { schema_version: 1, effect_scope: 'business-evidence', source_scope: 'frozen-harness', model_route: { provider: 'mimo', model: 'MiMoFlash', reasoningEffort: 'off' }, model_policy_sha256: 'a'.repeat(64), model_policy_snapshot: { path: 'evidence/analysis/model-policy.json', sha256: 'b'.repeat(64) } }
const doc = { case: { id: 'C-1', title: '测试一', inputs: ['第一轮'], expected_behavior: '正确回答', scene: '场景一', tier: 'fast' }, sha256: 'case-v1', path: 'agents/alpha/evaluation.md' }
const detail = { experiment: { id: expA }, versions: [{ id: expA }], evaluation: { path: doc.path, sha256: doc.sha256, cases: [{ id: 'C-1', title: '测试一', scene: '场景一', tier: 'fast', input_preview: '第一轮' }, { id: 'C-2', title: '测试二', scene: '场景二', tier: 'full', input_preview: '第二轮' }] }, decision: { content: '# Decision\ncontinue', sha256: 'decision-v1' } }
const overview = entries => ({ agents: entries.map(([agentId, experiments]) => ({ agent_id: agentId, experiments })) })
const betaRun = { experiment_id: 'EXP-beta-001', runs: [{ run_id: runB, status: 'completed', created_at: '2026-10-15T09:00:00Z' }] }
const alphaOverview = experiments => overview([['alpha', experiments], ['beta', [betaRun]]])
function workbench({ target, handler, onAssistant, storage = new Map() } = {}) {
  const states = [], dependencies = [], cleanups = []
  let cursor, effects, changed, tree, previewSerial = 0, modalOpen = false, failSave = false, loadedDoc = structuredClone(doc), decisionContent = detail.decision.content
  const calls = [], navigations = [], contexts = [], confirmations = [], assistants = []
  const updateListeners = new Set()
  let updateSnapshot = { domains: [], revision: 0 }
  const updates = { subscribe: listener => { updateListeners.add(listener); return () => updateListeners.delete(listener) }, getSnapshot: () => updateSnapshot, invalidate: domains => { updateSnapshot = { domains, revision: updateSnapshot.revision + 1 }; [...updateListeners].forEach(listener => listener()) } }
  const confirmationAnswers = []
  const react = {
    ...require('react'),
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
      return [states[index], value => { const next = typeof value === 'function' ? value(states[index]) : value; if (!Object.is(next, states[index])) { states[index] = next; changed = true } }]
    },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useMemo(compute, deps) { const index = cursor++; if (!dependencies[index] || deps.some((value, at) => value !== dependencies[index][at])) { states[index] = compute(); dependencies[index] = deps }; return states[index] },
    useEffect(effect, deps) {
      const index = cursor++
      if (!dependencies[index] || deps.some((value, at) => value !== dependencies[index][at])) { dependencies[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() }) }
    },
  }
  const MarkdownText = () => null, MarkdownDelegateProvider = () => null
  const module = { exports: {} }
  const beforeUnload = new Set()
  const timers = new Map()
  let timerId = 0
  const flushTimers = () => { while (timers.size) { const [id, callback] = timers.entries().next().value; timers.delete(id); callback() } }
  const window = { sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, confirm: message => { confirmations.push(message); return confirmationAnswers.shift() ?? true }, addEventListener: (name, listener) => { if (name === 'beforeunload') beforeUnload.add(listener) }, removeEventListener: (name, listener) => beforeUnload.delete(listener), setInterval: () => 1, clearInterval: () => undefined, setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => { timers.delete(id) } }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText, MarkdownDelegateProvider } : require(name), window, crypto: webcrypto, document: { baseURI: 'http://localhost:3090/hep/', getElementById: () => ({ focus() {} }), querySelector: () => modalOpen ? { role: 'dialog' } : null }, URL })
  const { EvaluationPage } = module.exports
  const defaultHandler = async (action, payload) => {
    if (action === 'list') return { root: '/test-assets', agents: [{ id: 'alpha' }, { id: 'beta' }], experiments: [{ id: expA, agent_id: 'alpha', change: {} }] }
    if (action === 'detail') return { ...detail, decision: { ...detail.decision, content: decisionContent } }
    if (action === 'runs/overview') return overview([['alpha', [{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed', created_at: '2026-10-15T08:00:00Z' }] }]], ['beta', [betaRun]]])
    if (action === 'runs/show') return { run_id: payload.run_id, run_path: `evolution/experiments/${expA}/runs/${payload.run_id}`, manifest: { agent_id: 'alpha', experiment_id: expA, status: 'completed' }, summary: { effective_verdict: 'passed' }, source: { executor: 'api' }, cases: [{ case_id: 'C-1', frozen: { inputs: ['原始输入'], expected_behavior: '原始标准' }, trials: [], evidence: [] }], missing: [] }
    if (action === 'runs/report') return { present: true, path: 'report.md', content: '# 测试评估报告\n\n完整报告正文' }
    if (action === 'runs/files') return { sealed: true, files: [{ path: `evolution/experiments/${expA}/runs/${payload.run_id}/evidence/C-1/trace.jsonl`, size: 90000, kind: 'text' }] }
    if (action === 'runs/read-file') return { path: payload.path, content: '预览轨迹', truncated: true }
    if (action === 'cases/read') return structuredClone(loadedDoc)
    if (action === 'cases/update') {
      if (failSave) throw new Error('conflict: 文件已被修改')
      loadedDoc = { ...loadedDoc, sha256: 'case-v2', case: { ...loadedDoc.case, title: payload.title, inputs: [...payload.inputs], expected_behavior: payload.expected_behavior, fast: payload.fast } }
      return structuredClone(loadedDoc)
    }
    if (action === 'eval/preview') return { run_id: ++previewSerial === 1 ? runA : `run-aaaaaaaa-aaaa-4aaa-8aaa-${String(previewSerial).padStart(12, '0')}`, result: { mode: payload.mode, case_ids: payload.cases ?? ['C-1'], executor: payload.executor } }
    if (action === 'eval/list') return { runs: [], errors: [] }
    if (action === 'eval/start') return { run_id: payload.run_id, run_created: true, status: 'running' }
    if (action === 'eval/status') return { run_id: payload.run_id || runA, run_created: true, status: 'completed', result: { run_id: payload.run_id || runA } }
    if (action === 'eval/cancel') return { status: 'cancelled' }
    if (action === 'decision/update') { decisionContent = payload.content; return { sha256: 'decision-v2' } }
    throw new Error(`未处理的 RPC ${action}`)
  }
  const props = { active: true, target, updates, onAssistant: async (task, context) => { assistants.push({ task, context }); await onAssistant?.(task, context) }, onNavigate: value => { navigations.push(value); props.target = value; changed = true }, onContext: value => contexts.push(value), rpc: { call: async (channel, endpoint, payload) => {
    const action = endpoint.replace(/^agents\//, '')
    calls.push({ action, payload })
    try { return { ok: true, value: await (handler ? handler(action, payload, defaultHandler) : defaultHandler(action, payload)) } } catch (error) { const [code, ...message] = error.message.split(': '); return { ok: false, error: { code, message: message.join(': ') } } }
  } } }
  function render() {
    let count = 0
    do { if (++count > 60) throw new Error('渲染未收敛'); cursor = 0; effects = []; changed = false; tree = EvaluationPage(props); effects.forEach(effect => effect()) } while (changed)
    return tree
  }
  async function settle() { for (let index = 0; index < 8; index++) { render(); flushTimers(); await new Promise(resolve => setImmediate(resolve)) }; return render() }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; if (['DistributionChart', 'CaseExpected', 'CaseExpectedPreview', 'RunCase'].includes(value.type?.name)) return [value, ...nodes(value.type(value.props))]; return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; if (typeof value === 'boolean') return ''; if (Array.isArray(value)) return value.map(text).join(''); if (['DistributionChart', 'CaseExpected', 'CaseExpectedPreview', 'RunCase'].includes(value?.type?.name)) return text(value.type(value.props)); return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
  const button = title => nodes().find(node => node.type === 'button' && text(node) === title)
  const idButton = id => nodes().find(node => node.type === 'button' && node.props.title === id)
  const byLabel = title => nodes().find(node => node.props?.['aria-label'] === title || node.props?.label === title)
  function change(title, value) { const element = byLabel(title); assert.ok(element, `缺少控件 ${title}`); element.props.onChange(element.props.label ? value : { target: { value, checked: value } }); render() }
  render()
  return { rpc: props.rpc, render, settle, nodes, text, button, idButton, byLabel, jobStatus: () => text(nodes().find(node => node.props?.className === 'harness-eval-job-title')?.props.children?.[1]), change, invalidate: updates.invalidate, calls, navigations, contexts, assistants, MarkdownText, beforeUnload, confirmations, confirmationAnswers, setFailSave: value => { failSave = value }, setTarget(value) { props.target = value; render() }, setModalOpen(value) { modalOpen = value }, setActive(value) { props.active = value; render() }, getTarget() { return props.target }, cleanup() { cleanups.forEach(cleanup => cleanup?.()); timers.clear() } }
}

test('当前用例和编辑预览保留同一 Markdown，保存重开不丢多轮输入与注释', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA, case_id: 'C-1' } })
  const expected = '主要检查点：\n\n1. **查询对象**，给出可观察结果。\n2. 保持顺序。\n\n> 注：缺少证据时说明限制。'
  try {
    await ui.settle(); ui.button('编辑用例').props.onClick(); await ui.settle()
    ui.change('用例预期行为', expected)
    ui.button('＋ 添加一轮输入').props.onClick(); await ui.settle(); ui.change('第 2 轮输入', '继续核对')
    assert.ok(ui.nodes().some(node => node.type === ui.MarkdownText && node.props.text === expected))
    ui.button('保存用例').props.onClick(); await ui.settle()
    assert.ok(ui.nodes().some(node => node.type === ui.MarkdownText && node.props.text === expected))
    ui.button('编辑用例').props.onClick(); await ui.settle()
    assert.equal(ui.byLabel('用例预期行为').props.value, expected)
    assert.equal(ui.byLabel('第 2 轮输入').props.value, '继续核对')
  } finally { ui.cleanup() }
})

test('Run 仅渲染自己冻结的预期，缺失冻结口径时不回填当前用例', async () => {
  for (const frozen of [{ inputs: ['冻结输入'], expected_behavior: '1. **历史口径**\n\n> 注：按当时约束核对。' }, undefined]) {
    const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA, case_id: 'C-1' }, handler: async (action, payload, original) => {
      if (action === 'runs/show') return { run_id: runA, manifest: { agent_id: 'alpha', experiment_id: expA, status: 'completed' }, summary: {}, cases: [{ case_id: 'C-1', frozen, contract_changed: true, output: ['实际回答'], trials: [] }] }
      return original(action, payload)
    } })
    try {
      await ui.settle()
      const markdown = ui.nodes().filter(node => node.type === ui.MarkdownText).map(node => node.props.text)
      if (frozen) assert.ok(markdown.includes(frozen.expected_behavior))
      else assert.match(ui.text(), /历史 Run 未冻结用例定义/)
      assert.ok(!markdown.includes(doc.case.expected_behavior))
    } finally { ui.cleanup() }
  }
})

test('用例读取失败显示可重试状态，重试后恢复当前口径', async () => {
  let fail = true
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA, case_id: 'C-1' }, handler: async (action, payload, original) => {
    if (action === 'cases/read' && fail) throw new Error('network: 连接暂时中断')
    return original(action, payload)
  } })
  try {
    await ui.settle(); assert.match(ui.text(), /读取用例失败/)
    fail = false; ui.button('重试读取用例').props.onClick(); await ui.settle()
    assert.ok(ui.nodes().some(node => node.type === ui.MarkdownText && node.props.text === doc.case.expected_behavior))
  } finally { ui.cleanup() }
})

test('评测中心默认汇总全部智能体 Run，点击即读取报告并保留挂载前缀下载', async () => {
  const ui = workbench()
  await ui.settle()
  assert.equal(ui.calls.filter(call => call.action === 'runs/overview').length, 1, '汇总读取一次覆盖全部 Agent')
  assert.equal(ui.calls.some(call => call.action === 'detail'), false)
  assert.equal(ui.byLabel('评测工作区').props.children.find(node => node.props.id === 'evaluation-tab-runs').props['aria-selected'], true)
  const records = () => ui.nodes().find(node => node.type === 'section' && node.props.className?.includes('harness-eval-record-list'))
  assert.equal(records()?.props['data-expanded'], false)
  ui.button('展开列表').props.onClick(); ui.render()
  assert.equal(records()?.props['data-expanded'], true)
  ui.button('收起列表').props.onClick(); ui.render()
  assert.equal(records()?.props['data-expanded'], false)
  ui.idButton(runA).props.onClick({ stopPropagation() {} })
  await ui.settle()
  assert.ok(ui.nodes().some(node => node.type === ui.MarkdownText && node.props.text.includes('完整报告正文')))
  const archive = ui.nodes().find(node => node.type === 'a' && ui.text(node) === '下载完整 Run ZIP')
  assert.equal(new URL(archive.props.href).pathname, '/hep/api/harness-platform/runs/download')
  assert.equal(new URL(archive.props.href).searchParams.get('kind'), 'archive')
  assert.equal(ui.navigations.at(-1).run_id, runA)
  ui.cleanup()
})

test('无深链时先显示统一记录，用户选择后才读取结果', async () => {
  const ui = workbench({ target: { page: 'evaluation' }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') return overview([['alpha', [{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed', created_at: '2026-10-15T08:00:00Z' }] }]], ['beta', [betaRun]]])
    return original(action, payload)
  } })
  try {
    await ui.settle()
    assert.equal(ui.getTarget().run_id, undefined)
    assert.equal(ui.calls.some(call => call.action === 'runs/show'), false)
    assert.ok(ui.idButton(runB))
    ui.idButton(runB).props.onClick({ stopPropagation() {} }); await ui.settle()
    assert.equal(ui.getTarget().run_id, runB)
    assert.equal(ui.calls.filter(call => call.action === 'runs/show').at(-1)?.payload.run_id, runB)
  } finally { ui.cleanup() }
})

test('控制清单或运行索引不可读时只保留真实Run，不伪造启动记录', async () => {
  for (const failure of ['eval/list', 'runs/overview']) {
    const ui = workbench({ handler(action, payload, fallback) {
      if (action === failure) throw new Error('read_failed: 运行观察不可读')
      if (action === 'eval/list') return { runs: [], errors: [] }
      return fallback(action, payload)
    } })
    try {
      await ui.settle()
      assert.match(ui.text(), /运行观察不可读/)
      assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
      const rows = ui.nodes(ui.byLabel('评测记录列表')).filter(node => node.type === 'tr').slice(1)
      assert.equal(rows.length, failure === 'eval/list' ? 2 : 0)
      assert.doesNotMatch(ui.text(ui.byLabel('评测记录列表')), /任务 ID：/)
    } finally { ui.cleanup() }
  }
})

test('迟到的 Run 索引不覆盖显式深链或用户切换的工作区', async () => {
  for (const route of [{ page: 'evaluation', tab: 'runs', run_id: runA }, { page: 'evaluation', tab: 'compare' }]) {
    let release
    const pending = new Promise(resolve => { release = resolve })
    const ui = workbench({ target: { page: 'evaluation' }, handler: async (action, payload, original) => {
      if (action === 'runs/overview') { await pending; return alphaOverview([{ experiment_id: expA, runs: [{ run_id: runB, status: 'completed', created_at: '2026-10-15T09:00:00Z' }] }]) }
      return original(action, payload)
    } })
    try {
      await ui.settle()
      ui.setTarget(route)
      release()
      await ui.settle()
      assert.equal(ui.getTarget().tab, route.tab)
      assert.equal(ui.getTarget().run_id, route.run_id)
      assert.equal(ui.navigations.some(item => item.run_id === runB), false)
    } finally { ui.cleanup() }
  }
})

test('Run 四个子视图随路由恢复，旧轨迹入口归入文件，浏览器往返保持 Run 且 Case 深链优先', async () => {
  const target = { page: 'evaluation', tab: 'runs', run_id: runA }
  const ui = workbench({ target })
  try {
    await ui.settle()
    for (const [label, run_tab] of [['逐例结果', 'results'], ['产物文件', 'files'], ['决策样本', 'datasets']]) {
      ui.button(label).props.onClick(); await ui.settle()
      assert.equal(ui.getTarget().run_id, runA)
      assert.equal(ui.getTarget().run_tab, run_tab)
      assert.equal(ui.nodes().find(node => node.props?.id === `evaluation-run-tab-${run_tab}`).props['aria-selected'], true)
    }
    ui.setTarget({ ...target, run_tab: 'trace' }); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-files').props['aria-selected'], true)
    ui.setTarget(target); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-report').props['aria-selected'], true)
    ui.setTarget({ ...target, case_id: 'C-1', run_tab: 'trace' }); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-results').props['aria-selected'], true)
    ui.button('产物文件').props.onClick(); await ui.settle()
    assert.equal(ui.getTarget().run_id, runA)
    assert.equal(ui.getTarget().case_id, undefined)
    assert.equal(ui.getTarget().run_tab, 'files')
  } finally { ui.cleanup() }
})

test('Job 选择与深链聚焦同一任务，返回记录恢复列表入口', async () => {
  const jobs = ['job-1', 'job-2'].map(job_id => ({ job_id, source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }))
  const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'job-1' }, handler: async (action, payload, original) => {
    if (action === 'eval/list') return { jobs }
    if (action === 'eval/status') return { job_id: payload.job_id, status: 'running' }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const title = ui.nodes().find(node => node.type === 'strong' && node.ref)
    const headingEvents = [], listEvents = []
    assert.ok(title?.ref)
    title.ref.current = { scrollIntoView: options => headingEvents.push(`scroll:${options.block}`), focus: () => headingEvents.push('focus') }
    ui.setTarget({ page: 'evaluation', tab: 'jobs', job_id: 'job-2' }); await ui.settle()
    assert.equal(ui.getTarget().job_id, 'job-2')
    assert.deepEqual(headingEvents, ['scroll:start', 'focus'])
    const listHeading = ui.nodes().find(node => node.props?.id === 'evaluation-record-list')
    listHeading.ref.current = { scrollIntoView: options => listEvents.push(`scroll:${options.block}`), focus: () => listEvents.push('focus') }
    ui.button('返回评测记录').props.onClick(); await ui.settle()
    assert.deepEqual(listEvents, ['scroll:center', 'focus'])
    assert.equal(ui.getTarget().job_id, undefined)
    assert.equal(ui.getTarget().tab, 'runs')
  } finally { ui.cleanup() }
})

test('旧job_id深链只读取实际关联并replace为原Run，不启动评测', async () => {
  for (let index = 0; index < 2; index++) {
    const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'legacy-job', agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
      if (action === 'eval/status' && payload.job_id) return { run_id: runA, run_created: true, status: 'running', source: `experiment:${expA}` }
      return fallback(action, payload)
    } })
    try {
      await ui.settle()
      assert.equal(ui.getTarget().run_id, runA); assert.equal(ui.getTarget().job_id, undefined)
      assert.equal(ui.getTarget().tab, 'runs')
      assert.ok(ui.navigations.some(item => item.run_id === runA && item.replace === true))
      assert.ok(ui.calls.some(call => call.action === 'eval/status' && call.payload.job_id === 'legacy-job'))
      assert.equal(ui.calls.some(call => ['eval/start', 'eval/preview'].includes(call.action)), false)
    } finally { ui.cleanup() }
  }
})

test('明确Run深链优先于同时残留的旧Job参数，不查询或跳到另一个Run', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runB, job_id: 'legacy-job' } })
  try {
    await ui.settle()
    assert.equal(ui.getTarget().run_id, runB)
    assert.equal(ui.calls.some(call => call.action === 'eval/status' && call.payload.job_id), false)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
    assert.ok(ui.calls.some(call => call.action === 'runs/show' && call.payload.run_id === runB))
  } finally { ui.cleanup() }
})

test('控制快照与评测事实按Run ID合并，未创建Run的预留或失败不进入表格', async () => {
  const ui = workbench({ handler(action, payload, fallback) {
    if (action === 'eval/list') return { runs: [
      { run_id: runA, run_created: true, source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running' },
      { run_id: 'run-prepared', run_created: false, status: 'prepared' },
      { run_id: null, legacy_id: 'failed-without-run', run_created: false, status: 'failed' },
    ], errors: [] }
    return fallback(action, payload)
  } })
  try {
    await ui.settle()
    const rows = ui.nodes(ui.byLabel('评测记录列表')).filter(node => node.type === 'tr').slice(1)
    assert.equal(rows.length, 2)
    assert.equal(ui.nodes(ui.byLabel('评测记录列表')).filter(node => node.type === 'button' && node.props.title === runA).length, 1)
    assert.doesNotMatch(ui.text(ui.byLabel('评测记录列表')), /failed-without-run|run-prepared|任务 ID：/)
  } finally { ui.cleanup() }
})

test('用例与比较深链直接呈现目标工作区并保留范围筛选', async () => {
  for (const tab of ['cases', 'compare']) {
    const ui = workbench({ target: { page: 'evaluation', tab, agent_id: 'alpha', experiment_id: expA } })
    try {
      await ui.settle()
      assert.equal(ui.nodes().some(node => node.type === 'section' && node.props.className?.includes('harness-eval-record-list')), false)
      assert.ok(ui.byLabel('评测智能体'))
      assert.ok(ui.byLabel('评测研究版本'))
      assert.equal(ui.byLabel('评测工作区').props.children.find(node => node.props.id === `evaluation-tab-${tab}`).props['aria-selected'], true)
    } finally { ui.cleanup() }
  }
})

test('Run 深链接的返回按钮将焦点送到运行列表标题', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA } })
  try {
    await ui.settle()
    const title = ui.nodes().find(node => node.props?.id === 'evaluation-record-list')
    assert.ok(title?.ref)
    const events = []
    title.ref.current = { scrollIntoView: options => events.push(`scroll:${options.block}`), focus: () => events.push('focus') }
    ui.button('返回评测记录').props.onClick(); await ui.settle()
    assert.deepEqual(events, ['scroll:center', 'focus'])
  } finally { ui.cleanup() }
})

test('直接打开 Run 深链接时等待目标详情加载后定位并聚焦', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action === 'runs/show') await pending
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const heading = ui.nodes().find(node => node.type === 'h2' && ui.text(node).endsWith('评测'))
    const events = []
    heading.ref.current = { scrollIntoView: options => events.push(`scroll:${options.block}`), focus: () => events.push('focus') }
    assert.deepEqual(events, [], '加载前不定位空详情')
    release(); await ui.settle()
    assert.deepEqual(events, ['scroll:start', 'focus'])
  } finally { ui.cleanup() }
})

test('Run 深链接等待列表布局稳定后才定位详情', async () => {
  let releaseIndex
  const pendingIndex = new Promise(resolve => { releaseIndex = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') await pendingIndex
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const heading = ui.nodes().find(node => node.type === 'h2' && ui.text(node).endsWith('评测'))
    const events = []
    heading.ref.current = { scrollIntoView: options => events.push(`scroll:${options.block}`), focus: () => events.push('focus') }
    assert.match(ui.text(heading), /评测$/)
    assert.deepEqual(events, [], '详情先于列表返回时不提前滚动')
    releaseIndex(); await ui.settle()
    assert.deepEqual(events, ['scroll:start', 'focus'])
  } finally { ui.cleanup() }
})

test('Run 深链接等待页首 Job 列表读取后再定位详情', async () => {
  let releaseJobs
  const pendingJobs = new Promise(resolve => { releaseJobs = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action === 'eval/list') { await pendingJobs; return { jobs: [{ job_id: 'job-1', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] } }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const heading = ui.nodes().find(node => node.type === 'h2' && ui.text(node).endsWith('评测'))
    const events = []
    heading.ref.current = { scrollIntoView: options => events.push(`scroll:${options.block}`), focus: () => events.push('focus') }
    assert.deepEqual(events, [], '页首 Job 横幅与记录行未确定前不滚动')
    releaseJobs(); await ui.settle()
    assert.deepEqual(events, ['scroll:start', 'focus'])
  } finally { ui.cleanup() }
})

test('Run 异步读取期间切到比较工作区，不再聚焦隐藏的 Run 详情', async () => {
  let releaseRun
  const pendingRun = new Promise(resolve => { releaseRun = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action === 'runs/show') await pendingRun
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const heading = ui.nodes().find(node => node.type === 'h2' && ui.text(node).endsWith('评测'))
    const events = []
    heading.ref.current = { scrollIntoView: () => events.push('scroll'), focus: () => events.push('focus') }
    ui.byLabel('评测工作区').props.children.find(node => node.props.id === 'evaluation-tab-compare').props.onClick()
    releaseRun(); await ui.settle()
    assert.deepEqual(events, [])
    assert.equal(ui.getTarget().tab, 'compare')
  } finally { ui.cleanup() }
})

test('深链接切换 Run 后只定位最终读取的目标', async () => {
  let releaseOld
  const oldPending = new Promise(resolve => { releaseOld = resolve })
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/show' && payload.run_id === runA) await oldPending
    return original(action, payload)
  } })
  try {
    await ui.settle()
    ui.setTarget({ page: 'evaluation', tab: 'runs', run_id: runA })
    await ui.settle()
    const heading = ui.nodes().find(node => node.type === 'h2' && ui.text(node).endsWith('评测'))
    const events = []
    heading.ref.current = { scrollIntoView: options => events.push(`scroll:${options.block}`), focus: () => events.push('focus') }
    ui.setTarget({ page: 'evaluation', tab: 'runs', run_id: runB })
    await ui.settle()
    assert.deepEqual(events, ['scroll:start', 'focus'])
    releaseOld(); await ui.settle()
    assert.deepEqual(events, ['scroll:start', 'focus'], '旧 Run 迟到响应不能再次抢走焦点')
  } finally { ui.cleanup() }
})

test('无Run的旧深链失效时只显示说明和重新查询，不静默选中其他记录', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'legacy-missing' }, handler(action, payload, fallback) {
    if (action === 'eval/status') throw new Error('not_found: 旧评测不存在')
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); assert.match(ui.text(), /旧评测未形成可继续的运行记录/)
    assert.equal(ui.getTarget().run_id, undefined)
    ui.button('重新查询').props.onClick(); await ui.settle()
    assert.equal(ui.calls.filter(call => call.action === 'eval/status' && call.payload.job_id === 'legacy-missing').length, 2)
    assert.equal(ui.calls.some(call => ['eval/start', 'eval/preview'].includes(call.action)), false)
  } finally { ui.cleanup() }
})

test('活动控制记录以同一Run进入结果详情，列表不额外显示任务身份', async () => {
  const activeRun = 'run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const control = { run_id: activeRun, run_created: true, source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-11-04T08:00:00Z' }
  const ui = workbench({ handler(action, payload, fallback) {
    if (action === 'eval/list') return { runs: [control], errors: [] }
    if (action === 'eval/status' && payload.run_id === activeRun) return control
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); assert.ok(ui.idButton(activeRun))
    assert.equal(ui.byLabel('评测进度'), undefined, '未选择时没有另一个任务工作面')
    ui.idButton(activeRun).props.onClick({ stopPropagation() {} }); await ui.settle()
    assert.equal(ui.getTarget().run_id, activeRun); assert.equal(ui.getTarget().job_id, undefined)
    assert.match(ui.text(ui.byLabel('评测进度')), /Run ID：run-aaaaaaaa.*运行中/s)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
  } finally { ui.cleanup() }
})

test('Run 列表将执行完成和有效失败、无法判定分别显示', async () => {
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [
      { run_id: runA, status: 'completed', effective_verdict: 'failed' },
      { run_id: 'run-33333333-3333-4333-8333-333333333333', status: 'completed', effective_verdict: 'inconclusive' },
    ] }])
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const rows = ui.nodes().filter(node => node.type === 'tr' && node.props?.['data-selected'] !== undefined)
    const rowFor = id => rows.find(row => ui.nodes(row).some(node => node.type === 'button' && node.props.title === id))
    assert.match(ui.text(rowFor(runA)), /已结束.*未通过/)
    assert.match(ui.text(rowFor('run-33333333-3333-4333-8333-333333333333')), /已结束.*无法判定/)
    assert.match(ui.text(rowFor('run-33333333-3333-4333-8333-333333333333')), /结果未知 · 逐例记录待核对/)
  } finally { ui.cleanup() }
})

test('分层评估的列表保留业务通过，源码未完成和历史未单列状态不会混为一谈', async () => {
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [
      { run_id: runA, status: 'completed', effective_verdict: 'passed', review_contract: reviewContract, review_status: 'completed', source_diagnosis: { status: 'incomplete', conclusion: 'inconclusive' } },
      { run_id: runB, status: 'completed', effective_verdict: 'failed' },
    ] }])
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const rows = ui.nodes().filter(node => node.type === 'tr' && node.props?.['data-selected'] !== undefined)
    const rowFor = id => rows.find(row => ui.nodes(row).some(node => node.type === 'button' && node.props.title === id))
    assert.match(ui.text(rowFor(runA)), /通过业务效果复核：已完成源码诊断：未完成 · 源码未核实完整/)
    assert.ok(ui.nodes(rowFor(runA)).some(node => node.type === 'small' && node.props.className === 'harness-eval-review-status'))
    assert.equal(ui.nodes(rowFor(runB)).some(node => node.props?.className === 'harness-eval-review-status'), false)
    assert.doesNotMatch(ui.text(rowFor(runB)), /源码诊断：|业务效果复核：/)
  } finally { ui.cleanup() }
})

test('分层评估详情展示源码范围、未核实限制及证据入口，源码完成也不表示整体代码通过', async () => {
  for (const [status, conclusion, expected] of [['incomplete', 'inconclusive', '未完成 · 源码未核实完整'], ['completed', 'no_findings', '所列范围未形成发现']]) {
    const evidence = 'evidence/analysis/source-diagnosis/trace.jsonl'
    const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
      const value = await original(action, payload)
      if (action === 'runs/files') return { ...value, files: [...value.files, { path: `evolution/experiments/${expA}/runs/${runA}/${evidence}`, kind: 'text', size: 20 }] }
      return action === 'runs/show' ? { ...value, source: { ...value.source, review_contract: reviewContract }, summary: { effective_verdict: 'passed', review_status: 'completed' }, source_diagnosis: { status, conclusion, reason: '仅完成所列范围审读', scope: [{ bundle: 'harness', path: 'workflow.ts', total_lines: 20, sha256: 'c'.repeat(64), read_ranges: [[1, 5]], complete: false }], findings: [], analysis_session: { session_id: 'source-session', route: reviewContract.model_route, evidence_ref: evidence } } } : value
    } })
    try {
      await ui.settle()
      const component = ui.nodes().find(node => node.type?.name === 'RunReviewAssessment')
      assert.ok(component)
      const rendered = component.type(component.props)
      assert.ok(rendered.props.className.split(' ').includes('harness-eval-review-assessment'))
      assert.equal(component.type({ ...component.props, view: { ...component.props.view, source: {} } }), null, '旧Run无独立诊断区，不改变其比较行数')
      assert.match(ui.text(rendered), new RegExp(expected))
      assert.match(ui.text(rendered), /workflow\.ts.*该材料分片尚未完整读取.*已读行：1–5 \/ 共 20 行/)
      assert.match(ui.text(rendered), /不改变业务效果判定；未审读部分尚未核实/)
      assert.doesNotMatch(ui.text(rendered), /整体代码通过|源码通过/)
      const button = ui.nodes(rendered).find(node => node.type === 'button')
      button.props.onClick(); await ui.settle()
      assert.ok(ui.calls.some(call => call.action === 'runs/read-file' && call.payload.path.endsWith(`/${evidence}`)))
    } finally { ui.cleanup() }
  }
})

test('Run 详情优先展示保存的结论、用例观察和异常证据入口', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action !== 'runs/show') return original(action, payload)
    const value = await original(action, payload)
    return { ...value, summary: { effective_verdict: 'failed' }, cases: [
      { case_id: 'C-1', frozen: { title: '正常回复' }, trials: [{ verdict: 'passed' }] },
      { case_id: 'C-2', frozen: { title: '分页遗漏' }, trials: [{ verdict: 'failed', failure_reason: '遗漏第 3 页' }] },
      { case_id: 'C-3', frozen: { title: '服务超时' }, trials: [{ verdict: 'inconclusive', observation: '证据不足' }] },
      { case_id: 'C-4', frozen: { title: '重复试次' }, trials: [{ verdict: 'passed' }, { verdict: 'failed' }] },
    ] }
  } })
  try {
    await ui.settle()
    assert.equal(ui.text(ui.nodes(ui.byLabel('Run 详情')).find(node => node.props?.className === 'harness-eval-detail-title')?.props.children?.[1]), '未通过')
    assert.match(ui.text(ui.byLabel('用例观察分布')), /共 4 个选定用例/)
    const categories = ui.nodes(ui.byLabel('用例观察分类')).filter(node => node.type === 'li').map(node => ui.text(node))
    assert.deepEqual(categories, ['通过1', '未通过1', '无法判定1', '结果不一致1', '未记录结果0'])
    const attention = ui.byLabel('需关注的用例')
    assert.equal(ui.nodes(attention).filter(node => node.type === 'li').length, 3)
    assert.match(ui.text(attention), /分页遗漏.*遗漏第 3 页/)
    assert.match(ui.text(attention), /无法判定.*服务超时/)
    const failed = ui.nodes(attention).find(node => node.type === 'button' && ui.text(node).includes('分页遗漏'))
    failed.props.onClick(); await ui.settle()
    assert.equal(ui.getTarget().case_id, 'C-2')
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-results').props['aria-selected'], true)
  } finally { ui.cleanup() }
})

test('评测列表按业务结论筛选，默认选中后只展示该 Run 的逐例分布', async () => {
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [
      { run_id: runA, status: 'completed', effective_verdict: 'failed', created_at: '2026-10-20T08:00:00Z', title: '分页与报告完整性验证', case_scope: '3 项已选用例', case_counts: { total: 3, passed: 1, failed: 1, inconclusive: 1, mixed: 0, pending: 0 } },
      { run_id: 'run-33333333-3333-4333-8333-333333333333', status: 'completed', effective_verdict: 'passed', title: '巡检能力基线验证', case_scope: '2 项已选用例', case_counts: { total: 2, passed: 2, failed: 0, inconclusive: 0, mixed: 0, pending: 0 } },
    ] }])
    if (action === 'runs/show') return { ...(await original(action, payload)), summary: { effective_verdict: 'failed' }, cases: [
      { case_id: 'C-1', trials: [{ verdict: 'passed' }] },
      { case_id: 'C-2', trials: [{ verdict: 'failed' }] },
      { case_id: 'C-3', trials: [{ verdict: 'inconclusive' }] },
    ] }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const baselineRow = ui.nodes().find(node => node.type === 'tr' && ui.nodes(node).some(child => child.type === 'button' && child.props.title === 'run-33333333-3333-4333-8333-333333333333'))
    assert.match(ui.text(baselineRow), /巡检能力基线验证.*2 项已选用例.*2 通过 \/ 0 未通过 \/ 0 无法判定/)
    assert.equal(ui.calls.some(call => call.action === 'runs/show' && call.payload.run_id === 'run-33333333-3333-4333-8333-333333333333'), false, '列表摘要不逐条加载完整 Run')
    ui.change('筛选评测结论', 'failed')
    const rows = ui.nodes().filter(node => node.type === 'tr' && node.props?.['data-selected'] !== undefined)
    assert.equal(rows.length, 1)
    assert.match(ui.text(rows[0]), /分页与报告完整性验证/)
    assert.match(ui.text(rows[0]), /1 通过 \/ 1 未通过 \/ 1 无法判定/)
    ui.idButton(runA).props.onClick({ stopPropagation() {} }); await ui.settle()
    const selected = ui.nodes().find(node => node.type === 'tr' && node.props?.['data-selected'] === true)
    assert.match(ui.text(selected), /1 通过 \/ 1 未通过 \/ 1 无法判定/)
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-report').props['aria-selected'], true)
    assert.ok(ui.nodes().some(node => node.props?.className === 'harness-eval-overview-grid'))
    ui.button('AI 分析并改进').props.onClick(); await ui.settle()
    assert.equal(ui.assistants.at(-1).context.run_id, runA)
  } finally { ui.cleanup() }
})

test('Run 列表读取失败与真实空列表分开显示', async () => {
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/overview') throw new Error('网络中断')
    return original(action, payload)
  } })
  try {
    await ui.settle()
    assert.match(ui.text(), /Run 列表读取失败.*网络中断/)
    assert.doesNotMatch(ui.text(), /当前筛选范围暂无 Run/)
  } finally { ui.cleanup() }
})

test('未完成 Run 的部分通过摘要不成为列表、详情或对照的整体结论', async () => {
  const partial = [
    { run_id: runB, status: 'failed', effective_verdict: 'passed', case_counts: { total: 2, passed: 1, failed: 0, inconclusive: 0, mixed: 0, pending: 1 } },
    { run_id: 'run-33333333-3333-4333-8333-333333333333', status: 'cancelled', effective_verdict: 'passed' },
    { run_id: 'run-44444444-4444-4444-8444-444444444444', status: 'running', effective_verdict: 'passed' },
  ]
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/overview') return overview([['alpha', [{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed', effective_verdict: 'passed' }, ...partial] }]], ['beta', []]])
    if (action === 'runs/show') {
      const status = partial.find(run => run.run_id === payload.run_id)?.status ?? 'completed'
      return { ...(await original(action, payload)), manifest: { agent_id: 'alpha', experiment_id: expA, status },
        summary: { effective_verdict: 'passed', machine_overall_verdict: 'passed' },
        cases: [{ case_id: 'C-1', frozen: { inputs: ['输入'], expected_behavior: '回答' }, trials: [{ verdict: 'passed', execution_status: 'completed' }], evidence: [] },
          { case_id: 'C-2', frozen: { inputs: ['待执行输入'], expected_behavior: '回答' }, trials: [], evidence: [] }] }
    }
    if (action === 'runs/compare') return { left_run: payload.left, right_run: payload.right, cases: [], limits: [] }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const rows = ui.nodes().filter(node => node.type === 'tr' && node.props?.['data-selected'] !== undefined)
    for (const run of partial) {
      const row = rows.find(node => ui.nodes(node).some(child => child.type === 'button' && child.props.title === run.run_id))
      assert.match(ui.text(row), /尚无结论/)
      assert.equal(ui.nodes(ui.nodes(row).find(node => node.type === 'td' && node.props['data-label'] === '评测结论')).find(node => node.props?.className === 'harness-eval-badge').props['data-state'], 'unknown')
    }
    assert.match(ui.text(rows.find(node => ui.nodes(node).some(child => child.type === 'button' && child.props.title === runB))), /1 通过 \/ 0 未通过 \/ 0 无法判定 \/ 1 待核对.*部分记录，非最终结论/)
    assert.match(ui.text(rows.find(node => ui.nodes(node).some(child => child.type === 'button' && child.props.title === runA))), /通过/)
    ui.idButton(runB).props.onClick({ stopPropagation() {} }); await ui.settle()
    const detailFacts = ui.nodes().find(node => node.type?.name === 'Facts' && node.props.items.some(([name]) => name === '机器结论'))
    assert.equal(ui.text(ui.nodes(ui.byLabel('Run 详情')).find(node => node.props?.className === 'harness-eval-detail-title')?.props.children?.[1]), '尚无结论')
    assert.equal(detailFacts.props.items.find(([name]) => name === '机器结论')[1], '未记录')
    assert.match(ui.text(), /仅是已采集的部分证据/)
    assert.equal(ui.nodes().find(node => node.type?.name === 'RunCase')?.props.item.trials[0].verdict, 'passed', '逐例证据仍可查看')
    ui.nodes().find(node => node.props?.id === 'evaluation-tab-compare').props.onClick(); await ui.settle()
    ui.change('左侧 Run', runB); ui.change('右侧 Run', runA)
    ui.button('开始比较').props.onClick(); await ui.settle()
    const comparisonFacts = ui.nodes().filter(node => node.type?.name === 'Facts' && node.props.items.some(([name]) => name === '业务效果'))
    assert.deepEqual(comparisonFacts.map(node => node.props.items.find(([name]) => name === '业务效果')[1]), ['尚无结论', '通过'])
  } finally { ui.cleanup() }
})

test('运行控制快照中的部分通过不能替代Run的有效业务结论', async () => {
  const ui = workbench({ handler(action, payload, fallback) {
    if (action === 'eval/list') return { runs: [{ run_id: runA, run_created: true, agent_id: 'alpha', experiment_id: expA, status: 'running', summary: { effective_verdict: 'passed' } }], errors: [] }
    if (action === 'runs/overview') return overview([['alpha', [{ experiment_id: expA, runs: [{ run_id: runA, status: 'running', effective_verdict: 'passed' }] }]]])
    return fallback(action, payload)
  } })
  try {
    await ui.settle()
    const row = ui.nodes(ui.byLabel('评测记录列表')).find(node => node.type === 'tr' && node.props.onClick)
    const verdict = ui.nodes(row).find(node => node.type === 'td' && node.props['data-label'] === '评测结论')
    assert.match(ui.text(verdict), /尚无结论/); assert.doesNotMatch(ui.text(verdict), /^通过/)
  } finally { ui.cleanup() }
})

test('取消评测确认同一Run ID，快速双击只发送一次取消请求', async () => {
  let resolveCancel, status = 'running'
  const pendingCancel = new Promise(resolve => { resolveCancel = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA, agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
    if (action === 'eval/status') return { run_id: runA, run_created: true, status }
    if (action === 'eval/cancel') return pendingCancel
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); ui.button('取消评测').props.onClick(); ui.render()
    assert.match(ui.text(), new RegExp(`Run ID：${runA}`))
    const confirm = ui.button('确认取消'); confirm.props.onClick(); confirm.props.onClick(); await ui.settle()
    assert.equal(ui.calls.filter(call => call.action === 'eval/cancel').length, 1)
    assert.deepEqual({ ...ui.calls.find(call => call.action === 'eval/cancel').payload }, { run_id: runA })
    status = 'cancelling'; resolveCancel({ run_id: runA, status }); await ui.settle()
    assert.equal(ui.button('取消评测').props.disabled, true)
  } finally { resolveCancel?.({}); ui.cleanup() }
})

test('进度读取失败保留原Run和上次观察，刷新只查询不重启', async () => {
  let offline = false
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler(action, payload, fallback) {
    if (action === 'eval/status') { if (offline) throw new Error('unavailable: 状态不可读'); return { run_id: runA, run_created: true, status: 'running' } }
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); offline = true; ui.button('刷新状态').props.onClick(); await ui.settle()
    assert.match(ui.text(ui.byLabel('评测进度')), /上次观察.*状态不可读/s)
    assert.equal(ui.getTarget().run_id, runA); assert.equal(ui.button('取消评测').props.disabled, true)
    offline = false; ui.button('刷新状态').props.onClick(); await ui.settle()
    assert.doesNotMatch(ui.text(ui.byLabel('评测进度')), /状态不可读/)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
  } finally { ui.cleanup() }
})

test('Run Case 深链刷新后打开逐例结果并定位 Case，返回无 Case 链接恢复报告', async () => {
  const target = { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA, run_id: runA, case_id: 'C-2' }
  for (let reopen = 0; reopen < 2; reopen++) {
    const ui = workbench({ target, handler: async (action, payload, original) => {
      if (action === 'runs/show') return { ...(await original(action, payload)), cases: [
        { case_id: 'C-1', frozen: { title: '第一例' }, trials: [], evidence: [] },
        { case_id: 'C-2', frozen: { title: '第二例' }, trials: [], evidence: [] },
      ] }
      return original(action, payload)
    } })
    try {
      await ui.settle()
      assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-results').props['aria-selected'], true)
      assert.ok(ui.nodes(ui.byLabel('Run 结果用例')).some(node => node.type === 'button' && node.props['aria-current'] === 'true' && ui.text(node).includes('C-2')))
      assert.equal(ui.nodes().find(node => node.type?.name === 'RunCase')?.props.item.case_id, 'C-2')
      assert.equal(ui.calls.some(call => call.action === 'cases/read'), false, 'Run Case 不读取可编辑用例')
      ui.setTarget({ ...target, case_id: undefined }); await ui.settle()
      assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-report').props['aria-selected'], true)
    } finally { ui.cleanup() }
  }
})

test('发起评测导航仅打开配置意图并清除一次性参数，不自动执行', async () => {
  const ui = workbench({ target: { page: 'evaluation', agent_id: 'alpha', experiment_id: expA, intent: 'start_eval' } })
  try {
    await ui.settle()
    assert.equal(ui.getTarget().intent, undefined)
    assert.equal(ui.navigations.at(-1).replace, true)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
  } finally { ui.cleanup() }
})

test('Case 冲突保留编辑框与下载草稿，读取最新后显式采用新基准', async () => {
  let latest = false
  let savedHash
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => {
    if (action === 'cases/read' && latest) return { ...doc, sha256: 'case-v2', case: { ...doc.case, title: '另一窗口的标题' } }
    if (action === 'cases/update') {
      if (payload.expected_sha256 === 'case-v1') throw new Error('conflict: 用例已修改')
      savedHash = payload.expected_sha256
      return { ...doc, sha256: 'case-v3', case: { ...doc.case, title: payload.title, inputs: payload.inputs, expected_behavior: payload.expected_behavior } }
    }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    ui.button('测试一C-1场景一 · fast').props.onClick({ stopPropagation() {} }); await ui.settle()
    ui.button('编辑用例').props.onClick(); ui.render()
    ui.change('用例名称', '我的标题')
    latest = true
    ui.button('保存用例').props.onClick(); await ui.settle()
    assert.equal(ui.byLabel('用例名称').props.value, '我的标题')
    const download = ui.nodes().find(node => node.type === 'a' && ui.text(node) === '下载用例草稿')
    assert.ok(download?.props.href.includes(encodeURIComponent('我的标题')))
    ui.button('读取最新用例').props.onClick(); await ui.settle()
    assert.equal(ui.byLabel('用例名称').props.value, '我的标题')
    assert.match(ui.text(), /另一窗口的标题/)
    ui.button('使用最新版本作为保存基准').props.onClick(); ui.render()
    ui.button('保存用例').props.onClick(); await ui.settle()
    assert.equal(savedHash, 'case-v2')
  } finally { ui.cleanup() }
})

test('Decision 冲突关闭再打开仍保留草稿，读取最新后显式合并保存', async () => {
  let savedHash
  let latest = false
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action === 'detail') {
      const value = await original(action, payload)
      return latest ? { ...value, decision: { content: '# Decision\n另一窗口内容', sha256: 'decision-v2' } } : value
    }
    if (action === 'decision/update') {
      if (payload.expected_sha256 === 'decision-v2') { savedHash = payload.expected_sha256; return { sha256: 'decision-v3' } }
      latest = true
      throw new Error('conflict: Decision 已修改')
    }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    ui.button('记录研究决策').props.onClick(); await ui.settle()
    ui.change('Decision 正文', '# Decision\n我的内容')
    ui.button('保存研究决策').props.onClick(); await ui.settle()
    assert.match(ui.text(), /草稿已保留/)
    const download = ui.nodes().find(node => node.type === 'a' && ui.text(node) === '下载 Decision 草稿')
    assert.ok(download?.props.href.includes(encodeURIComponent('我的内容')))
    const dialog = ui.nodes().find(node => node.type === 'dialog' && node.props.className === 'harness-eval-decision-dialog')
    ui.nodes(dialog).find(node => node.type === 'button' && ui.text(node) === '关闭').props.onClick(); ui.render()
    ui.button('记录研究决策').props.onClick(); ui.render()
    assert.equal(ui.byLabel('Decision 正文').props.value, '# Decision\n我的内容')
    ui.button('读取最新 Decision').props.onClick(); await ui.settle()
    assert.match(ui.text(), /另一窗口内容/)
    ui.button('使用最新版本作为保存基准').props.onClick(); ui.render()
    ui.button('保存研究决策').props.onClick(); await ui.settle()
    assert.equal(savedHash, 'decision-v2')
  } finally { ui.cleanup() }
})

test('用例行选择与执行复选框独立，编辑多轮输入保存回读，失败保留草稿并保护跳转', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA } })
  await ui.settle()
  ui.button('新建评测').props.onClick(); ui.render(); ui.button('自选用例').props.onClick(); ui.render()
  ui.byLabel('执行 C-1').props.onChange({ target: { checked: true } })
  await ui.settle()
  assert.equal(ui.calls.some(call => call.action === 'cases/read'), false)
  ui.button('测试一C-1场景一 · fast').props.onClick({ stopPropagation() {} })
  await ui.settle()
  ui.button('编辑用例').props.onClick()
  ui.render()
  ui.change('用例名称', '修改后的用例')
  ui.button('＋ 添加一轮输入').props.onClick()
  ui.render()
  ui.change('第 2 轮输入', '后续追问')
  let prevented = false
  for (const protect of ui.beforeUnload) protect({ preventDefault() { prevented = true }, returnValue: undefined })
  assert.equal(prevented, true)
  ui.setFailSave(true)
  ui.button('保存用例').props.onClick()
  await ui.settle()
  assert.match(ui.text(), /草稿已保留/)
  assert.equal(ui.byLabel('用例名称').props.value, '修改后的用例')
  ui.confirmationAnswers.push(false)
  ui.button('测试二C-2场景二 · full').props.onClick({ stopPropagation() {} })
  ui.render()
  assert.equal(ui.byLabel('用例名称').props.value, '修改后的用例')
  assert.equal(ui.navigations.at(-1).case_id, 'C-1')
  ui.setFailSave(false)
  ui.button('保存用例').props.onClick()
  await ui.settle()
  const save = ui.calls.filter(call => call.action === 'cases/update').at(-1)
  assert.equal(save.payload.case_id, 'C-1', '编辑内容保留既有用例身份')
  assert.deepEqual(Array.from(save.payload.inputs), ['第一轮', '后续追问'])
  assert.equal(save.payload.expected_sha256, 'case-v1')
  assert.equal(ui.byLabel('用例名称'), undefined)
  assert.match(ui.text(), /已保存。后续评测立即使用新定义/)
  ui.cleanup()
})

test('超过预览限制的轨迹通过完整文件下载入口导出', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA } })
  await ui.settle()
  const file = ui.nodes().find(node => node.type === 'button' && ui.text(node).includes('evidence/C-1/trace.jsonl'))
  file.props.onClick()
  await ui.settle()
  assert.ok(ui.nodes().some(node => node.type?.name === 'RunTraceView'), '轨迹文件默认结构化查看')
  ui.button('原文').props.onClick(); ui.render()
  assert.match(ui.text(), /仅预览前 64 KiB/)
  const link = ui.nodes().find(node => node.type === 'a' && ui.text(node) === '下载完整文件')
  assert.equal(new URL(link.props.href).searchParams.get('path'), `evolution/experiments/${expA}/runs/${runA}/evidence/C-1/trace.jsonl`)
  assert.equal(new URL(link.props.href).searchParams.get('kind'), 'file')
  assert.equal(ui.calls.filter(call => call.action === 'runs/read-file').length, 1)
  ui.cleanup()
})

test('新建评测传递明确范围并定位返回 Run，研究决策保存绑定该 Run 的 Experiment', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA } })
  await ui.settle()
  ui.button('新建评测').props.onClick(); ui.render(); ui.button('自选用例').props.onClick(); ui.render()
  ui.byLabel('执行 C-2').props.onChange({ target: { checked: true } })
  ui.render()
  ui.button('新建评测').props.onClick()
  ui.render()
  ui.button('执行预览').props.onClick()
  await ui.settle()
  assert.deepEqual(Array.from(ui.calls.find(call => call.action === 'eval/preview').payload.cases), ['C-2'])
  ui.button('启动评测').props.onClick()
  await ui.settle()
  assert.equal(ui.navigations.at(-1).run_id, runA)
  ui.button('记录研究决策').props.onClick()
  await ui.settle()
  ui.change('Decision 正文', '# Decision\nadopt')
  ui.button('保存研究决策').props.onClick()
  await ui.settle()
  const save = ui.calls.find(call => call.action === 'decision/update')
  assert.equal(save.payload.experiment_id, expA)
  assert.equal(save.payload.expected_sha256, 'decision-v1')
  assert.match(ui.text(), /研究决策已保存/)
  ui.cleanup()
})

test('深链切换 Run 后迟到的报告响应不会覆盖当前目标', async () => {
  let release
  const waiting = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (payload.run_id === runA && ['runs/show', 'runs/report', 'runs/files'].includes(action)) await waiting
    const value = await original(action, payload)
    return action === 'runs/report' ? { ...value, content: `报告 ${payload.run_id}` } : value
  } })
  await ui.settle()
  ui.setTarget({ page: 'evaluation', tab: 'runs', run_id: runB })
  await ui.settle()
  release()
  await ui.settle()
  const rendered = ui.nodes().filter(node => node.type === ui.MarkdownText).map(node => node.props.text)
  assert.ok(rendered.includes(`报告 ${runB}`))
  assert.ok(!rendered.includes(`报告 ${runA}`))
  ui.cleanup()
})

test('比较限制候选为同一智能体，并按冻结输入并排展示共同 Case', async () => {
  const runC = 'run-33333333-3333-4333-8333-333333333333'
  const ui = workbench({ target: { page: 'evaluation', tab: 'compare' }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed' }, { run_id: runC, status: 'completed' }] }])
    if (action === 'runs/compare') return { left_run: runA, right_run: runC, left_only: [], right_only: [], limits: ['executor: 不同'], cases: [{ case_id: 'C-1', frozen_contract_same: false, observed_change: '记录有差异' }] }
    const value = await original(action, payload)
    if (action === 'runs/show') value.cases[0].frozen.inputs = [payload.run_id === runA ? '左侧冻结输入' : '右侧冻结输入']
    return value
  } })
  await ui.settle()
  const leftOption = ui.byLabel('左侧 Run').props.options.find(node => node.value === runA)
  assert.match(`${leftOption.label} ${leftOption.description}`, /^alpha · v001 · /)
  assert.equal(leftOption.value, runA)
  assert.match(leftOption.description, /11111111$/)
  ui.change('左侧 Run', runA)
  const rightOptions = ui.byLabel('右侧 Run').props.options.map(node => node.value)
  assert.ok(rightOptions.includes(runC))
  assert.ok(!rightOptions.includes(runB))
  ui.change('右侧 Run', runC)
  ui.button('开始比较').props.onClick()
  await ui.settle()
  assert.match(ui.text(), /executor: 不同/)
  assert.match(ui.text(), /冻结用例口径不同/)
  const summary = ui.nodes().find(node => node.props?.className === 'harness-eval-comparison-summary')
  assert.match(ui.text(summary), /^左侧 · alpha · v001Run run-/)
  const caseInputs = ui.nodes().filter(node => node.type?.name === 'RunCase').flatMap(node => Array.from(node.props.item.frozen.inputs))
  assert.deepEqual(caseInputs, ['左侧冻结输入', '右侧冻结输入'])
  ui.cleanup()
})

test('浏览器导航从具体研究版本返回全部版本时清除旧版本筛选', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA } })
  await ui.settle()
  assert.equal(ui.byLabel('评测研究版本').props.value, expA)
  ui.setTarget({ page: 'evaluation', tab: 'runs', agent_id: 'alpha' })
  await ui.settle()
  assert.equal(ui.byLabel('评测研究版本').props.value, '')
  assert.equal(ui.contexts.at(-1).experiment_id, undefined)
  ui.cleanup()
})

test('在旧报告发起评测时预览分配新Run，创建成功后定位同一新Run', async () => {
  const created = 'run-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA, run_id: runA }, handler(action, payload, fallback) {
    if (action === 'eval/preview') return { run_id: created, result: { case_ids: ['C-1'] } }
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    assert.equal(ui.calls.find(call => call.action === 'eval/start').payload.run_id, created)
    assert.equal(ui.getTarget().run_id, created); assert.equal(ui.getTarget().job_id, undefined)
    assert.ok(ui.calls.some(call => call.action === 'runs/show' && call.payload.run_id === created))
  } finally { ui.cleanup() }
})

test('比较证据入口一次导航到运行标签和对应 Run，并打开实际轨迹文件', async () => {
  const runC = 'run-33333333-3333-4333-8333-333333333333'
  const ui = workbench({ target: { page: 'evaluation', tab: 'compare' }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed' }, { run_id: runC, status: 'completed' }] }])
    if (action === 'runs/compare') return { left_run: runA, right_run: runC, left_only: [], right_only: [], limits: [], cases: [{ case_id: 'C-1', frozen_contract_same: true, observed_change: '记录相同' }] }
    return original(action, payload)
  } })
  await ui.settle()
  ui.change('左侧 Run', runA)
  ui.change('右侧 Run', runC)
  ui.button('开始比较').props.onClick()
  await ui.settle()
  const source = ui.nodes().find(node => node.type?.name === 'RunCase')
  const count = ui.navigations.length
  source.props.onEvidence(`evolution/experiments/${expA}/runs/${runA}/evidence/C-1/trace.jsonl`)
  await ui.settle()
  assert.equal(ui.navigations.length, count + 2, '定位 Run 后将实际打开的文件子视图写入地址')
  assert.equal(ui.navigations.at(-1).run_id, runA)
  assert.equal(ui.navigations.at(-1).tab, 'runs')
  assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-tab-runs').props['aria-selected'], true)
  assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-files').props['aria-selected'], true)
  assert.ok(ui.calls.some(call => call.action === 'runs/read-file' && call.payload.run_id === runA))
  ui.cleanup()
})

test('对照源码证据回到已选中的同一Run时仍打开准确文件', async () => {
  const runC = 'run-33333333-3333-4333-8333-333333333333'
  const evidence = `evolution/experiments/${expA}/runs/${runA}/evidence/analysis/source-diagnosis/response.json`
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed' }, { run_id: runC, status: 'completed' }] }])
    if (action === 'runs/compare') return { left_run: runA, right_run: runC, left_only: [], right_only: [], limits: [], cases: [] }
    const value = await original(action, payload)
    if (action === 'runs/files') return { ...value, files: [...value.files, { path: evidence, kind: 'text', size: 20 }] }
    if (action === 'runs/show') return { ...value, source: { ...value.source, review_contract: reviewContract }, source_diagnosis: { status: 'incomplete', conclusion: 'inconclusive', reason: '范围未完成', scope: [], findings: [] } }
    return value
  } })
  try {
    await ui.settle()
    ui.nodes().find(node => node.props?.id === 'evaluation-tab-compare').props.onClick(); await ui.settle()
    ui.change('左侧 Run', runA); ui.change('右侧 Run', runC)
    ui.button('开始比较').props.onClick(); await ui.settle()
    const summary = ui.nodes().find(node => node.props?.className === 'harness-eval-compare-grid harness-eval-compare-summary-grid')
    const comparison = ui.nodes(summary).find(node => node.type?.name === 'RunReviewAssessment' && node.props.view.run_id === runA)
    assert.ok(comparison)
    comparison.props.onEvidence(evidence); await ui.settle()
    assert.equal(ui.navigations.at(-1).run_id, runA)
    assert.equal(ui.navigations.at(-1).run_tab, 'files')
    assert.ok(ui.calls.some(call => call.action === 'runs/read-file' && call.payload.path === evidence))
  } finally { ui.cleanup() }
})

test('深链切换智能体会取消旧比较选择并隔离迟到的比较响应', async () => {
  const runC = 'run-33333333-3333-4333-8333-333333333333'
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'compare', agent_id: 'alpha' }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed' }, { run_id: runC, status: 'completed' }] }])
    if (action === 'runs/compare') { await pending; return { left_run: runA, right_run: runC, limits: ['Alpha迟到结果'], cases: [{ case_id: 'C-1', frozen_contract_same: true, observed_change: 'Alpha结果' }] } }
    return original(action, payload)
  } })
  await ui.settle()
  ui.change('左侧 Run', runA)
  ui.change('右侧 Run', runC)
  ui.button('开始比较').props.onClick()
  await ui.settle()
  ui.setTarget({ page: 'evaluation', tab: 'compare', agent_id: 'beta' })
  await ui.settle()
  assert.equal(ui.byLabel('左侧 Run').props.value, '')
  assert.equal(ui.byLabel('右侧 Run').props.value, '')
  release()
  await ui.settle()
  assert.ok(!ui.text().includes('Alpha迟到结果'))
  assert.ok(!ui.text().includes('Alpha结果'))
  assert.equal(ui.byLabel('评测智能体').props.value, 'beta')
  ui.cleanup()
})

test('状态响应迟到时已离开评测页只更新任务，返回后不补跳报告', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const origin = { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA, run_id: runB }
  const ui = workbench({ target: origin, handler: async (action, payload, original) => { if (action === 'eval/status') await pending; return original(action, payload) } })
  await ui.settle()
  ui.button('新建评测').props.onClick()
  ui.render()
  ui.button('启动评测').props.onClick()
  await ui.settle()
  assert.ok(ui.calls.some(call => call.action === 'eval/status'))
  ui.setActive(false)
  ui.setTarget({ page: 'home' })
  const navigationCount = ui.navigations.length
  release()
  await ui.settle()
  assert.equal(ui.navigations.length, navigationCount)
  assert.equal(ui.getTarget().page, 'home')
  assert.equal(ui.jobStatus(), '已结束')
  ui.setTarget(origin)
  ui.setActive(true)
  await ui.settle()
  ui.button('刷新状态').props.onClick()
  await ui.settle()
  assert.equal(ui.navigations.length, navigationCount)
  assert.equal(ui.contexts.at(-1).run_id, runB)
  ui.cleanup()
})

test('创建回执迟到时已切换智能体范围，不覆盖新范围或导航', async () => {
  let resolveStart
  const pending = new Promise(resolve => { resolveStart = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
    if (action === 'eval/start') return pending
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    ui.change('评测智能体', ''); await ui.settle()
    resolveStart({ run_id: runA, run_created: true, status: 'running' }); await ui.settle()
    assert.equal(ui.byLabel('评测智能体').props.value, '')
    assert.equal(ui.getTarget().run_id, undefined)
    assert.equal(ui.calls.filter(call => call.action === 'eval/start').length, 1)
  } finally { resolveStart?.({ run_id: runA, run_created: true, status: 'running' }); ui.cleanup() }
})

test('等待任务时手动选择其他 Run，首个任务 run_id 不抢占当前报告', async () => {
  const runC = 'run-33333333-3333-4333-8333-333333333333'
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA, run_id: runB }, handler: async (action, payload, original) => {
    if (action === 'eval/status') { await pending; return { job_id: 'job-1', status: 'completed', result: { run_id: runC } } }
    return original(action, payload)
  } })
  await ui.settle()
  ui.button('新建评测').props.onClick()
  ui.render()
  ui.button('启动评测').props.onClick()
  await ui.settle()
  ui.idButton(runA).props.onClick({ stopPropagation() {} })
  await ui.settle()
  const navigationCount = ui.navigations.length
  release()
  await ui.settle()
  assert.equal(ui.navigations.length, navigationCount)
  assert.equal(ui.getTarget().run_id, runA)
  assert.equal(ui.contexts.at(-1).run_id, runA)
  ui.cleanup()
})

test('从旧链接解析的Run切到其他Run后，子页签与刷新不再携带旧Job', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'legacy-job' } })
  try {
    await ui.settle(); assert.equal(ui.getTarget().run_id, runA)
    ui.idButton(runB).props.onClick({ stopPropagation() {} }); await ui.settle()
    assert.equal(ui.getTarget().run_id, runB); assert.equal(ui.getTarget().job_id, undefined)
    ui.button('产物文件').props.onClick(); await ui.settle()
    assert.equal(ui.getTarget().run_id, runB); assert.equal(ui.getTarget().job_id, undefined)
    ui.invalidate(['agents']); await ui.settle()
    assert.equal(ui.getTarget().run_id, runB)
    assert.equal(ui.calls.filter(call => call.action === 'eval/status' && call.payload.job_id).length, 1)
  } finally { ui.cleanup() }
})

test('浏览器历史切换 Job 范围内的 Run 后，迟到结果不覆盖返回的 Run', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const target = { page: 'evaluation', tab: 'runs', job_id: 'job-1', agent_id: 'alpha', experiment_id: expA, run_id: runB }
  const ui = workbench({ target, handler: async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
    if (action === 'eval/status') { await pending; return { job_id: 'job-1', status: 'completed', result: { run_id: runA } } }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    ui.setTarget({ ...target, run_id: runA }); await ui.settle()
    ui.setTarget(target); await ui.settle()
    const count = ui.navigations.length
    release(); await ui.settle()
    assert.equal(ui.navigations.length, count)
    assert.equal(ui.getTarget().run_id, runB)
  } finally { release(); ui.cleanup() }
})

test('任务状态迟到时用户已切到用例标签，保留当前标签与选择', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => { if (action === 'eval/status') await pending; return original(action, payload) } })
  await ui.settle()
  ui.button('新建评测').props.onClick()
  ui.render()
  ui.button('启动评测').props.onClick()
  await ui.settle()
  ui.nodes().find(node => node.props?.id === 'evaluation-tab-cases').props.onClick()
  await ui.settle()
  const navigationCount = ui.navigations.length
  release()
  await ui.settle()
  assert.equal(ui.navigations.length, navigationCount)
  assert.equal(ui.getTarget().tab, 'cases')
  assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-tab-cases').props['aria-selected'], true)
  ui.cleanup()
})

test('Run AI 抽取按钮从实际 Run 身份固定上下文并明确调用 skill，页面筛选不替换目标', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'beta', experiment_id: 'EXP-beta-001', run_id: runA } })
  try {
    await ui.settle()
    const button = ui.button('请 AI 抽取决策样本')
    assert.equal(button.props.disabled, false)
    await button.props.onClick(); await ui.settle()
    assert.deepEqual(JSON.parse(JSON.stringify(ui.assistants[0].context)), { page: 'evaluation', run_id: runA, agent_id: 'alpha', experiment_id: expA, skill: 'decision-sample-extraction' })
    assert.match(ui.assistants[0].task, /读取并使用 decision-sample-extraction Skill/)
    assert.match(ui.assistants[0].task, /datasets\/source/); assert.match(ui.assistants[0].task, /datasets\/preview/)
    assert.match(ui.assistants[0].task, /extraction_contract/); assert.match(ui.assistants[0].task, /workflow、task/); assert.match(ui.assistants[0].task, /观察动作或推荐判断/); assert.match(ui.assistants[0].task, /禁止评价输入中不可见的回复/)
    assert.equal(ui.calls.some(item => item.action === 'datasets/preview' || item.action === 'datasets/apply'), false)
  } finally { ui.cleanup() }
})

test('Run 尚未封存或身份尚未读取时禁用 AI 抽取，打开助手失败可见且可重试', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, onAssistant: async () => { throw new Error('模型暂时不可达') }, handler: async (action, payload, original) => { if (action === 'runs/show') await pending; return original(action, payload) } })
  try {
    await ui.settle(); assert.equal(ui.button('请 AI 抽取决策样本').props.disabled, true)
    release(); await ui.settle(); assert.equal(ui.button('请 AI 抽取决策样本').props.disabled, false)
    await ui.button('请 AI 抽取决策样本').props.onClick(); await ui.settle()
    assert.match(ui.text(), /模型暂时不可达/); assert.equal(ui.button('请 AI 抽取决策样本').props.disabled, false)
  } finally { ui.cleanup() }
  const running = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    const value = await original(action, payload)
    if (action === 'runs/show') value.manifest.status = 'running'
    if (action === 'runs/files') value.sealed = false
    return value
  } })
  try { await running.settle(); assert.equal(running.button('请 AI 抽取决策样本').props.disabled, true) } finally { running.cleanup() }
})

test('新增用例与 Run 转草稿入口传递准确身份，保存后定位新 Case 并立即刷新清单', async () => {
  let createdDocument
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => {
    if (createdDocument && action === 'cases/read' && payload.case_id === createdDocument.case.id) return createdDocument
    const value = await original(action, payload)
    if (createdDocument && action === 'detail') return { ...value, evaluation: { ...value.evaluation, cases: [...value.evaluation.cases, { id: createdDocument.case.id, title: createdDocument.case.title, scene: createdDocument.case.scene, tier: 'fast' }] } }
    return value
  } })
  try {
    await ui.settle(); ui.button('＋ 新增用例').props.onClick(); ui.render()
    const create = ui.nodes().find(node => node.type?.name === 'CaseCreationDialog')
    assert.ok(create); assert.equal(create.props.agentId, 'alpha'); assert.equal(create.props.experimentId, expA); assert.equal(create.props.sourceRun, undefined)
    const before = ui.calls.filter(item => item.action === 'detail').length
    createdDocument = { path: doc.path, sha256: 'case-created', case: { id: 'U-NEW-001', title: '新的复现输入', inputs: ['全新输入'], expected_behavior: '核对结果', scene: '基础', tier: 'fast', fast: true } }
    create.props.onSaved(createdDocument); create.props.onClose()
    await ui.settle()
    assert.equal(ui.navigations.at(-1).case_id, 'U-NEW-001'); assert.equal(ui.navigations.at(-1).tab, 'cases')
    assert.ok(ui.calls.filter(item => item.action === 'detail').length > before)
    ui.button('新建评测').props.onClick(); ui.render(); ui.button('自选用例').props.onClick(); ui.render()
    assert.ok(ui.byLabel('执行 U-NEW-001'), '新增保存后即出现在后续评测执行范围选项')
    assert.equal(ui.nodes().some(node => node.type?.name === 'CaseCreationDialog'), false)
    ui.setTarget({ page: 'evaluation', tab: 'runs', run_id: runA }); await ui.settle()
    ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-results').props.onClick(); await ui.settle()
    ui.button('从此 Run 创建用例草稿').props.onClick(); ui.render()
    const fromRun = ui.nodes().find(node => node.type?.name === 'CaseCreationDialog')
    assert.equal(fromRun.props.agentId, 'alpha'); assert.equal(fromRun.props.experimentId, expA)
    assert.deepEqual(JSON.parse(JSON.stringify(fromRun.props.sourceRun)), { run_id: runA, case_id: 'C-1' })
  } finally { ui.cleanup() }
})

test('新增用例草稿参与浏览器后退与深链保护，拒绝回原对象，允许后关闭对话框', async () => {
  const origin = { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA }
  const ui = workbench({ target: origin })
  try {
    await ui.settle(); ui.button('＋ 新增用例').props.onClick(); ui.render()
    const create = ui.nodes().find(node => node.type?.name === 'CaseCreationDialog')
    create.props.onDirty(true); ui.render()
    let protectedRefresh = false
    for (const callback of ui.beforeUnload) callback({ preventDefault() { protectedRefresh = true }, returnValue: undefined })
    assert.equal(protectedRefresh, true)
    ui.confirmationAnswers.push(false)
    ui.setTarget({ page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA, run_id: runA }); await ui.settle()
    assert.equal(ui.getTarget().tab, 'cases'); assert.equal(ui.getTarget().run_id, undefined)
    assert.equal(ui.nodes().find(node => node.type?.name === 'CaseCreationDialog').props.agentId, 'alpha')
    ui.confirmationAnswers.push(false)
    ui.setTarget({ page: 'evaluation', tab: 'cases', agent_id: 'beta', experiment_id: 'EXP-beta-001' }); await ui.settle()
    assert.equal(ui.getTarget().agent_id, 'alpha'); assert.equal(ui.byLabel('评测研究版本').props.value, expA)
    ui.confirmationAnswers.push(true)
    ui.setTarget({ page: 'evaluation', tab: 'cases', agent_id: 'beta', experiment_id: 'EXP-beta-001' }); await ui.settle()
    assert.equal(ui.getTarget().agent_id, 'beta')
    assert.equal(ui.nodes().some(node => node.type?.name === 'CaseCreationDialog'), false)
  } finally { ui.cleanup() }
})

test('新增用例保存忙时拒绝目标和页面切换，不重复询问或丢弃模态草稿', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA } })
  try {
    await ui.settle(); ui.button('＋ 新增用例').props.onClick(); ui.render()
    const create = ui.nodes().find(node => node.type?.name === 'CaseCreationDialog')
    create.props.onDirty(true); create.props.onBusy(true); ui.render()
    const confirmations = ui.confirmations.length
    ui.setTarget({ page: 'evaluation', tab: 'cases', agent_id: 'beta', experiment_id: 'EXP-beta-001' }); await ui.settle()
    assert.equal(ui.getTarget().agent_id, 'alpha'); assert.equal(ui.confirmations.length, confirmations)
    assert.ok(ui.nodes().some(node => node.type?.name === 'CaseCreationDialog'))
    ui.setTarget({ page: 'home' }); ui.setActive(false); await ui.settle()
    assert.equal(ui.getTarget().page, 'evaluation'); assert.equal(ui.getTarget().agent_id, 'alpha')
    assert.ok(ui.nodes().some(node => node.type?.name === 'CaseCreationDialog'))
    create.props.onBusy(false); create.props.onDirty(false); ui.setActive(true); await ui.settle()
  } finally { ui.cleanup() }
})

test('新增用例草稿允许离开评测页后卸载模态层，拒绝时恢复评测深链', async () => {
  const origin = { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA }
  const ui = workbench({ target: origin })
  try {
    await ui.settle(); ui.button('＋ 新增用例').props.onClick(); ui.render()
    ui.nodes().find(node => node.type?.name === 'CaseCreationDialog').props.onDirty(true); ui.render()
    ui.confirmationAnswers.push(false); ui.setTarget({ page: 'home' }); ui.setActive(false); await ui.settle()
    assert.equal(ui.getTarget().page, 'evaluation'); assert.ok(ui.nodes().some(node => node.type?.name === 'CaseCreationDialog'))
    ui.setActive(true); await ui.settle()
    ui.confirmationAnswers.push(true); ui.setTarget({ page: 'home' }); ui.setActive(false); await ui.settle()
    assert.equal(ui.getTarget().page, 'home'); assert.equal(ui.nodes().some(node => node.type?.name === 'CaseCreationDialog'), false)
  } finally { ui.cleanup() }
})

test('Run取消中不重复发取消，收尾后仍读取原Run的封存结果', async () => {
  let state = 'running'
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler(action, payload, fallback) {
    if (action === 'eval/status') return { run_id: runA, run_created: true, status: state }
    if (action === 'eval/cancel') { state = 'cancelling'; return { run_id: runA, run_created: true, status: state } }
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); ui.button('取消评测').props.onClick(); ui.render(); ui.button('确认取消').props.onClick(); await ui.settle()
    assert.match(ui.text(ui.byLabel('评测进度')), /正在取消/)
    assert.equal(ui.button('取消评测').props.disabled, true)
    state = 'cancelled'; ui.button('刷新状态').props.onClick(); await ui.settle()
    assert.equal(ui.getTarget().run_id, runA)
    assert.equal(ui.calls.filter(call => call.action === 'eval/cancel').length, 1)
    assert.ok(ui.calls.some(call => call.action === 'runs/show' && call.payload.run_id === runA))
  } finally { ui.cleanup() }
})

test('从样本跳到固定轨迹并返回保留组件身份和草稿保护，重新抽取使用同一Run', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA } })
  try {
    await ui.settle(); ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-datasets').props.onClick(); ui.render()
    const dataset = ui.nodes().find(node => node.type?.name === 'DecisionDatasetView')
    assert.ok(dataset); dataset.props.onDirty(true); ui.render()
    dataset.props.onSource({ path: 'evidence/C-1/trace.jsonl', line: 141, source_sha256: 'trace-fixed' }); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-panel-files').props.hidden, false)
    const trace = ui.nodes().find(node => node.type?.name === 'RunTraceView')
    assert.equal(trace.props.focus.line, 141); assert.equal(trace.props.focus.source_sha256, 'trace-fixed')
    ui.button('返回样本复核（保留草稿）').props.onClick(); ui.render()
    const returned = ui.nodes().find(node => node.type?.name === 'DecisionDatasetView')
    assert.equal(returned.type, dataset.type); assert.equal(returned.key, dataset.key)
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-panel-datasets').props.hidden, false)
    assert.equal(ui.confirmations.length, 0)
    let prevented = false; for (const protect of ui.beforeUnload) protect({ preventDefault() { prevented = true }, returnValue: undefined }); assert.equal(prevented, true)
    returned.props.onReextract(); await ui.settle(); assert.equal(ui.assistants.at(-1).context.run_id, runA); assert.match(ui.assistants.at(-1).task, /extraction_contract/)
  } finally { ui.cleanup() }
})

test('评测中心把连续失效通知合并成一批刷新，隐藏时暂停并在恢复后补一次', async () => {
  const ui = workbench({ target: { page: 'evaluation' } })
  try {
    await ui.settle()
    const overviewCalls = () => ui.calls.filter(call => call.action === 'runs/overview').length
    const before = overviewCalls()
    for (let index = 0; index < 10; index++) ui.invalidate(['agents'])
    await ui.settle()
    assert.equal(overviewCalls() - before, 1, '连续通知只产生一次汇总读取')

    ui.setActive(false)
    const hidden = ui.calls.length
    for (let index = 0; index < 5; index++) ui.invalidate(['agents'])
    await ui.settle()
    assert.equal(ui.calls.length, hidden, '页面隐藏时不自动重读')
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)

    ui.setActive(true)
    await ui.settle()
    assert.equal(overviewCalls() - before, 2, '恢复可见时补一次刷新')
  } finally { ui.cleanup() }
})

test('评测页刷新单飞，在途时再次通知只在完成后补一次', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation' }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') await pending
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const before = ui.calls.filter(call => call.action === 'runs/overview').length
    ui.invalidate(['agents']); ui.render()
    ui.invalidate(['agents']); ui.render()
    await ui.settle()
    assert.equal(ui.calls.filter(call => call.action === 'runs/overview').length, before, '在途时不得叠加新的汇总读取')
    release()
    await ui.settle()
    assert.equal(ui.calls.filter(call => call.action === 'runs/overview').length - before, 1, '在途批次完成后补一次')
  } finally { ui.cleanup() }
})

test('Run 汇总读取失败保留上次列表并显示错误', async () => {
  let fail = false
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/overview' && fail) throw new Error('network: 暂时不可达')
    return original(action, payload)
  } })
  try {
    await ui.settle()
    assert.match(ui.text(), /共 2 条评测记录/)
    fail = true
    ui.invalidate(['agents']); await ui.settle()
    assert.match(ui.text(), /Run 列表读取失败：network: 暂时不可达/)
    assert.match(ui.text(), /共 2 条评测记录/, '读取失败不得清空上次看到的记录')
  } finally { ui.cleanup() }
})

test('刷新排队后隐藏时暂停，重新进入只补一次', async () => {
  const ui = workbench()
  try {
    await ui.settle()
    const count = () => ui.calls.filter(call => call.action === 'runs/overview').length
    const before = count()
    ui.invalidate(['agents']); ui.render()
    ui.setActive(false); await ui.settle()
    assert.equal(count(), before)
    ui.setActive(true); await ui.settle()
    assert.equal(count(), before + 1)
  } finally { ui.cleanup() }
})

test('坏记录保留带提示的旧行，其余记录更新，恢复后清除提示', async () => {
  let broken = false
  const ui = workbench({ handler: async (action, payload, original) => {
    const value = await original(action, payload)
    if (action !== 'runs/overview' || !broken) return value
    return { agents: value.agents.filter(agent => agent.agent_id !== 'alpha'), errors: [{ agent_id: 'alpha', experiment_id: expA, run_id: runA, path: 'run.yaml', error: '清单暂不可读' }] }
  } })
  try {
    await ui.settle(); broken = true
    ui.invalidate(['agents']); await ui.settle()
    assert.match(ui.text(), /共 2 条评测记录/)
    assert.match(ui.text(), /部分记录读取失败/)
    assert.match(ui.text(), /上次读取结果，当前记录暂不可读/)
    broken = false; ui.invalidate(['agents']); await ui.settle()
    assert.doesNotMatch(ui.text(), /当前记录暂不可读|部分记录读取失败/)
  } finally { ui.cleanup() }
})

test('三工作面与新建范围保持单一来源，切回快速评测不泄漏自选用例', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA } })
  try {
    await ui.settle()
    const navigation = ui.byLabel('评测工作区')
    assert.deepEqual(ui.nodes(navigation).filter(node => node.props?.role === 'tab').map(node => node.props.id), ['evaluation-tab-runs', 'evaluation-tab-cases', 'evaluation-tab-compare'])
    assert.equal(ui.byLabel('执行 C-2'), undefined, '用例库不维护运行范围')
    ui.button('新建评测').props.onClick(); ui.render()
    ui.button('自选用例').props.onClick(); ui.render()
    ui.byLabel('执行 C-2').props.onChange({ target: { checked: true } }); ui.render()
    await ui.button('执行预览').props.onClick(); await ui.settle()
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.filter(item => item.action === 'eval/preview').at(-1).payload.cases)), ['C-2'])
    ui.button('快速评测').props.onClick(); ui.render()
    await ui.button('执行预览').props.onClick(); await ui.settle()
    const preview = ui.calls.filter(item => item.action === 'eval/preview').at(-1).payload
    assert.equal(preview.mode, 'fast')
    assert.equal(preview.cases, undefined)
  } finally { ui.cleanup() }
})

test('新建评测以用户验证目标配置，界面冒烟自动关闭复核且保留业务评测草稿', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'cases', agent_id: 'alpha', experiment_id: expA } })
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render()
    assert.match(ui.text(ui.byLabel('验证目标')), /业务能力评测界面冒烟/)
    ui.change('证据复核', 'ai'); ui.button('自选用例').props.onClick(); ui.render(); ui.change('执行 C-2', true)
    ui.button('执行预览').props.onClick(); await ui.settle()
    let preview = ui.calls.filter(item => item.action === 'eval/preview').at(-1).payload
    assert.equal(preview.executor, 'api'); assert.equal(preview.review, 'ai')
    ui.change('验证目标', 'browser')
    assert.equal(ui.nodes().some(node => node.props?.className === 'harness-eval-preview'), false, '目标变化必须使旧预览失效')
    assert.equal(ui.byLabel('证据复核').props.disabled, true); assert.equal(ui.byLabel('证据复核').props.value, 'none')
    assert.match(ui.text(), /不生成业务能力通过结论/)
    ui.button('执行预览').props.onClick(); await ui.settle()
    preview = ui.calls.filter(item => item.action === 'eval/preview').at(-1).payload
    assert.equal(preview.executor, 'browser'); assert.equal(preview.review, 'none'); assert.deepEqual(Array.from(preview.cases), ['C-2'])
    ui.change('验证目标', 'api')
    assert.equal(ui.byLabel('证据复核').props.value, 'ai', '切回业务能力评测时恢复用户复核选择')
    assert.equal(ui.byLabel('执行 C-2').props.checked, true)
    ui.change('验证目标', 'browser'); ui.button('启动评测').props.onClick(); await ui.settle()
    const start = ui.calls.find(item => item.action === 'eval/start').payload
    assert.equal(start.executor, 'browser'); assert.equal(start.review, 'none')
    assert.deepEqual(Array.from(start.cases), ['C-2'])
  } finally { ui.cleanup() }
})


test('返回记录后修改筛选，再次点击记录标签不恢复先前的对象范围', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha' } })
  try {
    await ui.settle(); ui.idButton(runA).props.onClick({ stopPropagation() {} }); await ui.settle()
    ui.button('返回评测记录').props.onClick(); await ui.settle()
    ui.change('评测智能体', 'beta'); await ui.settle()
    ui.nodes(ui.byLabel('评测工作区')).find(node => node.props?.id === 'evaluation-tab-runs').props.onClick(); await ui.settle()
    assert.equal(ui.getTarget().agent_id, 'beta')
    assert.equal(ui.byLabel('评测智能体').props.value, 'beta')
  } finally { ui.cleanup() }
})


test('记录标题与计数不重复，Run 状态只在详情头部展示', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA } })
  try {
    await ui.settle()
    assert.equal(ui.nodes().filter(node => node.type === 'h2' && ui.text(node).startsWith('评测记录')).length, 0)
    assert.equal(ui.nodes().filter(node => node.type === 'span' && ui.text(node) === '共 2 条评测记录').length, 1)
    assert.equal(ui.nodes().some(node => node.props?.className === 'harness-eval-result-summary'), false)
    const technical = ui.nodes().find(node => node.type?.name === 'Facts' && node.props.items.some(([name]) => name === '机器结论'))
    assert.ok(technical)
    assert.equal(technical.props.items.some(([name]) => ['执行状态', '业务结论'].includes(name)), false)
    assert.ok(ui.button('下载完整 Run ZIP') || ui.nodes().some(node => node.type === 'a' && ui.text(node) === '下载完整 Run ZIP'))
  } finally { ui.cleanup() }
})

test('旧轨迹深链进入同一产物文件，结构化与原文共用路径和下载', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA, run_tab: 'trace' } })
  try {
    await ui.settle()
    assert.equal(ui.nodes().some(node => node.props?.id === 'evaluation-run-tab-trace'), false)
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-files').props['aria-selected'], true)
    const trace = ui.nodes().find(node => node.type?.name === 'RunTraceView')
    assert.equal(trace.props.path, `evolution/experiments/${expA}/runs/${runA}/evidence/C-1/trace.jsonl`)
    assert.equal(ui.getTarget().run_tab, 'files')
    const download = () => ui.nodes().find(node => node.type === 'a' && ui.text(node) === '下载完整文件')
    const href = download().props.href
    ui.button('原文').props.onClick(); ui.render()
    assert.match(ui.text(), /仅预览前 64 KiB/)
    assert.equal(download().props.href, href)
    ui.button('结构化查看').props.onClick(); ui.render()
    assert.equal(ui.nodes().find(node => node.type?.name === 'RunTraceView').props.path, trace.props.path)
    assert.equal(ui.calls.filter(call => call.action === 'runs/read-file').length, 1)
  } finally { ui.cleanup() }
})


test('评测模块工具行合并，Run 身份和原始资料共用受页签约束的抽屉', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA } })
  try {
    await ui.settle()
    const toolbar = ui.nodes().find(node => node.props?.className === 'harness-eval-toolbar')
    assert.ok(toolbar)
    assert.match(ui.text(toolbar), /评测记录测试用例结果比较新建评测/)
    const drawer = () => ui.nodes().find(node => node.type?.name === 'DetailDrawer' && node.props.title === '技术来源与 Run 信息')
    assert.equal(drawer().props.identity, `${runA}:report`)
    assert.equal(drawer().props.active, true)
    ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-files').props.onClick(); await ui.settle()
    assert.equal(drawer().props.identity, `${runA}:files`)
    ui.nodes().find(node => node.props?.id === 'evaluation-tab-compare').props.onClick(); ui.render()
    assert.equal(drawer().props.active, false)
    assert.equal(ui.nodes().some(node => node.type === 'details' && node.props.className === 'harness-eval-technical'), false)
  } finally { ui.cleanup() }
})


test('Run 延迟回执到达时已打开资料抽屉，消费自动定位而不抢走焦点', async () => {
  let release
  const delayed = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA }, handler: async (action, payload, original) => {
    if (action === 'runs/show') await delayed
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const events = [], heading = ui.nodes().find(node => node.type === 'h2' && node.ref)
    heading.ref.current = { scrollIntoView() { events.push('scroll') }, focus() { events.push('focus') } }
    assert.ok(ui.nodes().find(node => node.type?.name === 'DetailDrawer' && node.props.title === '技术来源与 Run 信息' && node.props.active))
    ui.setModalOpen(true)
    release(); await ui.settle()
    assert.deepEqual(events, [])
    ui.setModalOpen(false); ui.setActive(false); ui.setActive(true); await ui.settle()
    assert.deepEqual(events, [], '关闭抽屉或返回页面后不补发已消费的自动聚焦')
  } finally { ui.cleanup() }
})

test('双 Run 对照按共同语义轨道保留多轮输入、完整回答和缺失记录', async () => {
  const runC = 'run-33333333-3333-4333-8333-333333333333'
  const longAnswer = '完整回答应持续保留。'.repeat(500)
  const ui = workbench({ target: { page: 'evaluation', tab: 'compare' }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed' }, { run_id: runC, status: 'completed' }] }])
    if (action === 'runs/compare') return { left_run: runA, right_run: runC, left_only: [], right_only: [], limits: [], cases: [{ case_id: 'C-1', frozen_contract_same: false, observed_change: '记录有差异' }] }
    const value = await original(action, payload)
    if (action === 'runs/show') value.cases[0] = { ...value.cases[0], frozen: { title: '多轮对照', inputs: payload.run_id === runA ? ['第一轮完整输入', '第二轮完整输入'] : ['第一轮输入'], expected_behavior: '完整标准' }, output: payload.run_id === runA ? [longAnswer, '第二轮回答'] : ['短回答'], trials: payload.run_id === runA ? [{ execution_status: 'completed', verdict: 'passed', observation: '第一次完整观察' }, { execution_status: 'completed', verdict: 'failed', observation: '第二次完整观察', failure_reason: '保留失败原因' }] : [], evidence: [{ path: 'evidence/C-1/trace.jsonl', present: true }] }
    return value
  } })
  try {
    await ui.settle(); ui.change('左侧 Run', runA); ui.change('右侧 Run', runC); ui.button('开始比较').props.onClick(); await ui.settle()
    const cases = ui.nodes().filter(node => node.type?.name === 'RunCase')
    assert.equal(cases.length, 2)
    assert.deepEqual(JSON.parse(JSON.stringify(cases.map(node => node.props.paired))), [{ inputs: 2, outputs: 2, trials: 2 }, { inputs: 2, outputs: 2, trials: 2 }])
    const parts = cases.map(node => ui.nodes(node.type(node.props)).filter(part => part.props?.['data-case-part']))
    assert.deepEqual(parts[0].map(part => part.props['data-case-part']), parts[1].map(part => part.props['data-case-part']))
    const sides = ui.nodes().filter(node => node.props?.className === 'harness-eval-comparison-side')
    assert.equal(sides[0].props.style['--harness-case-rows'], parts[0].length + 2)
    assert.equal(sides[1].props.style['--harness-case-rows'], parts[1].length + 2)
    const answer = ui.nodes(parts[0]).find(node => node.type === ui.MarkdownText && node.props.text === longAnswer)
    assert.ok(answer, '长回答完整交给既有 Markdown 渲染器')
    assert.match(ui.text(parts[1]), /未记录第 2 轮冻结输入。.*未采集到第 2 轮回答。.*未记录第 2 次 Trial 结果。/s)
    assert.match(ui.text(parts[0]), /第二轮完整输入.*第二次完整观察.*保留失败原因/s)
    assert.ok(ui.nodes(parts[0]).find(node => node.type?.name === 'Raw' && node.props.value === cases[0].props.item))
  } finally { ui.cleanup() }
})

test('评测记录后台刷新保留已有列表，读取反馈位于刷新入口而不插入正文提示', async () => {
  let waiting = false, release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'runs/overview' && waiting) await pending
    return original(action, payload)
  } })
  try {
    await ui.settle()
    waiting = true
    ui.invalidate(['agents']); await ui.settle()
    const records = ui.nodes().find(node => node.props?.id === 'evaluation-record-list')
    assert.equal(records.props['aria-busy'], true)
    assert.match(ui.text(records), /共 2 条评测记录/)
    assert.ok(ui.nodes(ui.button('刷新')).some(node => node.props?.label === '读取评测记录与版本'))
    assert.doesNotMatch(ui.text(records), /正在读取|正在刷新/)
    release(); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-record-list').props['aria-busy'], false)
    assert.equal(ui.nodes(ui.button('刷新')).some(node => node.props?.label === '读取评测记录与版本'), false)
  } finally { release(); ui.cleanup() }
})

test('创建回执丢失后只查询原Run，明确新建才获得新的预留ID', async () => {
  let offline = true, starts = 0, accepted
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
    if (action === 'eval/start') { starts++; accepted = { run_id: payload.run_id, run_created: true, status: 'running' }; return accepted }
    if (action === 'eval/status' && accepted) return accepted
    return fallback(action, payload)
  } })
  const delegate = ui.rpc.call
  ui.rpc.call = async (...args) => { if (offline && args[1] === 'agents/eval/status') throw new Error('连接中断'); const value = await delegate(...args); if (offline && args[1] === 'agents/eval/start') throw new Error('回执丢失'); return value }
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    assert.match(ui.text(), /受理结果待核对/)
    const first = ui.calls.find(call => call.action === 'eval/start').payload.run_id
    assert.match(first, /^run-[0-9a-f-]{36}$/)
    offline = false; ui.button('核对原评测请求').props.onClick(); await ui.settle()
    assert.equal(starts, 1); assert.equal(ui.button('核对原评测请求'), undefined)
    ui.button('启动评测').props.onClick(); await ui.settle()
    assert.equal(starts, 2)
    assert.notEqual(ui.calls.filter(call => call.action === 'eval/start').at(-1).payload.run_id, first)
  } finally { ui.cleanup() }
})

test('重连只回读已创建Run，恢复时不抢占用户工作对象或重发start', async () => {
  let offline = true, accepted
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA } })
  const delegate = ui.rpc.call
  ui.rpc.call = async (...args) => {
    if (args[1] === 'agents/eval/start') { accepted = { run_id: args[2].run_id, run_created: true, status: 'running' }; throw new Error('回执丢失') }
    if (args[1] === 'agents/eval/status' && accepted) { if (offline) throw new Error('断连'); return { ok: true, value: accepted } }
    return delegate(...args)
  }
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    ui.change('评测智能体', ''); await ui.settle(); offline = false; ui.invalidate(['agents']); await ui.settle()
    assert.equal(ui.button('核对原评测请求'), undefined)
    assert.equal(ui.getTarget().run_id, undefined)
    assert.equal(ui.calls.filter(call => call.action === 'eval/start').length, 0, '唯一启动由传输夹具捕获，恢复没有发送第二次')
  } finally { ui.cleanup() }
})

test('未受理请求查询not_found后清pending，旧恢复按钮绝不重发start', async () => {
  let connected = false, starts = 0
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA } })
  const delegate = ui.rpc.call
  ui.rpc.call = async (...args) => {
    if (args[1] === 'agents/eval/start') { starts++; throw new Error('请求未送达') }
    if (args[1] === 'agents/eval/status') { if (!connected) throw new Error('断连'); return { ok: false, error: { code: 'not_found', message: '没有该Run' } } }
    return delegate(...args)
  }
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    const old = ui.button('核对原评测请求'); assert.ok(old)
    ui.change('评测智能体', ''); await ui.settle(); connected = true
    old.props.onClick(); await ui.settle()
    assert.match(ui.text(), /未找到可继续的运行记录.*重新预览/s)
    assert.equal(ui.button('核对原评测请求'), undefined)
    old.props.onClick(); await ui.settle(); assert.equal(starts, 1)
    assert.equal(ui.byLabel('评测智能体').props.value, '')
  } finally { ui.cleanup() }
})

test('待核对Run发送前按工作区保存，刷新只恢复原Run且其他数据根不消费暂存', async () => {
  const storage = new Map(); let id
  const first = workbench({ storage, target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA } })
  const delegate = first.rpc.call
  first.rpc.call = async (...args) => {
    if (args[1] === 'agents/eval/start') { id = args[2].run_id; const saved = [...storage.entries()].find(([key]) => key.startsWith('harness-evaluation-pending:v2:')); assert.equal(JSON.parse(saved[1]).run_id, id); assert.equal(JSON.parse(saved[1]).previousRunId, ''); throw new Error('回执丢失') }
    if (args[1] === 'agents/eval/status') throw new Error('断连')
    return delegate(...args)
  }
  await first.settle(); first.button('新建评测').props.onClick(); first.render(); first.button('启动评测').props.onClick(); await first.settle(); first.cleanup()
  const other = workbench({ storage, handler(action, payload, fallback) { if (action === 'list') return { root: '/other-assets', agents: [{ id: 'alpha' }] }; return fallback(action, payload) } })
  try { await other.settle(); assert.equal(other.button('核对原评测请求'), undefined); assert.equal(other.calls.some(call => call.action === 'eval/start'), false); assert.ok(storage.size) } finally { other.cleanup() }
  const second = workbench({ storage, handler(action, payload, fallback) { if (action === 'eval/status') return { run_id: id, run_created: true, status: 'running', source: `experiment:${expA}` }; return fallback(action, payload) } })
  try {
    await second.settle(); assert.ok(second.calls.some(call => call.action === 'eval/status' && call.payload.run_id === id))
    assert.equal(second.calls.some(call => ['eval/start', 'eval/preview'].includes(call.action)), false)
    assert.equal(second.button('核对原评测请求'), undefined); assert.equal(storage.size, 0)
  } finally { second.cleanup() }
})

test('浏览器暂存不可用时未知请求仍保留内存身份并阻止无提示刷新', async () => {
  const storage = { get() { return undefined }, set() { throw new Error('storage disabled') }, delete() {} }
  const ui = workbench({ storage, target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA } })
  const delegate = ui.rpc.call
  ui.rpc.call = async (...args) => {
    if (['agents/eval/start', 'agents/eval/status'].includes(args[1])) throw new Error('断连')
    return delegate(...args)
  }
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    for (const protect of ui.beforeUnload) protect(event)
    assert.equal(event.prevented, true)
    assert.ok(ui.button('核对原评测请求'))
  } finally { ui.cleanup() }
})

test('旧版pending只按旧Job身份查询，清理后的not_found不重新预览或启动', async () => {
  const key = 'harness-evaluation-pending:http://localhost:3090/hep/'
  const storage = new Map([[key, JSON.stringify({ request_id: '550e8400-e29b-41d4-a716-446655440000', payload: { source: `experiment:${expA}` }, agentId: 'alpha', experimentId: expA, runId: '', tab: 'runs' })]])
  const ui = workbench({ storage, handler(action, payload, fallback) { if (action === 'eval/status') throw new Error('not_found: 旧创建记录已清理'); return fallback(action, payload) } })
  try {
    await ui.settle(); assert.ok(ui.calls.some(call => call.action === 'eval/status' && call.payload.job_id === '550e8400-e29b-41d4-a716-446655440000'))
    assert.equal(ui.calls.some(call => ['eval/start', 'eval/preview'].includes(call.action)), false)
    assert.equal(storage.has(key), false)
    assert.match(ui.text(), /未找到可继续的运行记录.*重新预览/s)
  } finally { ui.cleanup() }
})

test('首次Decision不存在时正文可编辑并以null创建，读到空文件仍使用其摘要', async () => {
  for (const hash of [null, 'empty-file-sha256']) {
    const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA, run_id: runA }, handler: async (action, payload, original) => {
      if (action === 'detail') return { ...await original(action, payload), decision: { exists: hash !== null, content: '', sha256: hash } }
      return original(action, payload)
    } })
    try {
      await ui.settle(); ui.button('记录研究决策').props.onClick(); await ui.settle()
      assert.equal(ui.byLabel('Decision 正文').props.disabled, false)
      ui.change('Decision 正文', '# Decision\n\n尚未完成业务评测，结论 inconclusive。')
      assert.equal(ui.button('保存研究决策').props.disabled, false)
      ui.button('保存研究决策').props.onClick(); await ui.settle()
      assert.equal(ui.calls.find(call => call.action === 'decision/update').payload.expected_sha256, hash)
      assert.match(ui.text(), /研究决策已保存/)
    } finally { ui.cleanup() }
  }
})

test('评测记录按确认顺序拆列，完整版本和历史变体身份来自同一次资产读取', async () => {
  const normal = 'EXP-alpha-027-r123456abcdef'
  const variant = 'VAR-alpha-003-rabcdef123456'
  const legacy = 'EXP-alpha-019-r789abc123456'
  const unknown = 'EXP-alpha-005-r999999999999'
  const runIds = [runA, runB, 'run-33333333-3333-4333-8333-333333333333', 'run-44444444-4444-4444-8444-444444444444']
  const ui = workbench({ handler(action, payload, fallback) {
    if (action === 'list') return { agents: [{ id: 'alpha', name: '候选名称', manifest: { name: '安全运营专家' } }],
      experiments: [{ id: normal, agent_id: 'alpha', is_variant: false, change: {} }, { id: variant, agent_id: 'alpha', change: { variant_name: '不应显示的变体名称' } }],
      historical_experiments: [{ id: legacy, agent_id: 'alpha', change: { kind: 'end' } }] }
    if (action === 'runs/overview') return overview([['alpha', [normal, variant, legacy, unknown].map((id, index) => ({ experiment_id: id,
      runs: [{ run_id: runIds[index], title: '日常巡检', status: 'completed', effective_verdict: 'passed', created_at: `2026-11-04T0${9 - index}:00:00Z` }] }))]])
    return fallback(action, payload)
  } })
  try {
    await ui.settle()
    const table = ui.byLabel('评测记录列表')
    assert.deepEqual(ui.nodes(table).filter(node => node.type === 'th').map(node => ui.text(node)), ['评测名称', '所属智能体', '被测版本', '对象类型', '执行状态', '评测结论', '用例结果', '时间', '操作'])
    const rows = ui.nodes(table).filter(node => node.type === 'tr').slice(1)
    const cell = (row, name) => ui.nodes(row).find(node => node.type === 'td' && node.props['data-label'] === name)
    assert.deepEqual(rows.map(row => ui.text(cell(row, '对象类型'))), ['智能体', '变体', '变体', '待核对'])
    assert.deepEqual(rows.map(row => ui.text(cell(row, '被测版本'))), ['v027-r123456abcdef', 'v003-rabcdef123456', 'v019-r789abc123456', 'v005-r999999999999'])
    assert.ok(rows.every(row => ui.text(cell(row, '所属智能体')) === '安全运营专家'))
    assert.doesNotMatch(ui.text(table), /候选名称|不应显示的变体名称/)
    assert.equal(ui.calls.filter(call => call.action === 'list').length, 1)
    assert.equal(ui.calls.filter(call => call.action === 'detail').length, 0, '不逐行读取详情')
    ui.idButton(runB).props.onClick({ stopPropagation() {} }); await ui.settle()
    assert.equal(ui.getTarget().run_id, runB, '拆列不改变原始 Run 跳转')
  } finally { ui.cleanup() }
})

test('对象类型筛选一致作用于事实与控制合并后的真实Run，不改变对象或请求', async () => {
  const normal = 'EXP-alpha-027-r123456abcdef', variant = 'VAR-alpha-003-rabcdef123456', legacy = 'EXP-alpha-019-r789abc123456'
  const extra = 'run-55555555-5555-4555-8555-555555555555'
  const ui = workbench({ handler(action, payload, fallback) {
    if (action === 'list') return { root: '/test-assets', agents: [{ id: 'alpha' }], experiments: [{ id: normal, change: {} }, { id: variant, change: {} }], historical_experiments: [{ id: legacy, change: { compute_variant: {} } }] }
    if (action === 'runs/overview') return overview([['alpha', [normal, variant, legacy].map((id, index) => ({ experiment_id: id, runs: [{ run_id: index ? `run-${index}` : runA, title: `记录${index}`, status: 'completed', effective_verdict: 'passed' }] }))]])
    if (action === 'eval/list') return { runs: [{ run_id: extra, run_created: true, source: `experiment:${variant}`, agent_id: 'alpha', experiment_id: variant, status: 'running' }], errors: [] }
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); const rows = () => ui.nodes(ui.byLabel('评测记录列表')).filter(node => node.type === 'tr').slice(1)
    const beforeCalls = ui.calls.length, beforeNavigation = ui.navigations.length
    assert.equal(rows().length, 4)
    ui.change('筛选对象类型', '智能体'); await ui.settle(); assert.equal(rows().length, 1); assert.ok(ui.idButton(runA))
    ui.change('筛选对象类型', '变体'); await ui.settle(); assert.equal(rows().length, 3); assert.ok(ui.idButton(extra))
    ui.change('筛选对象类型', ''); await ui.settle(); assert.equal(rows().length, 4)
    assert.equal(ui.calls.length, beforeCalls); assert.equal(ui.navigations.length, beforeNavigation)
  } finally { ui.cleanup() }
})

test('记录表首列完整展示唯一Run ID，不再出现第二个任务ID且保持原始导航', async () => {
  const ui = workbench()
  try {
    await ui.settle()
    const table = ui.byLabel('评测记录列表')
    const firstCell = ui.nodes(table).find(node => node.type === 'td' && node.props['data-label'] === '评测名称' && ui.nodes(node).some(child => child.props?.title === runA))
    const id = ui.nodes(firstCell).find(node => node.props?.className === 'harness-eval-run-id')
    assert.equal(ui.text(id), `Run ID：${runA}`)
    assert.equal(ui.text(ui.nodes(firstCell).find(node => node.props?.className === 'harness-eval-case-meta')), '用例范围未知')
    assert.doesNotMatch(ui.text(table), /任务 ID：|历史任务|当前任务|进行中任务|…|\.\.\./)
    ui.idButton(runA).props.onClick({ stopPropagation() {} }); await ui.settle()
    assert.equal(ui.getTarget().run_id, runA); assert.equal(ui.getTarget().job_id, undefined)
    assert.equal(ui.calls.find(call => call.action === 'runs/show').payload.run_id, runA)
  } finally { ui.cleanup() }
})

test('记录时间分开始与结束两行，未结束和旧记录缺失时间分别说明', async () => {
  for (const entry of [
    { status: 'completed', created_at: '2026-11-04T08:00:00Z', finished_at: '2026-11-04T08:01:00Z' },
    { status: 'running', created_at: '2026-11-04T08:00:00Z', endLabel: '结束：尚未结束' },
    { status: 'failed', created_at: '2026-11-04T08:00:00Z', endLabel: '结束：未记录' },
    { status: 'unknown', endLabel: '结束：未记录' },
  ]) {
    const ui = workbench({ handler: async (action, payload, original) => action === 'runs/overview'
      ? overview([['alpha', [{ experiment_id: expA, runs: [{ run_id: runA, ...entry }] }]]]) : original(action, payload) })
    try {
      await ui.settle()
      const row = ui.nodes(ui.byLabel('评测记录列表')).find(node => node.type === 'tr' && ui.nodes(node).some(child => child.props?.title === runA))
      const cell = ui.nodes(row).find(node => node.type === 'td' && node.props['data-label'] === '时间')
      const lines = ui.nodes(cell).filter(node => node.props?.className === 'harness-eval-timestamp')
      assert.equal(lines.length, 2)
      assert.equal(ui.nodes(lines[0]).find(node => node.type === 'time').props.dateTime, entry.created_at)
      assert.match(ui.text(lines[0]), entry.created_at ? /^开始：/ : /^开始：未记录$/)
      if (entry.finished_at) {
        assert.equal(ui.nodes(lines[1]).find(node => node.type === 'time').props.dateTime, entry.finished_at)
        assert.match(ui.text(lines[1]), /^结束：/)
      } else {
        assert.equal(ui.text(lines[1]), entry.endLabel)
        assert.equal(ui.nodes(lines[1]).some(node => node.type === 'time'), false)
      }
    } finally { ui.cleanup() }
  }
})

test('预览只预留Run，关闭或修改参数撤销预留，再启动使用新ID', async () => {
  for (const operation of ['close', 'change']) {
    const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA } })
    try {
      await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('执行预览').props.onClick(); await ui.settle()
      assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
      if (operation === 'close') { ui.button('关闭').props.onClick(); await ui.settle(); ui.button('新建评测').props.onClick(); ui.render() }
      else { ui.change('验证目标', 'browser'); await ui.settle() }
      assert.equal(ui.calls.find(call => call.action === 'eval/cancel').payload.run_id, runA)
      ui.button('启动评测').props.onClick(); await ui.settle()
      assert.notEqual(ui.calls.find(call => call.action === 'eval/start').payload.run_id, runA)
    } finally { ui.cleanup() }
  }
})

test('准备前断线恢复到prepared时只读取，用户明确撤销后才能重新预览', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA } })
  const delegate = ui.rpc.call
  ui.rpc.call = async (...args) => {
    if (args[1] === 'agents/eval/start') throw new Error('未送达')
    if (args[1] === 'agents/eval/status') return { ok: true, value: { run_id: runA, run_created: false, status: 'prepared' } }
    return delegate(...args)
  }
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    assert.match(ui.text(), /尚未启动/)
    assert.equal(ui.calls.some(call => call.action === 'eval/cancel'), false, '只读恢复不能自动撤销或重发')
    assert.ok(ui.button('撤销预留')); ui.button('撤销预留').props.onClick(); await ui.settle()
    assert.equal(ui.calls.filter(call => call.action === 'eval/cancel').length, 1)
    assert.equal(ui.button('核对原评测请求'), undefined)
    assert.match(ui.text(), /预留或创建已取消.*重新预览/)
  } finally { ui.cleanup() }
})

test('Run创建失败直接在发起处显示原因并清暂存，不把预留ID放进表格', async () => {
  const storage = new Map(), created = 'run-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const ui = workbench({ storage, target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
    if (action === 'eval/preview') return { run_id: created, result: { case_ids: ['C-1'] } }
    if (action === 'eval/start') throw new Error('creation_failed: 冻结输入失败，创建数据已清理')
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    assert.match(ui.text(), /冻结输入失败.*重新预览/s)
    assert.equal(ui.idButton(created), undefined); assert.equal(storage.size, 0)
    assert.equal(ui.button('核对原评测请求'), undefined)
    assert.equal(ui.getTarget().run_id, undefined)
  } finally { ui.cleanup() }
})

test('预览回执迟到时页面已隐藏，撤销该预留且不启动Run', async () => {
  let resolvePreview
  const preview = new Promise(resolve => { resolvePreview = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
    if (action === 'eval/preview') return preview
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('执行预览').props.onClick(); await ui.settle()
    ui.setActive(false); resolvePreview({ run_id: runA, result: { case_ids: ['C-1'] } }); await ui.settle()
    assert.equal(ui.calls.find(call => call.action === 'eval/cancel').payload.run_id, runA)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
  } finally { resolvePreview?.({ run_id: runA }); ui.cleanup() }
})

test('旧在途无Run只在原入口观察取消，出现真实关联后才转换为Run导航', async () => {
  let state = 'running', committed = false
  const id = '550e8400-e29b-41d4-a716-446655440000'
  const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: id }, handler(action, payload, fallback) {
    if (action === 'eval/status' && payload.job_id) return { run_id: committed ? runA : null, legacy_id: id, run_created: committed, status: state }
    if (action === 'eval/cancel') { state = 'cancelling'; return { run_id: null, legacy_id: id, run_created: false, status: state } }
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); assert.match(ui.text(ui.byLabel('评测进度')), /旧评测尚未形成运行记录/)
    assert.doesNotMatch(ui.text(ui.byLabel('评测记录列表')), new RegExp(id))
    ui.button('取消评测').props.onClick(); ui.render(); ui.button('确认取消').props.onClick(); await ui.settle()
    assert.deepEqual({ ...ui.calls.find(call => call.action === 'eval/cancel').payload }, { job_id: id })
    committed = true; state = 'cancelled'; ui.button('刷新状态').props.onClick(); await ui.settle()
    assert.equal(ui.getTarget().run_id, runA); assert.equal(ui.getTarget().job_id, undefined)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
    assert.equal(ui.calls.some(call => call.payload.run_id === `run-${id}`), false)
  } finally { ui.cleanup() }
})

test('清理或观察未确认的明确回执仍保留pending，只查询原Run不重新启动', async () => {
  for (const code of ['observation_unknown', 'cleanup_failed', 'run_read_failed', 'conflict']) {
    const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
      if (action === 'eval/start') throw new Error(`${code}: 原运行现场待核对`)
      if (action === 'eval/status') return { run_id: runA, run_created: false, status: 'unknown' }
      return fallback(action, payload)
    } })
    try {
      await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
      assert.ok(ui.button('核对原评测请求'))
      ui.button('核对原评测请求').props.onClick(); await ui.settle()
      assert.equal(ui.calls.filter(call => call.action === 'eval/start').length, 1)
      assert.ok(ui.calls.filter(call => call.action === 'eval/status').every(call => call.payload.run_id === runA))
    } finally { ui.cleanup() }
  }
})

test('等待Run初始化提交时可取消同一Run，创建取消不进入记录表', async () => {
  let rejectStart, submitted
  const waiting = new Promise((_resolve, reject) => { rejectStart = reject })
  const created = 'run-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler(action, payload, fallback) {
    if (action === 'eval/preview') return { run_id: created, result: { case_ids: ['C-1'] } }
    if (action === 'eval/start') { submitted = payload.run_id; return waiting }
    if (action === 'eval/cancel') { rejectStart(new Error('creation_cancelled: Run创建已取消并清理')); return { run_id: created, run_created: false, status: 'cancelled' } }
    return fallback(action, payload)
  } })
  try {
    await ui.settle(); ui.button('新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    assert.equal(submitted, created); assert.match(ui.text(), /正在准备运行记录/)
    ui.button('取消此次评测').props.onClick(); await ui.settle()
    assert.equal(ui.calls.find(call => call.action === 'eval/cancel').payload.run_id, created)
    assert.equal(ui.idButton(created), undefined)
    assert.match(ui.text(), /创建已取消.*重新预览/s)
  } finally { rejectStart?.(new Error('creation_cancelled: 测试收尾')); ui.cleanup() }
})
