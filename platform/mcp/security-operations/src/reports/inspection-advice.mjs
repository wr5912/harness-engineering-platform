/**
 * 巡检建议单一事实源：按 reasonCode/业务状态生成建议、验证标准、执行边界与证据摘要。
 * 只读纯函数，不访问网络、不执行任何动作。公共 Markdown/HTML 与报告卡共用。
 */
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const list = value => Array.isArray(value) ? value : []
const text = value => ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : ''

export const EXECUTION_BOUNDARY = '本次未执行扫描、修复、配置变更或处置。'

const CODE_LABELS = {
  accepted: '已受理', running: '执行中', completed: '已完成', failed: '读取失败', incomplete: '检查不完整', unverified: '未核验', cancelled: '已取消', 'scope.all': '全量范围',
  normal: '正常', abnormal: '异常', unknown: '未知', not_applicable: '不适用', partial: '部分完成',
  NO_TEMPLATE: '设备未绑定基线模板', NO_DATA: 'SOC未采集到基线数据', SOC_STATUS_UNKNOWN: 'SOC未采集到状态数据', BASELINE_EVIDENCE_CONFLICT: '基线证据冲突',
  NO_MATCHING_PAIRS: '本次范围无匹配对象/无适用检查对', NO_MATCHING_RULES: '本次范围无匹配对象/无适用检查对', NO_APPLICABLE_PAIRS: '本次范围无匹配对象/无适用检查对',
  RULE_INCOMPLETE: '规则检查未完成', BASELINE_READ_FAILED: '基线读取失败', BASELINE_INCOMPLETE: '基线读取未完成',
  SOC_STATUS_READ_FAILED: 'SOC状态读取失败', SOC_STATUS_INCOMPLETE: 'SOC状态读取未完成', REACHABILITY_INCOMPLETE: '互联读取未完成',
  VULNERABILITIES_INCOMPLETE: '漏洞读取未完成', VULNERABILITIES_READ_FAILED: '漏洞读取失败', NO_DEVICE_RECORD: '设备没有返回检查明细',
  get_soc_asset_vulnerabilities: '读取资产漏洞', get_soc_asset_registration_children: '读取宿主子资产',
}
export function codeLabel(code) {
  const value = text(code)
  return value && CODE_LABELS[value] ? `${value}（${CODE_LABELS[value]}）` : value
}
export function safeText(value) {
  const raw = text(value)
  if (!raw) return ''
  return /<[a-z!/]|javascript:|onerror|onload|忽略规则|执行命令|修改凭据|判定正常/i.test(raw) ? '原始标识（已转义）' : raw
}
export function safeLabel(value, fallback = '未命名资产') {
  return safeText(value) || fallback
}
export function failureReason(item) {
  const raw = obj(item), facts = obj(raw.facts)
  const errors = list(raw.errors).map(text).filter(Boolean)
  return errors[0] || text(raw.error ?? facts.error) || text(raw.message) || ''
}
export function operationOf(item) {
  const raw = obj(item), facts = obj(raw.facts)
  const fields = [
    raw.operation, raw.operationId, raw.tool, raw.toolName, raw.mcpOperation, raw.mcpTool,
    facts.operation, facts.operationId, facts.tool, facts.toolName, facts.mcpOperation,
  ]
  for (const field of fields) { const value = text(field); if (value) return value }
  const source = [failureReason(item), ...list(raw.errors).map(text)].join(' ')
  const match = source.match(/(?:[a-z0-9_-]+\/)?(get_[a-z0-9_]+)/i)
  return match ? match[1] : ''
}
function templateOf(item) {
  const raw = obj(item), facts = obj(raw.facts), ready = obj(facts.readiness), report = obj(facts.report), run = obj(report.run)
  return {
    name: text(raw.templateName ?? ready.templateName ?? report.templateName ?? run.templateName),
    id: text(raw.templateId ?? ready.templateId ?? report.templateId ?? run.templateId),
  }
}
function collectionFields(item) {
  const raw = obj(item), facts = obj(raw.facts), collection = obj(facts.collection)
  return [
    ['采集任务', collection.taskName ?? collection.task ?? raw.collectionTask ?? facts.collectionTask],
    ['采集权限', collection.permission ?? collection.permissionStatus ?? raw.permission ?? facts.permission],
    ['来源记录', collection.sourceRecord ?? collection.source ?? raw.sourceRecord ?? facts.sourceRecord],
    ['最近采集时间', collection.lastCollectedAt ?? collection.lastCollectionTime ?? raw.lastCollectedAt ?? facts.lastCollectedAt],
  ].map(([name, value]) => [name, safeText(value)]).filter(([, value]) => value)
}
function findingCount(item) {
  const raw = obj(item)
  let count = 0
  for (const finding of list(raw.findings)) count += list(obj(finding).observations).length || 1
  count += list(raw.vulnerabilities).length + list(raw.records).length
  if (!count) for (const source of list(raw.sources)) count += Number(source?.records) || 0
  return count
}
function findingFacts(item) {
  const raw = obj(item), first = obj(list(raw.findings)[0])
  const record = obj(first.record ?? first)
  const severity = text(record.severity ?? record.severityName ?? record.riskLevel ?? record.risk_level)
  const source = text(record.sourceName ?? record.source ?? record.vendor)
  return { count: findingCount(item), severity, source }
}

/** 生成结构化建议；同一输入在公共报告和报告卡必须得到相同结果。 */
export function buildAdvice(kind, item, labelText = '') {
  if (!item && !labelText) return { advice: '', verification: '', executionBoundary: '', evidenceSummary: '', safeLabel: '', reasonCode: '', failed: false }
  const raw = obj(item), facts = obj(raw.facts), status = text(raw.status)
  const reason = text(raw.reasonCode ?? raw.notCheckedReason ?? obj(obj(facts.report).run).notCheckedReason ?? obj(facts.readiness).coverageReason)
  const online = text(raw.online ?? facts.online)
  const failure = failureReason(item), operation = operationOf(item)
  const failed = ['failed', 'incomplete', 'partial', 'not_executed', 'not_checked'].includes(status) || !!text(raw.error ?? facts.error) || list(raw.errors).length > 0
  const label = safeLabel(labelText)
  const boundary = EXECUTION_BOUNDARY
  if (kind === 'baseline' && reason === 'NO_TEMPLATE') {
    const template = templateOf(item)
    const actual = [template.name ? `模板${safeText(template.name)}` : '', template.id ? `templateId=${safeText(template.id)}` : ''].filter(Boolean)
    const verification = '重新读取到模板ID、适用检查项和对应基线结果。'
    return {
      advice: actual.length ? `请为设备绑定适用的基线模板：${actual.join('，')}` : '请在SOC核对并绑定适用的基线模板（当前未返回模板名称/ID）。',
      verification, executionBoundary: boundary,
      evidenceSummary: `模板名称：${safeText(template.name) || '未提供'}；模板ID：${safeText(template.id) || '未提供'}`,
      safeLabel: label, reasonCode: reason, failed: false,
    }
  }
  if (kind === 'baseline' && reason === 'NO_DATA') {
    const fields = collectionFields(item)
    const detail = fields.length ? `（${fields.map(([name, value]) => `${name}：${value}`).join('；')}）` : '（当前未返回采集任务、权限、来源记录或最近采集时间）'
    return {
      advice: `请核实并完善SOC基线采集配置${detail}`,
      verification: '出现新的有效采集记录和基线报告。', executionBoundary: boundary,
      evidenceSummary: fields.length ? fields.map(([name, value]) => `${name}：${value}`).join('；') : '未返回采集任务、权限、来源记录或最近采集时间',
      safeLabel: label, reasonCode: reason, failed: false,
    }
  }
  if (kind === 'status' && online === 'unknown') {
    const observed = text(obj(facts.stateEvidence).evaluatedAt ?? raw.observed_at)
    return {
      advice: '请核实SOC状态采集链路、心跳/上报配置及最近观测时间。',
      verification: '取得新的明确在线或离线观测记录；不据此推断当前在线状态。', executionBoundary: boundary,
      evidenceSummary: observed ? `最近观测时间：${safeText(observed)}` : '未返回最近观测时间',
      safeLabel: label, reasonCode: reason || 'SOC_STATUS_UNKNOWN', failed: false,
    }
  }
  if (kind === 'reachability' && ['NO_MATCHING_PAIRS', 'NO_MATCHING_RULES', 'NO_APPLICABLE_PAIRS'].includes(reason)) {
    return {
      advice: '当前范围无需修改规则或补充图层；如需继续核查，请提供适用对象/范围。',
      verification: '完整读取后仍无匹配对象即维持本结论；新增对象或范围变化时重新匹配。', executionBoundary: boundary,
      evidenceSummary: `源对象 ${text(facts.sourceCount) || '未提供'} 台；目的对象 ${text(facts.destinationCount) || '未提供'} 台`,
      safeLabel: label, reasonCode: reason, failed: false,
    }
  }
  if (kind === 'vulnerabilities' && status === 'abnormal') {
    const finding = findingFacts(item)
    return {
      advice: '请核对漏洞记录、影响资产、严重度和来源，完成复核并取得处置或接受风险记录。',
      verification: '完成逐条复核并取得处置或接受风险记录；本次未执行扫描或修复。', executionBoundary: boundary,
      evidenceSummary: [`漏洞记录：${finding.count} 条`, finding.severity ? `严重度：${safeText(finding.severity)}` : '', finding.source ? `来源：${safeText(finding.source)}` : ''].filter(Boolean).join('；'),
      safeLabel: label, reasonCode: reason, failed: false,
    }
  }
  if (failed) {
    const operationLabel = operation ? codeLabel(operation) : '操作名未返回'
    return {
      advice: `请核查受影响操作 ${operationLabel} 与资产${label}的连接授权、业务访问权限和重试条件。`,
      verification: '在授权范围内重试后取得明确成功结果或具体拒绝原因；不能用空结果或正常结论替代。', executionBoundary: boundary,
      evidenceSummary: `失败原因：${safeText(failure) || '未提供'}；受影响操作：${operationLabel}；资产：${label}`,
      safeLabel: label, reasonCode: reason, failed: true,
    }
  }
  if (kind === 'status' && online === 'offline') {
    return {
      advice: '按A1核对资产身份、维护计划和离线／心跳时间；地址无效时先核实真实地址。',
      verification: '取得新的在线和持续采集记录，受影响业务复测通过。', executionBoundary: boundary,
      evidenceSummary: '状态：离线', safeLabel: label, reasonCode: reason, failed: false,
    }
  }
  if (kind === 'reachability' && status === 'abnormal') {
    return {
      advice: '按A4核对规则要求、源目的服务及实际路径／策略证据。',
      verification: '应允许的业务可用，应阻断的访问被阻断。', executionBoundary: boundary,
      evidenceSummary: '规则异常结论已记录', safeLabel: label, reasonCode: reason, failed: false,
    }
  }
  if (kind === 'vulnerabilities' && status === 'normal') {
    return {
      advice: '完整读取后没有历史漏洞记录；当前无需处置。',
      verification: '如需确认当前风险，另行安排有效扫描；本结论不代表本次扫描。', executionBoundary: boundary,
      evidenceSummary: '漏洞记录：0 条', safeLabel: label, reasonCode: reason, failed: false,
    }
  }
  return { advice: '', verification: '', executionBoundary: boundary, evidenceSummary: '', safeLabel: label, reasonCode: reason, failed }
}


const EVIDENCE_REDACTION = /<script[\s\S]*?<\/script>|<img\b[^>]*>|javascript:|onerror|onload|忽略规则|执行命令|修改凭据/gi
/** 证据展示用安全JSON；保留结构，仅替换危险片段，原文语义以 [已转义] 标记。 */
export function safeEvidenceJson(value) {
  const serialized = JSON.stringify(value, null, 2) ?? '未记录'
  return serialized.replace(EVIDENCE_REDACTION, '[已转义]')
}
