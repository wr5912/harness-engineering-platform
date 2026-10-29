import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ModelCatalog, ModelSelection } from '@deepseek-ai/dsh-api-session-controller'
import { CHANNEL } from '../protocol.ts'
import { modelSettingsTheme } from './style.ts'

type ModelRef = Pick<ModelSelection, 'provider' | 'model'>
type ProviderReadiness = { state: 'ready' | 'runtime_check' | 'missing_api_key' | 'platform_only' | 'unknown'; message: string }
type ModelList = { catalog: ModelCatalog; provider_readiness?: Record<string, ProviderReadiness>; platform_default: ModelSelection | null;
  business_allowed: ModelRef[]; business_default: ModelSelection | null; business_model_revision: string;
  migration_required: boolean; legacy_default: ModelSelection | null }
type Draft<T> = { base: T; value: T; revision?: unknown }
type BusinessDraft = Draft<ModelSelection | null> & { edited?: boolean }
type BusinessSnapshot = Pick<ModelList, 'business_default' | 'business_model_revision' | 'migration_required' | 'legacy_default'>
type SaveOutcome = { kind: 'verified'; value: ModelList } | { kind: 'rejected' | 'unknown' | 'unverified'; message: string }
type Status = { tone: 'success' | 'warning' | 'error'; text: string; selection?: ModelSelection } | null
type ChangeSource = { getSnapshot(): number; subscribe(listener: () => void): () => void }

const modelKey = (value: ModelRef) => JSON.stringify([value.provider, value.model])
const sameSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left === right || Boolean(left && right && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort)
const route = (catalog: ModelCatalog, value: ModelRef) => catalog.groups.find(group => group.id === value.provider)?.models.find(model => model.id === value.model)
const modelName = (catalog: ModelCatalog, value: ModelRef) => {
  const group = catalog.groups.find(item => item.id === value.provider)
  const model = group?.models.find(item => item.id === value.model)
  return `${group?.name || value.provider} · ${model?.name || value.model}`
}
const catalogModels = (catalog: ModelCatalog) => catalog.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })))
export const selectedFromKey = (catalog: ModelCatalog, key: string, previous: ModelSelection | null): ModelSelection | null => {
  if (!key) return null
  const found = catalogModels(catalog).find(item => modelKey(item) === key)
  if (!found) return null
  const reasoning = route(catalog, found)?.reasoning
  const effort = previous && modelKey(previous) === key && previous.reasoningEffort
    && reasoning?.efforts.some(item => item.id === previous.reasoningEffort) ? previous.reasoningEffort : reasoning?.defaultEffort
  return { ...found, ...(effort ? { reasoningEffort: effort } : {}) }
}

export function modelPolicyIssue(catalog: ModelCatalog, allowed: readonly ModelRef[], selected: ModelSelection | null): string {
  if (!selected) return '请选择业务智能体统一默认模型。'
  if (selected.provider === 'deepseek-account') return 'DeepSeek 账号登录模型只供平台助手使用。'
  if (!allowed.some(item => modelKey(item) === modelKey(selected)) || !route(catalog, selected)) return '所选模型已不在当前业务可用目录中，请重新选择。'
  const model = route(catalog, selected)
  if (selected.reasoningEffort && !model?.reasoning?.efforts.some(item => item.id === selected.reasoningEffort)) return '统一默认模型的推理档位已不可用，请重新选择。'
  return ''
}

const unknownReadiness: ProviderReadiness = { state: 'unknown', message: '连接状态尚未核对，请刷新模型目录。' }
const providerReadiness = (items: ModelList['provider_readiness'], provider: string): ProviderReadiness => items?.[provider] ?? unknownReadiness
export function businessConnectionState(defaultModel: ModelSelection | null, items: ModelList['provider_readiness']) {
  if (!defaultModel) return { kind: 'unconfigured' as const, label: '尚未设置业务默认模型', description: '请从当前业务可用目录中选择默认模型。' }
  const selected = providerReadiness(items, defaultModel.provider)
  if (selected.state !== 'ready' && selected.state !== 'runtime_check') return {
    kind: 'blocked' as const, label: '所选默认模型连接未就绪', description: `${selected.message}可先保存选择，创建实例前需使该提供方连接就绪。`,
  }
  if (selected.state === 'runtime_check') return { kind: 'runtime_check' as const, label: '所选默认模型需调用核对',
    description: '启动配置可投影；仍需在实例中实际调用核对。实例另选模型时也需分别核对连接。' }
  return { kind: 'ready' as const, label: '所选默认模型启动配置就绪',
    description: '默认模型的连接配置可解析；创建或重启实例后仍需核对实际模型调用。实例另选模型时也需分别核对连接。' }
}

function readStored<T>(key: string): Draft<T> | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) || 'null')
    return value && typeof value === 'object' && 'base' in value && 'value' in value ? value as Draft<T> : null
  } catch { return null }
}
function keepStored<T>(key: string, draft: Draft<T> | null) {
  try { if (draft) sessionStorage.setItem(key, JSON.stringify(draft)); else sessionStorage.removeItem(key) } catch { /* 无存储权限时仍保留本页草稿。 */ }
}

export function platformDefaultState(raw: Draft<ModelSelection | null>, current: ModelSelection | null) {
  const clean = sameSelection(raw.value, current) || sameSelection(raw.base, raw.value)
  const alreadyCurrent = sameSelection(raw.base, current) && sameSelection(raw.value, current)
  const draft = clean && !alreadyCurrent ? { base: current, value: current } : raw
  const dirty = !sameSelection(draft.value, current)
  return { draft, dirty, stale: dirty && !sameSelection(draft.base, current), stored: dirty ? draft : null }
}

function initialBusinessDraft(data: BusinessSnapshot): BusinessDraft {
  return { base: data.business_default,
    value: data.migration_required && data.legacy_default ? data.legacy_default : data.business_default,
    revision: data.business_model_revision, edited: false }
}

export function businessDefaultState(raw: BusinessDraft, data: BusinessSnapshot) {
  const initial = initialBusinessDraft(data)
  const legacyPreselection = data.migration_required && sameSelection(raw.base, data.business_default)
    && sameSelection(raw.value, data.legacy_default)
  const edited = raw.edited ?? (!sameSelection(raw.base, raw.value) && !legacyPreselection)
  let draft: BusinessDraft = raw
  if (!edited || (!data.migration_required && sameSelection(raw.value, data.business_default))) {
    if (raw.edited !== false || raw.revision !== initial.revision
      || !sameSelection(raw.base, initial.base) || !sameSelection(raw.value, initial.value)) draft = initial
  } else if (sameSelection(raw.base, data.business_default)) {
    if (raw.revision !== data.business_model_revision || raw.edited !== true) {
      draft = { ...raw, revision: data.business_model_revision, edited: true }
    }
  } else if (raw.edited !== true) draft = { ...raw, edited: true }
  const dirty = Boolean(draft.edited && !sameSelection(draft.value, data.business_default))
  const stale = dirty && !sameSelection(draft.base, data.business_default)
  return { draft, dirty, stale, stored: dirty ? draft : null }
}

export function statusAfterRead(status: Status, current: ModelSelection | null): Status {
  return status?.tone === 'success' && status.selection && sameSelection(status.selection, current) ? status : null
}

function ModelOptions({ catalog, value, onChange, allowed, disabled }: { catalog: ModelCatalog; value: ModelSelection | null; onChange(value: ModelSelection | null): void; allowed?: readonly ModelRef[]; disabled?: boolean }) {
  const choices = allowed ? new Set(allowed.map(modelKey)) : null
  const selected = value ? modelKey(value) : ''
  const missing = value && (!route(catalog, value) || Boolean(choices && !choices.has(selected)))
  return <select value={selected} disabled={disabled} onChange={event => onChange(selectedFromKey(catalog, event.target.value, value))}>
    <option value="">请选择模型</option>
    {missing && <option value={selected} disabled>原默认模型当前不可选：{value.provider} / {value.model}</option>}
    {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
      {group.models.filter(model => !choices || choices.has(modelKey({ provider: group.id, model: model.id }))).map(model =>
        <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>{model.name}{model.name !== model.id ? ` (${model.id})` : ''}</option>)}
    </optgroup>)}
  </select>
}

function ModelEffort({ catalog, value, onChange, disabled }: { catalog: ModelCatalog; value: ModelSelection | null; onChange(value: ModelSelection): void; disabled?: boolean }) {
  if (!value) return null
  const reasoning = route(catalog, value)?.reasoning
  const efforts = reasoning?.efforts ?? []
  if (!efforts.length && !value.reasoningEffort) return null
  const selected = value.reasoningEffort ?? ''
  const missing = Boolean(selected && !efforts.some(item => item.id === selected))
  const defaultName = efforts.find(item => item.id === reasoning?.defaultEffort)?.name
  return <label className="hep-model-sharing-field"><span>推理档位</span><select value={selected} disabled={disabled} onChange={event => onChange({ provider: value.provider, model: value.model, ...(event.target.value ? { reasoningEffort: event.target.value } : {}) })}>
    <option value="">使用模型默认档位{defaultName ? `（${defaultName}）` : ''}</option>
    {missing && <option value={selected} disabled>原档位当前不可选：{selected}</option>}
    {efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
  </select></label>
}

function StatusLine({ status }: { status: Status }) {
  return status && <p className="hep-model-sharing-status" data-tone={status.tone} role={status.tone === 'error' ? 'alert' : 'status'}>{status.text}</p>
}

function PlatformDefault({ data, save, writable }: { data: ModelList; save(payload: unknown): Promise<SaveOutcome>; writable: boolean }) {
  const storageKey = 'hep-model-settings:platform-default'
  const [rawDraft, setDraft] = useState<Draft<ModelSelection | null>>(() => readStored(storageKey) ?? { base: data.platform_default, value: data.platform_default })
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const { draft, dirty, stale, stored } = platformDefaultState(rawDraft, data.platform_default)
  const selectedModel = draft.value && route(data.catalog, draft.value)
  const valid = Boolean(selectedModel && (!draft.value?.reasoningEffort || selectedModel.reasoning?.efforts.some(item => item.id === draft.value?.reasoningEffort)))
  useEffect(() => {
    setDraft(current => platformDefaultState(current, data.platform_default).draft)
    setStatus(current => statusAfterRead(current, data.platform_default))
  }, [data])
  useEffect(() => { keepStored(storageKey, stored) }, [stored])
  const submit = async () => {
    if (!draft.value || !valid || stale || busy) return
    setBusy(true); setStatus(null)
    const requested = draft.value
    const result = await save({ selection: requested })
    setBusy(false)
    if (result.kind === 'verified') {
      if (sameSelection(result.value.platform_default, requested)) {
        setDraft({ base: result.value.platform_default, value: result.value.platform_default })
        setStatus({ tone: 'success', text: '已保存并回读平台助手默认模型。新建管理会话将使用该默认模型。', selection: requested })
      } else setStatus({ tone: 'error', text: '保存后回读的默认模型与所选值不同，请刷新核对。' })
    } else setStatus({ tone: result.kind === 'unknown' || result.kind === 'unverified' ? 'warning' : 'error', text: result.message })
  }
  return <section className="hep-model-sharing-card" aria-labelledby="hep-platform-default-title">
    <div className="hep-model-sharing-card-header"><div><h4 id="hep-platform-default-title">平台 AI 助手</h4><p className="hep-model-sharing-note">可从上方原生目录选择任一模型；实际调用取决于平台连接配置。</p></div><span>目录模型均可选</span></div>
    <label className="hep-model-sharing-field"><span>默认模型</span><ModelOptions catalog={data.catalog} value={draft.value} disabled={busy} onChange={value => { setDraft(current => ({ ...platformDefaultState(current, data.platform_default).draft, value })); setStatus(null) }} /></label>
    <ModelEffort catalog={data.catalog} value={draft.value} disabled={busy} onChange={value => { setDraft(current => ({ ...platformDefaultState(current, data.platform_default).draft, value })); setStatus(null) }}/>
    {!valid && <p className="hep-model-sharing-status" data-tone="warning">当前默认模型或推理档位不在目录中，请重新选择。</p>}
    {stale && <p className="hep-model-sharing-status" data-tone="warning">配置已在别处变化。未保存选择仍保留；请重新核对后放弃旧草稿。</p>}
    {dirty && <p className="hep-model-sharing-status" data-tone="warning">有未保存修改，关闭设置后仍会保留本次选择。</p>}
    <div className="hep-model-sharing-actions"><button className="hep-model-sharing-primary" type="button" disabled={!writable || !dirty || !valid || stale || busy} onClick={() => void submit()}>{busy ? '正在保存并核对…' : '保存平台助手默认模型'}</button>
      {dirty && <button type="button" disabled={busy} onClick={() => { setDraft({ base: data.platform_default, value: data.platform_default }); setStatus(null) }}>放弃修改</button>}</div>
    <StatusLine status={status}/>
  </section>
}

function BusinessDefaultEditor({ data, save, writable }: { data: ModelList; save(payload: unknown): Promise<SaveOutcome>; writable: boolean }) {
  const storageKey = 'hep-model-settings:business-default-v3'
  const [rawDraft, setDraft] = useState<BusinessDraft>(() => readStored<BusinessDraft['value']>(storageKey) ?? initialBusinessDraft(data))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const { draft, dirty, stale, stored } = businessDefaultState(rawDraft, data)
  const issue = modelPolicyIssue(data.catalog, data.business_allowed, draft.value)
  useEffect(() => {
    setDraft(current => businessDefaultState(current, data).draft)
    setStatus(current => statusAfterRead(current, data.business_default))
  }, [data])
  useEffect(() => { keepStored(storageKey, stored) }, [stored])
  const submit = async () => {
    if (issue || stale || busy) return
    setBusy(true); setStatus(null)
    const requested = draft.value
    const result = await save({ selection: requested, revision: draft.revision })
    setBusy(false)
    if (result.kind === 'verified') {
      if (!result.value.migration_required && sameSelection(result.value.business_default, requested)) {
        setDraft({ base: requested, value: requested, revision: result.value.business_model_revision, edited: false })
        setStatus({ tone: 'success', text: '业务智能体统一默认模型已保存并回读。新建实例将预选该模型；现有实例仍使用各自登记的默认模型。', selection: requested ?? undefined })
      } else setStatus({ tone: 'error', text: '保存后回读的默认模型与所选值不同，请刷新核对。' })
    } else setStatus({ tone: result.kind === 'unknown' || result.kind === 'unverified' ? 'warning' : 'error', text: result.message })
  }
  const connection = businessConnectionState(draft.value, data.provider_readiness)
  return <section className="hep-model-sharing-card" aria-labelledby="hep-business-default-title">
    <div className="hep-model-sharing-card-header"><div><h4 id="hep-business-default-title">业务智能体统一默认</h4>
      <p className="hep-model-sharing-note">统一默认只有一个，保存新选择会替换旧选择。新建实例预选该模型；创建或管理单个实例时可从当前业务可用目录另选，现有实例继续使用各自登记的默认模型。</p></div><span>新建实例预选</span></div>
    {data.migration_required && <p className="hep-model-sharing-status" data-tone="warning" role="status">当前设置需确认新的统一默认模型。旧值仅作预选，不会自动用于新实例。{data.legacy_default ? `旧默认：${modelName(data.catalog, data.legacy_default)}。` : ''}</p>}
    <div className="hep-model-sharing-connection-state" data-state={connection.kind} role="status"><strong>{connection.label}</strong><p>{connection.description}</p></div>
    <label className="hep-model-sharing-field"><span>统一默认模型</span><ModelOptions catalog={data.catalog} allowed={data.business_allowed} value={draft.value} disabled={busy}
      onChange={value => { setDraft(current => ({ ...businessDefaultState(current, data).draft, value, edited: true })); setStatus(null) }}/></label>
    <ModelEffort catalog={data.catalog} value={draft.value} disabled={busy} onChange={value => { setDraft(current => ({ ...businessDefaultState(current, data).draft, value, edited: true })); setStatus(null) }}/>
    {!data.business_allowed.length && <p className="hep-model-sharing-status" data-tone="warning">当前 DSH 模型目录没有可用于业务实例的模型，请先配置模型连接。</p>}
    {issue && draft.value && <p className="hep-model-sharing-status" data-tone="warning">{issue}</p>}
    {stale && <p className="hep-model-sharing-status" data-tone="warning">默认模型已在别处变化。未保存选择仍保留；请核对当前设置后放弃旧草稿，再重新选择。</p>}
    {dirty && <p className="hep-model-sharing-status" data-tone="warning">有未保存修改，关闭设置后仍会保留本次选择。</p>}
    <div className="hep-model-sharing-actions"><button className="hep-model-sharing-primary" type="button" disabled={!writable || (!dirty && !data.migration_required) || Boolean(issue) || stale || busy}
      onClick={() => void submit()}>{busy ? '正在保存并核对…' : '保存业务智能体统一默认'}</button>
      {dirty && <button type="button" disabled={busy} onClick={() => { setDraft(initialBusinessDraft(data)); setStatus(null) }}>放弃修改</button>}</div>
    <StatusLine status={status}/>
  </section>
}

export function ModelsSettingsFooter({ rpc, changes }: { rpc: ClientConnectionRpc; changes: ChangeSource }) {
  const [data, setData] = useState<ModelList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const currentRequest = useRef(0)
  const version = useSyncExternalStore(changes.subscribe, changes.getSnapshot)
  const read = useCallback(async (): Promise<ModelList> => {
    const request = ++currentRequest.current
    setLoading(true)
    try {
      const result = await rpc.call(CHANNEL, 'models/list', {})
      if (!result.ok) throw new Error(result.error.message || '模型设置读取失败')
      const value = result.value as ModelList
      if (!value || !value.catalog || !Array.isArray(value.catalog.groups) || !Array.isArray(value.business_allowed)
        || typeof value.business_model_revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.business_model_revision)
        || typeof value.migration_required !== 'boolean'
        || (value.business_default !== null && (!value.business_default || typeof value.business_default.provider !== 'string'
          || typeof value.business_default.model !== 'string'))) throw new Error('模型设置响应格式不正确')
      if (request === currentRequest.current) { setData(value); setError(''); setLoading(false) }
      return value
    } catch (cause) {
      if (request === currentRequest.current) { setError(cause instanceof Error ? cause.message : '读取失败'); setLoading(false) }
      throw cause
    }
  }, [rpc])
  useEffect(() => { void read().catch(() => {}) }, [read, version])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { currentRequest.current++; window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  const save = async (method: 'models/saveDefault' | 'models/saveBusinessDefault', payload: unknown): Promise<SaveOutcome> => {
    let result: Awaited<ReturnType<ClientConnectionRpc['call']>>
    try { result = await rpc.call(CHANNEL, method, payload) }
    catch { return { kind: 'unknown', message: '连接中断，写入结果未知。草稿已保留，请刷新核对；不会自动重发。' } }
    if (!result.ok) return { kind: 'rejected', message: result.error.message || '保存失败，请核对设置后重试。' }
    try { return { kind: 'verified', value: await read() } }
    catch { return { kind: 'unverified', message: '请求已提交，但回读失败，当前结果尚未核对。草稿已保留，请刷新确认。' } }
  }
  const writable = online && !loading && !error
  return <section className="hep-model-sharing" aria-labelledby="hep-model-sharing-title" aria-busy={loading}>
    <style>{modelSettingsTheme}</style>
    <div className="hep-model-sharing-heading"><div><h3 id="hep-model-sharing-title">模型默认设置</h3><p className="hep-model-sharing-intro">平台助手和业务智能体共享上方 DSH 模型目录。业务实例可使用其中当前已配置且可路由的模型；账号登录模型仅供平台助手。</p></div>
      <div className="hep-model-sharing-heading-actions">{loading && data && <LoadingIndicator label="刷新模型目录和业务设置" />}<button type="button" disabled={loading} onClick={() => void read().catch(() => {})}>刷新</button></div></div>
    {!online && <p className="hep-model-sharing-status" data-tone="warning" role="status">当前离线。草稿仍保留，连接恢复后刷新再保存。</p>}
    {loading && !data && <LoadingIndicator label="读取模型目录和业务设置" block />}
    {error && <p className="hep-model-sharing-status" data-tone="error" role="alert">读取失败：{error}。{data ? '显示上次成功读取的配置；请刷新后再保存。' : '请刷新重试。'}</p>}
    {data && <>
      {data.catalog.failures.length > 0 && <div className="hep-model-sharing-failures">以下提供方模型目录读取失败，不能新增选择：<ul>{data.catalog.failures.map(item => <li key={item.id}>{item.name}：{item.message}</li>)}</ul></div>}
      {data.catalog.groups.length === 0 && <p className="hep-model-sharing-status" data-tone="warning">当前没有可用模型。请先在上方配置提供方和模型。</p>}
      <PlatformDefault data={data} writable={writable} save={payload => save('models/saveDefault', payload)}/>
      <BusinessDefaultEditor data={data} writable={writable} save={payload => save('models/saveBusinessDefault', payload)}/>
    </>}
  </section>
}
