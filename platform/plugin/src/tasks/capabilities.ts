import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as yaml } from 'js-yaml'
import { candidateDigest, candidateFiles, sourceInfo } from './files.ts'
import { versionSource, versionSources } from '../agents/version-source.ts'

export interface CapabilityOptions {
  nativeServers?: () => any[]
  signal?: AbortSignal
  agent_id?: string
  source?: string
  server_id?: string
  discoveredTools?: (serverId: string | undefined, signal?: AbortSignal) => any[] | Promise<any[]>
  compositionBindings?: (signal?: AbortSignal) => any[] | Promise<any[]>
}

/** 动态读取当前资产及原生 MCP 配置，只报告已发现事实，不把配置等同于可用性。 */
export async function discoverTaskCapabilities(assetRoot: string, options: CapabilityOptions = {}) {
  options.signal?.throwIfAborted()
  const catalog = versionSources(assetRoot)
  const sources = []
  const unavailable = []
  for (const id of [...new Set([...Object.keys(catalog.sources), ...Object.keys(catalog.errors), ...(options.source ? [options.source.replace(/^experiment:/, '')] : [])])].sort()) {
    if (options.agent_id && (catalog.sources[id]?.agent_id ?? id.slice(4).replace(/-\d{3}(?:-r[0-9a-f]{12})?$/, '')) !== options.agent_id || options.source && options.source.replace(/^experiment:/, '') !== id) continue
    options.signal?.throwIfAborted()
    try {
      const info = sourceInfo(assetRoot, id)
      const entry = versionSource(assetRoot, id)
      const files = candidateFiles(info.candidate)
      const skills = files.filter(path => path.endsWith('/SKILL.md')).map(path => ({ path, name: path.split('/').at(-2), verification: 'discovered' as const }))
      function names(value: unknown): string[] {
        if (Array.isArray(value)) return value.flatMap(names)
        if (!value || typeof value !== 'object') return []
        const row = value as Record<string, unknown>
        return [...(typeof row.name === 'string' ? [row.name] : []), ...Object.values(row).flatMap(names)]
      }
      const plugins = files.filter(path => /(?:\.patch\.yml|\.cordis\.yml|package\.json)$/.test(path)).map(path => {
        try {
          const body = readFileSync(join(info.candidate, path), 'utf8')
          const parsed = path.endsWith('.json') ? JSON.parse(body) : yaml(body)
          return { path, name: typeof parsed?.name === 'string' ? parsed.name : path.split('/').at(-1), plugin_names: [...new Set(names(parsed))], verification: 'discovered' as const }
        } catch { return { path, name: path.split('/').at(-1), verification: 'invalid' as const } }
      })
      sources.push({ source: info.source, experiment_id: id, agent_id: info.agent_id,
        candidate_sha256: candidateDigest(info.candidate), candidate_sha256_basis: 'run-content-path-mode', skills, plugins, preset: entry.preset,
        required_env_names: entry.required_env_names ?? [] })
    } catch (error) { unavailable.push({ source: `experiment:${id}`, reason: (error as Error).message }) }
  }
  const discovered = await options.discoveredTools?.(options.server_id, options.signal) ?? []
  options.signal?.throwIfAborted()
  const bindings = await options.compositionBindings?.(options.signal) ?? []
  const mcp = (options.nativeServers?.() ?? []).filter(server => !options.server_id || server.id === options.server_id).map(server => ({
    id: String(server.id ?? ''), enabled: server.enabled !== false,
    transport: server.specUrl ? 'openapi' : String(server.transport ?? 'streamable-http'),
    tools: Array.isArray(server.tools?.names) ? server.tools.names.filter((value: unknown) => typeof value === 'string') : [],
    tool_schemas: discovered.filter(tool => tool.server_id === server.id && typeof tool.name === 'string' && tool.inputSchema && typeof tool.inputSchema === 'object').map(tool => ({
      name: tool.name, inputSchema: tool.inputSchema, ...(tool.outputSchema && typeof tool.outputSchema === 'object' ? { outputSchema: tool.outputSchema } : {}), verification: 'discovered' as const,
    })),
    verification: 'configured' as const,
  }))
  const composition_bindings = bindings.filter(binding => typeof binding.composition_id === 'string' && typeof binding.version_id === 'string' && typeof binding.tool_name === 'string').map(binding => {
    const fixed = binding.fixed_binding
    const groupVersion = fixed?.group_link_version ?? 1
    const verified = fixed && /^[A-Za-z0-9_-]{1,32}$/.test(fixed.group_id)
      && [1, 2].includes(groupVersion)
      && /^[a-f0-9]{64}$/.test(fixed.group_target_digest) && /^[a-f0-9]{64}$/.test(fixed.versionId)
      && /^[a-f0-9]{64}$/.test(fixed.expectedImplementationDigest) && /^[a-z0-9-]{1,80}$/.test(fixed.compositionId)
      && typeof fixed.tool_name === 'string'
      && (groupVersion === 2 ? fixed.tool_name === binding.tool_name && /^[A-Za-z0-9_.-]+$/.test(fixed.tool_name)
        : fixed.tool_name.startsWith('mcp__compositions__'))
      && fixed.input_schema && typeof fixed.input_schema === 'object' && !Array.isArray(fixed.input_schema)
      && fixed.compositionId === binding.composition_id && fixed.versionId === binding.version_id
      && fixed.expectedImplementationDigest === binding.source_digest
    return { composition_id: binding.composition_id, version_id: binding.version_id, tool_name: binding.tool_name,
      ...(typeof binding.source_digest === 'string' ? { source_digest: binding.source_digest } : {}),
      ...(verified ? { fixed_binding: { group_id: fixed.group_id,
        ...(fixed.group_link_version === 2 ? { group_link_version: 2 } : {}), group_target_digest: fixed.group_target_digest,
        tool_name: fixed.tool_name, compositionId: fixed.compositionId, versionId: fixed.versionId,
        expectedImplementationDigest: fixed.expectedImplementationDigest, input_schema: fixed.input_schema } } : {}),
      ...(!verified && typeof binding.fixed_binding_unavailable === 'string' ? { fixed_binding_unavailable: binding.fixed_binding_unavailable } : {}),
      verification: 'published' as const,
    }
  })
  return { observed_at: new Date().toISOString(), sources, mcp, composition_bindings, unavailable,
    note: '已发现或已配置不表示已装载、已调用或通过当前任务验证。工具接入优先使用原生 MCP 配置管理。' }
}
