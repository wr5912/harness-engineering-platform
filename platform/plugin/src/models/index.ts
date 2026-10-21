import { closeSync, fstatSync, lstatSync, openSync, realpathSync, rmSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ConnectionRpcHandler, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ProviderReadiness } from './projection.ts'
import { businessCatalogRoutes } from './catalog.ts'
import { BusinessDefaultError, businessPolicyLockFile, readBusinessDefault, saveBusinessDefault } from './business-default.ts'

type ModelRoute = Pick<ModelSelection, 'provider' | 'model'>
type MapValue = Record<string, unknown>

export interface ModelsDependencies {
  modelCatalog(): Promise<ModelCatalog>
  providerReadiness(providers: readonly string[]): Promise<Record<string, ProviderReadiness>>
  currentSelection(): ModelSelection
  saveSelection(selection: ModelSelection): Promise<void>
}

class ModelsError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

const ok = (value: MapValue): ConnectionRpcResult<MapValue> => ({ ok: true, value })
const fail = (code: string, message: string): ConnectionRpcResult<never> => ({ ok: false, error: { code, message, details: {} } })

function object(value: unknown, name: string): MapValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelsError('invalid_request', `${name}必须是对象`)
  return value as MapValue
}

function route(value: unknown, name: string): ModelRoute {
  const item = object(value, name)
  if (typeof item.provider !== 'string' || !item.provider.trim() || typeof item.model !== 'string' || !item.model.trim()) {
    throw new ModelsError('invalid_request', `${name}必须包含提供方和模型`)
  }
  return { provider: item.provider, model: item.model }
}

function selection(value: unknown): ModelSelection {
  const item = object(value, 'selection')
  const selected = route(item, 'selection')
  if (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string' || !item.reasoningEffort.trim())) {
    throw new ModelsError('invalid_request', '推理档位无效')
  }
  return item.reasoningEffort === undefined ? selected : { ...selected, reasoningEffort: item.reasoningEffort as string }
}

function availableModel(catalog: ModelCatalog, selected: ModelRoute) {
  return catalog.groups.find(group => group.id === selected.provider)?.models.find(model => model.id === selected.model)
}

function requireAvailable(catalog: ModelCatalog, selected: ModelRoute) {
  const model = availableModel(catalog, selected)
  if (!model) throw new ModelsError('model_unavailable', `模型 ${selected.provider}/${selected.model} 不在当前目录中`)
  return model
}

function requireSelection(catalog: ModelCatalog, selected: ModelSelection) {
  const model = requireAvailable(catalog, selected)
  if (selected.reasoningEffort !== undefined && !model.reasoning?.efforts.some(effort => effort.id === selected.reasoningEffort)) {
    throw new ModelsError('invalid_request', '所选模型不支持该推理档位')
  }
}

async function acquireLock(file: string, signal?: AbortSignal): Promise<number> {
  for (let attempt = 0; attempt <= 2400; attempt++) {
    if (signal?.aborted) throw new ModelsError('aborted', '模型操作已取消')
    try { return openSync(file, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 2400) throw new ModelsError('busy', `业务默认模型配置正在保存或实例正在启动；确认没有进程持锁后移除 ${basename(file)}，再重试`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw new ModelsError('busy', '业务默认模型配置锁未释放')
}

function releaseLock(file: string, descriptor: number) {
  try {
    try { if (lstatSync(file).ino === fstatSync(descriptor).ino) rmSync(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } finally { closeSync(descriptor) }
}

const platformOnlyProviders = (readiness: Record<string, ProviderReadiness>) =>
  new Set(Object.entries(readiness).filter(([, value]) => value.state === 'platform_only').map(([provider]) => provider))

/** 平台助手使用 DSH 原生默认；业务默认独立保存，业务可选范围来自当前原生目录。 */
export function createModelsHandler(assetRoot: string, deps: ModelsDependencies): ConnectionRpcHandler {
  const root = realpathSync(resolve(assetRoot))
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return fail('aborted', '模型操作已取消')
    try {
      const body = object(payload ?? {}, '请求参数')
      if (endpoint === 'list') {
        const catalog = await deps.modelCatalog()
        const providerReadiness = await deps.providerReadiness(catalog.groups.map(group => group.id))
        const business = readBusinessDefault(root)
        return ok({ catalog, provider_readiness: providerReadiness, platform_default: deps.currentSelection(),
          business_allowed: businessCatalogRoutes(catalog, platformOnlyProviders(providerReadiness)),
          business_default: business.default, business_model_revision: business.revision,
          migration_required: business.migrationRequired, legacy_default: business.legacyDefault })
      }
      if (endpoint === 'saveDefault') {
        const selected = selection(body.selection)
        requireSelection(await deps.modelCatalog(), selected)
        if (signal?.aborted) throw new ModelsError('aborted', '模型操作已取消')
        try { await deps.saveSelection(selected) } catch { throw new ModelsError('model_save_failed', '平台助手默认模型保存失败') }
        return ok({ platform_default: deps.currentSelection() })
      }
      if (endpoint === 'saveBusinessDefault') {
        const selected = selection(body.selection)
        if (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) throw new ModelsError('invalid_request', '业务默认模型配置修订摘要无效')
        if (selected) {
          const catalog = await deps.modelCatalog()
          const readiness = await deps.providerReadiness(catalog.groups.map(group => group.id))
          if (!businessCatalogRoutes(catalog, platformOnlyProviders(readiness)).some(item => item.provider === selected.provider && item.model === selected.model)) {
            throw new ModelsError('model_unavailable', '该模型不在当前可用于业务智能体的目录中')
          }
          requireSelection(catalog, selected)
        }
        if (signal?.aborted) throw new ModelsError('aborted', '模型操作已取消')
        const lockFile = businessPolicyLockFile(root)
        const lock = await acquireLock(lockFile, signal)
        try {
          const current = readBusinessDefault(root)
          if (current.revision !== body.revision) throw new ModelsError('conflict', '业务默认模型配置已变化，请刷新后重试')
          const saved = await saveBusinessDefault(root, selected, current.revision, signal)
          return ok({ business_default: saved.default, business_model_revision: saved.revision,
            migration_required: false, legacy_default: null })
        } finally { releaseLock(lockFile, lock) }
      }
      return fail('method_not_found', '未知模型操作')
    } catch (error) {
      if (error instanceof ModelsError) return fail(error.code, error.message)
      if (error instanceof BusinessDefaultError) return fail(error.code, error.message)
      return fail('model_operation_failed', '模型配置操作失败')
    }
  }
}
