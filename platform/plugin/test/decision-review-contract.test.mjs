import assert from 'node:assert/strict'
import test from 'node:test'
import { validateDecisionTargets } from '../src/evaluation/decision-dataset-contract.ts'

const questions = { route: { type: 'choice', instructions: '下一步？', criteria: { read: '读取', ask: '澄清' } } }
const review = { kind: 'ai_delegated', session_id: 'synthetic-review-session', model: { provider: 'fixture', model: 'reviewer', reasoningEffort: null }, reviewed_at: '2026-10-29T00:00:00.000Z', purpose: 'functional_validation' }
const target = () => ({ label: 'read', basis: '合成材料依据', provenance: { kind: 'ai_annotation' }, status: 'reviewed', decision_time_reviewed: true, reviewed_at: review.reviewed_at, review: structuredClone(review) })

test('AI 复核合同保留原始模型字段、显式用途及来源，不升级成人工', () => {
  const value = validateDecisionTargets(questions, { route: target() }).route
  assert.deepEqual(value.review, review)
  assert.equal(value.provenance.kind, 'ai_annotation')
  assert.equal(value.probabilities, undefined)
  const manual = target(); manual.review = null
  assert.equal(validateDecisionTargets(questions, { route: manual }).route.review, undefined)
})

test('AI 复核拒绝未知方式、用途、缺身份及无效状态，旧版无review仍可读', () => {
  for (const patch of [{ kind: 'human' }, { purpose: 'gold' }, { session_id: '' }, { model: {} }, { reviewed_at: 'tomorrow' }, { reviewed_at: '2026-02-31T00:00:00.000Z' }, { reviewed_at: '2026-10-28T00:00:00.000Z' }]) {
    const item = target(); Object.assign(item.review, patch)
    assert.throws(() => validateDecisionTargets(questions, { route: item }))
  }
  const suggested = target(); suggested.status = 'suggested'
  assert.throws(() => validateDecisionTargets(questions, { route: suggested }), /状态无效/)
  const legacy = target(); delete legacy.review; legacy.provenance = { kind: 'model_suggestion' }
  assert.equal(validateDecisionTargets(questions, { route: legacy }).route.review, undefined)
})
