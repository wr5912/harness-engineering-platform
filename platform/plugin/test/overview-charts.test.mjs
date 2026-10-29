import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
async function source(path) {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require })
  return module.exports
}
const { runOutcome, runOutcomeSegments } = await source('../src/components/run-overview.ts')
const { caseObservation } = await source('../src/evaluation/case-observation.ts')
const { DistributionChart, SequenceChart } = await source('../src/components/overview-charts.tsx')
const { createElement } = require('react'), { renderToStaticMarkup } = require('react-dom/server')

test('概览将执行状态与业务结论分开，未完成运行不能沿用旧passed', () => {
  for (const verdict of ['passed', 'failed', 'inconclusive']) assert.equal(runOutcome({ status: 'completed', effective_verdict: verdict }), verdict)
  assert.equal(runOutcome({ status: 'completed' }), 'unreviewed')
  assert.equal(runOutcome({ status: 'completed', effective_verdict: 'unexpected' }), 'unreviewed')
  assert.equal(runOutcome({ status: 'failed', effective_verdict: 'passed' }), 'execution-failed')
  assert.equal(runOutcome({ status: 'cancelled', effective_verdict: 'passed' }), 'cancelled')
  for (const status of ['running', 'queued', 'planned', 'recovering']) assert.equal(runOutcome({ status, effective_verdict: 'passed' }), 'unfinished')
  for (const status of [null, undefined, 'missing', 'unexpected']) assert.equal(runOutcome({ status }), 'unknown')
})

test('分布的分类计数完整覆盖本次记录，空数据没有虚构类别', () => {
  assert.equal(runOutcomeSegments([]).length, 0)
  const runs = [{ status: 'completed', effective_verdict: 'passed' }, { status: 'completed', effective_verdict: 'failed' }, { status: 'completed', effective_verdict: 'failed' }, { status: 'running' }, {}]
  const segments = runOutcomeSegments(runs)
  assert.equal(segments.reduce((sum, item) => sum + item.count, 0), runs.length)
  assert.equal(segments.find(item => item.key === 'failed').count, 2)
  assert.equal(segments.find(item => item.key === 'unknown').count, 1)
  assert.equal(segments.some(item => item.count <= 0), false)
})

test('智能体与评测概览共用逐例判定，混合或缺失观察不伪造失败', () => {
  assert.equal(caseObservation({ trials: [{ verdict: 'passed' }, { verdict: 'failed' }] }).value, 'mixed')
  assert.equal(caseObservation({ trials: [{ verdict: 'passed' }, {}] }).value, 'pending')
  assert.equal(caseObservation({ trials: [{ verdict: ['passed'] }] }).value, 'pending')
  assert.equal(caseObservation({ trials: [{ verdict: { toString: () => 'passed' } }] }).value, 'pending')
  assert.equal(caseObservation({ trials: [] }).value, 'pending')
  assert.equal(caseObservation({ review: { reviewed_verdict: 'inconclusive' }, trials: [{ verdict: 'failed' }] }).value, 'inconclusive')
  assert.equal(caseObservation({ review: { reviewed_verdict: 'invalid' }, trials: [{ verdict: 'passed' }] }).value, 'passed')
})

test('图表在真实React渲染中保留可读分类，零总数不生成无效SVG或进度比例', () => {
  const empty = renderToStaticMarkup(createElement(DistributionChart, { title: '用例观察', segments: [{ key: 'pending', label: '未记录结果', count: 0, tone: 'neutral' }], emptyText: '尚无逐例观察' }))
  assert.match(empty, /尚无逐例观察/)
  assert.match(empty, /未记录结果/)
  assert.doesNotMatch(empty, /NaN|Infinity/)
  const chart = renderToStaticMarkup(createElement(DistributionChart, { title: '实例状态', variant: 'bars', segments: [{ key: 'unknown', label: '状态未知', count: 2, tone: 'neutral' }], onSelect() {}, selectedKey: 'unknown' }))
  assert.match(chart, /aria-pressed="true"/)
  assert.match(chart, /type="button"/)
  assert.match(chart, /width:100%/)
  assert.match(chart, /状态未知/)
})

test('分类序列明确展示日期和状态，并把点击绑定到原记录身份', () => {
  const chosen = [], props = { title: '最近记录', items: [{ key: 'run-1', label: '10/29', status: '无法判定', tone: 'warning', description: '版本001' }], onSelect: key => chosen.push(key) }
  const tree = SequenceChart(props), html = renderToStaticMarkup(createElement(SequenceChart, props))
  assert.match(html, /10\/29，无法判定，版本001/)
  assert.match(html, />无法判定</)
  const button = tree.props.children[1].props.children[0].props.children
  button.props.onClick()
  assert.deepEqual(chosen, ['run-1'])
})
