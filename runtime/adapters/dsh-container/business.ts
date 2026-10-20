import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBusinessRuntimePatch } from '../../../platform/plugin/src/business-control/patch.ts'
import { businessGatewayEntry } from '../../../platform/plugin/src/business-control/entry.ts'

const programRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(programRoot, 'platform/plugin/package.json'))
const yaml = require('js-yaml') as { load(text: string): any; dump(value: unknown, options?: unknown): string }
const containerAssets = '/opt/harness-business-assets'
const containerPlugin = '/opt/harness-platform'
const containerSecret = '/opt/harness-business/shared-secret'
const containerPatch = '/opt/harness-business/business.patch.yml'

export interface BusinessLaunchConfig {
  assetRoot: string; sharedSecretFile: string; coordinatorOrigin: string; pluginRoot?: string
}
export interface BusinessRenderInput {
  name: string; agentId: string; workspaceId: string; sourceDigest: string; runtimeGeneration?: string
  port: number; compose: string; profileManifest: string; basePath: string; presetId?: string; runtimeSettings?: string
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
  const config = JSON.parse(readFileSync(file, 'utf8')) as BusinessLaunchConfig
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
  if (!isAbsolute(pluginRoot) || !statSync(pluginRoot).isDirectory() || realpathSync(pluginRoot) !== pluginRoot) throw new Error('业务插件根路径无效')
  for (const file of ['lib/business-runtime.js', 'lib/mcp-manager.js', 'business/package.json', 'business/runtime.js', 'business/mcp-manager.js']) {
    if (!statSync(join(pluginRoot, file)).isFile()) throw new Error('业务 Runtime 插件尚未构建')
  }
  return { ...config, pluginRoot }
}

/** 只返回生成内容；实例目录由原启动器在 preflight 成功后写入。 */
export function renderBusinessInstance(config: BusinessLaunchConfig, input: BusinessRenderInput) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) || !input.sourceDigest || !input.workspaceId || !input.agentId
    || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('业务实例登记参数无效')
  const compose = yaml.load(input.compose)
  const service = compose?.services?.dsh
  if (!service || service.network_mode !== 'host') throw new Error('业务 Compose 缺少受控 dsh 网络入口')
  const seed = input.runtimeSettings && existsSync(input.runtimeSettings) ? input.runtimeSettings : join(dirname(input.profileManifest), 'web-profile.seed.patch.yml')
  if (!existsSync(seed)) throw new Error('业务来源缺少 MCP 配置种子')
  // 种子只按数据读取；不执行其中的表达式、Hook 或插件。
  const entries = (yaml.load(readFileSync(seed, 'utf8')) ?? []) as any[]
  const managers = entries.flatMap(item => item?.insert ?? []).filter(item => typeof item.name === 'string' && /(?:^|\/)mcp-manager\/(?:index\.(?:mjs|js|ts))$/.test(item.name))
  if (managers.length !== 1 || !managers[0].id || typeof managers[0].config !== 'object') throw new Error('业务来源必须有一个明确的 MCP manager 配置')
  const runtimeGeneration = input.runtimeGeneration ?? randomUUID()
  const businessBasePath = `/agents/${input.agentId}/`
  const runtimeConfig = {
    assetRoot: containerAssets, stateRoot: '/var/lib/dsh/business-control-state', sharedSecretFile: containerSecret,
    coordinatorOrigin: config.coordinatorOrigin, basePath: businessBasePath,
    workspacePath: '/work/harness/workspace', presetId: input.presetId ?? input.agentId,
    binding: { workspaceId: input.workspaceId, agentId: input.agentId, instanceId: input.name,
      runtimeGeneration, sourceDigest: input.sourceDigest },
  }
  const patch = [
    { id: 'webserver', config: { host: '0.0.0.0', port: input.port, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } },
    { id: managers[0].id, disabled: true },
    ...createBusinessRuntimePatch(runtimeConfig, `${containerPlugin}/business/runtime.js`, `${containerPlugin}/business/mcp-manager.js`, managers[0].config),
  ]
  delete service.network_mode
  service.networks = ['business']
  service.ports = [`127.0.0.1:${input.port}:${input.port}`]
  service.extra_hosts = [...(service.extra_hosts ?? []), 'host.docker.internal:host-gateway']
  compose.networks = { ...(compose.networks ?? {}), business: { driver: 'bridge' } }
  const command = service.command as string[]
  const host = command.indexOf('--host'), tail = command.indexOf('--no-open')
  if (host < 0 || tail < 0 || command.includes('/opt/dsh-adapter/verification-home-controls/web-unsafe-no-auth.patch.yml')) throw new Error('业务 Runtime 必须关闭免认证并保留明确监听配置')
  // CLI 禁止 wildcard；受管 WebServer 只在本实例 bridge 内监听全部接口。
  command[host + 1] = '127.0.0.1'
  command.splice(tail, 0, '--patch', containerPatch)
  service.environment.push(`HARNESS_ASSET_ROOT=${containerAssets}`)
  service.environment.push(`HARNESS_BUSINESS_AGENT_ID=${input.agentId}`)
  service.volumes.push(
    { type: 'bind', source: config.pluginRoot, target: containerPlugin, read_only: true },
    { type: 'bind', source: config.assetRoot, target: containerAssets, read_only: true },
    { type: 'bind', source: config.sharedSecretFile, target: containerSecret, read_only: true },
    { type: 'bind', source: '${DSH_BUSINESS_PATCH_HOST:?业务控制 Patch 由启动器注入}', target: containerPatch, read_only: true },
  )
  return { compose: yaml.dump(compose, { lineWidth: -1, noRefs: true }), patch: yaml.dump(patch, { lineWidth: -1, noRefs: true }),
    registration: { runtime_generation: runtimeGeneration, source_digest: input.sourceDigest,
      origin: `http://127.0.0.1:${input.port}`, scheduling_supported: false },
    runtimeConfig }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--entry') {
      console.log(JSON.stringify({ url: businessGatewayEntry(resolve(process.argv[3]!), process.argv[4]!, process.argv[5]!) }))
      process.exit(0)
    }
    const config = readBusinessLaunchConfig(resolve(process.argv[2]!))
    const text = readFileSync(0, 'utf8').trim(), input = text ? JSON.parse(text) : undefined
    if (input?.compose && input?.sourcePaths && businessSourceDigest(input.sourcePaths) !== input.sourceDigest) throw new Error('业务资产在计划后已改变')
    console.log(JSON.stringify(input?.compose ? renderBusinessInstance(config, input) : {
      valid: true, assetRoot: config.assetRoot, pluginRoot: config.pluginRoot,
      ...(input?.sourcePaths ? { sourceDigest: businessSourceDigest(input.sourcePaths) } : {}),
    }))
  } catch { console.error('业务启动配置或受控 Compose 无效，请核对路径、已构建插件和可达协调器'); process.exitCode = 1 }
}
