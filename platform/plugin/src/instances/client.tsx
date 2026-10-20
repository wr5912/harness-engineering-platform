import { useEffect, useMemo, useRef, useState } from 'react'
import { CHANNEL } from '../protocol.ts'
import type { PlatformNavigation, PlatformPageProps } from '../protocol.ts'
import type { PlatformUpdates } from '../realtime/client.ts'
import { instanceWebUrl } from './url.ts'
import { instanceTheme } from './style.ts'

type Operation = 'create' | 'start' | 'stop' | 'restart' | 'delete'

interface InstanceRow {
  name: string
  state?: string
  source_id?: string
  image_tag?: string
  agent_id?: string
  port?: number
  business_gateway?: boolean
  lan_access?: boolean
  home_volume?: string
  home_directory?: string
  home_preserved?: boolean | null
  container_name?: string
  observed_at?: string
  mounts?: Record<string, string>
  mount_modes?: Record<string, string>
  ps?: string
}

interface ActionRequest {
  operation: Operation
  name: string
  source?: string
  expected_source_id?: string
  port?: number
}

interface Detail {
  instance: InstanceRow
  runs: { id: string, path: string }[]
  session_scope: { home_volume?: unknown, preserved?: unknown, note: string }
}

interface Receipt {
  name: string
  operation: Operation
  ok: boolean
  value?: unknown
  error?: { message: string }
}

const labels: Record<Operation, string> = {
  create: '创建',
  start: '启动',
  stop: '停止',
  restart: '重启',
  delete: '删除',
}

const detailTabs = [{ id: 'overview', label: '概览' }, { id: 'embed', label: '网站嵌入' }, { id: 'logs', label: '运行日志' }] as const
const stateLabels: Record<string, string> = { running: '运行中', stopped: '已停止', absent: '无容器', failed: '异常', unknown: '状态未知' }

export function InstancesPage({ rpc, updates, onContext, target, onNavigate }: PlatformPageProps & { updates?: PlatformUpdates; target?: PlatformNavigation; onNavigate?(target: PlatformNavigation): void; onContext?(context: Record<string, unknown>): void }) {
  const [instances, setInstances] = useState<InstanceRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('existing')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  useEffect(() => {
    if (target?.page === 'instances') setSourceFilter(target.experiment_id ? `experiment:${target.experiment_id}` : '')
  }, [target?.page, target?.experiment_id])
  const [detailLoading, setDetailLoading] = useState(false)
  const [opening, setOpening] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<unknown>(null)
  const [pending, setPending] = useState<{ operation: Operation, items: ActionRequest[] } | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [actionDialog, setActionDialog] = useState<Operation | null>(null)
  const [creating, setCreating] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const [form, setForm] = useState({ name: '', source: '', port: '' })
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailTab, setDetailTab] = useState<typeof detailTabs[number]['id']>('overview')
  const [detailNotice, setDetailNotice] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [logs, setLogs] = useState('')
  const [logsError, setLogsError] = useState('')
  const [embedUrl, setEmbedUrl] = useState('')
  const [embedMessage, setEmbedMessage] = useState('')
  const embedRequest = useRef(0)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const detailName = useRef<string | undefined>(undefined)
  const embedCode = embedUrl ? `<iframe\n  src="${embedUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"\n  title="DSH 智能体"\n  style="width: 100%; height: 700px; border: 0;"\n  allow="clipboard-write"\n></iframe>` : ''

  const visible = useMemo(() => instances.filter(item => (!sourceFilter || item.source_id === sourceFilter) && (filter === 'all' || (filter === 'existing' ? item.state !== 'absent' : item.state === filter)) && `${item.name} ${item.source_id ?? ''}`.toLowerCase().includes(query.toLowerCase())), [instances, filter, query, sourceFilter])
  const visibleSelected = visible.filter(item => selected.has(item.name)).length

  async function call<T>(endpoint: string, payload: unknown): Promise<T> {
    const result = await rpc.call(CHANNEL, `instances/${endpoint}`, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }

  async function refresh(background = false) {
    const request = ++listRequest.current
    setLoading(true)
    if (!background) setError('')
    try {
      const data = await call<{ instances: InstanceRow[] }>('list', {})
      if (request !== listRequest.current) return
      setInstances(data.instances)
      setRefreshError('')
      if (detailName.current) {
        if (data.instances.some(item => item.name === detailName.current)) void openDetail(detailName.current, true)
        else {
          detailRequest.current++
          embedRequest.current++
          setDetailLoading(false)
          setDetail(current => current ? { ...current, instance: { ...current.instance, state: 'unknown' } } : current)
          setDetailNotice(`所选实例 ${detailName.current} 的登记已不存在，请重新选择。`)
          setLogs('')
          setLogsError('')
          setEmbedUrl('')
          setEmbedMessage('')
        }
      }
    } catch (err) {
      if (request === listRequest.current) setRefreshError((err as Error).message)
    } finally {
      if (request === listRequest.current) setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    return () => { listRequest.current++; detailRequest.current++ }
  }, [])
  useEffect(() => updates?.subscribe(() => {
    const domains = updates.getSnapshot().domains
    if (domains.includes('instances')) void refresh(true)
    else if (domains.includes('agents') && detailName.current) void openDetail(detailName.current, true)
  }), [updates])
  useEffect(() => {
    onContext?.({ page: 'instances', instance_name: detail?.instance.name, selected_instances: [...selected] })
  }, [detail?.instance.name, selected, onContext])
  useEffect(() => {
    if (actionDialog) dialog.current?.showModal()
    else dialog.current?.close()
  }, [actionDialog])

  function updateForm(next: typeof form) {
    setForm(next)
    setPreview(null)
    setPending(null)
  }

  function createRequest(): ActionRequest {
    return {
      operation: 'create',
      name: form.name,
      source: form.source,
      port: form.port ? Number(form.port) : undefined,
    }
  }

  async function prepare(operation: Operation, names: string[]) {
    setActionDialog(operation)
    setReceipts([])
    setBusy(true)
    setError('')
    setPreview(null)
    setPending(null)
    try {
      const items = operation === 'create'
        ? [createRequest()]
        : names.map(name => ({ operation, name }))
      const data = items.length === 1
        ? await call('preview', items[0])
        : await call('batch-preview', { items })
      setPreview(data)
      const previews = items.length === 1 ? [data] : (data as any).previews.map((item: any) => item.value)
      const frozen = items.map(item => {
        if (operation === 'create') return item
        const preview = previews.find((value: any) => value?.name === item.name) as any
        const source = preview?.plan?.source_id ?? preview?.source_id
        if (typeof source !== 'string' || !source) throw new Error('预览缺少实例来源，请刷新后重新预览。')
        return { ...item, expected_source_id: source }
      })
      setPending({ operation, items: frozen })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function execute() {
    if (!pending) return
    setBusy(true)
    setError('')
    setPreview(null)
    setReceipts([])
    let transportError = ''
    try {
      const concurrency = pending.operation === 'delete' ? 5 : 1
      for (let offset = 0; offset < pending.items.length; offset += concurrency) {
        const results = await Promise.allSettled(pending.items.slice(offset, offset + concurrency).map(async item => {
          try {
            const receipt = await call<Receipt>('run', item)
            setReceipts(current => [...current, receipt])
          } catch (err) {
            setReceipts(current => [...current, { ...item, ok: false, error: { message: '回执未收到，执行结果未知；请刷新核对。' } }])
            throw err
          }
        }))
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
    } catch (err) {
      transportError = `连接失败，后续操作已停止。已收到的回执保留；请核对实例状态后重新选择。${(err as Error).message}`
    } finally {
      setPending(null)
      await refresh()
      if (transportError) setError(transportError)
      setBusy(false)
    }
  }

  async function openDetail(name: string, background = false) {
    const request = ++detailRequest.current
    detailName.current = name
    if (!background) {
      embedRequest.current++
      setDetail(null)
      setDetailTab('overview')
      setLogs('')
      setLogsError('')
      setEmbedUrl('')
      setEmbedMessage('')
    }
    setDetailLoading(true)
    if (!background) setError('')
    try {
      const [nextDetail, nextLogs] = await Promise.all([
        call<Detail>('detail', { name }),
        call<{ logs: string }>('logs', { name, tail: 200 }).then(value => ({ logs: value.logs, error: '' }), err => ({ logs: '', error: (err as Error).message })),
      ])
      if (request !== detailRequest.current || name !== detailName.current) return
      setDetail(nextDetail)
      setDetailNotice('')
      setLogs(nextLogs.logs)
      setLogsError(nextLogs.error)
    } catch (err) {
      if (request === detailRequest.current) {
        setDetailNotice((err as Error).message)
        if (!background) setError((err as Error).message)
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false)
    }
  }

  function closeDetail() {
    detailRequest.current++
    embedRequest.current++
    detailName.current = undefined
    setDetail(null)
    setDetailLoading(false)
    setDetailNotice('')
    setLogs('')
    setLogsError('')
    setEmbedUrl('')
    setEmbedMessage('')
  }

  async function webUrl(name: string) {
    const result = await call<{ url: string, lan_access: boolean }>('url', { name })
    return instanceWebUrl(result, window.location.hostname)
  }

  async function generateEmbed(name: string) {
    const request = ++embedRequest.current
    setEmbedUrl('')
    setEmbedMessage('正在读取实例地址…')
    try {
      const url = await webUrl(name)
      if (request !== embedRequest.current) return
      setEmbedUrl(url)
      setEmbedMessage('将以下代码粘贴到网站的 HTML 中。')
    } catch (err) {
      if (request === embedRequest.current) setEmbedMessage((err as Error).message)
    }
  }

  async function copyEmbed() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(embedCode)
      else {
        const input = document.createElement('textarea')
        input.value = embedCode
        document.body.appendChild(input)
        input.select()
        try { if (!document.execCommand('copy')) throw new Error('copy failed') } finally { input.remove() }
      }
      setEmbedMessage('嵌入代码已复制。')
    } catch { setEmbedMessage('浏览器未允许复制，请手动复制下面的代码。') }
  }

  async function openWeb(name: string) {
    const tab = window.open('about:blank', '_blank')
    if (!tab) {
      setError('浏览器阻止了新标签页，请允许弹出窗口后重试。')
      return
    }
    tab.opener = null
    tab.document.title = '正在打开 DSH Web'
    tab.document.body.textContent = '正在获取实例访问地址…'
    setOpening(current => new Set(current).add(name))
    setError('')
    try {
      const url = await webUrl(name)
      if (!tab.closed) tab.location.replace(url)
    } catch (err) {
      tab.close()
      setError((err as Error).message)
    } finally {
      setOpening(current => { const next = new Set(current); next.delete(name); return next })
    }
  }

  const selectedNames = [...selected]
  const missingSelections = selectedNames.filter(name => !instances.some(item => item.name === name))
  const containerCount = instances.filter(item => ['running', 'stopped', 'failed'].includes(item.state ?? '')).length
  const absentCount = instances.filter(item => item.state === 'absent').length
  const unknownCount = instances.length - containerCount - absentCount

  return (
    <main className="harness-instances-page" aria-label="实例管理">
      <style>{instanceTheme}</style>
      <header className="harness-page-heading instance-page-heading">
        <div><p>管理智能体实例的运行、访问与网站嵌入。</p><div className="instance-summary-stats">{containerCount} 个容器实例 · {absentCount} 个无容器登记{unknownCount > 0 && ` · ${unknownCount} 个状态未知`}</div></div>
        <button type="button" className="harness-primary" aria-expanded={creating} aria-controls="instance-create" onClick={() => setCreating(value => !value)}>新建实例</button>
      </header>
      {creating && <section id="instance-create" aria-label="新建实例" className="instance-create-panel">
        <div className="instance-create-heading"><strong>新建实例</strong><button type="button" onClick={() => setCreating(false)} className="instance-button">收起</button></div>
        <p className="instance-create-note">选择已有版本作为来源。预览配置并确认后，才会创建实例。</p>
        <div className="instance-create-fields">
          <label className="instance-field">实例名<input aria-label="实例名" placeholder="例如 my-agent" value={form.name}
            onChange={event => updateForm({ ...form, name: event.target.value })} className="instance-field-input" /></label>
          <label className="instance-field">来源版本<input aria-label="来源" placeholder="experiment:EXP-..." value={form.source}
            onChange={event => updateForm({ ...form, source: event.target.value })} className="instance-field-input" /></label>
          <label className="instance-field">访问端口（可选）<input aria-label="端口" placeholder="留空自动分配" value={form.port}
            onChange={event => updateForm({ ...form, port: event.target.value })} className="instance-field-input" /></label>
        </div>
        <div className="instance-create-actions"><button type="button" className="harness-primary" disabled={busy || !form.name || !form.source}
          onClick={() => prepare('create', [])}>创建预览</button></div>
      </section>}
      <section aria-label="实例筛选" className="instance-filter-panel">
        {sourceFilter && <div className="instance-source-filter"><span>关联来源：{sourceFilter}</span><button type="button" onClick={() => { setSourceFilter(''); onNavigate?.({ page: 'instances' }) }}>查看全部实例</button></div>}
        <div className="instance-filter-row">
          <label className="instance-filter-field">状态<select aria-label="状态筛选" value={filter} onChange={event => setFilter(event.target.value)} className="instance-field-input">
            <option value="existing">现有容器</option><option value="all">全部登记</option>
            <option value="running">运行中</option><option value="stopped">已停止</option>
            <option value="absent">无容器（仅登记）</option><option value="failed">异常</option><option value="unknown">状态未知</option>
          </select></label>
          <label className="instance-search-field">搜索<input aria-label="搜索实例" placeholder="输入实例名或来源版本" value={query} onChange={event => setQuery(event.target.value)} className="instance-field-input" /></label>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="instance-button">{loading ? '读取中…' : '刷新'}</button>
        </div>
        {selectedNames.length > 0 && <div aria-label="批量操作" className="instance-batch-bar">
          <strong>已选择 {selected.size} 个</strong>
          {selected.size > visibleSelected && <span className="instance-muted">其中 {selected.size - visibleSelected} 个不在当前列表</span>}
          {(['start', 'stop', 'restart', 'delete'] as Operation[]).map(operation => <button key={operation} type="button" disabled={busy || missingSelections.length > 0}
            onClick={() => prepare(operation, selectedNames)} className="instance-button">{labels[operation]}</button>)}
          <button type="button" disabled={busy} onClick={() => setSelected(new Set())} className="instance-button">取消选择</button>
          {missingSelections.length > 0 && <span role="status" className="instance-selection-notice">{missingSelections.length} 个所选登记已不存在。<button type="button" onClick={() => setSelected(current => new Set([...current].filter(name => !missingSelections.includes(name))))}>清除失效选择</button></span>}
        </div>}
      </section>

      {error && !actionDialog ? <div role="alert" className="instance-error">{error}</div> : null}
      {refreshError && <div role="alert" className="instance-error">{refreshError}</div>}

      <section aria-label="实例列表" className="instance-list-panel">
        <div className="instance-list-heading"><strong>实例列表</strong><span className="instance-muted">显示 {visible.length} 项 · 勾选后可批量操作</span></div>
        <div className="instance-table-wrap"><table className="instance-table">
          <colgroup><col style={{ width: 44 }}/><col style={{ width: 200 }}/><col style={{ width: 108 }}/><col/><col style={{ width: 72 }}/><col style={{ width: 160 }}/><col style={{ width: 220 }}/></colgroup>
          <thead>
            <tr>
              <th className="instance-list-th">
                <input type="checkbox" aria-label="全选当前列表实例" disabled={loading || visible.length === 0}
                  checked={visible.length > 0 && visibleSelected === visible.length}
                  ref={element => { if (element) element.indeterminate = visibleSelected > 0 && visibleSelected < visible.length }}
                  onChange={event => setSelected(current => {
                    const next = new Set(current)
                    for (const item of visible) {
                      if (event.target.checked) next.add(item.name)
                      else next.delete(item.name)
                    }
                    return next
                  })} />
              </th>
              <th className="instance-list-th">实例</th><th className="instance-list-th">状态</th><th className="instance-list-th">来源版本</th>
              <th className="instance-list-th">端口</th><th className="instance-list-th">访问入口</th><th className="instance-list-th">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(item => (
              <tr key={item.name} data-current={detail?.instance.name === item.name || undefined} data-selected={selected.has(item.name) || undefined}>
                <td className="instance-list-td instance-selection">
                  <input type="checkbox" aria-label={`选择实例 ${item.name}`} checked={selected.has(item.name)}
                    onChange={event => setSelected(current => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(item.name)
                      else next.delete(item.name)
                      return next
                    })} />
                </td>
                <td className="instance-list-td instance-name" data-label="实例">{item.name}</td>
                <td className="instance-list-td" data-label="状态"><span className="instance-state-badge" data-state={item.state}>{stateLabels[item.state ?? 'unknown'] || item.state}</span></td>
                <td className="instance-list-td instance-source" data-label="来源版本"><span title={item.source_id}>{item.source_id || '未记录'}</span></td>
                <td className="instance-list-td" data-label="端口" title={item.business_gateway ? '业务 Runtime 内部端口；公开入口由业务网关提供' : undefined}>{item.port || '—'}</td>
                <td className="instance-list-td" data-label="访问入口">
                  <button type="button" disabled={item.state !== 'running' || !item.port || opening.has(item.name)}
                    onClick={() => openWeb(item.name)} className="instance-button"
                    title={item.state !== 'running' ? '实例运行后可访问' : item.business_gateway ? '经业务网关打开；需要业务用户登录' : item.lan_access ? '在新标签页打开' : '仅宿主机浏览器可访问'}>
                    {opening.has(item.name) ? '正在打开…' : '访问 DSH Web'}
                  </button>
                  <div className="instance-muted instance-access-note">{item.state !== 'running' ? '实例运行后可访问' : !item.port ? '未记录端口' : item.business_gateway ? '经业务网关 · 需个人登录' : !item.lan_access ? '仅宿主机' : null}</div>
                </td>
                <td className="instance-list-td" data-label="操作"><div className="instance-actions">
                  <button type="button" onClick={() => openDetail(item.name)} disabled={detailLoading} className="instance-button">详情</button>
                  {(item.state === 'running' ? ['stop', 'restart'] : item.state === 'stopped' || item.state === 'absent' ? ['start', 'delete'] : item.state === 'failed' ? ['start', 'stop'] : []).map(operation =>
                    <button type="button" key={operation} disabled={busy} onClick={() => prepare(operation as Operation, [item.name])} className="instance-button">{labels[operation as Operation]}</button>)}
                  {item.state === 'unknown' && <span>观察失败，请刷新</span>}
                </div></td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={7} className="instance-empty-list">{loading ? '正在读取实例…' : instances.length === 0 ? '暂无实例。点击右上角“新建实例”开始创建。' : '没有符合当前筛选条件的实例。请调整状态或搜索内容。'}</td></tr>}
          </tbody>
        </table></div>
      </section>

      {detailLoading && !detail && <p role="status">正在读取实例详情…</p>}
      {detail ? (
        <section className="harness-instance-detail instance-panel" aria-label="实例详情">
          <header className="instance-detail-header">
            <div className="instance-heading-content"><small className="instance-muted">实例详情</small><div className="instance-detail-title">
              <h2>{detail.instance.name}</h2>
              <span className="instance-state-badge" data-state={detail.instance.state}>{stateLabels[detail.instance.state ?? 'unknown'] || detail.instance.state}</span>
            </div></div>
            <div className="instance-actions">
              <button type="button" className="harness-primary" disabled={detail.instance.state !== 'running' || !detail.instance.port || opening.has(detail.instance.name)} onClick={() => void openWeb(detail.instance.name)}>{opening.has(detail.instance.name) ? '正在打开…' : '访问 DSH Web'}</button>
              <button type="button" className="instance-button" disabled={detailLoading} onClick={() => void openDetail(detail.instance.name, true)}>{detailLoading ? '刷新中…' : '刷新详情'}</button>
              <button type="button" className="instance-button" onClick={closeDetail}>关闭详情</button>
            </div>
          </header>
          {detailNotice && <p role="alert" className="instance-detail-notice">{detailNotice}</p>}
          {(detail.instance.state === 'failed' || detail.instance.state === 'unknown') && <p role="alert" className="instance-detail-notice">实例状态异常，请先查看运行日志，再决定是否停止或删除。</p>}
          <div role="tablist" aria-label="实例详情" className="instance-detail-tabs" onKeyDown={event => {
            const index = detailTabs.findIndex(item => item.id === detailTab)
            const next = event.key === 'ArrowRight' ? (index + 1) % detailTabs.length : event.key === 'ArrowLeft' ? (index + detailTabs.length - 1) % detailTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? detailTabs.length - 1 : undefined
            if (next === undefined) return
            event.preventDefault()
            setDetailTab(detailTabs[next].id)
            document.getElementById(`instance-tab-${detailTabs[next].id}`)?.focus()
          }}>{detailTabs.map(item => <button key={item.id} id={`instance-tab-${item.id}`} type="button" role="tab" aria-selected={detailTab === item.id} aria-controls={`instance-panel-${item.id}`} tabIndex={detailTab === item.id ? 0 : -1} onClick={() => setDetailTab(item.id)} className="instance-detail-tab">{item.label}</button>)}</div>

          <section id="instance-panel-overview" role="tabpanel" aria-labelledby="instance-tab-overview" hidden={detailTab !== 'overview'} className="instance-detail-body">
            <dl className="instance-detail-grid">
              {[
                ['来源版本', detail.instance.source_id || '未记录'],
                ['智能体', detail.instance.agent_id || '未记录'],
                [detail.instance.business_gateway ? '内部 Web 端口' : '访问端口', detail.instance.port || '未记录'],
                ['运行镜像', detail.instance.image_tag || '未记录'],
                ['HOME 存储', String(detail.instance.home_directory || detail.session_scope.home_volume || detail.instance.home_volume || '未记录')],
                ['HOME 保留状态', detail.session_scope.preserved === true ? '已保留' : detail.session_scope.preserved === false ? '未保留' : '尚未确认'],
              ].map(([label, value]) => <div key={label} className="instance-fact"><dt className="instance-muted">{label}</dt><dd className="instance-fact-value">{value}</dd></div>)}
            </dl>
            <div className="instance-session-note"><strong>会话与数据</strong><p>{detail.session_scope.note || '未记录会话说明。'}</p></div>
            <details className="instance-detail-fold"><summary className="instance-fold-title">挂载配置 · {Object.keys(detail.instance.mounts || {}).length} 项</summary>
              {Object.keys(detail.instance.mounts || {}).length ? <div className="instance-mount-scroll"><table className="instance-mount-table"><thead><tr><th className="instance-th">用途</th><th className="instance-th">来源路径</th><th className="instance-th">权限</th></tr></thead><tbody>{Object.entries(detail.instance.mounts || {}).map(([name, path]) => {
                const mode = detail.instance.mount_modes?.[name]
                return <tr key={name}><td className="instance-td">{name}</td><td className="instance-td instance-path">{path}</td><td className="instance-td">{mode === 'ro' ? '只读' : mode === 'rw' ? '读写' : mode || '未记录'}</td></tr>
              })}</tbody></table></div> : <p className="instance-muted">暂无挂载配置。</p>}
            </details>
            <details className="instance-detail-fold"><summary className="instance-fold-title">来源版本的运行记录 · {detail.runs.length} 条</summary>
              {detail.runs.length ? <ul className="instance-run-list">{detail.runs.map(run => <li key={run.id} className="instance-run-item">
                {onNavigate ? <button type="button" className="instance-run-link" onClick={() => onNavigate({ page: 'evaluation', run_id: run.id, agent_id: detail.instance.agent_id })}>{run.id}</button> : <code>{run.id}</code>}
                <small className="instance-muted instance-path">{run.path}</small>
              </li>)}</ul> : <p className="instance-muted">此来源版本暂无运行记录。</p>}
            </details>
          </section>

          <section id="instance-panel-embed" role="tabpanel" aria-labelledby="instance-tab-embed" hidden={detailTab !== 'embed'} className="instance-detail-body">
            <div className="instance-embed-heading"><div><h3 className="instance-section-title">将智能体嵌入网站</h3><p className="instance-muted">生成 iframe 代码，粘贴到网站的 HTML 中即可展示此实例。</p></div>
              <button type="button" className="instance-button" disabled={detail.instance.state !== 'running' || !detail.instance.port} onClick={() => void generateEmbed(detail.instance.name)}>{embedCode ? '重新生成代码' : '生成 iframe 代码'}</button>
            </div>
            {(detail.instance.state !== 'running' || !detail.instance.port) && <p role="status">实例运行且记录访问端口后，才可生成嵌入代码。</p>}
            {embedCode ? <div className="instance-code-box"><div className="instance-code-heading"><span>HTML 嵌入代码</span><button type="button" className="instance-button" onClick={() => void copyEmbed()}>复制嵌入代码</button></div><pre className="instance-embed-code">{embedCode}</pre></div> : <div className="instance-embed-empty">点击“生成 iframe 代码”，获取使用此实例实际访问地址的代码。</div>}
            {embedMessage && <p role="status" className="instance-muted">{embedMessage}</p>}
            <details className="instance-detail-fold"><summary className="instance-fold-title">使用须知</summary><ul className="instance-embed-notes">
              <li>网站访问者需要能连接到实例地址。供其他电脑访问时，使用局域网可达的地址；127.0.0.1 只指访问者自己的电脑。</li>
              <li>嵌入沿用实例自身的登录设置，不会自动传递平台登录状态。跨站登录受浏览器 Cookie 限制时，可使用同站点反向代理或直接打开 DSH Web。</li>
              <li>HTTPS 网站需使用 HTTPS 实例入口，网站的 CSP 也需要允许该 iframe 来源。</li>
            </ul></details>
          </section>

          <section id="instance-panel-logs" role="tabpanel" aria-labelledby="instance-tab-logs" hidden={detailTab !== 'logs'} className="instance-detail-body">
            <h3 className="instance-section-title">运行日志</h3><p className="instance-muted">最近 200 行。点击右上角“刷新详情”获取最新日志。</p>
            {logsError ? <p role="alert" className="instance-error">日志读取失败：{logsError}</p> : <pre role="log" aria-label="实例运行日志" aria-live="off" tabIndex={0} className="instance-log-content">{logs || '暂无日志。'}</pre>}
          </section>
        </section>
      ) : null}

      <dialog ref={dialog} aria-labelledby="instance-action-title" className="instance-dialog"
        onCancel={event => { if (busy) event.preventDefault(); else setActionDialog(null) }}>
        <header className="instance-dialog-heading"><h2 id="instance-action-title">{actionDialog && labels[actionDialog]}智能体 DSH 容器实例</h2></header>
        <div className="instance-dialog-content">
        {busy && <p role="status">{pending ? `正在执行：已处理 ${receipts.length} / ${pending.items.length} 项` : '正在读取操作预览…'}</p>}
        {error && <div role="alert" className="instance-error">{error}</div>}
        {preview && pending ? <>
          <p>请确认目标及保留范围后执行。</p>
          <pre className="instance-pre">{JSON.stringify(preview, null, 2)}</pre>
        </> : null}
        {receipts.length ? <section aria-live="polite">
          <strong>操作回执：成功 {receipts.filter(item => item.ok).length} 项，失败或结果未知 {receipts.filter(item => !item.ok).length} 项</strong>
          {receipts.map(item => (
            <div key={`${item.operation}-${item.name}`} className={item.ok ? 'instance-receipt-ok' : 'instance-receipt-bad'}>
              {item.name} / {labels[item.operation]} / {item.ok ? '成功' : item.error?.message || '失败'}
            </div>
          ))}
        </section> : null}
        </div>
        <footer className="instance-dialog-actions">
          {preview && pending ? <button type="button" onClick={execute} disabled={busy} className="harness-primary">确认{labels[pending.operation]}</button> : null}
          <button type="button" disabled={busy} onClick={() => { setActionDialog(null); setPreview(null); setPending(null) }} className="instance-button">{pending ? '取消' : '关闭'}</button>
        </footer>
      </dialog>
    </main>
  )
}
