import { randomUUID } from 'node:crypto'
import { isCodeOnlyModelRoute } from '../workflows/code-only-route.ts'

export type ModelRole = 'target' | 'judge' | 'analysis' | 'generation'
export type ModelAttemptContext = {
  execution_id: string; role?: ModelRole; parent_run_id?: string; case_id?: string; session_id?: string; tool_call_id?: string
  model_invocation?: boolean
}
export type ModelAttempt = ModelAttemptContext & {
  attempt_id: string; status: 'preparing' | 'started' | 'completed' | 'failed' | 'cancelled' | 'local'
  provider?: string; model?: string; reasoning_effort?: string; time: number; usage?: Record<string, any>; error_type?: string
}
export type AttemptRecorder = (attempt: ModelAttempt) => void | Promise<void>

function hasProviderResponse(failure: any) {
  return Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599
    || typeof failure?.requestId === 'string' && failure.requestId.length > 0
}

/** 观察实际 prepared stream；不改变固定源码的输入、返回值和原生模型装配。 */
export function observeLlm(llm: any, context: ModelAttemptContext, record: AttemptRecorder) {
  return {
    async prepareCall(config: Record<string, any>, signal?: AbortSignal, ...rest: any[]) {
      const identity = { execution_id: context.execution_id, role: context.role ?? 'target', attempt_id: randomUUID(),
        ...Object.fromEntries(['parent_run_id', 'case_id', 'session_id', 'tool_call_id'].flatMap(key => {
          const value = context[key as keyof ModelAttemptContext]
          return value === undefined ? [] : [[key, value]]
        })), ...(typeof context.model_invocation === 'boolean' ? { model_invocation: context.model_invocation } : {}) }
      const event = (status: ModelAttempt['status'], route = config, extra: Partial<ModelAttempt> = {}) => record({ ...identity,
        provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoning_effort: route.reasoningEffort }),
        status, time: Date.now(), ...extra })
      await event('preparing')
      let prepared: any
      try { prepared = await llm.prepareCall(config, signal, ...rest) }
      catch (error) {
        await event(signal?.aborted ? 'cancelled' : 'failed', config, { model_invocation: false, error_type: error instanceof Error ? error.name : 'Error' })
        throw error
      }
      return { ...prepared, stream(options: any) {
        // 保留原生 prepared call 的一次性校验；校验失败不记为已发出请求。
        const stream = prepared.stream(options)
        return (async function* () {
          let usage: Record<string, any> | undefined
          let finished = false, settled = false
          const local = context.model_invocation === false
          let invocationProven = context.model_invocation === true
          await event(local ? 'local' : 'started', prepared.config)
          try {
            for await (const chunk of stream) {
              // started 只证明进入原生 stream；中间件、附件或认证仍可能在 Provider 前失败。
              if (['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage'].includes(chunk.type)
                || chunk.type === 'finish' && (!['error', 'aborted'].includes(chunk.reason?.kind) || hasProviderResponse(chunk.reason?.failure))) invocationProven = true
              // 原生 usage 是完整调用快照，后续快照替换而不是累加。
              if (chunk.type === 'usage') usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
                .filter(key => typeof chunk.usage?.[key] === 'number').map(key => [key, chunk.usage[key]]))
              if (chunk.type === 'finish') finished = !['error', 'aborted'].includes(chunk.reason?.kind)
              yield chunk
            }
            await event(local ? 'local' : finished ? 'completed' : 'failed', prepared.config,
              { ...(invocationProven && !local ? { model_invocation: true } : {}), ...(usage ? { usage } : {}), ...(!finished ? { error_type: 'IncompleteModelStream' } : {}) })
            settled = true
          } catch (error) {
            if (hasProviderResponse((error as any)?.failure)) invocationProven = true
            await event(local ? 'local' : signal?.aborted || options.signal?.aborted ? 'cancelled' : 'failed', prepared.config,
              { ...(invocationProven && !local ? { model_invocation: true } : {}), ...(usage ? { usage } : {}), error_type: error instanceof Error ? error.name : 'Error' })
            settled = true
            throw error
          } finally {
            if (!settled) await event(local ? 'local' : 'cancelled', prepared.config, { ...(invocationProven && !local ? { model_invocation: true } : {}), ...(usage ? { usage } : {}), error_type: 'ModelStreamClosed' })
          }
        })()
      } }
    },
  }
}

/** 仅这些受控原生路由已证明完全本地执行，未知路由不能按零调用处理。 */
export function isLocalModelRoute(route: any): boolean {
  return route?.provider === 'threat-analysis-delivery' && route?.model === 'fixed-summary'
    || route?.provider === 'threat-analysis-automation' && route?.model === 'scheduled-batch'
    || isCodeOnlyModelRoute(route)
}
