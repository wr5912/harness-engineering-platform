import test from 'node:test'
import assert from 'node:assert/strict'
import { buildInspectionOperations, renderInspectionMarkdown, renderInspectionOperationsHtml } from '../src/reports/inspection-operations.ts'

const noMatch = (ruleId, sourceCount, destinationCount) => ({
  ruleId, ruleName: `规则${ruleId}`, ruleType: 'FORBIDDEN', status: 'not_applicable', reasonCode: 'NO_MATCHING_PAIRS', complete: true,
  message: '本次范围无匹配对象/无适用检查对', facts: { rule: { id: ruleId }, sourceCount, destinationCount },
})

test('无匹配规则按已取得范围说明，不冒充源目的待核实或A4缺口', () => {
  const raw = { kind: 'reachability', items: [noMatch(1, 0, 1), noMatch(3, 0, 0)] }
  const model = buildInspectionOperations(raw)
  assert.equal(model.rules.length, 2)
  assert.ok(model.rules.every(rule => rule.checks.every(check => check.disposition === 'no_applicable_pairs')))
  assert.equal(model.gapGroups.length, 0)
  assert.equal(model.plans.some(plan => plan.id === 'A4'), false)
  const markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  for (const body of [markdown, html]) {
    assert.match(body, /本次范围无匹配对象／无适用检查对/)
    assert.match(body, /源对象 0 台、目的对象 1 台/)
    assert.match(body, /不要求修改规则、绑定图层或补充对象/)
    assert.doesNotMatch(body, /源对象待核实|目的对象待核实/)
  }
  assert.doesNotMatch(markdown, /按A4核查/)
  assert.doesNotMatch(html, /参见A4/)
})

test('真实异常规则仍保留异常结论与A4提示', () => {
  const raw = { kind: 'reachability', items: [{ ruleId: 'R9', ruleName: '真实异常', ruleType: 'FORBIDDEN', status: 'abnormal', srcIp: '192.0.2.1', dstIp: '192.0.2.2', message: '路径可达且策略允许' }] }
  const markdown = renderInspectionMarkdown(raw), html = renderInspectionOperationsHtml(raw)
  assert.match(markdown, /按A4核查/)
  assert.match(html, /异常或缺口参见A4/)
  assert.match(html, /class="danger"/)
  assert.equal(buildInspectionOperations(raw).plans.some(plan => plan.id === 'A4'), true)
})
