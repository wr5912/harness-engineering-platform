export const INSTANCE_STATES = ['running', 'stopped', 'completed', 'failed', 'absent', 'unknown'] as const
export type InstanceState = typeof INSTANCE_STATES[number]

/** 平台状态保留 SDK 执行完成语义；原始容器状态先由 CLI 归一化。 */
export function instanceState(value: unknown): InstanceState {
  return typeof value === 'string' && (INSTANCE_STATES as readonly string[]).includes(value) ? value as InstanceState : 'unknown'
}
