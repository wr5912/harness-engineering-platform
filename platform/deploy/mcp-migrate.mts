import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { managedState, ownsPort, restoreManagedProcess } from '../lifecycle.mts'
import { readUpdateActivity } from './update.mts'
import { readCompositions, compositionConfig } from '../plugin/src/mcp/compositions.ts'
import { workspaceIdentity } from '../plugin/src/workspace.ts'
import { platformAddressArgs } from '../plugin/src/business-control/runtime-address.ts'

type Options = { programRoot: string; dataRoot: string; dryRun?: boolean }
type Move = { from: string; to: string }
type Write = { path: string; body: string }
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
function files(root: string): string[] {
  if (!existsSync(root)) return []
  if (lstatSync(root).isSymbolicLink()) return [root]
  return lstatSync(root).isDirectory() ? readdirSync(root).sort().flatMap(name => files(join(root, name))) : [root]
}
const fingerprint = (path: string) => createHash('sha256').update(lstatSync(path).isSymbolicLink() ? 'link:' + readlinkSync(path) : readFileSync(path)).digest('hex')

/** 规划只读；定义、私有凭据和运行记录原样迁移，既有固定版本不重写。 */
export function planMcpMigration(dataRoot: string) {
  const root = resolve(dataRoot), moves: Move[] = [], writes: Write[] = []
  if (existsSync(join(root, 'mcp/manager.json'))) {
    if (existsSync(join(root, 'config/mcp-manager.json')) || existsSync(join(root, 'config/mcp-compositions.json'))) throw new Error('MCP 新旧配置并存，保留两侧数据，请先核对冲突')
    return { root, moves, writes, complete: true, sources: [] as { path: string; digest: string }[] }
  }
  const move = (from: string, to: string) => { if (existsSync(join(root, from))) moves.push({ from, to }) }
  const write = (path: string, value: any) => writes.push({ path, body: typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n' })
  if (!existsSync(join(root, 'config/mcp-manager.json'))) throw new Error('缺少原 MCP 配置，未迁移')
  move('config/mcp-manager.json', 'mcp/manager.json')
  const { catalog } = readCompositions(join(root, 'config/mcp-compositions.json'))
  const manager = json(join(root, 'config/mcp-manager.json'))
  for (const [suffix, title, connections] of [
    ['status', '状态检查', { master: 'ai-soc-master' }], ['baseline', '基线检查', { master: 'ai-soc-master', ingest: 'ai-soc-ingest' }],
    ['vulnerabilities', '漏洞检查', { master: 'ai-soc-master' }], ['reachability', '可达性检查', { master: 'ai-soc-master', graph: 'ai-soc-graph' }],
  ] as const) {
    if (Object.values(connections).some(id => !manager.servers.some((server: any) => server.id === id))) throw new Error('巡检所需 SOC 连接尚未登记，未迁移')
    const id = `inspection-${suffix}`
    if (catalog.compositions.some(entry => entry.id === id)) throw new Error(`组合 ID 冲突：${id}`)
    catalog.compositions.push({ id, draft: compositionConfig({ kind: 'workflow', workflow: id, toolName: `inspection_${suffix}`, title,
      description: `${title}：按明确资产范围读取 SOC 事实并生成报告；未知和缺失不代表正常。`, connections }) })
  }
  for (const entry of catalog.compositions) write(`mcp/compositions/${entry.id}/composition.json`, entry)
  write('mcp/compositions.json', { schema_version: '2.0', compositions: catalog.compositions.map(entry => ({ id: entry.id, path: `compositions/${entry.id}/composition.json` })) })
  // 旧总文件保留在本次恢复目录，不再充当可编辑来源。
  move('config/mcp-compositions.json', 'mcp/.local/migration-originals/compositions.json')
  move('.local/credentials/mcp-manager', 'mcp/.local/credentials')
  if (!existsSync(join(root, '.local/credentials/mcp-manager/credentials.json'))) throw new Error('缺少当前 MCP 凭据目录，保留旧文件，请先恢复专用凭据来源')
  move('.local/mcp-composition-executions', 'mcp/.local/executions')
  move('.local/artifacts/security-operations/runs', 'mcp/.local/runs')
  move('.local/artifacts/security-operations/source', 'mcp/.local/cache/source')
  move('.local/state/mcp-connections.json', 'mcp/.local/state/mcp-connections.json')
  move('.local/build-cache/security-operations', 'mcp/.local/build-cache/legacy')
  const extension = 'extensions/security-operations'
  for (const file of files(join(root, extension, 'src'))) {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`业务源码不能是链接：${file}`)
    const part = relative(join(root, extension, 'src'), file)
    if (part === 'index.ts') continue
    move(`${extension}/src/${part}`, part === 'asset-alerts.ts' ? 'mcp/compositions/security-asset-related-alerts-readonly/src/index.ts' : `mcp/.local/migration-originals/extension/src/${part}`)
  }
  for (const part of ['src/index.ts', 'build.mjs', 'package.json']) move(`${extension}/${part}`, `mcp/.local/migration-originals/extension/${part}`)
  const workspace = json(join(root, 'workspace.json'))
  const registration = workspace.extensions?.find((item: any) => item.id === 'security-operations-compositions')
  if (registration?.path !== extension) throw new Error('当前业务扩展来源不符，未迁移')
  registration.path = 'mcp'; write('workspace.json', workspace)
  const destinations = new Set<string>()
  for (const item of moves) {
    if (destinations.has(item.to) || existsSync(join(root, item.to))) throw new Error(`迁移目标冲突，保留两侧数据：${item.to}`)
    destinations.add(item.to)
  }
  for (const item of writes) if (existsSync(join(root, item.path)) && !destinations.has(item.path) && item.path !== 'workspace.json') throw new Error(`迁移目标已有数据：${item.path}`)
  const sources = [...new Set([...moves.flatMap(item => files(join(root, item.from))), join(root, 'workspace.json')])]
    .map(path => ({ path, digest: fingerprint(path) }))
  return { root, moves, writes, complete: false, sources }
}

/** 事务回调失败时恢复全部来源与旧引用；用于真实激活及失败恢复测试。 */
export async function applyMcpMigration(plan: ReturnType<typeof planMcpMigration>, activate: () => Promise<void> = async () => {}) {
  if (plan.complete) return
  for (const source of plan.sources) if (!existsSync(source.path) || fingerprint(source.path) !== source.digest) throw new Error('迁移来源已变化，请重新规划，未覆盖并行修改')
  const destinations = new Set(plan.moves.map(item => item.to))
  for (const path of [...destinations, ...plan.writes.filter(item => item.path !== 'workspace.json' && !destinations.has(item.path)).map(item => item.path)]) {
    if (existsSync(join(plan.root, path))) throw new Error(`迁移目标已有数据：${path}`)
  }
  const directory = join(plan.root, '.local/mcp-migrations', randomUUID())
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const undo: (() => void)[] = []
  const backup = (path: string) => {
    const full = join(plan.root, path), saved = join(directory, path)
    let link: string | undefined
    try { if (lstatSync(full).isSymbolicLink()) link = readlinkSync(full) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
    if (link !== undefined) {
      mkdirSync(dirname(saved), { recursive: true }); symlinkSync(link, saved)
      undo.push(() => { rmSync(full, { force: true }); symlinkSync(link!, full) })
      return
    }
    if (existsSync(full) || (() => { try { return lstatSync(full).isSymbolicLink() } catch { return false } })()) {
      mkdirSync(dirname(saved), { recursive: true }); cpSync(full, saved, { dereference: false })
      undo.push(() => { rmSync(full, { recursive: true, force: true }); mkdirSync(dirname(full), { recursive: true }); cpSync(saved, full, { dereference: false }) })
    } else undo.push(() => rmSync(full, { recursive: true, force: true }))
  }
  try {
    for (const item of plan.moves) {
      const source = join(plan.root, item.from), target = join(plan.root, item.to)
      mkdirSync(dirname(target), { recursive: true }); renameSync(source, target)
      undo.push(() => { mkdirSync(dirname(source), { recursive: true }); renameSync(target, source) })
    }
    for (const item of plan.writes) { backup(item.path); mkdirSync(dirname(join(plan.root, item.path)), { recursive: true }); writeFileSync(join(plan.root, item.path), item.body) }
    for (const [legacy, target] of [['.local/credentials/mcp-manager.json', 'credentials.json'], ['.local/credentials/mcp-manager.lock', 'credentials.lock']]) {
      backup(legacy); const path = join(plan.root, legacy); rmSync(path, { force: true }); symlinkSync(relative(dirname(path), join(plan.root, 'mcp/.local/credentials', target)), path)
    }
    await activate()
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify({ status: 'applied', paths: [...plan.moves.map(item => item.to), ...plan.writes.map(item => item.path)] }, null, 2))
    return directory
  } catch (error) {
    const failures: string[] = []
    for (const restore of undo.reverse()) try { restore() } catch (failure: any) { failures.push(failure.message) }
    if (failures.length) throw new Error(`迁移失败且恢复未完成，恢复目录：${directory}；${failures.join('；')}`, { cause: error })
    throw error
  }
}

export async function migrateMcp(input: Options) {
  const options = { ...input, programRoot: resolve(input.programRoot), dataRoot: resolve(input.dataRoot) }, plan = planMcpMigration(options.dataRoot)
  if (plan.complete) return { status: 'unchanged', paths: [] }
  const state = managedState(options.dataRoot, options.programRoot)
  if (state && !ownsPort(state.pid, state.host, state.port)) throw new Error('平台进程与监听不符，未迁移')
  const busy = state ? await readUpdateActivity(options, state, workspaceIdentity(options.dataRoot).id) : []
  if (busy.length || options.dryRun) return { status: busy.length ? 'busy' : 'planned', busy, paths: [...plan.moves.map(item => item.to), ...plan.writes.map(item => item.path)] }
  const lock = join(options.dataRoot, '.local/mcp-migration.lock')
  const environment = state ? Object.fromEntries(readFileSync(`/proc/${state.pid}/environ`, 'utf8').split('\0').filter(Boolean).map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)])) : { ...process.env, HARNESS_ASSET_ROOT: options.dataRoot, HARNESS_PROGRAM_ROOT: options.programRoot }
  const original = state ? [readlinkSync(`/proc/${state.pid}/exe`), ...readFileSync(`/proc/${state.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(1)] : []
  function command(args: string[]) {
    const result = spawnSync(join(options.programRoot, 'platform/dsh-platform'), args, { cwd: options.programRoot, env: environment, encoding: 'utf8', timeout: 300_000 })
    if (result.status !== 0) throw new Error(`迁移激活失败：${args[0]}（退出状态 ${result.status ?? '超时'}）`)
  }
  const recovery = join(options.dataRoot, '.local/mcp-migrations/runtime-' + randomUUID())
  const artifacts = [join(options.programRoot, 'platform/plugin/lib'), join(options.dataRoot, '.local/platform-home/profiles/harness-platform')]
  let stopped = !state
  mkdirSync(lock)
  try {
    if (state) { command(['stop']); stopped = true }
    for (const path of ['config/mcp-compositions.json.lock', 'config/mcp-manager.json.lock', '.local/credentials/mcp-manager/credentials.lock']) if (existsSync(join(options.dataRoot, path))) throw new Error('MCP 数据正在保存，未迁移')
    mkdirSync(recovery, { recursive: true, mode: 0o700 })
    for (const [index, path] of artifacts.entries()) if (existsSync(path)) cpSync(path, join(recovery, String(index)), { recursive: true, dereference: false })
    const receipt = await applyMcpMigration(plan, async () => {
      command(['prepare', '--offline'])
      if (state) {
        command(['start', ...platformAddressArgs(state)])
        const current = managedState(options.dataRoot, options.programRoot)
        if (!current) throw new Error('迁移后的平台未启动')
        await readUpdateActivity(options, current, workspaceIdentity(options.dataRoot).id)
      }
    })
    return { status: 'applied', receipt, paths: [...plan.moves.map(item => item.to), ...plan.writes.map(item => item.path)] }
  } catch (error) {
    if (!stopped) throw error
    if (managedState(options.dataRoot, options.programRoot)) command(['stop'])
    for (const [index, path] of artifacts.entries()) if (existsSync(join(recovery, String(index)))) { rmSync(path, { recursive: true, force: true }); cpSync(join(recovery, String(index)), path, { recursive: true, dereference: false }) }
    if (state) await restoreManagedProcess(state, original, environment)
    throw error
  } finally { rmSync(lock, { recursive: true, force: true }) }
}
