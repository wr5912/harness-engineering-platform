import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InstanceBinding } from '../business-control/contracts.ts'
import type { CompositionConfig } from './compositions.ts'

type DraftBinding = {
  instanceId: string; sourceDigest: string
  compositions: { id: string; config: CompositionConfig; implementationDigest: string }[]
}
const current = new AsyncLocalStorage<InstanceBinding>()
export const withDraftInstance = <T>(binding: InstanceBinding, run: () => T): T => current.run(binding, run)
function location(root: string, instanceId: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(instanceId)) throw new Error('草稿联调实例名称无效')
  return join(root, 'mcp', 'tests', 'bindings', `${instanceId}.json`)
}
export function saveDraftBinding(root: string, binding: DraftBinding) {
  const file = location(root, binding.instanceId)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(binding, null, 2) + '\n')
  renameSync(`${file}.tmp`, file)
}
/** 复用已核对的实例来源；联调绑定不改变任何公开发布状态。 */
export function boundDrafts(root: string): DraftBinding['compositions'] {
  const instance = current.getStore()
  if (!instance) return []
  const file = location(root, instance.instanceId)
  if (!existsSync(file)) return []
  const binding: DraftBinding = JSON.parse(readFileSync(file, 'utf8'))
  if (!binding.compositions.length) return []
  if (binding.instanceId !== instance.instanceId || binding.sourceDigest !== instance.sourceDigest) throw new Error('草稿联调绑定与实例实际来源不一致，请重新绑定')
  return binding.compositions
}
