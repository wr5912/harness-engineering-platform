export type InstanceState = 'running' | 'stopped' | 'failed' | 'absent' | 'unknown'

/** 登记缺失或尚不能识别的状态统一保留为未知，统计和筛选共用同一口径。 */
export function instanceState(value: unknown): InstanceState {
  return value === 'running' || value === 'stopped' || value === 'failed' || value === 'absent' ? value : 'unknown'
}

export function matchesInstanceState(value: unknown, filter: string): boolean {
  const state = instanceState(value)
  return filter === 'all' || (filter === 'existing' ? state !== 'absent' : state === filter)
}

export function instanceStateSegments(rows: readonly { state?: unknown }[]) {
  const counts: Record<InstanceState, number> = { running: 0, stopped: 0, failed: 0, absent: 0, unknown: 0 }
  for (const row of rows) counts[instanceState(row.state)]++
  return [
    { key: 'running', label: '运行中', count: counts.running, tone: 'success' as const },
    { key: 'stopped', label: '已停止', count: counts.stopped, tone: 'neutral' as const },
    { key: 'failed', label: '异常', count: counts.failed, tone: 'danger' as const },
    { key: 'absent', label: '无容器登记', count: counts.absent, tone: 'neutral' as const },
    { key: 'unknown', label: '状态未知', count: counts.unknown, tone: 'warning' as const },
  ]
}
