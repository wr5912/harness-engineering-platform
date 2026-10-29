import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SettingsLauncherOwnerProps, SettingsOnboardingOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { createCatalog, type Catalog } from './catalog.ts'
import type { PageId, PlatformNavigation, PlatformPageProps } from './protocol.ts'
import { HomePage, PlatformLogo } from './home.tsx'
import { AgentsPage } from './agents/client.tsx'
import { EvaluationPage } from './evaluation/client.tsx'
import { navigationHash, readNavigation } from './navigation.ts'
import { InstancesPage } from './instances/client.tsx'
import { McpPage } from './mcp/client.tsx'
import { BusinessControlPage } from './business-control/ui.tsx'
import type { GatewayAssistantBridge } from './business-control/window.tsx'
import { platformTheme } from './theme.ts'
import { bindNewConversation, prepareConversation } from './conversation.ts'
import { AssistantConversation, AssistantOperations, PlatformOperationCard, createAssistant, type Assistant, type AssistantContext } from './assistant/client.tsx'
import { FloatingAssistantPresentation } from './assistant/presentation.ts'
import { createPlatformUpdates, type PlatformUpdates } from './realtime/client.ts'
import { ModelsSettingsFooter } from './models/client.tsx'

export const name = 'harness-platform-client'
export const inject = ['connection', 'remote', 'slots', 'layout', 'workspaces', 'uiWorkspace', 'uiSession', 'sessions', 'conversation', 'theme']
type ThemeScheme = 'light' | 'dark'
type ThemeControls = { getScheme: () => ThemeScheme; setScheme: (scheme: ThemeScheme) => void; subscribe: (listener: () => void) => () => void }
type ThemeChangeSource = { on(event: 'theme/change', listener: () => void): void }
type ClientContext = Omit<Context, 'connection'> & { connection: ConnectionHandle; theme: { getTheme(): { active: { colorScheme: ThemeScheme } }; setTheme(scheme: ThemeScheme): void } }
const pages: { id: PageId; label: string }[] = [
  { id: 'home', label: '首页' }, { id: 'conversations', label: '管理对话' }, { id: 'agents', label: '智能体管理' },
  { id: 'evaluation', label: '评测中心' },
  { id: 'instances', label: '实例管理' }, { id: 'gateway', label: '统一网关' }, { id: 'mcp', label: 'MCP 管理' },
]

type IdentityRows = {
  agents: { id: string; name?: string }[]
  experiments: { id: string; agent_id: string; change?: { variant_name?: string } }[]
}

function agentLabel(id: string, rows: IdentityRows | null) {
  const name = rows?.agents.find(agent => agent.id === id)?.name?.trim()
  if (!name || name === id) return id
  return rows!.agents.some(agent => agent.id !== id && agent.name?.trim() === name) ? `${name}（${id}）` : name
}

function versionNumber(id: string) { return /-(\d{3})(?:-r[0-9a-f]{12})?$/.exec(id)?.[1] }

function versionLabel(id: string, agentId: string | undefined, rows: IdentityRows | null) {
  const version = rows?.experiments.find(item => item.id === id && (!agentId || item.agent_id === agentId))
  if (!version) return id
  const number = versionNumber(id)
  const name = version.change?.variant_name?.trim()
  const repeated = number && rows!.experiments.some(item => item.id !== id && item.agent_id === version.agent_id && versionNumber(item.id) === number)
  return `${name || (number ? `版本 ${number}` : id)}${name && number ? ` · 版本 ${number}` : ''}${repeated ? ` · ${id.slice(-6)}` : ''}`
}

function sourceLabel(source: string, agentId: string | undefined, rows: IdentityRows | null) {
  return source.startsWith('experiment:') ? versionLabel(source.slice('experiment:'.length), agentId, rows) : source
}

type PlatformProps = PlatformPageProps & PropsRuntime<'shell.overlay'> & PropsRenderSlots<'harness.assistant.conversation'> & {
  catalog: Catalog
  assistant: Assistant
  sessions: Context['sessions']
  updates: PlatformUpdates
  theme: ThemeControls
  enterConversation: (sidebarCollapsed?: boolean) => void
  showNativeConversation: (visible: boolean, afterHidden?: () => void) => void
}

function PlatformPage({ catalog, rpc, assistant, updates, theme, enterConversation, showNativeConversation, SessionProvider, renderSlot, useSessionStatus, sessions }: PlatformProps) {
  const [target, setTarget] = useState<PlatformNavigation>(() => readNavigation(window.location.hash))
  const page = target.page
  const mountedPages = useRef(new Set<PageId>([page]))
  mountedPages.current.add(page)
  const [open, setOpen] = useState(false)
  const [assistantReturnAction, setAssistantReturnAction] = useState<Parameters<NonNullable<GatewayAssistantBridge['onAssistantReturnChange']>>[0]>(null)
  const onAssistantReturnChange = useCallback<NonNullable<GatewayAssistantBridge['onAssistantReturnChange']>>(action => setAssistantReturnAction(action), [])
  useEffect(() => { setAssistantReturnAction(null) }, [page])
  const [assistantWidth, setAssistantWidth] = useState(400)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  const [nativeMode, setNativeMode] = useState(false)
  const [unread, setUnread] = useState(false)
  const [account, setAccount] = useState<{ username: string; error?: string }>({ username: '' })
  const [identityRows, setIdentityRows] = useState<IdentityRows | null>(null)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const themeScheme = useSyncExternalStore(theme.subscribe, theme.getScheme)
  const accountMenu = useRef<HTMLDivElement>(null)
  const closeAssistant = useRef<HTMLButtonElement>(null)
  const toggleAssistant = useRef<HTMLButtonElement>(null)
  const previousPage = useRef<PageId>('agents')
  const previousRunning = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const nativeLayoutActive = useRef(false)
  const collapseOnEntry = useRef(true)
  const activePage = useRef(page)
  activePage.current = page
  useEffect(() => { setAccountMenuOpen(false) }, [page])
  useEffect(() => {
    if (!accountMenuOpen) return
    const closeOutside = (event: PointerEvent) => { if (!accountMenu.current?.contains(event.target as Node)) setAccountMenuOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [accountMenuOpen])
  const contexts = useRef<Record<string, AssistantContext>>({})
  const assistantState = useSyncExternalStore(assistant.subscribe, assistant.getSnapshot)
  const assets = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot).inventory
  useEffect(() => {
    let active = true
    void rpc.call('/harness-platform', 'auth/current', {}).then(result => {
      if (!active) return
      setAccount(result.ok ? { username: (result.value as { username: string }).username } : { username: '', error: result.error.message })
    }).catch(() => { if (active) setAccount({ username: '', error: '账号读取失败' }) })
    return () => { active = false }
  }, [rpc])
  useEffect(() => { assistant.restore() }, [assistant, assets?.root])
  const status = useSessionStatus(value => assistantState.sessionId ? value.get(assistantState.sessionId) : undefined)
  const navigate = useCallback((next: PageId | PlatformNavigation) => {
    const { replace, ...destination } = typeof next === 'string' ? { page: next } : next
    if (destination.page === 'conversations') { enterConversation(); assistant.reveal() }
    else if (destination.page !== 'home') previousPage.current = destination.page
    setTarget(destination)
    if (window.location.hash !== navigationHash(destination)) window.history[replace ? 'replaceState' : 'pushState'](null, '', navigationHash(destination))
  }, [assistant, enterConversation])
  useEffect(() => {
    const restore = () => setTarget(readNavigation(window.location.hash))
    window.addEventListener('hashchange', restore)
    window.addEventListener('popstate', restore)
    return () => { window.removeEventListener('hashchange', restore); window.removeEventListener('popstate', restore) }
  }, [])
  const onContext = useCallback((context: AssistantContext) => {
    const contextPage = String(context.page ?? activePage.current)
    contexts.current[contextPage] = context
    if (contextPage === activePage.current) assistant.updateContext(context)
  }, [assistant])
  const onAssistant = async (task: string, context: AssistantContext) => {
    setOpen(true)
    await assistant.create(task, context)
  }
  useEffect(() => { assistant.updateContext(contexts.current[page] ?? { page }) }, [assistant, page])
  useLayoutEffect(() => {
    // 原生布局由管理对话接管，其余页面只保留平台外壳和浮窗。
    nativeLayoutActive.current = true
    const layer = frame.current!.closest<HTMLElement>('[data-shell-overlay]')!
    const underneath = [...layer.parentElement!.children].filter(element => element !== layer) as HTMLElement[]
    const previous = underneath.map(element => ({ element, hidden: element.hidden, inert: element.inert, display: element.style.display }))
    underneath.forEach(element => { element.hidden = true; element.inert = true; element.style.display = 'none' })
    return () => {
      nativeLayoutActive.current = false
      previous.forEach(({ element, hidden, inert, display }) => { element.hidden = hidden; element.inert = inert; element.style.display = display })
    }
  }, [])
  const full = page === 'conversations'
  useLayoutEffect(() => {
    // 整页和浮窗互斥，原生 Session 与输入服务持续保存同一份草稿。
    // 等原生槽确认完成旧编辑器清理后再绑定浮窗，避免覆盖共享输入根节点。
    if (full) { setNativeMode(true); showNativeConversation(true) }
    else showNativeConversation(false, () => { setNativeMode(false) })
    return () => { showNativeConversation(false) }
  }, [full, showNativeConversation])
  useLayoutEffect(() => {
    if (!full) return
    const layer = frame.current!.closest<HTMLElement>('[data-shell-overlay]')!
    const nativeFrame = layer.parentElement!
    if (collapseOnEntry.current) {
      collapseOnEntry.current = false
      // DSH 在 frame 上输出实际折叠状态，无需读取内部 store 或另存侧栏状态。
      enterConversation(nativeFrame.hasAttribute('data-sidebar-collapsed'))
    }
    const elements = [...nativeFrame.children].filter(element => element !== layer) as HTMLElement[]
    const previous = elements.map(element => ({ element, hidden: element.hidden, inert: element.inert, display: element.style.display }))
    elements.forEach(element => { element.hidden = false; element.inert = false; element.style.display = '' })
    nativeFrame.classList.add('harness-conversation-frame')
    const position = () => {
      const bounds = conversation.current!.getBoundingClientRect()
      const parent = nativeFrame.getBoundingClientRect()
      nativeFrame.style.setProperty('--harness-conversation-top', `${bounds.top - parent.top}px`)
      nativeFrame.style.setProperty('--harness-conversation-left', `${bounds.left - parent.left}px`)
    }
    const observer = new ResizeObserver(position)
    observer.observe(frame.current!)
    observer.observe(conversation.current!)
    position()
    return () => {
      observer.disconnect()
      nativeFrame.classList.remove('harness-conversation-frame')
      nativeFrame.style.removeProperty('--harness-conversation-top')
      nativeFrame.style.removeProperty('--harness-conversation-left')
      if (nativeLayoutActive.current) previous.forEach(({ element, hidden, inert, display }) => { element.hidden = hidden; element.inert = inert; element.style.display = display })
    }
  }, [full, enterConversation])
  const navigation = <nav className="harness-nav" aria-label="平台导航">
    {pages.map(item => <button key={item.id} type="button" aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>{item.label}</button>)}
  </nav>
  const visible = page !== 'home' && (open || full)
  const floating = visible && !full && !nativeMode
  const toggleAssistantOpen = () => { if (full) { setOpen(true); navigate(previousPage.current) } else setOpen(value => !value) }
  const fixed = assistantState.status?.execution?.plan
  const needsIdentity = Boolean(target.agent_id || target.experiment_id || target.source_id || fixed?.agent_id)
  useEffect(() => {
    if (!floating || !needsIdentity) { setIdentityRows(null); return }
    let active = true
    let request = 0
    const refresh = () => {
      const current = ++request
      setIdentityRows(null)
      void rpc.call('/harness-platform', 'agents/list', {}).then(result => {
        if (!active || current !== request) return
        const value = result.ok ? result.value as Partial<IdentityRows> : null
        setIdentityRows(value && Array.isArray(value.agents) && Array.isArray(value.experiments)
          ? { agents: value.agents, experiments: value.experiments } : null)
      }).catch(() => { if (active && current === request) setIdentityRows(null) })
    }
    const dispose = updates.subscribe(() => {
      if (updates.getSnapshot().domains.some(domain => domain === 'agents' || domain === 'catalog')) refresh()
    })
    refresh()
    return () => { active = false; dispose() }
  }, [floating, needsIdentity, rpc, updates])
  useEffect(() => { if (floating) closeAssistant.current?.focus() }, [floating])
  useEffect(() => {
    if (visible) setUnread(false)
    else if (previousRunning.current && status?.running === false) setUnread(true)
    previousRunning.current = status?.running ?? false
  }, [visible, status?.running, assistantState.sessionId])
  const waiting = assistantState.status?.proposals?.some(item => item.state === 'awaiting_confirmation')
  const statusLabel = waiting ? '待确认' : status?.pendingInteraction ? '待回复' : status?.running ? '运行中' : unread || status?.completionUnread ? '有新结果' : 'AI 助手'
  const viewedSource = target.source_id ?? (target.experiment_id ? `experiment:${target.experiment_id}` : undefined)
  const viewedObject = [pages.find(item => item.id === page)?.label,
    target.agent_id && agentLabel(target.agent_id, identityRows),
    target.experiment_id && versionLabel(target.experiment_id, target.agent_id, identityRows),
    target.instance_name && `实例 ${target.instance_name}`,
    target.source_id && target.source_id !== `experiment:${target.experiment_id}` && `来源 ${sourceLabel(target.source_id, target.agent_id, identityRows)}`,
    target.server_id && `服务 ${target.server_id}`, target.composition_id && `组合 ${target.composition_id}`,
    target.version_id && `组合版本 ${target.version_id}`, target.job_id && `评测任务 ${target.job_id}`,
    target.run_id && `Run ${target.run_id}`, target.case_id && `用例 ${target.case_id}`].filter(Boolean).join(' · ')
  const fixedObject = fixed ? [fixed.new_agent?.name ?? agentLabel(fixed.agent_id, identityRows),
    fixed.source && sourceLabel(fixed.source, fixed.agent_id, identityRows),
    fixed.instance_name && `实例 ${fixed.instance_name}`].filter(Boolean).join(' · ') : ''
  const sameObject = Boolean(fixed && target.agent_id === fixed.agent_id
    && (viewedSource ?? '') === (fixed.source ?? '')
    && (target.instance_name ?? '') === (fixed.instance_name ?? '')
    && !target.server_id && !target.composition_id && !target.version_id && !target.job_id && !target.run_id && !target.case_id)
  const hasViewedObject = Boolean(target.agent_id || target.experiment_id || target.instance_name || target.source_id
    || target.server_id || target.composition_id || target.version_id || target.job_id || target.run_id || target.case_id)
  const fixedExperiment = fixed?.source?.startsWith('experiment:') ? fixed.source.slice('experiment:'.length) : undefined
  const fixedTarget: PlatformNavigation | null = fixed ? fixed.instance_name
    ? { page: 'instances', instance_name: fixed.instance_name, agent_id: fixed.agent_id, ...(fixed.source ? { source_id: fixed.source } : {}) }
    : { page: 'agents', agent_id: fixed.agent_id, ...(fixedExperiment ? { experiment_id: fixedExperiment } : {}), tab: 'overview' } : null
  const viewedIds = [
    ['Agent ID', target.agent_id], ['版本 ID', target.experiment_id], ['实例名', target.instance_name], ['来源 ID', target.source_id],
    ['服务 ID', target.server_id], ['组合 ID', target.composition_id], ['组合版本 ID', target.version_id],
    ['Job ID', target.job_id], ['Run ID', target.run_id], ['用例 ID', target.case_id],
  ].filter((item): item is [string, string] => Boolean(item[1]))
  const fixedIds = fixed ? [['Agent ID', fixed.agent_id], ['来源 ID', fixed.source], ['实例名', fixed.instance_name]]
    .filter((item): item is [string, string] => Boolean(item[1])) : []
  return <div ref={frame} className="harness-platform" data-page={page} data-assistant-open={floating || undefined}>
    <style>{platformTheme}</style>
    <header className="harness-topbar"><a className="harness-brand" href={navigationHash({ page: 'home' })} aria-label="返回 Harness 工程平台首页" onClick={event => { event.preventDefault(); navigate('home') }}><PlatformLogo size={38}/><span><strong>{full ? 'Harness工程平台' : 'Harness 工程平台'}</strong><small>{full ? 'Harness Engineering Platform' : 'ENGINEERING WORKSPACE'}</small></span></a>
      {navigation}
      <span className="harness-current-module" aria-label={`当前模块：${pages.find(item => item.id === page)?.label}`}>{pages.find(item => item.id === page)?.label}</span>
      <button type="button" className="harness-theme-toggle" aria-label={themeScheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={themeScheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={() => theme.setScheme(themeScheme === 'dark' ? 'light' : 'dark')}><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{themeScheme === 'dark' ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></> : <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>}</svg></button>
      {page !== 'home' && <button ref={toggleAssistant} type="button" className="harness-assistant-toggle" aria-expanded={visible} aria-label={visible ? '收起 AI 助手' : `打开 AI 助手${statusLabel === 'AI 助手' ? '' : `，${statusLabel}`}`} title={statusLabel === 'AI 助手' ? '平台 AI 助手' : `AI 助手 · ${statusLabel}`} data-status={waiting || status?.pendingInteraction ? 'waiting' : status?.running ? 'running' : unread || status?.completionUnread ? 'unread' : undefined} onClick={toggleAssistantOpen}><AssistantIcon/></button>}
      <div ref={accountMenu} className="harness-account" title={account.error ?? account.username ?? undefined} onKeyDown={event => { if (event.key === 'Escape') { setAccountMenuOpen(false); accountMenu.current?.querySelector<HTMLButtonElement>('.harness-account-toggle')?.focus() } }}>
        <button type="button" className="harness-account-toggle" aria-label="平台菜单" aria-expanded={accountMenuOpen} aria-controls="harness-account-actions" onClick={() => setAccountMenuOpen(value => !value)}><span className="harness-avatar">{account.username ? Array.from(account.username)[0].toLocaleUpperCase() : '…'}</span><span className="harness-account-menu-label">{full ? '账号' : account.username || '账号'}</span><span className="harness-menu-icon" aria-hidden="true">☰</span></button>
        <div id="harness-account-actions" className="harness-account-actions" data-open={accountMenuOpen || undefined} onClick={event => { if ((event.target as HTMLElement).closest('button')) setAccountMenuOpen(false) }}><nav className="harness-menu-navigation" aria-label="移动平台导航">{pages.map(item => <button key={item.id} type="button" aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>{item.label}</button>)}</nav><span className="harness-avatar">{account.username ? Array.from(account.username)[0].toLocaleUpperCase() : '…'}</span><span className="harness-account-name">{account.error ? '账号暂不可读' : account.username || '读取账号中…'}</span><span id="harness-settings"/><form method="post" action={new URL('logout', document.baseURI).href}><button type="submit">退出登录</button></form></div>
      </div>
    </header>
    {page !== 'home' && page !== 'conversations' && <button type="button" className="harness-assistant-launch" aria-expanded={visible} aria-label={visible ? '收起 AI 助手' : `打开 AI 助手${statusLabel === 'AI 助手' ? '' : `，${statusLabel}`}`} title={statusLabel === 'AI 助手' ? '平台 AI 助手' : `AI 助手 · ${statusLabel}`} data-status={waiting || status?.pendingInteraction ? 'waiting' : status?.running ? 'running' : unread || status?.completionUnread ? 'unread' : undefined} onClick={toggleAssistantOpen}><AssistantIcon/></button>}
    <div className="harness-body">
      <div className="harness-content">
        {full && <div className="harness-breadcrumb">工作空间 / 管理对话</div>}
        {mountedPages.current.has('home') && <div hidden={page !== 'home'}><HomePage active={page === 'home'} catalog={catalog} rpc={rpc} updates={updates} sessions={sessions} assistant={assistant} navigate={navigate} startConversation={async (_root, prompt, context) => { await assistant.create(prompt, context ?? { page: 'home' }); collapseOnEntry.current = true }} /></div>}
        {mountedPages.current.has('agents') && <div hidden={page !== 'agents'}><AgentsPage rpc={rpc} updates={updates} onAssistant={onAssistant} onContext={onContext} target={target} onNavigate={navigate} active={page === 'agents'} /></div>}
        {mountedPages.current.has('evaluation') && <div hidden={page !== 'evaluation'}><EvaluationPage rpc={rpc} updates={updates} onAssistant={onAssistant} onContext={onContext} target={target} onNavigate={navigate} active={page === 'evaluation'} /></div>}
        {mountedPages.current.has('instances') && <div hidden={page !== 'instances'}><InstancesPage rpc={rpc} updates={updates} onContext={onContext} target={target} onNavigate={navigate} active={page === 'instances'} /></div>}
        <div hidden={page !== 'gateway'}><BusinessControlPage rpc={rpc} updates={updates} active={page === 'gateway'} target={target} onNavigate={navigate} assistantVisible={floating} onAssistantVisibilityChange={setOpen} onAssistantReturnChange={onAssistantReturnChange} /></div>
        {mountedPages.current.has('mcp') && <div hidden={page !== 'mcp'}><McpPage rpc={rpc} updates={updates} onContext={onContext} target={target} onNavigate={navigate} active={page === 'mcp'} /></div>}
        <div ref={conversation} className="harness-conversation-viewport" hidden={!full}/>
        <section className="harness-assistant harness-assistant-floating" hidden={!floating} aria-label="平台 AI 助手" style={{ '--hep-assistant-width': `${assistantWidth}px` } as CSSProperties}>
          <div className="hep-assistant-resize" role="separator" tabIndex={0} aria-label="调整助手宽度" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={560} aria-valuenow={assistantWidth}
            onPointerDown={event => { resizeStart.current = { x: event.clientX, width: assistantWidth }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
            onPointerMove={event => { const start = resizeStart.current; if (start) setAssistantWidth(Math.max(360, Math.min(560, start.width + start.x - event.clientX))) }}
            onPointerUp={() => { resizeStart.current = null }} onLostPointerCapture={() => { resizeStart.current = null }}
            onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setAssistantWidth(width => event.key === 'Home' ? 360 : event.key === 'End' ? 560 : Math.max(360, Math.min(560, width + (event.key === 'ArrowLeft' ? 20 : -20)))) } }}/>
          <header className="harness-assistant-heading"><div><strong>平台 AI 助手</strong><small role="status">{assistantState.busy ? '正在准备会话…' : statusLabel}</small></div><div>
            {page === 'gateway' && assistantReturnAction && <button type="button" onClick={() => { setAssistantReturnAction(null); assistantReturnAction.onReturn() }}>{assistantReturnAction.label}</button>}
            <button title="新建独立任务会话" disabled={assistantState.busy} onClick={() => { void assistant.create().catch(() => {}) }}>新任务</button>
            <button title="在管理对话中展开" onClick={() => navigate('conversations')}>展开</button>
            <button ref={closeAssistant} title="收起助手" onClick={() => { setOpen(false); requestAnimationFrame(() => toggleAssistant.current?.focus()) }}>收起</button>
          </div></header>
          <div className="harness-assistant-context">
            <div className="harness-assistant-context-row"><span>{sameObject ? '当前查看与任务对象' : '当前查看'}：<strong>{viewedObject}</strong></span><a href={navigationHash(target)} onClick={event => { event.preventDefault(); setOpen(false); navigate(target) }}>定位当前对象</a></div>
            {fixedObject && !sameObject && <div className="harness-assistant-context-row"><span>原任务固定对象：<strong>{fixedObject}</strong></span>{fixedTarget && <a href={navigationHash(fixedTarget)} onClick={event => { event.preventDefault(); setOpen(false); navigate(fixedTarget) }}>查看任务对象</a>}</div>}
            {fixedObject && !sameObject && hasViewedObject && <button type="button" disabled={assistantState.busy} onClick={() => { void assistant.create(undefined, { ...target, page }).catch(() => {}) }}>以当前对象新建任务</button>}
            {(viewedIds.length > 0 || fixedIds.length > 0) && <details className="harness-assistant-context-ids"><summary>查看完整对象 ID</summary><dl>{viewedIds.map(([label, value]) => <div key={`viewed-${label}`}><dt>当前查看 · {label}</dt><dd><code>{value}</code></dd></div>)}{!sameObject && fixedIds.map(([label, value]) => <div key={`fixed-${label}`}><dt>任务对象 · {label}</dt><dd><code>{value}</code></dd></div>)}</dl></details>}
          </div>
          {assistantState.sessionId && assistantState.platformContext === false && <p className="harness-assistant-scope">当前为其他工作区会话。平台操作请使用“新任务”。</p>}
          {assistantState.error && <p className="harness-assistant-error" role="alert">{assistantState.error}</p>}
          <div className="harness-assistant-workspace">
            <div className="harness-assistant-chat">
              {floating && assistantState.reference ? <FloatingAssistantPresentation.Provider value><SessionProvider session={assistantState.reference} empty={() => <p role="status">正在连接会话…</p>}>{renderSlot('harness.assistant.conversation', {})}</SessionProvider></FloatingAssistantPresentation.Provider> : <div className="harness-assistant-empty"><PlatformLogo size={48}/><h2>开始新的平台任务</h2><p>管理智能体版本、评测、实例和 MCP。</p><button className="harness-primary" disabled={assistantState.busy} onClick={() => { void assistant.create().catch(() => {}) }}>新建任务会话</button></div>}
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
}

function AssistantIcon() {
  return <svg className="harness-assistant-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path d="M7 15.5 24 6 41 15.5 24 25Z" fill="#8be4ff"/>
    <path d="M7 15.5v18L24 43V25Z" fill="#0075ca"/>
    <path d="M24 25v18l17-9.5v-18Z" fill="#2ec5ff"/>
    <path d="M18 20h13a6 6 0 0 1 6 6v6a6 6 0 0 1-6 6h-5l-6 5v-5h-2a6 6 0 0 1-6-6v-6a6 6 0 0 1 6-6Z" fill="#fff"/>
    <path d="M20 27v3m10-3v3" fill="none" stroke="#0075ca" strokeWidth="3" strokeLinecap="round"/>
    <path d="m36 3 1.8 5.2L43 10l-5.2 1.8L36 17l-1.8-5.2L29 10l5.2-1.8Z" fill="#0075ca" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" paintOrder="stroke"/>
  </svg>
}

function ConversationWelcome({ size }: HeroBrandMarkOwnerProps) {
  return <span className="harness-conversation-welcome"><PlatformLogo size={size}/><span>开始管理与改进智能体</span></span>
}

function NativeConversationHidden({ onReady }: { onReady: () => void }) {
  // layout effect 发生在旧原生 Composer 的 layout 清理之后，作为浮窗的交接点。
  useLayoutEffect(onReady, [onReady])
  return null
}

function PlatformSettings({ openSettings, settingsOpen, settingsShortcut }: SettingsLauncherOwnerProps) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => { setTarget(document.getElementById('harness-settings')) }, [])
  return target && createPortal(<button type="button" aria-haspopup="dialog" aria-expanded={settingsOpen}
    aria-keyshortcuts={settingsShortcut?.aria} onClick={openSettings}>设置</button>, target)
}

export function apply(ctx: ClientContext) {
  ctx.effect(() => bindNewConversation(ctx))
  let modelRevision = 0
  const modelListeners = new Set<() => void>()
  const modelChanges = { getSnapshot: () => modelRevision,
    subscribe: (listener: () => void) => { modelListeners.add(listener); return () => { modelListeners.delete(listener) } } }
  ctx.effect(() => {
    const changed = () => { modelRevision++; modelListeners.forEach(listener => listener()) }
    const disposers = [ctx.remote.$on('settings/document-updated', changed), ctx.remote.$on('credentials/record-updated', changed),
      ctx.remote.$on('credentials/reference-updated', changed),
      ctx.remote.$on('llm/adapters-updated', changed), ctx.on('connection/reset', changed)]
    return () => disposers.forEach(dispose => dispose())
  })
  const themeListeners = new Set<() => void>()
  const themeEvents = ctx as unknown as ThemeChangeSource
  themeEvents.on('theme/change', () => themeListeners.forEach(listener => listener()))
  const theme: ThemeControls = { getScheme: () => ctx.theme.getTheme().active.colorScheme,
    setScheme: scheme => ctx.theme.setTheme(scheme), subscribe: listener => { themeListeners.add(listener); return () => themeListeners.delete(listener) } }
  ctx.effect(() => ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'welcome-notice', order: -100, priority: -1,
  }, ({ complete }: SettingsOnboardingOwnerProps) => {
    useEffect(() => { complete() }, [complete])
    return null
  })))
  const updates = createPlatformUpdates(ctx.connection)
  ctx.effect(() => updates.start())
  const catalog = createCatalog(ctx.connection.rpc, updates)
  // 首次读取不依赖事件流首帧；连接池或通知通道异常时页面仍会发起资产查询。
  ctx.effect(() => { void catalog.refresh(); return () => catalog.dispose() })
  const assistant = createAssistant(ctx, ctx.connection.rpc, () => catalog.getSnapshot().inventory?.root, () => catalog.getSnapshot().inventory?.workspace?.legacyRoots ?? [])
  ctx.effect(() => () => assistant.dispose())
  ctx.effect(() => updates.subscribe(() => { void assistant.refresh() }))
  ctx.on('connection/reset', () => { void catalog.refresh(); void assistant.reconnect() })
  let nativeReady = false
  let nativeVisible = false
  let nativeHidden = false
  let afterNativeHidden: (() => void) | undefined
  let suppressNative: (() => void) | undefined
  const showNativeConversation = (visible: boolean, afterHidden?: () => void) => {
    nativeVisible = visible
    afterNativeHidden = afterHidden
    if (visible) { nativeHidden = false; suppressNative?.(); suppressNative = undefined }
    else if (nativeReady && !suppressNative) suppressNative = ctx.slots.register({
      name: 'main.conversation', priority: -100,
      inject: () => ({ onReady: () => { if (!nativeVisible) { nativeHidden = true; afterNativeHidden?.() } } }),
    }, NativeConversationHidden)
    if (!visible && nativeHidden) afterNativeHidden?.()
  }
  ctx.slots.inject('main.conversation', () => {
    nativeReady = true
    showNativeConversation(nativeVisible)
    return () => { nativeReady = false; nativeHidden = false; afterNativeHidden = undefined; suppressNative?.(); suppressNative = undefined }
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'harness-platform', order: -100,
    children: { 'harness.assistant.conversation': { kind: 'single', scope: 'session-maybe' } },
    inject: () => ({ catalog, assistant, sessions: ctx.sessions, updates, theme, rpc: ctx.connection.rpc, enterConversation: (sidebarCollapsed?: boolean) => prepareConversation(ctx.layout, sidebarCollapsed), showNativeConversation }),
  }, PlatformPage))
  ctx.slots.inject('harness.assistant.conversation', () => ctx.slots.register({ name: 'harness.assistant.conversation' }, AssistantConversation))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'harness-operation-confirmation', inject: () => ({ rpc: ctx.connection.rpc, assistant }) }, AssistantOperations))
  for (const key of ['platform_agents', 'platform_instances', 'platform_mcp', 'platform_task']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, inject: () => ({ rpc: ctx.connection.rpc, assistant }) }, PlatformOperationCard))
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', priority: -1 }, PlatformSettings))
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'harness-model-sharing', order: 20,
    inject: () => ({ rpc: ctx.connection.rpc, changes: modelChanges }) }, ModelsSettingsFooter))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1 }, ({ size }: SidebarBrandMarkOwnerProps) => <PlatformLogo size={size}/>))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, () => <span>管理对话</span>))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -1 }, ConversationWelcome))
}
