/** 此固定路由只由工作流 SDK 注册的本地适配器执行，不连接模型服务。 */
export const CODE_ONLY_PROVIDER = 'harness-code-only'
export const CODE_ONLY_MODEL = 'workflow-v1'
export const HYBRID_WORKFLOW_PROVIDER = 'harness-workflow'
export const HYBRID_WORKFLOW_MODEL = 'hybrid-v1'

export function isCodeOnlyModelRoute(route: any): boolean {
  return route?.provider === CODE_ONLY_PROVIDER && route?.model === CODE_ONLY_MODEL
}

/** 混合图的外层适配器仍是本地派发；图内模型请求必须另行完整计量。 */
export function isHybridWorkflowRoute(route: any): boolean {
  return route?.provider === HYBRID_WORKFLOW_PROVIDER && route?.model === HYBRID_WORKFLOW_MODEL
}
