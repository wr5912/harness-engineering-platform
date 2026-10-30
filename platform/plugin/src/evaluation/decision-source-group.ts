import { createHash } from 'node:crypto'

/** 根任务与已核验委派共用同一分组；不把父消息加入子任务可见输入。 */
export function decisionSourceGroup(state: any, sessionLog: unknown): string {
  const first = state?.messages?.find((message: any) => message.role === 'user' && (!message.source || message.source.kind === 'user'))
  const text = JSON.stringify(first?.content ?? sessionLog ?? '<未记录任务>').normalize('NFKC').replace(/\s+/g, ' ').trim()
  return `task-${createHash('sha256').update(text).digest('hex').slice(0, 24)}`
}
