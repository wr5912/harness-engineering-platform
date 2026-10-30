import { load } from 'js-yaml'

export interface LocalModelRoute { provider: string; model: string }

/** 业务装载与封存证据读取共用的本地能力声明合同。 */
export function parseLocalCapabilities(content: string): { localTools: string[]; localModelRoutes: LocalModelRoute[] } {
  const value = load(content) as any
  const declared = value?.runtime_capabilities
  if (declared === undefined) return { localTools: [], localModelRoutes: [] }
  const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
  const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/
  const modelPattern = /^[A-Za-z0-9/][A-Za-z0-9._:/+@-]{0,255}$/
  const tools = declared?.local_tools, routes = declared?.local_model_routes
  if (!declared || Array.isArray(declared) || Object.keys(declared).sort().join(',') !== 'local_model_routes,local_tools'
    || !Array.isArray(tools) || tools.length > 32 || tools.some(name => typeof name !== 'string' || !namePattern.test(name))
    || new Set(tools).size !== tools.length || !Array.isArray(routes) || routes.length > 16
    || routes.some(route => !route || Array.isArray(route) || Object.keys(route).sort().join(',') !== 'model,provider'
      || typeof route.provider !== 'string' || !providerPattern.test(route.provider)
      || typeof route.model !== 'string' || !modelPattern.test(route.model))
    || new Set(routes.map(route => `${route.provider}\0${route.model}`)).size !== routes.length) {
    throw new Error('业务本地能力声明无效')
  }
  return { localTools: tools, localModelRoutes: routes }
}
