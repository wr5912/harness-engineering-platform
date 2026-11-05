import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluationAgentName, evaluationObjectType, evaluationVersionLabel } from '../src/evaluation/object-identity.ts'

test('评测身份兼容VAR与历史EXP声明，不把缺失元数据猜成智能体', () => {
  const id = 'EXP-alpha-001-r123456abcdef'
  assert.equal(evaluationObjectType('VAR-alpha-001-r123456abcdef', []), '变体')
  assert.equal(evaluationObjectType(id, []), '待核对')
  assert.equal(evaluationObjectType(id, [{ id, status: 'unavailable', change: {} }]), '待核对')
  assert.equal(evaluationObjectType(id, [{ id, change: {} }]), '智能体')
  for (const change of [{ compute_variant: {} }, { variant_kind: 'exploratory' }, { variant_kind: 'end' }, { kind: 'end' }, { variant: 'end' }]) {
    assert.equal(evaluationObjectType(id, [{ id, change }]), '变体')
  }
  assert.equal(evaluationObjectType(id, [{ id, is_variant: true }]), '变体')
})

test('被测版本保留随机后缀和旧版身份，智能体名称优先使用所属对象声明', () => {
  assert.equal(evaluationVersionLabel('EXP-alpha-001-r123456abcdef'), 'v001-r123456abcdef')
  assert.equal(evaluationVersionLabel('VAR-alpha-001-rabcdef123456'), 'v001-rabcdef123456')
  assert.equal(evaluationVersionLabel('EXP-alpha-001'), 'v001')
  assert.equal(evaluationVersionLabel('unrecognized'), 'unrecognized')
  const agents = [{ id: 'alpha', name: '变体继承名称', manifest: { name: '所属智能体' } }]
  assert.equal(evaluationAgentName(agents, 'alpha'), '所属智能体')
  assert.equal(evaluationAgentName([], 'alpha'), 'alpha')
  assert.equal(evaluationAgentName([], null), '智能体未知')
})
