import { GeneratedCodeBrowser } from '../components/generated-code-browser.tsx'
import { useEffect, useRef, useState } from 'react'
import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { Manager } from 'harness-mcp-manager-client'
import { copyText } from '../../../../plugins/mcp-manager/clipboard.ts'
import { SearchSelect } from '../components/search-select.tsx'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { CompositionCanvas } from './graph-canvas.tsx'
import { CompositionPanel, useCompositionFullscreen, useCompositionNarrow } from './composition-workbench.tsx'
import { PasswordInput } from './components.tsx'
import { CHANNEL, type PlatformNavigation, type PlatformPageProps } from '../protocol.ts'
import type { CompositionConfig, CompositionEntry } from './compositions.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { useQueuedRefresh } from '../realtime/refresh.ts'
import { compositionTestInput, isThreatComposition, ThreatConfigurationFields, ThreatRunResult, threatEditorStyle } from './threat-editor.tsx'

type LivePageProps = { updates?: PlatformUpdates; onContext?(context: Record<string, unknown>): void }
type NavigationProps = { target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void; active?: boolean }
type CompositionAttempt = { execution_id: string; selection_key: string; asset: string; payload: any; state: 'running' | 'unknown' | 'responded'; run_ids?: string[]; message?: string }

function transportDetail(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '运行时未提供错误详情，请查看平台日志'
}

const tabs = [
  { id: 'servers', title: '服务列表' },
  { id: 'groups', title: '工具与资源分组' },
  { id: 'connection', title: '服务与分组 MCP 调试' },
  { id: 'composition', title: '工具组合编排' },
] as const

export function McpPage({ rpc, updates, onContext, target, onNavigate, active = true }: PlatformPageProps & LivePageProps & NavigationProps) {
  const [state, setState] = useState<any>({ status: 'loading' })
  const [page, setPage] = useState<string>(tabs.some(tab => tab.id === target?.tab) ? target!.tab! : 'servers')
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null)
  const [publishedService, setPublishedService] = useState<any>(null)
  const [serviceError, setServiceError] = useState('')
  const managerRoot = useRef<HTMLDivElement>(null)
  const lastServer = useRef<string | undefined>(target?.server_id)
  const lastGroup = useRef<string | undefined>(target?.group_id)
  const locatedServer = useRef('')
  const lastComposition = useRef<{ composition_id: string; version?: 'draft' | 'published'; version_id?: string } | null>(null)
  const compositionContext = useCallback((context: Record<string, unknown>) => {
    if (typeof context.composition_id === 'string') lastComposition.current = {
      composition_id: context.composition_id,
      ...(context.version === 'draft' || context.version === 'published' ? { version: context.version } : {}),
      ...(typeof context.version_id === 'string' ? { version_id: context.version_id } : {}),
    }
    onContext?.(context)
  }, [onContext])
  const [serviceLoaded, setServiceLoaded] = useState(false)
  useEffect(() => {
    if (active && target?.page === 'mcp' && tabs.some(tab => tab.id === target.tab)) setPage(target.tab!)
  }, [active, target?.page, target?.tab])
  const refreshConfiguration = useQueuedRefresh(active, async () => {
    await Promise.allSettled([
      rpc.call(CHANNEL, 'mcp/configuration', {}).then(response => {
        setState(response.ok ? { status: 'ready', writable: true, ...(response.value as object) }
          : (previous: any) => previous.status === 'ready' ? { ...previous, error: response.error.message }
            : { status: 'unavailable', error: response.error.message })
      }).catch(error => setState((previous: any) => previous.status === 'ready'
        ? { ...previous, error: `读取 MCP 数据配置失败：${transportDetail(error)}` }
        : { status: 'unavailable', error: `读取 MCP 数据配置失败：${transportDetail(error)}` })),
      page === 'composition' ? Promise.resolve() : rpc.call(CHANNEL, 'mcp/list', {}).then(response => {
        if (response.ok) { setPublishedService((response.value as any).publishedService ?? null); setServiceError(''); setServiceLoaded(true) }
        else setServiceError(response.error.message)
      }).catch(error => setServiceError(`读取已发布组合服务失败：${transportDetail(error)}`)),
    ])
  })
  useEffect(() => { void refreshConfiguration() }, [rpc])
  useEffect(() => updates?.subscribe(() => {
    if (updates.getSnapshot().domains.includes('mcp')) void refreshConfiguration()
  }), [updates])
  useEffect(() => {
    if (active && page !== 'composition') onContext?.({ page: 'mcp', tab: page, server_id: target?.server_id, group_id: target?.group_id })
  }, [active, page, target?.server_id, target?.group_id, onContext])
  const servers = state.status === 'ready' ? [...(state.value?.servers ?? []), ...(publishedService ? [publishedService] : [])] : []
  const missingServer = active && page !== 'composition' && target?.server_id && serviceLoaded && state.status === 'ready' && !servers.some((server: any) => server.id === target.server_id)
  useEffect(() => {
    if (!active || page !== 'servers' || !target?.server_id) { locatedServer.current = ''; return }
    if (state.status !== 'ready' || !servers.some((server: any) => server.id === target.server_id) || locatedServer.current === target.server_id) return
    const root = managerRoot.current
    if (!root) return
    const locate = () => {
      const item = [...root.querySelectorAll<HTMLButtonElement>('.mcp-list-item')].find(button => button.dataset.serverId === target.server_id)
      const detail = root.querySelector<HTMLElement>('.mcp-layout > .mcp-card:not(.mcp-sidebar)')
      if (item?.getAttribute('aria-current') !== 'true' || !detail) return false
      locatedServer.current = target.server_id!
      detail.tabIndex = -1
      detail.scrollIntoView({ block: 'start' })
      detail.focus({ preventScroll: true })
      return true
    }
    const observer = new MutationObserver(() => { if (locate()) observer.disconnect() })
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current'] })
    const frame = requestAnimationFrame(() => { if (locate()) observer.disconnect() })
    return () => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame); observer.disconnect() }
  }, [active, page, target?.server_id, state.status, state.revision, publishedService])
  function selectTab(next: string) {
    setPage(next)
    if (active) onNavigate?.({ page: 'mcp', tab: next,
      ...(next === 'composition' ? target?.composition_id ? { composition_id: target.composition_id, version: target.version, version_id: target.version_id } : lastComposition.current ?? {} : {}),
      ...(next !== 'composition' ? target?.group_id || lastGroup.current ? { group_id: target?.group_id ?? lastGroup.current } : { server_id: target?.server_id ?? lastServer.current } : {}) })
  }
  return <main className="harness-mcp-page" aria-label="MCP 管理">
    <header className="harness-page-heading harness-mcp-page-heading">
      <div><span className="harness-mcp-kicker">工具与连接</span><h1>MCP 管理</h1><p>接入服务、组织工具与资源，在同一工作区完成调试和组合编排。</p></div>
      <button type="button" className="harness-primary" disabled={state.status !== 'ready'} onClick={() => { selectTab('servers'); requestAnimationFrame(() => managerRoot.current?.querySelector<HTMLButtonElement>('.mcp-service-layout .mcp-add')?.click()) }}>＋ 接入服务</button>
    </header>
    <div className="harness-mcp-module-toolbar">
      <nav className="harness-mcp-toolbar harness-mcp-tabs" aria-label="MCP 工作区">{tabs.map(tab => <button key={tab.id} type="button" aria-current={page === tab.id ? 'page' : undefined} onClick={() => selectTab(tab.id)}>{tab.title}</button>)}</nav>
    </div>
    <div className="harness-mcp-actions harness-mcp-save-actions" ref={setToolbarTarget} />
    {state.error && <p role="alert">{state.error}</p>}
    {state.status === 'loading' && page !== 'composition' && <LoadingIndicator label="读取 MCP 配置" block />}
    {serviceError && <p role="alert">{serviceError}</p>}
    {missingServer && <p role="alert">服务 ID <code>{target.server_id}</code> 不存在。请选择其他服务，或检查此链接。</p>}
    <div ref={managerRoot} hidden={page === 'composition'}>
      {target?.server_id && page === 'servers' && <button type="button" className="harness-mcp-return" onClick={() => {
        const item = managerRoot.current?.querySelector<HTMLElement>('.mcp-sidebar [aria-current="true"]')
        item?.scrollIntoView({ block: 'nearest' }); item?.focus()
      }}>返回服务列表</button>}
      {state.status === 'ready' && <Manager view={page} onValidationError={() => selectTab('servers')} publishedService={publishedService} selectedServerId={target?.server_id} selectedGroupId={target?.group_id} PasswordInput={PasswordInput} SearchSelect={SearchSelect} renderToolbar={(control, container) => createPortal(control, container)} onOpenView={(view, serverId, groupId) => {
      lastServer.current = serverId
      lastGroup.current = groupId
      setPage(view)
      if (active) onNavigate?.({ page: 'mcp', tab: view, server_id: serverId, group_id: groupId })
    }} onSelectGroupId={group_id => {
      lastGroup.current = group_id
      lastServer.current = undefined
      if (active) onNavigate?.({ page: 'mcp', tab: page, group_id })
    }} onSelectServerId={server_id => {
      lastGroup.current = undefined
      lastServer.current = server_id
      if (active) onNavigate?.({ page: 'mcp', tab: page, ...(server_id ? { server_id } : {}) })
      if (server_id && page === 'servers') requestAnimationFrame(() => {
        const detail = managerRoot.current?.querySelector<HTMLElement>('.mcp-layout > .mcp-card:not(.mcp-sidebar)')
        if (detail) { detail.tabIndex = -1; detail.scrollIntoView({ block: 'start' }); detail.focus() }
      })
    }} toolbarTarget={page === 'composition' ? null : toolbarTarget} form={{ state }} write={async (ops, revision) => {
      try {
        const response = await rpc.call(CHANNEL, 'mcp/saveConfiguration', { ops, revision })
        if (response.ok) {
          setState({ status: 'ready', writable: true, ...(response.value as object) })
          updates?.invalidate(['mcp'])
        }
        return response
      } catch { return { ok: false, error: { message: 'MCP 数据配置保存失败，请检查连接后重试。' } } }
    }} />}</div>
    <div hidden={page !== 'composition'}><CompositionPage rpc={rpc} configuration={state} updates={updates} active={active && page === 'composition'} target={target} onNavigate={onNavigate} onContext={compositionContext} onCatalogChange={value => { setPublishedService(value.publishedService ?? null); setServiceError(''); setServiceLoaded(true) }} /></div>
  </main>
}

function CompositionPage({ rpc, configuration, onCatalogChange, updates, onContext, active, target, onNavigate }: PlatformPageProps & LivePageProps & NavigationProps & { configuration: unknown; active: boolean; onCatalogChange(value: any): void }) {
  const [data, setData] = useState<any>(null)
  const [selection, setSelection] = useState<{ id: string; version: 'draft' | 'published'; versionId?: string } | null>(null)
  const [editor, setEditor] = useState<{ id?: string; revision: string; value: CompositionConfig } | null>(null)
  const [recoveryDraft, setRecoveryDraft] = useState<{ id?: string; revision: string; value: CompositionConfig } | null>(null)
  const [conflictDetected, setConflictDetected] = useState(false)
  const [mappingValid, setMappingValid] = useState(true)
  useEffect(() => { setMappingValid(true) }, [editor?.id, editor?.value.kind])
  const [asset, setAsset] = useState('')
  const [continuedRun, setContinuedRun] = useState<{ selectionKey: string; runId: string } | null>(null)
  const [rawResult, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [attempt, setAttempt] = useState<CompositionAttempt | null>(null)
  const [recoveredRuns, setRecoveredRuns] = useState<any[]>([])
  const [selectedNode, setSelectedNode] = useState('getAsset')
  const [frozenGraph, setFrozenGraph] = useState<{ key: string; graph?: any; error?: string } | null>(null)
  const [subflows, setSubflows] = useState<{ title: string; graph: any }[]>([])
  const [parents, setParents] = useState<NonNullable<typeof selection>[]>([])
  const [preview, setPreview] = useState<'config' | 'source' | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (!preview) return; previewRef.current?.focus(); return () => moreRef.current?.focus() }, [preview])
  useEffect(() => { setPreview(null) }, [target?.composition_id, target?.version, target?.version_id])
  const requestId = useRef(0)
  const actionId = useRef(0)
  const detailRef = useRef<HTMLElement>(null)
  const { fullscreen, setFullscreen } = useCompositionFullscreen(detailRef, active)
  const narrow = useCompositionNarrow()
  const [listOpen, setListOpen] = useState(true)
  const [nodeOpen, setNodeOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const locatedComposition = useRef('')
  const routeMatchesSelection = !target?.composition_id || target.composition_id === selection?.id
    && (!target.version || target.version === selection?.version) && target.version_id === selection?.versionId
  const result = routeMatchesSelection ? rawResult : null
  useEffect(() => {
    if (routeMatchesSelection) return
    actionId.current++
    setResult(null); setError(''); setBusy(false)
  }, [target?.composition_id, target?.version, target?.version_id])
  useEffect(() => updates?.subscribe(() => {
    if (updates.getSnapshot().domains.includes('mcp')) void refreshCatalog()
  }), [updates])
  useEffect(() => {
    if (!editor && !recoveryDraft) return
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [editor, recoveryDraft])
  useEffect(() => {
    if (active) onContext?.({ page: 'mcp', tab: 'composition', composition_id: selection?.id, version: selection?.version, version_id: selection?.versionId })
  }, [active, selection, onContext])
  useEffect(() => {
    if (!active || target?.page !== 'mcp' || target.tab !== 'composition' || !target.composition_id) return
    const requested = data?.compositions?.find((item: CompositionEntry) => item.id === target.composition_id)
    if (!target.version && !data) return
    const next = { id: target.composition_id, version: target.version === 'draft' || (!target.version && requested?.draft) ? 'draft' as const : 'published' as const,
      ...(target.version_id ? { versionId: target.version_id } : {}) }
    setSelection(current => current?.id === next.id && current.version === next.version && current.versionId === next.versionId ? current : next)
  }, [active, data, target?.page, target?.tab, target?.composition_id, target?.version, target?.version_id])
  useEffect(() => {
    if (active && selection && !target?.composition_id) onNavigate?.({ page: 'mcp', tab: 'composition', composition_id: selection.id,
      version: selection.version, ...(selection.versionId ? { version_id: selection.versionId } : {}), replace: true })
  }, [active, selection, target?.composition_id, onNavigate])
  const entries: CompositionEntry[] = data?.compositions ?? []
  const entry = entries.find(item => item.id === selection?.id)
  const frozenVersion = selection?.versionId && selection.version === 'published' ? entry?.versions?.find(item => item.versionId === selection.versionId) : undefined
  const config = selection && (selection.version === 'draft' ? entry?.draft : selection.versionId ? frozenVersion?.config : entry?.published)
  useEffect(() => {
    if (!active || target?.page !== 'mcp' || target.tab !== 'composition') { locatedComposition.current = ''; return }
    if (!target.composition_id || !data || selection?.id !== target.composition_id) return
    const expectedVersion = target.version === 'draft' || (!target.version && entry?.draft) ? 'draft' : 'published'
    if (selection.version !== expectedVersion || (target.version_id && selection.versionId !== target.version_id)) return
    const routeKey = `${target.composition_id}:${selection.version}:${selection.versionId ?? ''}`
    if (locatedComposition.current === routeKey) return
    const frame = requestAnimationFrame(() => {
      if (!detailRef.current) return
      locatedComposition.current = routeKey
      detailRef.current.scrollIntoView({ block: 'start' })
      detailRef.current.focus({ preventScroll: true })
    })
    return () => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame) }
  }, [active, target?.page, target?.tab, target?.composition_id, target?.version, target?.version_id, data, selection, entry])
  const historical = selection?.version === 'published' && Boolean(selection.versionId) && selection.versionId !== entry?.publishedVersionId
  const selectionKey = selection ? `${selection.id}:${selection.version}:${selection.versionId ?? ''}` : ''
  useEffect(() => { setSubflows([]); setSelectedNode(''); setNodeOpen(false); setMoreOpen(false) }, [selectionKey])
  useEffect(() => { if (!active || editor) { setNodeOpen(false); setTestOpen(false); setMoreOpen(false) } }, [active, Boolean(editor)])
  useEffect(() => {
    if (!historical || !selection) { setFrozenGraph(null); return }
    let cancelled = false
    setFrozenGraph({ key: selectionKey })
    void rpc.call(CHANNEL, 'mcp/compositionGraph', { compositionId: selection.id, versionId: selection.versionId }).then(response => {
      if (!cancelled) setFrozenGraph(response.ok ? { key: selectionKey, graph: response.value } : { key: selectionKey, error: response.error.message })
    }).catch(() => { if (!cancelled) setFrozenGraph({ key: selectionKey, error: '无法读取此固定版本的流程图，请刷新重试。' }) })
    return () => { cancelled = true }
  }, [historical, selectionKey, data?.revision])
  const currentSelection = useRef(selectionKey)
  currentSelection.current = selectionKey
  const storageKey = `hep:mcp-composition-executions:${document.baseURI}:${data?.workspace_id ?? 'legacy'}`
  const unresolved = attempt?.selection_key === selectionKey && attempt.state !== 'responded'
  function remembered() {
    try { return JSON.parse(sessionStorage.getItem(storageKey) || '{}') as Record<string, CompositionAttempt> } catch { return {} }
  }
  function remember(value: CompositionAttempt | null, key = selectionKey) {
    try {
      const values = remembered()
      if (value) values[key] = { execution_id: value.execution_id, selection_key: value.selection_key, asset: value.asset, payload: value.payload, state: 'unknown' }
      else delete values[key]
      sessionStorage.setItem(storageKey, JSON.stringify(values))
      return true
    } catch { return false }
  }
  function acceptReceipt(value: any, original: CompositionAttempt) {
    const next = { ...original, state: value.state as CompositionAttempt['state'], run_ids: value.run_ids ?? [], message: value.message }
    setAttempt(next)
    setResult(value.state === 'responded' ? value.result : null)
  }
  async function recover(original = attempt, restoring = false) {
    if (!original || busy && !restoring) return
    const id = ++actionId.current
    setBusy(true); setPendingAction('compositionExecution'); setError('')
    try {
      const response = await rpc.call(CHANNEL, 'mcp/compositionExecution', { execution_id: original.execution_id })
      if (id !== actionId.current || currentSelection.current !== original.selection_key) return
      if (!response.ok) { setAttempt({ ...original, state: 'unknown', message: response.error.message }); return }
      acceptReceipt(response.value, original)
    } catch { if (id === actionId.current) setAttempt({ ...original, state: 'unknown', message: '暂时无法读取原执行回执；输入和执行标识已保留，请稍后继续核对。' }) }
    finally { if (id === actionId.current) { setBusy(false); setPendingAction('') } }
  }
  useEffect(() => {
    if (!selectionKey || !data) return
    const saved = remembered()[selectionKey]
    setAttempt(saved ?? null); setRecoveredRuns([]); setAsset(continuedRun?.selectionKey === selectionKey ? continuedRun.runId : saved?.asset ?? '')
    if (saved) { setResult(null); void recover(saved, true) }
  }, [selectionKey, data?.workspace_id, Boolean(data)])
  const threat = isThreatComposition(config)
  const workflow = Boolean(config?.workflow)
  let testInput: Record<string, unknown> = {}, inputError = ''
  try { testInput = workflow ? JSON.parse(asset || '{}') : compositionTestInput(config || undefined, asset); if (!testInput || typeof testInput !== 'object' || Array.isArray(testInput)) throw new Error() } catch { inputError = '请输入有效的 JSON 对象' }
  const registeredConnections = data?.connections ?? []
  const connections = data?.connections?.filter((item: any) => item.kind === 'openapi') ?? []
  const extensionReady = config?.flow ? Boolean(data?.extension?.flow) : workflow ? Boolean(data?.extension?.workflows?.some((item: any) => item.id === config?.workflow)) : config?.kind ? Boolean(data?.extension?.stages) : true
  const upstream = extensionReady && config && (config.kind === 'threat-stage'
    ? [config.bindings?.socConnectionId, config.bindings?.reportConnectionId].every(id => registeredConnections.some((item: any) => item.id === id))
    : workflow ? Object.values(config.connections ?? {}).every(id => registeredConnections.some((item: any) => item.id === id)) : config.kind === 'composite' ? config.steps?.every(step => entries.find(item => item.id === step.compositionId)?.versions?.some(version => version.versionId === step.versionId))
      : [config.connectionId, ...(config.flow ? [config.alertsConnectionId] : [])].every(id => connections.some((item: any) => item.id === id)))
  const rootGraph = result?.graph ?? (historical ? frozenGraph?.key === selectionKey ? frozenGraph.graph : undefined : selection && data?.compositions.find((item: any) => item.id === selection.id)?.graphs?.[selection.version])
  const graph = subflows.at(-1)?.graph ?? rootGraph
  const nodes = graph?.nodes ?? []
  const node = nodes.find((item: any) => item.id === selectedNode) ?? nodes[0]
  const trace = result?.result?.trace?.find((item: any) => node && ((node.step && item.step === node.step) || item.step === node.id || item.stage === node.operationId))

  const run = result?.result
  const nextStage = result?.ok === true && config?.kind === 'threat-stage' && run?.run_id && ['completed', 'skipped'].includes(run.phase_status)
    ? config.stage === 'collect' ? run.status === 'completed' ? 'writeback' : run.route === 'five_source' ? 'infer' : null
      : config.stage === 'infer' ? 'writeback' : config.stage === 'writeback' && run.status === 'completed' ? 'report' : null
    : null
  const continuations = nextStage ? entries.flatMap(item => {
    const version = selection?.version === 'draft' && item.draft ? 'draft' as const : 'published' as const
    const next = item[version]
    return next?.kind === 'threat-stage' && next.stage === nextStage && next.bindings?.socConnectionId === config?.bindings?.socConnectionId && next.bindings?.reportConnectionId === config?.bindings?.reportConnectionId
      ? [{ entry: item, version, config: next }] : []
  }) : []
  const carriedRun = continuedRun?.selectionKey === selectionKey && continuedRun.runId === asset ? continuedRun.runId : null

  function accept(value: any) {
    setCatalogLoading(false)
    setData(value)
    onCatalogChange(value)
    setSelection(current => {
      if (current || target?.composition_id) return current
      const first = value.compositions[0]
      return first ? { id: first.id, version: first.draft ? 'draft' : 'published', ...(first.draft ? {} : { versionId: first.publishedVersionId }) } : null
    })
  }
  const refreshCatalog = useQueuedRefresh(active, async () => {
    const id = ++requestId.current
    setCatalogLoading(true)
    try {
      const response = await rpc.call(CHANNEL, 'mcp/list', {})
      if (id !== requestId.current) return
      if (response.ok) { accept(response.value); setError(''); setConflictDetected(false) }
      else setError(response.error.message)
    } catch (error) { if (id === requestId.current) setError(`读取编排目录失败：${transportDetail(error)}`) }
    finally { if (id === requestId.current) setCatalogLoading(false) }
  })
  useEffect(() => { void refreshCatalog(); return () => { requestId.current++ } }, [configuration])

  function select(item: CompositionEntry, version: 'draft' | 'published', versionId?: string, focus = true, preserveParents = false) {
    if (!preserveParents) setParents([])
    const next = { id: item.id, version, ...(versionId ? { versionId } : {}) }
    if (focus && selection?.id === next.id && selection.version === next.version && selection.versionId === next.versionId) {
      requestAnimationFrame(() => { detailRef.current?.scrollIntoView({ block: 'start' }); detailRef.current?.focus() })
      return
    }
    actionId.current++
    setSelection(next); setResult(null); setError(''); setAsset(''); setContinuedRun(null); setBusy(false)
    if (active) onNavigate?.({ page: 'mcp', tab: 'composition', composition_id: item.id, version, ...(versionId ? { version_id: versionId } : {}) })
    if (focus) requestAnimationFrame(() => { detailRef.current?.scrollIntoView({ block: 'start' }); detailRef.current?.focus() })
  }
  function exportDraft(value: CompositionConfig, download: boolean, label = '草稿') {
    const content = JSON.stringify(value, null, 2)
    if (!download) {
      void copyText(content).then(() => setError(`${label}已复制。`)).catch(() => setError(`无法自动复制，请下载${label}。`))
      return
    }
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url; link.download = `mcp-composition-${entry?.id || 'draft'}-${selection?.version || 'draft'}.json`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  async function action(endpoint: string, payload: any) {
    if (busy) return
    const id = ++actionId.current
    setBusy(true); setPendingAction(endpoint); setResult(null); setError('')
    try {
      const response = await rpc.call(CHANNEL, `mcp/${endpoint}`, payload)
      if (id !== actionId.current) return
      if (!response.ok) {
        setError(response.error.message)
        if (endpoint === 'saveCompositionDraft' && /变化|冲突|版本/.test(response.error.message)) {
          setConflictDetected(true)
          try {
            const latest = await rpc.call(CHANNEL, 'mcp/list', {})
            if (id === actionId.current && latest.ok) accept(latest.value)
          } catch { /* 保留原冲突信息与本地草稿，由用户手动重试读取。 */ }
        }
        return
      }
      const value = response.value as any
      if (endpoint === 'list') { accept(value); setConflictDetected(false) }
      else if (endpoint === 'saveCompositionDraft') {
        requestId.current++
        const saved = editor?.id ? value.compositions.find((item: CompositionEntry) => item.id === editor.id) : value.compositions.at(-1)
        accept(value); setEditor(null); setRecoveryDraft(null); setConflictDetected(false); select(saved, 'draft', undefined, false)
      } else if (endpoint === 'publishComposition') {
        requestId.current++
        accept(value)
        const saved = value.compositions.find((item: CompositionEntry) => item.id === payload.compositionId)
        select(saved, 'published', saved.publishedVersionId, false); setResult(value.dry)
      } else if (['withdrawComposition', 'deleteComposition'].includes(endpoint)) { accept(value); setSelection(null); setError(endpoint === 'withdrawComposition' ? '已下架，新调用已停止；已有记录保留。' : '已删除编排及其源码、文档和发布包；历史运行记录保留。') } else setResult(value)
      if (['saveCompositionDraft', 'publishComposition', 'withdrawComposition', 'deleteComposition'].includes(endpoint)) updates?.invalidate(['mcp'])
    } catch (error) { if (id === actionId.current) setError(`组合操作未完成：${transportDetail(error)}`) }
    finally { if (id === actionId.current) { setBusy(false); setPendingAction('') } }
  }
  const selectedPayload = { compositionId: entry?.id, version: selection?.version, ...(selection?.versionId ? { versionId: selection.versionId } : {}), revision: data?.revision, input: testInput }
  async function execute() {
    if (busy || unresolved) return
    const executionId = `graph-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
    const original: CompositionAttempt = { execution_id: executionId, selection_key: selectionKey, asset, payload: { ...selectedPayload, execution: { execution_id: executionId } }, state: 'running' }
    if (!remember(original)) { setError('无法保存本次执行身份，尚未派发；请允许浏览器会话存储后重试。'); return }
    const id = ++actionId.current
    setAttempt(original); setBusy(true); setPendingAction('executeComposition'); setResult(null); setRecoveredRuns([]); setError('')
    try {
      const response = await rpc.call(CHANNEL, 'mcp/executeComposition', original.payload)
      if (id !== actionId.current || currentSelection.current !== original.selection_key) return
      if (!response.ok) { remember(null, original.selection_key); setAttempt(null); setError(response.error.message); return }
      const value = response.value as any
      acceptReceipt(value.execution_receipt ?? { state: 'responded', result: value }, original)
    } catch (error) { if (id === actionId.current) setAttempt({ ...original, state: 'unknown', message: `未收到执行回执（传输原因：${transportDetail(error)}），远端可能已经执行。请核对原请求，平台不会自动再次执行。` }) }
    finally { if (id === actionId.current) { setBusy(false); setPendingAction('') } }
  }
  async function readOriginalRun(runId: string) {
    const id = ++actionId.current
    setBusy(true); setError('')
    try {
      const response = await rpc.call(CHANNEL, 'mcp/compositionRun', { run_id: runId })
      if (id !== actionId.current) return
      if (!response.ok) throw new Error(response.error.message)
      setRecoveredRuns(previous => [...previous.filter(run => run.run_id !== runId), response.value])
    } catch (error) { if (id === actionId.current) setError(error instanceof Error ? error.message : '无法读取原运行') }
    finally { if (id === actionId.current) setBusy(false) }
  }
  const conflict = Boolean(editor && data && (conflictDetected || editor.revision !== data.revision))
  const versionOptions = entry ? [
    ...(entry.draft ? [{ value: 'draft', label: '编辑草稿', group: '草稿' }] : []),
    ...(entry.published ? [{ value: entry.publishedVersionId ?? 'published', label: '当前发布版本', description: entry.publishedVersionId, group: '已发布' }] : []),
    ...(entry.versions ?? []).filter(version => version.versionId !== entry.publishedVersionId).map(version => ({ value: version.versionId, label: `历史版本 ${version.versionId.slice(0, 12)}`, description: `${version.versionId} · ${version.publishedAt ?? '发布时间未记录'}`, group: '历史版本' })),
  ] : []
  const testStatus = busy && pendingAction !== 'list' ? '正在处理…'
    : unresolved ? attempt?.state === 'running' ? '原请求正在执行，等待回执' : '结果待核对'
      : result?.mode === 'dry' ? 'dry 校验通过，未请求上游'
        : result ? result.ok === false ? '最近执行失败' : workflow || threat ? '已收到执行回执，详情中核对运行状态' : '最近执行成功' : '尚无测试结果'
  return <div className="harness-composition-workspace" data-list-open={listOpen} data-fullscreen={fullscreen}>
    <style>{threatEditorStyle}</style>
    <nav className="harness-card harness-composition-sidebar" aria-label="工具编排列表">
      <h2>工具组合编排{data && (catalogLoading || busy && pendingAction === 'list') && <LoadingIndicator label="刷新编排目录" />}</h2><div className="harness-mcp-actions"><button className="harness-primary" type="button" disabled={busy || !!editor || !data} onClick={() => setEditor({ revision: data.revision, value: { toolName: '', title: '资产相关告警查询', description: '查询资产后查询相关告警的两步只读组合', connectionId: connections[0]?.id ?? '' } })}>新建编排</button>
        <button type="button" disabled={busy || !!editor} onClick={() => void refreshCatalog()}>刷新</button></div>
      <section aria-label="全部编排"><h3>全部编排（{entries.length}）</h3>
        {!data ? null : entries.length ? <ul>{entries.map(item => {
          const version = item.draft ? 'draft' : 'published'
          const value = item[version]!
          return <li key={item.id}><button type="button" disabled={busy || !!editor} aria-current={selection?.id === item.id ? 'true' : undefined} onClick={() => select(item, version, version === 'published' ? item.publishedVersionId : undefined)}>
            <span>{value.title}</span><small>{value.toolName}</small>
            <span className="harness-composition-status">{item.published && <span data-state="published">已发布</span>}{item.draft && <span data-state="draft">正在编辑</span>}</span>
          </button></li>
        })}</ul> : <p>暂无编排</p>}
      </section>
    </nav>
    <section ref={detailRef} tabIndex={-1} className="harness-card harness-composition-detail" aria-label="组合编排详情" role={fullscreen ? 'dialog' : undefined} aria-modal={fullscreen ? true : undefined}>
      {narrow && <div className="harness-composition-mobile-picker"><SearchSelect label="选择编排" value={selection?.id ?? ''} disabled={busy || !!editor} options={entries.map(item => ({ value: item.id, label: (item.draft ?? item.published)!.title, description: (item.draft ?? item.published)!.toolName }))} onChange={id => { const item = entries.find(item => item.id === id); if (item) select(item, item.draft ? 'draft' : 'published', item.draft ? undefined : item.publishedVersionId, false) }}/><button type="button" disabled={busy || !!editor || !data} onClick={() => setEditor({ revision: data.revision, value: { toolName: '', title: '资产相关告警查询', description: '查询资产后查询相关告警的两步只读组合', connectionId: connections[0]?.id ?? '' } })}>新建编排</button><button type="button" disabled={busy || !!editor} onClick={() => void refreshCatalog()}>刷新</button></div>}
      <div className="harness-composition-topbar">
        <button type="button" className="harness-composition-list-toggle" aria-expanded={listOpen && !fullscreen} disabled={fullscreen} onClick={() => setListOpen(!listOpen)}>{listOpen ? '收起列表' : '展开列表'}</button>
        <h2>{editor ? (editor.id ? '编辑草稿' : '新建编排') : config?.title ?? '工具组合编排'}</h2>
        {!editor && config && <>
          <SearchSelect className="harness-composition-version" label="编排版本" value={selection?.version === 'draft' ? 'draft' : selection?.versionId ?? entry?.publishedVersionId ?? 'published'} options={versionOptions} disabled={busy} onChange={value => select(entry!, value === 'draft' ? 'draft' : 'published', value === 'draft' || value === 'published' ? undefined : value, false)}/>
          <button type="button" disabled={busy} onClick={() => { setEditor({ id: entry!.id, revision: data.revision, value: { ...(entry!.draft ?? config!) } }); setResult(null); setError('') }}>{entry?.draft ? '继续编辑草稿' : '编辑'}</button>
          <Menu open={moreOpen} onClose={() => setMoreOpen(false)} portal align="end" anchor={<button ref={moreRef} type="button" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>更多</button>}>
            <MenuItemButton onSelect={() => { setMoreOpen(false); setPreview('config') }}>查看配置</MenuItemButton>
            <MenuItemButton onSelect={() => { setMoreOpen(false); setPreview('source') }}>查看编排代码</MenuItemButton>
            {entry?.published && <MenuItemButton disabled={busy} separatorBefore onSelect={() => { setMoreOpen(false); void action('withdrawComposition', { compositionId: entry.id, revision: data.revision }) }}>下架工具</MenuItemButton>}
            <MenuItemButton disabled={busy} danger onSelect={() => { setMoreOpen(false); if (window.confirm(`删除编排“${config.title}”（${entry?.id}）及其源码、文档和发布包？历史运行记录保留。`)) void action('deleteComposition', { compositionId: entry?.id, revision: data.revision }) }}>删除编排</MenuItemButton>
          </Menu>
        </>}
        <button type="button" className="harness-composition-fullscreen-toggle" aria-pressed={fullscreen} onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? '退出全屏' : '全屏'}</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && pendingAction !== 'list' && <p role="status">正在处理…</p>}
      {config && !extensionReady && <p role="alert">此编排依赖的业务扩展尚未装载。已有目录保持可读，请先启用工作区的 DSH 扩展。</p>}
      {conflict && <section className="harness-composition-conflict" role="alert"><h3>编排目录版本冲突</h3><p>当前编辑基于版本 <code>{editor?.revision.slice(0, 12)}</code>，页面已读取的目录版本为 <code>{data?.revision?.slice(0, 12)}</code>。本地草稿仍在编辑器中；请先取回草稿，再读取最新内容并手工重应用修改。</p>
        <div className="harness-mcp-actions"><button type="button" onClick={() => exportDraft(editor!.value, false)}>复制本地草稿</button><button type="button" onClick={() => exportDraft(editor!.value, true)}>下载本地草稿</button><button type="button" disabled={busy} onClick={() => void refreshCatalog()}>读取最新目录</button>{data && editor?.revision !== data.revision && <button type="button" onClick={() => {
          const latest = entries.find(item => item.id === editor!.id)
          setRecoveryDraft(editor); setEditor(latest ? { id: latest.id, revision: data.revision, value: structuredClone(latest.draft ?? latest.published!) } : null)
          setConflictDetected(false); setError(latest ? '已装载最新内容。保留的本地草稿可复制或下载，请手工重应用修改后保存。' : '原编排已不存在；本地草稿仍可复制或下载。')
        }}>以最新版本继续编辑</button>}</div>
      </section>}
      {recoveryDraft && <section className="harness-composition-conflict" role="status"><h3>保留的本地草稿</h3><p>原草稿基于版本 <code>{recoveryDraft.revision.slice(0, 12)}</code>；重新读取目录后请逐项核对并手工重应用。刷新页面前请复制或下载。</p><div className="harness-mcp-actions"><button type="button" onClick={() => exportDraft(recoveryDraft.value, false)}>复制保留草稿</button><button type="button" onClick={() => exportDraft(recoveryDraft.value, true)}>下载保留草稿</button><button type="button" onClick={() => setRecoveryDraft(null)}>放弃保留草稿</button></div></section>}
      {!config && !editor ? !data ? !error && <LoadingIndicator label="读取编排目录" block /> : <div className="harness-composition-empty"><svg width="36" height="36" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="12" width="8" height="8" rx="2"/><rect x="21" y="3" width="8" height="8" rx="2"/><rect x="21" y="21" width="8" height="8" rx="2"/><path d="M11 16h5V7h5m-5 9v9h5"/></svg><h3>{selection ? '重新选择工具组合' : '从一组工具开始编排'}</h3><p>{selection ? `所选编排 ${selection.id} 的${selection.version === 'draft' ? '草稿' : selection.versionId ? `发布版本 ${selection.versionId}` : '当前发布版本'}已不存在，请重新选择。` : '在左侧选择一个工具组合，或点击“新建编排”开始。'}</p></div> : <>
        {editor ? <form onSubmit={event => { event.preventDefault(); if (!mappingValid) return; void action('saveCompositionDraft', { compositionId: editor.id, revision: editor.revision, draft: editor.value }) }} className="harness-composition-editor">
          <p>{editor.value.kind === 'workflow' ? '编辑代码工作流的连接，保存后进行 dry 校验和发布。' : isThreatComposition(editor.value) ? '编辑阶段连接或固定子版本，保存草稿后进行 dry 校验和发布。' : '复用当前 LangGraph 两步只读流程：查询资产 → 查询相关告警。保存草稿后进行 dry 测试和发布。'}</p>
          <label>编排标题<input required maxLength={80} value={editor.value.title} onChange={event => setEditor({ ...editor, value: { ...editor.value, title: event.target.value } })} /></label>
          <label>工具名称<input required maxLength={64} pattern="[A-Za-z0-9_.\-]+" value={editor.value.toolName} onChange={event => setEditor({ ...editor, value: { ...editor.value, toolName: event.target.value } })} /></label>
          <label className="harness-mcp-wide">工具说明<textarea maxLength={500} value={editor.value.description} onChange={event => setEditor({ ...editor, value: { ...editor.value, description: event.target.value } })} /></label>
          {editor.value.kind === 'workflow' ? <fieldset><legend>代码工作流连接</legend><p>工作流：<code>{editor.value.workflow}</code>。输入及输出以实际 Schema 为准。</p>{Object.entries(editor.value.connections ?? {}).map(([key, connection]) => <label key={key}>{key}<select required value={connection} onChange={event => setEditor({ ...editor, value: { ...editor.value, connections: { ...editor.value.connections, [key]: event.target.value } } })}><option value="">请选择连接</option>{registeredConnections.map((item: any) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label>)}</fieldset> : isThreatComposition(editor.value) ? <ThreatConfigurationFields rpc={rpc} active={active} identity={`${editor.id ?? 'new'}:${editor.revision}`} onValidityChange={setMappingValid} value={editor.value} change={value => setEditor({ ...editor, value })} compositionId={editor.id} connections={registeredConnections} entries={entries}/> : <><label>接口流程<select value={editor.value.flow ?? ''} onChange={event => setEditor({ ...editor, value: { ...editor.value, flow: event.target.value === 'soc-asset-alerts' ? 'soc-asset-alerts' : undefined, alertsConnectionId: event.target.value ? editor.value.alertsConnectionId ?? connections[0]?.id ?? '' : undefined } })}>
            <option value="">get_asset → list_alerts</option>{(data?.extension?.flow || editor.value.flow) && <option value="soc-asset-alerts">SOC 资产详情 → 近 30 天告警分组</option>}
          </select></label>
          <label>{editor.value.flow ? '资产 OpenAPI 服务器' : 'OpenAPI 服务器'}<select required value={editor.value.connectionId} onChange={event => setEditor({ ...editor, value: { ...editor.value, connectionId: event.target.value } })}>
            <option value="">请选择服务器</option>{editor.value.connectionId && !connections.some((item: any) => item.id === editor.value.connectionId) && <option value={editor.value.connectionId}>{editor.value.connectionId}（尚未接入）</option>}
            {connections.map((item: any) => <option key={item.id} value={item.id}>{item.name || item.id}（{item.id}）</option>)}
          </select></label>
          {editor.value.flow && <label>告警 OpenAPI 服务器<select required value={editor.value.alertsConnectionId ?? ''} onChange={event => setEditor({ ...editor, value: { ...editor.value, alertsConnectionId: event.target.value } })}>
            <option value="">请选择服务器</option>{editor.value.alertsConnectionId && !connections.some((item: any) => item.id === editor.value.alertsConnectionId) && <option value={editor.value.alertsConnectionId}>{editor.value.alertsConnectionId}（尚未接入）</option>}
            {connections.map((item: any) => <option key={item.id} value={item.id}>{item.name || item.id}（{item.id}）</option>)}
          </select></label>}</>}
          <div className="harness-mcp-actions"><button className="harness-primary" disabled={busy || conflict || !mappingValid} type="submit">保存草稿</button><button disabled={busy || !mappingValid} type="button" onClick={() => { setRecoveryDraft(editor); setEditor(null); setError('草稿已暂存于当前页面。刷新或关闭前请复制或下载，继续编辑时请手工核对最新目录。') }}>暂存并返回详情</button></div>
          <p>草稿保存到仓库编排目录；已发布版本继续供 MCP 调用。</p>
        </form> : <div className="harness-composition-summary">
          <span>{selection?.version === 'draft' ? '草稿尚未发布' : historical ? '历史发布版本，只读查看' : '当前版本已发布'} · {upstream ? '依赖已登记，等待实际调用验证' : threat ? '请编辑连接或选择已发布的固定子版本' : '请先接入所需的服务器'}</span>
          <DetailDrawer title="编排资料" trigger="资料" active={active} identity={selectionKey}>
            <h3>{config?.title}</h3><p>{config?.description}</p>
            <dl className="harness-fields"><div><dt>版本状态</dt><dd>{selection?.version === 'draft' ? '草稿尚未发布' : historical ? '历史发布版本' : '当前发布版本'}</dd></div>
              <div><dt>版本 ID</dt><dd><code>{selection?.version === 'draft' ? '未发布' : selection?.versionId ?? entry?.publishedVersionId ?? '未提供'}</code>{selection?.version === 'published' && <button type="button" onClick={() => void copyText(selection.versionId ?? entry?.publishedVersionId ?? '').then(() => setError('版本 ID 已复制。')).catch(() => setError('无法自动复制，请从资料中手动复制版本 ID。'))}>复制版本 ID</button>}</dd></div>
              <div><dt>发布时间</dt><dd>{historical ? frozenVersion?.publishedAt ?? '未记录' : entry?.published?.publishedAt ?? '未发布'}</dd></div>
              <div><dt>工具</dt><dd><code>{config?.toolName}</code></dd></div>
              <div><dt>工作流与连接</dt><dd>{config?.kind === 'threat-stage' ? <>SOC：<code>{config.bindings?.socConnectionId}</code> · 报告：<code>{config.bindings?.reportConnectionId}</code></> : workflow ? <><code>{config?.workflow}</code><pre>{JSON.stringify(config?.connections, null, 2)}</pre></> : config?.kind === 'composite' ? '调用画布中的固定子组合版本' : <><code>{config?.connectionId}</code>{config?.flow && <> → <code>{config.alertsConnectionId}</code></>}</>}</dd></div>
            </dl><h3>调用与发布说明</h3><p>MCP 入口：<code>{new URL('api/harness-platform/mcp', document.baseURI).href}</code>。入口受平台登录认证保护，仅列出并执行已发布版本。草稿供查看与测试，发布后调用方需重新发现工具。</p>
          </DetailDrawer>
        </div>}
        {!editor && <div className="harness-composition-layout" data-node-open={nodeOpen}><div className="harness-composition-graph">
          {parents.length > 0 && <button type="button" disabled={busy} onClick={() => { const parent = parents.at(-1)!, owner = entries.find(item => item.id === parent.id); if (owner) { setParents(parents.slice(0, -1)); select(owner, parent.version, parent.versionId, false, true) } }}>返回上级编排</button>}
          {subflows.length > 0 && <p><button type="button" onClick={() => { setSubflows(subflows.slice(0, -1)); setSelectedNode(''); setNodeOpen(false) }}>返回上层流程</button> · {subflows.map(item => item.title).join(' / ')}</p>}
          {historical && frozenGraph?.key === selectionKey && frozenGraph.error && <p role="alert">{frozenGraph.error}</p>}
          <CompositionCanvas graph={graph} selected={node?.id} onSelect={id => { setSelectedNode(id); setNodeOpen(true) }} identity={`${selectionKey}:${subflows.map(item => item.title).join('/')}`}/>
        </div><CompositionPanel drawer={narrow} title="编排节点详情" open={nodeOpen && active} onClose={() => setNodeOpen(false)} className="harness-composition-node-panel"><div className="harness-composition-panel-body">{node && <><h3>{node.id === '__start__' ? '开始' : node.id === '__end__' ? '结束' : node.title}</h3><p>{node.operationId ? <>工具：<code>{node.operationId}</code></> : node.id === '__start__' ? '流程开始' : node.id === '__end__' ? '流程结束' : '流程节点'}</p><p>状态：{result?.mode === 'dry' ? 'dry 未执行节点' : trace?.status ?? (workflow && result?.result?.run_id ? '请在运行记录中查看步骤结果' : '尚未执行')}</p>
          {node.description && <p>{node.description}</p>}
          {node.subgraph && <button type="button" onClick={() => { setSubflows([...subflows, { title: node.title, graph: node.subgraph }]); setSelectedNode(''); setNodeOpen(false) }}>展开批量步骤</button>}
          {node.compositionId && node.versionId && <><p>子编排：<code>{node.compositionId}</code><br/>固定版本：<code>{node.versionId}</code></p><button type="button" disabled={busy || !entries.some(item => item.id === node.compositionId && item.versions?.some(version => version.versionId === node.versionId))} onClick={() => { const child = entries.find(item => item.id === node.compositionId); if (child && selection) { setParents([...parents, selection]); select(child, 'published', node.versionId, false, true) } }}>进入子编排</button></>}
          {(node.operationId || node.input) && <><h4>输入映射</h4><dl className="harness-fields">{Object.entries(node.input ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
          {trace?.mappedArguments && <pre className="harness-asset-content">{JSON.stringify(trace.mappedArguments, null, 2)}</pre>}
          <h4>输出：{node.output}</h4><pre className="harness-asset-content">{result?.result ? JSON.stringify(config?.kind === 'threat-stage' ? result.result : result.result.stepValues?.[node.output] ?? result.result[node.output], null, 2) : '尚无执行结果'}</pre>{trace?.reason && <p>{trace.reason}</p>}</>}
        </>}</div></CompositionPanel></div>}
        {!editor && !historical && <div className="harness-composition-test-dock">
          <button type="button" className="harness-composition-test-toggle" aria-expanded={testOpen} onClick={() => setTestOpen(!testOpen)}><strong>测试与运行</strong><span role="status">{testStatus}</span><span>{testOpen ? '收起' : '展开'}</span></button>
          <CompositionPanel drawer title="测试与运行" open={testOpen && active} onClose={() => setTestOpen(false)} className="harness-composition-test-panel"><section className="harness-composition-test"><p>{workflow ? '按明确范围读取事实并生成报告；缺失或失败不代表正常。' : threat ? '实际执行将按已编译流程调用取证、模型或模拟存储；请使用基本运维测试事件。' : '第一步失败或缺少资产 ID 时，第二步停止执行。'}</p>
          {workflow ? <label>执行输入 JSON<textarea aria-label="组合执行输入 JSON" disabled={busy} value={asset} onChange={event => { actionId.current++; setAsset(event.target.value); setResult(null) }} placeholder={'{"scope":{"assetIds":[123]}}'} />{inputError && <small role="alert">{inputError}</small>}<details><summary>输入 Schema</summary><pre>{JSON.stringify(data?.extension?.workflows?.find((item: any) => item.id === config?.workflow)?.inputSchema, null, 2)}</pre></details></label> : config?.kind === 'threat-stage' && config.stage !== 'collect' ? <>
            {carriedRun && <p role="status">已带入上一阶段返回的运行：<code>{carriedRun}</code>。核对本阶段后再执行。</p>}
            <DetailDrawer title="按已知运行恢复" trigger={carriedRun ? '更换运行（高级恢复）' : '按已知运行恢复（高级）'} active={active} identity={`${selectionKey}:${subflows.map(item => item.title).join('/')}`}><div className="harness-threat-editor"><p>填写已有阶段返回的运行 ID。关闭窗口后输入仍保留，实际执行仍需在本阶段点击“实际执行组合工具”。</p><label>运行 ID<input aria-label="组合运行 ID" disabled={busy} value={asset} onChange={event => { if (busy) return; actionId.current++; setAsset(event.target.value); setContinuedRun(null); setResult(null) }} placeholder="填写已有阶段返回的 run_id" /></label></div></DetailDrawer>
            {!asset && <p>从上一阶段的实际结果选择“继续”，即可自动带入同一运行；也可按已知运行恢复。</p>}
          </> : <label>{threat ? '事件 ID' : '查询资产'}<input aria-label={threat ? '组合事件 ID' : '组合查询资产'} disabled={busy} value={asset} onChange={event => { if (busy) return; actionId.current++; setAsset(event.target.value); setResult(null) }} placeholder={threat ? 'INC-20261015-000001' : config?.flow ? '资产 ID，如 9106' : '资产 ID、主机名或 IP'} /></label>}
          <div className="harness-mcp-actions"><button type="button" disabled={busy || !asset.trim() || Boolean(inputError)} onClick={() => void action('dryRunComposition', selectedPayload)}>测试（dry）</button>
            {selection?.version === 'draft' && <button type="button" disabled={busy || !asset.trim() || Boolean(inputError)} onClick={() => void action('publishComposition', selectedPayload)}>发布工具</button>}
            <button type="button" disabled={busy || Boolean(unresolved) || !asset.trim() || Boolean(inputError) || !upstream || !entry?.published && selection?.version === 'published'} onClick={() => void execute()}>实际执行组合工具</button></div>
          {attempt?.selection_key === selectionKey && <section className="harness-composition-recovery" aria-label="组合执行回执"><p role="status">{attempt.state === 'responded' ? '已收到原执行回执' : attempt.state === 'running' ? '原请求正在执行，等待回执' : '结果待核对'}</p>{attempt.message && <p>{attempt.message}</p>}<p>执行标识：<code>{attempt.execution_id}</code></p>{attempt.asset !== asset && <p>当前输入已变化，下面核对的仍是原请求：<code>{attempt.asset}</code>。</p>}<button type="button" disabled={busy} onClick={() => void recover()}>核对原请求</button>{attempt.run_ids?.map(runId => <button key={runId} type="button" disabled={busy} onClick={() => void readOriginalRun(runId)}>读取原运行 {runId}</button>)}{recoveredRuns.map(run => <ThreatRunResult key={run.run_id} rpc={rpc} execution={{ result: run }} />)}</section>}
          <p>测试及发布前校验均使用 dry，不请求上游。{workflow ? '运行接受后可刷新进度、读取明细和下载报告。' : threat ? '阶段测试不自动补跑其他阶段；完整流程请执行总组合。' : '实际执行会调用两个只读工具。'}</p>
          {result?.mode === 'dry' && <div role="status"><p>dry 校验通过 · 上游请求 {result.upstreamRequests} 次</p><p>{result.checks.join('、')}。未验证：{result.unverified.join('、')}。</p></div>}
          {result && result.mode !== 'dry' && (workflow ? <ThreatRunResult rpc={rpc} execution={result}/> : threat ? <><ThreatRunResult rpc={rpc} execution={result}/>{continuations.length > 0 && <div className="harness-mcp-actions" aria-label="继续当前运行">{continuations.map(next => <button type="button" key={next.entry.id} disabled={busy} onClick={() => { const runId = run.run_id; const versionId = next.version === 'published' ? next.entry.publishedVersionId : undefined; select(next.entry, next.version, versionId); setAsset(runId); setContinuedRun({ selectionKey: `${next.entry.id}:${next.version}:${versionId ?? ''}`, runId }) }}>继续{nextStage === 'infer' ? '模型研判' : nextStage === 'writeback' ? '结果回写' : '报告保存'} · {next.config.title}（{next.version === 'draft' ? '草稿' : '已发布'}）</button>)}</div>}</> : <div><p role="status">{result.ok ? '组合执行成功' : '组合执行失败'}</p>{result.error && <p role="alert">{result.error.message}</p>}
            {result.result?.alertSummary && <p>近 30 天：{result.result.alertSummary.totalGroups} 个告警分组 · {result.result.alertSummary.totalAlerts} 条告警 · 当前展示 {result.result.alerts.length} 个分组。{result.result.alertSummary.truncated && '上游结果已截断。'}<br/>查询范围：{result.result.alertSummary.from} ～ {result.result.alertSummary.to}</p>}
            <div className="harness-table-scroll"><table className="harness-composition-trace"><thead><tr><th>步骤</th><th>状态</th><th>HTTP</th><th>耗时</th></tr></thead><tbody>{(result.result?.trace ?? []).map((step: any) => <tr key={step.step}><td data-label="步骤">{step.operationId}</td><td data-label="状态">{step.status}</td><td data-label="HTTP">{step.httpStatus ?? '未调用'}</td><td data-label="耗时">{step.durationMs === undefined ? '—' : `${step.durationMs} ms`}</td></tr>)}</tbody></table></div>
            <details><summary>业务结果</summary><pre>{JSON.stringify({ asset: result.result?.asset, alerts: result.result?.alerts, alertSummary: result.result?.alertSummary }, null, 2)}</pre></details><details><summary>执行回执与来源版本</summary><pre>{JSON.stringify({ receipts: result.receipts, version: result.version }, null, 2)}</pre></details></div>)}
          </section></CompositionPanel>
        </div>}
      </>}
      {preview && <div className="harness-composition-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setPreview(null) }}><div ref={previewRef} tabIndex={-1} className="harness-composition-modal" role="dialog" aria-modal="true" aria-label={preview === 'config' ? '查看编排配置' : '查看编排代码'} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPreview(null) }; if (event.key === 'Tab') { const elements = previewRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),summary,pre[tabindex],a[href]'); if (!elements?.length) return; const first = elements[0], last = elements[elements.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === previewRef.current)) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } } }}>
        <header><h2>{preview === 'config' ? '编排配置' : '编排代码'}</h2><button type="button" onClick={() => setPreview(null)} aria-label="关闭编排预览">×</button></header>
        <div><p>{config?.title} · {historical ? '历史发布版本' : selection?.version === 'published' ? '当前发布版本' : '已保存草稿'}{selection?.version === 'published' && <> · <code>{selection.versionId ?? entry?.publishedVersionId}</code></>}</p>{preview === 'config' ? <pre tabIndex={0}>{JSON.stringify(config, null, 2)}</pre> : <GeneratedCodeBrowser identity={`composition:${selection?.id}:${selection?.version}:${selection?.versionId ?? ''}:${data?.revision ?? ''}`} loadCatalog={async () => {
          const result = await rpc.call(CHANNEL, 'mcp/compositionSource', { selection })
          if (!result.ok) throw new Error(result.error.message)
          return result.value as any
        }} loadFile={async file => {
          const result = await rpc.call(CHANNEL, 'mcp/compositionSource', { selection, path: file.path, expected_sha256: file.sha256 })
          if (!result.ok) throw new Error(result.error.message)
          return result.value as any
        }} />}</div>
        <footer>{preview === 'config' ? <><button type="button" onClick={() => exportDraft(config!, false, '配置')}>复制配置</button><button type="button" onClick={() => exportDraft(config!, true, '配置')}>下载配置</button></> : null}<button type="button" onClick={() => setPreview(null)}>关闭</button></footer>
      </div></div>}
    </section>
  </div>
}
