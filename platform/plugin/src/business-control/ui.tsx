import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import type { AgentAccessRule } from './contracts.ts'
import type { BusinessControlManagementStatus, BusinessProviderView } from './management.ts'
import { businessControlStyle } from './style.ts'

type ProviderDraft = { enabled: boolean; endpoint: string; endpointHidden: boolean; timeout: string; testRunId: string }
type Draft = { revision: string; enabled: boolean; agents: string; operations: string; authentication: ProviderDraft; identityTrust: ProviderDraft
  riskAssessment: ProviderDraft; requiredKinds: string; inputMarkers: string; operationMarkers: string; reportMarkers: string; base: string }
type AgentCatalog = { agents: { id: string; name?: string; active_experiment?: string | null; version_count?: number }[]; experiments: { id: string; agent_id: string }[] }
const serialized = ({ revision: _revision, base: _base, ...value }: Draft) => JSON.stringify(value)
const dirty = (draft: Draft) => serialized(draft) !== draft.base
const lines = (text: string) => text.split(/[,\n]/).map(value => value.trim()).filter(Boolean)
// 保留键入中的分隔符；保存时由管理入口校验并规范化数组元素。
const draftList = (text: string) => text ? text.split(',') : []
const markerLines = (text: string) => text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
function draftOf(data: BusinessControlManagementStatus): Draft {
  const provider = (value?: BusinessProviderView): ProviderDraft => ({ enabled: value?.configured ?? false, endpoint: value?.endpoint ?? '', endpointHidden: value?.endpointHidden ?? false,
    timeout: value?.timeoutMs === undefined ? '' : String(value.timeoutMs), testRunId: value?.testRunId ?? '' })
  const value: Draft = { revision: data.revision, enabled: data.configuration.enabled, agents: JSON.stringify(data.configuration.agents, null, 2),
    operations: JSON.stringify(data.configuration.operations ?? [], null, 2), authentication: provider(data.configuration.authentication), identityTrust: provider(data.configuration.identityTrust),
    riskAssessment: provider(data.configuration.riskAssessment), requiredKinds: (data.configuration.riskAssessment?.requiredKinds ?? ['write', 'publish']).join(', '),
    inputMarkers: (data.configuration.detection?.inputMarkers ?? []).join('\n'), operationMarkers: (data.configuration.detection?.operationMarkers ?? []).join('\n'),
    reportMarkers: (data.configuration.detection?.reportMarkers ?? []).join('\n'), base: '' }
  value.base = serialized(value)
  return value
}
function providerPayload(value: ProviderDraft) {
  return !value.enabled ? null : { ...(value.endpoint.trim() || !value.endpointHidden ? { endpoint: value.endpoint.trim() } : {}),
    timeoutMs: value.timeout.trim() ? Number(value.timeout) : null, testRunId: value.testRunId.trim() || null }
}
function ProviderFields({ title, value, current, change }: { title: string; value: ProviderDraft; current: BusinessProviderView; change(value: ProviderDraft): void }) {
  return <div className="harness-composition-editor">
    <p>{current.mode === 'test-mock' ? '测试模拟提供方：由 fixture 标识或控制接口路径识别。' : current.configured ? '已配置提供方；本页没有执行连接探测。' : '尚未配置提供方。'}配置存在不代表身份核验或风险评估已通过。</p>
    <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={value.enabled} onChange={event => change({ ...value, enabled: event.target.checked })} />启用{title}</label>
    <label>{title}地址<input type="url" value={value.endpoint} placeholder={value.endpointHidden ? '原地址含私有部分，留空保留；可填写新的无凭据地址' : 'http://127.0.0.1:53101/api/v1/control/…'} onChange={event => change({ ...value, endpoint: event.target.value })} /></label>
    <label>{title}超时（毫秒）<input type="number" min={1} max={60000} placeholder="默认 1500" value={value.timeout} onChange={event => change({ ...value, timeout: event.target.value })} /></label>
    <label>{title}测试 fixture ID（可选）<input value={value.testRunId} onChange={event => change({ ...value, testRunId: event.target.value })} /></label>
    {value.endpointHidden && <p>原地址不回传私有部分；未填写新地址时保留原配置。提供方地址不接受用户名、密码、查询参数或片段。</p>}
  </div>
}
const actionNames: Record<string, string> = { read: '查询', write: '写入', publish: '报告发布' }
const stateNames: Record<string, string> = { verified: '已验证签名', unknown: '未知', expired: '已过期', disabled: '已停用', trusted: '身份条件已满足', revoked: '身份已撤销', mismatch: '来源或代次不匹配' }
const configurationTabs = [{ id: 'identity', label: '智能体身份' }, { id: 'risk', label: '风险评估' }, { id: 'authorization', label: '访问控制' }] as const

export function BusinessControlPage({ rpc, updates, active = true }: PlatformPageProps & { updates?: PlatformUpdates; active?: boolean }) {
  const [data, setData] = useState<BusinessControlManagementStatus | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState<string>('identity')
  const [runtimeSection, setRuntimeSection] = useState('instances')
  const [instanceId, setInstanceId] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [action, setAction] = useState('write')
  const [reason, setReason] = useState('')
  const [agentCatalog, setAgentCatalog] = useState<AgentCatalog | null>(null)
  const [agentCatalogError, setAgentCatalogError] = useState('')
  const [agentCatalogRevision, setAgentCatalogRevision] = useState(0)
  const [agentQuery, setAgentQuery] = useState('')
  const requestId = useRef(0)
  const reading = useRef<number | null>(null)
  const mounted = useRef(true)
  const mutating = useRef(false)
  function accept(value: BusinessControlManagementStatus) {
    setData(value)
    setDraft(previous => {
      if (previous && dirty(previous)) return previous
      return draftOf(value)
    })
    setInstanceId(previous => previous || value.instances[0]?.instanceId || '')
  }
  async function refresh() {
    if (mutating.current || reading.current !== null) return
    const id = ++requestId.current
    reading.current = id
    try {
      const response = await rpc.call(CHANNEL, 'mcp/control/status', {})
      if (!mounted.current || id !== requestId.current) return
      if (response.ok) { accept(response.value as BusinessControlManagementStatus); setLoadError('') }
      else setLoadError(response.error.message)
    } catch { if (mounted.current && id === requestId.current) setLoadError('无法读取统一网关状态，请检查连接。') }
    finally { if (reading.current === id) reading.current = null }
  }
  useEffect(() => {
    mounted.current = true
    // 常驻页面隐藏时仍接收写入回执；只有实际卸载才结束组件寿命。
    return () => { mounted.current = false; requestId.current++; reading.current = null }
  }, [])
  useEffect(() => {
    if (!active) return
    void refresh()
    // 回执与许可租期为 2 秒，页面每秒重读事实；轮询不修改草稿或发起业务。
    const timer = setInterval(() => { void refresh() }, 1000)
    const unsubscribe = updates?.subscribe(() => {
      if (updates.getSnapshot().domains.some(domain => domain === 'mcp' || domain === 'instances')) void refresh()
    })
    return () => { requestId.current++; reading.current = null; clearInterval(timer); unsubscribe?.() }
  }, [active, rpc, updates])
  useEffect(() => {
    if (!active) return
    let disposed = false, request = 0
    const readAgents = async () => {
      const id = ++request
      try {
        const response = await rpc.call(CHANNEL, 'agents/list', {})
        if (disposed || id !== request) return
        if (response.ok) { setAgentCatalog(response.value as AgentCatalog); setAgentCatalogError('') }
        else setAgentCatalogError(response.error.message)
      } catch { if (!disposed && id === request) setAgentCatalogError('无法读取智能体列表，请刷新重试；已选配置已保留。') }
    }
    void readAgents()
    const unsubscribe = updates?.subscribe(() => {
      if (updates.getSnapshot().domains.some(domain => domain === 'agents' || domain === 'catalog')) void readAgents()
    })
    return () => { disposed = true; unsubscribe?.() }
  }, [active, rpc, updates, agentCatalogRevision])
  async function perform(endpoint: string, payload: unknown) {
    if (mutating.current) return
    mutating.current = true
    setBusy(true); setError(''); setNotice('')
    // 先前发出的状态读取不能覆盖本次操作回执。
    requestId.current++
    reading.current = null
    try {
      const response = await rpc.call(CHANNEL, `mcp/control/${endpoint}`, payload)
      if (!mounted.current) return
      requestId.current++
      if (!response.ok) {
        setError(response.error.message)
        if (response.error.code === 'conflict') { mutating.current = false; void refresh() }
        return
      }
      const value = response.value as BusinessControlManagementStatus
      if (endpoint === 'saveConfiguration') {
        setDraft(draftOf(value))
        setNotice('配置已保存；实例是否应用请核对下方回执。')
      } else if (endpoint === 'restrict') setNotice('限制已保存；请核对实例回执。')
      else if (endpoint === 'release') setNotice(value.change?.currentPermission === 'deny'
        ? '所选限制已解除，当前请求仍受其他约束；没有重放业务。'
        : '重新评估后已解除所选限制；新请求仍会重验身份和许可，没有重放业务。')
      else setNotice('风险事实已重新评估；没有执行或重放业务。')
      accept(value)
      updates?.invalidate(['mcp', 'instances'])
    } catch { if (mounted.current) setError('操作结果未确认，请先刷新状态核对；没有自动重试。') }
    finally { mutating.current = false; if (mounted.current) setBusy(false) }
  }
  const instance = data?.instances.find(value => value.instanceId === instanceId)
  const agent = data?.configuration.agents.find(value => value.agentId === instance?.agentId)
  const conflict = !!draft && !!data && draft.revision !== data.revision
  const scope = instance && subjectId ? { workspaceId: instance.workspaceId, agentId: instance.agentId,
    instanceId: instance.instanceId, runtimeGeneration: instance.runtimeGeneration, subjectId,
    ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}) } : undefined
  function resetDraft() {
    if (!data) return
    setDraft(draftOf(data))
    setError('')
  }
  let agentDrafts: AgentAccessRule[] = [], operationDrafts: any[] = []
  try { const parsed = JSON.parse(draft?.agents ?? '[]'); if (Array.isArray(parsed)) agentDrafts = parsed } catch { /* 高级编辑中的未完成JSON保持草稿。 */ }
  try { const parsed = JSON.parse(draft?.operations ?? '[]'); if (Array.isArray(parsed)) operationDrafts = parsed } catch { /* 同上。 */ }
  const changeAgent = (index: number, value: Partial<AgentAccessRule>) => { if (draft) setDraft({ ...draft, agents: JSON.stringify(agentDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const selectAgent = (index: number, agentId: string) => {
    if (!agentCatalog?.agents.some(value => value.id === agentId) || agentDrafts[index]?.agentId === agentId) return
    // 更换配置对象不能沿用上一智能体的来源和身份启用状态。
    changeAgent(index, { agentId, enabled: false, sourceDigest: undefined, agentTrust: { enabled: false } })
  }
  const changeOperation = (index: number, value: Record<string, unknown>) => { if (draft) setDraft({ ...draft, operations: JSON.stringify(operationDrafts.map((row, at) => at === index ? { ...row, ...value } : row), null, 2) }) }
  const addAgent = () => { if (draft) { setDraft({ ...draft, agents: JSON.stringify([...agentDrafts, { agentId: '', enabled: false, subjects: [], actions: ['read'], serverIds: [], agentAuthentication: { enabled: true, method: 'hmac-sha256' }, agentTrust: { enabled: false } }], null, 2) }); setSection('identity') } }
  const freshFacts = data?.riskFacts.filter(value => Date.parse(value.expiresAt) > Date.now()) ?? []
  const highRiskCount = freshFacts.filter(value => value.level === 'high').length
  const unknownRiskCount = freshFacts.filter(value => value.status === 'unknown' || value.level === 'unknown' || value.level === undefined).length
  const riskOverview = !data?.riskFacts.length ? '尚无评估' : !freshFacts.length ? '评估已过期'
    : unknownRiskCount ? '存在未知评估' : `已评估范围内 ${highRiskCount} 项高风险`
  return <main className="harness-mcp-page harness-gateway-page" aria-label="统一网关管理">
      <style>{businessControlStyle}</style>
      <header className="harness-page-heading"><div><p>智能体身份、实时风险评估与访问控制</p></div><button type="button" disabled={busy} onClick={() => { void refresh(); setAgentCatalogRevision(value => value + 1) }}>刷新状态</button></header>
      {(loadError || error) && <p role="alert">{error || loadError}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data ? <section className="harness-card"><p role="status">正在读取统一网关状态…</p></section> : <>
        <div className="harness-gateway-status" aria-label="统一网关状态概览">
          <span>即时访问 <strong>{data.enabled ? '已开放' : '已关闭'}</strong><small>限制版本 {data.restrictionVersion}</small></span>
          <span title="已验证凭据、可信来源与实例绑定">身份核验 <strong>{data.agentStatuses.filter(value => value.trust.status === 'trusted').length} / {data.instances.length}</strong></span>
          <span title={`有效事实 ${freshFacts.length} / ${data.riskFacts.length} · 高风险 ${highRiskCount} · 未知 ${unknownRiskCount}`}>风险 <strong data-summary="risk">{riskOverview}</strong></span>
          <span>策略回执 <strong>{data.instances.filter(value => value.applied).length} / {data.instances.length}</strong></span>
        </div>
        <p className="harness-guide" role="note">首期仅覆盖经统一业务网关发起的即时任务。暂不支持定时任务的检测、防护闭环；定时巡检、自动研判和报表需手动发起，存在延迟和漏执行风险。现有研究实例的定时任务不纳入本闭环的完整保护声明。</p>
        {conflict && <p role="alert">配置已在其他位置更新，当前草稿已保留。请复制需要的修改，放弃草稿后按最新版本编辑；旧草稿不能覆盖新配置。</p>}
        <div className="harness-gateway-workspace">
        <section className="harness-card harness-composition-detail" aria-label="功能配置">
        <div className="harness-section-heading"><h2>功能配置</h2><span className="harness-gateway-description">三类配置共用一份草稿</span></div>
        <nav className="harness-mcp-toolbar harness-mcp-tabs" aria-label="统一网关功能">{configurationTabs.map(tab => <button key={tab.id} type="button" aria-current={section === tab.id ? 'page' : undefined} onClick={() => setSection(tab.id)}>{tab.label}</button>)}</nav>
        {draft && <form className="harness-composition-editor harness-gateway-config" aria-label="统一网关配置" onSubmit={event => {
          event.preventDefault()
          try { void perform('saveConfiguration', { revision: draft.revision, enabled: draft.enabled, agents: JSON.parse(draft.agents), operations: JSON.parse(draft.operations),
            authentication: providerPayload(draft.authentication), identityTrust: providerPayload(draft.identityTrust),
            riskAssessment: draft.riskAssessment.enabled ? { ...providerPayload(draft.riskAssessment), requiredKinds: lines(draft.requiredKinds) } : null,
            detection: { inputMarkers: markerLines(draft.inputMarkers), operationMarkers: markerLines(draft.operationMarkers), reportMarkers: markerLines(draft.reportMarkers) } }) }
          catch { setError('Agent 策略或操作授权 JSON 无效，当前草稿已保留。') }
        }}>
          <div className="harness-gateway-savebar"><div><label className="harness-gateway-inline"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />开放即时业务访问</label><small>{dirty(draft) ? '有未保存更改' : '已与当前配置同步'}</small></div><div className="harness-mcp-actions"><button className="harness-primary" type="submit" disabled={busy || !dirty(draft) || conflict}>保存业务访问配置</button><button type="button" disabled={busy} onClick={resetDraft}>放弃草稿并读取当前配置</button></div></div>
          {!agentDrafts.length && <div className="harness-gateway-empty"><strong>尚未配置业务 Agent</strong><p>先登记智能体身份并核对可信来源，再配置风险评估和访问范围。</p><button type="button" className="harness-primary" onClick={addAgent}>配置首个 Agent</button></div>}
          <fieldset hidden={section !== 'identity'}><legend>1．智能体身份</legend>
            <p>验证智能体的身份凭据、可信来源与实例绑定。身份过期、撤销或来源不匹配直接阻断访问，不折算成业务风险分数；低风险不能覆盖身份条件失败。</p>
            <div className="harness-gateway-identity"><section aria-label="认证方式与凭据"><h3>认证方式与凭据</h3>
            <p>当前支持受信部署域内的 HMAC SHA-256 签名，只有有效的真实签名才显示已验证。</p>
            {!!agentDrafts.length && <label>搜索智能体<input type="search" value={agentQuery} placeholder="按名称或 Agent ID 搜索" onChange={event => setAgentQuery(event.target.value)} /></label>}
            {agentCatalogError ? <p role="alert">{agentCatalogError}<button type="button" onClick={() => setAgentCatalogRevision(value => value + 1)}>重试智能体列表</button></p>
              : !agentCatalog ? <p role="status">正在读取智能体列表…</p> : !agentCatalog.agents.length && <p>当前没有可选智能体，请先在智能体管理中新建。</p>}
            {agentDrafts.map((row, index) => <div key={index} className="harness-composition-editor harness-gateway-agent">
              <label>选择智能体<select aria-label={`选择智能体 ${index + 1}`} value={row.agentId ?? ''} disabled={!agentCatalog || !!agentCatalogError} onChange={event => selectAgent(index, event.target.value)}>
                <option value="" disabled>请选择已有智能体</option>
                {!!row.agentId && !agentCatalog?.agents.some(value => value.id === row.agentId) && <option value={row.agentId}>{row.agentId}（{agentCatalog && !agentCatalogError ? '当前未找到，保留配置' : '列表未就绪，保留配置'}）</option>}
                {agentCatalog?.agents.filter(value => value.id === row.agentId || `${value.name ?? ''} ${value.id}`.toLowerCase().includes(agentQuery.trim().toLowerCase())).map(value => <option key={value.id} value={value.id} disabled={agentDrafts.some((other, at) => at !== index && other.agentId === value.id)}>{value.name && value.name !== value.id ? `${value.name}（${value.id}）` : value.id}</option>)}
              </select></label>
              {!!row.agentId && agentCatalog && !agentCatalogError && !agentCatalog.agents.some(value => value.id === row.agentId) && <p role="status">该智能体当前未在资产列表中找到，原配置已保留。</p>}
              <label>Agent ID<input readOnly value={row.agentId ?? ''} placeholder="选择后自动关联" /></label>
              {!!row.agentId && <details><summary>查看版本与业务实例</summary><p>当前启用版本：{agentCatalog?.agents.find(value => value.id === row.agentId)?.active_experiment || '未记录'}</p><p>已登记版本：{agentCatalog?.experiments.filter(value => value.agent_id === row.agentId).map(value => value.id).join('、') || '当前无可展示记录'}</p>
                {data.instances.filter(value => value.agentId === row.agentId).map(value => <p key={value.instanceId}>{value.instanceId} · {value.runtimeGeneration} · 实际来源 <code>{value.sourceDigest}</code></p>)}
                {!data.instances.some(value => value.agentId === row.agentId) && <p>尚无该智能体的业务实例与来源登记。</p>}
              </details>}
              <small>选择后需分别核对来源、身份启用和访问策略。</small>
              <label>认证方式<select value="hmac-sha256" onChange={() => changeAgent(index, { agentAuthentication: { enabled: row.agentAuthentication?.enabled ?? true, method: 'hmac-sha256' } })}><option value="hmac-sha256">HMAC SHA-256（当前支持）</option></select></label>
              <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={row.agentAuthentication?.enabled ?? true} onChange={event => changeAgent(index, { agentAuthentication: { enabled: event.target.checked, method: 'hmac-sha256' } })} />启用该 Agent 的签名认证</label>
            </div>)}
            {data.agentStatuses?.length ? <ul className="harness-gateway-list">{data.agentStatuses.map(value => <li key={value.instanceId}>{value.agentId} / {value.instanceId}：{stateNames[value.authentication.status]}<p>最近验证 {value.authentication.verifiedAt ?? '尚无验证证据'} · 有效期 {value.authentication.expiresAt ?? '未知'}</p></li>)}</ul> : <p>尚无 Agent 签名认证事实，状态为未知。</p>}
            {!!data.instances.length && <details className="harness-gateway-auxiliary"><summary>查看实例实际绑定与来源</summary>{data.instances.map(value => <p key={value.instanceId}><code>{value.workspaceId}</code> / {value.agentId} / {value.instanceId} / {value.runtimeGeneration} · 实际来源 <code>{value.sourceDigest}</code></p>)}</details>}
            </section><section aria-label="可信来源与身份状态"><h3>可信来源与身份状态</h3>
            <p>核对当前代次的有效签名、已建立的回执及固定来源。这里说明身份条件是否满足；当前访问策略是否应用另看实例回执。</p>
            {agentDrafts.map((row, index) => <div key={index} className="harness-composition-editor harness-gateway-agent"><strong>{row.agentId || '待填写 Agent'}</strong>
              <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={row.agentTrust?.enabled ?? true} onChange={event => changeAgent(index, { agentTrust: { enabled: event.target.checked } })} />允许该智能体身份（取消即撤销）</label>
              <label className="harness-mcp-wide">{row.agentId || 'Agent'} 的可信固定来源<input value={row.sourceDigest ?? ''} onChange={event => changeAgent(index, { sourceDigest: event.target.value || undefined })} placeholder="填写已核对的 sourceDigest；缺失时为未知" /></label>
            </div>)}
            {data.agentStatuses?.length ? <ul className="harness-gateway-list">{data.agentStatuses.map(value => <li key={value.instanceId}>{value.agentId} / {value.instanceId}：{stateNames[value.trust.status]}<p>依据 {value.trust.reason} · 代次 {value.trust.runtimeGeneration ?? '未知'} · 限制版本 {value.trust.restrictionVersion}</p></li>)}</ul> : <p>尚无可信来源核验事实，身份条件为未知。</p>}
            </section></div>
          </fieldset>
          <fieldset hidden={section !== 'risk'}><legend>2．风险评估</legend>
            <p>按业务事件实时自动评估各 Agent：输入、每个工具或资源执行步骤、报告发布与下载。风险变化自动参与执行许可；手动重评仅为辅助。空闲周期巡检不在首期范围。</p>
            <div className="harness-gateway-facts">{data.configuration.agents.map(row => {
              const facts = data.riskFacts.filter(fact => fact.scope.agentId === row.agentId), valid = facts.filter(fact => Date.parse(fact.expiresAt) > Date.now())
              const label = !facts.length ? '尚未评估' : !valid.length ? '评估已过期' : valid.some(fact => fact.level === 'high') ? '高风险（已评估范围）'
                : valid.some(fact => fact.status === 'unknown' || fact.level === 'unknown') ? '存在未知评估' : valid.every(fact => fact.level === 'low') ? '低风险（已评估范围）' : '已评估，未提供风险等级'
              const latest = [...facts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]
              const instances = data.instances.filter(value => value.agentId === row.agentId)
              return <article key={row.agentId}><h4>{row.agentId}：{label}</h4><p>最新评估 {latest?.observedAt ?? '尚无事实'} · 当前有效事实 {valid.length}/{facts.length} · 人工限制 {data.restrictions.filter(value => value.active && value.scope.agentId === row.agentId).length} · 实例回执 {instances.filter(value => value.applied).length}/{instances.length}</p>
                <p>依据：{latest?.signals.length ? latest.signals.map(value => `${value.code}=${value.value}（${value.reason}）`).join('；') : latest ? '最近事实未附加拒绝信号；不据此推断整个 Agent 无风险' : '尚无评估依据'}</p></article>
            })}</div>
            <ProviderFields title="Agent 风险评估提供方" value={draft.riskAssessment} current={data.configuration.riskAssessment} change={value => setDraft({ ...draft, riskAssessment: value })} />
            <label>必须自动评估的动作（逗号分隔）<input value={draft.requiredKinds} onChange={event => setDraft({ ...draft, requiredKinds: event.target.value })} placeholder="write, publish" /></label>
            <p>检测标记每行一个，仅验证已配置的检测接入，不代表通用攻击识别。</p>
            <div className="harness-composition-editor">{(['inputMarkers', 'operationMarkers', 'reportMarkers'] as const).map((key, index) => <label key={key}>{['输入检测标记', '执行参数检测标记', '报告检测标记'][index]}<textarea value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div>
          </fieldset>
          <fieldset hidden={section !== 'authorization'}><legend>3．访问控制</legend>
            <p>配置智能体可访问的服务、工具、资源和动作。执行时综合身份核验、当前风险与资源归属作出允许或拒绝；身份有效或低风险不会自动增加权限。</p>
            {agentDrafts.map((row, index) => <div key={index} className="harness-composition-editor harness-gateway-agent">
              <strong>{row.agentId || '待填写智能体身份'}</strong>
              <label style={{ display: 'flex', alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={row.enabled ?? false} onChange={event => changeAgent(index, { enabled: event.target.checked })} />开放该 Agent</label>
              <label>允许访问的服务（逗号分隔）<input value={(row.serverIds ?? []).join(',')} onChange={event => changeAgent(index, { serverIds: draftList(event.target.value) })} /></label>
              <label>允许的动作（逗号分隔）<input value={(row.actions ?? []).join(',')} onChange={event => changeAgent(index, { actions: draftList(event.target.value) })} /></label>
              <label>允许接入的用户主体（辅助）<input value={(row.subjects ?? []).join(',')} onChange={event => changeAgent(index, { subjects: draftList(event.target.value) })} /></label>
              <button type="button" onClick={() => setDraft({ ...draft, agents: JSON.stringify(agentDrafts.filter((_, at) => at !== index), null, 2) })}>移除该 Agent 全部配置</button>
            </div>)}
            <button type="button" onClick={addAgent}>添加 Agent 配置</button>
            <div className="harness-table-scroll"><table className="harness-gateway-operation-table" aria-label="工具与资源操作允许清单"><thead><tr><th>服务／操作</th><th>动作／方法</th><th>实际目标</th><th>必要确认</th><th>编辑</th></tr></thead><tbody>{operationDrafts.map((row, index) => <tr key={index}>
              <td><input aria-label={`服务 ID ${index + 1}`} value={row.serverId ?? ''} onChange={event => changeOperation(index, { serverId: event.target.value })} /><input aria-label={`操作 ID ${index + 1}`} value={row.operationId ?? ''} onChange={event => changeOperation(index, { operationId: event.target.value })} /></td>
              <td><select aria-label={`动作 ${index + 1}`} value={row.kind ?? 'read'} onChange={event => changeOperation(index, { kind: event.target.value })}>{['read', 'write', 'resource', 'publish'].map(value => <option key={value} value={value}>{value}</option>)}</select><input aria-label={`方法 ${index + 1}`} value={row.method ?? ''} onChange={event => changeOperation(index, { method: event.target.value })} /></td>
              <td><input aria-label={`实际目标 ${index + 1}`} value={row.target ?? ''} placeholder={row.targetHidden ? '原目标私有部分不回传，留空保留' : 'http://…/path/{id}'} onChange={event => changeOperation(index, { target: event.target.value, targetHidden: !event.target.value && !!row.targetHidden })} /></td>
              <td><input aria-label={`必要确认 ${index + 1}`} type="checkbox" checked={row.confirmation ?? false} onChange={event => changeOperation(index, { confirmation: event.target.checked })} /></td>
              <td><button type="button" onClick={() => setDraft({ ...draft, operations: JSON.stringify(operationDrafts.filter((_, at) => at !== index), null, 2) })}>移除操作</button></td>
            </tr>)}{!operationDrafts.length && <tr><td colSpan={5}>尚无操作允许清单。添加工具或资源操作后才可授权实际目标。</td></tr>}</tbody></table></div>
            <button type="button" onClick={() => setDraft({ ...draft, operations: JSON.stringify([...operationDrafts, { serverId: '', operationId: '', kind: 'read', method: 'GET', target: '' }], null, 2) })}>添加工具或资源操作</button>
            <p>actions 支持 read、write、resource、publish、agent:access、session:create、session:read、session:prompt 或 *。资源读取由 resource 动作及 resources/read 的实际目标约束；这里只配置现有允许清单。</p>
            <details><summary>高级 JSON 编辑</summary><label>Agent 规则 JSON<textarea aria-label="Agent 规则 JSON" rows={10} spellCheck={false} value={draft.agents} onChange={event => setDraft({ ...draft, agents: event.target.value })} /></label><label>操作授权 JSON<textarea aria-label="操作授权 JSON" rows={10} spellCheck={false} value={draft.operations} onChange={event => setDraft({ ...draft, operations: event.target.value })} /></label></details>
          </fieldset>
          <details className="harness-gateway-auxiliary"><summary>辅助：接入用户验证</summary>
            <p>这里只验证接入用户及其有效状态，用于区分会话归属，不能代替智能体身份核验。</p>
            <ProviderFields title="接入用户认证提供方" value={draft.authentication} current={data.configuration.authentication} change={value => setDraft({ ...draft, authentication: value })} />
            <ProviderFields title="接入用户状态核验提供方" value={draft.identityTrust} current={data.configuration.identityTrust} change={value => setDraft({ ...draft, identityTrust: value })} />
            {data.sessionTrustFacts?.length ? <ul>{data.sessionTrustFacts.map(value => <li key={value.sessionId}>{value.subjectId} / {value.sessionId}：{value.state === 'evidence-held' ? '持有已验证身份记录（非实时探测）' : '身份记录已过期'} · 验证时间 {value.verifiedAt ?? '未知'} · 有效期 {value.expiresAt ?? '未知'} · 观察时间 {value.observedAt}</li>)}</ul> : <p>尚无用户会话信任事实。</p>}
          </details>
        </form>}
        </section>
        <section className="harness-card harness-composition-detail" aria-label="运行工作区">
        <div className="harness-section-heading"><h2>运行工作区</h2><span className="harness-gateway-description">配置保存与实际应用分别核对</span></div>
        <nav className="harness-mcp-toolbar harness-mcp-tabs" aria-label="运行观察">{[{ id: 'instances', label: '实例与回执' }, { id: 'risk', label: '风险与限制' }, { id: 'events', label: '执行记录' }].map(tab => <button key={tab.id} type="button" aria-current={runtimeSection === tab.id ? 'page' : undefined} onClick={() => setRuntimeSection(tab.id)}>{tab.label}</button>)}</nav>
        <div hidden={runtimeSection !== 'instances'}><h3>实例应用回执</h3>
        <p className="harness-gateway-description">许可租期上限：2 秒 · 在线回执目标：2 秒</p>
        {data.instances.length ? <div className="harness-table-scroll"><table><thead><tr><th>实例</th><th>Agent</th><th>当前代次</th><th>回执版本</th><th>实际应用</th></tr></thead><tbody>{data.instances.map(value => <tr key={value.instanceId}>
          <td>{value.instanceId}</td><td>{value.agentId}</td><td>{value.runtimeGeneration}</td><td>{value.acknowledgement?.restrictionVersion ?? '尚无回执'}</td>
          <td>{value.applied ? '已应用（2 秒内有效回执）' : '未确认；到期许可不能用于受保护动作'}</td>
        </tr>)}</tbody></table></div> : <p>暂无已登记业务实例。配置保存不表示实例已经应用。</p>}</div>

        <div hidden={runtimeSection !== 'risk'}>
        <div className="harness-gateway-runtime-layout"><div><h3>当前限制</h3>
        {data.restrictions.length ? <ul className="harness-gateway-list">{data.restrictions.map(value => <li key={value.id}>
          <strong>{value.active ? '限制中' : '已解除'}</strong> · {value.scope.subjectId} · {value.scope.agentId} · {value.scope.instanceId ?? '所选工作区内匹配实例'}{value.scope.sessionId ? ` · ${value.scope.sessionId}` : ''}
          <p>{value.deniedActions.map(action => actionNames[action] ?? action).join('、')}：{value.reason}</p>
          {value.active && <button type="button" disabled={busy || !sessionId.trim()} onClick={() => void perform('release', { restrictionId: value.id, sessionId: sessionId.trim(), action: value.deniedActions[0] })}>重新评估并解除</button>}
        </li>)}</ul> : <p>暂无人工运行限制。风险事实和基础授权仍会参与每次请求判断。</p>}
        </div><aside><h3>辅助：收紧指定实例与接入用户范围</h3>
        <form className="harness-composition-editor" onSubmit={event => { event.preventDefault(); if (scope) void perform('restrict', { scope, deniedActions: [action], reason }) }}>
          <label>业务实例<select required value={instanceId} onChange={event => { setInstanceId(event.target.value); setSubjectId(''); setSessionId('') }}><option value="">请选择实例</option>{data.instances.map(value => <option key={value.instanceId} value={value.instanceId}>{value.instanceId}（{value.agentId}）</option>)}</select></label>
          <label>业务主体<select required value={subjectId} onChange={event => { setSubjectId(event.target.value); setSessionId('') }}><option value="">请选择主体</option>{agent?.subjects.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>动作<select value={action} onChange={event => setAction(event.target.value)}>{Object.entries(actionNames).map(([value, label]) => <option key={value} value={value}>{label}（{value}）</option>)}</select></label>
          <label>Session ID（可选；重新评估和解除时必填）<input maxLength={500} value={sessionId} onChange={event => setSessionId(event.target.value)} /></label>
          <label className="harness-mcp-wide">收紧依据<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <div className="harness-mcp-actions"><button type="submit" disabled={busy || !scope || !reason.trim()}>收紧所选动作</button><button type="button" disabled={busy || !scope || !sessionId.trim()} onClick={() => void perform('reassess', { sessionId: sessionId.trim(), action, scope })}>辅助重评当前 Session</button></div>
        </form>
        <p>收紧必须处于该主体的基础许可内。当前表单限定一个实例和主体；填写 Session 后进一步限定会话。重新评估只更新风险事实。</p>

        </aside></div>

        <details className="harness-gateway-auxiliary"><summary>查看全部风险事实（{data.riskFacts.length}）</summary>
        {data.riskFacts.length ? <ul className="harness-gateway-list">{data.riskFacts.map(value => <li key={value.id}>{value.scope.subjectId ?? '所选范围'} · {value.scope.sessionId ?? value.scope.agentId} · 版本 {value.version} · {Date.parse(value.expiresAt) <= Date.now() ? '已过期' : value.status === 'assessed' ? '已评估' : '未知'} · 有效期至 {value.expiresAt}
          <p>{value.signals.length ? value.signals.map(signal => `${signal.code}=${signal.value}（${signal.reason}）`).join('；') : '无新增风险约束'}</p>
        </li>)}</ul> : <p>尚无风险事实。实际受保护动作仍须按配置完成必要评估。</p>}</details></div>

        <div hidden={runtimeSection !== 'events'}><h3>最近执行结果</h3>
        {data.events.length ? <div className="harness-table-scroll"><table><thead><tr><th>时间</th><th>主体／会话</th><th>动作／操作</th><th>结果</th><th>依据</th></tr></thead><tbody>{data.events.slice(-30).reverse().map(value => <tr key={value.id}>
          <td>{value.at}</td><td>{value.subjectId} / {value.sessionId}</td><td>{value.action} / {value.operationId}</td><td>{value.outcome}</td><td>{value.reason ?? '—'}</td>
        </tr>)}</tbody></table></div> : <p>暂无受管执行记录。</p>}</div>
        </section></div>
      </>}
  </main>
}
