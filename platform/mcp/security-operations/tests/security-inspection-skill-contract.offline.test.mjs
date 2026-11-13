import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.env.HARNESS_ASSET_ROOT, 'evolution/experiments/EXP-security-operations-expert-027-f-r3ba4799b0cb7/candidate/dsh/workspace/.agents/skills/security-inspection')
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8')
const reporting = readFileSync(join(root, 'references/reporting.md'), 'utf8')
const workflows = readFileSync(join(root, 'references/workflows.md'), 'utf8')

test('show_ui默认主展示且必须显式readonly true并有最小示例', () => {
  assert.match(skill, /纯巡检展示[^\n]*readonly: true/)
  assert.match(reporting, /readonly: true/)
  assert.match(reporting, /"readonly":true/)
  assert.match(reporting, /static/)
  assert.match(reporting, /不得声称“等待操作”/)
  assert.match(skill, /`readonly:true` 的紧凑展示是主展示/)
  assert.match(skill, /1–2 句中文结论/)
  assert.match(skill, /不得再列“结果要点”“主要问题”“检查摘要”/)
  assert.match(skill, /`show_ui` 不可用（返回 unsupported\/桥接坏且无静态展示）时，才进入 B/)
  assert.doesNotMatch(skill, /show_ui` 只能作为正文之外的可选补充/)
  assert.match(skill, /常规未包含漏洞检查写“本次未包含漏洞检查”/)
  assert.match(skill, /已有漏洞记录完整读取：没有漏洞（仅读已有SOC记录）/)
  assert.match(skill, /`NO_TEMPLATE` 是未绑定模板状态，不是正常/)
})

test('禁止调用未装载present并保留原生文件/导出回执路径', () => {
  for (const text of [skill, reporting]) {
    assert.match(text, /不要调用未装载的 `present`/)
    assert.match(text, /export_security_report/)
    assert.match(text, /原生文件|附件/)
  }
})

test('无可适用检查对是范围结论，不再与缺口混写', () => {
  assert.doesNotMatch(workflows, /LAYER_NOT_FOUND及没有完整检查对仍如实列可达性缺口/)
  assert.match(workflows, /完整成功读取\/匹配后无适用对象[^\n]*范围结论/)
  assert.match(workflows, /不归咎预置规则/)
  assert.match(workflows, /真正读取失败、未执行、主体\/证据冲突或必需证据缺失才列缺口/)
})
