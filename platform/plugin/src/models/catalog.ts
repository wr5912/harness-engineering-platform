import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

type ModelRoute = Pick<ModelSelection, 'provider' | 'model'>

/** 业务模型范围每次从当前 DSH 目录派生，不保留隐藏的可编辑清单。 */
export function businessCatalogRoutes(catalog: ModelCatalog, platformOnly: ReadonlySet<string> = new Set()): ModelRoute[] {
  const routable = new Set(catalog.routableProviders)
  return catalog.groups.filter(group => routable.has(group.id) && group.id !== 'deepseek-account' && !platformOnly.has(group.id))
    .flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
}
