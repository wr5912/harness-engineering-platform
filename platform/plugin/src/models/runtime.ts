/** 业务实例的模型调用边界。实例 Patch 传入预览时当前 DSH 目录中的业务可用模型身份。 */
import { getBusinessControl } from '../business-control/core.ts'

export const name = 'harness-model-runtime'

interface ModelIdentity { provider: string; model: string }
interface ModelRequest extends ModelIdentity { sessionId?: string }
interface ModelRuntimeConfig { agentId: string; allowed: ModelIdentity[]; localRoutes?: ModelIdentity[]; assetRoot?: string }

export function assertModelAllowed(config: ModelRuntimeConfig, request: ModelIdentity): void {
  if (![...config.allowed, ...(config.localRoutes ?? [])].some(item => item.provider === request.provider && item.model === request.model)) {
    throw new Error(`业务智能体 ${config.agentId} 当前不可使用模型 ${request.provider}/${request.model}；请核对平台“设置 → 模型”的目录与实例模型设置。`)
  }
}

export function apply(ctx: { on: (event: string, listener: (...args: any[]) => any) => void }, config: ModelRuntimeConfig): void {
  if (!config || typeof config.agentId !== 'string' || !Array.isArray(config.allowed)
    || (config.assetRoot !== undefined && (typeof config.assetRoot !== 'string' || !config.assetRoot))
    || (config.localRoutes !== undefined && !Array.isArray(config.localRoutes))
    || [...config.allowed, ...(config.localRoutes ?? [])].some(item => !item || typeof item.provider !== 'string' || typeof item.model !== 'string')) {
    throw new Error('业务实例模型目录配置无效')
  }
  ctx.on('llm/stream', (async function* (request: ModelRequest, next: () => AsyncIterable<unknown>) {
    assertModelAllowed(config, request)
    if (config.assetRoot && config.localRoutes?.some(item => item.provider === request.provider && item.model === request.model)) {
      if (!request.sessionId) throw new Error('业务本地模型路由缺少当前 Session')
      const control = getBusinessControl(config.assetRoot)
      const context = control.contextForSession(request.sessionId)
      if (!context) throw new Error('业务本地模型路由缺少受信 Session 归属')
      control.assert(context, 'agent:access')
      if (context.identity?.evidence.method === 'anonymous') throw new Error('访客尚未获准使用业务本地模型路由')
    }
    yield* next()
  }) as any)
}
