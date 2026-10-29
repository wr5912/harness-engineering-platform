import { useEffect, useRef, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { GatewayWindow } from './window.tsx'

type ProtocolDocument = { kind: 'risk-assessment' | 'access-control'; title: string; filename: string; version: string; content: string; sha256: string }
const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

/** 阅读与下载复用管理端返回的同一份规范，不在页面维护协议副本。 */
export function ProviderProtocolView({ kind, rpc, active }: { kind: ProtocolDocument['kind']; rpc: PlatformPageProps['rpc']; active: boolean }) {
  const [value, setValue] = useState<ProtocolDocument | null>(null)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [open, setOpen] = useState(false)
  const request = useRef(0), container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    request.current++; setOpen(false); setLoading(false); setError(''); setValue(null)
    return () => { request.current++ }
  }, [kind])
  useEffect(() => { if (!active) { request.current++; setLoading(false); setOpen(false) } }, [active])
  async function read() {
    const id = ++request.current
    const windowElement = container.current?.querySelector<HTMLDialogElement>('dialog')
    const restoreFocus = !!open && !!windowElement?.contains(document.activeElement)
    setLoading(true); setError('')
    try {
      const response = await rpc.call(CHANNEL, 'mcp/control/providerProtocol', { kind })
      if (id !== request.current) return null
      if (!response.ok) throw new Error(response.error.message)
      const document = response.value as ProtocolDocument
      if (document.kind !== kind || typeof document.content !== 'string' || !document.filename || !document.sha256) throw new Error('接口规范内容无效，请重新读取。')
      setValue(document)
      return document
    } catch (failure) { if (id === request.current) setError(failure instanceof Error ? failure.message : '接口规范读取失败，请重试。'); return null }
    finally { if (id === request.current) {
      setLoading(false)
      if (restoreFocus) window.requestAnimationFrame(() => {
        if (id !== request.current || !windowElement?.open) return
        const focused = document.activeElement
        if (!focused || focused === document.body || !focused.isConnected) windowElement.querySelector<HTMLButtonElement>('[data-window-close]')?.focus()
      })
    } }
  }
  async function download() {
    const documentValue = value ?? await read()
    if (!documentValue) return
    const link = document.createElement('a')
    link.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(documentValue.content)}`
    link.download = documentValue.filename
    link.click()
  }
  return <div ref={container} className="harness-gateway-protocol-actions">
    <button type="button" className="harness-gateway-text-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); if (!value && !loading) void read() }}>查看接口规范</button>
    <button type="button" className="harness-gateway-text-button" disabled={loading} onClick={() => void download()}>下载接口规范</button>
    {loading && !open && <LoadingIndicator label="读取接口规范" />}
    {error && !open && <p role="alert">{error}<button type="button" onClick={() => void read()}>重新读取</button></p>}
    <GatewayWindow title={kind === 'risk-assessment' ? '风险评估接口规范' : '访问控制接口规范'} trigger={null} open={open} onOpenChange={setOpen} active={active} identity={kind}
      footer={value && <button type="button" onClick={() => void download()}>下载本规范</button>}>
      {loading && !value && <LoadingIndicator label="读取接口规范" block />}
      {error && <p role="alert">{error}<button type="button" disabled={loading} onClick={() => void read()}>重新读取</button></p>}
      {value && <article className="harness-gateway-protocol-document"><p className="harness-gateway-protocol-meta">版本 {value.version} · 阅读与下载内容一致</p><MarkdownText text={value.content} labels={markdownLabels} /></article>}
    </GatewayWindow>
  </div>
}
