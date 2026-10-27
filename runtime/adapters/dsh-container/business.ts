import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBusinessRuntimePatch } from '../../../platform/plugin/src/business-control/patch.ts'
import { platformGroupUrl } from '../../../platform/plugin/src/business-control/group-link.ts'
import { businessGatewayEntry } from '../../../platform/plugin/src/business-control/entry.ts'

const programRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(programRoot, 'platform/plugin/package.json'))
const yaml = require('js-yaml') as { load(text: string, options?: unknown): any; dump(value: unknown, options?: unknown): string; Type: any; DEFAULT_SCHEMA: any }
// DSH 表达式只作为带标签的标量保留，装配连接时不求值。
const patchSchema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', construct: (value: string) => new String(value),
  predicate: (value: unknown) => value instanceof String, represent: (value: String) => String(value),
}))
const containerAssets = '/opt/harness-business-assets'
const containerPlugin = '/opt/harness-platform'
const containerSecret = '/opt/harness-business/shared-secret'
const containerPatch = '/opt/harness-business/business.patch.yml'

export interface BusinessLaunchConfig {
  assetRoot: string; sharedSecretFile: string; coordinatorOrigin: string; pluginRoot?: string
}
export interface BusinessRenderInput {
  name: string; agentId: string; workspaceId: string; sourceDigest: string; runtimeGeneration?: string
  port: number; compose: string; profileManifest: string; basePath: string; presetId?: string; runtimeSettings?: string; managedPatch?: string
  sourcePaths?: { managed: string }
}

interface LocalModelRoute { provider: string; model: string }
function readLocalCapabilities(managed: string): { localTools: string[]; localModelRoutes: LocalModelRoute[] } {
  const path = join(managed, 'role-tool-matrix.yaml')
  if (!existsSync(path)) return { localTools: [], localModelRoutes: [] }
  const state = lstatSync(path)
  if (!state.isFile() || state.size > 64 * 1024) throw new Error('业务本地能力声明必须是受控普通文件')
  const value = yaml.load(readFileSync(path, 'utf8')) as any
  const declared = value?.runtime_capabilities
  if (declared === undefined) return { localTools: [], localModelRoutes: [] }
  const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
  const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/
  const tools = declared?.local_tools, routes = declared?.local_model_routes
  if (!declared || Array.isArray(declared) || Object.keys(declared).sort().join(',') !== 'local_model_routes,local_tools'
    || !Array.isArray(tools) || tools.length > 32 || tools.some(name => typeof name !== 'string' || !namePattern.test(name))
    || new Set(tools).size !== tools.length || !Array.isArray(routes) || routes.length > 16
    || routes.some(route => !route || Array.isArray(route) || Object.keys(route).sort().join(',') !== 'model,provider'
      || typeof route.provider !== 'string' || !modelPattern.test(route.provider)
      || typeof route.model !== 'string' || !modelPattern.test(route.model))
    || new Set(routes.map(route => `${route.provider}\0${route.model}`)).size !== routes.length) {
    throw new Error('业务本地能力声明无效')
  }
  return { localTools: tools, localModelRoutes: routes }
}

/** 固定实际装载资产的内容身份；依赖按其锁文件纳入，安装缓存不回流资产。 */
export function businessSourceDigest(paths: Record<string, string>): string {
  const hash = createHash('sha256')
  function visit(root: string, relative: string): void {
    const absolute = join(root, relative), state = lstatSync(absolute)
    if (state.isSymbolicLink()) throw new Error('业务资产中存在未固定的符号链接')
    if (state.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) if (!['node_modules', '.git', '.local'].includes(name)) visit(root, join(relative, name))
    } else if (state.isFile()) hash.update(relative).update('\0').update(readFileSync(absolute)).update('\0')
    else throw new Error('业务资产类型不支持')
  }
  for (const [kind, root] of Object.entries(paths).sort()) { hash.update(kind).update('\0'); visit(root, '') }
  return `sha256:${hash.digest('hex')}`
}

/** 启动配置只定位程序、事实源和受信通道，不复制授权规则或连接清单。 */
export function readBusinessLaunchConfig(file: string): BusinessLaunchConfig {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as BusinessLaunchConfig & { gateway?: { publicOrigin?: string; sharedSecretFile?: string } }
  // 平台以业务访问配置作为唯一可编辑来源；历史独立 launch 文件仍可用于既有实例。
  const assetRoot = dirname(dirname(file)), secretFile = saved.gateway?.sharedSecretFile
  const config: BusinessLaunchConfig = saved.gateway ? {
    assetRoot,
    sharedSecretFile: typeof secretFile === 'string' && !isAbsolute(secretFile) ? resolve(assetRoot, secretFile) : secretFile!,
    coordinatorOrigin: saved.gateway.publicOrigin!, pluginRoot: join(programRoot, 'platform/plugin'),
  } : saved
  for (const key of ['assetRoot', 'sharedSecretFile'] as const) {
    const path = config[key]
    if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path) || realpathSync(path) !== path) throw new Error(`业务启动配置的 ${key} 必须是已存在的规范化绝对路径`)
  }
  if (!statSync(config.assetRoot).isDirectory() || !statSync(config.sharedSecretFile).isFile()
    || statSync(config.sharedSecretFile).size < 32) throw new Error('业务数据根或共享密钥文件无效')
  const access = JSON.parse(readFileSync(join(config.assetRoot, 'config/business-access.json'), 'utf8'))
  if (access.schemaVersion !== 1 || access.enabled !== true) throw new Error('业务访问配置尚未启用')
  const origin = new URL(config.coordinatorOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('协调器必须使用不含路径和凭据的 HTTP 来源地址')
  if (['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('bridge 容器不能使用宿主回环地址访问协调器；请配置可达宿主地址')
  const pluginRoot = config.pluginRoot ?? join(programRoot, 'platform/plugin')
  if (!isAbsolute(pluginRoot) || !existsSync(pluginRoot) || !statSync(pluginRoot).isDirectory() || realpathSync(pluginRoot) !== pluginRoot) throw new Error('业务插件根路径无效')
  for (const file of ['lib/business-runtime.js', 'business/package.json', 'business/runtime.js']) {
    if (!existsSync(join(pluginRoot, file)) || !statSync(join(pluginRoot, file)).isFile()) throw new Error('业务 Runtime 插件尚未构建')
  }
  return { ...config, pluginRoot }
}

/** 只返回生成内容；实例目录由原启动器在 preflight 成功后写入。 */
export function renderBusinessInstance(config: BusinessLaunchConfig, input: BusinessRenderInput) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.name) || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.agentId)
    || !input.sourceDigest || !input.workspaceId
    || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('业务实例登记参数无效')
  const compose = yaml.load(input.compose)
  const service = compose?.services?.dsh
  if (!service || service.network_mode !== 'host') throw new Error('业务 Compose 缺少受控 dsh 网络入口')
  const seed = input.runtimeSettings && existsSync(input.runtimeSettings) ? input.runtimeSettings : join(dirname(input.profileManifest), 'web-profile.seed.patch.yml')
  // 可选来源种子只按数据读取；无 MCP manager 时保留 DSH 原生装载。
  const entries = existsSync(seed) ? yaml.load(readFileSync(seed, 'utf8')) ?? [] : []
  if (!Array.isArray(entries) || entries.some(item => item?.insert !== undefined && !Array.isArray(item.insert))) throw new Error('业务来源 MCP 配置种子无效')
  const managers = entries.flatMap(item => [item, ...(item?.insert ?? [])])
    .filter(item => item?.id === 'mcp-session-manager' || typeof item?.name === 'string' && /(?:^|\/)mcp-manager\/(?:index\.(?:mjs|js|ts))$/.test(item.name))
  if (managers.length > 1 || managers.length === 1 && (typeof managers[0]?.id !== 'string' || !managers[0].id
    || typeof managers[0]?.name !== 'string' || !/(?:^|\/)mcp-manager\/(?:index\.(?:mjs|js|ts))$/.test(managers[0].name)
    || !managers[0].config || typeof managers[0].config !== 'object' || Array.isArray(managers[0].config))) {
    throw new Error('业务来源 MCP manager 声明冲突或配置无效')
  }
  const manager = managers[0]
  const pluginRoot = config.pluginRoot ?? join(programRoot, 'platform/plugin')
  if (manager) for (const file of ['lib/mcp-manager.js', 'business/mcp-manager.js']) {
    if (!existsSync(join(pluginRoot, file)) || !statSync(join(pluginRoot, file)).isFile()) throw new Error('业务 MCP manager 插件尚未构建')
  }
  const capabilities = readLocalCapabilities(input.sourcePaths?.managed ?? dirname(input.profileManifest))
  const runtimeGeneration = input.runtimeGeneration ?? randomUUID()
  const businessBasePath = `/agents/${input.agentId}/instances/${input.name}/`
  const runtimeConfig = {
    assetRoot: containerAssets, stateRoot: '/var/lib/dsh/business-control-state', sharedSecretFile: containerSecret,
    coordinatorOrigin: config.coordinatorOrigin, basePath: businessBasePath,
    workspacePath: '/work/harness/workspace', presetId: input.presetId ?? input.agentId,
    localTools: capabilities.localTools,
    binding: { workspaceId: input.workspaceId, agentId: input.agentId, instanceId: input.name,
      runtimeGeneration, sourceDigest: input.sourceDigest },
  }
  // 平台分组连接随部署入口装配；固定 Candidate 及其摘要保持原样。
  const projectLinks = (value: any): any => {
    if (typeof value === 'string') {
      const match = /^https?:\/\/[^/]+\/.*mcp\/groups\/([A-Za-z0-9_-]{1,32})\/v2$/.exec(value)
      return match ? platformGroupUrl(config.assetRoot, match[1]!) : value
    }
    if (Array.isArray(value)) return value.map(projectLinks)
    if (value instanceof String) return value
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectLinks(item)]))
    return value
  }
  const managedEntries = input.managedPatch ? yaml.load(readFileSync(input.managedPatch, 'utf8'), { schema: patchSchema }) : []
  if (!Array.isArray(managedEntries)) throw new Error('业务来源配置 Patch 无效')
  const connectionPatches = managedEntries.flatMap(item => [item, ...(item?.insert ?? [])]).flatMap(item => {
    if (!item?.id || !item.config) return []
    const config = projectLinks(item.config)
    return JSON.stringify(config) === JSON.stringify(item.config) ? [] : [{ id: item.id, config }]
  })
  const patch = [
    { id: 'webserver', config: { host: '0.0.0.0', port: input.port, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } },
    ...connectionPatches,
    { id: 'web-runtime', config: { publicUrl: new URL(businessBasePath, config.coordinatorOrigin).href } },
    ...(manager ? [{ id: manager.id, disabled: true }] : []),
    ...createBusinessRuntimePatch(runtimeConfig, `${containerPlugin}/business/runtime.js`,
      manager ? `${containerPlugin}/business/mcp-manager.js` : undefined, manager?.config),
  ]
  delete service.network_mode
  service.networks = ['business']
  service.ports = [`127.0.0.1:${input.port}:${input.port}`]
  service.extra_hosts = [...new Set([...(service.extra_hosts ?? []), 'host.docker.internal:host-gateway'])]
  compose.networks = { ...(compose.networks ?? {}), business: { driver: 'bridge' } }
  const command = service.command as string[]
  const host = command.indexOf('--host'), tail = command.indexOf('--no-open')
  if (host < 0 || tail < 0 || command.includes('/opt/dsh-adapter/verification-home-controls/web-unsafe-no-auth.patch.yml')) throw new Error('业务 Runtime 必须关闭免认证并保留明确监听配置')
  // CLI 禁止 wildcard；受管 WebServer 只在本实例 bridge 内监听全部接口。
  command[host + 1] = '127.0.0.1'
  command.splice(tail, 0, '--patch', containerPatch)
  service.environment.push(`HARNESS_ASSET_ROOT=${containerAssets}`)
  service.environment.push(`HARNESS_BUSINESS_AGENT_ID=${input.agentId}`)
  service.environment.push(`HARNESS_BUSINESS_INSTANCE_ID=${input.name}`)
  service.volumes.push(
    { type: 'bind', source: pluginRoot, target: containerPlugin, read_only: true },
    { type: 'bind', source: config.assetRoot, target: containerAssets, read_only: true },
    { type: 'bind', source: config.sharedSecretFile, target: containerSecret, read_only: true },
    { type: 'bind', source: '${DSH_BUSINESS_PATCH_HOST:?业务控制 Patch 由启动器注入}', target: containerPatch, read_only: true },
  )
  return { compose: yaml.dump(compose, { lineWidth: -1, noRefs: true }), patch: yaml.dump(patch, { lineWidth: -1, noRefs: true, schema: patchSchema }),
    registration: { runtime_generation: runtimeGeneration, source_digest: input.sourceDigest,
      origin: `http://127.0.0.1:${input.port}`, scheduling_supported: true },
    runtimeConfig, localModelRoutes: capabilities.localModelRoutes }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--capabilities') {
      console.log(JSON.stringify(readLocalCapabilities(resolve(process.argv[3]!))))
      process.exit(0)
    }
    if (process.argv[2] === '--entry') {
      const assetRoot = resolve(process.argv[3]!), agentId = process.argv[4]!, instanceId = process.argv[5]!
      const url = businessGatewayEntry(assetRoot, agentId, instanceId)
      const access = JSON.parse(readFileSync(join(assetRoot, 'config/business-access.json'), 'utf8'))
      const selected = access.gateway.instances.find((item: { agentId: string; instanceId: string }) => item.agentId === agentId && item.instanceId === instanceId)
      console.log(JSON.stringify({ url, accessMode: selected?.accessMode === 'anonymous' ? 'anonymous' : 'authenticated' }))
      process.exit(0)
    }
    const config = readBusinessLaunchConfig(resolve(process.argv[2]!))
    const text = readFileSync(0, 'utf8').trim(), input = text ? JSON.parse(text) : undefined
    const access = JSON.parse(readFileSync(join(config.assetRoot, 'config/business-access.json'), 'utf8'))
    const development = access.gateway?.instances?.some((row: any) => row.agentId === input?.agentId
      && row.instanceId === input?.name && row.identityMode === 'development') === true
    if (input?.compose && input?.sourcePaths && businessSourceDigest(input.sourcePaths) !== input.sourceDigest) throw new Error('业务资产在计划后已改变')
    console.log(JSON.stringify(input?.compose ? renderBusinessInstance(config, input) : {
      valid: true, assetRoot: config.assetRoot, pluginRoot: config.pluginRoot, development,
      ...(input?.sourcePaths ? { sourceDigest: businessSourceDigest(input.sourcePaths) } : {}),
    }))
  } catch (error) {
    const known = new Set([
      '业务数据根或共享密钥文件无效', '业务访问配置尚未启用', '协调器必须使用不含路径和凭据的 HTTP 来源地址',
      'bridge 容器不能使用宿主回环地址访问协调器；请配置可达宿主地址', '业务插件根路径无效',
      '业务 Runtime 插件尚未构建', '业务 MCP manager 插件尚未构建', '业务来源 MCP 配置种子无效',
      '业务来源 MCP manager 声明冲突或配置无效', '业务来源配置 Patch 无效', '业务本地能力声明必须是受控普通文件',
      '业务本地能力声明无效', '业务资产在计划后已改变', '业务实例登记参数无效',
      '业务 Compose 缺少受控 dsh 网络入口', '业务 Runtime 必须关闭免认证并保留明确监听配置',
      '业务启动配置的 assetRoot 必须是已存在的规范化绝对路径',
      '业务启动配置的 sharedSecretFile 必须是已存在的规范化绝对路径',
      '实例未向业务网关开放', '业务网关公开来源无效', '业务实例名称无效', '业务实例归属不匹配',
      '实例没有已核对的业务接入登记', '业务实例来源与网关登记不一致', '业务实例接入地址无效',
      '业务 Runtime 必须使用本机或私网地址', '业务实例 Web 基址与实例入口不一致',
    ])
    const reason = error instanceof Error && known.has(error.message) ? error.message
      : process.argv[2] === '--entry' ? '业务网页入口配置或实例登记读取失败，请核对当前数据工作区与网关登记'
        : '业务启动配置或来源文件解析失败'
    console.error(`BUSINESS_STARTUP_ERROR:${reason}`)
    process.exitCode = 1
  }
}
