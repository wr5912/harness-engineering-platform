import { retiredLocalRiskFact, type ControlScope, type InstanceBinding, type RiskFact } from './contracts.ts'
import type { BusinessControlManagementStatus } from './management.ts'
import { currentRiskFacts, developmentSynchronized } from './overview.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'

type ManagedInstance = BusinessControlManagementStatus['instances'][number]
export interface GatewayAccessRegistration {
  phase: 'loading' | 'ready' | 'error'
  rows: readonly { name: string; agent_id: string; state?: string }[]
  error?: string
}
export interface GatewayAccessStateProps {
  data: BusinessControlManagementStatus | null
  selectedAgentId: string
  selectedServerId?: string
  registration: GatewayAccessRegistration
  statusLoading?: boolean
  statusError?: string
  now?: number
  onNavigateRisk(): void
  onNavigateOverview(): void
}

/** 与核心匹配规则一致的实例维度；用户、会话、服务和内容条件仍须按请求匹配。 */
export function matchesGatewayInstanceScope(scope: ControlScope, instance: Pick<InstanceBinding, 'workspaceId' | 'agentId' | 'instanceId' | 'runtimeGeneration'>): boolean {
  return scope.workspaceId === instance.workspaceId && scope.agentId === instance.agentId
    && (scope.instanceId === undefined || scope.instanceId === instance.instanceId)
    && (scope.runtimeGeneration === undefined || scope.runtimeGeneration === instance.runtimeGeneration)
}

const actionLabels: Record<string, string> = { read: '读取', resource: '读取资源', write: '写入', publish: '发布',
  'agent:access': '访问智能体', 'session:create': '创建会话', 'session:read': '读取会话', 'session:prompt': '发送消息' }
const actionLabel = (action: string) => action === '*' ? '全部动作' : actionLabels[action] ?? action
const validUntil = (value: string, now: number) => Number.isFinite(Date.parse(value)) && Date.parse(value) > now

function Scope({ scope, instances, contentDigest }: { scope: ControlScope; instances: ManagedInstance[]; contentDigest?: string }) {
  return <div className="harness-gateway-access-scope">
    <span>实例 {scope.instanceId ?? instances.map(instance => instance.instanceId).join('、')} · 工作区 {scope.workspaceId} · 运行代次 {scope.runtimeGeneration ?? '未限定'}</span>
    <span>接入用户 {scope.subjectId ?? '未限定'} · 会话 {scope.sessionId ?? '未限定'} · 服务 {scope.serverId ?? '未限定'}</span>
    {contentDigest && <span>内容依据 <code>{contentDigest}</code></span>}
  </div>
}

function denialLabels(fact: RiskFact, data: BusinessControlManagementStatus): Array<{ label: string; contentBound: boolean }> {
  const result: Array<{ label: string; contentBound: boolean }> = []
  const append = (label: string, contentBound = !!fact.contentDigest || !!fact.operationBinding) => {
    if (!result.some(item => item.label === label && item.contentBound === contentBound)) result.push({ label, contentBound })
  }
  for (const signal of fact.signals) {
    if (signal.code === 'deny-all' && signal.value === 'true') append('全部匹配请求')
    const appliesAction = (action: string) => !fact.operationBinding || fact.operationBinding.kind === action || fact.operationBinding.kind === 'resource' && action === 'read'
    if (signal.code.startsWith('deny-') && signal.value === 'true' && actionLabels[signal.code.slice(5)] && appliesAction(signal.code.slice(5))) append(actionLabel(signal.code.slice(5)))
    if (signal.code !== 'deny-operation') continue
    if (signal.value === '*') append('全部匹配请求')
    else if (actionLabels[signal.value] && appliesAction(signal.value)) append(actionLabel(signal.value))
    // 旧事实按既有操作 ID 规则，新条件事实还须匹配对应操作与输入。
    for (const operation of data.configuration.operations.filter(item => item.operationId === signal.value
      && (fact.scope.serverId === undefined || fact.scope.serverId === item.serverId)
      && (!fact.operationBinding || fact.operationBinding.serverId === item.serverId && fact.operationBinding.operationId === item.operationId && fact.operationBinding.kind === item.kind))) {
      append(`操作 ${operation.serverId} / ${operation.operationId}（${actionLabel(operation.kind)}）`, !!fact.operationBinding)
    }
  }
  return result
}

export const gatewayAccessStateStyle = `
.harness-gateway-access-state{min-width:0;margin-top:20px;padding-top:20px;border-top:1px solid var(--hep-border);font-size:13px}
.harness-gateway-access-state header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.harness-gateway-access-state h3{margin:0;font-size:15px}.harness-gateway-access-state h4{margin:0 0 8px;font-size:13px}
.harness-gateway-access-state header small{display:block;margin-top:4px;color:var(--hep-muted)}
.harness-gateway-access-state p{margin:0 0 10px;line-height:1.65}.harness-gateway-access-state nav{display:flex;gap:16px;flex-wrap:wrap;flex-shrink:0}
.harness-gateway-access-state button{border:0;background:transparent;padding:0;color:var(--hep-link);font:inherit;cursor:pointer;text-align:left;white-space:nowrap}
.harness-gateway-access-state button:hover{text-decoration:underline}.harness-gateway-access-state button:focus-visible{outline:2px solid var(--hep-link);outline-offset:4px}
.harness-gateway-access-state section+section{margin-top:16px}.harness-gateway-access-state ul{margin:0;padding:0;list-style:none}
.harness-gateway-access-state li{padding:10px 0;border-bottom:1px solid var(--hep-border)}.harness-gateway-access-state li:first-child{padding-top:0}.harness-gateway-access-state li:last-child{border-bottom:0;padding-bottom:0}
.harness-gateway-access-receipt>span{display:block;margin-top:4px;overflow-wrap:anywhere}.harness-gateway-access-state li>strong{display:block;font-weight:600}.harness-gateway-access-state li>small{display:block;margin-top:4px;color:var(--hep-muted)}
.harness-gateway-access-state .harness-gateway-access-scope{display:grid;gap:4px;margin-top:5px;line-height:1.6;color:var(--hep-muted);overflow-wrap:anywhere}
.harness-gateway-access-state code{font:inherit}.harness-gateway-access-state .harness-gateway-access-note{margin-top:16px;color:var(--hep-muted);font-size:12px}
.harness-gateway-access-state [data-access-notice]{color:var(--hep-muted)}.harness-gateway-access-state [data-access-notice=unknown]{color:var(--hep-warning)}
@media(max-width:680px){.harness-gateway-access-state header{flex-direction:column;gap:10px}.harness-gateway-access-state nav{gap:20px}}
`

/** 已保存事实的只读投影，不从草稿或风险等级推导整智能体的许可。 */
export function GatewayAccessState({ data, selectedAgentId, selectedServerId, registration, statusLoading = false, statusError = '', now = Date.now(), onNavigateRisk, onNavigateOverview }: GatewayAccessStateProps) {
  const stale = !!statusError
  const agent = data?.configuration.agents.find(item => item.agentId === selectedAgentId)
  const registered = registration.phase === 'ready' ? registration.rows.filter(item => item.agent_id === selectedAgentId) : []
  const instances = (data?.instances ?? []).filter(instance => instance.agentId === selectedAgentId
    && registered.some(row => row.name === instance.instanceId))
  const published = instances.filter(instance => instance.identityMode !== 'development')
  const inCurrentScope = (scope: ControlScope) => published.filter(instance => matchesGatewayInstanceScope(scope, instance))
  const records = currentRiskFacts(data?.riskFacts ?? [], now).map(item => item.fact).filter(fact => inCurrentScope(fact.scope).length > 0
    && (!selectedServerId || fact.scope.serverId === undefined || fact.scope.serverId === selectedServerId))
  const facts = records.filter(fact => !retiredLocalRiskFact(fact))
  const automatic = !!data?.configuration.riskAssessment.configured
  const denials = automatic && data ? facts.filter(fact => validUntil(fact.expiresAt, now))
    .map(fact => ({ fact, labels: denialLabels(fact, data) })).filter(item => item.labels.length > 0) : []
  const manual = (data?.restrictions ?? []).filter(item => item.active && inCurrentScope(item.scope).length > 0
    && (!selectedServerId || item.scope.serverId === undefined || item.scope.serverId === selectedServerId))
  const externalAuthorization = !!data?.configuration.accessAuthorization?.configured
  const receipts = (data?.events ?? []).filter(event => event.authorization && event.scope && inCurrentScope(event.scope).length > 0
    && (!selectedServerId || event.scope.serverId === selectedServerId)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6)
  const policies = agent?.toolPolicies?.filter(policy => !selectedServerId || policy.serverId === selectedServerId) ?? []
  const expired = facts.filter(fact => !validUntil(fact.expiresAt, now)).length
  const unknown = facts.filter(fact => fact.status === 'unknown').length
  const unobserved = registered.filter(row => !instances.some(instance => instance.instanceId === row.name)).length
  const required = data?.configuration.riskAssessment.requiredKinds ?? ['write', 'publish']
  const reading = statusLoading || registration.phase === 'loading'
  return <section className="harness-gateway-access-state" aria-label="运行时限制" data-access-evidence={stale ? 'snapshot' : reading || !data || registration.phase !== 'ready' ? 'unknown' : 'current'}>
    <style>{gatewayAccessStateStyle}</style>
    <header><div><h3>当前访问决定与限制</h3><small>来自已保存配置与运行事实{stale ? ' · 上次读取，当前状态待确认' : ''}</small>{data && reading && <LoadingIndicator label="核对运行时限制" />}</div>
      <nav aria-label="运行时限制相关页面"><button type="button" onClick={onNavigateRisk}>查看风险评估</button><button type="button" onClick={onNavigateOverview}>查看应用回执与处置</button></nav></header>
    {statusError && <p role="status" data-access-notice="unknown">网关状态读取失败：{statusError}。以下是上次读取的事实，不能确认当前许可。</p>}
    {!data ? statusLoading ? <LoadingIndicator label="读取已保存的访问控制状态" block /> : <p role="status">尚无已保存状态，运行时限制未知。</p>
      : !selectedAgentId ? <p>请选择智能体，核对其运行时限制。</p>
        : registration.phase !== 'ready' ? <p role="status" data-access-notice="unknown">{registration.phase === 'error' ? `实例登记读取失败${registration.error ? `：${registration.error}` : ''}` : '实例登记尚未确认'}，当前作用范围未知，暂不将历史记录列为生效约束。</p>
          : <>
            <p data-access-source={externalAuthorization ? 'third-party-first' : 'manual'}><strong>授权方式：{externalAuthorization ? '第三方优先，手动兜底' : '手动配置'}</strong></p>
            <section aria-label="最近访问决定"><h4>最近访问决定</h4>{receipts.length ? <ul>{receipts.map((event, index) => { const receipt = event.authorization!; return <li className="harness-gateway-access-receipt" key={`${event.at}:${event.requestId ?? index}`} data-authorization-source={receipt.source}><strong>{receipt.decision === 'allow' ? '允许' : receipt.decision === 'deny' ? '禁止' : '执行前确认'} · {receipt.source === 'third-party' ? '第三方决定' : receipt.source === 'manual-fallback' ? '手动兜底' : '手动配置'}</strong><span>{event.at} · {event.operationId || event.action}</span>{receipt.reason && <span>{receipt.reason}</span>}{receipt.policyVersion && <small>策略版本 {receipt.policyVersion}{receipt.expiresAt ? ` · 此次决定有效至 ${receipt.expiresAt}${validUntil(receipt.expiresAt, now) ? '' : ' · 回执已过期'}` : ''}</small>}<Scope scope={event.scope!} instances={inCurrentScope(event.scope!)}/></li> })}</ul> : <p>尚无当前实例的访问决定记录。</p>}<p data-access-notice>这里只展示对应请求的已记录决定，不代表智能体永久获准；新请求会重新查询并核对。</p></section>
            <p data-access-automatic={automatic ? 'on' : 'off'}><strong>自动风险评估：{automatic ? '已开启' : '已关闭'}</strong>{automatic && data.configuration.riskAssessment.mode === 'test-mock' ? ' · 测试模拟提供方' : ''}{!automatic && '；旧自动评估只作历史记录，不参与当前许可。'}</p>
            {!agent || !data.configuration.enabled || !agent.enabled ? <p data-access-notice="unknown">{!agent ? '所选智能体尚未登记业务访问身份，请在智能体身份页完成登记。' : !data.configuration.enabled ? '工作区业务入口已关闭。' : '该智能体的业务访问已关闭。'}身份、归属与手动临时限制仍须满足。</p> : null}
            {!registered.length ? <p data-access-notice="unknown">所选智能体没有当前实例登记；历史实例记录不作为当前运行时限制。</p> : null}
            {unobserved > 0 && <p data-access-notice="unknown">{unobserved} 个当前登记实例尚无网关绑定事实，运行状态待确认。</p>}
            {instances.length > published.length && <p>{instances.length - published.length} 个实例处于开发调试模式，发布阶段的自动评估和人工限制不适用。</p>}
            {published.length > 0 && <>
              {policies.length > 0 && <section aria-label="已保存的手动兜底策略"><h4>已保存的手动兜底策略</h4><ul>{policies.map(policy => {
                const conditional = policy.rules.filter(rule => Object.keys(rule.when).length > 0).length
                return <li key={policy.serverId} data-policy-server={policy.serverId}><strong>{policy.serverId} · 默认{policy.defaultEffect === 'allow' ? '按基础权限允许' : policy.defaultEffect === 'deny' ? '禁止执行' : '执行前确认'}</strong>
                  <small>{policy.rules.length - conditional} 条工具或动作规则 · {conditional} 条第三方条件{automatic ? '已启用' : '已暂停'}</small></li>
              })}</ul><p data-access-notice>这里显示手动兜底设置；第三方返回有效决定时，不再用这套工具规则重复裁决；未配置或不可用时才按此处理。规则是否命中在对应请求中判定；尚未执行的规则不表示已经触发。{!automatic && '自动评估关闭时，仅执行默认处理、工具或动作规则和人工限制。'}</p></section>}
              {records.length > facts.length && <p data-access-notice>{records.length - facts.length} 条旧本地标记记录仅作历史依据，不再参与运行时限制。</p>}
              <section aria-label="自动评估附加限制"><h4>{stale ? '上次读取的自动拒绝信号' : '自动评估附加限制'}</h4>
                {denials.length ? <ul>{denials.map(({ fact, labels }) => <li key={fact.id} data-risk-id={fact.id}>
                  <strong>{labels.map(item => item.label).join('；')}</strong>
                  <Scope scope={fact.scope} instances={inCurrentScope(fact.scope)} contentDigest={fact.contentDigest ?? fact.operationBinding?.inputDigest}/>
                  {fact.operationBinding && <small>仅操作 {fact.operationBinding.serverId} / {fact.operationBinding.operationId} · {actionLabel(fact.operationBinding.kind)}，须匹配相同目标与参数。</small>}
                  <small>适用参数：{fact.operationBinding ? '仅同一操作、目标与相同参数' : !fact.contentDigest ? '未限定内容参数' : labels.every(item => item.contentBound) ? '仅相同内容'
                    : labels.every(item => !item.contentBound) ? '具体操作 ID 匹配，不限定内容参数；摘要为本条评估依据' : '动作限制仅相同内容；具体操作 ID 限制不限定内容参数'}</small>
                  <small>有效至 {fact.expiresAt}{fact.status === 'unknown' ? ' · 评估状态未知，不表示低风险' : ''} · {fact.signals.filter(signal => signal.reason).map(signal => signal.reason).join('；') || '未附加说明'}</small>
                </li>)}</ul> : <p>{automatic ? '当前读取范围未发现有效自动拒绝信号，不能据此确认所有请求均获许可。' : '自动评估已关闭，没有自动评估附加限制。'}</p>}
                {automatic && <p data-access-notice="unknown">{!facts.length ? '当前实例尚无评估记录。' : `${unknown ? `${unknown} 条评估结果未知。` : ''}${expired ? `${expired} 条评估记录已过期。` : ''}评估仅覆盖各条记录的用户、会话、服务和内容范围。`}{required.length ? ` ${required.map(actionLabel).join('、')}请求会尝试获取匹配评估；` : ' '}风险服务不可用时不生成评估；访问控制服务仍会查询，需要手动兜底时使用基础处理与纯工具规则，依赖缺失风险的条件暂停。未记录拒绝不等于已放开。</p>}
              </section>
              <section aria-label="人工限制"><h4>{stale ? '上次读取的人工限制' : '人工限制'} · {manual.length} 项</h4>
                {manual.length ? <ul>{manual.map(item => <li key={item.id} data-restriction-id={item.id}>
                  <strong>{item.deniedActions.map(actionLabel).join('、')} · {item.reason}</strong><Scope scope={item.scope} instances={inCurrentScope(item.scope)}/><small>未解除；不随自动评估关闭而失效。</small>
                </li>)}</ul> : <p>当前读取范围没有未解除的人工限制。</p>}
              </section>
            </>}
            {instances.length > 0 && <section aria-label="配置应用回执"><h4>配置应用回执{stale ? ' · 上次读取' : ''}</h4><ul>{instances.map(instance => {
              const row = registered.find(item => item.name === instance.instanceId)
              if (instance.identityMode === 'development') {
                const label = row?.state !== 'running' ? '运行状态待核对' : stale ? '上次读取的同步记录，当前待确认'
                  : instance.synchronization?.lastError ? '记录同步失败，不阻断开发交互'
                    : developmentSynchronized(instance) ? '开发记录已同步，无需发布许可回执' : '尚无开发记录同步回执'
                return <li key={instance.instanceId} data-access-instance={instance.instanceId}>{instance.instanceId} · {label}
                  {instance.synchronization?.lastSuccessAt && <small>最近成功同步 {instance.synchronization.lastSuccessAt}</small>}
                  {instance.synchronization?.lastError && <small>{instance.synchronization.lastError}</small>}</li>
              }
              const acknowledgement = instance.acknowledgement, age = acknowledgement ? now - Date.parse(acknowledgement.at) : NaN
              const applied = instance.applied && acknowledgement?.restrictionVersion === data.restrictionVersion
                && Number.isFinite(age) && age >= 0 && age < data.coverage.acknowledgementDeadlineMs
              const label = row?.state !== 'running' ? row?.state === 'absent' ? '实例未运行，未确认应用' : '运行状态待核对'
                : applied ? stale ? '上次读取时已同步，当前待确认' : '当前配置已同步' : '当前配置应用待核对'
              return <li key={instance.instanceId} data-access-instance={instance.instanceId}>{instance.instanceId} · {label}{acknowledgement && <small>回执版本 {acknowledgement.restrictionVersion} / 当前版本 {data.restrictionVersion} · {acknowledgement.at}</small>}</li>
            })}</ul></section>}
            <p className="harness-gateway-access-note">以上显示匹配范围内的附加约束。每次请求仍核对第三方决定或手动兜底、身份、来源和当前参数；配置已同步也不等于业务请求获准。</p>
          </>}
  </section>
}
