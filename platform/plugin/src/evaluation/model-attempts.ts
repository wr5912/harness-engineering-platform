import { randomUUID } from 'node:crypto'
import { isCodeOnlyModelRoute, isHybridWorkflowRoute } from '../workflows/code-only-route.ts'

export type ModelRole = 'target' | 'judge' | 'analysis' | 'generation'
export type ModelAttemptContext = {
  execution_id: string; role?: ModelRole; parent_run_id?: string; case_id?: string; session_id?: string; tool_call_id?: string
  model_invocation?: boolean
  model_role?: 'language' | 'decision'; kind?: 'typed_decision'
  checkpoint_sha256?: string; state_constructor_sha256?: string; calibration_sha256?: string
}
export type ModelAttempt = ModelAttemptContext & {
  attempt_id: string; status: 'preparing' | 'started' | 'completed' | 'failed' | 'cancelled' | 'local'
  provider?: string; model?: string; reasoning_effort?: string; time: number; usage?: Record<string, any>; error_type?: string
}
export type AttemptRecorder = (attempt: ModelAttempt) => void | Promise<void>

/** 原生输入与缓存桶互斥，reasoning 已包含在 output，缺失 aggregate 不补造。 */
export function normalizeTokenUsage(usage: Record<string, any> | undefined) {
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)) return null
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, reasoningTokens } = usage
  if ([cacheReadTokens, cacheWriteTokens].some(value => value !== undefined && !count(value))
    || reasoningTokens !== undefined && (!count(reasoningTokens) || reasoningTokens > outputTokens)) return null
  const knownInput = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  if (!count(knownInput)) return null
  const completeCache = cacheReadTokens !== undefined && cacheWriteTokens !== undefined
  if (totalTokens !== undefined) {
    const input = totalTokens - outputTokens
    if (!count(totalTokens) || !count(input) || input < knownInput || completeCache && input !== knownInput) return null
    return { input, output: outputTokens, total: totalTokens }
  }
  return { input: completeCache ? knownInput : null, output: outputTokens, total: null }
}

export type ModelInvocationFact = { model_invocation?: boolean; usage?: Record<string, any>; status?: string }

/** 正用量才是推理证据；全零快照不证明调用，也不证明未调用。 */
export function hasPositiveTokenUsage(usage: Record<string, any> | undefined): boolean {
  return normalizeTokenUsage(usage) !== null && ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
    .some(key => typeof usage?.[key] === 'number' && usage[key] > 0)
}

/** 注册位置不参与是否推理的判断；相反事实同时存在时保留未知。 */
export function modelInvocationEvidence(route: any, facts: readonly ModelInvocationFact[]): 'invoked' | 'none' | 'unknown' | 'conflict' {
  const positive = facts.some(fact => fact.model_invocation === true || hasPositiveTokenUsage(fact.usage))
  const negative = isLocalModelRoute(route) || facts.some(fact => fact.model_invocation === false || fact.status === 'local')
  return positive && negative ? 'conflict' : positive ? 'invoked' : negative ? 'none' : 'unknown'
}

/** 观察实际 prepared stream；不改变固定源码的输入、返回值和原生模型装配。 */
export function observeLlm(llm: any, context: ModelAttemptContext, record: AttemptRecorder) {
  return {
    async prepareCall(config: Record<string, any>, signal?: AbortSignal, ...rest: any[]) {
      const identity = { execution_id: context.execution_id, role: context.role ?? 'target', attempt_id: randomUUID(),
        ...Object.fromEntries(['parent_run_id', 'case_id', 'session_id', 'tool_call_id', 'model_role', 'kind', 'checkpoint_sha256', 'state_constructor_sha256', 'calibration_sha256'].flatMap(key => {
          const value = context[key as keyof ModelAttemptContext]
          return value === undefined ? [] : [[key, value]]
        })), ...(context.model_invocation === false ? { model_invocation: false } : {}) }
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
          let invocationProven = false
          await event(local ? 'local' : 'started', prepared.config)
          try {
            for await (const chunk of stream) {
              // started 只证明进入原生 stream；中间件、附件或认证仍可能在 Provider 前失败。
              if (chunk.type === 'usage' && hasPositiveTokenUsage(chunk.usage)) invocationProven = true
              // 原生 usage 是累计快照，后续替换而不累加；最终完整性另核终态。
              if (chunk.type === 'usage') usage = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
                .filter(key => chunk.usage?.[key] !== undefined).map(key => [key, typeof chunk.usage[key] === 'number' ? chunk.usage[key] : null]))
              if (chunk.type === 'finish') finished = !['error', 'aborted'].includes(chunk.reason?.kind)
              yield chunk
            }
            await event(local ? 'local' : finished ? 'completed' : 'failed', prepared.config,
              { ...(invocationProven ? { model_invocation: true } : {}), ...(usage ? { usage } : {}), ...(!finished ? { error_type: 'IncompleteModelStream' } : {}) })
            settled = true
          } catch (error) {
            await event(local ? 'local' : signal?.aborted || options.signal?.aborted ? 'cancelled' : 'failed', prepared.config,
              { ...(invocationProven ? { model_invocation: true } : {}), ...(usage ? { usage } : {}), error_type: error instanceof Error ? error.name : 'Error' })
            settled = true
            throw error
          } finally {
            if (!settled) await event(local ? 'local' : 'cancelled', prepared.config, { ...(invocationProven ? { model_invocation: true } : {}), ...(usage ? { usage } : {}), error_type: 'ModelStreamClosed' })
          }
        })()
      } }
    },
  }
}

/** 已有受控无推理实现；本地注册声明不等于这项执行证明。 */
export function isLocalModelRoute(route: any): boolean {
  return route?.provider === 'threat-analysis-delivery' && route?.model === 'fixed-summary'
    || route?.provider === 'threat-analysis-automation' && route?.model === 'scheduled-batch'
    || isCodeOnlyModelRoute(route)
    || isHybridWorkflowRoute(route)
}
