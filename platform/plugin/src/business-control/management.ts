import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { prepareBusinessRuntimeFile } from './secret-file.ts'
import { dirname, join } from 'node:path'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { BusinessControlError, getBusinessControl } from './core.ts'
import { readProviderProtocol } from './protocol-documents.ts'
import { agentAccessActions, businessOperationMethods, validAgentToolPolicies, type AgentAccessRule, type BusinessAccessConfig, type BusinessContext, type ControlScope, type OperationRule, type ProviderConfig, type Restriction, type RiskFact, type SessionTrustFact } from './contracts.ts'

const actions = ['read', 'write', 'publish'] as const
const scopeKeys = ['workspaceId', 'agentId', 'subjectId', 'instanceId', 'runtimeGeneration', 'sessionId', 'serverId']
const fail = (code: string, message: string): never => { throw new BusinessControlError(code, message) }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_request', '请求参数必须是对象')
  return value as Record<string, unknown>
}
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) return fail('invalid_request', `${label}无效`)
  return value.trim()
}
const sameScope = (scope: ControlScope, context: BusinessContext): boolean => Object.entries(scope).every(([key, value]) => value === undefined
  || key === 'serverId' || value === (key === 'subjectId' ? context.subject.id : context.scope[key as keyof ControlScope]))
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const operationKinds = ['read', 'write', 'resource', 'publish']

function editableUrl(value: unknown, provider = false): string {
  const input = text(value, provider ? '提供方地址' : '执行目标')
  let url: URL
  try { url = new URL(input) } catch { return fail('invalid_request', '请填写有效的 HTTP(S) 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || (provider ? !!url.search : [...url.searchParams.keys()].some(key => /token|secret|password|credential|authorization|api[-_]?key/i.test(key)))) {
    return fail('invalid_request', '地址不能包含凭据、敏感查询参数或片段；提供方地址也不能包含查询参数')
  }
  return input
}
function publicUrl(value: string, provider = false): string {
  try { return editableUrl(value, provider) } catch { return '' }
}
export interface BusinessProviderView {
  configured: boolean; endpoint: string; endpointHidden: boolean; timeoutMs?: number; testRunId?: string
  mode: 'test-mock' | 'external-provider' | 'unconfigured'
}
function providerView(value?: ProviderConfig, kind?: 'riskAssessment'): BusinessProviderView {
  const endpoint = value ? publicUrl(value.endpoint, true) : ''
  let mock = kind === 'riskAssessment' && !!value?.testRunId
  try { mock ||= new URL(value!.endpoint).pathname.startsWith('/api/v1/control/') } catch { /* 未配置不产生已验证事实。 */ }
  return { configured: !!value, endpoint, endpointHidden: !!value && !endpoint,
    ...(value?.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}), ...(kind === 'riskAssessment' && value?.testRunId ? { testRunId: value.testRunId } : {}),
    mode: !value ? 'unconfigured' : mock ? 'test-mock' : 'external-provider' }
}
function providerPatch(value: unknown, previous?: ProviderConfig): ProviderConfig | undefined {
  if (value === null) return undefined
  const input = object(value)
  if (Object.keys(input).some(key => !['endpoint', 'timeoutMs', 'testRunId', 'requiredKinds'].includes(key))) return fail('invalid_request', '提供方配置包含未知字段，本页不接收凭据')
  const result = { ...previous } as ProviderConfig
  if (input.endpoint !== undefined) result.endpoint = editableUrl(input.endpoint, true)
  else if (!previous?.endpoint) return fail('invalid_request', '请填写提供方地址')
  if (input.timeoutMs === null) delete result.timeoutMs
  else if (input.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(input.timeoutMs) || (input.timeoutMs as number) < 1 || (input.timeoutMs as number) > 60000) return fail('invalid_request', '提供方超时必须为 1 至 60000 毫秒')
    result.timeoutMs = input.timeoutMs as number
  }
  if (input.testRunId === null) delete result.testRunId
  else if (input.testRunId !== undefined) {
    if (typeof input.testRunId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.testRunId)) return fail('invalid_request', '测试 fixture 标识无效')
    result.testRunId = input.testRunId
  }
  return result
}
function stringList(value: unknown, label: string, maximum = 256): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > maximum)) return fail('invalid_request', `${label}必须为限定长度的非空字符串数组`)
  return [...new Set(value.map(item => item.trim()))]
}
function operationRules(value: unknown, previous: OperationRule[] = []): OperationRule[] {
  if (!Array.isArray(value)) return fail('invalid_request', '操作授权必须是数组')
  const seen = new Set<string>()
  return value.map(row => {
    const input = object(row), serverId = text(input.serverId, '服务 ID'), operationId = text(input.operationId, '操作 ID')
    const id = JSON.stringify([serverId, operationId]), old = previous.find(item => item.serverId === serverId && item.operationId === operationId)
    if (seen.has(id) || !operationKinds.includes(input.kind as string)
      || Object.keys(input).some(key => !['serverId', 'operationId', 'kind', 'target', 'targetHidden', 'method', 'schemaDigest', 'confirmation', 'queryParameters'].includes(key))) return fail('invalid_request', '操作授权重复或字段无效')
    seen.add(id)
    const target = input.targetHidden === true && !input.target && old ? old.target : editableUrl(input.target)
    const method = text(input.method, '操作方法').toUpperCase()
    if (!businessOperationMethods.includes(method)) return fail('invalid_request', '操作方法无效')
    if (input.confirmation !== undefined && typeof input.confirmation !== 'boolean') return fail('invalid_request', '必要确认必须为布尔值')
    const privateFields = Object.fromEntries(Object.entries(old ?? {}).filter(([key]) => !['serverId', 'operationId', 'kind', 'target', 'method', 'schemaDigest', 'confirmation', 'queryParameters'].includes(key)))
    return { ...privateFields, serverId, operationId, kind: input.kind as OperationRule['kind'], target, method,
      ...(input.schemaDigest !== undefined ? { schemaDigest: text(input.schemaDigest, 'Schema 摘要') } : {}),
      ...(input.confirmation !== undefined ? { confirmation: input.confirmation } : {}),
      ...(input.queryParameters !== undefined ? { queryParameters: stringList(input.queryParameters, '允许的查询键') } : {}) }
  })
}

function agentRules(value: unknown): AgentAccessRule[] {
  if (!Array.isArray(value)) return fail('invalid_request', 'Agent 开放规则必须是数组')
  const seen = new Set<string>()
  return value.map(input => {
    const row = object(input), agentId = text(row.agentId, 'Agent ID')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId) || seen.has(agentId)) return fail('invalid_request', 'Agent ID 无效或重复')
    seen.add(agentId)
    if (Object.keys(row).some(key => !['agentId', 'enabled', 'subjects', 'actions', 'serverIds', 'sourceDigest', 'agentAuthentication', 'agentTrust', 'toolPolicies'].includes(key))
      || typeof row.enabled !== 'boolean' || !Array.isArray(row.subjects) || !Array.isArray(row.actions)) return fail('invalid_request', 'Agent 开放规则无效')
    const subjects = row.subjects.map(value => text(value, '主体 ID'))
    const allowedActions = row.actions.map(value => text(value, '基础动作'))
    if (subjects.includes('*') || allowedActions.some(value => !agentAccessActions.includes(value))) return fail('invalid_request', '主体或基础动作无效')
    if (row.serverIds !== undefined && !Array.isArray(row.serverIds)) return fail('invalid_request', 'MCP 服务范围无效')
    const authentication = row.agentAuthentication === undefined ? undefined : object(row.agentAuthentication)
    const trust = row.agentTrust === undefined ? undefined : object(row.agentTrust)
    if (authentication && (typeof authentication.enabled !== 'boolean' || authentication.method !== 'hmac-sha256'
      || Object.keys(authentication).some(key => !['enabled', 'method'].includes(key)))) return fail('invalid_request', 'Agent 认证只支持当前 HMAC SHA-256 方式及明确开关')
    if (trust && (typeof trust.enabled !== 'boolean' || Object.keys(trust).some(key => key !== 'enabled'))) return fail('invalid_request', '智能体身份只支持明确的启用或撤销状态')
    if (row.toolPolicies !== undefined && !validAgentToolPolicies(row.toolPolicies)) return fail('invalid_request', '工具条件规则无效：请选择服务、允许/禁止/确认处理，并使用明确的风险等级、场景代码或操作标签')
    return { agentId, enabled: row.enabled, subjects: [...new Set(subjects)], actions: [...new Set(allowedActions)],
      ...(row.serverIds !== undefined ? { serverIds: (row.serverIds as unknown[]).map(value => text(value, 'MCP 服务 ID')) } : {}),
      ...(row.sourceDigest !== undefined ? { sourceDigest: text(row.sourceDigest, '来源摘要') } : {}),
      ...(authentication ? { agentAuthentication: { enabled: authentication.enabled as boolean, method: 'hmac-sha256' as const } } : {}),
      ...(trust ? { agentTrust: { enabled: trust.enabled as boolean } } : {}),
      ...(row.toolPolicies !== undefined ? { toolPolicies: structuredClone(row.toolPolicies) as AgentAccessRule['toolPolicies'] } : {}) }
  })
}

export interface BusinessControlConfiguration {
  schemaVersion: 1; enabled: boolean; agents: AgentAccessRule[]
  providers: { authentication: boolean; identityTrust: boolean; riskAssessment: boolean; accessAuthorization: boolean }
  operationCount: number
  authentication: BusinessProviderView; identityTrust: BusinessProviderView; riskAssessment: BusinessProviderView & { requiredKinds: string[] }; accessAuthorization: BusinessProviderView
  detection: { inputMarkers: string[]; operationMarkers: string[]; reportMarkers: string[] }
  operations: Array<OperationRule & { targetHidden?: boolean }>
}
export interface BusinessControlManagementStatus {
  enabled: boolean; restrictionVersion: number; restrictions: Restriction[]; riskFacts: RiskFact[]
  events: ReturnType<ReturnType<typeof getBusinessControl>['status']>['events']
  instances: Array<{ workspaceId: string; agentId: string; instanceId: string; runtimeGeneration: string; sourceDigest: string
    pinnedSourceDigest?: string; identityMode: 'development' | 'published'; synchronization?: { lastSuccessAt?: string; lastAttemptAt: string; lastError?: string }; applied: boolean; acknowledgement?: { restrictionVersion: number; leaseId: string; at: string } }>
  revision: string; configuration: BusinessControlConfiguration
  sessionTrustFacts: SessionTrustFact[]
  agentStatuses: ReturnType<ReturnType<typeof getBusinessControl>['agentStatuses']>
  coverage: { immediate: true; schedules: false; leaseMs: 2000; acknowledgementDeadlineMs: 2000 }
  change?: { kind: string; currentPermission?: 'allow' | 'deny' | 'unknown'; reason?: string; source?: 'manual-fallback'; businessReplayed: false }
}

/** GUI 和管理助手只调用这一份管理入口；Peer 必须来自真实 Connection admission。 */
export function createBusinessControlHandler(assetRoot: string): ConnectionRpcHandler {
  const control = getBusinessControl(assetRoot)
  const path = join(assetRoot, 'config', 'business-access.json')
  function readConfiguration(): { config: BusinessAccessConfig; revision: string } {
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const config = raw ? JSON.parse(raw) as BusinessAccessConfig : { schemaVersion: 1 as const, enabled: false, agents: [] }
    if (config.schemaVersion !== 1 || typeof config.enabled !== 'boolean' || !Array.isArray(config.agents)) return fail('control_config_invalid', '业务访问配置无效')
    return { config, revision: sha256(raw) }
  }
  function view(): BusinessControlManagementStatus {
    const status = control.status(), { config, revision } = readConfiguration()
    const registered = (config.gateway as { instances?: Array<{ agentId?: string; instanceId?: string; sourceDigest?: string; identityMode?: 'development' | 'published' }> } | undefined)?.instances ?? []
    const instances = status.instances.map(value => {
      const row = registered.find(item => item.agentId === value.agentId && item.instanceId === value.instanceId)
      const identityMode = row?.identityMode === 'development' ? 'development' as const : 'published' as const
      return { ...value, identityMode,
        pinnedSourceDigest: row?.sourceDigest ?? (identityMode === 'published' ? config.agents.find(item => item.agentId === value.agentId)?.sourceDigest : undefined) }
    })
    return { ...status, events: status.events.map(event => ({ ...event, ...(event.authorization ? { authorization: { ...event.authorization, ...(event.authorization.provider ? { provider: 'external-provider' } : {}) } } : {}) })), instances, revision,
      sessionTrustFacts: control.sessionTrustFacts(),
      agentStatuses: control.agentStatuses(),
      riskFacts: status.riskFacts.map(fact => ({ ...fact, source: /^https?:\/\//i.test(fact.source) ? 'external-provider' : fact.source })),
      configuration: { schemaVersion: 1, enabled: config.enabled, agents: config.agents.map(rule => ({ agentId: rule.agentId,
        enabled: rule.enabled, subjects: [...rule.subjects], actions: [...rule.actions],
        ...(rule.serverIds ? { serverIds: [...rule.serverIds] } : {}), ...(rule.sourceDigest ? { sourceDigest: rule.sourceDigest } : {}),
        ...(rule.agentAuthentication ? { agentAuthentication: { ...rule.agentAuthentication } } : {}), ...(rule.agentTrust ? { agentTrust: { ...rule.agentTrust } } : {}),
        ...(rule.toolPolicies !== undefined ? { toolPolicies: structuredClone(rule.toolPolicies) } : {}) })),
        providers: { authentication: !!config.authentication, identityTrust: !!config.identityTrust, riskAssessment: !!config.riskAssessment, accessAuthorization: !!config.accessAuthorization },
        operationCount: config.operations?.length ?? 0,
        authentication: providerView(config.authentication), identityTrust: providerView(config.identityTrust),
        riskAssessment: { ...providerView(config.riskAssessment, 'riskAssessment'), requiredKinds: config.riskAssessment?.requiredKinds ?? ['write', 'publish'] },
        accessAuthorization: providerView(config.accessAuthorization),
        detection: { inputMarkers: config.detection?.inputMarkers ?? [], operationMarkers: config.detection?.operationMarkers ?? [], reportMarkers: config.detection?.reportMarkers ?? [] },
        operations: (config.operations ?? []).map(rule => ({ serverId: rule.serverId, operationId: rule.operationId, kind: rule.kind,
          target: publicUrl(rule.target), ...(!publicUrl(rule.target) ? { targetHidden: true } : {}), method: rule.method,
          ...(rule.schemaDigest ? { schemaDigest: rule.schemaDigest } : {}), ...(rule.confirmation !== undefined ? { confirmation: rule.confirmation } : {}),
          ...(rule.queryParameters ? { queryParameters: [...rule.queryParameters] } : {}) })) },
      coverage: { immediate: true, schedules: false, leaseMs: 2000, acknowledgementDeadlineMs: 2000 } }
  }
  function saveConfiguration(request: Record<string, unknown>): void {
    if (Object.keys(request).some(key => !['revision', 'enabled', 'agents', 'authentication', 'identityTrust', 'riskAssessment', 'accessAuthorization', 'operations', 'detection'].includes(key))) return fail('invalid_request', '本入口只编辑统一网关的四项功能配置')
    const revision = text(request.revision, '配置版本')
    if (typeof request.enabled !== 'boolean') return fail('invalid_request', '请明确是否开放即时业务访问')
    const agents = agentRules(request.agents)
    mkdirSync(dirname(path), { recursive: true })
    const lock = `${path}.lock`, temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number
    try { descriptor = openSync(lock, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail('conflict', '业务访问配置正在更新，当前草稿已保留，请读取最新状态后重试')
      throw error
    }
    try {
      const current = readConfiguration()
      if (current.revision !== revision) return fail('conflict', '业务访问配置已在其他位置更新，当前草稿已保留，请读取最新状态后重试')
      control.config()
      const config: BusinessAccessConfig = { ...current.config, enabled: request.enabled, agents }
      for (const key of ['authentication', 'identityTrust', 'riskAssessment', 'accessAuthorization'] as const) if (request[key] !== undefined) {
        const value = providerPatch(request[key], current.config[key])
        if (value) config[key] = value
        else delete config[key]
        const input = request[key] && object(request[key])
        if (input && 'requiredKinds' in input) {
          if (key !== 'riskAssessment' || !Array.isArray(input.requiredKinds) || input.requiredKinds.some(item => !operationKinds.includes(item as string))) return fail('invalid_request', '风险必需评估动作无效')
          config.riskAssessment!.requiredKinds = [...new Set(input.requiredKinds)] as OperationRule['kind'][]
        }
      }
      if (request.operations !== undefined) config.operations = operationRules(request.operations, current.config.operations)
      if (request.detection !== undefined) {
        const detection = object(request.detection)
        if (Object.keys(detection).some(key => !['inputMarkers', 'operationMarkers', 'reportMarkers'].includes(key))) return fail('invalid_request', '检测配置包含未知字段')
        config.detection = { ...current.config.detection }
        for (const key of ['inputMarkers', 'operationMarkers', 'reportMarkers'] as const) if (detection[key] !== undefined) config.detection[key] = stringList(detection[key], '检测标记')
      }
      writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      prepareBusinessRuntimeFile(temporary)
      renameSync(temporary, path)
      control.configurationChanged()
    } finally { closeSync(descriptor); rmSync(lock); rmSync(temporary, { force: true }) }
  }
  function scopeFor(value: unknown): ControlScope {
    const input = object(value)
    if (Object.keys(input).some(key => !scopeKeys.includes(key))) return fail('invalid_scope', '限制范围包含未知字段')
    const scope = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, text(value, '限制范围')])) as unknown as ControlScope
    if (!scope.workspaceId || !scope.agentId || !scope.subjectId || Object.values(scope).includes('*')) return fail('invalid_scope', '限制必须明确工作区、Agent 和主体，不能使用全局或通配范围')
    const instances = view().instances
    if (!instances.some(binding => binding.workspaceId === scope.workspaceId && binding.agentId === scope.agentId
      && (!scope.instanceId || binding.instanceId === scope.instanceId)
      && (!scope.runtimeGeneration || binding.runtimeGeneration === scope.runtimeGeneration))) return fail('invalid_scope', '限制范围与已登记实例不一致')
    if (scope.sessionId) {
      const context = control.contextForSession(scope.sessionId)
      if (!context || !sameScope(scope, context)) return fail('invalid_scope', 'Session 与限制范围不一致')
    }
    const agent = control.config().agents.find(rule => rule.agentId === scope.agentId)
    if (!agent?.subjects.includes(scope.subjectId)) return fail('invalid_scope', '主体未登记到该 Agent 的基础授权中')
    if (scope.serverId && (!control.config().accessAuthorization && agent.serverIds ? !agent.serverIds.includes(scope.serverId)
      : !control.config().operations?.some(rule => rule.serverId === scope.serverId))) return fail('invalid_scope', 'MCP 服务不属于该 Agent 的基础范围')
    return scope
  }
  function actionFor(value: unknown): 'read' | 'write' | 'publish' {
    if (!actions.includes(value as typeof actions[number])) return fail('invalid_request', '运行限制动作只支持 read、write 或 publish')
    return value as typeof actions[number]
  }
  function requireBase(scope: ControlScope, deniedActions: string[]): void {
    const rule = control.config().agents.find(agent => agent.agentId === scope.agentId)
    if (!rule?.enabled || !rule.subjects.includes(scope.subjectId!) || !control.config().accessAuthorization && deniedActions.some(action => !rule.actions.includes('*') && !rule.actions.includes(action))) {
      return fail('action_forbidden', '该主体或动作不在当前 Agent 的基础许可中')
    }
  }
  function sessionFor(request: Record<string, unknown>): BusinessContext {
    const context = control.contextForSession(text(request.sessionId, 'Session ID'))
    if (!context) return fail('invalid_scope', 'Session 尚未绑定业务主体，不能推断归属')
    return context
  }
  async function probeProvider(request: Record<string, unknown>, signal: AbortSignal) {
    const kind = request.kind
    if (kind !== 'authentication' && kind !== 'identityTrust' && kind !== 'riskAssessment' && kind !== 'accessAuthorization') return fail('invalid_request', '请选择提供方种类')
    if (Object.keys(request).some(key => !['kind', 'endpoint', 'timeoutMs'].includes(key))) return fail('invalid_request', '探测参数无效')
    const saved = readConfiguration().config[kind]
    const endpoint = editableUrl(request.endpoint === undefined ? saved?.endpoint : request.endpoint, true)
    const requestedTimeout = request.timeoutMs === undefined ? saved?.timeoutMs ?? 1500 : request.timeoutMs
    if (typeof requestedTimeout !== 'number' || !Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1 || requestedTimeout > 60000) return fail('invalid_request', '提供方超时必须为 1 至 60000 毫秒')
    const effectiveTimeoutMs = Math.min(requestedTimeout, 3000)
    const deadline = AbortSignal.timeout(effectiveTimeoutMs)
    const started = Date.now()
    let network: 'httpResponded' | 'timeout' | 'noResponse' = 'noResponse'
    let httpStatus: number | undefined
    try {
      const response = await fetch(endpoint, { method: 'OPTIONS', redirect: 'manual', signal: AbortSignal.any([signal, deadline]) })
      network = 'httpResponded'
      httpStatus = response.status
      void response.body?.cancel().catch(() => {})
    } catch {
      signal.throwIfAborted()
      network = deadline.aborted ? 'timeout' : 'noResponse'
    }
    return { kind, source: request.endpoint === undefined ? 'saved' : 'draft', checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started, effectiveTimeoutMs, network, ...(httpStatus !== undefined ? { httpStatus } : {}),
      contractChecked: false, businessChecked: false }
  }
  return async (endpoint, payload, signal, peer) => {
    try {
      if (!peer || peer.principal?.kind !== 'owner') return fail('forbidden', '运行权限管理仅供平台 owner 使用')
      signal.throwIfAborted()
      if (endpoint === 'status') return { ok: true, value: view() }
      const request = object(payload)
      if (endpoint === 'providerProtocol') {
        if (request.kind !== 'risk-assessment' && request.kind !== 'access-control') return fail('invalid_request', '请选择风险评估或访问控制接口规范')
        return { ok: true, value: readProviderProtocol(request.kind) }
      }
      if (endpoint === 'probeProvider') return { ok: true, value: await probeProvider(request, signal) }
      if (endpoint === 'saveConfiguration') { saveConfiguration(request); return { ok: true, value: view() } }
      if (endpoint === 'restrict') {
        const scope = scopeFor(request.scope)
        if (!Array.isArray(request.deniedActions) || !request.deniedActions.length) return fail('invalid_request', '请选择需要收紧的动作')
        const deniedActions = [...new Set(request.deniedActions.map(actionFor))]
        requireBase(scope, deniedActions)
        control.updateRestriction({ scope, deniedActions, reason: text(request.reason, '收紧依据'), active: true })
        return { ok: true, value: { ...view(), change: { kind: 'restricted', businessReplayed: false } } }
      }
      if (endpoint === 'reassess' || endpoint === 'release') {
        const context = sessionFor(request), action = actionFor(request.action ?? 'write')
        if (request.scope && !sameScope(scopeFor(request.scope), context)) return fail('invalid_scope', '评估 Session 与所选范围不一致')
        let restriction: Restriction | undefined
        if (endpoint === 'release') {
          restriction = control.status().restrictions.find(item => item.id === text(request.restrictionId, '限制 ID'))
          if (!restriction?.active || !sameScope(restriction.scope, context)) return fail('invalid_scope', '限制与指定 Session 不匹配或已解除')
          if (!restriction.deniedActions.includes(action)) return fail('invalid_request', '恢复评估动作必须属于所选限制')
        }
        const permissionContext = restriction?.scope.serverId ? { ...context, scope: { ...context.scope, serverId: restriction.scope.serverId } } : context
        let automaticAssessment = true, manualFallback = false
        if (restriction && !control.config().riskAssessment) {
          await control.revalidateIdentity(permissionContext, signal)
          signal.throwIfAborted()
          automaticAssessment = !!control.config().riskAssessment
        }
        if (!automaticAssessment && restriction) {
          scopeFor(restriction.scope)
          for (const deniedAction of restriction.deniedActions) control.assertBase(permissionContext, control.config().accessAuthorization ? 'agent:access' : deniedAction)
        }
        for (const assessedAction of automaticAssessment ? restriction?.deniedActions ?? [action] : []) {
          let fact: RiskFact
          try { fact = await control.reassess(context, signal, assessedAction) }
          catch (cause) {
            if (!restriction || !(cause instanceof BusinessControlError) || cause.code !== 'risk_provider_unavailable') throw cause
            await control.revalidateIdentity(permissionContext, signal); signal.throwIfAborted()
            scopeFor(restriction.scope)
            for (const deniedAction of restriction.deniedActions) control.assertBase(permissionContext, control.config().accessAuthorization ? 'agent:access' : deniedAction)
            manualFallback = true
            break
          }
          signal.throwIfAborted()
          if (restriction && (fact.status !== 'assessed' || Date.parse(fact.expiresAt) <= Date.now() || fact.signals.some(signal =>
            (signal.code === 'deny-all' && signal.value === 'true') || (signal.code === 'deny-operation' &&
              (signal.value === '*' || restriction!.deniedActions.includes(signal.value))) || restriction!.deniedActions.some(action => signal.code === `deny-${action}` && signal.value === 'true')))) {
            return fail('risk_restricted', '当前风险评估仍限制所选动作，已保留原限制')
          }
        }
        if (restriction) {
          const current = control.status().restrictions.find(item => item.id === restriction!.id)
          if (!current || JSON.stringify(current) !== JSON.stringify(restriction)) return fail('conflict', '限制已在评估期间变化，请重新读取；没有解除或重放业务')
          requireBase(restriction.scope, restriction.deniedActions)
          control.updateRestriction({ ...restriction, active: false })
        }
        let currentPermission: 'allow' | 'deny' | 'unknown' = control.config().accessAuthorization ? 'unknown' : 'allow', reason: string | undefined = control.config().accessAuthorization ? 'external_authorization_required' : undefined
        try {
          if (control.config().accessAuthorization) {
            control.assertBase(permissionContext, 'agent:access')
            if (control.status().restrictions.some(item => item.active && sameScope(item.scope, permissionContext)
              && (!item.scope.serverId || item.scope.serverId === permissionContext.scope.serverId)
              && (item.deniedActions.includes('*') || item.deniedActions.includes(action)))) { currentPermission = 'deny'; reason = 'risk_restricted' }
          } else control.assert(permissionContext, action)
        }
        catch (error) { currentPermission = 'deny'; reason = error instanceof BusinessControlError ? error.code : 'control_unavailable' }
        return { ok: true, value: { ...view(), change: { kind: restriction ? 'released' : 'reassessed', currentPermission, reason, ...(manualFallback ? { source: 'manual-fallback' as const } : {}), businessReplayed: false } } }
      }
      return fail('not_found', '未知运行权限管理操作')
    } catch (error) {
      return { ok: false, error: { code: error instanceof BusinessControlError ? error.code : 'control_management_failed',
        message: error instanceof BusinessControlError ? error.message : '运行权限管理操作失败，请刷新状态后重试', details: {} } }
    }
  }
}
