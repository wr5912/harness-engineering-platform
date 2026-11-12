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
/** 失效联调单独报告，不能阻断同实例的公开工具发现。 */
export function inspectDraftBinding(root: string): { compositions: DraftBinding['compositions']; error?: string } {
  const instance = current.getStore()
  if (!instance) return { compositions: [] }
  const file = location(root, instance.instanceId)
  if (!existsSync(file)) return { compositions: [] }
  let binding: DraftBinding
  try { binding = JSON.parse(readFileSync(file, 'utf8')) }
  catch { return { compositions: [], error: '草稿联调绑定无法读取，请重新绑定' } }
  if (!Array.isArray(binding?.compositions) || binding.compositions.some(item => !item || typeof item.id !== 'string'
    || !item.config || typeof item.config.toolName !== 'string')) return { compositions: [], error: '草稿联调绑定格式无效，请重新绑定' }
  if (!binding.compositions.length) return { compositions: [] }
  if (binding.instanceId !== instance.instanceId || binding.sourceDigest !== instance.sourceDigest) return { compositions: [], error: '草稿联调绑定与实例实际来源不一致，请重新绑定' }
  return { compositions: binding.compositions }
}
/** 执行草稿时仍须严格核对来源；联调绑定不改变公开发布状态。 */
export function boundDrafts(root: string): DraftBinding['compositions'] {
  const state = inspectDraftBinding(root)
  if (state.error) throw new Error(state.error)
  return state.compositions
}
