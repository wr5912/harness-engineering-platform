import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compositionExecutionDigest } from './execution-receipts.ts'
import type { CompositionConfig, Catalog } from './compositions.ts'
import type { CompositionWorkflow, WorkflowContext } from './extension.ts'

const roots = new Map<string, { active: Set<string>; queue: (() => Promise<void>)[]; running: number }>()
const admissions = new Map<string, { binding: string; promise: Promise<any> }>()
const now = () => new Date().toISOString()
const terminal = new Set(['completed', 'failed', 'interrupted'])
function atomic(file: string, value: any) {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
}

/** 运行记录与队列属于平台；业务工作流仅提供准备、执行、汇总与报告。 */
export function workflowRuns(root: string) {
  const directory = join(root, 'mcp/.local/runs')
  const state = roots.get(directory) ?? { active: new Set<string>(), queue: [], running: 0 }
  roots.set(directory, state)
  function file(id: string) {
    if (!/^run-[0-9a-f-]{36}$/.test(id)) throw new Error('运行 ID 无效')
    return join(directory, `${id}.json`)
  }
  function read(id: string): any | undefined {
    const path = file(id)
    if (!existsSync(path)) return undefined
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value.engine !== 'workflow') return undefined
    if (!terminal.has(value.status) && !state.active.has(id)) {
      value.status = 'interrupted'; value.finished_at = now()
      value.error = '平台运行已中断；保留已完成结果，不自动重放。'
      atomic(path, value)
    }
    return value
  }
  function pump() {
    while (state.running < 2 && state.queue.length) {
      const next = state.queue.shift()!
      state.running++
      void next().catch(error => process.emitWarning(`组合运行记录保存失败：${error.code ?? 'unknown'}`)).finally(() => { state.running--; pump() })
    }
  }
  async function start(request: { config: CompositionConfig; input: Record<string, any>; catalog: Catalog; version: any; executionId: string; compositionId: string }, workflow: CompositionWorkflow,
    execute: (context: WorkflowContext) => Promise<any>, prepare: () => Promise<any> = async () => undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const identity = compositionExecutionDigest({ execution: request.executionId })
    const identityFile = join(directory, `execution-${identity}.json`)
    // 发布身份用于请求去重；当前装载摘要只记入运行，不让配置更新重放旧请求。
    const binding = compositionExecutionDigest({ compositionId: request.compositionId, input: request.input, version: request.config.implementation ?? request.version.implementationDigest })
    if (existsSync(identityFile)) {
      const previous = JSON.parse(readFileSync(identityFile, 'utf8'))
      if (previous.binding !== binding) throw new Error('执行标识已用于不同的编排、实现或输入')
      return inspect(previous.run_id)
    }
    const pending = admissions.get(identityFile)
    if (pending) {
      if (pending.binding !== binding) throw new Error('执行标识已用于不同的编排、实现或输入')
      return pending.promise
    }
    const restoreContext = AsyncLocalStorage.snapshot()
    const submittedAt = Date.now()
    const promise = admit()
    admissions.set(identityFile, { binding, promise })
    try { return await promise } finally { admissions.delete(identityFile) }
    async function admit() {
    if (state.queue.length >= 256) throw new Error('当前待运行组合过多，请稍后提交；本次未创建运行')
    const prepared = await prepare()
    const preparationMs = Date.now() - submittedAt
    const runId = `run-${randomUUID()}`, path = file(runId)
    const record: any = { engine: 'workflow', run_id: runId, composition_id: request.compositionId, workflow: request.config.workflow,
      status: 'accepted', created_at: now(), input: request.input, version: request.version, plan: request.catalog,
      scope: prepared?.scope, snapshot: prepared, progress: {}, nodes: {}, artifacts: [], metrics: { requests: 0, peak_concurrency: 0, preparation_ms: preparationMs } }
    // 同一请求先落运行，再以排他文件登记身份；失败时不会启动上游调用。
    atomic(path, record)
    try { writeFileSync(identityFile, JSON.stringify({ binding, run_id: runId }), { flag: 'wx', mode: 0o600 }) }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      const previous = JSON.parse(readFileSync(identityFile, 'utf8'))
      if (previous.binding !== binding) throw new Error('执行标识已用于不同输入')
      record.status = 'interrupted'; record.error = '并发重复请求未执行'; atomic(path, record)
      return inspect(previous.run_id)
    }
    state.active.add(runId)
    const persist = () => { record.updated_at = now(); atomic(path, record) }
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    const persistProgress = () => { progressTimer ??= setTimeout(() => { progressTimer = undefined; persist() }, 250) }
    let requests = 0
    const waiting: (() => void)[] = []
    const limited = async <T>(call: () => Promise<T>): Promise<T> => {
      if (requests >= 8) await new Promise<void>(resolve => waiting.push(resolve))
      else requests++
      record.metrics.requests++
      record.metrics.peak_concurrency = Math.max(record.metrics.peak_concurrency, requests)
      try { return await call() } finally { const next = waiting.shift(); if (next) next(); else requests-- }
    }
    const context: WorkflowContext = { runId, nodeId: 'root', signal: AbortSignal.timeout(36 * 60_000), shared: prepared,
      progress(value) { record.nodes[this.nodeId] = { ...record.nodes[this.nodeId], ...value, updated_at: now() }; persistProgress() },
      call: limited,
      async map(items, call) { return Promise.all(items.map(call)) } }
    state.queue.push(() => restoreContext(async () => {
      try {
        record.status = 'running'; record.started_at = now(); persist()
        const value = await execute(context)
        record.result = value.result ?? value
        record.status = value.ok === false ? 'failed' : 'completed'
        if (value.error) record.error = value.error
        record.artifacts = workflow.artifacts?.(record.result) ?? []
      } catch (error) {
        record.status = 'failed'; record.error = error instanceof Error ? error.message : '工作流执行失败'
      } finally {
        clearTimeout(progressTimer)
        record.finished_at = now()
        record.metrics.elapsed_ms = Date.parse(record.finished_at) - submittedAt
        try { persist() } finally { state.active.delete(runId) }
      }
    }))
    // 先返回已持久化的 accepted 回执；请求断开不取消已接受的运行。
    setImmediate(pump)
    return publicRun(record)
    }
  }
  function publicRun(value: any) {
    const { plan: _plan, snapshot: _snapshot, ...view } = value
    const compact = (result: any): any => {
      if (!result || typeof result !== 'object') return result
      const { items, facts, ...summary } = result
      return { ...summary, ...(items ? { item_count: items.length } : {}), ...(result.checks ? { checks: Object.fromEntries(Object.entries(result.checks).map(([key, check]) => [key, compact(check)])) } : {}) }
    }
    return { ...view, result: compact(value.result), nodes: Object.fromEntries(Object.entries(value.nodes).map(([key, node]: [string, any]) => [key, { ...compact(node), ...(node.result ? { result: compact(node.result) } : {}) }])),
      artifacts: value.artifacts.map(({ body: _body, ...artifact }: any) => ({ ...artifact, bytes: Buffer.byteLength(_body ?? '') })) }
  }
  function inspect(id: string) { const value = read(id); return value ? publicRun(value) : undefined }
  function details(id: string, nodeId: string, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('明细分页参数无效')
    const record = read(id), node = record?.nodes[nodeId]
    if (!node) throw new Error('运行节点不存在，请先查询运行中的节点 ID')
    const result = node.result ?? nodeId.split('/').slice(1).reduce((value: any, key: string) => value?.checks?.[key], record.result)
    const collect = (value: any): any[] => value?.items ?? Object.values(value?.checks ?? {}).flatMap(collect)
    const items = node.items ?? collect(result)
    return { run_id: id, node_id: nodeId, offset, limit, total: items.length, items: items.slice(offset, offset + limit) }
  }
  function artifact(id: string, artifactId: string) {
    const value = read(id)?.artifacts.find((item: any) => item.id === artifactId)
    if (!value) throw new Error('运行产物不存在或尚未生成')
    const { filename, contentType, body } = value
    return { filename, contentType, body }
  }
  return { start, inspect, details, artifact, read, active: () => [...state.active] }
}
