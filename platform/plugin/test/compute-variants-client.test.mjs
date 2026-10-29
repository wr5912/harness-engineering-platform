import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/agents/compute-variants.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
function panel(eligible = false, hasPlan = true, readContext) {
  const states = [], deps = [], cleanups = [], calls = [], tasks = []
  let cursor = 0, effects = [], changed = false, tree
  const react = { ...require('react'),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { const next = typeof value === 'function' ? value(states[index]) : value; if (!Object.is(next, states[index])) { states[index] = next; changed = true } }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect(effect, values) { const index = cursor++; if (!deps[index] || values.some((value, at) => value !== deps[index][at])) { deps[index] = values; effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, URLSearchParams, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: () => null } : require(name) })
  const context = { experiment_id: 'EXP-alpha-002', agent_id: 'alpha', freeze: { candidate_matches: true }, parent_ref: `git:${'a'.repeat(40)}`, parent_experiment_id: 'EXP-alpha-001', fixed_parent_ref: `git:${'a'.repeat(40)}`, variant_name: '资产告警轻量版', variant_kind: 'exploratory', decision: 'inconclusive', plan: { strategy: '减少重复调用', case_hashes: { 'U-ONE-001': 'digest' }, critical_case_ids: ['U-ONE-001'], min_runs_per_case: 2, max_pass_rate_drop_pp: 0, resource_metric: 'total_tokens', min_resource_reduction_pct: 10 }, cases: [{ case_id: 'U-ONE-001', title: '查询状态' }], runs: [{ run_id: 'parent-run', experiment_id: 'EXP-alpha-001', status: 'completed' }, { run_id: 'variant-run', experiment_id: 'EXP-alpha-002', status: 'completed' }] }
  if (!hasPlan) context.plan = null
  const props = { onAssistant: async (task, context) => { tasks.push({task, context}) }, agentId: 'alpha', agentName: '资产告警助手', experimentId: 'EXP-alpha-002', versionLabel: 'v002', versions: [{ id: 'EXP-alpha-001' }, { id: 'EXP-alpha-002' }], rpc: { call: async (_channel, method, body) => {
    calls.push({ method, body })
    if (method.endsWith('/context')) return readContext ? readContext(context, body) : { ok: true, value: context }
    if (method.endsWith('/preview')) return { ok: true, value: { variant_name: body.variant_name, parent_experiment_id: body.parent_experiment_id, preview_sha256: 'preview-digest', plan: { strategy: body.strategy, case_hashes: { 'U-ONE-001': 'digest' }, min_runs_per_case: 2, resource_metric: 'total_tokens', min_resource_reduction_pct: 10 } } }
    if (method.endsWith('/create')) return { ok: true, value: { experiment_id: 'EXP-alpha-003' } }
    if (method.endsWith('/freeze-preview')) return { ok: true, value: { preview_sha256: 'freeze-digest', diff: '+ 实际TypeScript源码', freeze_input: { case_ids: ['U-ONE-001'], evaluation_base_sha256: 'case-base' } } }
    if (method.endsWith('/freeze')) return { ok: true, value: { commit: 'fixed' } }
    if (method.endsWith('/edit/read')) return { ok: true, value: { content: 'export function apply() {}' } }
    if (method.endsWith('/compare')) {
      context.comparison = { parent_run_ids: body.parent_run_ids, variant_run_ids: body.variant_run_ids, comparison_receipt: { path: 'evaluation/compute-comparison-fixture.json', sha256: 'receipt-digest' }, quality: { passed: true, cases: [{ case_id: 'U-ONE-001', parent_runs: 1, variant_runs: 1, parent_pass_rate: 100, variant_pass_rate: 100, critical: true, quality_passed: true }] }, resources: Object.fromEntries(['model_calls', 'input_tokens', 'output_tokens', 'total_tokens', 'elapsed_ms'].map(key => [key, { parent: 200, variant: eligible ? 100 : null, reduction_pct: eligible ? 50 : null }])), comparability: { passed: eligible, limits: eligible ? [] : ['独立 Run 数量不足'] }, resource_evidence: { passed: eligible, limits: eligible ? [] : ['缺少完整 token'] }, eligible_for_end: eligible, comparison_sha256: 'compared', notes: ['仅限冻结任务范围。'] }
      return { ok: true, value: context.comparison }
    }
    if (method.endsWith('/confirm')) return { ok: true, value: { decision: body.decision, variant_kind: body.decision === 'end' ? 'end' : 'exploratory' } }
    throw new Error('unexpected')
  } } }
  function render() { let count = 0; do { if (++count > 30) throw new Error('render did not settle'); cursor = 0; effects = []; changed = false; tree = module.exports.ComputeVariantsPanel(props); effects.forEach(effect => effect()) } while (changed); return tree }
  async function settle() { for (let index = 0; index < 6; index++) { render(); await new Promise(resolve => setImmediate(resolve)) }; render() }
  function nodes(value) { if (!arguments.length) value = tree; if (Array.isArray(value)) return value.flatMap(item => nodes(item)); if (!value || typeof value !== 'object') return []; return [value, ...(value.props?.children === undefined ? [] : nodes(value.props.children))] }
  function text(value) { if (!arguments.length) value = tree; return Array.isArray(value) ? value.map(item => text(item)).join('') : value && typeof value === 'object' ? text(value.props?.children ?? '') : String(value ?? '') }
  const label = title => nodes().find(node => node.props?.['aria-label'] === title)
  const button = title => nodes().find(node => node.type === 'button' && text(node) === title)
  const planningDialog = () => nodes().find(node => typeof node.type === 'function' && node.type.name === 'ComputePlanningDialog')
  const change = (title, value) => { label(title).props.onChange({ target: { value, checked: value } }); render() }
  render()
  return { settle, text, calls, tasks, change, button, planningDialog, nodes, render, props, storedContext: context, cleanup: () => cleanups.forEach(fn => fn?.()) }
}
async function compare(ui) { await ui.settle(); ui.change('parent parent-run', true); ui.change('variant variant-run', true); ui.button('比较实际效果与资源').props.onClick(); await ui.settle() }

test('证据不足显示未知和缺口，人工勾选也不能启用 end', async () => {
  const ui = panel()
  try { await compare(ui); assert.match(ui.text(), /未知/); assert.match(ui.text(), /独立 Run 数量不足/); assert.match(ui.text(), /数据仓库提交冻结计划/)
    ui.change('已审阅完整效果与工具结果', true); ui.change('变体研究结论', '需要补充独立运行。')
    assert.equal(ui.button('确认近似等效并标记 end').props.disabled, true)
    ui.button('记录证据不足').props.onClick(); await ui.settle()
    assert.equal(ui.calls.find(call => call.method.endsWith('/confirm')).body.decision, 'inconclusive')
  } finally { ui.cleanup() }
})

test('end 显式确认绑定比较摘要，选择Run变化后旧结果失效', async () => {
  const ui = panel(true)
  try { await compare(ui); assert.equal(ui.button('确认近似等效并标记 end').props.disabled, true)
    ui.change('已审阅完整效果与工具结果', true); ui.change('变体研究结论', '已核对完整输出。')
    assert.equal(ui.button('确认近似等效并标记 end').props.disabled, false)
    ui.button('确认近似等效并标记 end').props.onClick(); await ui.settle()
    const sent = ui.calls.find(call => call.method.endsWith('/confirm')).body
    assert.equal(sent.comparison_sha256, 'compared'); assert.equal(sent.human_confirmed, true)
    ui.button('比较实际效果与资源').props.onClick(); await ui.settle(); ui.change('parent parent-run', false)
    assert.equal(ui.button('确认近似等效并标记 end'), undefined)
  } finally { ui.cleanup() }
})


test('算力变体AI入口绑定专用Skill、版本与已选择Run，不直接执行写操作', async () => {
  const ui = panel()
  try {
    await ui.settle(); ui.change('parent parent-run', true); ui.change('variant variant-run', true)
    ui.button('请 AI 分析算力变体').props.onClick(); await ui.settle()
    const task = ui.tasks[0]
    assert.equal(task.context.skill, 'compute-variant-research')
    assert.equal(task.context.experiment_id, 'EXP-alpha-002')
    assert.equal(task.context.variant_name, '资产告警轻量版')
    assert.deepEqual(Array.from(task.context.parent_run_ids), ['parent-run'])
    assert.deepEqual(Array.from(task.context.variant_run_ids), ['variant-run'])
    assert.match(task.task, /不替我确认/)
    assert.equal(ui.calls.some(call => /\/(create|confirm)$/.test(call.method)), false)
  } finally { ui.cleanup() }
})


test('AI为主入口，手动计划先预览后确认，表单修改使预览失效', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    assert.equal(ui.button('请 AI 策划算力变体').props.className, 'compute-primary')
    assert.equal(ui.button('从固定父版派生'), undefined)
    const alternate = ui.nodes().find(node => node.type === 'details' && node.props.className === 'compute-more')
    assert.equal(alternate.props.open, undefined, '手动计划默认收在次级操作中')
    assert.match(ui.text(alternate), /其他策划方式/)
    ui.button('手动制定计划').props.onClick(); await ui.settle()
    assert.equal(ui.button('预览派生计划').props.disabled, true)
    ui.change('策略与研究问题', '减少重复查询并保留关键结果')
    assert.equal(ui.button('预览派生计划').props.disabled, true, '策略不能代替独立名称')
    ui.change('变体名称', '资产告警轻量版')
    ui.change('策略与研究问题', '减少重复查询并保留关键结果')
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    assert.equal(ui.calls.some(call => call.method.endsWith('/create')), false)
    assert.ok(ui.button('确认创建探索性变体'))
    assert.match(ui.text(), /变体名称：资产告警轻量版/)
    assert.match(ui.text(), /研究策略：减少重复查询并保留关键结果/)
    ui.nodes().find(node => node.type === 'fieldset' && node.props.id === 'compute-manual-plan').props.onChange(); ui.render()
    assert.equal(ui.button('确认创建探索性变体'), undefined)
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    ui.button('确认创建探索性变体').props.onClick(); await ui.settle()
    assert.equal(ui.calls.find(call => call.method.endsWith('/create')).body.expected_preview_sha256, 'preview-digest')
    for (const action of ['preview', 'create']) {
      const input = ui.calls.find(call => call.method.endsWith(`/${action}`)).body
      assert.equal(input.variant_name, '资产告警轻量版')
      assert.equal(input.strategy, '减少重复查询并保留关键结果')
    }
  } finally { ui.cleanup() }
})

test('手动纯代码计划将零调用约束和百分之百改善传入派生预览', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    ui.button('手动制定计划').props.onClick(); await ui.settle()
    ui.change('变体名称', '台账纯代码版')
    ui.change('策略与研究问题', '所有业务分支通过图和原工具执行')
    ui.change('生成 LangGraph 代码变体', true)
    ui.change('生成来源 variant-run', true)
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    const input = ui.calls.find(call => call.method.endsWith('/preview')).body
    assert.equal(input.execution_mode, 'code-only')
    assert.equal(input.resource_metric, 'actual_model_calls')
    assert.equal(input.min_resource_reduction_pct, 100)
    assert.equal(input.allow_model_change, false)
    assert.deepEqual(Array.from(input.generation.source_run_ids), ['variant-run'])
  } finally { ui.cleanup() }
})

test('手动切换父版独立回读固定来源、任务与轨迹，不覆盖当前比较工作区', async () => {
  const ui = panel(true, true, (context, body) => ({ ok: true, value: body.experiment_id === 'EXP-alpha-001' ? {
    ...context, experiment_id: body.experiment_id, parent_ref: `git:${'b'.repeat(40)}`, comparison: null,
    cases: [{ case_id: 'U-PARENT-001', title: '父版独立任务' }], plan: { ...context.plan, critical_case_ids: ['U-PARENT-001'] },
    runs: [{ run_id: 'selected-parent-run', experiment_id: body.experiment_id, status: 'completed' }],
  } : context }))
  try {
    await compare(ui)
    ui.button('手动派生新变体').props.onClick(); await ui.settle()
    ui.change('变体名称', '父版派生'); ui.change('策略与研究问题', '复用固定父版的流程')
    ui.change('生成 LangGraph 代码变体', true); ui.change('生成来源 variant-run', true)
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    assert.ok(ui.button('确认创建探索性变体'))
    ui.change('完整父版', 'EXP-alpha-001')
    assert.equal(ui.button('确认创建探索性变体'), undefined)
    assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '生成来源 variant-run'), false)
    await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '关键 U-PARENT-001').props.checked, true)
    assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '纳入 U-ONE-001'), false)
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === 'parent parent-run').props.checked, true)
    assert.ok(ui.button('确认近似等效并标记 end'), '选择创建父版不能清除当前版本已回读的比较')
    assert.equal(ui.button('预览派生计划').props.disabled, true, '必须重新选择对应父版的真实来源 Run')
    ui.change('生成来源 selected-parent-run', true)
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    const input = ui.calls.filter(call => call.method.endsWith('/preview')).at(-1).body
    assert.equal(input.parent_experiment_id, 'EXP-alpha-001'); assert.equal(input.parent_ref, `git:${'b'.repeat(40)}`)
    assert.deepEqual(Array.from(input.case_ids), ['U-PARENT-001'])
    assert.deepEqual(Array.from(input.critical_case_ids), ['U-PARENT-001'])
    assert.deepEqual(Array.from(input.generation.source_run_ids), ['selected-parent-run'])
    assert.equal(ui.nodes().some(node => node.type === 'input' && node.props.placeholder === 'git:<40 位提交>'), false)
  } finally { ui.cleanup() }
})

test('父版来源迟到不会覆盖新选择，未固定的 Candidate 不能派生', async () => {
  let reads = 0, releasePrevious
  const previous = new Promise(resolve => { releasePrevious = resolve })
  const ui = panel(false, false, (context, body) => {
    if (++reads === 2) return previous
    return { ok: true, value: body.experiment_id === 'EXP-alpha-001' ? { ...context, experiment_id: body.experiment_id, parent_ref: `git:${'b'.repeat(40)}`, freeze: { candidate_matches: false }, cases: [{ case_id: 'U-PARENT-001', title: '所选父版任务' }] } : context }
  })
  try {
    await ui.settle(); ui.button('手动制定计划').props.onClick(); await ui.settle()
    assert.ok(ui.nodes().some(node => node.type?.name === 'LoadingIndicator' && node.props.label === '核对父版来源与任务'))
    assert.doesNotMatch(ui.text(), /正在核对父版来源与任务/)
    ui.change('完整父版', 'EXP-alpha-001'); await ui.settle()
    releasePrevious({ ok: true, value: ui.storedContext }); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '完整父版').props.value, 'EXP-alpha-001')
    assert.ok(ui.nodes().some(node => node.props?.['aria-label'] === '纳入 U-PARENT-001'))
    assert.equal(ui.nodes().some(node => node.props?.['aria-label'] === '纳入 U-ONE-001'), false)
    ui.change('变体名称', '未固定来源派生'); ui.change('策略与研究问题', '减少重复请求')
    assert.match(ui.text(), /所选父版尚未固定或有未提交改动/)
    assert.equal(ui.button('预览派生计划').props.disabled, true)
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    assert.equal(ui.calls.some(call => call.method.endsWith('/preview')), false)
  } finally { ui.cleanup() }
})

test('父版核对失败保留业务草稿，重试后自动恢复对应来源', async () => {
  let reads = 0
  const ui = panel(false, false, context => ++reads === 2 ? { ok: false, error: { message: '来源暂不可读' } } : { ok: true, value: context })
  try {
    await ui.settle(); ui.button('手动制定计划').props.onClick(); await ui.settle()
    ui.change('变体名称', '保留的业务名称'); ui.change('策略与研究问题', '保留的业务目标')
    assert.match(ui.text(), /来源暂不可读/); assert.equal(ui.button('预览派生计划').props.disabled, true)
    ui.button('重新核对父版').props.onClick(); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '变体名称').props.value, '保留的业务名称')
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '策略与研究问题').props.value, '保留的业务目标')
    assert.equal(ui.button('预览派生计划').props.disabled, false)
  } finally { ui.cleanup() }
})

test('初次读取期间禁止刷新竞态，失败后刷新恢复完整表单默认值', async () => {
  let rejectInitial, reads = 0
  const ui = panel(false, false, context => ++reads === 1
    ? new Promise((_, reject) => { rejectInitial = reject })
    : { ok: true, value: context })
  try {
    await ui.settle()
    assert.ok(ui.nodes().some(node => node.type?.name === 'LoadingIndicator' && node.props.label === '读取计划与封存 Run'))
    assert.doesNotMatch(ui.text(), /正在读取|请稍候/)
    assert.doesNotMatch(ui.text(), /尚未保存算力变体计划|尚无封存 Run|待采集/)
    assert.equal(ui.button('刷新').props.disabled, true)
    assert.equal(ui.button('手动制定计划').props.disabled, true)
    rejectInitial(new Error('暂时无法读取'))
    await ui.settle()
    assert.match(ui.text(), /当前版本暂不可用/)
    assert.doesNotMatch(ui.text(), /尚未保存算力变体计划|尚无封存 Run|待采集/)
    assert.equal(ui.button('刷新').props.disabled, false)
    ui.button('刷新').props.onClick(); await ui.settle()
    ui.button('手动制定计划').props.onClick(); await ui.settle()
    ui.change('变体名称', '资产告警轻量版')
    ui.change('策略与研究问题', '减少重复查询')
    assert.equal(ui.button('预览派生计划').props.disabled, false)
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    const input = ui.calls.find(call => call.method.endsWith('/preview')).body
    assert.equal(input.parent_ref, `git:${'a'.repeat(40)}`)
    assert.deepEqual(Array.from(input.case_ids), ['U-ONE-001'])
  } finally { ui.cleanup() }
})

test('代码变体入口只提出固定目标任务，构建和装载状态来自回读，冻结保留完整输入并单独确认', async () => {
  const ui = panel(false, true, context => ({ ok: true, value: { ...context, generation: { mode: 'langgraph-aot', entry_path: 'dsh/managed/compute-workflow/index.ts', source_run_ids: ['parent-run'] }, workflow_status: { generated: true, built: true, frozen: false, loaded: false, compared: false } } }))
  try {
    await ui.settle()
    assert.match(ui.text(), /代码已保存：已验证/); assert.match(ui.text(), /新 Session 已装载：尚未验证/)
    ui.button('请 AI 生成代码变体').props.onClick(); await ui.settle()
    assert.equal(ui.tasks[0].context.experiment_id, 'EXP-alpha-002'); assert.equal(ui.tasks[0].context.generation_intent, 'implement')
    assert.equal(ui.tasks[0].context.variant_name, '资产告警轻量版')
    assert.match(ui.tasks[0].task, /保留已确定的 variant_name/)
    assert.match(ui.tasks[0].task, /kind=compute-variant/)
    assert.equal(ui.calls.some(call => /\/(build|freeze|create)$/.test(call.method)), false)
    ui.button('查看生成代码').props.onClick(); await ui.settle(); assert.match(ui.text(), /export function apply/)
    ui.button('预览冻结差异').props.onClick(); await ui.settle()
    assert.match(ui.text(), /实际TypeScript源码/); assert.equal(ui.calls.some(call => call.method.endsWith('/freeze')), false)
    ui.button('确认冻结本次差异').props.onClick(); await ui.settle()
    const input = ui.calls.find(call => call.method.endsWith('/freeze')).body
    assert.deepEqual(Array.from(input.case_ids), ['U-ONE-001']); assert.equal(input.evaluation_base_sha256, 'case-base'); assert.equal(input.expected_preview_sha256, 'freeze-digest'); assert.equal(input.confirmed, true)
  } finally { ui.cleanup() }
})

test('策划入口打开弹窗，选择低算力后才把真实来源与规则路线发送平台助手', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    ui.button('请 AI 策划算力变体').props.onClick(); await ui.settle()
    assert.equal(ui.tasks.length, 0)
    assert.equal(ui.planningDialog().props.open, true)
    assert.equal(ui.planningDialog().props.agentName, '资产告警助手')
    assert.equal(ui.planningDialog().props.versionLabel, 'v002')
    assert.deepEqual(Array.from(ui.planningDialog().props.runs.map(run => run.run_id)), ['variant-run'])
    await ui.planningDialog().props.onSend({ requestId: 'req-low-1', type: 'low', variantName: '告警规则版', goal: '缩短响应时间', sourceRunIds: ['variant-run'], tracePlanRequested: false, advanced: '延迟变化须单独说明', low: { uncovered: 'stop_and_report', requirements: '保持原工具调用结果' } })
    assert.equal(ui.tasks.length, 1)
    assert.equal(ui.tasks[0].context.planning_intent, 'plan_only')
    assert.equal(ui.tasks[0].context.request_id, 'req-low-1')
    assert.match(ui.tasks[0].task, /策划请求编号：req-low-1/)
    assert.equal(ui.tasks[0].context.experiment_id, 'EXP-alpha-002')
    assert.deepEqual(Array.from(ui.tasks[0].context.source_run_ids), ['variant-run'])
    assert.match(ui.tasks[0].task, /LangGraph 代码/)
    assert.match(ui.tasks[0].task, /业务全链零 LLM/)
    assert.equal(ui.tasks[0].context.execution_mode, 'code-only')
    assert.match(ui.tasks[0].task, /其他限制与验收关注点：延迟变化须单独说明/)
    assert.equal(ui.tasks[0].context.advanced, '延迟变化须单独说明')
    assert.match(ui.tasks[0].task, /近似等效和资源收益是待验证目标/)
    assert.equal(ui.calls.some(call => /\/(preview|create|build|confirm)$/.test(call.method)), false)
  } finally { ui.cleanup() }
})

test('中算力请求包含模型与 SSH 非敏感配置，拒绝失效 Run 和原文凭据', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    const base = { requestId: 'req-medium-1', type: 'medium', variantName: '', goal: '降低推理资源', sourceRunIds: ['variant-run'], tracePlanRequested: false,
      medium: { serverMode: 'new', serverId: '', host: 'training.example', port: 22, user: 'trainer', workDir: '/work/compute', auth: 'ssh_key', credentialRef: 'ref:training-key', models: [
        { kind: 'llm', source: 'huggingface', baseModel: 'org/summary-small', revision: 'hf-revision-1', purpose: '事件摘要' },
        { kind: 'llm', source: 'modelscope', baseModel: 'org/extraction-small', revision: 'ms-revision-2', purpose: '字段抽取' },
        { kind: 'decision', source: 'local', baseModel: '/models/event-classifier', revision: 'local-release-3', purpose: '事件分类' },
        { kind: 'decision', source: 'unspecified', baseModel: '', revision: '', purpose: '由助手建议辅助决策模型' },
      ], combinationPreference: '分类与摘要分别比较后组合' } }
    await assert.rejects(ui.planningDialog().props.onSend({ ...base, sourceRunIds: ['parent-run'] }), error => error.definitelyNotSent === true && /来源轨迹已变化/.test(error.message))
    assert.equal(ui.tasks.length, 0)
    await ui.planningDialog().props.onSend(base)
    assert.equal(ui.tasks[0].context.variant_type, 'medium')
    assert.equal(ui.tasks[0].context.execution_mode, undefined)
    assert.equal(ui.tasks[0].context.variant_name, '资产告警助手 · 中算力变体')
    assert.deepEqual(Object.keys(ui.tasks[0].context.medium).filter(key => key.startsWith('base_model_')), [])
    assert.equal(ui.tasks[0].context.medium.server_host, 'training.example')
    assert.equal(ui.tasks[0].context.medium.credential_ref, 'ref:training-key')
    assert.deepEqual(JSON.parse(JSON.stringify(ui.tasks[0].context.medium.model_suggestions)), base.medium.models)
    assert.equal(ui.tasks[0].context.medium.combination_preference, base.medium.combinationPreference)
    assert.ok(ui.tasks[0].task.includes(JSON.stringify(base.medium.models)))
    assert.match(ui.tasks[0].task, /组合偏好：分类与摘要分别比较后组合/)
    assert.match(ui.tasks[0].task, /小型 LLM 或决策模型的训练与比较/)
    assert.match(ui.tasks[0].task, /Hugging Face、ModelScope 或本地权重的训练引用，不是系统推理供应商 API 路由/)
    assert.match(ui.tasks[0].task, /只策划，不连接服务器、下载模型、启动训练/)
    assert.equal(ui.calls.some(call => call.method === 'models/list'), false)
    assert.doesNotMatch(ui.tasks[0].task, /决策基模型：/)
    await assert.rejects(ui.planningDialog().props.onSend({ ...base, requestId: 'req-medium-2', medium: { ...base.medium, credentialRef: 'raw-secret' } }), error => error.definitelyNotSent === true && /不发送密码或私钥原文/.test(error.message))
    assert.equal(ui.tasks.length, 1)
    assert.doesNotMatch(ui.tasks[0].task, /raw-secret/)
  } finally { ui.cleanup() }
})

test('登记训练连接发送前按 ID 和连接资料回读核对，只交给助手凭据引用', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    const server = { id: 'training-01', name: '训练机一号', host: 'training.example', port: 22, user: 'trainer', workDir: '/work/compute', auth: 'ssh_key', credentialRef: 'ref:training-key' }
    let listed = [server]
    const originalCall = ui.props.rpc.call
    ui.props.rpc.call = async (channel, method, body) => method === 'agents/training-servers/list'
      ? { ok: true, value: { servers: listed } }
      : originalCall(channel, method, body)
    const request = { requestId: 'req-registered-1', type: 'medium', variantName: '告警中算力版', goal: '降低推理资源', sourceRunIds: ['variant-run'], tracePlanRequested: false,
      medium: { serverMode: 'registered', serverId: server.id, host: server.host, port: server.port, user: server.user, workDir: server.workDir, auth: server.auth, credentialRef: server.credentialRef } }
    await ui.planningDialog().props.onSend(request)
    assert.equal(ui.tasks.length, 1)
    assert.equal(ui.tasks[0].context.medium.server_id, server.id)
    assert.equal(ui.tasks[0].context.medium.server_name, server.name)
    assert.equal(ui.tasks[0].context.medium.server_host, server.host)
    assert.equal(ui.tasks[0].context.medium.server_port, server.port)
    assert.equal(ui.tasks[0].context.medium.ssh_user, server.user)
    assert.equal(ui.tasks[0].context.medium.work_dir, server.workDir)
    assert.equal(ui.tasks[0].context.medium.ssh_auth_method, server.auth)
    assert.equal(ui.tasks[0].context.medium.credential_ref, server.credentialRef)
    assert.match(ui.tasks[0].task, /登记资源 训练机一号，training\.example:22，SSH 用户 trainer，工作目录 \/work\/compute，认证方式 ssh_key，凭据引用 ref:training-key/)
    listed = [{ ...server, host: 'changed.example' }]
    await assert.rejects(ui.planningDialog().props.onSend({ ...request, requestId: 'req-registered-2' }), error => error.definitelyNotSent === true && /发生变化/.test(error.message))
    assert.equal(ui.tasks.length, 1, '连接变化时不能向助手发送')
    listed = []
    await assert.rejects(ui.planningDialog().props.onSend({ ...request, requestId: 'req-registered-3' }), error => error.definitelyNotSent === true && /发生变化/.test(error.message))
    assert.equal(ui.tasks.length, 1)
  } finally { ui.cleanup() }
})

test('默认未知模型与空引用交助手建议，不依赖系统推理目录也能发送策划', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    let modelDirectoryReads = 0
    const originalCall = ui.props.rpc.call
    ui.props.rpc.call = async (channel, method, body) => {
      if (method === 'models/list') { modelDirectoryReads++; throw new Error('系统推理目录不可用') }
      return originalCall(channel, method, body)
    }
    const request = { requestId: 'req-suggest-1', type: 'medium', variantName: '', goal: '降低推理资源', sourceRunIds: ['variant-run'], tracePlanRequested: false,
      medium: { serverMode: 'later', serverId: '', host: '', port: 0, user: '', workDir: '', auth: 'ssh_key', credentialRef: '' } }
    await ui.planningDialog().props.onSend(request)
    assert.equal(ui.tasks.length, 1)
    assert.deepEqual(Array.from(ui.tasks[0].context.medium.model_suggestions), [])
    assert.deepEqual(Object.keys(ui.tasks[0].context.medium).filter(key => key.startsWith('base_model_')), [])
    assert.match(ui.tasks[0].task, /尚未填写模型建议，请助手.*小型 LLM 和决策模型/)
    assert.match(ui.tasks[0].task, /仓库或本地路径、Revision 及用途/)
    assert.match(ui.tasks[0].task, /只策划，不连接服务器、下载模型、启动训练/)
    const models = [{ kind: 'llm', source: 'unspecified', baseModel: '', revision: '', purpose: '由助手建议摘要模型' }, { kind: 'decision', baseModel: '', revision: '', purpose: '' }]
    await ui.planningDialog().props.onSend({ ...request, requestId: 'req-suggest-2', medium: { ...request.medium, models } })
    assert.equal(ui.tasks.length, 2)
    assert.deepEqual(JSON.parse(JSON.stringify(ui.tasks[1].context.medium.model_suggestions)), models)
    assert.match(ui.tasks[1].task, /来源未指定、模型仓库或路径未填写、Revision 未固定时，请助手建议/)
    assert.ok(ui.tasks[1].task.includes(JSON.stringify(models)))
    assert.equal(modelDirectoryReads, 0)
    assert.equal(ui.calls.some(call => call.method === 'agents/training-servers/list'), false, '稍后配置不读取或连接训练服务器')
    assert.equal(ui.calls.some(call => /download|train|create|start/.test(call.method)), false, '策划发送不下载模型或启动执行')
  } finally { ui.cleanup() }
})

test('切换版本后清空上一版 Decision 和手动计划草稿', async () => {
  const ui = panel(true, true, (context, body) => ({ ok: true, value: { ...context, experiment_id: body.experiment_id, comparison: context.comparison } }))
  try {
    await compare(ui)
    ui.change('变体研究结论', '上一版的结论')
    ui.button('手动派生新变体').props.onClick(); await ui.settle()
    ui.change('变体名称', '上一版草稿')
    ui.change('策略与研究问题', '上一版策略')
    ui.change('关键 U-ONE-001', true)
    ui.props.experimentId = 'EXP-alpha-003'
    ui.props.versionLabel = 'v003'
    ui.render(); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '变体研究结论').props.value, '')
    assert.equal(ui.nodes().find(node => node.props?.id === 'compute-manual-plan'), undefined)
    ui.button('手动派生新变体').props.onClick(); await ui.settle()
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '变体名称').props.value, '')
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '策略与研究问题').props.value, '')
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '关键 U-ONE-001').props.checked, true, '按新父版计划恢复关键任务，不继承上一版草稿')
    assert.equal(ui.nodes().find(node => node.type === 'details' && node.props.className === 'compute-more').props.open, undefined)
  } finally { ui.cleanup() }
})

test('比较表区分未知通过率、质量失败和证据不足', async () => {
  const ui = panel(true)
  try {
    await compare(ui)
    ui.storedContext.comparison.quality = { passed: false, cases: [
      { case_id: 'UNKNOWN', parent_runs: 1, variant_runs: 1, parent_pass_rate: null, variant_pass_rate: 80, critical: false, quality_passed: false },
      { case_id: 'FAILED', parent_runs: 2, variant_runs: 2, parent_pass_rate: 100, variant_pass_rate: 80, critical: true, quality_passed: false },
    ] }
    ui.button('刷新').props.onClick(); await ui.settle()
    assert.match(ui.text(), /功能质量：证据不足/)
    assert.match(ui.text(), /未知 \/ 80%/)
    assert.doesNotMatch(ui.text(), /未知%/)
    const rows = ui.nodes().filter(node => node.type === 'tr')
    assert.match(ui.text(rows.find(row => /UNKNOWN/.test(ui.text(row)))), /证据不足/)
    assert.match(ui.text(rows.find(row => /FAILED/.test(ui.text(row)))), /未满足/)
    ui.storedContext.comparison.quality.cases.shift()
    ui.button('刷新').props.onClick(); await ui.settle()
    assert.match(ui.text(), /功能质量：未满足预定观察指标/)
  } finally { ui.cleanup() }
})

test('资源摘要区分证据不足与未达到已冻结目标', async () => {
  const ui = panel(true)
  try {
    await compare(ui)
    assert.match(ui.text(), /资源目标：满足预定目标/)
    ui.storedContext.comparison.resource_evidence = { passed: false, limits: ['模型请求记录不完整'] }
    ui.button('刷新').props.onClick(); await ui.settle()
    assert.match(ui.text(), /资源目标：证据不足/)
    ui.storedContext.comparison.resource_evidence = { passed: false, limits: [] }
    ui.storedContext.comparison.resources.total_tokens.reduction_pct = 5
    ui.button('刷新').props.onClick(); await ui.settle()
    assert.match(ui.text(), /资源目标：未满足预定目标/)
  } finally { ui.cleanup() }
})

test('关联 Run 显示当前版本真正最新的记录，不混入其他版本', async () => {
  const ui = panel(false, false, context => ({ ok: true, value: { ...context, runs: [
    { run_id: 'new-other-version', experiment_id: 'EXP-alpha-001', status: 'failed', created_at: '2026-10-20T20:00:00Z' },
    { run_id: 'old-current', experiment_id: 'EXP-alpha-002', status: 'failed', created_at: '2026-10-18T20:00:00Z' },
    { run_id: 'new-current', experiment_id: 'EXP-alpha-002', status: 'completed', created_at: '2026-10-19T20:00:00Z' },
  ] } }))
  try {
    await ui.settle()
    const related = ui.nodes().find(node => node.props?.className === 'compute-related-run')
    assert.match(ui.text(related), /new-current/)
    assert.doesNotMatch(ui.text(related), /old-current|new-other-version/)
    assert.match(ui.text(related), /结果待核对/)
    assert.doesNotMatch(ui.text(related), /成功/)
    assert.match(ui.text(), /先定义路线，再验证效果/)
    assert.equal(ui.nodes().some(node => node.props?.className === 'compute-workflow'), false)
    assert.match(ui.text(related), /比较仍需新 Run/)
  } finally { ui.cleanup() }
})

test('比较父版 Run 显示冻结任务标题和业务结论', async () => {
  const ui = panel(false, true, context => ({ ok: true, value: { ...context, runs: [
    { run_id: 'parent-run', experiment_id: 'EXP-alpha-001', status: 'completed', title: '父版设备巡检', effective_verdict: 'failed', created_at: '2026-10-19T09:00:00Z' },
    { run_id: 'variant-run', experiment_id: 'EXP-alpha-002', status: 'completed', title: '新版设备巡检', effective_verdict: 'passed', created_at: '2026-10-20T09:00:00Z' },
  ] } }))
  try {
    await ui.settle()
    const labels = ui.nodes().filter(node => node.type === 'label')
    assert.match(ui.text(labels.find(node => node.props.children?.[0]?.props?.['aria-label'] === 'parent parent-run')), /父版设备巡检 · 未通过/)
    assert.match(ui.text(labels.find(node => node.props.children?.[0]?.props?.['aria-label'] === 'variant variant-run')), /新版设备巡检 · 成功/)
  } finally { ui.cleanup() }
})

test('手动名称修改后必须重新预览', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    ui.button('手动制定计划').props.onClick(); await ui.settle()
    ui.change('变体名称', '   '); ui.change('策略与研究问题', '减少重复调用')
    assert.equal(ui.button('预览派生计划').props.disabled, true)
    ui.change('变体名称', '  首次命名  ')
    ui.button('预览派生计划').props.onClick(); await ui.settle()
    assert.equal(ui.calls.find(call => call.method.endsWith('/preview')).body.variant_name, '首次命名')
    ui.change('变体名称', '新的名称')
    ui.nodes().find(node => node.type === 'fieldset' && node.props.id === 'compute-manual-plan').props.onChange(); ui.render()
    assert.equal(ui.button('确认创建探索性变体'), undefined)
    assert.equal(ui.calls.some(call => call.method.endsWith('/create')), false)
  } finally { ui.cleanup() }
})

test('详情回读改名后立即同步展示与AI上下文，不重读context且保留手动计划草稿', async () => {
  const ui = panel(true)
  try {
    await compare(ui)
    ui.button('手动派生新变体').props.onClick(); await ui.settle()
    ui.change('变体名称', '下一版草稿')
    ui.change('策略与研究问题', '保留正在编辑的策略正文')
    const reads = ui.calls.filter(call => call.method.endsWith('/context')).length
    ui.props.currentVariantName = '资产告警速查版'; ui.render()
    assert.match(ui.text(), /变体名称：资产告警速查版/)
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '变体名称').props.value, '下一版草稿')
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === '策略与研究问题').props.value, '保留正在编辑的策略正文')
    assert.equal(ui.calls.filter(call => call.method.endsWith('/context')).length, reads)
    ui.button('请 AI 分析算力变体').props.onClick(); await ui.settle()
    assert.equal(ui.tasks[0].context.variant_name, '资产告警速查版')
    ui.props.currentVariantName = null; ui.render()
    assert.match(ui.text(), /变体名称：未命名变体/)
    assert.doesNotMatch(ui.text(), /变体名称：资产告警轻量版/)
  } finally { ui.cleanup() }
})

test('实际比较在刷新和重新打开后从已核验回执恢复，证据失效时移除，人工确认不恢复', async () => {
  const readContext = context => ({ ok: true, value: { ...context, generation: { mode: 'langgraph-aot', entry_path: 'dsh/managed/compute-workflow/index.ts', source_run_ids: ['parent-run'] },
    workflow_status: { generated: true, built: true, frozen: true, loaded: true, compared: Boolean(context.comparison) } } })
  const ui = panel(true, true, readContext)
  let reopened
  try {
    await compare(ui)
    const saved = ui.storedContext.comparison
    assert.match(ui.text(), /实际 Run 已比较：已验证/)
    assert.match(ui.text(), /receipt-digest/)
    ui.change('已审阅完整效果与工具结果', true); ui.change('变体研究结论', '已核对原始结果。')
    ui.button('刷新').props.onClick(); await ui.settle()
    assert.match(ui.text(), /实际 Run 已比较：已验证/)
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === 'parent parent-run').props.checked, true)
    assert.equal(ui.nodes().find(node => node.props?.['aria-label'] === 'variant variant-run').props.checked, true)
    assert.equal(ui.button('确认近似等效并标记 end').props.disabled, true)
    reopened = panel(true, true, context => readContext({ ...context, comparison: saved }))
    await reopened.settle()
    assert.match(reopened.text(), /实际 Run 已比较：已验证/)
    assert.match(reopened.text(), /receipt-digest/)
    assert.equal(reopened.calls.some(call => call.method.endsWith('/compare')), false, '打开页面只读恢复，不重新保存比较')
    assert.equal(reopened.button('确认近似等效并标记 end').props.disabled, true)
    ui.storedContext.comparison = null
    ui.button('刷新').props.onClick(); await ui.settle()
    assert.match(ui.text(), /实际 Run 已比较：尚未验证/)
    assert.equal(ui.button('确认近似等效并标记 end'), undefined)
  } finally { ui.cleanup(); reopened?.cleanup() }
})

test('离开智能体页暂停显示策划弹窗，返回后保留原策划入口状态', async () => {
  const ui = panel(false, false)
  try {
    await ui.settle()
    ui.button('请 AI 策划算力变体').props.onClick(); await ui.settle()
    assert.equal(ui.planningDialog().props.open, true)
    ui.props.active = false; ui.render()
    assert.equal(ui.planningDialog().props.open, false)
    ui.props.active = true; ui.render()
    assert.equal(ui.planningDialog().props.open, true)
    assert.equal(ui.tasks.length, 0)
  } finally { ui.cleanup() }
})


test('固定来源与比较证据仅保留一个按版本及Run绑定的抽屉，缺口和确认仍在主面', async () => {
  const ui = panel()
  try {
    await ui.settle()
    const drawers = () => ui.nodes().filter(node => node.type?.name === 'DetailDrawer' && node.props.title === '来源与比较证据')
    assert.equal(drawers().length, 1)
    assert.match(ui.text(drawers()[0]), /git:aaaa/)
    await compare(ui)
    assert.equal(drawers().length, 1)
    assert.match(ui.text(drawers()[0]), /不可变机器比较回执/)
    assert.match(ui.text(drawers()[0]), /receipt-digest/)
    assert.equal(ui.nodes(drawers()[0]).filter(node => node.type === 'a').length, 2)
    assert.match(drawers()[0].props.identity, /EXP-alpha-002:compared:parent-run:variant-run/)
    assert.ok(ui.nodes().find(node => node.type === 'section' && node.props['aria-label'] === '阻断可比性的证据缺口'))
    assert.ok(ui.nodes().find(node => node.type === 'section' && node.props['aria-label'] === '资源记录限制'))
    assert.ok(ui.button('记录证据不足'))
    ui.props.active = false; ui.render()
    assert.equal(drawers()[0].props.active, false)
  } finally { ui.cleanup() }
})
