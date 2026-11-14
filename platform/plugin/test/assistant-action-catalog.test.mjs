import assert from 'node:assert/strict'
import test from 'node:test'
import { retiredResearchAction } from '../src/agents/action-status.ts'
import { assistantActions, assistantActionContract } from '../src/assistant/tool-contracts.ts'

test('管理助手仅提供可用的业务仓动作，不再引导调用停用的研究版本接口', () => {
  const retired = ['versions/migration-plan', 'versions/migration-apply', 'features/preview', 'fusion/prepare',
    'compute-variants/create', 'migrations/inspect', 'research/validate', 'decision/preview', 'decision/update', 'new', 'create']
  for (const action of retired) {
    assert.equal(retiredResearchAction(action), true, action)
    assert.equal(assistantActions.agents.includes(action), false, action)
    assert.throws(() => assistantActionContract('agents', action), /已停用/, action)
  }
  for (const action of assistantActions.agents) {
    assert.equal(retiredResearchAction(action), false, action)
    assert.equal(assistantActionContract('agents', action).action, action)
  }
  for (const action of ['business/list', 'business/detail', 'business/read', 'edit/read', 'edit/apply', 'eval/start', 'runs/report', 'documents/read']) {
    assert.equal(assistantActions.agents.includes(action), true, action)
  }
})

test('版本查询和编辑合同沿用业务 Harness 与 Git tag 的真实来源', () => {
  const detail = assistantActionContract('agents', 'detail')
  assert.equal(detail.input_schema.properties.source_id.type, 'string')
  assert.match(detail.instructions, /Git tag/)
  assert.doesNotMatch(detail.instructions, /mainline_id|active_experiment/)
  assert.match(assistantActionContract('agents', 'business/detail').instructions, /business-agents/)
  const edit = assistantActionContract('agents', 'edit/apply')
  assert.equal(edit.input_schema.properties.source_id.type, 'string')
  assert.match(edit.instructions, /Git tag 只读/)
})
