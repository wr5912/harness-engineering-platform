import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

type Options = { dataRoot?: string; id?: string; json: boolean; requestId?: string }

function defaultDataRoot(): string {
  const value = process.env.HARNESS_ASSET_ROOT
  if (value) return resolve(value)
  return join(homedir(), 'harness-engineering-platform-data')
}

function parse(argv: string[]): { command: string; options: Options } {
  const command = argv[0] ?? 'help'
  const options: Options = { json: false }
  for (let index = 1; index < argv.length; index++) {
    const value = argv[index]!
    if (value === '--json') { options.json = true; continue }
    if (value === '--help' || value === '-h') { options.json = false; return { command: 'help', options } }
    if (!value.startsWith('--')) throw Object.assign(new Error(`无法识别的参数：${value}`), { code: 'invalid_argument' })
    const key = value.slice(2)
    const next = argv[++index]
    if (!next || next.startsWith('--')) throw Object.assign(new Error(`选项 --${key} 需要值`), { code: 'invalid_argument' })
    if (key === 'data-root') options.dataRoot = next
    else if (key === 'id') options.id = next
    else if (key === 'request-id') options.requestId = next
    else throw Object.assign(new Error(`不支持的选项：--${key}`), { code: 'invalid_argument' })
  }
  return { command, options }
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw Object.assign(new Error(code === 'ENOENT' ? `文件不存在：${path}` : `JSON 文件无效：${path}`), { code: code === 'ENOENT' ? 'not_found' : 'invalid_json' })
  }
}

function managerSummary(root: string) {
  const manager = readJson(join(root, 'mcp/manager.json'))
  return {
    server_ids: Array.isArray(manager.servers) ? manager.servers.map((item: any) => item?.id).filter((id: unknown): id is string => typeof id === 'string').sort() : [],
    group_ids: Array.isArray(manager.groups) ? manager.groups.map((item: any) => item?.id).filter((id: unknown): id is string => typeof id === 'string').sort() : [],
  }
}

function receipt(status: string, options: Options, value?: unknown, error?: { code: string; message: string }) {
  return { schema_version: 1, status, request_id: options.requestId ?? null, ...(status === 'succeeded' ? { value } : { error }), next_action: status === 'succeeded' ? null : 'inspect_error' }
}

function usage(jsonOutput = false) {
  const value = {
    schema_version: 1,
    name: 'hep-mcp',
    status: 'succeeded',
    usage: 'platform/hep mcp <catalog|validate|show|migrate> [选项]',
    options: ['--data-root <数据根>', '--id <组合 ID>', '--request-id <id>', '--json'],
    notes: ['catalog/validate/show 只读当前 MCP 清单和 server/group ID。', '配置保存、发布、下架和实际执行继续通过平台 GUI/RPC。', 'migrate 转发到 dsh-deploy mcp-migrate。'],
  }
  if (jsonOutput) process.stdout.write(JSON.stringify(value, null, 2) + '\n')
  else process.stdout.write(`用法：${value.usage}\n  catalog   读取当前组合清单\n  validate  重新校验组合源并输出清单\n  show      显示指定组合和平台 server/group ID\n  migrate   迁移 MCP 配置（转发 dsh-deploy）\n\n配置写入和组合执行使用平台 GUI/RPC。\n`)
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, options } = parse(argv)
  if (command === 'help') { usage(options.json); return 0 }
  const root = resolve(options.dataRoot ?? defaultDataRoot())
  if (command === 'migrate') {
    const cli = join(root, '..', 'harness-engineering-platform', 'platform', 'deploy', 'cli.mts')
    const result = spawnSync(process.execPath, [cli, 'mcp-migrate', ...(options.json ? ['--json'] : [])], { cwd: root, encoding: 'utf8', env: process.env })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    return result.status ?? 1
  }
  const manifestPath = join(root, 'mcp/current-manifest.json')
  const managerPath = join(root, 'mcp/manager.json')
  if (!existsSync(manifestPath) || !existsSync(managerPath)) throw Object.assign(new Error('当前 MCP 清单或 manager.json 不存在，请先准备数据根'), { code: 'mcp_catalog_missing' })
  if (command === 'catalog') {
    const manifest = readJson(manifestPath)
    return emit(receipt('succeeded', options, { ...manifest, manager: managerSummary(root) }), options)
  }
  if (command === 'show') {
    const manifest = readJson(manifestPath)
    const entries = Array.isArray(manifest.compositions) ? manifest.compositions : []
    if (options.id) {
      const composition = entries.find((item: any) => item?.id === options.id)
      if (!composition) throw Object.assign(new Error(`未找到组合：${options.id}`), { code: 'mcp_composition_not_found' })
      return emit(receipt('succeeded', options, { composition, manager: managerSummary(root) }), options)
    }
    return emit(receipt('succeeded', options, { summary: { registered_count: manifest.registered_count, published_count: manifest.published_count, draft_count: manifest.draft_count, unregistered_count: manifest.unregistered_count }, manager: managerSummary(root) }), options)
  }
  if (command === 'validate') {
    const script = join(root, 'mcp/validate_catalog.py')
    const result = spawnSync(process.env.HARNESS_PYTHON || 'python3', [script, '--json'], { cwd: root, encoding: 'utf8', env: process.env })
    let value: unknown
    try { value = JSON.parse(result.stdout) } catch { value = { stdout: result.stdout.trim() } }
    if (result.status !== 0) return emit(receipt('failed', options, undefined, { code: 'mcp_catalog_invalid', message: String((value as any)?.errors?.join?.('; ') ?? 'MCP 当前清单校验失败') }), options)
    return emit(receipt('succeeded', options, { ...(value as object), manager: managerSummary(root) }), options)
  }
  throw Object.assign(new Error(`未知 MCP 命令：${command}`), { code: 'unknown_command' })
}

function emit(value: unknown, options: Options): number {
  process.stdout.write(options.json ? JSON.stringify(value, null, 2) + '\n' : JSON.stringify(value.value ?? value, null, 2) + '\n')
  return 0
}

try { process.exitCode = await main() }
catch (error) {
  const code = (error as { code?: string }).code ?? 'command_failed'
  const message = error instanceof Error ? error.message : String(error)
  const output = receipt('failed', { json: true }, undefined, { code, message })
  process.stdout.write(JSON.stringify(output, null, 2) + '\n')
  process.exitCode = 1
}
