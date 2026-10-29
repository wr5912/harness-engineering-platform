import { useEffect, useRef, useState } from 'react'
import { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { Manager } from 'harness-mcp-manager-client'
import { copyText } from '../../../../plugins/mcp-manager/clipboard.ts'
import { SearchSelect } from '../components/search-select.tsx'
import { DetailDrawer } from '../components/detail-drawer.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { CompositionCanvas } from './graph-canvas.tsx'
import { PasswordInput } from './components.tsx'
import { CHANNEL, type PlatformNavigation, type PlatformPageProps } from '../protocol.ts'
import type { CompositionConfig, CompositionEntry } from './compositions.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { useQueuedRefresh } from '../realtime/refresh.ts'
import { compositionTestInput, isThreatComposition, ThreatConfigurationFields, ThreatRunResult, threatEditorStyle } from './threat-editor.tsx'

type LivePageProps = { updates?: PlatformUpdates; onContext?(context: Record<string, unknown>): void }
type NavigationProps = { target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void; active?: boolean }

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
      }).catch(() => setState((previous: any) => previous.status === 'ready'
        ? { ...previous, error: '无法读取 MCP 数据配置，请检查连接后重试。' }
        : { status: 'unavailable', error: '无法读取 MCP 数据配置，请检查连接后重试。' })),
      page === 'composition' ? Promise.resolve() : rpc.call(CHANNEL, 'mcp/list', {}).then(response => {
        if (response.ok) { setPublishedService((response.value as any).publishedService ?? null); setServiceError(''); setServiceLoaded(true) }
        else setServiceError(response.error.message)
      }).catch(() => setServiceError('无法读取已发布组合服务，请刷新重试。')),
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
    <div className="harness-mcp-module-toolbar">
      <nav className="harness-mcp-toolbar harness-mcp-tabs" aria-label="MCP 工作区">{tabs.map(tab => <button key={tab.id} type="button" aria-current={page === tab.id ? 'page' : undefined} onClick={() => selectTab(tab.id)}>{tab.title}</button>)}</nav>
      <button type="button" className="harness-primary" disabled={state.status !== 'ready'} onClick={() => { selectTab('servers'); requestAnimationFrame(() => managerRoot.current?.querySelector<HTMLButtonElement>('.mcp-service-layout .mcp-add')?.click()) }}>＋ 接入服务</button>
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
        return response.ok ? { ok: true } : { ok: false, error: response.error }
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
  const [continuedRun, setContinuedRun] = useState<{ id: string; version: string; runId: string } | null>(null)
  const [rawResult, setResult] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState('')
  const [selectedNode, setSelectedNode] = useState('getAsset')
  const [preview, setPreview] = useState<'config' | 'source' | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (!preview) return; const previous = document.activeElement as HTMLElement | null; previewRef.current?.focus(); return () => previous?.focus?.() }, [preview])
  useEffect(() => { setPreview(null) }, [target?.composition_id, target?.version, target?.version_id])
  const requestId = useRef(0)
  const actionId = useRef(0)
  const detailRef = useRef<HTMLElement>(null)
  const locatedComposition = useRef('')
  const listRef = useRef<HTMLElement>(null)
  const listButtons = useRef(new Map<string, HTMLButtonElement>())
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
  const threat = isThreatComposition(config)
  const registeredConnections = data?.connections ?? []
  const connections = data?.connections?.filter((item: any) => item.kind === 'openapi') ?? []
  const extensionReady = config?.flow ? Boolean(data?.extension?.flow) : config?.kind ? Boolean(data?.extension?.stages) : true
  const upstream = extensionReady && config && (config.kind === 'threat-stage'
    ? [config.bindings?.socConnectionId, config.bindings?.reportConnectionId].every(id => registeredConnections.some((item: any) => item.id === id))
    : config.kind === 'composite' ? config.steps?.every(step => entries.find(item => item.id === step.compositionId)?.versions?.some(version => version.versionId === step.versionId))
      : [config.connectionId, ...(config.flow ? [config.alertsConnectionId] : [])].every(id => connections.some((item: any) => item.id === id)))
  const graph = result?.graph ?? (historical ? undefined : selection && data?.compositions.find((item: any) => item.id === selection.id)?.graphs?.[selection.version])
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
  const carriedRun = continuedRun && continuedRun.id === selection?.id && continuedRun.version === selection?.version && continuedRun.runId === asset ? continuedRun.runId : null

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
    } catch { if (id === requestId.current) setError('无法读取编排目录。') }
    finally { if (id === requestId.current) setCatalogLoading(false) }
  })
  useEffect(() => { void refreshCatalog(); return () => { requestId.current++ } }, [configuration])

  function select(item: CompositionEntry, version: 'draft' | 'published', versionId?: string, focus = true) {
    const next = { id: item.id, version, ...(versionId ? { versionId } : {}) }
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
      } else setResult(value)
      if (['saveCompositionDraft', 'publishComposition'].includes(endpoint)) updates?.invalidate(['mcp'])
    } catch { if (id === actionId.current) setError('操作失败，请检查连接并重试。') }
    finally { if (id === actionId.current) { setBusy(false); setPendingAction('') } }
  }
  const selectedPayload = { compositionId: entry?.id, version: selection?.version, revision: data?.revision, input: compositionTestInput(config || undefined, asset) }
  const conflict = Boolean(editor && data && (conflictDetected || editor.revision !== data.revision))
  return <div className="harness-composition-workspace">
    <style>{threatEditorStyle}</style>
    <nav ref={listRef} className="harness-card harness-composition-sidebar" aria-label="工具编排列表">
      <h2>工具组合编排{data && (catalogLoading || busy && pendingAction === 'list') && <LoadingIndicator label="刷新编排目录" />}</h2><div className="harness-mcp-actions"><button type="button" disabled={busy || !!editor || !data} onClick={() => setEditor({ revision: data.revision, value: { toolName: '', title: '资产相关告警查询', description: '查询资产后查询相关告警的两步只读组合', connectionId: connections[0]?.id ?? '' } })}>新建编排</button>
        <button type="button" disabled={busy || !!editor} onClick={() => void refreshCatalog()}>刷新</button></div>
      <section aria-label="全部编排"><h3>全部编排（{entries.length}）</h3>
        {!data ? null : entries.length ? <ul>{entries.map(item => {
          const version = item.draft ? 'draft' : 'published'
          const value = item[version]!
          return <li key={item.id}><button ref={element => { if (element) listButtons.current.set(item.id, element); else listButtons.current.delete(item.id) }} type="button" disabled={busy || !!editor} aria-current={selection?.id === item.id ? 'true' : undefined} onClick={() => select(item, version, version === 'published' ? item.publishedVersionId : undefined)}>
            <span>{value.title}</span><small>{value.toolName}</small>
            <span className="harness-composition-status">{item.published && <span data-state="published">已发布</span>}{item.draft && <span data-state="draft">正在编辑</span>}</span>
          </button></li>
        })}</ul> : <p>暂无编排</p>}
      </section>
    </nav>
    <section ref={detailRef} tabIndex={-1} className="harness-card harness-composition-detail" aria-label="组合编排详情">
      <button type="button" className="harness-composition-return" onClick={() => { listRef.current?.scrollIntoView({ block: 'start' }); if (selection) listButtons.current.get(selection.id)?.focus() }}>返回编排列表</button>
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
      {!config && !editor ? !data ? !error && <LoadingIndicator label="读取编排目录" block /> : <p>{selection ? `所选编排 ${selection.id} 的${selection.version === 'draft' ? '草稿' : selection.versionId ? `发布版本 ${selection.versionId}` : '当前发布版本'}已不存在，请重新选择。` : '选择一个编排查看，或新建编排。'}</p> : <>
        <div className="harness-composition-heading"><h2>{editor ? (editor.id ? '编辑草稿' : '新建编排') : config?.title}</h2>{!editor && <Tooltip disabled={!active} label={`MCP 入口：${new URL('api/harness-platform/mcp', document.baseURI).href}。入口受平台登录认证保护，仅列出并执行已发布版本。草稿供查看与测试，发布后调用方需重新发现工具。`} side="bottom" align="end" portal maxWidth={400} openOnClick><button type="button" className="harness-composition-help" aria-label="调用与发布说明"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 5.5v1"/></svg></button></Tooltip>}</div>
        {editor ? <form onSubmit={event => { event.preventDefault(); if (!mappingValid) return; void action('saveCompositionDraft', { compositionId: editor.id, revision: editor.revision, draft: editor.value }) }} className="harness-composition-editor">
          <p>{isThreatComposition(editor.value) ? '编辑阶段连接或固定子版本，保存草稿后进行 dry 校验和发布。' : '复用当前 LangGraph 两步只读流程：查询资产 → 查询相关告警。保存草稿后进行 dry 测试和发布。'}</p>
          <label>编排标题<input required maxLength={80} value={editor.value.title} onChange={event => setEditor({ ...editor, value: { ...editor.value, title: event.target.value } })} /></label>
          <label>工具名称<input required maxLength={64} pattern="[A-Za-z0-9_.\-]+" value={editor.value.toolName} onChange={event => setEditor({ ...editor, value: { ...editor.value, toolName: event.target.value } })} /></label>
          <label className="harness-mcp-wide">工具说明<textarea maxLength={500} value={editor.value.description} onChange={event => setEditor({ ...editor, value: { ...editor.value, description: event.target.value } })} /></label>
          {isThreatComposition(editor.value) ? <ThreatConfigurationFields rpc={rpc} active={active} identity={`${editor.id ?? 'new'}:${editor.revision}`} onValidityChange={setMappingValid} value={editor.value} change={value => setEditor({ ...editor, value })} compositionId={editor.id} connections={registeredConnections} entries={entries}/> : <><label>接口流程<select value={editor.value.flow ?? ''} onChange={event => setEditor({ ...editor, value: { ...editor.value, flow: event.target.value === 'soc-asset-alerts' ? 'soc-asset-alerts' : undefined, alertsConnectionId: event.target.value ? editor.value.alertsConnectionId ?? connections[0]?.id ?? '' : undefined } })}>
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
          <div className="harness-mcp-actions"><button disabled={busy || conflict || !mappingValid} type="submit">保存草稿</button><button disabled={busy || !mappingValid} type="button" onClick={() => { setRecoveryDraft(editor); setEditor(null); setError('草稿已暂存于当前页面。刷新或关闭前请复制或下载，继续编辑时请手工核对最新目录。') }}>暂存并返回详情</button></div>
          <p>草稿保存到仓库编排目录；已发布版本继续供 MCP 调用。</p>
        </form> : <>
          <div className="harness-mcp-actions" aria-label="编排版本">{(['draft', 'published'] as const).filter(version => entry?.[version]).map(version => <button key={version} disabled={busy} aria-pressed={selection?.version === version && (version === 'draft' || !selection.versionId || selection.versionId === entry?.publishedVersionId)} onClick={() => select(entry!, version, version === 'published' ? entry?.publishedVersionId : undefined, false)}>{version === 'draft' ? '编辑草稿' : '当前发布版本'}</button>)}
            {entry?.versions?.filter(version => version.versionId !== entry.publishedVersionId).map(version => <button key={version.versionId} type="button" disabled={busy} aria-pressed={selection?.versionId === version.versionId} onClick={() => select(entry, 'published', version.versionId, false)}>历史版本 {version.versionId.slice(0, 12)}</button>)}</div>
          <p>{selection?.version === 'draft' ? '草稿尚未发布' : historical ? '历史发布版本，只读查看' : '当前版本已发布'} · {upstream ? '依赖已登记，等待实际调用验证' : threat ? '请编辑连接或选择已发布的固定子版本' : '请先接入所需的 OpenAPI 服务器'}</p>
          {selection?.version === 'published' && <p>版本 ID：<code>{selection.versionId ?? entry?.publishedVersionId ?? '未提供'}</code>{historical && <> · 发布时间：{frozenVersion?.publishedAt ?? '未记录'}</>}</p>}
          {config?.description?.trim() && config.description.trim() !== config.title.trim() && <p>{config.description}</p>}<p>工具：<code>{config?.toolName}</code> · {config?.kind === 'threat-stage' ? <>SOC：<code>{config.bindings?.socConnectionId}</code> · 报告：<code>{config.bindings?.reportConnectionId}</code></> : config?.kind === 'composite' ? '调用下列固定子组合版本' : <>上游：<code>{config?.connectionId}</code>{config?.flow && <> → <code>{config.alertsConnectionId}</code></>}</>}</p>
          {selection?.version === 'published' && !historical && entry?.published?.publishedAt && <p>发布时间：{entry.published.publishedAt}</p>}
          <button type="button" disabled={busy} onClick={() => { setEditor({ id: entry!.id, revision: data.revision, value: { ...(entry!.draft ?? config!) } }); setResult(null); setError('') }}>{entry?.draft ? '继续编辑草稿' : '解锁编辑'}</button>
          <button type="button" onClick={() => setPreview('config')}>查看配置</button> <button type="button" onClick={() => setPreview('source')}>查看生成代码</button>
        </>}
        {!editor && <div className="harness-composition-layout"><div>
          {historical && <p>此历史版本仅提供冻结配置查看；执行请通过固定版本的调用入口验证。</p>}
          <CompositionCanvas graph={graph} selected={node?.id} onSelect={setSelectedNode} identity={`${selection?.id}:${selection?.version}:${selection?.versionId ?? ''}`}/>
        </div><aside className="harness-card" aria-label="编排节点详情">{node && <><h3>{node.id === '__start__' ? '开始' : node.id === '__end__' ? '结束' : node.title}</h3><p>{node.operationId ? <>工具：<code>{node.operationId}</code></> : node.id === '__start__' ? '流程开始' : node.id === '__end__' ? '流程结束' : '流程节点'}</p><p>状态：{result?.mode === 'dry' ? 'dry 未执行节点' : trace?.status ?? '尚未执行'}</p>
          {node.operationId && <><h4>输入映射</h4><dl className="harness-fields">{Object.entries(node.input ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
          {trace?.mappedArguments && <pre className="harness-asset-content">{JSON.stringify(trace.mappedArguments, null, 2)}</pre>}
          <h4>输出：{node.output}</h4><pre className="harness-asset-content">{result?.result ? JSON.stringify(config?.kind === 'threat-stage' ? result.result : result.result.stepValues?.[node.output] ?? result.result[node.output], null, 2) : '尚无执行结果'}</pre>{trace?.reason && <p>{trace.reason}</p>}</>}
        </>}</aside></div>}
        {!editor && !historical && <><section className="harness-composition-test"><p>{threat ? '实际执行将按已编译流程调用取证、模型或模拟存储；请使用基本运维测试事件。' : '第一步失败或缺少资产 ID 时，第二步停止执行。'}</p>
          {config?.kind === 'threat-stage' && config.stage !== 'collect' ? <>
            {carriedRun && <p role="status">已带入上一阶段返回的运行：<code>{carriedRun}</code>。核对本阶段后再执行。</p>}
            <DetailDrawer title="按已知运行恢复" trigger={carriedRun ? '更换运行（高级恢复）' : '按已知运行恢复（高级）'} active={active} identity={`${selection?.id}:${selection?.version}:${selection?.versionId ?? ''}`}><div className="harness-threat-editor"><p>填写已有阶段返回的运行 ID。关闭窗口后输入仍保留，实际执行仍需在本阶段点击“实际执行组合工具”。</p><label>运行 ID<input aria-label="组合运行 ID" disabled={busy} value={asset} onChange={event => { if (busy) return; actionId.current++; setAsset(event.target.value); setContinuedRun(null); setResult(null) }} placeholder="填写已有阶段返回的 run_id" /></label></div></DetailDrawer>
            {!asset && <p>从上一阶段的实际结果选择“继续”，即可自动带入同一运行；也可按已知运行恢复。</p>}
          </> : <label>{threat ? '事件 ID' : '查询资产'}<input aria-label={threat ? '组合事件 ID' : '组合查询资产'} disabled={busy} value={asset} onChange={event => { if (busy) return; actionId.current++; setAsset(event.target.value); setResult(null) }} placeholder={threat ? 'INC-20261015-000001' : config?.flow ? '资产 ID，如 9106' : '资产 ID、主机名或 IP'} /></label>}
          <div className="harness-mcp-actions"><button type="button" disabled={busy || !asset.trim()} onClick={() => void action('dryRunComposition', selectedPayload)}>测试（dry）</button>
            {selection?.version === 'draft' && <button type="button" disabled={busy || !asset.trim()} onClick={() => void action('publishComposition', selectedPayload)}>发布工具</button>}
            <button type="button" disabled={busy || !asset.trim() || !upstream} onClick={() => void action('executeComposition', selectedPayload)}>实际执行组合工具</button></div>
          <p>测试及发布前校验均使用 dry，不请求上游。{threat ? '阶段测试不自动补跑其他阶段；完整流程请执行总组合。' : '实际执行会调用两个只读工具。'}</p>
          {result?.mode === 'dry' && <div role="status"><p>dry 校验通过 · 上游请求 {result.upstreamRequests} 次</p><p>{result.checks.join('、')}。未验证：{result.unverified.join('、')}。</p></div>}
          {result && result.mode !== 'dry' && (threat ? <><ThreatRunResult rpc={rpc} execution={result}/>{continuations.length > 0 && <div className="harness-mcp-actions" aria-label="继续当前运行">{continuations.map(next => <button type="button" key={next.entry.id} disabled={busy} onClick={() => { const runId = run.run_id; select(next.entry, next.version, next.version === 'published' ? next.entry.publishedVersionId : undefined); setAsset(runId); setContinuedRun({ id: next.entry.id, version: next.version, runId }) }}>继续{nextStage === 'infer' ? '模型研判' : nextStage === 'writeback' ? '结果回写' : '报告保存'} · {next.config.title}（{next.version === 'draft' ? '草稿' : '已发布'}）</button>)}</div>}</> : <div><p role="status">{result.ok ? '组合执行成功' : '组合执行失败'}</p>{result.error && <p role="alert">{result.error.message}</p>}
            {result.result?.alertSummary && <p>近 30 天：{result.result.alertSummary.totalGroups} 个告警分组 · {result.result.alertSummary.totalAlerts} 条告警 · 当前展示 {result.result.alerts.length} 个分组。{result.result.alertSummary.truncated && '上游结果已截断。'}<br/>查询范围：{result.result.alertSummary.from} ～ {result.result.alertSummary.to}</p>}
            <div className="harness-table-scroll"><table className="harness-composition-trace"><thead><tr><th>步骤</th><th>状态</th><th>HTTP</th><th>耗时</th></tr></thead><tbody>{(result.result?.trace ?? []).map((step: any) => <tr key={step.step}><td data-label="步骤">{step.operationId}</td><td data-label="状态">{step.status}</td><td data-label="HTTP">{step.httpStatus ?? '未调用'}</td><td data-label="耗时">{step.durationMs === undefined ? '—' : `${step.durationMs} ms`}</td></tr>)}</tbody></table></div>
            <details><summary>业务结果</summary><pre>{JSON.stringify({ asset: result.result?.asset, alerts: result.result?.alerts, alertSummary: result.result?.alertSummary }, null, 2)}</pre></details><details><summary>执行回执与来源版本</summary><pre>{JSON.stringify({ receipts: result.receipts, version: result.version }, null, 2)}</pre></details></div>)}
          </section>
        </>}
      </>}
      {preview && <div className="harness-composition-modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setPreview(null) }}><div ref={previewRef} tabIndex={-1} className="harness-composition-modal" role="dialog" aria-modal="true" aria-label={preview === 'config' ? '查看编排配置' : '查看生成代码'} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setPreview(null) }; if (event.key === 'Tab') { const elements = previewRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),pre[tabindex]'); if (!elements?.length) return; const first = elements[0], last = elements[elements.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === previewRef.current)) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } } }}>
        <header><h2>{preview === 'config' ? '编排配置' : '生成代码'}</h2><button type="button" onClick={() => setPreview(null)} aria-label="关闭编排预览">×</button></header>
        <div><p>{config?.title} · {historical ? '历史发布版本' : selection?.version === 'published' ? '当前发布版本' : '已保存草稿'}</p>{preview === 'config' ? <pre tabIndex={0}>{JSON.stringify(config, null, 2)}</pre> : <p role="status">当前平台尚未接入生成源码的保存与读取。此编排按已保存配置构建 LangGraph，可在画布查看流程，或查看真实配置。</p>}</div>
        <footer>{preview === 'config' ? <><button type="button" onClick={() => exportDraft(config!, false, '配置')}>复制配置</button><button type="button" onClick={() => exportDraft(config!, true, '配置')}>下载配置</button></> : <button type="button" disabled>生成并保存源码 · 未接入</button>}<button type="button" onClick={() => setPreview(null)}>关闭</button></footer>
      </div></div>}
    </section>
  </div>
}
