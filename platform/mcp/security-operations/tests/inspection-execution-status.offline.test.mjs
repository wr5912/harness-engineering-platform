import test from 'node:test'
import assert from 'node:assert/strict'
import { summary } from '../src/inspection/index.ts'
import { renderInspectionChatMarkdown } from '../src/reports/inspection-operations.ts'

const context = () => ({ runId: 'run-44444444-4444-4444-8444-444444444444', shared: { scope: { all: true, count: 1 }, connection_fingerprints: { master: 'fp' } } })

test('执行completed业务complete明确传递completed，不写unverified', () => {
  const result = summary('routine', [], context(), 'completed')
  assert.equal(result.execution_status, 'completed')
  assert.equal(result.status, 'completed')
  assert.equal(result.complete, true)
  const text = renderInspectionChatMarkdown(result)
  assert.match(text, /completed（已完成）/)
  assert.doesNotMatch(text, /unverified（未核验）/)
})

test('执行completed但业务incomplete仍分开呈现', () => {
  const result = summary('routine', [{ complete: false, status: 'unknown', assetId: 1 }], context(), 'completed')
  assert.equal(result.execution_status, 'completed')
  assert.equal(result.status, 'incomplete')
  assert.equal(result.complete, false)
  const text = renderInspectionChatMarkdown(result)
  assert.match(text, /执行状态：completed（已完成）/)
  assert.match(text, /整体结论：incomplete（检查不完整）/)
})

test('缺少执行元数据时诚实unknown，不硬编码completed', () => {
  const result = summary('routine', [], context())
  assert.equal(result.execution_status, 'unknown')
  const text = renderInspectionChatMarkdown(result)
  assert.match(text, /unknown（未知）/)
  assert.doesNotMatch(text, /执行状态：completed（已完成）/)
})
