import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react'

export type GatewayAssistantBridge = {
  assistantVisible?: boolean
  onAssistantVisibilityChange?(visible: boolean): void
  onAssistantReturnChange?(action: { label: string; onReturn(): void } | null): void
}
const WindowContext = createContext<GatewayAssistantBridge & { current: string | null; select(value: string): void; restoreAssistant: MutableRefObject<boolean> } | null>(null)

export function GatewayWindows({ children, ...assistant }: GatewayAssistantBridge & { children: ReactNode }) {
  const [current, select] = useState<string | null>(null)
  const restoreAssistant = useRef(false)
  const workspace = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = workspace.current, content = element?.closest('.harness-content')
    const panel = element?.closest('.harness-platform')?.querySelector<HTMLElement>('.harness-assistant-floating')
    if (!element || !content || !panel) return
    const position = () => {
      const area = content.getBoundingClientRect(), bounds = panel.getBoundingClientRect()
      const parallel = !panel.hidden && bounds.left - area.left - 48 >= 360
      element.style.setProperty('--gateway-assistant-inset', `${parallel ? area.right - bounds.left + 24 : 0}px`)
    }
    position()
    const resize = new ResizeObserver(position)
    resize.observe(content); resize.observe(panel)
    window.addEventListener('resize', position)
    return () => { resize.disconnect(); window.removeEventListener('resize', position) }
  }, [assistant.assistantVisible])
  return <WindowContext.Provider value={{ ...assistant, current, select, restoreAssistant }}><div ref={workspace} className="harness-gateway-window-workspace">{children}</div></WindowContext.Provider>
}

/** 网关资料和配置与助手并行查看；非模态窗口不遮罩工作区，也不接管助手的键盘。 */
export function GatewayWindow({ title, trigger, children, active = true, identity, footer, open, onOpenChange, onClose, closeLabel, editing = false, disabled = false }: {
  title: string; trigger?: ReactNode; children: ReactNode; active?: boolean; identity?: string; footer?: ReactNode
  open?: boolean; onOpenChange?(open: boolean): void; onClose?(): void; closeLabel?: string; editing?: boolean; disabled?: boolean
}) {
  const bridge = useContext(WindowContext)
  const id = useId()
  const [localOpen, setLocalOpen] = useState(false)
  const requested = open ?? localOpen
  const [compact, setCompact] = useState(false)
  const [withAssistant, setWithAssistant] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const previousSelected = useRef<string | null>(null)
  const previousIdentity = useRef(identity)
  const localRestoreAssistant = useRef(false)
  const restoreAssistant = bridge?.restoreAssistant ?? localRestoreAssistant
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge
  const change = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value) }
  const shown = requested && active && !withAssistant && (!bridge || bridge.current === id)
  const close = () => {
    if (disabled) return
    const returnFocus = dialog.current?.contains(document.activeElement)
    change(false); setWithAssistant(false); onClose?.()
    if (!onClose) { if (restoreAssistant.current) bridge?.onAssistantVisibilityChange?.(true); restoreAssistant.current = false }
    bridge?.onAssistantReturnChange?.(null)
    if (returnFocus) (opener.current ?? previousFocus.current)?.focus()
  }
  useEffect(() => {
    if (!active || previousIdentity.current !== identity) { change(false); setWithAssistant(false) }
    previousIdentity.current = identity
  }, [active, identity])
  useEffect(() => {
    const previous = previousSelected.current
    previousSelected.current = bridge?.current ?? null
    if (previous === id && bridge?.current !== id) change(false)
  }, [bridge?.current])
  useLayoutEffect(() => {
    if (!requested || !active) return
    const placement = position()
    if (placement.assistantVisible && placement.narrow) { restoreAssistant.current = true; bridge?.onAssistantVisibilityChange?.(false) }
    setWithAssistant(false)
    bridge?.select(id)
  }, [requested, active])
  useEffect(() => {
    const navigate = () => { change(false); setWithAssistant(false) }
    window.addEventListener('popstate', navigate); window.addEventListener('hashchange', navigate)
    return () => { window.removeEventListener('popstate', navigate); window.removeEventListener('hashchange', navigate) }
  }, [])
  function position() {
    const element = dialog.current
    const content = (opener.current ?? element)?.closest('.harness-content')
    const platform = (opener.current ?? element)?.closest('.harness-platform')
    if (!element || !content || !platform) return { narrow: window.innerWidth < 800, assistantVisible: !!bridgeRef.current?.assistantVisible }
    const assistant = platform.querySelector<HTMLElement>('.harness-assistant-floating')
    const bounds = content.getBoundingClientRect()
    const inset = window.innerWidth <= 680 ? 12 : 24
    const left = Math.max(inset, bounds.left + inset), top = Math.max(inset, bounds.top + inset)
    let right = Math.min(window.innerWidth - inset, bounds.right - inset)
    const bottom = Math.min(window.innerHeight - inset, bounds.bottom - inset)
    const assistantWidth = assistant ? parseFloat(getComputedStyle(assistant).width) || 400 : 400
    const assistantVisible = !!assistant && !assistant.hidden
    const panelLeft = assistantVisible ? assistant.getBoundingClientRect().left : window.innerWidth - (assistant ? parseFloat(getComputedStyle(assistant).right) || 0 : inset) - assistantWidth
    const narrow = panelLeft - inset - left < 360
    if (assistantVisible && !narrow) right = Math.min(right, panelLeft - inset)
    element.style.setProperty('--gateway-window-x', `${(left + right) / 2}px`)
    element.style.setProperty('--gateway-window-y', `${(top + bottom) / 2}px`)
    element.style.setProperty('--gateway-window-width', `${Math.min(860, right - left)}px`)
    element.style.setProperty('--gateway-window-height', `${bottom - top}px`)
    setCompact(narrow)
    return { narrow, assistantVisible }
  }
  useLayoutEffect(() => {
    if (!requested || !active || (bridge && bridge.current !== id)) return
    const content = (opener.current ?? dialog.current)?.closest('.harness-content')
    const platform = (opener.current ?? dialog.current)?.closest('.harness-platform')
    if (!content || !platform) return
    const assistant = platform.querySelector<HTMLElement>('.harness-assistant-floating')
    const update = () => { const result = position(); setWithAssistant(result.narrow && result.assistantVisible) }
    update()
    const resize = new ResizeObserver(update)
    resize.observe(content); if (assistant) resize.observe(assistant)
    const visibility = new MutationObserver(update)
    visibility.observe(platform, { attributes: true, attributeFilter: ['data-assistant-open'] })
    if (assistant) visibility.observe(assistant, { attributes: true, attributeFilter: ['hidden', 'style'] })
    window.addEventListener('resize', update)
    return () => { resize.disconnect(); visibility.disconnect(); window.removeEventListener('resize', update) }
  }, [requested, active, bridge?.current])
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (shown && !element.open) { previousFocus.current = document.activeElement as HTMLElement; element.show(); if (bridgeRef.current?.assistantVisible && previousFocus.current?.closest('.harness-assistant-floating')) previousFocus.current.focus(); else element.querySelector<HTMLButtonElement>('[data-window-close]')?.focus() }
    else if (!shown && element.open) element.close()
  }, [shown])
  useEffect(() => {
    if (!requested || !active || !withAssistant || (bridge && bridge.current !== id)) return
    bridge?.onAssistantReturnChange?.({ label: editing ? '返回配置' : '返回资料', onReturn() { setWithAssistant(false); bridgeRef.current?.onAssistantVisibilityChange?.(false) } })
    return () => bridgeRef.current?.onAssistantReturnChange?.(null)
  }, [requested, active, withAssistant, bridge?.current, editing])
  useEffect(() => {
    if ((!active || (!requested && !onClose)) && (!bridge || bridge.current === id)) {
      bridgeRef.current?.onAssistantReturnChange?.(null)
      if (restoreAssistant.current) bridgeRef.current?.onAssistantVisibilityChange?.(true)
      restoreAssistant.current = false
    }
  }, [requested, active])
  useEffect(() => () => {
    if (restoreAssistant.current && (!bridgeRef.current || bridgeRef.current.current === id)) { restoreAssistant.current = false; bridgeRef.current?.onAssistantVisibilityChange?.(true) }
  }, [])
  function show() {
    if (disabled) return
    const placement = position()
    if (placement.assistantVisible && placement.narrow) { restoreAssistant.current = true; bridge?.onAssistantVisibilityChange?.(false) }
    setWithAssistant(false); bridge?.select(id); change(true)
  }
  return <>
    {trigger !== null && <button ref={opener} type="button" className="harness-gateway-window-trigger" aria-haspopup="dialog" aria-expanded={shown} disabled={disabled} onClick={show}>{trigger ?? title}</button>}
    <dialog ref={dialog} className="harness-gateway-window" aria-label={title} aria-modal="false" onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close() }
    }}>
      <header className="harness-gateway-window-heading"><h2>{title}</h2><button type="button" data-window-close aria-label={`关闭${title}`} disabled={disabled} onClick={close}>×</button></header>
      <div className="harness-gateway-window-body">{children}</div>
      <footer className="harness-gateway-window-footer">{footer}<div>{compact && bridge?.onAssistantVisibilityChange && <button type="button" onClick={() => { setWithAssistant(true); bridge.onAssistantVisibilityChange?.(true) }}>切换到 AI 助手</button>}<button type="button" disabled={disabled} onClick={close}>{closeLabel ?? (editing ? '暂存并返回' : '关闭')}</button></div></footer>
    </dialog>
  </>
}
