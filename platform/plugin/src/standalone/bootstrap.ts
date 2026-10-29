import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { networkInterfaces } from 'node:os'
import { dump, load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { configPath, readEnvironment, readStandaloneConfig, runtimeRoot, validateStandaloneConfig, writeStandaloneConfig, type StandaloneConfig } from './config.ts'

const patchSchema = DEFAULT_SCHEMA.extend(new (Type as any)('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value: string) => ({ __dshExpression: value }), represent: (value: any) => value.__dshExpression, predicate: (value: any) => Boolean(value && typeof value === 'object' && typeof value.__dshExpression === 'string') }))
const forbidden = /(?:harness-platform|harness-business-runtime|harness-model-runtime|business-runtime\.js|platform-mcp-manager|business\/mcp-manager|\/business-control\/)/

/** 仅投影装载边界；保留业务 Preset、Guard 与工具配置，不修改冻结资产。 */
export function projectManagedPatch(text: string, groupIds: string[] = []): any[] {
  const rows = load(text, { schema: patchSchema }) as any[]
  if (!Array.isArray(rows)) throw new Error('业务 Profile Patch 必须是数组')
  function project(row: any): any {
    if (!row || typeof row !== 'object') throw new Error('业务 Profile 条目无效')
    if (/^(?:agent-default-model|llm-deepseek|llm-deepseek-account|llm-pi-ai)$/.test(row.id || '') || forbidden.test(`${row.id || ''} ${row.name || ''}`) || row.id === 'mcp-session-manager' || /mcp-manager\.(?:m?js|ts)$/.test(row.name || '')) return undefined
    const value = { ...row }
    let localGroup = false
    function projectValue(item: any): any {
      if (typeof item === 'string') {
        let url: URL
        try { url = new URL(item) } catch { return item }
        const match = /\/mcp\/groups\/([A-Za-z0-9_-]{1,32})\/v2$/.exec(url.pathname)
        if (match && groupIds.includes(match[1])) {
          localGroup = true
          const path = `/mcp/groups/${match[1]}/v2`
          return { __dshExpression: `new URL(ctx.webServer.publicPath(${JSON.stringify(path)}), ctx.webServer.getOrigin()).href` }
        }
        return item
      }
      if (Array.isArray(item)) return item.map(projectValue)
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, projectValue(entry)]))
      return item
    }
    if (value.config) value.config = projectValue(value.config)
    if (localGroup) {
      if (value.inject && !Array.isArray(value.inject)) throw new Error('业务模块依赖声明不能自动投影 MCP 地址')
      value.inject = [...new Set([...(value.inject || []), 'webServer'])]
    }
    if (value.insert) { value.insert = value.insert.map(project).filter(Boolean); if (!value.insert.length && Object.keys(value).length === 1) return undefined }
    return value
  }
  return rows.map(project).filter(Boolean)
}
function write(path: string, content: string, mode = 0o600) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, content, { mode }) }
function nativeFallback(home: string, installAnchor: string) {
  const require = createRequire(installAnchor)
  const pending = [installAnchor], seen = new Set<string>(), modules = join(home, 'profiles/node_modules')
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
  const managed = join(root, 'assets/managed', config.profilePatch)
  const business = projectManagedPatch(readFileSync(managed, 'utf8'), config.mcp.groups.map(group => group.id))
  const runtimePatch = [
    { id: 'agent-preset-registry', config: { default: config.presetId } },
    { insert: [
      { id: 'legacy-prompt-variables', name: join(root, 'runtime/runtime-compat/index.ts') },
      { id: 'standalone-agent', name: join(root, 'runtime/standalone-plugin.js'), config: { home, root } },
      { id: 'webserver', name: join(root, 'runtime/web/container-webserver.mjs'), disabled: false, inject: ['webStartup'], config: { host: { __dshExpression: "ctx.webStartup.host ?? '127.0.0.1'" }, port: { __dshExpression: 'ctx.webStartup.port ?? 3080' } } },
      { id: 'web-runtime', name: join(root, 'runtime/web/container-web-app.mjs'), disabled: false, config: { openBrowser: false, printUrl: false } },
    ] },
  ]
  if ((config.offlineKnowledge as any)?.indexPath) runtimePatch.push(
    { insert: [{ id: 'harness-offline-knowledge', name: join(root, 'runtime/standalone-knowledge.js'), config: config.offlineKnowledge }] } as any,
    { id: 'web', config: { fetchProvider: 'harness-offline-knowledge' } } as any,
  )
  write(join(home, 'standalone/runtime.patch.yml'), dump([...business, ...runtimePatch], { schema: patchSchema, noRefs: true, lineWidth: -1 } as any))
  write(join(home, 'profiles/standalone/package.json'), JSON.stringify({ name: 'standalone-agent-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } } }, null, 2) + '\n')
  // 此处是当前原生模型设置；只在 seed 初始化或 configure 时生成，普通重启不重写。
  if (updateModel) write(join(home, 'profiles/standalone/cordis.patch.yml'), dump(config.modelPatch, { schema: patchSchema, noRefs: true, lineWidth: -1 } as any))
}
export function initializeStandalone({ root = runtimeRoot(), home = process.env.DSH_HOME || '/var/lib/dsh', installAnchor = '/opt/dsh/apps/cli/package.json' } = {}) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (existsSync(join(home, 'standalone/initialized.json'))) return { initialized: false }
  const initial = validateStandaloneConfig(JSON.parse(readFileSync(join(root, 'config-seed/standalone.json'), 'utf8')))
  const seed = existsSync(configPath(home)) ? readStandaloneConfig(home) : initial
  const modelFile = join(home, 'profiles/standalone/cordis.patch.yml')
  seed.modelPatch = existsSync(modelFile) ? load(readFileSync(modelFile, 'utf8'), { schema: patchSchema }) as unknown[] : initial.modelPatch
  let declaredServers: any[] | undefined
  function collect(rows: any[]) {
    for (const row of rows) {
      if (row?.insert) collect(row.insert)
      if (row?.id === 'mcp-session-manager' || /mcp-manager\.(?:m?js|ts)$/.test(row?.name || '')) if (Array.isArray(row.config?.servers)) declaredServers = row.config.servers
    }
  }
  for (const path of [join(root, 'assets/managed/web-profile.seed.patch.yml'), join(root, 'assets/managed', seed.profilePatch)]) {
    if (!existsSync(path)) continue
    const rows = load(readFileSync(path, 'utf8'), { schema: patchSchema })
    if (Array.isArray(rows)) collect(rows)
  }
  if (declaredServers) {
    const enabled = declaredServers.filter(server => typeof server.id === 'string' && server.enabled !== false)
    seed.mcp.mountServerIds = [...new Set(enabled.map(server => server.id))]
    seed.mcp.mountOverrides = Object.fromEntries(enabled.map(server => [server.id, { ...(server.serverName ? { serverName: server.serverName } : {}), ...(server.tools ? { tools: server.tools } : {}) }]))
  }
  nativeFallback(home, installAnchor)
  writeStandaloneConfig(seed, home)
  const secret = join(root, 'config-seed/environment.llm-api-key')
  if (!existsSync(join(home, 'standalone/environment.llm-api-key'))) write(join(home, 'standalone/environment.llm-api-key'), existsSync(secret) ? readFileSync(secret, 'utf8') : '{}\n')
  generateProfile(seed, home, root)
  write(join(home, 'standalone/initialized.json'), JSON.stringify({ agentId: seed.agentId, experimentId: seed.experimentId, sourceDigest: seed.sourceDigest, initializedAt: new Date().toISOString() }) + '\n')
  return { initialized: true }
}
export async function configureStandalone(file: string, { root = runtimeRoot(), home = process.env.DSH_HOME || '/var/lib/dsh' } = {}) {
  const previous = readStandaloneConfig(home)
  const nativeModelPatch = load(readFileSync(join(home, 'profiles/standalone/cordis.patch.yml'), 'utf8'), { schema: patchSchema })
  if (Array.isArray(nativeModelPatch)) previous.modelPatch = nativeModelPatch
  const supplied = JSON.parse(readFileSync(file, 'utf8'))
  // 身份和资产入口来自冻结包；重配只接受模型、MCP与其凭据。
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.keys(supplied).some(key => !['modelPatch', 'defaultModel', 'mcp', 'environment'].includes(key))) throw new Error('重新配置只接受 modelPatch、defaultModel、mcp 与 environment')
  const next = validateStandaloneConfig({ ...previous, ...supplied, environment: undefined })
  if (supplied.defaultModel) {
    const defaultRow = next.modelPatch.find((row: any) => row.id === 'agent-default-model') as any
    if (defaultRow) defaultRow.config = supplied.defaultModel
    else next.modelPatch.push({ id: 'agent-default-model', config: supplied.defaultModel })
  }
  // 保存前复用原始管理器的纯格式校验，不探测或等待任何外部 MCP。
  const { validateConfiguration } = await import(pathToFileURL(join(root, 'runtime/standalone-plugin.js')).href)
  validateConfiguration(next.mcp)
  if (supplied.environment) {
    if (Object.entries(supplied.environment).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string')) throw new Error('模型环境凭据格式无效')
    write(join(home, 'standalone/environment.llm-api-key'), JSON.stringify({ ...readEnvironment(join(home, 'standalone/environment.llm-api-key')), ...supplied.environment }) + '\n')
  }
  writeStandaloneConfig(next, home)
  generateProfile(next, home, root, supplied.modelPatch !== undefined || supplied.defaultModel !== undefined)
  return { configured: true, restartRequired: true }
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
    } else console.log('当前智能体未使用可配置的 API 模型；原生 DSH 设置页面仍可新增模型。')
    const mcp = structuredClone(current.mcp)
    for (const server of mcp.servers) {
      const field = server.specUrl ? 'specUrl' : server.url ? 'url' : undefined
      if (!field) continue
      const label = server.description || server.serverName || server.id
      const address = await ask(`MCP ${label} 地址（留空保留 ${server[field]}）：`)
      if (address) { const url = new URL(address); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP 地址必须是 HTTP(S)'); server[field] = address }
      const key = await ask(`MCP ${label} 凭据（留空保留，输入不显示）：`, true)
      if (key) {
        if (server.specUrl) { server.apiKey = key; server.authType ||= 'credential'; server.authHeader ||= 'Authorization' }
        else {
          server.headers ||= []
          const header = server.headers.find((header: any) => header.name.toLowerCase() === 'authorization')
          if (header) header.value = key.startsWith('Bearer ') ? key : `Bearer ${key}`
          else server.headers.push({ name: 'Authorization', value: key.startsWith('Bearer ') ? key : `Bearer ${key}` })
        }
      }
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
  const environment = readEnvironment(join(home, 'standalone/environment.llm-api-key'))
  const host = Object.values(networkInterfaces()).flat().find(address => address && address.family === 'IPv4' && !address.internal)?.address
  if (!host) throw new Error('容器未取得可用于原生 DSH 的 IPv4 地址')
  const port = process.env.STANDALONE_PORT || '18500'
  const publicHost = process.env.STANDALONE_HOST || '127.0.0.1'
  const publicUrl = `http://${publicHost}:${port}/assistant/`
  const child = spawn(process.execPath, ['--expose-internals', '/opt/dsh/apps/cli/lib/bin.js', '--profile', 'standalone', '--patch', join(home, 'standalone/runtime.patch.yml'), '--host', host, '--port', '3080', '--public-url', publicUrl, '--trusted-host', `${publicHost}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, '--no-open'], { cwd: '/work/harness/workspace', env: { ...process.env, ...environment, DSH_HOME: home, ...(config.offlineKnowledge ? { DSH_WEB_FETCH_PROVIDER: 'harness-offline-knowledge' } : {}) }, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
  return code
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const action = process.argv[2] || 'start'
    if (action === 'init') console.log(JSON.stringify(initializeStandalone()))
    else if (action === 'configure') console.log(JSON.stringify(process.argv[3] ? await configureStandalone(process.argv[3]) : await configureInteractive()))
    else if (action === 'start') process.exitCode = await startStandalone()
    else throw new Error('未知独立运行命令')
  } catch (error) { console.error(error instanceof Error ? error.message : '独立智能体启动失败'); process.exitCode = 1 }
}
