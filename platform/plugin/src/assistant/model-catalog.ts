type MapValue = Record<string, any>
const readinessStates = new Set(['ready', 'runtime_check', 'missing_api_key', 'platform_only', 'unknown'])
const record = (value: unknown): MapValue => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const label = (value: unknown) => typeof value === 'string' && value ? value : undefined
function selection(value: unknown) {
  const selected = record(value), provider = label(selected.provider), model = label(selected.model), effort = label(selected.reasoningEffort)
  return provider && model ? { provider, model, ...(effort ? { reasoningEffort: effort } : {}) } : null
}

/** 只投影现有公开目录；连接配置、凭据和提供方原始错误不进入管理上下文。 */
export async function assistantModelCatalog(read: () => Promise<any>, signal: AbortSignal) {
  const source = 'models/list', observed_at = new Date().toISOString()
  try {
    signal.throwIfAborted()
    const result = await read()
    signal.throwIfAborted()
    const value = record(result.value), catalog = record(value.catalog)
    if (!result.ok || !Array.isArray(catalog.groups) || !Array.isArray(value.business_allowed)) throw new Error('目录读取失败')
    const groups = catalog.groups.map(record)
    const models = value.business_allowed.flatMap((route: unknown) => {
      const selected = selection(route)
      if (!selected) return []
      const group = groups.find(group => group.id === selected.provider)
      const model = Array.isArray(group?.models) ? group.models.map(record).find((model: MapValue) => model.id === selected.model) : undefined
      if (!model) return []
      const nativeReasoning = record(model.reasoning)
      const efforts = (Array.isArray(nativeReasoning.efforts) ? nativeReasoning.efforts : []).flatMap((item: unknown) => {
        const effort = record(item), id = label(effort.id), name = label(effort.name)
        return id ? [{ id, ...(name ? { name } : {}) }] : []
      })
      const state = record(record(value.provider_readiness)[selected.provider]).state
      return [{ provider: selected.provider, model: selected.model, ...(label(group?.name) ? { provider_name: group!.name } : {}),
        ...(label(model.name) ? { name: model.name } : {}), reasoning: { efforts, ...(label(nativeReasoning.defaultEffort) ? { defaultEffort: nativeReasoning.defaultEffort } : {}) },
        readiness: readinessStates.has(state) ? state : 'unknown' }]
    })
    return { status: 'available', source, observed_at, models, business_default: selection(value.business_default),
      partial: Array.isArray(catalog.failures) && catalog.failures.length > 0, runtime_verified: false,
      note: '路由及推理档位来自当前原生模型目录；readiness 只表示配置状态。按原样使用 provider/model/reasoningEffort，不修改全局默认；实际调用仍须在目标实例验证。' }
  } catch {
    signal.throwIfAborted()
    return { status: 'unavailable', source, observed_at, models: [], business_default: null, runtime_verified: false,
      note: '当前模型目录读取失败，请稍后重试 platform_agents context；不从内部配置文件猜测模型路由或推理档位。' }
  }
}
