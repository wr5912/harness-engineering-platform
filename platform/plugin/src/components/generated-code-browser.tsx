import { useEffect, useRef, useState } from 'react'
import type { GeneratedCodeCatalog, GeneratedCodeFile, GeneratedCodeRead } from './generated-code.ts'

const kindName = { source: '源码', artifact: '构建产物', support: '配置与构建', binary: '资产' }
function FileTree({ files, selected, onSelect, depth = 0 }: { files: GeneratedCodeFile[]; selected: string; onSelect(path: string): void; depth?: number }) {
  const groups = new Map<string, GeneratedCodeFile[]>()
  for (const file of files) {
    const name = file.path.split('/')[depth]
    groups.set(name, [...(groups.get(name) ?? []), file])
  }
  return <ul>{[...groups].map(([name, entries]) => <li key={name}>{entries[0].path.split('/').length > depth + 1
    ? <details open><summary>{name}/</summary><FileTree files={entries} selected={selected} onSelect={onSelect} depth={depth + 1} /></details>
    : <button type="button" title={entries[0].path} aria-current={selected === entries[0].path} onClick={() => onSelect(entries[0].path)}>{entries[0].entry && '入口 · '}{name}{entries[0].missing && '（缺失）'}</button>}</li>)}</ul>
}
export function GeneratedCodeBrowser({ identity, loadCatalog, loadFile, onOpenAsset }: {
  identity: string
  loadCatalog(): Promise<GeneratedCodeCatalog>
  loadFile(file: GeneratedCodeFile): Promise<GeneratedCodeRead>
  onOpenAsset?(path: string): void
}) {
  const callbacks = useRef({ loadCatalog, loadFile }); callbacks.current = { loadCatalog, loadFile }
  const current = useRef(identity); current.current = identity
  const catalogRequest = useRef(0), fileRequest = useRef(0)
  const [catalog, setCatalog] = useState<GeneratedCodeCatalog | null>(null), [owner, setOwner] = useState('')
  const [selected, setSelected] = useState(''), [value, setValue] = useState<GeneratedCodeRead | null>(null)
  const [error, setError] = useState(''), [catalogError, setCatalogError] = useState('')
  const [loading, setLoading] = useState(false), [catalogLoading, setCatalogLoading] = useState(false)
  const [reload, setReload] = useState(0), [retry, setRetry] = useState(0)
  useEffect(() => {
    const request = ++catalogRequest.current
    fileRequest.current++; setLoading(false); setCatalogLoading(true); setCatalogError('')
    if (loading && owner === identity) setError('文件读取已随目录刷新取消，可重试读取当前文件。')
    callbacks.current.loadCatalog().then(result => {
      if (current.current !== identity || catalogRequest.current !== request) return
      setCatalog(result); setOwner(identity)
      setSelected(previous => result.files.some(file => file.path === previous) ? previous : (result.files.find(file => file.entry)?.path ?? result.files[0]?.path ?? ''))
    }).catch(error => { if (current.current === identity && catalogRequest.current === request) setCatalogError(error instanceof Error ? error.message : '无法读取源码目录') })
      .finally(() => { if (current.current === identity && catalogRequest.current === request) setCatalogLoading(false) })
    return () => { catalogRequest.current++; fileRequest.current++ }
  }, [identity, reload])
  const visible = owner === identity ? catalog : null
  const file = visible?.files.find(item => item.path === selected)
  useEffect(() => {
    const request = ++fileRequest.current
    setValue(null); setError('')
    if (!file || !visible || !file.sha256 || file.kind === 'binary') { setLoading(false); return }
    setLoading(true)
    callbacks.current.loadFile(file).then(result => {
      if (current.current !== identity || fileRequest.current !== request) return
      if (result.identity !== visible.identity || result.path !== file.path || result.sha256 !== file.sha256) throw new Error('读取结果与当前文件不一致，请刷新目录')
      setValue(result)
    }).catch(error => { if (current.current === identity && fileRequest.current === request) setError(error instanceof Error ? error.message : '无法读取源码') })
      .finally(() => { if (current.current === identity && fileRequest.current === request) setLoading(false) })
    return () => { fileRequest.current++ }
  }, [identity, visible, file?.path, file?.sha256, retry])
  const readable = value?.path === selected && value.identity === visible?.identity ? value : null
  return <section className="generated-code-browser" aria-label="完整代码文件浏览器">
    <style>{`.generated-code-browser{min-width:0;max-width:100%;box-sizing:border-box}.generated-code-browser *{box-sizing:border-box}.generated-code-browser .code-browser-layout{display:grid;grid-template-columns:minmax(190px,28%) minmax(0,1fr);gap:12px;min-width:0}.generated-code-browser nav,.generated-code-browser article{min-width:0;max-width:100%}.generated-code-browser nav{max-height:520px;overflow:auto}.generated-code-browser ul{list-style:none;padding-left:10px;margin:4px 0}.generated-code-browser button,.generated-code-browser summary,.generated-code-browser select,.generated-code-browser p,.generated-code-browser code{overflow-wrap:anywhere;max-width:100%}.generated-code-browser nav button{text-align:left;width:100%;white-space:normal}.generated-code-browser button[aria-current=true]{font-weight:700;border-color:var(--primary-color,#6287ef)}.generated-code-browser select{width:100%;min-width:0}.generated-code-browser pre{min-width:0;width:100%;max-width:100%;max-height:560px;overflow:auto;white-space:pre;tab-size:2}.generated-code-browser :focus-visible{outline:2px solid var(--primary-color,#6287ef);outline-offset:2px}@media(max-width:600px){.generated-code-browser .code-browser-layout{grid-template-columns:minmax(0,1fr)}.generated-code-browser nav{max-height:220px}}`}</style>
    <p><button type="button" disabled={catalogLoading} onClick={() => setReload(value => value + 1)}>刷新文件目录</button> {catalogLoading ? <span role="status">正在读取文件目录…</span> : visible ? `${visible.files.length} 个相关文件` : null}</p>
    {catalogError && <p role="alert">{catalogError}{visible && '；以下保留上次文件清单。'} <button type="button" onClick={() => setReload(value => value + 1)}>重试读取目录</button></p>}
    {visible?.notes.map((note, index) => <p key={index}>{note}</p>)}
    {visible && !visible.files.length && <p role="status">当前没有可读取的实现文件。</p>}
    {visible && visible.files.length > 0 && <>
      <label>选择代码文件<select aria-label="选择代码文件" value={selected} onChange={event => setSelected(event.target.value)}>{visible.files.map(file => <option key={file.path} value={file.path}>{file.entry ? '入口 · ' : ''}{kindName[file.kind]} · {file.path}</option>)}</select></label>
      <div className="code-browser-layout"><nav aria-label="相关代码目录">{(['source', 'artifact', 'support', 'binary'] as const).map(kind => {
        const files = visible.files.filter(file => file.kind === kind)
        return files.length ? <details open key={kind}><summary>{kindName[kind]}（{files.length}）</summary><FileTree files={files} selected={selected} onSelect={setSelected} /></details> : null
      })}</nav><article aria-label="当前代码文件">
        {file && <><p><strong>{file.path}</strong> · {kindName[file.kind]} · {file.language}{file.entry && ' · 入口'} · {file.bytes === null ? '大小未知' : `${file.bytes} 字节`}</p><p>文件 SHA-256：<code>{file.sha256 ?? '未读取'}</code></p>
          {onOpenAsset && file.asset_path && <p><button type="button" onClick={() => onOpenAsset(file.asset_path!)}>到资产查看或编辑此文件</button></p>}
          {file.built_sha256 && <p>构建时 SHA-256：<code>{file.built_sha256}</code> · {file.matches_build ? '当前文件与构建一致' : '当前文件与构建不一致，以下内容不代表已装载源码'}</p>}
          {file.missing && <p role="alert">此文件已列入构建清单，但当前不存在。请刷新目录或到资产恢复。</p>}
          {file.kind === 'binary' && <p>此文件仅显示资产信息，不作为代码预览。</p>}
        </>}
        {loading && <p role="status">正在读取所选文件…</p>}
        {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试读取文件</button></p>}
        {readable && <><p role="status">{readable.redacted ? '内容已脱敏，不能以此预览替换原文件。' : readable.truncated ? '当前为截断预览；文件摘要覆盖完整原文件。' : '完整文件内容。'}</p><pre tabIndex={0} aria-label="代码内容"><code>{readable.content || '（空文件）'}</code></pre></>}
      </article></div>
    </>}
  </section>
}
