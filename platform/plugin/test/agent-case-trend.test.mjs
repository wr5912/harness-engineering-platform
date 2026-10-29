import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const source = await build({ entryPoints: [new URL('../src/agents/case-trend.tsx', import.meta.url).pathname], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react', 'react/jsx-runtime'] })
const module = { exports: {} }
vm.runInNewContext(source.outputFiles[0].text, { module, exports: module.exports, require })
const { validCaseCounts, agentCaseTrendPoints, caseTrendLineSegments, AgentCaseTrend } = module.exports
const plain = value => JSON.parse(JSON.stringify(value))
const counts = value => ({ total: 0, passed: 0, failed: 0, inconclusive: 0, mixed: 0, pending: 0, ...value })
const run = (id, value, status = 'completed') => ({ run_id: id, status, created_at: `2026-10-${id === 'new' ? '29' : id === 'middle' ? '28' : '27'}T08:00:00Z`, case_counts: value })
function nodes(value) { if (Array.isArray(value)) return value.flatMap(nodes); if (!value || typeof value !== 'object') return []; return [value, ...nodes(value.props?.children)] }
function text(value) { if (Array.isArray(value)) return value.map(text).join(''); if (value && typeof value === 'object') return text(value.props?.children); return typeof value === 'boolean' ? '' : String(value ?? '') }

test('五类真实用例计数按Run先后形成1/2/1序列，不转换为通过率或总体结论', () => {
  const rows = [run('new', counts({ total: 1, mixed: 1 })), run('middle', counts({ total: 2, failed: 1, inconclusive: 1 })), run('old', counts({ total: 1, passed: 1 }))]
  const points = agentCaseTrendPoints(rows)
  assert.deepEqual(plain(points.map(point => [point.runId, point.counts.total, point.counts.passed, point.counts.failed, point.counts.inconclusive, point.counts.mixed])),
    [['old', 1, 1, 0, 0, 0], ['middle', 2, 0, 1, 1, 0], ['new', 1, 0, 0, 0, 1]])
  assert.deepEqual(plain(caseTrendLineSegments(points, 'failed')), [[{ index: 0, value: 0 }, { index: 1, value: 1 }, { index: 2, value: 0 }]])
  const tree = AgentCaseTrend({ points })
  assert.match(text(tree), /个选定用例/)
  assert.equal(nodes(tree).filter(node => node.type === 'polyline').length, 5)
})

test('最新详情只修正同一Run，保留其他Run索引计数，空详情不抹成零', () => {
  const rows = [run('new', counts({ total: 1, passed: 1 })), run('old', counts({ total: 2, passed: 2 }))]
  const detail = { run_id: 'new', cases: [{ trials: [{ verdict: 'failed' }] }, { trials: [] }] }
  const corrected = agentCaseTrendPoints(rows, rows[0], detail)
  assert.deepEqual(plain(corrected.map(point => point.counts)), [counts({ total: 2, passed: 2 }), counts({ total: 2, failed: 1, pending: 1 })])
  assert.equal(agentCaseTrendPoints(rows, rows[0], { ...detail, run_id: 'foreign' })[1].counts.passed, 1)
  assert.equal(agentCaseTrendPoints(rows, rows[0], { run_id: 'new', cases: [] })[1].counts.total, 1)
  assert.equal(agentCaseTrendPoints([run('new', null)], rows[0], { run_id: 'foreign', cases: detail.cases })[0].counts.total, 1)
})

test('缺失、非法或总量不符均留gap，禁止跨gap连线或补零', () => {
  for (const invalid of [null, {}, counts({ total: 2, passed: 1 }), counts({ total: 1, passed: -1, failed: 2 }), counts({ total: 1, passed: .5, failed: .5 })]) assert.equal(validCaseCounts(invalid), null)
  const points = agentCaseTrendPoints([run('new', counts({ total: 1, passed: 1 })), run('middle', null), run('old', counts({ total: 1, passed: 1 }))])
  assert.equal(points[1].counts, null)
  assert.deepEqual(plain(caseTrendLineSegments(points, 'passed')), [[{ index: 0, value: 1 }], [{ index: 2, value: 1 }]])
  const tree = AgentCaseTrend({ points })
  assert.equal(nodes(tree).filter(node => node.type === 'polyline').length, 0)
  assert.equal(nodes(tree).filter(node => node.props?.className === 'agent-case-trend-gap').length, 1)
  assert.match(text(tree), /未读取/)
})

test('只有一次有效计数画点而不造趋势，所有未知时也不画零曲线', () => {
  const one = AgentCaseTrend({ points: agentCaseTrendPoints([run('new', counts({ total: 1, failed: 1 }))]) })
  assert.equal(nodes(one).filter(node => node.type === 'polyline').length, 0)
  assert.equal(nodes(one).filter(node => node.type === 'circle').length, 5)
  assert.match(text(one), /仅有 1 次有效计数/)
  const missing = AgentCaseTrend({ points: agentCaseTrendPoints([run('new', null)]) })
  assert.equal(nodes(missing).filter(node => node.type === 'svg' && node.props.role === 'img').length, 0)
  assert.match(text(missing), /尚无有效用例计数/)
  const legend = nodes(missing).find(node => node.props?.className === 'agent-case-trend-legend')
  assert.equal(nodes(legend).filter(node => node.type === 'strong').every(node => text(node) === '—'), true)
})

test('真实零值保留五类数字与线型，日期入口可定位精确Run并说明部分观察', () => {
  const rows = [run('new', counts({ total: 1, passed: 1 }), 'running'), run('middle', counts({ total: 1, passed: 1 })), run('old', counts({ total: 2, passed: 2 }))]
  const points = agentCaseTrendPoints(rows), selected = []
  const tree = AgentCaseTrend({ points, onOpenRun: id => selected.push(id) })
  const legend = nodes(tree).find(node => node.props?.className === 'agent-case-trend-legend')
  assert.deepEqual(nodes(legend).filter(node => node.type === 'li').map(node => text(node)), ['通过1', '未通过0', '无法判定0', '结果不一致0', '未记录结果0'])
  assert.equal(nodes(tree).filter(node => node.type === 'polyline' && node.props.strokeDasharray).length, 4)
  const buttons = nodes(tree).filter(node => node.type === 'button')
  buttons[1].props.onClick()
  assert.deepEqual(selected, ['middle'])
  assert.match(buttons[2].props['aria-label'], /通过 1，未通过 0，无法判定 0，结果不一致 0，未记录结果 0/)
  assert.match(buttons[2].props['aria-label'], /未完整结束，仅为已记录观察/)
  assert.match(text(buttons[2]), /部分/)
})
