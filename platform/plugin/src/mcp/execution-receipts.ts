import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceIdentity, mcpLocalPath } from '../workspace.ts'

export type CompositionExecutionBinding = {
  composition_id: string
  version: string
  version_id?: string
  revision: string
  input_sha256: string
  config_sha256: string
  implementation_sha256: string
}
export type CompositionExecutionReceipt = {
  execution_id: string
  workspace_id: string
  binding: CompositionExecutionBinding
  state: 'running' | 'responded' | 'unknown'
  created_at: string
  updated_at: string
  run_ids: string[]
  result?: any
  message?: string
}

const active = new Set<string>()
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const compositionExecutionDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

/** 仅保存组合调用的回执和原生运行关联，不调度或重放业务。 */
export function createCompositionExecutionStore(root: string) {
  const workspace = workspaceIdentity(root).id
  const directory = mcpLocalPath(root, 'executions')
  function file(id: string) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) throw new Error('组合执行标识无效')
    return join(directory, `${id}.json`)
  }
  function save(path: string, value: CompositionExecutionReceipt) {
    const temporary = `${path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  }
  function read(id: string): CompositionExecutionReceipt | undefined {
    const path = file(id)
    if (!existsSync(path)) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8')) as CompositionExecutionReceipt
    if (value.execution_id !== id || value.workspace_id !== workspace) throw new Error('组合执行回执的工作区或身份不匹配')
    return value.state === 'running' && !active.has(path)
      ? { ...value, state: 'unknown', message: '原请求未留下最终回执；请只读核对关联运行，不要重新执行。' } : value
  }
  function assertRequest(value: CompositionExecutionReceipt, request: Pick<CompositionExecutionBinding, 'composition_id' | 'version' | 'version_id' | 'revision' | 'input_sha256'>) {
    if (Object.entries(request).some(([key, item]) => value.binding[key as keyof CompositionExecutionBinding] !== item)) throw new Error('组合执行标识已用于其他目标、版本或输入')
  }
  async function execute(id: string, binding: CompositionExecutionBinding, run: (onRun: (runId: string) => Promise<void>) => Promise<any>) {
    const existing = read(id)
    if (existing) { assertRequest(existing, binding); return existing }
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = file(id), now = new Date().toISOString()
    let receipt: CompositionExecutionReceipt = { execution_id: id, workspace_id: workspace, binding, state: 'running', created_at: now, updated_at: now, run_ids: [] }
    try { writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; const current = read(id)!; assertRequest(current, binding); return current }
    active.add(path)
    try {
      const result = await run(async runId => {
        if (typeof runId !== 'string' || !/^run-[A-Za-z0-9-]{1,160}$/.test(runId)) throw new Error('组合运行标识无效')
        if (!receipt.run_ids.includes(runId)) {
          receipt = { ...receipt, run_ids: [...receipt.run_ids, runId], updated_at: new Date().toISOString() }
          save(path, receipt)
        }
      })
      receipt = { ...receipt, state: 'responded', result, updated_at: new Date().toISOString() }
      save(path, receipt)
    } catch {
      receipt = { ...receipt, state: 'unknown', message: '未收到完整组合回执，业务可能已经执行；请核对原运行。', updated_at: new Date().toISOString() }
      try { save(path, receipt) } catch { receipt.message = '执行回执保存未完成，业务结果待核对；请保留执行标识并读取原运行。' }
    } finally { active.delete(path) }
    return receipt
  }
  return { read, assertRequest, execute, active: () => [...active].filter(path => path.startsWith(directory + '/')).map(path => JSON.parse(readFileSync(path, 'utf8')) as CompositionExecutionReceipt) }
}
