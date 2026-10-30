import { useEffect, useRef, useState } from 'react'
import { CHANNEL, type PlatformPageProps } from '../protocol.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'

type Operation = {
  id: string; workspace_id?: string; source: string; instance_id: string; status: string; request_id?: string
  session_id?: string; final_response?: string; events?: unknown[]; error?: string | { message?: string }
  created_at?: string; updated_at?: string
}
type Submission = { source: string; instance_id: string; input: string; session_id?: string; request_id: string }
type Guide = { workspace_id: string; markdown: string; example: string }
type Result = { ok: true; value: any } | { ok: false; error: { code: string; message: string } }
const running = (value?: Operation | null) => Boolean(value && ['starting', 'running', 'stopping'].includes(value.status))
const statusLabels: Record<string, string> = { starting: '正在启动 SDK 应用', running: '正在执行', completed: '执行完成', failed: '执行失败', stopping: '正在停止', stopped: '已停止', unknown: '结果待核对' }

function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** SDK 调试使用真实后台操作；页面恢复只查询，继续执行由用户明确发起。 */
export function SdkDebugDialog({ rpc, active, source, agentId, label, initialInstance, initialTab = 'debug', onClose }: PlatformPageProps & {
  active: boolean; source: string; agentId: string; label: string; initialInstance?: string; initialTab?: 'debug' | 'guide'; onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0)
  const [tab, setTab] = useState(initialTab), [guide, setGuide] = useState<Guide | null>(null)
  const [storageKey, setStorageKey] = useState(''), [input, setInput] = useState(''), [session, setSession] = useState('')
  const [instance, setInstance] = useState(initialInstance || `${agentId}-sdk`), [instances, setInstances] = useState<string[]>([])
  const [operation, setOperation] = useState<Operation | null>(null), [history, setHistory] = useState<Operation[]>([])
  const [submission, setSubmission] = useState<Submission | null>(null), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0)
  async function call(action: string, payload: Record<string, unknown>) {
    const result = await rpc.call(CHANNEL, `agents/sdk/${action}`, payload) as Result
    if (!result.ok) throw Object.assign(new Error(result.error.message), { confirmed: true })
    return result.value
  }
  function matching(value: Operation, workspace = guide?.workspace_id, expectedInstance = initialInstance) {
    if (value.source !== source || value.workspace_id && value.workspace_id !== workspace) throw Object.assign(new Error('调试回执与当前工作区或版本不一致，请重新核对。'), { targetMismatch: true })
    if (expectedInstance && value.instance_id !== expectedInstance) throw Object.assign(new Error('调试回执与当前实例不一致，请重新核对。'), { targetMismatch: true })
    return value
  }
  useEffect(() => {
    const token = ++generation.current
    if (!active) { dialog.current?.close(); return }
    if (!dialog.current?.open) dialog.current?.showModal()
    setTab(initialTab); setLoading(true); setError(''); setGuide(null); setStorageKey(''); setOperation(null); setSubmission(null); setHistory([])
    setInput(''); setSession(''); setInstance(initialInstance || `${agentId}-sdk`); setBusy(false)
    void call('guide', { source }).then(async value => {
      if (generation.current !== token) return
      if (typeof value.workspace_id !== 'string' || !value.workspace_id) throw new Error('未取得工作区身份，无法恢复 SDK 调试。')
      setGuide(value)
      const key = `harness-sdk:${value.workspace_id}:${source}:${initialInstance ?? ''}`
      let saved: any
      try { saved = JSON.parse(localStorage.getItem(key) || 'null') } catch {}
      setStorageKey(key)
      if (saved) {
        if (typeof saved.input === 'string') setInput(saved.input)
        const sameInstance = !initialInstance || saved.instance === initialInstance
        if (sameInstance && typeof saved.session === 'string') setSession(saved.session)
        if (sameInstance && !initialInstance && typeof saved.instance === 'string') setInstance(saved.instance)
        if (sameInstance && saved.submission?.source === source && saved.submission.instance_id === saved.instance
          && saved.submission.request_id === saved.operation_id) setSubmission(saved.submission)
        if (!sameInstance) setError('上次调试记录属于其他实例，已保留测试输入并清除会话恢复目标；没有恢复或执行其他实例。')
        if (sameInstance && typeof saved.operation_id === 'string') {
          setOperation({ id: saved.operation_id, status: 'unknown', source, instance_id: initialInstance || saved.instance || '', workspace_id: value.workspace_id })
          try {
            const observed = await call('status', { operation_id: saved.operation_id })
            if (generation.current === token) setOperation(matching(observed, value.workspace_id))
          } catch (error) {
            if (generation.current === token) {
              if ((error as any).targetMismatch) { setOperation(null); setSession(''); setSubmission(null); setError(`${(error as Error).message}已忽略该记录，未恢复会话或执行任务。`) }
              else setError(`调试状态暂时不可读，未重新执行。${(error as Error).message}`)
            }
          }
        }
      }
      const results = await Promise.allSettled([call('list', { source }), rpc.call(CHANNEL, 'instances/list', {})])
      if (generation.current !== token) return
      const [operations, listed] = results
      if (operations.status === 'fulfilled') {
        const values = (Array.isArray(operations.value) ? operations.value : operations.value.operations ?? []) as Operation[]
        setHistory(values.filter(item => item.source === source && (!item.workspace_id || item.workspace_id === value.workspace_id)
          && (!initialInstance || item.instance_id === initialInstance)))
      }
      if (listed.status === 'fulfilled') {
        const result = listed.value as Result
        if (result.ok) setInstances((result.value.instances ?? []).filter((item: any) => item.source_id === source && item.profile === 'sdk').map((item: any) => item.name))
      }
    }).catch(error => { if (generation.current === token) setError((error as Error).message) })
      .finally(() => { if (generation.current === token) setLoading(false) })
    return () => { generation.current++ }
  }, [active, source, initialInstance, initialTab, revision])
  useEffect(() => {
    if (!storageKey) return
    try { localStorage.setItem(storageKey, JSON.stringify({ input, session, instance, operation_id: operation?.id, submission })) } catch {}
  }, [storageKey, input, session, instance, operation?.id, submission])
  useEffect(() => {
    if (!active || !operation || !running(operation)) return
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const token = generation.current, id = operation.id, observedInstance = operation.instance_id
    async function poll() {
      try {
        const value = await call('status', { operation_id: id })
        if (!disposed && generation.current === token) { setOperation(matching(value, guide?.workspace_id, observedInstance)); setError(''); if (running(value)) timer = setTimeout(poll, 1200) }
      } catch (error) {
        if (!disposed && generation.current === token) { setError(`连接暂时中断，执行结果待核对，请勿重复执行。${(error as Error).message}`); timer = setTimeout(poll, 3000) }
      }
    }
    timer = setTimeout(poll, 800)
    return () => { disposed = true; clearTimeout(timer) }
  }, [active, operation?.id, operation?.status])
  async function refreshOperation() {
    if (!operation || busy) return
    const token = generation.current
    setBusy(true); setError('')
    try { const value = await call('status', { operation_id: operation.id }); if (generation.current === token) setOperation(matching(value, guide?.workspace_id, operation.instance_id)) }
    catch (error) { if (generation.current === token) setError((error as Error).message) }
    finally { if (generation.current === token) setBusy(false) }
  }
  async function submit(payload: Submission) {
    if (busy || running(operation)) return
    if (payload.source !== source || initialInstance && payload.instance_id !== initialInstance) { setError('待提交请求与当前版本或实例不一致，未发起执行。'); return }
    const token = generation.current
    setBusy(true); setError(''); setSubmission(payload)
    setOperation({ id: payload.request_id, source, instance_id: payload.instance_id, status: 'starting', workspace_id: guide?.workspace_id })
    try { localStorage.setItem(storageKey, JSON.stringify({ input, session, instance, operation_id: payload.request_id, submission: payload })) } catch {}
    try { const value = await call('start', payload); if (generation.current === token) setOperation(matching(value, guide?.workspace_id, payload.instance_id)) }
    catch (error) {
      if (generation.current === token) {
        setOperation(current => current && { ...current, status: (error as any).confirmed ? 'failed' : 'unknown', error: (error as Error).message })
        setError((error as any).confirmed ? (error as Error).message : '启动回执尚未收到。已保留请求，请查询状态；也可手动重新确认同一次请求。')
      }
    } finally { if (generation.current === token) setBusy(false) }
  }
  async function stop() {
    if (!operation || busy) return
    const token = generation.current
    setBusy(true); setError('')
    try { const value = await call('stop', { operation_id: operation.id }); if (generation.current === token) setOperation(matching(value, guide?.workspace_id, operation.instance_id)) }
    catch (error) { if (generation.current === token) setError((error as Error).message) }
    finally { if (generation.current === token) setBusy(false) }
  }
  const locked = loading || !guide || busy || running(operation) || operation?.status === 'unknown'
  return <dialog ref={dialog} className="harness-asset-dialog agent-sdk-dialog" aria-labelledby="agent-sdk-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <h2 id="agent-sdk-title">{tab === 'guide' ? 'TypeScript SDK 接入文档' : 'SDK 调试'}</h2>
    <div className="agent-dialog-body">
      <p><strong>{label}</strong><br/><code>{source}</code></p>
      <div className="agent-actions" aria-label="SDK 内容"><button type="button" aria-pressed={tab === 'debug'} onClick={() => setTab('debug')}>调试</button><button type="button" aria-pressed={tab === 'guide'} onClick={() => setTab('guide')}>接入文档</button></div>
      {loading && <LoadingIndicator label="读取 SDK 接入信息" />}
      {tab === 'debug' ? <>
        <p className="agent-muted">TypeScript 应用通过官方 SDK 启动同容器内的 DSH。执行完成后正常退出，输入和本次操作会保留；关闭窗口不会停止执行。</p>
        <form onSubmit={event => { event.preventDefault(); if (!locked && guide && input.trim() && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(instance)) void submit({ source, instance_id: instance, input, ...(session.trim() ? { session_id: session.trim() } : {}), request_id: requestId() }) }}>
          <label className="agent-field">实例名称<input aria-label="实例名称" value={instance} disabled={locked || Boolean(initialInstance)} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={80} onChange={event => { setInstance(event.target.value); setSession(''); setSubmission(null) }} list="sdk-instance-names" /></label>
          <datalist id="sdk-instance-names">{instances.map(name => <option key={name} value={name} />)}</datalist>
          <label className="agent-field">测试输入<textarea aria-label="测试输入" value={input} disabled={locked} required rows={5} maxLength={60000} onChange={event => setInput(event.target.value)} /></label>
          <label className="agent-field">恢复 Session（可选）<input aria-label="恢复 Session（可选）" value={session} disabled={locked} placeholder="留空创建新会话" onChange={event => setSession(event.target.value)} /></label>
          <p className="agent-muted">填写 Session 表示明确恢复该实例的历史会话。停止会关闭本次 SDK Runtime。</p>
          <div className="agent-actions"><button type="submit" className="agent-primary" disabled={locked || loading || !guide || !input.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(instance)}>启动并调试</button>{(running(operation) || operation?.status === 'unknown') && <button type="button" disabled={busy || operation?.status === 'stopping'} onClick={() => void stop()}>{operation?.status === 'unknown' ? '停止并核对原执行' : '停止本次执行'}</button>}</div>
        </form>
        {operation && <section aria-label="SDK 执行结果"><h3 role="status">{statusLabels[operation.status] ?? '结果待核对'}</h3><p>{operation.instance_id}{operation.updated_at && ` · 更新于 ${new Date(operation.updated_at).toLocaleString('zh-CN')}`}</p>
          {operation.session_id && <p>Session：<code>{operation.session_id}</code>{!running(operation) && operation.status !== 'unknown' && <button type="button" onClick={() => { setInstance(operation.instance_id); setSession(operation.session_id!); setSubmission(null) }}>用于继续会话</button>}</p>}
          {operation.final_response !== undefined && <><h4>响应内容</h4><pre className="harness-asset-content">{operation.final_response || '本次没有返回文本响应。'}</pre></>}
          {operation.error && <p role="alert">{typeof operation.error === 'string' ? operation.error : operation.error.message || '执行失败，请查看事件和运行日志。'}</p>}
          {operation.status === 'completed' && <p className="agent-muted">本次 SDK 执行已完成；业务结果需按任务要求核对。</p>}
          <details><summary>执行事件（{operation.events?.length ?? 0}）</summary><pre className="harness-asset-content">{JSON.stringify(operation.events ?? [], null, 2)}</pre></details>
          <div className="agent-actions"><button type="button" disabled={busy} onClick={() => void refreshOperation()}>查询执行状态</button>{operation.status === 'unknown' && submission && <button type="button" disabled={busy} onClick={() => void submit(submission)}>重新确认本次请求</button>}</div>
        </section>}
        {history.length > 0 && <details><summary>{initialInstance ? '此实例的最近调试' : '此版本的最近调试'}</summary><ul>{history.map(item => <li key={item.id}><button type="button" disabled={locked} onClick={() => { setInstance(initialInstance || item.instance_id); setOperation(matching(item)); setSession(''); setSubmission(null) }}>{item.instance_id} · {statusLabels[item.status] ?? '状态待核对'}{item.created_at && ` · ${new Date(item.created_at).toLocaleString('zh-CN')}`}</button></li>)}</ul></details>}
      </> : guide && <><p>应用与 DSH Runtime 在同一标准容器内运行，通过官方 SDK 调用；不需要业务 Web 地址。</p><h3>TypeScript 示例</h3><pre className="harness-asset-content">{guide.example}</pre><h3>使用说明</h3><article className="agent-sdk-guide"><MarkdownText text={guide.markdown} labels={{ code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }} /></article></>}
      {error && <p role="alert">{error}</p>}
      {!guide && !loading && <button type="button" onClick={() => setRevision(value => value + 1)}>重新读取接入信息</button>}
    </div>
    <div className="agent-actions agent-dialog-actions"><button type="button" onClick={onClose}>关闭</button></div>
  </dialog>
}
