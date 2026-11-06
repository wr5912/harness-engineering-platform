import { Annotation } from '@langchain/langgraph'
import { versionConfig, type Catalog, type CompositionConfig, type CompositionStep } from './compositions.ts'
import { compileSequence } from '../workflows/graph.ts'
import { compositionInputSchema } from './definition.ts'
import type { CompositionExtension } from './extension.ts'
import { compileWorkflow, END, START } from './workflow-graph.ts'
import type { WorkflowContext } from './extension.ts'

const safePart = (part: string) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)

function mappingPaths(value: unknown): string[] {
  if (typeof value === 'string' && value.startsWith('$')) return [value]
  if (Array.isArray(value)) return value.flatMap(mappingPaths)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => {
    if (!safePart(key)) throw new Error('参数映射字段无效')
    return mappingPaths(item)
  })
  return []
}

export function nestedWorkflowGraph(config: CompositionConfig, catalog: Catalog, call: (child: CompositionConfig, input: Record<string, any>, step: CompositionStep) => Promise<any>, aggregate: (values: Record<string, any>, input: Record<string, any>) => Promise<Record<string, any>>, context?: WorkflowContext) {
  const steps = config.steps ?? []
  if (steps.some(step => step.when && step.when !== 'always')) throw new Error('工作流子组合仅支持明确的输入依赖；不支持威胁分析的阶段条件')
  const nodes = steps.map(step => {
    const child = versionConfig(catalog, step.compositionId, step.versionId)
    return { id: step.id, title: child.title, kind: 'composition', compositionId: step.compositionId, versionId: step.versionId, input: step.inputMap, output: step.id,
      run: async (state: any) => {
        try { return { values: { [step.id]: await call(child, mappedInput(step.inputMap, state.input, state.values), step) } } }
        catch (error) { return { values: { [step.id]: { status: 'failed', error: error instanceof Error ? error.message : '子组合执行失败' } } } }
      } }
  })
  const dependencies = new Map(steps.map(step => [step.id, [...new Set(mappingPaths(step.inputMap).filter(path => path.startsWith('$steps.')).map(path => path.split('.')[1]))]]))
  for (const [id, sources] of dependencies) if (sources.some(source => !dependencies.has(source) || steps.findIndex(step => step.id === source) >= steps.findIndex(step => step.id === id))) throw new Error('参数映射只能引用前序步骤输出')
  const terminals = steps.filter(step => ![...dependencies.values()].some(sources => sources.includes(step.id))).map(step => step.id)
  return compileWorkflow([...nodes, { id: 'aggregate', title: '汇总检查结果', kind: 'aggregate', run: async state => ({ result: await aggregate(state.values, state.input) }) }], [
    ...steps.map(step => ({ source: dependencies.get(step.id)!.length ? dependencies.get(step.id)! : START, target: step.id })),
    { source: terminals.length ? terminals : START, target: 'aggregate' }, { source: 'aggregate', target: END },
  ], context)
}

export function validateNested(config: CompositionConfig, catalog: Catalog, ancestors = new Set<string>(), extension?: CompositionExtension) {
  if (config.kind !== 'composite') return
  const previous = new Set<string>()
  for (const step of config.steps ?? []) {
    const key = `${step.compositionId}:${step.versionId}`
    if (ancestors.has(key)) throw new Error('组合版本存在循环引用')
    const child = versionConfig(catalog, step.compositionId, step.versionId)
    for (const path of mappingPaths(step.inputMap)) {
      const parts = path.slice(1).split('.')
      if (!parts.every(safePart) || !(parts[0] === 'input' && parts.length >= 2 || parts[0] === 'steps' && parts.length >= 3 && previous.has(parts[1]))) throw new Error('参数映射只能引用输入或前序步骤输出')
    }
    const schema = compositionInputSchema(child, extension)
    for (const required of schema.required ?? []) if (!(required in step.inputMap)) throw new Error(`子组合参数映射缺少 ${required}`)
    if (schema.additionalProperties === false && Object.keys(step.inputMap).some(key => !Object.hasOwn(schema.properties ?? {}, key))) throw new Error('子组合参数映射包含未声明字段')
    validateNested(child, catalog, new Set([...ancestors, key]), extension)
    previous.add(step.id)
  }
  if (!ancestors.size) {
    const stages: string[] = []
    const visit = (current: CompositionConfig) => {
      if (current.kind === 'threat-stage') stages.push(current.stage!)
      else if (current.kind === 'composite') for (const step of current.steps ?? []) visit(versionConfig(catalog, step.compositionId, step.versionId))
    }
    visit(config)
    if (new Set(stages).size !== stages.length) throw new Error('同一威胁分析运行的业务阶段不能重复执行')
  }
}

export function mappedInput(map: Record<string, unknown>, input: Record<string, unknown>, steps: Record<string, any>): Record<string, any> {
  const resolve = (value: any): any => {
    if (typeof value === 'string' && value.startsWith('$')) {
      const parts = value.slice(1).split('.')
      if (!parts.every(safePart)) throw new Error('参数映射路径无效')
      let resolved: any = { input, steps }
      for (const part of parts) {
        if (!resolved || typeof resolved !== 'object' || !Object.hasOwn(resolved, part)) {
          // 可选输入未提供时由子组合的 Schema 判断必填性；步骤输出缺失仍是执行错误。
          if (parts[0] === 'input') return undefined
          throw new Error('参数映射来源字段不存在')
        }
        resolved = resolved[part]
      }
      return resolved
    }
    if (Array.isArray(value)) return value.map(resolve)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]).filter(([, item]) => item !== undefined))
    return value
  }
  return resolve(map)
}

function matches(step: CompositionStep, latest: any) {
  if (!step.when || step.when === 'always') return true
  if (step.when === 'claimed') return Boolean(latest?.judgement_id)
  if (step.when === 'completed') return latest?.status === 'completed'
  return latest?.route === 'five_source' && latest?.status !== 'claim_failed' && latest?.status !== 'evidence_failed'
}

const NestedState = Annotation.Root({ input: Annotation<Record<string, any>>(), stepValues: Annotation<Record<string, any>>(), latest: Annotation<any>(), trace: Annotation<any[]>(), receipts: Annotation<any[]>(), errors: Annotation<any[]>(), graphComplete: Annotation<boolean>() })
type ChildResult = { ok: boolean; result: any; receipts?: any[]; error?: any; version?: any; graph_execution?: { complete: boolean } }

function graph(config: CompositionConfig, catalog: Catalog, call: (child: CompositionConfig, input: Record<string, any>, step: CompositionStep) => Promise<ChildResult>) {
  const steps = config.steps ?? []
  const nodes = steps.map(step => {
    const child = catalog.compositions.find(entry => entry.id === step.compositionId)?.versions?.find(version => version.versionId === step.versionId)?.config
    const metadata = { step: step.id, title: child?.title ?? step.compositionId, operationId: child?.toolName ?? '未选择已发布版本', input: step.inputMap, output: step.id,
      compositionId: step.compositionId, versionId: step.versionId, when: step.when ?? 'always' }
    return { id: step.id, metadata, run: async (state: typeof NestedState.State) => {
      const started = Date.now()
      if (!matches(step, state.latest)) return { trace: [...state.trace, { ...metadata, status: 'skipped', reason: '前置结果不满足执行条件' }] }
      try {
        const args = mappedInput(step.inputMap, state.input, state.stepValues)
        const value = await call(child!, args, step)
        return { stepValues: { ...state.stepValues, [step.id]: value.result }, latest: value.result, graphComplete: state.graphComplete && value.graph_execution?.complete !== false,
          receipts: [...state.receipts, ...(value.receipts ?? [])], errors: value.ok ? state.errors : [...state.errors, value.error ?? { code: 'stage_failed' }],
          trace: [...state.trace, { ...metadata, mappedArguments: args, status: !value.ok || value.result?.phase_status === 'failed' ? 'failed' : ['skipped', 'unknown'].includes(value.result?.phase_status) ? value.result.phase_status : 'succeeded', durationMs: Date.now() - started, version: value.version }] }
      } catch (error) {
        // 保留前序运行，后续 claimed/completed 节点仍可执行一次收尾。
        return { graphComplete: false, errors: [...state.errors, { code: 'stage_failed', message: error instanceof Error ? error.message : '子组合执行失败' }], trace: [...state.trace, { ...metadata, status: 'failed', durationMs: Date.now() - started }] }
      }
    } }
  })
  return compileSequence(NestedState, nodes)
}

export async function nestedStructure(config: CompositionConfig, catalog: Catalog) {
  const compiled = await graph(config, catalog, async () => { throw new Error('结构查询不可执行节点') }).getGraphAsync()
  return { nodes: Object.values(compiled.nodes).map((node: any) => ({ id: node.id, ...node.metadata })), edges: compiled.edges }
}

export async function executeNested(config: CompositionConfig, catalog: Catalog, input: Record<string, any>, call: Parameters<typeof graph>[2], extension?: CompositionExtension) {
  validateNested(config, catalog, new Set(), extension)
  const state = await graph(config, catalog, call).invoke({ input, stepValues: {}, latest: {}, trace: [], receipts: [], errors: [], graphComplete: true })
  const error = state.errors[0] ?? (!Object.keys(state.stepValues).length ? { code: 'composition_not_executed', message: '所有子步骤均被跳过，未产生运行结果' } : undefined)
  return { ok: !error, receipts: state.receipts, graph_complete: state.graphComplete, result: { ...state.latest, stepValues: state.stepValues, trace: state.trace }, ...(error ? { error } : {}) }
}
