import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { McpConfigStore } from '../mcp/store.ts'
import { assertStandaloneVersionSupported } from '../agents/version-source.ts'
import { runtimeSource } from '../agents/business-source.ts'
import { workspaceConfigPath } from '../workspace.ts'
import { bindPlatformGroupConnection, harnessMcpConnections } from '../standalone/connections.ts'

type ModelProjection = (agentId: string, selection?: { provider: string; model: string; reasoningEffort?: string }, candidatePath?: string) => Promise<{ policy: any; environment: Record<string, string> }>

/** 导出原生连接；流程、下游凭据和执行记录始终留在平台。 */
export function createDeploymentSeed(assetRoot: string, modelProjection: ModelProjection, platformGroupUrl?: (id: string) => string) {
  return async (input: { agent_id: string; experiment_id: string }, signal: AbortSignal) => {
    signal.throwIfAborted()
    const source = runtimeSource(assetRoot, input.experiment_id)
    assertStandaloneVersionSupported(source)
    if (source.agent_id !== input.agent_id) throw new Error('所选版本不属于当前智能体')
    const candidate = join(source.repository_root, source.candidate_root)
    const environment: Record<string, string> = {}
    const envFile = join(candidate, 'workspace/.env')
    if (existsSync(envFile)) Object.assign(environment, parseEnv(readFileSync(envFile, 'utf8')))
    for (const name of source.optional_env_names ?? []) if (process.env[name] !== undefined) environment[name] = process.env[name]!
    const notices: string[] = []
    let projected: Awaited<ReturnType<ModelProjection>> | undefined
    try {
      projected = await modelProjection(input.agent_id, undefined, join(candidate, '..'))
      Object.assign(environment, projected.environment)
    } catch {
      signal.throwIfAborted()
      notices.push('当前模型连接未能完整导出，可在目标环境通过 ./standalone_agent_launcher configure 配置；本地业务 Provider 仍保留。')
    }
    const mcp = harnessMcpConnections(join(candidate, 'managed'), source.patch)
    if (platformGroupUrl) mcp.servers = mcp.servers.map(server => bindPlatformGroupConnection(server, platformGroupUrl) ?? server)
    // 只提供 Harness 已声明的平台入口凭据，不复制平台连接拓扑或下游密钥。
    const platformToken = existsSync(workspaceConfigPath(assetRoot, 'mcp-manager.json'))
      ? new McpConfigStore(assetRoot, () => {}).view().value.sharedToken : ''
    for (const server of mcp.servers) {
      if (!server.url || server.enabled === false) continue
      const url = new URL(server.url)
      const group = url.pathname.match(/\/mcp\/groups\/([^/]+)(?:\/v2)?$/)?.[1]
      const current = group && platformGroupUrl ? new URL(platformGroupUrl(group)) : undefined
      if (current && url.origin === current.origin && url.pathname.replace(/\/v2$/, '') === current.pathname.replace(/\/v2$/, '')
        && platformToken && !(server.headers || []).some((header: any) => header.name.toLowerCase() === 'authorization')) {
        server.headers = [...(server.headers || []), { name: 'Authorization', value: `Bearer ${platformToken}` }]
      }
    }
    signal.throwIfAborted()
    return { seed: { agentId: input.agent_id, experimentId: input.experiment_id,
      modelPatch: projected?.policy.patch ?? [], defaultModel: projected?.policy.default, environment, mcp }, notices }
  }
}
