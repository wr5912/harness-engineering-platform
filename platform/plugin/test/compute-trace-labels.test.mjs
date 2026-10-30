import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'
import { dump } from 'js-yaml'

process.env.HARNESS_PROGRAM_ROOT = new URL('../../../', import.meta.url).pathname
process.env.HARNESS_PYTHON ??= 'python3'
const require = createRequire(import.meta.url)
const source = new URL('../src/agents/compute-variants.ts', import.meta.url).pathname
const built = mkdtempSync(join(tmpdir(), 'compute-trace-labels-build-'))
await build({ entryPoints: [source], outfile: join(built, 'variants.mjs'), bundle: true, platform: 'node', format: 'esm' })
const { createComputeVariantsHandler } = await import(`file://${join(built, 'variants.mjs')}`)
const digest = value => createHash('sha256').update(value).digest('hex')
const experimentId = 'EXP-alpha-001-r111111111111'
const parentId = 'EXP-alpha-002-r222222222222'
const parentRunId = 'run-66666666-6666-4666-8666-666666666666'
const ids = {
  passed: 'run-11111111-1111-4111-8111-111111111111',
  failed: 'run-22222222-2222-4222-8222-222222222222',
  unknown: 'run-33333333-3333-4333-8333-333333333333',
  error: 'run-44444444-4444-4444-8444-444444444444',
  stale: 'run-55555555-5555-4555-8555-555555555555',
}
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value) }

test('来源轨迹使用冻结任务标题和同一 Run 的业务结论，缺失时不猜测成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'compute-trace-labels-'))
  try {
    write(join(root, 'agents/alpha/evaluation.md'), '# 评测\n\n## 查询\n\n#### U-ONE-001 查询状态\n\n**用户输入**\n\n> 查询状态。\n\n**预期**\n\n准确返回状态。\n')
    write(join(root, 'evolution/experiments', experimentId, 'change.yaml'), dump({ experiment_id: experimentId, agent_id: 'alpha', baseline_ref: 'none:first-experiment' }))
    for (const [kind, id] of Object.entries(ids)) {
      const runDir = join(root, 'evolution/experiments', experimentId, 'runs', id)
      const status = kind === 'error' ? 'failed' : 'completed'
      const summary = JSON.stringify({ run_id: kind === 'stale' ? ids.passed : id, effective_verdict: kind === 'failed' ? 'failed' : 'passed' })
      const manifest = { run_id: id, experiment_id: experimentId, agent_id: 'alpha', status, created_at: '2026-10-20T09:00:00Z', summary_sha256: digest(summary) }
      write(join(runDir, 'run.yaml'), dump(manifest))
      write(join(runDir, 'inputs.lock.json'), JSON.stringify({ run_id: kind === 'stale' ? ids.passed : id, evaluation_cases: kind === 'failed'
        ? [{ title: '工单字段缺失' }, { title: '超时恢复' }] : [{ title: '查询设备状态' }] }))
      if (kind !== 'unknown') write(join(runDir, 'summary.json'), summary)
    }
    write(join(root, 'evolution/experiments', parentId, 'change.yaml'), dump({ experiment_id: parentId, agent_id: 'alpha', baseline_ref: 'none:first-experiment' }))
    const parentDir = join(root, 'evolution/experiments', parentId, 'runs', parentRunId)
    const parentSummary = JSON.stringify({ run_id: parentRunId, effective_verdict: 'failed' })
    write(join(parentDir, 'run.yaml'), dump({ run_id: parentRunId, experiment_id: parentId, agent_id: 'alpha', status: 'completed', created_at: '2026-10-19T09:00:00Z', summary_sha256: digest(parentSummary) }))
    write(join(parentDir, 'inputs.lock.json'), JSON.stringify({ run_id: parentRunId, evaluation_cases: [{ title: '父版设备巡检' }] }))
    write(join(parentDir, 'summary.json'), parentSummary)
    const handler = createComputeVariantsHandler(root, {
      candidateDigest: () => 'candidate-digest', gitCandidateDigest: () => null,
      readRun: async () => { throw new Error('无生成计划时不应读取完整 Run') },
      createExperiment: async () => { throw new Error('仅查询') },
    })
    const result = await handler('context', { experiment_id: experimentId })
    assert.equal(result.ok, true, JSON.stringify(result))
    const runs = Object.fromEntries(result.value.runs.map(run => [run.run_id, run]))
    assert.equal(runs[ids.passed].title, '查询设备状态')
    assert.equal(runs[ids.passed].effective_verdict, 'passed')
    assert.equal(runs[ids.failed].title, '工单字段缺失等 2 项任务')
    assert.equal(runs[ids.failed].effective_verdict, 'failed')
    assert.equal(runs[ids.unknown].title, '查询设备状态')
    assert.equal(runs[ids.unknown].effective_verdict, undefined)
    assert.equal(runs[ids.error].status, 'failed')
    assert.equal(runs[ids.error].effective_verdict, undefined)
    assert.equal(runs[ids.stale].title, undefined)
    assert.equal(runs[ids.stale].effective_verdict, undefined)
    assert.equal(runs[parentRunId].experiment_id, parentId)
    assert.equal(runs[parentRunId].title, '父版设备巡检')
    assert.equal(runs[parentRunId].effective_verdict, 'failed')
    assert.equal(readFileSync(join(root, 'evolution/experiments', experimentId, 'runs', ids.passed, 'summary.json'), 'utf8'), JSON.stringify({ run_id: ids.passed, effective_verdict: 'passed' }))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('助手收到可读策划摘要，Run ID 与实际结论保留用于核对', async () => {
  const client = await build({ entryPoints: [new URL('../src/agents/compute-variants.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
  const states = [], deps = [], cleanups = [], calls = []
  let cursor = 0, effects = [], changed = false, tree
  const react = { ...require('react'),
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { const next = typeof value === 'function' ? value(states[index]) : value; if (!Object.is(next, states[index])) { states[index] = next; changed = true } }] },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect(effect, values) { const index = cursor++; if (!deps[index] || values.some((value, at) => value !== deps[index][at])) { deps[index] = values; effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() }) } },
  }
  const module = { exports: {} }
  const storage = new Map()
  const window = { sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, addEventListener() {}, removeEventListener() {} }
  vm.runInNewContext(client.outputFiles[0].text, { window, module, exports: module.exports, URLSearchParams, require: name => name === 'react' ? react : name === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: () => null } : require(name) })
  const context = { experiment_id: experimentId, agent_id: 'alpha', parent_ref: `git:${'a'.repeat(40)}`, plan: null, cases: [], runs: [
    { run_id: ids.passed, experiment_id: experimentId, status: 'completed', effective_verdict: 'passed', title: '查询设备状态', created_at: '2026-10-20T09:00:00Z' },
    { run_id: ids.unknown, experiment_id: experimentId, status: 'completed', title: '超时恢复', created_at: '2026-10-19T09:00:00Z' },
  ] }
  const rpc = { call: async () => ({ ok: true, value: context }) }
  const props = { rpc, agentId: 'alpha', agentName: '资产告警助手', experimentId, versionLabel: 'v001', versions: [{ id: experimentId }], onAssistant: async (task, scope) => calls.push({ task, scope }) }
  const render = () => { let attempts = 0; do { if (++attempts > 20) throw new Error('渲染未收敛'); cursor = 0; effects = []; changed = false; tree = module.exports.ComputeVariantsPanel(props); effects.forEach(effect => effect()) } while (changed) }
  const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children ?? [])]
  try {
    render(); await new Promise(resolve => setImmediate(resolve)); render()
    const dialog = nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'ComputePlanningDialog')
    assert.equal(dialog.props.rpc, rpc)
    assert.equal(dialog.props.runs[0].title, '查询设备状态')
    assert.equal(dialog.props.runs[0].effective_verdict, 'passed')
    await dialog.props.onSend({ requestId: 'request-trace-1', type: 'low', variantName: '规则版', goal: '降低推理开销', sourceRunIds: [ids.passed, ids.unknown], tracePlanRequested: false, low: { uncovered: 'stop_and_report', requirements: '' } })
    assert.match(calls[0].task, /^## 低算力变体策划请求/)
    assert.match(calls[0].task, /- 来源轨迹：查询设备状态（Run …11111111；成功）；超时恢复（Run …33333333；结果待核对）/)
    assert.match(calls[0].task, /- 工具与未覆盖：复用现有真实工具；未覆盖时中止并报告/)
    assert.match(calls[0].task, /请使用 compute-variant-research/)
    assert.match(calls[0].task, /近似等效和资源收益是待验证目标/)
    assert.deepEqual(Array.from(calls[0].scope.source_run_ids), [ids.passed, ids.unknown])
  } finally { cleanups.forEach(cleanup => cleanup?.()); rmSync(built, { recursive: true, force: true }) }
})
