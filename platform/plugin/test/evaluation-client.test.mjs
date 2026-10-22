import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/evaluation/client.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
const runA = 'run-11111111-1111-4111-8111-111111111111'
const runB = 'run-22222222-2222-4222-8222-222222222222'
const expA = 'EXP-alpha-001'
const doc = { case: { id: 'C-1', title: '测试一', inputs: ['第一轮'], expected_behavior: '正确回答', scene: '场景一', tier: 'fast' }, sha256: 'case-v1', path: 'agents/alpha/evaluation.md' }
const detail = { experiment: { id: expA }, versions: [{ id: expA }], evaluation: { path: doc.path, sha256: doc.sha256, cases: [{ id: 'C-1', title: '测试一', scene: '场景一', tier: 'fast', input_preview: '第一轮' }, { id: 'C-2', title: '测试二', scene: '场景二', tier: 'full', input_preview: '第二轮' }] }, decision: { content: '# Decision\ncontinue', sha256: 'decision-v1' } }
const overview = entries => ({ agents: entries.map(([agentId, experiments]) => ({ agent_id: agentId, experiments })) })
const betaRun = { experiment_id: 'EXP-beta-001', runs: [{ run_id: runB, status: 'completed', created_at: '2026-10-15T09:00:00Z' }] }
const alphaOverview = experiments => overview([['alpha', experiments], ['beta', [betaRun]]])
function workbench({ target, handler, onAssistant } = {}) {
  const states = [], dependencies = [], cleanups = []
  let cursor, effects, changed, tree, failSave = false, loadedDoc = structuredClone(doc), decisionContent = detail.decision.content
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
  const window = { confirm: message => { confirmations.push(message); return confirmationAnswers.shift() ?? true }, addEventListener: (name, listener) => { if (name === 'beforeunload') beforeUnload.add(listener) }, removeEventListener: (name, listener) => beforeUnload.delete(listener), setInterval: () => 1, clearInterval: () => undefined, setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => { timers.delete(id) } }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText, MarkdownDelegateProvider } : require(name), window, document: { baseURI: 'http://localhost:3090/hep/', getElementById: () => ({ focus() {} }) }, URL })
  const { EvaluationPage } = module.exports
  const defaultHandler = async (action, payload) => {
    if (action === 'list') return { agents: [{ id: 'alpha' }, { id: 'beta' }] }
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
    if (action === 'eval/preview') return { result: { mode: payload.mode, case_ids: payload.cases ?? ['C-1'], executor: payload.executor } }
    if (action === 'eval/list') return { jobs: [] }
    if (action === 'eval/start') return { job_id: 'job-1', status: 'running' }
    if (action === 'eval/status') return { job_id: 'job-1', status: 'completed', result: { run_id: runA } }
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
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.map(text).join(''); return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '') }
  const button = title => nodes().find(node => node.type === 'button' && text(node) === title)
  const idButton = id => nodes().find(node => node.type === 'button' && node.props.title === id)
  const byLabel = title => nodes().find(node => node.props?.['aria-label'] === title)
  function change(title, value) { const element = byLabel(title); assert.ok(element, `缺少控件 ${title}`); element.props.onChange({ target: { value, checked: value } }); render() }
  render()
  return { render, settle, nodes, text, button, idButton, byLabel, change, invalidate: updates.invalidate, calls, navigations, contexts, assistants, MarkdownText, beforeUnload, confirmations, confirmationAnswers, setFailSave: value => { failSave = value }, setTarget(value) { props.target = value; render() }, setActive(value) { props.active = value; render() }, getTarget() { return props.target }, cleanup() { cleanups.forEach(cleanup => cleanup?.()); timers.clear() } }
}

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

test('无深链时默认选中最新已保存 Run，选中身份进入 URL 与结果视图', async () => {
  const ui = workbench({ target: { page: 'evaluation' }, handler: async (action, payload, original) => {
    if (action === 'runs/overview') return overview([['alpha', [{ experiment_id: expA, runs: [{ run_id: runA, status: 'completed', created_at: '2026-10-15T08:00:00Z' }] }]], ['beta', [betaRun]]])
    return original(action, payload)
  } })
  try {
    await ui.settle()
    assert.equal(ui.getTarget().run_id, runB)
    assert.equal(ui.getTarget().replace, true)
    assert.equal(ui.calls.filter(call => call.action === 'runs/show').at(-1)?.payload.run_id, runB)
    const row = ui.nodes().find(node => node.type === 'tr' && node.props?.['data-selected'] === true)
    assert.ok(ui.nodes(row).some(node => node.type === 'button' && node.props.title === runB))
    assert.match(ui.text(), /业务结论/)
  } finally { ui.cleanup() }
})

test('只有 Job 或 Run 索引读取失败时不伪造默认 Run', async () => {
  for (const failed of [false, true]) {
    const ui = workbench({ target: { page: 'evaluation' }, handler: async (action, payload, original) => {
      if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
      if (action === 'runs/overview') { if (failed) throw new Error('network: 暂时不可达'); return { agents: [] } }
      return original(action, payload)
    } })
    try {
      await ui.settle()
      assert.equal(ui.getTarget()?.run_id, undefined)
      assert.equal(ui.calls.some(call => call.action === 'runs/show'), false)
      assert.match(ui.text(), failed ? /暂时无法读取已保存的评测结果/ : /当前没有已保存的 Run。可打开上方评测任务核对进展/)
      assert.match(ui.text(), /查看任务/)
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

test('Run 五个子视图随路由恢复，浏览器往返保持 Run 且 Case 深链优先', async () => {
  const target = { page: 'evaluation', tab: 'runs', run_id: runA }
  const ui = workbench({ target })
  try {
    await ui.settle()
    for (const [label, run_tab] of [['逐例结果', 'results'], ['执行轨迹', 'trace'], ['产物文件', 'files'], ['决策样本', 'datasets']]) {
      ui.button(label).props.onClick(); await ui.settle()
      assert.equal(ui.getTarget().run_id, runA)
      assert.equal(ui.getTarget().run_tab, run_tab)
      assert.equal(ui.nodes().find(node => node.props?.id === `evaluation-run-tab-${run_tab}`).props['aria-selected'], true)
    }
    ui.setTarget({ ...target, run_tab: 'trace' }); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-trace').props['aria-selected'], true)
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
    const listHeading = ui.nodes().find(node => node.type === 'h2' && ui.text(node).startsWith('评测记录 '))
    listHeading.ref.current = { scrollIntoView: options => listEvents.push(`scroll:${options.block}`), focus: () => listEvents.push('focus') }
    ui.button('返回评测记录').props.onClick()
    assert.deepEqual(listEvents, ['scroll:center', 'focus'])
    assert.equal(ui.getTarget().job_id, 'job-2')
  } finally { ui.cleanup() }
})

test('刷新与新标签页按 job_id 恢复原任务，不调用 eval/start，用户主动查看才跳到 Run', async () => {
  const target = { page: 'evaluation', tab: 'jobs', job_id: 'job-1', agent_id: 'alpha', experiment_id: expA }
  const handler = async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
    if (action === 'eval/status') return { job_id: payload.job_id, source: `experiment:${expA}`, status: 'completed', result: { run_id: runA } }
    return original(action, payload)
  }
  for (let reopen = 0; reopen < 2; reopen++) {
    const ui = workbench({ target, handler })
    try {
      await ui.settle()
      assert.equal(ui.calls.filter(call => call.action === 'eval/start').length, 0)
      assert.ok(ui.calls.some(call => call.action === 'eval/status' && call.payload.job_id === 'job-1'))
      assert.match(ui.text(), /评测任务 · 已结束/)
      assert.equal(ui.getTarget().run_id, undefined)
      ui.button('查看本次报告').props.onClick()
      await ui.settle()
      assert.equal(ui.getTarget().run_id, runA)
      assert.equal(ui.getTarget().job_id, 'job-1')
    } finally { ui.cleanup() }
  }
})

test('从 Run 页主动选择无 Run ID 的 Job 时，立即返回的状态不抢走任务标签', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
    if (action === 'eval/status') return { job_id: payload.job_id, source: `experiment:${expA}`, status: 'completed', result: { run_id: runA } }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const records = ui.nodes().find(node => node.type === 'table' && node.props['aria-label'] === '评测记录列表')
    assert.ok(records)
    assert.ok(ui.nodes().indexOf(records) < ui.nodes().indexOf(ui.byLabel('评测工作区')), '统一记录应先于详情标签呈现')
    assert.match(ui.text(records), /当前任务.*运行中.*尚无可核对结论.*查看任务/)
    assert.match(ui.text(records), /Run · .*查看结果/)
    ui.idButton('job-1').props.onClick({ stopPropagation() {} })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ui.navigations.at(-1).tab, 'jobs')
    assert.equal(ui.navigations.at(-1).run_id, undefined)
    await ui.settle()
    assert.equal(ui.getTarget().tab, 'jobs')
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
  } finally { ui.cleanup() }
})

test('统一记录对已有 Run 的任务去重，未形成 Run 的最终任务仍可核对', async () => {
  const ui = workbench({ handler: async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [
      { job_id: 'job-with-run', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'completed', run_id: runA, started_at: '2026-10-15T08:00:00Z' },
      { job_id: 'job-without-run', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'failed', started_at: '2026-10-15T09:00:00Z' },
    ] }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const records = ui.nodes().find(node => node.type === 'table' && node.props['aria-label'] === '评测记录列表')
    assert.ok(records)
    assert.equal(ui.nodes(records).some(node => node.type === 'button' && node.props.title === 'job-with-run'), false)
    assert.equal(ui.nodes(records).some(node => node.type === 'button' && node.props.title === 'job-without-run'), true)
    assert.match(ui.text(records), /历史任务.*执行错误.*尚无可核对结论.*未生成可核对的 Run/)
    assert.match(ui.text(records), /Run · .*查看结果/)
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
    const title = ui.nodes().find(node => node.type === 'h2' && ui.text(node).startsWith('评测记录 '))
    assert.ok(title?.ref)
    const events = []
    title.ref.current = { scrollIntoView: options => events.push(`scroll:${options.block}`), focus: () => events.push('focus') }
    ui.button('返回运行列表').props.onClick()
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

test('Job 失效保留原 ID 和重试入口，不静默选到其他任务', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'job-missing' }, handler: async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [{ job_id: 'job-other', source: `experiment:${expA}`, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
    if (action === 'eval/status') throw new Error('not_found: 评测任务不存在')
    return original(action, payload)
  } })
  try {
    await ui.settle()
    assert.match(ui.text(), /未能连接任务 job-missing/)
    assert.equal(ui.getTarget().job_id, 'job-missing')
    assert.equal(ui.button('刷新状态').props.disabled, undefined)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
  } finally { ui.cleanup() }
})

test('未主动选择任务时仍显示真实运行中 Job，并从同一任务进入执行过程', async () => {
  const ui = workbench({ handler: async (action, payload, original) => action === 'eval/list'
    ? { jobs: [{ job_id: 'job-active', agent_id: 'alpha', experiment_id: expA, source: `experiment:${expA}`, status: 'running', started_at: '2026-10-20T08:00:00Z' }] }
    : action === 'eval/status' ? { job_id: payload.job_id, status: 'running', agent_id: 'alpha', experiment_id: expA }
      : original(action, payload) })
  try {
    await ui.settle()
    const banner = ui.byLabel('当前评测任务')
    assert.match(ui.text(banner), /alpha v001.*运行中/)
    assert.equal(ui.calls.some(call => call.action === 'eval/start'), false)
    ui.button('查看执行过程').props.onClick()
    await ui.settle()
    assert.equal(ui.getTarget().job_id, 'job-active')
    assert.ok(ui.calls.some(call => call.action === 'eval/status' && call.payload.job_id === 'job-active'))
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
    assert.match(ui.text(ui.byLabel('Run 详情')), /业务结论未通过/)
    assert.match(ui.text(ui.byLabel('用例观察分布')), /共 4 个选定用例/)
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
      assert.equal(row.props.children[3].props.children.props['data-state'], 'unknown')
    }
    assert.match(ui.text(rows.find(node => ui.nodes(node).some(child => child.type === 'button' && child.props.title === runB))), /1 通过 \/ 0 未通过 \/ 0 无法判定 \/ 1 待核对.*部分记录，非最终结论/)
    assert.match(ui.text(rows.find(node => ui.nodes(node).some(child => child.type === 'button' && child.props.title === runA))), /通过/)
    ui.idButton(runB).props.onClick({ stopPropagation() {} }); await ui.settle()
    const detailFacts = ui.nodes().find(node => node.type?.name === 'Facts' && node.props.items.some(([name]) => name === '业务结论'))
    assert.equal(detailFacts.props.items.find(([name]) => name === '业务结论')[1], '尚无结论')
    assert.equal(detailFacts.props.items.find(([name]) => name === '机器结论')[1], '未记录')
    assert.match(ui.text(), /仅是已采集的部分证据/)
    assert.equal(ui.nodes().find(node => node.type?.name === 'RunCase')?.props.item.trials[0].verdict, 'passed', '逐例证据仍可查看')
    ui.nodes().find(node => node.props?.id === 'evaluation-tab-compare').props.onClick(); await ui.settle()
    ui.change('左侧 Run', runB); ui.change('右侧 Run', runA)
    ui.button('开始比较').props.onClick(); await ui.settle()
    const comparisonFacts = ui.nodes().filter(node => node.type?.name === 'Facts' && node.props.items.some(([name]) => name === '结论'))
    assert.deepEqual(comparisonFacts.map(node => node.props.items.find(([name]) => name === '结论')[1]), ['尚无结论', '通过'])
  } finally { ui.cleanup() }
})

test('Job 的部分通过摘要仅在 Job 与 Run 都完成后展示整体结论', async () => {
  for (const status of ['running', 'failed', 'cancelled', 'completed']) {
    const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'job-1', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => {
      if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status, started_at: '2026-10-15T08:00:00Z' }] }
      if (action === 'eval/status') return { job_id: 'job-1', source: `experiment:${expA}`, status, result: { run_id: runA, run_status: status }, summary: { effective_verdict: 'passed' } }
      return original(action, payload)
    } })
    try {
      await ui.settle()
      assert.equal(ui.text().includes('业务结论：通过'), status === 'completed', status)
      assert.ok(ui.button('查看本次报告'), '部分 Run 仍可打开查证据')
    } finally { ui.cleanup() }
  }
})

test('取消评测先核对任务身份，确认后进入取消中且快速双击只发送一次请求', async () => {
  let finishCancel
  const pendingCancel = new Promise(resolve => { finishCancel = resolve })
  let cancelled = false
  const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'job-1', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
    if (action === 'eval/status') return { job_id: 'job-1', status: cancelled ? 'cancelled' : 'running' }
    if (action === 'eval/cancel') return pendingCancel
    return original(action, payload)
  } })
  try {
    await ui.settle()
    const cancel = ui.button('取消评测')
    cancel.props.onClick(); cancel.props.onClick()
    ui.render()
    assert.equal(ui.calls.filter(call => call.action === 'eval/cancel').length, 0)
    assert.equal(ui.nodes().find(node => node.type === 'dialog' && node.props.className === 'harness-eval-confirm-dialog')?.props['aria-labelledby'], 'evaluation-cancel-title')
    assert.match(ui.text(), /目标评测：alpha v001.*查看任务 IDjob-1/)
    const confirm = ui.button('确认取消')
    confirm.props.onClick(); confirm.props.onClick()
    ui.render()
    assert.equal(ui.calls.filter(call => call.action === 'eval/cancel').length, 1)
    assert.equal(ui.calls.find(call => call.action === 'eval/cancel')?.payload.job_id, 'job-1')
    assert.match(ui.text(), /评测任务 · 正在取消/)
    assert.equal(ui.button('取消评测').props.disabled, true)
    cancelled = true; finishCancel({ status: 'cancelling' }); await ui.settle()
    assert.match(ui.text(), /评测任务 · 已取消/)
    assert.equal(ui.calls.filter(call => call.action === 'eval/cancel').length, 1)
  } finally { ui.cleanup() }
})

test('评测状态读取失败时标明待核对并保留 Job 身份，重试后恢复实际状态', async () => {
  let disconnected = true
  const ui = workbench({ target: { page: 'evaluation', tab: 'jobs', job_id: 'job-1', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', source: `experiment:${expA}`, agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
    if (action === 'eval/status') {
      if (disconnected) throw new Error('network: 状态查询暂不可用')
      return { job_id: 'job-1', status: 'running' }
    }
    return original(action, payload)
  } })
  try {
    await ui.settle()
    assert.match(ui.text(), /评测任务 · 状态待核对/)
    assert.match(ui.text(), /未能连接任务 job-1/)
    const records = ui.nodes().find(node => node.type === 'table' && node.props['aria-label'] === '评测记录列表')
    assert.match(ui.text(records), /当前任务.*状态待核对.*状态待核对/)
    assert.equal(ui.button('取消评测').props.disabled, true)
    disconnected = false
    ui.button('刷新状态').props.onClick(); await ui.settle()
    assert.match(ui.text(), /评测任务 · 运行中/)
    assert.equal(ui.button('取消评测').props.disabled, false)
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
      assert.equal(ui.byLabel('Run 结果用例').props.value, 'C-2')
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
    ui.button('测试一C-1').props.onClick({ stopPropagation() {} }); await ui.settle()
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
  ui.byLabel('执行 C-1').props.onChange({ target: { checked: true } })
  await ui.settle()
  assert.equal(ui.calls.some(call => call.action === 'cases/read'), false)
  ui.button('测试一C-1').props.onClick({ stopPropagation() {} })
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
  ui.button('测试二C-2').props.onClick({ stopPropagation() {} })
  ui.render()
  assert.equal(ui.byLabel('用例名称').props.value, '修改后的用例')
  assert.equal(ui.navigations.at(-1).case_id, 'C-1')
  ui.setFailSave(false)
  ui.button('保存用例').props.onClick()
  await ui.settle()
  const save = ui.calls.filter(call => call.action === 'cases/update').at(-1)
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
  ui.byLabel('执行 C-2').props.onChange({ target: { checked: true } })
  ui.render()
  ui.button('＋ 新建评测').props.onClick()
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
  const leftOption = ui.byLabel('左侧 Run').props.children.flat().find(node => node?.props.value === runA)
  assert.match(ui.text(leftOption), /^alpha · v001 · /)
  assert.equal(leftOption.props.title, runA)
  assert.match(ui.text(leftOption), /…11111111$/)
  ui.change('左侧 Run', runA)
  const rightOptions = ui.byLabel('右侧 Run').props.children.flat().filter(Boolean).map(node => node.props.value)
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

test('已有旧报告时启动新评测会定位新 Run，任务报告按钮合并标签与 Run 导航', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA, run_id: runB } })
  await ui.settle()
  ui.button('＋ 新建评测').props.onClick()
  ui.render()
  ui.button('启动评测').props.onClick()
  await ui.settle()
  assert.equal(ui.navigations.at(-1).run_id, runA)
  assert.equal(ui.navigations.at(-1).tab, 'runs')
  assert.equal(ui.contexts.at(-1).run_id, runA)
  ui.nodes().find(node => node.props?.id === 'evaluation-tab-cases').props.onClick()
  await ui.settle()
  ui.button('查看本次报告').props.onClick()
  await ui.settle()
  assert.equal(ui.navigations.at(-1).run_id, runA)
  assert.equal(ui.navigations.at(-1).tab, 'runs')
  assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-tab-runs').props['aria-selected'], true)
  ui.cleanup()
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
  ui.button('＋ 新建评测').props.onClick()
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
  assert.match(ui.text(), /评测任务 · 已结束/)
  ui.setTarget(origin)
  ui.setActive(true)
  await ui.settle()
  ui.button('刷新状态').props.onClick()
  await ui.settle()
  assert.equal(ui.navigations.length, navigationCount)
  assert.equal(ui.contexts.at(-1).run_id, runB)
  ui.cleanup()
})

test('等待状态时切换智能体范围，旧任务完成不覆盖新范围或导航', async () => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => { if (action === 'eval/status') await pending; return original(action, payload) } })
  await ui.settle()
  ui.button('＋ 新建评测').props.onClick()
  ui.render()
  ui.button('启动评测').props.onClick()
  await ui.settle()
  ui.setTarget({ page: 'evaluation', tab: 'runs', agent_id: 'beta' })
  await ui.settle()
  const navigationCount = ui.navigations.length
  release()
  await ui.settle()
  assert.equal(ui.navigations.length, navigationCount)
  assert.equal(ui.byLabel('评测智能体').props.value, 'beta')
  assert.equal(ui.byLabel('评测研究版本').props.value, '')
  assert.equal(ui.contexts.at(-1).run_id, undefined)
  assert.match(ui.text(), /评测任务 · 已结束/)
  ui.cleanup()
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
  ui.button('＋ 新建评测').props.onClick()
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

test('从任务手动查看历史 Run 后清除任务绑定，子页签与刷新不切回任务结果', async () => {
  const target = { page: 'evaluation', tab: 'jobs', job_id: 'job-1', agent_id: 'alpha', experiment_id: expA }
  const handler = async (action, payload, original) => {
    if (action === 'eval/list') return { jobs: [{ job_id: 'job-1', agent_id: 'alpha', experiment_id: expA, status: 'running', started_at: '2026-10-15T08:00:00Z' }] }
    if (action === 'eval/status') return { job_id: 'job-1', status: 'completed', result: { run_id: runA } }
    if (action === 'runs/overview') return alphaOverview([{ experiment_id: expA, runs: [{ run_id: runB, status: 'completed', created_at: '2026-10-15T09:00:00Z' }, { run_id: runA, status: 'completed', created_at: '2026-10-15T08:00:00Z' }] }])
    return original(action, payload)
  }
  const ui = workbench({ target, handler })
  try {
    await ui.settle()
    ui.idButton(runB).props.onClick({ stopPropagation() {} })
    await ui.settle()
    assert.equal(ui.getTarget().run_id, runB)
    assert.equal(ui.getTarget().job_id, undefined)
    ui.nodes().find(node => node.props?.id === 'evaluation-run-tab-trace').props.onClick()
    await ui.settle()
    assert.equal(ui.getTarget().run_tab, 'trace')
    assert.equal(ui.getTarget().job_id, undefined)
    const refreshed = workbench({ target: ui.getTarget(), handler })
    try {
      await refreshed.settle()
      assert.equal(refreshed.getTarget().run_id, runB)
      assert.equal(refreshed.getTarget().job_id, undefined)
      assert.equal(refreshed.calls.some(call => call.action === 'eval/status'), false)
    } finally { refreshed.cleanup() }
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
  ui.button('＋ 新建评测').props.onClick()
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

test('取消评测保持正在取消状态，禁止重复取消并在 CLI 收尾后读取封存报告', async () => {
  let state = 'running'
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', agent_id: 'alpha', experiment_id: expA }, handler: async (action, payload, original) => {
    if (action === 'eval/status') return { job_id: 'job-1', status: state, result: state === 'cancelled' ? { run_id: runA, cancelled: true, instance_stopped: true } : undefined }
    if (action === 'eval/cancel') { state = 'cancelling'; return { status: state } }
    return original(action, payload)
  } })
  try {
    await ui.settle(); ui.button('＋ 新建评测').props.onClick(); ui.render(); ui.button('启动评测').props.onClick(); await ui.settle()
    ui.button('取消评测').props.onClick(); ui.render()
    assert.equal(ui.calls.filter(item => item.action === 'eval/cancel').length, 0)
    ui.button('确认取消').props.onClick(); await ui.settle()
    assert.match(ui.text(), /评测任务 · 正在取消/); assert.equal(ui.button('取消评测').props.disabled, true)
    ui.button('取消评测').props.onClick(); await ui.settle()
    assert.equal(ui.calls.filter(item => item.action === 'eval/cancel').length, 1)
    state = 'cancelled'; ui.button('刷新状态').props.onClick(); await ui.settle()
    assert.match(ui.text(), /评测任务 · 已取消/); assert.ok(ui.calls.some(item => item.action === 'runs/show' && item.payload.run_id === runA))
  } finally { ui.cleanup() }
})


test('从样本跳到固定轨迹并返回保留组件身份和草稿保护，重新抽取使用同一Run', async () => {
  const ui = workbench({ target: { page: 'evaluation', tab: 'runs', run_id: runA } })
  try {
    await ui.settle(); ui.button('查看决策样本').props.onClick(); ui.render()
    const dataset = ui.nodes().find(node => node.type?.name === 'DecisionDatasetView')
    assert.ok(dataset); dataset.props.onDirty(true); ui.render()
    dataset.props.onSource({ path: 'evidence/C-1/trace.jsonl', line: 141, source_sha256: 'trace-fixed' }); ui.render()
    assert.equal(ui.nodes().find(node => node.props?.id === 'evaluation-run-panel-trace').props.hidden, false)
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
    assert.equal(ui.navigations.length > 0, true)

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
    assert.match(ui.text(), /评测记录\s*2/)
    fail = true
    ui.invalidate(['agents']); await ui.settle()
    assert.match(ui.text(), /Run 列表读取失败：network: 暂时不可达/)
    assert.match(ui.text(), /评测记录\s*2/, '读取失败不得清空上次看到的记录')
  } finally { ui.cleanup() }
})
