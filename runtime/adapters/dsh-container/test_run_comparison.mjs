import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const script = new URL('./run-comparison.ts', import.meta.url).pathname
const route = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'off' }
function view(id, actualRoutes = [route]) {
  return {
    run_id: id, run_path: `runs/${id}`,
    manifest: { agent_id: 'basic', status: 'completed' },
    source: { executor: 'api', model: 'deepseek-flash', review_mode: 'none',
      configured_capabilities: {}, dependency_env: {}, git_version: { commit: 'fixture', dirty: false },
      program_origin: { commit: 'a'.repeat(40), dirty: false },
      evaluation_implementation: { 'dsh-eval': 'b'.repeat(64), 'dsh-eval-api.mjs': 'c'.repeat(64) } },
    image: { image_build_fingerprint: 'fixture', local_image_id: 'fixture' },
    cases: [{ case_id: 'U-BASIC-001', frozen: { inputs: ['查询基础状态'] },
      trials: [{ execution_status: 'completed', verdict: 'passed', observation: '基础状态已展示' }],
      output: ['基础状态已展示'], actual_routes: actualRoutes, review: null,
      load_observation: { preset_matches: true, workspace_matches: true }, evidence: [] }], missing: [],
  }
}
function compare(left, right) {
  const input = JSON.stringify({ left, right })
  const result = spawnSync(process.execPath, [script], { input, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.stringify({ left, right }), input, '比较不得改写来源对象')
  return JSON.parse(result.stdout)
}

test('分层与历史综合复核不可归因，同方法不比较Run私有快照路径但核对评审策略摘要', () => {
  const left = view('old'), right = view('new')
  left.source.review_mode = right.source.review_mode = 'ai'
  const contract = { schema_version: 1, effect_scope: 'business-evidence', source_scope: 'frozen-harness', model_route: { provider: 'mimo', model: 'MiMoFlash', reasoningEffort: 'off' }, model_policy_sha256: '1'.repeat(64), model_policy_snapshot: { path: 'old/policy.json', sha256: '2'.repeat(64) } }
  right.source.review_contract = structuredClone(contract)
  assert.ok(compare(left, right).limits.some(item => item.startsWith('review_contract:')))
  left.source.review_contract = structuredClone(contract)
  right.source.review_contract.model_policy_snapshot.path = 'new/policy.json'
  assert.equal(compare(left, right).causal_comparable, true)
  right.source.review_contract.model_policy_sha256 = '3'.repeat(64)
  assert.ok(compare(left, right).limits.some(item => item.startsWith('review_contract:')))
})

test('源码诊断未完成不替换业务Case结论或判为业务差异', () => {
  const left = view('old'), right = view('new')
  left.summary = right.summary = { review_status: 'completed', effective_verdict: 'passed' }
  left.source_diagnosis = { status: 'completed', conclusion: 'no_findings' }
  right.source_diagnosis = { status: 'incomplete', conclusion: 'inconclusive' }
  const result = compare(left, right)
  assert.equal(result.cases[0].observed_change, '记录相同')
  assert.equal(result.causal_comparable, true)
})

test('历史父版和当前变体允许不同source_ref，但只有同一Mock映射才可比较并明确环境', () => {
  const left = view('parent'), right = view('variant')
  left.source.source_ref = 'git:' + '1'.repeat(40)
  left.source.mcp_fixture = right.source.mcp_fixture = { schema_version: 1, mode: 'mock', sha256: 'a'.repeat(64), connections: [] }
  const same = compare(left, right)
  assert.equal(same.causal_comparable, true)
  assert.match(same.markdown, /mock；冻结连接映射/)
  assert.match(same.markdown, /不代表真实业务系统/)
  right.source.mcp_fixture = { ...right.source.mcp_fixture, sha256: 'b'.repeat(64) }
  assert.ok(compare(left, right).limits.some(limit => limit.startsWith('mcp_fixture:')))
  delete right.source.mcp_fixture
  assert.equal(compare(left, right).causal_comparable, false)
})

test('完整相同路由保留观察性对照且显示实际provider、model和off', () => {
  const result = compare(view('old'), view('new'))
  assert.equal(result.comparable, true)
  assert.equal(result.causal_comparable, true)
  assert.deepEqual(result.limits, [])
  assert.match(result.markdown, /deepseek \/ deepseek-flash \/ reasoningEffort=off/)
  assert.match(result.markdown, /仍需结合实验设计判断/)
})

for (const field of ['provider', 'model', 'reasoningEffort']) {
  test(`记录中的${field}差异不能归因于Harness`, () => {
    const result = compare(view('old'), view('new', [{ ...route, [field]: 'different' }]))
    assert.equal(result.comparable, true)
    assert.equal(result.causal_comparable, false)
    assert.ok(result.limits.some(item => item.includes('实际模型路由不同')))
    assert.deepEqual(result.cases[0].left_actual_routes, [route])
    assert.deepEqual(result.cases[0].right_actual_routes, [{ ...route, [field]: 'different' }])
  })
}

test('off与未记录、双方均未记录必须分别保留未知限制', () => {
  const unknown = { provider: route.provider, model: route.model }
  const missing = compare(view('old'), view('new', [unknown]))
  assert.equal(missing.causal_comparable, false)
  assert.ok(missing.limits.some(item => /right 第 1 轮实际模型路由未记录 reasoningEffort/.test(item)))
  assert.ok(missing.limits.some(item => item.includes('实际模型路由不同')))
  const bothMissing = compare(view('old', [unknown]), view('new', [unknown]))
  assert.equal(bothMissing.comparable, true)
  assert.equal(bothMissing.causal_comparable, false)
  assert.equal(bothMissing.limits.filter(item => item.includes('未记录 reasoningEffort')).length, 2)
})

test('逐轮缺失不能在过滤模型名后被折叠为相同路由', () => {
  const result = compare(view('old', [route, null]), view('new', [route]))
  assert.equal(result.comparable, true)
  assert.equal(result.causal_comparable, false)
  assert.ok(result.limits.some(item => /left 第 2 轮实际模型路由未记录 provider \/ model \/ reasoningEffort/.test(item)))
  assert.ok(result.limits.some(item => item.includes('实际模型路由不同')))
  for (const routes of [null, []]) {
    const unknown = compare(view('old', routes), view('new', routes))
    assert.equal(unknown.causal_comparable, false)
    assert.equal(unknown.limits.filter(item => item.includes('缺少实际模型路由记录')).length, 2)
  }
})

test('平台来源或执行评审实现缺失及变化保留归因限制，不因模型相同而忽略', () => {
  for (const field of ['program_origin', 'evaluation_implementation']) {
    const missing = view('missing')
    delete missing.source[field]
    const missingResult = compare(view('old'), missing)
    assert.equal(missingResult.comparable, true)
    assert.equal(missingResult.causal_comparable, false)
    assert.ok(missingResult.limits.some(item => field === 'program_origin' ? item.includes('平台程序来源未记录') : item === 'evaluation_implementation: 未记录'))
    const changed = view('changed')
    if (field === 'program_origin') changed.source.program_origin.commit = 'd'.repeat(40)
    else changed.source.evaluation_implementation['dsh-eval'] = 'e'.repeat(64)
    const changedResult = compare(view('old'), changed)
    assert.equal(changedResult.comparable, true)
    assert.equal(changedResult.causal_comparable, false)
    assert.ok(changedResult.limits.includes(field === 'program_origin' ? 'program_origin: 平台程序提交不同' : 'evaluation_implementation: 不同'))
  }
})
