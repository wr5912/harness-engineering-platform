import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import * as manager from 'harness-mcp-manager-server'
import { workspaceConfigPath } from '../workspace.ts'
import { COMPOSITION_SERVICE_ID, publishedCompositionService, readCompositions } from './compositions.ts'
import { createPublishedCompositionClient } from './index.ts'
import { createManagedMcpHandler } from './native.ts'
import { executableCatalog, type CompositionExtension } from './extension.ts'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { getBusinessControl, currentBusinessContext, withBusinessContext } from '../business-control/core.ts'
import { managedDispatch, managementDispatch } from './control.ts'
import { setBusinessReportHeaderResolver } from '../business-control/reports.ts'
import { createBusinessControlHandler } from '../business-control/management.ts'
import { loadOpenApi } from 'harness-mcp-manager-openapi'

export const { name, Config } = manager
export const inject = manager.inject
export interface ManagerConfig {
  servers: { get(): any[] }
  groups: { get(): any[] }
  dispatch?: (request: any, signal?: AbortSignal) => Promise<{ status: number; value: any }>
  compositionHandler?: ConnectionRpcHandler
  compositionExtension?: CompositionExtension
  currentGroup?: (id: string) => { id: string; targetDigest: string } | undefined
  control?: ConnectionRpcHandler
}
declare module '@deepseek-ai/cordis' {
  interface Context { platformMcp: ManagerConfig }
}
export function apply(ctx: Context, config: ManagerConfig) {
  const assetRoot = process.env.HARNESS_ASSET_ROOT
  if (!assetRoot) throw new Error('未设置 HARNESS_ASSET_ROOT')
  let dispatch: ManagerConfig['dispatch']
  const compositionExtension: CompositionExtension = {}
  const compositionHandler = createManagedMcpHandler(assetRoot, () => config.servers.get(), { extension: compositionExtension })
  const platformClient = createPublishedCompositionClient(assetRoot, compositionHandler)
  const control = getBusinessControl(assetRoot)
  const execute = managedDispatch(assetRoot)
  ctx.effect(() => setBusinessReportHeaderResolver(assetRoot, async (serverId, expectedOrigin) => {
    const server = config.servers.get().find(value => value.id === serverId && value.enabled !== false)
    if (!server) throw new Error('报告依赖连接已停用')
    const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const expected = fingerprint(server)
    const currentOrigin = server.specUrl ? (await loadOpenApi(server)).base.origin : new URL(server.url).origin
    if (currentOrigin !== expectedOrigin) throw new Error('报告依赖连接的实际目标已经变化')
    const headers = Object.fromEntries((server.headers ?? []).map((header: any) => [header.name, header.value])) as Record<string, string>
    Object.assign(headers, execute.requestHeaders?.(expectedOrigin))
    if (server.apiKey) headers[server.authHeader ?? 'Authorization'] = server.authType === 'credential' ? server.apiKey : `Bearer ${server.apiKey}`
    if (server.authType === 'login') throw new Error('此报告下载连接尚未支持登录凭据适配')
    return { headers, assertCurrent: () => {
      const current = config.servers.get().find(value => value.id === serverId && value.enabled !== false)
      if (!current || fingerprint(current) !== expected) throw new Error('报告依赖连接或工具范围已变化')
    } }
  }))
  const controlHandler = createBusinessControlHandler(assetRoot)
  manager.apply(ctx, { ...config, platformClient,
    platformExecute: execute,
    onManagedTool: (name: string, registered: boolean) => {
      const runtime = (ctx as any).get('businessRuntime')
      if (runtime?.managedTools) { if (registered) runtime.managedTools.add(name); else runtime.managedTools.delete(name) }
    },
    withManagement: <T>(run: () => Promise<T>) => {
      if ((ctx as any).get('businessRuntime') && !currentBusinessContext()) throw new Error('业务执行缺少受信任务上下文')
      return managementDispatch(assetRoot, run)
    },
    ...(control.enabled() ? { withToolContext: async (execution: any, run: () => Promise<any>) => {
      const sessionId = execution.agent?.session?.id ?? execution.agent?.id
      const context = typeof sessionId === 'string' ? control.contextForSession(sessionId) : undefined
      if (context) return withBusinessContext({ ...context, invocationId: execution.callId }, run)
      if (currentBusinessContext()) return run()
      if ((ctx as any).get('businessRuntime')) throw new Error('业务工具调用缺少受信 Session 归属')
      return managementDispatch(assetRoot, run)
    } } : {}),
    platformDispatch: (handler: NonNullable<ManagerConfig['dispatch']>) => { dispatch = handler }, servers: { get() {
    const servers = config.servers.get()
    if (servers.some(server => server.id === COMPOSITION_SERVICE_ID || server.platformComposition)) throw new Error('platform-compositions 是已发布编排的保留服务 ID')
    const catalog = readCompositions(workspaceConfigPath(assetRoot, 'mcp-compositions.json')).catalog
    const service = publishedCompositionService(catalog, executableCatalog(catalog, compositionExtension))
    return service ? [...servers, service] : servers
  } } })
  ctx.provide('platformMcp', { ...config, compositionHandler, compositionExtension,
    control: (endpoint, payload, signal) => controlHandler(endpoint, payload, signal, ctx.connection.browserPeer),
    currentGroup: id => (ctx as any).mcpSessionManager.currentGroup(id), dispatch: (request, signal) => {
    if (!dispatch) throw new Error('MCP 管理服务尚未就绪')
    return dispatch(request, signal)
  } })
}
