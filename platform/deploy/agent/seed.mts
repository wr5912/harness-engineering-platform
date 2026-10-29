import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { AgentSeed, AgentSourceSnapshot } from './types.mts'

/** 只读取所选业务工作区的声明环境，不求值 .env，不转发整个开发进程环境。 */
export function agentSeed(snapshot: AgentSourceSnapshot, supplied: AgentSeed = {}): AgentSeed {
  const path = join(snapshot.candidate, 'dsh/workspace/.env')
  let local: Record<string, string> = {}
  if (existsSync(path)) {
    try { local = Object.fromEntries(Object.entries(parseEnv(readFileSync(path, 'utf8'))).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }
    catch { throw new Error('业务工作区 .env 无法解析，请检查文件格式') }
  }
  const declared = Object.fromEntries((snapshot.source.optional_env_names ?? []).filter((name: string) => process.env[name] !== undefined).map((name: string) => [name, process.env[name]!]))
  const environment = { ...declared, ...local, ...(supplied.environment ?? {}) }
  if (Object.keys(environment).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) || Object.values(environment).some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('业务环境配置包含无效名称或值')
  return { ...supplied, environment }
}
