import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = await build({ entryPoints: [new URL('../src/agents/variant-source.tsx', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'] })
const module = { exports: {} }
vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? { Modal: () => null } : require(name) })
const { VariantSourcePanel, variantSourceInfo } = module.exports
const fixed = `git:${'a'.repeat(40)}`
const parent = { id: 'EXP-alpha-023', agent_id: 'alpha', change: {} }
const fused = { id: 'EXP-alpha-020', agent_id: 'alpha', change: {} }
const target = change => ({ id: 'EXP-alpha-024', agent_id: 'alpha', change })
function nodes(value) {
  return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : []
}
function text(value) {
  return Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '')
}

test('来源统一进入当前版本抽屉，父版、生成方式和完整固定引用仍可定位', () => {
  const tree = VariantSourcePanel({ experiment: target({ parent_experiment_id: parent.id, parent_ref: fixed, compute_variant: { generation: { mode: 'langgraph-aot' } } }), experiments: [parent] })
  const drawer = nodes(tree).find(node => node.props?.title === '版本来源与继承')
  assert.equal(drawer.props.identity, 'EXP-alpha-024')
  assert.equal(nodes(tree).some(node => node.type === 'details'), false)
  assert.match(text(drawer), /EXP-alpha-023/)
  assert.match(text(drawer), /langgraph-aot/)
  assert.match(text(drawer), new RegExp(fixed))
  const first = VariantSourcePanel({ experiment: target({ baseline_ref: 'none:first-experiment' }), experiments: [] })
  assert.match(text(first), /首版本（无既有对照）/)
  const unknown = VariantSourcePanel({ experiment: target({}), experiments: [] })
  assert.match(text(unknown), /父版本未记录/)
})

test('父版固定引用以 parent_ref 为准，旧合同仅在父 ID 已记录时使用 baseline_ref', () => {
  const info = variantSourceInfo(target({ parent_experiment_id: parent.id, parent_ref: fixed, baseline_ref: 'git:older-comparison' }), [parent])
  assert.equal(info.parent.experimentId, parent.id)
  assert.equal(info.parent.ref, fixed)
  assert.equal(info.parent.available, true)
  const legacy = variantSourceInfo(target({ parent_experiment_id: parent.id, baseline_ref: fixed }), [parent])
  assert.equal(legacy.parent.ref, fixed)
  const missing = variantSourceInfo(target({ baseline_ref: fixed, related_references: [parent.id] }), [parent])
  assert.equal(missing.parent.experimentId, null)
  assert.equal(missing.parent.ref, null)
  assert.equal(missing.baselineRef, fixed)
  assert.match(text(VariantSourcePanel({ experiment: target({ baseline_ref: fixed }), experiments: [parent] })), /父版本未记录固定基线/)
})

test('融合来源保留原始引用，缺失来源不猜测 Agent 或启用跳转', () => {
  const rawRef = 'release:alpha-v1.2.3'
  const props = { experiment: target({ fusion_sources: [{ experiment_id: fused.id, ref: rawRef }, 'EXP-alpha-009', { ref: 'git:historical-source' }] }), experiments: [parent, fused] }
  const info = variantSourceInfo(props.experiment, props.experiments)
  assert.equal(info.fusionSources[0].ref, rawRef)
  assert.equal(info.fusionSources[1].ref, null)
  assert.equal(info.fusionSources[1].agentId, null)
  assert.equal(info.fusionSources[2].experimentId, null)
  const tree = VariantSourcePanel(props)
  assert.match(text(tree), /release:alpha-v1.2.3/)
  assert.match(text(tree), /当前工作区未找到该版本/)
  assert.match(text(tree), /版本 ID 未记录/)
})

test('来源详情、父版诊断报告和生成源码分别定位实际对象', () => {
  const calls = []
  const entry = 'dsh/managed/compute-workflow/index.ts'
  const experiment = target({ parent_experiment_id: parent.id, parent_ref: fixed, fusion_sources: [{ experiment_id: fused.id, ref: 'git:fused-fixed' }], compute_variant: { generation: { mode: 'langgraph-aot', entry_path: entry, source_run_ids: ['run-diagnostic', 'run-diagnostic'] } } })
  const tree = VariantSourcePanel({ experiment, experiments: [parent, fused],
    onSelectSource: (...args) => calls.push(['source', ...args]),
    onOpenRun: (...args) => calls.push(['run', ...args]),
    onOpenCode: (...args) => calls.push(['code', ...args]),
  })
  for (const label of ['查看父版当前详情', '查看融合来源当前详情', '查看诊断报告', '查看生成源码']) {
    const button = nodes(tree).find(node => node.type === 'button' && text(node) === label)
    assert.equal(button.props.disabled, false)
    button.props.onClick()
  }
  assert.deepEqual(calls, [['source', 'alpha', parent.id], ['source', 'alpha', fused.id], ['run', 'run-diagnostic', 'alpha', parent.id], ['code', `evolution/experiments/${experiment.id}/candidate/${entry}`]])
  assert.equal(nodes(tree).filter(node => node.type === 'button' && text(node) === '查看诊断报告').length, 1)
  assert.match(text(tree), /固定引用记录生成时的来源；打开来源详情查看的是该版本当前可编辑的资产/)
})

test('首版本、历史缺失和没有父版的诊断记录分别呈现，不关联到当前变体', () => {
  const first = VariantSourcePanel({ experiment: target({ baseline_ref: 'none:first-experiment' }), experiments: [] })
  assert.match(text(first), /首版本（无既有对照）/)
  assert.doesNotMatch(text(first), /父版本未记录/)
  const orphan = VariantSourcePanel({ experiment: target({ compute_variant: { generation: { source_run_ids: ['run-orphan'] } } }), experiments: [] })
  assert.match(text(orphan), /所属父版未记录/)
  assert.equal(nodes(orphan).some(node => node.type === 'button' && text(node) === '查看诊断报告'), false)
})

test('源码入口使用 Candidate 相对路径，异常路径仅展示原声明', () => {
  for (const entry of ['../other/index.ts', '/tmp/workflow.ts', 'dsh\\managed\\index.ts']) {
    const experiment = target({ compute_variant: { generation: { entry_path: entry } } })
    assert.equal(variantSourceInfo(experiment, []).codePath, null)
    const tree = VariantSourcePanel({ experiment, experiments: [], onOpenCode() { assert.fail('invalid code path') } })
    assert.equal(nodes(tree).find(node => node.type === 'button' && text(node) === '查看生成源码').props.disabled, true)
    assert.ok(text(tree).includes(entry))
  }
})
