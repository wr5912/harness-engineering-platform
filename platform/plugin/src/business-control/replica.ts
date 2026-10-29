import { randomUUID } from 'node:crypto'
import type { ReplicaBatch, ReplicaObservation } from './contracts.ts'

export const REPLICA_BATCH_BYTES = 128 * 1024

/** 按实际 JSON 字节分批；接收端全部确认前不替换已确认的观察。 */
export function replicaBatches(observation: ReplicaObservation): ReplicaBatch[] {
  const empty = (): ReplicaObservation => ({ binding: observation.binding, sessions: [], riskFacts: [], events: [] })
  const parts = [empty()]
  for (const key of ['sessions', 'riskFacts', 'events'] as const) for (const item of observation[key]) {
    let part = parts.at(-1)!
    ;(part[key] as unknown[]).push(item)
    if (Buffer.byteLength(JSON.stringify(part)) > REPLICA_BATCH_BYTES) {
      part[key].pop(); part = empty(); (part[key] as unknown[]).push(item)
      if (Buffer.byteLength(JSON.stringify(part)) > REPLICA_BATCH_BYTES) throw new Error('单条控制记录超过同步大小，请检查记录来源')
      parts.push(part)
    }
  }
  if (parts.length > 256) throw new Error('控制观察超过分批同步容量')
  const id = randomUUID()
  return parts.map((part, index) => ({ id, index, count: parts.length, observation: part }))
}
