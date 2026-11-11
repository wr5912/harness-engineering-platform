export type ThreatStage = 'collect' | 'infer' | 'writeback' | 'report'
export type ThreatPhaseStatus = 'completed' | 'failed' | 'unknown' | 'skipped'
export type ThreatModelRoute = { provider: string; model: string; reasoningEffort?: string }
export type ThreatBindings = { socConnectionId: string; reportConnectionId: string; model?: ThreatModelRoute }
export type ThreatArtifact = { id: string; name: string; content_type: string; bytes: number }
export type ThreatTrace = { stage: ThreatStage; status: ThreatPhaseStatus | 'running'; started_at: string; finished_at?: string; error_type?: string }
export type ThreatResult = Record<string, any> & {
  run_id: string; incident_id: string; status: string; phase_status: ThreatPhaseStatus
  artifacts: ThreatArtifact[]; trace: ThreatTrace[]
}
export interface ThreatServices {
  connectionFingerprint(connectionId: string): string | Promise<string>
  invoke(connectionId: string, toolName: string, args: Record<string, any>, signal: AbortSignal, expectedFingerprint?: string): Promise<any>
  inferFrozen(payload: Record<string, any>, route: ThreatModelRoute | undefined, signal: AbortSignal, execution?: CompositionExecutionContext): Promise<any>
  resolveModel?(route?: ThreatModelRoute): ThreatModelRoute | Promise<ThreatModelRoute>
}
export type ThreatRuntimeOptions = { stateRoot?: string; python?: string }
export interface ThreatRuntime {
  execute(stage: ThreatStage, bindings: ThreatBindings, input: Record<string, any>, signal: AbortSignal, execution?: CompositionExecutionContext): Promise<ThreatResult>
  inspect(runId: string): Promise<ThreatResult>
  artifact(runId: string, artifactId: string): Promise<{ filename: string; contentType: string; body: string }>
}

import type { Catalog, CompositionConfig } from './compositions.ts'
export type WorkflowContext = {
  runId: string; nodeId: string; signal: AbortSignal; shared: any
  composition?(selection: { compositionId: string; versionId: string }, input: Record<string, any>): Promise<any>
  progress(value: Record<string, any>): void
  call<T>(call: () => Promise<T>): Promise<T>
  map<T, R>(items: T[], call: (item: T, index: number) => Promise<R>): Promise<R[]>
}
export type CompositionWorkflow = {
  responseMode?: 'complete'
  native?: { digest(config: CompositionConfig): string; freeze(config: CompositionConfig): string }
  inputSchema: Record<string, any>
  outputSchema?: Record<string, any>
  sourceDigest: string
  connections(config: CompositionConfig): string[]
  structure?(config: CompositionConfig): Promise<{ nodes: any[]; edges: any[] }>
  prepare?(input: Record<string, any>, config: CompositionConfig, signal: AbortSignal, context?: Pick<WorkflowContext, 'call'>): Promise<any>
  components?: Record<string, (input: Record<string, any>, config: CompositionConfig, context: WorkflowContext) => Promise<Record<string, any>> | Record<string, any>>
  execute?(input: Record<string, any>, config: CompositionConfig, context: WorkflowContext): Promise<Record<string, any>>
  aggregate?(steps: Record<string, any>, input: Record<string, any>, context: WorkflowContext): Promise<Record<string, any>>
  artifacts?(result: Record<string, any>): { id: string; filename: string; contentType: string; body: string }[]
}
export type CompositionCall = { ok: boolean; status: number; json: any; receipt: any }
export type CompositionFlow = {
  steps(config: CompositionConfig): { step: string; title: string; connectionId?: string; operationId: string; input: Record<string, unknown>; output: string }[]
  assetArguments(input: Record<string, any>): Record<string, any>
  assetResult(reply: CompositionCall, input: Record<string, any>): { asset: any; assetId: string | number; error?: { code: string; message: string } }
  alertsArguments(input: Record<string, any>, assetId: string | number): Record<string, any>
  alertsResult(reply: CompositionCall): { items: unknown; summary?: any; error?: { code: string; message: string } }
  succeeded(reply: CompositionCall): boolean
}
/** DSH 原生插件登记实际业务运行器；平台不从工作区自动执行源码。 */
export type CompositionExtension = {
  id?: string
  sourceDigest?: string
  threat?: ThreatRuntime
  flow?: CompositionFlow
  workflows?: Record<string, CompositionWorkflow>
  seed?(catalog: Catalog, bindings: ThreatBindings): void
}

/** 目录仍可编辑；工具发现只暴露当前已装载实现能够执行的发布项。 */
export function executableCatalog(catalog: Catalog, extension?: CompositionExtension): Catalog {
  const available = (config: CompositionConfig, path = new Set<string>()): boolean => {
    if (config.workflow && !extension?.workflows?.[config.workflow]) return false
    if (config.kind === 'workflow') return Boolean(extension?.workflows?.[config.workflow!]?.execute)
    if (config.kind === 'threat-stage') return Boolean(extension?.threat)
    if (config.kind === 'composite') return (config.steps ?? []).every(step => {
      const key = `${step.compositionId}:${step.versionId}`
      if (path.has(key)) return false
      const child = catalog.compositions.find(entry => entry.id === step.compositionId)?.versions?.find(version => version.versionId === step.versionId)?.config
      return Boolean(child && available(child, new Set([...path, key])))
    })
    return !config.flow || Boolean(extension?.flow)
  }
  return { ...catalog, compositions: catalog.compositions.filter(entry => entry.published && available(entry.published)) }
}
import type { ModelAttempt, ModelAttemptContext, AttemptRecorder } from '../evaluation/model-attempts.ts'
export { observeLlm } from '../evaluation/model-attempts.ts'
export type { ModelAttempt } from '../evaluation/model-attempts.ts'
export type CompositionExecutionContext = ModelAttemptContext & { recordAttempt?: AttemptRecorder; onRun?(runId: string): Promise<void>; workflowContext?: WorkflowContext }
export type GraphExecution = {
  execution_id: string; parent_run_id?: string; case_id?: string; session_id?: string; tool_call_id?: string
  source_digest?: string; build_digest?: string
  model_attempts: ModelAttempt[]; complete: boolean; unknown_reasons?: string[]
}
