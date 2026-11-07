import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { FileTypeIcon, MenuSurface, Tooltip, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type ListFiles = Context['remote']['fileReferences']['list']
type Candidate = Extract<Awaited<ReturnType<ListFiles>>, { ok: true }>['value'][number]
type SearchProps = Pick<PropsRuntime<'sidebar.right.tab.files.actions'>, 'sessionId' | 'absolutePath'> & {
  listFiles: ListFiles
  sidebar: Pick<ISidebarRight, 'mounted' | 'openResource'>
}
type SearchResult = { query: string; items?: Candidate[]; error?: string }

export function WorkspaceFileSearch({ sessionId, absolutePath, listFiles, sidebar }: SearchProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult>()
  const [retry, setRetry] = useState(0)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const mounted = useSyncExternalStore(sidebar.mounted.subscribe, sidebar.mounted.getSnapshot)
  const visible = open && mounted === sessionId
  const position = useAnchoredPosition({ open: visible, anchorRef: anchor, panelRef: panel, side: 'bottom', align: 'end', gap: 8, margin: 12 })
  const ready = visible && !!position
  useDismissOnOutsidePointer(anchor, visible, setOpen, panel)
  useEffect(() => { setOpen(false); setQuery(''); setResult(undefined) }, [sessionId, absolutePath, mounted])
  useEffect(() => { if (ready) input.current?.focus() }, [ready])
  useEffect(() => {
    setResult(undefined)
    if (!visible || !query.trim()) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const response = await listFiles(sessionId, query.trim(), controller.signal)
        if (controller.signal.aborted) return
        setResult(response.ok ? { query, items: response.value } : { query, error: response.error.message })
      } catch (error) {
        if (!controller.signal.aborted) setResult({ query, error: error instanceof Error ? error.message : '文件查找失败' })
      }
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [visible, query, retry, sessionId, absolutePath, listFiles])
  const current = result?.query === query ? result : undefined
  const normalized = query.replaceAll('\\', '/')
  const directory = normalized.slice(0, normalized.lastIndexOf('/') + 1)
  const parent = directory.slice(0, directory.slice(0, -1).lastIndexOf('/') + 1)
  const close = () => { setOpen(false); anchor.current?.focus() }
  const select = (item: Candidate) => {
    if (sidebar.mounted.getSnapshot() !== sessionId) return
    if (item.kind === 'directory') { setQuery(item.path.replaceAll('\\', '/').replace(/\/+$/, '') + '/'); input.current?.focus(); return }
    try {
      sidebar.openResource(fileAddressFor(sessionId, absolutePath, item.path))
      setOpen(false)
    } catch (error) { setResult({ query, error: error instanceof Error ? error.message : '无法打开文件预览' }) }
  }
  return <>
    <style>{fileSearchStyle}</style>
    <Tooltip label="查找文件和文件夹"><button ref={anchor} type="button" className="harness-file-search-trigger"
      aria-label="查找文件和文件夹" aria-haspopup="dialog" aria-expanded={visible} aria-controls={visible ? id : undefined}
      onClick={() => setOpen(!open)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
    </button></Tooltip>
    {visible && createPortal(<MenuSurface ref={panel} id={id} role="dialog" aria-label="查找工作区文件" className="harness-file-search"
      style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      <div className="harness-file-search-heading"><strong>查找文件和文件夹</strong><button type="button" aria-label="关闭文件查找" onClick={close}>×</button></div>
      <p className="harness-file-search-scope" title={absolutePath}>当前工作区：{absolutePath}</p>
      <div className="harness-file-search-input"><input ref={input} aria-label="文件或文件夹关键字" value={query} placeholder="输入名称关键字，或目录路径/"
        onChange={event => setQuery(event.target.value)}/><button type="button" disabled={!query} onClick={() => { setQuery(''); input.current?.focus() }}>清空</button></div>
      {directory && <div className="harness-file-search-navigation"><button type="button" onClick={() => { setQuery(parent); input.current?.focus() }}>返回上级</button><span>{directory}</span></div>}
      <div className="harness-file-search-results" aria-busy={!!query.trim() && !current}>
        {!query.trim() ? <p role="status">输入关键字，查找工作区内尚未展开的文件和目录。</p>
          : !current ? <p role="status">正在查找…</p>
          : current.error ? <div role="alert"><p>查找或打开文件失败：{current.error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
          : !current.items?.length ? <p role="status">当前检索范围内没有匹配项，请调整关键字或目录。</p>
          : <ul aria-label="文件查找结果">{current.items.map(item => <li key={`${item.kind}:${item.path}`}><button type="button" onClick={() => select(item)} title={item.path}>
            {item.kind === 'directory' ? <FileTypeIcon kind="folder" size={24}/> : <FileTypeIcon path={item.path} size={24}/>}
            <span><strong>{pathPartsOf(item.path).name}</strong><small>{item.path}</small></span><small>{item.kind === 'directory' ? '文件夹' : '文件'}</small>
          </button></li>)}</ul>}
      </div>
      <p className="harness-file-search-note">最多显示 20 项；输入关键字搜索，目录路径用于逐级浏览。依赖与构建目录等沿用 DSH 排除规则。</p>
    </MenuSurface>, document.body)}
  </>
}

const fileSearchStyle = `
.harness-file-search-trigger{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.harness-file-search-trigger:hover,.harness-file-search-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.harness-file-search{position:fixed;z-index:1000;box-sizing:border-box;width:min(420px,calc(100vw - 24px));max-height:min(560px,calc(100dvh - 24px));display:flex;flex-direction:column;gap:12px;padding:16px;color:var(--hep-text);font:14px/1.55 HepNoto,system-ui,sans-serif}
.harness-file-search button,.harness-file-search input{box-sizing:border-box;border:1px solid var(--hep-border);border-radius:8px;background:var(--hep-surface);color:var(--hep-text);font:inherit}
.harness-file-search button{padding:4px 8px;cursor:pointer}.harness-file-search button:hover{background:var(--hep-surface-hover)}
.harness-file-search button:disabled{opacity:.45;cursor:default}
.harness-file-search :is(button,input):focus-visible,.harness-file-search-trigger:focus-visible{outline:2px solid var(--hep-focus);outline-offset:2px}
.harness-file-search-heading,.harness-file-search-input,.harness-file-search-navigation{display:flex;align-items:center;gap:8px;min-width:0}
.harness-file-search-heading{justify-content:space-between}.harness-file-search-heading strong{font-size:16px;font-weight:600}.harness-file-search-heading button{font-size:20px;line-height:1;width:28px;height:28px;padding:0}
.harness-file-search p{margin:0}.harness-file-search-scope,.harness-file-search-note{font-size:12px;color:var(--hep-muted);overflow-wrap:anywhere}
.harness-file-search-input input{width:0;min-width:0;flex:1;min-height:40px;padding:8px 10px;background:var(--hep-control-bg)}
.harness-file-search-navigation span{overflow-wrap:anywhere;min-width:0}.harness-file-search-navigation button{flex-shrink:0}
.harness-file-search-results{overflow:auto;min-height:0;flex:1}.harness-file-search-results ul{padding:0;margin:0;list-style:none}
.harness-file-search-results li+li{margin-top:4px}.harness-file-search-results li button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border-color:transparent;padding:8px}
.harness-file-search-results li button>span{min-width:0;flex:1}.harness-file-search-results strong,.harness-file-search-results small{display:block;overflow-wrap:anywhere}
.harness-file-search-results strong{font-weight:500}.harness-file-search-results small{font-size:12px;color:var(--hep-muted)}
.harness-file-search-results li button>svg{flex-shrink:0}.harness-file-search-results li button>small{flex-shrink:0}
@media(pointer:coarse){.harness-file-search :is(button,input){min-height:44px}}
`
