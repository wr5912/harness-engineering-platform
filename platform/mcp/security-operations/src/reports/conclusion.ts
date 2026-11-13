/** 两场景共用：统一结论对象、状态映射、建议生命周期与回显事实校验。 */

export const statusLabels = Object.freeze({
  CONFIRMED: '已确认',
  SUPPORTED: '得到支持',
  REFUTED: '被反驳',
  UNKNOWN: '未知',
  CONFLICT: '证据冲突',
  INSUFFICIENT_CAPABILITY: '能力不足',
} as const)

export const stopLabels = Object.freeze({
  CONFIRMED_END: '已确认结束',
  EVIDENCE_INSUFFICIENT: '证据不足停止',
  CAPABILITY_STOP: '能力不足停止',
  BUDGET_STOP: '预算耗尽停止',
  CONFLICT_STOP: '证据冲突停止',
} as const)

export const recommendationStates = Object.freeze(['PENDING:待处理', 'ACCEPTED:已接单', 'IN_PROGRESS:执行中', 'COMPLETED:已完成', 'VERIFIED:已验证', 'DEFERRED:暂缓', 'NOT_APPLICABLE:不适用'] as const)

const codeOf = (value: string) => String(value).split(':')[0]

export function labelOf(mapping: Record<string, string>, value: unknown) {
  const key = String(value ?? '')
  return mapping[key] ? `${key}(${mapping[key]})` : `${key || 'UNKNOWN'}(${mapping[key] ?? '未知'})`
}

/** 六态代码 → 统一代码；未知输入不猜测。 */
export function normalizedStatus(value: unknown) {
  const key = String(value ?? '').toLowerCase()
  const map: Record<string, keyof typeof statusLabels> = {
    confirmed: 'CONFIRMED', supported: 'SUPPORTED', refuted: 'REFUTED', unknown: 'UNKNOWN',
    conflict: 'CONFLICT', insufficient_capability: 'INSUFFICIENT_CAPABILITY',
  }
  return map[key] ?? 'UNKNOWN'
}

export function stopStatusOf(input: { terminal?: string; stopReason?: string; causes?: any[]; requestCount?: number; requestLimit?: number }) {
  const causes = Array.isArray(input.causes) ? input.causes : []
  if (causes.some(cause => cause?.status === 'confirmed')) return 'CONFIRMED_END'
  if (causes.some(cause => cause?.status === 'conflict')) return 'CONFLICT_STOP'
  const reason = String(input.stopReason ?? '')
  if (/预算|到限/.test(reason) || (Number.isFinite(input.requestCount) && Number.isFinite(input.requestLimit) && Number(input.requestCount) >= Number(input.requestLimit))) return 'BUDGET_STOP'
  if (/能力|权限|执行点|未核|缺少/.test(reason)) return 'CAPABILITY_STOP'
  return 'EVIDENCE_INSUFFICIENT'
}

/**
 * 影响等级只由已确认影响范围、业务重要性、持续时间计算，与根因置信度分开。
 * 范围级别由调用方按已核事实给出：service(单服务)/host(单主机)/segment(网段)/multi(多网段)。
 */
export function impactLevel(input: { scope?: string; businessCritical?: boolean; durationHours?: number | null; confirmed?: boolean }) {
  const scopeRank: Record<string, number> = { service: 1, host: 2, segment: 3, multi: 4 }
  // 影响未确认且业务重要性/持续时间未知时不得默认低风险。
  if (input.confirmed !== true && input.businessCritical === undefined && input.durationHours == null) {
    return { level: 'UNKNOWN', label: 'UNKNOWN(待评估)', basis: { scope: input.scope ?? 'service', businessCritical: 'unknown', durationHours: null, confirmedImpact: false },
      note: '仅知对象范围，业务重要性与持续时间未核实；不按低风险处理，也不代表根因置信度' }
  }
  const rank = scopeRank[String(input.scope ?? 'service')] ?? 1
  let score = rank + (input.businessCritical ? 2 : 0)
  if (Number.isFinite(input.durationHours ?? NaN)) {
    const hours = Number(input.durationHours)
    score += hours >= 24 ? 3 : hours >= 4 ? 2 : hours >= 1 ? 1 : 0
  }
  const level = score >= 7 ? 'CRITICAL' : score >= 5 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW'
  const labels: Record<string, string> = { CRITICAL: '严重', HIGH: '高', MEDIUM: '中', LOW: '低' }
  return { level, label: `${level}(${labels[level]})`, basis: { scope: input.scope ?? 'service', businessCritical: input.businessCritical === true, durationHours: input.durationHours ?? null, confirmedImpact: input.confirmed === true },
    note: '仅按已确认影响范围/业务重要性/持续时间计算，不代表根因置信度' }
}

function recommendation(input: { id: string; title: string; kind: 'check' | 'response'; owner: string; prerequisites: string[]; authorization: string; risk: string; done: string; verify: string; state?: string }) {
  return { recommendationId: input.id, title: input.title, category: input.kind === 'check' ? '核查建议(只读)' : '响应处置建议(需授权，默认不执行)',
    owner: input.owner, prerequisites: input.prerequisites, authorization: input.authorization, risk: input.risk,
    completionCriteria: input.done, verificationMethod: input.verify, state: input.state ?? 'PENDING', stateLabel: 'PENDING(待处理)' }
}

const capabilityGap = (fact: any) => /能力|权限|NOT_SUPPORTED|INSUFFICIENT/i.test(`${fact?.status} ${fact?.message ?? ''} ${JSON.stringify(fact?.gaps ?? '')}`)

/** 由已保存事实构建统一结论；不新增因果，不把支持写成确认。 */
export function buildConclusion(report: any) {
  const kind = report?.kind === 'device-offline' ? 'device-offline' : 'business-access'
  const items: any[] = Array.isArray(report?.items) ? report.items : []
  const causes: any[] = Array.isArray(report?.causes) ? report.causes : []
  const scope = report?.scope ?? {}
  const runId = String(report?.run_id ?? '')
  const confirmedCause = causes.find(cause => cause?.status === 'confirmed' && !causes.some(other => other?.status === 'conflict'))
  const supportedCause = causes.find(cause => cause?.status === 'supported')
  const conflict = causes.some(cause => cause?.status === 'conflict')
  const rootStatus = conflict ? 'CONFLICT' : confirmedCause ? 'CONFIRMED' : supportedCause ? 'SUPPORTED'
    : items.some(capabilityGap) ? 'INSUFFICIENT_CAPABILITY' : 'UNKNOWN'
  const currentStatus = rootStatus === 'CONFLICT' ? 'CONFLICT' : confirmedCause ? 'CONFIRMED' : rootStatus
  const stopStatus = stopStatusOf({ terminal: report?.terminal, stopReason: report?.stop_reason ?? report?.diagnostic_loop?.stop_reason,
    causes, requestCount: report?.request_count, requestLimit: report?.request_limit })
  const objects = kind === 'device-offline'
    ? { asset: scope.asset?.ip ?? report?.input?.asset?.ip, observer: scope.observer?.ip }
    : { source: scope.source?.ip ?? report?.input?.source?.ip, target: scope.target?.ip ?? report?.input?.target?.ip, protocol: scope.protocol ?? report?.input?.protocol, port: scope.port ?? report?.input?.port }
  const targetText = kind === 'device-offline' ? `设备 ${objects.asset ?? '未核'}` : `${objects.source ?? '未核'} → ${objects.target ?? '未核'} ${objects.protocol ?? '?'}/${objects.port ?? '?'}`
  // 按真实动作状态互斥分类：失败 > 不可用 > 未执行 > 成功无匹配；不得用“无数据”吞掉失败。
  const actionOf = (item: any) => String(item?.execution_status ?? '')
  const failed = items.filter(item => actionOf(item) === 'failed' || ['failed', 'partial'].includes(String(item?.status)) || (item?.error && String(item?.error).trim()))
  // 未执行优先于“不可用”：动作根本没跑时不能记为不可用结果。
  const notExecuted = items.filter(item => !failed.includes(item) && actionOf(item) === 'not_executed')
  const unavailable = items.filter(item => !failed.includes(item) && !notExecuted.includes(item) && (actionOf(item) === 'unavailable' || String(item?.status) === 'unavailable'))
  // 只有“明确无记录/精确空匹配”才算无数据；有数据但证据不足另列 inconclusive。
  const explicitlyEmpty = (item: any) => {
    const evidence = item?.evidence ?? {}, check = String(item?.check ?? '')
    if (check === 'portEvidence') return /NO_RECORD/i.test(String(evidence?.status ?? ''))
    if (check === 'policyEvidence') return Array.isArray(evidence?.exact) && evidence.exact.length === 0
      && Array.isArray(evidence?.destination) && evidence.destination.length === 0
    if (check === 'routeEvidence') return Array.isArray(evidence?.candidates) && evidence.candidates.length === 0
    return false
  }
  const unknownCompleted = items.filter(item => !failed.includes(item) && !unavailable.includes(item) && !notExecuted.includes(item)
    && String(item?.status) === 'unknown' && actionOf(item) === 'completed' && !item?.error)
  const noData = unknownCompleted.filter(explicitlyEmpty)
  const inconclusive = unknownCompleted.filter(item => !explicitlyEmpty(item))
  const supporting = (confirmedCause ?? supportedCause)?.support?.evidence_ids ?? []
  const contradicting = (confirmedCause ?? supportedCause)?.refutation?.evidence_ids ?? []
  const rawGaps = [...(Array.isArray(report?.gaps) ? report.gaps : []), ...items.flatMap(item => Array.isArray(item?.gaps) ? item.gaps : [])]
  const gapKey = (gap: any) => typeof gap === 'string' ? gap : String(gap?.reason ?? gap?.message ?? JSON.stringify(gap))
  const gaps = [...new Map(rawGaps.map((gap: any) => [gapKey(gap), gap])).values()]
  const gapAll = gaps.map(gapKey).join(' | ')
  const topGap = gaps.find((gap: any) => typeof gap === 'string' || gap?.reason) as any
  const gapText = typeof topGap === 'string' ? topGap : topGap?.reason

  const incidentSummary = kind === 'device-offline'
    ? `设备 ${objects.asset ?? '未核'} 在线/可用性存疑${scope.observer ? `，观察源 ${scope.observer}` : '，未提供观察源'}；已保存 ${items.length} 项检查事实。`
    : `业务访问异常：${targetText}；已保存 ${items.length} 项检查事实。`
  const impactScope = kind === 'device-offline'
    ? { scope: 'host', objects, text: `单设备 ${objects.asset ?? '未核'}${failed.length ? `；${failed.length} 项检查失败/不可用` : ''}`, boundary: '仅覆盖本次已核对象；未证明同网段其他设备受影响' }
    : { scope: 'service', objects, text: `单服务 ${targetText}${failed.length ? `；${failed.length} 项检查失败/不可用` : ''}`, boundary: '仅覆盖该五元组；未证明其他源/目标或端口受影响' }

  const evidenceRefs = items.map(item => ({ check: item?.check, factId: item?.id, nodeId: item?.node_id, runId: item?.run_id ?? runId,
    evidenceStatus: normalizedStatus(item?.status), actionStatus: item?.execution_status ?? 'unknown',
    observedAt: item?.observed_at ?? null, rawReceiptRefs: item?.raw_receipt_refs ?? [] }))

  const socChannelFailure = items.some(item => /503|认证服务暂不可用|service unavailable/i.test(String(item?.error ?? item?.message ?? '')))
  let primary: any
  const followup = (() => {
    const list: any[] = []
    if (socChannelFailure) list.push(recommendation({
      id: 'R1', kind: 'check', title: `请 SOC 平台维护责任方核查只读接口 503/认证服务可用性（当前查询 ${objects.target ?? objects.asset ?? '对象'} 时失败）`,
      owner: 'SOC 平台维护责任方', prerequisites: ['保留本次 Run 与原始回执作为通道失败证据', '不在业务侧重试或更换凭据'],
      authorization: '无需变更授权；仅只读核查', risk: '只读；不得据此判断业务故障或凭据错误',
      done: '取得通道恢复时间、影响范围与可核回执；或明确该接口当前不可用',
      verify: '通道恢复后以相同对象与只读参数重跑本诊断，确认事实由 failed 转为可核' }))
    if (kind === 'device-offline') {
      if (items.some((item: any) => item?.check === 'management-observation') || /管理|电源|网卡/.test(gapAll)) list.push(recommendation({
        id: 'R2', kind: 'check', title: `请虚拟化/宿主平台责任方只读核对 ${objects.asset ?? '该设备'} 的电源、客户机系统与虚拟网卡状态`,
        owner: '虚拟化/宿主平台管理员（该 VM 归属团队）',
        prerequisites: ['确认该地址由对应宿主承载', '只在管理面只读查看，不做开关机、迁移或重配'],
        authorization: '需宿主管理面只读账号；本编排不执行任何操作',
        risk: '只读；不得据此重启、迁移或改网络配置',
        done: '取得带来源与时区的电源状态、客户机系统事件、虚拟网卡链路三类中至少一项可核证据',
        verify: `以 asset=${objects.asset ?? '同对象'} 重跑本诊断，确认 management 事实由 unavailable 变为可核并附新来源` }))
      if (!items.some((item: any) => /collection-run-state|collection-binding|collection-capability/.test(String(item?.check)))) list.push(recommendation({
        id: 'R3', kind: 'check', title: '请 SOC 采集责任方核对绑定采集设备的原始心跳时间与采集任务状态',
        owner: 'SOC 采集/接入运维团队',
        prerequisites: ['确认该设备已绑定采集设备', '只读查询采集心跳与任务状态'],
        authorization: '只读；本编排不执行配置变更',
        risk: '只读；lastSeenAt/资产更新时间不能替代原始心跳',
        done: '取得原始心跳观测时间、采集任务状态与数据源，并注明时区',
        verify: '重跑本诊断，确认采集相关事实由未执行/未知转为可核，且缺口说明相应减少' }))
    } else {
      if (items.some((item: any) => item?.check === 'portEvidence') || /端口|NO_RECORD/.test(gapAll)) list.push(recommendation({
        id: 'R2', kind: 'check', title: `请 ${objects.target ?? '目标主机'} 的系统责任方只读核对 ${objects.port ?? '该端口'}/${objects.protocol ?? 'tcp'} 的监听与主机防火墙规则`,
        owner: '目标主机系统管理员',
        prerequisites: ['已确认目标 IP 与归属', '只读查看监听与防火墙，不改规则、不重启服务'],
        authorization: '需主机只读权限；本编排不执行变更',
        risk: '只读；不得以修改防火墙替代根因确认',
        done: '取得监听状态（含进程/服务名）与防火墙规则的可核来源，并注明观测时间',
        verify: `以 ${objects.source ?? '同源'} → ${objects.target ?? '同目标'} ${objects.protocol ?? 'tcp'}/${objects.port ?? ''} 重跑本诊断，确认端口证据由 NO_RECORD 转为可核结论` }))
      if (/NAT|回程|OPNSENSE|策略|路由|首跳|sameSession/i.test(gapAll)) list.push(recommendation({
        id: 'R3', kind: 'check', title: '请网络责任方只读关联该五元组的策略决策、NAT 转换与回程路径',
        owner: '网络/防火墙运维团队',
        prerequisites: ['对象与五元组保持冻结', '仅查询已有日志与配置，不新增探测'],
        authorization: '只读；本编排不执行任何网络变更',
        risk: '只读；静态候选策略不等于实际生效',
        done: '取得同一会话的策略决策、NAT 前后地址与回程记录，或明确说明日志范围不足',
        verify: '重跑本诊断，确认策略/路径候选由 unknown 转为有来源的结论或明确能力缺口' }))
    }
    if (!list.length) list.push(recommendation({
      id: 'R2', kind: 'check', title: `请责任团队只读补齐 ${objects.target ?? objects.asset ?? '该对象'} 尚未取得的证据`,
      owner: '对象归属责任团队', prerequisites: ['对象与范围保持冻结'], authorization: '只读',
      risk: '只读；不得据此执行变更', done: '缺失项取得带来源与观测时间的可核结论',
      verify: '重跑本诊断并核对新增事实的来源与候选状态' }))
    return list
  })()
  // 未确认根因时，首要建议取最具体的核查责任方，避免“补齐证据/一线值班”泛化。
  if (rootStatus === 'CONFIRMED') {
    primary = recommendation({ id: 'R1', kind: 'response', title: '按已确认根因完成修复并由值班复验', owner: '对应设备/策略责任团队', prerequisites: ['已确认根因与受影响对象', '具备变更授权'], authorization: '需变更审批；本编排不执行任何写操作', risk: '变更可能短时扩大影响', done: '原五元组恢复且证据可复核', verify: '复跑本次诊断，确认根因候选转为 REFUTED 且访问恢复' })
  } else {
    primary = followup.shift() ?? recommendation({ id: 'R1', kind: 'check', title: `请 ${objects.target ?? objects.asset ?? '对象归属方'} 责任团队只读补齐尚未取得的证据`, owner: '对象归属责任团队', prerequisites: ['对象与范围保持冻结'], authorization: '无需变更授权；仅只读', risk: '只读；不得据此执行变更', done: '缺失项取得带来源与观测时间的可核结论', verify: '复跑诊断并核对新增事实的来源、时间与候选状态' })
  }
  const followupFinal = followup.slice(0, 2)
  const escalation = socChannelFailure
    ? { required: true, to: 'SOC 平台维护责任方', trigger: 'SOC 只读接口返回 503/认证服务暂不可用：当前取证通道不可用，不代表业务故障或凭据错误', conditions: ['持续不可用超过当班处置窗口', '同一通道的其他诊断/巡检也无法取证'] }
    : unavailable.length ? { required: true, to: '对象归属维护团队', trigger: '存在不可用/无执行点的检查项，本地无管理执行点', conditions: ['需宿主/系统责任方提供只读证据', '或明确该能力未接入'] }
      : rootStatus === 'CONFLICT' || failed.length
        ? { required: true, to: '二线网络/系统团队', trigger: rootStatus === 'CONFLICT' ? '证据冲突需人工裁决' : '存在失败的部分检查项', conditions: ['一线只读补齐后仍未知', '涉及策略变更或设备重启'] }
        : { required: false, to: '—', trigger: '当前无强制升级条件；影响仍待评估', conditions: ['影响范围扩大或出现业务中断时升级'] }

  return {
    conclusionVersion: '1.0',
    kind,
    runId,
    currentStatus: labelOf(statusLabels, currentStatus),
    currentStatusCode: currentStatus,
    impactLevel: impactLevel({ scope: impactScope.scope, businessCritical: undefined, durationHours: null, confirmed: rootStatus === 'CONFIRMED' }),
    incidentSummary,
    impactScope,
    rootCause: {
      status: labelOf(statusLabels, rootStatus),
      statusCode: rootStatus,
      title: rootStatus === 'UNKNOWN' ? '根因尚未确认' : (confirmedCause ?? supportedCause)?.title ?? (rootStatus === 'CONFLICT' ? '候选证据冲突，需人工裁决' : '能力不足，无法继续判定'),
      supportingFacts: supporting,
      contradictingFacts: contradicting,
      gaps: gaps.slice(0, 12),
      note: rootStatus === 'UNKNOWN' ? '不以证据不足填充具体根因' : '支持不等于确认；确认需完整确认判据',
    },
    primaryRecommendation: primary,
    followupRecommendations: followupFinal,
    escalation,
    recommendationLifecycle: [primary, ...followupFinal].map(item => ({ recommendationId: item.recommendationId, state: item.state, stateLabel: item.stateLabel })),
    stopStatus: labelOf(stopLabels, stopStatus),
    stopStatusCode: stopStatus,
    verificationMethod: kind === 'device-offline'
      ? '复跑同参数只读诊断，核对同对象候选状态与新增事实来源；不以 SOC 在线标签代替真实响应'
      : '复跑同五元组只读诊断，核对监听/策略/路径候选状态与新增事实来源；不以旁路或静态候选替代直接结论',
    evidenceRefs,
    partialFailures: { failed: failed.map(item => ({ check: item?.check, status: item?.status, actionStatus: actionOf(item), reason: item?.message ?? item?.error ?? null })),
      unavailable: unavailable.map(item => ({ check: item?.check, status: item?.status, actionStatus: actionOf(item), reason: item?.message ?? item?.error ?? null })),
      notExecuted: notExecuted.map(item => item?.check),
      noData: noData.map(item => item?.check),
      successNoMatch: noData.map(item => item?.check),
      inconclusive: inconclusive.map(item => ({ check: item?.check, status: item?.status, reason: item?.message ?? null })),
      unknownEvidence: inconclusive.map(item => item?.check),
      note: '失败、不可用、未执行、明确无记录/精确空匹配、有数据但证据不足分别保存；任一分类不吞并其他分类（successNoMatch 仅含明确空匹配，兼容保留）' },
    activeProbes: report?.active_probes_executed === false || report?.active_checks_executed === false ? 'NOT_EXECUTED(未执行主动检查)' : 'UNRECORDED(未记录)',
    sideChannelPolicy: { direct: '仅 direct 结论可作为根因依据', corroboration: 'CORROBORATION(旁路佐证)', platformOnly: 'PLATFORM_ONLY(仅平台视角)' },
  }
}

/** 结构化回退摘要：事实校验失败时用它替代 LLM 自由叙述。 */
export function structuredSummary(conclusion: any) {
  return [
    `当前状态：${conclusion?.currentStatus ?? 'UNKNOWN(未知)'}；影响等级：${conclusion?.impactLevel?.label ?? '—'}；停止状态：${conclusion?.stopStatus ?? '—'}`,
    `故障概况：${conclusion?.incidentSummary ?? '—'}`,
    `当前根因判断：${conclusion?.rootCause?.title ?? '根因尚未确认'}（${conclusion?.rootCause?.status ?? 'UNKNOWN(未知)'}）`,
    `首要建议：${conclusion?.primaryRecommendation?.title ?? '—'}`,
  ].join('\n')
}

/**
 * LLM 回显事实校验：对象、方向、协议端口、Run 号、根因强度、证据状态。
 * 返回违规项；有违规时应回退 structuredSummary。
 */
export function validateEcho(conclusion: any, text: string) {
  const body = String(text ?? '')
  const violations: string[] = []
  if (!body.trim()) return { ok: false, violations: ['EMPTY_ECHO'] }
  const scope = conclusion?.impactScope?.objects ?? {}
  const ips = [scope.source, scope.target, scope.asset, scope.observer].filter(Boolean)
  if (ips.length && !ips.some(ip => body.includes(String(ip)))) violations.push('OBJECT_MISSING')
  const foreign = (body.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).filter(ip => !ips.includes(ip))
  if (foreign.length) violations.push(`OBJECT_EXTRA:${[...new Set(foreign)].slice(0, 3).join(',')}`)
  if (scope.port !== undefined && !body.includes(String(scope.port))) violations.push('PORT_MISSING')
  if (scope.protocol && !new RegExp(`\\b${scope.protocol}\\b`, 'i').test(body)) violations.push('PROTOCOL_MISSING')
  if (conclusion?.runId && !body.includes(conclusion.runId)) violations.push('RUN_ID_MISSING')
  const rootCode = conclusion?.rootCause?.statusCode
  if (rootCode !== 'CONFIRMED' && /(根因(?:已|是|为)?(?:确认|确定)|已定位根因|确定是)/.test(body)) violations.push('ROOT_OVERCLAIM')
  // 逐处判断：仅当某次“未监听”表述前文没有否定词时才算把无记录当未监听。
  const unNegated = [...body.matchAll(/未监听|没有监听/g)].some(match => {
    const before = body.slice(Math.max(0, (match.index ?? 0) - 10), match.index ?? 0)
    return !/(不等于|不能|不得|并非|不是|非)\s*$/.test(before)
  })
  if (unNegated && rootCode !== 'CONFIRMED') violations.push('NO_RECORD_AS_NOT_LISTENING')
  if (/(旁路|CORROBORATION|PLATFORM_ONLY)/.test(body) && /源端(?:实测|已测)|实测源端/.test(body)) violations.push('SIDECHANNEL_AS_DIRECT')
  if (/(检查完成|已完成检查)/.test(body) && rootCode !== 'CONFIRMED' && /(根因|定位)/.test(body)) violations.push('CHECK_AS_ROOTCAUSE')
  const statusWord = conclusion?.rootCause?.status ?? ''
  if (statusWord && !body.includes(statusWord.split('(')[0])) violations.push('ROOT_STATUS_MISSING')
  return { ok: violations.length === 0, violations, fallback: violations.length ? structuredSummary(conclusion) : null }
}
