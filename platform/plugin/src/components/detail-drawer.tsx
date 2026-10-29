import { useEffect, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/** 旁路只读资料使用同一抽屉；编辑草稿和关键操作仍由所属工作面维护。 */
export function DetailDrawer({ title, trigger, children, active = true, identity, footer }: {
  title: string
  trigger?: ReactNode
  children: ReactNode
  active?: boolean
  identity?: string
  footer?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => { setOpen(false) }, [active, identity])
  useEffect(() => {
    const close = () => setOpen(false)
    window.addEventListener('popstate', close); window.addEventListener('hashchange', close)
    return () => { window.removeEventListener('popstate', close); window.removeEventListener('hashchange', close) }
  }, [])
  return <>
    <button type="button" className="hep-detail-trigger" aria-haspopup="dialog" aria-expanded={open && active} onClick={() => setOpen(true)}>{trigger ?? title}<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m9 5 7 7-7 7"/></svg></button>
    <Modal headless open={open && active} onClose={() => setOpen(false)} title={title} className="hep-detail-drawer" backdropBlur={false}>
      <header className="hep-detail-drawer-header"><h2>{title}</h2><button type="button" data-modal-autofocus aria-label={`关闭${title}`} onClick={() => setOpen(false)}>×</button></header>
      <div className="hep-detail-drawer-body">{children}</div>
      {footer && <footer className="hep-detail-drawer-footer">{footer}</footer>}
    </Modal>
  </>
}

export const detailDrawerTheme = `
.harness-platform .hep-detail-trigger{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--hep-link);padding:6px 0;font-size:13px;text-align:left}.harness-platform .hep-detail-trigger:hover{background:transparent;text-decoration:underline}.hep-detail-drawer{position:fixed!important;inset:0 0 0 auto!important;width:min(620px,100vw)!important;max-width:100vw!important;height:100dvh!important;max-height:100dvh!important;margin:0!important;transform:none!important;border-radius:0!important;display:flex;flex-direction:column;padding:0!important;background:var(--hep-surface,#fff);color:var(--hep-text,#1c2d43);font:14px/1.6 HepNoto,system-ui,sans-serif;box-shadow:-12px 0 36px #10283e20;overflow:hidden}.hep-detail-drawer *{box-sizing:border-box}.hep-detail-drawer-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;border-bottom:1px solid var(--hep-border,#dce3ed);flex:none}.hep-detail-drawer-header h2{margin:0;font-size:18px}.hep-detail-drawer-header button{display:grid;place-items:center;border:0;background:transparent;color:inherit;font:24px/1 system-ui;min-width:36px;min-height:36px;cursor:pointer}.hep-detail-drawer-body{min-height:0;overflow:auto;padding:20px 24px;flex:1}.hep-detail-drawer-body p{overflow-wrap:anywhere}.hep-detail-drawer-body :is(code,dd){overflow-wrap:anywhere}.hep-detail-drawer-body pre{max-width:100%;overflow:auto;white-space:pre-wrap;font:12px/1.7 monospace;background:var(--hep-surface-muted,#f7f9fc);padding:14px;border-radius:7px}.hep-detail-drawer-body .harness-fields{display:grid;gap:14px;margin:0}.hep-detail-drawer-body .harness-fields>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px}.hep-detail-drawer-body .harness-eval-facts{margin:0 0 20px;padding:0;border:0}.hep-detail-drawer-body .harness-eval-facts:last-child{margin-bottom:0}.hep-detail-drawer-body dt{color:var(--hep-muted,#607187)}.hep-detail-drawer-body dd{margin:0;min-width:0}.hep-detail-drawer-footer{padding:16px 24px;border-top:1px solid var(--hep-border,#dce3ed);flex:none}.hep-detail-drawer-body table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}.hep-detail-drawer-body :is(td,th){padding:10px;border-bottom:1px solid var(--hep-border,#dce3ed);vertical-align:top;overflow-wrap:anywhere}.hep-detail-drawer-body th{color:var(--hep-muted,#607187);font-weight:500;background:var(--hep-surface-muted,#f7f9fc)}.hep-detail-drawer-body button,.hep-detail-drawer-footer button{font:inherit;padding:7px 10px;border:1px solid var(--hep-border,#dce3ed);border-radius:7px;background:var(--hep-surface,#fff);color:inherit;cursor:pointer}.hep-detail-drawer-body a{color:var(--hep-link,#0062ae)}.hep-detail-drawer :focus-visible{outline:2px solid var(--hep-focus,#0086dd);outline-offset:2px}@media(max-width:680px){.hep-detail-drawer{width:100vw!important}.hep-detail-drawer-header,.hep-detail-drawer-body{padding:16px}.hep-detail-drawer-body .harness-fields>div{grid-template-columns:1fr;gap:4px}}
`
