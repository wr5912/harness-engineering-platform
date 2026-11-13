import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { createThreatBridge } from './bridge.ts'
import { defaultThreatStateRoot, loadThreatSource } from './source.ts'
import { threatPython } from './python.ts'
import type { ThreatArtifact, ThreatBindings, ThreatPhaseStatus, ThreatResult, ThreatRuntime, ThreatRuntimeOptions, ThreatServices, ThreatStage, ThreatTrace } from './types.ts'
import type { CompositionExecutionContext } from '@harness-platform/mcp/extension'
import { publicErrorText } from '../error.ts'

const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STAGES: ThreatStage[] = ['collect', 'infer', 'writeback', 'report']
type Context = {
  bindings: ThreatBindings; source: { commit: string; digest: string }; analysis_deadline: number
  connections: { soc: string; report: string }
  result: Record<string, any> & { run_id: string; incident_id: string; status: string }; phases: Partial<Record<ThreatStage, ThreatPhaseStatus>>
  trace: ThreatTrace[]; phase_status: ThreatPhaseStatus; inference_attempted?: boolean
}
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'))
async function atomic(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, file)
}
function bindingsOf(value: ThreatBindings): ThreatBindings {
  if (!value || ![value.socConnectionId, value.reportConnectionId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(id))) throw new Error('invalid_threat_bindings')
  if (value.model && (![value.model.provider, value.model.model].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200))) throw new Error('invalid_threat_model')
  return { socConnectionId: value.socConnectionId, reportConnectionId: value.reportConnectionId,
    ...(value.model ? { model: { provider: value.model.provider, model: value.model.model,
      ...(value.model.reasoningEffort === undefined ? {} : { reasoningEffort: value.model.reasoningEffort }) } } : {}) }
}
function contentType(file: string) {
  return file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8'
}

export function createThreatRuntime(assetRoot: string, services: ThreatServices, opts: ThreatRuntimeOptions = {}): ThreatRuntime {
  const stateRoot = resolve(opts.stateRoot ?? defaultThreatStateRoot(assetRoot))
  const source = () => loadThreatSource(assetRoot, stateRoot)
  async function connectionFingerprints(bindings: ThreatBindings) {
    return { soc: await services.connectionFingerprint(bindings.socConnectionId), report: await services.connectionFingerprint(bindings.reportConnectionId) }
  }
  async function assertConnections(context: Context) {
    const current = await connectionFingerprints(context.bindings)
    if (!context.connections || current.soc !== context.connections.soc || current.report !== context.connections.report) throw new Error('threat_connection_conflict')
  }
  function runDirectory(id: string) {
    if (!RUN_ID.test(id)) throw new Error('invalid_threat_run_id')
    return join(stateRoot, 'runs', id)
  }
  async function checkedRunDirectory(id: string) {
    const root = runDirectory(id), stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('threat_artifact_integrity_failed')
    return root
  }
  async function load(id: string): Promise<Context> {
    try { return await json(join(await checkedRunDirectory(id), 'context.json')) }
    catch (error: any) { if (error.code === 'ENOENT') throw new Error('threat_run_not_found'); throw error }
  }
  async function artifacts(id: string): Promise<ThreatArtifact[]> {
    const root = await checkedRunDirectory(id), rows: ThreatArtifact[] = []
    async function walk(folder: string) {
      for (const name of (await readdir(folder)).sort()) {
        if (name === 'context.json' || name.startsWith('.') || name.endsWith('.tmp')) continue
        const file = join(folder, name), stat = await lstat(file)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) await walk(file)
        else rows.push({ id: relative(root, file).split(sep).join('/'), name, content_type: contentType(file), bytes: stat.size })
      }
    }
    await walk(root)
    return rows
  }
  async function view(id: string, context: Context, phase = context.phase_status): Promise<ThreatResult> {
    return { ...context.result, phase_status: phase, artifacts: await artifacts(id), trace: context.trace, source: context.source } as ThreatResult
  }
  async function inspect(id: string) { return view(id, await load(id)) }

  async function assertSavedResult(id: string, context: Context) {
    // 跨源码版本仅回读已保存的完整结果；旧 Run 没有逐文件摘要，不回填或重写历史。
    const required = ['result.json']
    if (context.result.route === 'fast_classification') required.push('fusion/fast-classification-output.json')
    if (context.phases.infer === 'completed' && context.result.route === 'five_source') required.push('model/model-analysis-output.json', 'model/validation.json')
    if (context.phases.writeback === 'completed' && context.result.status === 'completed') required.push('report.html', 'storage.json')
    if (context.phases.report === 'completed') required.push('summary.json', 'summary.md')
    try {
      const root = await checkedRunDirectory(id)
      for (const name of required) {
        let file = root
        const parts = name.split('/')
        for (const [index, part] of parts.entries()) {
          file = join(file, part)
          const stat = await lstat(file), last = index === parts.length - 1
          if (stat.isSymbolicLink() || (last ? !stat.isFile() || stat.size === 0 : !stat.isDirectory())) throw new Error('missing_artifact')
        }
        if (name.endsWith('.json')) await json(file)
      }
      if (context.result.run_id !== id || !isDeepStrictEqual(await json(join(runDirectory(id), 'result.json')), context.result)) throw new Error('result_conflict')
    } catch { throw new Error('threat_artifact_integrity_failed') }
  }

  return {
    inspect,
    async artifact(id, artifactId) {
      const found = (await artifacts(id)).find(item => item.id === artifactId)
      if (!found) throw new Error('threat_artifact_not_found')
      return { filename: basename(found.id), contentType: found.content_type, body: await readFile(join(runDirectory(id), found.id), 'utf8') }
    },
    async execute(stage, suppliedBindings, input, signal, execution?: CompositionExecutionContext) {
      if (!STAGES.includes(stage)) throw new Error('invalid_threat_stage')
      const bindings = bindingsOf(suppliedBindings)
      const immutable = await source()
      let id = typeof input.run_id === 'string' ? input.run_id : ''
      let context: Context
      if (stage === 'collect' && !id) {
        if (typeof input.incident_id !== 'string' || !/^INC-\d{8}-\d{6}$/.test(input.incident_id)) throw new Error('invalid_threat_incident_id')
        id = `run-${randomUUID()}`
        await mkdir(runDirectory(id), { recursive: true, mode: 0o700 })
        context = { bindings: { socConnectionId: bindings.socConnectionId, reportConnectionId: bindings.reportConnectionId }, connections: await connectionFingerprints(bindings), source: { commit: immutable.commit, digest: immutable.digest }, analysis_deadline: Date.now() / 1000 + 30 * 60,
          result: { schema_version: '1.0', run_id: id, incident_id: input.incident_id, model: null, llm_invoked: false, status: 'claim_failed' }, phases: {}, trace: [], phase_status: 'unknown' }
        await atomic(join(runDirectory(id), 'context.json'), context)
      } else context = await load(id)
      if (bindings.socConnectionId !== context.bindings.socConnectionId || bindings.reportConnectionId !== context.bindings.reportConnectionId) throw new Error('threat_binding_conflict')
      if (stage === 'collect' && input.incident_id !== context.result.incident_id) throw new Error('threat_incident_conflict')
      await execution?.onRun?.(id)
      const output = runDirectory(id), contextFile = join(output, 'context.json'), lock = join(output, '.phase-lock')
      try { await mkdir(lock) } catch (error: any) { if (error.code === 'EEXIST') throw new Error('threat_run_busy'); throw error }
      try {
        context = await load(id)
        if (stage === 'infer' && context.inference_attempted && bindings.model && context.bindings.model &&
          Object.entries(bindings.model).some(([key, value]) => value !== context.bindings.model![key as keyof typeof bindings.model])) throw new Error('threat_model_conflict')
        const sameSource = context.source.commit === immutable.commit && context.source.digest === immutable.digest
        if (context.phases[stage]) {
          if (!sameSource) {
            if (context.phases[stage] !== 'completed') throw new Error('threat_source_integrity_failed')
            await assertSavedResult(id, context)
          }
          return { ...await view(id, context, context.phases[stage]), replayed: true }
        }
        if (!sameSource) throw new Error('threat_source_integrity_failed')
        await assertConnections(context)
        if (stage !== 'collect' && !context.phases.collect) throw new Error('threat_collect_required')
        if (stage === 'writeback' && context.result.status === 'evidence_ready') throw new Error('threat_inference_required')
        if (stage === 'report' && !context.phases.writeback) throw new Error('threat_writeback_required')
        if (stage === 'infer' && context.inference_attempted) return view(id, context, 'unknown')
        if (stage === 'infer' && context.result.route !== 'five_source') {
          context.phases.infer = 'skipped'; context.phase_status = 'skipped'
          await atomic(contextFile, context)
          return view(id, context)
        }
        if (stage === 'infer') context.inference_attempted = true
        const trace: ThreatTrace = { stage, status: 'running', started_at: new Date().toISOString() }
        context.trace.push(trace)
        context.phase_status = 'unknown'
        await atomic(contextFile, context)
        let bridge: Awaited<ReturnType<typeof createThreatBridge>> | undefined
        let connectionConflict = false
        const entry = join(output, '.phase.py')
        try {
          if (stage === 'infer') {
            const model = services.resolveModel ? await services.resolveModel(bindings.model) : bindings.model
            if (!model) throw new Error('threat_model_configuration_unavailable')
            context.bindings.model = bindingsOf({ ...context.bindings, model }).model
            await atomic(contextFile, context)
          }
          const observedExecution: CompositionExecutionContext = { ...execution, execution_id: execution?.execution_id ?? `graph-${randomUUID()}`, role: execution?.role ?? 'target',
            recordAttempt: async attempt => {
              // 唯一业务模型原始事实；回执只传输同一事实，重放不重写或再次计费。
              await appendFile(join(output, 'model-attempts.jsonl'), JSON.stringify(attempt) + '\n', { mode: 0o600 })
              await execution?.recordAttempt?.(attempt)
            } }
          const scopedServices: ThreatServices = { ...services,
            inferFrozen: (payload, model, callSignal) => services.inferFrozen(payload, model, callSignal, observedExecution),
            async invoke(connectionId, toolName, args, callSignal) {
            const expected = connectionId === context.bindings.socConnectionId ? context.connections.soc : context.connections.report
            try {
              if (await services.connectionFingerprint(connectionId) !== expected) throw new Error('threat_connection_conflict')
              return await services.invoke(connectionId, toolName, args, callSignal, expected)
            } catch (error: any) {
              if (error.message === 'threat_connection_conflict') connectionConflict = true
              throw error
            }
          } }
          bridge = await createThreatBridge(immutable.catalog, context.bindings, scopedServices, signal)
          const currentBridge = bridge
          await writeFile(entry, threatPython, { mode: 0o600 })
          const payload = { stage, source: immutable.root, output, run: context.result, analysis_deadline: context.analysis_deadline,
            config: { connections: { runtime: { bridgeUrl: bridge.runtime, bridgeKey: bridge.key } },
              analysisModel: { baseURL: bridge.model, model: context.bindings.model?.model ?? 'platform-default' } } }
          const result = await new Promise<{ stdout: string }>((resolveResult, reject) => {
            const child = execFile(opts.python ?? process.env.HARNESS_PYTHON ?? 'python3', [entry], {
              env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', THREAT_MODEL_BRIDGE_KEY: currentBridge.key },
              signal, timeout: stage === 'collect' || stage === 'infer' ? Math.max(1000, Math.ceil((context.analysis_deadline - Date.now() / 1000) * 1000) + 120_000) : 150_000,
              maxBuffer: 4 * 1024 * 1024,
            }, (error, stdout) => error ? reject(error) : resolveResult({ stdout }))
            child.stdin?.on('error', () => undefined)
            child.stdin?.end(JSON.stringify(payload))
          })
          const value = JSON.parse(result.stdout)
          context.result = value.result
          context.phase_status = value.phase_status
        } catch (error: any) {
          try { context.result = await json(join(output, 'result.json')) } catch { /* 无已落盘身份时保留初始化状态。 */ }
          context.phase_status = 'unknown'
          context.result.error_type = signal.aborted ? 'AbortError' : error?.name || 'PhaseExecutionError'
          context.result.error = publicErrorText(error?.message, '阶段执行未返回错误详情')
          if (stage === 'collect' && context.result.judgement_id) context.result.status = 'evidence_failed'
          if (stage === 'infer') context.result.status = 'model_failed'
        } finally {
          bridge?.close()
          await rm(entry, { force: true })
          // 临时模型桥地址不是可交付证据或长期配置。
          const metadata = join(output, 'model/request-metadata.json')
          try { const value = await json(metadata); value.endpoint = 'platform:inferFrozen'; await atomic(metadata, value) } catch { /* 未调用模型时不存在。 */ }
        }
        trace.status = context.phase_status
        trace.finished_at = new Date().toISOString()
        if (context.phase_status === 'unknown') trace.error_type = context.result.error_type
        context.phases[stage] = context.phase_status
        if (connectionConflict) {
          context.phase_status = 'failed'; context.phases[stage] = 'failed'; trace.status = 'failed'
          context.result.error_type = trace.error_type = 'threat_connection_conflict'
        }
        await atomic(contextFile, context)
        if (connectionConflict) throw new Error('threat_connection_conflict')
        return view(id, context)
      } finally { await rm(lock, { recursive: true, force: true }) }
    },
  }
}
