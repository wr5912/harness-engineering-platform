/** Web 评测复用官方 SDK 的任务树等待语义；会话、输入与任务归属由原生服务维护。 */
export const name = 'harness-evaluation-wait'
export const inject = ['agents', 'connection']
export const EVALUATION_WAIT_PATH = '/api/evaluation.wait'

export interface EvaluationWaitConnection { baseUrl: string | URL; cookie?: string }

/** 完成条件来自原生任务树等待；定期导出仅用于保留超时、取消前的部分证据。 */
export async function waitForSessionTree(connection: EvaluationWaitConnection, sessionId: string, timeoutMs: number,
  signal?: AbortSignal, checkpoint?: () => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(timeoutMs)
  const bounded = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])])
  const url = new URL(EVALUATION_WAIT_PATH.slice(1), connection.baseUrl)
  url.searchParams.set('sessionId', sessionId)
  let settled = false
  const waiting = (async () => {
    try {
      const response = await fetch(url, { headers: { cookie: connection.cookie ?? '' }, signal: bounded })
      if (!response.ok) throw Object.assign(new Error('task-tree-wait-failed'), {
        rpc_method: 'evaluation.wait', http_status: response.status,
      })
      const value = await response.json()
      if (value?.settled !== true || value.session_id !== sessionId) throw new Error('task-tree-wait-invalid')
    } catch (error) {
      if (signal?.aborted) throw new Error('case-hard-timeout')
      if (timeout.aborted) throw new Error('task-tree-wait-timeout')
      throw error
    } finally { settled = true }
  })()
  // checkpoint 失败时仍会中止等待；拒绝回执始终由下面的 await 或 catch 消费。
  void waiting.catch(() => {})
  try {
    while (!settled) {
      await checkpoint?.()
      if (!settled) await Promise.race([waiting, new Promise(resolve => setTimeout(resolve, 300))])
    }
    await waiting
  } finally { controller.abort() }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('evaluation-wait-aborted'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

/** 与锁定版 SDK session/wait 一致，子任务回报后重新等待根会话和事件序列稳定。 */
export async function waitForEvaluationTree(ctx: any, sessionId: string, signal: AbortSignal): Promise<void> {
  const agent = ctx.agents.get(sessionId)
  if (!agent) throw new Error('evaluation-session-not-live')
  const assertLive = () => {
    signal.throwIfAborted()
    if (ctx.agents.get(sessionId) !== agent) throw new Error('evaluation-session-replaced')
  }
  while (true) {
    assertLive()
    await abortable(agent.whenIdle(), signal)
    assertLive()
    const idleSeq = agent.session.seq
    const joined = await abortable(Promise.resolve(ctx.get('subagents')?.waitForChildren(agent) ?? false), signal)
    assertLive()
    if (!joined && agent.status === 'idle' && agent.session.seq === idleSeq) return
  }
}

export function apply(ctx: any): void {
  // 认证、Host、Origin 和连接策略继续由原生 connection 处理。
  ctx.connection.fetch.register({
    path: EVALUATION_WAIT_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request: Request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!sessionId || sessionId.length > 256) return Response.json({ error: 'invalid-session-id' }, { status: 400 })
      try {
        await waitForEvaluationTree(ctx, sessionId, request.signal)
        return Response.json({ session_id: sessionId, settled: true })
      } catch (error) {
        request.signal.throwIfAborted()
        const reason = error instanceof Error ? error.message : ''
        return Response.json({ error: reason === 'evaluation-session-not-live' || reason === 'evaluation-session-replaced'
          ? reason : 'evaluation-wait-failed' }, { status: 409 })
      }
    },
  })
}
