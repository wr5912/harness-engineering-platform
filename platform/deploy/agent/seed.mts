import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { harnessMcpConnections, harnessModelPatch } from '../../plugin/src/standalone/connections.ts'
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
  const { compositions: _compositions, extensions: _extensions, fixedBindings: _fixedBindings, ...client } = supplied
  const native = harnessMcpConnections(join(snapshot.candidate, 'dsh/managed'), snapshot.source.patch)
  const modelPatch = harnessModelPatch(join(snapshot.candidate, 'dsh/managed'), snapshot.source.patch)
  for (const row of supplied.modelPatch ?? []) {
    const index = modelPatch.findIndex(current => current.id && current.id === (row as any)?.id)
    if (index >= 0) modelPatch[index] = row
    else modelPatch.push(row)
  }
  if (supplied.defaultModel) {
    const index = modelPatch.findIndex(row => row.id === 'agent-default-model')
    const row = { id: 'agent-default-model', config: supplied.defaultModel }
    if (index >= 0) modelPatch[index] = row
    else modelPatch.push(row)
  }
  return { ...client, modelPatch, mcp: { ...supplied.mcp, servers: supplied.mcp?.servers ?? native.servers, groups: supplied.mcp?.groups ?? native.groups }, environment }
}
