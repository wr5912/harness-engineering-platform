import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'

type ModelRoute = Pick<ModelSelection, 'provider' | 'model'>

type SettingsView = { ns: string; value: unknown }

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

/**
 * DSH 的 session modelCatalog 只列出原生可路由组；可配置的
 * llm-pi-ai Provider 仍是平台设置的一部分，必须合并进同一目录，
 * 否则保存的业务默认模型无法被实例投影核对。
 */
export function configuredModelCatalog(catalog: ModelCatalog, namespaces: readonly SettingsView[]): ModelCatalog {
  const pi = record(namespaces.find(item => item.ns === 'llm-pi-ai')?.value)
  const providers = record(pi.providers)
  const groups = [...catalog.groups] as any[]
  const known = new Set(groups.map(group => group.id))
  for (const [id, value] of Object.entries(providers)) {
    if (known.has(id)) continue
    const provider = record(value)
    const models = Array.isArray(provider.models) ? provider.models.flatMap((item: unknown) => {
      const model = record(item)
      if (typeof model.id !== 'string' || !model.id) return []
      const configuredEfforts = Array.isArray(model.reasoningEfforts)
        ? model.reasoningEfforts.filter((effort: unknown) => typeof effort === 'string' && effort).map((effort: string) => ({ id: effort, name: effort }))
        : undefined
      return [{ id: model.id, ...(typeof model.name === 'string' ? { name: model.name } : {}),
        ...(configuredEfforts?.length ? { reasoning: { efforts: configuredEfforts } } : { reasoning: { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' } }) }]
    }) : []
    if (models.length) groups.push({ id, name: typeof provider.displayName === 'string' ? provider.displayName : id, models })
  }
  const routableProviders = [...new Set([...catalog.routableProviders, ...groups.map(group => group.id)])]
  return { ...catalog, groups, routableProviders }
}

/** 业务模型范围每次从当前 DSH 目录派生，不保留隐藏的可编辑清单。 */
export function businessCatalogRoutes(catalog: ModelCatalog, platformOnly: ReadonlySet<string> = new Set()): ModelRoute[] {
  const routable = new Set(catalog.routableProviders)
  return catalog.groups.filter(group => routable.has(group.id) && group.id !== 'deepseek-account' && !platformOnly.has(group.id))
    .flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
}
