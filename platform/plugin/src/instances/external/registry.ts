import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { workspaceConfigPath, workspaceIdentity, workspaceLocalPath } from '../../workspace.ts'
import type { ExternalAgent, ExternalDetail, ExternalInstance, ExternalList, ExternalPolicy, ExternalRecord, ExternalVerification } from './types.ts'

interface Registry { schemaVersion: 1; agents: ExternalAgent[]; instances: ExternalInstance[]; requests: Array<{ id: string; digest: string; instanceId: string }> }
export class ExternalAccessError extends Error { constructor(public code: string, message: string, public status = 400) { super(message) } }
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function externalBindingDigest(root: string, value: Pick<ExternalInstance, 'framework' | 'endpoint' | 'selector' | 'credentialRef' | 'connectionUserId'>, material?: Record<string, string>): string {
  let credentialDigest = ''
  if (value.credentialRef) {
    try { credentialDigest = digest(material ?? upstreamHeaders(root, value as ExternalInstance)) }
    catch { credentialDigest = 'unavailable' }
  }
  return digest({ framework: value.framework, endpoint: value.endpoint, selector: value.selector ?? '', credentialRef: value.credentialRef ?? '', credentialDigest,
    ...(value.connectionUserId ? { connectionUserId: value.connectionUserId } : {}) })
}
export const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExternalAccessError('invalid_request', '请求参数必须是对象')
  return value as Record<string, any>
}
export function text(value: unknown, label: string, optional = false): string {
  if (optional && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ExternalAccessError('invalid_request', `${label}无效`)
  return value.trim()
}
export function identifier(value: unknown, label = '标识'): string {
  const id = text(value, label)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 160) throw new ExternalAccessError('invalid_request', `${label}必须为小写 kebab-case`)
  return id
}
export function externalEndpoint(value: unknown): string {
  let url: URL
  try { url = new URL(text(value, '服务地址')) } catch { throw new ExternalAccessError('invalid_target', '请填写完整的 HTTP(S) 服务地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ExternalAccessError('invalid_target', '服务地址不能包含凭据、查询参数或片段')
  return url.href.replace(/\/$/, '')
}
function read(root: string): { registry: Registry; revision: string } {
  const path = workspaceConfigPath(root, 'external-instances.json'), raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const registry = raw ? JSON.parse(raw) : { schemaVersion: 1, agents: [], instances: [], requests: [] }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.agents) || !Array.isArray(registry.instances) || !Array.isArray(registry.requests)) throw new ExternalAccessError('invalid_schema', '接入登记格式版本不受支持', 503)
  // 手工编辑同一事实源也必须使旧验证失效，不能只依赖 GUI 维护摘要。
  for (const instance of registry.instances) instance.bindingDigest = externalBindingDigest(root, instance)
  return { registry, revision: createHash('sha256').update(raw).digest('hex') }
}
export function readExternalBusinessConfig(root: string): Record<string, any> {
  const path = workspaceConfigPath(root, 'business-access.json')
  const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { schemaVersion: 1, enabled: false, agents: [] }
  if (value.schemaVersion !== 1 || !Array.isArray(value.agents) || (value.externalInstances !== undefined && !Array.isArray(value.externalInstances))) throw new ExternalAccessError('invalid_schema', '业务访问配置无效', 503)
  return value
}
export function externalPolicy(root: string, id: string): ExternalPolicy {
  return readExternalBusinessConfig(root).externalInstances?.find((value: ExternalPolicy) => value.instanceId === id)
    ?? { instanceId: id, subjects: [], actions: [], enabled: false }
}
export function isExternalEnabled(root: string, instance: ExternalInstance): boolean {
  if (readExternalBusinessConfig(root).enabled !== true) return false
  const policy = externalPolicy(root, instance.id)
  return instance.state === 'registered' && instance.entryState === 'enabled' && policy.enabled
    && instance.verification?.ok === true && instance.verification.bindingDigest === instance.bindingDigest
    && instance.activation?.bindingDigest === instance.bindingDigest && instance.activation.policyDigest === digest(policy)
}
export function getExternalInstance(root: string, id: string): ExternalInstance | undefined { return read(root).registry.instances.find(value => value.id === id) }
export function externalInstances(root: string): ExternalList {
  const { registry, revision } = read(root)
  return { revision, workspaceId: workspaceIdentity(root).id, agents: registry.agents, instances: registry.instances.filter(value => value.state !== 'removed').map(value => ({ ...value,
    entryState: readExternalBusinessConfig(root).enabled !== true ? 'disabled' : value.entryState === 'enabled' && !isExternalEnabled(root, value) ? 'pending' : value.entryState })), observedAt: new Date().toISOString() }
}
export function readExternalRecords(root: string, id: string, limit = 100): ExternalRecord[] {
  const directory = workspaceLocalPath(root, 'external-instances', 'records')
  if (!existsSync(directory)) return []
  const rows: ExternalRecord[] = []
  for (const file of readdirSync(directory).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().reverse().slice(0, 30)) {
    for (const line of readFileSync(join(directory, file), 'utf8').split('\n').reverse()) if (line) {
      try { const value = JSON.parse(line); if (value.instanceId === id) rows.push(value) } catch { /* 中断写入的尾记录保留原件，不伪造完成。 */ }
      if (rows.length >= limit) return rows
    }
  }
  return rows
}
export function appendExternalRecord(root: string, input: Omit<ExternalRecord, 'id' | 'at'>): ExternalRecord {
  const record: ExternalRecord = { ...input, id: randomUUID(), at: new Date().toISOString() }
  // 记录只接受合同中的阶段与标识，不接收消息、Header、原始错误或上游正文。
  const directory = workspaceLocalPath(root, 'external-instances', 'records'); mkdirSync(directory, { recursive: true, mode: 0o700 })
  appendFileSync(join(directory, record.at.slice(0, 10) + '.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  for (const file of readdirSync(directory)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) rmSync(join(directory, file))
  return record
}
export function externalDetail(root: string, id: string): ExternalDetail {
  const { registry, revision } = read(root), instance = registry.instances.find(value => value.id === id && value.state !== 'removed')
  if (!instance) throw new ExternalAccessError('not_found', '接入实例不存在或已移除', 404)
  const agent = registry.agents.find(value => value.id === instance.agentId)
  if (!agent) throw new ExternalAccessError('invalid_registration', '实例缺少智能体登记', 503)
  return { revision, agent, instance: { ...instance, entryState: readExternalBusinessConfig(root).enabled !== true ? 'disabled' : instance.entryState === 'enabled' && !isExternalEnabled(root, instance) ? 'pending' : instance.entryState }, policy: externalPolicy(root, id), records: readExternalRecords(root, id) }
}
function atomic(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}
function withLock<T>(path: string, callback: () => T): T {
  mkdirSync(dirname(path), { recursive: true }); let fd: number
  try { fd = openSync(path + '.lock', 'wx', 0o600) } catch { throw new ExternalAccessError('conflict', '配置正在更新，请读取最新状态后重试', 409) }
  try { return callback() } finally { closeSync(fd); rmSync(path + '.lock', { force: true }) }
}
function validPolicy(value: unknown, id: string): ExternalPolicy {
  const input = object(value)
  if (!Array.isArray(input.subjects) || input.subjects.length > 100 || !Array.isArray(input.actions) || input.actions.length > 20 || typeof input.enabled !== 'boolean') throw new ExternalAccessError('invalid_policy', '请明确访问主体、操作与授权状态')
  const subjects = [...new Set<string>(input.subjects.map((value: unknown) => text(value, '访问主体')))]
  const actions = [...new Set<string>(input.actions.map((value: unknown) => text(value, '操作')))]
  if (actions.some(value => !['agent:access', 'session:create', 'session:prompt', 'session:read', 'session:events', 'web:access'].includes(value))) throw new ExternalAccessError('invalid_policy', '包含未开放的接入操作')
  return { instanceId: id, subjects, actions, enabled: input.enabled }
}
/** 登记和策略同一应用操作协调；只有最后提交的匹配激活引用才形成入口。 */
export function mutateExternal(root: string, operation: 'save' | 'verify' | 'enable' | 'disable' | 'remove', payload: Record<string, any>, verification?: ExternalVerification): ExternalDetail {
  const path = workspaceConfigPath(root, 'external-instances.json'), requestId = text(payload.requestId, '请求标识'), requestDigest = digest([operation, payload])
  let selected = ''
  withLock(path, () => {
    const { registry, revision } = read(root), previous = registry.requests.find(value => value.id === requestId)
    if (previous) { if (previous.digest !== requestDigest) throw new ExternalAccessError('conflict', '请求标识已用于不同操作', 409); selected = previous.instanceId; return }
    if (payload.revision !== revision) throw new ExternalAccessError('conflict', '登记已在其他位置更新，草稿已保留，请刷新后重试', 409)
    let instance: ExternalInstance | undefined
    if (operation === 'save') {
      const agentInput = object(payload.agent ?? {}), submitted = object(payload.instance)
      const instanceId = submitted.id ? identifier(submitted.id, '实例标识') : 'external-' + randomUUID(), existing = registry.instances.find(value => value.id === instanceId)
      const input: Record<string, any> = { ...submitted, framework: submitted.framework === undefined ? existing?.framework : submitted.framework }
      const agentId = input.agentId ? identifier(input.agentId, '智能体标识') : existing?.agentId ?? (agentInput.id ? identifier(agentInput.id, '智能体标识') : 'external-agent-' + randomUUID())
      if (existing?.state === 'removed' || existing && existing.agentId !== agentId) throw new ExternalAccessError('conflict', '不能恢复已移除实例或变更其智能体身份', 409)
      if (!['dsh', 'agentscope', 'opencode'].includes(input.framework) || input.managementMode !== undefined && input.managementMode !== 'externally-managed' || input.usageMode !== undefined && input.usageMode !== 'shared') throw new ExternalAccessError('invalid_request', '请明确框架、外部生命周期责任及共享使用方式')
      const endpointInput = input.endpoint === undefined ? existing?.endpoint : input.endpoint
      const endpoint = endpointInput ? externalEndpoint(endpointInput) : '', credentialRef = text(input.credentialRef === undefined ? existing?.credentialRef : input.credentialRef, '凭据引用', true)
      if (credentialRef) identifier(credentialRef, '凭据引用')
      let agent = registry.agents.find(value => value.id === agentId)
      if (!agent) {
        const frameworkName = ({ dsh: 'DSH', agentscope: 'AgentScope', opencode: 'OpenCode' } as Record<string, string>)[input.framework]
        agent = { id: agentId, name: text(agentInput.name || `${frameworkName} 接入`, '智能体名称'), system: text(agentInput.system || (endpoint ? new URL(endpoint).hostname : '未填写'), '所属系统'), owner: text(agentInput.owner || '平台管理者', '责任主体'), ...(agentInput.description ? { description: text(agentInput.description, '说明') } : {}) }
        registry.agents.push(agent)
      } else if (['name', 'system', 'owner'].some(key => agentInput[key] !== undefined && agentInput[key] !== agent![key as 'name' | 'system' | 'owner'])) throw new ExternalAccessError('conflict', '关联已有智能体时不能静默修改公共名称、所属系统或责任主体', 409)
      const selector = text(input.selector === undefined ? existing?.framework === input.framework ? existing?.selector : undefined : input.selector, '目标选择器', true), connectionUserId = input.framework === 'agentscope' ? connectionUser(input.connectionUserId === undefined ? existing?.connectionUserId : input.connectionUserId) : ''
      const bindingDigest = externalBindingDigest(root, { framework: input.framework, endpoint, selector, credentialRef, connectionUserId })
      const declaredVersion = text(input.declaredVersion === undefined ? existing?.declaredVersion : input.declaredVersion, '声明版本', true)
      const description = text(input.description === undefined ? existing?.description : input.description, '说明', true)
      const now = new Date().toISOString()
      instance = { id: instanceId, agentId, name: text(input.name || existing?.name || agent.name, '实例名称'), framework: input.framework, endpoint, ...(selector ? { selector } : {}), ...(credentialRef ? { credentialRef } : {}), ...(connectionUserId ? { connectionUserId } : {}),
        ...(declaredVersion ? { declaredVersion } : {}), ...(description ? { description } : {}),
        location: text(input.location === undefined ? existing?.location : input.location, '运行位置', true), instanceOwner: text(input.instanceOwner === undefined ? existing?.instanceOwner ?? agent.owner : input.instanceOwner, '实例责任主体', true),
        managementMode: 'externally-managed', usageMode: 'shared', state: endpoint ? 'registered' : 'draft', revision: (existing?.revision ?? 0) + 1, bindingDigest, entryState: existing?.bindingDigest === bindingDigest ? existing.entryState : 'pending',
        ...(existing?.bindingDigest === bindingDigest && existing.verification ? { verification: existing.verification } : {}), createdAt: existing?.createdAt ?? now, updatedAt: now }
      const policy = validPolicy(payload.policy ?? (existing ? externalPolicy(root, instanceId) : { subjects: ['platform-owner'], actions: ['agent:access', 'session:create', 'session:prompt', 'session:read', 'session:events'], enabled: true }), instanceId), businessPath = workspaceConfigPath(root, 'business-access.json')
      withLock(businessPath, () => { const config = readExternalBusinessConfig(root); config.externalInstances = [...(config.externalInstances ?? []).filter((value: ExternalPolicy) => value.instanceId !== instanceId), policy]; atomic(businessPath, config) })
      if (existing?.bindingDigest === bindingDigest && existing.activation?.policyDigest === digest(policy)) instance.activation = existing.activation
      else instance.entryState = 'pending'
      if (existing) registry.instances[registry.instances.indexOf(existing)] = instance
      else registry.instances.push(instance)
    } else {
      instance = registry.instances.find(value => value.id === payload.id && value.state !== 'removed')
      if (!instance) throw new ExternalAccessError('not_found', '接入实例不存在或已移除', 404)
      if (operation === 'verify') {
        if (!verification || verification.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('conflict', '验证目标已变化，请重新验证', 409)
        instance.verification = verification; instance.entryState = 'pending'; delete instance.activation
      } else if (operation === 'enable') {
        if (readExternalBusinessConfig(root).enabled !== true) throw new ExternalAccessError('entry_disabled', '业务入口总开关已关闭，请在访问控制中开启后再启用', 409)
        const policy = externalPolicy(root, instance.id)
        if (!policy.enabled || !policy.subjects.length || !policy.actions.includes('agent:access') || !instance.verification?.ok || instance.verification.bindingDigest !== instance.bindingDigest) throw new ExternalAccessError('not_verified', '登记、目标验证或访问授权尚不满足启用条件', 409)
        instance.activation = { bindingDigest: instance.bindingDigest, policyDigest: digest(policy), activatedAt: new Date().toISOString() }; instance.entryState = 'enabled'
      } else { instance.entryState = 'disabled'; delete instance.activation; if (operation === 'remove') instance.state = 'removed' }
      instance.revision++; instance.updatedAt = new Date().toISOString()
    }
    selected = instance.id
    // 必需记录失败时不提交新的登记或启用；已收缩策略仍保持 fail-closed。
    appendExternalRecord(root, { instanceId: instance.id, requestId, operation, stage: 'management', result: 'allow', bindingDigest: instance.bindingDigest })
    registry.requests.push({ id: requestId, digest: requestDigest, instanceId: instance.id }); registry.requests = registry.requests.slice(-200)
    atomic(path, registry)
  })
  const found = getExternalInstance(root, selected)!
  if (found.state === 'removed') { const list = externalInstances(root); return { revision: list.revision, agent: list.agents.find(value => value.id === found.agentId)!, instance: found, policy: externalPolicy(root, selected), records: readExternalRecords(root, selected) } }
  return externalDetail(root, selected)
}
export function upstreamHeaders(root: string, instance: ExternalInstance): Record<string, string> {
  if (!instance.credentialRef) return {}
  const path = join(resolve(root), '.local', 'credentials', 'external', identifier(instance.credentialRef) + '.json')
  const value = object(JSON.parse(readFileSync(path, 'utf8'))), headers = object(value.headers)
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!/^(authorization|x-api-key|cookie)$/i.test(name) && !(instance.framework === 'agentscope' && /^x-user-id$/i.test(name)) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new ExternalAccessError('invalid_credential', '上游专用凭据格式无效', 503)
    if (Object.keys(result).some(key => key.toLowerCase() === name.toLowerCase())) throw new ExternalAccessError('invalid_credential', '上游专用凭据包含重复请求头', 503)
    result[name] = value
  }
  return result
}
function connectionUser(value: unknown): string {
  const result = text(value, '原系统用户标识', true)
  if (result && (/[\x00-\x20\x7f-\x9f]/.test(result) || /[^\x00-\xff]/.test(result))) throw new ExternalAccessError('invalid_request', '原系统用户标识不能包含空白、控制字符或无法发送的请求头字符')
  return result
}
/** 原生用户上下文不是认证；显式值与专用凭据头必须一致，旧登记保留原派生上下文。 */
export function externalConnectionUserId(root: string, value: Pick<ExternalInstance, 'framework' | 'credentialRef' | 'connectionUserId'> & { id?: string }, material?: Record<string, string>): string {
  const headers = material ?? upstreamHeaders(root, value as ExternalInstance), explicit = connectionUser(value.connectionUserId)
  const supplied = connectionUser(Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-user-id')?.[1])
  if (explicit && supplied && explicit !== supplied) throw new ExternalAccessError('connection_identity_conflict', '原系统用户标识与所选连接凭据中的 X-User-ID 不一致，请核对后重试')
  const selected = explicit || supplied || (value.id ? `harness-${value.id}` : '')
  if (!selected) throw new ExternalAccessError('connection_identity_required', '原服务需要原系统用户上下文，请填写原系统账号或向管理员索取；这不替代认证凭据')
  return selected
}
export function externalCredentialRefs(root: string): string[] {
  const directory = join(resolve(root), '.local', 'credentials', 'external')
  return existsSync(directory) ? readdirSync(directory).filter(name => /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(name)).map(name => name.slice(0, -5)).sort() : []
}
