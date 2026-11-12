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
  /** get_composition_run 的默认有界投影；完整 result/nodes 仍由 read/details/artifact 读取。 */
  function summary(id: string) {
    const value = read(id)
    if (!value) return undefined
    const MAX_BYTES = 24 * 1024
    const str = (value: any, max = 500) => typeof value === 'string' ? value.slice(0, max) : undefined
    const arr = (value: any, max = 200) => Array.isArray(value) ? value.slice(0, max) : undefined
    const numbers = (value: any) => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'number').slice(0, 50)) : undefined
    const boundedScope = (scope: any) => {
      if (!scope || typeof scope !== 'object') return scope
      const out: any = {}
      for (const key of ['count', 'frozen_at', 'ruleTypes']) if (scope[key] !== undefined) out[key] = scope[key]
      if (scope.requested && typeof scope.requested === 'object') out.requested = Object.fromEntries(Object.entries(scope.requested).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 12).map(([k, v]) => [k, typeof v === 'string' ? str(v, 300) : v]))
      if (scope.source && typeof scope.source === 'object') out.source = { connectionId: str(scope.source.connectionId, 200), sourceDigest: str(scope.source.sourceDigest, 200), fingerprint: str(scope.source.fingerprint, 200) }
      if (scope.connection_fingerprints && typeof scope.connection_fingerprints === 'object') out.connection_fingerprints = Object.fromEntries(Object.entries(scope.connection_fingerprints).filter(([, v]) => typeof v === 'string').slice(0, 12).map(([k, v]) => [k, str(v, 300)]))
      if (Array.isArray(scope.assetIds)) { out.assetIds = arr(scope.assetIds, 200); if (scope.assetIds.length > 200) out.assetIds_truncated = scope.assetIds.length - 200 }
      return out
    }
    const boundedCheck = (check: any, depth = 0): any => {
      if (!check || typeof check !== 'object') return check
      const out: any = {}
      for (const key of ['kind', 'status', 'complete', 'item_count', 'message', 'reason']) {
        if (key === 'item_count') out.item_count = Array.isArray(check.items) ? check.items.length : check.item_count
        else if (key === 'message' || key === 'reason') { const text = str(check[key], 800); if (text !== undefined) out[key] = text }
        else if (key === 'kind' || key === 'status') out[key] = str(check[key], 100)
        else if (key === 'complete') out.complete = typeof check.complete === 'boolean' ? check.complete : undefined
        else if (check[key] !== undefined) out[key] = check[key]
      }
      if (check.counts && typeof check.counts === 'object') out.counts = numbers(check.counts)
      const summary = str(check.summary, 2000); if (summary !== undefined) out.summary = summary
      if (check.checks && typeof check.checks === 'object' && depth < 4) {
        const entries = Object.entries(check.checks).slice(0, 100)
        out.checks = Object.fromEntries(entries.map(([key, child]) => [key, boundedCheck(child, depth + 1)]))
        if (Object.keys(check.checks).length > entries.length) out.checks_truncated = Object.keys(check.checks).length - entries.length
      }
      return out
    }
    const boundedResult = (result: any): any => {
      if (!result || typeof result !== 'object') return result
      const out: any = {}
      for (const key of ['complete', 'status', 'error']) if (result[key] !== undefined) out[key] = key === 'error' ? str(result[key], 500) : key === 'status' ? str(result[key], 100) : key === 'complete' ? Boolean(result[key]) : result[key]
      if (result.counts && typeof result.counts === 'object') out.counts = numbers(result.counts)
      if (result.summary !== undefined) out.summary = str(result.summary, 4000) ?? (typeof result.summary === 'object' ? Object.fromEntries(Object.entries(result.summary).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 30)) : undefined)
      if (result.checks && typeof result.checks === 'object') {
        const entries = Object.entries(result.checks).slice(0, 100)
        out.checks = Object.fromEntries(entries.map(([key, check]) => [key, boundedCheck(check)]))
        if (Object.keys(result.checks).length > entries.length) out.checks_truncated = Object.keys(result.checks).length - entries.length
      }
      return out
    }
    const nodes = Object.entries(value.nodes ?? {})
    const detailNodes: Record<string, string[]> = { status: [], baseline: [], reachability: [], vulnerabilities: [], root: ['root'] }
    for (const [key] of nodes) for (const dimension of ['status', 'baseline', 'reachability', 'vulnerabilities']) if (new RegExp(`(?:^|/)${dimension}(?:/|$)`).test(key) && detailNodes[dimension].length < 10) detailNodes[dimension].push(key)
    const byStatus: Record<string, number> = {}
    for (const [, node] of nodes) { const status = String((node as any)?.status ?? 'unknown'); byStatus[status] = (byStatus[status] ?? 0) + 1 }
    const ids = (status: string) => nodes.filter(([, node]) => (node as any)?.status === status).slice(0, 20).map(([key]) => key)
    const scope = boundedScope(value.scope)
    const input = value.input && typeof value.input === 'object' ? { ...(value.input.scope !== undefined ? { scope: boundedScope(value.input.scope) } : {}) } : value.input
    const progress: any = {}
    if (value.progress && typeof value.progress === 'object') for (const key of ['completed', 'total', 'status', 'title', 'error']) if (value.progress[key] !== undefined) progress[key] = key === 'error' ? str(value.progress[key], 500) : key === 'title' || key === 'status' ? str(value.progress[key], 300) : value.progress[key]
    const metrics = numbers(value.metrics)
    const error = typeof value.error === 'string'
      ? value.error.replace(/(authorization|bearer|token|password|api[_-]?key|secret)\s*[:=]?\s*\S+/giu, '$1=[已脱敏]').slice(0, 500)
      : value.error
    const version = value.version && typeof value.version === 'object' ? {
      versionId: value.version.versionId, workflow: value.version.workflow, toolName: value.version.toolName,
      implementationDigest: value.version.implementationDigest, digest: value.version.digest,
      sourceDigest: value.version.sourceDigest, gitCommit: value.version.gitCommit, gitDirty: value.version.gitDirty,
      programCommit: value.version.programCommit, programDirty: value.version.programDirty,
    } : value.version
    const result: any = {
      engine: value.engine, run_id: value.run_id, composition_id: value.composition_id, workflow: value.workflow,
      status: value.status, created_at: value.created_at, started_at: value.started_at, finished_at: value.finished_at,
      updated_at: value.updated_at, error, scope, input, version, progress, metrics,
      result: boundedResult(value.result),
      nodes_summary: { total: nodes.length, by_status: byStatus, failed: ids('failed'), running: ids('running'), completed: byStatus.completed ?? 0 }, detail_nodes: detailNodes,
      artifacts: value.artifacts.map(({ body: _body, ...artifact }: any) => ({ id: artifact.id, filename: artifact.filename, contentType: artifact.contentType, bytes: artifact.bytes ?? Buffer.byteLength(_body ?? '') })),
      detail: { tool: 'get_composition_details', run_id: value.run_id, node_id: 'root', offset: 0, limit: 50, note: '完整 result、节点证据与 HTML 仍在原存储/产物中，按 node_id 分页读取。' },
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
      result.truncated = true
      result.detail_available = true
      result.nodes_summary.failed = result.nodes_summary.failed.slice(0, 10)
      result.nodes_summary.running = result.nodes_summary.running.slice(0, 10)
      if (result.result?.checks && Object.keys(result.result.checks).length > 50) {
        result.result.checks = Object.fromEntries(Object.entries(result.result.checks).slice(0, 50))
        result.result.checks_truncated = true
      }
      if (result.input?.scope?.assetIds) result.input.scope.assetIds = result.input.scope.assetIds.slice(0, 100)
      if (result.scope?.assetIds) result.scope.assetIds = result.scope.assetIds.slice(0, 100)
      result.detail.note = '摘要超过预算，已保留状态/计数/来源；完整 result、节点证据与 HTML 仍可按 detail 分页读取。'
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
        result.omitted = ['result.checks 明细', '完整节点树', '输入/进度非白名单字段']
        if (result.result?.checks) result.result.checks = Object.fromEntries(Object.entries(result.result.checks).slice(0, 10))
        if (Array.isArray(result.scope?.assetIds)) result.scope.assetIds = result.scope.assetIds.slice(0, 20)
        if (Array.isArray(result.input?.scope?.assetIds)) result.input.scope.assetIds = result.input.scope.assetIds.slice(0, 20)
        result.nodes_summary.failed = []
        result.nodes_summary.running = []
      }
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
        result.result = result.result && typeof result.result === 'object' ? { status: result.result.status, complete: result.result.complete, counts: result.result.counts } : result.result
        result.input = result.input?.scope ? { scope: { count: result.input.scope.count, frozen_at: result.input.scope.frozen_at } } : undefined
        result.scope = { count: result.scope?.count, frozen_at: result.scope?.frozen_at, requested: result.scope?.requested }
      }
    }
    return result
  }  function resultForNode(result: any, nodeId: string): any {
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
  return { start, inspect, summary, details, artifact, read, active: () => [...state.active] }
}
