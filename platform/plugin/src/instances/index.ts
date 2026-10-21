import { instanceStateRoot, programRoot, workspaceConfigPath, workspaceOwnsInstance } from '../workspace.ts'
import { businessGatewayEntry } from '../business-control/entry.ts'
import { execFile as execFileCallback } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

const execFile = promisify(execFileCallback)
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SECRET_RE = /(Bearer\s+)[^\s,)"']+|(token=)[^\s&)"']+|("(?:api[_-]?key|token|password|secret)"\s*:\s*")[^"]+(")|((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,)"']+/gi
const LOG_LIMIT = 20000
const MODEL_PREVIEW_KEY = randomBytes(32)

export type InstanceOperation = 'create' | 'start' | 'stop' | 'restart' | 'delete'

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface InstanceActionRequest {
  operation: InstanceOperation
  name: string
  source?: string
  expected_source_id?: string
  expected_source_digest?: string
  expected_state?: string
  mode?: 'eval'
  business_control?: boolean
  access_mode?: 'authenticated' | 'anonymous'
  identity_mode?: 'development' | 'published'
  port?: number
  allow_missing_env?: boolean
  model_selection?: ModelSelection
  expected_model_policy_hash?: string
}

export interface BatchActionRequest {
  operation: InstanceOperation
  items: InstanceActionRequest[]
}

export interface InstanceActionReceipt {
  name: string
  operation: InstanceOperation | string
  ok: boolean
  value?: unknown
  error?: { code: string, message: string, details?: unknown }
  requested_source_id?: string
}

interface RegisteredSource {
  source_id: string
  experiment_id: string
  agent_id: string
  selectable: boolean
  reason: string
}

type InstanceRecord = Record<string, unknown> & {
  name?: unknown
  state?: unknown
  source_id?: unknown
  home_volume?: unknown
  home_preserved?: unknown
}

type ModelPolicyProvider = (agentId: string, selected?: ModelSelection) => Promise<{ policy: unknown; environment: Record<string, string> }>

function ok<T>(value: T): ConnectionRpcResult<T> {
  return { ok: true, value }
}

function failure(code: string, message: string, details: Record<string, unknown> = {}): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

function payloadObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('请求参数必须是对象')
  return payload as Record<string, unknown>
}

function assertName(name: unknown): string {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('实例名必须是小写 kebab-case')
  return name
}

function assertSource(source: unknown): string {
  if (typeof source !== 'string' || !source.trim()) throw new Error('来源必须是非空字符串')
  return source
}

function optionalPort(port: unknown): number | undefined {
  if (port === undefined) return undefined
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口必须是 1..65535 的有限整数')
  }
  return port
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是 boolean`)
  return value
}

function businessAccessPath(assetRoot: string): string { return workspaceConfigPath(assetRoot, 'business-access.json') }

async function businessAccess(assetRoot: string, requireEnabled = true): Promise<Record<string, unknown> & { gateway: Record<string, unknown> }> {
  const access = JSON.parse(await readFile(businessAccessPath(assetRoot), 'utf8')) as Record<string, unknown>
  const gateway = access.gateway
  if (access.schemaVersion !== 1 || (requireEnabled && access.enabled !== true) || !gateway || typeof gateway !== 'object'
    || Array.isArray(gateway) || !Array.isArray((gateway as Record<string, unknown>).instances)) {
    throw new Error(requireEnabled ? '业务网关尚未配置，无法创建受控实例' : '业务网关登记配置无效，拒绝删除受控实例')
  }
  return access as Record<string, unknown> & { gateway: Record<string, unknown> }
}

function assertMatchingRegistration(instances: Record<string, unknown>[], input: { agentId: string; instanceId: string; sourceId: string; sourceDigest: string; accessMode?: 'authenticated' | 'anonymous'; identityMode?: 'development' | 'published' }): void {
  const existing = instances.find(row => row.instanceId === input.instanceId)
  if (existing && (existing.agentId !== input.agentId || existing.sourceId && existing.sourceId !== input.sourceId
    || existing.sourceDigest && existing.sourceDigest !== input.sourceDigest
    || input.accessMode && (existing.accessMode ?? 'authenticated') !== input.accessMode
    || input.identityMode && (existing.identityMode ?? 'published') !== input.identityMode)) throw new Error('业务网关中同名实例的来源、访问方式或实例阶段不一致，拒绝覆盖')
}

async function preflightGatewayRegistration(assetRoot: string, input: { agentId: string; instanceId: string; sourceId: string; sourceDigest: string; accessMode?: 'authenticated' | 'anonymous'; identityMode?: 'development' | 'published' }, remove = false): Promise<void> {
  const access = await businessAccess(assetRoot, !remove)
  assertMatchingRegistration(access.gateway.instances as Record<string, unknown>[], input)
}

async function updateGatewayRegistration(assetRoot: string, input: { agentId: string; instanceId: string; sourceId: string; sourceDigest: string; accessMode?: 'authenticated' | 'anonymous'; identityMode?: 'development' | 'published' }, remove = false): Promise<void> {
  const path = businessAccessPath(assetRoot), lock = `${path}.lock`, temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(lock, 'wx', 0o600) }
  catch { throw new Error('业务网关配置正在更新，请刷新后重试；实例登记状态待核对') }
  try {
    const access = await businessAccess(assetRoot, !remove)
    const instances = access.gateway.instances as Record<string, unknown>[]
    assertMatchingRegistration(instances, input)
    const existing = instances.find(row => row.instanceId === input.instanceId)
    const next = remove ? instances.filter(row => row.instanceId !== input.instanceId)
      : [...instances.filter(row => row.instanceId !== input.instanceId), { ...input,
        ...(input.accessMode ? {} : existing?.accessMode ? { accessMode: existing.accessMode } : {}),
        ...(input.identityMode ? {} : existing?.identityMode ? { identityMode: existing.identityMode } : {}) }]
    if (JSON.stringify(instances) === JSON.stringify(next)) return
    access.gateway.instances = next
    await writeFile(temporary, JSON.stringify(access, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally { await handle.close(); await rm(lock, { force: true }); await rm(temporary, { force: true }) }
}

function modelSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型选择必须包含提供方和模型')
  const selected = value as Record<string, unknown>
  if (typeof selected.provider !== 'string' || !selected.provider.trim()
    || typeof selected.model !== 'string' || !selected.model.trim()) throw new Error('模型选择必须包含提供方和模型')
  if (selected.reasoningEffort !== undefined && (typeof selected.reasoningEffort !== 'string' || !selected.reasoningEffort.trim())) {
    throw new Error('模型推理强度必须是非空字符串')
  }
  if (Object.keys(selected).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('模型选择包含未知字段')
  return {
    provider: selected.provider,
    model: selected.model,
    ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort as string }),
  }
}

function sameModel(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

function registeredModelSnapshot(manifest: Record<string, unknown> | undefined) {
  if (!manifest) return null
  const policy = manifest.model_policy && typeof manifest.model_policy === 'object' && !Array.isArray(manifest.model_policy)
    ? manifest.model_policy as Record<string, unknown> : {}
  return { default: policy.default ?? null, sha256: policy.sha256 ?? null }
}

function policyHash(policy: unknown, registered: ReturnType<typeof registeredModelSnapshot>, environment: Record<string, string>): string {
  const orderedEnvironment = Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)))
  return createHmac('sha256', MODEL_PREVIEW_KEY)
    .update(JSON.stringify({ policy, registered, environment: orderedEnvironment })).digest('hex')
}

function dshDev(): string {
  return join(programRoot(), 'runtime/adapters/dsh-container/dsh-dev')
}

function redact(text: string): string {
  return text.replace(SECRET_RE, (_match, bearerPrefix, tokenPrefix, jsonPrefix, jsonSuffix, secretPrefix) =>
    `${bearerPrefix || tokenPrefix || jsonPrefix || secretPrefix}<redacted>${jsonSuffix || ''}`)
}

function bounded(text: string, limit = LOG_LIMIT): string {
  const clean = redact(text)
  return clean.length <= limit ? clean : clean.slice(-limit)
}

export function parseJsonObjects(text: string): unknown[] {
  const values: unknown[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escape = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (start === -1) {
      if (char === '{' || char === '[') {
        start = index
        depth = 1
      }
      continue
    }
    if (escape) {
      escape = false
      continue
    }
    if (char === '\\') {
      escape = inString
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1
    if (depth === 0) {
      values.push(JSON.parse(text.slice(start, index + 1)))
      start = -1
    }
  }
  return values
}

async function runDsh(assetRoot: string, args: string[], signal?: AbortSignal, modelEnvironment: Record<string, string> = {}) {
  try {
    return await execFile(process.env.HARNESS_PYTHON || 'python3', [dshDev(), ...args], {
      cwd: assetRoot,
      env: { ...process.env, ...modelEnvironment, HARNESS_ASSET_ROOT: resolve(assetRoot), HARNESS_PROGRAM_ROOT: programRoot() },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      signal,
    })
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string, stderr?: string }
    const removeValues = (text: string) => Object.values(modelEnvironment).filter(value => value.length >= 4)
      .reduce((value, secret) => value.replaceAll(secret, '<redacted>'), text)
    throw Object.assign(new Error(bounded(removeValues(failed.stderr || failed.stdout || failed.message))), {
      code: failed.code,
      stdout: bounded(removeValues(failed.stdout || '')),
      stderr: bounded(removeValues(failed.stderr || '')),
    })
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function ensureRealSource(assetRoot: string, source: string): Promise<string> {
  const catalog = await readJson(workspaceConfigPath(assetRoot, 'sources.json'))
  const sources = catalog?.sources
  const id = source.startsWith('experiment:') ? source.slice('experiment:'.length) : source
  if (!sources || typeof sources !== 'object' || !(id in sources)) throw new Error(`未找到真实来源：${source}`)
  const agentId = (sources as Record<string, unknown>)[id]
  const selected = agentId && typeof agentId === 'object' ? (agentId as Record<string, unknown>).agent_id : undefined
  if (typeof selected !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selected)) throw new Error('来源缺少有效的业务智能体 ID')
  return selected
}

async function runUpWithModelPolicy(assetRoot: string, args: string[], agentId: string, provider: ModelPolicyProvider | undefined,
  selected?: ModelSelection, expectedHash?: string, registered?: ReturnType<typeof registeredModelSnapshot>, signal?: AbortSignal) {
  if (!provider) {
    if (selected || expectedHash) throw new Error('当前实例入口无法核对模型选择，请刷新页面后重试')
    return { result: await runDsh(assetRoot, args, signal) }
  }
  const projected = await provider(agentId, selected)
  const policy = projected.policy && typeof projected.policy === 'object' && !Array.isArray(projected.policy)
    ? projected.policy as Record<string, unknown> : {}
  const effective = modelSelection(policy.default)
  if (selected && !sameModel(selected, effective)) throw new Error('实例模型选择与实际投影不一致，请重新预览')
  const hash = policyHash(projected.policy, registered ?? null, projected.environment)
  if (expectedHash && hash !== expectedHash) throw new Error('模型设置或实例默认模型已变化，请重新预览；本次未执行。')
  const directory = await mkdtemp(join(tmpdir(), 'hep-model-policy-'))
  const file = join(directory, 'policy.json')
  try {
    await writeFile(file, JSON.stringify(projected.policy), { mode: 0o600, flag: 'wx' })
    return {
      result: await runDsh(assetRoot, [...args, '--model-policy', file], signal, projected.environment),
      model_selection: effective,
      model_policy_hash: hash,
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function listSources(assetRoot: string): Promise<{ sources: RegisteredSource[]; business_gateway_available: boolean }> {
  const file = workspaceConfigPath(assetRoot, 'sources.json')
  let catalog: Record<string, unknown>
  try {
    catalog = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    throw new Error('无法读取当前工作区的来源登记，请检查 config/sources.json')
  }
  if (!catalog || typeof catalog.sources !== 'object' || !catalog.sources || Array.isArray(catalog.sources)) {
    throw new Error('当前工作区的 sources.json 缺少有效 sources 登记')
  }
  const sources = await Promise.all(Object.entries(catalog.sources).map(async ([experimentId, raw]): Promise<RegisteredSource> => {
    const entry = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const agentId = typeof entry.agent_id === 'string' ? entry.agent_id : ''
    const candidateRoot = typeof entry.candidate_root === 'string' ? entry.candidate_root : ''
    const candidatePath = candidateRoot ? resolve(assetRoot, candidateRoot) : ''
    const insideWorkspace = candidatePath && !relative(resolve(assetRoot), candidatePath).startsWith('..')
    const candidatePresent = insideWorkspace && await stat(candidatePath).then(value => value.isDirectory(), () => false)
    const selectable = Boolean(agentId && candidatePresent)
    return {
      source_id: `experiment:${experimentId}`,
      experiment_id: experimentId,
      agent_id: agentId,
      selectable,
      reason: selectable ? '已登记，Candidate 目录可读取；预览时仍需核对 Runtime 与环境' : !agentId ? '来源登记缺少智能体 ID' : 'Candidate 目录不可读取',
    }
  }))
  const businessGatewayAvailable = await businessAccess(assetRoot).then(() => true, () => false)
  return { sources: sources.sort((a, b) => a.agent_id.localeCompare(b.agent_id) || b.experiment_id.localeCompare(a.experiment_id, 'en', { numeric: true })),
    business_gateway_available: businessGatewayAvailable }
}

async function manifestFor(assetRoot: string, name: string): Promise<Record<string, unknown> | null> {
  const manifest = await readJson(join(instanceStateRoot(assetRoot), name, 'instance.json'))
  if (manifest && !workspaceOwnsInstance(assetRoot, manifest)) throw new Error(`实例 ${name} 不属于当前工作区或缺少可确认的迁移来源`)
  return manifest
}

async function listInstances(assetRoot: string, signal?: AbortSignal): Promise<{
  schema_version: '1.0'
  observed_at: string
  state_root: string
  instances: InstanceRecord[]
}> {
  const result = await runDsh(assetRoot, ['ps', '--all'], signal)
  const parsed = JSON.parse(result.stdout || '{}') as { instances?: Record<string, unknown>[] }
  const observedAt = new Date().toISOString()
  const gatewayRows = await businessAccess(assetRoot, false).then(value => value.gateway.instances as Record<string, unknown>[], () => [])
  const gatewayUrl = (instance: Record<string, unknown>): string | undefined => {
    if (!instance.business_gateway || typeof instance.agent_id !== 'string' || typeof instance.name !== 'string') return undefined
    try { return businessGatewayEntry(assetRoot, instance.agent_id, instance.name) }
    catch { return undefined }
  }
  return {
    schema_version: '1.0',
    observed_at: observedAt,
    state_root: instanceStateRoot(assetRoot),
    instances: (parsed.instances || []).map(instance => ({ observed_at: observedAt, ...instance,
      ...(instance.business_gateway ? {
        access_mode: gatewayRows.find(row => row.instanceId === instance.name && row.agentId === instance.agent_id)?.accessMode ?? 'authenticated',
        identity_mode: gatewayRows.find(row => row.instanceId === instance.name && row.agentId === instance.agent_id)?.identityMode ?? 'published',
        access_url: gatewayUrl(instance),
      } : {}) }) as InstanceRecord),
  }
}

async function instanceState(assetRoot: string, name: string, signal?: AbortSignal): Promise<string | null> {
  const listing = await listInstances(assetRoot, signal)
  const item = listing.instances.find(instance => instance.name === name)
  return typeof item?.state === 'string' ? item.state : null
}

async function assertKnownForMutation(assetRoot: string, name: string, signal?: AbortSignal): Promise<string | null> {
  const state = await instanceState(assetRoot, name, signal)
  if (state === 'unknown') throw new Error(`实例 ${name} 状态未知，拒绝执行生命周期操作`)
  return state
}

async function requestForUp(assetRoot: string, request: InstanceActionRequest, requireRecordedModel: boolean): Promise<InstanceActionRequest & { manifest?: any }> {
  const manifest = request.operation === 'create' ? undefined : await manifestFor(assetRoot, request.name)
  if (request.operation !== 'create' && !manifest) throw new Error(`未找到实例 ${request.name}`)
  const registeredDefault = manifest?.model_policy && typeof manifest.model_policy === 'object' && !Array.isArray(manifest.model_policy)
    ? (manifest.model_policy as Record<string, unknown>).default : undefined
  if (requireRecordedModel && manifest && !request.model_selection && registeredDefault == null) {
    throw new Error('此实例未记录默认模型，请先明确选择模型并重新预览；本次未执行。')
  }
  if (manifest && request.business_control !== undefined && request.business_control !== Boolean(manifest.business_control)) {
    throw new Error('既有实例不能切换业务网关边界；请新建独立实例')
  }
  const businessControl = manifest ? Boolean(manifest.business_control) : request.business_control === true
  const access = businessControl ? await businessAccess(assetRoot) : undefined
  if (request.access_mode && (!businessControl || request.operation !== 'create')) throw new Error('访问方式只能在创建受控实例时选择')
  if (request.identity_mode && (!businessControl || request.operation !== 'create')) throw new Error('智能体身份验证阶段只能在创建网关实例时选择')
  const registered = (access?.gateway.instances as Record<string, unknown>[] | undefined)
    ?.find(row => row.instanceId === request.name && row.agentId === manifest?.agent_id)
  const recordedBusiness = manifest?.business_control as { launch_config_file?: unknown; config_file?: unknown } | undefined
  if (recordedBusiness && typeof recordedBusiness.launch_config_file !== 'string' && typeof recordedBusiness.config_file !== 'string') {
    throw new Error('此旧受控实例未记录启动配置路径；请先核对原启动配置，不自动替换为当前网关配置')
  }
  return {
    ...request, manifest,
    business_control: businessControl,
    ...(businessControl ? {
      access_mode: request.access_mode ?? (registered?.accessMode === 'anonymous' ? 'anonymous' : 'authenticated'),
      identity_mode: request.identity_mode ?? (manifest ? registered?.identityMode === 'development' ? 'development' : 'published' : 'development'),
    } : {}),
    source: request.source || (manifest ? assertSource(manifest.source_id) : undefined),
    port: request.port ?? optionalPort(manifest?.port),
    model_selection: request.model_selection ?? (registeredDefault == null ? undefined : modelSelection(registeredDefault)),
  }
}

function upArgs(assetRoot: string, request: InstanceActionRequest & { manifest?: any }, dryRun = false): string[] {
  const args = ['up', '--name', request.name, '--source', request.source || '', '--mode', 'eval']
  if (request.business_control) args.push('--business-control', request.manifest?.business_control?.launch_config_file
    || request.manifest?.business_control?.config_file || businessAccessPath(assetRoot))
  if (request.port) args.push('--port', String(request.port))
  if (dryRun) args.push('--dry-run')
  if (request.operation === 'restart') args.push('--replace')
  if (request.allow_missing_env) args.push('--allow-missing-env')
  if (request.manifest?.trusted_host) args.push('--trusted-host', request.manifest.trusted_host)
  if (request.manifest?.mounts?.analysis_workspace) args.push('--analysis-workspace', request.manifest.mounts.analysis_workspace)
  if (request.manifest?.mounts?.plugin_node_modules) args.push('--plugin-node-modules', request.manifest.mounts.plugin_node_modules)
  return args
}

function parseCommandOutput(stdout: string, stderr: string) {
  const stdout_objects = parseJsonObjects(redact(stdout))
  const stderr_objects = parseJsonObjects(redact(stderr))
  const json_objects = [...stdout_objects, ...stderr_objects]
  return {
    json_objects,
    value: stdout_objects.at(-1) ?? stderr_objects.at(-1) ?? {},
    stdout: bounded(stdout),
    stderr: bounded(stderr),
  }
}

async function previewOne(assetRoot: string, request: InstanceActionRequest, signal?: AbortSignal, modelPolicy?: ModelPolicyProvider) {
  const name = assertName(request.name)
  if (request.operation === 'create' || request.operation === 'start' || request.operation === 'restart') {
    const prepared = await requestForUp(assetRoot, request, Boolean(modelPolicy))
    const source = prepared.source
    if (!source) throw new Error('创建、启动或重启需要来源')
    const agentId = await ensureRealSource(assetRoot, source)
    const projected = await runUpWithModelPolicy(assetRoot, upArgs(assetRoot, { ...prepared, name, source }, true), agentId,
      modelPolicy, prepared.model_selection, undefined, registeredModelSnapshot(prepared.manifest), signal)
    return { operation: request.operation, name, plan: JSON.parse(projected.result.stdout), retention: retention(request.operation),
      ...(prepared.business_control ? { access_mode: prepared.access_mode, identity_mode: prepared.identity_mode } : {}),
      model_selection: projected.model_selection, model_policy_hash: projected.model_policy_hash }
  }
  const manifest = await manifestFor(assetRoot, name)
  if (!manifest) throw new Error(`未找到实例 ${name}`)
  const observed = request.operation === 'stop' ? await listInstances(assetRoot, signal) : null
  const row = observed?.instances.find(instance => instance.name === name)
  if (request.operation === 'stop' && (typeof row?.state !== 'string' || row.state === 'unknown')) {
    throw new Error(`实例 ${name} 当前状态无法确认，请刷新后重新预览`)
  }
  return {
    operation: request.operation,
    name,
    source_id: manifest.source_id,
    image_tag: manifest.image_tag,
    port: manifest.port,
    ...(observed ? { observed_state: row?.state, observed_at: observed.observed_at } : {}),
    mounts: manifest.mounts,
    retention: retention(request.operation),
  }
}

function retention(operation: InstanceOperation) {
  return {
    home: '保留',
    sessions: '保留在 HOME 卷',
    source: '保留',
    runs: '保留',
    registration: operation === 'delete' ? '删除本实例管理登记' : '保留',
  }
}

const locks = new Map<string, Promise<unknown>>()

async function withInstanceLock<T>(names: string[], fn: () => Promise<T>): Promise<T> {
  const key = [...new Set(names)].sort().join(',')
  const previous = locks.get(key) || Promise.resolve()
  let release!: () => void
  const current = previous.catch(() => undefined).then(() => new Promise<void>(resolveRelease => {
    release = resolveRelease
  }))
  locks.set(key, current)
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === current) locks.delete(key)
  }
}

async function runOne(assetRoot: string, request: InstanceActionRequest, signal?: AbortSignal, modelPolicy?: ModelPolicyProvider): Promise<InstanceActionReceipt> {
  const name = assertName(request.name)
  try {
    return await withInstanceLock([name], async () => {
      if (request.expected_source_id !== undefined) {
        if (request.operation === 'create') {
          if (request.source !== request.expected_source_id) throw new Error('创建来源与预览来源不一致，请重新预览；本次未执行。')
        } else {
          const current = await manifestFor(assetRoot, name)
          if (current?.source_id !== request.expected_source_id) throw new Error('实例来源已变化，请刷新后重新预览；本次未执行。')
        }
      }
      if (modelPolicy && ['create', 'start', 'restart'].includes(request.operation) && !request.expected_model_policy_hash) {
        throw new Error('请先预览当前模型设置，再确认实例操作；本次未执行。')
      }
      // delete 在 CLI 内按目标实例核验容器状态，避免逐项扫描整个实例列表。
      if (request.operation !== 'create' && request.operation !== 'delete') {
        const state = await assertKnownForMutation(assetRoot, name, signal)
        if (request.operation === 'stop' && request.expected_state !== undefined && state !== request.expected_state) {
          throw new Error('实例状态已变化，请重新预览；本次未执行。')
        }
      }
      if (request.operation === 'create' || request.operation === 'start' || request.operation === 'restart') {
        const prepared = await requestForUp(assetRoot, request, Boolean(modelPolicy))
        const source = prepared.source
        if (!source) throw new Error('创建、启动或重启需要来源')
        const agentId = await ensureRealSource(assetRoot, source)
        if (prepared.business_control) {
          const preview = await runUpWithModelPolicy(assetRoot, upArgs(assetRoot, { ...prepared, name, source }, true), agentId,
            modelPolicy, prepared.model_selection, request.expected_model_policy_hash, registeredModelSnapshot(prepared.manifest), signal)
          const plan = JSON.parse(preview.result.stdout) as { business_control?: { source_digest?: string } }
          if (!request.expected_source_digest || plan.business_control?.source_digest !== request.expected_source_digest) {
            throw new Error('业务来源摘要与预览不一致，请重新预览；本次未执行')
          }
          await preflightGatewayRegistration(assetRoot, { agentId, instanceId: name, sourceId: source,
            sourceDigest: request.expected_source_digest,
            ...(request.operation === 'create' ? { accessMode: prepared.access_mode, identityMode: prepared.identity_mode } : {}) })
        }
        const projected = await runUpWithModelPolicy(assetRoot, upArgs(assetRoot, { ...prepared, name, source }), agentId,
          modelPolicy, prepared.model_selection, request.expected_model_policy_hash, registeredModelSnapshot(prepared.manifest), signal)
        if (prepared.business_control) {
          try {
            const manifest = await manifestFor(assetRoot, name)
            const registration = manifest?.business_control as { source_digest?: string } | undefined
            const sourceDigest = registration?.source_digest
            if (manifest?.source_id !== source || manifest?.agent_id !== agentId
              || !sourceDigest || sourceDigest !== request.expected_source_digest) {
              throw new Error('受控实例启动后来源登记与预览不一致')
            }
            await updateGatewayRegistration(assetRoot, { agentId, instanceId: name, sourceId: source, sourceDigest,
              ...(request.operation === 'create' ? { accessMode: prepared.access_mode, identityMode: prepared.identity_mode } : {}) })
            businessGatewayEntry(assetRoot, agentId, name)
          } catch (error) {
            try { await runDsh(assetRoot, ['down', name], signal) }
            catch { throw new Error(`实例已启动但网关登记失败，回退状态未知；请刷新实例与网关配置。${(error as Error).message}`) }
            throw new Error(`实例已停止并保留 HOME；网关登记失败，请修复配置后重启。${(error as Error).message}`)
          }
        }
        return { name, operation: request.operation, ok: true, requested_source_id: source,
          value: parseCommandOutput(projected.result.stdout, projected.result.stderr) }
      }
      const command = request.operation === 'delete' ? 'delete' : 'down'
      const before = command === 'delete' ? await manifestFor(assetRoot, name) : null
      const beforeDigest = (before?.business_control as { source_digest?: unknown } | undefined)?.source_digest
      let registration: { agentId: string; instanceId: string; sourceId: string; sourceDigest: string } | undefined
      if (command === 'delete' && before?.business_control) {
        if (typeof before.agent_id !== 'string' || typeof before.source_id !== 'string' || typeof beforeDigest !== 'string') {
          throw new Error('受控实例来源登记不完整，拒绝删除；请先核对实例与网关配置')
        }
        registration = { agentId: before.agent_id, instanceId: name, sourceId: before.source_id, sourceDigest: beforeDigest }
        await preflightGatewayRegistration(assetRoot, registration, true)
      }
      const result = await runDsh(assetRoot, [command, name], signal)
      if (registration) {
        try { await updateGatewayRegistration(assetRoot, registration, true) }
        catch (error) { throw new Error(`实例已由 DSH 删除，但业务网关登记清理未完成；请核对网关配置。${(error as Error).message}`) }
      }
      return { name, operation: request.operation, ok: true, value: parseCommandOutput(result.stdout, result.stderr) }
    })
  } catch (error) {
    return {
      name,
      operation: request.operation,
      ok: false,
      error: { code: 'operation_failed', message: (error as Error).message },
    }
  }
}

async function detail(assetRoot: string, name: string, signal?: AbortSignal) {
  const listing = await listInstances(assetRoot, signal)
  const instance = listing.instances.find(item => item.name === name)
  if (!instance) throw new Error(`未找到实例 ${name}`)
  const sourceId = typeof instance.source_id === 'string' ? instance.source_id : ''
  const experiment = sourceId.startsWith('experiment:') ? sourceId.slice('experiment:'.length) : null
  const runs = experiment ? await listRuns(assetRoot, experiment) : []
  return {
    instance,
    runs,
    session_scope: {
      home_volume: instance.home_volume,
      preserved: instance.home_preserved,
      note: '会话数据位于实例 HOME；平台不读取会话内容或凭据。',
    },
  }
}

async function listRuns(assetRoot: string, experiment: string) {
  try {
    const base = join(assetRoot, 'evolution/experiments', experiment, 'runs')
    const entries = await readdir(base, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && RUN_ID.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({ id: entry.name, experiment_id: experiment, path: `evolution/experiments/${experiment}/runs/${entry.name}` }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function actionRequest(payload: unknown): InstanceActionRequest {
  const object = payloadObject(payload)
  const operation = object.operation
  if (!['create', 'start', 'stop', 'restart', 'delete'].includes(String(operation))) {
    throw new Error('未知实例操作')
  }
  const request: InstanceActionRequest = {
    operation: operation as InstanceOperation,
    name: assertName(object.name),
    port: optionalPort(object.port),
    allow_missing_env: optionalBoolean(object.allow_missing_env, 'allow_missing_env'),
    business_control: optionalBoolean(object.business_control, 'business_control'),
  }
  if (object.access_mode !== undefined) {
    if (!['authenticated', 'anonymous'].includes(String(object.access_mode))) throw new Error('访问方式无效')
    request.access_mode = object.access_mode as 'authenticated' | 'anonymous'
  }
  if (object.identity_mode !== undefined) {
    if (!['development', 'published'].includes(String(object.identity_mode))) throw new Error('智能体身份验证阶段无效')
    request.identity_mode = object.identity_mode as 'development' | 'published'
  }
  if (object.source !== undefined) request.source = assertSource(object.source)
  if (object.expected_source_id !== undefined) request.expected_source_id = assertSource(object.expected_source_id)
  if (object.expected_source_digest !== undefined) {
    if (typeof object.expected_source_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(object.expected_source_digest)) throw new Error('来源摘要无效，请重新预览')
    request.expected_source_digest = object.expected_source_digest
  }
  if (object.expected_state !== undefined) {
    if (request.operation !== 'stop' || !['running', 'stopped', 'absent', 'failed'].includes(String(object.expected_state))) {
      throw new Error('预览的实例状态无效，请重新预览')
    }
    request.expected_state = object.expected_state as string
  }
  if (object.model_selection !== undefined) request.model_selection = modelSelection(object.model_selection)
  if (object.expected_model_policy_hash !== undefined) {
    if (typeof object.expected_model_policy_hash !== 'string' || !/^[0-9a-f]{64}$/.test(object.expected_model_policy_hash)) {
      throw new Error('模型策略摘要无效，请重新预览')
    }
    request.expected_model_policy_hash = object.expected_model_policy_hash
  }
  if (!['create', 'start', 'restart'].includes(request.operation) && (request.model_selection || request.expected_model_policy_hash)) {
    throw new Error('只有创建、启动或重启可以选择模型')
  }
  if (object.mode !== undefined) {
    if (object.mode !== 'eval') throw new Error('mode 只能是 eval')
    request.mode = 'eval'
  }
  return request
}

function invalidItem(item: unknown, error: unknown): InstanceActionReceipt {
  const object = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
  return {
    name: typeof object.name === 'string' ? object.name : '<invalid>',
    operation: typeof object.operation === 'string' ? object.operation : '<invalid>',
    ok: false,
    error: { code: 'invalid_request', message: (error as Error).message },
  }
}

export function createInstancesHandler(assetRoot: string, modelPolicy?: ModelPolicyProvider): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    if (signal.aborted) return failure('aborted', '实例操作已取消')
    try {
      if (endpoint === 'list') return ok(await listInstances(assetRoot, signal))
      if (endpoint === 'sources') return ok(await listSources(assetRoot))
      if (endpoint === 'url') {
        const name = assertName(payloadObject(payload).name)
        const manifest = await manifestFor(assetRoot, name)
        if (!manifest) throw new Error(`未找到实例 ${name}`)
        const port = optionalPort(manifest.port)
        if (!port) throw new Error('实例未记录有效 Web 端口')
        const result = await runDsh(assetRoot, ['url', name, '--non-interactive'], signal)
        const url = new URL(result.stdout.trim())
        if (manifest.business_control) {
          if (typeof manifest.agent_id !== 'string') throw new Error('业务实例缺少 Agent 登记')
          const entry = businessGatewayEntry(assetRoot, manifest.agent_id, name)
          if (url.href !== entry) throw new Error('实例返回的业务网关地址与登记入口不一致')
          return ok({ url: entry, lan_access: false })
        }
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port || 80) !== port || url.username || url.password) {
          throw new Error('实例返回的 Web 地址与登记端口不一致')
        }
        return ok({ url: url.href, lan_access: manifest.lan_access === true })
      }
      if (endpoint === 'logs') {
        const object = payloadObject(payload)
        const name = assertName(object.name)
        const tail = object.tail === undefined ? 200 : object.tail
        if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 1 || tail > 500) {
          throw new Error('tail 必须是 1..500 的有限整数')
        }
        const result = await runDsh(assetRoot, ['logs', name, '--tail', String(tail)], signal)
        return ok({ name, logs: bounded(result.stdout), stderr: bounded(result.stderr) })
      }
      if (endpoint === 'detail') {
        const object = payloadObject(payload)
        return ok(await detail(assetRoot, assertName(object.name), signal))
      }
      if (endpoint === 'preview') return ok(await previewOne(assetRoot, actionRequest(payload), signal, modelPolicy))
      if (endpoint === 'batch-preview') {
        const object = payloadObject(payload)
        if (!Array.isArray(object.items)) throw new Error('批量预览需要 items')
        const previews = []
        for (const item of object.items) {
          try {
            const request = actionRequest(item)
            previews.push({ name: request.name, operation: request.operation, ok: true,
              value: await previewOne(assetRoot, request, signal, modelPolicy) })
          } catch (error) {
            previews.push(invalidItem(item, error))
          }
        }
        return ok({
          ok: previews.every(item => item.ok),
          partial_success: previews.some(item => item.ok) && previews.some(item => !item.ok),
          previews,
        })
      }
      if (endpoint === 'run') return ok(await runOne(assetRoot, actionRequest(payload), signal, modelPolicy))
      if (endpoint === 'batch') {
        const object = payloadObject(payload)
        if (!Array.isArray(object.items)) throw new Error('批量操作需要 items')
        const receipts: InstanceActionReceipt[] = []
        for (const item of object.items) {
          try {
            receipts.push(await runOne(assetRoot, actionRequest(item), signal, modelPolicy))
          } catch (error) {
            receipts.push(invalidItem(item, error))
          }
        }
        return ok({
          ok: receipts.every(item => item.ok),
          partial_success: receipts.some(item => item.ok) && receipts.some(item => !item.ok),
          receipts,
        })
      }
      return failure('not_found', '未知的实例操作')
    } catch (error) {
      return failure('instances_failed', (error as Error).message)
    }
  }
}
