import { lstatSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import { readBusinessDefault } from './business-default.ts'
import { businessCatalogRoutes } from './catalog.ts'

type Route = { provider: string; model: string }
type Selection = Route & { reasoningEffort?: string }
type SettingsView = { ns: string; value: unknown }
type ModelPolicy = { agent_id: string; manifest_sha256: string; business_model_revision: string; allowed: Route[]; default: Selection; patch: unknown[]; credential_refs: string[] }
export type ProviderReadiness = { state: 'ready' | 'runtime_check' | 'missing_api_key' | 'platform_only' | 'unknown'; message: string }
type Services = {
  sessionController: { modelCatalog(): Promise<ModelCatalog> }
  settingsController: { describe(): { namespaces: SettingsView[] } }
  credentials: { resolve(ref: any): Promise<{ value: string } | undefined> }
  llm: { listConfigurableProviders(): Array<{ provider: string; settingsNs: string; defaultBaseURL?: string; baseURLEnv?: readonly string[]; nativeAuth?: { env: readonly string[]; oauth: boolean }; error?: string }> }
}
type ConnectionServices = Pick<Services, 'settingsController' | 'credentials' | 'llm'>
type Connection = { readiness: ProviderReadiness; environment: Record<string, string>; credentialRefs: string[] }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function route(value: unknown): Route | null {
  const item = record(value)
  return typeof item.provider === 'string' && item.provider && typeof item.model === 'string' && item.model
    ? { provider: item.provider, model: item.model } : null
}

function selection(value: unknown): Selection | null {
  const selected = route(value)
  if (!selected) return null
  const effort = record(value).reasoningEffort
  return typeof effort === 'string' && effort ? { ...selected, reasoningEffort: effort } : selected
}

function sameRoute(a: Route, b: Route) { return a.provider === b.provider && a.model === b.model }

function modelEntries(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(item => typeof record(item).id === 'string').map(item => record(item)) : []
}

function safeFields(value: unknown, keys: string[]): Record<string, unknown> {
  const input = record(value)
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]]))
}

function publicConfigWithResolvedRefs(value: unknown, refs: Set<string>, selectedProvider: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => publicConfigWithResolvedRefs(item, refs, selectedProvider))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if ((key === 'apiKeyEnv' || key === 'baseURLEnv') && (typeof item !== 'string' || !refs.has(item))) {
      if (selectedProvider) throw new Error('所选模型提供方的连接变量未就绪，请检查设置 → 模型')
      return []
    }
    return [[key, publicConfigWithResolvedRefs(item, refs, selectedProvider)]]
  }))
}

const readiness = (state: ProviderReadiness['state'], message: string): ProviderReadiness => ({ state, message })
const unknownConnection = (provider: string): Connection => ({
  readiness: readiness('unknown', `暂无法核对 ${provider} 的业务实例连接配置，请检查设置 → 模型后刷新。`),
  environment: {}, credentialRefs: [],
})

async function providerConnection(provider: string, namespaces: SettingsView[], directory: ReturnType<Services['llm']['listConfigurableProviders']>, credentials: Services['credentials']): Promise<Connection> {
  if (provider === 'deepseek-account') return {
    readiness: readiness('platform_only', '账号登录授权仅属于平台助手，不能用于业务实例。'),
    environment: {}, credentialRefs: [],
  }
  const pi = record(namespaces.find(item => item.ns === 'llm-pi-ai')?.value)
  const configuredProviders = record(pi.providers)
  const entry = directory.find(item => item.provider === provider && item.settingsNs === 'llm-pi-ai')
  const source = record(configuredProviders[provider])
  if (provider !== 'deepseek-official' && !entry) return {
    readiness: readiness('unknown', `提供方 ${provider} 当前没有业务实例连接配置投影；平台助手仍可按原生设置使用。`),
    environment: {}, credentialRefs: [],
  }
  if (provider !== 'deepseek-official' && !Object.hasOwn(configuredProviders, provider)) return unknownConnection(provider)
  if (entry?.error) return unknownConnection(provider)
  if (provider !== 'deepseek-official' && Object.keys(record(source.headers)).length) return {
    readiness: readiness('platform_only', `提供方 ${provider} 使用静态请求头；业务实例需改用可解析的凭据引用。`),
    environment: {}, credentialRefs: [],
  }
  const deepseek = record(namespaces.find(item => item.ns === 'llm-deepseek')?.value)
  const explicit = provider === 'deepseek-official'
    ? (typeof deepseek.apiKeyEnv === 'string' && deepseek.apiKeyEnv ? deepseek.apiKeyEnv : 'DEEPSEEK_API_KEY')
    : typeof source.apiKeyEnv === 'string' && source.apiKeyEnv ? source.apiKeyEnv : null
  const endpointRefs = entry?.baseURLEnv ?? []
  const candidates = explicit ? [explicit] : (entry?.nativeAuth?.env ?? []).filter(ref => !endpointRefs.includes(ref))
  const refs = [...new Set([...candidates, ...endpointRefs])]
  if (refs.some(ref => !/^[A-Z][A-Z0-9_]*$/.test(ref))) return unknownConnection(provider)
  const environment: Record<string, string> = {}
  for (const ref of refs) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved?.value) environment[ref] = resolved.value
    } catch { return unknownConnection(provider) }
  }
  const availableAuth = candidates.filter(ref => Boolean(environment[ref]))
  if (candidates.length && !availableAuth.length) return {
    readiness: readiness('missing_api_key', `提供方 ${provider} 尚无业务实例可解析的 API Key；请在设置 → 模型中配置后刷新。`),
    environment: {}, credentialRefs: [],
  }
  if (!candidates.length && entry?.nativeAuth?.oauth) return {
    readiness: readiness('platform_only', `提供方 ${provider} 只有平台进程的账号登录授权；业务实例需配置 API Key。`),
    environment: {}, credentialRefs: [],
  }
  const availableEndpoint = endpointRefs.filter(ref => Boolean(environment[ref]))
  const dynamicEndpoint = endpointRefs.length > 0 && !source.baseURL && !entry?.defaultBaseURL
  if (dynamicEndpoint && !availableEndpoint.length) return {
    readiness: readiness('unknown', `提供方 ${provider} 的动态端点未配置；请在设置 → 模型中配置端点后刷新。`),
    environment: {}, credentialRefs: [],
  }
  const needsCallCheck = dynamicEndpoint || (!explicit && candidates.length > 1)
  const forwarded = Object.fromEntries(refs.filter(ref => Boolean(environment[ref])).map(ref => [ref, environment[ref]]))
  return {
    readiness: needsCallCheck
      ? readiness('runtime_check', '业务实例环境可投影；原生授权或动态端点需在实例中实际调用核对。')
      : readiness('ready', candidates.length ? '业务实例可解析 API Key；实际调用仍需启动核验。' : '无需 API Key 的连接配置可用于业务实例启动；实际调用仍需核验。'),
    environment: forwarded, credentialRefs: Object.keys(forwarded),
  }
}

/** 目录只公开连接状态；凭据值和引用留在进程内的实例启动投影中。 */
export async function modelProviderReadiness(providers: readonly string[], services: ConnectionServices): Promise<Record<string, ProviderReadiness>> {
  let namespaces: SettingsView[]
  let directory: ReturnType<Services['llm']['listConfigurableProviders']>
  try {
    namespaces = services.settingsController.describe().namespaces
    directory = services.llm.listConfigurableProviders()
  } catch {
    return Object.fromEntries(providers.map(provider => [provider, unknownConnection(provider).readiness]))
  }
  const entries = await Promise.all(providers.map(async provider => {
    try { return [provider, (await providerConnection(provider, namespaces, directory, services.credentials)).readiness] as const }
    catch { return [provider, unknownConnection(provider).readiness] as const }
  }))
  return Object.fromEntries(entries)
}

function checkedManifest(assetRoot: string, agentId: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) throw new Error('智能体 ID 无效')
  const root = resolve(assetRoot)
  const agentDir = join(root, 'agents', agentId)
  const file = join(agentDir, 'manifest.yaml')
  if (lstatSync(agentDir).isSymbolicLink() || !lstatSync(agentDir).isDirectory()
    || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error('智能体模型配置来源不是普通文件')
  const text = readFileSync(file, 'utf8')
  const manifest = record(loadYaml(text))
  if (manifest.agent_id !== undefined && manifest.agent_id !== agentId) throw new Error('智能体模型配置的对象身份不一致')
  return { manifest, sha256: createHash('sha256').update(text).digest('hex') }
}

/** 平台原生设置是模型目录与连接配置的唯一来源；实例 Patch 只是一份启动投影。 */
export async function projectModelPolicy(assetRoot: string, agentId: string, services: Services, requestedSelection?: Selection | null): Promise<{ policy: ModelPolicy; environment: Record<string, string> }> {
  const { sha256 } = checkedManifest(assetRoot, agentId)
  const business = readBusinessDefault(assetRoot)
  if (business.migrationRequired) throw new Error('请先在设置 → 模型中确认业务智能体统一默认模型；旧配置不会自动生效')
  if (!business.default) throw new Error('请先在设置 → 模型中选择业务智能体统一默认模型')
  const selected = selection(requestedSelection === undefined ? business.default : requestedSelection)
  if (!selected) throw new Error('请为此实例选择默认模型')
  const catalog = await services.sessionController.modelCatalog()
  const namespaces = services.settingsController.describe().namespaces
  const deepseek = record(namespaces.find(item => item.ns === 'llm-deepseek')?.value)
  const pi = record(namespaces.find(item => item.ns === 'llm-pi-ai')?.value)
  const directory = services.llm.listConfigurableProviders()
  const connections = new Map<string, Awaited<ReturnType<typeof providerConnection>>>()
  for (const group of catalog.groups) {
    if (!connections.has(group.id)) connections.set(group.id, await providerConnection(group.id, namespaces, directory, services.credentials))
  }
  const platformOnly = new Set([...connections].filter(([, connection]) => connection.readiness.state === 'platform_only').map(([provider]) => provider))
  const routes = businessCatalogRoutes(catalog, platformOnly)
  if (!routes.some(item => sameRoute(item, selected))) throw new Error('此实例默认模型不在当前业务可用目录中；请重新选择')
  const selectedModel = catalog.groups.find(group => group.id === selected.provider)?.models.find(model => model.id === selected.model)
  if (selected.reasoningEffort && !selectedModel?.reasoning?.efforts.some(item => item.id === selected.reasoningEffort)) {
    throw new Error('此实例默认模型的推理档位已不可用，请刷新模型设置')
  }

  const refs = new Set<string>()
  const environment: Record<string, string> = {}
  for (const provider of new Set(routes.map(item => item.provider))) {
    const connection = connections.get(provider)!
    if (connection.readiness.state !== 'ready' && connection.readiness.state !== 'runtime_check') {
      if (provider === selected.provider) throw new Error(connection.readiness.message)
      continue
    }
    connection.credentialRefs.forEach(ref => refs.add(ref))
    Object.assign(environment, connection.environment)
  }
  const patch: unknown[] = [{ id: 'agent-default-model', config: selected }]
  const official = routes.filter(item => item.provider === 'deepseek-official')
  if (official.length) {
    const configured = modelEntries(deepseek.models)
    const models = official.map(item => configured.find(model => model.id === item.model) ?? { id: item.model })
    const config: Record<string, unknown> = { ...safeFields(deepseek, ['apiKeyEnv', 'baseURL', 'thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'retryPolicy']), models }
    patch.push({ id: 'llm-deepseek', config: publicConfigWithResolvedRefs(config, refs, selected.provider === 'deepseek-official') })
  } else patch.push({ id: 'llm-deepseek', disabled: true })
  if (routes.some(item => item.provider === 'deepseek-account')) {
    throw new Error('DeepSeek 账号模型的登录授权仅属于平台进程；业务智能体请选择可通过 API Key 装载的模型')
  }
  patch.push({ id: 'llm-deepseek-account', disabled: true })

  const customProviders = [...new Set(routes.filter(item => !['deepseek-official', 'deepseek-account'].includes(item.provider)).map(item => item.provider))]
  if (customProviders.length) {
    const configuredProviders = record(pi.providers)
    const providers: Record<string, unknown> = {}
    for (const provider of customProviders) {
      const entry = directory.find(item => item.provider === provider && item.settingsNs === 'llm-pi-ai')
      if (!entry || !Object.hasOwn(configuredProviders, provider)) {
        if (provider === selected.provider) throw new Error(`模型提供方 ${provider} 的平台设置不可读取，请先检查设置 → 模型`)
        continue
      }
      const source = record(configuredProviders[provider])
      if (Object.keys(record(source.headers)).length && provider === selected.provider) {
        throw new Error(`模型提供方 ${provider} 使用静态请求头；请改用凭据引用后再装载业务实例`)
      }
      const configured = modelEntries(source.models)
      const overrides = record(source.modelOverrides)
      const models = routes.filter(item => item.provider === provider).map(item => {
        const base = configured.find(model => model.id === item.model)
        if (base) return base
        return { id: item.model, ...record(overrides[item.model]) }
      })
      const config: Record<string, unknown> = { ...safeFields(source, ['apiKeyEnv', 'displayName', 'api', 'baseURL', 'compat', 'reasoning', 'defaultContextWindow', 'defaultMaxTokens', 'retryPolicy']), models }
      providers[provider] = publicConfigWithResolvedRefs(config, refs, provider === selected.provider)
    }
    patch.push({ id: 'llm-pi-ai', config: { ...safeFields(pi, ['retryPolicy']), providers } })
  } else patch.push({ id: 'llm-pi-ai', config: { providers: {} } })

  return { policy: { agent_id: agentId, manifest_sha256: sha256, business_model_revision: business.revision,
    allowed: routes, default: selected, patch, credential_refs: [...refs] }, environment }
}
