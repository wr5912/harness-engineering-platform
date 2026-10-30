import { instanceState, type InstanceState } from './state.ts'
export { instanceState, type InstanceState } from './state.ts'

export function matchesInstanceState(value: unknown, filter: string): boolean {
  const state = instanceState(value)
  return filter === 'all' || (filter === 'existing' ? state !== 'absent' : state === filter)
}

export function instanceStateSegments(rows: readonly { state?: unknown }[]) {
  const counts: Record<InstanceState, number> = { running: 0, stopped: 0, completed: 0, failed: 0, absent: 0, unknown: 0 }
  for (const row of rows) counts[instanceState(row.state)]++
  return [
    { key: 'running', label: '运行中', count: counts.running, tone: 'success' as const },
    { key: 'stopped', label: '已停止', count: counts.stopped, tone: 'neutral' as const },
    ...(counts.completed ? [{ key: 'completed', label: '执行完成', count: counts.completed, tone: 'success' as const }] : []),
    { key: 'failed', label: '异常', count: counts.failed, tone: 'danger' as const },
    { key: 'absent', label: '无容器登记', count: counts.absent, tone: 'neutral' as const },
    { key: 'unknown', label: '状态未知', count: counts.unknown, tone: 'warning' as const },
  ]
}
