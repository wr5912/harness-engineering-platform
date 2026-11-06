import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Modal, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'

/** 在原工作面展开，画布与编辑器不随全屏切换重新挂载。 */
export function useCompositionFullscreen(detail: RefObject<HTMLElement>, active: boolean) {
  const [fullscreen, setFullscreen] = useState(false)
  useModalLayer(detail, fullscreen && active, () => setFullscreen(false))
  useEffect(() => { if (!active) setFullscreen(false) }, [active])
  useEffect(() => {
    if (!fullscreen || !active) return
    const previous = document.body.style.overflow
    const scroll = { x: window.scrollX, y: window.scrollY }
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous; window.scrollTo(scroll.x, scroll.y) }
  }, [fullscreen, active])
  useEffect(() => {
    const element = detail.current
    if (!active || !element || fullscreen) return
    const resize = () => element.parentElement!.style.setProperty('--composition-top', `${Math.max(0, element.getBoundingClientRect().top + window.scrollY)}px`)
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element.parentElement!)
    window.addEventListener('resize', resize)
    return () => { observer.disconnect(); window.removeEventListener('resize', resize) }
  }, [detail, active, fullscreen])
  return { fullscreen, setFullscreen }
}

export function useCompositionNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1100px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)')
    const update = () => setNarrow(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return narrow
}

/** 抽屉复用 DSH 焦点管理；内嵌侧栏关闭后保留内容状态。 */
export function CompositionPanel({ title, open, onClose, drawer, className, children }: {
  title: string; open: boolean; onClose(): void; drawer: boolean; className: string; children: ReactNode
}) {
  const content = <><header className="harness-composition-panel-heading"><strong>{title}</strong><button type="button" data-modal-autofocus aria-label={`关闭${title}`} onClick={onClose}>×</button></header>{children}</>
  return drawer
    ? <Modal headless open={open} onClose={onClose} title={title} className={`hep-detail-drawer harness-composition-panel-drawer ${className}`} backdropBlur={false}>{content}</Modal>
    : <aside className={className} aria-label={title} hidden={!open}>{content}</aside>
}
