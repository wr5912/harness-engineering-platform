import { escapeHtml as e, jsonText, safeProjection, renderDocument, statusLabel, statusTone } from './common.ts'

type Value = Record<string, any>
type Evidence = { id: string; item: Value; index: number }

const checkNames: Record<string, string> = {
  'unique-endpoints': '对象定位', resolve: '对象定位',
  'source-soc-state': '源 SOC 状态依据', 'target-soc-state': '目标 SOC 状态依据', 'soc-state': 'SOC 状态依据',
  'source-alerts': '源关联告警', 'target-alerts': '目标关联告警', alerts: '关联告警',
  'configuration-path': '配置路径模型', 'current-source-tcp': '当前源端 TCP',
  'application-response': '应用响应', 'target-current-listener': '目标当前监听', 'target-service': '服务与关联日志',
  'current-source-route': '源当前路由', 'current-destination-observation': '目标当前观察',
  'tcp-followup-not-executed': 'TCP 后继检查缺口', 'management-observation': '管理侧观察',
  'collection-capability': '采集适用性', 'collection-binding': '采集绑定',
  'collection-run-state': '采集运行态', 'collection-config': '采集配置',
  'raw-heartbeat': '原始心跳', 'state-synchronization': '状态同步',
  'unknown-management': '管理观察缺口', 'unanswered-observation': '无响应边界',
}
const missing = '未记录'
const uncertain = new Set(['unknown', 'unavailable', 'failed', 'partial', 'incomplete'])
const isObject = (value: any): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value)
const asObject = (value: any): Value => isObject(value) ? value : {}
const records = (value: any): Value[] => Array.isArray(value) ? value.filter(isObject) : []
const present = (value: any): boolean => value !== undefined && value !== null && value !== ''
const text = (value: any, fallback = missing): string => !present(value) ? fallback : typeof value === 'object' ? JSON.stringify(value) : String(value)
const checkName = (item: Value): string => Object.hasOwn(checkNames, item.check) ? checkNames[item.check] : text(item.check, '未命名检查')
const empty = (message: string): string => `<p class="empty muted">${e(message)}</p>`
const safeJson = (value: any): string => `<pre>${jsonText(value)}</pre>`

function badge(value: any): string {
  const tone = statusTone(value)
  const style = tone === 'warning' ? 'warn' : tone === 'danger' ? 'danger' : tone === 'normal' ? 'normal' : 'neutral'
  return `<span class="pill ${style}">${e(present(value) ? statusLabel(value) : missing)}</span>`
}
function pair(label: string, value: any): string {
  return `<dt>${e(label)}</dt><dd>${e(text(value))}</dd>`
}
function endpoint(value: any): string {
  if (!isObject(value)) return missing
  const parts = [present(value.ip) ? `IP ${text(value.ip)}` : '', present(value.assetId) ? `资产 ${text(value.assetId)}` : '', present(value.hostname) ? text(value.hostname) : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : missing
}
function evidenceButton(evidence: Evidence, label = '查看安全证据'): string {
  return `<button type="button" class="link" data-show-evidence="${e(evidence.id)}" aria-haspopup="dialog">${e(label)}</button>`
}
function receiptRefs(item: Value): string {
  const refs = records(item.raw_receipt_refs)
  if (!refs.length) return empty('未保存回执引用；不能据此推断未发生查询或查询成功。')
  return `<ul class="tiny">${refs.map(ref => `<li>运行：${e(text(ref.run_id))} · 节点：${e(text(ref.node_id))} · 回执：${e(text(ref.receipt_id))}</li>`).join('')}</ul>`
}
function executionPoint(value: any): string {
  if (!isObject(value)) return text(value)
  const kinds: Record<string, string> = { SOC_READONLY: 'SOC 只读查询', PLATFORM_ANALYSIS: '平台分析' }
  const kind = Object.hasOwn(kinds, value.kind) ? kinds[value.kind] : text(value.kind)
  const services = Array.isArray(value.services) ? value.services.map((entry: any) => text(entry)).join('、') : ''
  return `${kind}${services ? ` · 来源服务：${services}` : ''}`
}
function execution(item: Value): string {
  const saved = present(item.execution_status) ? badge(item.execution_status) : e(missing)
  const declared = item.executed === false ? '明确记录：未执行' : item.executed === true ? '明确记录：已执行；不代表已完成或业务正常' : '是否执行：未记录'
  return `${saved}<div class="tiny muted">${e(declared)}</div>`
}
function summary(item: Value): string {
  for (const key of ['message', 'reason', 'error']) if (present(item[key])) return text(item[key])
  if (item.check === 'resolve' && isObject(item.exact_matches)) return `设备精确匹配数：${text(item.exact_matches.asset)}；观察源精确匹配数：${text(item.exact_matches.observer)}。不据候选数推断设备状态。`
  if (present(item.online) || present(item.reported_state)) return `SOC 原状态：${text(item.reported_state ?? item.online)}；依据：${text(item.onlineBasis)}。不等于本次真实响应或业务正常。`
  if (['alerts', 'source-alerts', 'target-alerts'].includes(item.check)) return `已存快照声明：告警组 ${text(item.totalGroups)}，告警条数 ${text(item.totalAlerts)}；完整性声明：${item.complete === true ? '已记录完整' : item.complete === false ? '不完整' : missing}。告警事实不直接确定根因，空结果不排除故障。`
  if (item.check === 'configuration-path') return '已有配置模型证据；不是本次真实业务路径、当前连接结果或故障因果链。'
  if (item.executed === false) return '本项明确未执行；缺失结果不解释为正常。'
  return '仅保留本项已保存事实；未记录独立摘要，不生成新判断。'
}
function factDetail(evidence: Evidence): string {
  const { item, index } = evidence
  return `<article class="pane evidence-record"><h3>${e(`证据 ${index + 1} · ${checkName(item)}`)}</h3>
    <p>已存事实状态：${badge(item.status)}；业务结果：${e(text(item.business_result))}</p>
    <dl class="kv">${pair('检查标识', item.check)}${pair('节点标识', item.node_id ?? item.id)}${pair('原运行', item.run_id)}${pair('记录时间（非源观测时间）', item.recorded_at)}${pair('源观测时间', item.observed_at)}${pair('源时区', item.source_timezone)}${pair('执行点', executionPoint(item.execution_point))}</dl>
    <div>执行状态：${execution(item)}</div><p>${e(summary(item))}</p>
    <h4>已保存证据引用</h4>${receiptRefs(item)}
    <p class="tiny muted">以下为保守已知字段的安全投影，非完整原始工具响应；未知字段、原始页与凭据不公开。记录时间、查询窗口和来源状态时间不替代本项源观测时间。</p>${safeJson(item)}</article>`
}
function factCards(evidence: Evidence[]): string {
  if (!evidence.length) return empty('尚无已保存检查事实；没有事实不表示没有故障。')
  return `<div class="grid">${evidence.map(entry => `<article class="pane"><div class="row"><h3>${e(`证据 ${entry.index + 1} · ${checkName(entry.item)}`)}</h3>${badge(entry.item.status)}</div><p>${e(summary(entry.item))}</p><p class="tiny muted">源观测：${e(text(entry.item.observed_at))} · 源时区：${e(text(entry.item.source_timezone))}<br>记录：${e(text(entry.item.recorded_at))}（非源观测时间）</p>${evidenceButton(entry)}</article>`).join('')}</div>`
}
function processTable(evidence: Evidence[], interactive: boolean): string {
  if (!evidence.length) return empty('未保存检查点记录；不能把流程定义当成本次已执行过程。')
  return `<div class="table-wrap"><table><thead><tr><th>真实检查点 / 执行点</th><th>执行状态</th><th>已存事实状态 / 业务结果</th><th>时间边界</th><th>事实说明 / 引用</th></tr></thead><tbody>${evidence.map(entry => {
    const item = entry.item
    return `<tr><td><strong>${e(checkName(item))}</strong><div class="tiny muted">检查：${e(text(item.check))}<br>节点：${e(text(item.node_id ?? item.id))}<br>执行点：${e(executionPoint(item.execution_point))}</div></td>
      <td>${execution(item)}</td><td>${badge(item.status)}<p class="tiny">业务结果：${e(text(item.business_result))}</p></td>
      <td class="tiny">源观测：${e(text(item.observed_at))}<br>源时区：${e(text(item.source_timezone))}<br>记录：${e(text(item.recorded_at))}<br><span class="muted">记录时间不代表观测时间</span></td>
      <td><p>${e(summary(item))}</p>${interactive ? evidenceButton(entry, '查看已保存检查证据') : receiptRefs(item)}</td></tr>`
  }).join('')}</tbody></table></div>`
}
function savedEntries(value: any, absent: string): string {
  if (!Array.isArray(value)) return empty(absent)
  if (!value.length) return empty('已保存列表为空；不代表范围外不存在相关记录。')
  return `<div class="grid">${value.map((entry: any, index: number) => {
    if (!isObject(entry)) return `<article class="pane"><h3>${e(`已存条目 ${index + 1}`)}</h3><p>${e(text(entry))}</p></article>`
    return `<article class="pane"><div class="row"><h3>${e(text(entry.title ?? entry.name, `已存条目 ${index + 1}`))}</h3>${present(entry.status) ? badge(entry.status) : ''}</div>${present(entry.description ?? entry.message) ? `<p>${e(text(entry.description ?? entry.message))}</p>` : ''}${safeJson(entry)}</article>`
  }).join('')}</div>`
}
function renderScope(report: Value): string {
  const input = asObject(report.input), scope = asObject(report.scope)
  const business = report.kind === 'business-access'
  const objectRows = business
    ? pair('请求源', endpoint(input.source)) + pair('请求目标', endpoint(input.target)) + pair('已存范围源', endpoint(scope.source)) + pair('已存范围目标', endpoint(scope.target))
    : pair('请求设备', endpoint(input.asset)) + pair('请求观察源', endpoint(input.observer)) + pair('已存范围设备', endpoint(scope.asset)) + pair('已存范围观察源', endpoint(scope.observer))
  const savedPath = report.report_path ?? report.saved_path
  return `<section class="pane"><h3>本次真实对象与范围</h3><dl class="kv">${objectRows}${pair('协议', input.protocol)}${pair('端口', input.port)}${pair('查询窗口起点（非源观测）', input.from)}${pair('查询窗口终点（非源观测）', input.to)}${pair('范围冻结时间（非源观测）', scope.frozen_at)}${pair('原运行', report.run_id)}</dl><p class="tiny muted">请求对象与已存范围分别列示；scope 可在对象定位前保存，仅有范围字段不证明已唯一解析，核实依据见对象定位事实。不扩大到 NAT 候选、其他源或其他端口。</p><h4>已存报告保存路径</h4>${present(savedPath) ? `<p>${e(text(savedPath))}</p>` : empty('未记录报告保存路径；不从运行编号、附件名或检查节点路径推测。')}</section>`
}
function boundaries(report: Value): string {
  const probes = report.active_checks_executed ?? report.active_probes_executed
  const active = probes === false ? '明确记录：本次未执行主动检查（只读）。' : probes === true ? '已存字段声明执行过主动检查；具体范围与结果只以对应已存证据为准。' : '是否执行主动检查：未记录。'
  return `<section class="pane"><h3>诊断边界</h3><p>${e(text(report.message, '未保存独立诊断总结；本报告不生成新结论。'))}</p><p class="alert warn">支持条件不是确认根因；未知不是反驳。SOC 在线不代表业务正常，无响应不直接判断断电，配置模型不代表本次实际响应。</p><p>${e(active)}</p><p class="tiny muted">只整理当前已保存结果，不发起查询、重新诊断、主动探测或修复；未保存恢复验收记录时不显示恢复通过。</p></section>`
}
function businessPaths(report: Value): string {
  const paths = report.business_paths
  return `<section class="pane"><h3>已保存业务访问路径与涉及设备</h3><p class="tiny muted">仅按已保存结构展开；顺序或连接不代表因果，不从组合流程图推导业务路径。</p>${savedEntries(paths, '未保存结构化业务路径及设备顺序；不以流程图、节点执行路径或配置模型补造。')}</section>`
}
function chains(report: Value): string {
  const topology = report.topology
  const topologyHtml = isObject(topology)
    ? `<p class="tiny muted">仅呈现已存拓扑；可用性、完整性、陈旧性和观测时间沿原记录，不重新判断。</p>${safeJson(topology)}`
    : Array.isArray(topology) ? savedEntries(topology, '') : empty('未保存结构化拓扑关系；不能把工作流连线或配置查询结果当作本次真实业务拓扑。')
  return `<div class="cols"><section class="pane"><h3>故障链与关联分析</h3><p class="tiny muted">共现、支持条件与拓扑相连均不能单独确认因果。</p>${savedEntries(report.fault_chains, '未保存结构化故障链或共因结论；不据执行先后、流程连线或相同状态生成故障链。')}</section><section class="pane"><h3>本次保存的拓扑关系</h3>${topologyHtml}</section></div>${businessPaths(report)}`
}
function causeSide(label: string, value: any): string {
  const block = asObject(value)
  return `<section class="pane"><div class="row"><h4>${e(label)}</h4>${present(block.status) ? badge(block.status) : ''}</div><p class="tiny muted">仅展示已存条件与结果，不重算条件真假；缺失或未知不解释为反驳，不把支持升级为确认。</p>${present(value) && !(Array.isArray(value) && value.length === 0) ? safeJson(value) : empty('未保存本侧结构化条件或判断；不从空值推断成立、不成立或根因。')}</section>`
}
function causeDetail(cause: Value, index: number): string {
  return `<article class="pane"><div class="row"><h3>${e(text(cause.title ?? cause.name, `已存候选原因 ${index + 1}`))}</h3>${badge(cause.status)}</div>
    ${present(cause.message) ? `<p>${e(text(cause.message))}</p>` : ''}
    <p class="tiny muted">此为已存候选原因及其原判断，不是报告新确认的根因。</p><div class="cols">${causeSide('支持条件', cause.support ?? cause.support_conditions)}${causeSide('反驳条件', cause.refutation ?? cause.rebuttal ?? cause.rebuttal_conditions)}</div>
    <h4>本原因完整安全判断记录</h4>${safeJson(cause)}</article>`
}
function causes(report: Value, interactive: boolean): string {
  const saved = records(report.causes).filter(cause => [cause.id, cause.title, cause.name].some(value => typeof value === 'string' && value.trim() !== '' || typeof value === 'number' && Number.isFinite(value)))
  if (!saved.length) return `<section class="pane"><h3>已保存候选原因 / 判断依据</h3>${empty('未保存真实结构化 causes；不生成原因选择器、候选原因、支持反驳结果或根因结论。')}</section>`
  const notice = '<p class="alert warn">只复现已保存判断：支持不等于确认根因，未知不等于反驳；不以候选原因数量替代现象或附加异常数量。</p>'
  if (!interactive) return `${notice}${saved.map(causeDetail).join('')}`
  return `<section class="pane"><h3>已保存候选原因与判断依据</h3>${notice}<div class="cols"><div role="tablist" aria-label="已保存候选原因" aria-orientation="vertical">${saved.map((cause, index) => `<button type="button" class="tab${index === 0 ? ' active' : ''}" data-cause-select="cause-${e(index)}" id="cause-select-${e(index)}" role="tab" aria-controls="cause-panel-${e(index)}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}">${e(text(cause.title ?? cause.name, `已存候选原因 ${index + 1}`))}</button>`).join('')}</div><div>${saved.map((cause, index) => `<section data-cause-panel="cause-${e(index)}" id="cause-panel-${e(index)}" role="tabpanel" aria-labelledby="cause-select-${e(index)}"${index === 0 ? '' : ' hidden'}>${causeDetail(cause, index)}</section>`).join('')}</div></div></section>`
}
function closure(report: Value): string {
  const acceptance = records(report.acceptance_records)
  return `<div class="cols"><section class="pane"><h3>已保存处置记录</h3>${savedEntries(report.actions, '未保存结构化处置记录；不展示演示操作、自动修复或已完成处置。')}</section>
    <section class="pane"><h3>已保存恢复验收记录</h3>${acceptance.length ? `<p class="tiny muted">以下为原记录，不由检查完成、在线标签或候选原因状态推断验收通过。</p>${savedEntries(acceptance, '')}` : empty('未保存恢复验收记录；业务是否恢复未验证，不显示验收通过。')}</section></div>
    <section class="pane"><h3>已存后续建议（不表示已执行）</h3>${savedEntries(report.recommendations, '未保存结构化后续建议；本报告不新增诊断或处置建议。')}${present(report.next_check) ? `<p><strong>已存下一步：</strong>${e(text(report.next_check))}</p>` : ''}${present(report.recovery) ? `<p><strong>已存运行恢复说明（不是业务恢复验收）：</strong>${e(text(report.recovery))}</p>` : ''}</section>`
}
function gaps(report: Value, evidence: Evidence[]): string {
  const rootGaps = Array.isArray(report.gaps) ? report.gaps : []
  const itemGaps = evidence.filter(entry => (Array.isArray(entry.item.gaps) && entry.item.gaps.length) || uncertain.has(entry.item.status))
  return `<section class="pane"><h3>已保存缺口与适用边界</h3>${rootGaps.length ? `<h4>运行缺口</h4>${safeJson(rootGaps)}` : empty('未保存额外运行缺口；不等于全部检查已完成或业务正常。')}
    ${itemGaps.length ? `<h4>检查点缺口 / 未知状态</h4>${itemGaps.map(entry => `<article class="pane"><strong>${e(checkName(entry.item))}</strong> ${badge(entry.item.status)}<p>${e(summary(entry.item))}</p>${Array.isArray(entry.item.gaps) && entry.item.gaps.length ? safeJson(entry.item.gaps) : ''}</article>`).join('')}` : empty('没有其他已保存的检查点缺口记录；本报告不据此证明无缺口。')}
    <p class="tiny muted">未执行、查询失败、部分结果、未知状态分别保留；不将缺字段解释为零、正常、不适用或已反驳。上游未保留的观测时间、时区、验收和因果关系均无法由报告补齐。</p></section>`
}
function safeSources(report: Value, evidence: Evidence[], includeSnapshot: boolean): string {
  const references = evidence.map(entry => ({ check: entry.item.check, id: entry.item.id, node_id: entry.item.node_id, run_id: entry.item.run_id,
    recorded_at: entry.item.recorded_at, observed_at: entry.item.observed_at, source_timezone: entry.item.source_timezone,
    execution_point: entry.item.execution_point, raw_receipt_refs: entry.item.raw_receipt_refs }))
  return `<section class="pane"><h3>安全来源与可追溯引用</h3><p>以下仅为安全投影及已保存引用，不是完整原始响应。原始工具载荷、原始页、请求头及未声明字段不公开；引用保留不表示来源已独立核实。</p>
    ${references.length ? safeJson(references) : empty('未保存可展示的检查来源引用。')}
    ${Array.isArray(report.source_appendix) && report.source_appendix.length ? `<h4>已存安全来源附录</h4>${savedEntries(report.source_appendix, '')}` : empty('未保存额外结构化安全来源附录；不补造存储路径、快照摘要或来源记录。')}
    ${includeSnapshot ? `<h4>本次完整安全投影</h4><p class="tiny muted">“完整”只指本报告获准展示的已知字段全量；不是完整上游回执，也不是原始响应摘要证明。</p>${safeJson(report)}` : ''}</section>`
}
function metricCount(value: any): string {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : missing
}
function metrics(report: Value): string {
  const saved = asObject(report.metrics)
  const listCount = (key: string): string => present(saved[key]) ? metricCount(saved[key]) : Array.isArray(report[key]) ? String(report[key].length) : missing
  const acceptance = records(report.acceptance_records)
  const values = [
    ['现象', listCount('symptoms'), '仅采用独立已存现象数；不把检查点当现象'],
    ['附加异常', listCount('additional_anomalies'), '没有独立记录就写未记录；不采用原因条数'],
    ['已定位', metricCount(saved.located), '仅呈现已存指标；支持条件不升级为根因'],
    ['部分定位', metricCount(saved.partially_located), '未保存独立指标时不根据候选原因推算'],
    ['待验证', metricCount(saved.pending_verification), '不把未知检查数或原因数当现象数'],
    ['恢复验收', acceptance.length ? `${acceptance.length} 条记录` : missing, '仅为已存验收记录数，不代表验收通过'],
  ]
  return `<div class="metrics">${values.map(([label, value, note]) => `<div class="metric"><b>${e(value)}</b><span>${e(label)}</span><small>${e(note)}</small></div>`).join('')}</div>`
}
function overview(report: Value): string {
  return `<section class="card overview"><div class="row"><h2>本次报告概览</h2>${badge(report.status)}</div><p class="headline">${e(text(report.message, '仅呈现本次已保存的安全事实与缺口；没有独立总结，不生成新结论。'))}</p>${metrics(report)}<p class="tiny muted">原运行：${e(text(report.run_id))} · 生成时间：${e(text(report.generated_at))}<br>“检查完成”“已取得证据”和“来源在线”都不是故障修复或恢复验收通过。</p></section>`
}
function printChapter(number: number, title: string, content: string): string {
  return `<section class="card print-chapter"><h2>${e(`${number}. ${title}`)}</h2>${content}</section>`
}

/** 首屏七项：一分钟内判断发生什么、影响哪里、根因到哪一步、现在做什么。 */
function firstScreen(report: Value): string {
  const c = asObject(report.unified_conclusion)
  if (!Object.keys(c).length) return `<section class="card"><h2>首屏结论</h2>${empty('本报告未包含统一结论对象；请按后续事实与缺口章节阅读，不据此认定根因。')}</section>`
  const root = asObject(c.rootCause), impact = asObject(c.impactLevel), scope = asObject(c.impactScope)
  const primary = asObject(c.primaryRecommendation), escalation = asObject(c.escalation)
  const card = (no: number, label: string, body: string) => `<article class="pane"><h3>${e(no + '. ' + label)}</h3>${body}</article>`
  return `<section class="card overview" id="first-screen"><div class="row"><h2>首屏结论</h2>${badge(text(c.stopStatusCode, 'UNKNOWN'))}</div>
    <p class="headline">${e(text(c.incidentSummary, '未保存故障概况'))}</p>
    <div class="cols">
      ${card(1, '当前状态', `<p><b>${e(text(c.currentStatus, 'UNKNOWN(未知)'))}</b></p><p class="tiny muted">停止状态：${e(text(c.stopStatus, '—'))}</p>`)}
      ${card(2, '影响等级', `<p><b>${e(text(impact.label, '—'))}</b></p><p class="tiny muted">依据：影响范围=${e(text(impact.basis?.scope, '—'))}，业务重要性=${impact.basis?.businessCritical === true ? '高' : '未确认'}，持续时间=${impact.basis?.durationHours == null ? '未知' : e(impact.basis.durationHours + ' 小时')}。与本条根因置信度分开。</p>`)}
      ${card(3, '故障概况', `<p>${e(text(c.incidentSummary, '未保存'))}</p>`)}
      ${card(4, '影响范围', `<p>${e(text(scope.text, '未确认影响范围'))}</p><p class="tiny muted">${e(text(scope.boundary, '边界未声明'))}</p>`)}
      ${card(5, '当前根因判断', `<p><b>${e(text(root.title, '根因尚未确认'))}</b> ${badge(text(root.statusCode, 'UNKNOWN'))}</p><p class="tiny muted">支持事实 ${Array.isArray(root.supportingFacts) ? root.supportingFacts.length : 0} 项 · 反驳事实 ${Array.isArray(root.contradictingFacts) ? root.contradictingFacts.length : 0} 项 · 缺口 ${Array.isArray(root.gaps) ? root.gaps.length : 0} 项。${e(text(root.note, ''))}</p>`)}
      ${card(6, '首要建议', `<p><b>${e(text(primary.title, '未保存建议'))}</b>（${e(text(primary.category, '—'))}）</p><p class="tiny muted">责任方：${e(text(primary.owner, '—'))} · 状态：${e(text(primary.stateLabel, '—'))}<br>前置：${e((primary.prerequisites ?? []).join('；') || '—')}<br>授权：${e(text(primary.authorization, '—'))}<br>完成标准：${e(text(primary.completionCriteria, '—'))}<br>复验：${e(text(primary.verificationMethod, '—'))}</p>`)}
      ${card(7, '升级条件', `<p>${escalation.required === true ? `需要升级：${e(text(escalation.to, '二线'))}` : '当前无需升级'}</p><p class="tiny muted">触发：${e(text(escalation.trigger, '—'))}<br>条件：${e((escalation.conditions ?? []).join('；') || '—')}</p>`)}
    </div>
    <p class="tiny muted">根因状态非 CONFIRMED 时不使用“已确认根因”表述；无记录不写作未监听，旁路不作为源端实测，检查完成不等于根因确认。</p></section>`
}

/** 第二层：两端状态、连通、监听/防火墙、路径策略、日志告警、旁路佐证、时间窗、候选状态。 */
function layers2(report: Value): string {
  const c = asObject(report.unified_conclusion)
  const evidence = records(report.items)
  const rows = evidence.map(item => `<tr><td>${e(checkName(item))}</td><td>${badge(item.status)}</td><td>${e(text(item.execution_status, 'unknown'))}</td><td>${e(text(item.observed_at, '未取得可核观测时间'))}</td><td>${e(text(item.source_query_window?.scope ?? '—'))}</td></tr>`).join('')
  const side = records(report.side_channels)
  const sideBlock = side.length
    ? side.map(item => `<article class="pane"><strong>${e(text(item.label, '旁路'))}</strong> ${badge(item.channel === 'PLATFORM_ONLY' ? 'PLATFORM_ONLY' : 'CORROBORATION')}<p>${e(text(item.summary, ''))}</p></article>`).join('')
    : empty('本次未取得旁路佐证；旁路缺失不影响直接结论，也不得用其他视角替代直接链路判断。')
  const candidates = records(report.causes).map(cause => `<tr><td>${e(text(cause.title, cause.id))}</td><td>${badge(cause.status)}</td><td>${e((cause.support?.evidence_ids ?? []).length + ' / ' + (cause.refutation?.evidence_ids ?? []).length)}</td></tr>`).join('')
  return `<section class="card"><h2>分层核对（第二层）</h2>
    <div class="pane"><h3>直接检查状态与时间窗</h3><table><thead><tr><th>检查</th><th>证据状态</th><th>动作状态</th><th>观测时间</th><th>来源窗口</th></tr></thead><tbody>${rows || `<tr><td colspan="5">未保存检查事实</td></tr>`}</tbody></table>
      <p class="tiny muted">动作状态与证据状态分开保存：TIMEOUT/失败/部分结果可以与成功证据同时存在，不互相覆盖。</p></div>
    <div class="pane"><h3>候选状态</h3><table><thead><tr><th>候选</th><th>状态</th><th>支持/反驳</th></tr></thead><tbody>${candidates || `<tr><td colspan="3">未保存候选</td></tr>`}</tbody></table></div>
    <div class="pane"><h3>旁路佐证分区</h3><p class="tiny muted">直接链路（A-B）与旁路（A-C/B-C）分区呈现；CORROBORATION(旁路佐证) 只能旁证，PLATFORM_ONLY(仅平台视角) 不代表源端实测，均不得替代直接结论。</p>${sideBlock}</div>
    <div class="pane"><h3>建议清单</h3>${[asObject(c.primaryRecommendation), ...records(c.followupRecommendations)].filter(item => Object.keys(item).length).map(item => `<article class="pane"><strong>${e(text(item.recommendationId, '—'))} ${e(text(item.title, ''))}</strong> ${badge(item.state ?? 'PENDING')}<p class="tiny muted">${e(text(item.category, ''))} · 责任方 ${e(text(item.owner, '—'))} · 授权 ${e(text(item.authorization, '—'))} · 风险 ${e(text(item.risk, '—'))}</p></article>`).join('') || empty('未保存建议')}</div>
    <div class="pane"><h3>部分失败与未覆盖</h3>${(() => {
      const label = (list: any[]) => (list ?? []).map(item => typeof item === 'string' ? item : String(item?.check ?? '未命名检查')).join('、') || '无'
      const pf = c.partialFailures ?? {}
      return `<p>失败：${e(label(pf.failed))}<br>能力不可用：${e(label(pf.unavailable))}<br>未执行：${e(label(pf.notExecuted))}<br>无记录/成功无精确匹配：${e(label(pf.noData))}<br>有数据但证据不足：${e(label(pf.unknownEvidence))}</p>`
    })()}<p class="tiny muted">保留未执行、未配置、不支持、权限失败、超时、部分结果与查询无匹配的具体原因；不以空结果推断正常。</p></div></section>`
}

/** 只整理已保存安全事实；不修改输入、不执行诊断、不生成根因或恢复结论。 */
export function renderTroubleshootingReport(result: Record<string, any>): string {
  const report = asObject(safeProjection(result))
  const evidence: Evidence[] = records(report.items).map((item, index) => ({ id: `fact-${index}`, item, index }))
  const title = report.kind === 'business-access' ? '业务访问故障排查报告' : report.kind === 'device-offline' ? '设备不在线故障排查报告' : '故障排查报告'
  const symptomContent = `<h2>故障现象与事实证据</h2><p class="muted">先看已存报障与真实对象，再看证据和原判断；不按检查结果新建故障现象。</p><section class="pane"><h3>已保存故障现象</h3>${savedEntries(report.symptoms, '未保存独立结构化故障现象；本次排查类型和请求对象不替代用户原始报障描述。')}</section><section class="pane"><h3>独立附加异常</h3>${savedEntries(report.additional_anomalies, '未保存独立附加异常；不把告警条数、检查点或候选原因数量当附加异常数。')}</section><div class="cols">${renderScope(report)}${boundaries(report)}</div>${businessPaths(report)}<section class="pane"><h3>本次已存事实证据</h3>${factCards(evidence)}</section>${causes(report, true)}`
  const chainContent = `<h2>故障链与关联分析</h2>${chains(report)}`
  const processContent = `<h2>排查过程与证据审计</h2><p class="muted">执行状态、已存事实状态、业务结果、源观测时间与记录时间分开呈现。未保存的执行状态不从检查记录存在与否推断。</p>${processTable(evidence, true)}${gaps(report, evidence)}<details class="pane"><summary>完整安全证据与来源附录</summary><p class="tiny muted">逐项安全证据可通过“查看已保存检查证据”离线打开；以下附录不含完整原始响应。</p>${safeSources(report, evidence, true)}</details>`
  const closureContent = `<h2>处置与恢复验收</h2>${closure(report)}`
  const tabs = [
    { key: 'first', label: '① 首屏结论', content: firstScreen(report) },
    { key: 'layers', label: '② 分层核对', content: layers2(report) },
    { key: 'symptoms', label: '③ 故障现象', content: symptomContent },
    { key: 'chains', label: '④ 故障链与关联', content: chainContent },
    { key: 'process', label: '⑤ 排查过程', content: processContent },
    { key: 'closure', label: '⑥ 处置与恢复', content: closureContent },
  ]
  const content = `<section class="card"><div class="tabs" role="tablist" aria-label="故障报告页签">${tabs.map((tab, index) => `<button type="button" class="tab${index === 0 ? ' active' : ''}" data-tab="${e(tab.key)}" id="tab-${e(tab.key)}" role="tab" aria-controls="view-${e(tab.key)}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}">${e(tab.label)}</button>`).join('')}</div>${tabs.map((tab, index) => `<section data-view="${e(tab.key)}" id="view-${e(tab.key)}" role="tabpanel" aria-labelledby="tab-${e(tab.key)}" tabindex="0"${index === 0 ? '' : ' hidden'}>${tab.content}</section>`).join('')}</section>${evidence.map(entry => `<template id="evidence-content-${e(entry.id)}">${factDetail(entry)}</template>`).join('')}`
  const printContent = `${firstScreen(report)}${layers2(report)}${printChapter(1, '现象', `<section class="pane"><h3>已保存故障现象</h3>${savedEntries(report.symptoms, '未保存独立结构化故障现象；不补造原始报障。')}</section><section class="pane"><h3>附加异常</h3>${savedEntries(report.additional_anomalies, '未保存独立附加异常；不以原因或告警数替代。')}</section>${renderScope(report)}${boundaries(report)}`)}
    ${printChapter(2, '链路', chains(report))}
    ${printChapter(3, '过程', processTable(evidence, false))}
    ${printChapter(4, '处置恢复', closure(report))}
    ${printChapter(5, '完整判断依据', causes(report, false))}
    ${printChapter(6, '完整安全证据', `<p class="tiny muted">以下全量展开本报告的全部安全事实；不是未裁剪上游响应。</p>${evidence.length ? evidence.map(factDetail).join('') : empty('没有已保存事实证据；不补造采集结果。')}`)}
    ${printChapter(7, '缺口边界', `${gaps(report, evidence)}${boundaries(report)}`)}
    ${printChapter(8, '安全来源附录', safeSources(report, evidence, true))}`
  return renderDocument({ kind: 'fault', title, subtitle: '只读已存事实 · 支持不等于根因 · 未知不等于反驳 · 恢复验收独立记录',
    runId: text(report.run_id), generatedAt: text(report.generated_at), snapshot: report, content, printContent, interaction: 'fault' })
}
