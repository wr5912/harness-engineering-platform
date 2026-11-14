import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { networkInterfaces } from 'node:os'
import { dump, load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { configPath, configuredServers, readEnvironment, readStandaloneConfig, runtimeRoot, validateStandaloneConfig, writeStandaloneConfig, type StandaloneConfig } from './config.ts'
import { harnessMcpConnections, migrateStandaloneConnections } from './connections.ts'
import { projectStandaloneBoundary } from '../../../deploy/agent/runtime/projections.mts'
import { parseHarnessRuntime, projectHarnessPresets } from '../models/harness-runtime.ts'
import { redactRunText } from '../agents/run-files.ts'

const patchSchema = DEFAULT_SCHEMA.extend(new (Type as any)('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value: string) => ({ __dshExpression: value }), represent: (value: any) => value.__dshExpression, predicate: (value: any) => Boolean(value && typeof value === 'object' && typeof value.__dshExpression === 'string') }))
const forbidden = /(?:harness-platform|harness-business-runtime|harness-model-runtime|business-runtime\.js|platform-mcp-manager|business\/mcp-manager|\/business-control\/)/

/** 仅投影装载边界；保留业务 Preset 与工具配置，移除平台服务，不修改冻结资产。 */
export function projectManagedPatch(text: string): any[] {
  const rows = load(text, { schema: patchSchema }) as any[]
  if (!Array.isArray(rows)) throw new Error('业务 Profile Patch 必须是数组')
  function project(row: any): any {
    if (!row || typeof row !== 'object') throw new Error('业务 Profile 条目无效')
    if (/^(?:agent-default-model|llm-deepseek|llm-deepseek-account|llm-pi-ai)$/.test(row.id || '') || forbidden.test(`${row.id || ''} ${row.name || ''}`) || row.id === 'mcp-session-manager' || /mcp-manager\.(?:m?js|ts)$/.test(row.name || '')) return undefined
    const value = { ...row }
    if (value.insert) { value.insert = value.insert.map(project).filter(Boolean); if (!value.insert.length && Object.keys(value).length === 1) return undefined }
    return value
  }
  return rows.map(project).filter(Boolean)
}
function nativeRoot(root: string) { return existsSync(join(root, 'harness/harness.yaml')) ? join(root, 'harness') : join(root, 'assets') }
function nativeDsh(root: string, name: string) { return join(nativeRoot(root), existsSync(join(root, 'harness/harness.yaml')) ? 'dsh' : '', name) }
function runtimeDirectory(root: string) { return process.env.STANDALONE_RUNTIME || join(root, 'runtime') }
function seedDirectory(root: string) { return join(root, existsSync(join(root, 'config/seed')) ? 'config/seed' : 'config-seed') }

/** 只在 HOME 生成装载投影，原生 Harness 保持只读。 */
function prepareNativeAssets(root: string, home: string) {
  if (!existsSync(join(root, 'harness/harness.yaml'))) return
  const managed = join(home, 'standalone/managed'), presets = join(home, 'standalone/presets')
  function project(source: string, target: string) {
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(target)) rmSync(join(target, name), { recursive: true, force: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const from = join(source, entry.name), to = join(target, entry.name)
      if (entry.isDirectory()) project(from, to)
      else if (entry.isFile()) {
        const result = /\.[mc]?js$/.test(entry.name) ? projectStandaloneBoundary(readFileSync(from, 'utf8'), root) : undefined
        if (result?.changed) write(to, result.content)
        else symlinkSync(from, to)
      }
    }
  }
  project(nativeDsh(root, 'managed'), managed)
  symlinkSync(join(home, 'profiles/node_modules'), join(managed, 'node_modules'), 'dir')
  const contract = parseHarnessRuntime(readFileSync(join(nativeRoot(root), 'harness.yaml'), 'utf8'))
  if (contract) {
    const prepared = join(home, 'standalone/.preset-build')
    rmSync(prepared, { recursive: true, force: true })
    projectHarnessPresets(nativeRoot(root), prepared, contract)
    mkdirSync(presets, { recursive: true })
    for (const name of readdirSync(presets)) rmSync(join(presets, name), { recursive: true, force: true })
    cpSync(prepared, presets, { recursive: true })
    rmSync(prepared, { recursive: true, force: true })
  } else project(nativeDsh(root, 'presets'), presets)
}
function sharedRuntimePackages(home: string, runtime: string) {
  const file = join(runtime, 'dependencies/package.json')
  if (!existsSync(file)) return
  const modules = join(home, 'profiles/node_modules')
  for (const name of Object.keys(JSON.parse(readFileSync(file, 'utf8')).dependencies || {})) {
    const target = join(modules, name)
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    symlinkSync(join(runtime, 'dependencies/node_modules', name), target, 'dir')
  }
}
function prepareSdkExample(root: string, home: string) {
  const app = join(home, 'standalone/sdk-app')
  mkdirSync(app, { recursive: true })
  cpSync(join(nativeRoot(root) === join(root, 'assets') ? root : nativeRoot(root), 'sdk/example.ts'), join(app, 'example.ts'))
  write(join(app, 'package.json'), JSON.stringify({ private: true, type: 'module', peerDependencies: { '@deepseek-ai/dsh-sdk-client': '*' } }) + '\n')
  if (!existsSync(join(app, 'node_modules'))) symlinkSync(join(home, 'profiles/node_modules'), join(app, 'node_modules'), 'dir')
}
function write(path: string, content: string, mode = 0o600) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode }) }
function nativeFallback(home: string, installAnchor: string, sharedPackages: string[] = []) {
  const require = createRequire(installAnchor)
  const pending = [installAnchor], seen = new Set<string>(), modules = join(home, 'profiles/node_modules')
  for (const name of sharedPackages) {
    const manifest = (require.resolve.paths(name) || []).map(directory => join(directory, name, 'package.json')).find(existsSync)
    if (!manifest) throw new Error(`当前标准镜像缺少官方共享模块 ${name}`)
    pending.push(manifest)
  }
  mkdirSync(modules, { recursive: true })
  while (pending.length) {
    const manifest = pending.shift()!, directory = dirname(manifest), pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (seen.has(pkg.name)) continue
    seen.add(pkg.name)
    const link = join(modules, pkg.name)
    mkdirSync(dirname(link), { recursive: true })
    if (!existsSync(link)) symlinkSync(directory, link, 'dir')
    for (const name of [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})]) {
      for (const candidate of createRequire(manifest).resolve.paths(name) || []) {
        const file = join(candidate, name, 'package.json')
        if (existsSync(file)) { pending.push(file); break }
      }
    }
  }
  return require
}
export function generateProfile(config: StandaloneConfig, home: string, root: string, updateModel = true) {
  const harnessFile = join(nativeRoot(root), 'harness.yaml')
  const access = existsSync(harnessFile) ? (load(readFileSync(harnessFile, 'utf8')) as any)?.standalone?.web?.access : undefined
  if (config.profile !== 'sdk' && access !== undefined && access !== 'anonymous-lan') throw new Error('Harness standalone.web.access 只支持 anonymous-lan')
  const managed = join(nativeDsh(root, 'managed'), config.profilePatch)
  const business = projectManagedPatch(readFileSync(managed, 'utf8'))
  const sdk = config.profile === 'sdk'
  const connection = join(home, 'standalone/connection')
  if (!sdk) {
    // 只替换 Host 认证适配；浏览器继续装载同镜像原生连接及其完整依赖声明。
    const require = createRequire(join(home, 'profiles/standalone/package.json'))
    const manifest = require.resolve('@deepseek-ai/dsh-client-connection/package.json')
    const native = JSON.parse(readFileSync(manifest, 'utf8'))
    const client = native.exports['./client']
    write(join(connection, 'package.json'), JSON.stringify({ name: native.name, private: true, type: 'module', exports: { '.': './index.mjs', './client': './client.browser.js' }, dsh: { client: native.dsh.client } }) + '\n')
    write(join(connection, 'index.mjs'), `export * from ${JSON.stringify(pathToFileURL(join(runtimeDirectory(root), 'standalone-connection.js')).href)};\n`)
    if (!existsSync(join(connection, 'client.browser.js'))) symlinkSync(join(dirname(manifest), typeof client === 'string' ? client : client.default), join(connection, 'client.browser.js'))
  }
  const sdkBase = sdk ? load(readFileSync(join(runtimeDirectory(root), 'sdk-profile.patch.yml'), 'utf8'), { schema: patchSchema }) as any[] : []
  const runtimePatch = [
    { id: 'agent-preset-registry', config: { default: config.presetId } },
    { insert: [
      { id: 'legacy-prompt-variables', name: join(runtimeDirectory(root), 'runtime-compat/index.ts') },
      { id: 'standalone-agent', name: join(runtimeDirectory(root), 'standalone-plugin.js'), config: { home, root } },
      ...(sdk ? [
        // 仅为原生客户端插件提供 Host 服务，不装载组合执行器。
        { id: 'standalone-mcp-server', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
        { id: 'standalone-connection', name: '@deepseek-ai/dsh-client-connection' },
        { id: 'standalone-workspace', name: '@deepseek-ai/dsh-workspace' },
        { id: 'standalone-settings', name: '@deepseek-ai/dsh-api-settings-controller' },
        { id: 'harness-sdk-preset', name: join(runtimeDirectory(root), 'sdk-preset.mts'), config: { presetId: config.presetId } },
      ] : [
        { id: 'connection', name: join(connection, 'index.mjs'), disabled: false, inject: ['webStartup'], config: { trustedHosts: { __dshExpression: 'ctx.webStartup.trustedHosts' } } },
        { id: 'webserver', name: join(runtimeDirectory(root), 'web/container-webserver.mjs'), disabled: false, inject: ['webStartup'], config: { host: { __dshExpression: "ctx.webStartup.host ?? '127.0.0.1'" }, port: { __dshExpression: 'ctx.webStartup.port ?? 3080' } } },
        { id: 'web-runtime', name: join(runtimeDirectory(root), 'web/container-web-app.mjs'), disabled: false, inject: ['webStartup'], config: {
          openBrowser: false, printUrl: false, surfaceContext: true,
          publicUrl: { __dshExpression: 'ctx.webStartup.publicUrl' },
        } },
      ]),
    ] },
  ]
  if ((config.offlineKnowledge as any)?.indexPath) runtimePatch.push(
    { insert: [{ id: 'harness-offline-knowledge', name: join(runtimeDirectory(root), 'standalone-knowledge.js'), config: config.offlineKnowledge }] } as any,
    { id: 'web', config: { fetchProvider: 'harness-offline-knowledge' } } as any,
  )
  write(join(home, 'standalone/runtime.patch.yml'), dump([...sdkBase, ...business, ...runtimePatch], { schema: patchSchema, noRefs: true, lineWidth: -1 } as any))
  write(join(home, 'profiles/standalone/package.json'), JSON.stringify({ name: 'standalone-agent-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', sdk ? '@deepseek-ai/dsh-sdk-app' : '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } } }, null, 2) + '\n')
  // 此处是当前原生模型设置；只在 seed 初始化或 configure 时生成，普通重启不重写。
  if (updateModel) write(join(home, 'profiles/standalone/cordis.patch.yml'), dump(config.modelPatch, { schema: patchSchema, noRefs: true, lineWidth: -1 } as any))
}
export function initializeStandalone({ root = runtimeRoot(), home = process.env.DSH_HOME || '/var/lib/dsh', installAnchor = '/opt/dsh/apps/cli/package.json' } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  prepareNativeAssets(root, home)
  if (existsSync(join(home, 'standalone/initialized.json'))) {
    nativeFallback(home, installAnchor, readStandaloneConfig(home).profile === 'sdk' ? ['@deepseek-ai/dsh-sdk-client'] : [])
    sharedRuntimePackages(home, runtimeDirectory(root))
    const previous = JSON.parse(readFileSync(configPath(home), 'utf8'))
    const current = migrateStandaloneConnections(previous, nativeDsh(root, 'managed'))
    if (current !== previous) writeStandaloneConfig(validateStandaloneConfig(current), home)
    if (current.profile === 'sdk') prepareSdkExample(root, home)
    generateProfile(readStandaloneConfig(home), home, root, false)
    return { initialized: false }
  }
  const initial = validateStandaloneConfig(migrateStandaloneConnections(JSON.parse(readFileSync(join(seedDirectory(root), 'standalone.json'), 'utf8')), nativeDsh(root, 'managed')))
  const seed = existsSync(configPath(home)) ? readStandaloneConfig(home) : initial
  const modelFile = join(home, 'profiles/standalone/cordis.patch.yml')
  seed.modelPatch = existsSync(modelFile) ? load(readFileSync(modelFile, 'utf8'), { schema: patchSchema }) as unknown[] : initial.modelPatch
  const native = harnessMcpConnections(nativeDsh(root, 'managed'), seed.profilePatch)
  for (const server of native.servers) {
    if (!seed.mcp.servers.some(current => current.id === server.id)) seed.mcp.servers.push(server)
  }
  nativeFallback(home, installAnchor, seed.profile === 'sdk' ? ['@deepseek-ai/dsh-sdk-client'] : [])
  sharedRuntimePackages(home, runtimeDirectory(root))
  writeStandaloneConfig(seed, home)
  const secret = join(seedDirectory(root), 'environment.llm-api-key')
  if (!existsSync(join(home, 'standalone/environment.llm-api-key'))) write(join(home, 'standalone/environment.llm-api-key'), existsSync(secret) ? readFileSync(secret, 'utf8') : '{}\n')
  generateProfile(seed, home, root)
  if (seed.profile === 'sdk') {
    prepareSdkExample(root, home)
    const harness = parseHarnessRuntime(readFileSync(join(nativeRoot(root), 'harness.yaml'), 'utf8'))
    if (harness?.project_workspace) {
      const project = join(home, 'standalone/project')
      cpSync(join('/opt/harness-candidate', harness.project_workspace.path), project, { recursive: true })
      const shared = join(project, 'node_modules/@deepseek-ai/dsh-sdk-client')
      mkdirSync(dirname(shared), { recursive: true })
      if (!existsSync(shared)) symlinkSync(join(home, 'profiles/node_modules/@deepseek-ai/dsh-sdk-client'), shared, 'dir')
    }
  }
  write(join(home, 'standalone/initialized.json'), JSON.stringify({ agentId: seed.agentId, experimentId: seed.experimentId, sourceDigest: seed.sourceDigest, initializedAt: new Date().toISOString() }) + '\n')
  return { initialized: true }
}
export async function configureStandalone(file: string | Record<string, unknown>, { root = runtimeRoot(), home = process.env.DSH_HOME || '/var/lib/dsh' } = {}) {
  const previous = readStandaloneConfig(home)
  const nativeModelPatch = load(readFileSync(join(home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), { schema: patchSchema })
  if (Array.isArray(nativeModelPatch)) previous.modelPatch = nativeModelPatch
  const supplied = typeof file === 'string' ? JSON.parse(readFileSync(file, 'utf8')) : file
  // 身份和资产入口来自冻结包；重配只接受模型、MCP与其凭据。
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(key => !['modelPatch', 'defaultModel', 'mcp', 'environment'].includes(key))) throw new Error('重新配置只接受 modelPatch、defaultModel、mcp 与 environment')
  const next = validateStandaloneConfig({ ...previous, ...supplied, environment: undefined })
  if (supplied.defaultModel) {
    const defaultRow = next.modelPatch.find((row: any) => row.id === 'agent-default-model') as any
    if (defaultRow) defaultRow.config = supplied.defaultModel
    else next.modelPatch.push({ id: 'agent-default-model', config: supplied.defaultModel })
  }
  // 保存前复用原始管理器的纯格式校验，不探测或等待任何外部 MCP。
  const { validateConfiguration } = await import(pathToFileURL(join(runtimeDirectory(root), 'standalone-plugin.js')).href)
  validateConfiguration({ ...next.mcp, servers: configuredServers(next) })
  if (supplied.environment) {
    if (Object.entries(supplied.environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string')) throw new Error('模型环境凭据格式无效')
    write(join(home, 'standalone/environment.llm-api-key'), JSON.stringify({ ...readEnvironment(join(home, 'standalone/environment.llm-api-key')), ...supplied.environment }) + '\n')
  }
  writeStandaloneConfig(next, home)
  generateProfile(next, home, root, supplied.modelPatch !== undefined || supplied.defaultModel !== undefined)
  return { configured: true, restartRequired: next.profile !== 'sdk' }
}
function updateMcpConnection(server: any, { url, token }: { url?: string; token?: string }) {
  if (url !== undefined) {
    let address: URL
    try { address = new URL(url) } catch { throw new Error('MCP 地址必须是 HTTP(S) URL') }
    if (!['http:', 'https:'].includes(address.protocol)) throw new Error('MCP 地址必须是 HTTP(S) URL')
    server[server.specUrl ? 'specUrl' : 'url'] = url
  }
  if (token === undefined) return
  if (/[\r\n]/.test(token)) throw new Error('MCP Token 不能包含换行')
  if (server.specUrl) { server.apiKey = token; server.authType = 'credential'; server.authHeader ||= 'Authorization' }
  else {
    server.headers = (server.headers || []).filter((header: any) => header.name.toLowerCase() !== 'authorization')
    if (token) server.headers.push({ name: 'Authorization', value: token.startsWith('Bearer ') ? token : `Bearer ${token}` })
  }
}
export async function configureMcpConnection(input: { id: string; url?: string; token?: string }, options: { root?: string; home?: string } = {}) {
  if (!input.id || input.url === undefined && input.token === undefined) throw new Error('请指定 MCP 连接 ID 及地址或 Token')
  const mcp = readStandaloneConfig(options.home).mcp
  const server = mcp.servers.find(server => server.id === input.id)
  if (!server) throw new Error('MCP 连接 ID 不存在，请核对 state/home/standalone/config.json 的 mcp.servers[].id')
  updateMcpConnection(server, input)
  return configureStandalone({ mcp }, options)
}
/** 交互入口只询问业务连接，不要求用户理解 Profile 插件 ID 或内部控制参数。 */
export async function configureInteractive({ root = runtimeRoot(), home = process.env.DSH_HOME || '/var/lib/dsh' } = {}) {
  if (!process.stdin.isTTY) throw new Error('交互配置需要终端；自动化可使用 ./agent configure --config-file <JSON>')
  const current = readStandaloneConfig(home)
  const nativePatch = load(readFileSync(join(home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), { schema: patchSchema }) as any[]
  const environment = readEnvironment(join(home, 'standalone/environment.llm-api-key'))
  let muted = false
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback() } })
  const reader = createInterface({ input: process.stdin, output, terminal: true })
  const ask = async (prompt: string, secret = false) => {
    if (secret) { process.stdout.write(prompt); muted = true }
    try { return (await reader.question(secret ? '' : prompt)).trim() }
    finally { if (secret) { muted = false; process.stdout.write('\n') } }
  }
  try {
    const defaultRow = nativePatch.find(row => row.id === 'agent-default-model')
    const selected = { ...(defaultRow?.config ?? current.defaultModel ?? {}) }
    const pi = nativePatch.find(row => row.id === 'llm-pi-ai')?.config?.providers
    const provider = selected.provider === 'deepseek-official' ? nativePatch.find(row => row.id === 'llm-deepseek')?.config : pi?.[selected.provider]
    if (provider) {
      const nextUrl = await ask(`模型服务地址（留空保留 ${typeof provider.baseURL === 'string' ? provider.baseURL : '现有地址'}）：`)
      const nextModel = await ask(`模型名称（留空保留 ${selected.model || '当前模型'}）：`)
      const nextKey = await ask('模型 API Key（留空保留，输入不显示）：', true)
      if (nextUrl) { const url = new URL(nextUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型地址必须是 HTTP(S)'); provider.baseURL = nextUrl }
      if (nextModel) {
        const previousModel = provider.models?.find((model: any) => model.id === selected.model)
        selected.model = nextModel
        if (!provider.models?.some((model: any) => model.id === nextModel)) provider.models = [...(provider.models || []), { ...(previousModel || {}), id: nextModel, name: nextModel }]
      }
      if (nextKey) { const key = provider.apiKeyEnv || 'STANDALONE_LLM_API_KEY'; provider.apiKeyEnv = key; environment[key] = nextKey }
      if (defaultRow) defaultRow.config = selected
    } else console.log(current.profile === 'sdk' ? '当前未配置 API 模型，请使用 ./agent configure --config-file <JSON> 提供模型配置。' : '当前智能体未使用可配置的 API 模型；原生 DSH 设置页面仍可新增模型。')
    const mcp = structuredClone(current.mcp)
    for (const server of mcp.servers) {
      const field = server.specUrl ? 'specUrl' : server.url ? 'url' : undefined
      if (!field) continue
      const label = server.description || server.serverName || server.id
      const address = await ask(`MCP ${label} 地址（留空保留 ${server[field]}）：`)
      const key = await ask(`MCP ${label} 凭据（留空保留，输入不显示）：`, true)
      updateMcpConnection(server, { ...(address ? { url: address } : {}), ...(key ? { token: key } : {}) })
    }
    const temporary = join(home, 'standalone/.interactive-config.llm-api-key')
    write(temporary, JSON.stringify({ modelPatch: nativePatch, mcp, environment }))
    try { return await configureStandalone(temporary, { home, root }) }
    finally { const { unlinkSync } = await import('node:fs'); unlinkSync(temporary) }
  } finally { reader.close(); output.end() }
}

export async function startStandalone({ root = runtimeRoot(), home = process.env.DSH_HOME || '/var/lib/dsh' } = {}) {
  initializeStandalone({ root, home })
  const config = readStandaloneConfig(home)
  if (config.profile === 'sdk') throw new Error('SDK 智能体由应用持有运行进程，请使用 ./agent run --input-file <JSON> 或 ./agent example')
  const environment = readEnvironment(join(home, 'standalone/environment.llm-api-key'))
  const host = Object.values(networkInterfaces()).flat().find(address => address && address.family === 'IPv4' && !address.internal)?.address
  if (!host) throw new Error('容器未取得可用于原生 DSH 的 IPv4 地址')
  const port = process.env.STANDALONE_PORT || '18500'
  const publicHost = process.env.STANDALONE_HOST || '127.0.0.1'
  const publicUrl = `http://${publicHost}:${port}/assistant/`
  const child = spawn(process.execPath, ['--expose-internals', '/opt/dsh/apps/cli/lib/bin.js', '--profile', 'standalone', '--patch', join(home, 'standalone/runtime.patch.yml'), '--host', host, '--port', '3080', '--public-url', publicUrl, '--trusted-host', `${publicHost}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, '--no-open'], { cwd: '/work/harness/workspace', env: { ...process.env, ...environment, HOME: home, DSH_HOME: home, ...(config.offlineKnowledge ? { DSH_WEB_FETCH_PROVIDER: 'harness-offline-knowledge' } : {}) }, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
  return code
}

/** 生成调用选项；模型仍以原生 Profile 为当前事实源，凭据不写入此文件。 */
export function prepareStandaloneSdk({ root = runtimeRoot(), home = process.env.DSH_HOME || '/var/lib/dsh' } = {}) {
  const config = readStandaloneConfig(home)
  if (config.profile !== 'sdk') throw new Error('当前运行包不是 SDK 型智能体')
  const harness = parseHarnessRuntime(readFileSync(join(nativeRoot(root), 'harness.yaml'), 'utf8'))
  const modelPatch = load(readFileSync(join(home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), { schema: patchSchema }) as any[]
  const selected = harness?.model_bindings?.main ?? modelPatch.find(row => row?.id === 'agent-default-model')?.config
  if (!selected || typeof selected.provider !== 'string' || typeof selected.model !== 'string') throw new Error('尚未配置 SDK 调用模型，请运行 ./agent configure --config-file <JSON>')
  const options = { profile: 'standalone', dshHome: home, dshBin: '/opt/dsh/apps/cli/lib/bin.js',
    cwd: harness?.project_workspace ? join(home, 'standalone/project') : '/work/harness/workspace',
    patches: [join(home, 'standalone/runtime.patch.yml')], provider: selected.provider, model: selected.model,
    ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) }
  write(join(home, 'standalone/sdk-options.json'), JSON.stringify(options, null, 2) + '\n')
  return options
}

export async function runStandaloneSdk(inputFile: string, exampleInput?: string, options: { root?: string; home?: string } = {}) {
  const root = options.root ?? runtimeRoot(), home = options.home ?? process.env.DSH_HOME ?? '/var/lib/dsh'
  prepareStandaloneSdk({ root, home })
  const environment = readEnvironment(join(home, 'standalone/environment.llm-api-key'))
  const args = exampleInput === undefined ? [join(runtimeDirectory(root), 'sdk-runner.mts'), join(home, 'standalone/sdk-options.json'), inputFile]
    : [join(home, 'standalone/sdk-app/example.ts'), exampleInput]
  const child = spawn(process.execPath, args, { env: { ...process.env, ...environment, HOME: home, DSH_HOME: home, HARNESS_SDK_OPTIONS: join(home, 'standalone/sdk-options.json'), ...(readStandaloneConfig(home).offlineKnowledge ? { DSH_WEB_FETCH_PROVIDER: 'harness-offline-knowledge' } : {}) }, stdio: ['inherit', 'pipe', 'pipe'] })
  const secrets = Object.entries(environment).filter(([key, value]) => /key|token|password|secret|cookie/i.test(key) && value).map(([, value]) => value)
  const forward = async (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => {
    const reader = createInterface({ input })
    for await (const line of reader) {
      let safe = redactRunText(line)
      for (const secret of secrets) safe = safe.replaceAll(secret, '[REDACTED]')
      try { safe = JSON.stringify(JSON.parse(safe)) } catch { /* 普通诊断保留文本格式。 */ }
      output.write(safe + '\n')
    }
  }
  const forwarded = [forward(child.stdout!, process.stdout), forward(child.stderr!, process.stderr)]
  const stop = (signal: NodeJS.Signals) => child.kill(signal)
  const int = () => stop('SIGINT'), term = () => stop('SIGTERM')
  process.on('SIGINT', int); process.on('SIGTERM', term)
  try {
    const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
    await Promise.all(forwarded)
    return code
  }
  finally { process.removeListener('SIGINT', int); process.removeListener('SIGTERM', term) }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const action = process.argv[2] || 'start'
    if (action === 'init') console.log(JSON.stringify(initializeStandalone()))
    else if (action === 'configure') console.log(JSON.stringify(process.argv[3] ? await configureStandalone(process.argv[3]) : await configureInteractive()))
    else if (action === 'configure-mcp') {
      // Token 仅经 stdin 传入，不进入 Docker 参数、环境或回执。
      const fields = readFileSync(0, 'utf8').split('\0')
      if (![3, 4].includes(fields.length) || fields.at(-1) !== '') throw new Error('MCP 参数格式无效')
      console.log(JSON.stringify(await configureMcpConnection({ id: fields[0], ...(fields[1] ? { url: fields[1] } : {}), ...(fields.length === 4 ? { token: fields[2] } : {}) })))
    }
    else if (action === 'start') process.exitCode = await startStandalone()
    else if (action === 'sdk-prepare') { prepareStandaloneSdk(); console.log(JSON.stringify({ prepared: true })) }
    else if (action === 'sdk-run') process.exitCode = await runStandaloneSdk(process.argv[3] || join(process.env.DSH_HOME || '/var/lib/dsh', 'standalone/input.json'))
    else if (action === 'sdk-example') process.exitCode = await runStandaloneSdk('', process.argv[3] || '请介绍你的职责。')
    else throw new Error('未知独立运行命令')
  } catch (error) { console.error(error instanceof Error ? error.message : '独立智能体启动失败'); process.exitCode = 1 }
}
