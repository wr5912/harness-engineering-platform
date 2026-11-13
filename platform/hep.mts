import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const PLATFORM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)))
const PROJECT_ROOT = resolve(PLATFORM_ROOT, '..')

type Domain = 'workspace' | 'platform' | 'deploy' | 'agent' | 'eval' | 'instance' | 'mcp'

const domains: Record<Domain, { description: string; command: string[] }> = {
  workspace: { description: '工作区初始化、状态、诊断与更新计划', command: ['node', join(PLATFORM_ROOT, 'lab/cli.mts')] },
  platform: { description: '平台 prepare/start/stop/restart/status/autostart', command: ['node', join(PLATFORM_ROOT, 'lifecycle.mts')] },
  deploy: { description: '部署、安装、更新、迁移与独立 Agent 包', command: ['node', join(PLATFORM_ROOT, 'deploy/cli.mts')] },
  agent: { description: 'Agent 资产、版本、迁移与融合', command: ['node', '--experimental-transform-types', join(PLATFORM_ROOT, 'plugin/src/agents/cli.ts')] },
  eval: { description: '确定性评测与 DSH 评测执行器', command: [join(PROJECT_ROOT, 'runtime/adapters/dsh-container/dsh-eval')] },
  instance: { description: 'DSH 实例创建、启停、重载和状态', command: [join(PROJECT_ROOT, 'runtime/adapters/dsh-container/dsh-dev')] },
  mcp: { description: 'MCP 清单校验、组合读取与迁移；配置保存使用平台 GUI/RPC', command: ['node', join(PLATFORM_ROOT, 'mcp-cli.mts')] },
}

function json(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n') }
function usage(jsonOutput = false) {
  const value = {
    schema_version: 1,
    name: 'hep',
    status: 'succeeded',
    usage: 'platform/hep <workspace|platform|deploy|agent|eval|instance|mcp> [参数]',
    domains: Object.entries(domains).map(([id, item]) => ({ id, description: item.description })),
    contract: { json: '--json', request_id: '--request-id <id>', preview: '--dry-run/--plan-only', receipt: '下游命令的 JSON 回执原样保留' },
  }
  if (jsonOutput) json(value)
  else {
    process.stdout.write('用法：' + value.usage + '\n\n')
    for (const item of value.domains) process.stdout.write(`  ${item.id.padEnd(10)} ${item.description}\n`)
    process.stdout.write('\n所有下游命令均可传 --json；请求标识使用 --request-id。\n')
  }
}

function version(jsonOutput = false) {
  let value = 'unknown'
  try { value = readFileSync(join(PROJECT_ROOT, 'VERSION.md'), 'utf8').match(/当前版本：`([^`]+)`/)?.[1] ?? value } catch { /* source archive may omit VERSION.md */ }
  const result = { schema_version: 1, name: 'hep', version: value }
  if (jsonOutput) json(result)
  else process.stdout.write(`hep ${value}\n`)
}

const argv = process.argv.slice(2)
const jsonOutput = argv.includes('--json') || argv.some(value => value.startsWith('--json='))
try {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') { usage(jsonOutput); process.exit(0) }
  if (command === '--version' || command === '-v') { version(jsonOutput); process.exit(0) }
  if (!(command in domains)) throw Object.assign(new Error(`未知命令：${command}`), { code: 'unknown_command' })
  const spec = domains[command as Domain]
  const args = argv.slice(1)
  if (command === 'mcp' && args[0] === 'migrate') {
    spec.command = ['node', join(PLATFORM_ROOT, 'deploy/cli.mts'), 'mcp-migrate']
    args.shift()
  }
  const result = spawnSync(spec.command[0], [...spec.command.slice(1), ...args], { cwd: PROJECT_ROOT, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} catch (error) {
  const code = (error as { code?: string }).code ?? 'command_failed'
  const message = error instanceof Error ? error.message : '命令执行失败'
  if (jsonOutput) json({ schema_version: 1, name: 'hep', status: 'failed', error: { code, message }, next_action: code === 'unknown_command' ? 'help' : 'inspect_stderr' })
  else process.stderr.write(`hep: ${message}\n`)
  process.exitCode = code === 'unknown_command' ? 2 : 1
}

