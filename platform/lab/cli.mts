import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctorLab, initializeLab, planUpdate, repositoryNames, statusLab, type RepositoryInput, type RepositoryKey } from './workspace.mts'

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../../..')
const VERSION = process.env.HEP_LAB_VERSION ?? (readFileSync(join(PROJECT_ROOT, 'VERSION.md'), 'utf8').match(/当前版本：`([^`]+)`/)?.[1] ?? 'unknown')
const REVISION = process.env.HEP_LAB_REVISION ?? (() => {
  try { return spawnSync('git', ['-C', PROJECT_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown' } catch { return 'unknown' }
})()

const usage = `用法：
  platform/hep-lab bootstrap --destination <目录> [--reuse] [--start]
    独立下载固定版本 CLI，按数据仓库锁定文件检出四个仓库。
  platform/hep-lab init --destination <目录> --data-repository <URL> --data-commit <SHA>
    其余三仓库默认从数据仓库 locks/repositories.yaml 推导；也可显式传入同名前缀的 URL/ref/commit。
    business-agents 是保存全部业务智能体的单个仓库。
    --check-only          只验证输入与已有目录，不 clone/fetch/写入
    --reuse               复用 origin、版本均一致且干净的仓库
    --allow-floating-ref  开发环境显式允许解析分支，清单仍记录实际 SHA
  platform/hep-lab status --lab <目录> [--json] [--request-id <id>]
  platform/hep-lab doctor --lab <目录> [--json] [--request-id <id>]
  platform/hep-lab update --lab <目录> --plan-only [--json] [--request-id <id>]
初始化保留已有目录；不自动 reset、不强制覆盖、不写入凭据。doctor 的结构与版本检查不代替启动和业务验收。`
const prefixes: Record<RepositoryKey, string> = { platform: 'platform', data: 'data', platform_manager_dsh_home: 'platform-manager-dsh-home', business_agents: 'business-agents' }
let jsonRequested = process.argv.slice(2).some(value => value === '--json' || value.startsWith('--json='))
let requestId: string | undefined
function emit(value: unknown) { process.stdout.write(JSON.stringify(value, null, 2) + '\n') }
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : '操作失败'
  const conflict = /已存在|工作树存在|不同|不一致|冲突|过期|stale/i.test(message)
  const result = { schema_version: 1, operation_id: `op_${Date.now().toString(36)}`, request_id: requestId ?? null, status: conflict ? 'failed' : 'failed', error: { code: conflict ? 'conflict' : 'invalid_input', message }, next_action: conflict ? 'status_or_reconcile' : null }
  if (jsonRequested) emit(result)
  else process.stderr.write(`hep-lab: ${message}\n`)
  process.exitCode = conflict ? 3 : 2
}
try {
  const options: Record<string, { type: 'string' | 'boolean' }> = Object.fromEntries([
    ...['help', 'version', 'check-only', 'reuse', 'allow-floating-ref', 'plan-only', 'json'].map(name => [name, { type: 'boolean' as const }]),
    ...['destination', 'lab', 'request-id', ...Object.values(prefixes).flatMap(prefix => ['repository', 'ref', 'commit'].map(suffix => `${prefix}-${suffix}`))].map(name => [name, { type: 'string' as const }]),
  ])
  const { values, positionals } = parseArgs({ options, allowPositionals: true })
  jsonRequested = values.json === true
  requestId = typeof values['request-id'] === 'string' ? values['request-id'] : undefined
  if (values.version) {
    const result = { schema_version: 1, name: 'hep-lab', version: VERSION, revision: REVISION }
    if (jsonRequested) emit(result)
    else process.stdout.write(`hep-lab ${VERSION} (${REVISION})\n`)
  } else if (values.help || !positionals.length) process.stdout.write(usage + '\n')
  else {
    if (positionals.length !== 1) throw new Error('只能指定一个 hep-lab 命令')
    const command = positionals[0]
    const initNames = ['destination', 'check-only', 'reuse', 'allow-floating-ref', 'request-id', ...Object.values(prefixes).flatMap(prefix => ['repository', 'ref', 'commit'].map(suffix => `${prefix}-${suffix}`))]
    const allowed = command === 'init' ? initNames : command === 'update' ? ['lab', 'plan-only', 'request-id'] : ['lab', 'request-id']
    for (const name of Object.keys(values)) if (!['json', ...allowed].includes(name)) throw new Error(`当前命令不支持 --${name}`)
    let result: any
    if (command === 'init') {
      if (typeof values.destination !== 'string') throw new Error('init 需要 --destination')
      const repositories = Object.fromEntries((Object.keys(repositoryNames) as RepositoryKey[]).flatMap(key => {
        const prefix = prefixes[key], url = values[`${prefix}-repository`], ref = values[`${prefix}-ref`], commit = values[`${prefix}-commit`]
        if (typeof url !== 'string') {
          if (ref !== undefined || commit !== undefined) throw new Error(`--${prefix}-ref/commit 需要同时提供 --${prefix}-repository`)
          return []
        }
        return [[key, { url, ...(ref ? { ref: String(ref) } : {}), ...(commit ? { commit: String(commit) } : {}) } as RepositoryInput]]
      })) as Partial<Record<RepositoryKey, RepositoryInput>>
      if (!repositories.data) throw new Error('init 需要 --data-repository；其余仓库可从数据仓库锁定文件推导')
      result = initializeLab({ destination: values.destination, repositories, checkOnly: values['check-only'] === true, reuse: values.reuse === true,
        allowFloatingRef: values['allow-floating-ref'] === true })
      if (result.validation && !result.validation.valid) process.exitCode = 1
    } else {
      if (typeof values.lab !== 'string') throw new Error('需要 --lab <目录>')
      if (command === 'status') result = statusLab(values.lab)
      else if (command === 'doctor') { result = doctorLab(values.lab); if (!result.valid) process.exitCode = 1 }
      else if (command === 'update') { if (values['plan-only'] !== true) throw new Error('update 当前只支持 --plan-only'); result = planUpdate(values.lab) }
      else throw new Error('未知 hep-lab 命令')
    }
    const status = result?.validation?.valid === false || result?.valid === false ? 'failed' : command === 'update' ? 'planned' : 'succeeded'
    emit({ schema_version: 1, operation_id: `op_${Date.now().toString(36)}`, request_id: requestId ?? null, status, ...result, next_action: status === 'planned' ? 'apply_or_reconcile' : null })
  }
} catch (error) {
  failure(error)
}
