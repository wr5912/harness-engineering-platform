import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ConfigForm, SettingsLauncherOwnerProps, SettingsOnboardingOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createCatalog, type Catalog } from './catalog.ts'
import type { PageId, PlatformNavigation, PlatformPageProps } from './protocol.ts'
import { HomePage, PlatformLogo } from './home.tsx'
import { AgentsPage } from './agents/client.tsx'
import { EvaluationPage } from './evaluation/client.tsx'
import { navigationHash, readNavigation } from './navigation.ts'
import { InstancesPage } from './instances/client.tsx'
import { McpPage } from './mcp/client.tsx'
import { BusinessControlPage } from './business-control/ui.tsx'
import { platformTheme } from './theme.ts'
import { prepareConversation } from './conversation.ts'
import { AssistantConversation, AssistantOperations, PlatformOperationCard, createAssistant, type Assistant, type AssistantContext } from './assistant/client.tsx'
import { createPlatformUpdates, type PlatformUpdates } from './realtime/client.ts'

export const name = 'harness-platform-client'
export const inject = ['connection', 'slots', 'configForms', 'layout', 'workspaces', 'uiWorkspace', 'uiSession', 'sessions', 'conversation']
type ClientContext = Omit<Context, 'connection'> & { connection: ConnectionHandle }
const pages: { id: PageId; label: string }[] = [
  { id: 'home', label: '首页' }, { id: 'conversations', label: '管理对话' }, { id: 'agents', label: '智能体管理' },
  { id: 'evaluation', label: '评测中心' },
  { id: 'instances', label: '实例管理' }, { id: 'gateway', label: '统一网关' }, { id: 'mcp', label: 'MCP 管理' },
]

type PlatformProps = PlatformPageProps & PropsRuntime<'shell.overlay'> & PropsRenderSlots<'harness.assistant.conversation'> & {
  catalog: Catalog
  assistant: Assistant
  updates: PlatformUpdates
  mcpForm: ConfigForm<any>
  enterConversation: (sidebarCollapsed?: boolean) => void
  showNativeConversation: (visible: boolean, afterHidden?: () => void) => void
}

function PlatformPage({ catalog, rpc, mcpForm, assistant, updates, enterConversation, showNativeConversation, SessionProvider, renderSlot, useSessionStatus }: PlatformProps) {
  const [target, setTarget] = useState<PlatformNavigation>(() => readNavigation(window.location.hash))
  const page = target.page
  const [open, setOpen] = useState(false)
  const [nativeMode, setNativeMode] = useState(false)
  const [unread, setUnread] = useState(false)
  const previousPage = useRef<PageId>('agents')
  const previousRunning = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const nativeLayoutActive = useRef(false)
  const collapseOnEntry = useRef(true)
  const activePage = useRef(page)
  activePage.current = page
  const contexts = useRef<Record<string, AssistantContext>>({})
  const assistantState = useSyncExternalStore(assistant.subscribe, assistant.getSnapshot)
  const assets = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot).inventory
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
  useEffect(() => {
    if (visible) setUnread(false)
    else if (previousRunning.current && status?.running === false) setUnread(true)
    previousRunning.current = status?.running ?? false
  }, [visible, status?.running, assistantState.sessionId])
  const waiting = assistantState.status?.proposals?.some(item => item.state === 'awaiting_confirmation')
  const statusLabel = waiting ? '待确认' : status?.pendingInteraction ? '待回复' : status?.running ? '运行中' : unread || status?.completionUnread ? '有新结果' : 'AI 助手'
  return <div ref={frame} className="harness-platform" data-page={page}>
    <style>{platformTheme}</style>
    <header className="harness-topbar"><div className="harness-brand"><PlatformLogo size={38}/><div><strong>Harness工程平台</strong><small>Harness Engineering Platform</small></div></div>
      {navigation}
      <div className="harness-account"><span className="harness-avatar">A</span><span>admin</span><span id="harness-settings"/><form method="post" action={new URL('logout', document.baseURI).href}><button type="submit">退出登录</button></form></div>
    </header>
    <div className="harness-body">
      <div className="harness-content">
        {page !== 'home' && <div className="harness-breadcrumb">工作空间 / {pages.find(item => item.id === page)?.label}</div>}
        <div hidden={page !== 'home'}><HomePage catalog={catalog} rpc={rpc} updates={updates} navigate={navigate} startConversation={async (_root, prompt, context) => { await assistant.create(prompt, context ?? { page: 'home' }); collapseOnEntry.current = true }} /></div>
        <div hidden={page !== 'agents'}><AgentsPage rpc={rpc} updates={updates} onAssistant={onAssistant} onContext={onContext} target={target} onNavigate={navigate} active={page === 'agents'} /></div>
        <div hidden={page !== 'evaluation'}><EvaluationPage rpc={rpc} updates={updates} onAssistant={onAssistant} onContext={onContext} target={target} onNavigate={navigate} active={page === 'evaluation'} /></div>
        <div hidden={page !== 'instances'}><InstancesPage rpc={rpc} updates={updates} onContext={onContext} target={target} onNavigate={navigate} /></div>
        <div hidden={page !== 'gateway'}><BusinessControlPage rpc={rpc} updates={updates} active={page === 'gateway'} /></div>
        <div hidden={page !== 'mcp'}><McpPage rpc={rpc} form={mcpForm} updates={updates} onContext={onContext} /></div>
        <div ref={conversation} className="harness-conversation-viewport" hidden={!full}/>
        <section className="harness-assistant harness-assistant-floating" hidden={!floating} aria-label="平台 AI 助手">
          <header className="harness-assistant-heading"><div><strong>平台 AI 助手</strong><small role="status">{assistantState.busy ? '正在准备会话…' : statusLabel}</small></div><div>
            <button title="新建独立任务会话" disabled={assistantState.busy} onClick={() => { void assistant.create().catch(() => {}) }}>新任务</button>
            <button title="在管理对话中展开" onClick={() => navigate('conversations')}>展开</button>
            <button title="收起助手" onClick={() => { setOpen(false) }}>收起</button>
          </div></header>
          {assistantState.sessionId && assistantState.platformContext === false && <p className="harness-assistant-scope">当前为其他工作区会话。平台操作请使用“新任务”。</p>}
          {assistantState.error && <p className="harness-assistant-error" role="alert">{assistantState.error}</p>}
          <div className="harness-assistant-workspace">
            <div className="harness-assistant-chat">
              {floating && assistantState.reference ? <SessionProvider session={assistantState.reference} empty={() => <p role="status">正在连接会话…</p>}>{renderSlot('harness.assistant.conversation', {})}</SessionProvider> : <div className="harness-assistant-empty"><PlatformLogo size={48}/><h2>开始新的平台任务</h2><p>管理智能体版本、评测、实例和 MCP。</p><button className="harness-primary" disabled={assistantState.busy} onClick={() => { void assistant.create().catch(() => {}) }}>新建任务会话</button></div>}
            </div>
          </div>
        </section>
      </div>
    </div>
    {page !== 'home' && <button type="button" className="harness-assistant-toggle" aria-expanded={visible} aria-label={visible ? '收起 AI 助手' : `打开 AI 助手${statusLabel === 'AI 助手' ? '' : `，${statusLabel}`}`} title={statusLabel === 'AI 助手' ? '平台 AI 助手' : `AI 助手 · ${statusLabel}`} data-status={waiting || status?.pendingInteraction ? 'waiting' : status?.running ? 'running' : unread || status?.completionUnread ? 'unread' : undefined} onClick={() => { if (full) { setOpen(true); navigate(previousPage.current) } else setOpen(value => !value) }}><AssistantIcon/></button>}
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
  ctx.effect(() => ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding', id: 'welcome-notice', order: -100, priority: -1,
  }, ({ complete }: SettingsOnboardingOwnerProps) => {
    useEffect(() => { complete() }, [complete])
    return null
  })))
  const updates = createPlatformUpdates(ctx.connection)
  ctx.effect(() => updates.start())
  const catalog = createCatalog(ctx.connection.rpc, updates)
  ctx.effect(() => () => catalog.dispose())
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
    inject: () => ({ catalog, assistant, updates, rpc: ctx.connection.rpc, mcpForm: ctx.configForms.get('mcp-session-manager'), enterConversation: (sidebarCollapsed?: boolean) => prepareConversation(ctx.layout, sidebarCollapsed), showNativeConversation }),
  }, PlatformPage))
  ctx.slots.inject('harness.assistant.conversation', () => ctx.slots.register({ name: 'harness.assistant.conversation' }, AssistantConversation))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'harness-operation-confirmation', inject: () => ({ rpc: ctx.connection.rpc, assistant }) }, AssistantOperations))
  for (const key of ['platform_agents', 'platform_instances', 'platform_mcp', 'platform_task']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key, inject: () => ({ rpc: ctx.connection.rpc, assistant }) }, PlatformOperationCard))
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', priority: -1 }, PlatformSettings))
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark', priority: -1 }, ({ size }: SidebarBrandMarkOwnerProps) => <PlatformLogo size={size}/>))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', priority: -1 }, () => <span>管理对话</span>))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: -1 }, ConversationWelcome))
}
