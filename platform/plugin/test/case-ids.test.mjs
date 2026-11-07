import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: [new URL('../src/evaluation/case-ids.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' })
const { sceneCasePrefix, suggestCaseId, validateCaseIds } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const rows = (scene, ...ids) => ids.map(case_id => ({ scene, case_id }))

test('场景缩写只从合规编号推导，忽略旧占位号和多段编号并保留编号间隙', () => {
  const catalog = [...rows('巡检', 'U-INS-001', 'U-INS-011', 'U-NEW-008'), ...rows('资产告警', 'U-ASSET-ALERTS-001', 'U-ASSET-ALERTS-EMPTY')]
  assert.equal(suggestCaseId(catalog, '巡检'), 'U-INS-012')
  assert.equal(suggestCaseId(catalog, '资产告警'), '')
  assert.equal(suggestCaseId([...catalog, ...rows('资产告警', 'U-ASSET-004')], '资产告警'), 'U-ASSET-005')
  assert.equal(suggestCaseId(rows('仅占位', 'U-NEW-001'), '仅占位'), '')
  assert.equal(suggestCaseId([], '新场景'), '')
  assert.equal(sceneCasePrefix(rows('混合', 'U-INS-A', 'U-POL-A'), '混合'), undefined)
  assert.equal(sceneCasePrefix(rows('多词', 'U-THREAT-A-X', 'U-THREAT-B-X'), '多词'), undefined)
  assert.equal(suggestCaseId(rows('巡检', 'U-INS-999'), '巡检'), '')
  assert.equal(suggestCaseId([...rows('巡检', 'U-INS-001'), ...rows('其他', 'U-INS-008')], '巡检'), 'U-INS-009')
})

test('旧用例可读可修改；新增、改号和跨场景移动必须遵守所属场景缩写', () => {
  const before = [...rows('巡检', 'U-INS-001', 'U-NEW-008'), ...rows('策略', 'U-POL-001')]
  assert.doesNotThrow(() => validateCaseIds(before, before))
  const legacy = rows('资产告警', 'U-ASSET-ALERTS-001', 'U-ASSET-ALERTS-EMPTY')
  assert.doesNotThrow(() => validateCaseIds(legacy, legacy))
  assert.doesNotThrow(() => validateCaseIds(legacy, rows('资产告警', 'U-ASSET-001', 'U-ASSET-002')))
  assert.doesNotThrow(() => validateCaseIds(before, rows('巡检', 'U-INS-012')))
  assert.doesNotThrow(() => validateCaseIds(before, rows('新场景', 'U-TASK-001')))
  for (const id of ['U-NEW-002', 'U-XXX-001', 'U-POL-002']) assert.throws(() => validateCaseIds(before, rows('巡检', id)))
  assert.throws(() => validateCaseIds(before, rows('策略', 'U-INS-001')), /U-POL-/)
  assert.throws(() => validateCaseIds(before, rows('巡检', 'U-POL-002', 'U-EMG-002')), /U-INS-/)
  assert.throws(() => validateCaseIds([], rows('新场景', 'U-POL-002', 'U-EMG-002')), /用例编号必须/)
  const mixed = rows('待统一', 'U-INS-001', 'U-POL-002')
  assert.throws(() => validateCaseIds(mixed, [...mixed, ...rows('待统一', 'U-INS-003')]), /缩写不一致/)
  assert.doesNotThrow(() => validateCaseIds(mixed, rows('待统一', 'U-INS-001', 'U-INS-002')))
  for (const id of ['U-ASSET-ALERTS-002', 'U-ASSET-EMPTY', 'U-ASSET-000', 'U-ASSET-1', 'U-ASSET-1000', 'U-ASSET2-001']) {
    assert.throws(() => validateCaseIds([], rows('资产告警', id)), /三位数字/)
  }
})
