/** 容器内真实 SDK 调用程序；SDK stdout 由它自己的管道独占。 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export type SdkInput = { input: string; session_id?: string }
export type SdkOptions = {
  profile?: string; dshBin?: string; dshHome: string; cwd: string; patches: string[]
  provider: string; model: string; reasoningEffort?: string; initializeTimeoutMs?: number
  moduleLinksPath?: string
}

/** 子任务回执保留在轨迹；执行终态取本次根会话的最后一个回合。 */
export function sdkRootOutcome(sessionId: string, turns: Array<{ sessionId: string; event: any }>): { status: string; message?: string } {
  const last = turns.findLast(item => item.sessionId === sessionId && item.event.type === 'turn/end')?.event
  if (!last) return { status: 'unknown', message: '未取得根会话的最终回合回执，请核对 Session 记录' }
  if (last.data?.reason?.kind === 'completed') return { status: 'completed' }
  return { status: 'failed', message: last.data?.reason?.error?.message ?? `SDK 根回合结束：${last.data?.reason?.kind ?? 'unknown'}` }
}

/** 完整事件已逐条输出并由原生 Session 持久化；IPC 终态只传摘要。 */
export function sdkCliSummary(result: any): any {
  const { events, ...summary } = result
  return { ...summary, event_count: Array.isArray(events) ? events.length : 0 }
}

export async function runSdk(options: SdkOptions, input: SdkInput, emit: (event: any) => void): Promise<any> {
  if (!input || typeof input.input !== 'string' || !input.input.trim() || Buffer.byteLength(input.input) > 1024 * 1024) throw new Error('SDK 输入必须为非空文本且不超过 1 MiB')
  if (input.session_id !== undefined && (typeof input.session_id !== 'string' || !input.session_id.trim() || input.session_id.length > 256)) throw new Error('SDK 会话 ID 必须为非空字符串且不超过 256 个字符')
  if (options.moduleLinksPath) {
    const { prepareSdkModuleLinks } = await import('./sdk-module-links.mts')
    prepareSdkModuleLinks(options.moduleLinksPath)
  }
  const sdk = await import(pathToFileURL(createRequire('/opt/dsh/apps/cli/package.json').resolve('@deepseek-ai/dsh-sdk-client')).href)
  const boot = await import(pathToFileURL(createRequire('/opt/dsh/apps/cli/package.json').resolve('@deepseek-ai/dsh-app-boot')).href)
  if (typeof boot.healProfilesModuleFallback === 'function') {
    await boot.healProfilesModuleFallback({ installAnchor: '/opt/dsh/apps/cli/package.json', home: options.dshHome })
  }
  const client = new sdk.HarnessClient({ ...options, profile: options.profile ?? 'sdk', processCwd: options.cwd })
  const sessionId = input.session_id ?? `session-${randomUUID()}`
  let stopping = false
  const stop = () => { stopping = true; void client.close() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const events: any[] = []
  const turns: Array<{ sessionId: string; event: any }> = []
  let finalResponse = ''
  try {
    client.start()
    await client.initialize({ cwd: options.cwd, provider: options.provider, model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}) })
    emit({ type: 'initialized', session_id: sessionId })
    if (input.session_id) await client.resumeSession(sessionId)
    const subscription = client.subscribeSessionTree(sessionId)
    const consume = (notification: any) => {
      emit({ type: 'notification', notification })
      if (notification.method === 'session.event') {
        const event = notification.params.event
        events.push(event)
        if (event?.type === 'turn/end') turns.push({ sessionId: notification.params.sessionId, event })
        if (notification.params.sessionId === sessionId && event?.type === 'assistant/message') {
          const content = event.data?.message?.content
          if (typeof content === 'string') finalResponse = content
          else if (Array.isArray(content)) finalResponse = content.filter((part: any) => part.type === 'text').map((part: any) => part.text ?? '').join('')
        }
      }
    }
    const drain = () => { for (let item = subscription.tryNext(); item; item = subscription.tryNext()) consume(item) }
    const timer = setInterval(drain, 100)
    try {
      await client.prompt(sessionId, [{ type: 'text', text: input.input }])
      await client.request('session/wait', { sessionId })
      drain()
    } finally { clearInterval(timer); subscription.close() }
    if (stopping) throw new Error('SDK 执行已停止')
    const result = { type: 'result', ...sdkRootOutcome(sessionId, turns), session_id: sessionId, final_response: finalResponse, events }
    return result
  } finally {
    await client.close()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const emit = (event: any) => process.stdout.write(JSON.stringify(event) + '\n')
  try {
    const options = JSON.parse(readFileSync(process.argv[2], 'utf8'))
    const input = JSON.parse(readFileSync(process.argv[3], 'utf8'))
    const result = await runSdk(options, input, emit)
    emit(sdkCliSummary(result))
    if (result.status !== 'completed') process.exitCode = 1
  } catch (error) {
    // SDK 错误可能带 stderr 尾部；上层仍须使用现有凭据脱敏器。
    emit({ type: 'error', status: 'failed', message: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  }
}
