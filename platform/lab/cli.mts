import { parseArgs } from 'node:util'
import { doctorLab, initializeLab, planUpdate, repositoryNames, statusLab, type RepositoryInput, type RepositoryKey } from './workspace.mts'

const usage = `用法：
  platform/hep-lab init --destination <目录> --data-repository <URL> --data-commit <SHA>
    --platform-repository <URL> --platform-commit <SHA>
    --platform-manager-dsh-home-repository <URL> --platform-manager-dsh-home-commit <SHA>
    --business-agents-repository <URL> --business-agents-commit <SHA>
    各仓库支持同名前缀的 --<仓库>-ref；business-agents 是保存全部业务智能体的单个仓库。
    --check-only          只验证输入与已有目录，不 clone/fetch/写入
    --reuse               复用 origin、版本均一致且干净的仓库
    --allow-floating-ref  开发环境显式允许解析分支，清单仍记录实际 SHA
    --isolate-runtime    从已锁定提交创建独立管理 HOME 和业务仓库 worktree
  platform/hep-lab status --lab <目录>
  platform/hep-lab doctor --lab <目录>
  platform/hep-lab update --lab <目录> --plan-only
初始化保留已有目录；不自动 reset、不强制覆盖、不写入凭据。doctor 的结构与版本检查不代替启动和业务验收。`
const prefixes: Record<RepositoryKey, string> = { platform: 'platform', data: 'data', platform_manager_dsh_home: 'platform-manager-dsh-home', business_agents: 'business-agents' }
try {
  const options: Record<string, { type: 'string' | 'boolean' }> = Object.fromEntries([
    ...['help', 'check-only', 'reuse', 'allow-floating-ref', 'isolate-runtime', 'plan-only', 'json'].map(name => [name, { type: 'boolean' as const }]),
    ...['destination', 'lab', ...Object.values(prefixes).flatMap(prefix => ['repository', 'ref', 'commit'].map(suffix => `${prefix}-${suffix}`))].map(name => [name, { type: 'string' as const }]),
  ])
  const { values, positionals } = parseArgs({ options, allowPositionals: true })
  if (values.help || !positionals.length) process.stdout.write(usage + '\n')
  else {
    if (positionals.length !== 1) throw new Error('只能指定一个 hep-lab 命令')
    const command = positionals[0]
    const initNames = ['destination', 'check-only', 'reuse', 'allow-floating-ref', 'isolate-runtime', ...Object.values(prefixes).flatMap(prefix => ['repository', 'ref', 'commit'].map(suffix => `${prefix}-${suffix}`))]
    const allowed = command === 'init' ? initNames : command === 'update' ? ['lab', 'plan-only'] : ['lab']
    for (const name of Object.keys(values)) if (!['json', ...allowed].includes(name)) throw new Error(`当前命令不支持 --${name}`)
    let result: any
    if (command === 'init') {
      if (typeof values.destination !== 'string') throw new Error('init 需要 --destination')
      const repositories = Object.fromEntries((Object.keys(repositoryNames) as RepositoryKey[]).map(key => {
        const prefix = prefixes[key], url = values[`${prefix}-repository`], ref = values[`${prefix}-ref`], commit = values[`${prefix}-commit`]
        if (typeof url !== 'string') throw new Error(`需要 --${prefix}-repository`)
        return [key, { url, ...(ref ? { ref: String(ref) } : {}), ...(commit ? { commit: String(commit) } : {}) } as RepositoryInput]
      })) as Record<RepositoryKey, RepositoryInput>
      result = initializeLab({ destination: values.destination, repositories, checkOnly: values['check-only'] === true, reuse: values.reuse === true,
        allowFloatingRef: values['allow-floating-ref'] === true, isolateRuntime: values['isolate-runtime'] === true })
      if (result.validation && !result.validation.valid) process.exitCode = 1
    } else {
      if (typeof values.lab !== 'string') throw new Error('需要 --lab <目录>')
      if (command === 'status') result = statusLab(values.lab)
      else if (command === 'doctor') { result = doctorLab(values.lab); if (!result.valid) process.exitCode = 1 }
      else if (command === 'update') { if (values['plan-only'] !== true) throw new Error('update 当前只支持 --plan-only'); result = planUpdate(values.lab) }
      else throw new Error('未知 hep-lab 命令')
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  }
} catch (error) {
  process.stderr.write(`hep-lab: ${error instanceof Error ? error.message : '操作失败'}\n`)
  process.exitCode = 1
}
