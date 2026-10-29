import { workspaceIdentity, workspaceOwnsCwd } from '../workspace.ts'
import { decisionExtractionToolParameters } from '../evaluation/decision-dataset-contract.ts'

const allowedNames = new Set(['skill', 'platform_agents'])
export const DECISION_EXTRACTION_ACTIONS = ['context', 'research/read-reference', 'datasets/source', 'datasets/preview', 'datasets/list']

/** 仅替换本轮模型看到的抽取接口说明，不改原生工具注册、执行与其他会话。 */
export function projectDecisionExtractionTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.map(tool => tool.name === 'platform_agents' ? {
    ...tool,
    description: '决策样本抽取接口。先读取固定 Run 的 datasets/source 与 extraction_contract.model_submission，逐页核对来源后，以 datasets/preview 每次提交一题：question_name、question、target 与 decision_id 等字段同级，不手写 samples 数组或 questions/targets 映射。预览通过后平台自动保存并回读；候选仍待人工逐题复核，datasets/list 可核对保存结果。',
    parameters: decisionExtractionToolParameters(DECISION_EXTRACTION_ACTIONS),
  } : tool)
}

type TaskScope = { apply(agent: any): void; release(agent: any): void; dispose(): void }

/** 同一 Agent 只持有一个任务作用域，切换时先撤销原生工具声明。 */
export function createExclusiveTaskScopes(scopes: TaskScope[]) {
  const active = new Map<any, TaskScope>()
  return {
    apply(agent: any, scope?: TaskScope) {
      const previous = active.get(agent)
      if (previous === scope) return
      previous?.release(agent)
      active.delete(agent)
      if (scope) {
        scope.apply(agent)
        active.set(agent, scope)
      }
    },
    release(agent: any) {
      for (const scope of scopes) scope.release(agent)
      active.delete(agent)
    },
    dispose() {
      for (const scope of scopes) scope.dispose()
      active.clear()
    },
  }
}

export function isDecisionExtraction(root: string, agent: any, state: any) {
  return belongsToTask(root, agent, state, 'decision-sample-extraction')
}
export function isComputeVariantResearch(root: string, agent: any, state: any) {
  return belongsToTask(root, agent, state, 'compute-variant-research')
}
export function isFeatureOrganization(root: string, agent: any, state: any) {
  return belongsToTask(root, agent, state, 'agent-maintenance') && state?.task_context?.workflow === 'features'
}
function belongsToTask(root: string, agent: any, state: any, skill: string) {
  return workspaceOwnsCwd(root, agent?.session?.header?.cwd) && (!state?.workspace_id || state.workspace_id === workspaceIdentity(root).id) && state?.task_context?.skill === skill
}
export const createExtractionScope = () => createTaskScope('decision-sample-extraction', '决策样本任务')
export const createComputeVariantScope = () => createTaskScope('compute-variant-research', '算力变体研究')

export const createFeatureScope = () => createTaskScope('agent-maintenance', '特性整理任务')
/** 专用任务复用 Runtime 工具作用域；动作与写入确认仍由各自平台接口负责。 */
function createTaskScope(skill: string, label: string, names = allowedNames) {
  const scopes = new Map<any, (() => void)[]>()
  return {
    apply(agent: any) {
      if (scopes.has(agent)) return
      const tools = agent.ctx?.tools
      if (!tools?.restrict || !tools?.guard || !tools?.presentAs) throw new Error(`当前 Runtime 缺少${label}所需的工具作用域能力`)
      const cleanup: (() => void)[] = []
      try {
        cleanup.push(tools.restrict({ allow: [...names] }))
        cleanup.push(tools.presentAs('native'))
        cleanup.push(tools.guard((execution: any) => names.has(execution.name) && (execution.name !== 'skill' || execution.arguments?.name === skill) ? undefined : `${label}仅允许读取指定技能和通过平台办理业务`))
        scopes.set(agent, cleanup)
      } catch (error) {
        for (const stop of cleanup.reverse()) stop()
        throw error
      }
    },
    release(agent: any) { const cleanup = scopes.get(agent); if (cleanup) { for (const stop of cleanup.reverse()) stop(); scopes.delete(agent) } },
    dispose() { for (const cleanup of scopes.values()) for (const stop of cleanup.reverse()) stop(); scopes.clear() },
  }
}
