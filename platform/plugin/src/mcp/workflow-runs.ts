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
    execute: (context: WorkflowContext) => Promise<any>, prepare: (context: Pick<WorkflowContext, 'call'>) => Promise<any> = async () => undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const identity = compositionExecutionDigest({ execution: request.executionId })
    const identityFile = join(directory, `execution-${identity}.json`)
    // 发布身份用于请求去重；当前装载摘要只记入运行，不让配置更新重放旧请求。
    const binding = compositionExecutionDigest({ compositionId: request.compositionId, input: request.input, version: request.config.implementation ?? request.version.implementationDigest })
    const pending = admissions.get(identityFile)
    if (pending) {
      if (pending.binding !== binding) throw new Error('执行标识已用于不同的编排、实现或输入')
      return pending.promise
    }
    if (existsSync(identityFile)) {
      const previous = JSON.parse(readFileSync(identityFile, 'utf8'))
      if (previous.binding !== binding) throw new Error('执行标识已用于不同的编排、实现或输入')
      return inspect(previous.run_id, workflow.responseMode === 'complete')
    }
    const restoreContext = AsyncLocalStorage.snapshot()
    const submittedAt = Date.now()
    const promise = admit()
    admissions.set(identityFile, { binding, promise })
    try { return await promise } finally { admissions.delete(identityFile) }
    async function admit() {
    if (state.queue.length >= 256) throw new Error('当前待运行组合过多，请稍后提交；本次未创建运行')
    const metrics = { requests: 0, peak_concurrency: 0, preparation_ms: 0 }
    let requests = 0
    const waiting: (() => void)[] = []
    const limited = async <T>(call: () => Promise<T>): Promise<T> => {
      if (requests >= 8) await new Promise<void>(resolve => waiting.push(resolve))
      else requests++
      metrics.requests++
      metrics.peak_concurrency = Math.max(metrics.peak_concurrency, requests)
      try { return await call() } finally { const next = waiting.shift(); if (next) next(); else requests-- }
    }
    let prepared = await prepare({ call: limited })
    if (request.input.resume_run_id !== undefined) {
      const previous = read(request.input.resume_run_id)
      if (!previous || !terminal.has(previous.status) || state.active.has(previous.run_id)) throw new Error('延续来源不存在或仍在执行；不重发')
      if (previous.composition_id !== request.compositionId || previous.version?.versionId !== request.version.versionId) throw new Error('延续必须使用原固定编排版本')
      const scopeInput = (value: any) => { const { resume_run_id: _resume, ...rest } = value; return rest }
      if (compositionExecutionDigest(scopeInput(previous.input)) !== compositionExecutionDigest(scopeInput(request.input))) throw new Error('延续不能改变冻结对象、服务、时间范围')
      if (!previous.snapshot?.diagnostic_loop) throw new Error('原运行没有可恢复诊断快照')
      if (compositionExecutionDigest(previous.snapshot.connection_fingerprints) !== compositionExecutionDigest(prepared.connection_fingerprints)) throw new Error('延续连接已变化；先核原请求，禁止切换来源')
      prepared = structuredClone(previous.snapshot)
      prepared.diagnostic_id ??= previous.run_id
      prepared.parent_run_id = previous.run_id
      prepared.continuations ??= []
      prepared.continuations.push({run_id:previous.run_id,status:previous.status,continued_at:now()})
      const unresolved = Object.values<any>(prepared.diagnostic_loop.attempts ?? {}).some(attempt => attempt.status === 'unknown')
      const proposalUnknown = (prepared.diagnostic_loop.proposals ?? []).some((attempt: any) => attempt.status === 'unknown')
      prepared.diagnostic_loop.stop_reason = unresolved || proposalUnknown ? '原执行或提议未知；已核原运行，禁止自动重发，等待可核响应' : null
      prepared.diagnostic_loop.pending = null
    }
    const preparationMs = Date.now() - submittedAt
    metrics.preparation_ms = preparationMs
    const runId = `run-${randomUUID()}`, path = file(runId)
    const record: any = { engine: 'workflow', run_id: runId, composition_id: request.compositionId, workflow: request.config.workflow,
      status: 'accepted', created_at: now(), input: request.input, version: request.version, plan: request.catalog,
      scope: prepared?.scope, snapshot: prepared, progress: {}, nodes: {}, artifacts: [], metrics }
    // 同一请求先落运行，再以排他文件登记身份；失败时不会启动上游调用。
    atomic(path, record)
    try { writeFileSync(identityFile, JSON.stringify({ binding, run_id: runId }), { flag: 'wx', mode: 0o600 }) }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error
      const previous = JSON.parse(readFileSync(identityFile, 'utf8'))
      if (previous.binding !== binding) throw new Error('执行标识已用于不同输入')
      record.status = 'interrupted'; record.error = '并发重复请求未执行'; atomic(path, record)
      return inspect(previous.run_id, workflow.responseMode === 'complete')
    }
    state.active.add(runId)
    const persist = () => { record.updated_at = now(); atomic(path, record) }
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    const persistProgress = () => { progressTimer ??= setTimeout(() => { progressTimer = undefined; persist() }, 250) }
    const context: WorkflowContext = { runId, nodeId: 'root', signal: AbortSignal.timeout(36 * 60_000), shared: prepared,
      progress(value) {
        record.nodes[this.nodeId] = { ...record.nodes[this.nodeId], ...value, updated_at: now() }
        // 完成事实必须先落盘，调用方随后才能释放依赖该事实的后继。
        if (terminal.has(value.status)) { clearTimeout(progressTimer); progressTimer = undefined; persist() }
        else persistProgress()
      },
      call: limited,
      async map(items, call) { return Promise.all(items.map(call)) } }
    const run = () => restoreContext(async () => {
      try {
        record.status = 'running'; record.started_at = now(); persist()
        const value = await execute(context)
        record.result = value.result ?? value
        record.status = value.ok === false ? 'failed' : 'completed'
        if (value.error) record.error = value.error
        record.artifacts.push(...(workflow.artifacts?.(record.result) ?? []))
      } catch (error) {
        record.status = 'failed'; record.error = error instanceof Error ? error.message : '工作流执行失败'
      } finally {
        clearTimeout(progressTimer)
        record.finished_at = now()
        record.metrics.elapsed_ms = Date.parse(record.finished_at) - submittedAt
        try { persist() } finally { state.active.delete(runId) }
      }
    })
    if (workflow.responseMode === 'complete') {
      await run()
      return publicRun(record, true)
    }
    state.queue.push(run)
    // 先返回已持久化的 accepted 回执；请求断开不取消已接受的运行。
    setImmediate(pump)
    return publicRun(record)
    }
  }
  function publicRun(value: any, fullResult = false) {
    const { plan: _plan, snapshot: _snapshot, ...view } = value
    const compact = (result: any): any => {
      if (!result || typeof result !== 'object') return result
      const { items, facts, ...summary } = result
      return { ...summary, ...(items ? { item_count: items.length } : {}), ...(result.checks ? { checks: Object.fromEntries(Object.entries(result.checks).map(([key, check]) => [key, compact(check)])) } : {}) }
    }
    return { ...view, result: fullResult ? value.result : compact(value.result), nodes: Object.fromEntries(Object.entries(value.nodes).map(([key, node]: [string, any]) => [key, { ...compact(node), ...(node.result ? { result: compact(node.result) } : {}) }])),
      artifacts: value.artifacts.map(({ body: _body, ...artifact }: any) => ({ ...artifact, bytes: artifact.bytes ?? Buffer.byteLength(_body ?? '') })) }
  }
  function inspect(id: string, fullResult = false) { const value = read(id); return value ? publicRun(value, fullResult) : undefined }
  function resultForNode(result: any, nodeId: string): any {
    let current = result, matched = false
    for (const raw of nodeId.split('/').slice(1)) {
      if (current?.checks && Object.hasOwn(current.checks, raw)) { current = current.checks[raw]; matched = true; continue }
      if (raw === 'routine' && current?.checks) { current = current.checks; matched = true; continue }
      if (raw === 'summary' || ['assess', 'children', 'observations', 'input', 'scope', 'selected-result'].includes(raw)) { matched = true; continue }
      const indexed = /^(.+)\[(\d+)\]$/.exec(raw)
      if (indexed) {
        const key = indexed[1], index = Number(indexed[2])
        if (key === 'assets' && Array.isArray(current)) { current = current[index]; matched = true; continue }
        if (key === 'assets' && Array.isArray(current?.items)) { current = current.items[index]; matched = true; continue }
        if (Array.isArray(current?.[key])) { current = current[key][index]; matched = true; continue }
        return undefined
      }
      if (raw === 'assets' && Array.isArray(current?.items)) { current = current.items; matched = true; continue }
      if (current && Object.hasOwn(current, raw)) { current = current[raw]; matched = true; continue }
      return undefined
    }
    return matched ? current : result
  }
  function details(id: string, nodeId: string, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('明细分页参数无效')
    const record = read(id), node = record?.nodes[nodeId]
    if (!node) throw new Error('运行节点不存在，请先查询运行中的节点 ID')
    const result = node.result ?? resultForNode(record.result, nodeId)
    if (result === undefined) throw new Error('运行节点没有可读取的已保存结果')
    const collect = (value: any): any[] => {
      if (Array.isArray(value)) return value
      if (Array.isArray(value?.items)) return value.items
      if (value?.checks && typeof value.checks === 'object') return Object.values(value.checks).flatMap(collect)
      return value && typeof value === 'object' ? [value] : []
    }
    const items = Array.isArray(node.items) ? node.items : collect(result)
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
