import assert from 'node:assert/strict'
import test from 'node:test'
import { scheduleCases, validateCaseSchedule } from './evaluation-case-scheduler.mts'

test('独立用例有界并发，写用例等待前组收尾且独占执行，输出保持原顺序', async () => {
  const cases = ['A', 'B', 'WRITE', 'C', 'D'].map(case_id => ({ case_id }))
  let active = 0, peak = 0
  const completed = []
  const value = await scheduleCases(cases, 2, ['A', 'B', 'C', 'D'], async ({ case_id }) => {
    if (case_id === 'WRITE') { assert.equal(active, 0); assert.deepEqual([...completed].sort(), ['A', 'B']) }
    if (case_id === 'C' || case_id === 'D') assert.ok(completed.includes('WRITE'))
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, case_id === 'A' ? 30 : 5))
    active--; completed.push(case_id)
    return { row: case_id }
  })
  assert.equal(peak, 2)
  assert.deepEqual(value.rows, cases.map(item => item.case_id))
})

test('归因失配停止发起后续用例，但收集已发出请求；停止用例不必是最后完成用例', async () => {
  const launched = []
  const value = await scheduleCases(['A', 'B', 'C', 'WRITE'].map(case_id => ({ case_id })), 2, ['A', 'B', 'C'], async ({ case_id }) => {
    launched.push(case_id)
    await new Promise(resolve => setTimeout(resolve, case_id === 'A' ? 5 : 20))
    return { row: case_id, ...(case_id === 'A' ? { stop_reason: 'identity-mismatch' } : {}) }
  })
  assert.deepEqual(launched, ['A', 'B'])
  assert.deepEqual(value, { rows: ['A', 'B'], stop_reason: 'identity-mismatch' })
})

test('未指定独立用例时保持串行；未知ID、重复ID及越界并发拒绝', async () => {
  const cases = ['A', 'B'].map(case_id => ({ case_id }))
  let active = 0
  await scheduleCases(cases, 8, [], async item => {
    assert.equal(active++, 0)
    await Promise.resolve(); active--
    return { row: item.case_id }
  })
  for (const [concurrency, ids] of [[0, []], [9, []], [1, ['X']], [1, ['A', 'A']]]) {
    assert.throws(() => validateCaseSchedule(cases, concurrency, ids), /invalid-case-schedule/)
  }
  await assert.rejects(scheduleCases(cases, 2, ['A', 'B'], async () => { throw new Error('save-failed') }), /save-failed/)
})
