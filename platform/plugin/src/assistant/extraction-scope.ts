import { decisionExtractionToolParameters } from '../evaluation/decision-dataset-contract.ts'

export const DECISION_EXTRACTION_ACTIONS = ['context', 'research/read-reference', 'datasets/source', 'datasets/preview', 'datasets/list']

/** 仅替换本轮模型看到的抽取接口说明，不改原生工具注册、执行与其他会话。 */
export function projectDecisionExtractionTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.map(tool => tool.name === 'platform_agents' ? {
    ...tool,
    description: '决策样本抽取接口。先读取固定 Run 的 datasets/source 与 extraction_contract.model_submission，逐页核对来源后，以 datasets/preview 每次提交一题：question_name、question、target 与 decision_id 等字段同级，不手写 samples 数组或 questions/targets 映射。预览通过后平台自动保存并回读；候选仍待人工逐题复核，datasets/list 可核对保存结果。',
    parameters: decisionExtractionToolParameters(DECISION_EXTRACTION_ACTIONS),
  } : tool)
}

export function isComputeVariantExecution(state: any) {
  const task = state?.task_context
  return task?.skill === 'compute-variant-research' && task.generation_intent === 'implement' && task.planning_intent !== 'plan_only'
}
