import { z } from 'zod'
import { workspaceIdentity, workspaceOwnsCwd } from '../workspace.ts'
import type { TaskExecution } from './task.ts'

export const deliveryProjectionSchema = z.object({
  session_id: z.string(), workspace_id: z.string().optional(),
  pending_proposals: z.number().int().nonnegative().optional(),
  unknown_proposals: z.number().int().nonnegative().optional(),
  task: z.object({
    id: z.string(), owner_session_id: z.string(), state: z.string(), reason: z.string().optional(),
    agent_id: z.string(), instance_name: z.string().optional(), target_source: z.string().optional(),
    delivery: z.object({
      ready: z.boolean().optional(), run_id: z.string().optional(),
      instance: z.object({ name: z.string(), source: z.string(), state: z.string().optional() }).optional(),
      checks: z.array(z.object({ name: z.string(), ok: z.boolean().optional(), message: z.string().optional() })).optional(),
      probe: z.object({ id: z.string(), status: z.string(), case_id: z.string().optional(), session_id: z.string().optional() }).optional(),
    }).optional(),
  }).optional(),
})
export type DeliveryProjection = z.infer<typeof deliveryProjectionSchema>

// 原生事件要求无损 JSON；只省略此投影合同中未定义的可选字段。
function definedFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as Partial<Pick<T, K>>
}

/** 原生对外投影只提供此只读视图；任务原记录仍是唯一事实来源。 */
export function deliveryProjection(state: { session_id: string; workspace_id?: string; execution?: TaskExecution; proposals?: { state?: string }[] }): DeliveryProjection {
  const task = state.execution, delivery = task?.delivery
  const pending = state.proposals?.filter(item => item.state === 'awaiting_confirmation').length ?? 0
  const unknown = state.proposals?.filter(item => item.state === 'unknown').length ?? 0
  return {
    session_id: state.session_id, ...definedFields(state, ['workspace_id']),
    ...(pending ? { pending_proposals: pending } : {}),
    ...(unknown ? { unknown_proposals: unknown } : {}),
    ...(task ? { task: {
      id: task.id, owner_session_id: task.owner_session_id, state: task.state, ...definedFields(task, ['reason', 'target_source']),
      agent_id: task.plan.agent_id, ...definedFields(task.plan, ['instance_name']),
      ...(delivery ? { delivery: {
        ...definedFields(delivery, ['ready', 'run_id']),
        ...(delivery.instance ? { instance: { name: delivery.instance.name, source: delivery.instance.source, ...definedFields(delivery.instance, ['state']) } } : {}),
        ...(Array.isArray(delivery.checks) ? { checks: delivery.checks.map((check: any) => ({ name: check.name, ...definedFields(check, check.ok === true ? ['ok'] : ['ok', 'message']) })) } : {}),
        ...(delivery.probe ? { probe: { id: delivery.probe.id, status: delivery.probe.status, ...definedFields(delivery.probe, ['case_id', 'session_id']) } } : {}),
      } } : {}),
    } } : {}),
  }
}

export interface DeliveryHistoryReader {
  list?(request: {}, signal: AbortSignal): Promise<{ items: readonly { sessionId: string; cwd?: string }[] }>
  projections?(request: { sessionId: any }, signal: AbortSignal): Promise<any>
}

/** 用原生冷读取核对各 Session 最新任务，不激活 Agent，也不扫描其 HOME。 */
export async function readInstanceDeliveryHistory(root: string, instance: { name: string; source_id?: string; agent_id?: string }, controller: DeliveryHistoryReader, signal: AbortSignal) {
  const scope = 'latest_task_per_session'
  const note = '仅查询各管理会话的最新任务；未找到记录不表示从未交付。记录描述当时的交付检查，当前实例状态以实例详情为准。'
  const records: (DeliveryProjection & { asOfSeq: number })[] = []
  const unavailable: { session_id?: string; reason: string }[] = []
  if (!controller.list || !controller.projections) return { scope, records, unavailable: [{ reason: '原生会话投影查询不可用' }], note }
  signal.throwIfAborted()
  const workspace = workspaceIdentity(root)
  let listing
  try { listing = await controller.list({}, signal) } catch {
    signal.throwIfAborted()
    return { scope, records, unavailable: [{ reason: '原生会话列表暂不可读' }], note }
  }
  for (const row of listing.items) {
    signal.throwIfAborted()
    if (!workspaceOwnsCwd(root, row.cwd)) continue
    try {
      const observed = await controller.projections({ sessionId: row.sessionId }, signal)
      signal.throwIfAborted()
      if (observed?.kind !== 'sequenced' || !Number.isSafeInteger(observed.asOfSeq) || observed.asOfSeq < 0) {
        unavailable.push({ session_id: row.sessionId, reason: '未取得精确会话投影，缓存或待迁移记录不能证明交付' })
        continue
      }
      const parsed = deliveryProjectionSchema.safeParse(observed.values?.harnessPlatformAssistant)
      if (!parsed.success) { unavailable.push({ session_id: row.sessionId, reason: '管理任务投影缺失或不可读' }); continue }
      const value = parsed.data, task = value.task
      if (value.workspace_id !== workspace.id || value.session_id !== row.sessionId || !task || task.owner_session_id !== row.sessionId
        || task.instance_name !== instance.name || !instance.source_id || task.target_source !== instance.source_id
        || instance.agent_id && task.agent_id !== instance.agent_id) continue
      if (task.delivery?.instance && (task.delivery.instance.name !== instance.name || task.delivery.instance.source !== instance.source_id)) continue
      records.push({ ...value, asOfSeq: observed.asOfSeq })
    } catch {
      signal.throwIfAborted()
      unavailable.push({ session_id: row.sessionId, reason: '会话投影暂不可读，交付状态未知' })
    }
  }
  return { scope, records, unavailable, note }
}
