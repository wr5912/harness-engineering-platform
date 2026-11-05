import type { ExternalConversationResult, ExternalFramework } from './types.ts'

export interface ConversationSnapshot { value: any; status?: string; running?: boolean; waiting?: boolean }
type Reply = Pick<ExternalConversationResult, 'status' | 'messages' | 'tools' | 'note' | 'retryAfterMs'>
const textContent = (content: any) => Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
const unresolved = (accepted: boolean, note: string): Reply => ({ status: accepted ? 'running' : 'unknown', messages: [], tools: [], note, retryAfterMs: 1500 })

/** 结果仅从本次原生 user 锚点后的事实派生；不保存第二份执行状态。 */
export function conversationReply(framework: ExternalFramework, requestId: string, messageId: string, snapshot: ConversationSnapshot, accepted: boolean): Reply {
  if (framework === 'dsh') return dshReply(requestId, snapshot, accepted)
  const rows = framework === 'opencode' ? snapshot.value?.data : snapshot.value?.messages
  if (!Array.isArray(rows)) return unresolved(false, '原系统消息格式无法确认，可继续读取或在原系统核对。')
  // OpenCode v2 list 默认按新到旧返回；相同毫秒仍保留原生消息次序。
  const ordered = framework === 'opencode' ? [...rows].reverse() : rows
  const index = ordered.findIndex(row => row.id === messageId && (framework === 'opencode' ? row.type === 'user' : row.role === 'user'))
  if (index < 0) return unresolved(accepted, '尚未读到本次输入；不会使用历史回复，也不会自动重发。若历史已超出读取窗口，请在原系统核对。')
  const tail = ordered.slice(index + 1), nextUser = tail.findIndex(row => framework === 'opencode' ? row.type === 'user' : row.role === 'user')
  const current = nextUser < 0 ? tail : tail.slice(0, nextUser)
  const assistants = current.filter(row => framework === 'opencode' ? row.type === 'assistant' : row.role === 'assistant')
  const messages = assistants.flatMap(row => { const text = textContent(row.content); return text ? [{ id: row.id, role: 'assistant' as const, text }] : [] })
  const tools: ExternalConversationResult['tools'] = []
  if (framework === 'opencode') {
    for (const row of assistants) for (const part of row.content ?? []) if (part.type === 'tool') tools.push({ id: part.id, name: part.name,
      status: part.state?.status === 'completed' ? 'completed' : part.state?.status === 'error' ? 'failed' : 'running' })
    const idle = current.find(row => row.type === 'idle')
    if (idle) {
      if (idle.outcome !== 'succeeded') return { status: 'failed', messages, tools, note: '原系统报告本次执行失败或被中断。' }
      if (assistants.some(row => row.finish === 'stop' && row.time?.completed <= idle.time?.created)) return { status: 'completed', messages, tools }
      return { status: 'unknown', messages, tools, note: '原系统已结束该轮，但未读到可确认的最终回复；请继续读取或在原系统核对。' }
    }
    if (nextUser >= 0) return { status: 'unknown', messages, tools, note: '本次输入后出现另一条用户输入，但本轮结束事实不完整；未认领后续回复。' }
    if (snapshot.waiting) return { status: 'waiting', messages, tools, note: '原系统正在等待权限确认或用户输入，请在原系统处理后继续读取。', retryAfterMs: 4000 }
    return { status: snapshot.running ? 'running' : 'unknown', messages, tools, retryAfterMs: 1500,
      note: snapshot.running ? '正在等待本次回复。' : '尚未读到本轮结束事实，可继续读取；不会自动重发。' }
  }
  for (const row of assistants) for (const block of row.content ?? []) if (block.type === 'tool_call') {
    const result = (row.content ?? []).find((item: any) => item.type === 'tool_result' && item.id === block.id)
    tools.push({ id: block.id, name: block.name, status: result?.state === 'success' ? 'completed' : result && ['error', 'denied', 'interrupted'].includes(result.state) ? 'failed' : 'running' })
  }
  const final = assistants.at(-1)
  if (final?.finished_at && final.finished_reason && final.finished_reason !== 'completed') return { status: 'failed', messages, tools, note: '原系统报告本次回复失败、中断或达到执行上限。' }
  // running 优先于旧持久快照；parked 状态由原生 SessionStatus 判断。
  if (nextUser < 0 && snapshot.status === 'running') return { status: 'running', messages, tools, note: '正在等待本次回复。', retryAfterMs: 1500 }
  if (nextUser < 0 && ['awaiting_permission', 'awaiting_external_result'].includes(snapshot.status ?? '')) return { status: 'waiting', messages, tools,
    note: snapshot.status === 'awaiting_permission' ? '原系统正在等待权限确认，请在原系统处理后继续读取。' : '原系统正在等待外部工具结果，可稍后继续读取。', retryAfterMs: 4000 }
  if (final?.finished_at && final.finished_reason === 'completed' && (snapshot.status === 'idle' || nextUser >= 0)) return { status: 'completed', messages, tools }
  return { status: 'unknown', messages, tools, note: '尚未确认本次回复结束；历史回复和原系统空闲状态不能替代本轮完成事实。', retryAfterMs: 1500 }
}

function dshReply(requestId: string, snapshot: ConversationSnapshot, accepted: boolean): Reply {
  const records = snapshot.value?.records
  if (!Array.isArray(records)) return unresolved(false, '原系统未返回可确认的会话事件。')
  const events = records.filter(row => row.type === 'event').map(row => row.event).sort((a, b) => a.seq - b.seq)
  const index = events.findIndex(event => event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data.source.rpcId === requestId)
  if (index < 0) return unresolved(accepted, '尚未读到本次输入事件，可继续读取；不会自动重发。')
  const turn = events.slice(0, index).reverse().find(event => event.type === 'turn/start')?.data?.turn
  const next = events.slice(index + 1), boundary = next.findIndex(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
  const current = boundary < 0 ? next : next.slice(0, boundary)
  const messages: ExternalConversationResult['messages'] = current.filter(event => event.type === 'assistant/message').flatMap(event => {
    const text = textContent(event.data?.message?.content)
    return text ? [{ id: String(event.seq), role: 'assistant' as const, text }] : []
  })
  const tools: ExternalConversationResult['tools'] = current.filter(event => event.type === 'tool/call').map(event => {
    const result = current.find(item => item.type === 'tool/result' && item.data?.message?.toolCallId === event.data?.callId)
    return { id: event.data.callId, name: event.data.name, status: result ? result.data.message.isError ? 'failed' : 'completed' : 'running' }
  })
  const end = current.find(event => event.type === 'turn/end' && turn !== undefined && event.data?.turn === turn)
  if (end?.data.reason?.kind === 'completed') return { status: 'completed', messages, tools }
  if (end?.data.reason?.kind === 'blocked') return { status: 'waiting', messages, tools, note: '原系统已暂停本轮操作，请处理原生限制后继续读取。', retryAfterMs: 4000 }
  if (end) return { status: 'failed', messages, tools, note: '原系统报告本轮执行未正常完成。' }
  return { status: boundary < 0 ? 'running' : 'unknown', messages, tools, note: boundary < 0 ? '正在等待本轮回复。' : '本轮结束事实不完整，未认领后续用户输入的回复。', retryAfterMs: 1500 }
}
