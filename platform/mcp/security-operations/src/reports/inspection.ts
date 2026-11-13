import { escapeHtml as e, jsonText, safeProjection, renderDocument, statusLabel, statusTone } from './common.ts'
import { buildInspectionOperations, renderInspectionOperationsParts } from './inspection-operations.ts'
import { withCompletion } from '../inspection/completion.ts'
import { codeLabel } from './inspection-advice.mjs'

type Data = Record<string, any>
type Category = '设备' | '漏洞' | '基线' | '业务' | '其他'
type ItemStatus = 'normal' | 'abnormal' | 'unknown' | 'not_applicable' | 'failed'
type ReportRecord = { id: string; category: Category; section: string; status: ItemStatus; source: Data; gap: boolean }
type Section = { name: string; kind: string; title: string; category: Category; source: Data; records: ReportRecord[]; gaps: string[]; gapRecord?: ReportRecord }

const STATUSES: ItemStatus[] = ['normal', 'abnormal', 'unknown', 'not_applicable', 'failed']
const CATEGORIES: Category[] = ['设备', '漏洞', '基线', '业务', '其他']
const CHECKS: Record<string, { title: string; category: Category }> = {
  status: { title: '设备在线状态', category: '设备' },
  vulnerabilities: { title: '漏洞观测', category: '漏洞' },
  baseline: { title: '基线核查', category: '基线' },
  reachability: { title: '配置关系与业务规则核查', category: '业务' },
}
const KINDS: Record<string, string> = { routine: '常规巡检', deep: '深度巡检', status: '设备状态巡检', vulnerabilities: '漏洞观测巡检', baseline: '基线巡检', reachability: '业务规则巡检' }
function kindLabel(value: any): string { const key = text(value); return Object.hasOwn(KINDS, key) ? KINDS[key] : '巡检类型未明确' }

function object(value: any): Data {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
function text(value: any, fallback = ''): string {
  return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback
}
function present(value: any): boolean { return value !== undefined && value !== null && text(value).trim() !== '' }
function shown(value: any, fallback = '未提供'): string { return e(present(value) ? text(value) : fallback) }
function integer(value: any): value is number { return Number.isSafeInteger(value) && value >= 0 }
function select(value: any, keys: string[]): Data {
  const source = object(value), selected: Data = {}
  for (const key of keys) {
    const field = source[key]
    if (Object.hasOwn(source, key) && (field === null || ['string', 'boolean'].includes(typeof field) || typeof field === 'number' && Number.isFinite(field))) selected[key] = field
  }
  return selected
}
function scalarList(value: any): any[] {
  return Array.isArray(value) ? value.filter(item => item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) : []
}
function listField(target: Data, source: Data, key: string) {
  if (Array.isArray(source[key])) target[key] = scalarList(source[key])
}
function status(value: any): ItemStatus {
  return STATUSES.includes(value) ? value : 'unknown'
}
function pill(value: any, label?: string): string {
  return `<span class="pill ${statusTone(value)}">${e(label ?? statusLabel(value))}</span>`
}
function stateView(value: any): Data {
  const source = object(value), view = select(source, ['online', 'timeBasis', 'evaluatedAt'])
  if (Array.isArray(source.signals)) view.signals = source.signals.map((signal: any) => select(signal, ['validity', 'supportsOnline', 'observedAt']))
  return view
}
function selectorView(value: any): Data {
  const source = object(value), view = select(source, ['scope'])
  for (const key of ['bizIds', 'cidrs', 'networkTiers', 'assetTypes']) listField(view, source, key)
  return view
}
function ruleView(value: any): Data {
  const source = object(value), view = select(source, ['id', 'name', 'enabled', 'ruleType', 'destPort', 'protocol'])
  for (const key of ['sourceSelector', 'destSelector']) if (source[key] && typeof source[key] === 'object') view[key] = selectorView(source[key])
  // selectorIssues / allowedPorts 的未知结构不作为展示证据；保留归一化 message。
  return view
}
function factsView(value: any): Data {
  const source = object(value)
  const view = select(source, ['online', 'onlineBasis', 'lastSeenAt', 'lastProbeAt', 'probeState', 'consistency', 'error', 'policy_error', 'path_observed_at', 'policy_observed_at', 'rules_frozen_at'])
  if (source.stateEvidence && typeof source.stateEvidence === 'object') view.stateEvidence = stateView(source.stateEvidence)
  if (source.report && typeof source.report === 'object') {
    const report = object(source.report)
    view.report = select(report, ['assetId', 'templateId', 'error'])
    if (report.run && typeof report.run === 'object' && !Array.isArray(report.run)) view.report.run = select(report.run, ['assetId', 'templateId', 'passFlag', 'notCheckedReason'])
  }
  if (source.readiness && typeof source.readiness === 'object') {
    const readiness = object(source.readiness)
    view.readiness = select(readiness, ['assetId', 'templateId', 'assetType', 'templateScopeMatched', 'memberCount', 'applicableCount', 'coverageReason', 'error'])
    if (Array.isArray(readiness.items)) view.readiness.items = readiness.items.map((item: any) => select(item, ['itemId', 'applicable', 'applicabilityReason', 'conditionError']))
  }
  if (source.rule && typeof source.rule === 'object') view.rule = ruleView(source.rule)
  if (Array.isArray(source.rules)) view.rules = source.rules.map(ruleView)
  if (source.path && typeof source.path === 'object') {
    const path = object(source.path)
    view.path = select(path, ['reachable', 'verdict', 'natApplied', 'viaSrcIp', 'viaDstIp', 'reason'])
    for (const key of ['routeOnlyPath', 'path']) listField(view.path, path, key)
  }
  if (source.policy && typeof source.policy === 'object') {
    const policy = object(source.policy)
    view.policy = select(policy, ['status', 'reason'])
    if (Array.isArray(policy.hops)) view.policy.hops = policy.hops.map((hop: any) => select(hop, ['deviceId', 'verdict']))
  }
  return view
}
function findingView(value: any): Data {
  const source = object(value), view: Data = {}
  // 上游 identity 可能是整段原始 record 的 JSON 回退值，绝不透传。
  if (present(source.identity) && !/^[\s]*[\{\[\"']/.test(text(source.identity))) view.identity = source.identity
  listField(view, source, 'sourceAssetIds')
  if (Array.isArray(source.observations)) view.observations = source.observations.map((value: any) => {
    const observation = object(value), record = select(observation.record, ['id', 'vulnerabilityId', 'cveId'])
    return { ...select(observation, ['sourceAssetId']), record }
  })
  return view
}
function itemView(value: any): Data {
  const source = object(value)
  const view = select(source, ['assetId', 'hostAssetId', 'ip', 'hostname', 'ruleId', 'ruleName', 'ruleType', 'srcIp', 'dstIp', 'mode', 'port', 'protocol', 'status', 'reasonCode', 'complete', 'message', 'error', 'recommendation', 'observed_at', 'coverage', 'templateId', 'passFlag', 'notCheckedReason'])
  if (source.facts && typeof source.facts === 'object') view.facts = factsView(source.facts)
  if (source.stateEvidence && typeof source.stateEvidence === 'object') view.stateEvidence = stateView(source.stateEvidence)
  listField(view, source, 'via')
  listField(view, source, 'errors')
  if (Array.isArray(source.findings)) view.findings = source.findings.map(findingView)
  if (Array.isArray(source.sources)) view.sources = source.sources.map((value: any) => select(value, ['assetId', 'hostAssetId', 'observed_at', 'records', 'error']))
  return view
}
function scopeView(value: any): Data {
  const source = object(value), view = select(source, ['frozen_at', 'count'])
  listField(view, source, 'assetIds')
  listField(view, source, 'ruleTypes')
  if (source.requested && typeof source.requested === 'object') {
    const requested = object(source.requested)
    view.requested = select(requested, ['all'])
    for (const key of ['assetIds', 'ips', 'cidrs', 'assetTypes', 'layerIds', 'networkTiers', 'deptIds']) listField(view.requested, requested, key)
  }
  return view
}
function scopeDescription(scope: Data): string {
  const requested = object(scope.requested)
  const rules = Array.isArray(scope.ruleTypes) && scope.ruleTypes.length ? `；规则类型：${scope.ruleTypes.map((item: any) => text(item)).join('、')}` : ''
  if (requested.all === true) return '全部资产（本次冻结范围，不代表当前库存）' + rules
  const labels: Record<string, string> = { assetIds: '资产 ID', ips: 'IP', cidrs: 'CIDR', assetTypes: '资产类型', layerIds: '层级 ID', networkTiers: '网络层级', deptIds: '部门 ID' }
  const parts = Object.entries(labels).filter(([key]) => Array.isArray(requested[key]) && requested[key].length).map(([key, label]) => `${label}：${requested[key].map((item: any) => text(item)).join('、')}`)
  return (parts.length ? parts.join('；') : '范围条件未提供；不能推断为全域') + rules
}
function sourceSections(result: Data): Array<{ name: string; source: Data }> {
  const kind = text(result.kind)
  const aggregate = ['routine', 'deep'].includes(kind)
  let sections: Array<{ name: string; source: Data }>
  if (result.checks && typeof result.checks === 'object' && !Array.isArray(result.checks)) sections = Object.entries(result.checks).map(([name, source]) => ({ name, source: object(source) }))
  else sections = aggregate ? [] : [{ name: kind || 'inspection', source: result }]
  // 仅依据当前 routine/deep 源码明确声明的检查维度揭示缺口，不创建检查事实。
  const expected = aggregate ? ['status', 'baseline', 'reachability', ...(kind === 'deep' ? ['vulnerabilities'] : [])] : []
  for (const name of expected) if (!sections.some(section => section.name === name || section.source.kind === name)) sections.push({ name, source: {} })
  return sections.length ? sections : [{ name: 'inspection', source: {} }]
}
function stableAssetId(value: any): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const candidate = text(value).trim(), numeric = Number(candidate)
  return /^\d+$/.test(candidate) && Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : ''
}
function assetId(item: Data): string { return stableAssetId(item.assetId) }
function assetIp(item: Data): string { return typeof item.ip === 'string' ? item.ip.trim().toLowerCase() : '' }
function assetAliases(records: ReportRecord[]): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>()
  for (const record of records) {
    const id = assetId(record.source), ip = assetIp(record.source)
    if (id && ip) { if (!aliases.has(ip)) aliases.set(ip, new Set()); aliases.get(ip)!.add(id) }
  }
  return aliases
}
function identity(item: Data, aliases: Map<string, Set<string>>): string | undefined {
  const id = assetId(item), ip = assetIp(item)
  if (id) return `asset:${id}`
  if (!ip) return undefined
  const ids = aliases.get(ip)
  if (ids && ids.size > 1) return undefined // 同一 IP 关联多个稳定 ID 时，IP-only 条目不能冒充第三台设备。
  return ids?.size === 1 ? `asset:${[...ids][0]}` : `ip:${ip}`
}
function groups(records: ReportRecord[], aliases: Map<string, Set<string>>): Map<string, ReportRecord[]> {
  const found = new Map<string, ReportRecord[]>()
  for (const record of records) {
    const key = identity(record.source, aliases)
    if (key) { if (!found.has(key)) found.set(key, []); found.get(key)!.push(record) }
  }
  return found
}
function states(records: ReportRecord[]): Set<ItemStatus> { return new Set(records.map(record => record.status)) }
function only(records: ReportRecord[], expected: ItemStatus): boolean { const values = states(records); return values.size === 1 && values.has(expected) }
function hasFindings(record: ReportRecord): boolean { return record.category === '漏洞' && Array.isArray(record.source.findings) && record.source.findings.length > 0 }
function abnormal(record: ReportRecord): boolean { return record.status === 'abnormal' || hasFindings(record) }
function counts(records: ReportRecord[]): Record<ItemStatus, number> {
  return Object.fromEntries(STATUSES.map(value => [value, records.filter(record => record.status === value).length])) as Record<ItemStatus, number>
}
function objectName(record: ReportRecord): string {
  const item = record.source
  if (record.gap) return `${record.section} · 覆盖与明细缺口`
  if (present(item.hostname)) return text(item.hostname)
  if (present(item.ruleName)) return text(item.ruleName)
  if (present(item.assetId)) return `资产 ${text(item.assetId)}`
  if (present(item.ip)) return text(item.ip)
  if (present(item.srcIp) || present(item.dstIp)) return `${text(item.srcIp, '源地址未提供')} → ${text(item.dstIp, '目的地址未提供')}`
  return '未关联稳定对象'
}
function address(record: ReportRecord): string {
  const item = record.source, parts: string[] = []
  if (present(item.assetId)) parts.push(`资产 ID ${text(item.assetId)}`)
  if (present(item.ip)) parts.push(text(item.ip))
  if (present(item.ruleId)) parts.push(`规则 ID ${text(item.ruleId)}`)
  if (present(item.srcIp) || present(item.dstIp)) parts.push(`${text(item.srcIp, '未提供')} → ${text(item.dstIp, '未提供')}`)
  if (present(item.protocol)) parts.push(text(item.protocol))
  if (present(item.port)) parts.push(`端口 ${text(item.port)}`)
  return parts.length ? parts.join(' · ') : record.gap ? '派生缺口说明，不是新增资产或检查事实' : '缺少稳定资产 ID / IP；不按名称去重'
}
function explanation(record: ReportRecord): string {
  const parts = [text(record.source.message), text(record.source.error), ...scalarList(record.source.errors).map(item => text(item))].filter(Boolean)
  return parts.length ? [...new Set(parts)].join('\n') : '未提供结果说明；不能由空白推断正常'
}
function recordPills(record: ReportRecord): string {
  return pill(record.status, record.gap ? '覆盖缺口' : undefined) + (hasFindings(record) && record.status !== 'abnormal' ? ` ${pill('abnormal', '同时已有漏洞观测')}` : '')
}
function percentage(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Number((numerator / denominator * 100).toFixed(1))}%` : '无法计算'
}
function metric(title: string, value: string, description: string, tone: string = 'neutral'): string {
  return `<article class="metric"><h3>${e(title)}</h3><strong class="${e(tone)}">${e(value)}</strong><p>${e(description)}</p></article>`
}
function countSummary(records: ReportRecord[]): string {
  if (!records.length) return '未取得对象明细，各状态数量未知'
  const tally = counts(records)
  return STATUSES.map(value => `${statusLabel(value)} ${tally[value]}`).join('；')
}

/** 纯渲染：不修改输入、不查询业务、不执行建议；输出由公共模块封装的独立离线 HTML。 */
export function renderInspectionReport(result: Record<string, any>): string {
  // 所有屏幕、统计、证据与打印内容都只能从这一安全深复制投影出发。
  const projected = object(safeProjection(result))
  const runId = present(projected.runId) ? text(projected.runId) : present(projected.run_id) ? text(projected.run_id) : undefined
  const generatedAt = present(projected.generatedAt) ? text(projected.generatedAt) : present(projected.generated_at) ? text(projected.generated_at) : undefined
  const source = object(projected.source)
  const sourceConnections = Array.isArray(source.connections) ? source.connections.map((entry: any) => text(entry.connectionId)).filter(Boolean).join('；') : source.connections && typeof source.connections === 'object' ? Object.entries(source.connections).map(([role, id]) => `${role}=${text(id)}`).join('；') : ''
  const scope = scopeView(projected.scope)
  // result.status是检查结果完整性，不是外层Run.status；只有显式字段才显示执行结论。
  const executionStatus = projected.execution_status ?? projected.executionStatus
  let recordIndex = 0
  const sections: Section[] = sourceSections(projected).map(({ name, source }) => {
    const kind = text(source.kind) || name
    const definition = Object.hasOwn(CHECKS, kind) ? CHECKS[kind] : Object.hasOwn(CHECKS, name) ? CHECKS[name] : undefined
    const title = definition?.title ?? `其他检查：${name}`
    const category: Category = definition?.category ?? '其他'
    const records: ReportRecord[] = Array.isArray(source.items) ? source.items.map((item: any) => {
      const view = itemView(item)
      return { id: `inspection-record-${recordIndex++}`, category, section: title, status: status(view.status), source: view, gap: false }
    }) : []
    return { name, kind, title, category, source, records, gaps: [] }
  })
  const sourceRecords = sections.flatMap(section => section.records)
  const aliases = assetAliases(sourceRecords)
  const scopeCount = integer(scope.count) ? scope.count as number : undefined
  const frozenIds = [...new Set(scalarList(scope.assetIds).map(stableAssetId).filter(Boolean))]
  const globalGaps: string[] = []
  if (!present(projected.status)) globalGaps.push('总体检查结果状态未提供，不能由局部分项补造总体结果完整。')
  if (scopeCount === undefined) globalGaps.push('冻结资产总数未提供或无效；不能声称覆盖了完整范围。')
  if (!present(scope.frozen_at)) globalGaps.push('范围冻结时间未提供。')
  const requested = object(scope.requested)
  if (requested.all !== true && !['assetIds', 'ips', 'cidrs', 'assetTypes', 'layerIds', 'networkTiers', 'deptIds'].some(key => Array.isArray(requested[key]) && requested[key].length)) globalGaps.push('请求范围条件未提供或为空，不能将本次范围推断为全域。')
  if (Array.isArray(scope.assetIds) && scope.assetIds.length !== frozenIds.length) globalGaps.push(`冻结资产 ID 列表存在重复或无效项：来源 ${scope.assetIds.length} 条，可识别去重数 ${frozenIds.length}。`)
  if (scopeCount !== undefined && frozenIds.length && frozenIds.length !== scopeCount) globalGaps.push(`冻结资产 ID 去重数 ${frozenIds.length} 与声明资产数 ${scopeCount} 不一致。`)

  for (const section of sections) {
    const { source, records } = section, declared = object(source.counts), actual = counts(records)
    if (!Array.isArray(source.items)) section.gaps.push('没有返回检查明细数组；不能将缺失结果作为空白通过。')
    else if (!source.items.length) section.gaps.push('检查明细为空；没有可据以确认检查覆盖的对象结果。')
    if (!present(source.status)) section.gaps.push('检查结果状态未提供。')
    if (!STATUSES.every(key => integer(declared[key]))) section.gaps.push('来源状态计数未完整提供或存在无效值；本报告分布按实际保存条目统计。')
    const mismatches = STATUSES.filter(key => integer(declared[key]) && declared[key] !== actual[key])
    if (mismatches.length) section.gaps.push(`来源计数与明细不一致：${mismatches.map(key => `${statusLabel(key)} 来源 ${declared[key]} / 明细 ${actual[key]}`).join('；')}。`)
    const invalid = records.filter(record => !STATUSES.includes(record.source.status)).length
    if (invalid) section.gaps.push(`${invalid} 条明细没有可识别的状态，展示为未知，不改写来源状态。`)
    if (['设备', '基线', '漏洞'].includes(section.category)) {
      const identified = groups(records, aliases), unlinked = records.filter(record => !identity(record.source, aliases)).length
      if (unlinked) section.gaps.push(`${unlinked} 条明细缺少可唯一关联的稳定资产身份（ID / IP 缺失或 IP 关联多个 ID），不纳入设备去重统计，仍保留完整明细。`)
      if (frozenIds.length) {
        const missing = frozenIds.filter(id => !identified.has(`asset:${id}`))
        if (missing.length) section.gaps.push(`冻结资产中 ${missing.length} 台未取得可按稳定 ID 关联的该项结果；资产 ID：${missing.join('、')}。`)
        const extra = [...identified.keys()].filter(key => key.startsWith('asset:') && !frozenIds.includes(key.slice(6)))
        if (extra.length) section.gaps.push(`该项出现 ${extra.length} 台冻结资产 ID 列表以外的对象，范围归属尚未核实；不据此扩大全量分母。`)
      } else if (scopeCount !== undefined && identified.size !== scopeCount) {
        section.gaps.push(`冻结范围 ${scopeCount} 台，该项可按稳定身份关联 ${identified.size} 台；数量差异不由未关联记录或名称推测补齐。`)
      }
    }
    if (section.gaps.length) section.gapRecord = {
      id: `inspection-record-${recordIndex++}`, category: section.category, section: section.title, status: 'unknown', gap: true,
      source: { ...select(source, ['error']), status: 'unknown', message: `展示层覆盖缺口（非原始检查对象）：\n来源检查结果状态：${present(source.status) ? statusLabel(source.status) : '未提供'}\n${text(source.message) ? `${text(source.message)}\n` : ''}${section.gaps.join('\n')}` },
    }
  }

  const allRecords = sections.flatMap(section => [...section.records, ...(section.gapRecord ? [section.gapRecord] : [])])
  if (globalGaps.length) allRecords.push({ id: `inspection-record-${recordIndex++}`, category: '其他', section: '报告范围与来源', status: 'unknown', gap: true, source: { status: 'unknown', message: `展示层范围缺口（非原始检查对象）：\n${globalGaps.join('\n')}` } })
  const attention = allRecords.filter(record => record.gap || record.status !== 'normal' || hasFindings(record))
  const abnormalRecords = sourceRecords.filter(abnormal)
  const sectionKind = (record: ReportRecord) => sections.find(section => section.title === record.section)?.kind ?? ''
  const recordIncomplete = (record: ReportRecord) => !withCompletion(sectionKind(record), record.source).complete
  const uncertainRecords = sourceRecords.filter(recordIncomplete)
  const hasDeclaredAbnormal = sections.some(section => integer(object(section.source.counts).abnormal) && section.source.counts.abnormal > 0)
  const hasNormal = sourceRecords.some(record => record.status === 'normal')
  const incomplete = projected.status !== 'completed' || globalGaps.length > 0 || sections.some(section => section.gaps.length > 0 || section.source.status !== 'completed') || uncertainRecords.length > 0
  const businessStatus: ItemStatus = abnormalRecords.length || hasDeclaredAbnormal ? 'abnormal' : !incomplete && hasNormal ? 'normal' : 'unknown'
  const businessConclusion = businessStatus === 'abnormal' ? '发现异常或已有漏洞观测' : incomplete ? '部分检查实际未完成，见具体原因' : hasNormal ? '已取得的检查结果未见明确异常；未采集、未绑定保持独立结论' : '已取得SOC业务状态，不强制归为达标或不达标'
  const businessTone = businessStatus === 'abnormal' ? 'danger' : businessStatus === 'normal' ? 'normal' : 'warning'
  const completeness = incomplete ? '有实际未完成或覆盖缺口，详见具体条目' : '已存结果与声明范围可核对；未采集、未绑定仍保留原业务结论'

  const statusSections = sections.filter(section => section.category === '设备')
  const statusRecords = statusSections.flatMap(section => section.records)
  const statusByIdentity = groups(statusRecords, aliases), statusGroups = [...statusByIdentity.values()]
  const online = statusGroups.filter(records => only(records, 'normal')).length
  const offline = statusGroups.filter(records => only(records, 'abnormal')).length
  const onlineNa = statusGroups.filter(records => only(records, 'not_applicable')).length
  const onlineUnknown = statusGroups.length - online - offline - onlineNa
  const onlineUnlinked = statusRecords.filter(record => !identity(record.source, aliases)).length
  const onlineScopeMatched = scopeCount !== undefined && scopeCount >= statusGroups.length && (!frozenIds.length || frozenIds.length === scopeCount && [...statusByIdentity.keys()].every(key => key.startsWith('asset:') && frozenIds.includes(key.slice(6))))
  const onlineDenominator = onlineScopeMatched ? scopeCount! : statusGroups.length
  const onlineValue = !statusSections.length ? '未检查' : !statusRecords.length ? '未取得结果' : !online && !offline ? '未取得明确结论' : onlineDenominator ? percentage(online, onlineDenominator) : '无法计算'
  const onlineDescription = !statusSections.length ? '本次结果未包含设备在线检查；不能记作 0。' : !statusRecords.length ? '未取得设备明细，不计算在线、离线或未采集数量；不能记作 0 或视为在线。' : `明确在线 ${online} 台；明确离线 ${offline} 台；SOC未采集到状态数据 ${onlineUnknown} 台；不适用 ${onlineNa} 台；无法关联 ${onlineUnlinked} 条。${onlineScopeMatched ? `分母为冻结范围 ${scopeCount} 台，其中 ${Math.max(0, scopeCount! - statusGroups.length)} 台没有可识别结果。` : `分母为已存可识别设备 ${statusGroups.length} 台，非全量在线率；冻结分母缺失或存在范围差异。`}未采集与缺失不当作在线。`

  const deviceRecords = sourceRecords.filter(record => ['设备', '基线', '漏洞'].includes(record.category))
  const abnormalDevices = groups(deviceRecords.filter(abnormal), aliases).size
  const unfinishedDevices = groups(deviceRecords.filter(recordIncomplete), aliases).size
  const unlinkedAbnormal = deviceRecords.filter(record => abnormal(record) && !identity(record.source, aliases)).length
  const abnormalDeviceValue = !deviceRecords.length ? '未取得结果' : !abnormalDevices && !deviceRecords.some(record => ['normal', 'abnormal'].includes(record.status) || hasFindings(record)) ? '未确认' : `${abnormalDevices} 台`
  const abnormalDeviceDescription = !deviceRecords.length ? '未取得设备级检查结果，不计算异常设备数；不能记作 0。' : `按稳定资产 ID / IP 跨检查去重；仍有实际读取失败、未执行或必需证据不足的设备 ${unfinishedDevices} 台，可与异常重叠；另有 ${unlinkedAbnormal} 条异常或观测无法关联资产。SOC未采集状态、设备未绑定模板及未采集基线数据属已取得业务结论，不计入未完成。未返回设备另见覆盖缺口；汇总数缺少明细支撑时不补造设备。业务路径端点不自动算作异常设备，名称不作唯一标识。`

  const vulnerabilitySections = sections.filter(section => section.category === '漏洞')
  const vulnerabilityRecords = vulnerabilitySections.flatMap(section => section.records)
  const findingKeys = new Set<string>()
  let findingsWithoutId = 0
  for (const record of vulnerabilityRecords) for (const [index, finding] of (record.source.findings ?? []).entries()) {
    const safeId = text(finding.identity) || (finding.observations ?? []).map((observation: any) => text(observation.record?.id) || text(observation.record?.vulnerabilityId) || text(observation.record?.cveId)).filter(Boolean).join('|')
    if (!safeId) findingsWithoutId++
    findingKeys.add(JSON.stringify([identity(record.source, aliases) ?? record.id, safeId || `${record.id}:${index}`]))
  }
  const vulnerabilityAssets = groups(vulnerabilityRecords.filter(hasFindings), aliases).size
  const vulnerabilityComplete = vulnerabilityRecords.length > 0 && vulnerabilityRecords.every(record => record.status === 'normal') && vulnerabilitySections.every(section => !section.gaps.length && section.source.status === 'completed')
  const vulnerabilityValue = !vulnerabilitySections.length ? '未检查' : findingKeys.size ? `${findingKeys.size} 条漏洞记录` : vulnerabilityComplete ? '没有漏洞' : vulnerabilityRecords.length ? '读取未完成' : '未取得结果'
  const vulnerabilityDescription = !vulnerabilitySections.length ? '本次未包含漏洞检查；记录数、受影响设备及严重度均不能填 0。' : !vulnerabilityRecords.length ? '该维度未取得设备明细；观测数与关联设备数未知，不记作 0。' : `按设备关联的已有观测去重；关联已有观测的设备 ${vulnerabilityAssets} 台；${findingsWithoutId} 条观测没有可展示安全标识，保留条目、不强行合并。${vulnerabilityRecords.filter(record => record.status === 'failed').length} 条设备结果未完整取得。完整成功读取且结果为空时显示“没有漏洞”；失败、未知或读取不完整不作空结果。来源与时间保留在证据中；未提供严重度则不分级。`

  const baselineSections = sections.filter(section => section.category === '基线')
  const baselineRecords = baselineSections.flatMap(section => section.records)
  const baselineByIdentity = groups(baselineRecords, aliases), baselineGroups = [...baselineByIdentity.values()]
  const baselineUnlinked = baselineRecords.filter(record => !identity(record.source, aliases)).length
  const baselineMissing = frozenIds.length ? frozenIds.filter(id => !baselineByIdentity.has(`asset:${id}`)).length : scopeCount === undefined ? undefined : Math.max(0, scopeCount - baselineGroups.length)
  const baselinePass = baselineGroups.filter(records => only(records, 'normal')).length
  const baselineFail = baselineGroups.filter(records => only(records, 'abnormal')).length
  const baselineNa = baselineGroups.filter(records => only(records, 'not_applicable')).length
  // 未绑定模板与未采集基线数据是已取得的明确业务状态，不是本次未完成，单列而不并入未知/失败。
  const baselineSocState = (records: ReportRecord[]) => {
    const reasons = new Set(records.map(record => text(record.source.reasonCode)))
    const [reason] = [...reasons]
    return reasons.size === 1 && ['NO_TEMPLATE', 'NO_DATA'].includes(reason) && only(records, 'unknown') && records.every(record => !record.source.error) ? reason : ''
  }
  const baselineUnbound = baselineGroups.filter(records => baselineSocState(records) === 'NO_TEMPLATE').length
  const baselineNoData = baselineGroups.filter(records => baselineSocState(records) === 'NO_DATA').length
  const baselinePending = baselineGroups.length - baselinePass - baselineFail - baselineNa - baselineUnbound - baselineNoData
  const baselineDefinite = baselinePass + baselineFail
  const baselineValue = !baselineSections.length ? '未检查' : !baselineRecords.length ? '未取得结果' : baselineDefinite ? percentage(baselinePass, baselineDefinite) : baselineUnbound || baselineNoData ? `未绑定 ${baselineUnbound} 台 / 未采集 ${baselineNoData} 台` : '无明确结论分母'
  const baselineDescription = !baselineSections.length ? '本次未包含基线核查；不能计算通过率。' : !baselineRecords.length ? '未取得基线设备明细，不计算通过 / 不通过数量或通过率；缺失不当作通过或不适用。' : `${baselinePass} / ${baselineDefinite} 台具有单一明确结论的设备通过；明确不通过 ${baselineFail} 台；设备未绑定基线模板 ${baselineUnbound} 台；SOC未采集到基线数据 ${baselineNoData} 台；实际未知、失败或冲突 ${baselinePending} 台；不适用 ${baselineNa} 台；未关联 ${baselineUnlinked} 条；冻结范围覆盖差额 ${baselineMissing === undefined ? '未知' : `${baselineMissing} 台`}。未绑定、未采集、缺失、不适用和未关联记录均不进分母，也不改称未完成；不是全量设备通过率。`

  const businessSections = sections.filter(section => section.category === '业务')
  const businessRecords = businessSections.flatMap(section => section.records)
  const rules = new Map<string, ReportRecord[]>(), pairs = new Set<string>()
  for (const record of businessRecords) {
    if (present(record.source.ruleId)) {
      const key = text(record.source.ruleId)
      if (!rules.has(key)) rules.set(key, [])
      rules.get(key)!.push(record)
    }
    if (present(record.source.srcIp) && present(record.source.dstIp)) pairs.add(JSON.stringify([record.source.srcIp, record.source.dstIp, record.source.port ?? null, record.source.protocol ?? null, record.source.mode ?? null]))
  }
  const incompleteRules = [...rules.values()].filter(records => records.some(record => ['unknown', 'failed'].includes(record.status) && !(text(record.source.reasonCode) === 'NO_MATCHING_PAIRS' && !record.source.error))).length
  const businessValue = !businessSections.length ? '未检查' : rules.size ? `${rules.size} 条规则` : pairs.size ? `${pairs.size} 个显式目标` : '未取得可核查规则'
  const businessDescription = !businessSections.length ? '本次结果未包含业务规则检查，不能记作 0。' : `${rules.size ? `按稳定规则 ID 去重；含实际未完成证据的规则 ${incompleteRules} 条；` : pairs.size ? '显式目标模式，未提供规则 ID，不统计规则数量或规则完成率；' : '没有取得可关联稳定规则 ID 或完整地址对的结果，不将规则数填 0；'}${pairs.size ? `已存不同地址 / 端口 / 协议目标 ${pairs.size} 组。` : '没有可统计的完整地址对。'}合法规则完整读取后无匹配对象的按无适用检查对单列，不计规则异常或选择器错误。无规则与读取失败保留在明细，不按名称合并。仅核对 SOC 计算路径与策略，未实测应用响应。`

  const metrics = `<section class="card"><h2>关键指标 · 分母与限制</h2><div class="metrics">${metric('设备在线率', onlineValue, onlineDescription, offline ? 'danger' : onlineUnknown || onlineUnlinked ? 'warning' : 'neutral')}${metric('已确认异常设备', abnormalDeviceValue, abnormalDeviceDescription, abnormalDevices ? 'danger' : unfinishedDevices ? 'warning' : 'neutral')}${metric('漏洞观测记录', vulnerabilityValue, vulnerabilityDescription, findingKeys.size ? 'danger' : vulnerabilityRecords.some(record => record.status === 'failed') ? 'warning' : 'neutral')}${metric(baselineDefinite || !baselineSections.length || !baselineRecords.length ? '基线明确结论内通过率' : '基线已取得状态', baselineValue, baselineDescription, baselineFail ? 'danger' : baselinePending || baselineUnlinked || baselineMissing ? 'warning' : 'neutral')}${metric('业务规则', businessValue, businessDescription, incompleteRules ? 'warning' : 'neutral')}</div></section>`

  const identityCard = `<section class="card"><h2>报告身份、范围与时间</h2>${present(projected.message) ? `<p class="note"><strong>来源说明：</strong>${e(projected.message)}</p>` : ''}<dl class="grid two"><div><dt>巡检类型</dt><dd>${e(kindLabel(projected.kind))}</dd></div><div><dt>报告 / 运行标识</dt><dd>${shown(runId, '当前结果未提供运行编号')}</dd></div><div><dt>范围冻结时间</dt><dd>${shown(scope.frozen_at)}</dd></div><div><dt>报告生成时间</dt><dd>${shown(generatedAt, '当前结果未提供；不以打开页面时间代替')}</dd></div><div><dt>冻结资产数</dt><dd>${scopeCount === undefined ? '未提供有效分母' : `${scopeCount} 台`}</dd></div><div><dt>范围条件</dt><dd>${e(scopeDescription(scope))}</dd></div><div><dt>来源连接</dt><dd>${e(sourceConnections || '未提供来源连接身份')}</dd></div></dl><p>时间保持来源原值；条目的 observed_at 是本次读取时间，不等于 SOC 事实观测时间。没有统一执行窗口或人工复核记录时，不自行补写。</p></section>`
  const opModel = buildInspectionOperations(result)
  const dimension = kind => {
    const found = sections.find(item => item.kind === kind)
    if (!found || Object.keys(found.source).length === 0) return { present: false, complete: false }
    const failed = found.gaps.length > 0 || found.records.some(record => record.status === 'failed')
    return { present: true, complete: found.source.status === 'completed' && !failed }
  }
  const statusDim = dimension('status'), baselineDim = dimension('baseline'), reachDim = dimension('reachability'), vulnDim = dimension('vulnerabilities')
  const socUnknown = opModel.socStateGroups.find(group => group.reason === 'SOC_STATUS_UNKNOWN')?.deviceIds.length
  const noTemplate = opModel.socStateGroups.find(group => group.reason === 'NO_TEMPLATE')?.deviceIds.length
  const noData = opModel.socStateGroups.find(group => group.reason === 'NO_DATA')?.deviceIds.length
  const noMatch = opModel.rules.filter(rule => rule.checks.some(check => check.disposition === 'no_applicable_pairs')).length
  const statusLine = statusDim.present ? `${statusDim.complete ? '' : '已读部分，读取不完整；'}设备离线 ${opModel.counts.offlineDevices} 台，SOC未采集状态 ${socUnknown ?? 0} 台` : '设备状态：本次未取得'
  const baselineLine = baselineDim.present ? `${baselineDim.complete ? '' : '已读部分，读取不完整；'}未绑定模板 ${noTemplate ?? 0} 台，未采集基线 ${noData ?? 0} 台` : '基线：本次未取得'
  const reachLine = reachDim.present ? `${reachDim.complete ? '' : '已读部分，读取不完整；'}无适用检查对 ${noMatch} 项` : '互联规则：本次未取得'
  const vulnLine = !vulnDim.present ? (kindLabel(projected.kind) === '深度巡检' ? '漏洞：检查未取得' : '漏洞：本次未包含') : !vulnDim.complete ? (opModel.counts.vulnerabilityRecords ? `漏洞：读取不完整，已读 ${opModel.counts.vulnerabilityRecords} 条` : '漏洞：读取失败或未取得') : opModel.counts.vulnerabilityRecords ? `历史漏洞 ${opModel.counts.vulnerabilityRecords} 条待复核` : '漏洞：完整读取，没有漏洞记录'
  const summary = `<section class="card"><h2>30 秒速读</h2><p><strong>检查执行状态：</strong>${present(executionStatus) && executionStatus !== 'unverified' ? pill(executionStatus) : pill('unknown', '报告生成时未取得执行终态回执；请查询同次运行')}</p><p><strong class="${businessTone}">${e(businessConclusion)}</strong>；${statusLine}；${baselineLine}；${reachLine}；${vulnLine}；真实执行缺口 ${opModel.counts.gapItems} 项。</p><p><strong>冻结范围：</strong>${scopeCount === undefined ? '未提供有效数量' : `${scopeCount} 台（含单元）`}；冻结时间：${shown(scope.frozen_at, '未提供')}。</p><p class="note">执行完成不等于业务通过；未绑定、未采集和无适用检查对单列，不计真实执行缺口。本报告只整理已保存 SOC 事实，建议尚未执行。</p></section>`
  const technicalStatus = `<dl class="grid two"><div><dt>源检查结果状态（非外层执行）</dt><dd>${present(projected.status) ? pill(projected.status, projected.status === 'completed' ? '来源声明检查结果完成' : statusLabel(projected.status)) : pill('unknown', '未提供')}</dd></div><div><dt>结果完整性（展示核对）</dt><dd>${pill(incomplete ? 'incomplete' : 'completed', completeness)}</dd></div></dl>`

  const focus = `<section class="card"><h2>当班关注</h2><p>按检查维度与已存顺序整理，不作业务影响或优先级排序。当前输入未提供责任人、业务影响和处置优先级，不代填。</p><ul>${sections.map(section => `<li><strong>${e(section.title)}</strong>：${e(countSummary(section.records))}；${section.gaps.length ? `${section.gaps.length} 项覆盖 / 来源缺口` : '未发现明细结构缺口，但仍须结合适用限制'}。${section.category === '基线' && (baselineUnbound || baselineNoData) ? `其中设备未绑定基线模板 ${baselineUnbound} 台、SOC未采集到基线数据 ${baselineNoData} 台为已取得业务状态，不计未完成。` : ''}</li>`).join('')}</ul><p>“正常”对象以覆盖汇总和完整安全附录为主；异常、未知、失败、不适用与覆盖缺口均可在后续清单逐条查看。</p></section>`
  const coverage = `<section class="card"><h2>巡检覆盖与结果分布</h2><div class="table-wrap"><table><caption>按已保存条目统计；来源计数单独列示，不用汇总数补造明细</caption><thead><tr><th scope="col">检查维度 / 执行</th><th scope="col">明细分布</th><th scope="col">稳定身份覆盖</th><th scope="col">来源声明 / 缺口</th></tr></thead><tbody>${sections.map(section => {
    const identified = groups(section.records, aliases).size
    const declared = STATUSES.filter(key => Object.hasOwn(object(section.source.counts), key)).map(key => `${statusLabel(key)} ${text(section.source.counts[key], '无效')}`).join('；')
    return `<tr><td>${e(section.title)}<br>${present(section.source.status) ? pill(section.source.status) : pill('unknown', '未提供检查结果状态')}</td><td>已存 ${section.records.length} 条<br>${e(countSummary(section.records))}</td><td>${section.category === '业务' ? '业务按规则 / 地址对统计，不用资产数充当规则分母' : `${identified} 台可识别资产；${section.records.filter(record => !identity(record.source, aliases)).length} 条未关联`}<br>${section.category === '其他' ? '此维度不能推断完整资产覆盖' : ''}</td><td>${e(declared || '未提供来源计数')}<br>${e(section.gaps.join('\n') || '未发现数量结构差异；未知及适用限制仍见结果')}</td></tr>`
  }).join('')}</tbody></table></div><p>设备按稳定 assetId / IP 关联；同一设备可同时异常和未完成。重名设备不合并；不同稳定 ID 共用 IP 时不合并 ID。分布为条目计数，与跨维度去重设备数不是同一分母。</p></section>`

  const baselineTable = `<section class="card"><h2>基线模板与覆盖依据</h2><p>只列本次已存字段，不用当前模板配置或参考报告补齐；模板名称、模板内容版本与原报告核查时间在当前归一化合同中未提供。两次接口读取不构成事务快照。</p>${baselineRecords.length ? `<div class="table-wrap"><table><caption>全部已保存基线设备结果，含正常、未知、失败与不适用</caption><thead><tr><th scope="col">设备 / 地址</th><th scope="col">模板 / 报告主体</th><th scope="col">明确结论 / 覆盖依据</th><th scope="col">时间与限制</th></tr></thead><tbody>${baselineRecords.map(record => {
    const facts = object(record.source.facts), report = object(facts.report), run = object(report.run), ready = object(facts.readiness)
    return `<tr><td>${e(objectName(record))}<br>${e(address(record))}</td><td>就绪模板 ID：${shown(ready.templateId)}<br>报告模板 ID：${shown(run.templateId ?? report.templateId)}<br>报告主体资产 ID：${shown(run.assetId)}<br>基线模板内容版本：未核实</td><td>${recordPills(record)}<br>通过标志（原值）：${shown(run.passFlag)}<br>适用项 / 模板成员：${shown(ready.applicableCount)} / ${shown(ready.memberCount)}<br>范围匹配（原值）：${shown(ready.templateScopeMatched)}<br>覆盖原因：${shown(ready.coverageReason)}<br>未检查原因：${shown(run.notCheckedReason)}<br>${e(explanation(record))}</td><td>本次读取：${shown(record.source.observed_at)}<br>原报告核查时间：当前结果未提供<br>${e(text(facts.consistency) || '基线模板内容版本、报告时效及读取一致性未核实')}</td></tr>`
  }).join('')}</tbody></table></div>` : `<p>${baselineSections.length ? '基线维度存在，但没有取得设备明细；缺口保留在后续清单。' : '本次未包含基线核查，不能计算基线通过率。'}</p>`}</section>`

  function detailTable(records: ReportRecord[], interactive: boolean): string {
    return `<div class="table-wrap"><table><caption>${interactive ? '异常、未知、失败、不适用及覆盖缺口；不截断记录' : '完整检查明细，包含正常结果及所有派生覆盖缺口'}</caption><thead><tr><th scope="col">维度 / 对象</th><th scope="col">结果与证据摘要</th><th scope="col">影响 / 责任 / 优先级</th><th scope="col">状态${interactive ? ' / 操作' : ''}</th></tr></thead><tbody>${records.map(record => {
      const search = [record.category, record.section, objectName(record), address(record), explanation(record), statusLabel(record.status), text(record.source.recommendation), JSON.stringify(record.source)].join(' ')
      const attributes = interactive ? ` data-record="${e(record.id)}" data-category="${e(record.category)}" data-search="${e(search)}" tabindex="0"` : ''
      return `<tr${attributes}><td><span class="pill neutral">${e(record.category)}</span> ${e(objectName(record))}<br>${e(address(record))}<br>${e(record.section)}</td><td>${e(explanation(record))}${record.gap ? '<br><strong>此条是由范围 / 明细核对揭示的缺口，不是新增上游结论。</strong>' : ''}</td><td>业务影响未提供<br>责任人未提供<br>处置优先级未提供</td><td>${recordPills(record)}${interactive ? `<br><button type="button" class="btn" data-open-evidence="${e(record.id)}">查看证据详情</button>` : ''}</td></tr>`
    }).join('')}</tbody></table></div>`
  }
  function evidence(record: ReportRecord, interactive: boolean, first: boolean): string {
    const item = record.source, facts = object(item.facts), observedState = object(facts.stateEvidence ?? item.stateEvidence)
    const attributes = interactive ? ` data-evidence-panel="${e(record.id)}" hidden` : ''
    const limitations = record.category === '业务' ? '计算路径、策略结果与业务应用实际响应是不同证据；未执行主动探测。' : record.category === '漏洞' ? '按SOC已有漏洞数据呈现；完整成功的空结果为没有漏洞，读取失败或未完成单独保留。' : record.category === '基线' ? '读取报告标志不证明基线模板内容版本与报告时效；未返回模板或报告不能视为通过、不适用。' : record.category === '设备' ? '默认SOC数据为最新，直接呈现SOC在线或离线状态；unknown显示SOC未采集到状态数据，不在本端因时间或心跳改判。' : '仅保留已知可展示字段；没有提供的事实不作补齐。'
    return `<section class="card"${attributes}><h3${interactive ? ' tabindex="-1"' : ''}>证据详情 · ${e(objectName(record))} ${recordPills(record)}</h3><dl class="grid two"><div><dt>检查维度</dt><dd>${e(record.section)}</dd></div><div><dt>稳定身份 / 地址</dt><dd>${e(address(record))}</dd></div><div><dt>本次读取时间</dt><dd>${shown(item.observed_at)}</dd></div><div><dt>上游观测时间</dt><dd>${shown(facts.lastSeenAt ?? facts.lastProbeAt, '当前结果未提供独立上游观测时间；逐信号 observedAt 见安全证据')}</dd></div><div><dt>SOC 状态评估时间 / 时间基准</dt><dd>${shown(observedState.evaluatedAt)} / ${shown(observedState.timeBasis)}</dd></div></dl><p>${e(explanation(record))}</p><p>${e(limitations)}</p>${present(item.recommendation) ? `<p><strong>来源建议 · 建议，未执行：</strong>${e(item.recommendation)}</p>` : '<p>未提供针对性处置建议；不据结果说明自动判断根因。</p>'}<p>业务影响、责任人和优先级未提供。${record.gap ? '以下仅为展示层缺口说明，不伪装为来源检查条目。' : '以下为完整的已知字段安全投影，不是完整原始响应；未知 / 敏感字段不输出。'}</p><pre>${jsonText(safeProjection(item))}</pre></section>`
  }

  const filters = `<div class="filters"><label for="report-search">搜索对象、地址、状态或说明</label> <input type="search" id="report-search" autocomplete="off" placeholder="搜索已保存明细">${(['全部', ...CATEGORIES] as string[]).map(category => `<button type="button" class="btn${category === '全部' ? ' active' : ''}" data-filter="${e(category)}" aria-pressed="${category === '全部' ? 'true' : 'false'}">${e(category)}</button>`).join('')}</div>`
  const interactiveDetails = `<section class="card"><h2>异常、未知与不适用明细</h2><p>筛选只改变本页展示，不改变统计与完整打印载荷；按行 Enter / 空格或“查看证据详情”打开证据。</p>${filters}<p id="filter-status" role="status" aria-live="polite">当前列出 ${attention.length} 条关注记录；正常结果完整保留于安全附录。</p>${detailTable(attention, true)}<p id="no-matches" hidden>当前筛选没有匹配记录；这不代表巡检已通过。</p>${attention.length ? '' : '<p>当前没有已存关注条目；是否存在未检查维度、覆盖不足或适用限制，仍须结合指标和缺口说明。</p>'}</section><p id="inspection-evidence-prompt">选择记录查看证据</p>${attention.map(record => evidence(record, true, false)).join('')}`
  const printableDetails = `<section class="card"><h2>全量检查明细 · 独立打印</h2><p>以下按完整列表生成，包含正常、异常、未知、失败、不适用与派生缺口，不依赖页面当前搜索或选中状态。</p>${detailTable(allRecords, false)}</section>${allRecords.map(record => evidence(record, false, false)).join('')}`

  const sourceRecommendations = sourceRecords.filter(record => present(record.source.recommendation))
  const recommendations = `<section class="card"><h2>建议 · 未执行</h2><p>以下仅整理来源建议或给出复核方向，不代表已执行整改、已验证根因或已分派责任。</p>${sourceRecommendations.length ? `<ul>${sourceRecommendations.map(record => `<li><strong>${e(record.section)} · ${e(objectName(record))}</strong>：${e(record.source.recommendation)} <span class="pill neutral">来源建议，未执行</span></li>`).join('')}</ul>` : '<p>当前结果没有提供针对性建议；不自动编造修复措施。</p>'}<p><strong>整理建议，未执行：</strong>先核对来源缺口、范围身份与证据时效，再在相同授权范围内复查；异常结论与未完成项分别处理。未记录责任人、优先级或业务影响时，应由有权人员补充，而不是由渲染器推测。</p></section>`
  const gapMessages = [...globalGaps, ...sections.flatMap(section => section.gaps.map(gap => `${section.title}：${gap}`))]
  const gaps = `<section class="card"><h2>来源缺口与适用边界</h2><p>实际读取失败、未执行、主体冲突或必需证据缺失才计缺口。</p>${gapMessages.length ? `<ul>${gapMessages.map(message => `<li>${e(message)}</li>`).join('')}</ul>` : '<p>未发现本次结构、计数与范围核对缺口；这不等于完成主动验证或排除所有安全风险。</p>'}<ul><li>实际证据不足 ${uncertainRecords.filter(record => record.status === 'unknown').length} 条、失败 ${uncertainRecords.filter(record => record.status === 'failed').length} 条仍保留；缺失和未检查不作为零或正常。</li><li>不适用仅采用来源明确结论；完整成功读取后无匹配对象保留无适用检查对。未绑定模板、未采集数据独立呈现，不算基线通过，也不单凭unknown列为未完成。</li><li>未执行主动探测；没有报告时效、模板版本、扫描覆盖、业务实际响应或人工复核证据时，均保持未核实。</li><li>安全投影会排除未知与敏感字段；安全附录不替代受控保存的原始事实，不能据未显示字段认定其不存在。</li></ul></section>`

  const appendixView = safeProjection({
    ...select(projected, ['kind', 'status', 'execution_status', 'executionStatus', 'runId', 'run_id', 'generatedAt', 'generated_at', 'message']), scope,
    checks: sections.map(section => ({
      name: section.name, ...select(section.source, ['kind', 'status', 'message', 'error']),
      counts: select(section.source.counts, STATUSES), items: section.records.map(record => record.source),
    })),
  })
  const appendixExplanation = '<p>保留全部已存条目（含正常项）及已知事实字段，不截断列表；派生覆盖缺口另列在明细与缺口章节。未知原始 response、凭据、请求头与 raw 字段不进入屏幕、打印或附录。本页不会运行输入脚本或调用外部网络。</p>'
  const appendix = `<section class="card"><h2>安全附录 · 全部已存条目</h2>${appendixExplanation}<details><summary>展开完整的已知字段安全投影</summary><pre>${jsonText(appendixView)}</pre></details></section>`
  const printAppendix = `<section class="card"><h2>安全附录 · 全部已存条目</h2>${appendixExplanation}<pre>${jsonText(appendixView)}</pre></section>`
  const parts = renderInspectionOperationsParts(result)
  // 仅净化首屏方案引用；结构化建议、方案编号与证据原值不变。
  const headlineText = (value: string) => e(value.replace(/按\s*A[1-4](?:\s*[\/／、]\s*A[1-4])*(?:\s*[：:]\s*)?/g, ''))
  const headlineItems = []
  const offPlan = opModel.plans.find(plan => plan.id === 'A1'), vulnPlan = opModel.plans.find(plan => plan.id === 'A2')
  if (opModel.counts.offlineDevices) headlineItems.push(`<li><strong>设备离线 ${opModel.counts.offlineDevices} 台</strong>：${headlineText(`按A1：${offPlan?.firstStep || '核对资产身份、维护计划、离线／心跳时间'}`)}<br><span class="pill neutral">验证</span> ${headlineText(offPlan?.verification || '取得新的在线和持续采集记录，受影响业务复测通过')}</li>`)
  for (const group of opModel.socStateGroups.filter(group => ['NO_TEMPLATE', 'NO_DATA'].includes(group.reason))) headlineItems.push(`<li><strong>${e(codeLabel(group.reason))} ${group.deviceIds.length} 台</strong><span class="pill neutral">按需改善，未执行</span>：${headlineText(`按A3：${group.advice || group.action}`)}<br><span class="pill neutral">验证</span> ${headlineText(group.verification || '取得新的有效采集记录和基线报告')}</li>`)
  if (opModel.counts.vulnerabilityRecords) headlineItems.push(`<li><strong>历史漏洞待复核 ${opModel.counts.vulnerabilityRecords} 条</strong>：${headlineText(`按A2：${vulnPlan?.firstStep || '核对漏洞记录、影响资产、严重度和来源'}`)}<br><span class="pill neutral">验证</span> ${headlineText(vulnPlan?.verification || '完成逐条复核并取得处置或接受风险记录')}</li>`)
  for (const gap of opModel.gapGroups.slice(0, 3)) headlineItems.push(`<li><strong>真实执行缺口 · ${e(codeLabel(gap.reason))}</strong>：${headlineText(gap.advice || gap.action)}<br><span class="pill neutral">验证</span> ${headlineText(gap.verification)}</li>`)
  const headline = headlineItems.length
    ? `<section class="card"><h2>重点问题与建议</h2><ul>${headlineItems.slice(0, 3).join('')}</ul><p class="note">仅列已取得的真实异常、真实缺口或明确标注的按需改善；无适用检查对属于范围结论，不列为风险。完整明细在下方默认折叠区。</p></section>`
    : '<section class="card"><h2>重点问题与建议</h2><p>没有已取得的真实异常或真实执行缺口；无适用检查对等范围结论见速读计数。完整明细在下方默认折叠区。</p></section>'
  const identityDetails = `<details class="card" id="inspection-identity-details"><summary>查看报告身份、范围、统计口径与覆盖分布</summary>${identityCard}${metrics}${technicalStatus}<div class="cols">${focus}${coverage}</div>${parts.overview}${recommendations}${parts.gaps}</details>`
  const deviceDetails = `<details class="card" id="inspection-device-details"><summary>查看设备明细、异常设备、处理方案与 SOC 状态</summary>${parts.abnormal}${parts.plans}${parts.devices}${parts.soc}${baselineTable}</details>`
  const ruleDetails = `<details class="card" id="inspection-rule-details"><summary>查看全部业务规则、检查对、路径与策略证据</summary>${parts.rules || '<p>本次未返回规则记录。</p>'}</details>`
  const vulnerabilityBody = parts.vulnerabilities || (!vulnDim.present ? (kindLabel(projected.kind) === '深度巡检' ? '<p>漏洞检查未取得；不显示0条或没有漏洞。</p>' : '<p>本次未包含漏洞检查。</p>') : !vulnDim.complete ? '<p>漏洞记录读取不完整；已读记录见下方证据，不显示0条或没有漏洞。</p>' : '<p>已有漏洞记录完整读取：没有漏洞。</p>')
  const vulnerabilityDetails = `<details class="card" id="inspection-vulnerability-details"><summary>查看已有漏洞记录与原始证据</summary>${vulnerabilityBody}</details>`
  const evidenceDetails = `<details class="card" id="inspection-evidence-details"><summary>查看原始证据、筛选明细、来源缺口与安全附录</summary>${interactiveDetails}${appendix}${gaps}${parts.tail}</details>`
  return renderDocument({
    kind: 'inspection', title: '网络安全巡检报告',
    subtitle: `${kindLabel(projected.kind)} · ${businessConclusion}`,
    runId,
    generatedAt,
    snapshot: appendixView,
    content: summary + headline + identityDetails + deviceDetails + ruleDetails + vulnerabilityDetails + evidenceDetails,
    printContent: [parts.overview,parts.abnormal,parts.plans,parts.devices,parts.rules,parts.vulnerabilities,parts.soc,parts.gaps,parts.tail].join('') + printableDetails + gaps + printAppendix,
    interaction: 'inspection',
  })
}
