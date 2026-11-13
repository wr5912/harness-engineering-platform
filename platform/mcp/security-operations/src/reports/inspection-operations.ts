import { isIP } from 'node:net'
import { escapeHtml as e, jsonText, safeProjection } from './common.ts'
import { buildAdvice, codeLabel as adviceCodeLabel, EXECUTION_BOUNDARY, failureReason, safeText } from './inspection-advice.mjs'

/** 只读、离线报告模型。标识和原结论不由报告层重判；不执行扫描或生成下载地址。 */
type Data = Record<string, any>
export type InspectionCheck = { id: string; kind: string; status: string; reason: string; message: string; evidence: Data; disposition?: 'soc_state' | 'no_applicable_pairs'; advice?: string; verification?: string; executionBoundary?: string; evidenceSummary?: string }
export type InspectionVulnerability = { id: string; identity: string; sourceAssetId?: string; record: Data; evidence: Data }
export type InspectionDevice = {
  id: string; number: string; assetId?: string; name: string; ips: string[]; address: string
  online: 'online' | 'offline' | 'unknown'; hasStatus: boolean; abnormal: boolean
  checks: InspectionCheck[]; vulnerabilities: InspectionVulnerability[]; problems: string[]; planIds: string[]; ruleIds: string[]
}
export type InspectionPlan = { id: string; title: string; appliesTo: string; firstStep: string; steps: string[]; branches: string[]; verification: string }
export type InspectionRule = { id: string; ruleId?: string; name: string; requirement: string; status: string; deviceIds: string[]; checks: InspectionCheck[] }
export type InspectionGap = { reason: string; label: string; deviceIds: string[]; ruleIds: string[]; checkIds: string[]; action: string; verification: string; advice?: string; executionBoundary?: string }
export type InspectionSocState = { reason: string; label: string; deviceIds: string[]; checkIds: string[]; action: string; advice?: string; verification?: string; executionBoundary?: string; evidenceSummary?: string }
export type InspectionOperations = {
  reportId?: string; runId?: string; kind: string; observedAt?: string; scope: Data; summary: string; coverageNotes: string[]
  devices: InspectionDevice[]; abnormalDevices: InspectionDevice[]; rules: InspectionRule[]; ruleReadChecks: InspectionCheck[]; gapGroups: InspectionGap[]; socStateGroups: InspectionSocState[]; plans: InspectionPlan[]
  counts: { devices: number; abnormalDevices: number; offlineDevices: number; vulnerabilityDevices: number; vulnerabilityRecords: number; rules: number | null; abnormalRules: number; gapDevices: number; gapRules: number; gapItems: number }
}
const obj = (v: any): Data => v && typeof v === 'object' && !Array.isArray(v) ? v : {}
const list = (v: any): any[] => Array.isArray(v) ? v : []
const text = (v: any): string => ['string', 'number', 'boolean'].includes(typeof v) ? String(safeProjection(String(v))) : ''
const unique = <T>(v: T[]): T[] => [...new Set(v)]
const secret = /password|passwd|token|api.?key|secret|private.?key|credential|authorization|cookie/i
const businessFields = new Set(('id vulnerabilityId vulnerability_id cve cveId cve_id cveIds name title description detail details severity severityName severityLevel riskLevel risk_level level score cvss cvssScore cvssVector cvssVersion recommendation recommendations solution solutions remediation fix fixSuggestion repairAdvice repairSuggestion advice suggestion suggestions references reference url source sourceId sourceName sourceAssetId assetId hostAssetId software softwareName product vendor version affectedVersion affectedVersions fixedVersion patch patchId port protocol service status state detectedAt firstSeenAt lastSeenAt observed_at observedAt recorded_at checked_at scanTime scan_time discoveryTime publishTime updatedAt createTime updateTime exploit evidence component path').split(' '))
/** 独立漏洞业务投影，不将原响应、凭据或未知嵌套对象直接公开。 */
function vulnerabilityRecord(value: any): Data {
  const ancestors = new Set<object>()
  const visit = (v: any, depth: number): any => {
    if (typeof v === 'string') return safeProjection(v)
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v
    if (!v || typeof v !== 'object') return undefined
    if (depth > 32 || ancestors.has(v)) return '[结构无法安全展开]'
    ancestors.add(v)
    let out: any
    if (Array.isArray(v)) out = v.map(x => visit(x, depth + 1)).filter(x => x !== undefined)
    else {
      out = Object.create(null)
      for (const [key, field] of Object.entries(v)) if (businessFields.has(key) && !secret.test(key)) {
        const projected = visit(field, depth + 1)
        if (projected !== undefined) out[key] = projected
      }
    }
    ancestors.delete(v)
    return out
  }
  return obj(visit(value, 0))
}
function assetId(value: any): string | undefined {
  const id = text(value).trim()
  if (!id || ['null', 'undefined', 'any', '-', '0'].includes(id.toLowerCase())) return undefined
  if (/^\d+$/.test(id)) return BigInt(id).toString() === '0' ? undefined : BigInt(id).toString()
  return id
}
const reasons: Record<string, string> = { NO_TEMPLATE: '设备未绑定基线模板', NO_DATA: 'SOC未采集到基线数据', SOC_STATUS_UNKNOWN: 'SOC未采集到状态数据', NO_DEVICE_RECORD: '冻结范围内设备没有返回检查明细', MISSING_ITEMS: '未返回检查明细数组' }
const plans: InspectionPlan[] = [
  { id: 'A1', title: '设备离线', appliesTo: 'SOC离线设备；不是已确认硬件故障', firstStep: '核对资产身份、维护计划和离线／心跳时间；地址无效时先核实真实地址',
    steps: ['同步复查关联业务访问、管理连接和采集心跳，记录各自时间。', '定位后恢复对应环节；重启或配置变更前明确业务影响、备份和回退方式。'],
    branches: ['业务、管理均正常而心跳异常：检查采集服务、上报连接与认证。', '业务正常、管理失败：检查管理路径与访问策略。', '业务失败、管理正常：检查服务监听、业务端口策略与应用依赖。', '业务、管理均失败：继续核对链路、电源和设备运行状态；不能直接认定硬件损坏。'],
    verification: '取得新的在线和持续采集记录，受影响业务复测通过；计划停机单独记录依据。' },
  { id: 'A2', title: '历史漏洞复核与修复', appliesTo: '关联的历史漏洞记录，当前待复核；原严重度不重分级', firstStep: '核实本机软件、版本与部署方式，逐项核对历史漏洞适用性',
    steps: ['逐条结合原修复建议与可信厂商公告确定适用补丁、升级版本或临时缓解；有原严重度时先核对严重、高危记录。', '适用条件一致且能共同修复的记录可合并变更，但保留逐设备、逐漏洞关联。', '验证兼容性、备份并明确回退条件，经授权实施后另行安排有效复扫和业务验证。'],
    branches: ['缺少版本或修复依据：先补查，不生成确定的补丁版本或修复命令。', '确认不适用：保存版本与适用性依据；需要缓解时区分临时缓解与正式修复。'],
    verification: '修复后的新扫描确认目标漏洞消除且业务正常；本报告仅展示历史记录，不发起扫描或宣称已经修复。' },
  { id: 'A3', title: '基线后续改善与整改', appliesTo: '未绑定、未采集状态的可选后续改善；真实基线缺口或已有不达标结论另行核查', firstStep: '核对本机已取得的SOC状态、设备类型及已有基线结论',
    steps: ['取得有效报告后逐项展示检查项、实际值和要求值，依据不合规项制定整改并重新核查。', '采集或变更前核对授权、影响与回退条件；保留本机独立复核结果。'],
    branches: ['设备未绑定基线模板：后续按需核对系统与服务、选择适用模板；绑定和采集不是完成本次巡检的前提。', 'SOC未采集到基线数据：后续按需检查采集条件并安排采集；不要求补采才能完成本次巡检。', '报告无效或主体不符：核对资产、模板和检测时间，重新取得有效报告。', '确认不适用：记录适用性依据，不能计为通过。'],
    verification: '如另行实施改善或整改，以对应本机的新报告、实际检查项、有效值、时间和结论复核；未绑定、未采集是已取得的SOC状态，不属本次未完成，也不计正常或通过。' },
  { id: 'A4', title: '业务规则异常', appliesTo: '规则或连接关系异常，不等同单台设备故障', firstStep: '核对规则要求、源、目的、服务及实际路径／策略证据',
    steps: ['在授权范围内验证实际访问，明确区分配置关系判断与应用实测。', '确认原因后按最小范围修正配置，明确影响、备份与回退条件。'],
    branches: ['模型显示同网段二层直达且无中间过滤：先核实拓扑和隔离要求，再评估端口隔离、VLAN或主机访问控制。', '缺少图层、选择器、路径或策略依据：先补齐证据后重检，不把模型路径结论当作应用实测。'],
    verification: '应允许的业务可用，应阻断的访问被阻断，关联合法业务不受影响。' },
]
function sourceSections(result: Data): Array<{ kind: string; source: Data }> {
  if (result.checks && typeof result.checks === 'object' && !Array.isArray(result.checks)) return Object.entries(result.checks).map(([kind, value]) => ({ kind: text(obj(value).kind) || kind, source: obj(value) }))
  return [{ kind: text(result.kind) || 'inspection', source: result }]
}
function gapGuidance(reason: string, kind: string): { action: string; verification: string } {
  if (kind === 'baseline' || ['NO_TEMPLATE', 'NO_DATA'].includes(reason)) return { action: reason === 'NO_TEMPLATE' ? '按A3核对设备类型与适用模板后重新核查' : reason === 'NO_DATA' ? '按A3核对本机缺失项、权限与采集服务，补采后重查' : '按A3核实报告主体、模板、实际项与结论后重查', verification: plans[2].verification }
  if (kind === 'reachability') return { action: '按A4补齐规则选择器、图层及路径／策略证据后重检', verification: plans[3].verification }
  if (kind === 'status') return { action: '核对SOC状态数据源、采集连接与时间，取得新的权威状态记录', verification: 'SOC返回明确online或offline及对应观测记录；不能用探测替代SOC状态。' }
  return { action: '核对本次读取错误和缺失来源，在授权范围内补齐当前报告所缺证据', verification: '返回与本机或规则匹配的完整结构化记录及明确读取结果。' }
}
/** 业务状态与读取失败分开：403等真实错误不能被空模板或未采集原因覆盖。 */
function hasReadFailure(item: Data): boolean {
  const facts = obj(item.facts)
  return ['failed', 'partial', 'incomplete', 'not_executed', 'not_checked'].includes(text(item.status)) || [item, facts, obj(facts.report), obj(facts.readiness)].some(value => !!value.error || list(value.errors).length > 0)
}
function baselineSocReason(item: Data): string {
  if (hasReadFailure(item)) return ''
  const facts = obj(item.facts), report = obj(facts.report), ready = obj(facts.readiness), run = obj(report.run)
  const reason = text(item.reasonCode ?? item.notCheckedReason ?? run.notCheckedReason ?? ready.coverageReason)
  // 原子合同的显式null表示未绑定；缺字段不作null。真实报告或明确结论不能被覆盖。
  const hasReport = Object.keys(run).some(key => !['assetId', 'templateId', 'notCheckedReason'].includes(key)) || run.passFlag != null || item.passFlag != null || report.passFlag != null || ['normal', 'abnormal'].includes(text(item.status)) || ['BASELINE_EVIDENCE_CONFLICT', 'BASELINE_ASSET_MISMATCH', 'BASELINE_TEMPLATE_MISMATCH', 'INVALID_BASELINE_REPORT', 'INVALID_BASELINE_EVIDENCE'].includes(reason)
  if (!hasReport && (reason === 'NO_TEMPLATE' || [item, report, ready].some(value => Object.hasOwn(value, 'templateId') && value.templateId === null))) return 'NO_TEMPLATE'
  return reason === 'NO_DATA' && !hasReport ? 'NO_DATA' : ''
}
function noApplicablePairs(item: Data): boolean {
  const reason = text(item.reasonCode)
  return !hasReadFailure(item) && (['NO_MATCHING_PAIRS', 'NO_MATCHING_RULES', 'NO_APPLICABLE_PAIRS'].includes(reason) || !reason && /no matching|未匹配到规则的完整检查对|规则只匹配同一地址，未生成跨地址检查对/i.test(text(item.message)))
}
function checkMessage(item: Data, kind: string): { message: string; reason: string; online?: InspectionDevice['online'] } {
  if (kind === 'status') {
    // SOC字段权威，不能由状态检查的abnormal或路径、心跳信号推导online。
    const raw = item.online ?? obj(item.facts).online
    const online = raw === 'online' || raw === 'offline' ? raw : 'unknown'
    if (online === 'unknown' && hasReadFailure(item)) return { online, message: safeText(failureReason(item)) || 'SOC状态读取失败或未执行', reason: text(item.reasonCode) || 'SOC_STATUS_READ_FAILED' }
    return { online, message: online === 'online' ? '在线' : online === 'offline' ? '离线' : reasons.SOC_STATUS_UNKNOWN, reason: online === 'unknown' ? 'SOC_STATUS_UNKNOWN' : text(item.reasonCode) }
  }
  const reason = (kind === 'baseline' ? baselineSocReason(item) : '') || text(item.reasonCode ?? item.notCheckedReason ?? obj(obj(item.facts).report).run?.notCheckedReason ?? obj(obj(item.facts).readiness).coverageReason)
  if (hasReadFailure(item)) {
    const base = safeText(text(item.message)), detail = safeText(failureReason(item))
    const message = base && detail && !base.includes(detail) ? `${base}：${detail}` : base || detail || '读取失败，未提供原因'
    return { message: kind === 'baseline' ? `基线读取失败：${message}` : message, reason: reason || (kind === 'vulnerabilities' ? 'VULNERABILITIES_INCOMPLETE' : `${kind.toUpperCase()}_READ_FAILED`) }
  }
  return { message: reasons[reason] || safeText(text(item.message)) || '未提供检查说明', reason }
}
function vulnerabilities(item: Data, checkId: string): InspectionVulnerability[] {
  const out: InspectionVulnerability[] = []
  const add = (record: any, identity: string, source: any, evidence: any) => out.push({ id: `${checkId}:V${out.length + 1}`, identity: /^[\s]*[\[{"']/.test(identity) ? '' : identity, ...(assetId(source) ? { sourceAssetId: assetId(source) } : {}), record: vulnerabilityRecord(record), evidence: obj(safeProjection(evidence)) })
  for (const finding of list(item.findings)) {
    const f = obj(finding), observations = list(f.observations)
    if (observations.length) for (const observation of observations) {
      const o = obj(observation)
      add(o.record, text(f.identity), o.sourceAssetId, { ...f, observations: [o] })
    } else add(f.record ?? f, text(f.identity ?? f.id ?? f.cveId), f.sourceAssetId, f)
  }
  for (const key of ['vulnerabilities', 'records']) for (const record of list(item[key])) add(record, text(obj(record).id ?? obj(record).cveId), item.assetId, record)
  // 原始来源形态与assess后的sources.records计数形态均可使用，不把计数当明细。
  if (!out.length) for (const source of list(item.sources)) for (const record of list(obj(source).records)) add(record, text(obj(record).id ?? obj(record).cveId), obj(source).assetId, source)
  return out
}
function severitySummary(device: InspectionDevice): string {
  const counts = new Map<string, number>()
  for (const vulnerability of device.vulnerabilities) {
    const record = vulnerability.record, severity = text(record.severity ?? record.riskLevel ?? record.risk_level ?? record.severityName ?? record.severityLevel ?? record.level)
    if (severity !== '') counts.set(severity, (counts.get(severity) ?? 0) + 1)
  }
  return counts.size ? `（原严重度：${[...counts].map(([key, count]) => `${key} ${count}条`).join('、')}）` : ''
}

export function buildInspectionOperations(result: Record<string, any>): InspectionOperations {
  const raw = obj(result), scope = obj(safeProjection(raw.scope)), devices: InspectionDevice[] = [], byId = new Map<string, InspectionDevice>()
  const rules: InspectionRule[] = [], byRule = new Map<string, InspectionRule>(), gaps = new Map<string, InspectionGap>()
  const ruleReadChecks: InspectionCheck[] = [], coverageNotes: string[] = [], socStates = new Map<string, InspectionSocState>()
  const sections = sourceSections(raw), expectedKinds = ['deep', 'routine'].includes(text(raw.kind)) ? ['status', 'baseline', 'reachability', ...(raw.kind === 'deep' ? ['vulnerabilities'] : [])] : []
  const ensureDevice = (value: Data, fallback: string): InspectionDevice => {
    const id = assetId(value.assetId ?? value.asset_id), key = id ? `asset:${id}` : `unidentified:${fallback}`
    let device = byId.get(key)
    if (!device) {
      device = { id: key, number: `D${String(devices.length + 1).padStart(2, '0')}`, ...(id ? { assetId: id } : {}), name: '', ips: [], address: '', online: 'unknown', hasStatus: false, abnormal: false, checks: [], vulnerabilities: [], problems: [], planIds: [], ruleIds: [] }
      byId.set(key, device); devices.push(device)
    }
    const name = safeText(text(safeProjection(value.hostname ?? value.assetName ?? value.asset_name ?? value.name)))
    if (!device.name && name) device.name = name
    const ip = text(safeProjection(value.ip ?? value.primary_ip)).trim()
    if (ip && !device.ips.includes(ip)) device.ips.push(ip)
    return device
  }
  const addGap = (reason: string, label: string, kind: string, checkId: string, deviceId?: string, ruleId?: string, advice?: string, verification?: string) => {
    const key = reason || `${kind}:UNKNOWN`, existing = gaps.get(key)
    const guidance = gapGuidance(reason, kind)
    const group = existing ?? { reason: key, label, deviceIds: [], ruleIds: [], checkIds: [], ...guidance, advice: advice || (/INCOMPLETE|READ_FAILED/.test(reason) ? '请核查受影响操作与资产的连接授权、业务访问权限和重试条件。' : guidance.action), verification: verification || guidance.verification, executionBoundary: EXECUTION_BOUNDARY }
    if (deviceId && !group.deviceIds.includes(deviceId)) group.deviceIds.push(deviceId)
    if (ruleId && !group.ruleIds.includes(ruleId)) group.ruleIds.push(ruleId)
    if (!group.checkIds.includes(checkId)) group.checkIds.push(checkId)
    if (!existing) gaps.set(key, group)
  }
  const frozenIds = unique(list(obj(raw.scope).assetIds).map(assetId).filter((id): id is string => !!id))
  for (const id of frozenIds) ensureDevice({ assetId: id }, '')
  for (const kind of expectedKinds) if (!sections.some(section => section.kind === kind)) {
    addGap('MISSING_SECTION', `未返回${kind}检查维度`, kind, `section:${kind}`)
    coverageNotes.push(`未返回${kind}检查维度，不能据此声称巡检完整。`)
  }
  let checkIndex = 0
  for (const { kind, source } of sections) {
    if (!Array.isArray(source.items)) { addGap('MISSING_ITEMS', `${kind}：${reasons.MISSING_ITEMS}`, kind, `section:${kind}`); continue }
    for (const [index, value] of source.items.entries()) {
      const item = obj(value), id = `check:${checkIndex++}`, mapped = checkMessage(item, kind)
      const projectedEvidence = obj(safeProjection(item))
      for (const field of ['srcAssetId', 'dstAssetId']) if (assetId(item[field])) projectedEvidence[field] = assetId(item[field])
      const labelText = [text(item.hostname ?? item.assetName ?? item.name), text(item.ip), assetId(item.assetId ?? item.asset_id) ? `资产 ${assetId(item.assetId ?? item.asset_id)}` : ''].filter(Boolean).join('／')
      const guidance = buildAdvice(kind, item, labelText)
      const check: InspectionCheck = { id, kind, status: text(item.status) || 'unknown', reason: text(safeProjection(mapped.reason)), message: text(safeProjection(mapped.message)), evidence: projectedEvidence, advice: guidance.advice, verification: guidance.verification, executionBoundary: guidance.executionBoundary, evidenceSummary: guidance.evidenceSummary }
      if (kind === 'reachability' && noApplicablePairs(item)) {
        check.disposition = 'no_applicable_pairs'; check.message = '无适用检查对；规则已完整读取，不计正常或通过'
        const facts = obj(item.facts)
        for (const [key, value] of [['sourceCount', facts.sourceCount ?? item.sourceCount], ['destinationCount', facts.destinationCount ?? item.destinationCount]] as const) if (Number.isFinite(value)) check.evidence[key] = value
      }
      if (kind === 'reachability' || item.ruleId != null || item.rule_id != null) {
        const rid = text(item.ruleId ?? item.rule_id ?? obj(obj(item.facts).rule).id), key = rid ? `rule:${rid}` : `connection:${id}`
        if (!rid && !text(item.srcIp) && !text(item.dstIp) && !['normal', 'abnormal'].includes(check.status)) {
          ruleReadChecks.push(check)
          if (check.disposition !== 'no_applicable_pairs') addGap(check.reason || 'RULE_READ_INCOMPLETE', check.message, kind, id, undefined, undefined, check.advice, check.verification)
          continue
        }
        let rule = byRule.get(key)
        if (!rule) {
          const type = item.ruleType ?? obj(obj(item.facts).rule).ruleType
          rule = { id: key, ...(rid ? { ruleId: rid } : {}), name: safeText(text(safeProjection(item.ruleName ?? obj(obj(item.facts).rule).name))) || '未命名规则／连接', requirement: type === 'REQUIRED' ? '应允许' : type === 'FORBIDDEN' ? '应阻断' : '规则要求待核实', status: check.status, deviceIds: [], checks: [] }
          byRule.set(key, rule); rules.push(rule)
        }
        rule.checks.push(check)
        if (check.status === 'abnormal') rule.status = 'abnormal'
        else if (rule.status !== 'abnormal' && check.status !== 'normal') rule.status = check.status
        if (check.disposition !== 'no_applicable_pairs' && (hasReadFailure(item) || !['normal', 'abnormal', 'not_applicable'].includes(check.status))) addGap(mapped.reason || 'RULE_INCOMPLETE', mapped.message, kind, id, undefined, rule.id, check.advice, check.verification)
        continue
      }
      const device = ensureDevice(item, `${kind}:${index}`)
      device.checks.push(check)
      if (kind === 'status') {
        device.hasStatus = true
        const online = mapped.online!
        // 同一冻结结果中若SOC状态冲突，保留各记录，汇总未知而不择一覆盖。
        const previous = device.checks.filter(c => c.kind === 'status').slice(0, -1)
        device.online = previous.length && device.online !== online ? 'unknown' : online
        if (device.online === 'unknown' && previous.some(c => c.evidence.online !== mapped.online && obj(c.evidence.facts).online !== mapped.online)) addGap('SOC_STATUS_CONFLICT', '同一设备SOC状态记录不一致，需核对时间', kind, id, device.id)
      }
      const records = kind === 'vulnerabilities' ? vulnerabilities(item, id) : []
      device.vulnerabilities.push(...records)
      const socReason = kind === 'status' && mapped.online === 'unknown' && !hasReadFailure(item) ? 'SOC_STATUS_UNKNOWN' : kind === 'baseline' ? baselineSocReason(item) : ''
      if (socReason) {
        check.disposition = 'soc_state'
        const socGuidance = buildAdvice(socReason === 'SOC_STATUS_UNKNOWN' ? 'status' : 'baseline', item, device.label)
        const group = socStates.get(socReason) ?? { reason: socReason, label: reasons[socReason], deviceIds: [], checkIds: [], action: socGuidance.advice, advice: socGuidance.advice, verification: socGuidance.verification, executionBoundary: socGuidance.executionBoundary, evidenceSummary: socGuidance.evidenceSummary }
        group.deviceIds = unique([...group.deviceIds, device.id]); group.checkIds.push(id); socStates.set(socReason, group)
      }
      const isGap = !socReason && (hasReadFailure(item) || (kind === 'status' ? mapped.online === 'unknown' : !['normal', 'abnormal', 'not_applicable'].includes(check.status)))
      if (isGap) addGap(hasReadFailure(item) && ['NO_TEMPLATE', 'NO_DATA', 'SOC_STATUS_UNKNOWN'].includes(mapped.reason) ? `${kind.toUpperCase()}_READ_FAILED` : mapped.reason || `${kind.toUpperCase()}_INCOMPLETE`, mapped.message, kind, id, device.id, undefined, check.advice, check.verification)
      if (kind === 'status') { if (mapped.online === 'offline') device.abnormal = true }
      else if (!isGap && check.status === 'abnormal' || records.length > 0) device.abnormal = true
      if (kind === 'status') {
        if (mapped.online !== 'online') device.problems.push(check.message)
      } else if (isGap || kind !== 'vulnerabilities' && check.status !== 'normal' || kind === 'vulnerabilities' && !records.length && check.status !== 'normal') device.problems.push(check.message)
      if (kind === 'status' && mapped.online === 'offline') device.planIds.push('A1')
      if (kind === 'vulnerabilities' && records.length) device.planIds.push('A2')
      if (kind === 'baseline' && (socReason || isGap || check.status === 'abnormal')) device.planIds.push('A3')
    }
  }
  for (const device of devices) {
    device.name ||= device.assetId ? `资产 ${device.assetId}` : '未提供设备名称（缺少稳定资产ID，不按IP归并）'
    device.address = device.ips.length ? device.ips.map(ip => isIP(ip) ? ip : `地址待核实（源值：${ip}）`).join('、') : '地址待核实'
    if (!device.checks.length) { device.problems.push(reasons.NO_DEVICE_RECORD); addGap('NO_DEVICE_RECORD', reasons.NO_DEVICE_RECORD, 'inspection', `device:${device.id}`, device.id) }
    if (device.vulnerabilities.length) device.problems.push(`历史漏洞${device.vulnerabilities.length}条，当前待复核${severitySummary(device)}`)
    device.problems = unique(device.problems); device.planIds = unique(device.planIds)
  }
  // 关系关联不改变设备异常口径；IP只有唯一候选时才用于关联，不用于资产合并。
  for (const rule of rules) for (const check of rule.checks) {
    const item = check.evidence
    for (const side of ['src', 'dst']) {
      const explicit = assetId(item[`${side}AssetId`]), ip = text(item[`${side}Ip`])
      const candidates = explicit ? devices.filter(d => d.assetId === explicit) : ip && isIP(ip) ? devices.filter(d => d.ips.includes(ip)) : []
      if (candidates.length === 1) { const d = candidates[0]; rule.deviceIds = unique([...rule.deviceIds, d.id]); d.ruleIds = unique([...d.ruleIds, rule.id]) }
    }
  }
  const declaredCount = obj(raw.scope).count
  if (Number.isSafeInteger(declaredCount) && declaredCount >= 0) {
    if (Array.isArray(obj(raw.scope).assetIds) && declaredCount !== frozenIds.length) coverageNotes.push(`范围声明${declaredCount}台，冻结assetIds有效去重数${frozenIds.length}台，数量不一致。`)
    if (declaredCount !== devices.length) coverageNotes.push(`范围声明${declaredCount}台，当前可识别设备${devices.length}台，覆盖数量不一致。`)
  } else coverageNotes.push('范围设备总数未提供或无效，不能确认完整覆盖。')
  if (frozenIds.length) {
    const unexpected = devices.filter(d => d.assetId && !frozenIds.includes(d.assetId))
    if (unexpected.length) coverageNotes.push(`${unexpected.length}台有检查记录的设备不在冻结assetIds中，需核对范围。`)
  }
  for (const [index, note] of coverageNotes.entries()) if (note.includes('不一致') || note.includes('不在冻结')) addGap('SCOPE_MISMATCH', note, 'inspection', `scope:${index}`)
  const ruleSection = sections.find(s => s.kind === 'reachability')
  const rulesUnknown = expectedKinds.includes('reachability') && !ruleSection || !!ruleSection && !Array.isArray(ruleSection.source.items) || ruleReadChecks.some(c => c.disposition !== 'no_applicable_pairs') || rules.some(r => !r.ruleId)
  if (rulesUnknown) coverageNotes.push('业务规则总数未取得；无规则标识的读取失败或连接记录不能作为规则数。')
  const abnormalDevices = devices.filter(d => d.abnormal), gapGroups = [...gaps.values()]
  const gapDeviceList = unique(gapGroups.flatMap(g => g.deviceIds)), gapRuleList = unique(gapGroups.flatMap(g => g.ruleIds)), gapOnly = gapGroups.filter(g => !g.deviceIds.length && !g.ruleIds.length).length
  const counts = { devices: devices.length, abnormalDevices: abnormalDevices.length, offlineDevices: devices.filter(d => d.online === 'offline').length, vulnerabilityDevices: devices.filter(d => d.vulnerabilities.length).length, vulnerabilityRecords: devices.reduce((n, d) => n + d.vulnerabilities.length, 0), rules: rulesUnknown ? null : rules.length, abnormalRules: rules.filter(r => r.ruleId && r.status === 'abnormal').length, gapDevices: gapDeviceList.length, gapRules: gapRuleList.length, gapItems: gapDeviceList.length + gapRuleList.length + gapOnly }
  const focus = [counts.offlineDevices ? '设备离线' : '', counts.vulnerabilityRecords ? '历史漏洞待复核' : '', abnormalDevices.some(d => d.checks.some(c => c.kind === 'baseline' && c.status === 'abnormal')) ? '基线不达标记录' : ''].filter(Boolean)
  const priority = [
    counts.offlineDevices ? '核对离线原因与心跳' : '',
    abnormalDevices.some(d => d.checks.some(c => c.kind === 'baseline' && c.status === 'abnormal')) ? '核查基线不达标项' : '',
    counts.vulnerabilityRecords ? '复核历史漏洞适用性' : '',
    counts.abnormalRules ? '核对规则路径与策略证据' : '',
  ].filter(Boolean)
  const summary = `本次已记录${counts.devices}台设备，设备异常记录涉及${counts.abnormalDevices}台${counts.offlineDevices ? `，其中${counts.offlineDevices}台离线` : ''}${counts.vulnerabilityRecords ? `；${counts.vulnerabilityDevices}台关联${counts.vulnerabilityRecords}条历史漏洞记录，当前待复核` : ''}${counts.abnormalRules ? `；另有${counts.abnormalRules}条业务规则异常` : ''}。${focus.length ? `问题集中在${focus.join('、')}，建议优先${priority.join('、') || '核对本机证据'}。` : '仅依据已返回记录判断，缺失结果不代表正常。'}`
  const usedPlans = new Set(devices.flatMap(d => d.planIds)); if (rules.some(r => r.checks.some(c => c.disposition !== 'no_applicable_pairs' && !['normal', 'not_applicable'].includes(c.status)))) usedPlans.add('A4')
  return { ...(text(raw.reportId ?? raw.report_id) ? { reportId: text(safeProjection(raw.reportId ?? raw.report_id)) } : {}), ...(text(raw.runId ?? raw.run_id) ? { runId: text(safeProjection(raw.runId ?? raw.run_id)) } : {}), kind: text(raw.kind), ...(text(raw.generatedAt ?? raw.generated_at) ? { observedAt: text(raw.generatedAt ?? raw.generated_at) } : {}), scope, summary, coverageNotes, devices, abnormalDevices, rules, ruleReadChecks, gapGroups, socStateGroups: [...socStates.values()], plans: plans.filter(p => usedPlans.has(p.id)), counts }
}

/** 所有动态文本转义HTML、Markdown控制符、管道和换行；不注入HTML换行。 */
function md(value: any): string {
  return e(text(value)).replace(/\\/g, '&#92;').replace(/\r\n|[\r\n\u2028\u2029]/g, ' ／ ').replace(/([`*_\[\]{}!>~])/g, '\\$1').replace(/\|/g, '&#124;')
}
function displayStatus(value: string): string { return ({ normal: '正常', abnormal: '异常', unknown: '未知', failed: '读取失败', not_applicable: '不适用', partial: '部分完成', incomplete: '未完成' } as Record<string, string>)[value] ?? '结论待核实' }
function checkStatus(check: InspectionCheck): string { return check.disposition === 'soc_state' ? '已取得的SOC状态（不计正常或通过）' : check.disposition === 'no_applicable_pairs' ? '无适用检查对（不计正常或通过）' : displayStatus(check.status) }
function ruleStatus(rule: InspectionRule): string { return rule.checks.every(c => c.disposition === 'no_applicable_pairs') ? '无适用检查对（不计正常或通过）' : displayStatus(rule.status) }
function checkTone(check: InspectionCheck): 'danger' | 'warning' | '' {
  if (check.disposition === 'no_applicable_pairs') return ''
  if (['NO_TEMPLATE', 'NO_DATA'].includes(check.reason)) return 'warning'
  if (check.kind === 'status') return check.message === '离线' ? 'danger' : check.message === '在线' ? '' : 'warning'
  return check.status === 'abnormal' ? 'danger' : check.status === 'normal' ? '' : 'warning'
}
function problemTone(device: InspectionDevice, problem: string): 'danger' | 'warning' | '' {
  if (problem.startsWith('历史漏洞') && device.vulnerabilities.length) return 'danger'
  const checks = device.checks.filter(c => c.message === problem)
  if (checks.some(c => checkTone(c) === 'warning')) return 'warning'
  return checks.some(c => checkTone(c) === 'danger') ? 'danger' : 'warning'
}
function problemsHtml(device: InspectionDevice): string {
  return device.problems.map(problem => problemTone(device, problem) === 'danger' ? `<strong class="danger">${e(problem)}</strong>` : `<span class="warning">${e(problem)}</span>`).join('；')
}
function problemsMarkdown(device: InspectionDevice): string {
  return device.problems.map(problem => problemTone(device, problem) === 'danger' ? `**${md(problem)}**` : md(problem)).join('；')
}
function summaryMarkdown(model: InspectionOperations): string { return md(model.summary).replace(/(\d+)(台|条)/g, '**$1$2**') }
function deviceLabel(d: InspectionDevice): string { return `${d.name}／${d.address}${d.assetId ? `（资产 ${d.assetId}）` : ''}` }
function firstSteps(d: InspectionDevice, model: InspectionOperations): string { return d.planIds.map(id => `${id}：${model.plans.find(p => p.id === id)?.firstStep ?? ''}`).join('；') || '核对本机证据后明确处理方案' }
function ruleConnection(check: InspectionCheck): string {
  const item = check.evidence
  if (check.disposition === 'no_applicable_pairs') {
    const source = Number.isFinite(item.sourceCount) ? item.sourceCount : undefined, destination = Number.isFinite(item.destinationCount) ? item.destinationCount : undefined
    return `本次范围无匹配对象／无适用检查对${source !== undefined || destination !== undefined ? `（源对象 ${source ?? '未提供'} 台、目的对象 ${destination ?? '未提供'} 台）` : ''}`
  }
  return `${text(item.srcIp) || '源对象待核实'} → ${text(item.dstIp) || '目的对象待核实'}${item.protocol ? `；协议 ${text(item.protocol)}` : ''}${item.port != null ? `；端口 ${text(item.port)}` : ''}`
}
/** 必须保留英文原因码时统一显示为“英文（中文说明）”。 */
const codeLabel = adviceCodeLabel
const KIND_LABELS: Record<string, string> = { status: '设备在线状态', baseline: '基线核查', vulnerabilities: '漏洞观测', reachability: '互联规则' }
function kindLabel(value: string): string { const code = text(value); return KIND_LABELS[code] ? `${code}（${KIND_LABELS[code]}）` : code }
/** 聊天用简短原因标签，原始长说明只保留一次。 */
function shortLabel(value: string, max = 40): string {
  const first = text(value).split(/[；;。]/)[0].replace(/^未完成原因[:：]\s*/, '').trim()
  return first.length > max ? `${first.slice(0, max)}…` : first
}
function statusTally(checks: InspectionCheck[]): string {
  const counts = new Map<string, number>()
  for (const check of checks) {
    const key = check.disposition === 'no_applicable_pairs' ? '无适用检查对' : check.disposition === 'soc_state' ? '已取得SOC状态' : displayStatus(check.status)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, count]) => `${key} ${count}`).join('、')
}

/** 首轮聊天只给短摘要；完整设备、规则、漏洞和原始证据由同 Run 报告卡/HTML承载。 */
export function renderInspectionChatMarkdown(result: Record<string, any>): string {
  const model = buildInspectionOperations(result), raw = obj(result), scope = obj(raw.scope)
  const clean = (value: any): string => md(value).replace(/[。；;]+$/, '')
  const executionRaw = text(raw.execution_status ?? raw.executionStatus) || 'unknown'
  const execution = md(executionRaw === 'unverified' ? 'unverified（未核验）' : codeLabel(executionRaw))
  const overall = md(codeLabel(text(raw.status) || (raw.complete === true ? 'completed' : 'incomplete')))
  const scopeCount = Number.isFinite(Number(scope.count)) ? Number(scope.count) : model.counts.devices
  const scopeText = scope.all === true ? 'scope.all（全量范围）' : '已筛选范围'
  const soc = reason => model.socStateGroups.find(group => group.reason === reason)
  const noMatchRules = model.rules.filter(rule => rule.checks.some(check => check.disposition === 'no_applicable_pairs'))
  const gapLines = model.gapGroups.map(gap => {
    const scopeParts = [gap.deviceIds.length ? `${gap.deviceIds.length} 台设备` : '', gap.ruleIds.length ? `${gap.ruleIds.length} 条规则` : ''].filter(Boolean)
    return `- **${md(codeLabel(gap.reason))}**：${scopeParts.length ? scopeParts.join('、') : '必需证据缺失'}；原因：${clean(shortLabel(gap.label, 100))}。建议：${clean(gap.advice || gap.action)}；验证：${clean(gap.verification)}。`
  })
  const mainGroups: string[][] = []
  if (gapLines.length) mainGroups.push(['### 真实执行缺口', ...gapLines])
  if (model.counts.offlineDevices) mainGroups.push([`### 设备离线（${model.counts.offlineDevices} 台）`, '建议：核对资产身份、维护计划和离线／心跳时间；区分采集心跳异常与业务/管理实际不可达，再恢复对应环节。', '验证：取得新的在线和持续采集记录，受影响业务复测通过。'])
  const abnormalRules = model.rules.filter(rule => rule.status === 'abnormal')
  if (abnormalRules.length) mainGroups.push([`### 业务规则异常（${abnormalRules.length} 条）`, '建议：核对规则要求、源、目的、服务及实际路径／策略证据；在授权范围内验证访问后，再按最小范围修正。', '验证：应允许的业务可用，应阻断的访问被阻断；路径计算不代表已完成应用实测。'])
  if (model.counts.vulnerabilityRecords) mainGroups.push([`### 历史漏洞待复核（${model.counts.vulnerabilityRecords} 条）`, '建议：请核对漏洞记录、影响资产、严重度和来源，逐条复核适用性。', '验证：完成逐条复核并取得处置或接受风险记录；本次未执行扫描或修复。'])
  const mainLines = mainGroups.slice(0, 4).flat()
  const lines = [
    '# 巡检概览（30秒速读）', '',
    ...(model.runId ? [`- 运行：${md(model.runId)}`] : []),
    `- 执行状态：${execution}；整体结论：${overall}`,
    `- 冻结范围：${scopeText}，${scopeCount} 台（含单元）${scope.frozen_at ? `；冻结时间：${md(scope.frozen_at)}` : ''}`,
    `- 真实执行缺口：${model.counts.gapItems} 项${model.counts.gapItems ? `（${model.counts.gapDevices} 台设备、${model.counts.gapRules} 条规则）` : ''}`,
  ]
  const stateSummary = [
    model.counts.offlineDevices ? `${model.counts.offlineDevices} 台离线` : '',
    soc('NO_TEMPLATE')?.deviceIds.length ? `未绑定基线模板 ${soc('NO_TEMPLATE')!.deviceIds.length} 台` : '',
    soc('NO_DATA')?.deviceIds.length ? `未采集基线数据 ${soc('NO_DATA')!.deviceIds.length} 台` : '',
    soc('SOC_STATUS_UNKNOWN')?.deviceIds.length ? `未采集状态数据 ${soc('SOC_STATUS_UNKNOWN')!.deviceIds.length} 台` : '',
    noMatchRules.length ? `无适用检查对 ${noMatchRules.length} 项` : '',
  ].filter(Boolean)
  if (stateSummary.length) lines.push(`- 已取得状态/范围结论：${stateSummary.join('；')}`)
  lines.push('', '## 主要问题与处理建议', '', ...(mainLines.length ? mainLines : ['本次没有需要首轮展开的主要问题。']))
  lines.push('', '## 详情与下载', '', '完整设备、规则、漏洞和原始证据请用同 Run 报告卡的“查看设备明细 / 查看规则 / 查看漏洞 / 展开证据”按钮查看；下载使用“下载同 Run 报告”。首轮不展开设备逐行表、完整规则表或原始证据。', '', EXECUTION_BOUNDARY)
  return lines.join('\n')
}
export function renderInspectionMarkdown(result: Record<string, any>): string {
  const model = buildInspectionOperations(result), lines = ['# 安全巡检报告', '', '## 巡检概要', '', summaryMarkdown(model)]
  if (model.coverageNotes.length) lines.push('', ...model.coverageNotes.map(note => `口径提示：${md(note)}`))
  if (model.reportId || model.runId) lines.push('', `报告／运行：${md(model.reportId ?? model.runId)}`)
  if (model.gapGroups.length) lines.push('', `检查缺口：${model.counts.gapDevices}台设备及${unique(model.gapGroups.flatMap(g => g.ruleIds)).length}条规则待补查，按原因列于后文。`)
  lines.push('', '## 异常设备与处理指引', '', '| 编号 | 设备／IP | 本机具体问题 | 处理指引 |', '| --- | --- | --- | --- |')
  for (const device of model.abnormalDevices) lines.push(`| ${device.number} | ${md(deviceLabel(device))} | ${problemsMarkdown(device)} | ${md(firstSteps(device, model))} |`)
  if (!model.abnormalDevices.length) lines.push('', '没有已记录的设备异常；未采集、未绑定状态或检查缺口不计入异常设备，也不计正常或通过。')
  const deviceAdvice = model.devices.flatMap(device => device.checks.filter(check => check.advice).map(check => `- ${md(deviceLabel(device))} · ${md(kindLabel(check.kind))}：建议：${md(check.advice)}；验证：${md(check.verification || '未提供')}；${md(check.executionBoundary || EXECUTION_BOUNDARY)}`))
  if (deviceAdvice.length) lines.push('', '## 逐项建议与验证', '', ...deviceAdvice)
  if (model.plans.length) lines.push('', '## 对应处理办法')
  for (const plan of model.plans) {
    lines.push('', `### ${plan.id}｜${plan.title}`, '', `适用：${md(plan.appliesTo)}`, '', `1. ${md(plan.firstStep)}。`)
    plan.steps.forEach((step, i) => lines.push(`${i + 2}. ${md(step)}`))
    lines.push('', '**结果分支：**', ...plan.branches.map(branch => `- ${md(branch)}`), '', `**验证条件：**${md(plan.verification)}`)
  }
  if (model.rules.length) lines.push('', '## 业务规则（独立口径）')
  for (const rule of model.rules) {
    lines.push('', `**${md(rule.name)}${rule.ruleId ? `（规则 ${md(rule.ruleId)}）` : ''}：${md(rule.requirement)}；原结论 ${md(ruleStatus(rule))}。**`)
    const actionable = rule.checks.filter(check => ['abnormal', 'failed'].includes(check.status) || check.disposition === 'soc_state')
    const shown = rule.checks.length <= 12 ? rule.checks : actionable.length ? actionable.slice(0, 12) : rule.checks.slice(0, 3)
    for (const check of shown) lines.push(`- ${md(ruleConnection(check))}；${md(check.message)}${check.advice ? `；建议：${md(check.advice)}` : ''}${check.verification ? `；验证：${md(check.verification)}` : ''}${check.executionBoundary ? `；${md(check.executionBoundary)}` : ''}${check.evidence.recommendation ? `；原建议：${md(check.evidence.recommendation)}` : ''}`)
    const rest = rule.checks.filter(check => !shown.includes(check))
    if (rest.length) lines.push(`- 其余 ${rest.length} 个连接结论：${md(statusTally(rest))}；完整明细见完整HTML，可按本条规则追问。`)
    lines.push(rule.checks.every(check => check.disposition === 'no_applicable_pairs')
      ? '- 本次范围无匹配对象，不属待补查；不要求修改规则、绑定图层或补充对象，规则关联不计入设备异常。'
      : '- 路径／策略模型不代表已完成应用实测；异常或缺口按A4核查，规则关联不计入设备异常。')
  }
  for (const check of model.ruleReadChecks) lines.push('', `业务规则读取：${md(checkStatus(check))}；${md(check.message)}。${check.disposition === 'no_applicable_pairs' ? '不计为一条规则，也不属待补查。' : '规则数未取得，不计为一条规则。'}`)
  if (model.socStateGroups.length) lines.push('', '## 已取得的SOC状态/后续按需处理', '', '以下状态不属本次未完成，不计正常或通过；补采或绑定不是完成本次巡检的前提。')
  for (const group of model.socStateGroups) {
    const names = group.deviceIds.map(id => deviceLabel(model.devices.find(d => d.id === id)!))
    const shown = names.slice(0, 6), more = names.length - shown.length
    lines.push(`- **${md(shortLabel(group.label))}**：${names.length} 台${shown.length ? `（${md(shown.join('；'))}${more > 0 ? `；其余 ${more} 台` : ''}）` : ''}${more > 0 ? '；完整名单见完整HTML，可按需追问' : ''}。建议：${md(group.advice || group.action)}；验证：${md(group.verification || '')}${group.evidenceSummary ? `；证据摘要：${md(group.evidenceSummary)}` : ''}；${md(group.executionBoundary || EXECUTION_BOUNDARY)}`)
  }
  if (model.gapGroups.length) lines.push('', '## 待补查与进展')
  for (const gap of model.gapGroups) {
    const names = gap.deviceIds.map(id => deviceLabel(model.devices.find(d => d.id === id)!))
    const shownNames = names.slice(0, 10), more = names.length - shownNames.length
    const ruleLabels = gap.ruleIds.map(id => { const rule = model.rules.find(item => item.id === id); return rule ? `${rule.name}（规则 ${rule.ruleId ?? id.replace(/^rule:/, '')}）` : id })
    const scope = [...shownNames, ...(more ? [`其余 ${more} 台`] : []), ...ruleLabels].join('；') || '检查维度缺口，未提供对象明细'
    lines.push(`- **${md(shortLabel(gap.label))}**（${md(codeLabel(gap.reason))}）：${gap.deviceIds.length}台设备、${gap.ruleIds.length}条规则。范围：${md(scope)}${more ? '；完整设备名单见完整HTML，可按需追问' : ''}。建议：${md(gap.advice || gap.action)}；验证：${md(gap.verification)}；${md(gap.executionBoundary || EXECUTION_BOUNDARY)}`)
  }
  const emptyVulnerabilities = model.devices.filter(d => d.checks.some(c => c.kind === 'vulnerabilities' && c.status === 'normal' && c.message === '没有漏洞') && !d.vulnerabilities.length)
  if (emptyVulnerabilities.length) lines.push('', `${emptyVulnerabilities.length}台设备完整读取SOC已有漏洞记录，结果为“没有漏洞”；逐设备检查证据见完整HTML。`)
  lines.push('', `本次未执行扫描、修复、配置变更或处置。修复执行与复核以已保存记录为准，未记录的执行与成功结果尚未确认。`)
  return lines.join('\n')
}
export const renderInspectionMarkdownDetailed = renderInspectionMarkdown
function evidence(value: any): string { return `<details><summary>展开证据</summary><pre>${jsonText(value)}</pre></details>` }
/** 可嵌入现有renderDocument；不生成html/head/body、脚本、外部资源或虚假下载入口。 */
export function renderInspectionOperationsParts(result: Record<string, any>): Record<string, string> {
  const model = buildInspectionOperations(result)
  const planHtml = model.plans.map(p => `<article id="inspection-${p.id}"><h3>${p.id}｜${e(p.title)}</h3><p>${e(p.appliesTo)}</p><ol>${[p.firstStep, ...p.steps].map(s => `<li>${e(s)}</li>`).join('')}</ol><h4>结果分支</h4><ul>${p.branches.map(s => `<li>${e(s)}</li>`).join('')}</ul><p><strong>验证条件：</strong>${e(p.verification)}</p></article>`).join('')
  const abnormalRows = model.abnormalDevices.map(d => `<tr><td>${d.number}</td><td>${e(deviceLabel(d))}</td><td>${problemsHtml(d)}</td><td>${e(firstSteps(d, model))}</td></tr>`).join('')
  const devices = model.devices.map(d => `<details id="inspection-device-${e(d.number)}" class="card"><summary><strong class="${d.abnormal ? 'danger' : d.problems.length ? 'warning' : ''}">${d.number} ${e(deviceLabel(d))}</strong> · ${e(d.hasStatus ? d.online === 'unknown' ? reasons.SOC_STATUS_UNKNOWN : d.online === 'online' ? '在线' : '离线' : '未返回SOC状态检查')}</summary><p>${d.problems.length ? problemsHtml(d) : '已返回检查没有记录设备异常；不推断未检查项目'}</p>${d.checks.map(c => `<section><h4>${e(kindLabel(c.kind))} · ${e(checkStatus(c))}</h4><p class="${checkTone(c)}">${checkTone(c) === 'danger' ? `<strong>${e(c.message)}</strong>` : e(c.message)}</p>${c.advice ? `<p><strong>建议：</strong>${e(c.advice)}</p>` : ''}${c.verification ? `<p><strong>验证：</strong>${e(c.verification)}</p>` : ''}${c.evidenceSummary ? `<p class="muted">证据摘要：${e(c.evidenceSummary)}</p>` : ''}${c.executionBoundary ? `<p>${e(c.executionBoundary)}</p>` : ''}${evidence(c.evidence)}</section>`).join('')}${d.vulnerabilities.length ? `<p class="muted">该设备已有漏洞 ${d.vulnerabilities.length} 条；完整记录见唯一“漏洞记录”明细组，不在设备组重复。</p>` : ''}${d.ruleIds.length ? `<p>关联规则：${e(d.ruleIds.join('、'))}；不自动计入设备异常。</p>` : ''}</details>`).join('')
  const rulesHtml = model.rules.map(r => `<article><h3>${e(r.name)}${r.ruleId ? ` · 规则 ${e(r.ruleId)}` : ''}</h3><p>${e(r.requirement)} · 原结论：<strong class="${r.checks.every(c => c.disposition === 'no_applicable_pairs') || r.status === 'normal' ? '' : r.status === 'abnormal' ? 'danger' : 'warning'}">${e(ruleStatus(r))}</strong></p>${r.checks.map(c => `<p>${e(ruleConnection(c))}；${e(c.message)}${c.advice ? `<br><strong>建议：</strong>${e(c.advice)}` : ''}${c.verification ? `<br><strong>验证：</strong>${e(c.verification)}` : ''}${c.executionBoundary ? `<br>${e(c.executionBoundary)}` : ''}${c.evidenceSummary ? `<br><span class="muted">证据摘要：${e(c.evidenceSummary)}</span>` : ''}</p>${evidence(c.evidence)}`).join('')}<p>${r.checks.every(c => c.disposition === 'no_applicable_pairs') ? '本次范围无匹配对象，不属待补查；不要求修改规则、绑定图层或补充对象，规则关联不计入设备异常。' : '路径／策略模型不代表已完成应用实测。异常或缺口参见A4。'}</p></article>`).join('')
  const ruleReadHtml = model.ruleReadChecks.map(c => `<article${c.disposition === 'no_applicable_pairs' ? '' : ' class="warning"'}><h3>业务规则读取：${e(checkStatus(c))}</h3><p>${e(c.message)}；${c.disposition === 'no_applicable_pairs' ? '不计为一条规则，也不属待补查。' : '规则数未取得，不计为一条规则。'}</p>${evidence(c.evidence)}</article>`).join('')
  const socStateHtml = model.socStateGroups.map(g => `<article><h3>${e(shortLabel(g.label))}</h3><p>${e(g.deviceIds.map(id => deviceLabel(model.devices.find(d => d.id === id)!)).join('；'))}</p><p><strong>建议：</strong>${e(g.advice || g.action)}</p><p><strong>验证：</strong>${e(g.verification || '')}</p>${g.evidenceSummary ? `<p class="muted">证据摘要：${e(g.evidenceSummary)}</p>` : ''}<p>${e(g.executionBoundary || EXECUTION_BOUNDARY)}</p></article>`).join('')
  const gapHtml = model.gapGroups.map(g => `<article class="warning"><h3>${e(shortLabel(g.label))}（${e(codeLabel(g.reason))}）</h3><p>${g.deviceIds.length}台设备、${g.ruleIds.length}条规则：${e([...g.deviceIds.map(id => deviceLabel(model.devices.find(d => d.id === id)!)), ...g.ruleIds].join('；') || '检查维度缺口，未返回对象明细')}</p><p><strong>建议：</strong>${e(g.advice || g.action)}</p><p><strong>验证：</strong>${e(g.verification)}</p><p>${e(g.executionBoundary || EXECUTION_BOUNDARY)}</p></article>`).join('')
  const overview = `<section class="card overview"><h1>安全巡检报告</h1><p>${e(model.summary)}</p>${model.coverageNotes.map(note => `<p class="warning">口径提示：${e(note)}</p>`).join('')}${model.reportId || model.runId ? `<p class="muted">报告／运行：${e(model.reportId ?? model.runId)}</p>` : ''}${model.gapGroups.length ? `<p class="warning">检查缺口：${model.counts.gapDevices}台设备及${unique(model.gapGroups.flatMap(g => g.ruleIds)).length}条规则待补查。</p>` : ''}</section>`
  const abnormal = `<section class="card"><h2>异常设备与处理指引</h2><div class="table-wrap"><table><thead><tr><th>编号</th><th>设备／IP</th><th>本机具体问题</th><th>处理指引</th></tr></thead><tbody>${abnormalRows}</tbody></table></div>${!model.abnormalDevices.length ? '<p>没有已记录的设备异常；未采集、未绑定状态或检查缺口不计入异常设备，也不计正常或通过。</p>' : ''}</section>`
  const plans = planHtml ? `<section class="card"><h2>对应处理办法</h2>${planHtml}</section>` : ''
  const allDevices = `<section class="card"><h2>全部设备及检查证据</h2>${devices || '<p>未返回设备记录。</p>'}</section>`
  const rulesContent = rulesHtml + ruleReadHtml
  const rules = rulesContent ? `<section class="card"><h2>业务规则（独立口径）</h2>${rulesContent}</section>` : ''
  const vulnerabilities = (() => {
    const rows = [...model.devices ?? []].flatMap(d => (d.vulnerabilities ?? []).map(v => ({ device: d, v })))
    if (!rows.length) return ''
    return `<section class="card"><h2>漏洞记录 · 已有数据</h2><p>仅整理同Run已保存漏洞记录，不发起扫描、不改变严重度或原始结论。</p>${rows.map(({ device, v }) => `<details class="card"><summary>${e(deviceLabel(device))} · ${e(text(v.record.cveId ?? v.record.cve ?? v.record.id) || v.identity || v.id)}</summary><pre>${jsonText(v.record)}</pre>${evidence(v.evidence)}</details>`).join('')}</section>`
  })()
  const soc = socStateHtml ? `<section class="card"><h2>已取得的SOC状态/后续按需处理</h2><p>以下状态不属本次未完成，不计正常或通过；补采或绑定不是完成本次巡检的前提。</p>${socStateHtml}</section>` : ''
  const gaps = gapHtml ? `<section class="card"><h2>待补查与进展</h2>${gapHtml}</section>` : ''
  const tail = '<p class="muted">本次未执行扫描、修复、配置变更或处置。修复执行与复核以已保存记录为准，未记录的执行与成功结果尚未确认。</p>'
  return { overview, abnormal, plans, devices: allDevices, rules, vulnerabilities, soc, gaps, tail }
}

export function renderInspectionOperationsHtml(result: Record<string, any>): string {
  const p = renderInspectionOperationsParts(result)
  return [p.overview, p.abnormal, p.plans, p.devices, p.rules, p.vulnerabilities, p.soc, p.gaps, p.tail].join('')
}
