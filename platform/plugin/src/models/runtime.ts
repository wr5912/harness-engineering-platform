/** 业务实例的模型调用边界。实例 Patch 传入预览时当前 DSH 目录中的业务可用模型身份。 */
export const name = 'harness-model-runtime'

interface ModelIdentity { provider: string; model: string }
interface ModelRuntimeConfig { agentId: string; allowed: ModelIdentity[] }

export function assertModelAllowed(config: ModelRuntimeConfig, request: ModelIdentity): void {
  if (!config.allowed.some(item => item.provider === request.provider && item.model === request.model)) {
    throw new Error(`业务智能体 ${config.agentId} 当前不可使用模型 ${request.provider}/${request.model}；请核对平台“设置 → 模型”的目录与实例模型设置。`)
  }
}

export function apply(ctx: { on: (event: string, listener: (...args: any[]) => any) => void }, config: ModelRuntimeConfig): void {
  if (!config || typeof config.agentId !== 'string' || !Array.isArray(config.allowed)
    || config.allowed.some(item => !item || typeof item.provider !== 'string' || typeof item.model !== 'string')) {
    throw new Error('业务实例模型目录配置无效')
  }
  ctx.on('llm/stream', (async function* (request: ModelIdentity, next: () => AsyncIterable<unknown>) {
    assertModelAllowed(config, request)
    yield* next()
  }) as any)
}
