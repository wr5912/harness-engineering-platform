import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { ModelAttemptContext } from '../evaluation/model-attempts.ts'

export type FixedCompositionBinding = {
  group_id: string; group_target_digest: string; tool_name: string
  group_link_version?: 1 | 2
  compositionId: string; versionId: string; expectedImplementationDigest: string; input_schema: Record<string, any>
}
type Client = { connect(transport: any, options?: any): Promise<any>; listTools(params?: any, options?: any): Promise<any>; callTool(params: any, options?: any): Promise<any>; close(): Promise<any> }
type ClientFactory = (url: string, token: string, signal: AbortSignal) => Promise<Client>
const executions = new AsyncLocalStorage<ModelAttemptContext>()
const GROUP_TARGET_META_KEY = 'io.deepseek.dsh/mcp-group-target'
const canonical = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)

/** 此名称须与工作流一起加入 Candidate 的原生工具路由/可见范围。 */
export function fixedCompositionToolName(name: string, binding: FixedCompositionBinding): string {
  return `hep_fixed_${createHash('sha256').update(name).update('\0').update(canonical(binding)).digest('hex').slice(0, 32)}`
}
export function withFixedCompositionExecution<T>(execution: ModelAttemptContext, task: () => T): T { return executions.run(execution, task) }

async function nativeClient(url: string, token: string, signal: AbortSignal): Promise<Client> {
  // 与当前业务 MCP 桥共用锁定 DSH 的官方 SDK，凭据来自原生管理服务。
  const require = createRequire(process.env.DSH_MCP_CLIENT_ANCHOR || '/opt/dsh/packages/mcp/mcp-client/package.json')
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client')
  const client = new Client({ name: 'harness-fixed-composition', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }), { signal })
    return client
  } catch { await client.close().catch(() => {}); throw new Error('固定组合 MCP 连接失败') }
}

function graphExecution(value: any): any {
  if (value.structuredContent?.graph_execution) return value.structuredContent.graph_execution
  for (const block of value.content ?? []) if (block.type === 'text') {
    try { const graph = JSON.parse(block.text)?.graph_execution; if (graph) return graph } catch { /* 普通工具文字不是图事实。 */ }
  }
}
function decodedResult(value: any): any {
  if (value.structuredContent) return value.structuredContent
  for (const block of value.content ?? []) if (block.type === 'text') {
    try { return JSON.parse(block.text) } catch { /* 普通文字结果不能证明实际版本。 */ }
  }
}

/** 注册固定版本的原生子工具；实际派发仍必须使用 ctx.tools.execute，保留 Guard 与取消。 */
export function registerFixedCompositionTools(ctx: any, bindings: Record<string, FixedCompositionBinding>, dependencies: { clientFactory?: ClientFactory } = {}): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const [name, supplied] of Object.entries(bindings)) {
    const binding: FixedCompositionBinding = structuredClone(supplied)
    const groupVersion = binding.group_link_version ?? 1
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(binding.group_id) || !/^[0-9a-f]{64}$/.test(binding.group_target_digest)
      || !/^[0-9a-f]{64}$/.test(binding.versionId) || !/^[0-9a-f]{64}$/.test(binding.expectedImplementationDigest)
      || typeof binding.compositionId !== 'string' || !/^[a-z0-9-]{1,80}$/.test(binding.compositionId)
      || ![1, 2].includes(groupVersion) || typeof binding.tool_name !== 'string'
      || !binding.tool_name.startsWith(groupVersion === 2 ? 'platform-compositions__' : 'mcp__compositions__')
      || !binding.input_schema || typeof binding.input_schema !== 'object') throw new Error('固定组合绑定无效')
    const alias = fixedCompositionToolName(name, binding)
    ctx.tools.register({ name: alias, description: `执行固定组合 ${name}`, parameters: binding.input_schema,
      isConcurrencySafe: () => false,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args: any, value: any) => value.content ?? [],
        presentationMeta: (_args: any, value: any) => ({ ...(graphExecution(value) ? { graph_execution: graphExecution(value) } : {}), fixed_composition: {
          composition_id: binding.compositionId, version_id: binding.versionId, implementation_digest: binding.expectedImplementationDigest } }) },
      async execute(args: Record<string, any>, exec: any) {
        exec.signal.throwIfAborted()
        if (!ctx.tools.get(name, exec.agent)) throw new Error('固定组合原工具不在当前实例范围')
        const current = () => ctx.mcpSessionManager?.currentGroup(binding.group_id, groupVersion)
        const assertGroup = () => {
          const group = current()
          if (!group?.token || group.targetDigest !== binding.group_target_digest) throw new Error('固定组合 MCP 分组已变化')
          return group
        }
        const group = assertGroup()
        let client: Client
        if (groupVersion === 2) {
          if (typeof ctx.mcpSessionManager?.listGroupTools !== 'function' || typeof ctx.mcpSessionManager?.callGroupTool !== 'function') {
            throw new Error('原生 MCP 分组 v2 服务未就绪')
          }
          client = {
            listTools: () => ctx.mcpSessionManager.listGroupTools(binding.group_id, 2),
            callTool: (params: any) => ctx.mcpSessionManager.callGroupTool(binding.group_id, 2,
              params.name, params.arguments, params._meta, exec),
            connect: async () => {}, close: async () => {},
          }
        } else {
          if (!Number.isInteger(ctx.webServer?.port) || ctx.webServer.port < 1) throw new Error('原生 MCP 分组服务未就绪')
          const path = `/mcp/groups/${binding.group_id}`
          const url = `http://127.0.0.1:${ctx.webServer.port}${ctx.webServer.publicPath?.(path) ?? path}`
          client = await (dependencies.clientFactory ?? nativeClient)(url, group.token, exec.signal)
        }
        try {
          const listed = await client.listTools(undefined, { signal: exec.signal })
          assertGroup()
          if (listed._meta?.[GROUP_TARGET_META_KEY]?.digest !== binding.group_target_digest
            || !listed.tools?.some((tool: any) => tool.name === binding.tool_name)) throw new Error('固定组合工具不属于当前 MCP 分组')
          const outer = executions.getStore()
          const execution = { execution_id: `fixed-${randomUUID()}`, ...(outer?.parent_run_id ? { parent_run_id: outer.parent_run_id } : {}),
            ...(outer?.case_id ? { case_id: outer.case_id } : {}), session_id: exec.agent?.session?.id, tool_call_id: exec.callId }
          if (!execution.session_id || !execution.tool_call_id) throw new Error('固定组合缺少原生执行身份')
          let value: any
          try {
            value = await client.callTool({ name: binding.tool_name, arguments: args,
              _meta: { harness: { compositionId: binding.compositionId, versionId: binding.versionId,
                expectedImplementationDigest: binding.expectedImplementationDigest, execution },
              [GROUP_TARGET_META_KEY]: { digest: binding.group_target_digest } } }, { signal: exec.signal, timeout: 36 * 60_000 })
          } catch {
            // 派发后丢失回执不能推成零调用，保留身份让资源比较明确阻断。
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '固定组合回执未知',
              graph_execution: { ...execution, complete: false, model_attempts: [], unknown_reasons: ['fixed-composition-receipt-missing'] } }) }] }
          }
          const actual = decodedResult(value)
          const matches = actual?.version?.versionId === binding.versionId && actual?.version?.implementationDigest === binding.expectedImplementationDigest
          let sameGroup = true
          try { assertGroup() } catch { sameGroup = false }
          // 原始MCP错误也保留图用量；调用方据isError将工作流结论置失败。
          return matches && sameGroup || value.isError ? value : { ...value, isError: true }
        } catch (error) {
          if (exec.signal.aborted) throw error
          throw new Error('固定组合执行失败，请核对版本、实现和原生 MCP 分组')
        } finally { await client.close().catch(() => {}) }
      } })
    aliases.set(name, alias)
  }
  return aliases
}
