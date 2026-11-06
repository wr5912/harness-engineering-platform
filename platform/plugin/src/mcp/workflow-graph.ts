import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { CompositionConfig } from './compositions.ts'
import type { WorkflowContext } from './extension.ts'

const State = Annotation.Root({
  input: Annotation<Record<string, any>>(),
  values: Annotation<Record<string, any>>({ reducer: (left, right) => ({ ...left, ...right }), default: () => ({}) }),
  result: Annotation<Record<string, any>>(),
})
export type WorkflowState = typeof State.State
type Node = {
  id: string; title: string; kind: string
  description?: string; compositionId?: string; versionId?: string; input?: Record<string, unknown>; output?: string
  subgraph?: { getGraphAsync(): Promise<any> }
  run(state: WorkflowState): Promise<Partial<WorkflowState>> | Partial<WorkflowState>
  route?: { select(state: WorkflowState): string; paths: Record<string, string> }
}

/** 同一份可执行图提供画布和运行；查询结构只编译，不调用节点。 */
export function compileWorkflow(nodes: Node[], edges: { source: string | string[]; target: string }[], context?: WorkflowContext) {
  const graph: any = new StateGraph(State)
  for (const { run, route: _route, ...metadata } of nodes) {
    graph.addNode(metadata.id, async (state: WorkflowState) => {
      const current = context && { ...context, nodeId: `${context.nodeId}/${metadata.id}` }
      current?.signal.throwIfAborted()
      if (metadata.kind !== 'composition') current?.progress({ status: 'running', title: metadata.title })
      try {
        const value = await run(state)
        if (metadata.kind !== 'composition') current?.progress({ status: 'completed' })
        return value
      } catch (error) {
        current?.progress({ status: 'failed', error: error instanceof Error ? error.message : '步骤执行失败' })
        throw error
      }
    }, { metadata })
  }
  for (const edge of edges) graph.addEdge(edge.source as any, edge.target as any)
  for (const node of nodes) if (node.route) graph.addConditionalEdges(node.id as any, node.route.select, node.route.paths as any)
  return graph.compile({ checkpointer: false })
}

export async function workflowStructure(compiled: ReturnType<typeof compileWorkflow>): Promise<{ nodes: any[]; edges: any[] }> {
  const graph = await compiled.getGraphAsync()
  return { nodes: await Promise.all(Object.values(graph.nodes).map(async (node: any) => {
    const { subgraph, ...metadata } = node.metadata ?? {}
    return { id: node.id, ...metadata, ...(subgraph ? { subgraph: await workflowStructure(subgraph) } : {}) }
  })), edges: graph.edges }
}

export function defineWorkflow(create: (config: CompositionConfig, context?: WorkflowContext) => ReturnType<typeof compileWorkflow>) {
  return {
    async structure(config: CompositionConfig) {
      return workflowStructure(create(config))
    },
    async execute(input: Record<string, any>, config: CompositionConfig, context: WorkflowContext) {
      const state = await create(config, context).invoke({ input, values: {} }, { signal: context.signal })
      return state.result
    },
  }
}
export { START, END }
