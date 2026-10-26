/** 此固定路由只由工作流 SDK 注册的本地适配器执行，不连接模型服务。 */
export const CODE_ONLY_PROVIDER = 'harness-code-only'
export const CODE_ONLY_MODEL = 'workflow-v1'

export function isCodeOnlyModelRoute(route: any): boolean {
  return route?.provider === CODE_ONLY_PROVIDER && route?.model === CODE_ONLY_MODEL
}
